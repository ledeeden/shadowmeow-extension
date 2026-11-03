import { callApi } from '../cloudbase';
import type { ToolCall, WireMessage } from './store';

export type AgentTool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ModelUsage = {
  promptTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};
export type ModelResult = WireMessage & { usage?: ModelUsage; estimatedCostCnyMicros?: number };
export type ModelPurpose = 'agent' | 'follow_up' | 'study_document' | 'onboarding';
export const DEEPSEEK_MODEL = 'deepseek-flash';

/** Remove local persistence metadata before sending a message to either provider. */
export function toWireMessage(message: WireMessage): WireMessage {
  return {
    role: message.role,
    content: message.content,
    ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}),
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map(call => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.function.name, arguments: call.function.arguments },
      })),
    } : {}),
    ...(typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
  };
}

function errorMessage(status: number) {
  if (status === 401) return 'Key 无效，请检查后重试。';
  if (status === 402) return 'DeepSeek 余额不足。';
  if (status === 429) return '请求过于频繁，请稍后重试。';
  return `DeepSeek 请求失败（${status}），请稍后重试。`;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function completeHosted(options: {
  messages: WireMessage[];
  tools?: AgentTool[];
  signal: AbortSignal;
  thinking?: boolean;
  purpose?: ModelPurpose;
  onText?: (text: string) => void;
}): Promise<ModelResult> {
  options.signal.throwIfAborted();
  const payload = {
    purpose: options.purpose || 'agent',
    messages: options.messages.map(toWireMessage),
    ...(options.tools?.length ? { tools: options.tools } : {}),
    thinking: false,
    stream: true,
    maxTokens: 4096,
  };
  const ticket = await abortable(callApi<{ stream: { url: string; token: string } }>('ai.complete', payload), options.signal);
  options.signal.throwIfAborted();
  if (!ticket.stream?.url || !ticket.stream.token) throw new Error('AI 流式服务尚未就绪，请稍后重试。');
  const response = await fetch(ticket.stream.url, {
    method: 'POST', signal: options.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ token: ticket.stream.token, payload }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message || 'AI 服务连接失败，请稍后重试。');
  }
  if (!response.body) throw new Error('没有收到响应内容。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '';
  let result: { message: WireMessage; usage: ModelUsage; estimatedCostCnyMicros: number } | undefined;
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    const event = JSON.parse(data);
    if (event.type === 'error') throw new Error(event.message || '回答连接中断，已保留收到的内容。');
    if (event.type === 'text' && typeof event.text === 'string') { content += event.text; options.onText?.(content); }
    if (event.type === 'result') result = event.result;
  };
  const abort = () => { void reader.cancel().catch(() => undefined); };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    while (!result) {
      options.signal.throwIfAborted();
      const { value, done } = await reader.read();
      options.signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) consume(line.trimEnd());
      if (done) { if (buffer.trim()) consume(buffer.trimEnd()); break; }
    }
  } finally {
    options.signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!result?.message) throw new Error('回答连接中断，已保留收到的内容。');
  return { ...result.message, usage: result.usage, estimatedCostCnyMicros: result.estimatedCostCnyMicros };
}

async function completeByok(options: {
  key: string;
  messages: WireMessage[];
  tools?: AgentTool[];
  signal: AbortSignal;
  thinking?: boolean;
  onText?: (text: string) => void;
}): Promise<ModelResult> {
  if (!options.key.trim()) throw new Error('请先在 AI 设置中配置 DeepSeek Key。');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', signal: options.signal,
    headers: { Authorization: `Bearer ${options.key.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: options.messages.map(toWireMessage),
      ...(options.tools?.length ? { tools: options.tools } : {}),
      thinking: { type: options.thinking ? 'enabled' : 'disabled' },
      ...(options.thinking ? { reasoning_effort: 'low' } : {}),
      max_tokens: 4096, stream: true, stream_options: { include_usage: true },
    }),
  });
  if (!response.ok) throw new Error(errorMessage(response.status));
  if (!response.body) throw new Error('没有收到响应内容。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, ToolCall>();
  let buffer = '', content = '', reasoning = '', finished = false, finishReason = '';
  let usage: ModelResult['usage'];
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { finished = true; return; }
    const event = JSON.parse(data);
    if (event.error) throw new Error('DeepSeek 返回错误，请重试。');
    if (event.usage) usage = event.usage;
    if (event.choices?.[0]?.finish_reason) finishReason = event.choices[0].finish_reason;
    const delta = event.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string') { content += delta.content; options.onText?.(content); }
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    for (const part of delta.tool_calls || []) {
      if (!Number.isInteger(part.index)) throw new Error('工具响应格式不正确。');
      const call = calls.get(part.index) || { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
      calls.set(part.index, call);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) consume(line.trimEnd());
      if (done) { if (buffer.trim()) consume(buffer.trimEnd()); break; }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!finished) throw new Error('回答连接中断，已保留收到的内容。');
  if (finishReason === 'length') throw new Error('回答达到本轮长度上限，已保留内容，可以继续追问。');
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.some(call => !call.id || !call.function.name)) throw new Error('工具响应不完整。');
  return { role: 'assistant', content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(usage ? { usage } : {}) };
}

/**
 * The Chrome extension supplies a user-owned key. The Web app omits the key
 * and uses the CloudBase relay; only the bounded onboarding purpose is
 * available before sign-in.
 */
export async function completeModel(options: {
  key?: string;
  messages: WireMessage[];
  tools?: AgentTool[];
  signal: AbortSignal;
  thinking?: boolean;
  purpose?: ModelPurpose;
  onText?: (text: string) => void;
}): Promise<ModelResult> {
  return options.key ? completeByok({ ...options, key: options.key }) : completeHosted(options);
}

export async function testKey(key: string, signal: AbortSignal) {
  if (!key.trim()) throw new Error('请先填写 Key。');
  const tools: AgentTool[] = [{ type: 'function', function: { name: 'connection_echo', description: 'Return the supplied text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }];
  const messages: WireMessage[] = [{ role: 'user', content: 'Call connection_echo with text shadow-language-ok, then report its returned text.' }];
  const started = Date.now();
  const first = await completeModel({ key, signal, tools, messages });
  if (!first.tool_calls?.length) throw new Error('模型连接成功，但没有完成工具调用。请重试。');
  messages.push(first);
  for (const call of first.tool_calls) {
    const args = JSON.parse(call.function.arguments);
    if (call.function.name !== 'connection_echo' || args.text !== 'shadow-language-ok') throw new Error('工具参数校验未通过。');
    messages.push({ role: 'tool', tool_call_id: call.id, content: args.text });
  }
  const final = await completeModel({ key, signal, tools, messages });
  if (final.tool_calls?.length || !final.content?.includes('shadow-language-ok')) throw new Error('工具返回后的回答未通过连接检查。');
  return { elapsedMs: Date.now() - started, model: DEEPSEEK_MODEL };
}
