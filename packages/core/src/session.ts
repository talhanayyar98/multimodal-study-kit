import { SessionClock, browserTimeSource, round3 } from './clock.js';
import type { TimeSource } from './clock.js';
import { buildConsentRecord, describeSensors, grantedOptionsFor } from './consent.js';
import type { ConsentInput, SessionDisclosure } from './consent.js';
import { detectEnvironment, measureTimerResolution } from './environment.js';
import { buildBundle, withdrawnManifest } from './export/bundle.js';
import type { SessionBundle } from './export/bundle.js';
import type {
  ConsentRecord,
  PrivacyFlags,
  SensorInfo,
  SessionManifest,
  SessionMs,
} from './manifest.js';
import { Recorder } from './recorder.js';
import type { RecorderOptions } from './recorder.js';
import type { Sensor, SensorContext, SensorPrivacyFlags } from './sensor.js';
import type { Sink, WithdrawalNotice } from './sinks.js';
import { openIndexedDbStore } from './store/indexeddb.js';
import { MemoryStore } from './store/memory.js';
import { SupersededError } from './store/types.js';
import type { ChunkStore, SessionRecord, StoredChunk } from './store/types.js';
import { RESERVED_SENSOR_IDS, checkPayload, guardRow, resolveStream } from './streams.js';
import type { ResolvedStream, StreamSpec } from './streams.js';
import { Emitter } from './util/emitter.js';
import { randomId } from './util/id.js';

/**
 * `superseded`: another page resumed this session (e.g. this page came back from the
 * back/forward cache after the participant moved on); this page stopped recording.
 */
export type SessionState =
  'created' | 'consented' | 'running' | 'paused' | 'ended' | 'withdrawn' | 'superseded';

export interface SessionConfig {
  /** Your study's identifier (letters, digits, `._:-`). */
  studyId: string;
  /** Optional study version, recorded in the manifest. */
  studyVersion?: string;
  /**
   * A pseudonymous participant ID that you provide (e.g. from your recruitment platform). The
   * toolkit never derives or collects one. Don't use names or email addresses.
   */
  participantId: string;
  sensors?: readonly Sensor[];
  sinks?: readonly Sink[];
  /**
   * Where buffered data lives. `'auto'` (default): IndexedDB, falling back to memory when it's
   * unavailable. `'memory'`: never touch IndexedDB (no reload recovery).
   */
  storage?: 'auto' | 'memory' | ChunkStore;
  /** Resume this tab's unfinished session after a reload. Default true. */
  resume?: boolean;
  /** Keep local data after every sink succeeded. Default false (delete it). */
  keepLocalData?: boolean;
  recorder?: RecorderOptions;
  /** Clock anchor interval in ms. Default 10,000. */
  anchorIntervalMs?: number;
  /** Testing hook: replace the browser time source. */
  timeSource?: TimeSource;
}

export interface StartResult {
  started: string[];
  declined: string[];
  failed: { sensorId: string; error: string }[];
}

export interface SinkResult {
  name: string;
  ok: boolean;
  error?: string;
}

export interface EndResult {
  manifest: SessionManifest;
  sinks: SinkResult[];
  /** False if a sink failed (or `keepLocalData` is set): `exportBundle()` still works then. */
  localDataDeleted: boolean;
}

export interface WithdrawResult {
  /** The manifest stub (no streams), or null if the session never started. */
  manifest: SessionManifest | null;
  sinks: SinkResult[];
}

export interface SessionEvents {
  state: SessionState;
  quality: { sensorId: string; quality: Record<string, unknown> };
  warning: { message: string; sensorId?: string };
}

export class SessionStateError extends Error {
  override readonly name = 'SessionStateError';
}

const SESSION_EVENT_TYPES = [
  'start',
  'segment',
  'pause',
  'resume',
  'discontinuity',
  'sensor_started',
  'sensor_failed',
  'sensor_stopped',
  'row_rejected',
  'storage_error',
  'end',
] as const;
type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

const SESSION_EVENTS_STREAM: StreamSpec = {
  name: 'session.events',
  kind: 'events',
  format: 'jsonl',
  nominalRateHz: null,
  timestampSource: 'performance.now',
  columns: [
    {
      name: 'type',
      type: 'enum',
      unit: null,
      description: 'Lifecycle event.',
      enumValues: SESSION_EVENT_TYPES,
    },
    { name: 'data', type: 'object', unit: null, description: 'Event details (type-specific).' },
  ],
};

