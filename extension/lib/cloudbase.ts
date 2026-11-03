import { track } from './analytics';
import type cloudbase from '@cloudbase/js-sdk';
import { randomId, timeoutSignal, type ApiAction, type ApiResponse, type RequestEnvelope } from '@shadow-language/contracts';
import { ADAPTER_VERSION, CLOUDBASE_ACCESS_KEY, CLOUDBASE_ENV, CLOUDBASE_REGION, EXTENSION_VERSION } from './constants';
import { cloudExtensionAdapter, flushCloudBaseStorage, prepareCloudBaseStorage } from './cloudbase-adapter';
import { completeGoogleOAuthFlow, GOOGLE_OAUTH_REDIRECT_PATH } from './google-oauth';
import { formatErrorForDisplay, userFacingErrorMessage } from './runtime-errors';
import onboardingMedia from '../../cloudbase/functions/shadowLanguageApi/lib/onboarding-media.json';

type CloudBaseApp = ReturnType<typeof cloudbase.init>;
let app: CloudBaseApp | null = null;
let appRequest: Promise<CloudBaseApp> | undefined;

async function deviceId(): Promise<string> {
  const result = await browser.storage.local.get('deviceId');
  if (typeof result.deviceId === 'string') return result.deviceId;
  const id = `device_${randomId()}`;
  await browser.storage.local.set({ deviceId: id });
  return id;
}

export async function rotateDeviceId(): Promise<string> {
  const id = `device_${randomId()}`;
  await browser.storage.local.set({ deviceId: id });
  return id;
}

export async function getCloudBaseApp(): Promise<CloudBaseApp> {
  if (app) return app;
  if (!appRequest) appRequest = (async () => {
    const [{ default: sdk }] = await Promise.all([import('@cloudbase/js-sdk'), prepareCloudBaseStorage()]);
    sdk.useAdapters(cloudExtensionAdapter as unknown as Parameters<typeof sdk.useAdapters>[0]);
    app = sdk.init({
        env: CLOUDBASE_ENV,
        region: CLOUDBASE_REGION,
        // Auth v2's provider exchange is served by the region-level Web API.
        // Keeping this explicit avoids the SDK's default gateway route, which
        // rejects MV3 service-worker origins before the OAuth payload is read.
        endPointMode: 'CLOUD_API',
        ...(CLOUDBASE_ACCESS_KEY ? { accessKey: CLOUDBASE_ACCESS_KEY } : {}),
    });
    return app;
  })().catch(error => { appRequest = undefined; throw error; });
  return appRequest;
}

export async function getAuthStatus(): Promise<{ signedIn: boolean; user: unknown | null; error?: string }> {
  try {
    const auth = ((await getCloudBaseApp()) as unknown as { auth: { getCurrentUser?: () => Promise<unknown>; currentUser?: unknown } }).auth;
    const user = auth.getCurrentUser ? await auth.getCurrentUser() : auth.currentUser || null;
    return { signedIn: Boolean(user), user };
  } catch (error) {
    return { signedIn: false, user: null, error: formatErrorForDisplay(error, 'CloudBase 登录状态读取失败。') };
  }
}

export async function signIn(email: string, password: string): Promise<{ signedIn: boolean; user: unknown | null }> {
  const auth = ((await getCloudBaseApp()) as unknown as { auth: { signInWithPassword: (credentials: { email: string; password: string }) => Promise<{ data?: unknown; error?: unknown }> } }).auth;
  const result = await auth.signInWithPassword({ email, password });
  if (result.error) throw authFailure(result.error, 'CloudBase 登录失败。');
  await flushCloudBaseStorage();
  return { signedIn: true, user: result.data || null };
}

export async function signInWithGoogle(): Promise<{ signedIn: boolean; user: unknown | null }> {
  const auth = ((await getCloudBaseApp()) as unknown as {
    auth: {
      genProviderRedirectUri: (params: { provider_id: string; provider_redirect_uri: string; state: string }) => Promise<{ uri?: string | null }>;
      grantProviderToken: (params: { provider_id: string; provider_redirect_uri: string; provider_code: string }) => Promise<unknown>;
      signInWithProvider: (params: { provider_token: string }) => Promise<unknown>;
      getCurrentUser: (isRefresh?: boolean) => Promise<unknown | null>;
    };
  }).auth;
  if (!browser.identity?.getRedirectURL || !browser.identity.launchWebAuthFlow) {
    throw new Error('当前 Chrome 不支持 Google 登录所需的身份认证能力。');
  }

  const redirectUri = browser.identity.getRedirectURL(GOOGLE_OAUTH_REDIRECT_PATH);
  const state = `shadow-language-google-${randomId()}`;
  const result = await completeGoogleOAuthFlow({
    auth,
    redirectUri,
    state,
    launchWebAuthFlow: (details) => browser.identity.launchWebAuthFlow(details),
  });
  await flushCloudBaseStorage();
  return result;
}

