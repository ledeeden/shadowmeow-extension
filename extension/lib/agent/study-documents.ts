import { readVideoTranscript, saveVideoTranscript } from '../video-transcript';
import { mappedSubtitleCues, subtitleResolutionSchema, videoKeyOf, videoUrl, type PageState, type CaptionCue } from '@shadow-language/contracts';
import { db, getLocalSettings } from '../db';
import { unwrapRuntimeResponse } from '../runtime-errors';
import { agentDb, type KnowledgeDocument } from './store';
import { completeModel } from './provider';
import { readKey } from './credentials';
import { isStudyDocumentReady, studyDocumentFormatVersion, studyDocumentId, studyDocumentLabel, studyDocumentMessages, type StudyDocumentKind } from './study-document-format';

export type StudyCorpus = { videoKey: string; title: string; durationMs?: number; page?: PageState };

export async function studyOwner() {
  const auth = unwrapRuntimeResponse(await browser.runtime.sendMessage({ type: 'AUTH_STATUS' })) as { signedIn: boolean; user?: { uid?: string; id?: string; _id?: string } };
  const id = auth.user?.uid || auth.user?.id || auth.user?._id;
  if (auth.signedIn && !id) throw new Error('无法读取账号身份，请重新登录。');
  return auth.signedIn && id ? `user:${id}` : 'local';
}

async function transcript(owner: string, corpus: StudyCorpus): Promise<CaptionCue[]> {
  if (corpus.page && videoKeyOf(corpus.page) === corpus.videoKey && corpus.page.cues.length) return corpus.page.cues;
  const local = await readVideoTranscript(corpus.videoKey);
  if (local) return local.cues;
  // Only inspect extension-enabled video tabs, never general browsing history.
  const tabs = await browser.tabs.query({ url: ['https://www.youtube.com/*', 'https://www.bilibili.com/*'] });
  const pages = await Promise.all(tabs.map(async tab => {
    if (tab.id == null) return null;
    return browser.tabs.sendMessage(tab.id, { type: 'PAGE_GET_STATE' }).catch(() => null) as Promise<PageState | null>;
  }));
  const page = pages.find(value => value && videoKeyOf(value) === corpus.videoKey && value.cues?.length);
  if (page) { await saveVideoTranscript(page); return page.cues; }
  if (corpus.videoKey.startsWith('bilibili:') && corpus.durationMs) {
    const raw = unwrapRuntimeResponse(await browser.runtime.sendMessage({ type: 'CORPUS_RESOLVE_SUBTITLES', videoKey: corpus.videoKey, durationMs: corpus.durationMs }));
    const resolution = subtitleResolutionSchema.safeParse(raw);
    if (resolution.success) {
      const cues = mappedSubtitleCues(resolution.data, 'en');
      await saveVideoTranscript({ youtubeId: null, videoKey: corpus.videoKey, platform: 'bilibili', title: corpus.title,
        durationMs: corpus.durationMs, timeMs: 0, playbackRate: 1, playerState: 'paused', tracks: [], activeTrackId: null, cues, segments: [] });
      return cues;
    }
  }
  const conversations = await agentDb.conversations.where('owner').equals(owner).reverse().sortBy('updatedAt');
  const saved = conversations.find(row => row.videoContext && videoKeyOf(row.videoContext) === corpus.videoKey && row.videoContext.cues.length);
  if (saved?.videoContext?.cues.length) return saved.videoContext.cues;
  if (import.meta.env.VITE_SHADOW_WEB && /^[A-Za-z0-9_-]{11}$/.test(corpus.videoKey)) {
    const { loadYoutubeTranscript } = await import('../public-transcript');
    const online = await loadYoutubeTranscript({ youtubeId: corpus.videoKey, videoKey: corpus.videoKey, platform: 'youtube',
      title: corpus.title, durationMs: corpus.durationMs || 0, timeMs: 0, playbackRate: 1, playerState: 'paused',
      tracks: [], activeTrackId: null, cues: [], segments: [] });
    if (online.cues.length) return online.cues;
  }
  return [];
}

