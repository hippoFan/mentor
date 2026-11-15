// Keeps Mentor's marks stuck to the physical parts while the caller's phone moves.
// Pyramidal Lucas-Kanade optical flow (Bouguet's method, as in OpenCV calcOpticalFlowPyrLK / jsfeat) on a downscaled
// grayscale copy of each frame, plus a forward-backward check and a patch-correlation score to tell when a part left
// the view. Pure JS, no deps: ~1-2 ms per frame for a handful of points at 480x850.
//
//   const t = createTracker();
//   t.reset(frame, [{ x, y }, ...]);          // frame the brain saw; points normalised 0..1 in that frame
//   const pts = t.update(latestFrame);        // [{ x, y, conf, visible }] same order, normalised in latestFrame
//
// Frames are RGBA { data, width, height }.

const WORK_W = 240;        // tracking resolution (long frames are box-averaged down to about this width)
const LEVELS = 4;          // pyramid: 240, 120, 60, 30 px wide -> catches ~±100 px jumps at 480 wide
const HALF = 6;            // LK window is (2*HALF+1)^2
const ITERS = 12;
const FB_MAX = 1.5;        // forward-backward disagreement (work px) above which a point is untrustworthy
const NCC_MIN = 0.55;      // patch similarity below which a point is untrustworthy
const SHOW = 0.35, HIDE = 0.2;   // hysteresis on the smoothed confidence

/** RGBA -> grayscale Float32 box-averaged by integer factor f. */
function gray(frame) {
  const { data, width: w, height: h } = frame;
  const f = Math.max(1, Math.round(w / WORK_W));
  const gw = Math.floor(w / f), gh = Math.floor(h / f);
  const out = new Float32Array(gw * gh);
  const inv = 1 / (f * f * 1000);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = ((gy * f + dy) * w + gx * f) * 4;
        for (let dx = 0; dx < f; dx++, i += 4) s += 299 * data[i] + 587 * data[i + 1] + 114 * data[i + 2];
      }
      out[gy * gw + gx] = s * inv;
    }
  }
  return { d: out, w: gw, h: gh, f };
}

function half(img) {
  const w = img.w >> 1, h = img.h >> 1, d = new Float32Array(w * h), s = img.d, sw = img.w;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * sw + 2 * x;
    d[y * w + x] = 0.25 * (s[i] + s[i + 1] + s[i + sw] + s[i + sw + 1]);
  }
  return { d, w, h };
}

function pyramid(frame) {
  const g = gray(frame);
  const levels = [g];
  for (let l = 1; l < LEVELS && levels[l - 1].w >= 32 && levels[l - 1].h >= 32; l++) levels.push(half(levels[l - 1]));
  return { levels, f: g.f, fw: frame.width, fh: frame.height };
}

/** Bilinear sample with edge clamp. */
function at(img, x, y) {
  const { d, w, h } = img;
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, i = y0 * w + x0;
  return (d[i] * (1 - ax) + d[i + 1] * ax) * (1 - ay) + (d[i + w] * (1 - ax) + d[i + w + 1] * ax) * ay;
}

const N = (2 * HALF + 1) ** 2;
const P = new Float32Array(N), GX = new Float32Array(N), GY = new Float32Array(N);

