export type CaptionProofToken = { videoId: string; token: string };
export type NativeCaptionTrack = { vss_id?: string; languageCode?: string; language_code?: string; kind?: string };

export function extractCaptionProofToken(value: string): CaptionProofToken | null {
  try {
    const baseUrl = typeof location === 'undefined' ? 'https://www.youtube.com' : location.origin;
    const url = new URL(value, baseUrl);
    if (url.protocol !== 'https:' || !(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) || url.pathname !== '/api/timedtext') return null;
    const videoId = url.searchParams.get('v');
    const token = url.searchParams.get('pot');
    return videoId && token ? { videoId, token } : null;
  } catch {
    return null;
  }
}

export function applyCaptionProofToken(value: string, token: string | null): string {
  if (!token) return value;
  const url = new URL(value);
  url.searchParams.set('c', 'WEB');
  url.searchParams.set('pot', token);
  return url.toString();
}

export function selectNativeCaptionTrack(tracks: NativeCaptionTrack[], captionUrl: string): NativeCaptionTrack | null {
  const url = new URL(captionUrl);
  const vssId = url.searchParams.get('vssId');
  const language = url.searchParams.get('lang');
  const kind = url.searchParams.get('kind');
  return tracks.find((track) => vssId && track.vss_id === vssId)
    || tracks.find((track) => {
      const trackLanguage = track.languageCode || track.language_code;
      return trackLanguage === language && (!kind || track.kind === kind);
    })
    || tracks.find((track) => (track.languageCode || track.language_code) === language)
    || null;
}
