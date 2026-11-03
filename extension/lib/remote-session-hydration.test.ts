import { describe, expect, it, vi } from 'vitest';
import { createRemoteSessionHydrator } from './remote-session-hydration';

describe('remote session hydration', () => {
  it('turns repeated service-worker wakes into cached reads during the TTL', async () => {
    let hydratedAt = 0;
    let now = 1_000;
    const hydrate = vi.fn(async () => ({ source: 'remote' }));
    const readCached = vi.fn(async () => ({ source: 'cache' }));
    const run = createRemoteSessionHydrator({
      readHydratedAt: async () => hydratedAt,
      writeHydratedAt: async (value) => { hydratedAt = value; },
      readCached,
      hydrate,
      now: () => now,
      ttlMs: 6 * 60 * 60 * 1000,
    });

    expect(await run()).toEqual({ source: 'remote' });
    for (let wake = 0; wake < 10; wake += 1) expect(await run()).toEqual({ source: 'cache' });
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(readCached).toHaveBeenCalledTimes(10);

    now += 6 * 60 * 60 * 1000;
    expect(await run()).toEqual({ source: 'remote' });
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight refresh and lets explicit login bypass a fresh cache', async () => {
    let hydratedAt = 0;
    let release: (() => void) | undefined;
    const hydrate = vi.fn(() => new Promise<{ source: string }>((resolve) => {
      release = () => resolve({ source: 'remote' });
    }));
    const run = createRemoteSessionHydrator({
      readHydratedAt: async () => hydratedAt,
      writeHydratedAt: async (value) => { hydratedAt = value; },
      readCached: async () => ({ source: 'cache' }),
      hydrate,
      now: () => 5_000,
    });

    const first = run({ force: true });
    const second = run({ force: true });
    await vi.waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([{ source: 'remote' }, { source: 'remote' }]);

    hydrate.mockImplementationOnce(async () => ({ source: 'remote' }));
    await run({ force: true });
    expect(hydrate).toHaveBeenCalledTimes(2);
  });
});
