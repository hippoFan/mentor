// Validates data/parts/*.json (output of tools/import-parts.mjs). Offline, no dependencies.
//   node test/parts-test.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const DIR = new URL('../data/parts/', import.meta.url);
const load = f => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
const files = readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
const parts = new Map(files.map(f => [f.replace(/\.json$/, ''), load(f)]));
const index = load('index.json');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };

const REQUIRED = ['arduino-uno', 'arduino-mega-2560', 'arduino-nano', 'raspberry-pi-4', 'raspberry-pi-pico', 'esp32-devkitc', 'esp32-devkit-v1',
  'nodemcu-esp8266', 'breadboard-half', 'hc-sr04', 'dht22', 'servo-sg90', 'potentiometer', 'led-5mm', 'pushbutton-12mm'];
t('required parts present', () => { for (const id of REQUIRED) assert.ok(parts.has(id), `missing ${id}`); });
t('at least 15 parts', () => assert.ok(parts.size >= 15, `only ${parts.size}`));

for (const [id, p] of parts) {
  t(`${id}: schema`, () => {
    assert.equal(p.id, id);
    for (const k of ['name', 'source', 'license', 'attribution', 'frame']) assert.ok(typeof p[k] === 'string' && p[k].length >= 3, `missing ${k}`);
    assert.ok(Array.isArray(p.aliases) && p.aliases.length >= 1);
    assert.ok(['MIT', 'CC-BY-SA-3.0', 'unspecified'].includes(p.license));
    if (p.license === 'CC-BY-SA-3.0') assert.match(p.attribution, /CC-BY-SA|Fritzing/);
    assert.ok(p.outline_mm.w > 0 && p.outline_mm.h > 0);
  });
  t(`${id}: >= 2 pins, finite, unique names, valid kind`, () => {
    assert.ok(p.pins.length >= 2);
    const names = new Set();
    for (const q of p.pins) {
      assert.ok(Number.isFinite(q.x_mm) && Number.isFinite(q.y_mm), `${q.name} not finite`);
      assert.ok(['header', 'pad', 'pin'].includes(q.kind), `${q.name} kind ${q.kind}`);
      assert.ok(!names.has(q.name), `duplicate pin name ${q.name}`);
      names.add(q.name);
    }
  });
  t(`${id}: pins inside outline`, () => {
    const { w, h } = p.outline_mm;
    for (const q of p.pins) assert.ok(q.x_mm >= -0.01 && q.x_mm <= w + 0.01 && q.y_mm >= -0.01 && q.y_mm <= h + 0.01, `${q.name} (${q.x_mm}, ${q.y_mm}) outside ${w}x${h}`);
  });
  t(`${id}: headers reference real pins, header pitch is 2.54 mm +-0.2`, () => {
    const by = new Map(p.pins.map(q => [q.name, q]));
    for (const h of p.headers) {
      assert.ok(h.pins.length >= 2);
      const seq = h.name === 'J8' ? h.pins : h.pins; // J8 is in physical order, which alternates rows
      for (const n of seq) assert.ok(by.has(n), `${h.name}: unknown pin ${n}`);
      if (h.name === 'J8') continue; // checked by the Pi test
      for (let i = 1; i < h.pins.length; i++) {
        const a = by.get(h.pins[i - 1]), b = by.get(h.pins[i]);
        const d = Math.hypot(a.x_mm - b.x_mm, a.y_mm - b.y_mm);
        assert.ok(Math.abs(d - 2.54) <= 0.2, `${h.name}: ${a.name}->${b.name} is ${d.toFixed(3)} mm`);
      }
    }
  });
}

t('Raspberry Pi: 85 x 56 mm outline, 2x20 layout, pin 1 = 3V3, 2 = 5V, 6 = GND, GPIO17 = pin 11', () => {
  const p = parts.get('raspberry-pi-4');
  assert.deepEqual(p.outline_mm, { w: 85, h: 56 });
  assert.equal(p.pins.length, 40);
  const n = k => p.pins.find(q => q.number === k);
  assert.match(n(1).name, /^3V3/); assert.match(n(2).name, /^5V/); assert.match(n(6).name, /^GND/); assert.equal(n(11).name, 'GPIO17');
  for (const k of [9, 14, 20, 25, 30, 34, 39]) assert.match(n(k).name, /^GND/, `pin ${k}`);
  assert.equal(n(3).name, 'GPIO2'); assert.equal(n(5).name, 'GPIO3'); assert.equal(n(40).name, 'GPIO21'); assert.equal(n(38).name, 'GPIO20');
  const rows = new Set(p.pins.map(q => q.y_mm));
  assert.equal(rows.size, 2, 'exactly two rows');
  for (let k = 1; k <= 40; k++) { // odd = inner row (larger y), even = outer row; columns advance 2.54 mm per pair
    const q = n(k), col = Math.floor((k - 1) / 2);
    assert.ok(Math.abs(q.x_mm - (n(1).x_mm + col * 2.54)) < 0.01, `pin ${k} x`);
    assert.ok(k % 2 === 1 ? q.y_mm > n(2).y_mm : q.y_mm === n(2).y_mm, `pin ${k} row`);
  }
  assert.ok(Math.abs(n(2).y_mm - n(1).y_mm) - 2.54 < 0.01);
  const j8 = p.headers.find(h => h.name === 'J8'); assert.equal(j8.pins.length, 40);
});

