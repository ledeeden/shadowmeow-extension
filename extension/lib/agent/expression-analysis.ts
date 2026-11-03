import { type CaptionCue, type ExpressionBundle, type ExpressionBundleInput, type ExpressionReviewItem, type PageState, randomId, videoKeyOf } from '@shadow-language/contracts';
import { getExpressionReviewState } from '../expression-review-store';
import { comparable, normalizeExpressionText } from '../expression-review';
import { agentDb, type KnowledgeDocument } from './store';
import { completeModel, type ModelPurpose } from './provider';
import { readKey } from './credentials';
import { studyOwner } from './study-documents';

export type ExtractedExpression = {
  id: string;
  chunk: string;
  pattern: string;
  meaningZh: string;
  intentZh: string;
  slots: string[];
  sourceSentence: string;
  startMs: number;
  isExisting: boolean;
  existingBundleId?: string;
  existingReviewStatus?: 'new' | 'learning' | 'due' | 'mastered';
  note?: string;
};

export type IntensiveSentenceCandidate = {
  seq: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type IntensiveSentenceSelection = IntensiveSentenceCandidate & {
  reasonZh: string;
  focus: string;
};

export type ExpressionAnalysisResult = {
  videoKey: string;
  expressions: ExtractedExpression[];
  updatedAt: number;
};

export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 返回内容不是有效的 JSON 格式。');
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function parseExpressionAnalysisJson(
  rawJsonText: string,
  existingBundles: ExpressionBundle[] = [],
  existingItems: ExpressionReviewItem[] = [],
  cues: CaptionCue[] = [],
): ExtractedExpression[] {
  const raw = extractJson(rawJsonText) as { expressions?: unknown[] };
  const list = Array.isArray(raw.expressions) ? raw.expressions : [];

  // Build lookup maps for existing knowledge
  const bundleByComparableChunk = new Map<string, ExpressionBundle>();
  const bundleByComparablePattern = new Map<string, ExpressionBundle>();
  for (const bundle of existingBundles) {
    if (bundle.chunk) bundleByComparableChunk.set(comparable(bundle.chunk), bundle);
    if (bundle.pattern) bundleByComparablePattern.set(comparable(bundle.pattern), bundle);
  }

  const itemsByBundleId = new Map<string, ExpressionReviewItem[]>();
  for (const item of existingItems) {
    if (item.bundleId) {
      const current = itemsByBundleId.get(item.bundleId) || [];
      current.push(item);
      itemsByBundleId.set(item.bundleId, current);
    }
  }

  const result: ExtractedExpression[] = [];
  const now = Date.now();

  for (let idx = 0; idx < list.length; idx++) {
    const item = list[idx] as Record<string, unknown>;
    const chunk = normalizeExpressionText(String(item.chunk || ''));
    const pattern = normalizeExpressionText(String(item.pattern || ''));
    if (!chunk && !pattern) continue;

    const meaningZh = normalizeExpressionText(String(item.meaningZh || ''));
    const intentZh = normalizeExpressionText(String(item.intentZh || ''));
    const rawSlots = Array.isArray(item.slots) ? item.slots.map(s => normalizeExpressionText(String(s))).filter(Boolean) : [];
    const sourceSentence = normalizeExpressionText(String(item.sourceSentence || ''));
    const note = item.note ? normalizeExpressionText(String(item.note)) : undefined;

    let startMs = typeof item.startMs === 'number' && Number.isFinite(item.startMs) ? Math.max(0, Math.round(item.startMs)) : 0;
    // If startMs is 0 or unaligned, attempt to find cue in video
    if (cues.length && (startMs === 0 || !cues.some(c => Math.abs(c.startMs - startMs) < 1000))) {
      const sentenceMatch = sourceSentence
        ? cues.find(c => c.text.toLowerCase().includes(sourceSentence.toLowerCase()) || sourceSentence.toLowerCase().includes(c.text.toLowerCase()))
        : null;
      if (sentenceMatch) {
        startMs = sentenceMatch.startMs;
      } else if (chunk) {
        const chunkMatch = cues.find(c => new RegExp(`\\b${chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(c.text));
        if (chunkMatch) startMs = chunkMatch.startMs;
      }
    }

    // Check if this matches user's existing knowledge
    const compChunk = comparable(chunk);
    const compPattern = comparable(pattern);
    const existing = (compChunk && bundleByComparableChunk.get(compChunk)) ||
      (compPattern && bundleByComparablePattern.get(compPattern)) ||
      existingBundles.find(b => {
        const bComp = comparable(b.chunk);
        return (bComp && compChunk && (bComp === compChunk || bComp.includes(compChunk) || compChunk.includes(bComp)));
      });

    const isExisting = Boolean(existing || item.isExisting);
    let existingReviewStatus: ExtractedExpression['existingReviewStatus'];
    if (existing) {
      const items = itemsByBundleId.get(existing.id) || [];
      const primaryItem = items.find(i => i.kind === 'phrase') || items.find(i => i.kind === 'pattern') || items[0];
      if (primaryItem) {
        if (primaryItem.status === 'mastered') {
          existingReviewStatus = 'mastered';
        } else if (primaryItem.due !== null && primaryItem.due <= now) {
          existingReviewStatus = 'due';
        } else if (primaryItem.status === 'learning' || primaryItem.fsrs.reps > 0) {
          existingReviewStatus = 'learning';
        } else {
          existingReviewStatus = 'new';
        }
      }
    }

    result.push({
      id: `extracted_${now}_${idx}`,
      chunk,
      pattern: pattern || chunk,
      meaningZh,
      intentZh,
      slots: rawSlots,
      sourceSentence,
      startMs,
      isExisting,
      ...(existing ? { existingBundleId: existing.id } : {}),
      ...(existingReviewStatus ? { existingReviewStatus } : {}),
      ...(note ? { note } : {}),
    });
  }

  return result;
}

export function expressionAnalysisDocId(owner: string, videoKey: string): string {
  return `expression_analysis:${owner}:${videoKey}`;
}

export async function readCachedExpressionAnalysis(
  owner: string,
  videoKey: string,
): Promise<ExpressionAnalysisResult | null> {
  const doc = await agentDb.documents.get(expressionAnalysisDocId(owner, videoKey));
  if (!doc || doc.documentKind !== 'expression_analysis' || !doc.text) return null;
  try {
    const parsed = JSON.parse(doc.text) as { expressions: ExtractedExpression[]; updatedAt: number };
    return {
      videoKey,
      expressions: parsed.expressions || [],
      updatedAt: parsed.updatedAt || doc.updatedAt,
    };
  } catch {
    return null;
  }
}

export async function saveCachedExpressionAnalysis(
  owner: string,
  videoKey: string,
  expressions: ExtractedExpression[],
): Promise<void> {
  const id = expressionAnalysisDocId(owner, videoKey);
  const existing = await agentDb.documents.get(id);
  const now = Date.now();
  const doc: KnowledgeDocument = {
    id,
    owner,
    videoKey,
    documentKind: 'expression_analysis',
    title: `Expression Analysis for ${videoKey}`,
    text: JSON.stringify({ expressions, updatedAt: now }),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await agentDb.documents.put(doc);
}

const SYSTEM_PROMPT = `你是一位精通地道口语与第二语言习得（SLA）的英语教学专家。
你的任务是从给定的视频英文字幕中，为英语学习者提炼出最具实际交际复用价值的「语块（Lexical Chunks）」与「可复用句型结构（Sentence Patterns）」。

【提炼标准与原则】
1. 语块（chunk）：可以被整体提取、直接脱口而出的固定或半固定搭配短语（例如："come up with", "make sense", "as far as I'm concerned", "at the end of the day", "take something for granted"）。
2. 可复用句型（pattern）：带有可替换槽位（slots）的框架结构，学习者能在日常交流中举一反三（例如："It turns out that [sentence]", "I'm having trouble [doing something]", "There's no point in [doing something]"）。槽位请在 pattern 中用中括号标注。
3. 必须对应字幕中真实出现的原句（sourceSentence）与时间戳（startMs）。
4. 深度对比用户的「既有表达复习库」：
   - 如果视频中出现的语块/句型，与用户已学过/收录过的表达相同或属于直接变体，标记 "isExisting": true，并在 intentZh 或 note 中说明这是旧知识在真实新语境中的复现与巩固。
   - 如果是用户表达库中尚未收录的高价值表达，标记 "isExisting": false，作为推荐收录的新知识。
5. 提炼质量优先：挑选 8 到 15 条最自然、高频、地道、适合中国英语学习者吸收的表达，不要罗列生僻单词或无复用价值的碎片。

【输出格式】
只输出纯 JSON 对象，严格禁止任何 Markdown 格式包装或额外寒暄：
{
  "expressions": [
    {
      "chunk": "come up with",
      "pattern": "come up with + [an idea / solution / plan]",
      "meaningZh": "想出，提出（主意、方案等）",
      "intentZh": "描述自己或他人产生新想法或解决办法",
      "slots": ["an idea", "a solution", "a plan"],
      "sourceSentence": "How did you come up with that idea?",
      "startMs": 14200,
      "isExisting": false,
      "note": "日常口语极高频"
    }
  ]
}`;

const SINGLE_SENTENCE_SYSTEM_PROMPT = `你是一位精通英语听力教学和口语表达的 AI 教练。
你会从一条真实语料中被指定的一个英文句子里，提炼 1～3 个最值得复习的语块或句型。
只保留可以在其他日常交流中复用的表达，不要把普通单词、整句拆碎成没有用的片段。
sourceSentence 必须逐字来自输入句子；不要改写、补全或发明字幕没有出现的内容。
只输出 JSON，不要 Markdown：
{"expressions":[{"chunk":"...","pattern":"...","meaningZh":"...","intentZh":"...","slots":["..."],"sourceSentence":"...","startMs":0,"isExisting":false,"note":"..."}]}`;

export async function selectIntensiveSentence({
  candidates,
  videoKey,
  title,
  owner,
  purpose = 'study_document',
  signal,
  onStatus,
}: {
  candidates: IntensiveSentenceCandidate[];
  videoKey: string;
  title: string;
  owner?: string;
  purpose?: ModelPurpose;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
}): Promise<IntensiveSentenceSelection> {
  if (!candidates.length) throw new Error('当前语料没有可供 AI 选择的完整句子。');
  const currentOwner = owner || (await studyOwner());
  const hostedAi = Boolean(import.meta.env.VITE_SHADOW_WEB);
  if (purpose !== 'onboarding' && hostedAi && currentOwner === 'local') throw new Error('请先登录 Shadow Language 账号后使用 AI 选句。');
  const key = hostedAi ? undefined : await readKey();
  if (!hostedAi && !key) throw new Error('请先在 Agent 的 AI 设置中配置 DeepSeek Key。');
  const transcript = candidates
    .map(candidate => `[${candidate.seq}] ${candidate.text}`)
    .join('\n')
    .slice(0, 50_000);
  onStatus?.('AI 正在从这条真实语料中挑选最值得精听的一句…');
  const controller = new AbortController();
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  const response = await completeModel({
    ...(key ? { key } : {}),
    purpose,
    messages: [
      { role: 'system', content: '你是严格的英语听力教练。只能从候选句子中选择，不得编造编号。只返回 JSON。' },
      { role: 'user', content: `视频标题：${title}\n视频 Key：${videoKey}\n\n候选句子（编号必须原样使用）：\n${transcript}\n\n请选一句最值得第一次精听：优先选择包含自然连读/弱读、真实口语结构、可复用表达且长度适中的句子；不要选择只有专名或信息噪声的句子。只返回：{"seq":候选编号,"reasonZh":"为什么值得精听","focus":"这句要特别留意的听力现象或表达"}` },
    ],
    signal: controller.signal,
  });
  if (!response.content?.trim()) throw new Error('AI 没有返回选句结果，请重试。');
  const raw = extractJson(response.content) as Record<string, unknown>;
  const seq = Number(raw.seq);
  if (!Number.isInteger(seq)) throw new Error('AI 选句结果缺少有效句子编号，请重试。');
  const selected = candidates.find(candidate => candidate.seq === seq);
  if (!selected) throw new Error('AI 选择了不在当前语料中的句子，请重试。');
  const reasonZh = normalizeExpressionText(String(raw.reasonZh || ''));
  const focus = normalizeExpressionText(String(raw.focus || ''));
  if (!reasonZh || !focus) throw new Error('AI 选句结果缺少教学理由，请重试。');
  return { ...selected, reasonZh, focus };
}

export async function analyzeCorpusExpressions({
  page,
  cues,
  videoKey,
  title,
  owner,
  purpose = 'study_document',
  signal,
  onStatus,
  maxExpressions = 15,
  scope = 'corpus',
  cache = true,
}: {
  page?: PageState;
  cues: CaptionCue[];
  videoKey: string;
  title: string;
  owner?: string;
  purpose?: ModelPurpose;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
  maxExpressions?: number;
  scope?: 'corpus' | 'single-sentence';
  cache?: boolean;
}): Promise<ExtractedExpression[]> {
  const currentOwner = owner || (await studyOwner());
  const hostedAi = Boolean(import.meta.env.VITE_SHADOW_WEB);
  if (purpose !== 'onboarding' && hostedAi && currentOwner === 'local') {
    throw new Error('请先登录 Shadow Language 账号后使用 AI 表达分析服务。');
  }
  const key = hostedAi ? undefined : await readKey();
  if (!hostedAi && !key) {
    throw new Error('请先在 Agent 的 AI 设置中配置 DeepSeek Key。');
  }

  if (!cues.length) {
    throw new Error('当前视频没有加载英文字幕，无法进行表达提炼。');
  }

  onStatus?.('正在读取您的表达复习库与视频字幕…');
  const reviewState = await getExpressionReviewState();
  const existingBundles = reviewState.bundles;
  const existingItems = reviewState.items;

  // Summarize existing expressions for the AI
  const existingSummary = existingBundles.length
    ? existingBundles
        .slice(0, 80)
        .map((b, i) => `${i + 1}. 语块: "${b.chunk}" | 句型: "${b.pattern}" | 含义: ${b.meaningZh || b.intentZh}`)
        .join('\n')
    : '（用户表达复习库目前为空，均为新知识）';

  // Format transcript with timestamps
  const transcriptLines = cues
    .map(c => `[${Math.floor(c.startMs / 60000)}:${String(Math.floor(c.startMs / 1000) % 60).padStart(2, '0')}] ${c.text}`)
    .join('\n')
    .slice(0, 50000);

  const expressionLimit = Math.max(1, Math.min(15, Math.round(maxExpressions)));
  const userPrompt = `【视频信息】
标题：${title}
视频ID/Key：${videoKey}

【用户既有表达复习库（已收录的语块与句型）】
${existingSummary}

【视频英文字幕（带时间戳）】
${transcriptLines}

请仔细分析上述英文字幕，提炼 ${expressionLimit} 条以内最具口语复用价值的语块与可复用句型。对照用户的表达库，准确标记出旧知识复现（isExisting: true）与新知识（isExisting: false），生成结构化数据。${scope === 'single-sentence' ? '当前只允许从这一条句子提炼，不要引用上下文中的其他句子。' : ''}严格输出 JSON。`;

  onStatus?.('AI 正在提炼高频语块与句型结构，对照复习库中…');

  const abortController = new AbortController();
  if (signal) {
    signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const response = await completeModel({
    ...(key ? { key } : {}),
    purpose,
    messages: [
      { role: 'system', content: scope === 'single-sentence' ? SINGLE_SENTENCE_SYSTEM_PROMPT : SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    signal: abortController.signal,
  });

  if (!response.content?.trim()) {
    throw new Error('AI 未返回有效内容，请重试。');
  }

  onStatus?.('正在校验表达结构并与本地表达库对齐…');
  const expressions = parseExpressionAnalysisJson(response.content, existingBundles, existingItems, cues).slice(0, expressionLimit);

  if (!expressions.length) {
    throw new Error('AI 分析完成，但未能提取出结构化表达，请重试。');
  }

  // Cache to document database
  if (cache) await saveCachedExpressionAnalysis(currentOwner, videoKey, expressions);

  return expressions;
}

export async function analyzeSentenceExpressions({
  page,
  sentence,
  videoKey,
  title,
  owner,
  purpose = 'study_document',
  signal,
  onStatus,
}: {
  page: PageState;
  sentence: IntensiveSentenceCandidate;
  videoKey: string;
  title: string;
  owner?: string;
  purpose?: ModelPurpose;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
}): Promise<ExtractedExpression[]> {
  const cue: CaptionCue = {
    seq: 0,
    startMs: Math.max(0, Math.round(sentence.startMs)),
    endMs: Math.max(Math.round(sentence.startMs) + 1, Math.round(sentence.endMs)),
    text: sentence.text,
  };
  return analyzeCorpusExpressions({
    page,
    cues: [cue],
    videoKey,
    title,
    ...(owner ? { owner } : {}),
    purpose,
    ...(signal ? { signal } : {}),
    ...(onStatus ? { onStatus } : {}),
    maxExpressions: 3,
    scope: 'single-sentence',
    cache: false,
  });
}

export function toExpressionBundleInput(
  expr: ExtractedExpression,
  page?: PageState,
): ExpressionBundleInput {
  const now = Date.now();
  const videoKey = page ? videoKeyOf(page) : 'general';
  const startMs = expr.startMs || 0;
  const sourceSegment = page?.segments.find((segment) => Math.abs(segment.startMs - startMs) < 1_000)
    || page?.segments.find((segment) => startMs >= segment.startMs && startMs < segment.endMs);
  const segmentSeq = sourceSegment ? Math.max(0, page!.segments.indexOf(sourceSegment)) : 0;

  return {
    id: `expression_${randomId()}`,
    chunk: expr.chunk,
    pattern: expr.pattern || expr.chunk,
    sourceSentence: expr.sourceSentence || expr.chunk,
    meaningZh: expr.meaningZh,
    intentZh: expr.intentZh,
    slots: expr.slots || [],
    acceptedVariants: [expr.chunk, expr.pattern].filter(Boolean),
    source: {
      type: 'video',
      videoKey,
      title: page?.title || '视频语料',
      ...(page?.canonicalUrl ? { canonicalUrl: page.canonicalUrl } : {}),
      ...(page?.thumbnailUrl ? { thumbnailUrl: page.thumbnailUrl } : {}),
      trackId: page?.activeTrackId ?? null,
      segmentSeq,
      startMs,
      ...(sourceSegment ? { endMs: sourceSegment.endMs } : {}),
      contextText: expr.sourceSentence || expr.chunk,
    },
    provenance: {
      kind: 'user-confirmed',
      extractor: 'ai-suggested',
      version: 'expression-analysis-v1',
    },
    createdAt: now,
    updatedAt: now,
  };
}
