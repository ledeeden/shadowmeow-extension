import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cloudbase', () => ({ callApi: vi.fn() }));
vi.mock('./db', () => ({ db: {} }));

type RecordValue = {
  id: string;
  type: 'progress' | 'attempt' | 'saveAsset' | 'deleteAsset';
  payload: Record<string, unknown>;
  status: 'pending' | 'syncing' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
};

function createFakeDb(initial: RecordValue[]) {
  const records = new Map(initial.map((record) => [record.id, structuredClone(record)]));
  let transactionQueue = Promise.resolve();
  const table = {
    where(index: string) {
      return {
        equals(value: string) {
          const selected = () => [...records.values()].filter((record) => record[index as keyof RecordValue] === value);
          return {
            toArray: async () => selected(),
            primaryKeys: async () => selected().map((record) => record.id),
          };
        },
        anyOf(...values: string[]) {
          return { toArray: async () => [...records.values()].filter((record) => values.includes(record[index as keyof RecordValue] as string)) };
        },
      };
    },
    async get(id: string) { return records.get(id) || undefined; },
    async update(id: string, changes: Record<string, unknown>) {
      const current = records.get(id);
      if (current) records.set(id, { ...current, ...changes } as RecordValue);
    },
    async delete(id: string) { records.delete(id); },
  };
  return {
    outbox: table,
    progress: { update: vi.fn(async () => undefined) },
    attempts: { update: vi.fn(async () => undefined) },
    assets: { update: vi.fn(async () => undefined) },
    transaction: async (_mode: string, _table: unknown, work: () => Promise<unknown>) => {
      const next = transactionQueue.then(work);
      transactionQueue = next.then(() => undefined, () => undefined);
      return next;
    },
    records,
  };
}

describe('outbox coordination', () => {
  beforeEach(() => vi.resetModules());

  it('atomically claims one record when two runtimes flush concurrently', async () => {
    const record: RecordValue = {
      id: 'attempt-001', type: 'attempt', payload: { id: 'attempt-001', youtubeId: 'dQw4w9WgXcQ' },
      status: 'pending', attempts: 0, nextAttemptAt: 0, createdAt: 1, updatedAt: 1,
    };
    const fakeDb = createFakeDb([record]);
    const api = vi.fn(async () => undefined);
    const { flushOutboxWith } = await import('./outbox');
    const [first, second] = await Promise.all([flushOutboxWith(fakeDb as never, api as never, () => 1000), flushOutboxWith(fakeDb as never, api as never, () => 1000)]);
    expect(api).toHaveBeenCalledOnce();
    expect(first.synced + second.synced).toBe(1);
    expect(fakeDb.records.size).toBe(0);
  });

  it('retires legacy progress records locally without calling CloudBase', async () => {
    const record: RecordValue = {
      id: 'progress-001', type: 'progress', payload: { youtubeId: 'dQw4w9WgXcQ' },
      status: 'pending', attempts: 0, nextAttemptAt: 0, createdAt: 1, updatedAt: 1,
    };
    const fakeDb = createFakeDb([record]);
    const api = vi.fn(async () => undefined);
    const { flushOutboxWith } = await import('./outbox');
    const result = await flushOutboxWith(fakeDb as never, api as never, () => 1000);
    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(api).not.toHaveBeenCalled();
    expect(fakeDb.records.size).toBe(0);
  });
});
