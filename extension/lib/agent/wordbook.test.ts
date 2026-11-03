import { describe, expect, it } from 'vitest';
import type { PageState } from '@shadow-language/contracts';
import { learningTools } from './runtime';
import { buildAgentWordbookItem, explicitlyRequestsWordbookSave, parseAgentWordbookInput } from './wordbook';

const page: PageState = {
  youtubeId: 'dQw4w9WgXcQ',
  title: 'Hotel English',
  channelTitle: 'Travel English',
  durationMs: 90_000,
  playerState: 'paused',
  timeMs: 12_000,
  playbackRate: 1,
  tracks: [],
  activeTrackId: '.en',
  cues: [
    { seq: 0, startMs: 1_000, endMs: 3_000, text: 'Welcome to our hotel.' },
    { seq: 1, startMs: 10_000, endMs: 13_000, text: 'I would like to check in, please.' },
  ],
  segments: [],
};

describe('Agent wordbook saves', () => {
  it('exposes a structured save tool for words, phrases, and patterns', () => {
    const tool = learningTools.find((candidate) => candidate.function.name === 'wordbook_save');
    expect(tool?.function.parameters).toMatchObject({
      required: ['kind', 'value'],
      properties: { kind: { enum: ['word', 'phrase', 'pattern'] } },
    });
  });

  it('requires an explicit request before allowing the model to write learner data', () => {
    expect(explicitlyRequestsWordbookSave('把 check in 写入生词本')).toBe(true);
    expect(explicitlyRequestsWordbookSave('Please add check in to my wordbook')).toBe(true);
    expect(explicitlyRequestsWordbookSave('解释一下 check in 的意思')).toBe(false);
  });

  it('uses the same saved-item shape and matching caption context as the player', () => {
    const input = parseAgentWordbookInput({ kind: 'phrase', value: 'check in', meaningZh: '办理入住' });
    const item = buildAgentWordbookItem(input, page);
    expect(item).toMatchObject({
      kind: 'phrase',
      displayValue: 'check in',
      normalizedValue: 'check in',
      youtubeId: 'dQw4w9WgXcQ',
      segmentSeq: 1,
      startMs: 10_000,
      contextText: 'I would like to check in, please.',
      meaningZh: '办理入住',
    });
  });

  it('rejects an unsupported entry kind instead of silently changing it', () => {
    expect(() => parseAgentWordbookInput({ kind: 'sentence', value: 'Could I check in?' })).toThrow('类型');
  });

  it('rejects self-hosted media keys that learning-data schemas cannot persist yet', () => {
    const mediaPage = { ...page, youtubeId: null, platform: 'media' as const, videoKey: 'media:youtube-d0yGdNEWdn0' };
    const input = parseAgentWordbookInput({ kind: 'phrase', value: 'check in' });
    expect(() => buildAgentWordbookItem(input, mediaPage)).toThrow('自有媒体语料');
  });
});
