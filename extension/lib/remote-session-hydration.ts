export const REMOTE_SESSION_HYDRATION_TTL_MS = 6 * 60 * 60 * 1000;

type RemoteSessionHydratorOptions<T> = {
  readHydratedAt: () => Promise<number>;
  writeHydratedAt: (value: number) => Promise<void>;
  readCached: () => Promise<T>;
  hydrate: () => Promise<T>;
  now?: () => number;
  ttlMs?: number;
};

export function createRemoteSessionHydrator<T>({
  readHydratedAt,
  writeHydratedAt,
  readCached,
  hydrate,
  now = Date.now,
  ttlMs = REMOTE_SESSION_HYDRATION_TTL_MS,
}: RemoteSessionHydratorOptions<T>) {
  let pending: Promise<T> | null = null;

  return async function hydrateRemoteSession({ force = false }: { force?: boolean } = {}): Promise<T> {
    if (pending) return pending;
    if (!force) {
      const hydratedAt = await readHydratedAt();
      if (Number.isFinite(hydratedAt) && hydratedAt > 0 && now() - hydratedAt >= 0 && now() - hydratedAt < ttlMs) {
        return readCached();
      }
      if (pending) return pending;
    }

    pending = hydrate().then(async (value) => {
      await writeHydratedAt(now());
      return value;
    }).finally(() => {
      pending = null;
    });
    return pending;
  };
}
