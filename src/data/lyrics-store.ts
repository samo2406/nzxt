import type { Lyrics } from './lyrics';

/**
 * Lyrics remembered across reloads in localStorage, so a song played before
 * shows its words instantly with no LRCLIB request. Kept under a size budget
 * (~200 songs); when it's full, songs played rarely and long ago go first.
 */

const KEY = 'kraken-lcd:lyrics';
/** Characters of JSON, roughly 200 songs; localStorage holds about 5M per origin. */
const BUDGET = 700_000;
/** Each play buys this much extra time before eviction, up to MAX_PLAYS of them. */
const PLAY_BONUS_MS = 3 * 24 * 3600_000;
const MAX_PLAYS = 10;
/** "No synced lyrics" is re-checked after this; LRCLIB keeps growing. */
const MISS_TTL_MS = 7 * 24 * 3600_000;

interface Entry {
  /** Last played. */
  t: number;
  /** Times played. */
  n: number;
  /** `centiseconds\ttext` per line, or null for a track with no synced lyrics. */
  l: string | null;
}

type Store = Record<string, Entry>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const store = raw ? JSON.parse(raw) : {};
    return store && typeof store === 'object' ? store : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  const keep = (budget: number): Store => {
    const ranked = Object.entries(store).sort(([, a], [, b]) => worth(b) - worth(a));
    const out: Store = {};
    let size = 2;
    for (const [id, entry] of ranked) {
      size += id.length + JSON.stringify(entry).length + 4;
      if (size > budget) break;
      out[id] = entry;
    }
    return out;
  };
  for (const budget of [BUDGET, BUDGET / 2, BUDGET / 8]) {
    try {
      localStorage.setItem(KEY, JSON.stringify(keep(budget)));
      return;
    } catch {
      // Over quota (other keys share it) or storage blocked: try smaller.
    }
  }
}

function worth(entry: Entry): number {
  return entry.t + Math.min(entry.n, MAX_PLAYS) * PLAY_BONUS_MS;
}

function encode(lyrics: Lyrics): string {
  return lyrics.lines.map((line) => `${Math.round(line.at / 10)}\t${line.text}`).join('\n');
}

function decode(packed: string): Lyrics {
  return {
    lines: packed.split('\n').map((row) => {
      const tab = row.indexOf('\t');
      return { at: Number(row.slice(0, tab)) * 10, text: row.slice(tab + 1) };
    }),
  };
}

/** Undefined when unknown (or a stale miss), and counts it as a play. */
export function recall(id: string): Lyrics | null | undefined {
  const store = read();
  const entry = store[id];
  if (!entry) return undefined;
  if (entry.l === null && Date.now() - entry.t > MISS_TTL_MS) return undefined;
  entry.t = Date.now();
  entry.n += 1;
  write(store);
  return entry.l === null ? null : decode(entry.l);
}

export function remember(id: string, lyrics: Lyrics | null): void {
  const store = read();
  store[id] = { t: Date.now(), n: store[id]?.n ?? 1, l: lyrics ? encode(lyrics) : null };
  write(store);
}
