import { useEffect, useState } from 'react';
import { isExternalDictationKey } from './dictation-keyboard';

/** Infer keyboard use from real input; never persist a claim that it is attached. */
export function useExternalDictationKeyboard(enabled: boolean): boolean {
  const [detected, setDetected] = useState(false);
  useEffect(() => {
    if (!enabled) { setDetected(false); return; }
    const viewport = window.visualViewport;
    const orientation = () => (window as Window & { orientation?: number }).orientation
      ?? screen.orientation?.type ?? `${screen.width <= screen.height}`;
    let currentOrientation = orientation();
    let baselineHeight = Math.max(window.innerHeight, viewport?.height ?? 0);
    const softwareKeyboardVisible = () => baselineHeight - Math.min(window.innerHeight, viewport?.height ?? window.innerHeight) > 120;
    const syncViewport = () => {
      const nextOrientation = orientation();
      if (nextOrientation !== currentOrientation) {
        currentOrientation = nextOrientation;
        baselineHeight = Math.max(window.innerHeight, viewport?.height ?? 0);
      }
      if (softwareKeyboardVisible()) setDetected(false);
      else baselineHeight = Math.max(baselineHeight, window.innerHeight, viewport?.height ?? 0);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isExternalDictationKey(event, softwareKeyboardVisible())) setDetected(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', syncViewport);
    viewport?.addEventListener('resize', syncViewport);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
      viewport?.removeEventListener('resize', syncViewport);
    };
  }, [enabled]);
  return enabled && detected;
}
