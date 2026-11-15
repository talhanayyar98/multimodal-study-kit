import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bundleToZip,
  createSession,
  downloadSink,
  MemoryStore,
  SessionStateError,
} from '../src/index.js';
import type {
  ChunkStore,
  SessionBundle,
  SessionConfig,
  Sink,
  WithdrawalNotice,
} from '../src/index.js';
import { fakeSensor, fakeTime, schemaErrors, unzipBlob } from './helpers.js';

/** A Storage stand-in so the reload pointer works under Node. */
class MapStorage {
  readonly #m = new Map<string, string>();
  getItem(k: string) {
    return this.#m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.#m.set(k, v);
  }
  removeItem(k: string) {
    this.#m.delete(k);
  }
  keys() {
    return [...this.#m.keys()];
  }
}

/** Records bundles and, like any real sink, reads their files inside onEnd. */
function captureSink() {
  const ended: SessionBundle[] = [];
  const files: Record<string, string>[] = [];
  const withdrawn: WithdrawalNotice[] = [];
  const sink: Sink = {
    name: 'capture',
    async onEnd(bundle) {
      ended.push(bundle);
      files.push(await readBundle(bundle));
    },
    onWithdraw(notice) {
      withdrawn.push(notice);
      return Promise.resolve();
    },
  };
  return { sink, ended, files, withdrawn };
}

async function readBundle(bundle: SessionBundle): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of bundle.files) {
    let text = '';
    for await (const piece of file.text()) text += piece;
    out[file.path] = text;
  }
  return out;
}

function setup(overrides: Partial<SessionConfig> = {}) {
  const time = fakeTime();
  const a = fakeSensor('alpha', { optIn: true });
  const b = fakeSensor('beta');
  const capture = captureSink();
  const store = new MemoryStore();
  const config: SessionConfig = {
    studyId: 'unit-study',
    participantId: 'P001',
    sensors: [a, b],
    sinks: [capture.sink],
    storage: store,
    timeSource: time.src,
    ...overrides,
  };
  return { time, a, b, capture, store, config };
}

