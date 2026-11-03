import { t } from '../../lib/i18n';
import { downloadPlatformFile } from '../../lib/platform-export';
import { selectTranscript } from '../../lib/video-transcript';
import { Icon, type IconName } from '../../components/icon';
import { track } from '../../lib/analytics';
import { GlobalAiSettingsProvider } from '../../components/agent/global-ai-settings';
import { videoKeyOf, videoIdentity, videoUrl, videoThumbnail } from '@shadow-language/contracts';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { liveQuery } from 'dexie';
import { ExtensionUpdateNotice } from '../../components/extension-update-notice';
import type { MediaCorpusPlaybackResponse, MediaCorpusRecommendResponse, PublicCorpusFilterInput, RuntimeMessage, SavedItemInput, UserSettings, VideoAnalysis, VideoVocabularyCoverage, VideoVocabularyRecommendation } from '@shadow-language/contracts';
import { vocabularyMatch } from '../../lib/corpus';
import { canShiftWindow, fetchDifficultyLadder, recommendationWindow, recommendMediaRoute, shiftRecommendationWindow, type RecommendKind } from '../../lib/media-recommend';
import { db, DEFAULT_SETTINGS, type LocalProgress } from '../../lib/db';
import { formatErrorForDisplay, runtimeTransportError, unwrapRuntimeResponse, userFacingErrorMessage } from '../../lib/runtime-errors';
import { DEFAULT_PAGE_SHORTCUTS, PAGE_SHORTCUT_LABELS, assignShortcut, shortcutKeyLabel, type PageShortcuts } from '../../lib/shortcuts';
import { analyzeFrequencyCoverage, createPersonalVocabularyCoverage, type CoverageBand, type VocabularyFrequencyCoverage } from '../../lib/frequency-coverage';
import { analyzeVocabularyText, exactVocabularyTierForSize, previewLevelForVocabularySize, recommendedVocabularyForProfile, vocabularyCoverage, vocabularyThresholdLabel, vocabularyTierForSize, VOCABULARY_TIERS, type VocabularyCoverage, type VocabularyRecommendation, type VocabularyTextProfile } from '../../lib/vocabulary-profile';
import { webAccessState, webProtectedSurface, type WebProtectedSurface } from '../../lib/web-access-control';
import type { ReaderRuntimeSender } from './reader-estimator';
import type { VocabularyStudyRuntimeSender } from './vocabulary-study';
import { useDashboardStore, type DashboardTab } from './store';
import './style.css';
import '../../components/fonts.css';
// Preserve the cascade before Web theme overrides, while loading feature code
// only when its screen is opened.
import '../../components/agent/agent.css';
import './reader-estimator.css';
import './vocabulary-study.css';
import '../../components/agent/study-document.css';

const StudyDocumentButtons = lazy(() => import('../../components/agent/study-document').then(module => ({ default: module.StudyDocumentButtons })));
const AgentApp = lazy(() => import('../../components/agent/agent-app').then(module => ({ default: module.AgentApp })));
const ReaderEstimator = lazy(() => import('./reader-estimator').then(module => ({ default: module.ReaderEstimator })));
const VocabularyStudy = lazy(() => import('./vocabulary-study').then(module => ({ default: module.VocabularyStudy })));

const TABS: Array<{ id: DashboardTab; label: string; icon: IconName }> = [
  { id: 'public-corpus', icon: 'grid', label: t("语料库") },
  { id: 'agent', icon: 'sparkles', label: t("专属智能教练") },
  { id: 'reader', icon: 'book', label: t("读懂多少") },
  { id: 'study', icon: 'brain', label: t("词库与复习") },
  { id: 'corpus', icon: 'history', label: t("我看过的") },
  { id: 'settings', icon: 'settings', label: t("设置") },
];

const WEB_AUTH_REQUIRED_EVENT = 'shadow-language:web-auth-required';

function learningUrl(key: string, startMs = 0) {
  return import.meta.env.VITE_SHADOW_WEB ? `#watch/${encodeURIComponent(key)}?t=${Math.max(0, Math.round(startMs))}` : videoUrl(key, startMs);
}

const ASSET_KIND_LABELS: Record<SavedItemInput['kind'], string> = {
  word: t("单词"),
  phrase: t("短语"),
  pattern: t("句式"),
};

const DELETION_STATUS_LABELS: Record<string, string> = {
  queued: t("等待处理"),
  leased: t("删除中"),
  retry_scheduled: t("等待重试"),
  ready: t("已删除"),
  dead_letter: t("删除失败"),
  unknown: t("状态未知"),
};

const OUTBOX_TYPE_LABELS: Record<string, string> = {
  saveAsset: t("保存学习资产"),
  deleteAsset: t("删除学习资产"),
  progress: t("学习进度"),
  attempt: t("跟读与重播记录"),
};

type CorpusAnalysisSummary = {
  status?: string | null;
  difficultyBand?: string | null;
  confidence?: number | null;
  difficultyScore?: number | null;
  tokenCount?: number | null;
  lemmaCount?: number | null;
  activeWpm?: number | null;
  cefrLevel?: string | null;
  topicIds?: string[];
  topics?: string[];
  register?: string | null;
  summaryZh?: string | null;
  learningSummaryZh?: string | null;
  recommendedVocabulary?: VideoVocabularyRecommendation | null;
  vocabularyCoverage?: VideoVocabularyCoverage | null;
};

type VocabularyFit = VocabularyCoverage & {
  recommendation: VocabularyRecommendation;
  label: string;
  tone: 'comfortable' | 'suitable' | 'challenging' | 'hard';
};

type CorpusEntry = {
  key: string;
  lastWatchedAt?: string | null;
  positionMs?: number;
  youtubeId?: string;
  videoKey?: string;
  platform?: 'youtube' | 'bilibili';
  seriesId?: string | null;
  seriesTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  episodeTitle?: string | null;
  thumbnailUrl?: string | undefined;
  hasSubtitles?: boolean;
  title: string;
  status: string;
  observedAt?: string | null;
  updatedAt?: number | string | null;
  trackId?: string;
  captionHash?: string | null;
  canonicalUrl?: string | null;
  channelId?: string | null;
  channelTitle?: string | null;
  durationMs?: number | null;
  language?: string | null;
  trackKind?: string | null;
  cueCount?: number | null;
  publicationScope?: string | null;
  privacyStatus?: string | null;
  analysisJobStatus?: string | null;
  analysisAttempts?: number | null;
  analysisError?: string | null;
  analysisErrorAt?: string | null;
  analysis?: CorpusAnalysisSummary | null;
};

function ShortcutEditor({ shortcuts, onChange }: { shortcuts: PageShortcuts; onChange: (shortcuts: PageShortcuts) => void }) {
  return <details className="shortcut-editor"><summary>{t("播放器页面快捷键")}</summary><p className="muted">{t("点击任一按键框，再按下新按键。若与另一动作重复，两者会自动交换；输入框和评论区聚焦时不会触发。")}</p><div>{PAGE_SHORTCUT_LABELS.map(({ action, label }) => <label key={action}><span>{label}</span><input aria-label={t("{0}快捷键", label)} value={shortcutKeyLabel(shortcuts[action])} readOnly onKeyDown={(event) => { if (event.metaKey || event.ctrlKey || event.altKey || ['Tab', 'Escape', 'Shift', 'Meta', 'Control', 'Alt'].includes(event.key) || event.key.length > 16) return; event.preventDefault(); onChange(assignShortcut(shortcuts, action, event.key)); }} /></label>)}</div><button onClick={() => onChange(DEFAULT_PAGE_SHORTCUTS)}>{t("恢复默认页面快捷键")}</button><p className="muted">{t("Space 由页面原生播放器处理；扩展播放/暂停快捷键默认为 W。跨页面的 Chrome 组合键可在")}<code>chrome://extensions/shortcuts</code> {t("配置。")}</p></details>;
}

async function sendRuntime<T>(message: RuntimeMessage): Promise<T> {
  try {
    return unwrapRuntimeResponse(await browser.runtime.sendMessage(message));
  } catch (error) {
    throw runtimeTransportError(error);
  }
}

async function sendAuthRuntime<T>(message: RuntimeMessage): Promise<T> {
  const result = await sendRuntime<T | { error: string }>(message);
  if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string') throw new Error(result.error);
  return result as T;
}

function displayError(error: unknown, fallback = t("操作失败，未返回具体错误描述。")): string {
  return formatErrorForDisplay(error, fallback);
}

function displayAuthError(error: unknown, fallback: string): string {
  return userFacingErrorMessage(error, fallback);
}

function authEmailOf(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const record = user as Record<string, unknown>;
  const direct = [record.email, record.emailAddress].find((value): value is string => typeof value === 'string' && value.includes('@'));
  if (direct) return direct.trim().toLowerCase();
  for (const key of ['user', 'data', 'userInfo']) {
    const nested = authEmailOf(record[key]);
    if (nested) return nested;
  }
  return null;
}

