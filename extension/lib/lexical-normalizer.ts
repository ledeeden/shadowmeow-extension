/**
 * Deterministic English lexical normalization.
 *
 * A surface token is intentionally kept separate from its lexical analysis:
 * contractions and spoken reductions can expand to more than one lemma, while
 * inflections and regional spellings normally resolve to one lookup lemma.
 */

export type LexicalKind =
  | 'word'
  | 'variant'
  | 'contraction'
  | 'possessive'
  | 'spoken-reduction'
  | 'abbreviation'
  | 'expression'
  | 'number'
  | 'proper'
  | 'noise'
  | 'unknown';

export type LexicalComponentRole = 'word' | 'auxiliary' | 'negation' | 'possessive' | 'particle' | 'expression';

export type LexicalComponent = {
  surface: string;
  lemma: string;
  role: LexicalComponentRole;
};

export type LexicalResolution = {
  surface: string;
  normalized: string;
  lemma: string;
  candidateLemmas: string[];
  components: LexicalComponent[];
  kind: LexicalKind;
  countable: boolean;
  resolution: string;
  confidence: number;
};

const BASE_LEMMAS: Record<string, string> = {
  subscribed: 'subscribe', subscribing: 'subscribe', teabags: 'teabag', earplugs: 'earplug',
  editing: 'edit', condiments: 'condiment',
  am: 'be', is: 'be', are: 'be', was: 'be', were: 'be', been: 'be', being: 'be',
  has: 'have', had: 'have', having: 'have',
  does: 'do', did: 'do', done: 'do', doing: 'do',
  goes: 'go', went: 'go', gone: 'go', going: 'go',
  says: 'say', said: 'say', saying: 'say',
  sells: 'sell', sold: 'sell', selling: 'sell',
  catches: 'catch', caught: 'catch', catching: 'catch',
  teaches: 'teach', taught: 'teach', teaching: 'teach',
  blew: 'blow', stung: 'sting',
  makes: 'make', made: 'make', making: 'make',
  gets: 'get', got: 'get', gotten: 'get', getting: 'get',
  takes: 'take', took: 'take', taken: 'take', taking: 'take',
  comes: 'come', came: 'come', coming: 'come',
  sees: 'see', saw: 'see', seen: 'see', seeing: 'see',
  knows: 'know', knew: 'know', known: 'know', knowing: 'know',
  thinks: 'think', thought: 'think', thinking: 'think',
  finds: 'find', found: 'find', finding: 'find',
  gives: 'give', gave: 'give', given: 'give', giving: 'give',
  tells: 'tell', told: 'tell', telling: 'tell',
  brings: 'bring', brought: 'bring', bringing: 'bring',
  begins: 'begin', began: 'begin', begun: 'begin', beginning: 'begin',
  keeps: 'keep', kept: 'keep', keeping: 'keep',
  holds: 'hold', held: 'hold', holding: 'hold',
  writes: 'write', wrote: 'write', written: 'write', writing: 'write',
  stands: 'stand', stood: 'stand', standing: 'stand',
  hears: 'hear', heard: 'hear', hearing: 'hear',
  meets: 'meet', met: 'meet', meeting: 'meet',
  runs: 'run', ran: 'run', running: 'run',
  pays: 'pay', paid: 'pay', paying: 'pay',
  sits: 'sit', sat: 'sit', sitting: 'sit',
  speaks: 'speak', spoke: 'speak', spoken: 'speak', speaking: 'speak',
  leads: 'lead', led: 'lead', leading: 'lead',
  reads: 'read', reading: 'read',
  grows: 'grow', grew: 'grow', grown: 'grow', growing: 'grow',
  loses: 'lose', lost: 'lose', losing: 'lose',
  falls: 'fall', fell: 'fall', fallen: 'fall', falling: 'fall',
  sends: 'send', sent: 'send', sending: 'send',
  builds: 'build', built: 'build', building: 'build',
  understands: 'understand', understood: 'understand', understanding: 'understand',
  draws: 'draw', drew: 'draw', drawn: 'draw', drawing: 'draw',
  breaks: 'break', broke: 'break', broken: 'break', breaking: 'break',
  spends: 'spend', spent: 'spend', spending: 'spend',
  cuts: 'cut', cutting: 'cut',
  rises: 'rise', rose: 'rise', risen: 'rise', rising: 'rise',
  becomes: 'become', became: 'become', becoming: 'become',
  leaves: 'leave', left: 'leave', leaving: 'leave',
  feels: 'feel', felt: 'feel', feeling: 'feel',
  drives: 'drive', drove: 'drive', driven: 'drive', driving: 'drive',
  buys: 'buy', bought: 'buy', buying: 'buy',
  eats: 'eat', ate: 'eat', eaten: 'eat', eating: 'eat',
  sleeps: 'sleep', slept: 'sleep', sleeping: 'sleep',
  wakes: 'wake', woke: 'wake', woken: 'wake', waking: 'wake',
  wears: 'wear', wore: 'wear', worn: 'wear', wearing: 'wear',
  chooses: 'choose', chose: 'choose', chosen: 'choose', choosing: 'choose',
  sings: 'sing', sang: 'sing', sung: 'sing', singing: 'sing',
  swims: 'swim', swam: 'swim', swum: 'swim', swimming: 'swim',
  rings: 'ring', rang: 'ring', rung: 'ring', ringing: 'ring',
  drinks: 'drink', drank: 'drink', drunk: 'drink', drinking: 'drink',
  sets: 'set', setting: 'set',
  puts: 'put', putting: 'put',
  lets: 'let', letting: 'let',
  costs: 'cost', costing: 'cost',
  hurts: 'hurt', hurting: 'hurt',
  shuts: 'shut', shutting: 'shut',
  hits: 'hit', hitting: 'hit',
  quits: 'quit', quitting: 'quit',
  lays: 'lay', laying: 'lay', laid: 'lay',
  lies: 'lie', lying: 'lie', lied: 'lie',
  hangs: 'hang', hanging: 'hang', hung: 'hang',
  men: 'man', women: 'woman', children: 'child', people: 'person',
  feet: 'foot', teeth: 'tooth', mice: 'mouse', geese: 'goose',
  oxen: 'ox', dice: 'die', data: 'datum', media: 'medium',
  criteria: 'criterion', phenomena: 'phenomenon', analyses: 'analysis',
  crises: 'crisis', theses: 'thesis', diagnoses: 'diagnosis',
  oases: 'oasis', axes: 'axis', indices: 'index', appendices: 'appendix',
  matrices: 'matrix', vertices: 'vertex', fungi: 'fungus', cacti: 'cactus',
  nuclei: 'nucleus', radii: 'radius', syllabi: 'syllabus', alumni: 'alumnus',
  wives: 'wife', knives: 'knife', wolves: 'wolf', loaves: 'loaf', calves: 'calf',
  halves: 'half', selves: 'self', shelves: 'shelf', lice: 'louse',
  better: 'good', best: 'good', worse: 'bad', worst: 'bad',
  farther: 'far', further: 'far', farthest: 'far', furthest: 'far',
};

