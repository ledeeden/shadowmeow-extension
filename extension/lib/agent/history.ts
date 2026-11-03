import type { AgentMessage, WireMessage } from './store';

/** Rebuild valid protocol turns after a page was closed mid-tool-call. */
export function modelHistory(history: AgentMessage[]): WireMessage[] {
  const output: WireMessage[] = [];
  const pending = new Set<string>();
  const closePending = () => {
    for (const id of pending) output.push({ role: 'tool', tool_call_id: id, content: '{"error":"上次操作中断，结果未知，请重新查询。"}' });
    pending.clear();
  };
  for (const m of history) {
    if (m.status !== 'complete') continue;
    if (m.role === 'tool') {
      if (!m.tool_call_id || !pending.has(m.tool_call_id)) continue;
      pending.delete(m.tool_call_id);
    } else closePending();
    let content = m.content;
    if (m.role === 'user') {
      if (m.attachments?.length) {
        const parts: string[] = [];
        for (const att of m.attachments) {
          if (att.type === 'text' || att.type === 'markdown') {
            parts.push(`[附件文件: ${att.name}]\n\`\`\`${att.type === 'markdown' ? 'markdown' : ''}\n${att.content || ''}\n\`\`\``);
          } else if (att.type === 'image') {
            parts.push(`[用户上传了图片附件: ${att.name}]`);
          }
        }
        if (parts.length) {
          content = content ? `${content}\n\n${parts.join('\n\n')}` : parts.join('\n\n');
        }
      }
      if (m.context) {
        content = `${content || ''}\n[提问时的视频资料] ${JSON.stringify(m.context)}`;
      }
    }
    output.push({ role: m.role, content,
      ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    });
    for (const call of m.tool_calls || []) pending.add(call.id);
  }
  closePending();
  return output;
}
