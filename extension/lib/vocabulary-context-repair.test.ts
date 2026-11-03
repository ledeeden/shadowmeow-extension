import { describe, expect, it } from 'vitest';
import { recoverMaskedVocabularyContext } from './vocabulary-context-repair';
import { subtitleTextForDisplay } from './subtitle-display';

describe('legacy masked vocabulary contexts', () => {
  const source = 'I met Catherine at the station with Marco.';
  const masked = subtitleTextForDisplay(source, 'new-words', 1000, new Set()).trim();

  it('recovers the original punctuation and words from a unique source match', () => {
    expect(masked).toContain('█');
    expect(recoverMaskedVocabularyContext(masked, 'catherine', [source, source])).toBe(source);
  });

  it('also recovers an old bilingual display without keeping the translation in the English context', () => {
    expect(recoverMaskedVocabularyContext(`${masked}\n我遇见了凯瑟琳。`, 'catherine', [source])).toBe(source);
  });

  it('does not guess when two sentences fit the mask', () => {
    const hidden = subtitleTextForDisplay('We met Catherine.', 'new-words', 1000, new Set());
    expect(recoverMaskedVocabularyContext(hidden, 'catherine', ['We met Catherine.', 'He met Catherine.'])).toBeNull();
  });

  it('preserves clean, unmatched, and unrelated-word contexts', () => {
    expect(recoverMaskedVocabularyContext(source, 'catherine', [source])).toBeNull();
    expect(recoverMaskedVocabularyContext('██ Catherine ████████████', 'catherine', [source])).toBeNull();
    expect(recoverMaskedVocabularyContext(masked, 'alice', [source])).toBeNull();
    expect(recoverMaskedVocabularyContext(masked, 'catherine', [masked])).toBeNull();
    expect(recoverMaskedVocabularyContext('██ ███ ████████', 'catherine', ['We met Catherine.'])).toBeNull();
  });
});