const PRONOUN_LEMMAS: Record<string, string> = {
  me: 'i', us: 'we', him: 'he', them: 'they',
  mine: 'my', ours: 'our', yours: 'your', hers: 'her', theirs: 'their',
  whom: 'who', these: 'this', those: 'that',
};

const ORTHOGRAPHIC_ALIASES: Record<string, string> = {
  colour: 'color', colours: 'colors', coloured: 'colored', colouring: 'coloring',
  flavour: 'flavor', flavours: 'flavors', flavoured: 'flavored', flavouring: 'flavoring',
  honour: 'honor', honours: 'honors', honoured: 'honored', honouring: 'honoring',
  labour: 'labor', labours: 'labors', laboured: 'labored', labouring: 'laboring',
  neighbour: 'neighbor', neighbours: 'neighbors', neighbourhood: 'neighborhood', neighbourhoods: 'neighborhoods',
  behaviour: 'behavior', behaviours: 'behaviors',
  favour: 'favor', favours: 'favors', favoured: 'favored', favouring: 'favoring', favourite: 'favorite', favourites: 'favorites',
  rumour: 'rumor', rumours: 'rumors', glamour: 'glamor', harbour: 'harbor', harbours: 'harbors',
  odour: 'odor', odours: 'odors', rigour: 'rigor', valour: 'valor', vigour: 'vigor', splendour: 'splendor',
  centre: 'center', centres: 'centers', centred: 'centered', centring: 'centering',
  theatre: 'theater', theatres: 'theaters', fibre: 'fiber', fibres: 'fibers',
  calibre: 'caliber', metre: 'meter', metres: 'meters', litre: 'liter', litres: 'liters',
  lustre: 'luster', meagre: 'meager', sepulchre: 'sepulcher', sombre: 'somber',
  defence: 'defense', defences: 'defenses', offence: 'offense', offences: 'offenses',
  pretence: 'pretense', licence: 'license', practise: 'practice',
  analyse: 'analyze', analyses: 'analyzes', analysing: 'analyzing', analysed: 'analyzed',
  paralyse: 'paralyze', paralysed: 'paralyzed', paralysing: 'paralyzing',
  catalogue: 'catalog', catalogues: 'catalogs', dialogue: 'dialog', dialogues: 'dialogs',
  endeavour: 'endeavor', endeavours: 'endeavors', endeavoured: 'endeavored', endeavouring: 'endeavoring',
  prologue: 'prolog', epilogue: 'epilog',
  judgement: 'judgment', judgements: 'judgments', ageing: 'aging',
  travelled: 'traveled', travelling: 'traveling', focussed: 'focused', focussing: 'focusing',
  jewellery: 'jewelry', programme: 'program', programmes: 'programs',
  cancelled: 'canceled', cancelling: 'canceling', labelled: 'labeled', labelling: 'labeling',
  organised: 'organized', organising: 'organizing', recognised: 'recognized', recognising: 'recognizing',
  customised: 'customized', customising: 'customizing', customisable: 'customizable',
  unrivalled: 'unrivaled', specialises: 'specializes', demeanour: 'demeanor', colourful: 'colorful',
  travellers: 'travelers', whilst: 'while', amongst: 'among', aluminium: 'aluminum',
};

