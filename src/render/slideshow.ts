import { loadImage } from '../core/image';
import { getPhotoBlob, listPhotos, onPhotosChange, type PhotoMeta } from '../data/photos';
import type { Settings } from '../data/settings';
import type { ScreenView } from './screen';
import '../styles/slideshow.css';

interface Slot {
  el: HTMLImageElement;
  url: string | null;
}

/**
 * Two stacked images crossfading on a timer. The next photo is decoded before
 * the fade starts so it never pops in, and every object URL is revoked once its
 * slot is retired — this runs for weeks without a reload, so a leak here is
 * fatal rather than untidy.
 */
export class SlideshowView implements ScreenView {
  readonly el: HTMLElement;
  private readonly slots: [Slot, Slot];
  private readonly empty: HTMLElement;
  private front = 0;
  private timer = 0;
  private photos: PhotoMeta[] = [];
  private queue: string[] = [];
  private active = false;
  private advancing = false;
  private settings: Settings;
  private readonly unsubscribe: () => void;

  constructor(
    settings: Settings,
    private readonly onInk?: (ink: 'light' | 'dark') => void,
  ) {
    this.settings = settings;
    this.el = document.createElement('div');
    this.el.className = 'slideshow';

    this.slots = [this.createSlot(), this.createSlot()];
    this.slots[0].el.dataset.front = 'true';

    this.empty = document.createElement('div');
    this.empty.className = 'slideshow__empty';
    this.empty.textContent = 'Pridajte fotky v okne konfigurácie';
    this.el.append(this.empty);

    this.applySettings(settings);
    this.unsubscribe = onPhotosChange(() => void this.reload());
    void this.reload();
  }

  private createSlot(): Slot {
    const img = document.createElement('img');
    img.className = 'slideshow__img';
    img.decoding = 'async';
    img.dataset.front = 'false';
    this.el.append(img);
    return { el: img, url: null };
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.el.style.setProperty('--crossfade', `${settings.slideshow.crossfadeMs}ms`);
    this.el.dataset.kenburns = settings.slideshow.kenBurns ? 'true' : 'false';
    if (this.active) this.schedule();
  }

  private async reload(): Promise<void> {
    this.photos = await listPhotos();
    this.queue = [];
    this.empty.dataset.on = this.photos.length === 0 ? 'true' : 'false';
    if (this.photos.length === 0) this.onInk?.('light');

    // A first photo added while the LCD is already showing this screen should
    // appear straight away rather than after a full interval.
    if (this.active && this.photos.length && !this.slots[this.front].url) {
      await this.advance();
    }
    if (this.active) this.schedule();
  }

  private nextId(): string | null {
    if (this.photos.length === 0) return null;
    if (this.photos.length === 1) return this.photos[0].id;

    if (this.queue.length === 0) {
      const ids = this.photos.map((p) => p.id);
      if (this.settings.slideshow.shuffle) {
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        // Avoid showing the same photo twice across a reshuffle boundary.
        const current = this.slots[this.front].el.dataset.photoId;
        if (ids[0] === current) [ids[0], ids[1]] = [ids[1], ids[0]];
      }
      this.queue = ids;
    }
    return this.queue.shift() ?? null;
  }

  private async advance(): Promise<void> {
    if (this.advancing) return;
    const id = this.nextId();
    if (!id) return;

    this.advancing = true;
    let url: string | null = null;
    try {
      const blob = await getPhotoBlob(id);
      if (!blob) return;

      const back = this.slots[1 - this.front];
      url = URL.createObjectURL(blob);
      back.el.dataset.photoId = id;
      await loadImage(back.el, url);
      if (!this.active && this.slots[this.front].url) return;

      const retired = this.slots[this.front];
      back.url = url;
      url = null;
      back.el.dataset.front = 'true';
      retired.el.dataset.front = 'false';
      this.front = 1 - this.front;
      this.onInk?.(this.sampleInk(back.el));
      this.retire(retired);
    } catch (err) {
      console.error('[slideshow] could not show photo', err);
    } finally {
      if (url) URL.revokeObjectURL(url);
      this.advancing = false;
    }
  }

  /**
   * The overlay (clock, temperatures) sits over the top half of the photo, so
   * the ink is judged on the top band of the same centre-square crop that
   * object-fit: cover displays. Photos are same-origin blobs, so the canvas
   * never taints; a decode oddity falls back to light ink on the shadowed side.
   */
  private sampleInk(img: HTMLImageElement): 'light' | 'dark' {
    try {
      const S = 24;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) return 'light';

      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = S;
      const g = canvas.getContext('2d');
      if (!g) return 'light';

      const side = Math.min(w, h);
      g.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, S, S);

      const rows = Math.floor(S * 0.45);
      const { data } = g.getImageData(0, 0, S, rows);
      let luma = 0;
      for (let i = 0; i < data.length; i += 4) {
        luma += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
      return luma / (data.length / 4) / 255 > 0.55 ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  /** Frees the faded-out slot once the crossfade has finished. */
  private retire(slot: Slot): void {
    const url = slot.url;
    if (!url) return;
    slot.url = null;
    setTimeout(() => {
      slot.el.removeAttribute('src');
      delete slot.el.dataset.photoId;
      URL.revokeObjectURL(url);
    }, this.settings.slideshow.crossfadeMs + 100);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.active || this.photos.length < 2) return;
    this.timer = window.setTimeout(() => {
      void this.advance().then(() => this.schedule());
    }, this.settings.slideshow.intervalMs);
  }

  activate(): void {
    this.active = true;
    if (!this.slots[this.front].url) void this.advance().then(() => this.schedule());
    else this.schedule();
  }

  deactivate(): void {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = 0;
  }

  destroy(): void {
    this.deactivate();
    this.unsubscribe();
    for (const slot of this.slots) {
      if (slot.url) URL.revokeObjectURL(slot.url);
      slot.url = null;
    }
    this.el.remove();
  }
}
