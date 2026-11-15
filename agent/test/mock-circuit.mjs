// Replays a voice circuit build on the 3D twin, no keys, phone or brain needed:
//   UNO -> "add a distance sensor" -> "add an LED on pin 6" -> "add a servo" -> "remove the LED"
// Every step goes through circuit.mjs (templates, no brain call) and is shown by twin/circuit3d.js on the standalone
// page twin-circuit-demo.html, served here on http://localhost:8798 (127.0.0.1 only; never 8790, never the live hub).
// Headless Chrome (SwiftShader, no window) screenshots each state in both looks:
//   ~/.playwright-mcp/circuit-<n>-<step>-{holo,real}.png
//   node test/mock-circuit.mjs [--serve] [--port 8798] [--model uno-r4-wifi]
//   --serve   only serve the page (with a replay you can watch at /twin-circuit-demo.html?replay) and keep running
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createProject, apply, fastPlan, circuitEvent, steps, markDone } from '../circuit.mjs';

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(opt('--port', 8798)), DEBUG = Number(opt('--debug-port', 9347));
if (PORT === 8790 || PORT === 8789) { console.error('8790/8789 are the live agent and hub; pick another port'); process.exit(2); }
const MODEL = opt('--model', 'uno-r3');
const SHOTS = join(homedir(), '.playwright-mcp');
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- the build ----------
export const SCRIPT = ['add a distance sensor', 'add an LED on pin 6', 'add a servo', 'remove the LED'];
export function replay(board = MODEL) {
  let st = createProject({ board });
  const out = [{ name: 'board', heard: '', ev: circuitEvent(st, { say: "Here's your board. Tell me what to add." }) }];
  for (const heard of SCRIPT) {
    for (const x of steps(st)) st = markDone(st, x.id);   // the caller built everything so far: "next" is the new part's first step
    const plan = fastPlan(st, heard);
    if (!plan) throw new Error(`no template for "${heard}"`);
    const r = apply(st, plan.actions);
    if (!r.changed) throw new Error(`"${heard}" changed nothing: ${r.say}`);
    st = r.state;
    out.push({ name: heard.replace(/^(add|remove) (a|an|the) /, '$1-').replace(/\W+/g, '-').replace(/-+$/, ''), heard, ev: circuitEvent(st, r) });
  }
  return out;
}

// ---------- static server (fixed routes, no traversal) ----------
const ROOT = new URL('..', import.meta.url);
const TYPES = { js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8', ttf: 'font/ttf' };
const ROUTES = [
  [/^\/twin-circuit-demo\.html$/, () => new URL('twin-circuit-demo.html', ROOT)],
  [/^\/twin\/([a-z0-9-]+\.(?:js|json))$/, m => new URL(`twin/${m[1]}`, ROOT)],
  [/^\/data\/(uno-pins\.json)$/, m => new URL(`data/${m[1]}`, ROOT)],
  [/^\/vendor\/three\/(build\/three\.(?:module|core)\.js|examples\/jsm\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.js)$/, m => new URL(`node_modules/three/${m[1]}`, ROOT)],
  [/^\/fonts\/(InterVariable\.ttf)$/, m => new URL(`fonts/${m[1]}`, ROOT)],
];
const states = replay();
const server = createServer(async (req, res) => {
  if (req.headers.host !== `localhost:${PORT}` && req.headers.host !== `127.0.0.1:${PORT}`) { res.writeHead(403).end(); return; }
  const path = req.url.split('?')[0];
  if (path === '/replay.json') { res.writeHead(200, { 'content-type': TYPES.json }).end(JSON.stringify(states)); return; }
  const r = ROUTES.find(([re]) => re.test(path));
  if (!r || req.method !== 'GET') { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(r[1](path.match(r[0])));
    res.writeHead(200, { 'content-type': TYPES[path.split('.').pop()] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(PORT, '127.0.0.1', ok); });
console.log(`[mock-circuit] http://localhost:${PORT}/twin-circuit-demo.html`);
if (args.includes('--serve')) { console.log('[mock-circuit] serving; Ctrl-C to stop'); await new Promise(() => {}); }

// ---------- headless Chrome ----------
await mkdir(SHOTS, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'mock-circuit-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const shots = [];
let failed = false;
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json(); } catch { await sleep(200); } }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  let id = 0; const wait = new Map(); const errors = [];
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || 'exception'); });
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return r.result?.result?.value; };
  const until = async (expr, tries = 80, ms = 250) => { for (let i = 0; i < tries; i++) { const v = await evalJs(expr).catch(() => null); if (v) return v; await sleep(ms); } return null; };
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://localhost:${PORT}/twin-circuit-demo.html?model=${MODEL}${opt('--q', '') ? `&${opt('--q', '')}` : ''}` });
  if (!await until('window.circuitDemo?.ready', 120)) throw new Error(`page never ready: ${errors.join(' | ').slice(0, 600)}`);
  const settle = async () => { await sleep(900); await until('!window.circuitDemo.stats().drawing && !window.circuitDemo.stats().leaving', 80, 250); await sleep(1400); };
  for (const [i, s] of states.entries()) {
    await evalJs(`window.circuitDemo.apply(${JSON.stringify(s.ev)}, ${JSON.stringify(s.heard)})`);
    for (const look of ['holo', 'real']) {
      await evalJs(`window.circuitDemo.setLook(${look === 'holo'})`);
      await settle();
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      const p = join(SHOTS, `circuit-${i}-${s.name}-${look}.png`);
      await writeFile(p, Buffer.from(shot.result.data, 'base64')); shots.push(p);
    }
    const st = await evalJs('window.circuitDemo.stats()');
    console.log(`[mock-circuit] ${i} ${s.heard || '(board)'}: ${st.parts} parts, ${st.wires} wires, ${st.meshes} meshes | ${s.ev.say}`);
  }
  if (errors.length) { failed = true; console.log(`[mock-circuit] page errors: ${errors.join(' | ').slice(0, 800)}`); }
  ws.close();
} catch (e) { failed = true; console.error(`[mock-circuit] ${e.message}`); }
finally {
  chrome.kill(); server.close();
  await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
for (const p of shots) console.log(`      ${p}`);
process.exitCode = failed ? 1 : 0;
