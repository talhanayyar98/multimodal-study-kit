/** Spike harness page. `window.runSpike(config)` runs one configuration and returns numbers. */

export interface SpikeConfig {
  mode: 'main' | 'classic' | 'module';
  delegate: 'CPU' | 'GPU';
  frame: 'bitmap' | 'videoframe';
  useModule: boolean;
  normalize: boolean;
  frames: number;
}

export interface SpikeResult {
  ok: boolean;
  error?: string;
  initMs?: number;
  inferMsP50?: number;
  inferMsP95?: number;
  normalizeMsP50?: number | undefined;
  grabMsP50?: number;
  longTasks?: number | null;
  blocked?: string[];
}

interface Pipeline {
  createRunner(o: { base: string; delegate: 'CPU' | 'GPU'; useModule: boolean }): Promise<{
    initMs: number;
    detect(frame: ImageBitmap | VideoFrame, ts: number): { faces: number; ms: number };
    close(): void;
  }>;
  installEgressGuard(base: string, blocked: string[]): void;
}

const base = new URL('/mediapipe/', location.href).href;

function source(): { canvas: HTMLCanvasElement; draw(i: number): void } {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  return {
    canvas,
    draw(i) {
      ctx.fillStyle = `hsl(${(i * 7) % 360} 40% 50%)`;
      ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(320 + 60 * Math.sin(i / 5), 240, 110, 150, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  };
}

function pct(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(((s[lo] ?? 0) + ((s[hi] ?? 0) - (s[lo] ?? 0)) * (pos - lo)) * 100) / 100;
}

async function grab(
  canvas: HTMLCanvasElement,
  kind: SpikeConfig['frame'],
  i: number,
): Promise<ImageBitmap | VideoFrame> {
  return kind === 'bitmap'
    ? createImageBitmap(canvas)
    : new VideoFrame(canvas, { timestamp: i * 33_333 });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${what} timed out`));
      }, ms);
    }),
  ]);
}

async function runSpike(cfg: SpikeConfig): Promise<SpikeResult> {
  let longTasks: number | null = null;
  try {
    const obs = new PerformanceObserver((list) => {
      longTasks = (longTasks ?? 0) + list.getEntries().length;
    });
    obs.observe({ type: 'longtask', buffered: false });
    longTasks = 0;
  } catch {
    longTasks = null; // Long Tasks API unsupported
  }

  const src = source();
  const infer: number[] = [];
  const grabs: number[] = [];
  const norms: number[] = [];
  try {
    if (cfg.mode === 'main') {
      const pipeline = (await import(
        /* @vite-ignore */ new URL('/pipeline.js', location.href).href
      )) as Pipeline;
      const blocked: string[] = [];
      const runner = await withTimeout(
        pipeline.createRunner({ base, delegate: cfg.delegate, useModule: cfg.useModule }),
        60_000,
        'init',
      );
      for (let i = 0; i < cfg.frames; i++) {
        src.draw(i);
        const t0 = performance.now();
        const frame = await grab(src.canvas, cfg.frame, i);
        grabs.push(performance.now() - t0);
        const r = runner.detect(frame, performance.now());
        frame.close();
        if (i >= 5) infer.push(r.ms);
      }
      runner.close();
      return {
        ok: true,
        initMs: Math.round(runner.initMs),
        inferMsP50: pct(infer, 0.5),
        inferMsP95: pct(infer, 0.95),
        grabMsP50: pct(grabs, 0.5),
        longTasks,
        blocked,
      };
    }

    const url = cfg.mode === 'classic' ? '/worker-classic.js' : '/worker-module.js';
    const worker = new Worker(url, cfg.mode === 'module' ? { type: 'module' } : undefined);
    const next = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<Record<string, unknown>>) => {
          if (e.data.type === 'error') reject(new Error(String(e.data.message)));
          else resolve(e.data);
        };
        worker.onerror = (e) => {
          reject(new Error(`worker error: ${e.message}`));
        };
      });
    let reply = next();
    worker.postMessage({ type: 'init', base, delegate: cfg.delegate, useModule: cfg.useModule });
    const ready = await withTimeout(reply, 60_000, 'init');
    for (let i = 0; i < cfg.frames; i++) {
      src.draw(i);
      const t0 = performance.now();
      const frame = await grab(src.canvas, cfg.frame, i);
      reply = next();
      worker.postMessage(
        { type: 'frame', frame, ts: performance.now(), normalize: cfg.normalize },
        [frame],
      );
      grabs.push(performance.now() - t0);
      const r = await withTimeout(reply, 30_000, 'frame');
      if (i >= 5) {
        infer.push(r.ms as number);
        norms.push(r.normalizeMs as number);
      }
    }
    reply = next();
    worker.postMessage({ type: 'close' });
    const closed = await withTimeout(reply, 10_000, 'close');
    worker.terminate();
    return {
      ok: true,
      initMs: Math.round(ready.initMs as number),
      inferMsP50: pct(infer, 0.5),
      inferMsP95: pct(infer, 0.95),
      normalizeMsP50: cfg.normalize ? pct(norms, 0.5) : undefined,
      grabMsP50: pct(grabs, 0.5),
      longTasks,
      blocked: closed.blocked as string[],
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    };
  }
}

/** Does requestVideoFrameCallback fire for a camera-like stream, and with which metadata? */
async function rvfcProbe(): Promise<Record<string, unknown>> {
  const src = source();
  let i = 0;
  const timer = setInterval(() => {
    src.draw(i++);
  }, 33);
  const stream = src.canvas.captureStream(30);
  const out: Record<string, unknown> = {
    supported: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
  };
  for (const placement of ['visible', 'hidden', 'detached'] as const) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    if (placement !== 'detached') {
      if (placement === 'hidden')
        Object.assign(video.style, {
          position: 'fixed',
          width: '1px',
          height: '1px',
          opacity: '0',
          pointerEvents: 'none',
        });
      document.body.append(video);
    }
    await video.play().catch(() => undefined);
    let count = 0;
    let keys: string[] = [];
    if (out.supported) {
      const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
        count++;
        keys = Object.keys(meta).length
          ? Object.keys(meta)
          : Object.keys(Object.getPrototypeOf(meta) as object);
        video.requestVideoFrameCallback(tick);
      };
      video.requestVideoFrameCallback(tick);
    }
    await new Promise((r) => setTimeout(r, 1500));
    let bitmapOk = false;
    let videoFrameOk = false;
    try {
      (await createImageBitmap(video)).close();
      bitmapOk = true;
    } catch {
      // unsupported
    }
    try {
      new VideoFrame(video).close();
      videoFrameOk = true;
    } catch {
      // unsupported
    }
    out[placement] = { callbacksIn1500ms: count, metadata: keys.sort(), bitmapOk, videoFrameOk };
    video.remove();
  }
  clearInterval(timer);
  return out;
}

Object.assign(window, { runSpike, rvfcProbe });
document.body.dataset.ready = '1';
