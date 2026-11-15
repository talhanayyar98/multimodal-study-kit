// Worker spike runner: `pnpm --filter @mmstudykit/face spike [--quick] [--headed]`.
// Builds the harness, serves it on 127.0.0.1, runs every configuration in Chromium, Firefox and
// WebKit (headless), aborts and records every request that leaves localhost, and writes
// spike/results.json. See docs/face-worker.md for the write-up.
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';

import { ensureModel } from '../scripts/model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, 'public');
const quick = process.argv.includes('--quick');
// Headless Chromium uses software GL, so GPU numbers need --headed on real hardware.
const headed = process.argv.includes('--headed');

rmSync(pub, { recursive: true, force: true });
mkdirSync(join(pub, 'mediapipe'), { recursive: true });
const common = { bundle: true, target: 'es2022', logLevel: 'warning', legalComments: 'none' };
await build({
  ...common,
  entryPoints: [join(here, 'worker.ts')],
  format: 'iife',
  outfile: join(pub, 'worker-classic.js'),
});
await build({
  ...common,
  entryPoints: [join(here, 'worker.ts')],
  format: 'esm',
  outfile: join(pub, 'worker-module.js'),
});
await build({
  ...common,
  entryPoints: [join(here, 'runner.ts')],
  format: 'esm',
  outfile: join(pub, 'pipeline.js'),
});
await build({
  ...common,
  entryPoints: [join(here, 'page.ts')],
  format: 'esm',
  outfile: join(pub, 'page.js'),
});
cpSync(join(here, '../node_modules/@mediapipe/tasks-vision/wasm'), join(pub, 'mediapipe/wasm'), {
  recursive: true,
});
copyFileSync(await ensureModel(), join(pub, 'mediapipe/face_landmarker.task'));
writeFileSync(
  join(pub, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>spike</title><body><script type="module" src="/page.js"></script>',
);

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  const file = path === '/' ? 'index.html' : path;
  try {
    const body = readFileSync(join(pub, file));
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const configs = [];
for (const mode of ['main', 'classic', 'module']) {
  for (const useModule of mode === 'module' ? [false, true] : [false]) {
    for (const delegate of ['CPU', 'GPU']) {
      for (const frame of ['bitmap', 'videoframe']) {
        for (const normalize of mode === 'main' ? [false] : [false, true]) {
          if (quick && (frame === 'videoframe' || normalize)) continue;
          configs.push({ mode, useModule, delegate, frame, normalize, frames: 30 });
        }
      }
    }
  }
}

const results = [];
for (const [name, type] of [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]) {
  const browser = await type.launch({ headless: !headed });
  const version = browser.version();
  const context = await browser.newContext();
  const escaped = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    escaped.push(url);
    return route.abort();
  });
  const probePage = await context.newPage();
  await probePage.goto(origin);
  await probePage.waitForSelector('body[data-ready]', { state: 'attached' });
  const rvfc = await probePage.evaluate(() => window.rvfcProbe());
  await probePage.close();
  for (const cfg of configs) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin);
    await page.waitForSelector('body[data-ready]', { state: 'attached' });
    const before = escaped.length;
    const r = await page.evaluate((c) => window.runSpike(c), cfg);
    results.push({
      browser: name,
      version,
      ...cfg,
      ...r,
      escaped: escaped.slice(before),
      pageErrors: errors,
    });
    const label = `${cfg.mode}${cfg.useModule ? '+module-wasm' : ''} ${cfg.delegate} ${cfg.frame}${cfg.normalize ? ' +2d' : ''}`;
    console.log(
      `${name.padEnd(8)} ${label.padEnd(36)} ${r.ok ? `init ${r.initMs} ms, infer p50 ${r.inferMsP50} ms, p95 ${r.inferMsP95}, grab ${r.grabMsP50}, blocked ${r.blocked?.length ?? 0}` : `FAIL ${r.error}`}`,
    );
    await page.close();
  }
  results.push({ browser: name, version, rvfc, escapedTotal: escaped });
  console.log(`${name.padEnd(8)} rVFC ${JSON.stringify(rvfc)}`);
  console.log(
    `${name.padEnd(8)} requests that tried to leave localhost: ${escaped.length ? [...new Set(escaped)].join(', ') : 'none'}`,
  );
  await browser.close();
}
server.close();
writeFileSync(
  join(here, 'results.json'),
  `${JSON.stringify({ date: new Date().toISOString(), results }, null, 2)}\n`,
);
