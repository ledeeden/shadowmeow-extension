/** Adapted from Word Atlas store/session.ts (MIT, Word Atlas contributors, 2026).
 * Source revision: 99c007673d38f02c418d8e4cd2e9ec90b5d40be5.
 * See web/public/word-atlas-CODE-LICENSE.txt. Uses Shadow Language cards/events.
 */
import type { VocabularyCard, VocabularyRating } from '@shadow-language/contracts';
import { atlasKey, atlasMedia, type AtlasEntry } from './word-atlas';
import { headwordPattern } from './word-atlas-text';

export type QuizKind = 'meaning' | 'picture' | 'listen' | 'spell';
export type StudyStep = { cardId: string; kind: QuizKind | 'intro' | 'fallback'; options: string[]; retry?: boolean };
export type StudyGrade = { correct: boolean; rating: VocabularyRating };
export type AtlasSession = {
  version: 1; id: string; started: number; cards: VocabularyCard[];
  steps: StudyStep[]; index: number; graded: Record<string, StudyGrade>; practice: boolean;
};

export function atlasEntryForCard(card: VocabularyCard, catalog: AtlasEntry[]): AtlasEntry | undefined {
  const content = atlasKey(card.atlasWord || card.word);
  return catalog.find(entry => atlasKey(entry.w) === content)
    || catalog.find(entry => atlasKey(entry.w) === atlasKey(card.lemma));
}

export function hashSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function seededShuffle<T>(values: T[], seed: number): T[] {
  const out = [...values]; let x = Math.floor(seed) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    const j = x % (i + 1); [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Mask every occurrence, including inflections. If an example cannot
// safely be masked, use another question format instead of revealing the word.
export function clozeSentence(sentence: string, word: string): string | null {
  const pattern = new RegExp(headwordPattern(word).source, 'gi');
  const result = sentence.replace(pattern, '______');
  return result === sentence ? null : result;
}

export function meaningOf(entry: AtlasEntry, limit = 2): string {
  return entry.senses.slice(0, limit).map(s => `${s.pos} ${s.zh}`.trim()).join('；');
}

export function chooseQuiz(card: VocabularyCard, entry: AtlasEntry, seed: number): QuizKind {
  const stability = card.fsrs?.stability || 0;
  const roll = hashSeed(entry.id + seed) % 100;
  const picture = Boolean(atlasMedia(entry, 'img') && entry.ex[0] && clozeSentence(entry.ex[0].en, entry.w));
  if (!card.fsrs?.reps || stability < 2) {
    if (picture && roll < 45) return 'picture';
    return roll < 80 ? 'meaning' : 'listen';
  }
  if (stability >= 4 || roll < 35) return roll < 75 ? 'spell' : picture ? 'picture' : 'listen';
  return roll < 50 ? 'listen' : picture ? 'picture' : 'meaning';
}

export function quizOptions(entry: AtlasEntry, catalog: AtlasEntry[], kind: QuizKind, seed: number): string[] {
  const index = catalog.findIndex(value => value.id === entry.id);
  const core = entry.senses[0]?.zh.split(/[；;，,]/)[0] || '';
  const pool = catalog.slice(Math.max(0, index - 400), Math.max(index, 0) + 401);
  const scored = pool.filter(value => value.id !== entry.id && atlasKey(value.w) !== atlasKey(entry.w) && (!core || !meaningOf(value).includes(core))).map(value => {
    let score = hashSeed(value.id + seed) % 100;
    if (kind === 'listen' || kind === 'picture') {
      if (value.w[0]?.toLowerCase() === entry.w[0]?.toLowerCase()) score += 120;
      score += Math.max(0, 60 - Math.abs(value.w.length - entry.w.length) * 20);
    } else {
      if (value.cefr === entry.cefr) score += 40;
      if (value.senses[0]?.pos === entry.senses[0]?.pos) score += 60;
    }
    return { value, score };
  }).sort((a, b) => b.score - a.score);
  const seen = new Set([kind === 'meaning' ? meaningOf(entry, 1) : atlasKey(entry.w)]);
  const picks = [entry.id];
  for (const { value } of scored) {
    const key = kind === 'meaning' ? meaningOf(value, 1) : atlasKey(value.w);
    if (!key || seen.has(key)) continue;
    picks.push(value.id); seen.add(key);
    if (picks.length === 4) break;
  }
  return seededShuffle(picks, seed);
}

export function makeQuiz(card: VocabularyCard, catalog: AtlasEntry[], seed: number, kind?: QuizKind, retry = false): StudyStep {
  const entry = atlasEntryForCard(card, catalog);
  if (!entry) return { cardId: card.id, kind: 'fallback', options: [], ...(retry ? { retry: true } : {}) };
  const selected = kind || chooseQuiz(card, entry, seed);
  const options = selected === 'spell' ? [] : quizOptions(entry, catalog, selected, seed);
  if (selected !== 'spell' && options.length < 4) return { cardId: card.id, kind: 'fallback', options: [], ...(retry ? { retry: true } : {}) };
  return { cardId: card.id, kind: selected, options, ...(retry ? { retry: true } : {}) };
}

export function buildAtlasSession(cards: VocabularyCard[], catalog: AtlasEntry[], seed = Date.now(), practice = false): AtlasSession {
  const steps: StudyStep[] = [];
  const reviews = cards.filter(card => card.fsrs?.reps > 0 || practice);
  const fresh = cards.filter(card => !card.fsrs?.reps && !practice);
  reviews.forEach((card, i) => steps.push(makeQuiz(card, catalog, seed + i)));
  for (let g = 0; g < fresh.length; g += 5) {
    const group = fresh.slice(g, g + 5);
    group.forEach(card => steps.push({ cardId: card.id, kind: 'intro', options: [] }));
    seededShuffle(group, seed + g).forEach((card, i) => steps.push(makeQuiz(card, catalog, seed + 1000 + g + i)));
  }
  return { version: 1, id: `atlas-${seed}`, started: seed, cards, steps, index: 0, graded: {}, practice };
}

export function gradeAnswer(kind: QuizKind, correct: boolean, ms: number, hinted: boolean): VocabularyRating {
  if (!correct) return 1;
  if (hinted || ms > (kind === 'spell' ? 20000 : 9000)) return 2;
  return kind === 'spell' && ms < 6000 ? 4 : 3;
}

export function acceptAnswer(session: AtlasSession, grade: StudyGrade, catalog: AtlasEntry[]): AtlasSession {
  const step = session.steps[session.index]!;
  const card = session.cards.find(value => value.id === step.cardId)!;
  const first = !step.retry && !session.graded[card.id];
  const next = { ...session, steps: [...session.steps], graded: first ? { ...session.graded, [card.id]: grade } : session.graded };
  if (!grade.correct && next.steps.filter(s => s.cardId === card.id && s.retry).length < 2) {
    const entry = atlasEntryForCard(card, catalog);
    const picture = entry && atlasMedia(entry, 'img') && entry.ex[0] && clozeSentence(entry.ex[0].en, entry.w);
    const kind = step.kind === 'meaning' ? (picture ? 'picture' : 'listen') : 'meaning';
    next.steps.splice(Math.min(next.steps.length, next.index + 4), 0, makeQuiz(card, catalog, hashSeed(next.id + next.steps.length), kind, true));
  }
  return next;
}
