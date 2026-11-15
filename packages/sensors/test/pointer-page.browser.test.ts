import { afterEach, describe, expect, it } from 'vitest';
import { page as browserPage, userEvent } from 'vitest/browser';

import { record, schemaErrors, sleep } from '../../core/test/browser.js';
import { page } from '../src/page.js';
import { pointer } from '../src/pointer.js';

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  scrollTo(0, 0);
});

describe('pointer sensor (trusted input)', () => {
  it('records moves, buttons and AOI enter/leave with geometry', async () => {
    document.body.innerHTML = `
      <div style="padding:40px">
        <div id="q" data-mmsk-aoi="question" style="width:300px;height:120px;padding:20px">
          <button id="b" data-mmsk-aoi="option_b" style="width:120px;height:40px">B</button>
        </div>
        <p id="outside" style="height:60px">outside</p>
      </div>`;
    const button = byId('b');
    const outside = byId('outside');

    const out = await record({ sensors: [pointer()] }, { sensors: ['pointer'] }, async () => {
      await userEvent.hover(outside);
      await userEvent.hover(button);
      await userEvent.click(button);
      await userEvent.hover(outside);
    });
    expect(schemaErrors(out.manifest)).toBe('');

    const moves = out.streams['pointer.move'] ?? [];
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.pointer_type === 'mouse')).toBe(true);
    const ts = moves.map((m) => Number(m.t));
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);

    const buttons = out.streams['pointer.button'] ?? [];
    expect(buttons.map((b) => [b.type, b.button, b.aoi])).toEqual([
      ['down', '0', 'option_b'],
      ['up', '0', 'option_b'],
    ]);

    const aoi = out.streams['pointer.aoi'] ?? [];
    const crossings = aoi
      .filter((r) => r.type === 'enter' || r.type === 'leave')
      .map((r) => `${String(r.type)}:${String(r.aoi)}`);
    // Entering the nested button enters the outer AOI first; leaving exits the inner first.
    expect(crossings).toEqual([
      'enter:question',
      'enter:option_b',
      'leave:option_b',
      'leave:question',
    ]);

    const rects = aoi.filter((r) => r.type === 'rect');
    expect(rects.map((r) => r.aoi).sort()).toEqual(['option_b', 'question']);
    const qRect = rects.find((r) => r.aoi === 'question')?.rect as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const actual = byId('q').getBoundingClientRect();
    expect(qRect.width).toBeCloseTo(actual.width, 1);
    expect(qRect.y).toBeCloseTo(actual.top + scrollY, 1);
  });

  it('records AOI geometry changes and removal', async () => {
    document.body.innerHTML =
      '<div id="a" data-mmsk-aoi="passage" style="width:200px;height:50px"></div>';
    const el = byId('a');
    const out = await record({ sensors: [pointer()] }, { sensors: ['pointer'] }, async () => {
      el.style.height = '150px';
      await sleep(250);
      el.remove();
      await sleep(250);
    });
    const rows = (out.streams['pointer.aoi'] ?? []).map((r) => [
      r.type,
      (r.rect as { height?: number } | null)?.height ?? null,
    ]);
    expect(rows).toEqual([
      ['rect', 50],
      ['rect', 150],
      ['removed', null],
    ]);
  });

  it('can turn AOIs off', async () => {
    const out = await record({ sensors: [pointer({ aoi: false })] }, { sensors: ['pointer'] }, () =>
      Promise.resolve(),
    );
    expect(out.manifest.streams.map((s) => s.name)).not.toContain('pointer.aoi');
  });
});

describe('page sensor', () => {
  it('records a snapshot, window and container scrolling, and resizes', async () => {
    document.body.innerHTML = `
      <div style="height:3000px">
        <div id="box" data-mmsk-scroll="passage" style="height:100px;overflow:auto">
          <div style="height:1000px">text</div>
        </div>
      </div>`;
    const box = byId('box');
    const out = await record({ sensors: [page()] }, { sensors: ['page'] }, async () => {
      scrollTo(0, 400);
      await sleep(100);
      box.scrollTop = 250;
      await sleep(100);
      await browserPage.viewport(700, 500);
      await sleep(200);
    });
    expect(schemaErrors(out.manifest)).toBe('');

    const events = out.streams['page.events'] ?? [];
    expect(events[0]).toMatchObject({
      type: 'snapshot',
      data: { visibility: 'visible', fullscreen: false },
    });
    expect(
      events.some((e) => e.type === 'resize' && (e.data as { width: number }).width === 700),
    ).toBe(true);

    const scroll = out.streams['page.scroll'] ?? [];
    expect(scroll.slice(0, 2).map((r) => [r.target, r.scroll_y])).toEqual([
      ['window', '0.0'],
      ['passage', '0.0'],
    ]);
    expect(scroll.some((r) => r.target === 'window' && r.scroll_y === '400.0')).toBe(true);
    expect(
      scroll.some((r) => r.target === 'passage' && r.scroll_y === '250.0' && r.max_y === '900.0'),
    ).toBe(true);
    // Nothing about the page itself.
    expect(JSON.stringify(out.raw)).not.toContain(location.pathname);
  });
});
