import '../lib/crypto-polyfill';
import type { CaptionTrack, PageState, PlayerCommand, RuntimeMessage } from '@shadow-language/contracts';
import { cuesToLearningSegments, normalizeCues, randomId } from '@shadow-language/contracts';
import { runtimeApiCall, unwrapRuntimeResponse } from '../lib/runtime-errors';
import { db, type CaptionCache } from '../lib/db';
import { captionCacheId } from '../lib/caption-cache';
import { PAGE_CHANNEL } from '../lib/constants';
import { fetchCaptionTrack, type CaptionFetchResponse } from '../lib/youtube-captions';
import { chooseEnglishCaptionTrack } from '../lib/youtube-track';
import { createYoutubePlayerUi, type YoutubePlayerUi } from '../components/youtube-player-ui';

type BridgeState = Omit<PageState, 'cues' | 'segments' | 'activeTrackId'> & {
  channelId?: string;
  isLive?: boolean;
  playabilityStatus?: string;
};

type CaptionFetchResult = {
  requestId?: unknown;
  ok?: unknown;
  status?: unknown;
  body?: unknown;
  error?: unknown;
};

const EMPTY_STATE: PageState = {
  youtubeId: null,
  title: '',
  durationMs: 0,
  playerState: 'paused',
  timeMs: 0,
  playbackRate: 1,
  tracks: [],
  activeTrackId: null,
  cues: [],
  segments: [],
};

