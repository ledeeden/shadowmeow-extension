import { describe, expect, it } from 'vitest';
import { captionHashInput, cuesToLearningSegments, MAX_LEARNING_SEGMENT_WORDS, normalizeCaptionText, normalizeCues } from './captions';

function wordStarts(text: string, startMs = 0, cadenceMs = 120) {
  return [...text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*/g)]
    .map((match, index) => ({ offset: match.index!, startMs: startMs + index * cadenceMs }));
}

describe('caption normalization', () => {
  it('normalizes tags, entities, unicode and whitespace deterministically', () => {
    expect(normalizeCaptionText('  <font>Ｈi&nbsp; &amp; bye</font>\n')).toBe('Hi & bye');
  });

  it('keeps timestamps stable while dropping empty cues', () => {
    expect(normalizeCues([
      { seq: 9, startMs: 1.2, endMs: 1000.8, text: ' Hello ' },
      { seq: 10, startMs: 1001, endMs: 1100, text: ' <i></i> ' },
    ])).toEqual([{ seq: 0, startMs: 1, endMs: 1001, text: 'Hello' }]);
  });

  it('sorts cues by playback time while keeping equal-time input stable', () => {
    expect(normalizeCues([
      { seq: 0, startMs: 2_000, endMs: 3_000, text: 'Later' },
      { seq: 1, startMs: 1_000, endMs: 2_000, text: 'Earlier' },
      { seq: 2, startMs: 1_000, endMs: 2_500, text: 'Overlapping' },
    ])).toEqual([
      { seq: 0, startMs: 1_000, endMs: 2_000, text: 'Earlier' },
      { seq: 1, startMs: 1_000, endMs: 2_500, text: 'Overlapping' },
      { seq: 2, startMs: 2_000, endMs: 3_000, text: 'Later' },
    ]);
  });

  it('builds hash input independent of caller sequence ids', () => {
    const a = captionHashInput('en', 'manual', [{ seq: 9, startMs: 0, endMs: 1000, text: 'Hi.' }]);
    const b = captionHashInput('en', 'manual', [{ seq: 0, startMs: 0, endMs: 1000, text: 'Hi.' }]);
    expect(a).toBe(b);
  });
});

