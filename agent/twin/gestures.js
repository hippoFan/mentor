// Hand gestures for the twin, from MediaPipe hand landmarks (21 points per hand, x/y 0..1 of the image). Pure
// (no DOM, no three.js) so it can be unit-tested with synthetic hands.
//   pinch + drag        rotate          two-hand pinch spread  zoom
//   fist + move         grab and move   open palm held 1 s     reset view
//   point, hold ~0.6 s  select the pin under the fingertip

/** One-euro filter (Casiez et al. 2012): smooth when still, responsive when moving. */
export class OneEuro {
  constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1.0 } = {}) { Object.assign(this, { minCutoff, beta, dCutoff }); this.reset(); }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  filter(x, tMs) {
    if (this.x == null) { this.x = x; this.t = tMs; return x; }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000); this.t = tMs;
    const a = c => 1 / (1 + 1 / (2 * Math.PI * c * dt));
    const dx = (x - this.x) / dt;
    this.dx += a(this.dCutoff) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += a(cutoff) * (x - this.x);
    return this.x;
  }
}
class Euro2 {
  constructor(o) { this.fx = new OneEuro(o); this.fy = new OneEuro(o); }
  reset() { this.fx.reset(); this.fy.reset(); }
  filter(p, t) { return { x: this.fx.filter(p.x, t), y: this.fy.filter(p.y, t) }; }
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]];   // tip, pip: index, middle, ring, pinky

/** Pose of one hand: 'pinch' | 'fist' | 'palm' | 'point' | 'none', plus useful points. */
export function classify(lm, wasPinching = false) {
  if (!Array.isArray(lm) || lm.length < 21) return { pose: 'none' };
  const size = dist(lm[0], lm[9]) || 1e-3;
  const pinchD = dist(lm[4], lm[8]) / size;
  const ext = FINGERS.map(([t, p]) => dist(lm[t], lm[0]) > dist(lm[p], lm[0]) * 1.15);
  const thumbOut = dist(lm[4], lm[17]) / size > 0.9;
  // a pinch holds the index tip out from the palm; in a fist the thumb also touches the index, but curled in
  const pinch = pinchD < (wasPinching ? 0.5 : 0.33) && dist(lm[8], lm[0]) / size > 1.0;
  const centre = { x: (lm[0].x + lm[5].x + lm[17].x) / 3, y: (lm[0].y + lm[5].y + lm[17].y) / 3 };
  const pinchPt = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
  let pose = 'none';
  if (pinch) pose = 'pinch';
  else if (ext.every(Boolean) && thumbOut) pose = 'palm';
  else if (!ext.some(Boolean)) pose = 'fist';
  else if (ext[0] && !ext[1] && !ext[2] && !ext[3]) pose = 'point';
  return { pose, size, centre, pinchPt, tip: { x: lm[8].x, y: lm[8].y } };
}

/**
 * Stateful recogniser. update(hands, tMs) with hands = [{landmarks:[{x,y,z}×21]}] (already mirrored like a selfie view).
 * Returns per-frame controls: rotate [dx, dy] and pan [dx, dy] in screen fractions, zoom (multiplier on distance,
 * <1 = closer), reset (true once per palm hold), select {x,y} (once per point dwell), cursor {x,y}, dwell 0..1.
 */
export function createGestures({ palmHoldMs = 1000, dwellMs = 600, dwellRadius = 0.035 } = {}) {
  const cur = new Euro2({ minCutoff: 1.5, beta: 4 }), grab = new Euro2({ minCutoff: 1.0, beta: 2 });
  const pts = [new Euro2({ minCutoff: 1.2, beta: 3 }), new Euro2({ minCutoff: 1.2, beta: 3 })];
  let last = null, lastSpread = null, palmSince = null, palmFired = false, dwell = null, pinching = [false, false];
  return {
    reset() { last = null; lastSpread = null; palmSince = null; palmFired = false; dwell = null; cur.reset(); grab.reset(); pts.forEach(p => p.reset()); },
    update(hands, t) {
      const out = { mode: 'none', rotate: [0, 0], pan: [0, 0], zoom: 1, reset: false, select: null, cursor: null, dwell: 0, hands: 0 };
      const hs = (hands || []).filter(h => h?.landmarks?.length >= 21).slice(0, 2).map((h, i) => {
        const c = classify(h.landmarks, pinching[i]); pinching[i] = c.pose === 'pinch'; return c;
      });
      out.hands = hs.length;
      if (!hs.length) { last = null; lastSpread = null; palmSince = null; palmFired = false; dwell = null; cur.reset(); grab.reset(); return out; }
      const a = hs[0];
      out.cursor = cur.filter(a.tip, t);

      // two hands pinching: zoom by how far apart the pinches are
      if (hs.length === 2 && hs[0].pose === 'pinch' && hs[1].pose === 'pinch') {
        const p0 = pts[0].filter(hs[0].pinchPt, t), p1 = pts[1].filter(hs[1].pinchPt, t);
        const spread = dist(p0, p1);
        if (lastSpread) out.zoom = Math.max(0.8, Math.min(1.25, lastSpread / Math.max(spread, 1e-3)));
        lastSpread = spread; last = null; out.mode = 'zoom'; palmSince = null; dwell = null;
        return out;
      }
      lastSpread = null; pts.forEach(p => p.reset());

      if (a.pose === 'pinch' || a.pose === 'fist') {
        const p = grab.filter(a.pose === 'pinch' ? a.pinchPt : a.centre, t);
        if (last && last.pose === a.pose) {
          const d = [p.x - last.x, p.y - last.y];
          if (a.pose === 'pinch') out.rotate = d; else out.pan = d;
        }
        last = { ...p, pose: a.pose }; out.mode = a.pose === 'pinch' ? 'rotate' : 'grab';
        palmSince = null; dwell = null; return out;
      }
      last = null; grab.reset();

      if (a.pose === 'palm') {
        out.mode = 'palm'; dwell = null;
        if (palmSince == null) palmSince = t;
        out.dwell = Math.min(1, (t - palmSince) / palmHoldMs);
        if (!palmFired && t - palmSince >= palmHoldMs) { out.reset = true; palmFired = true; }
        return out;
      }
      palmSince = null; palmFired = false;

      if (a.pose === 'point') {
        out.mode = 'point';
        const c = out.cursor;
        if (!dwell || dist(dwell, c) > dwellRadius) dwell = { x: c.x, y: c.y, since: t, fired: false };
        out.dwell = Math.min(1, (t - dwell.since) / dwellMs);
        if (!dwell.fired && t - dwell.since >= dwellMs) { out.select = { x: c.x, y: c.y }; dwell.fired = true; }
        return out;
      }
      dwell = null;
      return out;
    },
  };
}

