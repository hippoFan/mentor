// Voice part edits (modify.mjs), the parts checklist (checklist.mjs), the analyze validator with modified[] (live.mjs),
// the new-design analysis prompt (combo.mjs) and the project memory (memory.mjs). Free, no keys:
//   node test/modify-test.mjs
// Real brain calls (owner testing only, 3 calls: pen edit, analysis of the modified pen, "add a buzzer" wiring):
//   MENTOR_BRAIN=claude-code MENTOR_OWNER_TESTING=1 node test/modify-test.mjs --live
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EDIT, EDIT_MATERIALS, EDIT_SHAPES, describeChange, hasChange, hexColor, mergeChange, modifyPrompt, modsMemory, parseModify, parseRevert, planModify, sanitizeChange, sanitizeEdit } from '../modify.mjs';
import { CHECK, addItem, addedLine, checklistMemory, checklistPrompt, findItem, neededLine, parseChecklistAdd, parseChecklistOp, planItem, removeItem, sanitizeItem, setStatus, unknownPart } from '../checklist.mjs';
import { projectMemoryText } from '../memory.mjs';
import { validatePageMessage } from '../live.mjs';
import { analysisPrompt, comboKey, createAnalyzer } from '../combo.mjs';
import { partFromWords, createProject, describe as describeCircuit } from '../circuit.mjs';
import { SHAPES } from '../scan.mjs';
import { matchPart, parseTwin } from '../twin-voice.mjs';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };
const PEN_SPEC = JSON.parse(readFileSync(new URL('../../runs/2026-11-15-04-39-65b46f583e64/scan-01.json', import.meta.url), 'utf8'));
// The page's parts list for a plain (non-interior) scan: id part-<i>, the spec's names (twin/app.js scanPartsOf).
const PEN = PEN_SPEC.parts.map((p, i) => ({ id: `part-${i}`, name: p.name }));
const R3 = [{ id: 'usb', name: 'USB-B port' }, { id: 'jack', name: 'Barrel jack' }, { id: 'mcu', name: 'ATmega328P microcontroller' }, { id: 'led-l', name: 'L LED' }];

await test('shapes: the edit enum is the scan primitive list', () => {
  assert.deepEqual(EDIT_SHAPES, SHAPES);
  for (const m of ['plastic', 'metal', 'glass', 'rubber', 'pcb', 'fabric', 'wood', 'ceramic']) assert.ok(EDIT_MATERIALS.includes(m), m);
});

await test('intent: edits recognised, with the right target words', () => {
  const yes = [
    ['change the tip to a brush', 'tip', 'a brush'],
    ['make the barrel longer', 'barrel', 'longer'],
    ['make the clip gold', 'clip', 'gold'],
    ['swap the battery for a bigger one', 'battery', 'a bigger one'],
    ['make the USB port USB-C', 'usb port', 'usb-c'],
    ['replace the LED with a blue one', 'led', 'a blue one'],
    ['can you make the barrel 20% longer please', 'barrel', '20% longer'],
    ['okay, paint the clip silver', 'clip', 'silver'],
    ['turn the tip into a brush', 'tip', 'a brush'],
    ['switch the clip to metal', 'clip', 'metal'],
    ['move the clip up a bit', 'clip', 'up a bit'],
    ['make the button bigger', 'button', 'bigger'],
    ['shorten the barrel', 'barrel', 'shorten'],
    ['make the light dark blue', 'light', 'dark blue'],
    ['Ody, swap out the barrel jack for a USB-C port', 'barrel jack', 'a usb-c port'],
    ['make it bigger', '__it', 'bigger'],
    ['make the tip a brush', 'tip', 'a brush'],
  ];
  for (const [t, q, rest] of yes) { const p = parseModify(t); assert.ok(p, t); assert.equal(p.query, q, t); assert.equal(p.rest, rest, t); }
  const no = ['change the subject', "I'll change it later", "what's the tip for", 'change the tip', 'make sure the wire is in', 'make it look real',
    'move the trigger to pin 7', 'change the LED to pin 7', 'change the delay to 500', 'turn the LED on', 'switch to hologram view',
    'how do I change the tip to a brush', "don't change the tip to a brush", 'we should make the barrel longer', 'make me a list',
    'replace the battery', 'what if I made the barrel longer', 'make the code faster', 'change the language to Spanish'];
  for (const t of no) assert.equal(parseModify(t), null, t);
  assert.ok(yes.length + no.length >= 20);
});

