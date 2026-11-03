import { describe, expect, it } from 'vitest';
import { formatErrorForDisplay, runtimeApiCall, runtimeErrorResponse, runtimeTransportError, unwrapRuntimeResponse, userFacingErrorMessage } from './runtime-errors';

describe('runtime error transport', () => {
  it('can show only the user message while preserving diagnostic details on the error', () => {
    const response = runtimeErrorResponse(new Error('检查更新失败（503）'));
    try {
      unwrapRuntimeResponse(response, { includeDiagnostics: false });
      throw new Error('Expected failure');
    } catch (error) {
      expect((error as Error).message).toBe('检查更新失败（503）');
      expect((error as Error & { details?: unknown }).details).toBeDefined();
    }
  });
  it('uses useful nested CloudBase details instead of a generic Uncaught Error', () => {
    expect(userFacingErrorMessage({
      message: 'Uncaught Error',
      originError: { error_description: 'Email signups are disabled' },
    }, 'fallback')).toBe('Email signups are disabled');
  });

  it('ignores the generic CloudBase help template when a concrete SDK message exists', () => {
    expect(userFacingErrorMessage({
      helpMessage: '[CloudBase Auth] 操作失败\n如果问题持续存在，建议检查控制台',
      message: 'smtp is not set',
      code: 'aborted',
    }, 'fallback')).toBe('smtp is not set');
  });

  it('reads details and diagnostics through a wrapped auth error', () => {
    const cause = {
      msg: 'Email delivery was rejected',
      error_code: 10,
      request_id: 'request-123',
      retry_after: 60,
    };
    const response = runtimeErrorResponse(Object.assign(new Error('CloudBase 注册失败。'), { cause }));
    expect(response.__shadowLanguageError).toMatchObject({
      message: 'Email delivery was rejected',
      requestId: 'request-123',
      errorCode: 10,
      retryAfter: 60,
    });
  });

  it('maps common auth categories to actionable Chinese messages', () => {
    expect(userFacingErrorMessage({ category: 'PROVIDER_NOT_ENABLED' }, 'fallback')).toContain('邮箱密码登录');
    expect(userFacingErrorMessage({ code: 'rate_limit_exceeded' }, 'fallback')).toContain('60 秒');
    expect(userFacingErrorMessage({ code: '4029', message: '账号密码未设置' }, 'fallback')).toContain('验证邮箱');
  });

  it('does not claim that a missing credential was already saved locally', () => {
    expect(userFacingErrorMessage({
      category: 'INVALID_CREDENTIALS',
      code: 'unauthenticated',
      message: 'credentials not found',
    }, 'fallback')).toContain('没有可用的登录凭据');
  });

  it('preserves an error message across runtime message serialization', () => {
    const response = runtimeErrorResponse({ message: 'Uncaught Error', helpMessage: '验证码发送失败', code: 'AUTH_FAILED' });
    expect(() => unwrapRuntimeResponse(response)).toThrow('验证码发送失败');
  });

  it('exposes API error code, request ID, and redacted diagnostics', () => {
    const response = runtimeErrorResponse({
      message: '云函数 learning.listAssets 执行失败：数据库查询失败',
      code: 'RETRYABLE',
      requestId: 'request-list-123',
      details: { operation: 'learning.listAssets', source: { message: 'index missing', accessToken: 'secret' } },
    });
    expect(() => unwrapRuntimeResponse(response)).toThrow(/错误码：RETRYABLE/);
    expect(() => unwrapRuntimeResponse(response)).toThrow(/请求 ID：request-list-123/);
    expect(formatErrorForDisplay(response.__shadowLanguageError, 'fallback')).not.toContain('secret');
  });

  it('explains that stale extension pages must be refreshed', () => {
    expect(runtimeTransportError(new Error('Extension context invalidated.')).message).toContain('刷新当前页面');
    expect(runtimeTransportError(new Error('Uncaught Error')).message).toContain('未返回具体错误描述');
  });
});


describe('runtime API calls', () => {
  it('converts synchronous invalidation throws into catchable rejections', async () => {
    const result = runtimeApiCall(() => { throw new Error('Extension context invalidated.'); });
    await expect(result).rejects.toThrow('刷新当前页面');
  });

  it('handles asynchronous failures and preserves successful values', async () => {
    await expect(runtimeApiCall(() => Promise.reject(new Error('Extension context invalidated.')))).rejects.toThrow('刷新当前页面');
    await expect(runtimeApiCall(() => Promise.resolve({ enabled: true }))).resolves.toEqual({ enabled: true });
  });
});
