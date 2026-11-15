import { describe, expect, it } from 'vitest';

import {
  BLENDSHAPE_NAMES,
  blendshapeColumn,
  blendshapeScores,
  detectLayout,
  eyeFeatures,
  EYE,
  headPoseFromMatrix,
  landmarkValues,
  meanLuma,
} from '../src/extract.js';
import type { Point3 } from '../src/extract.js';

const rad = Math.PI / 180;

/** R = Ry(yaw)·Rx(pitch)·Rz(roll) with translation, as a 4×4 in the given storage order. */
function transform(
  yaw: number,
  pitch: number,
  roll: number,
  t: [number, number, number],
  layout: 'column-major' | 'row-major',
) {
  const [a, b, c] = [yaw * rad, pitch * rad, roll * rad];
  const Ry = [
    [Math.cos(a), 0, Math.sin(a)],
    [0, 1, 0],
    [-Math.sin(a), 0, Math.cos(a)],
  ];
  const Rx = [
    [1, 0, 0],
    [0, Math.cos(b), -Math.sin(b)],
    [0, Math.sin(b), Math.cos(b)],
  ];
  const Rz = [
    [Math.cos(c), -Math.sin(c), 0],
    [Math.sin(c), Math.cos(c), 0],
    [0, 0, 1],
  ];
  const at = (M: number[][], i: number, j: number) => M[i]?.[j] ?? 0;
  const mul = (A: number[][], B: number[][]) =>
    [0, 1, 2].map((i) =>
      [0, 1, 2].map((j) => [0, 1, 2].reduce((s, k) => s + at(A, i, k) * at(B, k, j), 0)),
    );
  const R = mul(mul(Ry, Rx), Rz);
  const M = [
    [at(R, 0, 0), at(R, 0, 1), at(R, 0, 2), t[0]],
    [at(R, 1, 0), at(R, 1, 1), at(R, 1, 2), t[1]],
    [at(R, 2, 0), at(R, 2, 1), at(R, 2, 2), t[2]],
    [0, 0, 0, 1],
  ];
  const out: number[] = [];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) out.push(layout === 'row-major' ? at(M, i, j) : at(M, j, i));
  return out;
}

describe('head pose', () => {
  it.each([
    [0, 0, 0],
    [30, 0, 0],
    [-25, 10, 0],
    [15, -20, 8],
    [-40, 25, -12],
  ])('decomposes yaw %d, pitch %d, roll %d in both storage orders', (yaw, pitch, roll) => {
    for (const layout of ['column-major', 'row-major'] as const) {
      const data = transform(yaw, pitch, roll, [1.5, -2, -45], layout);
      expect(detectLayout(data)).toBe(layout);
      const p = headPoseFromMatrix(data, layout);
      expect(p.yaw).toBeCloseTo(yaw, 6);
      expect(p.pitch).toBeCloseTo(pitch, 6);
      expect(p.roll).toBeCloseTo(roll, 6);
      expect([p.tx, p.ty, p.tz]).toEqual([1.5, -2, -45]);
    }
  });

  it('detects the storage order from where the translation sits', () => {
    expect(detectLayout(transform(10, 5, 0, [0, 0, -40], 'column-major'))).toBe('column-major');
    expect(detectLayout(transform(10, 5, 0, [0, 0, -40], 'row-major'))).toBe('row-major');
    expect(detectLayout([1, 2, 3])).toBeNull();
    expect(detectLayout(new Array<number>(16).fill(0.5))).toBeNull();
  });

  it('reading a row-major matrix as column-major would give wrong angles (why detection matters)', () => {
    const data = transform(30, 0, 0, [0, 0, -40], 'row-major');
    expect(headPoseFromMatrix(data, 'column-major').yaw).toBeCloseTo(-30, 6);
  });
});