function sanitizeBridgeState(value: unknown): BridgeState | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.youtubeId !== null && (typeof input.youtubeId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(input.youtubeId))) return null;
  if (typeof input.title !== 'string' || typeof input.durationMs !== 'number' || typeof input.timeMs !== 'number' || typeof input.playbackRate !== 'number') return null;
  if (!['playing', 'paused', 'ended'].includes(String(input.playerState)) || !Array.isArray(input.tracks)) return null;
  const tracks: CaptionTrack[] = [];
  for (const candidate of input.tracks) {
    if (!candidate || typeof candidate !== 'object') return null;
    const track = candidate as Record<string, unknown>;
    if (typeof track.id !== 'string' || typeof track.language !== 'string' || typeof track.label !== 'string' || typeof track.baseUrl !== 'string') return null;
    if (!['manual', 'asr', 'translation'].includes(String(track.kind))) return null;
    try {
      const url = new URL(track.baseUrl);
      if (url.protocol !== 'https:' || !(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))) return null;
    } catch { return null; }
    tracks.push({ id: track.id, language: track.language, label: track.label, baseUrl: track.baseUrl, kind: track.kind as CaptionTrack['kind'] });
  }
  return { ...input, tracks } as BridgeState;
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_start',
  async main(ctx) {
    await injectScript('/youtube-main-world.js', { keepInDom: true });
    if (ctx.isInvalid) return;
    let state: PageState = { ...EMPTY_STATE };
    let selectedTrack: CaptionTrack | null = null;
    let captionLoadKey = '';
    let captionLoadingKey = '';
    let captionRetryAttempts = 0;
    let playerUi: YoutubePlayerUi | null = null;
    let lastContextSignature = '';
    const captionRequests = new Map<string, { resolve: (response: CaptionFetchResponse) => void; reject: (error: Error) => void; timeout: number }>();

    const fetchCaptionInPage = (url: string): Promise<CaptionFetchResponse> => new Promise((resolve, reject) => {
      if (ctx.isInvalid) { reject(new Error('扩展已更新，请刷新当前页面。')); return; }
      const requestId = randomId();
      const timeout = window.setTimeout(() => {
        captionRequests.delete(requestId);
        reject(new Error('字幕请求超时。'));
      }, 15_000);
      captionRequests.set(requestId, { resolve, reject, timeout });
      window.postMessage({ channel: PAGE_CHANNEL, direction: 'to-page', type: 'CAPTION_FETCH', payload: { requestId, url } }, location.origin);
    });

    const sendPlayerCommand = (command: PlayerCommand) => {
      window.postMessage({ channel: PAGE_CHANNEL, direction: 'to-page', type: 'PLAYER_COMMAND', payload: command }, location.origin);
    };

    const contextSignature = () => {
      const firstCue = state.cues[0];
      const lastCue = state.cues.at(-1);
      return [
        state.youtubeId || '',
        state.activeTrackId || '',
        state.cues.length,
        firstCue?.startMs || 0,
        firstCue?.text || '',
        lastCue?.endMs || 0,
        lastCue?.text || '',
      ].join(':');
    };

    const publish = () => {
      if (ctx.isInvalid) return;
      playerUi?.update(state);
      const nextSignature = contextSignature();
      if (nextSignature !== lastContextSignature) {
        lastContextSignature = nextSignature;
        void runtimeApiCall(() => browser.runtime.sendMessage({ type: 'PAGE_CONTEXT_CHANGED', page: state } satisfies RuntimeMessage)).then(response => { unwrapRuntimeResponse(response); }).catch(() => {
          if (lastContextSignature === nextSignature) lastContextSignature = '';
        });
      }
    };

    const loadTrack = async (track: CaptionTrack | null, youtubeId: string | null, forceRefresh = false) => {
      if (ctx.isInvalid) return;
      if (!track || !youtubeId) {
        selectedTrack = null;
        state = { ...state, activeTrackId: null, cues: [], segments: [] };
        publish();
        return;
      }
      const key = `${youtubeId}:${track.id}`;
      if (!forceRefresh && key === captionLoadKey && state.cues.length) return;
      if (key === captionLoadingKey) return;
      if (key !== captionLoadKey) captionRetryAttempts = 0;
      captionLoadKey = key;
      captionLoadingKey = key;
      selectedTrack = track;
      const { error: _previousError, ...stateWithoutError } = state;
      state = { ...stateWithoutError, activeTrackId: track.id, cues: [], segments: [] };
      publish();
      let hasCachedCues = false;
      try {
        if (!forceRefresh) {
          const shared = unwrapRuntimeResponse(await browser.runtime.sendMessage({ type: 'CAPTION_CACHE_GET', videoKey: youtubeId, trackId: track.id } satisfies RuntimeMessage)) as CaptionCache | null;
          if (ctx.isInvalid || captionLoadKey !== key) return;
          // Recover pre-upgrade captions stored under the video site origin.
          const cached = shared?.trackId === track.id ? shared : await db.captions.get(captionCacheId(youtubeId, track.id));
          if (ctx.isInvalid || captionLoadKey !== key) return;
          if (cached?.cues.length) {
            const cues = normalizeCues(cached.cues);
            state = { ...state, activeTrackId: track.id, cues, segments: cuesToLearningSegments(cues, { allowOverlap: true }) };
            hasCachedCues = cues.length > 0;
            publish();
          }
        }
        const cues = normalizeCues(await fetchCaptionTrack(track.baseUrl, fetchCaptionInPage));
        if (ctx.isInvalid || captionLoadKey !== key) return;
        state = { ...state, activeTrackId: track.id, cues, segments: cuesToLearningSegments(cues, { allowOverlap: true }) };
        captionRetryAttempts = 0;
      } catch (error) {
        if (ctx.isInvalid || captionLoadKey !== key) return;
        if (hasCachedCues) {
          captionRetryAttempts = 0;
          publish();
          return;
        }
        state = { ...state, error: error instanceof Error ? error.message : String(error) };
        captionRetryAttempts += 1;
        if (captionRetryAttempts <= 5) {
          const delay = Math.min(30_000, 2 ** (captionRetryAttempts - 1) * 2_000);
          ctx.setTimeout(() => { if (captionLoadKey === key && !state.cues.length) void loadTrack(track, youtubeId); }, delay);
        }
      } finally {
        if (captionLoadingKey === key) captionLoadingKey = '';
      }
      publish();
    };

    const selectTrack = async (trackId: string) => {
      const track = state.tracks.find((item) => item.id === trackId) || null;
      await loadTrack(track, state.youtubeId);
    };
    const retryCaptions = async () => {
      captionRetryAttempts = 0;
      captionLoadKey = '';
      await loadTrack(selectedTrack || chooseEnglishCaptionTrack(state.tracks), state.youtubeId, true);
    };
    playerUi = createYoutubePlayerUi({ page: state, onCommand: sendPlayerCommand, onSelectTrack: selectTrack, onRetryCaptions: retryCaptions });
    const attachPlayerUi = () => {
      if (ctx.isInvalid || !playerUi) return;
      const player = document.querySelector<HTMLElement>('#movie_player.html5-video-player, .html5-video-player');
      if (!player || playerUi?.host.parentElement === player) return;
      player.append(playerUi!.host);
    };
    attachPlayerUi();
    const attachTimer = ctx.setInterval(attachPlayerUi, 800);
    ctx.addEventListener(document, 'yt-navigate-finish', attachPlayerUi);

    ctx.addEventListener(window, 'message', (event) => {
      if (ctx.isInvalid) return;
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data as { channel?: string; direction?: string; type?: string; payload?: unknown };
      if (message.channel !== PAGE_CHANNEL || message.direction !== 'from-page') return;
      if (message.type === 'CAPTION_FETCH_RESULT') {
        const result = message.payload as CaptionFetchResult | null;
        if (!result || typeof result.requestId !== 'string') return;
        const pending = captionRequests.get(result.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeout);
        captionRequests.delete(result.requestId);
        if (result.ok === true && typeof result.status === 'number' && typeof result.body === 'string') {
          pending.resolve({ ok: true, status: result.status, text: async () => result.body as string });
        } else {
          pending.resolve({ ok: false, status: typeof result.status === 'number' ? result.status : 0, text: async () => '' });
        }
        return;
      }
      if (message.type !== 'PLAYER_STATE' || !message.payload) return;
      const incoming = sanitizeBridgeState(message.payload);
      if (!incoming) return;
      const videoChanged = incoming.youtubeId !== state.youtubeId;
      const { canonicalUrl: _canonicalUrl, channelTitle: _channelTitle, channelId: _channelId, isLive: _isLive, playabilityStatus: _playabilityStatus, selectedText: _selectedText, error: _error, ...requiredState } = state;
      state = {
        ...requiredState,
        youtubeId: incoming.youtubeId,
        ...(incoming.canonicalUrl ? { canonicalUrl: incoming.canonicalUrl } : {}),
        title: incoming.title,
        ...(incoming.channelTitle ? { channelTitle: incoming.channelTitle } : {}),
        ...(incoming.channelId ? { channelId: incoming.channelId } : {}),
        durationMs: incoming.durationMs,
        ...(typeof incoming.isLive === 'boolean' ? { isLive: incoming.isLive } : {}),
        ...(incoming.playabilityStatus ? { playabilityStatus: incoming.playabilityStatus } : {}),
        playerState: incoming.playerState,
        timeMs: incoming.timeMs,
        playbackRate: incoming.playbackRate,
        tracks: incoming.tracks,
        ...(videoChanged ? { cues: [], segments: [], activeTrackId: null } : {}),
        ...(!videoChanged && _selectedText ? { selectedText: _selectedText } : {}),
        ...(!videoChanged && _error ? { error: _error } : {}),
      };
      if (videoChanged || !selectedTrack || !incoming.tracks.some((track) => track.id === selectedTrack?.id)) {
        void loadTrack(chooseEnglishCaptionTrack(incoming.tracks), incoming.youtubeId);
      }
      publish();
    });

    ctx.addEventListener(document, 'selectionchange', () => {
      if (ctx.isInvalid) return;
      const selection = document.getSelection()?.toString().replace(/\s+/g, ' ').trim() || '';
      if (selection.length > 0 && selection.length <= 500) {
        state = { ...state, selectedText: selection };
        publish();
      }
    });

    const onRuntimeMessage = async (message: RuntimeMessage) => {
      if (ctx.isInvalid) return;
      if (message.type === 'PAGE_GET_STATE') return state;
      if (message.type === 'PAGE_PLAYER_COMMAND') {
        sendPlayerCommand(message.command);
        return { ok: true };
      }
      if (message.type === 'PAGE_SELECT_TRACK') {
        await selectTrack(message.trackId);
        return state;
      }
      if (message.type === 'PAGE_RETRY_CAPTIONS') {
        await retryCaptions();
        return state;
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(onRuntimeMessage);

    ctx.onInvalidated(() => {
      window.clearInterval(attachTimer);
      captionLoadKey = '';
      captionLoadingKey = '';
      try { browser.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* Expired extension APIs can throw synchronously. */ }
      for (const pending of captionRequests.values()) {
        window.clearTimeout(pending.timeout);
        pending.reject(new Error('页面已关闭。'));
      }
      captionRequests.clear();
      if (browser.runtime.id) playerUi?.destroy();
      else playerUi?.invalidate();
      playerUi = null;
    });
  },
});
