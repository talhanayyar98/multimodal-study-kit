/**
 * Helpers for browser-mode tests (no Node APIs). Also imported by @mmstudykit/sensors' tests.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';

import schema from '../../../spec/manifest.schema.json' with { type: 'json' };
import { createSession, MemoryStore } from '../src/index.js';
import type {
  ChunkStore,
  SessionBundle,
  SessionConfig,
  SessionManifest,
  Sink,
} from '../src/index.js';

const ajv = new Ajv2020({
  strict: true,
  strictTuples: false,
  allErrors: true,
  validateFormats: false,
});
const validate = ajv.compile(schema);

export function schemaErrors(manifest: unknown): string {
  return validate(manifest) ? '' : ajv.errorsText(validate.errors, { separator: '\n' });
}

/** Minimal RFC 4180 parser for test assertions. Returns rows of strings (header included). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  return rows;
}

export type Rows = Record<string, unknown>[];

/** Parse a bundle file into objects keyed by column (CSV values stay strings). */
export function parseStream(text: string, format: 'csv' | 'jsonl'): Rows {
  if (format === 'jsonl') {
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  const [header = [], ...rows] = parseCsv(text);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

export interface Recorded {
  manifest: SessionManifest;
  /** stream name → rows */
  streams: Record<string, Rows>;
  /** stream name → raw file text */
  raw: Record<string, string>;
}

/** A sink that parses every file of the bundle inside onEnd. */
export function recordingSink(): { sink: Sink; result: Promise<Recorded> } {
  let resolve!: (r: Recorded) => void;
  const result = new Promise<Recorded>((r) => {
    resolve = r;
  });
  const sink: Sink = {
    name: 'recording',
    async onEnd(bundle: SessionBundle) {
      const streams: Record<string, Rows> = {};
      const raw: Record<string, string> = {};
      for (const file of bundle.files) {
        let text = '';
        for await (const piece of file.text()) text += piece;
        const info = bundle.manifest.streams.find((s) => s.name === file.stream);
        raw[file.stream] = text;
        streams[file.stream] = parseStream(text, info?.format ?? 'csv');
      }
      resolve({ manifest: bundle.manifest, streams, raw });
    },
  };
  return { sink, result };
}

/** Run a consented session around `body` and return everything it recorded. */
export async function record(
  config: Omit<SessionConfig, 'studyId' | 'participantId' | 'sinks'> & { studyId?: string },
  granted: { sensors: string[]; options?: string[] },
  body: () => Promise<void>,
  store: ChunkStore | 'memory' | 'auto' = new MemoryStore(),
): Promise<Recorded> {
  const { sink, result } = recordingSink();
  const session = await createSession({
    studyId: 'browser-test',
    participantId: 'P-test',
    storage: store,
    ...config,
    sinks: [sink],
    resume: false,
  });
  await session.consent({
    textVersion: 't1',
    granted: granted.sensors,
    grantedOptions: granted.options ?? [],
  });
  await session.start();
  await body();
  await session.end();
  return result;
}

export function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
