import { describe, expect, it, vi } from 'vitest';
import { completeGoogleOAuthFlow, parseGoogleOAuthCallback } from './google-oauth';

const redirectUri = 'https://extension-id.chromiumapp.org/shadow-language-google';

describe('Google OAuth for Chrome MV3', () => {
  it('validates the callback and returns its authorization code', () => {
    expect(parseGoogleOAuthCallback(
      `${redirectUri}?code=provider-code&state=state-123`,
      redirectUri,
      'state-123',
    )).toEqual({ code: 'provider-code', state: 'state-123' });
  });

  it('rejects a callback from another origin or with a mismatched state', () => {
    expect(() => parseGoogleOAuthCallback(
      'https://attacker.example/callback?code=provider-code&state=state-123',
      redirectUri,
      'state-123',
    )).toThrow('回调地址不匹配');
    expect(() => parseGoogleOAuthCallback(
      `${redirectUri}?code=provider-code&state=wrong-state`,
      redirectUri,
      'state-123',
    )).toThrow('状态校验失败');
  });

  it('reports provider cancellation and missing authorization code', () => {
    expect(() => parseGoogleOAuthCallback(
      `${redirectUri}?error=access_denied&state=state-123`,
      redirectUri,
      'state-123',
    )).toThrow('登录已取消');
    expect(() => parseGoogleOAuthCallback(
      `${redirectUri}?state=state-123`,
      redirectUri,
      'state-123',
    )).toThrow('未返回授权码');
  });

  it('exchanges the callback code and persists a CloudBase provider session', async () => {
    const auth = {
      genProviderRedirectUri: vi.fn().mockResolvedValue({ uri: 'https://accounts.google.com/oauth' }),
      grantProviderToken: vi.fn().mockResolvedValue({ provider_token: 'cloudbase-provider-token' }),
      signInWithProvider: vi.fn().mockResolvedValue(undefined),
      getCurrentUser: vi.fn().mockResolvedValue({ uid: 'user-1', email: 'learner@example.com' }),
    };
    const result = await completeGoogleOAuthFlow({
      auth,
      redirectUri,
      state: 'state-123',
      launchWebAuthFlow: vi.fn().mockResolvedValue(`${redirectUri}?code=provider-code&state=state-123`),
    });

    expect(result).toEqual({ signedIn: true, user: { uid: 'user-1', email: 'learner@example.com' } });
    expect(auth.genProviderRedirectUri).toHaveBeenCalledWith({
      provider_id: 'google', provider_redirect_uri: redirectUri, state: 'state-123',
    });
    expect(auth.grantProviderToken).toHaveBeenCalledWith({
      provider_id: 'google', provider_redirect_uri: redirectUri, provider_code: 'provider-code',
    });
    expect(auth.signInWithProvider).toHaveBeenCalledWith({ provider_token: 'cloudbase-provider-token' });
    expect(auth.getCurrentUser).toHaveBeenCalledWith(true);
  });

  it('accepts a provider token nested by an adapter response envelope', async () => {
    const auth = {
      genProviderRedirectUri: vi.fn().mockResolvedValue({ uri: 'https://accounts.google.com/oauth' }),
      grantProviderToken: vi.fn().mockResolvedValue({ data: { provider_token: 'nested-provider-token' } }),
      signInWithProvider: vi.fn().mockResolvedValue(undefined),
      getCurrentUser: vi.fn().mockResolvedValue(null),
    };

    await expect(completeGoogleOAuthFlow({
      auth,
      redirectUri,
      state: 'state-123',
      launchWebAuthFlow: vi.fn().mockResolvedValue(`${redirectUri}?code=provider-code&state=state-123`),
    })).resolves.toEqual({ signedIn: true, user: null });
    expect(auth.signInWithProvider).toHaveBeenCalledWith({ provider_token: 'nested-provider-token' });
  });

  it('surfaces a CloudBase provider exchange error instead of a generic missing-token message', async () => {
    const auth = {
      genProviderRedirectUri: vi.fn().mockResolvedValue({ uri: 'https://accounts.google.com/oauth' }),
      grantProviderToken: vi.fn().mockResolvedValue({ error_code: 'invalid_provider_code', error_description: 'Google code exchange failed' }),
      signInWithProvider: vi.fn(),
    };

    await expect(completeGoogleOAuthFlow({
      auth,
      redirectUri,
      state: 'state-123',
      launchWebAuthFlow: vi.fn().mockResolvedValue(`${redirectUri}?code=provider-code&state=state-123`),
    })).rejects.toThrow('Google code exchange failed');
    expect(auth.signInWithProvider).not.toHaveBeenCalled();
  });

  it('prints a safe diagnostic when CloudBase returns no provider token', async () => {
    const auth = {
      genProviderRedirectUri: vi.fn().mockResolvedValue({ uri: 'https://accounts.google.com/oauth' }),
      grantProviderToken: vi.fn().mockResolvedValue({}),
      signInWithProvider: vi.fn(),
    };

    await expect(completeGoogleOAuthFlow({
      auth,
      redirectUri,
      state: 'state-123',
      launchWebAuthFlow: vi.fn().mockResolvedValue(`${redirectUri}?code=provider-code&state=state-123`),
    })).rejects.toThrow('返回字段：无');
  });

  it('prints the actual rejected CloudBase exchange response', async () => {
    const auth = {
      genProviderRedirectUri: vi.fn().mockResolvedValue({ uri: 'https://accounts.google.com/oauth' }),
      grantProviderToken: vi.fn().mockRejectedValue({
        error_code: 'invalid_provider_code',
        error_description: 'Google code exchange failed',
        provider_token: 'must-not-be-printed',
      }),
      signInWithProvider: vi.fn(),
    };

    await expect(completeGoogleOAuthFlow({
      auth,
      redirectUri,
      state: 'state-123',
      launchWebAuthFlow: vi.fn().mockResolvedValue(`${redirectUri}?code=provider-code&state=state-123`),
    })).rejects.toThrow('错误描述：Google code exchange failed');
  });

  it('prints the adapter diagnostic when the SDK returns an empty provider response', async () => {
    const auth = {
      genProviderRedirectUri: vi.fn().mockResolvedValue({ uri: 'https://accounts.google.com/oauth' }),
      grantProviderToken: vi.fn().mockResolvedValue({
        __shadowLanguageResponseEmpty: true,
        __shadowLanguageHttpStatus: 204,
        __shadowLanguageRequestId: 'request-empty-provider',
      }),
      signInWithProvider: vi.fn(),
    };

    await expect(completeGoogleOAuthFlow({
      auth,
      redirectUri,
      state: 'state-123',
      launchWebAuthFlow: vi.fn().mockResolvedValue(`${redirectUri}?code=provider-code&state=state-123`),
    })).rejects.toThrow('HTTP 状态');
  });

  it('explains that an empty HTTP 403 requires the OAuth callback domain in CloudBase', async () => {
    const auth = {
      genProviderRedirectUri: vi.fn().mockResolvedValue({ uri: 'https://accounts.google.com/oauth' }),
      grantProviderToken: vi.fn().mockResolvedValue({
        __shadowLanguageResponseEmpty: true,
        __shadowLanguageHttpStatus: 403,
        __shadowLanguageRequestId: 'request-protected-domain',
      }),
      signInWithProvider: vi.fn(),
    };

    await expect(completeGoogleOAuthFlow({
      auth,
      redirectUri,
      state: 'state-123',
      launchWebAuthFlow: vi.fn().mockResolvedValue(`${redirectUri}?code=provider-code&state=state-123`),
    })).rejects.toThrow('安全域名」中添加域名 extension-id.chromiumapp.org');
  });
});
