// Schematics (blueprint.mjs): the netlist, the tscircuit tree, the cache key, and real drawings + KiCad files when
// agent/blueprint is installed. The on-demand route (POST /argos/designs/<id>/schematic) is in schematic-route-test.mjs.
// Free, no keys, no network.   node test/blueprint-test.mjs
import { strict as assert } from 'node:assert';
import * as C from '../circuit.mjs';
import { blueprint, circuitKey, circuitTree, netlist } from '../blueprint.mjs';

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { const d = await fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const build = (board, actions) => C.apply(C.createProject({ board }), actions).state;
const UNO = build('arduino-uno', [{ op: 'add', part: 'led-5mm', color: 'red' }, { op: 'add', part: 'dht22' }]);
const ESP = build('esp32-devkit-v1', [{ op: 'add', part: 'dht22' }, { op: 'add', part: 'led-5mm', color: 'red' }, { op: 'add', part: 'led-5mm', color: 'blue' }]);

await test('netlist: LED goes board pin -> resistor -> LED, grounds share one net', () => {
  const nets = netlist(UNO);
  const led = UNO.components.find(c => c.part === 'led-5mm');
  const sig = nets.find(n => n.nodes.some(x => x.ref === `R_${led.id}` && x.pin === '1'));
  assert.ok(sig, 'a net feeds the resistor');
  assert.deepEqual(sig.nodes.map(n => n.ref), ['BOARD', `R_${led.id}`]);
  assert.ok(nets.find(n => n.name === `${led.id}_A`).nodes.some(n => n.ref === led.id));
  const gnd = nets.find(n => n.name === 'GND');
  assert.ok(gnd.nodes.some(n => n.ref === led.id) && gnd.nodes.some(n => n.ref === 'dht1'));
  assert.equal(nets.filter(n => n.name === 'GND').length, 1);
});

await test('tree: one header for the board, a resistor + LED per LED, a header per module, every wire a trace', () => {
  const els = [];
  const h = (type, props, ...kids) => { els.push({ type, props }); return { type, props, kids }; };
  const tree = circuitTree(UNO, h);
  assert.equal(tree.type, 'board');
  const types = els.map(e => e.type);
  assert.equal(types.filter(t => t === 'resistor').length, 1);
  assert.equal(types.filter(t => t === 'led').length, 1);
  assert.equal(types.filter(t => t === 'chip').length, 2);   // J1 + DHT22 header
  assert.ok(types.filter(t => t === 'trace').length >= UNO.connections.length);
  assert.equal(circuitTree(C.createProject({ board: 'arduino-uno' }), h), null);
});

await test('circuitKey: changes with the wiring, not with notes or progress', () => {
  const k = circuitKey(UNO);
  assert.equal(k, circuitKey({ ...UNO, done: ['x'], notes: ['y'], rev: 99 }));
  assert.notEqual(k, circuitKey(ESP));
  assert.notEqual(k, circuitKey(build('arduino-uno', [{ op: 'add', part: 'led-5mm', color: 'blue' }, { op: 'add', part: 'dht22' }])));
});

await test('drawings: schematic, routed PCB and KiCad files (needs agent/blueprint installed)', async () => {
  const bp = await blueprint(ESP);
  if (!bp) return 'skipped: run cd agent/blueprint && npm install';
  assert.match(bp.schematicSvg, /^<svg/); assert.match(bp.pcbSvg, /^<svg/);
  assert.ok(bp.traces >= 5, `only ${bp.traces} traces`);
  assert.match(bp.kicad.sch, /^\(kicad_sch/); assert.match(bp.kicad.pcb, /^\(kicad_pcb/); assert.ok(bp.kicad.pro);
  return `${bp.traces} traces routed in ${bp.ms} ms`;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
