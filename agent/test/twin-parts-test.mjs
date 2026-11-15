// The 3D twin with each library board: mock call (test/mock-twin.mjs --part <id> on :8797, never 8790) in headless
// Chrome (SwiftShader, no window), then screenshots in both looks, pin tooltips from the library, marks on the right
// pins, explode and .glb export.
//   node test/twin-parts-test.mjs [id ...]      screenshots: ~/.playwright-mcp/twin-part-<id>-{holo,real,marks}.png
// "uno-q" (in the default run too): the Arduino UNO Q (board.js) via mock-twin --parts --board uno-q, explode, remove its
// Wi-Fi module by voice; screenshots ~/.playwright-mcp/unoq-{holo,real,exploded}.png
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import WebSocket from 'ws';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8797, DEBUG = 9341;
const SHOTS = join(homedir(), '.playwright-mcp');
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const ALL = ['raspberry-pi-4', 'esp32-devkit-v1', 'arduino-nano', 'arduino-mega-2560', 'raspberry-pi-pico', 'raspberry-pi-pico-w', 'esp32-devkitc', 'nodemcu-esp8266'];
const IDS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const UNOQ = !IDS.length || IDS.includes('uno-q');
const ids = (IDS.length ? IDS : ALL).filter(i => i !== 'uno-q');
// a pin per board whose tooltip must come from the library: [key, name shown, words in the function]
const TIPS = {
  'raspberry-pi-4': ['GPIO17', 'GPIO17', /pin 11/], 'esp32-devkit-v1': ['D21', 'D21', /I2C SDA/], 'arduino-nano': ['A4', 'A4', /SDA/],
  'arduino-mega-2560': ['20', 'D20', /SDA/], 'raspberry-pi-pico': ['GP15', 'GP15', /pin 20/], 'raspberry-pi-pico-w': ['VBUS', 'VBUS', /pin 40/],
  'esp32-devkitc': ['21', 'D21', /./], 'nodemcu-esp8266': ['D5', 'D5', /./],
};
const WIRE_FROM = { 'raspberry-pi-4': 'GPIO17', 'esp32-devkit-v1': 'D5', 'esp32-devkitc': '5', 'nodemcu-esp8266': 'D5', 'arduino-nano': '13', 'arduino-mega-2560': '22', 'raspberry-pi-pico': 'GP15', 'raspberry-pi-pico-w': 'GP15' };

