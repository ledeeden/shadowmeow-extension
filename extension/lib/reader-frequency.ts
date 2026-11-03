import { SUBTLEX_10000_WORDS } from './frequency-data';
import { resolveLexicalSurface, type LexicalComponent, type LexicalKind } from './lexical-normalizer';

// SUBTLEX-US top 10,000, ranked by subtitle frequency.
export { SUBTLEX_10000_WORDS };

const rankByWord = new Map<string, number>(SUBTLEX_10000_WORDS.map((word, index) => [word, index + 1]));

export type ReaderWordInfo = {
  surface: string;
  normalized: string;
  lemma: string;
  rank: number | null;
  surfaceRank: number | null;
  candidateLemmas: string[];
  components: LexicalComponent[];
  countable: boolean;
  kind: LexicalKind;
  resolution: string;
  confidence: number;
};

export function lookupReaderWord(raw: string, sentenceStart = false): ReaderWordInfo {
  const resolution = resolveLexicalSurface(raw);
  const surfaceRank = rankByWord.get(resolution.normalized) ?? null;
  if (!resolution.countable) return { ...resolution, rank: null, surfaceRank };


  let bestLemma = resolution.lemma;
  let bestRank: number | null = rankByWord.get(bestLemma) ?? null;
  const isExplicitResolution = resolution.resolution !== 'surface';
  if (!isExplicitResolution) {
    bestRank = surfaceRank;
    bestLemma = resolution.normalized;
  }

  for (const candidate of resolution.candidateLemmas) {
    const candidateRank = rankByWord.get(candidate) ?? null;
    if (candidateRank === null) continue;
    if (isExplicitResolution) {
      if (resolution.kind === 'possessive' && candidate.length < bestLemma.length) {
        bestLemma = candidate;
        bestRank = candidateRank;
      } else if (resolution.kind === 'variant' && bestRank !== null && candidateRank < bestRank) {
        bestLemma = candidate;
        bestRank = candidateRank;
      }
      if (bestRank === null) {
        bestLemma = candidate;
        bestRank = candidateRank;
      }
      continue;
    }
    if (bestRank === null || candidateRank < bestRank) {
      bestLemma = candidate;
      bestRank = candidateRank;
    }
  }

  const resolvedKind: LexicalKind = bestRank === null && resolution.kind === 'word'
    ? 'unknown'
    : bestLemma !== resolution.normalized && resolution.kind === 'word'
      ? 'variant'
      : resolution.kind;
  const firstComponent = resolution.components[0];
  return {
    ...resolution,
    lemma: bestLemma,
    rank: bestRank,
    surfaceRank,
    components: bestLemma !== resolution.lemma && firstComponent
      ? [{ ...firstComponent, lemma: bestLemma }, ...resolution.components.slice(1)]
      : resolution.components,
    countable: true,
    kind: resolvedKind,
  };
}

export function cefrForRank(rank: number | null): string {
  if (rank === null) return 'C2+';
  if (rank <= 300) return 'A1';
  if (rank <= 700) return 'A2';
  if (rank <= 2_000) return 'B1';
  if (rank <= 5_000) return 'B2';
  if (rank <= 8_000) return 'C1';
  return 'C2';
}
