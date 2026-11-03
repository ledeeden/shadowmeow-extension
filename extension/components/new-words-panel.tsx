import { t } from '../lib/i18n';
import { Icon } from './icon';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DictionaryResult,
  PageState,
  RuntimeMessage,
  SavedItemInput,
  UserSettings,
  VocabularyCard,
} from '@shadow-language/contracts';
import { normalizeDictionaryQuery, videoKeyOf, randomId } from '@shadow-language/contracts';
import { runtimeTransportError, unwrapRuntimeResponse } from '../lib/runtime-errors';
import { analyzeVocabularyText, newVocabularyLemmas } from '../lib/vocabulary-profile';
import { db } from '../lib/db';
import { mediaVocabularyWordInput } from '../lib/vocabulary';
import { speakEnglish } from '../lib/speech';
import { ExpressionBundleEditor } from './expression-bundle-editor';
import {
  analyzeCorpusExpressions,
  readCachedExpressionAnalysis,
  toExpressionBundleInput,
  type ExtractedExpression,
} from '../lib/agent/expression-analysis';

export type WordLearningStatus = 'unadded' | 'due' | 'learning' | 'known';

export type NewWordEntry = {
  lemma: string;
  translation: string | null;
  shortZh?: string | null;
  status: 'pending' | 'found' | 'missing' | 'unavailable';
  learningStatus: WordLearningStatus;
  cue?: { text: string; startMs: number; endMs: number } | undefined;
};

export type NewWordsState = {
  entries: NewWordEntry[];
  loading: boolean;
  error: string;
  refresh: () => void;
  dueCount: number;
  unaddedCount: number;
  saveWord: (entry: NewWordEntry) => Promise<void>;
  saveAllWords: () => Promise<void>;
};

const TRANSLATION_BATCH_SIZE = 12;

async function sendRuntime<T>(message: RuntimeMessage): Promise<T> {
  try {
    return unwrapRuntimeResponse(await browser.runtime.sendMessage(message));
  } catch (error) {
    throw runtimeTransportError(error);
  }
}

function dictionaryResultKey(result: DictionaryResult): string {
  return normalizeDictionaryQuery(result.query).toLowerCase();
}

export function newWordsPageSignature(page?: PageState): string {
  if (!page) return 'no-page';
  const firstCue = page.cues[0];
  const lastCue = page.cues.at(-1);
  return JSON.stringify([
    videoKeyOf(page),
    page.activeTrackId || '',
    page.cues.length,
    firstCue?.startMs || 0,
    firstCue?.text || '',
    lastCue?.endMs || 0,
    lastCue?.text || '',
    page.error || '',
  ]);
}

function computeLearningStatus(card?: VocabularyCard): WordLearningStatus {
  if (!card) return 'unadded';
  if (card.status === 'known') return 'known';
  if (card.due && card.due <= Date.now()) return 'due';
  return 'learning';
}

