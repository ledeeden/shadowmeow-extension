import { lookupOfflineDictionary } from './offline-dictionary';
import type {
  DictionaryAudioResult,
  DictionaryDetail,
  DictionaryExample,
  DictionaryPhrase,
  DictionaryResult,
  DictionarySense,
} from '@shadow-language/contracts';
import {
  buildShortZh,
  dictionaryDetailCacheKey,
  mergeZhTermsIntoSenses,
  normalizeDictionaryQuery,
  parseEcdictTranslation,
  shortZhFromTranslation,
} from '@shadow-language/contracts';
import { db, type DictionaryAudioCache, type DictionaryCache } from './db';

const FREE_DICTIONARY_ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';
const HOVER_REQUEST_TIMEOUT_MS = 1_800;
const FULL_REQUEST_TIMEOUT_MS = 4_500;
const AUDIO_REQUEST_TIMEOUT_MS = 3_500;
const FOUND_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FULL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UNAVAILABLE_CACHE_TTL_MS = 10 * 1000;
const MAX_PREFETCH_QUERIES = 80;
const PREFETCH_CONCURRENCY = 4;
const AUDIO_CACHE_VERSION = 2;

type FetchResult = {
  available: boolean;
  body: unknown | null;
};

type ParsedDefinitions = {
  lemma: string | null;
  phonetic: string | null;
  audioUrl: string | null;
  senses: DictionarySense[];
  examples: DictionaryExample[];
  relatedWords: string[];
  etymology: string | null;
};

export type DictionaryCacheAdapter = {
  get: (id: string) => Promise<DictionaryCache | undefined>;
  put: (record: DictionaryCache) => Promise<unknown>;
};

export type DictionaryAudioCacheAdapter = {
  get: (id: string) => Promise<DictionaryAudioCache | undefined>;
  put: (record: DictionaryAudioCache) => Promise<unknown>;
};

export type DictionaryLookupDependencies = {
  fetchImpl?: typeof fetch;
  cache?: DictionaryCacheAdapter;
  audioCache?: DictionaryAudioCacheAdapter;
  now?: () => number;
};

const defaultCache: DictionaryCacheAdapter = {
  get: (id) => db.dictionary.get(id),
  put: (record) => db.dictionary.put(record),
};

const defaultAudioCache: DictionaryAudioCacheAdapter = {
  get: (id) => db.dictionaryAudio.get(id),
  put: (record) => db.dictionaryAudio.put(record),
};

const lookupInFlight = new Map<string, Promise<DictionaryResult>>();
const audioInFlight = new Map<string, Promise<DictionaryAudioResult>>();

async function fetchJson(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 404) return { available: true, body: null };
    if (!response.ok) return { available: false, body: null };
    return { available: true, body: await response.json() };
  } catch {
    return { available: false, body: null };
  } finally {
    clearTimeout(timeout);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(stringValue).filter((item): item is string => Boolean(item)))].slice(0, limit);
}

