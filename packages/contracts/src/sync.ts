/** Local-first protocol v1. Keep this file dependency-free: the same source is
 * compiled into the CloudBase function by scripts/build-sync-core.mjs. */
export const SYNC_VERSION = 1 as const;
/** Lifetime completion is independent of the current Web lesson/assessment. */
export const ONBOARDING_COMPLETION_KEY = 'webOnboardingCompletion';
export type OnboardingCompletion = { version: 1; completed: true; completedAt: number };
export function isOnboardingCompletion(value: unknown): value is OnboardingCompletion {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as OnboardingCompletion;
  return receipt.version === 1 && receipt.completed === true && Number.isFinite(receipt.completedAt) && receipt.completedAt >= 0;
}
export const SYNC_LIMITS = Object.freeze({
  batch: 20, page: 50, requestBytes: 256 * 1024, responseBytes: 512 * 1024,
  recordBytes: 128 * 1024, fields: 96, autoIntervalMs: 2 * 60_000,
  debounceMs: 5_000, foregroundIntervalMs: 2 * 60_000,
  manualIntervalMs: 15_000, clientCallsPerDay: 96,
});
export const SYNC_TABLES = [
  'settings', 'assets', 'progress', 'attempts', 'vocabulary', 'vocabularyReviews',
  'studyMeta', 'userPreferences', 'readerWords', 'userTranscripts', 'transcriptChunks', 'expressionBundles', 'expressionReviewItems', 'expressionReviewLogs',
  'expressionChallengeAttempts', 'agent.conversations', 'agent.messages',
  'agent.notes', 'agent.memories', 'agent.documents', 'agent.dictations',
] as const;
export type SyncTable = typeof SYNC_TABLES[number];
export type JsonRecord = Record<string, any>;
export type FieldChange = { value?: any; remove?: boolean; base: number };
export type SyncMutation = {
  table: SyncTable; key: string; mutationId: string; baseRevision: number;
  fields: Record<string, FieldChange>; deleted: boolean;
  /** Accumulated locally, committed once using the durable client sequence. */
  activeSeconds?: number;
  /** Historical import must NOT replay already materialized SRS reviews. */
  seed?: boolean;
};
export type SyncRecord = {
  table: SyncTable; key: string; revision: number; deleted: boolean;
  data: JsonRecord; fieldVersions: Record<string, number>;
};
export type SyncAck = { mutationId: string; record: SyncRecord; conflictFields: string[]; rejected?: string; activeSecondsApplied?: boolean; effects?: Array<{ table: SyncTable; key: string; revision: number }> };
export type SyncRequest = {
  protocol: 1; expectedUserId: string; clientId: string; sequence: number;
  cursor: number; mutations: SyncMutation[];
};
export type SyncResponse = {
  protocol: 1; sequence: number; acks: SyncAck[]; changes: SyncRecord[];
  cursor: number; hasMore: boolean; legacyPending: boolean; migrationWarnings?: number; features?: { analysisEnabled: boolean };
  serverTime: number; retryAfterMs: number;
  usage: { calls: number; writes: number; bytes: number; records: number; callsLimit: number };
};
export const IMMUTABLE_SYNC_TABLES = new Set<string>([
  'attempts', 'vocabularyReviews', 'expressionReviewLogs', 'expressionChallengeAttempts',
]);
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export function safeKey(key: string): boolean {
  return !!key && key.length <= 512 && !key.includes('\u0000');
}
export function safeField(path: string): boolean {
  return path.length <= 160 && path.split('.').every(part => /^[A-Za-z][\w-]*$/.test(part) && !unsafe.has(part));
}
export function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
export function equalJson(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export function cleanJson(value: any, depth = 0): any {
  if (depth > 24) throw new Error('数据嵌套过深，无法同步。');
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => cleanJson(item, depth + 1) ?? null);
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('同步记录只能包含 JSON 数据。');
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (unsafe.has(key) || key.includes('\u0000')) throw new Error('数据包含不安全的字段。');
    const clean = cleanJson(item, depth + 1);
    if (clean !== undefined) result[key] = clean;
  }
  return result;
}
/** Strip cache / transport metadata, never silently trim user-authored text. */
export function syncProjection(table: SyncTable, row: JsonRecord): JsonRecord {
  const copy = { ...row };
  for (const key of ['_id', 'userId', 'syncStatus']) delete copy[key];
  if (table === 'progress') { delete copy.analysis; delete copy.activeSecondsDelta; }
  if (table === 'settings') {
    for (const key of Object.keys(copy)) if (!['id', 'targetLanguage', 'learnerLevel', 'vocabularySize', 'playbackPreferences', 'updatedAt'].includes(key)) delete copy[key];
  }
  if (table.startsWith('agent.')) {
    delete copy.owner;
    delete copy.videoContext; // Public captions/player cache, not conversation text.
    if (Array.isArray(copy.attachments)) copy.attachments = copy.attachments.map((item: JsonRecord) => {
      const { dataUrl, ...attachment } = item;
      return dataUrl ? { ...attachment, localOnly: true } : attachment;
    });
  }
  return cleanJson(copy);
}
/** Settings are merged per preference; other top-level values (including fsrs,
 * arrays and rich-text bodies) are atomic to avoid broken structured values. */
