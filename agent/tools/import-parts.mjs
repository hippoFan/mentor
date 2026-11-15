#!/usr/bin/env node
// Imports open-source electronics part libraries into Mentor's pin-map format.
//
//   node tools/import-parts.mjs [--src DIR] [--out DIR] [--offline] [--only id,id]
//
// Sources (pinned commits, fetched from raw.githubusercontent.com, parsed as DATA ONLY:
// nothing downloaded is ever executed or imported):
//   wokwi/wokwi-elements  (MIT)          src/*-element.ts  pinInfo arrays
//   wokwi/wokwi-boards    (MIT)          boards/*/board.json
//   fritzing/fritzing-parts (CC-BY-SA 3.0) core/*.fzp + svg/core/breadboard/*.svg
//
// Output (data/parts/): one <id>.json per part, index.json, LICENSES.md is hand-written.
//
// Frame of every part (see "frame" in each file): origin = top-left corner of the part outline as drawn
// in the top view, x_mm to the right, y_mm DOWN, z up from the top face. For the Arduino boards the
// outline is the PCB (not the Wokwi image box). uno-pins.json uses v = h - y_mm (see test/parts-test.mjs).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------- sources
const SRC = {
  elements: { repo: 'wokwi/wokwi-elements', sha: '5178c0cc1b455719fdf562169293797e29d73dac', license: 'MIT',
    attribution: 'Pin geometry from wokwi/wokwi-elements (MIT License, Copyright (c) 2019 Uri Shaked and contributors).' },
  boards: { repo: 'wokwi/wokwi-boards', sha: '962b19d5636756537a93bb5337ac99abd775eae0', license: 'unspecified',
    attribution: 'Pin geometry (physical board layout, a published fact of the Raspberry Pi Pico / Espressif ESP32-DevKitC design) read from wokwi/wokwi-boards, whose repository carries no LICENSE file. Only coordinates and pin names are used; no artwork or code is copied.' },
  fritzing: { repo: 'fritzing/fritzing-parts', sha: '27535f2fd02097be9bed229b75aa8e9be282a4a0', license: 'CC-BY-SA-3.0',
    attribution: 'Connector names/positions derived from Fritzing parts (https://github.com/fritzing/fritzing-parts), licensed CC-BY-SA 3.0. Share-alike applies to this file.' },
};
const ALLOWED_HOST = 'https://raw.githubusercontent.com/';
const PX_PER_MM = 96 / 25.4; // CSS px used by wokwi pinInfo

