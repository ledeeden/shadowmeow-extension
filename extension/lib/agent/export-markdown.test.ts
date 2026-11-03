import { describe, expect, it } from 'vitest';
import type { AgentConversation, AgentMessage } from './store';
import {
  appWatchUrl,
  buildAgentExport,
  buildCorpusDocument,
  corpusLink,
  createZipArchive,
  htmlToMarkdown,
  safeFileName,
  timecode,
  type ExportedNote,
} from './export-markdown';

const NOW = Date.parse('2026-10-15T13:30:00+08:00');

function message(partial: Partial<AgentMessage> & Pick<AgentMessage, 'role'>): AgentMessage {
  const { role, ...rest } = partial;
  return { id: `m_${role}`, owner: 'user:1', conversationId: 'c_1', content: '', createdAt: NOW, status: 'complete', ...rest, role };
}

function note(partial: Partial<ExportedNote> & Pick<ExportedNote, 'reference'>): ExportedNote {
  return { id: partial.id || 'n_1', owner: 'user:1', reference: partial.reference, body: partial.body ?? '', links: partial.links ?? [], createdAt: partial.createdAt ?? NOW, updatedAt: partial.updatedAt ?? NOW };
}

describe('HTML → Markdown', () => {
  it('converts the toolbar tag set', () => {
    expect(htmlToMarkdown('<p>plain <b>bold</b> and <i>italic</i> and <u>under</u></p>')).toBe('plain **bold** and *italic* and <u>under</u>');
    expect(htmlToMarkdown('<h2>Title</h2><p>body</p>')).toBe('## Title\n\nbody');
    expect(htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
    expect(htmlToMarkdown('<ol><li>first</li><li>second</li></ol>')).toBe('1. first\n2. second');
    expect(htmlToMarkdown('<p><a href="https://example.com/x">link</a></p>')).toBe('[link](https://example.com/x)');
    expect(htmlToMarkdown('<div>a</div><div>b</div>')).toBe('a\n\nb');
    expect(htmlToMarkdown('<p>one<br>two</p>')).toBe('one\ntwo');
  });

  it('decodes entities and keeps the writer’s own ampersands readable', () => {
    expect(htmlToMarkdown('<p>AT&amp;T &lt;tag&gt; &#39;quoted&#39;</p>')).toBe("AT&T <tag> 'quoted'");
  });

  it('survives unbalanced markup from pasted html', () => {
    expect(htmlToMarkdown('<div><p>keep</div></p><p>this</p>')).toContain('keep');
    expect(htmlToMarkdown('<p>text<script>alert(1)</script></p>')).toBe('text');
    expect(htmlToMarkdown('   ')).toBe('');
  });
});

describe('Corpus links', () => {
  it('uses the original platform when one exists', () => {
    expect(corpusLink('dQw4w9WgXcQ', 12_500)).toEqual({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s', label: '原视频', external: true });
    expect(corpusLink('bilibili:ep:4173750:cid:38850857680')).toMatchObject({ label: '原页面', external: true });
  });

  it('falls back to a stable in-app deep link for self-hosted media', () => {
    expect(corpusLink('media:englishpod-b001', 5_000)).toEqual({
      url: 'https://shadowmeow.ledetools.com/#watch/media%3Aenglishpod-b001?t=5000',
      label: '在应用中打开',
      external: false,
    });
    expect(corpusLink('media:youtube-d0yGdNEWdn0')).toMatchObject({ external: true });
  });

  it('never invents a link for detached notes', () => {
    expect(corpusLink('general')).toBeNull();
    expect(corpusLink('')).toBeNull();
  });

  it('formats timecodes and filenames safely', () => {
    expect(timecode(75_000)).toBe('1:15');
    expect(safeFileName('a/b:c*d?')).toBe('a b c d');
    expect(safeFileName('  ')).toBe('untitled');
    expect(appWatchUrl('media:x1')).toBe('https://shadowmeow.ledetools.com/#watch/media%3Ax1');
  });
});

describe('Corpus documents', () => {
  it('records the corpus link, dictation and every excerpt', () => {
    const markdown = buildCorpusDocument({
      videoKey: 'dQw4w9WgXcQ',
      title: 'Hotel English',
      updatedAt: NOW,
      dictation: { videoKey: 'dQw4w9WgXcQ', title: 'Hotel English', html: '<p>check in = 办理入住</p>', updatedAt: NOW },
      notes: [note({ reference: { id: 'r1', videoKey: 'dQw4w9WgXcQ', title: 'Hotel English', url: '', startMs: 10_000, endMs: 13_000, text: 'I would like to check in, please.', highlight: 'I would like to check in, please.', trackId: '.en', createdAt: NOW }, body: '前台会问你要几晚' })],
      conversations: [],
    }, NOW);

    expect(markdown).toContain('# Hotel English');
    expect(markdown).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s');
    expect(markdown).toContain('check in = 办理入住');
    expect(markdown).toContain('### 1. I would like to check in, please.');
    expect(markdown).toContain('[跳到原句](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s)');
    expect(markdown).toContain('前台会问你要几晚');
  });

  it('renders linked answers and skips placeholder-only corpus replies', () => {
    const markdown = buildCorpusDocument({
      videoKey: 'general',
      title: '今天记的',
      updatedAt: NOW,
      notes: [note({ reference: { id: 'r2', videoKey: 'general', title: '今天记的', url: '', startMs: 0, endMs: 0, text: '今天记的', highlight: '今天记的', trackId: null, createdAt: NOW }, body: '打扫花了 48 小时', links: [{ conversationId: 'c_1', questionId: 'm_user', answerId: 'm_assistant', question: message({ role: 'user', content: 'check in 是什么？' }), answer: message({ role: 'assistant', content: '办理入住' }) }] })],
      conversations: [{ conversation: { id: 'c_1', owner: 'user:1', title: '闲聊', createdAt: NOW, updatedAt: NOW }, messages: [message({ role: 'user', content: '你好' }), message({ role: 'assistant', content: '\u200b', presentation: 'corpus-results' }), message({ role: 'assistant', content: '你好，我在', sources: [{ id: 's1', kind: 'video', title: '原片', href: 'https://youtu.be/x' }] })] }],
    }, NOW);

    expect(markdown).toContain('- **来源**：未关联视频');
    expect(markdown).toContain('> **问**：check in 是什么？');
    expect(markdown).toContain('> **答**：办理入住');
    expect(markdown).toContain('**问**：你好');
    expect(markdown).toContain('> 参考资料：[原片](https://youtu.be/x)');
    expect(markdown).not.toContain('\u200b');
  });
});

describe('Agent export', () => {
  const corpora = {
    dictations: [
      { id: JSON.stringify(['user:1', 'dQw4w9WgXcQ']), title: 'Hotel English', html: '<p>check in = 办理入住</p>', updatedAt: NOW },
      { id: JSON.stringify(['user:1', 'media:englishpod-b001']), title: 'EnglishPod B001', html: '<p>podcast notes</p>', updatedAt: NOW - 1000 },
    ],
    notes: [] as ExportedNote[],
    conversations: [] as Array<{ conversation: AgentConversation; messages: AgentMessage[] }>,
  };

  it('writes one file per corpus plus a README index', () => {
    const result = buildAgentExport({ ...corpora, now: NOW });
    expect(result.fileName).toMatch(/^shadow-language-notes-\d{8}\.zip$/);
    expect(result.files.map(file => file.name)).toEqual(['README.md', '01-Hotel English.md', '02-EnglishPod B001.md']);
    expect(result.files[0]!.content).toContain('2 个语料');
    expect(result.files[0]!.content).toContain('https://shadowmeow.ledetools.com/#watch/media%3Aenglishpod-b001');
  });

  it('narrows to a single corpus and skips the index for one file', () => {
    const result = buildAgentExport({ ...corpora, onlyVideoKey: 'media:englishpod-b001', now: NOW });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.name).toBe('01-EnglishPod B001.md');
    expect(result.fileName).toBe('01-EnglishPod B001.md');
  });

  it('groups a video-less conversation into the detached bucket', () => {
    const result = buildAgentExport({
      ...corpora,
      dictations: [],
      notes: [],
      conversations: [{ conversation: { id: 'c_9', owner: 'user:1', title: '随便聊聊', createdAt: NOW, updatedAt: NOW }, messages: [message({ role: 'user', content: 'hi' })] }],
      now: NOW,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.videoKey).toBe('general');
    expect(result.rows[0]!.link).toBeNull();
  });

  it('drops corpora that hold nothing at all', () => {
    expect(buildAgentExport({ ...corpora, dictations: [], notes: [], conversations: [], now: NOW }).files).toEqual([]);
  });
});

describe('Zip archive', () => {
  it('produces a readable stored archive', () => {
    const archive = createZipArchive([{ name: 'README.md', content: '# 索引' }, { name: '01-笔记.md', content: '# 正文' }], new Date(NOW));
    expect(archive.byteLength).toBeGreaterThan(0);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(archive.byteLength - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(archive.byteLength - 22 + 10, true)).toBe(2);
    // Chinese filenames must be flagged as UTF-8 or unzip tools mangle them.
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
  });
});
