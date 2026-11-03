type Waiter<R> = {
  resolve: (value: R) => void;
  reject: (reason?: unknown) => void;
};

export function createDebouncedLatest<T, R>(work: (value: T) => Promise<R>, delayMs: number) {
  let latest: T | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiters: Array<Waiter<R>> = [];
  let serial: Promise<unknown> = Promise.resolve();

  const flush = () => {
    timer = null;
    const value = latest as T;
    const currentWaiters = waiters;
    waiters = [];
    serial = serial.catch(() => undefined).then(() => work(value));
    void serial.then(
      result => currentWaiters.forEach(waiter => waiter.resolve(result as R)),
      error => currentWaiters.forEach(waiter => waiter.reject(error)),
    );
  };

  return (value: T): Promise<R> => {
    latest = value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
    return new Promise<R>((resolve, reject) => { waiters.push({ resolve, reject }); });
  };
}
