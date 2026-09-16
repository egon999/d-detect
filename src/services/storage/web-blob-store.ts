/**
 * Web-only blob store for evidence originals, backed by IndexedDB.
 *
 * ## Why this file exists at all
 *
 * `expo-file-system` documents Android, iOS and tvOS. There is no `Paths.document` on web,
 * so the native store in `./evidence-storage.ts` has nothing to write to when the app runs
 * under `react-native-web`. The three alternatives and why they lose:
 *
 * - **In-memory `Map`.** Survives navigation, dies on reload. An evidence record would then
 *   point at a file that no longer exists, which is worse than not storing it: the app would
 *   show a case with sources it cannot open.
 * - **`localStorage`.** Strings only, so bytes have to be base64'd (a third larger), and the
 *   quota is typically 5 MB total. One phone photo exceeds it.
 * - **The Origin Private File System** (`navigator.storage.getDirectory`). The best fit
 *   technically, but Safari shipped it late and Firefox's support for the synchronous access
 *   handle is partial. IndexedDB is available in every browser this app could plausibly be
 *   demonstrated in.
 *
 * So: IndexedDB, one object store, keyed by the same logical storage path the native side
 * uses. Blobs are a first-class IndexedDB value type — no base64, no size ceiling beyond the
 * origin quota.
 *
 * ## What this does not do
 *
 * It does not encrypt. Neither does the native store — both rely on the platform's own
 * isolation (the app sandbox on a phone, the origin on the web). Anyone with the unlocked
 * device and the browser profile can read it, exactly as they could read the user's
 * downloads folder. Saying so plainly here is the point; a comment claiming encryption where
 * there is none would be worse than no comment.
 */

const DB_NAME = 'ddetect-evidence';
const DB_VERSION = 1;
const STORE = 'originals';

/** Opens (and on first use, creates) the database. */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser cannot store evidence files locally. Try Chrome, Edge, Safari or Firefox.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // A private-browsing window can refuse to open a database at all.
    request.onerror = () =>
      reject(new Error('Local file storage is unavailable in this browser window. A private window blocks it.'));
    request.onblocked = () => reject(new Error('Another tab of this app is upgrading its storage. Close it and retry.'));
  });
}

/** Wraps one request in a transaction, so callers never juggle event handlers. */
async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('The file could not be written to local storage.'));
      // A quota failure surfaces on the transaction, not the request.
      tx.onabort = () =>
        reject(
          tx.error?.name === 'QuotaExceededError'
            ? new Error('This browser is out of storage for evidence files. Remove some cases and try again.')
            : (tx.error ?? new Error('The local storage transaction failed.')),
        );
    });
  } finally {
    db.close();
  }
}

export async function putWebBlob(path: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  // Copy into a fresh buffer: `bytes` may be a view onto a larger pooled ArrayBuffer, and
  // Blob would then capture the whole thing.
  const blob = new Blob([bytes.slice()], { type: mimeType || 'application/octet-stream' });
  await transact('readwrite', (store) => store.put(blob, path) as IDBRequest<IDBValidKey>);
}

export async function getWebBlob(path: string): Promise<Blob | null> {
  const value = await transact('readonly', (store) => store.get(path) as IDBRequest<unknown>);
  return value instanceof Blob ? value : null;
}

export async function deleteWebBlob(path: string): Promise<void> {
  await transact('readwrite', (store) => store.delete(path) as IDBRequest<undefined>);
}

/**
 * Empties the store.
 *
 * `store.clear()` rather than `indexedDB.deleteDatabase(DB_NAME)`: deleting the database
 * blocks on every other tab that still holds it open, so a second tab of the app would leave
 * the user staring at a wipe that never completes. Clearing the object store takes effect
 * immediately and leaves the schema in place for the next write.
 */
export async function clearWebBlobs(): Promise<void> {
  await transact('readwrite', (store) => store.clear() as IDBRequest<undefined>);
}

/** Total bytes held, for the storage figure shown in settings. */
export async function webBlobUsage(): Promise<number> {
  const values = await transact('readonly', (store) => store.getAll() as IDBRequest<unknown[]>);
  return values.reduce<number>((total, value) => total + (value instanceof Blob ? value.size : 0), 0);
}
