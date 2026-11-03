import { useEffect, useMemo, useState } from 'react';
import { validCaptionNlp, type CaptionNlpResult, type RuntimeMessage } from '@shadow-language/contracts';
import { runtimeApiCall, unwrapRuntimeResponse } from './runtime-errors';

/** Shared UI cache: the model itself lives only in the extension background. */
const cache = new Map<string, CaptionNlpResult>();
export function useCaptionNlp(texts: string[]): Map<string, CaptionNlpResult> {
  const key = JSON.stringify([...new Set(texts.filter(text => text.length <= 4000))].slice(0, 8));
  const stableTexts = useMemo(() => JSON.parse(key) as string[], [key]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const missing = stableTexts.filter(text => !cache.has(text));
    if (!missing.length) return;
    void runtimeApiCall(() => browser.runtime.sendMessage({ type: 'CAPTION_NLP', texts: missing } satisfies RuntimeMessage))
      .then(response => {
        const results = unwrapRuntimeResponse<CaptionNlpResult[]>(response);
        if (!Array.isArray(results)) return;
        for (const result of results) {
          if (!missing.includes(result.text) || result.status !== 'ready' || !validCaptionNlp(result, result.text)) continue;
          cache.set(result.text, result);
          if (cache.size > 256) cache.delete(cache.keys().next().value!);
        }
        if (!cancelled) setRevision(value => value + 1);
      }).catch(() => { /* Raw subtitle remains available if the background fails. */ });
    return () => { cancelled = true; };
  }, [stableTexts]);
  return useMemo(() => new Map(stableTexts.flatMap(text => {
    const result = cache.get(text);
    return result ? [[text, result] as const] : [];
  })), [stableTexts, revision]);
}
