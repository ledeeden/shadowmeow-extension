import { t } from '../../lib/i18n';
import { Icon } from '../../components/icon';
import { WordAtlas } from '../../components/word-atlas';
import { AtlasStudy } from '../../components/atlas-study';
import { VocabularyWordbooks } from '../../components/vocabulary-wordbooks';
import { isPersonalVocabularyCard } from '../../lib/wordbook-plan';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DictionaryResult,
  RuntimeMessage,
  SavedItemInput,
  VocabularyCard,
  VocabularyPlan,
  VocabularyRating,
  VocabularyState,
} from '@shadow-language/contracts';
import { buildVocabularyQueue } from '../../lib/vocabulary-scheduler';
import { cancelEnglishSpeech, speakEnglish } from '../../lib/speech';
import './vocabulary-study.css';
import '../../components/fonts.css';

export type VocabularyStudyRuntimeSender = <T>(message: RuntimeMessage) => Promise<T>;

export type VocabularyStudyProps = {
  sendRuntime: VocabularyStudyRuntimeSender;
  onNotice?: (notice: string) => void;
  assets?: Array<SavedItemInput & { syncStatus?: string; deletedAt?: string }>;
  onOpenAsset?: (item: SavedItemInput) => void;
  onUpdateAsset?: (item: SavedItemInput) => Promise<void>;
  onDeleteAsset?: (id: string) => Promise<void>;
  web?: boolean;
  vocabularySize?: number | undefined;
};

type StudyTab = 'study' | 'assets' | 'mastered' | 'verify';
type StudyViewMode = 'atlas' | 'card' | 'skim';
type KindFilter = 'all' | 'word' | 'phrase' | 'pattern';
type StatusFilter = 'all' | 'due' | 'learning' | 'new' | 'known';
type VerifyOption = { text: string; correct: boolean };
type VerifyResult = { word: string; correct: boolean };

export type UnifiedItem = {
  id: string;
  kind: SavedItemInput['kind'];
  displayValue: string;
  lemma?: string | undefined;
  meaningZh?: string | undefined;
  phonetic?: string | undefined;
  partOfSpeech?: string | undefined;
  contextText?: string | undefined;
  note?: string | undefined;
  rank?: number | null | undefined;
  occurredAt?: string | undefined;
  syncStatus?: string | undefined;
  videoKey?: string | undefined;
  youtubeId?: string | undefined;
  startMs?: number | undefined;
  card?: VocabularyCard | undefined;
  asset?: (SavedItemInput & { syncStatus?: string }) | undefined;
};

const ASSET_KIND_LABELS: Record<SavedItemInput['kind'], string> = {
  word: t("单词"),
  phrase: t("短语"),
  pattern: t("句式"),
};

function normalizeWordKey(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201B\u02BC\u0060\u00B4]/g, "'")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function formatRank(rank: number | null | undefined): string {
  return rank == null || !Number.isFinite(rank) ? t("未收录") : `#${rank.toLocaleString()}`;
}

