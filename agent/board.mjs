// Board registration: turns "pin 13" / "GPIO17" / "D5" into the exact header hole or pin on the caller's video.
// The brain gives the 4 PCB corners of a known board; a homography maps board millimetres to the image, and a pose
// recovered from it (assumed phone focal length) lifts points off the board plane: UNO / Mega holes sit on top of 8.5 mm
// female headers, Pi pins stick up 8.5 mm, Nano / ESP32 / Pico pins point down (z ~ 1 mm: the solder joint on top).
// Pin geometry: data/uno-pins.json (UNO, from wokwi-elements, MIT; snapped to the official 0.1" grid) and
// data/parts/<id>.json for every other board, with the corner order in data/parts/orientation.json.
//
//   const b = createBoard(cornersPx, { w, h }, 'raspberry-pi-4');   // null if the quad is not a believable board
//   b.pinPoint('GPIO17') -> [x, y] normalised image point of that pin (top of the header)
//   resolveMarks(marks, b)                                           // marks with pin/pin2 snapped to their holes
import { readFileSync } from 'node:fs';
import { partTable, UNO_MODELS } from './twin/partpins.js';
import { customBoard } from './headers.mjs';

const json = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
export const UNO = json('./data/uno-pins.json');
const PART_INDEX = json('./data/parts/index.json');
const ORIENT = json('./data/parts/orientation.json');
const UNO_CORNERS = ['A', 'B', 'C', 'D'].map(k => UNO.corners[k]);

/** Canonical UNO pin key ("13", "GND.1", "5V", "A0"...) for what a model or person might write, or null. */
export function pinName(s) {
  if (s == null) return null;
  let k = String(s).trim().toUpperCase().replace(/\s+/g, '').replace(/^PIN/, '');
  if (!k) return null;
  if (/^D\d{1,2}$/.test(k)) k = k.slice(1);
  if (/^GND\d$/.test(k)) k = `GND.${k[3]}`;
  k = UNO.aliases[k] || k;
  return Object.hasOwn(UNO.pins, k) ? k : null;
}

/** Tracker points (board mm): the 4 corners plus a textured interior grid. */
const trackGrid = (corners, W, H) => {
  const [nu, nv] = W >= H ? [5, 3] : [3, 5];
  const out = [...corners];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) out.push([W * (0.15 + 0.7 * i / (nu - 1)), H * (0.22 + 0.56 * j / (nv - 1))]);
  return out;
};

/**
 * One registrable board: pins (u, v mm), corners A..D (u, v mm), header height, and its pin-name resolver.
 * @typedef {{id: string, name: string, W: number, H: number, pins: Record<string, {u: number, v: number}>, corners: number[][],
 *   headerTop: number, polarity: number, key: (name: any) => string | null, track: number[][]}} BoardSpec
 */
/** @type {BoardSpec} */
const UNO_SPEC = {
  id: 'arduino-uno', name: 'Arduino UNO', W: UNO.corners.B[0], H: UNO.corners.A[1], pins: UNO.pins, corners: UNO_CORNERS,
  headerTop: UNO.headerTop, polarity: 1, key: pinName,
  track: [...UNO_CORNERS, ...[10, 22, 34, 46, 58].flatMap(u => [12, 24, 36].map(v => [u, v]))],
};
const SPECS = new Map();
/** The board spec for a model id ("uno-r3", "raspberry-pi-4", ...), or null if it can't be registered. */
export function boardSpec(model) {
  if (model && typeof model === 'object' && model.pins) return model;
  if (UNO_MODELS.includes(model) || model === 'arduino-uno') return UNO_SPEC;
  if (SPECS.has(model)) return SPECS.get(model);
  const entry = PART_INDEX.parts[model], o = ORIENT[model];
  if (!entry || !o?.corners) return null;
  const t = partTable(json(`./data/parts/${entry.file}`), o);
  const corners = ['A', 'B', 'C', 'D'].map(k => t.corners[k]);
  const spec = { id: model, name: t.name, W: t.W, H: t.H, pins: t.pins, corners, headerTop: t.headerTop, polarity: t.polarity,
    key: name => t.resolve(name), info: t.info, track: trackGrid(corners, t.W, t.H) };
  SPECS.set(model, spec);
  return spec;
}
/** Every model the brain can name for which pins can be registered. */
export const BOARD_MODELS = new Set([...UNO.models, 'arduino-uno', ...Object.keys(ORIENT).filter(k => !k.startsWith('_') && PART_INDEX.parts[k])]);

