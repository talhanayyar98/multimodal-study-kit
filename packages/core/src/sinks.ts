import type { SessionBundle } from './export/bundle.js';
import { bundleToZip } from './export/zip.js';
import type { SessionManifest } from './manifest.js';

export interface WithdrawalNotice {
  sessionId: string;
  studyId: string;
  participantId: string;
  /** The manifest stub (`status: 'withdrawn'`, no streams), or null if the session never started. */
  manifest: SessionManifest | null;
}

/**
 * Where a session's data goes. Sinks are called in order; a failing sink doesn't stop the others,
 * and local data is kept until every sink has succeeded.
 *
 * (Chunk-level delivery during the session, `onChunk`, arrives with `httpSink` in M3.)
 */
export interface Sink {
  readonly name: string;
  /** Deliver the finished bundle. */
  onEnd?(bundle: SessionBundle): Promise<void>;
  /** The participant withdrew: delete anything this sink already holds for the session. */
  onWithdraw?(notice: WithdrawalNotice): Promise<void>;
}

export interface DownloadSinkOptions {
  /** File name without extension. Default: `session_<sessionId>`. */
  filename?: (bundle: SessionBundle) => string;
  /** How to hand over the Blob. Default: a temporary `<a download>` click. Injectable for tests. */
  save?: (blob: Blob, filename: string) => void | Promise<void>;
}

/**
 * Download the bundle as `session_<id>.zip` in the participant's browser when the session ends.
 * Good for piloting and for studies where participants send the file themselves. Nothing has
 * left the device before `end()`, so `onWithdraw` has nothing to delete.
 */
export function downloadSink(options: DownloadSinkOptions = {}): Sink {
  return {
    name: 'download',
    async onEnd(bundle) {
      const blob = await bundleToZip(bundle);
      const name = `${options.filename?.(bundle) ?? bundle.folderName}.zip`;
      await (options.save ?? saveViaAnchor)(blob, name);
    },
    async onWithdraw() {
      // Nothing was sent anywhere.
    },
  };
}

function saveViaAnchor(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') {
    throw new Error('downloadSink: no document to download from (pass options.save)');
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}