// ---------------------------------------------------------------- part catalogue
const WOKWI_RENAME_UNO = { 'A5.2': 'SCL', 'A4.2': 'SDA' }; // uno-pins.json naming
const PARTS = [
  { id: 'arduino-uno', name: 'Arduino UNO R3', kind: 'header', src: 'elements', file: 'arduino-uno', type: 'wokwi-el', snap: true,
    outline: { w: 68.58, h: 53.34 }, shiftFromViewBox: true, rename: WOKWI_RENAME_UNO,
    aliases: ['Arduino UNO', 'UNO', 'UNO R3', 'Arduino UNO R4', 'UNO R4 WiFi', 'Arduino UNO Q', 'UNO Q', 'Arduino', 'ATmega328P UNO'],
    note: 'Same header layout as UNO R4 (WiFi/Minima).' },
  { id: 'arduino-mega-2560', name: 'Arduino Mega 2560', kind: 'header', src: 'elements', file: 'arduino-mega', type: 'wokwi-el', snap: true,
    outline: { w: 101.6, h: 53.34 }, shiftFromViewBox: true,
    aliases: ['Arduino Mega', 'Mega 2560', 'Mega2560', 'Mega', 'ATmega2560'] },
  { id: 'arduino-nano', name: 'Arduino Nano', kind: 'header', src: 'elements', file: 'arduino-nano', type: 'wokwi-el', snap: true,
    outline: { w: 43.18, h: 17.78 }, shiftFromViewBox: true,
    aliases: ['Nano', 'Arduino Nano V3', 'Nano V3', 'ATmega328P Nano'] },
  { id: 'esp32-devkit-v1', name: 'ESP32 DevKit V1 (DOIT)', kind: 'header', src: 'elements', file: 'esp32-devkit-v1', type: 'wokwi-el', snap: true,
    aliases: ['ESP32 DevKit V1', 'DOIT ESP32 DevKit V1', 'ESP32 DevKit', 'ESP-WROOM-32 DevKit', 'ESP32 Dev Module', 'ESP32'] },
  { id: 'esp32-devkitc', name: 'ESP32 DevKitC', kind: 'header', src: 'boards', file: 'esp32-devkit-c-v4', type: 'wokwi-board',
    aliases: ['ESP32-DevKitC', 'ESP32 DevKitC V4', 'ESP32 DevKit C', 'Espressif ESP32-DevKitC', 'ESP32 WROOM DevKitC'] },
  { id: 'raspberry-pi-pico', name: 'Raspberry Pi Pico', kind: 'header', src: 'boards', file: 'pi-pico', type: 'wokwi-board',
    aliases: ['Pi Pico', 'Pico', 'RP2040 Pico', 'Raspberry Pico', 'RPi Pico'] },
  { id: 'raspberry-pi-pico-w', name: 'Raspberry Pi Pico W', kind: 'header', src: 'boards', file: 'pi-pico-w', type: 'wokwi-board',
    aliases: ['Pi Pico W', 'Pico W', 'Pico WH', 'Raspberry Pi Pico WH'] },
  { id: 'raspberry-pi-4', name: 'Raspberry Pi 4 / 5 (40-pin GPIO)', kind: 'header', src: 'fritzing', type: 'fz-pi',
    fzp: 'core/raspberry-pi-4B_1.fzp', svg: 'svg/core/breadboard/raspberry-pi-4B_1_breadboard.svg',
    outline: { w: 85, h: 56 },
    aliases: ['Raspberry Pi 4', 'Pi 4', 'Pi4', 'Raspberry Pi 4B', 'Raspberry Pi 4 Model B', 'Raspberry Pi 5', 'Pi 5', 'Pi5', 'RPi 4', 'RPi 5',
      'Raspberry Pi 3', 'Pi 3', 'Raspberry Pi 3B+', 'Raspberry Pi', 'Pi', 'Raspberry Pi GPIO'],
    note: 'Pi 3, 4 and 5 share the 85 x 56 mm outline and the 2x20 GPIO header position. Pin order from the Fritzing Raspberry Pi 4B part; header anchored to the official mechanical drawing (header centred between the 3.5/61.5 mm mounting holes, outer row 3.5 mm from the top edge). Orientation: GPIO header along the top edge, pin 1 at the left of the inner row, USB/Ethernet at the right.' },
  { id: 'nodemcu-esp8266', name: 'NodeMCU ESP8266 (Amica DevKit 1.0)', kind: 'header', src: 'fritzing', type: 'fz-svg', snap: true,
    fzp: 'core/Amica_NodeMCU_DEVKIT_1.0.fzp', svg: 'svg/core/breadboard/Amica_NodeMCU_DEVKIT_1.0_breadboard.svg',
    labels: ['3V3', 'GND', 'TX', 'RX', 'D8', 'D7', 'D6', 'D5', 'GND', '3V3', 'D4', 'D3', 'D2', 'D1', 'D0', 'A0', 'RSV', 'RSV', 'SD3', 'SD2', 'SD1', 'CMD', 'SD0', 'CLK', 'GND', '3V3', 'EN', 'RST', 'GND', 'VIN'],
    note: 'Pin labels are the silkscreen names of the NodeMCU v1.0 (Amica) board, mapped from the Fritzing connector order (ESP-12 module pin descriptions kept in "function"). Orientation: USB connector at the bottom edge, antenna at the top; D0..D8 are on the right column, A0/SD*/EN/RST/VIN on the left.',
    aliases: ['NodeMCU', 'Node MCU', 'NodeMCU ESP8266', 'NodeMCU v2', 'NodeMCU v3', 'ESP8266 NodeMCU', 'ESP8266', 'ESP-12E DevKit', 'Amica NodeMCU', 'Wemos D1 mini (approx)'].filter(a => !a.includes('Wemos')) },
  { id: 'breadboard-half', name: 'Half-size breadboard (400 tie points)', kind: 'pad', src: 'fritzing', type: 'fz-breadboard',
    svg: 'svg/core/breadboard/Half_breadboard56a.svg', dpi: 90, outline: { w: 82.5, h: 53.34 },
    aliases: ['Breadboard', 'Half breadboard', 'Half-size breadboard', 'Half size breadboard', '400 point breadboard', 'Solderless breadboard', 'Protoboard'],
    note: 'Pad names: <column><row letter>, columns 1-30, rows A-E (one strip) and F-J (other strip). W/X/Y/Z are the four power-rail strips.' },
  { id: 'hc-sr04', name: 'HC-SR04 ultrasonic sensor', kind: 'header', src: 'elements', file: 'hc-sr04', type: 'wokwi-el', snap: true,
    aliases: ['HC-SR04', 'HCSR04', 'Ultrasonic sensor', 'Ultrasonic distance sensor', 'Ultrasonic module', 'SR04'] },
  { id: 'dht22', name: 'DHT22 / DHT11 temperature-humidity sensor', kind: 'header', src: 'elements', file: 'dht22', type: 'wokwi-el', snap: true,
    aliases: ['DHT22', 'DHT11', 'DHT-11', 'DHT-22', 'AM2302', 'Temperature and humidity sensor', 'Humidity sensor'],
    note: 'DHT11 has the same 4-pin 2.54 mm pinout (VCC, DATA, NC, GND); body is slightly smaller (outline here is the DHT22).' },
  { id: 'servo-sg90', name: 'SG90 micro servo', kind: 'header', src: 'elements', file: 'servo', type: 'wokwi-el', snap: true,
    aliases: ['SG90', 'SG90 servo', 'Micro servo', 'Servo', 'Servo motor', '9g servo', 'MG90S'],
    note: 'Wire order from the 3-pin header: GND (brown), V+ (red), PWM/signal (orange).' },
  { id: 'potentiometer', name: 'Rotary potentiometer', kind: 'header', src: 'elements', file: 'potentiometer', type: 'wokwi-el', snap: true,
    aliases: ['Potentiometer', 'Pot', 'Trimpot', 'Rotary potentiometer', 'Variable resistor', 'Trimmer', 'Knob'] },
  { id: 'led-5mm', name: 'LED (5 mm)', kind: 'pin', src: 'elements', file: 'led', type: 'wokwi-el', vars: { anodeX: 25, cathodeX: 15 },
    aliases: ['LED', '5mm LED', 'Light emitting diode', 'Red LED', 'Green LED', 'Light'],
    note: 'Anode is the longer leg.' },
  { id: 'pushbutton-12mm', name: 'Pushbutton (12 mm tactile)', kind: 'pin', src: 'elements', file: 'pushbutton', type: 'wokwi-el',
    aliases: ['Pushbutton', 'Push button', 'Button', 'Tactile switch', 'Tact switch', 'Momentary switch'],
    note: 'Pins 1.l/1.r are internally connected, as are 2.l/2.r.' },
  { id: 'pushbutton-6mm', name: 'Pushbutton (6 mm tactile)', kind: 'pin', src: 'elements', file: 'pushbutton-6mm', type: 'wokwi-el',
    aliases: ['6mm pushbutton', '6mm tactile switch', 'Small button', 'Tiny pushbutton'] },
  { id: 'mpu6050', name: 'MPU-6050 IMU (GY-521)', kind: 'header', src: 'elements', file: 'mpu6050', type: 'wokwi-el', snap: true,
    aliases: ['MPU6050', 'MPU-6050', 'GY-521', 'Accelerometer gyroscope', 'IMU'] },
];
const UNAVAILABLE = [
  { id: 'l298n', name: 'L298N motor driver module', reason: 'No L298N dual H-bridge module exists in wokwi-elements or Fritzing core (only SparkFun bare L298 ICs); not imported.' },
];

