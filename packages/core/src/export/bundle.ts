import { MANIFEST_FORMAT, SCHEMA_VERSION } from '../manifest.js';
import type { SessionManifest, SessionStatus, StreamStats } from '../manifest.js';
import { streamInfo } from '../streams.js';
import type { ResolvedStream } from '../streams.js';
import type { ChunkStore, SessionRecord } from '../store/types.js';
import { CORE_PACKAGE, CORE_VERSION, TOOLKIT_NAME } from '../version.js';
import { csvHeader, csvRow, jsonlRow } from './encode.js';
import { StatsAccumulator } from './stats.js';

/** One stream file of a bundle, produced lazily from the store. */
export interface BundleFile {
  /** Path inside the bundle folder, e.g. `streams/pointer.move.csv`. */
  readonly path: string;
  readonly stream: string;
  /** File contents in pieces (header, then one piece per chunk). */
  text(): AsyncIterable<string>;
}

/**
 * A finished session, ready for sinks. Files are read from the store on demand, so a sink must
 * read them inside `onEnd`: once every sink succeeded, local data is deleted and reading throws.
 */
export interface SessionBundle {
  readonly sessionId: string;
  /** `session_<sessionId>`: the folder name inside the zip and the default download name. */
  readonly folderName: string;
  readonly manifest: SessionManifest;
  /** The stream files listed in `manifest.streams`, read lazily (the manifest is not included). */
  readonly files: readonly BundleFile[];
}

interface StreamPlan {
  stream: ResolvedStream;
  stats: StreamStats;
  /** Rows arrived out of time order (e.g. keystrokes complete at key-up); sort on export. */
  needsSort: boolean;
}

/** Build the bundle for a finished (or exported-early) session. Reads every stream once for stats. */
export async function buildBundle(
  store: ChunkStore,
  record: SessionRecord,
  status: Exclude<SessionStatus, 'withdrawn'>,
  readable: () => boolean = () => true,
): Promise<SessionBundle> {
  const plans: StreamPlan[] = [];
  for (const { spec } of record.streams) plans.push(await planStream(store, record.id, spec));

  const manifest = manifestFor(record, status, store.kind);
  manifest.streams = plans.map((p) => streamInfo(p.stream, p.stats));

  return {
    sessionId: record.id,
    folderName: `session_${record.id}`,
    manifest,
    files: plans.map((plan) => streamFile(store, record.id, plan, readable)),
  };
}

/** The manifest-only stub of a withdrawn session: no streams, withdrawal recorded. */
export function withdrawnManifest(
  record: SessionRecord,
  persistence: ChunkStore['kind'],
): SessionManifest {
  return manifestFor(record, 'withdrawn', persistence);
}

function manifestFor(
  record: SessionRecord,
  status: SessionStatus,
  persistence: ChunkStore['kind'],
): SessionManifest {
  if (!record.clock || !record.startedAt) {
    throw new Error('manifest: session was never started');
  }
  const packages: Record<string, string> = { [CORE_PACKAGE]: CORE_VERSION };
  for (const s of record.sensors) packages[s.package] = s.version;
  const lastSeenT = record.lastSeen?.t ?? null;
  return {
    format: MANIFEST_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    toolkit: { name: TOOLKIT_NAME, version: CORE_VERSION, packages },
    study:
      record.studyVersion === null
        ? { id: record.studyId }
        : { id: record.studyId, version: record.studyVersion },
    session: {
      id: record.id,
      participantId: record.participantId,
      status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: record.endedAt && lastSeenT !== null ? Math.round(lastSeenT * 1000) / 1000 : null,
      pauses: structuredClone(record.pauses),
    },
    clock: {
      timebase: 'session',
      unit: 'ms',
      crossOriginIsolated: record.crossOriginIsolated,
      measuredResolutionMs: record.measuredResolutionMs,
      ...structuredClone(record.clock),
    },
    consent: structuredClone(record.consent),
    environment: { ...structuredClone(record.environment), persistence },
    privacy: { ...record.privacy },
    sensors: structuredClone(record.sensors),
    streams: [],
    quality: structuredClone(record.quality),
  };
}

async function planStream(
  store: ChunkStore,
  sessionId: string,
  stream: ResolvedStream,
): Promise<StreamPlan> {
  const withIntervals = stream.kind === 'samples';
  const acc = new StatsAccumulator(withIntervals);
  for await (const chunk of store.chunks(sessionId, stream.name)) {
    for (const row of chunk.rows) acc.add(row[0] as number);
  }
  if (acc.sorted) return { stream, stats: acc.result(), needsSort: false };

  // Rare: recompute stats over the sorted timestamps, so they describe the file as written.
  const ts: number[] = [];
  for await (const chunk of store.chunks(sessionId, stream.name)) {
    for (const row of chunk.rows) ts.push(row[0] as number);
  }
  ts.sort((a, b) => a - b);
  const sortedAcc = new StatsAccumulator(withIntervals);
  for (const t of ts) sortedAcc.add(t);
  return { stream, stats: sortedAcc.result(), needsSort: true };
}

function streamFile(
  store: ChunkStore,
  sessionId: string,
  plan: StreamPlan,
  readable: () => boolean,
): BundleFile {
  const { stream } = plan;
  const encode = stream.format === 'csv' ? csvRow : jsonlRow;
  return {
    path: stream.file,
    stream: stream.name,
    async *text() {
      if (!readable()) {
        throw new Error(
          `bundle file ${stream.file} is no longer readable: local data was deleted after end(). Read files inside Sink.onEnd.`,
        );
      }
      if (stream.format === 'csv') yield csvHeader(stream.columns);
      if (plan.needsSort) {
        // Out-of-order streams are small event streams; sort them in memory (stable).
        const rows: unknown[][] = [];
        for await (const chunk of store.chunks(sessionId, stream.name)) rows.push(...chunk.rows);
        rows.sort((a, b) => (a[0] as number) - (b[0] as number));
        yield rows.map((row) => encode(stream.columns, row)).join('');
        return;
      }
      for await (const chunk of store.chunks(sessionId, stream.name)) {
        let piece = '';
        for (const row of chunk.rows) piece += encode(stream.columns, row);
        yield piece;
      }
    },
  };
}
