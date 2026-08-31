/**
 * Minimal IndexedDB wrapper for the tokenizer dataset cache (G1: runtime
 * fetch + IndexedDB). One database `dsh-composer-tokens`, one object store
 * `datasets` keyed by family id; values are `Record<fileName, { text: string }>`
 * (plain JSON data — small enough per entry to skip binary blobs).
 * Every operation degrades to `null`/`false` on any failure (private mode,
 * quota, unavailability) — the loader then falls back to the network.
 */

const DB_NAME = "dsh-composer-tokens";
const STORE = "datasets";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

export interface DatasetValue {
  text: string;
}

export async function idbGet(key: string): Promise<Record<string, DatasetValue> | null> {
  const db = await openDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readonly");
    } catch {
      resolve(null);
      return;
    }
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      const value = req.result as Record<string, DatasetValue> | undefined;
      resolve(value === undefined ? null : value);
    };
    req.onerror = () => resolve(null);
  });
}

export async function idbPut(key: string, value: Record<string, DatasetValue>): Promise<boolean> {
  const db = await openDb();
  if (db === null) return false;
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve(false);
      return;
    }
    let ok = true;
    tx.onerror = () => {
      ok = false;
    };
    tx.onabort = () => {
      ok = false;
    };
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(ok);
  });
}