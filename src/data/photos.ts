import { publish, subscribe } from '../core/bus';
import { readDisplayMetrics } from '../core/display';

const DB_NAME = 'kraken-lcd';
const DB_VERSION = 1;
const STORE_PHOTOS = 'photos';
const STORE_META = 'meta';
const ORDER_KEY = 'order';
const BUS_TYPE = 'photos';

const QUALITY = 0.85;
/** Cover, not fit: a letterboxed photo would show black bars on a round panel.
 *  The long edge is capped so a panorama can't balloon the store. */
const LONG_EDGE_CAP = 1.5;

export interface PhotoMeta {
  id: string;
  width: number;
  height: number;
  bytes: number;
  addedAt: number;
}

interface PhotoRecord extends PhotoMeta {
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PHOTOS)) db.createObjectStore(STORE_PHOTOS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(stores, mode);
        let result: T;
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        Promise.resolve(run(transaction)).then(
          (value) => (result = value),
          (err) => {
            transaction.abort();
            reject(err);
          },
        );
      }),
  );
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ------------------------------------------------------------------ encoding

async function decode(file: File): Promise<ImageBitmap> {
  // `from-image` applies the EXIF rotation phone photos carry.
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

async function encode(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await decode(file);
  try {
    const target = readDisplayMetrics().size;
    const short = Math.min(bitmap.width, bitmap.height);
    const scale = Math.min(1, target / short);
    let width = Math.round(bitmap.width * scale);
    let height = Math.round(bitmap.height * scale);

    const cap = Math.round(target * LONG_EDGE_CAP);
    const cropW = Math.min(width, cap);
    const cropH = Math.min(height, cap);

    const canvas = document.createElement('canvas');
    canvas.width = cropW;
    canvas.height = cropH;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2D context unavailable');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, Math.round((cropW - width) / 2), Math.round((cropH - height) / 2), width, height);
    width = cropW;
    height = cropH;

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', QUALITY));
    if (!blob) throw new Error('WebP encoding failed');
    return { blob, width, height };
  } finally {
    bitmap.close();
  }
}

// ------------------------------------------------------------------- queries

async function readOrder(transaction: IDBTransaction): Promise<string[]> {
  const stored = await request<string[] | undefined>(transaction.objectStore(STORE_META).get(ORDER_KEY));
  return stored ?? [];
}

export async function listPhotos(): Promise<PhotoMeta[]> {
  return tx([STORE_PHOTOS, STORE_META], 'readonly', async (transaction) => {
    const order = await readOrder(transaction);
    const records = await request<PhotoRecord[]>(transaction.objectStore(STORE_PHOTOS).getAll());
    const byId = new Map(records.map((r) => [r.id, r]));
    const ordered = order.map((id) => byId.get(id)).filter((r): r is PhotoRecord => !!r);
    // Anything the order list lost (an interrupted write) still shows up.
    for (const record of records) if (!order.includes(record.id)) ordered.push(record);
    return ordered.map(({ blob: _blob, ...meta }) => meta);
  });
}

export async function getPhotoBlob(id: string): Promise<Blob | undefined> {
  return tx([STORE_PHOTOS], 'readonly', async (transaction) => {
    const record = await request<PhotoRecord | undefined>(transaction.objectStore(STORE_PHOTOS).get(id));
    return record?.blob;
  });
}

// ------------------------------------------------------------------ mutation

export async function addPhotos(files: File[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const images = files.filter((f) => f.type.startsWith('image/'));
  let added = 0;

  for (const file of images) {
    try {
      const { blob, width, height } = await encode(file);
      const record: PhotoRecord = {
        id: crypto.randomUUID(),
        blob,
        width,
        height,
        bytes: blob.size,
        addedAt: Date.now(),
      };
      await tx([STORE_PHOTOS, STORE_META], 'readwrite', async (transaction) => {
        transaction.objectStore(STORE_PHOTOS).put(record);
        const order = await readOrder(transaction);
        order.push(record.id);
        transaction.objectStore(STORE_META).put(order, ORDER_KEY);
      });
      added++;
    } catch (err) {
      console.error('[photos] could not import', file.name, err);
    }
    onProgress?.(added, images.length);
  }

  if (added) publish({ type: BUS_TYPE });
  return added;
}

export async function deletePhoto(id: string): Promise<void> {
  await tx([STORE_PHOTOS, STORE_META], 'readwrite', async (transaction) => {
    transaction.objectStore(STORE_PHOTOS).delete(id);
    const order = (await readOrder(transaction)).filter((existing) => existing !== id);
    transaction.objectStore(STORE_META).put(order, ORDER_KEY);
  });
  publish({ type: BUS_TYPE });
}

export async function setOrder(ids: string[]): Promise<void> {
  await tx([STORE_META], 'readwrite', (transaction) => {
    transaction.objectStore(STORE_META).put(ids, ORDER_KEY);
  });
  publish({ type: BUS_TYPE });
}

export async function storageUsed(): Promise<{ bytes: number; quota?: number }> {
  const photos = await listPhotos();
  const bytes = photos.reduce((sum, p) => sum + p.bytes, 0);
  try {
    const estimate = await navigator.storage?.estimate?.();
    return { bytes, quota: estimate?.quota };
  } catch {
    return { bytes };
  }
}

export function onPhotosChange(fn: () => void): () => void {
  return subscribe((msg) => {
    if (msg.type === BUS_TYPE) fn();
  });
}
