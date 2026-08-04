import type { Settings } from './settings';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

const POLL_MS = 15 * 60_000;
const RETRY_MS = 2 * 60_000;
const CACHE_KEY = 'kraken-lcd:weather-cache';
/** A cache older than this is stale enough to hide rather than show. */
const CACHE_TTL_MS = 3 * 60 * 60_000;

export interface WeatherNow {
  tempC: number;
  /** WMO weather code as reported by Open-Meteo. */
  code: number;
}

interface CacheEntry extends WeatherNow {
  at: number;
  key: string;
}

function cacheKeyFor(s: Settings['weather']): string {
  return `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`;
}

function readCache(key: string): WeatherNow | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.key !== key || Date.now() - entry.at > CACHE_TTL_MS) return null;
    return { tempC: entry.tempC, code: entry.code };
  } catch {
    return null;
  }
}

function writeCache(key: string, now: WeatherNow): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...now, at: Date.now(), key } satisfies CacheEntry));
  } catch {
    /* quota; the next poll will try again */
  }
}

/**
 * Polls Open-Meteo (keyless, CORS-friendly) every 15 minutes while a place is
 * configured. The last reading is cached so a reload shows weather instantly
 * and a network drop holds the value instead of blanking it.
 */
export class WeatherSource {
  private timer = 0;
  private key = '';

  constructor(private readonly onUpdate: (now: WeatherNow | null) => void) {}

  sync(weather: Settings['weather']): void {
    const configured = weather.place !== '' && (weather.lat !== 0 || weather.lon !== 0);
    const key = configured ? cacheKeyFor(weather) : '';
    if (key === this.key) return;
    this.key = key;

    clearTimeout(this.timer);
    this.timer = 0;
    if (!configured) {
      this.onUpdate(null);
      return;
    }

    const cached = readCache(key);
    this.onUpdate(cached);
    void this.poll(weather, key);
  }

  private async poll(weather: Settings['weather'], key: string): Promise<void> {
    if (key !== this.key) return;
    let delay = POLL_MS;
    try {
      const params = new URLSearchParams({
        latitude: String(weather.lat),
        longitude: String(weather.lon),
        current: 'temperature_2m,weather_code',
      });
      const res = await fetch(`${FORECAST_URL}?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const tempC = json?.current?.temperature_2m;
      const code = json?.current?.weather_code;
      if (typeof tempC === 'number' && key === this.key) {
        const now: WeatherNow = { tempC, code: typeof code === 'number' ? code : 3 };
        writeCache(key, now);
        this.onUpdate(now);
      }
    } catch {
      delay = RETRY_MS;
    }
    if (key !== this.key) return;
    this.timer = window.setTimeout(() => void this.poll(weather, key), delay);
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    this.key = '';
  }
}

export interface GeocodeHit {
  name: string;
  lat: number;
  lon: number;
  country: string;
}

/** Config-window helper: resolve a city name to coordinates. */
export async function geocode(place: string): Promise<GeocodeHit | null> {
  const params = new URLSearchParams({ name: place, count: '1', language: 'sk', format: 'json' });
  const res = await fetch(`${GEOCODE_URL}?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const hit = json?.results?.[0];
  if (!hit) return null;
  return {
    name: hit.name ?? place,
    lat: hit.latitude,
    lon: hit.longitude,
    country: hit.country_code ?? '',
  };
}
