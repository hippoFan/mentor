// Voice circuit builder (circuit.mjs): intent detection, template wiring per part, auto pin assignment across five
// parts, rejected actions (shorts, double-driven pins, pins that don't exist), the sketch and Wokwi diagram, the
// step-by-step guide. No brain by default; with the owner's own subscription it also makes <= 4 real planner calls:
//   node test/circuit-test.mjs
//   MENTOR_BRAIN=claude-code MENTOR_OWNER_TESTING=1 node test/circuit-test.mjs      (owner testing only, see SECURITY.md)
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as C from '../circuit.mjs';

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { const d = await fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};
const say = (st, u) => { const p = C.fastPlan(st, u); assert.ok(p, `no template for "${u}"`); return C.apply(st, p.actions); };
const build = (...us) => us.reduce((st, u) => { const r = say(st, u); assert.ok(r.changed, `"${u}" changed nothing: ${r.say}`); return r.state; }, C.createProject({ board: 'uno-r3' }));
const wires = (st, id) => Object.fromEntries(st.connections.filter(w => w.to.startsWith(`${id}.`)).map(w => [w.to.slice(id.length + 1), w.from.split('.').slice(1).join('.')]));

// ---------- intent ----------
const YES = ['add a distance sensor', 'hook up an LED to pin 9 with a resistor', 'connect the servo', 'move the trigger to pin 7', 'remove the LED',
  'what goes where', 'can you add a temperature sensor', 'plug the servo into pin 5', 'wire up the button', 'attach the potentiometer',
  'swap the LED for a servo', 'add something to measure temperature', 'hook up a light that fades', 'take the LED out',
  'what do I plug in next', 'Ody, add an LED on pin 6 please', 'put a button on pin 2', 'connect trig to pin 7', 'get rid of the servo'];
const NO = ['how do I add a library', 'what is this board?', 'where is the USB port?', 'should I plug in the USB cable?', 'remove the cover',
  'can I connect it to my laptop?', 'is the LED working?', 'add a delay to the code', 'move the camera closer', 'the wire is loose',
  'I added the sensor', 'plug it into my laptop', 'connect to wifi', "don't connect 5V to ground", 'scan this', "what's the distance reading?",
  'why is the light not on', 'where does this wire go?', 'thanks, that works', 'explode it', 'should I connect the LED to pin 13?', 'how do I wire a servo?'];
await test(`intent: ${YES.length} circuit commands recognised`, () => {
  const miss = YES.filter(u => !C.circuitIntent(u));
  assert.deepEqual(miss, []);
  assert.equal(C.circuitIntent('what goes where'), 'next');
  assert.equal(C.circuitIntent('what do I plug in next'), 'next');
});
await test(`intent: ${NO.length} normal questions left to the brain`, () => assert.deepEqual(NO.filter(u => C.circuitIntent(u)), []));

// ---------- templates, one part at a time ----------
await test('hc-sr04 template: VCC 5V, GND, TRIG 9, ECHO 10', () => {
  const st = build('add a distance sensor');
  assert.deepEqual(wires(st, 'sonar1'), { VCC: '5V', TRIG: '9', ECHO: '10', GND: 'GND.2' });
  assert.equal(C.fastPlan(C.createProject(), 'add a distance sensor').actions[0].part, 'hc-sr04');
});
await test('hc-sr04: named pins and "unless taken"', () => {
  assert.deepEqual(wires(build('add a distance sensor with trigger on 7 and echo on 8'), 'sonar1'), { VCC: '5V', TRIG: '7', ECHO: '8', GND: 'GND.2' });
  const st = build('add an LED on pin 9', 'add a distance sensor');
  assert.notEqual(wires(st, 'sonar1').TRIG, '9');
  return `TRIG ${wires(st, 'sonar1').TRIG} when 9 is the LED's`;
});
await test('led template: pin 6 through a 220 ohm resistor to GND, PWM pin for "fade"', () => {
  const st = build('add an LED on pin 6');
  const w = st.connections.find(x => x.to === 'led1.A');
  assert.equal(w.from, 'uno.6'); assert.equal(w.via, 'resistor 220Ω'); assert.equal(wires(st, 'led1').C, 'GND.2');
  const f = build('hook up a light that fades');
  assert.equal(f.components[0].mode, 'fade');
  assert.ok(['3', '5', '6', '9', '10', '11'].includes(wires(f, 'led1').A));
  return `fade on pin ${wires(f, 'led1').A}`;
});
await test('servo template: GND, V+ 5V, PWM on a PWM pin', () => {
  const st = build('add a servo');
  assert.deepEqual(wires(st, 'servo1'), { GND: 'GND.2', 'V+': '5V', PWM: '9' });
});
await test('dht22 template: VCC, data on a digital pin, NC left empty, GND', () => {
  const st = build('add a temperature sensor');
  const w = wires(st, 'dht1');
  assert.equal(w.VCC, '5V'); assert.equal(w.GND, 'GND.2'); assert.equal(w.NC, undefined); assert.match(w.SDA, /^\d+$/);
  assert.ok(st.notes.some(n => /10 kΩ/.test(n)));
});
await test('potentiometer template: analog A0', () => assert.deepEqual(wires(build('add a knob'), 'pot1'), { GND: 'GND.2', SIG: 'A0', VCC: '5V' }));
await test('button template: one side to a digital pin, the other to GND (INPUT_PULLUP)', () => {
  const w = wires(build('add a button'), 'btn1');
  assert.equal(w['2.r'], 'GND.2'); assert.match(w['1.l'], /^\d+$/);
  assert.match(C.generateSketch(build('add a button')), /INPUT_PULLUP/);
});
await test('mpu6050 template: I2C SDA A4, SCL A5', () => assert.deepEqual(wires(build('add a gyroscope'), 'imu1'), { SDA: 'A4', SCL: 'A5', GND: 'GND.2', VCC: '5V' }));

