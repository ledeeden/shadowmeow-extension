import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireMessage } from './store';

const mocks = vi.hoisted(() => ({ callApi: vi.fn() }));
vi.mock('../cloudbase', () => ({ callApi: mocks.callApi }));
import { completeModel } from './provider';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function hostedResponse(result: unknown, text = '') {
  mocks.callApi.mockResolvedValue({ stream: { url: 'https://example.com/ai-stream', token: 'ticket' } });
  const events = [...(text ? [{ type: 'text', text }] : []), { type: 'result', result }];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 })));
}

describe('centralized DeepSeek transport', () => {
  it('sends no user credential and preserves tool calls plus usage', async () => {
    hostedResponse({
      model: 'deepseek-flash',
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'history_search', arguments: '{"query":"hotel"}' } }] },
      usage: { promptTokens: 30, cacheHitTokens: 10, cacheMissTokens: 20, completionTokens: 5, reasoningTokens: 0, totalTokens: 35 },
      estimatedCostCnyMicros: 80,
    });
    const result = await completeModel({ messages: [{ role: 'user', content: 'hotel' }], signal: new AbortController().signal });
    expect(mocks.callApi).toHaveBeenCalledWith('ai.complete', expect.objectContaining({ purpose: 'agent', messages: [{ role: 'user', content: 'hotel' }] }));
    expect(JSON.stringify(mocks.callApi.mock.calls[0])).not.toContain('apiKey');
    expect(result.tool_calls?.[0]?.function.name).toBe('history_search');
    expect(result.usage?.totalTokens).toBe(35);
  });

  it('publishes hosted text events to the UI', async () => {
    hostedResponse({
      model: 'deepseek-flash', message: { role: 'assistant', content: '完整回答' },
      usage: { promptTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1, reasoningTokens: 0, totalTokens: 2 }, estimatedCostCnyMicros: 5,
    }, '完整回答');
    const onText = vi.fn();
    await completeModel({ messages: [{ role: 'user', content: 'hello' }], signal: new AbortController().signal, onText });
    expect(onText).toHaveBeenCalledWith('完整回答');
  });

  it('projects live multi-turn messages onto the strict wire schema', async () => {
    hostedResponse({
      model: 'deepseek-flash', message: { role: 'assistant', content: 'done' },
      usage: { promptTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1, reasoningTokens: 0, totalTokens: 2 }, estimatedCostCnyMicros: 5,
    });
    const messages = [
      { role: 'user', content: 'first', id: 'q1', owner: 'user:1', conversationId: 'c1', createdAt: 1, status: 'complete' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'history_search', arguments: '{}', localOnly: true } }], usage: { totalTokens: 12 }, estimatedCostCnyMicros: 9 },
      { role: 'tool', content: '{}', tool_call_id: 'call-1', id: 't1', owner: 'user:1', conversationId: 'c1', createdAt: 2, status: 'complete' },
    ] as unknown as WireMessage[];

    await completeModel({ messages, signal: new AbortController().signal });

    expect(mocks.callApi).toHaveBeenCalledWith('ai.complete', expect.objectContaining({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'history_search', arguments: '{}' } }] },
        { role: 'tool', content: '{}', tool_call_id: 'call-1' },
      ],
    }));
  });

  it('honors local cancellation while the server request is still pending', async () => {
    mocks.callApi.mockReturnValue(new Promise(() => undefined));
    const abort = new AbortController();
    const request = completeModel({ messages: [{ role: 'user', content: 'hello' }], signal: abort.signal });
    abort.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('renders partial UTF-8 text before the stream completes and disables thinking', async () => {
    mocks.callApi.mockResolvedValue({ stream: { url: 'https://example.com/ai-stream', token: 'ticket' } });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => new Response(stream));
    vi.stubGlobal('fetch', fetchMock);
    const encoder = new TextEncoder();
    let received!: () => void;
    const firstText = new Promise<void>(resolve => { received = resolve; });
    const onText = vi.fn((_text: string) => received());
    const request = completeModel({ messages: [{ role: 'user', content: 'hello' }], thinking: true, signal: new AbortController().signal, onText });
    const first = encoder.encode('data: {"type":"text","text":"你好"}\n\n');
    const split = encoder.encode('data: {"type":"text","text":"').length + 1;
    controller.enqueue(first.slice(0, split));
    controller.enqueue(first.slice(split));
    await firstText;
    expect(onText).toHaveBeenCalledWith('你好');
    expect(mocks.callApi).toHaveBeenCalledWith('ai.complete', expect.objectContaining({ stream: true, thinking: false }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).payload.thinking).toBe(false);
    controller.enqueue(encoder.encode('data: {"type":"text","text":"世界"}\n\ndata: {"type":"result","result":{"message":{"role":"assistant","content":"你好世界"},"usage":{"totalTokens":4}}}\n\n'));
    controller.close();
    await expect(request).resolves.toMatchObject({ content: '你好世界', usage: { totalTokens: 4 } });
    expect(onText.mock.calls.map(call => call[0])).toEqual(['你好', '你好世界']);
  });

  it('keeps partial output when the stream ends without a result', async () => {
    mocks.callApi.mockResolvedValue({ stream: { url: 'https://example.com/ai-stream', token: 'ticket' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"text","text":"partial"}\n\n')));
    const onText = vi.fn();
    await expect(completeModel({ messages: [], signal: new AbortController().signal, onText })).rejects.toThrow('连接中断');
    expect(onText).toHaveBeenCalledWith('partial');
  });

  it('cancels an active reader and preserves the received text', async () => {
    mocks.callApi.mockResolvedValue({ stream: { url: 'https://example.com/ai-stream', token: 'ticket' } });
    const cancelled = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"text","text":"partial"}\n\n')); },
      cancel: cancelled,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)));
    const abort = new AbortController();
    const onText = vi.fn(() => abort.abort());
    await expect(completeModel({ messages: [], signal: abort.signal, onText })).rejects.toMatchObject({ name: 'AbortError' });
    expect(onText).toHaveBeenCalledWith('partial');
    expect(cancelled).toHaveBeenCalled();
  });

  it('reports a streaming server error without publishing a successful result', async () => {
    mocks.callApi.mockResolvedValue({ stream: { url: 'https://example.com/ai-stream', token: 'ticket' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"text","text":"partial"}\n\ndata: {"type":"error","message":"回答达到本轮长度上限"}\n\n')));
    const onText = vi.fn();
    await expect(completeModel({ messages: [], signal: new AbortController().signal, onText })).rejects.toThrow('长度上限');
    expect(onText).toHaveBeenCalledWith('partial');
  });
});

describe('extension BYOK transport', () => {
  it('uses the supplied user key directly and does not call the hosted relay', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await completeModel({ key: ' user-key ', messages: [{ role: 'user', content: 'hello' }], signal: new AbortController().signal });

    expect(result.content).toBe('hello');
    expect(mocks.callApi).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer user-key' }),
    }));
  });
});
