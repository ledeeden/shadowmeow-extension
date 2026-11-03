import { t } from '../../lib/i18n';
import { Icon } from '../../components/icon';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CorpusSubtitleDetail, CorpusSubtitleTitle, CorpusSubtitleTitleListResponse, DictionaryAudioResult, DictionaryResult, RuntimeMessage, VocabularyState } from '@shadow-language/contracts';
import jobsText from '../../reader-samples/jobs.txt?raw';
import { cefrForRank, lookupReaderWord } from '../../lib/reader-frequency';
import { lookupFrequencyRanks, type FrequencyRanks } from '../../lib/frequency-coverage';
import { cancelEnglishSpeech, speakEnglish } from '../../lib/speech';
import { vocabularyTermKeys } from '../../lib/vocabulary';
import { NGSL_VOCABULARY_TIERS, SUBTLEX_VOCABULARY_TIERS, vocabularyTierIndexForRank, type VocabularyTier } from '../../lib/vocabulary-profile';
import './reader-estimator.css';
import '../../components/fonts.css';

export type ReaderRuntimeSender = <T>(message: RuntimeMessage) => Promise<T>;

type ReaderEstimatorProps = {
  sendRuntime: ReaderRuntimeSender;
  onNotice?: (notice: string) => void;
  vocabularySize: number;
  onVocabularySizeChange: (vocabularySize: number) => void;
  web?: boolean;
};

type ReaderFrequencyTab = 'ngsl' | 'subtlex';

const READER_TABS: Array<{ id: ReaderFrequencyTab; label: string }> = [
  { id: 'ngsl', label: 'NGSL' },
  { id: 'subtlex', label: 'SUBTLEX-US' },
];

const READER_TAB_TIERS: Record<ReaderFrequencyTab, VocabularyTier[]> = {
  ngsl: NGSL_VOCABULARY_TIERS,
  subtlex: SUBTLEX_VOCABULARY_TIERS,
};

const EMPTY_FREQUENCY_RANKS: FrequencyRanks = { subtlex: null, ngslS: null, ngsl: null, ngslGr: null };

type ReaderToken = {
  raw: string;
  kind: 'word' | 'space' | 'punct';
  lemma: string;
  rank: number | null;
  frequencyRanks: FrequencyRanks;
  countable: boolean;
};

type ReaderParagraph = ReaderToken[];

type ReaderAnalysis = {
  paragraphs: ReaderParagraph[];
  wordRanks: Map<string, number>;
  wordFrequencyRanks: Map<string, FrequencyRanks>;
  wordFreqs: Map<string, number>;
  totalTokens: number;
  excludedTokens: number;
  unknownTokens: number;
};

type ActiveWord = {
  raw: string;
  lemma: string;
  rank: number | null;
  frequencyRanks: FrequencyRanks;
  occurrences: number;
  contextText: string;
  anchor: { left: number; right: number; top: number; bottom: number; width: number; height: number };
};

type SavedReaderWord = {
  key: string;
  word: string;
  lemma: string;
  title: string;
  contextText: string;
  meaningZh: string;
  phonetic: string;
  savedAt: string;
};

type ReaderBaseline = {
  title: string;
  source: ReaderFrequencyTab;
  tierLabel: string;
  rank: number;
  cefr: string;
  coveragePercent: number;
  savedAt: string;
};

function normalizeVocabularyKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

const READER_BASELINE_KEY = 'readerVocabBaseline';
const READER_SAVED_WORDS_KEY = 'readerSavedWords';
const CORPUS_DETAIL_CACHE_KEY = 'shadow-language:reader-corpus-details';
const CORPUS_TITLE_CACHE_KEY = 'shadow-language:reader-corpus-titles';
const CORPUS_TITLE_CACHE_TTL_MS = 10 * 60_000;

function readCachedCorpusTitles(): CorpusSubtitleTitle[] | null {
  try {
    const cached = JSON.parse(localStorage.getItem(CORPUS_TITLE_CACHE_KEY) || 'null') as { expiresAt?: number; items?: CorpusSubtitleTitle[] } | null;
    return cached && Number(cached.expiresAt) > Date.now() && Array.isArray(cached.items) ? cached.items : null;
  } catch {
    return null;
  }
}

function cacheCorpusTitles(items: CorpusSubtitleTitle[]) {
  try {
    localStorage.setItem(CORPUS_TITLE_CACHE_KEY, JSON.stringify({ expiresAt: Date.now() + CORPUS_TITLE_CACHE_TTL_MS, items }));
  } catch {
    // Cross-tab title caching is optional when storage is unavailable.
  }
}

function readCachedCorpusDetail(item: CorpusSubtitleTitle): CorpusSubtitleDetail | null {
  try {
    const values = JSON.parse(sessionStorage.getItem(CORPUS_DETAIL_CACHE_KEY) || '[]') as CorpusSubtitleDetail[];
    return values.find((value) => value.id === item.id && value.contentVersion === item.contentVersion) || null;
  } catch {
    return null;
  }
}

function cacheCorpusDetail(detail: CorpusSubtitleDetail) {
  if (detail.text.length > 1_500_000) return;
  try {
    const current = JSON.parse(sessionStorage.getItem(CORPUS_DETAIL_CACHE_KEY) || '[]') as CorpusSubtitleDetail[];
    const next = [detail, ...current.filter((value) => value.id !== detail.id || value.contentVersion !== detail.contentVersion)].slice(0, 3);
    while (JSON.stringify(next).length > 1_500_000 && next.length > 1) next.pop();
    sessionStorage.setItem(CORPUS_DETAIL_CACHE_KEY, JSON.stringify(next));
  } catch {
    // Session caching is an optimization; private mode/quota failures are safe.
  }
}

function corpusSubtitleErrorMessage(cause: unknown, target: 'titles' | 'detail'): string {
  const message = cause instanceof Error ? cause.message : String(cause || '');
  if (/invalid[_ ]enum|VALIDATION_FAILED|corpus\.listSubtitleTitles|corpus\.getSubtitleDetail/i.test(message)) {
    return t("语料字幕服务正在更新，请稍后再试。");
  }
  return target === 'titles' ? t("语料字幕标题读取失败，请稍后重试。") : t("字幕正文读取失败，请稍后重试。");
}

function getTierBounds(tiers: VocabularyTier[], index: number): { from: number; to: number } {
  if (index <= 0) return { from: 0, to: 0 };
  const previous = tiers[index - 1]?.rank ?? 0;
  const current = tiers[index]?.rank ?? Number.POSITIVE_INFINITY;
  return { from: previous + 1, to: index === tiers.length - 1 ? Number.POSITIVE_INFINITY : current };
}

function frequencyRankKeyForTier(tier: VocabularyTier): keyof FrequencyRanks | null {
  if (tier.source === 'ngslS') return 'ngslS';
  if (tier.source === 'ngsl') return 'ngsl';
  if (tier.source === 'ngslGr') return 'ngslGr';
  if (tier.source === 'subtlex') return 'subtlex';
  return null;
}

function rankAtReaderTier(ranks: FrequencyRanks, tier: VocabularyTier): number | null {
  const key = frequencyRankKeyForTier(tier);
  return key ? ranks[key] : null;
}

