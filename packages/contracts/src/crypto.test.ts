import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  mediaCaptureAvailable,
  randomId,
  safeClipboardWriteText,
  sha256Bytes,
  sha256Hex,
  webCryptoUnavailable,
} from './crypto';

const VECTORS: Array<[string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['hello', '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'],
  ['shadow-language-web-u-demo', 'b12a687d0f6037d1ca611e9fb5daeb2d1848b2e89ff3cde62564d2600e6e4b56'],
];

describe('sha256 compatibility helpers', () => {
  it('matches standard Web Crypto vectors via JS fallback', async () => {
    for (const [input, expected] of VECTORS) {
      expect(bytesToHex(sha256Bytes(new TextEncoder().encode(input)))).toBe(expected);
      const subtle = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
      expect(bytesToHex(new Uint8Array(subtle))).toBe(expected);
      expect(await sha256Hex(input)).toBe(expected);
    }
  });

  it('keeps hashing when subtle.digest is missing', async () => {
    const original = globalThis.crypto;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const stripped = { getRandomValues: original.getRandomValues.bind(original) } as Crypto;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: stripped });
    try {
      expect(webCryptoUnavailable()).toBe(true);
      expect(await sha256Hex('abc')).toBe(VECTORS[1]![1]);
      expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
    }
  });

  it('formats UUID fallback without randomUUID', () => {
    const original = globalThis.crypto;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const stripped = {
      getRandomValues: (array: Uint8Array) => { array.fill(0xab); return array; },
    } as Crypto;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: stripped });
    try {
      expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
    }
  });
});

describe('optional browser APIs', () => {
  it('reports clipboard availability without throwing', async () => {
    await expect(safeClipboardWriteText('x')).resolves.toBeTypeOf('boolean');
  });

  it('reports media capture capability as a structured result', () => {
    const result = mediaCaptureAvailable();
    expect(result).toHaveProperty('available');
    expect(typeof result.reason).toBe('string');
  });
});
