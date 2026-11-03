import type { CaptionCue } from '@shadow-language/contracts';

export function validateCues(source: unknown[]): CaptionCue[] {
  if (!source.length || source.length > 20000) throw new Error('字幕为空或超过 20,000 句。');
  return source.map((value, seq) => {
    const cue = value as CaptionCue;
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < 0 || cue.endMs <= cue.startMs || typeof cue.text !== 'string' || !cue.text.trim()) throw new Error(`第 ${seq + 1} 句的时间或文字无效。`);
    if (cue.wordTimings !== undefined && (!Array.isArray(cue.wordTimings) || cue.wordTimings.length > 500)) throw new Error(`第 ${seq + 1} 句的逐词时间数据无效。`);
    const wordTimings = cue.wordTimings?.map(word => {
      if (typeof word.text !== 'string' || !word.text.trim() || !Number.isInteger(word.startMs) || !Number.isInteger(word.endMs) || word.startMs < 0 || word.endMs <= word.startMs) {
        throw new Error(`第 ${seq + 1} 句的逐词时间数据无效。`);
      }
      return { ...word, text: word.text.trim() };
    });
    return { seq, startMs: cue.startMs, endMs: cue.endMs, text: cue.text.trim(), ...(wordTimings?.length ? { wordTimings } : {}) };
  }).sort((a, b) => a.startMs - b.startMs).map((cue, seq) => ({ ...cue, seq }));
}
