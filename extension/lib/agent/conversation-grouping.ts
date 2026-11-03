import type { AgentConversation } from './store';

export type ConversationGroup = {
  id: 'current' | 'today' | 'yesterday' | 'last7Days' | 'older';
  title: string;
  items: AgentConversation[];
};

export function filterConversations(
  conversations: AgentConversation[],
  query: string,
): AgentConversation[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return conversations;
  return conversations.filter((c) => c.title.toLowerCase().includes(normalized));
}

export function groupConversations(
  conversations: AgentConversation[],
  currentVideoKey?: string,
  now = Date.now(),
): ConversationGroup[] {
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const yesterdayStart = todayStart - 86_400_000;
  const last7DaysStart = todayStart - 6 * 86_400_000;

  const currentItems: AgentConversation[] = [];
  const todayItems: AgentConversation[] = [];
  const yesterdayItems: AgentConversation[] = [];
  const last7DaysItems: AgentConversation[] = [];
  const olderItems: AgentConversation[] = [];

  for (const c of conversations) {
    if (currentVideoKey && c.videoKey === currentVideoKey) {
      currentItems.push(c);
      continue;
    }

    const time = c.updatedAt || c.createdAt || 0;
    if (time >= todayStart) {
      todayItems.push(c);
    } else if (time >= yesterdayStart) {
      yesterdayItems.push(c);
    } else if (time >= last7DaysStart) {
      last7DaysItems.push(c);
    } else {
      olderItems.push(c);
    }
  }

  const groups: ConversationGroup[] = [];

  if (currentItems.length > 0) {
    groups.push({ id: 'current', title: '当前视频对话', items: currentItems });
  }
  if (todayItems.length > 0) {
    groups.push({ id: 'today', title: '今天', items: todayItems });
  }
  if (yesterdayItems.length > 0) {
    groups.push({ id: 'yesterday', title: '昨天', items: yesterdayItems });
  }
  if (last7DaysItems.length > 0) {
    groups.push({ id: 'last7Days', title: '过去 7 天', items: last7DaysItems });
  }
  if (olderItems.length > 0) {
    groups.push({ id: 'older', title: '更早', items: olderItems });
  }

  return groups;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - timestamp);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay === 1) return '昨天';
  if (diffDay < 7) return `${diffDay} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
