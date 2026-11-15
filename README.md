# multimodal-study-kit _(working name)_

**Synchronized, privacy-preserving multimodal behavioral data collection for browser-based research studies.**

Add webcam face features, pointer movement, keystroke timing, page events and task markers to any web study in a few lines. Everything is recorded on one shared clock and exported as a documented bundle that loads into Python or R in one line.

> [!WARNING]
> **Pre-alpha, M2 of 5.** These work and are tested on Chromium, Firefox and WebKit: core, the pointer/keyboard/page sensors, the face sensor (MediaPipe, self-hosted, metrics blocked), the zip export and the Python loader. Still to come in M2: the head-pose sign check and face-detection e2e, which wait for a recorded test clip. React bindings arrive in M3. Nothing is published to npm or PyPI yet. The quickstart below is kept true to the code.

## Why

- **Privacy by design.** Video frames are analysed on the participant's device and never stored or sent. Only derived numbers are recorded, and only for sensors the participant consented to. Key content is never recorded by default. No third-party network requests unless you configure them.
- **One clock for everything.** Every sample and marker is timestamped on a single monotonic session clock. Timing accuracy is documented and measured, not just asserted.
- **Clean, self-describing exports.** CSV/JSONL streams plus a versioned `manifest.json` (JSON Schema in [`spec/`](spec/)) with the consent record, clock anchors, sensor configs and per-stream statistics.
- **Features, not inferences.** The toolkit outputs behavioral features (head pose, blendshape scores, pointer trajectories, keystroke timing). It does **not** infer emotions, engagement or cognitive states. That is a deliberate design and ethics decision ([see below](#ethics-privacy-and-the-law)).

## Quickstart

```ts
import { createSession, downloadSink } from '@mmstudykit/core';
import { face } from '@mmstudykit/face';
import { keyboard } from '@mmstudykit/sensors/keyboard';
import { page } from '@mmstudykit/sensors/page';
import { pointer } from '@mmstudykit/sensors/pointer';

const session = await createSession({
  studyId: 'reading-pilot',
  participantId: 'P017', // pseudonymous, provided by you, never collected automatically
  sensors: [
    page(),
    pointer(), // + enter/leave of elements you tag with data-mmsk-aoi="…"
    keyboard(), // timing + key category only
    face({ fps: 15 }), // features only; video never leaves the device
  ],
  sinks: [downloadSink()],
});

// Show session.describe() in your consent form, then record the participant's choices.
// Sensors that aren't granted never start.
await session.consent({
  textVersion: 'ethics-v3',
  granted: ['page', 'pointer', 'keyboard', 'face'],
});
await session.start();

await session.markOnNextFrame('stimulus_onset', { itemId: 3 }); // right after you render it
// … your task …
await session.end(); // downloads session_<id>.zip
```

The face sensor needs its self-hosted assets (MediaPipe's engine, wasm and model, about 19 MB). Copy them once with `npx mmstudykit-face copy-assets public/mmstudykit-face`. See [docs/face.md](docs/face.md).

If the page reloads mid-session, `createSession()` returns the same session with `resumed: true`.
Call `start()` again and it continues in a new clock segment. [`examples/vanilla`](examples/vanilla)
is a complete study page that handles this.

```python
from mmstudykit import load_session
s = load_session("session_abc123.zip")
s.streams["pointer.move"]                                     # pandas DataFrame, t = session ms
s.markers                                                     # task.markers
```

Planned: React bindings (`<ConsentGate>`, `<CameraCheck>`, `<SensorStatus>`, M3), a jsPsych 8 extension and Python `align`/`epochs` (M4). See [PLAN.md §3](PLAN.md#3-public-api-sketch).

## What gets recorded, and what never is

| Sensor     | Records (defaults)                                                                                                                                   | Never recorded                                                                              | Opt-in                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `face`     | Head pose, 52 blendshape scores, eye openness and iris position, per-frame face-present flag and brightness, 1 Hz quality (fps, inference time)      | Video frames or images, in any form                                                         | Landmarks (subset or full mesh)            |
| `keyboard` | Key down/up times and a coarse category (letter, digit, punctuation, space, Enter, Tab, Backspace, Delete, navigation, modifier, composition, other) | Which key was pressed or what was typed; anything in password, one-time-code or card fields | Key identity (must appear in consent text) |
| `pointer`  | Position (incl. coalesced samples), buttons, pointer type, enter/leave and geometry of elements you tag as areas of interest                         | Text or content of the elements under the pointer                                           |                                            |
| `page`     | Visibility, focus/blur, viewport size and zoom, scroll (window and tagged containers), fullscreen, page lifecycle                                    | URLs, titles or page content                                                                |                                            |
| _session_  | Consent record (text version + hash, per-sensor decisions), pauses, clock anchors, coarse browser/OS/device class                                    | Device or camera labels and IDs, fingerprinting signals, IP address, timezone, language     |                                            |

## Ethics, privacy and the law

**This toolkit is intended for research with informed consent.** You are responsible for the legal and ethical basis of your study: ethics approval, data-protection law (e.g. GDPR), participant information and consent.

- **Features, not inferences.** The core packages output behavioral features, not emotion or affect labels, and that will not change.
- **EU AI Act.** Under Art. 5(1)(f) of the EU AI Act (Regulation (EU) 2024/1689), AI systems that infer the emotions of people **in workplaces and educational institutions are prohibited**, except for medical or safety reasons. This has applied since 2 February 2025. Outside those settings, emotion-recognition systems are classed as high-risk (Annex III) and carry transparency duties (Art. 50(3)). The Act excludes systems developed and used _solely_ for scientific research (Art. 2(6)), but deploying a system into real classrooms or workplaces is not covered by that exclusion. If you build an affect or engagement classifier on top of these features, these rules may apply to you. The Act was amended in 2026, so check the current consolidated text. _This is not legal advice._
- **Pseudonymous is not anonymous.** Exported data is linked to a participant ID and remains personal data under GDPR. Facial geometry (especially full landmark meshes) and keystroke timing can both act as biometric identifiers. That's why landmarks are opt-in and key identity is off by default.
- **Data minimization by default.** No raw video, no key content, researcher-provided pseudonymous IDs, coarse device info only.
- **Participant control.** Participants can pause sensing and withdraw at any time. Withdrawal deletes locally buffered data, tells upload sinks to delete what they hold, and leaves only a manifest stub marked `withdrawn`.
- **Third parties.** The face sensor uses Google's MediaPipe, which runs entirely on-device. MediaPipe Tasks ≥ 1.0 also sends usage metrics to Google by default. The toolkit self-hosts MediaPipe's files and blocks that traffic. An automated end-to-end test, run on the real camera path in Chromium and Firefox, checks that no request goes anywhere you didn't configure. See [docs/face.md](docs/face.md#privacy).
- **Proof, not promises.** An automated end-to-end test runs a full session and checks that no image data is sent over the network or written to IndexedDB, localStorage or other browser storage.

## Status

| Milestone                                                   | Status                                  |
| ----------------------------------------------------------- | --------------------------------------- |
| M0: Scaffold, plan, format schema v0                        | ✅ done                                 |
| M1: Core, pointer/keyboard/page sensors, export             | ✅ done                                 |
| M2: Face sensor, fake-camera e2e, privacy test              | in progress (waiting for the test clip) |
| M3: Consent UI, React, demo study, upload sink              |                                         |
| M4: jsPsych extension, Python align/epochs, researcher view |                                         |
| M5: Docs site, benchmarks, release v0.1.0                   |                                         |

## Repository layout

```
packages/core       @mmstudykit/core: session, clock, consent, streams, recorder, export, sinks
packages/sensors    @mmstudykit/sensors: pointer, keyboard, page (subpath exports)
packages/face       @mmstudykit/face: face sensor, self-hosted MediaPipe engine, copy-assets CLI, privacy e2e
examples/vanilla    a complete study page without a framework, plus its end-to-end test
spec/               bundle format: manifest JSON Schema, conventions, shared test fixtures
python/mmstudykit   Python loader (load_session)
docs/               face sensor guide, worker spike results
PLAN.md             architecture, API, milestones, risks, open questions
```

More packages (`react`, `jspsych`) and apps (`demo`, `receiver`) arrive with their milestones.

## Development

Requires Node 24 (see `.nvmrc`) and pnpm 12 (`corepack enable pnpm`). Browser tests use Playwright's browsers.

```sh
pnpm install
pnpm --filter @mmstudykit/core exec playwright install chromium firefox webkit   # once
pnpm check          # format, lint, typecheck, build, unit + browser tests (Chromium, Firefox, WebKit)
                    # (face tests download the MediaPipe model once into .cache/, SHA-256 checked)

cd python/mmstudykit
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]" && mypy && pytest
cd ../..

pnpm roundtrip      # TypeScript writes bundles (incl. a real e2e session), Python reads them back
```

Turborepo collects anonymous usage telemetry by default. CI disables it, and you can too with `turbo telemetry disable` or `TURBO_TELEMETRY_DISABLED=1`.

## License

[Apache-2.0](LICENSE)
