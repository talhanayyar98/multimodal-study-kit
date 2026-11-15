import type { ColumnSpec, Sensor, SensorContext, StreamSpec } from '@mmstudykit/core';

import { SENSORS_PACKAGE, SENSORS_VERSION } from './version.js';

export interface PointerOptions {
  /**
   * Record the intermediate samples browsers batch into one `pointermove` (`getCoalescedEvents`),
   * typically at the input device's rate rather than the display's. Default true.
   */
  coalesced?: boolean;
  /** Record enter/leave of areas of interest (elements with `aoiAttribute`) and their geometry. Default true. */
  aoi?: boolean;
  /** Attribute that marks an area of interest; its value is the AOI id. Default `data-mmsk-aoi`. */
  aoiAttribute?: string;
}

const POINTER_TYPES = ['mouse', 'pen', 'touch', 'unknown'] as const;
type PointerTypeValue = (typeof POINTER_TYPES)[number];

const XY: ColumnSpec[] = [
  {
    name: 'x',
    type: 'number',
    unit: 'px',
    description: 'clientX: CSS px from the left edge of the viewport.',
    precision: 2,
  },
  {
    name: 'y',
    type: 'number',
    unit: 'px',
    description: 'clientY: CSS px from the top edge of the viewport.',
    precision: 2,
  },
];
const POINTER_TYPE: ColumnSpec = {
  name: 'pointer_type',
  type: 'enum',
  unit: null,
  description: 'PointerEvent.pointerType (unknown if the browser reports something else).',
  enumValues: POINTER_TYPES,
};
const POINTER_ID: ColumnSpec = {
  name: 'pointer_id',
  type: 'integer',
  unit: null,
  description: 'PointerEvent.pointerId: distinguishes simultaneous touches.',
};
const BUTTONS: ColumnSpec = {
  name: 'buttons',
  type: 'integer',
  unit: null,
  description:
    'Bitmask of pressed buttons (PointerEvent.buttons): 1 primary, 2 secondary, 4 middle.',
};

/** Throttle for re-measuring AOI geometry after layout changes. */
const RECT_DEBOUNCE_MS = 100;
const MAX_AOI_ID = 64;

/**
 * Pointer sensor (mouse, pen, touch).
 *
 * Streams:
 * - `pointer.move`: position samples. With `coalesced`, rows with `coalesced = 1` come from
 *   `getCoalescedEvents()` and the row with `coalesced = 0` is the dispatched event (about one per
 *   frame). Filter on `coalesced == 0` for frame-rate data.
 * - `pointer.button`: down/up/cancel, with the innermost AOI under the pointer.
 * - `pointer.aoi`: `enter`/`leave` of researcher-tagged elements, plus `rect` rows with each AOI's
 *   position in document coordinates (CSS px, scroll-independent) whenever it changes, and
 *   `removed` when it leaves the DOM. Pointer `x`/`y` are viewport coordinates: add the window
 *   scroll offset from `page.scroll` to compare them with `rect`.
 */
