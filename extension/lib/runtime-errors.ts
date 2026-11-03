const GENERIC_MESSAGES = new Set([
  'error',
  'uncaught error',
  'unknown',
  'unknown error',
  'unknown error occurred',
  'temporary server error',
  'request failed',
  'cloudbase request failed',
]);
const SENSITIVE_KEY = /token|secret|password|cookie|authorization|credential|api[_-]?key/i;
const MAX_DIAGNOSTIC_LENGTH = 1400;

type ErrorDetails = {
  message: string;
  code?: string;
  category?: string;
  requestId?: string;
  errorCode?: number;
  status?: string;
  retryAfter?: number;
  details?: unknown;
};

export type RuntimeErrorResponse = { __shadowLanguageError: ErrorDetails };

function usefulMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || GENERIC_MESSAGES.has(normalized.toLowerCase()) || /^\d+$/.test(normalized)) return null;
  if (/^\[CloudBase Auth\]\s*操作失败/.test(normalized)) return null;
  return normalized;
}

function findMessage(value: unknown, seen = new Set<object>(), depth = 0): string | null {
  const direct = usefulMessage(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return null;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ['error_description', 'msg', 'reason', 'description']) {
    const message = usefulMessage(record[key]);
    if (message) return message;
  }
  for (const key of ['cause', 'originError', 'error', 'data', 'response', 'details']) {
    const nested = findMessage(record[key], seen, depth + 1);
    if (nested) return nested;
  }
  for (const key of ['message', 'helpMessage']) {
    const message = usefulMessage(record[key]);
    if (message) return message;
  }
  return null;
}