const SPOKEN_REDUCTIONS: Record<string, string[][]> = {
  gonna: [['go', 'to']],
  wanna: [['want', 'to']],
  gotta: [['get', 'to'], ['have', 'to']],
  hafta: [['have', 'to']],
  lemme: [['let', 'me']],
  gimme: [['give', 'me']],
  kinda: [['kind', 'of']],
  sorta: [['sort', 'of']],
  outta: [['out', 'of']],
  lotta: [['lot', 'of']],
  dunno: [['do', 'not', 'know']],
  "c'mon": [['come', 'on']],
  'cmon': [['come', 'on']],
  'c’mon': [['come', 'on']],
  yall: [['you', 'all']],
  "'em": [['them']],
  ya: [['you']],
  shoulda: [['should', 'have']],
  coulda: [['could', 'have']],
  woulda: [['would', 'have']],
  musta: [['must', 'have']],
  tryna: [['try', 'to']],
  whatcha: [['what', 'you']],
  "y'all": [['you', 'all']],
  imma: [['i', 'be']],
};

const EXPLICIT_CONTRACTIONS: Record<string, string[][]> = {
  "let's": [['let', 'we']],
  "ma'am": [['madam']],
  "can't": [['can', 'not']],
  cannot: [['can', 'not']],
  "won't": [['will', 'not']],
  "shan't": [['shall', 'not']],
  "ain't": [['be', 'not'], ['have', 'not']],
  "aren't": [['are', 'not']],
  "couldn't": [['could', 'not']],
  "daren't": [['dare', 'not']],
  "didn't": [['did', 'not']],
  "doesn't": [['does', 'not']],
  "don't": [['do', 'not']],
  "hadn't": [['had', 'not']],
  "hasn't": [['has', 'not']],
  "haven't": [['have', 'not']],
  "isn't": [['is', 'not']],
  "mayn't": [['may', 'not']],
  "mightn't": [['might', 'not']],
  "mustn't": [['must', 'not']],
  "needn't": [['need', 'not']],
  "oughtn't": [['ought', 'not']],
  "shouldn't": [['should', 'not']],
  "wasn't": [['was', 'not']],
  "weren't": [['were', 'not']],
  "wouldn't": [['would', 'not']],
  "'tis": [['it', 'be']],
  "'twas": [['it', 'be']],
};

