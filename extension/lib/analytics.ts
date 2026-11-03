import { runtimeApiCall } from './runtime-errors';
import { EXTENSION_VERSION } from './constants';
export type AnalyticsEvent = { name: string; platform?: string; feature?: string; outcome?: string; durationMs?: number; sessionId?: string; operation?: string };
let backgroundSink: ((event: AnalyticsEvent) => void) | undefined;
export function configureAnalyticsSink(sink: (event: AnalyticsEvent) => void): void { backgroundSink = sink; }
// Explicit properties only: never forward page state, message payloads or errors.
export function track(event: AnalyticsEvent): void {
  if (backgroundSink) { backgroundSink(event); return; }
  void runtimeApiCall(() => browser.runtime.sendMessage({ type: 'ANALYTICS_TRACK', event })).catch(() => undefined);
}
export const analyticsVersion = EXTENSION_VERSION;
