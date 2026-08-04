export type Shape = 'circle' | 'square';

export interface DisplayMetrics {
  width: number;
  height: number;
  shape: Shape;
  targetFps: number;
  /** min(width, height); every layout value is expressed as a fraction of this */
  size: number;
  cx: number;
  cy: number;
  radius: number;
  /** Outside this the panel is viewed at a steep angle — nothing legible may live there. */
  safeRadius: number;
  /** Multiplier from the 640-space the stylesheet is authored in. */
  unit: number;
}

const DESIGN_SIZE = 640;
const FALLBACK = { width: 640, height: 640, shape: 'circle' as Shape, targetFps: 60 };
/** 40px of a 640px panel. */
const BEZEL_RATIO = 40 / DESIGN_SIZE;

export function readDisplayMetrics(override?: Partial<typeof FALLBACK>): DisplayMetrics {
  const v1 = window.nzxt?.v1;
  const width = override?.width ?? v1?.width ?? FALLBACK.width;
  const height = override?.height ?? v1?.height ?? FALLBACK.height;
  const shape = override?.shape ?? v1?.shape ?? FALLBACK.shape;
  const targetFps = override?.targetFps ?? v1?.targetFps ?? FALLBACK.targetFps;
  const size = Math.min(width, height);
  const radius = size / 2;

  return {
    width,
    height,
    shape,
    targetFps,
    size,
    cx: width / 2,
    cy: height / 2,
    radius,
    safeRadius: radius - size * BEZEL_RATIO,
    unit: size / DESIGN_SIZE,
  };
}

/**
 * Half-width available to a horizontal line whose baseline sits `y` px from the
 * top, clipped to the safe circle. Text wider than this would run into the
 * steep-angle ring, so every text layer sizes itself against it.
 */
export function safeHalfWidth(m: DisplayMetrics, y: number): number {
  if (m.shape !== 'circle') return m.width / 2;
  const dy = Math.abs(y - m.cy);
  if (dy >= m.safeRadius) return 0;
  return Math.sqrt(m.safeRadius * m.safeRadius - dy * dy);
}

export function applyMetrics(root: HTMLElement, m: DisplayMetrics): void {
  root.style.setProperty('--w', `${m.width}px`);
  root.style.setProperty('--h', `${m.height}px`);
  root.style.setProperty('--u', `${m.unit}`);
  root.dataset.shape = m.shape;
}
