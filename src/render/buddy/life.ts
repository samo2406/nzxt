import type { LyricState } from '../lyrics';
import type { Hands, Pose } from './pose';

export type Anchor = 'clock' | 'date' | 'weather' | 'cpu' | 'gpu';

export interface Point {
  x: number;
  y: number;
}

/** What Piťu can see of the screen behind him, in 640-space. */
export interface World {
  screen(): 'slideshow' | 'spotify';
  discAngle(): number;
  discSpinning(): boolean;
  anchor(name: Anchor): Point | null;
  /** The line of the song playing now, when synced lyrics are showing. */
  lyric(): LyricState | null;
}

export type WorldEvent =
  | { kind: 'photo' }
  | { kind: 'track' }
  | { kind: 'temp'; which: 'cpu' | 'gpu'; value: number; warn: boolean }
  | { kind: 'minute'; hour: number; minute: number }
  | { kind: 'screen' };

/** A procedural motion the buddy layers on top of the springs. */
export type Motion = 'walk' | 'fan' | 'nod' | 'sway' | 'sing' | 'dance' | null;

export interface Ride {
  /** Ground point's distance from the disc centre. */
  radius: number;
}

export interface Intent {
  pose: Partial<Pose>;
  hands: Hands;
  motion: Motion;
  /** Walking direction, -1 or 1. */
  dir: number;
  ride: Ride | null;
  /** Asleep: the frame rate drops and he breathes slowly. */
  asleep: boolean;
  /** The line he's singing, for his mouth. */
  lyric: LyricState | null;
}

type Kind =
  | 'stand' | 'sit' | 'sleep' | 'walk' | 'look' | 'point' | 'wrist' | 'fan'
  | 'ride' | 'label' | 'dizzy' | 'nod' | 'ooh' | 'sing' | 'dance' | 'chill';

/** Following the lyrics: these last until a line change picks the next one. */
const SONG: Kind[] = ['sing', 'dance', 'chill'];
/** Busy with something else: a line change waits until it's done. */
const BUSY: Kind[] = ['walk', 'fan', 'wrist', 'ooh', 'look', 'point'];

interface Activity {
  kind: Kind;
  until: number;
  at?: Point;
  /** Walk destination. */
  to?: number;
  then?: Kind;
}

const DISC = { x: 320, y: 320 };
const RIDE_RADIUS = 205;
const LABEL_RADIUS = 38;
const FLOOR_Y = { slideshow: 494, spotify: 525 };
const FLOOR_X = [140, 500] as const;
const PHOTO: Point = { x: 320, y: 250 };
const WALK_SPEED = 26;
/** At most one reaction to the screen per this long, so he mostly lets things be. */
const REACT_GAP_MS = 20_000;
const TEMP_STEP_C = 3;
/** A song mode holds at least this long, so he doesn't flicker between lines. */
const SONG_HOLD_MS = 7000;

const SIT: Partial<Pose> = {
  sink: 20,
  footLx: 17,
  footLy: -1,
  footRx: -17,
  footRy: -1,
  handLx: 4,
  handLy: 20,
  handRx: -4,
  handRy: 20,
  rotL: 0,
  rotR: 0,
};

const SLEEP: Partial<Pose> = { ...SIT, lidL: 1, lidR: 1, tip: -0.55, lean: 7, zzz: 1, smile: 0.15, mouthOpen: 0.12, mouthO: 1, browY: -0.2 };

const OPEN: Hands = { gloveL: 'open', gloveR: 'open' };

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pick<T>(weighted: [T, number][]): T {
  let r = Math.random() * weighted.reduce((sum, [, w]) => sum + w, 0);
  for (const [item, w] of weighted) {
    r -= w;
    if (r <= 0) return item;
  }
  return weighted[0][0];
}

/**
 * Piťu's idle life: long, quiet stretches of standing, sitting and sleeping,
 * the odd walk, and now and then a reaction to what the screen is doing.
 * Time runs `speed` times faster for the mock harness.
 */
