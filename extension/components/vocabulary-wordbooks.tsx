import { t } from '../lib/i18n';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeMessage, VocabularyCard, VocabularyPlan } from '@shadow-language/contracts';
import { db } from '../lib/db';
import { getAllVocabularyCards } from '../lib/vocabulary';
import { buildVocabularyQueue } from '../lib/vocabulary-scheduler';
import { ensureWordbookReviewCard, getWordbookPreferences, getWordbookStudyPlan, loadWordbook, loadWordbookCatalog, setWordbookPreferences } from '../lib/wordbooks';
import { indexVocabularyCards, isPersonalVocabularyCard, wordbookProgress, type StudyBookId, type Wordbook, type WordbookPreferences } from '../lib/wordbook-plan';
import { AtlasStudy } from './atlas-study';
import { WordbookScreen } from './wordbook-screen';
import { markWordbookCardMastered } from '../lib/wordbook-screening';
import { Icon } from './icon';
import { wordbookCoverFilename } from '../lib/wordbook-covers';
import { applyWordbookAssessment, assessmentCandidates, getWordbookAssessment, recommendedWordbook, undoWordbookAssessment, type AssessmentBatch, type WordbookAssessment } from '../lib/wordbook-assessment';
import './vocabulary-wordbooks.css';
import './fonts.css';

type Sender = <T>(message: RuntimeMessage) => Promise<T>;
const number = (value: number) => value.toLocaleString(t("zh-CN"));
const cover = (id: Wordbook['id']) => `${import.meta.env.BASE_URL}wordbooks/covers/${wordbookCoverFilename(id)}`;

