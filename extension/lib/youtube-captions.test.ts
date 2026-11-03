import { describe, expect, it } from 'vitest';
import { fetchCaptionTrack, parseCaptionPayload, parseJson3, parseTimedTextXml } from './youtube-captions';
import { cuesToLearningSegments, normalizeCues } from '@shadow-language/contracts';

describe('YouTube json3 adapter', () => {
  it('retains word offsets through normalization for exact sentence splitting', () => {
    const cues = normalizeCues(parseJson3({ events: [{ tStartMs: 1000, dDurationMs: 6000, segs: [
      { utf8: 'We', tOffsetMs: 0 }, { utf8: ' ran.', tOffsetMs: 200 },
      { utf8: ' They', tOffsetMs: 2000 }, { utf8: ' stayed.', tOffsetMs: 2300 },
    ] }] }));
    expect(cues[0]?.wordStarts).toContainEqual({ offset: 8, startMs: 3000 });
    expect(cuesToLearningSegments(cues).map(segment => [segment.text, segment.startMs, segment.endMs, segment.timing]))
      .toEqual([['We ran.', 1000, 3000, 'word'], ['They stayed.', 3000, 7000, 'word']]);
  });
  it('joins event segments and ignores window markers', () => {
    expect(parseJson3({ events: [
      { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'Hello ' }, { utf8: 'world.' }] },
      { tStartMs: 1200, dDurationMs: 500 },
    ] })).toEqual([{ seq: 0, startMs: 0, endMs: 1200, text: 'Hello world.' }]);
  });

  it('uses the next caption start when json3 omits a duration', () => {
    expect(parseJson3({ events: [
      { tStartMs: 0, segs: [{ utf8: 'First' }] },
      { tStartMs: 1800, segs: [{ utf8: 'Second.' }] },
    ] })).toEqual([
      { seq: 0, startMs: 0, endMs: 1800, text: 'First' },
      { seq: 1, startMs: 1800, endMs: 3800, text: 'Second.' },
    ]);
  });

  it('treats an empty or malformed response as an unsupported payload', () => {
    expect(parseCaptionPayload('')).toEqual([]);
    expect(parseCaptionPayload('{')).toEqual([]);
  });

  it('parses legacy timed-text XML when json3 is unavailable', () => {
    expect(parseTimedTextXml('<transcript><text start="1.25" dur="2.5">Hello &amp; welcome</text></transcript>')).toEqual([
      { seq: 0, startMs: 1250, endMs: 3750, text: 'Hello & welcome' },
    ]);
  });

  it('parses srv3 millisecond cues and nested span text', () => {
    expect(parseCaptionPayload('<timedtext><body><p t="250" d="900"><s>Good </s><s>morning</s></p></body></timedtext>')).toEqual([
      { seq: 0, startMs: 250, endMs: 1150, text: 'Good morning' },
    ]);
  });

  it('uses the next cue start when srv3 omits a duration', () => {
    expect(parseTimedTextXml('<timedtext><body><p t="250"><s>First</s></p><p t="1800"><s>Second.</s></p></body></timedtext>')).toEqual([
      { seq: 0, startMs: 250, endMs: 1800, text: 'First' },
      { seq: 1, startMs: 1800, endMs: 3800, text: 'Second.' },
    ]);
  });

  it('falls back to another YouTube caption format after a 200 empty response', async () => {
    const requested: string[] = [];
    const bodies = ['', '<transcript><text start="0" dur="1">Fallback works</text></transcript>'];
    const cues = await fetchCaptionTrack('https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en', async (url) => {
      requested.push(url);
      const body = bodies.shift() ?? '';
      return { ok: true, status: 200, text: async () => body };
    });
    expect(requested).toHaveLength(2);
    expect(new URL(requested[0]!).searchParams.get('fmt')).toBe('json3');
    expect(new URL(requested[1]!).searchParams.get('fmt')).toBe('srv3');
    expect(cues[0]?.text).toBe('Fallback works');
  });
});
