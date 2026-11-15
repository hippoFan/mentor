// Hand gestures for the twin, from MediaPipe hand landmarks (21 points per hand, x/y 0..1 of the image, already
// mirrored like a selfie view). Pure (no DOM, no three.js), so tests drive it with synthetic hands.
//   open hand          hover: the ring follows the index fingertip      point, held ~0.6 s   pick the pin under it
//   pinch + move       turn the view, or (taken apart) grab a part; pull the hand closer / away to move it in depth
//   two hands          zoom by the distance between them: apart = in    fist, held ~0.7 s    reset the view
//   flick sideways     remove the part under the ring                    thumbs up, held      combine (the app confirms)
// Robust by design: One-Euro filtered landmarks, pinch hysteresis normalised by palm size, every pose must hold
// >= 150 ms before it counts, a dead-zone + gain curve on turning and zooming, hands smaller than minPalm are ignored
// (people behind you), the largest hand leads (left or right alike), and a missed detection frame is bridged.

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

/** Every threshold in one place. Distances are in image heights (x is scaled by the camera's aspect). */
export const TUNING = {
  minPalm: 0.05,          // a palm smaller than this is someone behind you: ignored
  secondRatio: 0.6,       // a second hand counts (zoom) only if it is at least this big next to the first
  tooClose: 0.32,         // palm bigger than this: "too close"
  pinchOn: 0.3, pinchOff: 0.48,   // thumb-index gap / palm size: engage below pinchOn, release above pinchOff
  stableMs: 150,          // a new pose (or a change between one and two hands) must hold this long
  lostMs: 250,            // a hand missing for less than this is bridged (no drop, no jump)
  fistHoldMs: 700, thumbsHoldMs: 450, dwellMs: 600, dwellRadius: 0.035,
  rotDead: 0.012, rotJitter: 0.0008,   // pinch must travel rotDead before turning starts; smaller steps accumulate
  zoomDead: 0.04,         // the hands' distance must change 4 % before zooming starts
  pullDead: 0.05,         // the hand must grow / shrink 5 % before a held part moves in depth
  flickSpeed: 1.8, flickDist: 0.16, flickWindowMs: 180, flickCooldownMs: 900,   // widths per second, widths, ms
};

const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]];   // tip, pip: index, middle, ring, pinky
const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = v => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const centreOf = lm => ({ x: (lm[0].x + lm[5].x + lm[17].x) / 3, y: (lm[0].y + lm[5].y + lm[17].y) / 3 });

/** Palm size: mean of four bones that barely change with the pose, so a fist and a palm measure alike. */
export function palmSize(lm, k = 1) {
  const D = (a, b) => Math.hypot((lm[a].x - lm[b].x) * k, lm[a].y - lm[b].y);
  return (D(0, 5) + D(0, 9) + D(0, 17) + D(5, 17)) / 4;
}

/** Pose of one hand: 'pinch' | 'palm' | 'thumbs' | 'fist' | 'point' | 'open' (relaxed) | 'none', plus useful points. */
export function classify(lm, wasPinching = false, k = 1, T = TUNING) {
  if (!Array.isArray(lm) || lm.length < 21) return { pose: 'none' };
  const D = (a, b) => Math.hypot((lm[a].x - lm[b].x) * k, lm[a].y - lm[b].y);
  const palm = palmSize(lm, k) || 1e-3;
  const gap = D(4, 8) / palm;
  const ext = FINGERS.map(([t, p]) => D(t, 0) > D(p, 0) * 1.15);
  const thumbOut = D(4, 17) / palm > 1.0;
  // a pinch holds the index tip out from the palm; in a fist the thumb also touches the index, but curled in
  const pinch = gap < (wasPinching ? T.pinchOff : T.pinchOn) && D(8, 0) / palm > 0.95;
  const thumbsUp = !ext.some(Boolean) && lm[2].y - lm[4].y > 0.5 * palm && lm[4].y < lm[5].y - 0.25 * palm && lm[4].y < lm[3].y;
  const pinchPt = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
  let pose = 'open';
  if (pinch) pose = 'pinch';
  else if (ext.every(Boolean) && thumbOut) pose = 'palm';
  else if (thumbsUp) pose = 'thumbs';
  else if (!ext.some(Boolean)) pose = 'fist';
  else if (ext[0] && !ext[1] && !ext[2] && !ext[3]) pose = 'point';
  return { pose, palm, size: palm, gap, closeness: clamp01((0.9 - gap) / (0.9 - T.pinchOn)), centre: centreOf(lm), pinchPt, tip: { x: lm[8].x, y: lm[8].y } };
}

const HOVER = new Set(['open', 'palm', 'point']);

