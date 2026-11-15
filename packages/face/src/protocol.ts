/** Messages between the main thread and the face engine (worker or main-thread fallback). */
import type { ResolvedAssets } from './assets.js';

export type Delegate = 'CPU' | 'GPU';

export interface EngineInit {
  assets: ResolvedAssets;
  delegate: Delegate;
  blendshapes: boolean;
  headPose: boolean;
  iris: boolean;
  /** Landmark indices to output, or null for none. */
  landmarks: readonly number[] | null;
  /** Draw every frame through a 2D canvas first (normalizes exotic camera frame formats). */
  normalize: boolean;
}

export interface EngineReady {
  /** The delegate actually in use (after any fallback). */
  delegate: Delegate;
  initMs: number;
  /** True if the model's SHA-256 matched; null if not checked (no WebCrypto, or disabled). */
  modelVerified: boolean | null;
}

/**
 * Per-frame output: numbers only. Image data never leaves the engine. Feature arrays are present
 * only when a face was found and the feature is enabled, in the column order of their streams.
 */
export interface FrameResult {
  id: number;
  face: boolean;
  inferenceMs: number;
  /** Mean luma 0–1 of the frame. */
  brightness: number;
  blendshapes: (number | null)[] | null;
  headPose: number[] | null;
  iris: (number | null)[] | null;
  landmarks: (number | null)[] | null;
  /** Set (main thread only) when the frame could not be processed because the engine failed. */
  failed?: true;
}

export type ToEngine =
  | { type: 'init'; init: EngineInit }
  | { type: 'frame'; id: number; t: number; frame: ImageBitmap }
  | { type: 'close' };

export type FromEngine =
  | { type: 'ready'; ready: EngineReady }
  | { type: 'result'; result: FrameResult }
  | { type: 'note'; text: string }
  | { type: 'fatal'; message: string }
  | { type: 'closed'; blocked: string[] };
