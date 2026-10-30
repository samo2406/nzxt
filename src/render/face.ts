import { prefersReducedMotion } from '../core/env';
import type { AssistantMessage, Emotion, FaceState } from '../data/assistant';
import type { Settings } from '../data/settings';
import { cardIcon } from './face-icons';
import type { ScreenView } from './screen';
import '../styles/face.css';

const FRAME_MS = 20;
const MOUTH_REST = 0.14;
const COUNTDOWN_MS = 10_000;
/** Frames averaged for the head bob, so it follows phrases rather than syllables. */
const BOB_SMOOTH = 7;

const BADGES: Partial<Record<string, string>> = {
  offline: 'Bez internetu',
  no_keys: 'Chýbajú kľúče',
  busy: 'Preťažené',
  slow: 'Pomalé spojenie',
  broken: 'Chyba',
};

const EMOTIONS = new Set<Emotion>([
  'neutral', 'happy', 'laugh', 'confused', 'surprised', 'sad', 'annoyed', 'thinking', 'excited', 'wink', 'sleepy',
]);

/** One-shot expressions fall back to what was showing before (laugh settles into happy). */
const TRANSIENT: Partial<Record<Emotion, { ms: number; then?: Emotion }>> = {
  surprised: { ms: 1600 },
  wink: { ms: 750 },
  laugh: { ms: 1900, then: 'happy' },
};

const ACCENTS: Partial<Record<Emotion, string>> = {
  confused: '?',
  surprised: '!',
  sleepy: 'z',
  excited: '✦',
};

/** States where the eyes are open and wander. */
const AWAKE = new Set<FaceState>(['listening', 'thinking', 'speaking', 'alarm', 'error', 'offline']);

type Cue = Extract<AssistantMessage, { type: 'emotion' } | { type: 'card' }>;

interface Chunk {
  offset: number;
  env: Uint8Array;
}

function decode(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Piťu's face. States and expressions are pure CSS (transforms and opacity
 * on a handful of elements); the mouth and the head bob during speech are
 * WAAPI keyframe tracks built from the agent's loudness envelope, scheduled
 * against the agent's playback clock. The only timers are the blink/glance
 * scheduler (a few per second at most) and the cues timed to the speech.
 */
export class FaceView implements ScreenView {
  readonly el: HTMLElement;
  private readonly mouth: HTMLElement;
  private readonly bob: HTMLElement;
  private readonly eyes: HTMLElement[];
  private readonly accent: HTMLElement;
  private readonly card: HTMLElement;
  private readonly badge: HTMLElement;
  private speechStart: number | null = null;
  private pending: Chunk[] = [];
  private pendingCues: Cue[] = [];
  private readonly anims = new Set<Animation>();
  private cueTimers: number[] = [];
  private leadMs: number;
  private readonly count: HTMLElement;
  private readonly countLabel: HTMLElement;
  private readonly progress: SVGCircleElement;
  private countTimer = 0;
  private countAnims: Animation[] = [];
  private emotion: Emotion = 'neutral';
  private held: Emotion = 'neutral';
  private emotionTimer = 0;
  private lifeTimer = 0;

  constructor(settings: Settings) {
    this.leadMs = settings.assistant.mouthLeadMs;
    this.el = document.createElement('div');
    this.el.className = 'face';
    this.el.dataset.state = 'sleeping';
    this.el.dataset.emotion = 'neutral';
    const eye = (side: string): string => `
          <div class="face__eye face__eye--${side}">
            <div class="face__eye-look">
              <div class="face__eye-ball">
                <div class="face__eye-inner"></div>
                <div class="face__lid face__lid--top"></div>
                <div class="face__lid face__lid--bottom"></div>
              </div>
              <div class="face__eye-arc"></div>
            </div>
          </div>`;
    this.el.innerHTML = `
      <div class="face__glow"></div>
      <div class="face__ring"></div>
      <svg class="face__progress" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49.3" pathLength="1"/></svg>
      <div class="face__orbit"><div class="face__dot"></div></div>
      <div class="face__head">
        <div class="face__bob">
          <div class="face__tilt">
            ${eye('l')}${eye('r')}
            <div class="face__mouth">
              <div class="face__mouth-inner"></div>
              <div class="face__mouth-curve"></div>
            </div>
            <div class="face__accent"></div>
          </div>
        </div>
      </div>
      <div class="face__card">
        <div class="face__card-row"><div class="face__card-icon"></div><div class="face__card-value"></div></div>
        <div class="face__card-label"></div>
      </div>
      <div class="face__count"><span></span></div>
      <div class="face__count-label"></div>
      <div class="face__badge"></div>`;
    this.mouth = this.el.querySelector('.face__mouth-inner') as HTMLElement;
    this.bob = this.el.querySelector('.face__bob') as HTMLElement;
    this.eyes = Array.from(this.el.querySelectorAll<HTMLElement>('.face__eye-inner'));
    this.accent = this.el.querySelector('.face__accent') as HTMLElement;
    this.card = this.el.querySelector('.face__card') as HTMLElement;
    this.badge = this.el.querySelector('.face__badge') as HTMLElement;
    this.count = this.el.querySelector('.face__count span') as HTMLElement;
    this.countLabel = this.el.querySelector('.face__count-label') as HTMLElement;
    this.progress = this.el.querySelector('.face__progress circle') as SVGCircleElement;
  }

