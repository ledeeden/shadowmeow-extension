import { describe, expect, it } from 'vitest';
import { anySignal, installAbortSignalPolyfill, timeoutSignal } from './abort';

describe('abort signal compatibility', () => {
  it('returns a working timeout signal even without AbortSignal.timeout', async () => {
    const original = (AbortSignal as { timeout?: unknown }).timeout;
    try {
      delete (AbortSignal as { timeout?: unknown }).timeout;
      const signal = timeoutSignal(20);
      expect(signal.aborted).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(signal.aborted).toBe(true);
    } finally {
      if (original) (AbortSignal as { timeout?: unknown }).timeout = original;
    }
  });

  it('combines signals without AbortSignal.any', () => {
    const original = (AbortSignal as { any?: unknown }).any;
    try {
      delete (AbortSignal as { any?: unknown }).any;
      const first = new AbortController();
      const second = new AbortController();
      const combined = anySignal([first.signal, second.signal]);
      expect(combined.aborted).toBe(false);
      second.abort(new Error('stop'));
      expect(combined.aborted).toBe(true);
    } finally {
      if (original) (AbortSignal as { any?: unknown }).any = original;
    }
  });

  it('installs missing statics when the host allows mutation', () => {
    const originalTimeout = (AbortSignal as { timeout?: unknown }).timeout;
    const originalAny = (AbortSignal as { any?: unknown }).any;
    try {
      delete (AbortSignal as { timeout?: unknown }).timeout;
      delete (AbortSignal as { any?: unknown }).any;
      installAbortSignalPolyfill();
      expect(typeof (AbortSignal as { timeout?: unknown }).timeout).toBe('function');
      expect(typeof (AbortSignal as { any?: unknown }).any).toBe('function');
    } finally {
      if (originalTimeout) (AbortSignal as { timeout?: unknown }).timeout = originalTimeout;
      else delete (AbortSignal as { timeout?: unknown }).timeout;
      if (originalAny) (AbortSignal as { any?: unknown }).any = originalAny;
      else delete (AbortSignal as { any?: unknown }).any;
    }
  });
});
