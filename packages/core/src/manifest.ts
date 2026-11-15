/**
 * TypeScript view of the session manifest, mirroring `spec/manifest.schema.json` (v0.1.0).
 *
 * The JSON Schema is the source of truth (it is language-neutral and shared with the Python
 * reader). The tests validate typed example manifests against the schema so the two cannot
 * drift silently in the common cases.
 */

/** Value of `manifest.format` for every session bundle. */
export const MANIFEST_FORMAT = 'mmstudykit.session';

/** Version of the manifest/bundle format this build writes. */
export const SCHEMA_VERSION = '0.1.0';

/** Milliseconds since session start on the session's monotonic clock. */
export type SessionMs = number;

/** ISO 8601 date-time string in UTC, e.g. `2026-11-15T10:00:00.000Z`. */
export type IsoDateTime = string;

export type ConsentDecision = 'granted' | 'declined';

export type SessionStatus = 'completed' | 'incomplete' | 'withdrawn';

export interface SessionManifest {
  $schema?: string;
  format: typeof MANIFEST_FORMAT;
  schemaVersion: string;
  toolkit: ToolkitInfo;
  study: StudyInfo;
  session: SessionInfo;
  clock: ClockInfo;
  consent: ConsentRecord;
  environment: EnvironmentInfo;
  privacy: PrivacyFlags;
  sensors: SensorInfo[];
  /** Empty when `session.status` is `'withdrawn'`. */
  streams: StreamInfo[];
  /** Sensor id → sensor-specific quality summary. */
  quality?: Record<string, Record<string, unknown>>;
  /** Namespaced third-party data (keys like `org.example.gaze`). Readers ignore unknown keys. */
  extensions?: Record<string, unknown>;
}

export interface ToolkitInfo {
  name: string;
  version: string;
  /** npm package name → version for every toolkit package that took part in the session. */
  packages: Record<string, string>;
}

export interface StudyInfo {
  id: string;
  version?: string;
}

export interface SessionInfo {
  id: string;
  /** Researcher-provided pseudonymous identifier; never collected automatically. */
  participantId: string;
  status: SessionStatus;
  startedAt: IsoDateTime;
  endedAt: IsoDateTime | null;
  durationMs: number | null;
  pauses: { startT: SessionMs; endT: SessionMs | null }[];
}

export interface ClockInfo {
  timebase: 'session';
  unit: 'ms';
  crossOriginIsolated: boolean;
  measuredResolutionMs: number | null;
  /** One segment per page load; a resumed session after reload adds a segment. */
  segments: ClockSegment[];
  anchors: ClockAnchor[];
  discontinuities: ClockDiscontinuity[];
}

export interface ClockSegment {
  index: number;
  reason: 'start' | 'reload-resume';
  /** Session time at which this segment starts. */
  t: SessionMs;
  /** `Date.now()` at segment start (Unix ms). */
  wallClockMs: number;
  /** `performance.timeOrigin` of this page load (Unix ms). */
  timeOrigin: number;
  /** `performance.now()` at segment start. */
  perfNow: number;
}

export interface ClockAnchor {
  segment: number;
  t: SessionMs;
  wallClockMs: number;
  perfNow: number;
}

export interface ClockDiscontinuity {
  t: SessionMs;
  kind: 'suspend' | 'wallclock-jump' | 'reload-gap';
  magnitudeMs: number;
}

export interface ConsentRecord {
  textVersion: string;
  /** SHA-256 (lowercase hex) of the exact consent text shown, or null if not provided. */
  textSha256: string | null;
  decidedAt: IsoDateTime;
  /** Sensor id → decision. Sensors without `'granted'` never start. */
  decisions: Record<string, ConsentDecision>;
  /** Privacy-relevant opt-ins keyed `<sensorId>.<option>`, e.g. `keyboard.keyIdentity`. */
  options: Record<string, ConsentDecision>;
  withdrawal: { at: IsoDateTime; t: SessionMs } | null;
}

export interface EnvironmentInfo {
  browser: { name: string; majorVersion: number | null };
  os: { name: string };
  deviceClass: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  /** Viewport at session start in CSS px; changes are recorded in `page.events`. */
  viewport: { width: number; height: number; devicePixelRatio: number };
  persistence: 'indexeddb' | 'memory';
}

export interface PrivacyFlags {
  rawVideoPersisted: false;
  rawVideoTransmitted: false;
  keyIdentityRecorded: boolean;
  faceLandmarksRecorded: 'none' | 'subset' | 'full';
  participantIdSource: 'researcher';
}

export interface SensorInfo {
  id: string;
  package: string;
  version: string;
  /** True only if consent was granted and the sensor started. */
  enabled: boolean;
  /** Resolved configuration with defaults applied. */
  config: Record<string, unknown>;
  notes?: string[];
}

export type ColumnType = 'number' | 'integer' | 'boolean' | 'string' | 'enum' | 'object';

export interface ColumnInfo {
  name: string;
  /** `boolean` is encoded 0/1 in CSV; `object` is only valid in JSONL streams. */
  type: ColumnType;
  /** Unit of measure (`'ms'`, `'px'`, `'deg'`, `'1'` for dimensionless) or null for non-quantities. */
  unit: string | null;
  description: string;
  enumValues?: string[];
  /** Decimal places written for this column, if fixed. */
  precision?: number | null;
}

export interface StreamStats {
  count: number;
  firstT: SessionMs | null;
  lastT: SessionMs | null;
  intervalMs: { mean: number; sd: number; p50: number; p95: number; max: number } | null;
}

export interface StreamInfo {
  /** `<sensor>.<stream>`, snake_case segments, e.g. `pointer.move`. */
  name: string;
  sensor: string;
  kind: 'samples' | 'events';
  format: 'csv' | 'jsonl';
  /** Path inside the bundle, e.g. `streams/pointer.move.csv`. */
  file: string;
  nominalRateHz: number | null;
  /** How `t` was obtained, e.g. `event.timeStamp`, `rvfc.captureTime`, `performance.now`. */
  timestampSource: string;
  /** Columns in file order (CSV) or top-level keys (JSONL). The first is always `t`. */
  columns: ColumnInfo[];
  stats: StreamStats;
}
