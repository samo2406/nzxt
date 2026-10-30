import type { NowPlaying } from './player';

/**
 * Time-synced lyrics from LRCLIB (https://lrclib.net), a free, keyless,
 * CORS-enabled database. Fetched at runtime for the track that's playing and
 * kept in memory only; nothing is stored or shipped with the page.
 */

export interface LyricLine {
  /** Milliseconds from the start of the track. */
  at: number;
  /** Empty for an instrumental break. */
  text: string;
}

export interface Lyrics {
  lines: LyricLine[];
}

const API = 'https://lrclib.net/api';
/** LRCLIB matches a duration within ±2 s; search hits get a little more slack. */
const DURATION_SLACK_S = 3;
const CACHE_SIZE = 40;

const cache = new Map<string, Lyrics | null>();

interface LrclibRecord {
  duration?: number;
  syncedLyrics?: string | null;
}

/** `[mm:ss.xx]` stamps, possibly several on one line for a repeated chorus. */
export function parseLrc(lrc: string): Lyrics {
  const lines: LyricLine[] = [];
  const stamp = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    let end = 0;
    stamp.lastIndex = 0;
    while ((match = stamp.exec(raw)) && match.index === end) {
      stamps.push((Number(match[1]) * 60 + Number(match[2].replace(':', '.'))) * 1000);
      end = stamp.lastIndex;
    }
    const text = raw.slice(end).trim();
    for (const at of stamps) lines.push({ at, text });
  }
  lines.sort((a, b) => a.at - b.at);
  return { lines };
}

/** LRCLIB is often overloaded for minutes at a time but lets the odd request through. */
const BUSY_BUDGET_MS = 120_000;
const BUSY_MAX_WAIT_S = 8;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** LRCLIB sheds load with 503/429 + Retry-After; keep trying with a backoff and a little jitter. */
async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal });
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if ((res.status !== 503 && res.status !== 429) || Date.now() - started > BUSY_BUDGET_MS) throw new Error(`lrclib ${res.status}`);
    const asked = Number(res.headers.get('retry-after')) || 1;
    const wait = Math.max(asked, Math.min(BUSY_MAX_WAIT_S, 2 ** attempt)) * 1000;
    await sleep(wait + Math.random() * 600, signal);
  }
}

function synced(record: LrclibRecord | null): Lyrics | null {
  const lrc = record?.syncedLyrics;
  if (!lrc) return null;
  const lyrics = parseLrc(lrc);
  return lyrics.lines.some((l) => l.text) ? lyrics : null;
}

/**
 * Null when the track has no synced lyrics (cached), throws on a network
 * failure (not cached, so the next play retries).
 */
export async function fetchLyrics(now: NowPlaying, signal: AbortSignal): Promise<Lyrics | null> {
  if (now.isEpisode || !now.title || !now.artist) return null;
  const hit = cache.get(now.id);
  if (hit !== undefined) return hit;

  const artist = now.artist.split(', ')[0];
  const duration = Math.round(now.durationMs / 1000);
  const q = (params: Record<string, string>): string => new URLSearchParams(params).toString();

  let lyrics = synced(
    (await getJson(`${API}/get?${q({ track_name: now.title, artist_name: artist, duration: String(duration) })}`, signal)) as LrclibRecord | null,
  );
  if (!lyrics) {
    const found = (await getJson(`${API}/search?${q({ track_name: now.title, artist_name: artist })}`, signal)) as LrclibRecord[] | null;
    const best = (found ?? [])
      .filter((r) => r.syncedLyrics && Math.abs((r.duration ?? 0) - duration) <= DURATION_SLACK_S)
      .sort((a, b) => Math.abs((a.duration ?? 0) - duration) - Math.abs((b.duration ?? 0) - duration))[0];
    lyrics = synced(best ?? null);
  }

  cache.set(now.id, lyrics);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return lyrics;
}

/** Placeholder lines for the ?mock=1 tracks: a verse, a repeated refrain and breaks. */
export function mockLyrics(now: NowPlaying): Lyrics | null {
  if (now.isEpisode) return null;
  const verse = ['Skúšobný riadok číslo jeden', 'Druhý riadok, trochu dlhší než ten prvý', 'Tretí riadok', 'A štvrtý na koniec verša'];
  const refrain = ['La la la, toto je refrén', 'Refrén sa opakuje', 'La la la, ešte raz'];
  const lines: LyricLine[] = [{ at: 0, text: '' }];
  let at = 8000;
  while (at < now.durationMs - 10_000) {
    for (const block of [verse, refrain]) {
      for (const text of block) {
        lines.push({ at, text });
        at += 3800;
      }
      lines.push({ at, text: '' });
      at += 7000;
    }
  }
  return { lines };
}
