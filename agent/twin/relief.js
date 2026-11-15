// "Scan anything", the photo relief: the camera photo of the object, cut out by its segmentation mask and pushed out by
// a monocular depth map (Depth Anything V2 Small, run by the agent: depth.mjs -> {type:'scan-depth'}), with a mirrored
// back so it reads as a solid from any angle. It sits in the same frame as the primitive assembly (scan.js) and swaps
// with it: the relief is the "looks like the real thing" view; the parts come back for Explode, X-ray and part edits.
import * as THREE from 'three';
import { holoMaterial } from './holo.js';
import { subscribe } from './shell.js';

const GRID = 128;   // cells along the crop's longer side
const depths = new Map();   // scan id -> {depth: base64 png, width, height, near, far}

/** The agent's depth payload, shape-checked (it is our own agent's data, but never trust a socket). */
function okDepth(d) {
  if (!d || typeof d !== 'object' || typeof d.depth !== 'string' || d.depth.length > 600_000 || !/^[A-Za-z0-9+/=]+$/.test(d.depth)) return null;
  return { depth: d.depth };
}
try {
  subscribe(ev => {
    if (!ev || typeof ev.type !== 'string') return;
    if (ev.type === 'hello') { depths.clear(); for (const s of Array.isArray(ev.scans) ? ev.scans : []) { const d = okDepth(s?.depth); if (d && Number.isFinite(Number(s.id))) depths.set(Number(s.id), d); } }
    else if (ev.type === 'scan' && Number.isFinite(Number(ev.id))) { const d = okDepth(ev.depth); if (d) depths.set(Number(ev.id), d); else depths.delete(Number(ev.id)); }
    else if (ev.type === 'scan-depth' && Number.isFinite(Number(ev.id))) { const d = okDepth(ev); if (d) depths.set(Number(ev.id), d); }
  });
} catch (e) { console.warn('[twin] relief feed', e); }

let wantRelief = true;   // the viewer's choice (Relief / Parts), kept across scans
const btn = id => document.getElementById(id);
function wireButtons() {
  const r = btn('t-relief'), p = btn('t-parts');
  if (!r || r.dataset.wired) return;
  r.dataset.wired = p.dataset.wired = '1';
  r.addEventListener('click', () => { wantRelief = true; });
  p.addEventListener('click', () => { wantRelief = false; });
}

