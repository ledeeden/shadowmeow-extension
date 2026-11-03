export type SubtitleMaskGeometry = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type SubtitleMaskResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export const DEFAULT_SUBTITLE_MASK_GEOMETRY: SubtitleMaskGeometry = {
  left: 10,
  top: 72,
  width: 80,
  height: 14,
};

export const MIN_SUBTITLE_MASK_WIDTH = 8;
export const MIN_SUBTITLE_MASK_HEIGHT = 4;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function clampSubtitleMaskGeometry(input: Partial<SubtitleMaskGeometry>): SubtitleMaskGeometry {
  const width = clamp(finite(input.width ?? DEFAULT_SUBTITLE_MASK_GEOMETRY.width, DEFAULT_SUBTITLE_MASK_GEOMETRY.width), MIN_SUBTITLE_MASK_WIDTH, 100);
  const height = clamp(finite(input.height ?? DEFAULT_SUBTITLE_MASK_GEOMETRY.height, DEFAULT_SUBTITLE_MASK_GEOMETRY.height), MIN_SUBTITLE_MASK_HEIGHT, 100);
  return {
    left: clamp(finite(input.left ?? DEFAULT_SUBTITLE_MASK_GEOMETRY.left, DEFAULT_SUBTITLE_MASK_GEOMETRY.left), 0, 100 - width),
    top: clamp(finite(input.top ?? DEFAULT_SUBTITLE_MASK_GEOMETRY.top, DEFAULT_SUBTITLE_MASK_GEOMETRY.top), 0, 100 - height),
    width,
    height,
  };
}

export function moveSubtitleMaskGeometry(start: SubtitleMaskGeometry, deltaX: number, deltaY: number): SubtitleMaskGeometry {
  return clampSubtitleMaskGeometry({ ...start, left: start.left + deltaX, top: start.top + deltaY });
}

export function resizeSubtitleMaskGeometry(start: SubtitleMaskGeometry, handle: SubtitleMaskResizeHandle, deltaX: number, deltaY: number): SubtitleMaskGeometry {
  let left = start.left;
  let top = start.top;
  let right = start.left + start.width;
  let bottom = start.top + start.height;

  if (handle.includes('w')) left = clamp(start.left + deltaX, 0, right - MIN_SUBTITLE_MASK_WIDTH);
  if (handle.includes('e')) right = clamp(right + deltaX, left + MIN_SUBTITLE_MASK_WIDTH, 100);
  if (handle.includes('n')) top = clamp(start.top + deltaY, 0, bottom - MIN_SUBTITLE_MASK_HEIGHT);
  if (handle.includes('s')) bottom = clamp(bottom + deltaY, top + MIN_SUBTITLE_MASK_HEIGHT, 100);

  return { left, top, width: right - left, height: bottom - top };
}
