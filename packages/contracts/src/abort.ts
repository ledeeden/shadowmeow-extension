/**
 * AbortSignal.timeout / AbortSignal.any are missing in older browsers, some
 * extension main-world scripts after page polyfills, and certain serverless
 * runtimes. Prefer the native statics when present; otherwise fall back to
 * AbortController + timers so fetch timeouts keep working.
 */

type AbortSignalStatics = {
  timeout?: (milliseconds: number) => AbortSignal;
  any?: (signals: AbortSignal[]) => AbortSignal;
};

function timeoutReason(milliseconds: number): unknown {
  try {
    return new DOMException(`Timeout after ${milliseconds}ms`, 'TimeoutError');
  } catch {
    const error = new Error(`Timeout after ${milliseconds}ms`);
    error.name = 'TimeoutError';
    return error;
  }
}

function abortTimeout(milliseconds: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutReason(milliseconds)), milliseconds);
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
}

function abortAny(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function timeoutSignal(milliseconds: number): AbortSignal {
  const timeout = (AbortSignal as unknown as AbortSignalStatics).timeout;
  if (typeof timeout === 'function') return timeout.call(AbortSignal, milliseconds);
  return abortTimeout(milliseconds);
}

export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const any = (AbortSignal as unknown as AbortSignalStatics).any;
  if (typeof any === 'function') return any.call(AbortSignal, [...signals]);
  return abortAny(signals);
}

/** Fill missing AbortSignal statics when the host allows mutation. */
export function installAbortSignalPolyfill(): void {
  const target = AbortSignal as unknown as AbortSignalStatics;
  if (typeof target.timeout !== 'function') {
    try {
      target.timeout = (milliseconds: number) => abortTimeout(milliseconds);
    } catch {
      // Frozen host object; call sites use timeoutSignal() which still works.
    }
  }
  if (typeof target.any !== 'function') {
    try {
      target.any = (signals: AbortSignal[]) => abortAny(signals);
    } catch {
      // Frozen host object; call sites use anySignal() which still works.
    }
  }
}