const MARKERS_STREAM: StreamSpec = {
  name: 'task.markers',
  kind: 'events',
  format: 'jsonl',
  nominalRateHz: null,
  timestampSource: 'per-row (see source)',
  columns: [
    {
      name: 'name',
      type: 'string',
      unit: null,
      description: 'Researcher-chosen marker name.',
      maxLength: 128,
    },
    {
      name: 'source',
      type: 'enum',
      unit: null,
      description:
        'api: performance.now() at mark(). frame: requestAnimationFrame timestamp (markOnNextFrame). jspsych: jsPsych extension.',
      enumValues: ['api', 'frame', 'jspsych'],
    },
    { name: 'data', type: 'object', unit: null, description: 'Researcher-provided payload.' },
  ],
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SENSOR_ID = /^[a-z][a-z0-9_]*$/;
/** Individually logged guard rejections per stream; the rest are counted. */
const LOGGED_REJECTIONS = 10;
const SENSOR_STOP_TIMEOUT_MS = 5000;
const MARK_FRAME_TIMEOUT_MS = 1000;

interface Pointer {
  v: 1;
  sessionId: string;
  participantId: string;
  state: 'active' | 'withdrawn';
}

interface SensorRuntime {
  sensor: Sensor;
  info: SensorInfo;
  streams: Map<string, ResolvedStream>;
  abort: AbortController | null;
  running: boolean;
}

/**
 * Create a session, or resume this tab's unfinished one after a reload.
 *
 * A resumed session comes back as `consented` with `resumed === true`. Nothing records until you
 * call `start()` again, which continues the same session in a new clock segment. If the
 * participant withdrew in this tab, the session comes back as `withdrawn`.
 */
export async function createSession(config: SessionConfig): Promise<Session> {
  validateConfig(config);
  const owned = !(config.storage && typeof config.storage === 'object');
  const store = await resolveStore(config.storage);
  const key = pointerKey(config.studyId);
  const writer = randomId();

  if (config.resume !== false) {
    const pointer = readPointer(key);
    if (pointer?.participantId === config.participantId) {
      if (pointer.state === 'withdrawn') {
        return new Session(config, store, owned, writer, {
          kind: 'withdrawn',
          sessionId: pointer.sessionId,
        });
      }
      const record = await store.load(pointer.sessionId).catch(() => undefined);
      const sensorIds = (config.sensors ?? [])
        .map((s) => s.id)
        .sort()
        .join(',');
      if (
        record &&
        record.state !== 'ended' &&
        record.studyId === config.studyId &&
        record.participantId === config.participantId &&
        record.sensors
          .map((s) => s.id)
          .sort()
          .join(',') === sensorIds
      ) {
        // Rows the previous page saved synchronously while unloading (see #spill).
        const recovered = takeSpill(record);
        // Take over: from now on, an older page still holding this session can't write to it.
        record.writer = writer;
        await store.write(record, recovered, { takeover: true });
        return new Session(config, store, owned, writer, { kind: 'resumed', record });
      }
    }
    if (pointer) removePointer(key);
  }
  return new Session(config, store, owned, writer, { kind: 'new' });
}

type Origin =
  | { kind: 'new' }
  | { kind: 'resumed'; record: SessionRecord }
  | { kind: 'withdrawn'; sessionId: string };

/** One participant run. Create it with {@link createSession}. */
export class Session {
  readonly id: string;
  readonly studyId: string;
  readonly participantId: string;
  /** True if this session was restored after a page reload. */
  readonly resumed: boolean;

  readonly #config: SessionConfig;
  readonly #sensors: readonly Sensor[];
  readonly #sinks: readonly Sink[];
  readonly #store: ChunkStore;
  /** Close the store when done only if we opened it. */
  readonly #ownsStore: boolean;
  readonly #writer: string;
  readonly #emitter = new Emitter<SessionEvents>();
  readonly #time: TimeSource;
  readonly #runtimes = new Map<string, SensorRuntime>();
  readonly #builtin = new Map<string, ResolvedStream>();
  readonly #rejections = new Map<string, { count: number; sensorId: string; lastReason: string }>();
  #state: SessionState;
  #record: SessionRecord | null;
  #clock: SessionClock | null = null;
  #recorder: Recorder | null = null;
  #lifecycle: AbortController | null = null;
  #anchorTimer: ReturnType<typeof setInterval> | undefined;
  #endT: SessionMs | null = null;
  #localDeleted = false;
  #spilled = false;
  #busy: Promise<unknown> = Promise.resolve();

  /** @internal Use {@link createSession}. */
  constructor(
    config: SessionConfig,
    store: ChunkStore,
    ownsStore: boolean,
    writer: string,
    origin: Origin,
  ) {
    this.#config = config;
    this.#ownsStore = ownsStore;
    this.#writer = writer;
    this.#sensors = config.sensors ?? [];
    this.#sinks = config.sinks ?? [];
    this.#store = store;
    this.#time = config.timeSource ?? browserTimeSource;
    this.studyId = config.studyId;
    this.participantId = config.participantId;
    this.resumed = origin.kind === 'resumed';
    this.#builtin.set('session.events', resolveStream('session', SESSION_EVENTS_STREAM));
    this.#builtin.set('task.markers', resolveStream('task', MARKERS_STREAM));

    if (origin.kind === 'resumed') {
      this.id = origin.record.id;
      this.#record = origin.record;
      this.#state = 'consented';
      // A pause still open at reload ends at the last moment the page was alive.
      const open = origin.record.pauses.at(-1);
      if (open?.endT === null) open.endT = origin.record.lastSeen?.t ?? open.startT;
    } else if (origin.kind === 'withdrawn') {
      this.id = origin.sessionId;
      this.#record = null;
      this.#state = 'withdrawn';
    } else {
      this.id = randomId();
      this.#record = null;
      this.#state = 'created';
    }
  }

  get state(): SessionState {
    return this.#state;
  }

  /** `indexeddb` or `memory`: where buffered data lives (also in the manifest). */
  get persistence(): ChunkStore['kind'] {
    return this.#store.kind;
  }

  /** The consent record, once `consent()` was called. */
  get consentRecord(): ConsentRecord | null {
    return this.#record ? structuredClone(this.#record.consent) : null;
  }

  on<K extends keyof SessionEvents>(
    event: K,
    listener: (payload: SessionEvents[K]) => void,
  ): () => void {
    return this.#emitter.on(event, listener);
  }

  /** Current session time (ms since start). Throws before `start()`. */
  now(): SessionMs {
    return this.#requireClock().now();
  }

  /**
   * What this configuration records, per sensor, in participant-facing language, plus default
   * English text. Show it inside your ethics-approved consent form.
   */
  describe(): SessionDisclosure {
    return describeSensors(this.#sensors);
  }

  /**
   * Record the participant's consent decision. Only granted sensors (and granted opt-ins) will
   * ever start. Must be called exactly once, before `start()`.
   */
  async consent(input: ConsentInput): Promise<ConsentRecord> {
    this.#expect(['created'], 'consent()');
    const decidedAt = isoAt(this.#time.wallNow());
    const consent = await buildConsentRecord(input, this.#sensors, decidedAt);
    this.#expect(['created'], 'consent()');
    this.#record = {
      v: 1,
      id: this.id,
      writer: this.#writer,
      studyId: this.studyId,
      studyVersion: this.#config.studyVersion ?? null,
      participantId: this.participantId,
      state: 'consented',
      startedAt: null,
      endedAt: null,
      consent,
      clock: null,
      lastSeen: null,
      crossOriginIsolated: false,
      measuredResolutionMs: null,
      pauses: [],
      sensors: this.#sensors.map((s) => {
        const info: SensorInfo = {
          id: s.id,
          package: s.package,
          version: s.version,
          enabled: false,
          config: s.config(),
        };
        if (consent.decisions[s.id] !== 'granted') info.notes = ['not started: consent declined'];
        return info;
      }),
      privacy: basePrivacy(),
      environment: detectEnvironment(),
      quality: {},
      streams: [],
    };
    await this.#persist();
    writePointer(pointerKey(this.studyId), {
      v: 1,
      sessionId: this.id,
      participantId: this.participantId,
      state: 'active',
    });
    this.#setState('consented');
    return structuredClone(consent);
  }

  /**
   * Start recording. Only consented sensors start, and sensors that ask for device permissions
   * (the camera) ask here. After a reload, `start()` continues the session in a new clock segment.
   */
  async start(): Promise<StartResult> {
    return this.#exclusive(async () => {
      this.#expect(['consented'], 'start()');
      const record = this.#requireRecord();
      const firstStart = record.clock === null;

      if (firstStart) {
        this.#clock = SessionClock.start(this.#time);
        const segment = this.#clock.snapshot().segments[0];
        record.startedAt = isoAt(segment?.wallClockMs ?? this.#time.wallNow());
        record.crossOriginIsolated =
          (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
        record.measuredResolutionMs = measureTimerResolution(() => this.#time.now());
        record.environment = detectEnvironment();
      } else {
        const lastSeen = record.lastSeen ?? lastAnchor(record);
        this.#clock = SessionClock.resume(record.clock ?? emptyClock(), lastSeen, this.#time);
      }
      record.clock = this.#clock.snapshot();

      const recorder = new Recorder(
        this.#store,
        this.id,
        () => this.#snapshot(),
        (e) => {
          this.#storageError(e);
        },
        this.#config.recorder,
      );
      recorder.onWritten = () => {
        if (this.#spilled && recorder.unsaved().length === 0) {
          this.#spilled = false;
          removeKey(spillKey(this.id));
        }
      };
      this.#recorder = recorder;
      for (const stream of this.#builtin.values()) this.#registerStream(stream);

      if (firstStart) this.#event('start', { segment: 0 });
      else {
        const seg = record.clock.segments.at(-1);
        const gap = record.clock.discontinuities.at(-1);
        this.#event('segment', {
          index: seg?.index ?? null,
          reason: seg?.reason ?? null,
          gapMs: gap?.magnitudeMs ?? null,
        });
      }

      // Enforcement: a sensor without a recorded 'granted' decision never gets start() called.
      const result: StartResult = { started: [], declined: [], failed: [] };
      const toStart: SensorRuntime[] = [];
      for (const sensor of this.#sensors) {
        const info = record.sensors.find((s) => s.id === sensor.id);
        if (!info) continue;
        if (record.consent.decisions[sensor.id] !== 'granted') {
          result.declined.push(sensor.id);
          continue;
        }
        const runtime: SensorRuntime = {
          sensor,
          info,
          streams: new Map(),
          abort: null,
          running: false,
        };
        try {
          const granted = grantedOptionsFor(record.consent, sensor.id);
          for (const spec of sensor.streams(granted)) {
            const stream = resolveStream(sensor.id, spec);
            runtime.streams.set(stream.name, stream);
            this.#registerStream(stream);
          }
        } catch (error) {
          this.#sensorFailed(runtime, error, result);
          continue;
        }
        this.#runtimes.set(sensor.id, runtime);
        toStart.push(runtime);
      }

      // Rows may arrive while sensors start (initial snapshots), so we're running from here on.
      this.#state = 'running';
      record.state = 'running';
      await Promise.all(
        toStart.map(async (runtime) => {
          const abort = new AbortController();
          runtime.abort = abort;
          runtime.running = true;
          try {
            await runtime.sensor.start(this.#context(runtime, abort.signal));
            runtime.info.enabled = true;
            result.started.push(runtime.sensor.id);
            this.#event('sensor_started', { sensor: runtime.sensor.id });
          } catch (error) {
            this.#sensorFailed(runtime, error, result);
          }
        }),
      );
      record.privacy = this.#privacy();

      this.#attachLifecycle();
      recorder.startTimer();
      this.#anchorTimer = setInterval(() => {
        this.#anchor();
      }, this.#config.anchorIntervalMs ?? 10_000);
      await recorder.flush();
      // pause() may have been called while sensors were starting.
      this.#setState(this.#state);
      return result;
    });
  }

  /** Record a task marker now. Returns its session time. */
  mark(name: string, data?: Record<string, unknown>): SessionMs {
    this.#expect(['running', 'paused'], 'mark()');
    validateMarker(name, data);
    const t = this.#requireClock().now();
    this.#append('task.markers', [t, name, 'api', data ?? null]);
    return t;
  }

  /**
   * Record a marker at the next animation frame: use it right after you render a stimulus, since
   * the stimulus appears on the next frame, not when your code runs. Resolves with the marker's
   * session time (the rAF timestamp; true display onset is 0–1 frame later and needs a photodiode
   * to measure). Falls back to `mark()` (source `api`) when the tab is hidden or no frame arrives
   * within 1 s.
   */
  markOnNextFrame(name: string, data?: Record<string, unknown>): Promise<SessionMs> {
    this.#expect(['running', 'paused'], 'markOnNextFrame()');
    validateMarker(name, data);
    const raf = (globalThis as { requestAnimationFrame?: (cb: (ts: number) => void) => number })
      .requestAnimationFrame;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (!raf || hidden) return Promise.resolve(this.mark(name, data));

    return new Promise((resolve, reject) => {
      let settled = false;
      const record = (t: SessionMs, source: 'api' | 'frame') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#state !== 'running' && this.#state !== 'paused') {
          reject(
            new SessionStateError(
              `markOnNextFrame("${name}"): session ${this.#state} before the frame`,
            ),
          );
          return;
        }
        this.#append('task.markers', [t, name, source, data ?? null]);
        resolve(t);
      };
      const timer = setTimeout(() => {
        record(this.#requireClock().now(), 'api');
      }, MARK_FRAME_TIMEOUT_MS);
      raf((ts) => {
        record(this.#requireClock().fromPerf(ts), 'frame');
      });
    });
  }

  /** Pause recording (participant- or researcher-initiated). Sensors record nothing until `resume()`. */
  pause(): void {
    this.#expect(['running'], 'pause()');
    const record = this.#requireRecord();
    // Sensors pause first, while emits are still accepted, so they can flush pending state.
    for (const r of this.#runtimes.values()) if (r.running) safely(() => r.sensor.pause?.());
    const t = this.now();
    record.pauses.push({ startT: t, endT: null });
    record.state = 'paused';
    this.#state = 'paused';
    this.#event('pause', null, t);
    void this.#recorder?.flush();
    this.#setState('paused');
  }

  resume(): void {
    this.#expect(['paused'], 'resume()');
    const record = this.#requireRecord();
    const t = this.now();
    const open = record.pauses.at(-1);
    if (open) open.endT = t;
    record.state = 'running';
    this.#state = 'running';
    this.#event('resume', null, t);
    for (const r of this.#runtimes.values()) if (r.running) safely(() => r.sensor.resume?.());
    void this.#recorder?.flush();
    this.#setState('running');
  }

  /** Flush buffered rows to storage now (e.g. before navigating away). */
  async flush(): Promise<void> {
    await this.#recorder?.flush();
  }

  /**
   * Finish: stop sensors, flush, build the manifest and hand the bundle to every sink. Local data
   * is deleted once every sink has succeeded (unless `keepLocalData`).
   */
  async end(): Promise<EndResult> {
    return this.#exclusive(async () => {
      this.#expect(['running', 'paused'], 'end()');
      const record = this.#requireRecord();
      await this.#stopSensors(true);
      const t = this.now();
      const open = record.pauses.at(-1);
      if (open?.endT === null) open.endT = t;
      this.#summarizeRejections();
      this.#event('end', null, t);
      this.#anchor();
      this.#endT = t;
      record.endedAt = isoAt(this.#time.wallNow());
      record.state = 'ended';
      this.#detach();
      const recorder = this.#requireRecorder();
      recorder.stopTimer();
      await recorder.flush();
      this.#state = 'ended';

      const bundle = await buildBundle(
        this.#store,
        this.#snapshot(),
        'completed',
        () => !this.#localDeleted,
      );
      const sinks = await runSinks(this.#sinks, (s) => s.onEnd?.(bundle));
      const allOk = sinks.every((s) => s.ok);
      let localDataDeleted = false;
      if (allOk && !this.#config.keepLocalData) {
        await this.#store.delete(this.id);
        localDataDeleted = true;
      }
      removePointer(pointerKey(this.studyId));
      removeKey(spillKey(this.id));
      if (localDataDeleted) {
        this.#localDeleted = true;
        this.#closeStore();
      }
      this.#setState('ended');
      return { manifest: bundle.manifest, sinks, localDataDeleted };
    });
  }

  /**
   * Withdraw: stop sensors, delete local data and tell every sink to delete what it holds. Allowed
   * in any state. A later export contains only a manifest stub marked `withdrawn`.
   */
  async withdraw(): Promise<WithdrawResult> {
    return this.#exclusive(async () => {
      if (this.#state === 'withdrawn') return { manifest: null, sinks: [] };
      await this.#stopSensors(false);
      this.#recorder?.discard();
      this.#detach();
      const record = this.#record;
      let manifest: SessionManifest | null = null;
      if (record) {
        const at = isoAt(this.#time.wallNow());
        const t = this.#clock ? this.#clock.now() : 0;
        record.consent.withdrawal = { at, t: round3(t) };
        if (record.clock && record.startedAt) {
          if (this.#clock) record.clock = this.#clock.snapshot();
          record.endedAt = at;
          record.lastSeen = { t, wallClockMs: this.#time.wallNow() };
          const open = record.pauses.at(-1);
          if (open?.endT === null) open.endT = t;
          manifest = withdrawnManifest(record, this.#store.kind);
        }
        if (!this.#localDeleted) {
          await this.#store.delete(this.id).catch((e: unknown) => {
            this.#warn(`withdraw: could not delete local data: ${errorMessage(e)}`);
          });
          this.#localDeleted = true;
        }
      }
      removeKey(spillKey(this.id));
      writePointer(pointerKey(this.studyId), {
        v: 1,
        sessionId: this.id,
        participantId: this.participantId,
        state: 'withdrawn',
      });
      const notice: WithdrawalNotice = {
        sessionId: this.id,
        studyId: this.studyId,
        participantId: this.participantId,
        manifest,
      };
      const sinks = record ? await runSinks(this.#sinks, (s) => s.onWithdraw?.(notice)) : [];
      this.#closeStore();
      this.#state = 'withdrawn';
      this.#setState('withdrawn');
      return { manifest, sinks };
    });
  }

  /**
   * Build a bundle from what's stored so far: `incomplete` while running, `completed` after an
   * `end()` whose local data was kept (a sink failed, or `keepLocalData`). Use it for an "export
   * now" button or to retry delivery.
   */
  async exportBundle(): Promise<SessionBundle> {
    this.#expect(['running', 'paused', 'ended'], 'exportBundle()');
    if (this.#state !== 'ended') await this.#recorder?.flush();
    else if (this.#localDeleted || !(await this.#store.load(this.id).catch(() => undefined))) {
      throw new SessionStateError('exportBundle(): local data was already deleted after end()');
    }
    return buildBundle(
      this.#store,
      this.#snapshot(),
      this.#state === 'ended' ? 'completed' : 'incomplete',
      () => !this.#localDeleted,
    );
  }

  // -------------------------------------------------------------------------------------------

  #context(runtime: SensorRuntime, signal: AbortSignal): SensorContext {
    const clock = this.#requireClock();
    const sensorId = runtime.sensor.id;
    const record = this.#requireRecord();
    return {
      sessionId: this.id,
      clock: { now: () => clock.now(), fromPerf: (ts) => clock.fromPerf(ts) },
      granted: grantedOptionsFor(record.consent, sensorId),
      signal,
      emit: (streamName, row) => {
        if (!runtime.running || signal.aborted || this.#state !== 'running') return false;
        const stream = runtime.streams.get(streamName);
        if (!stream) {
          this.#reject(
            sensorId,
            streamName,
            `stream "${streamName}" is not declared by sensor "${sensorId}"`,
          );
          return false;
        }
        const res = guardRow(stream, row);
        if (!res.ok) {
          this.#reject(sensorId, streamName, res.reason);
          return false;
        }
        this.#append(streamName, res.values);
        return true;
      },
      reportQuality: (quality) => {
        if (!signal.aborted) this.#emitter.emit('quality', { sensorId, quality });
      },
      note: (text) => {
        const notes = (runtime.info.notes ??= []);
        const clipped = text.slice(0, 256);
        if (!notes.includes(clipped)) notes.push(clipped);
      },
    };
  }

  #append(stream: string, row: unknown[]): void {
    this.#recorder?.append(stream, row);
  }

  #registerStream(stream: ResolvedStream): void {
    const record = this.#requireRecord();
    const existing = record.streams.find((s) => s.spec.name === stream.name);
    if (existing) {
      if (JSON.stringify(existing.spec) !== JSON.stringify(stream)) {
        this.#warn(
          `stream "${stream.name}" changed its declaration since the session started`,
          stream.sensor,
        );
        existing.spec = stream;
      }
    } else {
      record.streams.push({ spec: stream, nextSeq: 0 });
    }
    this.#requireRecorder().register(stream.name, existing?.nextSeq ?? 0);
  }

  #event(type: SessionEventType, data: Record<string, unknown> | null, t?: SessionMs): void {
    if (!this.#recorder || !this.#clock) return;
    this.#append('session.events', [t ?? this.#clock.now(), type, data]);
  }

  #reject(sensorId: string, stream: string, reason: string): void {
    const entry = this.#rejections.get(stream) ?? { count: 0, sensorId, lastReason: reason };
    entry.count++;
    entry.lastReason = reason;
    this.#rejections.set(stream, entry);
    if (entry.count <= LOGGED_REJECTIONS) {
      this.#event('row_rejected', { sensor: sensorId, stream, reason: reason.slice(0, 200) });
    }
    if (entry.count === 1) this.#warn(`rejected a row for "${stream}": ${reason}`, sensorId);
  }

  #summarizeRejections(): void {
    for (const [stream, { count, sensorId, lastReason }] of this.#rejections) {
      const runtime = this.#runtimes.get(sensorId);
      if (runtime)
        (runtime.info.notes ??= []).push(
          `${count} row(s) of ${stream} rejected by the sample guard`,
        );
      if (count > LOGGED_REJECTIONS) {
        this.#event('row_rejected', {
          sensor: sensorId,
          stream,
          reason: lastReason.slice(0, 200),
          total: count,
        });
      }
    }
  }

  #sensorFailed(runtime: SensorRuntime, error: unknown, result: StartResult): void {
    const message = errorMessage(error);
    runtime.running = false;
    runtime.abort?.abort();
    runtime.info.enabled = false;
    (runtime.info.notes ??= []).push(`start failed: ${message}`.slice(0, 256));
    result.failed.push({ sensorId: runtime.sensor.id, error: message });
    this.#event('sensor_failed', { sensor: runtime.sensor.id, error: message.slice(0, 200) });
    this.#warn(`sensor failed to start: ${message}`, runtime.sensor.id);
    void Promise.resolve()
      .then(() => runtime.sensor.stop())
      .catch(() => undefined);
  }

  async #stopSensors(collectSummaries: boolean): Promise<void> {
    const record = this.#record;
    await Promise.all(
      [...this.#runtimes.values()].map(async (runtime) => {
        if (!runtime.running) return;
        // stop() may emit final rows (e.g. keys still held), so emits stay open until it returns.
        try {
          await withTimeout(Promise.resolve(runtime.sensor.stop()), SENSOR_STOP_TIMEOUT_MS);
        } catch (error) {
          this.#warn(`sensor did not stop cleanly: ${errorMessage(error)}`, runtime.sensor.id);
        }
        runtime.running = false;
        runtime.abort?.abort();
        if (!collectSummaries) return;
        this.#event('sensor_stopped', { sensor: runtime.sensor.id });
        try {
          const summary = runtime.sensor.summary?.();
          if (summary && record && checkPayload(summary) === null)
            record.quality[runtime.sensor.id] = summary;
        } catch {
          // A broken summary shouldn't break end().
        }
      }),
    );
  }

  #privacy(): PrivacyFlags {
    const record = this.#requireRecord();
    const flags = basePrivacy();
    const rank = { none: 0, subset: 1, full: 2 } as const;
    for (const runtime of this.#runtimes.values()) {
      if (!runtime.info.enabled) continue;
      let p: SensorPrivacyFlags = {};
      try {
        p = runtime.sensor.privacy?.(grantedOptionsFor(record.consent, runtime.sensor.id)) ?? {};
      } catch {
        // Treat as no contribution.
      }
      if (p.keyIdentityRecorded) flags.keyIdentityRecorded = true;
      if (
        p.faceLandmarksRecorded &&
        rank[p.faceLandmarksRecorded] > rank[flags.faceLandmarksRecorded]
      ) {
        flags.faceLandmarksRecorded = p.faceLandmarksRecorded;
      }
    }
    return flags;
  }

  #anchor(): void {
    const d = this.#clock?.anchor();
    if (d) this.#event('discontinuity', { kind: d.kind, magnitudeMs: d.magnitudeMs }, d.t);
  }

  #attachLifecycle(): void {
    if (typeof document === 'undefined' || typeof addEventListener !== 'function') return;
    const lifecycle = new AbortController();
    this.#lifecycle = lifecycle;
    // Non-capture and registered after the sensors' own listeners, so sensors flush final rows
    // (e.g. keys still held) before the spill below is taken.
    const opts = { signal: lifecycle.signal } as const;
    const flushNow = () => {
      this.#anchor();
      this.#spill();
      void this.#recorder?.flush();
    };
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') flushNow();
        else this.#anchor();
      },
      opts,
    );
    addEventListener('pagehide', flushNow, opts);
    addEventListener(
      'pageshow',
      () => {
        this.#anchor();
      },
      opts,
    );
    // Page Lifecycle API (Chromium): a frozen tab may be discarded without further events.
    document.addEventListener('freeze', flushNow, opts);
    document.addEventListener(
      'resume',
      () => {
        this.#anchor();
      },
      opts,
    );
  }

  #detach(): void {
    this.#lifecycle?.abort();
    this.#lifecycle = null;
    if (this.#anchorTimer !== undefined) clearInterval(this.#anchorTimer);
    this.#anchorTimer = undefined;
  }

  /** The record as it should be persisted right now. */
  #snapshot(): SessionRecord {
    const record = this.#requireRecord();
    if (this.#clock) {
      record.clock = this.#clock.snapshot();
      const t = this.#endT ?? this.#clock.now();
      record.lastSeen = { t: round3(t), wallClockMs: this.#time.wallNow() };
    }
    if (this.#recorder) {
      for (const s of record.streams) s.nextSeq = this.#recorder.nextSeq(s.spec.name);
    }
    return record;
  }

  async #persist(): Promise<void> {
    await this.#store.write(this.#snapshot(), []);
  }

  /**
   * Synchronously save every unsaved chunk to sessionStorage. Called when the page may be about
   * to unload: an IndexedDB write started now would be aborted by the unload, but sessionStorage
   * is synchronous and survives a reload of the same tab. Merged back on resume (`takeSpill`).
   */
  #spill(): void {
    const recorder = this.#recorder;
    const clock = this.#clock;
    if (
      !recorder ||
      !clock ||
      this.#state === 'ended' ||
      this.#state === 'withdrawn' ||
      this.#state === 'superseded'
    )
      return;
    const chunks = recorder.unsaved();
    if (!chunks.length) return;
    const spill: Spill = {
      v: 1,
      writer: this.#writer,
      lastSeen: { t: round3(clock.now()), wallClockMs: this.#time.wallNow() },
      chunks,
    };
    this.#spilled = writeKey(spillKey(this.id), JSON.stringify(spill));
  }

  #closeStore(): void {
    if (this.#ownsStore) this.#store.close();
  }

  #storageError(error: unknown): void {
    if (error instanceof SupersededError) {
      this.#supersede();
      return;
    }
    const message = errorMessage(error);
    this.#warn(`storage write failed (will retry): ${message}`);
    this.#event('storage_error', { error: message.slice(0, 200) });
  }

  /** Another page resumed this session: stop recording here without touching stored data. */
  #supersede(): void {
    if (this.#state === 'superseded' || this.#state === 'ended' || this.#state === 'withdrawn')
      return;
    for (const runtime of this.#runtimes.values()) {
      if (!runtime.running) continue;
      runtime.running = false;
      runtime.abort?.abort();
      void Promise.resolve()
        .then(() => runtime.sensor.stop())
        .catch(() => undefined);
    }
    this.#recorder?.discard();
    this.#detach();
    this.#warn('this session was resumed in another page; this page stopped recording');
    this.#setState('superseded');
  }

  #warn(message: string, sensorId?: string): void {
    this.#emitter.emit('warning', sensorId === undefined ? { message } : { message, sensorId });
  }

  #setState(state: SessionState): void {
    this.#state = state;
    this.#emitter.emit('state', state);
  }

  #expect(states: readonly SessionState[], what: string): void {
    if (!states.includes(this.#state)) {
      throw new SessionStateError(
        `${what} is not allowed in state "${this.#state}" (expected ${states.join(' or ')})`,
      );
    }
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#busy.then(fn, fn);
    this.#busy = run.catch(() => undefined);
    return run;
  }

  #requireRecord(): SessionRecord {
    if (!this.#record) throw new SessionStateError('no consent recorded yet');
    return this.#record;
  }

  #requireClock(): SessionClock {
    if (!this.#clock) throw new SessionStateError('the session clock starts at start()');
    return this.#clock;
  }

  #requireRecorder(): Recorder {
    if (!this.#recorder) throw new SessionStateError('not started');
    return this.#recorder;
  }
}