export function DashboardApp({ web = false, allowGuestPlayer = false, hideNavigation = false, children, webCorpus, webSettings, webLamplit, webLocalCorpus, webBookRecommendations, resolveWatchedCover, webPlayerIllustration }: { web?: boolean; allowGuestPlayer?: boolean; hideNavigation?: boolean; children?: React.ReactNode; webCorpus?: React.ReactNode; webSettings?: React.ReactNode; webLamplit?: React.ReactNode; webLocalCorpus?: React.ReactNode; webBookRecommendations?: React.ReactNode; resolveWatchedCover?: (item: LocalProgress) => Promise<string | undefined>; webPlayerIllustration?: string | undefined }) {
  const store = useDashboardStore();
  const [navOpen, setNavOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [assets, setAssets] = useState<Array<SavedItemInput & { syncStatus?: string; deletedAt?: string }>>([]);
  const [progressItems, setProgressItems] = useState<LocalProgress[]>([]);
  const [videoAnalyses, setVideoAnalyses] = useState<Record<string, VideoAnalysis>>({});
  const [localFrequencyCoverage, setLocalFrequencyCoverage] = useState<Record<string, { objective: VocabularyFrequencyCoverage; personal: CoverageBand }>>({});
  const protectedSurface = webProtectedSurface(web, Boolean(children) && !allowGuestPlayer, store.activeTab);
  const accessState = webAccessState(protectedSurface, store.authReady, store.signedIn);
  const playerVisible = Boolean(children) && accessState === 'allowed';
  const coverageCache = useRef(new Map<string, { text: string; vocabulary: string; value: { objective: VocabularyFrequencyCoverage; personal: CoverageBand } }>());
  const refreshGeneration = useRef(0);

  const readLocal = async () => {
    // Transcript coverage is only displayed on Today and watched-history.
    // Consult the current store rather than a stale interval closure.
    const tab = useDashboardStore.getState().activeTab;
    const needsCoverage = !children && (tab === 'today' || tab === 'corpus');
    const needsAssets = !children && (tab === 'study' || tab === 'assets');
    const [nextAssets, nextProgressItems, nextVideoAnalysisRecords, captionCaches, vocabularyCards, baselineValues] = await Promise.all([
      needsAssets ? db.assets.orderBy('occurredAt').reverse().toArray() : Promise.resolve([]),
      needsCoverage ? db.progress.orderBy('occurredAt').reverse().toArray() : Promise.resolve([]),
      needsCoverage ? db.videoAnalyses.toArray() : Promise.resolve([]),
      needsCoverage ? db.captions.toArray() : Promise.resolve([]),
      needsCoverage ? db.vocabulary.toArray() : Promise.resolve([]),
      needsCoverage ? (web
        ? db.table('userPreferences').get('readerVocabBaseline').then(record => ({ readerVocabBaseline: record?.value }))
        : browser.storage.local.get(['readerVocabBaseline'])) : Promise.resolve({ readerVocabBaseline: undefined }),
    ]);
    return { nextAssets, nextProgressItems, nextVideoAnalysisRecords, captionCaches, vocabularyCards, baselineValues, needsCoverage };
  };
  const applyLocal = ({ nextAssets, nextProgressItems, nextVideoAnalysisRecords, captionCaches, vocabularyCards, baselineValues, needsCoverage }: Awaited<ReturnType<typeof readLocal>>) => {
    setAssets(nextAssets.filter((item) => !item.deletedAt));
    setProgressItems(nextProgressItems);
    const nextVideoAnalyses: Record<string, VideoAnalysis> = {};
    for (const record of nextVideoAnalysisRecords) nextVideoAnalyses[record.id] = record.analysis;
    setVideoAnalyses(nextVideoAnalyses);
    if (!needsCoverage) return;
    const storedBaseline = baselineValues.readerVocabBaseline as { rank?: number; source?: string } | undefined;
    const baselineRank = typeof storedBaseline?.rank === 'number' && storedBaseline.source !== 'ngsl'
      ? vocabularyTierForSize(storedBaseline.rank).rank
      : useDashboardStore.getState().settings.vocabularySize;
    const extraWords = vocabularyCards.flatMap((card) => [card.word, card.lemma]);
    const vocabulary = JSON.stringify([baselineRank, extraWords]);
    let personal: ReturnType<typeof createPersonalVocabularyCoverage> | undefined;
    const retained = new Set<string>();
    const nextCoverage: Record<string, { objective: VocabularyFrequencyCoverage; personal: CoverageBand }> = {};
    for (const item of nextProgressItems) {
      const key = videoKeyOf(item);
      const cache = selectTranscript(captionCaches, key, item.trackId);
      if (!cache || !cache.cues?.length) continue;
      const text = cache.cues.map((cue) => cue.text).join(' ');
      retained.add(cache.id);
      const cached = coverageCache.current.get(cache.id);
      const coverageData = cached?.text === text && cached.vocabulary === vocabulary ? cached.value
        : { objective: cached?.text === text ? cached.value.objective : analyzeFrequencyCoverage(text), personal: (personal ||= createPersonalVocabularyCoverage(baselineRank, extraWords))(text) };
      coverageCache.current.set(cache.id, { text, vocabulary, value: coverageData });
      if (key) nextCoverage[key] = coverageData;
      if (item.id) nextCoverage[item.id] = coverageData;
      if (item.youtubeId) nextCoverage[item.youtubeId] = coverageData;
    }
    for (const key of coverageCache.current.keys()) if (!retained.has(key)) coverageCache.current.delete(key);
    setLocalFrequencyCoverage(nextCoverage);
  };
  const refreshLocal = async () => {
    const generation = ++refreshGeneration.current;
    const database = db;
    const snapshot = await readLocal();
    if (generation === refreshGeneration.current && database === db) applyLocal(snapshot);
  };

  useEffect(() => {
    let disposed = false;
    let requestedTab = location.hash.slice(1).split('?')[0] || '';
    if (requestedTab === 'assets') requestedTab = 'study';
    if (requestedTab === 'progress') {
      requestedTab = 'corpus';
      history.replaceState(null, '', '#corpus');
    }
    if ((web && (requestedTab === 'today' || requestedTab === 'lamplit' || requestedTab === 'local-corpus')) || requestedTab === 'agent' || requestedTab === 'reader' || requestedTab === 'study' || requestedTab === 'corpus' || requestedTab === 'public-corpus' || requestedTab === 'settings') store.setActiveTab(requestedTab as DashboardTab);

    void sendRuntime<UserSettings>({ type: 'SETTINGS_GET' })
      .then((settings) => {
        if (!disposed) store.setSettings(settings);
      })
      .catch((error) => {
        if (!disposed) store.setNotice(displayError(error, t("Shadow Language 设置读取失败。")));
      });
    void sendRuntime<{ signedIn: boolean; user?: unknown }>({ type: 'AUTH_STATUS' })
      .then(async (auth) => {
        if (disposed) return;
        store.setSignedIn(auth.signedIn);
        store.setAccountEmail(auth.signedIn ? authEmailOf(auth.user) : null);
        store.setAuthReady(true);
        if (!auth.signedIn) return;
        await sendRuntime({ type: 'VIDEO_INSIGHTS_REFRESH' }).catch((error) => {
          if (!disposed) store.setNotice(displayError(error, t("视频学习数据刷新失败。")));
        });
        if (!disposed) {
          await refreshLocal().catch((error) => store.setNotice(displayError(error, t("本地学习数据读取失败。"))));
        }
      })
      .catch((error) => {
        if (!disposed) {
          store.setAuthReady(true);
          store.setNotice(displayError(error, t("Shadow Language 登录状态读取失败。")));
        }
      });
    const syncHash = () => {
      let tab = location.hash.slice(1).split('?')[0] || '';
      if (tab === 'assets') tab = 'study';
      if (tab === 'progress') {
        tab = 'corpus';
        history.replaceState(null, '', '#corpus');
      }
      if ((web && (tab === 'today' || tab === 'lamplit' || tab === 'local-corpus')) || tab === 'agent' || tab === 'reader' || tab === 'study' || tab === 'corpus' || tab === 'public-corpus' || tab === 'settings') useDashboardStore.getState().setActiveTab(tab as DashboardTab);
    };
    window.addEventListener('hashchange', syncHash);
    return () => { disposed = true; window.removeEventListener('hashchange', syncHash); };
  }, []);

  useEffect(() => {
    const database = db;
    const subscription = liveQuery(readLocal).subscribe({
      next: snapshot => { if (database === db) { refreshGeneration.current += 1; applyLocal(snapshot); } },
      error: error => store.setNotice(displayError(error, t("本地学习数据读取失败。"))),
    });
    const baselineChanged = (changes: Record<string, unknown>) => {
      if (!changes.readerVocabBaseline) return;
      void refreshLocal().catch(error => store.setNotice(displayError(error, t("本地学习数据读取失败。"))));
    };
    // Reader baselines live in browser storage in the extension and IndexedDB
    // on Web. Observe both transports instead of scanning every two seconds.
    browser.storage.onChanged.addListener(baselineChanged);
    return () => { subscription.unsubscribe(); refreshGeneration.current += 1; browser.storage.onChanged.removeListener(baselineChanged); };
  }, [store.activeTab, store.settings.vocabularySize, store.signedIn, Boolean(children)]);

  useEffect(() => {
    if (!store.notice) return;
    const timer = window.setTimeout(() => {
      store.setNotice(null);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [store.notice, store.noticeId]);

  useEffect(() => {
    const handleShortcut = (message: RuntimeMessage) => {
      if (message.type === 'AUTH_INVALIDATED') {
        const current = useDashboardStore.getState();
        current.setAuthReady(true);
        current.setSignedIn(false);
        current.setAccountEmail(null);
        current.setNotice(t("已切换为本地模式，学习数据保留在此浏览器。"));
        return;
      }
    };
    browser.runtime.onMessage.addListener(handleShortcut);
    return () => browser.runtime.onMessage.removeListener(handleShortcut);
  }, []);

  useEffect(() => {
    if (!web) return;
    const requireAuthentication = () => setLoginOpen(true);
    window.addEventListener(WEB_AUTH_REQUIRED_EVENT, requireAuthentication);
    return () => window.removeEventListener(WEB_AUTH_REQUIRED_EVENT, requireAuthentication);
  }, [web]);

  const handleSignedIn = async (settings: UserSettings, email: string) => {
    store.setAuthReady(true);
    store.setSignedIn(true);
    store.setAccountEmail(email.trim().toLowerCase());
    store.setSettings(settings);
    setLoginOpen(false);
    await refreshLocal().catch((error) => store.setNotice(displayError(error, t("登录成功，但本地学习数据刷新失败。"))));
  };

  const handleSignOut = async () => {
    if (authBusy) return;
    setAuthBusy(true);
    try {
      await sendRuntime({ type: 'AUTH_SIGN_OUT' });
      store.setAuthReady(true);
      store.setSignedIn(false);
      store.setAccountEmail(null);
      await refreshLocal();
    } catch (error) {
      store.setNotice(displayError(error, t("退出登录失败，请重试。")));
    } finally {
      setAuthBusy(false);
    }
  };

  const updateSettings = async (partial: Partial<UserSettings>) => {
    try {
      const settings = await sendRuntime<UserSettings>({ type: 'SETTINGS_UPDATE', settings: partial });
      store.setSettings(settings);
    } catch (error) {
      store.setNotice(displayError(error));
    }
  };

  return (
    <GlobalAiSettingsProvider>
    <main className={`app dashboard-app ${web ? 'web-dashboard' : ''} ${navOpen ? 'nav-open' : ''} ${playerVisible ? 'has-player' : ''} ${hideNavigation ? 'hide-navigation' : ''}`}>
      {store.notice && (
        <div key={store.noticeId} className="dashboard-notice-toast" role="status" aria-live="polite">
          <button
            type="button"
            className="notice toast-notice"
            onClick={() => store.setNotice(null)}
          >
            <span className="notice-text">{store.notice}</span>
            <span className="notice-close" aria-label={t("关闭提示")}>
              <Icon name="close" size={14} />
            </span>
          </button>
        </div>
      )}
      {web && !hideNavigation && <header className="web-mobile-header"><a href="#today"><img src="/design/brand-mark.svg" width="44" height="44" alt="" />Shadow Language</a><button aria-label={navOpen ? t("关闭导航") : t("打开导航")} aria-expanded={navOpen} onClick={() => setNavOpen(value => !value)}><img src={`/design/icons/${navOpen ? 'close' : 'menu'}.svg`} width="24" height="24" alt="" /></button></header>}
      <div className="dashboard-layout">
        {!hideNavigation && <nav className="dashboard-nav">
          <div className="dashboard-nav-header">
            <div className="dashboard-brand web-nav-brand-desktop">{web ? <img src="/design/brand-mark.svg" width="54" height="54" alt="" /> : <span className="brand-mark" aria-hidden="true">SL</span>}<strong>Shadow Language</strong></div>
            <CloudState signedIn={store.signedIn} email={store.accountEmail} authBusy={authBusy} onLogin={() => setLoginOpen(true)} onSignOut={() => void handleSignOut()} />
          </div>
          <div className="dashboard-nav-links">
            {(web ? [{id:'today' as DashboardTab,icon:'book' as IconName,label:t("今日学习")}, TABS[0]!, {id:'local-corpus' as DashboardTab,icon:'grid' as IconName,label:t("本地语料")}, ...TABS.slice(1, -1), {id:'lamplit' as DashboardTab,icon:'book' as IconName,label:t("文章精讲")}, TABS[TABS.length - 1]!] : TABS).map((tab) => <button key={tab.id} className={!children && (store.activeTab === tab.id || (tab.id === 'study' && store.activeTab === 'assets')) ? 'active' : ''} onClick={() => { store.setActiveTab(tab.id); location.hash = tab.id; setNavOpen(false); }}>{web ? <img src={`/design/icons/${({ today: 'home', lamplit: 'book', 'public-corpus': 'library', 'local-corpus': 'download', agent: 'wand', reader: 'book', study: 'vocabulary', corpus: 'film', settings: 'settings' } as Record<string, string>)[tab.id] || 'bookmark'}.svg`} width="24" height="24" alt="" /> : <Icon name={tab.icon} size={19} />}<span>{tab.label}</span></button>)}
          </div>
          <div className="dashboard-nav-footer">
            {web && <img className="web-books-cat" src={(playerVisible && webPlayerIllustration) || '/design/books-cat.webp'} alt="" />}
            {!web && <ExtensionUpdateNotice showCheck />}
          </div>
        </nav>}
        {web && !hideNavigation && navOpen && <div className="web-nav-overlay" aria-hidden="true" onClick={() => setNavOpen(false)} />}
        <section className={`dashboard-content ${store.activeTab === 'agent' && accessState === 'allowed' ? 'dashboard-content-agent' : ''}`}>
          {accessState === 'checking'
            ? <LoginRequired surface={protectedSurface} checking />
            : accessState === 'login-required'
              ? <LoginRequired surface={protectedSurface} notice={store.notice} onSignedIn={handleSignedIn} />
              : <Suspense fallback={<p role="status">{t("正在打开学习页面…")}</p>}>{children || <>
          {web && store.activeTab === 'today' && <TodayOverview signedIn={store.signedIn} progressItems={progressItems} videoAnalyses={videoAnalyses} vocabularySize={store.settings.vocabularySize} localFrequencyCoverage={localFrequencyCoverage} refreshLocal={refreshLocal} bookRecommendations={webBookRecommendations} resolveWatchedCover={resolveWatchedCover} />}
          {web && store.activeTab === 'lamplit' && webLamplit}
          {web && store.activeTab === 'local-corpus' && webLocalCorpus}
          {store.activeTab === 'settings' && !webSettings && <div className="dashboard-heading"><h1>{t("设置与账号")}</h1></div>}
          {store.activeTab === 'agent' && <div className="dashboard-agent-full"><AgentApp isDashboard={true} showAiSettingsButton={!web} /></div>}
          {store.activeTab === 'reader' && <ReaderEstimator web={web} sendRuntime={sendRuntime as ReaderRuntimeSender} vocabularySize={store.settings.vocabularySize} onVocabularySizeChange={(vocabularySize) => void updateSettings({ vocabularySize, learnerLevel: previewLevelForVocabularySize(vocabularySize) })} onNotice={(notice) => store.setNotice(notice)} />}
          {(store.activeTab === 'study' || store.activeTab === 'assets') && <VocabularyStudy web={web} vocabularySize={web ? store.settings.vocabularySize : undefined} sendRuntime={sendRuntime as VocabularyStudyRuntimeSender} onNotice={(notice) => store.setNotice(notice)} assets={assets} onOpenAsset={(item) => void sendRuntime({ type: 'VIDEO_OPEN', ...videoIdentity(videoKeyOf(item)), startMs: item.startMs })} onUpdateAsset={async (item) => { await sendRuntime({ type: 'ASSET_SAVE', item }); await refreshLocal(); }} onDeleteAsset={async (id) => { await sendRuntime({ type: 'ASSET_DELETE', id, occurredAt: new Date().toISOString() }); await refreshLocal(); }} />}
          {store.activeTab === 'corpus' && <CorpusLibrary signedIn={store.signedIn} progressItems={progressItems} videoAnalyses={videoAnalyses} vocabularySize={store.settings.vocabularySize} localFrequencyCoverage={localFrequencyCoverage} refreshLocal={refreshLocal} resolveWatchedCover={resolveWatchedCover} />}
          {store.activeTab === 'public-corpus' && (web && webCorpus ? webCorpus : <PublicCorpusLibrary vocabularySize={store.settings.vocabularySize} onVocabularySizeChange={(vocabularySize) => void updateSettings({ vocabularySize, learnerLevel: previewLevelForVocabularySize(vocabularySize) })} />)}
          {store.activeTab === 'settings' && (web && webSettings ? webSettings : <Settings signedIn={store.signedIn} accountEmail={store.accountEmail} settings={store.settings} setSignedIn={store.setSignedIn} setAccountEmail={store.setAccountEmail} setSettings={store.setSettings} updateSettings={updateSettings} refreshLocal={refreshLocal} onOpenLogin={() => setLoginOpen(true)} onSignOut={handleSignOut} />)}
          </>}</Suspense>}
        </section>
      </div>
      <AuthDialog open={loginOpen} onClose={() => setLoginOpen(false)} onSignedIn={handleSignedIn} web={web} />
    </main>
    </GlobalAiSettingsProvider>
  );
}

export function AuthForm({ onSignedIn, autoFocus = false, className = '' }: { onSignedIn: (settings: UserSettings, email: string) => Promise<void>; autoFocus?: boolean; className?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [verificationPending, setVerificationPending] = useState(false);
  const [resendAvailableIn, setResendAvailableIn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!verificationPending) return undefined;
    const port = browser.runtime.connect({ name: 'shadow-language-signup' });
    const keepAlive = setInterval(() => port.postMessage({ type: 'keepalive' }), 20_000);
    return () => { clearInterval(keepAlive); port.disconnect(); };
  }, [verificationPending]);
  useEffect(() => {
    if (!verificationPending || resendAvailableIn <= 0) return undefined;
    const timer = setTimeout(() => setResendAvailableIn((seconds) => Math.max(0, seconds - 1)), 1_000);
    return () => clearTimeout(timer);
  }, [verificationPending, resendAvailableIn]);
  const continueEmail = async () => {
    setBusy(true); setError('');
    try {
      const result = await sendAuthRuntime<{ signedIn: boolean; verificationRequired: boolean; settings?: UserSettings }>({ type: 'AUTH_EMAIL_CONTINUE', email, password });
      if (result.signedIn && result.settings) {
        await onSignedIn(result.settings, email);
        setPassword('');
      } else {
        setVerificationPending(result.verificationRequired);
        if (result.verificationRequired) setResendAvailableIn(60);
      }
    } catch (cause) { setError(displayAuthError(cause, t("登录或注册失败。"))); }
    finally { setBusy(false); }
  };
  const resendRegistration = async () => {
    setBusy(true); setError('');
    try {
      await sendAuthRuntime<{ resent: boolean; expiresInSeconds: number }>({ type: 'AUTH_SIGN_UP_RESEND', email });
      setResendAvailableIn(60);
    } catch (cause) { setError(displayAuthError(cause, t("验证码重发失败。"))); }
    finally { setBusy(false); }
  };
  const verifyRegistration = async () => {
    setBusy(true); setError('');
    try {
      const result = await sendAuthRuntime<{ signedIn: boolean; settings: UserSettings }>({ type: 'AUTH_SIGN_UP_VERIFY', email, code: verificationCode });
      await onSignedIn(result.settings, email);
      setPassword(''); setVerificationCode(''); setVerificationPending(false);
    } catch (cause) { setError(displayAuthError(cause, t("验证码验证失败。"))); }
    finally { setBusy(false); }
  };
  return <form className={`login-form ${className}`.trim()} onSubmit={(event) => { event.preventDefault(); if (!busy) void (verificationPending ? verifyRegistration() : continueEmail()); }}>
    <input type="email" aria-label={t("邮箱")} autoComplete="email" autoFocus={autoFocus} required placeholder={t("邮箱")} value={email} disabled={busy || verificationPending} onChange={(event) => setEmail(event.target.value)} />
    {!verificationPending && <input type="password" aria-label={t("密码")} autoComplete="current-password" required placeholder={t("密码")} value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />}
    {!verificationPending && <button type="submit" className="primary" disabled={busy || !email.trim() || !password}>{busy ? t("处理中…") : t("登录 / 注册")}</button>}
    {verificationPending && <><p className="muted">{t("验证码已发送至")}{email}{t("，10 分钟内有效。请输入验证码完成登录。")}</p><input aria-label={t("邮箱验证码")} inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} placeholder={t("6 位邮箱验证码")} value={verificationCode} disabled={busy} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, ''))} /><button type="submit" className="primary" disabled={busy || verificationCode.length !== 6}>{busy ? t("验证中…") : t("验证并登录")}</button><button type="button" disabled={busy || resendAvailableIn > 0} onClick={resendRegistration}>{resendAvailableIn > 0 ? t("{0} 秒后可重发", resendAvailableIn) : busy ? t("发送中…") : t("重新发送验证码")}</button><button type="button" disabled={busy} onClick={() => { setVerificationPending(false); setVerificationCode(''); setResendAvailableIn(0); setError(''); }}>{t("修改邮箱或密码")}</button></>}
    {error && <p className="error">{error}</p>}
  </form>;
}

