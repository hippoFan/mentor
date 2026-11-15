// Unit test for the twin's hand gestures, with synthetic MediaPipe landmarks (no camera needed):
//   node test/twin-gestures.mjs
// (the in-browser run of the same gestures, with ?handsim=1 and screenshots, is test/twin-gestures-test.mjs)
import assert from 'node:assert/strict';
import { createGestures, applyToCamera, classify, synthHand, OneEuro, TUNING, pinchGap, createInertia } from '../twin/gestures.js';

const HOME = { theta: 0.18, phi: 0.95, radius: 300, target: [2, 6, 4] };
let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };
/** A hand spec: [pose, cx, cy, size, opts?]. */
const hand = ([pose, cx, cy, size, o]) => ({ landmarks: synthHand(pose, cx, cy, size, o) });
/** Runs frames (each: list of hand specs) at 30 fps; returns the camera and the outputs. */
function run(frames, cam = { ...HOME, target: [...HOME.target] }) {
  const g = createGestures(), outs = [];
  frames.forEach((hands, i) => {
    const o = g.update(hands.map(hand), i * 33);
    outs.push(o); cam = applyToCamera(cam, o, HOME);
  });
  return { cam, outs };
}
const range = (n, f) => Array.from({ length: n }, (_, i) => f(n > 1 ? i / (n - 1) : 0, i));
const hold = (n, hands) => range(n, () => hands);
/** A pinch must close to engage: n frames of the same hand open (gap 1 palm) before it pinches. */
const opened = (n, [pose, cx, cy, size, o]) => hold(n, [['pinch', cx, cy, size, { ...o, gap: 1 }]]);

