import { z } from 'zod';
import type { CaptionCue } from '@shadow-language/contracts';

export const biliIdentitySchema = z.object({
  epId: z.string().regex(/^\d+$/).optional(), bvid: z.string().regex(/^BV[A-Za-z0-9]{10}$/),
  aid: z.string().regex(/^\d+$/), cid: z.string().regex(/^\d+$/),
  title: z.string().max(300), thumbnailUrl: z.string().max(2000).optional(),
});
export type BiliIdentity = z.infer<typeof biliIdentitySchema>;
export const BILIBILI_AUTO_RETRY_LIMIT = 3;
export function nextBilibiliRetry(attempts: number, now = Date.now()): { attempts: number; retryAt: number } {
  const nextAttempts = Math.max(0, Math.floor(attempts)) + 1;
  return { attempts: nextAttempts, retryAt: now + Math.min(60_000, 5_000 * 2 ** Math.min(nextAttempts - 1, 4)) };
}
export function biliKey(value: BiliIdentity): string {
  return `bilibili:${value.epId ? `ep:${value.epId}` : `bv:${value.bvid}`}:cid:${value.cid}`;
}
export function videoDurationMs(video: HTMLVideoElement | null): number {
  const duration = video?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0;
}
export function nativeBiliCues(body: unknown): CaptionCue[] {
  const parsed = z.array(z.object({ from: z.number().finite().nonnegative(), to: z.number().finite().positive(), content: z.string().min(1).max(2000) })).max(20000).parse(body);
  return parsed.filter(cue => cue.to > cue.from).sort((a,b) => a.from - b.from).map((cue,seq) => ({ seq, startMs: Math.round(cue.from*1000), endMs: Math.round(cue.to*1000), text: cue.content.replace(/<[^>]*>/g, '').trim() })).filter(cue => cue.text);
}
export function subtitleCdnUrl(raw: string): string {
  const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  if (url.protocol !== 'https:' || !/(^|\.)hdslb\.com$/.test(url.hostname)) throw new Error('字幕地址不受支持。');
  return url.href;
}
export function videoContentBounds(video: HTMLVideoElement, parent: HTMLElement) {
  const v = video.getBoundingClientRect(), p = parent.getBoundingClientRect();
  const ratio = video.videoWidth / video.videoHeight;
  const width = ratio > 0 ? Math.min(v.width, v.height * ratio) : v.width;
  const height = ratio > 0 ? width / ratio : v.height;
  return { left: v.left - p.left + (v.width-width)/2, top: v.top-p.top+(v.height-height)/2, width, height };
}
