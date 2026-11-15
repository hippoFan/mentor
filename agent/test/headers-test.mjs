// Custom boards (headers.mjs): pin-exact holes on a board nobody has mapped, from the brain's rough header description.
//   node test/headers-test.mjs                 synthetic warped custom PCB (1x8 + 2x10, blur, silkscreen): every hole
//                                              within 1.5 px, names, marks, tracker, twin spec, bad inputs rejected
//   node test/headers-test.mjs --photo p.jpg   real photo: uses <p>.headers-brain.json (cached brain reply) and renders
//                                              the snapped holes to <p>.headers.png
//   MENTOR_BRAIN=claude-code MENTOR_OWNER_TESTING=1 node test/headers-test.mjs --photo p.jpg --brain   asks the brain once
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { createCanvas, loadImage, ImageData } from '@napi-rs/canvas';
import { customBoard, resolveCustom, cleanHeader, PITCH } from '../headers.mjs';
import { apply, homography, boardFromReply, TRACK_POINTS, wireGeometry } from '../board.mjs';
import { createMarkTracker } from '../tracker.mjs';
import * as brain from '../brain.mjs';

const args = process.argv.slice(2);
let pass = 0, fail = 0;
const t = (name, fn) => { try { const d = fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 2).join('\n      ')}`); } };

// ---------- the synthetic custom PCB ----------
const FW = 960, FH = 720, S = 12;                 // frame px; texture px per mm
const BW = 60, BH = 40;                           // board mm
const pinsA = ['3V3', 'GND', 'D4', 'D5', 'SDA', 'SCL', 'TX', 'RX'];
// header A: 1x8 along the top; header B: 2x10 lower down (row 2 below row 1)
const A = { label: 'J1', rows: 1, count: 8, at: (i) => [12 + i * PITCH, 8] };
const B = { label: 'J2', rows: 2, count: 10, at: (i, j) => [14 + i * PITCH, 24 + j * PITCH] };
const holesMm = (hd, at = hd.at) => { const out = []; for (let j = 0; j < hd.rows; j++) for (let i = 0; i < hd.count; i++) out.push({ i, j, uv: at(i, j) }); return out; };

/** Board texture: green PCB, gold pads with black holes, white silkscreen labels. `irregular` moves header A's holes. */
function texture({ irregular = false } = {}) {
  const c = createCanvas(BW * S, BH * S), g = c.getContext('2d');
  g.fillStyle = '#1f6b3a'; g.fillRect(0, 0, BW * S, BH * S);
  g.fillStyle = '#2a7d47'; for (let k = 0; k < 9; k++) g.fillRect((4 + k * 6) * S, 32 * S, 0.4 * S, 6 * S);   // traces
  const atA = irregular ? (i => [12 + i * PITCH + [0, 0.8, -0.6, 0.9, -0.8, 0.7, -0.5, 0][i], 8]) : A.at;
  const hole = ([u, v]) => {
    g.fillStyle = '#c8a95a'; g.beginPath(); g.arc(u * S, v * S, 0.85 * S, 0, 2 * Math.PI); g.fill();
    g.fillStyle = '#0b0b0b'; g.beginPath(); g.arc(u * S, v * S, 0.5 * S, 0, 2 * Math.PI); g.fill();
  };
  holesMm(A, atA).forEach(h => hole(h.uv));
  holesMm(B).forEach(h => hole(h.uv));
  g.fillStyle = '#f2f2f2'; g.font = `${1.3 * S}px sans-serif`; g.textAlign = 'center';
  pinsA.forEach((l, i) => g.fillText(l, A.at(i)[0] * S, 5.2 * S));
  g.fillText('J1', 7.5 * S, 8.5 * S); g.fillText('J2', 9.5 * S, 26 * S);
  return { c, atA };
}

/** Perspective-warps the texture into the frame (table behind), then blurs it. H: board mm -> frame px. */
let frameNo = 0;
function render(H, tex, blur = 1.1) {
  const fn = ++frameNo * 2654435761;
  const tw = tex.c.width, th = tex.c.height, td = tex.c.getContext('2d').getImageData(0, 0, tw, th).data;
  const Hi = homography([[0, 0], [BW, 0], [BW, BH], [0, BH]].map(([u, v]) => apply(H, u, v)), [[0, 0], [BW, 0], [BW, BH], [0, BH]]);
  const out = new Uint8ClampedArray(FW * FH * 4);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const o = (y * FW + x) * 4;
    const [u, v] = apply(Hi, x, y), tx = u * S - 0.5, ty = v * S - 0.5;
    if (tx >= 0 && ty >= 0 && tx < tw - 1 && ty < th - 1) {
      const x0 = tx | 0, y0 = ty | 0, ax = tx - x0, ay = ty - y0;
      for (let ch = 0; ch < 3; ch++) {
        const i = (y0 * tw + x0) * 4 + ch;
        out[o + ch] = (td[i] * (1 - ax) + td[i + 4] * ax) * (1 - ay) + (td[i + tw * 4] * (1 - ax) + td[i + tw * 4 + 4] * ax) * ay;
      }
    } else { const n = 120 + ((x * 7 + y * 13) % 11); out[o] = n; out[o + 1] = n - 6; out[o + 2] = n - 14; }
    for (let ch = 0; ch < 3; ch++) out[o + ch] += (((x * 73856093 ^ y * 19349663 ^ ch * 83492791 ^ fn) >>> 0) % 17) - 8;   // sensor noise, new every frame
    out[o + 3] = 255;
  }
  const c = createCanvas(FW, FH), g = c.getContext('2d');
  const src = createCanvas(FW, FH); src.getContext('2d').putImageData(new ImageData(out, FW, FH), 0, 0);
  g.filter = `blur(${blur}px)`; g.drawImage(src, 0, 0);
  const d = g.getImageData(0, 0, FW, FH);
  return { data: d.data, width: FW, height: FH, canvas: c };
}

// A tilted, turned view (mild perspective): board corners -> a trapezoid
const quad = (dx = 0, dy = 0) => [[230 + dx, 170 + dy], [745 + dx, 205 + dy], [715 + dx, 560 + dy], [205 + dx, 505 + dy]];
const Hview = (dx, dy) => homography([[0, 0], [BW, 0], [BW, BH], [0, BH]], quad(dx, dy));
const H0 = Hview(0, 0);
const tex = texture();
const frame = render(H0, tex);

// deterministic "brain" error: ~0.3 pitch in a pseudo-random direction
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const off = (p, pitchPx) => { const a = rnd() * 2 * Math.PI; return [p[0] + 0.3 * pitchPx * Math.cos(a), p[1] + 0.3 * pitchPx * Math.sin(a)]; };
const N = ([x, y]) => [x / FW, y / FH];
function brainHeader(hd, H, { count = hd.count, at = hd.at, labels = [] } = {}) {
  const f = apply(H, ...at(0, 0)), l = apply(H, ...at(hd.count - 1, 0));
  const pp = Math.hypot(l[0] - f[0], l[1] - f[1]) / (hd.count - 1);
  const ff = off(f, pp), ll = off(l, pp);
  const offset = hd.rows === 2 ? (() => { const r = apply(H, ...at(0, 1)); return [(r[0] - f[0]) * 1.1 / FW, (r[1] - f[1]) * 0.9 / FH]; })() : null;
  return { label: hd.label, rows: hd.rows, count, first: N(ff), last: N(ll), offset, labels };
}
const truth = (hd, H, at = hd.at) => holesMm(hd, at).map(h => ({ ...h, xy: apply(H, ...h.uv) }));
const replyBoard = (H, extra = {}) => ({ model: 'other', corners: quad().map(N), headers: [brainHeader(A, H, { labels: pinsA }), brainHeader(B, H)], ...extra });

// ---------- the synthetic tests ----------
let C;
t('custom board registers from 2 rough headers', () => {
  const t0 = performance.now();
  C = customBoard(frame, replyBoard(H0));
  const ms = performance.now() - t0;
  assert.ok(C.board, `rejected: ${JSON.stringify(C.rejected)}`);
  assert.equal(C.headers.length, 2, JSON.stringify(C.rejected));
  return `${C.headers.map(h => `${h.label} ${h.rows}x${h.count} pitch ${h.pitchPx.toFixed(1)} px ${h.polarity > 0 ? 'dark' : 'bright'}`).join(', ')}, ${ms.toFixed(0)} ms`;
});
const errs = [];
t('every hole within 1.5 px after snapping', () => {
  for (const [hd, name] of [[A, 'J1'], [B, 'J2']]) {
    const h = C.headers.find(x => x.label === name);
    for (const tr of truth(hd, H0)) {
      const num = hd.rows === 2 ? 2 * tr.i + tr.j + 1 : tr.i + 1;
      const p = h.pins.find(q => q.num === num);
      const e = Math.hypot(p.px[0] - tr.xy[0], p.px[1] - tr.xy[1]);
      errs.push(e);
      assert.ok(e < 1.5, `${name}.${num} off by ${e.toFixed(2)} px`);
    }
  }
  return `${errs.length} holes, mean ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2)} px, max ${Math.max(...errs).toFixed(2)} px`;
});
t('pin names: silkscreen labels, J1.5, zigzag 2-row numbering', () => {
  const k = n => C.board.pinKey(n);
  const cases = { D4: 'J1.3', d4: 'J1.3', GPIO4: 'J1.3', '3.3V': 'J1.1', '3V3': 'J1.1', GND: 'J1.2', SDA: 'J1.5', RX: 'J1.8',
    'J1.5': 'J1.5', 'J1 5': 'J1.5', 'j1-pin5': 'J1.5', 'J2.1': 'J2.1', 'J2.20': 'J2.20', 'J2.21': null, 'J3.1': null, D9: null, 5: 'J1.4' };
  for (const [q, want] of Object.entries(cases)) assert.equal(k(q), want, `"${q}"`);
  // zigzag: J2.2 is row 2 under J2.1, J2.3 is next along row 1
  const P = n => C.board.pinPoint(n).map((v, i) => v * (i ? FH : FW));
  const [t1, t2, t3] = [[0, 0], [0, 1], [1, 0]].map(([i, j]) => apply(H0, ...B.at(i, j)));
  for (const [n, tr] of [['J2.1', t1], ['J2.2', t2], ['J2.3', t3]]) assert.ok(Math.hypot(P(n)[0] - tr[0], P(n)[1] - tr[1]) < 1.5, n);
  return `${Object.keys(cases).length} names`;
});
t('marks and wires land on their holes', () => {
  const marks = [{ label: 'D4 to J2.7', kind: 'wire', x: 0.5, y: 0.5, x2: 0.6, y2: 0.6, pin: 'D4', pin2: 'J2.7' },
    { label: 'LED', kind: 'circle', x: 0.3, y: 0.3, x2: -1, y2: -1, pin: '', pin2: '' }];
  const r = resolveCustom(frame, { marks, board: replyBoard(H0) });
  const a = apply(H0, ...A.at(2, 0)), b = apply(H0, ...B.at(3, 0));   // J2.7 = row 1, 4th hole
  const m = r.marks[0];
  assert.ok(Math.hypot(m.x * FW - a[0], m.y * FH - a[1]) < 1.5 && Math.hypot(m.x2 * FW - b[0], m.y2 * FH - b[1]) < 1.5, JSON.stringify(m));
  assert.equal(m.pinKey, 'J1.3'); assert.equal(m.pin2Key, 'J2.7');
  assert.deepEqual([r.marks[1].x, r.marks[1].y], [0.3, 0.3]);
  const geo = wireGeometry(r.board, { pin: 'J1.3' }, { pin: 'J2.7' });
  assert.ok(geo && geo.path.length > 10 && geo.path.every(p => p.every(Number.isFinite)), 'wire geometry');
});
t('twin spec: board mm on a 2.54 grid, labels, outline', () => {
  const tw = C.twin;
  assert.equal(tw.kind, 'custom-board'); assert.equal(tw.key, 'custom:J1:1x8,J2:2x10');
  assert.ok(tw.outline && tw.outline.length === 4, 'outline from the brain corners');
  // similarity of a perspective view: W/H roughly the board (within 15%)
  assert.ok(Math.abs(tw.W / BW - 1) < 0.15 && Math.abs(tw.H / BH - 1) < 0.2, `W ${tw.W} H ${tw.H}`);
  const j1 = tw.headers.find(h => h.label === 'J1'), j2 = tw.headers.find(h => h.label === 'J2');
  assert.deepEqual(j1.pins.map(p => p.label), pinsA);
  const gap = (p, q) => Math.hypot(p.u - q.u, p.v - q.v);
  assert.ok(Math.abs(gap(j1.pins[0], j1.pins[7]) - 7 * PITCH) < 0.05);
  assert.ok(Math.abs(gap(j2.pins[0], j2.pins[1]) - PITCH) < 0.05, 'row spacing');
  for (const h of tw.headers) for (const p of h.pins) assert.ok(p.u >= 0 && p.v >= 0 && p.u <= tw.W && p.v <= tw.H, `${p.name} outside`);
  return `W ${tw.W} x H ${tw.H} mm, ${tw.headers.reduce((s, h) => s + h.pins.length, 0)} pins`;
});
t('tracker follows the custom board (boardFromReply seeds it)', () => {
  const tr = createMarkTracker();
  const marks = [{ label: 'D4 to J2.7', kind: 'wire', x: 0.5, y: 0.5, x2: 0.6, y2: 0.6, pin: 'D4', pin2: 'J2.7' }];
  tr.seed(frame, marks, replyBoard(H0), 0);
  assert.ok(tr.board && tr.board.part.id === 'custom', 'registered');
  assert.ok(TRACK_POINTS.length >= 20, `track points ${TRACK_POINTS.length}`);
  let worst = 0; const es = [];
  for (let k = 1; k <= 6; k++) {   // the phone drifts 3 px per frame right and 2 down (the tracker's one-euro smoothing lags ~2-3 px; board-test allows 4)
    const Hk = Hview(3 * k, 2 * k), f = render(Hk, tex);
    const [m] = tr.update(f, 33 * k);
    assert.ok(m?.geo, `frame ${k}: no 3D wire`);
    const a = apply(Hk, ...A.at(2, 0)), b = apply(Hk, ...B.at(3, 0));
    const e1 = Math.hypot(m.x * FW - a[0], m.y * FH - a[1]), e2 = Math.hypot(m.x2 * FW - b[0], m.y2 * FH - b[1]);
    es.push(e1, e2); worst = Math.max(worst, e1, e2);
  }
  const mean = es.reduce((x, y) => x + y, 0) / es.length;
  assert.ok(mean < 4 && worst < 6, `mean ${mean.toFixed(2)} worst ${worst.toFixed(2)} px`);   // board-test's handheld bar: mean < 4
  return `6 moving frames, pins mean ${mean.toFixed(2)} px, worst ${worst.toFixed(2)} px`;
});

// ---------- bad inputs ----------
t('uneven spacing is rejected', () => {
  const bad = texture({ irregular: true }), f = render(H0, bad);
  const c = customBoard(f, { model: 'other', corners: [], headers: [brainHeader(A, H0)] });
  assert.equal(c.board, null, 'should not register');
  return c.rejected.map(r => r.reason).join('; ');
});
t('wrong hole count is rejected', () => {
  const h = brainHeader(A, H0); h.count = 10;
  const c = customBoard(frame, { model: 'other', corners: [], headers: [h] });
  assert.equal(c.board, null);
  return c.rejected.map(r => r.reason).join('; ');
});
t('header partly off the picture is rejected, the other one kept', () => {
  const Hs = Hview(0, -250);   // board slid up: J1 is beyond the top edge, J2 still in view
  const f = render(Hs, tex);
  const hA = brainHeader(A, Hs), hB = brainHeader(B, Hs);
  const c = customBoard(f, { model: 'other', corners: [], headers: [hA, hB] });
  assert.ok(c.rejected.some(r => r.label === 'J1'), JSON.stringify(c.rejected));
  assert.ok(c.board && c.headers.length === 1 && c.headers[0].label === 'J2', 'J2 kept');
  return c.rejected.map(r => `${r.label}: ${r.reason}`).join('; ') + (c.board ? `; kept ${c.headers.map(h => h.label)}` : '');
});
t('no holes where the brain says (blank PCB) is rejected', () => {
  const h = brainHeader(A, H0); h.first = [h.first[0], h.first[1] + 0.09]; h.last = [h.last[0], h.last[1] + 0.09];
  const c = customBoard(frame, { model: 'other', corners: [], headers: [h] });
  assert.equal(c.board, null);
  return c.rejected.map(r => r.reason).join('; ');
});
t('garbage header data is rejected without throwing', () => {
  for (const h of [null, {}, { rows: 3, count: 8, first: [0, 0], last: [1, 1] }, { rows: 1, count: 500, first: [0, 0], last: [1, 1] },
    { rows: 1, count: 8, first: [NaN, 0], last: [1, 1] }, { rows: 1, count: 1.5, first: [0, 0], last: [1, 1] }]) assert.equal(cleanHeader(h), null, JSON.stringify(h));
  const c = customBoard(frame, { model: 'other', headers: [{ rows: 1, count: 8, first: [0.5, 0.5], last: [0.5, 0.5] }, 'x'] });
  assert.equal(c.board, null);
  assert.equal(boardFromReply({ model: 'other', corners: [], headers: [] }, { w: FW, h: FH }, frame), null);
  return c.rejected.map(r => r.reason).join('; ');
});
t('brain: schema + prompt + normalizeReply carry headers', () => {
  const hp = brain.SCHEMA.properties.board.properties.headers;
  assert.ok(hp && hp.items.required.includes('pin_labels'));
  assert.match(brain.SYSTEM, /"headers" lists/);
  assert.ok(brain.SYSTEM.length < 9500, `SYSTEM ${brain.SYSTEM.length}`);
  const out = brain.normalizeReply({ marks: [], board: { model: 'other', corners: [], headers: [{ label: 'J1', rows: 2, count: 10, first: [100, 50], last: [500, 50], second_row_offset: [0, 40], pin_labels: [] }] } }, 1000, 500);
  assert.deepEqual(out.board.headers[0].first, [0.1, 0.1]); assert.deepEqual(out.board.headers[0].offset, [0, 0.08]);
  return `SYSTEM ${brain.SYSTEM.length} chars`;
});

// ---------- debug render: snapped holes as dots + names ----------
async function drawResult(img, c, out, extra = []) {
  const cv = createCanvas(img.width, img.height), g = cv.getContext('2d');
  g.drawImage(img, 0, 0);
  const r = Math.max(2, Math.round(img.width / 400));
  g.font = `${Math.max(10, Math.round(img.width / 110))}px sans-serif`;
  for (const [x, y, col] of extra) { g.strokeStyle = col; g.lineWidth = r; g.beginPath(); g.arc(x, y, 3 * r, 0, 2 * Math.PI); g.stroke(); }
  for (const h of c.headers || []) for (const p of h.pins) {
    const [x, y] = [p.xy[0] * img.width, p.xy[1] * img.height];
    g.fillStyle = p.detected ? '#00e5ff' : '#ff3d7f'; g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fill();
    g.fillStyle = '#ffff00'; g.fillText(p.label || p.key, x + r + 1, y - r - 1);
  }
  await writeFile(out, cv.toBuffer('image/png'));
}
if (!args.includes('--photo')) await drawResult(frame.canvas, C || {}, '/tmp/claude-1000/-home-plopee/c02e38dd-44ec-41ef-a7e2-9567a8304336/scratchpad/headers-synthetic.png');

// ---------- real photo ----------
const pi = args.indexOf('--photo');
if (pi >= 0) {
  const PHOTO = args[pi + 1], OUT = PHOTO.replace(/\.[a-z]+$/i, ''), CACHE = `${OUT}.headers-brain.json`;
  const img = await loadImage(PHOTO);
  const sc = Math.min(1, 1600 / Math.max(img.width, img.height));
  const w = Math.round(img.width * sc), h = Math.round(img.height * sc);
  const cv = createCanvas(w, h); cv.getContext('2d').drawImage(img, 0, 0, w, h);
  let reply = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : null;
  if (args.includes('--brain')) {
    const b = await brain.createBrain({ provider: 'claude-code', task: 'wire up this board' });
    try {
      reply = await b.turn('What board is this? Show me its pin headers and where pin 1 of each header is.', { jpeg: cv.toBuffer('image/jpeg', 90), width: w, height: h });
    } finally { await b.close?.(); }
    await writeFile(CACHE, JSON.stringify(reply, null, 1));
  }
  if (!reply) throw new Error(`no cached brain reply at ${CACHE}: run with --brain`);
  console.log(`brain: model ${reply.board?.model}, ${reply.board?.headers?.length || 0} headers, say "${reply.say}"`);
  const fd = cv.getContext('2d').getImageData(0, 0, w, h);
  const c = customBoard({ data: fd.data, width: w, height: h }, reply.board);
  console.log(c.board ? `registered: ${c.headers.map(x => `${x.label} ${x.rows}x${x.count} pitch ${x.pitchPx.toFixed(1)} px ${x.pins.filter(p => p.detected).length}/${x.pins.length} found, residual ${x.residualPx.toFixed(2)} px`).join('; ')}` : 'not registered');
  for (const r of c.rejected) console.log(`rejected ${r.label}: ${r.reason}`);
  // brain's raw first/last points in red for comparison
  const raw = (reply.board?.headers || []).flatMap(x => [[x.first[0] * w, x.first[1] * h, '#ff0000'], [x.last[0] * w, x.last[1] * h, '#ff8800']]);
  await drawResult(cv, c, `${OUT}.headers.png`, raw);
  console.log(`wrote ${OUT}.headers.png`);
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
