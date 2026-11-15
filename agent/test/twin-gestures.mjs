// Unit test for the twin's hand gestures, with synthetic MediaPipe landmarks (no camera needed):
//   node test/twin-gestures.mjs
import assert from 'node:assert/strict';
import { createGestures, applyToCamera, classify, synthHand, OneEuro } from '../twin/gestures.js';

const HOME = { theta: 0.18, phi: 0.95, radius: 300, target: [2, 6, 4] };
let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };
/** Runs a sequence of frames (each: list of [pose, cx, cy, size]) at 30 fps; returns the camera and the outputs. */
function run(frames, cam = { ...HOME, target: [...HOME.target] }) {
  const g = createGestures(), outs = [];
  frames.forEach((hands, i) => {
    const o = g.update(hands.map(([pose, cx, cy, size]) => ({ landmarks: synthHand(pose, cx, cy, size) })), i * 33);
    outs.push(o); cam = applyToCamera(cam, o, HOME);
  });
  return { cam, outs };
}
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i / (n - 1)));

test('poses classify', () => {
  for (const p of ['palm', 'point', 'fist', 'pinch']) assert.equal(classify(synthHand(p)).pose, p);
});
test('pinch + drag rotates', () => {
  const { cam, outs } = run(range(30, t => [['pinch', 0.35 + 0.3 * t, 0.5, 0.12]]));
  assert.equal(outs.at(-1).mode, 'rotate');
  assert.ok(HOME.theta - cam.theta > 0.5, `theta moved ${cam.theta}`);
  assert.equal(cam.radius, HOME.radius);
});
test('two-hand pinch spread zooms in', () => {
  const { cam, outs } = run(range(30, t => [['pinch', 0.42 - 0.2 * t, 0.5, 0.11], ['pinch', 0.58 + 0.2 * t, 0.5, 0.11]]));
  assert.equal(outs.at(-1).mode, 'zoom');
  assert.ok(cam.radius < HOME.radius * 0.6, `radius ${cam.radius}`);
});
test('fist + move grabs and moves the model', () => {
  const { cam, outs } = run(range(30, t => [['fist', 0.4 + 0.2 * t, 0.5 + 0.1 * t, 0.12]]));
  assert.equal(outs.at(-1).mode, 'grab');
  const moved = Math.hypot(cam.target[0] - HOME.target[0], cam.target[2] - HOME.target[2]);
  assert.ok(moved > 20, `moved ${moved} mm`);
  assert.equal(cam.theta, HOME.theta);
});
test('open palm held 1 s resets once', () => {
  const start = { theta: 1.5, phi: 0.5, radius: 120, target: [40, 0, 40] };
  const { cam, outs } = run(range(45, () => [['palm', 0.5, 0.5, 0.12]]), start);
  assert.equal(outs.filter(o => o.reset).length, 1);
  assert.deepEqual(cam, HOME);
  const short = run(range(20, () => [['palm', 0.5, 0.5, 0.12]]), start);
  assert.equal(short.outs.filter(o => o.reset).length, 0, 'no reset before 1 s');
});
test('point held ~0.6 s selects under the fingertip', () => {
  const { outs } = run(range(25, () => [['point', 0.6, 0.45, 0.12]]));
  const sel = outs.filter(o => o.select);
  assert.equal(sel.length, 1);
  const tip = synthHand('point', 0.6, 0.45, 0.12)[8];
  assert.ok(Math.abs(sel[0].select.x - tip.x) < 0.01 && Math.abs(sel[0].select.y - tip.y) < 0.01);
  const moving = run(range(25, t => [['point', 0.3 + 0.4 * t, 0.45, 0.12]]));
  assert.equal(moving.outs.filter(o => o.select).length, 0, 'a moving finger does not select');
});
test('no hands = no camera change', () => {
  const { cam, outs } = run(range(10, () => []));
  assert.deepEqual(cam, HOME); assert.equal(outs.at(-1).mode, 'none');
});
test('one-euro filter calms jitter', () => {
  const f = new OneEuro({ minCutoff: 1.2, beta: 0.02 }); let raw = 0, out = 0, prev = null;
  for (let i = 0; i < 120; i++) { const x = 0.5 + (i % 2 ? 0.01 : -0.01); const y = f.filter(x, i * 33); if (prev != null) out += Math.abs(y - prev); raw += 0.02; prev = y; }
  assert.ok(out < raw * 0.4, `filtered motion ${out} vs raw ${raw}`);
});
console.log(`${pass} gesture tests passed`);
