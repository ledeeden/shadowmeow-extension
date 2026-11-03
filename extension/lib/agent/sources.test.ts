import { describe, expect, it } from 'vitest';
import { sourcesFromTool } from './sources';

describe('Agent corpus result sources', () => {
  it('turns API video items into real resource cards with learning metadata', () => {
    const sources = sourcesFromTool('corpus_search', {
      items: [{
        youtubeId: 'dQw4w9WgXcQ',
        title: 'How to use public transportation',
        channelTitle: 'Travel English',
        analysis: { activeWpm: 112, recommendedVocabulary: { threshold: 3500 } },
      }],
    });
    expect(sources[0]).toMatchObject({
      kind: 'video',
      title: 'How to use public transportation',
      href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s',
      detail: 'Travel English · 112 词/分钟 · 4,000 词',
    });
  });
});
