import {
  addPhotos,
  deletePhoto,
  getPhotoBlob,
  listPhotos,
  setOrder,
  storageUsed,
  type PhotoMeta,
} from '../data/photos';
import { formatBytes } from './controls';
import { el, section } from './dom';

export class PhotoPanel {
  readonly el: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly usage: HTMLElement;
  private readonly status: HTMLElement;
  private urls: string[] = [];
  private dragId: string | null = null;
  private order: string[] = [];

  constructor() {
    this.grid = el('div', { class: 'photos__grid' });
    this.usage = el('span', { class: 'photos__usage' });
    this.status = el('span', { class: 'photos__status' });

    const input = el('input', {
      class: 'photos__input',
      type: 'file',
      accept: 'image/*',
      multiple: true,
    }) as HTMLInputElement;

    const drop = el(
      'button',
      { class: 'photos__drop', type: 'button' },
      el('span', { text: 'Pretiahnite sem fotky alebo kliknite pre výber' }),
    );

    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      void this.import(Array.from(input.files ?? []));
      input.value = '';
    });

    for (const type of ['dragenter', 'dragover'] as const) {
      drop.addEventListener(type, (ev) => {
        ev.preventDefault();
        drop.dataset.over = 'true';
      });
    }
    for (const type of ['dragleave', 'drop'] as const) {
      drop.addEventListener(type, () => (drop.dataset.over = 'false'));
    }
    drop.addEventListener('drop', (ev) => {
      ev.preventDefault();
      void this.import(Array.from(ev.dataTransfer?.files ?? []));
    });

    this.el = section(
      'Fotografie',
      'Fotky sa zmenšia a uložia len v tomto prehliadači (IndexedDB). Nikam sa neodosielajú a nie sú v repozitári. Originály si nechajte na disku — reset profilu CAM ich vymaže.',
      drop,
      input,
      el('div', { class: 'photos__meta' }, this.usage, this.status),
      this.grid,
    );

    void this.render();
  }

  private async import(files: File[]): Promise<void> {
    if (files.length === 0) return;
    this.status.textContent = `Spracúvam 0/${files.length}…`;
    const added = await addPhotos(files, (done, total) => {
      this.status.textContent = `Spracúvam ${done}/${total}…`;
    });
    this.status.textContent = added === files.length ? '' : `${files.length - added} súborov sa nepodarilo načítať`;
    await this.render();
  }

  private releaseUrls(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
  }

  async render(): Promise<void> {
    const photos = await listPhotos();
    this.order = photos.map((p) => p.id);

    this.releaseUrls();
    this.grid.replaceChildren();

    if (photos.length === 0) {
      this.grid.append(el('p', { class: 'photos__none', text: 'Zatiaľ žiadne fotky.' }));
    } else {
      for (const photo of photos) this.grid.append(await this.tile(photo));
    }

    const { bytes, quota } = await storageUsed();
    const quotaText = quota ? ` z ~${formatBytes(quota)} dostupných` : '';
    this.usage.textContent = `${photos.length} ${plural(photos.length)} · ${formatBytes(bytes)}${quotaText}`;
  }

  private async tile(photo: PhotoMeta): Promise<HTMLElement> {
    const blob = await getPhotoBlob(photo.id);
    const tile = el('figure', { class: 'tile', draggable: true, 'data-id': photo.id });

    if (blob) {
      const url = URL.createObjectURL(blob);
      this.urls.push(url);
      const img = el('img', { class: 'tile__img', alt: '', src: url, loading: 'lazy' });
      tile.append(img);
    }

    const remove = el('button', { class: 'tile__remove', type: 'button', title: 'Odstrániť', text: '×' });
    remove.addEventListener('click', async () => {
      await deletePhoto(photo.id);
      await this.render();
    });
    tile.append(remove);

    tile.addEventListener('dragstart', (ev) => {
      this.dragId = photo.id;
      tile.dataset.dragging = 'true';
      ev.dataTransfer?.setData('text/plain', photo.id);
    });
    tile.addEventListener('dragend', () => {
      this.dragId = null;
      delete tile.dataset.dragging;
    });
    tile.addEventListener('dragover', (ev) => {
      if (!this.dragId || this.dragId === photo.id) return;
      ev.preventDefault();
      const box = tile.getBoundingClientRect();
      tile.dataset.drop = ev.clientX < box.left + box.width / 2 ? 'before' : 'after';
    });
    tile.addEventListener('dragleave', () => delete tile.dataset.drop);
    tile.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      const side = tile.dataset.drop;
      delete tile.dataset.drop;
      if (!this.dragId || this.dragId === photo.id) return;
      await this.move(this.dragId, photo.id, side === 'before');
    });

    return tile;
  }

  private async move(dragId: string, targetId: string, before: boolean): Promise<void> {
    const next = this.order.filter((id) => id !== dragId);
    const at = next.indexOf(targetId);
    if (at === -1) return;
    next.splice(before ? at : at + 1, 0, dragId);
    await setOrder(next);
    await this.render();
  }

  destroy(): void {
    this.releaseUrls();
  }
}

function plural(count: number): string {
  if (count === 1) return 'fotka';
  if (count >= 2 && count <= 4) return 'fotky';
  return 'fotiek';
}
