import { videoIdentity, videoKeyOf, type NormalizedSegment, type PageState } from '@shadow-language/contracts';

export function playerOverlayEnabled(embedded: boolean, storedValue: unknown): boolean {
  // `youtubeOverlayEnabled` belongs to the extension's on-page master switch.
  // The Web player has no equivalent switch, so inheriting a stale `false`
  // value makes its subtitle surface disappear immediately after hydration.
  return embedded || storedValue !== false;
}

export function playerPersistenceIdentity(
  page: Pick<PageState, 'platform' | 'videoKey' | 'youtubeId'>,
): ReturnType<typeof videoIdentity> | null {
  // Self-hosted media uses a corpus asset id (`media:...`), not a YouTube or
  // Bilibili video identity accepted by the existing learning-data schemas.
  // Treat it as non-persistable until those schemas gain a dedicated media id.
  if (page.platform === 'media') return null;
  const key = videoKeyOf(page);
  return key ? videoIdentity(key) : null;
}

export function isBilibiliCorpusReady(page: Pick<PageState, 'platform' | 'activeTrackId' | 'cues'>): boolean {
  return page.platform !== 'bilibili' || Boolean(page.activeTrackId && page.cues.length > 0);
}

export type SubtitleHoverTransition = {
  command: 'PAUSE' | 'PLAY' | null;
  resumeOnLeave: boolean;
};

export function subtitleHoverTransition(
  phase: 'enter' | 'sentence-end' | 'leave',
  playerState: 'playing' | 'paused' | 'ended',
  resumeOnLeave: boolean,
): SubtitleHoverTransition {
  if (phase === 'enter') {
    return { command: null, resumeOnLeave: false };
  }
  if (phase === 'sentence-end') {
    return playerState === 'playing'
      ? { command: 'PAUSE', resumeOnLeave: true }
      : { command: null, resumeOnLeave: false };
  }
  return resumeOnLeave && playerState !== 'ended'
    ? { command: 'PLAY', resumeOnLeave: false }
    : { command: null, resumeOnLeave: false };
}

export function subtitleHoverDelay(endMs: number, currentMs: number, playbackRate: number): number {
  return Math.max(0, (endMs - currentMs) / Math.max(0.1, playbackRate));
}

export function shouldCancelPendingLoopReplay(
  boundary: Pick<NormalizedSegment, 'startMs' | 'endMs'>,
  timeMs: number,
): boolean {
  // The media clock may pass the sentence boundary before PAUSE takes effect.
  // Only a seek well outside that boundary should cancel the scheduled replay.
  return !Number.isFinite(timeMs) || timeMs < boundary.startMs - 250 || timeMs > boundary.endMs + 500;
}

// A sentence loop must not wait for a page snapshot to land in the tail of a
// sentence: the page reports 4–10 times a second, so that window is missed more
// often than it is hit and the loop stops after a few repetitions. Convert the
// remaining duration to wall time once and decide when the deadline arrives.
export const LOOP_EARLY_TOLERANCE_MS = 100;
// A loop deadline can fire late under load, and the first snapshot after a slow
// 3x sentence lands almost a second past the boundary. Allow that drift: a late
// replay is recoverable, a loop that silently stopped is not.
export const LOOP_LATE_TOLERANCE_MS = 1_500;

export type LoopCycleDecision = 'wait' | 'cycle' | 'cancel';

export function resolveLoopCycle(
  segment: Pick<NormalizedSegment, 'startMs' | 'endMs'>,
  timeMs: number,
  playbackRate: number,
): LoopCycleDecision {
  if (!Number.isFinite(timeMs) || timeMs < segment.startMs - 250 || timeMs > segment.endMs + LOOP_LATE_TOLERANCE_MS) return 'cancel';
  if (subtitleHoverDelay(segment.endMs, timeMs, playbackRate) > LOOP_EARLY_TOLERANCE_MS) return 'wait';
  return 'cycle';
}

export function resolveDisplayedSegment(
  currentSegment: NormalizedSegment | null,
  currentIndex: number,
  hoverTarget: { segment: NormalizedSegment; index: number } | null,
): { segment: NormalizedSegment | null; index: number } {
  return hoverTarget || { segment: currentSegment, index: currentIndex };
}

export function findSegment(segments: NormalizedSegment[], timeMs: number): { segment: NormalizedSegment | null; index: number } {
  if (!segments.length || !Number.isFinite(timeMs)) return { segment: null, index: -1 };

  // Find the last segment that has started. The backwards scan is only needed
  // for overlapping intervals; it makes the latest-started active cue win.
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (segments[mid]!.startMs <= timeMs) low = mid + 1;
    else high = mid;
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    const item = segments[index]!;
    if (item.startMs <= timeMs && timeMs < item.endMs) return { segment: item, index };
  }
  return { segment: null, index: -1 };
}