function WebAuthForm({ onSignedIn, autoFocus = false, className = '' }: { onSignedIn: (settings: UserSettings, email: string) => Promise<void>; autoFocus?: boolean; className?: string }) {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [verificationPending, setVerificationPending] = useState(false);
  const [resendAvailableIn, setResendAvailableIn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!verificationPending) return undefined;
    const port = browser.runtime.connect({ name: 'shadow-language-signup' });
    const keepAlive = setInterval(() => port.postMessage({ type: 'keepalive' }), 20_000);
    return () => { clearInterval(keepAlive); port.disconnect(); };
  }, [verificationPending]);
  useEffect(() => {
    if (!verificationPending || resendAvailableIn <= 0) return undefined;
    const timer = setTimeout(() => setResendAvailableIn((seconds) => Math.max(0, seconds - 1)), 1_000);
    return () => clearTimeout(timer);
  }, [verificationPending, resendAvailableIn]);
  const switchMode = (next: 'login' | 'signup' | 'reset') => {
    setMode(next);
    setPassword('');
    setConfirmPassword('');
    setVerificationCode('');
    setVerificationPending(false);
    setResendAvailableIn(0);
    setError('');
  };
  const loginErrorMessage = (cause: unknown): string => {
    const details = cause && typeof cause === 'object' ? cause as { code?: unknown } : {};
    const code = String(details.code || '');
    if (['invalid_password', 'invalid_credentials', 'not_found', 'user_not_found', '4043'].includes(code)) {
      return t("邮箱或密码错误，请检查后重试。忘记密码可通过邮箱验证码重置。");
    }
    if (code === 'password_not_set' || code === '4029') return t("该账号尚未设置密码，请点击“忘记密码”设置新密码。");
    if (code === 'invalid_status') return t("密码尝试次数过多，请稍后再试，或重置密码。");
    if (code === 'user_pending') return t("该账号尚未激活，请先完成邮箱验证。");
    if (code === 'user_blocked') return t("该账号已被停用，请联系支持人员。");
    return displayAuthError(cause, t("登录失败，请稍后重试。"));
  };
  const submitCredentials = async () => {
    setBusy(true); setError('');
    try {
      if (mode === 'login') {
        const result = await sendAuthRuntime<{ signedIn: boolean; settings?: UserSettings }>({ type: 'AUTH_SIGN_IN', email, password });
        if (!result.signedIn || !result.settings) throw new Error(t("登录会话未建立，请重试。"));
        await onSignedIn(result.settings, email);
        setPassword('');
        return;
      }
      if (password.length < 8) throw new Error(t("新密码至少需要 8 位。"));
      if (password !== confirmPassword) throw new Error(t("两次输入的密码不一致。"));
      const message: RuntimeMessage = mode === 'signup'
        ? { type: 'AUTH_SIGN_UP_START', email, password }
        : { type: 'AUTH_PASSWORD_RESET_START', email, password };
      const result = await sendAuthRuntime<{ verificationRequired: boolean }>(message);
      if (!result.verificationRequired) throw new Error(t("验证码未发送，请重试。"));
      setVerificationPending(true);
      setResendAvailableIn(60);
    } catch (cause) {
      const failure = cause && typeof cause === 'object' ? cause as { code?: unknown; category?: unknown; message?: unknown } : {};
      const code = String(failure.code || '');
      if (mode === 'login') setError(loginErrorMessage(cause));
      else if (mode === 'signup' && (code === 'failed_precondition' || failure.category === 'PRECONDITION_FAILED' || String(failure.message || '').includes('该邮箱已注册'))) {
        setError(t("该邮箱已有账号，请切换到登录；如果忘记密码，可以重置密码。"));
      } else if (mode === 'reset' && (['not_found', 'user_not_found', '4043'].includes(code) || failure.category === 'USER_NOT_FOUND')) {
        setError(t("没有找到该邮箱账号，请检查邮箱地址或注册账号。"));
      } else setError(displayAuthError(cause, mode === 'signup' ? t("注册失败，请稍后重试。") : t("重置密码失败，请稍后重试。")));
    } finally { setBusy(false); }
  };
  const resendVerification = async () => {
    setBusy(true); setError('');
    try {
      await sendAuthRuntime<{ resent: boolean }>({ type: 'AUTH_SIGN_UP_RESEND', email });
      setResendAvailableIn(60);
    } catch (cause) { setError(displayAuthError(cause, t("验证码重发失败。"))); }
    finally { setBusy(false); }
  };
  const verifyEmail = async () => {
    setBusy(true); setError('');
    try {
      const result = await sendAuthRuntime<{ signedIn: boolean; settings?: UserSettings }>({ type: 'AUTH_SIGN_UP_VERIFY', email, code: verificationCode });
      if (!result.signedIn || !result.settings) throw new Error(t("验证成功，但登录会话未建立，请返回登录。"));
      await onSignedIn(result.settings, email);
      setPassword(''); setConfirmPassword(''); setVerificationCode(''); setVerificationPending(false);
    } catch (cause) { setError(displayAuthError(cause, t("验证码验证失败，请重试。"))); }
    finally { setBusy(false); }
  };
  return <form className={'login-form ' + className} onSubmit={(event) => { event.preventDefault(); if (!busy) void (verificationPending ? verifyEmail() : submitCredentials()); }}>
    {mode !== 'reset' && <div className="auth-mode" role="group" aria-label={t("登录或注册")}><button type="button" className={mode === 'login' ? 'active' : ''} aria-pressed={mode === 'login'} disabled={busy} onClick={() => switchMode('login')}>{t("登录")}</button><button type="button" className={mode === 'signup' ? 'active' : ''} aria-pressed={mode === 'signup'} disabled={busy} onClick={() => switchMode('signup')}>{t("注册")}</button></div>}
    {mode === 'reset' && <p className="muted">{t("输入账号邮箱和新密码，验证邮箱后即可重置密码。")}</p>}
    <input type="email" aria-label={t("邮箱")} autoComplete="email" autoFocus={autoFocus} required placeholder={t("邮箱")} value={email} disabled={busy || verificationPending} onChange={(event) => setEmail(event.target.value)} />
    {!verificationPending && <>
      <input type="password" aria-label={mode === 'login' ? t("密码") : t("新密码")} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required placeholder={mode === 'login' ? t("密码") : t("新密码（至少 8 位）")} value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
      {mode !== 'login' && <input type="password" aria-label={t("确认新密码")} autoComplete="new-password" required placeholder={t("再次输入新密码")} value={confirmPassword} disabled={busy} onChange={(event) => setConfirmPassword(event.target.value)} />}
      <button type="submit" className="primary" disabled={busy || !email.trim() || !password || (mode !== 'login' && !confirmPassword)}>{busy ? t("处理中…") : mode === 'login' ? t("登录") : mode === 'signup' ? t("发送注册验证码") : t("发送重置验证码")}</button>
      {mode === 'login' && <button type="button" disabled={busy} onClick={() => switchMode('reset')}>{t("忘记密码？")}</button>}
      {mode === 'reset' && <button type="button" disabled={busy} onClick={() => switchMode('login')}>{t("返回登录")}</button>}
    </>}
    {verificationPending && <>
      <p className="muted">{t("验证码已发送至")}{email}{t("，10 分钟内有效。")}{mode === 'signup' ? t("验证后将创建账号并登录。") : t("验证后将设置新密码并登录。")}</p>
      <input aria-label={t("邮箱验证码")} inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} placeholder={t("6 位邮箱验证码")} value={verificationCode} disabled={busy} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, ''))} />
      <button type="submit" className="primary" disabled={busy || verificationCode.length !== 6}>{busy ? t("验证中…") : mode === 'signup' ? t("验证并注册") : t("验证并重置密码")}</button>
      <button type="button" disabled={busy || resendAvailableIn > 0} onClick={resendVerification}>{resendAvailableIn > 0 ? resendAvailableIn + t("秒后可重发") : t("重新发送验证码")}</button>
      <button type="button" disabled={busy} onClick={() => { setVerificationPending(false); setVerificationCode(''); setResendAvailableIn(0); setError(''); }}>{t("修改邮箱或密码")}</button>
      {mode === 'reset' && <button type="button" disabled={busy} onClick={() => switchMode('login')}>{t("返回登录")}</button>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}

