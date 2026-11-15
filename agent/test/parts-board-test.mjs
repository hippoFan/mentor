// Library boards (data/parts + orientation.json) on the phone video and in the twin's pin logic. Offline, no brain calls.
//   node test/parts-board-test.mjs            synthetic warped Pi 4 / ESP32 / Nano / Mega / Pico: every pin within 1 px,
//                                             pin-name resolution, corner snapping, tracker, brain prompt, twin bundle
//   node test/parts-board-test.mjs --write    regenerate twin/parts.json from data/parts first
import { readFileSync, writeFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { BOARD_MODELS, boardSpec, createBoard, boardFromReply, refineCorners, resolveMarks, wireGeometry, TRACK_POINTS } from '../board.mjs';
import { partTable, twinBundle } from '../twin/partpins.js';
import * as twinPins from '../twin/pins.js';
import { createMarkTracker } from '../tracker.mjs';

const read = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const index = read('../data/parts/index.json'), orientation = read('../data/parts/orientation.json');
const parts = Object.fromEntries(Object.entries(index.parts).map(([id, e]) => [id, read(`../data/parts/${e.file}`)]));

let pass = 0, fail = 0;
const t = (name, fn) => { try { const d = fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

// ---------- the twin bundle ----------
const bundle = twinBundle(index, parts, orientation);
const BUNDLE = new URL('../twin/parts.json', import.meta.url);
if (process.argv.includes('--write')) { writeFileSync(BUNDLE, `${JSON.stringify(bundle)}\n`); console.log(`wrote ${BUNDLE.pathname}`); }
t('twin/parts.json is up to date with data/parts', () => {
  assert.deepEqual(JSON.parse(readFileSync(BUNDLE, 'utf8')), JSON.parse(JSON.stringify(bundle)), 'stale: run node test/parts-board-test.mjs --write');
  return `${Object.keys(bundle.parts).length} boards`;
});
t('orientation.json: every entry is a part, 4 corners on the outline, clockwise', () => {
  for (const [id, o] of Object.entries(orientation)) {
    if (id.startsWith('_')) continue;
    assert.ok(parts[id], id);
    const { w, h } = parts[id].outline_mm;
    const c = ['A', 'B', 'C', 'D'].map(k => o.corners[k]);
    for (const [x, y] of c) assert.ok(x >= 0 && x <= w + 1e-6 && y >= 0 && y <= h + 1e-6, `${id} corner off the outline`);
    // clockwise on screen with y down: every turn has a positive cross product
    for (let i = 0; i < 4; i++) {
      const [a, b, d] = [c[i], c[(i + 1) % 4], c[(i + 2) % 4]];
      assert.ok((b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]) > 0, `${id} not clockwise at ${'ABCD'[i]}`);
    }
    for (const k of ['look', 'cornerA', 'cornerB', 'cornerC', 'cornerD', 'pinNames']) assert.ok(typeof o[k] === 'string' && o[k].length > 3, `${id} ${k}`);
    assert.ok(['female', 'maleUp', 'maleDown'].includes(o.header.type), `${id} header`);
  }
});

// ---------- pin names ----------
const key = (id, name) => boardSpec(id).key(name);
t('pin names resolve per board', () => {
  const cases = {
    'raspberry-pi-4': { GPIO17: 'GPIO17', 'gpio 17': 'GPIO17', 'pin 11': 'GPIO17', 'Pin 1': '3V3.1', '17': 'GPIO17', BCM18: 'GPIO18', '3V3': '3V3.1', '3.3V': '3V3.1', '5V': '5V.1', GND: 'GND.1', SDA: 'GPIO2', 'pin 40': 'GPIO21', GPIO99: null, 'pin 41': null },
    'esp32-devkit-v1': { D5: 'D5', GPIO5: 'D5', IO5: 'D5', 5: 'D5', 'pin 5': 'D5', GPIO1: 'TX0', TX: 'TX0', GPIO16: 'RX2', GPIO36: 'VP', '3V3': '3V3', '3.3V': '3V3', GND: 'GND.1', VIN: 'VIN', '5V': 'VIN', EN: 'EN', D99: null },
    'esp32-devkitc': { 5: '5', GPIO5: '5', GPIO1: 'TX', '3V3': '3V3', '5V': '5V', GND: 'GND.1' },
    'raspberry-pi-pico': { GP15: 'GP15', GPIO15: 'GP15', 15: 'GP15', 'pin 20': 'GP15', 'pin 1': 'GP0', 'pin 40': 'VBUS', 'pin 36': '3V3', '3V3': '3V3', '5V': 'VBUS', GND: 'GND.1', VSYS: 'VSYS' },
    'arduino-nano': { 13: '13', D13: '13', 'pin 13': '13', A0: 'A0', '3V3': '3.3V', GND: 'GND.1', TX: '1', RST: 'RESET', A7: 'A7' },
    'arduino-mega-2560': { 53: '53', D22: '22', A15: 'A15', GND: 'GND.1', '5V': '5V', '3V3': '3.3V', SDA: 'SDA' },
    'nodemcu-esp8266': { D5: 'D5', 5: 'D5', GPIO14: 'D5', GPIO16: 'D0', A0: 'A0', '3V3': '3V3.1', VIN: 'VIN' },
  };
  let n = 0;
  for (const [id, m] of Object.entries(cases)) for (const [q, want] of Object.entries(m)) { assert.equal(key(id, q), want, `${id} "${q}"`); n++; }
  return `${n} names`;
});
t('GND picks the nearest hole when asked', () => {
  const tab = partTable(parts['raspberry-pi-4'], orientation['raspberry-pi-4']);
  const p = tab.pins.GPIO21;   // pin 40, far end: nearest GND is pin 39 (GND.8)
  assert.equal(tab.resolve('GND', p), 'GND.8');
});
t('UNO unchanged: uno models still resolve through uno-pins.json', () => {
  assert.equal(key('uno-r3', 'D13'), '13'); assert.equal(key('uno-r4-wifi', 'GND'), 'GND.1'); assert.equal(key('uno-r3', 'GPIO17'), null);
  assert.ok(BOARD_MODELS.has('uno-r3') && BOARD_MODELS.has('raspberry-pi-4') && !BOARD_MODELS.has('dht22'));
});
t('UNO Q: registers with the UNO header geometry, own features, 3.3 V tooltips, D14-D21 names', () => {
  assert.ok(BOARD_MODELS.has('uno-q'));
  assert.equal(boardSpec('uno-q'), boardSpec('uno-r3'), 'UNO Q must share the UNO outline + header table');
  assert.equal(key('uno-q', 'D13'), '13'); assert.equal(key('uno-q', 'GND'), 'GND.1');
  const F = twinPins.FEATURES['uno-q'];
  for (const k of ['usb', 'chip', 'matrix', 'wifi', 'qwiic', 'power', 'stm32', 'jmedia', 'jmisc']) assert.ok(F[k], k);
  assert.ok(!F.jack && !F.reset, 'the UNO Q has no barrel jack and no reset button');
  for (const f of Object.values(F)) assert.ok(f.u >= 0 && f.u <= twinPins.BOARD_W && f.v >= 0 && f.v <= twinPins.BOARD_H, f.name);
  assert.equal(twinPins.featureFor('the STM32 microcontroller', 'uno-q'), 'stm32');
  assert.equal(twinPins.featureFor('Qualcomm chip', 'uno-q'), 'chip');
  assert.equal(twinPins.featureFor('the microcontroller', 'uno-r3'), 'chip', 'R3 microcontroller words changed');
  assert.match(twinPins.pinInfo('A0', 'uno-q').fn, /not 5 V-tolerant/); assert.match(twinPins.pinInfo('IOREF', 'uno-q').fn, /3\.3 V/);
  assert.doesNotMatch(twinPins.pinInfo('IOREF', 'uno-r3').fn, /3\.3 V/);
  const tab = { pins: Object.fromEntries(['A0', 'A5', 'SDA', 'SCL', '13'].map(k => [k, { u: 0, v: 0 }])) };
  assert.deepEqual(['D14', 'D19', 'D20', 'D21', 'D13'].map(n => twinPins.pinKey(tab, n)), ['A0', 'A5', 'SDA', 'SCL', '13']);
  assert.equal(twinPins.inferModel({ board: { model: 'uno-q' } }), 'uno-q');
  assert.equal(twinPins.inferModel({ marks: [{ label: 'QRB2210 processor' }] }), 'uno-q');
  assert.equal(twinPins.MODEL_NAMES['uno-q'], 'Arduino UNO Q');
});

// ---------- synthetic warped boards: known camera, known corners ----------
const W = 720, H = 960, f = 0.8 * Math.max(W, H);
const rot = (ax, ang) => { const c = Math.cos(ang), s = Math.sin(ang); return ax === 'x' ? [[1, 0, 0], [0, c, -s], [0, s, c]] : [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
const mm = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
/** A phone over a desk: tilted, the board turned, its centre `dist` mm away. */
function camera(spec, { tilt = 32, turn = 20, dist = 170 } = {}) {
  const R = mm(rot('x', tilt * Math.PI / 180), mm(rot('z', turn * Math.PI / 180), [[1, 0, 0], [0, -1, 0], [0, 0, -1]]));
  const c = [spec.W / 2, spec.H / 2];
  const T = [-(R[0][0] * c[0] + R[0][1] * c[1]), -(R[1][0] * c[0] + R[1][1] * c[1]), dist - (R[2][0] * c[0] + R[2][1] * c[1])];
  return (u, v, z) => {
    const X = R[0][0] * u + R[0][1] * v + R[0][2] * z + T[0], Y = R[1][0] * u + R[1][1] * v + R[1][2] * z + T[1];
    const Z = R[2][0] * u + R[2][1] * v + R[2][2] * z + T[2];
    return [W / 2 + f * X / Z, H / 2 + f * Y / Z];
  };
}
const VIEWS = {
  'raspberry-pi-4': [{ tilt: 32, turn: 20, dist: 190 }, { tilt: 45, turn: -110, dist: 230 }],
  'esp32-devkit-v1': [{ tilt: 30, turn: 15, dist: 120 }, { tilt: 40, turn: 160, dist: 140 }],
  'arduino-nano': [{ tilt: 25, turn: -30, dist: 90 }],
  'arduino-mega-2560': [{ tilt: 35, turn: 10, dist: 260 }],
  'raspberry-pi-pico': [{ tilt: 28, turn: 70, dist: 110 }],
  'esp32-devkitc': [{ tilt: 30, turn: 5, dist: 120 }],
  'nodemcu-esp8266': [{ tilt: 30, turn: -15, dist: 110 }],
  'raspberry-pi-pico-w': [{ tilt: 30, turn: 0, dist: 110 }],
};
for (const [id, views] of Object.entries(VIEWS)) {
  views.forEach((view, vi) => t(`${id} view ${vi + 1}: every pin within 1 px (board plane and pin top)`, () => {
    const spec = boardSpec(id), truth = camera(spec, view);
    const corners = spec.corners.map(([u, v]) => truth(u, v, 0)).map(([x, y]) => [x / W, y / H]);
    const b = createBoard(corners, { w: W, h: H }, id);
    assert.ok(b, 'createBoard returned null');
    assert.equal(b.part.id, id);
    let e0 = 0, eTop = 0;
    for (const [name, p] of Object.entries(spec.pins)) {
      const [x, y] = b.norm(p.u, p.v, 0), [tx, ty] = truth(p.u, p.v, 0);
      e0 = Math.max(e0, Math.hypot(x * W - tx, y * H - ty));
      const [x8, y8] = b.pinPoint(name), [tx8, ty8] = truth(p.u, p.v, spec.headerTop);
      eTop = Math.max(eTop, Math.hypot(x8 * W - tx8, y8 * H - ty8));
    }
    assert.ok(e0 < 1 && eTop < 1, `max ${e0.toFixed(3)} / ${eTop.toFixed(3)} px`);
    // mirrored order (seen from below) is refused
    assert.equal(createBoard([corners[0], corners[3], corners[2], corners[1]], { w: W, h: H }, id), null, 'mirror accepted');
    return `${Object.keys(spec.pins).length} pins, max ${e0.toFixed(3)} px plane, ${eTop.toFixed(3)} px at z=${spec.headerTop} mm`;
  }));
}

// ---------- a brain reply on a Pi: marks snap, wire geometry, the tracker follows the Pi ----------
/** Renders a board for the tracker / snapping: dark desk, PCB, black header strip, bright pins (or dark holes). */
function renderBoard(spec, truth, b) {
  const img = new Uint8ClampedArray(W * H * 4), Hinv = b.Hinv;
  // pins drawn where they appear at their top (z = headerTop): image px -> board mm at that height is the plane
  // homography of the z = headerTop plane, from 4 projected points
  const top = createBoard(spec.corners.map(([u, v]) => truth(u, v, spec.headerTop)).map(([x, y]) => [x / W, y / H]), { w: W, h: H }, spec);
  const T = top?.Hinv || Hinv;
  const pins = Object.values(spec.pins);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ww = Hinv[6] * x + Hinv[7] * y + Hinv[8];
    const u = (Hinv[0] * x + Hinv[1] * y + Hinv[2]) / ww, v = (Hinv[3] * x + Hinv[4] * y + Hinv[5]) / ww;
    const w2 = T[6] * x + T[7] * y + T[8];
    const ut = (T[0] * x + T[1] * y + T[2]) / w2, vt = (T[3] * x + T[4] * y + T[5]) / w2;
    let c = 40 + 30 * (((x >> 4) + (y >> 4)) & 1);   // checkered desk: texture for the tracker
    if (u >= 0 && u <= spec.W && v >= 0 && v <= spec.H) c = 110 + 25 * ((Math.floor(u / 6) + Math.floor(v / 6)) & 1);
    let near = Infinity;
    for (const p of pins) near = Math.min(near, Math.max(Math.abs(ut - p.u), Math.abs(vt - p.v)));
    if (near < 1.25) c = spec.polarity > 0 ? 200 : 25;   // header plastic: light for female (UNO-like), black for male
    if (near < 0.35) c = spec.polarity > 0 ? 0 : 235;    // the hole / the pin tip
    const i = (y * W + x) * 4; img[i] = img[i + 1] = img[i + 2] = c; img[i + 3] = 255;
  }
  return { data: img, width: W, height: H };
}
{
  const id = 'raspberry-pi-4', spec = boardSpec(id), truth = camera(spec, { tilt: 30, turn: 12, dist: 200 });
  const corners = spec.corners.map(([u, v]) => truth(u, v, 0)).map(([x, y]) => [x / W, y / H]);
  const b0 = createBoard(corners, { w: W, h: H }, id);
  const frame = renderBoard(spec, truth, b0);
  t('Pi 4: corners off by ~0.7 mm snap back onto the pins', () => {
    const off = b0.pxPerMm * 0.7;
    const bad = corners.map(([x, y], i) => [x + (i % 2 ? off : -off * 0.6) / W, y + (i < 2 ? off * 0.8 : -off * 0.5) / H]);
    const before = Math.max(...Object.values(spec.pins).map(p => { const [x, y] = createBoard(bad, { w: W, h: H }, id).norm(p.u, p.v, spec.headerTop), [tx, ty] = truth(p.u, p.v, spec.headerTop); return Math.hypot(x * W - tx, y * H - ty); }));
    const r = refineCorners(frame, bad, id);
    const b = createBoard(r.corners, { w: W, h: H }, id);
    const after = Math.max(...Object.values(spec.pins).map(p => { const [x, y] = b.norm(p.u, p.v, spec.headerTop), [tx, ty] = truth(p.u, p.v, spec.headerTop); return Math.hypot(x * W - tx, y * H - ty); }));
    assert.ok(after < Math.min(2, before / 3), `pin error ${before.toFixed(2)} -> ${after.toFixed(2)} px ${JSON.stringify({ s: r.score, g: r.gain, m: r.moved })}`);
    return `pin error ${before.toFixed(2)} -> ${after.toFixed(2)} px (score ${r.score?.toFixed(2)})`;
  });
  t('Pi 4: brain reply -> marks on GPIO17 / pin 6, 3D wire, tracker keeps the Pi', () => {
    const marks = [
      { kind: 'wire', label: 'GPIO17 to LED', x: 0.5, y: 0.5, x2: 0.9, y2: 0.9, pin: 'GPIO17', pin2: '' },
      { kind: 'circle', label: 'Ground', x: 0.5, y: 0.5, x2: -1, y2: -1, pin: 'pin 6', pin2: '' },
    ];
    const b = boardFromReply({ model: id, corners }, { w: W, h: H });
    assert.equal(b.part.id, id);
    assert.equal(TRACK_POINTS, spec.track, 'tracker points follow the Pi');
    const r = resolveMarks(marks, b);
    assert.equal(r[0].pinKey, 'GPIO17'); assert.equal(r[1].pinKey, 'GND.1');
    const [tx, ty] = truth(spec.pins.GPIO17.u, spec.pins.GPIO17.v, spec.headerTop);
    assert.ok(Math.hypot(r[0].x * W - tx, r[0].y * H - ty) < 1, 'GPIO17 mark off its pin');
    assert.ok(wireGeometry(b, { pin: 'GPIO17' }, { x: 0.9, y: 0.9 })?.path.length > 10, 'no wire geometry');
    const tr = createMarkTracker();
    tr.seed(frame, marks, { model: id, corners });
    const out = tr.update(frame, Date.now() + 33);
    assert.equal(tr.board?.part.id, id, 'tracker lost the Pi');
    const [x, y] = [out[0].x * W, out[0].y * H];
    assert.ok(Math.hypot(x - tx, y - ty) < 1.5, `tracked GPIO17 ${Math.hypot(x - tx, y - ty).toFixed(2)} px off`);
    assert.ok(out[0].geo, 'tracked wire has no 3D geometry');
    // an UNO afterwards puts the tracker back on the UNO
    boardFromReply({ model: 'uno-r3', corners: [[0.2, 0.18], [0.82, 0.2], [0.8, 0.66], [0.22, 0.64]] }, { w: W, h: H });
    assert.equal(TRACK_POINTS, boardSpec('uno-r3').track);
    return `GPIO17 tracked within ${Math.hypot(x - tx, y - ty).toFixed(2)} px`;
  });
}

// ---------- the twin's pin logic on a library board ----------
t('twin pins.js: marks on a Pi and an ESP32 resolve to library pins', () => {
  const pi = partTable(parts['raspberry-pi-4'], orientation['raspberry-pi-4']);
  pi.features = { usbc: { name: 'USB-C power', u: 11, v: 0 }, ethernet: { name: 'Gigabit Ethernet', u: 85, v: 45 }, board: { name: 'Pi', u: 42, v: 28 } };
  const r = twinPins.resolveMarks(pi, 'raspberry-pi-4', [
    { label: 'GPIO17 → breadboard J10', kind: 'wire', pin: 'GPIO17', pin2: '', x: 0.4, y: 0.2, x2: -1, y2: -1 },
    { label: 'Pin 6 (GND)', kind: 'circle', pin: '', x: -1, y: -1 },
    { label: 'USB-C power', kind: 'circle', pin: '', x: -1, y: -1 },
    { label: 'Ethernet port', kind: 'circle', pin: '', x: -1, y: -1 },
  ], null);
  assert.deepEqual(r[0].from, { on: 'pin', key: 'GPIO17' }); assert.equal(r[0].to?.on, 'bb');
  assert.deepEqual(r[1].from, { on: 'pin', key: 'GND.1' });
  assert.deepEqual(r[2].from, { on: 'feature', key: 'usbc' }); assert.deepEqual(r[3].from, { on: 'feature', key: 'ethernet' });
  assert.equal(twinPins.targetName(pi, 'raspberry-pi-4', r[0].from), 'GPIO17');
  assert.match(pi.info('GPIO17').fn, /pin 11/);
  const esp = partTable(parts['esp32-devkit-v1'], orientation['esp32-devkit-v1']);
  const e = twinPins.resolveMarks(esp, 'esp32-devkit-v1', [{ label: 'D5 to 3V3', kind: 'warn', pin: 'GPIO5', pin2: '3.3V', x: -1, y: -1, x2: -1, y2: -1 }], null);
  assert.deepEqual([e[0].from?.key, e[0].to?.key], ['D5', '3V3']);
  assert.equal(twinPins.targetName(esp, 'esp32-devkit-v1', e[0].from), 'D5');
  assert.equal(twinPins.inferModel({ board: { model: 'raspberry-pi-4' } }, ['raspberry-pi-4']), 'raspberry-pi-4');
  assert.equal(twinPins.inferModel({ marks: [{ label: 'GND' }] }, ['raspberry-pi-4'], 'raspberry-pi-4'), null, 'words flipped a Pi to an UNO');
  assert.equal(twinPins.inferModel({ marks: [{ label: 'USB-C port' }] }), 'uno-r4-wifi', 'UNO inference changed');
});

// ---------- brain prompt + schema ----------
const brain = await import('../brain.mjs');
t('brain: board.model enum = UNO variants + every part id + other/none', () => {
  const en = brain.SCHEMA.properties.board.properties.model.enum;
  for (const id of ['uno-r3', 'uno-r4-wifi', 'uno-q', 'other', 'none', ...Object.keys(index.parts).filter(i => i !== 'arduino-uno')]) assert.ok(en.includes(id), id);
  assert.ok(!en.includes('arduino-uno'));
});
t('brain: prompt has a corner line per registrable board, full rule on demand, still short', () => {
  for (const id of Object.keys(orientation).filter(k => !k.startsWith('_'))) assert.ok(brain.SYSTEM.includes(`- ${id}: `), id);
  assert.match(brain.SYSTEM, /A = the corner where the USB-connector edge meets the long edge with the digital header/);
  assert.match(brain.boardNote('raspberry-pi-4'), /C = .*D = .*Edges/);
  assert.equal(brain.boardNote('uno-r3'), ''); assert.equal(brain.boardNote('uno-q'), '');
  assert.match(brain.SYSTEM, /UNO Q: Qualcomm chip \+ LED matrix \+ USB-C, no barrel jack/);
  assert.ok(brain.SYSTEM.length < 9500, `SYSTEM ${brain.SYSTEM.length} chars`);
  return `SYSTEM ${brain.SYSTEM.length} chars`;
});

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
