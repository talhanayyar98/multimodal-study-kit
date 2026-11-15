import type { ColumnInfo, ColumnType, StreamInfo } from './manifest.js';

/** A column as a sensor declares it. The `t` column is added by core and must not be declared. */
export interface ColumnSpec {
  /** snake_case. */
  name: string;
  type: ColumnType;
  /** Unit (`'ms'`, `'px'`, `'deg'`, `'1'` for dimensionless) or null for non-quantities. */
  unit: string | null;
  description: string;
  /** Required for `type: 'enum'`. */
  enumValues?: readonly string[];
  /** Decimal places written for `number` columns. Omit for shortest round-trip output. */
  precision?: number;
  /** Max length for `string` columns (default {@link DEFAULT_MAX_STRING}). */
  maxLength?: number;
}

/** A stream as a sensor declares it. */
export interface StreamSpec {
  /** `<sensorId>.<stream>`, snake_case, e.g. `pointer.move`. */
  name: string;
  /** `samples`: (mostly) regular numeric series. `events`: irregular occurrences. */
  kind: 'samples' | 'events';
  format: 'csv' | 'jsonl';
  /** Nominal sampling rate, or null for event-driven streams. */
  nominalRateHz: number | null;
  /** How `t` is obtained, e.g. `event.timeStamp`, `rvfc.captureTime`, `performance.now`. */
  timestampSource: string;
  /** Columns after `t`, in file order. */
  columns: readonly ColumnSpec[];
}

/** A stream with core's additions: the `t` column, the owning sensor and the bundle path. */
export interface ResolvedStream {
  readonly name: string;
  readonly sensor: string;
  readonly kind: 'samples' | 'events';
  readonly format: 'csv' | 'jsonl';
  readonly file: string;
  readonly nominalRateHz: number | null;
  readonly timestampSource: string;
  /** All columns including `t` first. */
  readonly columns: readonly ColumnSpec[];
}

export const DEFAULT_MAX_STRING = 256;
/** Max serialized size of an `object` value (JSONL only). Keeps arbitrary blobs out. */
export const DEFAULT_MAX_OBJECT_BYTES = 4096;
const MAX_OBJECT_DEPTH = 8;

export const T_COLUMN: ColumnSpec = {
  name: 't',
  type: 'number',
  unit: 'ms',
  description: 'Session time: ms since session start on the session clock.',
  precision: 3,
};

const SNAKE = /^[a-z][a-z0-9_]*$/;
const STREAM_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Stream and sensor ids owned by core. */
export const RESERVED_SENSOR_IDS: ReadonlySet<string> = new Set(['session', 'task']);

/** Validate a sensor's stream declaration and add the `t` column. Throws on authoring mistakes. */
export function resolveStream(sensorId: string, spec: StreamSpec): ResolvedStream {
  const where = `stream "${spec.name}" of sensor "${sensorId}"`;
  if (!STREAM_NAME.test(spec.name)) {
    throw new TypeError(`${where}: name must be <sensor>.<stream> in snake_case`);
  }
  if (!spec.name.startsWith(`${sensorId}.`)) {
    throw new TypeError(`${where}: name must start with "${sensorId}."`);
  }
  if (spec.nominalRateHz !== null && !(spec.nominalRateHz > 0)) {
    throw new TypeError(`${where}: nominalRateHz must be positive or null`);
  }
  const seen = new Set<string>();
  for (const col of spec.columns) {
    const c = `${where}, column "${col.name}"`;
    if (!SNAKE.test(col.name)) throw new TypeError(`${c}: name must be snake_case`);
    if (col.name === 't') throw new TypeError(`${c}: "t" is added by core; don't declare it`);
    if (seen.has(col.name)) throw new TypeError(`${c}: duplicate column`);
    seen.add(col.name);
    if (col.type === 'enum' && !col.enumValues?.length) {
      throw new TypeError(`${c}: enum columns need enumValues`);
    }
    if (col.type === 'object' && spec.format === 'csv') {
      throw new TypeError(`${c}: object columns are only allowed in jsonl streams`);
    }
    if (col.precision !== undefined && !(Number.isInteger(col.precision) && col.precision >= 0)) {
      throw new TypeError(`${c}: precision must be a non-negative integer`);
    }
  }
  return {
    name: spec.name,
    sensor: sensorId,
    kind: spec.kind,
    format: spec.format,
    file: `streams/${spec.name}.${spec.format}`,
    nominalRateHz: spec.nominalRateHz,
    timestampSource: spec.timestampSource,
    columns: [T_COLUMN, ...spec.columns],
  };
}