describe('session lifecycle', () => {
  it('records only consented sensors and exports a schema-valid bundle', async () => {
    const { time, a, b, capture, store, config } = setup();
    const session = await createSession(config);
    expect(session.state).toBe('created');
    expect(session.resumed).toBe(false);

    const states: string[] = [];
    session.on('state', (s) => states.push(s));

    const consent = await session.consent({
      textVersion: 'v3',
      text: 'You agree.',
      granted: ['alpha'],
    });
    expect(consent.decisions).toEqual({ alpha: 'granted', beta: 'declined' });
    expect(consent.options).toEqual({ 'alpha.secret': 'declined' });
    expect(consent.textSha256).toMatch(/^[0-9a-f]{64}$/);

    const started = await session.start();
    expect(started).toEqual({ started: ['alpha'], declined: ['beta'], failed: [] });
    expect(a.startCalls).toBe(1);
    expect(b.startCalls).toBe(0); // enforcement: never even called

    const ctx = a.ctx;
    if (!ctx) throw new Error('alpha did not start');
    time.advance(10);
    expect(
      ctx.emit('alpha.samples', {
        t: ctx.clock.now(),
        value: 1.234,
        count: 1,
        flag: true,
        label: 'x,y',
        kind: 'a',
      }),
    ).toBe(true);
    time.advance(10);
    expect(
      ctx.emit('alpha.samples', {
        t: ctx.clock.now(),
        value: 2,
        count: 2,
        flag: false,
        label: null,
        kind: 'b',
      }),
    ).toBe(true);
    ctx.emit('alpha.events', { t: ctx.clock.now(), type: 'hello', data: { n: 1 } });
    expect(session.mark('stimulus_onset', { item: 3 })).toBe(20);
    expect(await session.markOnNextFrame('frame_marker')).toBe(20); // no rAF in Node → mark()

    time.advance(5);
    session.pause();
    expect(a.paused).toBe(1);
    expect(ctx.emit('alpha.samples', { t: ctx.clock.now(), value: 3 })).toBe(false); // dropped while paused
    session.mark('during_pause');
    time.advance(100);
    session.resume();
    time.advance(5);
    ctx.emit('alpha.samples', { t: ctx.clock.now(), value: 4 });

    time.advance(10);
    const result = await session.end();
    expect(session.state).toBe('ended');
    expect(states).toEqual(['consented', 'running', 'paused', 'running', 'ended']);
    expect(a.stopCalls).toBe(1);
    expect(result.sinks).toEqual([{ name: 'capture', ok: true }]);
    expect(result.localDataDeleted).toBe(true);
    expect(await store.load(session.id)).toBeUndefined();

    const m = result.manifest;
    expect(schemaErrors(m)).toBe('');
    expect(m.session).toMatchObject({
      status: 'completed',
      participantId: 'P001',
      durationMs: 140,
      pauses: [{ startT: 25, endT: 125 }],
    });
    expect(m.sensors.map((s) => [s.id, s.enabled, s.notes])).toEqual([
      ['alpha', true, undefined],
      ['beta', false, ['not started: consent declined']],
    ]);
    expect(m.quality).toEqual({ alpha: { ok: true } });
    expect(m.privacy.keyIdentityRecorded).toBe(false);
    expect(m.environment.persistence).toBe('memory');
    expect(m.toolkit.packages).toEqual({
      '@mmstudykit/core': '0.0.0',
      '@mmstudykit/test': '0.0.0',
    });
    expect(m.streams.map((s) => s.name)).toEqual([
      'session.events',
      'task.markers',
      'alpha.samples',
      'alpha.events',
    ]);
    // The opt-in column is absent because the option was declined.
    expect(m.streams[2]?.columns.map((c) => c.name)).toEqual([
      't',
      'value',
      'count',
      'flag',
      'label',
      'kind',
    ]);
    expect(m.streams[2]?.stats).toEqual({
      count: 3,
      firstT: 10,
      lastT: 130,
      intervalMs: { mean: 60, sd: 70.711, p50: 60, p95: 105, max: 110 },
    });

    const [bundle] = capture.ended;
    const [files = {}] = capture.files;
    if (!bundle) throw new Error('sink not called');
    // After end() deleted local data, the lazily-read bundle refuses instead of returning nothing.
    await expect(readBundle(bundle)).rejects.toThrow(/no longer readable/);
    expect(files['streams/alpha.samples.csv']).toBe(
      't,value,count,flag,label,kind\n' +
        '10.000,1.23,1,1,"x,y",a\n' +
        '20.000,2.00,2,0,,b\n' +
        '130.000,4.00,,,,\n',
    );
    expect(files['streams/task.markers.jsonl']).toBe(
      '{"t":20,"name":"stimulus_onset","source":"api","data":{"item":3}}\n' +
        '{"t":20,"name":"frame_marker","source":"api","data":null}\n' +
        '{"t":25,"name":"during_pause","source":"api","data":null}\n',
    );
    const events = (files['streams/session.events.jsonl'] ?? '')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(events).toEqual(['start', 'sensor_started', 'pause', 'resume', 'sensor_stopped', 'end']);
  });

  it('grants opt-ins only through the consent record', async () => {
    const { a, config } = setup();
    const session = await createSession(config);
    await session.consent({
      textVersion: 'v1',
      granted: ['alpha'],
      grantedOptions: ['alpha.secret'],
    });
    await session.start();
    expect(a.ctx?.granted).toEqual(new Set(['secret']));
    const { manifest } = await session.end();
    expect(manifest.privacy.keyIdentityRecorded).toBe(true);
    expect(manifest.consent.options).toEqual({ 'alpha.secret': 'granted' });
    expect(manifest.streams.find((s) => s.name === 'alpha.samples')?.columns.at(-1)?.name).toBe(
      'secret',
    );
  });

  it('rejects consent for sensors or options that are not configured', async () => {
    const { config } = setup();
    const session = await createSession(config);
    await expect(session.consent({ textVersion: 'v1', granted: ['alpah'] })).rejects.toThrow(
      /not a configured sensor/,
    );
    await expect(
      session.consent({ textVersion: 'v1', granted: [], grantedOptions: ['beta.secret'] }),
    ).rejects.toThrow(/not a requested option/);
    await expect(session.consent({ textVersion: '', granted: [] })).rejects.toThrow(/textVersion/);
    expect(session.state).toBe('created');
  });

  it('enforces the state machine', async () => {
    const { config } = setup();
    const session = await createSession(config);
    await expect(session.start()).rejects.toBeInstanceOf(SessionStateError);
    expect(() => session.mark('x')).toThrow(SessionStateError);
    await expect(session.end()).rejects.toThrow(/not allowed in state "created"/);
    await session.consent({ textVersion: 'v1', granted: [] });
    await expect(session.consent({ textVersion: 'v1', granted: [] })).rejects.toThrow(
      SessionStateError,
    );
    await session.start();
    await expect(session.start()).rejects.toThrow(SessionStateError);
    expect(() => {
      session.resume();
    }).toThrow(SessionStateError);
    await session.end();
    expect(() => session.mark('late')).toThrow(SessionStateError);
  });

  it('validates identifiers and catches email addresses as participant IDs', async () => {
    await expect(createSession({ studyId: 'ok', participantId: 'jane@uni.edu' })).rejects.toThrow(
      /email address/,
    );
    await expect(createSession({ studyId: 'has space', participantId: 'P1' })).rejects.toThrow(
      /studyId/,
    );
    const dup = [fakeSensor('same'), fakeSensor('same')];
    await expect(
      createSession({ studyId: 's', participantId: 'P1', sensors: dup, storage: 'memory' }),
    ).rejects.toThrow(/share the id/);
    await expect(
      createSession({
        studyId: 's',
        participantId: 'P1',
        sensors: [fakeSensor('task')],
        storage: 'memory',
      }),
    ).rejects.toThrow(/reserved/);
  });

  it('records sample-guard rejections in session.events and the sensor notes', async () => {
    const { a, config } = setup();
    const session = await createSession(config);
    const warnings: string[] = [];
    session.on('warning', (w) => warnings.push(w.message));
    await session.consent({ textVersion: 'v1', granted: ['alpha'] });
    await session.start();
    const ctx = a.ctx;
    if (!ctx) throw new Error('not started');
    for (let i = 0; i < 12; i++) {
      expect(
        ctx.emit('alpha.events', {
          t: 1,
          type: 'frame',
          data: { pixels: new Uint8ClampedArray(4) },
        }),
      ).toBe(false);
    }
    expect(ctx.emit('beta.samples', { t: 1 })).toBe(false);
    expect(warnings).toHaveLength(2);
    const { manifest } = await session.end();
    expect(manifest.sensors[0]?.notes).toEqual([
      '12 row(s) of alpha.events rejected by the sample guard',
      '1 row(s) of beta.samples rejected by the sample guard',
    ]);
    expect(manifest.streams.find((s) => s.name === 'alpha.events')?.stats.count).toBe(0);
    const rejected = manifest.streams.find((s) => s.name === 'session.events')?.stats.count;
    expect(rejected).toBe(1 + 1 + 10 + 1 + 1 + 1 + 1); // start, sensor_started, 10+1 logged, summary, stopped, end
  });

  it('continues without a sensor that fails to start', async () => {
    const broken = fakeSensor('broken', { failStart: true });
    const { config } = setup({ sensors: [broken, fakeSensor('fine')] });
    const session = await createSession(config);
    await session.consent({ textVersion: 'v1', granted: ['broken', 'fine'] });
    const result = await session.start();
    expect(result).toEqual({
      started: ['fine'],
      declined: [],
      failed: [{ sensorId: 'broken', error: 'no device' }],
    });
    const { manifest } = await session.end();
    expect(manifest.sensors[0]).toMatchObject({
      id: 'broken',
      enabled: false,
      notes: ['start failed: no device'],
    });
    expect(schemaErrors(manifest)).toBe('');
  });

  it('sorts rows that arrive out of time order (e.g. keystrokes completed at key-up)', async () => {
    const { a, config, capture } = setup();
    const session = await createSession(config);
    await session.consent({ textVersion: 'v1', granted: ['alpha'] });
    await session.start();
    const ctx = a.ctx;
    if (!ctx) throw new Error('not started');
    for (const t of [30, 10, 20]) ctx.emit('alpha.events', { t, type: `at${t}`, data: null });
    await session.end();
    const bundle = capture.ended[0];
    const files = capture.files[0] ?? {};
    if (!bundle) throw new Error('no bundle');
    expect(
      files['streams/alpha.events.jsonl']
        ?.trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as { t: number }).t),
    ).toEqual([10, 20, 30]);
    expect(bundle.manifest.streams.find((s) => s.name === 'alpha.events')?.stats).toMatchObject({
      firstT: 10,
      lastT: 30,
    });
  });
});

