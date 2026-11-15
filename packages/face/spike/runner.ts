/**
 * Worker spike (PLAN.md §7): the MediaPipe side, shared by the main-thread pipeline and both
 * worker builds. Not published; it exists to answer "where can FaceLandmarker 1.2.3 run, and
 * how well?" with data instead of assumptions.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export interface RunnerOptions {
  /** Absolute URL of the assets folder (wasm/ and face_landmarker.task inside), ending in '/'. */
  base: string;
  delegate: 'CPU' | 'GPU';
  useModule: boolean;
}

export interface Runner {
  initMs: number;
  detect(
    frame: ImageBitmap | VideoFrame | OffscreenCanvas,
    timestampMs: number,
  ): { faces: number; ms: number };
  close(): void;
}

/**
 * Let `fetch` reach only URLs under `base`. Everything else is refused and recorded. MediaPipe's
 * metrics logger uses the global fetch and disables itself after one failed send.
 */
export function installEgressGuard(base: string, blocked: string[]): void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(raw, globalThis.location.href);
    if (!url.href.startsWith(base)) {
      blocked.push(`${url.origin}${url.pathname}`);
      return Promise.reject(new TypeError(`blocked by egress guard: ${url.origin}`));
    }
    return real(input, init);
  };
}

export async function createRunner(opts: RunnerOptions): Promise<Runner> {
  const t0 = performance.now();
  const fileset = await FilesetResolver.forVisionTasks(`${opts.base}wasm`, opts.useModule);
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${opts.base}face_landmarker.task`, delegate: opts.delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  const initMs = performance.now() - t0;
  let last = -1;
  return {
    initMs,
    detect(frame, timestampMs) {
      // detectForVideo needs strictly increasing timestamps.
      const ts = Math.max(timestampMs, last + 1);
      last = ts;
      const start = performance.now();
      const result = landmarker.detectForVideo(frame, ts);
      return { faces: result.faceLandmarks.length, ms: performance.now() - start };
    },
    close() {
      landmarker.close();
    },
  };
}
