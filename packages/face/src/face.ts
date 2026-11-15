import type { Sensor, SensorContext } from '@mmstudykit/core';

import { MEDIAPIPE_VERSION, MODEL, resolveAssets } from './assets.js';
import { startMainBackend, startWorkerBackend } from './backend.js';
import type { Backend } from './backend.js';
import { formatOf, openCamera } from './camera.js';
import type { CameraFormat } from './camera.js';
import { BLENDSHAPE_NAMES, blendshapeColumn } from './extract.js';
import {
  describeFace,
  faceStreams,
  IRIS_COLUMNS,
  landmarkOptionText,
  resolveOptions,
} from './options.js';
import type { FaceOptions, TimingSource } from './options.js';
import type { EngineInit, FrameResult } from './protocol.js';
import { QualityTracker, shouldProcess } from './quality.js';
import { FACE_PACKAGE, FACE_VERSION } from './version.js';

export interface FaceSensor extends Sensor {
  /** The camera stream while running (e.g. for a mirrored preview), or null. */
  readonly stream: MediaStream | null;
}

const BLENDSHAPE_COLUMNS = BLENDSHAPE_NAMES.map(blendshapeColumn);
const IRIS_NAMES = IRIS_COLUMNS.map((c) => c.name);
const HEADPOSE_NAMES = ['yaw', 'pitch', 'roll', 'tx', 'ty', 'tz'] as const;

/**
 * Webcam face sensor (MediaPipe Face Landmarker). Frames are analysed on the participant's
 * device, in a worker; only numbers leave the engine, and the sample guard in core rejects
 * anything that isn't a number anyway. Video is never stored or transmitted.
 *
 * Streams: `face.frames` (one row per processed frame, with or without a face), `face.blendshapes`,
 * `face.headpose`, `face.iris` (rows only for frames with a face), opt-in `face.landmarks`, and
 * `face.quality` (1 Hz). Join on `t`.
 *
 * Needs the self-hosted assets: `npx mmstudykit-face copy-assets public/mmstudykit-face`.
 */
