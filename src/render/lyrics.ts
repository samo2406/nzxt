import { prefersReducedMotion } from '../core/env';
import { fetchLyrics, mockLyrics, type Lyrics } from '../data/lyrics';
import type { NowPlaying, PollResult } from '../data/player';
import '../styles/lyrics.css';

/** A failed lookup (LRCLIB busy, offline) is tried again this much later, twice. */
const RETRY_MS = 30_000;
/** A line longer than this is a break, not a verse — Piťu can dance through it. */
const LONG_GAP_MS = 9000;

export interface LyricState {
  index: number;
  text: string;
  /** The same words come back elsewhere in the song: probably the refrain. */
  repeated: boolean;
  /** An instrumental break, or before the first line. */
  gap: boolean;
  /** Milliseconds into this line, and how long it lasts. */
  elapsed: number;
  length: number;
}

/**
 * Current line large, next one dim, over the upper half of the record.
 * Driven by one timer per line change, re-anchored on every poll; nothing
 * runs per frame.
 */
export class LyricsView {
  readonly el: HTMLElement;
  private readonly current: HTMLElement;
  private readonly next: HTMLElement;
  private lyrics: Lyrics | null = null;
  private repeats = new Set<string>();
  private progressMs = 0;
  private sampledAt = 0;
  private playing = false;
  private shown = -2;
  private timer = 0;
  private enabled = true;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'lyrics';
    this.el.dataset.on = 'false';
    this.current = document.createElement('div');
    this.current.className = 'lyrics__line';
    this.next = document.createElement('div');
    this.next.className = 'lyrics__next';
    this.el.append(this.current, this.next);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.set(null);
  }

  set(lyrics: Lyrics | null): void {
    this.lyrics = lyrics;
    const counts = new Map<string, number>();
    for (const line of lyrics?.lines ?? []) {
      const key = line.text.toLowerCase();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    this.repeats = new Set([...counts].filter(([, n]) => n > 1).map(([key]) => key));
    this.shown = -2;
    this.render();
  }

  update(now: NowPlaying): void {
    this.progressMs = now.progressMs;
    this.sampledAt = now.sampledAt;
    this.playing = now.isPlaying;
    this.render();
  }

  stop(): void {
    this.playing = false;
    this.render();
  }

  private position(): number {
    return this.progressMs + (this.playing ? performance.now() - this.sampledAt : 0);
  }

  private indexAt(ms: number): number {
    const lines = this.lyrics?.lines ?? [];
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].at <= ms) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /** What Piťu needs to sing along; null when there's nothing to follow. */
  state(): LyricState | null {
    const lines = this.lyrics?.lines;
    if (!lines || !this.playing || !this.enabled) return null;
    const pos = this.position();
    const i = this.indexAt(pos);
    const start = i >= 0 ? lines[i].at : 0;
    const end = lines[i + 1]?.at ?? start + LONG_GAP_MS;
    const text = i >= 0 ? lines[i].text : '';
    return {
      index: i,
      text,
      repeated: this.repeats.has(text.toLowerCase()),
      gap: !text || end - start > LONG_GAP_MS * 1.6,
      elapsed: pos - start,
      length: end - start,
    };
  }

  private render(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    const lines = this.lyrics?.lines;
    this.el.dataset.on = lines && this.enabled ? 'true' : 'false';
    if (!lines || !this.enabled) return;

    const pos = this.position();
    const i = this.indexAt(pos);
    if (i !== this.shown) {
      this.shown = i;
      this.show(i >= 0 ? lines[i].text : '', this.upcoming(i));
    }
    const nextAt = lines[i + 1]?.at;
    if (this.playing && nextAt !== undefined) {
      this.timer = window.setTimeout(() => this.render(), Math.max(30, nextAt - pos));
    }
  }

  private upcoming(i: number): string {
    const lines = this.lyrics?.lines ?? [];
    for (let k = i + 1; k < lines.length && k <= i + 3; k++) if (lines[k].text) return lines[k].text;
    return '';
  }

  private show(text: string, next: string): void {
    this.current.textContent = text;
    this.current.dataset.size = text.length > 46 ? 's' : text.length > 28 ? 'm' : 'l';
    this.next.textContent = next;
    if (text && !prefersReducedMotion()) {
      this.current.animate(
        [
          { opacity: 0, transform: 'translateY(30%)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 320, easing: 'cubic-bezier(0.22, 0.9, 0.3, 1)' },
      );
    }
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.el.remove();
  }
}

/** Loads the lyrics once per track and keeps the view on the player's clock. */
export class LyricsFeed {
  private trackId: string | null = null;
  private last: NowPlaying | null = null;
  private abort: AbortController | null = null;
  private retryTimer = 0;

  constructor(
    private readonly view: LyricsView,
    private readonly mock: boolean,
    private enabled: boolean,
  ) {
    view.setEnabled(enabled);
  }

  result(result: PollResult): void {
    if (result.kind === 'track') {
      this.last = result.now;
      if (result.now.id !== this.trackId) this.load(result.now);
      this.view.update(result.now);
    } else if (result.kind === 'idle' || result.kind === 'unauthorized') {
      this.view.stop();
    }
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.view.setEnabled(enabled);
    if (enabled && this.last) {
      this.load(this.last);
      this.view.update(this.last);
    }
  }

  private load(now: NowPlaying, retries = 2): void {
    this.trackId = now.id;
    clearTimeout(this.retryTimer);
    this.abort?.abort();
    this.abort = null;
    this.view.set(null);
    if (!this.enabled) return;
    if (this.mock) {
      this.view.set(mockLyrics(now));
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    fetchLyrics(now, abort.signal)
      .then((lyrics) => {
        if (this.trackId === now.id) this.view.set(lyrics);
      })
      .catch((err) => {
        if (abort.signal.aborted) return;
        console.warn('[lyrics] could not load', err);
        if (retries > 0) {
          this.retryTimer = window.setTimeout(() => {
            if (this.trackId === now.id && this.last) this.load(this.last, retries - 1);
          }, RETRY_MS);
        }
      });
  }

  destroy(): void {
    clearTimeout(this.retryTimer);
    this.abort?.abort();
    this.view.destroy();
  }
}
