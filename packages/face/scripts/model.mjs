// The FaceLandmarker model bundle: pinned URL + SHA-256, cached in <repo>/.cache/mediapipe/.
// Used by the spike, the tests and the asset build. Downloads happen on developer/CI machines,
// never in a participant's browser.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL = {
  url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  bytes: 3_758_596,
};

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CACHE = join(
  repo,
  '.cache',
  'mediapipe',
  `face_landmarker-${MODEL.sha256.slice(0, 12)}.task`,
);

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Path to a verified copy of the model, downloading it once if needed. */
export async function ensureModel() {
  if (existsSync(CACHE) && sha256(readFileSync(CACHE)) === MODEL.sha256) return CACHE;
  const res = await fetch(MODEL.url);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== MODEL.sha256)
    throw new Error(`model checksum mismatch: got ${got}, want ${MODEL.sha256}`);
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(`${CACHE}.tmp`, buf);
  renameSync(`${CACHE}.tmp`, CACHE);
  return CACHE;
}
