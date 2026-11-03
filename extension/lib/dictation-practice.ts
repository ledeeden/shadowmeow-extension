import { lookupReaderWord } from './reader-frequency';
import { vocabularyTermKeys } from './vocabulary';
import { isOutsideVocabulary } from './vocabulary-profile';

export type DictationPracticeSettings = {
  showReference: boolean;
  autoAdvance: boolean;
  continueOnError: boolean;
};

export const DEFAULT_DICTATION_PRACTICE_SETTINGS: DictationPracticeSettings = {
  showReference: false,
  autoAdvance: true,
  continueOnError: false,
};

const DICTATION_WORD = /(?:\d{1,3}(?:,\d{3})+(?:st|nd|rd|th)?|[A-Za-z0-9]+)(?:['‘’][A-Za-z0-9]+)*(?:[-\u2010-\u2013](?:\d{1,3}(?:,\d{3})+|[A-Za-z0-9]+)(?:['‘’][A-Za-z0-9]+)*)*/g;
const DICTATION_CHARACTER = /^[A-Za-z0-9'\-]$/;
const OPTIONAL_MARK = /['-]/;
const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const ORDINAL_UNITS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINAL_TENS = ['', '', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];
const NUMBER_STARTS = new Set([...UNITS, ...TENS.slice(2), ...ORDINAL_UNITS, ...ORDINAL_TENS.slice(2)]);
const MAX_NUMBER = 9999;
let numberWordValues: Map<string, string> | null = null;
const spellingCache = new Map<string, string[]>();

function comparable(value: string): string {
  return value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[\u2010-\u2013]/g, '-').replace(/\s+/g, '-').replace(/,/g, '').toLocaleLowerCase('en-US');
}

function requiredCharacters(value: string): string {
  return comparable(value).replace(/['-]/g, '');
}

export function dictationRequiredCharacterCount(value: string): number {
  return requiredCharacters(value).length;
}

function cardinal(number: number): string {
  if (number < 20) return UNITS[number]!;
  if (number < 100) return TENS[Math.floor(number / 10)]! + (number % 10 ? `-${cardinal(number % 10)}` : '');
  if (number < 1000) return `${cardinal(Math.floor(number / 100))}-hundred${number % 100 ? `-${cardinal(number % 100)}` : ''}`;
  return `${cardinal(Math.floor(number / 1000))}-thousand${number % 1000 ? `-${cardinal(number % 1000)}` : ''}`;
}

function ordinal(number: number): string {
  if (number < 20) return ORDINAL_UNITS[number]!;
  if (number < 100) return number % 10 ? `${TENS[Math.floor(number / 10)]!}-${ordinal(number % 10)}` : ORDINAL_TENS[number / 10]!;
  if (number < 1000) return `${cardinal(Math.floor(number / 100))}-hundred${number % 100 ? `-${ordinal(number % 100)}` : 'th'}`;
  return `${cardinal(Math.floor(number / 1000))}-thousand${number % 1000 ? `-${ordinal(number % 1000)}` : 'th'}`;
}

function ordinalSuffix(number: number): string {
  if (number % 100 >= 11 && number % 100 <= 13) return 'th';
  return number % 10 === 1 ? 'st' : number % 10 === 2 ? 'nd' : number % 10 === 3 ? 'rd' : 'th';
}

function spokenNumberVariants(number: number, isOrdinal: boolean): string[] {
  const base = isOrdinal ? ordinal(number) : cardinal(number);
  const variants = [base];
  // Both "one hundred one" and "one hundred and one" are common.
  const lowerHundreds = number % 100;
  if (number >= 100 && lowerHundreds > 0) {
    const prefix = cardinal(number - lowerHundreds);
    variants.push(`${prefix}-and-${isOrdinal ? ordinal(lowerHundreds) : cardinal(lowerHundreds)}`);
  }
  if (!isOrdinal && number >= 1100 && number <= 2099) {
    const hundreds = Math.floor(number / 100);
    const remainder = number % 100;
    variants.push(remainder === 0 ? `${cardinal(hundreds)}-hundred` : `${cardinal(hundreds)}-${remainder < 10 ? 'oh-' : ''}${cardinal(remainder)}`);
  }
  return variants;
}

function numberWords(): Map<string, string> {
  if (numberWordValues) return numberWordValues;
  const values = new Map<string, string>();
  for (let number = 0; number <= MAX_NUMBER; number += 1) {
    for (const spelling of spokenNumberVariants(number, false)) values.set(spelling, String(number));
    for (const spelling of spokenNumberVariants(number, true)) values.set(spelling, `${number}${ordinalSuffix(number)}`);
  }
  numberWordValues = values;
  return values;
}

function acceptedSpellings(target: string): string[] {
  const normalized = comparable(target);
  const cached = spellingCache.get(normalized);
  if (cached) return cached;
  const spellings = [normalized];
  const numeric = /^(0|[1-9]\d{0,3})(st|nd|rd|th)?(?=-|$)/.exec(normalized);
  if (numeric) {
    const number = Number(numeric[1]);
    const suffix = numeric[2];
    if (number <= MAX_NUMBER && (!suffix || suffix === ordinalSuffix(number))) {
      const tail = normalized.slice(numeric[0].length);
      spellings.push(...spokenNumberVariants(number, Boolean(suffix)).map(spelling => spelling + tail));
    }
  } else if (NUMBER_STARTS.has(normalized.split('-')[0]!)) {
    const parts = normalized.split('-');
    for (let end = parts.length; end > 0; end -= 1) {
      const numericValue = numberWords().get(parts.slice(0, end).join('-'));
      if (numericValue !== undefined) {
        spellings.push(numericValue + (end < parts.length ? `-${parts.slice(end).join('-')}` : ''));
        break;
      }
    }
  }
  const unique = [...new Set(spellings)];
  spellingCache.set(normalized, unique);
  return unique;
}

export function dictationWords(text: string): string[] {
  const normalized = text.normalize('NFKC');
  const matches = [...normalized.matchAll(DICTATION_WORD)];
  const words: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index]!;
    let end = index;
    if (NUMBER_STARTS.has(comparable(current[0]).split('-')[0]!)) {
      // Keep spoken multiword numbers in one slot so "twenty one" can accept 21.
      for (let candidate = index + 1; candidate < Math.min(matches.length, index + 7); candidate += 1) {
        const between = normalized.slice(matches[candidate - 1]!.index! + matches[candidate - 1]![0].length, matches[candidate]!.index!);
        if (!/^\s+$/.test(between)) break;
        const phrase = normalized.slice(current.index!, matches[candidate]!.index! + matches[candidate]![0].length);
        if (numberWords().has(comparable(phrase))) end = candidate;
      }
    }
    words.push(normalized.slice(current.index!, matches[end]!.index! + matches[end]![0].length));
    index = end;
  }
  return words;
}

export function isDictationCharacter(key: string): boolean {
  return DICTATION_CHARACTER.test(key);
}

export type DictationCharacterResult =
  | { status: 'accepted'; value: string; complete: boolean; correct: boolean }
  | { status: 'rejected'; value: string; complete: false };

function matchesPrefix(expected: string, draft: string): boolean {
  const typed = comparable(draft);
  let position = 0;
  for (const character of typed) {
    while (position < expected.length && OPTIONAL_MARK.test(expected[position]!) && expected[position] !== character) position += 1;
    if (expected[position] !== character) return false;
    position += 1;
  }
  return true;
}

export function isDictationDraftCorrectPrefix(target: string, draft: string): boolean {
  return acceptedSpellings(target).some(spelling => matchesPrefix(spelling, draft));
}

export function isDictationDraftCorrect(target: string, draft: string): boolean {
  const count = dictationRequiredCharacterCount(draft);
  return acceptedSpellings(target).some(spelling => dictationRequiredCharacterCount(spelling) === count && matchesPrefix(spelling, draft));
}

export function isDictationDraftComplete(target: string, draft: string): boolean {
  if (isDictationDraftCorrect(target, draft)) return true;
  if (isDictationDraftCorrectPrefix(target, draft)) return false;
  // In "continue on error" mode, use the length of the chosen digit/word form.
  const typed = requiredCharacters(draft);
  const first = typed[0];
  if (!first) return false;
  const sameForm = acceptedSpellings(target).filter(spelling => /\d/.test(requiredCharacters(spelling)[0]!) === /\d/.test(first));
  const candidates = sameForm.length ? sameForm : acceptedSpellings(target);
  let chosenLength = 0;
  let bestPrefix = -1;
  for (const candidate of candidates) {
    const expected = requiredCharacters(candidate);
    let prefix = 0;
    while (prefix < typed.length && prefix < expected.length && typed[prefix] === expected[prefix]) prefix += 1;
    if (prefix > bestPrefix || (prefix === bestPrefix && expected.length < chosenLength)) {
      bestPrefix = prefix;
      chosenLength = expected.length;
    }
  }
  return typed.length >= chosenLength;
}

export function dictationMaximumDraftLength(target: string): number {
  return Math.max(...acceptedSpellings(target).map(spelling => spelling.length));
}

export function dictationExpectedCharacterCount(target: string, draft: string): number {
  if (!draft) return dictationRequiredCharacterCount(target);
  const matching = acceptedSpellings(target).filter(spelling => matchesPrefix(spelling, draft));
  if (matching.length) return Math.min(...matching.map(dictationRequiredCharacterCount));
  const first = requiredCharacters(draft)[0];
  const sameForm = acceptedSpellings(target).filter(spelling => /\d/.test(requiredCharacters(spelling)[0]!) === /\d/.test(first || ''));
  return sameForm.length ? Math.min(...sameForm.map(dictationRequiredCharacterCount)) : dictationRequiredCharacterCount(target);
}

export function isDictationHyphenBoundary(target: string, draft: string): boolean {
  if (!draft || !isDictationDraftCorrectPrefix(target, draft)) return false;
  const requiredCount = dictationRequiredCharacterCount(draft);
  return acceptedSpellings(target).some(expected => {
    if (!matchesPrefix(expected, draft)) return false;
    let position = 0;
    let seen = 0;
    while (position < expected.length && seen < requiredCount) {
      if (!OPTIONAL_MARK.test(expected[position]!)) seen += 1;
      position += 1;
    }
    return expected[position] === '-';
  });
}

export function applyDictationCharacter(target: string, current: string, key: string, continueOnError = false): DictationCharacterResult {
  if (!isDictationCharacter(key)) return { status: 'rejected', value: current, complete: false };
  const value = current + key;
  const maximum = dictationMaximumDraftLength(target);
  if (dictationRequiredCharacterCount(value) > maximum || value.length > maximum) return { status: 'rejected', value: current, complete: false };
  const correct = isDictationDraftCorrectPrefix(target, value);
  if (!correct && !continueOnError) return { status: 'rejected', value: current, complete: false };
  return { status: 'accepted', value, complete: isDictationDraftComplete(target, value), correct };
}

export function nextIncompleteWord(completed: boolean[], current: number): number | null {
  if (!completed.length || completed.every(Boolean)) return null;
  for (let offset = 1; offset <= completed.length; offset += 1) {
    const index = (current + offset) % completed.length;
    if (!completed[index]) return index;
  }
  return null;
}

export function previousDictationWord(wordCount: number, current: number, revealed: boolean[] = []): number | null {
  for (let index = Math.min(Math.floor(current) - 1, Math.floor(wordCount) - 1); index >= 0; index -= 1) {
    if (!revealed[index]) return index;
  }
  return null;
}

/** Saved unfamiliar words and words above the learner's level are given as listening support. */
export function revealedDictationWords(words: string[], vocabularySize: number, savedVocabulary: Set<string>, masteredVocabulary: Set<string>): boolean[] {
  return words.map(word => {
    const info = lookupReaderWord(word);
    const keys = vocabularyTermKeys(word, info.lemma);
    if (keys.some(key => masteredVocabulary.has(key))) return false;
    return keys.some(key => savedVocabulary.has(key)) || (info.countable && isOutsideVocabulary(info.rank, vocabularySize));
  });
}

export function createGuidedDictationSlots(words: string[], revealed: boolean[]): { drafts: string[]; completed: boolean[] } {
  return {
    drafts: words.map((word, index) => revealed[index] ? word : ''),
    completed: words.map((_, index) => Boolean(revealed[index])),
  };
}

export function createDictationSlots(wordCount: number): { drafts: string[]; completed: boolean[] } {
  const length = Math.max(0, Math.floor(wordCount));
  return {
    drafts: Array.from({ length }, () => ''),
    completed: Array.from({ length }, () => false),
  };
}

export function nearestDictationItem(sourceIndices: number[], preferredSourceIndex: number): number {
  if (!sourceIndices.length) return -1;
  const exact = sourceIndices.indexOf(preferredSourceIndex);
  if (exact >= 0) return exact;
  const following = sourceIndices.findIndex(index => index > preferredSourceIndex);
  return following >= 0 ? following : sourceIndices.length - 1;
}
