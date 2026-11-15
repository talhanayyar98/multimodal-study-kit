import { round3 } from '../clock.js';
import type { StreamStats } from '../manifest.js';

/**
 * Exact per-stream statistics, computed in one pass over a stream's timestamps.
 *
 * Inter-sample intervals are kept (8 bytes each) so p50/p95 are exact rather than sketched. A
 * stream is processed at a time, so memory is bounded by the largest stream: 30 minutes at
 * 240 Hz is ~3.5 MB. Percentiles use linear interpolation (the numpy/pandas default) and `sd` is
 * the sample standard deviation (n − 1).
 */
export class StatsAccumulator {
  #count = 0;
  #first: number | null = null;
  #last: number | null = null;
  #sorted = true;
  #intervals = new Float64Array(1024);
  #n = 0;
  readonly #withIntervals: boolean;

  constructor(withIntervals: boolean) {
    this.#withIntervals = withIntervals;
  }

  add(t: number): void {
    this.#count++;
    if (this.#first === null) this.#first = t;
    if (this.#last !== null) {
      if (t < this.#last) this.#sorted = false;
      if (this.#withIntervals) this.#push(t - this.#last);
    }
    this.#last = t;
  }

  /** False if any timestamp was smaller than the previous one. */
  get sorted(): boolean {
    return this.#sorted;
  }

  #push(interval: number): void {
    if (this.#n === this.#intervals.length) {
      const grown = new Float64Array(this.#intervals.length * 2);
      grown.set(this.#intervals);
      this.#intervals = grown;
    }
    this.#intervals[this.#n++] = interval;
  }

  result(): StreamStats {
    return {
      count: this.#count,
      firstT: this.#first === null ? null : round3(this.#first),
      lastT: this.#last === null ? null : round3(this.#last),
      intervalMs:
        this.#withIntervals && this.#sorted
          ? intervalSummary(this.#intervals.subarray(0, this.#n))
          : null,
    };
  }
}

/** Interval summary, or null for fewer than two samples. */
export function intervalSummary(intervals: Float64Array): StreamStats['intervalMs'] {
  const n = intervals.length;
  if (n === 0) return null;
  let sum = 0;
  for (const x of intervals) sum += x;
  const mean = sum / n;
  let sq = 0;
  for (const x of intervals) sq += (x - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  const sorted = Float64Array.from(intervals).sort();
  return {
    mean: round3(mean),
    sd: round3(sd),
    p50: round3(quantile(sorted, 0.5)),
    p95: round3(quantile(sorted, 0.95)),
    max: round3(sorted[n - 1] ?? 0),
  };
}

/** Linear-interpolation quantile of sorted data (numpy's default `method='linear'`). */
export function quantile(sorted: Float64Array, q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}
