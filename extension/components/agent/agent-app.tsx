import { t } from '../../lib/i18n';
import { Icon, type IconName } from '../icon';
import React, { useEffect, useRef, useState } from 'react';
import { ExtensionUpdateNotice } from '../extension-update-notice';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { liveQuery } from 'dexie';
import { videoKeyOf, videoUrl, type PageState, randomId } from '@shadow-language/contracts';
import {
  agentDb,
  createConversation,
  deleteConversation,
  saveHighlight,
  type AgentAttachment,
  type AgentConversation,
  type AgentMessage,
  type AgentNote,
  type VideoReference,
  type KnowledgeDocument,
} from '../../lib/agent/store';
import { readKey } from '../../lib/agent/credentials';
import { createAgentOwnerRefresh } from '../../lib/agent/session-owner';
import { FOLLOW_UP_QUESTION_COUNT, fallbackFollowUpQuestions, isEnglishConversation } from '../../lib/agent/follow-up-questions';
import { runAgent } from '../../lib/agent/runtime';
import { collectAgentExport, createZipArchive, downloadExport } from '../../lib/agent/export-markdown';
import { unwrapRuntimeResponse } from '../../lib/runtime-errors';
import { NewWordsPanel, useNewWords } from '../new-words-panel';
import { AgentHistoryDrawer } from './agent-history-drawer';
import { AgentSettingsDialog } from './agent-settings-dialog';
import { AiSettingsOpenerProvider } from './ai-settings-context';
import { StudyDocumentButtons } from './study-document';
import { AgentVideoList } from './agent-video-list';
import { useAgentVideoLibrary } from '../../lib/agent/video-library';
import { DictationEditor } from './dictation-editor';
import './agent.css';
import '../fonts.css';

export type AgentTab = 'chat' | 'words' | 'notes';
export type AgentLearningScene = {
  title: string; description: string; placeholder: string; context: string;
  prompts: Array<{ icon: IconName; label: string; prompt: string }>;
};

function sourceUrl(value: string): string {
  if (/^[A-Za-z0-9_-]{11}$/.test(value) || value.startsWith('bilibili:') || value.startsWith('media:')) {
    try {
      return videoUrl(value);
    } catch {
      return '';
    }
  }
  if (value.startsWith('#note=') || value.startsWith('#knowledge=')) return value;
  return /^https?:\/\//i.test(value) ? defaultUrlTransform(value) : '';
}

function CorpusResultList({ messages }: { messages: AgentMessage[] }) {
  const results = messages.filter(
    (message) =>
      message.presentation === 'corpus-results' &&
      message.status === 'complete' &&
      !message.sources?.length,
  );
  if (!results.length) return null;
  return (
    <div className="agent-corpus-results">
      {results.map((message) => (
        <p className="agent-search-empty" key={message.id}>
          {t("没有找到符合条件的资源")}</p>
      ))}
    </div>
  );
}

