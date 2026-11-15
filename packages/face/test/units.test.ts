import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStream } from '@mmstudykit/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ensureModel } from '../scripts/model.mjs';
import { ASSET_FILES, MODEL, resolveAssets } from '../src/assets.js';
import { BLOCKED_HOSTS, guardMainThread, guardWorkerScope } from '../src/egress.js';
import { FACE_VERSION, face } from '../src/index.js';
import { describeFace, faceStreams, resolveOptions } from '../src/options.js';
import { QualityTracker, shouldProcess } from '../src/quality.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('options and streams', () => {
  it('defaults: all features at 15 fps, CPU, worker-first, no landmarks', () => {
    const r = resolveOptions({});
    expect([...r.features]).toEqual(['blendshapes', 'headPose', 'iris']);
    expect(r).toMatchObject({
      fps: 15,
      delegate: 'CPU',
      backend: 'auto',
      landmarks: null,
      normalizeFrames: true,
    });
    expect(faceStreams(r, new Set()).map((s) => s.name)).toEqual([
      'face.frames',
      'face.blendshapes',
      'face.headpose',
      'face.iris',
      'face.quality',
    ]);
  });

  it('declares valid streams (core accepts them) with the expected widths', () => {
    const r = resolveOptions({ landmarks: 'full' });
    const streams = faceStreams(r, new Set(['landmarks'])).map((s) => resolveStream('face', s));
    const width = Object.fromEntries(streams.map((s) => [s.name, s.columns.length]));
    expect(width).toEqual({
      'face.frames': 6,
      'face.blendshapes': 53,
      'face.headpose': 7,
      'face.iris': 11,
      'face.landmarks': 1 + 478 * 3,
      'face.quality': 10,
    });
  });

  it('adds the landmarks stream only when the opt-in is granted', () => {
    const r = resolveOptions({ landmarks: 'iris', landmarksEvery: 3 });
    expect(faceStreams(r, new Set()).some((s) => s.name === 'face.landmarks')).toBe(false);
    const lm = faceStreams(r, new Set(['landmarks'])).find((s) => s.name === 'face.landmarks');
    expect(lm?.columns.map((c) => c.name).slice(0, 3)).toEqual([
      'lm_468_x',
      'lm_468_y',
      'lm_468_z',
    ]);
    expect(lm?.nominalRateHz).toBe(5);
  });

  it('feeds the privacy flags and the consent option from the landmark setting', () => {
    const none = face();
    expect(none.options).toEqual([]);
    expect(none.privacy?.(new Set())).toEqual({ faceLandmarksRecorded: 'none' });
    const subset = face({ landmarks: 'eyes' });
    expect(subset.options?.[0]?.id).toBe('landmarks');
    expect(subset.privacy?.(new Set())).toEqual({ faceLandmarksRecorded: 'none' });
    expect(subset.privacy?.(new Set(['landmarks']))).toEqual({ faceLandmarksRecorded: 'subset' });
    expect(face({ landmarks: 'full' }).privacy?.(new Set(['landmarks']))).toEqual({
      faceLandmarksRecorded: 'full',
    });
  });

  it('describes itself for the consent form without implying video is kept', () => {
    const d = describeFace(resolveOptions({ fps: 10, features: ['headPose'] }));
    expect(d.summary).toMatch(/10 times per second/);
    expect(d.summary).toMatch(/never saved or sent/);
    expect(d.records.join(' ')).toMatch(/orientation/);
    expect(d.records.join(' ')).not.toMatch(/52/);
    expect(d.neverRecords.join(' ')).toMatch(/camera image or video/);
  });

  it.each([
    [{ fps: 0 }, /fps/],
    [{ fps: 120 }, /fps/],
    [{ features: ['emotion'] }, /unknown feature/],
    [{ landmarks: [0, 999] }, /indices/],
    [{ landmarksEvery: 0 }, /landmarksEvery/],
  ])('rejects %j', (opts, message) => {
    expect(() => resolveOptions(opts as never)).toThrow(message);
  });
});

