type LearningPayload = { trackId?: string | null | undefined };

/**
 * Keep local YouTube vssIds intact, but make queued payloads compatible with
 * older API deployments that treated trackId as an internal safeId.
 */
export function normalizeLearningPayloadForCloud<T extends object>(payload: T & LearningPayload): T & LearningPayload {
  const { trackId } = payload;
  if (trackId === undefined || trackId === null || (typeof trackId === 'string' && trackId.length >= 8)) return payload;
  return { ...payload, trackId: null };
}