// ---------- five parts, no conflicts ----------
const five = build('add a distance sensor', 'add an LED', 'add a servo', 'add a potentiometer', 'add a button');
await test('auto pins across 5 parts: every signal pin used once, every pin real', () => {
  const t = C.boardPins('arduino-uno');
  const sig = five.connections.map(w => w.from.split('.').slice(1).join('.')).filter(k => !['5V', 'GND.2'].includes(k));
  assert.equal(new Set(sig).size, sig.length, `reused: ${sig}`);
  for (const w of five.connections) assert.ok(t.pins[w.from.slice(4)], `bad pin ${w.from}`);
  assert.ok(!sig.includes('0') && !sig.includes('1'), 'used the serial pins');
  return five.components.map(c => `${c.id}:${Object.entries(wires(five, c.id)).filter(([, v]) => !/5V|GND/.test(v)).map(([k, v]) => `${k}=${v}`).join('/')}`).join(' ');
});
await test('layout: parts never overlap, every jumper hole and rail hole used once', () => {
  const L = C.layout(five);
  for (const zone of ['front', 'back']) {
    const cols = L.components.filter(c => c.zone === zone).flatMap(c => Array.from({ length: c.cols }, (_, i) => c.col + i));
    assert.equal(new Set(cols).size, cols.length, `${zone} overlap`);
    assert.ok(cols.every(c => c >= 1 && c <= 30));
  }
  const holes = L.jumpers.flatMap(j => [j.from, j.to]).filter(e => e.hole || e.rail).map(e => e.hole || `${e.rail}${e.i}`);
  assert.equal(new Set(holes).size, holes.length, `shared: ${holes}`);
  const pinHoles = L.components.flatMap(c => Object.values(c.pins)).filter(h => h !== 'lead');
  assert.ok(!pinHoles.some(h => holes.includes(h)), 'a jumper in a part pin hole');
  return `${L.jumpers.length} jumpers, ${L.components.length} parts`;
});
await test('servo library: an LED added after a servo never fades on 9/10', () => {
  const st = build('add a servo', 'add an LED that fades');
  assert.ok(!['9', '10'].includes(wires(st, 'led1').A));
});

