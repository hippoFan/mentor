// Monocular depth for a cropped object photo: Depth Anything V2 Small (Apache-2.0),
// ONNX via onnxruntime-node on CPU. Weights: `npm run fetch-models` (see models/LICENSES.md).
// Output is relative inverse depth (bigger = nearer), normalised to an 8-bit grayscale PNG.
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export const DEPTH_MODEL = 'depth-anything-v2-small.int8.onnx';
const MODEL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'models', DEPTH_MODEL);

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const PATCH = 14;

export function depthAvailable() {
  return existsSync(MODEL_PATH);
}

let sessionPromise = null;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!depthAvailable()) {
        throw new Error(`depth model missing (${MODEL_PATH}); run \`npm run fetch-models\` in agent/`);
      }
      const ort = await import('onnxruntime-node');
      const session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        intraOpNumThreads: Math.max(1, Math.min(4, cpus().length)),
        interOpNumThreads: 1,
      });
      return { ort, session };
    })();
    // a failed load (e.g. missing file) must not poison later calls
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

// Round to a multiple of 14 (>= 14).
const to14 = (v) => Math.max(PATCH, Math.round(v / PATCH) * PATCH);

/**
 * @param {Buffer} jpegBuffer encoded image (JPEG/PNG/WebP)
 * @param {{size?: number, out?: number}} [opts] size = model input longest side, out = PNG longest side
 * @returns {Promise<{png: Buffer, width: number, height: number, near: number, far: number, ms: number}>}
 *   png: 8-bit grayscale, 255 = near, 0 = far, same aspect as the input (full frame, no padding).
 *   near/far: raw model values at the 98th/2nd percentile used for normalisation.
 */
export async function estimateDepth(jpegBuffer, { size = 518, out = 256 } = {}) {
  const t0 = performance.now();
  const { ort, session } = await getSession();
  const img = await loadImage(jpegBuffer);
  const iw = img.width, ih = img.height;
  if (!iw || !ih) throw new Error('estimateDepth: could not decode image');

  // Longest side -> size, keep aspect, snap both sides to multiples of 14. The small
  // anisotropic stretch from snapping is undone when we resize back to the input aspect.
  const s = size / Math.max(iw, ih);
  const mw = to14(iw * s), mh = to14(ih * s);
  const inCanvas = createCanvas(mw, mh);
  const ictx = inCanvas.getContext('2d');
  ictx.imageSmoothingEnabled = true;
  ictx.imageSmoothingQuality = 'high';
  ictx.drawImage(img, 0, 0, mw, mh);
  const rgba = ictx.getImageData(0, 0, mw, mh).data;

  const plane = mw * mh;
  const input = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    input[i] = (rgba[p] / 255 - MEAN[0]) / STD[0];
    input[plane + i] = (rgba[p + 1] / 255 - MEAN[1]) / STD[1];
    input[2 * plane + i] = (rgba[p + 2] / 255 - MEAN[2]) / STD[2];
  }

  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, mh, mw]) };
  const result = await session.run(feeds);
  const outT = result[session.outputNames[0]];
  const depth = outT.data; // Float32Array, shape [1, oh, ow]
  const oh = outT.dims[outT.dims.length - 2], ow = outT.dims[outT.dims.length - 1];

  // Robust range: 2nd / 98th percentile (inverse depth, so high = near).
  const sorted = Float32Array.from(depth).sort();
  const far = sorted[Math.floor(0.02 * (sorted.length - 1))];
  const near = sorted[Math.floor(0.98 * (sorted.length - 1))];
  const span = near - far || 1;

  // Model-res grayscale into an RGBA canvas, then let the canvas resample to the output size.
  const mapCanvas = createCanvas(ow, oh);
  const mctx = mapCanvas.getContext('2d');
  const mimg = mctx.createImageData(ow, oh);
  const md = mimg.data;
  for (let i = 0, p = 0; i < depth.length; i++, p += 4) {
    let v = Math.round(((depth[i] - far) / span) * 255);
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    md[p] = md[p + 1] = md[p + 2] = v;
    md[p + 3] = 255;
  }
  mctx.putImageData(mimg, 0, 0);

  const k = Math.min(1, out / Math.max(iw, ih));
  const width = Math.max(1, Math.round(iw * k)), height = Math.max(1, Math.round(ih * k));
  const outCanvas = createCanvas(width, height);
  const octx = outCanvas.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(mapCanvas, 0, 0, width, height);
  const od = octx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = od[p];

  return { png: encodeGrayPng(gray, width, height), width, height, near, far, ms: Math.round(performance.now() - t0) };
}

// Minimal 8-bit grayscale PNG encoder (color type 0); per-row Up filter keeps it small.
function encodeGrayPng(gray, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w + 1), r = y * w;
    raw[o] = y === 0 ? 0 : 2; // None for the first row, Up after
    for (let x = 0; x < w; x++) raw[o + 1 + x] = y === 0 ? gray[r + x] : (gray[r + x] - gray[r - w + x]) & 255;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
