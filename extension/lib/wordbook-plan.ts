import type { VocabularyCard, VocabularyPlan, VocabularyReviewLog } from '@shadow-language/contracts';
import { vocabularySyncKey } from '@shadow-language/contracts';
import { atlasKey } from './word-atlas';
import { lookupReaderWord } from './reader-frequency';
import { isVocabularyExempt } from './vocabulary-scheduler';

export const WORDBOOK_IDS = ['cefrj-a1', 'cefrj-a2', 'cefrj-b1', 'cefrj-b2', 'study-abroad'] as const;
export type WordbookId = typeof WORDBOOK_IDS[number];
export type StudyBookId = WordbookId | 'personal';
export type WordbookMember = {
  word: string;
  aliases?: string[];
  atlasWord?: string;
  phonetic?: string;
  translation?: string;
};
export type WordbookInfo = {
  id: WordbookId; title: string; subtitle: string; english: string; version: string;
  source: string; sourceUrl: string; sourceCount: number; count: number; atlasCount: number;
};
export type Wordbook = WordbookInfo & { words: WordbookMember[] };
export type WordbookPreferences = { id: StudyBookId; dailyNew: number };
export function isStudyBookId(id: unknown): id is StudyBookId {
  return id === 'personal' || WORDBOOK_IDS.includes(id as WordbookId);
}
export function normalizeWordbookPreferences(value: unknown): WordbookPreferences {
  const input = value as Partial<WordbookPreferences> | null;
  return { id: isStudyBookId(input?.id) ? input.id : 'personal', dailyNew: Math.min(100, Math.max(1, Math.round(Number(input?.dailyNew) || 15))) };
}
export function isPersonalVocabularyCard(card: VocabularyCard): boolean { return !card.source.startsWith('wordbook:'); }

export function wordbookKeys(member: WordbookMember): string[] {
  const words = [member.word, member.atlasWord, ...member.aliases || []].filter((value): value is string => Boolean(value));
  return [...new Set(words.flatMap(word => [atlasKey(word), atlasKey(lookupReaderWord(word).lemma || word)]))];
}
export function indexVocabularyCards(cards: VocabularyCard[]): Map<string, VocabularyCard> {
  const map = new Map<string, VocabularyCard>();
  // Prefer the actually learned record if historical aliases produced duplicates.
  for (const card of [...cards].sort((a, b) => a.fsrs.reps - b.fsrs.reps)) {
    for (const key of [card.lemma, card.word]) map.set(atlasKey(key), card);
  }
  return map;
}
export function findWordbookCard(member: WordbookMember, index: Map<string, VocabularyCard>): VocabularyCard | undefined {
  return wordbookKeys(member).map(key => index.get(key)).find(Boolean);
}
export function wordbookCard(member: WordbookMember, book: WordbookInfo, now: number): VocabularyCard {
  const word = member.atlasWord || member.word;
  const lemma = atlasKey(lookupReaderWord(word).lemma || word);
  return { id: vocabularySyncKey(lemma), word, lemma, rank: null, phonetic: member.phonetic || '', translation: member.translation || '',
    status: 'unfamiliar', source: `wordbook:${book.id}@${book.version}`, createdAt: now, updatedAt: now, due: now,
    fsrs: { state: 0, difficulty: 0, stability: 0, reps: 0, lapses: 0, lastReview: null, due: now } };
}
export function wordbookProgress(book: Wordbook, cards: VocabularyCard[], index = indexVocabularyCards(cards)) {
  let learned = 0, stable = 0, skipped = 0;
  for (const member of book.words) {
    const card = findWordbookCard(member, index);
    if (!card) continue;
    const exempt = isVocabularyExempt(card) || card.status === 'ignored' || card.status === 'known' && card.fsrs.reps === 0;
    if (exempt) skipped++;
    else if (card.fsrs.reps > 0) learned++;
    if (!exempt && card.status === 'known' && card.fsrs.reps > 0) stable++;
  }
  return { total: book.words.length, learned, stable, skipped, remaining: Math.max(0, book.words.length - learned - skipped) };
}

/** Scope new words and reviews to the selected lane, sharing existing word
 * history across overlapping books. Catalog reads never create saved cards. */
export function buildWordbookPlan(base: VocabularyPlan, cards: VocabularyCard[], book: Wordbook | null, preferences: WordbookPreferences, now = Date.now(), logs?: VocabularyReviewLog[]): VocabularyPlan {
  const index = indexVocabularyCards(cards);
  const seen = new Set<string>();
  const orderedMembers = book ? [...book.words].sort((a, b) => Number(Boolean(b.atlasWord)) - Number(Boolean(a.atlasWord))) : [];
  const candidates = book ? orderedMembers.map(member => {
    const existing = findWordbookCard(member, index);
    return existing ? { ...existing, ...(member.atlasWord ? { atlasWord: member.atlasWord } : {}) } : wordbookCard(member, book, now);
  })
    : base.newWords.filter(isPersonalVocabularyCard);
  const newWords = candidates.filter(card => {
    if (isVocabularyExempt(card) || card.fsrs.reps > 0 || !['unseen', 'unfamiliar'].includes(card.status) || seen.has(card.id)) return false;
    seen.add(card.id); return true;
  });
  const dailyNewTarget = preferences.dailyNew;
  const eligibleKeys = new Set(book ? book.words.flatMap(wordbookKeys) : cards.filter(isPersonalVocabularyCard).flatMap(card => [atlasKey(card.word), atlasKey(card.lemma)]));
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const exemptKeys = new Set(cards.filter(isVocabularyExempt).flatMap(card => [atlasKey(card.word), atlasKey(card.lemma)]));
  const newStartedToday = logs ? new Set(logs.filter(log => log.isNew && log.timestamp >= dayStart.getTime() && eligibleKeys.has(atlasKey(log.word)) && !exemptKeys.has(atlasKey(log.word))).map(log => atlasKey(log.word))).size : base.newStartedToday;
  const dailyNewRemaining = Math.max(0, dailyNewTarget - newStartedToday);
  const todayNewCount = Math.min(newWords.length, dailyNewRemaining);
  const atlasByCard = new Map<string, string>();
  if (book) for (const member of book.words) {
    const card = findWordbookCard(member, index);
    if (card && member.atlasWord) atlasByCard.set(card.id, member.atlasWord);
  }
  const memberIds = new Set(book ? book.words.flatMap(member => { const card = findWordbookCard(member, index); return card ? [card.id] : []; }) : cards.filter(isPersonalVocabularyCard).map(card => card.id));
  const dueCards = base.dueCards.filter(card => memberIds.has(card.id)).map(card => atlasByCard.has(card.id) ? { ...card, atlasWord: atlasByCard.get(card.id)! } : card);
  return { ...base, dueCards, dueCount: dueCards.length, newWords, newPoolCount: newWords.length, dailyNewTarget, newStartedToday, dailyNewRemaining, todayNewCount, totalTodayCount: dueCards.length + todayNewCount };
}
