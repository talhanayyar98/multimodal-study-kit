# Face sensor (`@mmstudykit/face`)

Webcam face features from MediaPipe Face Landmarker, computed on the participant's device. **Video is never stored or sent.** Only numbers leave the engine, and core's sample guard rejects anything that isn't one.

## Setup

```sh
pnpm add @mmstudykit/core @mmstudykit/face
npx mmstudykit-face copy-assets public/mmstudykit-face   # e.g. in "postinstall" or before "build"
```

`copy-assets` puts these files in one folder (about 19 MB, cacheable), each with a SHA-256 in `mmsk-face-assets.json`:

- the bundled engine (`mmsk-face-worker.js`, `mmsk-face-engine.js`)
- MediaPipe's wasm (`vision_wasm_internal.js`/`.wasm`), from the installed `@mediapipe/tasks-vision`, which must match the bundled version
- the model (`face_landmarker.task`, float16 v1, checked against its pinned SHA-256)

Serve the folder from the **same origin** as the study. Participants then load nothing from CDNs or Google. The model is downloaded once, on your machine or CI, from Google's model storage. It isn't vendored in the npm package because its licence couldn't be confirmed from the model card. Pass `--model <file>` to use a copy you already have.

```ts
import { createSession, downloadSink } from '@mmstudykit/core';
import { face } from '@mmstudykit/face';

const session = await createSession({
  studyId: 'reading-pilot',
  participantId: 'P017',
  sensors: [face({ fps: 15, assets: '/mmstudykit-face/' })],
  sinks: [downloadSink()],
});
```

The camera permission prompt appears at `session.start()`, after consent. MediaPipe's code is only fetched after that.

## Streams

All streams are joined on `t`, the session time of the camera frame: rVFC `captureTime` if the browser provides it, otherwise `presentationTime`, otherwise the callback time. Which one was used is recorded per row in `face.frames.timing`.

| Stream             | Rows                         | Columns                                                                                                                                              |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `face.frames`      | every processed frame        | `t_processed` (result arrived), `face` (0/1), `inference_ms`, `brightness` (mean luma 0–1), `timing`                                                 |
| `face.blendshapes` | frames with a face           | the 52 MediaPipe blendshapes as snake_case, 0–1 (`mouth_smile_left`, …)                                                                              |
| `face.headpose`    | frames with a face           | `yaw`, `pitch`, `roll` (deg), `tx`, `ty`, `tz` (cm, approximate)                                                                                     |
| `face.iris`        | frames with a face           | per eye (subject's `right_*`, `left_*`): `iris_x`, `iris_y` (normalized image), `iris_h`, `iris_v` (in eye widths), `openness` (lid gap / eye width) |
| `face.landmarks`   | opt-in only, every Nth frame | `lm_<i>_x/y/z` for the chosen mesh points                                                                                                            |
| `face.quality`     | 1 Hz                         | `effective_fps`, frames delivered / skipped by the limiter / dropped while busy, `face_present_ratio`, `brightness`, inference and latency p50/p95   |

`manifest.quality.face` summarises the whole session. `manifest.sensors[face].notes` records:

- the delivered camera format (never the camera's name or id)
- the engine (worker or main thread)
- the delegate
- model verification
- any fallback
- how many requests the egress guard blocked

## Conventions

- **Left and right are the subject's**, never the viewer's, in every column. Frames are never mirrored before analysis: MediaPipe's blendshapes invert under mirrored input. Mirror only a preview, with CSS.
- **Image coordinates** have x to the right and y down, normalized 0–1, in the unmirrored camera image.
- **Iris features** are computed in pixels, so they're correct for non-square frames and rotation-invariant (a tilted head doesn't shift them):
  - `iris_h` is the position along the outer→inner eye-corner axis: 0 at the outer corner, 1 at the inner, about 0.5 when looking straight ahead.
  - `iris_v` is the offset from that axis, positive towards the lower lid.
  - These are uncalibrated eye-in-head measures, **not** gaze on the screen.
- **Head pose** decomposes MediaPipe's facial transformation matrix as R = R_y(yaw)·R_x(pitch)·R_z(roll). The matrix's storage order is detected from the data and noted in the manifest. _Which physical direction is positive is being verified against a recorded clip and will be documented here; until then, treat the signs as unverified._ Translation is in cm in MediaPipe's camera model, which assumes a default field of view, so `tz` is only approximately the distance.

## Privacy

- **No video leaves the engine.** Frames exist as transient `ImageBitmap`s that are closed after inference. The privacy e2e test (`packages/face/e2e`) runs the real camera path in Chromium and Firefox and checks four things:
  - every request is same-origin
  - IndexedDB, local/session storage, Cache Storage and OPFS hold no binary values or image signatures
  - the uploaded bundle contains only CSV/JSONL and the manifest
  - local data is gone after delivery
- **MediaPipe's usage metrics are blocked.** MediaPipe Tasks ≥ 1.0 POSTs usage metrics to `odml.pa.googleapis.com` with no opt-out. In the worker, `fetch` only reaches the model and wasm URLs, and `XMLHttpRequest`, `WebSocket` and `EventSource` are disabled. On the main-thread fallback, only that one host is refused. The manifest records each blocked attempt.
- **Recommended CSP.** It's tested in the e2e test:
  ```
  default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' <your sink URLs>;
  img-src 'self'; media-src 'self' blob: mediastream:; style-src 'self'
  ```
- **Pausing releases the camera**, so the camera light goes off. It's reopened on resume.
- **Landmarks are opt-in** (`landmarks: 'iris' | 'eyes' | 'full' | number[]`). They're recorded only if the participant grants `face.landmarks`, which appears in `describe()` as a separate option. Face mesh coordinates are close to biometric data, so prefer a subset, a lower rate (`landmarksEvery`) and limited precision. `manifest.privacy.faceLandmarksRecorded` records the choice.
- **Exported face features are personal data.** Head pose, blendshapes and iris measures can still contribute to re-identification and are pseudonymous personal data under GDPR, not anonymous data.

## Engine and performance

- **Where it runs:** a classic worker by default, falling back to the main thread. See [face-worker.md](face-worker.md) for the measurements behind this.
- **Delegate:** CPU by default. The GPU option falls back to CPU if it fails, and if a frame aborts mid-session the engine rebuilds once with the other delegate.
- **Frame rate:** `fps` (default 15) is the processing rate. A 30 fps camera yields every second frame. If the engine is still busy, a frame is dropped rather than queued, so latency stays bounded. Both counts are in `face.quality`.
- **Background tabs:** browsers stop delivering video frames to hidden tabs, so there are no `face.frames` rows while the tab is hidden. `page.events` (visibility) explains the gap.
- **Phones:** best-effort in v0.1. The target is desktop and laptop browsers plus iPad (Safari ≥ 17).
