import { videoKeyOf } from '@shadow-language/contracts';
type CorpusEntryForDedupe = {
  youtubeId?: string;
  videoKey?: string;
  status?: string | null;
  analysis?: { status?: string | null } | null;
  observedAt?: string | null;
  updatedAt?: number | string | null;
};

const STATUS_PRIORITY: Record<string, number> = {
  ready: 4,
  already_available: 4,
  published: 4,
  processing: 3,
  queued: 3,
  committed: 3,
  upload_created: 3,
  pending: 2,
  waiting_network: 2,
  failed: 2,
  retryable_failed: 2,
  rejected: 2,
  watched: 1,
};

function entryTimestamp(entry: CorpusEntryForDedupe): number {
  if (typeof entry.updatedAt === 'number') return entry.updatedAt;
  return Date.parse(entry.updatedAt || entry.observedAt || '') || 0;
}

function entryQuality(entry: CorpusEntryForDedupe): [number, number, number, number] {
  const analysisQuality = entry.analysis?.status === 'ready' ? 2 : entry.analysis ? 1 : 0;
  return [analysisQuality, STATUS_PRIORITY[entry.status || ''] || 0, 0, entryTimestamp(entry)];
}

function compareQuality(left: CorpusEntryForDedupe, right: CorpusEntryForDedupe): number {
  const leftQuality = entryQuality(left);
  const rightQuality = entryQuality(right);
  for (let index = 0; index < leftQuality.length; index += 1) {
    const leftValue = leftQuality[index] || 0;
    const rightValue = rightQuality[index] || 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

/** Keep one representative card per video in a corpus library. */
export function dedupeCorpusEntries<T extends CorpusEntryForDedupe>(entries: T[]): T[] {
  const byYoutubeId = new Map<string, T>();
  for (const entry of entries) {
    const current = byYoutubeId.get(videoKeyOf(entry));
    if (!current || compareQuality(entry, current) > 0) byYoutubeId.set(videoKeyOf(entry), entry);
  }
  return Array.from(byYoutubeId.values());
}

export function vocabularyMatch(recommendation: { threshold: number; reachable: boolean } | null | undefined, vocabularySize: number): 'within' | 'above' | 'unknown' {
  if (!recommendation) return 'unknown';
  return recommendation.reachable && recommendation.threshold <= vocabularySize ? 'within' : 'above';
}
