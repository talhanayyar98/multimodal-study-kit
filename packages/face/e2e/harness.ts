/**
 * Privacy e2e harness page: a real study configuration (face + pointer + keyboard) with an upload
 * sink, plus a storage dump the test can inspect. Bundled by the e2e test with esbuild.
 */
import { bundleToZip, createSession } from '@mmstudykit/core';
import type { Session, Sink } from '@mmstudykit/core';
import { face } from '@mmstudykit/face';
import { keyboard } from '@mmstudykit/sensors/keyboard';
import { pointer } from '@mmstudykit/sensors/pointer';

const uploadSink: Sink = {
  name: 'upload',
  async onEnd(bundle) {
    const zip = await bundleToZip(bundle);
    const res = await fetch('/upload', {
      method: 'POST',
      body: zip,
      headers: { 'content-type': 'application/zip' },
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  },
};

let session: Session | null = null;

type Dumped = unknown;

/** JSON-safe copy of a stored value; binary objects become markers the test can flag. */
function dump(value: unknown, depth = 0): Dumped {
  if (depth > 12) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return {
      __binary: value.constructor.name,
      bytes: bytes.length,
      head: Array.from(bytes.slice(0, 16)),
    };
  }
  if (value instanceof Blob) return { __binary: 'Blob', bytes: value.size, head: [] };
  if (Array.isArray(value)) return value.map((v) => dump(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, dump(v, depth + 1)]));
}

async function idbDump(): Promise<Record<string, Dumped>> {
  const out: Record<string, Dumped> = {};
  const dbs =
    typeof indexedDB.databases === 'function'
      ? await indexedDB.databases()
      : [{ name: 'mmstudykit' }];
  for (const { name } of dbs) {
    if (!name) continue;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error('open failed'));
      };
    });
    for (const store of db.objectStoreNames) {
      const all = await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => {
          resolve(req.result as unknown[]);
        };
        req.onerror = () => {
          reject(req.error ?? new Error('getAll failed'));
        };
      });
      out[`${name}/${store}`] = dump(all);
    }
    db.close();
  }
  return out;
}

async function cacheDump(): Promise<Record<string, Dumped>> {
  const out: Record<string, Dumped> = {};
  if (typeof caches === 'undefined') return out;
  for (const key of await caches.keys()) {
    const cache = await caches.open(key);
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      out[`${key} ${req.url}`] = res ? dump(new Uint8Array(await res.arrayBuffer())) : null;
    }
  }
  return out;
}

function entries(storage: Storage): Record<string, string | null> {
  return Object.fromEntries(Object.keys(storage).map((k) => [k, storage.getItem(k)]));
}

async function opfsDump(): Promise<string[]> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof storage.getDirectory !== 'function') return [];
  const root = await storage.getDirectory();
  const names: string[] = [];
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys())
    names.push(name);
  return names;
}

Object.assign(window, {
  harness: {
    async start(participantId: string) {
      session = await createSession({
        studyId: 'privacy-e2e',
        participantId,
        sensors: [face({ fps: 15 }), pointer(), keyboard()],
        sinks: [uploadSink],
      });
      await session.consent({ textVersion: 'e2e-1', granted: ['face', 'pointer', 'keyboard'] });
      return session.start();
    },
    async end() {
      if (!session) throw new Error('not started');
      const r = await session.end();
      return { sinks: r.sinks, localDataDeleted: r.localDataDeleted };
    },
    async storage() {
      if (session?.state === 'running') await session.flush();
      return {
        indexedDB: await idbDump(),
        localStorage: entries(localStorage),
        sessionStorage: entries(sessionStorage),
        caches: await cacheDump(),
        opfs: await opfsDump(),
      };
    },
  },
});
document.body.dataset.ready = '1';
