import type { Telemetry } from '../data/nzxt';
import type { Settings } from '../data/settings';
import type { WeatherNow } from '../data/weather';
import '../styles/overlay.css';

const PLACEHOLDER = '--';

const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

/** Minimal line glyphs keyed by WMO weather code group. */
const WEATHER_ICONS: Record<string, string> = {
  sun: `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19"/></svg>`,
  partly: `<svg ${ICON_ATTRS}><circle cx="9" cy="9" r="3.4"/><path d="M9 3.2v1.6M3.2 9h1.6M4.9 4.9l1.2 1.2M14.8 9.4a4.3 4.3 0 0 1 4 2.9 3.4 3.4 0 0 1-.7 6.7H9.3a3.6 3.6 0 0 1-.6-7.1 4.3 4.3 0 0 1 6.1-2.5z" fill="none"/></svg>`,
  cloud: `<svg ${ICON_ATTRS}><path d="M7.2 18.5a4.2 4.2 0 0 1-.6-8.3 5 5 0 0 1 9.6-1.2 4.6 4.6 0 0 1-.9 9.5z"/></svg>`,
  fog: `<svg ${ICON_ATTRS}><path d="M7 8.5a4.5 4.5 0 0 1 8.8-1.1 4 4 0 0 1 2.5 3.6M4 14h16M6 17.5h12M8 21h8"/></svg>`,
  rain: `<svg ${ICON_ATTRS}><path d="M7.2 14.5a4.2 4.2 0 0 1-.6-8.3 5 5 0 0 1 9.6-1.2 4.6 4.6 0 0 1-.9 9.5z"/><path d="M8.5 17.5 7.5 20M12.5 17.5l-1 2.5M16.5 17.5l-1 2.5"/></svg>`,
  snow: `<svg ${ICON_ATTRS}><path d="M7.2 14.5a4.2 4.2 0 0 1-.6-8.3 5 5 0 0 1 9.6-1.2 4.6 4.6 0 0 1-.9 9.5z"/><path d="M8 18.2v.01M12 20v.01M16 18.2v.01M10 21v.01M14 17v.01"/></svg>`,
  storm: `<svg ${ICON_ATTRS}><path d="M7.2 14.5a4.2 4.2 0 0 1-.6-8.3 5 5 0 0 1 9.6-1.2 4.6 4.6 0 0 1-.9 9.5z"/><path d="m12.5 13.5-2 3.5h3l-2 3.5"/></svg>`,
};

function iconFor(code: number): string {
  if (code === 0) return WEATHER_ICONS.sun;
  if (code <= 2) return WEATHER_ICONS.partly;
  if (code === 3) return WEATHER_ICONS.cloud;
  if (code === 45 || code === 48) return WEATHER_ICONS.fog;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return WEATHER_ICONS.snow;
  if (code >= 95) return WEATHER_ICONS.storm;
  if (code >= 51) return WEATHER_ICONS.rain;
  return WEATHER_ICONS.cloud;
}

function formatC(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? PLACEHOLDER : String(Math.round(value));
}

/**
 * Slideshow overlay: clock, date and outdoor weather stacked at the top,
 * CPU/GPU at the bottom. Text adapts to the photo per pixel via
 * mix-blend-mode: difference in the stylesheet; the whole thing hides on the
 * music screen, which carries no text at all.
 */
export class InfoOverlay {
  readonly el: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly date: HTMLElement;
  private readonly weather: HTMLElement;
  private readonly weatherIcon: HTMLElement;
  private readonly weatherTemp: HTMLElement;
  private readonly temps: HTMLElement;
  private readonly cpu: HTMLElement;
  private readonly gpu: HTMLElement;
  private settings: Settings;
  private timer: number;
  private shownTime = '';
  private iconCode: number | null = null;
  onMinute: ((hour: number, minute: number) => void) | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
    this.el = document.createElement('div');
    this.el.className = 'info';

    this.clock = el('div', 'info__clock');
    this.date = el('div', 'info__date');

    this.weather = el('div', 'info__weather');
    this.weatherIcon = el('span', 'info__weather-icon');
    this.weatherTemp = el('span', 'info__weather-temp');
    this.weather.append(this.weatherIcon, this.weatherTemp);
    this.weather.dataset.on = 'false';

    this.temps = el('div', 'info__temps');
    this.cpu = this.createCell('CPU');
    this.gpu = this.createCell('GPU');

    this.el.append(this.clock, this.date, this.weather, this.temps);
    this.setEnabled(settings.telemetry.enabled);

    this.tick();
    this.timer = window.setInterval(() => this.tick(), 10_000);
  }

  private createCell(label: string): HTMLElement {
    const cell = el('span', 'info__cell');
    const name = el('span', 'info__label');
    name.textContent = label;
    const value = el('span', 'info__value');
    value.textContent = PLACEHOLDER;
    cell.append(name, value);
    this.temps.append(cell);
    return value;
  }

  private tick(): void {
    const now = new Date();
    const text = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (text === this.shownTime) return;
    this.shownTime = text;
    this.clock.textContent = text;
    this.date.textContent = `${now.getDate()}.${now.getMonth() + 1}.`;
    this.onMinute?.(now.getHours(), now.getMinutes());
  }

  /** Where a readout sits, in 640-space, or null while it is hidden. */
  anchor(name: 'clock' | 'date' | 'weather' | 'cpu' | 'gpu'): { x: number; y: number } | null {
    const node = { clock: this.clock, date: this.date, weather: this.weather, cpu: this.cpu, gpu: this.gpu }[name];
    if ((name === 'cpu' || name === 'gpu') && this.temps.dataset.on !== 'true') return null;
    if (name === 'weather' && this.weather.dataset.on !== 'true') return null;
    const box = this.el.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    if (!box.width || !r.width) return null;
    return {
      x: ((r.left + r.width / 2 - box.left) / box.width) * 640,
      y: ((r.top + r.height / 2 - box.top) / box.height) * 640,
    };
  }

  update(t: Telemetry): void {
    this.cpu.textContent = formatC(t.cpuTempC);
    this.gpu.textContent = formatC(t.gpuTempC);
    this.flag(this.cpu, t.cpuTempC, this.settings.telemetry.cpuWarnC);
    this.flag(this.gpu, t.gpuTempC, this.settings.telemetry.gpuWarnC);
  }

  setWeather(now: WeatherNow | null): void {
    this.weather.dataset.on = now ? 'true' : 'false';
    if (!now) return;
    this.weatherTemp.textContent = String(Math.round(now.tempC));
    if (now.code !== this.iconCode) {
      this.iconCode = now.code;
      this.weatherIcon.innerHTML = iconFor(now.code);
    }
  }

  private flag(node: HTMLElement, value: number | undefined, threshold: number): void {
    const warn = value !== undefined && Number.isFinite(value) && value >= threshold;
    node.dataset.warn = warn ? 'true' : 'false';
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

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
