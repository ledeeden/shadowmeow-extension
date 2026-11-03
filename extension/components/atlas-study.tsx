import { t } from '../lib/i18n';
/** Word Atlas learning flow adapted for Shadow Language. See word-atlas-CODE-LICENSE.txt. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DictionaryResult, RuntimeMessage, VocabularyCard, VocabularyPlan, VocabularyRating } from '@shadow-language/contracts';
import { db } from '../lib/db';
import { atlasKey, atlasMedia, loadAtlasEntries, type AtlasEntry } from '../lib/word-atlas';
import { acceptAnswer, atlasEntryForCard, buildAtlasSession, clozeSentence, gradeAnswer, meaningOf, quizOptions, type AtlasSession, type QuizKind, type StudyGrade, type StudyStep } from '../lib/atlas-study-session';
import { buildVocabularyQueue, isVocabularyExempt } from '../lib/vocabulary-scheduler';
import { cancelEnglishSpeech, speakEnglish } from '../lib/speech';
import { Icon } from './icon';
import { WordAtlas } from './word-atlas';
import './atlas-study.css';
import './fonts.css';

type Sender = <T>(message: RuntimeMessage) => Promise<T>;
type Pending = StudyGrade & { value: string; saved: boolean };
const labels = { intro: t("初次见面"), meaning: t("它是什么意思？"), picture: t("看图，补全这句话"), listen: t("听，是哪个词？"), spell: t("拼出这个词"), fallback: t("回忆词义") };

function usePlayback() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);
  const stop = useCallback(() => {
    seq.current++; audio.current?.pause(); audio.current = null;
    clearTimeout(timer.current); cancelEnglishSpeech(); setPlaying(false);
  }, []);
  const play = useCallback((text: string, url: string | null, rate = 1) => {
    stop(); const id = seq.current; setPlaying(true); setError(false);
    let fellBack = false;
    const finish = () => { if (seq.current === id) { clearTimeout(timer.current); setPlaying(false); } };
    const fallback = () => {
      if (seq.current !== id || fellBack) return;
      fellBack = true; clearTimeout(timer.current); audio.current?.pause();
      if (!speakEnglish(text, { rate, onend: finish, onerror: () => { if (seq.current === id) setError(true); finish(); } })) { setError(true); finish(); }
    };
    if (!url) { fallback(); return; }
    const player = new Audio(url); audio.current = player; player.playbackRate = rate;
    player.onplaying = () => clearTimeout(timer.current); player.onended = finish; player.onerror = fallback;
    timer.current = setTimeout(fallback, 8000);
    void player.play().catch(fallback);
  }, [stop]);
  useEffect(() => stop, [stop]);
  return { play, stop, playing, error };
}

function Art({ entry, secret = false }: { entry: AtlasEntry; secret?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = atlasMedia(entry, 'img');
  return src && !failed ? <img className="atlas-art" src={src} alt={secret ? t("词义提示插画") : t("{0} 插画", entry.w)} onError={() => setFailed(true)} /> : <div className="atlas-art atlas-art-missing" aria-label={t("插画暂不可用")}><Icon name="book" /></div>;
}

export function AtlasStudy({ queue, allCards, sendRuntime, onReviewed, sessionScope, getQueue, onMastered }: { queue: VocabularyCard[]; allCards: VocabularyCard[]; sendRuntime: Sender; onReviewed: () => Promise<void>; sessionScope?: string; getQueue?: () => Promise<VocabularyCard[]>; onMastered?: ((card: VocabularyCard) => Promise<VocabularyCard[]>) | undefined }) {
  const storageKey = `shadow-atlas-study:v1:${db.name}${sessionScope ? `:${sessionScope}` : ''}`;
  const [catalog, setCatalog] = useState<AtlasEntry[] | null>(null);
  const [session, setSession] = useState<AtlasSession | null>(null);
  const [notice, setNotice] = useState('');
  const progressTop = useRef<HTMLElement | null>(null);
  useEffect(() => { if (session?.index) progressTop.current?.scrollIntoView({ block: 'start' }); }, [session?.id, session?.index]);
  useEffect(() => { setSession(null); }, [storageKey]);
  useEffect(() => {
    let live = true;
    void loadAtlasEntries().then(values => { if (live) setCatalog([...values.values()]); }).catch(() => { if (live) setCatalog([]); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!catalog || session) return;
    let restored: AtlasSession | null = null;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as AtlasSession | null;
      const ids = new Set(allCards.map(card => card.id));
      const exemptIds = new Set(allCards.filter(card => isVocabularyExempt(card) || card.status === 'known' && card.fsrs.reps === 0).map(card => card.id));
      if (saved?.version === 1 && new Date(saved.started).toDateString() === new Date().toDateString() && Array.isArray(saved.cards) && Array.isArray(saved.steps) && saved.graded && Number.isInteger(saved.index) && saved.index >= 0 && saved.index <= saved.steps.length && saved.cards.every(card => ids.has(card.id) && !exemptIds.has(card.id)) && saved.steps.every(step => saved.cards.some(card => card.id === step.cardId))) {
        restored = { ...saved, steps: saved.steps.map(step => {
          const card = saved.cards.find(card => card.id === step.cardId)!;
          return step.kind !== 'intro' && !atlasEntryForCard(card, catalog) ? { ...step, kind: 'fallback' as const, options: [] } : step;
        }) };
      }
    } catch { /* A missing or obsolete checkpoint starts a fresh local session. */ }
    setSession(restored || buildAtlasSession(queue, catalog));
  }, [catalog, session, queue, allCards, storageKey]);
  const update = useCallback((next: AtlasSession) => {
    setSession(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Learning remains available without browser storage. */ }
  }, [storageKey]);
  const restart = async () => {
    try {
      const nextQueue = getQueue ? await getQueue() : buildVocabularyQueue(await sendRuntime<VocabularyPlan>({ type: 'VOCABULARY_PLAN_GET' }));
      update(buildAtlasSession(nextQueue, catalog || []));
      await onReviewed(); setNotice('');
    } catch { setNotice(t("计划读取失败，请重试。")); }
  };
  if (!session || !catalog) return <div className="atlas-study atlas-loading" role="status">{t("正在准备今天的词卡…")}</div>;
  const done = session.index >= session.steps.length;
  if (done) {
    const grades = Object.values(session.graded);
    const correct = grades.filter(grade => grade.correct).length;
    const wrong = session.cards.filter(card => session.graded[card.id]?.rating === 1);
    return <section className="atlas-study atlas-summary" aria-label={t("本轮学习结果")}>
      <Icon name="award" /><p>{t("这一程结束了")}</p><h3>{grades.length ? t("学过的词，又熟悉了一点。") : t("今天的词已经复习好了。")}</h3>
      {grades.length > 0 && <><div className="atlas-summary-stats"><strong>{Math.round(correct / grades.length * 100)}%<small>{t("首次正确")}</small></strong><strong>{grades.length}<small>{t("完成词数")}</small></strong><strong>{Math.max(1, Math.round((Date.now() - session.started) / 60000))}<small>{t("分钟")}</small></strong></div>
      <div className="atlas-summary-words">{session.cards.filter(card => session.graded[card.id]).map(card => <span key={card.id} className={session.graded[card.id]?.correct ? '' : 'is-wrong'}>{card.word}</span>)}</div></>}
      <p>{session.practice ? t("错词巩固已完成，本轮练习不重复更新复习记录。") : t("已按首次作答安排下次复习，错词重练不重复计分。")}</p>
      <div className="atlas-actions">{wrong.length > 0 && <button onClick={() => update(buildAtlasSession(wrong, catalog, Date.now(), true))}><Icon name="repeat" /> {t("再练")}{wrong.length} {t("个错词")}</button>}<button className="atlas-primary" onClick={() => void restart()}>{t("查看今日计划")}</button></div>
      {notice && <p role="alert">{notice}</p>}
    </section>;
  }
  return <section className="atlas-study" aria-label={t("词光式背词学习")}>
    <header ref={progressTop} className="atlas-session-top"><div className="atlas-progress" role="progressbar" aria-label={t("本轮进度")} aria-valuemin={0} aria-valuemax={session.steps.length} aria-valuenow={session.index}><span style={{ width: `${session.index / session.steps.length * 100}%` }} /></div><span>{session.index + 1}<small> / {session.steps.length} {t("步")}</small></span></header>
    <AtlasStep key={`${session.id}:${session.index}:${session.steps[session.index]!.cardId}`} session={session} catalog={catalog} sendRuntime={sendRuntime} update={update} onReviewed={onReviewed} onMastered={onMastered} />
  </section>;
}

