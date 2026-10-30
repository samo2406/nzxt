export type ScreenName = 'slideshow' | 'spotify';

/**
 * Decides which screen is visible. The only authority is the Spotify poller:
 * a successful poll reports playing or idle, a failed one reports nothing at
 * all — a dropped request must never push the LCD back to the slideshow.
 *
 * Idle does not switch immediately. The music screen lingers (disc easing to a
 * stop) for `fallbackMs` so skipping a track or a short pause doesn't make the
 * screen flap between states.
 */
export class ScreenState {
  private screen: ScreenName = 'slideshow';
  private timer = 0;
  private listeners = new Set<(screen: ScreenName) => void>();

  constructor(private fallbackMs: number) {}

  get current(): ScreenName {
    return this.screen;
  }

  setFallbackMs(ms: number): void {
    this.fallbackMs = ms;
  }

  reportPlaying(): void {
    this.clearTimer();
    this.set('spotify');
  }

  reportIdle(): void {
    if (this.screen !== 'spotify' || this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.set('slideshow');
    }, this.fallbackMs);
  }

  /** Spotify is not configured, or the user disconnected. */
  reset(): void {
    this.clearTimer();
    this.set('slideshow');
  }

  onChange(fn: (screen: ScreenName) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = 0;
  }

  private set(screen: ScreenName): void {
    if (this.screen === screen) return;
    this.screen = screen;
    for (const fn of this.listeners) {
      try {
        fn(screen);
      } catch (err) {
        console.error('[state] listener failed', err);
      }
    }
  }
}
