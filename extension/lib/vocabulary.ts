import { cuesToLearningSegments, vocabularySyncKey, randomId } from '@shadow-language/contracts';
import { markDerivedReview } from './sync/local-store';
import type { VocabularyCard, VocabularyGoal, VocabularyRating, VocabularyState, VocabularyWordInput } from '@shadow-language/contracts';
import { db, type LocalVocabularyCard, type LocalVocabularyGoal } from './db';
import { FSRSEngine } from './fsrs';
import { lookupReaderWord } from './reader-frequency';
import { buildVocabularyPlan, buildVocabularyQueue } from './vocabulary-scheduler';
import { correctSavedDictionaryMeaning } from './dictionary-corrections';
import { recoverMaskedVocabularyContext } from './vocabulary-context-repair';

const fsrs = new FSRSEngine();

function normalizeVocabularyText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201B\u02BC\u0060\u00B4]/g, "'")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function normalizeVocabularyLemma(word: string, lemma?: string): string {
  const supplied = lemma ? normalizeVocabularyText(lemma) : '';
  if (supplied) return supplied;
  const info = lookupReaderWord(word);
  return normalizeVocabularyText(info.lemma || word);
}

export function vocabularyCardId(lemma: string): string {
  return vocabularySyncKey(lemma);
}

export function vocabularyTermKeys(word: string, lemma?: string): string[] {
  const normalizedWord = normalizeVocabularyText(word);
  const suppliedLemma = lemma ? normalizeVocabularyText(lemma) : '';
  const readerLemma = normalizedWord ? normalizeVocabularyText(lookupReaderWord(normalizedWord).lemma || normalizedWord) : '';
  return [...new Set([normalizedWord, suppliedLemma, readerLemma].filter(Boolean))];
}

