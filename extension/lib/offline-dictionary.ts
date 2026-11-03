import rawData from './offline-dictionary-data.json';
import { correctedDictionaryTranslation } from './dictionary-corrections';
import {
  buildShortZh,
  parseEcdictDefinition,
  parseEcdictTranslation,
  type DictionaryDetail,
  type DictionaryResult,
  type DictionarySense,
} from '@shadow-language/contracts';

const data = rawData as Record<string, string[]>;
const aliases = new Map<string, string>();
for (const [lemma, entry] of Object.entries(data)) {
  for (const exchange of (entry[3] || '').split('/')) {
    const [kind, form] = exchange.split(':');
    if (kind && kind !== '0' && kind !== '1' && form && !data[form] && !aliases.has(form)) aliases.set(form, lemma);
  }
}

function parseOfflineSenses(definitionText: string, detail: DictionaryDetail, zhSenses: ReturnType<typeof parseEcdictTranslation>): DictionarySense[] {
  const limit = detail === 'hover' ? 2 : 12;
  const parsed = definitionText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((definition) => parseEcdictDefinition(definition));

  const senses: DictionarySense[] = [];
  for (const { partOfSpeech, text } of parsed) {
    if (!text) continue;
    const zh = zhSenses.find((item) => (item.partOfSpeech || null) === (partOfSpeech || null))
      || (partOfSpeech ? undefined : zhSenses.find((item) => !item.partOfSpeech));
    senses.push({
      partOfSpeech,
      definition: text,
      ...(zh?.terms.length ? { zhTerms: zh.terms } : {}),
    });
    if (senses.length >= limit) break;
  }
  return senses;
}

export function lookupOfflineDictionary(query: string, detail: DictionaryDetail, timestamp: number): DictionaryResult | null {
  const normalized = query.toLowerCase();
  const lemma = data[normalized] ? normalized : aliases.get(normalized);
  const entry = lemma ? data[lemma] : undefined;
  if (!entry || !lemma) return null;

  const translation = correctedDictionaryTranslation(lemma) || entry[1] || null;
  const zhSenses = parseEcdictTranslation(translation);
  const shortZh = zhSenses.length ? buildShortZh(zhSenses) : null;

  return {
    query,
    lemma,
    detail,
    translation,
    shortZh,
    zhSenses,
    phonetic: entry[0] || null,
    senses: parseOfflineSenses(entry[2] || '', detail, zhSenses),
    audioUrl: null,
    examples: [],
    phrases: [],
    relatedWords: [],
    etymology: null,
    status: 'found',
    sources: { translation: 'ECDICT', definitions: 'ECDICT' },
    cachedAt: new Date(timestamp).toISOString(),
  };
}