// The board the tracker is following. tracker.mjs re-fits with boardFromH(H, size) and seeds TRACK_POINTS, without
// knowing the model, so boardFromReply (its seed) sets both here. One call at a time per agent process.
let current = UNO_SPEC;
/** Points on the current board (mm) for the tracker to follow (live binding: changes with the board in view). */
export let TRACK_POINTS = UNO_SPEC.track;

// ---------- small linear algebra ----------

/** Solves A x = b (n x n, Gaussian elimination with partial pivoting). Returns null if singular. */
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Similarity that centres points and scales them to mean distance sqrt(2) (Hartley normalisation). */
function normT(pts) {
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let d = 0;
  for (const [x, y] of pts) d += Math.hypot(x - mx, y - my);
  const s = Math.SQRT2 / (d / pts.length || 1);
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

const mul = (A, B) => {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
};
export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
export const apply = (H, x, y) => {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
};

/**
 * Least-squares homography src -> dst (n >= 4 point pairs, optional weights), h33 = 1, Hartley-normalised.
 * @returns {number[] | null} row-major 3x3
 */
export function homography(src, dst, weights) {
  if (src.length < 4) return null;
  const Ts = normT(src), Td = normT(dst);
  const s = src.map(([x, y]) => apply(Ts, x, y)), d = dst.map(([x, y]) => apply(Td, x, y));
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0)), Atb = new Array(8).fill(0);
  const add = (row, rhs, w) => {
    for (let i = 0; i < 8; i++) { Atb[i] += w * row[i] * rhs; for (let j = 0; j < 8; j++) AtA[i][j] += w * row[i] * row[j]; }
  };
  for (let k = 0; k < s.length; k++) {
    const [x, y] = s[k], [u, v] = d[k], w = weights ? weights[k] : 1;
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u, w);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v, w);
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  const Hn = [...h, 1], TdInv = invert3(Td);
  if (!TdInv) return null;
  const H = mul(TdInv, mul(Hn, Ts));
  return H.map(v => v / H[8]);
}

// ---------- the board ----------

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * A registered board from its image homography (board mm -> image px).
 * @param {number[]} H  @param {{w:number,h:number}} size frame size in px
 * @param {string | BoardSpec} [model] defaults to the board the tracker is following (the UNO until another is seeded)
 * @returns {object | null} null when the homography is not a believable view of that board
 */
