export type DictionaryDetail = 'hover' | 'full';

export type DictionaryZhSense = {
  partOfSpeech: string | null;
  terms: string[];
};

export type DictionarySense = {
  partOfSpeech: string | null;
  definition: string;
  zhTerms?: string[];
  example?: string;
  synonyms?: string[];
  antonyms?: string[];
};

export type DictionaryExample = {
  text: string;
  translation?: string;
};

export type DictionaryPhrase = {
  text: string;
  translation: string | null;
};

export type DictionaryResult = {
  query: string;
  lemma: string;
  detail: DictionaryDetail;
  translation: string | null;
  shortZh?: string | null;
  zhSenses?: DictionaryZhSense[];
  phonetic: string | null;
  audioUrl: string | null;
  senses: DictionarySense[];
  examples: DictionaryExample[];
  phrases: DictionaryPhrase[];
  relatedWords: string[];
  etymology: string | null;
  contextText?: string;
  status: 'found' | 'not_found' | 'unavailable';
  sources: {
    definitions?: string;
    translation?: string;
    audio?: string;
  };
  cachedAt: string;
};

export type DictionaryAudioResult = {
  text: string;
  audioUrl: string | null;
  status: 'found' | 'not_found' | 'unavailable';
  cachedAt: string;
};

export type DictionaryLookupInput = {
  text: string;
  contextText?: string;
  sourceLanguage: 'en';
  targetLanguage: 'zh-CN';
  detail?: DictionaryDetail;
};

export type CaptionTextToken = {
  kind: 'word' | 'text';
  text: string;
  lookupText?: string;
  key: string;
};

const ENGLISH_WORD = /[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*/g;

const POS_ALIASES: Record<string, string> = {
  n: 'n.',
  noun: 'n.',
  vt: 'vt.',
  vi: 'vi.',
  v: 'v.',
  verb: 'v.',
  a: 'adj.',
  adj: 'adj.',
  adjective: 'adj.',
  adv: 'adv.',
  adverb: 'adv.',
  prep: 'prep.',
  conj: 'conj.',
  pron: 'pron.',
  num: 'num.',
  aux: 'aux.',
  int: 'int.',
  interj: 'int.',
  art: 'art.',
  abbr: 'abbr.',
  web: 'web.',
};

const POS_PREFIX = /^([A-Za-z]+)\.\s+/;
const ZH_TERM_SPLIT = /[,，;；、/]/;

export function normalizeDictionaryPos(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/\.$/, '');
  return POS_ALIASES[key] || (key ? `${key}.` : null);
}

export function parseEcdictTranslation(translation: string | null | undefined): DictionaryZhSense[] {
  if (!translation) return [];
  const senses: DictionaryZhSense[] = [];
  for (const rawLine of translation.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(POS_PREFIX);
    const posRaw = match?.[1];
    const partOfSpeech = match && posRaw ? normalizeDictionaryPos(posRaw) : null;
    const body = match ? line.slice(match[0].length) : line;
    const terms = body
      .split(ZH_TERM_SPLIT)
      .map((term) => term.trim())
      .filter(Boolean);
    if (!terms.length) continue;
    const previous = senses[senses.length - 1];
    if (!match && previous && !previous.partOfSpeech) {
      previous.terms.push(...terms);
      continue;
    }
    senses.push({ partOfSpeech, terms });
  }
  return senses;
}

export function parseEcdictDefinition(definition: string): { partOfSpeech: string | null; text: string } {
  const value = definition.trim();
  const match = value.match(POS_PREFIX);
  const posRaw = match?.[1];
  if (!match || !posRaw) return { partOfSpeech: null, text: value };
  return {
    partOfSpeech: normalizeDictionaryPos(posRaw),
    text: value.slice(match[0].length).replace(/;\s*$/, '').trim(),
  };
}

export function buildShortZh(senses: DictionaryZhSense[], options?: { maxGroups?: number; maxTermsPerGroup?: number; maxLength?: number }): string {
  const maxGroups = options?.maxGroups ?? 1;
  const maxTermsPerGroup = options?.maxTermsPerGroup ?? 2;
  const maxLength = options?.maxLength ?? 24;
  const joined = senses
    .slice(0, maxGroups)
    .map((sense) => sense.terms.slice(0, maxTermsPerGroup).join('，'))
    .filter(Boolean)
    .join('；');
  return joined.length > maxLength ? `${joined.slice(0, maxLength)}…` : joined;
}