let pass = 0, fail = 0;
const test = async (name, fn) => { try { const d = await fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

await mkdir(SHOTS, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'twin-parts-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let mock = null;
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json(); } catch { await sleep(200); } }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  let id = 0; const wait = new Map();
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
  const until = async (expr, tries = 60, ms = 300) => { for (let i = 0; i < tries; i++) { const v = await evalJs(expr).catch(() => null); if (v) return v; await sleep(ms); } return null; };
  const shot = async name => { const s = await cdp('Page.captureScreenshot', { format: 'png' }); const p = join(SHOTS, name); await writeFile(p, Buffer.from(s.result.data, 'base64')); console.log(`      ${p}`); };
  const settle = async () => { await sleep(500); await until('!window.mentorTwin.boardState().flying', 60, 300); await sleep(700); };
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const errors = [];
  await cdp('Runtime.enable');
  ws.on('message', m => { const d = JSON.parse(m); if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || 'exception'); });

  for (const part of ids) {
    mock = spawn(process.execPath, ['test/mock-twin.mjs', '--part', part, '--port', String(PORT)], { cwd: HERE, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_GAP_MS: '16000', MOCK_START_MS: '300' } });
    await new Promise((res, rej) => { mock.stdout.on('data', d => { if (/twin on/.test(String(d))) res(); }); mock.on('exit', c => rej(new Error(`mock exited ${c}`))); });
    let st = null;
    for (let attempt = 0; attempt < 3 && !st; attempt++) {   // the previous mock just freed the port: retry a failed load
      await cdp('Page.navigate', { url: `http://localhost:${PORT}/twin#argo` });
      st = await until(`(s => s?.built === ${JSON.stringify(part)} && s)(window.mentorTwin?.boardState?.())`, 60, 250);
    }
    await test(`${part}: built from the library`, () => {
      assert.ok(st, `board never built ${errors.join(' | ').slice(0, 600)}`);
      assert.ok(st.pins >= 30 && st.meshes >= 15, `${st.pins} pins, ${st.meshes} meshes`);
      assert.ok(st.part.length > 3 && st.part !== 'Board', `panel "${st.part}"`);
      return `${st.name}: ${st.pins} pins, ${st.meshes} meshes, "${st.sub}"`;
    });
    if (!st) { mock.kill(); await new Promise(r => mock.once('exit', r)); mock = null; continue; }
    await evalJs("document.getElementById('t-reset').click()");
    for (const look of ['holo', 'real']) {
      await evalJs(`window.mentorTwin.setLook(${look === 'holo'})`);
      await settle();
      await shot(`twin-part-${part}-${look}.png`);
    }
    await test(`${part}: pin tooltip from the library`, () => evalJs(`JSON.stringify(window.mentorTwin.pinTip(${JSON.stringify(TIPS[part][0])}))`).then(j => {
      const tip = JSON.parse(j); assert.equal(tip.name, TIPS[part][1]); assert.match(tip.fn, TIPS[part][2]); return `${tip.name}: ${tip.fn}`;
    }));
    // the marks turn: a wire from the board's pin to breadboard J10 + a ring on a signature part
    const marks = await until('(s => s.marks.length >= 2 && s.marks)(window.mentorTwin.state())', 80, 250);
    await test(`${part}: marks land on library pins and parts`, () => {
      assert.ok(marks, 'no marks');
      assert.deepEqual(marks[0].from, { on: 'pin', key: WIRE_FROM[part] }); assert.equal(marks[0].to?.on, 'bb');
      assert.equal(marks[1].from?.on, 'feature', `ring "${marks[1].label}" -> ${JSON.stringify(marks[1].from)}`);
      return `${marks[0].label}; ${marks[1].label} -> ${marks[1].from.key}`;
    });
    await evalJs('window.mentorTwin.setLook(true)'); await settle();
    await shot(`twin-part-${part}-marks.png`);
    if (part === ids[0]) {
      await evalJs("document.getElementById('t-explode').click()");
      await until('window.mentorTwin.boardState().explode > 0.99', 60, 300); await settle();
      await shot(`twin-part-${part}-exploded.png`);
      await evalJs("document.getElementById('t-explode').click()");
      const glb = await evalJs('window.mentorTwin.exportBytes()');
      await test(`${part}: explode + .glb export`, () => { assert.equal(glb.magic, 'glTF'); assert.ok(glb.length > 50_000, `${glb.length} bytes`); return `${glb.length} bytes`; });
    }
    mock.kill(); await new Promise(r => mock.once('exit', r)); mock = null;
  }
  if (UNOQ) {
    mock = spawn(process.execPath, ['test/mock-twin.mjs', '--parts', '--board', 'uno-q', '--port', String(PORT)], { cwd: HERE, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_GAP_MS: '600000', MOCK_START_MS: '300' } });
    await new Promise((res, rej) => { mock.stdout.on('data', d => { if (/twin on/.test(String(d))) res(); }); mock.on('exit', c => rej(new Error(`mock exited ${c}`))); });
    let st = null;
    for (let attempt = 0; attempt < 3 && !st; attempt++) {
      await cdp('Page.navigate', { url: 'about:blank' }); await sleep(200);   // same URL as the last board: force a real load
      await cdp('Page.navigate', { url: `http://localhost:${PORT}/twin#argo` });
      st = await until('(s => s?.built === "uno-q" && s)(window.mentorTwin?.boardState?.())', 80, 250);
    }
    if (!st) console.log('      state:', await evalJs('JSON.stringify(window.mentorTwin?.boardState?.() ?? location.href)').catch(e => e.message));
    await test('uno-q: Arduino UNO Q built (not the R4)', () => {
      assert.ok(st, `board never built ${errors.join(' | ').slice(0, 600)}`);
      assert.equal(st.name, 'Arduino UNO Q'); assert.equal(st.pins, 31); assert.ok(st.meshes >= 40, `${st.meshes} meshes`);
      assert.match(st.sub, /8 × 13 LED matrix/);
      return `${st.pins} pins, ${st.meshes} meshes, "${st.sub}"`;
    });
    if (st) {
      await evalJs("document.getElementById('t-reset').click()");
      for (const look of ['holo', 'real']) { await evalJs(`window.mentorTwin.setLook(${look === 'holo'})`); await settle(); await shot(`unoq-${look}.png`); }
      await test('uno-q: 3.3 V pin tooltips (D3 and A0 not 5 V-tolerant)', () => evalJs('JSON.stringify([window.mentorTwin.pinTip("3"), window.mentorTwin.pinTip("A0"), window.mentorTwin.pinTip("IOREF")])').then(j => {
        const [d3, a0, io] = JSON.parse(j); assert.match(d3.fn, /not 5 V-tolerant/); assert.match(a0.fn, /not 5 V-tolerant/); assert.match(io.fn, /3\.3 V/); return `${d3.name}: ${d3.fn}`;
      }));
      const ps = await evalJs('JSON.stringify(window.mentorTwin.partsState().parts.map(p => p.id))').then(JSON.parse);
      await test('uno-q: real parts listed for explode / remove', () => {
        for (const id of ['mpu', 'ram', 'pmic', 'wifi', 'matrix', 'usb', 'power', 'qwiic', 'jctl', 'icsp', 'stm32', 'emmc', 'jmedia', 'jmisc', 'rgb1']) assert.ok(ps.includes(id), `${id} missing: ${ps.join(',')}`);
        for (const id of ['jack', 'reset', 'esp32', 'regulator']) assert.ok(!ps.includes(id), `${id} should not be on a UNO Q`);
        return `${ps.length} parts`;
      });
      await evalJs("document.getElementById('t-explode').click()");
      await until('window.mentorTwin.boardState().explode > 0.99', 60, 300); await settle();
      await shot('unoq-exploded.png');
      await evalJs('window.mentorTwin.inject({ type: "twin", action: "remove", target: "the wifi module" })');
      const gone = await until('(window.mentorTwin.partsState().parts.find(p => p.id === "wifi") || {}).removed', 30, 300);
      await test('uno-q: "remove the wifi module" takes the WCBN3536A off', () => assert.ok(gone, 'wifi still on the board'));
      await settle(); await shot('unoq-exploded-nowifi.png');
      await evalJs('window.mentorTwin.inject({ type: "twin", action: "combine" })');
      await evalJs("document.getElementById('t-explode').click()");
      const glb = await evalJs('window.mentorTwin.exportBytes()');
      await test('uno-q: .glb export', () => { assert.equal(glb.magic, 'glTF'); assert.ok(glb.length > 50_000, `${glb.length} bytes`); return `${glb.length} bytes`; });
    }
    mock.kill(); await new Promise(r => mock.once('exit', r)); mock = null;
  }
  await test('no page errors', () => assert.deepEqual(errors, []));
  ws.close();
} finally {
  chrome.kill(); if (mock) mock.kill();
  await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
