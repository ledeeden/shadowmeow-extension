import { t } from '../lib/i18n';
import { SentenceSubmission, type SentenceSubmissionProps } from './sentence-submission';
import { DictationPortraitPrompt } from './dictation-portrait-prompt';
import { PLAYBACK_RATES, type NormalizedSegment, type PageState } from '@shadow-language/contracts';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  applyDictationCharacter,
  createDictationSlots,
  createGuidedDictationSlots,
  revealedDictationWords,
  DEFAULT_DICTATION_PRACTICE_SETTINGS,
  dictationExpectedCharacterCount,
  dictationMaximumDraftLength,
  dictationRequiredCharacterCount,
  dictationWords,
  isDictationCharacter,
  isDictationDraftComplete,
  isDictationDraftCorrect,
  isDictationDraftCorrectPrefix,
  isDictationHyphenBoundary,
  nearestDictationItem,
  nextIncompleteWord,
  previousDictationWord,
  type DictationPracticeSettings,
} from '../lib/dictation-practice';

const SETTINGS_KEY = 'shadowLanguageDictationPracticeSettings';

type PracticeItem = {
  segment: NormalizedSegment;
  sourceIndex: number;
  words: string[];
  revealed: boolean[];
};

type DictationPracticeProps = {
  vocabularySize: number;
  savedVocabulary: Set<string>;
  masteredVocabulary: Set<string>;
  segments: NormalizedSegment[];
  initialSegmentIndex: number;
  captionTimeMs: number;
  playerState: PageState['playerState'];
  playbackRate: number;
  subtitleMaskEnabled: boolean;
  translationFor: (segment: NormalizedSegment) => string;
  onClose: () => void;
  onPause: (segment: NormalizedSegment) => void;
  onReplay: (segment: NormalizedSegment) => void;
  onPlaybackRateChange: (rate: number) => void;
  onToggleSubtitleMask: () => void;
  mobileInput?: boolean;
  portraitFallback?: boolean;
  onDismissPortraitFallback?: () => void;
  preserveMobileKeyboard?: boolean;
  viewportDock?: boolean;
};

function mobileDictationViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 1199px)').matches || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
}

function interactiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input,select,textarea,[contenteditable="true"]'));
}

/** Dictation is mounted in a shadow root, where document.activeElement stops at the host. */
function deepActiveElement(): Element | null {
  let node: Element | null = document.activeElement;
  while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
  return node;
}

function mergeSettings(value: unknown): DictationPracticeSettings {
  if (!value || typeof value !== 'object') return DEFAULT_DICTATION_PRACTICE_SETTINGS;
  const source = value as Partial<Record<keyof DictationPracticeSettings, unknown>>;
  return Object.fromEntries(Object.entries(DEFAULT_DICTATION_PRACTICE_SETTINGS).map(([key, fallback]) => [key, typeof source[key as keyof DictationPracticeSettings] === 'boolean' ? source[key as keyof DictationPracticeSettings] : fallback])) as DictationPracticeSettings;
}

