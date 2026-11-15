/**
 * Feature extractors: MediaPipe results → plain numbers. Pure functions, so they run in the
 * worker (bundled) and are unit-tested in Node.
 *
 * Conventions:
 * - "left"/"right" are always the **subject's** left/right. Input frames are never mirrored
 *   (MediaPipe's blendshapes invert under mirrored input; only a preview may be mirrored).
 * - Image coordinates: x to the right, y down, in the unmirrored camera image.
 */

/** The 52 FaceLandmarker blendshapes (ARKit-style names). Mapped by name, never by index. */
export const BLENDSHAPE_NAMES = [
  '_neutral',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawOpen',
  'jawRight',
  'mouthClose',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthFunnel',
  'mouthLeft',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'noseSneerLeft',
  'noseSneerRight',
] as const;

export type BlendshapeName = (typeof BLENDSHAPE_NAMES)[number];

/** `mouthSmileLeft` → `mouth_smile_left`, `_neutral` → `neutral`. */
export function blendshapeColumn(name: string): string {
  return name
    .replace(/^_/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

const BLENDSHAPE_INDEX = new Map<string, number>(BLENDSHAPE_NAMES.map((n, i) => [n, i]));

/**
 * Scores in {@link BLENDSHAPE_NAMES} order (null where the model didn't report one), plus any
 * category names this build doesn't know (reported once as a manifest note).
 */
export function blendshapeScores(categories: readonly { categoryName: string; score: number }[]): {
  scores: (number | null)[];
  unknown: string[];
} {
  const scores: (number | null)[] = new Array<number | null>(BLENDSHAPE_NAMES.length).fill(null);
  const unknown: string[] = [];
  for (const c of categories) {
    const i = BLENDSHAPE_INDEX.get(c.categoryName);
    if (i === undefined) unknown.push(c.categoryName);
    else scores[i] = Number.isFinite(c.score) ? c.score : null;
  }
  return { scores, unknown };
}

// -------------------------------------------------------------------------------------------
// Head pose

export interface HeadPose {
  /** Degrees. Rotation about the face model's vertical (y) axis. */
  yaw: number;
  /** Degrees. Rotation about the horizontal (x) axis. */
  pitch: number;
  /** Degrees. Rotation about the depth (z) axis. */
  roll: number;
  /** Translation of the canonical face model in camera space, cm (approximate: assumes MediaPipe's default camera). */
  tx: number;
  ty: number;
  tz: number;
}

export type MatrixLayout = 'column-major' | 'row-major';

/**
 * Which way a flattened 4×4 rigid transform is stored. In a rigid transform the bottom row is
 * (0, 0, 0, 1) and the translation is non-zero for a face in front of a camera, so the two
 * layouts are distinguishable from the data itself. Returns null if neither fits.
 */
export function detectLayout(data: readonly number[], eps = 1e-4): MatrixLayout | null {
  if (data.length !== 16 || Math.abs((data[15] ?? 0) - 1) > eps) return null;
  const zero = (i: number) => Math.abs(data[i] ?? 1) <= eps;
  const colMajorBottom = zero(3) && zero(7) && zero(11);
  const rowMajorBottom = zero(12) && zero(13) && zero(14);
  if (colMajorBottom && !rowMajorBottom) return 'column-major';
  if (rowMajorBottom && !colMajorBottom) return 'row-major';
  return colMajorBottom ? 'column-major' : null; // identity-like: both fit; layout doesn't matter
}

/**
 * Head pose from FaceLandmarker's facial transformation matrix.
 *
 * Decomposes the rotation as R = Ry(yaw) · Rx(pitch) · Rz(roll) (intrinsic y-x-z), i.e.
 * pitch = asin(−R₁₂), yaw = atan2(R₀₂, R₂₂), roll = atan2(R₁₀, R₁₁). Which physical direction is
 * positive (e.g. does positive yaw mean the subject turned to their left?) is a property of
 * MediaPipe's camera/face frames; it is verified against a recorded clip and documented in
 * docs/face.md, not assumed here.
 */
export function headPoseFromMatrix(
  data: readonly number[],
  layout: MatrixLayout = 'column-major',
): HeadPose {
  // r(row, col) regardless of storage order.
  const r = (row: number, col: number): number =>
    (layout === 'column-major' ? data[col * 4 + row] : data[row * 4 + col]) ?? 0;
  const deg = 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r(1, 2))));
  const yaw = Math.atan2(r(0, 2), r(2, 2));
  const roll = Math.atan2(r(1, 0), r(1, 1));
  return {
    yaw: yaw * deg,
    pitch: pitch * deg,
    roll: roll * deg,
    tx: r(0, 3),
    ty: r(1, 3),
    tz: r(2, 3),
  };
}

