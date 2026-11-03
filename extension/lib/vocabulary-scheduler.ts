import type { VocabularyCard, VocabularyGoal, VocabularyPlan, VocabularyReviewLog } from '@shadow-language/contracts';

function rankOf(card: VocabularyCard): number {
  return Number.isFinite(card.rank) ? card.rank as number : 99_999;
}

function repsOf(card: VocabularyCard): number {
  return Number(card.fsrs?.reps) || 0;
}

export function isVocabularyExempt(card: VocabularyCard): boolean {
  return Boolean(card.reviewExempt || card.assessmentExemptBatch);
}

export function isVocabularyReviewCard(card: VocabularyCard): boolean {
  if (isVocabularyExempt(card)) return false;
  const reps = repsOf(card);
  return card.status === 'learning' || (['unfamiliar', 'known'].includes(card.status) && reps > 0);
}

/** Older clients cleared `due` on mastered cards. The retained FSRS item is
 * authoritative for these learned cards; manual, never-studied known words
 * remain exempt without fabricating a review history. */
export function vocabularyReviewDue(card: VocabularyCard): number | null {
  if (card.due !== null && Number.isFinite(card.due)) return card.due;
  return card.status === 'known' && repsOf(card) > 0 && Number.isFinite(card.fsrs?.due) ? card.fsrs.due : null;
}

export function isVocabularyNewCard(card: VocabularyCard): boolean {
  return !isVocabularyExempt(card) && card.status === 'unfamiliar' && repsOf(card) === 0;
}

export function buildVocabularyPlan(
  cards: VocabularyCard[],
  logs: VocabularyReviewLog[],
  goal: VocabularyGoal | null,
  now = Date.now(),
): VocabularyPlan {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const dueCards = cards
    .filter((card) => isVocabularyReviewCard(card) && vocabularyReviewDue(card) !== null && vocabularyReviewDue(card)! <= timestamp)
    .sort((left, right) => vocabularyReviewDue(left)! - vocabularyReviewDue(right)!);
  const newWords = cards
    .filter(isVocabularyNewCard)
    .sort((left, right) => rankOf(left) - rankOf(right) || left.word.localeCompare(right.word));

  const knownCount = cards.filter((card) => card.status === 'known').length;
  const unfamiliarCount = cards.filter((card) => card.status === 'unfamiliar').length;
  const learningCount = cards.filter((card) => card.status === 'learning').length;
  const hasGoal = Boolean(goal && goal.targetVocab > 0);
  const targetVocab = hasGoal ? Number(goal?.targetVocab) : 0;
  const targetDays = hasGoal ? Math.max(1, Number(goal?.targetDays) || 60) : 0;
  const startDate = hasGoal && Number.isFinite(goal?.startDate) ? Number(goal?.startDate) : timestamp;
  const elapsedDays = hasGoal ? Math.max(0, Math.floor((timestamp - startDate) / 86_400_000)) : 0;
  const daysRemaining = hasGoal ? Math.max(0, targetDays - elapsedDays) : 0;
  const goalGap = hasGoal ? Math.max(0, targetVocab - knownCount) : 0;
  const planningDays = Math.max(1, daysRemaining);
  const goalDailyNewTarget = goalGap > 0 ? Math.ceil(goalGap / planningDays) : 0;
  const dailyNewTarget = hasGoal
    ? (goalGap > 0 ? goalDailyNewTarget : Math.min(25, newWords.length))
    : 25;
  const dayStart = new Date(timestamp);
  dayStart.setHours(0, 0, 0, 0);
  const newStartedToday = new Set(
    logs
      .filter((log) => log.isNew && log.timestamp >= dayStart.getTime())
      .map((log) => log.word)
      .filter(Boolean),
  ).size;
  const dailyNewRemaining = Math.max(0, dailyNewTarget - newStartedToday);
  const todayNewCount = Math.min(newWords.length, dailyNewRemaining);

  return {
    goal,
    hasGoal,
    targetVocab,
    targetDays,
    startDate,
    elapsedDays,
    daysRemaining,
    goalGap,
    knownCount,
    unfamiliarCount,
    learningCount,
    dueCount: dueCards.length,
    dueCards,
    newWords,
    newPoolCount: newWords.length,
    dailyNewTarget,
    newStartedToday,
    dailyNewRemaining,
    todayNewCount,
    totalTodayCount: dueCards.length + todayNewCount,
  };
}

export function buildVocabularyQueue(plan: VocabularyPlan): VocabularyCard[] {
  const queue = [...plan.dueCards, ...plan.newWords.slice(0, plan.dailyNewRemaining)];
  const seen = new Set<string>();
  return queue.filter((card) => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });
}
