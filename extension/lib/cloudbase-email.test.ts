import { beforeEach, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ getVerification: vi.fn(), verify: vi.fn(), signUp: vi.fn(), getSession: vi.fn() }));
vi.mock('@cloudbase/js-sdk', () => ({ default: { useAdapters: vi.fn(), init: () => ({ auth }) } }));
vi.mock('./analytics', () => ({ track: vi.fn() }));
vi.mock('./db', () => ({ clearPrivateLocalData: vi.fn() }));
vi.mock('./cloudbase-adapter', () => ({ cloudExtensionAdapter: {}, flushCloudBaseStorage: vi.fn(), prepareCloudBaseStorage: vi.fn() }));
import { startSignUp, resendSignUp } from './cloudbase';
beforeEach(() => vi.resetAllMocks());
it('checks NOT_USER before sending and registers only after verification', async () => {
  auth.getVerification.mockResolvedValue({ verification_id: 'original' });
  auth.verify.mockResolvedValue({ verification_token: 'verified' });
  auth.signUp.mockResolvedValue({});
  auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'new' } } } });
  const pending = await startSignUp('new@example.com', 'password');
  expect(auth.getVerification).toHaveBeenCalledWith({ email: 'new@example.com', target: 'NOT_USER' });
  expect(auth.signUp).not.toHaveBeenCalled();
  await pending.verifyOtp!({ token: '123456', messageId: 'resent' });
  expect(auth.verify).toHaveBeenCalledWith({ verification_id: 'resent', verification_code: '123456' });
  expect(auth.signUp).toHaveBeenCalledWith({ email: 'new@example.com', password: 'password', verification_token: 'verified', verification_code: '123456' });
});
it('stops when server rejects an existing user', async () => {
  const error = { code: 'failed_precondition' };
  auth.getVerification.mockRejectedValue(error);
  await expect(startSignUp('existing@example.com', 'wrongpassword')).rejects.toBe(error);
  expect(auth.signUp).not.toHaveBeenCalled();
});
it('preserves the non-user guard when resending', async () => {
  auth.getVerification.mockResolvedValue({ verification_id: 'resent' });
  await expect(resendSignUp('new@example.com')).resolves.toBe('resent');
  expect(auth.getVerification).toHaveBeenCalledWith({ email: 'new@example.com', target: 'NOT_USER' });
});
