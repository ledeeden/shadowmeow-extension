const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const BILIBILI_VIDEO_PATH = /^\/video\/BV[A-Za-z0-9]{10}(?:\/|$)/;
const BILIBILI_BANGUMI_PATH = /^\/bangumi\/play\/(?:ep|ss)\d+(?:\/|$)/;

/**
 * The native side panel is a companion to an active learning video, not a
 * second navigation surface for the extension dashboard or the wider web.
 */
export function isSidePanelLearningUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname === 'youtube.com') {
      return url.pathname === '/watch' && YOUTUBE_VIDEO_ID.test(url.searchParams.get('v') || '');
    }
    if (hostname === 'bilibili.com') {
      return BILIBILI_VIDEO_PATH.test(url.pathname) || BILIBILI_BANGUMI_PATH.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}
