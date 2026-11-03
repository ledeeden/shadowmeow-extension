import { describe, expect, it } from 'vitest';
import { activeSubtitleWordIndex, cycleSubtitleDisplayMode, isNewSubtitleWord, subtitleDisplayModeLabel, subtitleTextForDisplay, subtitleWordStartTimes } from './subtitle-display';

describe('subtitle display modes', () => {
  it('cycles from English to new words to a complete mask', () => {
    expect(cycleSubtitleDisplayMode('all')).toBe('new-words');
    expect(cycleSubtitleDisplayMode('new-words')).toBe('hidden');
    expect(cycleSubtitleDisplayMode('hidden')).toBe('all');
    expect(subtitleDisplayModeLabel).toEqual({ all: '英文', 'new-words': '生词', hidden: '遮挡' });
  });

  it('only removes outside-vocabulary words from highlighting after mastery', () => {
    const vocabularyKeys = ['unfamiliar'];
    const base = { vocabularySize: 1_000, vocabularyKeys, vocabularyRank: 1_001, countable: true };
    expect(isNewSubtitleWord({ ...base, masteredVocabulary: new Set() })).toBe(true);
    expect(isNewSubtitleWord({ ...base, masteredVocabulary: new Set(vocabularyKeys) })).toBe(false);
  });

  it('uses a CAT estimate as an exact subtitle rank boundary', () => {
    const base = {
      vocabularySize: 4_100,
      vocabularyKeys: ['boundary-word'],
      countable: true,
      masteredVocabulary: new Set<string>(),
    };
    expect(isNewSubtitleWord({ ...base, vocabularyRank: 4_100 })).toBe(false);
    expect(isNewSubtitleWord({ ...base, vocabularyRank: 4_101 })).toBe(true);
  });

  it('does not reveal full transcript text outside English mode', () => {
    const mastered = new Set<string>();
    const fullyMasked = subtitleTextForDisplay('The cat.', 'hidden', 1_000, mastered);
    const newWordMode = subtitleTextForDisplay('The cat.', 'new-words', 10_000, mastered);
    expect(fullyMasked).toContain('█');
    expect(newWordMode).toContain('█');
    expect(`${fullyMasked} ${newWordMode}`).not.toContain('cat');
  });

  it('keeps every word position while only revealing a new word', () => {
    const display = subtitleTextForDisplay('The zyzzyva.', 'new-words', 10_000, new Set());
    expect(display).toContain('█');
    expect(display).toContain('zyzzyva');
    expect(display).not.toContain('The');
  });

  it('uses source timing only when every rendered word has an exact start', () => {
    const timing = {
      wordOffsets: [0, 3, 7],
      wordStarts: [{ offset: 0, startMs: 1_000 }, { offset: 3, startMs: 1_450 }, { offset: 7, startMs: 1_900 }],
      startMs: 1_000,
      endMs: 2_500,
    };
    expect(subtitleWordStartTimes(timing)).toEqual([1_000, 1_450, 1_900]);
    expect(activeSubtitleWordIndex({ ...timing, timeMs: 1_500 })).toBe(1);
    expect(activeSubtitleWordIndex({ ...timing, timeMs: 2_100 })).toBe(2);
  });

  it('does not animate a word position when timing is absent, sparse, or misaligned', () => {
    const timing = { wordOffsets: [0, 4, 8], startMs: 1_000, endMs: 2_200 };
    expect(subtitleWordStartTimes(timing)).toBeNull();
    expect(subtitleWordStartTimes({ ...timing, wordStarts: [{ offset: 0, startMs: 1_000 }, { offset: 8, startMs: 1_800 }] })).toBeNull();
    expect(subtitleWordStartTimes({ ...timing, wordStarts: [{ offset: 0, startMs: 1_000 }, { offset: 5, startMs: 1_400 }, { offset: 8, startMs: 1_800 }] })).toBeNull();
    expect(activeSubtitleWordIndex({ ...timing, timeMs: 900 })).toBeNull();
    expect(activeSubtitleWordIndex({ ...timing, timeMs: 1_500 })).toBeNull();
  });
});