// ---------------------------------------------------------------------------------------------

function validateConfig(config: SessionConfig): void {
  if (!IDENTIFIER.test(config.studyId)) {
    throw new TypeError(
      'studyId must be 1–128 characters: letters, digits and . _ : - (starting with a letter or digit)',
    );
  }
  if (typeof config.participantId !== 'string' || !IDENTIFIER.test(config.participantId)) {
    const hint =
      typeof config.participantId === 'string' && config.participantId.includes('@')
        ? ' It looks like an email address: use a pseudonymous ID instead.'
        : '';
    throw new TypeError(
      `participantId must be 1–128 characters: letters, digits and . _ : - (starting with a letter or digit).${hint}`,
    );
  }
  if (config.studyVersion !== undefined && config.studyVersion.length > 64) {
    throw new TypeError('studyVersion is longer than 64 characters');
  }
  const ids = new Set<string>();
  for (const sensor of config.sensors ?? []) {
    if (!SENSOR_ID.test(sensor.id))
      throw new TypeError(`sensor id "${sensor.id}" must be snake_case`);
    if (RESERVED_SENSOR_IDS.has(sensor.id))
      throw new TypeError(`sensor id "${sensor.id}" is reserved`);
    if (ids.has(sensor.id)) throw new TypeError(`two sensors share the id "${sensor.id}"`);
    ids.add(sensor.id);
  }
}

