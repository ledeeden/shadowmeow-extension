import { videoKeyOf } from '@shadow-language/contracts';
import type { AttemptInput, ProgressInput, SavedItemInput } from '@shadow-language/contracts';
import { callApi } from './cloudbase';
import { db, type OutboxRecord } from './db';
import { normalizeLearningPayloadForCloud } from './learning-sync';

const MAX_ATTEMPTS = 8;
const MAX_BATCH = 20;
const STALE_SYNCING_MS = 2 * 60 * 1000;

type OutboxDatabase = typeof db;
type ApiCaller = typeof callApi;

async function syncRecord(database: OutboxDatabase, api: ApiCaller, record: OutboxRecord): Promise<void> {
  if (record.type === 'progress') {
    // Progress persistence was retired. Drop records created by old clients
    // locally instead of sending a compatibility request for every position.
    const key = videoKeyOf(record.payload as ProgressInput);
    if (key) await database.progress.update(key, { syncStatus: 'synced' });
  }
  if (record.type === 'attempt') {
    const payload = record.payload as AttemptInput;
    await api('learning.recordAttempt', normalizeLearningPayloadForCloud(payload), { idempotencyKey: record.id });
    await database.attempts.update(payload.id, { syncStatus: 'synced' });
  }
  if (record.type === 'saveAsset') {
    const payload = record.payload as SavedItemInput;
    await api('learning.saveAsset', normalizeLearningPayloadForCloud(payload), { idempotencyKey: record.id });
    await database.assets.update(payload.id, { syncStatus: 'synced' });
  }
  if (record.type === 'deleteAsset') {
    const payload = record.payload as { id: string; occurredAt: string };
    await api('learning.deleteAsset', payload, { idempotencyKey: record.id });
    await database.assets.update(payload.id, { syncStatus: 'synced' });
  }
}

async function recoverStaleRecords(database: OutboxDatabase, now: number): Promise<void> {
  const staleBefore = now - STALE_SYNCING_MS;
  await database.transaction('rw', database.outbox, async () => {
    const staleSyncing = (await database.outbox.where('status').equals('syncing').toArray()).filter((record) => record.updatedAt < staleBefore);
    for (const record of staleSyncing) {
      const current = await database.outbox.get(record.id);
      if (current?.status === 'syncing' && current.updatedAt < staleBefore) {
        await database.outbox.update(record.id, { status: 'failed', nextAttemptAt: now, lastError: '同步任务中断，已重新排队。', updatedAt: now });
      }
    }
  });
}

async function claimNextRecord(database: OutboxDatabase, now: number): Promise<OutboxRecord | null> {
  return database.transaction('rw', database.outbox, async () => {
    const candidates = (await database.outbox.where('status').anyOf('pending', 'failed').toArray())
      .filter((record) => record.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const candidate of candidates) {
      const current = await database.outbox.get(candidate.id);
      if (!current || !['pending', 'failed'].includes(current.status) || current.nextAttemptAt > now) continue;
      await database.outbox.update(current.id, { status: 'syncing', updatedAt: now });
      return { ...current, status: 'syncing', updatedAt: now };
    }
    return null;
  });
}

export async function flushOutboxWith(database: OutboxDatabase, api: ApiCaller = callApi, nowProvider: () => number = Date.now): Promise<{ synced: number; failed: number }> {
  await recoverStaleRecords(database, nowProvider());
  let synced = 0;
  let failed = 0;
  for (let count = 0; count < MAX_BATCH; count += 1) {
    const record = await claimNextRecord(database, nowProvider());
    if (!record) break;
    try {
      await syncRecord(database, api, record);
      await database.outbox.delete(record.id);
      synced += 1;
    } catch (error) {
      const attempts = record.attempts + 1;
      const delay = Math.min(60 * 60 * 1000, 2 ** attempts * 15_000) + Math.round(Math.random() * 5_000);
      await database.outbox.update(record.id, {
        status: 'failed',
        attempts,
        nextAttemptAt: nowProvider() + delay,
        lastError: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        updatedAt: nowProvider(),
      });
      if (attempts >= MAX_ATTEMPTS) {
        const payload = record.payload as { id?: string; youtubeId?: string; videoKey?: string };
        if ((record.type === 'saveAsset' || record.type === 'deleteAsset') && payload.id) await database.assets.update(payload.id, { syncStatus: 'failed' });
        if (record.type === 'progress' && videoKeyOf(payload)) await database.progress.update(videoKeyOf(payload), { syncStatus: 'failed' });
        if (record.type === 'attempt' && payload.id) await database.attempts.update(payload.id, { syncStatus: 'failed' });
      }
      failed += 1;
    }
  }
  return { synced, failed };
}

let flushPromise: Promise<{ synced: number; failed: number }> | null = null;

export function flushOutbox(): Promise<{ synced: number; failed: number }> {
  if (!flushPromise) {
    flushPromise = flushOutboxWith(db).finally(() => { flushPromise = null; });
  }
  return flushPromise;
}

export async function retryOutboxNow(): Promise<{ synced: number; failed: number }> {
  const failed = await db.outbox.where('status').equals('failed').primaryKeys();
  const timestamp = Date.now();
  await db.outbox.bulkUpdate(failed.map((key) => ({ key, changes: { status: 'pending' as const, nextAttemptAt: timestamp, updatedAt: timestamp } })));
  return flushOutbox();
}
