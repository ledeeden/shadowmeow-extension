import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from './db';

describe('settings vocabulary threshold normalization', () => {
  it('preserves an exact CAT estimate instead of rounding it up to a preset tier', () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, vocabularySize: 4_100 })).toMatchObject({
      vocabularySize: 4_100,
      learnerLevel: 'B1',
    });
  });
});