function formatDate(timestamp: number | null | string | undefined): string {
  if (!timestamp) return t("现在");
  const timeMs = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  if (!timeMs || !Number.isFinite(timeMs)) return t("未知时间");
  return new Date(timeMs).toLocaleString(t("zh-CN"), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function cardIsNew(card: VocabularyCard): boolean {
  return !card.fsrs || card.fsrs.reps === 0;
}

function cardMeaning(card: VocabularyCard, dictionary?: DictionaryResult): string {
  return card.translation || dictionary?.shortZh || dictionary?.translation || dictionary?.senses.find((sense) => sense.definition)?.definition || t("暂无释义");
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function dedupeByText(options: VerifyOption[]): VerifyOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = option.text.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getItemMemoryStatus(item: UnifiedItem): 'due' | 'new' | 'learning' | 'known' | 'none' {
  if (!item.card) return 'none';
  if (item.card.status === 'known') return 'known';
  if (item.card.due && item.card.due <= Date.now()) return 'due';
  if (cardIsNew(item.card)) return 'new';
  return 'learning';
}

export function VocabularyStudy({
  sendRuntime,
  onNotice,
  assets = [],
  onOpenAsset,
  onUpdateAsset,
  onDeleteAsset,
  web = false,
  vocabularySize,
}: VocabularyStudyProps) {
  const isWeb = Boolean(web || import.meta.env.VITE_SHADOW_WEB);
  const [activeTab, setActiveTab] = useState<StudyTab>('study');
  const [viewMode, setViewMode] = useState<StudyViewMode>(() => {
    try {
      const saved = localStorage.getItem('shadow_vocab_study_mode') as StudyViewMode | null;
      if (saved && (saved === 'atlas' || saved === 'card' || saved === 'skim')) return saved;
      return isWeb ? 'atlas' : 'card';
    } catch {
      return isWeb ? 'atlas' : 'card';
    }
  });

  const handleViewModeChange = (mode: StudyViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem('shadow_vocab_study_mode', mode);
    } catch {
      // ignore
    }
  };
  const [plan, setPlan] = useState<VocabularyPlan | null>(null);
  const [allCards, setAllCards] = useState<VocabularyCard[]>([]);
  const [queue, setQueue] = useState<VocabularyCard[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [contextHint, setContextHint] = useState(false);
  const [audioHint, setAudioHint] = useState(false);
  const [skimMaskAll, setSkimMaskAll] = useState(true);
  const [skimRevealedMap, setSkimRevealedMap] = useState<Record<string, boolean>>({});
  const [autoPlayAudio, setAutoPlayAudio] = useState(true);
  const [sessionFinished, setSessionFinished] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Asset filtering & editing
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingDisplayValue, setEditingDisplayValue] = useState('');
  const [editingNote, setEditingNote] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [assetLayout, setAssetLayout] = useState<'grid' | 'list'>(() => {
    try {
      return (localStorage.getItem('shadow_vocab_asset_layout') as 'grid' | 'list') || 'grid';
    } catch {
      return 'grid';
    }
  });

  const handleLayoutChange = (mode: 'grid' | 'list') => {
    setAssetLayout(mode);
    try {
      localStorage.setItem('shadow_vocab_asset_layout', mode);
    } catch {
      // ignore
    }
  };

  // Goal modal
  const [goalOpen, setGoalOpen] = useState(false);
  const [goalVocab, setGoalVocab] = useState('8000');
  const [goalDays, setGoalDays] = useState('60');

  // Dictionary & audio
  const [dictionaryById, setDictionaryById] = useState<Record<string, DictionaryResult>>({});
  const [dictionaryLoadingId, setDictionaryLoadingId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const speechRequestId = useRef(0);
  const onNoticeRef = useRef(onNotice);

  useEffect(() => {
    onNoticeRef.current = onNotice;
  }, [onNotice]);

  // Mastered list state
  const [masteredQuery, setMasteredQuery] = useState('');

  // Verify quiz state
  const [verifyWords, setVerifyWords] = useState<VocabularyCard[]>([]);
  const [verifyIndex, setVerifyIndex] = useState(0);
  const [verifyOptions, setVerifyOptions] = useState<VerifyOption[]>([]);
  const [verifyScore, setVerifyScore] = useState({ correct: 0, wrong: 0 });
  const [verifyResults, setVerifyResults] = useState<VerifyResult[]>([]);
  const [verifyAnswered, setVerifyAnswered] = useState(false);
  const [verifyFinished, setVerifyFinished] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);

  // Build lookups
  const cardsByNormKey = useMemo(() => {
    const map = new Map<string, VocabularyCard>();
    for (const card of allCards) {
      if (card.lemma) map.set(normalizeWordKey(card.lemma), card);
      if (card.word) map.set(normalizeWordKey(card.word), card);
    }
    return map;
  }, [allCards]);

  const assetsByNormKey = useMemo(() => {
    const map = new Map<string, SavedItemInput & { syncStatus?: string }>();
    for (const item of assets) {
      if (item.lemma) map.set(normalizeWordKey(item.lemma), item);
      if (item.displayValue) map.set(normalizeWordKey(item.displayValue), item);
      if (item.normalizedValue) map.set(normalizeWordKey(item.normalizedValue), item);
    }
    return map;
  }, [assets]);

  // Unified items
  const unifiedItems = useMemo<UnifiedItem[]>(() => {
    const consumedCardIds = new Set<string>();
    const items: UnifiedItem[] = [];

    // 1. Process all assets
    for (const asset of assets) {
      const matchKey = normalizeWordKey(asset.lemma || asset.displayValue);
      const matchedCard = cardsByNormKey.get(matchKey);
      if (matchedCard) consumedCardIds.add(matchedCard.id);

      items.push({
        id: asset.id,
        kind: asset.kind,
        displayValue: asset.displayValue,
        lemma: asset.lemma || matchedCard?.lemma,
        meaningZh: asset.meaningZh || matchedCard?.translation,
        phonetic: asset.pronunciation || matchedCard?.phonetic,
        partOfSpeech: asset.partOfSpeech,
        contextText: asset.contextText || matchedCard?.contextText,
        note: asset.note,
        rank: matchedCard?.rank,
        occurredAt: asset.occurredAt,
        syncStatus: asset.syncStatus,
        videoKey: asset.videoKey,
        youtubeId: asset.youtubeId,
        startMs: asset.startMs,
        card: matchedCard,
        asset,
      });
    }

    // 2. Add any vocabulary cards that don't have a matching asset (e.g. saved from Reader)
    for (const card of allCards) {
      if (consumedCardIds.has(card.id)) continue;
      if (isWeb && !isPersonalVocabularyCard(card)) continue;
      items.push({
        id: card.id,
        kind: 'word',
        displayValue: card.word,
        lemma: card.lemma,
        meaningZh: card.translation,
        phonetic: card.phonetic,
        contextText: card.contextText,
        rank: card.rank,
        occurredAt: new Date(card.createdAt).toISOString(),
        card,
      });
    }

    // Sort by latest first
    return items.sort((a, b) => {
      const timeA = a.occurredAt ? Date.parse(a.occurredAt) : (a.card?.createdAt || 0);
      const timeB = b.occurredAt ? Date.parse(b.occurredAt) : (b.card?.createdAt || 0);
      return timeB - timeA;
    });
  }, [assets, allCards, cardsByNormKey, isWeb]);

  // Filtered unified items for assets view
  const filteredUnifiedItems = useMemo(() => {
    let result = unifiedItems;

    // Filter by kind
    if (kindFilter !== 'all') {
      result = result.filter((item) => item.kind === kindFilter);
    }

    // Filter by status
    if (statusFilter !== 'all') {
      result = result.filter((item) => {
        const memStatus = getItemMemoryStatus(item);
        if (statusFilter === 'due') return memStatus === 'due';
        if (statusFilter === 'new') return memStatus === 'new';
        if (statusFilter === 'learning') return memStatus === 'learning';
        if (statusFilter === 'known') return memStatus === 'known';
        return true;
      });
    }

    // Filter by search query
    const query = searchQuery.normalize('NFKC').trim().toLowerCase();
    if (query) {
      result = result.filter((item) =>
        [item.displayValue, item.lemma, item.meaningZh, item.contextText, item.note]
          .filter(Boolean)
          .some((val) => val!.toLowerCase().includes(query))
      );
    }

    return result;
  }, [unifiedItems, kindFilter, statusFilter, searchQuery]);

  const currentCard = queue[currentIndex];
  const matchedAssetForCurrentCard = currentCard
    ? assetsByNormKey.get(normalizeWordKey(currentCard.lemma || currentCard.word))
    : undefined;

  // Load state and plan
  const loadPlanAndCards = useCallback(async (resetQueue = true) => {
    if (resetQueue) setLoading(true);
    try {
      const [nextPlan, nextState] = await Promise.all([
        sendRuntime<VocabularyPlan>({ type: 'VOCABULARY_PLAN_GET' }),
        sendRuntime<VocabularyState>({ type: 'VOCABULARY_STATE_GET' }),
      ]);
      setPlan(nextPlan);
      setAllCards(nextState.cards);
      if (resetQueue) {
        setQueue(buildVocabularyQueue(nextPlan));
        setCurrentIndex(0);
        setFlipped(false);
        setContextHint(false);
        setAudioHint(false);
        setSessionFinished(false);
      }
      if (nextPlan.goal) {
        setGoalVocab(String(nextPlan.goal.targetVocab));
        setGoalDays(String(nextPlan.goal.targetDays));
      }
    } catch (error) {
      onNoticeRef.current?.(error instanceof Error ? error.message : t("背词计划读取失败。"));
    } finally {
      if (resetQueue) setLoading(false);
    }
  }, [sendRuntime]);

  useEffect(() => {
    void loadPlanAndCards();
  }, [loadPlanAndCards]);

  useEffect(() => {
    const onVocabularyChange = (message: RuntimeMessage) => {
      if (message.type !== 'VOCABULARY_CHANGED') return;
      void loadPlanAndCards(false);
    };
    browser.runtime.onMessage.addListener(onVocabularyChange);
    return () => browser.runtime.onMessage.removeListener(onVocabularyChange);
  }, [loadPlanAndCards]);

  useEffect(() => {
    if (activeTab !== 'verify') return;
    void initializeVerify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Dictionary lookup for current card if meaning missing
  useEffect(() => {
    if (!currentCard || currentCard.translation || dictionaryById[currentCard.id]) {
      setDictionaryLoadingId(null);
      return undefined;
    }
    let disposed = false;
    setDictionaryLoadingId(currentCard.id);
    void sendRuntime<DictionaryResult>({ type: 'DICTIONARY_LOOKUP', text: currentCard.word, detail: 'full' })
      .then((result) => {
        if (disposed) return;
        setDictionaryById((items) => ({ ...items, [currentCard.id]: result }));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) setDictionaryLoadingId(null);
      });
    return () => { disposed = true; };
  }, [currentCard?.id, currentCard?.translation, currentCard?.word, sendRuntime, dictionaryById]);

  // Keep recall free of unsolicited hints; autoplay belongs to the answer.
  useEffect(() => {
    if (!autoPlayAudio || !currentCard || !flipped || activeTab !== 'study' || viewMode !== 'card') return;
    void speakWord(currentCard.word, currentCard.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCard?.id, flipped, autoPlayAudio, activeTab, viewMode]);

  useEffect(() => {
    setContextHint(false);
    setAudioHint(false);
    speechRequestId.current += 1;
    cancelEnglishSpeech();
    setSpeakingId(null);
  }, [currentCard?.id, currentIndex]);

  // Keyboard navigation for card review
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (activeTab !== 'study' || viewMode !== 'card' || busy) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (!flipped) setFlipped(true);
      } else if (flipped && ['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault();
        void handleRating(Number(event.key) as VocabularyRating);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTab, viewMode, busy, flipped, currentCard, currentIndex, queue]);

  // Audio speech handler
  function speakWord(word: string, id: string) {
    if (speakingId === id) {
      speechRequestId.current += 1;
      cancelEnglishSpeech();
      setSpeakingId(null);
      return;
    }
    const requestId = ++speechRequestId.current;
    cancelEnglishSpeech();
    setSpeakingId(id);
    const onSpeechEnd = () => {
      if (requestId === speechRequestId.current) setSpeakingId(null);
    };
    if (!speakEnglish(word, { rate: 0.82, onend: onSpeechEnd, onerror: onSpeechEnd })) {
      setSpeakingId(null);
    }
  }

  // FSRS card rating
  async function handleRating(rating: VocabularyRating, targetCard?: VocabularyCard) {
    const cardToRate = targetCard || currentCard;
    if (!cardToRate || busy || (!targetCard && !flipped) || (targetCard && skimMaskAll && !skimRevealedMap[targetCard.id])) return;
    setBusy(true);
    try {
      const updated = await sendRuntime<VocabularyCard | null>({
        type: 'VOCABULARY_REVIEW',
        word: cardToRate.lemma || cardToRate.word,
        rating,
      });
      if (!updated) return;

      if (!targetCard) {
        // Active flashcard queue step
        const nextQueue = [...queue];
        nextQueue[currentIndex] = updated;
        if (rating === 1) nextQueue.push(updated);
        const nextIndex = currentIndex + 1;
        setQueue(nextQueue);
        setCurrentIndex(nextIndex);
        setFlipped(false);
        if (nextIndex >= nextQueue.length) setSessionFinished(true);
      }

      await loadPlanAndCards(false);
      if (updated.status === 'known') {
        onNotice?.(t("“{0}” 已掌握，后续不再高亮。", updated.word));
      }
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : t("记录复习失败。"));
    } finally {
      setBusy(false);
    }
  }

  // Toggle Known / Mastered state
  async function handleToggleKnown(item: UnifiedItem) {
    const isCurrentlyKnown = item.card?.status === 'known';
    setBusy(true);
    try {
      if (isCurrentlyKnown) {
        await sendRuntime({
          type: 'VOCABULARY_REVIEW',
          word: item.lemma || item.displayValue,
          rating: 1,
        });
        onNotice?.(t("已将 “{0}” 重置为复习队列。", item.displayValue));
      } else {
        await sendRuntime({
          type: 'VOCABULARY_MARK_KNOWN',
          input: {
            word: item.displayValue,
            ...(item.lemma ? { lemma: item.lemma } : {}),
            ...(item.meaningZh ? { translation: item.meaningZh } : {}),
            ...(item.phonetic ? { phonetic: item.phonetic } : {}),
            ...(item.contextText ? { contextText: item.contextText } : {}),
          },
        });
        onNotice?.(t("“{0}” 已标记为掌握，后续不再在字幕中高亮。", item.displayValue));
      }
      await loadPlanAndCards(false);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : t("掌握状态更新失败。"));
    } finally {
      setBusy(false);
    }
  }

  // Delete item from both assets and vocabulary
  async function handleDeleteItem(item: UnifiedItem) {
    if (!confirm(t("确定要从资产与词库中删除 “{0}” 吗？", item.displayValue))) return;
    setBusy(true);
    try {
      if (item.asset && onDeleteAsset) {
        await onDeleteAsset(item.asset.id);
      }
      if (item.card) {
        await sendRuntime({ type: 'VOCABULARY_REMOVE', word: item.card.lemma || item.card.word });
      }
      onNotice?.(t("已删除 “{0}”。", item.displayValue));
      await loadPlanAndCards(false);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : t("删除失败。"));
    } finally {
      setBusy(false);
    }
  }

  // Save asset edit
  async function handleSaveEdit(item: UnifiedItem) {
    const value = editingDisplayValue.replace(/\s+/g, ' ').trim();
    if (!value) return;
    setSavingEdit(true);
    try {
      if (item.asset && onUpdateAsset) {
        await onUpdateAsset({
          ...item.asset,
          displayValue: value,
          normalizedValue: value.normalize('NFKC').toLowerCase(),
          note: editingNote.trim(),
          occurredAt: new Date().toISOString(),
        });
      }
      setEditingItemId(null);
      onNotice?.(`资产已更新。`);
      await loadPlanAndCards(false);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : t("更新保存失败。"));
    } finally {
      setSavingEdit(false);
    }
  }

  function startEdit(item: UnifiedItem) {
    setEditingItemId(item.id);
    setEditingDisplayValue(item.displayValue);
    setEditingNote(item.note || '');
  }

  // Save Goal
  async function saveGoal() {
    const targetVocab = Math.max(1_000, Math.min(15_000, Number.parseInt(goalVocab, 10) || 8_000));
    const targetDays = Math.max(7, Math.min(365, Number.parseInt(goalDays, 10) || 60));
    try {
      await sendRuntime({ type: 'VOCABULARY_GOAL_SET', goal: { targetVocab, targetDays, startDate: plan?.goal?.startDate || Date.now() } });
      setGoalOpen(false);
      await loadPlanAndCards(false);
      onNotice?.(t("已设定 {0} 词 / {1} 天计划。", targetVocab.toLocaleString(), targetDays));
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : t("背词目标保存失败。"));
    }
  }

  // Verify quiz functions
  async function fetchMeaning(card: VocabularyCard): Promise<string> {
    const existing = dictionaryById[card.id];
    if (card.translation) return card.translation;
    if (existing) return cardMeaning(card, existing);
    try {
      const result = await sendRuntime<DictionaryResult>({ type: 'DICTIONARY_LOOKUP', text: card.word, detail: 'full' });
      setDictionaryById((items) => ({ ...items, [card.id]: result }));
      return cardMeaning(card, result);
    } catch {
      return t("暂无释义");
    }
  }

  async function makeVerifyOptions(card: VocabularyCard, candidates: VocabularyCard[]): Promise<VerifyOption[]> {
    const correctText = await fetchMeaning(card);
    const otherMeanings = await Promise.all(candidates.filter((item) => item.id !== card.id).slice(0, 8).map((item) => fetchMeaning(item)));
    const fallback = [t("另一个词义"), t("不同含义"), t("请结合语境判断")];
    const distractors = [...new Set([...otherMeanings, ...fallback])].filter((text) => text && text !== correctText).slice(0, 3);
    return shuffle(dedupeByText([{ text: correctText, correct: true }, ...distractors.map((text) => ({ text, correct: false }))]));
  }

  async function initializeVerify() {
    setVerifyLoading(true);
    setVerifyFinished(false);
    setVerifyAnswered(false);
    try {
      const candidates = allCards.filter((card) => ['learning', 'unfamiliar', 'known'].includes(card.status));
      if (candidates.length < 4) {
        setVerifyWords([]);
        return;
      }
      const sample = shuffle(candidates).slice(0, Math.min(15, candidates.length));
      setVerifyWords(sample);
      setVerifyIndex(0);
      setVerifyScore({ correct: 0, wrong: 0 });
      setVerifyResults([]);
      setVerifyOptions(await makeVerifyOptions(sample[0]!, candidates));
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : t("成果测验准备失败。"));
    } finally {
      setVerifyLoading(false);
    }
  }

  async function handleVerifyAnswer(option: VerifyOption) {
    const card = verifyWords[verifyIndex];
    if (!card || verifyAnswered || verifyLoading) return;
    setVerifyAnswered(true);
    const correct = option.correct;
    setVerifyScore((score) => ({ correct: score.correct + (correct ? 1 : 0), wrong: score.wrong + (correct ? 0 : 1) }));
    setVerifyResults((results) => [...results, { word: card.word, correct }]);
    try {
      await sendRuntime({ type: 'VOCABULARY_REVIEW', word: card.lemma || card.word, rating: correct ? 3 : 1 });
      setPlan(await sendRuntime<VocabularyPlan>({ type: 'VOCABULARY_PLAN_GET' }));
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : t("测验结果写入失败。"));
    }
    window.setTimeout(() => {
      const nextIndex = verifyIndex + 1;
      if (nextIndex >= verifyWords.length) {
        setVerifyFinished(true);
        return;
      }
      setVerifyIndex(nextIndex);
      setVerifyAnswered(false);
      void makeVerifyOptions(verifyWords[nextIndex]!, verifyWords).then(setVerifyOptions);
    }, 700);
  }

  // --- Render Views ---

  function renderEmptyStudy() {
    const hasSavedWords = allCards.length > 0 || Boolean(plan?.knownCount);
    return (
      <div className="vocab-empty-state">
        <div className="vocab-empty-icon">{hasSavedWords ? <Icon name="award" /> : <Icon name="compass" />}</div>
        <h2>{hasSavedWords ? t("今天没有到期复习") : t("还没有可背的词")}</h2>
        <p>{hasSavedWords ? t("已保存的词仍在词库中，下一次复习到期后会自动出现在这里。") : t("先在视频字幕或“读懂多少”中保存生词，系统会自动安排科学复习。")}</p>
        <div className="vocab-empty-actions">
          <button className="primary" onClick={() => setActiveTab('assets')}>{t("查看全部资产 (")}{unifiedItems.length})</button>
          <button onClick={() => setActiveTab('verify')}>{t("成果测验")}</button>
        </div>
      </div>
    );
  }

  function renderStudyCard() {
    if (!currentCard) return renderEmptyStudy();
    const dictionary = dictionaryById[currentCard.id];
    const meaning = cardMeaning(currentCard, dictionary);
    const isNew = cardIsNew(currentCard);
    const contextSentence = currentCard.contextText || matchedAssetForCurrentCard?.contextText;
    const canJumpVideo = matchedAssetForCurrentCard && (matchedAssetForCurrentCard.youtubeId || matchedAssetForCurrentCard.videoKey) && matchedAssetForCurrentCard.startMs !== undefined && onOpenAsset;

    return (
      <div className="vocab-card-view">
        <div className="vocab-card-toolbar">
          <div className="vocab-view-switch" role="group" aria-label={t("背词模式")}>
            <button className={viewMode === 'atlas' ? 'active' : ''} onClick={() => handleViewModeChange('atlas')}>
              <Icon name="sparkles" /> {t("词光练习")}</button>
            <button className={viewMode === 'card' ? 'active' : ''} onClick={() => handleViewModeChange('card')}>
              <Icon name="layers" /> {t("逐词闪卡")}</button>
            <button className={viewMode === 'skim' ? 'active' : ''} onClick={() => handleViewModeChange('skim')}>
              <Icon name="zap" /> {t("遮挡速刷")}</button>
          </div>
          <div className="vocab-card-meta">
            <span className={isNew ? 'new' : 'review'}>{isNew ? <><Icon name="star" /> {t("新词")}</> : <><Icon name="repeat" /> {t("复习 · 第")}{currentCard.fsrs.reps + 1}{t("轮")}</>}</span>
            <strong>{Math.min(currentIndex + 1, queue.length)} / {queue.length}</strong>
            <button onClick={() => setAutoPlayAudio((value) => !value)}>{autoPlayAudio ? <><Icon name="volume" /> {t("自动发音开")}</> : <><Icon name="volume-off" /> {t("静音")}</>}</button>
          </div>
        </div>

        <div className={`vocab-study-content ${flipped ? 'is-revealed' : ''}`}>
        <div
          className={`vocab-flashcard ${flipped ? 'flipped' : ''}`}
          aria-label={flipped ? t("单词释义") : t("回忆词义")}
        >
          {!flipped ? (
            <>
              <div className="vocab-card-top-row">
                <small>{formatRank(currentCard.rank)}</small>
                <small>{t("回忆词义")}</small>
              </div>
              <strong>{currentCard.word}</strong>
              <p className="vocab-recall-prompt">{t("先在心里说出它的意思，再查看答案。")}</p>
              {audioHint && currentCard.phonetic && <span>[ {currentCard.phonetic} ]</span>}
              {contextHint && contextSentence && <p className="vocab-card-context">“{contextSentence}”</p>}
              <div className="vocab-recall-hints">
                <button type="button" onClick={() => { setAudioHint(true); void speakWord(currentCard.word, currentCard.id); }}>
                  <Icon name={speakingId === currentCard.id ? 'stop' : 'volume'} /> {audioHint ? t("重听发音提示") : t("听发音提示")}
                </button>
                {contextSentence && <button type="button" onClick={() => setContextHint(value => !value)} aria-expanded={contextHint}>
                  <Icon name="film" /> {contextHint ? t("收起原句提示") : t("看原句提示")}
                </button>}
              </div>
              <button type="button" className="vocab-reveal-answer" onClick={() => setFlipped(true)}>{t("查看答案")}<small>{t("空格 / Enter")}</small></button>
            </>
          ) : (
            <>
              <div className="vocab-card-top-row">
                <small>{t("释义与语境")}</small>
                {canJumpVideo && (
                  <button
                    type="button"
                    className="vocab-video-jump-badge"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenAsset!(matchedAssetForCurrentCard!);
                    }}
                    title={t("跳回原视频复听原声")}
                  >
                    <Icon name="film" /> {t("原片")}{formatTime(matchedAssetForCurrentCard!.startMs!)} <Icon name="external" />
                  </button>
                )}
              </div>
              <strong>{dictionaryLoadingId === currentCard.id ? t("正在查询释义…") : meaning}</strong>
              {contextSentence && <p className="vocab-card-context">“{contextSentence}”</p>}
              {matchedAssetForCurrentCard?.note && <p className="vocab-card-note">{t("备注：")}{matchedAssetForCurrentCard.note}</p>}
              <span>{t("稳定性")}{currentCard.fsrs.stability}{t("d · 难度")}{currentCard.fsrs.difficulty} {t("· 遗忘")}{currentCard.fsrs.lapses} {t("次")}</span>
            </>
          )}
        </div>

        {isWeb && flipped && <WordAtlas word={currentCard.word} />}
        </div>

        {flipped && <div className="vocab-card-actions">
          <button onClick={() => void speakWord(currentCard.word, currentCard.id)}>
            {speakingId === currentCard.id ? <><Icon name="stop" /> {t("停止发音")}</> : <><Icon name="volume" /> {t("听发音")}</>}
          </button>
        </div>}

        {flipped && <>
        <p className="vocab-rating-guidance">{t("按揭晓前的回忆评分")}{audioHint || contextHint ? t("；用过提示，建议选择“困难”或“重来”") : ''}。</p>
        <div className="vocab-rating-bar">
          <button className="again" disabled={busy} onClick={() => void handleRating(1)}>
            <b>1</b>
            <strong>{t("没想起来")}</strong>
            <small>{t("需要重新学习")}</small>
          </button>
          <button className="hard" disabled={busy} onClick={() => void handleRating(2)}>
            <b>2</b>
            <strong>{t("费力想起")}</strong>
            <small>{t("犹豫或借助提示")}</small>
          </button>
          <button className="good" disabled={busy} onClick={() => void handleRating(3)}>
            <b>3</b>
            <strong>{t("想起来了")}</strong>
            <small>{t("独立回忆正确")}</small>
          </button>
          <button className="easy" disabled={busy} onClick={() => void handleRating(4)}>
            <b>4</b>
            <strong>{t("很轻松")}</strong>
            <small>{t("迅速且准确")}</small>
          </button>
        </div>
        </>}
      </div>
    );
  }

  function renderStudyAtlas() {
    if (!queue.length) return renderEmptyStudy();

    return (
      <div className="vocab-atlas-view">
        <div className="vocab-card-toolbar">
          <div className="vocab-view-switch" role="group" aria-label={t("背词模式")}>
            <button className={viewMode === 'atlas' ? 'active' : ''} onClick={() => handleViewModeChange('atlas')}>
              <Icon name="sparkles" /> {t("词光练习")}</button>
            <button className={viewMode === 'card' ? 'active' : ''} onClick={() => handleViewModeChange('card')}>
              <Icon name="layers" /> {t("逐词闪卡")}</button>
            <button className={viewMode === 'skim' ? 'active' : ''} onClick={() => handleViewModeChange('skim')}>
              <Icon name="zap" /> {t("遮挡速刷")}</button>
          </div>
          <div className="vocab-card-meta">
            <span><Icon name="repeat" /> {t("待学")}{queue.length} {t("词")}</span>
          </div>
        </div>
        <AtlasStudy queue={queue} allCards={allCards} sendRuntime={sendRuntime} onReviewed={() => loadPlanAndCards(false)} />
      </div>
    );
  }

  function renderStudySkim() {
    if (!queue.length) return renderEmptyStudy();

    return (
      <div className="vocab-skim-view">
        <div className="vocab-card-toolbar">
          <div className="vocab-view-switch" role="group" aria-label={t("背词模式")}>
            <button className={viewMode === 'atlas' ? 'active' : ''} onClick={() => handleViewModeChange('atlas')}>
              <Icon name="sparkles" /> {t("词光练习")}</button>
            <button className={viewMode === 'card' ? 'active' : ''} onClick={() => handleViewModeChange('card')}>
              <Icon name="layers" /> {t("逐词闪卡")}</button>
            <button className={viewMode === 'skim' ? 'active' : ''} onClick={() => handleViewModeChange('skim')}>
              <Icon name="zap" /> {t("遮挡速刷")}</button>
          </div>
          <div className="vocab-card-meta">
            <button onClick={() => setSkimMaskAll((v) => !v)}>
              {skimMaskAll ? <><Icon name="eye" /> {t("显示全部释义")}</> : <><Icon name="eye-off" /> {t("遮挡全部释义")}</>}
            </button>
            <button className="primary" onClick={() => handleViewModeChange('card')}>
              <Icon name="play" /> {t("进入闪卡")}</button>
          </div>
        </div>

        <div className="vocab-list-summary">
          <strong>{t("今日待学清单")}{queue.length} {t("词")}</strong>
          <span><Icon name="star" /> {t("新词")}{queue.filter(cardIsNew).length} · <Icon name="repeat" /> {t("复习")}{queue.filter((card) => !cardIsNew(card)).length} {t("· 已完成")}{Math.min(currentIndex, queue.length)}</span>
        </div>

        <div className="vocab-skim-list">
          {queue.map((card, index) => {
            const matchedAsset = assetsByNormKey.get(normalizeWordKey(card.lemma || card.word));
            const meaning = cardMeaning(card, dictionaryById[card.id]);
            const isMasked = skimMaskAll && !skimRevealedMap[card.id];
            const isLearned = index < currentIndex;
            const isCurrent = index === currentIndex;

            return (
              <div
                key={`${card.id}-${index}`}
                className={`vocab-skim-row ${isLearned ? 'learned' : ''} ${isCurrent ? 'current' : ''}`}
              >
                <div className="vocab-skim-left">
                  <small className="vocab-skim-num">#{index + 1}</small>
                  <div className="vocab-skim-word-block">
                    <strong>{card.word}</strong>
                    {card.phonetic && <small className="vocab-skim-phonetic">[{card.phonetic}]</small>}
                    <span className="vocab-skim-rank">{formatRank(card.rank)}</span>
                  </div>
                </div>

                <div
                  className={`vocab-skim-meaning ${isMasked ? 'masked' : 'revealed'}`}
                  onClick={() => setSkimRevealedMap((prev) => ({ ...prev, [card.id]: !prev[card.id] }))}
                  title={isMasked ? t("点击揭示释义") : t("点击遮挡释义")}
                >
                  <span className="vocab-skim-meaning-text">{meaning}</span>
                  {!isMasked && card.contextText && <small className="vocab-skim-context">“{card.contextText}”</small>}
                </div>

                <div className="vocab-skim-actions">
                  <button
                    className="vocab-mini-btn"
                    title={t("发音")}
                    onClick={() => void speakWord(card.word, card.id)}
                  >
                    {speakingId === card.id ? <Icon name="stop" /> : <Icon name="volume" />}
                  </button>
                  {matchedAsset && (matchedAsset.youtubeId || matchedAsset.videoKey) && matchedAsset.startMs !== undefined && onOpenAsset && (
                    <button
                      className="vocab-mini-btn video"
                      title={t("原视频回跳")}
                      onClick={() => onOpenAsset(matchedAsset)}
                    >
                      <Icon name="film" />
                    </button>
                  )}
                  <button
                    className="vocab-mini-btn rate-good"
                    title={t("记住了 (良好)")}
                    disabled={busy || isMasked}
                    onClick={() => void handleRating(3, card)}
                  >
                    <Icon name="check" /> {t("良好")}</button>
                  <button
                    className="vocab-mini-btn rate-easy"
                    title={t("已掌握 (熟知)")}
                    disabled={busy || isMasked}
                    onClick={() => void handleRating(4, card)}
                  >
                    <Icon name="star" /> {t("掌握")}</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderAssetsList() {
    return (
      <div className="vocab-assets-view">
        {/* Filters and search toolbar */}
        <div className="vocab-assets-toolbar">
          <div className="vocab-filter-group">
            <span className="vocab-filter-label">{t("类型:")}</span>
            <div className="vocab-pill-switch">
              {(['all', 'word', 'phrase', 'pattern'] as KindFilter[]).map((kind) => (
                <button
                  key={kind}
                  className={kindFilter === kind ? 'active' : ''}
                  onClick={() => setKindFilter(kind)}
                >
                  {kind === 'all' ? t("全部") : ASSET_KIND_LABELS[kind]}
                </button>
              ))}
            </div>
          </div>

          <div className="vocab-filter-group">
            <span className="vocab-filter-label">{t("状态:")}</span>
            <div className="vocab-pill-switch">
              {([
                { id: 'all', label: t("全部") },
                { id: 'due', label: t("待复习") },
                { id: 'learning', label: t("学习中") },
                { id: 'new', label: t("新词") },
                { id: 'known', label: t("已掌握") },
              ] as Array<{ id: StatusFilter; label: string }>).map((st) => (
                <button
                  key={st.id}
                  className={statusFilter === st.id ? 'active' : ''}
                  onClick={() => setStatusFilter(st.id)}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>

          <div className="vocab-search-wrap">
            <input
              type="text"
              placeholder={t("搜索资产文本、释义、例句或备注...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label={t("搜索资产")}
            />
            {searchQuery && (
              <button className="vocab-search-clear" aria-label={t("清空搜索")} onClick={() => setSearchQuery('')}><Icon name="close" /></button>
            )}
          </div>
        </div>

        {/* Counter strip + Layout Toggle */}
        <div className="vocab-list-summary">
          <div className="vocab-summary-left">
            <strong>{t("资产库 (")}{filteredUnifiedItems.length} / {unifiedItems.length} {t("条)")}</strong>
            <span>
              {t("单词")}{unifiedItems.filter((i) => i.kind === 'word').length} {t("· 短语")}{unifiedItems.filter((i) => i.kind === 'phrase').length} {t("· 句式")}{unifiedItems.filter((i) => i.kind === 'pattern').length} {t("· 已掌握")}{unifiedItems.filter((i) => i.card?.status === 'known').length}
            </span>
          </div>
          <div className="vocab-layout-toggle" role="group" aria-label={t("展示布局")}>
            <button
              className={assetLayout === 'grid' ? 'active' : ''}
              onClick={() => handleLayoutChange('grid')}
              title={t("网格卡片布局")}
            >
              <Icon name="layers" /> {t("卡片")}</button>
            <button
              className={assetLayout === 'list' ? 'active' : ''}
              onClick={() => handleLayoutChange('list')}
              title={t("紧凑列表布局")}
            >
              <Icon name="clipboard" /> {t("列表")}</button>
          </div>
        </div>

        {/* Item Cards / Rows */}
        {!filteredUnifiedItems.length ? (
          <div className="vocab-filter-empty">
            <p>{t("没有匹配的学习资产。")}</p>
            {searchQuery && <button onClick={() => setSearchQuery('')}>{t("清空搜索")}</button>}
          </div>
        ) : assetLayout === 'grid' ? (
          <div className="vocab-assets-grid">
            {filteredUnifiedItems.map((item) => {
              const isEditing = editingItemId === item.id;
              const memStatus = getItemMemoryStatus(item);
              const canJumpVideo = Boolean(
                item.asset && (item.asset.youtubeId || item.asset.videoKey) && item.asset.startMs !== undefined && onOpenAsset
              );

              return (
                <article key={item.id} className={`vocab-asset-card ${isEditing ? 'editing' : ''}`}>
                  <div className="vocab-asset-card-top">
                    <div className="vocab-asset-badges">
                      <span className={`vocab-badge kind ${item.kind}`}>{ASSET_KIND_LABELS[item.kind]}</span>
                      {memStatus !== 'none' && (
                        <span className={`vocab-badge mem-status ${memStatus}`}>
                          {memStatus === 'due' ? <><Icon name="repeat" /> {t("待复习")}</> : memStatus === 'known' ? <><Icon name="check" /> {t("已掌握")}</> : memStatus === 'new' ? <><Icon name="star" /> {t("新词")}</> : <><Icon name="hourglass" /> {t("记忆中 ·")}{item.card?.fsrs.stability ? Math.round(item.card.fsrs.stability) + 'd' : (item.card?.fsrs.reps || 1) + t("轮")}</>}
                        </span>
                      )}
                      {item.rank != null && <span className="vocab-asset-rank">{formatRank(item.rank)}</span>}
                    </div>
                    {item.syncStatus && (
                      <span className="vocab-asset-sync">{item.syncStatus === 'synced' ? <><Icon name="cloud" /> {t("已同步")}</> : item.syncStatus === 'failed' ? <><Icon name="warning" /> {t("失败")}</> : t("待同步")}</span>
                    )}
                  </div>

                  {isEditing ? (
                    <div className="vocab-asset-edit-box">
                      <input
                        value={editingDisplayValue}
                        maxLength={500}
                        onChange={(e) => setEditingDisplayValue(e.target.value)}
                        aria-label={t("资产文本")}
                      />
                      {item.kind === 'pattern' && <small className="slot-help">{t("用 [slot] 标记可替换内容")}</small>}
                      <textarea
                        value={editingNote}
                        maxLength={2000}
                        placeholder={t("备注（可选）")}
                        onChange={(e) => setEditingNote(e.target.value)}
                      />
                    </div>
                  ) : (
                    <div className="vocab-asset-card-body">
                      <div className="vocab-asset-term-line">
                        <strong className="vocab-asset-word">{item.displayValue}</strong>
                        {(item.phonetic || item.partOfSpeech) && (
                          <span className="vocab-asset-pron">
                            {[item.phonetic ? `[${item.phonetic}]` : '', item.partOfSpeech].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </div>
                      {item.meaningZh && (
                        <p className="vocab-asset-meaning" title={item.meaningZh}>
                          {item.meaningZh}
                        </p>
                      )}
                      {item.contextText && (
                        <p className="vocab-asset-context" title={item.contextText}>
                          “{item.contextText}”
                        </p>
                      )}
                      {item.note && (
                        <p className="vocab-asset-note">
                          <Icon name="lightbulb" /> {item.note}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="vocab-asset-card-footer">
                    {isEditing ? (
                      <div className="vocab-asset-edit-actions">
                        <button
                          className="primary"
                          disabled={savingEdit || !editingDisplayValue.trim()}
                          onClick={() => void handleSaveEdit(item)}
                        >
                          {savingEdit ? t("保存中…") : t("保存")}
                        </button>
                        <button onClick={() => setEditingItemId(null)}>{t("取消")}</button>
                      </div>
                    ) : (
                      <>
                        <div className="vocab-card-btn-group">
                          <button
                            className="vocab-action-btn icon"
                            title={t("发音")}
                            onClick={() => void speakWord(item.displayValue, item.id)}
                          >
                            {speakingId === item.id ? <Icon name="stop" /> : <Icon name="volume" />}
                          </button>
                          {canJumpVideo && (
                            <button
                              className="vocab-action-btn video"
                              title={t("跳回原视频对应时间点")}
                              onClick={() => onOpenAsset!(item.asset!)}
                            >
                              <Icon name="film" /> {formatTime(item.asset!.startMs!)}
                            </button>
                          )}
                          {item.kind === 'word' && (
                            <button
                              className={`vocab-action-btn ${item.card?.status === 'known' ? 'btn-known' : ''}`}
                              title={item.card?.status === 'known' ? t("已掌握（点击重新学习）") : t("标记为已掌握（后续不再在字幕中高亮）")}
                              disabled={busy}
                              onClick={() => void handleToggleKnown(item)}
                            >
                              {item.card?.status === 'known' ? <><Icon name="check" /> {t("已掌握")}</> : t("标为掌握")}
                            </button>
                          )}
                        </div>
                        <div className="vocab-card-link-group">
                          {item.asset && (
                            <button
                              className="vocab-link-btn"
                              title={t("编辑资产")}
                              onClick={() => startEdit(item)}
                            >
                              {t("编辑")}</button>
                          )}
                          <button
                            className="vocab-link-btn delete"
                            title={t("删除资产")}
                            disabled={busy}
                            onClick={() => void handleDeleteItem(item)}
                          >
                            {t("删除")}</button>
                        </div>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="vocab-assets-list-view">
            {filteredUnifiedItems.map((item) => {
              const isEditing = editingItemId === item.id;
              const memStatus = getItemMemoryStatus(item);
              const canJumpVideo = Boolean(
                item.asset && (item.asset.youtubeId || item.asset.videoKey) && item.asset.startMs !== undefined && onOpenAsset
              );

              return (
                <article key={item.id} className={`vocab-asset-row ${isEditing ? 'editing' : ''}`}>
                  {isEditing ? (
                    <div className="vocab-asset-row-editing">
                      <div className="vocab-asset-edit-box">
                        <input
                          value={editingDisplayValue}
                          maxLength={500}
                          onChange={(e) => setEditingDisplayValue(e.target.value)}
                          aria-label={t("资产文本")}
                        />
                        {item.kind === 'pattern' && <small className="slot-help">{t("用 [slot] 标记可替换内容")}</small>}
                        <textarea
                          value={editingNote}
                          maxLength={2000}
                          placeholder={t("备注（可选）")}
                          onChange={(e) => setEditingNote(e.target.value)}
                        />
                      </div>
                      <div className="vocab-asset-edit-actions">
                        <button
                          className="primary"
                          disabled={savingEdit || !editingDisplayValue.trim()}
                          onClick={() => void handleSaveEdit(item)}
                        >
                          {savingEdit ? t("保存中…") : t("保存")}
                        </button>
                        <button onClick={() => setEditingItemId(null)}>{t("取消")}</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="vocab-row-col term-col">
                        <div className="vocab-row-term-badges">
                          <span className={`vocab-badge kind ${item.kind}`}>{ASSET_KIND_LABELS[item.kind]}</span>
                          {memStatus !== 'none' && (
                            <span className={`vocab-badge mem-status ${memStatus}`}>
                              {memStatus === 'due' ? t("待复习") : memStatus === 'known' ? t("已掌握") : memStatus === 'new' ? t("新词") : t("记忆中")}
                            </span>
                          )}
                          {item.rank != null && <span className="vocab-asset-rank">{formatRank(item.rank)}</span>}
                        </div>
                        <div className="vocab-row-term-main">
                          <strong className="vocab-asset-word">{item.displayValue}</strong>
                          {(item.phonetic || item.partOfSpeech) && (
                            <span className="vocab-asset-pron">
                              {[item.phonetic ? `[${item.phonetic}]` : '', item.partOfSpeech].filter(Boolean).join(' ')}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="vocab-row-col meaning-col">
                        {item.meaningZh ? (
                          <p className="vocab-asset-meaning" title={item.meaningZh}>{item.meaningZh}</p>
                        ) : (
                          <span className="vocab-row-empty-text">{t("（暂无释义）")}</span>
                        )}
                      </div>

                      <div className="vocab-row-col context-col">
                        {item.contextText ? (
                          <p className="vocab-asset-context" title={item.contextText}>“{item.contextText}”</p>
                        ) : item.note ? (
                          <p className="vocab-asset-note"><Icon name="lightbulb" /> {item.note}</p>
                        ) : (
                          <span className="vocab-row-empty-text">{t("（无例句上下文）")}</span>
                        )}
                      </div>

                      <div className="vocab-row-col actions-col">
                        {item.syncStatus && (
                          <span className="vocab-asset-sync">{item.syncStatus === 'synced' ? <><Icon name="cloud" /> {t("已同步")}</> : item.syncStatus === 'failed' ? <><Icon name="warning" /> {t("失败")}</> : t("待同步")}</span>
                        )}
                        <div className="vocab-row-actions">
                          <button
                            className="vocab-action-btn icon"
                            title={t("发音")}
                            onClick={() => void speakWord(item.displayValue, item.id)}
                          >
                            {speakingId === item.id ? <Icon name="stop" /> : <Icon name="volume" />}
                          </button>
                          {canJumpVideo && (
                            <button
                              className="vocab-action-btn video"
                              title={t("跳回原视频时间点")}
                              onClick={() => onOpenAsset!(item.asset!)}
                            >
                              <Icon name="film" /> {formatTime(item.asset!.startMs!)}
                            </button>
                          )}
                          {item.kind === 'word' && (
                            <button
                              className={`vocab-action-btn ${item.card?.status === 'known' ? 'btn-known' : ''}`}
                              title={item.card?.status === 'known' ? t("已掌握（点击重新学习）") : t("标记为已掌握")}
                              disabled={busy}
                              onClick={() => void handleToggleKnown(item)}
                            >
                              {item.card?.status === 'known' ? <Icon name="check" /> : t("掌握")}
                            </button>
                          )}
                          {item.asset && (
                            <button
                              className="vocab-link-btn"
                              title={t("编辑资产")}
                              onClick={() => startEdit(item)}
                            >
                              {t("编辑")}</button>
                          )}
                          <button
                            className="vocab-link-btn delete"
                            title={t("删除资产")}
                            disabled={busy}
                            onClick={() => void handleDeleteItem(item)}
                          >
                            {t("删除")}</button>
                        </div>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function renderMastered() {
    const normalizedQuery = masteredQuery.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
    const masteredCards = allCards
      .filter((card) => card.status === 'known')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const visibleCards = normalizedQuery
      ? masteredCards.filter((card) => [card.word, card.lemma, card.translation].some((val) => val?.toLowerCase().includes(normalizedQuery)))
      : masteredCards;

    return (
      <div className="vocab-mastered-view">
        <div className="vocab-mastered-toolbar">
          <div>
            <strong>{t("已掌握")}{masteredCards.length} {t("词")}</strong>
            <span>{t("这些词不会再在视频字幕和阅读器中作为超纲生词高亮。")}</span>
          </div>
          <input
            aria-label={t("搜索已掌握单词")}
            placeholder={t("搜索单词、原形或释义")}
            value={masteredQuery}
            onChange={(e) => setMasteredQuery(e.target.value)}
          />
        </div>

        {!visibleCards.length ? (
          <div className="vocab-filter-empty">
            <p>{masteredCards.length ? t("没有匹配的已掌握单词。") : t("还没有已掌握的单词。在背词卡片中选择“熟知”或在资产中点击“标为掌握”即可掌握。")}</p>
          </div>
        ) : (
          <div className="vocab-mastered-list" role="list">
            {visibleCards.map((card) => (
              <article key={card.id} className="vocab-mastered-row" role="listitem">
                <div>
                  <strong>{card.word}</strong>
                  {card.lemma !== card.word && <small>{t("原形")}{card.lemma}</small>}
                  {card.rank && <small>{formatRank(card.rank)}</small>}
                </div>
                <span>{card.translation || t("暂无释义")}</span>
                <div className="vocab-mastered-row-actions">
                  <time dateTime={new Date(card.updatedAt).toISOString()}>
                    {t("掌握于")}{formatDate(card.updatedAt)}
                  </time>
                  <button
                    className="vocab-mini-btn"
                    title={t("重回复习队列")}
                    onClick={() => void handleToggleKnown({ id: card.id, kind: 'word', displayValue: card.word, lemma: card.lemma, card })}
                  >
                    {t("重学")}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderVerify() {
    if (verifyLoading) return <div className="vocab-empty-state"><div className="vocab-loading">{t("正在准备测验…")}</div></div>;
    if (verifyWords.length < 4) {
      return (
        <div className="vocab-empty-state">
          <div className="vocab-empty-icon"><Icon name="book" /></div>
          <h2>{t("可测词汇不足")}</h2>
          <p>{t("至少保存 4 个单词后，才能进行四选一成果测验。")}</p>
          <button className="primary" onClick={() => setActiveTab('assets')}>{t("去查看资产库")}</button>
        </div>
      );
    }
    if (verifyFinished) {
      const total = verifyResults.length;
      const correct = verifyResults.filter((result) => result.correct).length;
      return (
        <div className="vocab-verify-summary">
          <div className="vocab-empty-icon"><Icon name="target" /></div>
          <h2>{total ? Math.round(correct / total * 100) : 0}% <small>{t("正确率")}</small></h2>
          <p>{t("答对")}{correct} {t("题，错误")}{total - correct} {t("题。答对的词已记入良好复习，失误词已自动重新安排到近期队列。")}</p>
          <div className="vocab-verify-results">
            {verifyResults.map((result) => (
              <div key={`${result.word}-${result.correct ? 'ok' : 'bad'}`} className={result.correct ? 'ok' : 'bad'}>
                <strong>{result.word}</strong>
                <span>{result.correct ? <><Icon name="check" /> {t("记忆扎实")}</> : <><Icon name="close" /> {t("已重回复习队列")}</>}</span>
              </div>
            ))}
          </div>
          <button className="primary" onClick={() => void initializeVerify()}>{t("再测一组")}</button>
        </div>
      );
    }
    const card = verifyWords[verifyIndex]!;
    return (
      <div className="vocab-verify-view">
        <div className="vocab-verify-top">
          <span><Icon name="target" /> {t("成果检验测验")}</span>
          <strong>{t("第")}{verifyIndex + 1} / {verifyWords.length} {t("题")}</strong>
        </div>
        <div className="vocab-verify-word">
          <strong>{card.word}</strong>
          {card.phonetic && <span>[ {card.phonetic} ]</span>}
          <button onClick={() => void speakWord(card.word, card.id)}>
            {speakingId === card.id ? <Icon name="stop" /> : <Icon name="volume" />}
          </button>
        </div>
        <div className="vocab-options">
          {verifyOptions.map((option, index) => (
            <button
              key={`${option.text}-${index}`}
              disabled={verifyAnswered}
              className={verifyAnswered ? (option.correct ? 'correct' : 'disabled') : ''}
              onClick={() => void handleVerifyAnswer(option)}
            >
              <b>{String.fromCharCode(65 + index)}</b>
              <span>{option.text}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderStudyFinished() {
    return (
      <div className="vocab-study-finished">
        <div className="vocab-empty-icon"><Icon name="award" /></div>
        <h2>{t("今日复习达成！")}</h2>
        <p>{t("本轮卡片已全部完成，FSRS 算法已精准安排下一次唤醒间隔；达到掌握状态的词已自动取消超纲高亮。")}</p>
        <div className="vocab-empty-actions">
          <button className="primary" onClick={() => setActiveTab('assets')}>{t("浏览全部资产 (")}{unifiedItems.length})</button>
          <button onClick={() => setActiveTab('verify')}>{t("做成果测验")}</button>
        </div>
      </div>
    );
  }

  if (isWeb) return <section className="vocabulary-study-page" aria-label={t("词汇本与我的生词本")}><VocabularyWordbooks vocabularySize={vocabularySize} allCards={allCards} sendRuntime={sendRuntime} onReviewed={() => loadPlanAndCards(false)} personalLibrary={renderAssetsList()} /></section>;

  const planTitle = plan?.dueCount ? t("待复习 {0}", plan.dueCount) : plan?.todayNewCount ? t("今日新词 {0}", plan.todayNewCount) : t("暂无到期任务");
  const goalSummary = plan?.hasGoal
    ? t("目标 {0} 词 · 剩余 {1} 天 · 每日新词 {2}", plan.targetVocab.toLocaleString(), plan.daysRemaining, plan.dailyNewTarget)
    : t("未设定目标 · 默认每天安排 25 个新词");

  return (
    <section className="vocabulary-study-page" aria-label={t("词库与复习")}>
      {/* Header */}
      <div className="vocab-study-header">
        <div className="vocab-study-header-title">
          <span className="vocab-study-kicker">
            <Icon name="brain" /> {t("SPACED REPETITION · 科学记忆与词库")}</span>
          <h2>
            {activeTab === 'assets' ? t("全部资产清单") : activeTab === 'mastered' ? t("已掌握词库") : activeTab === 'verify' ? t("成果检验测验") : t("今日复习计划")}
            <span className="vocab-header-count-pill">{activeTab === 'assets' ? t("共 {0} 条", unifiedItems.length) : planTitle}</span>
          </h2>
        </div>

        <div className="vocab-study-header-actions">
          <button
            type="button"
            className="vocab-study-goal-btn"
            onClick={() => setGoalOpen(true)}
            title={t("设定或调整背词目标")}
          >
            <Icon name="target" /> {plan?.hasGoal ? t("调整目标") : t("设定目标")}
          </button>
          <div className="vocab-header-nav-pills" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'study'}
              className={activeTab === 'study' ? 'active' : ''}
              onClick={() => setActiveTab('study')}
            >
              <Icon name="brain" /> {t("今日背词")}</button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'assets'}
              className={activeTab === 'assets' ? 'active' : ''}
              onClick={() => setActiveTab('assets')}
            >
              <Icon name="clipboard" /> {t("资产清单")}</button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'mastered'}
              className={activeTab === 'mastered' ? 'active' : ''}
              onClick={() => setActiveTab('mastered')}
            >
              <Icon name="check" /> {t("已掌握 (")}{allCards.filter((c) => c.status === 'known').length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'verify'}
              className={activeTab === 'verify' ? 'active' : ''}
              onClick={() => setActiveTab('verify')}
            >
              <Icon name="target" /> {t("测验")}</button>
          </div>
        </div>
      </div>

      {/* Plan Bento Grid Banner */}
      {(!isWeb || activeTab !== 'study') && <div className="vocab-plan-bento">
        <div className="vocab-bento-cards">
          <button
            type="button"
            className={`vocab-bento-card due ${activeTab === 'study' && viewMode === 'card' ? 'is-active' : ''}`}
            onClick={() => { setActiveTab('study'); }}
            title={t("查看待复习任务")}
          >
            <div className="vocab-bento-top">
              <span className="vocab-bento-icon"><Icon name="repeat" /></span>
              <span className="vocab-bento-pill">{t("到期复习")}</span>
            </div>
            <strong className="vocab-bento-value">{plan?.dueCount || 0}</strong>
            <span className="vocab-bento-label">{t("待复习单词")}</span>
          </button>

          <button
            type="button"
            className={`vocab-bento-card new ${activeTab === 'study' && viewMode === 'atlas' ? 'is-active' : ''}`}
            onClick={() => { setActiveTab('study'); }}
            title={t("学习今日新词")}
          >
            <div className="vocab-bento-top">
              <span className="vocab-bento-icon"><Icon name="star" /></span>
              <span className="vocab-bento-pill">{t("今日新词")}</span>
            </div>
            <strong className="vocab-bento-value">{plan?.todayNewCount || 0}</strong>
            <span className="vocab-bento-label">{t("今日新学配额")}</span>
          </button>

          <button
            type="button"
            className={`vocab-bento-card known ${activeTab === 'mastered' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('mastered')}
            title={t("查看已掌握词库")}
          >
            <div className="vocab-bento-top">
              <span className="vocab-bento-icon"><Icon name="check" /></span>
              <span className="vocab-bento-pill">{t("完全掌握")}</span>
            </div>
            <strong className="vocab-bento-value">{allCards.filter((c) => c.status === 'known').length}</strong>
            <span className="vocab-bento-label">{t("已掌握词汇")}</span>
          </button>

          <button
            type="button"
            className={`vocab-bento-card total ${activeTab === 'assets' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('assets')}
            title={t("浏览全部语料资产")}
          >
            <div className="vocab-bento-top">
              <span className="vocab-bento-icon"><Icon name="clipboard" /></span>
              <span className="vocab-bento-pill">{t("语料沉淀")}</span>
            </div>
            <strong className="vocab-bento-value">{unifiedItems.length}</strong>
            <span className="vocab-bento-label">{t("词库总资产")}</span>
          </button>
        </div>

        <div className="vocab-bento-footer">
          <div className="vocab-bento-goal-info">
            <Icon name="target" />
            <span>{goalSummary} {t("· 生词池")}<b>{plan?.newPoolCount || 0}</b> {t("词")}</span>
          </div>
          <button
            type="button"
            className="vocab-bento-goal-action"
            onClick={() => setGoalOpen(true)}
            title={t("设定或调整背词目标")}
          >
            <Icon name="edit" /> {plan?.hasGoal ? t("调整学习目标") : t("设定背词目标")}
          </button>
        </div>
      </div>

      }
      {/* Main Content Body */}
      {loading ? (
        <div className="vocab-empty-state"><div className="vocab-loading">{t("正在读取词库与计划…")}</div></div>
      ) : activeTab === 'verify' ? (
        renderVerify()
      ) : activeTab === 'mastered' ? (
        renderMastered()
      ) : activeTab === 'assets' ? (
        renderAssetsList()
      ) : isWeb ? (
        <VocabularyWordbooks vocabularySize={vocabularySize} allCards={allCards} sendRuntime={sendRuntime} onReviewed={() => loadPlanAndCards(false)} />
      ) : sessionFinished ? (
        renderStudyFinished()
      ) : viewMode === 'atlas' ? (
        renderStudyAtlas()
      ) : viewMode === 'skim' ? (
        renderStudySkim()
      ) : (
        renderStudyCard()
      )}

      {/* Goal Modal */}
      {goalOpen && (
        <div
          className="vocab-modal-backdrop"
          role="presentation"
          onClick={(e) => { if (e.target === e.currentTarget) setGoalOpen(false); }}
        >
          <div className="vocab-goal-modal" role="dialog" aria-modal="true" aria-label={t("设定背词目标")}>
            <header>
              <h3><Icon name="target" /> {t("设定科学背词目标")}</h3>
              <button onClick={() => setGoalOpen(false)} aria-label={t("关闭")}><Icon name="close" /></button>
            </header>
            <div className="vocab-goal-body">
              <label>
                {t("目标词汇量（词）")}<div className="vocab-goal-presets">
                  {['3000', '5000', '8000', '12000'].map((val) => (
                    <button
                      key={val}
                      type="button"
                      className={goalVocab === val ? 'active' : ''}
                      onClick={() => setGoalVocab(val)}
                    >
                      {Number(val).toLocaleString()} {t("词")}</button>
                  ))}
                </div>
                <input
                  type="number"
                  min="1000"
                  max="15000"
                  step="500"
                  value={goalVocab}
                  onChange={(e) => setGoalVocab(e.target.value)}
                  placeholder={t("自定义目标词汇量")}
                />
              </label>

              <label>
                {t("计划完成周期（天）")}<div className="vocab-goal-presets">
                  {['30', '60', '90', '180'].map((val) => (
                    <button
                      key={val}
                      type="button"
                      className={goalDays === val ? 'active' : ''}
                      onClick={() => setGoalDays(val)}
                    >
                      {val} {t("天")}</button>
                  ))}
                </div>
                <input
                  type="number"
                  min="7"
                  max="365"
                  value={goalDays}
                  onChange={(e) => setGoalDays(e.target.value)}
                  placeholder={t("自定义天数")}
                />
              </label>

              <div className="vocab-goal-calc-hint">
                <Icon name="sparkles" />
                <span>
                  {t("预计每日需安排新词约")}<b>{Math.max(5, Math.ceil((Math.max(0, Number(goalVocab) - allCards.length) || 1000) / (Number(goalDays) || 60)))}</b> {t("词。根据 FSRS 艾宾浩斯间隔算法，复习任务将随记忆巩固自适应调整。")}</span>
              </div>
            </div>
            <footer>
              <button type="button" onClick={() => setGoalOpen(false)}>{t("取消")}</button>
              <button type="button" className="primary" onClick={() => void saveGoal()}>{t("保存目标")}</button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
