import type { ClockAnchor, ClockDiscontinuity, ClockSegment, SessionMs } from './manifest.js';

/**
 * Where the clock reads time from. Injected so the clock math can be unit-tested with fake time.
 * In the browser, `now` and every `event.timeStamp`, rAF and rVFC timestamp share one timebase
 * (the page's `performance.timeOrigin`).
 */
export interface TimeSource {
  /** Monotonic ms since `timeOrigin` (`performance.now()`). */
  now(): number;
  /** Wall-clock Unix ms (`Date.now()`). Can jump: NTP, manual changes, sleep. */
  wallNow(): number;
  /** `performance.timeOrigin` of this page load (Unix ms). */
  timeOrigin(): number;
}

export const browserTimeSource: TimeSource = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  timeOrigin: () => performance.timeOrigin,
};

/** If wall-clock and monotonic elapsed time differ by more than this between anchors, record it. */
export const DISCONTINUITY_THRESHOLD_MS = 250;

/** Persisted clock state: everything needed to continue the session clock after a reload. */
export interface ClockState {
  segments: ClockSegment[];
  anchors: ClockAnchor[];
  discontinuities: ClockDiscontinuity[];
}

/** Last moment the session is known to have been alive (persisted with every flush). */
export interface LastSeen {
  t: SessionMs;
  wallClockMs: number;
}

/**
 * The session clock. `t` is milliseconds since session start.
 *
 * Within one page load (a *segment*), `t = perfNow − segment.perfNow + segment.t`, which is
 * monotonic and as precise as `performance.now()`. A reload starts a new segment. There is no
 * monotonic clock that spans page loads, so the new segment's start `t` is estimated from the wall
 * clock and the gap is recorded as a `reload-gap` discontinuity.
 */
export class SessionClock {
  readonly #src: TimeSource;
  readonly #state: ClockState;
  #segment: ClockSegment;

  private constructor(src: TimeSource, state: ClockState, segment: ClockSegment) {
    this.#src = src;
    this.#state = state;
    this.#segment = segment;
  }

  /** Start a new session clock: segment 0 begins at `t = 0` now. */
  static start(src: TimeSource = browserTimeSource): SessionClock {
    const perfNow = src.now();
    const segment: ClockSegment = {
      index: 0,
      reason: 'start',
      t: 0,
      wallClockMs: src.wallNow(),
      timeOrigin: src.timeOrigin(),
      perfNow,
    };
    const clock = new SessionClock(
      src,
      { segments: [segment], anchors: [], discontinuities: [] },
      segment,
    );
    clock.anchor();
    return clock;
  }

  /**
   * Continue a session after a page reload. The new segment starts at
   * `lastSeen.t + (wall now − lastSeen.wallClockMs)`. That is never earlier than `lastSeen.t`, so
   * `t` stays monotonic across segments even if the wall clock went backwards.
   */
  static resume(
    previous: ClockState,
    lastSeen: LastSeen,
    src: TimeSource = browserTimeSource,
  ): SessionClock {
    const state: ClockState = structuredClone(previous);
    const wallNow = src.wallNow();
    const gap = wallNow - lastSeen.wallClockMs;
    const t = lastSeen.t + Math.max(0, gap);
    const segment: ClockSegment = {
      index: state.segments.length,
      reason: 'reload-resume',
      t,
      wallClockMs: wallNow,
      timeOrigin: src.timeOrigin(),
      perfNow: src.now(),
    };
    state.segments.push(segment);
    state.discontinuities.push({ t, kind: 'reload-gap', magnitudeMs: round3(gap) });
    const clock = new SessionClock(src, state, segment);
    clock.anchor();
    return clock;
  }

  /** Current session time. */
  now(): SessionMs {
    return this.fromPerf(this.#src.now());
  }

  /**
   * Convert a timestamp on the page's `performance.now()` timebase (`event.timeStamp`, rAF and
   * rVFC timestamps) to session time. Don't pass worker-side `performance.now()` values: workers
   * have their own time origin.
   */
  fromPerf(perfTimestamp: number): SessionMs {
    return perfTimestamp - this.#segment.perfNow + this.#segment.t;
  }

  /** Current wall-clock time (for ISO timestamps in the manifest). */
  wallNow(): number {
    return this.#src.wallNow();
  }

  get segmentIndex(): number {
    return this.#segment.index;
  }

  /**
   * Record a (perf, wall) anchor pair. If wall-clock and monotonic time diverged by more than
   * {@link DISCONTINUITY_THRESHOLD_MS} since the previous anchor in this segment, a discontinuity
   * is recorded and returned.
   *
   * The sign tells you which clock moved more, not why: a positive divergence (`suspend`) usually
   * means the monotonic clock stood still (system sleep, frozen tab) but could also be a forward
   * wall-clock jump. A negative divergence is reported as `wallclock-jump`.
   */
  anchor(): ClockDiscontinuity | null {
    const perfNow = this.#src.now();
    const wallClockMs = this.#src.wallNow();
    const t = this.fromPerf(perfNow);
    const previous = this.#state.anchors.at(-1);
    this.#state.anchors.push({ segment: this.#segment.index, t, wallClockMs, perfNow });

    if (previous?.segment !== this.#segment.index) return null;
    const divergence = wallClockMs - previous.wallClockMs - (perfNow - previous.perfNow);
    if (Math.abs(divergence) <= DISCONTINUITY_THRESHOLD_MS) return null;
    const discontinuity: ClockDiscontinuity = {
      t,
      kind: divergence > 0 ? 'suspend' : 'wallclock-jump',
      magnitudeMs: round3(divergence),
    };
    this.#state.discontinuities.push(discontinuity);
    return discontinuity;
  }

  /** A copy of the clock state, for persistence and the manifest. */
  snapshot(): ClockState {
    return structuredClone(this.#state);
  }
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