const PRONOUN_OR_WH_BASES = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'that', 'what', 'where', 'there',
  'who', 'here', 'how', 'when', 'why', 'which', 'this', 'these', 'those',
]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function canonicalLemma(word: string): string {
  return BASE_LEMMAS[word] || PRONOUN_LEMMAS[word] || ORTHOGRAPHIC_ALIASES[word] || word;
}

function component(surface: string, lemma: string, role: LexicalComponentRole = 'word'): LexicalComponent {
  return { surface, lemma: lemma === '__possessive' ? '' : canonicalLemma(lemma), role };
}

function componentsForExpansion(expansion: string[], source: string): LexicalComponent[] {
  return expansion.map((part, index) => component(index === 0 && expansion.length === 1 ? source : part, part, part === 'not' ? 'negation' : ['be', 'have', 'will', 'would', 'could', 'should', 'shall', 'can', 'do', 'get'].includes(part) ? 'auxiliary' : 'word'));
}

function buildResolution(
  surface: string,
  normalized: string,
  kind: LexicalKind,
  expansions: string[][],
  resolution: string,
  confidence: number,
): LexicalResolution {
  const normalizedExpansions = expansions.length ? expansions : [[normalized]];
  const primary = canonicalLemma(normalizedExpansions[0]?.[0] || normalized);
  const directCandidates = normalizedExpansions.flat().filter((part) => part !== '__possessive').map(canonicalLemma);
  const variantCandidates = kind === 'variant'
    ? normalizedExpansions.flatMap((expansion) => expansion.flatMap((part) => part === '__possessive' ? [] : morphologyCandidates(part)))
    : [];
  const candidates = unique([...directCandidates, ...variantCandidates]);
  const components = componentsForExpansion(normalizedExpansions[0] || [normalized], surface);
  return {
    surface,
    normalized,
    lemma: primary,
    candidateLemmas: unique([primary, ...candidates]),
    components,
    kind,
    countable: true,
    resolution,
    confidence,
  };
}

function splitClitic(normalized: string): { base: string; suffixes: string[] } | null {
  let rest = normalized;
  const suffixes: string[] = [];
  const endings = ["n't", "'re", "'ve", "'ll", "'d", "'s", "'m"];
  while (true) {
    const ending = endings.find((candidate) => rest.endsWith(candidate) && rest.length > candidate.length);
    if (!ending) break;
    suffixes.unshift(ending);
    rest = rest.slice(0, -ending.length);
  }
  return suffixes.length && rest ? { base: rest, suffixes } : null;
}

