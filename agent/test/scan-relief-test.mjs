// Scan v2 render test: every cached scan in <dir> (written by test/scan-test.mjs, optionally with a `depth` field from
// depth.mjs) replayed through the real live.mjs server (mock-twin, port 8799) into headless Chrome.
//   before: the old cut-out (segmenter blocked -> flood fill) and the parts view, Real look
//   after:  segmenter cut-out + photo relief (front and three-quarter views), hologram, Parts toggle, Explode, export
//   node test/scan-relief-test.mjs <dir> [--port 8799] [--shots ~/.playwright-mcp]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIR = resolve(args.find((a, i) => !a.startsWith('--') && !['--port', '--shots'].includes(args[i - 1])) || '');
const PORT = Number(opt('--port', 8799));
if (PORT === 8790) throw new Error('8790 is the live agent');
const SHOTS = resolve(opt('--shots', join(homedir(), '.playwright-mcp')));
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const HERE = fileURLToPath(new URL('..', import.meta.url));
const files = (await readdir(DIR)).filter(f => f.endsWith('.scan.json')).sort();
if (!files.length) { console.log('no <name>.scan.json in', DIR); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };

await mkdir(SHOTS, { recursive: true });
const mock = spawn(process.execPath, ['test/mock-twin.mjs', '--scan', DIR, '--port', String(PORT)], { cwd: HERE, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { mock.stdout.on('data', d => { if (/holding/.test(String(d))) res(); }); mock.on('exit', c => rej(new Error(`mock exited ${c}`))); });
const profile = await mkdtemp(join(tmpdir(), 'relief-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9338', `--user-data-dir=${profile}`, '--no-first-run',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch('http://127.0.0.1:9338/json')).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  let id = 0; const wait = new Map(); const errors = [];
  ws.on('message', m => {
    const d = JSON.parse(m); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
    if (d.method === 'Runtime.consoleAPICalled' && /relief|segment|cut-out/.test(JSON.stringify(d.params.args))) console.log('[page]', d.params.args.map(a => a.value ?? a.description).join(' '));
  });
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return r.result?.result?.value; };
  const shot = async name => { const s = await cdp('Page.captureScreenshot', { format: 'png' }); const p = join(SHOTS, `scan-v2-${name}.png`); await writeFile(p, Buffer.from(s.result.data, 'base64')); console.log(`    ${p}`); };
  const settle = async () => { await sleep(700); for (let k = 0; k < 40 && (await evalJs('window.mentorTwin.scanState().flying')); k++) await sleep(300); await sleep(500); };
  const relief = () => evalJs("import('/twin/relief.js').then(m => m.reliefState(window.odyHost.currentScan()?.built))");
  const load = async () => {
    await cdp('Page.navigate', { url: `http://localhost:${PORT}/twin` });
    for (let i = 0; i < 120; i++) { await sleep(500); const s = await evalJs('window.mentorTwin?.scanState?.()').catch(() => null); if (s?.scans?.length === files.length) break; }
    return evalJs('window.mentorTwin.scanState()');
  };
  const orbit = rad => evalJs(`(() => { const h = window.odyHost, c = h.camera, t = h.controls.target; const o = c.position.clone().sub(t); o.applyAxisAngle(new h.THREE.Vector3(0, 1, 0), ${rad}); o.y *= 0.55; c.position.copy(t).add(o); h.controls.update(); return true; })()`);
  await cdp('Runtime.enable'); await cdp('Network.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // ---------- before: the flood fill and the parts (what shipped until now) ----------
  await cdp('Network.setBlockedURLs', { urls: ['*magic_touch*'] });
  let st = await load();
  await evalJs("import('/twin/relief.js').then(m => m.setReliefWanted(false))");
  for (const [i, f] of files.entries()) {
    if (st.scans[i].known) continue;
    await evalJs(`window.mentorTwin.showScan(${i})`); await evalJs('window.mentorTwin.setLook(false)');
    await settle(); await shot(`before-${f.replace('.scan.json', '')}`);
  }
  // ---------- after ----------
  await cdp('Network.setBlockedURLs', { urls: [] });
  st = await load();
  for (const [i, f] of files.entries()) {
    if (st.scans[i].known) continue;
    const name = f.replace('.scan.json', '');
    await evalJs(`window.mentorTwin.showScan(${i})`); await evalJs('window.mentorTwin.setLook(false)');
    let r; for (let k = 0; k < 40; k++) { r = await relief(); if (r.state === 'ready' || r.state === 'failed') break; await sleep(300); }
    await settle(); r = await relief();
    const iou = await evalJs("import('/twin/relief.js').then(m => m.silhouetteIoU(window.odyHost.currentScan()?.built))");
    console.log(`    ${name}: relief ${r.state}${r.error ? ` (${r.error})` : ''} parts-vs-mask IoU ${iou == null ? '-' : iou.toFixed(2)} ${JSON.stringify(r.stats)}`);
    await test(`relief shown for ${name}`, () => { assert.equal(r.state, 'ready'); assert.ok(r.visible, 'relief visible'); });
    await shot(`after-${name}-relief`);
    await orbit(0.95); await sleep(600); await shot(`after-${name}-relief-34`);
    await evalJs('window.mentorTwin.setLook(true)'); await sleep(600); await shot(`after-${name}-relief-holo`);
    await evalJs('window.mentorTwin.setLook(false)');
  }
  // toggles on the last non-board scan: Parts, back to Relief, Explode (parts come back), export
  const last = st.scans.findLastIndex(x => !x.known);
  await evalJs(`window.mentorTwin.showScan(${last})`); await settle();
  await evalJs("document.getElementById('t-parts').click()"); await sleep(400);
  await test('Parts toggle shows the primitives', async () => { const r = await relief(); assert.equal(r.visible, false); assert.ok(await evalJs('window.odyHost.currentScan().built.meshes.every(m => m.visible)')); });
  await shot('after-parts');
  await evalJs("document.getElementById('t-relief').click()"); await sleep(400);
  await test('Relief toggle brings the relief back', async () => assert.equal((await relief()).visible, true));
  await evalJs("document.getElementById('t-explode').click()");
  for (let k = 0; k < 40 && (await evalJs('window.mentorTwin.scanState().explode')) < 0.99; k++) await sleep(300);
  await sleep(600); await shot('after-exploded');
  await test('Explode swaps in the parts', async () => { const r = await relief(); assert.equal(r.visible, false); assert.ok(await evalJs('window.odyHost.currentScan().built.meshes.every(m => m.visible)')); });
  await evalJs("document.getElementById('t-explode').click()");
  for (let k = 0; k < 40 && (await evalJs('window.mentorTwin.scanState().explode')) > 0.01; k++) await sleep(300);
  await sleep(300);
  await test('assembled again: relief back', async () => assert.equal((await relief()).visible, true));
  const glb = await evalJs('window.mentorTwin.exportBytes()');
  await test('export .glb with the relief', () => { assert.equal(glb.magic, 'glTF'); assert.ok(glb.length > 50_000, `glb ${glb.length}`); });
  await test('no page exceptions', () => assert.deepEqual(errors, []));
  ws.close();
} finally {
  chrome.kill(); mock.kill();
  await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(`${pass} scan relief tests passed`);
