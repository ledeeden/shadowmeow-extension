import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SHORTCUTS, PAGE_SHORTCUT_LABELS, assignShortcut, normalizeShortcutKey, shortcutActionForKey, shortcutKeyLabel } from './shortcuts';

describe('configurable page shortcuts', () => {
  it('normalizes Space but leaves native YouTube handling alone', () => {
    expect(normalizeShortcutKey(' ')).toBe('space');
    expect(shortcutActionForKey(DEFAULT_PAGE_SHORTCUTS, 'A')).toBe('previousSegment');
    expect(shortcutActionForKey(DEFAULT_PAGE_SHORTCUTS, ' ')).toBeNull();
    expect(shortcutActionForKey({ ...DEFAULT_PAGE_SHORTCUTS, togglePlayback: 'space' }, ' ')).toBeNull();
  });

  it('swaps duplicate assignments instead of leaving an ambiguous key', () => {
    const next = assignShortcut(DEFAULT_PAGE_SHORTCUTS, 'previousSegment', 'd');
    expect(next.previousSegment).toBe('d');
    expect(next.nextSegment).toBe('a');
    expect(assignShortcut(DEFAULT_PAGE_SHORTCUTS, 'previousSegment', ' ')).toBe(DEFAULT_PAGE_SHORTCUTS);
    expect(assignShortcut(DEFAULT_PAGE_SHORTCUTS, 'togglePlayback', ' ')).toBe(DEFAULT_PAGE_SHORTCUTS);
  });

  it('provides one learner-facing label for every active page shortcut', () => {
    expect(PAGE_SHORTCUT_LABELS.map(({ action }) => action)).toEqual([
      'previousSegment', 'nextSegment', 'replaySegment', 'togglePlayback', 'toggleLoop',
      'toggleTranscript', 'saveCurrent', 'decreaseSpeed', 'increaseSpeed',
    ]);
    expect(shortcutKeyLabel('a')).toBe('A');
    expect(shortcutKeyLabel('space')).toBe('Space');
  });
});
