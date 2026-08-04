import type { Cpu, Gpu, MonitoringData } from '@nzxt/web-integrations-types/v1';
import type { NowPlaying, PlayerSource, PollResult } from './player';

/**
 * `?mock=1` harness. Everything the LCD consumes is faked here so the whole UI
 * can be built, profiled and leak-tested without CAM or a Spotify account.
 *
 * Keys (mock only):
 *   space  play / pause          n  next track
 *   ← / →  seek ∓10s             s  stop (nothing playing → falls back to slideshow)
 *   e      toggle forced poll errors      u  toggle "authorisation revoked"
 *   d      toggle a degraded monitoring payload (missing fields)
 *   t      force a temperature spike now
 */

const POLL_MS = 3000;
const MONITOR_MS = 1000;

interface MockTrack {
  title: string;
  artist: string;
  durationMs: number;
  isEpisode: boolean;
  palette: [string, string, string];
}

const TRACKS: MockTrack[] = [
  {
    title: 'Neónové Ráno',
    artist: 'Kryštál Kvet',
    durationMs: 214_000,
    isEpisode: false,
    palette: ['#2b1055', '#7597de', '#ff8fab'],
  },
  {
    title: 'The Longest Possible Track Title That Should Definitely Get Clamped',
    artist: 'Overflow Test Ensemble & The Very Long Name Collective',
    durationMs: 402_000,
    isEpisode: false,
    palette: ['#0f2027', '#2c5364', '#f5d76e'],
  },
  {
    title: 'Slow Tide',
    artist: 'Halcyon Bay',
    durationMs: 187_000,
    isEpisode: false,
    palette: ['#3a1c71', '#d76d77', '#ffaf7b'],
  },
  {
    title: 'Ep. 214 — On Cooling Loops',
    artist: 'The Build Log',
    durationMs: 2_940_000,
    isEpisode: true,
    palette: ['#1b1b1f', '#4b5563', '#9ca3af'],
  },
];