// ---------------------------------------------------------------- fetch (cached)
function parseArgs(argv) {
  const a = { src: join(tmpdir(), 'mentor-parts-src'), out: join(ROOT, 'data', 'parts'), offline: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--src') a.src = resolve(argv[++i]);
    else if (k === '--out') a.out = resolve(argv[++i]);
    else if (k === '--offline') a.offline = true;
    else if (k === '--only') a.only = new Set(argv[++i].split(','));
    else if (k === '-h' || k === '--help') { console.log('usage: node tools/import-parts.mjs [--src DIR] [--out DIR] [--offline] [--only id,id]'); process.exit(0); }
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

async function getSource(args, srcKey, path) {
  const s = SRC[srcKey];
  const local = join(args.src, srcKey, path);
  if (existsSync(local)) return readFileSync(local, 'utf8');
  if (args.offline) throw new Error(`offline and not cached: ${srcKey}/${path}`);
  const url = `${ALLOWED_HOST}${s.repo}/${s.sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
  if (!url.startsWith(ALLOWED_HOST)) throw new Error('refusing non-GitHub URL');
  let lastErr;
  for (let t = 0; t < 3; t++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, text);
      return text;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- tiny XML/SVG (data only)
function parseXml(text) {
  text = text.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(text))) {
    const [, close, tag, attrText, self] = m;
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    for (const am of attrText.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[am[1]] = am[2] ?? am[3];
    const node = { tag: tag.replace(/^svg:/, ''), attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  return root.children.find(n => n.tag === 'svg') ?? root.children[0];
}

const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const nums = s => (s.match(NUM) ?? []).map(Number);

function parseTransform(t) {
  let m = IDENT;
  if (!t) return m;
  for (const part of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = nums(part[2]);
    let n = IDENT;
    switch (part[1]) {
      case 'translate': n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]; break;
      case 'scale': n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'matrix': if (v.length === 6) n = v; break;
      case 'rotate': { const a = (v[0] ?? 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); n = [c, s, -s, c, 0, 0];
        if (v.length === 3) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]); break; }
      default: break;
    }
    m = mul(m, n);
  }
  return m;
}

/** Points (endpoints) of a path "d" string; enough for bounding the small round/square pads in connector art. */
function pathPoints(d) {
  const pts = [];
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  const num = () => Number(toks[i++]);
  const hasNum = () => i < toks.length && !/^[a-zA-Z]$/.test(toks[i]);
  while (i < toks.length) {
    if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++];
    else if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l';
    const rel = cmd === cmd.toLowerCase() && cmd !== 'Z';
    const C = cmd.toUpperCase();
    if (C === 'Z') { x = sx; y = sy; continue; }
    const need = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7 }[C];
    if (!need || !hasNum()) { if (!need) i++; continue; }
    const a = []; for (let k = 0; k < need; k++) a.push(num());
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'H') x = (rel ? x : 0) + a[0];
    else if (C === 'V') y = (rel ? y : 0) + a[0];
    else {
      if (C === 'C') { pts.push([ox + a[0], oy + a[1]], [ox + a[2], oy + a[3]]); pts.pop(); pts.pop(); }
      x = ox + a[need - 2]; y = oy + a[need - 1];
    }
    if (C === 'M') { sx = x; sy = y; }
    pts.push([x, y]);
  }
  return pts;
}

function bbox(node, m, acc = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }) {
  const M = mul(m, parseTransform(node.attrs.transform));
  const add = (x, y) => { const [X, Y] = apply(M, x, y); acc.x0 = Math.min(acc.x0, X); acc.x1 = Math.max(acc.x1, X); acc.y0 = Math.min(acc.y0, Y); acc.y1 = Math.max(acc.y1, Y); };
  const a = node.attrs, f = k => Number(a[k] ?? 0);
  switch (node.tag) {
    case 'circle': add(f('cx') - f('r'), f('cy') - f('r')); add(f('cx') + f('r'), f('cy') + f('r')); break;
    case 'ellipse': add(f('cx') - f('rx'), f('cy') - f('ry')); add(f('cx') + f('rx'), f('cy') + f('ry')); break;
    case 'rect': add(f('x'), f('y')); add(f('x') + f('width'), f('y') + f('height')); break;
    case 'line': add(f('x1'), f('y1')); add(f('x2'), f('y2')); break;
    case 'polygon': case 'polyline': { const v = nums(a.points ?? ''); for (let i = 0; i + 1 < v.length; i += 2) add(v[i], v[i + 1]); break; }
    case 'path': for (const [x, y] of pathPoints(a.d ?? '')) add(x, y); break;
    default: break;
  }
  for (const c of node.children) bbox(c, M, acc);
  return acc;
}

function findAll(node, m, pred, out = []) {
  const M = mul(m, parseTransform(node.attrs.transform));
  if (pred(node)) out.push({ node, parentM: m });
  for (const c of node.children) findAll(c, M, pred, out);
  return out;
}

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 };
function svgScale(root, dpi) {
  const vb = nums(root.attrs.viewBox ?? '');
  const len = s => { const m = /^\s*(-?[\d.]+)\s*([a-z%]*)\s*$/i.exec(s ?? ''); if (!m) return null; const u = m[2].toLowerCase(); return Number(m[1]) * (UNIT_MM[u] ?? 25.4 / dpi); };
  const wmm = len(root.attrs.width), hmm = len(root.attrs.height);
  if (vb.length !== 4 || !wmm || !hmm) throw new Error('svg needs width, height and viewBox');
  return { vbx: vb[0], vby: vb[1], sx: wmm / vb[2], sy: hmm / vb[3], wmm, hmm };
}

// ---------------------------------------------------------------- per-source extractors
const r3 = v => Math.round(v * 1000) / 1000;

function wokwiFunction(sig) {
  const f = [];
  for (const m of sig.matchAll(/(spi|i2c|usart)\('(\w+)'/g)) f.push(`${{ spi: 'SPI', i2c: 'I2C', usart: 'UART' }[m[1]]} ${m[2]}`);
  for (const m of sig.matchAll(/analog\((\d+)/g)) f.push(`ADC ${m[1]}`);
  if (/type:\s*'pwm'/.test(sig)) f.push('PWM');
  const pw = /signal:\s*'(\w+)'(?:,\s*voltage:\s*([\d.]+))?/.exec(sig);
  if (pw) f.push(pw[1] === 'GND' ? 'GND' : `power ${pw[2] ?? ''}${pw[2] ? ' V' : ''}`.trim());
  return f.join(', ') || undefined;
}

function extractWokwiElement(ts, part) {
  const block = /pinInfo[^=]*=\s*(?:\[|[\s\S]*?return\s*\[)([\s\S]*?)\];/.exec(ts);
  if (!block) throw new Error('pinInfo not found');
  const body = block[1];
  const pins = [];
  const re = /name:\s*'([^']+)'\s*,\s*x:\s*([\w.-]+)\s*,\s*y:\s*([\w.-]+)/g;
  let m;
  while ((m = re.exec(body))) {
    const val = s => (part.vars && s in part.vars) ? part.vars[s] : Number(s);
    const x = val(m[2]), y = val(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`non-numeric pin ${m[1]}`);
    const tail = body.slice(re.lastIndex, re.lastIndex + 400);
    const sig = /signals:\s*\[([^\]]*)\]/.exec(tail)?.[1] ?? '';
    const desc = /description:\s*'([^']*)'/.exec(tail.split('}')[0])?.[1];
    const fn = [desc, wokwiFunction(sig)].filter(Boolean).join(', ') || undefined;
    pins.push({ name: part.rename?.[m[1]] ?? m[1], x: x / PX_PER_MM, y: y / PX_PER_MM, function: fn });
  }
  // outline: the element's <svg> box, unless the part pins the PCB size
  const svgTag = /<svg[\s\S]*?>/.exec(ts)?.[0] ?? '';
  const attr = k => new RegExp(`\\s${k}="([^"]*)"`).exec(svgTag)?.[1];
  const vb = nums(attr('viewBox') ?? '');
  const toMm = s => /mm$/.test(s) ? parseFloat(s) : parseFloat(s) / PX_PER_MM;
  const box = { w: toMm(attr('width')), h: toMm(attr('height')) };
  const dx = part.shiftFromViewBox ? vb[0] : 0, dy = part.shiftFromViewBox ? vb[1] : 0;
  for (const p of pins) { p.x += dx; p.y += dy; }
  return { pins, outline: part.outline ?? box, source_files: [`src/${part.file}-element.ts`] };
}