export function boardFromH(H, size, model = current) {
  if (!H || !H.every(Number.isFinite)) return null;
  const spec = boardSpec(model);
  if (!spec) return null;
  const { w, h } = size;
  const BW = spec.W, BH = spec.H;
  const quad = spec.corners.map(([u, v]) => apply(H, u, v));
  if (!quad.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return null;
  // Convex and clockwise on screen (y down) as A -> B -> C -> D: we always see the board's top face, never its mirror.
  for (let i = 0; i < 4; i++) if (cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]) <= 0) return null;
  const area = Math.abs(quad.reduce((s, p, i) => s + p[0] * quad[(i + 1) % 4][1] - quad[(i + 1) % 4][0] * p[1], 0)) / 2;
  if (area < (spec.minArea ?? 0.02) * w * h || area > 25 * w * h) return null;
  // Pose from the homography with an assumed phone focal length (~ 66 deg across the long side).
  const f = 0.8 * Math.max(w, h), cx = w / 2, cy = h / 2;
  const Kinv = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
  const M = mul(Kinv, H);
  const col = j => [M[j], M[3 + j], M[6 + j]];
  let m1 = col(0), m2 = col(1), m3 = col(2);
  const n1 = Math.hypot(...m1), n2 = Math.hypot(...m2);
  const ratio = n1 / n2;   // mm-scale along u vs v: ~1 for a real (rigid, square-pixel) board
  const cos = (m1[0] * m2[0] + m1[1] * m2[1] + m1[2] * m2[2]) / (n1 * n2);
  if (ratio < 0.55 || ratio > 1.8 || Math.abs(cos) > 0.45) return null;
  let lam = 2 / (n1 + n2);
  if (m3[2] * lam < 0) lam = -lam;   // board in front of the camera
  const r1 = m1.map(v => v * lam), r2 = m2.map(v => v * lam), t = m3.map(v => v * lam);
  // r3 = r1 x r2 points out of the board's top face (toward the camera when seen from above).
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const nr3 = Math.hypot(...r3);
  for (let i = 0; i < 3; i++) r3[i] /= nr3;
  const project = (u, v, z = 0) => {
    const X = u * r1[0] + v * r2[0] + z * r3[0] + t[0], Y = u * r1[1] + v * r2[1] + z * r3[1] + t[1];
    const Z = Math.max(1e-6, u * r1[2] + v * r2[2] + z * r3[2] + t[2]);
    return [cx + f * X / Z, cy + f * Y / Z];
  };
  const Hinv = invert3(H);
  const pxPerMm = Math.sqrt(area / (BW * BH));
  const camDist = Math.hypot(BW / 2 * r1[0] + BH / 2 * r2[0] + t[0], BW / 2 * r1[1] + BH / 2 * r2[1] + t[1], BW / 2 * r1[2] + BH / 2 * r2[2] + t[2]);
  return {
    H, Hinv, w, h, quad, pxPerMm, camDist, part: spec,
    /** board mm (z mm above the top face) -> image px */
    project,
    /** board mm -> normalised image point */
    norm: (u, v, z = 0) => { const [x, y] = project(u, v, z); return [x / w, y / h]; },
    /** normalised image point -> board mm on the z=0 plane */
    toBoard: (nx, ny) => (Hinv ? apply(Hinv, nx * w, ny * h) : null),
    /** Canonical pin key on this board, or null. */
    pinKey: name => spec.key(name),
    pin: name => { const k = spec.key(name); return k ? spec.pins[k] : null; },
    /** Normalised image point of a pin: top of the female header / male pin, or the solder joint on top. */
    pinPoint(name) { const p = this.pin(name); return p ? this.norm(p.u, p.v, spec.headerTop) : null; },
    corners: () => quad.map(([x, y]) => [x / w, y / h]),
  };
}

/**
 * @param {number[][]} corners 4 points [x, y] normalised 0..1 (A, B, C, D as defined in uno-pins.json / orientation.json)
 * @param {{w:number,h:number}} size frame size in px (aspect matters for the pose)
 * @param {string | BoardSpec} [model] board model id (default: the UNO)
 */
export function createBoard(corners, size, model = 'uno-r3') {
  const spec = boardSpec(model);
  if (!spec || !Array.isArray(corners) || corners.length !== 4) return null;
  const dst = corners.map(c => [Number(c?.[0]) * size.w, Number(c?.[1]) * size.h]);
  if (!dst.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return null;
  return boardFromH(homography(spec.corners, dst), size, spec);
}

/**
 * Board from a brain reply's `board` field, or null (not a known board, no corners, or an implausible quad).
 * With the frame the brain saw, the corners are first snapped to the header holes / pins in the picture (refineCorners).
 * Also makes this the board the tracker follows (boardFromH's default and TRACK_POINTS).
 */
export function boardFromReply(board, size, frame = null) {
  if (!board) return null;
  // Not a library board (model "other", a sensor breakout, a custom PCB): read its pin headers live (headers.mjs).
  if (!BOARD_MODELS.has(board.model)) return frame && board.headers?.length ? customFromReply(board, frame) : null;
  const spec = boardSpec(board.model);
  current = spec; TRACK_POINTS = spec.track;
  const corners = frame ? refineCorners(frame, board.corners, spec).corners : board.corners;
  return createBoard(corners, size, spec);
}

/** A custom board from the headers the brain saw; becomes the tracked board when at least one header checks out. */
function customFromReply(board, frame) {
  const c = customBoard(frame, board);
  const why = c.rejected.map(r => `${r.label}: ${r.reason}`).join('; ');
  if (!c.board) { if (why) console.log(`[board] custom board not registered (${why})`); return null; }
  console.log(`[board] custom board: ${c.headers.map(h => `${h.label} ${h.rows}x${h.count}`).join(', ')}${why ? `; skipped ${why}` : ''}`);
  current = c.spec; TRACK_POINTS = c.spec.track;
  return c.board;
}

// ---------- snapping the model's corners to the real header holes ----------

/** Luma of an RGBA frame as Float32 (0..255). */
export function luma(frame) {
  const { data, width: w, height: h } = frame, out = new Float32Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return { d: out, w, h };
}
export function sample({ d, w, h }, x, y) {
  if (!(x >= 0 && y >= 0 && x < w - 1 && y < h - 1)) return NaN;
  const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, i = y0 * w + x0;
  return (d[i] * (1 - ax) + d[i + 1] * ax) * (1 - ay) + (d[i + w] * (1 - ax) + d[i + w + 1] * ax) * ay;
}
// Around each hole (header-top plane, mm): the hole itself, and the plastic between holes / around the row.
const CORE = [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]];
const RIM = [[1.27, 0], [-1.27, 0], [0, 1.0], [0, -1.0], [1.27, 1.0], [-1.27, 1.0], [1.27, -1.0], [-1.27, -1.0]];

