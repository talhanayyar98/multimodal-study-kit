import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { strFromU8, unzipSync } from 'fflate';

import type { Sensor, SensorContext, StreamSpec, TimeSource } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const specDir = join(here, '../../../spec');

const schema = JSON.parse(readFileSync(join(specDir, 'manifest.schema.json'), 'utf8')) as object;
const ajv = new Ajv2020({
  strict: true,
  strictTuples: false,
  allErrors: true,
  validateFormats: false,
});
const validateManifest = ajv.compile(schema);

/** Validate against spec/manifest.schema.json; returns the error text ('' if valid). */
export function schemaErrors(manifest: unknown): string {
  return validateManifest(manifest)
    ? ''
    : ajv.errorsText(validateManifest.errors, { separator: '\n' });
}

/** A controllable clock: perf and wall time advance only when told to. */
export function fakeTime(perfStart = 1000, wallStart = 1_794_736_800_000) {
  let perf = perfStart;
  let wall = wallStart;
  let origin = wallStart - perfStart;
  const src: TimeSource = {
    now: () => perf,
    wallNow: () => wall,
    timeOrigin: () => origin,
  };
  return {
    src,
    advance(ms: number, wallMs = ms) {
      perf += ms;
      wall += wallMs;
    },
    /** Simulate a new page load: perf restarts near zero with a new time origin. */
    reload(gapWallMs: number, newPerf = 50) {
      wall += gapWallMs;
      perf = newPerf;
      origin = wall - newPerf;
    },
    get perf() {
      return perf;
    },
  };
}

/** A sensor that records whatever the test pushes, with every column type. */
export function fakeSensor(
  id = 'fake',
  options: { failStart?: boolean; optIn?: boolean } = {},
): Sensor & { ctx: SensorContext | null; startCalls: number; stopCalls: number; paused: number } {
  const spec = (granted: ReadonlySet<string>): StreamSpec[] => [
    {
      name: `${id}.samples`,
      kind: 'samples',
      format: 'csv',
      nominalRateHz: 100,
      timestampSource: 'performance.now',
      columns: [
        { name: 'value', type: 'number', unit: '1', description: 'A value.', precision: 2 },
        { name: 'count', type: 'integer', unit: null, description: 'A count.' },
        { name: 'flag', type: 'boolean', unit: null, description: 'A flag.' },
        { name: 'label', type: 'string', unit: null, description: 'A label.' },
        { name: 'kind', type: 'enum', unit: null, description: 'A kind.', enumValues: ['a', 'b'] },
        ...(granted.has('secret')
          ? [{ name: 'secret', type: 'string' as const, unit: null, description: 'Opt-in.' }]
          : []),
      ],
    },
    {
      name: `${id}.events`,
      kind: 'events',
      format: 'jsonl',
      nominalRateHz: null,
      timestampSource: 'performance.now',
      columns: [
        { name: 'type', type: 'string', unit: null, description: 'Type.' },
        { name: 'data', type: 'object', unit: null, description: 'Payload.' },
      ],
    },
  ];
  const sensor = {
    id,
    package: '@mmstudykit/test',
    version: '0.0.0',
    ...(options.optIn
      ? { options: [{ id: 'secret', title: 'Secret', description: 'Records a secret.' }] }
      : {}),
    ctx: null as SensorContext | null,
    startCalls: 0,
    stopCalls: 0,
    paused: 0,
    config: () => ({ optIn: options.optIn ?? false }),
    streams: spec,
    describe: () => ({
      title: 'Fake',
      summary: 'For tests.',
      records: ['numbers'],
      neverRecords: ['pixels'],
      rateHz: 100,
    }),
    privacy: (granted: ReadonlySet<string>) => ({ keyIdentityRecorded: granted.has('secret') }),
    start(ctx: SensorContext) {
      sensor.startCalls++;
      if (options.failStart) throw new Error('no device');
      sensor.ctx = ctx;
    },
    stop() {
      sensor.stopCalls++;
    },
    pause() {
      sensor.paused++;
    },
    summary: () => ({ ok: true }),
  };
  return sensor;
}

/** Unzip a bundle Blob into { path: text }. */
export async function unzipBlob(blob: Blob): Promise<Record<string, string>> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([path, data]) => [path, strFromU8(data)]));
}
