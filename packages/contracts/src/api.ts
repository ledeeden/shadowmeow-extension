import { z } from 'zod';
import { bilibiliVideoKeySchema, mediaVideoKeySchema } from './video';

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'VALIDATION_FAILED',
  'UNSUPPORTED_VIDEO',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'CONFLICT',
  'RETRYABLE',
  'NOT_FOUND',
  'FORBIDDEN',
  'ACCOUNT_DELETED',
  'DEVICE_REVOKED',
  'SYNC_DISABLED',
  'SYNC_DAILY_LIMIT',
  'SYNC_STORAGE_LIMIT',
  'SYNC_CLIENT_LIMIT',
  'SYNC_CURSOR_INVALID',
  'SYNC_SEQUENCE_CONFLICT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ACTIONS = [
  'sync.exchange',
  'auth.bootstrap',
  'auth.signOut',
  'settings.get',
  'settings.update',
  'devices.list',
  'devices.revoke',
  'ai.complete',
  'learning.upsertProgress',
  'learning.batchSync',
  'learning.saveAsset',
  'learning.deleteAsset',
  'learning.listAssets',
  'learning.listRecentVideos',
  'learning.recordAttempt',
  'learning.listAttempts',
  'corpus.publicList',
  'corpus.listCollections',
  'corpus.listEpisodes',
  'corpus.listFacets',
  'corpus.listSubtitleTitles',
  'corpus.getSubtitleDetail',
  'corpus.resolveSubtitles',
  'corpus.webPlayback',
  'mediaCorpus.publicList',
  'mediaCorpus.publicSeries',
  'mediaCorpus.resolvePlayback',
  'mediaCorpus.recommend',
  'account.export',
  'account.delete',
  'account.status',
] as const;

export type ApiAction = (typeof ACTIONS)[number];

export const clientSchema = z.object({
  clientType: z.enum(['extension', 'web']).default('extension'),
  extensionVersion: z.string().min(1).max(32),
  adapterVersion: z.string().min(1).max(32),
  deviceId: z.string().min(8).max(128),
});

export const requestEnvelopeSchema = z.object({
  version: z.literal(1),
  action: z.enum(ACTIONS),
  requestId: z.string().min(8).max(128),
  idempotencyKey: z.string().min(8).max(128).optional(),
  client: clientSchema,
  payload: z.unknown(),
});

export type RequestEnvelope<T = unknown> = Omit<
  z.infer<typeof requestEnvelopeSchema>,
  'payload'
> & { payload: T };

export type ApiSuccess<T> = {
  ok: true;
  requestId: string;
  data: T;
  serverTime: string;
};

