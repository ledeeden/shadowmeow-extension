import { describe, expect, it } from 'vitest';
import type { CaptionTrack } from '@shadow-language/contracts';
import { chooseEnglishCaptionTrack, classifyYoutubeCaptionTrack, isEnglishCaptionTrack, sortEnglishCaptionTracks } from './youtube-track';

const track = (overrides: Partial<CaptionTrack>): CaptionTrack => ({
  id: '.en',
  language: 'en',
  label: 'English',
  kind: 'manual',
  baseUrl: 'https://www.youtube.com/api/timedtext?v=video',
  ...overrides,
});

describe('YouTube caption track detection', () => {
  it('recognizes automatic tracks from kind, source id, or URL markers', () => {
    expect(classifyYoutubeCaptionTrack({ languageCode: 'en', kind: 'asr', vssId: 'a.en' })).toBe('asr');
    expect(classifyYoutubeCaptionTrack({ languageCode: 'en', vssId: 'a.en' })).toBe('asr');
    expect(classifyYoutubeCaptionTrack({ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?kind=asr' })).toBe('asr');
  });

  it('does not mistake non-English tracks for English auto captions', () => {
    expect(classifyYoutubeCaptionTrack({ languageCode: 'fr', kind: 'asr', vssId: 'a.fr' })).toBe('translation');
    expect(isEnglishCaptionTrack(track({ language: 'fr', kind: 'translation' }))).toBe(false);
  });

  it('prefers automatic English for word-timed playback, then manual tracks', () => {
    const auto = track({ id: 'a.en', label: 'English (auto-generated)', kind: 'asr' });
    const regional = track({ id: '.en-US', language: 'en-US', label: 'English (United States)' });
    const manual = track({ id: '.en', label: 'English' });
    const sorted = sortEnglishCaptionTracks([auto, regional, manual]);
    expect(sorted.map((item) => item.id)).toEqual(['a.en', '.en', '.en-US']);
    expect(chooseEnglishCaptionTrack([auto, regional, manual])?.id).toBe('a.en');
  });
});
