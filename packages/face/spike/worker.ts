/** Spike worker. Built twice: as a classic (IIFE) worker and as a module worker. */
import { createRunner, installEgressGuard } from './runner.js';
import type { Runner, RunnerOptions } from './runner.js';

type Msg =
  | ({ type: 'init' } & RunnerOptions)
  | { type: 'frame'; frame: ImageBitmap | VideoFrame; ts: number; normalize: boolean }
  | { type: 'close' };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Msg>) => void) | null;
  postMessage(message: unknown): void;
};
const blocked: string[] = [];
let runner: Runner | null = null;
let canvas: OffscreenCanvas | null = null;

// TFLite prints informational lines on stderr (console.error). Demote them, in this scope only.
const originalError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('INFO: ')) return;
  originalError(...args);
};

scope.onmessage = (e) => {
  const msg = e.data;
  void (async () => {
    try {
      if (msg.type === 'init') {
        installEgressGuard(msg.base, blocked);
        runner = await createRunner(msg);
        scope.postMessage({
          type: 'ready',
          initMs: runner.initMs,
          offscreen: typeof OffscreenCanvas !== 'undefined',
        });
      } else if (msg.type === 'frame') {
        if (!runner) throw new Error('not initialized');
        let input: ImageBitmap | VideoFrame | OffscreenCanvas = msg.frame;
        let normalizeMs = 0;
        if (msg.normalize) {
          const t0 = performance.now();
          const w = 'displayWidth' in msg.frame ? msg.frame.displayWidth : msg.frame.width;
          const h = 'displayHeight' in msg.frame ? msg.frame.displayHeight : msg.frame.height;
          canvas ??= new OffscreenCanvas(w, h);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('no 2d context');
          ctx.drawImage(msg.frame, 0, 0, w, h);
          input = canvas;
          normalizeMs = performance.now() - t0;
        }
        const r = runner.detect(input, msg.ts);
        msg.frame.close();
        scope.postMessage({ type: 'result', ...r, normalizeMs });
      } else {
        runner?.close();
        // The metrics logger flushes on close(); give it a moment to try.
        await new Promise((resolve) => setTimeout(resolve, 500));
        scope.postMessage({ type: 'closed', blocked });
      }
    } catch (error) {
      scope.postMessage({
        type: 'error',
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  })();
};
