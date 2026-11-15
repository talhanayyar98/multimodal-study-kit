// Cross-language round trip: TypeScript writes bundles, Python reads them.
//
//   pnpm roundtrip            (uses python/mmstudykit/.venv if present, else python3)
//   PYTHON=python pnpm roundtrip
//
// 1. core's roundtrip test writes a zip of awkward values + the rows it emitted.
// 2. the vanilla example's e2e test drives a real study in Chromium and saves its download.
// 3. pytest loads every zip and compares values and dtypes with the manifest.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.roundtrip');
const venv = join(root, 'python/mmstudykit/.venv/bin/python');
const python = process.env.PYTHON ?? (existsSync(venv) ? venv : 'python3');
const env = { ...process.env, MMSK_ROUNDTRIP_DIR: out, MMSK_REQUIRE_ROUNDTRIP: '1' };

rmSync(out, { recursive: true, force: true });

const steps = [
  [
    'pnpm',
    [
      '--filter',
      '@mmstudykit/core',
      'exec',
      'vitest',
      'run',
      '--project',
      'node',
      'test/roundtrip.test.ts',
    ],
    root,
  ],
  ['pnpm', ['--filter', '@mmstudykit/example-vanilla', 'test'], root],
  [python, ['-m', 'pytest', '-q', 'tests/test_roundtrip.py'], join(root, 'python/mmstudykit')],
];

for (const [cmd, args, cwd] of steps) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const res = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}