function contractionResolution(surface: string, normalized: string): LexicalResolution | null {
  const explicit = EXPLICIT_CONTRACTIONS[normalized];
  if (explicit) return buildResolution(surface, normalized, 'contraction', explicit, 'explicit-contraction', 1);

  const split = splitClitic(normalized);
  if (!split) return null;

  const { base, suffixes } = split;
  let expansions: string[][] = [[base]];
  for (const suffix of suffixes) {
    if (suffix === "'m" || suffix === "'re") expansions = expansions.map((item) => [...item, 'be']);
    else if (suffix === "'ve") expansions = expansions.map((item) => [...item, 'have']);
    else if (suffix === "'ll") expansions = expansions.map((item) => [...item, 'will']);
    else if (suffix === "'d") expansions = expansions.flatMap((item) => [[...item, 'would'], [...item, 'had']]);
    else if (suffix === "n't") expansions = expansions.map((item) => [...item, 'not']);
    else if (suffix === "'s") expansions = expansions.flatMap((item) => [[...item, 'be'], [...item, 'have']]);
  }

  const isPossessiveCandidate = suffixes.length === 1 && suffixes[0] === "'s" && !PRONOUN_OR_WH_BASES.has(base);
  if (isPossessiveCandidate) {
    const possessive = buildResolution(surface, normalized, 'possessive', [[base, '__possessive']], 'possessive-clitic', 0.99);
    possessive.candidateLemmas = unique([possessive.lemma, ...morphologyCandidates(base), ...possessive.candidateLemmas]);
    possessive.components[1] = component("'s", '__possessive', 'possessive');
    return possessive;
  }

  return buildResolution(surface, normalized, 'contraction', expansions, 'compositional-contraction', 0.98);
}

function possessiveResolution(surface: string, normalized: string): LexicalResolution | null {
  if (normalized.endsWith("'") && normalized.length > 2) {
    const stem = normalized.slice(0, -1);
    const result = buildResolution(surface, normalized, 'possessive', [[stem, '__possessive']], 'possessive-clitic', 0.99);
    result.candidateLemmas = unique([result.lemma, ...morphologyCandidates(stem), ...result.candidateLemmas]);
    result.components[1] = component("'", '__possessive', 'possessive');
    return result;
  }
  return null;
}

