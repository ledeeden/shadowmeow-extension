import { describe, expect, it } from 'vitest';
import { buildCorpusSearchFilters } from './corpus-search';

describe('Agent public corpus search intent', () => {
  it('turns the natural-language slow public-transport request into structured filters', () => {
    expect(buildCorpusSearchFilters({ query: '我想学习语速慢一点的，讲公共交通的' })).toMatchObject({
      query: '',
      topic: 'public_transport',
      searchMode: 'agent',
      maxActiveWpm: 140,
      cursor: 0,
      limit: 8,
    });
  });

  it('keeps explicit structured preferences and bounds the result page', () => {
    expect(buildCorpusSearchFilters({ topic: 'airport', speed: 'very_slow', topicTerms: ['boarding', '机场'], limit: 99 })).toMatchObject({
      topic: 'airport',
      topicTerms: ['boarding', '机场'],
      maxActiveWpm: 100,
      limit: 12,
      searchMode: 'agent',
    });
  });
});