test('poses classify', () => {
  for (const p of ['palm', 'point', 'fist', 'pinch', 'thumbs']) assert.equal(classify(synthHand(p)).pose, p);
});
test('handedness-agnostic: a mirrored (other) hand classifies the same', () => {
  for (const p of ['palm', 'point', 'fist', 'pinch', 'thumbs']) assert.equal(classify(synthHand(p, 0.5, 0.5, 0.12, { mirror: true })).pose, p, p);
});
test('pinch hysteresis: engages below pinchOn, holds until above pinchOff', () => {
  const at = (gap, was) => classify(synthHand('pinch', 0.5, 0.5, 0.12, { gap }), was).pose === 'pinch';
  assert.equal(at(0.38, false), false, 'between the thresholds, not yet pinching: no pinch');
  assert.equal(at(0.24, false), true, 'below pinchOn engages');
  assert.equal(at(0.42, true), true, 'between the thresholds while pinching: still a pinch');
  assert.equal(at(0.56, true), false, 'above pinchOff releases');
  // same through the recogniser: once engaged, a gap wobbling 0.30 .. 0.44 never drops the grab
  const { outs } = run(range(40, (t, i) => [['pinch', 0.5, 0.5, 0.12, { gap: i < 4 ? 0.7 : i < 14 ? 0.15 : 0.3 + 0.14 * (i % 2) }]]));
  const ends = outs.filter(o => o.grab === 'end').length, starts = outs.filter(o => o.grab === 'start').length;
  assert.equal(starts, 1); assert.equal(ends, 0);
  assert.ok(Math.abs(TUNING.pinchOff - TUNING.pinchOn) > 0.1);
});
test('debounce: a pinch flicker under 150 ms never grabs; a held one does', () => {
  const flick = run([...hold(8, [['palm', 0.5, 0.5, 0.12]]), ...hold(3, [['pinch', 0.5, 0.5, 0.12]]), ...hold(10, [['palm', 0.5, 0.5, 0.12]])]);
  assert.equal(flick.outs.filter(o => o.mode === 'rotate' || o.grab).length, 0, 'flicker counted');
  const held = run([...hold(8, [['palm', 0.5, 0.5, 0.12]]), ...hold(8, [['pinch', 0.5, 0.5, 0.12]])]);
  assert.equal(held.outs.filter(o => o.grab === 'start').length, 1);
  assert.equal(held.outs.at(-1).mode, 'rotate');
});
test('pinch + drag rotates (gain curve: fast > slow per distance)', () => {
  const { cam, outs } = run([...opened(4, ['pinch', 0.35, 0.5, 0.12]), ...hold(6, [['pinch', 0.35, 0.5, 0.12]]), ...range(30, t => [['pinch', 0.35 + 0.3 * t, 0.5, 0.12]])]);
  assert.equal(outs.at(-1).mode, 'rotate');
  assert.ok(HOME.theta - cam.theta > 0.5, `theta moved ${cam.theta}`);
  assert.equal(cam.radius, HOME.radius);
  const slow = run([...opened(4, ['pinch', 0.35, 0.5, 0.12]), ...hold(6, [['pinch', 0.35, 0.5, 0.12]]), ...range(90, t => [['pinch', 0.35 + 0.3 * t, 0.5, 0.12]])]);
  assert.ok(HOME.theta - cam.theta > HOME.theta - slow.cam.theta, 'a fast drag turns further than the same slow drag');
});
test('rotation dead-zone: a trembling pinch does not turn the view', () => {
  const { cam, outs } = run([...opened(4, ['pinch', 0.5, 0.5, 0.12]), ...range(40, (t, i) => [['pinch', 0.5 + (i % 2 ? 0.003 : -0.003), 0.5 + (i % 3 ? 0.002 : -0.002), 0.12]])]);
  assert.equal(outs.at(-1).mode, 'rotate', 'pinching');
  assert.ok(Math.abs(cam.theta - HOME.theta) < 1e-6 && Math.abs(cam.phi - HOME.phi) < 1e-6, `moved ${cam.theta} ${cam.phi}`);
});
test('two hands apart zoom in, together zoom out (inter-hand distance, any pose)', () => {
  const inn = run(range(30, t => [['palm', 0.4 - 0.2 * t, 0.5, 0.11], ['palm', 0.6 + 0.2 * t, 0.5, 0.11]]));
  assert.equal(inn.outs.at(-1).mode, 'zoom');
  assert.ok(inn.cam.radius < HOME.radius * 0.6, `radius ${inn.cam.radius}`);
  const out = run(range(30, t => [['pinch', 0.2 + 0.2 * t, 0.5, 0.11], ['pinch', 0.8 - 0.2 * t, 0.5, 0.11]]));
  assert.ok(out.cam.radius > HOME.radius * 1.4, `radius ${out.cam.radius}`);
  const still = run(range(30, (t, i) => [['palm', 0.35 + (i % 2) * 0.004, 0.5, 0.11], ['palm', 0.65, 0.5, 0.11]]));
  assert.equal(still.cam.radius, HOME.radius, 'zoom dead-zone');
});
test('a second hand flickering in for < 150 ms does not start a zoom', () => {
  const { outs, cam } = run([...hold(10, [['pinch', 0.5, 0.5, 0.12]]), ...hold(3, [['pinch', 0.5, 0.5, 0.12], ['palm', 0.2, 0.5, 0.12]]), ...hold(10, [['pinch', 0.5, 0.5, 0.12]])]);
  assert.equal(outs.filter(o => o.mode === 'zoom').length, 0); assert.equal(cam.radius, HOME.radius);
});
test('closest (largest) hand leads, wherever it is in the list', () => {
  const { cam, outs } = run([...hold(4, [['palm', 0.3, 0.4, 0.065], ['pinch', 0.4, 0.55, 0.13, { gap: 1 }]]), ...range(36, t => [['palm', 0.3, 0.4, 0.065], ['pinch', 0.4 + 0.3 * Math.max(0, t - 0.2), 0.55, 0.13]])]);
  assert.equal(outs.at(-1).mode, 'rotate', 'the big pinching hand leads, the smaller far one is not a second hand');
  assert.ok(HOME.theta - cam.theta > 0.3, `theta ${cam.theta}`);
  assert.equal(cam.radius, HOME.radius, 'no zoom from the far hand');
});
test('tiny background hand ignored', () => {
  const alone = run(range(30, t => [['pinch', 0.3 + 0.4 * t, 0.5, 0.035]]));
  assert.deepEqual(alone.cam, HOME); assert.equal(alone.outs.at(-1).status, 'none'); assert.equal(alone.outs.at(-1).ignored, 1);
  const withUser = run(range(30, t => [['fist', 0.2 + 0.5 * t, 0.3, 0.035], ['palm', 0.55, 0.5, 0.12]]));
  assert.ok(withUser.outs.every(o => o.mode !== 'zoom' && !o.reset), 'background fist neither zooms nor resets');
  assert.equal(withUser.outs.at(-1).mode, 'hover'); assert.equal(withUser.outs.at(-1).hands, 1);
});
test('too close is reported', () => {
  assert.equal(run(hold(5, [['palm', 0.5, 0.5, 0.42]])).outs.at(-1).status, 'close');
  assert.equal(run(hold(5, [['palm', 0.5, 0.5, 0.12]])).outs.at(-1).status, 'ok');
});
test('fist held ~0.7 s resets once; a short fist does not', () => {
  const start = { theta: 1.5, phi: 0.5, radius: 120, target: [40, 0, 40] };
  const { cam, outs } = run(hold(40, [['fist', 0.5, 0.5, 0.12]]), start);
  assert.equal(outs.filter(o => o.reset).length, 1);
  assert.deepEqual(cam, HOME);
  const short = run(hold(18, [['fist', 0.5, 0.5, 0.12]]), start);
  assert.equal(short.outs.filter(o => o.reset).length, 0, 'no reset before the hold');
  assert.ok(short.outs.at(-1).dwell > 0.3, 'the hold shows progress');
});
test('open palm hovers (never resets)', () => {
  const { cam, outs } = run(hold(60, [['palm', 0.5, 0.5, 0.12]]));
  assert.deepEqual(cam, HOME); assert.equal(outs.at(-1).mode, 'hover');
  const tip = synthHand('palm', 0.5, 0.5, 0.12)[8];
  assert.ok(Math.abs(outs.at(-1).cursor.x - tip.x) < 1e-6, 'cursor = index fingertip');
});
test('thumbs up held fires once', () => {
  const { outs } = run(hold(30, [['thumbs', 0.5, 0.5, 0.12]]));
  assert.equal(outs.filter(o => o.thumbsUp).length, 1); assert.equal(outs.at(-1).mode, 'thumbs');
});
test('flick sideways fires once, from where the hand rested', () => {
  const { outs } = run([...hold(12, [['palm', 0.4, 0.5, 0.12]]), ...range(4, t => [['palm', 0.4 + 0.33 * t, 0.5, 0.12]]), ...hold(8, [['palm', 0.73, 0.5, 0.12]])]);
  const f = outs.filter(o => o.flick);
  assert.equal(f.length, 1); assert.equal(f[0].flick.dir, 1);
  const tip = synthHand('palm', 0.4, 0.5, 0.12)[8];
  assert.ok(Math.abs(f[0].flick.from.x - tip.x) < 0.03, `from ${f[0].flick.from.x} vs ${tip.x}`);
  const slow = run(range(40, t => [['palm', 0.3 + 0.4 * t, 0.5, 0.12]]));
  assert.equal(slow.outs.filter(o => o.flick).length, 0, 'an ordinary move is not a flick');
  const pinched = run([...opened(4, ['pinch', 0.4, 0.5, 0.12]), ...hold(8, [['pinch', 0.4, 0.5, 0.12]]), ...range(4, t => [['pinch', 0.4 + 0.33 * t, 0.5, 0.12]])]);
  assert.equal(pinched.outs.filter(o => o.flick).length, 0, 'a fast pinch-drag is not a flick');
});
test('pinch-pull: the hand growing moves a held part toward the camera', () => {
  const { outs } = run([...opened(4, ['pinch', 0.5, 0.5, 0.12]), ...hold(8, [['pinch', 0.5, 0.5, 0.12]]), ...range(20, t => [['pinch', 0.5, 0.5, 0.12 + 0.05 * t]])]);
  const pull = outs.reduce((s, o) => s + o.pull, 0);
  assert.ok(pull > 0.15, `pull ${pull}`);
  const still = run([...opened(4, ['pinch', 0.5, 0.5, 0.12]), ...hold(30, [['pinch', 0.5, 0.5, 0.12]])]);
  assert.equal(still.outs.at(-1).mode, 'rotate'); assert.equal(still.outs.reduce((s, o) => s + o.pull, 0), 0);
});
test('a missed detection frame is bridged (no drop)', () => {
  const frames = [...opened(4, ['pinch', 0.5, 0.5, 0.12]), ...hold(10, [['pinch', 0.5, 0.5, 0.12]]), [], ...hold(4, [['pinch', 0.5, 0.5, 0.12]])];
  const { outs } = run(frames);
  assert.equal(outs.filter(o => o.grab === 'start').length, 1);
  assert.equal(outs.filter(o => o.grab === 'end').length, 0); assert.equal(outs[14].mode, 'rotate');
});
test('point held ~0.6 s selects under the fingertip', () => {
  const { outs } = run(hold(30, [['point', 0.6, 0.45, 0.12]]));
  const sel = outs.filter(o => o.select);
  assert.equal(sel.length, 1);
  const tip = synthHand('point', 0.6, 0.45, 0.12)[8];
  assert.ok(Math.abs(sel[0].select.x - tip.x) < 0.01 && Math.abs(sel[0].select.y - tip.y) < 0.01);
  const moving = run(range(30, t => [['point', 0.3 + 0.4 * t, 0.45, 0.12]]));
  assert.equal(moving.outs.filter(o => o.select).length, 0, 'a moving finger does not select');
});
test('no hands = no camera change', () => {
  const { cam, outs } = run(hold(10, []));
  assert.deepEqual(cam, HOME); assert.equal(outs.at(-1).mode, 'none'); assert.equal(outs.at(-1).status, 'none');
});
test('one-euro filter calms jitter', () => {
  const f = new OneEuro({ minCutoff: 1.2, beta: 0.02 }); let raw = 0, out = 0, prev = null;
  for (let i = 0; i < 120; i++) { const x = 0.5 + (i % 2 ? 0.01 : -0.01); const y = f.filter(x, i * 33); if (prev != null) out += Math.abs(y - prev); raw += 0.02; prev = y; }
  assert.ok(out < raw * 0.4, `filtered motion ${out} vs raw ${raw}`);
});
test('3D gap: an edge-on hand whose tips overlap on screen but not in depth is no pinch', () => {
  const flat = synthHand('pinch', 0.5, 0.5, 0.12), edge = synthHand('pinch', 0.5, 0.5, 0.12, { thumbZ: 0.5 });
  assert.equal(classify(flat).pose, 'pinch');
  assert.notEqual(classify(edge).pose, 'pinch', `gap ${pinchGap(edge).toFixed(2)}`);
  assert.ok(pinchGap(edge, 4 / 3) > pinchGap(edge), 'depth is scaled by the camera aspect like x');
  const { outs } = run([...opened(4, ['pinch', 0.5, 0.5, 0.12]), ...hold(20, [['pinch', 0.5, 0.5, 0.12, { thumbZ: 0.5 }]])]);
  assert.equal(outs.filter(o => o.grab === 'start').length, 0, 'edge-on overlap grabbed');
});
test('closing gap: a hand that arrives already pinched never grabs; open then pinch does', () => {
  const arrives = run(hold(30, [['pinch', 0.5, 0.5, 0.12]]));
  assert.equal(arrives.outs.filter(o => o.grab === 'start' || o.mode === 'rotate').length, 0);
  const closes = run([...hold(30, [['pinch', 0.5, 0.5, 0.12]]), ...opened(5, ['pinch', 0.5, 0.5, 0.12]), ...hold(8, [['pinch', 0.5, 0.5, 0.12]])]);
  assert.equal(closes.outs.filter(o => o.grab === 'start').length, 1, 'opening and pinching again engages');
  // a slow drift of the gap to just under pinchOn (no real closing) does not engage either
  const drift = run(range(60, t => [['pinch', 0.5, 0.5, 0.12, { gap: 0.4 - 0.15 * t }]]));
  assert.equal(drift.outs.filter(o => o.grab === 'start').length, 0, 'a creeping gap engaged');
});
test('pinch-onset rewind: the grab lands where the ring was when the fingers started closing', () => {
  const size = 0.12, x0 = 0.45, drift = 0.04;
  const frames = [...opened(12, ['pinch', x0, 0.5, size]),
    ...range(3, (t, i) => [['pinch', x0 + drift * (i + 1) / 3, 0.5, size, { gap: 0.66 - 0.33 * i }]]),   // closing ~100 ms, drifting
    ...hold(10, [['pinch', x0 + drift, 0.5, size]])];
  const { outs } = run(frames);
  const at = outs.findIndex(o => o.grab === 'start'); assert.ok(at > 0, 'no grab');
  const tip0 = synthHand('pinch', x0, 0.5, size, { gap: 1 })[8].x, now = synthHand('pinch', x0 + drift, 0.5, size)[8].x;
  const c = outs[at].cursor.x;
  assert.ok(Math.abs(c - tip0) < 0.3 * drift, `grab at ${c.toFixed(3)}, aimed ${tip0.toFixed(3)}, drifted tip ${now.toFixed(3)}`);
  assert.ok(Math.abs(outs.at(-1).cursor.x - c) < 0.006, 'the ring holds the rewound spot while the pinch is still');
  // the ring stays continuous: no jump between frames anywhere in the hover -> pinch -> hold sequence beyond the rewind
  const hover = run(range(30, t => [['palm', 0.3 + 0.3 * t, 0.5, size]])).outs;
  const tipAt = synthHand('palm', 0.6, 0.5, size)[8].x;
  assert.ok(hover.at(-1).cursor.x > tipAt - 0.002, 'the ring leads (is predicted ahead of) a moving fingertip');
  const still = run(hold(20, [['palm', 0.6, 0.5, size]])).outs.at(-1).cursor.x;
  assert.ok(Math.abs(still - tipAt) < 1e-4, 'and sits exactly on a still one');
});
test('inertia: a turn let go while moving coasts (x0.92 per frame) to a stop; a stopped one does not', () => {
  const sp = createInertia(); sp.fling(1, 0); let sum = 0, n = 0;
  while (sp.active && n < 500) { sum += sp.step(1 / 60)[0]; n++; }
  assert.ok(!sp.active && n < 120, `${n} frames`); assert.ok(Math.abs(sum - (1 / 60) / (1 - 0.92)) < 0.03, `coasted ${sum.toFixed(3)}`);   // ~0.2 s of the release speed
  const s30 = createInertia(); s30.fling(1, 0); let sum30 = 0; while (s30.active) sum30 += s30.step(1 / 30)[0];
  assert.ok(Math.abs(sum30 - sum) / sum < 0.02, `30 fps ${sum30.toFixed(3)} vs 60 fps ${sum.toFixed(3)}`);
  const lead = [...opened(4, ['pinch', 0.3, 0.5, 0.12]), ...hold(6, [['pinch', 0.3, 0.5, 0.12]])];
  const fast = run([...lead, ...range(12, t => [['pinch', 0.3 + 0.25 * t, 0.5, 0.12]]), ...range(8, (t, i) => [['pinch', 0.55 + 0.02 * (i + 1), 0.5, 0.12, { gap: 1.2 }]])]);
  const f = fast.outs.filter(o => o.fling);
  assert.equal(f.length, 1, 'one fling'); assert.ok(f[0].fling[0] > 0.5, `fling ${f[0].fling}`);
  const stopped = run([...lead, ...range(12, t => [['pinch', 0.3 + 0.25 * t, 0.5, 0.12]]), ...hold(10, [['pinch', 0.55, 0.5, 0.12]]), ...hold(8, [['pinch', 0.55, 0.5, 0.12, { gap: 1.2 }]])]);
  assert.equal(stopped.outs.filter(o => o.fling).length, 0, 'stopped, then let go: no coasting');
});
test('two-hand twist rolls the view (clockwise = positive), small twists and pure zooms do not', () => {
  const pair = (deg, r = 0.15) => { const a = deg * Math.PI / 180, dx = Math.cos(a) * r, dy = Math.sin(a) * r; return [['palm', 0.5 - dx, 0.5 - dy, 0.11], ['palm', 0.5 + dx, 0.5 + dy, 0.11]]; };
  const roll = frames => run(frames).outs.reduce((s, o) => s + o.roll, 0);
  const cw = roll([...hold(6, pair(0)), ...range(24, t => pair(40 * t))]);
  assert.ok(cw > 0.35 && cw < 0.75, `roll ${cw.toFixed(3)} rad for a 40 degree twist`);
  assert.ok(roll([...hold(6, pair(0)), ...range(24, t => pair(-40 * t))]) < -0.35, 'counter-clockwise rolls back');
  assert.equal(roll([...hold(6, pair(0)), ...range(24, t => pair(5 * t))]), 0, 'a 5 degree wobble');
  assert.equal(roll(range(30, t => pair(0, 0.1 + 0.1 * t))), 0, 'zooming alone');
});
console.log(`${pass} gesture tests passed`);
