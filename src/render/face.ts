import type { AssistantMessage, FaceState } from '../data/assistant';
import type { Settings } from '../data/settings';
import type { ScreenView } from './screen';
import '../styles/face.css';

const FRAME_MS = 20;
const MOUTH_REST = 0.14;

const BADGES: Partial<Record<string, string>> = {
  offline: 'Bez internetu',
  no_keys: 'Chýbajú kľúče',
  busy: 'Preťažené',
  slow: 'Pomalé spojenie',
  broken: 'Chyba',
};

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

/**
 * Piťu's face. States are pure CSS (transforms and opacity on a handful of
 * elements); the mouth during speech is a WAAPI keyframe track built from the
 * agent's loudness envelope, scheduled against the agent's playback clock, so
 * talking costs no per-frame JavaScript either.
 */
export class FaceView implements ScreenView {
  readonly el: HTMLElement;
  private readonly mouth: HTMLElement;
  private readonly badge: HTMLElement;
  private speechStart: number | null = null;
  private pending: Chunk[] = [];
  private readonly anims = new Set<Animation>();
  private leadMs: number;

  constructor(settings: Settings) {
    this.leadMs = settings.assistant.mouthLeadMs;
    this.el = document.createElement('div');
    this.el.className = 'face';
    this.el.dataset.state = 'sleeping';
    this.el.innerHTML = `
      <div class="face__glow"></div>
      <div class="face__ring"></div>
      <div class="face__orbit"><div class="face__dot"></div></div>
      <div class="face__head">
        <div class="face__eye face__eye--l"><div class="face__eye-inner"></div></div>
        <div class="face__eye face__eye--r"><div class="face__eye-inner"></div></div>
        <div class="face__mouth"><div class="face__mouth-inner"></div></div>
      </div>
      <div class="face__badge"></div>`;
    this.mouth = this.el.querySelector('.face__mouth-inner') as HTMLElement;
    this.badge = this.el.querySelector('.face__badge') as HTMLElement;
  }

  get state(): FaceState {
    return this.el.dataset.state as FaceState;
  }

  handle(msg: AssistantMessage): void {
    if (msg.type === 'state') this.setState(msg);
    else if (msg.type === 'mouth') this.addMouth(msg.offset, decode(msg.env));
  }

  private setState(msg: Extract<AssistantMessage, { type: 'state' }>): void {
    if (msg.state === 'speaking') {
      this.speechStart = msg.at ?? Date.now();
      const queued = this.pending;
      this.pending = [];
      for (const chunk of queued) this.schedule(chunk);
    } else {
      // Envelope chunks of the next reply arrive after this, before 'speaking'.
      this.stopMouth();
      this.speechStart = null;
      this.pending = [];
    }
    this.badge.textContent = msg.reason ? (BADGES[msg.reason] ?? '') : '';
    this.el.dataset.followUp = msg.followUp ? 'true' : 'false';
    this.el.dataset.state = msg.state;
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
    const anim = this.mouth.animate(frames, { duration, delay, easing: 'linear', fill: 'none' });
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

  activate(): void {}

  deactivate(): void {
    this.stopMouth();
    this.pending = [];
    this.speechStart = null;
  }

  destroy(): void {
    this.deactivate();
    this.el.remove();
  }
}
