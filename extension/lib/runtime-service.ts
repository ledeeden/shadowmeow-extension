import { readVideoTranscript, saveVideoTranscript } from './video-transcript';
import { configureAnalyticsSink } from './analytics';
import { continueWithEmail } from './email-auth';
import { enqueueAnalytics, flushAnalytics } from './analytics-background';
import { createDebouncedLatest } from './debounced-latest';
import { deleteOwnerAgentData, exportAgentData } from './agent/store';
import { videoKeyOf, videoIdentity, videoUrl, bilibiliVideoKeySchema, subtitleResolutionSchema } from '@shadow-language/contracts';
import type { AttemptInput, RuntimeMessage, SavedItemInput, UserSettings, VideoAnalysis } from '@shadow-language/contracts';
import { callApi, getAuthStatus, resendPasswordSetup, resendSignUp, rotateDeviceId, signIn, signInWithGoogle, signOut, startPasswordSetup, startSignUp, verifySignUp, type SignUpVerifier } from './cloudbase';
import { clearPrivateLocalData, db, enqueueOutbox, getLocalSettings, normalizeSettings, saveLocalSettings } from './db';
import { flushOutbox, retryOutboxNow } from './outbox';
import { mergeLocalProgress } from './progress';
import { formatErrorForDisplay, runtimeErrorResponse } from './runtime-errors';
import { checkExtensionUpdate } from './extension-update';
import { createRemoteSessionHydrator } from './remote-session-hydration';
import { getVocabularyState, getVocabularyStudyPlan, markVocabularyKnown, recordVocabularyReview, removeVocabularyWord, saveVocabularyWord, setVocabularyGoal } from './vocabulary';
import { isSidePanelLearningUrl } from './side-panel-policy';
import { getExpressionReviewState, recordExpressionChallengeAttempt, recordExpressionReview, saveExpressionBundle } from './expression-review-store';

const REMOTE_SESSION_HYDRATED_AT_KEY = 'remoteSessionHydratedAtV1';
const SYNC_ALARM = 'shadow-language-sync';
const ANALYTICS_ALARM = 'shadow-language-analytics';
const SETTINGS_SYNC_DEBOUNCE_MS = 500;
const WEB_ONBOARDING_VOCABULARY_KEY = 'webOnboardingVocabularyEstimateV1';

type RuntimeMessageSender = {
  url?: string;
  tab?: {
    id?: number | undefined;
  } | undefined;
};

