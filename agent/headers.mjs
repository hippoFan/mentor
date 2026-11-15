// Custom boards: pin-exact holes on ANY board (a custom PCB, a breakout nobody has mapped) by reading its pin headers
// live. The brain gives each header roughly (first / last hole, holes per row, rows, silkscreen labels); this file
// lays every hole out on the 2.54 mm grid, snaps the grid onto the real holes (or pins) in the frame, fits a straight
// evenly spaced row (1D projective for one row, a homography for two, so perspective is exact), rejects anything
// that does not look like a real header, and builds a BoardSpec so board.mjs / tracker.mjs treat it like a library
// board: pinKey("D4") / pinKey("J1.5"), pinPoint, resolveMarks, wireGeometry, tracking the hole centres.
//
//   const c = customBoard(frame, reply.board);   // { board, spec, headers, twin, rejected } or { board: null, rejected }
//   c.board.pinPoint('J2.7') -> [x, y] normalised; c.twin -> the custom-board spec for the laptop twin (see twinSpec)
//   resolveCustom(frame, reply) -> { marks, board, twin, headers, rejected }  (marks with pin / pin2 snapped)
//
// Board mm for a custom board are a similarity of the frame the brain saw (u along the longest header, 2.54 mm per
// pitch), so tracking is exact (any fixed projective frame on the plane works) and the twin gets ~metric positions.
import { apply, boardFromH, homography, luma, resolveMarks, sample } from './board.mjs';

export const PITCH = 2.54;          // mm
export const MAX_HEADERS = 4;
export const MAX_COUNT = 40;        // holes per row
const MAX_TRACK = 40;               // hole centres seeded into the tracker

const fin = v => typeof v === 'number' && Number.isFinite(v);
const pair = a => Array.isArray(a) && a.length >= 2 && fin(a[0]) && fin(a[1]);
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

/**
 * Cleans one header from a (normalised) brain reply. Model output is untrusted: bounded, finite, short labels.
 * @returns {{label: string, rows: number, count: number, first: number[], last: number[], offset: number[] | null, labels: string[]} | null}
 */
export function cleanHeader(h) {
  if (!h || typeof h !== 'object') return null;
  const rows = h.rows === 2 ? 2 : h.rows === 1 || h.rows == null ? 1 : 0;
  const count = Number.isInteger(h.count) ? h.count : NaN;
  if (!rows || !(count >= 2 && count <= MAX_COUNT) || !pair(h.first) || !pair(h.last)) return null;
  const off = h.offset ?? h.second_row_offset;
  const offset = rows === 2 && pair(off) && (off[0] || off[1]) ? [off[0], off[1]] : null;
  const labels = Array.isArray(h.labels ?? h.pin_labels) ? (h.labels ?? h.pin_labels).slice(0, rows * count).map(s => clean(s, 10)) : [];
  return { label: clean(h.label, 8).replace(/[^A-Za-z0-9_+-]/g, ''), rows, count, first: [h.first[0], h.first[1]], last: [h.last[0], h.last[1]],
    offset, labels: labels.length === rows * count && labels.some(Boolean) ? labels : [] };
}

// ---------- hole scoring and snapping ----------

/** Hole (i, j) of a header model {M, d, p, o}: M = centre of row 0, d = unit row direction, p = pitch px, o = row offset px. */
const at = (g, N, i, j) => [g.M[0] + (i - (N - 1) / 2) * g.p * g.d[0] + j * g.o[0], g.M[1] + (i - (N - 1) / 2) * g.p * g.d[1] + j * g.o[1]];
const holesOf = (g, N, R) => { const out = []; for (let j = 0; j < R; j++) for (let i = 0; i < N; i++) out.push({ i, j, xy: at(g, N, i, j) }); return out; };

const CORE = [[0, 0], [0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]];
const RIM = [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];
const RING = Array.from({ length: 8 }, (_, k) => [0.29 * Math.cos(k * Math.PI / 4), 0.29 * Math.sin(k * Math.PI / 4)]);
/**
 * Mean contrast at every hole for one look (pol): 1 dark hole in plastic / board (rim - core), -1 bright pin (core -
 * rim), 2 bare pad (dark hole inside a bright ring: ring - core), -2 light through the hole of a duller pad. Higher
 * is better.
 */