function LoginRequired({ surface, checking = false, notice, onSignedIn }: { surface: WebProtectedSurface; checking?: boolean; notice?: string | null; onSignedIn?: (settings: UserSettings, email: string) => Promise<void> }) {
  const player = surface === 'player';
  return <section className="web-login-required" aria-live="polite">
    <img src="/design/brand-mark.svg" width="64" height="64" alt="" />
    <h1>{checking ? t("正在确认登录状态…") : player ? t("登录后进入播放页") : t("登录后使用 AI")}</h1>
    {!checking && <p>{player ? t("登录后即可播放语料、保存学习进度并使用 AI 学习助手。") : t("AI 服务按账号提供，登录后即可开始对话。")}</p>}
    {notice && <p className="web-login-required-notice" role="alert">{notice}</p>}
    {!checking && onSignedIn && <WebAuthForm onSignedIn={onSignedIn} className="web-login-required-form" />}
    {player && !checking && <a href="#public-corpus">{t("返回语料库")}</a>}
  </section>;
}

function CloudState({ signedIn, email, authBusy, onLogin, onSignOut }: { signedIn: boolean; email: string | null; authBusy: boolean; onLogin: () => void; onSignOut: () => void }) {
  if (signedIn) return <div className="cloud-state cloud-state-account on" title={t("云同步状态")}><div className="cloud-state-account-info"><span className="cloud-state-account-label"><span aria-hidden="true"><Icon name="cloud" /></span> {t("已登录")}</span><span className="cloud-state-email">{email || t("账号邮箱读取中")}</span></div><button type="button" className="cloud-signout" disabled={authBusy} onClick={onSignOut}>{authBusy ? t("退出中…") : t("退出登录")}</button></div>;
  return <button type="button" className="cloud-state cloud-state-login" onClick={onLogin} aria-haspopup="dialog" title={t("登录并开启云同步")}><span aria-hidden="true"><Icon name="cloud" /></span><span>{t("本地模式")}</span><strong>{t("登录")}</strong></button>;
}

const DIFFICULTY_LABELS: Record<VideoAnalysis['difficultyBand'], string> = {
  accessible: t("轻松"), moderate: t("适中"), challenging: t("有挑战"), advanced: t("高难度"),
};

const TOPIC_LABELS: Record<string, string> = {
  technology: t("科技"), 'personal development': t("个人成长"), education: t("教育"), business: t("商业"),
  science: t("科学"), health: t("健康"), news: t("新闻"), culture: t("文化"), history: t("历史"), travel: t("旅行"),
  entertainment: t("娱乐"), lifestyle: t("生活方式"), relationships: t("人际关系"), finance: t("财经"), productivity: t("效率"),
  storytelling: t("故事"), interview: t("访谈"), commentary: t("评论"), comedy: t("喜剧"), cooking: t("烹饪"), gaming: t("游戏"),
  'language learning': t("英语学习"), 'self improvement': t("自我提升"), 'current events': t("时事"),
};

const REGISTER_LABELS: Record<string, string> = {
  conversational: t("日常对话"), academic: t("学术"), formal: t("正式"), informal: t("非正式"), narrative: t("叙事"),
  news: t("新闻播报"), instructional: t("教学"), interview: t("访谈"), general: t("通用"), commentary: t("评论"),
};

const VOCABULARY_RANGES = [
  { value: 'all', label: t("全部独立词汇") },
  { value: '0-300', label: '≤ 300' },
  { value: '301-800', label: '301–800' },
  { value: '801-1500', label: '801–1,500' },
  { value: '1501+', label: '> 1,500' },
];

const SPEED_RANGES = [
  { value: 'all', label: t("全部语速") },
  { value: '0-100', label: t("慢速 · ≤ 100 词/分钟") },
  { value: '100-140', label: t("较慢 · 100–140 词/分钟") },
  { value: '140-180', label: t("中速 · 140–180 词/分钟") },
  { value: '180+', label: t("较快 · > 180 词/分钟") },
];

type CorpusFilters = {
  category: string;
  register: string;
  vocabulary: string;
  speed: string;
  difficulty: string;
  channel: string;
};

const EMPTY_CORPUS_FILTERS: CorpusFilters = {
  category: 'all', register: 'all', vocabulary: 'all', speed: 'all', difficulty: 'all', channel: 'all',
};

function youtubeWatchUrl(youtubeId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`;
}

function youtubeThumbnailUrl(youtubeId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/hqdefault.jpg`;
}

function topicLabel(topic: string): string {
  const normalized = topic.trim().toLocaleLowerCase();
  return t(TOPIC_LABELS[normalized] || topic.trim());
}

function registerLabel(register: string): string {
  const normalized = register.trim().toLocaleLowerCase();
  return t(REGISTER_LABELS[normalized] || register.trim());
}

function difficultyLabel(value: string | null | undefined): string {
  if (!value) return t("待分析");
  return t(value in DIFFICULTY_LABELS ? DIFFICULTY_LABELS[value as VideoAnalysis['difficultyBand']] : value);
}

function vocabularyFitForProfile(profile: VocabularyTextProfile | undefined, vocabularySize: number): VocabularyFit | null {
  if (!profile || profile.totalTokens <= 0) return null;
  const coverage = vocabularyCoverage(profile, vocabularySize);
  const recommendation = recommendedVocabularyForProfile(profile);
  if (!recommendation) return null;
  if (coverage.coveragePercent >= 95) return { ...coverage, recommendation, label: t("很适合"), tone: 'comfortable' };
  if (coverage.coveragePercent >= 90) return { ...coverage, recommendation, label: t("适合"), tone: 'suitable' };
  if (coverage.coveragePercent >= 80) return { ...coverage, recommendation, label: t("有挑战"), tone: 'challenging' };
  return { ...coverage, recommendation, label: t("偏难"), tone: 'hard' };
}

function matchesNumericRange(value: number | null | undefined, range: string): boolean {
  if (range === 'all') return true;
  if (value == null || !Number.isFinite(value)) return false;
  if (range.endsWith('+')) return value >= Number(range.slice(0, -1));
  const [minimum = 0, maximum = Number.POSITIVE_INFINITY] = range.split('-').map(Number);
  return value >= minimum && value <= maximum;
}

function entryTopics(entry: CorpusEntry): string[] {
  return (entry.analysis?.topics || []).map((topic) => topic.trim()).filter(Boolean);
}

function formatRelativeTime(dateString: string | null | undefined): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0 || diffMs < 60_000) return t("刚刚");
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return t("{0} 分钟前", diffMin);
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return t("{0} 小时前", diffHours);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return t("{0} 天前", diffDays);
  return t("{0}月{1}日", date.getMonth() + 1, date.getDate());
}

function learningSummaryOf(analysis: { aiAssessment?: { learningSummaryZh?: string | null } | null; learningSummaryZh?: string | null } | null | undefined): string {
  return analysis?.aiAssessment?.learningSummaryZh?.trim() || analysis?.learningSummaryZh?.trim() || '';
}

function getWatchedCoverage(
  analysis: VideoAnalysis | null | undefined,
  localCoverage?: { objective?: VocabularyFrequencyCoverage; personal?: CoverageBand } | null,
  vocabularySize?: number
): { percent: number; label: string; tone: 'comfortable' | 'suitable' | 'challenging' | 'hard' } | null {
  let percent: number | null = null;
  const targetSize = vocabularySize || 3000;

  if (localCoverage?.personal?.coveragePercent != null && Number.isFinite(localCoverage.personal.coveragePercent)) {
    percent = Math.round(localCoverage.personal.coveragePercent);
  } else if (localCoverage?.objective?.subtlex && localCoverage.objective.subtlex.length > 0) {
    const subtlex = localCoverage.objective.subtlex;
    const matched = subtlex.find((b) => b.size === targetSize)
      || subtlex.slice().reverse().find((b) => b.size <= targetSize)
      || subtlex[0];
    if (matched && Number.isFinite(matched.coveragePercent)) {
      percent = Math.round(matched.coveragePercent);
    }
  } else if (analysis?.vocabularyCoverage?.subtlex && analysis.vocabularyCoverage.subtlex.length > 0) {
    const subtlex = analysis.vocabularyCoverage.subtlex;
    const matched = subtlex.find((b) => b.size === targetSize)
      || subtlex.slice().reverse().find((b) => b.size <= targetSize)
      || subtlex[0];
    if (matched && Number.isFinite(matched.coveragePercent)) {
      percent = Math.round(matched.coveragePercent);
    }
  } else if (analysis?.recommendedVocabulary?.coveragePercent != null && Number.isFinite(analysis.recommendedVocabulary.coveragePercent)) {
    percent = Math.round(analysis.recommendedVocabulary.coveragePercent);
  } else if (analysis?.vocabularyCoverage?.ngsl?.coveragePercent != null && Number.isFinite(analysis.vocabularyCoverage.ngsl.coveragePercent)) {
    percent = Math.round(analysis.vocabularyCoverage.ngsl.coveragePercent);
  }

  if (percent == null) return null;
  if (percent >= 95) return { percent, label: t("很适合"), tone: 'comfortable' };
  if (percent >= 90) return { percent, label: t("适合"), tone: 'suitable' };
  if (percent >= 80) return { percent, label: t("有挑战"), tone: 'challenging' };
  return { percent, label: t("偏难"), tone: 'hard' };
}

