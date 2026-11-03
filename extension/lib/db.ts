import { SYNC_STORES, installChangeJournal } from './sync/local-store';
import type { SyncTable } from '@shadow-language/contracts';
import Dexie, { type EntityTable } from 'dexie';
import { settingsSchema, type AttemptInput, type CaptionCue, type DictionaryAudioResult, type DictionaryResult, type ExpressionBundle, type ExpressionChallengeAttempt, type ExpressionReviewItem, type ExpressionReviewLog, type ProgressInput, type SavedItemInput, type UserSettings, type VideoAnalysis, type VocabularyCard, type VocabularyGoal, type VocabularyReviewLog, randomId } from '@shadow-language/contracts';
import { clampVocabularySize, DEFAULT_VOCABULARY_SIZE, previewLevelForVocabularySize } from './vocabulary-profile';

export type LocalSettings = UserSettings & { id: 'settings'; updatedAt: string };
export type LocalAsset = SavedItemInput & { syncStatus: 'pending' | 'synced' | 'failed'; deletedAt?: string };
export type LocalProgress = ProgressInput & { id: string; syncStatus: 'pending' | 'synced' | 'failed'; activeSecondsTotal?: number; analysis?: VideoAnalysis | null };
export type LocalVideoAnalysis = { id: string; analysis: VideoAnalysis; updatedAt: number };
export type LocalAttempt = AttemptInput & { syncStatus: 'pending' | 'synced' | 'failed' };
export type LocalVocabularyCard = VocabularyCard;
export type LocalVocabularyGoal = VocabularyGoal & { id: 'goal'; updatedAt: number };
export type LocalVocabularyReview = VocabularyReviewLog;
export type OutboxRecord = {
  id: string;
  type: 'progress' | 'attempt' | 'saveAsset' | 'deleteAsset';
  payload: unknown;
  status: 'pending' | 'syncing' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};
export type CaptionCache = {
  id: string;
  youtubeId: string;
  trackId: string;
  adapterVersion: string;
  cues: CaptionCue[];
  cachedAt: number;
  page?: import('@shadow-language/contracts').PageState;
};
export type DictionaryCache = {
  id: string;
  result: DictionaryResult;
  cachedAt: number;
  expiresAt: number;
};
export type DictionaryAudioCache = {
  id: string;
  result: DictionaryAudioResult;
  cachedAt: number;
  expiresAt: number;
};

export type LocalOnboardingRecord = { id: 'primary'; value: unknown; updatedAt: number };

export class ShadowLanguageDb extends Dexie {
  onboarding!: EntityTable<LocalOnboardingRecord, 'id'>;
  settings!: EntityTable<LocalSettings, 'id'>;
  assets!: EntityTable<LocalAsset, 'id'>;
  progress!: EntityTable<LocalProgress, 'id'>;
  videoAnalyses!: EntityTable<LocalVideoAnalysis, 'id'>;
  attempts!: EntityTable<LocalAttempt, 'id'>;
  outbox!: EntityTable<OutboxRecord, 'id'>;
  captions!: EntityTable<CaptionCache, 'id'>;
  dictionary!: EntityTable<DictionaryCache, 'id'>;
  dictionaryAudio!: EntityTable<DictionaryAudioCache, 'id'>;
  vocabulary!: EntityTable<LocalVocabularyCard, 'id'>;
  vocabularyReviews!: EntityTable<LocalVocabularyReview, 'id'>;
  studyMeta!: EntityTable<LocalVocabularyGoal, 'id'>;
  expressionBundles!: EntityTable<ExpressionBundle, 'id'>;
  expressionReviewItems!: EntityTable<ExpressionReviewItem, 'id'>;
  expressionReviewLogs!: EntityTable<ExpressionReviewLog, 'id'>;
  expressionChallengeAttempts!: EntityTable<ExpressionChallengeAttempt, 'id'>;