/**
 * Stateful recogniser. update(hands, tMs, { aspect }) with hands = [{landmarks:[{x,y,z}×21]}] (mirrored like a selfie).
 * Returns per-frame controls:
 *   mode 'none' | 'hover' | 'point' | 'rotate' (pinch) | 'zoom' (two hands) | 'fist' | 'thumbs'
 *   cursor {x,y} (index tip, or the pinch point while pinching), closeness 0..1 (how near a pinch), pinching,
 *   grab 'start' | 'end' | null (pinch edges), rotate [dx, dy] (screen fractions, after dead-zone + gain),
 *   pull (log change of hand size while pinching: > 0 = toward the camera), zoom (multiplier on distance, < 1 = closer),
 *   reset / thumbsUp (once per hold), dwell 0..1 (hold progress), select {x,y} (once per point dwell),
 *   flick {dir, from:{x,y}, speed} (once per flick), status 'none' | 'ok' | 'close', hands, ignored, skeleton.
 */
export function createGestures(opts = {}) {
  const T = { ...TUNING, ...opts };
  let tracks = [], primaryId = null, nextId = 1, count = 0, countCand = 0, countSince = 0, zoom = null, flickAt = -1e9;
  const newTrack = (c, t) => ({
    id: nextId++, f: Array.from({ length: 21 }, () => new Euro2({ minCutoff: 1.1, beta: 6, dCutoff: 1.6 })), size: new OneEuro({ minCutoff: 0.8, beta: 0.4 }),
    lm: null, c: null, rawC: c.c, palm: c.palm, logPalm: Math.log(c.palm), lastT: t, born: t, pinching: false,
    stable: 'open', cand: 'open', candSince: t, stableSince: t, fired: false, rot: null, pull: null, dwell: null, hist: [], rest: null,
  });
  function reset() { tracks = []; primaryId = null; count = 0; countCand = 0; zoom = null; }
  return {
    reset,
    tuning: T,
    update(hands, t, info = {}) {
      const k = info.aspect || 1;
      const out = { mode: 'none', pose: 'none', rotate: [0, 0], pan: [0, 0], zoom: 1, reset: false, select: null, cursor: null, dwell: 0, closeness: 0,
        pinching: false, grab: null, pull: 0, flick: null, thumbsUp: false, status: 'none', palm: 0, hands: 0, ignored: 0, skeleton: [] };
      // 1. which hands count: big enough, largest first, a second only if it is about as big (the same person)
      const cands = [];
      for (const h of hands || []) {
        const lm = h?.landmarks; if (!Array.isArray(lm) || lm.length < 21) continue;
        const palm = palmSize(lm, k);
        if (!(palm >= T.minPalm)) { out.ignored++; continue; }
        cands.push({ lm, palm, c: centreOf(lm) });
      }
      cands.sort((a, b) => b.palm - a.palm);
      const use = cands.slice(0, 1); if (cands[1] && cands[1].palm >= cands[0].palm * T.secondRatio) use.push(cands[1]);
      // 2. match to tracks (nearest centre), so filters and pose state follow the same hand
      const free = new Set(tracks);
      for (const c of use) {
        let best = null, bd = 0.3;
        for (const tr of free) { const d = Math.hypot((tr.rawC.x - c.c.x) * k, tr.rawC.y - c.c.y); if (d < bd) { bd = d; best = tr; } }
        if (best) free.delete(best); else { best = newTrack(c, t); tracks.push(best); }
        c.tr = best; best.seen = t;
      }
      tracks = tracks.filter(tr => tr.seen === t || t - tr.lastT <= T.lostMs);
      for (const c of use) {
        const tr = c.tr; tr.lastT = t; tr.rawC = c.c; tr.raw = c.lm;
        tr.lm = c.lm.map((p, i) => tr.f[i].filter(p, t));
        const cl = classify(tr.lm, tr.pinching, k, T); tr.pinching = cl.pose === 'pinch'; tr.cl = cl;
        tr.palm = cl.palm; tr.logPalm = tr.size.filter(Math.log(Math.max(1e-3, c.palm)), t);
        // debounce: a pose counts once it has held stableMs
        if (cl.pose === tr.stable) tr.cand = cl.pose;
        else if (cl.pose !== tr.cand) { tr.cand = cl.pose; tr.candSince = t; }
        else if (t - tr.candSince >= T.stableMs) {
          const was = tr.stable; tr.stable = cl.pose; tr.stableSince = t; tr.fired = false;
          if (was === 'pinch') { tr.grabEnd = true; tr.rot = null; tr.pull = null; }
          if (cl.pose === 'pinch') tr.grabStart = true;
        }
      }
      if (!tracks.length) { primaryId = null; count = 0; countCand = 0; zoom = null; return out; }
      // 3. the leading hand: the biggest, but the current one keeps the lead unless another is clearly bigger
      const biggest = tracks.reduce((a, b) => (b.palm > a.palm ? b : a));
      const cur = tracks.find(tr => tr.id === primaryId);
      const P = cur && cur.palm * 1.25 >= biggest.palm ? cur : biggest; primaryId = P.id;
      const live = tracks.slice(0, 2);
      // one <-> two hands only switches after stableMs (a hand flickering in and out does not start a zoom)
      const seenNow = live.filter(tr => tr.seen === t).length, n = seenNow || count || live.length;   // a missed frame keeps the count
      if (!count || n === count) { count = n; countCand = n; }
      else if (n !== countCand) { countCand = n; countSince = t; }
      else if (t - countSince >= T.stableMs) count = n;
      const fresh = P.seen === t;
      out.hands = n; out.palm = P.palm; out.pose = P.stable;
      out.status = P.palm > T.tooClose ? 'close' : 'ok';
      out.skeleton = live.map(tr => ({ lm: tr.lm, primary: tr === P, closeness: tr.cl.closeness, pose: tr.stable }));
      const grabStart = P.grabStart, grabEnd = P.grabEnd; P.grabStart = P.grabEnd = false;
      for (const tr of tracks) { if (tr !== P) tr.grabStart = tr.grabEnd = false; }

      // 4. two hands: zoom by the distance between the palms
      if (count === 2 && live.length === 2) {
        const [a, b] = live.map(tr => centreOf(tr.lm));
        const dist = Math.hypot((a.x - b.x) * k, a.y - b.y);
        if (!zoom) zoom = { anchor: dist, last: dist, on: false };
        if (!zoom.on && Math.abs(Math.log(dist / zoom.anchor)) > T.zoomDead) { zoom.on = true; zoom.last = dist; }
        if (zoom.on && fresh) { out.zoom = Math.max(0.85, Math.min(1.18, zoom.last / Math.max(dist, 1e-3))); zoom.last = dist; }
        out.mode = 'zoom'; out.cursor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (P.stable === 'pinch') out.grab = 'end';
        for (const tr of live) { tr.rot = null; tr.pull = null; tr.dwell = null; tr.hist = []; }
        return out;
      }
      zoom = null;

      // 5. one hand
      const cl = P.cl, pinch = P.stable === 'pinch';
      out.cursor = pinch ? cl.pinchPt : cl.tip;
      out.closeness = pinch ? 1 : cl.closeness; out.pinching = pinch;
      if (grabStart) out.grab = 'start'; else if (grabEnd) out.grab = 'end';
      if (!fresh) { out.mode = pinch ? 'rotate' : HOVER.has(P.stable) ? (P.stable === 'point' ? 'point' : 'hover') : P.stable; return out; }   // bridged frame: hold still

      if (pinch) {
        out.mode = 'rotate';
        const p = cl.pinchPt;
        if (!P.rot) P.rot = { anchor: p, last: p, on: false };
        if (!P.rot.on && Math.hypot((p.x - P.rot.anchor.x) * k, p.y - P.rot.anchor.y) > T.rotDead) { P.rot.on = true; P.rot.last = p; }
        else if (P.rot.on) {
          const dx = p.x - P.rot.last.x, dy = p.y - P.rot.last.y, m = Math.hypot(dx, dy);
          if (m >= T.rotJitter) { const g = 0.7 + 1.3 * smooth((m - 0.002) / 0.018); out.rotate = [dx * g, dy * g]; P.rot.last = p; }
        }
        const lp = P.logPalm;
        if (!P.pull) P.pull = { anchor: lp, last: lp, on: false };
        if (!P.pull.on && Math.abs(lp - P.pull.anchor) > T.pullDead) { P.pull.on = true; P.pull.last = lp; }
        else if (P.pull.on) { out.pull = lp - P.pull.last; P.pull.last = lp; }
        P.hist = []; P.dwell = null;
        return out;
      }
      if (P.stable === 'fist' || P.stable === 'thumbs') {
        out.mode = P.stable;
        const hold = P.stable === 'fist' ? T.fistHoldMs : T.thumbsHoldMs;
        out.dwell = clamp01((t - P.stableSince) / hold);
        if (!P.fired && t - P.stableSince >= hold) { P.fired = true; if (P.stable === 'fist') out.reset = true; else out.thumbsUp = true; }
        P.hist = []; P.dwell = null;
        return out;
      }
      out.mode = P.stable === 'point' ? 'point' : 'hover';
      // flick: a fast sideways throw of the open hand, measured on the raw palm centre (filters would blunt it)
      const c = P.rawC, h = P.hist;
      const prev = h[h.length - 1];
      const speed = prev ? Math.hypot((c.x - prev.x) * k, c.y - prev.y) / Math.max(1e-3, (t - prev.t) / 1000) : 0;
      if (!P.rest || speed < 0.6) P.rest = { ...out.cursor };
      h.push({ t, x: c.x, y: c.y }); while (h.length && t - h[0].t > T.flickWindowMs) h.shift();
      if (t - flickAt > T.flickCooldownMs && h.length >= 2) {
        const s = h[0], dx = c.x - s.x, dy = c.y - s.y, dtt = (t - s.t) / 1000;
        if (dtt > 0.04 && Math.abs(dx) >= T.flickDist && Math.abs(dx) / dtt >= T.flickSpeed && Math.abs(dx) > 1.5 * Math.abs(dy)) {
          out.flick = { dir: Math.sign(dx), from: { ...P.rest }, speed: Math.abs(dx) / dtt }; flickAt = t; P.hist = []; P.dwell = null;
          return out;
        }
      }
      if (t - flickAt < 300) return out;   // the hand is still settling after a flick: no dwell
      if (P.stable === 'point') {
        const q = out.cursor;
        if (!P.dwell || Math.hypot(P.dwell.x - q.x, P.dwell.y - q.y) > T.dwellRadius) P.dwell = { x: q.x, y: q.y, since: t, fired: false };
        out.dwell = clamp01((t - P.dwell.since) / T.dwellMs);
        if (!P.dwell.fired && t - P.dwell.since >= T.dwellMs) { out.select = { x: q.x, y: q.y }; P.dwell.fired = true; }
      } else P.dwell = null;
      return out;
    },
  };
}

