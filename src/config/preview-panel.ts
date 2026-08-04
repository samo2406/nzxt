import { readDisplayMetrics } from '../core/display';
import { mountLcd, type LcdHandle } from '../render/lcd';
import { el, section } from './dom';

/** Half-scale preview of the panel, running the same modules as the LCD. */
const PREVIEW_SCALE = 0.5;

export class PreviewPanel {
  readonly el: HTMLElement;
  private handle: LcdHandle | null = null;

  constructor() {
    const metrics = readDisplayMetrics({ width: 640, height: 640, shape: 'circle' });
    const stage = el('div', { class: 'preview__stage' });
    stage.style.width = `${metrics.width * PREVIEW_SCALE}px`;
    stage.style.height = `${metrics.height * PREVIEW_SCALE}px`;

    this.el = section(
      'Náhľad',
      'Rovnaký kód ako na displeji, v polovičnej veľkosti. Prepína sa sám podľa prehrávania. Teploty sú ukážkové — CAM ich posiela len do okna, ktoré streamuje na displej.',
      el('div', { class: 'preview' }, stage),
    );

    void mountLcd(stage, metrics, { sampleTelemetryIfSilent: true }).then((handle) => {
      this.handle = handle;
      handle.screen.root.style.transform = `scale(${PREVIEW_SCALE})`;
      handle.screen.root.style.transformOrigin = '0 0';
    });
  }

  destroy(): void {
    this.handle?.destroy();
    this.handle = null;
  }
}
