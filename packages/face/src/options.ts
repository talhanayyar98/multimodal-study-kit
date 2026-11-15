import type { ColumnSpec, SensorDisclosure, StreamSpec } from '@mmstudykit/core';

import type { FaceAssets } from './assets.js';
import { BLENDSHAPE_NAMES, blendshapeColumn, LANDMARK_SUBSETS, MESH_SIZE } from './extract.js';
import type { Delegate } from './protocol.js';

export type FaceFeature = 'blendshapes' | 'headPose' | 'iris';
export type LandmarkSubset = 'iris' | 'eyes' | 'full';

export interface FaceOptions {
  /** Features to record. Default all three: `['blendshapes', 'headPose', 'iris']`. */
  features?: readonly FaceFeature[];
  /** Frames processed per second (the camera may deliver more; extra frames are skipped). Default 15. */
  fps?: number;
  /** Where the self-hosted assets are (see `mmstudykit-face copy-assets`). Default `/mmstudykit-face/`. */
  assets?: string | FaceAssets;
  /** `auto` (default): worker, falling back to the main thread. */
  backend?: 'auto' | 'worker' | 'main';
  /** MediaPipe delegate. Default `CPU` (see docs/face-worker.md); GPU falls back to CPU if it fails. */
  delegate?: Delegate;
  /**
   * Opt-in: also record face mesh landmarks (`face.landmarks`), only if the participant grants
   * `face.landmarks`. Landmarks are close to biometric data: prefer a subset and a low rate.
   * `iris` = 10 points, `eyes` = 18 (iris + eye corners and lids), `full` = all 478, or explicit
   * mesh indices.
   */
  landmarks?: false | LandmarkSubset | readonly number[];
  /** Record landmarks on every Nth processed frame. Default 1. */
  landmarksEvery?: number;
  /** Decimal places for landmark coordinates. Default 4. */
  landmarksPrecision?: number;
  /** Requested camera format. Defaults 640×480 at 30 fps. The delivered format is recorded. */
  camera?: { width?: number; height?: number; frameRate?: number };
  /** Draw frames through a 2D canvas before inference (robust to exotic camera formats). Default true. */
  normalizeFrames?: boolean;
  /** How long the engine may take to load (assets ~15 MB on first visit), ms. Default 60,000. */
  initTimeoutMs?: number;
  /**
   * Advanced/testing: use this stream instead of opening the camera. The sensor doesn't stop
   * tracks it didn't open.
   */
  source?: MediaStream | (() => Promise<MediaStream>);
}

export interface Resolved {
  features: ReadonlySet<FaceFeature>;
  fps: number;
  assets: string | FaceAssets | undefined;
  backend: 'auto' | 'worker' | 'main';
  delegate: Delegate;
  landmarks: { name: LandmarkSubset | 'custom'; indices: readonly number[] } | null;
  landmarksEvery: number;
  landmarksPrecision: number;
  camera: { width: number; height: number; frameRate: number };
  normalizeFrames: boolean;
  initTimeoutMs: number;
  source: FaceOptions['source'];
}

const FEATURES: readonly FaceFeature[] = ['blendshapes', 'headPose', 'iris'];

export function resolveOptions(o: FaceOptions): Resolved {
  const features = new Set(o.features ?? FEATURES);
  for (const f of features) {
    if (!FEATURES.includes(f))
      throw new TypeError(`face: unknown feature "${f}" (have: ${FEATURES.join(', ')})`);
  }
  const fps = o.fps ?? 15;
  if (!(fps > 0 && fps <= 60)) throw new TypeError('face: fps must be in (0, 60]');
  let landmarks: Resolved['landmarks'] = null;
  if (o.landmarks) {
    if (o.landmarks === 'full')
      landmarks = { name: 'full', indices: Array.from({ length: MESH_SIZE }, (_, i) => i) };
    else if (o.landmarks === 'iris' || o.landmarks === 'eyes')
      landmarks = { name: o.landmarks, indices: LANDMARK_SUBSETS[o.landmarks] };
    else if (Array.isArray(o.landmarks)) {
      const indices = [...new Set(o.landmarks as readonly number[])].sort((a, b) => a - b);
      if (!indices.length || indices.some((i) => !Number.isInteger(i) || i < 0 || i >= MESH_SIZE)) {
        throw new TypeError(`face: landmark indices must be integers in [0, ${MESH_SIZE - 1}]`);
      }
      landmarks = { name: indices.length === MESH_SIZE ? 'full' : 'custom', indices };
    } else {
      throw new TypeError(
        'face: landmarks must be false, "iris", "eyes", "full" or an array of indices',
      );
    }
  }
  const every = o.landmarksEvery ?? 1;
  if (!(Number.isInteger(every) && every >= 1))
    throw new TypeError('face: landmarksEvery must be a positive integer');
  const precision = o.landmarksPrecision ?? 4;
  if (!(Number.isInteger(precision) && precision >= 0 && precision <= 8))
    throw new TypeError('face: landmarksPrecision must be 0–8');
  return {
    features,
    fps,
    assets: o.assets,
    backend: o.backend ?? 'auto',
    delegate: o.delegate ?? 'CPU',
    landmarks,
    landmarksEvery: every,
    landmarksPrecision: precision,
    camera: {
      width: o.camera?.width ?? 640,
      height: o.camera?.height ?? 480,
      frameRate: o.camera?.frameRate ?? 30,
    },
    normalizeFrames: o.normalizeFrames ?? true,
    initTimeoutMs: o.initTimeoutMs ?? 60_000,
    source: o.source,
  };
}

