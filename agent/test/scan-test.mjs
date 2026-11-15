// "Scan anything" test: unit checks (intent regex, sanitiser), then brain.scan on photos, then each scan rendered in the
// real /twin page (mock server on :8798, headless Chrome) in hologram and realistic looks.
//   node test/scan-test.mjs                    unit checks only (free, no keys)
//   MENTOR_BRAIN=claude-code MENTOR_OWNER_TESTING=1 node --env-file=../.env test/scan-test.mjs --scan photo1.jpg photo2.jpg ...
//     one brain call per photo (cached in --out; --fresh re-scans), then renders + screenshots
//   node test/scan-test.mjs --render           renders the cached scans only (no brain calls)
// Options: --out <dir> (default: ./scan-out), --shots <dir> (default: ~/.playwright-mcp)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MAX_PARTS, SHAPES, cropJpeg, isScanIntent, sanitizeScan, scaleJpeg } from '../scan.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(opt('--out', join(tmpdir(), 'mentor-scan-out')));
const SHOTS = resolve(opt('--shots', join(homedir(), '.playwright-mcp')));
const PORT = Number(opt('--port', 8798));   // never 8790 (the live agent)
if (PORT === 8790) throw new Error('8790 is the live agent');
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const HERE = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };

// ---------- unit ----------
await test('scan intent', () => {
  for (const t of ['Scan this', 'can you scan it?', 'make a 3D model of this', 'send this to my laptop', 'Send it to laptop', 'make me a model of my mouse', 'show me the digital twin'])
    assert.ok(isScanIntent(t), t);
  for (const t of ['where does pin 13 go', 'is this right?', 'okay', 'I sent the code', 'scanner app is open'.replace('scanner', 'scanr')])
    assert.ok(!isScanIntent(t), t);
});
await test('sanitiser caps and validates', () => {
  const evil = sanitizeScan({
    name: '<img src=x onerror=alert(1)> a very long name that goes on and on and on forever', category: 'x', known_model: 'nope',
    dims_mm: { w: 1e9, d: -5, h: 'tall' }, confidence: 7, bbox: [900, 800, 100, 50], top_face: 'zz', camera_elev_deg: 400,
    parts: Array.from({ length: 60 }, (_, i) => ({ name: `p${i}\u0007`, shape: i ? 'box' : 'teapot', size_mm: { x: 0, y: NaN, z: 5 },
      position_mm: { x: 1e7, y: 0, z: 0 }, rotation_deg: { x: 720, y: 0, z: 0 }, color: i % 2 ? 'red' : '#ABC', material: 'lava', label: 'x'.repeat(99) })),
  }, 1000, 1000);
  assert.ok(evil.name.length <= 40 && !/[<>]/.test(evil.name));
  assert.equal(evil.known_model, 'none');
  assert.deepEqual(evil.dims_mm, { w: 2000, d: 5, h: 40 });
  assert.equal(evil.confidence, 1);
  assert.deepEqual(evil.bbox, [0.1, 0.05, 0.9, 0.8]);
  assert.equal(evil.top_face, 'xy'); assert.equal(evil.camera_elev_deg, 90);
  assert.equal(evil.parts.length, MAX_PARTS);
  assert.equal(evil.parts[0].shape, 'box');
  assert.equal(evil.parts[0].color, '#aabbcc'); assert.equal(evil.parts[1].color, '#8a8f98');
  assert.equal(evil.parts[0].material, 'plastic');
  assert.equal(evil.parts[0].size_mm.x, 0.5); assert.equal(evil.parts[0].size_mm.y, 10);
  assert.equal(evil.parts[0].position_mm.x, 2000); assert.equal(evil.parts[0].rotation_deg.x, 360);
  assert.ok(evil.parts.every(p => p.label.length <= 40 && !/[\u0000-\u001f]/.test(p.name)));
  const empty = sanitizeScan(null);
  assert.equal(empty.parts.length, 1); assert.deepEqual(empty.bbox, [0, 0, 1, 1]);
});

// ---------- brain scans (owner testing; one call per photo, cached) ----------
const photos = args.includes('--scan') ? args.slice(args.indexOf('--scan') + 1).filter(a => !a.startsWith('--') && /\.(jpe?g|png)$/i.test(a)) : [];
if (photos.length > 6) throw new Error('at most 6 brain calls per run');
await mkdir(OUT, { recursive: true });
if (photos.length) {
  const { createBrain } = await import('../brain.mjs');
  const brain = await createBrain({});
  console.log(`[scan-test] brain: ${brain.provider}`);
  for (const photo of photos) {
    const name = basename(photo).replace(/\.\w+$/, '');
    const file = join(OUT, `${name}.scan.json`);
    if (existsSync(file) && !args.includes('--fresh')) { console.log(`[scan-test] ${name}: cached`); continue; }
    const image = await scaleJpeg(await readFile(photo), 1280);
    const spec = await brain.scan(image);
    const cut = await cropJpeg(image.jpeg, spec.bbox, 1024);
    await writeFile(file, JSON.stringify({ spec, photo: cut.jpeg.toString('base64'), crop: cut.rect }));
    await writeFile(join(OUT, `${name}.crop.jpg`), cut.jpeg);
    console.log(`[scan-test] ${name}: ${spec.name} (${spec.category}), ${spec.parts.length} parts, ${Math.round(spec.confidence * 100)}%, ` +
      `${spec.dims_mm.w}x${spec.dims_mm.d}x${spec.dims_mm.h} mm, elev ${spec.camera_elev_deg}, ${spec.ms} ms`);
  }
  await brain.close?.();
}

