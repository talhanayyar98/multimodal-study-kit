/**
 * The self-hosted asset folder (`mmstudykit-face copy-assets <dir>` creates it). Everything the
 * face sensor loads comes from here, so participants never contact a CDN or Google.
 */
export const ASSET_FILES = {
  /** Classic worker: MediaPipe + extractors + egress guard, bundled. */
  worker: 'mmsk-face-worker.js',
  /** The same engine as an ES module, for the main-thread fallback. */
  engine: 'mmsk-face-engine.js',
  wasmLoader: 'vision_wasm_internal.js',
  wasmBinary: 'vision_wasm_internal.wasm',
  model: 'face_landmarker.task',
  /** Versions and SHA-256 of every file, written by copy-assets. */
  manifest: 'mmsk-face-assets.json',
} as const;

/** FaceLandmarker bundle (float16, version 1), pinned by URL and SHA-256. */
export const MODEL = {
  url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  bytes: 3_758_596,
} as const;

/** The audited MediaPipe version (metrics behaviour checked, PLAN.md §12 Q3). */
export const MEDIAPIPE_VERSION = '1.2.3';

export const DEFAULT_ASSETS_BASE = '/mmstudykit-face/';

export interface FaceAssets {
  /** Folder URL with every file of {@link ASSET_FILES}. Default `/mmstudykit-face/`. */
  base?: string;
  worker?: string;
  engine?: string;
  wasmLoader?: string;
  wasmBinary?: string;
  model?: string;
  /** Expected SHA-256 of the model (lowercase hex). null disables the check. */
  modelSha256?: string | null;
}

export interface ResolvedAssets {
  worker: string;
  engine: string;
  wasmLoader: string;
  wasmBinary: string;
  model: string;
  modelSha256: string | null;
}

/** Resolve asset URLs against the document, so relative paths work like in HTML. */
export function resolveAssets(
  assets: string | FaceAssets | undefined,
  baseUrl: string,
): ResolvedAssets {
  const a: FaceAssets = typeof assets === 'string' ? { base: assets } : (assets ?? {});
  let base = a.base ?? DEFAULT_ASSETS_BASE;
  if (!base.endsWith('/')) base += '/';
  const abs = (explicit: string | undefined, file: string) =>
    new URL(explicit ?? base + file, baseUrl).href;
  return {
    worker: abs(a.worker, ASSET_FILES.worker),
    engine: abs(a.engine, ASSET_FILES.engine),
    wasmLoader: abs(a.wasmLoader, ASSET_FILES.wasmLoader),
    wasmBinary: abs(a.wasmBinary, ASSET_FILES.wasmBinary),
    model: abs(a.model, ASSET_FILES.model),
    modelSha256: a.modelSha256 === undefined ? MODEL.sha256 : a.modelSha256,
  };
}
