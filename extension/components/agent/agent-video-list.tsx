import { t } from '../../lib/i18n';
import React, { useState } from 'react';
import { Icon } from '../icon';

export type AgentVideoItem = { videoKey: string; title: string; updatedAt: number };

export function AgentVideoList({ kind, items, selected, onSelect, isOpen, isEmbedded, onClose }: {
  kind: 'notes' | 'words'; items: AgentVideoItem[]; selected: string;
  onSelect: (key: string) => void; isOpen: boolean; isEmbedded: boolean; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  if (!isOpen && !isEmbedded) return null;
  const title = kind === 'notes' ? t("视频笔记") : t("视频生词");
  const filtered = items.filter(item => item.title.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    {!isEmbedded && <div className="agent-drawer-backdrop" onClick={onClose} />}
    <aside className={`agent-history-drawer ${isEmbedded ? 'embedded' : 'slide-over open'}`} aria-label={title}>
      <header className="agent-history-drawer-header">
        <div className="agent-history-drawer-title"><h3>{title}</h3>
          {!isEmbedded && <button type="button" className="agent-icon-btn" aria-label={t("关闭视频列表")} onClick={onClose}><Icon name="close" /></button>}
        </div>
        <div className="agent-history-search"><input type="search" aria-label={t("搜索{0}", title)} placeholder={t("搜索视频…")} value={query} onChange={event => setQuery(event.target.value)} /></div>
      </header>
      <div className="agent-history-drawer-content agent-video-list">
        {filtered.map(item => <button type="button" key={item.videoKey} className="agent-video-list-item" aria-current={selected === item.videoKey ? 'true' : undefined}
          onClick={() => { onSelect(item.videoKey); onClose(); }}>
          <Icon name="video" /><span>{item.title}</span>
        </button>)}
        {!filtered.length && <div className="agent-history-empty">{query ? t("没有找到视频") : t("暂无{0}", title)}</div>}
      </div>
    </aside>
  </>;
}
