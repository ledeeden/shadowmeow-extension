import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptRows, TranscriptRowsView, TranscriptText } from './transcript-rows';
import { subtitleTextForDisplay } from '../lib/subtitle-display';
import type { NormalizedSegment } from '@shadow-language/contracts';

describe('transcript source and display separation', () => {
  const source: NormalizedSegment = {
    id: 's1', sourceCueIds: ['1'], startMs: 0, endMs: 2000,
    text: 'The cat met zyzzyva.', confidence: 1,
  };
  const masteredVocabulary = new Set<string>();

  it.each(['all', 'new-words', 'hidden'] as const)('keeps the %s display consistent with subtitle masking', displayMode => {
    const html = renderToStaticMarkup(React.createElement(TranscriptText, {
      text: source.text, displayMode, vocabularySize: 10000, masteredVocabulary,
    }));
    expect(html.replace(/<[^>]*>/g, '')).toBe(subtitleTextForDisplay(source.text, displayMode, 10000, masteredVocabulary));
  });

  it('keeps the source word index after masked words', () => {
    const onWordClick = vi.fn();
    const tree = TranscriptText({ text: source.text, displayMode: 'new-words', vocabularySize: 10000, masteredVocabulary, onWordClick });
    const word = React.Children.toArray(tree.props.children).find(child => React.isValidElement<{ children: string }>(child) && child.props.children === 'zyzzyva') as React.ReactElement<{ onKeyDown: (event: unknown) => void }>;
    const element = {};
    word.props.onKeyDown({ key: 'Enter', currentTarget: element, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onWordClick).toHaveBeenCalledWith('zyzzyva', element, 3);
  });

  it('passes the original sentence to saving even while its row is masked and bilingual', () => {
    const onWordClick = vi.fn();
    let tree: ReturnType<typeof TranscriptRowsView>;
    function Probe() {
      tree = TranscriptRowsView({ segments: [source], currentIndex: 0, emptyText: '', vocabularySize: 10000, masteredVocabulary,
        displayMode: 'new-words', translations: ['猫遇到了一只昆虫。'], onSeek: vi.fn(), onSelect: vi.fn(), onWordClick });
      return tree;
    }
    renderToStaticMarkup(React.createElement(Probe));
    const list = tree!.props.children[1];
    const row = list.props.children[0];
    const english = row.props.children[1].props.children[0];
    english.props.children.props.onWordClick('zyzzyva', {}, 3);
    expect(onWordClick.mock.calls[0]?.slice(2)).toEqual([3, source, 0]);
    expect(source.text).toBe('The cat met zyzzyva.');
  });

  it('renders translations separately when English is hidden', () => {
    const html = renderToStaticMarkup(React.createElement(TranscriptRows, {
      segments: [source], currentIndex: 0, emptyText: '', vocabularySize: 10000, masteredVocabulary,
      showEnglish: false, translations: ['中文翻译'], onSeek: vi.fn(), onSelect: vi.fn(), onWordClick: vi.fn(),
    }));
    expect(html).toContain('中文翻译');
    expect(html).not.toContain('zyzzyva');
    expect(html).not.toContain('is-clickable');
  });
});
