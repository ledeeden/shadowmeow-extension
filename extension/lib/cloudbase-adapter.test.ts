import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudBaseServiceWorkerRequest, cloudExtensionAdapter, createCloudBaseStorage, readCloudBaseResponse } from './cloudbase-adapter';

afterEach(() => vi.unstubAllGlobals());

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys?: string | string[] | null) {
      if (keys == null) return { ...data };
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(selected.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(items: Record<string, unknown>) { Object.assign(data, items); },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  };
}

describe('CloudBase MV3 storage adapter', () => {
  it('uses synchronous adapter storage while persisting OAuth credentials', async () => {
    const local = memoryStorage();
    const session = memoryStorage();
    vi.stubGlobal('browser', { storage: { local, session } });

    const adapter = cloudExtensionAdapter.genAdapter();
    expect(adapter.primaryStorage).toBe('none');
    expect(adapter.localStorage.mode).toBe('sync');
    await adapter.localStorage.ready;
  });

  it('persists namespaced credentials and never clears extension learning data', async () => {
    const area = memoryStorage({ learningData: 'keep', 'cloudbase-sdk:old': 'remove' });
    const storage = createCloudBaseStorage(area);
    await storage.ready;
    storage.setItem('token', 'secret');
    expect(storage.getItem('token')).toBe('secret');
    storage.clear();
    await storage.flush();
    expect(area.data).toEqual({ learningData: 'keep' });
  });

  it('makes credentials readable before an asynchronous browser storage write finishes', async () => {
    let finishWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { finishWrite = resolve; });
    const area = memoryStorage();
    const originalSet = area.set;
    area.set = async (items) => {
      await writeBlocked;
      await originalSet(items);
    };
    const storage = createCloudBaseStorage(area);
    await storage.ready;

    storage.setItem('credentials_test', 'new-session');
    expect(storage.getItem('credentials_test')).toBe('new-session');
    expect(area.data).toEqual({});

    finishWrite();
    await storage.flush();
    expect(area.data).toEqual({ 'cloudbase-sdk:credentials_test': 'new-session' });
  });

  it('does not let startup hydration overwrite a concurrent credential write', async () => {
    let finishRead!: () => void;
    let markReadStarted!: () => void;
    const readBlocked = new Promise<void>((resolve) => { finishRead = resolve; });
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const area = memoryStorage();
    const originalGet = area.get;
    area.get = async (keys) => {
      const snapshot = await originalGet(keys);
      markReadStarted();
      await readBlocked;
      return snapshot;
    };
    const storage = createCloudBaseStorage(area);

    await readStarted;
    storage.setItem('credentials_test', 'new-session');
    finishRead();

    await storage.ready;
    await storage.flush();
    expect(storage.getItem('credentials_test')).toBe('new-session');
  });

  it('never exposes a Promise through the SDK synchronous storage path', async () => {
    const area = memoryStorage({ 'cloudbase-sdk:lang_test': 'zh-CN' });
    const storage = createCloudBaseStorage(area);
    await storage.ready;

    const language = storage.getItem('lang_test');
    expect(language).toBe('zh-CN');
    expect(language).not.toBeInstanceOf(Promise);
    storage.setItem('lang_test', language!);
    expect(storage.getItem('lang_test')).toBe('zh-CN');
  });

  it('uses fetch for CloudBase requests in a service worker without XMLHttpRequest', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ session: null, verifyOtp: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('XMLHttpRequest', undefined);

    const request = new CloudBaseServiceWorkerRequest({ timeout: 1_000, restrictedMethods: ['post'] });
    await expect(request.post({
      url: '//example.tcb-api.tencentcloudapi.com/auth/v1/signup',
      headers: { 'content-type': 'application/json' },
      data: { email: 'learner@example.com', password: 'password123' },
    })).resolves.toMatchObject({
      data: { session: null, verifyOtp: true },
      statusCode: 200,
      header: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.tcb-api.tencentcloudapi.com/auth/v1/signup',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'learner@example.com', password: 'password123' }) }),
    );
  });

  it('accepts empty JSON responses instead of throwing an end-of-input parse error', async () => {
    await expect(readCloudBaseResponse(new Response(null, {
      status: 204,
      headers: { 'content-type': 'application/json' },
    }))).resolves.toEqual({});
  });

  it('promotes CloudBase HTTP error metadata for the SDK auth adapter', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'aborted',
      error_description: 'smtp is not set',
    }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-503' },
    })));

    const request = new CloudBaseServiceWorkerRequest({ restrictedMethods: ['post'] });
    await expect(request.post({
      url: 'https://example.tcb-api.tencentcloudapi.com/auth/v1/verification',
      headers: { 'content-type': 'application/json' },
      data: { email: 'learner@example.com' },
    })).resolves.toMatchObject({
      code: 'aborted',
      message: 'smtp is not set',
      requestId: 'request-503',
      statusCode: 503,
    });
  });

  it('preserves auth errors returned as an HTTP 200 error payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error_code: 'invalid_provider_code',
      error_description: 'Google OAuth code exchange failed',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-provider' },
    })));

    const request = new CloudBaseServiceWorkerRequest({ restrictedMethods: ['post'] });
    await expect(request.post({
      url: 'https://example.tcb-api.tencentcloudapi.com/auth/v1/provider/token',
      headers: { 'content-type': 'application/json' },
      data: { provider_id: 'google' },
    })).resolves.toMatchObject({
      data: {
        __shadowLanguageProviderErrorCode: 'invalid_provider_code',
        __shadowLanguageProviderErrorDescription: 'Google OAuth code exchange failed',
        __shadowLanguageHttpStatus: 200,
      },
      requestId: 'request-provider',
      statusCode: 200,
    });
  });

  it('keeps HTTP status and request ID when the provider endpoint has an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {
      status: 204,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-empty-provider' },
    })));

    const request = new CloudBaseServiceWorkerRequest({ restrictedMethods: ['post'] });
    await expect(request.post({
      url: 'https://example.tcb-api.tencentcloudapi.com/auth/v1/provider/token',
      headers: { 'content-type': 'application/json' },
      data: { provider_id: 'google' },
    })).resolves.toMatchObject({
      data: {
        __shadowLanguageResponseEmpty: true,
        __shadowLanguageHttpStatus: 204,
        __shadowLanguageRequestId: 'request-empty-provider',
      },
    });
  });
});
