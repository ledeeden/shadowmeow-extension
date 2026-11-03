import { videoIdentity, videoKeyOf, type PageState, type SavedItemInput, randomId } from '@shadow-language/contracts';

export type WordbookEntryKind = SavedItemInput['kind'];

export type AgentWordbookInput = {
  kind: WordbookEntryKind;
  value: string;
  meaningZh?: string | undefined;
  lemma?: string | undefined;
  partOfSpeech?: string | undefined;
  pronunciation?: string | undefined;
};

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function normalizedText(value: string): string {
  return cleanText(value, 500).toLocaleLowerCase();
}

/**
 * Saving changes the learner's data, so a model may only do it for a direct
 * request. This is deliberately stricter than a generic "remember" request:
 * explaining a word or suggesting a study item must never create a card.
 */
export function explicitlyRequestsWordbookSave(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const saveAction = /写入|写到|保存|收录|添加|加入|放进|放到|记下|记入|记到|存入/;
  const wordbookTarget = /生词本|单词本|词汇本|词库|单词卡|单词|词汇|语块|短语|句式|表达/;
  const englishRequest = /\b(?:save|add|put)\b[\s\S]{0,80}\b(?:wordbook|vocabulary|word|phrase|chunk|pattern)\b/i;
  return (saveAction.test(normalized) && wordbookTarget.test(normalized)) || englishRequest.test(normalized);
}

export function parseAgentWordbookInput(input: unknown): AgentWordbookInput {
  if (!input || typeof input !== 'object') throw new Error('生词本条目无效。');
  const value = input as Record<string, unknown>;
  const kind = value.kind;
  if (kind !== 'word' && kind !== 'phrase' && kind !== 'pattern') throw new Error('生词本条目类型只能是单词、语块或句式。');
  const text = cleanText(value.value, 500);
  if (!text) throw new Error('要保存的英文内容不能为空。');
  const optional = (key: string, maxLength: number) => cleanText(value[key], maxLength);
  return {
    kind,
    value: text,
    ...(optional('meaningZh', 1000) ? { meaningZh: optional('meaningZh', 1000) } : {}),
    ...(optional('lemma', 200) ? { lemma: optional('lemma', 200) } : {}),
    ...(optional('partOfSpeech', 80) ? { partOfSpeech: optional('partOfSpeech', 80) } : {}),
    ...(optional('pronunciation', 100) ? { pronunciation: optional('pronunciation', 100) } : {}),
  };
}

function cueForEntry(page: PageState, value: string) {
  const target = normalizedText(value);
  const matchingIndex = page.cues.findIndex((cue) => normalizedText(cue.text).includes(target));
  if (matchingIndex >= 0) return { cue: page.cues[matchingIndex]!, index: matchingIndex };

  const currentIndex = page.cues.findIndex((cue) => cue.startMs <= page.timeMs && cue.endMs >= page.timeMs);
  if (currentIndex >= 0) return { cue: page.cues[currentIndex]!, index: currentIndex };
  return null;
}

/** Builds the same SavedItemInput used by subtitle selection and dictionary save. */
export function buildAgentWordbookItem(input: AgentWordbookInput, page: PageState): SavedItemInput {
  const videoKey = videoKeyOf(page);
  if (!videoKey) throw new Error('请在打开视频后再让 Agent 写入生词本。');
  // Learning-data schemas still only persist YouTube/Bilibili identities.
  if (videoKey.startsWith('media:')) throw new Error('自有媒体语料暂不支持写入生词本，请先打开公开语料视频。');
  const match = cueForEntry(page, input.value);
  return {
    id: `item_${randomId()}`,
    kind: input.kind,
    normalizedValue: normalizedText(input.value),
    displayValue: input.value,
    ...videoIdentity(videoKey),
    ...(page.thumbnailUrl ? { thumbnailUrl: page.thumbnailUrl } : {}),
    trackId: page.activeTrackId,
    segmentSeq: match?.index ?? 0,
    startMs: match?.cue.startMs ?? Math.max(0, Math.round(page.timeMs || 0)),
    contextText: match?.cue.text || input.value,
    note: '',
    ...(input.meaningZh ? { meaningZh: input.meaningZh } : {}),
    ...(input.lemma ? { lemma: input.lemma } : {}),
    ...(input.partOfSpeech ? { partOfSpeech: input.partOfSpeech } : {}),
    ...(input.pronunciation ? { pronunciation: input.pronunciation } : {}),
    dictionarySource: 'Agent',
    occurredAt: new Date().toISOString(),
  };
}
