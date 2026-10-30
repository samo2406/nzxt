import type { DisplayMetrics } from '../../core/display';
import { prefersReducedMotion } from '../../core/env';
import type { AssistantMessage, Emotion, FaceState } from '../../data/assistant';
import type { Settings } from '../../data/settings';
import { drawBuddy, type Sign } from './draw';
import type { LyricState } from '../lyrics';
import { Life, type Intent, type World, type WorldEvent } from './life';
import { EMOTION_LOOKS, PoseSpring, compose, type Hands, type Look, type Pose } from './pose';

const FRAME_MS = 20;

const EMOTIONS = new Set<Emotion>(Object.keys(EMOTION_LOOKS) as Emotion[]);

/** One-shot expressions fall back to what was showing before (laugh settles into happy). */
const TRANSIENT: Partial<Record<Emotion, { ms: number; then?: Emotion }>> = {
  surprised: { ms: 1600 },
  wink: { ms: 900 },
  laugh: { ms: 1900, then: 'happy' },
};

/** Up close: centred and about 60 % of the screen tall; with a sign, moved aside to make room. */
const CLOSE: Partial<Pose> = { x: 320, y: 494, scale: 2.7 };
const CLOSE_SIGN: Partial<Pose> = { x: 200, y: 540, scale: 2.2 };
const FAREWELL: Partial<Pose> = { x: 320, y: 610, scale: 1.45 };

const OPEN: Hands = { gloveL: 'open', gloveR: 'open' };

const HAND_KEYS: (keyof Pose)[] = ['handLx', 'handLy', 'handRx', 'handRy', 'rotL', 'rotR', 'bendL', 'bendR'];

/** Talking hands, swapped at pauses in the speech. */
const GESTURES: Look[] = [
  { pose: {} },
  { pose: { handLx: 20, handLy: 6, rotL: -50, handRx: -20, handRy: 6, rotR: 50 } },
  { pose: { handLx: 12, handLy: -22, rotL: -165 }, hands: { gloveL: 'point' } },
  { pose: { handRx: -22, handRy: 2, rotR: 75 } },
  { pose: { handLx: 18, handLy: -4, rotL: -95, handRx: -10, handRy: 24 } },
];

const STAGE: Partial<Record<FaceState, Look>> = {
  listening: { pose: { handLx: -4, handLy: -22, rotL: 180, browY: 0.5, lidL: 0, lidR: 0, squash: 1.03, turn: -0.1, smile: 0.5 } },
  thinking: EMOTION_LOOKS.thinking,
  alarm: { pose: { ...EMOTION_LOOKS.excited.pose, sparkle: 0, bang: 1, mouthO: 1 }, hands: EMOTION_LOOKS.excited.hands },
  error: EMOTION_LOOKS.sad,
  offline: EMOTION_LOOKS.sad,
};

