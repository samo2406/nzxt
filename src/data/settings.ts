import { publish, subscribe } from '../core/bus';

const STORAGE_KEY = 'kraken-lcd:settings';
const BUS_TYPE = 'settings';

export interface Settings {
  slideshow: {
    intervalMs: number;
    crossfadeMs: number;
    shuffle: boolean;
    kenBurns: boolean;
  };
  spotify: {
    clientId: string;
    /** How long the music screen lingers after playback stops. */
    fallbackMs: number;
    rotationRpm: number;
  };
  telemetry: {
    enabled: boolean;
    cpuWarnC: number;
    liquidWarnC: number;
  };
}

export const DEFAULTS: Settings = {
  slideshow: {
    intervalMs: 30_000,
    crossfadeMs: 1200,
    shuffle: false,
    kenBurns: false,
  },
  spotify: {
    clientId: '',
    fallbackMs: 20_000,
    rotationRpm: 6,
  },
  telemetry: {
    enabled: true,
    cpuWarnC: 85,
    liquidWarnC: 45,
  },
};

export type SettingsPatch = {
  [K in keyof Settings]?: Partial<Settings[K]>;
};

/** Group-wise merge over the defaults, dropping any stored value whose type
 *  no longer matches, so an older or hand-edited blob can't poison a setting. */
function merge(stored: unknown): Settings {
  const src = (stored ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const out: Record<string, unknown> = {};
  for (const group of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const defaults = DEFAULTS[group] as Record<string, unknown>;
    const found = src[group] ?? {};
    const merged: Record<string, unknown> = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const value = found[key];
      if (value !== undefined && typeof value === typeof defaults[key]) merged[key] = value;
    }
    out[group] = merged;
  }
  return out as unknown as Settings;
}

function read(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return merge(raw ? JSON.parse(raw) : null);
  } catch {
    return merge(null);
  }
}

let current = read();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: SettingsPatch): Settings {
  const next = { ...current } as unknown as Record<string, unknown>;
  for (const group of Object.keys(patch) as (keyof Settings)[]) {
    next[group] = { ...current[group], ...patch[group] };
  }
  current = next as unknown as Settings;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch (err) {
    console.error('[settings] could not persist', err);
  }
  // The bus delivers locally too, so the subscriber below does the notifying.
  publish({ type: BUS_TYPE });
  return current;
}

const listeners = new Set<(s: Settings) => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn(current);
    } catch (err) {
      console.error('[settings] listener failed', err);
    }
  }
}

subscribe((msg) => {
  if (msg.type !== BUS_TYPE) return;
  current = read();
  notify();
});

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
