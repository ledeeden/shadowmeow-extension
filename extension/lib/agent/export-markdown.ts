import { downloadPlatformFile } from '../platform-export';
import { videoKeyOf, videoUrl } from '@shadow-language/contracts';
import { agentDb, type AgentConversation, type AgentMessage, type AgentNote } from './store';

export const APP_ORIGIN = 'https://shadowmeow.ledetools.com';
const ZERO_WIDTH = '\u200b';

/* ------------------------------------------------------------------ *
 * HTML → Markdown
 *
 * The dictation editor stores contenteditable HTML and the toolbar only
 * emits a small tag set. A tokenizer keeps this dependency-free and
 * testable outside the browser, where DOMParser does not exist.
 * ------------------------------------------------------------------ */

type HtmlNode = { tag: string; attrs: Record<string, string>; children: HtmlNode[]; text?: string };

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'meta', 'link']);
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', hellip: '…', mdash: '—', ndash: '–', middot: '·' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/** Block-level tags close an open paragraph, matching how a browser nests them. */
const AUTO_CLOSE: Record<string, string[]> = {
  li: ['li'],
  p: ['p'],
  div: ['p'],
  ul: ['p', 'li'],
  ol: ['p', 'li'],
  h1: ['p', 'li'], h2: ['p', 'li'], h3: ['p', 'li'], h4: ['p', 'li'], h5: ['p', 'li'], h6: ['p', 'li'],
  blockquote: ['p', 'li'],
  pre: ['p', 'li'],
};

/** Array.prototype.findLastIndex is newer than this package's ES2022 lib target. */
function lastTagIndex(stack: HtmlNode[], tag: string): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) if (stack[index]!.tag === tag) return index;
  return -1;
}

function parseHtml(html: string): HtmlNode[] {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack: HtmlNode[] = [root];
  // Non-content blocks are removed up front; skipping only the open tag would leak their body as text.
  const source = html.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<(script|style|head|title)\b[^>]*>/gi, '');
  const pattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^<>])*?)\/?>|([^<]+)/g;
  for (const match of source.matchAll(pattern)) {
    const [raw, tag, rawAttrs, text] = match;
    if (!tag) {
      if (text && text.trim()) stack.at(-1)!.children.push({ tag: '#text', attrs: {}, children: [], text: decodeEntities(text) });
      continue;
    }
    const lower = tag.toLowerCase();
    if (lower === 'br' || lower === 'hr') {
      stack.at(-1)!.children.push({ tag: lower, attrs: {}, children: [] });
      continue;
    }
    if (raw.startsWith('</')) {
      const index = lastTagIndex(stack, lower);
      // An unmatched close tag from pasted HTML must not unwind the whole tree.
      if (index > 0) stack.length = index;
      continue;
    }
    if (SKIP_TAGS.has(lower)) continue;
    for (const closable of AUTO_CLOSE[lower] || []) {
      const index = lastTagIndex(stack, closable);
      if (index > 0) stack.length = index;
    }
    const node: HtmlNode = { tag: lower, attrs: parseAttrs(rawAttrs || ''), children: [] };
    stack.at(-1)!.children.push(node);
    if (!VOID_TAGS.has(lower) && !raw.endsWith('/>')) stack.push(node);
  }
  return root.children;
}

function renderInline(nodes: HtmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.tag === '#text') { out += node.text || ''; continue; }
    const inner = renderInline(node.children);
    switch (node.tag) {
      case 'b': case 'strong': out += inner.trim() ? `**${inner.trim()}**` : ''; break;
      case 'i': case 'em': out += inner.trim() ? `*${inner.trim()}*` : ''; break;
      // Markdown has no underline; keep the HTML form that most editors still render.
      case 'u': out += inner.trim() ? `<u>${inner.trim()}</u>` : ''; break;
      case 's': case 'strike': case 'del': out += inner.trim() ? `~~${inner.trim()}~~` : ''; break;
      case 'code': out += inner.trim() ? `\`${inner.trim()}\`` : ''; break;
      case 'a': {
        const href = (node.attrs.href || '').trim();
        const label = inner.trim() || href;
        out += href ? `[${label}](${href})` : label;
        break;
      }
      case 'br': out += '\n'; break;
      case 'img': out += (node.attrs.alt || '').trim(); break;
      default: out += inner;
    }
  }
  return out;
}

