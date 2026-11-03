import { beforeEach, expect, it, vi } from 'vitest';
import { isStudyDocumentReady, studyDocumentBlocks, studyDocumentId, studyDocumentMessages } from './study-document-format';

const mocks = vi.hoisted(() => ({ model: vi.fn(), put: vi.fn(), get: vi.fn(), auth: vi.fn(), publicLoad: vi.fn() }));
vi.mock('../public-transcript', () => ({ loadYoutubeTranscript: mocks.publicLoad }));
vi.mock('./provider', () => ({ completeModel: mocks.model }));
vi.mock('./credentials', () => ({ readKey: async () => 'user-owned-key' }));
vi.mock('../user-transcripts', () => ({ readUserTranscript: async () => undefined, saveUserTranscript: async () => {} }));
vi.mock('../db', () => ({ getLocalSettings: async () => ({ vocabularySize: 1_000 }), db: {
  table: () => ({ get: async () => undefined, where: () => ({ equals: () => ({ toArray: async () => [] }) }) }),
  assets: { toArray: async () => [{ displayValue: 'check in', contextText: 'I would like to check in.', note: '', youtubeId: 'MYX7RVOf3Yc', occurredAt: '2026-09-10' }] },
  progress: { toArray: async () => [] }, captions: { where: () => ({ equals: () => ({ toArray: async () => [], reverse: () => ({ sortBy: async () => [] }) }) }) },
} }));
vi.mock('./store', () => ({ agentDb: {
  documents: { get: mocks.get, put: mocks.put }, messages: { get: async () => undefined },
  memories: { where: () => ({ equals: (owner: string) => ({ toArray: async () => [{ text: `目标属于 ${owner}` }] }) }) },
  notes: { where: () => ({ equals: () => ({ reverse: () => ({ sortBy: async () => [] }) }) }) },
  conversations: { where: () => ({ equals: () => ({ reverse: () => ({ sortBy: async () => [] }) }) }) },
} }));
import { generateStudyDocument } from './study-documents';
import type { PageState } from '@shadow-language/contracts';

const page = { youtubeId: 'MYX7RVOf3Yc', title: 'Hotel', cues: [{ seq: 0, startMs: 1000, endMs: 2000, text: 'Welcome to the hotel.' }] } as PageState;
const input = () => ({ owner: 'user:one', corpus: { videoKey: 'MYX7RVOf3Yc', title: 'Hotel', page }, kind: 'preview' as const,
  signal: new AbortController().signal, onText: vi.fn(), onStatus: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.publicLoad.mockResolvedValue({ cues: [] });
  mocks.auth.mockResolvedValue({ signedIn: true, user: { uid: 'one' } });
  mocks.get.mockResolvedValue(undefined);
  mocks.model.mockResolvedValue({ content: '# 预习\n\n## 1. 单词\n- welcome\n\n## 2. 短语动词\n- check in\n\n## 3. 习惯用语\n- thank you\n\n## 4. 常用句式\n- I need to [动作]\n\n## 听力关注点\n- 连读' });
  vi.stubGlobal('browser', { runtime: { sendMessage: mocks.auth }, tabs: { query: async () => [] } });
  vi.stubGlobal('navigator', { locks: { request: (_: string, __: unknown, fn: (lock: object) => unknown) => fn({}) } });
});

