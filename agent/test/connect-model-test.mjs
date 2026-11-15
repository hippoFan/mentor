// "Show me how to connect it" (connect.mjs) and exact model id (scan.mjs / research.mjs): free unit checks, then
// (owner testing only) real brain calls:
//   node test/connect-model-test.mjs
//   MENTOR_BRAIN=claude-code MENTOR_OWNER_TESTING=1 node test/connect-model-test.mjs --live [--web]
//     1) analysis: UNO R4 WiFi minus the ESP32-S3 module    2) analysis: UNO R4 WiFi minus the RA4M1 microcontroller
//     3) hole lookup on an UNO photo with no breadboard (must say "not seen")
//     4) scan of a real phone back (runs/.../scan-03.jpg) -> exact model guess  5) research of that model (fresh)
//   5 brain calls in total. Results go to $TMPDIR/ody-live-out.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOLE_SCHEMA, holeAsk, sanitizeHole, stepMarks } from '../connect.mjs';
import { createProject, apply, nextStep, steps } from '../circuit.mjs';
import { SCAN_SCHEMA, parseModelCorrection, sanitizeScan, scanLine } from '../scan.mjs';
import { researchAsk, researchKey } from '../research.mjs';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };
const live = process.argv.includes('--live');

let st = createProject({ board: 'uno-r4-wifi' });
st = apply(st, [{ op: 'add', part: 'hc-sr04' }]).state;
const all = steps(st);
const signal = all.find(s => s.kind === 'jumper' && s.boardPin && !/GND|5V/.test(s.boardPin));
const rail = all.find(s => s.kind === 'jumper' && !s.boardPin);

