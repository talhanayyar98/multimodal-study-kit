/**
 * `mmstudykit-face copy-assets <dir> [--model <path>]`
 *
 * Puts everything the face sensor loads into one folder you serve with your study: the bundled
 * worker and engine, MediaPipe's wasm (from the installed @mediapipe/tasks-vision, which must be
 * the version the engine was bundled with) and the model, verified by SHA-256. Participants then
 * load nothing from CDNs or Google.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSET_FILES, MEDIAPIPE_VERSION, MODEL } from './assets.js';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function usage(code: number): never {
  console.log(`Usage: mmstudykit-face copy-assets <dir> [--model <path-to-face_landmarker.task>]

Copies the face sensor's assets into <dir> (e.g. public/mmstudykit-face) and downloads the model
unless --model is given or <dir> already has a verified copy. Then use face({ assets: '/mmstudykit-face/' }).`);
  process.exit(code);
}

async function main(argv: string[]): Promise<void> {
  const [command, dir, ...rest] = argv;
  if (command !== 'copy-assets' || !dir) usage(command === '--help' || command === '-h' ? 0 : 1);
  let modelPath: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--model') modelPath = rest[++i] ?? usage(1);
    else usage(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const assetsDir = join(here, 'assets');
  const require = createRequire(import.meta.url);
  // Its exports map hides package.json; it sits next to the main entry.
  const mpPkg = JSON.parse(
    readFileSync(join(dirname(require.resolve('@mediapipe/tasks-vision')), 'package.json'), 'utf8'),
  ) as { version: string };
  if (mpPkg.version !== MEDIAPIPE_VERSION) {
    throw new Error(
      `@mediapipe/tasks-vision ${mpPkg.version} is installed, but the engine was bundled with ${MEDIAPIPE_VERSION}. The wasm must match the bundled JS: reinstall dependencies.`,
    );
  }
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });

  copyFileSync(join(assetsDir, ASSET_FILES.worker), join(out, ASSET_FILES.worker));
  copyFileSync(join(assetsDir, ASSET_FILES.engine), join(out, ASSET_FILES.engine));
  copyFileSync(join(assetsDir, 'THIRD_PARTY_NOTICES.txt'), join(out, 'THIRD_PARTY_NOTICES.txt'));
  copyFileSync(
    require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.js'),
    join(out, ASSET_FILES.wasmLoader),
  );
  copyFileSync(
    require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.wasm'),
    join(out, ASSET_FILES.wasmBinary),
  );

  const modelOut = join(out, ASSET_FILES.model);
  let model: Buffer | null = null;
  if (modelPath) model = readFileSync(modelPath);
  else if (existsSync(modelOut)) {
    const existing = readFileSync(modelOut);
    if (sha256(existing) === MODEL.sha256) model = existing;
  }
  if (!model) {
    console.log(`downloading ${MODEL.url} …`);
    const res = await fetch(MODEL.url);
    if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
    model = Buffer.from(await res.arrayBuffer());
  }
  const got = sha256(model);
  if (got !== MODEL.sha256)
    throw new Error(`model checksum mismatch: got ${got}, expected ${MODEL.sha256}`);
  writeFileSync(modelOut, model);

  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const name of [
    ASSET_FILES.worker,
    ASSET_FILES.engine,
    ASSET_FILES.wasmLoader,
    ASSET_FILES.wasmBinary,
    ASSET_FILES.model,
  ]) {
    const buf = readFileSync(join(out, name));
    files[name] = { sha256: sha256(buf), bytes: buf.length };
  }
  const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  writeFileSync(
    join(out, ASSET_FILES.manifest),
    `${JSON.stringify({ package: pkg.name, version: pkg.version, mediapipe: MEDIAPIPE_VERSION, files }, null, 2)}\n`,
  );
  const mb = Object.values(files).reduce((s, f) => s + f.bytes, 0) / 1e6;
  console.log(`face assets ready in ${out} (${mb.toFixed(1)} MB). Serve them same-origin, e.g. at /mmstudykit-face/.
Suggested Content-Security-Policy additions: worker-src 'self'; connect-src 'self' (and your sink URLs only).`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`mmstudykit-face: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
