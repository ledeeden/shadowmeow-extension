import { describe, expect, it } from 'vitest';
import { dedupeCorpusEntries, vocabularyMatch } from './corpus';

describe('dedupeCorpusEntries', () => {
  it('keeps one best card when a video has multiple corpus records', () => {
    const entries = dedupeCorpusEntries([
      { key: 'watched:video-001', youtubeId: 'video-001', status: 'watched', observedAt: '2026-09-06T10:00:00.000Z' },
      { key: 'track:track-001', youtubeId: 'video-001', status: 'ready', trackId: 'track-001', analysis: { status: 'ready' }, observedAt: '2026-09-05T10:00:00.000Z' },
      { key: 'watched:video-002', youtubeId: 'video-002', status: 'watched', observedAt: '2026-09-06T09:00:00.000Z' },
    ]);

    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.youtubeId === 'video-001')).toMatchObject({ key: 'track:track-001', status: 'ready' });
  });

  it('keeps the best analyzed track when multiple caption tracks belong to one video', () => {
    const entries = dedupeCorpusEntries([
      { key: 'track:asr', youtubeId: 'video-001', status: 'processing', observedAt: '2026-09-06T10:00:00.000Z' },
      { key: 'track:manual', youtubeId: 'video-001', status: 'ready', analysis: { status: 'ready' }, observedAt: '2026-09-05T10:00:00.000Z' },
    ]);

    expect(entries).toEqual([{ key: 'track:manual', youtubeId: 'video-001', status: 'ready', analysis: { status: 'ready' }, observedAt: '2026-09-05T10:00:00.000Z' }]);
  });

  it('does not merge different YouTube videos', () => {
    const entries = dedupeCorpusEntries([
      { key: 'track:one', youtubeId: 'video-001', status: 'ready' },
      { key: 'track:two', youtubeId: 'video-002', status: 'ready' },
    ]);

    expect(entries.map((entry) => entry.youtubeId)).toEqual(['video-001', 'video-002']);
  });

  it('classifies public recommendations against the selected vocabulary size', () => {
    expect(vocabularyMatch({ threshold: 1_000, reachable: true }, 1_000)).toBe('within');
    expect(vocabularyMatch({ threshold: 3_500, reachable: true }, 1_000)).toBe('above');
    expect(vocabularyMatch(null, 1_000)).toBe('unknown');
  });
});
