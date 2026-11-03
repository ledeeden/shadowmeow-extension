import { t } from '../lib/i18n';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { VocabularyCard } from '@shadow-language/contracts';
import { db } from '../lib/db';
import { isVocabularyExempt } from '../lib/vocabulary-scheduler';
import { findWordbookCard, indexVocabularyCards, type Wordbook } from '../lib/wordbook-plan';
import { screenedKnownWords, submitWordbookScreening, type ScreeningMode } from '../lib/wordbook-screening';
import { Icon } from './icon';
import './wordbook-screen.css';
import './fonts.css';

const PAGE_SIZE = 30;
type Draft = { page: number; query: string; mode: ScreeningMode; choices: Record<string, string[]> };
function readDraft(key: string): Draft | null {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) || 'null') as Draft | null;
    return draft && Number.isInteger(draft.page) && draft.page >= 0 && typeof draft.query === 'string' && ['known', 'unknown'].includes(draft.mode) && draft.choices && typeof draft.choices === 'object' ? draft : null;
  } catch { return null; }
}
export function WordbookScreen({ book, allCards, onSaved, onClose }: { book: Wordbook; allCards: VocabularyCard[]; onSaved: () => Promise<void>; onClose: () => void }) {
  const database = db;
  const draftKey = `shadow-wordbook-screen:v1:${database.name}:${book.id}:${book.version}`;
  const [draft, setDraft] = useState<Draft>(() => readDraft(draftKey) || { page: 0, query: '', mode: 'known', choices: {} });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const locked = useRef(false);
  const top = useRef<HTMLElement | null>(null);
  const index = useMemo(() => indexVocabularyCards(allCards), [allCards]);
  const filtered = useMemo(() => {
    const query = draft.query.trim().toLowerCase();
    return book.words.filter(word => !query || [word.word, ...word.aliases || []].some(value => value.toLowerCase().includes(query)));
  }, [book, draft.query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(draft.page, pages - 1);
  const words = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const choiceKey = `${draft.mode}:${draft.query}:${page}`;
  const selected = new Set(draft.choices[choiceKey] || (draft.mode === 'known' ? words.filter(member => {
    const card = findWordbookCard(member, index);
    return card && (isVocabularyExempt(card) || card.status === 'known' && card.fsrs.reps === 0);
  }).map(member => member.word) : []));
  const knownWords = screenedKnownWords(words, selected, draft.mode);
  useEffect(() => {
    if (readDraft(draftKey)) return;
    let live = true;
    void database.studyMeta.get('goal').then(goal => {
      const checkpoint = goal?.wordbookScreening?.[book.id];
      if (live && checkpoint?.version === book.version) setDraft(value => ({ ...value, page: Math.min(pages - 1, checkpoint.page) }));
    }).catch(() => {});
    return () => { live = false; };
  }, [draftKey]);
  useEffect(() => { try { sessionStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* Submission remains available without draft storage. */ } }, [draftKey, draft]);
  const select = (values: string[]) => setDraft(value => ({ ...value, choices: { ...value.choices, [choiceKey]: values } }));
  const toggle = (word: string) => setDraft(value => {
    // Several quick taps can share one render. Read the previous draft inside
    // the updater so the second tap never discards the first selection.
    const next = new Set(value.choices[choiceKey] || [...selected]);
    if (next.has(word)) next.delete(word); else next.add(word);
    return { ...value, choices: { ...value.choices, [choiceKey]: [...next] } };
  });
  const move = (next: number) => { setDraft(value => ({ ...value, page: Math.max(0, Math.min(pages - 1, next)) })); setNotice(''); setError(''); top.current?.scrollIntoView({ block: 'start' }); };
  const submit = async () => {
    if (locked.current || !words.length) return;
    locked.current = true; setSaving(true); setError(''); setNotice('');
    try {
      if (database !== db) throw new Error(t("账号已切换，请重新打开筛词页。"));
      const nextPage = Math.min(page + 1, pages - 1);
      const result = await submitWordbookScreening(book, words.map(word => word.word), knownWords, draft.query ? 0 : nextPage);
      setNotice(t("本页已保存：{0} 词免学，{1} 词继续学习。{2}", result.known, result.learning, page + 1 === pages ? t('已到本次词表的最后一页。') : ''));
      setDraft(value => {
        const choices = { ...value.choices }; delete choices[choiceKey];
        return { ...value, choices, page: nextPage };
      });
      try { await onSaved(); } catch { setNotice(t("本页已保存。学习计划暂未刷新，返回学习后可重新读取。")); }
      top.current?.scrollIntoView({ block: 'start' });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("本页未保存，请重试。")); }
    finally { locked.current = false; setSaving(false); }
  };
  return <section className="wordbook-screen" aria-label={t("{0}快速筛词", book.title)} ref={top}>
    <header className="wordbook-screen-header"><div><small>{book.title}</small><h3>{t("快速筛词")}</h3><p>{t("认识的词直接免学，不认识的词继续学习。历史复习记录和收藏原句会保留。")}</p></div><button disabled={saving} onClick={onClose}><Icon name="arrow-left" />{t("返回学习")}</button></header>
    <div className="wordbook-screen-modes" role="group" aria-label={t("筛词选择方式")}><button aria-pressed={draft.mode === 'known'} disabled={saving} onClick={() => setDraft(value => ({ ...value, mode: 'known' }))}>{t("选认识的词")}</button><button aria-pressed={draft.mode === 'unknown'} disabled={saving} onClick={() => setDraft(value => ({ ...value, mode: 'unknown' }))}>{t("选不认识的词")}</button></div>
    <p className="wordbook-screen-instruction">{draft.mode === 'known' ? t("勾选你认识的词；提交后，未勾选的词继续学习。") : t("只勾选你不认识的词；提交后，其余词全部标记为认识。")}</p>
    <div className="wordbook-screen-tools"><input type="search" aria-label={t("搜索筛词词表")} placeholder={t("搜索本书单词")} disabled={saving} value={draft.query} onChange={event => setDraft(value => ({ ...value, query: event.target.value, page: 0 }))} /><div><button disabled={saving || !words.length} onClick={() => select(words.map(word => word.word))}>{t("全选本页")}</button><button disabled={saving || !words.length} onClick={() => select([])}>{t("清空选择")}</button><button disabled={saving || !words.length} onClick={() => select(words.filter(word => !selected.has(word.word)).map(word => word.word))}>{t("反选")}</button></div></div>
    <div className="wordbook-screen-pagination"><span>{t("第")}{page + 1} / {pages} {t("页 · 共")}{filtered.length.toLocaleString()} {t("词 · 每页")}{PAGE_SIZE} {t("词")}</span><div><button disabled={saving || page === 0} onClick={() => move(page - 1)}>{t("上一页")}</button><button disabled={saving || page + 1 >= pages} onClick={() => move(page + 1)}>{t("下一页")}</button></div></div>
    <div className="wordbook-screen-grid" role="group" aria-label={t("本页单词")}>{words.map(member => {
      const card = findWordbookCard(member, index);
      const exempt = card && (isVocabularyExempt(card) || card.status === 'known' && card.fsrs.reps === 0);
      return <button key={member.word} disabled={saving} aria-pressed={selected.has(member.word)} className={selected.has(member.word) ? 'is-selected' : ''} onClick={() => toggle(member.word)}><span className="wordbook-screen-checkbox" aria-hidden="true">{selected.has(member.word) && <Icon name="check" />}</span><strong lang="en">{member.word}</strong><small>{exempt ? t("已免学") : card?.fsrs.reps ? t("已学") : t("待学")}</small></button>;
    })}</div>
    {!words.length && <p className="wordbook-screen-empty">{t("没有匹配的单词。")}</p>}
    <footer className="wordbook-screen-submit"><div><strong>{t("本页提交后：")}{knownWords.length} {t("词免学")}</strong><span>{words.length - knownWords.length} {t("词继续学习 · 已选")}{selected.size} {t("词")}</span></div><button className="wordbook-screen-primary primary" disabled={saving || !words.length} onClick={() => void submit()}>{saving ? t("正在保存本页…") : page + 1 < pages ? t("提交本页并到下一页") : t("提交本页")}<Icon name="check" /></button></footer>
    {error && <p className="wordbooks-error" role="alert">{error}</p>}
    {notice && <p className="wordbook-screen-notice" role="status">{notice}</p>}
    <details className="wordbook-screen-source"><summary>{t("词本来源")}</summary><p>{book.source} · {book.version} <a href={book.sourceUrl} target="_blank" rel="noreferrer">{t("查看来源 ↗")}</a></p><p>{t("留学词汇收录全部带图解与例句录音的开放词目，不是官方考试词表。CEFR-J 词表来自投野研究室·东京外国语大学。")}{t("词目按拼写和明确变体整理，显示数量以本词本实际收录为准。图文与录音内容来自 Word Atlas contributors（CC BY 4.0）。")}</p></details>
  </section>;
}
