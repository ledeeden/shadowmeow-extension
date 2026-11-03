import { describe, expect, it } from 'vitest';
import { capitalizeDictation } from './dictation-case';

describe('dictation capitalization', () => {
  it('handles sentences, I contractions, and names without changing wording', () => {
    expect(capitalizeDictation("hello. i'm learning english on monday.\nwe visit london. ")).toBe("Hello. I'm learning English on Monday.\nWe visit London. ");
  });
  it('does not capitalize an unfinished i inside another word', () => {
    expect(capitalizeDictation('This is i')).toBe('This is i');
    expect(capitalizeDictation('This is interesting.')).toBe('This is interesting.');
  });
  it('preserves ambiguous common words and existing capitals', () => {
    expect(capitalizeDictation('You may help us with iPhone.')).toBe('You may help us with iPhone.');
  });
  it('supports user names and multiword place names', () => {
    expect(capitalizeDictation('Ask ryan about new york. ', 'Ryan, New York')).toBe('Ask Ryan about New York. ');
  });
  it('keeps character offsets and non-English composition intact', () => {
    const text = '你好，hello. “how are you?” i am fine. ';
    expect(capitalizeDictation(text)).toBe('你好，hello. “How are you?” I am fine. ');
    expect(capitalizeDictation(text).length).toBe(text.length);
  });
});
