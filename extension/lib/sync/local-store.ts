import Dexie, { type Table, type Transaction } from 'dexie';
import { SYNC_LIMITS, vocabularySyncKey, applyFields, byteSize, equalJson, flattenSyncData, randomId, syncProjection, type JsonRecord, type SyncAck, type SyncMutation, type SyncRecord, type SyncTable } from '@shadow-language/contracts';

export const SYNC_STORES = {
  _syncOutbox: 'id,status,updatedAt', _syncMeta: 'id', _syncState: 'id', _syncConflicts: 'id,createdAt',
};
export type PendingMutation = SyncMutation & { id: string; status: 'pending' | 'blocked'; updatedAt: number; error?: string; localValue?: JsonRecord };
export type LocalSyncMeta = { id: string; revision: number; fieldVersions: Record<string, number>; lastAck?: string };
export type SyncConflict = { id: string; table: SyncTable; key: string; local: SyncMutation; remote: SyncRecord; fields: string[]; createdAt: number; localRecord?: JsonRecord; resolution?: 'automatic'; resolvedAt?: number };
export const outboxTable = (database: Dexie): Table<PendingMutation, string> => database.table('_syncOutbox');
export const metaTable = (database: Dexie): Table<LocalSyncMeta, string> => database.table('_syncMeta');
export const stateTable = (database: Dexie): Table<JsonRecord & { id: string }, string> => database.table('_syncState');
export const conflictTable = (database: Dexie): Table<SyncConflict, string> => database.table('_syncConflicts');
export const entityId = (table: string, key: string) => `${table}|${key}`;
export const localTableName = (table: SyncTable) => table.replace(/^agent\./, '');

/** Upgrade old conflict copies in place. Never delete copies, replay their
 * counters/events, or overwrite edits made after the original conflict. The
 * canonical result was already applied when the old ACK was received. */
export async function archiveLegacyConflicts(database: Dexie): Promise<void> {
  const table = conflictTable(database);
  await database.transaction('rw', table, async () => {
    for (const row of await table.toArray()) {
      if (!row.resolution) await table.put({ ...row, resolution: 'automatic', resolvedAt: Date.now() });
    }
  });
}

export async function restoreRecoveryCopies(database: Dexie, copies: SyncConflict[]): Promise<void> {
  const table = conflictTable(database);
  await database.transaction('rw', table, async () => {
    for (const row of copies) {
      if (!await table.get(row.id)) await table.put({ ...row, resolution: 'automatic', resolvedAt: row.resolvedAt || Date.now() });
    }
  });
}

type NativeTransaction = IDBTransaction & { shadowSyncOrigin?: 'remote' | 'seed'; shadowDerivedReview?: boolean };
function native(tx: Transaction): NativeTransaction { return tx.idbtrans as NativeTransaction; }
export async function withoutSync<T>(database: Dexie, tables: Table[], fn: () => Promise<T>): Promise<T> {
  return database.transaction('rw', [...tables, ...Object.keys(SYNC_STORES).map(name => database.table(name))], async tx => {
    native(tx).shadowSyncOrigin = 'remote';
    return fn();
  });
}
/** SRS state is optimistically materialized locally; only the review event is
 * uploaded. The server serializes every accepted event exactly once. */
export function markDerivedReview(tx: Transaction): void { native(tx).shadowDerivedReview = true; }

