import { safeHalfWidth, type DisplayMetrics } from '../core/display';
import { prefersReducedMotion } from '../core/env';
import { loadImage } from '../core/image';
import { onTick } from '../core/ticker';
import type { NowPlaying, PollResult } from '../data/player';
import type { Settings } from '../data/settings';
import { accentFrom } from './palette';
import type { ScreenView } from './screen';
import '../styles/vinyl.css';

/** Layout is authored in a 640-space field that is centred and scaled by --u. */
const DESIGN = 640;
const DISC_CX = 320;
const DISC_CY = 275;
const ART_R = 174;
const PIVOT_X = 512;
const PIVOT_Y = 128;
const ARM_LEN = 190;
/** Stylus travel: outer edge of the artwork in to the label. */
const TRACK_OUTER = ART_R * 0.95;
const TRACK_INNER = ART_R * 0.36;
const PARK_ANGLE = 84;

const TITLE_Y = 478;
const ARTIST_Y = 512;

const POLL_MS = 3000;
const RAMP_MS = 1600;
const RESEAT_MS = 900;

const PIVOT_TO_CENTRE = Math.hypot(PIVOT_X - DISC_CX, PIVOT_Y - DISC_CY);
const BASE_ANGLE = (Math.atan2(DISC_CY - PIVOT_Y, DISC_CX - PIVOT_X) * 180) / Math.PI;

