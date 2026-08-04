import { loadImage } from '../core/image';

const FALLBACK = '#6b7a8f';
const SAMPLE = 16;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / delta + 2) / 6;
  else h = ((rn - gn) / delta + 4) / 6;
  return { h: h * 360, s, l };
}

/**
 * Picks a single accent from the cover for the progress arc. A cross-origin
 * failure here must never blank the screen, so every step is guarded and the
 * fallback is a neutral slate.
 */
export async function accentFrom(url: string): Promise<string> {
  try {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    await loadImage(image, url, 0);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SAMPLE;
    const g = canvas.getContext('2d', { willReadFrequently: false });
    if (!g) return FALLBACK;
    g.drawImage(image, 0, 0, SAMPLE, SAMPLE);

    const { data } = g.getImageData(0, 0, SAMPLE, SAMPLE);
    interface Bucket {
      count: number;
      sumS: number;
      /** Most saturated member; averaging a bucket washes the colour out. */
      peak: Hsl;
    }
    const buckets = new Map<number, Bucket>();

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const hsl = toHsl(data[i], data[i + 1], data[i + 2]);
      // Near-black and near-white carry no usable hue.
      if (hsl.l < 0.12 || hsl.l > 0.94) continue;
      const key = Math.round(hsl.h / 24);
      const bucket = buckets.get(key);
      if (!bucket) {
        buckets.set(key, { count: 1, sumS: hsl.s, peak: hsl });
        continue;
      }
      bucket.count++;
      bucket.sumS += hsl.s;
      if (hsl.s > bucket.peak.s) bucket.peak = hsl;
    }

    let best: Bucket | null = null;
    let bestScore = 0;
    for (const bucket of buckets.values()) {
      // Favour a hue that is both well represented and genuinely colourful.
      const score = bucket.count * (0.25 + bucket.sumS / bucket.count);
      if (score > bestScore) {
        bestScore = score;
        best = bucket;
      }
    }
    if (!best) return FALLBACK;

    const s = Math.min(0.9, Math.max(0.42, best.peak.s));
    const l = Math.min(0.66, Math.max(0.46, best.peak.l));
    return `hsl(${best.peak.h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;
  } catch {
    return FALLBACK;
  }
}
