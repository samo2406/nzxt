/**
 * Shared frame ticker. Almost nothing here needs per-frame JavaScript — the
 * screens animate on the compositor — so this runs only while something is
 * actively subscribed (a rotation-speed ramp, a progress interpolation).
 *
 * The Kraken window is hidden and streamed rather than presented, so
 * requestAnimationFrame may be throttled or starved there. If frames stop
 * arriving, fall back to a timer permanently rather than freezing.
 */

export type TickFn = (dtMs: number, nowMs: number) => void;

const STARVATION_MS = 400;

const subs = new Set<TickFn>();
let mode: 'idle' | 'raf' | 'interval' = 'idle';
let rafHandle = 0;
let intervalHandle = 0;
let watchdogHandle = 0;
let last = 0;
let fallbackFps = 60;
let starved = false;

function emit(now: number): void {
  const dt = last === 0 ? 0 : now - last;
  last = now;
  for (const fn of subs) {
    try {
      fn(dt, now);
    } catch (err) {
      console.error('[ticker] subscriber failed', err);
    }
  }
}

function armWatchdog(): void {
  clearTimeout(watchdogHandle);
  watchdogHandle = window.setTimeout(() => {
    if (mode !== 'raf') return;
    console.warn('[ticker] requestAnimationFrame starved, switching to a timer');
    starved = true;
    cancelAnimationFrame(rafHandle);
    startInterval();
  }, STARVATION_MS);
}

function rafStep(now: number): void {
  armWatchdog();
  emit(now);
  if (mode === 'raf') rafHandle = requestAnimationFrame(rafStep);
}

function startInterval(): void {
  mode = 'interval';
  intervalHandle = window.setInterval(() => emit(performance.now()), 1000 / fallbackFps);
}

function start(): void {
  if (mode !== 'idle') return;
  last = 0;
  // A window that starved once will starve again; don't re-probe every time.
  if (starved) {
    startInterval();
    return;
  }
  mode = 'raf';
  armWatchdog();
  rafHandle = requestAnimationFrame(rafStep);
}

function stop(): void {
  cancelAnimationFrame(rafHandle);
  clearInterval(intervalHandle);
  clearTimeout(watchdogHandle);
  mode = 'idle';
  last = 0;
}

export function configureTicker(targetFps: number): void {
  fallbackFps = targetFps > 0 ? targetFps : 60;
}

export function onTick(fn: TickFn): () => void {
  subs.add(fn);
  start();
  return () => {
    subs.delete(fn);
    if (subs.size === 0) stop();
  };
}
