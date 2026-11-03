import { t } from '../../lib/i18n';
import { Icon } from '../icon';
import React, { useMemo, useState } from 'react';
import type { AgentConversation } from '../../lib/agent/store';
import {
  filterConversations,
  formatRelativeTime,
  groupConversations,
} from '../../lib/agent/conversation-grouping';

export type AgentHistoryDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  conversations: AgentConversation[];
  currentConversationId: string;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => Promise<void>;
  onRenameConversation: (id: string, newTitle: string) => Promise<void>;
  currentVideoKey?: string | undefined;
  isEmbedded?: boolean | undefined; // When true, rendered as permanent sidebar in wide screen
};

export function AgentHistoryDrawer({
  isOpen,
  onClose,
  conversations,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onRenameConversation,
  currentVideoKey,
  isEmbedded = false,
}: AgentHistoryDrawerProps) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filtered = useMemo(
    () => filterConversations(conversations, query),
    [conversations, query],
  );

  const groups = useMemo(
    () => groupConversations(filtered, currentVideoKey),
    [filtered, currentVideoKey],
  );

  const handleStartRename = (c: AgentConversation, event: React.MouseEvent) => {
    event.stopPropagation();
    setEditingId(c.id);
    setEditingTitle(c.title);
  };

  const handleSaveRename = async (id: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed && trimmed !== conversations.find((c) => c.id === id)?.title) {
      await onRenameConversation(id, trimmed);
    }
    setEditingId(null);
  };

  const handleDelete = async (id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setDeletingId(id);
    try {
      await onDeleteConversation(id);
    } finally {
      setDeletingId(null);
    }
  };

  if (!isOpen && !isEmbedded) return null;

  return (
    <>
      {!isEmbedded && (
        <div
          className="agent-drawer-backdrop"
          onClick={onClose}
          aria-label={t("关闭历史抽屉")}
        />
      )}
      <aside
        className={`agent-history-drawer ${isEmbedded ? 'embedded' : 'slide-over'} ${
          isOpen ? 'open' : ''
        }`}
        aria-label={t("会话历史")}
      >
        <header className="agent-history-drawer-header">
          <div className="agent-history-drawer-title">
            <h3>{t("会话记录")}</h3>
            {!isEmbedded && (
              <button
                type="button"
                className="agent-icon-btn"
                onClick={onClose}
                aria-label={t("关闭历史抽屉")}
                title={t("关闭")}
              >
                <Icon name="close" />
              </button>
            )}
          </div>
          <button
            type="button"
            className="agent-new-chat-btn"
            onClick={() => {
              onNewConversation();
              if (!isEmbedded) onClose();
            }}
          >
            <span><Icon name="plus" /></span> {t("新建对话")}</button>
          <div className="agent-history-search">
            <input
              type="search"
              placeholder={t("搜索历史对话…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("搜索历史对话")}
            />
          </div>
        </header>

        <div className="agent-history-drawer-content">
          {groups.length === 0 ? (
            <div className="agent-history-empty">
              {query ? t("未找到相关对话") : t("暂无历史会话")}
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.id} className="agent-history-group">
                <h4 className="agent-history-group-title">{group.title}</h4>
                <ul className="agent-history-list">
                  {group.items.map((c) => {
                    const isActive = c.id === currentConversationId;
                    const isEditing = c.id === editingId;

                    return (
                      <li
                        key={c.id}
                        className={`agent-history-item ${isActive ? 'active' : ''}`}
                        onClick={() => {
                          if (isEditing) return;
                          onSelectConversation(c.id);
                          if (!isEmbedded) onClose();
                        }}
                      >
                        {isEditing ? (
                          <div
                            className="agent-history-rename"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              autoFocus
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleSaveRename(c.id);
                                if (e.key === 'Escape') setEditingId(null);
                              }}
                              onBlur={() => void handleSaveRename(c.id)}
                            />
                          </div>
                        ) : (
                          <>
                            <div className="agent-history-info">
                              <span className="agent-history-item-title" title={c.title}>
                                {c.videoKey && <span className="agent-video-badge"><Icon name="video" /></span>}
                                {c.title}
                              </span>
                              <span className="agent-history-time">
                                {formatRelativeTime(c.updatedAt || c.createdAt)}
                              </span>
                            </div>
                            <div className="agent-history-actions">
                              <button
                                type="button"
                                className="agent-action-btn"
                                title={t("重命名")}
                                aria-label={t("重命名对话")}
                                onClick={(e) => handleStartRename(c, e)}
                              >
                                <Icon name="edit" />
                              </button>
                              <button
                                type="button"
                                className="agent-action-btn delete"
                                title={t("删除对话")}
                                aria-label={t("删除对话")}
                                disabled={deletingId === c.id}
                                onClick={(e) => void handleDelete(c.id, e)}
                              >
                                <Icon name="trash" />
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
