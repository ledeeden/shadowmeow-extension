import { lookupReaderWord, type ReaderWordInfo } from './reader-frequency';
import { NGSL_GR_WORDS, NGSL_SPOKEN_WORDS, NGSL_WORDS, SUBTLEX_10000_WORDS } from './frequency-data';
import { tokenizeLexicalText } from './lexical-normalizer';

export type VocabularyTierSource = 'baseline' | 'ngslS' | 'ngsl' | 'ngslGr' | 'subtlex';

export type VocabularyTier = {
  rank: number;
  cefr: string;
  label: string;
  desc: string;
  source: VocabularyTierSource;
};

export const NGSL_VOCABULARY_TIERS: VocabularyTier[] = [
  { rank: NGSL_SPOKEN_WORDS.length, cefr: 'A2', label: 'NGSL-S', desc: `${NGSL_SPOKEN_WORDS.length.toLocaleString()} 个口语高频词 · 日常交流起步`, source: 'ngslS' },
  { rank: NGSL_WORDS.length, cefr: 'B1', label: 'NGSL', desc: `${NGSL_WORDS.length.toLocaleString()} 个通用高频词 · 日常阅读核心`, source: 'ngsl' },
  { rank: NGSL_GR_WORDS.length, cefr: 'B2', label: 'NGSL-GR', desc: `${NGSL_GR_WORDS.length.toLocaleString()} 个分级阅读词 · 阅读扩展`, source: 'ngslGr' },
];

export const SUBTLEX_VOCABULARY_TIERS: VocabularyTier[] = [
  { rank: 0, cefr: 'Pre-A1', label: '0 词', desc: 'SUBTLEX-US 起点 · 尚未入门', source: 'baseline' },
  { rank: 500, cefr: 'A1', label: '500 词', desc: 'SUBTLEX-US 前 500 个字幕高频词', source: 'subtlex' },
  { rank: 1_000, cefr: 'A2', label: '1,000 词', desc: 'SUBTLEX-US 前 1,000 个字幕高频词', source: 'subtlex' },
  { rank: 1_500, cefr: 'B1', label: '1,500 词', desc: 'SUBTLEX-US 前 1,500 个字幕高频词', source: 'subtlex' },
  { rank: 2_000, cefr: 'B1', label: '2,000 词', desc: 'SUBTLEX-US 前 2,000 个字幕高频词', source: 'subtlex' },
  { rank: 2_500, cefr: 'B1', label: '2,500 词', desc: 'SUBTLEX-US 前 2,500 个字幕高频词', source: 'subtlex' },
  { rank: 3_000, cefr: 'B1', label: '3,000 词', desc: 'SUBTLEX-US 前 3,000 个字幕高频词', source: 'subtlex' },
  { rank: 4_000, cefr: 'B2', label: '4,000 词', desc: 'SUBTLEX-US 前 4,000 个字幕高频词', source: 'subtlex' },
  { rank: 5_000, cefr: 'B2', label: '5,000 词', desc: 'SUBTLEX-US 前 5,000 个字幕高频词', source: 'subtlex' },
  { rank: 7_000, cefr: 'C1', label: '7,000 词', desc: 'SUBTLEX-US 前 7,000 个字幕高频词', source: 'subtlex' },
  { rank: 8_500, cefr: 'C1', label: '8,500 词', desc: 'SUBTLEX-US 前 8,500 个字幕高频词', source: 'subtlex' },
  { rank: SUBTLEX_10000_WORDS.length, cefr: 'C2', label: '10,000 词', desc: 'SUBTLEX-US 前 10,000 个字幕高频词', source: 'subtlex' },
];

// The shared setting and player threshold are SUBTLEX-US ranks. NGSL is an
// independent Reader tab, while this array remains the canonical shared
// ladder for settings, progress and subtitle highlighting.
export const VOCABULARY_TIERS: VocabularyTier[] = SUBTLEX_VOCABULARY_TIERS;

export const DEFAULT_VOCABULARY_SIZE = 3_000;

export type VocabularyToken = {
  raw: string;
  info: ReaderWordInfo;
};

export type VocabularyTextProfile = {
  tokenRanks: Array<number | null>;
  tokenLemmas?: string[];
  lemmaRanks: Map<string, number | null>;
  totalTokens: number;
  excludedTokens: number;
  unknownTokens: number;
};