/**
 * How well a board's header holes line up with dark holes in the picture (or, for male pins / solder joints, bright
 * points: spec.polarity -1): mean (rim - hole) brightness, normalised by the local contrast. Higher is better.
 */
function holeScore(img, b) {
  const { pins, headerTop, polarity } = b.part;
  let s = 0, n = 0;
  for (const p of Object.values(pins)) {
    let c = 0, r = 0, r2 = 0, ok = true;
    for (const [du, dv] of CORE) { const [x, y] = b.project(p.u + du, p.v + dv, headerTop); const v = sample(img, x, y); if (Number.isNaN(v)) { ok = false; break; } c += v; }
    if (!ok) continue;
    for (const [du, dv] of RIM) { const [x, y] = b.project(p.u + du, p.v + dv, headerTop); const v = sample(img, x, y); if (Number.isNaN(v)) { ok = false; break; } r += v; r2 += v * v; }
    if (!ok) continue;
    c /= CORE.length; r /= RIM.length;
    const sd = Math.sqrt(Math.max(0, r2 / RIM.length - r * r));
    s += polarity * (r - c) / (12 + sd); n++;
  }
  return n >= 12 ? s / n : -Infinity;
}

/**
 * Snaps the brain's 4 corners (normalised) so the header holes (UNO: 31) land on the holes / pins in `frame`: a
 * translation grid search, then coordinate descent on all 8 corner coordinates, bounded to ~3 mm. Keeps the model's
 * corners when the holes cannot be seen (no clear gain).
 * @param {string | BoardSpec} [model] board model id (default: the UNO)
 * @returns {{ corners: number[][], gain: number, moved: number }} gain = score improvement, moved = max corner shift in mm
 */
export function refineCorners(frame, corners, model = 'uno-r3') {
  const size = { w: frame.width, h: frame.height };
  const b0 = createBoard(corners, size, model);
  if (!b0) return { corners, gain: 0, moved: 0 };
  const img = luma(frame);
  const at = c => { const b = createBoard(c, size, model); return b ? holeScore(img, b) : -Infinity; };
  const mm = b0.pxPerMm, start = holeScore(img, b0);
  const toPx = c => c.map(([x, y]) => [x * size.w, y * size.h]), toN = c => c.map(([x, y]) => [x / size.w, y / size.h]);
  const orig = toPx(corners);
  let best = orig, bestS = start;
  // 1) shift the whole board: +-1.5 mm in 0.15 mm steps (the model is usually a fraction of a pitch off)
  for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
    const c = orig.map(([x, y]) => [x + dx * 0.15 * mm, y + dy * 0.15 * mm]);
    const s = at(toN(c));
    if (s > bestS) { bestS = s; best = c; }
  }
  // 2) each corner coordinate on its own, shrinking steps
  for (let step = 0.6 * mm; step >= 0.05 * mm; step /= 2) {
    for (let pass = 0, improved = true; improved && pass < 6; pass++) {
      improved = false;
      for (let k = 0; k < 8; k++) for (const sgn of [1, -1]) {
        const c = best.map(p => [...p]);
        c[k >> 1][k & 1] += sgn * step;
        if (Math.hypot(c[k >> 1][0] - orig[k >> 1][0], c[k >> 1][1] - orig[k >> 1][1]) > 3 * mm) continue;
        const s = at(toN(c));
        if (s > bestS + 1e-4) { bestS = s; best = c; improved = true; }
      }
    }
  }
  const moved = Math.max(...best.map((p, i) => Math.hypot(p[0] - orig[i][0], p[1] - orig[i][1]))) / mm;
  const gain = bestS - start;
  // Only trust it when the holes really show up (clear contrast once aligned).
  if (!(bestS > 0.6 && gain > 0.05)) return { corners, gain, moved: 0, score: bestS };
  return { corners: toN(best), gain, moved, score: bestS };
}