const loadImg = src => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
function pixels(img, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Builds the relief geometry for a built scan (scan.js buildScan result, photo loaded).
 * @param {object} built buildScan's result (needs built.proj and built.atlas.userData.mask)
 * @param {HTMLImageElement} depthImg the 8-bit depth PNG (255 = near) of the same crop
 * @returns {{front: THREE.BufferGeometry, back: THREE.BufferGeometry, stats: object} | null}
 */
export function reliefGeometry(built, depthImg) {
  const P = built.proj, mask = built.atlas.userData.mask, crop = built.atlas.userData.img;
  if (!P || !crop) return null;
  const aspect = crop.naturalWidth / Math.max(1, crop.naturalHeight);
  const nx = aspect >= 1 ? GRID : Math.max(8, Math.round(GRID * aspect)), ny = aspect >= 1 ? Math.max(8, Math.round(GRID / aspect)) : GRID;
  const vx = nx + 1, vy = ny + 1, N = vx * vy;
  // depth at grid resolution (the browser resamples the PNG), 0..1, 1 = near
  const dp = pixels(depthImg, vx, vy), d = new Float32Array(N);
  for (let k = 0; k < N; k++) d[k] = dp[k * 4] / 255;
  // object coverage per grid vertex: the mask averaged over the vertex's cell; no mask -> the bbox rectangle
  const m = new Float32Array(N);
  if (mask) {
    const { w, h, data } = mask;
    for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
      const x0 = Math.floor((i - 0.5) / nx * w), x1 = Math.ceil((i + 0.5) / nx * w), y0 = Math.floor((j - 0.5) / ny * h), y1 = Math.ceil((j + 0.5) / ny * h);
      let s = 0, n = 0;
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) { s += data[y * w + x]; n++; }
      m[j * vx + i] = n ? s / n : 0;
    }
  } else {
    for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) { const u = i / nx, v = j / ny; m[j * vx + i] = u >= P.ix0 && u <= P.ix1 && v >= P.iy0 && v <= P.iy1 ? 1 : 0; }
  }
  // height above the table: subtract a plane fitted to the background's depth (a tilted camera makes the table a ramp)
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, sn = 0, sxd = 0, syd = 0, sd = 0;
  for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
    const k = j * vx + i; if (m[k] > 0.02) continue;
    const x = i / nx, y = j / ny, z = d[k];
    sxx += x * x; sxy += x * y; sx += x; syy += y * y; sy += y; sn++; sxd += x * z; syd += y * z; sd += z;
  }
  let plane = () => 0;
  const inside = []; for (let k = 0; k < N; k++) if (m[k] > 0.5) inside.push(d[k]);
  inside.sort((a, b) => a - b);
  const pct = q => inside.length ? inside[Math.min(inside.length - 1, Math.floor(q * (inside.length - 1)))] : 0;
  if (sn >= 40) {   // solve the 3x3 normal equations (Cramer)
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, sn]], B = [sxd, syd, sd];
    const det3 = M => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    const D = det3(A);
    if (Math.abs(D) > 1e-9) {
      const col = c => A.map((r, i) => r.map((v, j) => (j === c ? B[i] : v)));
      const a = det3(col(0)) / D, b = det3(col(1)) / D, c = det3(col(2)) / D;
      plane = (x, y) => a * x + b * y + c;
    }
  } else { const base = pct(0.03); plane = () => base; }   // almost no background in the crop: its least-near part
  let hgt = new Float32Array(N); const hs = [];
  for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) { const k = j * vx + i; hgt[k] = d[k] - plane(i / nx, j / ny); }
  // the depth model's fine texture is mostly noise at this scale: two 3x3 box blurs (inside the object only)
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(N);
    for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
      let s = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= vx || jj >= vy || m[jj * vx + ii] < 0.5) continue; s += hgt[jj * vx + ii]; n++; }
      o[j * vx + i] = n ? s / n : hgt[j * vx + i];
    }
    hgt = o;
  }
  for (let k = 0; k < N; k++) if (m[k] > 0.5) hs.push(hgt[k]);
  hs.sort((a, b) => a - b);
  const top = hs.length ? hs[Math.floor(0.95 * (hs.length - 1))] : 0, lo = hs.length ? hs[Math.floor(0.05 * (hs.length - 1))] : 0;
  const flat = !(top - lo > 0.04 && top > 0.02);   // no usable relief in the depth: a slab with rounded edges
  // kept cells: most of the cell is the object; the silhouette's vertices pinch front and back together (closed solid)
  const keep = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * vx + i; keep[j * nx + i] = (m[k] + m[k + 1] + m[k + vx] + m[k + vx + 1]) / 4 > 0.5 ? 1 : 0;
  }
  // holes inside the object (a glare spot the mask missed) would pinch the surface into dimples: fill them
  { const out = new Uint8Array(nx * ny), st = [];
    const go = c => { if (!keep[c] && !out[c]) { out[c] = 1; st.push(c); } };
    for (let i = 0; i < nx; i++) { go(i); go((ny - 1) * nx + i); }
    for (let j = 0; j < ny; j++) { go(j * nx); go(j * nx + nx - 1); }
    while (st.length) { const c = st.pop(), i = c % nx, j = (c - i) / nx; if (i > 0) go(c - 1); if (i < nx - 1) go(c + 1); if (j > 0) go(c - nx); if (j < ny - 1) go(c + nx); }
    for (let c = 0; c < keep.length; c++) if (!out[c]) keep[c] = 1; }
  // distance (in cells) from each vertex to the silhouette: 0 on it, BFS inward; gives the rounded rim
  const dist = new Int32Array(N).fill(-1), q = [];
  const cellOn = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && keep[j * nx + i];
  for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
    const a = cellOn(i - 1, j - 1), b = cellOn(i, j - 1), c = cellOn(i - 1, j), e = cellOn(i, j);
    if ((a || b || c || e) && !(a && b && c && e)) { dist[j * vx + i] = 0; q.push(j * vx + i); }
  }
  for (let h = 0; h < q.length; h++) {
    const k = q[h], i = k % vx, j = (k - i) / vx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= vx || jj >= vy) continue;
      const kk = jj * vx + ii; if (dist[kk] >= 0) continue;
      if (!(cellOn(ii - 1, jj - 1) && cellOn(ii, jj - 1) && cellOn(ii - 1, jj) && cellOn(ii, jj))) continue;
      dist[kk] = dist[k] + 1; q.push(kk);
    }
  }
  const R = Math.max(1, Math.round(0.07 * Math.min(nx, ny)));
  // how much the depth may shape the surface: a pen (as thick as it is wide) fully, a phone (10 mm of 80) only a little
  const { umin, umax, vmin, vmax, wmin, wmax, ix0, ix1, iy0, iy1, up, toCam, v0 } = P;
  const T = Math.max(1, wmax - wmin), w0 = (wmin + wmax) / 2;
  const amp = Math.min(0.7, Math.max(0.15, 2 * T / Math.max(1, Math.min(umax - umin, vmax - vmin))));
  // per-vertex half thickness 0..1
  const t = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    if (dist[k] < 0) continue;
    const r = Math.min(1, dist[k] / R), rim = Math.sqrt(1 - (1 - r) * (1 - r));
    const rel = flat ? 1 : 1 - amp + amp * smooth(lo, top, hgt[k]);
    t[k] = rim * rel;
  }
  // positions: crop (u, v) -> the scan's projection plane; depth along the camera direction around the body's mid-plane
  // the silhouette is a staircase of grid cells: relax its vertices toward their silhouette neighbours (a few passes),
  // so the rim reads as a smooth outline; uv moves with them, so the photo stays registered
  const gx = new Float32Array(N), gy = new Float32Array(N);
  for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) { gx[j * vx + i] = i / nx; gy[j * vx + i] = j / ny; }
  for (let pass = 0; pass < 4; pass++) {
    const ox = gx.slice(), oy = gy.slice();
    for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
      const k = j * vx + i; if (dist[k] !== 0) continue;
      let sx = 0, sy = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue; const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= vx || jj >= vy) continue;
        const kk = jj * vx + ii; if (dist[kk] !== 0) continue; sx += ox[kk]; sy += oy[kk]; n++;
      }
      if (n >= 2) { gx[k] = 0.5 * ox[k] + 0.5 * sx / n; gy[k] = 0.5 * oy[k] + 0.5 * sy / n; }
    }
    // the next rings follow the relaxed outline (plain Laplacian), so rim triangles don't fold
    for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
      const k = j * vx + i; if (dist[k] < 1 || dist[k] > 2) continue;
      let sx = 0, sy = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue; const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= vx || jj >= vy) continue;
        const kk = jj * vx + ii; if (dist[kk] < 0) continue; sx += ox[kk]; sy += oy[kk]; n++;
      }
      if (n) { gx[k] = 0.5 * ox[k] + 0.5 * sx / n; gy[k] = 0.5 * oy[k] + 0.5 * sy / n; }
    }
  }
  const X = new THREE.Vector3(1, 0, 0), U = new THREE.Vector3().copy(up), W = new THREE.Vector3().copy(toCam);
  const front = new Float32Array(N * 3), back = new Float32Array(N * 3), uv = new Float32Array(N * 2), p = new THREE.Vector3();
  for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
    const k = j * vx + i, px = gx[k], py = gy[k];
    const u = umin + (px - ix0) / Math.max(1e-6, ix1 - ix0) * (umax - umin), v = vmax - (py - iy0) / Math.max(1e-6, iy1 - iy0) * (vmax - vmin);
    for (const [arr, s] of [[front, 1], [back, -1]]) {
      p.copy(X).multiplyScalar(u).addScaledVector(U, v).addScaledVector(W, w0 + s * t[k] * T / 2);
      arr[k * 3] = p.x; arr[k * 3 + 1] = p.y; arr[k * 3 + 2] = p.z;
    }
    uv[k * 2] = Math.min(0.999, Math.max(0.001, px)); uv[k * 2 + 1] = 1 - Math.min(0.999, Math.max(0.001, py)) * (1 - v0);
  }
  const fi = [], bi = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!keep[j * nx + i]) continue;
    const a = j * vx + i, b = a + 1, c = a + vx, e = c + 1;
    fi.push(a, c, b, b, c, e); bi.push(a, b, c, b, e, c);   // front faces the camera (toCam); the back is wound the other way
  }
  const make = (pos, idx) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv.slice(), 2));
    g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingBox();
    return g;
  };
  const g = make(front, fi);
  // the winding above assumes (X, U, W) is right-handed with W toward the camera; check with one normal and flip if not
  const n = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, fi[0] ?? 0);
  if (fi.length && n.dot(W) < 0) { for (let s = 0; s < fi.length; s += 3) { [fi[s + 1], fi[s + 2]] = [fi[s + 2], fi[s + 1]]; [bi[s + 1], bi[s + 2]] = [bi[s + 2], bi[s + 1]]; } g.setIndex(fi); g.computeVertexNormals(); }
  return { front: g, back: make(back, bi), stats: { nx, ny, cells: fi.length / 6, flat, top, lo, mask: mask?.source || 'bbox' } };
}