// ---------- rejected actions ----------
const sonar = build('add a distance sensor', 'add an LED on pin 6');
const rej = (st, actions) => { const r = C.apply(st, actions); assert.equal(r.changed, false, `applied: ${r.say}`); assert.ok(r.rejected.length, 'not rejected'); return r.rejected[0].reason; };
await test('rejects a power-to-ground short', () => {
  const a = rej(sonar, [{ op: 'connect', from: 'uno.GND', to: 'sonar1.VCC' }]);
  const b = rej(sonar, [{ op: 'connect', from: 'uno.5V', to: 'sonar1.GND' }]);
  assert.match(a, /short/i); assert.match(b, /short/i);
  return a;
});
await test('rejects a double-driven pin', () => {
  const r = rej(sonar, [{ op: 'connect', from: 'uno.9', to: 'led1.A' }]);
  assert.match(r, /already used by the distance sensor/);
  assert.match(rej(sonar, C.fastPlan(sonar, 'add a servo on pin 6').actions), /already used/);
  return r;
});
await test('rejects pins that do not exist', () => {
  assert.match(rej(sonar, [{ op: 'add', part: 'led-5mm', pins: '22' }]), /no pin 22/);
  assert.match(rej(sonar, [{ op: 'connect', from: 'uno.7', to: 'sonar1.FOO' }]), /no pin called FOO/);
  assert.match(rej(sonar, [{ op: 'add', part: 'hc-sr04', pins: 'BEEP=4' }]), /no BEEP pin/);
});
await test('rejects other wrong wiring with a spoken reason', () => {
  const r = [
    rej(sonar, [{ op: 'connect', from: 'uno.5V', to: 'sonar1.TRIG' }]),   // power on a signal pin
    rej(sonar, [{ op: 'add', part: 'led-5mm', pins: '0' }]),               // serial pins
    rej(sonar, [{ op: 'add', part: 'led-5mm', mode: 'fade', pins: '7' }]), // no PWM
    rej(sonar, [{ op: 'add', part: 'potentiometer', pins: '7' }]),         // not analog
    rej(sonar, [{ op: 'connect', from: 'uno.3.3V', to: 'sonar1.VCC' }]),   // needs 5 V
    rej(sonar, [{ op: 'connect', from: 'uno.VIN', to: 'sonar1.VCC' }]),
    rej(sonar, [{ op: 'add', part: 'buzzer' }]),
    rej(sonar, [{ op: 'remove', id: 'servo' }]),
  ];
  assert.ok(r.every(x => x.length > 10 && x.length < 200 && /^[A-Z]/.test(x)), r.join(' | '));
  return r.slice(0, 3).join(' | ');
});
await test('rejected actions leave the project unchanged', () => {
  const r = C.apply(sonar, [{ op: 'connect', from: 'uno.GND', to: 'sonar1.VCC' }, { op: 'add', part: 'servo-sg90' }]);
  assert.equal(r.rejected.length, 1); assert.equal(r.applied.length, 1);
  assert.equal(sonar.components.length, 2, 'input state mutated');
});

// ---------- move / remove / board change ----------
await test('move the trigger, remove the LED, swap to a Nano', () => {
  let st = say(sonar, 'move the trigger to pin 7').state;
  assert.equal(wires(st, 'sonar1').TRIG, '7');
  st = say(st, 'remove the LED').state;
  assert.equal(st.components.length, 1); assert.ok(!st.connections.some(w => w.to.startsWith('led1.')));
  assert.equal(say(st, 'move pin 7 to pin 4').state.connections.find(w => w.to === 'sonar1.TRIG').from, 'uno.4');
  const nano = C.setBoard(build('add a distance sensor', 'add a knob'), 'arduino-nano');
  assert.equal(nano.board, 'arduino-nano'); assert.deepEqual(wires(nano, 'sonar1'), { VCC: '5V', TRIG: '9', ECHO: '10', GND: nano.connections[3].from.slice(5) });
});