function isKnownAtReaderTier(ranks: FrequencyRanks, tiers: VocabularyTier[], index: number, tab: ReaderFrequencyTab): boolean {
  const tier = tiers[index];
  if (!tier) return false;
  if (tab === 'ngsl') return rankAtReaderTier(ranks, tier) !== null;
  const rank = ranks.subtlex;
  return rank !== null && rank <= tier.rank;
}

function isInReaderTier(ranks: FrequencyRanks, tiers: VocabularyTier[], index: number, tab: ReaderFrequencyTab): boolean {
  const tier = tiers[index];
  if (!tier || tier.source === 'baseline') return false;
  if (tab === 'ngsl') return rankAtReaderTier(ranks, tier) !== null;
  const rank = ranks.subtlex;
  const bounds = getTierBounds(tiers, index);
  return rank !== null && rank >= bounds.from && rank <= bounds.to;
}

function mergeFrequencyRanks(previous: FrequencyRanks | undefined, next: FrequencyRanks): FrequencyRanks {
  if (!previous) return next;
  return {
    subtlex: previous.subtlex === null ? next.subtlex : next.subtlex === null ? previous.subtlex : Math.min(previous.subtlex, next.subtlex),
    ngslS: previous.ngslS === null ? next.ngslS : next.ngslS === null ? previous.ngslS : Math.min(previous.ngslS, next.ngslS),
    ngsl: previous.ngsl === null ? next.ngsl : next.ngsl === null ? previous.ngsl : Math.min(previous.ngsl, next.ngsl),
    ngslGr: previous.ngslGr === null ? next.ngslGr : next.ngslGr === null ? previous.ngslGr : Math.min(previous.ngslGr, next.ngslGr),
  };
}

function tokenizeReaderText(text: string): ReaderParagraph[] {
  const normalizedText = text.replace(/[\u2018\u2019\u201B\u02BC\u0060\u00B4]/g, "'");
  const paragraphs: ReaderParagraph[] = [];
  for (const rawParagraph of normalizedText.split(/\n\s*\n/)) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) continue;
    const tokens: ReaderToken[] = [];
    const pattern = /[A-Za-zÀ-ÖØ-öø-ÿ]+(?:'[A-Za-zÀ-ÖØ-öø-ÿ]+)?|[^A-Za-zÀ-ÖØ-öø-ÿ\s]|\s+/g;
    let sentenceStart = true;
    for (const match of paragraph.matchAll(pattern)) {
      const raw = match[0];
      if (/^\s+$/.test(raw)) {
        tokens.push({ raw, kind: 'space', lemma: '', rank: null, frequencyRanks: EMPTY_FREQUENCY_RANKS, countable: false });
        continue;
      }
      if (/^[A-Za-zÀ-ÖØ-öø-ÿ]/.test(raw)) {
        const info = lookupReaderWord(raw, sentenceStart);
        tokens.push({ raw, kind: 'word', lemma: info.lemma, rank: info.rank, frequencyRanks: lookupFrequencyRanks(raw, sentenceStart), countable: info.countable });
        sentenceStart = false;
        continue;
      }
      tokens.push({ raw, kind: 'punct', lemma: '', rank: null, frequencyRanks: EMPTY_FREQUENCY_RANKS, countable: false });
      if (/[.!?]/.test(raw)) sentenceStart = true;
    }
    paragraphs.push(tokens);
  }
  return paragraphs;
}

