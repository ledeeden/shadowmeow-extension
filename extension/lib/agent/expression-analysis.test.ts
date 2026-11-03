import { describe, expect, it } from 'vitest';
import type { CaptionCue, ExpressionBundle, ExpressionReviewItem } from '@shadow-language/contracts';
import {
  extractJson,
  parseExpressionAnalysisJson,
  toExpressionBundleInput,
} from './expression-analysis';

describe('expression-analysis', () => {
  it('extracts JSON from fenced markdown response', () => {
    const raw = '```json\n{"expressions": [{"chunk": "take it for granted"}]}\n```';
    const parsed = extractJson(raw) as { expressions: Array<{ chunk: string }> };
    expect(parsed.expressions).toHaveLength(1);
    const first = parsed.expressions[0];
    expect(first?.chunk).toBe('take it for granted');
  });

  it('correctly matches existing knowledge and marks isExisting and status', () => {
    const cues: CaptionCue[] = [
      { seq: 0, startMs: 5000, endMs: 8000, text: 'We should not take this opportunity for granted.' },
      { seq: 1, startMs: 12000, endMs: 15000, text: 'How did you come up with that solution?' },
    ];

    const existingBundles: ExpressionBundle[] = [
      {
        id: 'bundle_123',
        dedupKey: 'video|test|take it for granted|...',
        chunk: 'take it for granted',
        pattern: 'take [something] for granted',
        sourceSentence: 'Do not take life for granted.',
        meaningZh: '认为……理所当然',
        intentZh: '表达忽视重要性',
        slots: ['something'],
        acceptedVariants: ['take it for granted'],
        source: { type: 'video', videoKey: 'v1', title: 'test', segmentSeq: 0, startMs: 1000, contextText: 'old' },
        provenance: { kind: 'user-confirmed', extractor: 'manual', version: 'v1' },
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];

    const existingItems: ExpressionReviewItem[] = [
      {
        id: 'review_123',
        kind: 'phrase',
        bundleId: 'bundle_123',
        promptZh: '认为……理所当然',
        answer: 'take it for granted',
        meaningZh: '认为……理所当然',
        intentZh: '表达忽视重要性',
        sourceSentence: 'Do not take life for granted.',
        pattern: 'take [something] for granted',
        slots: ['something'],
        acceptedVariants: ['take it for granted'],
        status: 'mastered',
        due: null,
        fsrs: { state: 2, due: 1000, stability: 10, difficulty: 2, reps: 4, lapses: 0, lastReview: 1000 },
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];

    const jsonText = JSON.stringify({
      expressions: [
        {
          chunk: 'take it for granted',
          pattern: 'take [something] for granted',
          meaningZh: '把……视作理所当然',
          intentZh: '表达忽视其珍贵程度',
          slots: ['this opportunity'],
          sourceSentence: 'We should not take this opportunity for granted.',
          startMs: 5000,
          isExisting: false, // AI might report false, but our reconciler will catch it!
        },
        {
          chunk: 'come up with',
          pattern: 'come up with + [solution / idea]',
          meaningZh: '想出，提出',
          intentZh: '描述想到解决办法',
          slots: ['solution'],
          sourceSentence: 'How did you come up with that solution?',
          startMs: 12000,
          isExisting: false,
        },
      ],
    });

    const parsed = parseExpressionAnalysisJson(jsonText, existingBundles, existingItems, cues);
    expect(parsed).toHaveLength(2);

    const item0 = parsed[0]!;
    const item1 = parsed[1]!;

    // First item should be matched as existing knowledge
    expect(item0.chunk).toBe('take it for granted');
    expect(item0.isExisting).toBe(true);
    expect(item0.existingBundleId).toBe('bundle_123');
    expect(item0.existingReviewStatus).toBe('mastered');
    expect(item0.startMs).toBe(5000);

    // Second item should be new knowledge
    expect(item1.chunk).toBe('come up with');
    expect(item1.isExisting).toBe(false);
    expect(item1.existingBundleId).toBeUndefined();
    expect(item1.startMs).toBe(12000);
  });

  it('converts ExtractedExpression to ExpressionBundleInput correctly', () => {
    const expr = {
      id: 'ext_1',
      chunk: 'make sense',
      pattern: 'make sense to [someone]',
      meaningZh: '有道理，行得通',
      intentZh: '确认理解或逻辑成立',
      slots: ['someone'],
      sourceSentence: 'That does not make sense at all.',
      startMs: 45000,
      isExisting: false,
    };

    const bundleInput = toExpressionBundleInput(expr, {
      youtubeId: 'abc12345678',
      platform: 'youtube',
      title: 'TED Talk',
      durationMs: 60000,
      playerState: 'paused',
      timeMs: 45000,
      playbackRate: 1,
      tracks: [],
      activeTrackId: 'en',
      cues: [],
      segments: [],
    });

    expect(bundleInput.chunk).toBe('make sense');
    expect(bundleInput.pattern).toBe('make sense to [someone]');
    expect(bundleInput.sourceSentence).toBe('That does not make sense at all.');
    expect(bundleInput.source.type).toBe('video');
    if (bundleInput.source.type === 'video') {
      expect(bundleInput.source.startMs).toBe(45000);
    }
    expect(bundleInput.source.title).toBe('TED Talk');
    expect(bundleInput.provenance.extractor).toBe('ai-suggested');
  });
});
