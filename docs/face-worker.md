# Face engine: where MediaPipe runs (worker spike)

_Run 2026-11-15 with `@mediapipe/tasks-vision` 1.2.3. Reproduce with `pnpm --filter @mmstudykit/face spike` (add `--quick` for a subset, `--headed` for real-GPU numbers). Raw data: [`packages/face/spike/results.json`](../packages/face/spike/results.json)._

## Question

Can FaceLandmarker 1.2.3 run off the main thread in every target browser? With which loader, delegate and frame type? And does blocking the usage-metrics request work there?

## Method

- **Harness:** a page with MediaPipe pre-bundled three ways, as the shipped package does: on the main thread (ESM), in a classic worker (IIFE) and in a module worker (ESM). Assets are served from the same origin.
- **Engines:** Playwright 1.65.1, headless. Chromium 159, Firefox 159 and WebKit 27.2 (the engine behind Safari 26).
- **Frames:** synthetic 640×480 frames, passed as `ImageBitmap` or `VideoFrame`. Optionally each frame is drawn through a 2D `OffscreenCanvas` first. There are 30 frames per configuration, and the first 5 are discarded as warm-up.
- **Network:** the runner aborts and records every request that leaves `127.0.0.1`. In workers, a `fetch` allowlist (the egress guard) is installed before MediaPipe loads.

**Limits of these numbers.** The frames contain no face, so the timings cover the face _detector_ only. The landmark and blendshape models run only while a face is tracked, so real per-frame cost is higher. Numbers with the recorded clip will be added once it's in the repo. Headless Chromium has no GPU and falls back to software GL, which is why its GPU delegate looks slower than its CPU one. Use `--headed` on real hardware for GPU conclusions.

## Results (inference p50, ms; init in parentheses)

| Engine location                  | Delegate | Chromium   | Firefox | WebKit  |
| -------------------------------- | -------- | ---------- | ------- | ------- |
| Main thread                      | CPU      | 3.0 (171)  | 4 (317) | 5 (158) |
| Main thread                      | GPU      | 18.0 (137) | 6 (286) | 7 (124) |
| Classic worker                   | CPU      | 3.0 (142)  | 4 (273) | 4 (123) |
| Classic worker                   | GPU      | 17.2 (140) | 6 (273) | 6 (122) |
| Module worker, standard wasm     | any      | fails¹     | fails¹  | fails¹  |
| Module worker + `useModule` wasm | CPU      | 3.2 (142)  | 4 (288) | 5 (129) |
| Module worker + `useModule` wasm | GPU      | 18.0 (139) | 6 (273) | 7 (127) |

¹ `Error: ModuleFactory not set.` In module workers MediaPipe's loader falls back from `importScripts` to dynamic `import()`, which needs the `_module_` wasm loader.

Rows use `ImageBitmap` frames without 2D normalisation. Across all combinations:

- `VideoFrame` performed the same as `ImageBitmap`, within noise.
- Drawing through a 2D canvas first added about 0.5–1 ms per frame.
- Grabbing a frame on the main thread (`createImageBitmap`) took about 0.1 ms.

**Metrics.** In every worker run, the egress guard refused exactly one request: `POST https://odml.pa.googleapis.com/v1/log`, sent by MediaPipe when the task closes. The only requests that tried to leave localhost came from the main-thread runs, which had no guard. The harness aborted those.

**`requestVideoFrameCallback`.** It works for a visible, a hidden (1 px, opacity 0) and a detached `<video>` in all three engines. For a canvas-backed stream, only WebKit reports `captureTime`. With Chrome's fake camera, `captureTime` is present on every frame.

## Decision

- **Default:** a classic worker with the standard wasm loader (`vision_wasm_internal.*`). It works in all three engines, is as fast as the alternatives, and needs neither module-worker support nor a second wasm build. `copy-assets` therefore ships one 14.7 MB wasm, not two.
- **Fallback:** the main thread. It's used when `Worker`/`OffscreenCanvas` are missing or the worker fails to start (for example, the worker script is cross-origin). In that case a narrow `fetch` denylist blocks only the metrics host. The choice is recorded in the manifest (`sensors[].notes`).
- **Delegate:** CPU by default. It wins headless everywhere and avoids GPU-driver variance. GPU is an option; if it fails to initialise, the engine falls back to CPU. If a frame aborts mid-session, it rebuilds once with the other delegate. Revisit the default with `--headed` numbers on real hardware.
- **Frames:** `ImageBitmap` from `createImageBitmap(video)`, transferred to the worker. Each frame is drawn through a 2D canvas there, on by default (`normalizeFrames`). The maintainer's thesis prototype found that some cameras deliver GPU-backed frames the wasm importer aborts on, and this normalisation avoids that.
- **Video element:** detached (not in the DOM). rVFC fires for it in all engines.