function analyzeReaderText(text: string): ReaderAnalysis {
  const paragraphs = tokenizeReaderText(text);
  const wordRanks = new Map<string, number>();
  const wordFrequencyRanks = new Map<string, FrequencyRanks>();
  const wordFreqs = new Map<string, number>();
  let totalTokens = 0;
  let excludedTokens = 0;
  let unknownTokens = 0;
  for (const paragraph of paragraphs) {
    for (const token of paragraph) {
      if (token.kind !== 'word') continue;
      if (!token.countable) {
        excludedTokens += 1;
        continue;
      }
      totalTokens += 1;
      if (token.rank === null) unknownTokens += 1;
      const rank = token.rank ?? Number.POSITIVE_INFINITY;
      const previousRank = wordRanks.get(token.lemma);
      if (previousRank === undefined || rank < previousRank) wordRanks.set(token.lemma, rank);
      wordFrequencyRanks.set(token.lemma, mergeFrequencyRanks(wordFrequencyRanks.get(token.lemma), token.frequencyRanks));
      wordFreqs.set(token.lemma, (wordFreqs.get(token.lemma) || 0) + 1);
    }
  }
  return { paragraphs, wordRanks, wordFrequencyRanks, wordFreqs, totalTokens, excludedTokens, unknownTokens };
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function rankLabel(rank: number | null): string {
  return rank === null || !Number.isFinite(rank) ? t("超纲 / 未收录") : t("核心 #{0}", formatCount(rank));
}

function listRankLabel(rank: number | null): string {
  return rank === null || !Number.isFinite(rank) ? t("未收录") : `#${formatCount(rank)}`;
}

function dictionaryMeaning(result: DictionaryResult | null, fallback: string): string {
  if (result?.shortZh) return result.shortZh;
  if (result?.translation) return result.translation;
  const definition = result?.senses.find((sense) => sense.definition)?.definition;
  return definition || fallback;
}

function closeEnoughAnchor(anchor: ActiveWord['anchor']): { left: number; top: number } {
  const width = Math.min(300, window.innerWidth - 20);
  const popoverHeight = 315;
  let left = anchor.left + anchor.width / 2 - width / 2;
  let top = anchor.bottom + 8;
  if (left < 10) left = 10;
  if (left + width > window.innerWidth - 10) left = window.innerWidth - width - 10;
  if (top > window.innerHeight - popoverHeight) top = Math.max(10, anchor.top - popoverHeight);
  return { left, top };
}

function ReaderWordPopover({
  activeWord,
  known,
  activeTierLabel,
  activeTierRank,
  result,
  loading,
  saved,
  mastered,
  onSpeak,
  onToggleSave,
  onClose,
}: {
  activeWord: ActiveWord;
  known: boolean;
  activeTierLabel: string;
  activeTierRank: number | null;
  result: DictionaryResult | null;
  loading: boolean;
  saved: boolean;
  mastered: boolean;
  onSpeak: () => void;
  onToggleSave: () => void;
  onClose: () => void;
}) {
  const position = closeEnoughAnchor(activeWord.anchor);
  const fallback = activeWord.rank === null ? t("暂未找到离线词频记录，仍可用在线词典查询。") : rankLabel(activeWord.rank);
  return <div
    className="reader-word-popover"
    data-reader-popover="true"
    style={{ left: position.left, top: position.top }}
    role="dialog"
    aria-label={t("{0} 词条", activeWord.raw)}
    onClick={(event) => event.stopPropagation()}
  >
    <div className="reader-word-popover-header">
      <div><strong>{activeWord.raw}</strong><span>{result?.phonetic ? `[ /${result.phonetic}/ ]` : ''}</span></div>
      <div className="reader-word-popover-actions"><button type="button" onClick={onSpeak} title={t("朗读发音")}><Icon name="volume" /></button><button type="button" onClick={onClose} aria-label={t("关闭")}><Icon name="close" /></button></div>
    </div>
    <span className={`reader-word-status ${mastered ? 'mastered' : saved ? 'saved' : known ? 'known' : 'unknown'}`}>
      {mastered ? t("已掌握 · 不再高亮") : saved ? t("已保存 · 待学习") : known ? `${activeTierLabel} · ${listRankLabel(activeTierRank)}` : activeWord.rank !== null ? `${cefrForRank(activeWord.rank)} · ${rankLabel(activeWord.rank)}` : t("待确认词汇")}
    </span>
    <div className="reader-word-meaning">{loading ? t("正在查询释义…") : dictionaryMeaning(result, fallback)}</div>
    <div className="reader-word-meta">
      <span>{t("原形")}<b>{result?.lemma || activeWord.lemma}</b></span>
      <span>CEFR <b>{cefrForRank(activeWord.rank)}</b></span>
      <span>{t("本文")}<b>{activeWord.occurrences} {t("次")}</b></span>
      <span>{t("词频")}<b>{rankLabel(activeWord.rank)}</b></span>
    </div>
    <div className="reader-word-frequency-meta" aria-label={t("四套词表分级")}>
      <span><b>SUBTLEX-US</b>{listRankLabel(activeWord.frequencyRanks.subtlex)}</span>
      <span><b>NGSL-S</b>{listRankLabel(activeWord.frequencyRanks.ngslS)}</span>
      <span><b>NGSL</b>{listRankLabel(activeWord.frequencyRanks.ngsl)}</span>
      <span><b>NGSL-GR</b>{listRankLabel(activeWord.frequencyRanks.ngslGr)}</span>
    </div>
    {result?.senses[0]?.partOfSpeech && <small className="reader-word-pos">{result.senses[0].partOfSpeech}</small>}
    <button className={`reader-word-save ${saved ? 'is-saved' : ''}`} type="button" onClick={onToggleSave}>{saved ? <><Icon name="check" /> {t("已保存到本地词汇")}</> : t("保存到本地词汇")}</button>
  </div>;
}

export function ReaderEstimator({ sendRuntime, onNotice, vocabularySize, onVocabularySizeChange, web = false }: ReaderEstimatorProps) {
  const [sourceText, setSourceText] = useState(jobsText);
  const [articleTitle, setArticleTitle] = useState(t("乔布斯斯坦福演讲"));
  const [readerTab, setReaderTab] = useState<ReaderFrequencyTab>('subtlex');
  const [tierIndices, setTierIndices] = useState<Record<ReaderFrequencyTab, number>>(() => ({
    ngsl: 0,
    subtlex: vocabularyTierIndexForRank(vocabularySize),
  }));
  const [showCurrentHighlight, setShowCurrentHighlight] = useState(true);
  const [showNextHighlight, setShowNextHighlight] = useState(true);
  const [activeWord, setActiveWord] = useState<ActiveWord | null>(null);
  const [dictionary, setDictionary] = useState<DictionaryResult | null>(null);
  const [dictionaryLoading, setDictionaryLoading] = useState(false);
  const [savedWords, setSavedWords] = useState<SavedReaderWord[]>([]);
  const [savedVocabularyLemmas, setSavedVocabularyLemmas] = useState<Set<string>>(() => new Set());
  const [masteredLemmas, setMasteredLemmas] = useState<Set<string>>(() => new Set());
  const [baseline, setBaseline] = useState<ReaderBaseline | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState(jobsText);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [conceptOpen, setConceptOpen] = useState(false);
  const [corpusPickerOpen, setCorpusPickerOpen] = useState(false);
  const [corpusTitles, setCorpusTitles] = useState<CorpusSubtitleTitle[]>([]);
  const [corpusSearch, setCorpusSearch] = useState('');
  const [corpusLoading, setCorpusLoading] = useState(false);
  const [corpusLoadError, setCorpusLoadError] = useState('');
  const [loadingSubtitleId, setLoadingSubtitleId] = useState('');
  const [loadError, setLoadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textAreaRef = useRef<HTMLDivElement>(null);
  const activeTierRef = useRef<HTMLButtonElement>(null);

  const analysis = useMemo(() => analyzeReaderText(sourceText), [sourceText]);
  const activeTiers = READER_TAB_TIERS[readerTab];
  const tierIndex = tierIndices[readerTab];
  const selectedDesktopTierRef = useRef<HTMLButtonElement>(null);
  const currentTier = activeTiers[tierIndex] ?? activeTiers.at(-1)!;
  const nextTier = activeTiers[tierIndex + 1];
  const threshold = currentTier.rank;
  const isMastered = (lemma: string) => masteredLemmas.has(normalizeVocabularyKey(lemma));
  const isSaved = (word: string, lemma: string) => vocabularyTermKeys(word, lemma).some((key) => savedVocabularyLemmas.has(key));
  const countableTokens = useMemo(() => {
    return analysis.paragraphs.flatMap((p) => p.filter((t) => t.kind === 'word' && t.countable));
  }, [analysis.paragraphs]);

  const tierCoverages = useMemo(() => {
    if (analysis.totalTokens <= 0) return activeTiers.map(() => 0);
    return activeTiers.map((tier, idx) => {
      let known = 0;
      for (const token of countableTokens) {
        if (isMastered(token.lemma) || isKnownAtReaderTier(token.frequencyRanks, activeTiers, idx, readerTab)) {
          known += 1;
        }
      }
      return Math.round((known / analysis.totalTokens) * 100);
    });
  }, [analysis.totalTokens, activeTiers, countableTokens, masteredLemmas, readerTab]);

  const knownTokens = countableTokens.filter((token) => isMastered(token.lemma) || isKnownAtReaderTier(token.frequencyRanks, activeTiers, tierIndex, readerTab)).length;
  const uncoveredTokens = Math.max(0, analysis.totalTokens - knownTokens);
  const coveragePercent = tierCoverages[tierIndex] ?? (analysis.totalTokens > 0 ? Math.round((knownTokens / analysis.totalTokens) * 100) : 0);
  const knownUnique = [...analysis.wordFrequencyRanks.entries()].filter(([lemma, ranks]) => isMastered(lemma) || isKnownAtReaderTier(ranks, activeTiers, tierIndex, readerTab)).length;
  const uniqueCoveragePercent = analysis.wordRanks.size > 0 ? Math.round((knownUnique / analysis.wordRanks.size) * 100) : 0;
  const currentTierTokens = countableTokens.filter((token) => !isMastered(token.lemma) && isInReaderTier(token.frequencyRanks, activeTiers, tierIndex, readerTab)).length;
  const nextTierTokens = nextTier
    ? countableTokens.filter((token) => !isMastered(token.lemma) && isInReaderTier(token.frequencyRanks, activeTiers, tierIndex + 1, readerTab) && !isKnownAtReaderTier(token.frequencyRanks, activeTiers, tierIndex, readerTab)).length
    : 0;
  const wordsForTier = (index: number, excludeKnownAtCurrent = false): Array<[string, number]> => {
    const tier = activeTiers[index];
    if (!tier) return [];
    const words: Array<[string, number]> = [];
    for (const [lemma, ranks] of analysis.wordFrequencyRanks.entries()) {
      const rank = rankAtReaderTier(ranks, tier);
      if (isMastered(lemma) || rank === null || !isInReaderTier(ranks, activeTiers, index, readerTab)) continue;
      if (excludeKnownAtCurrent && isKnownAtReaderTier(ranks, activeTiers, tierIndex, readerTab)) continue;
      words.push([lemma, rank]);
    }
    return words.sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
  };
  const tierWords = wordsForTier(tierIndex);
  const nextTierWords = nextTier ? wordsForTier(tierIndex + 1, true) : [];

  const selectTab = (tab: ReaderFrequencyTab) => {
    setReaderTab(tab);
    setActiveWord(null);
    setDrawerOpen(false);
  };
  const selectTier = (index: number) => {
    const tier = activeTiers[index];
    if (!tier) return;
    setTierIndices((current) => ({ ...current, [readerTab]: index }));
    if (readerTab === 'subtlex') onVocabularySizeChange(tier.rank);
  };

  useEffect(() => {
    const nextIndex = vocabularyTierIndexForRank(vocabularySize);
    setTierIndices((current) => current.subtlex === nextIndex ? current : { ...current, subtlex: nextIndex });
  }, [vocabularySize]);

  useEffect(() => {
    let disposed = false;
    void browser.storage.local.get([READER_BASELINE_KEY, READER_SAVED_WORDS_KEY]).then((values) => {
      if (disposed) return;
      const storedBaseline = values[READER_BASELINE_KEY];
      if (storedBaseline && typeof storedBaseline === 'object') {
        const record = storedBaseline as Partial<ReaderBaseline>;
        if (typeof record.rank === 'number' && typeof record.title === 'string') {
          const savedRank = record.rank;
          const source: ReaderFrequencyTab = record.source === 'ngsl' ? 'ngsl' : 'subtlex';
          const tiers = READER_TAB_TIERS[source];
          const restoredTier = tiers.find((tier) => tier.rank === savedRank)
            || tiers.find((tier) => tier.rank >= savedRank)
            || tiers.at(-1)!;
          const restored: ReaderBaseline = {
            title: record.title,
            source,
            tierLabel: restoredTier.label,
            rank: restoredTier.rank,
            cefr: restoredTier.cefr,
            coveragePercent: typeof record.coveragePercent === 'number' ? record.coveragePercent : 0,
            savedAt: typeof record.savedAt === 'string' ? record.savedAt : new Date().toISOString(),
          };
          setBaseline(restored);
        }
      }
      const storedWords = values[READER_SAVED_WORDS_KEY];
      if (Array.isArray(storedWords)) setSavedWords(storedWords.filter((item): item is SavedReaderWord => Boolean(item && typeof item === 'object' && typeof (item as SavedReaderWord).key === 'string')));
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, []);

  const refreshVocabulary = useCallback(async () => {
    try {
      const state = await sendRuntime<VocabularyState>({ type: 'VOCABULARY_STATE_GET' });
      setMasteredLemmas(new Set(state.masteredLemmas.map(normalizeVocabularyKey)));
      setSavedVocabularyLemmas(new Set(state.cards.flatMap((card) => vocabularyTermKeys(card.word, card.lemma))));
    } catch {
      // The baseline reader remains usable if the study store is unavailable.
    }
  }, [sendRuntime]);

  useEffect(() => {
    void refreshVocabulary();
    const onVocabularyChange = (message: RuntimeMessage) => {
      if (message.type === 'VOCABULARY_CHANGED') void refreshVocabulary();
    };
    browser.runtime.onMessage.addListener(onVocabularyChange);
    return () => browser.runtime.onMessage.removeListener(onVocabularyChange);
  }, [refreshVocabulary]);

  useEffect(() => {
    const active = activeTierRef.current;
    const track = active?.parentElement;
    if (active && track && active.offsetParent) track.scrollLeft += active.getBoundingClientRect().left - track.getBoundingClientRect().left - (track.clientWidth - active.offsetWidth) / 2;
    const selected = selectedDesktopTierRef.current;
    if (selected && selected.offsetParent) {
      const list = selected.parentElement;
      if (list) list.scrollTop += selected.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - selected.offsetHeight) / 2;
    }
  }, [readerTab, tierIndex]);

  useEffect(() => {
    if (!activeWord) {
      setDictionary(null);
      setDictionaryLoading(false);
      return undefined;
    }
    let disposed = false;
    setDictionary(null);
    setDictionaryLoading(true);
    void sendRuntime<DictionaryResult>({ type: 'DICTIONARY_LOOKUP', text: activeWord.raw, contextText: activeWord.contextText, detail: 'full' })
      .then((result) => { if (!disposed) setDictionary(result); })
      .catch(() => { if (!disposed) setDictionary(null); })
      .finally(() => { if (!disposed) setDictionaryLoading(false); });
    return () => { disposed = true; };
  }, [activeWord, sendRuntime]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        event.preventDefault();
        selectTier(Math.min(activeTiers.length - 1, tierIndex + 1));
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        event.preventDefault();
        selectTier(Math.max(0, tierIndex - 1));
      } else if (event.key === 'Escape') {
        setActiveWord(null);
        setDrawerOpen(false);
        setPasteOpen(false);
        setMenuOpen(false);
        setCorpusPickerOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readerTab, tierIndex]);

  useEffect(() => {
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.reader-article-dropdown')) setMenuOpen(false);
    };
    const handleScroll = () => {
      setActiveWord(null);
    };
    document.addEventListener('click', closeMenu);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      document.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const loadText = (text: string, title: string) => {
    const nextText = text.trim();
    if (!nextText) return;
    setSourceText(nextText);
    setArticleTitle(title);
    setActiveWord(null);
    setLoadError('');
    setPasteOpen(false);
    setMenuOpen(false);
  };

  const openPaste = () => {
    setPasteText(sourceText);
    setPasteOpen(true);
    setMenuOpen(false);
  };

  const openCorpusPicker = async () => {
    setMenuOpen(false);
    setCorpusPickerOpen(true);
    if (corpusTitles.length || corpusLoading) return;
    const cachedTitles = readCachedCorpusTitles();
    if (cachedTitles) {
      setCorpusTitles(cachedTitles);
      return;
    }
    setCorpusLoading(true);
    setCorpusLoadError('');
    try {
      const titles: CorpusSubtitleTitle[] = [];
      let cursor: number | null = 0;
      do {
        const response: CorpusSubtitleTitleListResponse = await sendRuntime<CorpusSubtitleTitleListResponse>({
          type: 'CORPUS_SUBTITLE_TITLES_LIST',
          filters: { query: '', cursor, limit: 500 },
        });
        titles.push(...response.items);
        cursor = response.nextCursor;
      } while (cursor !== null && titles.length < 10_000);
      setCorpusTitles(titles);
      cacheCorpusTitles(titles);
    } catch (cause) {
      setCorpusLoadError(corpusSubtitleErrorMessage(cause, 'titles'));
    } finally {
      setCorpusLoading(false);
    }
  };

  const loadCorpusSubtitle = async (item: CorpusSubtitleTitle) => {
    setLoadingSubtitleId(item.id);
    setCorpusLoadError('');
    try {
      let detail = readCachedCorpusDetail(item);
      if (!detail) {
        detail = await sendRuntime<CorpusSubtitleDetail>({
          type: 'CORPUS_SUBTITLE_DETAIL_GET',
          subtitleId: item.id,
          contentVersion: item.contentVersion,
        });
        cacheCorpusDetail(detail);
      }
      loadText(detail.text, detail.seriesTitle ? `${detail.seriesTitle} · ${detail.title}` : detail.title);
      setCorpusPickerOpen(false);
      onNotice?.(t("已载入“{0}”字幕，共 {1} 条。", detail.title, detail.cueCount.toLocaleString()));
    } catch (cause) {
      setCorpusLoadError(corpusSubtitleErrorMessage(cause, 'detail'));
    } finally {
      setLoadingSubtitleId('');
    }
  };

  const normalizedCorpusSearch = corpusSearch.normalize('NFKC').trim().toLocaleLowerCase();
  const filteredCorpusTitles = corpusTitles.filter((item) => !normalizedCorpusSearch || [item.title, item.seriesTitle, item.platform].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedCorpusSearch));

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      loadText(await file.text(), file.name.replace(/\.[^.]+$/, '') || t("导入文本"));
    } catch {
      setLoadError(t("文本文件读取失败，请重新选择 .txt 文件。"));
    }
  };

  const saveBaseline = async () => {
    const nextBaseline: ReaderBaseline = {
      title: articleTitle,
      source: readerTab,
      tierLabel: currentTier.label,
      rank: threshold,
      cefr: currentTier.cefr,
      coveragePercent,
      savedAt: new Date().toISOString(),
    };
    try {
      await browser.storage.local.set({ [READER_BASELINE_KEY]: nextBaseline });
      setBaseline(nextBaseline);
      onNotice?.(t("已保存“{0} · {1}”阅读测评基准。", currentTier.label, currentTier.cefr));
    } catch {
      onNotice?.(t("测评结果保存失败，仅保留当前页面状态。"));
    }
  };

  const toggleSaveWord = async () => {
    if (!activeWord) return;
    const key = `${articleTitle}:${activeWord.lemma}`;
    const exists = savedWords.some((item) => item.key === key) || vocabularyTermKeys(activeWord.raw, activeWord.lemma).some((item) => savedVocabularyLemmas.has(item));
    try {
      if (exists) {
        await sendRuntime({ type: 'VOCABULARY_REMOVE', word: activeWord.lemma });
      } else {
        await sendRuntime({
          type: 'VOCABULARY_SAVE',
          input: {
            word: activeWord.raw,
            lemma: activeWord.lemma,
            rank: activeWord.rank,
            source: `reader:${articleTitle}`,
            contextText: activeWord.contextText,
            ...(dictionary?.shortZh || dictionary?.translation ? { translation: dictionary?.shortZh || dictionary?.translation || '' } : {}),
            ...(dictionary?.phonetic ? { phonetic: dictionary.phonetic } : {}),
          },
        });
      }
      const nextWords = exists
        ? savedWords.filter((item) => item.key !== key)
        : [...savedWords, {
          key,
          word: activeWord.raw,
          lemma: activeWord.lemma,
          title: articleTitle,
          contextText: activeWord.contextText,
          meaningZh: dictionaryMeaning(dictionary, rankLabel(activeWord.rank)),
          phonetic: dictionary?.phonetic || '',
          savedAt: new Date().toISOString(),
        }];
      setSavedWords(nextWords);
      await browser.storage.local.set({ [READER_SAVED_WORDS_KEY]: nextWords });
      await refreshVocabulary();
      onNotice?.(exists ? t("已从本地词汇移除。") : t("已保存到背词队列。"));
    } catch {
      onNotice?.(t("词汇保存失败，请重试。"));
    }
  };

  const speakWord = async () => {
    if (!activeWord) return;
    try {
      const audio = await sendRuntime<DictionaryAudioResult>({ type: 'DICTIONARY_TTS', text: activeWord.raw });
      if (audio?.audioUrl) {
        const player = new Audio(audio.audioUrl);
        await player.play();
        return;
      }
    } catch {
      // Fall through to the browser's built-in voice.
    }
    cancelEnglishSpeech();
    speakEnglish(activeWord.raw);
  };

  const openWord = (event: React.MouseEvent<HTMLSpanElement>, token: ReaderToken, contextText: string) => {
    if (token.kind !== 'word' || !token.countable) return;
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setActiveWord({
      raw: token.raw,
      lemma: token.lemma,
      rank: token.rank,
      frequencyRanks: token.frequencyRanks,
      occurrences: analysis.wordFreqs.get(token.lemma) || 1,
      contextText,
      anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
    });
  };

  const savedKey = activeWord ? `${articleTitle}:${activeWord.lemma}` : '';
  const activeIsSaved = Boolean(savedKey && (savedWords.some((item) => item.key === savedKey) || (activeWord && vocabularyTermKeys(activeWord.raw, activeWord.lemma).some((item) => savedVocabularyLemmas.has(item)))));
  const frequencyTabs = (extraClass = '') => <div className={`reader-frequency-tabs ${extraClass}`} role="tablist" aria-label={t("词频表")}>
    {READER_TABS.map((tab) => <button
      key={tab.id}
      type="button"
      role="tab"
      aria-selected={readerTab === tab.id}
      className={`reader-frequency-tab ${readerTab === tab.id ? 'is-active' : ''}`}
      onClick={(event) => { event.stopPropagation(); selectTab(tab.id); }}
    >{tab.label}</button>)}
  </div>;

  return <section className="reader-estimator-page" aria-label={t("语料理解度测评")} onClick={() => setActiveWord(null)}>
    <div className="reader-mobile-tier-row" aria-label={t("词汇量档位选择器")}>
      <div className="reader-mobile-tabs-bar">
        {frequencyTabs('reader-frequency-tabs-mobile')}
        <button
          type="button"
          className="reader-concept-trigger-btn reader-concept-trigger-mobile"
          onClick={() => setConceptOpen(true)}
          title={t("词频体系理念与各档位详解")}
        >
          <Icon name="book" />
          <span>{t("理念说明")}</span>
        </button>
      </div>
      <div className="reader-tier-track">
        {activeTiers.map((tier, index) => <button
          key={tier.label}
          ref={index === tierIndex ? activeTierRef : null}
          type="button"
          className={`reader-tier-card ${index === tierIndex ? 'is-active' : ''}`}
          onClick={(event) => { event.stopPropagation(); if (index === tierIndex) setDrawerOpen(true); else selectTier(index); }}
          aria-label={t("词汇量级别：{0}，CEFR {1}，覆盖率 {2}%", tier.label, tier.cefr, tierCoverages[index])}
        ><span>{tier.label}</span><b>{tier.cefr}</b><small className="reader-tier-card-cov">{tierCoverages[index]}%</small></button>)}
      </div>
    </div>
    <div className="reader-mobile-words-row" aria-label={t("当前档位代表词列表")}>
      <span className="reader-mobile-words-label"><i />{currentTier.rank === 0 ? t("起点基线:") : `${currentTier.label}:`}</span>
      <div className="reader-mobile-words-track">
        {tierWords.length ? tierWords.map(([word, rank]) => <button key={word} type="button" onClick={(event) => {
          event.stopPropagation();
          const target = [...document.querySelectorAll<HTMLElement>('[data-reader-lemma]')].find((item) => item.dataset.readerLemma === word);
          target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target?.click();
        }}>{word}<small>#{rank}</small></button>) : <span>{analysis.wordRanks.size ? t("当前文章在此档位无代表词") : t("导入文本后开始分析")}</span>}
      </div>
    </div>

    <div className="reader-estimator-main">
      <aside className="reader-estimator-panel reader-estimator-panel-left" aria-label={t("词频分级表")}>
        <div className="reader-estimator-panel-header">
          <div className="reader-panel-title-row">
            <h2>{t("词频分级")}<span>{readerTab === 'ngsl' ? 'NGSL' : 'SUBTLEX-US'}</span></h2>
            <button
              type="button"
              className="reader-concept-trigger-btn"
              onClick={() => setConceptOpen(true)}
              title={t("查看词频体系理念与各档位详解")}
            >
              <Icon name="book" />
              <span>{t("理念说明")}</span>
            </button>
          </div>
          {frequencyTabs()}
          <p className="reader-frequency-summary">{readerTab === 'ngsl' ? t("按英语学习核心词表分级，选择档位查看本文覆盖率。") : t("按影视对白词频分级，选择档位查看本文覆盖率。")}</p>
        </div>
        <div className="reader-vocab-list" role="group" aria-label={t("选择词汇量等级")}>
          {activeTiers.map((tier, index) => {
            const isSelected = index === tierIndex;
            const isNext = index === tierIndex + 1;
            const isBaseline = tier.source === 'baseline';
            const words = isBaseline ? [] : wordsForTier(index, isNext);
            return <button key={tier.label} type="button" className={`reader-vocab-row ${isSelected ? 'is-selected' : ''} ${isNext ? 'is-next' : ''}`} onClick={() => selectTier(index)} aria-pressed={isSelected} ref={isSelected ? selectedDesktopTierRef : undefined}>
              <span className="reader-vocab-row-top">
                <span>
                  <strong>{tier.label}</strong>
                  <em>{tier.cefr}</em>
                  <small>{tier.desc}</small>
                  {isSelected && <mark className="current">{t("✓ 当前档")}</mark>}
                  {isNext && <mark className="next">{t("下一档")}</mark>}
                </span>
                <div className="reader-vocab-row-stats">
                  <span className="reader-vocab-coverage-badge">
                    {t("覆盖")}<b>{tierCoverages[index]}%</b>
                  </span>
                  <i className="reader-vocab-coverage-bar" aria-hidden="true">
                    <b style={{ width: `${tierCoverages[index]}%` }} />
                  </i>
                  {!isBaseline && <span className="reader-vocab-count-label">{words.length} {t("词")}</span>}
                </div>
              </span>
              <span className="reader-vocab-words">{analysis.wordRanks.size === 0 ? t("载入文本后显示出现在此级别的词") : isBaseline ? t("基线：还不认识任何英文单词") : words.length === 0 ? t("本文在此区间无对应词汇") : <>{words.slice(0, isSelected || isNext ? 12 : 5).map(([word, rank]) => { const saved = savedVocabularyLemmas.has(normalizeVocabularyKey(word)); const ranks = analysis.wordFrequencyRanks.get(word) || EMPTY_FREQUENCY_RANKS; return <i key={word} className={saved ? 'saved' : isSelected && showCurrentHighlight ? 'current' : isNext && showNextHighlight ? 'next' : isKnownAtReaderTier(ranks, activeTiers, tierIndex, readerTab) ? 'known' : ''} title={t("{0}排名 #{1} · 本文出现 {2} 次", saved ? t("已保存 · 待学习 ·") : '', rank, analysis.wordFreqs.get(word) || 1)}>{word}</i>; })}{words.length > (isSelected || isNext ? 12 : 5) && <small>+{words.length - (isSelected || isNext ? 12 : 5)} {t("更多…")}</small>}</>}</span>
            </button>;
          })}
        </div>
        <div className="reader-estimator-panel-footer">{t("使用键盘 ↑ ↓ 或滑动切换等级")}</div>
      </aside>

      <section className="reader-estimator-panel reader-estimator-panel-right" aria-label={t("文本分析视图")}>
        <div className="reader-estimator-panel-header reader-estimator-right-header">
          <div className="reader-header-line">
            <div className={`reader-article-dropdown ${menuOpen ? 'is-open' : ''}`}>
              <button type="button" className="reader-article-title-btn" aria-expanded={menuOpen} onClick={(event) => { event.stopPropagation(); setMenuOpen((value) => !value); }}><span>{articleTitle}</span><b>{currentTier.cefr}</b><i><Icon name="chevron" /></i></button>
              <div className="reader-article-menu" onClick={(event) => event.stopPropagation()}>
                <button type="button" onClick={() => loadText(jobsText, t("乔布斯斯坦福演讲"))}>{t("乔布斯斯坦福演讲")}<small>{t("经典演讲 · A1-B1")}</small></button>
                {web && <button type="button" onClick={() => void openCorpusPicker()}>{t("从语料库选择字幕")}<small>{t("读取已发布语料的完整英文字幕")}</small></button>}
                <div />
                <button type="button" onClick={() => fileInputRef.current?.click()}>{t("导入本地 .txt 文本")}<small>{t("从文件读取新的英语语料")}</small></button>
                <button type="button" onClick={openPaste}>{t("粘贴 / 输入自定义文本")}<small>{t("文章、外刊或字幕均可")}</small></button>
              </div>
            </div>
            <div className="reader-text-stats"><span>{t("全文")}{formatCount(analysis.totalTokens)} {t("词")}</span><span>{t("当前未覆盖")}{formatCount(uncoveredTokens)} {t("词")}</span><span>{t("已掌握")}{formatCount(masteredLemmas.size)} {t("词")}</span><span>{t("未收录")}{formatCount(analysis.wordRanks.size ? [...analysis.wordRanks.values()].filter((rank) => !Number.isFinite(rank)).length : 0)} {t("个词")}</span>{analysis.excludedTokens > 0 && <span>{t("忽略")}{formatCount(analysis.excludedTokens)} {t("个专名/格式")}</span>}</div>
            <div className="reader-coverage-pill" title={t("按实际出现次数加权计算的覆盖率")}><span>{t("覆盖率")}</span><strong>{coveragePercent}%</strong><i><b style={{ width: `${coveragePercent}%` }} /></i></div>
          </div>
          <div className="reader-tier-legend">
            <button type="button" className={`reader-legend-pill current ${showCurrentHighlight ? '' : 'is-off'}`} aria-pressed={showCurrentHighlight} onClick={() => setShowCurrentHighlight((value) => !value)}><i /><span>{t("本级核心")}</span><strong>{currentTier.label}</strong><small>{currentTierTokens} {t("词")}</small></button>
            {nextTier && <button type="button" className={`reader-legend-pill next ${showNextHighlight ? '' : 'is-off'}`} aria-pressed={showNextHighlight} onClick={() => setShowNextHighlight((value) => !value)}><i /><span>{t("进阶目标")}</span><strong>{nextTier.label}</strong><small>{nextTierTokens} {t("词")}</small></button>}
            <span className="reader-legend-pill saved" title={t("已保存但尚未掌握的词使用蓝色显示")}><i /><span>{t("已保存")}</span><strong>{t("待学习")}</strong><small>{t("蓝色高亮")}</small></span>
            <button type="button" className="reader-replace-text-btn" onClick={openPaste}>{t("替换文本")}</button>
          </div>
        </div>
        <div className="reader-text-area" ref={textAreaRef} onScroll={() => setActiveWord(null)}>
          {loadError && <p className="reader-load-error" role="alert">{loadError}</p>}
          {analysis.paragraphs.length ? <article className="reader-text-content">
            {analysis.paragraphs.map((paragraph, paragraphIndex) => {
              const contextText = paragraph.map((token) => token.raw).join('').trim();
              return <p data-reader-paragraph={paragraphIndex} key={`${articleTitle}-${paragraphIndex}`}>{paragraph.map((token, tokenIndex) => token.kind === 'space' ? <React.Fragment key={`${paragraphIndex}-${tokenIndex}`}>{token.raw}</React.Fragment> : <span
                key={`${paragraphIndex}-${tokenIndex}`}
                data-reader-word={token.kind === 'word' ? 'true' : undefined}
                data-reader-lemma={token.kind === 'word' ? token.lemma : undefined}
                className={token.kind !== 'word' ? 'reader-punct' : (() => {
                  if (!token.countable) return 'reader-word excluded';
                  if (isMastered(token.lemma)) return 'reader-word mastered';
                  if (isSaved(token.raw, token.lemma)) return 'reader-word saved';
                  const knownAtCurrent = isKnownAtReaderTier(token.frequencyRanks, activeTiers, tierIndex, readerTab);
                  if (isInReaderTier(token.frequencyRanks, activeTiers, tierIndex, readerTab)) return `reader-word ${showCurrentHighlight ? 'tier-current' : 'known'}`;
                  if (nextTier && isInReaderTier(token.frequencyRanks, activeTiers, tierIndex + 1, readerTab) && !knownAtCurrent) return `reader-word ${showNextHighlight ? 'tier-next' : 'unknown faded'}`;
                  if (knownAtCurrent) return 'reader-word known';
                  return 'reader-word unknown faded';
                })()}
                onClick={(event) => openWord(event, token, contextText)}
              >{token.raw}</span>)} </p>;
            })}
          </article> : <div className="reader-empty-state"><strong>{t("还没有可分析的文本")}</strong><button type="button" onClick={openPaste}>{t("粘贴一段英文文本")}</button></div>}
        </div>
      </section>
    </div>

    <footer className="reader-estimator-footer">
      <div className="reader-footer-summary"><div><span>{t("起始词汇量 ·")}{readerTab === 'ngsl' ? 'NGSL' : 'SUBTLEX-US'}</span><strong>{readerTab === 'ngsl' ? currentTier.label : formatCount(threshold)}</strong><small>{readerTab === 'ngsl' ? '' : t("词")}</small><em>{currentTier.cefr}</em></div><span className="reader-footer-meta">{baseline ? t("上次保存：{0} · {1} · {2}% 覆盖 · {3}", baseline.source === 'ngsl' ? 'NGSL' : 'SUBTLEX-US', baseline.tierLabel, baseline.coveragePercent, new Date(baseline.savedAt).toLocaleString()) : t("独立词覆盖 {0}% · 已掌握词 {1}", uniqueCoveragePercent, masteredLemmas.size)}</span></div>
      <button type="button" className="reader-confirm-btn" onClick={() => void saveBaseline()}><span><Icon name="target" /></span>{t("保存当前测评")}</button>
    </footer>

    <input ref={fileInputRef} className="reader-hidden-input" type="file" accept=".txt,text/plain" onChange={(event) => void handleFile(event)} />

    {activeWord && <ReaderWordPopover activeWord={activeWord} known={isKnownAtReaderTier(activeWord.frequencyRanks, activeTiers, tierIndex, readerTab)} activeTierLabel={currentTier.label} activeTierRank={rankAtReaderTier(activeWord.frequencyRanks, currentTier)} result={dictionary} loading={dictionaryLoading} saved={activeIsSaved} mastered={isMastered(activeWord.lemma)} onSpeak={() => void speakWord()} onToggleSave={() => void toggleSaveWord()} onClose={() => setActiveWord(null)} />}

    {pasteOpen && <div className="reader-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setPasteOpen(false); }}>
      <div className="reader-modal-dialog" role="dialog" aria-modal="true" aria-label={t("输入英文文本")}>
        <header><div><h3>{t("粘贴 / 输入英文文本")}</h3><p>{t("粘贴文章、外刊或字幕进行词频测算")}</p></div><button type="button" aria-label={t("关闭")} onClick={() => setPasteOpen(false)}><Icon name="close" /></button></header>
        <div className="reader-modal-body"><textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder={t("在此粘贴或输入英文文本…")} rows={10} /><span>{formatCount((pasteText.match(/[A-Za-z]+/g) || []).length)} {t("词")}</span><div className="reader-quick-presets"><button type="button" onClick={() => setPasteText(jobsText)}>{t("乔布斯演讲")}</button></div></div>
        <footer><button type="button" onClick={() => setPasteOpen(false)}>{t("取消")}</button><button type="button" className="primary" onClick={() => loadText(pasteText, t("粘贴自定义文本"))}>{t("确认载入分析")}</button></footer>
      </div>
    </div>}

    {corpusPickerOpen && <div className="reader-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setCorpusPickerOpen(false); }}>
      <div className="reader-modal-dialog reader-corpus-picker" role="dialog" aria-modal="true" aria-label={t("选择语料字幕")}>
        <header><div><h3>{t("从语料库选择字幕")}</h3><p>{t("标题目录一次轻量读取；选中后才加载字幕正文。")}</p></div><button type="button" aria-label={t("关闭")} onClick={() => setCorpusPickerOpen(false)}><Icon name="close" /></button></header>
        <div className="reader-corpus-picker-body">
          <input value={corpusSearch} onChange={(event) => setCorpusSearch(event.target.value)} placeholder={t("搜索标题或系列…")} aria-label={t("搜索语料字幕")} />
          {!corpusLoadError && <div className="reader-corpus-picker-summary"><span>{corpusTitles.length.toLocaleString()} {t("条可用字幕")}</span>{normalizedCorpusSearch && <span>{t("匹配")}{filteredCorpusTitles.length.toLocaleString()} {t("条")}</span>}</div>}
          {corpusLoadError ? <div className="reader-corpus-picker-empty" role="alert"><span>{corpusLoadError}</span><button type="button" onClick={() => void openCorpusPicker()}>{t("重试")}</button></div> : corpusLoading ? <div className="reader-corpus-picker-empty">{t("正在读取字幕标题…")}</div> : filteredCorpusTitles.length ? <div className="reader-corpus-picker-list">
            {filteredCorpusTitles.map((item) => <button key={`${item.id}:${item.contentVersion}`} type="button" disabled={Boolean(loadingSubtitleId)} onClick={() => void loadCorpusSubtitle(item)}>
              <span><strong>{item.title}</strong><small>{[item.seriesTitle, item.library === 'media' ? t("自有语料") : null, item.platform === 'bilibili' ? t("B站") : 'YouTube'].filter(Boolean).join(' · ')}</small></span>
              <em>{loadingSubtitleId === item.id ? t("载入中…") : item.cueCount ? t("{0} 条", item.cueCount.toLocaleString()) : t("查看")}</em>
            </button>)}
          </div> : <div className="reader-corpus-picker-empty">{corpusSearch ? t("没有匹配的字幕") : t("当前没有可用字幕")}</div>}
        </div>
      </div>
    </div>}

    {drawerOpen && <div className="reader-drawer-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}>
      <div className="reader-drawer-content" role="dialog" aria-modal="true" aria-label={t("选择词汇量等级")}>
        <div className="reader-drawer-handle" />
        <header>
          <h3>{t("选择")}{readerTab === 'ngsl' ? 'NGSL' : 'SUBTLEX-US'} {t("词汇量等级")}</h3>
          <div className="reader-drawer-header-actions">
            <button
              type="button"
              className="reader-concept-trigger-btn"
              onClick={() => { setDrawerOpen(false); setConceptOpen(true); }}
              title={t("查看词频分级理念与档位详解")}
            >
              <Icon name="book" />
              <span>{t("理念说明")}</span>
            </button>
            <button type="button" aria-label={t("关闭词汇量等级")} onClick={() => setDrawerOpen(false)}><Icon name="close" /></button>
          </div>
        </header>
        <div className="reader-drawer-list">{activeTiers.map((tier, index) => {
          const isBaseline = tier.source === 'baseline';
          return <button key={tier.label} type="button" className={index === tierIndex ? 'is-selected' : ''} onClick={() => { selectTier(index); setDrawerOpen(false); }}>
            <div className="reader-drawer-tier-left">
              <span>{tier.label}<b>{tier.cefr}</b></span>
              <small>{tier.desc}</small>
            </div>
            <div className="reader-drawer-tier-right">
              <span className="reader-drawer-cov">{t("覆盖")}<b>{tierCoverages[index]}%</b></span>
              {!isBaseline && <small>{wordsForTier(index).length} {t("词")}</small>}
            </div>
          </button>;
        })}</div>
      </div>
    </div>}

    {conceptOpen && <div className="reader-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setConceptOpen(false); }}>
      <div className="reader-modal-dialog reader-concept-dialog" role="dialog" aria-modal="true" aria-label={t("词频分级理念与体系说明")}>
        <header>
          <div>
            <h3>{t("词频分级理念与体系说明")}</h3>
            <p>{t("了解 NGSL 各档位定位与 SUBTLEX-US 影视语用词频理念")}</p>
          </div>
          <button type="button" aria-label={t("关闭")} onClick={() => setConceptOpen(false)}><Icon name="close" /></button>
        </header>
        <div className="reader-modal-body reader-concept-modal-body">
          <section className="reader-concept-section">
            <div className="reader-concept-section-head">
              <span className="reader-concept-pill subtlex">SUBTLEX-US</span>
              <h4>{t("现代影视语用词频理念")}</h4>
            </div>
            <div className="reader-concept-card">
              <p>
                <strong>{t("为什么使用影视字幕语料？")}</strong> {t("传统经典词频表多提取自正式书面出版物（如新闻报刊、百科全书、学术论文），不可避免地偏重书面甚至生僻文体，导致许多现实生活交流中极高频实用的口语词汇排名被严重稀释。")}</p>
              <p>
                <strong>{t("真实语用与认知实证：")}</strong> {t("SUBTLEX-US 基于 8,000+ 部美剧与好莱坞电影字幕、累计逾 5,100 万词次大数据提炼而成。认知心理学权威研究（Brysbaert & New）证实，在预测学习者与母语者的自然词汇识别速度和视听理解难度上，影视字幕词频的拟合度与解释力显著优于传统书面词表。")}</p>
              <p>
                <strong>{t("0 ~ 10,000 词梯度与全局联动：")}</strong> {t("本系统将 SUBTLEX-US 精细划分为 12 个台阶（Pre-A1 至 C2）。它作为本插件唯一的全域基准值，跨设备同步，直接驱动 YouTube 播放器超纲生词波浪线高亮、生词预习以及视频难度适合度评估。")}</p>
            </div>
          </section>

          <section className="reader-concept-section">
            <div className="reader-concept-section-head">
              <span className="reader-concept-pill ngsl">NGSL</span>
              <h4>{t("新通用服务词表体系与三大档位")}</h4>
            </div>
            <div className="reader-concept-card">
              <p>
                <strong>{t("体系理念：")}</strong> {t("NGSL (New General Service List) 由知名应用语言学家 Dr. Charles Browne 等主持研发，专门面向第二语言（ESL/EFL）学习者。其核心哲学是“以最少词量达成最高文本覆盖率”，是二语学习最具性价比的核心词表。")}</p>
              <div className="reader-concept-tier-grid">
                <div className="reader-concept-tier-card">
                  <div className="reader-concept-tier-title">
                    <span className="reader-ngsl-pill">NGSL-S</span>
                    <strong>{t("口语核心 (Spoken)")}</strong>
                    <em>{t("721 词 · A2")}</em>
                  </div>
                  <p>
                    {t("基于权威口语对话语料库提炼，专攻面对面日常会话与生活听力中最高频的交流词汇，是日常口语表达与听力交流的黄金起步基石。")}</p>
                </div>
                <div className="reader-concept-tier-card">
                  <div className="reader-concept-tier-title">
                    <span className="reader-ngsl-pill">NGSL</span>
                    <strong>{t("通用基石 (General)")}</strong>
                    <em>{t("2,809 词 · B1")}</em>
                  </div>
                  <p>
                    {t("二语学习者的核心词表，覆盖日常通用英语文本（常见杂志、网页、报道、书籍）90% 以上的词次，是通识阅读的核心词汇底座。")}</p>
                </div>
                <div className="reader-concept-tier-card">
                  <div className="reader-concept-tier-title">
                    <span className="reader-ngsl-pill">NGSL-GR</span>
                    <strong>{t("分级阅读 (Graded Readers)")}</strong>
                    <em>{t("5,000 词 · B2")}</em>
                  </div>
                  <p>
                    {t("针对全球主流分级读物高频词拓展，专为二语学习者搭建由浅入深的阶梯，助力平滑过渡至英文原版书籍的自主通识阅读。")}</p>
                </div>
              </div>
            </div>
          </section>

          <section className="reader-concept-section">
            <div className="reader-concept-section-head">
              <span className="reader-concept-pill diff">{t("体系协同")}</span>
              <h4>{t("两套分级在插件中的协同分工")}</h4>
            </div>
            <div className="reader-concept-card reader-concept-collab">
              <ul>
                <li><strong>{t("SUBTLEX-US 阶梯")}</strong>{t("：全插件通用设置，用于播放器超纲生词波浪线高亮、语料库视频难度匹配与跨端同步。")}</li>
                <li><strong>{t("NGSL 三档阶梯")}</strong>{t("：读懂多少页面的独立评估体系，专供你导入文章或演讲时，从二语核心教学维度快速自测文本覆盖率。")}</li>
              </ul>
            </div>
          </section>
        </div>
        <footer>
          <button type="button" className="primary" onClick={() => setConceptOpen(false)}>{t("我知道了")}</button>
        </footer>
      </div>
    </div>}
  </section>;
}
