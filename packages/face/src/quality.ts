/** Per-second quality rows and a whole-session summary for the face sensor. Pure, tested in Node. */

function percentile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] ?? 0;
  return a + ((s[hi] ?? a) - a) * (pos - lo);
}

const round = (x: number | null, p: number) =>
  x === null ? null : Math.round(x * 10 ** p) / 10 ** p;

interface Counts {
  delivered: number;
  skipped: number;
  dropped: number;
  processed: number;
  faces: number;
  brightnessSum: number;
  inference: number[];
  latency: number[];
}

const empty = (): Counts => ({
  delivered: 0,
  skipped: 0,
  dropped: 0,
  processed: 0,
  faces: 0,
  brightnessSum: 0,
  inference: [],
  latency: [],
});

export class QualityTracker {
  #window = empty();
  #total = empty();
  #windowStart: number;
  #activeMs = 0;
  readonly #timing = new Map<string, number>();

  constructor(startT: number) {
    this.#windowStart = startT;
  }

  delivered(): void {
    this.#window.delivered++;
    this.#total.delivered++;
  }

  skipped(): void {
    this.#window.skipped++;
    this.#total.skipped++;
  }

  dropped(): void {
    this.#window.dropped++;
    this.#total.dropped++;
  }

  result(
    face: boolean,
    brightness: number,
    inferenceMs: number,
    latencyMs: number,
    timing: string,
  ): void {
    for (const c of [this.#window, this.#total]) {
      c.processed++;
      if (face) c.faces++;
      c.brightnessSum += brightness;
      c.inference.push(inferenceMs);
      c.latency.push(latencyMs);
    }
    this.#timing.set(timing, (this.#timing.get(timing) ?? 0) + 1);
  }

  /** Close the current window at `t` and return its row (without `t`). */
  takeWindow(t: number): Record<string, number | null> {
    const w = this.#window;
    const seconds = Math.max(1e-3, (t - this.#windowStart) / 1000);
    this.#activeMs += t - this.#windowStart;
    this.#windowStart = t;
    this.#window = empty();
    return {
      effective_fps: round(w.processed / seconds, 2),
      frames_delivered: w.delivered,
      frames_skipped: w.skipped,
      frames_dropped: w.dropped,
      face_present_ratio: w.processed ? round(w.faces / w.processed, 3) : null,
      brightness: w.processed ? round(w.brightnessSum / w.processed, 3) : null,
      inference_ms_p50: round(percentile(w.inference, 0.5), 2),
      inference_ms_p95: round(percentile(w.inference, 0.95), 2),
      latency_ms_p50: round(percentile(w.latency, 0.5), 2),
    };
  }

  /** Restart the window clock without counting the gap (e.g. after a pause). */
  restart(t: number): void {
    this.#windowStart = t;
    this.#window = empty();
  }

  /** Whole-session summary for `manifest.quality.face`. */
  summary(): Record<string, unknown> {
    const c = this.#total;
    return {
      framesDelivered: c.delivered,
      framesProcessed: c.processed,
      framesSkippedByLimiter: c.skipped,
      framesDroppedBusy: c.dropped,
      effectiveFps: this.#activeMs > 0 ? round(c.processed / (this.#activeMs / 1000), 2) : null,
      facePresentRatio: c.processed ? round(c.faces / c.processed, 3) : null,
      brightnessMean: c.processed ? round(c.brightnessSum / c.processed, 3) : null,
      inferenceMs: {
        p50: round(percentile(c.inference, 0.5), 2),
        p95: round(percentile(c.inference, 0.95), 2),
      },
      latencyMs: {
        p50: round(percentile(c.latency, 0.5), 2),
        p95: round(percentile(c.latency, 0.95), 2),
      },
      timingSources: Object.fromEntries(this.#timing),
    };
  }
}

/**
 * Frame limiter: process a frame if at least 75 % of the target interval has passed since the
 * last processed one. The slack absorbs camera jitter, so a 30 fps camera at a 15 fps target
 * yields every second frame rather than drifting.
 */
export function shouldProcess(perfTs: number, lastProcessed: number | null, fps: number): boolean {
  if (lastProcessed === null) return true;
  return perfTs - lastProcessed >= (1000 / fps) * 0.75;
}
