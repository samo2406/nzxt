import { cardIcon } from '../face-icons';
import type { Glove, Hands, Pose } from './pose';

const INK = '#1b1612';
const BODY = '#9fd8e8';
const SHADE = '#5aa7c4';
const CREAM = '#f6efe0';
const EYE = '#fffaf0';
const SHOE = '#c8352e';
const SHOE_DARK = '#8e2420';
const MOUTH = '#4a1414';
const TONGUE = '#e0605a';
const BLUSH = '#f08a8a';

/** Body frame: origin at the bottom of the drop, where the legs attach. */
const HIP_Y = -26;
const CENTER_Y = -30;
const RADIUS = 31;
const TIP_Y = -98;
const EYE_Y = -46;
const MOUTH_Y = -22;
const SHOULDER = { x: 29, y: -30 };

export interface Sign {
  icon: string;
  value: string;
  label: string;
}

export interface Frame {
  /** 0, 1 or 2: which of the three boil drawings. */
  boil: number;
  /** 0 turns the boil off (reduced motion). */
  boilAmp: number;
  /** Seconds, for the props that drift on their own. */
  time: number;
  sign: Sign | null;
}

type Pt = [number, number];

let seed = 0;
let counter = 0;
let amp = 0;

function jitter(): number {
  let h = (seed * 374761393 + counter++ * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h & 0xffff) / 0xffff - 0.5) * 2 * amp;
}

function j(x: number, y: number): Pt {
  return [x + jitter(), y + jitter()];
}

/**
 * Draws Piťu in `pose`. `ctx` must already map 640-space to the canvas; this
 * applies the pose's own placement, so the caller only clears and calls.
 */
