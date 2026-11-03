import { describe, expect, it } from 'vitest';
import { parseReleaseCheck } from './extension-release';

const release = { version: '0.10.0', downloadUrl: 'https://cdn.example.com/releases/app.zip', sha256: 'a'.repeat(64), size: 100, publishedAt: '2026-09-13T00:00:00Z' };
describe('extension release response', () => {
  it('compares numerically and ignores a misleading available flag', () => {
    expect(parseReleaseCheck({ available: false, release }, '0.9.0').available).toBe(true);
    expect(parseReleaseCheck({ available: true, release }, '0.10.0').available).toBe(false);
    expect(parseReleaseCheck({ available: true, release }, '1.0.0').available).toBe(false);
  });
  it('handles an unpublished channel', () => {
    expect(parseReleaseCheck({ release: null }, '0.1.0')).toEqual({ available: false, release: null });
  });
  it.each(['javascript:alert(1)', 'http://cdn.example.com/app.zip', 'https://user:pass@cdn.example.com/app.zip', 'https://cdn.example.com/app.js'])('rejects unsafe download URL %s', (downloadUrl) => {
    expect(() => parseReleaseCheck({ release: { ...release, downloadUrl } }, '0.1.0')).toThrow();
  });
  it.each([{ version: '0.01.0' }, { version: '1.0.0-beta' }, { version: '65536.0.0' }, { sha256: 'wrong' }, { size: -1 }, { publishedAt: 'invalid' }])('rejects malformed metadata %j', (changes) => {
    expect(() => parseReleaseCheck({ release: { ...release, ...changes } }, '0.1.0')).toThrow();
  });
});
