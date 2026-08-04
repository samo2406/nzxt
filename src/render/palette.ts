import { loadImage } from '../core/image';

const FALLBACK: CoverAnalysis = { accent: '#6b7a8f', ink: 'light' };
const SAMPLE = 16;

export interface CoverAnalysis {
  accent: string;
  /** Ink that stays readable over the cover's outer region. */
  ink: 'light' | 'dark';
}

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
 * Accent colour plus an ink choice for text drawn over the cover. The disc
 * rotates under the text, so the ink is judged on the annulus that passes
 * behind it — every rotation shows a different slice of that ring, never the
 * centre. A cross-origin failure must never blank the screen, so every step
 * is guarded and the fallback is a neutral slate with light ink.
 */
export async function analyzeCover(url: string): Promise<CoverAnalysis> {
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
    let ringLuma = 0;
    let ringCount = 0;
    const centre = (SAMPLE - 1) / 2;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const px = (i / 4) % SAMPLE;
      const py = Math.floor(i / 4 / SAMPLE);
      const radial = Math.hypot(px - centre, py - centre) / centre;
      // The band the text actually sits over as the disc turns.
      if (radial >= 0.4 && radial <= 0.95) {
        ringLuma += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        ringCount++;
      }

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

    const ink = ringCount > 0 && ringLuma / ringCount / 255 > 0.55 ? 'dark' : 'light';
    if (!best) return { ...FALLBACK, ink };

    const s = Math.min(0.9, Math.max(0.42, best.peak.s));
    const l = Math.min(0.66, Math.max(0.46, best.peak.l));
    return { accent: `hsl(${best.peak.h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`, ink };
  } catch {
    return FALLBACK;
  }
}
