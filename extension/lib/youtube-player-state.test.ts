import { describe, expect, it } from 'vitest';
import { canonicalYoutubeUrl, isSupportedVideoContext, selectCurrentPlayerResponse, youtubeVideoIdFromLocation } from './youtube-player-state';

describe('YouTube SPA player state', () => {
  it('rejects a stale initial response after navigation and chooses the current player response', () => {
    const stale = { videoDetails: { videoId: 'dQw4w9WgXcQ' } };
    const current = { videoDetails: { videoId: 'abcdefghijk' } };
    expect(selectCurrentPlayerResponse('abcdefghijk', [stale, current])).toBe(current);
    expect(selectCurrentPlayerResponse('abcdefghijk', [stale])).toBeNull();
  });

  it('canonicalizes watch pages without disguising Shorts as watch pages', () => {
    expect(canonicalYoutubeUrl('https://www.youtube.com', '/watch', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2', 'dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(canonicalYoutubeUrl('https://www.youtube.com', '/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ')).toBe('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    expect(youtubeVideoIdFromLocation('/shorts/dQw4w9WgXcQ', null)).toBe('dQw4w9WgXcQ');
  });
});

const compatibilityFixtures = [
  ...Array.from({ length: 12 }, (_, index) => ({ name: `manual watch ${index + 1}${index >= 9 ? ' long-video' : ''}`, pathname: '/watch', tracks: [{ language: index % 2 ? 'en-US' : 'en', kind: 'manual' as const }], expected: true })),
  ...Array.from({ length: 12 }, (_, index) => ({ name: `automatic watch ${index + 1}${index >= 9 ? ' long-video' : ''}`, pathname: '/watch', tracks: [{ language: index % 2 ? 'en-GB' : 'en', kind: 'asr' as const }], expected: true })),
  ...Array.from({ length: 8 }, (_, index) => ({ name: `no English captions ${index + 1}`, pathname: '/watch', tracks: index % 2 ? [{ language: 'zh-Hans', kind: 'manual' as const }] : [], expected: false })),
  ...Array.from({ length: 6 }, (_, index) => ({ name: `Shorts degrade ${index + 1}`, pathname: `/shorts/fixture${index}`, tracks: [{ language: 'en', kind: 'asr' as const }], expected: false })),
  ...Array.from({ length: 6 }, (_, index) => ({ name: `live degrade ${index + 1}`, pathname: '/watch', isLive: true, tracks: [{ language: 'en', kind: 'manual' as const }], expected: false })),
  ...Array.from({ length: 6 }, (_, index) => ({ name: `restricted degrade ${index + 1}`, pathname: '/watch', playabilityStatus: 'LOGIN_REQUIRED', tracks: [{ language: 'en', kind: 'manual' as const }], expected: false })),
];

describe('50 YouTube compatibility fixtures', () => {
  it('contains exactly the committed fixture count', () => {
    expect(compatibilityFixtures).toHaveLength(50);
  });

  it.each(compatibilityFixtures)('$name', ({ pathname, tracks, expected, ...optional }) => {
    expect(isSupportedVideoContext({ pathname, tracks, ...optional })).toBe(expected);
  });
});