/**
 * Applies gesture controls to an orbit camera {theta, phi, radius, target:[x,y,z]} (radians, scene units) and returns
 * the new state. `home` is the state a palm-hold resets to. Pure, so tests can check the camera really responds.
 */
export function applyToCamera(cam, g, home, { rotSpeed = 4.2, panSpeed = 260, minR = 60, maxR = 520 } = {}) {
  if (g.reset) return { ...home, target: [...home.target] };
  let { theta, phi, radius } = cam; const target = [...cam.target];
  theta -= g.rotate[0] * rotSpeed;
  phi = Math.max(0.12, Math.min(1.45, phi - g.rotate[1] * rotSpeed));
  radius = Math.max(minR, Math.min(maxR, radius * g.zoom));
  if (g.pan[0] || g.pan[1]) {   // move in the view plane: x along the camera's right, y along the ground away from it
    const k = panSpeed * (radius / 220);
    target[0] += (g.pan[0] * Math.cos(theta) + g.pan[1] * Math.sin(theta)) * k;
    target[2] += (-g.pan[0] * Math.sin(theta) + g.pan[1] * Math.cos(theta)) * k;
  }
  return { theta, phi, radius, target };
}

/** Synthetic hand for tests and demos: centre (cx, cy), size = wrist→middle-knuckle distance. */
export function synthHand(pose, cx = 0.5, cy = 0.5, size = 0.12) {
  const P = (x, y) => ({ x: cx + x * size, y: cy + y * size, z: 0 });
  const lm = new Array(21);
  const base = { 1: [-0.35, 0.65], 5: [-0.3, 0], 9: [0, -0.1], 13: [0.25, -0.05], 17: [0.45, 0.1] };
  lm[0] = P(0, 0.9); lm[9] = P(0, 0);
  for (const [k, [x, y]] of Object.entries(base)) lm[k] = P(x, y);
  const finger = (mcp, out) => {   // mcp index; 3 more joints straight up (extended) or curled back toward the wrist
    const [x, y] = base[mcp];
    for (let j = 1; j <= 3; j++) lm[mcp + j] = out ? P(x, y - 0.38 * j) : P(x + 0.05 * j, y + (j === 1 ? -0.25 : -0.25 + 0.3 * (j - 1)));
  };
  const ext = { palm: [1, 1, 1, 1], point: [1, 0, 0, 0], fist: [0, 0, 0, 0], pinch: [1, 1, 1, 1], none: [1, 1, 0, 0] }[pose];
  [5, 9, 13, 17].forEach((m, i) => finger(m, ext[i]));
  if (pose === 'palm' || pose === 'none') { lm[2] = P(-0.7, 0.45); lm[3] = P(-0.95, 0.25); lm[4] = P(-1.2, 0.05); }
  else if (pose === 'pinch') {   // thumb tip meets a slightly bent index tip
    lm[6] = P(-0.4, -0.35); lm[7] = P(-0.5, -0.6); lm[8] = P(-0.55, -0.75);
    lm[2] = P(-0.6, 0.35); lm[3] = P(-0.65, -0.2); lm[4] = P(-0.6, -0.72);
  } else { lm[2] = P(-0.45, 0.45); lm[3] = P(-0.3, 0.3); lm[4] = P(-0.1, 0.25); }   // thumb tucked
  return lm;
}
