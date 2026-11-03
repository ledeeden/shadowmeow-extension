import { describe, expect, it } from 'vitest';
import { FSRSEngine } from './fsrs';

describe('Shadow-Word compatible FSRS scheduler', () => {
  const now = Date.UTC(2026, 0, 1, 9);

  it('keeps the original new-card intervals', () => {
    const engine = new FSRSEngine();
    const again = engine.schedule(engine.createItem(now), engine.RATING.AGAIN, now);
    const hard = engine.schedule(engine.createItem(now), engine.RATING.HARD, now);
    const good = engine.schedule(engine.createItem(now), engine.RATING.GOOD, now);
    const easy = engine.schedule(engine.createItem(now), engine.RATING.EASY, now);

    expect(again).toMatchObject({ state: 1, reps: 1, lapses: 1, intervalDays: 10 / (24 * 60) });
    expect(hard).toMatchObject({ state: 1, reps: 1, intervalDays: 0.5 });
    expect(good).toMatchObject({ state: 2, reps: 1, intervalDays: 2 });
    expect(easy).toMatchObject({ state: 2, reps: 1, intervalDays: 9 });
  });

  it('graduates an easy card on the second successful review', () => {
    const engine = new FSRSEngine();
    const first = engine.schedule(engine.createItem(now), engine.RATING.EASY, now);
    const second = engine.schedule(first, engine.RATING.EASY, first.due);
    expect(second.reps).toBe(2);
    expect(second.state).toBe(2);
    expect(second.stability).toBeGreaterThan(first.stability);
  });
});