describe('sinks and local data', () => {
  it('keeps local data when a sink fails, so the bundle can be exported again', async () => {
    const failing: Sink = { name: 'flaky', onEnd: () => Promise.reject(new Error('offline')) };
    const { config, store } = setup({ sinks: [failing] });
    const session = await createSession(config);
    await session.consent({ textVersion: 'v1', granted: ['alpha'] });
    await session.start();
    const result = await session.end();
    expect(result.sinks).toEqual([{ name: 'flaky', ok: false, error: 'offline' }]);
    expect(result.localDataDeleted).toBe(false);
    expect(await store.load(session.id)).toBeDefined();
    const again = await session.exportBundle();
    expect(again.manifest.session.status).toBe('completed');
  });

  it('exports an incomplete bundle while running', async () => {
    const { config } = setup();
    const session = await createSession(config);
    await session.consent({ textVersion: 'v1', granted: ['alpha'] });
    await session.start();
    session.mark('half_way');
    const bundle = await session.exportBundle();
    expect(bundle.manifest.session).toMatchObject({
      status: 'incomplete',
      endedAt: null,
      durationMs: null,
    });
    expect(schemaErrors(bundle.manifest)).toBe('');
    await session.end();
  });

  it('downloadSink zips manifest + streams under session_<id>/ with a fixed timestamp', async () => {
    const saved: { blob: Blob; name: string }[] = [];
    const { config, a } = setup({
      sinks: [downloadSink({ save: (blob, name) => void saved.push({ blob, name }) })],
    });
    const session = await createSession(config);
    await session.consent({ textVersion: 'v1', granted: ['alpha'] });
    await session.start();
    a.ctx?.emit('alpha.samples', { t: 1, value: 1 });
    await session.end();
    expect(saved).toHaveLength(1);
    const [{ blob, name } = { blob: new Blob(), name: '' }] = saved;
    expect(name).toBe(`session_${session.id}.zip`);
    expect(blob.type).toBe('application/zip');
    const files = await unzipBlob(blob);
    const root = `session_${session.id}`;
    expect(Object.keys(files).sort()).toEqual(
      [
        'manifest.json',
        'streams/alpha.events.jsonl',
        'streams/alpha.samples.csv',
        'streams/session.events.jsonl',
        'streams/task.markers.jsonl',
      ].map((p) => `${root}/${p}`),
    );
    expect(schemaErrors(JSON.parse(files[`${root}/manifest.json`] ?? '{}'))).toBe('');
    expect(files[`${root}/streams/alpha.samples.csv`]).toBe(
      't,value,count,flag,label,kind\n1.000,1.00,,,,\n',
    );

    // DOS date/time of every local file header = 1980-01-01 00:00:00 (date 0x0021, time 0).
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let headers = 0;
    for (let i = 0; i + 4 < bytes.length; i++) {
      if (view.getUint32(i, true) === 0x04034b50) {
        expect(view.getUint16(i + 10, true)).toBe(0);
        expect(view.getUint16(i + 12, true)).toBe(0x0021);
        headers++;
      }
    }
    expect(headers).toBe(5);
  });

  it('bundleToZip is deterministic for the same bundle', async () => {
    const kept = setup({ keepLocalData: true });
    const s2 = await createSession(kept.config);
    await s2.consent({ textVersion: 'v1', granted: ['alpha'] });
    await s2.start();
    await s2.end();
    const b2 = kept.capture.ended[0];
    if (!b2) throw new Error('no bundle');
    const [z1, z2] = await Promise.all([bundleToZip(b2), bundleToZip(b2)]);
    expect(new Uint8Array(await z1.arrayBuffer())).toEqual(new Uint8Array(await z2.arrayBuffer()));
  });
});

