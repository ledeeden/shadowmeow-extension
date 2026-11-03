import type { UserSettings } from '@shadow-language/contracts';
import { create } from 'zustand';
import { DEFAULT_SETTINGS } from '../../lib/db';

export type DashboardTab = 'today' | 'lamplit' | 'local-corpus' | 'agent' | 'reader' | 'study' | 'assets' | 'corpus' | 'public-corpus' | 'settings';

type DashboardStore = {
  settings: UserSettings;
  activeTab: DashboardTab;
  authReady: boolean;
  signedIn: boolean;
  accountEmail: string | null;
  notice: string | null;
  noticeId: number;
  setSettings: (settings: UserSettings) => void;
  setActiveTab: (tab: DashboardTab) => void;
  setAuthReady: (authReady: boolean) => void;
  setSignedIn: (signedIn: boolean) => void;
  setAccountEmail: (accountEmail: string | null) => void;
  setNotice: (notice: string | null) => void;
};

export const useDashboardStore = create<DashboardStore>((set) => ({
  settings: DEFAULT_SETTINGS,
  activeTab: 'study',
  authReady: false,
  signedIn: false,
  accountEmail: null,
  notice: null,
  noticeId: 0,
  setSettings: (settings) => set({ settings }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setAuthReady: (authReady) => set({ authReady }),
  setSignedIn: (signedIn) => set({ signedIn }),
  setAccountEmail: (accountEmail) => set({ accountEmail }),
  setNotice: (notice) => set((state) => ({ notice, noticeId: state.noticeId + 1 })),
}));
