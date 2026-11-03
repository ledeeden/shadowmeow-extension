/** Ambiguous credentials errors are resolved by a server-guarded NOT_USER signup. */
export async function continueWithEmail<T, U>(
  email: string,
  password: string,
  signIn: (email: string, password: string) => Promise<T>,
  signUp: (email: string, password: string) => Promise<U>,
  setInitialPassword: (email: string, password: string) => Promise<U>,
): Promise<T | U> {
  const normalizedEmail = email.trim().toLowerCase();
  try {
    return await signIn(normalizedEmail, password);
  } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
    if (code === '4029') {
      if (password.length < 8) throw new Error('设置账号密码至少需要 8 位。');
      return setInitialPassword(normalizedEmail, password);
    }
    if (!['not_found', '4043'].includes(code)) throw error;
  }
  if (password.length < 8) throw new Error('新账号密码至少需要 8 位。');
  return signUp(normalizedEmail, password);
}
