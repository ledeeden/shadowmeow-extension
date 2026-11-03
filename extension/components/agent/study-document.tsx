import { t } from '../../lib/i18n';
import { Icon } from '../icon';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { liveQuery } from 'dexie';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { agentDb, type KnowledgeDocument } from '../../lib/agent/store';
import { generateStudyDocument, studyOwner, type StudyCorpus } from '../../lib/agent/study-documents';
import { studyDocumentBlocks, studyDocumentFormatVersion, studyDocumentId, studyDocumentLabel, type StudyDocumentKind } from '../../lib/agent/study-document-format';
import { useAiSettingsOpener } from './ai-settings-context';
import './study-document.css';

export function StudyDocumentMarkdown({ text }: { text: string }) {
  const markdown = (value: string) => <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>, img: () => null,
  }}>{value}</Markdown>;
  return <div className="study-document-markdown">{studyDocumentBlocks(text).map((block, index) => block.answer
    ? <details key={index}><summary>{t("参考答案")}</summary>{markdown(block.text)}</details>
    : <div key={index}>{markdown(block.text)}</div>)}</div>;
}

export function StudyDocumentButtons({ corpus }: { corpus: StudyCorpus }) {
  const [kind, setKind] = useState<StudyDocumentKind | null>(null);
  const openDocument = async (value: StudyDocumentKind) => {
    if (import.meta.env.VITE_SHADOW_WEB) {
      try {
        const auth = await browser.runtime.sendMessage({ type: 'AUTH_STATUS' }) as { signedIn?: boolean; data?: { signedIn?: boolean } };
        if (!(auth.signedIn ?? auth.data?.signedIn)) {
          window.dispatchEvent(new Event('shadow-language:web-auth-required'));
          return;
        }
      } catch {
        window.dispatchEvent(new Event('shadow-language:web-auth-required'));
        return;
      }
    }
    setKind(value);
  };
  return <><span className="study-document-buttons">{(['preview', 'review'] as const).map(value =>
    <button type="button" key={value} onClick={() => void openDocument(value)}>{studyDocumentLabel[value]}</button>)}</span>
    {kind && createPortal(<StudyDocument key={`${corpus.videoKey}:${kind}`} corpus={corpus} kind={kind} onClose={() => setKind(null)} />, document.querySelector('.web-dashboard') || document.body)}</>;
}

function StudyDocument({ corpus, kind, onClose }: { corpus: StudyCorpus; kind: StudyDocumentKind; onClose: () => void }) {
  const openAiSettings = useAiSettingsOpener();
  const [owner, setOwner] = useState('');
  const [saved, setSaved] = useState<KnowledgeDocument>();
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState(t("正在读取文档…"));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const started = useRef(false);
  const needsRefresh = kind === 'preview' && !!saved && saved.documentFormatVersion !== studyDocumentFormatVersion.preview;

  const generate = async (identity: string) => {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setDraft('');
    const timeout = window.setTimeout(() => abort.abort(), 180000);
    try {
      await generateStudyDocument({ owner: identity, corpus, kind, signal: abort.signal,
        onText: value => { if (mounted.current) setDraft(value); }, onStatus: value => { if (mounted.current) setStatus(value); } });
      if (mounted.current) { setDraft(''); setStatus(''); }
    } catch (e) {
      if (mounted.current) { setError(abort.signal.aborted ? t("生成已停止。") : e instanceof Error ? e.message : t("生成失败，请重试。")); setStatus(''); }
    } finally {
      clearTimeout(timeout); controller.current = null;
      if (mounted.current) setBusy(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    const authChanged = (message: { type?: string }) => {
      if (message.type === 'AUTH_CHANGED') { controller.current?.abort(); onClose(); }
    };
    browser.runtime.onMessage.addListener(authChanged);
    void studyOwner().then(identity => { if (mounted.current) setOwner(identity); }).catch(e => {
      if (mounted.current) { setError(e instanceof Error ? e.message : t("读取账号失败")); setStatus(''); }
    });
    return () => { mounted.current = false; controller.current?.abort(); browser.runtime.onMessage.removeListener(authChanged); focus?.focus(); };
  }, []);

  useEffect(() => {
    if (!owner) return;
    const subscription = liveQuery(() => agentDb.documents.get(studyDocumentId(owner, corpus.videoKey, kind))).subscribe({
      next: value => {
        setSaved(value?.owner === owner ? value : undefined);
        if (!started.current) {
          started.current = true;
          if (value?.owner === owner) setStatus('');
          else void generate(owner);
        }
      }, error: e => { setStatus(''); setError(String(e)); },
    });
    return () => subscription.unsubscribe();
  }, [owner]);

  return <dialog ref={dialog} className="study-document-dialog" aria-label={`${corpus.title} · ${studyDocumentLabel[kind]}`} onCancel={onClose}>
    <header><div><small>{studyDocumentLabel[kind]}{t("文档")}</small><h2>{corpus.title}</h2></div><button type="button" aria-label={t("关闭文档")} onClick={onClose}><Icon name="close" /></button></header>
    <div className="study-document-body">
      {error && <p className="study-document-error" role="alert">{error}</p>}
      {needsRefresh && <p className="study-document-update-note" role="status">{t("这份预习是旧版内容；点击下方“更新速览”后，会按单词、短语动词、习惯用语、常用句式重新整理。")}</p>}
      {status && <p role="status">{status}</p>}
      {draft && <><StudyDocumentMarkdown text={draft} />{!busy && <small>{t("以上为未完成内容，尚未保存。")}</small>}</>}
      {!draft && saved && <StudyDocumentMarkdown text={saved.text} />}
      {!busy && draft && saved && <details><summary>{t("查看已保存的文档")}</summary><StudyDocumentMarkdown text={saved.text} /></details>}
    </div>
    <footer><small>{saved ? t("已保存在本机 · {0}", new Date(saved.updatedAt).toLocaleString()) : t("保存在对应语料下")} </small><div>
      {busy ? <button type="button" onClick={() => controller.current?.abort()}>{t("停止生成")}</button> : <button type="button" disabled={!owner} onClick={() => void generate(owner)}>{needsRefresh ? t("更新速览") : saved ? t("重新生成") : t("重试生成")}</button>}
      {error && <button type="button" onClick={() => openAiSettings?.()}>{t("AI 设置")}</button>}
      <button type="button" onClick={() => void browser.runtime.sendMessage({ type: 'VIDEO_OPEN', videoKey: corpus.videoKey, startMs: 0 }).catch(e => setError(String(e)))}>{t("打开语料")}</button>
    </div></footer>
  </dialog>;
}