/** Starts building the relief for this scan once its photo and its depth are both here. */
async function attach(built, dep) {
  built.relief = { state: 'building' };
  try {
    const img = await loadImg(`data:image/png;base64,${dep.depth}`);
    const r = reliefGeometry(built, img);
    if (!r || !r.stats.cells) throw new Error('no relief cells');
    const holo = window.odyHost?.holo?.() ?? true;
    const mk = (geo, tint) => {
      const real = new THREE.MeshStandardMaterial({ map: built.atlas, roughness: 0.6, metalness: 0, color: tint, side: THREE.FrontSide });
      const hm = holoMaterial('body', built.atlas); hm.uniforms.uMapAmt.value = 0.38;
      const mesh = new THREE.Mesh(geo, holo ? hm : real);
      mesh.userData.real = real; mesh.userData.holoMat = hm; mesh.userData.reliefMesh = true;
      mesh.castShadow = !holo; mesh.receiveShadow = true;
      return mesh;
    };
    const group = new THREE.Group(); group.name = 'Photo relief';
    group.add(mk(r.front, 0xffffff), mk(r.back, 0x9a9a9a));
    group.visible = false;
    built.group.add(group);
    built.relief = { state: 'ready', group, stats: r.stats,
      dispose() { group.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.userData.real.dispose(); o.userData.holoMat.dispose(); } }); } };
  } catch (e) {
    console.warn('[twin] relief', e?.message || e);
    built.relief = { state: 'failed', error: String(e?.message || e) };
  }
}

