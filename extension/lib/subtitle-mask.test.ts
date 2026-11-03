import { describe, expect, it } from 'vitest';
import { clampSubtitleMaskGeometry, moveSubtitleMaskGeometry, resizeSubtitleMaskGeometry } from './subtitle-mask';

describe('subtitle mask geometry', () => {
  it('keeps a moved mask inside the video surface', () => {
    expect(moveSubtitleMaskGeometry({ left: 10, top: 72, width: 80, height: 14 }, 30, 30)).toEqual({ left: 20, top: 86, width: 80, height: 14 });
  });

  it('resizes from every side without crossing the opposite edge', () => {
    expect(resizeSubtitleMaskGeometry({ left: 20, top: 60, width: 60, height: 20 }, 'nw', -10, -20)).toEqual({ left: 10, top: 40, width: 70, height: 40 });
    expect(resizeSubtitleMaskGeometry({ left: 20, top: 60, width: 60, height: 20 }, 'se', 30, 30)).toEqual({ left: 20, top: 60, width: 80, height: 40 });
  });

  it('sanitizes persisted geometry and preserves minimum size', () => {
    expect(clampSubtitleMaskGeometry({ left: -5, top: 99, width: 2, height: 1 })).toEqual({ left: 0, top: 96, width: 8, height: 4 });
  });
});