function extractWokwiBoard(jsonText, part) {
  const text = jsonText.replace(/\/\*[\s\S]*?\*\//g, '');
  const j = JSON.parse(text);
  const pins = [];
  for (const [name, p] of Object.entries(j.pins)) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number') continue; // virtual pins
    pins.push({ name, x: p.x, y: p.y, function: typeof p.target === 'string' ? p.target : undefined });
  }
  return { pins, outline: { w: j.width, h: j.height }, source_files: [`boards/${part.file}/board.json`], boardName: j.name };
}

function parseFzp(xml) {
  const conns = new Map();
  for (const m of xml.matchAll(/<connector\s+([^>]*?)>([\s\S]*?)<\/connector>/g)) {
    const id = /\bid="([^"]*)"/.exec(m[1])?.[1], name = /\bname="([^"]*)"/.exec(m[1])?.[1];
    const desc = /<description>([\s\S]*?)<\/description>/.exec(m[2])?.[1]?.trim();
    if (id) conns.set(id, { name, desc: desc && desc.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/<[^>]*>/g, '').replace(/^[\s>]+/, '').trim().slice(0, 80) });
  }
  const author = /<author>([^<]*)<\/author>/.exec(xml)?.[1];
  const title = /<title>([^<]*)<\/title>/.exec(xml)?.[1];
  return { conns, author, title };
}

