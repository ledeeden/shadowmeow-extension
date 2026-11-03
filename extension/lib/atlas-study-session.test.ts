import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VocabularyCard } from '@shadow-language/contracts';
import { acceptAnswer, buildAtlasSession, clozeSentence, gradeAnswer, meaningOf, quizOptions } from './atlas-study-session';
import type { AtlasEntry } from './word-atlas';

const catalog: AtlasEntry[] = JSON.parse(readFileSync(new URL('../../web/public/word-atlas.json', import.meta.url), 'utf8'));
const card = (word: string, reps = 0): VocabularyCard => ({ id: word, word, lemma: word, translation: '', phonetic: '', rank: null, source: 'test', status: reps ? 'learning' : 'unfamiliar', createdAt: 1, updatedAt: 1, due: 1, fsrs: { state: reps ? 2 : 0, difficulty: 3, stability: reps ? 5 : 0, reps, lapses: 0, lastReview: null, due: 1 } });

describe('Word Atlas learning session', () => {
  it('reviews first, then introduces batches of five before their recall', () => {
    const words = ['library', 'welcome', 'another', 'book', 'river', 'horse'];
    const s = buildAtlasSession([card('rain', 2), ...words.map(w => card(w))], catalog, 7);
    expect(s.steps[0]?.cardId).toBe('rain');
    expect(s.steps[0]?.kind).not.toBe('intro');
    expect(s.steps.slice(1, 6).map(step => step.kind)).toEqual(Array(5).fill('intro'));
    expect(new Set(s.steps.slice(6, 11).map(step => step.cardId))).toEqual(new Set(words.slice(0, 5)));
    expect(s.steps.slice(6, 11).every(step => step.kind !== 'intro')).toBe(true);
    expect(s.steps[11]).toMatchObject({ kind: 'intro', cardId: 'horse' });
  });

  it('only matches headwords and keeps unknown words in the old card flow', () => {
    const s = buildAtlasSession([card('libraries'), card('not-in-atlas')], catalog, 9);
    expect(s.steps.filter(step => step.kind !== 'intro').every(step => step.kind === 'fallback')).toBe(true);
  });

  it('creates four distinct, plausible options without repeating the answer meaning', () => {
    const target = catalog.find(entry => entry.w === 'welcome')!;
    for (const kind of ['meaning', 'listen', 'picture'] as const) {
      const ids = quizOptions(target, catalog, kind, 123);
      expect(ids).toHaveLength(4); expect(new Set(ids).size).toBe(4); expect(ids).toContain(target.id);
      const texts = ids.map(id => catalog.find(entry => entry.id === id)!).map(e => kind === 'meaning' ? meaningOf(e, 1) : e.w);
      expect(new Set(texts).size).toBe(4);
    }
  });

  it('masks repeated headwords and regular inflections; missing matches never become picture prompts', () => {
    expect(clozeSentence('We welcome you. They welcomed us.', 'welcome')).toBe('We ______ you. They ______ us.');
    expect(clozeSentence('She taught him, then teaches me.', 'teach')).toBe('She ______ him, then ______ me.');
    expect(clozeSentence('It is a library.', 'book')).toBeNull();
  });

  it('uses the upstream timing and hint thresholds for automatic grading', () => {
    expect(gradeAnswer('meaning', false, 100, false)).toBe(1);
    expect(gradeAnswer('spell', true, 100, true)).toBe(2);
    expect(gradeAnswer('meaning', true, 9500, false)).toBe(2);
    expect(gradeAnswer('meaning', true, 1000, false)).toBe(3);
    expect(gradeAnswer('spell', true, 5000, false)).toBe(4);
  });

  it('changes format for delayed retries, preserves first grades and caps retries at two', () => {
    let s = buildAtlasSession([card('welcome', 2), card('library', 2), card('book', 2), card('river', 2)], catalog, 12);
    s.steps[0] = { cardId: 'welcome', kind: 'meaning', options: [] };
    s = acceptAnswer(s, { correct: false, rating: 1 }, catalog);
    expect(s.steps[4]).toMatchObject({ cardId: 'welcome', retry: true });
    expect(s.steps[4]?.kind).not.toBe('meaning');
    s = { ...s, index: 4 };
    s = acceptAnswer(s, { correct: false, rating: 1 }, catalog);
    s = { ...s, index: s.steps.length - 1 };
    s = acceptAnswer(s, { correct: true, rating: 3 }, catalog);
    expect(s.graded.welcome).toEqual({ correct: false, rating: 1 });
    expect(s.steps.filter(step => step.cardId === 'welcome' && step.retry)).toHaveLength(2);
  });
});
