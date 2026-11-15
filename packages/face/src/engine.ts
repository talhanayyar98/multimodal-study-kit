/**
 * The face engine: MediaPipe FaceLandmarker + feature extraction. Runs in the worker (default)
 * or, as a fallback, on the main thread. It is bundled into the self-hosted assets
 * (`mmsk-face-worker.js`, `mmsk-face-engine.js`) and never into the researcher's app bundle,
 * so MediaPipe's code only loads after the participant consented to the face sensor.
 *
 * Lessons carried over from the maintainer's thesis prototype (PLAN.md §7):
 * - The wasm runtime tolerates neither concurrent init nor close() during a detect call, so the
 *   engine is driven by one serial message queue and close() runs only between frames.
 * - Some cameras (e.g. Continuity Camera) deliver GPU-backed frames the wasm importer aborts on;
 *   drawing through a 2D canvas first normalizes them (`normalize`, on by default).
 * - detectForVideo needs strictly increasing timestamps.
 * - A wasm abort mid-session is survivable once: rebuild with the other delegate.
 */
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision';

import {
  blendshapeScores,
  detectLayout,
  eyeFeatures,
  headPoseFromMatrix,
  landmarkValues,
  meanLuma,
} from './extract.js';
import type { MatrixLayout } from './extract.js';
import type { Delegate, EngineInit, EngineReady, FrameResult } from './protocol.js';

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function context2d(c: AnyCanvas, readback: boolean): Canvas2D {
  // HTMLCanvasElement doesn't exist in workers, so test for OffscreenCanvas first.
  let ctx: Canvas2D | null;
  if (typeof OffscreenCanvas !== 'undefined' && c instanceof OffscreenCanvas) {
    ctx = readback ? c.getContext('2d', { willReadFrequently: true }) : c.getContext('2d');
  } else {
    const html = c as HTMLCanvasElement;
    ctx = readback ? html.getContext('2d', { willReadFrequently: true }) : html.getContext('2d');
  }
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Engine {
  readonly #init: EngineInit;
  readonly #model: Uint8Array;
  readonly #note: (text: string) => void;
  #landmarker: FaceLandmarker;
  #delegate: Delegate;
  #recovered = false;
  #lastTs = -1;
  #frameCanvas: AnyCanvas | null = null;
  #frameCtx: Canvas2D | null = null;
  readonly #lumaCanvas: AnyCanvas;
  readonly #lumaCtx: Canvas2D;
  #layout: MatrixLayout | null = null;
  #unknownReported = false;

  private constructor(
    init: EngineInit,
    model: Uint8Array,
    landmarker: FaceLandmarker,
    delegate: Delegate,
    note: (t: string) => void,
  ) {
    this.#init = init;
    this.#model = model;
    this.#landmarker = landmarker;
    this.#delegate = delegate;
    this.#note = note;
    this.#lumaCanvas = makeCanvas(32, 24);
    this.#lumaCtx = context2d(this.#lumaCanvas, true);
  }

  static async create(
    init: EngineInit,
    note: (text: string) => void,
  ): Promise<{ engine: Engine; ready: EngineReady }> {
    const t0 = performance.now();
    const res = await fetch(init.assets.model);
    if (!res.ok)
      throw new Error(`model download failed: HTTP ${res.status} for ${init.assets.model}`);
    const buf = await res.arrayBuffer();
    let modelVerified: boolean | null = null;
    if (init.assets.modelSha256) {
      const got = await sha256Hex(buf);
      if (got !== null) {
        if (got !== init.assets.modelSha256) {
          throw new Error(
            `model checksum mismatch (got ${got.slice(0, 12)}…, want ${init.assets.modelSha256.slice(0, 12)}…): re-run copy-assets`,
          );
        }
        modelVerified = true;
      }
    }
    const model = new Uint8Array(buf);
    let delegate = init.delegate;
    let landmarker: FaceLandmarker;
    try {
      landmarker = await Engine.#build(init, model, delegate);
    } catch (error) {
      if (delegate !== 'GPU') throw error;
      note(`GPU delegate failed to initialize (${message(error)}); using CPU`);
      delegate = 'CPU';
      landmarker = await Engine.#build(init, model, delegate);
    }
    const engine = new Engine(init, model, landmarker, delegate, note);
    return { engine, ready: { delegate, initMs: performance.now() - t0, modelVerified } };
  }

  static #build(init: EngineInit, model: Uint8Array, delegate: Delegate): Promise<FaceLandmarker> {
    return FaceLandmarker.createFromOptions(
      { wasmLoaderPath: init.assets.wasmLoader, wasmBinaryPath: init.assets.wasmBinary },
      {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: init.blendshapes,
        outputFacialTransformationMatrixes: init.headPose,
      },
    );
  }

  get delegate(): Delegate {
    return this.#delegate;
  }

  /**
   * Process one frame. Closes the frame. Throws only if the pipeline failed twice (the caller
   * then treats it as fatal).
   */
  async process(frame: ImageBitmap, id: number, t: number): Promise<FrameResult> {
    try {
      const w = frame.width;
      const h = frame.height;
      let input: ImageBitmap | AnyCanvas = frame;
      if (this.#init.normalize) {
        if (!this.#frameCanvas || this.#frameCanvas.width !== w || this.#frameCanvas.height !== h) {
          this.#frameCanvas = makeCanvas(w, h);
          this.#frameCtx = context2d(this.#frameCanvas, false);
        }
        this.#frameCtx?.drawImage(frame, 0, 0, w, h);
        input = this.#frameCanvas;
      }
      this.#lumaCtx.drawImage(input, 0, 0, 32, 24);
      const brightness = meanLuma(this.#lumaCtx.getImageData(0, 0, 32, 24).data);

      const ts = Math.max(Math.round(t), this.#lastTs + 1, 0);
      this.#lastTs = ts;
      const start = performance.now();
      let result: FaceLandmarkerResult;
      try {
        result = this.#landmarker.detectForVideo(input, ts);
      } catch (error) {
        result = await this.#recover(error, input, ts);
      }
      const inferenceMs = performance.now() - start;
      return this.#extract(id, result, w, h, inferenceMs, brightness);
    } finally {
      frame.close();
    }
  }

  async #recover(
    error: unknown,
    input: ImageBitmap | AnyCanvas,
    ts: number,
  ): Promise<FaceLandmarkerResult> {
    if (this.#recovered) throw error;
    this.#recovered = true;
    const next: Delegate = this.#delegate === 'GPU' ? 'CPU' : 'GPU';
    this.#note(`pipeline aborted (${message(error)}); rebuilt once with the ${next} delegate`);
    try {
      this.#landmarker.close();
    } catch {
      // An aborted wasm instance may refuse to close; nothing left to free.
    }
    this.#landmarker = await Engine.#build(this.#init, this.#model, next);
    this.#delegate = next;
    return this.#landmarker.detectForVideo(input, ts + 1);
  }

  #extract(
    id: number,
    r: FaceLandmarkerResult,
    w: number,
    h: number,
    inferenceMs: number,
    brightness: number,
  ): FrameResult {
    const landmarks = r.faceLandmarks[0];
    const base: FrameResult = {
      id,
      face: landmarks !== undefined,
      inferenceMs,
      brightness,
      blendshapes: null,
      headPose: null,
      iris: null,
      landmarks: null,
    };
    if (!landmarks) return base;

    if (this.#init.blendshapes) {
      const categories = r.faceBlendshapes[0]?.categories ?? [];
      const { scores, unknown } = blendshapeScores(categories);
      if (unknown.length && !this.#unknownReported) {
        this.#unknownReported = true;
        this.#note(`unknown blendshape names ignored: ${unknown.join(', ')}`);
      }
      base.blendshapes = categories.length ? scores : null;
    }
    if (this.#init.headPose) {
      const m = r.facialTransformationMatrixes[0];
      if (m?.data.length === 16) {
        if (!this.#layout) {
          this.#layout = detectLayout(m.data);
          if (this.#layout) this.#note(`transformation matrix layout: ${this.#layout}`);
        }
        if (this.#layout) {
          const p = headPoseFromMatrix(m.data, this.#layout);
          base.headPose = [p.yaw, p.pitch, p.roll, p.tx, p.ty, p.tz];
        }
      }
    }
    if (this.#init.iris) {
      base.iris = [
        ...eyeFeatures(landmarks, 'right', w, h),
        ...eyeFeatures(landmarks, 'left', w, h),
      ];
    }
    if (this.#init.landmarks) base.landmarks = landmarkValues(landmarks, this.#init.landmarks);
    return base;
  }

  close(): void {
    try {
      this.#landmarker.close();
    } catch {
      // See #recover.
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`.slice(0, 200)
    : String(error).slice(0, 200);
}