function connectorPoints(svgText, part, idPattern) {
  const root = parseXml(svgText);
  const sc = svgScale(root, part.dpi ?? 90);
  const found = findAll(root, IDENT, n => idPattern.test(n.attrs.id ?? ''));
  const out = new Map();
  for (const { node, parentM } of found) {
    const b = bbox(node, parentM);
    if (!Number.isFinite(b.x0)) continue;
    out.set(node.attrs.id, { x: ((b.x0 + b.x1) / 2 - sc.vbx) * sc.sx, y: ((b.y0 + b.y1) / 2 - sc.vby) * sc.sy });
  }
  return { points: out, sc };
}

async function extractFritzingSvg(args, part) {
  const fzp = parseFzp(await getSource(args, 'fritzing', part.fzp));
  const svg = await getSource(args, 'fritzing', part.svg);
  const { points, sc } = connectorPoints(svg, part, /^connector\d+(pin|terminal)$/);
  const byConn = new Map();
  for (const [id, pt] of points) { const c = id.replace(/(pin|terminal)$/, ''); if (!byConn.has(c) || id.endsWith('pin')) byConn.set(c, pt); }
  const pins = [];
  for (const [cid, c] of fzp.conns) {
    const pt = byConn.get(cid);
    if (pt && c.name) pins.push({ name: c.name, x: pt.x, y: pt.y, function: c.desc, _cid: Number(cid.replace('connector', '')) });
  }
  pins.sort((a, b) => a._cid - b._cid);
  if (part.labels) {
    if (part.labels.length !== pins.length) throw new Error(`labels (${part.labels.length}) do not match connectors (${pins.length})`);
    for (const p of pins) { p.name = part.labels[p._cid]; if (p.function) p.function = p.function.replace(/^\d+,\s*/, ''); }
  }
  return { pins, outline: part.outline ?? { w: sc.wmm, h: sc.hmm }, source_files: [part.fzp, part.svg], fzp, sc };
}

