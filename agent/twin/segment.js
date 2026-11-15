// Object cut-out for "scan anything": MediaPipe's Interactive Segmenter (magic_touch.tflite, Apache-2.0) seeded with a
// scribble along the scanned object's main axis. Runs in this page on files served by this laptop (no network).
// Any failure (model missing, WASM/GL trouble, a timeout) returns null and the caller falls back to its flood fill.
const BASE = '/vendor/mediapipe';
const MODEL = '/twin/models/magic_touch.tflite';
let seg = null;   // Promise<InteractiveSegmenterLegacy | null>, made once

function segmenter() {
  seg ||= (async () => {
    const { FilesetResolver, InteractiveSegmenterLegacy } = await import(`${BASE}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    return InteractiveSegmenterLegacy.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' }, runningMode: 'IMAGE',
      outputConfidenceMasks: true, outputCategoryMask: false,
    });
  })().catch(e => { console.warn('[twin] segmenter unavailable', e?.message || e); seg = null; return null; });
  return seg;
}

/**
 * Positive seed points (0..1 of the image) for the object inside box [x0, y0, x1, y1] (0..1): the centre, plus a few
 * points along the box's longer side (a pen is a line, a phone a column), kept off the ends where the background shows.
 */
export function seedPoints([x0, y0, x1, y1], aspect = 1) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, wide = (x1 - x0) * aspect >= (y1 - y0);
  const pts = [];
  for (const t of [-0.3, -0.15, 0, 0.15, 0.3]) pts.push(wide ? { x: cx + t * (x1 - x0), y: cy } : { x: cx, y: cy + t * (y1 - y0) });
  return pts.map(p => ({ x: Math.min(0.999, Math.max(0.001, p.x)), y: Math.min(0.999, Math.max(0.001, p.y)) }));
}

/**
 * Segments the object in `canvas` (an HTMLCanvasElement holding the crop).
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} box the object's bbox inside the canvas, 0..1
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{w: number, h: number, mask: Uint8Array, conf: Float32Array, ms: number} | null>} mask[k] = 1 on the
 *   object (confidence > 0.5) at the canvas's own size; null if the model isn't available or the mask is implausible
 */
export async function segmentObject(canvas, box, { timeoutMs = 6000 } = {}) {
  const t0 = performance.now();
  try {
    const s = await Promise.race([segmenter(), new Promise(r => setTimeout(() => r(null), timeoutMs))]);
    if (!s) return null;
    const w = canvas.width, h = canvas.height;
    const run = roi => new Promise((resolve, reject) => {
      try {
        s.segment(canvas, roi, res => {
          try {
            const m = res.confidenceMasks?.[0];
            if (!m) return resolve(null);
            const f = m.getAsFloat32Array(), mw = m.width, mh = m.height;
            // resample to the canvas size (nearest) if the task returned another size
            const conf = new Float32Array(w * h);
            for (let y = 0; y < h; y++) {
              const sy = Math.min(mh - 1, Math.floor(y * mh / h));
              for (let x = 0; x < w; x++) conf[y * w + x] = f[sy * mw + Math.min(mw - 1, Math.floor(x * mw / w))];
            }
            resolve(conf);
          } catch (e) { reject(e); }
        });
      } catch (e) { reject(e); }
    });
    const pts = seedPoints(box, w / Math.max(1, h));
    let conf = await run({ scribble: pts });
    if (!conf) conf = await run({ keypoint: pts[2] });
    if (!conf) return null;
    const mask = new Uint8Array(w * h);
    let on = 0;
    for (let k = 0; k < mask.length; k++) if (conf[k] > 0.5) { mask[k] = 1; on++; }
    // sanity: the object covers a real share of its own crop, and the seed centre is on it
    const frac = on / mask.length, c = pts[2], ck = Math.floor(c.y * (h - 1)) * w + Math.floor(c.x * (w - 1));
    if (frac < 0.04 || frac > 0.995 || !mask[ck]) return null;
    return { w, h, mask, conf, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    console.warn('[twin] segmentation failed', e?.message || e);
    return null;
  }
}
