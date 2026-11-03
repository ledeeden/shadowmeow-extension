import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { atlasKey, atlasMedia, findAtlasEntry } from './word-atlas';

const dataset = JSON.parse(readFileSync(new URL('../../web/public/word-atlas.json', import.meta.url), 'utf8'));
afterEach(() => vi.unstubAllGlobals());

describe('Word Atlas', () => {
  it('matches the exact normalized headword and does not guess another word', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => dataset })));
    const entry = await findAtlasEntry(' LIBRARY ');
    expect(entry?.w).toBe('library');
    expect(entry?.ex).toHaveLength(2);
    expect(await findAtlasEntry('libraries')).toBeNull();
    expect(await findAtlasEntry('library card')).toBeNull();
    expect((await findAtlasEntry('post office'))?.w).toBe('post office');
    expect(atlasKey('O’CLOCK')).toBe("o'clock");
  });

  it('uses only media that the upstream index says exists', async () => {
    const entry = (await findAtlasEntry('library'))!;
    expect(atlasMedia(entry, 'uk')).toContain('/audio/uk/library.mp3');
    expect(atlasMedia(entry, 'ex')).toContain('/audio/ex/library.mp3');
    expect(atlasMedia({ ...entry, m: 1 }, 'ex2')).toBeNull();
    expect(atlasMedia({ ...entry, id: '../unsafe' }, 'img')).toBeNull();
  });

  it('falls back on a failed data request and retries later', async () => {
    vi.resetModules();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, json: async () => dataset });
    vi.stubGlobal('fetch', fetcher);
    const fresh = await import('./word-atlas');
    expect(await fresh.findAtlasEntry('library')).toBeNull();
    expect((await fresh.findAtlasEntry('library'))?.w).toBe('library');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