/** Track one point (work-level-0 coords) from pyramid a to b. Returns [x, y] or null. */
function lk(a, b, x, y, gx0 = x, gy0 = y) {
  const L = Math.min(a.levels.length, b.levels.length);
  let gx = (gx0 - x) / 2 ** L, gy = (gy0 - y) / 2 ** L;   // initial guess of the displacement (from a prediction)
  for (let l = L - 1; l >= 0; l--) {
    const A = a.levels[l], B = b.levels[l], s = 2 ** l;
    const px = x / s, py = y / s;
    gx *= 2; gy *= 2;
    // template + gradients around the point in A
    let gxx = 0, gxy = 0, gyy = 0, k = 0;
    for (let j = -HALF; j <= HALF; j++) for (let i = -HALF; i <= HALF; i++, k++) {
      const qx = px + i, qy = py + j;
      P[k] = at(A, qx, qy);
      const ix = 0.5 * (at(A, qx + 1, qy) - at(A, qx - 1, qy));
      const iy = 0.5 * (at(A, qx, qy + 1) - at(A, qx, qy - 1));
      GX[k] = ix; GY[k] = iy;
      gxx += ix * ix; gxy += ix * iy; gyy += iy * iy;
    }
    const det = gxx * gyy - gxy * gxy;
    const minEig = (gxx + gyy - Math.sqrt((gxx - gyy) ** 2 + 4 * gxy * gxy)) / (2 * N);
    if (det < 1e-9 || minEig < 1e-5) return null;   // flat patch: nothing to lock on to
    let vx = 0, vy = 0;
    for (let it = 0; it < ITERS; it++) {
      let bx = 0, by = 0; k = 0;
      const cx = px + gx + vx, cy = py + gy + vy;
      for (let j = -HALF; j <= HALF; j++) for (let i = -HALF; i <= HALF; i++, k++) {
        const e = P[k] - at(B, cx + i, cy + j);
        bx += e * GX[k]; by += e * GY[k];
      }
      const dx = (gyy * bx - gxy * by) / det, dy = (gxx * by - gxy * bx) / det;
      vx += dx; vy += dy;
      if (dx * dx + dy * dy < 1e-4) break;
    }
    gx += vx; gy += vy;
  }
  return [x + gx, y + gy];
}

/** Normalised cross-correlation of the windows around (ax,ay) in a and (bx,by) in b, at level 0. */
function ncc(a, ax, ay, b, bx, by) {
  const A = a.levels[0], B = b.levels[0], R = HALF + 2;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++, n++) {
    const u = at(A, ax + i, ay + j), v = at(B, bx + i, by + j);
    sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v;
  }
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  if (va < 1e-6 || vb < 1e-6) return 0;
  return (sab - sa * sb / n) / Math.sqrt(va * vb);
}

/** One-euro filter (Casiez et al. 2012): steady when still, little lag when moving. */
function oneEuro(minCutoff = 2, beta = 0.1, dCutoff = 1) {
  let xPrev = null, dxPrev = 0, tPrev = 0;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  return {
    reset() { xPrev = null; },
    filter(x, t) {
      if (xPrev === null) { xPrev = x; tPrev = t; return x; }
      const dt = Math.max(1e-3, (t - tPrev) / 1000); tPrev = t;
      const dx = (x - xPrev) / dt;
      dxPrev += alpha(dCutoff, dt) * (dx - dxPrev);
      const c = minCutoff + beta * Math.abs(dxPrev);
      xPrev += alpha(c, dt) * (x - xPrev);
      return xPrev;
    },
  };
}

/**
 * @param {{ smooth?: boolean }} [opts]
 */