export function face(options: FaceOptions = {}): FaceSensor {
  const r = resolveOptions(options);
  let ctx: SensorContext | null = null;
  let backend: Backend | null = null;
  let stream: MediaStream | null = null;
  let ownsStream = false;
  let video: HTMLVideoElement | null = null;
  let loopStop: (() => void) | null = null;
  let qualityTimer: ReturnType<typeof setInterval> | undefined;
  let quality = new QualityTracker(0);
  let lastProcessed: number | null = null;
  let inFlight = false;
  let frameId = 0;
  let landmarkCounter = 0;
  let withLandmarks = false;
  let failed = false;
  let blocked: string[] = [];
  let cameraFormat: CameraFormat | null = null;
  let suspicionNoted = false;

  const note = (text: string) => ctx?.note(text);

  const emitResult = (res: FrameResult, t: number, timing: TimingSource) => {
    const c = ctx;
    if (!c || res.failed) return;
    const tProcessed = c.clock.now();
    quality.result(res.face, res.brightness, res.inferenceMs, tProcessed - t, timing);
    c.emit('face.frames', {
      t,
      t_processed: tProcessed,
      face: res.face,
      inference_ms: res.inferenceMs,
      brightness: res.brightness,
      timing,
    });
    if (!res.face) return;
    if (res.blendshapes) {
      const row: Record<string, unknown> = { t };
      res.blendshapes.forEach((v, i) => {
        const col = BLENDSHAPE_COLUMNS[i];
        if (col) row[col] = v;
      });
      c.emit('face.blendshapes', row);
    }
    if (res.headPose) {
      const row: Record<string, unknown> = { t };
      HEADPOSE_NAMES.forEach((n, i) => (row[n] = res.headPose?.[i] ?? null));
      c.emit('face.headpose', row);
    }
    if (res.iris) {
      const row: Record<string, unknown> = { t };
      IRIS_NAMES.forEach((n, i) => (row[n] = res.iris?.[i] ?? null));
      c.emit('face.iris', row);
    }
    if (withLandmarks && res.landmarks && r.landmarks) {
      if (landmarkCounter++ % r.landmarksEvery === 0) {
        const row: Record<string, unknown> = { t };
        const indices = r.landmarks.indices;
        indices.forEach((idx, k) => {
          row[`lm_${idx}_x`] = res.landmarks?.[3 * k] ?? null;
          row[`lm_${idx}_y`] = res.landmarks?.[3 * k + 1] ?? null;
          row[`lm_${idx}_z`] = res.landmarks?.[3 * k + 2] ?? null;
        });
        c.emit('face.landmarks', row);
      }
    }
  };

  const onFrame = (perfTs: number, timing: TimingSource) => {
    const c = ctx;
    const b = backend;
    const v = video;
    if (!c || !b || !v || failed) return;
    quality.delivered();
    if (!shouldProcess(perfTs, lastProcessed, r.fps)) {
      quality.skipped();
      return;
    }
    if (inFlight) {
      quality.dropped();
      return;
    }
    lastProcessed = perfTs;
    inFlight = true;
    const t = c.clock.fromPerf(perfTs);
    const id = frameId++;
    createImageBitmap(v)
      .then((bitmap) => b.process(bitmap, id, t))
      .then((res) => {
        emitResult(res, t, timing);
      })
      .catch((error: unknown) => {
        note(`frame grab failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  /** rVFC loop with timestamps from frame metadata; rAF + currentTime polling where missing. */
  const startLoop = (v: HTMLVideoElement): (() => void) => {
    let stopped = false;
    // Typed as always present, but missing in Firefox < 132 and Safari < 15.4.
    if (
      typeof (v as Partial<Pick<HTMLVideoElement, 'requestVideoFrameCallback'>>)
        .requestVideoFrameCallback === 'function'
    ) {
      const tick = (now: number, meta: VideoFrameCallbackMetadata) => {
        if (stopped) return;
        let ts = now;
        let timing: TimingSource = 'callback';
        if (
          meta.captureTime !== undefined &&
          meta.captureTime <= now + 1 &&
          meta.captureTime > now - 1000
        ) {
          ts = meta.captureTime;
          timing = 'capture';
        } else if (meta.presentationTime) {
          ts = meta.presentationTime;
          timing = 'presentation';
          if (meta.captureTime !== undefined && !suspicionNoted) {
            suspicionNoted = true;
            note('rVFC captureTime looked implausible; using presentationTime');
          }
        }
        onFrame(ts, timing);
        v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    } else {
      note('requestVideoFrameCallback unavailable: frames detected by rAF polling (timing = raf)');
      let lastTime = -1;
      const poll = (ts: number) => {
        if (stopped) return;
        if (v.currentTime !== lastTime && v.readyState >= 2) {
          lastTime = v.currentTime;
          onFrame(ts, 'raf');
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }
    return () => {
      stopped = true;
    };
  };

  const acquire = async (): Promise<void> => {
    if (r.source) {
      stream = typeof r.source === 'function' ? await r.source() : r.source;
      ownsStream = false;
    } else {
      stream = await openCamera(r.camera);
      ownsStream = true;
    }
    const v = (video ??= document.createElement('video'));
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    await v.play();
    const fmt = formatOf(stream);
    if (!cameraFormat) {
      cameraFormat = fmt;
      note(
        `camera delivered ${fmt.width ?? '?'}×${fmt.height ?? '?'} at ${fmt.frameRate ?? '?'} fps`,
      );
    }
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      note('camera track ended (unplugged or permission revoked)');
    });
    loopStop = startLoop(v);
  };

  const release = () => {
    loopStop?.();
    loopStop = null;
    if (ownsStream) for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    if (video) video.srcObject = null;
  };

  const emitQuality = () => {
    const c = ctx;
    if (!c) return;
    const t = c.clock.now();
    const row = { t, ...quality.takeWindow(t) };
    c.emit('face.quality', row);
    c.reportQuality(row);
  };

  return {
    id: 'face',
    package: FACE_PACKAGE,
    version: FACE_VERSION,
    get stream() {
      return stream;
    },
    options: r.landmarks
      ? [{ id: 'landmarks', title: 'Face shape points', description: landmarkOptionText(r) }]
      : [],
    config: () => ({
      features: [...r.features],
      fps: r.fps,
      backend: r.backend,
      delegate: r.delegate,
      landmarks: r.landmarks
        ? {
            subset: r.landmarks.name,
            points: r.landmarks.indices.length,
            every: r.landmarksEvery,
            precision: r.landmarksPrecision,
          }
        : false,
      camera: r.camera,
      normalizeFrames: r.normalizeFrames,
      mediapipe: MEDIAPIPE_VERSION,
      model: { file: 'face_landmarker.task (float16/1)', sha256: MODEL.sha256 },
    }),
    streams: (granted) => faceStreams(r, granted),
    describe: () => describeFace(r),
    privacy: (granted) => ({
      faceLandmarksRecorded:
        r.landmarks && granted.has('landmarks')
          ? r.landmarks.name === 'full'
            ? 'full'
            : 'subset'
          : 'none',
    }),

    async start(context) {
      ctx = context;
      withLandmarks = r.landmarks !== null && context.granted.has('landmarks');
      quality = new QualityTracker(context.clock.now());
      failed = false;
      blocked = [];
      // Camera first: the permission prompt is what the participant sees right after consenting.
      await acquire();
      const init: EngineInit = {
        assets: resolveAssets(r.assets, document.baseURI),
        delegate: r.delegate,
        blendshapes: r.features.has('blendshapes'),
        headPose: r.features.has('headPose'),
        iris: r.features.has('iris'),
        landmarks: withLandmarks && r.landmarks ? r.landmarks.indices : null,
        normalize: r.normalizeFrames,
      };
      const hooks = {
        note,
        fatal: (message: string) => {
          failed = true;
          note(`face pipeline stopped: ${message}`);
          context.reportQuality({ error: message });
        },
      };
      const canWorker = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
      try {
        if (r.backend === 'worker' || (r.backend === 'auto' && canWorker)) {
          try {
            backend = await startWorkerBackend(init, hooks, r.initTimeoutMs);
          } catch (error) {
            if (r.backend === 'worker') throw error;
            note(
              `worker unavailable (${error instanceof Error ? error.message : String(error)}); running on the main thread`,
            );
            backend = await startMainBackend(init, hooks, r.initTimeoutMs);
          }
        } else {
          backend = await startMainBackend(init, hooks, r.initTimeoutMs);
        }
      } catch (error) {
        release();
        throw error;
      }
      const ready = backend.ready;
      note(
        `engine: ${backend.kind === 'worker' ? 'worker' : 'main thread'}, ${ready.delegate} delegate, ` +
          `model ${ready.modelVerified === true ? 'SHA-256 verified' : 'not verified (no WebCrypto)'}, init ${Math.round(ready.initMs)} ms`,
      );
      quality.restart(context.clock.now());
      qualityTimer = setInterval(emitQuality, 1000);
    },

    pause() {
      // Release the camera while paused: the camera light goes off, nothing is analysed.
      release();
      lastProcessed = null;
    },

    resume() {
      if (!ctx) return;
      quality.restart(ctx.clock.now());
      acquire().catch((error: unknown) => {
        note(
          `camera could not be reopened after pause: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },

    async stop() {
      if (qualityTimer !== undefined) clearInterval(qualityTimer);
      qualityTimer = undefined;
      release();
      // Let a frame in flight finish so its rows are recorded.
      for (let i = 0; i < 50 && inFlight; i++) await new Promise((r) => setTimeout(r, 10));
      if (ctx) emitQuality();
      if (backend) {
        blocked = await backend.close();
        backend = null;
      }
      if (blocked.length) {
        const hosts = [...new Set(blocked.map((b) => b.replace(/^https?:\/\//, '').split('/')[0]))];
        note(
          `egress guard blocked ${blocked.length} request(s) to ${hosts.join(', ')} (MediaPipe usage metrics)`,
        );
      }
      video?.remove();
      video = null;
      ctx = null;
    },

    summary: () => ({
      ...quality.summary(),
      camera: cameraFormat,
      blockedRequests: blocked.length,
    }),
  };
}
