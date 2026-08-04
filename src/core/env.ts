const params = new URLSearchParams(location.search);

/** CAM appends `?kraken=1` to the hidden window it streams to the panel. */
export const isKrakenWindow = params.get('kraken') === '1';

export const isMock = params.get('mock') === '1';

export function prefersReducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
