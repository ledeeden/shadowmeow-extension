import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { analyzeVocabularyText, recommendedVocabularyForProfile, vocabularyCoverage } from './vocabulary-profile';
import { analyzeFrequencyCoverage } from './frequency-coverage';
import { tokenizeLexicalText } from './lexical-normalizer';
const require = createRequire(import.meta.url);
const worker = require('../../cloudbase/functions/shadowLanguageWorker/jobs/analyze-caption.js');

describe('shared vocabulary engine', () => {
  it('keeps worker, reader and coverage bands consistent across cue boundaries', () => {
    const segments = [{ text: 'We subscribed and booked a reservation.' }, { text: 'Teabags and wi-fi. Frittata is here.' }];
    const text = segments.map(s => s.text).join(' ');
    const profile = analyzeVocabularyText(text);
    const coverage = analyzeFrequencyCoverage(text);
    expect(worker.recommendedVocabularyForSegments(segments)).toEqual(recommendedVocabularyForProfile(profile));
    expect(worker.vocabularyCoverageForSegments(segments)).toEqual(coverage);
    for (const band of coverage.subtlex) {
      expect(band.knownTokens).toBe(vocabularyCoverage(profile, band.size).knownTokens);
      expect(band.totalTokens).toBe(profile.totalTokens);
    }
  });
  it('does not hide an unfamiliar word merely because it starts a sentence', () => {
    expect(analyzeVocabularyText('Frittata').unknownTokens).toBe(1);
    expect(analyzeVocabularyText('frittata').unknownTokens).toBe(1);
    expect(tokenizeLexicalText('wi-fi')).toHaveLength(1);
    expect(analyzeVocabularyText('subscribe subscribed').lemmaRanks.size).toBe(1);
  });
  it('exposes local concentration even when overall coverage passes', () => {
    const profile = analyzeVocabularyText(`${'the '.repeat(900)}${'frittata '.repeat(100)}`);
    const result = recommendedVocabularyForProfile(profile);
    expect(result?.threshold).toBe(500);
    expect(result?.burden).toMatchObject({ outsideUnique: 1, windowTokens: 100, lowestWindowCoveragePercent: 0, recurringWords: ['frittata'] });
  });
  it('uses exact counts at the 90 percent boundary', () => {
    const profile = analyzeVocabularyText(`${'the '.repeat(179)}${'frittata '.repeat(21)}`);
    expect(recommendedVocabularyForProfile(profile)?.reachable).toBe(false);
  });
});
