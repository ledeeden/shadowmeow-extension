import type { WordbookId } from './wordbook-plan';

/** Increasing academy ranks; independent of a learner's assessment or progress. */
export const WORDBOOK_COVER_RANKS = {
  'cefrj-a1': { material: 'bronze', label: '青铜' },
  'cefrj-a2': { material: 'silver', label: '白银' },
  'cefrj-b1': { material: 'gold', label: '黄金' },
  'cefrj-b2': { material: 'platinum', label: '铂金' },
  'study-abroad': { material: 'stellar', label: '星耀' },
} as const satisfies Record<WordbookId, { material: string; label: string }>;

export const wordbookCoverFilename = (id: WordbookId) => `${id}-${WORDBOOK_COVER_RANKS[id].material}-minimal.webp`;