export function AgentApp({
  page,
  initialNoteId,
  initialTab = 'chat',
  activeTab,
  onActiveTabChange,
  reference,
  onReferenceSaved,
  onReplay,
  isDashboard = false,
  showAiSettingsButton = true,
  showBrandButton = true,
  externalDraft,
  learningScene,
}: {
  learningScene?: AgentLearningScene | undefined;
  externalDraft?: { id: string; text: string } | undefined;
  page?: PageState | undefined;
  initialNoteId?: string | undefined;
  initialTab?: AgentTab | undefined;
  activeTab?: AgentTab | undefined;
  onActiveTabChange?: ((tab: AgentTab) => void) | undefined;
  reference?: VideoReference | undefined;
  onReferenceSaved?: ((id: string) => void) | undefined;
  onReplay?: ((ms: number) => void) | undefined;
  isDashboard?: boolean | undefined;
  showAiSettingsButton?: boolean | undefined;
  showBrandButton?: boolean | undefined;
}) {
  const hostedAi = Boolean(import.meta.env.VITE_SHADOW_WEB);
  const inDashboard = isDashboard || (typeof location !== 'undefined' && location.pathname.includes('dashboard'));
  const [sessionLoaded, setSessionLoaded] = useState('');
  const [owner, setOwner] = useState('');
  const [sideView, setSideView] = useState<'none' | 'words' | 'notes'>(initialTab === 'chat' ? 'none' : initialTab);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isWideScreen, setIsWideScreen] = useState(false);

  const library = useAgentVideoLibrary(owner, page);
  const [notesVideoKey, setNotesVideoKey] = useState('');
  const [wordsVideoKey, setWordsVideoKey] = useState('');
  const noteVideos = library.videos.filter(item => item.hasNotes);
  const wordVideos = library.videos.filter(item => item.videoKey !== 'general');
  const selectedNoteVideo = noteVideos.find(item => item.videoKey === notesVideoKey) || noteVideos[0];
  const selectedWordVideo = wordVideos.find(item => item.videoKey === wordsVideoKey) || wordVideos[0];
  const wordsPage = selectedWordVideo?.page;
  const newWords = useNewWords(wordsPage);
  useEffect(() => {
    setNotesVideoKey(page ? videoKeyOf(page) : '');
    setWordsVideoKey(page ? videoKeyOf(page) : '');
  }, [owner, page ? videoKeyOf(page) : '']);
  const [openedDocument, setOpenedDocument] = useState('');
  const [conversationId, setConversationId] = useState(
    new URLSearchParams(location.search).get('conversation') || '',
  );
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [notes, setNotes] = useState<AgentNote[]>([]);
  const [noteId, setNoteId] = useState(initialNoteId || '');
  const [text, setText] = useState('');
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [imagePreview, setImagePreview] = useState<{ name: string; url: string }>();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [memories, setMemories] = useState<Array<{ id: string; text: string; owner: string; createdAt: number; updatedAt: number }>>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);

  const controller = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastExternalDraft = useRef('');
  useEffect(() => {
    if (!activeTab) return;
    setSideView(activeTab === 'chat' ? 'none' : activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (!externalDraft || busy || lastExternalDraft.current === externalDraft.id) return;
    lastExternalDraft.current = externalDraft.id;
    setSideView('none');
    setText(previous => previous.trim() ? `${previous}\n\n${externalDraft.text}` : externalDraft.text);
    setStatus(t("已带入当前句和附近字幕；确认后发送，不会自动调用 AI。"));
    const timer = window.setTimeout(() => chatInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [externalDraft, busy]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : t("操作失败，请重试。"));

  const runExport = async () => {
    if (!owner) return;
    setExporting(true); setError('');
    try {
      const onlyVideoKey = isDashboard ? undefined : page ? videoKeyOf(page) : undefined;
      const result = await collectAgentExport(owner, onlyVideoKey);
      if (!result.files.length) { setError(t("还没有可导出的笔记或对话。")); return; }
      const single = result.files.length === 1;
      const exported = single
        ? await downloadExport(result.files[0]!.content, result.fileName, 'text/markdown;charset=utf-8')
        : await downloadExport(createZipArchive(result.files, new Date()).buffer as ArrayBuffer, result.fileName, 'application/zip');
      if (exported === 'cancelled') return;
      setStatus(single ? t("已导出 1 个语料的 Markdown。") : t("已导出 {0} 个语料的 Markdown 压缩包。", result.files.length - 1));
    } catch (e) {
      fail(e);
    } finally { setExporting(false); }
  };

  const focusWorkspaceInput = (tab: typeof sideView) => {
    if (tab === 'words') return;
    window.requestAnimationFrame(() => {
      if (tab === 'none') {
        chatInputRef.current?.focus();
        return;
      }
      containerRef.current
        ?.querySelector<HTMLElement>('.dictation-editor[contenteditable="true"]')
        ?.focus();
    });
  };

  // Detect wide screen (for responsive desktop three-column workspace)
  useEffect(() => {
    const checkWidth = () => {
      if (containerRef.current) {
        setIsWideScreen(containerRef.current.clientWidth >= 880);
      } else {
        setIsWideScreen(window.innerWidth >= 880);
      }
    };
    checkWidth();
    window.addEventListener('resize', checkWidth);
    return () => window.removeEventListener('resize', checkWidth);
  }, []);

  const openSource = (href: string) => {
    if (href.startsWith('#knowledge=')) {
      setOpenedDocument(decodeURIComponent(href.slice(11)));
      setSettingsOpen(true);
      return true;
    }
    if (href.startsWith('#note=')) {
      const id = decodeURIComponent(href.slice(6));
      setNoteId(id);
      const linkedNote = notes.find(note => note.id === id);
      if (linkedNote) setNotesVideoKey(linkedNote.reference.videoKey);
      setSideView('notes');
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (!hostedAi) void readKey().then(setKey).catch(fail);
    const ownerRefresh = createAgentOwnerRefresh({
      readOwner: async () => {
        const value = await browser.runtime.sendMessage({ type: 'AUTH_STATUS' });
        const auth = unwrapRuntimeResponse(value) as {
          signedIn: boolean;
          user?: { uid?: string; id?: string; _id?: string };
          error?: string;
        };
        if (auth.error) throw new Error(auth.error);
        const id = auth.user?.uid || auth.user?.id || auth.user?._id;
        if (auth.signedIn && !id) throw new Error(t("无法读取账号身份，请重新登录后打开 Agent。"));
        return auth.signedIn && id ? `user:${id}` : 'local';
      },
      onChange: next => {
        controller.current?.abort();
        setOwner(next);
      },
      onError: fail,
    });
    void ownerRefresh.refresh();
    const listener = (message: { type?: string }) => {
      if (message.type === 'AUTH_CHANGED') void ownerRefresh.refresh();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => {
      ownerRefresh.dispose();
      controller.current?.abort();
      browser.runtime.onMessage.removeListener(listener);
    };
  }, [hostedAi]);

  const sessionKey = `sl-agent-session:${owner}:${page ? videoKeyOf(page) : 'general'}`;
  useEffect(() => {
    if (!owner) return;
    controller.current?.abort();
    setSessionLoaded('');
    const saved = localStorage.getItem(sessionKey);
    setConversationId(new URLSearchParams(location.search).get('conversation') || saved || '');
    setNoteId(new URLSearchParams(location.search).get('note') || '');
    setText(localStorage.getItem(`${sessionKey}:draft`) || '');
    setSessionLoaded(sessionKey);
  }, [sessionKey, owner]);

  useEffect(() => {
    if (sessionLoaded === sessionKey && owner) {
      localStorage.setItem(sessionKey, conversationId);
      localStorage.setItem(`${sessionKey}:draft`, text);
    }
  }, [sessionKey, owner, sessionLoaded, conversationId, text]);

  useEffect(() => {
    if (owner && reference) {
      void saveHighlight(owner, reference)
        .then((note) => {
          setNoteId(note.id);
          setNotesVideoKey(note.reference.videoKey);
          setSideView('notes');
          onReferenceSaved?.(reference.id);
        })
        .catch(fail);
    }
  }, [owner, reference?.id]);

  useEffect(() => {
    if (initialNoteId) {
      setNoteId(initialNoteId);
      setSideView('notes');
    }
  }, [initialNoteId]);

  useEffect(() => {
    if (initialTab === 'words') setSideView('words');
    else if (initialTab === 'notes') setSideView('notes');
    else if (!initialNoteId && !reference) setSideView('none');
  }, [initialTab]);

  useEffect(() => {
    if (!owner) return;
    const subscription = liveQuery(async () => ({
      conversations: await agentDb.conversations
        .where('owner')
        .equals(owner)
        .reverse()
        .sortBy('updatedAt'),
      messages: conversationId
        ? (await agentDb.messages.where('conversationId').equals(conversationId).sortBy('createdAt')).filter(
            (m) => m.owner === owner,
          )
        : [],
      notes: await agentDb.notes.where('owner').equals(owner).reverse().sortBy('updatedAt'),
      memories: await agentDb.memories.where('owner').equals(owner).toArray(),
      documents: await agentDb.documents.where('owner').equals(owner).toArray(),
    })).subscribe({
      next: (data) => {
        setConversations(data.conversations);
        setMessages(data.messages);
        setNotes(data.notes);
        setMemories(data.memories);
        setDocuments(data.documents);
      },
      error: fail,
    });
    return () => subscription.unsubscribe();
  }, [owner, conversationId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length, messages.at(-1)?.content]);

  const processFiles = async (files: File[]) => {
    const newAttachments: AgentAttachment[] = [];
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        if (file.size > 5 * 1024 * 1024) {
          setError(t("图片 {0} 超过 5MB 限制", file.name));
          continue;
        }
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          newAttachments.push({
            id: randomId(),
            name: file.name,
            type: 'image',
            size: file.size,
            dataUrl,
          });
        } catch {
          setError(t("读取图片 {0} 失败", file.name));
        }
      } else if (
        file.name.endsWith('.txt') ||
        file.name.endsWith('.md') ||
        file.type === 'text/plain' ||
        file.type === 'text/markdown'
      ) {
        if (file.size > 2 * 1024 * 1024) {
          setError(t("文本文件 {0} 超过 2MB 限制", file.name));
          continue;
        }
        try {
          const content = await file.text();
          newAttachments.push({
            id: randomId(),
            name: file.name,
            type: file.name.endsWith('.md') || file.type === 'text/markdown' ? 'markdown' : 'text',
            size: file.size,
            content,
          });
        } catch {
          setError(t("读取文件 {0} 失败", file.name));
        }
      } else {
        setError(`仅支持上传图片、.txt 或 .md 文件`);
      }
    }
    if (newAttachments.length) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length) {
      void processFiles(files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items || []);
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) {
      void processFiles(files);
    }
  };

  const send = async (value = text, pendingAttachments = attachments) => {
    const trimmed = value.trim();
    if ((!trimmed && pendingAttachments.length === 0) || busy || controller.current || !owner || sessionLoaded !== sessionKey) return;
    if (hostedAi && owner === 'local') {
      setSettingsOpen(true);
      setError(t("请先登录 Shadow Language 账号后使用 AI 服务。"));
      return;
    }
    if (!hostedAi && !key) {
      setSettingsOpen(true);
      setError(t("请先在 AI 设置中配置 DeepSeek Key。"));
      return;
    }
    setError('');
    setBusy(true);
    setText('');
    setAttachments([]);
    const abort = new AbortController();
    controller.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 180000);
    try {
      let id = conversationId;
      if (!id) {
        const convTitle = trimmed.slice(0, 30) || (pendingAttachments[0] ? pendingAttachments[0].name.slice(0, 30) : t("新对话"));
        const conversation = await createConversation(
          owner,
          convTitle,
          page ? videoKeyOf(page) : undefined,
        );
        id = conversation.id;
        setConversationId(id);
      }
      await runAgent({
        owner,
        conversationId: id,
        text: trimmed,
        attachments: pendingAttachments,
        ...(!hostedAi ? { key } : {}),
        signal: abort.signal,
        ...(page ? { page: structuredClone(page) } : {}),
        ...(learningScene ? { learningContext: learningScene.context } : {}),
        ...(noteId ? { noteId } : {}),
        onChange: () => undefined,
        onStatus: setStatus,
      });
    } catch (e) {
      if (abort.signal.aborted) setError(t("已停止回答，收到的内容已保存。"));
      else fail(e);
    } finally {
      clearTimeout(timeout);
      setBusy(false);
      controller.current = null;
    }
  };

  const handleNewConversation = () => {
    controller.current?.abort();
    setConversationId('');
    setNoteId('');
    setSideView('none');
  };

  const handleSelectConversation = (id: string) => {
    controller.current?.abort();
    setConversationId(id);
    setNoteId('');
    setSideView('none');
  };

  const handleRenameConversation = async (id: string, newTitle: string) => {
    try {
      await agentDb.conversations.update(id, { title: newTitle, updatedAt: Date.now() });
    } catch (e) {
      fail(e);
    }
  };

  const handleDeleteConversation = async (id: string) => {
    try {
      await deleteConversation(owner, id);
      if (conversationId === id) {
        setConversationId('');
        setNoteId('');
      }
    } catch (e) {
      fail(e);
    }
  };

  const currentNote = notes.find((note) => note.id === noteId);
  const quoteCurrent = async () => {
    if (!page || !owner) return;
    const cue =
      page.segments.find((c) => c.startMs <= page.timeMs && c.endMs >= page.timeMs) ||
      page.cues.find((c) => c.startMs <= page.timeMs && c.endMs >= page.timeMs);
    if (!cue) {
      setError(t("当前时间没有字幕，请播放到一句字幕后再记。"));
      return;
    }
    const note = await saveHighlight(owner, {
      id: randomId(),
      videoKey: videoKeyOf(page),
      title: page.title,
      url: videoUrl(videoKeyOf(page), cue.startMs),
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cue.text,
      highlight: cue.text,
      trackId: page.activeTrackId,
      createdAt: Date.now(),
    });
    setNoteId(note.id);
    setNotesVideoKey(note.reference.videoKey);
    setSideView('notes');
  };

  const visibleNotes = notes.filter(note => note.reference.videoKey === selectedNoteVideo?.videoKey);

  const activeConversation = conversations.find((c) => c.id === conversationId);

  const handleCopyMessage = async (id: string, content: string) => {
    const { safeClipboardWriteText } = await import('@shadow-language/contracts');
    const ok = await safeClipboardWriteText(content);
    if (!ok) return;
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const quickPrompts = learningScene?.prompts ?? (page
    ? [
        { icon: 'lightbulb' as const, label: t("解释当前句"), prompt: t('结合当前视频语境，请用简洁易懂的中文和地道英文解释当前这句字幕的核心意思与用法。') },
        { icon: 'speech' as const, label: t("拆解连读弱读"), prompt: t('请分析当前字幕在真实美式发音中的连读、弱读、失爆或重音技巧，指导我如何更地道地跟读。') },
        { icon: 'messages' as const, label: t("场景对话演练"), prompt: t('以当前视频话题为情景，扮演母语者跟我进行 3 轮日常英语对话练习，请先向我提出第一个问题。') },
        { icon: 'notebook' as const, label: t("提炼核心表达"), prompt: t('请帮我梳理当前视频中最实用、最地道的 3 个口语表达或习语，给出中文释义和生动例句。') },
      ]
    : [
        { icon: 'plane' as const, label: t("旅行高频口语"), prompt: t('教我 3 个在机场和酒店办理入住时最地道自然的英语口语表达。') },
        { icon: 'coffee' as const, label: t("咖啡馆点单演练"), prompt: t('我们来做一次角色扮演，你是咖啡师，我是顾客，请开始接待我。') },
        { icon: 'edit' as const, label: t("地道英语改写"), prompt: t('我给你一句中式英语，请帮我改成 3 种不同语调（日常口语/正式职场/幽默轻松）的地道英文表达。') },
      ]);

  const latestMessage = messages[messages.length - 1];
  const lastQuestion = [...messages].reverse().find(message => message.role === 'user');
  const followUps = latestMessage?.conversationId === conversationId && latestMessage.owner === owner && latestMessage.role === 'assistant' && latestMessage.status === 'complete' && !latestMessage.tool_calls?.length
    ? [...new Set([
        ...(latestMessage.followUpQuestions || []).filter(prompt => !isEnglishConversation(messages) || !/[\u3400-\u9fff]/.test(prompt)),
        ...fallbackFollowUpQuestions(lastQuestion?.content || '', messages),
      ])].slice(0, FOLLOW_UP_QUESTION_COUNT)
    : [];
  const displayedPrompts = messages.length
    ? followUps.map(prompt => ({ icon: 'messages' as const, label: prompt, prompt }))
    : quickPrompts;

  return (
    <AiSettingsOpenerProvider onOpen={() => setSettingsOpen(true)}>
    <section
      ref={containerRef}
      className={`agent-app ${isWideScreen ? 'wide-screen' : ''} ${inDashboard ? 'is-dashboard' : ''}`}
    >
      {!inDashboard && <ExtensionUpdateNotice />}
      {/* 顶部现代化导航 Header */}
      <header className="agent-nav">
        <div className="agent-nav-left">
          {!isWideScreen && (
            <button
              type="button"
              className="agent-icon-btn history-trigger"
              onClick={() => setHistoryOpen(!historyOpen)}
              title={sideView === 'none' ? t("查看会话记录") : t("查看视频列表")}
              aria-label={sideView === 'none' ? t("会话记录") : sideView === 'notes' ? t("视频笔记列表") : t("视频生词列表")}
            >
              <Icon name="menu" />
            </button>
          )}
          {showBrandButton && <button
            type="button"
            className="agent-brand"
            onClick={() => {
              setSideView('none');
              setHistoryOpen(false);
            }}
          >
            <Icon name="sparkles" />
          </button>}
          {sideView === 'none' && activeConversation && (
            <span className="agent-current-conv-pill" title={activeConversation.title}>
              {activeConversation.title}
            </span>
          )}
        </div>

        <div className="agent-header-actions">
          {sideView === 'none' && <button
            type="button"
            className="agent-action-pill"
            title={t("新建对话")}
            aria-label={t("新建对话")}
            disabled={busy}
            onClick={handleNewConversation}
          >
            <Icon name="plus" /> {t("新对话")}</button>}

          {/* One export per surface: the dashboard owns every record, a corpus page owns its own. */}
          {owner && (isDashboard || page) && <button
            type="button"
            className="agent-action-pill"
            title={isDashboard ? t("把所有笔记和对话导出为 Markdown 压缩包") : t("把当前语料的笔记和对话导出为 Markdown")}
            aria-label={isDashboard ? t("导出全部笔记为 Markdown") : t("导出当前语料笔记为 Markdown")}
            disabled={exporting}
            onClick={() => void runExport()}
          >
            <Icon name="download" /> {exporting ? t("导出中…") : isDashboard ? t("导出全部") : t("导出本语料")}
          </button>}

          {showAiSettingsButton && <button
            type="button"
            className="agent-icon-btn"
            title={t("AI 服务状态")}
            aria-label={t("AI 服务状态")}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" />
          </button>}
        </div>
      </header>

      <nav className="agent-primary-tabs" role="tablist" aria-label={t("学习工作区")}>
        {(['none', 'notes', 'words'] as const).map((tab, index) => (
          <button key={tab} type="button" role="tab" id={`agent-tab-${tab}`}
            aria-selected={sideView === tab} aria-controls={`agent-panel-${tab}`}
            tabIndex={sideView === tab ? 0 : -1}
            onKeyDown={(event) => {
              const tabs = ['none', 'notes', 'words'] as const;
              const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
              if (next < 0) return;
              event.preventDefault();
              setSideView(tabs[next]!);
              onActiveTabChange?.(tabs[next] === 'none' ? 'chat' : tabs[next]!);
              document.getElementById(`agent-tab-${tabs[next]}`)?.focus();
            }}
            onClick={() => {
              setSideView(tab);
              onActiveTabChange?.(tab === 'none' ? 'chat' : tab);
              setHistoryOpen(false);
              focusWorkspaceInput(tab);
            }}>
            {tab === 'none' ? t("对话") : tab === 'notes' ? t("笔记") : t("生词 {0}", newWords.entries.length)}
          </button>
        ))}
      </nav>
      {error && (
        <div className="agent-error" role="alert">
          <span>{error}</span>
          <button type="button" aria-label={t("关闭错误提示")} onClick={() => setError('')}>
            <Icon name="close" />
          </button>
        </div>
      )}

      {/* 主工作区（宽屏三栏 / 窄屏主对话+滑出抽屉） */}
      <div className="agent-main-workspace">
        {/* 左侧：历史会话抽屉（宽屏内嵌 / 窄屏覆盖滑出） */}
        {sideView === 'none' && <AgentHistoryDrawer
          isOpen={historyOpen}
          isEmbedded={isWideScreen}
          onClose={() => setHistoryOpen(false)}
          conversations={conversations}
          currentConversationId={conversationId}
          {...(page ? { currentVideoKey: videoKeyOf(page) } : {})}
          onSelectConversation={handleSelectConversation}
          onNewConversation={handleNewConversation}
          onDeleteConversation={handleDeleteConversation}
          onRenameConversation={handleRenameConversation}
        />}
        {sideView !== 'none' && <AgentVideoList key={sideView} kind={sideView}
          items={sideView === 'notes' ? noteVideos : wordVideos}
          selected={(sideView === 'notes' ? selectedNoteVideo : selectedWordVideo)?.videoKey || ''}
          onSelect={sideView === 'notes' ? setNotesVideoKey : setWordsVideoKey}
          isOpen={historyOpen} isEmbedded={isWideScreen} onClose={() => setHistoryOpen(false)} /> }

        {/* 中间：主对话区 */}
        <div className="agent-chat-stage" id="agent-panel-none" role="tabpanel" aria-labelledby="agent-tab-none" style={sideView !== 'none' ? { display: 'none' } : undefined}>
          {page && (
            <div className="agent-study-doc-bar">
              <span className="agent-doc-bar-label">{learningScene ? t("本章阅读准备 / 回顾：") : t("视频学习预习/复习速览：")}</span>
              <StudyDocumentButtons
                corpus={{
                  videoKey: videoKeyOf(page),
                  title: page.title,
                  durationMs: page.durationMs,
                  page,
                }}
              />
            </div>
          )}

          <CorpusResultList messages={messages} />

          <div className="agent-messages">
            {!messages.length && (
              <div className="agent-empty">
                <h2>{learningScene?.title || t("开启一段专属学习对话")}</h2>
                {learningScene ? <p>{learningScene.description}</p> : !page && (
                  <p>{t("随时询问英语表达、语法疑问、场景对话练习，或检索你学过的表达。")}</p>
                )}
                <div className="agent-empty-prompts">
                  {quickPrompts.map((item) => (
                    <button
                      type="button"
                      key={item.label}
                      className="agent-empty-prompt-btn"
                      onClick={() => void send(item.prompt)}
                    >
                      <span><Icon name={item.icon} /> {item.label}</span>
                      <small>{item.prompt}</small>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages
              .filter(
                (m) =>
                  m.role === 'user' ||
                  (m.role === 'assistant' && m.content && !m.tool_calls?.length),
              )
              .map((m) => (
                <article key={m.id} className={`agent-message ${m.role}`}>
                  {m.role === 'assistant' && !!m.steps?.length && (
                    <details className="agent-steps">
                      <summary>{t("查询过程 ·")}{((m.elapsedMs || 0) / 1000).toFixed(1)} {t("秒")}</summary>
                      {m.steps.map((step, index) => (
                        <div key={index}>{step}</div>
                      ))}
                    </details>
                  )}
                  {m.status === 'interrupted' && <small>{t("已中断")}</small>}

                  {!!m.attachments?.length && (
                    <div className="agent-message-attachments">
                      {m.attachments.map((att) =>
                        att.type === 'image' && att.dataUrl ? (
                          <div key={att.id} className="agent-msg-attachment-img-box">
                            <img
                              src={att.dataUrl}
                              alt={att.name}
                              className="agent-msg-attachment-img"
                              role="button"
                              tabIndex={0}
                              aria-label={t("查看大图：{0}", att.name)}
                              onClick={() => setImagePreview({ name: att.name, url: att.dataUrl! })}
                              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setImagePreview({ name: att.name, url: att.dataUrl! }); } }}
                              title={t("点击查看大图")}
                            />
                            <span className="agent-msg-attachment-name" title={att.name}>
                              {att.name}
                            </span>
                          </div>
                        ) : (
                          <div key={att.id} className="agent-msg-attachment-file" title={att.name}>
                            <span className="agent-msg-file-icon">
                              {att.type === 'markdown' ? <Icon name="notebook" /> : <Icon name="file" />}
                            </span>
                            <span className="agent-msg-file-name">{att.name}</span>
                            <span className="agent-msg-file-size">
                              ({(att.size / 1024).toFixed(1)} KB)
                            </span>
                          </div>
                        ),
                      )}
                    </div>
                  )}

                  <div className="agent-markdown">
                    <Markdown
                      urlTransform={sourceUrl}
                      remarkPlugins={[remarkGfm]}
                      skipHtml
                      components={{
                        a: ({ children, href }) => (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => {
                              if (href && openSource(href)) event.preventDefault();
                            }}
                          >
                            {children}
                          </a>
                        ),
                        img: () => null,
                      }}
                    >
                      {m.content || ''}
                    </Markdown>
                  </div>

                  {/* 消息底部交互条 */}
                  {m.role === 'assistant' && m.content && (
                    <div className="agent-message-footer">
                      <button
                        type="button"
                        className="agent-msg-action-btn"
                        title={t("复制内容")}
                        onClick={() => handleCopyMessage(m.id, m.content || '')}
                      >
                        {copiedId === m.id ? <><Icon name="check" /> {t("已复制")}</> : <><Icon name="clipboard" /> {t("复制")}</>}
                      </button>
                      {page && (
                        <button
                          type="button"
                          className="agent-msg-action-btn"
                          title={t("将这句解答收录至视频笔记")}
                          onClick={() => void quoteCurrent().catch(fail)}
                        >
                          <Icon name="pin" /> {t("记笔记")}</button>
                      )}
                    </div>
                  )}

                  {!!m.sources?.length && (
                    <div className="agent-sources">
                      {m.sources.map((source) => (
                        <a
                          key={source.id}
                          href={source.href}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => {
                            if (openSource(source.href)) event.preventDefault();
                          }}
                        >
                          {source.thumbnail && (
                            <img src={source.thumbnail} alt="" loading="lazy" />
                          )}
                          <span>
                            <strong>{source.title}</strong>
                            <small>
                              {source.detail || (source.kind === 'note' ? t("笔记") : t("知识库"))} <Icon name="external" />
                            </small>
                          </span>
                        </a>
                      ))}
                    </div>
                  )}

                  {m.context && (
                    <small className="agent-msg-context-tag">
                      {m.context.title} · {Math.floor(m.context.timeMs / 1000)} {t("秒")}</small>
                  )}
                </article>
              ))}
            <div ref={bottom} />
          </div>

          {status && <small className="agent-status">{status}</small>}

          {/* 快捷推荐 Prompt 药丸 */}
          <div className="agent-quick-chips" aria-label={t("推荐提问")}>
            {displayedPrompts.map((item) => (
              <button
                type="button"
                key={item.label}
                className="agent-chip"
                disabled={busy || !owner || sessionLoaded !== sessionKey}
                onClick={() => void send(item.prompt, [])}
              >
                <Icon name={item.icon} /> {item.label}
              </button>
            ))}
          </div>

          {/* 输入框区 */}
          <form
            className="agent-compose"
            onPaste={handlePaste}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const files = Array.from(e.dataTransfer.files || []);
              if (files.length) void processFiles(files);
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {(currentNote || page) && (
              <div className="agent-compose-context">
                <button
                  type="button"
                  className={`agent-context-pill ${currentNote ? 'is-note' : 'is-video'}`}
                  title={currentNote?.reference.text || page?.title}
                  onClick={() =>
                    currentNote
                      ? setSideView('notes')
                      : void quoteCurrent().catch(fail)
                  }
                >
                  <span className="agent-context-tag">
                    {currentNote ? <><Icon name="pin" /> {t("引用笔记")}</> : learningScene ? <><Icon name="book" /> {t("当前章节")}</> : <><Icon name="video" /> {t("当前视频")}</>}
                  </span>
                  <span className="agent-context-text">
                    {currentNote ? currentNote.reference.highlight : page?.title}
                  </span>
                </button>
                {currentNote && (
                  <button
                    type="button"
                    className="agent-context-clear"
                    aria-label={t("移除提问引用")}
                    title={t("移除引用")}
                    onClick={() => setNoteId('')}
                  >
                    <Icon name="close" />
                  </button>
                )}
              </div>
            )}

            {attachments.length > 0 && (
              <div className="agent-compose-attachments">
                {attachments.map((att) => (
                  <div key={att.id} className="agent-attachment-chip">
                    {att.type === 'image' && att.dataUrl ? (
                      <img src={att.dataUrl} alt={att.name} className="agent-attachment-thumb" />
                    ) : (
                      <span className="agent-attachment-chip-icon">
                        {att.type === 'markdown' ? <Icon name="notebook" /> : <Icon name="file" />}
                      </span>
                    )}
                    <span className="agent-attachment-chip-name" title={att.name}>
                      {att.name}
                    </span>
                    <button
                      type="button"
                      className="agent-attachment-chip-remove"
                      aria-label={t("移除附件")}
                      title={t("移除附件")}
                      onClick={() => removeAttachment(att.id)}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              ref={chatInputRef}
              aria-label={t("给学习 Agent 发消息")}
              placeholder={learningScene?.placeholder || t("输入消息（Enter 发送，Shift+Enter 换行）…")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />

            <div className="agent-compose-footer">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,text/plain,text/markdown"
                style={{ display: 'none' }}
                onChange={handleFileSelect}
              />
              <button
                type="button"
                className="agent-compose-btn agent-attachment-add-btn"
                title={t("上传图片、txt 或 markdown 文件")}
                aria-label={t("上传图片、txt 或 markdown 文件")}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="plus" size={16} />
              </button>

              {busy ? (
                <button
                  className="agent-send stop"
                  type="button"
                  aria-label={t("停止回答")}
                  onClick={() => controller.current?.abort()}
                >
                  <Icon name="stop" size={16} />
                </button>
              ) : (
                <button
                  className="agent-send"
                  type="submit"
                  aria-label={t("发送")}
                  disabled={!owner || (!text.trim() && !attachments.length)}
                >
                  <Icon name="arrow-up" size={16} />
                </button>
              )}
            </div>
          </form>
        </div>

        {/* 右侧：生词 / 笔记辅助抽屉面板 */}
        {(
          <aside style={sideView === 'none' ? { display: 'none' } : undefined} className="agent-tab-panel" id={`agent-panel-${sideView === 'none' ? 'notes' : sideView}`} role="tabpanel" aria-labelledby={`agent-tab-${sideView === 'none' ? 'notes' : sideView}`}>
            <div className="agent-side-panel-body">
              {library.error && <div className="agent-error" role="alert">{library.error}</div>}
              {(sideView === 'notes' ? selectedNoteVideo : selectedWordVideo) && <div className="agent-selected-video">
                <span>{(sideView === 'notes' ? selectedNoteVideo : selectedWordVideo)?.title}</span>
                {(sideView === 'notes' ? selectedNoteVideo : selectedWordVideo)?.videoKey !== 'general' && <button type="button" className="agent-icon-btn" aria-label={t("打开原视频")} title={t("打开原视频")}
                  onClick={() => void browser.runtime.sendMessage({ type: 'VIDEO_OPEN', videoKey: (sideView === 'notes' ? selectedNoteVideo : selectedWordVideo)!.videoKey, startMs: 0 }).catch(fail)}><Icon name="external" /></button>}
              </div>}
              {sideView === 'words' && (
                <NewWordsPanel
                  {...(wordsPage ? { page: wordsPage } : {})}
                  state={newWords}
                  owner={owner}
                  showExpressions={!hostedAi}
                  onReplay={(ms) => {
                    if (onReplay && page && selectedWordVideo?.videoKey === videoKeyOf(page)) onReplay(ms);
                    else if (selectedWordVideo) {
                      void browser.runtime
                        .sendMessage({
                          type: 'VIDEO_OPEN',
                          videoKey: selectedWordVideo.videoKey,
                          startMs: ms,
                        })
                        .catch(fail);
                    }
                  }}
                />
              )}

              {(
                <div className="agent-dictation-panel" style={sideView !== 'notes' ? { display: 'none' } : undefined}>
                  {owner && selectedNoteVideo && <DictationEditor key={`${owner}:${selectedNoteVideo.videoKey}`} owner={owner} videoKey={selectedNoteVideo.videoKey} title={selectedNoteVideo.title} focusOnLoad={sideView === 'notes'} />}
                  {!selectedNoteVideo && <div className="agent-empty">{t("打开一个视频开始记笔记")}</div>}
                  {!!visibleNotes.length && <details className="agent-saved-excerpts"><summary>{t("字幕摘录（")}{visibleNotes.length}）</summary>
                  <div className="agent-scroll">
                  {visibleNotes.map((note) => (
                    <NoteCard
                      key={note.id}
                      note={note}
                      onSource={openSource}
                      onAsk={(linkedConversationId) => {
                        setNoteId(note.id);
                        const link = note.links.at(-1);
                        setConversationId(linkedConversationId || link?.conversationId || '');
                        setSideView('none');
                      }}
                      onReplay={() => {
                        if (onReplay && page && videoKeyOf(page) === note.reference.videoKey) {
                          onReplay(note.reference.startMs);
                        } else {
                          void browser.runtime
                            .sendMessage({
                              type: 'VIDEO_OPEN',
                              videoKey: note.reference.videoKey,
                              startMs: note.reference.startMs,
                            })
                            .catch(fail);
                        }
                      }}
                    />
                  ))}
                  </div></details>}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {imagePreview && <AttachmentPreview name={imagePreview.name} url={imagePreview.url} onClose={() => setImagePreview(undefined)} />}
      {/* 设置中心弹窗 */}
      <AgentSettingsDialog
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onCredentialChange={setKey}
        owner={owner}
        {...(page ? { page } : {})}
        memories={memories}
        documents={documents}
      />
    </section>
    </AiSettingsOpenerProvider>
  );
}

const NOTE_BODY_MAX_HEIGHT = 360;

/**
 * A note body holds both the learner's own words and what the agent wrote, so it
 * renders as Markdown while idle and only becomes a source editor on demand. The
 * editor grows with its content up to a cap, which keeps a short note compact and
 * a long one readable without hunting for the resize handle.
 */
function NoteBody({ note, onSource }: { note: AgentNote; onSource: (href: string) => boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note.body);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Agent writes and cross-tab edits have to land while the field is idle.
  useEffect(() => {
    if (!editing) setValue(note.body);
  }, [note.body, editing]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editing || !editor) return;
    editor.style.height = 'auto';
    editor.style.height = `${Math.min(Math.max(editor.scrollHeight, 48), NOTE_BODY_MAX_HEIGHT)}px`;
  }, [editing, value]);

  if (editing) {
    return (
      <textarea
        ref={editorRef}
        className="agent-note-body-editor"
        aria-label={t("自己的笔记")}
        placeholder={t("写一点自己的理解或心得（自动保存）…")}
        value={value}
        autoFocus
        onChange={(event) => {
          setValue(event.target.value);
          void agentDb.notes.update(note.id, { body: event.target.value, updatedAt: Date.now() });
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur();
        }}
      />
    );
  }

  return (
    <div
      className="agent-note-body"
      role="button"
      tabIndex={0}
      title={t("点击编辑")}
      onClick={(event) => {
        // A link inside the rendered body is a real destination, not an edit trigger.
        if ((event.target as HTMLElement).closest('a')) return;
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        setEditing(true);
      }}
    >
      {value.trim() ? (
        <Markdown
          urlTransform={sourceUrl}
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={{
            a: ({ children, href }) => (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  if (href && onSource(href)) event.preventDefault();
                }}
              >
                {children}
              </a>
            ),
            img: () => null,
          }}
        >
          {value}
        </Markdown>
      ) : (
        <span className="agent-note-body-placeholder">{t("点一下写自己的理解或心得…")}</span>
      )}
    </div>
  );
}

function NoteCard({
  note,
  onAsk,
  onReplay,
  onSource,
}: {
  note: AgentNote;
  onAsk: (conversationId?: string) => void;
  onReplay: () => void;
  onSource: (href: string) => boolean;
}) {
  const [links, setLinks] = useState<
    Array<{
      question: AgentMessage | undefined;
      answer: AgentMessage | undefined;
      answerId: string;
    }>
  >([]);
  const detached = note.reference.videoKey === 'general';

  useEffect(() => {
    let disposed = false;
    void Promise.all(
      note.links.map(async (link) => ({
        question: await agentDb.messages.get(link.questionId),
        answer: await agentDb.messages.get(link.answerId),
        answerId: link.answerId,
      })),
    ).then((rows) => {
      if (!disposed) setLinks(rows);
    });
    return () => {
      disposed = true;
    };
  }, [note.links]);

  return (
    <article className="agent-note" id={`agent-note-${note.id}`}>
      <div className="agent-note-top">
        <small className="agent-note-source-title">{note.reference.title}</small>
        {/* A note with no corpus has nothing to seek to, so it never shows a replay affordance. */}
        {detached ? <span className="agent-note-detached">{t("未关联视频")}</span> : <button type="button" className="agent-time" onClick={onReplay} title={t("回放原句")}>
          {Math.floor(note.reference.startMs / 60000)}:
          {String(Math.floor(note.reference.startMs / 1000) % 60).padStart(2, '0')} <Icon name="external" />
        </button>}
      </div>

      <blockquote>{note.reference.text}</blockquote>
      {note.reference.highlight !== note.reference.text && (
        <mark>{note.reference.highlight}</mark>
      )}

      {links.map((link) => (
        <details key={link.answerId} className="agent-note-qa">
          <summary>{link.question?.content || t("查看问答")}</summary>
          <div className="agent-answer">
            <Markdown
              urlTransform={sourceUrl}
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                a: ({ children, href }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => {
                      if (href && onSource(href)) event.preventDefault();
                    }}
                  >
                    {children}
                  </a>
                ),
                img: () => null,
              }}
            >
              {link.answer?.content || t("回答不可用")}
            </Markdown>
          </div>
          <div className="agent-note-link-actions">
            <button type="button" onClick={() => onAsk(link.answer?.conversationId)}>
              {t("继续追问")}</button>
            <button
              type="button"
              onClick={() =>
                void agentDb.notes.update(note.id, {
                  links: note.links.filter((value) => value.answerId !== link.answerId),
                  updatedAt: Date.now(),
                })
              }
            >
              {t("移除问答引用")}</button>
          </div>
        </details>
      ))}

      <NoteBody note={note} onSource={onSource} />

      <footer>
        <button type="button" className="agent-btn primary" onClick={() => onAsk()}>
          <Icon name="message" /> {t("问这句")}</button>
        <button
          type="button"
          className="agent-btn agent-danger"
          onClick={() => void agentDb.notes.delete(note.id)}
        >
          {t("删除笔记")}</button>
      </footer>
    </article>
  );
}

/** In-document preview also works in WKWebView, where window.open has no DOM. */
function AttachmentPreview({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="agent-attachment-preview" aria-label={name} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><span>{name}</span><button type="button" aria-label={t("关闭图片预览")} onClick={onClose}>×</button></header>
    <img src={url} alt={name} />
  </dialog>;
}
