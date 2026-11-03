import { markDerivedReview } from './sync/local-store';
import type {
  ExpressionBundle,
  ExpressionBundleInput,
  ExpressionChallengeAttempt,
  ExpressionReviewItem,
  ExpressionReviewRating,
  ExpressionReviewState,
} from '@shadow-language/contracts';
import { db } from './db';
import {
  buildExpressionReviewItems,
  buildExpressionReviewState,
  createExpressionChallengeAttempt,
  expressionRatingToFsrs,
  migrateLegacyVocabularyCard,
  normalizeExpressionBundle,
  scheduleExpressionReviewItem,
} from './expression-review';
import { recordVocabularyReview } from './vocabulary';

export type SaveExpressionBundleResult = {
  bundle: ExpressionBundle;
  items: ExpressionReviewItem[];
  duplicate: boolean;
};

async function migrateLegacyVocabularyCards(): Promise<void> {
  await db.transaction('rw', [db.vocabulary, db.expressionReviewItems], async tx => {
    markDerivedReview(tx);
    const cards = await db.vocabulary.toArray();
    const ids = new Set(cards.map(card => card.id));
    const all = await db.expressionReviewItems.toArray();
    const orphanIds = all.filter(item => item.legacyVocabularyId && !ids.has(item.legacyVocabularyId)).map(item => item.id);
    if (orphanIds.length) await db.expressionReviewItems.bulkDelete(orphanIds);
    const existing = new Map(all.map(item => [item.id, item]));
    const changed = cards.map(migrateLegacyVocabularyCard).filter(item => !existing.has(item.id) || item.updatedAt > existing.get(item.id)!.updatedAt);
    if (changed.length) await db.expressionReviewItems.bulkPut(changed);
  });
}

function mergeBundle(existing: ExpressionBundle, incoming: ExpressionBundle): ExpressionBundle {
  return normalizeExpressionBundle({
    ...incoming,
    id: existing.id,
    chunk: incoming.chunk || existing.chunk,
    pattern: incoming.pattern || existing.pattern,
    sourceSentence: incoming.sourceSentence || existing.sourceSentence,
    meaningZh: incoming.meaningZh || existing.meaningZh,
    intentZh: incoming.intentZh || existing.intentZh,
    slots: [...existing.slots, ...incoming.slots],
    acceptedVariants: [...existing.acceptedVariants, ...incoming.acceptedVariants],
    source: incoming.source,
    provenance: incoming.provenance,
    createdAt: existing.createdAt,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  });
}

export async function saveExpressionBundle(input: ExpressionBundleInput): Promise<SaveExpressionBundleResult> {
  const normalized = normalizeExpressionBundle(input);
  return db.transaction('rw', [db.expressionBundles, db.expressionReviewItems], async () => {
    // Read and deduplicate inside the write transaction: two tabs cannot both insert.
    const existing = await db.expressionBundles.where('dedupKey').equals(normalized.dedupKey).first()
      || (await db.expressionBundles.toArray()).find(candidate => normalizeExpressionBundle(candidate).dedupKey === normalized.dedupKey);
    const bundle = existing ? mergeBundle(existing, normalized) : normalized;
    const proposedItems = buildExpressionReviewItems(bundle, bundle.updatedAt);
    const savedItems: ExpressionReviewItem[] = [];
    await db.expressionBundles.put(bundle);
    for (const proposed of proposedItems) {
      const current = await db.expressionReviewItems.get(proposed.id);
      const next: ExpressionReviewItem = current ? {
        ...current,
        promptZh: proposed.promptZh,
        answer: proposed.answer,
        meaningZh: proposed.meaningZh,
        intentZh: proposed.intentZh,
        sourceSentence: proposed.sourceSentence,
        pattern: proposed.pattern,
        slots: proposed.slots,
        acceptedVariants: proposed.acceptedVariants,
        ...(proposed.source ? { source: proposed.source } : {}),
        updatedAt: Math.max(current.updatedAt, bundle.updatedAt),
      } : proposed;
      await db.expressionReviewItems.put(next);
      savedItems.push(next);
    }
    return { bundle, items: savedItems, duplicate: Boolean(existing) };
  });
}

export async function getExpressionReviewState(now = Date.now()): Promise<ExpressionReviewState> {
  await migrateLegacyVocabularyCards();
  const [bundles, items] = await Promise.all([db.expressionBundles.toArray(), db.expressionReviewItems.toArray()]);
  return buildExpressionReviewState(bundles, items, now);
}

export async function recordExpressionReview(itemId: string, rating: ExpressionReviewRating, sessionId: string, responseMs?: number, now = Date.now()): Promise<ExpressionReviewItem> {
  if (!sessionId.trim() || !['forgot','slow','natural'].includes(rating)) throw new Error('复习会话或评价无效。');
  // One item can be scheduled only once within a formal review session.
  const logId = `expression_review_log_${JSON.stringify([sessionId, itemId])}`;
  return db.transaction('rw', [db.expressionReviewItems, db.expressionReviewLogs, db.vocabulary, db.vocabularyReviews], async tx => {
    markDerivedReview(tx);
    const item = await db.expressionReviewItems.get(itemId);
    if (!item) throw new Error('找不到要复习的表达。');
    if (await db.expressionReviewLogs.get(logId)) return item;
    let updated: ExpressionReviewItem;
    if (item.legacyVocabularyId) {
      const card = await db.vocabulary.get(item.legacyVocabularyId);
      if (!card) throw new Error('原单词卡已经不存在。');
      // recordVocabularyReview expects a lemma, NOT a "vocab_..." storage id.
      const legacy = await recordVocabularyReview(card.lemma, expressionRatingToFsrs(rating), now);
      if (!legacy) throw new Error('原单词卡已经不存在。');
      updated = migrateLegacyVocabularyCard(legacy);
    } else updated = scheduleExpressionReviewItem(item, rating, now);
    await db.expressionReviewItems.put(updated);
    await db.expressionReviewLogs.put({
      id: logId, itemId, sessionId, rating, fsrsRating: expressionRatingToFsrs(rating),
      dueBefore: item.due, dueAfter: updated.due,
      ...(responseMs !== undefined ? { responseMs: Math.max(0, responseMs) } : {}), timestamp: now,
    });
    return updated;
  });
}

export async function recordExpressionChallengeAttempt(input: Omit<ExpressionChallengeAttempt, 'id' | 'officialScheduleChanged' | 'timestamp'>, now = Date.now()): Promise<ExpressionChallengeAttempt> {
  const attempt = createExpressionChallengeAttempt(input, now);
  await db.expressionChallengeAttempts.put(attempt);
  return attempt;
}