export function drawBuddy(ctx: CanvasRenderingContext2D, p: Pose, hands: Hands, f: Frame): void {
  seed = f.boil + 1;
  counter = 0;
  amp = (f.boilAmp * 0.75) / Math.sqrt(Math.max(0.3, p.scale));
  const ink = 2.7 * Math.pow(Math.max(0.3, p.scale), -0.35);

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.scale(p.scale, p.scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (p.shadow > 0.01) {
    ctx.fillStyle = `rgba(0,0,0,${(0.32 * p.shadow).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(0, 1, 30 * p.shadow, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.rotate((p.rot * Math.PI) / 180);

  const body = new DOMMatrix()
    .translate(0, HIP_Y + p.sink)
    .rotate(p.lean)
    .scale(1 / Math.sqrt(p.squash), p.squash);
  const toChar = (x: number, y: number): Pt => {
    const q = body.transformPoint({ x, y });
    return [q.x, q.y];
  };

  // Legs and shoes sit behind the drop.
  for (const side of [1, -1] as const) {
    const hip = toChar(10 * side, -3);
    const foot: Pt = side === 1 ? [p.footLx, p.footLy] : [p.footRx, p.footRy];
    limb(ctx, hip, foot, 5 * side, 4.6);
    shoe(ctx, foot, side, ink);
  }

  ctx.save();
  ctx.setTransform(ctx.getTransform().multiply(body));
  drawBody(ctx, p, ink, f);
  ctx.restore();

  for (const side of [1, -1] as const) {
    const shoulder = toChar(SHOULDER.x * side, SHOULDER.y);
    const hx = side === 1 ? p.handLx : p.handRx;
    const hy = side === 1 ? p.handLy : p.handRy;
    const hand: Pt = [shoulder[0] + hx, shoulder[1] + hy];
    const bend = (side === 1 ? p.bendL : p.bendR) * 6;
    limb(ctx, shoulder, hand, bend, 4, side);
    glove(ctx, hand, side === 1 ? p.rotL : p.rotR, side === 1 ? hands.gloveL : hands.gloveR, side, ink);
  }

  if (f.sign && p.sign > 0.02) drawSign(ctx, f.sign, p, toChar, ink);
  props(ctx, p, toChar, ink, f.time);
  ctx.restore();
}

// ------------------------------------------------------------------- body

function dropPath(ctx: CanvasRenderingContext2D, tipBend: number, dx = 0, dy = 0): void {
  const tx = tipBend * 16 + dx;
  const ty = TIP_Y + dy;
  const cy = CENTER_Y + dy;
  ctx.beginPath();
  ctx.moveTo(...j(tx, ty));
  ctx.bezierCurveTo(...j(tx + 7, ty + 20), ...j(RADIUS + dx, cy - 34), ...j(RADIUS + dx, cy));
  ctx.bezierCurveTo(...j(RADIUS + dx, cy + RADIUS * 0.56), ...j(RADIUS * 0.56 + dx, cy + RADIUS), ...j(dx, cy + RADIUS));
  ctx.bezierCurveTo(...j(-RADIUS * 0.56 + dx, cy + RADIUS), ...j(-RADIUS + dx, cy + RADIUS * 0.56), ...j(-RADIUS + dx, cy));
  ctx.bezierCurveTo(...j(-RADIUS + dx, cy - 34), ...j(tx - 7, ty + 20), ...j(tx, ty));
  ctx.closePath();
}

function drawBody(ctx: CanvasRenderingContext2D, p: Pose, ink: number, f: Frame): void {
  const save = counter;
  dropPath(ctx, p.tip);
  ctx.fillStyle = SHADE;
  ctx.fill();

  // Cel shade: the lit drop is the same shape nudged up and left, clipped to the body.
  ctx.save();
  counter = save;
  dropPath(ctx, p.tip);
  ctx.clip();
  dropPath(ctx, p.tip, -6 + p.turn * 4, -5);
  ctx.fillStyle = BODY;
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.moveTo(...j(-23 + p.turn * 3, -38));
  ctx.quadraticCurveTo(...j(-24 + p.turn * 3, -56), ...j(-12 + p.tip * 6, -74));
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(...j(-7 + p.tip * 9, -81), 2, 0, Math.PI * 2);
  ctx.fill();

  counter = save;
  dropPath(ctx, p.tip);
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink;
  ctx.stroke();

  face(ctx, p, ink, f);
}

function face(ctx: CanvasRenderingContext2D, p: Pose, ink: number, f: Frame): void {
  const shift = p.turn * 9;
  if (p.blush > 0.02) {
    ctx.fillStyle = BLUSH;
    ctx.globalAlpha = 0.45 * p.blush;
    for (const s of [1, -1]) {
      ctx.beginPath();
      ctx.ellipse(shift * 1.1 + s * 18, -28, 5.5, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  for (const side of [1, -1] as const) eye(ctx, p, side, shift, ink, f.time);
  mouth(ctx, p, shift * 1.15, ink);
}

function eye(ctx: CanvasRenderingContext2D, p: Pose, side: 1 | -1, shift: number, ink: number, time: number): void {
  const far = Math.max(0, -side * p.turn);
  const rx = 8.5 * (1 - 0.3 * far);
  const ry = 12;
  const cx = side * 9.5 + shift;
  const cy = EYE_Y;
  const lid = side === 1 ? p.lidL : p.lidR;

  brow(ctx, p, side, cx, cy - ry - 4, ink);

  if (p.joy > 0.5) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = ink * 1.1;
    ctx.beginPath();
    ctx.moveTo(...j(cx - rx, cy + 3));
    ctx.quadraticCurveTo(...j(cx, cy - 11), ...j(cx + rx, cy + 3));
    ctx.stroke();
    return;
  }
  if (lid > 0.93) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = ink;
    ctx.beginPath();
    ctx.moveTo(...j(cx - rx, cy + 1));
    ctx.quadraticCurveTo(...j(cx, cy + 6), ...j(cx + rx, cy + 1));
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  ctx.ellipse(...j(cx, cy), rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = EYE;
  ctx.fill();

  ctx.save();
  ctx.clip();
  if (p.dizzy > 0.5) {
    spiral(ctx, cx, cy, rx * 0.8, time * 6 * side, ink);
  } else {
    const px = cx + Math.max(-1, Math.min(1, p.lookX)) * (rx - 4.4) * 0.8;
    const py = cy + 1 + Math.max(-1, Math.min(1, p.lookY)) * (ry - 6) * 0.8;
    pie(ctx, px, py, 4.6 * p.pupil, 7.4 * p.pupil);
  }
  if (lid > 0.02) {
    const edge = cy - ry + lid * 2 * ry;
    const tilt = p.lidTilt * 4;
    ctx.beginPath();
    ctx.moveTo(cx - rx - 2, cy - ry - 2);
    ctx.lineTo(cx + rx + 2, cy - ry - 2);
    ctx.lineTo(...j(cx + rx + 2, edge + tilt * side));
    ctx.lineTo(...j(cx - rx - 2, edge - tilt * side));
    ctx.closePath();
    ctx.fillStyle = BODY;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = ink;
    ctx.beginPath();
    ctx.moveTo(cx - rx - 2, edge - tilt * side);
    ctx.lineTo(cx + rx + 2, edge + tilt * side);
    ctx.stroke();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.ellipse(...j(cx, cy), rx, ry, 0, 0, Math.PI * 2);
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink;
  ctx.stroke();
}

/** The 1930s pie-cut pupil: a black oval with a wedge of light missing. */
function pie(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  const at = -0.95;
  const half = 0.42;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.ellipse(x, y, rx, ry, 0, at + half, at - half + Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = INK;
  ctx.fill();
}

function spiral(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, phase: number, ink: number): void {
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink * 0.7;
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const a = phase + t * Math.PI * 5;
    const rr = t * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 1.3);
  }
  ctx.stroke();
}

function brow(ctx: CanvasRenderingContext2D, p: Pose, side: 1 | -1, cx: number, y: number, ink: number): void {
  const base = y - p.browY * 5;
  const inner: Pt = [cx - side * 6, base - p.browTilt * 4];
  const outer: Pt = [cx + side * 7, base + p.browTilt * 2.5];
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink * 1.25;
  ctx.beginPath();
  ctx.moveTo(...j(...inner));
  ctx.quadraticCurveTo(...j(cx, Math.min(inner[1], outer[1]) - 2.5), ...j(...outer));
  ctx.stroke();
}

function mouth(ctx: CanvasRenderingContext2D, p: Pose, mx: number, ink: number): void {
  const w = 10 * p.mouthW;
  const y = MOUTH_Y;
  const lift = -p.smile * 2.5;
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink;
  if (p.mouthOpen < 0.06) {
    ctx.beginPath();
    ctx.moveTo(...j(mx - w, y + lift));
    ctx.quadraticCurveTo(...j(mx, y + p.smile * 8), ...j(mx + w, y + lift));
    ctx.stroke();
    return;
  }
  const open = p.mouthOpen * 18;
  const round = p.mouthO > 0.5;
  const oy = y + open * 0.35;
  const oh = Math.max(3, open * 0.55);
  const save = counter;
  const outline = (): void => {
    counter = save;
    ctx.beginPath();
    if (round) {
      ctx.ellipse(...j(mx, oy), w * 0.6, oh, 0, 0, Math.PI * 2);
    } else {
      ctx.moveTo(...j(mx - w, y + lift));
      ctx.quadraticCurveTo(...j(mx, y + p.smile * 4), ...j(mx + w, y + lift));
      ctx.quadraticCurveTo(...j(mx, y + lift + open + Math.max(0, p.smile) * 6), ...j(mx - w, y + lift));
    }
    ctx.closePath();
  };
  outline();
  ctx.fillStyle = MOUTH;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = TONGUE;
  ctx.beginPath();
  if (round) ctx.ellipse(mx, oy + oh * 0.75, w * 0.4, oh * 0.5, 0, 0, Math.PI * 2);
  else ctx.ellipse(mx, y + lift + open + 2, w * 0.6, open * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  outline();
  ctx.stroke();
}

// ------------------------------------------------------------------ limbs

/**
 * A rubber-hose limb: one bowed curve, no joints. With `outward` (the arm's
 * side), a positive bow always swings the elbow away from the body, whichever
 * way the arm points.
 */
function limb(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, bow: number, width: number, outward?: number): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  let ux = -dy / len;
  let uy = dx / len;
  if (outward !== undefined && ux * outward + uy * 0.35 < 0) {
    ux = -ux;
    uy = -uy;
  }
  const nx = ux * bow;
  const ny = uy * bow;
  ctx.strokeStyle = INK;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(...j(...a));
  ctx.bezierCurveTo(
    ...j(a[0] + dx * 0.3 + nx, a[1] + dy * 0.3 + ny),
    ...j(a[0] + dx * 0.7 + nx, a[1] + dy * 0.7 + ny),
    ...j(...b),
  );
  ctx.stroke();
}

function shoe(ctx: CanvasRenderingContext2D, foot: Pt, side: 1 | -1, ink: number): void {
  ctx.save();
  ctx.translate(foot[0] + side * 4, foot[1] - 4);
  ctx.rotate(side * 0.12);
  ctx.beginPath();
  ctx.ellipse(...j(0, 0), 11.5, 6.8, 0, 0, Math.PI * 2);
  ctx.fillStyle = SHOE;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = SHOE_DARK;
  ctx.fillRect(-14, 2.5, 28, 6);
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(side * 3, -1.5, 4.5, Math.PI * 1.15, Math.PI * 1.55);
  ctx.stroke();
  ctx.restore();
}

/**
 * White four-finger glove. Local frame: wrist at the origin, fingers along +y
 * at rotation 0, mirrored for the right hand so the thumb points inward.
 * All parts are inked first and filled after, so they merge into one silhouette.
 */
function glove(ctx: CanvasRenderingContext2D, at: Pt, rotDeg: number, shape: Glove, side: 1 | -1, ink: number): void {
  ctx.save();
  ctx.translate(...at);
  ctx.rotate((rotDeg * Math.PI) / 180);
  ctx.scale(-side, 1);
  const line = ink * 0.9;

  const tubes: [Pt, Pt, number][] = [];
  const open = shape === 'open' || shape === 'wave';
  if (open) {
    const spread = shape === 'wave' ? 1.35 : 1;
    for (const [angle, len] of [[-0.5, 8], [-0.17, 9.5], [0.17, 9.2], [0.5, 7.5]] as const) {
      const a = angle * spread;
      tubes.push([j(Math.sin(a) * 3, 10), j(Math.sin(a) * (len + 3), 10 + Math.cos(a) * len), 2.9]);
    }
  } else {
    for (const x of [-3.6, 0, 3.6]) tubes.push([j(x, 13), j(x, 13.5), 2.7]);
    if (shape === 'point') tubes.push([j(1.5, 11), j(2, 23), 2.8]);
  }
  tubes.push(shape === 'thumb' ? [j(-4, 7), j(-6, -5), 2.9] : [j(-5, 6), j(-9.5, 11), 2.8]);
  const palm = j(0, 8);

  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.ellipse(palm[0], palm[1], 7.2 + line, 6.8 + line, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const [a, b, r] of tubes) tube(ctx, a, b, r * 2 + line * 2);
  ctx.fillStyle = CREAM;
  ctx.strokeStyle = CREAM;
  ctx.beginPath();
  ctx.ellipse(palm[0], palm[1], 7.2, 6.8, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const [a, b, r] of tubes) tube(ctx, a, b, r * 2);

  ctx.strokeStyle = INK;
  ctx.lineWidth = line * 0.7;
  ctx.beginPath();
  if (!open) {
    for (const x of [-1.8, 1.8]) {
      ctx.moveTo(x, 11);
      ctx.lineTo(x, 14.5);
    }
  }
  // The three stitch lines on the back of the hand.
  for (const x of [-2.4, 0, 2.4]) {
    ctx.moveTo(x, 3.5);
    ctx.lineTo(x * 1.1, 7);
  }
  ctx.stroke();

  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.moveTo(...j(-5.5, -2));
  ctx.lineTo(...j(5.5, -2));
  ctx.lineTo(...j(7.5, 3));
  ctx.quadraticCurveTo(0, 5, -7.5, 3);
  ctx.closePath();
  ctx.fillStyle = CREAM;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function tube(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, width: number): void {
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(...a);
  ctx.lineTo(...b);
  ctx.stroke();
}

// ------------------------------------------------------------------ props

const iconCache = new Map<string, HTMLImageElement>();

function icon(name: string): HTMLImageElement | null {
  let img = iconCache.get(name);
  if (!img) {
    img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cardIcon(name).replace('currentColor', INK).replace('stroke-width="1.7"', 'stroke-width="2.2"'))}`;
    iconCache.set(name, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** A cardboard placard on a stick, held up in his left hand. */
function drawSign(ctx: CanvasRenderingContext2D, sign: Sign, p: Pose, toChar: (x: number, y: number) => Pt, ink: number): void {
  const shoulder = toChar(SHOULDER.x, SHOULDER.y);
  const hand: Pt = [shoulder[0] + p.handLx, shoulder[1] + p.handLy];
  const w = 96;
  const h = 62;
  const cx = hand[0] + 4;
  const top = hand[1] - 30 - h;
  ctx.save();
  ctx.globalAlpha = Math.min(1, p.sign);
  ctx.translate(cx, hand[1]);
  ctx.rotate(0.05);
  ctx.translate(-cx, -hand[1]);

  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(...j(cx, top + h));
  ctx.lineTo(...j(cx, hand[1] + 6));
  ctx.stroke();
  ctx.strokeStyle = '#a0703c';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(...j(cx - w / 2, top));
  ctx.lineTo(...j(cx + w / 2, top + 2));
  ctx.lineTo(...j(cx + w / 2 - 1, top + h));
  ctx.lineTo(...j(cx - w / 2 + 1, top + h - 1));
  ctx.closePath();
  ctx.fillStyle = CREAM;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink;
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const img = icon(sign.icon);
  const valueSize = fitText(ctx, sign.value, img ? w - 34 : w - 14, 30, 800);
  ctx.font = `800 ${valueSize}px Inter, sans-serif`;
  const vw = ctx.measureText(sign.value).width;
  const iconSize = 22;
  const rowW = vw + (img ? iconSize + 5 : 0);
  const rowX = cx - rowW / 2;
  if (img) ctx.drawImage(img, rowX, top + 22 - iconSize / 2, iconSize, iconSize);
  ctx.textAlign = 'left';
  ctx.fillText(sign.value, rowX + (img ? iconSize + 5 : 0), top + 23);
  ctx.textAlign = 'center';
  const labelSize = fitText(ctx, sign.label, w - 12, 13, 600);
  ctx.font = `600 ${labelSize}px Inter, sans-serif`;
  ctx.fillStyle = '#4b4038';
  ctx.fillText(sign.label, cx, top + h - 15);
  ctx.restore();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, width: number, size: number, weight: number): number {
  ctx.font = `${weight} ${size}px Inter, sans-serif`;
  const measured = ctx.measureText(text).width;
  return measured > width ? Math.max(8, Math.floor((size * width) / measured)) : size;
}

function props(ctx: CanvasRenderingContext2D, p: Pose, toChar: (x: number, y: number) => Pt, ink: number, t: number): void {
  const top = toChar(p.tip * 16, TIP_Y);
  ctx.lineWidth = ink;

  if (p.zzz > 0.02) {
    for (let i = 0; i < 3; i++) {
      const phase = (t / 3.2 + i / 3) % 1;
      const size = 8 + phase * 10;
      ctx.globalAlpha = p.zzz * Math.sin(phase * Math.PI);
      letter(ctx, 'z', top[0] + 10 + phase * 26 + Math.sin(phase * 6) * 3, top[1] + 4 - phase * 34, size, ink);
    }
    ctx.globalAlpha = 1;
  }
  if (p.question > 0.02) {
    ctx.globalAlpha = Math.min(1, p.question);
    letter(ctx, '?', top[0] + 18, top[1] - 4 + Math.sin(t * 3) * 2, 24 * Math.min(1, p.question), ink);
    ctx.globalAlpha = 1;
  }
  if (p.bang > 0.02) {
    ctx.globalAlpha = Math.min(1, p.bang);
    letter(ctx, '!', top[0] + 16, top[1] - 6, 26 * Math.min(1.1, p.bang), ink);
    ctx.globalAlpha = 1;
  }
  if (p.sweat > 0.02) {
    const slide = (t / 2.4) % 1;
    const [sx, sy] = toChar(-24, -64 + slide * 14);
    ctx.globalAlpha = p.sweat * (1 - slide * 0.6);
    ctx.beginPath();
    ctx.moveTo(sx, sy - 7);
    ctx.quadraticCurveTo(sx + 5, sy, sx, sy + 3);
    ctx.quadraticCurveTo(sx - 5, sy, sx, sy - 7);
    ctx.fillStyle = '#d9f3fb';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = ink * 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (p.sparkle > 0.02) {
    const spots: Pt[] = [toChar(-40, -80), toChar(42, -66), toChar(-34, -20)];
    spots.forEach(([x, y], i) => {
      const tw = 0.6 + 0.4 * Math.sin(t * 5 + i * 2.1);
      star(ctx, x, y, 7 * tw * p.sparkle, ink);
    });
  }
  if (p.think > 0.02) {
    ctx.globalAlpha = Math.min(1, p.think);
    for (let i = 0; i < 3; i++) {
      const pulse = 0.75 + 0.25 * Math.max(0, Math.sin(t * 4 - i * 0.9));
      ctx.beginPath();
      ctx.arc(top[0] - 14 - i * 9, top[1] - 2 - i * 9, (2.5 + i * 1.6) * pulse, 0, Math.PI * 2);
      ctx.fillStyle = CREAM;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = ink * 0.7;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (p.notes > 0.02) {
    for (let i = 0; i < 2; i++) {
      const phase = (t / 2.6 + i / 2) % 1;
      ctx.globalAlpha = p.notes * Math.sin(phase * Math.PI);
      note(ctx, top[0] - 22 + i * 40 + Math.sin(phase * 5 + i) * 4, top[1] + 10 - phase * 30, ink);
    }
    ctx.globalAlpha = 1;
  }
  if (p.dizzy > 0.02) {
    for (let i = 0; i < 3; i++) {
      const a = t * 3 + (i * Math.PI * 2) / 3;
      const [x, y] = toChar(Math.cos(a) * 26, -96 + Math.sin(a) * 6);
      ctx.globalAlpha = p.dizzy;
      star(ctx, x, y, 5, ink);
    }
    ctx.globalAlpha = 1;
  }
}

function letter(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number, size: number, ink: number): void {
  ctx.font = `900 ${size}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = ink * 1.2;
  ctx.strokeStyle = INK;
  ctx.strokeText(ch, ...j(x, y));
  ctx.fillStyle = CREAM;
  ctx.fillText(ch, x, y);
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, ink: number): void {
  if (r < 0.5) return;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const rr = i % 2 === 0 ? r : r * 0.32;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = '#ffe28a';
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink * 0.6;
  ctx.stroke();
}

function note(ctx: CanvasRenderingContext2D, x: number, y: number, ink: number): void {
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink * 0.8;
  ctx.beginPath();
  ctx.ellipse(x, y, 4, 3, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + 3.6, y - 1);
  ctx.lineTo(x + 3.6, y - 15);
  ctx.quadraticCurveTo(x + 9, y - 11, x + 9, y - 6);
  ctx.stroke();
}