/** Manifest view of a stream's columns. */
export function columnInfo(col: ColumnSpec): ColumnInfo {
  const info: ColumnInfo = {
    name: col.name,
    type: col.type,
    unit: col.unit,
    description: col.description,
  };
  if (col.enumValues) info.enumValues = [...col.enumValues];
  if (col.precision !== undefined) info.precision = col.precision;
  return info;
}

export function streamInfo(stream: ResolvedStream, stats: StreamInfo['stats']): StreamInfo {
  return {
    name: stream.name,
    sensor: stream.sensor,
    kind: stream.kind,
    format: stream.format,
    file: stream.file,
    nominalRateHz: stream.nominalRateHz,
    timestampSource: stream.timestampSource,
    columns: stream.columns.map(columnInfo),
    stats,
  };
}

// ---------------------------------------------------------------------------------------------
// Sample guard
// ---------------------------------------------------------------------------------------------

export type GuardResult = { ok: true; values: unknown[] } | { ok: false; reason: string };

/**
 * The sample guard. Turns a row object into an array in column order, or rejects it.
 *
 * Accepted: finite numbers, integers, booleans, `null`, short strings, declared enum values and,
 * in JSONL streams only, small JSON-serializable plain objects. Rejected: binary and image types
 * (ArrayBuffer, typed arrays, Blob, ImageData, ImageBitmap, VideoFrame, …), data URLs, `NaN` and
 * `Infinity`, undeclared keys, and oversized payloads. A buggy or third-party sensor therefore
 * can't put pixels into storage whatever it does internally.
 */
export function guardRow(
  stream: ResolvedStream,
  row: Readonly<Record<string, unknown>>,
): GuardResult {
  if (typeof row !== 'object' || (row as unknown) === null || !isPlainObject(row)) {
    return { ok: false, reason: 'row must be a plain object' };
  }
  for (const key of Object.keys(row)) {
    if (!stream.columns.some((c) => c.name === key)) {
      return { ok: false, reason: `undeclared column "${key}"` };
    }
  }
  const values: unknown[] = [];
  for (const col of stream.columns) {
    const value = row[col.name];
    const problem = checkValue(col, value);
    if (problem) return { ok: false, reason: `column "${col.name}": ${problem}` };
    values.push(value ?? null);
  }
  return { ok: true, values };
}

function checkValue(col: ColumnSpec, value: unknown): string | null {
  if (value === undefined || value === null) {
    return col.name === 't' ? 'is required' : null;
  }
  switch (col.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : 'expected a finite number';
    case 'integer':
      return Number.isSafeInteger(value) ? null : 'expected an integer';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected a boolean';
    case 'string':
      return checkString(value, col.maxLength ?? DEFAULT_MAX_STRING);
    case 'enum':
      return typeof value === 'string' && col.enumValues?.includes(value)
        ? null
        : `expected one of ${JSON.stringify(col.enumValues)}`;
    case 'object':
      return checkPayload(value);
  }
}

function checkString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return 'expected a string';
  if (value.length > maxLength) return `string longer than ${maxLength}`;
  if (DATA_URL.test(value)) return 'data URLs are not allowed';
  return null;
}

const DATA_URL = /^\s*data:/i;

/**
 * Check an `object`-typed value: JSON-serializable plain data only, within depth and size limits.
 * Exported for markers, which accept researcher payloads under the same rules.
 */
export function checkPayload(value: unknown, maxBytes = DEFAULT_MAX_OBJECT_BYTES): string | null {
  const problem = checkPlain(value, 0);
  if (problem) return problem;
  const size = JSON.stringify(value).length;
  return size > maxBytes ? `payload is ${size} bytes when serialized (max ${maxBytes})` : null;
}

function checkPlain(value: unknown, depth: number): string | null {
  if (depth > MAX_OBJECT_DEPTH) return `nested deeper than ${MAX_OBJECT_DEPTH}`;
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'non-finite number';
  if (typeof value === 'string') return checkString(value, DEFAULT_MAX_OBJECT_BYTES);
  if (typeof value !== 'object') return `unsupported type ${typeof value}`;
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      const p = checkPlain(item, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (!isPlainObject(value)) {
    // ArrayBuffer, typed arrays, Blob, ImageData, ImageBitmap, VideoFrame, Date, Map, DOM nodes…
    return `unsupported object type ${describeType(value)}`;
  }
  for (const item of Object.values(value)) {
    const p = checkPlain(item, depth + 1);
    if (p) return p;
  }
  return null;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describeType(value: object): string {
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name ? name : Object.prototype.toString.call(value);
}