async function extractPi(args, part) {
  const r = await extractFritzingSvg(args, part);
  r.pins = r.pins.filter(p => p._cid < 40); // connector0..39 = physical pins 1..40; the rest are USB/HDMI/etc.
  if (r.pins.length !== 40) throw new Error(`expected 40 GPIO pins, got ${r.pins.length}`);
  const PITCH = 2.54, X1 = 32.5 - 19 * PITCH / 2, Y_OUTER = 3.5;
  const p1 = r.pins[0], p2 = r.pins[1];
  // Fritzing artwork gives only the relative layout; verify it is a 2 x 20 grid with pin 1 on the inner row, then anchor it.
  for (const p of r.pins) {
    const rel = (p.x - p1.x) / PITCH;
    if (Math.abs(rel - Math.round(rel)) > 0.1) throw new Error(`Pi pin ${p.name} off the 2.54 grid`);
  }
  if (!(p1.y > p2.y)) throw new Error('unexpected Fritzing pin-1 row');
  r.pins.forEach((p, i) => {
    p.number = i + 1;
    p.x = X1 + Math.round((p.x - p1.x) / PITCH) * PITCH;
    p.y = (i % 2 === 0) ? Y_OUTER + PITCH : Y_OUTER;
  });
  return r;
}

async function extractBreadboard(args, part) {
  const svg = await getSource(args, 'fritzing', part.svg);
  const { points, sc } = connectorPoints(svg, part, /^pin\d+[A-Z]$/);
  if (points.size < 380) throw new Error(`breadboard: only ${points.size} tie points found`);
  const pins = [...points].map(([id, p]) => ({ name: id.replace(/^pin/, ''), x: p.x, y: p.y }));
  const n = nm => ({ col: parseInt(nm), row: nm.slice(-1) });
  pins.sort((a, b) => n(a.name).col - n(b.name).col || n(a.name).row.localeCompare(n(b.name).row));
  return { pins, outline: part.outline, source_files: [part.svg] };
}