const num = (
  name: string,
  unit: string | null,
  description: string,
  precision: number,
): ColumnSpec => ({
  name,
  type: 'number',
  unit,
  description,
  precision,
});

export const TIMING_SOURCES = ['capture', 'presentation', 'callback', 'raf'] as const;
export type TimingSource = (typeof TIMING_SOURCES)[number];

export const IRIS_COLUMNS: readonly ColumnSpec[] = (['right', 'left'] as const).flatMap((side) => [
  num(
    `${side}_iris_x`,
    '1',
    `Subject's ${side} iris centre, x in normalized image coordinates (0–1, unmirrored).`,
    4,
  ),
  num(
    `${side}_iris_y`,
    '1',
    `Subject's ${side} iris centre, y in normalized image coordinates (0–1, down).`,
    4,
  ),
  num(
    `${side}_iris_h`,
    '1',
    `${side} iris along the outer→inner eye-corner axis, in eye widths (0 outer, 1 inner).`,
    4,
  ),
  num(
    `${side}_iris_v`,
    '1',
    `${side} iris offset from the corner axis, in eye widths, positive towards the lower lid.`,
    4,
  ),
  num(`${side}_openness`, '1', `${side} lid distance / eye width (~0 closed).`, 4),
]);

export const QUALITY_COLUMNS: readonly ColumnSpec[] = [
  num('effective_fps', 'Hz', 'Frames processed in the last second.', 2),
  {
    name: 'frames_delivered',
    type: 'integer',
    unit: null,
    description: 'Camera frames seen (requestVideoFrameCallback).',
  },
  {
    name: 'frames_skipped',
    type: 'integer',
    unit: null,
    description: 'Frames skipped by the fps limiter (by design).',
  },
  {
    name: 'frames_dropped',
    type: 'integer',
    unit: null,
    description: 'Frames dropped because the engine was still busy.',
  },
  num('face_present_ratio', '1', 'Share of processed frames with a face.', 3),
  num('brightness', '1', 'Mean frame luma (0–1).', 3),
  num('inference_ms_p50', 'ms', 'Median inference time.', 2),
  num('inference_ms_p95', 'ms', '95th percentile inference time.', 2),
  num(
    'latency_ms_p50',
    'ms',
    'Median frame time → result on the main thread (t_processed − t).',
    2,
  ),
];

export function landmarkColumns(indices: readonly number[], precision: number): ColumnSpec[] {
  return indices.flatMap((i) => [
    num(`lm_${i}_x`, '1', `Mesh point ${i}, x (normalized image coordinates).`, precision),
    num(`lm_${i}_y`, '1', `Mesh point ${i}, y (normalized image coordinates).`, precision),
    num(
      `lm_${i}_z`,
      '1',
      `Mesh point ${i}, relative depth (MediaPipe units, roughly x scale).`,
      precision,
    ),
  ]);
}