export type SignUpVerifier = (params: { token: string; messageId?: string }) => Promise<{ data?: { user?: unknown; session?: unknown }; error?: unknown }>;
export type EmailVerificationStart = {
  signedIn: boolean;
  user: unknown | null;
  verificationPurpose?: 'signup' | 'password_setup';
  verifyOtp?: SignUpVerifier;
};

export async function startSignUp(email: string, password: string): Promise<EmailVerificationStart> {
  const auth = (await getCloudBaseApp()).auth;
  const verification = await auth.getVerification({ email, target: 'NOT_USER' });
  if (verification.is_user) throw new Error('该邮箱已注册，请检查密码后重试。');
  if (!verification.verification_id) throw new Error('验证码发送失败，请重试。');
  return {
    signedIn: false,
    user: null,
    verificationPurpose: 'signup',
    verifyOtp: async ({ token, messageId }) => {
      const verified = await auth.verify({
        verification_id: messageId || verification.verification_id!,
        verification_code: token,
      });
      if (!verified.verification_token) throw new Error('验证码验证失败，请重试。');
      const result = await auth.signUp({ email, password, verification_token: verified.verification_token, verification_code: token });
      if (result?.error) throw authFailure(result.error, '注册失败。');
      const session = await auth.getSession();
      if (session.error) throw authFailure(session.error, '登录失败。');
      return { data: { user: session.data?.session?.user, session: session.data?.session } };
    },
  };
}

export async function startPasswordSetup(email: string, password: string): Promise<EmailVerificationStart> {
  const auth = (await getCloudBaseApp()).auth;
  // Match the installed SDK's resetPasswordForEmail flow: recovery codes use RECOVERY.
  const verification = await auth.getVerification({ email, target: 'USER', usage: 'RECOVERY' });
  if (!verification.is_user) throw new Error('没有找到该邮箱账号，请检查邮箱地址。');
  if (!verification.verification_id) throw new Error('验证码发送失败，请重试。');
  return {
    signedIn: false,
    user: null,
    verificationPurpose: 'password_setup',
    verifyOtp: async ({ token, messageId }) => {
      const verified = await auth.verify({
        verification_id: messageId || verification.verification_id!,
        verification_code: token,
      });
      if (!verified.verification_token) throw new Error('验证码验证失败，请重试。');
      await auth.resetPassword({ email, new_password: password, verification_token: verified.verification_token });
      const result = await auth.signInWithPassword({ email, password });
      if (result.error) throw authFailure(result.error, '密码已设置，但登录失败。');
      return { data: result.data };
    },
  };
}

export async function resendSignUp(email: string): Promise<string | undefined> {
  const auth = (await getCloudBaseApp()).auth;
  const result = await auth.getVerification({ email, target: 'NOT_USER' });
  if (result.is_user) throw new Error('该邮箱已注册，请返回登录。');
  if (!result.verification_id) throw new Error('验证码发送失败，请重试。');
  return result.verification_id;
}

export async function resendPasswordSetup(email: string): Promise<string | undefined> {
  const auth = (await getCloudBaseApp()).auth;
  const result = await auth.getVerification({ email, target: 'USER', usage: 'RECOVERY' });
  if (!result.is_user) throw new Error('没有找到该邮箱账号，请检查邮箱地址。');
  if (!result.verification_id) throw new Error('验证码发送失败，请重试。');
  return result.verification_id;
}

export async function verifySignUp(verifyOtp: SignUpVerifier, code: string, messageId?: string): Promise<{ signedIn: boolean; user: unknown | null }> {
  const result = await verifyOtp({ token: code, ...(messageId ? { messageId } : {}) });
  if (result.error) throw authFailure(result.error, 'CloudBase 验证失败。');
  await flushCloudBaseStorage();
  return { signedIn: Boolean(result.data?.session || result.data?.user), user: result.data?.user || null };
}

