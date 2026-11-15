/**
 * The face sensor in real browsers (Chromium, Firefox, WebKit), with the real engine and assets
 * (prepared by test/setup-assets.ts via copy-assets) and a synthetic camera: a canvas stream.
 * There's no face in it, so these tests cover the pipeline, timing, quality, fallbacks and the
 * egress guard; face detection itself is covered by the fake-camera e2e with a recorded clip.
 */
import { createSession, MemoryStore } from '@mmstudykit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { record, schemaErrors, sleep } from '../../core/test/browser.js';
import { face } from '../src/index.js';

function syntheticCamera(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d');
  let i = 0;
  const draw = () => {
    ctx.fillStyle = `hsl(${(i++ * 5) % 360} 30% 40%)`;
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#ddd';
    ctx.fillRect(200 + (i % 50), 150, 240, 180);
  };
  draw();
  const timer = setInterval(draw, 33);
  const stream = canvas.captureStream(30);
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    clearInterval(timer);
  });
  return stream;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const notesOf = (m: { sensors: { id: string; notes?: string[] }[] }) =>
  m.sensors.find((s) => s.id === 'face')?.notes ?? [];

describe('face sensor (real engine, synthetic camera)', () => {
  it('runs in a worker, records every processed frame and 1 Hz quality, and blocks MediaPipe metrics', async () => {
    const out = await record(
      { sensors: [face({ source: syntheticCamera(), fps: 10 })] },
      { sensors: ['face'] },
      async () => {
        await sleep(2600);
      },
    );
    expect(schemaErrors(out.manifest)).toBe('');
    const sensor = out.manifest.sensors.find((s) => s.id === 'face');
    expect(sensor?.enabled, JSON.stringify(sensor?.notes)).toBe(true);
    const notes = notesOf(out.manifest);
    expect(
      notes.some((n) => n.startsWith('engine: worker, CPU delegate, model SHA-256 verified')),
    ).toBe(true);
    expect(notes).toContain(
      'egress guard blocked 1 request(s) to odml.pa.googleapis.com (MediaPipe usage metrics)',
    );
    expect(notes.some((n) => /^camera delivered \d+×\d+/.test(n))).toBe(true);

    const frames = out.streams['face.frames'] ?? [];
    expect(frames.length).toBeGreaterThanOrEqual(10);
    for (const f of frames) {
      expect(f.face).toBe('0');
      expect(Number(f.brightness)).toBeGreaterThan(0.05);
      expect(Number(f.brightness)).toBeLessThan(0.95);
      expect(Number(f.t_processed)).toBeGreaterThanOrEqual(Number(f.t));
      expect(['capture', 'presentation', 'callback']).toContain(f.timing);
    }
    // The limiter holds the rate near the target (10 fps) even though the camera delivers 30.
    const span = (Number(frames.at(-1)?.t) - Number(frames[0]?.t)) / 1000;
    expect((frames.length - 1) / span).toBeLessThan(13);

    expect((out.streams['face.quality'] ?? []).length).toBeGreaterThanOrEqual(2);
    for (const name of ['face.blendshapes', 'face.headpose', 'face.iris'])
      expect(out.streams[name]).toEqual([]);
    expect(out.manifest.quality?.face).toMatchObject({ blockedRequests: 1, facePresentRatio: 0 });
    expect(out.manifest.privacy.faceLandmarksRecorded).toBe('none');
  });

  it('falls back to the main thread when the worker cannot start, still blocking metrics', async () => {
    const out = await record(
      {
        sensors: [
          face({
            source: syntheticCamera(),
            fps: 10,
            assets: { worker: '/mmstudykit-face/missing-worker.js' },
          }),
        ],
      },
      { sensors: ['face'] },
      async () => {
        await sleep(1500);
      },
    );
    const notes = notesOf(out.manifest);
    expect(notes.some((n) => n.startsWith('worker unavailable'))).toBe(true);
    expect(notes.some((n) => n.startsWith('engine: main thread'))).toBe(true);
    expect(notes).toContain(
      'egress guard blocked 1 request(s) to odml.pa.googleapis.com (MediaPipe usage metrics)',
    );
    expect((out.streams['face.frames'] ?? []).length).toBeGreaterThan(3);
  });

  it('records landmarks only with the opt-in, and says so in the manifest', async () => {
    const out = await record(
      { sensors: [face({ source: syntheticCamera(), landmarks: 'iris', features: ['headPose'] })] },
      { sensors: ['face'], options: ['face.landmarks'] },
      async () => {
        await sleep(800);
      },
    );
    expect(out.manifest.consent.options).toEqual({ 'face.landmarks': 'granted' });
    expect(out.manifest.privacy.faceLandmarksRecorded).toBe('subset');
    expect(out.manifest.streams.map((s) => s.name)).toEqual([
      'session.events',
      'task.markers',
      'face.frames',
      'face.headpose',
      'face.landmarks',
      'face.quality',
    ]);
  });

  it('releases the camera while paused and reopens it on resume', async () => {
    const streams: MediaStream[] = [];
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(() => {
      const s = syntheticCamera();
      streams.push(s);
      return Promise.resolve(s);
    });
    const session = await createSession({
      studyId: 'face-pause',
      participantId: 'P1',
      storage: new MemoryStore(),
      sensors: [face({ fps: 10 })],
      resume: false,
    });
    await session.consent({ textVersion: 'v1', granted: ['face'] });
    const started = await session.start();
    expect(started.started).toEqual(['face']);
    expect(streams).toHaveLength(1);
    session.pause();
    expect(streams[0]?.getVideoTracks()[0]?.readyState).toBe('ended');
    session.resume();
    await sleep(300);
    expect(streams).toHaveLength(2);
    expect(streams[1]?.getVideoTracks()[0]?.readyState).toBe('live');
    await session.end();
    expect(streams[1]?.getVideoTracks()[0]?.readyState).toBe('ended');
  });

  it('fails to start with a clear reason when camera permission is denied (session continues)', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(
      new DOMException('denied', 'NotAllowedError'),
    );
    const session = await createSession({
      studyId: 'face-denied',
      participantId: 'P1',
      storage: new MemoryStore(),
      sensors: [face()],
      resume: false,
    });
    await session.consent({ textVersion: 'v1', granted: ['face'] });
    const started = await session.start();
    expect(started.failed).toEqual([{ sensorId: 'face', error: 'camera permission denied' }]);
    const { manifest } = await session.end();
    expect(manifest.sensors[0]).toMatchObject({
      id: 'face',
      enabled: false,
      notes: ['start failed: camera permission denied'],
    });
  });
});
