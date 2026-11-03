import { describe, it, expect, vi } from 'vitest';
import {
  buildShortZh,
  displayPhonetic,
  mergeZhTermsIntoSenses,
  parseEcdictDefinition,
  parseEcdictTranslation,
  selectPhraseCandidates,
  shortZhFromTranslation,
} from '@shadow-language/contracts';
import { lookupDictionary } from './dictionary';
import { lookupOfflineDictionary } from './offline-dictionary';
import { correctSavedDictionaryMeaning } from './dictionary-corrections';

const cache = { get: async () => undefined, put: async () => undefined };

describe('offline dictionary', () => {
  it('corrects Catherine without assigning Catherine wheel meanings to a person', async () => {
    const result = lookupOfflineDictionary('Catherine', 'full', 0)!;
    expect(result.translation).toBe('n. 凯瑟琳（女子名）');
    expect(result.shortZh).toBe('凯瑟琳（女子名）');
    const stale = { ...result, translation: 'n. 轮圈外缘装有倒钩的车轮, 侧翻筋斗, 轮转烟火, 车轮窗', shortZh: '轮圈外缘装有倒钩的车轮，侧翻筋斗' };
    const fresh = await lookupDictionary({ text: 'Catherine', detail: 'full' }, { cache: {
      ...cache, get: async id => ({ id, result: stale, cachedAt: Date.now(), expiresAt: Date.now() + 300000 }),
    } });
    expect(fresh.shortZh).toBe('凯瑟琳（女子名）');
    expect(correctSavedDictionaryMeaning('catherine', stale.shortZh)).toBe('凯瑟琳（女子名）');
    expect(correctSavedDictionaryMeaning('catherine', '凯瑟琳，我的同事')).toBe('凯瑟琳，我的同事');
    expect(correctSavedDictionaryMeaning('catherine wheel', stale.shortZh)).toBe(stale.shortZh);
  });
  it('returns garage immediately without any network, even with an old failed cache', async () => {
    const fetchImpl = vi.fn(() => { throw new Error('offline'); });
    const old = { ...lookupOfflineDictionary('garage', 'hover', Date.now())!, status: 'unavailable' as const };
    const result = await lookupDictionary({ text: 'garage' }, { fetchImpl, cache: { ...cache, get: async id => ({ id, result: old, cachedAt: Date.now(), expiresAt: Date.now() + 300000 }) } });
    expect(result.translation).toContain('车库');
    expect(result.shortZh).toBeTruthy();
    expect(result.status).toBe('found');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps Chinese definitions when full online enrichment fails and skips MyMemory', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    const result = await lookupDictionary({ text: 'garage', detail: 'full' }, { fetchImpl, cache });
    expect(result.translation).toContain('车库');
    expect(result.shortZh).toContain('车库');
    expect(result.shortZh!.length).toBeLessThanOrEqual(25);
    expect(result.senses.length).toBeGreaterThan(0);
    expect(result.senses[0]?.partOfSpeech).toBeTruthy();
    expect(result.sources.translation).toBe('ECDICT');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('handles capitalization and plural forms', () => {
    expect(lookupOfflineDictionary('GARAGES', 'hover', 0)?.translation).toContain('车库');
  });

  it('parses piece into structured senses and short Chinese meaning', () => {
    const result = lookupOfflineDictionary('piece', 'full', 0);
    expect(result?.shortZh).toBe('块，片');
    expect(result?.zhSenses?.map((sense) => sense.partOfSpeech)).toEqual(['n.', 'vt.', 'vi.']);
    expect(result?.senses.every((sense) => sense.partOfSpeech)).toBe(true);
    expect(result?.senses[0]?.zhTerms?.[0]).toBe('块');
  });
});

describe('ECDICT structured parsing', () => {
  it('splits multi-POS translation into zh senses', () => {
    const senses = parseEcdictTranslation('n. 块, 片, 篇\nvt. 修补, 修理\nvi. 吃零食');
    expect(senses).toEqual([
      { partOfSpeech: 'n.', terms: ['块', '片', '篇'] },
      { partOfSpeech: 'vt.', terms: ['修补', '修理'] },
      { partOfSpeech: 'vi.', terms: ['吃零食'] },
    ]);
    expect(buildShortZh(senses)).toBe('块，片');
    expect(buildShortZh(senses, { maxGroups: 2, maxTermsPerGroup: 1 })).toBe('块；修补');
  });

  it('strips POS prefix from ECDICT English definitions', () => {
    expect(parseEcdictDefinition('n. a separate part of a whole')).toEqual({
      partOfSpeech: 'n.',
      text: 'a separate part of a whole',
    });
    expect(parseEcdictDefinition('n. an item that is an instance of some type; ')).toEqual({
      partOfSpeech: 'n.',
      text: 'an item that is an instance of some type',
    });
  });

  it('merges Chinese terms into English senses by POS', () => {
    const zhSenses = parseEcdictTranslation('n. 车库\nvt. 修车');
    const merged = mergeZhTermsIntoSenses(
      [
        { partOfSpeech: 'n.', definition: 'a building for a car' },
        { partOfSpeech: 'vt.', definition: 'to repair' },
      ],
      zhSenses,
    );
    expect(merged[0]?.zhTerms).toEqual(['车库']);
    expect(merged[1]?.zhTerms).toEqual(['修车']);
  });

  it('falls back to a short slice when translation has no POS lines', () => {
    expect(shortZhFromTranslation('你好世界，这是一句较长的翻译')).toBe('你好世界，这是一句较长的翻译');
    expect(shortZhFromTranslation('a'.repeat(80))!.length).toBeLessThanOrEqual(41);
  });

  it('formats phonetics for display', () => {
    expect(displayPhonetic('pi:s')).toBe('/pi:s/');
    expect(displayPhonetic('/piːs/')).toBe('/piːs/');
    expect(displayPhonetic('piːs')).toBe('/piːs/');
    expect(displayPhonetic(null)).toBeNull();
  });

  it('selects phrase candidates that contain the clicked word', () => {
    const candidates = selectPhraseCandidates('and piece by piece I understood', 1, 'piece');
    expect(candidates).toContain('piece by piece');
    expect(candidates.every((item) => item.split(' ').includes('piece'))).toBe(true);
    expect(selectPhraseCandidates('hello world', 0, 'hello')).toEqual(['hello world']);
    expect(selectPhraseCandidates('hello world', undefined, 'hello')).toEqual([]);
  });
});