function authFailure(error: unknown, fallback: string): Error {
  const failure = new Error(formatErrorForDisplay(error, fallback)) as Error & { cause?: unknown };
  failure.cause = error;
  return failure;
}

function clientType(): 'extension' | 'web' {
  try {
    const protocol = new URL(browser.runtime.getURL('/')).protocol;
    // iOS reuses the deployed Web API contract. Custom-scheme origins are
    // still Web clients and must receive the same public/onboarding transport.
    return protocol === 'http:' || protocol === 'https:' || protocol === 'capacitor:' ? 'web' : 'extension';
  } catch {
    return 'extension';
  }
}

export async function signOut(): Promise<void> {
  const auth = ((await getCloudBaseApp()) as unknown as { auth: { signOut: (options?: { clearStorage?: boolean }) => Promise<unknown> } }).auth;
  await auth.signOut({ clearStorage: true });
  await flushCloudBaseStorage();
}

// Public-corpus listings carry the same `find ... limit 1000` cost on the
// server. Web dashboard pagination kept re-issuing the same query on every
// keystroke. Raise the TTL to 5 minutes so the second visit within a session
// is served from the in-memory cache.
const PUBLIC_REQUEST_CACHE_TTL: Partial<Record<ApiAction, number>> = {
  'corpus.publicList': 5 * 60_000,
  'corpus.listCollections': 5 * 60_000,
  'corpus.listEpisodes': 5 * 60_000,
  'corpus.listFacets': 5 * 60_000,
  'corpus.listSubtitleTitles': 10 * 60_000,
  'mediaCorpus.publicList': 5 * 60_000,
  // 系列登记表变化很慢(每个 list 一条),缓存久一点,避免每次进页面都打服务端。
  'mediaCorpus.publicSeries': 10 * 60_000,
  // 推荐阶梯要把该类型全部语料读一遍再排序,是最贵的一个读接口,缓存久一点。
  'mediaCorpus.recommend': 10 * 60_000,
};
const PUBLIC_API_ACTIONS = new Set<ApiAction>([
  'corpus.publicList', 'corpus.listCollections', 'corpus.listEpisodes', 'corpus.listFacets',
  'corpus.listSubtitleTitles',
  'mediaCorpus.publicList', 'mediaCorpus.publicSeries', 'mediaCorpus.recommend',
]);
const publicRequestCache = new Map<string, { expiresAt: number; value: unknown }>();
const publicRequestInFlight = new Map<string, Promise<unknown>>();

/**
 * Approved onboarding media and AI keep a guest HTTP path. Invoking
 * the CloudBase SDK function first asks the SDK for a session credential, so
 * the server's guest allowance would otherwise never be reached.
 */
function usesGuestOnboardingTransport(action: ApiAction, payload: unknown, type: 'extension' | 'web'): boolean {
  return action === 'ai.complete'
    && type === 'web'
    && Boolean(payload)
    && typeof payload === 'object'
    && (payload as { purpose?: unknown }).purpose === 'onboarding';
}

async function usesPublicHttpTransport(action: ApiAction, payload: unknown, type: 'extension' | 'web'): Promise<boolean> {
  if (PUBLIC_API_ACTIONS.has(action) || usesGuestOnboardingTransport(action, payload, type)) return true;
  if (type !== 'web' || !payload || typeof payload !== 'object') return false;
  const data = payload as { corpusItemId?: string; subtitleId?: string };
  const mediaId = action === 'mediaCorpus.resolvePlayback' ? data.corpusItemId
    : action === 'corpus.getSubtitleDetail' && data.subtitleId?.startsWith('media:') ? data.subtitleId.slice(6) : undefined;
  return Boolean(mediaId && onboardingMedia.includes(mediaId) && !(await getAuthStatus()).signedIn);
}

function publicRequestKey(action: ApiAction, payload: unknown, options: { idempotencyKey?: string }): string {
  return JSON.stringify([action, payload, options.idempotencyKey || null]);
}