export async function generateStudyDocument(input: {
  owner: string; corpus: StudyCorpus; kind: StudyDocumentKind; signal: AbortSignal;
  onText: (text: string) => void; onStatus: (text: string) => void;
}) {
  const id = studyDocumentId(input.owner, input.corpus.videoKey, input.kind);
  return navigator.locks.request(id, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('这个文档正在另一个页面生成，请稍后查看。');
    const assertOwner = async () => {
      input.signal.throwIfAborted();
      if (await studyOwner() !== input.owner) throw new Error('账号已切换，请重新打开文档。');
      input.signal.throwIfAborted();
    };
    await assertOwner();
    const hostedAi = Boolean(import.meta.env.VITE_SHADOW_WEB);
    if (hostedAi && input.owner === 'local') throw new Error('请先登录 Shadow Language 账号后使用 AI 服务。');
    const key = hostedAi ? undefined : await readKey();
    if (!hostedAi && !key) throw new Error('请先在 Agent 的 AI 设置中配置 DeepSeek Key。');
    input.onStatus('正在读取语料与学习记录…');
    const cues = await transcript(input.owner, input.corpus);
    if (!cues.length) throw new Error('暂时没有这份语料的字幕。请先打开视频并加载英文字幕，再回来生成。');
    const [settings, memories, notes, assets, progress, previous] = await Promise.all([
      getLocalSettings(), agentDb.memories.where('owner').equals(input.owner).toArray(),
      agentDb.notes.where('owner').equals(input.owner).reverse().sortBy('updatedAt'),
      db.assets.toArray(), db.progress.toArray(), agentDb.documents.get(id),
    ]);
    const relevantNotes = notes.filter(n => n.reference.videoKey === input.corpus.videoKey).slice(0, 12);
    const questions = await Promise.all(relevantNotes.flatMap(n => n.links.slice(-3)).map(async link => {
      const question = await agentDb.messages.get(link.questionId);
      return question?.owner === input.owner ? question.content?.slice(0, 1000) : null;
    }));
    const lines = cues.map(c => `[${Math.floor(c.startMs / 60000)}:${String(Math.floor(c.startMs / 1000) % 60).padStart(2, '0')}] (${videoUrl(input.corpus.videoKey, c.startMs)}) ${c.text}`);
    const fullTranscript = lines.join('\n');
    const context = {
      corpus: { title: input.corpus.title, url: videoUrl(input.corpus.videoKey), transcript: fullTranscript.slice(0, 65000), truncated: fullTranscript.length > 65000 },
      learner: { vocabularySizeSetting: settings.vocabularySize, memories: memories.slice(-30).map(m => m.text.slice(0, 1000)),
        notes: relevantNotes.map(n => ({ quote: n.reference.text, note: n.body.slice(0, 2000) })), questions,
        recentNotes: notes.slice(0, 8).map(n => ({ title: n.reference.title, note: n.body.slice(0, 800), quote: n.reference.highlight })),
        savedExpressions: assets.filter(a => !a.deletedAt).sort((a, b) => Number(videoKeyOf(b) === input.corpus.videoKey) - Number(videoKeyOf(a) === input.corpus.videoKey) || b.occurredAt.localeCompare(a.occurredAt)).slice(0, 20).map(a => ({ text: a.displayValue, context: a.contextText, note: a.note, videoKey: videoKeyOf(a) })),
        viewingHistory: progress.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 15).map(p => ({ title: p.title, videoKey: videoKeyOf(p), positionMs: p.positionMs, occurredAt: p.occurredAt })),
        coverage: '本机已有记录。没有作答或掌握情况验证，缺失记录表示未知。' },
    };
    await assertOwner();
    input.onStatus(`正在生成${studyDocumentLabel[input.kind]}文档…`);
    const result = await completeModel({ ...(key ? { key } : {}), purpose: 'study_document', messages: studyDocumentMessages(input.kind, context), signal: input.signal, onText: input.onText });
    if (!result.content?.trim() || result.tool_calls?.length) throw new Error('没有收到完整文档，请重试。');
    await assertOwner();
    if (!isStudyDocumentReady(input.kind, result.content)) throw new Error('预习文档缺少单词、短语动词、习惯用语或常用句式速览，请重试。');
    const document: KnowledgeDocument = { id, owner: input.owner, videoKey: input.corpus.videoKey, documentKind: input.kind,
      sourceUrl: videoUrl(input.corpus.videoKey), title: `${input.corpus.title} · ${studyDocumentLabel[input.kind]}`,
      text: result.content.trim(), documentFormatVersion: studyDocumentFormatVersion[input.kind], createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now() };
    await agentDb.documents.put(document);
    return document;
  });
}
