import { describe, expect, it } from 'vitest';

import { DISCONTINUITY_THRESHOLD_MS, SessionClock } from '../src/index.js';
import { fakeTime } from './helpers.js';

describe('SessionClock', () => {
  it('starts at t = 0 and follows performance.now()', () => {
    const time = fakeTime(1500);
    const clock = SessionClock.start(time.src);
    expect(clock.now()).toBe(0);
    time.advance(16.5);
    expect(clock.now()).toBe(16.5);
    expect(clock.fromPerf(1500 + 100.25)).toBe(100.25);
    const state = clock.snapshot();
    expect(state.segments).toEqual([
      {
        index: 0,
        reason: 'start',
        t: 0,
        wallClockMs: 1_794_736_800_000,
        timeOrigin: 1_794_736_798_500,
        perfNow: 1500,
      },
    ]);
    expect(state.anchors).toHaveLength(1);
  });

  it('converts event timestamps from before start to negative t (callers decide what to drop)', () => {
    const time = fakeTime(1000);
    const clock = SessionClock.start(time.src);
    expect(clock.fromPerf(990)).toBe(-10);
  });

  it('does not flag ordinary drift between anchors', () => {
    const time = fakeTime();
    const clock = SessionClock.start(time.src);
    time.advance(10_000, 10_000 + DISCONTINUITY_THRESHOLD_MS);
    expect(clock.anchor()).toBeNull();
    expect(clock.snapshot().discontinuities).toEqual([]);
  });

  it('records a suspend when the wall clock ran ahead of the monotonic clock (sleep)', () => {
    const time = fakeTime();
    const clock = SessionClock.start(time.src);
    time.advance(10_000);
    clock.anchor();
    time.advance(1000, 61_000); // perf barely moved while a minute passed
    const d = clock.anchor();
    expect(d).toEqual({ t: 11_000, kind: 'suspend', magnitudeMs: 60_000 });
    expect(clock.snapshot().discontinuities).toEqual([d]);
  });

  it('records a wallclock-jump when the wall clock went backwards', () => {
    const time = fakeTime();
    const clock = SessionClock.start(time.src);
    time.advance(10_000, -3_600_000 + 10_000);
    expect(clock.anchor()).toMatchObject({ kind: 'wallclock-jump', magnitudeMs: -3_600_000 });
  });

  it('continues after a reload in a new segment estimated from the wall clock', () => {
    const time = fakeTime(1000);
    const first = SessionClock.start(time.src);
    time.advance(5000);
    const lastSeen = { t: first.now(), wallClockMs: time.src.wallNow() };
    const state = first.snapshot();

    time.reload(1200, 80); // page reloads 1.2 s later; performance.now() restarts
    const second = SessionClock.resume(state, lastSeen, time.src);
    expect(second.segmentIndex).toBe(1);
    expect(second.now()).toBe(6200);
    time.advance(10);
    expect(second.now()).toBe(6210);
    expect(second.fromPerf(80)).toBe(6200);

    const snap = second.snapshot();
    expect(snap.segments[1]).toMatchObject({
      index: 1,
      reason: 'reload-resume',
      t: 6200,
      perfNow: 80,
    });
    expect(snap.discontinuities).toEqual([{ t: 6200, kind: 'reload-gap', magnitudeMs: 1200 }]);
    // The previous state was not mutated.
    expect(state.segments).toHaveLength(1);
  });

  it('never goes backwards across segments, even if the wall clock did', () => {
    const time = fakeTime();
    const first = SessionClock.start(time.src);
    time.advance(5000);
    const lastSeen = { t: first.now(), wallClockMs: time.src.wallNow() };
    time.reload(-60_000);
    const second = SessionClock.resume(first.snapshot(), lastSeen, time.src);
    expect(second.now()).toBe(5000);
    expect(second.snapshot().discontinuities[0]).toMatchObject({
      kind: 'reload-gap',
      magnitudeMs: -60_000,
    });
  });

  it('compares anchors only within a segment', () => {
    const time = fakeTime();
    const first = SessionClock.start(time.src);
    const lastSeen = { t: 0, wallClockMs: time.src.wallNow() };
    time.reload(100_000);
    const second = SessionClock.resume(first.snapshot(), lastSeen, time.src);
    time.advance(10_000);
    expect(second.anchor()).toBeNull();
  });
});