export function useNewWords(page?: PageState): NewWordsState {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [entries, setEntries] = useState<NewWordEntry[]>([]);
  const [cardsMap, setCardsMap] = useState<Map<string, VocabularyCard>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const requestId = useRef(0);
  const pageSignature = useMemo(() => newWordsPageSignature(page), [page]);

  const refresh = useCallback(() => setRefreshGeneration((value) => value + 1), []);

  const loadCards = useCallback(async () => {
    try {
      const cards = await db.vocabulary.toArray();
      const map = new Map<string, VocabularyCard>();
      for (const card of cards) {
        map.set(card.word.toLowerCase(), card);
        if (card.lemma) map.set(card.lemma.toLowerCase(), card);
      }
      setCardsMap(map);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const loadSettings = async () => {
      try {
        const next = await sendRuntime<UserSettings>({ type: 'SETTINGS_GET' });
        if (!disposed) setSettings(next);
      } catch (loadError) {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    };

    const onRuntimeMessage = (message: RuntimeMessage) => {
      if (message.type === 'AUTH_CHANGED' && message.settings) {
        setSettings(message.settings);
        return;
      }
      if (message.type === 'VOCABULARY_CHANGED') {
        void loadCards();
        void loadSettings();
      }
    };

    void loadSettings();
    void loadCards();

    browser.runtime.onMessage.addListener(onRuntimeMessage);
    return () => {
      disposed = true;
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
    };
  }, [loadCards]);

  useEffect(() => {
    const currentRequestId = ++requestId.current;
    setError('');
    if (!settings) {
      setLoading(true);
      return () => {
        if (requestId.current === currentRequestId) requestId.current += 1;
      };
    }
    if (!page || !videoKeyOf(page)) {
      setEntries([]);
      setLoading(false);
      return () => {
        if (requestId.current === currentRequestId) requestId.current += 1;
      };
    }
    if (!page.cues.length) {
      setEntries([]);
      setLoading(false);
      setError(page.error || t("当前页面还没有英文字幕"));
      return () => {
        if (requestId.current === currentRequestId) requestId.current += 1;
      };
    }

    const lemmas = newVocabularyLemmas(
      analyzeVocabularyText(page.cues.map((cue) => cue.text).join('\n')),
      settings.vocabularySize,
    );

    // Match each lemma to its first cue
    const lemmaCueMap = new Map<string, { text: string; startMs: number; endMs: number }>();
    for (const lemma of lemmas) {
      const regex = new RegExp(`\\b${lemma}\\b`, 'i');
      const cue = page.cues.find((c) => regex.test(c.text));
      if (cue) lemmaCueMap.set(lemma, { text: cue.text, startMs: cue.startMs, endMs: cue.endMs });
    }

    setEntries(
      lemmas.map((lemma) => ({
        lemma,
        translation: null,
        status: 'pending',
        learningStatus: computeLearningStatus(cardsMap.get(lemma.toLowerCase())),
        cue: lemmaCueMap.get(lemma),
      })),
    );
    setLoading(false);
    setError('');

    void (async () => {
      for (let start = 0; start < lemmas.length; start += TRANSLATION_BATCH_SIZE) {
        if (requestId.current !== currentRequestId) return;
        const batch = lemmas.slice(start, start + TRANSLATION_BATCH_SIZE);
        try {
          const payload = await sendRuntime<{ results: DictionaryResult[] }>({
            type: 'DICTIONARY_PREFETCH',
            texts: batch,
          });
          if (requestId.current !== currentRequestId) return;
          const resultByLemma = new Map(
            (payload.results || []).map((result) => [dictionaryResultKey(result), result]),
          );
          setEntries((current) =>
            current.map((entry) => {
              const result = resultByLemma.get(entry.lemma);
              if (!result) return batch.includes(entry.lemma) ? { ...entry, status: 'missing' } : entry;
              const translation = result.translation?.trim() || null;
              return {
                ...entry,
                translation,
                shortZh: result.shortZh || null,
                status: translation ? 'found' : result.status === 'unavailable' ? 'unavailable' : 'missing',
              };
            }),
          );
        } catch {
          if (requestId.current !== currentRequestId) return;
          const batchSet = new Set(batch);
          setEntries((current) =>
            current.map((entry) => (batchSet.has(entry.lemma) ? { ...entry, status: 'unavailable' } : entry)),
          );
        }
      }
    })();

    return () => {
      if (requestId.current === currentRequestId) requestId.current += 1;
    };
  }, [pageSignature, refreshGeneration, settings?.vocabularySize]);

  // Update learning status whenever cardsMap changes
  useEffect(() => {
    setEntries((current) =>
      current.map((entry) => ({
        ...entry,
        learningStatus: computeLearningStatus(cardsMap.get(entry.lemma.toLowerCase())),
      })),
    );
  }, [cardsMap]);

  const saveWord = useCallback(
    async (entry: NewWordEntry) => {
      if (page?.platform === 'media') {
        await sendRuntime({ type: 'VOCABULARY_SAVE', input: mediaVocabularyWordInput(videoKeyOf(page), entry.lemma, entry.cue?.text ?? entry.lemma, {
          lemma: entry.lemma,
          ...(entry.shortZh || entry.translation ? { translation: entry.shortZh || entry.translation || '' } : {}),
        }) });
        await loadCards();
        return;
      }
      const identity = page
        ? (videoKeyOf(page).startsWith('bilibili:') ? { videoKey: videoKeyOf(page) } : { youtubeId: videoKeyOf(page).replace(/^youtube:/, '') })
        : { youtubeId: '00000000000' };
      const item: SavedItemInput = {
        id: randomId(),
        kind: 'word',
        displayValue: entry.lemma.trim(),
        normalizedValue: entry.lemma.toLowerCase().trim(),
        ...identity,
        segmentSeq: 0,
        startMs: entry.cue?.startMs ?? 0,
        contextText: entry.cue?.text ?? entry.lemma,
        note: '',
        lemma: entry.lemma,
        ...(entry.shortZh || entry.translation ? { meaningZh: entry.shortZh || entry.translation || '' } : {}),
        occurredAt: new Date().toISOString(),
      };
      await sendRuntime({ type: 'ASSET_SAVE', item });
      await loadCards();
    },
    [page, loadCards],
  );

  const saveAllWords = useCallback(async () => {
    const unadded = entries.filter((e) => e.learningStatus === 'unadded');
    for (const entry of unadded) {
      await saveWord(entry);
    }
  }, [entries, saveWord]);

  const dueCount = useMemo(
    () => entries.filter((e) => e.learningStatus === 'due').length,
    [entries],
  );

  const unaddedCount = useMemo(
    () => entries.filter((e) => e.learningStatus === 'unadded').length,
    [entries],
  );

  return { entries, loading, error, refresh, dueCount, unaddedCount, saveWord, saveAllWords };
}

export function NewWordCard({
  entry,
  onSave,
  onSelect,
}: {
  entry: NewWordEntry;
  onSave?: ((entry: NewWordEntry) => void) | undefined;
  onSelect?: ((entry: NewWordEntry) => void) | undefined;
}) {
  const [saving, setSaving] = useState(false);
  const isSaved = entry.learningStatus !== 'unadded';

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onSave || saving || isSaved) return;
    setSaving(true);
    try {
      await onSave(entry);
    } finally {
      setSaving(false);
    }
  };

  const handleSelect = () => {
    onSelect?.(entry);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleSelect();
    }
  };

  return (
    <li
      className={`new-word-card compact ${entry.status} ${entry.learningStatus} ${isSaved ? 'is-saved' : 'is-unadded'}`}
      role="button"
      tabIndex={0}
      aria-label={t("{0}，{1}，点击查看详情", entry.lemma, isSaved ? t("已在词库") : t("待收录"))}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
    >
      <div className="new-word-header-left">
        <strong className="new-word-lemma">{entry.lemma}</strong>
        <button
          type="button"
          className="agent-word-voice-btn"
          title={t("发音朗读")}
          aria-label={t("朗读 {0}", entry.lemma)}
          onClick={(e) => {
            e.stopPropagation();
            speakEnglish(entry.lemma);
          }}
        >
          <Icon name="volume" />
        </button>
      </div>
      <button
        type="button"
        className={`new-word-btn primary ${isSaved ? 'is-saved' : ''}`}
        disabled={saving || isSaved}
        title={isSaved ? t("已在词库") : t("加入词库")}
        aria-label={isSaved ? t("{0} 已在词库", entry.lemma) : t("把 {0} 加入词库", entry.lemma)}
        onClick={handleSave}
      >
        {saving ? '…' : isSaved ? <Icon name="check" /> : <Icon name="plus" />}
      </button>
    </li>
  );
}

