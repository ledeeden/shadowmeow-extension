import { describe, expect, it } from 'vitest';
import type { VocabularyCard, VocabularyReviewLog } from '@shadow-language/contracts';
import { buildVocabularyPlan, buildVocabularyQueue } from './vocabulary-scheduler';

function card(id: string, status: VocabularyCard['status'], rank: number, due: number | null, reps = 0): VocabularyCard {
  return {
    id,
    word: id,
    lemma: id,
    rank,
    phonetic: '',
    translation: id,
    status,
    source: 'test',
    createdAt: 0,
    updatedAt: 0,
    due,
    fsrs: { state: reps ? 2 : 0, difficulty: 0, stability: reps ? 2 : 0, reps, lapses: 0, lastReview: null, due: due || 0 },
  };
}

describe('vocabulary study planning', () => {
  it('puts due reviews before new words and sorts new words by frequency rank', () => {
    const now = Date.UTC(2026, 0, 2, 12);
    const plan = buildVocabularyPlan([
      card('hard-new', 'unfamiliar', 900, now, 0),
      card('due-late', 'learning', 200, now - 1_000, 1),
      card('due-early', 'learning', 300, now - 2_000, 1),
      card('easy-new', 'unfamiliar', 100, now, 0),
    ], [], null, now);
    const queue = buildVocabularyQueue(plan);
    expect(queue.map((item) => item.id)).toEqual(['due-early', 'due-late', 'easy-new', 'hard-new']);
  });

  it('honors the default daily new-word quota and counts unique starts', () => {
    const now = Date.UTC(2026, 0, 2, 12);
    const logs: VocabularyReviewLog[] = Array.from({ length: 24 }, (_, index) => ({
      id: `review-${index}`,
      word: `word-${index}`,
      rating: 3,
      stability: 2,
      difficulty: 4,
      intervalDays: 2,
      isNew: true,
      timestamp: now - index * 1_000,
    }));
    const plan = buildVocabularyPlan(Array.from({ length: 4 }, (_, index) => card(`new-${index}`, 'unfamiliar', index + 1, now, 0)), logs, null, now);
    expect(plan.dailyNewTarget).toBe(25);
    expect(plan.dailyNewRemaining).toBe(1);
    expect(plan.todayNewCount).toBe(1);
  });

  it('keeps mastered learned cards in due reviews, including legacy cleared due dates', () => {
    const now = Date.UTC(2026, 9, 27, 12);
    const stable = card('stable', 'known', 100, now - 500, 4);
    const legacy = card('legacy', 'known', 200, null, 6);
    legacy.fsrs.due = now - 1000;
    const manual = card('manual', 'known', 300, null, 0);
    const later = card('later', 'known', 400, now + 1000, 8);
    const ignored = card('ignored', 'ignored', 500, now - 2000, 5);
    const plan = buildVocabularyPlan([stable, legacy, manual, later, ignored], [], null, now);
    expect(plan.dueCards.map(card => card.id)).toEqual(['legacy', 'stable']);
    expect(legacy.due).toBeNull();
    expect(plan.newPoolCount).toBe(0);
  });
});
