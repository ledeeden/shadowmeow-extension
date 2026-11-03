import { PAGE_CHANNEL } from '../lib/constants';
import { canonicalYoutubeUrl, selectCurrentPlayerResponse, youtubeVideoIdFromLocation } from '../lib/youtube-player-state';
import { applyCaptionProofToken, extractCaptionProofToken, selectNativeCaptionTrack, type NativeCaptionTrack } from '../lib/youtube-proof-token';
import { classifyYoutubeCaptionTrack } from '../lib/youtube-track';

type YoutubePlayerResponse = {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
    channelId?: string;
    isLiveContent?: boolean;
  };
  playabilityStatus?: { status?: string; reason?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl: string;
        vssId?: string;
        languageCode?: string;
        kind?: string;
        isTranslatable?: boolean;
        name?: { simpleText?: string; runs?: Array<{ text?: string }> };
      }>;
    };
  };
};

declare global {
  interface Window {
    ytInitialPlayerResponse?: YoutubePlayerResponse;
    ytplayer?: { config?: { args?: { player_response?: string } } };
  }
}

type YoutubePlayerElement = HTMLElement & {
  getPlayerResponse?: () => YoutubePlayerResponse;
  getOption?: (module: string, option: string, options?: Record<string, unknown>) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
  isSubtitlesOn?: () => boolean;
  toggleSubtitles?: () => void;
};

type CaptionFetchRequest = { requestId?: unknown; url?: unknown };

function isAllowedCaptionUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))
      && url.pathname === '/api/timedtext';
  } catch {
    return false;
  }
}

function getPlayerResponse(): YoutubePlayerResponse | null {
  const urlVideoId = youtubeVideoIdFromLocation(location.pathname, new URL(location.href).searchParams.get('v'));
  if (!urlVideoId) return null;
  const playerResponse = (document.getElementById('movie_player') as YoutubePlayerElement | null)?.getPlayerResponse?.();
  const raw = window.ytplayer?.config?.args?.player_response;
  let configResponse: YoutubePlayerResponse | null = null;
  if (raw) try { configResponse = JSON.parse(raw) as YoutubePlayerResponse; } catch { configResponse = null; }
  return selectCurrentPlayerResponse(urlVideoId, [playerResponse, window.ytInitialPlayerResponse, configResponse]);
}

function readState() {
  const response = getPlayerResponse();
  const video = document.querySelector<HTMLVideoElement>('video.html5-main-video, video');
  const urlVideoId = youtubeVideoIdFromLocation(location.pathname, new URL(location.href).searchParams.get('v'));
  const videoId = response?.videoDetails?.videoId || urlVideoId;
  const captionTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return {
    youtubeId: videoId,
    canonicalUrl: canonicalYoutubeUrl(location.origin, location.pathname, location.href, videoId),
    title: response?.videoDetails?.title || document.title.replace(/\s*-\s*YouTube\s*$/, ''),
    channelTitle: response?.videoDetails?.author,
    channelId: response?.videoDetails?.channelId,
    durationMs: Number.isFinite(video?.duration) ? Math.round((video?.duration || 0) * 1000) : Number(response?.videoDetails?.lengthSeconds || 0) * 1000,
    timeMs: Math.round((video?.currentTime || 0) * 1000),
    playbackRate: video?.playbackRate || 1,
    playerState: video?.ended ? 'ended' : video?.paused ? 'paused' : 'playing',
    isLive: Boolean(response?.videoDetails?.isLiveContent),
    playabilityStatus: response?.playabilityStatus?.status,
    tracks: captionTracks.map((track, index) => ({
      id: track.vssId || `${track.languageCode || 'unknown'}-${index}`,
      language: track.languageCode || '',
      label: track.name?.simpleText || track.name?.runs?.map((run) => run.text || '').join('') || track.languageCode || 'Unknown',
      kind: classifyYoutubeCaptionTrack(track),
      baseUrl: track.baseUrl,
      isTranslatable: Boolean(track.isTranslatable),
    })),
  };
}

