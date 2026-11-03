import { describe, expect, it } from 'vitest';
import type { ProgressInput, VideoAnalysis } from '@shadow-language/contracts';
import { mergeLocalProgress } from './progress';

const progress: ProgressInput = {
  youtubeId: 'dQw4w9WgXcQ',
  segmentSeq: 4,
  positionMs: 12_000,
  completedRatio: 0.2,
  activeSecondsDelta: 3,
  occurredAt: '2026-09-11T09:00:00.000Z',
};

describe('local progress persistence', () => {
  it('keeps hydrated analysis when a player saves a new position', () => {
    const analysis = { status: 'ready' } as VideoAnalysis;
    const merged = mergeLocalProgress({ activeSecondsTotal: 10, title: 'Existing title', channelTitle: 'Existing channel', durationMs: 60_000, analysis }, progress);

    expect(merged).toMatchObject({
      id: 'dQw4w9WgXcQ',
      positionMs: 12_000,
      activeSecondsTotal: 13,
      title: 'Existing title',
      channelTitle: 'Existing channel',
      durationMs: 60_000,
      analysis,
    });
  });

  it('does not invent analysis for a new local progress record', () => {
    expect(mergeLocalProgress(undefined, progress)).not.toHaveProperty('analysis');
  });
});
