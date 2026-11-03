import { SYNC_STORES, installChangeJournal } from '../sync/local-store';
import { randomId, type PageState, type SyncTable } from '@shadow-language/contracts';
import Dexie, { type EntityTable } from 'dexie';
import { NOTE_BODY_LIMIT, noteOverwriteToken, type NoteWriteResult } from './note';

export type VideoReference = {
  id: string; videoKey: string; title: string; url: string; startMs: number;
  endMs: number; text: string; highlight: string; trackId: string | null; createdAt: number;
};
export type AgentConversation = { id: string; owner: string; title: string; videoKey?: string; videoContext?: PageState; createdAt: number; updatedAt: number };
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type WireMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; reasoning_content?: string; tool_calls?: ToolCall[]; tool_call_id?: string };
export type AgentSource = { id: string; kind: 'video' | 'note' | 'document'; title: string; href: string; thumbnail?: string; detail?: string };
export type AgentAttachment = {
  id: string;
  name: string;
  type: 'image' | 'text' | 'markdown';
  size: number;
  dataUrl?: string;
  content?: string;
};
export type AgentMessage = WireMessage & {
  id: string; conversationId: string; owner: string; createdAt: number;
  referenceId?: string; status?: 'streaming' | 'complete' | 'interrupted' | 'failed';
  context?: { title: string; videoKey: string; timeMs: number; text: string };
  sources?: AgentSource[];
  presentation?: 'corpus-results';
  searchResultCount?: number;
  followUpQuestions?: string[];
  steps?: string[];
  elapsedMs?: number;
  attachments?: AgentAttachment[];
};
export type AgentNote = {
  id: string; owner: string; reference: VideoReference; body: string;
  links: Array<{ conversationId: string; questionId: string; answerId: string }>;
  createdAt: number; updatedAt: number;
};
export type AgentMemory = { id: string; owner: string; text: string; sourceMessageId?: string; createdAt: number; updatedAt: number };
export type KnowledgeDocument = { id: string; owner: string; title: string; text: string; createdAt: number; updatedAt: number;
  videoKey?: string; documentKind?: 'preview' | 'review' | 'expression_analysis'; documentFormatVersion?: string; sourceUrl?: string;
};
export type AgentRun = { id: string; owner: string; conversationId: string; status: 'running' | 'complete' | 'interrupted' | 'failed'; error?: string; updatedAt: number };

export class AgentDatabase extends Dexie {
  conversations!: EntityTable<AgentConversation, 'id'>;
  messages!: EntityTable<AgentMessage, 'id'>;
  notes!: EntityTable<AgentNote, 'id'>;
  memories!: EntityTable<AgentMemory, 'id'>;
  documents!: EntityTable<KnowledgeDocument, 'id'>;
  dictations!: EntityTable<{ id: string; owner: string; html: string; title?: string; names: string; autoCase: boolean; updatedAt: number }, 'id'>;
  videoPages!: EntityTable<{ id: string; owner: string; page: PageState; updatedAt: number }, 'id'>;
  runs!: EntityTable<AgentRun, 'id'>;
  constructor(name = 'shadow-language-agent') {
    super(name);
    this.version(1).stores({
      conversations: 'id,owner,[owner+updatedAt],videoKey',
      messages: 'id,owner,conversationId,[conversationId+createdAt]',
      notes: 'id,owner,[owner+updatedAt],reference.videoKey',
      memories: 'id,owner', documents: 'id,owner', runs: 'id,owner,conversationId,status',
    });
    this.version(2).stores({ dictations: 'id,owner' });
    this.version(3).stores({ videoPages: 'id,owner' });
    this.version(4).stores(SYNC_STORES);
  }
}
export let agentDb = new AgentDatabase();
export function selectWebAgentDatabase(name: string, changed: () => void, writable: () => boolean) {
  agentDb.close();
  agentDb = new AgentDatabase(name);
  installChangeJournal(agentDb, Object.fromEntries(['conversations', 'messages', 'notes', 'memories', 'documents', 'dictations'].map(table => [table, `agent.${table}` as SyncTable])), changed, writable);
  return agentDb;
}

export async function createConversation(owner: string, title = '新对话', videoKey?: string) {
  const value: AgentConversation = { id: randomId(), owner, title, ...(videoKey ? { videoKey } : {}), createdAt: Date.now(), updatedAt: Date.now() };
  await agentDb.conversations.add(value);
  return value;
}

export async function saveHighlight(owner: string, reference: VideoReference) {
  return agentDb.transaction('rw', agentDb.notes, async () => {
    const existing = (await agentDb.notes.where('owner').equals(owner).toArray()).find(n => n.reference.videoKey === reference.videoKey && n.reference.startMs === reference.startMs && n.reference.highlight === reference.highlight && n.reference.text === reference.text);
    if (existing) return existing;
    const note: AgentNote = { id: randomId(), owner, reference, body: '', links: [], createdAt: Date.now(), updatedAt: Date.now() };
    await agentDb.notes.add(note);
    return note;
  });
}

function referenceIdentity(reference: VideoReference): string {
  return [reference.videoKey, reference.startMs, reference.endMs, reference.highlight, reference.text].join('|');
}

