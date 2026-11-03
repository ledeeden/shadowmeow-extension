import { t } from '../lib/i18n';
/* @refresh reset */
import { Icon } from './icon';
import { TranscriptRows } from './transcript-rows';
import { WordAtlas } from './word-atlas';
import { findAtlasEntry } from '../lib/word-atlas';
import { DictationPractice, DICTATION_PRACTICE_CSS } from './dictation-practice';
import { DictationPortraitPrompt } from './dictation-portrait-prompt';
import { showDictationPortraitHint } from '../lib/dictation-keyboard';
import { useExternalDictationKeyboard } from '../lib/use-dictation-keyboard';
import { SentenceSubmission } from './sentence-submission';
import { track } from '../lib/analytics';
import { useLearningAnalytics } from '../lib/use-analytics';
import { selectedTextIn } from '../lib/text-selection';
import { captionNlpPhrases, PLAYBACK_RATES, type CaptionNlpResult, videoKeyOf, translatedSegmentText, randomId } from '@shadow-language/contracts';
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { AttemptInput, CaptionTextToken, DictionaryResult, NormalizedSegment, PageState, PlayerCommand, RuntimeMessage, SavedItemInput, UserSettings, VocabularyState } from '@shadow-language/contracts';
import { captionDictionaryTerms, captionPhraseCandidates, centeredCaptionPhraseCandidates, dedupeDictionarySources, dictionaryDetailCacheKey, displayPhonetic, normalizeDictionaryQuery, selectPhraseCandidates, shortZhFromTranslation, tokenizeCaptionText } from '@shadow-language/contracts';
import { useCaptionNlp } from '../lib/use-caption-nlp';
import { db, DEFAULT_SETTINGS } from '../lib/db';
import { runtimeApiCall, runtimeTransportError, unwrapRuntimeResponse } from '../lib/runtime-errors';
import { cancelEnglishSpeech, speakEnglish } from '../lib/speech';
import { resetActivityTracker } from '../lib/learning-activity';
import { findSegment, isBilibiliCorpusReady, LOOP_EARLY_TOLERANCE_MS, playerOverlayEnabled, playerPersistenceIdentity, resolveDisplayedSegment, resolveLoopCycle, shouldCancelPendingLoopReplay, subtitleHoverDelay, subtitleHoverTransition } from '../lib/player-control';
import { PAGE_SHORTCUT_LABELS, shortcutActionForKey, shortcutKeyLabel, type PageShortcuts } from '../lib/shortcuts';
import { clampSubtitleMaskGeometry, DEFAULT_SUBTITLE_MASK_GEOMETRY, moveSubtitleMaskGeometry, resizeSubtitleMaskGeometry, type SubtitleMaskGeometry, type SubtitleMaskResizeHandle } from '../lib/subtitle-mask';
import { analyzeVocabularyText, vocabularyCoverage } from '../lib/vocabulary-profile';
import { lookupReaderWord } from '../lib/reader-frequency';
import { mediaVocabularyWordInput, vocabularyTermKeys } from '../lib/vocabulary';
import { activeSubtitleWordIndex, cycleSubtitleDisplayMode, isNewSubtitleWord, subtitleDisplayModeLabel, subtitleMaskWidth, type SubtitleDisplayMode } from '../lib/subtitle-display';
import { isSupportedVideoContext } from '../lib/youtube-player-state';
import { sortEnglishCaptionTracks } from '../lib/youtube-track';
import type { ErrorSpan } from '../lib/sentence-alignment';

type SegmentMode = 'learning' | 'raw';

export type PlayerLearningAction = 'dictation-open' | 'replay' | 'loop' | 'asset-saved' | 'expression-saved' | 'dictation-submitted';

export type PlayerDictationSubmission = {
  segment: NormalizedSegment;
  answer: string;
  spans: ErrorSpan[];
};

type PlayerUiProps = {
  persistProgress?: boolean;
  embedded?: { controls: Element; transcript: Element; popover?: Element; initialChineseSubtitlesVisible?: boolean; onTranscriptCollapsedChange?: (collapsed: boolean) => void; onSubtitleDisplayModeChange?: (mode: SubtitleDisplayMode) => void; onSubtitleMaskEnabledChange?: (enabled: boolean) => void; onChineseSubtitlesVisibleChange?: (visible: boolean) => void; onLoopChange?: (enabled: boolean) => void; onDictationOpenChange?: (open: boolean) => void };
  dictationRequestId?: number;
  expandTranscriptRequestId?: number;
  subtitleMaskRequestId?: number;
  chineseSubtitleRequestId?: number;
  loopToggleRequestId?: number;
  dictationMode?: 'guided' | 'whole-sentence';
  dictationSegmentIndex?: number;
  preventDictationFullscreen?: boolean;
  mobileDictation?: boolean;
  page: PageState;
  onCommand: (command: PlayerCommand) => void;
  onSelectTrack: (trackId: string) => Promise<void>;
  onRetryCaptions: () => Promise<void>;
  onLearningEvent?: (action: PlayerLearningAction) => void;
  onDictationSubmit?: (submission: PlayerDictationSubmission) => void;
};


type TextSelection = {
  text: string;
  segment: NormalizedSegment;
  index: number;
  origin: 'subtitle' | 'transcript';
};

type DictionaryPopoverState = {
  query: string;
  result: DictionaryResult | null;
  loading: boolean;
  expanded: boolean;
  pinned: boolean;
  anchor: { left: number; top: number };
  placement: 'above' | 'below';
  maxHeight: number;
  origin: 'subtitle' | 'transcript';
  sourceSegment?: NormalizedSegment;
  sourceIndex?: number;
  phraseCandidates?: string[];
};

type ActionToolbarPosition = {
  left: number;
  top: number;
};

type SubtitleMaskInteraction = {
  pointerId: number;
  startX: number;
  startY: number;
  shellWidth: number;
  shellHeight: number;
  geometry: SubtitleMaskGeometry;
  mode: 'move' | 'resize';
  handle?: SubtitleMaskResizeHandle;
};

const ACTION_TOOLBAR_POSITION_KEY = 'shadowLanguageActionToolbarPosition';
const SUBTITLE_MASK_STORAGE_KEY = 'shadowLanguageSubtitleMask';
const ACTION_TOOLBAR_EDGE = 12;
const SUBTITLE_EDGE = 8;
const SUBTITLE_MASK_HANDLES: SubtitleMaskResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

type DictationOrientation = ScreenOrientation & {
  lock?: (orientation: 'portrait') => Promise<void>;
  unlock?: () => void;
};

function mobileDictationViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 1199px)').matches || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
}

function isIPadDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const browser = navigator as Navigator & { platform?: string };
  return /iPad/i.test(browser.userAgent) || (browser.platform === 'MacIntel' && browser.maxTouchPoints > 1);
}

function portraitDictationViewport(useStableIPadOrientation = false): boolean {
  if (typeof window === 'undefined') return false;
  if (useStableIPadOrientation && isIPadDevice()) {
    // Keyboard-sized viewports must not be mistaken for device rotation.
    const legacyOrientation = (window as Window & { orientation?: number }).orientation;
    if (typeof legacyOrientation === 'number') return Math.abs(legacyOrientation) !== 90;
    const orientation = dictationOrientation();
    if (orientation?.type) return orientation.type.startsWith('portrait');
    return screen.width <= screen.height;
  }
  return window.matchMedia('(orientation: portrait)').matches;
}

function dictationOrientation(): DictationOrientation | undefined {
  if (typeof screen === 'undefined' || !screen.orientation) return undefined;
  return screen.orientation as DictationOrientation;
}

export type YoutubePlayerUi = {
  host: HTMLDivElement;
  update: (page: PageState) => void;
  openDictation: () => void;
  expandTranscript: () => void;
  toggleSubtitleMask: () => void;
  toggleChineseSubtitles: () => void;
  toggleLoop: () => void;
  invalidate: () => void;
  destroy: () => void;
};

async function sendRuntime<T>(message: RuntimeMessage): Promise<T> {
  try {
    return unwrapRuntimeResponse(await browser.runtime.sendMessage(message));
  } catch (error) {
    throw runtimeTransportError(error);
  }
}

function runtimeErrorMessage(error: unknown): string {
  return runtimeTransportError(error).message;
}

function ShortcutHelp({ shortcuts }: { shortcuts: PageShortcuts }) {
  return <details
    className="sl-shortcuts"
    onKeyDown={(event) => {
      if (event.key !== 'Escape') return;
      event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
      event.stopPropagation();
    }}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
    }}
  >
    <summary aria-label={t("查看快捷键")}>{t("快捷键")}</summary>
    <section className="sl-shortcuts-panel" aria-label={t("播放器快捷键")}>
      <header><strong>{t("播放器快捷键")}</strong><small>{t("可在扩展设置中修改")}</small></header>
      <dl>{PAGE_SHORTCUT_LABELS.map(({ action, label }) => <div key={action}><dt>{label}</dt><dd>{shortcutKeyLabel(shortcuts[action])}</dd></div>)}</dl>
      <p>{t("Space 由页面原生播放器处理。")}</p>
    </section>
  </details>;
}
function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

type SubtitleTextProps = {
  text: string;
  nlp?: CaptionNlpResult | undefined;
  displayMode: SubtitleDisplayMode;
  timeMs: number;
  startMs: number;
  endMs: number;
  wordStarts?: NormalizedSegment['wordStarts'];
  vocabularySize: number;
  savedVocabulary: Set<string>;
  masteredVocabulary: Set<string>;
  onWordEnter: (term: string, element: HTMLElement, wordIndex: number) => void;
  onWordLeave: () => void;
  onWordClick: (term: string, element: HTMLElement, wordIndex: number) => void;
};

