import { describe, expect, it } from 'vitest';
import type { VocabularyCard } from '@shadow-language/contracts';
import { screenedCard, screenedKnownWords } from './wordbook-screening';
import { buildVocabularyPlan } from './vocabulary-scheduler';
const now = Date.now();
const card: VocabularyCard = { id: 'vocab_library', word: 'library', lemma: 'library', source: 'video_asset:example', translation: '我的释义', phonetic: '', contextText: 'My original sentence.', rank: 100, status: 'known', createdAt: 1, updatedAt: 2, due: now - 1,
  fsrs: { state: 2, reps: 7, stability: 30, difficulty: 3, lapses: 1, lastReview: now - 100, due: now - 1 } };
describe('explicit recognition screening', () => {
  it('supports selecting known words or inversely selecting unknown words', () => {
    const words = ['one', 'two', 'three'].map(word => ({ word }));
    expect(screenedKnownWords(words, new Set(['one']), 'known')).toEqual(['one']);
    expect(screenedKnownWords(words, new Set(['one']), 'unknown')).toEqual(['two', 'three']);
    expect(screenedKnownWords(words, new Set(), 'unknown')).toEqual(['one', 'two', 'three']);
  });
  it('exempts explicitly known words without erasing any learning history or source', () => {
    const screened = screenedCard(card, true, now);
    expect(screened).toMatchObject({ fsrs: card.fsrs, source: card.source, contextText: card.contextText, translation: card.translation, createdAt: card.createdAt, reviewExempt: true, due: null });
    expect(buildVocabularyPlan([screened], [], null, now).dueCards).toEqual([]);
    expect(card).not.toHaveProperty('reviewExempt');
  });
  it('keeps automatic mastery in review while explicit recognition is exempt', () => {
    expect(buildVocabularyPlan([card], [], null, now).dueCards).toHaveLength(1);
    expect(buildVocabularyPlan([screenedCard(card, true, now)], [], null, now).dueCards).toHaveLength(0);
  });
  it('can re-enable a previously screened word without resetting FSRS', () => {
    const restored = screenedCard(screenedCard(card, true, now), false, now);
    expect(restored).toMatchObject({ fsrs: card.fsrs, reviewExempt: false, status: 'learning', due: now });
    expect(buildVocabularyPlan([restored], [], null, now).dueCards).toHaveLength(1);
  });
});