export default defineUnlistedScript(() => {
  const captionProofTokens = new Map<string, string>();
  const captureCaptionProofToken = (value: string) => {
    const proof = extractCaptionProofToken(value);
    if (proof) captionProofTokens.set(proof.videoId, proof.token);
  };
  for (const entry of performance.getEntriesByType('resource')) captureCaptionProofToken(entry.name);
  const originalXhrOpen = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) => void;
  const patchedXhrOpen = function(this: XMLHttpRequest, method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
    captureCaptionProofToken(String(url));
    return originalXhrOpen.call(this, method, url, async, username, password);
  };
  XMLHttpRequest.prototype.open = patchedXhrOpen as typeof XMLHttpRequest.prototype.open;
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    captureCaptionProofToken(input instanceof Request ? input.url : String(input));
    return originalFetch(input, init);
  }) as typeof window.fetch;

  const waitForCaptionProofToken = async (videoId: string, requestedCaptionUrl: string): Promise<string | null> => {
    captureCaptionProofToken(requestedCaptionUrl);
    let temporarilyEnabledSubtitles = false;
    for (let attempt = 0; !captionProofTokens.has(videoId) && attempt < 3; attempt += 1) {
      const player = document.getElementById('movie_player') as YoutubePlayerElement | null;
      if (attempt === 0 && player?.getOption && player.setOption) {
        const trackList = player.getOption('captions', 'tracklist', { includeAsr: true });
        if (Array.isArray(trackList)) {
          const target = selectNativeCaptionTrack(trackList as NativeCaptionTrack[], requestedCaptionUrl);
          if (target) {
            const subtitleButton = document.querySelector<HTMLElement>('.ytp-subtitles-button');
            const subtitlesWereOn = player.isSubtitlesOn?.()
              ?? subtitleButton?.getAttribute('aria-pressed') === 'true';
            player.setOption('captions', 'track', target);
            const subtitlesAreOn = player.isSubtitlesOn?.()
              ?? subtitleButton?.getAttribute('aria-pressed') === 'true';
            if (!subtitlesAreOn && player.toggleSubtitles) {
              player.toggleSubtitles();
              temporarilyEnabledSubtitles = !subtitlesWereOn;
            }
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const token = captionProofTokens.get(videoId) || null;
    if (temporarilyEnabledSubtitles) {
      const player = document.getElementById('movie_player') as YoutubePlayerElement | null;
      const subtitleButton = document.querySelector<HTMLElement>('.ytp-subtitles-button');
      const subtitlesAreOn = player?.isSubtitlesOn?.()
        ?? subtitleButton?.getAttribute('aria-pressed') === 'true';
      if (subtitlesAreOn) player?.toggleSubtitles?.();
    }
    return token;
  };

  let lastEmission = 0;
  const emit = (force = false) => {
    const now = performance.now();
    if (!force && now - lastEmission < 200) return;
    lastEmission = now;
    window.postMessage({ channel: PAGE_CHANNEL, direction: 'from-page', type: 'PLAYER_STATE', payload: readState() }, location.origin);
  };
  const bindVideo = () => {
    const video = document.querySelector<HTMLVideoElement>('video.html5-main-video, video');
    if (!video || video.dataset.shadowLanguageBound === 'true') return;
    video.dataset.shadowLanguageBound = 'true';
    for (const event of ['timeupdate', 'play', 'pause', 'ratechange', 'loadedmetadata', 'ended', 'seeking']) {
      video.addEventListener(event, () => emit(event !== 'timeupdate'), { passive: true });
    }
    emit(true);
  };
  const observer = new MutationObserver(bindVideo);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  bindVideo();
  document.addEventListener('yt-navigate-finish', () => setTimeout(() => emit(true), 250));
  window.addEventListener('popstate', () => setTimeout(() => emit(true), 250));
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data as { channel?: string; direction?: string; type?: string; payload?: unknown };
    if (message.channel !== PAGE_CHANNEL || message.direction !== 'to-page') return;
    if (message.type === 'CAPTION_FETCH') {
      const payload = message.payload as CaptionFetchRequest | null;
      if (!payload || typeof payload.requestId !== 'string' || !isAllowedCaptionUrl(payload.url)) return;
      const requestedCaptionUrl = payload.url;
      void (async () => {
        const requestUrl = new URL(requestedCaptionUrl);
        const videoId = requestUrl.searchParams.get('v');
        const proofToken = videoId ? await waitForCaptionProofToken(videoId, requestedCaptionUrl) : null;
        return originalFetch(applyCaptionProofToken(requestedCaptionUrl, proofToken), { credentials: 'include', cache: 'no-store' });
      })()
        .then(async (response) => {
          window.postMessage({
            channel: PAGE_CHANNEL,
            direction: 'from-page',
            type: 'CAPTION_FETCH_RESULT',
            payload: { requestId: payload.requestId, ok: response.ok, status: response.status, body: await response.text() },
          }, location.origin);
        })
        .catch((error) => {
          window.postMessage({
            channel: PAGE_CHANNEL,
            direction: 'from-page',
            type: 'CAPTION_FETCH_RESULT',
            payload: { requestId: payload.requestId, ok: false, status: 0, error: error instanceof Error ? error.message : String(error) },
          }, location.origin);
        });
      return;
    }
    if (message.type !== 'PLAYER_COMMAND') return;
    const video = document.querySelector<HTMLVideoElement>('video.html5-main-video, video');
    if (!video || !message.payload || typeof message.payload !== 'object') return;
    const command = message.payload as { type?: string; timeMs?: number; rate?: number };
    if (command.type === 'SEEK' && Number.isFinite(command.timeMs) && command.timeMs! >= 0 && command.timeMs! <= Math.max(0, video.duration * 1000 + 1000)) video.currentTime = command.timeMs! / 1000;
    if (command.type === 'PLAY') void video.play();
    if (command.type === 'PAUSE') video.pause();
    if (command.type === 'SET_RATE' && Number.isFinite(command.rate) && command.rate! >= 0.25 && command.rate! <= 3) video.playbackRate = command.rate!;
    emit(true);
  });
  window.postMessage({ channel: PAGE_CHANNEL, direction: 'from-page', type: 'BRIDGE_READY' }, location.origin);
  emit(true);
});
