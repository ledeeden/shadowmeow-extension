import { describe, expect, it } from 'vitest';
import { vocabularySyncKey, type VocabularyCard, type VocabularyReviewLog } from '@shadow-language/contracts';
import { buildVocabularyPlan, buildVocabularyQueue } from './vocabulary-scheduler';
import { buildWordbookPlan, normalizeWordbookPreferences, wordbookProgress, type Wordbook } from './wordbook-plan';

const now = new Date(2026, 9, 27, 12).getTime();
const book: Wordbook = { id: 'cefrj-a1', title: 'CEFR-J A1', subtitle: '', english: '', version: 'test', source: '', sourceUrl: '', sourceCount: 4, count: 4, atlasCount: 2,
  words: [{ word: 'a', translation: '冠词' }, { word: 'library', atlasWord: 'library' }, { word: 'colour', aliases: ['color'], atlasWord: 'color' }, { word: 'at', translation: '在' }] };
const card = (word: string, overrides: Partial<VocabularyCard> = {}): VocabularyCard => ({ id: vocabularySyncKey(word), word, lemma: word, source: 'saved_word', status: 'unfamiliar', rank: null, translation: '', phonetic: '', createdAt: 100, updatedAt: 200, due: now,
  fsrs: { state: 0, reps: 0, stability: 0, difficulty: 0, lapses: 0, lastReview: null, due: now }, ...overrides });

describe('Web wordbooks', () => {
  it('puts every Atlas member before missing-resource words without changing the catalog', () => {
    const original = structuredClone(book);
    const plan = buildWordbookPlan(buildVocabularyPlan([], [], null, now), [], book, { id: 'cefrj-a1', dailyNew: 100 }, now);
    expect(buildVocabularyQueue(plan).map(card => card.word)).toEqual(['library', 'color', 'a', 'at']);
    expect(book).toEqual(original);
  });
  it('reuses existing cards, definitions, source, context and memory through spelling aliases', () => {
    const saved = card('color', { translation: '我的释义', contextText: 'My original sentence.', source: 'video_asset:example' });
    const plan = buildWordbookPlan(buildVocabularyPlan([saved], [], null, now), [saved], book, { id: 'cefrj-a1', dailyNew: 15 }, now);
    expect(plan.newWords.find(value => value.id === saved.id)).toMatchObject(saved);
    expect(saved).not.toHaveProperty('atlasWord');
  });
  it('keeps a selected book separate from unrelated book and personal review queues', () => {
    const due = card('outside', { status: 'known', source: 'wordbook:cet6@test', fsrs: { state: 2, reps: 5, stability: 30, difficulty: 3, lapses: 0, lastReview: 1, due: now - 1 }, due: now - 1 });
    const cards = [due];
    const plan = buildWordbookPlan(buildVocabularyPlan(cards, [], null, now), cards, book, { id: 'cefrj-a1', dailyNew: 1 }, now);
    expect(buildVocabularyQueue(plan).map(value => value.word)).toEqual(['library']);
    expect(plan.dueCount).toBe(0);
    expect(due.fsrs.reps).toBe(5);
  });
  it('counts learned and exempt words separately and never relearns overlap', () => {
    const learned = card('color', { status: 'known', fsrs: { state: 2, reps: 4, stability: 30, difficulty: 3, lapses: 0, lastReview: now, due: now + 100 }, due: now + 100 });
    const skipped = card('library', { status: 'known', due: null });
    const cards = [learned, skipped];
    expect(wordbookProgress(book, cards)).toEqual({ total: 4, learned: 1, stable: 1, skipped: 1, remaining: 2 });
    const plan = buildWordbookPlan(buildVocabularyPlan(cards, [], null, now), cards, book, { id: 'cefrj-a1', dailyNew: 15 }, now);
    expect(plan.newWords.map(value => value.word)).toEqual(['a', 'at']);
  });
  it('honors the base daily quota when review logs are unavailable', () => {
    const logs: VocabularyReviewLog[] = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, word: `${i}`, rating: 3, stability: 1, difficulty: 3, intervalDays: 1, isNew: true, timestamp: now - i }));
    const plan = buildWordbookPlan(buildVocabularyPlan([], logs, null, now), [], book, { id: 'cefrj-a1', dailyNew: 5 }, now);
    expect(plan.todayNewCount).toBe(0);
    expect(buildVocabularyQueue(plan)).toEqual([]);
  });
  it('counts daily starts only in the selected book or personal lane', () => {
    const cards = [card('mine'), card('library', { source: 'wordbook:cefrj-a1@test' })];
    const logs: VocabularyReviewLog[] = ['library', 'outside', 'mine'].map((word, i) => ({ id: `${i}`, word, rating: 3, stability: 1, difficulty: 3, intervalDays: 1, isNew: true, timestamp: now - i }));
    const base = buildVocabularyPlan(cards, logs, null, now);
    const bookPlan = buildWordbookPlan(base, cards, book, { id: 'cefrj-a1', dailyNew: 5 }, now, logs);
    const personalPlan = buildWordbookPlan(base, cards, null, { id: 'personal', dailyNew: 5 }, now, logs);
    expect(bookPlan.newStartedToday).toBe(1);
    expect(bookPlan.dailyNewRemaining).toBe(4);
    expect(personalPlan.newStartedToday).toBe(1);
    expect(personalPlan.newWords.map(value => value.word)).toEqual(['mine']);
  });
  it('replaces a newly studied word marked mastered without deleting its review log', () => {
    const mastered = card('library', { status: 'known', reviewExempt: true, due: null, fsrs: { state: 1, reps: 1, stability: 1, difficulty: 3, lapses: 0, lastReview: now, due: now + 100 } });
    const logs: VocabularyReviewLog[] = [{ id: 'review', word: 'library', rating: 3, stability: 1, difficulty: 3, intervalDays: 1, isNew: true, timestamp: now }];
    const plan = buildWordbookPlan(buildVocabularyPlan([mastered], logs, null, now), [mastered], book, { id: 'cefrj-a1', dailyNew: 1 }, now, logs);
    expect(plan.newStartedToday).toBe(0);
    expect(buildVocabularyQueue(plan).map(value => value.word)).toEqual(['color']);
    expect(logs).toHaveLength(1);
  });
  it('keeps book-only cards out of the personal new-word pool', () => {
    const cards = [card('mine'), card('book-only', { source: 'wordbook:senior@test' })];
    const plan = buildWordbookPlan(buildVocabularyPlan(cards, [], null, now), cards, null, { id: 'personal', dailyNew: 15 }, now);
    expect(plan.newWords.map(value => value.word)).toEqual(['mine']);
  });
  it('bounds persisted settings and rejects unknown book identities', () => {
    expect(normalizeWordbookPreferences({ id: 'bad', dailyNew: 100000 })).toEqual({ id: 'personal', dailyNew: 100 });
    expect(normalizeWordbookPreferences(null)).toEqual({ id: 'personal', dailyNew: 15 });
  });
});
