/**
 * End-to-end: the M1 "done when" criterion, automated.
 *
 * Builds the example, serves it, and drives it in Chromium like a participant: consent, reading,
 * clicking, typing (including into a password field), a page reload in the middle, then finish.
 * The downloaded zip must validate against the schema, contain both clock segments and the
 * recorded streams, and contain none of the typed text. With MMSK_ROUNDTRIP_DIR set, the zip is
 * also handed to the Python loader tests.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { build, preview } from 'vite';
import type { PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(
  readFileSync(join(root, '../../spec/manifest.schema.json'), 'utf8'),
) as object;

let server: PreviewServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  await build({ root, logLevel: 'warn' });
  server = await preview({
    root,
    logLevel: 'warn',
    preview: { port: 0, host: '127.0.0.1', strictPort: false },
  });
  baseUrl = server.resolvedUrls?.local[0] ?? '';
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await server.close();
});

describe('vanilla example', () => {
  it('records, survives a reload and exports a valid bundle without typed content', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });

    await page.goto(`${baseUrl}?pid=E2E-001`);
    await page.locator('#consent').waitFor();
    for (const box of await page.locator('input[name=sensor]').all()) await box.check();
    await page.click('#agree');
    await page.locator('#task').waitFor();

    await page.hover('#passage');
    await page.mouse.wheel(0, 120);
    await page.click('[data-answer=B]');
    await page.click('#notes');
    await page.keyboard.type('secret words');
    await page.click('#password');
    await page.keyboard.type('pw-hunter2');

    // Reload mid-session: the same tab resumes the same session.
    await page.reload();
    await page.locator('#resumed').waitFor();
    await page.click('#continue');
    await page.locator('#task').waitFor();
    await page.click('#notes');
    await page.keyboard.type('more');

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#finish')]);
    await page.locator('#done').waitFor();
    expect(await page.textContent('#done-text')).toContain('downloaded');
    const dir = mkdtempSync(join(tmpdir(), 'mmsk-e2e-'));
    const zipPath = join(dir, download.suggestedFilename());
    await download.saveAs(zipPath);
    await context.close();

    expect(download.suggestedFilename()).toMatch(/^session_[0-9a-f-]{36}\.zip$/);
    const files = Object.fromEntries(
      Object.entries(unzipSync(readFileSync(zipPath))).map(([p, d]) => [
        p.replace(/^session_[^/]+\//, ''),
        strFromU8(d),
      ]),
    );
    const manifest = JSON.parse(files['manifest.json'] ?? '{}') as {
      session: { participantId: string; status: string };
      clock: { segments: { reason: string }[] };
      consent: { decisions: Record<string, string> };
      environment: { persistence: string };
      streams: { name: string; stats: { count: number } }[];
    };

    const ajv = new Ajv2020({
      strict: true,
      strictTuples: false,
      allErrors: true,
      validateFormats: false,
    });
    const validate = ajv.compile(schema);
    expect(validate(manifest), ajv.errorsText(validate.errors)).toBe(true);

    expect(manifest.session).toMatchObject({ participantId: 'E2E-001', status: 'completed' });
    expect(manifest.clock.segments.map((s) => s.reason)).toEqual(['start', 'reload-resume']);
    expect(manifest.consent.decisions).toEqual({
      page: 'granted',
      pointer: 'granted',
      keyboard: 'granted',
    });
    expect(manifest.environment.persistence).toBe('indexeddb');
    const count = (name: string) => manifest.streams.find((s) => s.name === name)?.stats.count ?? 0;
    expect(count('pointer.move')).toBeGreaterThan(0);
    expect(count('pointer.aoi')).toBeGreaterThan(0);
    expect(count('page.scroll')).toBeGreaterThan(1);
    // "secret words" (12) + "more" (4) + clicks don't type; the password field is skipped entirely.
    expect(count('keyboard.keystrokes')).toBe(16);

    expect(files['streams/pointer.button.csv']).toContain('option_b');
    expect(files['streams/task.markers.jsonl']).toContain('"choice":"B"');
    expect(files['streams/task.markers.jsonl']).toContain('"source":"frame"');
    const everything = Object.values(files).join('\n');
    for (const fragment of ['secret', 'words', 'hunter', 'more"', 'KeyS'])
      expect(everything).not.toContain(fragment);

    expect(problems).toEqual([]);

    const out = process.env.MMSK_ROUNDTRIP_DIR;
    if (out) {
      mkdirSync(out, { recursive: true });
      copyFileSync(zipPath, join(out, 'vanilla-e2e.zip'));
    }
  });
});