describe('withdrawal', () => {
  it('stops sensors, deletes local data, notifies sinks and leaves a schema-valid stub', async () => {
    const { a, capture, config, store, time } = setup();
    const session = await createSession(config);
    await session.consent({ textVersion: 'v1', granted: ['alpha'] });
    await session.start();
    a.ctx?.emit('alpha.samples', { t: 1, value: 1 });
    await session.flush();
    expect(await store.load(session.id)).toBeDefined();
    time.advance(3000);

    const { manifest, sinks } = await session.withdraw();
    expect(session.state).toBe('withdrawn');
    expect(a.stopCalls).toBe(1);
    expect(sinks).toEqual([{ name: 'capture', ok: true }]);
    expect(await store.load(session.id)).toBeUndefined();
    expect(capture.ended).toHaveLength(0);
    expect(capture.withdrawn).toHaveLength(1);
    expect(capture.withdrawn[0]?.manifest).toEqual(manifest);

    expect(manifest).not.toBeNull();
    expect(schemaErrors(manifest)).toBe('');
    expect(manifest?.session).toMatchObject({ status: 'withdrawn', durationMs: 3000 });
    expect(manifest?.streams).toEqual([]);
    expect(manifest?.consent.withdrawal).toMatchObject({ t: 3000 });
    expect(a.ctx?.emit('alpha.samples', { t: 2, value: 1 })).toBe(false);
    await expect(session.withdraw()).resolves.toEqual({ manifest: null, sinks: [] });
  });

  it('works before start (no stub) and after end', async () => {
    const early = setup();
    const s1 = await createSession(early.config);
    await s1.consent({ textVersion: 'v1', granted: ['alpha'] });
    const r1 = await s1.withdraw();
    expect(r1.manifest).toBeNull();
    expect(early.capture.withdrawn[0]?.manifest).toBeNull();

    const late = setup();
    const s2 = await createSession(late.config);
    await s2.consent({ textVersion: 'v1', granted: ['alpha'] });
    await s2.start();
    await s2.end();
    const r2 = await s2.withdraw();
    expect(r2.manifest?.session.status).toBe('withdrawn');
    expect(late.capture.withdrawn).toHaveLength(1);
  });
});