describe('quality and limiter', () => {
  it('processes every second frame of a 30 fps camera at a 15 fps target, despite jitter', () => {
    let last: number | null = null;
    let processed = 0;
    for (let i = 0; i < 60; i++) {
      const ts = i * 33.33 + (i % 3) * 2; // jitter
      if (shouldProcess(ts, last, 15)) {
        last = ts;
        processed++;
      }
    }
    expect(processed).toBe(30);
  });

  it('summarizes windows and the session', () => {
    const q = new QualityTracker(0);
    for (let i = 0; i < 10; i++) q.delivered();
    q.skipped();
    q.dropped();
    q.result(true, 0.5, 10, 20, 'capture');
    q.result(false, 0.3, 20, 30, 'capture');
    expect(q.takeWindow(1000)).toEqual({
      effective_fps: 2,
      frames_delivered: 10,
      frames_skipped: 1,
      frames_dropped: 1,
      face_present_ratio: 0.5,
      brightness: 0.4,
      inference_ms_p50: 15,
      inference_ms_p95: 19.5,
      latency_ms_p50: 25,
    });
    expect(q.takeWindow(2000)).toMatchObject({
      effective_fps: 0,
      face_present_ratio: null,
      inference_ms_p50: null,
    });
    expect(q.summary()).toMatchObject({
      framesProcessed: 2,
      effectiveFps: 1,
      facePresentRatio: 0.5,
      timingSources: { capture: 2 },
    });
  });
});

describe('egress guards', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    fetch: g.fetch,
    XMLHttpRequest: g.XMLHttpRequest,
    WebSocket: g.WebSocket,
    importScripts: g.importScripts,
    location: g.location,
  };
  afterEach(() => {
    Object.assign(g, saved);
  });

  it('worker scope: allows only the listed URLs and records the rest', async () => {
    const seen: string[] = [];
    g.location = { href: 'https://study.example/mmstudykit-face/mmsk-face-worker.js' };
    g.fetch = (input: string) => {
      seen.push(input);
      return Promise.resolve(new Response('ok'));
    };
    g.WebSocket = class {
      readonly stub = true;
    };
    const imported: string[] = [];
    g.importScripts = (...urls: string[]) => {
      imported.push(...urls);
    };
    const blocked: string[] = [];
    guardWorkerScope(
      [
        'https://study.example/mmstudykit-face/face_landmarker.task',
        'https://study.example/mmstudykit-face/vision_wasm_internal.js',
      ],
      blocked,
    );

    await expect((g.fetch as typeof fetch)('face_landmarker.task')).resolves.toBeInstanceOf(
      Response,
    );
    await expect(
      (g.fetch as typeof fetch)('https://odml.pa.googleapis.com/v1/log', { method: 'POST' }),
    ).rejects.toThrow(/egress guard/);
    await expect((g.fetch as typeof fetch)('https://cdn.jsdelivr.net/x.wasm')).rejects.toThrow();
    expect(() => new (g.WebSocket as new () => unknown)()).toThrow(/disabled/);
    (g.importScripts as (u: string) => void)('vision_wasm_internal.js');
    expect(() => {
      (g.importScripts as (u: string) => void)('https://evil.example/x.js');
    }).toThrow(/blocked/);
    expect(seen).toEqual(['face_landmarker.task']);
    expect(imported).toEqual(['vision_wasm_internal.js']);
    expect(blocked).toEqual([
      'https://odml.pa.googleapis.com/v1/log',
      'https://cdn.jsdelivr.net/x.wasm',
      'WebSocket',
      'https://evil.example/x.js',
    ]);
  });

  it('main thread: blocks only the metrics host, passes the page’s own requests, and releases', async () => {
    const seen: string[] = [];
    const original = (input: string) => {
      seen.push(input);
      return Promise.resolve(new Response('ok'));
    };
    g.fetch = original;
    g.location = { href: 'https://study.example/' };
    const guard = guardMainThread();
    await (g.fetch as typeof fetch)('/api/upload');
    await (g.fetch as typeof fetch)('https://other.example/x');
    await expect((g.fetch as typeof fetch)(`https://${BLOCKED_HOSTS[0]}/v1/log`)).rejects.toThrow();
    expect(seen).toEqual(['/api/upload', 'https://other.example/x']);
    expect(guard.blocked).toEqual(['https://odml.pa.googleapis.com/v1/log']);
    guard.release();
    expect(g.fetch).toBe(original);
  });
});