export function installChangeJournal(database: Dexie, tableMap: Record<string, SyncTable>, changed: () => void, writable: () => boolean = () => true): void {
  const notified = new WeakSet<object>();
  database.use({
    stack: 'dbcore', name: 'shadow-local-first',
    create: (down: any) => ({
      ...down,
      transaction(stores: string[], mode: IDBTransactionMode, options: any) {
        const tracked = mode === 'readwrite' && stores.some(name => tableMap[name]);
        return down.transaction(tracked ? [...new Set([...stores, ...Object.keys(SYNC_STORES)])] : stores, mode, options);
      },
      table(name: string) {
        const lower = down.table(name);
        const table = tableMap[name];
        if (!table) return lower;
        return {
          ...lower,
          async mutate(req: any) {
            const trans = req.trans as NativeTransaction;
            if (trans.shadowSyncOrigin === 'remote') return lower.mutate(req);
            if (!writable()) throw new Error('账号会话已切换，请刷新页面后再保存。');
            let keys: any[];
            let previous: JsonRecord[];
            if (req.type === 'deleteRange') {
              const result = await lower.query({ trans, values: true, limit: Infinity, query: { index: lower.schema.primaryKey, range: req.range } });
              previous = result.result;
              keys = previous.map(value => lower.schema.primaryKey.extractKey(value));
            } else {
              keys = req.keys || req.values.map((value: JsonRecord) => lower.schema.primaryKey.extractKey(value));
              previous = await lower.getMany({ trans, keys, cache: 'immutable' });
            }
            const result = await lower.mutate(req);
            const pendingStore = down.table('_syncOutbox');
            const metas = down.table('_syncMeta');
            for (let index = 0; index < keys.length; index += 1) {
              if (result.failures?.[index]) continue;
              const key = String(keys[index]);
              const oldRow = previous[index];
              const row = req.type === 'delete' || req.type === 'deleteRange' ? undefined : req.values[index];
              if (!row && !oldRow) continue;
              const id = entityId(table, key);
              const [prior] = await pendingStore.getMany({ trans, keys: [id] });
              const [meta] = await metas.getMany({ trans, keys: [id] });
              const before = oldRow ? syncProjection(table, oldRow) : {};
              const after = row ? syncProjection(table, row) : {};
              const deleted = !row || (table === 'assets' && Boolean(row.deletedAt));
              const fields = { ...(prior?.fields || {}) };
              const a = flattenSyncData(table, before), b = flattenSyncData(table, after);
              let meaningful = deleted !== Boolean(prior?.deleted) && deleted;
              for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
                if (table === 'progress' && path === 'activeSecondsTotal' && trans.shadowSyncOrigin !== 'seed') continue;
                if (oldRow && trans.shadowDerivedReview && ['vocabulary', 'expressionReviewItems'].includes(table) && ['fsrs', 'due', 'status', 'updatedAt'].includes(path)) continue;
                if (equalJson(a[path], b[path])) continue;
                meaningful = true;
                fields[path] = b[path] === undefined ? { remove: true, base: prior?.fields[path]?.base ?? meta?.fieldVersions[path] ?? 0 }
                  : { value: b[path], base: prior?.fields[path]?.base ?? meta?.fieldVersions[path] ?? 0 };
              }
              const delta = table === 'progress' && trans.shadowSyncOrigin !== 'seed'
                ? Math.max(0, Math.round(Number(after.activeSecondsTotal || 0) - Number(before.activeSecondsTotal || 0))) : 0;
              if (!meaningful && !delta) continue;
              const record: PendingMutation = {
                id, table, key, mutationId: randomId(), baseRevision: prior?.baseRevision ?? meta?.revision ?? 0,
                fields, deleted, ...(table === 'progress' ? { activeSeconds: (prior?.activeSeconds || 0) + delta } : {}),
                ...(prior?.seed || trans.shadowSyncOrigin === 'seed' ? { seed: true } : {}),
                status: 'pending', updatedAt: Date.now(), localValue: row ? after : before,
              };
              if (byteSize({ ...record, localValue: undefined }) > SYNC_LIMITS.recordBytes) { record.status = 'blocked'; record.error = '该记录超过 128 KiB，已保存在本地。请导出备份或缩短内容后重试。'; }
              const journalResult = await pendingStore.mutate({ trans, type: 'put', values: [record] });
              if (journalResult.numFailures) throw new Error('本地同步日志写入失败；本次保存已回滚，请检查设备空间。');
            }
            if (!notified.has(trans)) { notified.add(trans); trans.addEventListener('complete', changed, { once: true }); }
            return result;
          },
        };
      },
    }),
  });
}

/** One-time, explicit migration. Existing server records win conflicts; local
 * alternatives are retained in _syncConflicts, never silently discarded. */
export async function seedRecords(database: Dexie, table: SyncTable, rows: JsonRecord[]): Promise<void> {
  const local = database.table(localTableName(table));
  await database.transaction('rw', [local, ...Object.keys(SYNC_STORES).map(name => database.table(name))], async tx => {
    native(tx).shadowSyncOrigin = 'seed';
    for (const row of rows) {
      // A migration never overwrites data already accumulated in this account.
      if (!await local.get(row.id)) await local.put(row);
    }
  });
}

function materialize(record: SyncRecord, owner: string, old: JsonRecord | undefined): JsonRecord {
  const value: JsonRecord = { ...record.data, id: record.key };
  if (record.table.startsWith('agent.')) {
    value.owner = owner;
    // Binary attachments and public player caches belong to this device only.
    if (old?.videoContext) value.videoContext = old.videoContext;
    if (Array.isArray(value.attachments)) value.attachments = value.attachments.map((attachment: JsonRecord) => {
      const local = old?.attachments?.find((entry: JsonRecord) => entry.id === attachment.id);
      return local?.dataUrl ? { ...attachment, dataUrl: local.dataUrl } : attachment;
    });
  }
  if (record.table === 'progress') { value.activeSecondsDelta = 0; if (old?.analysis) value.analysis = old.analysis; }
  if (['progress', 'attempts', 'assets'].includes(record.table)) value.syncStatus = 'synced';
  return value;
}

/** ACK application is transactional per database. lastAck makes a crash between
 * the two IndexedDB databases safe: replay cannot subtract counters twice. */
