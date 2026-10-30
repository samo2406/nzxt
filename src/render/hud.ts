import type { AssistantMessage } from '../data/assistant';
import '../styles/hud.css';

const COUNTDOWN_MS = 10_000;

const BADGES: Partial<Record<string, string>> = {
  offline: 'Bez internetu',
  no_keys: 'Chýbajú kľúče',
  busy: 'Preťažené',
  slow: 'Pomalé spojenie',
  broken: 'Chyba',
};

type StateMessage = Extract<AssistantMessage, { type: 'state' }>;

/**
 * What the assistant shows besides Piťu himself: the scrim that pushes the
 * screen back while he is up close, the shutdown countdown and the status
 * badge. DOM and CSS only; nothing here runs while idle.
 */
export class AssistantHud {
  readonly el: HTMLElement;
  private readonly count: HTMLElement;
  private readonly countLabel: HTMLElement;
  private readonly progress: SVGCircleElement;
  private readonly badge: HTMLElement;
  private countTimer = 0;
  private countAnims: Animation[] = [];

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.dataset.state = 'sleeping';
    this.el.innerHTML = `
      <div class="hud__scrim"></div>
      <svg class="hud__progress" viewBox="0 0 100 100"><circle cx="50" cy="50" r="49.3" pathLength="1"/></svg>
      <div class="hud__count"><span></span></div>
      <div class="hud__count-label"></div>
      <div class="hud__badge"></div>`;
    this.count = this.el.querySelector('.hud__count span') as HTMLElement;
    this.countLabel = this.el.querySelector('.hud__count-label') as HTMLElement;
    this.progress = this.el.querySelector('.hud__progress circle') as SVGCircleElement;
    this.badge = this.el.querySelector('.hud__badge') as HTMLElement;
  }

  setState(msg: StateMessage): void {
    if (msg.state === 'countdown') this.startCountdown(msg.until ?? Date.now() + COUNTDOWN_MS, msg.restart === true);
    else this.stopCountdown();
    this.badge.textContent = msg.reason ? (BADGES[msg.reason] ?? '') : '';
    this.el.dataset.state = msg.state;
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

  get counting(): 'running' | 'final' | 'done' | null {
    return (this.el.dataset.count as 'running' | 'final' | 'done' | undefined) ?? null;
  }

  private stopCountdown(): void {
    clearTimeout(this.countTimer);
    this.countTimer = 0;
    for (const anim of this.countAnims) anim.cancel();
    this.countAnims = [];
    delete this.el.dataset.count;
  }

  destroy(): void {
    this.stopCountdown();
    this.el.remove();
  }
}
