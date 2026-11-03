import type { IFetchOptions, IRequestConfig, IRequestOptions, IUploadRequestOptions, ResponseObject } from '@cloudbase/adapter-interface';

const PREFIX = 'cloudbase-sdk:';

type StorageArea = {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

type RequestHeaders = Record<string, string>;

type CloudBaseResponseObject = ResponseObject & {
  code?: string | number;
  message?: string;
  requestId?: string;
};

type ResponseErrorMetadata = {
  code?: string | number;
  message?: string;
};

const PROVIDER_TOKEN_PATH = '/auth/v1/provider/token';

function isProviderTokenRequest(url: string): boolean {
  try {
    return new URL(url, 'https://cloudbase.invalid').pathname === PROVIDER_TOKEN_PATH;
  } catch {
    return url.includes(PROVIDER_TOKEN_PATH);
  }
}

function sensitiveDiagnosticField(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'code'
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('cookie')
    || normalized.includes('authorization');
}

function diagnosticValue(value: unknown, key = '', depth = 0): unknown {
  if (sensitiveDiagnosticField(key)) return '[已隐藏]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (depth >= 3) return '[嵌套内容已省略]';
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => diagnosticValue(item, '', depth + 1));
  if (!value || typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([entryKey, entryValue]) => [
    entryKey,
    diagnosticValue(entryValue, entryKey, depth + 1),
  ]));
}

function containsProviderToken(value: unknown, depth = 0): boolean {
  if (depth >= 4 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsProviderToken(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([key, entryValue]) => (
    key === 'provider_token' && typeof entryValue === 'string' && Boolean(entryValue)
  ) || containsProviderToken(entryValue, depth + 1));
}

function providerTokenResponseData(data: unknown, statusCode: number, requestId?: string): unknown {
  const body = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  if (containsProviderToken(body)) return data;

  const { error_code: errorCode, error_description: errorDescription, ...safeBody } = body;
  return {
    ...diagnosticValue(safeBody) as Record<string, unknown>,
    ...(errorCode !== undefined ? { __shadowLanguageProviderErrorCode: errorCode } : {}),
    ...(errorDescription !== undefined ? { __shadowLanguageProviderErrorDescription: errorDescription } : {}),
    __shadowLanguageHttpStatus: statusCode,
    ...(requestId ? { __shadowLanguageRequestId: requestId } : {}),
    ...(Object.keys(body).length === 0 ? { __shadowLanguageResponseEmpty: true } : {}),
  };
}

function scalarErrorCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return value;
  if (typeof value === 'string' && value.trim() && value.trim() !== '0') return value.trim();
  return undefined;
}

function errorMessage(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function responseErrorMetadata(data: unknown, httpError: boolean): ResponseErrorMetadata {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const body = data as Record<string, unknown>;
  const nestedError = body.error && typeof body.error === 'object' && !Array.isArray(body.error)
    ? body.error as Record<string, unknown>
    : undefined;
  const code = scalarErrorCode(
    body.error_code
      ?? (typeof body.error === 'string' ? body.error : undefined)
      ?? nestedError?.error_code
      ?? nestedError?.code
      ?? (httpError ? body.code : undefined),
  );
  const message = errorMessage(
    body.error_description
      ?? body.message
      ?? body.msg
      ?? body.detail
      ?? body.error_message
      ?? nestedError?.error_description
      ?? nestedError?.message
      ?? nestedError?.detail,
  );

  // Auth APIs can return an application error with HTTP 200. The CloudBase
  // SDK adapter otherwise turns `{ error_code: ... }` into `{}`, hiding the
  // actual reason from the extension UI.
  if (httpError || code !== undefined || message !== undefined) {
    return {
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }
  return {};
}

export async function readCloudBaseResponse(response: Response, responseType?: string): Promise<unknown> {
  if (responseType === 'blob') return response.blob();
  const body = await response.text();
  if (!body.trim()) return {};
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`CloudBase returned invalid JSON (HTTP ${response.status}).`);
  }
}

function requestUrl(url: string, data?: object): string {
  const absolute = /^https?:\/\//.test(url) ? url : `https:${url}`;
  if (!data || !Object.keys(data).length) return absolute;
  const parsed = new URL(absolute);
  for (const [key, value] of Object.entries(data)) parsed.searchParams.append(key, String(value));
  return parsed.toString();
}

