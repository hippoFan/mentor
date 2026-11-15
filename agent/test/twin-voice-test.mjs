// Voice part control of the 3D twin (twin-voice.mjs): command parsing and fuzzy part matching. Free, no keys.
//   node test/twin-voice-test.mjs
import assert from 'node:assert/strict';
import { matchPart, parseTwin, partList } from '../twin-voice.mjs';
import { isShowHow } from '../connect.mjs';

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

// What the laptop page sends for an UNO R4 WiFi on the stage (names as twin/board.js builds them).
const R4 = [
  { id: 'pcb', name: 'PCB' }, { id: 'mcu', name: 'RA4M1 microcontroller' }, { id: 'esp', name: 'ESP32-S3 module' },
  { id: 'usb', name: 'USB-C port' }, { id: 'jack', name: 'Barrel jack' }, { id: 'matrix', name: 'LED matrix' },
  { id: 'qwiic', name: 'Qwiic connector' }, { id: 'reset', name: 'Reset button' }, { id: 'icsp', name: 'ICSP header' },
  { id: 'headers', name: 'Pin headers' },
];
const PHONE = [
  { id: 'l0', name: 'Back glass' }, { id: 'l1', name: 'Wireless charging coil' }, { id: 'l2', name: 'Logic board' },
  { id: 'l3', name: 'Rear camera module' }, { id: 'l4', name: 'Battery' }, { id: 'l5', name: 'Display assembly' }, { id: 'l6', name: 'Midframe' },
];

test('parse: remove / restore / combine / select / focus / explode / assemble', () => {
  const cases = [
    ['remove the wifi module', [{ action: 'remove', query: 'wifi module' }]],
    ['take out the wifi module', [{ action: 'remove', query: 'wifi module' }]],
    ['hide the USB port', [{ action: 'remove', query: 'usb port' }]],
    ['take the chip out', [{ action: 'remove', query: 'chip' }]],
    ['can you remove the power jack please', [{ action: 'remove', query: 'power jack' }]],
    ['put the wifi module back', [{ action: 'restore', query: 'wifi module' }]],
    ['bring everything back', [{ action: 'restore' }]],
    ['put it back', [{ action: 'restore', query: '__last' }]],
    ['combine the rest', [{ action: 'combine' }]],
    ['put it together without the wifi module', [{ action: 'remove', query: 'wifi module' }, { action: 'combine' }]],
    ['combine everything except USB and the chip', [{ action: 'remove', query: 'usb' }, { action: 'remove', query: 'chip' }, { action: 'combine' }]],
    ['show me the chip', [{ action: 'select', query: 'chip' }]],
    ['zoom on the USB port', [{ action: 'focus', query: 'usb port' }]],
  ];
  for (const [t, want] of cases) assert.deepEqual(parseTwin(t)?.map(({ action, query }) => (query ? { action, query } : { action })), want, t);
  for (const t of ['blow it up', 'take it apart', 'open it up', 'show me inside', 'explode it']) assert.equal(parseTwin(t)?.[0].action, 'explode', t);
  for (const t of ['put it back together', 'assemble it', 'reassemble']) assert.equal(parseTwin(t)?.[0].action, 'assemble', t);
  assert.equal(parseTwin('Ody, rotate it')?.[0].action, 'rotate');
});

test('parse negatives: not twin commands', () => {
  for (const t of ['turn it on', 'I removed the cap earlier', 'we took out the battery yesterday', "don't remove the chip",
    'show me how to connect it', 'show me again', 'where does it go', 'add a distance sensor',
    'can you tell me what this board does and how I would remove the regulator safely', 'what is the wifi module for',
    'remove', 'show me']) assert.equal(parseTwin(t), null, t);
});

test('fuzzy match: >= 15 spoken targets', () => {
  const cases = [
    ['wifi module', R4, 'esp'], ['the wifi', R4, 'esp'], ['bluetooth', R4, 'esp'], ['esp32', R4, 'esp'], ['antenna', R4, 'esp'],
    ['chip', R4, 'mcu'], ['microcontroller', R4, 'mcu'], ['main processor', R4, 'mcu'], ['mcu', R4, 'mcu'],
    ['usb', R4, 'usb'], ['usb port', R4, 'usb'], ['usb-c', R4, 'usb'], ['power jack', R4, 'jack'], ['power', R4, 'jack'],
    ['barrel jack', R4, 'jack'], ['led matrix', R4, 'matrix'], ['lights', R4, 'matrix'], ['reset button', R4, 'reset'],
    ['qwiic connector', R4, 'qwiic'], ['icsp', R4, 'icsp'],
    ['battery', PHONE, 'l4'], ['screen', PHONE, 'l5'], ['camera', PHONE, 'l3'], ['charging coil', PHONE, 'l1'],
    ['magsafe', PHONE, 'l1'], ['motherboard', PHONE, 'l2'], ['back glass', PHONE, 'l0'],
  ];
  for (const [q, parts, id] of cases) assert.equal(matchPart(q, parts)?.id, id, `${q} -> ${id} (got ${JSON.stringify(matchPart(q, parts))})`);
});

test('fuzzy match negatives: nothing plausible -> null', () => {
  for (const q of ['banana', 'the cap', 'speaker', 'capacitor', 'thing', '']) assert.equal(matchPart(q, R4), null, q);
  assert.equal(matchPart('battery', R4), null);
  assert.equal(matchPart('module', R4)?.id, 'esp');   // the only module on the board
  assert.equal(matchPart('usb', []), null);
  assert.equal(partList(R4, 5), 'PCB, RA4M1 microcontroller, ESP32-S3 module, USB-C port and Barrel jack');
});

test('"show me how to connect it" phrases', () => {
  for (const t of ['show me', 'Show me how to connect it.', 'how do I connect it', 'where does it go', 'where does this wire go',
    'show me how to wire it up', 'okay, how do I hook it up?', 'show me where it goes']) assert.ok(isShowHow(t), t);
  for (const t of ['show me the chip', 'show me again', 'how do I code it', 'where is the USB port', 'what does it do']) assert.ok(!isShowHow(t), t);
});

console.log(`${pass} twin voice tests passed`);
