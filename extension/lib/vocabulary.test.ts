import { describe, expect, it } from 'vitest';
import { mediaVocabularyWordInput, vocabularyTermKeys } from './vocabulary';

describe('vocabulary term matching', () => {
  it('matches both the displayed word and its supplied or indexed lemma', () => {
    expect(vocabularyTermKeys('Running', 'run')).toEqual(['running', 'run']);
  });

  it('normalizes apostrophes and whitespace for highlight state lookup', () => {
    expect(vocabularyTermKeys('  DON’T  ')).toContain("don't");
  });
});

describe('self-hosted corpus word saving', () => {
  it('keeps the corpus source and context for the FSRS vocabulary card', () => {
    expect(mediaVocabularyWordInput('media:youtube-abcdefghijk', ' Learning ', 'We are learning.', { lemma: 'learn', translation: '学习' })).toEqual({
      word: 'Learning', lemma: 'learn', translation: '学习',
      source: 'video_asset:media:youtube-abcdefghijk', contextText: 'We are learning.',
    });
  });

  it('does not misidentify arbitrary video ids as self-hosted corpus', () => {
    expect(() => mediaVocabularyWordInput('abcdefghijk', 'learn', 'Learn it.')).toThrow('语料 ID 无效');
  });
});
