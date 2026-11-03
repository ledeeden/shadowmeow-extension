import { describe, expect, it } from 'vitest';
import { vocabularySyncKey, type VocabularyCard } from '@shadow-language/contracts';
import { assessmentCandidates, readWordbookAssessment, recommendedWordbook, type WordbookAssessment } from './wordbook-assessment';
import { SUBTLEX_10000_WORDS } from './reader-frequency';
import { buildVocabularyPlan } from './vocabulary-scheduler';
import { screenedCard } from './wordbook-screening';
import type { Wordbook } from './wordbook-plan';

const profile: WordbookAssessment = { key: 'test', estimate: 3000, low: 100, high: 4000, completedAt: 100, known: new Set(['library', 'color']), unknown: new Set(['run']) };
const book: Wordbook = { id: 'cefrj-a1', title: 'CEFR-J A1', subtitle: '', english: '', version: 'test', source: '', sourceUrl: '', sourceCount: 5, count: 5, atlasCount: 0,
  words: [{ word: 'the' }, { word: 'library' }, { word: 'colour', aliases: ['color'] }, { word: 'run' }, { word: 'unranked-special-word' }] };
const card = (word: string, extra: Partial<VocabularyCard> = {}): VocabularyCard => ({ id: vocabularySyncKey(word), word, lemma: word, rank: null, translation: '我的释义', phonetic: '', source: 'saved_word', status: 'unfamiliar', due: 10, createdAt: 1, updatedAt: 1,
  fsrs: { state: 0, reps: 0, difficulty: 0, stability: 0, lapses: 0, lastReview: null, due: 10 }, ...extra });

describe('assessment-aware wordbooks', () => {
  it('recommends a starting book at every level boundary', () => {
    expect([0, 1063, 1064, 2414, 2415, 4767, 4768, 7459, 7460, 10000].map(recommendedWordbook))
      .toEqual(['cefrj-a1', 'cefrj-a1', 'cefrj-a2', 'cefrj-a2', 'cefrj-b1', 'cefrj-b1', 'cefrj-b2', 'cefrj-b2', 'study-abroad', 'study-abroad']);
  });
  it('requires a completed applied assessment rather than a settings default or unfinished retest', () => {
    const valid = { startingPoint: { version: 'subtlex-1pl-heuristic-v1', low: 2000, high: 4000, suggestedSize: 3000, completedAt: 100 },
      assessment: { version: 'subtlex-1pl-heuristic-v1', current: null, responses: SUBTLEX_10000_WORDS.slice(0, 14).map((word, i) => ({ word, rank: i + 1, pseudo: false, known: i % 2 === 0 })) } };
    expect(readWordbookAssessment(valid)).toMatchObject({ estimate: 3000, low: 2000, high: 4000 });
    expect(readWordbookAssessment({ vocabularySize: 3000 })).toBeNull();
    expect(readWordbookAssessment({ ...valid, assessment: { ...valid.assessment, current: { word: 'next' } } })).toBeNull();
    expect(readWordbookAssessment({ ...valid, startingPoint: { ...valid.startingPoint, version: 'unknown' } })).toBeNull();
    expect(readWordbookAssessment({ ...valid, assessment: { ...valid.assessment, responses: [{ word: 'forged', rank: 1, pseudo: false, known: true }] } })).toBeNull();
    expect(readWordbookAssessment({ ...valid, startingPoint: { ...valid.startingPoint, low: 4001 } })).toBeNull();
  });
  it('uses the conservative frequency cutoff and explicit known answers, excluding explicit unknown and unranked words', () => {
    expect(assessmentCandidates(book, [], profile).map(value => value.word)).toEqual(['the', 'library', 'colour']);
    expect(assessmentCandidates(book, [], { ...profile, low: 10000 }).map(value => value.word)).not.toContain('run');
  });
  it('preserves studied cards, manual exclusions and manual recognition', () => {
    const studied = card('the', { status: 'known', fsrs: { ...card('the').fsrs, reps: 3, stability: 30 } });
    const manualUnknown = card('library', { reviewExempt: false });
    const manualKnown = card('color', { reviewExempt: true });
    const cards = [studied, manualUnknown, manualKnown], before = structuredClone(cards);
    expect(assessmentCandidates(book, cards, profile)).toEqual([]);
    expect(cards).toEqual(before);
  });
  it('excludes reversible exemptions from study without claiming actual review events', () => {
    const exempt = card('library', { assessmentExemptBatch: 'batch' });
    const plan = buildVocabularyPlan([exempt], [], null, 100);
    expect(plan.newWords).toEqual([]); expect(plan.dueCards).toEqual([]); expect(plan.newStartedToday).toBe(0);
    const restored = { ...exempt, assessmentExemptBatch: null };
    expect(buildVocabularyPlan([restored], [], null, 100).newWords).toEqual([restored]);
  });
  it('lets later explicit screening replace the estimate marker while retaining memory', () => {
    const original = card('library', { assessmentExemptBatch: 'batch' });
    expect(screenedCard(original, true, 100)).toMatchObject({ assessmentExemptBatch: null, reviewExempt: true, fsrs: original.fsrs });
    expect(screenedCard(original, false, 100)).toMatchObject({ assessmentExemptBatch: null, reviewExempt: false, fsrs: original.fsrs });
  });
});
