import { expect, it, vi } from 'vitest';
import { createAgentOwnerRefresh } from './session-owner';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('keeps a streaming answer alive through repeated sync auth notifications', async () => {
  const controller = new AbortController();
  let answering = false;
  const onChange = vi.fn(() => { if (answering) controller.abort(); });
  const refresh = createAgentOwnerRefresh({ readOwner: async () => 'user:one', onChange, onError: vi.fn() });
  await refresh.refresh();
  answering = true;
  await Promise.all([refresh.refresh(), refresh.refresh(), refresh.refresh()]);
  expect(controller.signal.aborted).toBe(false);
  expect(onChange).toHaveBeenCalledTimes(1);
});

it.each(['user:two', 'local'])('ends the old account run when identity changes to %s', async next => {
  let owner = 'user:one';
  const controller = new AbortController();
  const changes: string[] = [];
  const refresh = createAgentOwnerRefresh({ readOwner: async () => owner, onChange: value => {
    if (changes.length) controller.abort();
    changes.push(value);
  }, onError: vi.fn() });
  await refresh.refresh();
  owner = next;
  await refresh.refresh();
  expect(controller.signal.aborted).toBe(true);
  expect(changes).toEqual(['user:one', next]);
});

it('ignores stale identity responses arriving after a newer account lookup', async () => {
  const older = deferred<string>(), newer = deferred<string>();
  const readOwner = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const onChange = vi.fn();
  const refresh = createAgentOwnerRefresh({ readOwner, onChange, onError: vi.fn() });
  const first = refresh.refresh(), second = refresh.refresh();
  newer.resolve('user:two'); await second;
  older.resolve('user:one'); await first;
  expect(onChange.mock.calls).toEqual([['user:two']]);
});

it('retains the current session on a transient auth read failure', async () => {
  const readOwner = vi.fn().mockResolvedValueOnce('user:one').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('user:one');
  const onChange = vi.fn(), onError = vi.fn();
  const refresh = createAgentOwnerRefresh({ readOwner, onChange, onError });
  await refresh.refresh(); await refresh.refresh(); await refresh.refresh();
  expect(onChange.mock.calls).toEqual([['user:one']]);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }));
});

it('ignores pending lookups after the panel unmounts', async () => {
  const pending = deferred<string>();
  const onChange = vi.fn(), onError = vi.fn();
  const refresh = createAgentOwnerRefresh({ readOwner: () => pending.promise, onChange, onError });
  const request = refresh.refresh();
  refresh.dispose(); pending.resolve('user:one'); await request;
  expect(onChange).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
