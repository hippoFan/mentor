// Researched interiors, rendered: serves twin-interior-demo.html (the twin's renderer + twin/interior.js) with the cases
// in a folder, on http://localhost:8797 (127.0.0.1 only; never 8790, and never the always-on hub).
//   node test/mock-research.mjs [--cases <dir>] [--port 8797]          serve; open http://localhost:8797/?case=0
//   node test/mock-research.mjs --shoot [--shots ~/.playwright-mcp]   headless Chrome: every case closed, x-ray and
//     exploded, in hologram and realistic -> <shots>/interior-<case>-<state>-<look>.png, then exits
// A case is <name>.case.json: {scan, photo (base64 JPEG crop or ''), crop, interior} (written by test/research-test.mjs).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const PORT = Number(opt('--port', 8797));
if (PORT < 8796 || PORT > 8799) throw new Error('mocks run on 8796-8799 only');
const CASES = resolve(opt('--cases', join(tmpdir(), 'ody-research-out')));
const SHOTS = resolve(opt('--shots', join(homedir(), '.playwright-mcp')));
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const HERE = fileURLToPath(new URL('..', import.meta.url));
const only = opt('--only', '');

const TYPES = { js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', ttf: 'font/ttf', html: 'text/html; charset=utf-8' };
const STATIC = [   // fixed patterns, as live.mjs: nothing outside these folders can be named
  [/^\/twin\/([a-z0-9-]+\.js)$/, m => join(HERE, 'twin', m[1])],
  [/^\/vendor\/three\/(build\/three\.(?:module|core)\.js|examples\/jsm\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.js)$/, m => join(HERE, 'node_modules/three', m[1])],
  [/^\/fonts\/(InterVariable\.ttf)$/, m => join(HERE, 'fonts', m[1])],
];
async function loadCases() {
  if (!existsSync(CASES)) return [];
  const files = (await readdir(CASES)).filter(f => f.endsWith('.case.json') && (!only || f.startsWith(only))).sort();
  return Promise.all(files.map(async f => ({ file: f.replace('.case.json', ''), ...JSON.parse(await readFile(join(CASES, f), 'utf8')) })));
}
const server = createServer(async (req, res) => {
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host || '')) { res.writeHead(403).end(); return; }
  const url = req.url.split('?')[0];
  try {
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': TYPES.html, 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'" })
        .end(await readFile(join(HERE, 'twin-interior-demo.html')));
    } else if (url === '/cases') {
      res.writeHead(200, { 'content-type': TYPES.json, 'cache-control': 'no-store' }).end(JSON.stringify(await loadCases()));
    } else {
      const hit = STATIC.find(([re]) => re.test(url));
      if (!hit) { res.writeHead(404).end(); return; }
      const m = url.match(hit[0]);
      res.writeHead(200, { 'content-type': TYPES[m[1].split('.').pop()], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }).end(await readFile(hit[1](m)));
    }
  } catch { res.writeHead(404).end(); }
});
await new Promise((r, j) => { server.once('error', j); server.listen(PORT, '127.0.0.1', r); });
console.log(`[mock-research] http://localhost:${PORT}/ (${(await loadCases()).length} cases from ${CASES})`);

if (args.includes('--shoot')) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await mkdir(SHOTS, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'interior-chrome-'));
  const DBG = 9341;
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  let code = 0; const errors = [];
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); } catch { await sleep(200); } }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise(r => ws.once('open', r));
    let id = 0; const wait = new Map();
    ws.on('message', m => { const d = JSON.parse(m); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || 'error'); });
    const cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
    await cdp('Runtime.enable');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `http://localhost:${PORT}/` });
    for (let i = 0; i < 120 && !(await evalJs('!!window.interiorDemo').catch(() => false)); i++) await sleep(500);
    const names = await evalJs('window.interiorDemo.cases()');
    const cases = await loadCases();
    const settle = async () => { await sleep(500); for (let k = 0; k < 50; k++) { const s = await evalJs('window.interiorDemo.state()'); if (!s.flying && (s.explode === 0 || s.explode === 1)) break; await sleep(250); } await sleep(700); };
    for (const [i] of names.entries()) {
      await evalJs(`window.interiorDemo.load(${i})`);
      for (const look of ['holo', 'real']) {
        await evalJs(`window.interiorDemo.setLook(${look === 'holo'})`);
        for (const [state, x, e] of [['closed', false, false], ['xray', true, false], ['exploded', false, true]]) {
          await evalJs(`window.interiorDemo.setXray(${x}); window.interiorDemo.setExplode(${e})`);
          await settle();
          const shot = await cdp('Page.captureScreenshot', { format: 'png' });
          const path = join(SHOTS, `interior-${cases[i].file}-${state}-${look}.png`);
          await writeFile(path, Buffer.from(shot.result.data, 'base64'));
          const s = await evalJs('window.interiorDemo.state()');
          console.log(`[mock-research] ${path} (inside ${s.inside}, ${s.meshes} parts)`);
        }
      }
      await evalJs('window.interiorDemo.setXray(false); window.interiorDemo.setExplode(false)'); await settle();
    }
    if (errors.length) { console.error('[mock-research] page errors:', errors.slice(0, 5)); code = 1; }
    ws.close();
  } catch (e) { console.error("[mock-research]", String(e).slice(0, 300), "page errors:", errors.slice(0, 3)); code = 1; }
  finally { chrome.kill(); server.close(); await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {}); }
  process.exit(code);
}