function AtlasStep({ session, catalog, sendRuntime, update, onReviewed, onMastered }: { session: AtlasSession; catalog: AtlasEntry[]; sendRuntime: Sender; update: (session: AtlasSession) => void; onReviewed: () => Promise<void>; onMastered?: ((card: VocabularyCard) => Promise<VocabularyCard[]>) | undefined }) {
  const original = session.steps[session.index]!;
  const [step, setStep] = useState<StudyStep>(original);
  const card = session.cards.find(value => value.id === step.cardId)!;
  const entry = atlasEntryForCard(card, catalog);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [value, setValue] = useState('');
  const [hints, setHints] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [meaning, setMeaning] = useState(card.translation);
  const [autoplay, setAutoplay] = useState(() => { try { return localStorage.getItem('shadow-atlas-autoplay') !== 'off'; } catch { return true; } });
  const start = useRef(performance.now());
  const locked = useRef(false);
  const nextButton = useRef<HTMLButtonElement | null>(null);
  const feedback = useRef<HTMLDivElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  useEffect(() => { stage.current?.focus({ preventScroll: true }); }, []);
  const audio = usePlayback();
  const { play, stop } = audio;
  useEffect(() => {
    if (entry && (step.kind === 'listen' || step.kind === 'intro' && autoplay)) play(entry.w, atlasMedia(entry, 'uk'));
    return stop;
  }, [entry, step.kind, play, stop, autoplay]);
  useEffect(() => {
    if (entry || meaning) return;
    let live = true;
    void sendRuntime<DictionaryResult>({ type: 'DICTIONARY_LOOKUP', text: card.word, detail: 'full' }).then(result => { if (live) setMeaning(result.shortZh || result.translation || result.senses[0]?.definition || t("暂无释义")); }).catch(() => { if (live) setMeaning(t("释义暂不可用，请返回词库稍后重试。")); });
    return () => { live = false; };
  }, [entry, meaning, card.word, sendRuntime]);
  const next = useCallback(() => {
    if (saving || pending && !pending.saved) return;
    stop(); update({ ...session, index: session.index + 1 });
  }, [saving, pending, stop, update, session]);
  useEffect(() => { if (pending) { feedback.current?.scrollIntoView({ block: 'nearest' }); nextButton.current?.focus({ preventScroll: true }); } }, [pending?.saved]);

  const submit = async (answerValue: string, correct: boolean, explicitRating?: VocabularyRating) => {
    if (locked.current) return;
    locked.current = true; stop();
    const rating = explicitRating || gradeAnswer(step.kind as QuizKind, correct, performance.now() - start.current, hints > 0);
    const attempt: Pending = { value: answerValue, correct, rating, saved: false };
    setPending(attempt); setSaving(true); setError('');
    try {
      if (!step.retry && !session.practice && !session.graded[card.id]) {
        const result = await sendRuntime<VocabularyCard | null>({ type: 'VOCABULARY_REVIEW', word: card.lemma || card.word, rating });
        if (!result) throw new Error(t("词条已不存在"));
      }
      const withKind = { ...session, steps: session.steps.map((item, i) => i === session.index ? step : item) };
      update(acceptAnswer(withKind, { rating, correct }, catalog));
      setPending({ ...attempt, saved: true });
      void onReviewed().catch(() => undefined);
      if (entry) play(entry.w, atlasMedia(entry, 'uk'));
    } catch {
      setError(t("复习记录未保存，请重试后继续。"));
      locked.current = false;
    } finally { setSaving(false); }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || saving) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (target?.closest('button,a') && (event.key === 'Enter' || event.key === ' ')) return;
      if (step.kind === 'intro' || pending?.saved) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); next(); }
      } else if (!pending && step.options.length && /^[1-4]$/.test(event.key)) {
        const id = step.options[Number(event.key) - 1];
        if (id) { event.preventDefault(); void submit(id, id === entry?.id); }
      }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });
  const master = async () => {
    if (!onMastered || locked.current || saving) return;
    locked.current = true; setSaving(true); setError(''); stop();
    try {
      const candidates = await onMastered(card);
      const remainingCards = session.cards.filter(item => item.id !== card.id);
      const ids = new Set(session.cards.map(item => item.id));
      const replacement = candidates.find(item => !ids.has(item.id));
      const keptSteps = session.steps.filter(item => item.cardId !== card.id);
      const index = session.steps.slice(0, session.index).filter(item => item.cardId !== card.id).length;
      const added = replacement ? buildAtlasSession([replacement], catalog).steps : [];
      const graded = { ...session.graded }; delete graded[card.id];
      update({ ...session, cards: replacement ? [...remainingCards, replacement] : remainingCards, steps: [...keptSteps, ...added], index, graded });
    } catch { setError(t("标记未完成，请重试。")); locked.current = false; }
    finally { setSaving(false); }
  };
  const speak = (rate = 1) => { if (entry) play(entry.w, atlasMedia(entry, 'uk'), rate); else play(card.word, null, rate); };
  const toggleAutoplay = () => { const enabled = !autoplay; setAutoplay(enabled); try { localStorage.setItem('shadow-atlas-autoplay', enabled ? 'on' : 'off'); } catch { /* optional preference */ } };
  const label = session.practice ? t("错词巩固 · ") : step.retry ? t("再见一面 · ") : '';
  return <div ref={stage} tabIndex={-1} aria-label={labels[step.kind]} className={`atlas-runner atlas-kind-${step.kind}`}>
    <div className="atlas-stage-label"><span>{label}{labels[step.kind]}</span><div className="atlas-stage-controls">{step.kind === 'intro' && <button type="button" onClick={toggleAutoplay} aria-pressed={autoplay}><Icon name={autoplay ? 'volume' : 'volume-off'} /> {t("自动发音")}{autoplay ? t("开") : t("关")}</button>}{onMastered && step.kind !== 'intro' && !session.practice && !pending && <button type="button" disabled={saving} onClick={() => void master()}>{saving ? t("保存中…") : t("已掌握，不再出现")}</button>}</div></div>
    {error && !pending && <p role="alert">{error}</p>}
    {step.kind === 'intro' ? <>
      {entry ? <WordAtlas word={entry.w} lesson onBeforePlay={stop} /> : <div className="atlas-fallback"><h3>{card.word}</h3><button onClick={() => speak()}><Icon name="volume" /> {card.phonetic || t("听发音")}</button><p>{meaning || t("正在读取释义…")}</p>{card.contextText && <p>{card.contextText}</p>}</div>}
      <footer className="atlas-actions atlas-intro-next"><small>{t("先认识，再回忆")}</small>{onMastered && <button disabled={saving} onClick={() => void master()}>{saving ? t("保存中…") : t("已掌握，不再出现")}</button>}<button className="atlas-primary" disabled={saving} onClick={next}>{t("认识了")}<Icon name="arrow-right" /></button></footer>
    </> : <>
      <div className="atlas-prompt">
        {(step.kind === 'meaning' || step.kind === 'fallback') && <><h3 className="atlas-headword" lang="en">{card.word}</h3><button className="atlas-pronounce" onClick={() => speak()} aria-label={t("播放单词发音")}><Icon name="volume" /> {entry?.uk || card.phonetic || t("听发音")}</button></>}
        {step.kind === 'picture' && entry && <><Art entry={entry} secret /><p className="atlas-cloze" lang="en">{pending ? entry.ex[0]?.en : clozeSentence(entry.ex[0]?.en || '', entry.w)}</p>{pending && <p className="atlas-muted">{entry.ex[0]?.zh}</p>}</>}
        {step.kind === 'listen' && <><button className="atlas-listen-orb" onClick={() => speak()} aria-label={t("再听一遍")}><Icon name="volume" /></button><button onClick={() => speak(.7)}>{t("慢速再听")}</button>{audio.error && <p role="alert">{t("发音暂不可用。")}<button onClick={() => { stop(); setStep({ ...step, kind: 'meaning', options: quizOptions(entry!, catalog, 'meaning', Date.now()) }); start.current = performance.now(); }}>{t("改做选义题")}</button></p>}</>}
        {step.kind === 'spell' && entry && <div className="atlas-spell-prompt"><Art entry={entry} secret /><div><p>{entry.senses[0]?.pos} {entry.senses[0]?.zh}</p><p className="atlas-cloze">{clozeSentence(entry.ex[0]?.en || '', entry.w)}</p><button onClick={() => speak()}><Icon name="volume" /> {t("听发音")}</button></div></div>}
      </div>
      {step.kind === 'spell' && entry ? <form className="atlas-spell-form" onSubmit={event => { event.preventDefault(); if (!pending && value.trim()) void submit(value, atlasKey(value) === atlasKey(entry.w)); }}>
        <input aria-label={t("拼写答案")} autoFocus autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} value={value} readOnly={Boolean(pending)} onChange={event => setValue(event.target.value)} placeholder={t("输入这个词")} />
        {!pending && <div className="atlas-actions"><button type="button" disabled={hints >= entry.w.length - 1} onClick={() => { const count = hints + 1; setHints(count); setValue(entry.w.slice(0, count)); }}><Icon name="lightbulb" /> {t("提示字母")}</button><button className="atlas-primary" type="submit" disabled={!value.trim()}>{t("确认")}</button></div>}
      </form> : step.kind === 'fallback' ? <div className="atlas-fallback">
        {!revealed ? <button className="atlas-primary" onClick={() => setRevealed(true)}>{t("查看释义")}</button> : <><p>{meaning}</p>{card.contextText && <p>{card.contextText}</p>}{!pending && <div className="atlas-fallback-ratings">{([t("没想起来"), t("困难"), t("想起来了"), t("很轻松")] as const).map((text, i) => <button key={text} onClick={() => void submit(text, i > 0, (i + 1) as VocabularyRating)}>{text}</button>)}</div>}</>}
      </div> : <div className="atlas-options" aria-label={t("答案选项")}>{step.options.map((id, i) => {
        const option = catalog.find(item => item.id === id)!;
        const correct = id === entry?.id;
        const state = pending ? correct ? 'is-answer' : pending.value === id ? 'is-chosen' : 'is-dim' : '';
        return <button key={id} className={`atlas-option ${state}`} disabled={Boolean(pending)} onClick={() => void submit(id, correct)}><kbd>{i + 1}</kbd><span>{step.kind === 'meaning' ? meaningOf(option, 1) : option.w}</span>{pending && (correct ? <Icon name="check" /> : pending.value === id ? <Icon name="close" /> : null)}</button>;
      })}</div>}
      {pending && <section className={`atlas-feedback ${pending.correct ? 'is-right' : 'is-wrong'}`} role="status">
        <div ref={feedback} className="atlas-feedback-main">{entry && <Art entry={entry} />}<div><strong>{pending.correct ? t("答对了") : t("没关系，记住它")}</strong><h4>{entry?.w || card.word}</h4><p>{entry ? meaningOf(entry) : meaning}</p>{entry?.ex[0] && <p lang="en">{entry.ex[0].en}</p>}{step.kind === 'spell' && !pending.correct && <p>{t("你输入的是：")}{pending.value}</p>}</div><button ref={nextButton} className="atlas-primary" disabled={saving || !pending.saved} onClick={next}>{saving ? t("保存中…") : t("继续")} <Icon name="arrow-right" /></button></div>
        {entry && <details><summary>{t("查看完整词条与例句朗读")}</summary><WordAtlas word={entry.w} onBeforePlay={stop} /></details>}
        {error && <p role="alert">{error} <button onClick={() => void submit(pending.value, pending.correct, pending.rating)}>{t("重试保存")}</button></p>}
      </section>}
    </>}
  </div>;
}