  constructor(name = 'shadow-language') {
    super(name);
    this.version(1).stores({
      settings: 'id,updatedAt',
      assets: 'id,youtubeId,kind,syncStatus,occurredAt',
      progress: 'id,youtubeId,syncStatus,occurredAt',
      outbox: 'id,type,status,nextAttemptAt,createdAt',
      captions: 'id,youtubeId,trackId,cachedAt',
      dictionary: 'id,expiresAt,cachedAt',
      dictionaryAudio: 'id,expiresAt,cachedAt',
    });
    this.version(2).stores({
      settings: 'id,updatedAt',
      assets: 'id,youtubeId,kind,syncStatus,occurredAt',
      progress: 'id,youtubeId,syncStatus,occurredAt',
      attempts: 'id,youtubeId,segmentSeq,syncStatus,occurredAt',
      outbox: 'id,type,status,nextAttemptAt,createdAt',
      captions: 'id,youtubeId,trackId,cachedAt',
      dictionary: 'id,expiresAt,cachedAt',
      dictionaryAudio: 'id,expiresAt,cachedAt',
    });
    this.version(3).stores({
      settings: 'id,updatedAt',
      assets: 'id,youtubeId,kind,syncStatus,occurredAt',
      progress: 'id,youtubeId,syncStatus,occurredAt',
      attempts: 'id,youtubeId,segmentSeq,syncStatus,occurredAt',
      outbox: 'id,type,status,nextAttemptAt,createdAt',
      captions: 'id,youtubeId,trackId,cachedAt',
      dictionary: 'id,expiresAt,cachedAt',
      dictionaryAudio: 'id,expiresAt,cachedAt',
    });
    this.version(4).stores({
      settings: 'id,updatedAt',
      assets: 'id,youtubeId,kind,syncStatus,occurredAt',
      progress: 'id,youtubeId,syncStatus,occurredAt',
      attempts: 'id,youtubeId,segmentSeq,syncStatus,occurredAt',
      outbox: 'id,type,status,nextAttemptAt,createdAt',
      captions: 'id,youtubeId,trackId,cachedAt',
      dictionary: 'id,expiresAt,cachedAt',
      dictionaryAudio: 'id,expiresAt,cachedAt',
    });
    this.version(5).stores({
      settings: 'id,updatedAt',
      assets: 'id,youtubeId,kind,syncStatus,occurredAt',
      progress: 'id,youtubeId,syncStatus,occurredAt',
      attempts: 'id,youtubeId,segmentSeq,syncStatus,occurredAt',
      outbox: 'id,type,status,nextAttemptAt,createdAt',
      captions: 'id,youtubeId,trackId,cachedAt',
      dictionary: 'id,expiresAt,cachedAt',
      dictionaryAudio: 'id,expiresAt,cachedAt',
      vocabulary: 'id,lemma,status,due,updatedAt,rank',
      vocabularyReviews: 'id,word,timestamp,isNew',
      studyMeta: 'id,updatedAt',
    });
    this.version(6).stores({ assets: 'id,youtubeId,videoKey,kind,syncStatus,occurredAt', progress: 'id,youtubeId,videoKey,syncStatus,occurredAt', attempts: 'id,youtubeId,videoKey,segmentSeq,syncStatus,occurredAt' });
    // Retire the old watch-page contribution receipt store. Existing queued
    // contribution outbox records are obsolete once channel batch import is
    // the only corpus ingestion path.
    this.version(7).stores({ contributions: null }).upgrade(async (transaction) => {
      await transaction.table('outbox').where('type').equals('contribution').delete();
    });
    this.version(8).stores({ videoAnalyses: 'id,updatedAt' }).upgrade(async (transaction) => {
      const progressTable = transaction.table('progress');
      const analysisTable = transaction.table('videoAnalyses');
      await progressTable.toCollection().each(async (item: LocalProgress) => {
        if (item.analysis?.status !== 'ready') return;
        await analysisTable.put({
          id: item.id,
          analysis: item.analysis,
          updatedAt: Date.parse(item.occurredAt) || Date.now(),
        });
      });
    });
    this.version(9).stores({
      expressionBundles: 'id,dedupKey,updatedAt',
      expressionReviewItems: 'id,bundleId,legacyVocabularyId,kind,status,due,updatedAt',
      expressionReviewLogs: 'id,itemId,sessionId,timestamp',
      expressionChallengeAttempts: 'id,sessionId,itemId,timestamp,category',
    });
    this.version(10).stores({ ...SYNC_STORES, onboarding: 'id,updatedAt' });
    this.version(11).stores({ userPreferences: 'id', readerWords: 'id', userTranscripts: 'id', transcriptChunks: 'id,generation,videoKey' });
  }
}