function requestBody(options: IRequestOptions, headers: RequestHeaders): BodyInit | undefined {
  if (options.body !== undefined) return options.body as BodyInit;
  if (options.data === undefined) return undefined;
  if (options.data instanceof FormData) return options.data;
  const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (contentType === 'application/x-www-form-urlencoded') {
    return new URLSearchParams(Object.entries(options.data).map(([key, value]) => [key, String(value)])).toString();
  }
  return JSON.stringify(options.data);
}

/** CloudBase's WebRequest uses XMLHttpRequest, which is unavailable in MV3 workers. */
export class CloudBaseServiceWorkerRequest {
  private readonly timeout: number;
  private readonly timeoutMessage: string;
  private readonly restrictedMethods: string[];

  constructor(config: IRequestConfig = {}) {
    this.timeout = config.timeout || 0;
    this.timeoutMessage = config.timeoutMsg || '请求超时';
    this.restrictedMethods = config.restrictedMethods || ['get', 'post', 'upload', 'download'];
  }

  get(options: IRequestOptions): Promise<ResponseObject> {
    return this.request({ ...options, method: 'get' }, this.restrictedMethods.includes('get'));
  }

  post(options: IRequestOptions): Promise<ResponseObject> {
    return this.request({ ...options, method: 'post' }, this.restrictedMethods.includes('post'));
  }

  put(options: IRequestOptions): Promise<ResponseObject> {
    return this.request({ ...options, method: 'put' });
  }

  upload(options: IUploadRequestOptions): Promise<ResponseObject> {
    const form = new FormData();
    for (const [key, value] of Object.entries(options.data || {})) form.append(key, String(value));
    form.append('key', options.name);
    form.append('file', options.file);
    return this.request({ ...options, data: form, body: undefined, method: options.method || 'put' }, this.restrictedMethods.includes('upload'));
  }

  async download(options: IRequestOptions): Promise<ResponseObject> {
    return this.request({ ...options, method: 'get', responseType: 'blob' }, this.restrictedMethods.includes('download'));
  }

  fetch(options: IFetchOptions & { shouldThrowOnError?: boolean }): Promise<ResponseObject> {
    return this.request(options as IRequestOptions, Boolean(options.enableAbort), options.shouldThrowOnError !== false);
  }

  private async request(options: IRequestOptions, enableTimeout = false, throwOnHttpError = false): Promise<ResponseObject> {
    if (!options.url) throw new Error('CloudBase request URL is required.');
    const method = String(options.method || 'get').toUpperCase();
    const headers = { ...(options.headers || {}) } as RequestHeaders;
    const controller = new AbortController();
    const externalSignal = options.signal as AbortSignal | undefined;
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    const timeout = enableTimeout && this.timeout
      ? setTimeout(() => controller.abort(new Error(this.timeoutMessage)), this.timeout)
      : undefined;

    try {
      const body = method === 'GET' || method === 'HEAD' ? undefined : requestBody(options, headers);
      const response = await globalThis.fetch(requestUrl(options.url, method === 'GET' ? options.data : undefined), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: options.withCredentials ? 'include' : 'same-origin',
        signal: controller.signal,
      });
      const data = await readCloudBaseResponse(response, options.responseType);
      const { code, message } = responseErrorMetadata(data, !response.ok);
      const requestId = response.headers.get('x-request-id') || response.headers.get('request-id') || undefined;
      if (throwOnHttpError && !response.ok) {
        const error = new Error(message || `CloudBase HTTP 请求失败（${response.status}）。`) as Error & {
          code?: string | number;
          status?: number;
          requestId?: string;
          details?: unknown;
        };
        if (code !== undefined) error.code = code;
        error.status = response.status;
        if (requestId) error.requestId = requestId;
        error.details = diagnosticValue(data);
        throw error;
      }
      const providerTokenRequest = isProviderTokenRequest(options.url);
      return {
        // The auth SDK treats `data.error_code` as a rejected response and then
        // discards the body. Keep a redacted diagnostic payload for the OAuth
        // exchange so the extension can show the actual CloudBase response.
        data: providerTokenRequest ? providerTokenResponseData(data, response.status, requestId) : data,
        statusCode: response.status,
        header: Object.fromEntries(response.headers.entries()),
        response,
        ...(!providerTokenRequest && code !== undefined ? { code } : {}),
        ...(!providerTokenRequest && message ? { message } : {}),
        ...(requestId ? { requestId } : {}),
      } as CloudBaseResponseObject;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abort);
    }
  }
}