export function NewWordDetailPopover({
  entry,
  onClose,
  onSave,
  onReplay,
}: {
  entry: NewWordEntry;
  onClose: () => void;
  onSave: (entry: NewWordEntry) => Promise<void>;
  onReplay?: ((startMs: number) => void) | undefined;
}) {
  const [saving, setSaving] = useState(false);
  const isSaved = entry.learningStatus !== 'unadded';
  const translation =
    entry.status === 'pending' ? t("加载中…") : entry.translation || t("暂无中文翻译");

  const handleSave = async () => {
    if (!onSave || isSaved || saving) return;
    setSaving(true);
    try {
      await onSave(entry);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      className="new-word-detail-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("{0} 详情", entry.lemma)}
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="new-word-detail-popover"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="new-word-detail-close"
          onClick={onClose}
          aria-label={t("关闭详情")}
          title={t("关闭")}
        >
          <Icon name="close" />
        </button>
        <div className="new-word-detail-head">
          <strong className="new-word-detail-lemma">{entry.lemma}</strong>
          <button
            type="button"
            className="agent-word-voice-btn"
            title={t("发音朗读")}
            aria-label={t("朗读 {0}", entry.lemma)}
            onClick={() => speakEnglish(entry.lemma)}
          >
            <Icon name="volume" />
          </button>
        </div>
        <div className="new-word-detail-translation" title={translation}>
          {translation}
        </div>
        {entry.cue && (
          <button
            type="button"
            className="new-word-detail-context"
            title={t("点击跳到原句时间点")}
            onClick={() => onReplay?.(entry.cue!.startMs)}
          >
            <small className="new-word-detail-time">
              {Math.floor(entry.cue.startMs / 60000)}:
              {String(Math.floor(entry.cue.startMs / 1000) % 60).padStart(2, '0')}
              <Icon name="external" />
            </small>
            <p className="new-word-detail-sentence">“{entry.cue.text}”</p>
          </button>
        )}
        <div className="new-word-detail-actions">
          <button
            type="button"
            className={`new-word-btn primary ${isSaved ? 'is-saved' : ''}`}
            disabled={saving || isSaved}
            onClick={handleSave}
            title={isSaved ? t("已在词库") : t("加入词库")}
          >
            {saving ? '…' : isSaved ? <><Icon name="check" /> {t("已在词库")}</> : <><Icon name="plus" /> {t("加入词库")}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

const EXPRESSION_REVIEW_STATUS_LABELS: Record<string, { text: string; className: string }> = {
  due: { text: t("🌟 旧知识 · 待复习"), className: 'status-due' },
  learning: { text: t("🌟 旧知识 · 学习中"), className: 'status-learning' },
  mastered: { text: t("🌟 旧知识 · 已掌握"), className: 'status-known' },
  new: { text: t("🌟 旧知识 · 新加入"), className: 'status-learning' },
};

export function ExpressionCard({
  expr,
  isSaved,
  onSave,
  onEdit,
  onReplay,
  onJumpStudy,
}: {
  expr: ExtractedExpression;
  isSaved?: boolean;
  onSave?: ((expr: ExtractedExpression) => Promise<void>) | undefined;
  onEdit?: ((expr: ExtractedExpression) => void) | undefined;
  onReplay?: ((startMs: number) => void) | undefined;
  onJumpStudy?: (() => void) | undefined;
}) {
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onSave || saving) return;
    setSaving(true);
    try {
      await onSave(expr);
    } finally {
      setSaving(false);
    }
  };

  const statusInfo = expr.isExisting
    ? (expr.existingReviewStatus && EXPRESSION_REVIEW_STATUS_LABELS[expr.existingReviewStatus]) || {
        text: t("🌟 旧知识复现"),
        className: 'status-known',
      }
    : isSaved
      ? { text: t("已加入表达库"), className: 'status-learning' }
      : { text: t("✨ 新知识 · 推荐"), className: 'status-unadded' };

  return (
    <li
      className={`expression-item-card ${expr.isExisting ? 'is-existing' : 'is-new'} ${isSaved ? 'is-saved' : ''}`}
      aria-label={`${expr.chunk}，${expr.meaningZh || expr.intentZh}`}
    >
      <div className="expression-card-top">
        <div className="expression-header-left">
          <strong className="expression-chunk">{expr.chunk}</strong>
          <button
            type="button"
            className="agent-word-voice-btn"
            title={t("发音朗读")}
            aria-label={t("朗读 {0}", expr.chunk)}
            onClick={(e) => {
              e.stopPropagation();
              speakEnglish(expr.chunk);
            }}
          >
            <Icon name="volume" />
          </button>
        </div>
        <span className={`expression-badge ${statusInfo.className}`}>
          {statusInfo.text}
        </span>
      </div>

      {expr.pattern && expr.pattern.toLowerCase() !== expr.chunk.toLowerCase() && (
        <div className="expression-pattern" title={expr.pattern}>
          <span className="expression-pattern-label">{t("句型：")}</span>
          <span className="expression-pattern-text">{expr.pattern}</span>
        </div>
      )}

      <div className="expression-meanings">
        {expr.meaningZh && (
          <div className="expression-meaning-row">
            <span className="expression-meaning-tag">{t("释义")}</span>
            <span className="expression-meaning-val">{expr.meaningZh}</span>
          </div>
        )}
        {expr.intentZh && (
          <div className="expression-intent-row">
            <span className="expression-intent-tag">{t("意图")}</span>
            <span className="expression-intent-val">{expr.intentZh}</span>
          </div>
        )}
      </div>

      {expr.slots && expr.slots.length > 0 && (
        <div className="expression-slots">
          <span className="expression-slots-label">{t("替换槽位：")}</span>
          <div className="expression-slots-wrap">
            {expr.slots.map((slot, sIdx) => (
              <span key={sIdx} className="expression-slot-chip">
                {slot}
              </span>
            ))}
          </div>
        </div>
      )}

      {expr.sourceSentence && (
        <div
          className="expression-context"
          title={expr.sourceSentence}
          onClick={() => onReplay?.(expr.startMs)}
        >
          <small className="expression-time">
            {Math.floor(expr.startMs / 60000)}:
            {String(Math.floor(expr.startMs / 1000) % 60).padStart(2, '0')} <Icon name="external" />
          </small>
          <p className="expression-sentence">“{expr.sourceSentence}”</p>
        </div>
      )}

      <div className="expression-card-actions">
        {!expr.isExisting && !isSaved ? (
          <>
            <button
              type="button"
              className="new-word-btn primary"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? t("收录中…") : <><Icon name="plus" /> {t("表达复习")}</>}
            </button>
            <button
              type="button"
              className="new-word-btn"
              title={t("编辑微调语块与句型槽位")}
              onClick={(e) => {
                e.stopPropagation();
                onEdit?.(expr);
              }}
            >
              <Icon name="edit" /> {t("细调")}</button>
          </>
        ) : (
          <span className="expression-saved-tag">
            {expr.isExisting ? t("已在表达库（已巩固）") : t("已收录至表达库")}
          </span>
        )}

        <button
          type="button"
          className="new-word-btn"
          title={t("去表达复习进行主动回想与场景挑战")}
          onClick={(e) => {
            e.stopPropagation();
            onJumpStudy?.();
          }}
        >
          <Icon name="play" /> {t("表达复习")}</button>
      </div>
    </li>
  );
}

export function NewWordsPanel({
  page,
  state,
  owner,
  onReplay,
  showExpressions = true,
}: {
  page?: PageState;
  state: NewWordsState;
  owner?: string;
  onReplay?: (startMs: number) => void;
  showExpressions?: boolean;
}) {
  const { entries, loading, error, refresh, dueCount, unaddedCount, saveWord, saveAllWords } = state;
  const [savingAll, setSavingAll] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'words' | 'expressions'>('words');
  const [detailEntry, setDetailEntry] = useState<NewWordEntry | null>(null);
  const expressionsVisible = showExpressions && activeSubTab === 'expressions';

  // Expression analysis states
  const [expressions, setExpressions] = useState<ExtractedExpression[]>([]);
  const [savedExpressionIds, setSavedExpressionIds] = useState<Set<string>>(new Set());
  const [analyzingExpressions, setAnalyzingExpressions] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState('');
  const [analysisError, setAnalysisError] = useState('');
  const [savingAllExpressions, setSavingAllExpressions] = useState(false);
  const [editingExpression, setEditingExpression] = useState<ExtractedExpression | null>(null);
  const [expressionCacheState, setExpressionCacheState] = useState<'loading' | 'ready'>('ready');
  const expressionRequestKey = useRef('');
  const expressionAbortController = useRef<AbortController | null>(null);

  const videoKey = page ? videoKeyOf(page) : '';

  // Load cached analysis when video or owner changes
  useEffect(() => {
    if (!showExpressions) return;
    let disposed = false;
    expressionAbortController.current?.abort();
    expressionAbortController.current = null;
    expressionRequestKey.current = '';
    setExpressions([]);
    setSavedExpressionIds(new Set());
    setAnalysisError('');
    setAnalysisStatus('');
    setAnalyzingExpressions(false);
    setExpressionCacheState(videoKey ? 'loading' : 'ready');

    if (!videoKey) {
      return;
    }

    const loadCache = async () => {
      try {
        const cached = await readCachedExpressionAnalysis(owner || 'local', videoKey);
        if (!disposed) {
          setExpressions(cached?.expressions || []);
          setExpressionCacheState('ready');
        }
      } catch {
        if (!disposed) setExpressionCacheState('ready');
      }
    };

    void loadCache();
    return () => {
      disposed = true;
      expressionAbortController.current?.abort();
    };
  }, [videoKey, owner, showExpressions]);

  // Reload expression bundles on vocabulary changes to keep statuses in sync
  useEffect(() => {
    if (!showExpressions) return;
    const onRuntimeMessage = (message: RuntimeMessage) => {
      if (message.type === 'VOCABULARY_CHANGED' && videoKey) {
        void readCachedExpressionAnalysis(owner || 'local', videoKey).then((cached) => {
          if (cached?.expressions.length) setExpressions(cached.expressions);
        });
      }
    };
    browser.runtime.onMessage.addListener(onRuntimeMessage);
    return () => {
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
    };
  }, [videoKey, owner, showExpressions]);

  const handleSaveAll = async () => {
    setSavingAll(true);
    try {
      await saveAllWords();
    } finally {
      setSavingAll(false);
    }
  };

  const handleAnalyzeExpressions = async () => {
    if (!page || !videoKey) return;
    if (expressionCacheState !== 'ready' || expressions.length > 0 || analyzingExpressions) return;
    const requestKey = `${owner || 'local'}:${videoKey}`;
    if (expressionRequestKey.current === requestKey) return;

    const abortController = new AbortController();
    expressionAbortController.current = abortController;
    expressionRequestKey.current = requestKey;
    setAnalyzingExpressions(true);
    setAnalysisError('');
    setAnalysisStatus(t("正在读取语料字幕与您的表达复习库…"));
    try {
      const results = await analyzeCorpusExpressions({
        page,
        cues: page.cues,
        videoKey,
        title: page.title || t("当前视频"),
        owner: owner || 'local',
        signal: abortController.signal,
        onStatus: (st) => setAnalysisStatus(st),
      });
      setExpressions(results);
      setExpressionCacheState('ready');
    } catch (err) {
      if (abortController.signal.aborted) return;
      setAnalysisError(err instanceof Error ? err.message : String(err));
    } finally {
      if (expressionRequestKey.current === requestKey) {
        expressionRequestKey.current = '';
        expressionAbortController.current = null;
        setAnalyzingExpressions(false);
        setAnalysisStatus('');
      }
    }
  };

  const handleSaveSingleExpression = async (expr: ExtractedExpression) => {
    const bundle = toExpressionBundleInput(expr, page);
    await sendRuntime({ type: 'EXPRESSION_BUNDLE_SAVE', bundle });
    setSavedExpressionIds((prev) => new Set(prev).add(expr.id));
  };

  const handleSaveAllNewExpressions = async () => {
    setSavingAllExpressions(true);
    try {
      const unadded = expressions.filter(
        (e) => !e.isExisting && !savedExpressionIds.has(e.id),
      );
      for (const expr of unadded) {
        const bundle = toExpressionBundleInput(expr, page);
        await sendRuntime({ type: 'EXPRESSION_BUNDLE_SAVE', bundle });
        setSavedExpressionIds((prev) => new Set(prev).add(expr.id));
      }
    } finally {
      setSavingAllExpressions(false);
    }
  };

  const openVocabularyStudy = () => {
    window.open(`${browser.runtime.getURL('/dashboard.html')}#study`, '_blank');
  };

  const openExpressionStudy = () => {
    window.open(`${browser.runtime.getURL('/dashboard.html')}#study`, '_blank');
  };

  const unaddedExpressionsCount = useMemo(
    () => expressions.filter((e) => !e.isExisting && !savedExpressionIds.has(e.id)).length,
    [expressions, savedExpressionIds],
  );

  const existingExpressionsCount = useMemo(
    () => expressions.filter((e) => e.isExisting).length,
    [expressions],
  );

  return (
    <section className="new-words-panel" aria-label={showExpressions ? t("当前页面生词与表达") : t("当前页面生词")}>
      <header className="new-words-panel-header">
        <div className="new-words-panel-info">
          {showExpressions ? <div className="new-words-subtabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeSubTab === 'words'}
              className={`new-words-subtab ${activeSubTab === 'words' ? 'active' : ''}`}
              onClick={() => setActiveSubTab('words')}
            >
              {t("生词 (")}{loading && !entries.length ? '…' : entries.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeSubTab === 'expressions'}
              className={`new-words-subtab ${activeSubTab === 'expressions' ? 'active' : ''}`}
              onClick={() => setActiveSubTab('expressions')}
            >
              {t("语块与句型")}{expressions.length > 0 ? `(${expressions.length})` : ''}
            </button>
          </div> : <strong>{t("生词 (")}{loading && !entries.length ? '…' : entries.length})</strong>}
        </div>

        {!expressionsVisible ? (
          <div className="new-words-header-actions">
            {unaddedCount > 0 && (
              <button
                type="button"
                className="new-words-batch-btn"
                disabled={savingAll}
                onClick={handleSaveAll}
                title={t("把本视频所有未收录生词批量加入词库")}
              >
                {savingAll ? t("添加中…") : <><Icon name="plus" />{t("全部收录 (")}{unaddedCount})</>}
              </button>
            )}

            {showExpressions && <button
              type="button"
              className="new-words-ai-btn"
              disabled={expressionCacheState !== 'ready' || analyzingExpressions}
              onClick={() => {
                setActiveSubTab('expressions');
                void handleAnalyzeExpressions();
              }}
              title={expressions.length ? t("查看本视频已生成的表达分析") : t("点击一次，AI 提炼本视频的核心语块与可复用句型")}
            >
              <Icon name={expressions.length ? 'notebook' : 'sparkles'} />
              {expressionCacheState !== 'ready' ? t("读取表达…") : expressions.length ? t("查看表达") : t("AI 提炼表达")}
            </button>}

            <button
              type="button"
              className="new-words-study-link-btn"
              onClick={openVocabularyStudy}
              title={t("去词库进行 FSRS 间隔记忆复习")}
            >
              <Icon name="play" /> {t("词库复习")}</button>

            <button
              type="button"
              className="new-words-refresh"
              onClick={refresh}
              disabled={loading}
              aria-label={t("刷新生词列表")}
              title={t("刷新生词列表")}
            >
              <Icon name="refresh" />
            </button>
          </div>
        ) : (
          <div className="new-words-header-actions">
            {unaddedExpressionsCount > 0 && (
              <button
                type="button"
                className="new-words-batch-btn"
                disabled={savingAllExpressions}
                onClick={handleSaveAllNewExpressions}
                title={t("把本视频提炼出的所有新表达一键加入表达复习库")}
              >
                {savingAllExpressions ? t("收录中…") : <><Icon name="plus" />{t("全部收录 (")}{unaddedExpressionsCount})</>}
              </button>
            )}

            <button
              type="button"
              className="new-words-study-link-btn"
              onClick={openExpressionStudy}
              title={t("前往表达复习页面进行主动回想与场景迁移挑战")}
            >
              <Icon name="play" /> {t("前往表达复习")}</button>
          </div>
        )}
      </header>

      {!expressionsVisible ? (
        <ul className="new-words-grid compact-mode">
          {loading && !entries.length && <li className="new-words-empty">{t("正在分析视频生词…")}</li>}
          {!loading && !entries.length && (
            <li className="new-words-empty">{error || t("当前页面没有超出词汇量的生词")}</li>
          )}
          {entries.map((entry) => (
            <NewWordCard
              key={entry.lemma}
              entry={entry}
              onSave={saveWord}
              onSelect={setDetailEntry}
            />
          ))}
        </ul>
      ) : (
        <div className="expressions-panel-container">
          {expressions.length > 0 && (
            <div className="expressions-summary-banner">
              <span>
                {t("共提炼")}<strong>{expressions.length}</strong> {t("条表达")}{existingExpressionsCount > 0 && (
                  <> · 🌟 <strong>{existingExpressionsCount}</strong> {t("条旧知识复现巩固")}</>
                )}
                {unaddedExpressionsCount > 0 && (
                  <> · ✨ <strong>{unaddedExpressionsCount}</strong> {t("条新知识待收录")}</>
                )}
              </span>
            </div>
          )}

          {expressionCacheState === 'loading' && !analyzingExpressions && (
            <div className="expressions-loading-state" role="status">
              <p>{t("正在读取已保存的表达分析…")}</p>
            </div>
          )}

          {analyzingExpressions && (
            <div className="expressions-loading-state" role="status">
              <div className="expressions-loading-spinner" />
              <p>{analysisStatus || t("AI 正在结合您的表达复习库深入分析视频语料…")}</p>
              <small>{t("提炼高频核心语块、可复用句型结构与替换槽位")}</small>
            </div>
          )}

          {analysisError && (
            <div className="expressions-error-box" role="alert">
              <p>{analysisError}</p>
              <button type="button" className="new-word-btn primary" onClick={handleAnalyzeExpressions}>
                {t("重试")}</button>
            </div>
          )}

          {expressionCacheState === 'ready' && !analyzingExpressions && !expressions.length && !analysisError && (
            <div className="expressions-empty-state">
              <p>{t("语块与句型不会随播放器自动生成")}</p>
              <small>{t("准备好后，点击一次开始 AI 提炼；生成结果会按视频保存。")}</small>
              <button
                type="button"
                className="new-words-ai-btn primary-btn"
                disabled={!page?.cues.length}
                onClick={() => void handleAnalyzeExpressions()}
              >
                <Icon name="sparkles" /> {page?.cues.length ? t("开始 AI 提炼表达") : t("暂无英文字幕")}
              </button>
            </div>
          )}

          {!analyzingExpressions && expressions.length > 0 && (
            <ul className="expressions-card-grid">
              {expressions.map((expr) => (
                <ExpressionCard
                  key={expr.id}
                  expr={expr}
                  isSaved={savedExpressionIds.has(expr.id)}
                  onSave={handleSaveSingleExpression}
                  onEdit={(target) => setEditingExpression(target)}
                  onReplay={onReplay}
                  onJumpStudy={openExpressionStudy}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {editingExpression && (
        <ExpressionBundleEditor
          chunk={editingExpression.chunk}
          pattern={editingExpression.pattern}
          sourceSentence={editingExpression.sourceSentence}
          meaningZh={editingExpression.meaningZh}
          intentZh={editingExpression.intentZh}
          slots={editingExpression.slots}
          source={{
            type: 'video',
            videoKey: page ? videoKeyOf(page) : 'general',
            title: page?.title || t("视频语料"),
            ...(page?.canonicalUrl ? { canonicalUrl: page.canonicalUrl } : {}),
            ...(page?.thumbnailUrl ? { thumbnailUrl: page.thumbnailUrl } : {}),
            trackId: page?.activeTrackId ?? null,
            segmentSeq: 0,
            startMs: editingExpression.startMs || 0,
            contextText: editingExpression.sourceSentence,
          }}
          onSave={async (bundle) => {
            await sendRuntime({ type: 'EXPRESSION_BUNDLE_SAVE', bundle });
            setSavedExpressionIds((prev) => new Set(prev).add(editingExpression.id));
            setEditingExpression(null);
          }}
          onClose={() => setEditingExpression(null)}
        />
      )}

      {detailEntry && (
        <NewWordDetailPopover
          entry={detailEntry}
          onClose={() => setDetailEntry(null)}
          onSave={async (entry) => {
            await saveWord(entry);
            setDetailEntry((current) =>
              current && current.lemma === entry.lemma
                ? { ...current, learningStatus: 'learning' }
                : current,
            );
          }}
          onReplay={onReplay}
        />
      )}
    </section>
  );
}
