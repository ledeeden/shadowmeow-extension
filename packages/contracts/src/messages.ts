import type { AttemptInput, CaptionCue, MediaCorpusFilterInput, PublicCorpusEpisodesFilterInput, PublicCorpusFilterInput, SavedItemInput, UserSettings } from './api';
import type { DictionaryDetail } from './dictionary';
import type { NormalizedSegment } from './captions';
import type { VocabularyGoal, VocabularyRating, VocabularyWordInput } from './vocabulary';
import type { ExpressionBundleInput, ExpressionChallengeAttempt, ExpressionReviewRating } from './expression-review';

export type CaptionTrack = {
  id: string;
  language: string;
  label: string;
  kind: 'manual' | 'asr' | 'translation';
  baseUrl: string;
};

export type PageState = {
  youtubeId: string | null;
  videoKey?: string;
  platform?: 'youtube' | 'bilibili' | 'media';
  /** Audio assets open straight into reading mode; video keeps the picture. */
  mediaKind?: 'video' | 'audio';
  translationCues?: CaptionCue[];
  subtitleSource?: string;
  thumbnailUrl?: string;
  mediaBounds?: { left: number; top: number; width: number; height: number };

  canonicalUrl?: string;
  title: string;
  channelTitle?: string;
  channelId?: string;
  durationMs: number;
  isLive?: boolean;
  playabilityStatus?: string;
  playerState: 'playing' | 'paused' | 'ended';
  timeMs: number;
  playbackRate: number;
  tracks: CaptionTrack[];
  activeTrackId: string | null;
  cues: CaptionCue[];
  segments: NormalizedSegment[];
  selectedText?: string;
  error?: string;
};

export type PlayerCommand =
  | { type: 'SEEK'; timeMs: number }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'SET_RATE'; rate: number };

