import { describe, expect, it } from 'vitest';
import { advanceActivity, consumeSyncDelta, resetActivityTracker } from './learning-activity';

describe('learning activity tracker', () => {
  it('accumulates across short segment changes and only consumes whole unsynced seconds', () => {
    let tracker = resetActivityTracker('dQw4w9WgXcQ', 0);
    tracker = advanceActivity(tracker, 'dQw4w9WgXcQ', true, 1_000);
    tracker = advanceActivity(tracker, 'dQw4w9WgXcQ', true, 2_000);
    expect(consumeSyncDelta(tracker, true).activeSecondsDelta).toBe(0);
    tracker = advanceActivity(tracker, 'dQw4w9WgXcQ', true, 3_200);
    const consumed = consumeSyncDelta(tracker, false);
    expect(consumed.activeSecondsDelta).toBe(3);
    expect(consumed.tracker.syncedMs).toBe(3_000);
  });

  it('does not count paused time, caps delayed ticks, and resets for a new video', () => {
    let tracker = resetActivityTracker('dQw4w9WgXcQ', 0);
    tracker = advanceActivity(tracker, 'dQw4w9WgXcQ', false, 4_000);
    expect(tracker.activeMs).toBe(0);
    tracker = advanceActivity(tracker, 'dQw4w9WgXcQ', true, 8_000);
    expect(tracker.activeMs).toBe(1_500);
    tracker = advanceActivity(tracker, 'abcdefghijk', true, 9_000);
    expect(tracker).toEqual({ youtubeId: 'abcdefghijk', activeMs: 0, syncedMs: 0, lastWallAt: 9_000 });
  });
});
