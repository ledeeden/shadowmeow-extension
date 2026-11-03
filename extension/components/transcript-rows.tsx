import { t } from '../lib/i18n';
import React, { memo, useEffect, useRef, useState } from 'react';
import { tokenizeCaptionText, type NormalizedSegment } from '@shadow-language/contracts';
import { selectedTextIn } from '../lib/text-selection';
import { lookupReaderWord } from '../lib/reader-frequency';
import { vocabularyTermKeys } from '../lib/vocabulary';
import { isNewSubtitleWord, subtitleMaskText, type SubtitleDisplayMode } from '../lib/subtitle-display';

type TranscriptRowsProps = {
  segments: NormalizedSegment[];
  displayMode?: SubtitleDisplayMode;
  showEnglish?: boolean;
  translations?: string[];
  currentIndex: number;
  emptyText: string;
  vocabularySize: number;
  masteredVocabulary: Set<string>;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onSeek: (index: number) => void;
  onSelect: (selection: { text: string; segment: NormalizedSegment; index: number }) => void;
  onWordClick?: (term: string, element: HTMLElement, wordIndex: number, segment: NormalizedSegment, index: number) => void;
};

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function TranscriptText({ text, vocabularySize, masteredVocabulary, displayMode = 'all', onWordClick }: {
  text: string;
  displayMode?: SubtitleDisplayMode;
  vocabularySize: number;
  masteredVocabulary: Set<string>;
  onWordClick?: (term: string, element: HTMLElement, wordIndex: number) => void;
}) {
  let wordIndex = 0;
  return <>{tokenizeCaptionText(text).map((token) => {
    if (token.kind !== 'word' || !token.lookupText) return <React.Fragment key={token.key}>{displayMode === 'all' ? token.text : token.text.replace(/\S/g, ' ')}</React.Fragment>;
    const currentWordIndex = wordIndex++;
    const info = lookupReaderWord(token.lookupText);
    const vocabularyKeys = vocabularyTermKeys(token.lookupText, info.lemma);
    const outsideVocabulary = isNewSubtitleWord({
      vocabularySize,
      vocabularyKeys,
      vocabularyRank: info.rank,
      countable: info.countable,
      masteredVocabulary,
    });
    const masked = displayMode === 'hidden' || (displayMode === 'new-words' && !outsideVocabulary);
    if (masked) return <React.Fragment key={token.key}>{subtitleMaskText(token.text)}</React.Fragment>;
    return <span
      key={token.key}
      className={`${outsideVocabulary ? 'sl-transcript-word is-outside' : 'sl-transcript-word'} ${onWordClick ? 'is-clickable' : ''}`}
      {...(onWordClick ? {
        role: 'button',
        tabIndex: 0,
        title: t("查看 {0} 的释义并播放发音", token.text),
        onClick: (event: React.MouseEvent<HTMLSpanElement>) => {
          event.stopPropagation();
          if (!selectedTextIn(event.currentTarget.closest<HTMLElement>('.sl-transcript-list') || event.currentTarget)) onWordClick(token.lookupText!, event.currentTarget, currentWordIndex);
        },
        onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          onWordClick(token.lookupText!, event.currentTarget, currentWordIndex);
        },
      } : {})}
    >{token.text}</span>;
  })}</>;
}

export function TranscriptRowsView({ segments, displayMode = 'all', showEnglish = true, translations = [], currentIndex, emptyText, vocabularySize, masteredVocabulary, collapsed = false, onToggleCollapsed, onSeek, onSelect, onWordClick }: TranscriptRowsProps) {
  const list = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (!follow || collapsed) return;
    const container = list.current;
    const row = container?.querySelector<HTMLElement>('.current');
    if (container && row) container.scrollTo({ top: container.scrollTop + row.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientHeight / 3, behavior: 'smooth' });
  }, [collapsed, currentIndex, follow]);
  return <>
    <div className="sl-transcript-tools">
      <button className="sl-follow" aria-pressed={follow} onClick={() => setFollow(value => !value)}>{t("自动滚动")}{follow ? t("· 开") : t("· 关")}</button>
      {onToggleCollapsed && <button className="sl-transcript-toggle" aria-expanded={!collapsed} onClick={onToggleCollapsed}>{collapsed ? t("展开列表") : t("收起列表")}</button>}
    </div>
    <div ref={list} className="sl-transcript-list" hidden={collapsed}>
      {segments.length ? segments.map((segment, index) => <button key={segment.id} className={index === currentIndex ? 'current' : ''} onClick={event => { if (!selectedTextIn(event.currentTarget)) onSeek(index); }}>
        <time>{formatTime(segment.startMs)}</time>
        <span>
          {showEnglish && <span onMouseUp={(event) => {
            const text = selectedTextIn(event.currentTarget);
            // A selection crossing masked words is not a usable saved expression.
            if (text && !text.includes('█')) onSelect({ text, segment, index });
          }}><TranscriptText text={segment.text} displayMode={displayMode} vocabularySize={vocabularySize} masteredVocabulary={masteredVocabulary} {...(onWordClick ? { onWordClick: (term: string, element: HTMLElement, wordIndex: number) => onWordClick(term, element, wordIndex, segment, index) } : {})} /></span>}
          {translations[index] && <>{showEnglish && '\n'}<span>{translations[index]}</span></>}
          {!showEnglish && !translations[index] && t("字幕已隐藏")}
        </span>
      </button>) : <p>{emptyText}</p>}
    </div>
  </>;
}

export const TranscriptRows = memo(TranscriptRowsView);
