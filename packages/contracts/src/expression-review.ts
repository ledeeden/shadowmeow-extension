import type { VocabularyFsrsItem, VocabularyRating } from './vocabulary';

export type ExpressionReviewKind = 'word' | 'phrase' | 'pattern' | 'sentence';
export type ExpressionReviewRating = 'forgot' | 'slow' | 'natural';
export type ExpressionReviewStatus = 'new' | 'learning' | 'mastered';

export type ExpressionVideoSource = {
  type: 'video';
  videoKey: string;
  title: string;
  canonicalUrl?: string;
  thumbnailUrl?: string;
  trackId?: string | null;
  segmentSeq: number;
  startMs: number;
  endMs?: number;
  contextText: string;
};

export type ExpressionReaderSource = {
  type: 'reader';
  title: string;
  location: string;
  contextText: string;
};

export type ExpressionSource = ExpressionVideoSource | ExpressionReaderSource;

export type ExpressionBundleInput = {
  id: string;
  chunk: string;
  pattern: string;
  sourceSentence: string;
  meaningZh: string;
  intentZh: string;
  slots: string[];
  acceptedVariants: string[];
  source: ExpressionSource;
  provenance: {
    kind: 'user-confirmed';
    extractor: 'manual' | 'ai-suggested';
    version: string;
  };
  createdAt: number;
  updatedAt: number;
};

export type ExpressionBundle = ExpressionBundleInput & {
  dedupKey: string;
};

export type ExpressionReviewItem = {
  id: string;
  kind: ExpressionReviewKind;
  bundleId?: string;
  legacyVocabularyId?: string;
  promptZh: string;
  answer: string;
  meaningZh: string;
  intentZh: string;
  sourceSentence: string;
  pattern: string;
  slots: string[];
  acceptedVariants: string[];
  source?: ExpressionSource;
  status: ExpressionReviewStatus;
  due: number | null;
  fsrs: VocabularyFsrsItem;
  createdAt: number;
  updatedAt: number;
};

export type ExpressionReviewLog = {
  id: string;
  itemId: string;
  sessionId: string;
  rating: ExpressionReviewRating;
  fsrsRating: VocabularyRating;
  dueBefore: number | null;
  dueAfter: number | null;
  responseMs?: number;
  timestamp: number;
};

export type ExpressionReviewSessionItem = {
  item: ExpressionReviewItem;
  reviewedAt: number;
  rating: ExpressionReviewRating;
  responseMs?: number;
};

export type ExpressionReviewState = {
  bundles: ExpressionBundle[];
  items: ExpressionReviewItem[];
  dueItems: ExpressionReviewItem[];
  dueCount: number;
  newCount: number;
  estimateMinutes: number;
};

export type ExpressionChallengeCategory =
  | 'target_used_naturally'
  | 'valid_alternative'
  | 'target_form_error'
  | 'no_usable_expression';

export type ExpressionChallengeAnchor = {
  itemId: string;
  bundleId?: string;
  targetIntentZh: string;
  requiredChunk: string;
  optionalPattern: string;
  acceptedVariants: string[];
};

export type ExpressionChallengeScene = {
  id: string;
  targetItemId: string;
  targetAssetIds: string[];
  scenarioZh: string;
  dialogueContext: string;
  promptZh: string;
  difficulty: 'easy' | 'standard' | 'stretch';
  source: 'ai' | 'template';
};

export type ExpressionChallengeFeedback = {
  category: ExpressionChallengeCategory;
  explanationZh: string;
  matchedVariant?: string;
  correction?: string;
  source: 'deterministic' | 'ai' | 'override';
  ambiguous?: boolean;
};

export type ExpressionChallengeAttempt = {
  id: string;
  sessionId: string;
  itemId: string;
  sceneId: string;
  answer: string;
  category: ExpressionChallengeCategory;
  responseMs?: number;
  officialScheduleChanged: false;
  timestamp: number;
};