/**
 * Applies gesture controls to an orbit camera {theta, phi, radius, target:[x,y,z]} (radians, scene units) and returns
 * the new state. `home` is the state a reset returns to. Pure, so tests can check the camera really responds.
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

/**
 * Synthetic hand for tests, the coach's glyphs and ?handsim=1: centre (cx, cy), size = wrist→middle-knuckle distance.
 * pose: 'palm' | 'point' | 'fist' | 'pinch' | 'thumbs' | 'open'. opts.gap (pinch only): thumb-index gap in palm sizes.
 */
export function synthHand(pose, cx = 0.5, cy = 0.5, size = 0.12, { gap = null, mirror = false } = {}) {
  const P = (x, y) => ({ x: cx + (mirror ? -x : x) * size, y: cy + y * size, z: 0 });
  const lm = new Array(21);
  const base = { 1: [-0.35, 0.65], 5: [-0.3, 0], 9: [0, -0.1], 13: [0.25, -0.05], 17: [0.45, 0.1] };
  lm[0] = P(0, 0.9); lm[9] = P(0, 0);
  for (const [k, [x, y]] of Object.entries(base)) lm[k] = P(x, y);
  const finger = (mcp, out) => {   // mcp index; 3 more joints straight up (extended) or curled back toward the wrist
    const [x, y] = base[mcp];
    for (let j = 1; j <= 3; j++) lm[mcp + j] = out ? P(x, y - 0.38 * j) : P(x + 0.05 * j, y + (j === 1 ? -0.25 : -0.25 + 0.3 * (j - 1)));
  };
  const ext = { palm: [1, 1, 1, 1], point: [1, 0, 0, 0], fist: [0, 0, 0, 0], thumbs: [0, 0, 0, 0], pinch: [1, 1, 1, 1], open: [1, 1, 0, 0], none: [1, 1, 0, 0] }[pose] || [1, 1, 0, 0];
  [5, 9, 13, 17].forEach((m, i) => finger(m, ext[i]));
  if (pose === 'palm' || pose === 'open' || pose === 'none') { lm[2] = P(-0.7, 0.45); lm[3] = P(-0.95, 0.25); lm[4] = P(-1.2, 0.05); }
  else if (pose === 'pinch') {   // thumb tip meets a slightly bent index tip
    lm[6] = P(-0.4, -0.35); lm[7] = P(-0.5, -0.6); lm[8] = P(-0.55, -0.75);
    lm[2] = P(-0.6, 0.35); lm[3] = P(-0.65, -0.2); lm[4] = P(-0.6, -0.72);
    if (gap != null) { const palm = palmSize(lm) / size; lm[4] = P(-0.55 - gap * palm, -0.75); lm[3] = P(-0.6 - gap * palm * 0.5, -0.2); }
  } else if (pose === 'thumbs') { lm[2] = P(-0.5, 0.3); lm[3] = P(-0.55, -0.15); lm[4] = P(-0.6, -0.6); }
  else { lm[2] = P(-0.45, 0.45); lm[3] = P(-0.3, 0.3); lm[4] = P(-0.1, 0.25); }   // thumb tucked
  return lm;
}
