import { describe, expect, it } from 'vitest';
import { CAPTION_CACHE_TTL_MS, captionCacheId, isCaptionCacheFresh } from './caption-cache';

const record = {
  id: 'video:track',
  youtubeId: 'abcdefghijk',
  trackId: 'track-id',
  adapterVersion: 'adapter-v1',
  cues: [{ seq: 0, startMs: 0, endMs: 1000, text: 'Hello' }],
  cachedAt: 1_000,
};

describe('caption cache', () => {
  it('uses a track-scoped deterministic key', () => {
    expect(captionCacheId('abcdefghijk', 'track-id')).toBe('abcdefghijk:track-id');
  });

  it('rejects stale, future, empty, or incompatible records', () => {
    expect(isCaptionCacheFresh(record, 'adapter-v1', 1_000 + CAPTION_CACHE_TTL_MS)).toBe(true);
    expect(isCaptionCacheFresh(record, 'adapter-v1', 1_001 + CAPTION_CACHE_TTL_MS)).toBe(false);
    expect(isCaptionCacheFresh(record, 'adapter-v2', 1_001)).toBe(false);
    expect(isCaptionCacheFresh({ ...record, cues: [] }, 'adapter-v1', 1_001)).toBe(false);
    expect(isCaptionCacheFresh({ ...record, cachedAt: 2_000 }, 'adapter-v1', 1_001)).toBe(false);
  });
});