export function createTracker(opts = {}) {
  const smooth = opts.smooth !== false;
  let prev = null;      // pyramid of the last frame tracked
  let prevFrame = null; // identity of that frame, to skip repeats
  let seed = null;      // pyramid of the seed frame (template source for the confidence check)
  /** @type {{ x:number, y:number, sx:number, sy:number, vx:number, vy:number, conf:number, visible:boolean, lost:boolean, fx:any, fy:any, ox:number, oy:number }[]} */
  let pts = [];

  const out = () => pts.map(p => ({
    x: p.ox / (prev ? prev.fw : 1), y: p.oy / (prev ? prev.fh : 1), conf: p.conf, visible: p.visible,
  }));

  return {
    /** Start tracking `points` (normalised in `frame`). Pass [] to stop. */
    reset(frame, points) {
      prev = frame ? pyramid(frame) : null; prevFrame = frame; seed = prev;
      pts = (prev ? points : []).map(q => {
        const p = { x: q.x * prev.fw / prev.f, y: q.y * prev.fh / prev.f, vx: 0, vy: 0, conf: 1, visible: true, lost: false,
          fx: oneEuro(), fy: oneEuro(), ox: q.x * prev.fw, oy: q.y * prev.fh, sx: 0, sy: 0 };
        p.sx = p.x; p.sy = p.y;
        return p;
      });
      return out();
    },
    /** Move every point to where it is in `frame`. Returns [{ x, y, conf, visible }] (normalised to `frame`). */
    update(frame, now = Date.now()) {
      if (!frame || !prev || !pts.length) return out();
      if (frame === prevFrame) return out();
      if (frame.width !== prev.fw || frame.height !== prev.fh) {
        // Picture size changed (crop box moved / rotation): no flow across sizes; keep the normalised spot and re-anchor.
        const next = pyramid(frame);
        for (const p of pts) {
          p.x = p.x * prev.f / prev.fw * next.fw / next.f; p.y = p.y * prev.f / prev.fh * next.fh / next.f;
          p.ox = p.ox / prev.fw * next.fw; p.oy = p.oy / prev.fh * next.fh;
          p.fx.reset(); p.fy.reset(); p.vx = p.vy = 0;
        }
        prev = next; prevFrame = frame; seed = null;
        return out();
      }
      const cur = pyramid(frame);
      const W = cur.levels[0].w, H = cur.levels[0].h;
      for (const p of pts) {
        if (p.lost) continue;
        const fwd = lk(prev, cur, p.x, p.y, p.x + p.vx, p.y + p.vy);
        let ok = false;
        if (fwd && fwd[0] >= 1 && fwd[1] >= 1 && fwd[0] <= W - 2 && fwd[1] <= H - 2) {
          const back = lk(cur, prev, fwd[0], fwd[1]);
          const fb = back ? Math.hypot(back[0] - p.x, back[1] - p.y) : Infinity;
          const sim = Math.max(ncc(prev, p.x, p.y, cur, fwd[0], fwd[1]),
            seed ? ncc(seed, p.sx, p.sy, cur, fwd[0], fwd[1]) : -1);
          ok = fb < FB_MAX && sim > NCC_MIN;
          const c = ok ? Math.min(1, sim) * Math.max(0, 1 - fb / (2 * FB_MAX)) : 0;
          p.conf = 0.6 * p.conf + 0.4 * c;
          if (ok) { p.vx = fwd[0] - p.x; p.vy = fwd[1] - p.y; p.x = fwd[0]; p.y = fwd[1]; }
        } else {
          p.conf *= 0.5;
        }
        if (!ok) { p.vx *= 0.5; p.vy *= 0.5; }
        if (p.visible && p.conf < HIDE) p.visible = false;
        else if (!p.visible && p.conf > SHOW) p.visible = true;
        if (p.conf < 0.05) { p.lost = true; p.visible = false; }   // part left the view: hide until the next answer
        const rx = p.x * cur.f, ry = p.y * cur.f;
        p.ox = smooth ? p.fx.filter(rx, now) : rx;
        p.oy = smooth ? p.fy.filter(ry, now) : ry;
      }
      prev = cur; prevFrame = frame;
      return out();
    },
    get size() { return pts.length; },
  };
}

/**
 * Convenience for Mentor's marks: tracks x,y (and x2,y2 for wires) and returns marks moved to their tracked spots.
 * Marks whose anchor is lost are dropped; a wire whose far end is lost keeps its last good far end.
 */
export function createMarkTracker() {
  const t = createTracker();
  let base = [], index = [];   // index[i] = [slot of x,y, slot of x2,y2 or -1]
  return {
    seed(frame, marks) {
      base = marks || [];
      const pts = []; index = [];
      for (const m of base) {
        const a = pts.push({ x: m.x, y: m.y }) - 1;
        const b = m.x2 >= 0 && m.y2 >= 0 ? pts.push({ x: m.x2, y: m.y2 }) - 1 : -1;
        index.push([a, b]);
      }
      t.reset(frame, pts);
    },
    update(frame) {
      if (!base.length) return base;
      const p = t.update(frame);
      if (!p.length) return base;   // no frame to track in: show the marks where the brain put them
      const res = [];
      base.forEach((m, i) => {
        const [a, b] = index[i];
        if (!p[a].visible) return;
        const n = { ...m, x: p[a].x, y: p[a].y };
        if (b >= 0) { n.x2 = p[b].x; n.y2 = p[b].y; }
        res.push(n);
      });
      return res;
    },
  };
}