function gridScore(img, g, N, R, pol) {
  const OUT = Math.abs(pol) === 2 ? RING : RIM, sg = pol < 0 ? -1 : 1;
  const n = [-g.d[1], g.d[0]];
  let s = 0, k = 0, tot = 0;
  for (const { xy: [x, y] } of holesOf(g, N, R)) {
    tot++;
    const v = ([a, b]) => sample(img, x + (a * g.d[0] + b * n[0]) * g.p, y + (a * g.d[1] + b * n[1]) * g.p);
    let c = 0, r = 0, r2 = 0, ok = true;
    for (const o of CORE) { const q = v(o); if (Number.isNaN(q)) { ok = false; break; } c += q; }
    if (!ok) continue;
    for (const o of OUT) { const q = v(o); if (Number.isNaN(q)) { ok = false; break; } r += q; r2 += q * q; }
    if (!ok) continue;
    c /= CORE.length; r /= OUT.length;
    s += sg * (r - c) / (10 + Math.sqrt(Math.max(0, r2 / OUT.length - r * r))); k++;
  }
  return k >= 0.6 * tot ? s / k : -Infinity;
}

// Point-symmetry pairs around a hole centre (fractions of a pitch): a hole, a pin, a pad ring are all point-symmetric
// about their centre, whatever the polarity; a shadow inside the hole (a crescent) is not, so it barely pulls.
const SYM = [];
for (const r of [0.1, 0.2, 0.3, 0.4, 0.5]) for (let k = 0; k < 8; k++) SYM.push([r * Math.cos(k * Math.PI / 8), r * Math.sin(k * Math.PI / 8)]);
function asym(img, x, y, p) {
  // normalised by the local variance: a flat patch is trivially symmetric but has no hole to centre on
  let s = 0, m = 0, m2 = 0;
  for (const [a, b] of SYM) {
    const u = sample(img, x + a * p, y + b * p), v = sample(img, x - a * p, y - b * p);
    if (Number.isNaN(u) || Number.isNaN(v)) return Infinity;
    s += (u - v) * (u - v); m += u + v; m2 += u * u + v * v;
  }
  const n = 2 * SYM.length, varr = m2 / n - (m / n) ** 2;
  return s / SYM.length / (2 * varr + 25);
}

/**
 * Centre of the hole near (x0, y0): the most point-symmetric spot within `reach` (grid, then halving steps to
 * ~0.05 px). strength = the blob's contrast against its surroundings (darkest or brightest vs the median), or null
 * when the window leaves the picture.
 */
function snapHole(img, x0, y0, p, reach, pol) {
  let best = [x0, y0], bc = asym(img, x0, y0, p);
  const st = 0.05 * p, n = Math.round(reach / st);
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    if (i * i + j * j > n * n) continue;
    const c = asym(img, x0 + i * st, y0 + j * st, p);
    if (c < bc) { bc = c; best = [x0 + i * st, y0 + j * st]; }
  }
  if (!Number.isFinite(bc)) return null;
  for (let step = st / 2; step > 0.04; step /= 2) {
    for (let moved = true, k = 0; moved && k < 8; k++) {
      moved = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = [best[0] + dx * step, best[1] + dy * step];
        if (Math.hypot(q[0] - x0, q[1] - y0) > reach) continue;
        const c = asym(img, q[0], q[1], p);
        if (c < bc) { bc = c; best = q; moved = true; }
      }
    }
  }
  const vals = [];
  const r = 0.4 * p, R = Math.max(2, Math.ceil(r));
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= r * r) vals.push(sample(img, best[0] + dx, best[1] + dy));
  if (vals.some(Number.isNaN)) return null;
  vals.sort((a, b) => a - b);
  const med = vals[vals.length >> 1], strength = pol > 0 ? med - vals[0] : vals[vals.length - 1] - med;
  return { x: best[0], y: best[1], strength };
}