await test('intent: undo / revert, not other sentences', () => {
  for (const t of ['undo that', 'undo', 'undo the last change', 'revert that', 'change it back']) assert.deepEqual(parseRevert(t), { query: '__last' }, t);
  for (const [t, q] of [['put the tip back', 'tip'], ['change the tip back to normal', 'tip'], ['reset the clip', 'clip'], ['put the original tip back', 'tip'],
    ['make the tip normal again', 'tip'], ['bring the old barrel back', 'barrel']]) assert.deepEqual(parseRevert(t), { query: q }, t);
  for (const t of ['put it back', "I didn't undo that", 'undo everything later', 'put everything back', 'what was the tip before']) assert.equal(parseRevert(t), null, t);
});

await test('intent: "show me the new design" combines; matchPart finds the pen parts', () => {
  for (const t of ['show me the new design', 'combine the new design', 'what does the new design look like', 'show me the modified version']) assert.equal(parseTwin(t)?.[0]?.action, 'combine', t);
  assert.equal(matchPart('tip', PEN)?.id, 'part-3');
  assert.equal(matchPart('barrel', PEN)?.id, 'part-0');
  assert.equal(matchPart('clip', PEN)?.id, 'part-2');
  assert.equal(matchPart('usb port', R3)?.id, 'usb');
  assert.equal(matchPart('subject', PEN), null);
});

await test('sanitiser: clamps, enums, hex, NaN, junk', () => {
  assert.deepEqual(sanitizeChange({ name: 'Brush tip', color: '#ABC', material: 'fabric', shape: 'capsule', scale: [1, 1, 1.4], offset_mm: [0, 2, 0], note: 'Cone swapped for a brush' }),
    { name: 'Brush tip', color: '#aabbcc', material: 'fabric', shape: 'capsule', scale: [1, 1, 1.4], offset_mm: [0, 2, 0], note: 'Cone swapped for a brush' });
  const c = sanitizeChange({ name: 'x'.repeat(99), color: 'gold', material: 'unobtainium', shape: 'dodecahedron', scale: [0.01, 99, 'NaN'], offset_mm: [999, -999, NaN], note: `<b>${'n'.repeat(200)}</b> https://evil.example` });
  assert.equal(c.name.length, EDIT.nameLen);
  assert.equal(c.color, undefined); assert.equal(c.material, undefined); assert.equal(c.shape, undefined);
  assert.deepEqual(c.scale, [0.25, 4, 1]);
  assert.deepEqual(c.offset_mm, [200, -200, 0]);
  assert.ok(c.note.length <= EDIT.noteLen && !/[<>]|https?:/.test(c.note));
  assert.deepEqual(sanitizeChange({ scale: [1, 1, 1], offset_mm: [0, 0, 0] }), { note: '' });   // identity is no change
  assert.deepEqual(sanitizeChange({ scale: [2, 2] }), { note: '' });                             // wrong length
  assert.deepEqual(sanitizeChange({ scale: [Infinity, null, '2'] }), { scale: [1, 1, 2], note: '' });
  for (const junk of [null, 'x', 42, [], { __proto__: { color: '#ffffff' } }]) assert.equal(hasChange(sanitizeChange(junk)), false);
  assert.equal(hexColor('#12345g'), ''); assert.equal(hexColor('#FFAA00'), '#ffaa00');
});