function findField(value: unknown, keys: string[], seen = new Set<object>(), depth = 0): unknown {
  if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return undefined;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of keys) if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  for (const key of ['cause', 'originError', 'error', 'data', 'response', 'details']) {
    const nested = findField(record[key], keys, seen, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function stringField(value: unknown, ...keys: string[]): string | undefined {
  const field = findField(value, keys);
  if (typeof field === 'string' && field.trim()) return field.trim();
  if (typeof field === 'number' && Number.isFinite(field)) return String(field);
  return undefined;
}

function numberField(value: unknown, ...keys: string[]): number | undefined {
  const field = findField(value, keys);
  if (typeof field === 'number' && Number.isFinite(field)) return field;
  if (typeof field === 'string' && /^\d+$/.test(field.trim())) return Number(field);
  return undefined;
}

function diagnosticPreview(value: unknown, key = '', depth = 0, seen = new Set<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return '[已隐藏]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (depth > 4) return '[嵌套内容已省略]';
  if (!value || typeof value !== 'object') return typeof value;
  if (seen.has(value)) return '[循环引用已省略]';
  seen.add(value);
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; status?: unknown; cause?: unknown };
    return {
      name: error.name,
      ...(usefulMessage(error.message) ? { message: error.message } : {}),
      ...(error.code !== undefined ? { code: diagnosticPreview(error.code, 'code', depth + 1, seen) } : {}),
      ...(error.status !== undefined ? { status: diagnosticPreview(error.status, 'status', depth + 1, seen) } : {}),
      ...(error.cause !== undefined ? { cause: diagnosticPreview(error.cause, 'cause', depth + 1, seen) } : {}),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => diagnosticPreview(item, '', depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([entryKey, entryValue]) => [
    entryKey,
    diagnosticPreview(entryValue, entryKey, depth + 1, seen),
  ]));
}

function diagnosticText(value: unknown): string | null {
  if (value === undefined) return null;
  const preview = diagnosticPreview(value);
  try {
    const text = JSON.stringify(preview);
    if (!text || text === '{}') return null;
    return text.length > MAX_DIAGNOSTIC_LENGTH ? `${text.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : text;
  } catch {
    return null;
  }
}

export function userFacingErrorMessage(error: unknown, fallback: string): string {
  const category = stringField(error, 'category');
  const code = stringField(error, 'code', 'status', 'error');
  const message = findMessage(error);
  if (message && /credentials? not found|missing credentials?/i.test(message)) {
    return 'CloudBase 当前没有可用的登录凭据。请重新登录；如果刚登录就出现此提示，请重新加载最新版 Shadow Language 后再试。';
  }
  if (category === 'CAPTCHA_REQUIRED' || code === 'captcha_required') return 'CloudBase 要求完成人机验证，请稍后重试或在控制台关闭当前环境的验证码要求。';
  if (category === 'RATE_LIMITED' || code === 'rate_limit_exceeded') return '请求过于频繁，请等待 60 秒后再试。';
  if (code === '4029') return '该邮箱账号尚未设置密码。验证码已发送后，可验证邮箱并设置当前密码。';
  if (code === 'invalid_redirect_uri') return 'CloudBase 拒绝了 Google OAuth 回调地址，请在身份认证设置中检查允许的回调域名后重试。';
  if (category === 'PROVIDER_NOT_ENABLED' || code === 'provider_not_enabled') return 'CloudBase 尚未启用当前登录方式，请在身份认证设置中启用邮箱密码登录或 Google 身份源后重试。';
  if (category === 'INVALID_CREDENTIALS') return '邮箱或密码不正确。';
  if (category === 'VERIFICATION_FAILED') return '验证码已过期或不正确，请重新获取后再试。';
  if (category === 'PRECONDITION_FAILED') return '该邮箱可能已经注册；请尝试直接登录，或换一个邮箱。';
  if (category === 'SERVICE_ERROR') return 'CloudBase 邮件服务请求失败，请稍后重试；若持续失败，请检查邮件发送服务配置。';
  if (message) return message;
  const diagnosticCode = stringField(error, 'errorCode', 'error_code', 'code', 'status', 'error');
  const requestId = stringField(error, 'requestId', 'request_id');
  const diagnostics = [diagnosticCode ? `错误码：${diagnosticCode}` : '', requestId ? `请求 ID：${requestId}` : ''].filter(Boolean);
  return diagnostics.length ? `${fallback}（${diagnostics.join('；')}）` : fallback;
}

export function formatErrorForDisplay(error: unknown, fallback: string): string {
  const message = userFacingErrorMessage(error, fallback);
  const code = stringField(error, 'code', 'errorCode', 'error_code');
  const category = stringField(error, 'category');
  const status = stringField(error, 'status', 'statusCode', 'httpStatus');
  const requestId = stringField(error, 'requestId', 'request_id', 'traceId', 'trace_id');
  const details = findField(error, ['details', 'diagnostics']);
  const suffix = [
    code && !message.includes(`错误码：${code}`) ? `错误码：${code}` : '',
    category && !message.includes(`错误类别：${category}`) ? `错误类别：${category}` : '',
    status && !message.includes(`HTTP 状态：${status}`) ? `HTTP 状态：${status}` : '',
    requestId && !message.includes(`请求 ID：${requestId}`) ? `请求 ID：${requestId}` : '',
    diagnosticText(details) ? `诊断：${diagnosticText(details)}` : '',
  ].filter(Boolean);
  return [message, ...suffix].join('；');
}

export function runtimeErrorResponse(error: unknown, fallback = '操作失败，未返回具体错误描述；请查看诊断信息后重试。'): RuntimeErrorResponse {
  const code = stringField(error, 'code', 'status', 'error');
  const category = stringField(error, 'category');
  const requestId = stringField(error, 'requestId', 'request_id');
  const errorCode = numberField(error, 'errorCode', 'error_code');
  const status = stringField(error, 'status');
  const retryAfter = numberField(error, 'retryAfter', 'retry_after');
  const details = diagnosticPreview(findField(error, ['details', 'diagnostics']) ?? error);
  return {
    __shadowLanguageError: {
      message: userFacingErrorMessage(error, fallback),
      ...(code ? { code } : {}),
      ...(category ? { category } : {}),
      ...(requestId ? { requestId } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(status ? { status } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      ...(details !== undefined ? { details } : {}),
    },
  };
}

export function unwrapRuntimeResponse<T>(response: T | RuntimeErrorResponse, options: { includeDiagnostics?: boolean } = {}): T {
  if (response && typeof response === 'object' && '__shadowLanguageError' in response) {
    const details = (response as RuntimeErrorResponse).__shadowLanguageError;
    const error = new Error(details.message) as Error & Omit<ErrorDetails, 'message'>;
    if (details.code) error.code = details.code;
    if (details.category) error.category = details.category;
    if (details.requestId) error.requestId = details.requestId;
    if (details.errorCode !== undefined) error.errorCode = details.errorCode;
    if (details.status) error.status = details.status;
    if (details.retryAfter !== undefined) error.retryAfter = details.retryAfter;
    if (details.details !== undefined) error.details = details.details;
    if (options.includeDiagnostics !== false) error.message = formatErrorForDisplay(error, details.message);
    throw error;
  }
  return response as T;
}

export function runtimeTransportError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  if (/extension context invalidated/i.test(raw)) {
    return new Error('扩展已更新，请刷新当前页面以重新加载 Shadow Language。');
  }
  if (/message port closed|receiving end does not exist/i.test(raw)) {
    return new Error(`扩展后台未响应（${raw}），请刷新当前页面后重试。`);
  }
  if (error instanceof Error && findMessage(error)) return error;
  return new Error(formatErrorForDisplay(error, '扩展通信失败，未返回具体错误描述；请刷新页面后重试。'));
}

/** Chrome can throw before returning a Promise after an extension reload. */
export async function runtimeApiCall<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw runtimeTransportError(error);
  }
}
