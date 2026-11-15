/**
 * Network egress guards for the face engine.
 *
 * MediaPipe Tasks ≥ 1.0 POSTs usage metrics to Google (odml.pa.googleapis.com) every 60 s and on
 * close(), with no opt-out. It uses the global `fetch` and stops after the first failure. Each
 * guard records what it refused, and the sensor reports that in the manifest.
 */

/** Hosts the main-thread guard refuses. */
export const BLOCKED_HOSTS: readonly string[] = ['odml.pa.googleapis.com'];

function urlOf(input: RequestInfo | URL, base: string): URL | null {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(raw, base);
  } catch {
    return null;
  }
}

function describe(url: URL | null): string {
  return url ? `${url.origin}${url.pathname}` : 'unparseable URL';
}

/**
 * Worker scope: allow only the listed URLs (the model and wasm binary); refuse every other
 * `fetch`, and disable XMLHttpRequest, WebSocket and EventSource. `importScripts` is limited to
 * the listed scripts (the wasm loader). The worker is ours, so an allowlist is safe here.
 */
export function guardWorkerScope(allowed: readonly string[], blocked: string[]): void {
  const scope = globalThis as unknown as Record<string, unknown> & {
    fetch: typeof fetch;
    location: { href: string };
  };
  const allow = new Set(allowed.map((u) => new URL(u).href.split('#')[0]));
  const realFetch = scope.fetch.bind(globalThis);
  scope.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input, scope.location.href);
    if (!url || !allow.has(url.href.split('#')[0] ?? '')) {
      blocked.push(describe(url));
      return Promise.reject(new TypeError('blocked by @mmstudykit/face egress guard'));
    }
    return realFetch(input, init);
  };
  for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource']) {
    if (name in scope) {
      scope[name] = function Blocked() {
        blocked.push(name);
        throw new TypeError(`${name} is disabled in the face worker`);
      };
    }
  }
  const realImport = scope.importScripts as ((...urls: string[]) => void) | undefined;
  if (typeof realImport === 'function') {
    scope.importScripts = (...urls: string[]) => {
      for (const u of urls) {
        const url = urlOf(u, scope.location.href);
        if (!url || !allow.has(url.href)) {
          blocked.push(describe(url));
          throw new TypeError('importScripts blocked by @mmstudykit/face egress guard');
        }
      }
      realImport.apply(globalThis, urls);
    };
  }
}

export interface MainGuard {
  readonly blocked: string[];
  /** Stop refusing (restores the original fetch if nobody wrapped it since). */
  release(): void;
}

/**
 * Main thread (fallback only): refuse requests to {@link BLOCKED_HOSTS} and pass everything else
 * through untouched. The host page's own requests are not our business, so this is a denylist.
 * Prefer a CSP `connect-src` as well; see docs/face.md.
 */
export function guardMainThread(hosts: readonly string[] = BLOCKED_HOSTS): MainGuard {
  const g = globalThis as unknown as { fetch: typeof fetch; location?: { href: string } };
  const original = g.fetch;
  const blocked: string[] = [];
  let active = true;
  const wrapped: typeof fetch = (input, init) => {
    if (active) {
      const url = urlOf(input, g.location?.href ?? 'http://localhost/');
      if (url && hosts.includes(url.hostname)) {
        blocked.push(describe(url));
        return Promise.reject(new TypeError('blocked by @mmstudykit/face egress guard'));
      }
    }
    return original.call(globalThis, input, init);
  };
  g.fetch = wrapped;
  return {
    blocked,
    release() {
      active = false;
      if (g.fetch === wrapped) g.fetch = original;
    },
  };
}
