import { describe, expect, it } from 'vitest';
import { PLAYBACK_RATES } from '@shadow-language/contracts';
import { applyDictationCharacter, createDictationSlots, createGuidedDictationSlots, revealedDictationWords, DEFAULT_DICTATION_PRACTICE_SETTINGS, dictationExpectedCharacterCount, dictationRequiredCharacterCount, dictationWords, isDictationCharacter, isDictationDraftComplete, isDictationDraftCorrect, isDictationDraftCorrectPrefix, isDictationHyphenBoundary, nearestDictationItem, nextIncompleteWord, previousDictationWord } from './dictation-practice';

describe('dictation practice', () => {
  it('keeps only the intended persistent practice preferences', () => {
    expect(DEFAULT_DICTATION_PRACTICE_SETTINGS).toEqual({
      showReference: false,
      autoAdvance: true,
      continueOnError: false,
    });
  });

  it('offers the approved listening speed ladder', () => {
    expect(PLAYBACK_RATES).toEqual([0.4, 0.6, 0.8, 1, 1.2, 1.5, 2]);
  });

  it('extracts English words while ignoring punctuation and preserving useful internal marks', () => {
    expect(dictationWords("If my career hadn't worked out, I'd try part-time work."))
      .toEqual(['If', 'my', 'career', "hadn't", 'worked', 'out', "I'd", 'try', 'part-time', 'work']);
    expect(dictationWords('A 14‑year‑old and a 14–year–old.')).toEqual(['A', '14‐year‐old', 'and', 'a', '14–year–old']);
    expect(dictationWords('Twenty one of 1,000 people.')).toEqual(['Twenty one', 'of', '1,000', 'people']);
    expect(dictationWords('One hundred and five.')).toEqual(['One hundred and five']);
    expect(dictationWords('The 1,000th person.')).toEqual(['The', '1,000th', 'person']);
    expect(dictationWords('One. Two.')).toEqual(['One', 'Two']);
    expect(dictationWords('如果失败，就再试一次。')).toEqual([]);
  });

  it('accepts only a case-insensitive prefix and reports word completion', () => {
    expect(applyDictationCharacter('Career', '', 'c')).toEqual({ status: 'accepted', value: 'c', complete: false, correct: true });
    expect(applyDictationCharacter('Career', 'caree', 'R')).toEqual({ status: 'accepted', value: 'careeR', complete: true, correct: true });
    expect(applyDictationCharacter('Career', 'ca', 'x')).toEqual({ status: 'rejected', value: 'ca', complete: false });
    expect(applyDictationCharacter('hadn’t', 'hadn', "'")).toEqual({ status: 'accepted', value: "hadn'", complete: false, correct: true });
  });

  it('can keep an incorrect character and finish the word in continue mode', () => {
    expect(applyDictationCharacter('cat', 'c', 'x', true)).toEqual({ status: 'accepted', value: 'cx', complete: false, correct: false });
    expect(applyDictationCharacter('cat', 'cx', 't', true)).toEqual({ status: 'accepted', value: 'cxt', complete: true, correct: false });
  });

  it('makes internal hyphens and apostrophes optional without relaxing letter order', () => {
    expect(dictationRequiredCharacterCount('14-year-old')).toBe(9);
    expect(isDictationDraftCorrectPrefix('14-year-old', '14y')).toBe(true);
    expect(isDictationDraftComplete('14-year-old', '14yearold')).toBe(true);
    expect(isDictationDraftCorrect('14-year-old', '14yearold')).toBe(true);
    expect(isDictationDraftCorrect('14‑year‑old', '14-year-old')).toBe(true);
    expect(isDictationDraftCorrect("don't", 'dont')).toBe(true);
    expect(isDictationDraftCorrect('don’t', "don't")).toBe(true);
    expect(isDictationDraftCorrect('14-year-old', '14yerold')).toBe(false);
    expect(isDictationDraftCorrectPrefix('14-year-old', '1-4')).toBe(false);
    expect(isDictationDraftCorrectPrefix('cat', 'c-at')).toBe(false);
    expect(applyDictationCharacter('14-year-old', '14yearol', 'd')).toEqual({ status: 'accepted', value: '14yearold', complete: true, correct: true });
    expect(applyDictationCharacter("don't", 'don', 't')).toEqual({ status: 'accepted', value: 'dont', complete: true, correct: true });
    expect(applyDictationCharacter("don't", 'do', 'x', true)).toEqual({ status: 'accepted', value: 'dox', complete: false, correct: false });
    expect(applyDictationCharacter('cat', 'ca', '-')).toEqual({ status: 'rejected', value: 'ca', complete: false });
    expect(isDictationHyphenBoundary('14-year-old', '14')).toBe(true);
    expect(isDictationHyphenBoundary('14-year-old', '14year')).toBe(true);
    expect(isDictationHyphenBoundary('14-year-old', '14y')).toBe(false);
  });

  it('accepts digit and English number forms without finishing a longer form early', () => {
    expect(isDictationDraftCorrect('14', 'fourteen')).toBe(true);
    expect(isDictationDraftCorrect('fourteen', '14')).toBe(true);
    expect(isDictationDraftCorrect('14-year-old', 'fourteenyearold')).toBe(true);
    expect(isDictationDraftCorrect('fourteen-year-old', '14yearold')).toBe(true);
    expect(isDictationDraftCorrect('twenty one', '21')).toBe(true);
    expect(isDictationDraftCorrect('21st', 'twentyfirst')).toBe(true);
    expect(isDictationDraftCorrect('1,000', 'onethousand')).toBe(true);
    expect(isDictationDraftCorrect('one thousand', '1000')).toBe(true);
    expect(isDictationDraftCorrect('2024', 'twentytwentyfour')).toBe(true);
    expect(isDictationDraftCorrect('14', 'fifteen')).toBe(false);
    expect(isDictationDraftCorrect('14', '140')).toBe(false);
    expect(isDictationDraftComplete('14', 'fo')).toBe(false);
    expect(isDictationDraftComplete('14', 'fx')).toBe(false);
    expect(isDictationDraftComplete('101', 'onehundredand')).toBe(false);
    expect(isDictationDraftComplete('101', 'onehundredxne')).toBe(true);
    expect(isDictationDraftComplete('101', 'onehundredandxne')).toBe(true);
    expect(dictationExpectedCharacterCount('14', '')).toBe(2);
    expect(dictationExpectedCharacterCount('14', 'f')).toBe(8);
    expect(dictationExpectedCharacterCount('fourteen', '1')).toBe(2);
    expect(dictationExpectedCharacterCount('101', 'onehundred')).toBe(13);
    expect(dictationExpectedCharacterCount('101', 'onehundredand')).toBe(16);
    expect(applyDictationCharacter('14', 'f', 'o')).toEqual({ status: 'accepted', value: 'fo', complete: false, correct: true });
    expect(applyDictationCharacter('fourteen', '1', '4')).toEqual({ status: 'accepted', value: '14', complete: true, correct: true });
    expect(applyDictationCharacter('14', '1', '5')).toEqual({ status: 'rejected', value: '1', complete: false });
    expect(isDictationHyphenBoundary('14-year-old', 'fourteen')).toBe(true);
    expect(isDictationHyphenBoundary('101', 'one')).toBe(true);
  });

  it('handles common integer and ordinal boundaries without accepting a different value', () => {
    const equivalents = [
      ['0', 'zero', 'zero'], ['11', 'eleven', 'eleven'], ['40', 'forty', 'forty'],
      ['100', 'one hundred', 'onehundred'], ['101', 'one hundred and one', 'onehundredandone'],
      ['1,001', 'one thousand one', 'onethousandone'],
      ['9999', 'nine thousand nine hundred ninety nine', 'ninethousandninehundredninetynine'],
      ['11th', 'eleventh', 'eleventh'], ['22nd', 'twenty second', 'twentysecond'],
      ['100th', 'one hundredth', 'onehundredth'],
    ];
    for (const [digits, captionWords, typedWords] of equivalents) {
      expect(isDictationDraftCorrect(digits!, typedWords!)).toBe(true);
      expect(isDictationDraftCorrect(captionWords!, digits!.replaceAll(',', ''))).toBe(true);
    }
    expect(isDictationDraftCorrect('01', 'one')).toBe(false);
    expect(isDictationDraftCorrect('21st', 'twentysecond')).toBe(false);
  });

  it('accepts only characters supported by the exercise', () => {
    expect(isDictationCharacter('-')).toBe(true);
    expect(isDictationCharacter("'")).toBe(true);
    expect(isDictationCharacter(' ')).toBe(false);
    expect(isDictationCharacter('.')).toBe(false);
  });

  it('cycles to the next unfinished word and resolves the nearest playable sentence', () => {
    expect(nextIncompleteWord([true, false, true, false], 1)).toBe(3);
    expect(nextIncompleteWord([true, true], 0)).toBeNull();
    expect(previousDictationWord(4, 2)).toBe(1);
    expect(previousDictationWord(4, 0)).toBeNull();
    expect(nearestDictationItem([1, 4, 8], 4)).toBe(1);
    expect(nearestDictationItem([1, 4, 8], 5)).toBe(2);
    expect(nearestDictationItem([1, 4, 8], 20)).toBe(2);
  });

  it('shows above-level and saved unfamiliar words while keeping mastered forms as blanks', () => {
    expect(revealedDictationWords(['the', 'photosynthesis', 'running'], 1000, new Set(['the']), new Set(['run'])))
      .toEqual([true, true, false]);
    expect(revealedDictationWords(['photosynthesis'], 1000, new Set(['photosynthesis']), new Set(['photosynthesis'])))
      .toEqual([false]);
  });

  it('starts at the first blank and skips revealed positions in both directions', () => {
    const words = ['Photosynthesis', 'is', 'a', 'process'];
    const revealed = [true, false, true, false];
    const slots = createGuidedDictationSlots(words, revealed);
    expect(slots).toEqual({ drafts: ['Photosynthesis', '', 'a', ''], completed: revealed });
    expect(nextIncompleteWord(slots.completed, -1)).toBe(1);
    expect(nextIncompleteWord(slots.completed, 1)).toBe(3);
    expect(previousDictationWord(words.length, 3, revealed)).toBe(1);
    expect(previousDictationWord(words.length, 1, revealed)).toBeNull();
    slots.completed[1] = true;
    slots.completed[3] = true;
    expect(nextIncompleteWord(slots.completed, 3)).toBeNull();
    expect(nextIncompleteWord(createGuidedDictationSlots(words, words.map(() => true)).completed, -1)).toBeNull();
  });

  it('initializes every word slot before the first completion is evaluated', () => {
    const progress = createDictationSlots(3);
    progress.completed[0] = true;
    progress.drafts[0] = 'Good';
    expect(progress).toEqual({ drafts: ['Good', '', ''], completed: [true, false, false] });
    expect(nextIncompleteWord(progress.completed, 0)).toBe(1);
  });
});
