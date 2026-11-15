import type { Sensor, SensorContext, StreamSpec } from '@mmstudykit/core';

import { SENSORS_PACKAGE, SENSORS_VERSION } from './version.js';

export interface PageOptions {
  /** Record scroll positions of the window and of elements tagged with `scrollAttribute`. Default true. */
  scroll?: boolean;
  /** Attribute that marks a scroll container to record; its value names it. Default `data-mmsk-scroll`. */
  scrollAttribute?: string;
}

const PAGE_EVENT_TYPES = [
  'snapshot',
  'visibility',
  'focus',
  'blur',
  'resize',
  'fullscreen',
  'pageshow',
  'pagehide',
  'freeze',
  'resume',
  'online',
  'offline',
] as const;
type PageEventType = (typeof PAGE_EVENT_TYPES)[number];

/**
 * Page sensor: the context needed to interpret everything else.
 *
 * - `page.events`: a `snapshot` at start (visibility, focus, viewport, fullscreen), then
 *   visibility changes, window focus/blur, viewport resizes (incl. zoom / devicePixelRatio
 *   changes), fullscreen, bfcache `pageshow`/`pagehide`, Page Lifecycle `freeze`/`resume` and
 *   online/offline.
 * - `page.scroll`: scroll offsets of the window (`target = window`) and of tagged containers.
 *
 * It doesn't record URLs, titles or page content.
 */
