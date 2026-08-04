import './styles/base.css';
import './styles/fonts.css';

import { readDisplayMetrics } from './core/display';
import { isKrakenWindow, isMock } from './core/env';
import { configureTicker } from './core/ticker';
import { mountLcd } from './render/lcd';

async function bootLcd(): Promise<void> {
  document.body.dataset.role = 'lcd';
  const metrics = readDisplayMetrics();
  configureTicker(metrics.targetFps);
  await mountLcd(document.body, metrics, { mock: isMock });
}

async function bootConfig(): Promise<void> {
  document.body.dataset.role = 'config';
  const { mountConfig } = await import('./config/config');
  mountConfig(document.body);
}

if (isKrakenWindow) {
  void bootLcd();
} else {
  void bootConfig();
}
