import { byteSize, cuesToLearningSegments, videoKeyOf, type CaptionCue, type PageState, randomId } from '@shadow-language/contracts';
import { db, type CaptionCache } from './db';

/** Only explicit user imports enter these tables; fetched public captions are
 * still a device cache. Chunks avoid a huge document or a whole-file upload on
 * each playback tick. Each generation is immutable; the manifest is merged. */
export async function saveUserTranscript(page: PageState): Promise<void> {
  const videoKey = videoKeyOf(page);
  if (!videoKey || !page.cues.length) return;
  const generation = randomId();
  const groups: CaptionCue[][] = [];
  let group: CaptionCue[] = [], size = 0;
  for (const cue of page.cues) {
    const bytes = byteSize(cue);
    if (bytes > 48 * 1024) throw new Error('单条字幕过长，请拆分后重新导入。');
    if (size + bytes > 48 * 1024 && group.length) { groups.push(group); group = []; size = 0; }
    group.push(cue); size += bytes;
  }
  if (group.length) groups.push(group);
  if (groups.length > 512) throw new Error('字幕分片过多，请缩短后重新导入。');
  const chunks = groups.map((cues, index) => ({ id: `${generation}:${index}`, videoKey, generation, index, cues }));
  const manifest = { id: videoKey, generation, chunkCount: chunks.length, trackId: page.activeTrackId || `local:${generation}`, title: page.title, durationMs: page.durationMs, updatedAt: Date.now() };
  await db.transaction('rw', db.table('userTranscripts'), db.table('transcriptChunks'), async () => {
    await db.table('transcriptChunks').where('videoKey').equals(videoKey).delete();
    await db.table('transcriptChunks').bulkPut(chunks);
    await db.table('userTranscripts').put(manifest);
  });
}
export async function readUserTranscript(videoKey: string): Promise<CaptionCache | undefined> {
  const manifest = await db.table('userTranscripts').get(videoKey);
  if (!manifest) return;
  const chunks = await db.table('transcriptChunks').where('generation').equals(manifest.generation).toArray();
  chunks.sort((a, b) => a.index - b.index);
  // Never replace a working transcript with a partially downloaded generation.
  if (chunks.length !== manifest.chunkCount || chunks.some((row, index) => row.index !== index || row.videoKey !== videoKey)) return;
  const cues = chunks.flatMap(row => row.cues);
  return { id: `user:${videoKey}`, youtubeId: videoKey, trackId: manifest.trackId, adapterVersion: 'user-import-v1', cues, cachedAt: manifest.updatedAt, page: { videoKey, youtubeId: videoKey.startsWith('media:') || videoKey.startsWith('bilibili:') ? null : videoKey, platform: videoKey.startsWith('media:') ? 'media' : videoKey.startsWith('bilibili:') ? 'bilibili' : 'youtube', title: manifest.title || '', canonicalUrl: '', durationMs: manifest.durationMs || cues.at(-1)?.endMs || 0, timeMs: 0, playerState: 'paused', playbackRate: 1, tracks: [], activeTrackId: manifest.trackId, cues, segments: cuesToLearningSegments(cues, { allowOverlap: true }) } };
}
