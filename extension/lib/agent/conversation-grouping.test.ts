import { describe, expect, it } from 'vitest';
import { filterConversations, formatRelativeTime, groupConversations } from './conversation-grouping';
import type { AgentConversation } from './store';

describe('conversation-grouping', () => {
  const baseConversations: AgentConversation[] = [
    {
      id: 'c-current',
      owner: 'user1',
      title: 'Current Video Chat',
      videoKey: 'vid-123',
      createdAt: 1000,
      updatedAt: 1000,
    },
    {
      id: 'c-today',
      owner: 'user1',
      title: 'Today General Discussion',
      createdAt: Date.now() - 3600_000,
      updatedAt: Date.now() - 3600_000,
    },
    {
      id: 'c-yesterday',
      owner: 'user1',
      title: 'Yesterday Grammar',
      createdAt: Date.now() - 86400_000,
      updatedAt: Date.now() - 86400_000,
    },
    {
      id: 'c-older',
      owner: 'user1',
      title: 'Old Vocabulary Chat',
      createdAt: Date.now() - 30 * 86400_000,
      updatedAt: Date.now() - 30 * 86400_000,
    },
  ];

  it('filters conversations by query case-insensitively', () => {
    const matched = filterConversations(baseConversations, 'grammar');
    expect(matched).toHaveLength(1);
    expect(matched[0]?.id).toBe('c-yesterday');

    expect(filterConversations(baseConversations, '')).toHaveLength(4);
    expect(filterConversations(baseConversations, 'non-existent')).toHaveLength(0);
  });

  it('groups conversations with current video prioritized', () => {
    const groups = groupConversations(baseConversations, 'vid-123');
    expect(groups[0]?.id).toBe('current');
    expect(groups[0]?.items[0]?.id).toBe('c-current');
  });

  it('formats relative time accurately', () => {
    const now = 1700000000000;
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚');
    expect(formatRelativeTime(now - 120_000, now)).toBe('2 分钟前');
    expect(formatRelativeTime(now - 7200_000, now)).toBe('2 小时前');
  });
});