export type VocabularyCoverage = {
  threshold: number;
  totalTokens: number;
  uniqueLemmas: number;
  knownTokens: number;
  knownUnique: number;
  newWordCount: number;
  outsideTokens: number;
  unknownTokens: number;
  coveragePercent: number;
  uniqueCoveragePercent: number;
};

export type VocabularyRecommendation = {
  threshold: number;
  targetCoveragePercent: number;
  coveragePercent: number;
  reachable: boolean;
  burden?: {
    outsideUnique: number;
    unlistedTokens: number;
    windowTokens: number;
    lowestWindowCoveragePercent: number;
    recurringWords: string[];
  };
};

// 90% is a practical threshold for starting a subtitle-led video.  95% is a
// useful comfort target, but making it the entry recommendation overstates the
// vocabulary needed to begin (especially when names and one-off topic words
// occur in the captions).
export const RECOMMENDED_TOKEN_COVERAGE_PERCENT = 90;
export const VOCABULARY_COVERAGE_VERSION = 'subtlex-us-ngsl-v3-shared-90';

function tierBounds(index: number): { from: number; to: number } {
  if (index <= 0) return { from: 0, to: 0 };
  const previous = VOCABULARY_TIERS[index - 1]?.rank ?? 0;
  const current = VOCABULARY_TIERS[index]?.rank ?? Number.POSITIVE_INFINITY;
  return { from: previous + 1, to: index === VOCABULARY_TIERS.length - 1 ? Number.POSITIVE_INFINITY : current };
}

export function vocabularyTierIndexForRank(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  for (let index = 1; index < VOCABULARY_TIERS.length; index += 1) {
    const bounds = tierBounds(index);
    if (rank >= bounds.from && rank <= bounds.to) return index;
  }
  return VOCABULARY_TIERS.length - 1;
}

export function vocabularyTierForSize(size: number): VocabularyTier {
  const normalized = clampVocabularySize(size);
  return VOCABULARY_TIERS[vocabularyTierIndexForRank(normalized)] || VOCABULARY_TIERS.at(-1)!;
}

export function exactVocabularyTierForSize(size: number): VocabularyTier | null {
  const normalized = clampVocabularySize(size);
  return VOCABULARY_TIERS.find((tier) => tier.rank === normalized) || null;
}

export function vocabularyThresholdLabel(size: number): string {
  return `${clampVocabularySize(size).toLocaleString('en-US')} 词`;
}

export function clampVocabularySize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOCABULARY_SIZE;
  return Math.min(VOCABULARY_TIERS.at(-1)?.rank || 10_000, Math.max(0, Math.round(value)));
}

export function previewLevelForVocabularySize(size: number): 'A2' | 'B1' | 'B2' {
  const normalized = clampVocabularySize(size);
  if (normalized <= 2_000) return 'A2';
  if (normalized <= 5_000) return 'B1';
  return 'B2';
}

export function isOutsideVocabulary(rank: number | null, vocabularySize: number = DEFAULT_VOCABULARY_SIZE): boolean {
  return rank === null || rank > clampVocabularySize(vocabularySize);
}

export function vocabularyTokenInfo(raw: string, vocabularySize: number = DEFAULT_VOCABULARY_SIZE): VocabularyToken & { outside: boolean } {
  const info = lookupReaderWord(raw);
  return { raw, info, outside: info.countable && isOutsideVocabulary(info.rank, vocabularySize) };
}

function tokenizeVocabularyText(text: string): VocabularyToken[] {
  return tokenizeLexicalText(text).map(({ raw, sentenceStart }) => ({
    raw,
    info: lookupReaderWord(raw, sentenceStart),
  }));
}

export function analyzeVocabularyText(text: string): VocabularyTextProfile {
  const tokenRanks: Array<number | null> = [];
  const lemmaRanks = new Map<string, number | null>();
  const tokenLemmas: string[] = [];
  let excludedTokens = 0;
  let unknownTokens = 0;
  for (const token of tokenizeVocabularyText(text)) {
    if (!token.info.countable) {
      excludedTokens += 1;
      continue;
    }
    tokenRanks.push(token.info.rank);
    tokenLemmas.push(token.info.lemma);
    if (token.info.rank === null) unknownTokens += 1;
    const previous = lemmaRanks.get(token.info.lemma);
    if (previous === undefined || (token.info.rank !== null && (previous === null || token.info.rank < previous))) {
      lemmaRanks.set(token.info.lemma, token.info.rank);
    }
  }
  return { tokenRanks, tokenLemmas, lemmaRanks, totalTokens: tokenRanks.length, excludedTokens, unknownTokens };
}

