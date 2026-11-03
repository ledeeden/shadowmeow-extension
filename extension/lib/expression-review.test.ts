import { describe, expect, it } from 'vitest';
import type {
  ExpressionBundleInput,
  ExpressionChallengeAttempt,
  ExpressionReviewItem,
  ExpressionReviewSessionItem,
  VocabularyCard,
} from '@shadow-language/contracts';
import {
  buildExpressionReviewItems,
  createExpressionChallengeAttempt,
  deterministicExpressionChallengeMatch,
  expressionBundleDedupKey,
  expressionChallengeCoverage,
  expressionRatingToFsrs,
  migrateLegacyVocabularyCard,
  normalizeExpressionBundle,
  parseExpressionChallengeFeedback,
  parseExpressionChallengeScene,
  scheduleExpressionReviewItem,
  selectNextExpressionChallengeItem,
} from './expression-review';

const NOW = Date.UTC(2026, 8, 17, 8);

function bundleInput(overrides: Partial<ExpressionBundleInput> = {}): ExpressionBundleInput {
  return {
    id: 'bundle-1',
    chunk: '  I\u2019m looking forward to it. ',
    pattern: "I'm looking forward to + something",
    sourceSentence: "I'm really looking forward to seeing you again.",
    meaningZh: '我很期待',
    intentZh: '表达对未来事件的期待',
    slots: ['something', ' something ', 'doing something'],
    acceptedVariants: ["I'm looking forward to it", "I\u2019m looking forward to it"],
    source: {
      type: 'video',
      videoKey: 'youtube:abc',
      title: ' Demo ',
      segmentSeq: 12,
      startMs: 12_345,
      contextText: '  Previous context.  ',
    },
    provenance: { kind: 'user-confirmed', extractor: 'manual', version: 'v1' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function reviewItem(id: string, kind: ExpressionReviewItem['kind'] = 'phrase'): ExpressionReviewItem {
  const bundle = normalizeExpressionBundle(bundleInput({ id: `bundle-${id}`, chunk: id }));
  return { ...buildExpressionReviewItems(bundle, NOW).find((item) => item.kind === kind)!, id };
}

describe('expression bundle normalization', () => {
  it('normalizes smart quotes and whitespace before deriving a stable source-aware key', () => {
    const normalized = normalizeExpressionBundle(bundleInput());
    expect(normalized.chunk).toBe("I'm looking forward to it.");
    expect(normalized.slots).toEqual(['something', 'doing something']);
    expect(normalized.acceptedVariants).toEqual([
      "I'm looking forward to it.",
      "I'm looking forward to + something",
    ]);
    expect(normalized.source).toMatchObject({ title: 'Demo', startMs: 12_345, contextText: 'Previous context.' });

    const equivalent = bundleInput({
      chunk: "I'm   looking forward to it.",
      pattern: "look forward to + noun or gerund",
      sourceSentence: "I’m really looking forward to seeing you again.",
    });
    expect(expressionBundleDedupKey(equivalent)).toBe(normalized.dedupKey);
  });

  it('creates phrase, pattern and full-sentence review items without duplicating an identical pattern', () => {
    const bundle = normalizeExpressionBundle(bundleInput());
    expect(buildExpressionReviewItems(bundle, NOW).map((item) => item.kind)).toEqual(['phrase', 'pattern', 'sentence']);

    const samePattern = normalizeExpressionBundle(bundleInput({ pattern: "I'M LOOKING FORWARD TO IT." }));
    expect(buildExpressionReviewItems(samePattern, NOW).map((item) => item.kind)).toEqual(['phrase', 'sentence']);
  });
});

describe('expression review scheduling', () => {
  it('migrates a legacy word without changing its scheduling fields or mutating the card', () => {
    const card: VocabularyCard = {
      id: 'legacy-word',
      word: 'commitment',
      lemma: 'commitment',
      rank: 1_200,
      phonetic: '',
      translation: '承诺',
      status: 'learning',
      source: 'subtitle',
      contextText: 'That takes real commitment.',
      createdAt: NOW - 10_000,
      updatedAt: NOW - 5_000,
      due: NOW + 86_400_000,
      fsrs: { state: 2, difficulty: 4, stability: 5, reps: 2, lapses: 0, lastReview: NOW - 86_400_000, due: NOW + 86_400_000 },
    };
    const snapshot = structuredClone(card);
    const migrated = migrateLegacyVocabularyCard(card);
    expect(migrated).toMatchObject({ kind: 'word', legacyVocabularyId: card.id, due: card.due, fsrs: card.fsrs, updatedAt: card.updatedAt });
    expect(card).toEqual(snapshot);
  });

  it('maps three user outcomes to FSRS and only the scheduled-review path changes due', () => {
    expect(expressionRatingToFsrs('forgot')).toBe(1);
    expect(expressionRatingToFsrs('slow')).toBe(3);
    expect(expressionRatingToFsrs('natural')).toBe(4);

    const item = reviewItem('target');
    const scheduled = scheduleExpressionReviewItem(item, 'slow', NOW);
    expect(scheduled.due).toBeGreaterThan(NOW);
    expect(item.due).toBe(NOW);

    const attempt = createExpressionChallengeAttempt({
      sessionId: 'session-1',
      itemId: item.id,
      sceneId: 'scene-1',
      answer: 'A fresh answer.',
      category: 'valid_alternative',
    }, NOW + 1_000);
    expect(attempt.officialScheduleChanged).toBe(false);
    expect(item.due).toBe(NOW);
  });
});

describe('expression transfer challenge', () => {
  it('parses constrained AI scenes and feedback', () => {
    const item = reviewItem('target');
    const anchor = {
      itemId: item.id,
      targetIntentZh: item.intentZh,
      requiredChunk: item.answer,
      optionalPattern: item.pattern,
      acceptedVariants: item.acceptedVariants,
    };
    expect(parseExpressionChallengeScene('```json\n{"scenarioZh":"朋友邀请你旅行","dialogueContext":"A: Are you coming?","promptZh":"回应对方","difficulty":"standard"}\n```', anchor)).toMatchObject({ source: 'ai', difficulty: 'standard' });
    expect(parseExpressionChallengeFeedback('{"category":"valid_alternative","explanationZh":"表达自然，但没有使用目标语块。"}')).toMatchObject({ category: 'valid_alternative', source: 'ai' });
  });

  it('uses deterministic matching only for exact/partial evidence and leaves alternatives to AI', () => {
    const item = reviewItem('look forward');
    const anchor = {
      itemId: item.id,
      targetIntentZh: '表达期待',
      requiredChunk: 'look forward to',
      optionalPattern: 'look forward to + noun',
      acceptedVariants: ['looking forward to'],
    };
    expect(deterministicExpressionChallengeMatch("I'm looking forward to Friday.", anchor)?.category).toBe('target_used_naturally');
    expect(deterministicExpressionChallengeMatch('I look forward Friday.', anchor)?.category).toBe('target_form_error');
    expect(deterministicExpressionChallengeMatch('Friday sounds wonderful.', anchor)).toBeNull();
    expect(deterministicExpressionChallengeMatch('   ', anchor)?.category).toBe('no_usable_expression');
  });

  it('covers every reviewed item before prioritizing weak or slow items', () => {
    const one = reviewItem('one');
    const two = reviewItem('two');
    const reviewed: ExpressionReviewSessionItem[] = [
      { item: one, reviewedAt: NOW, rating: 'natural' },
      { item: two, reviewedAt: NOW + 1, rating: 'slow' },
    ];
    const attempts: ExpressionChallengeAttempt[] = [
      createExpressionChallengeAttempt({ sessionId: 's', itemId: one.id, sceneId: 'a', answer: 'x', category: 'no_usable_expression' }, NOW + 2),
    ];
    expect(selectNextExpressionChallengeItem(reviewed, attempts)?.id).toBe(two.id);
    attempts.push(createExpressionChallengeAttempt({ sessionId: 's', itemId: two.id, sceneId: 'b', answer: 'x', category: 'target_used_naturally', responseMs: 30_000 }, NOW + 3));
    expect(expressionChallengeCoverage(reviewed, attempts)).toEqual({ covered: 2, total: 2 });
    expect(selectNextExpressionChallengeItem(reviewed, attempts)?.id).toBe(one.id);
  });
});
