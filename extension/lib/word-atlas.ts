export type AtlasEntry = {
  id: string; w: string; uk: string; us: string; m: number;
  senses: { pos: string; zh: string; en: string }[];
  ex: { en: string; zh: string }[];
  col: string[]; fam: string[]; tip: string; note?: string;
  cefr?: string; topic?: string;
};

const revision = '99c007673d38f02c418d8e4cd2e9ec90b5d40be5';
const mediaBase = `https://cdn.jsdelivr.net/gh/designfuchen/word-atlas@${revision}/public/atlas`;
const flags = { img: 1, uk: 2, us: 4, ex: 8, ex2: 16 } as const;
let entries: Promise<Map<string, AtlasEntry>> | undefined;

export function atlasKey(value: string): string {
  return value.normalize('NFKC').replace(/[\u2018\u2019\u201b\u02bc]/g, "'").trim().toLowerCase().replace(/\s+/g, ' ');
}

export function atlasMedia(entry: AtlasEntry, kind: keyof typeof flags): string | null {
  if (!(entry.m & flags[kind]) || !/^[a-z0-9-]+$/.test(entry.id)) return null;
  return kind === 'img' ? `${mediaBase}/img/${entry.id}.webp` : `${mediaBase}/audio/${kind}/${entry.id}.mp3`;
}

export async function loadAtlasEntries(): Promise<Map<string, AtlasEntry>> {
  if (!entries) {
    entries = fetch(`${import.meta.env.BASE_URL}word-atlas.json`).then(async response => {
      if (!response.ok) throw new Error('Word Atlas unavailable');
      const data = await response.json() as AtlasEntry[];
      if (!Array.isArray(data)) throw new Error('Invalid Word Atlas');
      const result = new Map<string, AtlasEntry>();
      for (const entry of data) if (typeof entry.w === 'string' && typeof entry.id === 'string') result.set(atlasKey(entry.w), entry);
      return result;
    }).catch(error => { entries = undefined; throw error; });
  }
  return entries;
}

export async function findAtlasEntry(word: string): Promise<AtlasEntry | null> {
  const key = atlasKey(word);
  if (!key || key.length > 100 || !/^[a-z][a-z ./'-]*$/.test(key)) return null;
  try { return (await loadAtlasEntries()).get(key) || null; } catch { return null; }
}
