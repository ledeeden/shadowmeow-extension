import { describe, expect, it, beforeEach } from 'vitest';
import { useDashboardStore } from './store';

describe('useDashboardStore notice state', () => {
  beforeEach(() => {
    useDashboardStore.setState({ notice: null, noticeId: 0 });
  });

  it('updates notice and increments noticeId when a notice is set', () => {
    const store = useDashboardStore.getState();
    expect(store.notice).toBeNull();
    expect(store.noticeId).toBe(0);

    store.setNotice('已载入字幕');
    const state1 = useDashboardStore.getState();
    expect(state1.notice).toBe('已载入字幕');
    expect(state1.noticeId).toBe(1);

    // Setting again (even the same text) increments noticeId to restart timers
    store.setNotice('已载入字幕');
    const state2 = useDashboardStore.getState();
    expect(state2.notice).toBe('已载入字幕');
    expect(state2.noticeId).toBe(2);

    // Clearing notice
    store.setNotice(null);
    const state3 = useDashboardStore.getState();
    expect(state3.notice).toBeNull();
    expect(state3.noticeId).toBe(3);
  });
});
