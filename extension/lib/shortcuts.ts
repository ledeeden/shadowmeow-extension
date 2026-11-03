import type { UserSettings } from '@shadow-language/contracts';
import { DEFAULT_SETTINGS } from './db';

export type PageShortcutAction = keyof UserSettings['playbackPreferences']['pageShortcuts'];
export type PageShortcuts = UserSettings['playbackPreferences']['pageShortcuts'];

export const DEFAULT_PAGE_SHORTCUTS: PageShortcuts = DEFAULT_SETTINGS.playbackPreferences.pageShortcuts;

export const PAGE_SHORTCUT_LABELS: Array<{ action: PageShortcutAction; label: string }> = [
  { action: 'previousSegment', label: '上一句' },
  { action: 'nextSegment', label: '下一句' },
  { action: 'replaySegment', label: '重播当前句' },
  { action: 'togglePlayback', label: '播放/暂停' },
  { action: 'toggleLoop', label: '单句循环' },
  { action: 'toggleTranscript', label: '字幕显隐' },
  { action: 'saveCurrent', label: '保存当前句' },
  { action: 'decreaseSpeed', label: '降低速度' },
  { action: 'increaseSpeed', label: '提高速度' },
];

export function shortcutKeyLabel(key: string): string {
  if (typeof key !== 'string') return '';
  return key === 'space' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
}

export function normalizeShortcutKey(key: string): string {
  if (typeof key !== 'string') return '';
  return key === ' ' ? 'space' : key.toLowerCase();
}

export function shortcutActionForKey(shortcuts: PageShortcuts, key: string): PageShortcutAction | null {
  if (typeof key !== 'string') return null;
  const normalized = normalizeShortcutKey(key);
  // Space belongs to YouTube's native player. Handling it here makes one
  // physical key press toggle playback once in the extension and once in
  // YouTube, which cancels itself out.
  if (normalized === 'space') return null;
  return (Object.keys(shortcuts) as PageShortcutAction[]).find((action) => shortcuts[action] === normalized)
    || null;
}

export function assignShortcut(shortcuts: PageShortcuts, action: PageShortcutAction, key: string): PageShortcuts {
  const normalized = normalizeShortcutKey(key);
  if (normalized === 'space') return shortcuts;
  const previous = shortcuts[action];
  const duplicate = (Object.keys(shortcuts) as PageShortcutAction[]).find((candidate) => candidate !== action && shortcuts[candidate] === normalized);
  return { ...shortcuts, ...(duplicate ? { [duplicate]: previous } : {}), [action]: normalized };
}
