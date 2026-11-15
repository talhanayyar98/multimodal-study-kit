import type { PrivacyFlags, SessionMs } from './manifest.js';
import type { StreamSpec } from './streams.js';

/**
 * A privacy-relevant option that a sensor's configuration requests, such as recording key
 * identity. Requested options are disclosed to the participant and run only if the consent
 * record grants them, under the key `<sensorId>.<id>`.
 */
export interface SensorOptionRequest {
  /** camelCase, e.g. `keyIdentity`. */
  id: string;
  /** Short participant-facing label. */
  title: string;
  /** Participant-facing explanation of what changes if this is granted. */
  description: string;
}

/** What a sensor records, in participant-facing language. Feeds `session.describe()`. */
export interface SensorDisclosure {
  sensorId: string;
  /** e.g. `Keyboard timing`. */
  title: string;
  /** One or two plain sentences. */
  summary: string;
  /** Concrete things recorded. */
  records: string[];
  /** Concrete things never recorded. This is what ethics boards look for. */
  neverRecords: string[];
  /** Approximate rate in Hz, or null if event-driven. */
  rateHz: number | null;
  /** Requested opt-ins, keyed `<sensorId>.<id>` in the consent record. */
  options: (SensorOptionRequest & { key: string })[];
}

/** The privacy flags a sensor can contribute to `manifest.privacy`. */
export type SensorPrivacyFlags = Partial<
  Pick<PrivacyFlags, 'keyIdentityRecorded' | 'faceLandmarksRecorded'>
>;

/** What core gives a running sensor. */
export interface SensorContext {
  readonly sessionId: string;
  readonly clock: {
    /** Current session time. */
    now(): SessionMs;
    /** Convert a `performance.now()`-timebase timestamp (e.g. `event.timeStamp`) to session time. */
    fromPerf(perfTimestamp: number): SessionMs;
  };
  /** Option ids (without the sensor prefix) the participant granted, e.g. `keyIdentity`. */
  readonly granted: ReadonlySet<string>;
  /** Aborted when the sensor is stopped (end, withdraw). Use it to remove listeners. */
  readonly signal: AbortSignal;
  /**
   * Record one row. `row.t` (session ms) is required. Keys must be declared columns. Returns false
   * if the row was dropped: session paused, sensor stopped, or rejected by the sample guard (the
   * rejection is recorded in `session.events`).
   */
  emit(stream: string, row: Readonly<Record<string, unknown>>): boolean;
  /** Live quality metrics for UIs (`session.on('quality')`). Not recorded. */
  reportQuality(quality: Record<string, unknown>): void;
  /** Add a runtime note to this sensor's manifest entry, e.g. `getCoalescedEvents unavailable`. */
  note(text: string): void;
}

/**
 * The sensor contract. Built-in sensors use exactly this interface, so third-party sensors (and
 * the future gaze module) have the same capabilities and constraints.
 */
export interface Sensor {
  /** snake_case id, e.g. `pointer`. Prefix of all its stream names. */
  readonly id: string;
  /** npm package and version, for the manifest. */
  readonly package: string;
  readonly version: string;
  /** Privacy-relevant opt-ins this configuration requests. */
  readonly options?: readonly SensorOptionRequest[];
  /** The resolved configuration (defaults applied), recorded in the manifest. */
  config(): Record<string, unknown>;
  /** Streams this sensor writes, given which requested options were granted. */
  streams(granted: ReadonlySet<string>): readonly StreamSpec[];
  /** Participant-facing description of what this configuration records. */
  describe(): Omit<SensorDisclosure, 'sensorId' | 'options'>;
  /** Contribution to `manifest.privacy`. */
  privacy?(granted: ReadonlySet<string>): SensorPrivacyFlags;
  /** Start recording. Rejecting marks the sensor as failed; the session continues without it. */
  start(ctx: SensorContext): Promise<void> | void;
  /** Stop recording and release resources. Emitting after this is a no-op. */
  stop(): Promise<void> | void;
  /** Optional: release expensive resources (e.g. the camera) while paused. */
  pause?(): void;
  resume?(): void;
  /** Optional summary for `manifest.quality[sensorId]`, read after `stop()`. */
  summary?(): Record<string, unknown>;
}
