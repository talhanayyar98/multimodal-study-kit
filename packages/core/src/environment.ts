import type { EnvironmentInfo } from './manifest.js';

/**
 * Coarse environment info: what an analyst needs to interpret the data, and nothing that helps
 * fingerprint the participant. Browser family + major version, OS family, device class and the
 * viewport. No full UA string, no device or camera labels, no timezone, no language, no screen
 * size beyond the viewport.
 */
export function detectEnvironment(): Omit<EnvironmentInfo, 'persistence'> {
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
  const win = globalThis as {
    innerWidth?: number;
    innerHeight?: number;
    devicePixelRatio?: number;
  };
  const parsed = nav
    ? fromNavigator(nav)
    : {
        browser: { name: 'unknown', majorVersion: null },
        os: { name: 'unknown' },
        deviceClass: 'unknown' as const,
      };
  return {
    ...parsed,
    viewport: {
      width: win.innerWidth ?? 0,
      height: win.innerHeight ?? 0,
      devicePixelRatio: win.devicePixelRatio && win.devicePixelRatio > 0 ? win.devicePixelRatio : 1,
    },
  };
}

/** The parts of `navigator` we read. */
export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: {
    brands: readonly { brand: string; version: string }[];
    mobile: boolean;
    platform: string;
  };
}

type Parsed = Pick<EnvironmentInfo, 'browser' | 'os' | 'deviceClass'>;

export function fromNavigator(nav: NavigatorLike): Parsed {
  const fromUa = parseUserAgent(nav.userAgent, nav.maxTouchPoints ?? 0);
  const ch = nav.userAgentData;
  if (!ch) return fromUa;
  // UA Client Hints (Chromium): low-entropy brands/platform/mobile only, never high-entropy hints.
  const brand = pickBrand(ch.brands);
  return {
    browser: brand ?? fromUa.browser,
    os: { name: normalizeOs(ch.platform) ?? fromUa.os.name },
    deviceClass: ch.mobile ? 'mobile' : fromUa.deviceClass === 'tablet' ? 'tablet' : 'desktop',
  };
}

const BRAND_NAMES: [string, string][] = [
  ['HeadlessChrome', 'HeadlessChrome'],
  ['Microsoft Edge', 'Edge'],
  ['Opera', 'Opera'],
  ['Samsung Internet', 'Samsung Internet'],
  ['Google Chrome', 'Chrome'],
  ['Brave', 'Brave'],
  ['Chromium', 'Chromium'],
];

function pickBrand(
  brands: readonly { brand: string; version: string }[],
): Parsed['browser'] | null {
  for (const [brand, name] of BRAND_NAMES) {
    const hit = brands.find((b) => b.brand === brand);
    if (hit) return { name, majorVersion: toMajor(hit.version) };
  }
  return null;
}

function normalizeOs(platform: string): string | null {
  const p = platform.toLowerCase();
  if (p === 'macos') return 'macOS';
  if (p === 'windows') return 'Windows';
  if (p === 'android') return 'Android';
  if (p === 'linux') return 'Linux';
  if (p === 'chrome os' || p === 'chromeos' || p === 'chromium os') return 'ChromeOS';
  if (p === 'ios') return 'iOS';
  return null;
}

/** Parse just enough of a UA string. Order matters: Edge and Opera also claim to be Chrome. */
export function parseUserAgent(ua: string, maxTouchPoints = 0): Parsed {
  const browser = ((): Parsed['browser'] => {
    const rules: [RegExp, string][] = [
      [/\bEdg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
      [/\bOPR\/(\d+)/, 'Opera'],
      [/\bSamsungBrowser\/(\d+)/, 'Samsung Internet'],
      [/\bFirefox\/(\d+)/, 'Firefox'],
      [/\bFxiOS\/(\d+)/, 'Firefox'],
      [/\bCriOS\/(\d+)/, 'Chrome'],
      // Automation (and many bots) run headless; worth knowing when screening data.
      [/\bHeadlessChrome\/(\d+)/, 'HeadlessChrome'],
      [/\bChrome\/(\d+)/, 'Chrome'],
      [/\bVersion\/(\d+)[\d.]*(?: Mobile\/\S+)? Safari\//, 'Safari'],
    ];
    for (const [re, name] of rules) {
      const m = re.exec(ua);
      if (m) return { name, majorVersion: toMajor(m[1]) };
    }
    return { name: 'other', majorVersion: null };
  })();

  // iPadOS 13+ Safari sends a desktop macOS UA; touch support is the only coarse tell.
  const iPadDesktopUa = /\bMacintosh\b/.test(ua) && maxTouchPoints > 1;
  let os = 'other';
  if (/\b(iPhone|iPod)\b/.test(ua)) os = 'iOS';
  else if (/\biPad\b/.test(ua) || iPadDesktopUa) os = 'iPadOS';
  else if (/\bAndroid\b/.test(ua)) os = 'Android';
  else if (/\bCrOS\b/.test(ua)) os = 'ChromeOS';
  else if (/\bWindows\b/.test(ua)) os = 'Windows';
  else if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) os = 'macOS';
  else if (/\bLinux\b/.test(ua)) os = 'Linux';

  let deviceClass: Parsed['deviceClass'] = 'desktop';
  if (os === 'iPadOS' || (os === 'Android' && !/\bMobile\b/.test(ua)) || /\bTablet\b/.test(ua)) {
    deviceClass = 'tablet';
  } else if (os === 'iOS' || /\bMobi/.test(ua)) {
    deviceClass = 'mobile';
  } else if (os === 'other') {
    deviceClass = 'unknown';
  }
  return { browser, os: { name: os }, deviceClass };
}

function toMajor(version: string | undefined): number | null {
  const n = Number.parseInt(version ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Smallest non-zero `performance.now()` step observed in a short busy loop, in ms (rounded to
 * 1 µs), or null if the clock didn't tick twice within the budget (e.g. Firefox's
 * resistFingerprinting mode, which coarsens to 100 ms).
 */
export function measureTimerResolution(
  now: () => number = () => performance.now(),
  budgetMs = 10,
): number | null {
  const start = now();
  let last = start;
  let best = Infinity;
  let ticks = 0;
  // Bounded by iterations too, so a clock that never advances can't hang the page.
  for (let i = 0; i < 1_000_000 && ticks < 50; i++) {
    const t = now();
    if (t - start > budgetMs) break;
    if (t !== last) {
      best = Math.min(best, t - last);
      last = t;
      ticks++;
    }
  }
  return ticks >= 2 && Number.isFinite(best) ? Math.round(best * 1000) / 1000 : null;
}
