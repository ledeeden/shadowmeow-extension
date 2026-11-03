import { tokenizeCaptionText } from '@shadow-language/contracts';

const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Recover only a unique match from the card's own source transcript. */
export function recoverMaskedVocabularyContext(context: string, word: string, candidates: string[]): string | null {
  if (!context.includes('█')) return null;
  // Older bilingual transcript rows appended the Chinese translation after a newline.
  const english = normalize(context.split(/\r?\n(?=[^\n]*[\u3400-\u9fff])/u)[0]!);
  const target = word.trim().toLowerCase();
  if (!tokenizeCaptionText(english).some(token => token.lookupText?.toLowerCase() === target)) return null;
  const matches = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.includes('█')) continue;
    const source = normalize(candidate);
    const tokens = tokenizeCaptionText(source);
    if (!tokens.some(token => token.lookupText?.toLowerCase() === target)) continue;
    const pattern = tokens.map(token => {
      if (token.kind !== 'word' || !token.lookupText) return token.text.replace(/\S/g, ' ');
      // Match the mask used when these historical records were saved.
      const mask = '█'.repeat(Math.min(12, Math.max(2, Array.from(token.text).length)));
      return `(?:${escapeRegex(token.text)}|${mask})`;
    }).join('').trim().replace(/\s+/g, '\\s+');
    if (new RegExp(`^${pattern}$`, 'iu').test(english)) matches.add(source);
  }
  return matches.size === 1 ? [...matches][0]! : null;
}