// ---------- code + simulator ----------
const strip = s => s.replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
const balanced = s => { let d = 0; for (const ch of strip(s)) { if ('{(['.includes(ch)) d++; if ('})]'.includes(ch)) d--; if (d < 0) return false; } return d === 0; };
const all7 = build('add a distance sensor', 'add an LED that fades', 'add a servo', 'add a knob', 'add a button', 'add a motion sensor', 'add a temperature sensor');
await test('sketch: compiles-looking structure for every part', () => {
  const code = C.generateSketch(all7);
  assert.ok(balanced(code), 'unbalanced brackets');
  assert.equal((code.match(/void setup\(\) \{/g) || []).length, 1); assert.equal((code.match(/void loop\(\) \{/g) || []).length, 1);
  for (const inc of ['<Servo.h>', '<DHT.h>', '<Wire.h>']) assert.ok(code.includes(`#include ${inc}`), inc);
  assert.match(code, /Serial\.begin\(9600\)/); assert.match(code, /pulseIn\(SONAR1_ECHO, HIGH/); assert.match(code, /analogWrite\(LED1_PIN/);
  assert.match(code, /servo1\.attach\(SERVO1_PIN\)/); assert.match(code, /analogRead\(POT1_PIN\)/); assert.match(code, /Wire\.write\(0x3B\)/); assert.match(code, /dht1\.readTemperature/);
  for (const w of all7.connections) {   // every signal pin constant matches the wiring
    const k = w.from.slice(4); if (/5V|GND/.test(k) || /^imu\d+\.(SDA|SCL)$/.test(w.to)) continue;   // I2C goes through Wire
    assert.ok(new RegExp(`= ${k};`).test(code), `no constant for ${k} (${w.to})`);
  }
  for (const line of strip(code).split('\n').map(l => l.trim()).filter(Boolean)) {
    if (/^(#include|void |if |\}|\{|else|} else)/.test(line) || line.endsWith('{') || line.endsWith('}')) continue;
    assert.ok(line.endsWith(';'), `no semicolon: ${line}`);
  }
  const vars = [...code.matchAll(/^(?:const int|int|bool|unsigned long|Servo|DHT|const uint8_t) (\w+)/gm)].map(m => m[1]);
  assert.equal(new Set(vars).size, vars.length, 'duplicate globals');
  return `${code.split('\n').length} lines, ${vars.length} globals`;
});
await test('wokwi diagram: valid parts, wires and pin names', () => {
  const d = C.wokwiDiagram(all7);
  assert.equal(d.version, 1); assert.equal(d.parts[0].type, 'wokwi-arduino-uno');
  const ids = new Set(d.parts.map(p => p.id));
  assert.equal(ids.size, d.parts.length);
  const unoPins = new Set(JSON.parse(readFileSync(new URL('../data/parts/arduino-uno.json', import.meta.url))).pins.map(p => ({ SDA: 'A4.2', SCL: 'A5.2' })[p.name] || p.name));
  const partPins = { 'wokwi-hc-sr04': 'hc-sr04', 'wokwi-led': 'led-5mm', 'wokwi-servo': 'servo-sg90', 'wokwi-potentiometer': 'potentiometer', 'wokwi-pushbutton': 'pushbutton-12mm',
    'wokwi-mpu6050': 'mpu6050', 'wokwi-dht22': 'dht22' };
  const pinsOf = id => { const p = d.parts.find(x => x.id === id); if (p.type === 'wokwi-arduino-uno') return unoPins; if (p.type === 'wokwi-resistor') return new Set(['1', '2']);
    return new Set(JSON.parse(readFileSync(new URL(`../data/parts/${partPins[p.type]}.json`, import.meta.url))).pins.map(x => x.name)); };
  for (const [a, b, color, route] of d.connections) {
    for (const end of [a, b]) { const [id, pin] = [end.slice(0, end.indexOf(':')), end.slice(end.indexOf(':') + 1)]; assert.ok(ids.has(id), end); assert.ok(pinsOf(id).has(pin), `bad pin ${end}`); }
    assert.ok(color && Array.isArray(route));
  }
  assert.ok(d.parts.some(p => p.type === 'wokwi-resistor' && p.attrs.value === '220'));
  const proj = C.wokwiProject(all7);
  assert.match(proj.libraries, /DHT sensor library/);
  JSON.parse(JSON.stringify(d));
  return `${d.parts.length} parts, ${d.connections.length} wires`;
});

// ---------- the guide ----------
await test('nextStep: rails first, then each part, with AR endpoints', () => {
  let st = build('add a distance sensor');
  const n = C.nextStep(st);
  assert.equal(n.id, 'wire:rail:+'); assert.equal(n.boardPin, '5V'); assert.equal(n.mark.pin, '5V'); assert.equal(n.mark.kind, 'wire');
  st = C.markDone(C.markDone(st), undefined);
  assert.equal(C.nextStep(st).kind, 'place');
  st = C.markDone(st);
  const sig = C.steps(st).find(s => s.componentPin === 'TRIG');
  assert.equal(sig.boardPin, '9'); assert.equal(sig.component, 'sonar1'); assert.match(sig.to.breadboard, /^breadboard D\d+$/);
  while (C.nextStep(st)) st = C.markDone(st);
  assert.equal(C.nextStep(st), null);
  const moved = say(st, 'move the trigger to pin 7').state;
  assert.equal(C.nextStep(moved).boardPin, '7', 'a moved wire becomes the next step');
  return sig.say;
});
await test('circuitEvent: small, complete, JSON-safe', () => {
  const ev = C.circuitEvent(five, { say: 'x' });
  const n = JSON.stringify(ev).length;
  assert.equal(ev.type, 'circuit'); assert.ok(ev.layout.jumpers.length > 10 && ev.legend.length >= 5 && ev.sketch.includes('void loop'));
  assert.ok(n < 20000, `${n} bytes`);
  return `${n} bytes`;
});
await test('sanitizePlan: garbage from the brain is capped and filtered', () => {
  const p = C.sanitizePlan({ actions: [{ op: 'rm -rf' }, { op: 'add', part: 'led-5mm', label: '<script>http://x.y/' + 'a'.repeat(99) }, null, 7], say: 'hi\u0000 http://evil.example now' });
  assert.equal(p.actions.length, 1); assert.ok(!/[<>]|http/.test(p.actions[0].label)); assert.ok(p.actions[0].label.length <= 40); assert.ok(!/http|\u0000/.test(p.say));
});
await test('handleUtterance without a brain: templates work, free-form asks to rephrase', async () => {
  const r = await C.handleUtterance(null, C.createProject(), 'add a distance sensor');
  assert.equal(r.plan.source, 'template'); assert.ok(r.changed);
  const f = await C.handleUtterance(null, C.createProject(), 'add something to measure temperature');
  assert.equal(f.changed, false); assert.match(f.say, /add/);
  const w = await C.handleUtterance(null, r.state, 'what goes where');
  assert.match(w.say, /jumper/);
});

// ---------- real planner calls (owner testing only, <= 4) ----------
const BRAIN = process.env.MENTOR_BRAIN || process.env.ODY_BRAIN;
if (BRAIN && (BRAIN !== 'claude-code' || process.env.MENTOR_OWNER_TESTING === '1')) {
  const { createBrain } = await import('../brain.mjs');
  const brain = await createBrain({ provider: BRAIN });
  const cases = [
    ['hook up a light that fades', C.createProject(), r => r.state.components[0]?.part === 'led-5mm' && r.state.components[0].mode === 'fade'],
    ['add something to measure temperature', C.createProject(), r => r.state.components[0]?.part === 'dht22'],
    ['I want the sensor that sees how far away my hand is, on pins 4 and 5', C.createProject(), r => r.state.components[0]?.part === 'hc-sr04' && /^[45]$/.test(wires(r.state, 'sonar1').TRIG || '')],
    ['add a buzzer that beeps', build('add an LED'), r => !r.changed && /buzzer|library|can add/i.test(r.say)],
  ];
  for (const [u, st, check] of cases) {
    await test(`brain (${BRAIN}): "${u}"`, async () => {
      const plan = await C.planChange(brain, st, u, null, { brainOnly: true });
      const r = C.apply(st, plan.actions);
      const sayText = r.say || plan.say;
      assert.equal(plan.source, 'brain', sayText);
      assert.ok(check({ ...r, say: sayText }), `${JSON.stringify(plan.actions)} -> ${sayText}`);
      return `${plan.ms} ms: ${JSON.stringify(plan.actions)} -> "${sayText}"`;
    });
  }
  await brain.close?.();
} else console.log('skip  real planner calls (set MENTOR_BRAIN; claude-code also needs MENTOR_OWNER_TESTING=1)');

// ---------- UNO Q: 3.3 V logic ----------
await test('UNO Q: same UNO pins, 3.3 V notes spoken, 5 V echo kept off D3 / A0 / A1', () => {
  let st = C.createProject({ board: 'uno-q' });
  assert.equal(st.board, 'arduino-uno'); assert.equal(st.variant, 'uno-q');
  let r = say(st, 'add a distance sensor'); assert.ok(r.changed, r.say); st = r.state;
  assert.match(r.say, /3\.3 volt logic/); assert.notEqual(wires(st, 'sonar1').ECHO, '3');
  r = C.apply(st, [{ op: 'move', connection: 'sonar1.ECHO', to: 'uno.3' }]);
  assert.ok(!r.changed); assert.match(r.rejected[0]?.why || r.say, /3\.3 volts/);
  r = say(st, 'add an LED on pin 6'); assert.ok(r.changed, r.say); assert.match(r.say, /220 ohm resistor still works/);
  const r3 = say(C.createProject({ board: 'uno-r3' }), 'add a distance sensor');
  assert.doesNotMatch(r3.say, /3\.3 volt/, 'R3 must not get the UNO Q note');
  assert.equal(C.setBoard(st, 'uno-r3').variant, 'uno-r3');
  return r.say;
});

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
