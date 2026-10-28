import type { DisplayMetrics } from '../core/display';
import { ScreenState } from '../core/state';
import { AssistantLink, type AssistantMessage, type AssistantSource } from '../data/assistant';
import { MockAssistant } from '../data/assistant-mock';
import { installMonitoring, type Telemetry } from '../data/nzxt';
import type { PlayerSource } from '../data/player';
import { getSettings, onSettingsChange, type Settings } from '../data/settings';
import { isConnected, onAuthChange, SpotifyPlayer } from '../data/spotify';
import { WeatherSource } from '../data/weather';
import { FaceView } from './face';
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
    forwardTelemetry(data);
  });
  const sampleTimer = options.sampleTelemetryIfSilent
    ? window.setTimeout(() => {
        if (!sawMonitoring) overlay.update(SAMPLE_TELEMETRY);
      }, SAMPLE_DELAY_MS)
    : 0;

  const weather = new WeatherSource((now) => overlay.setWeather(now));
  weather.sync(settings.weather);

  const slideshow = new SlideshowView(settings);
  const vinyl = new VinylView(metrics, settings);
  screen.register('slideshow', slideshow);
  screen.register('spotify', vinyl);

  const face = new FaceView(settings);
  screen.register('face', face);

  const state = new ScreenState(settings.spotify.fallbackMs);
  const assistant = new AssistantController(screen, state, face, options.mock === true);
  state.onChange((name) => {
    if (!assistant.active) screen.show(name);
  });
  screen.show('slideshow');
  assistant.sync(settings);

  let lastTelemetrySent = 0;
  const forwardTelemetry = (t: Telemetry): void => {
    const now = Date.now();
    if (now - lastTelemetrySent < TELEMETRY_FORWARD_MS) return;
    lastTelemetrySent = now;
    const data: Record<string, number> = {};
    for (const [key, value] of Object.entries(t)) {
      if (typeof value === 'number' && Number.isFinite(value)) data[key] = value;
    }
    assistant.sendTelemetry(data);
  };

  const offSettings = onSettingsChange((next) => {
    overlay.applySettings(next);
    weather.sync(next.weather);
    slideshow.applySettings(next);
    vinyl.applySettings(next);
    face.applySettings(next);
    assistant.sync(next);
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
      assistant.destroy();
      weather.destroy();
      overlay.destroy();
      screen.destroy();
    },
  };
}

const TELEMETRY_FORWARD_MS = 5000;
/** The face closes its eyes before the screen is handed back. */
const HAND_BACK_DELAY_MS = 700;
/** A turn that goes silent this long (agent crashed mid-sentence) gives the screen back. */
const STALE_TURN_MS = 45_000;

/**
 * Lets the voice assistant take the screen over the slideshow/music logic:
 * any non-sleeping state shows the face; 'sleeping' closes the eyes and hands
 * the screen back to whatever ScreenState currently wants.
 */
class AssistantController {
  active = false;
  private source: AssistantSource | null = null;
  private signature = '';
  private handBackTimer = 0;
  private staleTimer = 0;
  private offs: (() => void)[] = [];

  constructor(
    private readonly screen: Screen,
    private readonly state: ScreenState,
    private readonly face: FaceView,
    private readonly mock: boolean,
  ) {}

  sync(settings: Settings): void {
    const { enabled, port } = settings.assistant;
    const signature = enabled ? `${this.mock ? 'mock' : 'ws'}:${port}` : '';
    if (signature === this.signature) return;
    this.signature = signature;
    this.teardown();
    if (!enabled) return;

    const source: AssistantSource = this.mock ? new MockAssistant() : new AssistantLink(port);
    this.offs.push(
      source.onMessage((msg) => this.onMessage(msg)),
      source.onConnection((connected) => {
        if (!connected) this.sleep();
      }),
    );
    this.source = source;
    source.start();
  }

  sendTelemetry(data: Record<string, number>): void {
    this.source?.sendTelemetry(data);
  }

  private onMessage(msg: AssistantMessage): void {
    this.face.handle(msg);
    if (msg.type === 'status') return;
    if (msg.type === 'state') {
      if (msg.state === 'sleeping') this.scheduleHandBack();
      else this.takeOver();
    }
    if (this.active) {
      clearTimeout(this.staleTimer);
      this.staleTimer = window.setTimeout(() => this.sleep(), STALE_TURN_MS);
    }
  }

  private takeOver(): void {
    clearTimeout(this.handBackTimer);
    this.handBackTimer = 0;
    this.active = true;
    this.screen.show('face');
  }

  private scheduleHandBack(): void {
    if (!this.active || this.handBackTimer) return;
    this.handBackTimer = window.setTimeout(() => {
      this.handBackTimer = 0;
      this.active = false;
      clearTimeout(this.staleTimer);
      this.screen.show(this.state.current);
    }, HAND_BACK_DELAY_MS);
  }

  private sleep(): void {
    if (!this.active) return;
    this.face.handle({ type: 'state', state: 'sleeping' });
    this.scheduleHandBack();
  }

  private teardown(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.source?.stop();
    this.source = null;
    this.sleep();
  }

  destroy(): void {
    this.teardown();
    clearTimeout(this.handBackTimer);
    clearTimeout(this.staleTimer);
  }
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