export function createCloudBaseStorage(area: StorageArea) {
  // CloudBase calls the same adapter methods from both sync and async code paths.
  // A Promise-returning getItem is therefore treated as a value by its sync path
  // and can even be written back into storage. Hydrate once, then expose a truly
  // synchronous mirror while serializing persistence to chrome.storage.
  const memory = new Map<string, string | null>();
  const revisions = new Map<string, number>();
  const bumpRevision = (key: string) => revisions.set(key, (revisions.get(key) || 0) + 1);
  let persistenceError: unknown = null;
  const ready = area.get(null).then((items) => {
    for (const [key, value] of Object.entries(items)) {
      if (key.startsWith(PREFIX) && typeof value === 'string' && !revisions.has(key)) memory.set(key, value);
    }
  });
  let pendingPersistence = ready.catch((error) => { persistenceError = error; });
  const persist = (operation: () => Promise<void>) => {
    pendingPersistence = pendingPersistence.then(async () => {
      try {
        await operation();
      } catch (error) {
        persistenceError = error;
      }
    });
  };

  return {
    mode: 'sync' as const,
    ready,
    getItem(key: string): string | null {
      const namespaced = `${PREFIX}${key}`;
      return memory.get(namespaced) ?? null;
    },
    setItem(key: string, value: string): void {
      const namespaced = `${PREFIX}${key}`;
      bumpRevision(namespaced);
      memory.set(namespaced, value);
      persist(() => area.set({ [namespaced]: value }));
    },
    removeItem(key: string): void {
      const namespaced = `${PREFIX}${key}`;
      bumpRevision(namespaced);
      memory.set(namespaced, null);
      persist(() => area.remove(namespaced));
    },
    clear(): void {
      for (const key of memory.keys()) {
        if (key.startsWith(PREFIX)) {
          bumpRevision(key);
          memory.set(key, null);
        }
      }
      persist(async () => {
        const items = await area.get(null);
        const keys = Object.keys(items).filter((key) => key.startsWith(PREFIX));
        if (keys.length) await area.remove(keys);
      });
    },
    async flush(): Promise<void> {
      await pendingPersistence;
      if (persistenceError) {
        const error = persistenceError;
        persistenceError = null;
        throw error;
      }
    },
  };
}

type CloudBaseStorage = ReturnType<typeof createCloudBaseStorage>;
const storageCache = new WeakMap<StorageArea, CloudBaseStorage>();

function cachedCloudBaseStorage(area: StorageArea): CloudBaseStorage {
  const existing = storageCache.get(area);
  if (existing) return existing;
  const storage = createCloudBaseStorage(area);
  storageCache.set(area, storage);
  return storage;
}

export async function prepareCloudBaseStorage(): Promise<void> {
  await Promise.all([
    cachedCloudBaseStorage(browser.storage.local).ready,
    cachedCloudBaseStorage(browser.storage.session).ready,
  ]);
}

export async function flushCloudBaseStorage(): Promise<void> {
  await Promise.all([
    cachedCloudBaseStorage(browser.storage.local).flush(),
    cachedCloudBaseStorage(browser.storage.session).flush(),
  ]);
}

export const cloudExtensionAdapter = {
  runtime: 'chrome-extension-service-worker',
  isMatch: () => typeof browser !== 'undefined' && Boolean(browser.storage?.local),
  genAdapter: () => ({
    root: globalThis,
    reqClass: CloudBaseServiceWorkerRequest,
    wsClass: WebSocket,
    localStorage: cachedCloudBaseStorage(browser.storage.local),
    sessionStorage: cachedCloudBaseStorage(browser.storage.session),
    // The SDK's User constructor reads its profile cache synchronously. Keep that
    // cache in memory, while OAuth credentials continue to use localStorage above
    // and therefore remain persisted in chrome.storage.local across worker restarts.
    primaryStorage: 'none' as const,
  }),
};
