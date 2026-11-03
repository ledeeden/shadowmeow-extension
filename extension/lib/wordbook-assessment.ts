import type { VocabularyCard, VocabularyGoal } from '@shadow-language/contracts';
import { db } from './db';
import { SUBTLEX_10000_WORDS } from './reader-frequency';
import { atlasKey } from './word-atlas';
import { findWordbookCard, indexVocabularyCards, wordbookCard, wordbookKeys, type Wordbook, type WordbookId } from './wordbook-plan';
import { isVocabularyExempt } from './vocabulary-scheduler';

const VERSION = 'subtlex-1pl-heuristic-v1';
const ranks = new Map<string, number>(SUBTLEX_10000_WORDS.map((word, index) => [atlasKey(word), index + 1]));
export type WordbookAssessment = { key: string; estimate: number; low: number; high: number; completedAt: number; known: Set<string>; unknown: Set<string> };
export type AssessmentBatch = NonNullable<VocabularyGoal['wordbookAssessmentBatches']>[string];

/** Product starting-point guidance, not a conversion to a certified exam score. */
export function recommendedWordbook(size: number): WordbookId {
  // Cumulative rebuilt membership counts; a starting-book heuristic, not CEFR certification.
  return size < 1064 ? 'cefrj-a1' : size < 2415 ? 'cefrj-a2' : size < 4768 ? 'cefrj-b1' : size < 7460 ? 'cefrj-b2' : 'study-abroad';
}

/** Read only a completed, applied assessment, never the settings default of 3000. */
export function readWordbookAssessment(value: unknown): WordbookAssessment | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as { startingPoint?: { version?: string; low?: number; high?: number; suggestedSize?: number; completedAt?: number }; assessment?: { version?: string; current?: unknown; responses?: Array<{ word: string; rank: number | null; pseudo: boolean; known: boolean }> } };
  const point = state.startingPoint, test = state.assessment;
  if (!point || point.version !== VERSION || !test || test.version !== VERSION || test.current !== null || !Array.isArray(test.responses) || test.responses.length > 20) return null;
  const { low, high, suggestedSize: estimate, completedAt } = point;
  if (![low, high, estimate, completedAt].every(number => typeof number === 'number' && Number.isFinite(number)) || low! < 0 || high! > 10000 || low! > estimate! || estimate! > high! || completedAt! <= 0) return null;
  const real = test.responses.filter(response => response && response.pseudo === false);
  if (real.length < 14 || real.some(response => typeof response.known !== 'boolean' || !Number.isInteger(response.rank) || response.rank! < 1 || SUBTLEX_10000_WORDS[response.rank! - 1] !== response.word)) return null;
  return { key: `${VERSION}:${completedAt}:${estimate}:${low}:${high}`, estimate: estimate!, low: low!, high: high!, completedAt: completedAt!,
    known: new Set(real.filter(response => response.known).flatMap(response => wordbookKeys({ word: response.word }))),
    unknown: new Set(real.filter(response => !response.known).flatMap(response => wordbookKeys({ word: response.word }))) };
}

export async function getWordbookAssessment(): Promise<WordbookAssessment | null> {
  return readWordbookAssessment((await db.onboarding.get('primary'))?.value);
}

export function assessmentCandidates(book: Wordbook, cards: VocabularyCard[], assessment: WordbookAssessment): VocabularyCard[] {
  const index = indexVocabularyCards(cards), candidates = new Map<string, VocabularyCard>(), excluded = new Set<string>();
  for (const member of book.words) {
    const keys = wordbookKeys(member);
    const existing = findWordbookCard(member, index);
    const card = existing || wordbookCard(member, book, 0);
    if (keys.some(key => assessment.unknown.has(key))) { excluded.add(card.id); continue; }
    if (existing && (isVocabularyExempt(existing) || existing.reviewExempt === false || existing.fsrs.reps > 0 || !['unfamiliar', 'unseen'].includes(existing.status))) continue;
    if (keys.some(key => assessment.known.has(key) || (ranks.get(key) || Infinity) <= assessment.low)) candidates.set(card.id, card);
  }
  return [...candidates.values()].filter(card => !excluded.has(card.id));
}

function clearCheckpoint(databaseName: string, book: Wordbook) {
  try { sessionStorage.removeItem(`shadow-atlas-study:v1:${databaseName}:${book.id}:${book.version}`); } catch { /* Optional browser checkpoint. */ }
}

export async function applyWordbookAssessment(book: Wordbook, assessmentKey: string, now = Date.now()): Promise<AssessmentBatch> {
  const database = db;
  const batch = await database.transaction('rw', [database.onboarding, database.vocabulary, database.studyMeta], async () => {
    const profile = readWordbookAssessment((await database.onboarding.get('primary'))?.value);
    if (!profile || profile.key !== assessmentKey) throw new Error('测评结果已变化，请重新读取后再操作。');
    const goal = await database.studyMeta.get('goal');
    const previous = goal?.wordbookAssessmentBatches?.[book.id];
    if (previous && !previous.undoneAt) throw new Error('这本词本已有测评免学，可先撤销后重新应用。');
    const candidates = assessmentCandidates(book, await database.vocabulary.toArray(), profile);
    if (!candidates.length) throw new Error('本书没有可按本次测评免学的新词。');
    const receipt: AssessmentBatch = { id: crypto.randomUUID(), version: book.version, assessmentKey, cutoff: profile.low, count: candidates.length, createdAt: now };
    await database.vocabulary.bulkPut(candidates.map(card => ({ ...card, createdAt: card.createdAt || now, updatedAt: now, assessmentExemptBatch: receipt.id })));
    await database.studyMeta.put({ id: 'goal', targetVocab: 0, targetDays: 60, startDate: now, ...goal, updatedAt: now,
      wordbookAssessmentBatches: { ...goal?.wordbookAssessmentBatches, [book.id]: receipt } });
    return receipt;
  });
  if (database === db) clearCheckpoint(database.name, book);
  return batch;
}

export async function undoWordbookAssessment(book: Wordbook, batchId: string, now = Date.now()): Promise<number> {
  const database = db;
  const restored = await database.transaction('rw', [database.vocabulary, database.studyMeta], async () => {
    const goal = await database.studyMeta.get('goal');
    const receipt = goal?.wordbookAssessmentBatches?.[book.id];
    if (!goal || !receipt || receipt.id !== batchId || receipt.undoneAt) throw new Error('这次测评免学已撤销或已更新，请重新读取。');
    const affected = (await database.vocabulary.toArray()).filter(card => card.assessmentExemptBatch === batchId);
    // Clear only our marker. Later reviews, explicit screening, saved sentences,
    // source changes and new dictionary meanings are never restored from snapshots.
    await database.vocabulary.bulkPut(affected.map(card => ({ ...card, assessmentExemptBatch: null, updatedAt: now })));
    await database.studyMeta.put({ ...goal, updatedAt: now, wordbookAssessmentBatches: { ...goal.wordbookAssessmentBatches, [book.id]: { ...receipt, undoneAt: now } } });
    return affected.length;
  });
  if (database === db) clearCheckpoint(database.name, book);
  return restored;
}