export class Life {
  speed = 1;
  forceNight = false;
  private x = 320;
  private act: Activity = { kind: 'stand', until: 0 };
  private nextReaction = 0;
  private glanceAt = 0;
  private glance: Point = { x: 0, y: 0 };
  private temps: Record<'cpu' | 'gpu', number | null> = { cpu: null, gpu: null };
  private hotBy = { cpu: false, gpu: false };
  private clock = 0;
  private last = 0;
  private lyricIndex = -2;
  private modeSince = 0;
  private lyric: LyricState | null = null;

  constructor(
    private readonly world: World,
    private readonly calm: () => boolean,
  ) {}

  private get hot(): boolean {
    return this.hotBy.cpu || this.hotBy.gpu;
  }

  get groundX(): number {
    return this.x;
  }

  /** Back from a conversation: carry on standing where he left off. */
  resume(): void {
    this.begin({ kind: 'stand', until: this.after(between(8, 20)) });
  }

  private now(): number {
    return this.clock;
  }

  private after(seconds: number): number {
    return this.clock + seconds * 1000;
  }

  private night(): boolean {
    if (this.forceNight) return true;
    const h = new Date().getHours();
    return h >= 23 || h < 7;
  }

  private floor(): number {
    return FLOOR_Y[this.world.screen()];
  }

  private begin(act: Activity): void {
    this.act = act;
  }

  notice(ev: WorldEvent): void {
    if (ev.kind === 'screen') {
      this.begin({ kind: 'stand', until: this.after(between(2, 4)) });
      return;
    }
    if (ev.kind === 'temp') {
      const prev = this.temps[ev.which];
      this.temps[ev.which] = ev.value;
      const wasHot = this.hot;
      this.hotBy[ev.which] = ev.warn;
      if (this.hot && !wasHot) {
        this.react({ kind: 'fan', until: this.after(7) }, true);
        return;
      }
      if (prev !== null && Math.abs(ev.value - prev) >= TEMP_STEP_C) {
        const at = this.world.anchor(ev.which);
        if (at) this.react({ kind: 'look', until: this.after(2.6), at }, false, 0.7);
      } else if (prev !== null) {
        this.temps[ev.which] = prev;
      }
      return;
    }
    if (ev.kind === 'minute') {
      if (ev.minute === 0) this.react({ kind: 'wrist', until: this.after(3.2) }, false, 0.8);
      else {
        const at = this.world.anchor('clock');
        if (at) this.react({ kind: 'look', until: this.after(2.2), at }, false, 0.06);
      }
      return;
    }
    if (ev.kind === 'photo' && this.world.screen() === 'slideshow') {
      const at = { x: PHOTO.x + between(-90, 90), y: PHOTO.y + between(-40, 40) };
      if (Math.random() < 0.25) this.react({ kind: 'point', until: this.after(3.5), at }, false, 0.4);
      else this.react({ kind: 'ooh', until: this.after(3.2), at }, false, 0.4);
      return;
    }
    if (ev.kind === 'track') this.react({ kind: 'ooh', until: this.after(1.8), at: { x: 320, y: 200 } }, false, 0.6);
  }

  /** A reaction only lands if he's free, awake, not riding, and hasn't reacted lately. */
  private react(act: Activity, urgent: boolean, chance = 1): void {
    if (!urgent) {
      if (this.now() < this.nextReaction || Math.random() > chance) return;
      if (['sleep', 'ride', 'label', 'walk'].includes(this.act.kind)) return;
    }
    this.nextReaction = this.now() + REACT_GAP_MS;
    this.begin({ ...act, then: this.act.kind === 'sit' ? 'sit' : 'stand' });
  }

  update(nowMs: number): Intent {
    const dt = this.last ? Math.min(250, nowMs - this.last) : 0;
    this.last = nowMs;
    this.clock += dt * this.speed;

    this.lyric = this.music() ? this.world.lyric() : null;
    if (this.lyric && this.lyric.index !== this.lyricIndex) {
      this.lyricIndex = this.lyric.index;
      this.onLine(this.lyric);
    }
    if (!this.lyric && SONG.includes(this.act.kind)) this.act.until = 0;

    if (this.act.kind === 'walk') this.stepWalk(dt);
    else if (this.now() >= this.act.until) this.next();
    return this.intent();
  }

  private music(): boolean {
    return this.world.screen() === 'spotify' && this.world.discSpinning() && !this.calm();
  }

