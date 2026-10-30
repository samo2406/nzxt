import type { DisplayMetrics } from '../core/display';
import { ScreenState } from '../core/state';
import { AssistantLink, type AssistantMessage, type AssistantSource } from '../data/assistant';
import { MockAssistant } from '../data/assistant-mock';
import { installMonitoring, type Telemetry } from '../data/nzxt';
import type { PlayerSource } from '../data/player';
import { getSettings, onSettingsChange, type Settings } from '../data/settings';
import { isConnected, onAuthChange, SpotifyPlayer } from '../data/spotify';
import { WeatherSource } from '../data/weather';
import { Buddy } from './buddy/buddy';
import { AssistantHud } from './hud';
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
  const showTelemetry = (data: Telemetry): void => {
    overlay.update(data);
    noticeTemps(data);
  };
  installMonitoring((data) => {
    sawMonitoring = true;
    showTelemetry(data);
    forwardTelemetry(data);
  });
  const sampleTimer = options.sampleTelemetryIfSilent
    ? window.setTimeout(() => {
        if (!sawMonitoring) showTelemetry(SAMPLE_TELEMETRY);
      }, SAMPLE_DELAY_MS)
    : 0;

  const weather = new WeatherSource((now) => overlay.setWeather(now));
  weather.sync(settings.weather);

  const slideshow = new SlideshowView(settings);
  const vinyl = new VinylView(metrics, settings);
  screen.register('slideshow', slideshow);
  screen.register('spotify', vinyl);

  const buddy = new Buddy(metrics, settings, {
    screen: () => screen.current ?? 'slideshow',
    discAngle: () => vinyl.angle(),
    discSpinning: () => vinyl.spinning,
    anchor: (name) => overlay.anchor(name),
  });
  screen.buddy.append(buddy.el);
  const hud = new AssistantHud();
  screen.overlay.append(hud.el);
  slideshow.onAdvance = () => buddy.notice({ kind: 'photo' });
  overlay.onMinute = (hour, minute) => buddy.notice({ kind: 'minute', hour, minute });
  const noticeTemps = (t: Telemetry): void => {
    const s = getSettings().telemetry;
    if (!s.enabled) return;
    if (Number.isFinite(t.cpuTempC)) buddy.notice({ kind: 'temp', which: 'cpu', value: t.cpuTempC as number, warn: (t.cpuTempC as number) >= s.cpuWarnC });
    if (Number.isFinite(t.gpuTempC)) buddy.notice({ kind: 'temp', which: 'gpu', value: t.gpuTempC as number, warn: (t.gpuTempC as number) >= s.gpuWarnC });
  };

  const state = new ScreenState(settings.spotify.fallbackMs);
  const assistant = new AssistantController(screen, buddy, hud, options.mock === true);
  state.onChange((name) => {
    screen.show(name);
    buddy.notice({ kind: 'screen' });
  });
  screen.show('slideshow');
  buddy.start();
  assistant.sync(settings);
  const offDebug = options.mock ? mockKeys(buddy) : () => {};

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
    buddy.applySettings(next);
    assistant.sync(next);
    state.setFallbackMs(next.spotify.fallbackMs);
  });

  let player: PlayerSource | null = null;
  let offAuth = (): void => {};
  let offPlayerSettings = (): void => {};

  if (options.mock) {
    const { startMock } = await import('../data/mock');
    player = startMock().player;
    wirePlayer(player, state, vinyl, buddy);
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
      wirePlayer(player, state, vinyl, buddy);
    };

    offAuth = onAuthChange(syncPlayer);
    offPlayerSettings = onSettingsChange(syncPlayer);
    syncPlayer();
  }

  return {
    screen,
    destroy(): void {
      clearTimeout(sampleTimer);
      offDebug();
      offSettings();
      offAuth();
      offPlayerSettings();
      player?.stop();
      assistant.destroy();
      buddy.destroy();
      hud.destroy();
      weather.destroy();
      overlay.destroy();
      screen.destroy();
    },
  };
}

const TELEMETRY_FORWARD_MS = 5000;
/** A turn that goes silent this long (agent crashed mid-sentence) sends Piťu back. */
const STALE_TURN_MS = 45_000;

/**
 * Links the voice assistant to Piťu: any non-sleeping state brings him up
 * close over a dimmed screen, 'sleeping' sends him back to his own business.
 * The screens underneath keep running either way.
 */
class AssistantController {
  private active = false;
  private source: AssistantSource | null = null;
  private signature = '';
  private staleTimer = 0;
  private offs: (() => void)[] = [];

  constructor(
    private readonly screen: Screen,
    private readonly buddy: Buddy,
    private readonly hud: AssistantHud,
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
    this.buddy.handle(msg);
    if (msg.type === 'status') return;
    if (msg.type === 'state') {
      this.hud.setState(msg);
      this.setActive(msg.state !== 'sleeping');
    }
    if (this.active) {
      clearTimeout(this.staleTimer);
      this.staleTimer = window.setTimeout(() => this.sleep(), STALE_TURN_MS);
    }
  }

  private setActive(active: boolean): void {
    this.active = active;
    this.screen.root.dataset.assistant = active ? 'on' : 'off';
    if (!active) clearTimeout(this.staleTimer);
  }

  private sleep(): void {
    if (!this.active) return;
    this.onMessage({ type: 'state', state: 'sleeping' });
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
    clearTimeout(this.staleTimer);
  }
}

function wirePlayer(player: PlayerSource, state: ScreenState, vinyl: VinylView, buddy: Buddy): void {
  let trackId: string | null = null;
  player.onResult((result) => {
    vinyl.update(result);
    if (result.kind === 'track' && result.now.id !== trackId) {
      if (trackId !== null && result.now.isPlaying) buddy.notice({ kind: 'track' });
      trackId = result.now.id;
    }
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

/** ?mock=1 keys for Piťu's idle life: z night · f ×10 time · p new photo · h full hour. */
function mockKeys(buddy: Buddy): () => void {
  const onKey = (ev: KeyboardEvent): void => {
    switch (ev.key) {
      case 'z':
        buddy.life.forceNight = !buddy.life.forceNight;
        break;
      case 'f':
        buddy.life.speed = buddy.life.speed === 1 ? 10 : 1;
        break;
      case 'p':
        buddy.notice({ kind: 'photo' });
        break;
      case 'h':
        buddy.notice({ kind: 'minute', hour: new Date().getHours(), minute: 0 });
        break;
      default:
        break;
    }
  };
  window.addEventListener('keydown', onKey);
  (window as unknown as { pitu: Buddy }).pitu = buddy;
  return () => window.removeEventListener('keydown', onKey);
}
