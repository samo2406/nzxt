import type { Telemetry } from '../data/nzxt';
import type { Settings } from '../data/settings';
import '../styles/overlay.css';

const PLACEHOLDER = '--';

const CPU_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
  '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/>' +
  '<path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/></svg>';

const GPU_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
  '<rect x="2.5" y="6" width="19" height="11" rx="2"/><circle cx="14.5" cy="11.5" r="3.4"/>' +
  '<path d="M6.5 17v3.5M11 17v3.5"/></svg>';

function formatC(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? PLACEHOLDER : String(Math.round(value));
}

/**
 * Clock and temperatures over the slideshow. Ink is chosen per photo by the
 * slideshow (it knows what is behind the overlay); the whole thing hides on
 * the music screen, which carries no text at all.
 */
export class InfoOverlay {
  readonly el: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly temps: HTMLElement;
  private readonly cpu: HTMLElement;
  private readonly gpu: HTMLElement;
  private settings: Settings;
  private timer: number;
  private shownTime = '';

  constructor(settings: Settings) {
    this.settings = settings;
    this.el = document.createElement('div');
    this.el.className = 'info';
    this.el.dataset.ink = 'light';

    this.clock = document.createElement('div');
    this.clock.className = 'info__clock';

    this.temps = document.createElement('div');
    this.temps.className = 'info__temps';

    this.cpu = this.createCell(CPU_ICON);
    this.gpu = this.createCell(GPU_ICON);

    this.el.append(this.clock, this.temps);
    this.setEnabled(settings.telemetry.enabled);

    this.tick();
    this.timer = window.setInterval(() => this.tick(), 10_000);
  }

  private createCell(icon: string): HTMLElement {
    const cell = document.createElement('span');
    cell.className = 'info__cell';

    const glyph = document.createElement('span');
    glyph.className = 'info__icon';
    glyph.innerHTML = icon;

    const value = document.createElement('span');
    value.className = 'info__value';
    value.textContent = PLACEHOLDER;

    cell.append(glyph, value);
    this.temps.append(cell);
    return value;
  }

  private tick(): void {
    const now = new Date();
    const text = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (text === this.shownTime) return;
    this.shownTime = text;
    this.clock.textContent = text;
  }

  update(t: Telemetry): void {
    this.cpu.textContent = formatC(t.cpuTempC);
    this.gpu.textContent = formatC(t.gpuTempC);
    this.flag(this.cpu, t.cpuTempC, this.settings.telemetry.cpuWarnC);
    this.flag(this.gpu, t.gpuTempC, this.settings.telemetry.gpuWarnC);
  }

  private flag(el: HTMLElement, value: number | undefined, threshold: number): void {
    const warn = value !== undefined && Number.isFinite(value) && value >= threshold;
    el.dataset.warn = warn ? 'true' : 'false';
  }

  /** Called by the slideshow with the tone that stays readable on the photo. */
  setInk(ink: 'light' | 'dark'): void {
    this.el.dataset.ink = ink;
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.setEnabled(settings.telemetry.enabled);
  }

  private setEnabled(enabled: boolean): void {
    this.temps.dataset.on = enabled ? 'true' : 'false';
  }

  destroy(): void {
    clearInterval(this.timer);
    this.el.remove();
  }
}
