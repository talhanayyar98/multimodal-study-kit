// Turn a recorded face video into the MJPEG fixture Chrome's fake camera plays in the e2e test.
//
//   node scripts/make-face-fixture.mjs <video> [--width 320] [--seconds 10] [--quality 0.8]
//
// Decodes with the installed Google Chrome (Playwright channel "chrome", which has the H.264/HEVC
// codecs phones and QuickTime produce), samples 30 frames per second, scales to 4:3 at --width,
// and writes concatenated JPEG frames to e2e/fixtures/face.mjpeg. No ffmpeg needed.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
if (!input) {
  console.error(
    'usage: node scripts/make-face-fixture.mjs <video> [--width 320] [--seconds 10] [--quality 0.8]',
  );
  process.exit(1);
}
const width = opt('width', 320);
const height = Math.round((width * 3) / 4);
const seconds = opt('seconds', 10);
const quality = opt('quality', 0.8);
const fps = 30;
const out = join(dirname(fileURLToPath(import.meta.url)), '../e2e/fixtures/face.mjpeg');

const file = resolve(input);
const types = {
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
};
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><body>');
    return;
  }
  const size = statSync(file).size;
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const type = types[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const data = readFileSync(file);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, {
      'content-type': type,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    res.end(data.subarray(start, end + 1));
  } else {
    res
      .writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size })
      .end(data);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto(origin);
const frames = await page.evaluate(
  async ({ src, width, height, seconds, fps, quality }) => {
    const video = document.createElement('video');
    video.muted = true;
    video.src = src;
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () =>
        rej(new Error(`cannot decode video (${video.error?.message ?? 'unknown'})`));
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    // Centre-crop to 4:3, keep orientation as recorded (no mirroring).
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const target = 4 / 3;
    let sw = vw;
    let sh = vh;
    if (vw / vh > target) sw = vh * target;
    else sh = vw / target;
    const sx = (vw - sw) / 2;
    const sy = (vh - sh) / 2;
    const n = Math.min(Math.floor(video.duration * fps), Math.floor(seconds * fps));
    const out = [];
    for (let i = 0; i < n; i++) {
      video.currentTime = i / fps;
      await new Promise((r) => (video.onseeked = r));
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      out.push(btoa(s));
    }
    return { frames: out, source: { width: vw, height: vh, duration: video.duration } };
  },
  { src: `${origin}/${encodeURIComponent(basename(file))}`, width, height, seconds, fps, quality },
);
await browser.close();
server.close();

const buf = Buffer.concat(frames.frames.map((b64) => Buffer.from(b64, 'base64')));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(
  `wrote ${out}: ${frames.frames.length} frames (${(frames.frames.length / fps).toFixed(1)} s at ${fps} fps), ${width}×${height}, ` +
    `${(buf.length / 1e6).toFixed(1)} MB (source ${frames.source.width}×${frames.source.height}, ${frames.source.duration.toFixed(1)} s)`,
);
