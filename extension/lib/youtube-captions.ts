import type { CaptionCue } from '@shadow-language/contracts';
import { parseCaptionPayload } from './caption-payload';
export { parseJson3, parseTimedTextXml, parseCaptionPayload } from './caption-payload';

export type CaptionFetchResponse = Pick<Response, 'ok' | 'status' | 'text'>;
export type CaptionFetcher = (url: string) => Promise<CaptionFetchResponse>;

function captionUrl(baseUrl: string, format: 'json3' | 'srv3' | null): string {
  const url = new URL(baseUrl);
  if (format) url.searchParams.set('fmt', format);
  else url.searchParams.delete('fmt');
  return url.toString();
}

export async function fetchCaptionTrack(baseUrl: string, fetcher: CaptionFetcher = (url) => fetch(url, { credentials: 'include', cache: 'no-store' })): Promise<CaptionCue[]> {
  const attempts = ['json3', 'srv3', null] as const;
  let lastStatus: number | null = null;
  for (const format of attempts) {
    const response = await fetcher(captionUrl(baseUrl, format));
    lastStatus = response.status;
    if (!response.ok) continue;
    const cues = parseCaptionPayload(await response.text());
    if (cues.length) return cues;
  }
  const status = lastStatus && lastStatus !== 200 ? `（HTTP ${lastStatus}）` : '';
  throw new Error(`未能读取这条视频的字幕${status}。请确认字幕可用后重试。`);
}
