/** Offsets are UTF-16 indices into the unchanged source text (DOM/JS convention). */
export type CaptionNlpToken = {
  index: number;
  start: number;
  end: number;
  text: string;
  normalized: string;
  lemma: string;
  pos: string;
  lookupText: string | null;
};

export type CaptionNlpResult = {
  text: string;
  engine: string;
  status: 'ready' | 'fallback';
  tokens: CaptionNlpToken[];
};

/** Never allow a stale or misaligned annotation to change the visible subtitle. */
export function validCaptionNlp(result: CaptionNlpResult, text: string): boolean {
  let cursor = 0;
  return result.text === text && result.tokens.every((token, index) => {
    const valid = token.index === index && token.start === cursor && token.end > token.start
      && token.text === text.slice(token.start, token.end);
    cursor = token.end;
    return valid;
  }) && cursor === text.length;
}

/** Phrase lookup uses surface text and the same token index as rendering. */
export function captionNlpPhrases(result: CaptionNlpResult, tokenIndex: number, maxWords = 5): string[] {
  const target = result.tokens[tokenIndex];
  if (!target?.lookupText) return [];
  // Group adjacent contraction pieces into a single surface word.
  const words: Array<{ start: number; end: number; first: number; last: number }> = [];
  for (const token of result.tokens) {
    if (token.pos === 'WS' || token.pos === 'SPACE') continue;
    if (!token.lookupText) {
      if (token.index < tokenIndex) words.length = 0;
      else break;
      continue;
    }
    const previous = words.at(-1);
    if (previous && previous.end === token.start) { previous.end = token.end; previous.last = token.index; }
    else words.push({ start: token.start, end: token.end, first: token.index, last: token.index });
  }
  const center = words.findIndex(word => word.first <= tokenIndex && word.last >= tokenIndex);
  if (center < 0) return [];
  const phrases: string[] = [];
  for (let size = Math.min(maxWords, words.length); size >= 2; size -= 1) {
    for (let start = Math.max(0, center - size + 1); start <= center && start + size <= words.length; start += 1) {
      phrases.push(result.text.slice(words[start]!.start, words[start + size - 1]!.end).replace(/\s+/g, ' ').toLowerCase());
    }
  }
  return [...new Set(phrases)];
}