function renderBlocks(nodes: HtmlNode[]): string[] {
  const blocks: string[] = [];
  for (const node of nodes) {
    if (node.tag === '#text') {
      const text = (node.text || '').replace(/\s+/g, ' ');
      if (text.trim()) blocks.push(text.trim());
      continue;
    }
    const upper = node.tag.toUpperCase();
    if (upper === 'UL' || upper === 'OL') {
      const ordered = upper === 'OL';
      // The whole list is one block so its items stay on consecutive lines.
      const items = node.children
        .filter(child => child.tag === 'li')
        .map((item, index) => {
          const marker = ordered ? `${index + 1}.` : '-';
          const [first = '', ...rest] = renderBlocks(item.children);
          const head = first.split('\n')[0] || '';
          const tail = [first.slice(head.length), ...rest].filter(Boolean).join('\n');
          if (!head && !tail) return '';
          return `${marker} ${head}${tail ? `\n${tail.split('\n').map(line => `   ${line}`).join('\n')}` : ''}`;
        })
        .filter(Boolean);
      if (items.length) blocks.push(items.join('\n'));
      continue;
    }
    if (upper === 'PRE') {
      blocks.push(`\`\`\`\n${renderInline(node.children).trim()}\n\`\`\``);
      continue;
    }
    const inline = renderInline(node.children).replace(/[ \t]+\n/g, '\n').trim();
    if (HEADING_TAGS.has(upper)) {
      if (inline) blocks.push(`${'#'.repeat(Number(upper.slice(1)))} ${inline}`);
      continue;
    }
    if (upper === 'BLOCKQUOTE') {
      const quoted = renderBlocks(node.children).join('\n\n');
      if (quoted) blocks.push(quoted.split('\n').map(line => `> ${line}`).join('\n'));
      continue;
    }
    if (upper === 'HR') { blocks.push('---'); continue; }
    const nested = node.children.some(child => ['UL', 'OL', 'P', 'DIV', 'PRE', 'BLOCKQUOTE'].includes(child.tag.toUpperCase()));
    if (nested) {
      blocks.push(...renderBlocks(node.children));
      continue;
    }
    if (inline) blocks.push(inline);
  }
  return blocks;
}

export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';
  return renderBlocks(parseHtml(html)).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ *
 * Corpus links
 *
 * Expiring CDN links would be dead ends inside an exported archive, so
 * self-hosted media falls back to a stable in-app deep link instead.
 * ------------------------------------------------------------------ */

export function appWatchUrl(videoKey: string, startMs = 0): string {
  const ms = Math.max(0, Math.round(startMs));
  return `${APP_ORIGIN}/#watch/${encodeURIComponent(videoKey)}${ms > 0 ? `?t=${ms}` : ''}`;
}

export type CorpusLink = { url: string; label: string; external: boolean };

export function corpusLink(videoKey: string, startMs = 0): CorpusLink | null {
  if (!videoKey || videoKey === 'general') return null;
  try {
    const external = videoUrl(videoKey, startMs);
    if (external) return { url: external, label: videoKey.startsWith('bilibili:') ? '原页面' : '原视频', external: true };
  } catch { /* Unknown identities fall back to the in-app route. */ }
  return { url: appWatchUrl(videoKey, startMs), label: '在应用中打开', external: false };
}

/* ------------------------------------------------------------------ *
 * Document assembly
 * ------------------------------------------------------------------ */

export type ExportedNoteLink = AgentNote['links'][number] & { question?: AgentMessage; answer?: AgentMessage };
export type ExportedNote = Omit<AgentNote, 'links'> & { links: ExportedNoteLink[] };

