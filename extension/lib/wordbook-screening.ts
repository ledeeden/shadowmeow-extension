import type { VocabularyCard } from '@shadow-language/contracts';
import { db } from './db';
import { atlasKey, loadAtlasEntries } from './word-atlas';
import { findWordbookCard, indexVocabularyCards, wordbookCard, wordbookKeys, type Wordbook, type WordbookMember } from './wordbook-plan';

export type ScreeningMode = 'known' | 'unknown';
export function screenedKnownWords(page: WordbookMember[], selected: Set<string>, mode: ScreeningMode): string[] {
  return page.filter(member => mode === 'known' ? selected.has(member.word) : !selected.has(member.word)).map(member => member.word);
}
export function screenedCard(card: VocabularyCard, known: boolean, now: number): VocabularyCard {
  return { ...card, status: known ? 'known' : card.fsrs.reps > 0 ? 'learning' : 'unfamiliar',
    reviewExempt: known, assessmentExemptBatch: null, due: known ? null : now, updatedAt: now };
}

/** One explicit page submission, one account-scoped transaction. Recognition
 * screening never invents an FSRS review or erases a learned card's history. */
export async function submitWordbookScreening(book: Wordbook, pageWords: string[], knownWords: string[], nextPage: number, now = Date.now()) {
  const database = db;
  if (!pageWords.length || pageWords.length > 100 || new Set(pageWords).size !== pageWords.length) throw new Error('筛词页无效，请重新打开。');
  const members = new Map(book.words.map(member => [member.word, member]));
  const page = new Set(pageWords), known = new Set(knownWords);
  if (pageWords.some(word => !members.has(word)) || knownWords.some(word => !page.has(word))) throw new Error('筛词范围与当前词本不一致。');
  const atlas = await loadAtlasEntries().catch(() => new Map());
  if (database !== db) throw new Error('账号已切换，请重新打开筛词页。');
  await database.transaction('rw', [database.vocabulary, database.studyMeta], async () => {
    const index = indexVocabularyCards(await database.vocabulary.toArray());
    const updates = new Map<string, { card: VocabularyCard; known: boolean }>();
    const decisions = new Map<string, boolean>();
    for (const word of pageWords) {
      const member = members.get(word)!;
      const existing = findWordbookCard(member, index);
      const isKnown = known.has(word);
      // Keep explicit unknown answers so a later estimate-based bulk action
      // cannot override them. These records remain separate from My Words.
      let card = existing || wordbookCard(member, book, now);
      const previousDecision = decisions.get(card.id);
      const decision = previousDecision === undefined ? isKnown : previousDecision && isKnown;
      decisions.set(card.id, decision);
      if (!existing) {
        const entry = atlas.get(atlasKey(card.word));
        if (entry) card = { ...card, phonetic: entry.uk, translation: entry.senses.slice(0, 2).map((sense: { pos: string; zh: string }) => `${sense.pos} ${sense.zh}`).join('；') };
      }
      // If two attested variants share one card, any explicit unknown wins.
      updates.set(card.id, { card, known: decision });
    }
    await database.vocabulary.bulkPut([...updates.values()].map(value => screenedCard(value.card, value.known, now)));
    const goal = await database.studyMeta.get('goal');
    await database.studyMeta.put({ id: 'goal', targetVocab: 0, targetDays: 60, startDate: now, ...goal, updatedAt: now,
      wordbookScreening: { ...goal?.wordbookScreening, [book.id]: { version: book.version, page: Math.max(0, Math.floor(nextPage)), updatedAt: now } } });
  });
  try { sessionStorage.removeItem(`shadow-atlas-study:v1:${database.name}:${book.id}:${book.version}`); } catch { /* Optional browser checkpoint. */ }
  return { known: knownWords.length, learning: pageWords.length - knownWords.length };
}

/** Mark a single study card as already mastered without altering its review history. */
export async function markWordbookCardMastered(book: Wordbook, card: VocabularyCard) {
  const database = db;
  await database.transaction('rw', database.vocabulary, async () => {
    if (database !== db) throw new Error('账号已切换，请重新打开词本。');
    const index = indexVocabularyCards(await database.vocabulary.toArray());
    const member = book.words.find(item => wordbookKeys(item).some(key => key === atlasKey(card.word) || key === atlasKey(card.lemma)));
    if (!member) throw new Error('词条不在当前词本中。');
    const existing = findWordbookCard(member, index);
    await database.vocabulary.put(screenedCard(existing || card, true, Date.now()));
  });
}