const RENDERABLE_ENGLISH_WORD = /^[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*$/;

const SubtitleText = memo(function SubtitleText({ text, nlp, displayMode, timeMs, startMs, endMs, wordStarts, vocabularySize, savedVocabulary, masteredVocabulary, onWordEnter, onWordLeave, onWordClick }: SubtitleTextProps) {
  const tokens = useMemo(() => nlp ? nlp.tokens.map(token => ({
    kind: token.lookupText || RENDERABLE_ENGLISH_WORD.test(token.text) ? 'word' as const : 'text' as const,
    text: token.text, ...(token.lookupText ? { lookupText: token.lookupText } : {}), key: `nlp-${token.index}`,
  })) : tokenizeCaptionText(text), [text, nlp]);
  const activeWordIndex = useMemo(() => {
    let offset = 0;
    const wordOffsets: number[] = [];
    for (const token of tokens) {
      if (token.kind === 'word') wordOffsets.push(offset);
      offset += token.text.length;
    }
    return activeSubtitleWordIndex({ wordOffsets, ...(wordStarts?.length ? { wordStarts } : {}), startMs, endMs, timeMs });
  }, [tokens, wordStarts, startMs, endMs, timeMs]);
  let wordIndex = 0;
  return <>{tokens.map((token: CaptionTextToken, tokenIndex) => {
    if (token.kind !== 'word') return displayMode === 'all' ? <span key={token.key}>{token.text}</span> : <span key={token.key} className="sl-word-mask-separator" aria-hidden="true">{token.text.replace(/\S/g, ' ')}</span>;
    const spokenWordIndex = wordIndex;
    const currentWordIndex = nlp ? tokenIndex : spokenWordIndex;
    wordIndex += 1;
    const vocabularyInfo = token.lookupText ? lookupReaderWord(token.lookupText) : null;
    const vocabularyKeys = token.lookupText ? (nlp ? [token.lookupText] : vocabularyTermKeys(token.lookupText, vocabularyInfo!.lemma)) : [];
    const mastered = vocabularyKeys.some((key) => masteredVocabulary.has(key));
    const saved = !mastered && vocabularyKeys.some((key) => savedVocabulary.has(key));
    const outsideVocabulary = vocabularyInfo ? isNewSubtitleWord({ vocabularySize, vocabularyKeys, vocabularyRank: vocabularyInfo.rank, countable: vocabularyInfo.countable, masteredVocabulary }) : false;
    const visible = displayMode === 'all' || (displayMode === 'new-words' && outsideVocabulary);
    const current = activeWordIndex === spokenWordIndex;
    if (!visible) return <span key={token.key} className={`sl-word-mask ${current ? 'is-current' : ''}`} role="img" aria-label={current ? t("当前词位已遮盖") : t("已遮盖")} style={{ width: `${subtitleMaskWidth(token.text)}em` }} />;
    const stateLabel = mastered ? t("已掌握") : saved ? t("已保存 · 待学习") : outsideVocabulary ? t("超出当前词汇量") : '';
    if (!token.lookupText) return <span key={token.key} className={`sl-word-token ${current ? 'is-current' : ''}`}>{token.text}</span>;
    return <span
      key={token.key}
      data-token-index={currentWordIndex}
      data-word-key={token.lookupText}
      data-nlp-engine={nlp?.engine}
      className={`sl-word-token ${mastered ? 'is-mastered' : ''} ${saved ? 'is-saved' : ''} ${outsideVocabulary ? 'is-outside' : ''} ${current ? 'is-current' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={t("查词 {0}{1}", token.text, stateLabel ? `，${stateLabel}` : '')}
      title={t("{0}悬停查看翻译，点击打开完整词典", stateLabel ? `${stateLabel} · ` : '')}
      onPointerEnter={(event) => onWordEnter(token.lookupText!, event.currentTarget, currentWordIndex)}
      onPointerLeave={onWordLeave}
      onClick={(event) => {
        if (!selectedTextIn(event.currentTarget.closest<HTMLElement>('.sl-subtitle-text') || event.currentTarget)) onWordClick(token.lookupText!, event.currentTarget, currentWordIndex);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onWordClick(token.lookupText!, event.currentTarget, currentWordIndex);
      }}
    >{token.text}</span>;
  })}</>;
});

function dictionaryPreview(result: DictionaryResult | null): string {
  if (!result) return '';
  return result.shortZh
    || shortZhFromTranslation(result.translation)
    || result.senses[0]?.zhTerms?.join('，')
    || result.senses[0]?.definition
    || (result.status === 'unavailable' ? t("词典暂不可用") : t("暂未找到释义"));
}

function dictionaryMeaningZh(result: DictionaryResult | null | undefined): string | null {
  if (!result) return null;
  return result.shortZh || shortZhFromTranslation(result.translation) || result.translation || null;
}

function highlightContextSentence(sentence: string, query: string, candidates: string[] = []): { before: string; match: string; after: string } | null {
  const normalizedSentence = sentence.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalizedSentence) return null;
  const targets = [query, ...candidates]
    .map((value) => normalizeDictionaryQuery(value).toLowerCase())
    .filter((value, index, list) => value && list.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);
  const lower = normalizedSentence.toLowerCase();
  for (const target of targets) {
    const at = lower.indexOf(target);
    if (at < 0) continue;
    return {
      before: normalizedSentence.slice(0, at),
      match: normalizedSentence.slice(at, at + target.length),
      after: normalizedSentence.slice(at + target.length),
    };
  }
  return { before: normalizedSentence, match: '', after: '' };
}

function groupSensesByPos(senses: DictionaryResult['senses'], zhSenses: NonNullable<DictionaryResult['zhSenses']>) {
  const groups: { partOfSpeech: string | null; zhTerms: string[]; en: string[] }[] = [];
  const indexByPos = new Map<string | null, number>();
  const push = (partOfSpeech: string | null, zhTerms: string[], en?: string) => {
    const key = partOfSpeech || null;
    const existingIndex = indexByPos.get(key);
    if (existingIndex === undefined) {
      indexByPos.set(key, groups.length);
      groups.push({ partOfSpeech: key, zhTerms: [...zhTerms], en: en ? [en] : [] });
      return;
    }
    const group = groups[existingIndex];
    if (!group) return;
    for (const term of zhTerms) if (!group.zhTerms.includes(term)) group.zhTerms.push(term);
    if (en && !group.en.includes(en)) group.en.push(en);
  };

  for (const zh of zhSenses) push(zh.partOfSpeech, zh.terms);
  for (const sense of senses) {
    const zhTerms = sense.zhTerms?.length
      ? sense.zhTerms
      : zhSenses.find((zh) => (zh.partOfSpeech || null) === (sense.partOfSpeech || null))?.terms || [];
    push(sense.partOfSpeech, zhTerms, sense.definition);
  }
  return groups;
}

function dictionaryResultKey(query: string, detail: 'hover' | 'full'): string {
  return dictionaryDetailCacheKey(query, 'en', 'zh-CN', detail);
}

function withDictionaryContext(result: DictionaryResult, contextText?: string): DictionaryResult {
  const context = contextText?.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 500);
  return context ? { ...result, contextText: context } : result;
}

function withoutDictionaryContext(result: DictionaryResult): DictionaryResult {
  const { contextText: _contextText, ...contextFree } = result;
  return contextFree;
}

function dictionaryVocabularyKeys(result: DictionaryResult): string[] {
  return vocabularyTermKeys(result.query, result.lemma);
}

function DictionaryPopover({
  panel,
  onClose,
  onSave,
  onMarkKnown,
  onSpeak,
  onLookupPhrase,
  speaking,
  mastered,
  popoverRef,
  onPointerEnter,
  onPointerLeave,
}: {
  panel: DictionaryPopoverState;
  onClose: () => void;
  onSave: (result: DictionaryResult) => void;
  onMarkKnown: (result: DictionaryResult) => void;
  onSpeak: (term: string) => void;
  onLookupPhrase: (phrase: string) => void;
  speaking: boolean;
  mastered: boolean;
  popoverRef?: React.Ref<HTMLDivElement>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const [atlasMatch, setAtlasMatch] = useState<{ query: string; found: boolean } | null>(null);
  useEffect(() => {
    if (!panel.expanded || !import.meta.env.VITE_SHADOW_WEB) return;
    let active = true;
    void findAtlasEntry(panel.query).then(entry => {
      if (active) setAtlasMatch({ query: panel.query, found: Boolean(entry) });
    });
    return () => { active = false; };
  }, [panel.expanded, panel.query]);
  const hasAtlas = panel.expanded && atlasMatch?.query === panel.query && atlasMatch.found;
  const result = panel.result;
  const isPhrase = panel.query.split(/\s+/).filter(Boolean).length > 1;
  const shortZh = dictionaryPreview(result);
  const phonetic = displayPhonetic(result?.phonetic);
  const context = highlightContextSentence(
    panel.sourceSegment?.text || result?.contextText || '',
    panel.query,
    panel.phraseCandidates,
  );
  const senseGroups = result ? groupSensesByPos(result.senses, result.zhSenses || []) : [];
  const phraseChips = (panel.phraseCandidates || []).filter((phrase) => phrase !== normalizeDictionaryQuery(panel.query).toLowerCase());
  const sourcesLabel = result ? dedupeDictionarySources(result.sources) : '';

  return <aside
    ref={popoverRef}
    className={`sl-dictionary-popover ${panel.expanded ? 'expanded' : 'compact'} from-${panel.origin} place-${panel.placement}`}
    style={{ left: panel.anchor.left, top: panel.anchor.top, maxHeight: panel.maxHeight }}
    role="dialog"
    aria-label={t("{0} 词典", panel.query)}
    onPointerEnter={onPointerEnter}
    onPointerLeave={onPointerLeave}
  >
    {panel.loading && <div className="sl-dictionary-progress" aria-hidden="true"><i /></div>}
    <header>
      <div>
        <strong>{result?.lemma || panel.query}</strong>
        {phonetic && <small className="sl-dictionary-phonetic">{phonetic}</small>}
      </div>
      <div className="sl-dictionary-header-actions">
        {result?.status === 'found' && <button type="button" className="sl-dictionary-save" onClick={() => onSave(result)} aria-label={t("保存{0}", isPhrase ? t("短语") : t("单词"))} title={t("保存{0}", isPhrase ? t("短语") : t("单词"))}>{t("保存")}</button>}
        {panel.expanded && result?.status === 'found' && !isPhrase && (
          <button type="button" className={`sl-dictionary-known ${mastered ? 'is-active' : ''}`} onClick={() => onMarkKnown(result)} aria-label={mastered ? t("已掌握") : t("标记为已掌握")} aria-pressed={mastered} title={mastered ? t("已掌握") : t("标记为已掌握")}>
            {mastered ? <><Icon name="check" /> {t("已掌握")}</> : t("已掌握")}
          </button>
        )}
        <button type="button" className="sl-dictionary-speak" onClick={() => onSpeak(result?.query || panel.query)} aria-label={speaking ? t("停止发音") : t("播放发音")} title={speaking ? t("停止发音") : t("播放发音")}>{speaking ? <Icon name="stop" /> : <Icon name="volume" />}</button>
        <button type="button" onClick={onClose} aria-label={t("关闭词典")}><Icon name="close" /></button>
      </div>
    </header>
    {panel.loading && !result ? (
      <p className="sl-dictionary-loading">{t("查词中…")}</p>
    ) : !result || result.status === 'unavailable' ? (
      <p className="sl-dictionary-loading">{result?.status === 'unavailable' ? t("词典暂时不可用，请稍后重试。") : t("暂未找到这个词。")}</p>
    ) : <>
      {shortZh && shortZh !== result.senses[0]?.definition && (
        <strong className="sl-dictionary-translation">{shortZh}</strong>
      )}
      {context && (
        <p className="sl-dictionary-context">
          {context.before}
          {context.match && <em>{context.match}</em>}
          {context.after}
        </p>
      )}
      {panel.expanded && import.meta.env.VITE_SHADOW_WEB && <WordAtlas word={panel.query} />}
      {!panel.expanded && (
        <p className="sl-dictionary-definition">
          {result.senses[0]?.definition || result.phrases[0]?.translation || t("点击单词查看完整词典。")}
        </p>
      )}
      {panel.expanded && !hasAtlas && <>
        {senseGroups.length > 0 ? (
          <div className="sl-dictionary-senses">
            {senseGroups.map((group) => (
              <div key={group.partOfSpeech || 'unk'}>
                <small>{group.partOfSpeech || t("释义")}</small>
                {group.zhTerms.length > 0 && <p className="sl-dictionary-sense-zh">{group.zhTerms.join('；')}</p>}
                {group.en.slice(0, panel.result?.detail === 'hover' ? 1 : 3).map((definition) => (
                  <p className="sl-dictionary-sense-en" key={definition}>{definition}</p>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="sl-dictionary-senses">
            <div>
              <small>{t("释义")}</small>
              <p className="sl-dictionary-sense-zh">{result.translation || t("当前结果只有翻译，没有更多英文释义。")}</p>
            </div>
          </div>
        )}
        {phraseChips.length > 0 && (
          <section className="sl-dictionary-extra">
            <small>{t("当前句搭配")}</small>
            <div className="sl-dictionary-phrases">
              {phraseChips.map((phrase) => (
                <button type="button" key={phrase} className="sl-dictionary-phrase-chip" onClick={() => onLookupPhrase(phrase)}>
                  {phrase}
                </button>
              ))}
            </div>
          </section>
        )}
        {result.phrases.filter((phrase) => !phraseChips.includes(phrase.text.toLowerCase())).length > 0 && (
          <section className="sl-dictionary-extra">
            <small>{t("短语")}</small>
            {result.phrases
              .filter((phrase) => !phraseChips.includes(normalizeDictionaryQuery(phrase.text).toLowerCase()))
              .map((phrase) => (
                <p key={phrase.text}>{phrase.text}{phrase.translation && <em>{phrase.translation}</em>}</p>
              ))}
          </section>
        )}
        {result.examples.length > 0 && (
          <section className="sl-dictionary-extra">
            <small>{t("例句")}</small>
            {result.examples.map((example, index) => (
              <p key={`${example.text}-${index}`}>{example.text}{example.translation && <em>{example.translation}</em>}</p>
            ))}
          </section>
        )}
        {result.relatedWords.length > 0 && (
          <section className="sl-dictionary-extra">
            <small>{t("相关词")}</small>
            <p>{result.relatedWords.join(' · ')}</p>
          </section>
        )}
      </>}
      {!hasAtlas && sourcesLabel && <footer><small>{sourcesLabel}</small></footer>}
    </>}
    {panel.expanded && import.meta.env.VITE_SHADOW_WEB && (!result || result.status === 'unavailable') && <WordAtlas word={panel.query} />}
  </aside>;
}

function WholeSentenceDictation({
  segment,
  translation,
  onClose,
  onReplay,
  onSubmit,
  mobileDictation = false,
  portraitFallback = false,
  onDismissPortraitFallback,
}: {
  segment: NormalizedSegment;
  translation: string;
  onClose: () => void;
  onReplay: (segment: NormalizedSegment) => void;
  onSubmit: (spans: ErrorSpan[], answer: string) => void;
  mobileDictation?: boolean;
  portraitFallback?: boolean;
  onDismissPortraitFallback?: () => void;
}) {
  const [heard, setHeard] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    onReplay(segment);
    setHeard(true);
  }, [onReplay, segment.id]);
  // Keep the soft keyboard on the answer box: a press on 重放单句 would otherwise
  // move focus off the textarea and dismiss it. Closing and submitting both end
  // the sentence, so they keep the native behaviour.
  const holdAnswerFocus = useCallback((event: React.SyntheticEvent) => {
    if (!mobileDictation || !heard) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.sl-dictation-close,.sl-sentence-submission .onb-primary')) return;
    event.preventDefault();
  }, [heard, mobileDictation]);
  const restoreAnswerFocus = useCallback(() => {
    if (!mobileDictation || !heard) return;
    const answer = stageRef.current?.querySelector<HTMLTextAreaElement>('.sl-sentence-submission textarea');
    if (!answer || !answer.isConnected) return;
    // The dialog lives in a shadow root, where document.activeElement stops at the host.
    let node: Element | null = document.activeElement;
    while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
    if (node === answer) return;
    answer.focus({ preventScroll: true });
  }, [heard, mobileDictation]);
  return <div
    className={`sl-dictation sl-dictation-whole-sentence ${portraitFallback ? (onDismissPortraitFallback ? 'sl-dictation-await-portrait' : 'sl-dictation-portrait-fallback') : ''}`}
    role="dialog"
    aria-modal="true"
    aria-label={t("整句听写")}
    onPointerDown={event => { event.stopPropagation(); holdAnswerFocus(event); }}
    onPointerUp={event => event.stopPropagation()}
    onMouseDown={event => { event.stopPropagation(); holdAnswerFocus(event); }}
    onMouseUp={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); restoreAnswerFocus(); }}
    onContextMenu={event => event.stopPropagation()}
  >
    <style>{DICTATION_PRACTICE_CSS}</style>
    <button className="sl-dictation-close" onClick={onClose} aria-label={t("关闭整句听写")} title={t("关闭（Esc）")}>×</button>
    {portraitFallback && onDismissPortraitFallback && <DictationPortraitPrompt onDismiss={onDismissPortraitFallback} />}
    <section className="sl-whole-sentence-stage" ref={stageRef}>
      <small>{t("AI 选中的值得精听句 ·")}{Math.max(1, segment.text.split(/\s+/).filter(Boolean).length)} {t("词")}</small>
      {translation && <p className="sl-whole-sentence-translation">{translation}</p>}
      <SentenceSubmission
        submissionMode="whole-sentence"
        reference={segment.text}
        heard={heard}
        autoFocus={mobileDictation}
        onSubmit={onSubmit}
      />
      <button type="button" className="sl-whole-sentence-replay" onClick={() => { onReplay(segment); setHeard(true); }}>{t("↻ 重放单句")}</button>
    </section>
  </div>;
}

function PlayerUi({ page, onCommand: sendCommand, onSelectTrack, onRetryCaptions, onLearningEvent, onDictationSubmit, embedded, persistProgress = true, dictationMode = 'guided', dictationSegmentIndex, preventDictationFullscreen = false, mobileDictation = false, dictationRequestId = 0, expandTranscriptRequestId = 0, subtitleMaskRequestId = 0, chineseSubtitleRequestId = 0, loopToggleRequestId = 0 }: PlayerUiProps) {
  const embeddedMode = Boolean(embedded);
  const webIPadDictation = embeddedMode && isIPadDevice();
  const externalDictationKeyboard = useExternalDictationKeyboard(webIPadDictation && mobileDictation);
  const [dictationPortraitDismissed, setDictationPortraitDismissed] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [enabled, setEnabled] = useState(true);
  const defaultShowChinese = embedded ? Boolean(embedded.initialChineseSubtitlesVisible) : true;
  const [showChinese, setShowChinese] = useState(defaultShowChinese);
  const [syncEditor, setSyncEditor] = useState(false);
  const [localOffset, setLocalOffset] = useState(0);
  const [displayPrefsKey, setDisplayPrefsKey] = useState('');
  const bilingual = page.platform === 'bilibili' || Boolean(page.translationCues?.length);
  const bilibiliCorpusReady = isBilibiliCorpusReady(page);
  const localPrefsKey = `bilibiliDisplay:${videoKeyOf(page)}`;
  useEffect(() => {
    if (!bilingual) return;
    let cancelled = false;
    setDisplayPrefsKey('');
    setShowChinese(defaultShowChinese); setSyncEditor(false); setLocalOffset(0);
    if (!embedded) {
      void runtimeApiCall(() => browser.storage.local.get(localPrefsKey)).then(record => {
        if (cancelled) return;
        const value = record[localPrefsKey] as Record<string, unknown> | undefined;
        if (typeof value?.showChinese === 'boolean') setShowChinese(value.showChinese);
        if (typeof value?.offset === 'number') setLocalOffset(Math.max(-30000, Math.min(30000, value.offset)));
        setDisplayPrefsKey(localPrefsKey);
      }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [localPrefsKey, bilingual, defaultShowChinese, embedded]);
  useEffect(() => {
    if (embedded || !bilingual || displayPrefsKey !== localPrefsKey) return;
    void runtimeApiCall(() => browser.storage.local.set({ [localPrefsKey]: { showChinese, offset: localOffset } })).catch(() => undefined);
  }, [bilingual, displayPrefsKey, localPrefsKey, showChinese, localOffset, embedded]);
  useEffect(() => {
    embedded?.onChineseSubtitlesVisibleChange?.(showChinese);
  }, [embedded, showChinese]);
  const previousChineseSubtitleRequest = useRef(chineseSubtitleRequestId);
  useEffect(() => {
    if (!embedded || chineseSubtitleRequestId === previousChineseSubtitleRequest.current) return;
    previousChineseSubtitleRequest.current = chineseSubtitleRequestId;
    setShowChinese(value => !value);
  }, [chineseSubtitleRequestId, embedded]);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  useLearningAnalytics(page, enabled);
  const [loop, setLoopState] = useState(false);
  const loopValue = useRef(false);
  const setLoop = (update: boolean | ((value: boolean) => boolean)) => { const next = typeof update === 'function' ? update(loopValue.current) : update; loopValue.current = next; track({ name: 'feature', platform: page.platform || 'youtube', feature: next ? 'loop_on' : 'loop_off' }); setLoopState(next); embedded?.onLoopChange?.(next); };
  const previousLoopToggleRequest = useRef(loopToggleRequestId);
  useEffect(() => {
    if (!embedded || loopToggleRequestId === previousLoopToggleRequest.current) return;
    previousLoopToggleRequest.current = loopToggleRequestId;
    setLoop(value => !value);
  }, [embedded, loopToggleRequestId]);
  const [segmentMode, setSegmentMode] = useState<SegmentMode>('learning');
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [embeddedTranscriptCollapsed, setEmbeddedTranscriptCollapsed] = useState(false);
  const [dictationOpen, setDictationOpen] = useState(false);
  const [dictationPortraitFallback, setDictationPortraitFallback] = useState(false);
  const showPortraitHint = embeddedMode
    ? showDictationPortraitHint(dictationPortraitFallback, externalDictationKeyboard, dictationPortraitDismissed)
    : dictationPortraitFallback;
  const dismissPortraitHint = useCallback(() => setDictationPortraitDismissed(true), []);
  const [dictationInitialIndex, setDictationInitialIndex] = useState(0);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [dictionaryPanel, setDictionaryPanel] = useState<DictionaryPopoverState | null>(null);
  const dictionaryPanelRef = useRef<DictionaryPopoverState | null>(null);
  const dictionaryAnchorElementRef = useRef<HTMLElement | null>(null);
  const dictionaryContainerElementRef = useRef<HTMLElement | null>(null);
  const dictionaryPopoverElementRef = useRef<HTMLDivElement | null>(null);
  const [actionToolbarPosition, setActionToolbarPosition] = useState<ActionToolbarPosition | null>(null);
  const [subtitleTop, setSubtitleTop] = useState<number | null>(null);
  const [subtitleMaskEnabled, setSubtitleMaskEnabled] = useState(false);
  const [subtitleMaskEditorOpen, setSubtitleMaskEditorOpen] = useState(false);
  const [subtitleMaskSelected, setSubtitleMaskSelected] = useState(false);
  const [subtitleMaskGeometry, setSubtitleMaskGeometry] = useState<SubtitleMaskGeometry>(DEFAULT_SUBTITLE_MASK_GEOMETRY);
  const [notice, setNotice] = useState('');
  const [savedVocabulary, setSavedVocabulary] = useState<Set<string>>(() => new Set());
  const [masteredVocabulary, setMasteredVocabulary] = useState<Set<string>>(() => new Set());
  const handledCycle = useRef('');
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activity = useRef(resetActivityTracker('', Date.now()));
  const pageRef = useRef(page);
  const settingsRef = useRef(settings);
  const captionOffsetRef = useRef(0);
  const offsetRef = useRef(0);
  offsetRef.current = bilingual ? localOffset : 0;
  captionOffsetRef.current = bilingual ? -localOffset : settings.playbackPreferences.captionOffsetMs;
  const onCommand = useCallback((value: PlayerCommand) => sendCommand(value.type === 'SEEK' ? { ...value, timeMs: Math.max(0, value.timeMs + offsetRef.current) } : value), [sendCommand]);
  const restoredVideos = useRef(new Set<string>());
  const previousPlayerState = useRef<PageState['playerState']>(page.playerState);
  const pauseOwnerSegmentId = useRef<string | null>(null);
  const pendingLoopBoundary = useRef<{ startMs: number; endMs: number } | null>(null);
  const loopEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordAttemptRef = useRef<(segment: NormalizedSegment, segmentSeq: number, trigger: AttemptInput['trigger']) => void>(() => undefined);
  const loopContextKey = `${videoKeyOf(page) ?? ''}:${page.activeTrackId ?? ''}:${segmentMode}`;
  const previousLoopContextKey = useRef(loopContextKey);
  const hoverResumeOnLeave = useRef(false);
  const hoverTarget = useRef<{ key: string; segment: NormalizedSegment; index: number } | null>(null);
  const [hoverTargetKey, setHoverTargetKey] = useState('');
  const [hoverPaused, setHoverPaused] = useState(false);
  const segmentCache = useRef<{ key: string; segments: NormalizedSegment[]; source: PageState['cues'] | PageState['segments'] } | null>(null);
  const subtitleRef = useRef<HTMLDivElement | null>(null);
  const dictationButtonRef = useRef<HTMLButtonElement | null>(null);
  const dictationFullscreenTarget = useRef<HTMLElement | null>(null);
  const dictationOwnsFullscreen = useRef(false);
  const dictationOwnsOrientation = useRef(false);
  const dictationFullscreenRequest = useRef(0);
  const subtitleMaskRef = useRef<HTMLDivElement | null>(null);
  const subtitleMaskGeometryRef = useRef(subtitleMaskGeometry);
  const subtitleMaskInteraction = useRef<SubtitleMaskInteraction | null>(null);
  const subtitleDrag = useRef<{ pointerId: number; startY: number; top: number } | null>(null);
  const actionToolbarRef = useRef<HTMLDivElement | null>(null);
  const actionToolbarDrag = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number } | null>(null);
  const dictionaryHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dictionaryCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dictionaryPointer = useRef<{ x: number; y: number } | null>(null);
  const dictionaryRequestId = useRef(0);
  const dictionaryCache = useRef(new Map<string, DictionaryResult>());
  const dictionaryAudioRequestId = useRef(0);
  const dictionaryPrefetchWindows = useRef(new Set<string>());
  const [speakingQuery, setSpeakingQuery] = useState<string | null>(null);

  pageRef.current = page;
  settingsRef.current = settings;
  subtitleMaskGeometryRef.current = subtitleMaskGeometry;
  dictionaryPanelRef.current = dictionaryPanel;

  useEffect(() => {
    if (!embedded) return;
    const embeddedHost = document.getElementById('shadow-language-player-ui');
    if (!(embeddedHost instanceof HTMLElement)) return;
    embeddedHost.style.zIndex = dictationOpen ? '10000' : '70';
    return () => { embeddedHost.style.zIndex = '70'; };
  }, [dictationOpen, embedded]);

  useEffect(() => {
    embedded?.onDictationOpenChange?.(dictationOpen);
    return () => {
      if (dictationOpen) embedded?.onDictationOpenChange?.(false);
    };
  }, [dictationOpen, embedded]);

  const firstCue = page.cues[0];
  const lastCue = page.cues.at(-1);
  const resolvedSegmentMode: SegmentMode = embedded ? (page.segments.length ? 'learning' : 'raw') : segmentMode;
  const segmentCacheKey = `${videoKeyOf(page) ?? ''}:${page.activeTrackId ?? ''}:${resolvedSegmentMode}:${page.cues.length}:${firstCue?.startMs ?? -1}:${lastCue?.endMs ?? -1}`;
  const segmentSource = resolvedSegmentMode === 'raw' ? page.cues : page.segments;
  if (segmentCache.current?.key !== segmentCacheKey || segmentCache.current.source !== segmentSource) {
    segmentCache.current = {
      key: segmentCacheKey,
      source: segmentSource,
      segments: resolvedSegmentMode === 'raw'
        ? page.cues.map((cue) => ({ id: `cue-${cue.seq}`, sourceCueIds: [String(cue.seq)], startMs: cue.startMs, endMs: cue.endMs, text: cue.text, confidence: 1, ...(cue.wordStarts?.length ? { wordStarts: cue.wordStarts } : {}) }))
        : page.segments,
    };
  }
  const segments = segmentCache.current.segments;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const captionTimeMs = page.timeMs + (bilingual ? -localOffset : settings.playbackPreferences.captionOffsetMs);
  const { segment: currentSegment, index: currentIndex } = useMemo(
    () => findSegment(segments, captionTimeMs),
    [segments, captionTimeMs],
  );
  const displayedHoverTarget = hoverTarget.current?.key === hoverTargetKey ? hoverTarget.current : null;
  const { segment: displayedSegment, index: displayedIndex } = resolveDisplayedSegment(currentSegment, currentIndex, displayedHoverTarget);
  const nlpResults = useCaptionNlp([displayedSegment?.text || '', ...segments.slice(Math.max(0, currentIndex), Math.max(0, currentIndex) + 4).map(segment => segment.text)]);
  const displayedNlp = displayedSegment ? nlpResults.get(displayedSegment.text) : undefined;
  const subtitleVisible = Boolean(
    bilibiliCorpusReady && (
      displayedSegment
      || page.error
      || (page.cues.length === 0 && page.tracks.length > 0)
    ),
  );
  const captionVocabularyProfile = useMemo(() => {
    if (!page.cues.length) return null;
    return analyzeVocabularyText(page.cues.map((cue) => cue.text).join('\n'));
  }, [page.cues]);
  const newWordCount = useMemo(() => {
    if (!captionVocabularyProfile) return null;
    return vocabularyCoverage(captionVocabularyProfile, settings.vocabularySize).newWordCount;
  }, [captionVocabularyProfile, settings.vocabularySize]);
  const subtitleDisplayMode = settings.playbackPreferences.subtitleDisplayMode;
  useEffect(() => {
    embedded?.onSubtitleDisplayModeChange?.(subtitleDisplayMode);
  }, [embedded, subtitleDisplayMode]);
  useEffect(() => {
    embedded?.onSubtitleMaskEnabledChange?.(subtitleMaskEnabled);
  }, [embedded, subtitleMaskEnabled]);

  const updateSettings = async (partial: Partial<UserSettings>) => {
    try {
      if (partial.playbackPreferences?.subtitleDisplayMode) track({ name: 'feature', platform: page.platform || 'youtube', feature: 'subtitle_' + (partial.playbackPreferences.subtitleDisplayMode === 'new-words' ? 'new' : partial.playbackPreferences.subtitleDisplayMode) });
      const next = await sendRuntime<UserSettings>({ type: 'SETTINGS_UPDATE', settings: partial });
      setSettings(next);
    } catch (error) {
      setNotice(runtimeErrorMessage(error));
    }
  };

  const command = useCallback((playerCommand: PlayerCommand) => {
    if (playerCommand.type === 'SET_RATE') track({ name: 'feature', platform: pageRef.current.platform || 'youtube', feature: 'speed' });
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = null;
    pendingLoopBoundary.current = null;
    const currentPage = pageRef.current;
    const bilingualPage = currentPage.platform === 'bilibili' || Boolean(currentPage.translationCues?.length);
    const found = findSegment(segmentsRef.current, currentPage.timeMs + (bilingualPage ? -offsetRef.current : settingsRef.current.playbackPreferences.captionOffsetMs));
    const cyclePrefix = videoKeyOf(currentPage) && found.segment ? `${videoKeyOf(currentPage)}:${found.segment.id}:` : '';
    if (playerCommand.type !== 'PLAY' || !cyclePrefix || !handledCycle.current.startsWith(cyclePrefix)) handledCycle.current = '';
    onCommand(playerCommand);
  }, [onCommand]);

  const setSubtitleHover = useCallback((phase: 'enter' | 'leave') => {
    // Hover-to-pause and sentence looping own the same playback boundary.
    // A stray pointer-leave must not cancel a loop's pending replay.
    if (loopValue.current) return;
    const currentPage = pageRef.current;
    const bilingualPage = currentPage.platform === 'bilibili' || Boolean(currentPage.translationCues?.length);
    const found = findSegment(
      segmentsRef.current,
      currentPage.timeMs + (bilingualPage ? -offsetRef.current : settingsRef.current.playbackPreferences.captionOffsetMs),
    );
    if (phase === 'enter') {
      if (hoverTarget.current) return;
      if (!settingsRef.current.playbackPreferences.showTranscript || !videoKeyOf(currentPage) || !found.segment) return;
      const key = `${videoKeyOf(currentPage)}:${currentPage.activeTrackId ?? ''}:${found.segment.id}`;
      hoverTarget.current = { key, segment: found.segment, index: found.index };
      hoverResumeOnLeave.current = subtitleHoverTransition('enter', currentPage.playerState, false).resumeOnLeave;
      setHoverPaused(false);
      setHoverTargetKey(key);
      if (pauseTimer.current) clearTimeout(pauseTimer.current);
      pauseTimer.current = null;
      pendingLoopBoundary.current = null;
      return;
    }
    hoverTarget.current = null;
    setHoverPaused(false);
    setHoverTargetKey('');
    if (hoverEndTimer.current) clearTimeout(hoverEndTimer.current);
    hoverEndTimer.current = null;
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = null;
    pendingLoopBoundary.current = null;
    const transition = subtitleHoverTransition('leave', currentPage.playerState, hoverResumeOnLeave.current);
    hoverResumeOnLeave.current = transition.resumeOnLeave;
    if (transition.command) onCommand({ type: transition.command });
  }, [onCommand]);

  const goSegment = useCallback((index: number, play = false) => {
    const target = segments[index];
    if (!target) return;
    window.dispatchEvent(new CustomEvent('shadow-language:onboarding-action', { detail: 'seek' }));
    command({ type: 'SEEK', timeMs: target.startMs });
    if (play) window.setTimeout(() => onCommand({ type: 'PLAY' }), 30);
  }, [command, onCommand, segments]);

  const replayDictationSegment = useCallback((segment: NormalizedSegment) => {
    command({ type: 'SEEK', timeMs: segment.startMs });
    window.setTimeout(() => onCommand({ type: 'PLAY' }), 30);
  }, [command, onCommand]);

  const lockDictationPortrait = useCallback(async () => {
    if (!mobileDictation || (embeddedMode ? !webIPadDictation : !mobileDictationViewport())) return;
    setDictationPortraitFallback(!portraitDictationViewport(embeddedMode));
    // Web shows a dismissible suggestion. Locking first would rotate iPads
    // before external-keyboard input can be detected or the hint dismissed.
    if (embeddedMode) return;
    const orientation = dictationOrientation();
    if (!orientation?.lock) return;
    try {
      await orientation.lock('portrait');
      dictationOwnsOrientation.current = true;
      setDictationPortraitFallback(false);
    } catch {
      setDictationPortraitFallback(!portraitDictationViewport());
    }
  }, [embeddedMode, mobileDictation, webIPadDictation]);

  const enterDictationFullscreen = useCallback(() => {
    const host = document.getElementById('shadow-language-player-ui');
    const target = host?.parentElement;
    if (!(target instanceof HTMLElement)) {
      void lockDictationPortrait();
      return;
    }
    const requestId = dictationFullscreenRequest.current + 1;
    dictationFullscreenRequest.current = requestId;
    dictationFullscreenTarget.current = target;
    dictationOwnsFullscreen.current = false;
    if (!embeddedMode && mobileDictation && mobileDictationViewport()) setDictationPortraitFallback(!portraitDictationViewport());
    if (document.fullscreenElement) {
      void lockDictationPortrait();
      return;
    }
    try {
      void target.requestFullscreen().then(() => {
        if (dictationFullscreenRequest.current !== requestId) {
          if (document.fullscreenElement === target) void document.exitFullscreen().catch(() => undefined);
          return;
        }
        dictationOwnsFullscreen.current = document.fullscreenElement === target;
        void lockDictationPortrait();
      }).catch(() => setNotice(t("浏览器未能进入全屏，可再次点击听写重试。")));
    } catch {
      setNotice(t("浏览器未能进入全屏，可再次点击听写重试。"));
    }
  }, [embeddedMode, lockDictationPortrait, mobileDictation]);

  const exitDictationFullscreen = useCallback(() => {
    dictationFullscreenRequest.current += 1;
    const target = dictationFullscreenTarget.current;
    const owned = dictationOwnsFullscreen.current;
    dictationFullscreenTarget.current = null;
    dictationOwnsFullscreen.current = false;
    if (dictationOwnsOrientation.current) {
      try { dictationOrientation()?.unlock?.(); } catch { /* unsupported browser */ }
      dictationOwnsOrientation.current = false;
    }
    setDictationPortraitFallback(false);
    if (owned && target && document.fullscreenElement === target) void document.exitFullscreen().catch(() => undefined);
  }, []);

  const openDictation = useCallback(() => {
    if (!segments.length) return;
    if (!preventDictationFullscreen) enterDictationFullscreen();
    else void lockDictationPortrait();
    if (loopValue.current) setLoop(false);
    if (!embedded) setTranscriptOpen(false);
    setSelection(null);
    setDictionaryPanel(null);
    setSubtitleHover('leave');
    setDictationInitialIndex(dictationSegmentIndex ?? (displayedIndex >= 0 ? displayedIndex : Math.max(0, currentIndex)));
    setDictationOpen(true);
    onLearningEvent?.('dictation-open');
    track({ name: 'feature', platform: pageRef.current.platform || 'youtube', feature: 'dictation_open' });
  }, [currentIndex, dictationSegmentIndex, displayedIndex, embedded, enterDictationFullscreen, lockDictationPortrait, onLearningEvent, preventDictationFullscreen, segments.length, setSubtitleHover]);

  const closeDictation = useCallback(() => {
    setDictationOpen(false);
    onCommand({ type: 'PAUSE' });
    exitDictationFullscreen();
    window.requestAnimationFrame(() => dictationButtonRef.current?.focus());
  }, [exitDictationFullscreen, onCommand]);

  const previousDictationRequest = useRef(dictationRequestId);
  useEffect(() => {
    if (!embedded || dictationRequestId === previousDictationRequest.current) return;
    previousDictationRequest.current = dictationRequestId;
    openDictation();
  }, [dictationRequestId, embedded, openDictation]);

  useEffect(() => {
    embedded?.onTranscriptCollapsedChange?.(embeddedTranscriptCollapsed);
  }, [embedded, embeddedTranscriptCollapsed]);

  const previousExpandTranscriptRequest = useRef(expandTranscriptRequestId);
  useEffect(() => {
    if (!embedded || expandTranscriptRequestId === previousExpandTranscriptRequest.current) return;
    previousExpandTranscriptRequest.current = expandTranscriptRequestId;
    setEmbeddedTranscriptCollapsed(false);
  }, [embedded, expandTranscriptRequestId]);

  useEffect(() => {
    if (!dictationOpen) return;
    const handleFullscreenChange = () => {
      const target = dictationFullscreenTarget.current;
      if (!dictationOwnsFullscreen.current || (target && (document.fullscreenElement === target || target.contains(document.fullscreenElement)))) return;
      exitDictationFullscreen();
      setDictationOpen(false);
      onCommand({ type: 'PAUSE' });
      window.requestAnimationFrame(() => dictationButtonRef.current?.focus());
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [dictationOpen, exitDictationFullscreen, onCommand]);

  useEffect(() => {
    if (!dictationOpen || !mobileDictation) return;
    const sync = () => {
      setDictationPortraitFallback((embeddedMode ? webIPadDictation : mobileDictationViewport()) && !portraitDictationViewport(embeddedMode));
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, [dictationOpen, embeddedMode, mobileDictation, webIPadDictation]);

  useEffect(() => () => exitDictationFullscreen(), [exitDictationFullscreen]);

  const selectTranscriptText = useCallback((nextSelection: { text: string; segment: NormalizedSegment; index: number }) => {
    setSelection({ ...nextSelection, origin: 'transcript' });
  }, []);

  const selectSubtitleText = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!displayedSegment) return;
    const text = selectedTextIn(event.currentTarget);
    if (!text || text.length > 500) return;
    setSelection({ text, segment: displayedSegment, index: displayedIndex, origin: 'subtitle' });
  }, [displayedIndex, displayedSegment]);

  const dictionaryAnchor = useCallback((element: HTMLElement, container: HTMLElement | null, origin: DictionaryPopoverState['origin'], panelSize?: { width: number; height: number }) => {
    if (!container) return { anchor: { left: 0, top: 0 }, placement: 'above' as const, maxHeight: 360 };
    const containerRect = container.getBoundingClientRect();
    const wordRect = element.getBoundingClientRect();
    const margin = 12;
    const gap = 9;
    const boundsTop = Math.max(containerRect.top, margin);
    const boundsBottom = Math.min(containerRect.bottom, window.innerHeight - margin);
    const availableAbove = Math.max(0, wordRect.top - boundsTop - gap);
    const availableBelow = Math.max(0, boundsBottom - wordRect.bottom - gap);
    // Never ask for less than the designed card height: judging the side by the
    // short loading placeholder and then by the loaded card flips the placement
    // mid-hover, which moves the panel out from under the pointer.
    const desiredHeight = Math.max(panelSize?.height || 0, origin === 'transcript' ? 300 : 240);
    const wordCenter = wordRect.top + wordRect.height / 2;
    const preferBelow = wordCenter < boundsTop + Math.max(0, boundsBottom - boundsTop) / 2;
    const placement: DictionaryPopoverState['placement'] = preferBelow
      ? (availableBelow >= desiredHeight || availableBelow >= availableAbove ? 'below' : 'above')
      : (availableAbove >= desiredHeight || availableAbove >= availableBelow ? 'above' : 'below');
    const availableHeight = placement === 'below' ? availableBelow : availableAbove;
    const panelWidth = Math.min(panelSize?.width || (origin === 'transcript' ? 360 : 330), Math.max(1, containerRect.width - margin * 2));
    const minLeft = margin + panelWidth / 2;
    const maxLeft = Math.max(minLeft, containerRect.width - margin - panelWidth / 2);
    return {
      anchor: {
        left: Math.max(minLeft, Math.min(maxLeft, wordRect.left - containerRect.left + wordRect.width / 2)),
        top: Math.max(margin, placement === 'below' ? wordRect.bottom - containerRect.top : wordRect.top - containerRect.top),
      },
      placement,
      maxHeight: Math.max(1, Math.floor(availableHeight)),
    };
  }, []);

  const repositionDictionary = useCallback(() => {
    const panel = dictionaryPanelRef.current;
    const element = dictionaryAnchorElementRef.current;
    const container = dictionaryContainerElementRef.current;
    const popover = dictionaryPopoverElementRef.current;
    if (!panel || !element || !container || !popover || !element.isConnected || !container.isConnected) return;
    const next = dictionaryAnchor(element, container, panel.origin, { width: popover.offsetWidth, height: popover.scrollHeight });
    setDictionaryPanel((current) => {
      if (!current) return current;
      if (current.placement === next.placement && current.anchor.left === next.anchor.left && current.anchor.top === next.anchor.top && current.maxHeight === next.maxHeight) return current;
      return { ...current, ...next };
    });
  }, [dictionaryAnchor]);

  useLayoutEffect(() => {
    if (!dictionaryPanel) return;
    repositionDictionary();
    const update = () => window.requestAnimationFrame(repositionDictionary);
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (dictionaryContainerElementRef.current) observer?.observe(dictionaryContainerElementRef.current);
    if (dictionaryPopoverElementRef.current) observer?.observe(dictionaryPopoverElementRef.current);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
      observer?.disconnect();
    };
  }, [dictionaryPanel?.expanded, dictionaryPanel?.query, dictionaryPanel?.result, repositionDictionary]);

  const clearDictionaryTimers = () => {
    if (dictionaryHoverTimer.current) clearTimeout(dictionaryHoverTimer.current);
    if (dictionaryCloseTimer.current) clearTimeout(dictionaryCloseTimer.current);
    dictionaryHoverTimer.current = null;
    dictionaryCloseTimer.current = null;
  };

  const closeDictionary = useCallback(() => {
    clearDictionaryTimers();
    dictionaryRequestId.current += 1;
    dictionaryAudioRequestId.current += 1;
    cancelEnglishSpeech();
    setSpeakingQuery(null);
    setDictionaryPanel(null);
    dictionaryAnchorElementRef.current = null;
    dictionaryContainerElementRef.current = null;
  }, []);

  const dictionaryOpen = dictionaryPanel !== null;
  useEffect(() => {
    if (!dictionaryOpen) return;
    const dismissOutsideDictionary = (event: PointerEvent) => {
      const path = event.composedPath();
      if (path.some(target => target === dictionaryPopoverElementRef.current || target === dictionaryAnchorElementRef.current)) return;
      closeDictionary();
    };
    document.addEventListener('pointerdown', dismissOutsideDictionary, true);
    // Pointer events are composed, so this also sees moves that cross into the
    // popover shadow root. Kept in a ref because only the close decision reads it.
    const trackDictionaryPointer = (event: PointerEvent) => { dictionaryPointer.current = { x: event.clientX, y: event.clientY }; };
    // Leaving the window (or entering the video iframe) produces no further moves,
    // so drop the last position instead of letting the close poll reuse it.
    const forgetDictionaryPointer = (event: PointerEvent) => { if (!event.relatedTarget) dictionaryPointer.current = null; };
    document.addEventListener('pointermove', trackDictionaryPointer, true);
    document.addEventListener('pointerout', forgetDictionaryPointer, true);
    // Clicks inside a cross-origin video iframe do not bubble to this document.
    window.addEventListener('blur', closeDictionary);
    return () => {
      document.removeEventListener('pointerdown', dismissOutsideDictionary, true);
      document.removeEventListener('pointermove', trackDictionaryPointer, true);
      document.removeEventListener('pointerout', forgetDictionaryPointer, true);
      window.removeEventListener('blur', closeDictionary);
    };
  }, [dictionaryOpen, closeDictionary]);

  // The subtitle and the popover live in different shadow roots, so the pointer
  // enter/leave pair between them can be missed or delivered out of order.
  // Deciding to close by hit testing the live rectangles keeps the panel open
  // for as long as the pointer is genuinely on the word or on the panel.
  const pointerOverDictionary = useCallback(() => {
    const pointer = dictionaryPointer.current;
    if (!pointer) return false;
    return [dictionaryAnchorElementRef.current, dictionaryPopoverElementRef.current].some((element) => {
      if (!element?.isConnected) return false;
      const bounds = element.getBoundingClientRect();
      return pointer.x >= bounds.left && pointer.x <= bounds.right && pointer.y >= bounds.top && pointer.y <= bounds.bottom;
    });
  }, []);

  const scheduleDictionaryClose = useCallback(() => {
    if (dictionaryCloseTimer.current) clearTimeout(dictionaryCloseTimer.current);
    const scheduled = dictionaryPanelRef.current;
    const settle = () => {
      if (pointerOverDictionary()) {
        dictionaryCloseTimer.current = setTimeout(settle, 120);
        return;
      }
      dictionaryCloseTimer.current = null;
      setDictionaryPanel((panel) => panel && panel === scheduled && !panel.pinned ? null : panel);
    };
    dictionaryCloseTimer.current = setTimeout(settle, 240);
  }, [pointerOverDictionary]);

  const findDictionaryQuery = useCallback((term: string, wordIndex?: number) => {
    const normalizedTerm = normalizeDictionaryQuery(term).toLowerCase();
    if (!displayedSegment || wordIndex === undefined) return normalizedTerm;
    const candidates = displayedNlp ? captionNlpPhrases(displayedNlp, wordIndex, 5) : centeredCaptionPhraseCandidates(displayedSegment.text, wordIndex, 5);
    for (const candidate of candidates) {
      const hover = dictionaryCache.current.get(dictionaryResultKey(candidate, 'hover'));
      const full = dictionaryCache.current.get(dictionaryResultKey(candidate, 'full'));
      const result = full || hover;
      if (result?.status === 'found' && (result.translation || result.senses.length || result.phrases.length)) return candidate;
    }
    return normalizedTerm;
  }, [displayedSegment, displayedNlp]);

  const openDictionary = useCallback((term: string, element: HTMLElement, expanded: boolean, wordIndex?: number, source?: { segment: NormalizedSegment; index: number; origin: DictionaryPopoverState['origin'] }) => {
    clearDictionaryTimers();
    // A click is an explicit request for the token under the pointer. Nearby
    // phrase matching is useful for passive hover previews, but letting it
    // rewrite click queries makes every cached phrase hide the actual word.
    const query = expanded
      ? normalizeDictionaryQuery(term).toLowerCase()
      : findDictionaryQuery(term, wordIndex);
    if (!query) return;
    track({ name: 'feature', platform: page.platform || 'youtube', feature: expanded ? 'lookup_click' : 'lookup_hover' });
    const requestId = ++dictionaryRequestId.current;
    const hoverCached = dictionaryCache.current.get(dictionaryResultKey(query, 'hover'));
    const fullCached = dictionaryCache.current.get(dictionaryResultKey(query, 'full'));
    const cached = expanded ? (fullCached || hoverCached) : (hoverCached || fullCached);
    const needsRequest = expanded ? !fullCached : !hoverCached && !fullCached;
    const sourceSegment = source?.segment || displayedSegment;
    const sourceIndex = source?.index ?? displayedIndex;
    const origin = source?.origin || 'subtitle';
    const container = (embedded?.popover as HTMLElement | undefined)
      || (origin === 'transcript' ? element.closest<HTMLElement>('.sl-transcript') : subtitleRef.current);
    dictionaryAnchorElementRef.current = element;
    dictionaryContainerElementRef.current = container;
    const { anchor, placement, maxHeight } = dictionaryAnchor(element, container, origin);
    const phraseCandidates = expanded
      ? selectPhraseCandidates(sourceSegment?.text || '', wordIndex, query, 3)
      : [];
    setDictionaryPanel({
      query,
      result: cached ? withDictionaryContext(cached, sourceSegment?.text) : null,
      loading: needsRequest,
      expanded,
      pinned: expanded,
      anchor,
      placement,
      maxHeight,
      origin,
      ...(sourceSegment ? { sourceSegment, sourceIndex } : {}),
      ...(phraseCandidates.length ? { phraseCandidates } : {}),
    });
    if (!needsRequest) return;
    if (expanded && !cached) void sendRuntime<DictionaryResult>({ type: 'DICTIONARY_LOOKUP', text: query, detail: 'hover' }).then((preview) => {
      if (requestId !== dictionaryRequestId.current || preview.status !== 'found') return;
      setDictionaryPanel((panel) => panel?.query === query && panel.loading && !panel.result ? { ...panel, result: withDictionaryContext(preview, sourceSegment?.text) } : panel);
    }).catch(() => {});
    void sendRuntime<DictionaryResult>({ type: 'DICTIONARY_LOOKUP', text: query, detail: expanded ? 'full' : 'hover', ...(sourceSegment?.text ? { contextText: sourceSegment.text } : {}) })
      .then((result) => {
        if (requestId !== dictionaryRequestId.current) return;
        if (result.status === 'found') dictionaryCache.current.set(dictionaryResultKey(result.query, result.detail), withoutDictionaryContext(result));
        setDictionaryPanel((panel) => panel?.query === query ? { ...panel, result: withDictionaryContext(result, sourceSegment?.text), loading: false } : panel);
      })
      .catch(() => {
        if (requestId !== dictionaryRequestId.current) return;
        const unavailable: DictionaryResult = { query, lemma: query.toLowerCase(), detail: expanded ? 'full' : 'hover', translation: null, phonetic: null, audioUrl: null, senses: [], examples: [], phrases: [], relatedWords: [], etymology: null, status: 'unavailable', sources: {}, cachedAt: new Date().toISOString() };
        setDictionaryPanel((panel) => panel?.query === query ? { ...panel, result: panel.result?.status === 'found' ? panel.result : unavailable, loading: false } : panel);
      });
  }, [dictionaryAnchor, displayedIndex, displayedSegment, embedded?.popover, findDictionaryQuery]);

  const onWordEnter = useCallback((term: string, element: HTMLElement, wordIndex: number) => {
    clearDictionaryTimers();
    dictionaryHoverTimer.current = setTimeout(() => {
      dictionaryHoverTimer.current = null;
      openDictionary(term, element, false, wordIndex);
    }, 180);
  }, [openDictionary]);

  const onWordLeave = useCallback(() => {
    if (dictionaryHoverTimer.current) clearTimeout(dictionaryHoverTimer.current);
    dictionaryHoverTimer.current = null;
    scheduleDictionaryClose();
  }, [scheduleDictionaryClose]);

  const onWordClick = useCallback((term: string, element: HTMLElement, wordIndex: number) => {
    clearDictionaryTimers();
    openDictionary(term, element, true, wordIndex);
  }, [openDictionary]);

  const lookupDictionaryPhrase = useCallback((phrase: string) => {
    const element = dictionaryAnchorElementRef.current;
    if (!element || !phrase.trim()) return;
    openDictionary(phrase, element, true, undefined, dictionaryPanel?.sourceSegment
      ? { segment: dictionaryPanel.sourceSegment, index: dictionaryPanel.sourceIndex ?? displayedIndex, origin: dictionaryPanel.origin }
      : undefined);
  }, [dictionaryPanel, displayedIndex, openDictionary]);

  const speakDictionary = useCallback((term: string) => {
    const query = normalizeDictionaryQuery(term).toLowerCase();
    if (!query) return;
    const requestId = ++dictionaryAudioRequestId.current;
    if (speakingQuery === query) {
      cancelEnglishSpeech();
      setSpeakingQuery(null);
      return;
    }
    cancelEnglishSpeech();
    setSpeakingQuery(query);
    const onSpeechEnd = () => {
      if (requestId === dictionaryAudioRequestId.current) setSpeakingQuery(null);
    };
    const started = speakEnglish(query, { rate: 0.82, onend: onSpeechEnd, onerror: onSpeechEnd });
    if (!started) setSpeakingQuery(null);
  }, [speakingQuery]);

  const onTranscriptWordClick = useCallback((term: string, element: HTMLElement, wordIndex: number, segment: NormalizedSegment, index: number) => {
    openDictionary(term, element, true, wordIndex, { segment, index, origin: 'transcript' });
    speakDictionary(term);
  }, [openDictionary, speakDictionary]);

  const recordAttempt = async (segment: NormalizedSegment, segmentSeq: number, trigger: AttemptInput['trigger']) => {
    const identity = playerPersistenceIdentity(page);
    if (page.activeTrackId?.startsWith('preview:') || !identity || segmentSeq < 0) return;
    const attempt: AttemptInput = {
      id: `attempt_${randomId()}`,
      ...identity,
      ...(page.thumbnailUrl ? { thumbnailUrl: page.thumbnailUrl } : {}),
      trackId: page.activeTrackId,
      segmentSeq,
      startMs: Math.max(0, segment.startMs + offsetRef.current),
      endMs: Math.max(1, segment.endMs + offsetRef.current),
      mode: loop ? 'loop' : 'manual',
      trigger,
      occurredAt: new Date().toISOString(),
    };
    await sendRuntime({ type: 'ATTEMPT_RECORD', attempt });
    onLearningEvent?.(trigger === 'loop' ? 'loop' : 'replay');
  };
  recordAttemptRef.current = recordAttempt;

  const cancelLoopCycle = () => {
    if (loopEndTimer.current) clearTimeout(loopEndTimer.current);
    loopEndTimer.current = null;
  };

  const runLoopCycle = (target: { segment: NormalizedSegment; index: number }) => {
    const snapshot = pageRef.current;
    const effectiveTimeMs = snapshot.timeMs + captionOffsetRef.current;
    const decision = resolveLoopCycle(target.segment, effectiveTimeMs, snapshot.playbackRate);
    // The deadline arrived early (decode stall): wait for the real boundary
    // instead of cutting the sentence short.
    if (decision === 'wait') {
      scheduleLoopCycle(target, subtitleHoverDelay(target.segment.endMs, effectiveTimeMs, snapshot.playbackRate));
      return;
    }
    // The clock left this sentence for good: a real seek or a context switch.
    if (decision === 'cancel') return;
    loopEndTimer.current = null;
    handledCycle.current = `${videoKeyOf(snapshot) ?? ''}:${target.segment.id}:`;
    void recordAttemptRef.current(target.segment, target.index, 'loop');
    onCommand({ type: 'PAUSE' });
    pendingLoopBoundary.current = { startMs: target.segment.startMs, endMs: target.segment.endMs };
    pauseTimer.current = setTimeout(() => {
      pauseTimer.current = null;
      pendingLoopBoundary.current = null;
      onCommand({ type: 'SEEK', timeMs: target.segment.startMs });
      onCommand({ type: 'PLAY' });
      handledCycle.current = '';
    }, 500);
  };

  const scheduleLoopCycle = (target: { segment: NormalizedSegment; index: number }, delayMs: number) => {
    cancelLoopCycle();
    if (delayMs <= 0) {
      runLoopCycle(target);
      return;
    }
    loopEndTimer.current = setTimeout(() => runLoopCycle(target), delayMs);
  };

  const replayDisplayedSentence = () => {
    const target = hoverTarget.current
      ?? (displayedSegment && displayedIndex >= 0
        ? { key: '', segment: displayedSegment, index: displayedIndex }
        : null);
    if (!target) return;
    if (hoverEndTimer.current) clearTimeout(hoverEndTimer.current);
    hoverEndTimer.current = null;
    hoverResumeOnLeave.current = false;
    void recordAttempt(target.segment, target.index, 'manual_replay');
    onCommand({ type: 'SEEK', timeMs: target.segment.startMs });
    onCommand({ type: 'PLAY' });
  };

  const saveAsset = async (kind: SavedItemInput['kind'], value: string, sourceSegment = displayedSegment, sourceIndex = displayedIndex, dictionaryEntry?: DictionaryResult) => {
    if (!sourceSegment || !value.trim()) return false;
    if (page.platform === 'media') {
      if (kind !== 'word') {
        setNotice(t("当前语料请选中单个单词保存到词库。"));
        return false;
      }
      await sendRuntime({ type: 'VOCABULARY_SAVE', input: mediaVocabularyWordInput(videoKeyOf(page), value, sourceSegment.text, {
        ...(dictionaryEntry?.lemma ? { lemma: dictionaryEntry.lemma } : {}),
        ...(dictionaryMeaningZh(dictionaryEntry) ? { translation: dictionaryMeaningZh(dictionaryEntry)! } : {}),
        ...(dictionaryEntry?.phonetic ? { phonetic: dictionaryEntry.phonetic } : {}),
      }) });
      onLearningEvent?.('asset-saved');
      setNotice(t("已保存到背词队列"));
      return true;
    }
    const identity = playerPersistenceIdentity(page);
    if (!identity) return false;
    const firstSense = dictionaryEntry?.senses[0];
    const item: SavedItemInput = {
      id: `item_${randomId()}`,
      kind,
      normalizedValue: value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
      displayValue: value.trim(),
      ...identity,
      ...(page.thumbnailUrl ? { thumbnailUrl: page.thumbnailUrl } : {}),
      trackId: page.activeTrackId,
      segmentSeq: sourceIndex,
      startMs: Math.max(0, sourceSegment.startMs + offsetRef.current),
      contextText: sourceSegment.text,
      note: '',
      ...(dictionaryMeaningZh(dictionaryEntry) ? { meaningZh: dictionaryMeaningZh(dictionaryEntry)! } : {}),
      ...(dictionaryEntry?.lemma ? { lemma: dictionaryEntry.lemma } : {}),
      ...(firstSense?.partOfSpeech ? { partOfSpeech: firstSense.partOfSpeech } : {}),
      ...(dictionaryEntry?.phonetic ? { pronunciation: dictionaryEntry.phonetic } : {}),
      ...(dictionaryEntry && Object.values(dictionaryEntry.sources).filter(Boolean).length ? { dictionarySource: Object.values(dictionaryEntry.sources).filter(Boolean).join(' · ') } : {}),
      occurredAt: new Date().toISOString(),
    };
    await sendRuntime({ type: 'ASSET_SAVE', item });
    onLearningEvent?.('asset-saved');
    setNotice(t("已保存"));
    return true;
  };

  const saveSelection = async () => {
    if (!selection) return;
    try {
      const kind = selection.text.split(/\s+/).length === 1 ? 'word' : 'phrase';
      if (!await saveAsset(kind, selection.text, selection.segment, selection.index)) return;
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      setNotice(runtimeErrorMessage(error));
    }
  };

  const saveDictionaryResult = async (result: DictionaryResult) => {
    try {
      const kind = result.query.split(/\s+/).filter(Boolean).length > 1 ? 'phrase' : 'word';
      if (await saveAsset(kind, result.query, dictionaryPanel?.sourceSegment || displayedSegment, dictionaryPanel?.sourceIndex ?? displayedIndex, result)) closeDictionary();
    } catch (error) {
      setNotice(runtimeErrorMessage(error));
    }
  };

  const markDictionaryResultKnown = async (result: DictionaryResult) => {
    const query = normalizeDictionaryQuery(result.query).toLowerCase();
    if (!query || /\s/.test(query)) return;
    try {
      const contextText = result.contextText || displayedSegment?.text;
      await sendRuntime({
        type: 'VOCABULARY_MARK_KNOWN',
        input: {
          word: query,
          ...(result.lemma ? { lemma: result.lemma } : {}),
          ...(dictionaryMeaningZh(result) ? { translation: dictionaryMeaningZh(result)! } : {}),
          ...(result.phonetic ? { phonetic: result.phonetic } : {}),
          source: videoKeyOf(page) ? `subtitle:${videoKeyOf(page)}` : 'subtitle',
          ...(contextText ? { contextText } : {}),
        },
      });
      setMasteredVocabulary((current) => new Set([...current, ...dictionaryVocabularyKeys(result)]));
      setNotice(t("已标记为已掌握，字幕高亮已移除"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshVocabulary = useCallback(async () => {
    try {
      const state = await sendRuntime<VocabularyState>({ type: 'VOCABULARY_STATE_GET' });
      setSavedVocabulary(new Set((state.cards || []).flatMap((card) => vocabularyTermKeys(card.word, card.lemma))));
      setMasteredVocabulary(new Set((state.masteredLemmas || []).map((word) => word.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' '))));
    } catch {
      // Vocabulary state is an enhancement; a read failure must not hide subtitles.
    }
  }, []);

  useEffect(() => {
    void refreshVocabulary();
  }, [refreshVocabulary]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      sendRuntime<UserSettings>({ type: 'SETTINGS_GET' }),
      runtimeApiCall(() => browser.storage.local.get(['youtubeOverlayEnabled', 'youtubeTranscriptDrawerOpen', ACTION_TOOLBAR_POSITION_KEY, SUBTITLE_MASK_STORAGE_KEY])),
    ]).then(([savedSettings, storage]) => {
      if (cancelled) return;
      setSettings(savedSettings);
      setEnabled(playerOverlayEnabled(embeddedMode, storage.youtubeOverlayEnabled));
      setTranscriptOpen(Boolean(embedded) || storage.youtubeTranscriptDrawerOpen === true);
      const savedToolbarPosition = storage[ACTION_TOOLBAR_POSITION_KEY];
      if (savedToolbarPosition && typeof savedToolbarPosition === 'object') {
        const { left, top } = savedToolbarPosition as Partial<ActionToolbarPosition>;
        if (typeof left === 'number' && Number.isFinite(left) && typeof top === 'number' && Number.isFinite(top)) {
          setActionToolbarPosition({ left: Math.max(ACTION_TOOLBAR_EDGE, left), top: Math.max(ACTION_TOOLBAR_EDGE, top) });
        }
      }
      const savedMask = storage[SUBTITLE_MASK_STORAGE_KEY];
      if (savedMask && typeof savedMask === 'object') {
        setSubtitleMaskGeometry(clampSubtitleMaskGeometry(savedMask as Partial<SubtitleMaskGeometry>));
      }
      if (savedSettings.playbackPreferences.playbackRate !== pageRef.current.playbackRate) onCommand({ type: 'SET_RATE', rate: savedSettings.playbackPreferences.playbackRate });
    }).catch((error) => setNotice(runtimeErrorMessage(error)));
    const onRuntimeMessage = (message: RuntimeMessage) => {
      if (message.type === 'AUTH_INVALIDATED') {
        setNotice(t("已切换为本地模式。"));
      }
      if (message.type === 'AUTH_CHANGED') {
        if (message.settings) {
          setSettings(message.settings);
        }
        return;
      }
      if (message.type === 'VOCABULARY_CHANGED') {
        void refreshVocabulary();
        return;
      }
      if (message.type !== 'PLAYER_SHORTCUT') return;
      if (message.action === 'toggle-loop') setLoop((value) => !value);
      if (message.action === 'cycle-mode') {
        const current = settingsRef.current;
        const playbackPreferences = {
          ...current.playbackPreferences,
          showTranscript: true,
          subtitleDisplayMode: cycleSubtitleDisplayMode(current.playbackPreferences.subtitleDisplayMode),
        };
        setSelection(null);
        closeDictionary();
        setSettings({ ...current, playbackPreferences });
        void updateSettings({ playbackPreferences });
      }
      if (message.action === 'toggle-transcript') {
        const current = settingsRef.current;
        const showTranscript = !current.playbackPreferences.showTranscript;
        void updateSettings({ playbackPreferences: { ...current.playbackPreferences, showTranscript } });
      }
    };
    try {
      browser.runtime.onMessage.addListener(onRuntimeMessage);
    } catch (error) {
      setNotice(runtimeErrorMessage(error));
    }
    return () => {
      cancelled = true;
      try {
        browser.runtime.onMessage.removeListener(onRuntimeMessage);
      } catch {
        // Chrome removes listeners when an extension context is invalidated.
      }
    };
  }, [embeddedMode, refreshVocabulary]);

  useEffect(() => {
    if (!enabled || !settings.playbackPreferences.showTranscript || !videoKeyOf(page) || currentIndex < 0 || !segments.length) return;
    const windowKey = `${videoKeyOf(page)}:${page.activeTrackId || ''}:${segmentMode}:${currentIndex}:${nlpResults.size}`;
    if (dictionaryPrefetchWindows.current.has(windowKey)) return;
    const windowSegments = segments.slice(currentIndex, currentIndex + 4);
    const texts = [...new Set(windowSegments.flatMap((segment) => {
      const nlp = nlpResults.get(segment.text);
      return nlp ? nlp.tokens.flatMap(token => token.lookupText ? [token.lookupText] : []) : captionDictionaryTerms(segment.text);
    }))].slice(0, 60);
    const phrases = [...new Set(windowSegments.flatMap((segment) => captionPhraseCandidates(segment.text, 5, 4)))].slice(0, 16);
    if (!texts.length && !phrases.length) return;
    dictionaryPrefetchWindows.current.add(windowKey);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void sendRuntime<{ results: DictionaryResult[] }>({ type: 'DICTIONARY_PREFETCH', texts, ...(phrases.length ? { phrases } : {}) })
        .then((payload) => {
          if (cancelled) return;
          for (const result of payload.results || []) if (result.status === 'found') dictionaryCache.current.set(dictionaryResultKey(result.query, result.detail), result);
        })
        .catch(() => { dictionaryPrefetchWindows.current.delete(windowKey); });
    }, 80);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [currentIndex, enabled, page.activeTrackId, videoKeyOf(page), segmentMode, segments, settings.playbackPreferences.showTranscript, nlpResults]);

  useEffect(() => {
    if (!enabled || dictationOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Space' || event.key === ' ' || event.repeat) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const action = shortcutActionForKey(settings.playbackPreferences.pageShortcuts, event.key);
      if (!action) return;
      if (action === 'cycleMode') return;
      if (action === 'previousSegment') goSegment(Math.max(0, displayedIndex - 1));
      if (action === 'nextSegment') goSegment(Math.min(segments.length - 1, Math.max(0, displayedIndex) + 1));
      if (action === 'replaySegment' && displayedSegment) {
        if (hoverPaused) replayDisplayedSentence();
        else {
          void recordAttempt(displayedSegment, displayedIndex, 'manual_replay');
          goSegment(displayedIndex, true);
        }
      }
      if (action === 'togglePlayback') {
        if (hoverResumeOnLeave.current && pageRef.current.playerState !== 'playing') replayDisplayedSentence();
        else command({ type: pageRef.current.playerState === 'playing' ? 'PAUSE' : 'PLAY' });
      }
      if (action === 'saveCurrent' && displayedSegment) void saveAsset('pattern', displayedSegment.text, displayedSegment, displayedIndex);
      if (action === 'toggleTranscript') void updateSettings({ playbackPreferences: { ...settings.playbackPreferences, showTranscript: !settings.playbackPreferences.showTranscript } });
      if (action === 'toggleLoop') setLoop((value) => !value);
      if (action === 'decreaseSpeed' || action === 'increaseSpeed') {
        const currentRate = pageRef.current.playbackRate;
        const currentRateIndex = PLAYBACK_RATES.reduce((closestIndex, candidate, candidateIndex) => (
          Math.abs(candidate - currentRate) < Math.abs(PLAYBACK_RATES[closestIndex]! - currentRate) ? candidateIndex : closestIndex
        ), 0);
        const nextRateIndex = Math.min(
          PLAYBACK_RATES.length - 1,
          Math.max(0, currentRateIndex + (action === 'increaseSpeed' ? 1 : -1)),
        );
        const rate = PLAYBACK_RATES[nextRateIndex]!;
        command({ type: 'SET_RATE', rate });
        void updateSettings({ playbackPreferences: { ...settings.playbackPreferences, playbackRate: rate } });
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dictationOpen, displayedSegment?.id, displayedIndex, enabled, hoverPaused, settings.playbackPreferences, segments]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 2400);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (hoverEndTimer.current) clearTimeout(hoverEndTimer.current);
    hoverEndTimer.current = null;
    const target = hoverTarget.current;
    if (!target || target.key !== hoverTargetKey || loop || page.playerState !== 'playing' || hoverResumeOnLeave.current) return;
    const effectiveTimeMs = page.timeMs + (bilingual ? -localOffset : settings.playbackPreferences.captionOffsetMs);
    const delayMs = subtitleHoverDelay(target.segment.endMs, effectiveTimeMs, page.playbackRate);
    const pauseAtSentenceEnd = () => {
      hoverEndTimer.current = null;
      if (hoverTarget.current?.key !== target.key || pageRef.current.playerState !== 'playing' || hoverResumeOnLeave.current) return;
      const transition = subtitleHoverTransition('sentence-end', pageRef.current.playerState, false);
      hoverResumeOnLeave.current = transition.resumeOnLeave;
      if (!transition.command) return;
      setHoverPaused(true);
      onCommand({ type: transition.command });
    };
    if (delayMs === 0) pauseAtSentenceEnd();
    else hoverEndTimer.current = setTimeout(pauseAtSentenceEnd, delayMs);
    return () => {
      if (hoverEndTimer.current) clearTimeout(hoverEndTimer.current);
      hoverEndTimer.current = null;
    };
  }, [hoverTargetKey, loop, page.timeMs, page.playerState, page.playbackRate, (bilingual ? -localOffset : settings.playbackPreferences.captionOffsetMs), onCommand]);

  // Sentence looping cannot rely on a page snapshot landing in the last 100ms of a
  // sentence: the page only reports 4–10 times a second, so that window is missed
  // more often than it is hit and the loop stops after a few repetitions. Schedule
  // the boundary in wall time from the remaining duration and decide on arrival.
  useEffect(() => {
    const cyclePrefix = videoKeyOf(page) && currentSegment ? `${videoKeyOf(page)}:${currentSegment.id}:` : '';
    if (loop && cyclePrefix && page.playerState === 'playing' && !pauseTimer.current && !hoverTarget.current
      && !handledCycle.current.startsWith(cyclePrefix)) {
      const target = { segment: currentSegment!, index: currentIndex };
      const delayMs = subtitleHoverDelay(currentSegment!.endMs, captionTimeMs, page.playbackRate);
      if (delayMs > LOOP_EARLY_TOLERANCE_MS) scheduleLoopCycle(target, delayMs);
      else runLoopCycle(target);
    }
    return () => cancelLoopCycle();
  }, [captionTimeMs, currentIndex, currentSegment?.id, loop, page.playerState, page.playbackRate]);

  useEffect(() => {
    if (previousPlayerState.current === 'paused' && page.playerState === 'playing' && pauseTimer.current) {
      clearTimeout(pauseTimer.current);
      pauseTimer.current = null;
      pendingLoopBoundary.current = null;
      // Resumed inside the replay gap. Drop the dedupe mark with the pending
      // replay, otherwise this sentence stays unlooped until the segment changes.
      handledCycle.current = '';
    }
    previousPlayerState.current = page.playerState;
  }, [page.playerState]);

  useEffect(() => {
    const nextSegmentId = currentSegment?.id || null;
    if (pauseOwnerSegmentId.current && pauseOwnerSegmentId.current !== nextSegmentId && pauseTimer.current) {
      const boundary = pendingLoopBoundary.current;
      // The clock can enter the next cue (or a gap) before our PAUSE snapshot
      // arrives. That is still the same loop cycle, not a user seek.
      if (!boundary || shouldCancelPendingLoopReplay(boundary, page.timeMs)) {
        clearTimeout(pauseTimer.current);
        pauseTimer.current = null;
        pendingLoopBoundary.current = null;
        // The mark belongs to the cancelled cycle. Keeping it would block this
        // sentence until the segment changes, with no way back.
        handledCycle.current = '';
      }
    }
    if (pauseOwnerSegmentId.current !== nextSegmentId) handledCycle.current = '';
    pauseOwnerSegmentId.current = nextSegmentId;
  }, [currentSegment?.id, page.timeMs]);

  useEffect(() => {
    const contextChanged = previousLoopContextKey.current !== loopContextKey;
    previousLoopContextKey.current = loopContextKey;
    if (contextChanged || !loop) {
      if (pauseTimer.current) clearTimeout(pauseTimer.current);
      pauseTimer.current = null;
      pendingLoopBoundary.current = null;
      cancelLoopCycle();
    }
    if (hoverEndTimer.current) clearTimeout(hoverEndTimer.current);
    hoverEndTimer.current = null;
    hoverTarget.current = null;
    setHoverPaused(false);
    setHoverTargetKey('');
    hoverResumeOnLeave.current = false;
    handledCycle.current = '';
    setSelection(null);
    clearDictionaryTimers();
    dictionaryRequestId.current += 1;
    setDictionaryPanel(null);
    dictionaryPrefetchWindows.current.clear();
  }, [loopContextKey, loop]);

  useEffect(() => {
    setDictationOpen(false);
    exitDictationFullscreen();
  }, [videoKeyOf(page), page.activeTrackId, segmentMode, exitDictationFullscreen]);

  useEffect(() => {
    if (dictionaryPanelRef.current?.origin === 'transcript') return;
    dictionaryRequestId.current += 1;
    setDictionaryPanel(null);
    dictionaryAudioRequestId.current += 1;
    cancelEnglishSpeech();
    setSpeakingQuery(null);
  }, [currentSegment?.id]);

  useEffect(() => {
    const subtitleCanShowWords = settings.playbackPreferences.showTranscript && settings.playbackPreferences.subtitleDisplayMode !== 'hidden';
    if (!enabled || !subtitleCanShowWords) closeDictionary();
    if (enabled && subtitleCanShowWords) return;
    if (!hoverTarget.current && !hoverResumeOnLeave.current) return;
    hoverTarget.current = null;
    setHoverPaused(false);
    setHoverTargetKey('');
    if (hoverEndTimer.current) clearTimeout(hoverEndTimer.current);
    hoverEndTimer.current = null;
    const transition = subtitleHoverTransition('leave', pageRef.current.playerState, hoverResumeOnLeave.current);
    hoverResumeOnLeave.current = false;
    if (transition.command) onCommand({ type: transition.command });
  }, [enabled, settings.playbackPreferences.showTranscript, settings.playbackPreferences.subtitleDisplayMode, closeDictionary, onCommand]);

  useEffect(() => () => {
    if (hoverEndTimer.current) clearTimeout(hoverEndTimer.current);
    clearDictionaryTimers();
    dictionaryRequestId.current += 1;
    dictionaryAudioRequestId.current += 1;
    cancelEnglishSpeech();
    if (hoverResumeOnLeave.current) onCommand({ type: 'PLAY' });
  }, [onCommand]);

  useEffect(() => {
    const identity = playerPersistenceIdentity(page);
    if (!persistProgress || page.activeTrackId?.startsWith('preview:') || !identity || currentIndex < 0) return;
    if (activity.current.youtubeId !== videoKeyOf(page)) activity.current = resetActivityTracker(videoKeyOf(page), Date.now());
    void sendRuntime({ type: 'PROGRESS_SAVE', localOnly: true, progress: {
      ...identity,
      ...(page.thumbnailUrl ? { thumbnailUrl: page.thumbnailUrl } : {}),
      ...(page.title ? { title: page.title } : {}),
      ...(page.channelTitle ? { channelTitle: page.channelTitle } : {}),
      ...(page.durationMs ? { durationMs: page.durationMs } : {}),
      trackId: page.activeTrackId,
      segmentSeq: currentIndex,
      positionMs: page.timeMs,
      completedRatio: page.durationMs ? Math.min(1, page.timeMs / page.durationMs) : 0,
      activeSecondsDelta: 0,
      occurredAt: new Date().toISOString(),
    } }).catch(() => undefined);
  }, [videoKeyOf(page), page.platform, page.activeTrackId, currentIndex, persistProgress]);

  useEffect(() => {
    if (!videoKeyOf(page) || restoredVideos.current.has(videoKeyOf(page))) return;
    restoredVideos.current.add(videoKeyOf(page));
    void db.progress.get(videoKeyOf(page)).then((progress) => {
      if (progress && progress.positionMs >= 3_000 && pageRef.current.timeMs < 2_000) {
        sendCommand({ type: 'SEEK', timeMs: progress.positionMs });
      }
    });
  }, [videoKeyOf(page)]);

  const englishTracks = sortEnglishCaptionTracks(page.tracks);
  const supportedWatchPage = Boolean(embedded) || page.platform === 'bilibili' || isSupportedVideoContext({
    pathname: location.pathname,
    ...(typeof page.isLive === 'boolean' ? { isLive: page.isLive } : {}),
    ...(page.playabilityStatus ? { playabilityStatus: page.playabilityStatus } : {}),
    tracks: page.tracks,
  });
  const toggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    void runtimeApiCall(() => browser.storage.local.set({ youtubeOverlayEnabled: next })).catch((error) => setNotice(runtimeErrorMessage(error)));
  };
  const setTranscriptDrawer = (value: boolean) => {
    setTranscriptOpen(value);
    void runtimeApiCall(() => browser.storage.local.set({ youtubeTranscriptDrawerOpen: value })).catch((error) => setNotice(runtimeErrorMessage(error)));
  };
  const prepareAgentPanel = (panel: 'agent' | 'words' = 'agent') => { void sendRuntime({ type: 'AGENT_PREPARE', panel }).catch(() => undefined); };
  const agentPanelIntent = { onPointerEnter: () => prepareAgentPanel(), onFocus: () => prepareAgentPanel(), onPointerDown: () => prepareAgentPanel() };
  const highlightForAgent = async () => {
    if (!selection) return;
    try {
      await sendRuntime({ type: 'AGENT_HIGHLIGHT', reference: { id: randomId(), videoKey: videoKeyOf(page), title: page.title, url: page.canonicalUrl || location.href, startMs: Math.max(0, selection.segment.startMs + offsetRef.current), endMs: Math.max(1, selection.segment.endMs + offsetRef.current), text: selection.segment.text, highlight: selection.text, trackId: page.activeTrackId, createdAt: Date.now() } });
      setSelection(null); setNotice(t("已加入笔记")); setTranscriptDrawer(false);
    } catch (error) { setAgentError(runtimeErrorMessage(error)); }
  };
  const openNewWordPanel = () => {
    setTranscriptDrawer(false);
    void sendRuntime<{ opened: boolean }>({ type: 'OPEN_NEW_WORD_PANEL' }).catch((error) => setNotice(runtimeErrorMessage(error)));
  };
  const cycleSubtitleDisplay = () => {
    const current = settingsRef.current;
    const playbackPreferences = {
      ...current.playbackPreferences,
      showTranscript: true,
      subtitleDisplayMode: cycleSubtitleDisplayMode(current.playbackPreferences.subtitleDisplayMode),
    };
    setSelection(null);
    closeDictionary();
    // Switching the learning aid is local UI state first. Cloud settings may
    // take longer to sync, but that must not delay the learner's next replay.
    setSettings({ ...current, playbackPreferences });
    void updateSettings({
      playbackPreferences,
    });
  };
  const readActionToolbarPosition = (): ActionToolbarPosition | null => {
    const toolbar = actionToolbarRef.current;
    const shell = toolbar?.closest<HTMLElement>('.sl-shell');
    if (!toolbar || !shell) return null;
    const shellBounds = shell.getBoundingClientRect();
    const toolbarBounds = toolbar.getBoundingClientRect();
    const maxLeft = Math.max(ACTION_TOOLBAR_EDGE, shellBounds.width - toolbarBounds.width - ACTION_TOOLBAR_EDGE);
    const maxTop = Math.max(ACTION_TOOLBAR_EDGE, shellBounds.height - toolbarBounds.height - ACTION_TOOLBAR_EDGE);
    return {
      left: Math.min(maxLeft, Math.max(ACTION_TOOLBAR_EDGE, toolbarBounds.left - shellBounds.left)),
      top: Math.min(maxTop, Math.max(ACTION_TOOLBAR_EDGE, toolbarBounds.top - shellBounds.top)),
    };
  };
  const moveActionToolbar = (drag: NonNullable<typeof actionToolbarDrag.current>, clientX: number, clientY: number) => {
    const toolbar = actionToolbarRef.current;
    const shell = toolbar?.closest<HTMLElement>('.sl-shell');
    if (!toolbar || !shell) return null;
    const shellBounds = shell.getBoundingClientRect();
    const toolbarBounds = toolbar.getBoundingClientRect();
    const maxLeft = Math.max(ACTION_TOOLBAR_EDGE, shellBounds.width - toolbarBounds.width - ACTION_TOOLBAR_EDGE);
    const maxTop = Math.max(ACTION_TOOLBAR_EDGE, shellBounds.height - toolbarBounds.height - ACTION_TOOLBAR_EDGE);
    const next = {
      left: Math.min(maxLeft, Math.max(ACTION_TOOLBAR_EDGE, drag.left + clientX - drag.startX)),
      top: Math.min(maxTop, Math.max(ACTION_TOOLBAR_EDGE, drag.top + clientY - drag.startY)),
    };
    setActionToolbarPosition(next);
    return next;
  };
  const onActionToolbarPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    const position = readActionToolbarPosition();
    if (!position) return;
    actionToolbarDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, ...position };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const onActionToolbarPointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
    const drag = actionToolbarDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveActionToolbar(drag, event.clientX, event.clientY);
    event.preventDefault();
  };
  const finishActionToolbarDrag = (event: React.PointerEvent<HTMLSpanElement>) => {
    const drag = actionToolbarDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = moveActionToolbar(drag, event.clientX, event.clientY);
    actionToolbarDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (position) void runtimeApiCall(() => browser.storage.local.set({ [ACTION_TOOLBAR_POSITION_KEY]: position })).catch((error) => setNotice(runtimeErrorMessage(error)));
  };
  const actionToolbarStyle = actionToolbarPosition
    ? { left: `${actionToolbarPosition.left}px`, top: `${actionToolbarPosition.top}px`, right: 'auto', bottom: 'auto' }
    : undefined;
  useEffect(() => {
    if (!actionToolbarPosition) return;
    const clampPosition = () => {
      const next = readActionToolbarPosition();
      if (!next || (Math.abs(next.left - actionToolbarPosition.left) < .5 && Math.abs(next.top - actionToolbarPosition.top) < .5)) return;
      setActionToolbarPosition(next);
    };
    const frame = window.requestAnimationFrame(clampPosition);
    window.addEventListener('resize', clampPosition);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', clampPosition);
    };
  }, [actionToolbarPosition]);
  const readSubtitleTop = (): number | null => {
    const subtitle = subtitleRef.current;
    const shell = subtitle?.closest<HTMLElement>('.sl-shell');
    if (!subtitle || !shell) return null;
    const shellBounds = shell.getBoundingClientRect();
    const subtitleBounds = subtitle.getBoundingClientRect();
    const maxTop = Math.max(SUBTITLE_EDGE, shellBounds.height - subtitleBounds.height - SUBTITLE_EDGE);
    return Math.min(maxTop, Math.max(SUBTITLE_EDGE, subtitleBounds.top - shellBounds.top));
  };
  const moveSubtitle = (drag: NonNullable<typeof subtitleDrag.current>, clientY: number) => {
    const subtitle = subtitleRef.current;
    const shell = subtitle?.closest<HTMLElement>('.sl-shell');
    if (!subtitle || !shell) return null;
    const shellBounds = shell.getBoundingClientRect();
    const subtitleBounds = subtitle.getBoundingClientRect();
    const maxTop = Math.max(SUBTITLE_EDGE, shellBounds.height - subtitleBounds.height - SUBTITLE_EDGE);
    const next = Math.min(maxTop, Math.max(SUBTITLE_EDGE, drag.top + clientY - drag.startY));
    setSubtitleTop(next);
    return next;
  };
  const onSubtitlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const top = readSubtitleTop();
    if (top === null) return;
    subtitleDrag.current = { pointerId: event.pointerId, startY: event.clientY, top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const onSubtitlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = subtitleDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveSubtitle(drag, event.clientY);
    event.preventDefault();
  };
  const finishSubtitleDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = subtitleDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const top = moveSubtitle(drag, event.clientY);
    subtitleDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (top !== null) setSubtitleTop(top);
  };
  const resetSubtitlePosition = () => {
    subtitleDrag.current = null;
    setSubtitleTop(null);
  };
  const defaultSubtitleStyle: React.CSSProperties = {
    left: '50%',
    right: 'auto',
    top: 'auto',
    bottom: embedded ? 'var(--web-caption-bottom, 8px)' : 80,
    transform: 'translateX(-50%)',
  };
  const subtitleStyle: React.CSSProperties = subtitleTop !== null ? {
    ...defaultSubtitleStyle,
    top: subtitleTop,
    bottom: 'auto',
  } : defaultSubtitleStyle;
  useEffect(() => {
    if (subtitleTop === null || !subtitleVisible) return;
    const clampPosition = () => {
      const next = readSubtitleTop();
      if (next === null || Math.abs(next - subtitleTop) < .5) return;
      setSubtitleTop(next);
    };
    const frame = window.requestAnimationFrame(clampPosition);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampPosition);
    if (subtitleRef.current) observer?.observe(subtitleRef.current);
    const shell = subtitleRef.current?.closest<HTMLElement>('.sl-shell');
    if (shell) observer?.observe(shell);
    window.addEventListener('resize', clampPosition);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', clampPosition);
    };
  }, [subtitleTop, subtitleVisible]);
  const persistSubtitleMask = (geometry: SubtitleMaskGeometry) => {
    void runtimeApiCall(() => browser.storage.local.set({ [SUBTITLE_MASK_STORAGE_KEY]: geometry })).catch((error) => setNotice(runtimeErrorMessage(error)));
  };
  const applySubtitleMaskGeometry = (geometry: SubtitleMaskGeometry, persist = false) => {
    const next = clampSubtitleMaskGeometry(geometry);
    subtitleMaskGeometryRef.current = next;
    setSubtitleMaskGeometry(next);
    if (persist) persistSubtitleMask(next);
    return next;
  };
  const toggleSubtitleMask = () => {
    const next = !subtitleMaskEnabled;
    setSubtitleMaskEnabled(next);
    setSubtitleMaskEditorOpen(next);
    setSubtitleMaskSelected(false);
    subtitleMaskInteraction.current = null;
    persistSubtitleMask(subtitleMaskGeometryRef.current);
    track({ name: 'feature', platform: page.platform || 'youtube', feature: next ? 'subtitle_mask_on' : 'subtitle_mask_off' });
  };
  const previousSubtitleMaskRequest = useRef(subtitleMaskRequestId);
  useEffect(() => {
    if (!embedded || subtitleMaskRequestId === previousSubtitleMaskRequest.current) return;
    previousSubtitleMaskRequest.current = subtitleMaskRequestId;
    toggleSubtitleMask();
  }, [embedded, subtitleMaskRequestId, toggleSubtitleMask]);
  useEffect(() => {
    if (!subtitleMaskEnabled || !subtitleMaskEditorOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSubtitleMaskEditorOpen(false);
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [subtitleMaskEnabled, subtitleMaskEditorOpen]);
  useEffect(() => {
    if (!subtitleMaskEnabled || !subtitleMaskSelected) return;
    const deselectOutsideMask = (event: PointerEvent) => {
      const mask = subtitleMaskRef.current;
      if (mask && !event.composedPath().includes(mask)) setSubtitleMaskSelected(false);
    };
    document.addEventListener('pointerdown', deselectOutsideMask, true);
    return () => document.removeEventListener('pointerdown', deselectOutsideMask, true);
  }, [subtitleMaskEnabled, subtitleMaskSelected]);
  const beginSubtitleMaskInteraction = (event: React.PointerEvent<HTMLElement>, mode: SubtitleMaskInteraction['mode'], handle?: SubtitleMaskResizeHandle) => {
    if (!subtitleMaskEnabled || event.button !== 0) return;
    const mask = subtitleMaskRef.current;
    const shell = mask?.closest<HTMLElement>('.sl-shell');
    const bounds = shell?.getBoundingClientRect();
    if (!mask || !bounds?.width || !bounds.height) return;
    setSubtitleMaskSelected(true);
    subtitleMaskInteraction.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      shellWidth: bounds.width,
      shellHeight: bounds.height,
      geometry: subtitleMaskGeometryRef.current,
      mode,
      ...(handle ? { handle } : {}),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const moveSubtitleMaskInteraction = (event: React.PointerEvent<HTMLElement>) => {
    const interaction = subtitleMaskInteraction.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return null;
    const deltaX = (event.clientX - interaction.startX) / interaction.shellWidth * 100;
    const deltaY = (event.clientY - interaction.startY) / interaction.shellHeight * 100;
    const next = interaction.mode === 'move'
      ? moveSubtitleMaskGeometry(interaction.geometry, deltaX, deltaY)
      : resizeSubtitleMaskGeometry(interaction.geometry, interaction.handle!, deltaX, deltaY);
    applySubtitleMaskGeometry(next);
    event.preventDefault();
    event.stopPropagation();
    return next;
  };
  const finishSubtitleMaskInteraction = (event: React.PointerEvent<HTMLElement>) => {
    const interaction = subtitleMaskInteraction.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const next = moveSubtitleMaskInteraction(event) || subtitleMaskGeometryRef.current;
    subtitleMaskInteraction.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    persistSubtitleMask(next);
  };
  const updateSubtitleMaskField = (field: keyof SubtitleMaskGeometry, value: number) => {
    if (!Number.isFinite(value)) return;
    applySubtitleMaskGeometry({ ...subtitleMaskGeometryRef.current, [field]: value }, true);
  };
  const resetSubtitleMask = () => {
    subtitleMaskInteraction.current = null;
    applySubtitleMaskGeometry(DEFAULT_SUBTITLE_MASK_GEOMETRY, true);
  };
  const learningControls = <div className="sl-controls sl-compact-controls" role="toolbar" aria-label={t("字幕学习控制")}>
    <button className={subtitleDisplayMode !== 'all' ? 'active' : ''} aria-label={t("切换英文字幕显示，当前{0}", t(subtitleDisplayModeLabel[subtitleDisplayMode]))} onClick={cycleSubtitleDisplay} title={t("切换：英文 → 只看生词 → 全部遮盖")}>{t(subtitleDisplayModeLabel[subtitleDisplayMode])}</button>
    <button ref={dictationButtonRef} className={dictationOpen ? 'active' : ''} aria-pressed={dictationOpen} disabled={!segments.length} onClick={openDictation} title={t("逐句播放并逐词听写")}>{t("听写")}</button>
    <button className={subtitleMaskEnabled ? 'active' : ''} aria-pressed={subtitleMaskEnabled} onClick={toggleSubtitleMask} title={subtitleMaskEnabled ? t("关闭遮挡板") : t("打开可拖动、可缩放的遮挡板")}>{t("遮挡板")}</button>
    <button className={loop ? 'active' : ''} aria-pressed={loop} onClick={() => setLoop((value) => !value)} title={loop ? t("关闭单句循环") : t("开启单句循环")}>{t("循环")}</button>
    <button className={transcriptOpen ? 'active' : ''} aria-pressed={transcriptOpen} onClick={() => setTranscriptDrawer(!transcriptOpen)} title={transcriptOpen ? t("关闭字幕列表") : t("打开字幕列表")}>{t("列表")}</button>
    <ShortcutHelp shortcuts={settings.playbackPreferences.pageShortcuts} />
    <details className="sl-more" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); event.stopPropagation(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }}>
      <summary aria-label={t("更多学习操作")}>{t("更多")}</summary>
      <div className="sl-more-panel">
        <label title={t("播放速度")}><span>{page.playbackRate.toFixed(1)}×</span><select value={page.playbackRate} onChange={(event) => { const rate = Number(event.target.value); onCommand({ type: 'SET_RATE', rate }); void updateSettings({ playbackPreferences: { ...settings.playbackPreferences, playbackRate: rate } }); }}>{PLAYBACK_RATES.map((rate) => <option key={rate} value={rate}>{rate.toFixed(1)}×</option>)}</select></label>
        {newWordCount !== null && <button type="button" className="sl-new-word-count" aria-label={t("生词数：{0}", newWordCount)} aria-haspopup="dialog" disabled={newWordCount === 0} onPointerEnter={() => prepareAgentPanel('words')} onFocus={() => prepareAgentPanel('words')} onPointerDown={() => prepareAgentPanel('words')} onClick={openNewWordPanel} title={t("打开生词列表")}>{t("生词数：")}{newWordCount}</button>}
        {page.platform !== 'media' && <button onClick={() => displayedSegment && void saveAsset('pattern', displayedSegment.text, displayedSegment, displayedIndex)} disabled={!displayedSegment} title={t("保存当前句")}>{t("收藏本句")}</button>}
        {page.error && <button onClick={() => void onRetryCaptions()} title={t("重试字幕")}>{t("重试")}</button>}
        {englishTracks.length > 1 && <label className="sl-track" title={t("英文字幕轨道")}><span>{t("字幕轨道")}</span><select value={page.activeTrackId || ''} onChange={(event) => void onSelectTrack(event.target.value)}>{englishTracks.map((track) => <option key={track.id} value={track.id}>{track.label} · {track.kind === 'manual' ? t("人工") : t("自动")}</option>)}</select></label>}
        {bilingual && <button aria-label={t("显示中文字幕")} aria-pressed={showChinese} className={showChinese ? 'active' : ''} onClick={() => setShowChinese(value => !value)}>{showChinese ? t("隐藏中文") : t("显示中文")}</button>}
        {bilingual && <button aria-label={t("调整字幕时间")} aria-expanded={syncEditor} onClick={() => setSyncEditor(value => !value)}>{t("校时")}</button>}
      </div>
    </details>
  </div>;

  const dictionaryPopover = dictionaryPanel && <DictionaryPopover
    panel={dictionaryPanel}
    popoverRef={dictionaryPopoverElementRef}
    onClose={closeDictionary}
    onSave={(result) => { void saveDictionaryResult(result); }}
    onMarkKnown={(result) => { void markDictionaryResultKnown(result); }}
    mastered={Boolean(dictionaryPanel.result && dictionaryVocabularyKeys(dictionaryPanel.result).some((key) => masteredVocabulary.has(key)))}
    onSpeak={speakDictionary}
    onLookupPhrase={lookupDictionaryPhrase}
    speaking={speakingQuery === dictionaryPanel.query}
    onPointerEnter={() => { if (dictionaryCloseTimer.current) clearTimeout(dictionaryCloseTimer.current); dictionaryCloseTimer.current = null; }}
    onPointerLeave={scheduleDictionaryClose}
  />;

  const transcriptPanel = <aside className={`sl-transcript ${embeddedTranscriptCollapsed ? 'is-collapsed' : ''}`}>
          {!embedded && <header><div><button className={segmentMode === 'learning' ? 'active' : ''} onClick={() => setSegmentMode('learning')}>{t("学习句段")}</button><button className={segmentMode === 'raw' ? 'active' : ''} onClick={() => setSegmentMode('raw')}>{t("原始字幕")}</button></div><button onClick={() => setTranscriptDrawer(false)} title={t("关闭字幕列表")}><Icon name="close" /></button></header>}
          {selection?.origin === 'transcript' && <><button className="sl-save-selection" onClick={() => { void saveSelection(); }}>{t("保存选中：")}{selection.text.slice(0, 24)}</button><button className="sl-save-selection" {...agentPanelIntent} onClick={() => void highlightForAgent()}>{t("划线 · 记笔记")}</button></>}
          <TranscriptRows segments={segments} displayMode={subtitleDisplayMode} showEnglish={settings.playbackPreferences.showTranscript} translations={bilingual && showChinese ? segments.map(segment => translatedSegmentText(page.translationCues || [], segment)) : []} currentIndex={displayedIndex} emptyText={page.error || t("正在加载英文字幕…")} vocabularySize={settings.vocabularySize} masteredVocabulary={masteredVocabulary} {...(embedded ? { collapsed: embeddedTranscriptCollapsed, onToggleCollapsed: () => setEmbeddedTranscriptCollapsed(value => !value), onWordClick: onTranscriptWordClick } : {})} onSeek={goSegment} onSelect={selectTranscriptText} />
          {dictionaryPanel?.origin === 'transcript' && !embedded?.popover && dictionaryPopover}
        </aside>;
  const wholeSentenceSegment = segments[Math.max(0, Math.min(segments.length - 1, dictationInitialIndex))] || null;
  const submitWholeSentence = (spans: ErrorSpan[], answer: string) => {
    if (!wholeSentenceSegment) return;
    onDictationSubmit?.({ segment: wholeSentenceSegment, answer, spans });
    onLearningEvent?.('dictation-submitted');
    closeDictation();
  };

  return <>
    <style>{PLAYER_CSS}{embedded ? EMBEDDED_OVERLAY_CSS : ''}</style>
    <div className={`sl-shell ${enabled ? 'sl-enabled' : ''} ${bilingual ? 'sl-bilibili' : ''}`} onClick={event => { if (bilingual) event.stopPropagation(); }} onDoubleClick={event => { if (bilingual) event.stopPropagation(); }}>
      {!embedded && bilibiliCorpusReady && <>
        {agentError && <div className="sl-notice" onClick={() => setAgentError('')}>{agentError}</div>}
        <div ref={actionToolbarRef} className="sl-action-toolbar" style={actionToolbarStyle} hidden={dictationOpen}>
          <span className="sl-action-toolbar-drag" onPointerDown={onActionToolbarPointerDown} onPointerMove={onActionToolbarPointerMove} onPointerUp={finishActionToolbarDrag} onPointerCancel={finishActionToolbarDrag} title={t("拖动操作条")} aria-label={t("拖动操作条")}><Icon name="grip" /></span>
          <button className="sl-master" onClick={toggleEnabled} title={enabled ? t("关闭 Shadow Language") : t("开启 Shadow Language")}><span>SL</span>{enabled ? 'ON' : 'OFF'}</button>
          {videoKeyOf(page) && <button className="sl-agent-button" {...agentPanelIntent} onClick={() => void sendRuntime({ type: 'AGENT_OPEN' }).catch(error => setAgentError(runtimeErrorMessage(error)))} title={t("学习 Agent")}>AI</button>}
          {enabled && videoKeyOf(page) && supportedWatchPage && !embedded && learningControls}
        </div>
      </>}
      {embedded && createPortal(<><style>{PLAYER_CSS}{EMBEDDED_CSS}</style>{learningControls}</>, embedded.controls)}
      {enabled && page.error && !videoKeyOf(page) && <div className="sl-notice">{page.error}</div>}
      {enabled && videoKeyOf(page) && supportedWatchPage && bilibiliCorpusReady && <>
        {subtitleMaskEnabled && <div
          className="sl-hard-subtitle-mask"
          style={{ left: `${subtitleMaskGeometry.left}%`, top: `${subtitleMaskGeometry.top}%`, width: `${subtitleMaskGeometry.width}%`, height: `${subtitleMaskGeometry.height}%` }}
          aria-hidden="true"
        />}
        {subtitleMaskEnabled && <div
          ref={subtitleMaskRef}
          className={`sl-mask-editor-surface${subtitleMaskSelected ? ' is-selected' : ''}`}
          style={{ left: `${subtitleMaskGeometry.left}%`, top: `${subtitleMaskGeometry.top}%`, width: `${subtitleMaskGeometry.width}%`, height: `${subtitleMaskGeometry.height}%` }}
          aria-label={t("调整视频内嵌字幕遮挡板")}
          aria-pressed={subtitleMaskSelected}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSubtitleMaskSelected(true); }
            if (event.key === 'Escape') { event.stopPropagation(); setSubtitleMaskSelected(false); }
          }}
          onPointerDown={(event) => beginSubtitleMaskInteraction(event, 'move')}
          onPointerMove={moveSubtitleMaskInteraction}
          onPointerUp={finishSubtitleMaskInteraction}
          onPointerCancel={finishSubtitleMaskInteraction}
          onClick={(event) => {
            setSubtitleMaskSelected(true);
            event.stopPropagation();
          }}
          onDoubleClick={(event) => {
            setSubtitleMaskEditorOpen(true);
            event.stopPropagation();
          }}
        >
          {subtitleMaskSelected && <div className="sl-mask-instruction">
            <span>{t("拖动移动 · 拖拽边缘缩放")}</span>
            {!subtitleMaskEditorOpen && <button
              type="button"
              className="sl-mask-instruction-btn"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setSubtitleMaskEditorOpen(true);
              }}
              title={t("打开遮挡板设置")}
            >
              {t("设置")}</button>}
          </div>}
          {subtitleMaskSelected && SUBTITLE_MASK_HANDLES.map((handle) => <span
            key={handle}
            className={`sl-mask-resize-handle is-${handle}`}
            aria-hidden="true"
            onPointerDown={(event) => beginSubtitleMaskInteraction(event, 'resize', handle)}
            onPointerMove={moveSubtitleMaskInteraction}
            onPointerUp={finishSubtitleMaskInteraction}
            onPointerCancel={finishSubtitleMaskInteraction}
          />)}
        </div>}
        {notice && <div className="sl-notice">{notice}</div>}
        {dictationOpen && dictationMode === 'whole-sentence' && wholeSentenceSegment
          ? <WholeSentenceDictation
            segment={wholeSentenceSegment}
            translation={translatedSegmentText(page.translationCues || [], wholeSentenceSegment)}
            onClose={closeDictation}
            onReplay={replayDictationSegment}
            onSubmit={submitWholeSentence}
            mobileDictation={mobileDictation}
            portraitFallback={showPortraitHint}
            {...(webIPadDictation ? { onDismissPortraitFallback: dismissPortraitHint } : {})}
          />
          : dictationOpen && <DictationPractice
            vocabularySize={settings.vocabularySize}
            savedVocabulary={savedVocabulary}
            masteredVocabulary={masteredVocabulary}
            segments={segments}
            initialSegmentIndex={dictationInitialIndex}
            captionTimeMs={captionTimeMs}
            playerState={page.playerState}
            playbackRate={page.playbackRate}
            subtitleMaskEnabled={subtitleMaskEnabled}
            translationFor={(segment) => translatedSegmentText(page.translationCues || [], segment)}
            onClose={closeDictation}
            onPause={(segment) => {
              onCommand({ type: 'PAUSE' });
              command({ type: 'SEEK', timeMs: segment.startMs });
            }}
            onReplay={replayDictationSegment}
            onToggleSubtitleMask={toggleSubtitleMask}
            mobileInput={mobileDictation}
            portraitFallback={showPortraitHint}
            {...(webIPadDictation ? { onDismissPortraitFallback: dismissPortraitHint } : {})}
            preserveMobileKeyboard={webIPadDictation}
            viewportDock={embeddedMode && mobileDictation}
            onPlaybackRateChange={(rate) => {
              command({ type: 'SET_RATE', rate });
              void updateSettings({ playbackPreferences: { ...settings.playbackPreferences, playbackRate: rate } });
            }}
          />}
        {!dictationOpen && transcriptOpen && (embedded ? createPortal(<><style>{PLAYER_CSS}{EMBEDDED_CSS}</style>{transcriptPanel}</>, embedded.transcript) : transcriptPanel)}
        {embedded?.popover && dictionaryPanel && createPortal(<><style>{PLAYER_CSS}{EMBEDDED_CSS}</style>{dictionaryPopover}</>, embedded.popover)}
        {!dictationOpen && subtitleVisible && <div
          ref={subtitleRef}
          className="sl-subtitle"
          style={subtitleStyle}
          aria-live="polite"
          onMouseUp={selectSubtitleText}
          onMouseEnter={() => setSubtitleHover('enter')}
          onPointerOver={() => { if (!hoverTarget.current) setSubtitleHover('enter'); }}
          onPointerMove={() => { if (!hoverTarget.current) setSubtitleHover('enter'); }}
          onPointerLeave={() => { setSubtitleHover('leave'); onWordLeave(); }}
          onMouseLeave={() => { if (hoverTarget.current || hoverResumeOnLeave.current) setSubtitleHover('leave'); onWordLeave(); }}
        >
          {displayedSegment && <button type="button" className="sl-subtitle-replay" onClick={(event) => { event.stopPropagation(); replayDisplayedSentence(); }} title={t("重播这一句")} aria-label={t("重播这一句")}><Icon name="play" /></button>}
          <button className="sl-subtitle-drag" onPointerDown={onSubtitlePointerDown} onPointerMove={onSubtitlePointerMove} onPointerUp={finishSubtitleDrag} onPointerCancel={finishSubtitleDrag} title={t("上下拖动字幕")} aria-label={t("上下拖动字幕")}><Icon name="grip" /></button>
          {subtitleTop !== null && <button className="sl-subtitle-reset" onClick={(event) => { event.stopPropagation(); resetSubtitlePosition(); }} title={t("恢复字幕默认位置")} aria-label={t("恢复字幕默认位置")}><Icon name="replay" /></button>}
          {displayedSegment && !embedded && <div className="sl-sentence-nav" role="group" aria-label={t("切换句子")}>
            <button disabled={displayedIndex <= 0} onClick={() => goSegment(displayedIndex - 1)} title={t("上一句 (A)")} aria-label={t("上一句")}><Icon name="arrow-left" /></button>
            <button disabled={displayedIndex >= segments.length - 1} onClick={() => goSegment(displayedIndex + 1)} title={t("下一句 (D)")} aria-label={t("下一句")}><Icon name="arrow-right" /></button>
          </div>}
          <span className="sl-counter">{displayedIndex >= 0 ? `${displayedIndex + 1}/${segments.length}` : '--'}</span>
          <span className="sl-subtitle-text">{settings.playbackPreferences.showTranscript && displayedSegment?.text && <span className="sl-english-line"><SubtitleText text={displayedSegment.text} nlp={displayedNlp} displayMode={subtitleDisplayMode} timeMs={captionTimeMs} startMs={displayedSegment.startMs} endMs={displayedSegment.endMs} {...(displayedSegment.wordStarts?.length ? { wordStarts: displayedSegment.wordStarts } : {})} vocabularySize={settings.vocabularySize} savedVocabulary={savedVocabulary} masteredVocabulary={masteredVocabulary} onWordEnter={onWordEnter} onWordLeave={onWordLeave} onWordClick={onWordClick} /></span>}{bilingual && showChinese && displayedSegment && <span className="sl-chinese-line">{translatedSegmentText(page.translationCues || [], displayedSegment)}</span>}{!displayedSegment && page.error && <span>{page.error}</span>}</span>
          {selection?.origin === 'subtitle' && <div className="sl-selection-actions" onMouseDown={event => event.preventDefault()}><span>{selection.text.slice(0, 30)}</span><button onClick={() => void saveSelection()}>{t("收藏")}</button><button {...agentPanelIntent} onClick={() => void highlightForAgent()}>{t("划线 · 问 AI")}</button></div>}
          {dictionaryPanel?.origin === 'subtitle' && !embedded?.popover && dictionaryPopover}
        </div>}
        {subtitleMaskEnabled && subtitleMaskEditorOpen && <section
          className="sl-mask-editor"
          aria-label={t("调整遮挡板")}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setSubtitleMaskEditorOpen(false);
              event.stopPropagation();
            }
          }}
        >
          <header>
            <strong>{t("遮挡板位置和大小")}</strong>
            <button
              type="button"
              className="sl-mask-editor-close"
              onClick={() => setSubtitleMaskEditorOpen(false)}
              aria-label={t("关闭遮挡板设置")}
              title={t("关闭")}
            >
              <Icon name="close" size={14} />
            </button>
          </header>
          <div className="sl-mask-editor-grid">
            {(['left', 'top', 'width', 'height'] as const).map((field) => <label key={field}>
              <span>{{ left: t("左"), top: t("上"), width: t("宽"), height: t("高") }[field]}</span>
              <input type="number" min="0" max="100" step="0.5" value={Number(subtitleMaskGeometry[field].toFixed(1))} onChange={(event) => updateSubtitleMaskField(field, Number(event.target.value))} />
              <small>%</small>
            </label>)}
          </div>
          <div className="sl-mask-editor-actions">
            <button type="button" onClick={resetSubtitleMask}>{t("恢复默认大小和位置")}</button>
            <button type="button" className="sl-mask-editor-done" onClick={() => setSubtitleMaskEditorOpen(false)}>{t("完成")}</button>
          </div>
        </section>}
        {bilingual && syncEditor && <div className="sl-sync-editor"><label>{t("字幕延后（秒）")}<input aria-label={t("字幕延后秒数")} type="number" min="-30" max="30" step="0.1" value={localOffset / 1000} onChange={event => setLocalOffset(Math.round(Math.max(-30, Math.min(30, Number(event.target.value))) * 1000))} /></label><small>{page.subtitleSource || t("语料库字幕")}</small><button onClick={() => setLocalOffset(0)}>{t("恢复默认")}</button><button onClick={() => setSyncEditor(false)}>{t("完成")}</button></div>}
      </>}
    </div>
  </>;
}

export function createPlayerUi(props: PlayerUiProps): YoutubePlayerUi {
  const host = document.createElement('div');
  host.id = 'shadow-language-player-ui';
  Object.assign(host.style, { position: 'absolute', inset: '0', zIndex: '70', pointerEvents: 'none' });
  const shadow = host.attachShadow({ mode: 'open' });
  const mount = document.createElement('div');
  shadow.append(mount);
  const root: Root = createRoot(mount);
  let current = props;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // This UI is a nested React root. During Vite invalidation its owner can be
    // rendering while this cleanup runs; defer the nested unmount so React does
    // not leave the old root half-alive with duplicate window listeners.
    queueMicrotask(() => root.unmount());
  };
  root.render(<PlayerUi {...current} />);
  return {
    host,
    update(page) { if (stopped) return; current = { ...current, page }; root.render(<PlayerUi {...current} />); },
    openDictation() { if (stopped) return; current = { ...current, dictationRequestId: (current.dictationRequestId || 0) + 1 }; root.render(<PlayerUi {...current} />); },
    expandTranscript() { if (stopped) return; current = { ...current, expandTranscriptRequestId: (current.expandTranscriptRequestId || 0) + 1 }; root.render(<PlayerUi {...current} />); },
    toggleSubtitleMask() { if (stopped) return; current = { ...current, subtitleMaskRequestId: (current.subtitleMaskRequestId || 0) + 1 }; root.render(<PlayerUi {...current} />); },
    toggleChineseSubtitles() { if (stopped) return; current = { ...current, chineseSubtitleRequestId: (current.chineseSubtitleRequestId || 0) + 1 }; root.render(<PlayerUi {...current} />); },
    toggleLoop() { if (stopped) return; current = { ...current, loopToggleRequestId: (current.loopToggleRequestId || 0) + 1 }; root.render(<PlayerUi {...current} />); },
    invalidate() {
      if (stopped) return;
      stop();
      // No React or extension APIs remain active in this expired context.
      const refresh = document.createElement('button');
      refresh.textContent = t("Shadow Language 已更新 · 刷新页面");
      Object.assign(refresh.style, { position: 'absolute', top: '12px', left: '12px', pointerEvents: 'auto', padding: '8px 12px', border: '1px solid #ffffff40', borderRadius: '8px', background: '#18241f', color: '#fff', cursor: 'pointer', font: '13px system-ui' });
      refresh.addEventListener('click', event => { event.stopPropagation(); location.reload(); });
      shadow.replaceChildren(refresh);
    },
    destroy() { stop(); host.remove(); },
  };
}

const PLAYER_CSS = `
:host { all: initial; color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", "Noto Sans SC", Roboto, sans-serif; }
* { box-sizing: border-box; }
button, select { font: inherit; }
button { color: inherit; }
.sl-hard-subtitle-mask { position:absolute; z-index:1; background:rgba(0,0,0,.96); box-shadow:0 2px 14px rgba(0,0,0,.38); pointer-events:none; }
.sl-mask-editor-surface { position:absolute; z-index:41; pointer-events:auto; cursor:move; touch-action:none; }
.sl-mask-editor-surface.is-selected { outline:2px solid rgba(255,255,255,.88); outline-offset:2px; }
.sl-mask-editor-surface:focus-visible { outline:2px solid rgba(255,255,255,.88); outline-offset:2px; }
.sl-mask-instruction { position:absolute; left:50%; top:50%; max-width:calc(100% - 28px); overflow:hidden; padding:4px 7px; border-radius:6px; color:#fff; background:rgba(25,33,53,.9); font-size:10px; font-weight:700; text-overflow:ellipsis; transform:translate(-50%,-50%); white-space:nowrap; pointer-events:none; user-select:none; display:inline-flex; align-items:center; gap:6px; }
.sl-mask-instruction button { pointer-events:auto; padding:1px 6px; border:0; border-radius:4px; color:#f9d99b; background:rgba(255,255,255,.12); cursor:pointer; font:inherit; font-size:10px; font-weight:600; }
.sl-mask-instruction button:hover { color:#fff; background:rgba(255,255,255,.24); }
.sl-mask-resize-handle { position:absolute; z-index:2; width:18px; height:18px; border:2px solid #fff; border-radius:50%; background:#e8b86d; box-shadow:0 2px 7px rgba(0,0,0,.55); touch-action:none; }
.sl-mask-resize-handle.is-nw { left:-10px; top:-10px; cursor:nwse-resize; }
.sl-mask-resize-handle.is-n { left:50%; top:-10px; transform:translateX(-50%); cursor:ns-resize; }
.sl-mask-resize-handle.is-ne { right:-10px; top:-10px; cursor:nesw-resize; }
.sl-mask-resize-handle.is-e { right:-10px; top:50%; transform:translateY(-50%); cursor:ew-resize; }
.sl-mask-resize-handle.is-se { right:-10px; bottom:-10px; cursor:nwse-resize; }
.sl-mask-resize-handle.is-s { left:50%; bottom:-10px; transform:translateX(-50%); cursor:ns-resize; }
.sl-mask-resize-handle.is-sw { left:-10px; bottom:-10px; cursor:nesw-resize; }
.sl-mask-resize-handle.is-w { left:-10px; top:50%; transform:translateY(-50%); cursor:ew-resize; }
.sl-mask-editor { pointer-events:auto; position:absolute; right:16px; top:58px; z-index:42; display:grid; gap:9px; width:230px; padding:11px; border:1px solid rgba(255,255,255,.2); border-radius:11px; color:#eef3ff; background:rgba(16,23,41,.96); box-shadow:0 10px 30px rgba(0,0,0,.42); }
.sl-mask-editor header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sl-mask-editor header button.sl-mask-editor-close { min-height:20px; width:20px; height:20px; padding:0; border:0; border-radius:5px; color:#b9bed0; background:transparent; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; }
.sl-mask-editor header button.sl-mask-editor-close:hover { color:#fff; background:rgba(255,255,255,.15); }
.sl-mask-editor button { min-height:28px; padding:5px 8px; border:0; border-radius:7px; color:#f9d99b; background:rgba(255,255,255,.08); cursor:pointer; font-size:10px; }
.sl-mask-editor-actions { display:grid; grid-template-columns:1fr auto; gap:6px; }
.sl-mask-editor-actions button.sl-mask-editor-done { color:#fff; background:rgba(255,255,255,.16); font-weight:600; padding:5px 12px; }
.sl-mask-editor-actions button.sl-mask-editor-done:hover { background:rgba(255,255,255,.24); }
.sl-mask-editor-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.sl-mask-editor label { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:5px; color:#b9bed0; font-size:10px; }
.sl-mask-editor input { min-width:0; width:100%; height:28px; padding:3px 5px; border:1px solid rgba(255,255,255,.18); border-radius:6px; color:#fff; background:#101729; font:inherit; }
.sl-english-line,.sl-chinese-line { display:block; }
.sl-chinese-line { font-size:.82em; margin-top:3px; color:#eee; }
.sl-sync-editor { pointer-events:auto; position:absolute; right:16px; top:100px; background:#18241f; padding:14px; border-radius:10px; display:grid; gap:10px; z-index:5; }
.sl-sync-editor label { display:flex; gap:10px; justify-content:space-between; }
.sl-sync-editor input[type=number] { width:75px; }
.sl-shell { position: absolute; inset: 0; pointer-events: none; color: #f7fbf8; font-size: 13px; }
.sl-shell button, .sl-shell label { pointer-events: auto; }
.sl-master { position: absolute; top: 12px; right: 12px; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 9px 0 5px; border: 1px solid rgba(255,255,255,.24); border-radius: 8px; color: #d9e2dc; background: rgba(12,18,15,.82); box-shadow: 0 4px 18px rgba(0,0,0,.25); cursor: pointer; font-size: 10px; font-weight: 800; }
.sl-master span { display: grid; place-items: center; width: 21px; height: 21px; border-radius: 6px; color: #fff; background: #238a61; font-size: 9px; }
.sl-controls { position: absolute; left: 50%; bottom: 50px; display: flex; align-items: center; gap: 5px; max-width: calc(100% - 32px); min-height: 42px; padding: 5px 7px; border: 1px solid rgba(255,255,255,.18); border-radius: 12px; background: rgba(10,15,12,.9); box-shadow: 0 8px 30px rgba(0,0,0,.36); transform: translateX(-50%); backdrop-filter: blur(12px); white-space: nowrap; }
.sl-controls button { min-width: 32px; height: 32px; padding: 0 8px; border: 0; border-radius: 8px; background: rgba(255,255,255,.08); cursor: pointer; }
.sl-controls button:hover:not(:disabled), .sl-controls button.active { color: #baf0d4; background: rgba(45,147,101,.35); }
.sl-controls button:disabled { cursor: default; opacity: .32; }
.sl-controls label { position: relative; display: grid; place-items: center; height: 32px; min-width: 48px; padding: 0 8px; border-radius: 8px; background: rgba(255,255,255,.07); cursor: pointer; font-size: 11px; }
.sl-controls label select { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
.sl-action-toolbar { position:absolute; top:12px; right:12px; z-index:12; display:flex; align-items:center; flex-wrap:wrap; gap:4px; max-width:calc(100% - 24px); min-height:36px; padding:3px; border:1px solid rgba(255,255,255,.18); border-radius:10px; background:rgba(10,15,12,.9); box-shadow:0 8px 30px rgba(0,0,0,.36); backdrop-filter:blur(12px); pointer-events:auto; }
.sl-action-toolbar-drag { display:grid; flex:none; place-items:center; width:24px; height:28px; border-radius:6px; color:#aeb9b2; cursor:grab; font-size:16px; line-height:1; touch-action:none; user-select:none; }
.sl-action-toolbar-drag:hover { color:#e5f7eb; background:rgba(255,255,255,.08); }
.sl-action-toolbar-drag:active { cursor:grabbing; }
.sl-action-toolbar .sl-master { position:static; flex:none; height:28px; padding:0 7px 0 3px; border:0; border-radius:6px; background:rgba(255,255,255,.08); box-shadow:none; font-size:10px; }
.sl-action-toolbar .sl-master:hover { color:#baf0d4; background:rgba(45,147,101,.35); }
.sl-action-toolbar .sl-master span { width:20px; height:20px; border-radius:5px; }
.sl-agent-button { flex:none; min-width:32px; height:28px; padding:0 8px; border:0; border-radius:6px; color:#d9e8dd; background:rgba(255,255,255,.08); cursor:pointer; font-size:11px; font-weight:800; }
.sl-agent-button:hover { color:#fff; background:rgba(255,255,255,.15); }
.sl-action-toolbar .sl-controls { position:static; left:auto; bottom:auto; display:flex; flex:0 1 auto; flex-wrap:wrap; min-width:0; max-width:100%; min-height:28px; padding:0; border:0; border-radius:0; background:transparent; box-shadow:none; transform:none; backdrop-filter:none; white-space:normal; }
.sl-action-toolbar .sl-controls.sl-compact-controls { top:auto; bottom:auto; left:auto; min-height:28px; padding:0; gap:3px; border-radius:0; transform:none; }
.sl-action-toolbar .sl-controls button { height:28px; }
.sl-action-toolbar .sl-controls label { height:28px; }
.sl-action-toolbar .sl-more-panel { top:calc(100% + 8px); right:0; left:auto; }
.sl-controls .sl-track { max-width: 58px; }
.sl-subtitle { position: absolute; left: 50%; bottom: 103px; z-index:4; display: flex; align-items: flex-start; gap: 9px; max-width: min(76%, 980px); padding: 10px 14px; border: 1px solid transparent; border-radius: 10px; background: rgba(9,13,11,.76); box-shadow: 0 4px 20px rgba(0,0,0,.28); transform: translateX(-50%); font-size: clamp(15px, 2.15vw, 26px); font-weight: 550; line-height: 1.38; text-align: center; text-shadow: 0 1px 2px #000; pointer-events: auto; }
.sl-controls.sl-compact-controls { top:12px; bottom:auto; left:12px; transform:none; max-width:calc(100% - 115px); min-height:34px; padding:3px; gap:3px; border-radius:9px; }
.sl-compact-controls button, .sl-more summary { height:28px; font-size:12px; }
.sl-more { position:relative; pointer-events:auto; }
.sl-more summary { display:flex; align-items:center; padding:0 10px; border-radius:6px; cursor:pointer; list-style:none; }
.sl-more summary::-webkit-details-marker { display:none; }
.sl-more summary:hover, .sl-more[open] summary { background:rgba(45,147,101,.35); }
.sl-more-panel { position:absolute; top:calc(100% + 8px); left:0; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; width:220px; max-height:calc(100vh - 180px); overflow:auto; padding:8px; background:rgba(10,15,12,.97); border:1px solid #ffffff30; border-radius:10px; box-shadow:0 8px 24px #0005; }
.sl-more-panel .sl-track { max-width:none; }
.sl-more-panel button, .sl-more-panel label { width:100%; }
.sl-shortcuts { position:relative; pointer-events:auto; }
.sl-shortcuts summary { display:flex; align-items:center; height:28px; padding:0 10px; border-radius:6px; cursor:pointer; list-style:none; font-size:12px; }
.sl-shortcuts summary::-webkit-details-marker { display:none; }
.sl-shortcuts summary:hover, .sl-shortcuts[open] summary { color:#baf0d4; background:rgba(45,147,101,.35); }
.sl-shortcuts-panel { position:absolute; top:calc(100% + 8px); right:0; z-index:20; width:min(248px,calc(100vw - 24px)); padding:10px; border:1px solid #ffffff30; border-radius:10px; color:#eaf4ed; background:rgba(10,15,12,.97); box-shadow:0 8px 24px #0005; }
.sl-shortcuts-panel header { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:8px; }
.sl-shortcuts-panel header strong { font-size:12px; }
.sl-shortcuts-panel header small, .sl-shortcuts-panel p { color:#aeb9b2; font-size:10px; }
.sl-shortcuts-panel dl { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px 12px; margin:0; }
.sl-shortcuts-panel dl > div { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
.sl-shortcuts-panel dt { overflow:hidden; color:#d5e4da; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.sl-shortcuts-panel dd { flex:none; min-width:20px; margin:0; padding:2px 5px; border-radius:4px; color:#baf0d4; background:rgba(255,255,255,.09); font-family:ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-size:10px; text-align:center; }
.sl-shortcuts-panel p { margin:9px 0 0; }
.sl-compact-controls { z-index:10; }
.sl-sentence-nav { position:absolute; bottom:100%; left:0; display:flex; gap:4px; padding-bottom:5px; visibility:hidden; }
.sl-subtitle:hover .sl-sentence-nav, .sl-subtitle:focus-within .sl-sentence-nav { visibility:visible; }
.sl-sentence-nav button { width:32px; height:28px; border:1px solid #ffffff30; border-radius:7px; background:#15231df2; cursor:pointer; font-size:16px; }
.sl-sentence-nav button:disabled { opacity:.35; cursor:default; }
@media (hover:none) { .sl-sentence-nav { visibility:visible; } }
.sl-subtitle:hover { border-color: rgba(146,188,166,.5); background: rgba(9,13,11,.9); }
.sl-subtitle-text { display:block; flex:1; min-width:0; user-select: text; -webkit-user-select: text; }
.sl-selection-actions { position:absolute; bottom:calc(100% + 8px); left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:8px; padding:7px; border:1px solid #d6e2da; border-radius:10px; background:#fff; color:#263f31; font-size:12px; text-shadow:none; white-space:nowrap; z-index:30; box-shadow:0 6px 22px #0004; }
.sl-selection-actions button { padding:6px 9px; border:0; border-radius:6px; color:#fff; background:#286446; cursor:pointer; }
.sl-selection-actions span { max-width:180px; overflow:hidden; text-overflow:ellipsis; }
.sl-word-token { cursor: pointer; text-decoration: underline dotted rgba(186,240,212,.45); text-underline-offset: 3px; }
.sl-word-token.is-mastered { color: inherit; text-decoration-color: transparent; }
.sl-word-token.is-saved { color: #8bd6ff; text-decoration-color: rgba(139,214,255,.78); text-decoration-style: solid; }
.sl-word-token.is-outside { color: #ffd889; text-decoration-color: rgba(255,216,137,.8); text-decoration-style: wavy; }
.sl-word-mask { display:inline-block; height:.54em; margin:0 .02em; border:0; border-radius:999px; background:rgba(226,239,231,.28); box-shadow:inset 0 0 0 1px rgba(255,255,255,.09); vertical-align:.08em; user-select:none; -webkit-user-select:none; transition:background .12s ease, box-shadow .12s ease, transform .12s ease; }
.sl-word-mask-separator { white-space:pre-wrap; user-select:none; -webkit-user-select:none; }
.sl-word-mask.is-current { background:#baf0d4; box-shadow:0 0 0 2px rgba(186,240,212,.3), 0 0 12px rgba(88,212,143,.55); transform:translateY(-.08em) scaleY(1.22); animation:sl-current-word .32s ease-out; }
.sl-word-token.is-current { color:#e8fff1; text-decoration-color:#baf0d4; text-decoration-style:solid; text-shadow:0 0 12px rgba(88,212,143,.75); animation:sl-current-word .32s ease-out; }
@keyframes sl-current-word { from { transform:translateY(.04em) scale(.94); } to { transform:translateY(0) scale(1); } }
@media (prefers-reduced-motion: reduce) { .sl-word-mask, .sl-word-token { transition:none; animation:none !important; } }
.sl-word-token:hover, .sl-word-token:focus-visible { color: #baf0d4; text-decoration-color: #baf0d4; outline: none; }
.sl-word-token.is-saved:hover, .sl-word-token.is-saved:focus-visible { color: #c5efff; text-decoration-color: #c5efff; }
.sl-word-token.is-outside:hover, .sl-word-token.is-outside:focus-visible { color: #ffe9b0; text-decoration-color: #ffe9b0; }
.sl-subtitle-replay { display: grid; flex: none; place-items: center; width: 28px; height: 28px; margin-top: 1px; padding: 0; border: 1px solid rgba(186,240,212,.45); border-radius: 50%; color: #fff; background: #238a61; cursor: pointer; font-size: 12px; text-shadow: none; }
.sl-subtitle-replay:hover { background: #2fa274; }
.sl-subtitle-drag, .sl-subtitle-reset { display:grid; flex:none; place-items:center; width:24px; height:28px; margin-top:1px; padding:0; border:0; border-radius:6px; color:#b8c8be; background:rgba(255,255,255,.08); cursor:pointer; font-size:13px; text-shadow:none; }
.sl-subtitle-drag { cursor:grab; touch-action:none; user-select:none; -webkit-user-select:none; }
.sl-subtitle-drag:active { cursor:grabbing; }
.sl-subtitle-drag:hover, .sl-subtitle-reset:hover { color:#e8fff1; background:rgba(45,147,101,.38); }
.sl-subtitle-reset { color:#baf0d4; }
.sl-save-selection-floating { position: absolute; left: 50%; bottom: calc(100% + 7px); z-index: 3; max-width: min(320px, 90%); overflow: hidden; color: #baf0d4; background: rgba(27,104,75,.96); box-shadow: 0 5px 18px rgba(0,0,0,.32); text-overflow: ellipsis; transform: translateX(-50%); white-space: nowrap; }
.sl-dictionary-popover {
  --dict-bg: rgba(9,18,13,.98);
  --dict-border: rgba(186,240,212,.34);
  --dict-accent: #baf0d4;
  --dict-accent-soft: rgba(186,240,212,.14);
  --dict-heading: #d8f6e4;
  --dict-text: #e1ebe4;
  --dict-muted: #94b6a2;
  --dict-en: #9fb5a7;
  --dict-control: rgba(255,255,255,.08);
  --dict-control-hover: rgba(255,255,255,.16);
  --dict-line: rgba(255,255,255,.1);
  --dict-known: #ffe0a0;
  --dict-known-bg: rgba(155,111,35,.24);
  position: absolute;
  left: 0;
  top: 0;
  z-index: 5;
  display: grid;
  gap: 7px;
  width: min(330px, 390px);
  max-height: min(45vh, 360px);
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--dict-border);
  border-radius: 11px;
  color: var(--dict-text);
  background: var(--dict-bg);
  box-shadow: 0 9px 30px rgba(0,0,0,.5);
  transform: translate(-50%, calc(-100% - 9px));
  text-align: left;
  text-shadow: none;
  pointer-events: auto;
}
.sl-dictionary-popover.expanded { width: min(360px, 430px); max-height: min(48vh, 420px); }
.sl-dictionary-popover.place-below { transform: translate(-50%, 9px); }
.sl-dictionary-popover.from-transcript { z-index: 8; width: min(340px, calc(100% - 16px)); max-height: min(420px, calc(100% - 16px)); }
.sl-dictionary-progress { height: 2px; margin: -2px -2px 0; overflow: hidden; border-radius: 999px; background: var(--dict-control); }
.sl-dictionary-progress i { display: block; width: 36%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, transparent, var(--dict-accent), transparent); animation: sl-dict-progress 1.1s ease-in-out infinite; }
@keyframes sl-dict-progress { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }
.sl-dictionary-popover header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.sl-dictionary-popover header div { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.sl-dictionary-header-actions { align-items: center !important; flex: none; }
.sl-dictionary-popover header strong { color: var(--dict-heading); font-size: 15px; }
.sl-dictionary-popover header small, .sl-dictionary-popover footer small { color: var(--dict-muted); font-size: 10px; }
.sl-dictionary-popover header .sl-dictionary-phonetic { font-variant: tabular-nums; letter-spacing: .01em; }
.sl-dictionary-popover header button { width: 23px; height: 23px; padding: 0; border: 0; border-radius: 6px; color: var(--dict-text); background: var(--dict-control); cursor: pointer; line-height: 1; }
.sl-dictionary-popover header button.sl-dictionary-save { width: auto; min-width: 45px; padding: 0 8px; color: #082417; background: var(--dict-accent); font-size: 10px; font-weight: 800; }
.sl-dictionary-popover header button.sl-dictionary-save:hover { filter: brightness(1.08); color: #082417; background: var(--dict-accent); }
.sl-dictionary-popover header button.sl-dictionary-known { width: auto; min-width: 47px; padding: 0 7px; color: var(--dict-known); background: var(--dict-known-bg); font-size: 10px; font-weight: 800; }
.sl-dictionary-popover header button.sl-dictionary-known:hover { color: #fff1c9; background: rgba(183,133,48,.4); }
.sl-dictionary-popover header button.sl-dictionary-known.is-active { color: #082417; background: #ffd889; }
.sl-dictionary-popover header button:hover { color: #fff; background: var(--dict-control-hover); }
.sl-dictionary-speak { font-size: 13px; }
.sl-dictionary-translation { color: var(--dict-accent); font-size: 15px; line-height: 1.35; }
.sl-dictionary-context { margin: 0; padding: 7px 8px; border-left: 2px solid var(--dict-accent); border-radius: 6px; color: var(--dict-text); background: var(--dict-accent-soft); font-size: 11.5px; line-height: 1.45; }
.sl-dictionary-context em { font-style: normal; font-weight: 700; color: var(--dict-accent); background: rgba(255,255,255,.06); border-radius: 3px; padding: 0 3px; }
.sl-dictionary-definition, .sl-dictionary-loading { margin: 0; color: var(--dict-text); font-size: 11px; line-height: 1.45; }
.sl-dictionary-loading { color: var(--dict-muted); }
.sl-dictionary-extra { display: grid; gap: 4px; padding-top: 6px; border-top: 1px solid var(--dict-line); border-radius: 0; background: transparent; }
.sl-dictionary-extra > small { color: var(--dict-accent); font-size: 10px; font-weight: 700; letter-spacing: .03em; }
.sl-dictionary-extra p { margin: 0; color: var(--dict-text); font-size: 11px; line-height: 1.42; }
.sl-dictionary-extra em { display: block; margin-top: 2px; color: var(--dict-en); font-size: 10px; font-style: normal; }
.sl-dictionary-phrases { display: flex; flex-wrap: wrap; gap: 6px; }
.sl-dictionary-phrase-chip {
  border: 1px solid var(--dict-border);
  border-radius: 999px;
  padding: 4px 9px;
  color: var(--dict-accent);
  background: var(--dict-accent-soft);
  cursor: pointer;
  font-size: 11px;
  font-weight: 650;
}
.sl-dictionary-phrase-chip:hover { filter: brightness(1.1); }
.sl-dictionary-senses { display: grid; gap: 8px; }
.sl-dictionary-senses > div { padding-top: 7px; border-top: 1px solid var(--dict-line); }
.sl-dictionary-senses small { color: var(--dict-accent); font-size: 10px; font-weight: 800; font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; }
.sl-dictionary-senses p { margin: 2px 0 0; font-size: 11px; line-height: 1.42; }
.sl-dictionary-senses .sl-dictionary-sense-zh { color: var(--dict-text); font-size: 12.5px; }
.sl-dictionary-senses .sl-dictionary-sense-en { color: var(--dict-en); font-size: 11px; }
.sl-dictionary-senses em { display: block; margin-top: 3px; color: var(--dict-en); font-size: 10px; line-height: 1.35; }
.sl-dictionary-popover footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 5px; border-top: 1px solid var(--dict-line); }
.sl-dictionary-popover footer button { min-height: 27px; padding: 4px 9px; border: 0; border-radius: 7px; color: #082417; background: var(--dict-accent); cursor: pointer; font-size: 11px; font-weight: 700; }
.sl-dictionary-popover footer button:hover { filter: brightness(1.08); }
.sl-new-word-count { display: inline-flex; align-items: center; min-height: 32px; padding: 0 7px !important; border: 0 !important; border-radius: 8px; color: #ffd889 !important; background: rgba(155,111,35,.2) !important; cursor: pointer !important; font-size: 10px; }
.sl-new-word-count:hover:not(:disabled) { color: #fff0bd !important; background: rgba(183,133,48,.38) !important; }
.sl-new-word-count:disabled { cursor: default !important; opacity: .72 !important; }
.sl-counter { flex: none; margin-top: .3em; color: #92bca6; font-size: 10px; font-weight: 700; }
.sl-transcript { position: absolute; top: 52px; right: 12px; bottom: 102px; z-index:6; display: flex; flex-direction: column; width: min(370px, 38%); min-width: 260px; overflow: hidden; border: 1px solid rgba(255,255,255,.16); border-radius: 12px; background: rgba(10,15,12,.93); box-shadow: 0 10px 36px rgba(0,0,0,.36); backdrop-filter: blur(14px); pointer-events: auto; }
.sl-transcript header { display: flex; align-items: center; justify-content: space-between; padding: 6px; border-bottom: 1px solid rgba(255,255,255,.1); }
.sl-transcript header div { display: flex; gap: 3px; }
.sl-transcript header button, .sl-save-selection { min-height: 28px; padding: 5px 8px; border: 0; border-radius: 7px; background: transparent; cursor: pointer; font-size: 11px; }
.sl-transcript header button.active { color: #baf0d4; background: rgba(45,147,101,.28); }
.sl-save-selection { margin: 6px; overflow: hidden; color: #baf0d4; background: rgba(45,147,101,.2); text-overflow: ellipsis; white-space: nowrap; }
.sl-transcript-list { overflow-y: auto; padding: 5px; scrollbar-color: #486657 transparent; }
.sl-transcript-list > button { display: grid; grid-template-columns: 38px 1fr; gap: 7px; width: 100%; padding: 8px 7px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; text-align: left; line-height: 1.4; }
.sl-transcript-list > button:hover, .sl-transcript-list > button.current { background: rgba(45,147,101,.25); }
:host-context(html[data-onboarding-step="seek"]) .sl-transcript-list > button:not(.current) { position:relative; z-index:101; outline:3px solid #f7cf89; outline-offset:3px; box-shadow:0 0 0 7px #e8b86d35,0 0 28px #e8b86d99; animation:sl-onboarding-pulse 1.15s ease-in-out infinite; }
@keyframes sl-onboarding-pulse { 50% { box-shadow:0 0 0 11px #e8b86d10,0 0 38px #e8b86d99; } }
.sl-transcript-list time { color: #8ba095; font-size: 9px; }
.sl-transcript-list span { user-select: text; }
.sl-transcript-word.is-clickable { border-radius: 3px; cursor: pointer; }
.sl-transcript-word.is-clickable:hover, .sl-transcript-word.is-clickable:focus-visible { color: #e4fff0; background: rgba(87,196,143,.28); outline: none; }
.sl-transcript-word.is-outside { color: #ffd889; font-weight: 650; }
.sl-transcript-list p { padding: 18px; color: #aeb9b2; text-align: center; }
.sl-notice { position: absolute; top: 15px; left: 50%; padding: 8px 12px; border-radius: 8px; background: rgba(25,122,87,.95); box-shadow: 0 4px 16px rgba(0,0,0,.3); transform: translateX(-50%); }
@media (max-width: 760px) {
  .sl-transcript { display: none; }
  .sl-controls { bottom: 45px; gap: 3px; }
  .sl-controls .sl-track, .sl-controls .sl-session { display: none; }
  .sl-subtitle { bottom: 96px; max-width: 90%; font-size: 15px; }
  .sl-mask-editor { top:8px; right:8px; width:min(230px,calc(100% - 16px)); }
  .sl-mask-resize-handle { width:24px; height:24px; }
  .sl-mask-resize-handle.is-nw { left:-13px; top:-13px; }
  .sl-mask-resize-handle.is-n { top:-13px; }
  .sl-mask-resize-handle.is-ne { right:-13px; top:-13px; }
  .sl-mask-resize-handle.is-e { right:-13px; }
  .sl-mask-resize-handle.is-se { right:-13px; bottom:-13px; }
  .sl-mask-resize-handle.is-s { bottom:-13px; }
  .sl-mask-resize-handle.is-sw { left:-13px; bottom:-13px; }
  .sl-mask-resize-handle.is-w { left:-13px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

export const createYoutubePlayerUi = createPlayerUi;

const EMBEDDED_OVERLAY_CSS = `
.sl-subtitle { bottom:var(--web-caption-bottom, 8px); width:94%; font-size:clamp(14px,2vw,25px); max-width:94%; }
.sl-sentence-nav { display:none !important; }
.sl-subtitle-text { line-height:1.4; }
.sl-dictionary { max-width:min(360px,88vw); }
@media(max-width:600px) { .sl-subtitle { font-size:16px; } .sl-counter { display:none; } }
`;
const EMBEDDED_CSS = `
:host { display:block; height:100%; color:#f5f1e8; font:14px Inter, sans-serif; color-scheme:dark; }
.sl-controls { position:relative; inset:auto; transform:none; border:0; border-radius:0; background:#192135; box-shadow:none; max-width:none; width:100%; min-height:48px; justify-content:flex-start; flex-wrap:wrap; }
.sl-controls button,.sl-controls summary { min-height:40px; color:#f9d99b; }
.sl-more-panel { top:100%; bottom:auto; right:0; background:#192135; color:#f5f1e8; z-index:30; }
.sl-transcript { position:relative; inset:auto; width:100%; height:100%; max-height:none; border:0; border-radius:0; background:#101729; display:flex; flex-direction:column; box-shadow:none; }
.sl-transcript header { flex-shrink:0; background:#192135; }
.sl-transcript header > button { display:none; }
.sl-transcript-list { flex:1; overflow:auto; overscroll-behavior:contain; min-height:0; }
.sl-transcript-list button { width:100%; padding:18px; color:#b9bed0; font-size:17px; line-height:1.7; border-bottom:1px solid #252e49; border-radius:0; }
.sl-transcript-list button.current { color:#fff; background:#252e49; box-shadow:inset 3px 0 #e8b86d; }
.sl-transcript-list time { color:#8992ab; }
.sl-transcript-list span { white-space:pre-line; }
.sl-transcript-tools { display:flex; align-items:center; justify-content:space-between; flex-shrink:0; min-height:40px; background:#192135; }
.sl-follow,.sl-transcript-toggle { border:0; background:transparent; color:#f9d99b; padding:8px 12px; min-height:40px; cursor:pointer; }
.sl-follow { flex:1; text-align:left; }
.sl-transcript-toggle { flex:none; text-align:right; }
.sl-transcript-toggle:hover { background:#3c4768; }
.sl-transcript.is-collapsed .sl-save-selection { display:none; }
.sl-transcript header button.active,.sl-controls button.active { background:#3c4768; color:#f9d99b; }
.sl-transcript-list > p { color:#b9bed0; padding:16px; }
.sl-controls { flex-wrap:nowrap; gap:4px; }
.sl-controls .sl-shortcuts { display:none; }
.sl-controls .sl-more summary { padding:8px; min-height:36px; }
`;