export type ExportConversation = { conversation: AgentConversation; messages: AgentMessage[] };
export type ExportDictation = { videoKey: string; title: string; html: string; updatedAt: number };
export type ExportCorpus = {
  videoKey: string;
  title: string;
  mediaKind?: 'video' | 'audio' | undefined;
  dictation?: ExportDictation | undefined;
  notes: ExportedNote[];
  conversations: ExportConversation[];
  updatedAt: number;
};

export function exportDate(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function safeFileName(value: string, fallback = 'untitled'): string {
  const cleaned = value.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || fallback;
}

/** Corpus-result answers carry a zero-width placeholder instead of prose. */
function visibleContent(message: AgentMessage): string {
  return (message.content || '').replace(/\u200b/g, '').trim();
}

export function buildCorpusDocument(corpus: ExportCorpus, exportedAt: number): string {
  const { videoKey, title } = corpus;
  const link = corpusLink(videoKey);
  const kind = videoKey === 'general' ? '未关联视频' : corpus.mediaKind === 'audio' ? '音频' : '视频';
  const lines: string[] = [`# ${title}`, ''];
  lines.push(`- **类型**：${kind}`);
  lines.push(`- **语料标识**：\`${videoKey}\``);
  lines.push(link ? `- **来源**：${link.label} · [打开](${link.url})` : '- **来源**：未关联视频');
  lines.push(`- **最近更新**：${exportDate(corpus.updatedAt)}`);
  lines.push(`- **导出时间**：${exportDate(exportedAt)}`);
  lines.push('');

  const dictation = corpus.dictation?.html ? htmlToMarkdown(corpus.dictation.html) : '';
  lines.push('## 听写笔记', '');
  lines.push(dictation || '*（暂无内容）*');
  lines.push('');

  lines.push('## 字幕摘录', '');
  if (!corpus.notes.length) lines.push('*（暂无内容）*');
  corpus.notes.forEach((note, index) => {
    const reference = note.reference;
    const noteLink = corpusLink(reference.videoKey, reference.startMs);
    lines.push(`### ${index + 1}. ${reference.text || reference.highlight || '摘录'}`, '');
    const meta: string[] = [];
    if (noteLink && reference.startMs > 0) meta.push(`**时间**：${timecode(reference.startMs)} · [跳到原句](${noteLink.url})`);
    else if (noteLink) meta.push(`**时间**：${timecode(reference.startMs)}`);
    if (reference.highlight && reference.highlight !== reference.text) meta.push(`**高亮**：${reference.highlight}`);
    meta.push(`**记录时间**：${exportDate(note.createdAt)}`);
    if (meta.length) lines.push(`- ${meta.join('\n- ')}`);
    lines.push('');
    lines.push(note.body.trim() || '*（未写正文）*');
    if (note.links.length) {
      lines.push('', '#### 关联问答', '');
      note.links.forEach(link2 => {
        lines.push(`> **问**：${link2.question?.content?.trim() || '（问题不可用）'}`, '>', `> **答**：${link2.answer?.content?.trim() || '（回答不可用）'}`, '');
      });
    }
    lines.push('');
  });

  lines.push('## 对话', '');
  if (!corpus.conversations.length) lines.push('*（暂无内容）*');
  corpus.conversations.forEach(entry => {
    lines.push(`### ${entry.conversation.title || '未命名对话'}`, '');
    lines.push(`- **开始时间**：${exportDate(entry.conversation.createdAt)}`);
    lines.push('');
    for (const message of entry.messages) {
      const content = visibleContent(message);
      if (!content || (message.role !== 'user' && message.role !== 'assistant')) continue;
      lines.push(`**${message.role === 'user' ? '问' : '答'}**：${content}`, '');
      const sources = message.sources || [];
      if (sources.length) {
        lines.push(`> 参考资料：${sources.map(source => `[${source.title}](${source.href})`).join(' · ')}`, '');
      }
      if (message.context) {
        const contextLink = corpusLink(message.context.videoKey, message.context.timeMs);
        if (contextLink) lines.push(`> 提问时的语料：${timecode(message.context.timeMs)} · [打开](${contextLink.url})`, '');
      }
    }
    lines.push('');
  });

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export type ExportIndexRow = { file: string; title: string; videoKey: string; dictation: boolean; notes: number; conversations: number; link: CorpusLink | null };

export function buildExportIndex(rows: ExportIndexRow[], exportedAt: number): string {
  const totals = rows.reduce((acc, row) => ({
    dictations: acc.dictations + (row.dictation ? 1 : 0),
    notes: acc.notes + row.notes,
    conversations: acc.conversations + row.conversations,
  }), { dictations: 0, notes: 0, conversations: 0 });
  const lines = [
    '# Shadow Language 学习笔记导出',
    '',
    `> 导出时间 ${exportDate(exportedAt)} · ${rows.length} 个语料 · ${totals.dictations} 篇听写笔记 · ${totals.notes} 条字幕摘录 · ${totals.conversations} 段对话`,
    '',
    '| 语料 | 类型 | 听写笔记 | 摘录 | 对话 | 来源 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| [${row.title}](${encodeURI(row.file)}) | ${row.videoKey === 'general' ? '未关联视频' : row.videoKey.startsWith('media:') ? '语料' : '视频'} | ${row.dictation ? '✓' : ''} | ${row.notes} | ${row.conversations} | ${row.link ? `[${row.link.label}](${row.link.url})` : '—'} |`),
    '',
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * ZIP (stored, no dependency)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZipArchive(files: Array<{ name: string; content: string }>, modifiedAt: Date): Uint8Array {
  const encoder = new TextEncoder();
  const dosTime = (modifiedAt.getHours() << 11) | (modifiedAt.getMinutes() << 5) | Math.floor(modifiedAt.getSeconds() / 2);
  const dosDate = ((modifiedAt.getFullYear() - 1980) << 9) | ((modifiedAt.getMonth() + 1) << 5) | modifiedAt.getDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 filenames
    localView.setUint16(8, 0, true); // stored
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, end];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const archive = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) { archive.set(part, cursor); cursor += part.length; }
  return archive;
}

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

function dictationVideoKey(id: string): string | null {
  try {
    const value: unknown = JSON.parse(id);
    return Array.isArray(value) && typeof value[1] === 'string' ? value[1] : null;
  } catch { return null; }
}

export type AgentExport = { files: Array<{ name: string; content: string }>; rows: ExportIndexRow[]; fileName: string };

/** Groups every stored artefact under the corpus it belongs to. */
export function groupExportData(input: {
  dictations: Array<{ id: string; title?: string; html: string; updatedAt: number }>;
  notes: ExportedNote[];
  conversations: Array<{ conversation: AgentConversation; messages: AgentMessage[] }>;
}): ExportCorpus[] {
  const rows = new Map<string, ExportCorpus>();
  const bucket = (videoKey: string, title = ''): ExportCorpus => {
    const key = videoKey || 'general';
    const existing = rows.get(key);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      return existing;
    }
    const created: ExportCorpus = { videoKey: key, title: title || key, notes: [], conversations: [], updatedAt: 0 };
    rows.set(key, created);
    return created;
  };

  for (const record of input.dictations) {
    const videoKey = dictationVideoKey(record.id) || 'general';
    const row = bucket(videoKey, record.title || '');
    row.dictation = { videoKey, title: record.title || '', html: record.html, updatedAt: record.updatedAt };
    row.updatedAt = Math.max(row.updatedAt, record.updatedAt);
  }
  for (const note of input.notes) {
    const row = bucket(note.reference.videoKey, note.reference.title);
    row.notes.push(note);
    row.updatedAt = Math.max(row.updatedAt, note.updatedAt);
  }
  for (const entry of input.conversations) {
    const context = entry.conversation.videoContext;
    const videoKey = entry.conversation.videoKey || (context ? videoKeyOf(context) : '') || entry.messages.find(message => message.context)?.context?.videoKey || 'general';
    const row = bucket(videoKey, context?.title || '');
    row.conversations.push(entry);
    row.updatedAt = Math.max(row.updatedAt, entry.conversation.updatedAt);
  }
  return [...rows.values()]
    .filter(row => row.dictation || row.notes.length || row.conversations.length)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function buildAgentExport(input: {
  dictations: Array<{ id: string; title?: string; html: string; updatedAt: number }>;
  notes: ExportedNote[];
  conversations: Array<{ conversation: AgentConversation; messages: AgentMessage[] }>;
  onlyVideoKey?: string | undefined;
  now?: number;
}): AgentExport {
  const now = input.now ?? Date.now();
  const corpora = groupExportData(input).filter(row => !input.onlyVideoKey || row.videoKey === input.onlyVideoKey);
  const rows: ExportIndexRow[] = [];
  const files: Array<{ name: string; content: string }> = [];
  const used = new Set<string>();
  corpora.forEach((corpus, index) => {
    let name = `${String(index + 1).padStart(2, '0')}-${safeFileName(corpus.title)}.md`;
    while (used.has(name)) name = name.replace(/\.md$/, `-${used.size}.md`);
    used.add(name);
    files.push({ name, content: buildCorpusDocument(corpus, now) });
    rows.push({
      file: name,
      title: corpus.title,
      videoKey: corpus.videoKey,
      dictation: Boolean(corpus.dictation?.html),
      notes: corpus.notes.length,
      conversations: corpus.conversations.length,
      link: corpusLink(corpus.videoKey),
    });
  });
  if (files.length > 1) files.unshift({ name: 'README.md', content: buildExportIndex(rows, now) });
  const stamp = new Date(now);
  const date = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}`;
  return { files, rows, fileName: files.length > 1 ? `shadow-language-notes-${date}.zip` : files[0]?.name || `shadow-language-notes-${date}.zip` };
}

/** Reads every stored artefact for one owner. Only the owner's own rows are read. */
export async function collectAgentExport(owner: string, onlyVideoKey?: string) {
  const [dictations, notes, conversations] = await Promise.all([
    agentDb.dictations.where('owner').equals(owner).toArray(),
    agentDb.notes.where('owner').equals(owner).toArray(),
    agentDb.conversations.where('owner').equals(owner).toArray(),
  ]);
  const messages = await Promise.all(conversations.map(async conversation => ({
    conversation,
    messages: await agentDb.messages.where('conversationId').equals(conversation.id).sortBy('createdAt'),
  })));
  const linkedAnswers = new Map<string, AgentMessage>();
  const linkedQuestions = new Map<string, AgentMessage>();
  await Promise.all(notes.flatMap(note => note.links.map(async link => {
    const [question, answer] = await Promise.all([agentDb.messages.get(link.questionId), agentDb.messages.get(link.answerId)]);
    if (question) linkedQuestions.set(link.questionId, question);
    if (answer) linkedAnswers.set(link.answerId, answer);
  })));
  const hydrated: ExportedNote[] = notes.map(note => ({
    ...note,
    links: note.links.map(link => ({
      ...link,
      ...(linkedQuestions.get(link.questionId) ? { question: linkedQuestions.get(link.questionId)! } : {}),
      ...(linkedAnswers.get(link.answerId) ? { answer: linkedAnswers.get(link.answerId)! } : {}),
    })),
  }));
  return buildAgentExport({ dictations, notes: hydrated, conversations: messages, ...(onlyVideoKey ? { onlyVideoKey } : {}) });
}

export function downloadExport(content: string | ArrayBuffer, fileName: string, mimeType: string) {
  return downloadPlatformFile(new Blob([content], { type: mimeType }), fileName, '学习笔记与对话');
}
