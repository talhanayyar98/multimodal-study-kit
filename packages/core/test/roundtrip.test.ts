/**
 * TypeScript half of the cross-language round trip (Python half:
 * python/mmstudykit/tests/test_roundtrip.py).
 *
 * Runs a session with values chosen to break naive encoders, zips it with the real exporter and,
 * when MMSK_ROUNDTRIP_DIR is set (`pnpm roundtrip`, CI), writes `<name>.zip` plus
 * `<name>.expected.json`: the rows exactly as emitted, which Python compares against pandas.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bundleToZip, createSession, MemoryStore } from '../src/index.js';
import type { Sensor, SensorContext, Sink } from '../src/index.js';
import { fakeTime, schemaErrors, unzipBlob } from './helpers.js';

const outDir = process.env.MMSK_ROUNDTRIP_DIR;

type Row = Record<string, unknown>;

function tortureSensor(): Sensor & { ctx: SensorContext | null } {
  const sensor: Sensor & { ctx: SensorContext | null } = {
    id: 'torture',
    package: '@mmstudykit/test',
    version: '0.0.0',
    ctx: null,
    config: () => ({}),
    streams: () => [
      {
        name: 'torture.table',
        kind: 'samples',
        format: 'csv',
        nominalRateHz: 60,
        timestampSource: 'performance.now',
        columns: [
          {
            name: 'num_p2',
            type: 'number',
            unit: '1',
            description: 'Fixed 2 decimals.',
            precision: 2,
          },
          { name: 'num_free', type: 'number', unit: '1', description: 'Shortest round-trip.' },
          { name: 'int', type: 'integer', unit: null, description: 'Integer.' },
          { name: 'flag', type: 'boolean', unit: null, description: 'Boolean.' },
          { name: 'text', type: 'string', unit: null, description: 'Free text.' },
          {
            name: 'kind',
            type: 'enum',
            unit: null,
            description: 'Enum.',
            enumValues: ['alpha', 'beta', 'NA'],
          },
        ],
      },
      {
        name: 'torture.log',
        kind: 'events',
        format: 'jsonl',
        nominalRateHz: null,
        timestampSource: 'performance.now',
        columns: [
          { name: 'text', type: 'string', unit: null, description: 'Free text.' },
          { name: 'flag', type: 'boolean', unit: null, description: 'Boolean.' },
          { name: 'payload', type: 'object', unit: null, description: 'Nested.' },
        ],
      },
    ],
    describe: () => ({
      title: 'Torture',
      summary: '',
      records: [],
      neverRecords: [],
      rateHz: null,
    }),
    start(ctx) {
      sensor.ctx = ctx;
    },
    stop() {
      sensor.ctx = null;
    },
  };
  return sensor;
}

const TABLE_ROWS: Row[] = [
  { t: 0.0004, num_p2: 1.005, num_free: 0.1, int: 0, flag: true, text: 'plain', kind: 'alpha' },
  {
    t: 16.667,
    num_p2: -0.004,
    num_free: -1e-7,
    int: -42,
    flag: false,
    text: 'comma, "quote"',
    kind: 'beta',
  },
  {
    t: 33.333,
    num_p2: 123456.789,
    num_free: 1e21,
    int: Number.MAX_SAFE_INTEGER,
    flag: null,
    text: 'line\nbreak\r\nCRLF',
    kind: 'NA',
  },
  { t: 50, num_p2: null, num_free: null, int: null, flag: true, text: '', kind: null },
  {
    t: 66.667,
    num_p2: 0,
    num_free: 3.141592653589793,
    int: 7,
    flag: false,
    text: 'ünïcödé ☕ 漢字 🙂',
    kind: 'alpha',
  },
  { t: 83.333, num_p2: 2.5, num_free: 2.5, int: 1, flag: true, text: 'NA', kind: 'beta' },
];

// Emitted out of order on purpose; the exporter sorts by t.
const LOG_ROWS: Row[] = [
  {
    t: 40,
    text: 'second',
    flag: false,
    payload: { nested: { list: [1, 'two', null, true] }, unicode: 'é' },
  },
  { t: 10, text: '', flag: null, payload: null },
  { t: 90, text: 'tab\there', flag: true, payload: { quote: '"', newline: '\n' } },
];

async function runSession(name: string): Promise<{ zip: Blob; expected: Record<string, Row[]> }> {
  const time = fakeTime();
  const sensor = tortureSensor();
  const out: { zip: Blob | null } = { zip: null };
  const sink: Sink = {
    name: 'zip',
    async onEnd(bundle) {
      out.zip = await bundleToZip(bundle);
    },
  };
  const session = await createSession({
    studyId: 'roundtrip',
    participantId: name,
    sensors: [sensor],
    sinks: [sink],
    storage: new MemoryStore(),
    timeSource: time.src,
    // Tiny chunks, so encoding across chunk boundaries is exercised too.
    recorder: { flushRows: 2, flushIntervalMs: 60_000 },
  });
  await session.consent({ textVersion: 'rt-1', text: 'Consent text ✓', granted: ['torture'] });
  await session.start();
  const ctx = sensor.ctx;
  if (!ctx) throw new Error('not started');
  for (const row of TABLE_ROWS) expect(ctx.emit('torture.table', row)).toBe(true);
  for (const row of LOG_ROWS) expect(ctx.emit('torture.log', row)).toBe(true);
  time.advance(25);
  session.mark('onset', { item: 'A,"1"', n: 2 });
  time.advance(10);
  session.mark('ünï');
  time.advance(100);
  await session.end();
  const { zip } = out;
  if (!zip) throw new Error('sink did not run');
  return {
    zip,
    expected: {
      'torture.table': TABLE_ROWS,
      'torture.log': [...LOG_ROWS].sort((a, b) => (a.t as number) - (b.t as number)),
      'task.markers': [
        { t: 25, name: 'onset', source: 'api', data: { item: 'A,"1"', n: 2 } },
        { t: 35, name: 'ünï', source: 'api', data: null },
      ],
    },
  };
}

describe('round trip (TypeScript writer)', () => {
  it('writes a schema-valid zip whose files match the manifest', async () => {
    const { zip, expected } = await runSession('RT-1');
    const files = await unzipBlob(zip);
    const manifestPath = Object.keys(files).find((p) => p.endsWith('/manifest.json'));
    if (!manifestPath) throw new Error('no manifest');
    const manifest = JSON.parse(files[manifestPath] ?? '{}') as {
      streams: { name: string; file: string; stats: { count: number } }[];
    };
    expect(schemaErrors(manifest)).toBe('');
    const root = manifestPath.slice(0, -'manifest.json'.length);
    for (const s of manifest.streams) {
      const text = files[root + s.file];
      expect(text, s.file).toBeDefined();
      const rows = s.file.endsWith('.csv')
        ? text?.split(/\n(?=\d)/).length
        : text?.trim().split('\n').length;
      if (s.stats.count > 0) expect(rows, s.file).toBeGreaterThan(0);
    }
    expect(manifest.streams.find((s) => s.name === 'torture.table')?.stats.count).toBe(
      TABLE_ROWS.length,
    );

    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'torture.zip'), new Uint8Array(await zip.arrayBuffer()));
      writeFileSync(
        join(outDir, 'torture.expected.json'),
        `${JSON.stringify(expected, null, 2)}\n`,
      );
    }
  });
});