describe('blendshapes', () => {
  it('has the 52 FaceLandmarker names and snake_case columns', () => {
    expect(BLENDSHAPE_NAMES).toHaveLength(52);
    expect(blendshapeColumn('_neutral')).toBe('neutral');
    expect(blendshapeColumn('mouthSmileLeft')).toBe('mouth_smile_left');
    expect(blendshapeColumn('eyeLookUpRight')).toBe('eye_look_up_right');
    expect(new Set(BLENDSHAPE_NAMES.map(blendshapeColumn)).size).toBe(52);
  });

  it('maps scores by name, not position, and reports unknown names', () => {
    const { scores, unknown } = blendshapeScores([
      { categoryName: 'jawOpen', score: 0.7 },
      { categoryName: 'mouthSmileLeft', score: 0.2 },
      { categoryName: 'futureShape', score: 0.1 },
    ]);
    expect(scores[BLENDSHAPE_NAMES.indexOf('jawOpen')]).toBe(0.7);
    expect(scores[BLENDSHAPE_NAMES.indexOf('mouthSmileLeft')]).toBe(0.2);
    expect(scores[0]).toBeNull();
    expect(unknown).toEqual(['futureShape']);
  });
});

describe('eye features', () => {
  /** A mesh with one eye drawn in pixel space and converted to normalized coordinates. */
  function mesh(
    side: 'left' | 'right',
    w: number,
    h: number,
    px: Record<'outer' | 'inner' | 'upperLid' | 'lowerLid' | 'iris', [number, number]>,
  ) {
    const lm: Point3[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    const e = EYE[side];
    for (const key of ['outer', 'inner', 'upperLid', 'lowerLid', 'iris'] as const) {
      lm[e[key]] = { x: px[key][0] / w, y: px[key][1] / h, z: 0 };
    }
    return lm;
  }

  it('measures iris position and openness in eye widths, in pixel space', () => {
    // A 40 px wide eye, lids 12 px apart, iris centred and 2 px below the axis.
    const lm = mesh('right', 640, 480, {
      outer: [100, 200],
      inner: [140, 200],
      upperLid: [120, 194],
      lowerLid: [120, 206],
      iris: [120, 202],
    });
    const [x, y, hpos, v, open] = eyeFeatures(lm, 'right', 640, 480);
    expect(x).toBeCloseTo(120 / 640, 6);
    expect(y).toBeCloseTo(202 / 480, 6);
    expect(hpos).toBeCloseTo(0.5, 6);
    expect(v).toBeCloseTo(2 / 40, 6);
    expect(open).toBeCloseTo(12 / 40, 6);
  });

  it('is invariant to head roll and to non-square frames', () => {
    // Same eye rotated by 30° about its outer corner, on a 1280×720 frame.
    const rot = (p: [number, number]): [number, number] => {
      const [cx, cy] = [300, 300];
      const a = 30 * rad;
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
    };
    const lm = mesh('left', 1280, 720, {
      outer: rot([300, 300]),
      inner: rot([340, 300]),
      upperLid: rot([320, 294]),
      lowerLid: rot([320, 306]),
      iris: rot([330, 303]),
    });
    const [, , hpos, v, open] = eyeFeatures(lm, 'left', 1280, 720);
    expect(hpos).toBeCloseTo(0.75, 6);
    expect(v).toBeCloseTo(3 / 40, 6);
    expect(open).toBeCloseTo(0.3, 6);
  });

  it('returns nulls for a degenerate eye', () => {
    const lm = mesh('right', 640, 480, {
      outer: [100, 200],
      inner: [100, 200],
      upperLid: [100, 200],
      lowerLid: [100, 200],
      iris: [100, 200],
    });
    expect(eyeFeatures(lm, 'right', 640, 480).slice(2)).toEqual([null, null, null]);
    expect(eyeFeatures([], 'left', 640, 480)).toEqual([null, null, null, null, null]);
  });
});

describe('misc', () => {
  it('flattens landmark subsets', () => {
    const lm: Point3[] = [
      { x: 0.1, y: 0.2, z: 0.3 },
      { x: 0.4, y: 0.5, z: 0.6 },
    ];
    expect(landmarkValues(lm, [1, 0, 7])).toEqual([0.4, 0.5, 0.6, 0.1, 0.2, 0.3, null, null, null]);
  });

  it('computes Rec. 709 luma', () => {
    expect(meanLuma(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]))).toBeCloseTo(0.5, 6);
    expect(meanLuma(new Uint8ClampedArray([0, 255, 0, 255]))).toBeCloseTo(0.7152, 4);
    expect(meanLuma(new Uint8ClampedArray())).toBe(0);
  });
});