function validateMarker(name: string, data: Record<string, unknown> | undefined): void {
  if (typeof name !== 'string' || !name || name.length > 128) {
    throw new TypeError('marker name must be a non-empty string of at most 128 characters');
  }
  if (data !== undefined) {
    const problem = checkPayload(data);
    if (problem) throw new TypeError(`marker "${name}": data ${problem}`);
  }
}

async function resolveStore(option: SessionConfig['storage']): Promise<ChunkStore> {
  if (option && typeof option === 'object') return option;
  if (option === 'memory') return new MemoryStore();
  return (await openIndexedDbStore()) ?? new MemoryStore();
}

async function runSinks(
  sinks: readonly Sink[],
  call: (sink: Sink) => Promise<void> | undefined,
): Promise<SinkResult[]> {
  const results: SinkResult[] = [];
  for (const sink of sinks) {
    try {
      await call(sink);
      results.push({ name: sink.name, ok: true });
    } catch (error) {
      results.push({ name: sink.name, ok: false, error: errorMessage(error) });
    }
  }
  return results;
}

function basePrivacy(): PrivacyFlags {
  return {
    rawVideoPersisted: false,
    rawVideoTransmitted: false,
    keyIdentityRecorded: false,
    faceLandmarksRecorded: 'none',
    participantIdSource: 'researcher',
  };
}