// -------------------------------------------------------------------------------------------
// Iris / eye features

/** Canonical 478-point mesh indices (subject's left/right). 468–477 are the iris points. */
export const EYE = {
  right: {
    outer: 33,
    inner: 133,
    upperLid: 159,
    lowerLid: 145,
    iris: 468,
    ring: [469, 470, 471, 472],
  },
  left: {
    outer: 263,
    inner: 362,
    upperLid: 386,
    lowerLid: 374,
    iris: 473,
    ring: [474, 475, 476, 477],
  },
} as const;

/** Landmark subsets for the opt-in landmarks stream. */
export const LANDMARK_SUBSETS = {
  iris: [468, 469, 470, 471, 472, 473, 474, 475, 476, 477],
  eyes: [33, 133, 159, 145, 468, 469, 470, 471, 472, 263, 362, 386, 374, 473, 474, 475, 476, 477],
} as const;

export const MESH_SIZE = 478;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Per-eye features, in order `[iris_x, iris_y, iris_h, iris_v, openness]`:
 * - `iris_x`, `iris_y`: iris centre in normalized image coordinates (0–1).
 * - `iris_h`: iris centre projected onto the outer→inner corner axis, in eye widths
 *   (0 = outer corner, 1 = inner corner; ~0.5 looking straight).
 * - `iris_v`: signed distance from that axis, in eye widths, positive towards the lower lid.
 * - `openness`: lid-to-lid distance / eye width (an eye-aspect ratio; ~0.25–0.35 open, ~0 closed).
 *
 * Geometry is computed in pixels (`width` × `height`), because normalized coordinates are
 * anisotropic for non-square frames. Returns nulls if the eye is degenerate.
 */
export function eyeFeatures(
  landmarks: readonly Point3[],
  side: 'left' | 'right',
  width: number,
  height: number,
): (number | null)[] {
  const e = EYE[side];
  const p = (i: number) => {
    const l = landmarks[i];
    return l ? { x: l.x * width, y: l.y * height } : null;
  };
  const outer = p(e.outer);
  const inner = p(e.inner);
  const upper = p(e.upperLid);
  const lower = p(e.lowerLid);
  const iris = p(e.iris);
  const irisN = landmarks[e.iris];
  if (!outer || !inner || !upper || !lower || !iris || !irisN)
    return [null, null, null, null, null];
  const ax = inner.x - outer.x;
  const ay = inner.y - outer.y;
  const w = Math.hypot(ax, ay);
  if (w < 1e-6) return [irisN.x, irisN.y, null, null, null];
  const ux = ax / w;
  const uy = ay / w;
  // Perpendicular, oriented towards the lower lid.
  let nx = -uy;
  let ny = ux;
  const lidSide = (lower.x - upper.x) * nx + (lower.y - upper.y) * ny;
  if (lidSide < 0) {
    nx = -nx;
    ny = -ny;
  }
  const dx = iris.x - outer.x;
  const dy = iris.y - outer.y;
  const h = (dx * ux + dy * uy) / w;
  const v = (dx * nx + dy * ny) / w;
  const openness = Math.hypot(lower.x - upper.x, lower.y - upper.y) / w;
  return [irisN.x, irisN.y, h, v, openness];
}

/** Flattened `[x0, y0, z0, x1, …]` for the given indices (nulls for missing points). */
export function landmarkValues(
  landmarks: readonly Point3[],
  indices: readonly number[],
): (number | null)[] {
  const out: (number | null)[] = [];
  for (const i of indices) {
    const l = landmarks[i];
    out.push(l?.x ?? null, l?.y ?? null, l?.z ?? null);
  }
  return out;
}

/** Mean luma (Rec. 709) of RGBA pixels, 0–1. */
export function meanLuma(rgba: Uint8ClampedArray): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    sum += 0.2126 * (rgba[i] ?? 0) + 0.7152 * (rgba[i + 1] ?? 0) + 0.0722 * (rgba[i + 2] ?? 0);
    n++;
  }
  return n ? sum / n / 255 : 0;
}