export async function callApi<T>(action: ApiAction, payload: unknown, options: { idempotencyKey?: string } = {}): Promise<T> {
  const started = Date.now();
  try {
    const ttl = PUBLIC_REQUEST_CACHE_TTL[action] || 0;
    const isPublic = PUBLIC_API_ACTIONS.has(action);
    let result: T;
    if (!isPublic) {
      result = await performApi<T>(action, payload, options);
    } else {
      const key = publicRequestKey(action, payload, options);
      const cached = publicRequestCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        result = cached.value as T;
      } else {
        if (cached) publicRequestCache.delete(key);
        let request = publicRequestInFlight.get(key) as Promise<T> | undefined;
        if (!request) {
          request = performApi<T>(action, payload, options).then((value) => {
            if (ttl > 0) {
              publicRequestCache.set(key, { expiresAt: Date.now() + ttl, value });
              if (publicRequestCache.size > 64) publicRequestCache.delete(publicRequestCache.keys().next().value as string);
            }
            return value;
          }).finally(() => { publicRequestInFlight.delete(key); });
          publicRequestInFlight.set(key, request);
        }
        result = await request;
      }
    }
    return result;
  }
  catch (error) { throw error; }
}
async function performApi<T>(action: ApiAction, payload: unknown, options: { idempotencyKey?: string }): Promise<T> {
  const requestId = randomId();
  let envelope: RequestEnvelope;
  let result: { result?: unknown };
  try {
    const type = clientType();
    envelope = {
      version: 1,
      action,
      requestId,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      client: {
        clientType: type,
        extensionVersion: EXTENSION_VERSION,
        adapterVersion: ADAPTER_VERSION,
        deviceId: await deviceId(),
      },
      payload,
    };
    if (await usesPublicHttpTransport(action, payload, type)) {
      const response = await fetch(import.meta.env.WXT_PUBLIC_API_URL || 'https://example.com/public-learning', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), signal: timeoutSignal(30_000),
      });
      if (!response.ok) throw new Error(`公共语料服务暂不可用（HTTP ${response.status}）`);
      result = { result: await response.json() };
    } else {
    await flushCloudBaseStorage();
    const cloudApp = (await getCloudBaseApp()) as unknown as { callFunction: (input: { name: string; data: unknown }) => Promise<{ result?: unknown }> };
    result = await cloudApp.callFunction({ name: 'shadowLanguageApi', data: envelope });
    }
  } catch (cause) {
    const error = new Error(formatErrorForDisplay(cause, `CloudBase 云函数 ${action} 请求失败。`)) as Error & {
      cause?: unknown;
      action?: string;
      requestId?: string;
    };
    error.cause = cause;
    error.action = action;
    error.requestId = requestId;
    throw error;
  }

  const response = parseFunctionResult(result?.result);
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    const error = new Error(`CloudBase 云函数 ${action} 返回格式异常，未收到可解析的 API 响应。`) as Error & {
      action?: string;
      requestId?: string;
      details?: unknown;
    };
    error.action = action;
    error.requestId = requestId;
    error.details = { returnedType: response === null ? 'null' : typeof response, raw: diagnosticPreview(response) };
    throw error;
  }

  const apiResponse = response as ApiResponse<T>;
  if (!apiResponse.ok) {
    const error = new Error(apiResponse.error?.message || `CloudBase 云函数 ${action} 返回失败。`) as Error & {
      code?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      requestId?: string;
      details?: unknown;
      action?: string;
    };
    error.code = apiResponse.error?.code;
    error.retryable = apiResponse.error?.retryable;
    if (apiResponse.error?.retryAfterMs !== undefined) error.retryAfterMs = apiResponse.error.retryAfterMs;
    error.requestId = apiResponse.requestId || requestId;
    error.details = apiResponse.error?.details;
    error.action = action;
    error.message = formatErrorForDisplay(error, `CloudBase 云函数 ${action} 返回失败。`);
    if (error.code === 'UNAUTHENTICATED' && action !== 'sync.exchange') {
      const authStatus = await getAuthStatus();
      if (authStatus.signedIn) {
        error.message = '登录状态暂时无法验证，请刷新页面后重试；若仍失败，请重新登录。';
      } else if (!authStatus.error) {
        await browser.storage.local.remove('remoteFeatures');
        await browser.runtime.sendMessage({ type: 'AUTH_INVALIDATED' }).catch(() => undefined);
      }
    }
    throw error;
  }
  return apiResponse.data;
}

function parseFunctionResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function diagnosticPreview(value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => diagnosticPreview(item));
  if (!value || typeof value !== 'object') return typeof value;
  const sensitive = /token|secret|password|cookie|authorization|credential|api[_-]?key/i;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([key, item]) => [
    key,
    sensitive.test(key) ? '[已隐藏]' : diagnosticPreview(item),
  ]));
}
