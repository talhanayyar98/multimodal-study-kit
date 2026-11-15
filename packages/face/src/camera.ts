/** Camera access. Records only the delivered format, never device ids or labels. */

export interface CameraFormat {
  width: number | null;
  height: number | null;
  frameRate: number | null;
}

export async function openCamera(req: {
  width: number;
  height: number;
  frameRate: number;
}): Promise<MediaStream> {
  const media = (globalThis as { navigator?: { mediaDevices?: Partial<MediaDevices> } }).navigator
    ?.mediaDevices;
  if (!media?.getUserMedia) {
    throw new Error('camera unavailable: getUserMedia is missing (needs https or localhost)');
  }
  try {
    return await media.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: req.width },
        height: { ideal: req.height },
        frameRate: { ideal: req.frameRate },
      },
    });
  } catch (error) {
    throw new Error(cameraErrorMessage(error), { cause: error });
  }
}

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'camera permission denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no suitable camera found';
    case 'NotReadableError':
    case 'AbortError':
      return 'camera is in use by another application or unavailable';
    default:
      return `camera unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function formatOf(stream: MediaStream): CameraFormat {
  const s = stream.getVideoTracks()[0]?.getSettings() ?? {};
  return {
    width: typeof s.width === 'number' ? s.width : null,
    height: typeof s.height === 'number' ? s.height : null,
    frameRate: typeof s.frameRate === 'number' ? Math.round(s.frameRate * 100) / 100 : null,
  };
}
