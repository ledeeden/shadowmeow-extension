import { describe, expect, it } from 'vitest';
import { applyCaptionProofToken, extractCaptionProofToken, selectNativeCaptionTrack } from './youtube-proof-token';

describe('YouTube caption proof token', () => {
  it('extracts only timedtext proof tokens with a video id', () => {
    expect(extractCaptionProofToken('https://www.youtube.com/api/timedtext?v=abcdefghijk&pot=proof-token')).toEqual({ videoId: 'abcdefghijk', token: 'proof-token' });
    expect(extractCaptionProofToken('https://www.youtube.com/watch?v=abcdefghijk&pot=proof-token')).toBeNull();
    expect(extractCaptionProofToken('https://example.com/api/timedtext?v=abcdefghijk&pot=proof-token')).toBeNull();
    expect(extractCaptionProofToken('https://www.youtube.com/api/timedtext?v=abcdefghijk')).toBeNull();
  });

  it('adds the WEB client and proof token without dropping caption parameters', () => {
    const result = new URL(applyCaptionProofToken('https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&fmt=json3', 'proof-token'));
    expect(result.searchParams.get('v')).toBe('abcdefghijk');
    expect(result.searchParams.get('lang')).toBe('en');
    expect(result.searchParams.get('fmt')).toBe('json3');
    expect(result.searchParams.get('c')).toBe('WEB');
    expect(result.searchParams.get('pot')).toBe('proof-token');
  });

  it('selects the native track needed to trigger a proof token request', () => {
    const tracks = [
      { vss_id: '.en', languageCode: 'en' },
      { vss_id: 'a.en', languageCode: 'en', kind: 'asr' },
    ];
    expect(selectNativeCaptionTrack(tracks, 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr')).toEqual(tracks[1]);
    expect(selectNativeCaptionTrack(tracks, 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=fr')).toBeNull();
  });
});