/** Solves a small dense system (Gaussian elimination, partial pivoting); null if singular. */
function solveN(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

/**
 * One row seen in perspective: a weighted line through the holes, and along it s(i) = (a + b i) / (1 + c i), a 1D
 * projective map, so the holes stay collinear and evenly spaced on the board while the picture foreshortens them.
 * @returns {((i: number) => number[]) | null}
 */
function fitRow(dets) {
  if (dets.length < 3) return null;
  let W = 0, cx = 0, cy = 0;
  for (const d of dets) { W += d.w; cx += d.w * d.x; cy += d.w * d.y; }
  cx /= W; cy /= W;
  let sxx = 0, sxy = 0, syy = 0;
  for (const d of dets) { const x = d.x - cx, y = d.y - cy; sxx += d.w * x * x; sxy += d.w * x * y; syy += d.w * y * y; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let e = [Math.cos(th), Math.sin(th)];
  const a0 = dets[0], a1 = dets[dets.length - 1];
  if (((a1.x - a0.x) * e[0] + (a1.y - a0.y) * e[1]) * (a1.i - a0.i) < 0) e = [-e[0], -e[1]];
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  const proj = dets.length >= 4;
  for (const d of dets) {
    const s = (d.x - cx) * e[0] + (d.y - cy) * e[1];
    const row = proj ? [1, d.i, -d.i * s] : [1, d.i, 0];
    for (let r = 0; r < 3; r++) { B[r] += d.w * row[r] * s; for (let c = 0; c < 3; c++) A[r][c] += d.w * row[r] * row[c]; }
  }
  if (!proj) A[2][2] = 1;
  const sol = solveN(A, B);
  if (!sol) return null;
  const [a, b, c] = sol;
  return i => { const s = (a + b * i) / (1 + c * i); return [cx + s * e[0], cy + s * e[1]]; };
}

/** Two rows: a homography from the (i, j) hole grid to the picture. */
function fitGrid(dets) {
  const rows = new Set(dets.map(d => d.j));
  if (dets.length < 5 || rows.size < 2) return null;
  const H = homography(dets.map(d => [d.i, d.j]), dets.map(d => [d.x, d.y]), dets.map(d => d.w));
  return H && H.every(Number.isFinite) ? (i, j) => apply(H, i, j) : null;
}

/**
 * Finds one header in the picture from the brain's rough description (px). Rejects it (with a reason) when the holes
 * are not there, not evenly spaced, not in a straight row, or partly off the picture.
 * @param {{d: Float32Array, w: number, h: number}} img luma
 * @param {ReturnType<typeof cleanHeader>} hd header with first / last / offset in px
 * @returns {{ok: true, holes: {i: number, j: number, x: number, y: number, detected: boolean}[], pitch: number, polarity: number, score: number, residual: number}
 *   | {ok: false, reason: string}}
 */
export function fitHeader(img, hd) {
  const { w, h } = img, N = hd.count, R = hd.rows;
  const [fx, fy] = hd.first, [lx, ly] = hd.last;
  const len = Math.hypot(lx - fx, ly - fy), p0 = len / (N - 1);
  if (!(p0 >= 4)) return { ok: false, reason: `pitch ${p0.toFixed(1)} px is too small to see holes` };
  if (p0 > 0.25 * Math.min(w, h)) return { ok: false, reason: `pitch ${p0.toFixed(0)} px is implausibly large` };
  const d = [(lx - fx) / len, (ly - fy) / len], n = [-d[1], d[0]];
  // Second row: the brain's offset if it is about one pitch, else try both sides of the row.
  let offs = [[n[0] * p0, n[1] * p0], [-n[0] * p0, -n[1] * p0]];
  if (R === 2 && hd.offset) {
    const ol = Math.hypot(...hd.offset);
    if (ol > 0.6 * p0 && ol < 1.6 * p0) offs = [hd.offset];
  }
  if (R === 1) offs = [[0, 0]];
  const inside = (g, m) => holesOf(g, N, R).every(({ xy: [x, y] }) => x >= m && y >= m && x <= w - 1 - m && y <= h - 1 - m);
  const g0 = { M: [(fx + lx) / 2, (fy + ly) / 2], d, p: p0, o: offs[0] };
  if (!offs.some(o => inside({ ...g0, o }, 0))) return { ok: false, reason: 'header runs off the picture' };

  // 1) coarse: shift +-0.5 pitch, scale +-8 %, turn +-2.3 deg, both polarities, both sides for a 2nd row
  let best = null;
  const rotd = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
  for (const pol of [1, -1, 2, -2]) for (const o of offs) for (const da of [-0.04, 0, 0.04]) for (const sc of [0.92, 0.96, 1, 1.04, 1.08]) {
    const dd = rotd(d, da), oo = rotd(o, da);
    for (let ty = -5; ty <= 5; ty++) for (let tx = -5; tx <= 5; tx++) {
      const g = { M: [g0.M[0] + tx * 0.1 * p0, g0.M[1] + ty * 0.1 * p0], d: dd, p: sc * p0, o: oo };
      const s = gridScore(img, g, N, R, pol);
      if (!best || s > best.s) best = { s, g, pol };
    }
  }
  if (!best || !(best.s > -Infinity)) return { ok: false, reason: 'header runs off the picture' };
  // 2) refine all six parameters by coordinate descent, shrinking steps
  const { pol } = best;
  const P = [best.g.M[0], best.g.M[1], Math.atan2(best.g.d[1], best.g.d[0]), best.g.p, best.g.o[0], best.g.o[1]];
  const toG = q => ({ M: [q[0], q[1]], d: [Math.cos(q[2]), Math.sin(q[2])], p: q[3], o: [q[4], q[5]] });
  let bestS = best.s;
  for (let k = 1; k >= 1 / 8; k /= 2) {
    const steps = [0.1 * p0 * k, 0.1 * p0 * k, 0.4 / N * k, 0.03 * p0 * k, R === 2 ? 0.08 * p0 * k : 0, R === 2 ? 0.08 * p0 * k : 0];
    for (let pass = 0, improved = true; improved && pass < 4; pass++) {
      improved = false;
      for (let a = 0; a < 6; a++) for (const sg of [1, -1]) {
        if (!steps[a]) continue;
        const q = [...P]; q[a] += sg * steps[a];
        const s = gridScore(img, toG(q), N, R, pol);
        if (s > bestS + 1e-4) { bestS = s; P.splice(0, 6, ...q); improved = true; }
      }
    }
  }
  if (!(bestS > 0.35)) return { ok: false, reason: `no clear holes there (contrast ${bestS.toFixed(2)})` };
  const g = toG(P);
  // 3) each hole on its own: mean shift onto the blob
  const raw = holesOf(g, N, R).map(({ i, j, xy }) => {
    const s = snapHole(img, xy[0], xy[1], g.p, 0.3 * g.p, pol < 0 ? -1 : 1);
    return s ? { i, j, x: s.x, y: s.y, strength: s.strength } : { i, j, x: xy[0], y: xy[1], strength: 0 };
  });
  const strengths = raw.map(q => q.strength).sort((a, b) => a - b);
  const thr = Math.max(6, 0.35 * strengths[strengths.length >> 1]);
  let dets = raw.filter(q => q.strength >= thr).map(q => ({ ...q, w: Math.min(q.strength, 2 * thr) }));
  if (dets.length < 0.6 * raw.length) return { ok: false, reason: `only ${dets.length} of ${raw.length} holes found` };
  // 4) robust fit: straight, evenly spaced rows (perspective-exact); one round of outlier rejection
  const fitAll = ds => {
    if (R === 1) { const f = fitRow(ds); return f ? (i => f(i)) : null; }
    const f = fitGrid(ds); return f;
  };
  let model = fitAll(dets);
  if (!model) return { ok: false, reason: 'could not fit a row' };
  const resid = ds => ds.map(q => { const [x, y] = model(q.i, q.j); return Math.hypot(x - q.x, y - q.y); });
  let res = resid(dets);
  const med = [...res].sort((a, b) => a - b)[res.length >> 1];
  const keep = dets.filter((_, k) => res[k] <= Math.max(2.5 * med, 0.1 * g.p));
  if (keep.length < dets.length && keep.length >= 0.6 * raw.length) { dets = keep; model = fitAll(dets) || model; res = resid(dets); }
  const medRes = [...res].sort((a, b) => a - b)[res.length >> 1];
  const holes = raw.map(q => { const [x, y] = model(q.i, q.j); return { i: q.i, j: q.j, x, y, detected: dets.some(e => e.i === q.i && e.j === q.j) }; });
  const hole = (i, j) => holes[j * N + i];
  // A row whose end holes are not there is longer than the real header (count too high) or runs under something.
  for (let j = 0; j < R; j++) if (!hole(0, j).detected || !hole(N - 1, j).detected) return { ok: false, reason: `no hole at the ${hole(0, j).detected ? 'last' : 'first'} position of row ${j + 1} (wrong count or covered)` };

  // 5) sanity: pitch near what the brain implied, even along the row, straight, all of it in the picture
  const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let pm = 0;
  for (let j = 0; j < R; j++) pm += gap(hole(N - 1, j), hole(0, j)) / (N - 1);
  pm /= R;
  if (Math.abs(pm / p0 - 1) > 0.25) return { ok: false, reason: `pitch ${pm.toFixed(1)} px is ${Math.round(100 * (pm / p0 - 1))}% off the expected ${p0.toFixed(1)} px` };
  const ends = [gap(hole(1, 0), hole(0, 0)), gap(hole(N - 1, 0), hole(N - 2, 0))];
  if (ends[0] / ends[1] > 1.6 || ends[1] / ends[0] > 1.6) return { ok: false, reason: 'pitch changes too much along the row' };
  let bad = 0, gaps = 0;
  for (const q of raw) {
    if (q.i === N - 1 || q.strength < thr) continue;
    const r2 = raw[q.j * N + q.i + 1];
    if (r2.strength < thr) continue;
    const local = gap(hole(q.i + 1, q.j), hole(q.i, q.j));
    gaps++;
    if (Math.abs(gap(q, r2) / local - 1) > 0.25) bad++;
  }
  if (gaps < 0.5 * R * (N - 1) || bad > 0.15 * gaps) return { ok: false, reason: `uneven spacing (${bad} of ${gaps} gaps off by more than 25%)` };
  if (medRes > 0.12 * pm) return { ok: false, reason: `holes are not on a straight, even row (residual ${(medRes / pm).toFixed(2)} pitch)` };
  if (R === 2) {
    let rs = 0;
    for (let i = 0; i < N; i++) rs += gap(hole(i, 1), hole(i, 0));
    rs /= N * pm;
    if (rs < 0.7 || rs > 1.45) return { ok: false, reason: `rows are ${rs.toFixed(2)} pitch apart, not one` };
  }
  const m = 0.4 * pm;
  if (!holes.every(q => q.x >= m && q.y >= m && q.x <= w - 1 - m && q.y <= h - 1 - m)) return { ok: false, reason: 'header runs off the picture' };
  return { ok: true, holes, pitch: pm, polarity: pol, score: bestS, residual: medRes };
}

// ---------- pin names ----------

const norm = s => String(s ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/^PIN(?=.)/, '');
/** Common spellings of the same supply label: 3.3V / 3V3 / +3.3V, 5V / +5V / 5V0. */
const canon = s => {
  let k = norm(s).replace(/^\+/, '');
  if (/^3\.?3V?$|^3V3$/.test(k)) k = '3V3';
  if (/^5V0?$|^5\.0V$/.test(k)) k = '5V';
  if (/^GND\d*$|^VSS$|^0V$/.test(k)) k = 'GND';
  return k;
};
const digits = s => { const m = /^(?:GPIO|GP|IO|D|P)(\d{1,3})$/.exec(canon(s)); return m ? String(+m[1]) : null; };

/**
 * Pin-name resolver for a set of fitted headers: "J1.5" / "J1-5" / "J1 pin 5" (header label + pin number), a silkscreen
 * label ("D4", "3V3", "GND" = the first GND, "GND.2" the second), or a bare number when there is only one header.
 * Pins are numbered like a 2xN header (zigzag: 1 = row 1 first hole, 2 = row 2 first hole, ...).
 */
function makeKey(hdrs) {
  const byLabel = new Map(), byDigits = new Map(), counts = new Map();
  for (const h of hdrs) for (const p of h.pins) {
    if (!p.label) continue;
    const c = canon(p.label);
    const k = (counts.get(c) || 0) + 1; counts.set(c, k);
    if (k === 1) byLabel.set(c, p.key);
    byLabel.set(`${c}.${k}`, p.key);
    const dg = digits(p.label);
    if (dg) byDigits.set(dg, byDigits.has(dg) ? null : p.key);
  }
  const keys = new Set(hdrs.flatMap(h => h.pins.map(p => p.key)));
  return name => {
    const s = norm(name), sp = String(name ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!s) return null;
    for (const h of hdrs) {
      const L = h.label.toUpperCase();
      if (!sp.startsWith(L)) continue;
      const m = (/\d$/.test(L) ? /^(?:\s*[.\-_:#/]\s*|\s+)(?:PIN\s*)?(\d{1,2})$/ : /^\s*[.\-_:#/]?\s*(?:PIN\s*)?(\d{1,2})$/).exec(sp.slice(L.length));
      if (m && keys.has(`${h.label}.${+m[1]}`)) return `${h.label}.${+m[1]}`;
    }
    const c = canon(s);
    if (byLabel.has(c)) return byLabel.get(c);
    if (/^\d{1,2}$/.test(s) && hdrs.length === 1 && keys.has(`${hdrs[0].label}.${+s}`) && !byDigits.has(String(+s))) return `${hdrs[0].label}.${+s}`;
    const dg = digits(s) ?? (/^\d{1,3}$/.test(s) ? String(+s) : null);
    return dg && byDigits.get(dg) ? byDigits.get(dg) : null;
  };
}

// ---------- the custom board ----------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

/** Is p inside the convex polygon q (any winding), with a tolerance in the polygon's units? */
function inPoly(q, p, tol) {
  let sgn = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length], e = sub(b, a), l = Math.hypot(...e) || 1;
    const c = (e[0] * (p[1] - a[1]) - e[1] * (p[0] - a[0])) / l;
    if (Math.abs(c) <= tol) continue;
    if (sgn && Math.sign(c) !== sgn) return false;
    sgn = Math.sign(c);
  }
  return true;
}

/**
 * A registered board for a custom PCB, from the frame the brain saw and its `board` field (normalised; see brain.mjs).
 * @param {{data: Uint8Array, width: number, height: number}} frame RGBA
 * @param {{model?: string, corners?: number[][], headers?: any[]}} board
 * @returns {{board: object | null, spec?: object, headers?: object[], twin?: object, rejected: {label: string, reason: string}[]}}
 */
export function customBoard(frame, board) {
  const rejected = [];
  if (!frame || !board || !Array.isArray(board.headers)) return { board: null, rejected };
  const size = { w: frame.width, h: frame.height };
  const img = luma(frame);
  const fits = [];
  board.headers.slice(0, MAX_HEADERS).forEach((raw, k) => {
    const hd = cleanHeader(raw);
    const label0 = clean(raw?.label, 8).replace(/[^A-Za-z0-9_+-]/g, '') || `J${k + 1}`;
    if (!hd) { rejected.push({ label: label0, reason: 'bad header data' }); return; }
    const px = { ...hd, first: [hd.first[0] * size.w, hd.first[1] * size.h], last: [hd.last[0] * size.w, hd.last[1] * size.h],
      offset: hd.offset ? [hd.offset[0] * size.w, hd.offset[1] * size.h] : null };
    const f = fitHeader(img, px);
    if (!f.ok) { rejected.push({ label: label0, reason: f.reason }); return; }
    fits.push({ hd, f, k });
  });
  if (!fits.length) return { board: null, rejected };
  // Unique header labels: the silkscreen name, else J1, J2... (by the brain's order).
  const used = new Set();
  const hdrs = fits.map(({ hd, f, k }) => {
    let label = hd.label || `J${k + 1}`;
    for (let n = 2; used.has(label.toUpperCase()); n++) label = `${hd.label || 'J'}${hd.label ? `_${n}` : k + n}`;
    used.add(label.toUpperCase());
    const N = hd.count;
    // zigzag numbering for 2 rows (pin 1 row 1, pin 2 row 2, ...), straight for 1
    const pins = f.holes.map(q => {
      const num = hd.rows === 2 ? 2 * q.i + q.j + 1 : q.i + 1;
      return { key: `${label}.${num}`, num, row: q.j, index: q.i, label: hd.labels[num - 1] || null, px: [q.x, q.y], detected: q.detected };
    }).sort((a, b) => a.num - b.num);
    return { label, rows: hd.rows, count: N, pitchPx: f.pitch, polarity: f.polarity, score: f.score, residualPx: f.residual, pins, holes: f.holes };
  });

  // Board mm: a similarity of this frame, u along the longest header, 2.54 mm per pitch of it.
  const main = hdrs.reduce((a, b) => (b.rows * b.count > a.rows * a.count ? b : a));
  const mh = (i, j) => main.holes[j * main.count + i];
  const dv = sub([mh(main.count - 1, 0).x, mh(main.count - 1, 0).y], [mh(0, 0).x, mh(0, 0).y]), dl = Math.hypot(...dv);
  const d = [dv[0] / dl, dv[1] / dl], s = main.pitchPx / PITCH;      // px per mm
  const toMm = (p, O) => { const r = sub(p, O); return [(r[0] * d[0] + r[1] * d[1]) / s, (-r[0] * d[1] + r[1] * d[0]) / s]; };
  const zero = [0, 0];
  const holeMm = hdrs.flatMap(hh => hh.pins.map(p => toMm(p.px, zero)));
  // The brain's PCB outline, if it is a believable convex quad that holds every hole.
  let outline = null;
  const bc = Array.isArray(board.corners) && board.corners.length === 4 && board.corners.every(pair) ? board.corners.map(c => toMm([c[0] * size.w, c[1] * size.h], zero)) : null;
  if (bc) {
    const cx = bc.reduce((a, c) => a + c[0], 0) / 4, cy = bc.reduce((a, c) => a + c[1], 0) / 4;
    const q = [...bc].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));   // clockwise (y down)
    let convex = true;
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4]; if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 0) convex = false; }
    if (convex && holeMm.every(p => inPoly(q, p, 1.5))) outline = q;
  }
  const pts = outline || holeMm;
  const pad = outline ? 0 : 3;
  const minU = Math.min(...pts.map(p => p[0])) - pad, minV = Math.min(...pts.map(p => p[1])) - pad;
  const W = Math.max(...pts.map(p => p[0])) + pad - minU, Hh = Math.max(...pts.map(p => p[1])) + pad - minV;
  // origin O (px) of board (0, 0): board -> image is p = O + s * R^T [u, v]
  const O = [minU * s * d[0] - minV * s * d[1], minU * s * d[1] + minV * s * d[0]];
  const H = [s * d[0], -s * d[1], O[0], s * d[1], s * d[0], O[1], 0, 0, 1];
  const pinsMm = {};
  for (const hh of hdrs) for (const p of hh.pins) { const [u, v] = toMm(p.px, O); p.u = u; p.v = v; pinsMm[p.key] = { u, v }; }
  const outlineMm = outline ? outline.map(([u, v]) => [u - minU, v - minV]) : null;

  // Tracker points. Mid-row holes are bad features (identical holes slide along the row), so: the end holes of every
  // row (2D structure), the PCB corners when the outline is known, and a grid over the board like library boards.
  const ends = hdrs.flatMap(hh => hh.pins.filter(p => p.index === 0 || p.index === hh.count - 1).map(p => [p.u, p.v]));
  const [nu, nv] = W >= Hh ? [5, 3] : [3, 5], grid = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) grid.push([W * (0.15 + 0.7 * i / (nu - 1)), Hh * (0.22 + 0.56 * j / (nv - 1))]);
  const track = [...ends, ...(outlineMm || []), ...grid].slice(0, MAX_TRACK);
  const twin = twinSpec(hdrs, W, Hh, outlineMm);
  const spec = {
    id: 'custom', name: 'Custom board', W, H: Hh, pins: pinsMm, corners: [[0, 0], [W, 0], [W, Hh], [0, Hh]],
    headerTop: 0, polarity: main.polarity < 0 ? -1 : 1, key: makeKey(hdrs), track, minArea: 0, custom: twin,
  };
  const b = boardFromH(H, size, spec);
  if (!b) return { board: null, rejected: [...rejected, { label: '*', reason: 'board pose implausible' }] };
  const headers = hdrs.map(({ holes, ...hh }) => ({ ...hh, pins: hh.pins.map(p => ({ ...p, xy: [p.px[0] / size.w, p.px[1] / size.h] })) }));
  return { board: b, spec, headers, twin, rejected };
}

