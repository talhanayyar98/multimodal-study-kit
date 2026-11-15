import type { ChunkStore, SessionRecord, StoredChunk } from './store/types.js';

export interface RecorderOptions {
  /** Flush buffered rows at least this often (ms). Default 2000. */
  flushIntervalMs?: number;
  /** Flush a stream once it has this many buffered rows. Default 2000. */
  flushRows?: number;
}

/**
 * Buffers rows per stream in memory and flushes them to the store as immutable, numbered chunks.
 *
 * Every flush writes the session record (stream sequence numbers, clock state, last-seen time)
 * and the new chunks in one transaction, so after a crash or reload the record always describes
 * exactly the chunks that exist. Flushes are serialized. If a write fails, its chunks are kept
 * and retried on the next flush.
 */
export class Recorder {
  readonly #store: ChunkStore;
  readonly #snapshot: () => SessionRecord;
  readonly #onError: (error: unknown) => void;
  readonly #flushRows: number;
  readonly #flushIntervalMs: number;
  readonly #buffers = new Map<string, unknown[][]>();
  readonly #nextSeq = new Map<string, number>();
  /** Chunks cut but not yet durably written (a failed write leaves them here). */
  #pending: StoredChunk[] = [];
  /** Chunks of the write currently in progress. */
  #inflight: StoredChunk[] = [];
  #onWritten: (() => void) | null = null;
  #queue: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #sessionId: string;
  #closed = false;

  constructor(
    store: ChunkStore,
    sessionId: string,
    snapshot: () => SessionRecord,
    onError: (error: unknown) => void,
    options: RecorderOptions = {},
  ) {
    this.#store = store;
    this.#sessionId = sessionId;
    this.#snapshot = snapshot;
    this.#onError = onError;
    this.#flushRows = options.flushRows ?? 2000;
    this.#flushIntervalMs = options.flushIntervalMs ?? 2000;
  }

  get store(): ChunkStore {
    return this.#store;
  }

  /** Called after every successful write (used to drop the unload spill once it's redundant). */
  set onWritten(fn: (() => void) | null) {
    this.#onWritten = fn;
  }

  /** Register a stream, continuing its sequence numbering after a reload. */
  register(stream: string, nextSeq = 0): void {
    if (!this.#buffers.has(stream)) this.#buffers.set(stream, []);
    this.#nextSeq.set(stream, Math.max(nextSeq, this.#nextSeq.get(stream) ?? 0));
  }

  /** Sequence number the next chunk of `stream` will get (persisted in the session record). */
  nextSeq(stream: string): number {
    return this.#nextSeq.get(stream) ?? 0;
  }

  append(stream: string, row: unknown[]): void {
    if (this.#closed) return;
    const buffer = this.#buffers.get(stream);
    if (!buffer) throw new Error(`recorder: unknown stream "${stream}"`);
    buffer.push(row);
    if (buffer.length >= this.#flushRows) void this.flush();
  }

  /** Buffered rows not yet handed to the store (for tests and diagnostics). */
  bufferedRows(): number {
    let n = 0;
    for (const b of this.#buffers.values()) n += b.length;
    return n + this.#pending.reduce((sum, c) => sum + c.rows.length, 0);
  }

  startTimer(): void {
    this.stopTimer();
    this.#timer = setInterval(() => void this.flush(), this.#flushIntervalMs);
  }

  stopTimer(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Cut chunks from all non-empty buffers and write them with a fresh session record. Resolves
   * when this flush is written (or has failed and been reported via `onError`).
   */
  flush(): Promise<void> {
    this.#cut();
    const run = async (): Promise<void> => {
      if (this.#closed) return;
      const chunks = this.#pending;
      this.#pending = [];
      this.#inflight = chunks;
      try {
        await this.#store.write(this.#snapshot(), chunks);
        this.#inflight = [];
        this.#onWritten?.();
      } catch (error) {
        this.#inflight = [];
        this.#pending = [...chunks, ...this.#pending];
        this.#onError(error);
      }
    };
    this.#queue = this.#queue.then(run);
    return this.#queue;
  }

  /**
   * Every chunk not yet known to be durably written: in flight, pending, and freshly cut from the
   * buffers. Synchronous, for the unload spill: an IndexedDB transaction still running when the
   * page unloads is aborted (IndexedDB spec, "close a database connection" with forced flag).
   */
  unsaved(): StoredChunk[] {
    this.#cut();
    return [...this.#inflight, ...this.#pending];
  }

  /** Move buffered rows into numbered pending chunks. Rows appended later go into the next cut. */
  #cut(): void {
    for (const [stream, rows] of this.#buffers) {
      if (!rows.length) continue;
      const seq = this.#nextSeq.get(stream) ?? 0;
      this.#nextSeq.set(stream, seq + 1);
      this.#pending.push({ sessionId: this.#sessionId, stream, seq, rows });
      this.#buffers.set(stream, []);
    }
  }

  /** Drop everything buffered and stop accepting rows (withdrawal). */
  discard(): void {
    this.#closed = true;
    this.stopTimer();
    this.#pending = [];
    this.#inflight = [];
    for (const stream of this.#buffers.keys()) this.#buffers.set(stream, []);
  }

  /** Wait for in-flight writes. */
  idle(): Promise<void> {
    return this.#queue;
  }
}