  /**
   * Each new line may change what he does: the refrain is mostly sung, verses
   * get a mix of singing and chilling, breaks are for dancing. Never singing
   * over silence.
   */
  private onLine(line: LyricState): void {
    if (BUSY.includes(this.act.kind)) return;
    const want = line.gap
      ? pick<Kind>([['dance', 3], ['chill', 1]])
      : line.repeated
        ? pick<Kind>([['sing', 6], ['dance', 2], ['chill', 1]])
        : pick<Kind>([['sing', 3], ['chill', 4], ['dance', 2]]);
    if (want === this.act.kind) return;
    const held = this.now() - this.modeSince >= SONG_HOLD_MS || !SONG.includes(this.act.kind);
    if (!held && !(line.gap && this.act.kind === 'sing')) return;
    this.modeSince = this.now();
    this.begin({ kind: want, until: Infinity });
  }

  private stepWalk(dt: number): void {
    const to = this.act.to ?? this.x;
    const step = (WALK_SPEED * this.speed * dt) / 1000;
    if (Math.abs(to - this.x) <= step) {
      this.x = to;
      this.next();
    } else {
      this.x += Math.sign(to - this.x) * step;
    }
  }

  private next(): void {
    const prev = this.act;
    if (prev.then) {
      this.begin({ kind: prev.then, until: this.after(prev.then === 'sit' ? between(20, 60) : between(8, 20)) });
      return;
    }
    if (this.music()) {
      if (this.lyric) {
        this.lyricIndex = -2;
        this.begin({ kind: 'chill', until: Infinity });
        return;
      }
      this.nextMusic(prev.kind);
      return;
    }
    const night = this.night();
    const walkable = !this.calm();
    const kind = pick<Kind>(
      night
        ? [['sleep', 7], ['sit', 2], ['stand', 1]]
        : [
            ['stand', 3],
            ['sit', 3],
            ['walk', walkable ? 2.5 : 0],
            ['sleep', prev.kind === 'sit' ? 1.5 : 0.3],
          ],
    );
    if (kind === 'walk') {
      let to = between(...FLOOR_X);
      if (Math.abs(to - this.x) < 60) to = this.x < 320 ? to + 120 : to - 120;
      this.begin({ kind: 'walk', until: 0, to: Math.min(FLOOR_X[1], Math.max(FLOOR_X[0], to)), then: Math.random() < 0.5 ? 'sit' : undefined });
      return;
    }
    const seconds = { stand: between(20, 60), sit: between(40, 120), sleep: night ? between(600, 1800) : between(90, 300) }[kind as 'stand' | 'sit' | 'sleep'];
    this.begin({ kind, until: this.after(seconds) });
  }

  private nextMusic(prev: Kind): void {
    if (prev === 'ride' || prev === 'label') {
      this.begin({ kind: prev === 'ride' && Math.random() < 0.5 ? 'dizzy' : 'nod', until: this.after(prev === 'ride' ? 4.5 : between(20, 50)) });
      return;
    }
    if (Math.abs(this.x - 320) > 4) {
      this.begin({ kind: 'walk', until: 0, to: 320 });
      return;
    }
    const kind = pick<Kind>([['ride', 4], ['label', 2], ['nod', 3], ['sit', 1]]);
    const seconds = { ride: between(30, 80), label: between(20, 45), nod: between(20, 60), sit: between(30, 60) }[kind as 'ride' | 'label' | 'nod' | 'sit'];
    this.begin({ kind, until: this.after(seconds) });
  }

  private lookAt(p: Point, scale = 1): Partial<Pose> {
    const y = this.floor();
    const dx = p.x - this.x;
    const dy = p.y - (y - 60 * scale);
    return {
      turn: Math.max(-0.6, Math.min(0.6, dx / 260)),
      lookX: Math.max(-1, Math.min(1, dx / 110)),
      lookY: Math.max(-1, Math.min(1, dy / 110)),
    };
  }

  private idleGlance(): Partial<Pose> {
    if (this.now() >= this.glanceAt) {
      this.glanceAt = this.now() + between(3000, 9000);
      this.glance = Math.random() < 0.45 ? { x: 0, y: 0 } : { x: between(-0.8, 0.8), y: between(-0.6, 0.5) };
    }
    return { lookX: this.glance.x, lookY: this.glance.y, turn: this.glance.x * 0.12 };
  }

