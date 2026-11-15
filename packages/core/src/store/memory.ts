import { SupersededError } from './types.js';
import type { ChunkStore, SessionRecord, StoredChunk } from './types.js';

/**
 * In-memory store, used when IndexedDB is unavailable (or by choice). Data does not survive a
 * reload. Values are cloned on the way in and out, so it behaves like IndexedDB.
 */
export class MemoryStore implements ChunkStore {
  readonly kind = 'memory';
  readonly #records = new Map<string, SessionRecord>();
  readonly #chunks = new Map<string, Map<string, StoredChunk[]>>();

  write(
    record: SessionRecord,
    chunks: readonly StoredChunk[],
    options: { takeover?: boolean } = {},
  ): Promise<void> {
    const existing = this.#records.get(record.id);
    if (existing && existing.writer !== record.writer && !options.takeover) {
      return Promise.reject(new SupersededError(record.id));
    }
    this.#records.set(record.id, structuredClone(record));
    for (const chunk of chunks) {
      let byStream = this.#chunks.get(chunk.sessionId);
      if (!byStream) {
        byStream = new Map();
        this.#chunks.set(chunk.sessionId, byStream);
      }
      let list = byStream.get(chunk.stream);
      if (!list) {
        list = [];
        byStream.set(chunk.stream, list);
      }
      const copy = structuredClone(chunk);
      const at = list.findIndex((c) => c.seq === copy.seq);
      if (at >= 0) list[at] = copy;
      else {
        list.push(copy);
        list.sort((a, b) => a.seq - b.seq);
      }
    }
    return Promise.resolve();
  }

  load(sessionId: string): Promise<SessionRecord | undefined> {
    const record = this.#records.get(sessionId);
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }

  async *chunks(sessionId: string, stream: string): AsyncIterable<StoredChunk> {
    const list = this.#chunks.get(sessionId)?.get(stream) ?? [];
    for (const chunk of [...list]) {
      await Promise.resolve();
      yield structuredClone(chunk);
    }
  }

  delete(sessionId: string): Promise<void> {
    this.#records.delete(sessionId);
    this.#chunks.delete(sessionId);
    return Promise.resolve();
  }

  close(): void {
    // Nothing to release.
  }
}
