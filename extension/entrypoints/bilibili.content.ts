import '../lib/crypto-polyfill';
import { cuesToLearningSegments, mappedSubtitleCues, subtitleResolutionSchema, videoUrl, type CaptionCue, type PageState, type PlayerCommand, type RuntimeMessage, randomId } from '@shadow-language/contracts';
import { BILIBILI_AUTO_RETRY_LIMIT, biliIdentitySchema, biliKey, nativeBiliCues, nextBilibiliRetry, videoContentBounds, videoDurationMs } from '../lib/bilibili';
import { createPlayerUi, type YoutubePlayerUi } from '../components/youtube-player-ui';
import { runtimeApiCall, unwrapRuntimeResponse } from '../lib/runtime-errors';

const channel = 'shadow-language-bilibili-v1';
const empty = (): PageState => ({ youtubeId:null, platform:'bilibili', title:'', durationMs:0, playerState:'paused', timeMs:0, playbackRate:1, tracks:[], activeTrackId:null, cues:[], translationCues:[], segments:[] });

export default defineContentScript({
  matches:['https://www.bilibili.com/video/*','https://www.bilibili.com/bangumi/play/*'], runAt:'document_start',
  async main(ctx) {
    await injectScript('/bilibili-main-world.js', { keepInDom:true });
    if (ctx.isInvalid) return;
    let state = empty(), requestId = '', route = '', loading = false, generation = 0;
    let ui: YoutubePlayerUi | null = null, video: HTMLVideoElement | null = null;
    let timeout = 0, attempts = 0, retryAt = 0, cloudLoadedAt = 0;
    let lastContextSignature = '';
    const contextSignature = () => {
      const firstCue = state.cues[0];
      const lastCue = state.cues.at(-1);
      return [
        state.videoKey || '',
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
      ui?.update(state);
      const nextSignature = contextSignature();
      if (nextSignature !== lastContextSignature) {
        lastContextSignature = nextSignature;
        void runtimeApiCall(() => browser.runtime.sendMessage({ type: 'PAGE_CONTEXT_CHANGED', page: state } satisfies RuntimeMessage)).then(response => { unwrapRuntimeResponse(response); }).catch(() => {
          if (lastContextSignature === nextSignature) lastContextSignature = '';
        });
      }
    };
    const command = (value: PlayerCommand) => {
      if (!video || !state.videoKey) return;
      if (value.type === 'SEEK') video.currentTime = Math.max(0, Math.min(video.duration, value.timeMs / 1000));
      if (value.type === 'PLAY') void video.play().catch(() => undefined);
      if (value.type === 'PAUSE') video.pause();
      if (value.type === 'SET_RATE' && value.rate >= .25 && value.rate <= 3) video.playbackRate = value.rate;
    };
    const fail = (error: string) => {
      loading = false; const retry = nextBilibiliRetry(attempts); attempts = retry.attempts; retryAt = retry.retryAt;
      state = { ...state, error: /action: Invalid enum|未知操作|Unknown action/.test(error) ? '云端字幕服务尚未更新，请稍后重试。' : error }; publish();
    };
    const load = () => {
      if (ctx.isInvalid) return;
      if (localPreview || loading || !video || videoDurationMs(video) < 1) return;
      loading = true; requestId = randomId(); generation += 1;
      const id = requestId;
      const { error: _error, ...stateWithoutError } = state;
      state = stateWithoutError; publish();
      window.clearTimeout(timeout);
      timeout = ctx.setTimeout(() => { if (requestId === id) fail('字幕请求超时，点击重试。'); }, 35000);
      window.postMessage({channel,direction:'to-page',type:'LOAD',requestId},location.origin);
    };
    const retry = async () => { loading = false; attempts = 0; load(); };
    ui = createPlayerUi({page:state,onCommand:command,onSelectTrack:async()=>undefined,onRetryCaptions:retry});
    const currentRoute = () => location.pathname + location.search;
    const tick = () => {
      if (ctx.isInvalid || !ui) return;
      const nextVideo = Array.from(document.querySelectorAll<HTMLVideoElement>('video')).find(v => v.clientWidth > 100 && v.clientHeight > 100) || null;
      const nextRoute = currentRoute();
      if (nextRoute !== route || nextVideo !== video) {
        localPreview = false; route = nextRoute; video = nextVideo; generation += 1; requestId = ''; loading = false; attempts = 0; retryAt = 0; cloudLoadedAt = 0;
        window.clearTimeout(timeout); state = empty();
      }
      const parent = video?.closest<HTMLElement>('.bpx-player-primary-area, .bilibili-player-video-wrap') || video?.parentElement;
      if (!parent || !video) { ui!.host.remove(); publish(); return; }
      if (ui!.host.parentElement !== parent) {
        if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
        parent.append(ui!.host);
      }
      const duration = videoDurationMs(video);
      state = { ...state, durationMs:duration, timeMs:Math.round(video.currentTime*1000), playerState:video.ended ? 'ended' : video.paused ? 'paused' : 'playing', playbackRate:video.playbackRate, mediaBounds:videoContentBounds(video,parent) };
      // A changed media duration can mean preroll ended or a replaced video edition.
      if (state.cues.length && cloudLoadedAt && Math.abs(duration - loadedDuration) > 2500) { state = {...state,cues:[],segments:[],translationCues:[],activeTrackId:null}; cloudLoadedAt = 0; retryAt = 0; }
      const clock=ui!.host.shadowRoot?.getElementById('sl-preview-clock');if(clock)clock.textContent=`${(state.timeMs/1000).toFixed(2)} / ${(duration/1000).toFixed(2)} 秒`;
      publish();
      if (!loading && duration > 0 && ((!state.cues.length && attempts < BILIBILI_AUTO_RETRY_LIMIT && Date.now() >= retryAt) || (cloudLoadedAt > 0 && Date.now()-cloudLoadedAt > 300000 && attempts < BILIBILI_AUTO_RETRY_LIMIT && Date.now() >= retryAt))) load();
    };
    let loadedDuration = 0;
    let localPreview = false;
    ctx.addEventListener(window,'message', event => {
      if (ctx.isInvalid) return;
      if(event.source !== window || event.origin !== location.origin) return;
      const m = event.data;
      if(m?.channel !== channel || m.direction !== 'from-page' || m.requestId !== requestId || m.route !== currentRoute()) return;
      if(typeof m.error === 'string') { window.clearTimeout(timeout); fail(m.error.slice(0,500)); return; }
      const parsed = biliIdentitySchema.safeParse(m.identity);
      if(!parsed.success) return;
      const key = biliKey(parsed.data);
      if(m.phase === 'identity') {
        state = { ...state, ...(state.videoKey !== key ? {cues:[],segments:[],translationCues:[],activeTrackId:null} : {}), videoKey:key, canonicalUrl:videoUrl(key), title:parsed.data.title, ...(parsed.data.thumbnailUrl ? {thumbnailUrl:parsed.data.thumbnailUrl} : {}), channelTitle:'Bilibili' }; publish(); return;
      }
      if(m.phase !== 'captions' || !Array.isArray(m.captions)) return;
      window.clearTimeout(timeout);
      const activeGeneration = generation;
      void (async () => {
        try {
          let en: CaptionCue[] = [], zh: CaptionCue[] = [];
          for(const track of m.captions.slice(0,2)) {
            if(track.language === 'en') en = nativeBiliCues(track.body);
            if(track.language === 'zh-Hans') zh = nativeBiliCues(track.body);
          }
          if(en.length) {
            const {error: _error, ...clean} = state;
            state = {...clean, cues:en,translationCues:zh,segments:cuesToLearningSegments(en),activeTrackId:`bili-native:${key}`,subtitleSource:'B 站字幕'};
            cloudLoadedAt = 0;
          } else {
            const durationMs = videoDurationMs(video);
            if (durationMs < 1) {
              if (ctx.isInvalid || activeGeneration !== generation || state.videoKey !== key) return;
              loading = false;
              retryAt = Date.now() + 1000;
              const { error: _error, ...stateWithoutError } = state;
              state = stateWithoutError;
              publish();
              return;
            }
            if (state.durationMs !== durationMs) state = { ...state, durationMs };
            const raw = unwrapRuntimeResponse(await browser.runtime.sendMessage({type:'CORPUS_RESOLVE_SUBTITLES',videoKey:key,durationMs} satisfies RuntimeMessage)) as {status:string};
            if(ctx.isInvalid || activeGeneration !== generation || state.videoKey !== key) return;
            if (raw.status === 'not_ready') {
              loading = false;
              const retry = nextBilibiliRetry(attempts);
              attempts = retry.attempts;
              retryAt = retry.retryAt;
              const { error: _error, ...stateWithoutError } = state;
              state = stateWithoutError;
              publish();
              return;
            }
            if(raw.status !== 'available') {
              state = {...state,cues:[],segments:[],translationCues:[],activeTrackId:null};
              cloudLoadedAt = 0;
              throw new Error(raw.status === 'version_mismatch' ? '当前视频版本与字幕时长不匹配。请切换正片后重试。' : (m.nativeError ? `${m.nativeError}；语料库暂无对应字幕。` : '语料库暂未收录这集字幕。'));
            }
            const result = subtitleResolutionSchema.parse(raw);
            if(result.binding.videoKey !== key) throw new Error('字幕关联校验失败。');
            en = mappedSubtitleCues(result,'en'); zh = mappedSubtitleCues(result,'zh-Hans');
            if(!en.length) throw new Error('这份字幕尚无英文轨道。');
            const {error: _error, ...clean} = state;
            state = {...clean,cues:en,translationCues:zh,segments:cuesToLearningSegments(en),activeTrackId:`subtitle:${result.package.assetId}:${result.package.revision}`,subtitleSource:`语料库 · ${result.package.attribution}`};
            cloudLoadedAt = Date.now(); loadedDuration = state.durationMs;
          }
          loading = false; attempts = 0; publish();
        } catch(error) { if(activeGeneration === generation) fail(error instanceof Error ? error.message : '字幕读取失败。'); }
      })();
    });
    const listener = async (m: RuntimeMessage) => {
      if (ctx.isInvalid) return;
      if(m.type === 'PAGE_GET_STATE') return state;
      if(m.type === 'PAGE_PLAYER_COMMAND') { command(m.command); return {ok:true}; }
      if(m.type === 'PAGE_RETRY_CAPTIONS') { await retry(); return state; }
      if(m.type === 'AUTH_CHANGED' && !localPreview) {
        await retry();
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(listener);
    if(new URL(location.href).searchParams.get('sl-preview') === '1') {
      const label = document.createElement('label');
      label.textContent = '选择本地字幕预览 ';
      Object.assign(label.style,{position:'absolute',top:'65px',left:'12px',color:'white',background:'#18241f',padding:'8px',pointerEvents:'auto',fontSize:'12px'});
      const jumpBar = document.createElement('span');
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json'; input.style.width = '180px';
      input.addEventListener('change',async () => {
        try {
          const file = input.files?.[0]; if(!file || file.size > 720000) throw new Error('预览文件过大或未选择。');
          const result = subtitleResolutionSchema.parse(JSON.parse(await file.text()));
          if(result.binding.videoKey !== state.videoKey || Math.abs(result.binding.durationMs-state.durationMs)>2500) throw new Error('预览字幕与当前视频不匹配。');
          generation += 1; requestId=''; loading=false; window.clearTimeout(timeout); localPreview=true;
          const en=mappedSubtitleCues(result,'en'),zh=mappedSubtitleCues(result,'zh-Hans');
          const {error:_error,...clean}=state;
          state={...clean,cues:en,translationCues:zh,segments:cuesToLearningSegments(en),activeTrackId:`preview:${result.package.assetId}:${result.package.revision}`,subtitleSource:'本地预览 · 尚未发布'};
          if(video) { video.pause(); video.currentTime = (en[0]!.startMs+600)/1000; }
          jumpBar.replaceChildren();
          for(const [name,index] of [['开头',0],['中段',Math.floor(en.length/2)],['结尾',en.length-1]] as const) {
            const button=document.createElement('button');button.textContent=name;button.style.marginLeft='6px';
            button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(video){video.pause();video.currentTime=(en[index]!.startMs+600)/1000;}});jumpBar.append(button);
          }
          const clock=document.createElement('span');clock.id='sl-preview-clock';clock.style.marginLeft='8px';jumpBar.append(clock);
          publish(); label.firstChild!.textContent = '本地预览中 ';
        } catch(error) { fail(error instanceof Error ? error.message : '预览文件无效。'); }
      });
      label.addEventListener('click',event=>event.stopPropagation());
      label.append(input,jumpBar); ui.host.shadowRoot!.append(label);
    }
    const timer = ctx.setInterval(tick,200); tick();
    ctx.onInvalidated(() => {
      generation += 1;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
      try { browser.runtime.onMessage.removeListener(listener); } catch { /* Expired extension APIs can throw synchronously. */ }
      if (browser.runtime.id) ui?.destroy();
      else ui?.invalidate();
      ui = null;
    });
  },
});