describe('resume after reload', () => {
  let storage: MapStorage;
  beforeEach(() => {
    storage = new MapStorage();
    vi.stubGlobal('sessionStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('continues the same session in a new clock segment', async () => {
    const time = fakeTime();
    const store: ChunkStore = new MemoryStore();
    const capture = captureSink();
    const make = () => {
      const sensor = fakeSensor('alpha');
      const config: SessionConfig = {
        studyId: 'resume-study',
        participantId: 'P9',
        sensors: [sensor],
        sinks: [capture.sink],
        storage: store,
        timeSource: time.src,
      };
      return { sensor, config };
    };

    const first = make();
    const s1 = await createSession(first.config);
    await s1.consent({ textVersion: 'v1', granted: ['alpha'] });
    await s1.start();
    time.advance(1000);
    first.sensor.ctx?.emit('alpha.samples', { t: first.sensor.ctx.clock.now(), value: 1 });
    time.advance(500);
    s1.pause();
    await s1.flush();
    expect(storage.keys()).toEqual(['mmstudykit:resume-study']);
    // The page reloads 2 s later. s1 is simply abandoned, as it would be on unload.
    time.reload(2000);

    const second = make();
    const s2 = await createSession(second.config);
    expect(s2.resumed).toBe(true);
    expect(s2.id).toBe(s1.id);
    expect(s2.state).toBe('consented');
    await expect(s2.consent({ textVersion: 'v1', granted: ['alpha'] })).rejects.toThrow(
      SessionStateError,
    );
    await s2.start();
    expect(s2.now()).toBe(3500);
    second.sensor.ctx?.emit('alpha.samples', { t: s2.now(), value: 2 });
    time.advance(100);
    const { manifest } = await s2.end();

    expect(schemaErrors(manifest)).toBe('');
    expect(manifest.clock.segments.map((s) => [s.index, s.reason, s.t])).toEqual([
      [0, 'start', 0],
      [1, 'reload-resume', 3500],
    ]);
    expect(manifest.clock.discontinuities).toEqual([
      { t: 3500, kind: 'reload-gap', magnitudeMs: 2000 },
    ]);
    expect(manifest.session.pauses).toEqual([{ startT: 1500, endT: 1500 }]); // closed at last-seen time
    expect(manifest.streams.find((s) => s.name === 'alpha.samples')?.stats).toMatchObject({
      count: 2,
      firstT: 1000,
      lastT: 3500,
    });
    const files = capture.files[0] ?? {};
    const types = (files['streams/session.events.jsonl'] ?? '')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain('segment');
    expect(storage.keys()).toEqual([]);
  });

  it('stops the old page once another page resumed the session (bfcache, multi-page studies)', async () => {
    const store = new MemoryStore();
    const config: SessionConfig = { studyId: 'takeover', participantId: 'P5', storage: store };
    const oldPage = await createSession(config);
    await oldPage.consent({ textVersion: 'v1', granted: [] });
    await oldPage.start();
    oldPage.mark('old');
    await oldPage.flush();
    const warnings: string[] = [];
    oldPage.on('warning', (w) => warnings.push(w.message));

    const newPage = await createSession(config);
    expect(newPage.resumed).toBe(true);
    // The old page comes back (e.g. from the back/forward cache) and tries to write.
    oldPage.mark('stale');
    await oldPage.flush();
    expect(oldPage.state).toBe('superseded');
    expect(warnings).toEqual([
      'this session was resumed in another page; this page stopped recording',
    ]);
    expect(() => oldPage.mark('again')).toThrow(SessionStateError);

    await newPage.start();
    newPage.mark('new');
    const { manifest } = await newPage.end();
    expect(manifest.streams.find((s) => s.name === 'task.markers')?.stats.count).toBe(2); // old + new, not stale
  });

  it('starts fresh for a different participant or after the session ended', async () => {
    const store = new MemoryStore();
    const base = { studyId: 'resume-study', storage: store } as const;
    const s1 = await createSession({ ...base, participantId: 'P1' });
    await s1.consent({ textVersion: 'v1', granted: [] });
    const s2 = await createSession({ ...base, participantId: 'P2' });
    expect(s2.resumed).toBe(false);
    expect(s2.id).not.toBe(s1.id);
    const s3 = await createSession({ ...base, participantId: 'P1' });
    expect(s3.resumed).toBe(false); // P2's createSession cleared P1's pointer
  });

  it('comes back withdrawn after a withdrawal in this tab', async () => {
    const config: SessionConfig = {
      studyId: 'w-study',
      participantId: 'P3',
      storage: new MemoryStore(),
    };
    const s1 = await createSession(config);
    await s1.consent({ textVersion: 'v1', granted: [] });
    await s1.start();
    await s1.withdraw();
    const s2 = await createSession(config);
    expect(s2.state).toBe('withdrawn');
    expect(s2.id).toBe(s1.id);
    await expect(s2.start()).rejects.toThrow(SessionStateError);
  });

  it('ignores the pointer when resume is disabled', async () => {
    const config: SessionConfig = {
      studyId: 'r-study',
      participantId: 'P4',
      storage: new MemoryStore(),
    };
    const s1 = await createSession(config);
    await s1.consent({ textVersion: 'v1', granted: [] });
    const s2 = await createSession({ ...config, resume: false });
    expect(s2.resumed).toBe(false);
  });
});

describe('recorder', () => {
  it('flushes by row count and retries failed writes', async () => {
    const inner = new MemoryStore();
    let failNext = 1;
    const flaky: ChunkStore = {
      kind: 'memory',
      write: (record, chunks) =>
        failNext-- > 0
          ? Promise.reject(new Error('QuotaExceededError'))
          : inner.write(record, chunks),
      load: (id) => inner.load(id),
      chunks: (id, s) => inner.chunks(id, s),
      delete: (id) => inner.delete(id),
      close: () => undefined,
    };
    const { a, config } = setup({
      storage: flaky,
      recorder: { flushRows: 3, flushIntervalMs: 60_000 },
      keepLocalData: true,
    });
    const session = await createSession(config);
    const warnings: string[] = [];
    session.on('warning', (w) => warnings.push(w.message));
    await expect(session.consent({ textVersion: 'v1', granted: ['alpha'] })).rejects.toThrow(
      'QuotaExceededError',
    );
    // consent() itself failed to persist; a real app would retry. Do that.
    const retry = await createSession({ ...config, storage: flaky });
    await retry.consent({ textVersion: 'v1', granted: ['alpha'] });
    await retry.start();
    for (let i = 0; i < 7; i++) a.ctx?.emit('alpha.samples', { t: i, value: i });
    await retry.flush();
    const { manifest } = await retry.end();
    expect(manifest.streams.find((s) => s.name === 'alpha.samples')?.stats.count).toBe(7);
    expect(warnings).toEqual([]);
  });

  it('keeps chunks of a failed flush and writes them on the next one', async () => {
    const inner = new MemoryStore();
    let fail = false;
    const flaky: ChunkStore = {
      kind: 'memory',
      write: (record, chunks) =>
        fail ? Promise.reject(new Error('disk full')) : inner.write(record, chunks),
      load: (id) => inner.load(id),
      chunks: (id, s) => inner.chunks(id, s),
      delete: (id) => inner.delete(id),
      close: () => undefined,
    };
    const { a, config } = setup({
      storage: flaky,
      recorder: { flushIntervalMs: 60_000 },
      keepLocalData: true,
    });
    const session = await createSession(config);
    const warnings: string[] = [];
    session.on('warning', (w) => warnings.push(w.message));
    await session.consent({ textVersion: 'v1', granted: ['alpha'] });
    await session.start();
    a.ctx?.emit('alpha.samples', { t: 1, value: 1 });
    fail = true;
    await session.flush();
    expect(warnings).toEqual(['storage write failed (will retry): disk full']);
    fail = false;
    a.ctx?.emit('alpha.samples', { t: 2, value: 2 });
    const { manifest } = await session.end();
    expect(manifest.streams.find((s) => s.name === 'alpha.samples')?.stats).toMatchObject({
      count: 2,
      firstT: 1,
      lastT: 2,
    });
    expect(manifest.streams.find((s) => s.name === 'session.events')?.stats.count).toBeGreaterThan(
      0,
    );
  });
});
