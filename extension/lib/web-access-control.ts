export type WebProtectedSurface = 'ai' | 'player' | null;
export type WebAccessState = 'allowed' | 'checking' | 'login-required';

export function webProtectedSurface(web: boolean, hasPlayer: boolean, activeTab: string): WebProtectedSurface {
  if (!web) return null;
  if (hasPlayer) return 'player';
  return activeTab === 'agent' ? 'ai' : null;
}

export function webAccessState(surface: WebProtectedSurface, authReady: boolean, signedIn: boolean): WebAccessState {
  if (!surface || signedIn) return 'allowed';
  return authReady ? 'login-required' : 'checking';
}