/** Stream declarations for a configuration. The landmarks stream exists only if granted. */
export function faceStreams(r: Resolved, granted: ReadonlySet<string>): StreamSpec[] {
  const frameTiming =
    'requestVideoFrameCallback: captureTime, else presentationTime, else callback time (per row: timing)';
  const streams: StreamSpec[] = [
    {
      name: 'face.frames',
      kind: 'samples',
      format: 'csv',
      nominalRateHz: r.fps,
      timestampSource: frameTiming,
      columns: [
        num('t_processed', 'ms', 'Session time the result arrived on the main thread.', 3),
        {
          name: 'face',
          type: 'boolean',
          unit: null,
          description: '1 if a face was found in this frame.',
        },
        num('inference_ms', 'ms', 'Time inside FaceLandmarker.detectForVideo.', 2),
        num('brightness', '1', 'Mean frame luma (0–1). Low values explain poor detection.', 3),
        {
          name: 'timing',
          type: 'enum',
          unit: null,
          description:
            'Which timestamp t is: camera capture time, frame presentation time, the rVFC callback time, or rAF (no rVFC).',
          enumValues: TIMING_SOURCES,
        },
      ],
    },
  ];
  if (r.features.has('blendshapes')) {
    streams.push({
      name: 'face.blendshapes',
      kind: 'samples',
      format: 'csv',
      nominalRateHz: r.fps,
      timestampSource: frameTiming,
      columns: BLENDSHAPE_NAMES.map((n) =>
        num(
          blendshapeColumn(n),
          '1',
          `FaceLandmarker blendshape "${n}" (0–1; subject's left/right).`,
          4,
        ),
      ),
    });
  }
  if (r.features.has('headPose')) {
    streams.push({
      name: 'face.headpose',
      kind: 'samples',
      format: 'csv',
      nominalRateHz: r.fps,
      timestampSource: frameTiming,
      columns: [
        num(
          'yaw',
          'deg',
          'Rotation about the face vertical axis (R = Ry·Rx·Rz; signs in docs/face.md).',
          2,
        ),
        num('pitch', 'deg', 'Rotation about the horizontal axis.', 2),
        num('roll', 'deg', 'Rotation about the depth axis.', 2),
        num('tx', 'cm', 'Face model translation x, camera space (approximate).', 2),
        num('ty', 'cm', 'Face model translation y, camera space (approximate).', 2),
        num(
          'tz',
          'cm',
          'Face model translation z, camera space (approximate; negative = in front of camera).',
          2,
        ),
      ],
    });
  }
  if (r.features.has('iris')) {
    streams.push({
      name: 'face.iris',
      kind: 'samples',
      format: 'csv',
      nominalRateHz: r.fps,
      timestampSource: frameTiming,
      columns: IRIS_COLUMNS,
    });
  }
  if (r.landmarks && granted.has('landmarks')) {
    streams.push({
      name: 'face.landmarks',
      kind: 'samples',
      format: 'csv',
      nominalRateHz: r.fps / r.landmarksEvery,
      timestampSource: frameTiming,
      columns: landmarkColumns(r.landmarks.indices, r.landmarksPrecision),
    });
  }
  streams.push({
    name: 'face.quality',
    kind: 'samples',
    format: 'csv',
    nominalRateHz: 1,
    timestampSource: 'performance.now',
    columns: QUALITY_COLUMNS,
  });
  return streams;
}

export function describeFace(r: Resolved): Omit<SensorDisclosure, 'sensorId' | 'options'> {
  const perSecond = r.fps === 1 ? 'once per second' : `${r.fps} times per second`;
  const records = ['whether a face is visible, and how bright the image is'];
  if (r.features.has('headPose')) records.push('the orientation and position of your head');
  if (r.features.has('blendshapes'))
    records.push('52 facial-movement scores, such as how much you smile or blink');
  if (r.features.has('iris'))
    records.push('how open your eyes are and where your irises are within your eyes');
  return {
    title: 'Webcam (face features)',
    summary: `Your camera image is analysed on your device, ${perSecond}. The video is never saved or sent anywhere.`,
    records,
    neverRecords: [
      'your camera image or video, in any form',
      r.landmarks
        ? 'a map of your face, unless you agree to the option below'
        : 'a map of your face (face mesh)',
      'which camera you use',
    ],
    rateHz: r.fps,
  };
}

export function landmarkOptionText(r: Resolved): string {
  if (!r.landmarks) return '';
  const what =
    r.landmarks.name === 'full'
      ? 'the positions of all 478 points of a 3D face mesh'
      : `the positions of ${r.landmarks.indices.length} points around your eyes`;
  const rate =
    r.landmarksEvery === 1
      ? `${r.fps} times per second`
      : `${r.fps / r.landmarksEvery} times per second`;
  return `Also record ${what}, ${rate}. Face shape data can identify a person more easily than the other measures.`;
}
