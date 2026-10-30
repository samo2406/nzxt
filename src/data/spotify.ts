import { publish, subscribe } from '../core/bus';
import { isKrakenWindow } from '../core/env';
import type { NowPlaying, PlayerSource, PollResult, TrackInfo } from './player';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode';
const QUEUE_URL = 'https://api.spotify.com/v1/me/player/queue';
const SCOPES = 'user-read-currently-playing user-read-playback-state';

const TOKEN_KEY = 'kraken-lcd:spotify-token';
const VERIFIER_KEY = 'kraken-lcd:spotify-verifier';
const MUTEX_KEY = 'kraken-lcd:spotify-refresh';
const BUS_TYPE = 'spotify-auth';

/** Spotify has no push API for playback state, so reaction latency is bounded
 *  by this cadence. 2s keeps a lone user far inside the rate budget. */
const POLL_MS = 2000;
/** Refresh this far ahead of expiry rather than on a 401. */
const REFRESH_LEAD_MS = 60_000;
const MUTEX_TTL_MS = 15_000;
/** Position drift beyond this means the user seeked, not that time passed. */
const SEEK_EPSILON_MS = 2000;

const holderId = crypto.randomUUID();

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

/**
 * Spotify requires the redirect URI to match the registered one byte for byte.
 * Deriving it from the live location is the only way to guarantee the string
 * shown in the config UI is the string actually sent.
 */
export function redirectUri(): string {
  return location.origin + location.pathname;
}

// ---------------------------------------------------------------- token store

export function readToken(): TokenSet | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const token = JSON.parse(raw) as TokenSet;
    return token.access_token && token.refresh_token ? token : null;
  } catch {
    return null;
  }
}

function writeToken(token: TokenSet): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  publish({ type: BUS_TYPE });
}

export function disconnect(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(MUTEX_KEY);
  publish({ type: BUS_TYPE });
}

export function isConnected(): boolean {
  return readToken() !== null;
}

export function onAuthChange(fn: () => void): () => void {
  return subscribe((msg) => {
    if (msg.type === BUS_TYPE) fn();
  });
}

// ----------------------------------------------------------------- PKCE flow

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * Config window only. The Kraken window is never navigated — CAM stops
 * streaming it the moment its URL changes.
 */
export async function beginAuth(clientId: string): Promise<void> {
  if (isKrakenWindow) throw new Error('refusing to navigate the Kraken window');

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state, clientId }));

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    state,
  });
  location.assign(`${AUTH_URL}?${params}`);
}

export type AuthOutcome = { status: 'none' } | { status: 'ok' } | { status: 'failed'; reason: string };

/** Consumes `?code=` on return from Spotify and cleans it out of the URL. */
export async function completeAuth(): Promise<AuthOutcome> {
  if (isKrakenWindow) return { status: 'none' };

  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return { status: 'none' };

  const stored = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  // Safe here: the config window is a normal tab, and the path is unchanged.
  history.replaceState(null, '', redirectUri());

  if (error) return { status: 'failed', reason: error };
  if (!stored) return { status: 'failed', reason: 'chýba overovací kód (verifier)' };

  const { verifier, state, clientId } = JSON.parse(stored) as {
    verifier: string;
    state: string;
    clientId: string;
  };
  if (params.get('state') !== state) return { status: 'failed', reason: 'nesúhlasí state' };

  try {
    const token = await exchange(
      new URLSearchParams({
        client_id: clientId,
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirectUri(),
        code_verifier: verifier,
      }),
    );
    writeToken(token);
    return { status: 'ok' };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

async function exchange(body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `HTTP ${res.status}`);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

// -------------------------------------------------------------- refresh mutex

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Refresh tokens rotate, so two windows refreshing at once would invalidate
 * each other and log the user out. The loser waits for the winner's token
 * instead of asking for its own.
 */
async function claimRefresh(): Promise<boolean> {
  const raw = localStorage.getItem(MUTEX_KEY);
  if (raw) {
    try {
      const held = JSON.parse(raw) as { owner: string; at: number };
      if (Date.now() - held.at < MUTEX_TTL_MS) return false;
    } catch {
      /* corrupt claim, treat as stale */
    }
  }
  localStorage.setItem(MUTEX_KEY, JSON.stringify({ owner: holderId, at: Date.now() }));
  // Last write wins; give the other window time to land its claim, then check.
  await sleep(80);
  try {
    return (JSON.parse(localStorage.getItem(MUTEX_KEY) ?? '{}') as { owner?: string }).owner === holderId;
  } catch {
    return false;
  }
}

async function awaitOtherRefresh(previous: string): Promise<TokenSet | null> {
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const token = readToken();
    if (token && token.access_token !== previous) return token;
    if (!token) return null;
  }
  return null;
}

async function refreshToken(clientId: string, token: TokenSet): Promise<TokenSet | null> {
  if (!(await claimRefresh())) return awaitOtherRefresh(token.access_token);

  try {
    const next = await exchange(
      new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
      }),
    );
    // A rotated response may omit the refresh token; keep the working one.
    if (!next.refresh_token) next.refresh_token = token.refresh_token;
    writeToken(next);
    return next;
  } catch (err) {
    console.warn('[spotify] refresh failed', err);
    return null;
  } finally {
    localStorage.removeItem(MUTEX_KEY);
  }
}