/** Self-hosted corpus items do not fit the legacy video-asset identity schema. */
export function mediaVocabularyWordInput(
  videoKey: string,
  word: string,
  contextText: string,
  details: Pick<VocabularyWordInput, 'lemma' | 'translation' | 'phonetic'> = {},
): VocabularyWordInput {
  if (!/^media:[^\s/?#]{8,128}$/.test(videoKey)) throw new Error('语料 ID 无效。');
  return { word: word.trim(), ...details, source: `video_asset:${videoKey}`, contextText };
}

function optionalText(value: string | undefined, fallback: string): string {
  const normalized = value?.normalize('NFKC').trim();
  return normalized || fallback;
}

function fallbackRank(word: string, lemma: string): number | null {
  const info = lookupReaderWord(word);
  if (info.rank !== null) return info.rank;
  const lemmaInfo = lookupReaderWord(lemma);
  return lemmaInfo.rank;
}

function asVocabularyCard(card: LocalVocabularyCard): VocabularyCard {
  return card;
}

export async function getVocabularyCard(wordOrLemma: string): Promise<LocalVocabularyCard | null> {
  const query = normalizeVocabularyText(wordOrLemma);
  if (!query) return null;
  const direct = await db.vocabulary.get(vocabularyCardId(normalizeVocabularyLemma(query)));
  if (direct) return direct;
  const byLemma = await db.vocabulary.where('lemma').equals(query).first();
  if (byLemma) return byLemma;
  const all = await db.vocabulary.toArray();
  return all.find((card) => normalizeVocabularyText(card.word) === query) || null;
}

export async function saveVocabularyWord(input: VocabularyWordInput): Promise<LocalVocabularyCard> {
  const word = optionalText(input.word, '');
  if (!word) throw new Error('要学习的单词不能为空。');

  const lemma = normalizeVocabularyLemma(word, input.lemma);
  const id = vocabularyCardId(lemma);
  const existing = await db.vocabulary.get(id);
  const now = Date.now();
  const rank = input.rank ?? existing?.rank ?? fallbackRank(word, lemma);
  const fsrsState = existing?.fsrs || fsrs.createItem(now);
  const status = existing?.status === 'ignored' ? 'unfamiliar' : (existing?.status || 'unfamiliar');
  const card: LocalVocabularyCard = {
    id,
    word: existing?.word || word,
    lemma,
    rank,
    phonetic: optionalText(input.phonetic, existing?.phonetic || ''),
    translation: correctSavedDictionaryMeaning(lemma, optionalText(input.translation, existing?.translation || '')),
    status,
    // Saving a studied book word from a video/reader also puts it in My Words.
    source: existing?.source?.startsWith('wordbook:') && !input.source?.startsWith('wordbook:')
      ? optionalText(input.source, 'saved_word') : existing?.source || optionalText(input.source, 'saved_word'),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    due: existing?.due ?? now,
    fsrs: fsrsState,
    ...(existing?.reviewExempt !== undefined ? { reviewExempt: existing.reviewExempt } : {}),
    ...(existing?.assessmentExemptBatch !== undefined ? { assessmentExemptBatch: existing.assessmentExemptBatch } : {}),
    ...(input.contextText !== undefined ? { contextText: input.contextText.normalize('NFKC').trim().slice(0, 2_000) } : existing?.contextText ? { contextText: existing.contextText } : {}),
  };
  await db.vocabulary.put(card);
  return card;
}

export async function markVocabularyKnown(input: VocabularyWordInput): Promise<LocalVocabularyCard> {
  const saved = await saveVocabularyWord(input);
  const known: LocalVocabularyCard = {
    ...saved,
    status: 'known',
    due: saved.fsrs.reps > 0 ? saved.fsrs.due : null,
    updatedAt: Date.now(),
  };
  await db.vocabulary.put(known);
  return known;
}

export async function removeVocabularyWord(wordOrLemma: string): Promise<boolean> {
  const card = await getVocabularyCard(wordOrLemma);
  if (!card) return false;
  await db.vocabulary.delete(card.id);
  return true;
}

export async function getAllVocabularyCards(): Promise<LocalVocabularyCard[]> {
  const cards = await repairStoredVocabularyCards(await db.vocabulary.toArray());
  return cards.sort((left, right) => {
    const leftRank = Number.isFinite(left.rank) ? left.rank as number : 99_999;
    const rightRank = Number.isFinite(right.rank) ? right.rank as number : 99_999;
    return leftRank - rightRank || left.word.localeCompare(right.word);
  });
}

async function repairStoredVocabularyCards(cards: LocalVocabularyCard[]): Promise<LocalVocabularyCard[]> {
  const sources = new Map<string, Promise<string[]>>();
  const repairs: Array<{ card: LocalVocabularyCard; translation: string; contextText: string | undefined }> = [];
  for (const card of cards) {
    const translation = correctSavedDictionaryMeaning(card.lemma, card.translation);
    let contextText = card.contextText;
    if (contextText?.includes('█') && /^(?:video_asset|subtitle):/.test(card.source)) {
      const videoKey = card.source.replace(/^(?:video_asset|subtitle):/, '');
      if (!sources.has(videoKey)) sources.set(videoKey, (async () => {
        const { readVideoTranscript } = await import('./video-transcript');
        const transcript = await readVideoTranscript(videoKey);
        if (!transcript) return [];
        return [
          ...(transcript.page?.segments || []),
          ...transcript.cues,
          ...cuesToLearningSegments(transcript.cues, { allowOverlap: true }),
        ].map(segment => segment.text);
      })().catch(() => []));
      contextText = recoverMaskedVocabularyContext(contextText, card.word, await sources.get(videoKey)!) || contextText;
    }
    if (translation !== card.translation || contextText !== card.contextText) repairs.push({ card, translation, contextText });
  }
  if (!repairs.length) return cards;

  // Recheck each field inside the transaction so a concurrent edit is preserved.
  const repaired = new Map<string, LocalVocabularyCard>();
  await db.transaction('rw', db.vocabulary, async () => {
    for (const { card, translation, contextText } of repairs) {
      const current = await db.vocabulary.get(card.id);
      if (!current) continue;
      const changes: Partial<LocalVocabularyCard> = {};
      if (translation !== card.translation && current.translation === card.translation) changes.translation = translation;
      if (contextText !== undefined && contextText !== card.contextText && current.contextText === card.contextText && current.source === card.source) changes.contextText = contextText;
      if (Object.keys(changes).length) {
        changes.updatedAt = Date.now();
        await db.vocabulary.update(card.id, changes);
      }
      repaired.set(card.id, { ...current, ...changes });
    }
  });
  return cards.map(card => repaired.get(card.id) || card);
}

export async function getMasteredVocabularyLemmas(): Promise<Set<string>> {
  const cards = await db.vocabulary.where('status').equals('known').toArray();
  const mastered = new Set<string>();
  for (const card of cards) {
    for (const key of vocabularyTermKeys(card.word, card.lemma)) mastered.add(key);
  }
  return mastered;
}

export async function getVocabularyStudyPlan(now = Date.now()) {
  const [cards, logs, goal] = await Promise.all([
    getAllVocabularyCards(),
    db.vocabularyReviews.toArray(),
    db.studyMeta.get('goal'),
  ]);
  return buildVocabularyPlan(cards.map(asVocabularyCard), logs, goal ? {
    targetVocab: goal.targetVocab,
    targetDays: goal.targetDays,
    startDate: goal.startDate,
    ...(goal.wordbook ? { wordbook: goal.wordbook } : {}),
  } : null, now);
}

export async function getTodayVocabularyQueue(now = Date.now()) {
  return buildVocabularyQueue(await getVocabularyStudyPlan(now));
}

export async function recordVocabularyReview(wordOrLemma: string, rating: VocabularyRating, now = Date.now()): Promise<LocalVocabularyCard | null> {
  if (![1, 2, 3, 4].includes(rating)) throw new Error('复习评分无效。');
  const card = await getVocabularyCard(wordOrLemma);
  if (!card) return null;

  const currentFsrs = card.fsrs || fsrs.createItem(now);
  const wasNew = currentFsrs.reps === 0;
  const updatedFsrs = fsrs.schedule(currentFsrs, rating, now);
  const nextStatus: LocalVocabularyCard['status'] = rating === fsrs.RATING.EASY && updatedFsrs.reps >= 2
    ? 'known'
    : fsrs.isMastered(updatedFsrs)
      ? 'known'
      : 'learning';
  const updated: LocalVocabularyCard = {
    ...card,
    fsrs: updatedFsrs,
    due: updatedFsrs.due,
    status: nextStatus,
    reviewExempt: false,
    assessmentExemptBatch: null,
    updatedAt: now,
  };
  const review: VocabularyReviewLogRecord = {
    id: `vocab_review_${randomId()}`,
    word: card.lemma,
    rating,
    stability: updatedFsrs.stability,
    difficulty: updatedFsrs.difficulty,
    intervalDays: updatedFsrs.intervalDays || 0,
    isNew: wasNew,
    timestamp: now,
  };
  await db.transaction('rw', [db.vocabulary, db.vocabularyReviews], async tx => {
    markDerivedReview(tx);
    await db.vocabulary.put(updated);
    await db.vocabularyReviews.put(review);
  });
  return updated;
}

type VocabularyReviewLogRecord = {
  id: string;
  word: string;
  rating: VocabularyRating;
  stability: number;
  difficulty: number;
  intervalDays: number;
  isNew: boolean;
  timestamp: number;
};

export async function getVocabularyState(): Promise<VocabularyState> {
  const [cards, plan, masteredLemmas] = await Promise.all([
    getAllVocabularyCards(),
    getVocabularyStudyPlan(),
    getMasteredVocabularyLemmas(),
  ]);
  return { cards: cards.map(asVocabularyCard), masteredLemmas: [...masteredLemmas], plan };
}

export async function setVocabularyGoal(goal: VocabularyGoal | null): Promise<VocabularyGoal | null> {
  if (!goal) {
    const current = await db.studyMeta.get('goal');
    if (current?.wordbook || current?.wordbookScreening || current?.wordbookAssessmentBatches) await db.studyMeta.put({ ...current, targetVocab: 0, updatedAt: Date.now() });
    else await db.studyMeta.delete('goal');
    return null;
  }
  const targetVocab = Math.max(1_000, Math.min(15_000, Math.round(Number(goal.targetVocab) || 8_000)));
  const targetDays = Math.max(7, Math.min(365, Math.round(Number(goal.targetDays) || 60)));
  const startDate = Number.isFinite(Number(goal.startDate)) && Number(goal.startDate) > 0 ? Number(goal.startDate) : Date.now();
  const current = await db.studyMeta.get('goal');
  const record: LocalVocabularyGoal = { ...current, id: 'goal', targetVocab, targetDays, startDate, updatedAt: Date.now() };
  await db.studyMeta.put(record);
  return { targetVocab, targetDays, startDate };
}