  private intent(): Intent {
    const base: Partial<Pose> = { x: this.x, y: this.floor(), scale: 1, sweat: this.hot ? 1 : 0 };
    const act = this.act;
    const out = (pose: Partial<Pose>, extra: Partial<Intent> = {}): Intent => ({
      pose: { ...base, ...pose },
      hands: OPEN,
      motion: null,
      dir: 1,
      ride: null,
      asleep: false,
      lyric: null,
      ...extra,
    });
    switch (act.kind) {
      case 'walk': {
        const dir = Math.sign((act.to ?? this.x) - this.x) || 1;
        return out({ turn: 0.55 * dir, lookX: 0.45 * dir, lookY: 0.1 }, { motion: 'walk', dir });
      }
      case 'sit':
        return out({ ...SIT, ...this.idleGlance() });
      case 'sleep':
        return out(SLEEP, { asleep: true });
      case 'look':
        return out({ ...this.lookAt(act.at ?? PHOTO), browY: 0.3 });
      case 'ooh':
        return out({ ...this.lookAt(act.at ?? PHOTO), browY: 0.8, mouthOpen: 0.3, mouthO: 1, lidL: 0, lidR: 0 });
      case 'point': {
        const at = act.at ?? PHOTO;
        const side = at.x >= this.x ? 1 : -1;
        const arm = side === 1 ? { handLx: 26, handLy: -26, rotL: -130 } : { handRx: -26, handRy: -26, rotR: 130 };
        return out(
          { ...this.lookAt(at), ...arm, browTilt: -0.3, browY: 0.2, smile: 0.1, mouthW: 0.7 },
          { hands: side === 1 ? { gloveL: 'point', gloveR: 'open' } : { gloveL: 'open', gloveR: 'point' } },
        );
      }
      case 'wrist':
        return out(
          { handLx: -22, handLy: -4, rotL: 105, lookX: 0.35, lookY: 0.55, turn: 0.1, browY: 0.3, smile: 0.2 },
          { hands: { gloveL: 'fist', gloveR: 'open' } },
        );
      case 'fan':
        return out(
          { handRx: 4, handRy: -30, rotR: 160, sweat: 1, browTilt: 0.7, smile: -0.4, mouthOpen: 0.2, lidL: 0.3, lidR: 0.3 },
          { motion: 'fan' },
        );
      case 'ride':
        return out({ ...SIT, notes: 0.7, smile: 0.8, joy: 0.2, handLy: 26, handRy: 26 }, { ride: { radius: RIDE_RADIUS } });
      case 'label':
        return out({ ...SIT, notes: 1, joy: 1, smile: 0.8, handLx: 12, handLy: 12, handRx: -12, handRy: 12 }, { ride: { radius: LABEL_RADIUS } });
      case 'dizzy':
        return out({ dizzy: 1, smile: -0.1, mouthW: 0.8, mouthOpen: 0.15 }, { motion: 'sway' });
      case 'nod':
        return out({ notes: 0.8, joy: 1, smile: 0.9 }, { motion: 'nod' });
      case 'sing': {
        const flip = (this.lyric?.index ?? 0) % 2 === 0;
        const reach = { handLx: 24, handLy: -16, rotL: -105, handRx: -20, handRy: 6, rotR: 60 };
        const arms = flip ? reach : { handRx: -24, handRy: -16, rotR: 105, handLx: 20, handLy: 6, rotL: -60 };
        return out({ ...arms, lookY: -0.35, browY: 0.5, smile: 0.4, notes: 0.8, joy: this.lyric?.repeated ? 1 : 0 }, { motion: 'sing', lyric: this.lyric });
      }
      case 'dance':
        return out({ handLx: 16, handLy: -36, rotL: -160, handRx: -16, handRy: -36, rotR: 160, joy: 0.6, smile: 1, notes: 0.5 }, { motion: 'dance' });
      case 'chill':
        return out({ ...SIT, joy: 1, smile: 0.7, notes: 0.5 }, { motion: 'nod' });
      default:
        return out(this.idleGlance());
    }
  }

  get disc(): Point {
    return DISC;
  }
}
