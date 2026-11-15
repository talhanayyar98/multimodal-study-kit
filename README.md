# multimodal-study-kit _(working name)_

**Synchronized, privacy-preserving multimodal behavioral data collection for browser-based research studies.**

Add webcam face features, pointer movement, keystroke timing, page events and task markers to any web study in a few lines. Everything is recorded on one shared clock and exported as a documented bundle that loads into Python or R in one line.

> [!WARNING]
> **Pre-alpha, M1 of 5.** Core, the pointer/keyboard/page sensors, the zip export and the Python loader work and are tested on Chromium, Firefox and WebKit. The face sensor arrives in M2, React bindings in M3. Nothing is published to npm or PyPI yet. The quickstart below is kept true to the code.

## Why

- **Privacy by design.** Video frames are analysed on the participant's device and never stored or sent. Only derived numbers are recorded, and only for sensors the participant consented to. Key content is never recorded by default. No third-party network requests unless you configure them.
- **One clock for everything.** Every sample and marker is timestamped on a single monotonic session clock. Timing accuracy is documented and measured, not just asserted.
- **Clean, self-describing exports.** CSV/JSONL streams plus a versioned `manifest.json` (JSON Schema in [`spec/`](spec/)) with the consent record, clock anchors, sensor configs and per-stream statistics.
- **Features, not inferences.** The toolkit outputs behavioral features (head pose, blendshape scores, pointer trajectories, keystroke timing). It does **not** infer emotions, engagement or cognitive states. That is a deliberate design and ethics decision ([see below](#ethics-privacy-and-the-law)).

## Quickstart

```ts
import { createSession, downloadSink } from '@mmstudykit/core';
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
  ],
  sinks: [downloadSink()],
});

// Show session.describe() in your consent form, then record the participant's choices.
// Sensors that aren't granted never start.
await session.consent({
  textVersion: 'ethics-v3',
  granted: ['page', 'pointer', 'keyboard'],
});
await session.start();

await session.markOnNextFrame('stimulus_onset', { itemId: 3 }); // right after you render it
// … your task …
await session.end(); // downloads session_<id>.zip
```

If the page reloads mid-session, `createSession()` returns the same session with `resumed: true`.
Call `start()` again and it continues in a new clock segment. [`examples/vanilla`](examples/vanilla)
is a complete study page that handles this.

```python
from mmstudykit import load_session
s = load_session("session_abc123.zip")
s.streams["pointer.move"]                                     # pandas DataFrame, t = session ms
s.markers                                                     # task.markers
```

Planned: the `face` sensor (M2), React bindings (`<ConsentGate>`, `<CameraCheck>`, `<SensorStatus>`, M3), a jsPsych 8 extension and Python `align`/`epochs` (M4). See [PLAN.md §3](PLAN.md#3-public-api-sketch).

## What gets recorded, and what never is

| Sensor        | Records (defaults)                                                                                                                                   | Never recorded                                                                              | Opt-in                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `face` _(M2)_ | Head pose, 52 blendshape scores, iris features, face-present flag, quality metrics (fps, brightness)                                                 | Video frames or images, in any form                                                         | Landmarks (subset or full mesh)            |
| `keyboard`    | Key down/up times and a coarse category (letter, digit, punctuation, space, Enter, Tab, Backspace, Delete, navigation, modifier, composition, other) | Which key was pressed or what was typed; anything in password, one-time-code or card fields | Key identity (must appear in consent text) |
| `pointer`     | Position (incl. coalesced samples), buttons, pointer type, enter/leave and geometry of elements you tag as areas of interest                         | Text or content of the elements under the pointer                                           |                                            |
| `page`        | Visibility, focus/blur, viewport size and zoom, scroll (window and tagged containers), fullscreen, page lifecycle                                    | URLs, titles or page content                                                                |                                            |
| _session_     | Consent record (text version + hash, per-sensor decisions), pauses, clock anchors, coarse browser/OS/device class                                    | Device or camera labels and IDs, fingerprinting signals, IP address, timezone, language     |                                            |

## Ethics, privacy and the law

**This toolkit is intended for research with informed consent.** You are responsible for the legal and ethical basis of your study: ethics approval, data-protection law (e.g. GDPR), participant information and consent.

- **Features, not inferences.** The core packages output behavioral features, not emotion or affect labels, and that will not change.
- **EU AI Act.** Under Art. 5(1)(f) of the EU AI Act (Regulation (EU) 2024/1689), AI systems that infer the emotions of people **in workplaces and educational institutions are prohibited**, except for medical or safety reasons. This has applied since 2 February 2025. Outside those settings, emotion-recognition systems are classed as high-risk (Annex III) and carry transparency duties (Art. 50(3)). The Act excludes systems developed and used _solely_ for scientific research (Art. 2(6)), but deploying a system into real classrooms or workplaces is not covered by that exclusion. If you build an affect or engagement classifier on top of these features, these rules may apply to you. The Act was amended in 2026, so check the current consolidated text. _This is not legal advice._
- **Pseudonymous is not anonymous.** Exported data is linked to a participant ID and remains personal data under GDPR. Facial geometry (especially full landmark meshes) and keystroke timing can both act as biometric identifiers. That's why landmarks are opt-in and key identity is off by default.
- **Data minimization by default.** No raw video, no key content, researcher-provided pseudonymous IDs, coarse device info only.
- **Participant control.** Participants can pause sensing and withdraw at any time. Withdrawal deletes locally buffered data, tells upload sinks to delete what they hold, and leaves only a manifest stub marked `withdrawn`.
- **Third parties.** The face sensor uses Google's MediaPipe, which runs entirely on-device. MediaPipe Tasks ≥ 1.0 also sends usage metrics to Google by default. The toolkit is designed to self-host MediaPipe's files and block that traffic, and an automated test checks that no request goes anywhere you didn't configure. See [PLAN.md §0](PLAN.md#0-where-this-plan-departs-from-the-brief).
- **Proof, not promises.** An automated end-to-end test runs a full session and checks that no image data is sent over the network or written to IndexedDB, localStorage or other browser storage.

## Status

| Milestone                                                   | Status  |
| ----------------------------------------------------------- | ------- |
| M0: Scaffold, plan, format schema v0                        | ✅ done |
| M1: Core, pointer/keyboard/page sensors, export             | ✅ done |
| M2: Face sensor, fake-camera e2e, privacy test              | next    |
| M3: Consent UI, React, demo study, upload sink              |         |
| M4: jsPsych extension, Python align/epochs, researcher view |         |
| M5: Docs site, benchmarks, release v0.1.0                   |         |

## Repository layout

```
packages/core       @mmstudykit/core: session, clock, consent, streams, recorder, export, sinks
packages/sensors    @mmstudykit/sensors: pointer, keyboard, page (subpath exports)
examples/vanilla    a complete study page without a framework, plus its end-to-end test
spec/               bundle format: manifest JSON Schema, conventions, shared test fixtures
python/mmstudykit   Python loader (load_session)
PLAN.md             architecture, API, milestones, risks, open questions
```

More packages (`face`, `react`, `jspsych`) and apps (`demo`, `receiver`) arrive with their milestones.

## Development

Requires Node 24 (see `.nvmrc`) and pnpm 12 (`corepack enable pnpm`). Browser tests use Playwright's browsers.

```sh
pnpm install
pnpm --filter @mmstudykit/core exec playwright install chromium firefox webkit   # once
pnpm check          # format, lint, typecheck, build, unit + browser tests (Chromium, Firefox, WebKit)

cd python/mmstudykit
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]" && mypy && pytest
cd ../..

pnpm roundtrip      # TypeScript writes bundles (incl. a real e2e session), Python reads them back
```

Turborepo collects anonymous usage telemetry by default. CI disables it, and you can too with `turbo telemetry disable` or `TURBO_TELEMETRY_DISABLED=1`.

## License

[Apache-2.0](LICENSE)
