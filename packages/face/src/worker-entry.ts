/**
 * Entry of `mmsk-face-worker.js` (classic worker, bundled by scripts/build-assets.mjs).
 *
 * The worker spike (docs/face-worker.md) found MediaPipe 1.2.3 runs in classic and module
 * workers in Chromium, Firefox and WebKit; module workers additionally need the `_module_` wasm
 * loader. Classic + the standard loader is the simplest combination that works everywhere.
 */
import { guardWorkerScope } from './egress.js';
import { Engine } from './engine.js';
import type { FromEngine, ToEngine } from './protocol.js';

interface WorkerScope {
  onmessage: ((e: MessageEvent<ToEngine>) => void) | null;
  postMessage(message: FromEngine): void;
}
const scope = globalThis as unknown as WorkerScope;
const blocked: string[] = [];
let engine: Engine | null = null;
let starting: Promise<unknown> | null = null;
let closed = false;
let queue: Promise<void> = Promise.resolve();

// TFLite prints informational lines ("INFO: Created TensorFlow Lite XNNPACK delegate…") on
// stderr, which becomes console.error. Demote exactly those, in this worker's scope only.
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  // "INFO: …" from TFLite and glog info/warning lines ("W1115 13:29:57.822 …"); errors pass.
  if (typeof args[0] === 'string' && /^(INFO: |[IW]\d{4} \d{2}:\d{2}:\d{2})/.test(args[0])) return;
  consoleError(...args);
};

const post = (m: FromEngine) => {
  scope.postMessage(m);
};
const note = (text: string) => {
  post({ type: 'note', text });
};

// One serial queue: never two MediaPipe calls at once, never close() during a detect.
scope.onmessage = (e) => {
  const msg = e.data;
  queue = queue
    .then(() => handle(msg))
    .catch((error: unknown) => {
      post({
        type: 'fatal',
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    });
};

async function handle(msg: ToEngine): Promise<void> {
  if (msg.type === 'init') {
    if (starting || closed) return;
    const { assets } = msg.init;
    guardWorkerScope([assets.model, assets.wasmBinary, assets.wasmLoader], blocked);
    starting = Engine.create(msg.init, note);
    const { engine: e, ready } = (await starting) as Awaited<ReturnType<typeof Engine.create>>;
    engine = e;
    post({ type: 'ready', ready });
  } else if (msg.type === 'frame') {
    if (!engine || closed) {
      msg.frame.close();
      return;
    }
    post({ type: 'result', result: await engine.process(msg.frame, msg.id, msg.t) });
  } else {
    closed = true;
    engine?.close();
    engine = null;
    // The metrics logger flushes on close(); let that (blocked) attempt happen before reporting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    post({ type: 'closed', blocked: [...blocked] });
  }
}
