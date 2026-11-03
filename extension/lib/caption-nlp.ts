import winkNLP, { type ItemToken, type ItsFunction } from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import { validCaptionNlp, type CaptionNlpResult, type CaptionNlpToken } from '@shadow-language/contracts';

export const CAPTION_NLP_ENGINE = 'wink-nlp/2.4.0:eng-lite-web/1.8.1:adapter/1';
const cache = new Map<string, CaptionNlpResult>();
let pipeline: ReturnType<typeof winkNLP> | undefined;
const excluded = new Set(['PUNCT', 'SPACE', 'WS', 'SYM', 'NUM', 'PROPN', 'X']);

export function analyzeCaption(text: string): CaptionNlpResult {
  if (typeof text !== 'string' || text.length > 4000) throw new Error('Caption NLP text exceeds 4000 characters');
  const cached = cache.get(text);
  if (cached) { cache.delete(text); cache.set(text, cached); return cached; }
  const nlp = pipeline ??= winkNLP(model, ['sbd', 'pos']);
  const tokens: CaptionNlpToken[] = [];
  let cursor = 0;
  const append = (start: number, end: number, normalized: string, lemma: string, pos: string) => {
    const lookupText = excluded.has(pos) ? null : [lemma, normalized, text.slice(start, end)]
      .map(value => value.replace(/’/g, "'").toLowerCase())
      .find(value => /^[a-z]+(?:['-][a-z]+)*$/.test(value)) || null;
    tokens.push({ index: tokens.length, start, end, text: text.slice(start, end), normalized, lemma, pos, lookupText });
  };
  let result: CaptionNlpResult;
  try {
    nlp.readDoc(text).tokens().each((token: ItemToken) => {
      const value = token.out(nlp.its.value) as string;
      const start = text.indexOf(value, cursor);
      if (start < cursor || !value || /\S/.test(text.slice(cursor, start))) throw new Error('NLP alignment failed');
      if (start > cursor) append(cursor, start, text.slice(cursor, start), '', 'WS');
      const end = start + value.length;
      // The lite model leaves I'm unsplit and tags it PROPN. Correct only this
      // unambiguous contraction; ambiguous 's/'d remain context-tagged by NLP.
      if (/^i['’]m$/i.test(value)) {
        append(start, start + 1, 'i', 'i', 'PRON');
        append(start + 1, end, 'am', 'be', 'AUX');
      // wink 2.4 declares lemma's addon argument differently from ItemToken.out;
      // this is the documented runtime helper, covered with real-model tests.
      } else append(start, end, token.out(nlp.its.normal), token.out(nlp.its.lemma as unknown as ItsFunction<string>), token.out(nlp.its.pos));
      cursor = end;
    });
    if (cursor < text.length) {
      if (/\S/.test(text.slice(cursor))) throw new Error('NLP alignment failed');
      append(cursor, text.length, text.slice(cursor), '', 'WS');
    }
    result = { text, engine: CAPTION_NLP_ENGINE, status: 'ready', tokens };
    if (!validCaptionNlp(result, text)) throw new Error('NLP alignment failed');
  } catch {
    result = { text, engine: CAPTION_NLP_ENGINE, status: 'fallback', tokens: text ? [{ index: 0, start: 0, end: text.length, text, normalized: text, lemma: '', pos: 'X', lookupText: null }] : [] };
  }
  cache.set(text, result);
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  return result;
}

export function analyzeCaptions(texts: string[]): CaptionNlpResult[] {
  if (!Array.isArray(texts) || texts.length > 8 || texts.some(text => typeof text !== 'string' || text.length > 4000)) {
    throw new Error('Caption NLP accepts at most 8 texts of 4000 characters');
  }
  return texts.map(analyzeCaption);
}
