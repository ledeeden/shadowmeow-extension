import { videoKeyOf, videoUrl, videoThumbnail } from '@shadow-language/contracts';
import type { AgentSource } from './store';
import { vocabularyTierForSize } from '../vocabulary-profile';

/** Sources are built from actual tool records, never guessed from generated prose. */
export function sourcesFromTool(name: string, result: unknown): AgentSource[] {
  if (!result || typeof result !== 'object') return [];
  const value = result as Record<string, unknown>;
  const records = (Array.isArray(result) ? result : Array.isArray(value.items) ? value.items : []) as Array<Record<string, unknown>>;
  const sources: AgentSource[] = [];
  if (['history_search', 'assets_search', 'corpus_search'].includes(name)) {
    for (const row of records) {
      const key = videoKeyOf(row as { videoKey?: string; youtubeId?: string });
      if (!key) continue;
      const ms = typeof row.positionMs === 'number' ? row.positionMs : typeof row.startMs === 'number' ? row.startMs : 0;
      const analysis = row.analysis && typeof row.analysis === 'object' ? row.analysis as Record<string, unknown> : {};
      const recommendation = analysis.recommendedVocabulary && typeof analysis.recommendedVocabulary === 'object' ? analysis.recommendedVocabulary as Record<string, unknown> : {};
      const detail = [
        row.channel || row.channelTitle || '视频',
        name === 'corpus_search' && typeof analysis.activeWpm === 'number' ? `${Math.round(analysis.activeWpm)} 词/分钟` : '',
        name === 'corpus_search' && typeof recommendation.threshold === 'number' ? `${vocabularyTierForSize(Math.round(recommendation.threshold)).label}${recommendation.reachable === false ? '+' : ''}` : '',
      ].filter(Boolean).join(' · ');
      try { sources.push({ id: `video:${key}`, kind: 'video', title: String(row.title || row.displayValue || '打开视频'), href: videoUrl(key, ms), thumbnail: videoThumbnail({ videoKey: key }), detail }); } catch { /* Invalid source identities are not shown as links. */ }
    }
  }
  if (name === 'knowledge_search') {
    for (const row of (Array.isArray(value.notes) ? value.notes : [])) sources.push({ id: row.id, kind: 'note', title: row.reference?.highlight || row.reference?.title || '视频笔记', href: `#note=${encodeURIComponent(row.id)}`, detail: row.reference?.title || '笔记' });
    for (const row of (Array.isArray(value.documents) ? value.documents : [])) sources.push({ id: row.id, kind: 'document', title: row.title, href: `#knowledge=${encodeURIComponent(row.id)}`, detail: '知识库' });
  }
  if (name === 'knowledge_read' && typeof value.id === 'string') sources.push({ id: value.id, kind: value.kind === 'note' ? 'note' : 'document', title: String(value.title || (value.reference as { highlight?: string } | undefined)?.highlight || '知识资料'), href: `#${value.kind === 'note' ? 'note' : 'knowledge'}=${encodeURIComponent(value.id)}`, detail: '知识库' });
  return sources;
}
