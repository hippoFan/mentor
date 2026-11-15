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
  if (only === 'v5') {   // the bar on every page and mid-move: v5-*.png
    const snap = async (name, clip) => { const r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); await writeFile(join(SHOTS, `v5-${name}.png`), Buffer.from(r.result.data, 'base64')); };
    for (const [w, h] of [[1440, 900], [1280, 800]]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await cdp('Page.navigate', { url: `http://localhost:${PORT}/#main` });
      for (let i = 0; i < 60 && !(await ev('!!(window.odyPages && window.odyAccount && document.fonts.status === "loaded")')); i++) await sleep(200);
      await sleep(1800);
      await snap(`home-${w}x${h}`);
      for (const p of ['argo', 'forge', 'main']) {
        if (p === 'forge') { await ev('window.odyPages.goTo("main")'); await sleep(1600); }
        await ev(`window.odyPages.goTo(${JSON.stringify(p)})`); await sleep(420); await snap(`mid-to-${p}-${w}x${h}`);
        await sleep(1600); await snap(`${p}-${w}x${h}`);
        if (p === 'argo') { const r = await ev('(() => { const b = document.getElementById("rail").getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()'); await snap(`argo-panel-${w}x${h}`, { x: Math.max(0, r[0] - 12), y: r[1] - 12, width: r[2] + 24, height: Math.min(h - r[1] + 12, r[3] + 24) }); }
      }
    }
    throw Object.assign(new Error('v5 done'), { done: true });
  }
  if (only === 'v4') {   // Home's exits and the nav: v4-*.png
    const snap = async (name, clip) => { const r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); await writeFile(join(SHOTS, `v4-${name}.png`), Buffer.from(r.result.data, 'base64')); };
    const centre = async sel => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    const move = async ([x, y]) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (const [w, h] of [[1440, 900], [1280, 800]]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await cdp('Page.navigate', { url: `http://localhost:${PORT}/#main` });
      for (let i = 0; i < 60 && !(await ev('!!(window.odyPages && window.odyAccount && document.fonts.status === "loaded")')); i++) await sleep(200);
      await sleep(1800); await move([w / 2, h / 2]); await sleep(300);
      await snap(`home-${w}x${h}`);
      await move(await centre('#page-main .home-rip')); await sleep(700); await snap(`rip-hover-${w}x${h}`, { x: 0, y: 64, width: 360, height: h - 64 });
      await move(await centre('#page-main .home-column')); await sleep(700); await snap(`column-hover-${w}x${h}`, { x: w - 360, y: 64, width: 360, height: h - 64 });
      await move([w / 2, h / 2]); await sleep(400); await snap(`nav-${w}x${h}`, { x: 0, y: 0, width: w, height: 90 });
      await move(await centre('#page-main .home-rip'));
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: (await centre('#page-main .home-rip'))[0], y: (await centre('#page-main .home-rip'))[1], button: 'left', clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: (await centre('#page-main .home-rip'))[0], y: (await centre('#page-main .home-rip'))[1], button: 'left', clickCount: 1 });
      await sleep(300); await snap(`rip-push-mid-${w}x${h}`); await sleep(1500);
      console.log(w, 'after rip click:', await ev('window.odyPages.page()'));
      await ev('window.odyPages.goTo("main")'); await sleep(1600);
      const c = await centre('#page-main .home-column');
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c[0], y: c[1], button: 'left', clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c[0], y: c[1], button: 'left', clickCount: 1 });
      await sleep(1800); console.log(w, 'after column click:', await ev('window.odyPages.page()'));
    }
    throw Object.assign(new Error('v4 done'), { done: true });
  }
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
} catch (e) { if (!e.done) throw e; } finally { chrome.kill(); await live.close(); await rm(profile, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no console errors');
process.exit(0);
