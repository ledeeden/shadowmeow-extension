import { shortZhFromTranslation } from '@shadow-language/contracts';

// ECDICT's Catherine entry accidentally contains the senses of "Catherine wheel".
const catherineTranslation = 'n. 凯瑟琳（女子名）';
const incorrectCatherineTranslation = 'n. 轮圈外缘装有倒钩的车轮, 侧翻筋斗, 轮转烟火, 车轮窗';
const incorrectCatherineMeanings = new Set([
  incorrectCatherineTranslation,
  shortZhFromTranslation(incorrectCatherineTranslation),
]);

export function correctedDictionaryTranslation(lemma: string): string | undefined {
  return lemma.trim().toLowerCase() === 'catherine' ? catherineTranslation : undefined;
}

/** Correct only the known bad imported meanings, preserving user edits. */
export function correctSavedDictionaryMeaning(lemma: string, meaning: string): string {
  return lemma.trim().toLowerCase() === 'catherine' && incorrectCatherineMeanings.has(meaning.trim())
    ? shortZhFromTranslation(catherineTranslation)!
    : meaning;
}
