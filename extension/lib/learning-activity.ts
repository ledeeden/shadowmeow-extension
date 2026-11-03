export type ActivityTracker = {
  youtubeId: string;
  activeMs: number;
  syncedMs: number;
  lastWallAt: number;
};

export function resetActivityTracker(youtubeId: string, now: number): ActivityTracker {
  return { youtubeId, activeMs: 0, syncedMs: 0, lastWallAt: now };
}

export function advanceActivity(tracker: ActivityTracker, youtubeId: string | null, playing: boolean, now: number): ActivityTracker {
  if (!youtubeId) return { ...tracker, lastWallAt: now };
  if (tracker.youtubeId !== youtubeId) return resetActivityTracker(youtubeId, now);
  const elapsed = Math.min(1_500, Math.max(0, now - tracker.lastWallAt));
  return { ...tracker, activeMs: tracker.activeMs + (playing ? elapsed : 0), lastWallAt: now };
}

export function consumeSyncDelta(tracker: ActivityTracker, localOnly: boolean): { tracker: ActivityTracker; activeSecondsDelta: number } {
  if (localOnly) return { tracker, activeSecondsDelta: 0 };
  const activeSecondsDelta = Math.max(0, Math.floor((tracker.activeMs - tracker.syncedMs) / 1000));
  return { tracker: { ...tracker, syncedMs: tracker.syncedMs + activeSecondsDelta * 1000 }, activeSecondsDelta };
}
