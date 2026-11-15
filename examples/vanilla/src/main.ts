/**
 * A complete, framework-free study page: consent → task → finish (or withdraw), surviving reloads.
 * Run it with `pnpm --filter @mmstudykit/example-vanilla dev` and open the printed URL with
 * `?pid=P001` (your recruitment platform would normally provide the participant ID).
 */
import { createSession, downloadSink } from '@mmstudykit/core';
import type { Session } from '@mmstudykit/core';
import { keyboard } from '@mmstudykit/sensors/keyboard';
import { page } from '@mmstudykit/sensors/page';
import { pointer } from '@mmstudykit/sensors/pointer';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
const show = (id: string) => {
  for (const s of document.querySelectorAll('section')) s.hidden = s.id !== id;
};

const participantId = new URLSearchParams(location.search).get('pid') ?? 'demo-participant';

const session: Session = await createSession({
  studyId: 'vanilla-example',
  participantId,
  sensors: [page(), pointer(), keyboard()],
  sinks: [downloadSink()],
});

session.on('state', (state) => {
  $('status').textContent =
    `Session ${session.id.slice(0, 8)} · ${state} · storage: ${session.persistence}`;
});
session.on('warning', (w) => {
  console.warn('[mmstudykit]', w.sensorId ?? '', w.message);
});
$('status').textContent =
  `Session ${session.id.slice(0, 8)} · ${session.state} · storage: ${session.persistence}`;

async function beginTask(): Promise<void> {
  const result = await session.start();
  if (result.failed.length) console.warn('sensors that failed to start:', result.failed);
  show('task');
  // The task is now on screen: mark the frame it appears in.
  await session.markOnNextFrame('task_shown');
}

function finish(title: string, text: string): void {
  $('done-title').textContent = title;
  $('done-text').textContent = text;
  show('done');
}

// --- Entry: fresh, resumed after a reload, or already withdrawn in this tab ---

if (session.state === 'withdrawn') {
  finish('You withdrew', 'Your data from this session was deleted.');
} else if (session.resumed) {
  show('resumed');
  $('continue').addEventListener('click', () => void beginTask(), { once: true });
} else {
  const disclosure = session.describe();
  const container = $('disclosure');
  for (const d of disclosure.sensors) {
    const box = document.createElement('div');
    box.className = 'disclosure';
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'sensor';
    input.value = d.sensorId;
    // Consent must be opt-in: nothing is pre-checked.
    label.append(input, ` ${d.title}: ${d.summary}`);
    const records = document.createElement('ul');
    for (const r of d.records)
      records.append(
        Object.assign(document.createElement('li'), { textContent: `Recorded: ${r}` }),
      );
    for (const r of d.neverRecords)
      records.append(
        Object.assign(document.createElement('li'), { textContent: `Never recorded: ${r}` }),
      );
    box.append(label, records);
    container.append(box);
  }
  show('consent');

  $('agree').addEventListener('click', () => {
    void (async () => {
      const granted = [
        ...document.querySelectorAll<HTMLInputElement>('input[name=sensor]:checked'),
      ].map((i) => i.value);
      await session.consent({ textVersion: 'example-consent-v1', text: disclosure.text, granted });
      await beginTask();
    })();
  });
}

// --- Task controls ---

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-answer]')) {
  button.addEventListener('click', () => {
    session.mark('answer', { question: 1, choice: button.dataset.answer ?? null });
  });
}

$('pause').addEventListener('click', () => {
  if (session.state === 'running') {
    session.pause();
    $('pause').textContent = 'Resume';
  } else if (session.state === 'paused') {
    session.resume();
    $('pause').textContent = 'Pause';
  }
});

$('finish').addEventListener('click', () => {
  void (async () => {
    const { sinks } = await session.end();
    const failed = sinks.filter((s) => !s.ok);
    finish(
      'Thank you',
      failed.length
        ? `Saving failed (${failed.map((s) => s.error).join('; ')}). Your data is still on this device.`
        : 'Your data was downloaded as a zip file.',
    );
  })();
});

$('withdraw').addEventListener('click', () => {
  if (!confirm('Withdraw from the study and delete the data recorded so far?')) return;
  void session.withdraw().then(() => {
    finish('You withdrew', 'Your data from this session was deleted.');
  });
});
