import { t } from '../lib/i18n';
import React, { useMemo, useState } from 'react';
import { randomId, type ExpressionBundleInput, type ExpressionSource } from '@shadow-language/contracts';

export type ExpressionBundleEditorProps = {
  chunk: string;
  pattern?: string;
  sourceSentence: string;
  meaningZh?: string;
  intentZh?: string;
  slots?: string[];
  source: ExpressionSource;
  onSave: (bundle: ExpressionBundleInput) => Promise<{ duplicate?: boolean } | void>;
  onClose: () => void;
};

const EDITOR_CSS = `
.expression-editor-backdrop{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:18px;background:#020712b8;backdrop-filter:blur(12px);pointer-events:auto;color:#f7f4ed;font:14px Inter,system-ui,sans-serif}.expression-editor{width:min(680px,100%);max-height:min(760px,92vh);overflow:auto;border:1px solid #7783a266;border-radius:22px;background:linear-gradient(145deg,#182136f7,#0e1628f7);box-shadow:0 28px 90px #000a}.expression-editor header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:24px 26px 18px;border-bottom:1px solid #ffffff12}.expression-editor header h2{margin:0 0 6px;font-size:24px}.expression-editor header p{margin:0;color:#aeb8ce;line-height:1.5}.expression-editor header button{border:0;background:transparent;color:#c8d0df;font-size:24px}.expression-editor form{padding:22px 26px}.expression-editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.expression-editor label{display:flex;flex-direction:column;gap:7px;color:#bbc4d7;font-size:12px}.expression-editor label.wide{grid-column:1/-1}.expression-editor input,.expression-editor textarea{box-sizing:border-box;width:100%;border:1px solid #66718e66;border-radius:11px;background:#07101f99;color:#fff;padding:11px 12px;font:inherit;line-height:1.5;resize:vertical}.expression-editor input:focus,.expression-editor textarea:focus{outline:2px solid #e8b86d77;border-color:#e8b86d}.expression-editor-source{margin:16px 0 0;padding:12px 14px;border-radius:11px;background:#ffffff08;color:#aeb8ce;font-size:12px}.expression-editor-source b{display:block;color:#f0d398;margin-bottom:4px}.expression-editor footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:18px 26px 24px}.expression-editor footer button{border:1px solid #66718e66;border-radius:11px;background:#ffffff08;color:#eef2fb;padding:11px 18px;font-weight:700}.expression-editor footer button.primary{border-color:#f1cb87;background:#e8b86d;color:#131827}.expression-editor footer button:disabled{opacity:.5}.expression-editor-error{margin:14px 26px 0;color:#ffb8b8}.expression-editor-note{margin-right:auto;color:#88dcb7;font-size:12px}@media(max-width:620px){.expression-editor-grid{grid-template-columns:1fr}.expression-editor label.wide{grid-column:auto}.expression-editor form,.expression-editor header{padding-left:18px;padding-right:18px}.expression-editor footer{padding-left:18px;padding-right:18px;flex-wrap:wrap}.expression-editor-note{width:100%}}
`;

function splitLines(value: string): string[] {
  return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
}

export function ExpressionBundleEditor({
  chunk: initialChunk,
  pattern: initialPattern = '',
  sourceSentence: initialSentence,
  meaningZh: initialMeaning = '',
  intentZh: initialIntent = '',
  slots: initialSlots = [],
  source,
  onSave,
  onClose,
}: ExpressionBundleEditorProps) {
  const [chunk, setChunk] = useState(initialChunk);
  const [pattern, setPattern] = useState(initialPattern);
  const [sourceSentence, setSourceSentence] = useState(initialSentence);
  const [meaningZh, setMeaningZh] = useState(initialMeaning);
  const [intentZh, setIntentZh] = useState(initialIntent);
  const [slots, setSlots] = useState(initialSlots.join('\n'));
  const [variants, setVariants] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sourceDescription = useMemo(() => source.type === 'video'
    ? `${source.title} · ${Math.floor(source.startMs / 60_000)}:${String(Math.floor(source.startMs / 1_000) % 60).padStart(2, '0')}`
    : `${source.title} · ${source.location}`, [source]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    const now = Date.now();
    try {
      await onSave({
        id: `expression_${randomId()}`,
        chunk,
        pattern,
        sourceSentence,
        meaningZh,
        intentZh,
        slots: splitLines(slots),
        acceptedVariants: splitLines(variants),
        source,
        provenance: { kind: 'user-confirmed', extractor: 'manual', version: 'expression-bundle-v1' },
        createdAt: now,
        updatedAt: now,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  return <div className="expression-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <style>{EDITOR_CSS}</style>
    <section className="expression-editor" role="dialog" aria-modal="true" aria-label={t("确认表达包")}>
      <header><div><h2>{t("确认表达包")}</h2><p>{t("保留能直接调用的语块、可替换的句型，以及承载声音与语境的来源整句。")}</p></div><button type="button" aria-label={t("关闭")} disabled={busy} onClick={onClose}>×</button></header>
      {error && <p className="expression-editor-error" role="alert">{error}</p>}
      <form id="expression-bundle-form" onSubmit={submit}>
        <div className="expression-editor-grid">
          <label className="wide">{t("语块（可直接开口）")}<input value={chunk} onChange={(event) => setChunk(event.target.value)} placeholder={t("例如：I'm looking forward to it")} /></label>
          <label className="wide">{t("可替换句型")}<input value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder={t("例如：I'm looking forward to + 名词 / doing")} /></label>
          <label className="wide">{t("来源整句")}<textarea required value={sourceSentence} onChange={(event) => setSourceSentence(event.target.value)} rows={3} /></label>
          <label>{t("中文含义")}<input value={meaningZh} onChange={(event) => setMeaningZh(event.target.value)} placeholder={t("这句话是什么意思")} /></label>
          <label>{t("表达意图")}<input value={intentZh} onChange={(event) => setIntentZh(event.target.value)} placeholder={t("在什么意图下会用它")} /></label>
          <label>{t("可替换槽位")}<textarea value={slots} onChange={(event) => setSlots(event.target.value)} placeholder={t("每行一个，例如：something")} rows={2} /></label>
          <label>{t("可接受变体")}<textarea value={variants} onChange={(event) => setVariants(event.target.value)} placeholder={t("每行一个自然变体")} rows={2} /></label>
        </div>
        <p className="expression-editor-source"><b>{t("来源")}</b>{sourceDescription}</p>
      </form>
      <footer><span className="expression-editor-note">{t("只有确认后才进入正式复习")}</span><button type="button" disabled={busy} onClick={onClose}>{t("取消")}</button><button className="primary" type="submit" form="expression-bundle-form" disabled={busy || (!chunk.trim() && !pattern.trim()) || !sourceSentence.trim()}>{busy ? t("保存中…") : t("确认并加入复习")}</button></footer>
    </section>
  </div>;
}
