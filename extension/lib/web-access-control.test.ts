import { describe, expect, it } from 'vitest';
import { webAccessState, webProtectedSurface } from './web-access-control';

describe('web access control', () => {
  it('protects the Web AI tab and player without changing extension access', () => {
    expect(webProtectedSurface(true, false, 'agent')).toBe('ai');
    expect(webProtectedSurface(true, true, 'public-corpus')).toBe('player');
    expect(webProtectedSurface(true, false, 'public-corpus')).toBeNull();
    expect(webProtectedSurface(false, true, 'agent')).toBeNull();
  });

  it('waits for restored authentication before deciding whether login is required', () => {
    expect(webAccessState('player', false, false)).toBe('checking');
    expect(webAccessState('ai', true, false)).toBe('login-required');
    expect(webAccessState('player', true, true)).toBe('allowed');
    expect(webAccessState(null, true, false)).toBe('allowed');
  });
});
