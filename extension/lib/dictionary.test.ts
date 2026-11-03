// Provider contract tests isolate the online fallback from the bundled dictionary.
vi.mock('./offline-dictionary', () => ({ lookupOfflineDictionary: () => null }));
import { describe, expect, it, vi } from 'vitest';
import { getDictionaryAudio, lookupDictionary, prefetchDictionary } from './dictionary';
import { captionPhraseCandidates, centeredCaptionPhraseCandidates, tokenizeCaptionText } from '@shadow-language/contracts';

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('dictionary lookup', () => {
  it('turns subtitle text into selectable words while preserving spaces and punctuation', () => {
    expect(tokenizeCaptionText("I'm ready, aren't you?")).toEqual([
      { kind: 'word', text: "I'm", lookupText: "i'm", key: 'word-0' },
      { kind: 'text', text: ' ', key: 'text-1' },
      { kind: 'word', text: 'ready', lookupText: 'ready', key: 'word-2' },
      { kind: 'text', text: ', ', key: 'text-3' },
      { kind: 'word', text: "aren't", lookupText: "aren't", key: 'word-4' },
      { kind: 'text', text: ' ', key: 'text-5' },
      { kind: 'word', text: 'you', lookupText: 'you', key: 'word-6' },
      { kind: 'text', text: '?', key: 'text-7' },
    ]);
  });

  it('combines English definitions and Chinese translation, then caches the result', async () => {
    const fetchImpl = vi.fn(async (url: string) => url.includes('dictionaryapi.dev')
      ? response([{ word: 'ready', phonetic: '/ˈredi/', meanings: [{ partOfSpeech: 'adjective', definitions: [{ definition: 'prepared for action', example: 'Are you ready?' }] }] }])
      : response({ responseStatus: 200, responseData: { translatedText: '准备好的' } }));
    const records = new Map<string, { id: string; result: Awaited<ReturnType<typeof lookupDictionary>>; cachedAt: number; expiresAt: number }>();
    const cache = {
      get: async (id: string) => records.get(id),
      put: async (record: (typeof records extends Map<string, infer T> ? T : never)) => { records.set(record.id, record); },
    };
    const now = () => Date.parse('2026-09-03T00:00:00.000Z');

    const first = await lookupDictionary({ text: 'ready' }, { fetchImpl: fetchImpl as unknown as typeof fetch, cache, now });
    expect(first).toMatchObject({ status: 'found', lemma: 'ready', translation: '准备好的', phonetic: '/ˈredi/' });
    expect(first.senses[0]).toMatchObject({ partOfSpeech: 'adjective', definition: 'prepared for action', example: 'Are you ready?' });
    expect(first.sources).toEqual({ definitions: 'Free Dictionary API', translation: 'MyMemory' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const second = await lookupDictionary({ text: 'READY' }, { fetchImpl: fetchImpl as unknown as typeof fetch, cache, now });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses translation lookup for phrases without treating a missing dictionary entry as a transport error', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('dictionaryapi.dev')) return response(null, 404);
      return response({ responseStatus: 200, responseData: { translatedText: '小心' } });
    });
    const result = await lookupDictionary({ text: 'be careful' }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cache: { get: async () => undefined, put: async () => undefined },
    });
    expect(result).toMatchObject({ status: 'found', translation: '小心' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('mymemory.translated.net');
  });

  it('creates bounded phrase candidates and selects windows around a hovered word', () => {
    expect(captionPhraseCandidates('make sure your opponent is ready', 3, 3)).toEqual([
      'make sure your',
      'opponent is ready',
      'sure your opponent',
    ]);
    expect(centeredCaptionPhraseCandidates('make sure your opponent is ready', 3, 4)).toEqual([
      'make sure your opponent',
      'sure your opponent is',
      'your opponent is ready',
      'sure your opponent',
      'your opponent is',
      'opponent is ready',
      'your opponent',
      'opponent is',
    ]);
  });

  it('deduplicates concurrent hover requests and keeps full details separate', async () => {
    const fetchImpl = vi.fn(async (url: string) => url.includes('dictionaryapi.dev')
      ? response([{ word: 'swift', phonetic: '/swɪft/', phonetics: [{ audio: 'https://api.dictionaryapi.dev/media/swift.mp3' }], meanings: [{ partOfSpeech: 'adjective', definitions: [{ definition: 'moving quickly', synonyms: ['fast'] }, { definition: 'prompt', antonyms: ['slow'] }] }], origin: 'Old English' }])
      : response({ responseStatus: 200, responseData: { translatedText: '迅速的' } }));
    const records = new Map<string, { id: string; result: Awaited<ReturnType<typeof lookupDictionary>>; cachedAt: number; expiresAt: number }>();
    const cache = {
      get: async (id: string) => records.get(id),
      put: async (record: (typeof records extends Map<string, infer T> ? T : never)) => { records.set(record.id, record); },
    };
    const dependencies = { fetchImpl: fetchImpl as unknown as typeof fetch, cache };
    const [first, second] = await Promise.all([
      lookupDictionary({ text: 'swift' }, dependencies),
      lookupDictionary({ text: 'SWIFT' }, dependencies),
    ]);
    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(first.audioUrl).toBe('https://api.dictionaryapi.dev/media/swift.mp3');
    expect(first.detail).toBe('hover');

    const full = await lookupDictionary({ text: 'swift', detail: 'full' }, dependencies);
    expect(full.detail).toBe('full');
    expect(full.senses[0]?.synonyms).toEqual(['fast']);
    expect(full.etymology).toBe('Old English');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('prefetches unique words and phrases through the same cache-aware lookup path', async () => {
    const fetchImpl = vi.fn(async (url: string) => url.includes('dictionaryapi.dev')
      ? response([{ word: 'learn', meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'gain knowledge' }] }] }])
      : response({ responseStatus: 200, responseData: { translatedText: '学习' } }));
    const records = new Map<string, { id: string; result: Awaited<ReturnType<typeof lookupDictionary>>; cachedAt: number; expiresAt: number }>();
    const cache = {
      get: async (id: string) => records.get(id),
      put: async (record: (typeof records extends Map<string, infer T> ? T : never)) => { records.set(record.id, record); },
    };
    const result = await prefetchDictionary({ texts: ['learn', 'learn'], phrases: ['learn English'] }, { fetchImpl: fetchImpl as unknown as typeof fetch, cache });
    expect(result.requested).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.results.map((item) => item.query).sort()).toEqual(['learn', 'learn english']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('resolves pronunciation audio independently and caches a miss or hit', async () => {
    const fetchImpl = vi.fn(async () => response([{ word: 'audio', phonetics: [{ audio: 'https://api.dictionaryapi.dev/media/audio.mp3' }] }]));
    const records = new Map<string, { id: string; result: Awaited<ReturnType<typeof getDictionaryAudio>>; cachedAt: number; expiresAt: number }>();
    const audioCache = {
      get: async (id: string) => records.get(id),
      put: async (record: (typeof records extends Map<string, infer T> ? T : never)) => { records.set(record.id, record); },
    };
    const first = await getDictionaryAudio({ text: 'audio' }, { fetchImpl: fetchImpl as unknown as typeof fetch, audioCache });
    const second = await getDictionaryAudio({ text: 'AUDIO' }, { fetchImpl: fetchImpl as unknown as typeof fetch, audioCache });
    expect(first).toMatchObject({ status: 'found', audioUrl: 'https://api.dictionaryapi.dev/media/audio.mp3' });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('prefers an en-US pronunciation when the provider returns multiple regional audios', async () => {
    const fetchImpl = vi.fn(async () => response([{
      word: 'read',
      phonetic: '/ɹiːd/',
      phonetics: [
        { text: '/ɹiːd/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/read-1-uk.mp3' },
        { text: '/ɹid/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/read-1-us.ogg' },
      ],
    }]));
    const records = new Map<string, { id: string; result: Awaited<ReturnType<typeof getDictionaryAudio>>; cachedAt: number; expiresAt: number }>();
    const audioCache = {
      get: async (id: string) => records.get(id),
      put: async (record: (typeof records extends Map<string, infer T> ? T : never)) => { records.set(record.id, record); },
    };

    const result = await getDictionaryAudio({ text: 'read' }, { fetchImpl: fetchImpl as unknown as typeof fetch, audioCache });

    expect(result).toMatchObject({
      status: 'found',
      audioUrl: 'https://api.dictionaryapi.dev/media/pronunciations/en/read-1-us.ogg',
    });
    expect(records.has('en:us:v2:read')).toBe(true);
  });
});
