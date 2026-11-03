import React, { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { liveQuery } from 'dexie';
import { agentDb, type AgentMemory, type KnowledgeDocument } from '../../lib/agent/store';
import { studyOwner } from '../../lib/agent/study-documents';
import { AiSettingsOpenerProvider } from './ai-settings-context';
const AgentSettingsDialog = lazy(() => import('./agent-settings-dialog').then(module => ({ default: module.AgentSettingsDialog })));

export function GlobalAiSettingsProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [owner, setOwner] = useState('');
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.querySelector<HTMLElement>('.dashboard-app'));
  }, []);

  useEffect(() => {
    let disposed = false;
    const refreshOwner = () => {
      void studyOwner()
        .then((identity) => { if (!disposed) setOwner(identity); })
        .catch(() => { if (!disposed) setOwner(''); });
    };
    refreshOwner();
    const authChanged = (message: { type?: string }) => {
      if (message.type === 'AUTH_CHANGED' || message.type === 'AUTH_INVALIDATED') refreshOwner();
    };
    browser.runtime.onMessage.addListener(authChanged);
    return () => {
      disposed = true;
      browser.runtime.onMessage.removeListener(authChanged);
    };
  }, []);

  useEffect(() => {
    if (!owner || !isOpen) {
      setMemories([]);
      setDocuments([]);
      return;
    }
    const subscription = liveQuery(async () => ({
      memories: await agentDb.memories.where('owner').equals(owner).toArray(),
      documents: await agentDb.documents.where('owner').equals(owner).toArray(),
    })).subscribe({
      next: (data) => {
        setMemories(data.memories);
        setDocuments(data.documents);
      },
    });
    return () => subscription.unsubscribe();
  }, [owner, isOpen]);

  return (
    <AiSettingsOpenerProvider onOpen={() => setIsOpen(true)}>
      {children}
      {portalTarget && isOpen && createPortal(<Suspense fallback={null}><AgentSettingsDialog
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        owner={owner}
        memories={memories}
        documents={documents}
      /></Suspense>, portalTarget)}
    </AiSettingsOpenerProvider>
  );
}