export type ApiFailure = {
  ok: false;
  requestId: string;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export const PLAYBACK_RATES = [0.4, 0.6, 0.8, 1, 1.2, 1.5, 2] as const;

export const settingsSchema = z.object({
  targetLanguage: z.literal('en').default('en'),
  learnerLevel: z.enum(['A2', 'B1', 'B2']).default('A2'),
  vocabularySize: z.number().int().min(0).max(10_000).default(3_000),
  playbackPreferences: z.object({
    mode: z.enum(['normal', 'manual', 'short', 'normal_pause', 'long']).default('normal'),
    playbackRate: z.number().min(0.4).max(2).default(1),
    showTranscript: z.boolean().default(true),
    subtitleDisplayMode: z.enum(['all', 'new-words', 'hidden']).default('all'),
    captionOffsetMs: z.number().int().min(-5000).max(5000).default(0),
    pageShortcuts: z.object({
      previousSegment: z.string().min(1).max(16).default('a'),
      nextSegment: z.string().min(1).max(16).default('d'),
      replaySegment: z.string().min(1).max(16).default('s'),
      togglePlayback: z.string().min(1).max(16).default('w'),
      toggleLoop: z.string().min(1).max(16).default('l'),
      cycleMode: z.string().min(1).max(16).default('q'),
      toggleTranscript: z.string().min(1).max(16).default('v'),
      saveCurrent: z.string().min(1).max(16).default('r'),
      decreaseSpeed: z.string().min(1).max(16).default('-'),
      increaseSpeed: z.string().min(1).max(16).default('='),
    }).default({}),
  }).default({}),
});

export type UserSettings = z.infer<typeof settingsSchema>;

export const PUBLIC_CORPUS_TOPIC_IDS = [
  'public_transport',
  'travel',
  'hotel',
  'airport',
  'shopping',
  'food',
  'work',
  'education',
  'technology',
  'health',
  'news',
  'daily_life',
  'entertainment',
] as const;

export const publicCorpusTopicSchema = z.enum(PUBLIC_CORPUS_TOPIC_IDS);
export type PublicCorpusTopic = (typeof PUBLIC_CORPUS_TOPIC_IDS)[number];

export const publicCorpusFilterSchema = z.object({
  platform: z.enum(['youtube', 'bilibili']).optional(),
  query: z.string().max(200).default(''),
  topic: publicCorpusTopicSchema.optional(),
  topicQuery: z.string().max(120).optional(),
  topicTerms: z.array(z.string().min(1).max(60)).max(16).optional(),
  searchMode: z.enum(['browse', 'agent']).optional(),
  category: z.string().max(80).optional(),
  register: z.string().max(80).optional(),
  channel: z.string().max(200).optional(),
  maxRecommendedVocabulary: z.number().int().min(1).max(60_000).optional(),
  minLemmaCount: z.number().int().min(0).max(1_000_000).optional(),
  maxLemmaCount: z.number().int().min(0).max(1_000_000).optional(),
  minActiveWpm: z.number().min(0).max(1_000).optional(),
  maxActiveWpm: z.number().min(0).max(1_000).optional(),
  difficultyBand: z.enum(['accessible', 'moderate', 'challenging', 'advanced']).optional(),
  cursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(30),
});

export type PublicCorpusFilterInput = z.infer<typeof publicCorpusFilterSchema>;

export const publicCorpusEpisodesFilterSchema = publicCorpusFilterSchema.extend({
  seriesId: z.string().min(1).max(200).optional(),
});

export type PublicCorpusEpisodesFilterInput = z.infer<typeof publicCorpusEpisodesFilterSchema>;

export const corpusSubtitleTitleFilterSchema = z.object({
  query: z.string().max(200).default(''),
  cursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(1_000).default(200),
});

export type CorpusSubtitleTitleFilterInput = z.infer<typeof corpusSubtitleTitleFilterSchema>;

export type CorpusSubtitleTitle = {
  id: string;
  title: string;
  seriesTitle: string | null;
  /** Open string: self-hosted sources are not limited to youtube / bilibili. */
  platform: string;
  library: 'public' | 'media';
  seriesCode?: string;
  episodeNumber?: number;
  mediaKind?: 'video' | 'audio';
  cueCount: number | null;
  durationMs: number | null;
  contentVersion: string;
  updatedAt: string | null;
};

export type CorpusSubtitleTitleListResponse = {
  items: CorpusSubtitleTitle[];
  total: number;
  nextCursor: number | null;
  catalogVersion: string;
};

export type CorpusSubtitleDetail = {
  id: string;
  title: string;
  seriesTitle: string | null;
  platform: string;
  library: 'public' | 'media';
  seriesCode?: string;
  episodeNumber?: number;
  mediaKind?: 'video' | 'audio';
  cueCount: number;
  contentVersion: string;
  text: string;
};

/**
 * 单个分类标签的长度上限。
 *
 * 标签不只是个 slug:音频分类已经改成数据驱动,tag 直接取系列登记表里的系列标题
 * (发布器未指定 --tag 时就是 ListenLeap 的 list 标题),是真实展示名,几十字符很正常。
 * 上限取 200,和同文件里 channelTitle / channel 一致——那是同一类值(来源展示名)。
 *
 * 之前这里是 40。那是 tags 还只有「短篇/演讲/vlog」这种工作台标签时的遗留值,
 * 音频分类改成读登记表之后没跟着放宽,结果真实标题一超就把整页查询打挂。
 * 改动时记得同步 cloudbase/functions/shadowLanguageApi/lib/schemas.js 的同名约束。
 */
export const MEDIA_CORPUS_TAG_MAX_LENGTH = 200;

export const mediaCorpusFilterSchema = z.object({
  query: z.string().max(200).default(''),
  tags: z.array(z.string().min(1).max(MEDIA_CORPUS_TAG_MAX_LENGTH)).max(20).default([]),
  // Self-hosted sources keep multiplying (youtube / bilibili / englishpod / ...),
  // so this stays an open string instead of a closed enum that breaks on every new one.
  platform: z.string().min(1).max(32).optional(),
  mediaKind: z.enum(['video', 'audio']).optional(),
  seriesCode: z.string().min(1).max(40).optional(),
  difficultyBand: z.enum(['accessible', 'moderate', 'challenging', 'advanced']).optional(),
  language: z.string().min(1).max(32).optional(),
  // 'recent' 按更新时间倒排;'episode' 按集数倒排;'episode-asc' 按集数正排。
  // 音频是课程,默认给 'episode-asc':1、2、3 就是上课顺序,倒排对用户没有意义。
  // 同一批导入的条目 updatedAt 几乎相同,按 recent 排序会退化成随机顺序。
  sort: z.enum(['recent', 'episode', 'episode-asc']).optional(),
  cursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(30),
});

export type MediaCorpusFilterInput = z.infer<typeof mediaCorpusFilterSchema>;

/**
 * 「为你推荐」的查询条件。
 *
 * ladder 模式给出一整条按难度升序的阶梯，客户端自己滑动窗口显示 5 条；
 * nearby 模式从当前条目的难度出发，找同方向上最近的一条（播放页的「换更难/换更简单」）。
 */
export type MediaCorpusRecommendInput = {
  mediaKind?: 'video' | 'audio';
  vocabularySize?: number;
  mode?: 'ladder' | 'nearby';
  currentId?: string;
  direction?: 'easier' | 'harder';
};

/** 阶梯上的一条语料：显示字段 + 难度值 + 它的来源口径。 */
export type MediaCorpusRecommendation = {
  id: string;
  title: string;
  titleZh: string;
  thumbnailUrl: string | null;
  durationMs: number | null;
  seriesTitle: string | null;
  mediaKind: 'video' | 'audio';
  difficulty: number;
  method: string | null;
  /** ListenLeap 频道自带的 CEFR 等级（音频用）。 */
  sourceLevel: string | null;
};

export type MediaCorpusRecommendResponse = {
  /** 当前生效的难度口径版本。 */
  version: string;
  kind: 'video' | 'audio';
  /** 用户词表档位对应的 CEFR 档位。 */
  band: string | null;
  /** 用户当前档位对应的目标难度（0-10）。 */
  target: number | null;
  /** 按难度升序的阶梯。 */
  ladder: MediaCorpusRecommendation[];
  /** 推荐一屏的起始下标（相对 ladder）。 */
  fitStart: number;
  /** 一屏几条。 */
  fitCount: number;
  /** 每个来源等级有多少条、难度中位数是多少。 */
  levelStats: Array<{ level: string; count: number; median: number | null }>;
  /** nearby 模式下的目标条目。 */
  item?: MediaCorpusRecommendation | null;
};

/**
 * 语料难度。0-10，越大越难。
 *
 * 难度值单独存一层（sl_corpus_difficulty），不在语料记录里，所以这套算法可以
 * 整体换掉而不动语料数据。`version` 是当前生效的口径版本，`method` 是这一条
 * 具体怎么算的——视频用本仓库算法，音频直接用 ListenLeap 频道给的评分，
 * 两种方法不是同一把尺，UI 要把 method 显示出来。
 */
export type CorpusDifficulty = {
  value: number;
  version: string;
  method?: string | null;
};

export type MediaCorpusItem = {
  id: string;
  title: string;
  titleEn: string;
  titleZh: string;
  description: string;
  thumbnailUrl: string | null;
  durationMs: number | null;
  channelTitle: string | null;
  viewCount: number | null;
  tags: string[];
  platform?: string;
  /** What the asset actually is. Absent on records written before audio support. */
  mediaKind?: 'video' | 'audio';
  /** Course / channel grouping. EnglishPod uses seriesCode `B`, `C`, ... */
  seriesCode?: string | null;
  seriesTitle?: string | null;
  /** 1-based position inside the series; enables ordered course listings. */
  episodeNumber?: number | null;
  level?: string | null;
  difficultyBand?: 'accessible' | 'moderate' | 'challenging' | 'advanced';
  /** 0-10 难度值。缺失表示这条语料还没有被打过分，不是 0 分。 */
  difficulty?: CorpusDifficulty | null;
  languages?: string[];
  source: { provider: string; sourceId: string | null; canonicalUrl: string | null };
  playbackKind: 'cloudbase';
  media: {
    sizeBytes: number;
    /** Empty for audio-only assets. */
    width: number;
    height: number;
    duration: number;
    /** Empty for audio-only assets. */
    videoCodec: string;
    audioCodec: string;
    mimeType?: string;
  };
  subtitleTracks: Array<{ id: string; language: string; format: string; sizeBytes: number }>;
  updatedAt?: string | null;
};

export type MediaCorpusListResponse = {
  items: MediaCorpusItem[];
  total: number;
  nextCursor: number | null;
  /** 当前生效的难度口径版本。条目上的 difficulty 属于这个版本。 */
  difficultyVersion?: string;
};

/**
 * 一个音频/视频系列的分类元数据,由发布器写入 sl_media_corpus_series。
 *
 * 音频分类以前是前端硬编码常量,每导一个新 ListenLeap list 都要改代码 + 重新部署。
 * 改成读这张登记表之后,新系列导入即出现,不需要动前端。
 */
export type MediaCorpusSeries = {
  seriesCode: string;
  seriesTitle: string;
  /** 分类标签:web 端按它把条目分组,发布器按系列钉死过默认值。 */
  tag: string;
  mediaKind: 'video' | 'audio';
  itemCount: number;
  thumbnailUrl?: string;
};

export type MediaCorpusSeriesResponse = {
  series: MediaCorpusSeries[];
};

export type MediaCorpusPlaybackResponse =
  | { status: 'missing' }
  | {
      status: 'available';
      item: MediaCorpusItem;
      playback: { kind: 'cloudbase'; url: string; contentType: string; sha256: string };
      subtitles: Array<{ id: string; language: string; format: string; sha256: string; url: string }>;
    };

// YouTube's native caption track IDs (vssId) can be short, such as ".en".
// They are source IDs, not CloudBase-generated record IDs.
const youtubeCaptionTrackIdSchema = z.string().min(1).max(128);

export const progressSchema = z.object({
  youtubeId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  videoKey: z.union([bilibiliVideoKeySchema, mediaVideoKeySchema]).optional(),
  thumbnailUrl: z.string().url().max(2000).optional(),
  title: z.string().min(1).max(300).optional(),
  channelTitle: z.string().max(200).optional(),
  durationMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
  trackId: youtubeCaptionTrackIdSchema.nullable().optional(),
  segmentSeq: z.number().int().min(0),
  positionMs: z.number().int().min(0),
  completedRatio: z.number().min(0).max(1),
  activeSecondsDelta: z.number().int().min(0).max(3600).default(0),
  occurredAt: z.string().datetime(),
}).refine(value => Boolean(value.youtubeId) !== Boolean(value.videoKey), 'Exactly one video identity is required');

export type ProgressInput = z.infer<typeof progressSchema>;

export type LearnerLevel = 'A2' | 'B1' | 'B2';

export type VocabularyPreviewItem = {
  word: string;
  lemma: string;
  cefrLevel: 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  meaningZh: string;
  example: string;
  startMs: number;
};

export type VideoVocabularyRecommendation = {
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

export type VideoVocabularyCoverageBand = {
  size: number;
  totalTokens: number;
  knownTokens: number;
  coveragePercent: number;
};

export type VideoVocabularyCoverage = {
  totalTokens: number;
  uniqueLemmas: number;
  unknownTokens: number;
  subtlex: VideoVocabularyCoverageBand[];
  ngslS: VideoVocabularyCoverageBand;
  ngsl: VideoVocabularyCoverageBand;
  ngslGr: VideoVocabularyCoverageBand;
};

export type VideoAnalysis = {
  youtubeId: string;
  analysisVersion: string;
  analyzer: { name: string; version: string; model?: string };
  lexicalMetrics: {
    tokenCount: number;
    surfaceTypeCount: number;
    lemmaCount: number;
    contentLemmaCount: number;
  };
  speedMetrics: {
    activeWpm: number;
    rawWpm: number;
    p50SegmentWpm: number;
    p90SegmentWpm: number;
    pauseRatio: number;
  };
  difficultyBand: 'accessible' | 'moderate' | 'challenging' | 'advanced';
  objectiveScore: number;
  confidence: number;
  aiAssessment: {
    cefrLevel: 'A2' | 'B1' | 'B2' | 'C1';
    difficultyScore: number;
    summaryZh: string;
    /** One-sentence, transcript-grounded explanation of what the learner can practice. */
    learningSummaryZh?: string;
    topicIds?: string[];
    topics: string[];
    register: string;
  };
  /** Objective caption reading requirement; independent of the learner profile. */
  recommendedVocabulary?: VideoVocabularyRecommendation | null;
  /** Objective coverage profiles; independent of the learner profile. */
  vocabularyCoverage?: VideoVocabularyCoverage | null;
  vocabularyPreview: Record<LearnerLevel, VocabularyPreviewItem[]>;
  status: 'ready';
  warnings: string[];
  createdAt: string;
};

export const attemptSchema = z.object({
  id: z.string().min(8).max(128),
  youtubeId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  videoKey: bilibiliVideoKeySchema.optional(),
  thumbnailUrl: z.string().url().max(2000).optional(),
  trackId: youtubeCaptionTrackIdSchema.nullable().optional(),
  segmentSeq: z.number().int().min(0),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  mode: z.enum(['manual', 'short', 'normal_pause', 'long', 'loop']),
  trigger: z.enum(['auto_pause', 'manual_replay', 'loop']),
  occurredAt: z.string().datetime(),
}).refine(value => Boolean(value.youtubeId) !== Boolean(value.videoKey), 'Exactly one video identity is required').refine((attempt) => attempt.endMs > attempt.startMs, 'endMs must be greater than startMs');

export type AttemptInput = z.infer<typeof attemptSchema>;

export const savedItemSchema = z.object({
  id: z.string().min(8).max(128),
  kind: z.enum(['word', 'phrase', 'pattern']),
  normalizedValue: z.string().min(1).max(500),
  displayValue: z.string().min(1).max(500),
  youtubeId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  videoKey: bilibiliVideoKeySchema.optional(),
  thumbnailUrl: z.string().url().max(2000).optional(),
  trackId: youtubeCaptionTrackIdSchema.nullable().optional(),
  segmentSeq: z.number().int().min(0),
  startMs: z.number().int().min(0),
  contextText: z.string().max(2000),
  note: z.string().max(2000).default(''),
  meaningZh: z.string().max(1000).optional(),
  lemma: z.string().max(200).optional(),
  partOfSpeech: z.string().max(80).optional(),
  pronunciation: z.string().max(100).optional(),
  dictionarySource: z.string().max(200).optional(),
  occurredAt: z.string().datetime(),
}).refine(value => Boolean(value.youtubeId) !== Boolean(value.videoKey), 'Exactly one video identity is required');

export type SavedItemInput = z.infer<typeof savedItemSchema>;

export const cueSchema = z.object({
  seq: z.number().int().min(0),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  text: z.string().min(1).max(2000),
  wordStarts: z.array(z.object({ offset: z.number().int().min(0), startMs: z.number().int().min(0) })).optional(),
  // Retain source word alignments without using them for sentence-level playback yet.
  wordTimings: z.array(z.object({
    text: z.string().min(1).max(200),
    startMs: z.number().int().min(0),
    endMs: z.number().int().positive(),
    id: z.union([z.string(), z.number().int()]).optional(),
    type: z.number().int().optional(),
  }).refine(word => word.endMs > word.startMs)).max(500).optional(),
}).refine((cue) => cue.endMs > cue.startMs, 'endMs must be greater than startMs');

export type CaptionCue = z.infer<typeof cueSchema>;