export function newVocabularyLemmas(profile: VocabularyTextProfile, vocabularySize: number = DEFAULT_VOCABULARY_SIZE): string[] {
  const threshold = clampVocabularySize(vocabularySize);
  return [...profile.lemmaRanks.entries()]
    .filter(([, rank]) => rank === null || rank > threshold)
    .map(([lemma]) => lemma);
}

export function vocabularyCoverage(profile: VocabularyTextProfile, vocabularySize: number = DEFAULT_VOCABULARY_SIZE): VocabularyCoverage {
  const threshold = clampVocabularySize(vocabularySize);
  const knownTokens = profile.tokenRanks.filter((rank) => rank !== null && rank <= threshold).length;
  const knownUnique = [...profile.lemmaRanks.values()].filter((rank) => rank !== null && rank <= threshold).length;
  const newWordCount = newVocabularyLemmas(profile, threshold).length;
  return {
    threshold,
    totalTokens: profile.totalTokens,
    uniqueLemmas: profile.lemmaRanks.size,
    knownTokens,
    knownUnique,
    newWordCount,
    outsideTokens: Math.max(0, profile.totalTokens - knownTokens),
    unknownTokens: profile.unknownTokens,
    coveragePercent: profile.totalTokens ? Math.round((knownTokens / profile.totalTokens) * 100) : 0,
    uniqueCoveragePercent: profile.lemmaRanks.size ? Math.round((knownUnique / profile.lemmaRanks.size) * 100) : 0,
  };
}

/**
 * Return the smallest shared vocabulary tier for starting a subtitle-led
 * video.  This is intentionally token-based: a video's independent lemma
 * count is content volume, not the vocabulary size a learner needs to follow
 * it.  The 90% default is an entry point, not a claim of effortless listening.
 */
export function recommendedVocabularyForProfile(
  profile: VocabularyTextProfile,
  targetCoveragePercent = RECOMMENDED_TOKEN_COVERAGE_PERCENT,
): VocabularyRecommendation | null {
  if (profile.totalTokens <= 0) return null;
  const target = Math.min(100, Math.max(1, Math.round(targetCoveragePercent)));
  const requiredKnownTokens = Math.ceil((profile.totalTokens * target) / 100);
  const tier = VOCABULARY_TIERS.slice(1).find((candidate) => (
    profile.tokenRanks.filter((rank) => rank !== null && rank <= candidate.rank).length >= requiredKnownTokens
  ));
  const threshold = tier?.rank ?? VOCABULARY_TIERS.at(-1)?.rank ?? 10_000;
  const coverage = vocabularyCoverage(profile, threshold);
  const windows: number[] = [];
  const windowTokens = Math.min(100, profile.totalTokens);
  // Fixed word windows work with both plain transcripts and timed captions.
  for (let start = 0; start <= profile.totalTokens - windowTokens; start += 1) {
    const window = profile.tokenRanks.slice(start, start + windowTokens);
    windows.push(100 * window.filter(rank => rank !== null && rank <= threshold).length / window.length);
  }
  const repeated = new Map<string, number>();
  profile.tokenLemmas?.forEach((lemma, index) => {
    const rank = profile.tokenRanks[index];
    if (rank === null || (rank !== undefined && rank > threshold)) repeated.set(lemma, (repeated.get(lemma) || 0) + 1);
  });
  return {
    threshold,
    burden: {
      outsideUnique: coverage.newWordCount,
      unlistedTokens: profile.unknownTokens,
      windowTokens,
      lowestWindowCoveragePercent: Math.round(windows.reduce((lowest, value) => Math.min(lowest, value), 100)),
      recurringWords: [...repeated].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word]) => word),
    },
    targetCoveragePercent: target,
    coveragePercent: coverage.coveragePercent,
    reachable: coverage.knownTokens >= requiredKnownTokens,
  };
}
