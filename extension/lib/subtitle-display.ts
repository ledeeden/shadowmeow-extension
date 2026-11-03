import { tokenizeCaptionText } from '@shadow-language/contracts';
import { lookupReaderWord } from './reader-frequency';
import { isOutsideVocabulary } from './vocabulary-profile';
import { vocabularyTermKeys } from './vocabulary';

export const SUBTITLE_DISPLAY_MODES = ['all', 'new-words', 'hidden'] as const;

export type SubtitleDisplayMode = typeof SUBTITLE_DISPLAY_MODES[number];

export const subtitleDisplayModeLabel: Record<SubtitleDisplayMode, string> = {
  all: '英文',
  'new-words': '生词',
  hidden: '遮挡',
};

export function cycleSubtitleDisplayMode(mode: SubtitleDisplayMode): SubtitleDisplayMode {
  return SUBTITLE_DISPLAY_MODES[(SUBTITLE_DISPLAY_MODES.indexOf(mode) + 1) % SUBTITLE_DISPLAY_MODES.length]!;
}

export function subtitleMaskText(text: string): string {
  return '█'.repeat(Math.min(12, Math.max(2, Array.from(text).length)));
}

export function subtitleMaskWidth(text: string): number {
  return Math.min(7, Math.max(0.8, Array.from(text).length * 0.58));
}

type SubtitleWordTimingInput = {
  wordOffsets: number[];
  wordStarts?: Array<{ offset: number; startMs: number }>;
  startMs: number;
  endMs: number;
};

/** Returns timestamps only when the source has an exact timestamp for every rendered word. */
export function subtitleWordStartTimes({ wordOffsets, wordStarts, startMs, endMs }: SubtitleWordTimingInput): number[] | null {
  if (!wordOffsets.length || endMs <= startMs || wordStarts?.length !== wordOffsets.length) return null;
  const starts = wordStarts.map((item) => item.startMs);
  const matchesEveryWord = wordStarts.every((item, index) =>
    item.offset === wordOffsets[index]
    && Number.isFinite(item.startMs)
    && item.startMs >= startMs
    && item.startMs < endMs
    && (index === 0 || item.startMs > starts[index - 1]!),
  );
  return matchesEveryWord ? starts : null;
}

export function activeSubtitleWordIndex({ timeMs, ...timing }: SubtitleWordTimingInput & { timeMs: number }): number | null {
  if (!Number.isFinite(timeMs) || timeMs < timing.startMs || timeMs >= timing.endMs) return null;
  const starts = subtitleWordStartTimes(timing);
  if (!starts?.length) return null;
  if (timeMs < starts[0]!) return null;
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    if (timeMs >= starts[index]!) return index;
  }
  return 0;
}

export function isNewSubtitleWord({
  vocabularySize,
  vocabularyKeys,
  vocabularyRank,
  countable,
  masteredVocabulary,
}: {
  vocabularySize: number;
  vocabularyKeys: string[];
  vocabularyRank: number | null;
  countable: boolean;
  masteredVocabulary: Set<string>;
}): boolean {
  const mastered = vocabularyKeys.some((key) => masteredVocabulary.has(key));
  return !mastered && countable && isOutsideVocabulary(vocabularyRank, vocabularySize);
}

/** A transcript row mirrors the word positions in the player without exposing a masked answer. */
export function subtitleTextForDisplay(
  text: string,
  mode: SubtitleDisplayMode,
  vocabularySize: number,
  masteredVocabulary: Set<string>,
): string {
  if (mode === 'all') return text;
  return tokenizeCaptionText(text).map((token) => {
    if (token.kind !== 'word' || !token.lookupText) return token.text.replace(/\S/g, ' ');
    if (mode === 'hidden') return subtitleMaskText(token.text);
    const info = lookupReaderWord(token.lookupText);
    const vocabularyKeys = vocabularyTermKeys(token.lookupText, info.lemma);
    return isNewSubtitleWord({
      vocabularySize,
      vocabularyKeys,
      vocabularyRank: info.rank,
      countable: info.countable,
      masteredVocabulary,
    }) ? token.text : subtitleMaskText(token.text);
  }).join('');
}