type Cue = Extract<AssistantMessage, { type: 'emotion' } | { type: 'card' }>;

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function wrap(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/**
 * Piťu, always on screen: a canvas over every screen, drawn on twos (12 Hz)
 * like a 1930s cartoon, faster only while he talks or moves, slower asleep.
 * Idle, `Life` decides what he does; while the assistant is active he comes
 * up close and follows its states, the speech envelope and the cues.
 */
export class Buddy {
  readonly el: HTMLCanvasElement;
  readonly life: Life;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly spring = new PoseSpring();
  private readonly dpr: number;
  private hands: Hands = OPEN;
  private timer = 0;
  private last = 0;
  private boil = 0;
  private draws = 0;

  private active = false;
  private state: FaceState = 'sleeping';
  private followUp = false;
  private restart = false;
  private countdownUntil = 0;
  private emotion: Emotion = 'neutral';
  private held: Emotion = 'neutral';
  private emotionTimer = 0;
  private sign: Sign | null = null;

  private speechStart: number | null = null;
  private env: number[] = [];
  private pendingCues: Cue[] = [];
  private cueTimers: number[] = [];
  private leadMs: number;
  private level = 0;
  private quiet = 0;
  private gesture = 0;
  private gestureAt = 0;

  private walkPhase = 0;
  private walkW = 0;
  private ride: { offset: number; radius: number } | null = null;
  private rideW = 0;
  private drawn: Pose | null = null;
  private blinkUntil = 0;
  private nextBlink = 0;

  constructor(
    private readonly metrics: DisplayMetrics,
    settings: Settings,
    private readonly world: World,
  ) {
    this.leadMs = settings.assistant.mouthLeadMs;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.el = document.createElement('canvas');
    this.el.className = 'buddy';
    this.el.width = Math.round(metrics.width * this.dpr);
    this.el.height = Math.round(metrics.height * this.dpr);
    this.ctx = this.el.getContext('2d') as CanvasRenderingContext2D;
    this.life = new Life(world, prefersReducedMotion);
    this.life.resume();
    const first = this.life.update(performance.now());
    this.spring.snap(compose(first.pose));
  }

  start(): void {
    if (!this.timer) this.frame();
  }

  notice(ev: WorldEvent): void {
    this.life.notice(ev);
  }

  applySettings(settings: Settings): void {
    this.leadMs = settings.assistant.mouthLeadMs;
  }

  // -------------------------------------------------------------- assistant

  handle(msg: AssistantMessage): void {
    if (msg.type === 'state') this.setState(msg);
    else if (msg.type === 'mouth') this.addMouth(msg.offset, msg.env);
    else if (msg.type === 'emotion' || msg.type === 'card') this.addCue(msg);
  }

  private setState(msg: Extract<AssistantMessage, { type: 'state' }>): void {
    if (msg.state === 'speaking') {
      this.speechStart = msg.at ?? Date.now();
      const cues = this.pendingCues;
      this.pendingCues = [];
      for (const cue of cues) this.scheduleCue(cue);
    } else {
      // Envelope chunks and cues of the next reply arrive after this, before 'speaking'.
      this.speechStart = null;
      this.env = [];
      this.pendingCues = [];
    }
    if (msg.state === 'listening' || msg.state === 'sleeping') {
      this.setEmotion('neutral');
      this.hideSign();
    }
    this.state = msg.state;
    this.followUp = msg.followUp === true;
    this.restart = msg.restart === true;
    if (msg.state === 'countdown') this.countdownUntil = msg.until ?? Date.now() + 10_000;
    const active = msg.state !== 'sleeping';
    if (active !== this.active) {
      this.active = active;
      if (active) this.letGo();
      else this.life.resume();
    }
  }

  private addMouth(offset: number, b64: string): void {
    const raw = atob(b64);
    for (let i = 0; i < raw.length; i++) this.env[offset + i] = raw.charCodeAt(i);
  }

  private addCue(cue: Cue): void {
    if (cue.offset === null) this.applyCue(cue);
    else if (this.speechStart === null) this.pendingCues.push(cue);
    else this.scheduleCue(cue);
  }

  private scheduleCue(cue: Cue): void {
    if (this.speechStart === null || cue.offset === null) return;
    const delay = this.speechStart + cue.offset * FRAME_MS - this.leadMs - Date.now();
    if (delay <= 0) {
      this.applyCue(cue);
      return;
    }
    const timer = window.setTimeout(() => {
      this.cueTimers = this.cueTimers.filter((t) => t !== timer);
      this.applyCue(cue);
    }, delay);
    this.cueTimers.push(timer);
  }

  private applyCue(cue: Cue): void {
    if (cue.type === 'emotion') this.setEmotion(cue.name);
    else this.sign = { icon: cue.icon, value: cue.value, label: cue.label };
  }

  private setEmotion(name: Emotion): void {
    if (!EMOTIONS.has(name)) return;
    clearTimeout(this.emotionTimer);
    this.emotionTimer = 0;
    const transient = TRANSIENT[name];
    if (transient) {
      const back = transient.then ?? this.held;
      this.emotionTimer = window.setTimeout(() => this.setEmotion(back), transient.ms);
    } else {
      this.held = name;
    }
    this.emotion = name;
  }

  private hideSign(): void {
    for (const timer of this.cueTimers) clearTimeout(timer);
    this.cueTimers = [];
    this.sign = null;
  }

  // ---------------------------------------------------------------- targets

  private stageTarget(): { pose: Partial<Pose>; hands: Hands } {
    let look: Look;
    let place = this.sign ? CLOSE_SIGN : CLOSE;
    if (this.state === 'speaking') {
      look = GESTURES[this.gesture];
    } else if (this.state === 'countdown') {
      place = FAREWELL;
      const done = Date.now() >= this.countdownUntil;
      if (done && !this.restart) look = { pose: { lidL: 1, lidR: 1, tip: -0.5, zzz: 1, smile: 0.2, squash: 0.96 } };
      else if (this.restart) look = { pose: { ...EMOTION_LOOKS.wink.pose, lidR: done ? 1 : 0.1 }, hands: EMOTION_LOOKS.wink.hands };
      else look = { pose: { handLx: 16, handLy: -44, rotL: -165, smile: 0.7, browTilt: 0.4 }, hands: { gloveL: 'wave' } };
    } else {
      look = (this.state === 'listening' && this.followUp ? { pose: { browY: 0.4, lidL: 0, lidR: 0, smile: 0.5 } } : STAGE[this.state]) ?? { pose: {} };
    }
    const pose: Partial<Pose> = { ...place, ...look.pose };
    let hands: Hands = { ...OPEN, ...look.hands };
    const feeling = EMOTION_LOOKS[this.emotion];
    Object.assign(pose, feeling.pose);
    if (HAND_KEYS.some((k) => k in feeling.pose)) hands = { ...OPEN, ...feeling.hands };
    if (this.sign) {
      Object.assign(pose, { handLx: 30, handLy: -18, rotL: 180, sign: 1 });
      hands = { ...hands, gloveL: 'fist' };
    }
    return { pose, hands };
  }

  private ambientTarget(intent: Intent): { pose: Partial<Pose>; hands: Hands } {
    if (this.emotion === 'neutral') return intent;
    const feeling = EMOTION_LOOKS[this.emotion];
    return { pose: { ...intent.pose, ...feeling.pose }, hands: { ...intent.hands, ...feeling.hands } };
  }

  // ------------------------------------------------------------------- loop

  private frame = (): void => {
    const now = performance.now();
    const dt = this.last ? Math.min(250, now - this.last) : 16;
    this.last = now;

    const intent = this.active ? null : this.life.update(now);
    const target = intent ? this.ambientTarget(intent) : this.stageTarget();
    this.spring.set(compose(target.pose));
    this.hands = target.hands;
    let moving = false;
    for (let left = dt; left > 0; left -= 16) moving = this.spring.step(Math.min(16, left)) || moving;

    const p: Pose = { ...this.spring.now };
    const t = now / 1000;
    const asleep = (intent?.asleep ?? false) || (this.state === 'countdown' && !this.restart && Date.now() >= this.countdownUntil);
    this.layer(p, now, dt, t, intent, asleep);

    const fast = moving || this.walkW > 0.05 || this.ride !== null || intent?.motion === 'sing' || intent?.motion === 'dance' || this.speechStart !== null || this.state === 'alarm' || this.emotion === 'laugh';
    const fps = fast ? 24 : asleep ? 6 : 12;
    if (fps < 24 || ++this.draws % 2 === 0) this.boil = (this.boil + 1) % 3;
    this.draw(p, t);
    this.drawn = p;
    this.timer = window.setTimeout(this.frame, 1000 / fps);
  };

  /** Procedural motion over the springs: breathing, blinks, walking, riding, talking. */
  private layer(p: Pose, now: number, dt: number, t: number, intent: Intent | null, asleep: boolean): void {
    const calm = prefersReducedMotion();
    const breath = Math.sin((t * Math.PI * 2) / (asleep ? 5.5 : 3.6));
    p.squash *= 1 + breath * (asleep ? 0.03 : 0.012);
    if (asleep) p.tip += breath * 0.08;

    if (!asleep && p.lidL < 0.9 && p.joy < 0.5) {
      if (now >= this.nextBlink) {
        this.blinkUntil = now + 130;
        this.nextBlink = now + (Math.random() < 0.15 ? 260 : between(2200, 6500));
      }
      if (now < this.blinkUntil) {
        p.lidL = 1;
        p.lidR = 1;
      }
    }

    const walking = intent?.motion === 'walk' && !calm;
    this.walkW += ((walking ? 1 : 0) - this.walkW) * Math.min(1, dt / 120);
    if (this.walkW > 0.01) {
      const dir = intent?.dir ?? 1;
      this.walkPhase += (dt / 1000) * Math.PI * 2 * 1.5;
      const s = Math.sin(this.walkPhase);
      const w = this.walkW;
      p.footLx += s * 8 * w;
      p.footRx -= s * 8 * w;
      p.footLy -= Math.max(0, Math.cos(this.walkPhase)) * 6 * w;
      p.footRy -= Math.max(0, -Math.cos(this.walkPhase)) * 6 * w;
      p.sink -= Math.abs(s) * 2.5 * w;
      p.handLy -= s * 4 * w;
      p.handRy += s * 4 * w;
      p.handLx -= s * 5 * w;
      p.handRx -= s * 5 * w;
      p.lean += dir * 4 * w;
      p.tip -= dir * 0.25 * w;
    }

    const motion = intent?.motion ?? null;
    if (motion === 'fan') {
      p.rotR += Math.sin(t * 14) * 28;
      p.handRx += Math.sin(t * 14) * 3;
    } else if (motion === 'nod' && !calm) {
      const beat = Math.sin(t * Math.PI * 2 * 1.05);
      p.lean += beat * 4;
      p.tip += beat * 0.2;
      p.sink += Math.max(0, beat) * 2;
    } else if (motion === 'sway' && !calm) {
      p.lean += Math.sin(t * 2.3) * 7;
      p.tip += Math.sin(t * 2.3 - 0.8) * 0.4;
    } else if (motion === 'sing' && intent?.lyric) {
      this.layerSing(p, intent.lyric, t);
    } else if (motion === 'dance' && !calm) {
      const beat = t * Math.PI * 2;
      p.sink -= Math.abs(Math.sin(beat)) * 6;
      p.lean += Math.sin(beat / 2) * 7;
      p.tip += Math.sin(beat / 2 - 0.6) * 0.35;
      p.turn += Math.sin(beat / 4) * 0.25;
      p.handLy += Math.sin(beat / 2) * 12;
      p.handRy -= Math.sin(beat / 2) * 12;
      p.footLy -= Math.max(0, Math.sin(beat / 2)) * 5;
      p.footRy -= Math.max(0, -Math.sin(beat / 2)) * 5;
    }

    this.layerRide(p, intent, dt);

    if (this.state === 'countdown' && !this.restart && Date.now() < this.countdownUntil) p.rotL += Math.sin(t * 8) * 22;
    if (this.state === 'alarm' && !calm) {
      p.sink -= Math.abs(Math.sin(t * 9)) * 10;
      p.rotL += Math.sin(t * 18) * 20;
      p.rotR -= Math.sin(t * 18) * 20;
    }
    if (this.emotion === 'laugh' && !calm) {
      p.sink += Math.sin(t * 22) * 1.3;
      p.squash += Math.sin(t * 22) * 0.02;
    } else if (this.emotion === 'excited' && !calm) {
      p.sink -= Math.abs(Math.sin(t * 7)) * 5;
    }

    this.layerSpeech(p);
  }

  /**
   * On the record he is carried round with the disc's real angle. He hops on
   * at the bottom and only lets go back there, so he never lands upside down.
   */
  private layerRide(p: Pose, intent: Intent | null, dt: number): void {
    const want = intent?.ride ?? null;
    const angle = this.world.discAngle();
    if (want && !this.ride) this.ride = { offset: 90 - angle, radius: want.radius };
    if (!this.ride) return;
    if (want) this.ride.radius = want.radius;
    const rot = wrap(angle + this.ride.offset - 90);
    const hold = want !== null || (Math.abs(rot) > 12 && this.world.discSpinning());
    this.rideW += ((hold ? 1 : 0) - this.rideW) * Math.min(1, dt / 350);
    if (!hold && this.rideW < 0.01) {
      this.ride = null;
      this.rideW = 0;
      return;
    }
    const r = this.ride.radius;
    const rad = (rot * Math.PI) / 180;
    const disc = this.life.disc;
    const w = this.rideW;
    p.x += (disc.x - r * Math.sin(rad) - p.x) * w;
    p.y += (disc.y + r * Math.cos(rad) - p.y) * w;
    p.rot += (rot - p.rot) * w;
    p.shadow *= 1 - 0.75 * w;
  }

  /**
   * Mouths along to the current line: syllables paced from its length and
   * duration, a held vowel at the end. Not the real words, but it reads.
   */
  private layerSing(p: Pose, line: LyricState, t: number): void {
    const seconds = Math.max(0.5, line.length / 1000);
    const syllables = Math.max(2, line.text.replace(/\s+/g, '').length / 2.8);
    const rate = Math.min(6, Math.max(2.2, syllables / seconds));
    const done = line.elapsed / line.length;
    const open = done < 0.85 ? 0.2 + 0.65 * Math.max(0, Math.sin((line.elapsed / 1000) * rate * Math.PI * 2)) : 0.45;
    p.mouthOpen = Math.max(p.mouthOpen, open);
    p.mouthO = done >= 0.85 ? 1 : p.mouthO;
    p.lean += Math.sin(t * 1.7) * 3;
    p.tip += Math.sin(t * 1.7 - 0.7) * 0.2;
  }

  /** Off the record mid-ride: the springs carry on from where he is drawn. */
  private letGo(): void {
    if (!this.ride || !this.drawn) return;
    const { x, y, rot } = this.drawn;
    Object.assign(this.spring.now, { x, y, rot });
    this.ride = null;
    this.rideW = 0;
  }

  private layerSpeech(p: Pose): void {
    if (this.speechStart === null) {
      this.level = 0;
      return;
    }
    const i = Math.floor((Date.now() - this.speechStart + this.leadMs) / FRAME_MS);
    const level = Math.max(this.env[i] ?? 0, this.env[i - 1] ?? 0) / 255;
    this.level += (level - this.level) * 0.3;
    p.mouthOpen = Math.max(p.mouthOpen, level * 0.95);
    p.sink -= this.level * 4;
    p.lean += Math.sin(i / 38) * 1.5 * (0.35 + this.level);

    this.quiet = level < 0.06 ? this.quiet + 1 : 0;
    const now = performance.now();
    if (this.quiet === 2 && now - this.gestureAt > 1400 && Math.random() < 0.55) {
      this.gestureAt = now;
      this.gesture = (this.gesture + 1 + Math.floor(Math.random() * (GESTURES.length - 1))) % GESTURES.length;
    }
  }

  private draw(p: Pose, t: number): void {
    const { ctx, dpr, metrics } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.el.width, this.el.height);
    const k = dpr * metrics.unit;
    ctx.setTransform(k, 0, 0, k, ((metrics.width - metrics.size) / 2) * dpr, ((metrics.height - metrics.size) / 2) * dpr);
    drawBuddy(ctx, p, this.hands, {
      boil: this.boil,
      boilAmp: prefersReducedMotion() ? 0 : 1,
      time: t,
      sign: this.sign,
    });
  }

  destroy(): void {
    clearTimeout(this.timer);
    clearTimeout(this.emotionTimer);
    this.hideSign();
    this.el.remove();
  }
}