function GuidedDictationPractice({ vocabularySize, savedVocabulary, masteredVocabulary, segments, initialSegmentIndex, captionTimeMs, playerState, playbackRate, subtitleMaskEnabled, translationFor, onClose, onPause, onReplay, onPlaybackRateChange, onToggleSubtitleMask, mobileInput = false, portraitFallback = false, onDismissPortraitFallback, preserveMobileKeyboard = false, viewportDock = false }: DictationPracticeProps) {
  const items = useMemo<PracticeItem[]>(() => segments.map((segment, sourceIndex) => {
    const words = dictationWords(segment.text);
    return { segment, sourceIndex, words, revealed: revealedDictationWords(words, vocabularySize, savedVocabulary, masteredVocabulary) };
  }).filter(item => item.words.length > 0), [segments, vocabularySize, savedVocabulary, masteredVocabulary]);
  const initialItem = useMemo(() => nearestDictationItem(items.map(item => item.sourceIndex), initialSegmentIndex), [initialSegmentIndex, items]);
  const [itemIndex, setItemIndex] = useState(Math.max(0, initialItem));
  const [wordIndex, setWordIndex] = useState(0);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [completed, setCompleted] = useState<boolean[]>([]);
  const [mistakes, setMistakes] = useState<boolean[]>([]);
  const [sentenceComplete, setSentenceComplete] = useState(false);
  const [errorWord, setErrorWord] = useState<number | null>(null);
  const [settings, setSettings] = useState(DEFAULT_DICTATION_PRACTICE_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [mobileInputActive, setMobileInputActive] = useState(() => mobileInput && mobileDictationViewport());
  const [softKeyboardOpen, setSoftKeyboardOpen] = useState(false);
  const [visiblePracticeHeight, setVisiblePracticeHeight] = useState<number | null>(null);
  const [visiblePracticeTop, setVisiblePracticeTop] = useState(0);
  const [visibleStageTop, setVisibleStageTop] = useState(0);
  const autoAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorVisualTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const mobileInputRef = useRef<HTMLInputElement | null>(null);
  const mobileFocusRequested = useRef(false);
  const mobileInputId = useId();
  const active = items[itemIndex];

  const clearAutoAdvance = useCallback(() => {
    if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current);
    autoAdvanceTimer.current = null;
  }, []);
  const resetSentence = useCallback((item?: PracticeItem) => {
    clearAutoAdvance();
    const slots = createGuidedDictationSlots(item?.words || [], item?.revealed || []);
    setWordIndex(nextIncompleteWord(slots.completed, -1) ?? 0);
    setDrafts(slots.drafts);
    setCompleted(slots.completed);
    setMistakes(slots.completed.map(() => false));
    setSentenceComplete(slots.completed.length > 0 && slots.completed.every(Boolean));
    setErrorWord(null);
  }, [clearAutoAdvance]);

  const replay = useCallback(() => {
    if (active) onReplay(active.segment);
  }, [active, onReplay]);

  const moveToItem = useCallback((next: number) => {
    if (next < 0 || next >= items.length) return;
    resetSentence(items[next]);
    setItemIndex(next);
  }, [items, resetSentence]);

  useEffect(() => {
    if (!mobileInput) {
      setMobileInputActive(false);
      return;
    }
    const update = () => setMobileInputActive(mobileDictationViewport());
    const mediaQuery = window.matchMedia('(max-width: 1199px)');
    update();
    mediaQuery.addEventListener?.('change', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      mediaQuery.removeEventListener?.('change', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [mobileInput]);
  useEffect(() => {
    if (portraitFallback) {
      mobileFocusRequested.current = false;
      if (!preserveMobileKeyboard) dialogRef.current?.focus();
      return;
    }
    if (mobileInputActive && (!sentenceComplete || preserveMobileKeyboard)) {
      // On Web iPad, keep the same input focused across words and sentences.
      // Repeated focus calls and disabling it at sentence completion make the
      // software keyboard close and reopen during automatic advancement.
      if (preserveMobileKeyboard && mobileFocusRequested.current) return;
      const frame = window.requestAnimationFrame(() => {
        if (!mobileInputRef.current) return;
        mobileInputRef.current.focus({ preventScroll: true });
        if (preserveMobileKeyboard) mobileFocusRequested.current = true;
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (!preserveMobileKeyboard) dialogRef.current?.focus();
  }, [active?.segment.id, mobileInputActive, portraitFallback, preserveMobileKeyboard, sentenceComplete]);
  useEffect(() => {
    if (preserveMobileKeyboard || !mobileInputActive || sentenceComplete || portraitFallback) return;
    const frame = window.requestAnimationFrame(() => mobileInputRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [mobileInputActive, portraitFallback, preserveMobileKeyboard, sentenceComplete, wordIndex]);
  useEffect(() => {
    if (!mobileInputActive) {
      setSoftKeyboardOpen(false);
      setVisiblePracticeHeight(null);
      setVisiblePracticeTop(0);
      setVisibleStageTop(0);
      return;
    }
    const viewport = window.visualViewport;
    // Tallest layout height seen while the keyboard is closed. Android resize
    // lowers window.innerHeight with the keyboard; iOS often keeps layout height
    // and only shrinks visualViewport (overlay/pan). Both need a stable baseline.
    let baselineLayoutHeight = window.innerHeight;
    const syncVisibleViewport = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      // Measure the player canvas host, not the React mount parent: the mount
      // has zero flow height (children are absolutely positioned), so using it
      // collapses the dock to 0 when the keyboard opens and the top bar vanishes.
      const rootNode = dialog.getRootNode();
      const shadowHost = rootNode instanceof ShadowRoot ? (rootNode.host as HTMLElement) : null;
      const candidates: HTMLElement[] = [];
      if (shadowHost) candidates.push(shadowHost);
      if (dialog.parentElement) candidates.push(dialog.parentElement);
      if (dialog.offsetParent instanceof HTMLElement) candidates.push(dialog.offsetParent);
      candidates.push(dialog);
      const canvas = candidates.find(node => node.getBoundingClientRect().height > 40) ?? dialog;
      const rect = canvas.getBoundingClientRect();
      const layoutHeight = window.innerHeight;

      if (viewportDock) {
        // Web practice uses the entire visible viewport above the keyboard.
        // The video canvas can be shorter: capping to rect.height leaves the
        // input and toolbar floating far above the keyboard on iPad.
        const visibleHeight = viewport?.height ?? layoutHeight;
        const keyboardOpen = baselineLayoutHeight - Math.min(layoutHeight, visibleHeight) > 120;
        if (!keyboardOpen) baselineLayoutHeight = Math.max(baselineLayoutHeight, layoutHeight);
        setSoftKeyboardOpen(keyboardOpen);
        // The Web dock is fixed to the layout viewport, not the player canvas.
        // Its containing block can move when the player enters practice mode or
        // Safari pans the page for the keyboard, even without a resize event.
        setVisiblePracticeTop(Math.round(viewport?.offsetTop ?? 0));
        setVisibleStageTop(0);
        setVisiblePracticeHeight(Math.round(visibleHeight));
        return;
      }

      setVisibleStageTop(0);

      if (!viewport) {
        // Older WebViews: layout height often already excludes the keyboard.
        const height = Math.round(rect.height);
        setSoftKeyboardOpen(height > 0 && baselineLayoutHeight - layoutHeight > 120);
        setVisiblePracticeTop(0);
        setVisiblePracticeHeight(height > 0 ? height : null);
        return;
      }

      // getBoundingClientRect vs visualViewport disagree across engines:
      // A) rect is already visual-space → visible band [0, vv.height]
      // B) rect is layout-space → visible band [offsetTop, offsetTop+height]
      // iOS overlay/pan and Android pan differ; keep the larger non-empty band.
      const bands = [
        { top: Math.max(rect.top, 0), bottom: Math.min(rect.bottom, viewport.height) },
        { top: Math.max(rect.top, viewport.offsetTop), bottom: Math.min(rect.bottom, viewport.offsetTop + viewport.height) },
      ];
      let visibleTop = 0;
      let availableHeight = 0;
      for (const band of bands) {
        const height = band.bottom - band.top;
        if (height > availableHeight) {
          availableHeight = height;
          visibleTop = band.top - rect.top;
        }
      }

      const shrunkLayout = layoutHeight - viewport.height;
      const obscuredBelow = layoutHeight - (viewport.offsetTop + viewport.height);
      const canvasLost = rect.height - availableHeight;
      const shorterThanBaseline = baselineLayoutHeight - Math.max(layoutHeight, viewport.height, availableHeight);
      const keyboardOpen = Math.max(shrunkLayout, obscuredBelow, canvasLost, shorterThanBaseline) > 120;
      if (!keyboardOpen) baselineLayoutHeight = Math.max(baselineLayoutHeight, layoutHeight);

      // Never collapse the practice dock; keep a usable minimum so the top
      // status bar stays on screen on both iOS and Android.
      if (availableHeight < 48 && rect.height > 48) {
        // Band math failed — still clip to the visual viewport so the top bar
        // stays above the keyboard instead of sitting under a full-canvas dialog.
        const fallbackHeight = Math.round(Math.min(rect.height, Math.max(viewport.height, 160)));
        const fallbackTop = Math.round(Math.max(0, Math.min(rect.height - fallbackHeight, viewport.offsetTop - rect.top)));
        setVisiblePracticeTop(fallbackTop);
        setVisiblePracticeHeight(fallbackHeight);
      } else {
        setVisiblePracticeTop(Math.round(Math.max(0, visibleTop)));
        setVisiblePracticeHeight(Math.round(Math.max(availableHeight, keyboardOpen ? 160 : 0)));
      }
      setSoftKeyboardOpen(keyboardOpen);
    };
    syncVisibleViewport();
    viewport?.addEventListener('resize', syncVisibleViewport);
    viewport?.addEventListener('scroll', syncVisibleViewport);
    window.addEventListener('resize', syncVisibleViewport);
    window.addEventListener('orientationchange', syncVisibleViewport);
    const input = mobileInputRef.current;
    input?.addEventListener('focus', syncVisibleViewport);
    input?.addEventListener('blur', syncVisibleViewport);
    const resizeObserver = new ResizeObserver(syncVisibleViewport);
    const host = dialogRef.current?.getRootNode();
    if (host instanceof ShadowRoot) resizeObserver.observe(host.host);
    return () => {
      resizeObserver.disconnect();
      viewport?.removeEventListener('resize', syncVisibleViewport);
      viewport?.removeEventListener('scroll', syncVisibleViewport);
      window.removeEventListener('resize', syncVisibleViewport);
      window.removeEventListener('orientationchange', syncVisibleViewport);
      input?.removeEventListener('focus', syncVisibleViewport);
      input?.removeEventListener('blur', syncVisibleViewport);
    };
  }, [mobileInputActive, viewportDock]);
  useEffect(() => {
    if (!viewportDock || !mobileInputActive) return;
    const frame = window.requestAnimationFrame(() => {
      const content = contentRef.current;
      const currentWord = content?.querySelector<HTMLElement>('.sl-dictation-word.current');
      if (!content || !currentWord) return;
      const bounds = content.getBoundingClientRect();
      const word = currentWord.getBoundingClientRect();
      // Scroll only the sentence, never the page or the focused input. Safari
      // can pan the visual viewport when scrollIntoView reaches an ancestor.
      if (word.top < bounds.top) content.scrollTop += word.top - bounds.top - 8;
      else if (word.bottom > bounds.bottom) content.scrollTop += word.bottom - bounds.bottom + 8;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active?.segment.id, mobileInputActive, settings.showReference, viewportDock, visiblePracticeHeight, wordIndex]);
  useEffect(() => {
    if (initialItem >= 0) setItemIndex(initialItem);
  }, [initialItem]);
  useEffect(() => {
    resetSentence(active);
    if (active) onReplay(active.segment);
  }, [active?.segment.id, active?.revealed.join(',')]);
  useEffect(() => {
    if (!active || playerState !== 'playing') return;
    if (captionTimeMs >= active.segment.endMs - 35) onPause(active.segment);
  }, [active?.segment.id, captionTimeMs, onPause, playerState]);
  useEffect(() => {
    let cancelled = false;
    void browser.storage.local.get(SETTINGS_KEY).then(record => {
      if (cancelled) return;
      setSettings(mergeSettings(record[SETTINGS_KEY]));
      setSettingsReady(true);
    }).catch(() => setSettingsReady(true));
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!settingsReady) return;
    void browser.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => undefined);
  }, [settings, settingsReady]);
  useEffect(() => {
    clearAutoAdvance();
    if (!sentenceComplete || !settings.autoAdvance || itemIndex >= items.length - 1) return;
    autoAdvanceTimer.current = setTimeout(() => moveToItem(itemIndex + 1), 1000);
    return clearAutoAdvance;
  }, [clearAutoAdvance, itemIndex, items.length, moveToItem, sentenceComplete, settings.autoAdvance]);
  useEffect(() => {
    if (sentenceComplete) window.dispatchEvent(new CustomEvent('shadow-language:onboarding-action', { detail: 'dictation-complete' }));
  }, [sentenceComplete]);
  useEffect(() => () => {
    clearAutoAdvance();
    if (errorVisualTimer.current) clearTimeout(errorVisualTimer.current);
  }, [clearAutoAdvance]);

  const completeCurrentWord = useCallback((value: string, incorrect: boolean) => {
    if (!active) return;
    const slots = createDictationSlots(active.words.length);
    const nextCompleted = slots.completed.map((_, index) => Boolean(completed[index]));
    const nextDrafts = slots.drafts.map((_, index) => drafts[index] || '');
    const nextMistakes = slots.completed.map((_, index) => Boolean(mistakes[index]));
    nextCompleted[wordIndex] = true;
    nextDrafts[wordIndex] = value;
    nextMistakes[wordIndex] = incorrect;
    setCompleted(nextCompleted);
    setDrafts(nextDrafts);
    setMistakes(nextMistakes);
    setErrorWord(null);
    const next = nextIncompleteWord(nextCompleted, wordIndex);
    if (next === null) {
      setSentenceComplete(true);
      return;
    }
    setWordIndex(next);
  }, [active, completed, drafts, mistakes, wordIndex]);

  const handleMobileDraftChange = useCallback((value: string) => {
    if (!active || sentenceComplete) return;
    clearAutoAdvance();
    const targetWord = active.words[wordIndex];
    if (!targetWord) return;
    const filtered = Array.from(value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[\u2010-\u2013]/g, '-')).filter(isDictationCharacter).join('').slice(0, dictationMaximumDraftLength(targetWord));
    const correct = isDictationDraftCorrectPrefix(targetWord, filtered);
    if (!correct && !settings.continueOnError) {
      setErrorWord(null);
      requestAnimationFrame(() => setErrorWord(wordIndex));
      if (errorVisualTimer.current) clearTimeout(errorVisualTimer.current);
      errorVisualTimer.current = setTimeout(() => setErrorWord(null), 320);
      return;
    }
    if (isDictationDraftComplete(targetWord, filtered)) {
      completeCurrentWord(filtered, !correct);
      return;
    }
    const nextDrafts = [...drafts]; nextDrafts[wordIndex] = filtered;
    const nextMistakes = [...mistakes]; nextMistakes[wordIndex] = !correct;
    setDrafts(nextDrafts); setMistakes(nextMistakes); setSentenceComplete(false); setErrorWord(null);
  }, [active, clearAutoAdvance, completeCurrentWord, drafts, mistakes, sentenceComplete, settings.continueOnError, wordIndex]);

  const updateSetting = useCallback(<K extends keyof DictationPracticeSettings>(key: K, value: DictationPracticeSettings[K]) => {
    setSettings(current => ({ ...current, [key]: value }));
  }, []);

  // Pressing any dictation control moves focus off the input, and a focused
  // element leaving the field dismisses the soft keyboard mid-sentence. Cancel
  // the focus default on press, then hand focus back for engines that focus on
  // press anyway. The speed picker keeps its native gesture: cancelling it would
  // stop the system sheet from opening.
  const holdDictationFocus = useCallback((event: React.SyntheticEvent) => {
    if (!mobileInputActive || sentenceComplete) return;
    if (event.target instanceof Element && event.target.closest('select')) return;
    event.preventDefault();
  }, [mobileInputActive, sentenceComplete]);
  const restoreDictationFocus = useCallback(() => {
    if (!mobileInputActive || sentenceComplete) return;
    const input = mobileInputRef.current;
    if (!input || deepActiveElement() === input) return;
    input.focus({ preventScroll: true });
  }, [mobileInputActive, sentenceComplete]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
      if (interactiveTarget(event.target) || hasModifier) return;
      const targetWord = active?.words[wordIndex];
      const optionalSpace = event.key === ' ' && !sentenceComplete && Boolean(targetWord && isDictationHyphenBoundary(targetWord, drafts[wordIndex] || ''));
      const practiceKey = optionalSpace || event.key === 'Escape' || event.key === '[' || event.key.startsWith('Arrow') || event.key === 'Backspace' || event.key === 'Tab' || event.key === 'Enter' || isDictationCharacter(event.key);
      if (practiceKey) event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (!active) return;
      if (optionalSpace) { event.preventDefault(); return; }
      if (event.key === '[') { event.preventDefault(); updateSetting('showReference', !settings.showReference); return; }
      if (event.key === 'ArrowLeft') { event.preventDefault(); moveToItem(itemIndex - 1); return; }
      if (event.key === 'ArrowRight') { event.preventDefault(); moveToItem(itemIndex + 1); return; }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); replay(); return; }
      if (sentenceComplete) {
        if (event.key === 'Backspace' || event.key === 'Tab' || event.key === 'Enter' || isDictationCharacter(event.key)) event.preventDefault();
        return;
      }
      if (!targetWord) return;
      if (event.key === 'Backspace') {
        event.preventDefault(); clearAutoAdvance();
        const nextDrafts = [...drafts];
        nextDrafts[wordIndex] = (nextDrafts[wordIndex] || '').slice(0, -1);
        const nextCompleted = [...completed]; nextCompleted[wordIndex] = false;
        const nextMistakes = [...mistakes]; nextMistakes[wordIndex] = !isDictationDraftCorrectPrefix(targetWord, nextDrafts[wordIndex] || '');
        setDrafts(nextDrafts); setCompleted(nextCompleted); setMistakes(nextMistakes); setSentenceComplete(false); setErrorWord(null);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const next = event.shiftKey
          ? previousDictationWord(active.words.length, wordIndex, active.revealed)
          : nextIncompleteWord(completed, wordIndex);
        if (next !== null) setWordIndex(next);
        setErrorWord(null);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const value = drafts[wordIndex] || '';
        if (isDictationDraftCorrect(targetWord, value)) completeCurrentWord(value, false);
        return;
      }
      if (!isDictationCharacter(event.key)) return;
      event.preventDefault();
      const current = drafts[wordIndex] || '';
      const result = applyDictationCharacter(targetWord, current, event.key, settings.continueOnError);
      if (result.status === 'accepted') {
        const nextDrafts = [...drafts]; nextDrafts[wordIndex] = result.value;
        const nextMistakes = [...mistakes]; nextMistakes[wordIndex] = !result.correct;
        setDrafts(nextDrafts); setMistakes(nextMistakes); setErrorWord(null);
        if (result.complete) completeCurrentWord(result.value, !result.correct);
        return;
      }
      setErrorWord(null);
      requestAnimationFrame(() => setErrorWord(wordIndex));
      if (errorVisualTimer.current) clearTimeout(errorVisualTimer.current);
      errorVisualTimer.current = setTimeout(() => setErrorWord(null), 320);
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [active, clearAutoAdvance, completeCurrentWord, completed, drafts, itemIndex, mistakes, moveToItem, onClose, replay, sentenceComplete, settings, updateSetting, wordIndex]);

  if (!active) return <div ref={dialogRef} tabIndex={-1} className="sl-dictation" role="dialog" aria-modal="true" aria-label={t("逐句听写")} onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}><button className="sl-dictation-close" onClick={onClose} aria-label={t("关闭逐句听写")}>×</button><p className="sl-dictation-empty">{t("当前字幕没有可用于听写的英文单词。")}</p><style>{DICTATION_PRACTICE_CSS}</style></div>;
  const translation = translationFor(active.segment);

  return <div
    ref={dialogRef}
    tabIndex={-1}
    className={`sl-dictation ${viewportDock && mobileInputActive ? 'sl-dictation-viewport-dock' : ''} ${portraitFallback ? 'sl-dictation-await-portrait' : ''} ${softKeyboardOpen && !portraitFallback ? 'sl-dictation-keyboard-open' : ''}`}
    style={visiblePracticeHeight !== null ? { '--sl-dictation-visible-height': `${visiblePracticeHeight}px`, '--sl-dictation-visible-top': `${visiblePracticeTop}px`, '--sl-dictation-stage-top': `${visibleStageTop}px` } as React.CSSProperties : undefined}
    role="dialog"
    aria-modal="true"
    aria-label={t("逐句听写")}
    onPointerDown={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()}
    onMouseDown={event => event.stopPropagation()}
    onMouseUp={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => event.stopPropagation()}
  >
    <style>{DICTATION_PRACTICE_CSS}</style>
    <button className="sl-dictation-close" onClick={onClose} aria-label={t("关闭逐句听写")} title={t("关闭（Esc）")}>×</button>
    {portraitFallback && <DictationPortraitPrompt {...(onDismissPortraitFallback ? { onDismiss: onDismissPortraitFallback } : {})} />}
    <div className="sl-dictation-toolbar" role="toolbar" aria-label={t("逐句听写控制")} onPointerDown={event => { event.stopPropagation(); holdDictationFocus(event); }} onMouseDown={event => { event.stopPropagation(); holdDictationFocus(event); }} onClick={restoreDictationFocus}>
      <label title={t("显示或隐藏当前完整台词（[）")}><span>{t("查看全句")}</span><input type="checkbox" checked={settings.showReference} onChange={event => updateSetting('showReference', event.target.checked)} /><i /></label>
      <label title={t("完成当前句后自动进入下一句")}><span>{t("自动下一句")}</span><input type="checkbox" checked={settings.autoAdvance} onChange={event => updateSetting('autoAdvance', event.target.checked)} /><i /></label>
      <button type="button" className={`sl-dictation-toggle-btn sl-dictation-error-mode ${settings.continueOnError ? 'is-continue' : 'is-intercept'}`} aria-pressed={settings.continueOnError} onClick={() => updateSetting('continueOnError', !settings.continueOnError)} title={settings.continueOnError ? t("拼错继续：输入错误时标红记录，允许直接继续输入") : t("拼错拦截：输入错误时阻止前进，必须纠正后才可继续")}><span className="sl-dictation-btn-dot" aria-hidden="true" /><span>{settings.continueOnError ? t("拼错继续") : t("拼错拦截")}</span></button>
      <button type="button" className={`sl-dictation-toggle-btn sl-dictation-mask-toggle ${subtitleMaskEnabled ? 'is-active' : ''}`} aria-pressed={subtitleMaskEnabled} onClick={onToggleSubtitleMask} title={subtitleMaskEnabled ? t("已开启遮挡板：点击隐藏遮挡板") : t("遮挡原字幕：覆盖视频自带的内嵌字幕，避免看到答案")}><span className="sl-dictation-btn-dot" aria-hidden="true" /><span>{subtitleMaskEnabled ? t("已遮挡原字幕") : t("遮挡原字幕")}</span></button>
      <button className="sl-dictation-navigation" disabled={itemIndex === 0} onClick={() => moveToItem(itemIndex - 1)} title={t("上一句（←）")} aria-label={t("上一句")}><span aria-hidden="true">‹</span></button>
      <button className="sl-dictation-navigation" onClick={replay} title={t("重播当前句（↑ / ↓）")} aria-label={t("重播当前句")}><span aria-hidden="true">↻</span></button>
      <button className="sl-dictation-navigation" disabled={itemIndex >= items.length - 1} onClick={() => moveToItem(itemIndex + 1)} title={t("下一句（→）")} aria-label={t("下一句")}><span aria-hidden="true">›</span></button>
      <label className="sl-dictation-speed"><span>{t("倍速")}</span><select aria-label={t("听写播放速度")} value={playbackRate} onChange={event => onPlaybackRateChange(Number(event.target.value))}>{PLAYBACK_RATES.map(speed => <option key={speed} value={speed}>{speed.toFixed(1)}×</option>)}</select></label>
    </div>
    <section className="sl-dictation-stage">
      <small>{t("本句")}{active.words.length} {t("个听写项 ·")}{sentenceComplete ? t("已完成") : t("当前 {0}/{1}", wordIndex + 1, active.words.length)}</small>
      <div ref={contentRef} className="sl-dictation-content">
        {settings.showReference && <div className="sl-dictation-reference">{translation && <span>{translation}</span>}<strong>{active.segment.text}</strong></div>}
        <div className="sl-dictation-words" aria-label={t("听写句子，共 {0} 个听写项", active.words.length)}>
          {active.words.map((word, index) => {
            const revealed = Boolean(active.revealed[index]);
            const done = revealed || Boolean(completed[index]) || sentenceComplete;
            const current = !revealed && index === wordIndex && !sentenceComplete;
            const draft = drafts[index] || '';
            const incorrect = Boolean(mistakes[index]);
            const correct = done && !incorrect;
            return <div key={`${active.segment.id}:${index}:${word}`} className={`sl-dictation-word ${revealed ? 'revealed' : ''} ${done ? 'done' : ''} ${correct ? 'correct' : ''} ${incorrect ? 'incorrect' : ''} ${current ? 'current' : ''} ${errorWord === index ? 'error' : ''}`} title={revealed ? t("生词提示，无需输入") : undefined} style={{ '--sl-dictation-chars': Math.max(current ? dictationExpectedCharacterCount(word, draft) : dictationRequiredCharacterCount(word), 2) } as React.CSSProperties}>
              <span className="sl-dictation-measure" aria-hidden="true">{word}</span>
              <span className="sl-dictation-visible">{done ? (incorrect ? draft : word) : <>{current ? draft : ''}{current && <em className="sl-dictation-cursor" />}</>}</span>
              {!correct && <span className="sl-dictation-answer" aria-hidden="true">{word}</span>}
              <span className={`sl-dictation-line ${correct ? 'done' : ''} ${incorrect ? 'incorrect' : ''}`} aria-hidden="true" />
            </div>;
          })}
        </div>
      </div>
    </section>
    {mobileInputActive && <div className="sl-dictation-mobile-input-wrap">
        <label htmlFor={`${mobileInputId}-word`}>{t("输入当前听写项")}</label>
        <input
          ref={mobileInputRef}
          id={`${mobileInputId}-word`}
          className="sl-dictation-mobile-input"
          type="text"
          inputMode="text"
          enterKeyHint="next"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={sentenceComplete && !preserveMobileKeyboard}
          value={sentenceComplete ? '' : drafts[wordIndex] || ''}
          aria-label={t("输入当前听写项")}
          onChange={event => handleMobileDraftChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
            if (event.key === 'Tab') {
              event.preventDefault();
              const next = event.shiftKey
                ? previousDictationWord(active.words.length, wordIndex, active.revealed)
                : nextIncompleteWord(completed, wordIndex);
              if (next !== null) setWordIndex(next);
              setErrorWord(null);
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              const targetWord = active.words[wordIndex];
              const value = drafts[wordIndex] || '';
              if (targetWord && isDictationDraftCorrect(targetWord, value)) completeCurrentWord(value, false);
              return;
            }
          }}
        />
    </div>}
    <p className="sl-dictation-hint">{t("整数可用数字或英文 · 复合词可连打或用空格分开 · 撇号可省略 · 其他位置空格播放/暂停 · Tab 切词")}</p>
  </div>;
}

export const DICTATION_PRACTICE_CSS = `
.sl-dictation { position:absolute; inset:0; z-index:40; color:#f7fbf8; outline:none; pointer-events:auto; }
.sl-dictation-close { position:absolute; top:14px; right:16px; z-index:3; width:42px; height:42px; border:0; border-radius:50%; color:#fff; background:rgba(8,12,10,.48); cursor:pointer; font-size:28px; line-height:1; backdrop-filter:blur(8px); }
.sl-dictation-close:hover { background:rgba(255,255,255,.16); }
.sl-dictation-toolbar { position:absolute; bottom:max(12px,env(safe-area-inset-bottom)); left:50%; z-index:3; display:flex; min-height:48px; box-sizing:border-box; align-items:center; gap:7px; max-width:calc(100% - 140px); padding:7px 10px; border:1px solid rgba(66,210,137,.35); border-radius:999px; background:rgba(8,12,10,.72); box-shadow:0 10px 30px rgba(0,0,0,.34); transform:translateX(-50%); backdrop-filter:blur(12px); white-space:nowrap; }
.sl-dictation-toolbar > * { flex:0 0 auto; align-self:center; }
.sl-dictation-toolbar > button { display:grid; place-items:center; width:32px; height:32px; padding:0; border:0; border-radius:50%; color:#ecf7f0; background:transparent; cursor:pointer; font-size:24px; line-height:1; }
.sl-dictation-toolbar > button > span { display:block; line-height:1; transform:translateY(-1px); }
.sl-dictation-toolbar > button:hover:not(:disabled) { background:rgba(255,255,255,.1); }
.sl-dictation-toolbar > button:disabled { opacity:.3; cursor:default; }
.sl-dictation-toolbar > button.sl-dictation-toggle-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; width:auto; height:30px; padding:0 12px; border-radius:999px; font-size:12px; font-weight:500; line-height:1; letter-spacing:.2px; border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.05); color:#d7e4dc; transition:all .18s ease; cursor:pointer; }
.sl-dictation-toolbar > button.sl-dictation-toggle-btn:hover:not(:disabled) { background:rgba(255,255,255,.12); border-color:rgba(255,255,255,.3); color:#fff; }
.sl-dictation-toolbar > button.sl-dictation-toggle-btn .sl-dictation-btn-dot { width:6px; height:6px; border-radius:50%; background:rgba(255,255,255,.35); flex-shrink:0; transition:all .18s ease; }
.sl-dictation-toolbar > button.sl-dictation-error-mode.is-intercept { border-color:rgba(66,210,137,.45); background:rgba(66,210,137,.12); color:#d1fae5; }
.sl-dictation-toolbar > button.sl-dictation-error-mode.is-intercept:hover:not(:disabled) { border-color:rgba(66,210,137,.7); background:rgba(66,210,137,.2); }
.sl-dictation-toolbar > button.sl-dictation-error-mode.is-intercept .sl-dictation-btn-dot { background:#34d399; box-shadow:0 0 6px rgba(52,211,153,.7); }
.sl-dictation-toolbar > button.sl-dictation-error-mode.is-continue { border-color:rgba(251,146,60,.5); background:rgba(251,146,60,.14); color:#fed7aa; }
.sl-dictation-toolbar > button.sl-dictation-error-mode.is-continue:hover:not(:disabled) { border-color:rgba(251,146,60,.75); background:rgba(251,146,60,.22); }
.sl-dictation-toolbar > button.sl-dictation-error-mode.is-continue .sl-dictation-btn-dot { background:#fb923c; box-shadow:0 0 6px rgba(251,146,60,.7); }
.sl-dictation-toolbar > button.sl-dictation-mask-toggle.is-active { border-color:rgba(66,210,137,.65); background:rgba(31,156,103,.3); color:#c9f8df; }
.sl-dictation-toolbar > button.sl-dictation-mask-toggle.is-active:hover:not(:disabled) { border-color:rgba(66,210,137,.85); background:rgba(31,156,103,.4); }
.sl-dictation-toolbar > button.sl-dictation-mask-toggle.is-active .sl-dictation-btn-dot { background:#34d399; box-shadow:0 0 6px rgba(52,211,153,.8); }
.sl-dictation-toolbar label { display:flex; height:32px; box-sizing:border-box; align-items:center; gap:7px; color:#d3dfd7; cursor:pointer; font-size:12px; line-height:1; }
.sl-dictation-toolbar label > span { display:inline-flex; height:32px; align-items:center; line-height:1; }
.sl-dictation-toolbar label input { position:absolute; opacity:0; pointer-events:none; }
.sl-dictation-toolbar label > i { position:relative; display:block; width:34px; height:18px; border-radius:999px; background:rgba(255,255,255,.18); transition:background .16s ease; }
.sl-dictation-toolbar label > i:after { position:absolute; top:4px; left:4px; width:10px; height:10px; border-radius:50%; background:#fff; content:""; transition:transform .16s ease; }
.sl-dictation-toolbar label input:checked + i { background:#35c98a; }
.sl-dictation-toolbar label input:checked + i:after { transform:translateX(16px); }
.sl-dictation-speed { position:relative; padding-left:6px; }
.sl-dictation-speed select { display:block; min-width:62px; height:30px; border:1px solid rgba(255,255,255,.16); border-radius:999px; padding:0 8px; color:#fff; background:rgba(0,0,0,.25); line-height:28px; }
.sl-dictation-stage { position:absolute; left:50%; bottom:max(72px,calc(env(safe-area-inset-bottom) + 60px)); width:min(88%,1120px); padding:36px clamp(14px,2.5vw,30px) 12px; border-radius:18px; background:linear-gradient(180deg,transparent,rgba(0,0,0,.16) 28%,rgba(0,0,0,.34)); transform:translateX(-50%); text-align:center; backdrop-filter:blur(2px); }
.sl-dictation-stage > small { position:absolute; top:11px; left:16px; padding:4px 9px; border:1px solid rgba(255,255,255,.1); border-radius:999px; color:rgba(255,255,255,.64); background:rgba(8,12,10,.42); font-size:11px; }
.sl-dictation-reference { display:grid; gap:3px; max-width:900px; margin:0 auto 12px; text-shadow:0 2px 12px rgba(0,0,0,.72); }
.sl-dictation-reference span { color:rgba(255,255,255,.72); font-size:clamp(12px,1vw,16px); line-height:1.45; }
.sl-dictation-reference strong { color:rgba(255,255,255,.94); font-size:clamp(14px,1.35vw,20px); line-height:1.4; }
.sl-dictation-words { display:flex; flex-wrap:wrap; justify-content:center; gap:12px clamp(12px,2.2vw,32px); }
.sl-dictation-word { position:relative; display:grid; width:max-content; min-width:24px; max-width:100%; justify-items:center; gap:5px; --sl-dictation-step:calc(100% / var(--sl-dictation-chars,4)); }
.sl-dictation-measure,.sl-dictation-visible,.sl-dictation-answer { grid-area:1 / 1; white-space:nowrap; }
.sl-dictation-measure { visibility:hidden; font-size:clamp(16px,1.45vw,22px); font-weight:650; }
.sl-dictation-visible,.sl-dictation-answer { display:inline-flex; align-items:center; justify-content:center; min-height:30px; font-size:clamp(16px,1.45vw,22px); font-weight:650; text-shadow:0 2px 10px rgba(0,0,0,.78); }
.sl-dictation-answer { visibility:hidden; color:#fff; }
.sl-dictation-word:not(.correct):hover .sl-dictation-visible { visibility:hidden; }
.sl-dictation-word:not(.correct):hover .sl-dictation-answer { visibility:visible; }
.sl-dictation-cursor { display:inline-block; width:2px; height:1.15em; margin-left:2px; border-radius:2px; background:currentColor; box-shadow:0 0 6px rgba(255,255,255,.42); animation:sl-dictation-blink 1s steps(1,end) infinite; }
.sl-dictation-line { grid-area:2 / 1; display:block; width:100%; height:3px; border-radius:999px; background:repeating-linear-gradient(90deg,transparent 0,transparent calc(var(--sl-dictation-step) - 4px),rgba(255,255,255,.2) calc(var(--sl-dictation-step) - 4px),rgba(255,255,255,.2) var(--sl-dictation-step)),linear-gradient(90deg,var(--sl-action-primary,#e8b86d),var(--sl-text-accent,#f9d99b)); box-shadow:0 2px 10px rgba(0,0,0,.45),0 0 10px rgba(232,184,109,.18); }
.sl-dictation-line.done { background:linear-gradient(90deg,#34d399,#2dd4bf); }
.sl-dictation-word.revealed .sl-dictation-visible { color:#f9d99b; }
.sl-dictation-word.revealed .sl-dictation-line { visibility:hidden; }
.sl-dictation-word.incorrect .sl-dictation-visible { color:#fb7185; }
.sl-dictation-line.incorrect { background:linear-gradient(90deg,#fb7185,#f43f5e); }
.sl-dictation-mobile-input-wrap { position:absolute; left:50%; bottom:72px; z-index:3; display:grid; justify-items:center; gap:6px; width:min(520px,calc(100% - 28px)); transform:translateX(-50%); }
.sl-dictation-mobile-input-wrap label { color:rgba(255,255,255,.62); font-size:11px; }
.sl-dictation-mobile-input { display:block; width:min(100%,420px); min-height:48px; padding:8px 14px; border:1px solid rgba(66,210,137,.6); border-radius:12px; color:#fff; background:rgba(8,14,11,.82); box-shadow:0 0 0 3px rgba(52,211,153,.12); outline:none; font:600 20px/1.3 system-ui,sans-serif; text-align:center; }
.sl-dictation-mobile-input:focus { border-color:#7ee2b0; box-shadow:0 0 0 3px rgba(52,211,153,.26); }
.sl-dictation-mobile-input:disabled { opacity:.6; }
.sl-dictation-word.error { animation:sl-dictation-shake .32s ease-in-out; }
.sl-dictation-word.error .sl-dictation-line { background:linear-gradient(90deg,#fb7185,#f43f5e); }
.sl-dictation-hint { position:absolute; left:50%; bottom:max(66px,calc(env(safe-area-inset-bottom) + 54px)); margin:0; color:rgba(255,255,255,.56); transform:translateX(-50%); font-size:10px; }
.sl-dictation-empty { position:absolute; top:50%; left:50%; margin:0; padding:18px 22px; border-radius:12px; color:#fff; background:rgba(8,14,11,.9); transform:translate(-50%,-50%); }
.sl-whole-sentence-stage { position:absolute; left:50%; top:50%; width:min(760px,calc(100% - 36px)); max-height:calc(100% - 120px); overflow:auto; padding:34px clamp(18px,4vw,42px) 26px; border:1px solid rgba(66,210,137,.28); border-radius:22px; background:rgba(8,14,11,.86); box-shadow:0 18px 60px rgba(0,0,0,.42); transform:translate(-50%,-50%); }
.sl-whole-sentence-stage > small { display:block; color:rgba(255,255,255,.62); font-size:11px; letter-spacing:.04em; }
.sl-whole-sentence-translation { margin:10px 0 20px; color:rgba(255,255,255,.76); font-size:14px; line-height:1.7; }
.sl-sentence-submission label { display:block; margin:12px 0 8px; color:#fff; font-size:14px; font-weight:600; }
.sl-sentence-submission textarea { display:block; width:100%; min-height:116px; padding:14px; border:1px solid rgba(255,255,255,.24); border-radius:12px; color:#fff; background:rgba(255,255,255,.08); font:16px/1.7 system-ui,sans-serif; resize:vertical; }
.sl-sentence-submission textarea:focus { border-color:#34d399; outline:2px solid rgba(52,211,153,.28); outline-offset:2px; }
.sl-sentence-submission .onb-muted { margin:10px 0 14px; color:rgba(255,255,255,.56); font-size:11px; }
.sl-sentence-submission .onb-primary,.sl-whole-sentence-replay { min-height:40px; padding:9px 14px; border:1px solid rgba(52,211,153,.55); border-radius:10px; color:#07150e; background:#7ee2b0; cursor:pointer; font:600 13px system-ui,sans-serif; }
.sl-sentence-submission .onb-primary:disabled { opacity:.45; cursor:not-allowed; }
.sl-whole-sentence-replay { margin-top:14px; color:#d9f9e8; background:rgba(52,211,153,.12); }
.sl-whole-sentence-replay:hover { background:rgba(52,211,153,.22); }
.sl-dictation-await-portrait { background:#080e0b; }
.sl-dictation-await-portrait :is(.sl-dictation-toolbar,.sl-dictation-stage,.sl-dictation-mobile-input-wrap,.sl-dictation-hint,.sl-whole-sentence-stage) { display:none; }
.sl-dictation-rotate-prompt { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:24px; text-align:center; }
.sl-dictation-rotate-prompt strong { font-size:clamp(22px,4vw,34px); }
.sl-dictation-rotate-prompt span { color:rgba(255,255,255,.7); font-size:16px; }
.sl-dictation-dismiss-portrait { min-height:44px; margin-top:8px; padding:10px 18px; border:1px solid rgba(66,210,137,.6); border-radius:12px; color:#d9f9e8; background:rgba(52,211,153,.12); font:600 15px system-ui,sans-serif; cursor:pointer; }
.sl-dictation-dismiss-portrait:focus-visible { outline:2px solid #7ee2b0; outline-offset:3px; }
@keyframes sl-dictation-blink { 0%,48% { opacity:1; } 49%,100% { opacity:0; } }
@keyframes sl-dictation-shake { 0%,100% { transform:translateX(0); } 25% { transform:translateX(-3px); } 50% { transform:translateX(3px); } 75% { transform:translateX(-2px); } }
@media(max-width:760px) {
  .sl-dictation { pointer-events:auto; background:linear-gradient(180deg,rgba(0,0,0,.2),transparent 28%,rgba(0,0,0,.22)); }
  .sl-dictation-toolbar { bottom:max(10px,env(safe-area-inset-bottom)); max-width:calc(100% - 20px); flex-wrap:wrap; justify-content:center; border-radius:18px; }
  .sl-dictation-stage { bottom:max(150px,calc(env(safe-area-inset-bottom) + 138px)); width:calc(100% - 24px); padding:30px 12px 12px; }
  .sl-dictation-stage > small { top:10px; }
  .sl-dictation-hint { display:none; }
  .sl-whole-sentence-stage { width:calc(100% - 24px); max-height:calc(100% - 84px); padding:28px 16px 18px; }
  .sl-dictation-visible,.sl-dictation-answer,.sl-dictation-measure { font-size:clamp(15px,4vw,19px); }
  .sl-dictation-mobile-input { min-height:46px; font-size:18px; }
}
@media(max-width:1199px) {
  .sl-dictation { background:linear-gradient(180deg,rgba(0,0,0,.34),rgba(0,0,0,.08) 42%,rgba(0,0,0,.4)); }
  .sl-dictation-close { top:max(10px,env(safe-area-inset-top)); right:12px; width:38px; height:38px; font-size:24px; z-index:5; }
  .sl-dictation-stage {
    top:clamp(48px,8dvh,92px);
    bottom:auto;
    box-sizing:border-box;
    width:min(760px,calc(100% - 28px));
    /* Floor the height: on short viewports (soft keyboard / small phones)
       calc(100% - 235px) can hit 0 and make the top dictation bar disappear. */
    max-height:max(96px,calc(100% - 235px - env(safe-area-inset-bottom)));
    overflow:auto;
    padding:32px 16px 14px;
    border-radius:16px;
    background:linear-gradient(180deg,rgba(8,12,10,.38),rgba(8,12,10,.66));
    scrollbar-width:thin;
  }
  .sl-dictation-reference { margin-bottom:9px; }
  .sl-dictation-words { gap:9px clamp(10px,2vw,22px); }
  .sl-dictation-visible,.sl-dictation-answer,.sl-dictation-measure { font-size:clamp(15px,2.4vw,20px); }
  .sl-dictation-mobile-input { width:100%; min-height:44px; font-size:17px; box-sizing:border-box; }
  .sl-dictation-toolbar {
    bottom:max(10px,env(safe-area-inset-bottom));
    width:min(760px,calc(100% - 24px));
    max-width:none;
    min-height:46px;
    justify-content:flex-start;
    flex-wrap:nowrap;
    gap:5px;
    overflow-x:auto;
    padding:6px 8px;
    border-radius:14px;
    scrollbar-width:none;
  }
  .sl-dictation-toolbar::-webkit-scrollbar { display:none; }
  .sl-dictation-toolbar > .sl-dictation-navigation { order:-1; }
  .sl-dictation-toolbar label { gap:4px; font-size:11px; }
  .sl-dictation-toolbar > button.sl-dictation-toggle-btn { gap:4px; padding:0 8px; font-size:11px; }
  .sl-dictation-speed { padding-left:2px; }
  .sl-dictation-speed select { min-width:58px; padding:0 6px; }
  .sl-dictation-hint { display:none; }
}
.sl-dictation-keyboard-open {
  top:var(--sl-dictation-visible-top,0px);
  bottom:auto;
  height:var(--sl-dictation-visible-height,50dvh);
  min-height:160px;
  overflow:hidden;
}
.sl-dictation-keyboard-open .sl-dictation-close { top:calc(var(--sl-dictation-stage-top,0px) + 6px); right:8px; width:36px; height:36px; z-index:6; }
.sl-dictation-keyboard-open .sl-dictation-toolbar {
  top:auto;
  bottom:4px;
  left:8px;
  width:calc(100% - 16px);
  max-width:none;
  min-height:38px;
  padding:3px 6px;
  transform:none;
  z-index:4;
}
.sl-dictation-keyboard-open .sl-dictation-toolbar > label:not(.sl-dictation-speed),
.sl-dictation-keyboard-open .sl-dictation-toolbar > button.sl-dictation-toggle-btn { display:none; }
/* Top dictation bar must stay pinned above the keyboard on iOS (overlay/pan)
   and Android (resize/pan). Keep status + word slots visible; leave room for close. */
.sl-dictation-keyboard-open .sl-dictation-stage {
  top:var(--sl-dictation-stage-top,0px);
  bottom:auto;
  left:50%;
  transform:translateX(-50%);
  width:calc(100% - 12px);
  max-height:max(88px,min(34%,160px,calc(100% - var(--sl-dictation-stage-top,0px) - 112px)));
  overflow:auto;
  box-sizing:border-box;
  padding:8px 48px 8px 12px;
  border-radius:0 0 14px 14px;
  background:linear-gradient(180deg,rgba(8,12,10,.82),rgba(8,12,10,.64));
  z-index:5;
}
.sl-dictation-keyboard-open .sl-dictation-stage > small {
  position:sticky;
  top:0;
  z-index:1;
  display:inline-flex;
  margin-bottom:4px;
}
.sl-dictation-keyboard-open .sl-dictation-words { gap:7px 10px; }
.sl-dictation-keyboard-open .sl-dictation-mobile-input-wrap {
  bottom:50px;
  width:calc(100% - 20px);
  padding:2px 0;
  z-index:4;
}
.sl-dictation-keyboard-open .sl-dictation-mobile-input-wrap label { display:none; }
.sl-dictation-keyboard-open .sl-dictation-mobile-input { min-height:40px; font-size:16px; }
/* Normal Web touch practice: the sentence owns the remaining space; input and
   controls occupy two stable rows immediately above the software keyboard. */
.sl-dictation.sl-dictation-viewport-dock {
  position:fixed;
  top:var(--sl-dictation-visible-top,0px);
  left:0;
  right:0;
  bottom:auto;
  height:var(--sl-dictation-visible-height,100dvh);
  min-height:0;
  box-sizing:border-box;
  padding:50px 12px max(8px,env(safe-area-inset-bottom));
  overflow:hidden;
}
.sl-dictation-viewport-dock:not(.sl-dictation-await-portrait) {
  display:grid;
  grid-template-rows:minmax(0,1fr) auto auto;
  gap:8px;
}
.sl-dictation-viewport-dock.sl-dictation-keyboard-open { padding-bottom:8px; }
.sl-dictation-viewport-dock .sl-dictation-close { top:6px; right:12px; }
.sl-dictation-viewport-dock .sl-dictation-stage {
  position:static;
  grid-row:1;
  align-self:end;
  display:flex;
  flex-direction:column;
  min-height:0;
  width:100%;
  max-height:100%;
  box-sizing:border-box;
  padding:12px 16px 16px;
  overflow:hidden;
  border-radius:16px;
  transform:none;
  background:linear-gradient(180deg,rgba(8,12,10,.72),rgba(8,12,10,.64));
}
.sl-dictation-viewport-dock .sl-dictation-stage > small {
  position:static;
  flex:none;
  align-self:center;
  margin:0 0 12px;
}
.sl-dictation-viewport-dock .sl-dictation-content {
  min-height:0;
  overflow:auto;
  overscroll-behavior:contain;
  scrollbar-width:thin;
}
.sl-dictation-viewport-dock .sl-dictation-words { gap:14px 20px; padding:4px 0; }
.sl-dictation-viewport-dock .sl-dictation-word { flex:0 0 auto; }
.sl-dictation-viewport-dock :is(.sl-dictation-visible,.sl-dictation-answer,.sl-dictation-measure) { font-size:clamp(17px,2.4vw,20px); }
.sl-dictation-viewport-dock .sl-dictation-mobile-input-wrap {
  position:static;
  grid-row:2;
  width:100%;
  padding:0;
  transform:none;
}
.sl-dictation-viewport-dock .sl-dictation-mobile-input-wrap label { display:none; }
.sl-dictation-viewport-dock .sl-dictation-mobile-input { width:100%; min-height:44px; box-sizing:border-box; font-size:17px; }
.sl-dictation-viewport-dock .sl-dictation-toolbar {
  position:static;
  grid-row:3;
  width:100%;
  max-width:none;
  min-height:42px;
  padding:5px 8px;
  justify-content:flex-start;
  flex-wrap:nowrap;
  overflow-x:auto;
  border-radius:14px;
  scrollbar-width:thin;
  transform:none;
}
.sl-dictation-viewport-dock .sl-dictation-toolbar > :is(.sl-dictation-navigation,.sl-dictation-speed) { order:-1; }
/* Keyboard mode normally hides secondary controls. Web's scrollable dock has
   room to keep them available, including on narrow screens. */
.sl-dictation-viewport-dock.sl-dictation-keyboard-open .sl-dictation-toolbar > label:not(.sl-dictation-speed) { display:flex; }
.sl-dictation-viewport-dock.sl-dictation-keyboard-open .sl-dictation-toolbar > button.sl-dictation-toggle-btn { display:inline-flex; }
.sl-dictation-viewport-dock .sl-dictation-toolbar::-webkit-scrollbar { display:block; height:3px; }
.sl-dictation-viewport-dock .sl-dictation-toolbar::-webkit-scrollbar-thumb { background:rgba(255,255,255,.45); border-radius:3px; }
.sl-dictation-viewport-dock .sl-dictation-hint { display:none; }
@media(prefers-reduced-motion:reduce) { .sl-dictation-word.error,.sl-dictation-cursor { animation:none; } }
`;

/** Whole-sentence feedback is an orchestration option, never the default player behavior. */
export function DictationPractice(props: DictationPracticeProps | SentenceSubmissionProps) {
  return 'submissionMode' in props ? <SentenceSubmission {...props} /> : <GuidedDictationPractice {...props} />;
}
