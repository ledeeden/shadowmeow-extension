import { useEffect, useRef } from 'react';
import { videoKeyOf, type PageState, randomId } from '@shadow-language/contracts';
import { track } from './analytics';
export function useLearningAnalytics(page: PageState, enabled: boolean) {
  // Per-second tick used to fire open/caption/learning_start. The 10-second
  // learning_tick heartbeat has been retired to cut sl_analytics_events writes
  // (≈80% of the database volume on idle days) without losing any product-visible
  // signal. The timer stays in place so the remaining events still fire reliably.
  const current = useRef({ page, enabled }); current.current = { page, enabled };
  useEffect(() => {
    let activePlatform = 'youtube'; let key = ''; let sessionId = randomId(); let started = false; let captionOutcome = ''; let loadAt = Date.now();
    const timer = window.setInterval(() => {
      const { page: p, enabled: on } = current.current;
      const now = Date.now();
      const nextKey = videoKeyOf(p);
      if (key !== nextKey) { activePlatform = p.platform || 'youtube'; key = nextKey; sessionId = randomId(); started = false; captionOutcome = ''; loadAt = now; if (key) track({ name: 'open', platform: p.platform || 'youtube' }); }
      if (!key || !on || p.activeTrackId?.startsWith('preview:')) return;
      const outcome = p.segments.length ? 'success' : p.error ? 'failure' : '';
      if (outcome && outcome !== captionOutcome) { captionOutcome = outcome; track({ name: 'caption', platform: p.platform || 'youtube', outcome, durationMs: now - loadAt }); }
      if (p.playerState !== 'playing' || document.visibilityState !== 'visible' || !p.segments.length) return;
      if (!started) { started = true; track({ name: 'learning_start', platform: p.platform || 'youtube', sessionId }); }
    }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
}
