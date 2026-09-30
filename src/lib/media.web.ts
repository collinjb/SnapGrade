/** Image and file storage, web implementation.
 *
 *  The browser has no cache directory, so pages live in IndexedDB keyed by a
 *  `sg://` URI and are handed to <img> as object URLs. IndexedDB rather than
 *  memory because the pending queue is persisted: a stack captured on a bad
 *  connection has to survive the tab being reloaded, which is exactly when a
 *  blob URL would already be dead. */

const DB_NAME = 'snapgrade-media';
const STORE = 'files';
const SCHEME = 'sg://';

/** Web URIs need resolving to an object URL before an <Image> can show them. */
export const mediaUrisAreDirect = false;

/** Object URLs we have handed out, so repeat renders do not leak new ones. */
const objectUrls = new Map<string, string>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      // Private browsing and blocked site data both land here; the app still
      // works, it just cannot keep pages across a reload.
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(STORE, mode);
          const request = run(tx.objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

const keyOf = (uri: string): string => (uri.startsWith(SCHEME) ? uri.slice(SCHEME.length) : uri);

/** Fallback store for when IndexedDB is unavailable: at least the current
 *  session keeps working. */
const memory = new Map<string, Blob>();

async function putBlob(key: string, blob: Blob): Promise<void> {
  memory.set(key, blob);
  await withStore('readwrite', (store) => store.put(blob, key) as IDBRequest<IDBValidKey>);
}

async function getBlob(key: string): Promise<Blob | null> {
  const cached = memory.get(key);
  if (cached) return cached;
  const stored = await withStore<Blob>('readonly', (store) => store.get(key) as IDBRequest<Blob>);
  if (stored) memory.set(key, stored);
  return stored ?? null;
}

export async function saveJpegBytes(bytes: Uint8Array, tag: string): Promise<string> {
  const key = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
  // Copy into a fresh ArrayBuffer: the caller's view may be over a pooled
  // buffer that gets reused for the next frame.
  await putBlob(key, new Blob([bytes.slice()], { type: 'image/jpeg' }));
  return SCHEME + key;
}

/** Store a Blob the browser already has (a canvas export, a file input). */
export async function saveBlob(blob: Blob, tag: string): Promise<string> {
  const key = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
  await putBlob(key, blob);
  return SCHEME + key;
}

export async function readBytes(uri: string): Promise<Uint8Array | null> {
  const blob = await getBlob(keyOf(uri));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

export async function readBase64(uri: string): Promise<string | null> {
  const blob = await getBlob(keyOf(uri));
  if (!blob) return null;
  return new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      // Strip the "data:image/jpeg;base64," prefix the API insists on.
      const comma = result.indexOf(',');
      resolve(comma === -1 ? null : result.slice(comma + 1));
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export async function mediaExists(uri: string): Promise<boolean> {
  return (await getBlob(keyOf(uri))) !== null;
}

export async function removeMedia(uri: string): Promise<void> {
  const key = keyOf(uri);
  const url = objectUrls.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(key);
  }
  memory.delete(key);
  await withStore('readwrite', (store) => store.delete(key) as IDBRequest<undefined>);
}

/** Resolve a `sg://` URI into an object URL an <img> can load. */
export async function resolveDisplayUri(uri: string): Promise<string | null> {
  if (!uri.startsWith(SCHEME)) return uri; // already a blob:/data:/http: URL
  const key = keyOf(uri);

  const existing = objectUrls.get(key);
  if (existing) return existing;

  const blob = await getBlob(key);
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

/**
 * Hand the user a file. The Web Share API is used where it exists — on iOS
 * and Android that is the real share sheet, same as native — and otherwise
 * we fall back to a plain download.
 */
export async function saveTextAndShare(
  fileName: string,
  text: string,
  mimeType: string,
  dialogTitle: string,
): Promise<string> {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const file = new File([blob], fileName, { type: mimeType });

  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };

  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: dialogTitle });
      return fileName;
    } catch (e) {
      // A cancelled share is not a failure; anything else falls through to
      // the download path below.
      if (e instanceof DOMException && e.name === 'AbortError') return fileName;
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the download a moment to start before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  return fileName;
}
