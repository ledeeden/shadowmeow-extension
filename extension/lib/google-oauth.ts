export const GOOGLE_OAUTH_PROVIDER = 'google';
export const GOOGLE_OAUTH_REDIRECT_PATH = 'shadow-language-google';

type GoogleOAuthCallback = {
  code: string;
  state: string;
};

type GoogleAuthClient = {
  genProviderRedirectUri: (params: {
    provider_id: string;
    provider_redirect_uri: string;
    state: string;
  }) => Promise<{ uri?: string | null }>;
  grantProviderToken: (params: {
    provider_id: string;
    provider_redirect_uri: string;
    provider_code: string;
  }) => Promise<unknown>;
  signInWithProvider: (params: { provider_token: string }) => Promise<unknown>;
  getCurrentUser?: (isRefresh?: boolean) => Promise<unknown | null>;
};

type WebAuthFlowDetails = {
  url: string;
  interactive: true;
};

type LaunchWebAuthFlow = (details: WebAuthFlowDetails) => Promise<string | undefined>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sensitiveProviderField(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'code'
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('cookie')
    || normalized.includes('authorization');
}

function providerResponsePreview(value: unknown, key = '', depth = 0): unknown {
  if (sensitiveProviderField(key)) return '[已隐藏]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (depth >= 3) return '[嵌套内容已省略]';
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => providerResponsePreview(item, '', depth + 1));
  const data = record(value);
  if (!data) return typeof value;
  return Object.fromEntries(Object.entries(data).slice(0, 30).map(([entryKey, entryValue]) => [
    entryKey,
    providerResponsePreview(entryValue, entryKey, depth + 1),
  ]));
}

function providerToken(response: unknown): string | undefined {
  let current: unknown = response;
  for (let depth = 0; depth < 4; depth += 1) {
    const data = record(current);
    if (!data) return undefined;
    if (typeof data.provider_token === 'string' && data.provider_token) return data.provider_token;
    current = data.data ?? data.result;
  }
  return undefined;
}

function providerErrorMessage(response: unknown): string | undefined {
  let current: unknown = response;
  for (let depth = 0; depth < 4; depth += 1) {
    const data = record(current);
    if (!data) return undefined;
    for (const key of ['__shadowLanguageProviderErrorDescription', 'error_description', 'message', 'msg', 'reason', 'description', 'error']) {
      if (typeof data[key] === 'string' && data[key]) return data[key] as string;
    }
    current = data.data ?? data.result ?? data.error;
  }
  return undefined;
}

function providerResponseDiagnostic(response: unknown): string {
  const data = record(response);
  const fields = data ? Object.keys(data) : [];
  const code = providerErrorCode(response);
  const message = providerErrorMessage(response);
  const status = data?.__shadowLanguageHttpStatus;
  const requestId = data?.__shadowLanguageRequestId;
  const preview = providerResponsePreview(response);
  const previewText = JSON.stringify(preview);
  return [
    `返回类型：${response === null ? 'null' : typeof response}`,
    `返回字段：${fields.length ? fields.join(', ') : '无'}`,
    ...(typeof status === 'number' || typeof status === 'string' ? [`HTTP 状态：${status}`] : []),
    ...(typeof requestId === 'string' && requestId ? [`请求 ID：${requestId}`] : []),
    ...(code ? [`错误码：${code}`] : []),
    ...(message ? [`错误描述：${message}`] : []),
    ...(previewText && previewText !== '{}' ? [`返回摘要：${previewText}`] : []),
  ].join('；');
}

function protectedDomainForRedirect(redirectUri: string): string | undefined {
  try {
    return new URL(redirectUri).host || undefined;
  } catch {
    return undefined;
  }
}

function providerSecurityHint(response: unknown, redirectUri?: string): string | undefined {
  const data = record(response);
  const status = data?.__shadowLanguageHttpStatus;
  const message = providerErrorMessage(response);
  if (String(status) !== '403' || message) return undefined;
  const domain = redirectUri ? protectedDomainForRedirect(redirectUri) : undefined;
  return `CloudBase 拒绝了 OAuth 回调安全来源（HTTP 403）。请在 CloudBase「环境配置 → 安全来源 → 安全域名」中添加${domain ? `域名 ${domain}` : '当前扩展的回调域名'}，保存后等待配置生效再重试`;
}

