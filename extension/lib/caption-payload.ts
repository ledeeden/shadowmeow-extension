// Pure subtitle parsing; no transport or persistence.
import type { CaptionCue } from '@shadow-language/contracts';
import { normalizeCaptionText } from '@shadow-language/contracts';

type Json3Response = {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    segs?: Array<{ utf8?: string; tOffsetMs?: number }>;
  }>;
};

type ParsedCaptionEntry = {
  startMs: number;
  durationMs: number | null;
  text: string;
  wordStarts?: CaptionCue['wordStarts'];
};

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function readAttribute(attributes: string, name: string): string | null {
  return attributes.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'))?.[1] ?? null;
}

function materializeEntries(entries: ParsedCaptionEntry[]): CaptionCue[] {
  const starts = [...new Set(entries.map((entry) => entry.startMs))].sort((left, right) => left - right);
  return entries.map((entry, index) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle]! <= entry.startMs) low = middle + 1;
      else high = middle;
    }
    const nextStartMs = starts[low];
    const durationMs = entry.durationMs
      ?? (nextStartMs === undefined ? 2_000 : Math.max(1, nextStartMs - entry.startMs));
    return {
      seq: index,
      startMs: entry.startMs,
      endMs: entry.startMs + durationMs,
      text: entry.text,
      ...(entry.wordStarts?.length ? { wordStarts: entry.wordStarts } : {}),
    };
  });
}

export function parseJson3(payload: Json3Response): CaptionCue[] {
  const entries: ParsedCaptionEntry[] = [];
  for (const event of payload.events || []) {
    if (!event.segs?.length || !Number.isFinite(event.tStartMs)) continue;
    const text = event.segs.map((segment) => segment.utf8 || '').join('').replace(/\n/g, ' ').trim();
    if (!text) continue;
    const startMs = Math.max(0, Math.round(event.tStartMs || 0));
    const durationMs = Number.isFinite(event.dDurationMs) && event.dDurationMs! > 0
      ? Math.round(event.dDurationMs!)
      : null;
    const canonical = normalizeCaptionText(text);
    let prefix = '';
    const wordStarts: NonNullable<CaptionCue['wordStarts']> = [];
    for (const segment of event.segs) {
      const raw = segment.utf8 || '';
      if (Number.isFinite(segment.tOffsetMs) && /\S/.test(raw)) {
        const offset = normalizeCaptionText(prefix + raw).length - normalizeCaptionText(raw).length;
        wordStarts.push({ offset, startMs: startMs + Math.max(0, Math.round(segment.tOffsetMs!)) });
      }
      prefix += raw;
    }
    entries.push({ startMs, durationMs, text: canonical, ...(wordStarts.length ? { wordStarts } : {}) });
  }
  return materializeEntries(entries);
}

export function parseTimedTextXml(payload: string): CaptionCue[] {
  const entries: ParsedCaptionEntry[] = [];
  const nodePattern = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of payload.matchAll(nodePattern)) {
    const [, tag, attributes, contents] = match;
    if (!tag || attributes === undefined || contents === undefined) continue;
    const usesMilliseconds = tag.toLowerCase() === 'p';
    const startValue = readAttribute(attributes, usesMilliseconds ? 't' : 'start');
    if (startValue === null) continue;
    const durationValue = readAttribute(attributes, usesMilliseconds ? 'd' : 'dur');
    const startMs = Math.max(0, Math.round(Number(startValue) * (usesMilliseconds ? 1 : 1000)));
    const durationMs = durationValue === null
      ? null
      : Math.max(1, Math.round(Number(durationValue) * (usesMilliseconds ? 1 : 1000)));
    if (!Number.isFinite(startMs) || (durationMs !== null && !Number.isFinite(durationMs))) continue;
    const text = decodeXmlEntities(contents.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text) entries.push({ startMs, durationMs, text });
  }
  return materializeEntries(entries);
}

export function parseCaptionPayload(payload: string): CaptionCue[] {
  const normalized = payload.replace(/^\uFEFF/, '').trim();
  if (!normalized) return [];
  if (normalized.startsWith('{')) {
    try {
      return parseJson3(JSON.parse(normalized) as Json3Response);
    } catch {
      return [];
    }
  }
  return parseTimedTextXml(normalized);
}
