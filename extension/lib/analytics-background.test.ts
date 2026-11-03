import { beforeEach, expect, it, vi } from 'vitest';
let state: Record<string, unknown> = {};
vi.mock('./cloudbase', () => ({ getAuthStatus: vi.fn(async () => ({ signedIn: false, user: null })), getCloudBaseApp: vi.fn() }));
vi.mock('./constants', () => ({ EXTENSION_VERSION: 'test.1' }));
beforeEach(async () => { const { getAuthStatus } = await import('./cloudbase'); vi.mocked(getAuthStatus).mockResolvedValue({ signedIn: false, user: null }); state = {}; vi.resetModules(); vi.stubGlobal('browser', { storage: { local: { get: vi.fn(async (key: string) => ({ [key]: structuredClone(state[key]) })), set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(state, structuredClone(value)); }) } } }); });
it('serializes concurrent writes and persists only explicit non-content fields', async () => {
  const { enqueueAnalytics } = await import('./analytics-background');
  await Promise.all(Array.from({ length: 25 }, () => enqueueAnalytics({ name: 'feature', feature: 'replay', ...{ text: 'private transcript', url: 'https://secret.test', apiKey: 'secret' } })));
  const saved = state.betaAnalyticsV1 as { events: unknown[] }; expect(saved.events).toHaveLength(25);
  expect(JSON.stringify(saved)).not.toContain('private'); expect(JSON.stringify(saved)).not.toContain('secret');
});
it('retains events on failed uploads and does not lose new events during a successful upload', async () => {
  const { enqueueAnalytics, flushAnalytics } = await import('./analytics-background');
  await enqueueAnalytics({ name: 'open' });
  vi.stubGlobal('fetch', vi.fn(async () => { await enqueueAnalytics({ name: 'feature', feature: 'replay' }); return { ok: true, json: async () => ({ ok: true }) }; }));
  await flushAnalytics();
  expect((state.betaAnalyticsV1 as any).events).toHaveLength(1);
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('offline'); })); await flushAnalytics();
  expect((state.betaAnalyticsV1 as any).events).toHaveLength(1); expect((state.betaAnalyticsV1 as any).retryAt).toBeGreaterThan(Date.now());
});
it('drops expired events before uploading so an old event cannot block the batch', async () => {
 const { enqueueAnalytics, flushAnalytics } = await import('./analytics-background'); await enqueueAnalytics({ name: 'open' });
 (state.betaAnalyticsV1 as any).events[0].occurredAt = Date.now() - 8 * 86400000;
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await flushAnalytics(); expect(fetch).not.toHaveBeenCalled();
});

it('captures account identity per event and does not relabel queued events after logout or switching accounts', async()=>{
 const { getAuthStatus, getCloudBaseApp }=await import('./cloudbase');
 vi.mocked(getAuthStatus).mockResolvedValue({signedIn:true,user:{uid:'user-a'}});
 vi.mocked(getCloudBaseApp).mockResolvedValue({callFunction:async()=>({result:{ok:true,identity:{userId:'user-a',email:'a@example.test',proof:'proof-a',expiresAt:Date.now()+15*86400000}}})} as any);
 const {enqueueAnalytics,flushAnalytics}=await import('./analytics-background');await enqueueAnalytics({name:'open'});
 vi.mocked(getAuthStatus).mockResolvedValue({signedIn:false,user:null});await enqueueAnalytics({name:'open'});
 const rows=(state.betaAnalyticsV1 as any).events;expect(rows[0].identityUserId).toBe('user-a');expect(rows[1].identityUserId).toBeUndefined();
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({ok:true})}));vi.stubGlobal('fetch',fetch);await flushAnalytics();
 const body=JSON.parse((fetch.mock.calls[0] as any)[1].body);expect(body.events[0].identityProof).toBe('proof-a');expect(body.events[1].identityProof).toBeUndefined();expect(body.events[0].identityUserId).toBeUndefined();
});