export async function applyServerRecords(database: Dexie, owner: string, records: SyncRecord[], acks: SyncAck[], sent: SyncMutation[], recoveries: Record<string, JsonRecord> = {}): Promise<void> {
  const names = [...new Set([...records, ...acks.map(ack => ack.record)].map(record => localTableName(record.table)))];
  if (!names.length) return;
  await withoutSync(database, names.map(name => database.table(name)), async () => {
    // Card effects may be on a later response page. Keep optimistic SRS visible
    // until that specific canonical card revision has arrived; no counter replay.
    for (const ack of acks) for (const effect of ack.effects || []) {
      const key = `derived:${entityId(effect.table, effect.key)}`;
      const previous = await stateTable(database).get(key);
      await stateTable(database).put({ id: key, revision: Math.max(previous?.revision || 0, effect.revision) });
    }
    const acknowledgedIds = new Set(acks.map(ack => ack.mutationId));
    const pendingReviews = (await outboxTable(database).toArray()).filter(op => !op.deleted && !op.seed && !acknowledgedIds.has(op.mutationId) && ['vocabularyReviews', 'expressionReviewLogs'].includes(op.table));
    const acknowledgements = new Map(acks.map(ack => [entityId(ack.record.table, ack.record.key), ack]));
    const incoming = new Map([...acks.map(ack => ack.record), ...records].map(record => [entityId(record.table, record.key), record]));
    // A later pull may be newer than the ACK (or a previous pull in another tab).
    for (const record of [...acks.map(ack => ack.record), ...records]) {
      const id = entityId(record.table, record.key);
      if ((incoming.get(id)?.revision || 0) < record.revision) incoming.set(id, record);
    }
    for (const [id, record] of incoming) {
      const table = database.table(localTableName(record.table));
      const meta = await metaTable(database).get(id);
      let pending = await outboxTable(database).get(id);
      const ack = acknowledgements.get(id);
      const snapshot = ack && sent.find(op => op.mutationId === ack.mutationId);
      if (ack && snapshot && meta?.lastAck !== ack.mutationId) {
        const localRecord = recoveries[ack.mutationId] || pending?.localValue;
        if (ack.conflictFields.length || ack.rejected) await conflictTable(database).put({
          id: ack.mutationId, table: record.table, key: record.key, local: { ...snapshot, ...(ack.activeSecondsApplied ? { activeSeconds: 0 } : {}) }, remote: ack.record,
          ...(localRecord ? { localRecord } : {}),
          fields: ack.conflictFields.length ? ack.conflictFields : [ack.rejected!], createdAt: Date.now(), resolution: 'automatic', resolvedAt: Date.now(),
        });
        if (pending?.mutationId === ack.mutationId) {
          await outboxTable(database).delete(id); pending = undefined;
        } else if (pending) {
          const fields = { ...pending.fields };
          for (const [path, change] of Object.entries(snapshot.fields)) {
            if (equalJson(fields[path], change)) delete fields[path];
            else if (fields[path]) fields[path] = { ...fields[path], base: ack.record.fieldVersions[path] || ack.record.revision };
          }
          const activeSeconds = Math.max(0, (pending.activeSeconds || 0) - (snapshot.activeSeconds || 0));
          pending = { ...pending, fields, baseRevision: ack.record.revision, ...(pending.table === 'progress' ? { activeSeconds } : {}) };
          // Once the imported snapshot is acknowledged, later edits are live,
          // not another seed (which would intentionally defer to cloud history).
          if (snapshot.seed) delete pending.seed;
          if (!Object.keys(fields).length && !activeSeconds && pending.deleted === snapshot.deleted) {
            await outboxTable(database).delete(id); pending = undefined;
          } else await outboxTable(database).put(pending);
        }
      }
      if (meta && meta.revision > record.revision) {
        if (ack) await metaTable(database).put({ ...meta, lastAck: ack.mutationId });
        continue;
      }
      const old = await table.get(record.key);
      if (record.deleted && !pending) await table.delete(record.key);
      else {
        let value = materialize(record, owner, old);
        if (pending) {
          value = applyFields(value, pending.fields);
          if (pending.table === 'progress') value.activeSecondsTotal = Number(record.data.activeSecondsTotal || 0) + (pending.activeSeconds || 0);
          if (pending.deleted) {
            if (record.table === 'assets') value.deletedAt = old?.deletedAt || new Date().toISOString();
            else { await table.delete(record.key); value = null as unknown as JsonRecord; }
          }
          if (value && ['progress', 'attempts', 'assets'].includes(record.table)) value.syncStatus = 'pending';
        }
        if (value && ['vocabulary', 'expressionReviewItems'].includes(record.table)) {
          const effectKey = `derived:${id}`;
          const expected = await stateTable(database).get(effectKey);
          const pendingReview = pendingReviews.some(op => record.table === 'vocabulary'
            ? op.table === 'vocabularyReviews' && typeof (op.fields.word?.value || op.localValue?.word) === 'string' && vocabularySyncKey(op.fields.word?.value || op.localValue?.word) === record.key
            : op.table === 'expressionReviewLogs' && (op.fields.itemId?.value || op.localValue?.itemId) === record.key);
          if (old && (pendingReview || expected?.revision > record.revision)) {
            for (const field of ['fsrs', 'due', 'status', 'updatedAt']) if (old[field] !== undefined) value[field] = old[field];
          }
          if (expected && record.revision >= expected.revision) await stateTable(database).delete(effectKey);
        }
        if (value) await table.put(value);
      }
      await metaTable(database).put({ id, revision: record.revision, fieldVersions: record.fieldVersions, ...(ack ? { lastAck: ack.mutationId } : meta?.lastAck ? { lastAck: meta.lastAck } : {}) });
    }
  });
}