export function normalizeWord(raw: string): string {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/[’‘ʻʼ´`]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function morphologyCandidates(word: string): string[] {
  const candidates = new Set<string>([word]);
  const add = (candidate: string) => { if (candidate && candidate !== word) candidates.add(candidate); };
  const irregular = BASE_LEMMAS[word];
  if (irregular) add(irregular);

  if (word.endsWith('ies') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ied') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ves') && word.length > 4) {
    add(`${word.slice(0, -3)}f`);
    add(`${word.slice(0, -3)}fe`);
  }
  if (word.endsWith('men') && word.length > 4) add(`${word.slice(0, -3)}man`);
  if (word.endsWith('ren') && word.length > 4) add(`${word.slice(0, -3)}r`);
  if (word.endsWith('es') && word.length > 4) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
  }
  if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) add(word.slice(0, -1));
  if (word.endsWith('ed') && word.length > 4) {
    const stem = word.slice(0, -2);
    add(stem);
    add(`${stem}e`);
    if (/(.)\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (word.endsWith('ing') && word.length > 5) {
    const stem = word.slice(0, -3);
    add(stem);
    add(`${stem}e`);
    if (/(.)\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (word.endsWith('ier') && word.length > 4) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('iest') && word.length > 5) add(`${word.slice(0, -4)}y`);
  if (word.endsWith('er') && word.length > 4) {
    const stem = word.slice(0, -2);
    add(stem);
    add(`${stem}e`);
    if (/(.)\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (word.endsWith('est') && word.length > 5) {
    const stem = word.slice(0, -3);
    add(stem);
    add(`${stem}e`);
    if (/(.)\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (word.endsWith('ise') && word.length > 5) add(`${word.slice(0, -3)}ize`);
  if (word.endsWith('ised') && word.length > 6) add(`${word.slice(0, -4)}ized`);
  if (word.endsWith('ising') && word.length > 6) add(`${word.slice(0, -4)}izing`);
  if (word.endsWith('ises') && word.length > 5) add(`${word.slice(0, -4)}izes`);
  if (word.endsWith('isation') && word.length > 7) add(`${word.slice(0, -7)}ization`);
  if (word.endsWith('isations') && word.length > 8) add(`${word.slice(0, -8)}izations`);
  if (word.endsWith('our') && word.length > 4) add(`${word.slice(0, -3)}or`);
  if (word.endsWith('ours') && word.length > 5) add(`${word.slice(0, -4)}ors`);
  if (word.endsWith('re') && word.length > 4) add(`${word.slice(0, -2)}er`);
  if (word.endsWith('lling') && word.length > 6) add(`${word.slice(0, -5)}ling`);
  if (word.endsWith('lled') && word.length > 5) add(`${word.slice(0, -4)}led`);
  if (word.endsWith('ller') && word.length > 5) add(`${word.slice(0, -4)}ler`);

  return [...candidates].map(canonicalLemma);
}

export function resolveLexicalSurface(raw: string, options: { sentenceStart?: boolean; knownWords?: ReadonlySet<string> } = {}): LexicalResolution {
  const surface = String(raw || '');
  const normalized = normalizeWord(surface);
  if (!normalized) return { surface, normalized, lemma: '', candidateLemmas: [], components: [], kind: 'noise', countable: false, resolution: 'empty', confidence: 1 };
  if (/^\d+(?:[.,]\d+)?$/.test(normalized)) return { surface, normalized, lemma: normalized, candidateLemmas: [normalized], components: [], kind: 'number', countable: false, resolution: 'numeric-token', confidence: 1 };
  if (normalized.length === 1 && !['a', 'i'].includes(normalized)) return { surface, normalized, lemma: normalized, candidateLemmas: [], components: [], kind: 'noise', countable: false, resolution: 'single-letter-fragment', confidence: 1 };

  const spoken = SPOKEN_REDUCTIONS[normalized];
  if (spoken) return buildResolution(surface, normalized, 'spoken-reduction', spoken, 'spoken-reduction', 0.97);

  const contraction = contractionResolution(surface, normalized);
  if (contraction) return contraction;

  const possessive = possessiveResolution(surface, normalized);
  if (possessive) return possessive;

  const alias = ORTHOGRAPHIC_ALIASES[normalized];
  if (alias) return buildResolution(surface, normalized, 'variant', [[alias]], 'regional-spelling', 0.99);

  const pronoun = PRONOUN_LEMMAS[normalized];
  if (pronoun) return buildResolution(surface, normalized, 'variant', [[pronoun]], 'pronoun-form', 0.99);

  const canonical = canonicalLemma(normalized);
  const candidates = morphologyCandidates(normalized);
  const preferred = canonical !== normalized ? canonical : normalized;
  return {
    surface,
    normalized,
    lemma: preferred,
    candidateLemmas: unique([preferred, ...candidates]),
    components: [component(surface, preferred)],
    kind: preferred !== normalized ? 'variant' : 'word',
    countable: true,
    resolution: preferred !== normalized ? 'explicit-lemma' : 'surface',
    confidence: preferred !== normalized ? 0.95 : 1,
  };
}

export type LexicalTextToken = { raw: string; sentenceStart: boolean };

export function tokenizeLexicalText(text: string): LexicalTextToken[] {
  const normalizedText = String(text || '').replace(/[’‘ʻʼ´`]/g, "'");
  const pattern = /wi-fi|[A-Za-zÀ-ÖØ-öø-ÿ]+(?:'[A-Za-zÀ-ÖØ-öø-ÿ]+)?|[^A-Za-zÀ-ÖØ-öø-ÿ\s]|\s+/g;
  const tokens: LexicalTextToken[] = [];
  let sentenceStart = true;
  for (const match of normalizedText.matchAll(pattern)) {
    const raw = match[0] || '';
    if (/^[A-Za-zÀ-ÖØ-öø-ÿ]/.test(raw)) {
      tokens.push({ raw, sentenceStart });
      sentenceStart = false;
      continue;
    }
    if (!/^\s+$/.test(raw) && /[.!?]/.test(raw)) sentenceStart = true;
  }
  return tokens;
}
