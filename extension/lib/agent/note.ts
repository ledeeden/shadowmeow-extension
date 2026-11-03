import { randomId, videoKeyOf, videoUrl, type PageState } from '@shadow-language/contracts';
import type { AgentNote, VideoReference } from './store';

/** Notes that never attached to a corpus live here; the library already renders this bucket. */
export const NOTE_GENERAL_VIDEO_KEY = 'general';
/** The note body is a human writing surface, so a runaway model cannot fill the sync record. */
export const NOTE_BODY_LIMIT = 20000;

export type AgentNoteAction = 'create' | 'append' | 'overwrite';

export type AgentNoteInput = {
  action: AgentNoteAction;
  body: string;
  title?: string | undefined;
  noteId?: string | undefined;
  confirm?: string | undefined;
};

export type NoteWriteReason = 'created' | 'appended' | 'appended_to_existing' | 'already_exists' | 'already_appended' | 'overwritten' | 'unchanged' | 'needs_confirmation';

export type NoteWriteResult = {
  saved: boolean;
  reason: NoteWriteReason;
  note: AgentNote;
  /** Present only when an overwrite has to be confirmed first. */
  preview?: string;
  confirmToken?: string;
};

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function cleanBody(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : '';
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * Writing notes changes the learner's own data, so a model may only do it for a
 * direct request. This is deliberately stricter than "summarise": explaining or
 * recommending must never leave a note behind.
 */
export function explicitlyRequestsNoteSave(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const saveAction = /写入|写到|写进|写进|保存|存到|存进|收录|记到|记入|记下|加到|加进|整理成|归纳到|汇总到/;
  const noteTarget = /笔记|摘录|学习笔记/;
  const englishRequest = /\b(?:save|add|write|put|append|note)\b[\s\S]{0,80}\b(?:note|notes|notebook|excerpt)\b/i;
  return (saveAction.test(normalized) && noteTarget.test(normalized)) || englishRequest.test(normalized);
}

/** Overwriting is a separate, stronger intent: the body may already hold the learner's own words. */
export function explicitlyRequestsNoteOverwrite(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const overwriteAction = /重写|覆盖|替换|改写|清空|重新写|重做|删掉重写/;
  const noteTarget = /笔记|正文|内容|摘录/;
  const englishRequest = /\b(?:overwrite|replace|rewrite|clear)\b[\s\S]{0,80}\b(?:note|notes|body)\b/i;
  return (overwriteAction.test(normalized) && noteTarget.test(normalized)) || englishRequest.test(normalized);
}

export function parseAgentNoteInput(input: unknown): AgentNoteInput {
  if (!input || typeof input !== 'object') throw new Error('笔记内容无效。');
  const value = input as Record<string, unknown>;
  const action = value.action;
  if (action !== 'create' && action !== 'append' && action !== 'overwrite') throw new Error('笔记操作只能是新建、追加或重写。');
  const body = cleanBody(value.body);
  if (!body) throw new Error('要写入的笔记内容不能为空。');
  if (body.length > NOTE_BODY_LIMIT) throw new Error(`笔记内容超过 ${NOTE_BODY_LIMIT} 字上限，请分段写入。`);
  const title = cleanText(value.title, 200);
  const noteId = cleanText(value.noteId, 64);
  const confirm = cleanText(value.confirm, 64);
  if (action === 'create') {
    if (!title) throw new Error('新建笔记必须提供标题。');
    return { action, body: `# ${title}\n\n${body}`, title };
  }
  if (!noteId) throw new Error('追加或重写必须指定笔记 ID。');
  return { action, body, noteId, ...(confirm ? { confirm } : {}) };
}

function cueForBody(page: PageState, body: string) {
  const normalized = normalizedText(body);
  // Match the longest cue inside the body so a summary still lands on its source sentence.
  const match = page.cues
    .filter(cue => {
      const text = normalizedText(cue.text);
      return text.length >= 8 && normalized.includes(text);
    })
    .sort((a, b) => b.text.length - a.text.length)[0];
  if (match) return match;
  return page.cues.find(cue => cue.startMs <= page.timeMs && cue.endMs >= page.timeMs) || null;
}

function safeVideoUrl(videoKey: string, startMs: number): string {
  try { return videoUrl(videoKey, startMs); } catch { return ''; }
}

/**
 * Notes are anchored to a corpus sentence so they keep a way back to the source.
 * Without a page the note lands in the existing "未关联视频的笔记" bucket instead
 * of inventing a video identity.
 */
export function buildAgentNoteReference(input: AgentNoteInput, page?: PageState): VideoReference {
  const createdAt = Date.now();
  const title = input.title || '未关联视频的笔记';
  const videoKey = page ? videoKeyOf(page) : '';
  if (!page || !videoKey) {
    return { id: randomId(), videoKey: NOTE_GENERAL_VIDEO_KEY, title, url: '', startMs: 0, endMs: 0, text: title, highlight: title, trackId: null, createdAt };
  }
  const cue = cueForBody(page, input.body);
  const startMs = cue ? cue.startMs : Math.max(0, Math.round(page.timeMs || 0));
  const endMs = cue ? cue.endMs : startMs;
  const text = cue ? cue.text : input.body.split('\n').find(line => line.trim()) || page.title;
  return {
    id: randomId(),
    videoKey,
    title: page.title || videoKey,
    url: safeVideoUrl(videoKey, startMs) || page.canonicalUrl || '',
    startMs,
    endMs,
    text,
    highlight: text,
    trackId: page.activeTrackId,
    createdAt,
  };
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Stateless confirmation token for overwriting. It folds the note's updatedAt and
 * body tail, so an edit made between asking and confirming invalidates the token
 * instead of silently discarding words the learner just typed.
 */
export function noteOverwriteToken(note: Pick<AgentNote, 'id' | 'body' | 'updatedAt'>): string {
  return fnv1a(`${note.id}|${note.updatedAt}|${note.body.length}|${note.body.slice(-64)}`);
}

export function describeNoteWrite(result: NoteWriteResult) {
  const reference = result.note.reference;
  return {
    id: result.note.id,
    saved: result.saved,
    reason: result.reason,
    videoKey: reference.videoKey,
    title: reference.title || reference.text,
    startMs: reference.startMs,
    ...(result.preview ? { preview: result.preview } : {}),
    ...(result.confirmToken ? { confirmToken: result.confirmToken } : {}),
  };
}
