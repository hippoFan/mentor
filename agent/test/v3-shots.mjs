// Screenshots of every page at four window sizes (design review): ~/.playwright-mcp/v3-<page>-<w>x<h>.png, plus the
// profile menu and Settings. Also reports horizontal overflow and overlap of the Argo stage and call panel.
// Real live.mjs + argos/server.mjs on :8797 with a temp designs folder and a temp .env. Never the live hub.
//   node test/v3-shots.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.SHOTS_PORT || 8796), DEBUG = 9357, SHOTS = join(homedir(), '.playwright-mcp');
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = await mkdtemp(join(tmpdir(), 'ody-shots-'));
process.env.ARGOS_DESIGNS_DIR = join(dir, 'designs'); process.env.ARGOS_ENV_FILE = join(dir, 'test.env'); process.env.MENTOR_MONITOR_PORT = String(PORT);
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ARGOS_OPENAI_KEY', 'ELEVENLABS_API_KEY', 'ELEVEN_API_KEY', 'CHERT_API_KEY']) delete process.env[k];
await writeFile(process.env.ARGOS_ENV_FILE, '# test\n', { mode: 0o600 });
const { createLiveServer } = await import('../live.mjs');
const { createArgos } = await import('../argos/server.mjs');
let argos;
const live = await createLiveServer({ onPageMessage: m => argos.onPageMessage(m), routes: (req, res) => argos.route(req, res) });
argos = createArgos({ send: e => live.send(e) });
argos.onPublished({ type: 'scan', spec: { name: 'Sensor lamp', parts: [{ name: 'Base', shape: 'box', size_mm: { x: 60, y: 40, z: 12 } }] } });
await sleep(600);
await mkdir(SHOTS, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'shots-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, '--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
const errors = [];
try {
  let t; for (let i = 0; i < 50 && !t; i++) { try { t = await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  let id = 0; const wait = new Map();
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || 'exception');
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 200)); });
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async e => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cdp('Runtime.enable'); await cdp('Page.enable');
  const only = process.argv[2];
  for (const [w, h] of [[1280, 800], [1440, 900], [1024, 768], [1920, 1080]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `http://localhost:${PORT}/#main` });
    for (let i = 0; i < 60 && !(await ev('!!(window.odyPages && window.odyAccount && document.fonts.status === "loaded")')); i++) await sleep(200);
    await sleep(1200);
    for (const p of ['main', 'argo', 'forge', 'settings', 'profile']) {
      if (only && only !== p) continue;
      await ev(`window.odyPages.goTo(${JSON.stringify(p)})`); await sleep(p === 'forge' ? 2000 : 1500);
      const o = await ev(`(() => { const r = s => document.querySelector(s)?.getBoundingClientRect(); const st = r('#page-argo .theatre'), rl = r('#rail');
        return { x: document.documentElement.scrollWidth > innerWidth, stage: st && [Math.round(st.width), Math.round(st.height)], rail: rl && Math.round(rl.width), cur: document.querySelector("#pages > .page:not([hidden]):not(.off)")?.id, argo: document.getElementById("page-argo").getAttribute("style"), main: document.getElementById("page-main").getAttribute("style") }; })()`);
      console.log(`${p} ${w}x${h}`, JSON.stringify(o));
      const s = await cdp('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(SHOTS, `v3-${p}-${w}x${h}.png`), Buffer.from(s.result.data, 'base64'));
      if (p === 'main') {
        await ev('document.getElementById("page-main").scrollTop = 1e6'); await sleep(400);
        const b = await cdp('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(SHOTS, `v3-main-bottom-${w}x${h}.png`), Buffer.from(b.result.data, 'base64'));
        await ev('document.getElementById("page-main").scrollTop = 0');
      }
    }
    if (!only || only === 'menu') {
      await ev('window.odyPages.goTo("main")'); await sleep(500); await ev('window.odyAccount.open()'); await sleep(400);
      const s = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(join(SHOTS, `v3-menu-${w}x${h}.png`), Buffer.from(s.result.data, 'base64'));
      await ev('window.odyAccount.close()');
    }
  }
} finally { chrome.kill(); await live.close(); await rm(profile, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no console errors');
process.exit(0);