export let db = new ShadowLanguageDb();
export function selectWebLearningDatabase(name: string, changed: () => void, writable: () => boolean) {
  db.close();
  db = new ShadowLanguageDb(name);
  installChangeJournal(db, Object.fromEntries(['settings', 'assets', 'progress', 'attempts', 'vocabulary', 'vocabularyReviews', 'studyMeta', 'userPreferences', 'readerWords', 'userTranscripts', 'transcriptChunks', 'expressionBundles', 'expressionReviewItems', 'expressionReviewLogs', 'expressionChallengeAttempts'].map(table => [table, table as SyncTable])), changed, writable);
  return db;
}

export const DEFAULT_SETTINGS: UserSettings = {
  targetLanguage: 'en',
  learnerLevel: 'A2',
  vocabularySize: DEFAULT_VOCABULARY_SIZE,
  playbackPreferences: {
    mode: 'normal',
    playbackRate: 1,
    showTranscript: true,
    subtitleDisplayMode: 'all',
    captionOffsetMs: 0,
    pageShortcuts: {
      previousSegment: 'a',
      nextSegment: 'd',
      replaySegment: 's',
      togglePlayback: 'w',
      toggleLoop: 'l',
      cycleMode: 'q',
      toggleTranscript: 'v',
      saveCurrent: 'r',
      decreaseSpeed: '-',
      increaseSpeed: '=',
    },
  },
};

export function normalizeSettings(settings: unknown): UserSettings {
  const parsed = settingsSchema.parse(settings);
  const vocabularySize = clampVocabularySize(parsed.vocabularySize);
  return { ...parsed, vocabularySize, learnerLevel: previewLevelForVocabularySize(vocabularySize) };
}

export async function getLocalSettings(): Promise<UserSettings> {
  const record = await db.settings.get('settings');
  const normalized = normalizeSettings(record || DEFAULT_SETTINGS);
  if (record && (record.vocabularySize !== normalized.vocabularySize || record.learnerLevel !== normalized.learnerLevel)) {
    await db.settings.put({ ...normalized, id: 'settings', updatedAt: new Date().toISOString() });
  }
  return normalized;
}

export async function saveLocalSettings(settings: UserSettings): Promise<void> {
  await db.settings.put({ ...normalizeSettings(settings), id: 'settings', updatedAt: new Date().toISOString() });
}

export async function clearPrivateLocalData(): Promise<void> {
  await db.transaction('rw', [db.assets, db.progress, db.videoAnalyses, db.attempts, db.outbox, db.dictionary, db.dictionaryAudio, db.vocabulary, db.vocabularyReviews, db.studyMeta, db.expressionBundles, db.expressionReviewItems, db.expressionReviewLogs, db.expressionChallengeAttempts, db.onboarding], async () => {
    await Promise.all([db.assets.clear(), db.progress.clear(), db.videoAnalyses.clear(), db.attempts.clear(), db.outbox.clear(), db.dictionary.clear(), db.dictionaryAudio.clear(), db.vocabulary.clear(), db.vocabularyReviews.clear(), db.studyMeta.clear(), db.expressionBundles.clear(), db.expressionReviewItems.clear(), db.expressionReviewLogs.clear(), db.expressionChallengeAttempts.clear(), db.onboarding.clear()]);
  });
  await saveLocalSettings(DEFAULT_SETTINGS);
}

export function newOutboxId(type: string): string {
  return `${type}_${randomId()}`;
}

export async function enqueueOutbox(type: OutboxRecord['type'], payload: unknown, id = newOutboxId(type)): Promise<string> {
  const timestamp = Date.now();
  await db.outbox.put({ id, type, payload, status: 'pending', attempts: 0, nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
  return id;
}
