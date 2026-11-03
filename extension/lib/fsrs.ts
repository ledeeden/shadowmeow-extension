import type { VocabularyFsrsItem, VocabularyRating } from '@shadow-language/contracts';

/**
 * The same lightweight FSRS variant used by Shadow-Word.
 *
 * Ratings are intentionally kept at 1..4 so the study UI and keyboard
 * shortcuts preserve the original learning contract.
 */
export class FSRSEngine {
  readonly RATING = {
    AGAIN: 1,
    HARD: 2,
    GOOD: 3,
    EASY: 4,
  } as const;

  private readonly w = [
    0.4,   // Initial stability for Again
    0.9,   // Initial stability for Hard
    2.4,   // Initial stability for Good
    5.8,   // Initial stability for Easy
    4.93,  // Initial difficulty mean
    0.94,  // Initial difficulty delta
    0.86,  // Stability increase factor base
    0.01,  // Difficulty damping
    1.49,  // Retrievability decay factor
    0.14,  // Again penalty
    0.94,  // Hard penalty
    2.18,  // Good reward
    0.05,  // Easy bonus
    0.34,  // Forget stability power
    1.26,  // Stability growth power
    0.29,  // Retrievability sensitivity
    2.61,  // Review interval multiplier
  ] as const;

  createItem(now = Date.now()): VocabularyFsrsItem {
    return {
      state: 0,
      difficulty: 0,
      stability: 0,
      reps: 0,
      lapses: 0,
      lastReview: null,
      due: now,
    };
  }

  getRetrievability(item: VocabularyFsrsItem, now = Date.now()): number {
    if (!item.lastReview || item.stability <= 0) return 0;
    const elapsedDays = Math.max(0, (now - item.lastReview) / (1000 * 60 * 60 * 24));
    return Math.pow(1 + 19 / 81 * (elapsedDays / item.stability), -0.5);
  }

  schedule(item: VocabularyFsrsItem, rating: VocabularyRating, now = Date.now()): VocabularyFsrsItem {
    const previous = { ...item };
    let { state, difficulty, stability, reps, lapses } = previous;
    const isNew = state === 0 || reps === 0;

    let nextState = state;
    let nextDifficulty = difficulty;
    let nextStability = stability;
    let nextIntervalDays = 1;

    if (isNew) {
      reps = 1;
      nextDifficulty = Math.max(1, Math.min(10, this.w[4] - (rating - 3) * this.w[5]));
      nextStability = this.w[rating - 1] ?? this.w[2];

      if (rating === this.RATING.AGAIN) {
        nextState = 1;
        lapses = 1;
        nextIntervalDays = 10 / (24 * 60);
      } else if (rating === this.RATING.HARD) {
        nextState = 1;
        nextIntervalDays = 12 / 24;
      } else if (rating === this.RATING.GOOD) {
        nextState = 2;
        nextIntervalDays = Math.max(1, Math.round(nextStability));
      } else {
        nextState = 2;
        nextIntervalDays = Math.max(2, Math.round(nextStability * 1.5));
      }
    } else {
      reps += 1;
      const retrievability = this.getRetrievability(previous, now);
      const difficultyDelta = (rating - 3) * 0.8;
      nextDifficulty = Math.max(1, Math.min(10, difficulty - difficultyDelta));

      if (rating === this.RATING.AGAIN) {
        lapses += 1;
        nextState = 3;
        nextStability = Math.max(0.2, this.w[9] * Math.pow(nextDifficulty, -0.2) * Math.pow(stability, 0.2));
        nextIntervalDays = 10 / (24 * 60);
      } else if (rating === this.RATING.HARD) {
        nextState = 2;
        nextStability = Math.max(1.1 * stability, stability * (1 + 0.15 * (10 - nextDifficulty)));
        nextIntervalDays = Math.max(1, Math.round(nextStability * 0.7));
      } else if (rating === this.RATING.GOOD) {
        nextState = 2;
        const factor = Math.exp(this.w[6]) * (11 - nextDifficulty) * Math.pow(stability, -0.2) * (Math.exp((1 - retrievability) * 0.4) - 1);
        nextStability = Math.max(stability + 1, stability * (1 + Math.max(0.1, factor)));
        nextIntervalDays = Math.max(1, Math.round(nextStability));
      } else {
        nextState = 2;
        const factor = Math.exp(this.w[6]) * (11 - nextDifficulty) * Math.pow(stability, -0.2) * (Math.exp((1 - retrievability) * 0.4) - 1);
        nextStability = Math.max(stability + 2, stability * (1 + Math.max(0.3, factor * 1.4)));
        nextIntervalDays = Math.max(2, Math.round(nextStability * 1.3));
      }
    }

    return {
      state: nextState as VocabularyFsrsItem['state'],
      difficulty: Number(nextDifficulty.toFixed(2)),
      stability: Number(nextStability.toFixed(2)),
      reps,
      lapses,
      lastReview: now,
      due: now + Math.round(nextIntervalDays * 24 * 60 * 60 * 1000),
      intervalDays: nextIntervalDays,
    };
  }

  isMastered(item: VocabularyFsrsItem): boolean {
    return item.stability >= 21 && item.reps >= 3 && item.state === 2;
  }
}
