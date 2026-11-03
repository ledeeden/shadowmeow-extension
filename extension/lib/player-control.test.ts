import { describe, expect, it } from 'vitest';
import type { NormalizedSegment } from '@shadow-language/contracts';
import { findSegment, isBilibiliCorpusReady, playerOverlayEnabled, playerPersistenceIdentity, resolveDisplayedSegment, resolveLoopCycle, shouldCancelPendingLoopReplay, subtitleHoverDelay, subtitleHoverTransition } from './player-control';

const segments: NormalizedSegment[] = [
  { id: 'a', sourceCueIds: ['0'], startMs: 100, endMs: 2_100, text: 'One.', confidence: 1 },
  { id: 'b', sourceCueIds: ['1'], startMs: 2_500, endMs: 12_500, text: 'Two.', confidence: 1 },
];

describe('player control', () => {
  it('keeps the Web player overlay enabled regardless of the extension master switch', () => {
    expect(playerOverlayEnabled(true, false)).toBe(true);
    expect(playerOverlayEnabled(false, false)).toBe(false);
    expect(playerOverlayEnabled(false, undefined)).toBe(true);
  });

  it('does not run YouTube/Bilibili persistence for self-hosted media ids', () => {
    expect(playerPersistenceIdentity({ platform: 'media', videoKey: 'media:youtube-5MgBikgcWnY', youtubeId: null })).toBeNull();
    expect(playerPersistenceIdentity({ platform: 'youtube', youtubeId: '5MgBikgcWnY' })).toEqual({ youtubeId: '5MgBikgcWnY' });
    expect(playerPersistenceIdentity({ platform: 'bilibili', videoKey: 'bilibili:ep:1:cid:2', youtubeId: null })).toEqual({ videoKey: 'bilibili:ep:1:cid:2' });
  });

  it('only exposes the Bilibili learning surface after a corpus is loaded', () => {
    expect(isBilibiliCorpusReady({ platform: 'bilibili', activeTrackId: null, cues: [] })).toBe(false);
    expect(isBilibiliCorpusReady({ platform: 'bilibili', activeTrackId: 'subtitle:fixture:1', cues: [
      { seq: 0, startMs: 0, endMs: 1_000, text: 'Hello.' },
    ] })).toBe(true);
    expect(isBilibiliCorpusReady({ platform: 'youtube', activeTrackId: null, cues: [] })).toBe(true);
  });

  it('finds only an active segment and leaves timing gaps empty', () => {
    expect(findSegment(segments, 1_000).index).toBe(0);
    expect(findSegment(segments, 2_300)).toEqual({ segment: null, index: -1 });
    expect(findSegment(segments, 3_000).index).toBe(1);
    expect(findSegment([], 0)).toEqual({ segment: null, index: -1 });
  });

  it('chooses the latest-started cue when intervals overlap', () => {
    const overlapping: NormalizedSegment[] = [
      { id: 'a', sourceCueIds: ['0'], startMs: 100, endMs: 5_000, text: 'Long.', confidence: 1 },
      { id: 'b', sourceCueIds: ['1'], startMs: 2_000, endMs: 3_000, text: 'Short.', confidence: 1 },
    ];
    expect(findSegment(overlapping, 2_500)).toEqual({ segment: overlapping[1], index: 1 });
    expect(findSegment(overlapping, 3_500)).toEqual({ segment: overlapping[0], index: 0 });
  });

  it('keeps playing on hover, pauses at the sentence end, and resumes only that pause', () => {
    expect(subtitleHoverTransition('enter', 'playing', false)).toEqual({ command: null, resumeOnLeave: false });
    expect(subtitleHoverTransition('sentence-end', 'playing', false)).toEqual({ command: 'PAUSE', resumeOnLeave: true });
    expect(subtitleHoverTransition('leave', 'paused', true)).toEqual({ command: 'PLAY', resumeOnLeave: false });
    expect(subtitleHoverTransition('sentence-end', 'paused', false)).toEqual({ command: null, resumeOnLeave: false });
    expect(subtitleHoverTransition('leave', 'paused', false)).toEqual({ command: null, resumeOnLeave: false });
    expect(subtitleHoverTransition('leave', 'ended', true)).toEqual({ command: null, resumeOnLeave: false });
  });

  it('schedules the sentence boundary in wall time at the current playback rate', () => {
    expect(subtitleHoverDelay(5_000, 3_000, 1)).toBe(2_000);
    expect(subtitleHoverDelay(5_000, 3_000, 2)).toBe(1_000);
    expect(subtitleHoverDelay(5_000, 5_200, 1)).toBe(0);
  });

  it('keeps a pending loop replay across the sentence boundary but cancels a real seek', () => {
    const boundary = segments[0]!;
    expect(shouldCancelPendingLoopReplay(boundary, 2_100)).toBe(false);
    expect(shouldCancelPendingLoopReplay(boundary, 2_300)).toBe(false);
    expect(shouldCancelPendingLoopReplay(boundary, 5_000)).toBe(true);
    expect(shouldCancelPendingLoopReplay(boundary, Number.NaN)).toBe(true);
  });

  it('waits before the sentence end and cycles from the first snapshot past it', () => {
    expect(resolveLoopCycle(segments[0]!, 1_000, 1)).toBe('wait');
    expect(resolveLoopCycle(segments[0]!, 1_950, 1)).toBe('wait');
    // Inside the tolerance before the end, and at or past it: both cycle.
    expect(resolveLoopCycle(segments[0]!, 2_050, 1)).toBe('cycle');
    expect(resolveLoopCycle(segments[0]!, 2_100, 1)).toBe('cycle');
    expect(resolveLoopCycle(segments[0]!, 2_400, 1)).toBe('cycle');
  });

  it('scales the sentence loop wait with the playback rate', () => {
    // 7.5s of media left: a wait at 1x and at 3x, a cycle once it is spent.
    expect(resolveLoopCycle(segments[1]!, 5_000, 1)).toBe('wait');
    expect(resolveLoopCycle(segments[1]!, 5_000, 3)).toBe('wait');
    expect(resolveLoopCycle(segments[1]!, 12_400, 3)).toBe('cycle');
  });

  it('tolerates a late loop deadline but drops a real seek', () => {
    const boundary = segments[0]!;
    expect(resolveLoopCycle(boundary, boundary.endMs + 1_400, 1)).toBe('cycle');
    expect(resolveLoopCycle(boundary, boundary.endMs + 2_000, 1)).toBe('cancel');
    expect(resolveLoopCycle(boundary, boundary.startMs - 400, 1)).toBe('cancel');
    expect(resolveLoopCycle(boundary, Number.NaN, 1)).toBe('cancel');
  });

  it('repeats every sentence length, sampling phase and playback rate', () => {
    // The regression this guards: the boundary used to require a snapshot inside
    // the last 100ms of a sentence, which a 100–250ms cadence simply misses.
    for (const rate of [0.5, 1, 1.5, 2, 3]) {
      for (const snapshotMs of [100, 250]) {
        for (let lengthMs = 600; lengthMs <= 6_000; lengthMs += 25) {
          for (let phaseMs = 0; phaseMs < snapshotMs; phaseMs += 25) {
            const segment = { startMs: 1_000, endMs: 1_000 + lengthMs };
            const stepMs = snapshotMs * rate;
            const samples = Math.ceil((lengthMs + stepMs - phaseMs) / stepMs);
            const decisions = Array.from({ length: samples }, (_, index) =>
              resolveLoopCycle(segment, segment.startMs + phaseMs + index * stepMs, rate));
            expect(decisions, `rate=${rate} snapshot=${snapshotMs}ms length=${lengthMs}ms phase=${phaseMs}ms`).toContain('cycle');
            expect(decisions).not.toContain('cancel');
          }
        }
      }
    }
  });

  it('keeps the hovered sentence displayed after playback reaches the next segment boundary', () => {
    expect(resolveDisplayedSegment(segments[1]!, 1, { segment: segments[0]!, index: 0 })).toEqual({ segment: segments[0], index: 0 });
    expect(resolveDisplayedSegment(segments[1]!, 1, null)).toEqual({ segment: segments[1], index: 1 });
  });
});
