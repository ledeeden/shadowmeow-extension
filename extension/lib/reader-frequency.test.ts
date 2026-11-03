import { describe, expect, it } from 'vitest';
import { SUBTLEX_10000_WORDS, cefrForRank, lookupReaderWord } from './reader-frequency';

describe('reader frequency index', () => {
  it('bundles the same 10k ranked vocabulary scale used by the reference reader', () => {
    expect(SUBTLEX_10000_WORDS).toHaveLength(10_000);
    expect(SUBTLEX_10000_WORDS[0]).toBe('the');
    expect(SUBTLEX_10000_WORDS[9999]).toBe('hitched');
  });

  it('normalizes common inflections before calculating coverage', () => {
    expect(lookupReaderWord('are').lemma).toBe('be');
    expect(lookupReaderWord('graduated').rank).not.toBeNull();
    expect(lookupReaderWord('fascinating').rank).not.toBeNull();
    expect(lookupReaderWord('x').countable).toBe(false);
  });

  it('recognizes contractions, possessives, regional spellings, and degree forms', () => {
    expect(lookupReaderWord("I'm")).toMatchObject({ lemma: 'i', kind: 'contraction', countable: true });
    expect(lookupReaderWord("I'll")).toMatchObject({ lemma: 'i', kind: 'contraction', countable: true });
    expect(lookupReaderWord("what's")).toMatchObject({ lemma: 'what', kind: 'contraction', countable: true });
    expect(lookupReaderWord("world's")).toMatchObject({ lemma: 'world', kind: 'possessive', countable: true });
    const pluralPossessive = lookupReaderWord("friends'");
    expect(pluralPossessive).toMatchObject({ lemma: 'friend', kind: 'possessive', countable: true });
    expect(pluralPossessive.components[0]?.lemma).toBe('friend');
    expect(lookupReaderWord('realise')).toMatchObject({ lemma: 'realize', kind: 'variant', countable: true });
    expect(lookupReaderWord('colour')).toMatchObject({ lemma: 'color', kind: 'variant', countable: true });
    expect(lookupReaderWord('farthest')).toMatchObject({ lemma: 'far', countable: true });
    expect(lookupReaderWord('wont').rank).toBeNull();
  });

  it('maps ranks to the same CEFR bands as the vocabulary estimator', () => {
    expect(cefrForRank(300)).toBe('A1');
    expect(cefrForRank(1_000)).toBe('B1');
    expect(cefrForRank(5_001)).toBe('C1');
    expect(cefrForRank(null)).toBe('C2+');
  });
});
