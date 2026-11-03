import { hydrateVideoTranscript, restoreTranscript, selectTranscript } from '../video-transcript';
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { videoKeyOf, type PageState } from '@shadow-language/contracts';
import { db } from '../db';
import { agentDb } from './store';
import { newWordsPageSignature } from '../../components/new-words-panel';

export type LibraryVideo = { videoKey: string; title: string; updatedAt: number; hasNotes: boolean; page?: PageState };

export function dictationVideoKey(id: string, owner: string): string | null {
  try {
    const value: unknown = JSON.parse(id);
    return Array.isArray(value) && value[0] === owner && typeof value[1] === 'string' ? value[1] : null;
  } catch { return null; }
}

export function useAgentVideoLibrary(owner: string, page?: PageState) {
  const [videos, setVideos] = useState<LibraryVideo[]>([]);
  const [error, setError] = useState('');
  const signature = newWordsPageSignature(page);
  useEffect(() => {
    if (!owner || !page || !videoKeyOf(page)) return;
    // Keep a subtitle snapshot so the vocabulary list can reopen a previous video.
    const snapshot = structuredClone(page);
    void hydrateVideoTranscript(snapshot).then(page => agentDb.videoPages.put({ id: JSON.stringify([owner, videoKeyOf(page)]), owner, page, updatedAt: Date.now() }))
      .catch(() => setError('视频记录保存失败'));
  }, [owner, signature]);

  useEffect(() => {
    setVideos([]); setError('');
    if (!owner) return;
    const subscription = liveQuery(async () => {
      const [dictations, notes, conversations, snapshots, progress, captions, assets] = await Promise.all([
        agentDb.dictations.where('owner').equals(owner).toArray(), agentDb.notes.where('owner').equals(owner).toArray(),
        agentDb.conversations.where('owner').equals(owner).toArray(), agentDb.videoPages.where('owner').equals(owner).toArray(),
        db.progress.toArray(), db.captions.toArray(), db.assets.toArray(),
      ]);
      const rows = new Map<string, LibraryVideo>();
      function add(key: string, title: string, updatedAt: number, hasNotes = false, context?: PageState) {
        const previous = rows.get(key);
        rows.set(key, { videoKey: key, title: title || previous?.title || (key === 'general' ? '未关联视频的笔记' : key),
          updatedAt: Math.max(updatedAt, previous?.updatedAt || 0), hasNotes: hasNotes || previous?.hasNotes || false,
          ...(context ? { page: context } : previous?.page ? { page: previous.page } : {}) });
      }
      for (const item of progress) add(item.videoKey || item.youtubeId!, item.title || '', Date.parse(item.occurredAt));
      for (const item of assets.filter(item => !item.deletedAt)) add(item.videoKey || item.youtubeId!, '', Date.parse(item.occurredAt));
      for (const item of conversations) if (item.videoContext) add(videoKeyOf(item.videoContext), item.videoContext.title, item.updatedAt, false, item.videoContext);
      for (const item of snapshots) add(videoKeyOf(item.page), item.page.title, item.updatedAt, false, item.page);
      for (const item of notes) add(item.reference.videoKey, item.reference.title, item.updatedAt, true);
      for (const item of dictations) {
        const key = dictationVideoKey(item.id, owner);
        if (key) add(key, item.title || '', item.updatedAt, true);
      }
      for (const row of rows.values()) {
        if (row.videoKey === 'general' || row.page?.cues.length) continue;
        const cached = selectTranscript(captions, row.videoKey, row.page?.activeTrackId);
        if (row.page && cached) { row.page = restoreTranscript(row.page, cached); continue; }
        row.page = restoreTranscript({ youtubeId: row.videoKey.startsWith('bilibili:') ? null : row.videoKey,
          videoKey: row.videoKey, title: row.title, durationMs: 0, playerState: 'paused', timeMs: 0, playbackRate: 1,
          tracks: [], activeTrackId: cached?.trackId || null, cues: [], segments: [],
          ...(!cached?.cues.length ? { error: '此视频的字幕未缓存在本机，请打开原视频加载生词。' } : {}) }, cached);
      }
      return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }).subscribe({ next: setVideos, error: () => setError('视频列表读取失败，请重新打开') });
    return () => subscription.unsubscribe();
  }, [owner]);
  const key = page ? videoKeyOf(page) : '';
  const available = key ? [{ videoKey: key, title: page!.title, updatedAt: Date.now(), hasNotes: true, page: page!.cues.length ? page : videos.find(item => item.videoKey === key)?.page || page }, ...videos.filter(item => item.videoKey !== key)] : videos;
  return { videos: available, error };
}
