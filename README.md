# multimodal-study-kit _(working name)_

**Synchronized, privacy-preserving multimodal behavioral data collection for browser-based research studies.**

Add webcam face features, pointer movement, keystroke timing, page events and task markers to any web study in a few lines. Everything is recorded on one shared clock and exported as a documented bundle that loads into Python or R in one line.

> [!WARNING]
> **Pre-alpha, M0 of 5.** The repository currently contains the scaffold, the [plan](PLAN.md) and the draft [export format](spec/). The quickstart below shows the **target API**. It is not implemented yet, and this README will be kept in sync with what actually works as each milestone lands.

## Why

- **Privacy by design.** Video frames are analysed on the participant's device and never stored or sent. Only derived numbers are recorded, and only for sensors the participant consented to. Key content is never recorded by default. No third-party network requests unless you configure them.
- **One clock for everything.** Every sample and marker is timestamped on a single monotonic session clock. Timing accuracy is documented and measured, not just asserted.
- **Clean, self-describing exports.** CSV/JSONL streams plus a versioned `manifest.json` (JSON Schema in [`spec/`](spec/)) with the consent record, clock anchors, sensor configs and per-stream statistics.
- **Features, not inferences.** The toolkit outputs behavioral features (head pose, blendshape scores, pointer trajectories, keystroke timing). It does **not** infer emotions, engagement or cognitive states. That is a deliberate design and ethics decision ([see below](#ethics-privacy-and-the-law)).

## Quickstart _(target API, not implemented yet)_

```ts
import { createSession, downloadSink } from '@mmstudykit/core';
import { page } from '@mmstudykit/sensors/page';
import { pointer } from '@mmstudykit/sensors/pointer';
import { keyboard } from '@mmstudykit/sensors/keyboard';
import { face } from '@mmstudykit/face';

const session = await createSession({
  studyId: 'reading-pilot',
  participantId: 'P017', // pseudonymous, provided by you, never collected automatically
  sensors: [
    page(),
    pointer(),
    keyboard(), // timing + key category only
    face({ features: ['blendshapes', 'headPose'], fps: 15 }),
  ],
  sinks: [downloadSink()],
});

// Show session.describe() in your consent form, then record the participant's choices:
await session.consent({
  textVersion: 'ethics-v3',
  granted: ['page', 'pointer', 'keyboard', 'face'],
});
await session.start();

await session.markOnNextFrame('stimulus_onset', { itemId: 3 });
// … your task …
await session.end(); // downloads session_<id>.zip
```

```python
from mmstudykit import load_session
s = load_session("session_abc123.zip")
s.streams["face.headpose"]                                    # pandas DataFrame, t = session ms
s.epochs(marker="stimulus_onset", window=(-500, 3000))
```

React bindings (`<ConsentGate>`, `<CameraCheck>`, `<SensorStatus>`) and a jsPsych 8 extension are planned. See [PLAN.md §3](PLAN.md#3-public-api-sketch).

## What gets recorded, and what never is

| Sensor     | Records (defaults)                                                                                                | Never recorded                                                                          | Opt-in                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ |
| `face`     | Head pose, 52 blendshape scores, iris features, face-present flag, quality metrics (fps, brightness)              | Video frames or images, in any form                                                     | Landmarks (subset or full mesh)            |
| `keyboard` | Key down/up times and coarse category (letter, digit, space, backspace, enter, modifier, other)                   | Which key was pressed or what was typed; anything in password fields                    | Key identity (must appear in consent text) |
| `pointer`  | Position, buttons, pointer type, enter/leave of elements you tag as areas of interest                             | Text or content of the elements under the pointer                                       |                                            |
| `page`     | Visibility, focus/blur, viewport size, scroll, fullscreen, page lifecycle                                         | URLs or page content                                                                    |                                            |
| _session_  | Consent record (text version + hash, per-sensor decisions), pauses, clock anchors, coarse browser/OS/device class | Device or camera labels and IDs, fingerprinting signals, IP address, timezone, language |                                            |

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
| M1: Core, pointer/keyboard/page sensors, export             | next    |
| M2: Face sensor, fake-camera e2e, privacy test              |         |
| M3: Consent UI, React, demo study, upload sink              |         |
| M4: jsPsych extension, Python align/epochs, researcher view |         |
| M5: Docs site, benchmarks, release v0.1.0                   |         |

## Repository layout

```
packages/core       @mmstudykit/core: session, clock, streams, recorder, export (skeleton)
spec/               bundle format: manifest JSON Schema, conventions, shared test fixtures
python/mmstudykit   Python loader (skeleton)
PLAN.md             architecture, API, milestones, risks, open questions
```

More packages (`sensors`, `face`, `react`, `jspsych`) and apps (`demo`, `receiver`) arrive with their milestones.

## Development

Requires Node 24 (see `.nvmrc`) and pnpm 12 (`corepack enable pnpm`).

```sh
pnpm install
pnpm check          # format, lint, typecheck, build, unit tests

cd python/mmstudykit
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]" && pytest
```

Turborepo collects anonymous usage telemetry by default. CI disables it, and you can too with `turbo telemetry disable` or `TURBO_TELEMETRY_DISABLED=1`.

## License

[Apache-2.0](LICENSE) _(provisional, see [PLAN.md Q2](PLAN.md#12-open-questions))_.
