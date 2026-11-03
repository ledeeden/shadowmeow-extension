export type YoutubePlayerResponseLike = { videoDetails?: { videoId?: string } };
export type YoutubeTrackLike = { language: string; kind: 'manual' | 'asr' | 'translation' };

export function youtubeVideoIdFromLocation(pathname: string, searchVideoId: string | null): string | null {
  if (searchVideoId && /^[A-Za-z0-9_-]{11}$/.test(searchVideoId)) return searchVideoId;
  const shortsId = pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1];
  return shortsId || null;
}

export function selectCurrentPlayerResponse<T extends YoutubePlayerResponseLike>(urlVideoId: string | null, candidates: Array<T | null | undefined>): T | null {
  if (urlVideoId) return candidates.find((candidate) => candidate?.videoDetails?.videoId === urlVideoId) || null;
  return candidates.find((candidate) => Boolean(candidate?.videoDetails?.videoId)) || null;
}

export function canonicalYoutubeUrl(origin: string, pathname: string, href: string, videoId: string | null | undefined): string {
  return pathname === '/watch' && videoId ? `${origin}/watch?v=${videoId}` : href;
}

export function isSupportedVideoContext(input: { pathname: string; isLive?: boolean; playabilityStatus?: string; tracks: YoutubeTrackLike[] }): boolean {
  return input.pathname === '/watch'
    && !input.isLive
    && input.playabilityStatus !== 'LOGIN_REQUIRED'
    && input.tracks.some((track) => /^en(?:-|$)/i.test(track.language) && track.kind !== 'translation');
}
