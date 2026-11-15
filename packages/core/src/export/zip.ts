import { Zip, ZipDeflate } from 'fflate';

import type { SessionBundle } from './bundle.js';

/**
 * Fixed modification time for every zip entry. Zip timestamps are local time, so the real time
 * next to the UTC `startedAt` in the manifest would reveal the participant's timezone, which the
 * manifest deliberately leaves out. A constant also makes zips reproducible.
 */
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);

/**
 * Stream a bundle into a zip: `session_<id>/manifest.json` and `session_<id>/streams/…`.
 *
 * Stream files are read chunk by chunk from the store and compressed as they go, so the
 * uncompressed session is never in memory at once. The compressed output is collected into a
 * Blob, which browsers back with disk for large sizes.
 */
export async function bundleToZip(bundle: SessionBundle): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const status: { failure: Error | null } = { failure: null };
  let finished!: () => void;
  const ended = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const zip = new Zip((err, data, final) => {
    if (err) status.failure = err;
    else parts.push(data);
    if (err || final) finished();
  });
  const encoder = new TextEncoder();
  const root = bundle.folderName;

  const addText = async (path: string, pieces: AsyncIterable<string> | Iterable<string>) => {
    const entry = new ZipDeflate(`${root}/${path}`, { level: 6 });
    entry.mtime = ZIP_MTIME;
    zip.add(entry);
    for await (const piece of pieces) {
      if (piece) entry.push(encoder.encode(piece));
    }
    entry.push(new Uint8Array(0), true);
  };

  await addText('manifest.json', [`${JSON.stringify(bundle.manifest, null, 2)}\n`]);
  for (const file of bundle.files) await addText(file.path, file.text());
  zip.end();
  await ended;
  if (status.failure) throw status.failure;
  return new Blob(parts, { type: 'application/zip' });
}
