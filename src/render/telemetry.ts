import type { Telemetry } from '../data/nzxt';
import type { Settings } from '../data/settings';
import '../styles/telemetry.css';

const PLACEHOLDER = '--';

function formatC(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? PLACEHOLDER : String(Math.round(value));
}

/**
 * Deliberately plain: a monospace readout at the bottom of the circle. Sits in
 * the overlay so it survives a screen change.
 */
export class TelemetryOverlay {
  readonly el: HTMLElement;
  private readonly cpu: HTMLElement;
  private readonly gpu: HTMLElement;
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
    this.el = document.createElement('div');
    this.el.className = 'telemetry';

    this.cpu = this.createCell('CPU');
    this.gpu = this.createCell('GPU');
    this.setEnabled(settings.telemetry.enabled);
  }

  private createCell(label: string): HTMLElement {
    const cell = document.createElement('span');
    cell.className = 'telemetry__cell';

    const name = document.createElement('span');
    name.className = 'telemetry__label';
    name.textContent = label;

    const value = document.createElement('span');
    value.className = 'telemetry__value';
    value.textContent = PLACEHOLDER;

    cell.append(name, value);
    this.el.append(cell);
    return value;
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

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.setEnabled(settings.telemetry.enabled);
  }

  private setEnabled(enabled: boolean): void {
    this.el.dataset.on = enabled ? 'true' : 'false';
  }

  destroy(): void {
    this.el.remove();
  }
}