t('Arduino UNO agrees with data/uno-pins.json within 0.5 mm', () => {
  const uno = JSON.parse(readFileSync(new URL('../uno-pins.json', DIR), 'utf8'));
  const p = parts.get('arduino-uno'), by = new Map(p.pins.map(q => [q.name, q]));
  assert.ok(Math.abs(p.outline_mm.w - uno.pcb.w) < 0.01 && Math.abs(p.outline_mm.h - uno.pcb.h) < 0.01);
  let n = 0;
  for (const [name, u] of Object.entries(uno.pins)) {
    const q = by.get(name);
    assert.ok(q, `pin ${name} missing from imported UNO`);
    // part frame: y down from the top edge; uno-pins.json: v = pcb.h - y
    const du = Math.abs(q.x_mm - u.u), dv = Math.abs((uno.pcb.h - q.y_mm) - u.v);
    assert.ok(du <= 0.5 && dv <= 0.5, `${name}: imported (${q.x_mm}, ${uno.pcb.h - q.y_mm}) vs uno-pins (${u.u}, ${u.v})`);
    n++;
  }
  assert.equal(n, Object.keys(uno.pins).length);
});

t('known pin counts and landmarks', () => {
  const c = id => parts.get(id).pins.length;
  assert.ok(c('arduino-mega-2560') >= 80); assert.equal(c('raspberry-pi-pico'), 40);
  const pico = parts.get('raspberry-pi-pico').pins, by = n => pico.find(q => q.name === n);
  assert.ok(Math.abs(by('GP0').y_mm - 3.4) < 0.01 && Math.abs(by('GP1').y_mm - by('GP0').y_mm - 2.54) < 0.01);
  assert.equal(c('breadboard-half'), 400); assert.equal(c('hc-sr04'), 4);
  assert.deepEqual(parts.get('hc-sr04').pins.map(q => q.name), ['VCC', 'TRIG', 'ECHO', 'GND']);
  assert.deepEqual(parts.get('servo-sg90').pins.map(q => q.name), ['GND', 'V+', 'PWM']);
  assert.deepEqual(parts.get('dht22').pins.map(q => q.name), ['VCC', 'SDA', 'NC', 'GND']);
  const mega = new Set(parts.get('arduino-mega-2560').pins.map(q => q.name));
  for (const n of ['A15', '53', '5V', 'SCL', 'SDA']) assert.ok([...mega].some(m => m === n || m.startsWith(n)), `mega ${n}`);
});

t('breadboard: 0.1" grid (columns and rows)', () => {
  const by = new Map(parts.get('breadboard-half').pins.map(q => [q.name, q]));
  const d = (a, b) => Math.hypot(by.get(a).x_mm - by.get(b).x_mm, by.get(a).y_mm - by.get(b).y_mm);
  assert.ok(Math.abs(d('1A', '2A') - 2.54) < 0.2); assert.ok(Math.abs(d('1A', '1B') - 2.54) < 0.2); assert.ok(Math.abs(d('1D', '1E') - 2.54) < 0.2);
  assert.ok(Math.abs(d('1E', '1F') - 2.54 * 3) < 0.4, `centre gap ${d('1E', '1F')}`);
});

t('index.json: every part indexed, aliases resolve, model-style names match', () => {
  assert.equal(Object.keys(index.parts).length, parts.size);
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const [id, e] of Object.entries(index.parts)) {
    assert.ok(parts.has(id)); assert.equal(e.file, `${id}.json`);
    for (const a of [id, e.name, ...e.aliases]) assert.equal(index.lookup[norm(a)], id, `alias "${a}"`);
  }
  const want = { 'ESP32 DevKit V1': 'esp32-devkit-v1', 'NodeMCU': 'nodemcu-esp8266', 'Pi 4': 'raspberry-pi-4', 'Raspberry Pi 5': 'raspberry-pi-4',
    'Arduino Mega': 'arduino-mega-2560', 'Pico': 'raspberry-pi-pico', 'DHT11': 'dht22', 'HC-SR04': 'hc-sr04', 'SG90': 'servo-sg90', 'Arduino UNO R3': 'arduino-uno',
    'Half breadboard': 'breadboard-half', 'Nano': 'arduino-nano', 'LED': 'led-5mm' };
  for (const [q, id] of Object.entries(want)) assert.equal(index.lookup[norm(q)], id, q);
});

t('Fritzing-derived files carry CC-BY-SA attribution; LICENSES.md exists', () => {
  const lic = readFileSync(new URL('LICENSES.md', DIR), 'utf8');
  assert.match(lic, /CC-BY-SA/); assert.match(lic, /wokwi/i);
  for (const p of parts.values()) if (p.source.includes('fritzing')) { assert.equal(p.license, 'CC-BY-SA-3.0'); assert.match(p.attribution, /Fritzing/); }
});

console.log(`${pass} passed, ${fail} failed (${parts.size} parts)`);
process.exit(fail ? 1 : 0);