function drawCover(palette: [string, string, string]): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 400;
  const g = canvas.getContext('2d');
  if (!g) return '';

  const grad = g.createLinearGradient(0, 0, 400, 400);
  grad.addColorStop(0, palette[0]);
  grad.addColorStop(1, palette[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, 400, 400);

  g.fillStyle = palette[2];
  g.beginPath();
  g.arc(285, 135, 88, 0, Math.PI * 2);
  g.fill();

  g.globalAlpha = 0.28;
  g.fillStyle = palette[2];
  for (let i = 0; i < 5; i++) g.fillRect(0, 288 + i * 20, 400, 6 + i * 2);
  g.globalAlpha = 1;

  return canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------- monitoring

function makeCpu(temperature: number, load: number): Cpu {
  return {
    name: 'Mock Core i9-14900K',
    manufacturer: 'Intel',
    codeName: 'Raptor Lake',
    socket: 'LGA1700',
    load,
    numCores: 24,
    numThreads: 32,
    temperature,
    minTemperature: 32,
    maxTemperature: 100,
    frequency: 3200 + load * 2400,
    minFrequency: 800,
    maxFrequency: 5800,
    stockFrequency: 3200,
    fanSpeed: 900 + load * 1200,
    minFanSpeed: 600,
    maxFanSpeed: 2200,
    tdp: 125,
    power: 45 + load * 180,
  };
}

function makeGpu(temperature: number, load: number): Gpu {
  return {
    name: 'Mock RTX 4080',
    load,
    temperature,
    minTemperature: 30,
    maxTemperature: 90,
    frequency: 1400 + load * 1100,
    minFrequency: 210,
    maxFrequency: 2600,
    stockFrequency: 2205,
    fanSpeed: 800 + load * 1400,
    minFanSpeed: 0,
    maxFanSpeed: 2800,
    power: 60 + load * 260,
  };
}

class MockMonitor {
  private handle = 0;
  private phase = 0;
  private spikeUntil = 0;
  degraded = false;

  start(): void {
    this.stop();
    this.handle = window.setInterval(() => this.emit(), MONITOR_MS);
    this.emit();
  }

  stop(): void {
    clearInterval(this.handle);
    this.handle = 0;
  }

  spike(): void {
    this.spikeUntil = performance.now() + 6000;
  }

  private emit(): void {
    const push = window.nzxt?.v1?.onMonitoringDataUpdate;
    if (!push) return;

    this.phase += MONITOR_MS / 1000;
    // A spike every ~45s so the warning threshold gets exercised unattended.
    if (this.phase % 45 < 1) this.spike();
    const spiking = performance.now() < this.spikeUntil;

    const load = spiking ? 0.98 : 0.25 + 0.2 * Math.sin(this.phase / 7) + Math.random() * 0.08;
    const cpuTemp = spiking ? 88 + Math.random() * 6 : 47 + load * 26 + Math.random() * 2;
    const gpuTemp = 42 + load * 24 + Math.random() * 2;
    const liquid = 29 + load * 11 + Math.sin(this.phase / 20) * 1.5;

    if (this.degraded) {
      // Missing hardware, missing coolant reading — the screen must not blank.
      push({ cpus: [], gpus: [], ram: { totalSize: undefined, inUse: undefined, modules: [] }, kraken: {} } as unknown as MonitoringData);
      return;
    }

    push({
      cpus: [makeCpu(cpuTemp, load)],
      gpus: [makeGpu(gpuTemp, load)],
      ram: {
        totalSize: 32768,
        inUse: 12000 + Math.random() * 4000,
        modules: [
          { kind: 'DDR5', size: 16384, model: 'Mock 6000', frequency: 6000, stockFrequency: 4800 },
          { kind: 'DDR5', size: 16384, model: 'Mock 6000', frequency: 6000, stockFrequency: 4800 },
        ],
      },
      kraken: { liquidTemperature: liquid },
    });
  }
}

// -------------------------------------------------------------------- player

class MockPlayer implements PlayerSource {
  private listeners = new Set<(r: PollResult) => void>();
  private handle = 0;
  private index = 0;
  private progressMs = 0;
  private lastAdvance = 0;
  private playing = true;
  private stopped = false;
  private covers: string[] = [];
  private seeked = true;
  forceError = false;
  forceUnauthorized = false;

  constructor() {
    this.covers = TRACKS.map((t) => drawCover(t.palette));
  }

  start(): void {
    this.stop();
    this.lastAdvance = performance.now();
    this.handle = window.setInterval(() => this.emit(), POLL_MS);
    this.emit();
  }

  stop(): void {
    clearInterval(this.handle);
    this.handle = 0;
  }

  onResult(fn: (r: PollResult) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private advance(): void {
    const now = performance.now();
    const dt = now - this.lastAdvance;
    this.lastAdvance = now;
    if (!this.playing || this.stopped) return;
    this.progressMs += dt;
    const duration = TRACKS[this.index].durationMs;
    if (this.progressMs >= duration) {
      this.progressMs = 0;
      this.index = (this.index + 1) % TRACKS.length;
      this.seeked = true;
    }
  }

  private snapshot(): NowPlaying {
    const track = TRACKS[this.index];
    return {
      id: `mock-${this.index}`,
      title: track.title,
      artist: track.artist,
      artUrl: this.covers[this.index] || null,
      durationMs: track.durationMs,
      progressMs: this.progressMs,
      isPlaying: this.playing,
      isEpisode: track.isEpisode,
      sampledAt: performance.now(),
      seeked: this.seeked,
    };
  }

  /** Emits on the poll cadence, and immediately after a key press. */
  private emit(): void {
    this.advance();
    let result: PollResult;
    if (this.forceUnauthorized) result = { kind: 'unauthorized' };
    else if (this.forceError) result = { kind: 'error', reason: 'mock forced error' };
    else if (this.stopped) result = { kind: 'idle' };
    else result = { kind: 'track', now: this.snapshot() };

    for (const fn of this.listeners) fn(result);
    this.seeked = false;
  }

  toggle(): void {
    this.advance();
    this.stopped = false;
    this.playing = !this.playing;
    this.emit();
  }

  next(): void {
    this.index = (this.index + 1) % TRACKS.length;
    this.progressMs = 0;
    this.stopped = false;
    this.seeked = true;
    this.lastAdvance = performance.now();
    this.emit();
  }

  seek(deltaMs: number): void {
    this.advance();
    const duration = TRACKS[this.index].durationMs;
    this.progressMs = Math.min(Math.max(this.progressMs + deltaMs, 0), duration - 1000);
    this.seeked = true;
    this.emit();
  }

  setStopped(stopped: boolean): void {
    this.advance();
    this.stopped = stopped;
    this.emit();
  }
}

// --------------------------------------------------------------------- entry

export interface MockHarness {
  player: PlayerSource;
}

export function startMock(): MockHarness {
  const monitor = new MockMonitor();
  const player = new MockPlayer();
  monitor.start();

  window.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        player.toggle();
        break;
      case 'n':
        player.next();
        break;
      case 'ArrowLeft':
        player.seek(-10_000);
        break;
      case 'ArrowRight':
        player.seek(10_000);
        break;
      case 's':
        player.setStopped(true);
        break;
      case 'e':
        player.forceError = !player.forceError;
        console.info('[mock] forced errors', player.forceError);
        break;
      case 'u':
        player.forceUnauthorized = !player.forceUnauthorized;
        console.info('[mock] authorisation revoked', player.forceUnauthorized);
        break;
      case 'd':
        monitor.degraded = !monitor.degraded;
        console.info('[mock] degraded monitoring', monitor.degraded);
        break;
      case 't':
        monitor.spike();
        break;
      default:
        break;
    }
  });

  return { player };
}
