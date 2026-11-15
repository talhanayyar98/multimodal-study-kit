import type { ColumnSpec, Sensor, SensorContext, StreamSpec } from '@mmstudykit/core';

import { eventTarget, isSensitiveTarget, KEY_CATEGORIES, keyCategory } from './internal/keys.js';
import type { KeyCategory } from './internal/keys.js';
import { SENSORS_PACKAGE, SENSORS_VERSION } from './version.js';

export { KEY_CATEGORIES, keyCategory } from './internal/keys.js';
export type { KeyCategory } from './internal/keys.js';

export interface KeyboardOptions {
  /**
   * Ask for consent to also record which key was pressed (`key` and `code` columns). Off by
   * default. Even when requested, it's only recorded if the participant grants
   * `keyboard.keyIdentity`. Key identity can reveal what someone typed, so it must appear in your
   * consent text.
   */
  keyIdentity?: boolean;
  /**
   * CSS selector. If set, only keys whose target is inside a matching element are recorded
   * (e.g. `'[data-mmsk-keyboard]'` or `'#essay'`).
   */
  scope?: string;
}

const KEY_COLUMNS: ColumnSpec[] = [
  {
    name: 'key',
    type: 'string',
    unit: null,
    description: 'KeyboardEvent.key (opt-in: keyIdentity).',
    maxLength: 32,
  },
  {
    name: 'code',
    type: 'string',
    unit: null,
    description: 'KeyboardEvent.code (opt-in: keyIdentity).',
    maxLength: 32,
  },
];

const CATEGORY: ColumnSpec = {
  name: 'category',
  type: 'enum',
  unit: null,
  description:
    'Coarse key category. The key itself is not recorded (unless keyIdentity was granted).',
  enumValues: KEY_CATEGORIES,
};

interface Pending {
  tDown: number;
  category: KeyCategory;
  repeats: number;
  key: string;
  code: string;
}

/**
 * Keyboard timing sensor.
 *
 * Records key-down/up times and a coarse category per key. Down and up are paired in the browser
 * by `event.code`, which is never stored, so rollover typing (pressing the next key before
 * releasing the previous one) pairs correctly. Never records anything from password, one-time
 * code or card-number fields, or from inside `[data-mmsk-ignore]`.
 *
 * Streams:
 * - `keyboard.events`: every key-down (including auto-repeats) and key-up.
 * - `keyboard.keystrokes`: one row per press, `t` = key-down time, with release time and dwell.
 *   Flight times (down-to-down, up-to-down) are derived downstream. A press whose release wasn't
 *   seen (focus left the page while the key was held, pause, end) has empty `t_up`/`dwell_ms`.
 */
