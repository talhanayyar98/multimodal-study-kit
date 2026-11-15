import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { CORE_VERSION, MANIFEST_FORMAT, SCHEMA_VERSION } from '../src/index.js';
import type { SessionManifest } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, '../../../spec');
const fixturesDir = join(specDir, 'fixtures');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const schema = readJson(join(specDir, 'manifest.schema.json')) as Record<string, unknown>;
// Strict mode catches schema-authoring mistakes. Two relaxations:
// - strictTuples: `columns` is intentionally an open tuple (first item must be `t`, rest free).
// - validateFormats: `date-time` is an annotation here; structural rules are what we enforce.
const ajv = new Ajv2020({
  strict: true,
  strictTuples: false,
  allErrors: true,
  validateFormats: false,
});
const validate = ajv.compile(schema);

function errorsOf(value: unknown): string {
  validate(value);
  return ajv.errorsText(validate.errors, { separator: '\n' });
}

function expectValid(value: unknown): void {
  const ok = validate(value);
  expect(ok, errorsOf(value)).toBe(true);
}

function expectInvalid(value: unknown): void {
  expect(validate(value)).toBe(false);
}

const fixtureNames = readdirSync(fixturesDir).filter((name) =>
  existsSync(join(fixturesDir, name, 'manifest.json')),
);

function loadFixture(name: string): SessionManifest {
  return readJson(join(fixturesDir, name, 'manifest.json')) as SessionManifest;
}

/** Deep copy so negative tests can mutate freely. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('manifest JSON Schema', () => {
  it('has fixtures to test against', () => {
    expect(fixtureNames).toEqual(expect.arrayContaining(['minimal', 'withdrawn']));
  });

  it('declares the schema version this build writes', () => {
    expect(schema.$id).toBe(`urn:mmstudykit:schema:manifest:${SCHEMA_VERSION}`);
  });

  it.each(fixtureNames)('validates fixture "%s"', (name) => {
    const manifest = loadFixture(name);
    expectValid(manifest);
    expect(manifest.format).toBe(MANIFEST_FORMAT);
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('validates a manifest constructed through the TypeScript types', () => {
    // If the TS types allow something the schema rejects, this is where it shows up.
    const typed: SessionManifest = {
      format: MANIFEST_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      toolkit: { name: 'multimodal-study-kit', version: CORE_VERSION, packages: {} },
      study: { id: 'typed-example' },
      session: {
        id: 'abc-123',
        participantId: 'P-42',
        status: 'incomplete',
        startedAt: '2026-11-15T10:00:00.000Z',
        endedAt: null,
        durationMs: null,
        pauses: [{ startT: 100, endT: null }],
      },
      clock: {
        timebase: 'session',
        unit: 'ms',
        crossOriginIsolated: true,
        measuredResolutionMs: null,
        segments: [
          { index: 0, reason: 'start', t: 0, wallClockMs: 1, timeOrigin: 0.5, perfNow: 0.5 },
          {
            index: 1,
            reason: 'reload-resume',
            t: 9000,
            wallClockMs: 9001,
            timeOrigin: 9000,
            perfNow: 1,
          },
        ],
        anchors: [],
        discontinuities: [{ t: 5000, kind: 'reload-gap', magnitudeMs: 2500 }],
      },
      consent: {
        textVersion: 'v1',
        textSha256: null,
        decidedAt: '2026-11-15T09:59:00.000Z',
        decisions: { keyboard: 'granted' },
        options: { 'keyboard.keyIdentity': 'declined' },
        withdrawal: null,
      },
      environment: {
        browser: { name: 'Firefox', majorVersion: null },
        os: { name: 'Linux' },
        deviceClass: 'unknown',
        viewport: { width: 800, height: 600, devicePixelRatio: 1 },
        persistence: 'memory',
      },
      privacy: {
        rawVideoPersisted: false,
        rawVideoTransmitted: false,
        keyIdentityRecorded: false,
        faceLandmarksRecorded: 'none',
        participantIdSource: 'researcher',
      },
      sensors: [
        {
          id: 'keyboard',
          package: '@mmstudykit/sensors',
          version: '0.0.0',
          enabled: true,
          config: {},
        },
      ],
      streams: [],
      quality: {},
      extensions: { 'org.example.thing': { anything: true } },
    };
    expectValid(typed);
  });

  describe('rejects manifests that break the privacy and format rules', () => {
    const base = loadFixture('minimal');

    it('raw video flagged as persisted', () => {
      const m = clone(base) as unknown as { privacy: { rawVideoPersisted: boolean } };
      m.privacy.rawVideoPersisted = true;
      expectInvalid(m);
    });

    it('participant ID not marked as researcher-provided', () => {
      const m = clone(base) as unknown as { privacy: { participantIdSource: string } };
      m.privacy.participantIdSource = 'auto';
      expectInvalid(m);
    });

    it('withdrawn session that still contains streams', () => {
      const m = clone(base);
      m.session.status = 'withdrawn';
      m.consent.withdrawal = { at: '2026-11-15T10:00:03.000Z', t: 3000 };
      expectInvalid(m);
    });

    it('withdrawn session without a withdrawal record', () => {
      const m = clone(loadFixture('withdrawn'));
      m.consent.withdrawal = null;
      expectInvalid(m);
    });

    it('stream whose first column is not t', () => {
      const m = clone(base);
      m.streams[0]?.columns.reverse();
      expectInvalid(m);
    });

    it('enum column without enumValues', () => {
      const m = clone(base);
      const col = m.streams[0]?.columns.find((c) => c.type === 'enum');
      if (col) delete col.enumValues;
      expectInvalid(m);
    });

    it('object column in a CSV stream', () => {
      const m = clone(base);
      m.streams[0]?.columns.push({ name: 'blob', type: 'object', unit: null, description: 'x' });
      expectInvalid(m);
    });

    it('unknown top-level field (writers must be strict; use extensions instead)', () => {
      const m = { ...clone(base), surprise: 1 };
      expectInvalid(m);
    });

    it('non-namespaced extension key', () => {
      const m = { ...clone(base), extensions: { gaze: {} } };
      expectInvalid(m);
    });
  });
});

describe('fixture stream files match their manifest', () => {
  const cases = fixtureNames.flatMap((name) =>
    loadFixture(name).streams.map((stream) => ({ name, stream })),
  );

  it.each(cases)('$name: $stream.file', ({ name, stream }) => {
    const text = readFileSync(join(fixturesDir, name, stream.file), 'utf8');
    expect(text.endsWith('\n'), 'files end with a newline').toBe(true);
    const lines = text.slice(0, -1).split('\n');
    const declared = stream.columns.map((c) => c.name);

    let ts: number[];
    if (stream.format === 'csv') {
      const [header, ...rows] = lines;
      expect(header?.split(',')).toEqual(declared);
      ts = rows.map((row) => Number(row.split(',')[0]));
    } else {
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const record of records) expect(Object.keys(record)).toEqual(declared);
      ts = records.map((record) => record.t as number);
    }

    expect(ts).toHaveLength(stream.stats.count);
    expect(ts[0]).toBe(stream.stats.firstT);
    expect(ts.at(-1)).toBe(stream.stats.lastT);
    expect(
      [...ts].sort((a, b) => a - b),
      'rows are in time order',
    ).toEqual(ts);
  });
});

describe('version constants', () => {
  it('CORE_VERSION matches package.json', () => {
    const pkg = readJson(join(here, '../package.json')) as { version: string };
    expect(CORE_VERSION).toBe(pkg.version);
  });
});
