import { describe, expect, it } from 'vitest';

import { fromNavigator, measureTimerResolution, parseUserAgent } from '../src/environment.js';
import { randomId } from '../src/util/id.js';
import { sha256, sha256Hex, toHex } from '../src/util/sha256.js';

describe('SHA-256', () => {
  // FIPS 180-2 test vectors, plus multi-block and non-ASCII input.
  const vectors: [string, string][] = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    ['a'.repeat(1000), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3'],
  ];

  it.each(vectors)('pure-JS fallback: %#', (input, hex) => {
    expect(toHex(sha256(new TextEncoder().encode(input)))).toBe(hex);
  });

  it.each(vectors)('WebCrypto path: %#', async (input, hex) => {
    expect(await sha256Hex(input)).toBe(hex);
  });

  it('agrees with WebCrypto on non-ASCII text at block boundaries', async () => {
    for (const n of [55, 56, 63, 64, 65, 119, 120]) {
      const text = 'é☕'.repeat(n);
      expect(toHex(sha256(new TextEncoder().encode(text)))).toBe(await sha256Hex(text));
    }
  });
});

describe('randomId', () => {
  it('is a v4 UUID', () => {
    expect(randomId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('coarse environment', () => {
  const cases: [string, string, number, object][] = [
    [
      'Chrome on macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      0,
      {
        browser: { name: 'Chrome', majorVersion: 142 },
        os: { name: 'macOS' },
        deviceClass: 'desktop',
      },
    ],
    [
      'Edge on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.3595.53',
      0,
      {
        browser: { name: 'Edge', majorVersion: 142 },
        os: { name: 'Windows' },
        deviceClass: 'desktop',
      },
    ],
    [
      'Firefox on Linux',
      'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0',
      0,
      {
        browser: { name: 'Firefox', majorVersion: 145 },
        os: { name: 'Linux' },
        deviceClass: 'desktop',
      },
    ],
    [
      'Safari on iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      5,
      { browser: { name: 'Safari', majorVersion: 18 }, os: { name: 'iOS' }, deviceClass: 'mobile' },
    ],
    [
      'Safari on iPad (desktop UA)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      5,
      {
        browser: { name: 'Safari', majorVersion: 26 },
        os: { name: 'iPadOS' },
        deviceClass: 'tablet',
      },
    ],
    [
      'Chrome on Android phone',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
      5,
      {
        browser: { name: 'Chrome', majorVersion: 142 },
        os: { name: 'Android' },
        deviceClass: 'mobile',
      },
    ],
    [
      'Android tablet',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      5,
      {
        browser: { name: 'Chrome', majorVersion: 142 },
        os: { name: 'Android' },
        deviceClass: 'tablet',
      },
    ],
    [
      'headless Chrome',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/159.0.0.0 Safari/537.36',
      0,
      {
        browser: { name: 'HeadlessChrome', majorVersion: 159 },
        os: { name: 'macOS' },
        deviceClass: 'desktop',
      },
    ],
    [
      'unknown',
      'curl/8.0',
      0,
      {
        browser: { name: 'other', majorVersion: null },
        os: { name: 'other' },
        deviceClass: 'unknown',
      },
    ],
  ];

  it.each(cases)('%s', (_label, ua, touch, expected) => {
    expect(parseUserAgent(ua, touch)).toEqual(expected);
  });

  it('prefers low-entropy UA Client Hints when present, ignoring GREASE brands', () => {
    expect(
      fromNavigator({
        userAgent: cases[0]?.[1] ?? '',
        userAgentData: {
          brands: [
            { brand: 'Not_A Brand', version: '99' },
            { brand: 'Chromium', version: '142' },
            { brand: 'Microsoft Edge', version: '142' },
          ],
          mobile: false,
          platform: 'Windows',
        },
      }),
    ).toEqual({
      browser: { name: 'Edge', majorVersion: 142 },
      os: { name: 'Windows' },
      deviceClass: 'desktop',
    });
  });

  it('measures timer resolution and gives up on a frozen clock', () => {
    let t = 0;
    expect(measureTimerResolution(() => (t += 0.1))).toBeCloseTo(0.1, 3);
    expect(measureTimerResolution(() => 42)).toBeNull();
  });
});
