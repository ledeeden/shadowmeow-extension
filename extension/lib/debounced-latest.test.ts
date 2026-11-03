import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDebouncedLatest } from './debounced-latest';

afterEach(() => vi.useRealTimers());

describe('debounced latest work', () => {
  it('coalesces rapid settings changes into one remote call with the latest value', async () => {
    vi.useFakeTimers();
    const work = vi.fn(async (value: number) => value * 2);
    const run = createDebouncedLatest(work, 500);
    const first = run(1);
    const second = run(2);
    const third = run(3);

    await vi.advanceTimersByTimeAsync(500);

    expect(work).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledWith(3);
    await expect(Promise.all([first, second, third])).resolves.toEqual([6, 6, 6]);
  });
});