export function flattenSyncData(table: SyncTable, value: JsonRecord): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'playbackPreferences' && table === 'settings' && item && typeof item === 'object') {
      for (const [pref, entry] of Object.entries(item)) {
        if (pref === 'pageShortcuts' && entry && typeof entry === 'object') {
          for (const [shortcut, binding] of Object.entries(entry)) result[`playbackPreferences.pageShortcuts.${shortcut}`] = binding;
        } else result[`playbackPreferences.${pref}`] = entry;
      }
    } else result[key] = item;
  }
  return result;
}
export function applyFields(data: JsonRecord, fields: Record<string, FieldChange>): JsonRecord {
  const result = cleanJson(data);
  for (const [path, change] of Object.entries(fields)) {
    if (!safeField(path)) throw new Error('同步字段路径无效。');
    const parts = path.split('.');
    let target = result;
    for (const part of parts.slice(0, -1)) target = target[part] && typeof target[part] === 'object' && !Array.isArray(target[part]) ? target[part] : (target[part] = {});
    const key = parts[parts.length - 1]!;
    if (change.remove) delete target[key]; else target[key] = cleanJson(change.value);
  }
  return result;
}
export function validateSyncRequest(input: any): SyncRequest {
  if (!input || input.protocol !== 1 || typeof input.expectedUserId !== 'string' || input.expectedUserId.length > 256 || !input.expectedUserId) throw new Error('Invalid sync identity/protocol');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.clientId) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !Number.isSafeInteger(input.cursor) || input.cursor < 0) throw new Error('Invalid sync cursor/sequence');
  if (!Array.isArray(input.mutations) || input.mutations.length > SYNC_LIMITS.batch || byteSize(input) > SYNC_LIMITS.requestBytes) throw new Error('Sync batch too large');
  const keys = new Set<string>();
  for (const op of input.mutations as SyncMutation[]) {
    if (!(SYNC_TABLES as readonly string[]).includes(op.table) || typeof op.key !== 'string' || !safeKey(op.key) || !/^[\w-]{8,128}$/.test(op.mutationId)) throw new Error('Invalid sync record identity');
    if (keys.has(`${op.table}:${op.key}`)) throw new Error('Duplicate record in batch');
    keys.add(`${op.table}:${op.key}`);
    if (!Number.isSafeInteger(op.baseRevision) || op.baseRevision < 0 || typeof op.deleted !== 'boolean' || !op.fields || typeof op.fields !== 'object' || Array.isArray(op.fields)) throw new Error('Invalid mutation');
    if (Object.keys(op.fields).length > SYNC_LIMITS.fields || byteSize(op) > SYNC_LIMITS.recordBytes) throw new Error('Sync record too large');
    if (op.activeSeconds !== undefined && (op.table !== 'progress' || !Number.isSafeInteger(op.activeSeconds) || op.activeSeconds < 0 || op.activeSeconds > 365 * 86400)) throw new Error('Invalid active seconds');
    if (op.seed !== undefined && typeof op.seed !== 'boolean') throw new Error('Invalid seed flag');
    for (const [path, change] of Object.entries(op.fields)) {
      if (!safeField(path) || ['owner', 'userId', '_id'].includes(path.split('.')[0]!) || !change || !Number.isSafeInteger(change.base) || change.base < 0 || (change.remove !== undefined && typeof change.remove !== 'boolean')) throw new Error('Invalid change');
      if (!change.remove && !Object.hasOwn(change, 'value')) throw new Error('Missing change value');
      if (path.includes('.') && !(op.table === 'settings' && path.startsWith('playbackPreferences.'))) throw new Error('Nested field is not mergeable');
      cleanJson(change.value);
    }
  }
  return input as SyncRequest;
}

/** Validate the complete response before opening a local write transaction. */
export function validateSyncResponse(input: any, request: SyncRequest): SyncResponse {
  if (!input || input.protocol !== 1 || input.sequence !== request.sequence || !Number.isSafeInteger(input.cursor) || input.cursor < request.cursor || !Array.isArray(input.acks) || !Array.isArray(input.changes) || typeof input.hasMore !== 'boolean' || !Number.isFinite(input.retryAfterMs) || input.retryAfterMs < 0 || byteSize(input) > SYNC_LIMITS.responseBytes) throw new Error('云端同步响应格式无效，未修改本地数据。');
  const seen = new Set<string>();
  const sent = new Map(request.mutations.map(op => [op.mutationId, op]));
  for (const ack of input.acks as SyncAck[]) {
    const op = sent.get(ack.mutationId);
    if (!op || seen.has(ack.mutationId) || !ack.record || ack.record.table !== op.table || ack.record.key !== op.key || !Array.isArray(ack.conflictFields)) throw new Error('同步确认与本机请求不匹配。');
    if (ack.effects !== undefined && (!Array.isArray(ack.effects) || ack.effects.length > 2 || ack.effects.some(effect => !['vocabulary', 'expressionReviewItems'].includes(effect.table) || typeof effect.key !== 'string' || !safeKey(effect.key) || !Number.isSafeInteger(effect.revision) || effect.revision < 0))) throw new Error('复习派生版本无效。');
    seen.add(ack.mutationId);
  }
  for (const record of [...input.changes, ...input.acks.map((ack: SyncAck) => ack.record)] as SyncRecord[]) {
    if (!(SYNC_TABLES as readonly string[]).includes(record.table) || typeof record.key !== 'string' || !safeKey(record.key) || !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.deleted !== 'boolean' || !record.data || !record.fieldVersions) throw new Error('云端记录格式无效。');
    cleanJson(record);
    if (!record.deleted && record.data.id !== record.key) throw new Error('云端记录主键不一致。');
    for (const [field, revision] of Object.entries(record.fieldVersions)) if (!safeField(field) || !Number.isSafeInteger(revision) || revision < 0 || revision > record.revision) throw new Error('云端字段版本无效。');
  }
  return input as SyncResponse;
}

/** Keep canonical review targets identical to the existing vocabulary IDs. */
export function vocabularySyncKey(lemma: string): string {
  return `vocab_${lemma.normalize('NFKC').replace(/[\u2018\u2019\u201B\u02BC\u0060\u00B4]/g, "'").trim().toLowerCase().replace(/\s+/g, ' ')}`;
}
