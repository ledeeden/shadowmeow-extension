import { describe, expect, it } from 'vitest';
import type { PageState } from '@shadow-language/contracts';
import { newWordsPageSignature } from './new-words-panel';

const makePage = (overrides: Partial<PageState> = {}): PageState => ({
  youtubeId: 'abcdefghijk',
  platform: 'youtube',
  title: 'Demo video',
  durationMs: 60_000,
  playerState: 'paused',
  timeMs: 0,
  playbackRate: 1,
  tracks: [],
  activeTrackId: 'en',
  cues: [{ seq: 0, startMs: 0, endMs: 1_000, text: 'Hello world.' }],
  segments: [],
  ...overrides,
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewWordCard, NewWordDetailPopover, NewWordsPanel, ExpressionCard } from './new-words-panel';

describe('new words page signature', () => {
  it('stays stable while only playback time changes', () => {
    expect(newWordsPageSignature(makePage())).toBe(newWordsPageSignature(makePage({ timeMs: 20_000 })));
  });

  it('changes when the video or loaded caption context changes', () => {
    const base = newWordsPageSignature(makePage());
    expect(newWordsPageSignature(makePage({ youtubeId: 'zyxwvutsrqp' }))).not.toBe(base);
    expect(newWordsPageSignature(makePage({ cues: [{ seq: 0, startMs: 0, endMs: 1_000, text: 'A different sentence.' }] }))).not.toBe(base);
  });
});

describe('NewWordCard compact rendering', () => {
  it('renders the lemma with only a single add button and no inline context sentence', () => {
    const html = renderToStaticMarkup(
      React.createElement(NewWordCard, {
        entry: {
          lemma: 'transcriber',
          translation: '记录员',
          status: 'found',
          learningStatus: 'unadded',
          cue: { text: 'Transcriber: Translate TED Reviewer', startMs: 0, endMs: 1000 },
        },
        onSelect: () => {},
        onSave: () => {},
      }),
    );
    expect(html).toContain('transcriber');
    expect(html).toContain('compact');
    // The original inline context sentence has moved out of the card into the popover.
    expect(html).not.toContain('Transcriber: Translate TED Reviewer');
    // No more status badges, context toggle, or ask-AI affordances.
    expect(html).not.toContain('未收录');
    expect(html).not.toContain('展开查看原句');
    expect(html).not.toContain('向 Agent');
    // The single add button is present and labelled as join-the-vocab.
    expect(html).toContain('加入词库');
  });

  it('renders a check icon for words already in the vocab library', () => {
    const html = renderToStaticMarkup(
      React.createElement(NewWordCard, {
        entry: {
          lemma: 'memorize',
          translation: '记住',
          status: 'found',
          learningStatus: 'learning',
          cue: { text: 'Try to memorize the pattern.', startMs: 0, endMs: 1000 },
        },
        onSelect: () => {},
      }),
    );
    expect(html).toContain('memorize');
    expect(html).toContain('is-saved');
    expect(html).not.toContain('加入词库');
  });
});

describe('NewWordDetailPopover', () => {
  it('shows lemma, translation, context sentence, and the single add action', () => {
    const html = renderToStaticMarkup(
      React.createElement(NewWordDetailPopover, {
        entry: {
          lemma: 'classroom',
          translation: '教室',
          status: 'found',
          learningStatus: 'unadded',
          cue: { text: 'We walked into the classroom together.', startMs: 12_000, endMs: 14_000 },
        },
        onClose: () => {},
        onSave: async () => {},
      }),
    );
    expect(html).toContain('classroom');
    expect(html).toContain('教室');
    expect(html).toContain('We walked into the classroom together.');
    expect(html).toContain('0:12');
    expect(html).toContain('加入词库');
    expect(html).not.toContain('向 Agent');
  });
});

it('keeps the Web corpus sidebar on word saving and FSRS without expression actions', () => {
  const html = renderToStaticMarkup(React.createElement(NewWordsPanel, {
    showExpressions: false,
    state: {
      entries: [], loading: false, error: '', dueCount: 0, unaddedCount: 0,
      refresh: () => {}, saveWord: async () => {}, saveAllWords: async () => {},
    },
  }));
  expect(html).toContain('词库复习');
  expect(html).not.toContain('AI 提炼表达');
  expect(html).not.toContain('表达复习');
  // Context toggle was removed; details live in the popover.
  expect(html).not.toContain('显示原句');
  expect(html).not.toContain('隐藏原句');
});

describe('ExpressionCard rendering', () => {
  it('renders new knowledge expression card with intent, slots, and actions', () => {
    const html = renderToStaticMarkup(
      React.createElement(ExpressionCard, {
        expr: {
          id: 'exp_1',
          chunk: 'come up with',
          pattern: 'come up with + [idea]',
          meaningZh: '想出，提出',
          intentZh: '描述产生新想法',
          slots: ['idea'],
          sourceSentence: 'How did you come up with that?',
          startMs: 14000,
          isExisting: false,
        },
      }),
    );
    expect(html).toContain('come up with');
    expect(html).toContain('come up with + [idea]');
    expect(html).toContain('想出，提出');
    expect(html).toContain('描述产生新想法');
    expect(html).toContain('新知识 · 推荐');
    expect(html).toContain('is-new');
  });

  it('renders existing knowledge expression card with existing badge and consolidated tag', () => {
    const html = renderToStaticMarkup(
      React.createElement(ExpressionCard, {
        expr: {
          id: 'exp_2',
          chunk: 'take it for granted',
          pattern: 'take [something] for granted',
          meaningZh: '理所当然',
          intentZh: '表达忽视',
          slots: ['something'],
          sourceSentence: 'Do not take life for granted.',
          startMs: 5000,
          isExisting: true,
          existingReviewStatus: 'mastered',
        },
      }),
    );
    expect(html).toContain('take it for granted');
    expect(html).toContain('🌟 旧知识 · 已掌握');
    expect(html).toContain('is-existing');
    expect(html).toContain('已在表达库（已巩固）');
  });
});

