import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const release = { version: '0.2.0', downloadUrl: 'https://cdn.example.com/app.zip', sha256: 'a'.repeat(64), size: 100, publishedAt: '2026-09-13T00:00:00Z' };
let data: Record<string, unknown>;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('WXT_UPDATE_CHECK_URL', 'https://updates.example.com/extension-release');
  data = {};
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ release }) });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('browser', { runtime: { getManifest: () => ({ version: '0.1.0' }) }, storage: { local: {
    get: async () => data,
    set: async (value: Record<string, unknown>) => { Object.assign(data, value); },
  } } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('update checks', () => {
  it('uses the deployed default endpoint when a build has no environment override', async () => {
    vi.stubEnv('WXT_UPDATE_CHECK_URL', '');
    const { checkExtensionUpdate } = await import('./extension-update');
    await checkExtensionUpdate(true);
    expect(fetchMock.mock.calls[0]?.[0].origin).toBe('https://example.com');
  });
  it('caches successful checks while manual checks bypass the cache', async () => {
    const { checkExtensionUpdate } = await import('./extension-update');
    expect((await checkExtensionUpdate()).available).toBe(true);
    await checkExtensionUpdate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await checkExtensionUpdate(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0].searchParams.get('currentVersion')).toBe('0.1.0');
    expect(fetchMock.mock.calls[0]?.[1].credentials).toBe('omit');
  });
  it('does not cache failures as no-update responses', async () => {
    const { checkExtensionUpdate } = await import('./extension-update');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(checkExtensionUpdate()).rejects.toThrow('503');
    expect(Object.keys(data)).toHaveLength(0);
    expect((await checkExtensionUpdate()).available).toBe(true);
  });
  it('rechecks when the cached result belongs to a different installed version', async () => {
    const { checkExtensionUpdate } = await import('./extension-update');
    data['extension-release-check-v1'] = { version: '0.0.1', checkedAt: Date.now(), result: { release: null } };
    expect((await checkExtensionUpdate()).available).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
