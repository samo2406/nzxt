import type { Emotion } from '../../data/assistant';

export type Glove = 'open' | 'fist' | 'point' | 'wave' | 'thumb';

/**
 * Everything the drawing needs, as plain numbers so any two poses blend.
 * Character units: the feet stand on y = 0, the drop's tip is near y = -122,
 * one unit is one 640-space pixel at scale 1. Hands are relative to their
 * shoulder, feet to the ground point.
 */
export interface Pose {
  /** Ground point in 640-space. */
  x: number;
  y: number;
  scale: number;
  /** Whole figure, degrees, about the ground point. */
  rot: number;
  /** -1 (his right, our left) … 1: features slide round the drop. */
  turn: number;
  /** Body tilt about its bottom, degrees. */
  lean: number;
  /** < 1 squashes, > 1 stretches, volume kept. */
  squash: number;
  /** The tip trails motion: -1 … 1. */
  tip: number;
  /** Body lowered by this much (sitting). */
  sink: number;
  lookX: number;
  lookY: number;
  lidL: number;
  lidR: number;
  /** Lid angle: > 0 droops the outer corner (sad), < 0 the inner (annoyed). */
  lidTilt: number;
  /** 1 swaps the eyes for closed ^ ^ arcs. */
  joy: number;
  /** Pupil size, 1 normal. */
  pupil: number;
  browY: number;
  /** > 0 worried (inner ends up), < 0 cross (inner ends down). */
  browTilt: number;
  mouthOpen: number;
  smile: number;
  mouthW: number;
  /** 1 rounds the open mouth into an O. */
  mouthO: number;
  handLx: number;
  handLy: number;
  handRx: number;
  handRy: number;
  /** 1 bows the elbow away from the body, -1 toward it. */
  bendL: number;
  bendR: number;
  rotL: number;
  rotR: number;
  footLx: number;
  footLy: number;
  footRx: number;
  footRy: number;
  shadow: number;
  zzz: number;
  question: number;
  bang: number;
  sweat: number;
  sparkle: number;
  think: number;
  notes: number;
  sign: number;
  dizzy: number;
  blush: number;
}

export interface Hands {
  gloveL: Glove;
  gloveR: Glove;
}

export type Key = keyof Pose;

/** His left hand is on our right; hands sit relative to the shoulders at (±27, -54). */
export const BASE: Pose = {
  x: 320,
  y: 488,
  scale: 1,
  rot: 0,
  turn: 0,
  lean: 0,
  squash: 1,
  tip: 0,
  sink: 0,
  lookX: 0,
  lookY: 0,
  lidL: 0.12,
  lidR: 0.12,
  lidTilt: 0,
  joy: 0,
  pupil: 1,
  browY: 0,
  browTilt: 0,
  mouthOpen: 0,
  smile: 0.35,
  mouthW: 1,
  mouthO: 0,
  handLx: 10,
  handLy: 26,
  handRx: -10,
  handRy: 26,
  bendL: 1,
  bendR: 1,
  rotL: 20,
  rotR: -20,
  footLx: 13,
  footLy: 0,
  footRx: -13,
  footRy: 0,
  shadow: 1,
  zzz: 0,
  question: 0,
  bang: 0,
  sweat: 0,
  sparkle: 0,
  think: 0,
  notes: 0,
  sign: 0,
  dizzy: 0,
  blush: 0,
};

export interface Look {
  pose: Partial<Pose>;
  hands?: Partial<Hands>;
}

