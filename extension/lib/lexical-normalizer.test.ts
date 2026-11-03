import { describe, expect, it } from 'vitest';
import { morphologyCandidates, normalizeWord, resolveLexicalSurface, tokenizeLexicalText } from './lexical-normalizer';

describe('lexical normalization', () => {
  it('normalizes typography without losing the original surface', () => {
    expect(normalizeWord('I’m')).toBe("i'm");
    expect(normalizeWord('CAFÉ')).toBe('cafe');
  });

  it('expands standard contractions into their component lemmas', () => {
    expect(resolveLexicalSurface("I'm")).toMatchObject({ lemma: 'i', kind: 'contraction', candidateLemmas: ['i', 'be'] });
    expect(resolveLexicalSurface("I'll").candidateLemmas).toEqual(['i', 'will']);
    expect(resolveLexicalSurface("what's").candidateLemmas).toEqual(['what', 'be', 'have']);
    expect(resolveLexicalSurface("don't").candidateLemmas).toEqual(['do', 'not']);
    expect(resolveLexicalSurface("doesn't").candidateLemmas).toEqual(['do', 'not']);
    expect(resolveLexicalSurface("aren't").candidateLemmas).toEqual(['be', 'not']);
    expect(resolveLexicalSurface("won't").candidateLemmas).toEqual(['will', 'not']);
    expect(resolveLexicalSurface("John's")).toMatchObject({ lemma: 'john', kind: 'possessive' });
  });

  it('keeps spoken reductions as multi-lemma expansions', () => {
    expect(resolveLexicalSurface('gonna')).toMatchObject({ lemma: 'go', kind: 'spoken-reduction' });
    expect(resolveLexicalSurface('gonna').components.map((item) => item.lemma)).toEqual(['go', 'to']);
    expect(resolveLexicalSurface('c’mon').components.map((item) => item.lemma)).toEqual(['come', 'on']);
    expect(resolveLexicalSurface("y’all").components.map((item) => item.lemma)).toEqual(['you', 'all']);
    expect(resolveLexicalSurface("let's").components.map((item) => item.lemma)).toEqual(['let', 'we']);
  });

  it('generates validated candidates for regular and irregular forms', () => {
    expect(morphologyCandidates('focussing')).toContain('focus');
    expect(morphologyCandidates('mapped')).toContain('map');
    expect(resolveLexicalSurface('farthest').lemma).toBe('far');
    expect(resolveLexicalSurface('specialises')).toMatchObject({ lemma: 'specializes', kind: 'variant' });
    expect(resolveLexicalSurface("friends'").candidateLemmas).toContain('friend');
  });

  it('keeps sentence boundaries while sharing tokenization', () => {
    expect(tokenizeLexicalText("I'm ready. I'll go.")).toEqual([
      { raw: "I'm", sentenceStart: true },
      { raw: 'ready', sentenceStart: false },
      { raw: "I'll", sentenceStart: true },
      { raw: 'go', sentenceStart: false },
    ]);
  });
});
