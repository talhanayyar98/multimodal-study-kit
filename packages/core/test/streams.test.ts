import { describe, expect, it } from 'vitest';

import { checkPayload, guardRow, resolveStream } from '../src/index.js';
import type { StreamSpec } from '../src/index.js';

const spec: StreamSpec = {
  name: 'demo.samples',
  kind: 'samples',
  format: 'jsonl',
  nominalRateHz: 30,
  timestampSource: 'performance.now',
  columns: [
    { name: 'x', type: 'number', unit: 'px', description: 'x' },
    { name: 'n', type: 'integer', unit: null, description: 'n' },
    { name: 'on', type: 'boolean', unit: null, description: 'on' },
    { name: 'label', type: 'string', unit: null, description: 'label', maxLength: 8 },
    { name: 'kind', type: 'enum', unit: null, description: 'kind', enumValues: ['a', 'b'] },
    { name: 'data', type: 'object', unit: null, description: 'data' },
  ],
};
const stream = resolveStream('demo', spec);

describe('resolveStream', () => {
  it('adds t first, the sensor and the file path', () => {
    expect(stream.columns[0]).toMatchObject({
      name: 't',
      type: 'number',
      unit: 'ms',
      precision: 3,
    });
    expect(stream.columns.map((c) => c.name)).toEqual([
      't',
      'x',
      'n',
      'on',
      'label',
      'kind',
      'data',
    ]);
    expect(stream.sensor).toBe('demo');
    expect(stream.file).toBe('streams/demo.samples.jsonl');
  });

  it.each([
    ['a name outside the sensor namespace', { name: 'other.samples' }],
    ['a non-snake_case name', { name: 'demo.Samples' }],
    [
      'a declared t column',
      { columns: [{ name: 't', type: 'number', unit: 'ms', description: '' }] },
    ],
    ['duplicate columns', { columns: [spec.columns[0], spec.columns[0]] }],
    [
      'an enum without values',
      { columns: [{ name: 'k', type: 'enum', unit: null, description: '' }] },
    ],
    [
      'an object column in CSV',
      { format: 'csv', columns: [{ name: 'o', type: 'object', unit: null, description: '' }] },
    ],
    [
      'a negative precision',
      { columns: [{ name: 'x', type: 'number', unit: null, description: '', precision: -1 }] },
    ],
    ['a zero rate', { nominalRateHz: 0 }],
  ])('rejects %s', (_label, override) => {
    expect(() => resolveStream('demo', { ...spec, ...override } as StreamSpec)).toThrow(TypeError);
  });
});

describe('sample guard', () => {
  const ok = {
    t: 1.5,
    x: 2.25,
    n: 3,
    on: true,
    label: 'hi',
    kind: 'a',
    data: { nested: [1, 'two', null] },
  };

  it('accepts declared, well-typed values and orders them by column', () => {
    expect(guardRow(stream, ok)).toEqual({
      ok: true,
      values: [1.5, 2.25, 3, true, 'hi', 'a', { nested: [1, 'two', null] }],
    });
  });

  it('fills missing optional columns with null', () => {
    expect(guardRow(stream, { t: 1 })).toEqual({
      ok: true,
      values: [1, null, null, null, null, null, null],
    });
  });

  const binary: [string, unknown][] = [
    ['ArrayBuffer', new ArrayBuffer(8)],
    ['Uint8Array', new Uint8Array(8)],
    ['Float32Array', new Float32Array(4)],
    ['DataView', new DataView(new ArrayBuffer(4))],
    ['Blob', new Blob(['x'])],
    ['Date', new Date()],
    ['Map', new Map()],
    [
      'class instance',
      new (class Frame {
        readonly width = 640;
      })(),
    ],
  ];

  it.each(binary)('rejects a %s inside an object payload', (_label, value) => {
    const res = guardRow(stream, { ...ok, data: { frame: value } });
    expect(res.ok).toBe(false);
  });

  it.each(binary)('rejects a %s as a column value', (_label, value) => {
    expect(guardRow(stream, { ...ok, x: value }).ok).toBe(false);
    expect(guardRow(stream, { ...ok, data: value }).ok).toBe(false);
  });

  it.each([
    ['a missing t', { x: 1 }],
    ['NaN', { ...ok, x: Number.NaN }],
    ['Infinity', { ...ok, x: Infinity }],
    ['a float in an integer column', { ...ok, n: 1.5 }],
    ['a number in a boolean column', { ...ok, on: 1 }],
    ['an undeclared enum value', { ...ok, kind: 'c' }],
    ['an over-long string', { ...ok, label: 'x'.repeat(9) }],
    ['a data URL string', { ...ok, label: 'data:,x' }],
    ['a data URL inside a payload', { ...ok, data: { img: 'data:image/png;base64,iVBORw0KGgo=' } }],
    ['an undeclared column', { ...ok, extra: 1 }],
    ['an oversized payload', { ...ok, data: { s: 'x'.repeat(5000) } }],
    [
      'a deeply nested payload',
      { ...ok, data: JSON.parse('['.repeat(12) + ']'.repeat(12)) as unknown },
    ],
    ['a non-plain row', Object.assign(Object.create({ inherited: true }) as object, { t: 1 })],
  ])('rejects %s', (_label, row) => {
    const res = guardRow(stream, row);
    expect(res.ok).toBe(false);
  });

  it('explains why a row was rejected', () => {
    expect(guardRow(stream, { ...ok, data: { frame: new Uint8Array(4) } })).toEqual({
      ok: false,
      reason: 'column "data": unsupported object type Uint8Array',
    });
  });

  it('checkPayload accepts plain JSON and null-prototype objects', () => {
    expect(checkPayload({ a: [1, true, null, { b: 'c' }] })).toBeNull();
    expect(checkPayload(Object.assign(Object.create(null) as object, { a: 1 }))).toBeNull();
    expect(checkPayload({ fn: () => 1 })).toMatch(/unsupported type function/);
  });
});