  get state(): FaceState {
    return this.el.dataset.state as FaceState;
  }

  handle(msg: AssistantMessage): void {
    if (msg.type === 'state') this.setState(msg);
    else if (msg.type === 'mouth') this.addMouth(msg.offset, decode(msg.env));
    else if (msg.type === 'emotion' || msg.type === 'card') this.addCue(msg);
  }

  private setState(msg: Extract<AssistantMessage, { type: 'state' }>): void {
    if (msg.state === 'speaking') {
      this.speechStart = msg.at ?? Date.now();
      const queued = this.pending;
      this.pending = [];
      for (const chunk of queued) this.schedule(chunk);
      const cues = this.pendingCues;
      this.pendingCues = [];
      for (const cue of cues) this.scheduleCue(cue);
    } else {
      // Envelope chunks and cues of the next reply arrive after this, before 'speaking'.
      this.stopMouth();
      this.speechStart = null;
      this.pending = [];
      this.pendingCues = [];
    }
    if (msg.state === 'listening' || msg.state === 'sleeping') {
      this.setEmotion('neutral');
      this.hideCard();
    }
    if (msg.state === 'countdown') this.startCountdown(msg.until ?? Date.now() + COUNTDOWN_MS, msg.restart === true);
    else this.stopCountdown();
    this.badge.textContent = msg.reason ? (BADGES[msg.reason] ?? '') : '';
    this.el.dataset.followUp = msg.followUp ? 'true' : 'false';
    this.el.dataset.state = msg.state;
    if (!AWAKE.has(msg.state)) this.look(0, 0);
  }

