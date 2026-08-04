import './styles/base.css';
import './styles/fonts.css';

import { readDisplayMetrics } from './core/display';
import { isKrakenWindow, isMock } from './core/env';
import { ScreenState } from './core/state';
import { configureTicker } from './core/ticker';
import { installMonitoring } from './data/nzxt';
import type { PlayerSource } from './data/player';
import { getSettings, onSettingsChange } from './data/settings';
import { Screen } from './render/screen';
import { TelemetryOverlay } from './render/telemetry';

async function bootLcd(): Promise<void> {
  document.body.dataset.role = 'lcd';

  const metrics = readDisplayMetrics();
  configureTicker(metrics.targetFps);

  let settings = getSettings();
  const screen = new Screen(document.body, metrics);

  const telemetry = new TelemetryOverlay(settings);
  screen.overlay.append(telemetry.el);
  // Installed before the mock starts — the mock pushes through this same hook.
  installMonitoring((t) => telemetry.update(t));

  const state = new ScreenState(settings.spotify.fallbackMs);
  state.onChange((name) => screen.show(name));

  onSettingsChange((next) => {
    settings = next;
    telemetry.applySettings(next);
    state.setFallbackMs(next.spotify.fallbackMs);
  });

  if (isMock) {
    const { startMock } = await import('./data/mock');
    wirePlayer(startMock().player, state);
  }
}

function wirePlayer(player: PlayerSource, state: ScreenState): void {
  player.onResult((result) => {
    switch (result.kind) {
      case 'track':
        if (result.now.isPlaying) state.reportPlaying();
        else state.reportIdle();
        break;
      case 'idle':
        state.reportIdle();
        break;
      case 'error':
        // Hold the current screen; a dropped request is not "nothing playing".
        break;
    }
  });
  player.start();
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
