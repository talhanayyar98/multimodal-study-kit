/**
 * The privacy guarantee, end to end (PLAN.md §5), with the real camera path:
 * Chromium's fake capture device, or Firefox's fake streams. With a recorded clip present
 * (e2e/fixtures/face.mjpeg), Chromium plays it as the camera and face detection is asserted too.
 *
 * Checked:
 * 1. Every request (page and worker) is same-origin: assets GETs and the one upload POST.
 * 2. Mid-session, IndexedDB / localStorage / sessionStorage / Cache Storage / OPFS hold no binary
 *    values and no image signatures.
 * 3. The uploaded bundle, decompressed, holds only manifest + CSV/JSONL streams, no image data,
 *    and validates against the schema. MediaPipe's metrics were blocked (manifest note).
 * 4. After delivery, local data is gone.
 * 5. The page runs under the strict CSP documented in docs/face.md.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { build } from 'esbuild';
import { strFromU8, unzipSync } from 'fflate';
import { chromium, firefox } from 'playwright';
import type { Browser, BrowserType, LaunchOptions } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const site = join(root, '.e2e-site');
const clip = join(here, 'fixtures/face.mjpeg');
const CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self' blob: mediastream:; style-src 'self'";

const IMAGE_SIGNATURES: [string, (b: Uint8Array) => boolean][] = [
  ['JPEG', (b) => indexOfBytes(b, [0xff, 0xd8, 0xff]) >= 0],
  ['PNG', (b) => indexOfBytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) >= 0],
  ['GIF', (b) => indexOfBytes(b, ascii('GIF8')) >= 0],
  ['WebP', (b) => indexOfBytes(b, ascii('WEBPVP8')) >= 0],
];
const IMAGE_TEXT = [/data:image\//i, /\/9j\/4/, /iVBORw0KGgo/, /UklGR[\s\S]{0,8}V0VCUA/];

function ascii(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function indexOfBytes(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function imageFindings(label: string, data: Uint8Array | string): string[] {
  const out: string[] = [];
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  for (const [name, test] of IMAGE_SIGNATURES)
    if (test(bytes)) out.push(`${label}: ${name} signature`);
  const text =
    typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: false }).decode(data);
  for (const re of IMAGE_TEXT) if (re.test(text)) out.push(`${label}: ${String(re)}`);
  return out;
}

/** Every `{__binary}` marker the harness put where a binary value was stored. */
function binaryMarkers(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];
  if ('__binary' in value) return [`${path}: ${(value as { __binary: string }).__binary}`];
  return Object.entries(value).flatMap(([k, v]) => binaryMarkers(v, `${path}.${k}`));
}

interface Logged {
  method: string;
  url: string;
}

let server: Server;
let origin: string;
const uploads: Buffer[] = [];
const served: string[] = [];

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  rmSync(site, { recursive: true, force: true });
  mkdirSync(site, { recursive: true });
  await build({
    entryPoints: [join(here, 'harness.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile: join(site, 'harness.js'),
    logLevel: 'warning',
  });
  writeFileSync(
    join(site, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>privacy e2e</title><body><script type="module" src="/harness.js"></script></body>',
  );
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
  };
  const assets = join(root, '.test-assets');
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      served.push(`${req.method ?? ''} ${url.pathname}`);
      if (req.method === 'POST' && url.pathname === '/upload') {
        uploads.push(await body(req));
        res.writeHead(204).end();
        return;
      }
      const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      const file =
        path === '/'
          ? join(site, 'index.html')
          : path.startsWith('/mmstudykit-face/')
            ? join(assets, path)
            : join(site, path);
      if (!existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': types[extname(file)] ?? 'application/octet-stream',
        'content-security-policy': CSP,
      });
      res.end(readFileSync(file));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(site, { recursive: true, force: true });
});

describe('privacy scanners (negative control)', () => {
  it('flag real image data in bytes, base64 and data URLs, and binary values in storage dumps', () => {
    expect(imageFindings('jpeg', new Uint8Array([0x00, 0xff, 0xd8, 0xff, 0xe0, 0x00]))).toEqual([
      'jpeg: JPEG signature',
    ]);
    expect(
      imageFindings('png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toEqual(['png: PNG signature']);
    expect(imageFindings('b64', '{"x":"/9j/4AAQSkZJRg"}')).toHaveLength(1);
    expect(imageFindings('url', 'data:image/png;base64,iVBORw0KGgo=')).toHaveLength(2);
    expect(imageFindings('csv', 't,x\n1.000,2.5\n')).toEqual([]);
    expect(binaryMarkers({ a: [{ __binary: 'Uint8Array', bytes: 4 }] })).toEqual([
      '$.a.0: Uint8Array',
    ]);
  });
});

const hasClip = existsSync(clip);
const engines: [string, BrowserType, LaunchOptions][] = [
  [
    'chromium',
    chromium,
    {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        ...(hasClip ? [`--use-file-for-fake-video-capture=${clip}`] : []),
      ],
    },
  ],
  [
    'firefox',
    firefox,
    {
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
      },
    },
  ],
];

