import { z } from 'zod';

export const bilibiliVideoKeySchema = z.string().regex(/^bilibili:(?:ep:\d+|bv:BV[A-Za-z0-9]{10}):cid:\d+$/);
/** Self-hosted media assets use their corpus item id, which may be a short source id such as `b0001`. */
export const mediaVideoKeySchema = z.string().regex(/^media:[^\s/?#]{4,128}$/);
export type VideoIdentity = { youtubeId?: string | null | undefined; videoKey?: string | null | undefined };

/** Legacy YouTube keys remain unchanged so existing progress is not orphaned. */
export function videoKeyOf(value: VideoIdentity): string {
  return value.videoKey || value.youtubeId || '';
}

/** Media ids embed the source provider + id, e.g. `media:youtube-d0yGdNEWdn0`. */
export function mediaYoutubeId(key: string): string | undefined {
  if (!key.startsWith('media:')) return;
  return /^media:youtube-([A-Za-z0-9_-]{11})$/.exec(key)?.[1];
}

export function videoIdentity(key: string): { videoKey: string } | { youtubeId: string } {
  if (key.startsWith('media:')) return { videoKey: mediaVideoKeySchema.parse(key) };
  if (key.startsWith('bilibili:')) return { videoKey: bilibiliVideoKeySchema.parse(key) };
  if (!/^[A-Za-z0-9_-]{11}$/.test(key)) throw new Error('视频 ID 无效。');
  return { youtubeId: key };
}

export function videoUrl(key: string, startMs = 0): string {
  videoIdentity(key);
  const seconds = Math.max(0, Math.floor(startMs / 1000));
  const ep = /^bilibili:ep:(\d+):cid:(\d+)$/.exec(key);
  if (ep) return `https://www.bilibili.com/bangumi/play/ep${ep[1]}?t=${seconds}`;
  const bv = /^bilibili:bv:(BV[A-Za-z0-9]{10}):cid:(\d+)$/.exec(key);
  if (bv) return `https://www.bilibili.com/video/${bv[1]}/?cid=${bv[2]}&t=${seconds}`;
  const mediaId = mediaYoutubeId(key);
  if (mediaId) return `https://www.youtube.com/watch?v=${mediaId}&t=${seconds}s`;
  // Other self-hosted media has no external watch URL; callers may fall back to page.canonicalUrl.
  if (key.startsWith('media:')) return '';
  return `https://www.youtube.com/watch?v=${key}&t=${seconds}s`;
}

export function videoThumbnail(value: VideoIdentity & { thumbnailUrl?: string | null | undefined }): string {
  if (value.thumbnailUrl && /^https:\/\/(?:[\w-]+\.)?(?:hdslb\.com|ytimg\.com)\//.test(value.thumbnailUrl)) return value.thumbnailUrl;
  const key = videoKeyOf(value);
  // Self-hosted corpus covers are published on our CloudBase Hosting CDN.
  if (key.startsWith('media:') && value.thumbnailUrl && /^https:\/\/(?:language\.honi\.pro|[\w-]+\.tcb\.qcloud\.la)\/media-corpus\/items\//.test(value.thumbnailUrl)) return value.thumbnailUrl;
  const youtubeId = mediaYoutubeId(key) || (/^[A-Za-z0-9_-]{11}$/.test(key) ? key : undefined);
  return youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : '';
}
