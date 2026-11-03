import React, { createContext, useContext } from 'react';

const AiSettingsContext = createContext<(() => void) | null>(null);

export function AiSettingsOpenerProvider({
  onOpen,
  children,
}: {
  onOpen: () => void;
  children: React.ReactNode;
}) {
  return <AiSettingsContext.Provider value={onOpen}>{children}</AiSettingsContext.Provider>;
}

export function useAiSettingsOpener() {
  return useContext(AiSettingsContext);
}
