/** Where the engine runs: a classic worker (default) or the main thread (fallback). */
import { guardMainThread } from './egress.js';
import type { Engine } from './engine.js';
import type { EngineInit, EngineReady, FrameResult, FromEngine, ToEngine } from './protocol.js';

export interface Backend {
  readonly kind: 'worker' | 'main';
  readonly ready: EngineReady;
  /** Process one frame (the bitmap is transferred/closed). */
  process(frame: ImageBitmap, id: number, t: number): Promise<FrameResult>;
  /** Close the engine; resolves with the requests the egress guard refused. */
  close(): Promise<string[]>;
}

export interface BackendHooks {
  note(text: string): void;
  /** The engine failed after init (twice in a row, or the worker died). */
  fatal(message: string): void;
}

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${ms} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export async function startWorkerBackend(
  init: EngineInit,
  hooks: BackendHooks,
  initTimeoutMs: number,
): Promise<Backend> {
  // Classic worker. Same-origin is required by the Worker constructor.
  const worker = new Worker(init.assets.worker);
  const pending = new Map<number, (r: FrameResult) => void>();
  let onReady: ((r: EngineReady) => void) | null = null;
  let onInitError: ((e: Error) => void) | null = null;
  let onClosed: ((blocked: string[]) => void) | null = null;
  let dead = false;

  const die = (message: string) => {
    if (dead) return;
    dead = true;
    if (onInitError) onInitError(new Error(message));
    else hooks.fatal(message);
    for (const resolve of pending.values()) resolve(failed());
    pending.clear();
  };
  worker.onmessage = (e: MessageEvent<FromEngine>) => {
    const m = e.data;
    if (m.type === 'ready') onReady?.(m.ready);
    else if (m.type === 'result') {
      pending.get(m.result.id)?.(m.result);
      pending.delete(m.result.id);
    } else if (m.type === 'note') hooks.note(m.text);
    else if (m.type === 'fatal') die(m.message);
    else onClosed?.(m.blocked);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    die(`worker error: ${e.message || 'script failed to load'}`);
  };
  const post = (m: ToEngine, transfer: Transferable[] = []) => {
    worker.postMessage(m, transfer);
  };

  let ready: EngineReady;
  try {
    ready = await timeout(
      new Promise<EngineReady>((resolve, reject) => {
        onReady = resolve;
        onInitError = reject;
        post({ type: 'init', init });
      }),
      initTimeoutMs,
      'face engine init (worker)',
    );
  } catch (error) {
    worker.terminate();
    throw error;
  } finally {
    onInitError = null;
  }

  return {
    kind: 'worker',
    ready,
    process(frame, id, t) {
      if (dead) {
        frame.close();
        return Promise.resolve(failed(id));
      }
      return new Promise((resolve) => {
        pending.set(id, resolve);
        post({ type: 'frame', id, t, frame }, [frame]);
      });
    },
    async close() {
      if (dead) {
        worker.terminate();
        return [];
      }
      try {
        return await timeout(
          new Promise<string[]>((resolve) => {
            onClosed = resolve;
            post({ type: 'close' });
          }),
          3000,
          'face engine close',
        );
      } catch {
        return [];
      } finally {
        worker.terminate();
      }
    },
  };
}

export async function startMainBackend(
  init: EngineInit,
  hooks: BackendHooks,
  initTimeoutMs: number,
): Promise<Backend> {
  // Deny only MediaPipe's metrics host; the page's other requests are untouched.
  const guard = guardMainThread();
  let engine: Engine;
  let ready: EngineReady;
  try {
    const mod = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ init.assets.engine
    )) as { Engine: typeof Engine };
    const created = await timeout(
      mod.Engine.create(init, (text) => {
        hooks.note(text);
      }),
      initTimeoutMs,
      'face engine init (main thread)',
    );
    engine = created.engine;
    ready = created.ready;
  } catch (error) {
    guard.release();
    throw error;
  }
  let queue: Promise<unknown> = Promise.resolve();
  let failedTwice = false;
  return {
    kind: 'main',
    ready,
    process(frame, id, t) {
      const run = queue.then(async () => {
        if (failedTwice) {
          frame.close();
          return failed(id);
        }
        try {
          return await engine.process(frame, id, t);
        } catch (error) {
          failedTwice = true;
          hooks.fatal(error instanceof Error ? error.message : String(error));
          return failed(id);
        }
      });
      queue = run;
      return run;
    },
    async close() {
      await queue;
      engine.close();
      // The metrics logger flushes synchronously on close(); the guard has seen it by now.
      guard.release();
      return [...guard.blocked];
    },
  };
}

function failed(id = -1): FrameResult {
  return {
    id,
    face: false,
    inferenceMs: 0,
    brightness: 0,
    blendshapes: null,
    headPose: null,
    iris: null,
    landmarks: null,
    failed: true,
  };
}
