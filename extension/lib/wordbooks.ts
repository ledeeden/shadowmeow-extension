import { db } from './db';
import { atlasKey, loadAtlasEntries } from './word-atlas';
import { getVocabularyCard, getVocabularyStudyPlan, saveVocabularyWord } from './vocabulary';
import { buildWordbookPlan, findWordbookCard, indexVocabularyCards, isStudyBookId, normalizeWordbookPreferences, wordbookCard, wordbookKeys, type StudyBookId, type Wordbook, type WordbookInfo, type WordbookPreferences } from './wordbook-plan';
import type { VocabularyCard } from '@shadow-language/contracts';

const cache = new Map<string, Promise<Wordbook>>();
let catalog: Promise<WordbookInfo[]> | undefined;
const base = () => `${import.meta.env.BASE_URL}wordbooks/`;
export async function loadWordbookCatalog(): Promise<WordbookInfo[]> {
  if (!catalog) catalog = fetch(`${base()}catalog.json`).then(async response => {
    if (!response.ok) throw new Error('词本目录读取失败，请重试。');
    const value = await response.json() as WordbookInfo[];
    if (!Array.isArray(value) || value.length !== 6 || value.some(book => {
      const id: unknown = book.id;
      return !isStudyBookId(id) || id === 'personal' || !book.version;
    })) throw new Error('词本目录格式无效。');
    return value;
  }).catch(error => { catalog = undefined; throw error; });
  return catalog;
}
export async function loadWordbook(id: StudyBookId): Promise<Wordbook | null> {
  if (id === 'personal') return null;
  if (!isStudyBookId(id)) throw new Error('词本不存在。');
  if (!cache.has(id)) cache.set(id, (async () => {
    const info = (await loadWordbookCatalog()).find(book => book.id === id);
    if (!info) throw new Error('词本不存在。');
    const response = await fetch(`${base()}${id}.json`);
    if (!response.ok) throw new Error('词本暂时无法读取，请重试。');
    const words = await response.json() as Wordbook['words'];
    if (!Array.isArray(words) || words.length !== info.count || words.some(word => !word.word || typeof word.word !== 'string')) throw new Error('词本内容校验失败。');
    return { ...info, words };
  })().catch(error => { cache.delete(id); throw error; }));
  return cache.get(id)!;
}
export async function getWordbookPreferences(defaultId: StudyBookId = 'personal'): Promise<WordbookPreferences> {
  return normalizeWordbookPreferences((await db.studyMeta.get('goal'))?.wordbook || { id: defaultId, dailyNew: 15 });
}
export async function setWordbookPreferences(preferences: WordbookPreferences): Promise<WordbookPreferences> {
  const normalized = normalizeWordbookPreferences(preferences);
  const database = db;
  await database.transaction('rw', database.studyMeta, async () => {
    const current = await database.studyMeta.get('goal');
    await database.studyMeta.put({ id: 'goal', targetVocab: 0, targetDays: 60, startDate: Date.now(), ...current, wordbook: normalized, updatedAt: Date.now() });
  });
  return normalized;
}
export async function getWordbookStudyPlan(book: Wordbook | null, preferences: WordbookPreferences, cards: VocabularyCard[]) {
  const now = Date.now();
  const [basePlan, logs] = await Promise.all([getVocabularyStudyPlan(now), db.vocabularyReviews.toArray()]);
  const plan = buildWordbookPlan(basePlan, cards, book, preferences, now, logs);
  // Do not load the large Atlas when there are no book entries to enrich.
  if (!plan.newWords.some(card => !card.translation && card.source.startsWith('wordbook:'))) return plan;
  // Fill the virtual pool from Atlas; no duplicated full dataset.
  const atlas = await loadAtlasEntries().catch(() => new Map());
  plan.newWords = plan.newWords.map(card => {
    if (card.translation || !card.source.startsWith('wordbook:')) return card;
    const entry = atlas.get(atlasKey(card.word));
    return entry ? { ...card, phonetic: entry.uk, translation: entry.senses.slice(0, 2).map((sense: { pos: string; zh: string }) => `${sense.pos} ${sense.zh}`).join('；') } : card;
  });
  return plan;
}
/** Materialize only an answered word. An enrolled book never overwrites saved
 * context, notes, definitions, FSRS state or the original source of an old word. */
export async function ensureWordbookReviewCard(word: string, book: Wordbook | null): Promise<void> {
  const database = db;
  if (await getVocabularyCard(word)) return;
  const member = book?.words.find(member => wordbookKeys(member).includes(atlasKey(word)));
  if (!member || !book) throw new Error('词条已不存在，请重新读取今日计划。');
  const atlas = await loadAtlasEntries().catch(() => new Map());
  if (database !== db) throw new Error('账号已切换，请重新打开词本。');
  await database.transaction('rw', database.vocabulary, async () => {
    const existing = findWordbookCard(member, indexVocabularyCards(await database.vocabulary.toArray()));
    if (existing) return;
    const card = wordbookCard(member, book, Date.now());
    const entry = atlas.get(atlasKey(card.word));
    await saveVocabularyWord({ word: card.word, lemma: card.lemma, source: card.source,
      phonetic: entry?.uk || card.phonetic,
      translation: entry ? entry.senses.slice(0, 2).map((sense: { pos: string; zh: string }) => `${sense.pos} ${sense.zh}`).join('；') : card.translation });
  });
}
