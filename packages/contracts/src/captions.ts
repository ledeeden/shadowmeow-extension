import type { CaptionCue } from './api';

export const CAPTION_NORMALIZATION_VERSION = '2';

const DISPLAY_TAGS = /<[^>]+>/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SENTENCE_BOUNDARY = /[.!?…。！？](?:["'”’»)\]}]+)?$/;

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f\d]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function normalizeCaptionText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(DISPLAY_TAGS, ' ')
    .normalize('NFKC')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCues(cues: CaptionCue[]): CaptionCue[] {
  const normalized = cues
    .map((cue, sourceIndex) => {
      const startMs = Number.isFinite(cue.startMs) ? Math.max(0, Math.round(cue.startMs)) : 0;
      const endMs = Number.isFinite(cue.endMs) ? Math.round(cue.endMs) : startMs + 1;
      return {
        sourceIndex,
        startMs,
        endMs: Math.max(startMs + 1, endMs),
        text: normalizeCaptionText(cue.text),
        ...(cue.wordStarts?.length && normalizeCaptionText(cue.text) === cue.text ? { wordStarts: cue.wordStarts } : {}),
      };
    })
    .filter((cue) => cue.text.length > 0);
  normalized.sort((left, right) =>
    left.startMs - right.startMs
    || left.endMs - right.endMs
    || left.sourceIndex - right.sourceIndex);
  return normalized.map(({ sourceIndex: _sourceIndex, ...cue }, seq) => ({ seq, ...cue }));
}

export function captionHashInput(
  language: string,
  trackKind: 'manual' | 'asr',
  cues: CaptionCue[],
): string {
  return JSON.stringify({
    v: CAPTION_NORMALIZATION_VERSION,
    language: language.toLowerCase(),
    trackKind,
    cues: normalizeCues(cues).map(({ startMs, endMs, text }) => [startMs, endMs, text]),
  });
}

export type NormalizedSegment = {
  id: string;
  sourceCueIds: string[];
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  timing?: 'cue' | 'word' | 'estimated';
  /** Offsets are relative to this segment's rendered text. */
  wordStarts?: NonNullable<CaptionCue['wordStarts']>;
};

const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|a\.m|p\.m)\.$/i;
export const MAX_LEARNING_SEGMENT_WORDS = 30;
const CAPTION_WORD = /[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*/g;
const CLAUSE_CONNECTOR = new Set(['but', 'so', 'yet', 'while', 'because', 'although', 'though', 'whereas', 'however', 'therefore', 'instead', 'meanwhile']);

/** A quote or whitespace before a spoken word has no duration of its own. */
function sourceTimeAtBoundary(
  text: string,
  offset: number,
  wordStarts: NonNullable<CaptionCue['wordStarts']> | undefined,
): number | null {
  const direct = wordStarts?.find((item) => item.offset === offset);
  if (direct) return direct.startMs;
  const nextWord = wordStarts?.find((item) =>
    item.offset > offset
    && /^[\s"'“”‘’([{]*$/.test(text.slice(offset, item.offset)));
  return nextWord?.startMs ?? null;
}

function sourceTimeNearSentenceBoundary(
  text: string,
  offset: number,
  nextSentenceBoundary: number,
  wordStarts: NonNullable<CaptionCue['wordStarts']> | undefined,
): { ms: number | null; exact: boolean } {
  const exact = sourceTimeAtBoundary(text, offset, wordStarts);
  if (exact !== null) return { ms: exact, exact: true };

  // YouTube ASR occasionally omits the timestamp on the first word after a
  // sentence boundary while retaining one on a later word. That should make
  // only this boundary approximate, not disable sentence splitting for the
  // entire cue. The fallback still uses a source timestamp; it never derives
  // time from character position.
  const nextTimedWord = wordStarts?.find((item) =>
    item.offset > offset && item.offset < nextSentenceBoundary);
  return nextTimedWord ? { ms: nextTimedWord.startMs, exact: false } : { ms: null, exact: false };
}

function estimatedTimeAtWordBoundary(
  text: string,
  offset: number,
  startMs: number,
  endMs: number,
): number | null {
  const words = [...text.matchAll(CAPTION_WORD)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
  }));
  const completedWords = words.filter((word) => word.end <= offset).length;
  if (completedWords <= 0 || completedWords >= words.length || endMs <= startMs) return null;
  return startMs + Math.round((endMs - startMs) * completedWords / words.length);
}

/**
 * Keep complete subtitle text while avoiding a player-sized paragraph. Prefer
 * punctuation and clause boundaries; an exact word cap is only the last resort.
 */
function learningChunkBoundaries(text: string): number[] {
  const words = [...text.matchAll(CAPTION_WORD)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
    value: match[0].toLowerCase(),
  }));
  if (words.length <= MAX_LEARNING_SEGMENT_WORDS) return [0, text.length];
  const boundaries = [0];
  let firstWord = 0;
  while (firstWord < words.length) {
    const nextWord = firstWord + MAX_LEARNING_SEGMENT_WORDS;
    if (nextWord >= words.length) {
      boundaries.push(text.length);
      break;
    }
    const hardBoundary = words[nextWord]!.start;
    const candidates: Array<{ offset: number; words: number; strength: number }> = [];
    for (const match of text.slice(boundaries.at(-1)!).matchAll(/[,;:—–]\s+/g)) {
      const offset = boundaries.at(-1)! + match.index! + match[0].length;
      const count = words.filter((word) => word.end <= offset).length - firstWord;
      if (count >= 6 && count <= MAX_LEARNING_SEGMENT_WORDS && offset <= hardBoundary) {
        const nextWord = words.find((word) => word.start >= offset)?.value;
        // Never strand a coordinating word at the beginning of the next
        // display segment (", or …" / ", and …"). For an opening subordinate
        // clause, its first comma is the natural phrase boundary.
        if (nextWord === 'or' || nextWord === 'and') continue;
        const openingClause = firstWord === 0
          && candidates.length === 0
          && /^(?:if|when|while|because|although|though|unless)\b/i.test(text.trim());
        candidates.push({ offset, words: count, strength: openingClause ? 3 : /[;:—–]/.test(match[0]) ? 2 : 1 });
      }
    }
    for (let index = firstWord + 6; index <= firstWord + MAX_LEARNING_SEGMENT_WORDS; index += 1) {
      const word = words[index];
      if (word && CLAUSE_CONNECTOR.has(word.value)) candidates.push({ offset: word.start, words: index - firstWord, strength: 0 });
    }
    candidates.sort((left, right) => right.strength - left.strength || right.words - left.words);
    const offset = candidates[0]?.offset ?? hardBoundary;
    boundaries.push(offset);
    firstWord = words.filter((word) => word.end <= offset).length;
  }
  return boundaries;
}

