import { analyticsVersion, type AnalyticsEvent } from './analytics';
import { randomId, timeoutSignal } from '@shadow-language/contracts';
const ENDPOINT = import.meta.env.WXT_ANALYTICS_URL || '';
const KEY = 'betaAnalyticsV1';
const FLUSH_LEASE_KEY = 'betaAnalyticsFlushLease';
const FLUSH_LEASE_MS = 20_000;
// learning_tick / agent_request / agent_result / api_result were retired to
// cut the sl_analytics_events write volume. Old events still validate against
// the server-side schema, so historical data continues to render.
const NAMES = new Set(['open', 'caption', 'learning_start', 'feature']);
type Identity = { userId: string; email: string | null; proof: string; expiresAt: number; issuedAt: number };
type Row = AnalyticsEvent & { id: string; occurredAt: number; version: string; identityUserId?: string; identityProof?: string };
async function currentIdentity(installationId: string): Promise<{ userId?: string; proof?: string }> {
  const { getAuthStatus, getCloudBaseApp } = await import('./cloudbase');
  const status = await getAuthStatus();
  const user = status.user as { uid?: string; id?: string; _id?: string } | null;
  const userId = user?.uid || user?.id || user?._id;
  if (!status.signedIn || !userId) return {};
  const cached = (await browser.storage.local.get('betaAnalyticsIdentity')).betaAnalyticsIdentity as Identity | undefined;
  if (cached?.userId === userId && cached.expiresAt > Date.now() + 14 * 86400000) return { userId, proof: cached.proof };
  const retry = (await browser.storage.local.get('betaAnalyticsIdentityRetry')).betaAnalyticsIdentityRetry as { userId: string; until: number } | undefined;
  if (retry?.userId === userId && retry.until > Date.now()) return { userId };
  try {
    const app = await getCloudBaseApp();
    const result = await app.callFunction({ name: 'shadowLanguageAnalytics', data: { action: 'identify', installationId } });
    const response = (typeof result.result === 'string' ? JSON.parse(result.result) : result.result) as { ok?: boolean; identity?: Identity };
    if (response.ok && response.identity?.userId === userId) { await browser.storage.local.set({ betaAnalyticsIdentity: response.identity }); return { userId, proof: response.identity.proof }; }
  } catch { /* Keep account attribution pending until its authenticated identity is available. */ }
  await browser.storage.local.set({ betaAnalyticsIdentityRetry: { userId, until: Date.now() + 60000 } });
  return { userId };
}
type State = { installationId: string; firstSeenAt: number; events: Row[]; retryAt: number; failures: number };
let serial: Promise<unknown> = Promise.resolve();
let flushing = false;
function locked<T>(work: () => Promise<T>): Promise<T> {
  const result = serial.then(work, work); serial = result.catch(() => undefined); return result;
}
async function read(): Promise<State> {
  const data = (await browser.storage.local.get(KEY))[KEY] as State | undefined;
  return data || { installationId: randomId(), firstSeenAt: Date.now(), events: [], retryAt: 0, failures: 0 };
}
async function acquireFlushLease(): Promise<string | null> {
  const current = (await browser.storage.local.get(FLUSH_LEASE_KEY))[FLUSH_LEASE_KEY] as { token?: string; expiresAt?: number } | null | undefined;
  if (current?.token && Number(current.expiresAt) > Date.now()) return null;
  const token = randomId();
  await browser.storage.local.set({ [FLUSH_LEASE_KEY]: { token, expiresAt: Date.now() + FLUSH_LEASE_MS } });
  const verified = (await browser.storage.local.get(FLUSH_LEASE_KEY))[FLUSH_LEASE_KEY] as { token?: string; expiresAt?: number } | null | undefined;
  return verified?.token === token ? token : null;
}
async function releaseFlushLease(token: string): Promise<void> {
  const current = (await browser.storage.local.get(FLUSH_LEASE_KEY))[FLUSH_LEASE_KEY] as { token?: string } | null | undefined;
  if (current?.token === token) await browser.storage.local.set({ [FLUSH_LEASE_KEY]: null });
}
export async function enqueueAnalytics(input: AnalyticsEvent): Promise<void> {
  if (!NAMES.has(input?.name)) return;
  await locked(async () => {
    const state = await read();
    const identity = await currentIdentity(state.installationId);
    const event: Row = { id: randomId(), occurredAt: Date.now(), version: analyticsVersion, name: input.name, ...(identity.userId ? { identityUserId: identity.userId } : {}), ...(identity.proof ? { identityProof: identity.proof } : {}) };
    if (input.platform && ['youtube', 'bilibili', 'extension'].includes(input.platform || '')) event.platform = input.platform;
    if (input.feature && /^(dashboard|agent|lookup_click|lookup_hover|replay|loop_on|loop_off|subtitle_all|subtitle_new|subtitle_hidden|subtitle_toggle|save_word|save_asset|agent_replay|agent_save|result_open|speed|review)$/.test(input.feature)) event.feature = input.feature;
    if (input.outcome && ['success', 'failure', 'cancelled'].includes(input.outcome || '')) event.outcome = input.outcome;
    if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) event.durationMs = Math.max(0, Math.min(3600000, Math.round(input.durationMs)));
    if (input.sessionId && /^[a-f0-9-]{36}$/.test(input.sessionId)) event.sessionId = input.sessionId;
    if (input.operation && /^[a-zA-Z.]{1,64}$/.test(input.operation)) event.operation = input.operation;
    state.events = state.events.filter(row => row.occurredAt > Date.now() - 7 * 86400000).slice(-1999);
    state.events.push(event);
    await browser.storage.local.set({ [KEY]: state });
  });
}
export async function flushAnalytics(): Promise<void> {
  if (flushing) return; flushing = true;
  let leaseToken: string | null = null;
  try {
    leaseToken = await acquireFlushLease();
    if (!leaseToken) return;
    const snapshot = await locked(async () => { const state = await read(); state.events = state.events.filter(row => row.occurredAt > Date.now() - 7 * 86400000 + 60000); await browser.storage.local.set({ [KEY]: state }); return state; });
    if (!snapshot.events.length || snapshot.retryAt > Date.now()) return;
    const identity = await currentIdentity(snapshot.installationId);
    const candidates = snapshot.events.filter(row => !row.identityUserId || row.identityProof || (row.identityUserId === identity.userId && identity.proof)).slice(0, 100);
    if (!candidates.length) return;
    const events = candidates.map(({ identityUserId, ...row }) => ({ ...row, ...(identityUserId && identityUserId === identity.userId && identity.proof ? { identityProof: identity.proof } : {}) }));
    const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'ingest', installationId: snapshot.installationId, firstSeenAt: snapshot.firstSeenAt, events }), signal: timeoutSignal(15000) });
    if (!response.ok || !(await response.json()).ok) throw new Error('upload');
    await locked(async () => { const state = await read(); const ids = new Set(events.map(row => row.id)); state.events = state.events.filter(row => !ids.has(row.id)); state.failures = 0; state.retryAt = 0; await browser.storage.local.set({ [KEY]: state }); });
  } catch {
    await locked(async () => { const state = await read(); state.failures += 1; state.retryAt = Date.now() + Math.min(3600000, 15000 * 2 ** Math.min(state.failures, 8)); await browser.storage.local.set({ [KEY]: state }); }).catch(() => undefined);
  } finally { if (leaseToken) await releaseFlushLease(leaseToken).catch(() => undefined); flushing = false; }
}
