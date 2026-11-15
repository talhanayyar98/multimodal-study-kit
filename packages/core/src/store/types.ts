import type { ClockState, LastSeen } from '../clock.js';
import type {
  ConsentRecord,
  EnvironmentInfo,
  PrivacyFlags,
  SensorInfo,
  SessionMs,
} from '../manifest.js';
import type { ResolvedStream } from '../streams.js';

/** Session lifecycle states that are persisted. Withdrawn sessions keep no stored record. */
export type PersistedState = 'consented' | 'running' | 'paused' | 'ended';

/**
 * Everything needed to rebuild a session after a reload and to write its manifest. One record per
 * session, rewritten atomically with each flush of chunks.
 */
export interface SessionRecord {
  v: 1;
  id: string;
  /**
   * Random id of the page (Session instance) allowed to write this record. A resumed session
   * takes over; a stale page (e.g. restored from the back/forward cache) is then rejected.
   */
  writer: string;
  studyId: string;
  studyVersion: string | null;
  participantId: string;
  state: PersistedState;
  /** ISO time of the first `start()`, null before. */
  startedAt: string | null;
  endedAt: string | null;
  consent: ConsentRecord;
  clock: ClockState | null;
  lastSeen: LastSeen | null;
  crossOriginIsolated: boolean;
  measuredResolutionMs: number | null;
  pauses: { startT: SessionMs; endT: SessionMs | null }[];
  sensors: SensorInfo[];
  privacy: PrivacyFlags;
  environment: Omit<EnvironmentInfo, 'persistence'>;
  quality: Record<string, Record<string, unknown>>;
  /** Registered streams in registration order, with the next chunk sequence number. */
  streams: { spec: ResolvedStream; nextSeq: number }[];
}

/** An immutable block of rows of one stream. Rows are arrays in column order (`t` first). */
export interface StoredChunk {
  sessionId: string;
  stream: string;
  seq: number;
  rows: unknown[][];
}

/** Thrown by `ChunkStore.write` when another page has taken over the session. */
export class SupersededError extends Error {
  override readonly name = 'SupersededError';
  constructor(sessionId: string) {
    super(`session ${sessionId} was resumed by another page; this page no longer writes to it`);
  }
}

/** Durable (or not) storage for session records and chunks. */
export interface ChunkStore {
  readonly kind: 'indexeddb' | 'memory';
  /**
   * Write the session record and any new chunks in one atomic transaction. Rejects with
   * {@link SupersededError} if the stored record belongs to a different writer, unless
   * `takeover` is set (used once, when a session is resumed).
   */
  write(
    record: SessionRecord,
    chunks: readonly StoredChunk[],
    options?: { takeover?: boolean },
  ): Promise<void>;
  load(sessionId: string): Promise<SessionRecord | undefined>;
  /** Chunks of one stream in sequence order, read in pages so memory stays bounded. */
  chunks(sessionId: string, stream: string): AsyncIterable<StoredChunk>;
  /** Delete the record and every chunk of a session. */
  delete(sessionId: string): Promise<void>;
  close(): void;
}