await test('hole answer sanitiser', () => {
  const h = sanitizeHole({ to: { seen: true, x: 0.4, y: 0.7, confidence: 0.8 }, from: { seen: true, x: 2, y: 0.1, confidence: 0.9 }, corners: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  assert.deepEqual(h.to, { seen: true, x: 0.4, y: 0.7, confidence: 0.8 });
  assert.equal(h.from.seen, false, 'x outside 0..1');
  assert.equal(h.corners.length, 4);
  assert.equal(sanitizeHole({ to: { seen: true, x: 0.5, y: 0.5, confidence: 0.3 } }).to.seen, false, 'low confidence = not seen');
  assert.equal(sanitizeHole({ to: { seen: 'yes', x: 0.5, y: 0.5, confidence: 1 } }).to.seen, false);
  assert.deepEqual(sanitizeHole(null).corners, []);
  assert.deepEqual(sanitizeHole({ corners: [[0, 0], [1, 0], [9, 9], [0, 1]] }).corners, []);
  assert.ok(HOLE_SCHEMA.required.includes('to'));
});

await test('step marks: wire from the exact board pin, ring when the breadboard is not seen', () => {
  assert.ok(signal && rail, 'the HC-SR04 build has a board-pin jumper and a rail jumper');
  const seen = { to: { seen: true, x: 0.6, y: 0.8, confidence: 0.9 }, from: { seen: false, x: -1, y: -1, confidence: 0 }, corners: [] };
  const w = stepMarks(signal, seen);
  assert.equal(w.marks[0].kind, 'wire'); assert.equal(w.marks[0].pin, signal.boardPin); assert.equal(w.marks[0].x2, 0.6); assert.equal(w.toSeen, true);
  assert.equal(w.fallback[0].kind, 'circle'); assert.equal(w.fallback[0].x, 0.6);
  const notSeen = stepMarks(signal, sanitizeHole({ to: { seen: false } }));
  assert.equal(notSeen.marks.length, 1); assert.equal(notSeen.marks[0].kind, 'circle'); assert.equal(notSeen.marks[0].pin, signal.boardPin); assert.equal(notSeen.toSeen, false);
  assert.deepEqual(notSeen.fallback, []);
  const r = stepMarks(rail, { ...seen, from: { seen: true, x: 0.2, y: 0.8, confidence: 0.8 } });
  assert.equal(r.marks[0].kind, 'wire'); assert.equal(r.marks[0].pin, ''); assert.equal(r.marks[0].x, 0.2);
  assert.match(holeAsk(signal, 'uno-r4-wifi'), /USB-connector edge/);
  assert.match(holeAsk(signal, 'uno-r4-wifi'), new RegExp(signal.to.breadboard));
  const n = nextStep(st);
  assert.ok(n.index >= 1 && n.total === all.length);
});

await test('exact model: schema, sanitiser, spoken line, research key + prompt', () => {
  for (const k of ['model_guess', 'model_confidence', 'id_cues', 'alternatives']) assert.ok(SCAN_SCHEMA.required.includes(k), k);
  const s = sanitizeScan({ name: 'Phone in black case', model_guess: 'Samsung Galaxy S23 Ultra', model_confidence: 0.6,
    id_cues: ['four separate lenses in a column', 'flat edges', 'x', 'y', 'z'], alternatives: ['Samsung Galaxy S24 Ultra', 'Samsung Galaxy S22 Ultra', 'Samsung Galaxy S21 Ultra'],
    parts: [{ name: 'Body', shape: 'rounded_box', size_mm: { x: 78, y: 163, z: 9 }, position_mm: { x: 0, y: 0, z: 4.5 } }] });
  assert.equal(s.id_cues.length, 4); assert.equal(s.alternatives.length, 2);
  assert.equal(scanLine(s), "Looks like a Samsung Galaxy S23 Ultra, about 60% sure, from the four separate lenses in a column. It's on your laptop. Tell me if it's a different model.");
  assert.equal(researchKey(s), 'samsung-galaxy-s23-ultra');
  assert.equal(researchKey({ ...s, model_confidence: 0.4 }), 'phone-in-black-case', 'unsure guesses keep the name as the cache key');
  assert.equal(researchKey({ ...s, model_confidence: 0.2, model_guess: 'Galaxy S24 Ultra', model_source: 'user' }), 'galaxy-s24-ultra');
  assert.match(researchAsk(s, true), /Identified model: Samsung Galaxy S23 Ultra \(60% sure/);
  assert.match(researchAsk({ ...s, model_source: 'user' }, true), /confirmed by its owner/);
  assert.doesNotMatch(researchAsk(sanitizeScan({ name: 'Mouse' })), /Identified model/);
  const none = sanitizeScan({ name: 'Mug', model_guess: 'unknown', model_confidence: 0.9, id_cues: ['a'] });
  assert.equal(none.model_guess, ''); assert.equal(none.model_confidence, 0); assert.deepEqual(none.id_cues, []);
});

await test('model correction phrases', () => {
  const yes = [["it's actually a Galaxy S24 Ultra", 'Galaxy S24 Ultra'], ["that's an iPhone 15 Pro", 'iPhone 15 Pro'], ["No, it's a pixel 8 pro", 'Pixel 8 Pro'],
    ['it is a samsung galaxy s23 ultra actually', 'Samsung Galaxy S23 Ultra'], ['this is an Arduino UNO R3', 'Arduino UNO R3'], ['the model is iphone 13 mini', 'iPhone 13 Mini']];
  for (const [t, m] of yes) assert.equal(parseModelCorrection(t), m, t);
  for (const t of ["it's on the table", "that's cool", "it's actually working now", "that's the switch", "it's not a samsung", "this is my project",
    "it's charging", 'what model is it', "I think it's broken"]) assert.equal(parseModelCorrection(t), null, t);
});

if (live) {
  if (process.env.MENTOR_OWNER_TESTING !== '1') { console.error('--live needs MENTOR_BRAIN=claude-code MENTOR_OWNER_TESTING=1'); process.exit(2); }
  const OUT = join(tmpdir(), 'ody-live-out');
  await mkdir(OUT, { recursive: true });
  const { createBrain } = await import('../brain.mjs');
  const { createAnalyzer } = await import('../combo.mjs');
  const { locateHole } = await import('../connect.mjs');
  const { scaleJpeg } = await import('../scan.mjs');
  const { researchInterior } = await import('../research.mjs');
  const brain = await createBrain({});
  const R4 = ['PCB', 'RA4M1 microcontroller', 'ESP32-S3 module', 'USB-C port', 'Barrel jack', 'LED matrix', 'Qwiic connector', 'Reset button', 'ICSP header', 'Pin headers'].map(name => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name }));
  const an = createAnalyzer({ brain });
  const combo = async (removedName, file) => {
    const msg = { scope: 'board', board: 'Arduino UNO R4 WiFi', kept: R4.filter(p => p.name !== removedName), removed: R4.filter(p => p.name === removedName) };
    const r = await an.analyze(msg);
    await writeFile(join(OUT, file), JSON.stringify(r, null, 2));
    console.log(`    ${removedName} removed -> works=${r.works} "${r.title}": ${r.summary}\n      pros ${JSON.stringify(r.pros)}\n      cons ${JSON.stringify(r.cons)}\n      needs ${JSON.stringify(r.needs)}`);
    return r;
  };
  await test('LIVE analysis: UNO R4 WiFi minus the ESP32-S3 module still works (like an UNO R4 Minima)', async () => {
    const r = await combo('ESP32-S3 module', 'analysis-no-esp32.json');
    assert.equal(r.works, true);
    assert.match(`${r.title} ${r.summary} ${r.verdict} ${r.cons.join(' ')}`, /wi-?fi|bluetooth|wireless/i);
  });
  await test('LIVE analysis: UNO R4 WiFi minus the RA4M1 microcontroller does not work', async () => {
    const r = await combo('RA4M1 microcontroller', 'analysis-no-mcu.json');
    assert.equal(r.works, false);
  });
  await test('LIVE hole lookup: UNO photo with no breadboard -> not seen (ring only)', async () => {
    const img = await scaleJpeg(await readFile(fileURLToPath(new URL('./qa/photo.jpg', import.meta.url))), 1024);
    const h = await locateHole(brain, img, signal, 'uno-r3');
    await writeFile(join(OUT, 'hole-no-breadboard.json'), JSON.stringify(h, null, 2));
    console.log(`    to=${JSON.stringify(h.to)} corners=${h.corners.length} (${h.ms} ms)`);
    assert.equal(h.to.seen, false);
    assert.equal(stepMarks(signal, h).marks[0].kind, 'circle');
  });
  const PHONE = fileURLToPath(new URL('../../runs/2026-11-15-04-39-65b46f583e64/scan-03.jpg', import.meta.url));
  let spec = null;
  await test('LIVE scan: real phone back -> exact model guess with cues', async () => {
    if (!existsSync(PHONE)) throw new Error(`missing ${PHONE}`);
    const img = await scaleJpeg(await readFile(PHONE), 1280);
    spec = await brain.scan(img);
    await writeFile(join(OUT, 'phone-scan.json'), JSON.stringify(spec, null, 2));
    console.log(`    ${spec.name}: model_guess "${spec.model_guess}" ${Math.round(spec.model_confidence * 100)}%, cues ${JSON.stringify(spec.id_cues)}, alternatives ${JSON.stringify(spec.alternatives)}\n    says: ${scanLine(spec)}`);
    assert.ok(spec.model_guess, 'a model guess');
    assert.match(spec.model_guess, /galaxy|samsung/i);
    assert.ok(spec.id_cues.length >= 1);
  });
  await test(`LIVE research of that exact model${process.argv.includes('--web') ? ' (web, sources kept)' : ''}`, async () => {
    const img = await scaleJpeg(await readFile(PHONE), 1024);
    const web = process.argv.includes('--web');
    const i = await researchInterior(brain, spec, { image: img, fresh: true, web, cacheDir: join(OUT, 'cache'), timeoutMs: 60_000 });
    await writeFile(join(OUT, 'phone-interior.json'), JSON.stringify(i, null, 2));
    assert.ok(i, 'an interior came back');
    console.log(`    ${i.object} / ${i.model_guess}: ${i.layers.length} layers, ${i.sources.length} sources ${JSON.stringify(i.sources.map(s => s.url))}`);
    assert.match(i.model_guess, /galaxy|samsung/i);
    if (web) assert.ok(i.sources.length >= 1, 'web research keeps its sources');
  });
  await brain.close?.();
  console.log(`live results in ${OUT}`);
}

console.log(`${pass} connect/model tests passed`);
