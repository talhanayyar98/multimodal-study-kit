/**
 * @mmstudykit/core: session, clock, consent, streams, markers, recorder and export.
 *
 * Pre-alpha. See the README for the quickstart and PLAN.md for the design.
 */
export { createSession, Session, SessionStateError } from './session.js';
export type {
  EndResult,
  SessionConfig,
  SessionEvents,
  SessionState,
  SinkResult,
  StartResult,
  WithdrawResult,
} from './session.js';

export type { ConsentInput, SessionDisclosure } from './consent.js';
export type {
  Sensor,
  SensorContext,
  SensorDisclosure,
  SensorOptionRequest,
  SensorPrivacyFlags,
} from './sensor.js';
export type { ColumnSpec, ResolvedStream, StreamSpec } from './streams.js';
export { checkPayload, guardRow, resolveStream } from './streams.js';

export { SessionClock, browserTimeSource, DISCONTINUITY_THRESHOLD_MS } from './clock.js';
export type { ClockState, LastSeen, TimeSource } from './clock.js';

export { downloadSink } from './sinks.js';
export type { DownloadSinkOptions, Sink, WithdrawalNotice } from './sinks.js';
export { bundleToZip } from './export/zip.js';
export type { BundleFile, SessionBundle } from './export/bundle.js';

export { MemoryStore } from './store/memory.js';
export { SupersededError } from './store/types.js';
export { openIndexedDbStore } from './store/indexeddb.js';
export type { ChunkStore, SessionRecord, StoredChunk } from './store/types.js';

export { MANIFEST_FORMAT, SCHEMA_VERSION } from './manifest.js';
export type {
  ClockAnchor,
  ClockDiscontinuity,
  ClockInfo,
  ClockSegment,
  ColumnInfo,
  ColumnType,
  ConsentDecision,
  ConsentRecord,
  EnvironmentInfo,
  IsoDateTime,
  PrivacyFlags,
  SensorInfo,
  SessionInfo,
  SessionManifest,
  SessionMs,
  SessionStatus,
  StreamInfo,
  StreamStats,
  StudyInfo,
  ToolkitInfo,
} from './manifest.js';
export { CORE_VERSION } from './version.js';