export type RuntimeMessage =
  | { type: 'EXTENSION_UPDATE_CHECK'; force?: boolean }
  | { type: 'AGENT_PREPARE'; panel: 'agent' | 'words' }
  | { type: 'AGENT_OPEN' }
  | { type: 'AGENT_VIEW'; view: 'chat' | 'words'; tabId: number }
  | { type: 'AGENT_CONTEXT' }
  | { type: 'AGENT_CONTEXT_CHANGED'; tabId: number }
  | { type: 'AGENT_REFERENCE_SAVED'; id: string }
  | { type: 'AGENT_REPLAY'; videoKey: string; timeMs: number }
  | { type: 'AGENT_HIGHLIGHT'; reference: { id: string; videoKey: string; title: string; url: string; startMs: number; endMs: number; text: string; highlight: string; trackId: string | null; createdAt: number } }
  | { type: 'CAPTION_NLP'; texts: string[] }
  | { type: 'PAGE_GET_STATE' }
  | { type: 'PAGE_CONTEXT_CHANGED'; page?: PageState }
  | { type: 'CAPTION_CACHE_GET'; videoKey: string; trackId?: string }
  | { type: 'PAGE_PLAYER_COMMAND'; command: PlayerCommand }
  | { type: 'PAGE_SELECT_TRACK'; trackId: string }
  | { type: 'PAGE_RETRY_CAPTIONS' }
  | { type: 'OPEN_NEW_WORD_PANEL' }
  | { type: 'DASHBOARD_OPEN'; section?: 'agent' | 'reader' | 'study' | 'assets' | 'corpus' | 'public-corpus' | 'progress' | 'settings' }
  | { type: 'VIDEO_OPEN'; youtubeId?: string; videoKey?: string; startMs: number }
  | { type: 'VIDEO_INSIGHTS_REFRESH' }
  | { type: 'PLAYER_SHORTCUT'; action: 'toggle-loop' | 'cycle-mode' | 'toggle-transcript' }
  | { type: 'AUTH_STATUS' }
  | { type: 'AUTH_EMAIL_CONTINUE'; email: string; password: string }
  | { type: 'AUTH_SIGN_IN'; email: string; password: string }
  | { type: 'AUTH_SIGN_IN_GOOGLE' }
  | { type: 'AUTH_SIGN_UP_START'; email: string; password: string }
  | { type: 'AUTH_PASSWORD_RESET_START'; email: string; password: string }
  | { type: 'AUTH_SIGN_UP_RESEND'; email: string }
  | { type: 'AUTH_SIGN_UP_VERIFY'; email: string; code: string }
  | { type: 'AUTH_SIGN_OUT' }
  | { type: 'AUTH_INVALIDATED' }
  | { type: 'AUTH_CHANGED'; signedIn: boolean; settings?: UserSettings }
  | { type: 'SETTINGS_GET' }
  | { type: 'SETTINGS_UPDATE'; settings: Partial<UserSettings> }
  | { type: 'DEVICES_LIST' }
  | { type: 'DEVICE_REVOKE'; deviceRecordId: string }
  | { type: 'DICTIONARY_LOOKUP'; text: string; contextText?: string; detail?: DictionaryDetail }
  | { type: 'DICTIONARY_PREFETCH'; texts: string[]; phrases?: string[] }
  | { type: 'DICTIONARY_TTS'; text: string }
  | { type: 'ASSET_SAVE'; item: SavedItemInput }
  | { type: 'ASSET_DELETE'; id: string; occurredAt: string }
  | { type: 'ANALYTICS_TRACK'; event: { name: string; platform?: string; feature?: string; outcome?: string; durationMs?: number; sessionId?: string; operation?: string } }
  | { type: 'PROGRESS_SAVE'; progress: import('./api').ProgressInput; localOnly?: boolean }
  | { type: 'ATTEMPT_RECORD'; attempt: AttemptInput }
  | { type: 'VOCABULARY_STATE_GET' }
  | { type: 'VOCABULARY_PLAN_GET' }
  | { type: 'VOCABULARY_SAVE'; input: VocabularyWordInput }
  | { type: 'VOCABULARY_MARK_KNOWN'; input: VocabularyWordInput }
  | { type: 'VOCABULARY_REMOVE'; word: string }
  | { type: 'VOCABULARY_REVIEW'; word: string; rating: VocabularyRating }
  | { type: 'VOCABULARY_GOAL_SET'; goal: VocabularyGoal | null }
  | { type: 'VOCABULARY_CHANGED' }
  | { type: 'EXPRESSION_BUNDLE_SAVE'; bundle: ExpressionBundleInput }
  | { type: 'EXPRESSION_REVIEW_STATE_GET' }
  | { type: 'EXPRESSION_REVIEW_RATE'; itemId: string; rating: ExpressionReviewRating; sessionId: string; responseMs?: number }
  | { type: 'EXPRESSION_CHALLENGE_ATTEMPT_RECORD'; attempt: Omit<ExpressionChallengeAttempt, 'id' | 'officialScheduleChanged' | 'timestamp'> }
  | { type: 'ACCOUNT_EXPORT' }
  | { type: 'ACCOUNT_DELETE'; confirmation: 'DELETE' }
  | { type: 'ACCOUNT_STATUS' }
  | { type: 'CORPUS_RESOLVE_SUBTITLES'; videoKey: string; durationMs: number }
  | { type: 'PUBLIC_CORPUS_LIST'; filters: PublicCorpusFilterInput }
  | { type: 'PUBLIC_CORPUS_COLLECTIONS_LIST'; filters: PublicCorpusFilterInput }
  | { type: 'PUBLIC_CORPUS_EPISODES_LIST'; filters: PublicCorpusEpisodesFilterInput }
  | { type: 'PUBLIC_CORPUS_FACETS'; filters?: Pick<PublicCorpusFilterInput, 'platform'> }
  | { type: 'CORPUS_SUBTITLE_TITLES_LIST'; filters: import('./api').CorpusSubtitleTitleFilterInput }
  | { type: 'CORPUS_SUBTITLE_DETAIL_GET'; subtitleId: string; contentVersion: string }
  | { type: 'MEDIA_CORPUS_LIST'; filters: MediaCorpusFilterInput }
  | { type: 'MEDIA_CORPUS_SERIES'; filters?: { mediaKind?: 'video' | 'audio' } }
  | { type: 'MEDIA_CORPUS_RECOMMEND'; filters: import('./api').MediaCorpusRecommendInput }
  | { type: 'MEDIA_CORPUS_RESOLVE_PLAYBACK'; corpusItemId: string; pageOpen?: true }
  | { type: 'SYNC_NOW' };