/**
 * The custom-board spec the laptop twin renders: board-relative mm (u right, v down, origin at the outline's / holes'
 * top-left), each header on an exact 2.54 mm grid anchored at its measured centre and direction.
 * @returns {{kind: 'custom-board', key: string, name: string, units: 'mm', W: number, H: number, outline: number[][] | null,
 *   style: {holes: 'dark' | 'bright' | 'pad'}, headers: {label: string, rows: number, count: number, pitch: number, origin: number[], dir: number[],
 *   rowDir: number[] | null, pins: {name: string, num: number, row: number, index: number, label: string | null, u: number, v: number}[]}[]}}
 */
function twinSpec(hdrs, W, H, outline) {
  const r2 = v => Math.round(v * 100) / 100;
  const headers = hdrs.map(hh => {
    const N = hh.count, P = (i, j) => hh.pins.find(p => p.index === i && p.row === j);
    const a = P(0, 0), b = P(N - 1, 0), dl = Math.hypot(b.u - a.u, b.v - a.v);
    const dir = [(b.u - a.u) / dl, (b.v - a.v) / dl];
    let rowDir = null;
    if (hh.rows === 2) { let x = 0, y = 0; for (let i = 0; i < N; i++) { x += P(i, 1).u - P(i, 0).u; y += P(i, 1).v - P(i, 0).v; } const l = Math.hypot(x, y); rowDir = [x / l, y / l]; }
    const cu = hh.pins.reduce((s, p) => s + p.u, 0) / hh.pins.length, cv = hh.pins.reduce((s, p) => s + p.v, 0) / hh.pins.length;
    const reg = (i, j) => {
      const ti = (i - (N - 1) / 2) * PITCH, tj = rowDir ? (j - 0.5) * PITCH : 0;
      return [cu + ti * dir[0] + tj * (rowDir?.[0] || 0), cv + ti * dir[1] + tj * (rowDir?.[1] || 0)];
    };
    const pins = hh.pins.map(p => { const [u, v] = reg(p.index, p.row); return { name: p.key, num: p.num, row: p.row, index: p.index, label: p.label, u: r2(u), v: r2(v) }; });
    return { label: hh.label, rows: hh.rows, count: N, pitch: PITCH, origin: [pins[0].u, pins[0].v], dir: dir.map(r2), rowDir: rowDir && rowDir.map(r2), pins };
  });
  return {
    kind: 'custom-board', key: `custom:${headers.map(h => `${h.label}:${h.rows}x${h.count}`).join(',')}`, name: 'Custom board', units: 'mm',
    W: r2(W), H: r2(H), outline: outline && outline.map(p => p.map(r2)), style: { holes: ({ 1: 'dark', '-1': 'bright', 2: 'pad', '-2': 'pad' })[hdrs[0].polarity] }, headers,
  };
}

/**
 * For the agent: a brain reply -> marks with pin / pin2 on their exact holes, the board, and the twin spec.
 * (tracker.seed does the same through board.mjs boardFromReply; use this when not tracking.)
 */
export function resolveCustom(frame, reply) {
  const c = customBoard(frame, reply?.board);
  return { marks: resolveMarks(reply?.marks || [], c.board), board: c.board, twin: c.twin || null, headers: c.headers || [], rejected: c.rejected };
}
