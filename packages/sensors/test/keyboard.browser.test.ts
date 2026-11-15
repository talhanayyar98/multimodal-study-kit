import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { record, schemaErrors } from '../../core/test/browser.js';
import { keyboard } from '../src/keyboard.js';

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

function field(html: string): HTMLElement {
  document.body.innerHTML = html;
  const el = document.body.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('no element');
  return el;
}

describe('keyboard sensor (trusted input)', () => {
  it('records timing and categories, never the text', async () => {
    const input = field('<textarea></textarea>');
    const secret = 'Hi, 42 there';
    const out = await record({ sensors: [keyboard()] }, { sensors: ['keyboard'] }, async () => {
      await userEvent.type(input, secret);
    });

    expect(schemaErrors(out.manifest)).toBe('');
    const strokes = out.streams['keyboard.keystrokes'] ?? [];
    // Shift for "H" is a stroke of its own (category modifier).
    const categories = strokes.map((s) => s.category).filter((c) => c !== 'modifier');
    expect(categories).toEqual([
      'letter',
      'letter',
      'punctuation',
      'space',
      'digit',
      'digit',
      'space',
      'letter',
      'letter',
      'letter',
      'letter',
      'letter',
    ]);
    for (const s of strokes) {
      expect(Number(s.dwell_ms)).toBeGreaterThanOrEqual(0);
      expect(Number(s.t_up)).toBeCloseTo(Number(s.t) + Number(s.dwell_ms), 3);
    }
    const events = out.streams['keyboard.events'] ?? [];
    expect(events.filter((e) => e.type === 'down')).toHaveLength(strokes.length);
    expect(events.filter((e) => e.type === 'up')).toHaveLength(strokes.length);

    // The typed content can't be reconstructed from anything in the export.
    expect(
      out.manifest.streams.find((s) => s.name === 'keyboard.events')?.columns.map((c) => c.name),
    ).toEqual(['t', 'type', 'category', 'repeat']);
    const everything = JSON.stringify(out.raw) + JSON.stringify(out.manifest);
    // (Digits alone would match timestamps, so check the key codes instead.)
    for (const fragment of ['Hi', 'there', 'KeyH', 'Digit4', 'Comma'])
      expect(everything).not.toContain(fragment);
    expect(out.manifest.privacy.keyIdentityRecorded).toBe(false);
  });

  it('pairs rollover keystrokes (next key pressed before the previous is released)', async () => {
    const input = field('<input>');
    input.focus();
    const out = await record({ sensors: [keyboard()] }, { sensors: ['keyboard'] }, async () => {
      await userEvent.keyboard('{a>}{b>}{/a}{/b}');
    });
    const strokes = out.streams['keyboard.keystrokes'] ?? [];
    expect(strokes).toHaveLength(2);
    const [a, b] = strokes.map((s) => ({ t: Number(s.t), up: Number(s.t_up) }));
    if (!a || !b) throw new Error('missing strokes');
    // a down < b down < a up < b up: each release went to its own press.
    expect(a.t).toBeLessThanOrEqual(b.t);
    expect(b.t).toBeLessThanOrEqual(a.up);
    expect(a.up).toBeLessThanOrEqual(b.up);
  });

  it('records nothing at all from password and one-time-code fields', async () => {
    document.body.innerHTML =
      '<input id="user"><input id="pw" type="password"><input id="otp" autocomplete="one-time-code">';
    const user = byId('user') as HTMLInputElement;
    const pw = byId('pw') as HTMLInputElement;
    const otp = byId('otp') as HTMLInputElement;
    const out = await record({ sensors: [keyboard()] }, { sensors: ['keyboard'] }, async () => {
      await userEvent.type(user, 'ab');
      await userEvent.type(pw, 'hunter22');
      await userEvent.type(otp, '123456');
    });
    expect(pw.value).toBe('hunter22');
    expect(out.streams['keyboard.keystrokes']?.map((s) => s.category)).toEqual([
      'letter',
      'letter',
    ]);
    expect(out.manifest.quality).toEqual({ keyboard: { keyDowns: 2, keyUps: 2 } });
  });

  it('records key identity only when it was requested and granted', async () => {
    const declined = await record(
      { sensors: [keyboard({ keyIdentity: true })] },
      { sensors: ['keyboard'] },
      async () => {
        await userEvent.type(field('<input>'), 'x');
      },
    );
    expect(declined.manifest.consent.options).toEqual({ 'keyboard.keyIdentity': 'declined' });
    expect(
      declined.manifest.streams
        .find((s) => s.name === 'keyboard.keystrokes')
        ?.columns.some((c) => c.name === 'key'),
    ).toBe(false);

    const granted = await record(
      { sensors: [keyboard({ keyIdentity: true })] },
      { sensors: ['keyboard'], options: ['keyboard.keyIdentity'] },
      async () => {
        await userEvent.type(field('<input>'), 'x');
      },
    );
    expect(granted.manifest.privacy.keyIdentityRecorded).toBe(true);
    expect(granted.streams['keyboard.keystrokes']?.[0]).toMatchObject({
      category: 'letter',
      key: 'x',
      code: 'KeyX',
    });
  });

  it('limits recording to a scope', async () => {
    document.body.innerHTML = '<input id="in" data-task><input id="out">';
    const out = await record(
      { sensors: [keyboard({ scope: '[data-task]' })] },
      { sensors: ['keyboard'] },
      async () => {
        await userEvent.type(byId('out'), 'zz');
        await userEvent.type(byId('in'), '7');
      },
    );
    expect(out.streams['keyboard.keystrokes']?.map((s) => s.category)).toEqual(['digit']);
  });

  it('ends presses still held at pause or end without a release time', async () => {
    const input = field('<input>');
    input.focus();
    const out = await record({ sensors: [keyboard()] }, { sensors: ['keyboard'] }, async () => {
      await userEvent.keyboard('{Shift>}');
    });
    await userEvent.keyboard('{/Shift}');
    expect(out.streams['keyboard.keystrokes']).toEqual([
      expect.objectContaining({ category: 'modifier', t_up: '', dwell_ms: '' }),
    ]);
  });

  it('describes itself for the consent form', () => {
    const d = keyboard({ keyIdentity: true }).describe();
    expect(d.neverRecords.join(' ')).toMatch(/password/);
    expect(d.neverRecords[0]).toMatch(/unless you agree/);
  });
});