describe('assets', () => {
  it('resolves URLs against the page, with the pinned model hash', () => {
    const a = resolveAssets(undefined, 'https://study.example/pilot/index.html');
    expect(a.worker).toBe('https://study.example/mmstudykit-face/mmsk-face-worker.js');
    expect(a.modelSha256).toBe(MODEL.sha256);
    const b = resolveAssets(
      { base: 'assets/face', model: 'https://cdn.example/m.task', modelSha256: null },
      'https://study.example/pilot/',
    );
    expect(b.wasmBinary).toBe('https://study.example/pilot/assets/face/vision_wasm_internal.wasm');
    expect(b.model).toBe('https://cdn.example/m.task');
    expect(b.modelSha256).toBeNull();
  });
});

describe('copy-assets CLI', () => {
  let model: string;
  beforeAll(async () => {
    model = await ensureModel();
  });

  it('copies everything, verifies the model and writes an integrity manifest', () => {
    const out = mkdtempSync(join(tmpdir(), 'mmsk-face-'));
    execFileSync('node', [join(root, 'dist/cli.js'), 'copy-assets', out, '--model', model], {
      stdio: 'pipe',
    });
    const manifest = JSON.parse(readFileSync(join(out, ASSET_FILES.manifest), 'utf8')) as {
      mediapipe: string;
      files: Record<string, { sha256: string; bytes: number }>;
    };
    expect(manifest.mediapipe).toBe('1.2.3');
    expect(Object.keys(manifest.files).sort()).toEqual(
      [
        ASSET_FILES.engine,
        ASSET_FILES.model,
        ASSET_FILES.wasmBinary,
        ASSET_FILES.wasmLoader,
        ASSET_FILES.worker,
      ].sort(),
    );
    for (const [name, f] of Object.entries(manifest.files)) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(out, name)))
          .digest('hex'),
      ).toBe(f.sha256);
    }
    expect(manifest.files[ASSET_FILES.model]?.sha256).toBe(MODEL.sha256);
    expect(readFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toMatch(/Apache License/);
  });

  it('refuses a model with the wrong checksum', () => {
    const out = mkdtempSync(join(tmpdir(), 'mmsk-face-'));
    const bad = join(out, 'bad.task');
    writeFileSync(bad, 'not a model');
    const res = spawnSync('node', [join(root, 'dist/cli.js'), 'copy-assets', out, '--model', bad], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/checksum mismatch/);
  });

  it('bundles never phone home on their own: the only Google URL in them is the metrics endpoint the guard blocks', () => {
    for (const file of [ASSET_FILES.worker, ASSET_FILES.engine]) {
      const text = readFileSync(join(root, 'dist/assets', file), 'utf8');
      const urls = [
        ...new Set(
          text.match(
            /https?:\/\/[a-z0-9.-]+\.(?:googleapis|google|gstatic|jsdelivr|unpkg)\.[a-z]+[^\s"'`)]*/gi,
          ) ?? [],
        ),
      ];
      expect(urls, file).toEqual(['https://odml.pa.googleapis.com/v1/log']);
    }
  });
});

describe('version', () => {
  it('FACE_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(FACE_VERSION).toBe(pkg.version);
  });
});
