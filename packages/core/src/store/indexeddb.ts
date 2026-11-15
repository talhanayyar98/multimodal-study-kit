import { SupersededError } from './types.js';
import type { ChunkStore, SessionRecord, StoredChunk } from './types.js';

export const DB_NAME = 'mmstudykit';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const CHUNKS = 'chunks';
/** Chunks fetched per read. At ≤ 2,000 rows per chunk this bounds a page to ~32k rows. */
const PAGE = 16;
const OPEN_TIMEOUT_MS = 5000;

/**
 * Open the IndexedDB store, or resolve `null` if IndexedDB is unavailable or doesn't open in
 * time (some browsers' private modes, blocked storage, sandboxed iframes). The caller then falls
 * back to memory and records that in `manifest.environment.persistence`.
 */
export async function openIndexedDbStore(dbName = DB_NAME): Promise<IndexedDbStore | null> {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) return null;
  try {
    const db = await withTimeout(
      new Promise<IDBDatabase>((resolve, reject) => {
        const req = factory.open(dbName, DB_VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(SESSIONS))
            d.createObjectStore(SESSIONS, { keyPath: 'id' });
          if (!d.objectStoreNames.contains(CHUNKS)) {
            d.createObjectStore(CHUNKS, { keyPath: ['sessionId', 'stream', 'seq'] });
          }
        };
        req.onsuccess = () => {
          resolve(req.result);
        };
        req.onerror = () => {
          reject(req.error ?? new Error('indexedDB.open failed'));
        };
      }),
      OPEN_TIMEOUT_MS,
    );
    db.onversionchange = () => {
      db.close();
    };
    return new IndexedDbStore(db);
  } catch {
    return null;
  }
}

export class IndexedDbStore implements ChunkStore {
  readonly kind = 'indexeddb';
  readonly #db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.#db = db;
  }

  async write(
    record: SessionRecord,
    chunks: readonly StoredChunk[],
    options: { takeover?: boolean } = {},
  ): Promise<void> {
    const tx = this.#db.transaction([SESSIONS, CHUNKS], 'readwrite');
    const sessions = tx.objectStore(SESSIONS);
    const outcome = { superseded: false };
    // Check the writer and write in the same transaction, so a stale page can't interleave.
    const check = sessions.get(record.id);
    check.onsuccess = () => {
      const existing = check.result as SessionRecord | undefined;
      if (existing && existing.writer !== record.writer && !options.takeover) {
        outcome.superseded = true;
        tx.abort();
        return;
      }
      sessions.put(record);
      const store = tx.objectStore(CHUNKS);
      for (const chunk of chunks) store.put(chunk);
    };
    try {
      await done(tx);
    } catch (error) {
      if (outcome.superseded) throw new SupersededError(record.id);
      throw error;
    }
  }

  async load(sessionId: string): Promise<SessionRecord | undefined> {
    const tx = this.#db.transaction(SESSIONS, 'readonly');
    const value: unknown = await request(tx.objectStore(SESSIONS).get(sessionId));
    return value as SessionRecord | undefined;
  }

  async *chunks(sessionId: string, stream: string): AsyncIterable<StoredChunk> {
    let from = 0;
    for (;;) {
      const tx = this.#db.transaction(CHUNKS, 'readonly');
      const range = IDBKeyRange.bound([sessionId, stream, from], [sessionId, stream, Infinity]);
      const page = (await request(tx.objectStore(CHUNKS).getAll(range, PAGE))) as StoredChunk[];
      // Yield only after the transaction's request settled; the consumer may await between items.
      for (const chunk of page) yield chunk;
      const last = page.at(-1);
      if (page.length < PAGE || !last) return;
      from = last.seq + 1;
    }
  }

  delete(sessionId: string): Promise<void> {
    const tx = this.#db.transaction([SESSIONS, CHUNKS], 'readwrite');
    tx.objectStore(SESSIONS).delete(sessionId);
    // Arrays sort after strings and numbers, so [id, []] is above every [id, stream, seq].
    tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([sessionId], [sessionId, []]));
    return done(tx);
  }

  close(): void {
    this.#db.close();
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