/**
 * Called every frame while the scan is on stage (scan.js sets it as the group's userData.update): builds the relief
 * when its inputs are ready, and shows it (hiding the parts) unless the viewer chose Parts, the object is exploded,
 * its interior is showing, or a part was removed / moved / reshaped.
 */
export function syncRelief(built) {
  const host = window.odyHost, entry = host?.currentScan?.();
  if (!entry || entry.built !== built) return;
  wireButtons();
  const dep = depths.get(Number(entry.id));
  if (!built.relief && dep && built.atlas.userData.photo) void attach(built, dep);
  const ready = built.relief?.state === 'ready';
  const edited = built.meshes.some(m => m.scale.x < 0.5 || m.geometry !== m.userData.geo0);
  const busy = (host.explode?.() || 0) > 0.01 || !!entry.I?.group?.visible || edited;
  const show = ready && wantRelief && !busy;
  if (ready) {
    const g = built.relief.group;
    if (g.visible !== show) g.visible = show;
    const holo = host.holo?.();
    for (const o of g.children) { const want = holo ? o.userData.holoMat : o.userData.real; if (o.material !== want) { o.material = want; o.castShadow = !holo; } }
    for (const m of built.meshes) if (m.visible === show) m.visible = !show;
  }
  const r = btn('t-relief'), p = btn('t-parts'), row = btn('scanlook');
  if (row) row.hidden = !ready;
  if (r && p && ready) {
    r.setAttribute('aria-pressed', String(wantRelief)); p.setAttribute('aria-pressed', String(!wantRelief));
    r.disabled = busy; r.title = busy ? 'Assemble the object (and close X-ray) to see the photo relief' : '';
  }
}

/** For tests: what the relief is doing. */
export const reliefState = built => ({ state: built?.relief?.state || 'none', visible: !!built?.relief?.group?.visible, want: wantRelief, stats: built?.relief?.stats || null, error: built?.relief?.error || '' });
export function setReliefWanted(on) { wantRelief = !!on; }

/**
 * How well the primitive assembly matches the photo: IoU of its silhouette (orthographic, the scan's projection) with
 * the object's segmentation mask, both in the crop. null until the photo's mask is here.
 */
export function silhouetteIoU(built) {
  const P = built?.proj, mask = built?.atlas?.userData.mask;
  if (!P || !mask) return null;
  const { w, h, data } = mask, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff';
  const a = new THREE.Vector3(), X = (u) => (P.ix0 + (u - P.umin) / Math.max(1e-6, P.umax - P.umin) * (P.ix1 - P.ix0)) * w;
  const Y = (v) => (P.iy0 + (P.vmax - v) / Math.max(1e-6, P.vmax - P.vmin) * (P.iy1 - P.iy0)) * h;
  for (const m of built.meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i + 2 < pos.count; i += 3) {   // one fill per triangle: front and back faces wind opposite ways
      g.beginPath();
      for (let k = 0; k < 3; k++) { a.fromBufferAttribute(pos, i + k).add(m.position); const x = X(a.x), y = Y(a.dot(P.up)); if (k) g.lineTo(x, y); else g.moveTo(x, y); }
      g.fill();
    }
  }
  const s = g.getImageData(0, 0, w, h).data;
  let inter = 0, uni = 0;
  for (let k = 0; k < w * h; k++) { const p = s[k * 4 + 3] > 127 ? 1 : 0, q = data[k]; inter += p & q; uni += p | q; }
  return uni ? inter / uni : null;
}
