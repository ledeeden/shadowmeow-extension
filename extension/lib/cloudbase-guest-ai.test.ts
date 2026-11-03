import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const cloudApp = vi.hoisted(() => ({ callFunction: vi.fn(), auth: { getCurrentUser: vi.fn() } }));
vi.mock('@cloudbase/js-sdk', () => ({ default: { useAdapters: vi.fn(), init: () => cloudApp } }));
vi.mock('./analytics', () => ({ track: vi.fn() }));
vi.mock('./cloudbase-adapter', () => ({ cloudExtensionAdapter: {}, flushCloudBaseStorage: vi.fn(), prepareCloudBaseStorage: vi.fn() }));

import { callApi } from './cloudbase';

beforeEach(() => { cloudApp.auth.getCurrentUser.mockResolvedValue(null); });

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('sends the signed-out Web onboarding AI request through public HTTP, not the credentialed SDK', async () => {
  vi.stubGlobal('browser', {
    runtime: { getURL: () => 'https://example.com/' },
    storage: { local: { get: vi.fn(async () => ({ deviceId: 'guest-device-123' })), set: vi.fn() } },
  });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    ok: true, requestId: 'guest-request-123', data: { message: { role: 'assistant', content: '{}' } }, serverTime: new Date().toISOString(),
  }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(callApi('ai.complete', { purpose: 'onboarding', messages: [{ role: 'user', content: 'Pick one sentence.' }] })).resolves.toEqual({ message: { role: 'assistant', content: '{}' } });
  expect(fetchMock).toHaveBeenCalledWith('https://example.com/public-learning', expect.objectContaining({ method: 'POST' }));
  expect(cloudApp.callFunction).not.toHaveBeenCalled();
});

it('keeps ordinary Web AI on the credentialed transport', async () => {
  vi.stubGlobal('browser', {
    runtime: { getURL: () => 'https://example.com/' },
    storage: { local: { get: vi.fn(async () => ({ deviceId: 'signed-in-device-123' })), set: vi.fn() } },
  });
  cloudApp.callFunction.mockResolvedValue({ result: { ok: true, requestId: 'request-123', data: { message: { role: 'assistant', content: 'private' } }, serverTime: new Date().toISOString() } });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  await callApi('ai.complete', { purpose: 'agent', messages: [{ role: 'user', content: 'Analyze this.' }] });
  expect(cloudApp.callFunction).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('uses authenticated transport for every ordinary playback and subtitle action', async () => {
  vi.stubGlobal('browser', {
    runtime: { getURL: () => 'https://example.com/' },
    storage: { local: { get: vi.fn(async () => ({ deviceId: 'signed-in-device-123' })), set: vi.fn() } },
  });
  cloudApp.callFunction.mockResolvedValue({ result: { ok: true, requestId: 'request-123', data: { status: 'available' }, serverTime: new Date().toISOString() } });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  for (const [action, payload] of [
    ['mediaCorpus.resolvePlayback', { corpusItemId: 'ordinary-media' }],
    ['corpus.getSubtitleDetail', { subtitleId: 'media:ordinary-media', contentVersion: 'v1' }],
    ['corpus.resolveSubtitles', { videoKey: 'bilibili:ep:123:cid:456', durationMs: 1000 }],
    ['corpus.webPlayback', { youtubeId: '9PXluC2FMD0' }],
  ] as const) await callApi(action, payload);
  expect(cloudApp.callFunction).toHaveBeenCalledTimes(4);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('keeps only signed-out onboarding content on HTTP and does not cache it across sign-in', async () => {
  vi.stubGlobal('browser', {
    runtime: { getURL: () => 'https://example.com/' },
    storage: { local: { get: vi.fn(async () => ({ deviceId: 'guest-device-123' })), set: vi.fn() } },
  });
  const response = { ok: true, requestId: 'request-123', data: { status: 'available' }, serverTime: new Date().toISOString() };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  for (const [action, payload] of [
    ['mediaCorpus.resolvePlayback', { corpusItemId: 'onboarding-foundation-v1' }],
    ['corpus.getSubtitleDetail', { subtitleId: 'media:onboarding-foundation-v1', contentVersion: 'v1' }],
  ] as const) {
    cloudApp.auth.getCurrentUser.mockResolvedValue(null);
    await callApi(action, payload);
    cloudApp.auth.getCurrentUser.mockResolvedValue({ uid: 'user-a' });
    cloudApp.callFunction.mockResolvedValue({ result: response });
    await callApi(action, payload);
  }
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(cloudApp.callFunction).toHaveBeenCalledTimes(2);
});