// ---------------------------------------------------------------- post-processing
function uniqueNames(pins) {
  const count = new Map();
  for (const p of pins) count.set(p.name, (count.get(p.name) ?? 0) + 1);
  const seen = new Map();
  for (const p of pins) {
    if (count.get(p.name) > 1) { const n = (seen.get(p.name) ?? 0) + 1; seen.set(p.name, n); p.name = `${p.name}.${n}`; }
  }
}

/** Group header pins into straight runs (rows or columns); snap to the 2.54 mm grid when asked and when the fit is tight. */
function groupHeaders(pins, snap) {
  const hdr = pins.filter(p => p.kind === 'header');
  const used = new Set();
  const groups = [];
  const run = (axis) => {
    const perp = axis === 'x' ? 'y' : 'x';
    const rest = hdr.filter(p => !used.has(p));
    const lines = [];
    for (const p of rest.sort((a, b) => a[perp] - b[perp])) {
      const l = lines.find(l => Math.abs(l.pos - p[perp]) <= 0.6);
      if (l) { l.pins.push(p); l.pos = l.pins.reduce((s, q) => s + q[perp], 0) / l.pins.length; } else lines.push({ pos: p[perp], pins: [p] });
    }
    for (const l of lines) {
      const ps = l.pins.sort((a, b) => a[axis] - b[axis]);
      let cur = [ps[0]];
      const flush = () => { if (cur.length >= 2) { groups.push({ axis, pins: cur }); cur.forEach(p => used.add(p)); } };
      for (let i = 1; i < ps.length; i++) {
        if (ps[i][axis] - ps[i - 1][axis] > 3.3) { flush(); cur = [ps[i]]; } else cur.push(ps[i]);
      }
      flush();
    }
  };
  run('x'); run('y');
  for (const p of hdr) if (!used.has(p)) p.kind = 'pin';
  if (snap) {
    for (const g of groups) {
      const perp = g.axis === 'x' ? 'y' : 'x';
      const base = g.pins[0][g.axis];
      const ks = g.pins.map(p => Math.round((p[g.axis] - base) / 2.54));
      const origin = g.pins.reduce((s, p, i) => s + (p[g.axis] - ks[i] * 2.54), 0) / g.pins.length;
      const resid = Math.max(...g.pins.map((p, i) => Math.abs(p[g.axis] - (origin + ks[i] * 2.54))));
      const dup = new Set(ks).size !== ks.length;
      if (resid <= 0.5 && !dup) {
        g.pins.forEach((p, i) => { p[g.axis] = origin + ks[i] * 2.54; });
        const mean = g.pins.reduce((s, p) => s + p[perp], 0) / g.pins.length;
        g.pins.forEach(p => { p[perp] = mean; });
        g.snapped = true;
      }
    }
  }
  return groups;
}

function buildHeaders(groups, outline) {
  // merge 2-row headers that sit directly next to each other (same extent, 2.54 apart) into one named header
  const hs = groups.map(g => ({
    axis: g.axis, pins: g.pins, snapped: !!g.snapped,
    cx: g.pins.reduce((s, p) => s + p.x_mm, 0) / g.pins.length, cy: g.pins.reduce((s, p) => s + p.y_mm, 0) / g.pins.length,
  }));
  hs.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  return hs.map((h, i) => {
    const side = (() => {
      const dl = h.cx, dr = outline.w - h.cx, dt = h.cy, db = outline.h - h.cy;
      const m = Math.min(dl, dr, dt, db);
      return m === dt ? 'top' : m === db ? 'bottom' : m === dl ? 'left' : 'right';
    })();
    const gaps = h.pins.slice(1).map((p, k) => Math.hypot(p.x_mm - h.pins[k].x_mm, p.y_mm - h.pins[k].y_mm));
    const pitch = gaps.length ? r3(gaps.reduce((s, g) => s + g, 0) / gaps.length) : null;
    return { name: `H${i + 1}`, side, orientation: h.axis === 'x' ? 'row' : 'column', pitch_mm: pitch, snapped_to_grid: h.snapped, pins: h.pins.map(p => p.name) };
  });
}

const FRAME = 'x_mm to the right along the top view from the left edge of outline_mm, y_mm DOWN from its top edge, z up from the top face; all in millimetres. Origin = top-left corner of the outline box as drawn.';