/** Split inside cues, not just at their last character. Keep the source text. */
function sentencePieces(cue: CaptionCue): Array<CaptionCue & { timing: 'cue' | 'word' | 'estimated' }> {
  const textBoundaries = [0];
  for (const match of cue.text.matchAll(/[.!?。！？]+["'”’»)\]}]*(?:\s+|$)/g)) {
    const end = match.index! + match[0].length;
    const prefix = cue.text.slice(0, end).trim();
    if (ABBREVIATION.test(prefix) || /\b[A-Z]\.$/.test(prefix)) continue;
    if (end < cue.text.length) textBoundaries.push(end);
  }
  textBoundaries.push(cue.text.length);

  const boundaries: Array<{ offset: number; ms: number; exact: boolean }> = [
    { offset: 0, ms: cue.startMs, exact: true },
  ];
  for (const [index, offset] of textBoundaries.slice(1, -1).entries()) {
    const nextSentenceBoundary = textBoundaries[index + 2]!;
    const sourceTime = sourceTimeNearSentenceBoundary(cue.text, offset, nextSentenceBoundary, cue.wordStarts);
    const time = sourceTime.ms === null
      ? { ms: estimatedTimeAtWordBoundary(cue.text, offset, cue.startMs, cue.endMs), exact: false }
      : sourceTime;
    const previous = boundaries.at(-1)!;
    // Keep every independently usable sentence boundary. A single missing or
    // degenerate timestamp must not collapse all the other sentences back into
    // one player-sized paragraph.
    if (time.ms !== null && time.ms > previous.ms && time.ms < cue.endMs) {
      boundaries.push({ offset, ms: time.ms, exact: time.exact });
    }
  }
  boundaries.push({ offset: cue.text.length, ms: cue.endMs, exact: true });

  return boundaries.slice(0, -1).map((boundary, index) => {
    const nextBoundary = boundaries[index + 1]!;
    const start = boundary.offset;
    const end = nextBoundary.offset;
    const rawText = cue.text.slice(start, end);
    const leadingWhitespace = rawText.length - rawText.trimStart().length;
    const text = rawText.trim();
    const textStart = start + leadingWhitespace;
    const textEnd = textStart + text.length;
    const wordStarts = cue.wordStarts
      ?.filter((item) => item.offset >= textStart && item.offset < textEnd)
      .map((item) => ({ ...item, offset: item.offset - textStart }));
    return {
      seq: cue.seq,
      text,
      startMs: boundary.ms,
      endMs: nextBoundary.ms,
      timing: boundaries.length === 2 ? 'cue' : boundary.exact && nextBoundary.exact ? 'word' : 'estimated',
      ...(wordStarts?.length ? { wordStarts } : {}),
    };
  });
}

export function cuesToLearningSegments(cues: CaptionCue[], options: { allowOverlap?: boolean } = {}): NormalizedSegment[] {
  const normalized = normalizeCues(cues);
  // YouTube's rolling captions retain old lines on screen after the next cue
  // begins. That display overlap is not a speaker pause or sentence boundary.
  if (options.allowOverlap) {
    normalized.forEach((cue, index) => {
      const next = normalized[index + 1];
      if (next && next.startMs > cue.startMs) cue.endMs = Math.min(cue.endMs, next.startMs);
    });
  }
  const result: NormalizedSegment[] = [];
  let buffer: ReturnType<typeof sentencePieces> = [];

  const flush = () => {
    if (!buffer.length) return;
    const first = buffer[0]!;
    const last = buffer[buffer.length - 1]!;
    const text = buffer.map((cue) => cue.text).join(' ').replace(/\s+/g, ' ').trim();
    let textOffset = 0;
    const wordStarts = buffer.flatMap((cue) => {
      const starts = cue.wordStarts?.map((item) => ({ ...item, offset: item.offset + textOffset })) || [];
      textOffset += cue.text.length + 1;
      return starts;
    });
    const boundaries = learningChunkBoundaries(text);
    const chunkCandidates = boundaries.slice(0, -1).map((start, index) => {
      const rawText = text.slice(start, boundaries[index + 1]!);
      const leadingWhitespace = rawText.length - rawText.trimStart().length;
      const chunkText = rawText.trim();
      const textStart = start + leadingWhitespace;
      return { text: chunkText, textStart, textEnd: textStart + chunkText.length };
    });
    let cueTextOffset = 0;
    const cueStarts = buffer.map((cue) => {
      const anchor = { offset: cueTextOffset, startMs: cue.startMs };
      cueTextOffset += cue.text.length + 1;
      return anchor;
    });
    const sourceTimingAt = (offset: number) => sourceTimeAtBoundary(text, offset, wordStarts)
      ?? cueStarts.find((item) => item.offset === offset)?.startMs
      ?? null;
    const timingAt = (offset: number): { ms: number | null; exact: boolean } => {
      const sourceMs = sourceTimingAt(offset);
      return sourceMs === null
        ? { ms: estimatedTimeAtWordBoundary(text, offset, first.startMs, last.endMs), exact: false }
        : { ms: sourceMs, exact: true };
    };
    const chunkStarts = chunkCandidates.map((chunk, index) => index === 0
      ? { ms: first.startMs, exact: true }
      : timingAt(chunk.textStart));
    const canSplitOnTime = chunkStarts.slice(1).every((boundary, index) =>
      boundary.ms !== null
      && boundary.ms > chunkStarts[index]!.ms!
      && boundary.ms < last.endMs);
    const chunks = canSplitOnTime
      ? chunkCandidates
      : [{ text, textStart: 0, textEnd: text.length }];
    const starts = canSplitOnTime ? chunkStarts : [{ ms: first.startMs, exact: true }];
    for (const [index, chunk] of chunks.entries()) {
      const next = chunks[index + 1];
      const startBoundary = starts[index]!;
      const endBoundary = next ? starts[index + 1]! : { ms: last.endMs, exact: true };
      const startMs = startBoundary.ms!;
      const endMs = endBoundary.ms!;
      const hasExactBoundaryTimes = chunks.length === 1
        ? !buffer.some((cue) => cue.timing === 'estimated')
        : startBoundary.exact && endBoundary.exact && !buffer.some((cue) => cue.timing === 'estimated');
      const chunkWordStarts = wordStarts
        .filter((item) => item.offset >= chunk.textStart && item.offset < chunk.textEnd)
        .map((item) => ({ ...item, offset: item.offset - chunk.textStart }));
      result.push({
        id: `${startMs}-${endMs}-${result.length}`,
        sourceCueIds: [...new Set(buffer.map((cue) => String(cue.seq)))],
        startMs,
        endMs: Math.max(startMs + 1, endMs),
        text: chunk.text,
        confidence: hasExactBoundaryTimes && !buffer.some(cue => cue.timing === 'estimated') ? (SENTENCE_BOUNDARY.test(chunk.text) ? 0.95 : 0.78) : 0.65,
        timing: hasExactBoundaryTimes && !buffer.some(cue => cue.timing === 'estimated') ? (buffer.some(cue => cue.timing === 'word') ? 'word' : 'cue') : 'estimated',
        ...(chunkWordStarts.length ? { wordStarts: chunkWordStarts } : {}),
      });
    }
    buffer = [];
  };

  for (const cue of normalized.flatMap(sentencePieces)) {
    const first = buffer[0];
    const candidateDuration = first ? cue.endMs - first.startMs : cue.endMs - cue.startMs;
    const candidateWords = [...buffer, cue].reduce((count, item) => count + item.text.split(/\s+/).length, 0);
    const gap = buffer.length ? cue.startMs - buffer[buffer.length - 1]!.endMs : 0;
    // Prefer finishing the spoken thought over the old 8-second/15-word cap.
    // A safety bound remains for unpunctuated ASR, but ordinary long sentences
    // are not cut just before their object or a preposition's complement.
    if (buffer.length && (gap > 1_500 || (!options.allowOverlap && gap < 0)
      || candidateDuration > 30_000 || candidateWords > 90)) flush();
    buffer.push(cue);
    const abbreviation = ABBREVIATION.test(cue.text) || /\b[A-Z]\.$/.test(cue.text);
    if (SENTENCE_BOUNDARY.test(cue.text) && !abbreviation) flush();
  }
  flush();
  return result;
}