export function shortZhFromTranslation(translation: string | null | undefined): string | null {
  if (!translation) return null;
  const parsed = parseEcdictTranslation(translation);
  if (parsed.length) return buildShortZh(parsed);
  const firstLine = translation.split(/\n+/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return null;
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

export function mergeZhTermsIntoSenses(senses: DictionarySense[], zhSenses: DictionaryZhSense[]): DictionarySense[] {
  if (!zhSenses.length) return senses;
  return senses.map((sense) => {
    if (sense.zhTerms?.length) return sense;
    const match = zhSenses.find((zh) => (zh.partOfSpeech || null) === (sense.partOfSpeech || null))
      || (sense.partOfSpeech ? undefined : zhSenses.find((zh) => !zh.partOfSpeech));
    return match ? { ...sense, zhTerms: match.terms } : sense;
  });
}

export function displayPhonetic(phonetic: string | null | undefined): string | null {
  const value = phonetic?.trim();
  if (!value) return null;
  if (value.startsWith('/') && value.endsWith('/')) return value;
  if (/[ːəɪʊæɑɔɜʃθðŋɡʧʤ]/.test(value) || value.includes('/')) {
    return value.startsWith('/') ? value : `/${value.replace(/^\/+|\/+$/g, '')}/`;
  }
  return `/${value}/`;
}

export function dedupeDictionarySources(sources: DictionaryResult['sources']): string {
  const values = [sources.definitions, sources.translation, sources.audio].filter(Boolean) as string[];
  return [...new Set(values)].join(' · ');
}

export function normalizeDictionaryQuery(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function normalizeLookupTerm(value: string): string {
  return normalizeDictionaryQuery(value)
    .replace(/^[^A-Za-z]+|[^A-Za-z' -]+$/g, '')
    .trim()
    .toLowerCase();
}

export function dictionaryCacheKey(
  text: string,
  sourceLanguage = 'en',
  targetLanguage = 'zh-CN',
  detail: DictionaryDetail = 'hover',
): string {
  return dictionaryDetailCacheKey(text, sourceLanguage, targetLanguage, detail);
}

export function dictionaryDetailCacheKey(
  text: string,
  sourceLanguage = 'en',
  targetLanguage = 'zh-CN',
  detail: DictionaryDetail = 'hover',
): string {
  return `${sourceLanguage}:${targetLanguage}:${detail}:${normalizeDictionaryQuery(text).toLowerCase()}`;
}

export function tokenizeCaptionText(text: string): CaptionTextToken[] {
  const tokens: CaptionTextToken[] = [];
  let cursor = 0;
  let index = 0;

  for (const match of text.matchAll(ENGLISH_WORD)) {
    const value = match[0];
    const start = match.index ?? cursor;
    if (start > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, start), key: `text-${index++}` });
    tokens.push({ kind: 'word', text: value, lookupText: normalizeLookupTerm(value), key: `word-${index++}` });
    cursor = start + value.length;
  }

  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor), key: `text-${index}` });
  return tokens;
}

function wordTexts(text: string): string[] {
  return tokenizeCaptionText(text)
    .filter((token): token is CaptionTextToken & { kind: 'word'; lookupText: string } => token.kind === 'word' && Boolean(token.lookupText))
    .map((token) => token.lookupText);
}

export function captionDictionaryTerms(text: string): string[] {
  const common = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'she', 'so', 'that', 'the', 'their', 'them', 'there', 'they', 'this', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your']);
  return [...new Set(wordTexts(text).filter((word) => word.length >= 2 && (!common.has(word) || word.length >= 5)))];
}

export function captionPhraseCandidates(text: string, maxWords = 5, maxCandidates = 12): string[] {
  const words = wordTexts(text);
  const candidates = new Set<string>();
  for (let length = 2; length <= Math.min(maxWords, words.length); length += 1) {
    for (let start = 0; start + length <= words.length; start += 1) {
      candidates.add(words.slice(start, start + length).join(' '));
    }
  }
  return [...candidates]
    .sort((left, right) => {
      const lengthDifference = right.split(' ').length - left.split(' ').length;
      return lengthDifference || left.localeCompare(right);
    })
    .slice(0, maxCandidates);
}

export function centeredCaptionPhraseCandidates(text: string, wordIndex: number, maxWords = 5): string[] {
  const words = wordTexts(text);
  if (wordIndex < 0 || wordIndex >= words.length) return [];
  const candidates: string[] = [];
  for (let length = Math.min(maxWords, words.length); length >= 2; length -= 1) {
    for (let start = Math.max(0, wordIndex - length + 1); start <= wordIndex && start + length <= words.length; start += 1) {
      candidates.push(words.slice(start, start + length).join(' '));
    }
  }
  return [...new Set(candidates)];
}

export function selectPhraseCandidates(text: string, wordIndex: number | undefined, query: string, maxCandidates = 3): string[] {
  if (wordIndex === undefined) return [];
  const normalizedQuery = normalizeDictionaryQuery(query).toLowerCase();
  if (!normalizedQuery || /\s/.test(normalizedQuery)) return [];
  return centeredCaptionPhraseCandidates(text, wordIndex, 4)
    .map((candidate) => {
      const words = candidate.split(' ');
      const queryIndex = words.indexOf(normalizedQuery);
      if (queryIndex < 0) return null;
      const length = words.length;
      let score = 0;
      if (length === 2) score += 2;
      else if (length === 3) score += 4;
      else if (length === 4) score += 1;
      if (queryIndex > 0 && queryIndex < length - 1) score += 3;
      if (length === 3 && queryIndex === 0) score += 1;
      return { candidate, score };
    })
    .filter((item): item is { candidate: string; score: number } => Boolean(item))
    .sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate))
    .map((item) => item.candidate)
    .slice(0, maxCandidates);
}