describe('learning segments', () => {
  it('splits the reported paragraph into sentences within a cue', () => {
    const text = '>> Yeah, we come from Vikings probably. We love the cold. I love the cold. My favorite day of the year is when it gets cold and people can\'t drive around because it\'s too much snow. Look at my face. Look at my hair. Do I look like I go to Spain every year? no. But I think it\'s the most beautiful place in the world. You know, people are friendly. People love each other and they take care of each other.';
    const result = cuesToLearningSegments([{ seq: 0, startMs: 0, endMs: 26000, text, wordStarts: wordStarts(text) }]);
    expect(result).toHaveLength(11);
    expect(result[0]?.text).toBe('>> Yeah, we come from Vikings probably.');
    expect(result[1]?.text).toBe('We love the cold.');
    expect(result.map(segment => segment.text).join(' ')).toBe(text);
    expect(result.every(segment => segment.endMs > segment.startMs && segment.timing === 'word')).toBe(true);
    expect(result.slice(1).every((segment, index) => segment.startMs === result[index]?.endMs)).toBe(true);
  });

  it('uses source word timestamps for internal sentence boundaries', () => {
    const result = cuesToLearningSegments([{ seq: 0, startMs: 1000, endMs: 8000,
      text: 'We ran. They stayed.', wordStarts: [{ offset: 0, startMs: 1000 }, { offset: 8, startMs: 2500 }] }]);
    expect(result.map(segment => [segment.text, segment.startMs, segment.endMs, segment.timing])).toEqual([
      ['We ran.', 1000, 2500, 'word'], ['They stayed.', 2500, 8000, 'word'],
    ]);
    expect(result.map(segment => segment.wordStarts)).toEqual([
      [{ offset: 0, startMs: 1000 }], [{ offset: 0, startMs: 2500 }],
    ]);
  });

  it('splits a long multi-sentence cue even when YouTube omits word timestamps', () => {
    const sentences = [
      'The person at the window was laughing so hard at me [laughter] and it was really embarrassing.',
      'So after that, whenever I go through a drive-thru, I\'m really careful.',
      'I have never hit a mirror against a building and I\'ve never had to get out of the car at a drive-thru.',
      'So, let\'s see if I do any better today.',
      'And I can get close enough that I can reach from the window and I don\'t hit the car against the Starbucks building.',
      'Let\'s go.',
    ];
    const text = sentences.join(' ');
    const result = cuesToLearningSegments([
      { seq: 79, startMs: 652_000, endMs: 679_000, text },
    ]);

    expect(result.map((segment) => segment.text)).toEqual(sentences);
    expect(result.every((segment) =>
      (segment.text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*/g)?.length ?? 0)
      <= MAX_LEARNING_SEGMENT_WORDS)).toBe(true);
    expect(result.map((segment) => segment.text).join(' ')).toBe(text);
    expect(result.some((segment) => segment.timing === 'estimated')).toBe(true);
  });

  it('keeps word-start offsets relative to a merged learning segment', () => {
    const result = cuesToLearningSegments([
      { seq: 0, startMs: 0, endMs: 600, text: 'Hello', wordStarts: [{ offset: 0, startMs: 0 }] },
      { seq: 1, startMs: 600, endMs: 1_200, text: 'world.', wordStarts: [{ offset: 0, startMs: 600 }] },
    ]);
    expect(result[0]?.wordStarts).toEqual([{ offset: 0, startMs: 0 }, { offset: 6, startMs: 600 }]);
  });

  it('splits a long sentence at a clause boundary without dropping any text', () => {
    const firstClause = Array.from({ length: 18 }, () => 'first').join(' ');
    const secondClause = Array.from({ length: 16 }, () => 'second').join(' ');
    const text = `${firstClause}, ${secondClause}.`;
    const result = cuesToLearningSegments([{ seq: 0, startMs: 0, endMs: 8_000, text, wordStarts: wordStarts(text) }]);
    expect(result.map((segment) => segment.text).join(' ')).toBe(text);
    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe(`${firstClause},`);
    expect(result.every((segment) => segment.text.split(/\s+/).length <= MAX_LEARNING_SEGMENT_WORDS)).toBe(true);
  });

  it('keeps a parallel clause together instead of starting a segment with or', () => {
    const text = "If you're new to learning English and want to see more about life in Australia, maybe you're planning to travel here, are studying here, or will move here for work, this video series will help you understand everyday English while exploring real places around Melbourne and Australia.";
    const result = cuesToLearningSegments([{ seq: 0, startMs: 0, endMs: 12_000, text, wordStarts: wordStarts(text, 0, 200) }]);
    expect(result.map((segment) => segment.text)).toEqual([
      "If you're new to learning English and want to see more about life in Australia,",
      "maybe you're planning to travel here, are studying here, or will move here for work,",
      'this video series will help you understand everyday English while exploring real places around Melbourne and Australia.',
    ]);
    expect(result.every((segment) => segment.text.split(/\s+/).length <= MAX_LEARNING_SEGMENT_WORDS)).toBe(true);
  });

  it('enforces the word cap even where there is no suitable clause boundary', () => {
    const text = `${Array.from({ length: MAX_LEARNING_SEGMENT_WORDS + 3 }, () => 'word').join(' ')}.`;
    const result = cuesToLearningSegments([{ seq: 0, startMs: 0, endMs: 8_000, text, wordStarts: wordStarts(text) }]);
    expect(result.map((segment) => segment.text).join(' ')).toBe(text);
    expect(result.every((segment) => segment.text.split(/\s+/).length <= MAX_LEARNING_SEGMENT_WORDS)).toBe(true);
  });

  it('keeps abbreviations, decimals and punctuation with their sentence', () => {
    const text = 'Dr. Smith arrived at 3.5 p.m. yesterday. "Really?" Yes!';
    expect(cuesToLearningSegments([{ seq: 0, startMs: 0, endMs: 10000, text, wordStarts: wordStarts(text) }]).map(segment => segment.text))
      .toEqual(['Dr. Smith arrived at 3.5 p.m. yesterday.', '"Really?"', 'Yes!']);
  });

  it('uses word-count timing to preserve and bound an unanchored long source cue', () => {
    const text = `${Array.from({ length: MAX_LEARNING_SEGMENT_WORDS + 3 }, () => 'word').join(' ')}.`;
    const result = cuesToLearningSegments([{ seq: 0, startMs: 0, endMs: 8_000, text }]);
    expect(result.map((segment) => segment.text).join(' ')).toBe(text);
    expect(result.every((segment) => segment.text.split(/\s+/).length <= MAX_LEARNING_SEGMENT_WORDS)).toBe(true);
    expect(result.every((segment) => segment.timing === 'estimated')).toBe(true);
  });
  it('keeps a long shadowing sentence together across rolling YouTube cues', () => {
    const cues = [
      { seq: 0, startMs: 0, endMs: 7000, text: 'This is the famous Rainbow Street and' },
      { seq: 1, startMs: 4000, endMs: 11000, text: 'behind me the famous brutalist church' },
      { seq: 2, startMs: 8000, endMs: 15000, text: 'that is the centerpiece of the city.' },
      { seq: 3, startMs: 12000, endMs: 17000, text: 'Its design was inspired by' },
      { seq: 4, startMs: 16000, endMs: 21000, text: "Iceland's natural landscape." },
    ];
    const segments = cuesToLearningSegments(cues, { allowOverlap: true });
    expect(segments.map(segment => segment.text)).toEqual([
      'This is the famous Rainbow Street and behind me the famous brutalist church that is the centerpiece of the city.',
      "Its design was inspired by Iceland's natural landscape.",
    ]);
    expect(segments[0]).toMatchObject({ startMs: 0, endMs: 12000, sourceCueIds: ['0', '1', '2'] });
    expect(segments[1]).toMatchObject({ startMs: 12000, endMs: 21000 });
    expect(cues[0]?.endMs).toBe(7000);
  });

  it('keeps the continuation after by even when it exceeds eight seconds', () => {
    const first = 'visible from almost everywhere in the city. Its design was inspired by';
    const second = "Iceland's natural landscape.";
    expect(cuesToLearningSegments([
      { seq: 0, startMs: 0, endMs: 6000, text: first, wordStarts: wordStarts(first) },
      { seq: 1, startMs: 6000, endMs: 11000, text: second, wordStarts: wordStarts(second, 6000) },
    ]).map(segment => segment.text)).toEqual([
      'visible from almost everywhere in the city.',
      "Its design was inspired by Iceland's natural landscape.",
    ]);
  });

  it('does not split a list at a comma merely because the segment is long', () => {
    expect(cuesToLearningSegments([
      { seq: 0, startMs: 0, endMs: 18000, text: 'Its facade mimicking hexagonal basalt columns,' },
      { seq: 1, startMs: 18000, endMs: 22000, text: 'glaciers, and lava flows.' },
    ]).map(segment => segment.text)).toEqual(['Its facade mimicking hexagonal basalt columns, glaciers, and lava flows.']);
  });

  it('separates complete short responses but not abbreviations', () => {
    expect(cuesToLearningSegments([
      { seq: 0, startMs: 0, endMs: 500, text: 'Yes.' },
      { seq: 1, startMs: 500, endMs: 2000, text: 'We met Dr.' },
      { seq: 2, startMs: 2000, endMs: 4000, text: 'Smith yesterday.' },
    ]).map(segment => segment.text)).toEqual(['Yes.', 'We met Dr. Smith yesterday.']);
  });

  it('does not merge across a long silence and bounds unpunctuated ASR', () => {
    const cues = Array.from({ length: 40 }, (_, seq) => ({ seq, startMs: seq * 1000, endMs: seq * 1000 + 1000, text: 'another word' }));
    const segments = cuesToLearningSegments(cues, { allowOverlap: true });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every(segment => segment.endMs - segment.startMs <= 30000)).toBe(true);
    expect(segments.map(segment => segment.text).join(' ')).toBe(cues.map(cue => cue.text).join(' '));
    expect(cuesToLearningSegments([
      { seq: 0, startMs: 0, endMs: 1000, text: 'unfinished' },
      { seq: 1, startMs: 4000, endMs: 5000, text: 'new speaker' },
    ])).toHaveLength(2);
  });
  it('merges short cues and flushes at a sentence boundary', () => {
    const segments = cuesToLearningSegments([
      { seq: 0, startMs: 0, endMs: 900, text: 'This is' },
      { seq: 1, startMs: 900, endMs: 2300, text: 'a sentence.' },
      { seq: 2, startMs: 2400, endMs: 5000, text: 'Another sentence.' },
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.text).toBe('This is a sentence.');
  });

  it('does not merge overlapping cues into one learning segment', () => {
    const segments = cuesToLearningSegments([
      { seq: 0, startMs: 0, endMs: 2_000, text: 'First phrase' },
      { seq: 1, startMs: 1_500, endMs: 3_000, text: 'Second phrase.' },
    ]);
    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.text)).toEqual(['First phrase', 'Second phrase.']);
  });
});
