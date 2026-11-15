// Overlays on demand (overlay-policy.mjs), offline: node test/overlay-policy-test.mjs
// Also renders the three cases through the real overlay and checks the pixels: plain turn = untouched camera picture.
import assert from 'node:assert/strict';
import { POINT_INTENT, overlayFrame, shouldDraw } from '../overlay-policy.mjs';
import { HEIGHT, WIDTH, render } from '../overlay.mjs';

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };
const ring = [{ label: 'USB port', x: 0.4, y: 0.4, kind: 'circle', x2: -1, y2: -1, pin: '', pin2: '' }];
const warn = [{ label: 'Short: 5V to GND', x: 0.5, y: 0.6, kind: 'warn', x2: -1, y2: -1, pin: '', pin2: '' }];

test('a turn without a pointing intent draws nothing', () => {
  for (const t of ['okay I plugged it in', 'what now', 'it is blinking', 'I uploaded the code']) assert.equal(shouldDraw(t, ring, 'demand'), false, t);
});
test('asking where / show / which / connect draws', () => {
  for (const t of ['where is the USB port?', 'show me the LED', 'which pin is ground', "what's this chip", 'where does this wire go', 'label the parts', 'connect it how?'])
    assert.equal(shouldDraw(t, ring, 'demand'), true, t);
});
test('a warning is always drawn', () => assert.equal(shouldDraw('it is blinking', warn, 'demand'), true));
test('MENTOR_OVERLAY=always draws every turn', () => assert.equal(shouldDraw('it is blinking', ring, 'always'), true));
test('no marks = nothing to draw', () => assert.equal(shouldDraw('where is it', [], 'demand'), false));
test('intent regex is word-bounded', () => { assert.ok(!POINT_INTENT.test('somewhere else')); assert.ok(!POINT_INTENT.test('whatever')); });

test('marks fade after the TTL and take the caption with them', () => {
  const at = 1_000_000;
  const fresh = overlayFrame({ marks: ring, marksAt: at, now: at + 9_000, caption: 'Plug in USB', speaking: true, mode: 'demand', ttl: 10_000, showSpeaking: false });
  assert.equal(fresh.marks.length, 1); assert.equal(fresh.caption, 'Plug in USB'); assert.equal(fresh.speaking, false);
  const old = overlayFrame({ marks: ring, marksAt: at, now: at + 10_500, caption: 'Plug in USB', mode: 'demand', ttl: 10_000 });
  assert.equal(old.marks.length, 0); assert.equal(old.expired, true); assert.equal(old.caption, '');
  const none = overlayFrame({ marks: [], marksAt: 0, caption: 'Show me your project', mode: 'demand' });
  assert.equal(none.caption, '', 'no caption pill without marks');
  const always = overlayFrame({ marks: [], marksAt: 0, caption: 'Show me your project', speaking: true, mode: 'always', showSpeaking: true });
  assert.equal(always.caption, 'Show me your project'); assert.equal(always.speaking, true);
});

// pixels: a flat grey camera frame; count pixels that differ from the plain render
const W = 640, H = 480, data = new Uint8Array(W * H * 4).fill(128);
const frame = { data, width: W, height: H };
const plain = Uint8Array.from(render(frame, [], { caption: '', speaking: false }));
const differs = px => { let n = 0; for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - plain[i]) + Math.abs(px[i + 1] - plain[i + 1]) + Math.abs(px[i + 2] - plain[i + 2]) > 30) n++; return n; };
const draw = (heard, marks) => {
  const shown = shouldDraw(heard, marks, 'demand') ? marks : [];
  const o = overlayFrame({ marks: shown, marksAt: Date.now(), caption: 'Plug the USB cable in', speaking: true, mode: 'demand', showSpeaking: false });
  return Uint8Array.from(render(frame, o.marks, { caption: o.caption, speaking: o.speaking }));
};
test('rendered: plain turn leaves the camera untouched', () => assert.equal(differs(draw('it is blinking now', ring)), 0));
test('rendered: "where" draws the mark', () => assert.ok(differs(draw('where is the USB port', ring)) > 500));
test('rendered: a warning draws without being asked', () => assert.ok(differs(draw('ok I added a wire', warn)) > 500));
console.log(`${pass} overlay policy tests passed (${WIDTH}x${HEIGHT})`);
