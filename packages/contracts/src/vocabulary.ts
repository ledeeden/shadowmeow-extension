export type VocabularyStatus = 'unseen' | 'known' | 'unfamiliar' | 'learning' | 'ignored';

export type VocabularyRating = 1 | 2 | 3 | 4;

export type VocabularyFsrsItem = {
  state: 0 | 1 | 2 | 3;
  difficulty: number;
  stability: number;
  reps: number;
  lapses: number;
  lastReview: number | null;
  due: number;
  intervalDays?: number;
};

export type VocabularyWordInput = {
  word: string;
  lemma?: string;
  rank?: number | null;
  phonetic?: string;
  translation?: string;
  source?: string;
  contextText?: string;
};

export type VocabularyCard = {
  id: string;
  word: string;
  lemma: string;
  rank: number | null;
  phonetic: string;
  translation: string;
  status: VocabularyStatus;
  source: string;
  createdAt: number;
  updatedAt: number;
  due: number | null;
  fsrs: VocabularyFsrsItem;
  contextText?: string;
  /** Content reference only; identity and review history still use the lemma. */
  atlasWord?: string;
  /** Explicit screening exemption; automatic mastery never sets this flag. */
  reviewExempt?: boolean;
  /** Reversible estimate-based exemption; separate from explicit recognition. */
  assessmentExemptBatch?: string | null;
};

export type VocabularyGoal = {
  targetVocab: number;
  targetDays: number;
  startDate: number;
  /** Web wordbook selection; stored with the existing account-scoped study plan. */
  wordbook?: { id: string; dailyNew: number };
  wordbookScreening?: Record<string, { page: number; version: string; updatedAt: number }>;
  wordbookAssessmentBatches?: Record<string, { id: string; version: string; assessmentKey: string; cutoff: number; count: number; createdAt: number; undoneAt?: number }>;
};

export type VocabularyReviewLog = {
  id: string;
  word: string;
  rating: VocabularyRating;
  stability: number;
  difficulty: number;
  intervalDays: number;
  isNew: boolean;
  timestamp: number;
};

export type VocabularyPlan = {
  goal: VocabularyGoal | null;
  hasGoal: boolean;
  targetVocab: number;
  targetDays: number;
  startDate: number;
  elapsedDays: number;
  daysRemaining: number;
  goalGap: number;
  knownCount: number;
  unfamiliarCount: number;
  learningCount: number;
  dueCount: number;
  dueCards: VocabularyCard[];
  newWords: VocabularyCard[];
  newPoolCount: number;
  dailyNewTarget: number;
  newStartedToday: number;
  dailyNewRemaining: number;
  todayNewCount: number;
  totalTodayCount: number;
};

export type VocabularyState = {
  cards: VocabularyCard[];
  masteredLemmas: string[];
  plan: VocabularyPlan;
};