describe.each(engines)('privacy guarantee (%s, real camera path)', (name, type, launch) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch(launch);
  });
  afterAll(async () => {
    await browser.close();
  });

  it('sends nothing anywhere but this origin, stores no images, uploads no images', async () => {
    uploads.length = 0;
    const context = await browser.newContext();
    const requests: Logged[] = [];
    const escaped: string[] = [];
    await context.route('**/*', (route) => {
      const r = route.request();
      requests.push({ method: r.method(), url: r.url() });
      if (!r.url().startsWith(origin)) {
        escaped.push(`${r.method()} ${r.url()}`);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });

    await page.goto(origin);
    await page.waitForSelector('body[data-ready]', { state: 'attached' });
    const started = await page.evaluate(() =>
      (
        window as unknown as {
          harness: { start(p: string): Promise<{ started: string[]; failed: unknown[] }> };
        }
      ).harness.start('E2E-P1'),
    );
    expect([...started.started].sort(), JSON.stringify(started)).toEqual([
      'face',
      'keyboard',
      'pointer',
    ]);
    expect(started.failed).toEqual([]);
    await page.mouse.move(100, 100);
    await page.mouse.move(300, 200, { steps: 10 });
    await page.keyboard.type('hello');
    await page.waitForTimeout(hasClip ? 9000 : 3000);

    // 2. Storage mid-session.
    const storage = await page.evaluate(() =>
      (window as unknown as { harness: { storage(): Promise<unknown> } }).harness.storage(),
    );
    expect(binaryMarkers(storage)).toEqual([]);
    expect(imageFindings('storage', JSON.stringify(storage))).toEqual([]);
    const idb = (storage as { indexedDB: Record<string, unknown[]> }).indexedDB;
    expect(Object.keys(idb).sort()).toEqual(['mmstudykit/chunks', 'mmstudykit/sessions']);
    expect((idb['mmstudykit/chunks'] ?? []).length).toBeGreaterThan(0);

    const ended = await page.evaluate(() =>
      (window as unknown as { harness: { end(): Promise<unknown> } }).harness.end(),
    );
    expect(ended).toEqual({ sinks: [{ name: 'upload', ok: true }], localDataDeleted: true });

    // 4. After delivery, nothing of the session remains locally.
    const after = (await page.evaluate(() =>
      (window as unknown as { harness: { storage(): Promise<unknown> } }).harness.storage(),
    )) as {
      indexedDB: Record<string, unknown[]>;
      sessionStorage: Record<string, string>;
    };
    expect(after.indexedDB['mmstudykit/chunks']).toEqual([]);
    expect(after.indexedDB['mmstudykit/sessions']).toEqual([]);
    expect(Object.keys(after.sessionStorage).filter((k) => k.startsWith('mmstudykit:'))).toEqual(
      [],
    );
    await context.close();

    // 1. Network: same-origin only, and only what we expect.
    expect(escaped).toEqual([]);
    for (const r of requests) {
      const path = new URL(r.url).pathname;
      if (r.method === 'POST') expect(path).toBe('/upload');
      else expect(r.method).toBe('GET');
    }
    // The worker's own requests are visible to the route (so a leak from it would be caught too).
    const paths = requests.map((r) => new URL(r.url).pathname);
    expect(paths).toContain('/mmstudykit-face/face_landmarker.task');
    expect(paths).toContain('/mmstudykit-face/vision_wasm_internal.wasm');

    // 3. The uploaded bundle.
    expect(uploads).toHaveLength(1);
    const zip = new Uint8Array(uploads[0] ?? Buffer.alloc(0));
    const files = unzipSync(zip);
    const names = Object.keys(files).map((p) => p.replace(/^session_[^/]+\//, ''));
    for (const n of names)
      expect(n).toMatch(/^(manifest\.json|streams\/[a-z0-9_.]+\.(csv|jsonl))$/);
    for (const [path, data] of Object.entries(files))
      expect(imageFindings(path, data), path).toEqual([]);
    const manifestEntry = Object.entries(files).find(([p]) => p.endsWith('/manifest.json'));
    const manifest = JSON.parse(strFromU8(manifestEntry?.[1] ?? new Uint8Array())) as {
      sensors: { id: string; enabled: boolean; notes?: string[] }[];
      streams: { name: string; stats: { count: number } }[];
      quality?: { face?: { facePresentRatio: number | null } };
    };
    const schema = JSON.parse(
      readFileSync(join(root, '../../spec/manifest.schema.json'), 'utf8'),
    ) as object;
    const ajv = new Ajv2020({
      strict: true,
      strictTuples: false,
      allErrors: true,
      validateFormats: false,
    });
    const validate = ajv.compile(schema);
    expect(validate(manifest), ajv.errorsText(validate.errors)).toBe(true);
    const faceInfo = manifest.sensors.find((s) => s.id === 'face');
    expect(faceInfo?.enabled).toBe(true);
    expect(faceInfo?.notes).toContain(
      'egress guard blocked 1 request(s) to odml.pa.googleapis.com (MediaPipe usage metrics)',
    );
    expect(faceInfo?.notes?.some((n) => n.startsWith('engine: worker'))).toBe(true);
    const count = (s: string) => manifest.streams.find((x) => x.name === s)?.stats.count ?? 0;
    expect(count('face.frames')).toBeGreaterThan(10);
    if (hasClip && name === 'chromium') {
      // The recorded clip has a face in most frames.
      expect(manifest.quality?.face?.facePresentRatio ?? 0).toBeGreaterThan(0.6);
      expect(count('face.blendshapes')).toBeGreaterThan(10);
    }

    // 5. Under the strict CSP, nothing was refused or broke.
    expect(problems).toEqual([]);
  });
});
