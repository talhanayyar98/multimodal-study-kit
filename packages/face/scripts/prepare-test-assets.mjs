// Puts real face assets into .test-assets/mmstudykit-face via the CLI, before Vitest starts.
// (Not a Vitest globalSetup: Vite lists public files when its server starts, so they must
// exist by then.)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureModel } from './model.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'dist/cli.js'))) {
  execFileSync('node', ['scripts/build-assets.mjs'], { cwd: root, stdio: 'inherit' });
}
const model = await ensureModel();
execFileSync(
  'node',
  ['dist/cli.js', 'copy-assets', '.test-assets/mmstudykit-face', '--model', model],
  { cwd: root, stdio: 'pipe' },
);