export function keyboard(options: KeyboardOptions = {}): Sensor {
  const requestKeyIdentity = options.keyIdentity === true;
  const scope = options.scope;
  let ctx: SensorContext | null = null;
  let withKeys = false;
  const pending = new Map<string, Pending>();
  /** Codes whose key-down was skipped (sensitive field, out of scope): skip their key-up too. */
  const skipped = new Set<string>();
  // Deliberately no count of skipped sensitive-field keys: it would reveal password lengths.
  let counts = { down: 0, up: 0 };

  const emitStroke = (p: Pending, tUp: number | null) => {
    ctx?.emit('keyboard.keystrokes', {
      t: p.tDown,
      t_up: tUp,
      dwell_ms: tUp === null ? null : tUp - p.tDown,
      category: p.category,
      repeats: p.repeats,
      ...(withKeys ? { key: p.key, code: p.code } : {}),
    });
  };

  /** End every press still held, without a release time. */
  const flushPending = () => {
    for (const p of pending.values()) emitStroke(p, null);
    pending.clear();
  };

  const slot = (e: KeyboardEvent) => e.code || `key:${e.key}`;

  const onDown = (e: KeyboardEvent) => {
    if (!ctx) return;
    const id = slot(e);
    const target = eventTarget(e);
    if (isSensitiveTarget(target) || (scope && !inScope(target, scope))) {
      skipped.add(id);
      pending.delete(id);
      return;
    }
    skipped.delete(id);
    const t = ctx.clock.fromPerf(e.timeStamp);
    const category = keyCategory(e.key, e.isComposing);
    const existing = pending.get(id);
    if (e.repeat) {
      // Auto-repeat of a key whose press we didn't see (held before start) is dropped.
      if (!existing) return;
      existing.repeats++;
    } else {
      if (existing) emitStroke(existing, null); // its key-up never arrived
      pending.set(id, { tDown: t, category, repeats: 0, key: e.key, code: e.code });
    }
    counts.down++;
    ctx.emit('keyboard.events', {
      t,
      type: 'down',
      category,
      repeat: e.repeat,
      ...(withKeys ? { key: e.key, code: e.code } : {}),
    });
  };

  const onUp = (e: KeyboardEvent) => {
    if (!ctx) return;
    const id = slot(e);
    if (skipped.delete(id)) return;
    const p = pending.get(id);
    // A release without a recorded press (key held before start, or pressed in another window).
    if (!p) return;
    pending.delete(id);
    const t = ctx.clock.fromPerf(e.timeStamp);
    counts.up++;
    ctx.emit('keyboard.events', {
      t,
      type: 'up',
      category: keyCategory(e.key, e.isComposing),
      repeat: false,
      ...(withKeys ? { key: e.key, code: e.code } : {}),
    });
    emitStroke(p, t);
  };

  return {
    id: 'keyboard',
    package: SENSORS_PACKAGE,
    version: SENSORS_VERSION,
    options: requestKeyIdentity
      ? [
          {
            id: 'keyIdentity',
            title: 'Which keys',
            description:
              'Also record which key was pressed (for example "a" or "Enter"). This can reveal what you type. Password fields are still never recorded.',
          },
        ]
      : [],
    config: () => ({ keyIdentity: requestKeyIdentity, scope: scope ?? null }),
    streams(granted): StreamSpec[] {
      const keys = requestKeyIdentity && granted.has('keyIdentity') ? KEY_COLUMNS : [];
      return [
        {
          name: 'keyboard.events',
          kind: 'events',
          format: 'csv',
          nominalRateHz: null,
          timestampSource: 'event.timeStamp',
          columns: [
            {
              name: 'type',
              type: 'enum',
              unit: null,
              description: 'Key down or up.',
              enumValues: ['down', 'up'],
            },
            CATEGORY,
            {
              name: 'repeat',
              type: 'boolean',
              unit: null,
              description: '1 for auto-repeat key-downs while a key is held.',
            },
            ...keys,
          ],
        },
        {
          name: 'keyboard.keystrokes',
          kind: 'events',
          format: 'csv',
          nominalRateHz: null,
          timestampSource: 'event.timeStamp',
          columns: [
            {
              name: 't_up',
              type: 'number',
              unit: 'ms',
              description: 'Session time of the release; empty if not observed.',
              precision: 3,
            },
            {
              name: 'dwell_ms',
              type: 'number',
              unit: 'ms',
              description: 'Hold time (t_up − t).',
              precision: 3,
            },
            CATEGORY,
            {
              name: 'repeats',
              type: 'integer',
              unit: null,
              description: 'Auto-repeat key-downs while held.',
            },
            ...keys,
          ],
        },
      ];
    },
    describe: () => ({
      title: 'Keyboard timing',
      summary: 'We record when keys are pressed and released, and what kind of key it was.',
      records: [
        'when each key is pressed and released',
        'the kind of key: letter, digit, punctuation, space, Enter, Tab, Backspace, Delete, arrow or other navigation key, modifier (such as Shift), or other',
      ],
      neverRecords: [
        requestKeyIdentity
          ? 'which keys you press or what you type, unless you agree to the "Which keys" option'
          : 'which keys you press or what you type',
        'anything typed in password fields',
        ...(scope ? ['keys pressed outside the parts of the page the researchers selected'] : []),
      ],
      rateHz: null,
    }),
    privacy: (granted) => ({
      keyIdentityRecorded: requestKeyIdentity && granted.has('keyIdentity'),
    }),
    start(context) {
      ctx = context;
      withKeys = requestKeyIdentity && context.granted.has('keyIdentity');
      counts = { down: 0, up: 0 };
      const opts = { capture: true, passive: true, signal: context.signal } as const;
      addEventListener('keydown', onDown, opts);
      addEventListener('keyup', onUp, opts);
      // A key held while focus leaves the page never reports its release.
      addEventListener('blur', flushPending, { signal: context.signal });
      document.addEventListener(
        'visibilitychange',
        () => {
          if (document.visibilityState === 'hidden') flushPending();
        },
        { signal: context.signal },
      );
    },
    pause: flushPending,
    stop() {
      flushPending();
      skipped.clear();
      ctx = null;
    },
    summary: () => ({ keyDowns: counts.down, keyUps: counts.up }),
  };
}

function inScope(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}
