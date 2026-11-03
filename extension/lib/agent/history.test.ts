import { expect, it } from 'vitest';
import { modelHistory } from './history';
import type { AgentMessage } from './store';

it('repairs an interrupted tool sequence before the next user question', () => {
  const base = { id: '1', owner: 'local', conversationId: 'c', createdAt: 1, status: 'complete' as const };
  const history: AgentMessage[] = [
    { ...base, role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'history_search', arguments: '{}' } }] },
    { ...base, id: '2', role: 'user', content: '继续' },
  ];
  const result = modelHistory(history);
  expect(result.map(m => m.role)).toEqual(['assistant', 'tool', 'user']);
  expect(result[1]?.tool_call_id).toBe('call');
});

it('omits orphaned tool messages and incomplete assistant output', () => {
  const base = { id: '1', owner: 'local', conversationId: 'c', createdAt: 1 };
  expect(modelHistory([
    { ...base, role: 'assistant', content: 'partial', status: 'interrupted' },
    { ...base, role: 'tool', content: 'orphan', tool_call_id: 'missing', status: 'complete' },
  ])).toEqual([]);
});

it('formats text, markdown and image attachments in user messages', () => {
  const base = { id: '1', owner: 'local', conversationId: 'c', createdAt: 1, status: 'complete' as const };
  const history: AgentMessage[] = [
    {
      ...base,
      role: 'user',
      content: '请总结文件',
      attachments: [
        { id: 'a1', name: 'sample.txt', type: 'text', size: 100, content: 'Hello world txt' },
        { id: 'a2', name: 'notes.md', type: 'markdown', size: 200, content: '# Header\nSome md' },
        { id: 'a3', name: 'photo.png', type: 'image', size: 300, dataUrl: 'data:image/png;base64,xxx' },
      ],
    },
  ];
  const result = modelHistory(history);
  expect(result).toHaveLength(1);
  const first = result[0]!;
  expect(first.content).toContain('请总结文件');
  expect(first.content).toContain('[附件文件: sample.txt]\n```\nHello world txt\n```');
  expect(first.content).toContain('[附件文件: notes.md]\n```markdown\n# Header\nSome md\n```');
  expect(first.content).toContain('[用户上传了图片附件: photo.png]');
});
