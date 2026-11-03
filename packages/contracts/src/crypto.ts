const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function toUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Deterministic SHA-256 matching Web Crypto so offline fallback keeps stable IDs. */
export function sha256Bytes(input: Uint8Array): Uint8Array {
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(input);
  message[input.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLen >>> 0, false);

  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const left15 = schedule[index - 15]!;
      const left2 = schedule[index - 2]!;
      const s0 = rotr(left15, 7) ^ rotr(left15, 18) ^ (left15 >>> 3);
      const s1 = rotr(left2, 17) ^ rotr(left2, 19) ^ (left2 >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }
    let a = hash[0]!, b = hash[1]!, c = hash[2]!, d = hash[3]!, e = hash[4]!, f = hash[5]!, g = hash[6]!, h = hash[7]!;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[index]! + schedule[index]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let index = 0; index < 8; index += 1) outView.setUint32(index * 4, hash[index]!, false);
  return out;
}

function fillRandomBytes(bytes: Uint8Array): Uint8Array {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoObject?.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
    return bytes;
  }
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}

export function randomUUIDFallback(): string {
  const bytes = fillRandomBytes(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomId(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoObject?.randomUUID === 'function') {
    try { return cryptoObject.randomUUID(); } catch { /* insecure context */ }
  }
  return randomUUIDFallback();
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const subtle = globalThis.crypto?.subtle as SubtleCrypto | undefined;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
    } catch {
      // Insecure context or blocked Web Crypto — fall through to JS SHA-256.
    }
  }
  return bytesToHex(sha256Bytes(bytes));
}

function buildFallbackCrypto(existing: Crypto | undefined): Crypto {
  const digest = async (_algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
    return sha256Bytes(toUint8Array(data)).buffer as ArrayBuffer;
  };
  const subtle = {
    ...(existing?.subtle as object | undefined),
    digest,
  } as SubtleCrypto;
  const randomUUID = (): string => randomUUIDFallback();
  const getRandomValues = <T extends ArrayBufferView>(array: T): T => fillRandomBytes(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)) as unknown as T;
  return Object.assign(Object.create(existing || null), {
    subtle,
    randomUUID,
    getRandomValues,
  }) as Crypto;
}

function tryDefine(target: object, key: string, value: unknown): boolean {
  try {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    return true;
  } catch {
    try {
      (target as Record<string, unknown>)[key] = value;
      return (target as Record<string, unknown>)[key] === value;
    } catch {
      return false;
    }
  }
}

function cryptoReady(candidate: Crypto | undefined): boolean {
  return Boolean(
    candidate
    && typeof candidate.getRandomValues === 'function'
    && typeof candidate.randomUUID === 'function'
    && candidate.subtle
    && typeof (candidate.subtle as SubtleCrypto).digest === 'function',
  );
}

/**
 * Fill in crypto.subtle.digest / crypto.randomUUID / getRandomValues when the
 * runtime lacks them (non-secure HTTP, older WebViews, some private modes).
 * Call-site helpers still fall back if the host freezes Crypto.
 */
export function installWebCryptoPolyfill(): void {
  const root = globalThis as typeof globalThis & { crypto?: Crypto };
  if (cryptoReady(root.crypto)) return;
  const existing = root.crypto;
  const fallback = buildFallbackCrypto(existing);
  if (existing && cryptoReady(existing)) return;

  let current = existing;
  if (current) {
    if (typeof current.getRandomValues !== 'function') tryDefine(current, 'getRandomValues', fallback.getRandomValues);
    if (typeof current.randomUUID !== 'function') tryDefine(current, 'randomUUID', fallback.randomUUID);
    const subtle = current.subtle as SubtleCrypto | undefined;
    if (!subtle) tryDefine(current, 'subtle', fallback.subtle);
    else if (typeof subtle.digest !== 'function') tryDefine(subtle, 'digest', fallback.subtle.digest);
  }

  if (cryptoReady(current || root.crypto)) return;

  if (tryDefine(root, 'crypto', fallback) && cryptoReady(root.crypto)) return;
  // Last resort for webviews that only accept a replaced global binding.
  try {
    (root as { crypto?: Crypto }).crypto = fallback;
  } catch {
    // Call-site helpers remain the final safety net.
  }
}

export function webCryptoUnavailable(): boolean {
  return !cryptoReady(globalThis.crypto as Crypto | undefined);
}

export function insecureContextHint(): string {
  if (typeof location === 'undefined') return '';
  if (!webCryptoUnavailable()) return '';
  const secure = location.protocol === 'https:'
    || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || location.hostname === '[::1]'
    || location.hostname.endsWith('.localhost');
  if (secure) {
    return '浏览器未提供 Web Crypto（可能是隐私模式或受限环境）。请更换浏览器或关闭隐私限制后刷新。';
  }
  return '当前页面不在安全上下文（需要 https:// 或 localhost）。浏览器禁用了 Web Crypto，请改用安全地址访问后刷新。';
}

/** Optional browser APIs that are missing or blocked in insecure/legacy contexts. */
export function safeClipboardWriteText(text: string): Promise<boolean> {
  const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') return Promise.resolve(false);
  return clipboard.writeText(text).then(() => true).catch(() => false);
}

export function mediaCaptureAvailable(): { available: boolean; reason: string } {
  const nav = globalThis.navigator as Navigator | undefined;
  if (typeof location !== 'undefined') {
    const host = location.hostname;
    const secure = location.protocol === 'https:'
      || host === 'localhost'
      || host === '127.0.0.1'
      || host === '[::1]'
      || host.endsWith('.localhost');
    if (!secure && typeof globalThis.isSecureContext === 'boolean' && !globalThis.isSecureContext) {
      return { available: false, reason: '录音需要安全上下文（https:// 或 localhost）。' };
    }
  }
  if (!nav?.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
    return { available: false, reason: '当前浏览器不支持麦克风录音 API。' };
  }
  if (typeof globalThis.MediaRecorder !== 'function') {
    return { available: false, reason: '当前浏览器不支持 MediaRecorder。' };
  }
  return { available: true, reason: '' };
}
