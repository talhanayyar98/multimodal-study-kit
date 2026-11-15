# PLAN — multimodal-study-kit (working name)

> Status: **M2 nearly done**, 2026-11-15. The face sensor is built and tested; the head-pose sign check and the face-detection e2e wait for the recorded clip (Q5). See [§11 M2](#m2--face-sensor). Every open question in [§12](#12-open-questions) is decided.
> This plan covers architecture, the public API (what a researcher's code looks like), the refined milestones, risks, and the questions that need answers before M1.
> Everything marked _verified_ was checked against current packages or docs on 2026-11-15 (see [§13 Verification log](#13-verification-log)). Everything else is a design proposal.

---

## 0. Where this plan departs from the brief

Most of the brief stands. These are the changes I'm proposing, roughly in order of importance.

1. **MediaPipe Tasks 1.x sends usage metrics to Google by default, with no opt-out.** _Verified_ by reading `@mediapipe/tasks-vision@1.2.3`. Every task creates a metrics logger that POSTs protobuf to `https://odml.pa.googleapis.com/v1/log` every 60 s and on `close()`. The package README (privacy notice dated 2026-06-05) says the app developer is responsible for getting user consent for this. `0.10.35` (the last 0.10 release, 2026-04-27) has no logger. The metrics don't include image data, but each request still sends the participant's IP address, user agent and the study's origin to Google. That breaks "nothing leaves the browser except what the researcher configured". **Proposal:** run MediaPipe in a Worker whose `fetch` only allows the configured asset URLs, and add a CSP `connect-src` to the demo and docs. The logger shuts itself off after its first failed send. The privacy e2e test will assert zero requests to unexpected origins. → [Q3](#12-open-questions)
2. **Self-host the MediaPipe WASM and model by default.** The official examples load WASM from jsDelivr and the model from `storage.googleapis.com`. That's two more third parties that see participant IPs, which ethics boards and GDPR reviewers will ask about. Self-hosting also lets a study enable cross-origin isolation (COOP/COEP), which tightens timer resolution from 100 µs to 5 µs in Chrome.
3. **Fewer npm packages: 5 instead of 8.**
   - `sensor-pointer`, `sensor-keyboard` and `sensor-page` become one `@mmstudykit/sensors` package with subpath exports. They have no dependencies, they're small, and they release together. Three packages would triple the release overhead for no install-size gain, since subpath exports plus tree-shaking give the same isolation.
   - `face` stays separate because of its heavy dependency, WASM and model assets, and worker.
   - The **consent model and its enforcement move into `core`.** "Only consented sensors run" is a core guarantee, and it can't depend on an optional package being installed. The consent UI ships with `react`, with `jspsych` (as a trial), and as a small vanilla helper.
4. **Full face landmarks are opt-in and close to biometric data.** The full 478-point mesh can support re-identification, and it isn't feasible as CSV: at 30 fps for 30 minutes it's about 540 MB (see [§6.4](#64-data-volume-estimates-30-minute-session)). Default to off. When enabled, offer subsets (e.g. iris only), lower rates and limited precision, and record the choice in the manifest. Docs should say plainly that exported data is **pseudonymous personal data, not anonymous** (GDPR Recital 26).
5. **Keystroke timing is a behavioral biometric too.** Category-only recording is the right default, but the docs shouldn't imply that timing is harmless. Also:
   - Never record events from `input[type=password]`.
   - Let researchers scope the keyboard sensor to tagged elements.
   - Pair key-down and key-up inside the browser using `event.code`, which is never stored. Without key identity, overlapping keystrokes (rollover typing) can't be paired afterwards.
6. **Withdrawal has a remote half.** Deleting local buffers isn't enough once an upload sink has already sent chunks. Proposal: withdrawal (a) stops sensors, (b) deletes local data, keeping a tombstone, and (c) calls `onWithdraw()` on every sink. The reference receiver deletes everything it holds for that session. An export after withdrawal contains only a manifest stub with `status: "withdrawn"` and no streams.
7. **Timing claims: separate what we can measure from what we can't.** In the browser we can measure internal consistency: sampling regularity, timestamp overhead, and agreement between streams on one clock. End-to-end latency needs external hardware: when the camera actually captured a frame, when a key was physically pressed, when pixels appeared. The benchmark will report the first kind and give a protocol for the second, without claiming "research-grade" beyond what's measured. I'm also adding `session.markOnNextFrame()`, because a stimulus appears on the next frame, not when the JS runs.
8. **Resuming after a reload creates a new clock segment.** A reload gives a new `performance.timeOrigin`, and there's no monotonic clock that spans page loads. Segments are joined using the wall clock, which is less accurate (it's subject to NTP adjustments). Each boundary is recorded in the manifest so analysts can see it.
9. **jsPsych users need a `<script>`-tag build.** Many jsPsych studies are plain HTML hosted on JATOS, Pavlovia or Cognition.run, without a bundler. The `jspsych` package will also ship an IIFE/CDN bundle, which may also make sense for `core` and `sensors`.
10. **The privacy e2e test needs a harness in M2, before the demo exists in M3.** M2 runs it against a test page with the face pipeline. M3 extends it to the full demo flow.
11. **A minimal Python reader moves into M1.** The export format is the contract, so a cross-language round-trip test (TypeScript writes the bundle, Python reads it) should exist from the first exporter onward. `align`/`epochs` stay in M4.
12. **TypeScript 6.0, not 7.0.** TS 7 (the native Go compiler) has been stable since July 2026, but `typescript-eslint@8.72` has peer `typescript <6.1.0` and type-aware linting needs the TS 7.1 API, which is still in beta. Pin `typescript@6.0.3` everywhere and revisit when typescript-eslint supports 7.x.
13. **EU AI Act wording.** Art. 5(1)(f) doesn't _restrict_ emotion inference in workplaces and education, it **prohibits** it, except for medical or safety reasons. Elsewhere, emotion recognition is high-risk (Annex III) and carries transparency duties (Art. 50(3)). Art. 2(6) excludes systems built and used _solely_ for scientific research. That's relevant to labs, but it doesn't cover deploying a system into real classrooms. The README summary uses this framing and is explicit that it isn't legal advice. The Act was amended in 2026, so the docs point to the consolidated text.
14. **Test video.** Chrome's fake camera accepts `.y4m` and `.mjpeg`. Y4M is uncompressed: 5 s at 640×480 is about 70 MB, too big for git. Use a short low-resolution MJPEG clip (a few MB). We need a face video we have the right to redistribute. → [Q5](#12-open-questions)

---

## 1. Goals and non-goals

**Goals (v0.1)**

- Add synchronized multimodal behavioral data collection to any web study in about 10 lines of code.
- Privacy by construction: no raw video ever stored or sent, no key content by default, pseudonymous IDs, coarse device info, and nothing contacts a third party unless the researcher configures it.
- One shared session clock with documented and measured timing behavior.
- A self-describing, versioned export bundle that loads into pandas in one line, or into R with `read.csv` plus `jsonlite`.
- Works in current Chrome, Edge, Firefox and Safari, with documented degradation.

**Non-goals (v0.1)**

- Inferring emotion, affect, engagement or cognitive state. This is permanent for `core`/`face`, not just deferred.
- Screen-space gaze estimation (webcam eye tracking). There's an extension point for it ([§3.6](#36-extension-point-for-sensor-authors-and-future-gaze-module)).
- Experiment building. jsPsych, lab.js, PsychoJS or the researcher's own app owns trials, stimuli and randomization.
- Hosting or a participant database. Sinks hand data to the researcher's infrastructure.
- XDF/LSL export. The design leaves room for it ([§6.6](#66-xdf--lab-streaming-layer-stretch)).

---

## 2. Architecture

### 2.1 Packages

| Path                | npm / PyPI name¹      | Contents                                                                                                                                                                                             | Runtime deps                                                                              |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/core`     | `@mmstudykit/core`    | Session lifecycle, clock, stream registry, markers, consent model and enforcement, recorder (memory → IndexedDB), resume, manifest, CSV/JSONL encoders, sinks (download zip, HTTP), sensor interface | `fflate` (zip, ~8 kB gz, tree-shaken)                                                     |
| `packages/sensors`  | `@mmstudykit/sensors` | `pointer`, `keyboard`, `page` sensors via subpath exports (`@mmstudykit/sensors/pointer`, …)                                                                                                         | none (peer: core)                                                                         |
| `packages/face`     | `@mmstudykit/face`    | Face sensor on MediaPipe FaceLandmarker, worker and main-thread pipelines, feature extractors, quality metrics, asset helper                                                                         | `@mediapipe/tasks-vision` exactly 1.2.3, bundled into the self-hosted assets (peer: core) |
| `packages/react`    | `@mmstudykit/react`   | `StudySessionProvider`, `useStudySession`, `useSensorQuality`, `<ConsentGate>`, `<CameraCheck>`, `<SensorStatus>`, `<PauseControls>`                                                                 | none (peers: react, core)                                                                 |
| `packages/jspsych`  | `@mmstudykit/jspsych` | jsPsych 8 extension, consent trial, ESM plus IIFE/CDN build                                                                                                                                          | none (peers: jspsych, core)                                                               |
| `python/mmstudykit` | `mmstudykit` (PyPI)   | `load_session`, `align`, `epochs`, typed                                                                                                                                                             | `pandas`, `numpy`                                                                         |
| `apps/demo`         | private               | Next.js demo study and researcher view (static export)                                                                                                                                               | next, react                                                                               |
| `apps/receiver`     | private               | Reference upload receiver that implements `spec/upload-protocol.md`                                                                                                                                  | express                                                                                   |
| `spec/`             | n/a                   | Bundle format spec, JSON Schema, upload protocol, **shared conformance fixtures** used by both TS and Python tests                                                                                   | n/a                                                                                       |
| `docs/`             | n/a                   | Docs site (M5)                                                                                                                                                                                       | n/a                                                                                       |

¹ Confirmed 2026-11-15: the npm scope `@mmstudykit` and the PyPI name `mmstudykit` are both unclaimed. → [Q1](#12-open-questions)

Dependency direction: `sensors`, `face`, `react` and `jspsych` → `core`. Nothing depends on `face` except the apps. `core` has no DOM-framework dependency.

### 2.2 Runtime picture

```
          researcher code / React / jsPsych
                         │  createSession(), mark(), pause(), withdraw(), end()
                         ▼
 ┌──────────────────────── Session (core) ─────────────────────────┐
 │ ConsentState ──gates──► SensorHost ──► Sensor[] (pointer, key,  │
 │      │                       │          page, face, …)          │
 │      │                emit(stream, row)                         │
 │      ▼                       ▼                                  │
 │  Clock (segments,     StreamRegistry ──validate──► Recorder     │
 │  anchors, discont.)   (schemas, units)             │ memory buf │
 │      ▲                                             ▼            │
 │  Markers ─────────────────────────────────►  ChunkStore (IDB /  │
 │                                              memory fallback)   │
 │                                                    │            │
 │  Manifest builder ◄──── stats/quality ─────────────┤            │
 │                                                    ▼            │
 │                                          Sinks: download(zip),  │
 │                                          http(chunked), custom  │
 └─────────────────────────────────────────────────────────────────┘
      face sensor:  <video> ─rVFC─► frame grab ─transfer─► Worker
                    (MediaPipe + extractors) ─► numeric rows only ─► emit
```

### 2.3 Core concepts

**Session** is one participant run, with a state machine:
`created → consented → running ⇄ paused → ended`, with `withdrawn` reachable from any state. A page whose session was resumed elsewhere becomes `superseded` (see Recorder).

- It has `studyId`, `sessionId` (random UUID), a **researcher-provided** `participantId` (never collected automatically; a warning fires if it looks like an email address), and its config.
- `createSession()` is async because it may resume an unfinished session from IndexedDB. A resumed session comes back as `consented` with `resumed: true`. Nothing records until the app calls `start()` again, so the app decides what the participant sees after a reload. A pause still open at reload is closed at the last moment the page was alive.

**Clock**

- Session time `t` is milliseconds since session start, as a float.
- Within a page load, `t = performance.now() − perfAtSegmentStart + segmentOffset`.
- **Anchors** pair `performance.now()` with `Date.now()` at start, every 10 s, and on `visibilitychange`, `pageshow` and `resume`.
- If wall-clock elapsed time differs from monotonic elapsed time by more than 250 ms, the clock records a **discontinuity**: system sleep, a wall-clock jump, or tab freeze. Browsers differ on whether `performance.now()` advances during sleep.
- A reload with resume starts a new **segment**. Its `segmentOffset` comes from wall-clock time since the last persisted anchor, and its `reason` is set to `reload-resume`.

**Stream** is a named, typed time series, `<sensor>.<stream>` in snake_case, e.g. `pointer.move`. Each has:

- `kind`: `samples` (numeric, mostly regular → CSV) or `events` (irregular, possibly nested → JSONL).
- Declared columns with type, unit and description, which feed the manifest and the consent disclosure.
- A nominal rate.

**Sample guard.** The recorder accepts only finite numbers, booleans, `null`, short strings, enum values from the declared schema, and (for JSONL streams only) JSON-serializable plain objects under a size cap. It **rejects** ArrayBuffers, typed arrays, Blobs, ImageData, ImageBitmap, VideoFrame and data URLs. A buggy or third-party sensor therefore can't push pixels into storage, whatever it does internally. This check runs at runtime and is backed by tests.

**Markers**

- `session.mark(name, data?)` timestamps at call time and returns `t`.
- `session.markOnNextFrame(name, data?)` resolves with the next `requestAnimationFrame` timestamp, which approximates frame onset. Use it for stimulus onsets.
- Markers go to `task.markers.jsonl`.

**Recorder**

- Rows buffer in memory, per stream, as columnar arrays.
- Every 2 s, every 2,000 rows, and on `visibilitychange→hidden` or `pagehide`, they flush to the ChunkStore as immutable chunks with sequence numbers.
- The ChunkStore uses IndexedDB, falling back to memory-only when IndexedDB is unavailable. `manifest.environment.persistence` records which was used.
- A `sessionStorage` entry holds only the session ID, so the same tab can find the session after a reload.
- **Unload spill (M1).** The IndexedDB spec aborts unfinished transactions when a document unloads, so a flush started in `pagehide` is not reliable. On `pagehide`, `visibilitychange→hidden` and `freeze`, the session also writes every unsaved chunk (in flight, pending and freshly cut) to `sessionStorage`, which is synchronous and survives a reload in the same tab. On resume, the chunks that the record's sequence numbers show were never committed are merged. The spill is removed once IndexedDB confirms a write. A crash (as opposed to an orderly unload) can still lose up to one flush interval.
- **Single writer (M1).** Each page holds a random writer token, and the store checks it inside the write transaction. Resuming takes the session over, and an older page still holding it (for example one restored from the back/forward cache in a multi-page study) gets `SupersededError` on its next write. That page stops recording and moves to `superseded`.

**Sinks** get the final bundle (`onEnd`) and withdrawal (`onWithdraw`). Chunk delivery during the session (`onChunk`) is deferred to M3 with `httpSink`, where its retry semantics get designed together.

- A bundle's files are read lazily from the store, so a sink must read them inside `onEnd`. Afterwards they throw rather than silently returning nothing.
- Local data is deleted only once every sink has succeeded (or never, with `keepLocalData`). If a sink fails, `end()` reports it and `session.exportBundle()` still works.

- `downloadSink()` builds the zip at the end by **streaming** chunks out of IndexedDB through `fflate`, so memory stays bounded.
- `httpSink()` uploads chunks during the session (crash-tolerant, idempotent chunk IDs, retry with backoff) and uploads the manifest at the end.

**Sensor** is a plain object implementing the interface in [§3.6](#36-extension-point-for-sensor-authors-and-future-gaze-module). Sensors declare their streams up front, because consent text and the manifest both depend on them, and they receive a `SensorContext` with `clock`, `emit`, `reportQuality`, and an `AbortSignal`.

---

## 3. Public API sketch

These are the targets. M1–M4 implement them, and the README quickstart is kept identical to whatever actually works.

### 3.1 Vanilla TypeScript / JavaScript

```ts
import { createSession, downloadSink } from '@mmstudykit/core';
import { page } from '@mmstudykit/sensors/page';
import { pointer } from '@mmstudykit/sensors/pointer';
import { keyboard } from '@mmstudykit/sensors/keyboard';
import { face } from '@mmstudykit/face';

const session = await createSession({
  studyId: 'reading-pilot-2026',
  participantId: new URLSearchParams(location.search).get('pid')!, // researcher-provided pseudonym
  sensors: [
    page(),
    pointer(), // + AOI enter/leave for elements with data-mmsk-aoi="…"
    keyboard(), // timing + coarse key category only
    face({ features: ['blendshapes', 'headPose'], fps: 15, assets: '/mediapipe/' }),
  ],
  sinks: [downloadSink()],
});

// 1. Consent. The toolkit describes exactly what *this* config records…
const disclosure = session.describe(); // per sensor: what, how often, what is never recorded
// …you show it inside your ethics-approved consent form, then record the decision:
await session.consent({
  textVersion: 'ethics-2026-017-v3',
  text: consentFormHtml, // hashed (SHA-256) into the manifest, not stored in full by default
  granted: ['page', 'pointer', 'keyboard', 'face'],
});

// 2. Run. Only consented sensors start; the camera permission prompt happens here.
await session.start();

await session.markOnNextFrame('stimulus_onset', { itemId: 3 }); // after you render the stimulus
session.mark('response', { itemId: 3, choice: 'B' });

session.pause(); // participant-initiated; gap is explicit in the data
session.resume();

// 3. Finish (flush, build manifest, hand the bundle to sinks) …
await session.end();
// … or withdraw (stop, delete local data, tell sinks to delete).
await session.withdraw();

// Live status for UIs
session.on('quality', (q) => console.log(q.face?.effectiveFps, q.face?.facePresentRatio));
```

### 3.2 React

```tsx
<StudySessionProvider session={session}>
  <ConsentGate textVersion="ethics-2026-017-v3" declined={<ThanksAnyway />}>
    <CameraCheck minFacePresentRatio={0.9} onPass={() => setStep('task')} />
    <SensorStatus /> {/* live fps / face present / brightness / paused */}
    <PauseControls /> {/* pause, resume, withdraw with confirmation */}
    <ReadingTask />
  </ConsentGate>
</StudySessionProvider>;

function ReadingTask() {
  const { markOnNextFrame } = useStudySession();
  useEffect(() => void markOnNextFrame('passage_shown', { passage: 1 }), []);
  /* … */
}
```

### 3.3 jsPsych 8

```js
const session = await mmsk.createSession({ studyId, participantId, sensors: [...], sinks: [...] });
const jsPsych = initJsPsych({
  extensions: [{ type: jsPsychMmsk, params: { session } }],
  on_finish: () => session.end(),
});
const trial = {
  type: jsPsychHtmlKeyboardResponse,
  stimulus: '<p>…</p>',
  extensions: [{ type: jsPsychMmsk }], // marks trial_start / stimulus_onset / trial_end
};
// Adds mmsk_session_id, mmsk_t_start, mmsk_t_onset, mmsk_t_end to each trial's jsPsych data,
// so jsPsych data joins to the streams on the session clock.
```

_Verified_ against `jspsych@8.4.0` types: an extension is a class with `static info: JsPsychExtensionInfo` (`name`, `version`, `data`, `citations`) and the methods `initialize(params)`, `on_start(params)`, `on_load(params)` and `on_finish(params)`. Whatever `on_finish` returns is merged into the trial's data.

### 3.4 Python

```python
from mmstudykit import load_session
s = load_session("session_abc123/")            # or "session_abc123.zip"
s.manifest["session"]["participantId"]
s.streams["face.headpose"]                     # DataFrame, column t = session ms
s.markers                                      # DataFrame from task.markers.jsonl
s.align(["face.blendshapes", "pointer.move"], rate_hz=30, method="nearest", max_gap_ms=100)
s.epochs(marker="stimulus_onset", window=(-500, 3000), streams=["face.headpose"])
```

### 3.5 Consent disclosure (generated, not hand-written)

`session.describe()` returns structured data plus default English text, generated from the actual configuration:

> **Webcam (face features), 15 times per second.** Your camera image is analysed on your device. Video is never saved or sent. We record head orientation and 52 facial-movement scores. We do **not** record your face image or a full face mesh.
> **Keyboard timing.** We record when keys are pressed and released and the type of key (letter, digit, space, …). We do **not** record which keys or what you type. Password fields are never recorded.

Researchers can override or translate the text. The manifest records the version and hash of what was shown.

### 3.6 Extension point for sensor authors (and future gaze module)

```ts
export interface Sensor {
  readonly id: string; // 'face'
  readonly package: string; // for manifest.toolkit.packages
  readonly version: string;
  readonly options?: readonly SensorOptionRequest[]; // privacy opt-ins, granted via consent
  config(): Record<string, unknown>; // resolved config → manifest
  streams(granted: ReadonlySet<string>): readonly StreamSpec[]; // depends on granted opt-ins
  describe(): SensorDisclosureBase; // feeds consent text
  privacy?(granted: ReadonlySet<string>): SensorPrivacyFlags; // → manifest.privacy
  start(ctx: SensorContext): Promise<void> | void;
  stop(): Promise<void> | void; // may still emit final rows
  pause?(): void; // called while emits are still open, so pending state can be flushed
  resume?(): void;
  summary?(): Record<string, unknown>; // → manifest.quality[id]
}
```

_As built in M1:_ `streams` became a function of the granted opt-ins, because a declined opt-in (key identity) changes the columns. Core prepends the `t` column, and sensors don't declare it.

Inside `face`, the built-in features (blendshapes, head pose, iris, landmarks) are themselves `FaceFeatureExtractor`s: `(result, frame) => rows` plus `StreamSpec`s. A future `@mmstudykit/gaze` would add one extractor (iris + head-pose features), a calibration routine that emits markers, and its own streams, with no changes to `face`. Built-in features use the same interface, so it gets exercised from day one.

---

## 4. Timing model

| Source                    | Timestamp                                                                                                                                                 | What limits accuracy                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pointer / keyboard / page | `event.timeStamp` (same timebase as `performance.now()`), not the time the handler runs                                                                   | Timer resolution (Chrome 0.1 ms, 5 µs if cross-origin isolated; Firefox/Safari ~1 ms, to be measured); OS/USB input latency (not measurable in-browser) |
| Face                      | `requestVideoFrameCallback` metadata: `captureTime` if present → `presentationTime` → callback `now`; fallback rAF + `video.currentTime` change detection | Frame period (33 ms at 30 fps) dominates; camera exposure/transport latency needs external validation                                                   |
| Face processing           | Second column `t_processed` (inference finished)                                                                                                          | Shows pipeline latency per frame                                                                                                                        |
| Markers                   | `mark`: `performance.now()` at call. `markOnNextFrame`: rAF timestamp                                                                                     | True display onset is +0–1 frame after rAF; validated only with a photodiode                                                                            |
| Worker-produced values    | Timestamps are decided on the main thread at frame grab. Workers have their own `timeOrigin`, so worker time is never mixed in unconverted                | n/a                                                                                                                                                     |

_Verified:_

- `requestVideoFrameCallback` is in Chrome 83+, Safari 15.4+ and Firefox 132+.
- `captureTime` is optional (aimed at WebRTC, sometimes missing for the first frames), so the timing source is recorded per stream.
- Timer resolution: Chrome is 100 µs, or 5 µs when cross-origin isolated. Firefox and Safari report around 1 ms. M5 measures and records the real numbers.

**Known gaps, documented and recorded rather than hidden:**

- In background tabs, rAF and rVFC stop and timers are throttled. Face data has gaps while the tab is hidden, and `page.visibility` explains them.
- Sleep and suspend show up as clock discontinuities.
- A reload starts a new clock segment.

**Benchmarks (M5)** report, per browser:

- Inter-sample interval distributions per stream.
- `mark()` overhead.
- Synthetic-event dispatch time vs. recorded `t`.
- rAF-marker vs. rVFC alignment.
- Main-thread cost (Long Animation Frames API where available).

They come with an optional external-validation protocol (photodiode / camera-loopback) for labs that need end-to-end numbers. The test machine is documented. Bridges et al. (2020, _PeerJ_) is cited for context on browser timing.

---

## 5. Privacy model

| Guarantee                                 | How it's enforced                                                                                                                                                                                                                                                                                                            | How it's tested                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw video never persisted or transmitted  | Frames exist only as a `<video>` element and transient `ImageBitmap`/`VideoFrame` objects, closed right after inference. Only extractor outputs (numbers) leave the worker. The recorder's sample guard rejects binary and image types                                                                                       | Playwright run (M2 harness, M3 full demo): every request body and IndexedDB, localStorage, sessionStorage, Cache Storage and OPFS entry is scanned for image signatures (JPEG/PNG/WebP/GIF magic, `data:image`), binary payloads above a size threshold, and unexpected origins |
| No third-party network contact by default | Self-hosted MediaPipe assets; worker `fetch` allowlist (asset URLs only); CSP `connect-src` in demo/docs                                                                                                                                                                                                                     | Same test: the request log must contain only same-origin assets and configured sink URLs                                                                                                                                                                                        |
| Only consented sensors run                | `SensorHost` won't call `start()` without a recorded `granted` decision; enforced in core                                                                                                                                                                                                                                    | Unit tests                                                                                                                                                                                                                                                                      |
| No key content by default                 | Keyboard sensor stores only `category`; `key`/`code` are used in memory for pairing and never stored; password inputs ignored                                                                                                                                                                                                | Unit tests + e2e typing a known string and asserting it can't be reconstructed from the export                                                                                                                                                                                  |
| Opt-ins are visible                       | Key identity, full landmarks, etc. are flags in config → in the consent disclosure → in `manifest.privacy`                                                                                                                                                                                                                   | Unit tests on disclosure + manifest                                                                                                                                                                                                                                             |
| Data minimization                         | Coarse environment: browser family + major version, OS family, device class, viewport + DPR (needed to interpret pointer coordinates), delivered camera resolution/fps. **No** device labels or IDs (camera labels can contain personal names, e.g. phone cameras), no canvas/audio fingerprinting, no timezone, no language | Manifest snapshot test                                                                                                                                                                                                                                                          |
| Participant control                       | `pause()`, `resume()`, `withdraw()` available to UI components; withdrawal propagates to sinks                                                                                                                                                                                                                               | Unit + e2e                                                                                                                                                                                                                                                                      |

Exported data is **pseudonymous personal data**, not anonymous. The docs say so and point to institutional DPO and ethics processes.

---

## 6. Export format

### 6.1 Bundle

```
session_<sessionId>/            (or session_<sessionId>.zip)
  manifest.json
  streams/
    page.events.jsonl           visibility, focus/blur, resize, fullscreen, lifecycle
    page.scroll.csv
    pointer.move.csv
    pointer.button.csv          down/up/cancel with innermost AOI (flat, so CSV; was .jsonl in the draft)
    pointer.aoi.jsonl           enter/leave of researcher-tagged elements, rect (document coords) on change, removed
    keyboard.events.csv         t, type (down/up), category, repeat
    keyboard.keystrokes.csv     t (= down), t_up, dwell_ms, category, repeats   (flight derived downstream)
    face.blendshapes.csv
    face.headpose.csv
    face.iris.csv
    face.landmarks.csv          (opt-in)
    face.quality.csv            1 Hz: effective fps, dropped frames, face-present ratio, brightness, inference ms
    session.events.jsonl        start/pause/resume/segment/discontinuity/sensor errors
    task.markers.jsonl
```

### 6.2 Conventions

**CSV**

- RFC 4180, UTF-8 without BOM, LF line endings, header row.
- The first column is always `t` (session ms, 3 decimals). Columns are snake_case.
- An empty field means missing. Booleans are `0`/`1`. Enums are strings.
- Precision is fixed per column and declared in the manifest.

**JSONL** has one object per line: `{"t": …, "type"|"name": …, "data": {…}}`.

**Manifest** keys are camelCase (JSON/JS convention). Column and stream names are snake_case (data-frame friendly).

### 6.3 Manifest and schema versioning

The manifest is described by `spec/manifest.schema.json` (JSON Schema 2020-12), with `schemaVersion` as semver:

- Readers accept any manifest with the same major version and ignore unknown fields.
- While the version is 0.x, minor bumps may break, and the changelog says so.
- Writers are tested strictly: the schema sets `additionalProperties: false` and provides an `extensions` object for third-party data.
- The shared fixtures in `spec/fixtures/` are validated by the TypeScript tests (ajv), loaded by the Python tests, and (from M1) generated by the real exporter in a round-trip test.

### 6.4 Data volume estimates (30-minute session)

| Stream                                         | Values / frame | Rate                                    | Approx. CSV size      |
| ---------------------------------------------- | -------------- | --------------------------------------- | --------------------- |
| `face.blendshapes` (52)                        | 52             | 30 fps                                  | ~18 MB (~4 MB zipped) |
| `face.headpose` (yaw, pitch, roll, tx, ty, tz) | 6              | 30 fps                                  | ~2.5 MB               |
| `face.landmarks` iris subset (10 × xyz)        | 30             | 30 fps                                  | ~11 MB                |
| `face.landmarks` full (478 × xyz)              | 1,434          | 30 fps                                  | **~540 MB**           |
| `pointer.move`                                 | 7              | ~30 Hz avg (bursty, up to display rate) | ~2–5 MB               |

All but full landmarks fit easily. Full landmarks need opt-in, streaming export, and probably a lower rate or precision. If labs actually need full meshes, a binary sidecar (`.f32` plus a descriptor, or Parquet) is a later option.

### 6.5 Upload protocol (M3)

`spec/upload-protocol.md` defines:

- `PUT /sessions/{id}/chunks/{stream}/{seq}`, idempotent.
- `PUT /sessions/{id}/manifest`.
- `DELETE /sessions/{id}`, for withdrawal.
- Auth is a bearer token or a signed per-session upload token issued by the researcher's backend.

Any server can implement it. `apps/receiver` is the reference. Possible later sinks: JATOS (`jatos.uploadResultFile`), Pavlovia.

### 6.6 XDF / Lab Streaming Layer (stretch)

Streams already carry what XDF stream headers need: name, type, channel labels and units, nominal rate, and per-sample timestamps on one clock. Clock offsets map to XDF `ClockOffset` chunks. A Python-side `s.to_xdf()` is probably easier than doing this in the browser. Not in v0.1.

---

## 7. Face sensor plan

**API facts (_verified_ from `@mediapipe/tasks-vision@1.2.3` `vision.d.ts`):**

- `FilesetResolver.forVisionTasks(basePath?, useModule?)` takes a `useModule` flag (ESM WASM loader, `vision_wasm_module_internal.js`).
- `FaceLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath | modelAssetBuffer, delegate: 'CPU' | 'GPU' }, runningMode: 'VIDEO', numFaces, minFaceDetectionConfidence, minFacePresenceConfidence, minTrackingConfidence, outputFaceBlendshapes, outputFacialTransformationMatrixes, canvas })`.
- `detectForVideo(frame: TexImageSource, timestampMs, imageProcessingOptions?)`. `TexImageSource` includes `ImageBitmap`, `VideoFrame` and `OffscreenCanvas`.
- The result has `faceLandmarks: NormalizedLandmark[][]`, `faceBlendshapes: Classifications[]` and `facialTransformationMatrixes: Matrix[]` (`{rows, columns, data}`).
- The blendshape doc says `*Left`/`*Right` refer to the **subject's** face and that **mirrored input inverts them**. So the input is never mirrored; only the camera preview is mirrored, via CSS.
- The bundle only uses `OffscreenCanvas` on Safari ≥ 17.

**Pipeline:** `getUserMedia` (640×480 at 30 fps requested; delivered settings are recorded) → `<video>` → rVFC loop with an FPS limiter → `createImageBitmap(video)` or `new VideoFrame(video)` → transfer to the Worker → `detectForVideo` → extractors → rows → main thread → `emit`.

- Brightness: mean luma of a 32×24 downscale computed in the worker. Only the scalar leaves.
- Quality metrics:
  - effective fps
  - frames skipped by the limiter (by design) vs. frames dropped because inference was busy
  - face-present ratio and brightness
  - inference ms p50/p95
  - timing source and delegate
- These stream at 1 Hz to `face.quality` and are summarized in the manifest.

**Worker spike (first task of M2, ~1 day).** The current bundle tries `importScripts`, catches the `TypeError` thrown in module workers, and falls back to `self.import` or dynamic `import()`. That suggests the 2023 "module workers unsupported" problem is fixed, but it needs empirical confirmation. The spike covers {Chrome, Edge, Firefox, Safari} × {main thread, module worker, classic worker} × {GPU, CPU} × {ImageBitmap, VideoFrame}, recording init success, fps and main-thread long tasks. Results go in `docs/face-worker.md`. The chosen default and fallback order get written down, and the runtime picks automatically and records its choice in the manifest.

**Head pose.** Yaw, pitch and roll come from the 4×4 facial transformation matrix. Element order (row- vs. column-major) and angle conventions will be confirmed empirically against known poses in the test video, not assumed. The convention is documented, and translation (cm, canonical face space) is included.

**Assets.**

- Option `assets: string | { wasmBase, modelUrl }`.
- A small `mmstudykit-face copy-assets <dir>` CLI copies the WASM from `node_modules`.
- We could vendor the ~3.6 MB `face_landmarker.task` model (Apache-2.0) into the package so self-hosting needs no download from Google. Decided in M2 after checking the model license text.

**Metrics endpoint.** See [§0.1](#0-where-this-plan-departs-from-the-brief) and [Q3](#12-open-questions).

### 7.1 As built (M2)

User-facing details are in [docs/face.md](docs/face.md); the measurements are in [docs/face-worker.md](docs/face-worker.md).

- **Engine location.** A classic worker with the standard wasm loader is the default. The spike showed module workers need the `_module_` wasm (otherwise `ModuleFactory not set`), and main thread, classic and module (with the `_module_` wasm) all run in Chromium, Firefox and WebKit. The main thread is the fallback. The CPU delegate is the default: GPU loses headless everywhere, and real-GPU numbers are pending (`spike --headed`).
- **MediaPipe never enters the app bundle.** The engine (MediaPipe + extractors + egress guard) is pre-bundled with esbuild into `mmsk-face-worker.js` (IIFE) and `mmsk-face-engine.js` (ESM). Both are served from the self-hosted assets folder and loaded only at `start()`, i.e. after consent. The sensor code in the app is small and needs no bundler configuration.
- **Assets.** `mmstudykit-face copy-assets <dir>` writes the bundles, the matching wasm from the installed `@mediapipe/tasks-vision` (and refuses a version mismatch), and the model, checked against its pinned SHA-256. It also writes an integrity manifest. The engine verifies the model's SHA-256 again in the browser when WebCrypto is available. **The model isn't vendored**: no licence statement could be extracted from the model cards (`.task` contains none), so it's downloaded on the researcher's machine or CI instead. Participants never contact Google either way. Revisit if the Apache-2.0 status is confirmed.
- **Egress.** In the worker, `fetch` only reaches the model and wasm URLs, `importScripts` only the loader, and `XMLHttpRequest`/`WebSocket`/`EventSource` are disabled. On the main-thread fallback, only `odml.pa.googleapis.com` is denied. Blocked attempts are counted in the manifest.
- **Streams.** A new `face.frames` stream has one row per processed frame, with or without a face: `t_processed`, `face`, `inference_ms`, `brightness` and the timing source. "No face" and "not processed" are therefore distinguishable, and the feature streams only have rows for frames with a face.
- **Iris features** are computed in pixel space and are rotation-invariant: position along the eye-corner axis, offset from it, and lid openness. The thesis prototype computed them in normalized coordinates, which are anisotropic for 4:3 frames.
- **Head pose:** R = R_y·R_x·R_z. The matrix storage order is detected from the data (the translation's position), because the `Matrix` type only says "flattened". The **sign convention is not yet verified**: that needs the recorded clip.
- **Lessons from the thesis prototype.** It was read only; nothing was copied.
  - One serial engine queue, because the wasm aborts on concurrent init or on `close()` during a detect.
  - 2D-canvas normalization of frames, because Continuity Camera frames crashed the importer.
  - Strictly increasing timestamps.
  - Rebuild once with the other delegate after an abort.
  - TFLite `INFO:` and glog lines are filtered in the worker scope only; the host page's console is never patched.
- **Camera.** Only the delivered width, height and frame rate are recorded. `getSettings()` also returns `deviceId`/`groupId`, which are dropped. The camera is released on `pause()` and reopened on `resume()`.

---

## 8. Browser support (expected; confirmed in M2 / M5)

| Feature                          | Chrome / Edge          | Firefox            | Safari             | Degradation                                    |
| -------------------------------- | ---------------------- | ------------------ | ------------------ | ---------------------------------------------- |
| rVFC                             | 83+                    | 132+               | 15.4+              | rAF + `currentTime` polling; recorded          |
| rVFC `captureTime`               | yes (camera)           | partial            | to verify          | `presentationTime`; recorded                   |
| `getCoalescedEvents`             | yes                    | yes                | 18.2+              | plain `pointermove` only; recorded             |
| MediaPipe in worker (GPU)        | expected               | to verify          | to verify (≥ 17)   | worker CPU → main thread throttled             |
| Timer resolution                 | 0.1 ms (5 µs isolated) | ~1 ms (to measure) | ~1 ms (to measure) | documented per browser                         |
| IndexedDB in private mode        | yes                    | yes (in-memory)    | yes                | memory store; recorded                         |
| Page Lifecycle `freeze`/`resume` | yes                    | no                 | no                 | wall-clock discontinuity detection still works |

Target baseline: the last two major versions of Chrome, Edge and Firefox, plus Safari ≥ 17 on macOS and iPadOS. Face on phones is best-effort in v0.1. → [Q7](#12-open-questions)

---

## 9. Testing strategy

| Layer          | Tool                                                                  | Scope                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure unit      | Vitest (Node)                                                         | clock math, encoders, manifest builder, schema validation, consent rules, key categories                                                                                               |
| Browser unit   | Vitest browser mode + Playwright provider (Chromium, Firefox, WebKit) | IndexedDB recorder and resume, real Pointer/Keyboard/Visibility events, zip streaming                                                                                                  |
| E2E            | Playwright Test                                                       | Face pipeline with Chrome `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<mjpeg>`; demo flow; privacy guarantee; Firefox/WebKit flows without the face pipeline |
| Cross-language | CI job                                                                | Export a bundle (browser) → `pytest` loads it                                                                                                                                          |
| Python         | pytest (+ pyright/mypy strict from M1)                                | loader, align, epochs                                                                                                                                                                  |
| Timing / perf  | Playwright-driven benchmark scripts (M5)                              | → `docs/benchmarks.md`                                                                                                                                                                 |

CI notes:

- GitHub runners have no GPU, so the face e2e uses the CPU delegate at a low fps and asserts structure and plausibility (face detected in ≥ X % of frames, head pose within a range), not performance.
- Performance numbers come from a documented local machine.

---

## 10. Tooling and dependencies

All versions were checked on npm and PyPI on 2026-11-15. Each runtime dependency is justified here, and any new one also goes in its commit message.

| Tool / dep                                 | Version                  | Why                                                                                                                                                    |
| ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node                                       | 24 LTS                   | Vitest 5 needs ^22.12 or ^24; ESLint 10 needs ≥ 20.19                                                                                                  |
| pnpm (workspaces, catalogs)                | 12.21.0                  | Workspace linking; `catalog:` keeps dev-tool versions in one place                                                                                     |
| Turborepo                                  | 2.11                     | Task graph + caching (brief). At five packages, `pnpm -r` would also do; Turbo earns its keep in CI caching                                            |
| TypeScript                                 | **6.0.3**                | Not 7.0: typescript-eslint peer range is `<6.1.0` (§0.12)                                                                                              |
| ESLint + typescript-eslint + @eslint/js    | 10.15 / 8.72 / 10.0      | Type-aware linting (flat config)                                                                                                                       |
| eslint-config-prettier, Prettier           | 10.1 / 3.10              | Formatting owned by Prettier                                                                                                                           |
| Vitest + Vite                              | 5.1 / 8.3                | Unit tests; Vite is a required peer of Vitest 5                                                                                                        |
| ajv (dev)                                  | 8.20                     | Validate fixtures/manifests against the JSON Schema in tests                                                                                           |
| fflate (core, M1)                          | 0.8.3                    | Streaming zip; small, MIT, tree-shakable. Entry mtime pinned (see §13)                                                                                 |
| @mediapipe/tasks-vision (face, M2)         | **1.2.3 exact**          | FaceLandmarker (Apache-2.0). Exact pin: the metrics audit (Q3) applies to this build; re-audit on any bump                                             |
| esbuild (face, dev, M2)                    | 0.28.2                   | Bundles the engine into self-hostable worker/ESM assets and the CLI (MIT). pnpm keeps its install script blocked; the platform binary works without it |
| IndexedDB wrapper                          | none                     | ~100-line internal wrapper; we need few operations. (`idb` is the fallback if this grows)                                                              |
| Playwright + @vitest/browser-playwright    | 1.65.1 / 5.1.0           | Vitest browser mode on Chromium/Firefox/WebKit with trusted input (M1); example e2e (M1); fake camera (M2)                                             |
| Next.js / React (demo, peers)              | 16.4 / 19.3              | Demo app (brief); static export so it can be hosted like a real study                                                                                  |
| Express (receiver, M3)                     | 5.x                      | Familiar, readable reference server                                                                                                                    |
| uPlot (demo researcher view, M4)           | tbd                      | Fast canvas time-series plots for ~10⁵–10⁶ points; MIT, ~50 kB. Final pick in M4                                                                       |
| Changesets (M5)                            | 3.0                      | Versioning/changelogs (brief)                                                                                                                          |
| Python: numpy, pandas / hatchling / pytest | ≥1.26, ≥2.2 / 1.33 / 9.x | Loader; `requires-python >= 3.11` (3.10 reached end-of-life in Oct 2026)                                                                               |
| Python dev: mypy, pandas-stubs             | 2.4 / 3.1                | `mypy --strict` over the loader and tests (§9)                                                                                                         |
| Library build                              | `tsc`                    | Enough for ESM + `.d.ts` now. Re-evaluate in M2 (worker bundling) and M4 (IIFE): `tsdown`/`tsup` or esbuild                                            |

No GPL or AGPL dependencies (WebGazer is GPL and is not used). M5 adds a CI licence check.

**Tooling telemetry.** Turborepo and Next.js both collect anonymous usage telemetry by default. CI sets `TURBO_TELEMETRY_DISABLED=1` and `NEXT_TELEMETRY_DISABLED=1`, and the README tells contributors how to opt out locally. This doesn't affect participants, but a privacy-first project shouldn't phone home from its own tooling either.

---

## 11. Milestones (refined)

Every milestone ends with: `pnpm check` green (lint, format, typecheck, build, unit tests), Python tests green, README quickstart still true, a commit with a clear message, and a summary. Then I wait.

### M0 — Scaffold and plan (this milestone)

- pnpm workspace, Turborepo, TS 6.0 strict, ESLint (type-aware), Prettier, Vitest.
- `@mmstudykit/core` skeleton exporting the manifest types and `SCHEMA_VERSION`.
- `spec/manifest.schema.json` v0.1.0 and two fixture bundles (`minimal`, `withdrawn`). TS tests validate them with ajv, run negative cases (privacy flags, the withdrawal rule, column rules), and validate an example built through the TS types. Python tests read the same fixtures.
- `python/mmstudykit` skeleton with pytest.
- GitHub Actions CI: lint, format, typecheck, build, unit, python.
- This PLAN and a draft README.

### M1 — Core and simple sensors

- Clock with segments, anchors and discontinuity detection (fake-timer unit tests).
- Session state machine. Consent model and **enforcement** in core. `describe()` disclosure generator.
- Stream registry and the sample guard.
- Markers: `mark`, `markOnNextFrame`.
- Recorder: memory → IndexedDB chunks, memory fallback, resume after reload via a `sessionStorage` pointer.
- Export: CSV/JSONL encoders, manifest builder, streaming zip `downloadSink`.
- Sensors:
  - `pointer`: coalesced events where available, buttons, AOI enter/leave plus AOI rects.
  - `keyboard`: category default, password exclusion, element scoping, in-browser pairing, opt-in key identity.
  - `page`: visibility, focus, viewport, scroll, fullscreen, lifecycle.
- Minimal Python `load_session` (manifest + streams → DataFrames) and the TS→Python round-trip test.
- Vitest browser mode on Chromium, Firefox and WebKit.

**Done when:** a vanilla HTML example records pointer, keyboard and page data, survives a reload, and exports a zip that validates against the schema and loads in Python.

**Status: done (2026-11-15).** The "done when" criterion is an automated test: `examples/vanilla/test/e2e.test.ts` drives the example in Chromium through consent, reading, clicking, typing (including a password field), a reload and finish. It validates the downloaded zip, checks that both clock segments and all 16 keystrokes are present and that no typed text is, and `pnpm roundtrip` then loads the zip in Python.

Tests: core has 138 (Node, plus browser mode on Chromium, Firefox and WebKit), sensors 60, the example e2e 1, Python 22 plus 3 round-trip tests, with mypy strict clean.

Changes from the plan, found while building:

- **Unload spill and single-writer token** (§2.3). The e2e test showed that keystrokes typed in the ~2 s before a reload were lost, because unload aborts pending IndexedDB transactions. A simulated reload in a browser test also showed that a stale page can overwrite the resumed session's record.
- **Sensors can flush on pause and stop.** Core now calls `pause()`/`stop()` while emits are still open, so keys still held aren't dropped.
- **Privacy details.** Zip entry timestamps are pinned to 1980-01-01, because real ones are local time and would leak the timezone. The keyboard sensor doesn't count keys skipped in password fields, because that would leak password length. Fields with `autocomplete` values `one-time-code` and `cc-*` are excluded like password fields, and so is `[data-mmsk-ignore]`.
- **Format details.** In CSV, an empty string is written as missing, because pandas and R can't tell the two apart. Rows are sorted by `t` on export: keystrokes complete at key-up, so they're written out of order. `pointer.button` is CSV. The manifest's `HeadlessChrome` browser name is kept, because it's a useful bot signal.
- **A store passed in by the caller is never closed by the session**, and bundles refuse to be read after local data was deleted.

Known limitations, carried forward:

- Data left in IndexedDB when an `end()` sink fails, or when a different participant ID takes over a tab, is kept but has no recovery or cleanup API yet. That's planned for M3, alongside `httpSink`.
- AOI geometry is re-measured on resize, DOM mutations, element scroll and AOI or body size changes. A purely positional shift with none of those (rare) is missed until the next trigger.
- If `consent()` fails to persist (for example, storage is full), it rejects and the app has to retry.
- The vanilla e2e runs on Chromium only. Firefox and WebKit are covered by the browser-mode tests, and full-flow e2e on them comes with M2/M3.

### M2 — Face sensor

- Worker spike and decision (`docs/face-worker.md`).
- Metrics-endpoint handling per Q3, worker egress allowlist, and a self-hosted asset story.
- Extractors: blendshapes, head pose (convention verified), iris features, face-present, opt-in landmarks (subset, precision, rate).
- rVFC timing with fallback, with the timing source recorded.
- Quality metrics stream and summary.
- Fake-camera MJPEG fixture. Playwright e2e on Chromium. **Privacy test on a harness page.** First main-thread overhead numbers.

**Done when:** CI runs the face pipeline on a checked-in clip and proves no image data and no unexpected origins.

**Status (2026-11-15): everything except the clip-dependent parts.** Done:

- worker spike and decision ([docs/face-worker.md](docs/face-worker.md))
- egress guards
- `copy-assets` with integrity checks
- extractors (math unit-tested, including both matrix layouts and anisotropic frames)
- rVFC timing with fallback
- `face.frames` and `face.quality`
- landmarks opt-in, and the camera released on pause
- the privacy e2e: real camera path (Chrome fake device, Firefox fake streams), strict CSP, network and storage scans, decompressed-bundle scan, negative controls
- the MJPEG fixture converter, which uses installed Chrome, so no ffmpeg is needed

Tests: face 51 (33 Node, 15 browser across 3 engines, 3 e2e).

**Waiting for the clip:**

- convert it with `node packages/face/scripts/make-face-fixture.mjs <video>` and check it in
- the e2e then asserts face detection automatically (face-present ratio, blendshape rows)
- verify the head-pose sign convention against the recorded turns and document it in docs/face.md
- spike numbers with a face present

Main-thread overhead numbers move to M5 benchmarks.

### M3 — Consent UI, React and demo

- Consent UI pieces and the consent record (text hash, version, per-sensor decisions, opt-ins).
- Pause and withdraw UX, with withdrawal propagated to sinks.
- `@mmstudykit/react`: provider, hooks, `ConsentGate`, `CameraCheck`, `SensorStatus`, `PauseControls`.
- Next.js demo, statically exported: consent → camera check (live quality) → reading task → quiz (markers) → end/download.
- `httpSink`, `spec/upload-protocol.md`, and the Express receiver, including withdrawal deletion.
- Privacy test extended to the full demo.

### M4 — Ecosystem

- `@mmstudykit/jspsych`: extension, consent trial, IIFE build, and an example plain-HTML experiment.
- Python `align` (nearest/linear/previous, `max_gap_ms`) and `epochs` (long format with marker data), typed and tested.
- Demo **researcher view**: drop a bundle (zip or folder), parsed locally in the browser, streams on a shared timeline with markers and quality bands.

### M5 — Release readiness

- Docs site (VitePress or Starlight, chosen then) and TypeDoc API reference.
- Timing and performance benchmarks → `docs/benchmarks.md`, with the machine documented.
- Community files: `CITATION.cff`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (including how to report privacy issues), issue templates.
- Changesets. npm publishing with provenance and PyPI trusted publishing via GitHub OIDC. Licence check in CI.
- Demo GIF and the v0.1.0 release checklist.

---

## 12. Open questions

Decided 2026-11-15:

1. **Name and scope: keep `@mmstudykit/*` (npm) and `mmstudykit` (PyPI).** Checked on 2026-11-15: `registry.npmjs.org/-/org/mmstudykit/user` returns `Scope not found` (the same endpoint returns 200 for existing user and org scopes), there are no packages under the scope, and `pypi.org/pypi/mmstudykit/json` returns 404. _Action for the maintainer:_ create the free npm org `mmstudykit` so the scope can't be taken before the first publish. PyPI can't reserve a name without an upload, so that waits for M5.
2. **License: Apache-2.0.** No longer provisional. _Action for the maintainer:_ check the university's IP policy before the repo goes public.
3. **MediaPipe metrics: block them** (decided 2026-11-15). Use 1.2.x. Re-checked on 2026-11-15: 1.2.3 (latest) and the 1.2.4 nightly both still create the metrics logger unconditionally for every task. `enableLogging` appears in `vision.d.ts` but doesn't exist in the bundle at runtime. The logger sends with the global `fetch` and disables itself after the first failed send. The face worker's `fetch` only allows the configured asset URLs. The main-thread fallback denies only the metrics endpoint, so the host app's own `fetch` is untouched. The docs give a CSP `connect-src`, and the privacy e2e asserts that no request goes to an unexpected origin.
4. **Package consolidation: accepted.** One `@mmstudykit/sensors` package with subpath exports. The consent model and its enforcement live in `core`; the consent UI ships with `react` and `jspsych`.
5. **Test video: the maintainer records their own clip** (decided 2026-11-15) and agrees to it being public in the repo. Until it exists, the pipeline is tested with synthetic frames and result fixtures, and the CI face e2e and head-pose convention check wait for it.
6. **First real deployment: the maintainer's own Next.js/React app.** The milestone order stays as it is: React and the demo in M3, jsPsych in M4.
7. **Mobile: desktop + iPad first** (decided 2026-11-15). The target is the last two major versions of Chrome, Edge and Firefox, plus Safari ≥ 17 on macOS and iPadOS. Phones are best-effort: documented, not tested in CI.
8. **Thesis repo: reviewed for lessons learned** (decided 2026-11-15). It was read only; nothing is copied verbatim. What carried over is noted in [§7](#7-face-sensor-plan).

---

## 13. Verification log

| Claim                                                                                                                                                            | Source (checked 2026-11-15)                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MediaPipe 1.x metrics POST to `odml.pa.googleapis.com/v1/log` every 60 s, no option to disable; stops after first failed send                                    | `@mediapipe/tasks-vision@1.2.3` `vision_bundle.mjs` + README "Privacy Notice" (last modified 2026-06-05); absent in `0.10.35`, present since `1.0.0`           |
| FaceLandmarker options, `detectForVideo`, result types, blendshape mirroring note, `useModule` loader, module-worker fallback                                    | `@mediapipe/tasks-vision@1.2.3` `vision.d.ts` and bundle                                                                                                       |
| jsPsych extension interface                                                                                                                                      | `jspsych@8.4.0` `dist/index.d.ts`                                                                                                                              |
| rVFC support (Chrome 83, Safari 15.4, Firefox 132); `captureTime` optional/WebRTC-oriented                                                                       | web.dev rVFC article; MDN; Mozilla bug 1908245                                                                                                                 |
| `performance.now()` coarsening (Chrome 100 µs / 5 µs isolated; Firefox, Safari ~1 ms)                                                                            | Chrome developer blog "Aligning timers with cross origin isolation restrictions"; MDN `Performance.now()`                                                      |
| `getCoalescedEvents` in Safari 18.2+                                                                                                                             | MDN compat data; WebKit bug 210454                                                                                                                             |
| Chrome fake capture accepts `.y4m` and `.mjpeg`                                                                                                                  | Chromium `media_switches.cc`; WebdriverIO camera service docs                                                                                                  |
| typescript-eslint peer `typescript >=4.8.4 <6.1.0`; TS 7.0 stable, 7.1 beta                                                                                      | `npm view typescript-eslint@8.72.2 peerDependencies`; npm dist-tags; TypeScript 7.0 announcement                                                               |
| Vitest 5 requires Node ^22.12/^24 and Vite (non-optional peer)                                                                                                   | `npm view vitest@5.1.0 engines peerDependencies peerDependenciesMeta`                                                                                          |
| pandas 3.1 requires Python ≥ 3.11; numpy 2.5 ≥ 3.12                                                                                                              | PyPI JSON API                                                                                                                                                  |
| Unloading a document force-closes its IndexedDB connections, aborting unfinished transactions                                                                    | IndexedDB 3.0 "close a database connection" (forced flag); reproduced by the M1 e2e test before the spill fix                                                  |
| fflate builds zip DOS timestamps from `new Date(mtime ?? Date.now())` with local-time getters                                                                    | `fflate@0.8.3` `esm/browser.js` (`getFullYear() - 1980` …)                                                                                                     |
| Vitest 5 browser mode: `browser: { enabled, provider: playwright(), instances }`, `test.projects`; `vitest/browser` `userEvent`                                  | `vitest@5.1.0` and `@vitest/browser@5.1.0` type definitions; Playwright 1.65.1 browsers (Chromium 159, Firefox 159, WebKit 27.2)                               |
| pandas reads `0`/`1` into nullable `boolean` via `Int64`; `keep_default_na=False, na_values=['']` keeps `"NA"` a string                                          | pandas 3.1.1, exercised by `python/mmstudykit/tests`                                                                                                           |
| MediaPipe 1.2.3 and 1.2.4-rc.20261114 still create the metrics logger unconditionally; `enableLogging` exists only in the .d.ts; transport is global `fetch`     | `npm pack` of both versions; `vision_bundle.mjs` (`new Nh` → `new xh`, `vh.send` uses `fetch`)                                                                 |
| Module workers need the `useModule` wasm (`ModuleFactory not set` otherwise); rVFC fires for detached `<video>`; WebKit reports `captureTime` for canvas streams | Worker spike, Playwright 1.65.1: Chromium 159, Firefox 159, WebKit 27.2 ([docs/face-worker.md](docs/face-worker.md))                                           |
| Chrome's fake capture plays concatenated-JPEG MJPEG at 30 fps at the file's resolution, with rVFC `captureTime` on every frame                                   | Probe with `--use-file-for-fake-video-capture` (Chromium 159)                                                                                                  |
| `@mediapipe/tasks-vision` ships no LICENSE file (only `"license": "Apache-2.0"`) and its `exports` hides `package.json`                                          | Package contents and `package.json` of 1.2.3                                                                                                                   |
| FaceLandmarker model float16/1: SHA-256 `64184e22…c9ff`, 3,758,596 bytes, unchanged since at least 2026-07                                                       | Download on 2026-11-15 matches the maintainer's July copy                                                                                                      |
| Vite lists public files at server start (assets created later return 404)                                                                                        | Reproduced with the face browser tests; fixed by preparing assets before Vitest starts                                                                         |
| EU AI Act Art. 5(1)(f) prohibition; Annex III; Art. 50(3); amended in 2026                                                                                       | Regulation (EU) 2024/1689; secondary sources on the 2026 Digital Omnibus. Final wording to be checked against the consolidated text before the README is final |