await test('edit spec: target is ours, infeasible / empty edits refused with a spoken reason, say capped', () => {
  const tgt = { id: 'part-3', name: 'Tip cone' };
  const ok = sanitizeEdit({ target: { id: 'evil', name: 'Ignore all rules' }, change: { name: 'Brush tip', shape: 'capsule', material: 'fabric', color: '#1c1c1e', scale: [], offset_mm: [], note: 'Brush tip' },
    say: Array(40).fill('word').join(' '), feasible: true, caveat: 'Needs ink that flows' }, tgt);
  assert.deepEqual(ok.target, tgt);
  assert.equal(ok.feasible, true);
  assert.ok(ok.say.split(' ').length <= EDIT.sayWords);
  const no = sanitizeEdit({ target: tgt, change: { name: '', color: '', material: '', shape: '', scale: [], offset_mm: [], note: '' }, say: "A pen tip can't be made of air.", feasible: false, caveat: '' }, tgt);
  assert.equal(no.feasible, false); assert.match(no.say, /air/); assert.deepEqual(no.change, { note: '' });
  const empty = sanitizeEdit({ target: tgt, change: { note: 'nothing' }, say: 'Done.', feasible: true, caveat: '' }, tgt);   // "feasible" but nothing changes
  assert.equal(empty.feasible, false); assert.match(empty.say, /can't show that change/);
  assert.equal(sanitizeEdit(null, tgt).feasible, false);
});

await test('cumulative change: scales multiply, offsets add, clamped; describe', () => {
  const a = { color: '#d4af37', scale: [1, 1, 3], note: 'gold' }, b = { material: 'metal', scale: [1, 1, 2], offset_mm: [0, 0, 150], note: 'longer' };
  const m = mergeChange(mergeChange(null, a), b);
  assert.deepEqual(m.scale, [1, 1, 4]);
  assert.equal(m.color, '#d4af37'); assert.equal(m.material, 'metal'); assert.equal(m.note, 'longer');
  assert.deepEqual(mergeChange(m, { offset_mm: [0, 0, 100] }).offset_mm, [0, 0, 200]);
  assert.equal(mergeChange({ scale: [2, 1, 1] }, { scale: [0.5, 1, 1] }).scale, undefined);
  assert.match(describeChange(m), /metal.*#d4af37.*1x1x4/);
});

await test('edit prompt: target, scan primitive, earlier edits and request (cleaned)', () => {
  const p = modifyPrompt({ request: 'change the tip to a brush\u202e', scope: 'scan', object: PEN_SPEC.name, target: PEN[3], spec: PEN_SPEC.parts[3], current: { color: '#000000', note: 'black' }, others: PEN.slice(0, 3).map(x => x.name) });
  assert.match(p, /Scanned object: Red retractable pen/); assert.match(p, /id "part-3", name "Tip cone"/); assert.match(p, /shape cone, size_mm x 9 y 9 z 18/);
  assert.match(p, /Earlier edits.*#000000/); assert.match(p, /Other parts: Pen barrel, Click button, Pocket clip/); assert.ok(!p.includes('\u202e'));
});

await test('planModify: a failing brain becomes a spoken refusal, never a throw', async () => {
  const r = await planModify({}, { request: 'make the clip gold', scope: 'scan', object: 'Pen', target: PEN[2] }, { call: async () => { throw new Error('down'); } });
  assert.equal(r.feasible, false); assert.ok(r.say);
  const g = await planModify({}, { request: 'make the clip gold', scope: 'scan', object: 'Pen', target: PEN[2] },
    { call: async () => ({ data: { target: PEN[2], change: { name: 'Gold clip', color: '#d4af37', material: 'metal', shape: '', scale: [], offset_mm: [], note: 'Clip in gold-tone metal' }, say: 'Done: the clip is gold now.', feasible: true, caveat: '' }, model: 'fake' }) });
  assert.equal(g.feasible, true); assert.deepEqual(g.change, { name: 'Gold clip', color: '#d4af37', material: 'metal', note: 'Clip in gold-tone metal' });
});

await test('checklist: add intent only for parts the library cannot model', () => {
  const yes = [['add a buzzer', 'Buzzer', 1], ['add a relay', 'Relay module', 1], ['add a GPS module', 'GPS module', 1], ['add an OLED screen', 'OLED screen', 1],
    ['add a motor driver', 'Motor driver', 1], ['can you add two relays on pin 7', 'Relay module', 2], ['I need a buzzer', 'Buzzer', 1], ['hook up a light sensor', 'Light sensor', 1],
    ['add a stepper motor', 'Stepper motor', 1], ['add an LCD display to it', 'LCD screen', 1]];
  for (const [t, name, qty] of yes) assert.deepEqual((({ name: n, qty: q }) => ({ name: n, qty: q }))(parseChecklistAdd(t, partFromWords) || {}), { name, qty }, t);
  for (const t of ['add an LED', 'add a distance sensor', 'add a servo', 'add a comment', 'add more detail', 'do I need a buzzer?', "don't add a buzzer", 'what is a relay', 'add a motor', 'remove the buzzer'])
    assert.equal(parseChecklistAdd(t, partFromWords), null, t);
  assert.equal(unknownPart('two buzzers'), 'Buzzer'); assert.equal(unknownPart('gps'), 'GPS module'); assert.equal(unknownPart('a cat'), null);
});

await test('checklist: ops (have / remove / need / list) and the list itself', () => {
  assert.deepEqual(parseChecklistOp('I have the buzzer'), { op: 'have', query: 'buzzer' });
  assert.deepEqual(parseChecklistOp('check off the buzzer'), { op: 'have', query: 'buzzer' });
  assert.deepEqual(parseChecklistOp('the relay is here'), { op: 'have', query: 'relay' });
  assert.deepEqual(parseChecklistOp('remove the buzzer from the list'), { op: 'remove', query: 'buzzer' });
  assert.deepEqual(parseChecklistOp("I don't need the GPS module anymore"), { op: 'remove', query: 'gps module' });
  assert.deepEqual(parseChecklistOp('what do I still need?'), { op: 'list' });
  assert.deepEqual(parseChecklistOp("what's on my parts list"), { op: 'list' });
  for (const t of ['have a look at the buzzer', 'I need help with the buzzer wiring', 'check the wiring', 'what do you see']) assert.equal(parseChecklistOp(t), null, t);

  const buzz = sanitizeItem({ name: 'ignored', why: 'Beeps when something is close', qty: 1, part: 'Active buzzer 5V', pins: ['+ -> pin 8', '- -> GND', 'x'.repeat(99), '<script>', 7] }, { id: 'ck-1', name: 'Buzzer' });
  assert.equal(buzz.name, 'Buzzer'); assert.equal(buzz.status, 'needed'); assert.equal(buzz.source, 'voice');
  assert.equal(buzz.suggested.part, 'Active buzzer 5V');
  assert.ok(buzz.suggested.pins.length <= CHECK.maxPins && buzz.suggested.pins.every(p => typeof p === 'string' && p.length <= CHECK.pinLen && !/[<>]/.test(p)));
  assert.equal(sanitizeItem({ qty: 'NaN' }, { id: 'ck-2', name: 'Relay module', qty: 2 }).qty, 2);
  assert.equal(sanitizeItem({ qty: 999 }, { id: 'ck-2', name: 'Relay module' }).qty, CHECK.maxQty);
  let items = addItem([], buzz).items;
  const gps = sanitizeItem(null, { id: 'ck-2', name: 'GPS module' });
  items = addItem(items, gps).items;
  assert.equal(addItem(items, { ...buzz, id: 'ck-9' }).added, false);   // same part: no duplicate
  assert.equal(findItem(items, 'buzzer')?.id, 'ck-1'); assert.equal(findItem(items, 'the gps')?.id, 'ck-2'); assert.equal(findItem(items, 'relay'), null);
  assert.equal(neededLine(items), 'Still needed: a buzzer and a GPS module.');
  const had = setStatus(items, 'ck-1', 'have');
  assert.equal(items[0].status, 'needed');   // never mutates
  assert.equal(neededLine(had), 'Still needed: a GPS module.');
  assert.match(neededLine(setStatus(had, 'ck-2', 'have')), /^You have everything/);
  assert.deepEqual(removeItem(had, 'ck-2').map(x => x.id), ['ck-1']);
  assert.match(neededLine([]), /empty/);
  assert.equal(addedLine(buzz), "I don't have a 3D model for a buzzer yet, so it's on your parts list with how to wire it.");
  assert.equal(addedLine(gps), "I don't have a 3D model for a GPS module yet, so it's on your parts list.");
  assert.match(checklistPrompt({ request: 'add a buzzer', name: 'Buzzer', board: 'Arduino UNO', pins: 'signal 2, 4' }), /Board: Arduino UNO[\s\S]*Caller said: "add a buzzer"/);
});

await test('analyze validator: modified[] cleaned, capped at 50, optional', () => {
  const kept = [{ id: 'part-0', name: 'Pen barrel' }, { id: 'part-3', name: 'Tip cone' }];
  const a = validatePageMessage(JSON.stringify({ type: 'analyze', scope: 'scan', board: 'Red retractable pen', kept, removed: [],
    modified: [{ id: 'part-3', name: 'Tip cone\u202e', change: { name: 'Brush tip', shape: 'capsule', scale: [1, 1, 99], color: 'red', note: 'brush' } }, { id: 'x', name: 'No change', change: {} }] }));
  assert.deepEqual(a.modified, [{ id: 'part-3', name: 'Tip cone', change: { name: 'Brush tip', shape: 'capsule', scale: [1, 1, 4], note: 'brush' } }]);
  const plainMsg = validatePageMessage(JSON.stringify({ type: 'analyze', scope: 'scan', board: 'Pen', kept, removed: [] }));
  assert.equal('modified' in plainMsg, false);   // unchanged shape for pages that send no edits
  const mod = n => ({ id: `p${n}`, name: `Part ${n}`, change: { color: '#ffffff' } });
  assert.equal(validatePageMessage(JSON.stringify({ type: 'analyze', scope: 'scan', board: 'Pen', kept, removed: [], modified: Array.from({ length: 50 }, (_, i) => mod(i)) })).modified.length, 50);
  for (const bad of [Array.from({ length: 51 }, (_, i) => mod(i)), 'x', [['p']], [{ name: 'a', change: 'gold' }], [{ name: 'a', change: [1] }]])
    assert.equal(validatePageMessage(JSON.stringify({ type: 'analyze', scope: 'scan', board: 'Pen', kept, removed: [], modified: bad })), null, JSON.stringify(bad).slice(0, 40));
});

await test('analysis: the prompt judges the NEW design; modified parts change the cache key', async () => {
  const msg = { scope: 'scan', board: 'Red retractable pen', kept: PEN, removed: [], modified: [{ id: 'part-3', name: 'Tip cone', change: { name: 'Brush tip', shape: 'capsule', material: 'fabric', note: 'Cone tip swapped for a brush' } }] };
  const p = analysisPrompt(msg);
  assert.match(p, /Modified parts[\s\S]*Tip cone: now "Brush tip", capsule shape, fabric/); assert.match(p, /new design/);
  assert.doesNotMatch(analysisPrompt({ ...msg, modified: [] }), /Modified parts/);
  assert.notEqual(comboKey(msg), comboKey({ ...msg, modified: [] }));
  assert.equal(comboKey({ ...msg, modified: [] }), comboKey({ scope: msg.scope, board: msg.board, kept: PEN, removed: [] }));
  let calls = 0;
  const an = createAnalyzer({ brain: {}, call: async () => { calls++; return { data: { title: 'Pen with a brush tip', works: true, summary: 'It works as a brush pen.', pros: [], cons: [], needs: ['Brush-pen ink'], verdict: 'v' } }; } });
  await an.analyze(msg); await an.analyze(msg); await an.analyze({ ...msg, modified: [] });
  assert.equal(calls, 2);
});

await test('project memory: contains the modifications and the parts list', () => {
  const mods = [{ scope: 'scan', target: PEN[3], change: { name: 'Brush tip', shape: 'capsule', note: 'Cone tip swapped for a brush' } }, { scope: 'scan', target: PEN[2], change: { color: '#d4af37', material: 'metal', note: 'Gold clip' } }];
  const list = [sanitizeItem({ part: 'Active buzzer 5V', pins: ['+ -> pin 8'] }, { id: 'ck-1', name: 'Buzzer' }), { ...sanitizeItem(null, { id: 'ck-2', name: 'Relay module' }), status: 'have' }];
  const circuit = createProject({ board: 'arduino-uno' });
  const m = projectMemoryText({ board: 'uno-r3', circuit: describeCircuit(circuit), scan: 'Red retractable pen', mods, checklist: list });
  assert.match(m, /^\[Project memory/);
  assert.match(m, /modified by voice.*Tip cone now "Brush tip"/); assert.match(m, /Pocket clip.*#d4af37/);
  assert.match(m, /parts list.*Buzzer \(needed, Active buzzer 5V\).*Relay module \(have/);
  assert.equal(projectMemoryText({}), '');
  assert.equal(modsMemory([]), ''); assert.equal(checklistMemory([]), '');
});

// ---------- real brain calls (owner testing only) ----------
if (process.argv.includes('--live')) {
  if (process.env.MENTOR_OWNER_TESTING !== '1') { console.error('--live needs MENTOR_BRAIN=claude-code MENTOR_OWNER_TESTING=1'); process.exit(2); }
  const { createBrain } = await import('../brain.mjs');
  const brain = await createBrain({});
  console.log(`live brain: ${brain.provider}`);
  let edit;
  await test('LIVE edit: pen scan + "change the tip to a brush" -> a safe edit of the tip', async () => {
    const p = parseModify('change the tip to a brush'), target = matchPart(p.query, PEN);
    assert.equal(target.id, 'part-3');
    edit = await planModify(brain, { request: 'change the tip to a brush', scope: 'scan', object: PEN_SPEC.name, target: { id: target.id, name: target.name }, spec: PEN_SPEC.parts[3], others: PEN.slice(0, 3).map(x => x.name) });
    console.log('    ', JSON.stringify(edit));
    assert.equal(edit.feasible, true, edit.say); assert.deepEqual(edit.target, { id: 'part-3', name: 'Tip cone' });
    assert.ok(hasChange(edit.change)); assert.ok(edit.say && edit.say.split(' ').length <= EDIT.sayWords);
    assert.match(`${edit.change.name || ''} ${edit.change.note}`, /brush/i);
  });
  await test('LIVE analysis: the modified pen is judged as a new design', async () => {
    const an = createAnalyzer({ brain });
    const r = await an.analyze({ scope: 'scan', board: PEN_SPEC.name, kept: PEN, removed: [], modified: [{ id: 'part-3', name: 'Tip cone', change: edit.change }] });
    console.log('    ', JSON.stringify(r));
    assert.match(r.title, /brush/i); assert.ok(r.summary && r.verdict);
  });
  await test('LIVE checklist: "add a buzzer" -> list item with wiring', async () => {
    const a = parseChecklistAdd('add a buzzer', partFromWords);
    const { item, failed } = await planItem(brain, { request: 'add a buzzer', name: a.name, board: 'Arduino UNO R3', pins: 'signal 2, 4, 7, 8, 12, 13, 3, 5, 6, 9, 10, 11; analog A0-A5; I2C SDA A4, SCL A5; power 5V, 3.3V, GND' }, { id: 'ck-1', name: a.name, qty: a.qty });
    console.log('    ', JSON.stringify(item));
    assert.ok(!failed); assert.equal(item.name, 'Buzzer'); assert.match(item.suggested.part, /buzzer/i);
    assert.ok(item.suggested.pins.length >= 2 && item.suggested.pins.some(p => /gnd/i.test(p)));
    console.log(`     say: ${addedLine(item)}`);
  });
  await brain.close?.();
}
console.log(`\n${pass} passed`);