function finish(part, r, extraNote) {
  uniqueNames(r.pins);
  const src = SRC[part.src];
  const pins = r.pins.map(p => ({ ...p, kind: part.kind }));
  const groups = groupHeaders(pins, part.snap);
  // coordinates -> output keys
  const out = pins.map(p => {
    const o = { name: p.name, x_mm: r3(p.x), y_mm: r3(p.y), kind: p.kind };
    if (p.number != null) o.number = p.number;
    if (p.function) o.function = p.function;
    return o;
  });
  const byName = new Map(out.map(p => [p.name, p]));
  for (const g of groups) for (let i = 0; i < g.pins.length; i++) { const o = byName.get(g.pins[i].name); g.pins[i] = o; }
  const outline = { w: r3(r.outline.w), h: r3(r.outline.h) };
  const headers = part.kind === 'pad' ? [] : buildHeaders(groups, outline);
  for (const p of out) {
    if (p.x_mm < -0.01 || p.y_mm < -0.01 || p.x_mm > outline.w + 0.01 || p.y_mm > outline.h + 0.01)
      throw new Error(`pin ${p.name} (${p.x_mm}, ${p.y_mm}) outside outline ${outline.w}x${outline.h}`);
  }
  const files = r.source_files.map(f => `${src.repo}@${src.sha.slice(0, 7)}:${f}`);
  return {
    id: part.id,
    name: part.name,
    aliases: part.aliases,
    source: files.join(' + '),
    license: src.license,
    attribution: src.attribution + (r.fzp?.author ? ` Original part author(s): ${r.fzp.author}.` : '') + ' Mentor code is MIT; this data file keeps the license above.',
    outline_mm: outline,
    frame: FRAME,
    ...(part.note || extraNote ? { notes: [part.note, extraNote].filter(Boolean).join(' ') } : {}),
    pins: out,
    headers,
  };
}

// ---------------------------------------------------------------- main
async function importPart(args, part) {
  switch (part.type) {
    case 'wokwi-el': return finish(part, extractWokwiElement(await getSource(args, 'elements', `src/${part.file}-element.ts`), part));
    case 'wokwi-board': return finish(part, extractWokwiBoard(await getSource(args, 'boards', `boards/${part.file}/board.json`), part));
    case 'fz-pi': {
      const doc = finish(part, await extractPi(args, part));
      doc.headers.unshift({ name: 'J8', side: 'top', orientation: 'row', pitch_mm: 2.54, snapped_to_grid: true, description: '2x20 GPIO header in physical pin order 1..40 (odd pins inner row, even pins outer row)', pins: doc.pins.map(p => p.name) });
      return doc;
    }
    case 'fz-svg': return finish(part, await extractFritzingSvg(args, part));
    case 'fz-breadboard': return finish(part, await extractBreadboard(args, part));
    default: throw new Error(`unknown type ${part.type}`);
  }
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const done = [], failed = [];
  for (const part of PARTS) {
    if (args.only && !args.only.has(part.id)) continue;
    try {
      const doc = await importPart(args, part);
      writeFileSync(join(args.out, `${part.id}.json`), JSON.stringify(doc, null, 1) + '\n');
      done.push(doc);
      console.log(`ok   ${part.id.padEnd(22)} ${String(doc.pins.length).padStart(3)} pins  ${doc.headers.length} headers  ${doc.outline_mm.w}x${doc.outline_mm.h} mm`);
    } catch (e) {
      failed.push({ id: part.id, reason: e.message });
      console.log(`FAIL ${part.id}: ${e.message}`);
    }
  }
  if (!args.only) {
    const index = { _doc: 'Part registry. lookup maps a normalised alias (lowercase, non-alphanumerics removed, e.g. "ESP32 DevKit V1" -> "esp32devkitv1") to a part id. Parts: data/parts/<id>.json. Licensing: see LICENSES.md.', parts: {}, lookup: {}, not_available: UNAVAILABLE };
    for (const d of done) {
      index.parts[d.id] = { name: d.name, file: `${d.id}.json`, aliases: d.aliases, license: d.license, source: d.source, pins: d.pins.length, outline_mm: d.outline_mm };
      for (const a of [d.id, d.name, ...d.aliases]) {
        const k = norm(a);
        if (index.lookup[k] && index.lookup[k] !== d.id) throw new Error(`alias collision: "${a}" -> ${index.lookup[k]} vs ${d.id}`);
        index.lookup[k] = d.id;
      }
    }
    writeFileSync(join(args.out, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  }
  for (const u of UNAVAILABLE) console.log(`skip ${u.id}: ${u.reason}`);
  console.log(`${done.length} imported, ${failed.length} failed -> ${args.out}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
