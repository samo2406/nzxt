import { applyMetrics, type DisplayMetrics } from '../core/display';
import type { ScreenName } from '../core/state';
import '../styles/screen.css';

/**
 * A screen is a full-bleed layer inside the circle. Views are told when they
 * go on and off screen so they can stop their timers — this page runs for
 * weeks, so an inactive view must cost nothing.
 */
export interface ScreenView {
  readonly el: HTMLElement;
  activate(): void;
  deactivate(): void;
  destroy(): void;
}

export class Screen {
  readonly root: HTMLElement;
  readonly overlay: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly views = new Map<ScreenName, ScreenView>();
  private boot: HTMLElement | null;
  private active: ScreenName | null = null;

  constructor(host: HTMLElement, readonly metrics: DisplayMetrics) {
    this.root = document.createElement('div');
    this.root.className = 'screen';
    applyMetrics(this.root, metrics);

    this.stage = document.createElement('div');
    this.stage.className = 'screen__stage';

    this.overlay = document.createElement('div');
    this.overlay.className = 'screen__overlay';

    this.boot = document.createElement('div');
    this.boot.className = 'screen__boot';
    this.boot.textContent = '…';

    this.root.append(this.stage, this.overlay, this.boot);
    host.append(this.root);
  }

  register(name: ScreenName, view: ScreenView): void {
    view.el.classList.add('view');
    view.el.dataset.active = 'false';
    this.views.set(name, view);
    this.stage.append(view.el);
  }

  show(name: ScreenName): void {
    if (this.active === name) return;
    const next = this.views.get(name);
    if (!next) return;

    const prev = this.active ? this.views.get(this.active) : undefined;
    this.active = name;

    next.el.dataset.active = 'true';
    next.activate();

    if (prev) {
      prev.el.dataset.active = 'false';
      prev.deactivate();
    }
    this.dismissBoot();
  }

  private dismissBoot(): void {
    const boot = this.boot;
    if (!boot) return;
    this.boot = null;
    boot.style.opacity = '0';
    boot.addEventListener('transitionend', () => boot.remove(), { once: true });
  }

  destroy(): void {
    for (const view of this.views.values()) view.destroy();
    this.views.clear();
    this.root.remove();
  }
}