/** Arm angle that puts the stylus `d` from the disc centre. */
function armAngleFor(d: number): number {
  const cos = (ARM_LEN * ARM_LEN + PIVOT_TO_CENTRE * PIVOT_TO_CENTRE - d * d) / (2 * ARM_LEN * PIVOT_TO_CENTRE);
  const theta = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
  return BASE_ANGLE - theta;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function angleForProgress(fraction: number): number {
  return armAngleFor(TRACK_OUTER + (TRACK_INNER - TRACK_OUTER) * clamp01(fraction));
}

export class VinylView implements ScreenView {
  readonly el: HTMLElement;

  private readonly spin: HTMLElement;
  private readonly art: [HTMLImageElement, HTMLImageElement];
  private readonly glow: HTMLElement;
  private readonly arm: HTMLElement;
  private readonly rimRight: HTMLElement;
  private readonly rimLeft: HTMLElement;
  private readonly title: HTMLElement;
  private readonly artist: HTMLElement;

  private spinAnim: Animation | null = null;
  private stopRamp: (() => void) | null = null;
  private artFront = 0;
  private trackId: string | null = null;
  private artToken = 0;
  private settings: Settings;
  private active = false;
  private desiredRate = 0;

  constructor(private readonly metrics: DisplayMetrics, settings: Settings) {
    this.settings = settings;
    this.el = document.createElement('div');
    this.el.className = 'vinyl';

    this.glow = div('vinyl__glow');

    const field = div('vinyl__field');
    const disc = div('vinyl__disc');
    this.spin = div('vinyl__spin');
    this.art = [image(), image()];
    this.spin.append(this.art[0], this.art[1]);

    disc.append(this.spin, this.grooves(), div('vinyl__label'), div('vinyl__hole'), div('vinyl__sheen'), div('vinyl__edge'));

    this.arm = div('vinyl__arm');
    this.arm.append(div('vinyl__arm-pivot'), div('vinyl__arm-tube'), div('vinyl__arm-head'));

    const rim = div('vinyl__rim');
    this.rimRight = div('vinyl__rim-half vinyl__rim-half--r');
    this.rimLeft = div('vinyl__rim-half vinyl__rim-half--l');
    this.rimRight.append(div('vinyl__rim-fill'));
    this.rimLeft.append(div('vinyl__rim-fill'));
    rim.append(div('vinyl__rim-track'), this.rimRight, this.rimLeft);

    this.title = div('vinyl__title');
    this.artist = div('vinyl__artist');
    const text = div('vinyl__text');
    text.append(this.title, this.artist);

    field.append(disc, this.arm, rim, text);
    this.el.append(this.glow, field);

    this.clampText();
    this.setArmAngle(PARK_ANGLE, 0);
    this.setProgressArc(0, 0);
  }

  /** Each line is clipped to the chord of the safe circle at its own baseline,
   *  so a long title cannot reach the steep-angle ring. */
  private clampText(): void {
    const m = this.metrics;
    for (const [node, y] of [
      [this.title, TITLE_Y],
      [this.artist, ARTIST_Y],
    ] as const) {
      const absolute = m.cy + (y - DESIGN / 2) * m.unit;
      node.style.maxWidth = `${Math.round(safeHalfWidth(m, absolute) * 2 * 0.94)}px`;
    }
  }

  private grooves(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.className = 'vinyl__grooves';
    const size = Math.round(ART_R * 2 * this.metrics.unit);
    canvas.width = canvas.height = size;

    const g = canvas.getContext('2d');
    if (g) {
      const centre = size / 2;
      const outer = centre * 0.985;
      const inner = centre * 0.3;
      g.lineWidth = Math.max(1, this.metrics.unit);
      for (let r = outer; r > inner; r -= 3.1 * this.metrics.unit) {
        // Wider gaps read as the breaks between tracks on a real pressing.
        const band = Math.sin(r / 26) > 0.94;
        g.strokeStyle = band ? 'rgba(0,0,0,0.30)' : 'rgba(0,0,0,0.13)';
        g.beginPath();
        g.arc(centre, centre, r, 0, Math.PI * 2);
        g.stroke();
      }
    }
    return canvas;
  }

  // ------------------------------------------------------------------ update

  update(result: PollResult): void {
    if (result.kind !== 'track') {
      // 'error' is not authoritative, so it must not touch the disc.
      if (result.kind === 'idle' || result.kind === 'unauthorized') this.setRate(0);
      return;
    }
    const now = result.now;
    if (now.id !== this.trackId) this.loadTrack(now);

    const fraction = now.durationMs > 0 ? now.progressMs / now.durationMs : 0;
    const step = now.isPlaying && now.durationMs > 0 ? POLL_MS / now.durationMs : 0;
    // Aim one poll ahead so the linear tween lands as the next result arrives.
    const target = clamp01(fraction + step);
    const tween = now.seeked ? 0 : POLL_MS;

    this.setArmAngle(angleForProgress(target), tween);
    this.setProgressArc(target, tween);
    this.setRate(now.isPlaying ? 1 : 0);
  }

  private loadTrack(now: NowPlaying): void {
    this.trackId = now.id;
    this.title.textContent = now.title;
    this.artist.textContent = now.artist;
    this.el.dataset.episode = now.isEpisode ? 'true' : 'false';

    // Lift and reseat rather than crawling back over a whole poll interval.
    this.setArmAngle(PARK_ANGLE, RESEAT_MS);

    const token = ++this.artToken;
    const back = this.art[1 - this.artFront];
    const front = this.art[this.artFront];

    if (!now.artUrl) {
      front.dataset.front = 'false';
      back.dataset.front = 'false';
      this.setAccent('');
      return;
    }

    // The displayed image carries no crossOrigin so a CORS refusal can never
    // blank the disc; sampling uses its own request and falls back on failure.
    void loadImage(back, now.artUrl)
      .then(() => {
        if (token !== this.artToken) return;
        back.dataset.front = 'true';
        front.dataset.front = 'false';
        this.artFront = 1 - this.artFront;
      })
      .catch(() => {
        /* keep whatever is already on the disc */
      });

    void accentFrom(now.artUrl).then((accent) => {
      if (token === this.artToken) this.setAccent(accent);
    });
  }

  private setAccent(accent: string): void {
    this.el.style.setProperty('--accent', accent || '#6b7a8f');
    this.glow.dataset.on = accent ? 'true' : 'false';
  }

  private setArmAngle(deg: number, durationMs: number): void {
    this.arm.style.transition = durationMs > 0 ? `transform ${durationMs}ms linear` : 'none';
    this.arm.style.transform = `rotate(${deg.toFixed(3)}deg)`;
  }

  /** Two half-rings rotated into view: a pure transform, so the arc never
   *  repaints the way an animated stroke-dashoffset would. */
  private setProgressArc(fraction: number, durationMs: number): void {
    const p = clamp01(fraction);
    // Each half sweeps its own 180deg: hidden at -180, fully in view at 0.
    const right = Math.min(p, 0.5) * 360 - 180;
    const left = Math.max(p - 0.5, 0) * 360 - 180;
    for (const [node, deg] of [
      [this.rimRight, right],
      [this.rimLeft, left],
    ] as const) {
      const fill = node.firstElementChild as HTMLElement;
      fill.style.transition = durationMs > 0 ? `transform ${durationMs}ms linear` : 'none';
      fill.style.transform = `rotate(${deg.toFixed(3)}deg)`;
    }
  }

  // ---------------------------------------------------------------- rotation

  private ensureSpin(): void {
    if (this.spinAnim) return;
    const period = 60_000 / Math.max(1, this.settings.spotify.rotationRpm);
    this.spinAnim = this.spin.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration: period,
      iterations: Infinity,
      easing: 'linear',
    });
    this.spinAnim.playbackRate = 0;
  }

  /**
   * Rotation runs on the compositor, so speed is a playbackRate change rather
   * than a new animation and the disc never jumps phase. The ramp is the only
   * per-frame JavaScript on this screen, and it stops when it lands.
   */
  private setRate(target: number): void {
    this.ensureSpin();
    this.desiredRate = target;
    const anim = this.spinAnim;
    if (!anim || !this.active) return;

    if (prefersReducedMotion()) {
      anim.playbackRate = 0;
      return;
    }
    if (target > 0 && anim.playState !== 'running') anim.play();

    this.stopRamp?.();
    this.stopRamp = null;

    const from = anim.playbackRate;
    if (Math.abs(from - target) < 0.005) {
      anim.playbackRate = target;
      return;
    }

    const started = performance.now();
    this.stopRamp = onTick((_dt, now) => {
      const t = Math.min(1, (now - started) / RAMP_MS);
      const eased = t * t * (3 - 2 * t);
      anim.playbackRate = from + (target - from) * eased;
      if (t < 1) return;
      this.stopRamp?.();
      this.stopRamp = null;
      if (target === 0) anim.pause();
    });
  }

  // --------------------------------------------------------------- lifecycle

  applySettings(settings: Settings): void {
    const rpmChanged = settings.spotify.rotationRpm !== this.settings.spotify.rotationRpm;
    this.settings = settings;
    if (!rpmChanged || !this.spinAnim) return;
    // Preserve phase and speed across a period change.
    const rate = this.spinAnim.playbackRate;
    const time = this.spinAnim.currentTime;
    this.spinAnim.effect?.updateTiming({ duration: 60_000 / Math.max(1, settings.spotify.rotationRpm) });
    this.spinAnim.currentTime = time;
    this.spinAnim.playbackRate = rate;
  }

  activate(): void {
    this.active = true;
    this.setRate(this.desiredRate);
  }

  deactivate(): void {
    this.active = false;
    this.stopRamp?.();
    this.stopRamp = null;
    // Nothing is visible, so stop burning compositor frames on the rotation.
    this.spinAnim?.pause();
  }

  destroy(): void {
    this.deactivate();
    this.spinAnim?.cancel();
    this.spinAnim = null;
    this.el.remove();
  }
}

function div(className: string): HTMLElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function image(): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'vinyl__art';
  img.alt = '';
  img.decoding = 'async';
  img.dataset.front = 'false';
  return img;
}