/**
 * Snaps marks whose pin / pin2 name a header hole onto the exact hole. Unknown pins keep the model's point.
 * Adds pinKey / pin2Key so the tracker can keep them registered.
 */
export function resolveMarks(marks, board) {
  return (marks || []).map(m => {
    const n = { ...m };
    const k1 = board ? board.pinKey(m.pin) : null, k2 = board && m.kind === 'wire' ? board.pinKey(m.pin2) : null;
    if (k1) { [n.x, n.y] = board.pinPoint(k1); n.pinKey = k1; }
    if (k2) { [n.x2, n.y2] = board.pinPoint(k2); n.pin2Key = k2; }
    return n;
  });
}

// ---------- 3D jumper geometry ----------

const WIRE_N = 28;
const PLUG = 9;           // mm: the jumper's dark plug housing above the hole
const TUBE = 1.9;         // mm: cable diameter

/**
 * Geometry of a jumper from end a to end b, in normalised image coords.
 * Each end is { pin: key } (a header hole: starts at the header top) or { x, y } (an image point: back-projected onto
 * the board plane, e.g. a breadboard hole next to the board).
 * @returns {{ path: number[][], shadow: number[][], plugs: number[][][], rings: number[][][], width: number, plugWidth: number } | null}
 */
export function wireGeometry(board, a, b) {
  if (!board) return null;
  const end = e => {
    if (e.pin) { const p = board.part.pins[e.pin]; return p ? { u: p.u, v: p.v, z: board.part.headerTop, pin: true } : null; }
    const q = board.toBoard(e.x, e.y);
    return q && q.every(Number.isFinite) ? { u: q[0], v: q[1], z: 0, pin: false } : null;
  };
  const P = end(a), Q = end(b);
  if (!P || !Q) return null;
  const d = Math.hypot(Q.u - P.u, Q.v - P.v);
  if (d > 400) return null;   // back-projection blew up (point near the horizon)
  // The arc rises above the higher plug top; never too close to the (estimated) camera, or perspective blows it up.
  const lift = Math.max(4, Math.min(8 + 0.5 * d, 45, 0.2 * board.camDist));
  const p0 = [P.u, P.v, P.z + PLUG], p3 = [Q.u, Q.v, Q.z + PLUG];
  const top = Math.max(p0[2], p3[2]) + lift;
  const p1 = [P.u + (Q.u - P.u) * 0.12, P.v + (Q.v - P.v) * 0.12, top], p2 = [Q.u + (P.u - Q.u) * 0.12, Q.v + (P.v - Q.v) * 0.12, top];
  const bez = t => [0, 1, 2].map(i => {
    const s = 1 - t;
    return s * s * s * p0[i] + 3 * s * s * t * p1[i] + 3 * s * t * t * p2[i] + t * t * t * p3[i];
  });
  const path = [], shadow = [];
  // Light from the upper left of the board: the shadow falls a little toward +u, -v, flattened onto the table plane.
  for (let i = 0; i <= WIRE_N; i++) {
    const [u, v, z] = bez(i / WIRE_N);
    path.push(board.norm(u, v, z));
    shadow.push(board.norm(u + z * 0.35, v - z * 0.25, 0));
  }
  const plug = E => [board.norm(E.u, E.v, E.z), board.norm(E.u, E.v, E.z + PLUG)];
  const ring = E => Array.from({ length: 24 }, (_, i) => {
    const th = (i / 24) * Math.PI * 2;
    return board.norm(E.u + 1.7 * Math.cos(th), E.v + 1.7 * Math.sin(th), E.z);
  });
  return {
    path, shadow, plugs: [plug(P), plug(Q)], rings: [ring(P), ring(Q)],
    width: (TUBE * board.pxPerMm) / board.w, plugWidth: (2.5 * board.pxPerMm) / board.w,
  };
}
