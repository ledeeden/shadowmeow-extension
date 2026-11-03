import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { videoKeyOf, type PageState, type RuntimeMessage } from '@shadow-language/contracts';
import { AgentApp, type AgentTab, type AgentLearningScene } from './agent-app';
import type { VideoReference } from '../../lib/agent/store';
import { unwrapRuntimeResponse } from '../../lib/runtime-errors';

export function AgentSidePanel({ defaultTab, activeTab, onActiveTabChange, showAiSettingsButton, showBrandButton, externalDraft, contextPage, learningScene }: { defaultTab?: AgentTab; activeTab?: AgentTab; onActiveTabChange?: (tab: AgentTab) => void; showAiSettingsButton?: boolean; showBrandButton?: boolean; externalDraft?: { id: string; text: string }; contextPage?: PageState | undefined; learningScene?: AgentLearningScene | undefined }) {
  const [page, setPage] = useState<PageState>();
  const [reference, setReference] = useState<VideoReference>();

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        const data = unwrapRuntimeResponse(await browser.runtime.sendMessage({ type: 'AGENT_CONTEXT' })) as { page?: PageState; reference?: VideoReference };
        if (!disposed) {
          setPage(data.page);
          setReference(data.reference);
        }
      } catch {
        if (!disposed) {
          setPage(undefined);
          setReference(undefined);
        }
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    const onRuntimeMessage = (message: RuntimeMessage) => {
      if (message.type === 'AGENT_CONTEXT_CHANGED') void refresh();
    };
    browser.runtime.onMessage.addListener(onRuntimeMessage);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
    };
  }, []);

  const effectivePage = contextPage || page;
  return <AgentApp
    {...(learningScene ? { learningScene } : {})}
    {...(externalDraft ? { externalDraft } : {})}
    key={effectivePage?.videoKey || effectivePage?.youtubeId || 'loading'}
    {...(effectivePage ? { page: effectivePage } : {})}
    {...(reference ? { reference } : {})}
    {...(defaultTab ? { initialTab: defaultTab } : {})}
    {...(activeTab ? { activeTab } : {})}
    {...(onActiveTabChange ? { onActiveTabChange } : {})}
    {...(showAiSettingsButton === undefined ? {} : { showAiSettingsButton })}
    {...(showBrandButton === undefined ? {} : { showBrandButton })}
    onReferenceSaved={(id) => void browser.runtime.sendMessage({ type: 'AGENT_REFERENCE_SAVED', id })}
    onReplay={(timeMs) => void browser.runtime.sendMessage({ type: 'AGENT_REPLAY', videoKey: effectivePage ? videoKeyOf(effectivePage) : '', timeMs })}
  />;
}

export function mountAgentSidePanel(rootId = 'root', defaultTab?: AgentTab) {
  createRoot(document.getElementById(rootId)!).render(<AgentSidePanel {...(defaultTab ? { defaultTab } : {})} />);
}