export function VocabularyWordbooks({ allCards, sendRuntime, onReviewed, personalLibrary, vocabularySize }: { allCards: VocabularyCard[]; sendRuntime: Sender; onReviewed: () => Promise<void>; personalLibrary?: React.ReactNode; vocabularySize?: number | undefined }) {
  const owner = db.name;
  const [books, setBooks] = useState<Wordbook[]>([]);
  const [preferences, setPreferences] = useState<WordbookPreferences | null>(null);
  const [plan, setPlan] = useState<VocabularyPlan | null>(null);
  const [pageTab, setPageTab] = useState<'books' | 'personal'>('books');
  const [openedBook, setOpenedBook] = useState<StudyBookId | null>(null);
  const [personalPane, setPersonalPane] = useState<'list' | 'study'>('list');
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const [screening, setScreening] = useState(false);
  const [assessment, setAssessment] = useState<WordbookAssessment | null>(null);
  const [assessmentBatches, setAssessmentBatches] = useState<Record<string, AssessmentBatch>>({});
  const [assessmentBusy, setAssessmentBusy] = useState(false);
  const [assessmentNotice, setAssessmentNotice] = useState('');
  const [sessionRevision, setSessionRevision] = useState(0);
  const assessmentLock = useRef(false);
  const sequence = useRef(0);
  const book = books.find(value => value.id === preferences?.id) || null;
  const personal = useMemo(() => allCards.filter(isPersonalVocabularyCard), [allCards]);
  const initialize = useCallback(async () => {
    const database = db;
    setError('');
    try {
      const profile = await getWordbookAssessment();
      const size = vocabularySize ?? profile?.estimate;
      const saved = await getWordbookPreferences(size != null ? recommendedWordbook(size) : 'personal');
      const batches = (await database.studyMeta.get('goal'))?.wordbookAssessmentBatches || {};
      if (database !== db) return;
      setAssessment(profile); setAssessmentBatches(batches);
      setPreferences(saved);
      const catalog = await loadWordbookCatalog();
      const loaded = await Promise.all(catalog.map(info => loadWordbook(info.id)));
      if (database !== db) return;
      setBooks(loaded.filter((value): value is Wordbook => Boolean(value)));
    } catch (cause) { if (database === db) setError(cause instanceof Error ? cause.message : t("词本读取失败。")); }
  }, [owner, vocabularySize]);
  useEffect(() => { setPlan(null); setPreferences(null); setAssessment(null); setAssessmentBatches({}); setAssessmentNotice(''); void initialize(); }, [initialize]);
  const reloadPlan = useCallback(async () => {
    if (!preferences) return [];
    const database = db, request = ++sequence.current;
    const cards = await getAllVocabularyCards();
    const next = await getWordbookStudyPlan(book, preferences, cards);
    if (database !== db || request !== sequence.current) return [];
    setPlan(next); return buildVocabularyQueue(next);
  }, [owner, book, preferences]);
  useEffect(() => {
    // The shelf only needs book progress and assessment data. Building a study
    // queue here also loads the entire Atlas, even before a book is opened.
    if (pageTab === 'books' && !openedBook) return;
    let live = true;
    void reloadPlan().catch(cause => { if (live) setError(cause instanceof Error ? cause.message : t("学习计划读取失败。")); });
    return () => { live = false; };
  }, [reloadPlan, allCards, pageTab, openedBook]);
  const choose = async (id: StudyBookId, dailyNew = preferences?.dailyNew || 15) => {
    if (changing || assessmentLock.current) return;
    const database = db;
    setChanging(true); setError('');
    try {
      await loadWordbook(id);
      if (database !== db) return;
      const saved = await setWordbookPreferences({ id, dailyNew });
      if (database !== db) return;
      sequence.current++; setPlan(null); setPreferences(saved); setOpenedBook(id === 'personal' ? null : id); setPageTab(id === 'personal' ? 'personal' : 'books'); setScreening(false);
    } catch (cause) { if (database === db) setError(cause instanceof Error ? cause.message : t("词本切换失败，请重试。")); }
    finally { if (database === db) setChanging(false); }
  };
  const reviewSender = useCallback(async <T,>(message: RuntimeMessage): Promise<T> => {
    if (db.name !== owner) throw new Error(t("账号已切换，请重新打开背词页。"));
    if (message.type === 'VOCABULARY_REVIEW') await ensureWordbookReviewCard(message.word, book);
    return sendRuntime<T>(message);
  }, [owner, book, sendRuntime]);
  const reviewed = useCallback(async () => { await onReviewed(); await reloadPlan(); }, [onReviewed, reloadPlan]);
  const queue = useMemo(() => plan ? buildVocabularyQueue(plan) : [], [plan]);
  const cardsForSession = useMemo(() => {
    const map = new Map(allCards.map(card => [card.id, card]));
    for (const card of queue) if (!map.has(card.id)) map.set(card.id, card);
    return [...map.values()];
  }, [allCards, queue]);
  const progressByBook = useMemo(() => {
    const index = indexVocabularyCards(allCards);
    return new Map(books.map(item => [item.id, wordbookProgress(item, allCards, index)]));
  }, [books, allCards]);
  const progress = book ? progressByBook.get(book.id) || null : null;
  const recommendationSize = vocabularySize ?? assessment?.estimate;
  const recommendation = recommendationSize != null ? books.find(value => value.id === recommendedWordbook(recommendationSize)) : null;
  const assessmentBook = book || recommendation;
  const assessmentBatch = assessmentBook ? assessmentBatches[assessmentBook.id] : undefined;
  const activeBatch = assessmentBatch && !assessmentBatch.undoneAt ? assessmentBatch : null;
  const assessmentCount = useMemo(() => assessment && assessmentBook ? assessmentCandidates(assessmentBook, allCards, assessment).length : 0, [assessment, assessmentBook, allCards]);
  const changeAssessment = async (undo = false) => {
    if (!assessmentBook || changing || assessmentLock.current || (undo ? !activeBatch : !assessment)) return;
    if (db.name !== owner) { setError(t("账号已切换，请重新打开词本。")); return; }
    const database = db;
    assessmentLock.current = true; setAssessmentBusy(true); setError(''); setAssessmentNotice('');
    try {
      const message = undo && activeBatch
        ? t("已撤销本次测评免学，恢复 {0} 词。后续学习和手动筛词结果已保留。", number(await undoWordbookAssessment(assessmentBook, activeBatch.id)))
        : t("已按测评水平将 {0} 个基础词设为免学，可随时撤销。", number((await applyWordbookAssessment(assessmentBook, assessment!.key)).count));
      if (database !== db) return;
      setAssessmentBatches((await database.studyMeta.get('goal'))?.wordbookAssessmentBatches || {});
      setAssessmentNotice(message);
      try { await reviewed(); } catch { setAssessmentNotice(t("{0} 学习计划暂未刷新，可重新打开词本读取。", message)); }
      // Rebuild only after the refreshed queue and exemptions are available.
      setSessionRevision(value => value + 1);
    } catch (cause) { if (database === db) setError(cause instanceof Error ? cause.message : t("测评免学操作未保存，请重试。")); }
    finally { assessmentLock.current = false; if (database === db) setAssessmentBusy(false); }
  };
  const masterCard = async (card: VocabularyCard) => {
    if (!book || !preferences || db.name !== owner) throw new Error(t("词本已切换，请重新打开背词页。"));
    await markWordbookCardMastered(book, card);
    await onReviewed().catch(() => undefined);
    const cards = await getAllVocabularyCards();
    const next = await getWordbookStudyPlan(book, preferences, cards);
    setPlan(next);
    return next.newWords;
  };
  const id = preferences?.id || 'personal';
  const showShelf = pageTab === 'books' && !openedBook;
  return <div className="wordbooks" aria-label={t("词本与学习计划")}>
    {!openedBook && <nav className="wordbooks-tabs" role="tablist" aria-label={t("词汇学习")}>
      <button role="tab" aria-selected={pageTab === 'books'} aria-controls="wordbooks-panel" onClick={() => { setPageTab('books'); setOpenedBook(null); }}><Icon name="layers" />{t("词汇本")}</button>
      <button role="tab" aria-selected={pageTab === 'personal'} aria-controls="wordbooks-panel" disabled={changing || !preferences} onClick={() => void choose('personal')}><Icon name="book" />{t("我的生词本")}<span>{number(personal.length)}</span></button>
    </nav>}
    {error && <p className="wordbooks-error" role="alert">{error} <button onClick={() => void (books.length ? reloadPlan() : initialize()).catch(() => {})}>{t("重新读取")}</button></p>}
    <div id="wordbooks-panel" role="tabpanel" aria-label={pageTab === 'books' ? t("词汇本") : t("我的生词本")}>
    {showShelf && recommendation && assessmentBook && <section className="wordbook-assessment" aria-label={t("词本推荐与测评免学")}>
      <div><h3>{t("约")}{number(recommendationSize!)} {t("词 · 推荐")}{recommendation.title}</h3>{assessment && <p>{t("上次测评约")}{number(assessment.estimate)} {t("词")}{assessment.low && assessment.high ? t("（{0}–{1} 词）", number(assessment.low), number(assessment.high)) : ''}。{activeBatch ? t("{0}已应用本次测评免学。", assessmentBook.title) : t("尚未应用测评免学。点击按钮后按测评下限免学基础词，可随时撤销。")}</p>}</div>
      <div className="wordbook-assessment-actions">
        {assessmentBook.id !== recommendation.id && <button disabled={changing || assessmentBusy} onClick={() => void choose(recommendation.id)}>{t("使用推荐词本")}</button>}
        {activeBatch ? <><span role="status">{assessmentBook.title}{t("已免学")}{number(activeBatch.count)} {t("词")}</span><button disabled={assessmentBusy || changing} onClick={() => void changeAssessment(true)}>{assessmentBusy ? t("正在保存…") : t("撤销本次测评免学")}</button></> : assessment && <button className="primary" disabled={assessmentBusy || changing || !assessmentCount} onClick={() => void changeAssessment()}>{assessmentBusy ? t("正在保存…") : assessmentCount ? t("按上次测评免学 {0} 词", number(assessmentCount)) : t("暂无可按测评免学的词")}</button>}
      </div>
      {assessmentNotice && <p className="wordbook-assessment-notice" role="status">{assessmentNotice}</p>}
    </section>}
    {showShelf && !recommendation && !assessment && activeBatch && <section className="wordbook-assessment" aria-label={t("撤销测评免学")}><p>{assessmentBook?.title}{t("曾按测评免学")}{number(activeBatch.count)} {t("词。")}</p><button disabled={assessmentBusy || changing} onClick={() => void changeAssessment(true)}>{t("撤销本次测评免学")}</button>{assessmentNotice && <p role="status">{assessmentNotice}</p>}</section>}
    {openedBook && book && <div className="wordbook-study-toolbar" aria-label={t("背词操作")}>
      <button className="wordbook-change" disabled={changing} onClick={() => setOpenedBook(null)}><Icon name="arrow-left" /> {t("返回词汇本")}</button>
      <span>{book.title}</span>
      <label className="wordbook-daily">{t("每日新词")}<select aria-label={t("每日新词数量")} disabled={!preferences || changing} value={preferences?.dailyNew || 15} onChange={event => void choose(id, Number(event.target.value))}>{[5, 10, 15, 20, 25, 30, 50, 100].map(value => <option key={value} value={value}>{value} {t("词")}</option>)}</select></label>
      <button className="wordbook-change" disabled={changing} onClick={() => setScreening(true)}><Icon name="check" />{t("快速筛词")}</button>
    </div>}
    {!showShelf && !openedBook && <section className="wordbook-current" aria-label={t("当前词本")}>
      {book ? <img src={cover(book.id)} width="66" height="88" alt={t("{0}封面", book.title)} /> : <span className="wordbook-personal-symbol"><Icon name="book" /></span>}
      <div className="wordbook-current-copy"><small>{book ? t("当前词本") : t("我的收藏")}</small><h3>{book?.title || t("我的生词本")}</h3><p>{book ? t("{0} 词 · 已学 {1} 词{2}", number(book.count), number(progress?.learned || 0), progress?.skipped ? ` · 免学 ${number(progress.skipped)} 词` : '') : t("从视频、阅读中收藏的 {0} 个词，继续沿用原有进度", number(personal.length))}</p></div>
      <label className="wordbook-daily">{t("每日新词")}<select aria-label={t("每日新词数量")} disabled={!preferences || changing} value={preferences?.dailyNew || 15} onChange={event => void choose(id, Number(event.target.value))}>{[5, 10, 15, 20, 25, 30, 50, 100].map(value => <option key={value} value={value}>{value} {t("词")}</option>)}</select></label>
      {book && <button className="wordbook-change" disabled={changing} onClick={() => setScreening(true)}><Icon name="check" />{t("快速筛词")}</button>}
      <button className="wordbook-change" disabled={changing} onClick={() => book ? setOpenedBook(null) : setPersonalPane(value => value === 'list' ? 'study' : 'list')}><Icon name={book ? 'arrow-left' : personalPane === 'list' ? 'play' : 'book'} /> {book ? t("返回词汇本") : personalPane === 'list' ? t("开始背词") : t("收藏清单")}</button>
    </section>}
    {showShelf && <section id="wordbook-gallery" className="wordbook-gallery" aria-label={t("词汇本书架")}>
      <header><div><h3>{t("选择下一段词汇旅程")}</h3><p>{t("选择一本词本开始学习，已有进度会继续保留。")}</p></div><span>{t("{0} 套词本", books.length)}</span></header>
      {!books.length ? <p role="status">{t("正在打开词本书架…")}</p> : <div className="wordbook-grid">{books.map(item => {
        const stats = progressByBook.get(item.id)!, selected = item.id === id;
        return <button className={`wordbook-tile ${selected ? 'is-selected' : ''}`} key={item.id} disabled={changing} aria-label={t("打开{0}，{1}词", item.title, item.count)} onClick={() => void choose(item.id)}>
          <div className="wordbook-cover"><img src={cover(item.id)} alt={`${item.title} · Shadow Language`} width="216" height="288" loading="lazy" />{recommendation?.id === item.id && <span className="wordbook-recommended">{vocabularySize != null ? t("推荐") : t("测评推荐")}</span>}{selected && <span className="wordbook-selected"><Icon name="check" /> {t("当前词本")}</span>}</div>
          <div className="wordbook-tile-copy"><strong>{item.title}</strong><span>{number(item.count)} {t("词")}</span><small>{item.subtitle}</small><div className="wordbook-progress" role="progressbar" aria-label={t("{0}已学进度", item.title)} aria-valuemin={0} aria-valuemax={item.count} aria-valuenow={stats.learned}><i style={{ width: `${stats.learned / item.count * 100}%` }} /></div><small>{t("已学")}{number(stats.learned)} {t("词")}{stats.skipped > 0 ? t(" · 免学 {0}", number(stats.skipped)) : ''}</small></div>
        </button>;
      })}</div>}
    </section>}
    {!showShelf && book && screening ? <WordbookScreen key={`${owner}:${book.id}:${sessionRevision}`} book={book} allCards={allCards} onSaved={reviewed} onClose={() => setScreening(false)} /> : !showShelf && (preferences && plan ? <>
      {!book && <div className="wordbook-today" aria-label={t("今日词本计划")}><div><span><strong>{number(plan.dueCount)}</strong>{t("到期复习")}</span><span><strong>{number(plan.todayNewCount)}</strong>{t("今日新词")}</span><span><strong>{number(plan.newStartedToday)}</strong>{t("今日已新学")}</span>{progress && <span><strong>{number(progress.remaining)}</strong>{t("本书待学")}</span>}</div><p>{t("先复习，再学新词")}{book ? t("；先学有图解和录音的词，其余词汇排在后面。") : t("；收藏原句和学习进度持续保留。")}</p></div>}
      {!book && personalPane === 'list' && personalLibrary ? personalLibrary : !book && !personal.length && !plan.dueCount ? <div className="wordbook-empty"><Icon name="book" /><h3>{t("把遇见的生词，收进这里")}</h3><p>{t("在视频字幕和阅读中保存单词，就能保留原句并安排复习。")}</p></div> : <AtlasStudy key={`${owner}:${id}:${sessionRevision}`} sessionScope={`${id}:${book?.version || 'v1'}`} queue={queue} allCards={cardsForSession} sendRuntime={reviewSender} getQueue={reloadPlan} onReviewed={reviewed} onMastered={book ? masterCard : undefined} />}
    </> : !error && <p role="status" className="wordbook-loading">{t("正在读取词本与已有学习进度…")}</p>)}
    </div>
  </div>;
}
