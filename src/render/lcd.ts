import type { DisplayMetrics } from '../core/display';
import { ScreenState } from '../core/state';
import { installMonitoring, type Telemetry } from '../data/nzxt';
import type { PlayerSource } from '../data/player';
import { getSettings, onSettingsChange } from '../data/settings';
import { isConnected, onAuthChange, SpotifyPlayer } from '../data/spotify';
import { WeatherSource } from '../data/weather';
import { InfoOverlay } from './overlay';
import { Screen } from './screen';
import { SlideshowView } from './slideshow';
import { VinylView } from './vinyl';

export interface LcdOptions {
  /** Drive from the ?mock=1 harness instead of Spotify and CAM. */
  mock?: boolean;
  /**
   * Show a plausible reading when no monitoring data arrives. CAM only pushes
   * to the window it streams, so the config preview would otherwise sit at
   * placeholder dashes and the threshold settings could not be judged.
   */
  sampleTelemetryIfSilent?: boolean;
}

export interface LcdHandle {
  screen: Screen;
  destroy(): void;
}

const SAMPLE_TELEMETRY: Telemetry = { cpuTempC: 61, cpuLoad: 0.42, gpuTempC: 54, liquidTempC: 34 };
const SAMPLE_DELAY_MS = 2500;

/**
 * The whole LCD, assembled. Both the streamed window and the config preview
 * mount this, so the preview is the same code at half scale rather than a
 * lookalike.
 */
export async function mountLcd(
  host: HTMLElement,
  metrics: DisplayMetrics,
  options: LcdOptions = {},
): Promise<LcdHandle> {
  const settings = getSettings();
  const screen = new Screen(host, metrics);

  const overlay = new InfoOverlay(settings);
  screen.overlay.append(overlay.el);

  let sawMonitoring = false;
  installMonitoring((data) => {
    sawMonitoring = true;
    overlay.update(data);
  });
  const sampleTimer = options.sampleTelemetryIfSilent
    ? window.setTimeout(() => {
        if (!sawMonitoring) overlay.update(SAMPLE_TELEMETRY);
      }, SAMPLE_DELAY_MS)
    : 0;

  const weather = new WeatherSource((now) => overlay.setWeather(now));
  weather.sync(settings.weather);

  const slideshow = new SlideshowView(settings, (ink) => overlay.setInk(ink));
  const vinyl = new VinylView(metrics, settings);
  screen.register('slideshow', slideshow);
  screen.register('spotify', vinyl);

  const state = new ScreenState(settings.spotify.fallbackMs);
  state.onChange((name) => screen.show(name));
  screen.show('slideshow');

  const offSettings = onSettingsChange((next) => {
    overlay.applySettings(next);
    weather.sync(next.weather);
    slideshow.applySettings(next);
    vinyl.applySettings(next);
    state.setFallbackMs(next.spotify.fallbackMs);
  });

  let player: PlayerSource | null = null;
  let offAuth = (): void => {};
  let offPlayerSettings = (): void => {};

  if (options.mock) {
    const { startMock } = await import('../data/mock');
    player = startMock().player;
    wirePlayer(player, state, vinyl);
  } else {
    // Rebuilt only when the connection or the client ID actually changes.
    let signature = '';
    const syncPlayer = (): void => {
      const next = isConnected() ? getSettings().spotify.clientId : '';
      if (next === signature) return;
      signature = next;

      player?.stop();
      player = null;
      if (!next) {
        state.reset();
        return;
      }
      player = new SpotifyPlayer(next);
      wirePlayer(player, state, vinyl);
    };

    offAuth = onAuthChange(syncPlayer);
    offPlayerSettings = onSettingsChange(syncPlayer);
    syncPlayer();
  }

  return {
    screen,
    destroy(): void {
      clearTimeout(sampleTimer);
      offSettings();
      offAuth();
      offPlayerSettings();
      player?.stop();
      weather.destroy();
      overlay.destroy();
      screen.destroy();
    },
  };
}

function wirePlayer(player: PlayerSource, state: ScreenState, vinyl: VinylView): void {
  player.onResult((result) => {
    vinyl.update(result);
    switch (result.kind) {
      case 'track':
        if (result.now.isPlaying) state.reportPlaying();
        else state.reportIdle();
        break;
      case 'idle':
        state.reportIdle();
        break;
      case 'unauthorized':
        state.reset();
        break;
      case 'error':
        // Hold the current screen; a dropped request is not "nothing playing".
        break;
    }
  });
  player.start();
}
