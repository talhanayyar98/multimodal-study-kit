import type { ColumnSpec } from '../streams.js';

/**
 * Encoders for the bundle's stream files (see spec/README.md):
 * - CSV: RFC 4180, UTF-8, LF, header row, empty field = missing, booleans 0/1, fixed precision
 *   per column where declared.
 * - JSONL: one object per line, keys in declared order, every declared key present.
 */

export function csvHeader(columns: readonly ColumnSpec[]): string {
  return `${columns.map((c) => c.name).join(',')}\n`;
}

export function csvRow(columns: readonly ColumnSpec[], row: readonly unknown[]): string {
  let line = '';
  for (const [i, col] of columns.entries()) {
    if (i) line += ',';
    line += csvField(col, row[i]);
  }
  return `${line}\n`;
}

function csvField(col: ColumnSpec, value: unknown): string {
  if (value === null || value === undefined) return '';
  switch (typeof value) {
    case 'number':
      return formatNumber(value, col.precision);
    case 'boolean':
      return value ? '1' : '0';
    case 'string':
      return quoteCsv(value);
    default:
      // The sample guard only lets the types above into CSV streams.
      return quoteCsv(JSON.stringify(value));
  }
}

const NEEDS_QUOTES = /[",\r\n]/;

function quoteCsv(value: string): string {
  // Readers (pandas, R) don't distinguish "" from an empty field, and the format defines an empty
  // field as missing. So in CSV an empty string *is* missing. JSONL keeps "" distinct from null.
  return NEEDS_QUOTES.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Fixed-precision decimal, never `-0.000`. Without precision, shortest round-trip form. */
export function formatNumber(value: number, precision: number | undefined): string {
  if (precision === undefined) return Object.is(value, -0) ? '0' : String(value);
  const s = value.toFixed(precision);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

export function roundTo(value: number, precision: number): number {
  const f = 10 ** precision;
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function jsonlRow(columns: readonly ColumnSpec[], row: readonly unknown[]): string {
  const obj: Record<string, unknown> = {};
  for (const [i, col] of columns.entries()) {
    const value = row[i] ?? null;
    obj[col.name] =
      typeof value === 'number' && col.precision !== undefined
        ? roundTo(value, col.precision)
        : value;
  }
  return `${JSON.stringify(obj)}\n`;
}
