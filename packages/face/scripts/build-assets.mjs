// Bundles the face engine into self-hostable assets (dist/assets/) and the CLI (dist/cli.js).
// MediaPipe's JS is bundled here, so the researcher's app never imports it: it loads from the
// assets folder only after consent. Its wasm and the model are added by `copy-assets`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/assets');
mkdirSync(out, { recursive: true });

const mediapipe = JSON.parse(
  readFileSync(join(root, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8'),
);
const self = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const banner = `/* ${self.name} ${self.version} — bundles @mediapipe/tasks-vision ${mediapipe.version} (Apache-2.0, © Google LLC). See THIRD_PARTY_NOTICES.txt. */`;

const common = {
  bundle: true,
  target: 'es2022',
  logLevel: 'warning',
  legalComments: 'eof',
  banner: { js: banner },
  // Readable, so ethics reviewers and researchers can audit what runs on participants' devices.
  minify: false,
};
await build({
  ...common,
  entryPoints: [join(root, 'src/worker-entry.ts')],
  format: 'iife',
  outfile: join(out, 'mmsk-face-worker.js'),
});
await build({
  ...common,
  entryPoints: [join(root, 'src/engine-entry.ts')],
  format: 'esm',
  outfile: join(out, 'mmsk-face-engine.js'),
});
await build({
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(root, 'dist/cli.js'),
  banner: { js: '#!/usr/bin/env node' },
});

const apache = readFileSync(join(root, '../../LICENSE'), 'utf8');
writeFileSync(
  join(out, 'THIRD_PARTY_NOTICES.txt'),
  `The files mmsk-face-worker.js and mmsk-face-engine.js bundle @mediapipe/tasks-vision ${mediapipe.version}.
copy-assets adds vision_wasm_internal.js and vision_wasm_internal.wasm from the same package, and the
FaceLandmarker model bundle (face_landmarker.task) downloaded from Google's model storage.

@mediapipe/tasks-vision: Copyright Google LLC. Licensed under the Apache License, Version 2.0
(declared in its package.json; the package ships no separate license file). Full text below.

${apache}`,
);
console.log(`[face] assets built in ${out}`);
