import { cuesToLearningSegments, videoKeyOf, type PageState } from '@shadow-language/contracts';
import { db, type CaptionCache } from './db';
import { readUserTranscript } from './user-transcripts';
import { captionCacheId } from './caption-cache';

// This repository is used only in extension-origin pages and the background worker.
export function selectTranscript(records: CaptionCache[], videoKey: string, trackId?: string | null) {
  const matches = records.filter(row => row.youtubeId === videoKey && row.cues.length);
  return matches.sort((a, b) => Number(b.trackId === trackId) - Number(a.trackId === trackId) || b.cachedAt - a.cachedAt)[0];
}

export async function readVideoTranscript(videoKey: string, trackId?: string | null) {
  const imported = await readUserTranscript(videoKey);
  if (imported) return imported;
  return selectTranscript(await db.captions.where('youtubeId').equals(videoKey).toArray(), videoKey, trackId);
}

export async function saveVideoTranscript(page: PageState) {
  const key = videoKeyOf(page);
  if (!key || !page.cues.length) return;
  const trackId = page.activeTrackId || 'default';
  await db.captions.put({ id: captionCacheId(key, trackId), youtubeId: key, trackId,
    adapterVersion: 'shared-transcript-v1', cues: page.cues, page: structuredClone(page), cachedAt: Date.now() });
}

export function restoreTranscript(page: PageState, cached?: CaptionCache): PageState {
  if (page.cues.length || !cached?.cues.length || cached.youtubeId !== videoKeyOf(page)) return page;
  const { error: _error, ...rest } = page;
  return { ...cached.page, ...rest, title: rest.title || cached.page?.title || '',
    durationMs: rest.durationMs || cached.page?.durationMs || cached.cues.at(-1)?.endMs || 0,
    tracks: rest.tracks?.length ? rest.tracks : cached.page?.tracks || [], activeTrackId: cached.trackId, cues: cached.cues,
    segments: cuesToLearningSegments(cached.cues, { allowOverlap: true }) };
}

export async function hydrateVideoTranscript(page: PageState) {
  if (page.cues.length) { await saveVideoTranscript(page); return page; }
  return restoreTranscript(page, await readVideoTranscript(videoKeyOf(page), page.activeTrackId));
}
