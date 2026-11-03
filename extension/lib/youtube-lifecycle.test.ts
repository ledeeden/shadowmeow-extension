import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { PAGE_CHANNEL } from './constants';

const mocks = vi.hoisted(() => {
  const ui = { host: { parentElement: null }, update: vi.fn(), invalidate: vi.fn(), destroy: vi.fn() };
  const runtime = { id: 'test-extension' as string | undefined, sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } };
  return { ui, runtime, browser: { runtime }, cacheGet: vi.fn(), fetchTrack: vi.fn() };
});
vi.mock('../components/youtube-player-ui', () => ({ createYoutubePlayerUi: () => mocks.ui }));
vi.mock('./db', () => ({ db: { captions: { get: mocks.cacheGet } } }));
vi.mock('./youtube-captions', () => ({ fetchCaptionTrack: mocks.fetchTrack }));

let ctx: ContentScriptContext;
let pageWindow: EventTarget & { postMessage: ReturnType<typeof vi.fn> };
const state = { youtubeId: '5H9N9E0F-IM', title: 'Coffee', durationMs: 100000, playerState: 'playing', timeMs: 1000, playbackRate: 1, tracks: [] };
const track = { id: 'en', language: 'en', label: 'English', kind: 'manual', baseUrl: 'https://www.youtube.com/api/timedtext?v=5H9N9E0F-IM' };
function emit(payload = state) {
  const event = new Event('message');
  Object.assign(event, { source: pageWindow, origin: 'https://www.youtube.com', data: { channel: PAGE_CHANNEL, direction: 'from-page', type: 'PLAYER_STATE', payload } });
  pageWindow.dispatchEvent(event);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.runtime.id = 'test-extension';
  mocks.runtime.sendMessage.mockResolvedValue(null);
  mocks.cacheGet.mockResolvedValue(null);
  const parent = { append: vi.fn() };
  pageWindow = Object.assign(new EventTarget(), { postMessage: vi.fn(), setInterval, clearInterval, setTimeout, clearTimeout });
  vi.stubGlobal('window', pageWindow);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { querySelector: () => parent }));
  vi.stubGlobal('location', { origin: 'https://www.youtube.com' });
  vi.stubGlobal('browser', mocks.browser);
  vi.stubGlobal('injectScript', vi.fn().mockResolvedValue(undefined));
  vi.stubGlobal('defineContentScript', (definition: unknown) => definition);
  const controller = new AbortController();
  // Model WXT's lazy runtime.id check and context-owned timers/listeners.
  ctx = {
    get isInvalid() { if (!mocks.runtime.id) controller.abort(); return controller.signal.aborted; },
    notifyInvalidated() { controller.abort(); },
    onInvalidated(callback: () => void) { controller.signal.addEventListener('abort', callback); },
    setInterval(callback: () => void, delay: number) {
      const id = setInterval(() => { if (!ctx.isInvalid) callback(); }, delay);
      controller.signal.addEventListener('abort', () => clearInterval(id));
      return id;
    },
    setTimeout(callback: () => void, delay: number) {
      const id = setTimeout(() => { if (!ctx.isInvalid) callback(); }, delay);
      controller.signal.addEventListener('abort', () => clearTimeout(id));
      return id;
    },
    addEventListener(target: EventTarget, type: string, callback: EventListener) {
      target.addEventListener(type, callback, { signal: controller.signal });
    },
  } as unknown as ContentScriptContext;
  const script = (await import('../entrypoints/youtube.content')).default;
  await script.main(ctx);
});
afterEach(() => { ctx.notifyInvalidated(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('YouTube extension lifetime', () => {
  it('stops rendering and IPC on the first player event after a reload', () => {
    emit();
    const updates = mocks.ui.update.mock.calls.length;
    const messages = mocks.runtime.sendMessage.mock.calls.length;
    mocks.runtime.id = undefined;
    emit();
    emit();
    vi.advanceTimersByTime(5000);
    expect(mocks.ui.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.ui.update).toHaveBeenCalledTimes(updates);
    expect(mocks.runtime.sendMessage).toHaveBeenCalledTimes(messages);
    expect(mocks.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('detects invalidation while paused without waiting for a player event', () => {
    mocks.runtime.id = undefined;
    vi.advanceTimersByTime(800);
    expect(mocks.ui.invalidate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still retires the UI when removing an expired runtime listener throws', () => {
    mocks.runtime.onMessage.removeListener.mockImplementationOnce(() => { throw new Error('Extension context invalidated.'); });
    mocks.runtime.id = undefined;
    expect(() => emit()).not.toThrow();
    expect(mocks.ui.invalidate).toHaveBeenCalledOnce();
  });

  it('discards a pending caption cache response instead of fetching or remounting', async () => {
    let resolve!: (value: unknown) => void;
    mocks.runtime.sendMessage.mockImplementation((message: { type: string }) => message.type === 'CAPTION_CACHE_GET' ? new Promise(r => { resolve = r; }) : Promise.resolve(null));
    emit({ ...state, tracks: [track] } as typeof state);
    mocks.runtime.id = undefined;
    emit();
    const updates = mocks.ui.update.mock.calls.length;
    resolve({ trackId: 'en', cues: [{ seq: 0, startMs: 0, endMs: 1000, text: 'Hello' }] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.fetchTrack).not.toHaveBeenCalled();
    expect(mocks.ui.update).toHaveBeenCalledTimes(updates);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a scheduled subtitle retry after invalidation', async () => {
    mocks.fetchTrack.mockRejectedValueOnce(new Error('temporary failure'));
    emit({ ...state, tracks: [track] } as typeof state);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetchTrack).toHaveBeenCalledOnce();
    mocks.runtime.id = undefined;
    await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.fetchTrack).toHaveBeenCalledOnce();
    expect(mocks.ui.invalidate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the old UI without an update notice when replaced by a valid script', () => {
    ctx.notifyInvalidated();
    expect(mocks.ui.destroy).toHaveBeenCalledOnce();
    expect(mocks.ui.invalidate).not.toHaveBeenCalled();
  });
});