export function startRuntimeService(options: { localFirst?: boolean } = {}) {
  const localFirst = Boolean(options.localFirst);
  // Web records only corpus page entries, piggybacked on resolvePlayback.
  // Never enable the extension's feature/caption/learning telemetry on Web.
  const analyticsEnabled = !localFirst;
  const queueLegacy: typeof enqueueOutbox = (...args) => localFirst ? Promise.resolve(args[2] || '') : enqueueOutbox(...args);
  configureAnalyticsSink(event => { if (analyticsEnabled) void enqueueAnalytics(event).catch(() => undefined); });
  const pendingSignUps = new Map<string, { verifyOtp: SignUpVerifier; resend: () => Promise<string | undefined>; expiresAt: number; messageId?: string }>();
  type RemoteBootstrap = { settings: UserSettings; features?: { analysisEnabled: boolean } };
  const hydrateSignedInSession = createRemoteSessionHydrator<RemoteBootstrap>({
    readHydratedAt: async () => Number((await browser.storage.local.get(REMOTE_SESSION_HYDRATED_AT_KEY))[REMOTE_SESSION_HYDRATED_AT_KEY] || 0),
    writeHydratedAt: async (value) => { await browser.storage.local.set({ [REMOTE_SESSION_HYDRATED_AT_KEY]: value }); },
    readCached: async () => {
      const features = (await browser.storage.local.get('remoteFeatures')).remoteFeatures as RemoteBootstrap['features'] | undefined;
      return { settings: await getLocalSettings(), ...(features ? { features } : {}) };
    },
    hydrate: performRemoteSessionHydration,
  });
  const syncSettingsRemotely = createDebouncedLatest<UserSettings, UserSettings>(async (next) => {
    const remote = await callApi<UserSettings>('settings.update', {
      targetLanguage: next.targetLanguage,
      learnerLevel: next.learnerLevel,
      vocabularySize: next.vocabularySize,
      playbackPreferences: next.playbackPreferences,
    }, { idempotencyKey: `settings_${Date.now()}` });
    const normalized = normalizeSettings(remote);
    await saveLocalSettings(normalized);
    broadcastAuthChange(true, normalized);
    return normalized;
  }, SETTINGS_SYNC_DEBOUNCE_MS);
  const hydrateRecentVideos = async () => {
    const recent = await callApi<{ items: Array<Record<string, unknown>> }>('learning.listRecentVideos', { limit: 100 });
    for (const item of recent.items) {
      if (typeof item.youtubeId !== 'string' && typeof item.videoKey !== 'string') continue;
      const key = typeof item.videoKey === 'string' ? item.videoKey : String(item.youtubeId);
      const current = await db.progress.get(key);
      const remoteAnalysis = item.analysis && typeof item.analysis === 'object' && (item.analysis as { status?: unknown }).status === 'ready'
        ? item.analysis as VideoAnalysis
        : null;
      if (remoteAnalysis) await db.videoAnalyses.put({ id: key, analysis: remoteAnalysis, updatedAt: Date.now() });
      const analysis = remoteAnalysis || current?.analysis || null;
      await db.progress.put({
        id: key,
        ...videoIdentity(key),
        ...(typeof item.thumbnailUrl === 'string' ? { thumbnailUrl: item.thumbnailUrl } : {}),
        ...(typeof item.title === 'string' ? { title: item.title } : current?.title ? { title: current.title } : {}),
        ...(typeof item.channelTitle === 'string' ? { channelTitle: item.channelTitle } : current?.channelTitle ? { channelTitle: current.channelTitle } : {}),
        ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : current?.durationMs ? { durationMs: current.durationMs } : {}),
        trackId: typeof item.trackId === 'string' ? item.trackId : null,
        segmentSeq: typeof item.segmentSeq === 'number' ? item.segmentSeq : 0,
        positionMs: typeof item.positionMs === 'number' ? item.positionMs : 0,
        completedRatio: typeof item.completedRatio === 'number' ? item.completedRatio : 0,
        activeSecondsDelta: 0,
        activeSecondsTotal: typeof item.activeSeconds === 'number' ? item.activeSeconds : (current?.activeSecondsTotal || 0),
        occurredAt: typeof item.lastPositionOccurredAt === 'string' ? item.lastPositionOccurredAt : (current?.occurredAt || new Date().toISOString()),
        syncStatus: 'synced',
        analysis,
      });
    }
    return recent;
  };
  const hydrateFromCloud = async () => {
    await hydrateRecentVideos();
    const remoteAssets: Array<Record<string, unknown>> = [];
    const remoteAttempts: Array<Record<string, unknown>> = [];
    let cursor: number | null = 0;
    while (cursor !== null && remoteAssets.length < 1000) {
      const page: { items: Array<Record<string, unknown>>; nextCursor: number | null } = await callApi('learning.listAssets', { cursor, limit: 100 });
      remoteAssets.push(...page.items);
      cursor = page.nextCursor;
    }
    cursor = 0;
    while (cursor !== null && remoteAttempts.length < 1000) {
      const page: { items: Array<Record<string, unknown>>; nextCursor: number | null } = await callApi('learning.listAttempts', { cursor, limit: 100 });
      remoteAttempts.push(...page.items);
      cursor = page.nextCursor;
    }
    await db.transaction('rw', [db.assets, db.attempts], async () => {
      for (const item of remoteAssets) {
        if (typeof item.id !== 'string' || (typeof item.youtubeId !== 'string' && typeof item.videoKey !== 'string')) continue;
        await db.assets.put({ ...(item as unknown as import('@shadow-language/contracts').SavedItemInput), syncStatus: 'synced' });
      }
      for (const item of remoteAttempts) {
        if (typeof item.id !== 'string' || (typeof item.youtubeId !== 'string' && typeof item.videoKey !== 'string')) continue;
        await db.attempts.put({ ...(item as unknown as AttemptInput), syncStatus: 'synced' });
      }
    });
  };
  const restoreSession = async () => {
    const auth = await getAuthStatus();
    if (!auth.signedIn) return;
    try {
      await hydrateSignedInSession();
    } catch (error) {
      // A later alarm retries transient network or token-refresh failures, but
      // keep the concrete reason in the service-worker console for diagnosis.
      console.warn('[Shadow Language] session restore failed', formatErrorForDisplay(error, '会话恢复失败，未返回具体错误描述。'));
    }
  };
  const disableAgentPanel = (tabId: number) => browser.sidePanel.setOptions({ tabId, enabled: false });
  const openDashboard = async (section: 'agent' | 'reader' | 'study' | 'assets' | 'corpus' | 'public-corpus' | 'progress' | 'settings' = 'assets') => {
    const tab = await browser.tabs.create({ url: `${browser.runtime.getURL('/dashboard.html')}#${section}` });
    if (typeof tab.id === 'number') await disableAgentPanel(tab.id).catch(() => undefined);
    return tab;
  };
  const agentPanelPath = (tabId: number, view: 'chat' | 'words') => `agent.html?tab=${tabId}&agentTab=${view}`;
  const prepareAgentPanel = (tabId: number, view: 'chat' | 'words') => browser.sidePanel.setOptions({ tabId, path: agentPanelPath(tabId, view), enabled: true });
  const openAgentPanel = (tabId: number, view: 'chat' | 'words') => {
    // Start both calls in the original user-gesture task. Awaiting setOptions
    // first makes Chrome reject open() as non-interactive.
    const configured = prepareAgentPanel(tabId, view);
    const opened = browser.sidePanel.open({ tabId });
    return Promise.all([opened, configured]);
  };
  const broadcastAgentView = (tabId: number, view: 'chat' | 'words') => {
    void browser.runtime.sendMessage({ type: 'AGENT_VIEW', view, tabId } satisfies RuntimeMessage).catch(() => undefined);
  };
  const currentLearningTabId = async (fallback?: number): Promise<number | undefined> => {
    const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (typeof active?.id === 'number') {
      if (!isSidePanelLearningUrl(active.url)) return undefined;
      return active.id;
    }
    return fallback;
  };
  const broadcastVocabularyChange = () => {
    void browser.runtime.sendMessage({ type: 'VOCABULARY_CHANGED' } satisfies RuntimeMessage).catch(() => undefined);
  };
  const broadcastAuthChange = (signedIn: boolean, settings?: UserSettings) => {
    void browser.runtime.sendMessage({ type: 'AUTH_CHANGED', signedIn, ...(settings ? { settings } : {}) } satisfies RuntimeMessage).catch(() => undefined);
  };
  // There is no global panel. Each supported video tab opts in only after a
  // user points to, focuses, or activates one of its contextual panel actions.
  void browser.sidePanel.setOptions({ enabled: false }).catch(() => undefined);
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  browser.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    if (!isSidePanelLearningUrl(tab.url)) void disableAgentPanel(tabId).catch(() => undefined);
  });
  void browser.tabs.query({}).then((tabs) => Promise.all(tabs.map((tab) => {
    if (typeof tab.id !== 'number' || isSidePanelLearningUrl(tab.url)) return Promise.resolve();
    return disableAgentPanel(tab.id).catch(() => undefined);
  }))).catch(() => undefined);
  browser.action.onClicked.addListener(() => { void openDashboard('public-corpus'); });
  if (!localFirst) browser.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  if (analyticsEnabled) browser.alarms.create(ANALYTICS_ALARM, { periodInMinutes: 5 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (analyticsEnabled && alarm.name === ANALYTICS_ALARM) void flushAnalytics();
    if (!localFirst && alarm.name === SYNC_ALARM) void (async () => { if ((await getAuthStatus()).signedIn) await flushOutbox(); })();
  });
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === 'shadow-language-signup') port.onMessage.addListener(() => undefined);
  });
  browser.runtime.onStartup.addListener(() => { if (!localFirst) void restoreSession(); });
  browser.runtime.onInstalled.addListener(() => { if (!localFirst) void restoreSession(); });
  if (!localFirst) void restoreSession();

  const handleRuntimeMessage = async (message: RuntimeMessage, sender: RuntimeMessageSender) => {
    if (message.type === 'EXTENSION_UPDATE_CHECK') return checkExtensionUpdate(message.force);
    if (message.type === 'ANALYTICS_TRACK') { if (analyticsEnabled) await enqueueAnalytics(message.event); return { ok: true }; }
    if (message.type === 'CAPTION_CACHE_GET') return (await readVideoTranscript(message.videoKey, message.trackId)) || null;
    if (message.type === 'PAGE_CONTEXT_CHANGED') {
      if (message.page) await saveVideoTranscript(message.page);
      const tabId = sender.tab?.id;
      if (typeof tabId === 'number') {
        void browser.runtime.sendMessage({ type: 'AGENT_CONTEXT_CHANGED', tabId } satisfies RuntimeMessage).catch(() => undefined);
      }
      return { changed: true };
    }
    if (message.type === 'AGENT_PREPARE') {
      const tabId = sender.tab?.id;
      if (!tabId || !isSidePanelLearningUrl(sender.url)) throw new Error('无法确定视频页面');
      await prepareAgentPanel(tabId, message.panel === 'words' ? 'words' : 'chat');
      return { ready: true };
    }
    if (message.type === 'AGENT_OPEN') {
      const tabId = sender.tab?.id;
      if (!tabId || !isSidePanelLearningUrl(sender.url)) throw new Error('无法确定视频页面');
      await openAgentPanel(tabId, 'chat');
      broadcastAgentView(tabId, 'chat');
      return { opened: true };
    }
    if (message.type === 'AGENT_HIGHLIGHT') {
      if (!sender.tab?.id || !isSidePanelLearningUrl(sender.url)) throw new Error('无法确定字幕来源');
      const r = message.reference;
      if (!r || typeof r.text !== 'string' || r.text.length > 10000 || typeof r.highlight !== 'string' || !r.text.replace(/\s+/g, ' ').includes(r.highlight.replace(/\s+/g, ' ')) || !Number.isFinite(r.startMs)) throw new Error('字幕引用无效');
      const opened = openAgentPanel(sender.tab.id, 'chat');
      await browser.storage.session.set({ [`agent-reference:${sender.tab.id}`]: r });
      await opened;
      broadcastAgentView(sender.tab.id, 'chat');
      return { saved: true };
    }
    if (message.type === 'AGENT_CONTEXT' || message.type === 'AGENT_REPLAY' || message.type === 'AGENT_REFERENCE_SAVED') {
      if (!sender.url || !(sender.url.startsWith(browser.runtime.getURL('/agent.html')) || sender.url.startsWith(browser.runtime.getURL('/sidepanel.html')))) throw new Error('Agent 页面不可用');
      const panelUrl = new URL(sender.url);
      const requestedTabId = Number(panelUrl.searchParams.get('tab')) || sender.tab?.id;
      const tabId = message.type === 'AGENT_REFERENCE_SAVED'
        ? requestedTabId || await currentLearningTabId()
        : await currentLearningTabId(requestedTabId);
      if (!tabId) return {};

      if (message.type === 'AGENT_REFERENCE_SAVED') {
        const key = `agent-reference:${tabId}`;
        const record = await browser.storage.session.get(key);
        if ((record[key] as { id?: string } | undefined)?.id === message.id) await browser.storage.session.remove(key);
        return { ok: true };
      }
      const page = await browser.tabs.sendMessage(tabId, { type: 'PAGE_GET_STATE' });
      if (!page || !videoKeyOf(page)) return {};
      if (message.type === 'AGENT_REPLAY') {
        if (videoKeyOf(page) !== message.videoKey || !Number.isFinite(message.timeMs) || message.timeMs < 0 || message.timeMs > page.durationMs) throw new Error('视频已切换');
        await browser.tabs.sendMessage(tabId, { type: 'PAGE_PLAYER_COMMAND', command: { type: 'SEEK', timeMs: message.timeMs } });
        await browser.tabs.sendMessage(tabId, { type: 'PAGE_PLAYER_COMMAND', command: { type: 'PLAY' } });
        return { ok: true };
      }
      const record = await browser.storage.session.get(`agent-reference:${tabId}`);
      const reference = record[`agent-reference:${tabId}`] as { videoKey?: string } | undefined;
      return { page, ...(reference && reference.videoKey === videoKeyOf(page) ? { reference } : {}) };
    }
    if (message.type === 'OPEN_NEW_WORD_PANEL') {
      const tabId = sender.tab?.id;
      if (typeof tabId !== 'number' || !isSidePanelLearningUrl(sender.url)) throw new Error('无法确定当前视频页面。');
      await openAgentPanel(tabId, 'words');
      broadcastAgentView(tabId, 'words');
      return { opened: true };
    }
    if (message.type === 'DASHBOARD_OPEN') return openDashboard(message.section);
    if (message.type === 'VIDEO_OPEN') {
      return browser.tabs.create({ url: videoUrl(videoKeyOf(message), message.startMs) });
    }
    if (message.type === 'CORPUS_RESOLVE_SUBTITLES') {
      const videoKey = bilibiliVideoKeySchema.parse(message.videoKey);
      const durationMs = Math.round(message.durationMs);
      if (!Number.isFinite(durationMs) || durationMs <= 0) return { status: 'not_ready' };
      const result = await callApi<{ status: string }>('corpus.resolveSubtitles', { videoKey, durationMs });
      return result.status === 'available' ? subtitleResolutionSchema.parse(result) : { status: result.status };
    }
    if (message.type === 'VIDEO_INSIGHTS_REFRESH') {
      if (localFirst) return { refreshed: false, reason: 'local_first_sync_owns_private_data' };
      if (!(await getAuthStatus()).signedIn) return { refreshed: false };
      const recent = await hydrateRecentVideos();
      return { refreshed: true, count: recent.items.length };
    }
    if (message.type === 'AUTH_STATUS') return getAuthStatus();
    if (message.type === 'AUTH_SIGN_IN') {
      const auth = await signIn(message.email.trim().toLowerCase(), message.password);
      await rotateDeviceId();
      const bootstrap = await hydrateSignedInSession({ force: true });
      return { ...auth, settings: bootstrap.settings };
    }
    if (message.type === 'AUTH_SIGN_IN_GOOGLE') {
      const auth = await signInWithGoogle();
      await rotateDeviceId();
      const bootstrap = await hydrateSignedInSession({ force: true });
      return { ...auth, settings: bootstrap.settings };
    }
    if (message.type === 'AUTH_SIGN_UP_START' || message.type === 'AUTH_EMAIL_CONTINUE' || message.type === 'AUTH_PASSWORD_RESET_START') {
      return (async () => {
        const email = message.email.trim().toLowerCase();
        for (const [key, pending] of pendingSignUps) if (pending.expiresAt < Date.now()) pendingSignUps.delete(key);
        if (message.type === 'AUTH_PASSWORD_RESET_START' && message.password.length < 8) throw new Error('新密码至少需要 8 位。');
        const auth: Awaited<ReturnType<typeof startSignUp>> = message.type === 'AUTH_EMAIL_CONTINUE'
          ? await continueWithEmail(email, message.password, signIn, startSignUp, startPasswordSetup)
          : message.type === 'AUTH_PASSWORD_RESET_START'
            ? await startPasswordSetup(email, message.password)
            : await startSignUp(email, message.password);
        if (auth.verifyOtp) {
          pendingSignUps.set(email, {
            verifyOtp: auth.verifyOtp,
            resend: () => auth.verificationPurpose === 'password_setup' ? resendPasswordSetup(email) : resendSignUp(email),
            expiresAt: Date.now() + 10 * 60_000,
          });
          return { signedIn: false, verificationRequired: true, expiresInSeconds: 600 };
        }
        if (!auth.signedIn) throw new Error('注册请求已提交，但未返回验证码流程或登录会话。请重试。');
        await rotateDeviceId();
        const bootstrap = await hydrateSignedInSession({ force: true });
        return { ...auth, verificationRequired: false, settings: bootstrap.settings };
      })();
    }
    if (message.type === 'AUTH_SIGN_UP_RESEND') {
      return (async () => {
        const email = message.email.trim().toLowerCase();
        const pending = pendingSignUps.get(email);
        if (!pending || pending.expiresAt < Date.now()) {
          pendingSignUps.delete(email);
          throw new Error('验证码会话已过期，请返回邮箱输入页重新发送。');
        }
        const messageId = await pending.resend();
        pendingSignUps.set(email, { ...pending, expiresAt: Date.now() + 10 * 60_000, ...(messageId ? { messageId } : {}) });
        return { resent: true, expiresInSeconds: 600 };
      })();
    }
    if (message.type === 'AUTH_SIGN_UP_VERIFY') {
      return (async () => {
        const email = message.email.trim().toLowerCase();
        const pending = pendingSignUps.get(email);
        if (!pending || pending.expiresAt < Date.now()) {
          pendingSignUps.delete(email);
          throw new Error('验证码会话已过期，请重新发送验证码。');
        }
        const auth = await verifySignUp(pending.verifyOtp, message.code.trim(), pending.messageId);
        if (!auth.signedIn) throw new Error('验证码已接受，但登录会话未建立。请重新登录。');
        pendingSignUps.delete(email);
        await rotateDeviceId();
        const bootstrap = await hydrateSignedInSession({ force: true });
        return { ...auth, settings: bootstrap.settings };
      })();
    }
    if (message.type === 'AUTH_SIGN_OUT') {
      // End the server-side device session before clearing the local CloudBase
      // credentials. Otherwise the next login rotates to a new device ID while
      // the previous row remains active and the UI shows duplicate sessions.
      await callApi('auth.signOut', {}).catch(() => undefined);
      await signOut();
      await browser.storage.local.remove(['remoteFeatures', REMOTE_SESSION_HYDRATED_AT_KEY]);
      broadcastVocabularyChange();
      broadcastAuthChange(false, await getLocalSettings());
      return { signedIn: false };
    }
    if (message.type === 'SETTINGS_GET') return getLocalSettings();
    if (message.type === 'SETTINGS_UPDATE') {
      const current = await getLocalSettings();
      const next = normalizeSettings({
        ...current,
        ...message.settings,
        playbackPreferences: { ...current.playbackPreferences, ...(message.settings.playbackPreferences || {}) },
      });
      await saveLocalSettings(next);
      const auth = await getAuthStatus();
      if (auth.signedIn && !localFirst) {
        return syncSettingsRemotely(next);
      }
      broadcastAuthChange(auth.signedIn, next);
      return next;
    }
    if (message.type === 'DEVICES_LIST') return callApi('devices.list', {});
    if (message.type === 'DEVICE_REVOKE') return callApi('devices.revoke', { deviceRecordId: message.deviceRecordId }, { idempotencyKey: `revoke-device-${message.deviceRecordId}` });
    if (message.type === 'CAPTION_NLP') return (await import('./caption-nlp')).analyzeCaptions(message.texts);
    if (message.type === 'DICTIONARY_LOOKUP') return (await import('./dictionary')).lookupDictionary({ text: message.text, ...(message.contextText ? { contextText: message.contextText } : {}), ...(message.detail ? { detail: message.detail } : {}) });
    if (message.type === 'DICTIONARY_PREFETCH') return (await import('./dictionary')).prefetchDictionary({ texts: message.texts, ...(message.phrases ? { phrases: message.phrases } : {}) });
    if (message.type === 'DICTIONARY_TTS') return (await import('./dictionary')).getDictionaryAudio({ text: message.text });
    if (message.type === 'ASSET_SAVE') {
      const item: SavedItemInput = message.item;
      await db.assets.put({ ...item, syncStatus: 'pending' });
      if (item.kind === 'word') {
        await saveVocabularyWord({
          word: item.displayValue,
          ...(item.lemma ? { lemma: item.lemma } : {}),
          ...(item.meaningZh ? { translation: item.meaningZh } : {}),
          ...(item.pronunciation ? { phonetic: item.pronunciation } : {}),
          source: `video_asset:${videoKeyOf(item)}`,
          contextText: item.contextText,
        });
        broadcastVocabularyChange();
      }
      await queueLegacy('saveAsset', item, `asset_${item.id}`);
      if (!localFirst && (await getAuthStatus()).signedIn) void flushOutbox();
      return { saved: true };
    }
    if (message.type === 'ASSET_DELETE') {
      await db.assets.update(message.id, { deletedAt: message.occurredAt, syncStatus: 'pending' });
      await queueLegacy('deleteAsset', { id: message.id, occurredAt: message.occurredAt }, `delete_${message.id}_${message.occurredAt}`);
      if (!localFirst && (await getAuthStatus()).signedIn) void flushOutbox();
      return { deleted: true };
    }
    if (message.type === 'PROGRESS_SAVE') {
      const previous = await db.progress.get(videoKeyOf(message.progress));
      await db.progress.put(mergeLocalProgress(previous, message.progress));
      if (!message.localOnly) {
        await queueLegacy('progress', message.progress, `progress_${videoKeyOf(message.progress)}_${message.progress.occurredAt}`);
        if (!localFirst && (await getAuthStatus()).signedIn) void flushOutbox();
      }
      return { saved: true, localOnly: Boolean(message.localOnly) };
    }
    if (message.type === 'ATTEMPT_RECORD') {
      await db.attempts.put({ ...message.attempt, syncStatus: 'pending' });
      await queueLegacy('attempt', message.attempt, `attempt_${message.attempt.id}`);
      if (!localFirst && (await getAuthStatus()).signedIn) void flushOutbox();
      return { saved: true };
    }
    if (message.type === 'VOCABULARY_STATE_GET') return getVocabularyState();
    if (message.type === 'VOCABULARY_PLAN_GET') return getVocabularyStudyPlan();
    if (message.type === 'VOCABULARY_SAVE') {
      const card = await saveVocabularyWord(message.input);
      broadcastVocabularyChange();
      return card;
    }
    if (message.type === 'VOCABULARY_MARK_KNOWN') {
      const card = await markVocabularyKnown(message.input);
      broadcastVocabularyChange();
      return card;
    }
    if (message.type === 'VOCABULARY_REMOVE') {
      const removed = await removeVocabularyWord(message.word);
      if (removed) broadcastVocabularyChange();
      return { removed };
    }
    if (message.type === 'VOCABULARY_REVIEW') {
      const card = await recordVocabularyReview(message.word, message.rating);
      if (card) broadcastVocabularyChange();
      return card;
    }
    if (message.type === 'VOCABULARY_GOAL_SET') {
      const goal = await setVocabularyGoal(message.goal);
      broadcastVocabularyChange();
      return goal;
    }
    if (message.type === 'VOCABULARY_CHANGED') return { changed: true };
    if (message.type === 'EXPRESSION_BUNDLE_SAVE') {
      const result = await saveExpressionBundle(message.bundle);
      broadcastVocabularyChange();
      return result;
    }
    if (message.type === 'EXPRESSION_REVIEW_STATE_GET') return getExpressionReviewState();
    if (message.type === 'EXPRESSION_REVIEW_RATE') {
      const item = await recordExpressionReview(message.itemId, message.rating, message.sessionId, message.responseMs);
      broadcastVocabularyChange();
      return item;
    }
    if (message.type === 'EXPRESSION_CHALLENGE_ATTEMPT_RECORD') return recordExpressionChallengeAttempt(message.attempt);
    if (message.type === 'SYNC_NOW') return (await getAuthStatus()).signedIn ? retryOutboxNow() : { synced: 0, failed: 0 };
    if (message.type === 'ACCOUNT_EXPORT') {
      const auth = await getAuthStatus();
      const localData: Record<string, unknown[]> = {};
      for (const table of [db.settings, db.assets, db.progress, db.attempts, db.vocabulary, db.vocabularyReviews, db.studyMeta, db.videoAnalyses, db.expressionBundles, db.expressionReviewItems, db.expressionReviewLogs, db.expressionChallengeAttempts, db.onboarding]) localData[table.name] = await table.toArray();
      const account = auth.signedIn
        ? await callApi<{ data: Record<string, unknown[]> }>('account.export', {})
        : { schemaVersion: 1, exportedAt: new Date().toISOString(), truncated: false, data: localData };
      // Local-only orchestration and expression records must remain exportable while signed in.
      if (auth.signedIn) for (const [name, records] of Object.entries(localData)) account.data[`browser_local_${name}`] = records;
      const guest = await exportAgentData('local');
      for (const [name, records] of Object.entries(guest.data)) account.data[`agent_local_${name}`] = records;
      const user = auth.user as { uid?: string; id?: string; _id?: string } | null;
      const id = user?.uid || user?.id || user?._id;
      if (id) { const local = await exportAgentData(`user:${id}`); for (const [name, records] of Object.entries(local.data)) account.data[`agent_${name}`] = records; }
      return account;
    }
    if (message.type === 'ACCOUNT_DELETE') {
      const auth = await getAuthStatus();
      if (!auth.signedIn) {
        if (message.confirmation !== 'DELETE') throw new Error('请输入 DELETE 确认删除。');
        await clearPrivateLocalData();
        await deleteOwnerAgentData('local');
        broadcastVocabularyChange();
        broadcastAuthChange(false, await getLocalSettings());
        return { status: 'ready' };
      }
      const user = auth.user as { uid?: string; id?: string; _id?: string } | null;
      const id = user?.uid || user?.id || user?._id;
      const result = await callApi('account.delete', { confirmation: message.confirmation }, { idempotencyKey: `account-delete-${Date.now()}` });
      if (id) await deleteOwnerAgentData(`user:${id}`);
      return result;
    }
    if (message.type === 'ACCOUNT_STATUS') return callApi('account.status', {});
    if (message.type === 'PUBLIC_CORPUS_LIST') return callApi('corpus.publicList', message.filters);
    if (message.type === 'PUBLIC_CORPUS_COLLECTIONS_LIST') return callApi('corpus.listCollections', message.filters);
    if (message.type === 'PUBLIC_CORPUS_EPISODES_LIST') return callApi('corpus.listEpisodes', message.filters);
    if (message.type === 'PUBLIC_CORPUS_FACETS') return callApi('corpus.listFacets', message.filters || {});
    if (message.type === 'CORPUS_SUBTITLE_TITLES_LIST') return callApi('corpus.listSubtitleTitles', message.filters);
    if (message.type === 'CORPUS_SUBTITLE_DETAIL_GET') return callApi('corpus.getSubtitleDetail', { subtitleId: message.subtitleId, contentVersion: message.contentVersion });
    if (message.type === 'MEDIA_CORPUS_LIST') return callApi('mediaCorpus.publicList', message.filters);
    if (message.type === 'MEDIA_CORPUS_RECOMMEND') return callApi('mediaCorpus.recommend', message.filters || {});
    if (message.type === 'MEDIA_CORPUS_SERIES') return callApi('mediaCorpus.publicSeries', message.filters || {});
    if (message.type === 'MEDIA_CORPUS_RESOLVE_PLAYBACK') return callApi('mediaCorpus.resolvePlayback', { corpusItemId: message.corpusItemId, ...(message.pageOpen === true ? { pageOpen: true } : {}) });
    return undefined;
  };
  const runtimeMessageListener = (message: RuntimeMessage, sender: RuntimeMessageSender) => handleRuntimeMessage(message, sender).then(result => {
    const platform = sender.url?.includes('bilibili.com') ? 'bilibili' : sender.url?.includes('youtube.com') ? 'youtube' : 'extension';
    const feature = ({ AGENT_REPLAY: 'agent_replay', VIDEO_OPEN: 'result_open', ASSET_SAVE: 'save_asset', VOCABULARY_SAVE: 'save_word', VOCABULARY_REVIEW: 'review' } as Record<string, string>)[message.type];
    if (analyticsEnabled && feature) void enqueueAnalytics({ name: 'feature', platform, feature }).catch(() => undefined);
    if (analyticsEnabled && message.type === 'ATTEMPT_RECORD' && message.attempt.trigger === 'manual_replay') void enqueueAnalytics({ name: 'feature', platform, feature: 'replay' }).catch(() => undefined);
    return result;
  }).catch((error) => runtimeErrorResponse(error));
  browser.runtime.onMessage.addListener(runtimeMessageListener);

  async function performRemoteSessionHydration(): Promise<RemoteBootstrap> {
    if (localFirst) return { settings: await getLocalSettings() }; // Web sync initializes the account partition before hydration.
    const bootstrap = await callApi<RemoteBootstrap>('auth.bootstrap', {});
    let settings = normalizeSettings(bootstrap.settings);
    // A guest assessment already drives local subtitle highlighting. Preserve it
    // at first sign-in and explicitly write it to the account instead of letting
    // the bootstrap response silently overwrite it.
    const pending = (await browser.storage.local.get(WEB_ONBOARDING_VOCABULARY_KEY))[WEB_ONBOARDING_VOCABULARY_KEY] as { vocabularySize?: unknown; learnerLevel?: unknown; syncedAt?: unknown } | undefined;
    if (pending && typeof pending.vocabularySize === 'number' && Number.isInteger(pending.vocabularySize) && !pending.syncedAt) {
      const local = normalizeSettings({ ...settings, vocabularySize: pending.vocabularySize, learnerLevel: pending.learnerLevel });
      settings = normalizeSettings(await callApi<UserSettings>('settings.update', {
        targetLanguage: local.targetLanguage,
        learnerLevel: local.learnerLevel,
        vocabularySize: local.vocabularySize,
        playbackPreferences: local.playbackPreferences,
      }, { idempotencyKey: `onboarding_settings_${Date.now()}` }));
      await browser.storage.local.set({ [WEB_ONBOARDING_VOCABULARY_KEY]: { ...pending, vocabularySize: settings.vocabularySize, learnerLevel: settings.learnerLevel, syncedAt: Date.now() } });
    }
    await saveLocalSettings(settings);
    if (bootstrap.features) await browser.storage.local.set({ remoteFeatures: bootstrap.features });
    broadcastAuthChange(true, settings);
    await flushOutbox();
    await hydrateFromCloud();
    return { ...bootstrap, settings };
  }

  browser.commands.onCommand.addListener(async (command) => {
    if (command === 'toggle-loop' || command === 'toggle-transcript') {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await browser.tabs.sendMessage(tab.id, { type: 'PLAYER_SHORTCUT', action: command } satisfies RuntimeMessage).catch(() => undefined);
      return;
    }
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const state = await browser.tabs.sendMessage(tab.id, { type: 'PAGE_GET_STATE' } satisfies RuntimeMessage).catch(() => null) as import('@shadow-language/contracts').PageState | null;
    if (!state) return;
    if (command === 'toggle-playback') {
      await browser.tabs.sendMessage(tab.id, { type: 'PAGE_PLAYER_COMMAND', command: { type: state.playerState === 'playing' ? 'PAUSE' : 'PLAY' } } satisfies RuntimeMessage);
      return;
    }
    if (command === 'decrease-speed' || command === 'increase-speed') {
      const delta = command === 'increase-speed' ? 0.25 : -0.25;
      const rate = Math.min(1.5, Math.max(0.5, Math.round((state.playbackRate + delta) * 4) / 4));
      await browser.tabs.sendMessage(tab.id, { type: 'PAGE_PLAYER_COMMAND', command: { type: 'SET_RATE', rate } } satisfies RuntimeMessage);
      return;
    }
    const current = state.segments.findIndex((segment) => state.timeMs >= segment.startMs && state.timeMs < segment.endMs);
    const offset = command === 'previous-segment' ? -1 : command === 'next-segment' ? 1 : 0;
    const target = state.segments[Math.min(state.segments.length - 1, Math.max(0, (current < 0 ? 0 : current) + offset))];
    if (target) await browser.tabs.sendMessage(tab.id, { type: 'PAGE_PLAYER_COMMAND', command: { type: 'SEEK', timeMs: Math.max(0, target.startMs - 80) } } satisfies RuntimeMessage);
  });

  return runtimeMessageListener;
}
