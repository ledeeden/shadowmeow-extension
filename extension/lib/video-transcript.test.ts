import { beforeEach, expect, it, vi } from 'vitest';
import type { PageState } from '@shadow-language/contracts';
const mocks = vi.hoisted(() => ({ put: vi.fn(), rows: [] as any[] }));
vi.mock('./user-transcripts', () => ({ readUserTranscript: async () => undefined, saveUserTranscript: async () => {} }));
vi.mock('./db', () => ({ db: {
  table: () => ({ get: async () => undefined, where: () => ({ equals: () => ({ toArray: async () => [] }) }) }),
  captions: { put: mocks.put, where: () => ({ equals: () => ({ toArray: async () => mocks.rows }) }) },
} }));
import { hydrateVideoTranscript, restoreTranscript, saveVideoTranscript, selectTranscript } from './video-transcript';
const page = { youtubeId: 'abcdefghijk', title: 'Video', activeTrackId: 'en', cues: [{ seq: 0, startMs: 0, endMs: 1000, text: 'Hello there.' }], segments: [] } as unknown as PageState;
const record = { id: 'x', youtubeId: 'abcdefghijk', trackId: 'en', adapterVersion: 'old', cachedAt: 1, cues: page.cues };
beforeEach(() => { mocks.put.mockClear(); mocks.rows = [record]; });
it('persists subtitles by platform video identity and never erases them with empty loading states', async () => {
  await saveVideoTranscript(page);
  await saveVideoTranscript({ ...page, cues: [] });
  expect(mocks.put).toHaveBeenCalledTimes(1);
  expect(mocks.put.mock.calls[0]![0]).toMatchObject({ id: 'abcdefghijk:en', cues: page.cues });
  await saveVideoTranscript({ ...page, youtubeId: null, videoKey: 'bilibili:BV1:2' });
  expect(mocks.put.mock.calls[1]![0].youtubeId).toBe('bilibili:BV1:2');
});
it('restores old captions and timed learning segments after the source tab is closed', async () => {
  const restored = await hydrateVideoTranscript({ ...page, cues: [], error: 'loading' });
  expect(restored.cues).toEqual(page.cues);
  expect(restored.segments.length).toBeGreaterThan(0);
  expect(restored.error).toBeUndefined();
});
it('does not mix videos, prefers requested tracks, and ignores empty cache entries', () => {
  expect(selectTranscript([record, { ...record, trackId: 'fr', cachedAt: 2 }], record.youtubeId, 'en')).toBe(record);
  expect(selectTranscript([{ ...record, cues: [] }, record], record.youtubeId)).toBe(record);
  expect(selectTranscript([record], 'other')).toBeUndefined();
  const empty = { ...page, youtubeId: 'other', cues: [] };
  expect(restoreTranscript(empty, record)).toBe(empty);
});
