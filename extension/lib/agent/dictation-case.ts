const names = `Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April June July August September October November December English Chinese French Spanish German Italian Japanese Korean British American London China Japan France Germany Italy Spain Australia Canada India Europe Asia Africa Christmas Google YouTube`.split(' ');

/** Case only; ambiguous May/US are intentionally excluded. */
export function capitalizeDictation(text: string, customNames = ''): string {
  const dictionary = new Map([...names, ...customNames.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean)].map(s => [s.toLowerCase(), s]));
  let result = text.replace(/\b[a-z]+(?:['’][a-z]+)?\b/gi, (word, offset: number) => {
    if (offset + word.length === text.length) return word;
    if (/^i(?:['’](?:m|d|ll|ve))?$/i.test(word)) return `I${word.slice(1)}`;
    return offset + word.length < text.length ? dictionary.get(word.toLowerCase()) || word : word;
  });
  for (const [lower, canonical] of dictionary) {
    if (!lower.includes(' ')) continue;
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`\\b${escaped}\\b(?=\\W)`, 'gi'), canonical);
  }
  return result.replace(/(^|[.!?]\s+|\n)([\s"“'‘(]*)([a-z])/g, (_, boundary, quote, letter: string) => boundary + quote + letter.toUpperCase());
}
