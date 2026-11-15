/**
 * @mmstudykit/face: webcam face features on MediaPipe Face Landmarker.
 *
 * Video is analysed on the participant's device and never stored or sent. MediaPipe and its
 * assets are self-hosted (`npx mmstudykit-face copy-assets <dir>`) and loaded only after the
 * participant consented; MediaPipe's usage metrics are blocked.
 */
export { face } from './face.js';
export type { FaceSensor } from './face.js';
export type { FaceFeature, FaceOptions, LandmarkSubset } from './options.js';
export type { FaceAssets } from './assets.js';
export { ASSET_FILES, DEFAULT_ASSETS_BASE, MEDIAPIPE_VERSION, MODEL } from './assets.js';
export {
  BLENDSHAPE_NAMES,
  blendshapeColumn,
  EYE,
  eyeFeatures,
  headPoseFromMatrix,
  LANDMARK_SUBSETS,
} from './extract.js';
export type { HeadPose } from './extract.js';
export { FACE_VERSION } from './version.js';
