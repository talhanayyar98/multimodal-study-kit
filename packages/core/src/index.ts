/**
 * @mmstudykit/core: session, clock, streams, markers, recorder and export.
 *
 * Pre-alpha. M0 ships only the manifest types and format constants; the session API described
 * in the README lands in M1.
 */
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
