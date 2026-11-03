import { describe, expect, it } from 'vitest';
import { analyzeFrequencyCoverage, createPersonalVocabularyCoverage, lookupFrequencyRanks, personalVocabularyCoverage } from './frequency-coverage';

describe('frequency coverage profiles', () => {
  it('reuses a personal vocabulary across transcripts without changing coverage or consuming a word iterator twice', () => {
    const words = ['controversial', 'proposals', "can't"];
    const batch = createPersonalVocabularyCoverage(3000, words.values());
    for (const text of ['The controversial proposals.', "I can't believe it.", 'The same words repeat repeat.']) {
      expect(batch(text)).toEqual(personalVocabularyCoverage(text, 3000, words));
    }
  });
  it('calculates SUBTLEX bands and parallel NGSL coverage independently', () => {
    const coverage = analyzeFrequencyCoverage('The controversial proposal is for everyday people.');
    expect(coverage.totalTokens).toBe(7);
    expect(coverage.subtlex).toHaveLength(10);
    expect(coverage.subtlex.at(-1)?.size).toBe(10_000);
    expect(coverage.ngslS.size).toBe(721);
    expect(coverage.ngsl.size).toBe(2_809);
    expect(coverage.ngslGr.size).toBe(5_000);
    expect(coverage.ngslS.coveragePercent).toBeLessThanOrEqual(coverage.ngsl.coveragePercent);
  });

  it('keeps the four word-list ranks independent', () => {
    const ranks = lookupFrequencyRanks('the');
    expect(ranks.subtlex).toEqual(expect.any(Number));
    expect(ranks.ngslS).toEqual(expect.any(Number));
    expect(ranks.ngsl).toEqual(expect.any(Number));
    expect(ranks.ngslGr).toEqual(expect.any(Number));
    expect(lookupFrequencyRanks('not-a-real-word')).toEqual({ subtlex: null, ngslS: null, ngsl: null, ngslGr: null });
  });

  it('adds the baseline and saved vocabulary as one deduplicated personal set', () => {
    const withBaseline = personalVocabularyCoverage('The controversial proposal.', 3_000, []);
    const withSaved = personalVocabularyCoverage('The controversial proposal.', 3_000, ['controversial']);
    expect(withSaved.knownTokens).toBeGreaterThanOrEqual(withBaseline.knownTokens);
    expect(withSaved.totalTokens).toBe(3);
  });
});
