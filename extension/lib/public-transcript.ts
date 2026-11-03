import { cuesToLearningSegments, type CaptionCue, type PageState } from '@shadow-language/contracts';
import { validateCues } from './subtitle-validation';
import { callApi } from './cloudbase';
import { saveVideoTranscript } from './video-transcript';

export async function loadYoutubeTranscript(page: PageState, trackId?: string): Promise<PageState> {
  const response = await callApi<{ status: string; cues?: CaptionCue[]; tracks?: PageState['tracks']; trackId?: string }>('corpus.webPlayback', { youtubeId: page.youtubeId, ...(trackId ? { trackId } : {}) });
  if (response.status !== 'available' || !response.cues?.length) return page;
  const cues = validateCues(response.cues);
  const { error: _error, ...rest } = page;
  const next = { ...rest, cues, tracks: response.tracks || [], activeTrackId: response.trackId || null, segments: cuesToLearningSegments(cues, { allowOverlap: true }) };
  await saveVideoTranscript(next); return next;
}

export { validateCues } from './subtitle-validation';