function WatchedCard({
  item,
  analysis: hydratedAnalysis,
  localCoverage,
  vocabularySize,
  resolveWatchedCover,
}: {
  item: LocalProgress;
  analysis: VideoAnalysis | null | undefined;
  localCoverage?: { objective?: VocabularyFrequencyCoverage; personal?: CoverageBand } | undefined;
  vocabularySize: number;
  resolveWatchedCover?: ((item: LocalProgress) => Promise<string | undefined>) | undefined;
}) {
  const videoKey = videoKeyOf(item);
  const [cover, setCover] = useState('');
  useEffect(() => {
    let active = true;
    setCover('');
    if (resolveWatchedCover) void resolveWatchedCover(item).then(url => { if (active && url) setCover(url); }).catch(() => undefined);
    return () => { active = false; };
  }, [resolveWatchedCover, videoKey, item.channelTitle]);
  const [recoveredThumbnail, setRecoveredThumbnail] = useState('');
  useEffect(() => {
    if (!import.meta.env.VITE_SHADOW_WEB || item.thumbnailUrl || !videoKey.startsWith('media:onboarding-')) return;
    let active = true;
    // Progress saved before onboarding covers were published has no thumbnail URL.
    void sendRuntime<MediaCorpusPlaybackResponse>({ type: 'MEDIA_CORPUS_RESOLVE_PLAYBACK', corpusItemId: videoKey.slice('media:'.length) })
      .then(async (response) => {
        if (!active || response.status !== 'available' || !response.item.thumbnailUrl) return;
        const thumbnail = videoThumbnail({ videoKey, thumbnailUrl: response.item.thumbnailUrl });
        if (!thumbnail) return;
        setRecoveredThumbnail(thumbnail);
        await db.progress.update(item.id || videoKey, { thumbnailUrl: thumbnail });
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [videoKey, item.id, item.thumbnailUrl]);
  const analysis = hydratedAnalysis || item.analysis;
  const topics = (analysis?.aiAssessment?.topics || []).map((t) => t.trim()).filter(Boolean);
  const resumeMs = item.positionMs && (!item.durationMs || item.positionMs < item.durationMs - 3000) ? item.positionMs : 0;
  const playUrl = learningUrl(videoKey, resumeMs);
  const progressPercent = item.completedRatio != null
    ? Math.round(item.completedRatio * 100)
    : (item.positionMs && item.durationMs)
      ? Math.round((item.positionMs / item.durationMs) * 100)
      : 0;
  const coverage = getWatchedCoverage(analysis, localCoverage, vocabularySize);
  const learningSummary = learningSummaryOf(analysis);

  return (
    <article className="watched-card">
      <a
        className="watched-thumb-wrapper"
        href={playUrl}
        target={import.meta.env.VITE_SHADOW_WEB ? undefined : '_blank'}
        rel="noreferrer"
        aria-label={`${resumeMs ? t("继续观看") : t("观看")} ${item.title || videoKey}`}
      >
        <img className={`watched-thumb-img${cover ? ' watched-thumb-artwork' : ''}`} src={cover || videoThumbnail({ ...item, thumbnailUrl: item.thumbnailUrl || recoveredThumbnail }) || undefined} alt="" loading="lazy" decoding="async" />
        {item.durationMs ? (
          <span className="watched-duration-badge">{formatTime(item.durationMs)}</span>
        ) : null}
        {progressPercent > 0 && (
          <div className="watched-progress-bar-track">
            <div className="watched-progress-bar-fill" style={{ width: `${Math.min(100, Math.max(2, progressPercent))}%` }} />
          </div>
        )}
      </a>

      <div className="watched-card-body">
        <div className="watched-card-header">
          <a className="watched-card-title" href={playUrl} target={import.meta.env.VITE_SHADOW_WEB ? undefined : '_blank'} rel="noreferrer" title={item.title || videoKey}>
            {item.title || videoKey}
          </a>
          <div className="watched-card-meta">
            {item.channelTitle && <span className="watched-channel">{item.channelTitle}</span>}
            {item.trackId && <span className="watched-sub-tag">{t("中英字幕")}</span>}
            {item.positionMs ? (
              <span className="watched-progress-info">
                {t("看到")}{formatTime(item.positionMs)}{item.durationMs ? ` / ${formatTime(item.durationMs)}` : ''}{progressPercent > 0 ? ` · ${progressPercent}%` : ''}
              </span>
            ) : null}
            {item.occurredAt && (
              <span className="watched-last-time" title={new Date(item.occurredAt).toLocaleString()}>
                {t("上次观看")}{formatRelativeTime(item.occurredAt)}
              </span>
            )}
          </div>
        </div>

        {(learningSummary || !import.meta.env.VITE_SHADOW_WEB) && <p className="watched-card-summary" title={learningSummary}>
          {learningSummary || <span className="watched-summary-empty">{t("AI 学习介绍待生成")}</span>}
        </p>}

        <div className="watched-card-footer">
          <div className="watched-card-tags">
            {coverage ? (
              <span className={`watched-tag coverage ${coverage.tone}`} title={t("词汇覆盖度：{0}%（{1}）", coverage.percent, coverage.label)}>
                {t("覆盖度")}{coverage.percent}% · {coverage.label}
              </span>
            ) : (
              <span className="watched-tag coverage pending" title={t("播放并加载字幕后可计算覆盖度")}>
                {t("覆盖度待计算")}</span>
            )}
            {analysis?.aiAssessment?.cefrLevel && (
              <span className="watched-tag cefr">{analysis.aiAssessment.cefrLevel}</span>
            )}
            {analysis?.speedMetrics?.activeWpm != null && (
              <span className="watched-tag wpm">{Math.round(analysis.speedMetrics.activeWpm)} {t("词/分")}</span>
            )}
            {topics.slice(0, 1).map((topic) => (
              <span key={topic} className="watched-tag topic">{topicLabel(topic)}</span>
            ))}
          </div>

          <div className="watched-card-actions">
            <Suspense fallback={null}><StudyDocumentButtons corpus={{ videoKey, title: item.title || videoKey, ...(item.durationMs ? { durationMs: item.durationMs } : {}) }} /></Suspense>
            <a className="watched-play-btn" href={playUrl} target={import.meta.env.VITE_SHADOW_WEB ? undefined : '_blank'} rel="noreferrer">
              {resumeMs ? <>{t("继续观看")}<Icon name="external" /></> : <>{t("再次观看")}<Icon name="external" /></>}
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}

function CorpusLibrary({ signedIn, progressItems, videoAnalyses, vocabularySize, localFrequencyCoverage, refreshLocal, heading = t("我看过的"), countUnit = t("个视频"), resolveWatchedCover }: { signedIn: boolean; progressItems: LocalProgress[]; videoAnalyses: Record<string, VideoAnalysis>; vocabularySize: number; localFrequencyCoverage: Record<string, { objective: VocabularyFrequencyCoverage; personal: CoverageBand }>; refreshLocal: () => Promise<void>; heading?: string; countUnit?: string; resolveWatchedCover?: ((item: LocalProgress) => Promise<string | undefined>) | undefined }) {
  const [query, setQuery] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const filtered = progressItems.filter((item) => {
    const key = videoKeyOf(item);
    const analysis = videoAnalyses[key] || item.analysis;
    const topics = (analysis?.aiAssessment?.topics || []).flatMap((topic) => [topic, topicLabel(topic)]);
    const text = [item.title || key, item.channelTitle || '', ...topics].join(' ').toLocaleLowerCase();
    return text.includes(query.trim().toLocaleLowerCase());
  });
  const hasFilters = Boolean(query.trim());

  const syncNow = async () => {
    setSyncing(true); setNotice('');
    try {
      if (signedIn && !import.meta.env.VITE_SHADOW_WEB) {
        await sendRuntime({ type: 'SYNC_NOW' });
        await sendRuntime({ type: 'VIDEO_INSIGHTS_REFRESH' });
      }
      await refreshLocal();
      setNotice(t("观看记录已刷新。"));
    } catch (cause) { setNotice(displayError(cause, t("刷新失败，请稍后重试。"))); }
    finally { setSyncing(false); }
  };

  return <section className="corpus-page watched-corpus-page">
    <div className="watched-header">
      <div className="watched-header-left">
        <h1 className="watched-title">{heading}</h1>
        <span className="watched-count-badge">
          {hasFilters ? t("找到 {0} {1}", filtered.length, countUnit) : t("共 {0} {1}", progressItems.length, countUnit)}
        </span>
      </div>
      <div className="watched-header-right">
        <div className="watched-search-box">
          <span className="watched-search-icon" aria-hidden="true"><Icon name="search" /></span>
          <input
            value={query}
            placeholder={t("搜索看过的标题、频道…")}
            aria-label={t("搜索我看过的")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {hasFilters && (
            <button
              type="button"
              className="watched-search-clear"
              onClick={() => setQuery('')}
              title={t("清除搜索")}
              aria-label={t("清除搜索")}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
        <button
          type="button"
          className="watched-refresh-btn"
          disabled={syncing}
          onClick={() => void syncNow()}
          title={t("刷新观看记录")}
        >
          <span className={syncing ? 'spinning' : ''} aria-hidden="true"><Icon name="refresh" /></span>
          <span>{syncing ? t("刷新中…") : t("刷新记录")}</span>
        </button>
      </div>
    </div>
    {notice && <p className="corpus-feedback" role="status">{notice}</p>}
    <div className="watched-list">
      {filtered.length ? (
        filtered.map((item) => {
          const key = videoKeyOf(item);
          return (
            <WatchedCard
              key={item.id || key}
              item={item}
              analysis={videoAnalyses[key] || (item.id ? videoAnalyses[item.id] : undefined) || item.analysis}
              localCoverage={localFrequencyCoverage[key] || (item.id ? localFrequencyCoverage[item.id] : undefined)}
              vocabularySize={vocabularySize}
              resolveWatchedCover={resolveWatchedCover}
            />
          );
        })
      ) : (
        <div className="corpus-empty">
          <span className="corpus-empty-icon"><Icon name="history" /></span>
          <h2>{hasFilters ? t("没有找到符合条件的观看记录") : t("还没有观看记录")}</h2>
          {(!import.meta.env.VITE_SHADOW_WEB || hasFilters) && <p>{hasFilters ? t("试试其他关键词，或清除搜索。") : t("播放 YouTube 或 B 站视频后，学习进度会自动记录在这里。")}</p>}
          {hasFilters ? (
            <button onClick={() => setQuery('')}>{t("清除搜索")}</button>
          ) : (
            <button onClick={() => { location.hash = 'public-corpus'; }}>{t("去语料库找视频")}</button>
          )}
        </div>
      )}
    </div>
  </section>;
}

function TodayRecommendations({ vocabularySize }: { vocabularySize: number }) {
  const [ladders, setLadders] = useState<Record<RecommendKind, MediaCorpusRecommendResponse | null>>({ video: null, audio: null });
  const [offsets, setOffsets] = useState<Record<RecommendKind, number>>({ video: 0, audio: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void Promise.all([
      fetchDifficultyLadder('video', vocabularySize),
      fetchDifficultyLadder('audio', vocabularySize),
    ]).then(([video, audio]) => {
      if (!alive) return;
      setLadders({ video, audio });
      setOffsets({ video: video?.fitStart ?? 0, audio: audio?.fitStart ?? 0 });
    }).catch(() => undefined).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [vocabularySize]);

  const shift = (kind: RecommendKind, direction: 'easier' | 'harder') => {
    setOffsets((current) => ({ ...current, [kind]: shiftRecommendationWindow(ladders[kind], current[kind], direction) }));
  };
  const groups: Array<{ kind: RecommendKind; label: string }> = [
    { kind: 'audio', label: t("音频") },
    { kind: 'video', label: t("视频") },
  ];
  const anyItem = groups.some(({ kind }) => recommendationWindow(ladders[kind], offsets[kind]).length > 0);

  if (loading && !anyItem) {
    return <section className="today-recommend" aria-label={t("为你推荐")} aria-busy="true">
      <header className="today-recommend-header"><h2>{t("为你推荐")}</h2><p role="status">{t("正在按你的词汇量挑选语料…")}</p></header>
      {groups.map(({ kind, label }) => <div className="today-recommend-group" key={kind}>
        <header className="today-recommend-group-header"><h3>{label}</h3><span style={{ height: 32 }} aria-hidden="true" /></header>
        <div className="today-recommend-grid" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <div className="today-recommend-card" key={index}>
          <span className="today-recommend-cover" /><span className="today-recommend-copy"><strong>&nbsp;<br />&nbsp;</strong><small>&nbsp;</small><span className="today-recommend-difficulty">&nbsp;</span></span>
        </div>)}</div>
      </div>)}
    </section>;
  }
  if (!anyItem) return null;

  return <section className="today-recommend" aria-label={t("为你推荐")}>
    <header className="today-recommend-header">
      <div>
        <h2>{t("为你推荐")}</h2>
        <p>{t("按你的词汇量挑的 5 条。推荐只是起点——觉得偏难或偏易，换一批就好。")}</p>
      </div>
    </header>
    {groups.map(({ kind, label }) => {
      const ladder = ladders[kind];
      const items = recommendationWindow(ladder, offsets[kind]);
      if (!items.length) return null;
      const target = ladder?.target;
      return <div className="today-recommend-group" key={kind}>
        <header className="today-recommend-group-header">
          <h3>{label}</h3>
          {typeof target === 'number' && <span className="today-recommend-target">{t("目标难度")}{target.toFixed(1)}{ladder?.band ? ` · ${ladder.band}` : ''}</span>}
          <div className="today-recommend-actions">
            <button type="button" onClick={() => shift(kind, 'easier')} disabled={!canShiftWindow(ladder, offsets[kind], 'easier')}>{t("更简单")}</button>
            <button type="button" onClick={() => shift(kind, 'harder')} disabled={!canShiftWindow(ladder, offsets[kind], 'harder')}>{t("更难")}</button>
          </div>
        </header>
        <div className="today-recommend-grid">
          {items.map((item) => <a className="today-recommend-card" href={recommendMediaRoute(item)} key={item.id}>
            <span className="today-recommend-cover">
              {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <span aria-hidden="true">{kind === 'audio' ? '♫' : '▶'}</span>}
              {item.durationMs ? <span className="today-recommend-duration">{formatTime(item.durationMs)}</span> : null}
            </span>
            <span className="today-recommend-copy">
              <strong>{item.titleZh || item.title}</strong>
              {item.seriesTitle ? <small>{item.seriesTitle}</small> : null}
            </span>
            <span className="today-recommend-difficulty">{t("难度")}{item.difficulty.toFixed(1)}{item.sourceLevel ? ` · ${item.sourceLevel}` : ''}</span>
          </a>)}
        </div>
      </div>;
    })}
  </section>;
}

function TodayOverview({ signedIn, progressItems, videoAnalyses, vocabularySize, localFrequencyCoverage, refreshLocal, bookRecommendations, resolveWatchedCover }: { signedIn: boolean; progressItems: LocalProgress[]; videoAnalyses: Record<string, VideoAnalysis>; vocabularySize: number; localFrequencyCoverage: Record<string, { objective: VocabularyFrequencyCoverage; personal: CoverageBand }>; refreshLocal: () => Promise<void>; bookRecommendations?: React.ReactNode; resolveWatchedCover?: ((item: LocalProgress) => Promise<string | undefined>) | undefined }) {
  return <section className="today-overview" aria-label={t("今日学习")}>
    <a className="today-vocabulary" href="#vocabulary-test" aria-labelledby="today-vocabulary-title" aria-describedby="today-vocabulary-action">
      <div className="today-vocabulary-copy"><h1 id="today-vocabulary-title">{t("我的词汇量")}</h1><strong>{vocabularyThresholdLabel(vocabularySize)}</strong></div>
      <span className="today-vocabulary-action" id="today-vocabulary-action">{t("查看测评结果")}<span aria-hidden="true">→</span></span>
    </a>
    {bookRecommendations}
    <TodayRecommendations vocabularySize={vocabularySize} />
    <CorpusLibrary signedIn={signedIn} progressItems={progressItems} videoAnalyses={videoAnalyses} vocabularySize={vocabularySize} localFrequencyCoverage={localFrequencyCoverage} refreshLocal={refreshLocal} heading={t("看过的语料")} countUnit={t("条语料")} resolveWatchedCover={resolveWatchedCover} />
  </section>;
}

function CorpusCard({ entry, vocabularySize, mode = 'public', personalCoverage }: { entry: CorpusEntry; vocabularySize: number; mode?: 'watched' | 'public'; personalCoverage?: CoverageBand }) {
  const analysis = entry.analysis;
  const topics = entryTopics(entry);
  const recommendation = analysis?.recommendedVocabulary;
  const match = vocabularyMatch(recommendation, vocabularySize);
  const resumeMs = mode === 'watched' && entry.positionMs && (!entry.durationMs || entry.positionMs < entry.durationMs - 3000) ? entry.positionMs : 0;
  const playUrl = learningUrl(videoKeyOf(entry), resumeMs);
  return <article className={`corpus-card ${mode}`}>
    <a className="corpus-thumbnail-link" href={playUrl} target={import.meta.env.VITE_SHADOW_WEB ? undefined : '_blank'} rel="noreferrer" aria-label={`${resumeMs ? t("继续观看") : t("观看")} ${entry.title}`}><img className="corpus-thumbnail" src={videoThumbnail(entry)} alt="" loading="lazy" />{entry.durationMs ? <span className="corpus-duration">{formatTime(entry.durationMs)}</span> : null}</a>
    <div className="corpus-card-main">
      <div className="corpus-card-title"><a href={playUrl} target={import.meta.env.VITE_SHADOW_WEB ? undefined : '_blank'} rel="noreferrer">{entry.title}</a></div>
      <p className="corpus-card-meta">{entry.channelTitle || t("频道信息暂缺")}{entry.hasSubtitles ? t("· 中英字幕") : ''}{mode === 'watched' && entry.lastWatchedAt ? t(" · 上次观看 {0}", new Date(entry.lastWatchedAt).toLocaleString()) : ''}{mode === 'watched' && entry.positionMs ? t(" · 看到 {0}", formatTime(entry.positionMs)) : ''}</p>
      {analysis?.learningSummaryZh && <p className="corpus-analysis-summary">{analysis.learningSummaryZh}</p>}
      {analysis && <div className="corpus-facts">
        {recommendation && <span><b>{vocabularyTierForSize(recommendation.threshold).label}{!recommendation.reachable ? '+' : ''}</b> {t("推荐词汇量")}</span>}
        {analysis.activeWpm != null && <span><b>{Math.round(analysis.activeWpm)} {t("词/分钟")}</b> {t("语速")}</span>}
        {analysis.cefrLevel && <span><b>{analysis.cefrLevel}</b> {t("英语等级")}</span>}
      </div>}
      {analysis?.vocabularyCoverage && <VocabularyCoverageSummary coverage={analysis.vocabularyCoverage} {...(personalCoverage ? { personal: personalCoverage } : {})} />}
      {mode === 'public' && <div className="corpus-personal-fit"><span className={`corpus-fit-badge ${match === 'within' ? 'suitable' : match === 'above' ? 'challenging' : ''}`}>{match === 'within' ? t("在你的词汇量范围内") : match === 'above' ? t("词汇有挑战") : t("词汇难度待补充")}</span><span>{match === 'within' ? t("可以先试着看一小段，再决定是否继续。") : match === 'above' ? t("建议先开字幕观看，遇到生词随时查。") : t("先参考英语等级和语速选择。")}</span></div>}
      {topics.length > 0 && <div className="corpus-categories">{topics.map((topic) => <span key={topic}>{topicLabel(topic)}</span>)}{analysis?.register && <small>{registerLabel(analysis.register)}</small>}</div>}
      {analysis && <details className="corpus-details"><summary>{t("查看分析依据")}</summary>
        {recommendation && <p>{t("推荐词汇量按 SUBTLEX-US 字幕词频估算：达到约")}{recommendation.reachable ? recommendation.targetCoveragePercent : recommendation.coveragePercent}{t("% 的字幕词次即可开始用字幕练习。它不是“听懂门槛”；下方 3k / 5k / 10k 覆盖率用于判断继续学习会有多顺。")}</p>}
        {analysis && <p>{entry.hasSubtitles ? t("词汇与语速按导入字幕估算，主题由人工整理。") : t("主题、英语等级由 DeepSeek 分析。英语等级从 A1 到 C2 逐渐变难；语速按字幕时间估算。")}{analysis.lemmaCount != null ? t("这段字幕约含 {0} 个不重复词，不代表需要掌握的词汇量。", analysis.lemmaCount) : ''}</p>}
      </details>}
    </div>
    <div className="corpus-card-actions"><StudyDocumentButtons corpus={{ videoKey: videoKeyOf(entry), title: entry.title, ...(entry.durationMs ? { durationMs: entry.durationMs } : {}) }} /><a className="corpus-open" href={playUrl} target={import.meta.env.VITE_SHADOW_WEB ? undefined : '_blank'} rel="noreferrer">{import.meta.env.VITE_SHADOW_WEB ? (resumeMs ? t("继续学习") : t("开始学习")) : mode === 'public' ? (entry.videoKey ? <>{t("去 B 站学习")}<Icon name="external" /></> : <>{t("去 YouTube 观看")}<Icon name="external" /></>) : resumeMs ? <>{t("继续观看")}<Icon name="external" /></> : <>{t("再次观看")}<Icon name="external" /></>}</a></div>
  </article>;
}

const VOCABULARY_SOURCE_INFO = {
  subtlex: { label: 'SUBTLEX-US', description: t("基于电影和电视剧字幕的英语词频表。这里的 3k / 5k / 10k 表示按词频排名取前 N 个词，用来估算字幕词汇覆盖率。"), url: 'https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus/overview.htm' },
  ngslS: { label: 'NGSL-S', description: t("New General Service List Spoken，面向日常口语交流的高频词表，用来观察字幕中常用口语词的覆盖情况。"), url: 'https://www.newgeneralservicelist.com/ngsl-spoken' },
  ngsl: { label: 'NGSL', description: t("New General Service List，面向一般英语文本的通用高频词表，用来观察常见英语词的覆盖情况。"), url: 'https://www.newgeneralservicelist.com/ngsl' },
  ngslGr: { label: 'NGSL-GR', description: t("面向分级读物的 New General Service List 词表，用来观察更适合阅读材料的常用词覆盖情况。"), url: 'https://www.newgeneralservicelist.com/ngsl-graded-reader' },
} as const;

function VocabularySourceHint({ source }: { source: keyof typeof VOCABULARY_SOURCE_INFO }) {
  const info = VOCABULARY_SOURCE_INFO[source];
  const tooltipId = `vocabulary-source-${source}`;
  return <span className="corpus-vocabulary-source">
    <button type="button" className="corpus-vocabulary-source-trigger" aria-describedby={tooltipId}>{info.label}</button>
    <span id={tooltipId} className="corpus-vocabulary-source-tooltip" role="tooltip"><strong>{info.label}</strong><span>{info.description}</span><a href={info.url} target="_blank" rel="noreferrer">{t("查看官方说明")}<Icon name="external" /></a></span>
  </span>;
}

function VocabularyCoverageSummary({ coverage, personal }: { coverage: VideoVocabularyCoverage; personal?: CoverageBand }) {
  const subtlex = coverage.subtlex.filter((band) => [3_000, 5_000, 10_000].includes(band.size));
  return <div className="corpus-vocabulary-coverage" aria-label={t("多套词表字幕词次覆盖率")}>
    <span><VocabularySourceHint source="subtlex" /> {subtlex.map((band) => `${band.size / 1000}k ${band.coveragePercent}%`).join(' · ')}</span>
    <span><VocabularySourceHint source="ngslS" /> {coverage.ngslS.coveragePercent}% · <VocabularySourceHint source="ngsl" /> {coverage.ngsl.coveragePercent}% · <VocabularySourceHint source="ngslGr" /> {coverage.ngslGr.coveragePercent}%</span>
    {personal && <span><b>{t("我的词汇量")}</b> {personal.coveragePercent}%</span>}
  </div>;
}

type PublicCorpusItem = Omit<CorpusEntry, 'key'> & { _id: string; channel?: string | null };
type PublicCorpusCollection = {
  _id?: string;
  seriesId: string;
  seriesTitle: string;
  platform: 'youtube' | 'bilibili';
  channelId?: string | null;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  episodeCount: number;
  seasonCount: number;
  latestUpdated: string | null;
  collectionType?: 'series' | 'channel' | 'video';
  learningSummaryZh?: string | null;
  minRecommendedVocabulary?: number | null;
  maxRecommendedVocabulary?: number | null;
};
type PublicCorpusCollectionsResponse = { items: PublicCorpusCollection[]; total: number; nextCursor: number | null };
type PublicCorpusEpisodesResponse = { items: PublicCorpusItem[]; total: number; nextCursor: number | null };
type PublicCorpusFacets = { categories: string[]; registers: string[]; channels: Array<{ id: string | null; title: string }> };
type PublicCorpusFacetsResponse = { facets: PublicCorpusFacets };
const EMPTY_PUBLIC_CORPUS_FACETS: PublicCorpusFacets = { categories: [], registers: [], channels: [] };
function rangeBounds(range: string): { min?: number; max?: number } {
  if (range === 'all') return {};
  if (range.endsWith('+')) return { min: Number(range.slice(0, -1)) };
  const [min, max] = range.split('-').map(Number);
  return { ...(Number.isFinite(min) ? { min } : {}), ...(Number.isFinite(max) ? { max } : {}) };
}
function publicCorpusRequest(query: string, filters: CorpusFilters, cursor: number, vocabularySize?: number): PublicCorpusFilterInput {
  const speed = rangeBounds(filters.speed);
  return {
    query: query.trim(),
    ...(filters.category !== 'all' ? { category: filters.category } : {}),
    ...(filters.register !== 'all' ? { register: filters.register } : {}),
    ...(filters.channel !== 'all' ? { channel: filters.channel } : {}),
    ...(filters.difficulty !== 'all' ? { difficultyBand: filters.difficulty as PublicCorpusFilterInput['difficultyBand'] } : {}),
    ...(vocabularySize ? { maxRecommendedVocabulary: vocabularySize } : {}),
    ...(speed.min !== undefined ? { minActiveWpm: speed.min } : {}),
    ...(speed.max !== undefined ? { maxActiveWpm: speed.max } : {}), cursor, limit: 30,
  };
}
function PublicCorpusLibrary({ vocabularySize, onVocabularySizeChange }: { vocabularySize: number; onVocabularySizeChange: (size: number) => void }) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<CorpusFilters>(EMPTY_CORPUS_FILTERS);
  const [forMe, setForMe] = useState(true);
  const [collections, setCollections] = useState<PublicCorpusCollection[]>([]);
  const [collectionTotal, setCollectionTotal] = useState(0);
  const [collectionCursor, setCollectionCursor] = useState<number | null>(null);
  const [facets, setFacets] = useState<PublicCorpusFacets>(EMPTY_PUBLIC_CORPUS_FACETS);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const generation = useRef(0);
  // Invalidate pagination as soon as controls change, before a deferred effect runs.
  const searchKey = JSON.stringify([query, filters, forMe, vocabularySize, refreshKey]);
  const currentSearchKey = useRef(searchKey);
  currentSearchKey.current = searchKey;
  useEffect(() => {
    let alive = true;
    void sendRuntime<PublicCorpusFacetsResponse>({ type: 'PUBLIC_CORPUS_FACETS' })
      .then((result) => { if (alive) setFacets(result.facets); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [refreshKey]);
  useEffect(() => {
    const version = ++generation.current;
    setLoadingMore(false); setError(''); setLoading(true);
    setSelectedSeriesId(null);
    setCollections([]); setCollectionTotal(0); setCollectionCursor(null);
    const timer = window.setTimeout(() => {
      void sendRuntime<PublicCorpusCollectionsResponse>({ type: 'PUBLIC_CORPUS_COLLECTIONS_LIST', filters: publicCorpusRequest(query, filters, 0, forMe ? vocabularySize : undefined) })
        .then((next) => { if (version === generation.current) { setCollections(next.items); setCollectionTotal(next.total); setCollectionCursor(next.nextCursor); } })
        .catch((cause) => { if (version === generation.current) setError(displayError(cause, t("暂时无法加载视频，请稍后重试。"))); })
        .finally(() => { if (version === generation.current) setLoading(false); });
    }, 220);
    return () => { generation.current += 1; window.clearTimeout(timer); };
  }, [searchKey]);
  const loadMore = async () => {
    if (collectionCursor == null || loading || loadingMore) return;
    const key = searchKey;
    setLoadingMore(true); setError('');
    try {
      const next = await sendRuntime<PublicCorpusCollectionsResponse>({ type: 'PUBLIC_CORPUS_COLLECTIONS_LIST', filters: publicCorpusRequest(query, filters, collectionCursor, forMe ? vocabularySize : undefined) });
      if (key === currentSearchKey.current) { setCollections((current) => [...current, ...next.items]); setCollectionTotal(next.total); setCollectionCursor(next.nextCursor); }
    } catch (cause) { if (key === currentSearchKey.current) setError(displayError(cause, t("更多视频加载失败，请重试。"))); }
    finally { if (key === currentSearchKey.current) setLoadingMore(false); }
  };
  const clearFilters = () => { setQuery(''); setFilters(EMPTY_CORPUS_FILTERS); setForMe(false); };
  const hasFilters = Boolean(query.trim()) || forMe || Object.values(filters).some((value) => value !== 'all');
  const countBadgeText = loading
    ? t("正在查找…")
    : error && !collections.length
    ? t("查询未完成")
    : hasFilters
    ? t("找到 {0} 个集合{1}", collectionTotal, collectionCursor != null ? `（已显示 ${collections.length} 个）` : '')
    : t("共 {0} 个集合", collectionTotal);
  return <section className="corpus-page public-corpus-page">
    {!selectedSeriesId && (
      <>
        <div className="public-corpus-header">
          <div className="public-corpus-header-left">
            <h1 className="public-corpus-title">{t("语料库")}</h1>
            <span className="public-corpus-count-badge" role="status">
              {countBadgeText}
            </span>
          </div>
          <div className="public-corpus-header-right">
            <div className="public-corpus-search-box">
              <span className="public-corpus-search-icon" aria-hidden="true"><Icon name="search" /></span>
              <input
                value={query}
                maxLength={200}
                placeholder={t("搜索标题、频道或主题…")}
                aria-label={t("搜索语料库")}
                onChange={(event) => setQuery(event.target.value)}
              />
              {Boolean(query.trim()) && (
                <button
                  type="button"
                  className="public-corpus-search-clear"
                  onClick={() => setQuery('')}
                  title={t("清除搜索")}
                  aria-label={t("清除搜索")}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
            <button
              type="button"
              className="public-corpus-refresh-btn"
              disabled={loading || loadingMore}
              onClick={() => setRefreshKey((key) => key + 1)}
              title={t("刷新视频")}
            >
              <span className={loading || loadingMore ? 'spinning' : ''} aria-hidden="true"><Icon name="refresh" /></span>
              <span>{loading ? t("刷新中…") : t("刷新")}</span>
            </button>
          </div>
        </div>
        <div className="public-corpus-filters" aria-label={t("语料库筛选条件")}>
          <label className={`public-filter-item ${filters.category !== 'all' ? 'active' : ''}`}>
            <span className="public-filter-label">{t("主题")}</span>
            <select
              value={filters.category}
              onChange={(event) => setFilters({ ...filters, category: event.target.value })}
            >
              <option value="all">{t("全部主题")}</option>
              {facets.categories.map((category) => (
                <option key={category} value={category}>{topicLabel(category)}</option>
              ))}
            </select>
          </label>
          <label className={`public-filter-item ${forMe ? 'active' : ''}`}>
            <span className="public-filter-label">{t("词汇量")}</span>
            <select
              aria-label={t("语料库词汇量筛选")}
              value={forMe ? String(vocabularySize) : 'all'}
              onChange={(event) => {
                const value = event.target.value;
                setForMe(value !== 'all');
                if (value !== 'all') onVocabularySizeChange(Number(value));
              }}
            >
              <option value="all">{t("不限词汇量")}</option>
              {VOCABULARY_TIERS.map((tier) => (
                <option key={tier.rank} value={tier.rank}>{t("不高于")}{tier.label}（{tier.rank.toLocaleString()} {t("词）")}</option>
              ))}
            </select>
          </label>
          <label className={`public-filter-item ${filters.speed !== 'all' ? 'active' : ''}`}>
            <span className="public-filter-label">{t("语速")}</span>
            <select
              value={filters.speed}
              onChange={(event) => setFilters({ ...filters, speed: event.target.value })}
            >
              {SPEED_RANGES.map((range) => (
                <option key={range.value} value={range.value}>{range.label}</option>
              ))}
            </select>
          </label>
          <label className={`public-filter-item ${filters.register !== 'all' ? 'active' : ''}`}>
            <span className="public-filter-label">{t("表达方式")}</span>
            <select
              value={filters.register}
              onChange={(event) => setFilters({ ...filters, register: event.target.value })}
            >
              <option value="all">{t("全部表达方式")}</option>
              {facets.registers.map((register) => (
                <option key={register} value={register}>{registerLabel(register)}</option>
              ))}
            </select>
          </label>
          <label className={`public-filter-item ${filters.channel !== 'all' ? 'active' : ''}`}>
            <span className="public-filter-label">{t("频道")}</span>
            <select
              value={filters.channel}
              onChange={(event) => setFilters({ ...filters, channel: event.target.value })}
            >
              <option value="all">{t("全部频道")}</option>
              {facets.channels.map((channel) => (
                <option key={channel.id || channel.title} value={channel.id || channel.title}>{channel.title}</option>
              ))}
            </select>
          </label>
          {hasFilters && (
            <button
              type="button"
              className="public-corpus-clear-filters"
              onClick={clearFilters}
            >
              {t("清除筛选")}</button>
          )}
        </div>
      </>
    )}
    {error && <div className="corpus-error" role="alert">{error}<button onClick={() => collections.length ? void loadMore() : setRefreshKey((key) => key + 1)}>{t("重试")}</button></div>}
    <div className="corpus-list" aria-busy={loading || loadingMore}>
      {loading ? <p className="empty-inline">{t("正在查找符合条件的视频…")}</p> : selectedSeriesId ? <PublicSeriesDetail collection={collections.find((item) => item.seriesId === selectedSeriesId)} filters={publicCorpusRequest(query, filters, 0, forMe ? vocabularySize : undefined)} onBack={() => setSelectedSeriesId(null)} /> : collections.length ? <div className="corpus-series-wall">{collections.map((collection) => <PublicSeriesCard key={collection.seriesId} collection={collection} onOpen={() => setSelectedSeriesId(collection.seriesId)} />)}</div> : !error && <div className="corpus-empty"><span className="corpus-empty-icon"><Icon name="grid" /></span><h2>{hasFilters ? t("暂时没有符合条件的视频") : t("语料库还在积累中")}</h2><p>{hasFilters ? t("试试放宽词汇量或主题条件。还没有推荐词汇量的视频，可以在“不限词汇量”中查看。") : t("频道批量导入并完成分析后，视频会加入这里。你也可以先去 YouTube 看自己感兴趣的英文内容。")}</p>{hasFilters ? <button onClick={clearFilters}>{t("查看全部视频")}</button> : <a href="https://www.youtube.com/" target="_blank" rel="noreferrer">{t("去 YouTube 找视频")}<Icon name="external" /></a>}</div>}
    </div>
    {collectionCursor != null && !selectedSeriesId && !loading && <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t("加载中…") : t("加载更多集合")}</button>}
  </section>;
}

function PublicSeriesCard({ collection, onOpen }: { collection: PublicCorpusCollection; onOpen: () => void }) {
  const minRecommendation = collection.minRecommendedVocabulary ?? null;
  const maxRecommendation = collection.maxRecommendedVocabulary ?? null;
  return <article
    className="corpus-series-card"
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen();
      }
    }}
    aria-label={t("查看剧集 {0}", collection.seriesTitle)}
  >
    <div className="corpus-series-cover">
      {collection.thumbnailUrl ? <img src={collection.thumbnailUrl} referrerPolicy="no-referrer" alt="" loading="lazy" /> : <div className="corpus-series-cover-empty">SL</div>}
      <span className="corpus-series-cover-shade" />
      <span className="corpus-series-cover-top"><span>{collection.platform === 'bilibili' ? t("B 站剧集") : collection.collectionType === 'channel' ? t("YouTube 频道") : t("视频系列")}</span><span>{collection.seasonCount ? t("{0} 季", collection.seasonCount) : t("精选")}</span></span>
      <span className="corpus-series-cover-copy"><strong>{collection.seriesTitle}</strong><small>{collection.episodeCount} {t("集已收录")}</small></span>
    </div>
    <div className="corpus-series-card-body">
      <div className="corpus-series-heading"><span className="corpus-series-kicker">{collection.channelTitle || t("语料库")}</span><h2>{collection.seriesTitle}</h2></div>
      <div className="corpus-series-meta"><span>{collection.seasonCount ? t("{0} 季", collection.seasonCount) : collection.collectionType === 'channel' ? t("频道合集") : t("单集视频")}</span><span>{collection.episodeCount} {t("集")}</span>{minRecommendation != null && <span>{t("推荐词汇量")}{vocabularyTierForSize(minRecommendation).label}{maxRecommendation && maxRecommendation !== minRecommendation ? `–${vocabularyTierForSize(maxRecommendation).label}` : ''}</span>}</div>
      {collection.learningSummaryZh && <p className="corpus-series-summary">{collection.learningSummaryZh}</p>}
    </div>
  </article>;
}

function PublicSeriesDetail({ collection, filters, onBack }: { collection?: PublicCorpusCollection | undefined; filters: PublicCorpusFilterInput; onBack: () => void }) {
  const [episodes, setEpisodes] = useState<PublicCorpusItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null);
  const requestKey = JSON.stringify([collection?.seriesId, filters]);
  useEffect(() => {
    if (!collection) return;
    let alive = true;
    setEpisodes([]); setCursor(0); setSeasonNumber(null); setError(''); setLoading(true);
    void sendRuntime<PublicCorpusEpisodesResponse>({ type: 'PUBLIC_CORPUS_EPISODES_LIST', filters: { ...filters, seriesId: collection.seriesId, cursor: 0, limit: 30 } })
      .then((result) => { if (alive) { setEpisodes(result.items); setCursor(result.nextCursor); setSeasonNumber(result.items[0]?.seasonNumber ?? null); } })
      .catch((cause) => { if (alive) setError(displayError(cause, t("暂时无法加载剧集内容，请稍后重试。"))); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [requestKey, collection?.seriesId]);
  if (!collection) return <div className="corpus-empty"><h2>{t("剧集已更新")}</h2><button onClick={onBack}>{t("返回剧集墙")}</button></div>;
  const seasons = [...new Set(episodes.map((episode) => episode.seasonNumber ?? null))]
    .sort((left, right) => (left ?? 0) - (right ?? 0))
    .map((number) => ({ seasonNumber: number, episodes: episodes.filter((episode) => (episode.seasonNumber ?? null) === number) }));
  const activeSeason = seasons.find((item) => item.seasonNumber === seasonNumber) || seasons[0];
  const loadMore = async () => {
    if (cursor == null || loading || loadingMore) return;
    setLoadingMore(true); setError('');
    try {
      const next = await sendRuntime<PublicCorpusEpisodesResponse>({ type: 'PUBLIC_CORPUS_EPISODES_LIST', filters: { ...filters, seriesId: collection.seriesId, cursor, limit: 30 } });
      setEpisodes((current) => [...current, ...next.items]); setCursor(next.nextCursor);
    } catch (cause) { setError(displayError(cause, t("更多剧集内容加载失败，请重试。"))); }
    finally { setLoadingMore(false); }
  };
  return <section className="corpus-series-detail">
    <button type="button" className="corpus-back-link" onClick={onBack}><Icon name="arrow-left" /> {t("返回剧集墙")}</button>
    <header className="corpus-series-detail-header">
      {collection.thumbnailUrl && <img src={collection.thumbnailUrl} referrerPolicy="no-referrer" alt="" />}
      <div><span className="corpus-series-kicker">{collection.platform === 'bilibili' ? t("B 站公共语料") : collection.collectionType === 'channel' ? t("YouTube 频道") : t("公共语料系列")}</span><h2>{collection.seriesTitle}</h2><p>{collection.seasonCount ? t("{0} 季 · ", collection.seasonCount) : ''}{collection.episodeCount} {t("集")}</p>{collection.learningSummaryZh && <div className="corpus-series-detail-summary"><span>{t("AI 学习总览")}</span>{collection.learningSummaryZh}</div>}</div>
    </header>
    {seasons.length > 1 && <div className="corpus-season-tabs" role="tablist" aria-label={t("选择季数")}>{seasons.map((item) => <button key={item.seasonNumber ?? 'special'} type="button" role="tab" aria-selected={item.seasonNumber === activeSeason?.seasonNumber} className={item.seasonNumber === activeSeason?.seasonNumber ? 'active' : ''} onClick={() => setSeasonNumber(item.seasonNumber)}>{item.seasonNumber ? t("第{0}季", item.seasonNumber) : t("特别篇")}<small>{item.episodes.length} {t("集")}</small></button>)}</div>}
    {error && <div className="corpus-error" role="alert">{error}</div>}
    {loading ? <p className="empty-inline">{t("正在加载剧集内容…")}</p> : <><div className="corpus-season-heading"><div><span>{t("正在学习")}</span><h3>{activeSeason?.seasonNumber ? t("第{0}季", activeSeason.seasonNumber) : t("单集")}</h3></div><small>{activeSeason?.episodes.length || 0}{cursor != null ? ` / ${collection.episodeCount}` : ''} {t("集")}</small></div><div className="corpus-episode-wall">{activeSeason?.episodes.map((episode) => <PublicEpisodeCard key={videoKeyOf(episode)} entry={episode} />)}</div>{cursor != null && <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t("加载中…") : t("加载更多剧集")}</button>}</>}
  </section>;
}

function PublicEpisodeCard({ entry }: { entry: PublicCorpusItem }) {
  const recommendation = entry.analysis?.recommendedVocabulary;
  const episodeLabel = entry.seasonNumber && entry.episodeNumber ? `S${String(entry.seasonNumber).padStart(2, '0')}E${String(entry.episodeNumber).padStart(2, '0')}` : entry.episodeNumber ? t("第{0}集", entry.episodeNumber) : t("单集");
  const playUrl = learningUrl(entry.videoKey || entry.youtubeId || '', 0);
  return <article className="corpus-episode-card">
    <a className="corpus-card-stretched-link" href={playUrl} target={import.meta.env.VITE_SHADOW_WEB ? undefined : '_blank'} rel="noreferrer" aria-label={t("去学习 {0}", entry.episodeTitle || entry.title)} />
    <div className="corpus-episode-cover"><img src={entry.thumbnailUrl || undefined} referrerPolicy="no-referrer" alt="" loading="lazy" decoding="async" /><span className="corpus-episode-number">{episodeLabel}</span>{entry.durationMs ? <span className="corpus-duration">{formatTime(entry.durationMs)}</span> : null}</div>
    <div className="corpus-episode-copy"><span className="corpus-series-kicker">{entry.platform === 'bilibili' ? t("中英字幕") : t("英文字幕")}</span><h3>{entry.episodeTitle || entry.title}</h3>{entry.analysis?.learningSummaryZh && <p className="corpus-episode-summary"><span>{t("AI 学习介绍")}</span>{entry.analysis.learningSummaryZh}</p>}<div className="corpus-episode-facts">{recommendation && <span>{t("推荐词汇量")}{vocabularyTierForSize(recommendation.threshold).label}</span>}{entry.analysis?.activeWpm != null && <span>{Math.round(entry.analysis.activeWpm)} {t("词/分钟")}</span>}</div>{entry.analysis?.vocabularyCoverage && <VocabularyCoverageSummary coverage={entry.analysis.vocabularyCoverage} />}<div className="corpus-episode-actions" onClick={(e) => e.stopPropagation()}><StudyDocumentButtons corpus={{ videoKey: videoKeyOf(entry), title: entry.title, ...(entry.durationMs ? { durationMs: entry.durationMs } : {}) }} /></div></div>
  </article>;
}

function AuthDialog({ open, onClose, onSignedIn, web }: { open: boolean; onClose: () => void; onSignedIn: (settings: UserSettings, email: string) => Promise<void>; web: boolean }) {
  if (!open) return null;
  return <div className="auth-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="auth-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-dialog-title">
      <header><div><h2 id="auth-dialog-title">{t("登录 Shadow Language")}</h2>{web ? <><p>{t("登录是为了帮你记住学习进度，请放心注册。")}</p><p>{t("电脑、手机、平板登录同一账号，即可同步学习进度，换设备也能接着学。")}</p></> : <p>{t("登录后可在不同设备同步学习数据。")}</p>}</div><button type="button" className="auth-modal-close" aria-label={t("关闭登录窗口")} onClick={onClose}><Icon name="close" /></button></header>
      {web ? <WebAuthForm onSignedIn={onSignedIn} autoFocus /> : <AuthForm onSignedIn={onSignedIn} autoFocus />}
    </div>
  </div>;
}

type DeviceRecord = { _id: string; deviceId: string; clientType?: 'extension' | 'web'; extensionVersion: string; lastSeenAt: string; revokedAt: string | null };

function deviceClientLabel(device: DeviceRecord): string {
  return device.clientType === 'web' ? 'Web' : t("扩展");
}

function deviceTitle(device: DeviceRecord, currentDeviceId: string): string {
  if (device.deviceId === currentDeviceId) return t("当前设备");
  return device.clientType === 'web' ? t("Web 设备") : t("Chrome 设备");
}

function Settings({ signedIn, accountEmail, settings, setSignedIn, setAccountEmail, setSettings, updateSettings, refreshLocal, onOpenLogin, onSignOut }: { signedIn: boolean; accountEmail: string | null; settings: UserSettings; setSignedIn: (value: boolean) => void; setAccountEmail: (value: string | null) => void; setSettings: (settings: UserSettings) => void; updateSettings: (partial: Partial<UserSettings>) => void; refreshLocal: () => Promise<void>; onOpenLogin: () => void; onSignOut: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleteText, setDeleteText] = useState('');
  const [deletionStatus, setDeletionStatus] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [failedOutbox, setFailedOutbox] = useState<Array<{ id: string; type: string; attempts: number; nextAttemptAt: number; lastError?: string }>>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState('');
  const refreshDiagnostics = async () => {
    const failed = await db.outbox.where('status').equals('failed').toArray();
    setFailedOutbox(failed.sort((a, b) => b.updatedAt - a.updatedAt));
  };
  const refreshDevices = async () => {
    if (!signedIn) { setDevices([]); return; }
    try {
      const [result, storage] = await Promise.all([
        sendRuntime<{ items: DeviceRecord[] }>({ type: 'DEVICES_LIST' }),
        browser.storage.local.get('deviceId'),
      ]);
      setDevices(result.items);
      setCurrentDeviceId(typeof storage.deviceId === 'string' ? storage.deviceId : '');
    } catch (cause) {
      setDevices([]);
      setError(displayError(cause, t("设备列表读取失败。")));
    }
  };
  useEffect(() => {
    void refreshDevices();
    void refreshDiagnostics();
    if (!signedIn) return undefined;
    const timer = window.setInterval(() => { void refreshDiagnostics(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [signedIn]);
  const downloadExport = (contents: string, extension: 'json' | 'csv', mimeType: string) =>
    downloadPlatformFile(new Blob([contents], { type: mimeType }), `shadow-language-export-${new Date().toISOString().slice(0, 10)}.${extension}`, t("学习数据备份"));
  const exportAccount = async (format: 'json' | 'csv') => {
    setBusy(true); setError('');
    try {
      const account = await sendRuntime<{ schemaVersion: number; exportedAt: string; data: Record<string, unknown[]>; truncated: boolean }>({ type: 'ACCOUNT_EXPORT' });
      if (format === 'json') {
        await downloadExport(JSON.stringify(account, null, 2), 'json', 'application/json');
      } else {
        const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
        const rows = ['collection,record_json'];
        for (const [collection, records] of Object.entries(account.data)) for (const record of records) rows.push(`${escape(collection)},${escape(JSON.stringify(record))}`);
        await downloadExport(`\uFEFF${rows.join('\n')}`, 'csv', 'text/csv;charset=utf-8');
      }
    } catch (cause) { setError(displayError(cause, t("账号数据导出失败。"))); }
    finally { setBusy(false); }
  };
  const requestAccountDeletion = async () => {
    setBusy(true); setError('');
    try {
      await sendRuntime({ type: 'ACCOUNT_DELETE', confirmation: 'DELETE' });
      setDeleteText(''); setDeletionStatus(signedIn ? 'queued' : 'ready');
      if (!signedIn) { setSettings(await sendRuntime<UserSettings>({ type: 'SETTINGS_GET' })); await refreshLocal(); }
    } catch (cause) { setError(displayError(cause, t("账号删除任务提交失败。"))); }
    finally { setBusy(false); }
  };
  const syncNow = async () => {
    setBusy(true); setError(''); setSyncMessage('');
    try {
      const result = await sendRuntime<{ synced: number; failed: number }>({ type: 'SYNC_NOW' });
      setSyncMessage(t("本次同步 {0} 项，失败 {1} 项", result.synced, result.failed));
      await sendRuntime({ type: 'VIDEO_INSIGHTS_REFRESH' });
      await Promise.all([refreshLocal(), refreshDiagnostics()]);
    } catch (cause) { setError(displayError(cause, t("同步失败。"))); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!signedIn || !deletionStatus || deletionStatus === 'ready' || deletionStatus === 'dead_letter') return;
    let cancelled = false;
    let timer: number | undefined;
    let delay = 15_000;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        try {
          const result = await sendRuntime<{ deletion?: { status?: string } | null }>({ type: 'ACCOUNT_STATUS' });
        const status = result.deletion?.status || 'unknown';
        setDeletionStatus(status);
        if (status === 'ready') {
          await sendRuntime({ type: 'AUTH_SIGN_OUT' });
          setSignedIn(false);
          setAccountEmail(null);
          setSettings(DEFAULT_SETTINGS);
          await refreshLocal();
        }
        } catch (cause) {
          setError(displayError(cause, t("账号删除状态读取失败。")));
        } finally {
          if (!cancelled) { delay = Math.min(60_000, delay * 2); schedule(); }
        }
      }, delay);
    };
    schedule();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [signedIn, deletionStatus]);
  const selectedVocabularyTier = exactVocabularyTierForSize(settings.vocabularySize);
  const selectedVocabularyLabel = vocabularyThresholdLabel(settings.vocabularySize);
  return <section className="settings panel">
    <div className="settings-group">
    <h2>{t("词汇量与字幕")}</h2>
    <div className="vocabulary-preference"><label><span>{t("我的词汇量")}</span><select aria-label={t("我的词汇量阈值")} value={settings.vocabularySize} onChange={(event) => { const vocabularySize = Number(event.target.value); void updateSettings({ vocabularySize, learnerLevel: previewLevelForVocabularySize(vocabularySize) }); }}>{!selectedVocabularyTier && <option value={settings.vocabularySize}>{selectedVocabularyLabel} {t("· 快速测试")}</option>}{VOCABULARY_TIERS.map((tier) => <option key={tier.label} value={tier.rank}>{tier.label} · {tier.cefr}</option>)}</select></label><p>{t("当前阈值为")}{selectedVocabularyLabel}{t("。YouTube 字幕超纲高亮和语料库适合度会使用这个精确数值。")}</p></div>
    </div><hr /><div className="settings-group">
    <h2>{t("快捷键")}</h2>
    <ShortcutEditor shortcuts={settings.playbackPreferences.pageShortcuts} onChange={(pageShortcuts) => updateSettings({ playbackPreferences: { ...settings.playbackPreferences, pageShortcuts } })} />
    </div><hr /><div className="settings-group">
    <h2>{t("账号与同步")}</h2>
    {signedIn ? <><div className="signed-in"><span><strong>{accountEmail || t("已登录")}</strong><small>{t("云同步已开启")}</small></span><button type="button" onClick={() => void onSignOut()}>{t("退出登录")}</button></div><div className="devices"><h3>{t("设备")}</h3>{devices.filter((device) => !device.revokedAt).map((device) => <div key={device._id}><span><strong>{deviceTitle(device, currentDeviceId)}</strong><small>{deviceClientLabel(device)} {device.extensionVersion} · {new Date(device.lastSeenAt).toLocaleDateString()}</small></span>{device.deviceId !== currentDeviceId && <button className="danger-link" onClick={async () => { await sendRuntime({ type: 'DEVICE_REVOKE', deviceRecordId: device._id }); await refreshDevices(); }}>{t("撤销")}</button>}</div>)}</div></> : <div className="account-local"><span>{t("本地模式")}</span><button type="button" className="primary" onClick={onOpenLogin}>{t("登录并开启云同步")}</button></div>}
    </div><hr /><div className="settings-group">
    <h2>{t("数据控制")}</h2>
    <div className="button-row"><button disabled={busy} onClick={() => void exportAccount('json')}>{t("导出 JSON")}</button><button disabled={busy} onClick={() => void exportAccount('csv')}>{t("导出 CSV")}</button>{signedIn && <button disabled={busy} onClick={syncNow}>{busy ? t("处理中…") : !signedIn ? t("登录后同步") : failedOutbox.length ? t("重试失败项（{0}）", failedOutbox.length) : t("立即同步")}</button>}</div>
    {syncMessage && <p className="sync-message">{syncMessage}</p>}
    <details className="diagnostics" open={failedOutbox.length > 0}><summary>{t("同步诊断 ·")}{failedOutbox.length ? t("{0} 项需要处理", failedOutbox.length) : t("正常")}</summary>{failedOutbox.length ? failedOutbox.slice(0, 10).map((item) => <div key={item.id}><strong>{OUTBOX_TYPE_LABELS[item.type] || t("同步任务")}</strong><span>{t("已尝试")}{item.attempts} {t("次 · 下次")}{new Date(item.nextAttemptAt).toLocaleTimeString()}</span><code>{item.lastError || t("未知错误")}</code></div>) : <p className="muted">{t("没有失败的同步任务。离线任务会在联网后自动重试，也可手动立即同步。")}</p>}</details>
    <details><summary>{signedIn ? t("删除账号数据") : t("删除本地学习数据")}</summary><p className="muted">{!signedIn ? t("输入 DELETE 后清除本浏览器的学习记录、生词本和本地 Agent 数据。") : t("输入 DELETE 后提交。后台会先停止新写入，再异步删除私有数据；重复语料会解除你的贡献关联，是否保留共享副本取决于其他合法来源。")}</p><input value={deleteText} onChange={(event) => setDeleteText(event.target.value)} placeholder="DELETE" /><button className="danger" disabled={busy || deleteText !== 'DELETE'} onClick={requestAccountDeletion}>{t("提交删除任务")}</button>{deletionStatus && <p className="deletion-status">{t("删除任务：")}{DELETION_STATUS_LABELS[deletionStatus] || t("处理中")}</p>}</details>
    </div>
  </section>;
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