export function page(options: PageOptions = {}): Sensor {
  const scroll = options.scroll ?? true;
  const scrollAttr = options.scrollAttribute ?? 'data-mmsk-scroll';
  let ctx: SensorContext | null = null;
  let resizeFrame: number | undefined;
  let lastResize: { t: number } | null = null;
  let dprQuery: MediaQueryList | null = null;
  let counts = { hidden: 0, blur: 0 };

  const event = (type: PageEventType, data: Record<string, unknown> | null, timeStamp?: number) => {
    if (!ctx) return;
    const t = timeStamp === undefined ? ctx.clock.now() : ctx.clock.fromPerf(timeStamp);
    ctx.emit('page.events', { t, type, data });
  };

  const viewport = () => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio: devicePixelRatio,
  });

  const emitResize = () => {
    resizeFrame = undefined;
    if (!ctx || !lastResize) return;
    ctx.emit('page.events', { t: lastResize.t, type: 'resize', data: viewport() });
    lastResize = null;
  };

  const onResize = (e: Event) => {
    if (!ctx) return;
    // Resizes fire continuously while dragging; keep the latest per frame.
    lastResize = { t: ctx.clock.fromPerf(e.timeStamp) };
    if (resizeFrame === undefined) {
      resizeFrame =
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame(emitResize) : undefined;
      if (resizeFrame === undefined) emitResize();
    }
  };

  /** devicePixelRatio changes (zoom, moving to another monitor) don't always fire resize. */
  const watchDpr = (signal: AbortSignal) => {
    if (typeof matchMedia !== 'function') return;
    dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    dprQuery.addEventListener(
      'change',
      () => {
        if (!ctx) return;
        event('resize', viewport());
        if (!signal.aborted) watchDpr(signal);
      },
      { once: true, signal },
    );
  };

  const emitScroll = (target: 'window' | Element, timeStamp?: number) => {
    if (!ctx) return;
    const t = timeStamp === undefined ? ctx.clock.now() : ctx.clock.fromPerf(timeStamp);
    if (target === 'window') {
      const root = document.documentElement;
      ctx.emit('page.scroll', {
        t,
        target: 'window',
        scroll_x: scrollX,
        scroll_y: scrollY,
        max_x: Math.max(0, root.scrollWidth - root.clientWidth),
        max_y: Math.max(0, root.scrollHeight - root.clientHeight),
      });
      return;
    }
    ctx.emit('page.scroll', {
      t,
      target: (target.getAttribute(scrollAttr) ?? '').slice(0, 64) || 'unnamed',
      scroll_x: target.scrollLeft,
      scroll_y: target.scrollTop,
      max_x: Math.max(0, target.scrollWidth - target.clientWidth),
      max_y: Math.max(0, target.scrollHeight - target.clientHeight),
    });
  };

  const streams = (): StreamSpec[] => {
    const out: StreamSpec[] = [
      {
        name: 'page.events',
        kind: 'events',
        format: 'jsonl',
        nominalRateHz: null,
        timestampSource: 'event.timeStamp (snapshot: performance.now)',
        columns: [
          {
            name: 'type',
            type: 'enum',
            unit: null,
            description: 'Page event.',
            enumValues: PAGE_EVENT_TYPES,
          },
          {
            name: 'data',
            type: 'object',
            unit: null,
            description:
              'snapshot: {visibility, focused, width, height, devicePixelRatio, fullscreen}. visibility: {state}. resize: {width, height, devicePixelRatio}. fullscreen: {active}. pageshow/pagehide: {persisted}.',
          },
        ],
      },
    ];
    if (scroll) {
      out.push({
        name: 'page.scroll',
        kind: 'events',
        format: 'csv',
        nominalRateHz: null,
        timestampSource: 'event.timeStamp (initial rows: performance.now)',
        columns: [
          {
            name: 'target',
            type: 'string',
            unit: null,
            description: `"window", or the ${scrollAttr} value of a tagged container.`,
            maxLength: 64,
          },
          {
            name: 'scroll_x',
            type: 'number',
            unit: 'px',
            description: 'Horizontal scroll offset (CSS px).',
            precision: 1,
          },
          {
            name: 'scroll_y',
            type: 'number',
            unit: 'px',
            description: 'Vertical scroll offset (CSS px).',
            precision: 1,
          },
          {
            name: 'max_x',
            type: 'number',
            unit: 'px',
            description: 'Largest possible horizontal offset at this time.',
            precision: 1,
          },
          {
            name: 'max_y',
            type: 'number',
            unit: 'px',
            description: 'Largest possible vertical offset at this time.',
            precision: 1,
          },
        ],
      });
    }
    return out;
  };

  return {
    id: 'page',
    package: SENSORS_PACKAGE,
    version: SENSORS_VERSION,
    config: () => ({ scroll, scrollAttribute: scrollAttr }),
    streams,
    describe: () => ({
      title: 'Page activity',
      summary:
        'We record whether this page is visible and in focus, the size of the window, and how far you scroll.',
      records: [
        'when this page is hidden or shown (for example when you switch tabs) and when the window gains or loses focus',
        'the size of the browser window and whether it is in fullscreen',
        ...(scroll ? ['how far you scroll'] : []),
      ],
      neverRecords: [
        'the addresses (URLs) or content of pages',
        'what you do in other tabs or applications',
      ],
      rateHz: null,
    }),
    start(context) {
      ctx = context;
      counts = { hidden: 0, blur: 0 };
      const signal = context.signal;
      const opts = { signal } as const;

      event('snapshot', {
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        ...viewport(),
        fullscreen: document.fullscreenElement != null,
      });

      document.addEventListener(
        'visibilitychange',
        (e) => {
          if (document.visibilityState === 'hidden') counts.hidden++;
          event('visibility', { state: document.visibilityState }, e.timeStamp);
        },
        opts,
      );
      // Window focus only: element focus events don't bubble, and we check the target anyway.
      addEventListener(
        'focus',
        (e) => {
          if (e.target === window) event('focus', null, e.timeStamp);
        },
        opts,
      );
      addEventListener(
        'blur',
        (e) => {
          if (e.target !== window) return;
          counts.blur++;
          event('blur', null, e.timeStamp);
        },
        opts,
      );
      addEventListener('resize', onResize, opts);
      watchDpr(signal);
      document.addEventListener(
        'fullscreenchange',
        (e) => {
          event('fullscreen', { active: document.fullscreenElement != null }, e.timeStamp);
        },
        opts,
      );
      addEventListener(
        'pageshow',
        (e) => {
          event('pageshow', { persisted: e.persisted }, e.timeStamp);
        },
        opts,
      );
      addEventListener(
        'pagehide',
        (e) => {
          event('pagehide', { persisted: e.persisted }, e.timeStamp);
        },
        opts,
      );
      document.addEventListener(
        'freeze',
        (e) => {
          event('freeze', null, e.timeStamp);
        },
        opts,
      );
      document.addEventListener(
        'resume',
        (e) => {
          event('resume', null, e.timeStamp);
        },
        opts,
      );
      addEventListener(
        'online',
        (e) => {
          event('online', null, e.timeStamp);
        },
        opts,
      );
      addEventListener(
        'offline',
        (e) => {
          event('offline', null, e.timeStamp);
        },
        opts,
      );

      if (!scroll) return;
      emitScroll('window');
      for (const el of document.querySelectorAll(`[${scrollAttr}]`)) emitScroll(el);
      // scroll doesn't bubble, but it can be captured. Browsers fire it at most once per frame.
      document.addEventListener(
        'scroll',
        (e) => {
          const target = e.target;
          if (target === document) emitScroll('window', e.timeStamp);
          else if (target instanceof Element && target.hasAttribute(scrollAttr))
            emitScroll(target, e.timeStamp);
        },
        { capture: true, passive: true, signal },
      );
    },
    stop() {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      emitResize();
      resizeFrame = undefined;
      dprQuery = null;
      ctx = null;
    },
    summary: () => ({ hiddenCount: counts.hidden, blurCount: counts.blur }),
  };
}
