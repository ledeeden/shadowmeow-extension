import { describe, expect, it } from 'vitest';
import { normalizeLearningPayloadForCloud } from './learning-sync';

describe('learning sync payload compatibility', () => {
  it('drops short native YouTube track IDs for legacy API deployments', () => {
    expect(normalizeLearningPayloadForCloud({ youtubeId: 'dQw4w9WgXcQ', trackId: '.en' })).toEqual({
      youtubeId: 'dQw4w9WgXcQ',
      trackId: null,
    });
  });

  it('keeps long server track IDs and absent track IDs unchanged', () => {
    const remote = { trackId: 'track-server-001' };
    expect(normalizeLearningPayloadForCloud(remote)).toBe(remote);
    const withoutTrack = { youtubeId: 'dQw4w9WgXcQ' };
    expect(normalizeLearningPayloadForCloud(withoutTrack)).toEqual(withoutTrack);
  });
});