  // ------------------------------------------------------------ expressions

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
    else this.showCard(cue.icon, cue.value, cue.label);
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
    if (name === this.emotion) return;
    this.emotion = name;
    this.el.dataset.emotion = name;
    const accent = ACCENTS[name] ?? '';
    if (accent) this.accent.textContent = accent;
    this.accent.dataset.on = accent ? 'true' : 'false';
  }

  private showCard(icon: string, value: string, label: string): void {
    (this.card.querySelector('.face__card-icon') as HTMLElement).innerHTML = cardIcon(icon);
    (this.card.querySelector('.face__card-value') as HTMLElement).textContent = value;
    (this.card.querySelector('.face__card-label') as HTMLElement).textContent = label;
    this.card.dataset.long = value.length > 7 ? 'true' : 'false';
    this.el.dataset.card = 'true';
  }

  private hideCard(): void {
    for (const timer of this.cueTimers) clearTimeout(timer);
    this.cueTimers = [];
    this.el.dataset.card = 'false';
  }

  // ------------------------------------------------------- blinks and looks

  private live(): void {
    clearTimeout(this.lifeTimer);
    this.lifeTimer = window.setTimeout(() => this.live(), between(1400, 4200));
    if (!AWAKE.has(this.state) || this.state === 'thinking') return;
    if (Math.random() < 0.45) {
      this.blink(Math.random() < 0.18);
    } else if (Math.random() < 0.55) {
      this.look(between(-9, 9), between(-6, 4));
    } else {
      this.look(0, 0);
    }
  }

  private blink(twice: boolean): void {
    const frames = twice
      ? [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0.08)' }, { transform: 'scaleY(1)' }, { transform: 'scaleY(0.08)' }, { transform: 'scaleY(1)' }]
      : [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0.08)' }, { transform: 'scaleY(1)' }];
    for (const eye of this.eyes) eye.animate(frames, { duration: twice ? 380 : 170, easing: 'ease-in-out' });
  }

  private look(x: number, y: number): void {
    this.el.style.setProperty('--lx', `${x.toFixed(1)}%`);
    this.el.style.setProperty('--ly', `${y.toFixed(1)}%`);
  }

  private startCountdown(until: number, restart: boolean): void {
    this.stopCountdown();
    this.el.dataset.restart = String(restart);
    this.countLabel.textContent = restart ? 'Reštartujem' : 'Vypínam';
    const left = Math.max(0, until - Date.now());
    this.countAnims.push(
      this.progress.animate([{ strokeDashoffset: 1 - Math.min(1, left / COUNTDOWN_MS) }, { strokeDashoffset: 1 }], {
        duration: left,
        easing: 'linear',
        fill: 'forwards',
      }),
    );
    const tick = (): void => {
      const ms = until - Date.now();
      const secs = Math.ceil(ms / 1000);
      if (secs <= 0) {
        this.el.dataset.count = 'done';
        this.countLabel.textContent = restart ? 'Hneď som späť' : 'Dobrú noc';
        return;
      }
      this.el.dataset.count = secs <= 3 ? 'final' : 'running';
      this.count.textContent = String(Math.min(secs, COUNTDOWN_MS / 1000));
      this.countAnims.push(
        this.count.animate([{ transform: 'scale(1.4)', opacity: 0.2 }, { transform: 'scale(1)', opacity: 1 }], {
          duration: 450,
          easing: 'cubic-bezier(0.3, 1.45, 0.5, 1)',
        }),
      );
      this.countTimer = window.setTimeout(tick, ms - (secs - 1) * 1000);
    };
    tick();
  }

  private stopCountdown(): void {
    clearTimeout(this.countTimer);
    this.countTimer = 0;
    for (const anim of this.countAnims) anim.cancel();
    this.countAnims = [];
    delete this.el.dataset.count;
  }

  private addMouth(offset: number, env: Uint8Array): void {
    const chunk = { offset, env };
    if (this.speechStart === null) this.pending.push(chunk);
    else this.schedule(chunk);
  }

  private schedule({ offset, env }: Chunk): void {
    if (this.speechStart === null || env.length === 0) return;
    const start = this.speechStart + offset * FRAME_MS - this.leadMs;
    const duration = env.length * FRAME_MS;
    const delay = start - Date.now();
    if (delay + duration <= 0) return;
    const frames = Array.from(env, (v) => ({ transform: `scaleY(${MOUTH_REST + ((1 - MOUTH_REST) * v) / 255})` }));
    this.track(this.mouth.animate(frames, { duration, delay, easing: 'linear', fill: 'none' }));
    if (!prefersReducedMotion()) {
      this.track(this.bob.animate(this.bobFrames(env, offset), { duration, delay, easing: 'linear', fill: 'none' }));
    }
  }

  /** The head nods with loudness and sways slowly; the sway follows the frame index, so chunks join up. */
  private bobFrames(env: Uint8Array, offset: number): Keyframe[] {
    const frames: Keyframe[] = [];
    let sum = 0;
    const recent: number[] = [];
    for (let i = 0; i < env.length; i++) {
      recent.push(env[i] / 255);
      sum += env[i] / 255;
      if (recent.length > BOB_SMOOTH) sum -= recent.shift() as number;
      const level = sum / recent.length;
      const sway = Math.sin((offset + i) / 38);
      frames.push({ transform: `translateY(${(-1.6 * level).toFixed(2)}%) rotate(${(1.4 * sway * (0.35 + level)).toFixed(2)}deg)` });
    }
    return frames;
  }

  private track(anim: Animation): void {
    this.anims.add(anim);
    anim.onfinish = () => this.anims.delete(anim);
  }

  private stopMouth(): void {
    for (const anim of this.anims) anim.cancel();
    this.anims.clear();
  }

  applySettings(settings: Settings): void {
    this.leadMs = settings.assistant.mouthLeadMs;
  }

  activate(): void {
    if (!prefersReducedMotion()) this.live();
  }

  deactivate(): void {
    clearTimeout(this.lifeTimer);
    this.lifeTimer = 0;
    clearTimeout(this.emotionTimer);
    this.emotionTimer = 0;
    this.stopMouth();
    this.stopCountdown();
    this.hideCard();
    this.pending = [];
    this.pendingCues = [];
    this.speechStart = null;
  }

  destroy(): void {
    this.deactivate();
    this.el.remove();
  }
}