function normalizedBody(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * Agent writes are additive by default. The body is a human writing surface, so
 * a note the learner already filled is extended instead of replaced, and a
 * repeated write is reported rather than duplicated.
 */
function mergeNoteBody(existing: string, addition: string): string {
  const next = addition.trim();
  if (!existing.trim()) return next;
  const incoming = normalizedBody(next);
  if (incoming.length >= 4 && normalizedBody(existing).includes(incoming)) return existing;
  const merged = `${existing.trimEnd()}\n\n---\n\n${next}`;
  if (merged.length > NOTE_BODY_LIMIT) throw new Error(`笔记内容超过 ${NOTE_BODY_LIMIT} 字上限，请分段写入。`);
  return merged;
}

export async function createNote(owner: string, reference: VideoReference, body: string): Promise<NoteWriteResult> {
  return agentDb.transaction('rw', agentDb.notes, async () => {
    const identity = referenceIdentity(reference);
    const existing = (await agentDb.notes.where('owner').equals(owner).toArray()).find(note => referenceIdentity(note.reference) === identity);
    if (existing) {
      const merged = mergeNoteBody(existing.body, body);
      if (merged === existing.body) return { saved: false, reason: 'already_exists', note: existing };
      const updatedAt = Date.now();
      await agentDb.notes.update(existing.id, { body: merged, updatedAt });
      return { saved: true, reason: 'appended_to_existing', note: { ...existing, body: merged, updatedAt } };
    }
    const now = Date.now();
    const note: AgentNote = { id: randomId(), owner, reference, body: body.trim(), links: [], createdAt: now, updatedAt: now };
    await agentDb.notes.add(note);
    return { saved: true, reason: 'created', note };
  });
}

export async function appendToNote(owner: string, noteId: string, body: string): Promise<NoteWriteResult> {
  return agentDb.transaction('rw', agentDb.notes, async () => {
    const note = await agentDb.notes.get(noteId);
    if (!note || note.owner !== owner) throw new Error('笔记不存在。');
    const merged = mergeNoteBody(note.body, body);
    if (merged === note.body) return { saved: false, reason: 'already_appended', note };
    const updatedAt = Date.now();
    await agentDb.notes.update(noteId, { body: merged, updatedAt });
    return { saved: true, reason: 'appended', note: { ...note, body: merged, updatedAt } };
  });
}

/** Overwrite is the only path that replaces learner text, so it stays gated on a token. */
export async function overwriteNote(owner: string, noteId: string, body: string, confirm?: string): Promise<NoteWriteResult> {
  return agentDb.transaction('rw', agentDb.notes, async () => {
    const note = await agentDb.notes.get(noteId);
    if (!note || note.owner !== owner) throw new Error('笔记不存在。');
    const next = body.trim();
    if (note.body.trim()) {
      const expected = noteOverwriteToken(note);
      if (!confirm) return { saved: false, reason: 'needs_confirmation', note, preview: note.body.slice(0, 300), confirmToken: expected };
      if (confirm !== expected) throw new Error('笔记在确认之后又被修改过，请重新确认再覆盖。');
    }
    if (next === note.body) return { saved: false, reason: 'unchanged', note };
    const updatedAt = Date.now();
    await agentDb.notes.update(noteId, { body: next, updatedAt });
    return { saved: true, reason: 'overwritten', note: { ...note, body: next, updatedAt } };
  });
}

export async function linkAnswer(owner: string, noteId: string, link: AgentNote['links'][number]) {
  await agentDb.transaction('rw', agentDb.notes, async () => {
    const note = await agentDb.notes.get(noteId);
    if (!note || note.owner !== owner) throw new Error('笔记不存在');
    if (!note.links.some(value => value.answerId === link.answerId)) await agentDb.notes.update(noteId, { links: [...note.links, link], updatedAt: Date.now() });
  });
}

export async function deleteConversation(owner: string, id: string) {
  await agentDb.transaction('rw', [agentDb.conversations, agentDb.messages, agentDb.notes, agentDb.runs], async () => {
    const conversation = await agentDb.conversations.get(id);
    if (conversation?.owner !== owner) throw new Error('对话不存在');
    const notes = await agentDb.notes.where('owner').equals(owner).toArray();
    if (notes.some(note => note.links.some(link => link.conversationId === id))) throw new Error('这段对话被笔记引用，请先移除笔记中的问答引用。');
    await agentDb.messages.where('conversationId').equals(id).delete();
    await agentDb.runs.where('conversationId').equals(id).delete();
    await agentDb.conversations.delete(id);
  });
}

export async function clearAgentData() {
  await agentDb.transaction('rw', agentDb.tables, async () => {
    for (const table of agentDb.tables.filter(table => !table.name.startsWith('_sync'))) await table.clear();
  });
}

export async function exportAgentData(owner: string) {
  const data: Record<string, unknown[]> = {};
  for (const table of agentDb.tables.filter(table => !table.name.startsWith('_sync'))) data[table.name] = await table.where('owner').equals(owner).toArray();
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), data };
}

export async function deleteOwnerAgentData(owner: string) {
  await agentDb.transaction('rw', agentDb.tables, async () => {
    for (const table of agentDb.tables.filter(table => !table.name.startsWith('_sync'))) await table.where('owner').equals(owner).delete();
  });
}
