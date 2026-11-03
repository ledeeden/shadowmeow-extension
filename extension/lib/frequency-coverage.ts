import { NGSL_GR_WORDS, NGSL_SPOKEN_WORDS, NGSL_WORDS, SUBTLEX_10000_WORDS } from './frequency-data';
import { lookupReaderWord } from './reader-frequency';
import { resolveLexicalSurface, tokenizeLexicalText } from './lexical-normalizer';

export const SUBTLEX_COVERAGE_TIERS = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000] as const;

export type CoverageBand = {
  size: number;
  totalTokens: number;
  knownTokens: number;
  coveragePercent: number;
};

export type VocabularyFrequencyCoverage = {
  totalTokens: number;
  uniqueLemmas: number;
  unknownTokens: number;
  subtlex: CoverageBand[];
  ngslS: CoverageBand;
  ngsl: CoverageBand;
  ngslGr: CoverageBand;
};

export type FrequencyRanks = {
  subtlex: number | null;
  ngslS: number | null;
  ngsl: number | null;
  ngslGr: number | null;
};

const ngslRanks = new Map<string, number>(NGSL_WORDS.map((word, index) => [word, index + 1]));
const ngslSpokenRanks = new Map<string, number>(NGSL_SPOKEN_WORDS.map((word, index) => [word, index + 1]));
const ngslGrRanks = new Map<string, number>(NGSL_GR_WORDS.map((word, index) => [word, index + 1]));

function rankForMap(raw: string, rankMap: Map<string, number>): number | null {
  const resolution = resolveLexicalSurface(raw);
  if (!resolution.countable) return null;
  const candidates = [resolution.normalized, resolution.lemma, ...resolution.candidateLemmas];
  const ranks = candidates.map((candidate) => rankMap.get(candidate)).filter((rank): rank is number => Number.isFinite(rank));
  return ranks.length ? Math.min(...ranks) : null;
}

/**
 * Return each independent list's rank for a token. SUBTLEX-US remains the
 * primary reader tier; the three NGSL lists are deliberately not collapsed
 * into a made-up combined score.
 */
export function lookupFrequencyRanks(raw: string, sentenceStart = false): FrequencyRanks {
  const resolution = resolveLexicalSurface(raw);
  if (!resolution.countable) return { subtlex: null, ngslS: null, ngsl: null, ngslGr: null };
  return {
    subtlex: lookupReaderWord(raw, sentenceStart).rank,
    ngslS: rankForMap(raw, ngslSpokenRanks),
    ngsl: rankForMap(raw, ngslRanks),
    ngslGr: rankForMap(raw, ngslGrRanks),
  };
}

function band(ranks: Array<number | null>, size: number): CoverageBand {
  const knownTokens = ranks.filter((rank) => rank !== null && rank <= size).length;
  return { size, totalTokens: ranks.length, knownTokens, coveragePercent: ranks.length ? Math.round((knownTokens / ranks.length) * 100) : 0 };
}

export function analyzeFrequencyCoverage(text: string): VocabularyFrequencyCoverage {
  const subtlex: Array<number | null> = [];
  const ngslS: Array<number | null> = [];
  const ngsl: Array<number | null> = [];
  const ngslGr: Array<number | null> = [];
  const lemmas = new Set<string>();
  const rankCache = new Map<string, FrequencyRanks>();
  let unknownTokens = 0;
  for (const token of tokenizeLexicalText(text)) {
    const resolution = resolveLexicalSurface(token.raw);
    if (!resolution.countable) continue;
    const key = `${Number(token.sentenceStart)}:${token.raw}`;
    let ranks = rankCache.get(key);
    if (!ranks) { ranks = lookupFrequencyRanks(token.raw, token.sentenceStart); rankCache.set(key, ranks); }
    subtlex.push(ranks.subtlex);
    ngslS.push(ranks.ngslS);
    ngsl.push(ranks.ngsl);
    ngslGr.push(ranks.ngslGr);
    lemmas.add(resolution.lemma);
    if (ranks.subtlex === null) unknownTokens += 1;
  }
  return {
    totalTokens: subtlex.length,
    uniqueLemmas: lemmas.size,
    unknownTokens,
    subtlex: SUBTLEX_COVERAGE_TIERS.map((size) => band(subtlex, size)),
    ngslS: band(ngslS, NGSL_SPOKEN_WORDS.length),
    ngsl: band(ngsl, NGSL_WORDS.length),
    ngslGr: band(ngslGr, NGSL_GR_WORDS.length),
  };
}

export function frequencyRankSet(words: readonly string[], size: number): Set<string> {
  return new Set(words.slice(0, Math.max(0, Math.min(words.length, Math.round(size)))));
}

export function personalVocabularyCoverage(text: string, baselineSize: number, extraWords: Iterable<string>): CoverageBand {
  return createPersonalVocabularyCoverage(baselineSize, extraWords)(text);
}

/** Build the learner's vocabulary once for a batch of transcripts. */
export function createPersonalVocabularyCoverage(baselineSize: number, extraWords: Iterable<string>): (text: string) => CoverageBand {
  const known = frequencyRankSet(SUBTLEX_10000_WORDS, baselineSize);
  for (const word of extraWords) {
    const resolution = resolveLexicalSurface(word);
    if (!resolution.countable) continue;
    known.add(resolution.normalized);
    known.add(resolution.lemma);
    resolution.candidateLemmas.forEach((lemma) => known.add(lemma));
  }
  return (text) => {
    let totalTokens = 0;
    let knownTokens = 0;
    for (const token of tokenizeLexicalText(text)) {
      const resolution = resolveLexicalSurface(token.raw);
      if (!resolution.countable) continue;
      totalTokens += 1;
      if ([resolution.normalized, resolution.lemma, ...resolution.candidateLemmas].some((candidate) => known.has(candidate))) knownTokens += 1;
    }
    return { size: baselineSize, totalTokens, knownTokens, coveragePercent: totalTokens ? Math.round((knownTokens / totalTokens) * 100) : 0 };
  };
}
