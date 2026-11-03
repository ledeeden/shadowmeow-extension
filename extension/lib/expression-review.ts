import { randomId } from '@shadow-language/contracts';
import type {
  ExpressionBundle,
  ExpressionBundleInput,
  ExpressionChallengeAnchor,
  ExpressionChallengeAttempt,
  ExpressionChallengeCategory,
  ExpressionChallengeFeedback,
  ExpressionChallengeScene,
  ExpressionReviewItem,
  ExpressionReviewRating,
  ExpressionReviewSessionItem,
  ExpressionReviewState,
  VocabularyCard,
  VocabularyRating,
} from '@shadow-language/contracts';
import { FSRSEngine } from './fsrs';

const fsrs = new FSRSEngine();
const PRIMARY_KIND_ORDER: Record<ExpressionReviewItem['kind'], number> = { phrase: 0, pattern: 1, sentence: 2, word: 3 };

export function normalizeExpressionText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201B\u02BC\u0060\u00B4]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function comparable(value: string): string {
  return normalizeExpressionText(value)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueText(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeExpressionText(value);
    const key = comparable(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function expressionBundleDedupKey(input: Pick<ExpressionBundleInput, 'chunk' | 'sourceSentence' | 'source'>): string {
  const sourceKey = input.source.type === 'video'
    ? `${input.source.videoKey}:${input.source.segmentSeq}:${Math.round(input.source.startMs / 100)}`
    : `${input.source.title}:${input.source.location}`;
  return [input.source.type, sourceKey, comparable(input.chunk), comparable(input.sourceSentence)].join('|');
}

export function normalizeExpressionBundle(input: ExpressionBundleInput): ExpressionBundle {
  const now = Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now();
  const chunk = normalizeExpressionText(input.chunk).slice(0, 500);
  const pattern = normalizeExpressionText(input.pattern).slice(0, 500);
  const sourceSentence = normalizeExpressionText(input.sourceSentence).slice(0, 2_000);
  if (!chunk && !pattern) throw new Error('至少确认一个可复用语块或句型。');
  if (!sourceSentence) throw new Error('表达包必须保留来源整句。');
  const source = input.source.type === 'video'
    ? { ...input.source, title: normalizeExpressionText(input.source.title), contextText: normalizeExpressionText(input.source.contextText).slice(0, 2_000), startMs: Math.max(0, Math.round(input.source.startMs)), segmentSeq: Math.max(0, Math.round(input.source.segmentSeq)) }
    : { ...input.source, title: normalizeExpressionText(input.source.title), location: normalizeExpressionText(input.source.location), contextText: normalizeExpressionText(input.source.contextText).slice(0, 2_000) };
  const normalized: ExpressionBundleInput = {
    ...input,
    id: input.id || `expression_${randomId()}`,
    chunk,
    pattern,
    sourceSentence,
    meaningZh: normalizeExpressionText(input.meaningZh).slice(0, 1_000),
    intentZh: normalizeExpressionText(input.intentZh).slice(0, 1_000),
    slots: uniqueText(input.slots).slice(0, 16),
    acceptedVariants: uniqueText([chunk, pattern, ...input.acceptedVariants]).slice(0, 24),
    source,
    provenance: {
      kind: 'user-confirmed',
      extractor: input.provenance.extractor,
      version: normalizeExpressionText(input.provenance.version) || 'expression-bundle-v1',
    },
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    updatedAt: now,
  };
  return { ...normalized, dedupKey: expressionBundleDedupKey(normalized) };
}

function newReviewItem(bundle: ExpressionBundle, kind: ExpressionReviewItem['kind'], answer: string, now: number): ExpressionReviewItem {
  const normalizedAnswer = normalizeExpressionText(answer);
  const suffix = kind === 'phrase' ? 'chunk' : kind;
  const promptZh = bundle.intentZh || bundle.meaningZh || (kind === 'sentence' ? '回想原场景中的完整表达。' : '根据原场景主动说出这个表达。');
  return {
    id: `expression_review_${bundle.id}_${suffix}`,
    kind,
    bundleId: bundle.id,
    promptZh,
    answer: normalizedAnswer,
    meaningZh: bundle.meaningZh,
    intentZh: bundle.intentZh,
    sourceSentence: bundle.sourceSentence,
    pattern: bundle.pattern,
    slots: [...bundle.slots],
    acceptedVariants: uniqueText([normalizedAnswer, ...bundle.acceptedVariants]),
    source: bundle.source,
    status: 'new',
    due: now,
    fsrs: fsrs.createItem(now),
    createdAt: now,
    updatedAt: now,
  };
}

export function buildExpressionReviewItems(bundle: ExpressionBundle, now = bundle.updatedAt): ExpressionReviewItem[] {
  const items: ExpressionReviewItem[] = [];
  if (bundle.chunk) items.push(newReviewItem(bundle, 'phrase', bundle.chunk, now));
  if (bundle.pattern && comparable(bundle.pattern) !== comparable(bundle.chunk)) items.push(newReviewItem(bundle, 'pattern', bundle.pattern, now));
  items.push(newReviewItem(bundle, 'sentence', bundle.sourceSentence, now));
  return items;
}

export function migrateLegacyVocabularyCard(card: VocabularyCard): ExpressionReviewItem {
  return {
    id: `expression_review_legacy_${card.id}`,
    kind: 'word',
    legacyVocabularyId: card.id,
    promptZh: card.translation || '回想这个单词的常见含义与用法。',
    answer: normalizeExpressionText(card.word),
    meaningZh: card.translation,
    intentZh: '',
    sourceSentence: card.contextText || '',
    pattern: '',
    slots: [],
    acceptedVariants: uniqueText([card.word, card.lemma]),
    status: card.status === 'known' ? 'mastered' : card.fsrs.reps > 0 ? 'learning' : 'new',
    due: card.due,
    fsrs: { ...card.fsrs },
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

export function expressionRatingToFsrs(rating: ExpressionReviewRating): VocabularyRating {
  if (rating === 'forgot') return 1;
  if (rating === 'slow') return 3;
  return 4;
}

export function scheduleExpressionReviewItem(item: ExpressionReviewItem, rating: ExpressionReviewRating, now = Date.now()): ExpressionReviewItem {
  const nextFsrs = fsrs.schedule(item.fsrs, expressionRatingToFsrs(rating), now);
  return {
    ...item,
    fsrs: nextFsrs,
    due: nextFsrs.due,
    status: fsrs.isMastered(nextFsrs) ? 'mastered' : 'learning',
    updatedAt: now,
  };
}

export function buildExpressionReviewState(bundles: ExpressionBundle[], items: ExpressionReviewItem[], now = Date.now()): ExpressionReviewState {
  const dueItems = items
    .filter((item) => item.status !== 'mastered' && item.due !== null && item.due <= now)
    .sort((left, right) => PRIMARY_KIND_ORDER[left.kind] - PRIMARY_KIND_ORDER[right.kind] || (left.due || 0) - (right.due || 0) || left.createdAt - right.createdAt);
  return {
    bundles: [...bundles].sort((left, right) => right.updatedAt - left.updatedAt),
    items: [...items],
    dueItems,
    dueCount: dueItems.filter((item) => item.fsrs.reps > 0).length,
    newCount: dueItems.filter((item) => item.fsrs.reps === 0).length,
    estimateMinutes: dueItems.length ? Math.max(1, Math.ceil(dueItems.length * 42 / 60)) : 0,
  };
}

export function expressionChallengeAnchor(item: ExpressionReviewItem): ExpressionChallengeAnchor {
  return {
    itemId: item.id,
    ...(item.bundleId ? { bundleId: item.bundleId } : {}),
    targetIntentZh: item.intentZh || item.meaningZh || item.promptZh,
    requiredChunk: item.kind === 'sentence' ? item.sourceSentence : item.answer,
    optionalPattern: item.pattern,
    acceptedVariants: uniqueText(item.acceptedVariants),
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 返回内容不是有效 JSON。');
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function parseExpressionChallengeScene(text: string, anchor: ExpressionChallengeAnchor): ExpressionChallengeScene {
  const raw = extractJson(text) as Record<string, unknown>;
  const scenarioZh = normalizeExpressionText(String(raw.scenarioZh || ''));
  const dialogueContext = normalizeExpressionText(String(raw.dialogueContext || ''));
  const promptZh = normalizeExpressionText(String(raw.promptZh || ''));
  const difficulty = raw.difficulty;
  if (!scenarioZh || !dialogueContext || !promptZh || !['easy', 'standard', 'stretch'].includes(String(difficulty))) {
    throw new Error('AI 场景缺少必要字段。');
  }
  return {
    id: `expression_challenge_${randomId()}`,
    targetItemId: anchor.itemId,
    targetAssetIds: [anchor.bundleId, anchor.itemId].filter((value): value is string => Boolean(value)),
    scenarioZh,
    dialogueContext,
    promptZh,
    difficulty: difficulty as ExpressionChallengeScene['difficulty'],
    source: 'ai',
  };
}

export function templateExpressionChallengeScene(anchor: ExpressionChallengeAnchor): ExpressionChallengeScene {
  return {
    id: `expression_challenge_${randomId()}`,
    targetItemId: anchor.itemId,
    targetAssetIds: [anchor.bundleId, anchor.itemId].filter((value): value is string => Boolean(value)),
    scenarioZh: `迁移练习：${anchor.targetIntentZh || '在新场景中调用今天复习的表达'}`,
    dialogueContext: '对方正在等你回应。请不要照抄原句，而是在这个新情境里自然表达。',
    promptZh: '请用英文写出你会说的话。',
    difficulty: 'standard',
    source: 'template',
  };
}

function containsVariant(answer: string, variant: string): boolean {
  const normalizedAnswer = comparable(answer);
  const normalizedVariant = comparable(variant).replace(/\b(someone|something|somebody|verb|noun)\b/g, '').replace(/\s+/g, ' ').trim();
  return Boolean(normalizedVariant && normalizedAnswer.includes(normalizedVariant));
}

export function deterministicExpressionChallengeMatch(answer: string, anchor: ExpressionChallengeAnchor): ExpressionChallengeFeedback | null {
  const normalized = comparable(answer);
  if (!normalized) return { category: 'no_usable_expression', explanationZh: '还没有可判断的英文回答。', source: 'deterministic' };
  const variants = uniqueText([anchor.requiredChunk, ...anchor.acceptedVariants]);
  const matched = variants.find((variant) => containsVariant(answer, variant));
  if (matched) return { category: 'target_used_naturally', explanationZh: '检测到今天复习的目标表达；仍可由 AI 进一步判断在新场景中是否自然。', matchedVariant: matched, source: 'deterministic', ambiguous: true };
  const targetTokens = new Set(comparable(anchor.requiredChunk).split(' ').filter((token) => token.length > 2));
  const answerTokens = new Set(normalized.split(' '));
  const overlap = [...targetTokens].filter((token) => answerTokens.has(token)).length;
  if (targetTokens.size && overlap / targetTokens.size >= 0.5) {
    return { category: 'target_form_error', explanationZh: '看起来尝试了目标表达，但形式或搭配没有完整匹配。', source: 'deterministic', ambiguous: true };
  }
  return null;
}

const CHALLENGE_CATEGORIES = new Set<ExpressionChallengeCategory>(['target_used_naturally', 'valid_alternative', 'target_form_error', 'no_usable_expression']);

export function parseExpressionChallengeFeedback(text: string): ExpressionChallengeFeedback {
  const raw = extractJson(text) as Record<string, unknown>;
  const category = String(raw.category || '') as ExpressionChallengeCategory;
  const explanationZh = normalizeExpressionText(String(raw.explanationZh || ''));
  if (!CHALLENGE_CATEGORIES.has(category) || !explanationZh) throw new Error('AI 反馈分类格式不正确。');
  const matchedVariant = normalizeExpressionText(String(raw.matchedVariant || ''));
  const correction = normalizeExpressionText(String(raw.correction || ''));
  return {
    category,
    explanationZh,
    ...(matchedVariant ? { matchedVariant } : {}),
    ...(correction ? { correction } : {}),
    source: 'ai',
    ambiguous: Boolean(raw.ambiguous),
  };
}

export function selectNextExpressionChallengeItem(reviewed: ExpressionReviewSessionItem[], attempts: ExpressionChallengeAttempt[]): ExpressionReviewItem | null {
  if (!reviewed.length) return null;
  const challengedIds = new Set(attempts.map((attempt) => attempt.itemId));
  const unchallenged = reviewed.find((entry) => !challengedIds.has(entry.item.id));
  if (unchallenged) return unchallenged.item;
  const stats = new Map<string, { weak: number; slow: number; total: number }>();
  for (const attempt of attempts) {
    const current = stats.get(attempt.itemId) || { weak: 0, slow: 0, total: 0 };
    current.total += 1;
    if (attempt.category === 'target_form_error' || attempt.category === 'no_usable_expression') current.weak += 1;
    if ((attempt.responseMs || 0) >= 20_000) current.slow += 1;
    stats.set(attempt.itemId, current);
  }
  return [...reviewed]
    .sort((left, right) => {
      const a = stats.get(left.item.id) || { weak: 0, slow: 0, total: 0 };
      const b = stats.get(right.item.id) || { weak: 0, slow: 0, total: 0 };
      return b.weak - a.weak || b.slow - a.slow || a.total - b.total || left.reviewedAt - right.reviewedAt;
    })[0]?.item || null;
}

export function expressionChallengeCoverage(reviewed: ExpressionReviewSessionItem[], attempts: ExpressionChallengeAttempt[]): { covered: number; total: number } {
  const eligible = new Set(reviewed.map((entry) => entry.item.id));
  const covered = new Set(attempts.filter((attempt) => eligible.has(attempt.itemId)).map((attempt) => attempt.itemId));
  return { covered: covered.size, total: eligible.size };
}

export function createExpressionChallengeAttempt(input: Omit<ExpressionChallengeAttempt, 'id' | 'officialScheduleChanged' | 'timestamp'>, now = Date.now()): ExpressionChallengeAttempt {
  return { ...input, id: `expression_attempt_${randomId()}`, officialScheduleChanged: false, timestamp: now };
}
