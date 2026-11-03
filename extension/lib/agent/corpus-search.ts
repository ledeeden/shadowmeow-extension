import { PUBLIC_CORPUS_TOPIC_IDS, publicCorpusFilterSchema, type PublicCorpusFilterInput, type PublicCorpusTopic } from '@shadow-language/contracts';

export const CORPUS_TOPIC_IDS = PUBLIC_CORPUS_TOPIC_IDS;
export type CorpusSearchSpeed = 'very_slow' | 'slow' | 'normal' | 'fast';

const TOPIC_PATTERNS: Array<{ id: PublicCorpusTopic; pattern: RegExp }> = [
  { id: 'public_transport', pattern: /公共交通|公交|地铁|轻轨|火车|列车|巴士|车站|车票|换乘|public\s+(?:transport|transportation|transit)|transit|subway|metro|bus(?:es)?|train|tram|station|ticket|transfer/i },
  { id: 'airport', pattern: /机场|登机|航班|airport|boarding|flight/i },
  { id: 'hotel', pattern: /酒店|旅馆|住宿|入住|退房|hotel|hostel|check[- ]?in|check[- ]?out|accommodation/i },
  { id: 'shopping', pattern: /购物|商店|买东西|价格|退货|shopping|shop|store|price|return(?:ing)?/i },
  { id: 'food', pattern: /餐厅|吃饭|点餐|食物|咖啡|restaurant|food|dining|order|coffee/i },
  { id: 'work', pattern: /工作|职场|会议|面试|work|office|meeting|interview/i },
  { id: 'education', pattern: /学习|教育|课堂|学校|education|school|classroom|study/i },
  { id: 'technology', pattern: /科技|技术|软件|电脑|technology|software|computer|programming/i },
  { id: 'health', pattern: /健康|医院|看病|health|hospital|doctor|medical/i },
  { id: 'news', pattern: /新闻|时事|报道|news|current\s+affairs|report/i },
  { id: 'entertainment', pattern: /电影|电视剧|娱乐|music|movie|television|entertainment/i },
  { id: 'daily_life', pattern: /日常|生活|家庭|daily\s+life|everyday|family/i },
  { id: 'travel', pattern: /旅行|旅游|景点|出行|travel|tourism|sightseeing|trip/i },
];

const SPEED_PATTERNS: Array<{ speed: CorpusSearchSpeed; pattern: RegExp }> = [
  { speed: 'very_slow', pattern: /非常慢|很慢|慢速|慢得多|\bvery\s+slow\b/i },
  { speed: 'slow', pattern: /慢一点|慢些|较慢|慢的|语速慢|\bslow(?:er)?\b/i },
  { speed: 'fast', pattern: /快一点|较快|快速|语速快|\bfast(?:er)?\b/i },
  { speed: 'normal', pattern: /正常语速|中速|\bnormal\s+speed\b|\bmedium\s+speed\b/i },
];

const SPEED_BOUNDS: Record<CorpusSearchSpeed, Pick<PublicCorpusFilterInput, 'minActiveWpm' | 'maxActiveWpm'>> = {
  very_slow: { maxActiveWpm: 100 },
  slow: { maxActiveWpm: 140 },
  normal: { minActiveWpm: 140, maxActiveWpm: 180 },
  fast: { minActiveWpm: 180 },
};

function finiteNumber(value: unknown, minimum = 0, maximum = 1_000) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

function cleanTerms(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const terms = [...new Set(value.filter((term): term is string => typeof term === 'string').map(term => term.trim()).filter(Boolean))].slice(0, 16);
  return terms.length ? terms : undefined;
}

function inferTopic(query: string): PublicCorpusTopic | undefined {
  return TOPIC_PATTERNS.find(({ pattern }) => pattern.test(query))?.id;
}

function inferSpeed(query: string): CorpusSearchSpeed | undefined {
  return SPEED_PATTERNS.find(({ pattern }) => pattern.test(query))?.speed;
}

/** Convert the model's natural-language search intent into the public API shape. */
export function buildCorpusSearchFilters(input: unknown): PublicCorpusFilterInput {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const rawQuery = typeof value.query === 'string' ? value.query.trim().slice(0, 200) : '';
  const inferredTopic = inferTopic(rawQuery);
  const topic = inferredTopic || (typeof value.topic === 'string' && (CORPUS_TOPIC_IDS as readonly string[]).includes(value.topic)
    ? value.topic as PublicCorpusTopic
    : undefined);
  const inferredSpeed = inferSpeed(rawQuery);
  const speed = inferredSpeed || (typeof value.speed === 'string' && ['very_slow', 'slow', 'normal', 'fast'].includes(value.speed)
    ? value.speed as CorpusSearchSpeed
    : undefined);
  const explicitTopicTerms = cleanTerms(value.topicTerms);
  const topicQuery = typeof value.topicQuery === 'string' ? value.topicQuery.trim().slice(0, 120) : undefined;
  const explicitMinWpm = finiteNumber(value.minActiveWpm);
  const explicitMaxWpm = finiteNumber(value.maxActiveWpm);
  const speedBounds = speed ? SPEED_BOUNDS[speed] : {};
  const query = topic || speed ? '' : rawQuery;
  const result = {
    query,
    ...(topic ? { topic } : {}),
    ...(topicQuery ? { topicQuery } : {}),
    ...(explicitTopicTerms ? { topicTerms: explicitTopicTerms } : {}),
    searchMode: 'agent' as const,
    ...(typeof value.category === 'string' ? { category: value.category.trim().slice(0, 80) } : {}),
    ...(typeof value.register === 'string' ? { register: value.register.trim().slice(0, 80) } : {}),
    ...(typeof value.channel === 'string' ? { channel: value.channel.trim().slice(0, 200) } : {}),
    ...(finiteNumber(value.maxRecommendedVocabulary, 1, 60_000) != null ? { maxRecommendedVocabulary: finiteNumber(value.maxRecommendedVocabulary, 1, 60_000) } : {}),
    ...(finiteNumber(value.minLemmaCount, 0, 1_000_000) != null ? { minLemmaCount: finiteNumber(value.minLemmaCount, 0, 1_000_000) } : {}),
    ...(finiteNumber(value.maxLemmaCount, 0, 1_000_000) != null ? { maxLemmaCount: finiteNumber(value.maxLemmaCount, 0, 1_000_000) } : {}),
    ...(explicitMinWpm != null ? { minActiveWpm: explicitMinWpm } : speedBounds.minActiveWpm != null ? { minActiveWpm: speedBounds.minActiveWpm } : {}),
    ...(explicitMaxWpm != null ? { maxActiveWpm: explicitMaxWpm } : speedBounds.maxActiveWpm != null ? { maxActiveWpm: speedBounds.maxActiveWpm } : {}),
    ...(typeof value.difficultyBand === 'string' && ['accessible', 'moderate', 'challenging', 'advanced'].includes(value.difficultyBand) ? { difficultyBand: value.difficultyBand as PublicCorpusFilterInput['difficultyBand'] } : {}),
    cursor: 0,
    limit: Math.min(12, Math.max(1, typeof value.limit === 'number' && Number.isInteger(value.limit) ? value.limit : 8)),
  };
  return publicCorpusFilterSchema.parse(result);
}