function providerExchangeFailure(response: unknown, redirectUri?: string): Error {
  const code = providerErrorCode(response);
  const message = providerErrorMessage(response);
  const securityHint = providerSecurityHint(response, redirectUri);
  const reason = message || securityHint || (code ? `CloudBase 返回错误码 ${code}` : 'CloudBase 未返回 provider_token');
  const diagnostic = providerResponseDiagnostic(response);
  console.error('[Shadow Language] Google OAuth provider token exchange failed', providerResponsePreview(response));
  return flowError(`CloudBase Google 登录凭据交换失败：${reason}。${diagnostic}`, response);
}

function providerErrorCode(response: unknown): string | undefined {
  let current: unknown = response;
  for (let depth = 0; depth < 4; depth += 1) {
    const data = record(current);
    if (!data) return undefined;
    for (const key of ['__shadowLanguageProviderErrorCode', 'error_code', 'code', 'error']) {
      if (typeof data[key] === 'string' && data[key]) return data[key] as string;
      if (typeof data[key] === 'number' && Number.isFinite(data[key])) return String(data[key]);
    }
    current = data.data ?? data.result;
  }
  return undefined;
}

function flowError(message: string, cause?: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function parseGoogleOAuthCallback(
  responseUrl: string,
  redirectUri: string,
  expectedState: string,
): GoogleOAuthCallback {
  let callback: URL;
  let expected: URL;
  try {
    callback = new URL(responseUrl);
    expected = new URL(redirectUri);
  } catch (cause) {
    throw flowError('Google 登录回调地址无效，请重试。', cause);
  }

  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
    throw flowError('Google 登录回调地址不匹配，请重试。');
  }

  const state = callback.searchParams.get('state');
  if (!state || state !== expectedState) throw flowError('Google 登录状态校验失败，请重试。');

  const providerError = callback.searchParams.get('error');
  if (providerError) {
    if (providerError === 'access_denied') throw flowError('Google 登录已取消。');
    const description = callback.searchParams.get('error_description');
    throw flowError(`Google 登录未完成${description ? `：${description}` : '，请重试。'}`);
  }

  const code = callback.searchParams.get('code');
  if (!code) throw flowError('Google 登录未返回授权码，请重试。');
  return { code, state };
}

export async function completeGoogleOAuthFlow({
  auth,
  redirectUri,
  launchWebAuthFlow,
  state,
}: {
  auth: GoogleAuthClient;
  redirectUri: string;
  launchWebAuthFlow: LaunchWebAuthFlow;
  state: string;
}): Promise<{ signedIn: true; user: unknown | null }> {
  const authorization = await auth.genProviderRedirectUri({
    provider_id: GOOGLE_OAUTH_PROVIDER,
    provider_redirect_uri: redirectUri,
    state,
  });
  const authorizationUrl = authorization?.uri;
  if (!authorizationUrl) throw flowError('CloudBase 未返回 Google 授权地址，请检查身份源配置。');

  let responseUrl: string | undefined;
  try {
    responseUrl = await launchWebAuthFlow({ url: authorizationUrl, interactive: true });
  } catch (cause) {
    throw flowError('Google 登录窗口未能完成授权，请重试。', cause);
  }
  if (!responseUrl) throw flowError('Google 登录已取消或未完成。');

  const callback = parseGoogleOAuthCallback(responseUrl, redirectUri, state);
  let providerTokenResponse: unknown;
  try {
    providerTokenResponse = await auth.grantProviderToken({
      provider_id: GOOGLE_OAUTH_PROVIDER,
      provider_redirect_uri: redirectUri,
      provider_code: callback.code,
    });
  } catch (cause) {
    throw providerExchangeFailure(cause, redirectUri);
  }
  const token = providerToken(providerTokenResponse);
  if (!token) {
    throw providerExchangeFailure(providerTokenResponse, redirectUri);
  }

  await auth.signInWithProvider({ provider_token: token });
  const user = auth.getCurrentUser ? await auth.getCurrentUser(true) : null;
  return { signedIn: true, user };
}