async function validToken(clientId: string): Promise<TokenSet | null> {
  const token = readToken();
  if (!token) return null;
  if (token.expires_at - Date.now() > REFRESH_LEAD_MS) return token;
  return refreshToken(clientId, token);
}

// ---------------------------------------------------------------- now playing

interface SpotifyImage {
  url: string;
  width?: number;
  height?: number;
}

function pickArt(images: SpotifyImage[] | undefined): string | null {
  if (!images?.length) return null;
  // Largest available: it is scaled down into a disc, so detail is worth it.
  return images.reduce((best, img) => ((img.width ?? 0) > (best.width ?? 0) ? img : best)).url ?? null;
}

function trackInfo(item: any): TrackInfo {
  const isEpisode = item.type === 'episode';
  const artists: string[] = Array.isArray(item.artists)
    ? item.artists.map((a: { name?: string }) => a?.name).filter(Boolean)
    : [];
  return {
    id: item.id ?? item.uri ?? 'unknown',
    title: item.name ?? '',
    artist: isEpisode ? (item.show?.name ?? '') : artists.join(', '),
    durationMs: item.duration_ms ?? 0,
    isEpisode,
  };
}

function parse(json: Record<string, any>, previous: NowPlaying | null): NowPlaying | null {
  const item = json?.item;
  if (!item) return null;

  const info = trackInfo(item);

  const progressMs = typeof json.progress_ms === 'number' ? json.progress_ms : 0;
  const sampledAt = performance.now();

  let seeked = true;
  if (previous && previous.id === item.id) {
    const elapsed = previous.isPlaying ? sampledAt - previous.sampledAt : 0;
    seeked = Math.abs(progressMs - (previous.progressMs + elapsed)) > SEEK_EPSILON_MS;
  }

  return {
    ...info,
    artUrl: pickArt(info.isEpisode ? item.images : item.album?.images),
    progressMs,
    isPlaying: json.is_playing === true,
    sampledAt,
    seeked,
  };
}

export class SpotifyPlayer implements PlayerSource {
  private listeners = new Set<(r: PollResult) => void>();
  private handle = 0;
  private running = false;
  private previous: NowPlaying | null = null;
  private retryAfterUntil = 0;

  constructor(private clientId: string) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.handle);
    this.handle = 0;
  }

  onResult(fn: (r: PollResult) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(result: PollResult): void {
    for (const fn of this.listeners) {
      try {
        fn(result);
      } catch (err) {
        console.error('[spotify] listener failed', err);
      }
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    clearTimeout(this.handle);
    this.handle = window.setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    const wait = this.retryAfterUntil - Date.now();
    if (wait > 0) {
      this.schedule(wait);
      return;
    }

    try {
      const result = await this.poll();
      this.emit(result);
      if (result.kind === 'unauthorized') {
        this.stop();
        return;
      }
    } catch (err) {
      this.emit({ kind: 'error', reason: err instanceof Error ? err.message : String(err) });
    }
    this.schedule(POLL_MS);
  }

  private async poll(retriedAfter401 = false): Promise<PollResult> {
    const token = await validToken(this.clientId);
    if (!token) return { kind: 'unauthorized' };

    let res: Response;
    try {
      res = await fetch(API_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
    } catch (err) {
      return { kind: 'error', reason: err instanceof Error ? err.message : 'network' };
    }

    if (res.status === 204) {
      this.previous = null;
      return { kind: 'idle' };
    }

    if (res.status === 401) {
      if (retriedAfter401) {
        disconnect();
        return { kind: 'unauthorized' };
      }
      const refreshed = await refreshToken(this.clientId, token);
      if (!refreshed) {
        disconnect();
        return { kind: 'unauthorized' };
      }
      return this.poll(true);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '5');
      this.retryAfterUntil = Date.now() + (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000;
      return { kind: 'error', reason: `rate limited ${retryAfter}s` };
    }

    if (res.status === 403) {
      disconnect();
      return { kind: 'unauthorized' };
    }

    if (!res.ok) return { kind: 'error', reason: `HTTP ${res.status}` };

    const json = await res.json().catch(() => null);
    const now = json ? parse(json, this.previous) : null;
    if (!now) {
      this.previous = null;
      return { kind: 'idle' };
    }
    this.previous = now;
    return { kind: 'track', now };
  }

  async upNext(): Promise<TrackInfo | null> {
    const token = await validToken(this.clientId);
    if (!token || Date.now() < this.retryAfterUntil) return null;
    const res = await fetch(QUEUE_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const item = json?.queue?.[0];
    return item ? trackInfo(item) : null;
  }
}