export function pointer(options: PointerOptions = {}): Sensor {
  const coalesced = options.coalesced ?? true;
  const aoi = options.aoi ?? true;
  const attr = options.aoiAttribute ?? 'data-mmsk-aoi';
  const selector = `[${attr}]`;

  let ctx: SensorContext | null = null;
  /** AOI elements currently containing each pointer. */
  const inside = new Map<number, Set<Element>>();
  /** Last emitted geometry per AOI element. */
  const rects = new Map<Element, string>();
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let rectTimer: ReturnType<typeof setTimeout> | undefined;
  let counts = { move: 0, coalescedMove: 0, button: 0 };

  const aoiId = (el: Element) => (el.getAttribute(attr) ?? '').slice(0, MAX_AOI_ID);

  /** AOI elements containing `target`, innermost first. */
  const chain = (target: EventTarget | null): Element[] => {
    const out: Element[] = [];
    let el = target instanceof Element ? target.closest(selector) : null;
    while (el) {
      out.push(el);
      el = el.parentElement?.closest(selector) ?? null;
    }
    return out;
  };

  const emitMove = (e: PointerEvent, isCoalesced: boolean) => {
    if (!ctx) return;
    if (isCoalesced) counts.coalescedMove++;
    else counts.move++;
    ctx.emit('pointer.move', {
      t: ctx.clock.fromPerf(e.timeStamp),
      x: e.clientX,
      y: e.clientY,
      pointer_type: pointerType(e),
      pointer_id: e.pointerId,
      buttons: e.buttons,
      coalesced: isCoalesced,
    });
  };

  const onMove = (e: PointerEvent) => {
    if (coalesced && typeof e.getCoalescedEvents === 'function') {
      const list = e.getCoalescedEvents();
      // The last coalesced event is the dispatched one; it's written once, as coalesced = 0.
      for (let i = 0; i < list.length - 1; i++) {
        const c = list[i];
        if (c) emitMove(c, true);
      }
    }
    emitMove(e, false);
  };

  const onButton = (type: 'down' | 'up' | 'cancel') => (e: PointerEvent) => {
    if (!ctx) return;
    counts.button++;
    const innermost = aoi ? chain(e.composedPath()[0] ?? e.target)[0] : undefined;
    ctx.emit('pointer.button', {
      t: ctx.clock.fromPerf(e.timeStamp),
      type,
      button: e.button,
      buttons: e.buttons,
      x: e.clientX,
      y: e.clientY,
      pointer_type: pointerType(e),
      pointer_id: e.pointerId,
      aoi: innermost ? aoiId(innermost) : null,
    });
    if (type === 'cancel') leaveAll(e);
  };

  const transition = (e: PointerEvent, next: Element[]) => {
    if (!ctx) return;
    const t = ctx.clock.fromPerf(e.timeStamp);
    const current = inside.get(e.pointerId) ?? new Set<Element>();
    const nextSet = new Set(next);
    // Leave innermost-first, enter outermost-first, so nesting reads naturally in the data.
    for (const el of [...current].reverse()) {
      if (!nextSet.has(el)) {
        ctx.emit('pointer.aoi', {
          t,
          type: 'leave',
          aoi: aoiId(el),
          pointer_id: e.pointerId,
          rect: null,
        });
      }
    }
    for (const el of [...next].reverse()) {
      if (!current.has(el)) {
        ctx.emit('pointer.aoi', {
          t,
          type: 'enter',
          aoi: aoiId(el),
          pointer_id: e.pointerId,
          rect: null,
        });
      }
    }
    // Stored outermost-first so the reverse() above yields innermost-first.
    if (next.length) inside.set(e.pointerId, new Set([...next].reverse()));
    else inside.delete(e.pointerId);
  };

  const onOver = (e: PointerEvent) => {
    transition(e, chain(e.composedPath()[0] ?? e.target));
  };
  const onOut = (e: PointerEvent) => {
    // relatedTarget null: the pointer left the document (or a touch ended).
    if (e.relatedTarget === null) transition(e, []);
  };
  const leaveAll = (e: PointerEvent) => {
    transition(e, []);
  };

  const measure = () => {
    rectTimer = undefined;
    if (!ctx) return;
    const t = ctx.clock.now();
    const seen = new Set<Element>();
    for (const el of document.querySelectorAll(selector)) {
      seen.add(el);
      resizeObserver?.observe(el);
      const r = el.getBoundingClientRect();
      const rect = {
        x: round2(r.left + scrollX),
        y: round2(r.top + scrollY),
        width: round2(r.width),
        height: round2(r.height),
      };
      const key = `${aoiId(el)}|${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
      if (rects.get(el) === key) continue;
      rects.set(el, key);
      ctx.emit('pointer.aoi', { t, type: 'rect', aoi: aoiId(el), pointer_id: null, rect });
    }
    for (const el of [...rects.keys()]) {
      if (seen.has(el)) continue;
      rects.delete(el);
      resizeObserver?.unobserve(el);
      ctx.emit('pointer.aoi', { t, type: 'removed', aoi: aoiId(el), pointer_id: null, rect: null });
    }
  };
  const scheduleMeasure = () => {
    rectTimer ??= setTimeout(measure, RECT_DEBOUNCE_MS);
  };

  return {
    id: 'pointer',
    package: SENSORS_PACKAGE,
    version: SENSORS_VERSION,
    config: () => ({ coalesced, aoi, aoiAttribute: attr }),
    streams(): StreamSpec[] {
      const streams: StreamSpec[] = [
        {
          name: 'pointer.move',
          kind: 'samples',
          format: 'csv',
          nominalRateHz: null,
          timestampSource: 'event.timeStamp',
          columns: [
            ...XY,
            POINTER_TYPE,
            POINTER_ID,
            BUTTONS,
            {
              name: 'coalesced',
              type: 'boolean',
              unit: null,
              description:
                '1 if from getCoalescedEvents() (intermediate sample), 0 if the dispatched pointermove.',
            },
          ],
        },
        {
          name: 'pointer.button',
          kind: 'events',
          format: 'csv',
          nominalRateHz: null,
          timestampSource: 'event.timeStamp',
          columns: [
            {
              name: 'type',
              type: 'enum',
              unit: null,
              description: 'pointerdown, pointerup or pointercancel.',
              enumValues: ['down', 'up', 'cancel'],
            },
            {
              name: 'button',
              type: 'integer',
              unit: null,
              description: 'PointerEvent.button: 0 primary, 1 middle, 2 secondary.',
            },
            BUTTONS,
            ...XY,
            POINTER_TYPE,
            POINTER_ID,
            {
              name: 'aoi',
              type: 'string',
              unit: null,
              description: 'Innermost area of interest under the pointer, if any.',
              maxLength: MAX_AOI_ID,
            },
          ],
        },
      ];
      if (aoi) {
        streams.push({
          name: 'pointer.aoi',
          kind: 'events',
          format: 'jsonl',
          nominalRateHz: null,
          timestampSource: 'event.timeStamp (enter/leave); performance.now (rect/removed)',
          columns: [
            {
              name: 'type',
              type: 'enum',
              unit: null,
              description:
                'enter/leave: pointer crossed the AOI boundary. rect: AOI geometry (new or changed). removed: AOI left the DOM.',
              enumValues: ['enter', 'leave', 'rect', 'removed'],
            },
            {
              name: 'aoi',
              type: 'string',
              unit: null,
              description: `AOI id (value of ${attr}).`,
              maxLength: MAX_AOI_ID,
            },
            {
              name: 'pointer_id',
              type: 'integer',
              unit: null,
              description: 'Pointer that entered or left (enter/leave only).',
            },
            {
              name: 'rect',
              type: 'object',
              unit: 'px',
              description:
                'For rect rows: {x, y, width, height} in document coordinates (CSS px, independent of window scroll).',
            },
          ],
        });
      }
      return streams;
    },
    describe: () => ({
      title: 'Mouse, touch and pen',
      summary:
        'We record where the pointer is on this page and when you press or release a button.',
      records: [
        'pointer position on this page, many times per second',
        'button presses and releases',
        ...(aoi
          ? [
              'when the pointer enters or leaves parts of the page the researchers marked, and where those parts are',
            ]
          : []),
      ],
      neverRecords: ['the text or content under the pointer', 'anything outside this page'],
      rateHz: null,
    }),
    start(context) {
      ctx = context;
      counts = { move: 0, coalescedMove: 0, button: 0 };
      if (
        coalesced &&
        typeof PointerEvent !== 'undefined' &&
        !('getCoalescedEvents' in PointerEvent.prototype)
      ) {
        context.note(
          'getCoalescedEvents unavailable: only dispatched pointermove events are recorded',
        );
      }
      const opts = { capture: true, passive: true, signal: context.signal } as const;
      addEventListener('pointermove', onMove, opts);
      addEventListener('pointerdown', onButton('down'), opts);
      addEventListener('pointerup', onButton('up'), opts);
      addEventListener('pointercancel', onButton('cancel'), opts);
      if (!aoi) return;
      addEventListener('pointerover', onOver, opts);
      addEventListener('pointerout', onOut, opts);
      // Geometry: re-measure on resize, DOM changes, element scrolling and AOI/body size changes.
      addEventListener('resize', scheduleMeasure, opts);
      document.addEventListener(
        'scroll',
        (e) => {
          if (e.target !== document) scheduleMeasure();
        },
        opts,
      );
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(scheduleMeasure);
        resizeObserver.observe(document.body);
      }
      if (typeof MutationObserver !== 'undefined') {
        mutationObserver = new MutationObserver(scheduleMeasure);
        mutationObserver.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: [attr, 'style', 'class', 'hidden'],
        });
      }
      measure();
    },
    stop() {
      if (rectTimer !== undefined) clearTimeout(rectTimer);
      rectTimer = undefined;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      resizeObserver = null;
      mutationObserver = null;
      inside.clear();
      rects.clear();
      ctx = null;
    },
    summary: () => ({
      moveEvents: counts.move,
      coalescedSamples: counts.coalescedMove,
      buttonEvents: counts.button,
    }),
  };
}

function pointerType(e: PointerEvent): PointerTypeValue {
  const t = e.pointerType;
  return t === 'mouse' || t === 'pen' || t === 'touch' ? t : 'unknown';
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
