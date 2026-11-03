import type { CaptionCache } from './db';

export const CAPTION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function captionCacheId(youtubeId: string, trackId: string): string {
  return `${youtubeId}:${trackId}`;
}

export function isCaptionCacheFresh(record: CaptionCache | undefined, adapterVersion: string, now = Date.now()): record is CaptionCache {
  return Boolean(record
    && record.adapterVersion === adapterVersion
    && record.cues.length > 0
    && record.cachedAt <= now
    && now - record.cachedAt <= CAPTION_CACHE_TTL_MS);
}
