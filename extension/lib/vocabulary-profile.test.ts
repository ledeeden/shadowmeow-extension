import { describe, expect, it } from 'vitest';
import { lookupReaderWord } from './reader-frequency';
import { DEFAULT_VOCABULARY_SIZE, NGSL_VOCABULARY_TIERS, SUBTLEX_VOCABULARY_TIERS, VOCABULARY_TIERS, analyzeVocabularyText, exactVocabularyTierForSize, isOutsideVocabulary, newVocabularyLemmas, previewLevelForVocabularySize, recommendedVocabularyForProfile, vocabularyCoverage, vocabularyThresholdLabel, vocabularyTierForSize, vocabularyTierIndexForRank } from './vocabulary-profile';

describe('shared vocabulary tiers', () => {
  it('keeps NGSL and SUBTLEX-US as separate reading ladders', () => {
    expect(DEFAULT_VOCABULARY_SIZE).toBe(3_000);
    expect(NGSL_VOCABULARY_TIERS.map((tier) => tier.rank)).toEqual([721, 2_809, 5_000]);
    expect(NGSL_VOCABULARY_TIERS.map((tier) => tier.label)).toEqual(['NGSL-S', 'NGSL', 'NGSL-GR']);
    expect(SUBTLEX_VOCABULARY_TIERS.map((tier) => tier.rank)).toEqual([
      0, 500, 1_000, 1_500, 2_000, 2_500, 3_000, 4_000, 5_000, 7_000, 8_500, 10_000,
    ]);
    expect(VOCABULARY_TIERS).toEqual(SUBTLEX_VOCABULARY_TIERS);
  });

  it('uses the requested SUBTLEX-US ranks as actual tier boundaries', () => {
    expect(vocabularyTierForSize(700).label).toBe('1,000 词');
    expect(vocabularyTierForSize(2_500).label).toBe('2,500 词');
    expect(vocabularyTierForSize(3_000).label).toBe('3,000 词');
    expect(vocabularyTierForSize(3_501).label).toBe('4,000 词');
    expect(vocabularyTierIndexForRank(3_501)).toBeLessThan(vocabularyTierIndexForRank(5_000));
    expect(vocabularyTierForSize(5_500).label).toBe('7,000 词');
    expect(vocabularyTierForSize(7_500).label).toBe('8,500 词');
  });

  it('maps the selected tier to the shared preview and subtitle rules', () => {
    expect(previewLevelForVocabularySize(700)).toBe('A2');
    expect(previewLevelForVocabularySize(721)).toBe('A2');
    expect(previewLevelForVocabularySize(2_500)).toBe('B1');
    expect(isOutsideVocabulary(2_501, 2_500)).toBe(true);
    expect(isOutsideVocabulary(null, 2_500)).toBe(true);
    expect(isOutsideVocabulary(2_500, 2_500)).toBe(false);
  });

  it('keeps a CAT estimate as an exact subtitle highlight threshold', () => {
    expect(exactVocabularyTierForSize(4_100)).toBeNull();
    expect(vocabularyThresholdLabel(4_100)).toBe('4,100 词');
    expect(isOutsideVocabulary(4_100, 4_100)).toBe(false);
    expect(isOutsideVocabulary(4_101, 4_100)).toBe(true);
  });

  it('calculates token and unique lemma coverage from the same ranked index', () => {
    expect(lookupReaderWord('proposal').rank).toBeGreaterThan(1_000);
    const profile = analyzeVocabularyText('The proposal the.');
    const coverage = vocabularyCoverage(profile, 1_000);
    expect(coverage.totalTokens).toBe(3);
    expect(coverage.outsideTokens).toBe(1);
    expect(coverage.knownTokens).toBe(2);
    expect(coverage.uniqueLemmas).toBe(2);
    expect(coverage.knownUnique).toBe(1);
    expect(coverage.newWordCount).toBe(1);
    expect(newVocabularyLemmas(profile, 1_000)).toEqual(['proposal']);
    expect(coverage.coveragePercent).toBe(67);
    expect(coverage.uniqueCoveragePercent).toBe(50);
  });

  it('counts repeated out-of-range words once as new words', () => {
    const coverage = vocabularyCoverage(analyzeVocabularyText('The proposal proposal.'), 1_000);
    expect(coverage.outsideTokens).toBe(2);
    expect(coverage.newWordCount).toBe(1);
  });

  it('recommends a tier by token coverage instead of independent vocabulary count', () => {
    const profile = analyzeVocabularyText(`${'the '.repeat(16)}${'proposal '.repeat(4)}`);
    const recommendation = recommendedVocabularyForProfile(profile);
    expect(recommendation).not.toBeNull();
    expect(recommendation?.targetCoveragePercent).toBe(90);
    expect(recommendation?.reachable).toBe(true);
    expect(recommendation?.threshold).toBeGreaterThanOrEqual(lookupReaderWord('proposal').rank || 0);
    expect(recommendation?.coveragePercent).toBeGreaterThanOrEqual(90);
  });

  it('does not turn an unknown tail into a higher starting requirement', () => {
    const profile = analyzeVocabularyText(`${'the '.repeat(18)}wont wont.`);
    const recommendation = recommendedVocabularyForProfile(profile);
    expect(recommendation).toMatchObject({ threshold: 500, targetCoveragePercent: 90, reachable: true, coveragePercent: 90 });
  });
});
