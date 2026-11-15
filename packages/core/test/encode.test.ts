import { describe, expect, it } from 'vitest';

import { csvHeader, csvRow, formatNumber, jsonlRow } from '../src/export/encode.js';
import { intervalSummary, quantile, StatsAccumulator } from '../src/export/stats.js';
import type { ColumnSpec } from '../src/index.js';

const cols: ColumnSpec[] = [
  { name: 't', type: 'number', unit: 'ms', description: '', precision: 3 },
  { name: 'x', type: 'number', unit: 'px', description: '', precision: 1 },
  { name: 'raw', type: 'number', unit: null, description: '' },
  { name: 'n', type: 'integer', unit: null, description: '' },
  { name: 'on', type: 'boolean', unit: null, description: '' },
  { name: 's', type: 'string', unit: null, description: '' },
];

describe('CSV encoder', () => {
  it('writes a header and fixed-precision rows', () => {
    expect(csvHeader(cols)).toBe('t,x,raw,n,on,s\n');
    expect(csvRow(cols, [1000, 412.55, 0.1, 3, true, 'a'])).toBe('1000.000,412.6,0.1,3,1,a\n');
  });

  it('writes null and empty strings as empty fields (missing)', () => {
    expect(csvRow(cols, [1, null, null, null, null, null])).toBe('1.000,,,,,\n');
    expect(csvRow(cols, [1, null, null, null, false, ''])).toBe('1.000,,,,0,\n');
  });

  it('quotes per RFC 4180', () => {
    const row = [1, 0, 0, 0, false, 'he said "hi", then\nleft'];
    expect(csvRow(cols, row)).toBe('1.000,0.0,0,0,0,"he said ""hi"", then\nleft"\n');
    expect(csvRow(cols, [1, 0, 0, 0, false, 'café ☕'])).toBe('1.000,0.0,0,0,0,café ☕\n');
  });

  it('never writes negative zero', () => {
    expect(formatNumber(-0.0001, 3)).toBe('0.000');
    expect(formatNumber(-0, 1)).toBe('0.0');
    expect(formatNumber(-0, undefined)).toBe('0');
    expect(formatNumber(-0.25, 1)).toBe('-0.3');
  });
});

describe('JSONL encoder', () => {
  const jcols: ColumnSpec[] = [
    { name: 't', type: 'number', unit: 'ms', description: '', precision: 3 },
    { name: 'name', type: 'string', unit: null, description: '' },
    { name: 'data', type: 'object', unit: null, description: '' },
  ];

  it('writes every declared key in order, rounding t', () => {
    expect(jsonlRow(jcols, [980.2504, 'onset', { itemId: 3 }])).toBe(
      '{"t":980.25,"name":"onset","data":{"itemId":3}}\n',
    );
    expect(jsonlRow(jcols, [1, '', null])).toBe('{"t":1,"name":"","data":null}\n');
  });
});

describe('stream statistics', () => {
  it('match numpy for intervals (linear percentiles, sample sd)', () => {
    // np.diff([0, 10, 30, 31, 61]) = [10, 20, 1, 30]
    // mean 15.25, std(ddof=1) 12.527; percentile(50) 15, percentile(95) 28.5 (numpy 2.5)
    const acc = new StatsAccumulator(true);
    for (const t of [0, 10, 30, 31, 61]) acc.add(t);
    expect(acc.result()).toEqual({
      count: 5,
      firstT: 0,
      lastT: 61,
      intervalMs: { mean: 15.25, sd: 12.527, p50: 15, p95: 28.5, max: 30 },
    });
  });

  it('reports null intervals for event streams and for fewer than two samples', () => {
    const events = new StatsAccumulator(false);
    events.add(1);
    events.add(2);
    expect(events.result().intervalMs).toBeNull();
    const single = new StatsAccumulator(true);
    single.add(5);
    expect(single.result()).toEqual({ count: 1, firstT: 5, lastT: 5, intervalMs: null });
    expect(new StatsAccumulator(true).result()).toEqual({
      count: 0,
      firstT: null,
      lastT: null,
      intervalMs: null,
    });
  });

  it('notices unsorted input', () => {
    const acc = new StatsAccumulator(true);
    for (const t of [0, 10, 5]) acc.add(t);
    expect(acc.sorted).toBe(false);
  });

  it('quantile edge cases', () => {
    expect(quantile(Float64Array.from([7]), 0.95)).toBe(7);
    expect(intervalSummary(new Float64Array(0))).toBeNull();
    expect(intervalSummary(Float64Array.from([16.5]))).toEqual({
      mean: 16.5,
      sd: 0,
      p50: 16.5,
      p95: 16.5,
      max: 16.5,
    });
  });

  it('grows past its initial buffer', () => {
    const acc = new StatsAccumulator(true);
    for (let i = 0; i < 5000; i++) acc.add(i * 2);
    expect(acc.result().intervalMs).toEqual({ mean: 2, sd: 0, p50: 2, p95: 2, max: 2 });
  });
});
