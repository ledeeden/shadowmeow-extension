// Small page bridge: session-aware public metadata/subtitle reads only. No CloudBase actions.
import { timeoutSignal } from '@shadow-language/contracts';

export default defineUnlistedScript(() => {
  const channel = 'shadow-language-bilibili-v1';
  type PageState = { __INITIAL_STATE__?: { epInfo?: Record<string, unknown>; mediaInfo?: Record<string, unknown> } };
  const page = window as unknown as PageState;
  const pageRoute = () => location.pathname + location.search;
  const numericId = (value: unknown): string | undefined => {
    const text = typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : typeof value === 'string' ? value : '';
    return /^\d+$/.test(text) ? text : undefined;
  };
  const episodeIdFromHref = (value: unknown): string | undefined => typeof value === 'string' ? value.match(/\/ep(\d+)/)?.[1] : undefined;
  const episodeIdFromNode = (node: Element | null): string | undefined => {
    if (!node) return undefined;
    return episodeIdFromHref(node.getAttribute('href')) || numericId(node.getAttribute('data-ep-id')) || numericId(node.getAttribute('data-episode-id'));
  };
  const playerEpisodeNumber = (): number | undefined => {
    const playerText = [
      document.querySelector('.bpx-player-primary-area')?.parentElement?.textContent,
      document.querySelector('.bpx-player-container')?.textContent,
      document.querySelector('.bilibili-player')?.textContent,
    ].filter((value): value is string => Boolean(value)).join(' ');
    // On a season page B 站 may expose the restored episode only in the
    // selector summary, e.g. "正片 (4/22)", not in the player DOM.
    const pageText = document.body.textContent?.replace(/\s+/g, ' ') || '';
    const match = pageText.match(/正片\s*\(\s*(\d+)\s*\/\s*\d+\s*\)/)
      || playerText.match(/第\s*(\d+)\s*集/)
      || pageText.match(/第\s*(\d+)\s*集/);
    const number = match ? Number(match[1]) : NaN;
    return Number.isInteger(number) && number > 0 ? number : undefined;
  };
  const playerSeasonEpisodeId = (): string | undefined => {
    const number = playerEpisodeNumber();
    if (!number) return undefined;
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/bangumi/play/ep"]'));
    const link = links.find(candidate => {
      const text = candidate.textContent?.replace(/\s+/g, ' ').trim() || '';
      return new RegExp(`^(?:第\\s*)?${number}(?:\\s*(?:集|会员|限免))?(?:\\s|$)`).test(text);
    });
    return episodeIdFromNode(link || null);
  };
  const selectedSeasonEpisodeId = (): string | undefined => {
    const selectors = [
      'a.ep-item.cursor.active', 'a.ep-item.cursor.on', 'a.ep-item.active', 'a.ep-item.on',
      '.ep-item.active a', '.ep-item.on a', '.ep-list-wrapper .active a', '.ep-list-wrapper .on a',
      'a[aria-current="page"][href*="/ep"]', 'a[aria-selected="true"][href*="/ep"]',
    ];
    for (const selector of selectors) {
      const id = episodeIdFromNode(document.querySelector(selector));
      if (id) return id;
    }
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('a[href*="/ep"], [data-ep-id], [data-episode-id]'));
    const marked = candidates.find(node => {
      const ownClass = typeof node.className === 'string' ? node.className : '';
      const parentClass = typeof node.parentElement?.className === 'string' ? node.parentElement.className : '';
      return node.matches('[aria-current="page"], [aria-selected="true"]') || /\b(active|on|current|selected)\b/.test(`${ownClass} ${parentClass}`);
    });
    return episodeIdFromNode(marked || null);
  };
  const stateSeasonEpisodeId = (seasonPath: string): string | undefined => {
    const initial = page.__INITIAL_STATE__;
    const epInfo = initial?.epInfo || {};
    const mediaInfo = initial?.mediaInfo || {};
    const seasonIds = [mediaInfo.season_id, mediaInfo.seasonId, epInfo.season_id, epInfo.seasonId].map(numericId).filter((value): value is string => Boolean(value));
    if (seasonIds.length && !seasonIds.includes(seasonPath)) return undefined;
    return [epInfo.id, epInfo.ep_id, epInfo.epId, mediaInfo.ep_id, mediaInfo.epId, mediaInfo.episode_id, mediaInfo.episodeId].map(numericId).find(Boolean);
  };
  const currentSeasonEpisodeId = (seasonPath: string): string | undefined => playerSeasonEpisodeId() || selectedSeasonEpisodeId() || stateSeasonEpisodeId(seasonPath);
  const waitForSeasonEpisode = async (seasonPath: string, route: string): Promise<string | null> => {
    const deadline = Date.now() + 15000;
    let candidate = '';
    let candidateSince = 0;
    while (Date.now() < deadline) {
      if (pageRoute() !== route) return null;
      const next = currentSeasonEpisodeId(seasonPath) || '';
      if (next !== candidate) { candidate = next; candidateSince = Date.now(); }
      if (candidate && Date.now() - candidateSince >= 600) return candidate;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return pageRoute() === route ? currentSeasonEpisodeId(seasonPath) || '' : null;
  };
  const json = async (url: string) => {
    const response = await fetch(url, { credentials: 'include', signal: timeoutSignal(12000) });
    if (!response.ok) throw new Error(`B 站请求失败 (${response.status})`);
    return response.json();
  };
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const m = event.data;
    if (m?.channel !== channel || m.direction !== 'to-page' || typeof m.requestId !== 'string' || m.type !== 'LOAD') return;
    const route = pageRoute();
    const reply = (payload: unknown) => window.postMessage({ channel, direction:'from-page', requestId:m.requestId, route, ...payload as object }, location.origin);
    try {
      const epPath = location.pathname.match(/\/bangumi\/play\/ep(\d+)/)?.[1];
      const seasonPath = location.pathname.match(/\/bangumi\/play\/ss(\d+)/)?.[1];
      const bvPath = location.pathname.match(/\/video\/(BV[A-Za-z0-9]{10})/)?.[1];
      let epId = epPath;
      if (seasonPath) {
        // B 站 keeps the season URL while restoring the last played episode.
        // The selected item/state is populated asynchronously, so wait for it
        // instead of treating the ss URL as the episode identity.
        const restored = await waitForSeasonEpisode(seasonPath, route);
        if (restored === null) return;
        epId = restored;
        if (!epId) { reply({ error:'B 站正在恢复当前集，请稍后重试。' }); return; }
      }
      let identity: Record<string,unknown>;
      if (epId) {
        const data = await json(`https://api.bilibili.com/pgc/view/web/season?ep_id=${epId}`);
        if (data.code !== 0) throw new Error(`B 站剧集信息暂不可用 (${data.code})`);
        const ep = data.result?.episodes?.find((x: { id: number }) => String(x.id) === epId);
        if (!ep?.cid || !ep?.bvid) throw new Error('无法确认当前集数。');
        identity = { epId, bvid:ep.bvid, aid:String(ep.aid), cid:String(ep.cid), title:`${data.result.title} 第${ep.title}集${ep.long_title ? ` · ${ep.long_title}` : ''}`, thumbnailUrl:String(ep.cover || data.result.cover || '').replace(/^http:/,'https:') };
      } else if (bvPath) {
        const data = await json(`https://api.bilibili.com/x/web-interface/view?bvid=${bvPath}`);
        if (data.code !== 0) throw new Error(`B 站视频信息暂不可用 (${data.code})`);
        const part = Math.max(1, Number(new URL(location.href).searchParams.get('p')) || 1);
        const clip = data.data?.pages?.find((x: { page:number }) => x.page === part);
        if (!clip?.cid) throw new Error('无法确认当前分 P。');
        identity = { bvid:bvPath, aid:String(data.data.aid), cid:String(clip.cid), title:data.data.title, thumbnailUrl:String(data.data.pic || '').replace(/^http:/,'https:') };
      } else return;
      if (route !== location.pathname + location.search) return;
      reply({ identity, phase:'identity' });
      try {
        const player = await json(`https://api.bilibili.com/x/player/wbi/v2?aid=${identity.aid}&cid=${identity.cid}`);
        if (player.code !== 0) throw new Error(`字幕列表请求失败 (${player.code})`);
        const tracks = (player.data?.subtitle?.subtitles || []).filter((x: {lan:string}) => /^(en|zh)(-|$)/.test(x.lan));
        const chosen = ['en','zh'].map(lang => tracks.find((x: {lan:string}) => x.lan === lang || x.lan === `${lang}-Hans`) || tracks.find((x:{lan:string}) => x.lan.startsWith(`${lang}-`))).filter(Boolean);
        const captions = await Promise.all(chosen.map(async (track: {lan:string;subtitle_url:string}) => {
          const url = new URL(track.subtitle_url.startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url);
          if (url.protocol !== 'https:' || !/(^|\.)hdslb\.com$/.test(url.hostname)) throw new Error('字幕地址不受支持。');
          const result = await json(url.href);
          return { language:track.lan.startsWith('en') ? 'en' : 'zh-Hans', body:result.body };
        }));
        reply({ identity, phase:'captions', captions });
      } catch (error) { reply({ identity, phase:'captions', captions:[], nativeError:error instanceof Error ? error.message : '字幕读取失败' }); }
    } catch(error) { reply({ error:error instanceof Error ? error.message : 'B 站字幕读取失败。' }); }
  });
});