const scans = existsSync(OUT) ? (await readdir(OUT)).filter(f => f.endsWith('.scan.json')).sort() : [];
for (const f of scans) {
  await test(`spec valid: ${f}`, async () => {
    const { spec, photo, crop } = JSON.parse(await readFile(join(OUT, f), 'utf8'));
    assert.ok(spec.name && spec.parts.length >= 1 && spec.parts.length <= MAX_PARTS);
    assert.ok(spec.parts.every(p => SHAPES.includes(p.shape) && /^#[0-9a-f]{6}$/.test(p.color)));
    assert.ok(spec.bbox[2] > spec.bbox[0] && spec.bbox[3] > spec.bbox[1]);
    assert.equal(crop.length, 4); assert.ok(photo.length > 1000);
    const dims = [spec.dims_mm.w, spec.dims_mm.d, spec.dims_mm.h];
    assert.ok(dims.every(d => d >= 1 && d <= 2000));
  });
}

// ---------- render in the real twin page ----------
if (scans.length && (photos.length || args.includes('--render'))) {
  await mkdir(SHOTS, { recursive: true });
  const mock = spawn(process.execPath, ['test/mock-twin.mjs', '--scan', OUT, '--port', String(PORT)], { cwd: HERE, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { mock.stdout.on('data', d => { if (/holding/.test(String(d))) res(); }); mock.on('exit', c => rej(new Error(`mock exited ${c}`))); });
  const profile = await mkdtemp(join(tmpdir(), 'scan-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9339', `--user-data-dir=${profile}`, '--no-first-run',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch('http://127.0.0.1:9339/json')).json(); } catch { await new Promise(r => setTimeout(r, 200)); } }
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise(r => ws.once('open', r));
    let id = 0; const wait = new Map();
    ws.on('message', m => { const d = JSON.parse(m); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
    const cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `http://localhost:${PORT}/twin` });
    for (let i = 0; i < 60; i++) { await sleep(500); const s = await evalJs('window.mentorTwin?.scanState?.()').catch(() => null); if (s?.scans?.length === scans.length) break; }
    const st = await evalJs('window.mentorTwin.scanState()');
    await test('twin received every scan', () => assert.equal(st.scans.length, scans.length));
    for (const [i, f] of scans.entries()) {
      const name = f.replace('.scan.json', '');
      const known = st.scans[i].known;
      await evalJs(`window.mentorTwin.showScan(${i})`);
      for (const look of ['holo', 'real']) {
        await evalJs(`window.mentorTwin.setLook(${look === 'holo'})`);
        await sleep(800);
        for (let k = 0; k < 40 && (await evalJs('window.mentorTwin.scanState().flying')); k++) await sleep(300);   // camera flight (slow on SwiftShader)
        await sleep(600);
        const shot = await cdp('Page.captureScreenshot', { format: 'png' });
        const path = join(SHOTS, `scan-${name}-${look}.png`);
        await writeFile(path, Buffer.from(shot.result.data, 'base64'));
        console.log(`[scan-test] ${path}`);
      }
      const s = await evalJs('window.mentorTwin.scanState()');
      await test(`twin shows ${name}`, () => {
        if (known) assert.equal(s.view, 'board');
        else { assert.equal(s.view, 'scan'); assert.ok(s.meshes >= 1); assert.ok(s.photoLoaded, 'photo projected'); }
      });
    }
    // explode + export on the last non-board scan
    const last = st.scans.findLastIndex(x => !x.known);
    if (last >= 0) {
      await evalJs(`window.mentorTwin.showScan(${last})`); await evalJs('window.mentorTwin.setLook(true)');
      await evalJs("document.getElementById('t-explode').click()");
      for (let k = 0; k < 40 && (await evalJs('window.mentorTwin.scanState().explode')) < 0.99; k++) await sleep(300);
      await sleep(600);
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(SHOTS, 'scan-exploded.png'), Buffer.from(shot.result.data, 'base64'));
      const e = await evalJs('window.mentorTwin.scanState().explode');
      await test('explode spreads the scan', () => assert.ok(e > 0.95, `explode ${e}`));
      const glb = await evalJs('window.mentorTwin.exportBytes()');
      await test('export .glb of the scan', () => { assert.equal(glb.magic, 'glTF'); assert.ok(glb.length > 50_000, `glb ${glb.length} bytes`); });
    }
    ws.close();
  } finally {
    chrome.kill(); mock.kill();
    await sleep0(300); await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
function sleep0(ms) { return new Promise(r => setTimeout(r, ms)); }
console.log(`${pass} scan tests passed`);
