import { describe, expect, it, vi } from 'vitest';
import { continueWithEmail } from './email-auth';

describe('unified email authentication', () => {
  it('signs in existing accounts and normalizes the email', async () => {
    const login = vi.fn().mockResolvedValue({ signedIn: true });
    const register = vi.fn();
    await expect(continueWithEmail(' User@Example.com ', 'password', login, register, vi.fn())).resolves.toEqual({ signedIn: true });
    expect(login).toHaveBeenCalledWith('user@example.com', 'password');
    expect(register).not.toHaveBeenCalled();
  });
  it.each(['not_found', '4043', 4043])('uses guarded registration after %s', async (code) => {
    const login = vi.fn().mockRejectedValue(new Error('missing', { cause: { code } }));
    const register = vi.fn().mockResolvedValue({ verificationRequired: true });
    await expect(continueWithEmail('new@example.com', 'password', login, register, vi.fn())).resolves.toEqual({ verificationRequired: true });
    expect(register).toHaveBeenCalledWith('new@example.com', 'password');
  });
  it('starts verified password setup when an existing account has no password', async () => {
    const setup = vi.fn().mockResolvedValue({ verificationRequired: true });
    await expect(continueWithEmail(
      ' Existing@Example.com ',
      'password',
      vi.fn().mockRejectedValue(new Error('password missing', { cause: { code: '4029' } })),
      vi.fn(),
      setup,
    )).resolves.toEqual({ verificationRequired: true });
    expect(setup).toHaveBeenCalledWith('existing@example.com', 'password');
  });
  it.each(['invalid_password', 'user_blocked', 'user_pending', 'unreachable', 'invalid_status'])('does not register after %s', async (code) => {
    const error = new Error('failed', { cause: { code } });
    const register = vi.fn();
    await expect(continueWithEmail('user@example.com', 'password', vi.fn().mockRejectedValue(error), register, vi.fn())).rejects.toBe(error);
    expect(register).not.toHaveBeenCalled();
  });
  it('requires eight characters only when creating an account', async () => {
    const register = vi.fn();
    await expect(continueWithEmail('new@example.com', 'short', vi.fn().mockRejectedValue({ code: 'not_found' }), register, vi.fn())).rejects.toThrow('至少');
    expect(register).not.toHaveBeenCalled();
    await expect(continueWithEmail('old@example.com', 'short', vi.fn().mockResolvedValue(true), register, vi.fn())).resolves.toBe(true);
  });
  it('requires eight characters when setting a password for an existing account', async () => {
    const setup = vi.fn();
    await expect(continueWithEmail(
      'existing@example.com',
      'short',
      vi.fn().mockRejectedValue(new Error('password missing', { cause: { code: 4029 } })),
      vi.fn(),
      setup,
    )).rejects.toThrow('至少');
    expect(setup).not.toHaveBeenCalled();
  });
});