it('keeps owners, corpora and document kinds in separate stable identities', () => {
  expect(new Set([studyDocumentId('a', 'x', 'preview'), studyDocumentId('b', 'x', 'preview'), studyDocumentId('a', 'y', 'preview'), studyDocumentId('a', 'x', 'review')]).size).toBe(4);
});
it('extracts folded answers including partial streaming output without accepting HTML attributes', () => {
  expect(studyDocumentBlocks('Question\n<details open onclick="bad()"><summary>Answer</summary>**One**</details>\nNext\n<details><summary>参考答案</summary>Two')).toEqual([
    { text: 'Question\n', answer: false }, { text: '**One**', answer: true }, { text: '\nNext\n', answer: false }, { text: 'Two', answer: true },
  ]);
});
it('keeps user data outside system instructions and distinguishes preview from review', () => {
  const messages = studyDocumentMessages('review', { note: 'untrusted unique text' });
  expect(messages[0]?.content).not.toContain('untrusted unique text');
  expect(messages[1]?.content).toContain('untrusted unique text');
  expect(messages[0]?.content).toContain('没有本次困难记录');
});
it('requires the preview quick-scan sections and keeps review flexible', () => {
  const preview = '# 预习\n## 1. 单词\n## 2. 短语动词\n## 3. 习惯用语\n## 4. 常用句式';
  expect(isStudyDocumentReady('preview', preview)).toBe(true);
  expect(isStudyDocumentReady('preview', '## 单词\n## 短语动词')).toBe(false);
  expect(isStudyDocumentReady('preview', '## 1. 短语动词\n## 2. 单词\n## 3. 习惯用语\n## 4. 常用句式')).toBe(false);
  expect(isStudyDocumentReady('review', '# 复习\n重点')).toBe(true);
  expect(studyDocumentMessages('preview', {})[0]?.content).toContain('短语动词');
  expect(studyDocumentMessages('preview', {})[0]?.content).toContain('预习不加自测题、参考答案');
});
it('generates from actual subtitles and learning history then saves the corpus association', async () => {
  await generateStudyDocument(input());
  const prompt = JSON.stringify(mocks.model.mock.calls[0]![0].messages);
  expect(prompt).toContain('Welcome to the hotel.');
  expect(prompt).toContain('目标属于 user:one');
  expect(prompt).toContain('check in');
  expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({ owner: 'user:one', videoKey: 'MYX7RVOf3Yc', documentKind: 'preview', documentFormatVersion: 'preview-quick-scan-v1' }));
});
it('does not save a preview that omits one of the quick-scan sections', async () => {
  mocks.model.mockResolvedValue({ content: '# 预习\n## 1. 单词\n只有词汇，没有完整速览。' });
  await expect(generateStudyDocument(input())).rejects.toThrow('缺少单词、短语动词、习惯用语或常用句式速览');
  expect(mocks.put).not.toHaveBeenCalled();
});
it('does not generate from a title alone', async () => {
  const value = input(); value.corpus.page = { ...page, cues: [] };
  await expect(generateStudyDocument(value)).rejects.toThrow('没有这份语料的字幕');
  expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled();
});
it('preserves the previous document when generation fails', async () => {
  mocks.get.mockResolvedValue({ text: 'original', createdAt: 10 });
  mocks.model.mockRejectedValue(new Error('connection interrupted'));
  await expect(generateStudyDocument(input())).rejects.toThrow('connection interrupted');
  expect(mocks.put).not.toHaveBeenCalled();
});
it('saves review separately and preserves the creation date on regeneration', async () => {
  mocks.get.mockResolvedValue({ createdAt: 10, text: 'old review' });
  await generateStudyDocument({ ...input(), kind: 'review' });
  expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({
    id: studyDocumentId('user:one', 'MYX7RVOf3Yc', 'review'), documentKind: 'review', createdAt: 10,
  }));
  expect(mocks.model.mock.calls[0]![0].messages[0].content).toContain('复习围绕语料');
});
it('requires login before sending any user data to the centralized AI service', async () => {
  vi.stubEnv('VITE_SHADOW_WEB', 'true');
  const value = input(); value.owner = 'local';
  mocks.auth.mockResolvedValue({ signedIn: false, user: null });
  await expect(generateStudyDocument(value)).rejects.toThrow('登录 Shadow Language');
  expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled();
});
it('does not save after account switching or cancellation', async () => {
  mocks.model.mockImplementation(async () => { mocks.auth.mockResolvedValue({ signedIn: true, user: { uid: 'two' } }); return { content: 'new' }; });
  await expect(generateStudyDocument(input())).rejects.toThrow('账号已切换');
  expect(mocks.put).not.toHaveBeenCalled();
});
it('aborted generations cannot overwrite saved documents', async () => {
  const abort = new AbortController();
  mocks.model.mockImplementation(async () => { abort.abort(); return { content: 'new' }; });
  await expect(generateStudyDocument({ ...input(), signal: abort.signal })).rejects.toThrow();
  expect(mocks.put).not.toHaveBeenCalled();
});

it('loads published captions for web preview before the video has been opened', async () => {
  vi.stubEnv('VITE_SHADOW_WEB', 'true');
  mocks.publicLoad.mockResolvedValue(page);
  const value = input(); value.corpus.page = { ...page, cues: [] };
  await generateStudyDocument(value);
  expect(mocks.publicLoad).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'MYX7RVOf3Yc', cues: [] }));
  expect(JSON.stringify(mocks.model.mock.calls[0]![0].messages)).toContain('Welcome to the hotel.');
});
it('does not generate a web preview when public captions are unavailable', async () => {
  vi.stubEnv('VITE_SHADOW_WEB', 'true');
  const value = input(); value.corpus.page = { ...page, cues: [] };
  await expect(generateStudyDocument(value)).rejects.toThrow('没有这份语料的字幕');
  expect(mocks.model).not.toHaveBeenCalled();
});
it('does not use the web public-caption fallback for extension previews', async () => {
  const value = input(); value.corpus.page = { ...page, cues: [] };
  await expect(generateStudyDocument(value)).rejects.toThrow();
  expect(mocks.publicLoad).not.toHaveBeenCalled();
});