function audioUrlValue(value: unknown): string | null {
  const candidate = stringValue(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function pronunciationLocaleScore(audioUrl: string): number {
  const normalized = audioUrl.toLowerCase();
  if (/(?:^|[\/_ .-])(?:en[-_]?us|us)(?:[\/_ .-]|$)/.test(normalized)) return 2;
  if (/(?:^|[\/_ .-])(?:en[-_]?(?:gb|uk)|gb|uk)(?:[\/_ .-]|$)/.test(normalized)) return 0;
  return 1;
}

function audioCacheKey(query: string): string {
  return `en:us:v${AUDIO_CACHE_VERSION}:${query}`;
}

function parseDefinitions(body: unknown, detail: DictionaryDetail = 'full'): ParsedDefinitions {
  if (!Array.isArray(body)) {
    return { lemma: null, phonetic: null, audioUrl: null, senses: [], examples: [], relatedWords: [], etymology: null };
  }

  const entries = body.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  const first = entries[0];
  const pronunciationCandidates = entries.flatMap((entry, entryIndex) => (
    Array.isArray(entry.phonetics) ? entry.phonetics : []
  ).map((item, phoneticIndex) => {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const audioUrl = audioUrlValue(record.audio);
    return audioUrl ? {
      audioUrl,
      text: stringValue(record.text),
      entryIndex,
      phoneticIndex,
    } : null;
  }).filter((item): item is { audioUrl: string; text: string | null; entryIndex: number; phoneticIndex: number } => Boolean(item)));
  const selectedPronunciation = [...pronunciationCandidates].sort((left, right) => (
    pronunciationLocaleScore(right.audioUrl) - pronunciationLocaleScore(left.audioUrl)
      || left.entryIndex - right.entryIndex
      || left.phoneticIndex - right.phoneticIndex
  ))[0];
  const firstEntryPhonetic = entries.reduce<string | null>((found, entry) => found || stringValue(entry.phonetic), null);
  const phonetic = selectedPronunciation?.text || firstEntryPhonetic || pronunciationCandidates[0]?.text || null;
  const audioUrl = selectedPronunciation?.audioUrl || null;
  const senses: DictionarySense[] = [];
  const examples: DictionaryExample[] = [];
  const relatedWords = new Set<string>();
  let etymology: string | null = null;
  const senseLimit = detail === 'hover' ? 2 : 12;
  const exampleLimit = detail === 'hover' ? 2 : 16;
  const relatedLimit = detail === 'hover' ? 6 : 16;

  for (const entry of entries) {
    etymology ||= stringValue(entry.origin);
    const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
    for (const meaning of meanings) {
      if (!meaning || typeof meaning !== 'object') continue;
      const meaningRecord = meaning as Record<string, unknown>;
      const partOfSpeech = stringValue(meaningRecord.partOfSpeech);
      const meaningSynonyms = stringList(meaningRecord.synonyms, 6);
      const meaningAntonyms = stringList(meaningRecord.antonyms, 6);
      for (const word of [...meaningSynonyms, ...meaningAntonyms]) relatedWords.add(word);
      const definitions = Array.isArray(meaningRecord.definitions) ? meaningRecord.definitions : [];
      for (const definition of definitions) {
        if (!definition || typeof definition !== 'object') continue;
        const definitionRecord = definition as Record<string, unknown>;
        const text = stringValue(definitionRecord.definition);
        if (!text) continue;
        const example = stringValue(definitionRecord.example);
        const synonyms = [...new Set([...meaningSynonyms, ...stringList(definitionRecord.synonyms, 6)])].slice(0, 6);
        const antonyms = [...new Set([...meaningAntonyms, ...stringList(definitionRecord.antonyms, 6)])].slice(0, 6);
        senses.push({
          partOfSpeech,
          definition: text,
          ...(example ? { example } : {}),
          ...(detail === 'full' && synonyms.length ? { synonyms } : {}),
          ...(detail === 'full' && antonyms.length ? { antonyms } : {}),
        });
        if (example && examples.length < exampleLimit && !examples.some((item) => item.text === example)) examples.push({ text: example });
        if (senses.length >= senseLimit) break;
      }
      if (senses.length >= senseLimit) break;
    }
    if (senses.length >= senseLimit) break;
  }

  return {
    lemma: stringValue(first?.word),
    phonetic,
    audioUrl,
    senses,
    examples,
    relatedWords: [...relatedWords].slice(0, relatedLimit),
    etymology,
  };
}

function parseTranslation(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (record.responseStatus !== undefined && Number(record.responseStatus) !== 200) return null;
  const responseData = record.responseData;
  if (!responseData || typeof responseData !== 'object') return null;
  const translated = stringValue((responseData as Record<string, unknown>).translatedText);
  return translated?.replace(/<[^>]+>/g, '').trim() || null;
}

function validQuery(query: string): boolean {
  return query.length > 0 && query.length <= 120 && /^[A-Za-z][A-Za-z' -]*$/.test(query);
}

function isSingleWord(query: string): boolean {
  return !/\s/.test(query);
}

function resultWithContext(result: DictionaryResult, contextText?: string): DictionaryResult {
  const context = typeof contextText === 'string' ? contextText.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  return context ? { ...result, contextText: context } : result;
}

function withStructuredZh(value: DictionaryResult): DictionaryResult {
  const zhSenses = value.zhSenses?.length ? value.zhSenses : parseEcdictTranslation(value.translation);
  if (!zhSenses.length && !value.translation) return value;
  const shortZh = value.shortZh || (zhSenses.length ? buildShortZh(zhSenses) : shortZhFromTranslation(value.translation));
  const structuredZhSenses = zhSenses.length ? zhSenses : [{ partOfSpeech: null, terms: [value.translation!] }];
  return {
    ...value,
    shortZh: shortZh || null,
    zhSenses: structuredZhSenses,
    senses: mergeZhTermsIntoSenses(value.senses || [], zhSenses),
  };
}

function normalizedCachedResult(value: DictionaryResult, fallbackDetail: DictionaryDetail): DictionaryResult {
  return withStructuredZh({
    ...value,
    detail: value.detail || fallbackDetail,
    audioUrl: value.audioUrl || null,
    examples: value.examples || [],
    phrases: value.phrases || [],
    relatedWords: value.relatedWords || [],
    etymology: value.etymology || null,
  });
}

function toHoverResult(result: DictionaryResult): DictionaryResult {
  if (result.detail === 'hover') return result;
  return {
    ...result,
    detail: 'hover',
    senses: result.senses.slice(0, 2),
    examples: result.examples.slice(0, 2),
    phrases: result.phrases.slice(0, 4),
    relatedWords: result.relatedWords.slice(0, 6),
  };
}

async function readFreshCache(
  cache: DictionaryCacheAdapter,
  query: string,
  sourceLanguage: string,
  targetLanguage: string,
  detail: DictionaryDetail,
  timestamp: number,
): Promise<DictionaryResult | null> {
  const ids = [dictionaryDetailCacheKey(query, sourceLanguage, targetLanguage, detail)];
  if (detail === 'hover') {
    ids.push(dictionaryDetailCacheKey(query, sourceLanguage, targetLanguage, 'full'));
    // Read the pre-detail cache format once so existing installations do not
    // lose their warm dictionary entries after the schema upgrade.
    ids.push(`${sourceLanguage}:${targetLanguage}:${query.toLowerCase()}`);
  }
  for (const id of ids) {
    try {
      const record = await cache.get(id);
      if (!record || record.expiresAt <= timestamp || record.result.status !== 'found') continue;
      const result = normalizedCachedResult(record.result, id.includes(':full:') ? 'full' : detail);
      return detail === 'hover' ? toHoverResult(result) : result;
    } catch {
      // A cache failure should not make the dictionary unavailable.
    }
  }
  return null;
}

async function fetchAndCacheDictionary(
  query: string,
  sourceLanguage: string,
  targetLanguage: string,
  detail: DictionaryDetail,
  dependencies: DictionaryLookupDependencies,
): Promise<DictionaryResult> {
  const now = dependencies.now || Date.now;
  const timestamp = now();
  const cachedAt = new Date(timestamp).toISOString();
  const fetchImpl = dependencies.fetchImpl || fetch;
  const timeoutMs = detail === 'hover' ? HOVER_REQUEST_TIMEOUT_MS : FULL_REQUEST_TIMEOUT_MS;
  const offline = lookupOfflineDictionary(query, detail, timestamp);
  const definitionPromise = isSingleWord(query)
    ? fetchJson(`${FREE_DICTIONARY_ENDPOINT}${encodeURIComponent(query)}`, fetchImpl, timeoutMs)
    : Promise.resolve<FetchResult>({ available: true, body: null });
  const translationUrl = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(query)}&langpair=${sourceLanguage}|${targetLanguage}`;
  const [definitionResponse, translationResponse] = await Promise.all([
    definitionPromise,
    offline ? Promise.resolve<FetchResult>({ available: true, body: null }) : fetchJson(translationUrl, fetchImpl, timeoutMs),
  ]);
  const definitions = parseDefinitions(definitionResponse.body, detail);
  const translation = offline?.translation || parseTranslation(translationResponse.body);
  const zhSenses = offline
    ? offline.zhSenses?.length ? offline.zhSenses : parseEcdictTranslation(offline.translation)
    : translation ? [{ partOfSpeech: null, terms: [translation] }] : [];
  const shortZh = offline?.shortZh || (zhSenses.length ? buildShortZh(zhSenses) : shortZhFromTranslation(translation));
  const onlineSenses = definitions.senses.length
    ? mergeZhTermsIntoSenses(definitions.senses, zhSenses)
    : offline?.senses || [];
  const hasDefinitions = Boolean(onlineSenses.length || definitions.phonetic || definitions.audioUrl || definitions.etymology);
  const status: DictionaryResult['status'] = hasDefinitions || translation
    ? 'found'
    : definitionResponse.available && translationResponse.available ? 'not_found' : 'unavailable';
  const phrases: DictionaryPhrase[] = !isSingleWord(query) && translation ? [{ text: query, translation }] : [];
  const result: DictionaryResult = {
    query,
    lemma: offline?.lemma || definitions.lemma || query.toLowerCase(),
    detail,
    translation,
    shortZh: shortZh || null,
    zhSenses,
    phonetic: definitions.phonetic || offline?.phonetic || null,
    audioUrl: definitions.audioUrl,
    senses: onlineSenses,
    examples: definitions.examples,
    phrases,
    relatedWords: definitions.relatedWords,
    etymology: definitions.etymology,
    status,
    sources: {
      ...(hasDefinitions ? { definitions: definitions.senses.length ? 'Free Dictionary API' : 'ECDICT' } : {}),
      ...(translation ? { translation: offline ? 'ECDICT' : 'MyMemory' } : {}),
      ...(definitions.audioUrl ? { audio: 'Free Dictionary API' } : {}),
    },
    cachedAt,
  };
  const cache = dependencies.cache || defaultCache;
  const ttl = status === 'found' ? (detail === 'full' ? FULL_CACHE_TTL_MS : FOUND_CACHE_TTL_MS) : status === 'not_found' ? MISS_CACHE_TTL_MS : UNAVAILABLE_CACHE_TTL_MS;
  try {
    await cache.put({ id: dictionaryDetailCacheKey(query, sourceLanguage, targetLanguage, detail), result, cachedAt: timestamp, expiresAt: timestamp + ttl });
  } catch {
    // The result is still useful when IndexedDB is temporarily unavailable.
  }
  return result;
}

export async function lookupDictionary(
  input: { text: string; contextText?: string; sourceLanguage?: 'en'; targetLanguage?: 'zh-CN'; detail?: DictionaryDetail },
  dependencies: DictionaryLookupDependencies = {},
): Promise<DictionaryResult> {
  const now = dependencies.now || Date.now;
  const rawText = typeof input?.text === 'string' ? input.text : '';
  const query = normalizeDictionaryQuery(rawText);
  const detail: DictionaryDetail = input?.detail === 'full' ? 'full' : 'hover';
  const cachedAt = new Date(now()).toISOString();
  const emptyResult = (status: DictionaryResult['status']): DictionaryResult => ({
    query,
    lemma: query.toLowerCase(),
    detail,
    translation: null,
    phonetic: null,
    audioUrl: null,
    senses: [],
    examples: [],
    phrases: [],
    relatedWords: [],
    etymology: null,
    status,
    sources: {},
    cachedAt,
  });

  if (!validQuery(query)) return resultWithContext(emptyResult('not_found'), input?.contextText);

  const sourceLanguage = input?.sourceLanguage || 'en';
  const targetLanguage = input?.targetLanguage || 'zh-CN';
  const cache = dependencies.cache || defaultCache;
  const timestamp = now();
  const key = dictionaryDetailCacheKey(query, sourceLanguage, targetLanguage, detail);
  const cached = await readFreshCache(cache, query, sourceLanguage, targetLanguage, detail, timestamp);
  const offline = lookupOfflineDictionary(query, detail, timestamp);
  if (detail === 'hover' && offline) return resultWithContext(offline, input?.contextText);
  if (cached) {
    const merged = offline
      ? withStructuredZh({
          ...cached,
          translation: offline.translation,
          ...(offline.shortZh || cached.shortZh ? { shortZh: offline.shortZh || cached.shortZh || null } : {}),
          ...(offline.zhSenses?.length || cached.zhSenses ? { zhSenses: offline.zhSenses?.length ? offline.zhSenses : cached.zhSenses } : {}),
          sources: { ...cached.sources, translation: 'ECDICT' },
        })
      : cached;
    return resultWithContext(merged, input?.contextText);
  }

  let request = lookupInFlight.get(key);
  if (!request) {
    request = fetchAndCacheDictionary(query, sourceLanguage, targetLanguage, detail, dependencies);
    lookupInFlight.set(key, request);
  }
  try {
    return resultWithContext(await request, input?.contextText);
  } finally {
    if (lookupInFlight.get(key) === request) lookupInFlight.delete(key);
  }
}

async function fetchAudioAndCache(
  query: string,
  dependencies: DictionaryLookupDependencies,
): Promise<DictionaryAudioResult> {
  const now = dependencies.now || Date.now;
  const timestamp = now();
  const cachedAt = new Date(timestamp).toISOString();
  const fetchImpl = dependencies.fetchImpl || fetch;
  const response = await fetchJson(`${FREE_DICTIONARY_ENDPOINT}${encodeURIComponent(query)}`, fetchImpl, AUDIO_REQUEST_TIMEOUT_MS);
  const audioUrl = parseDefinitions(response.body, 'hover').audioUrl;
  const status: DictionaryAudioResult['status'] = audioUrl ? 'found' : response.available ? 'not_found' : 'unavailable';
  const result: DictionaryAudioResult = { text: query, audioUrl, status, cachedAt };
  const cache = dependencies.audioCache || defaultAudioCache;
  const ttl = status === 'found' ? FULL_CACHE_TTL_MS : status === 'not_found' ? MISS_CACHE_TTL_MS : UNAVAILABLE_CACHE_TTL_MS;
  try {
    await cache.put({ id: audioCacheKey(query), result, cachedAt: timestamp, expiresAt: timestamp + ttl });
  } catch {
    // Audio fallback in the page remains available if IndexedDB cannot be written.
  }
  return result;
}

export async function getDictionaryAudio(
  input: { text: string },
  dependencies: DictionaryLookupDependencies = {},
): Promise<DictionaryAudioResult> {
  const query = normalizeDictionaryQuery(typeof input?.text === 'string' ? input.text : '').toLowerCase();
  const emptyResult = (status: DictionaryAudioResult['status']): DictionaryAudioResult => ({ text: query, audioUrl: null, status, cachedAt: new Date((dependencies.now || Date.now)()).toISOString() });
  if (!validQuery(query) || !isSingleWord(query)) return emptyResult('not_found');
  const now = dependencies.now || Date.now;
  const timestamp = now();
  const cache = dependencies.audioCache || defaultAudioCache;
  try {
    const record = await cache.get(audioCacheKey(query));
    if (record && record.expiresAt > timestamp) return record.result;
  } catch {
    // Continue to the provider when the cache is unavailable.
  }

  let request = audioInFlight.get(query);
  if (!request) {
    request = fetchAudioAndCache(query, dependencies);
    audioInFlight.set(query, request);
  }
  try {
    return await request;
  } finally {
    if (audioInFlight.get(query) === request) audioInFlight.delete(query);
  }
}

export type DictionaryPrefetchResponse = {
  results: DictionaryResult[];
  requested: number;
  completed: number;
};

export async function prefetchDictionary(input: { texts?: string[]; phrases?: string[] }, dependencies: DictionaryLookupDependencies = {}): Promise<DictionaryPrefetchResponse> {
  const values = [
    ...(Array.isArray(input?.texts) ? input.texts : []),
    ...(Array.isArray(input?.phrases) ? input.phrases : []),
  ];
  const queries = [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizeDictionaryQuery(value).toLowerCase())
    .filter(validQuery))].slice(0, MAX_PREFETCH_QUERIES);
  const results: DictionaryResult[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queries.length) {
      const index = cursor;
      cursor += 1;
      const query = queries[index];
      if (!query) continue;
      results.push(await lookupDictionary({ text: query, detail: 'hover' }, dependencies));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queries.length) }, () => worker()));
  return { results, requested: queries.length, completed: results.length };
}

export const dictionaryProviderEndpoints = {
  definitions: FREE_DICTIONARY_ENDPOINT,
  translation: MYMEMORY_ENDPOINT,
  audio: FREE_DICTIONARY_ENDPOINT,
};