function emptyClock(): NonNullable<SessionRecord['clock']> {
  return { segments: [], anchors: [], discontinuities: [] };
}

function lastAnchor(record: SessionRecord): { t: SessionMs; wallClockMs: number } {
  const a = record.clock?.anchors.at(-1);
  return a ? { t: a.t, wallClockMs: a.wallClockMs } : { t: 0, wallClockMs: Date.now() };
}

function isoAt(unixMs: number): string {
  return new Date(unixMs).toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Sensor pause/resume hooks are best-effort.
  }
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

// sessionStorage pointer: lets the same tab find its session after a reload. Holds only IDs.

function pointerKey(studyId: string): string {
  return `mmstudykit:${studyId}`;
}

// Unload spill: chunks not yet in IndexedDB when the page was hidden or unloaded.

interface Spill {
  v: 1;
  writer: string;
  lastSeen: { t: SessionMs; wallClockMs: number };
  chunks: StoredChunk[];
}

function spillKey(sessionId: string): string {
  return `mmstudykit:spill:${sessionId}`;
}

/**
 * Read and remove the unload spill of a session, returning the chunks the store doesn't have yet
 * and updating the record's sequence numbers and last-seen time. Chunks and the record are
 * written atomically, so `nextSeq` tells exactly which spilled chunks already made it.
 */
