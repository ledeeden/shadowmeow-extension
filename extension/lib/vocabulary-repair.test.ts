import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VocabularyCard } from '@shadow-language/contracts';
import { getAllVocabularyCards } from './vocabulary';

const state = vi.hoisted(() => ({ cards: [] as VocabularyCard[], beforeTransaction: undefined as (() => void) | undefined, transcript: vi.fn() }));
vi.mock('./video-transcript', () => ({ readVideoTranscript: state.transcript }));
vi.mock('./db', () => ({ db: {
  vocabulary: {
    toArray: async () => structuredClone(state.cards),
    get: async (id: string) => structuredClone(state.cards.find(card => card.id === id)),
    update: async (id: string, patch: Partial<VocabularyCard>) => Object.assign(state.cards.find(card => card.id === id)!, patch),
  },
  transaction: async (_mode: string, _table: unknown, run: () => Promise<void>) => { state.beforeTransaction?.(); await run(); },
} }));

function card(overrides: Partial<VocabularyCard> = {}): VocabularyCard {
  return {
    id: 'vocab:catherine', word: 'Catherine', lemma: 'catherine', rank: null, phonetic: '',
    translation: '轮圈外缘装有倒钩的车轮，侧翻筋斗', status: 'learning', source: 'video_asset:media:youtube-abcdefghijk',
    contextText: '██ ███ Catherine', createdAt: 100, updatedAt: 200, due: 1000,
    fsrs: { state: 2, difficulty: 4, stability: 3, reps: 5, lapses: 1, lastReview: 100, due: 1000 },
    ...overrides,
  };
}

describe('stored vocabulary repair', () => {
  beforeEach(() => {
    state.cards = [card()];
    state.beforeTransaction = undefined;
    state.transcript.mockReset().mockResolvedValue({ cues: [], page: { segments: [{ text: 'We met Catherine.' }] } });
  });

  it('repairs the saved definition and context while preserving FSRS and source data', async () => {
    const original = structuredClone(state.cards[0]!);
    const [repaired] = await getAllVocabularyCards();
    expect(repaired).toMatchObject({ translation: '凯瑟琳（女子名）', contextText: 'We met Catherine.', fsrs: original.fsrs, due: original.due, status: original.status, source: original.source });
    expect(state.cards[0]).toEqual(repaired);
    expect(state.transcript).toHaveBeenCalledWith('media:youtube-abcdefghijk');
    state.transcript.mockClear();
    await getAllVocabularyCards();
    expect(state.transcript).not.toHaveBeenCalled();
  });

  it('does not guess a missing transcript or erase the old context', async () => {
    state.transcript.mockResolvedValue(undefined);
    const [repaired] = await getAllVocabularyCards();
    expect(repaired?.contextText).toBe('██ ███ Catherine');
    expect(repaired?.translation).toBe('凯瑟琳（女子名）');
  });

  it('preserves concurrent user edits and review changes', async () => {
    state.beforeTransaction = () => Object.assign(state.cards[0]!, { translation: '我的同事凯瑟琳', contextText: 'Catherine is my colleague.', fsrs: { ...state.cards[0]!.fsrs, reps: 6 } });
    const [repaired] = await getAllVocabularyCards();
    expect(repaired).toMatchObject({ translation: '我的同事凯瑟琳', contextText: 'Catherine is my colleague.', fsrs: { reps: 6 } });
  });

  it('does not use a different or unidentifiable source for recovery', async () => {
    state.cards = [card({ source: 'reader:文章' })];
    const [repaired] = await getAllVocabularyCards();
    expect(repaired?.contextText).toBe('██ ███ Catherine');
    expect(state.transcript).not.toHaveBeenCalled();
  });
});
