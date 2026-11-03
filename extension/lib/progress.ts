import { videoKeyOf, type ProgressInput, type VideoAnalysis } from '@shadow-language/contracts';

export type ExistingLocalProgress = {
  activeSecondsTotal?: number;
  thumbnailUrl?: string | undefined;
  title?: string | undefined;
  channelTitle?: string | undefined;
  durationMs?: number | undefined;
  trackId?: string | null | undefined;
  analysis?: VideoAnalysis | null;
};

export type LocalProgressSave = ProgressInput & {
  id: string;
  syncStatus: 'pending';
  activeSecondsTotal: number;
  analysis?: VideoAnalysis | null;
};

/**
 * Progress events do not carry video analysis. Keep the locally hydrated
 * analysis when an active player writes a newer position.
 */
export function mergeLocalProgress(previous: ExistingLocalProgress | undefined, progress: ProgressInput): LocalProgressSave {
  const next: LocalProgressSave = {
    ...progress,
    ...(progress.thumbnailUrl === undefined && previous?.thumbnailUrl !== undefined ? { thumbnailUrl: previous.thumbnailUrl } : {}),
    ...(progress.title === undefined && previous?.title !== undefined ? { title: previous.title } : {}),
    ...(progress.channelTitle === undefined && previous?.channelTitle !== undefined ? { channelTitle: previous.channelTitle } : {}),
    ...(progress.durationMs === undefined && previous?.durationMs !== undefined ? { durationMs: previous.durationMs } : {}),
    ...(progress.trackId === undefined && previous?.trackId !== undefined ? { trackId: previous.trackId } : {}),
    id: videoKeyOf(progress),
    syncStatus: 'pending',
    activeSecondsTotal: (previous?.activeSecondsTotal || 0) + progress.activeSecondsDelta,
  };
  if (previous?.analysis !== undefined) next.analysis = previous.analysis;
  return next;
}