/** Face and arms per emotion, layered over whatever the body is doing. */
export const EMOTION_LOOKS: Record<Emotion, Look> = {
  neutral: { pose: {} },
  happy: { pose: { smile: 1, joy: 0.2, browY: 0.4, lidL: 0.05, lidR: 0.05, blush: 0.6 } },
  laugh: {
    pose: { joy: 1, smile: 1, mouthOpen: 0.75, mouthW: 1.2, browY: 0.6, blush: 1, handLx: -6, handLy: 30, handRx: 6, handRy: 30, rotL: 70, rotR: -70, squash: 0.95 },
    hands: { gloveL: 'open', gloveR: 'open' },
  },
  confused: {
    pose: { browTilt: 0.5, browY: 0.2, smile: -0.25, mouthW: 0.7, lookX: 0.5, lookY: -0.5, turn: 0.2, lean: -5, handRx: 6, handRy: -38, rotR: -150, question: 1 },
    hands: { gloveR: 'point' },
  },
  surprised: { pose: { pupil: 0.65, lidL: 0, lidR: 0, browY: 1, mouthOpen: 0.6, mouthO: 1, mouthW: 0.7, squash: 1.08, bang: 1, handLx: 22, handLy: -10, handRx: -22, handRy: -10, rotL: -40, rotR: 40 }, hands: { gloveL: 'open', gloveR: 'open' } },
  sad: { pose: { browTilt: 1, browY: -0.1, lidTilt: 1, lidL: 0.35, lidR: 0.35, smile: -0.8, lookY: 0.5, squash: 0.95, tip: -0.2, lean: 3, handLx: 2, handLy: 30, handRx: -2, handRy: 30 } },
  annoyed: {
    pose: { browTilt: -1, browY: -0.3, lidTilt: -1, lidL: 0.45, lidR: 0.45, smile: -0.4, mouthW: 0.8, lookX: -0.4, handLx: -26, handLy: 4, handRx: 26, handRy: 6, rotL: 90, rotR: -90 },
    hands: { gloveL: 'fist', gloveR: 'fist' },
  },
  thinking: {
    pose: { lookX: -0.6, lookY: -0.7, browTilt: 0.3, browY: 0.3, smile: 0, mouthW: 0.6, turn: -0.15, handRx: 22, handRy: 22, rotR: -175, think: 1 },
    hands: { gloveR: 'fist' },
  },
  excited: {
    pose: { joy: 0.3, smile: 1, mouthOpen: 0.5, mouthW: 1.15, browY: 1, squash: 1.06, sparkle: 1, blush: 0.7, handLx: 18, handLy: -44, handRx: -18, handRy: -44, rotL: -160, rotR: 160 },
    hands: { gloveL: 'open', gloveR: 'open' },
  },
  wink: { pose: { lidR: 1, smile: 0.9, browY: 0.3, handLx: 26, handLy: -8, rotL: -60 }, hands: { gloveL: 'thumb' } },
  sleepy: { pose: { lidL: 0.6, lidR: 0.6, browY: -0.3, smile: 0, mouthOpen: 0.25, mouthO: 0.7, squash: 0.96, tip: -0.3, zzz: 0.6 } },
};

/** Per-key spring stiffness; anything not listed uses the default. */
const STIFF: Partial<Record<Key, number>> = {
  x: 9,
  y: 9,
  scale: 7,
  rot: 8,
  lookX: 22,
  lookY: 22,
  lidL: 30,
  lidR: 30,
  mouthOpen: 34,
  pupil: 18,
  footLx: 18,
  footLy: 18,
  footRx: 18,
  footRy: 18,
};
const DEFAULT_STIFF = 12;
/** Under 1 so limbs and the drop overshoot a little, rubber-hose style. */
const DAMPING = 0.72;

/**
 * Springs every key toward its target. Stepped with real elapsed time; a
 * long gap (hidden pane, starved timer) is clamped so nothing explodes.
 */
export class PoseSpring {
  readonly now: Pose = { ...BASE };
  private readonly vel: Record<string, number> = {};
  target: Pose = { ...BASE };

  constructor() {
    for (const key of Object.keys(BASE)) this.vel[key] = 0;
  }

  set(target: Pose): void {
    this.target = target;
  }

  snap(target: Pose): void {
    this.target = target;
    Object.assign(this.now, target);
    for (const key of Object.keys(this.vel)) this.vel[key] = 0;
  }

  step(dtMs: number): boolean {
    const dt = Math.min(dtMs, 50) / 1000;
    let moving = false;
    for (const key of Object.keys(this.target) as Key[]) {
      const k = STIFF[key] ?? DEFAULT_STIFF;
      const x = this.now[key];
      const goal = this.target[key];
      let v = this.vel[key];
      v += (k * k * (goal - x) - 2 * DAMPING * k * v) * dt;
      const next = x + v * dt;
      if (Math.abs(goal - next) < 1e-3 && Math.abs(v) < 1e-2) {
        this.now[key] = goal;
        this.vel[key] = 0;
        continue;
      }
      moving = true;
      this.now[key] = next;
      this.vel[key] = v;
    }
    return moving;
  }
}

export function compose(...layers: Partial<Pose>[]): Pose {
  return Object.assign({ ...BASE }, ...layers);
}
