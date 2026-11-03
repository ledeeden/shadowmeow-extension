import { describe, expect, it } from 'vitest';
import { captionNlpPhrases, validCaptionNlp } from '@shadow-language/contracts';
import { analyzeCaption, analyzeCaptions } from './caption-nlp';

describe('caption NLP with the packaged English model', () => {
  it.each([
    '', '   ', 'I saw a saw.', "I'm ready. I can't go. John's book.",
    '  He’s\t gone.\n😀 mice went running.  ', 'We paid $12.50 in 2024.',
    'state-of-the-art tools… Really?!', '你说 hello\u00a0world.',
    "I'll go. We've finished. They won't come.", 'Same same same.',
  ])('preserves all characters and offsets: %j', text => {
    const result = analyzeCaption(text);
    expect(result.status).toBe('ready');
    expect(validCaptionNlp(result, text)).toBe(true);
    expect(result.tokens.map(token => token.text).join('')).toBe(text);
  });

  it('disambiguates identical surfaces by context', () => {
    const saws = analyzeCaption('I saw a saw.').tokens.filter(token => token.text === 'saw');
    expect(saws.map(token => [token.lemma, token.pos, token.lookupText])).toEqual([
      ['see', 'VERB', 'see'], ['saw', 'NOUN', 'saw'],
    ]);
  });

  it('resolves irregular forms and split contractions without rewriting the source', () => {
    const result = analyzeCaption("I'm ready. I can't go. The mice went running.");
    expect(result.tokens.filter(token => token.lookupText).map(token => token.lookupText))
      .toEqual(['i', 'be', 'ready', 'i', 'can', 'not', 'go', 'the', 'mouse', 'go', 'run']);
  });

  it('does not make names, numbers and punctuation dictionary targets', () => {
    const tokens = analyzeCaption('John paid 42 dollars.').tokens;
    for (const text of ['John', '42', '.']) expect(tokens.find(token => token.text === text)?.lookupText).toBeNull();
  });

  it('uses NLP token indices and original contractions for nearby phrases', () => {
    const result = analyzeCaption("I can't go. We stayed.");
    const index = result.tokens.find(token => token.text === "n't")!.index;
    expect(captionNlpPhrases(result, index)).toContain("i can't go");
    expect(captionNlpPhrases(result, index).every(phrase => !phrase.includes('stayed'))).toBe(true);
  });

  it('rejects stale annotations and bounded-message violations', () => {
    expect(validCaptionNlp(analyzeCaption('We ran.'), 'We run.')).toBe(false);
    expect(() => analyzeCaptions(Array(9).fill('hello'))).toThrow();
    expect(() => analyzeCaptions(['x'.repeat(4001)])).toThrow();
    expect(() => analyzeCaptions([null as unknown as string])).toThrow();
  });
});
