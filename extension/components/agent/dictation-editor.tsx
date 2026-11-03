import { t } from '../../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { agentDb } from '../../lib/agent/store';
import { capitalizeDictation } from '../../lib/agent/dictation-case';

const commands = [
  ['bold', 'B', t("粗体")], ['italic', 'I', t("斜体")], ['underline', 'U', t("下划线")],
  ['insertUnorderedList', '• ≡', t("项目列表")], ['insertOrderedList', '1. ≡', t("编号列表")],
  ['removeFormat', 'Tx', t("清除格式")], ['undo', '↶', t("撤销")], ['redo', '↷', t("重做")],
] as const;

export function DictationEditor({
  owner,
  videoKey,
  title,
  focusOnLoad = false,
}: {
  owner: string;
  videoKey: string;
  title: string;
  focusOnLoad?: boolean;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [names, setNames] = useState('');
  const [autoCase, setAutoCase] = useState(true);
  const [status, setStatus] = useState('');
  const [options, setOptions] = useState(false);
  const id = JSON.stringify([owner, videoKey]);
  useEffect(() => {
    let active = true;
    void agentDb.dictations.get(id).then(note => {
      if (!active) return;
      if (editor.current) editor.current.innerHTML = note?.html || '';
      history.current = [note?.html || ''];
      historyIndex.current = 0;
      setNames(note?.names || ''); setAutoCase(note?.autoCase ?? true); setLoaded(true);
    }).catch(() => { if (active) setStatus(t("读取失败，请重新打开笔记")); });
    return () => { active = false; };
  }, [id]);
  useEffect(() => {
    if (!loaded || !focusOnLoad) return;
    const frame = window.requestAnimationFrame(() => editor.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusOnLoad, loaded]);
  function save(nextNames = names, nextAuto = autoCase, remember = true) {
    if (!loaded || !editor.current) return;
    const record = { id, owner, title, html: editor.current.innerHTML, names: nextNames, autoCase: nextAuto, updatedAt: Date.now() };
    if (remember && history.current[historyIndex.current] !== record.html) {
      history.current = history.current.slice(0, historyIndex.current + 1);
      history.current.push(record.html);
      if (history.current.length > 200) history.current.shift();
      historyIndex.current = history.current.length - 1;
    }
    const version = ++revision.current;
    setStatus(t("保存中"));
    queue.current = queue.current.catch(() => {}).then(() => agentDb.dictations.put(record)).then(() => {
      if (version === revision.current) setStatus(t("已保存"));
    }).catch(() => { setStatus(t("保存失败，请重试")); });
  }
  function undoRedo(direction: number) {
    const index = historyIndex.current + direction;
    if (!editor.current || index < 0 || index >= history.current.length) return;
    historyIndex.current = index;
    editor.current.innerHTML = history.current[index]!;
    editor.current.focus();
    const range = document.createRange();
    range.selectNodeContents(editor.current); range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    save(names, autoCase, false);
  }
  function normalize() {
    const root = editor.current;
    if (!root || !autoCase || composing.current) return;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode, focus = selection?.focusNode;
    const a = selection?.anchorOffset || 0, f = selection?.focusOffset || 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    const nodes: Array<{ node: Text; start: number }> = [];
    let text = '';
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeType === Node.TEXT_NODE) { nodes.push({ node: node as Text, start: text.length }); text += node.textContent || ''; }
      else if (/^(DIV|P|LI|BR|BLOCKQUOTE)$/.test(node.nodeName)) text += '\n';
    }
    const corrected = capitalizeDictation(text, names);
    for (const { node, start } of nodes) {
      const value = corrected.slice(start, start + node.length);
      if (value !== node.data) node.replaceData(0, node.length, value);
    }
    if (anchor && focus && root.contains(anchor) && root.contains(focus)) selection?.setBaseAndExtent(anchor, a, focus, f);
  }
  return <div className="dictation-notebook">
    <div className="dictation-toolbar" role="toolbar" aria-label={t("笔记格式")}>
      {commands.map(([command, label, title]) => <button key={command} type="button" title={title} aria-label={title} disabled={!loaded}
        onMouseDown={e => e.preventDefault()} onClick={() => {
          if (command === 'undo' || command === 'redo') { undoRedo(command === 'undo' ? -1 : 1); return; }
          editor.current?.focus(); document.execCommand(command); save();
        }}>{label}</button>)}
      <button type="button" title={t("英文输入设置")} aria-expanded={options} onClick={() => setOptions(!options)}>Aa</button>
    </div>
    {options && <div className="dictation-options">
      <label><input type="checkbox" checked={autoCase} onChange={e => { setAutoCase(e.target.checked); save(names, e.target.checked); }} /> {t("自动大小写")}</label>
      <label>{t("专有名词")}<input aria-label={t("专有名词")} placeholder={t("例如 Ryan, New York")} value={names} onChange={e => { setNames(e.target.value); save(e.target.value); }} /></label>
    </div>}
    <div ref={editor} className="dictation-editor" contentEditable={loaded} suppressContentEditableWarning role="textbox" aria-label={t("听写笔记")} aria-multiline="true" lang="en" spellCheck autoCapitalize="sentences"
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || !(event.metaKey || event.ctrlKey)) return;
        const key = event.key.toLowerCase();
        if (key === 'z' || key === 'y') { event.preventDefault(); undoRedo(key === 'y' || event.shiftKey ? 1 : -1); }
      }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; normalize(); save(); }}
      onInput={event => { if (!(event.nativeEvent as InputEvent).inputType?.startsWith('history')) normalize(); save(); }}
      onPaste={event => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); normalize(); save(); }}
      onDrop={event => event.preventDefault()} />
    <div className="dictation-save-status" role="status">{status}{status.startsWith(t("保存失败")) && <button type="button" onClick={() => save()}>{t("重试")}</button>}</div>
  </div>;
}