function takeSpill(record: SessionRecord): StoredChunk[] {
  const key = spillKey(record.id);
  const spill = readJson(key) as Spill | null;
  removeKey(key);
  if (spill?.v !== 1 || spill.writer !== record.writer || !Array.isArray(spill.chunks)) return [];
  const recovered: StoredChunk[] = [];
  for (const chunk of spill.chunks) {
    const entry = record.streams.find((s) => s.spec.name === chunk.stream);
    if (!entry || chunk.sessionId !== record.id || chunk.seq < entry.nextSeq) continue;
    recovered.push(chunk);
  }
  for (const chunk of recovered) {
    const entry = record.streams.find((s) => s.spec.name === chunk.stream);
    if (entry) entry.nextSeq = Math.max(entry.nextSeq, chunk.seq + 1);
  }
  if (!record.lastSeen || spill.lastSeen.t > record.lastSeen.t) record.lastSeen = spill.lastSeen;
  return recovered;
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false; // Quota exceeded or storage blocked: the IndexedDB flush is all we have.
  }
}

function removeKey(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Storage blocked.
  }
}

function storage(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null; // Access can throw in sandboxed iframes or with storage blocked.
  }
}

function readPointer(key: string): Pointer | null {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Pointer>;
    if (p.v !== 1 || typeof p.sessionId !== 'string' || typeof p.participantId !== 'string')
      return null;
    if (p.state !== 'active' && p.state !== 'withdrawn') return null;
    return p as Pointer;
  } catch {
    return null;
  }
}

function writePointer(key: string, pointer: Pointer): void {
  try {
    storage()?.setItem(key, JSON.stringify(pointer));
  } catch {
    // Without sessionStorage there's no reload recovery; the session itself still works.
  }
}

function removePointer(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // See writePointer.
  }
}
