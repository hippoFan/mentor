// The laptop screen for judging: serves the one Ody app (twin.html: the 3D twin as the hero, the caller's phone view,
// the voyage, the conversation and a tester drawer) on http://localhost:8790 (and /twin, a deep link to the same page),
// and streams the call to it over one WebSocket. Local only (127.0.0.1). Each call runs in its own job process, so the server opens with the call and
// closes when it ends; the page reconnects by itself and shows "waiting" in between.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.MENTOR_MONITOR_PORT || 8790);
const APP = new URL('./twin.html', import.meta.url);   // monitor.html is only a redirect for servers started before this
const APP_PATHS = new Set(['/', '/index.html', '/twin', '/twin.html']);

// The 3D twin (/twin) and its files. Each route is a fixed pattern of plain path segments (no dots except the one
// extension), so nothing outside these folders can be named: no traversal, no directory listing.
const TYPES = { js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  wasm: 'application/wasm', task: 'application/octet-stream', ttf: 'font/ttf' };
const STATIC = [
  [/^\/twin\/([a-z0-9-]+\.(?:js|json))$/, m => new URL(`./twin/${m[1]}`, import.meta.url)],
  [/^\/data\/(uno-pins\.json)$/, m => new URL(`./data/${m[1]}`, import.meta.url)],
  [/^\/vendor\/three\/(build\/three\.(?:module|core)\.js|examples\/jsm\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.js)$/,
    m => new URL(`./node_modules/three/${m[1]}`, import.meta.url)],
  // Optional hand control: MediaPipe Tasks Vision (Apache-2.0) and its hand model, all served from this laptop.
  [/^\/vendor\/mediapipe\/(vision_bundle\.mjs|wasm\/vision_wasm_(?:nosimd_)?internal\.(?:js|wasm))$/,
    m => new URL(`./node_modules/@mediapipe/tasks-vision/${m[1]}`, import.meta.url)],
  [/^\/twin\/models\/(hand_landmarker\.task)$/, m => new URL(`./twin/models/${m[1]}`, import.meta.url)],
  [/^\/fonts\/(InterVariable\.ttf)$/, m => new URL(`./fonts/${m[1]}`, import.meta.url)],   // OFL, served locally: no font CDN
];
async function appPage() {   // the page's one inline script is its import map; CSP allows exactly that script by hash
  const html = await readFile(APP, 'utf8');
  const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  const hash = map ? ` 'sha256-${createHash('sha256').update(map[1]).digest('base64')}'` : '';
  return { html, csp: `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'${hash}; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` };
}

const HUB_PORT = Number(process.env.MENTOR_HUB_PORT || 8789);
const TOKEN_FILE = new URL('../logs/hub.token', import.meta.url);

/**
 * Called by each call's job. If the always-on hub (hub.mjs) is running, the call publishes its events to the hub, so
 * the laptop page stays up between calls. Otherwise it falls back to serving the page itself for the call's duration.
 * @returns {Promise<{send: (event: object) => void, close: () => Promise<void>}>} never throws
 */
export async function startLive() {
  try {
    const token = (await readFile(TOKEN_FILE, 'utf8')).trim();
    const ws = await new Promise((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${HUB_PORT}/publish`, { headers: { 'x-ody-token': token } });
      const t = setTimeout(() => { c.terminate(); reject(new Error('hub timeout')); }, 1500);
      c.once('open', () => { clearTimeout(t); resolve(c); });
      c.once('error', e => { clearTimeout(t); reject(e); });
    });
    ws.on('error', () => {});
    console.log('[live] publishing to the always-on hub (laptop page at http://localhost:' + PORT + ')');
    return {
      send(event) { if (ws.readyState === 1) ws.send(JSON.stringify(event)); },
      async close() { try { ws.close(); } catch { /* gone */ } },
    };
  } catch { /* no hub running: serve the page for this call only */ }
  return createLiveServer();
}

/** The laptop page + its WebSocket on 127.0.0.1:PORT. Used by hub.mjs (always on) or by a call when no hub runs. */
export async function createLiveServer() {
  const state = { call: null, step: '', transcript: [], brain: '', turns: [], part: null, scans: [], circuit: null };   // replayed to a page that connects mid-call
  // Only this machine's own page may connect (stops cross-site WebSocket hijacking and DNS rebinding).
  const okHost = h => h === `localhost:${PORT}` || h === `127.0.0.1:${PORT}`;
  const okOrigin = o => o === `http://localhost:${PORT}` || o === `http://127.0.0.1:${PORT}`;
  const server = createServer(async (req, res) => {
    if (!okHost(req.headers.host)) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && APP_PATHS.has(req.url.split('?')[0])) {
      try {
        const { html, csp } = await appPage();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
          'content-security-policy': csp, 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
          'permissions-policy': 'camera=(self), microphone=(), geolocation=()' }).end(html);
      } catch { res.writeHead(404).end(); }
    } else if ((req.method === 'GET' || req.method === 'HEAD') && STATIC.some(([re]) => re.test(req.url))) {
      const [re, file] = STATIC.find(([r]) => r.test(req.url)), m = req.url.match(re);
      try {
        const body = await readFile(file(m));
        res.writeHead(200, { 'content-type': TYPES[m[1].split('.').pop()], 'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }).end(body);
      } catch { res.writeHead(404).end(); }
    } else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({
    server, maxPayload: 4096,   // the page never needs to send anything large
    verifyClient: ({ origin, req }) => okOrigin(origin) && okHost(req.headers.host) && wss.clients.size < 4,
  });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'hello', ...state }));
  });
  // The ws server re-emits the http server's errors; without these listeners a busy port (the previous call's job
  // still holding it) was an uncaught EADDRINUSE that killed the whole call. Now the monitor just sits this call out.
  wss.on('error', () => {});
  server.on('error', () => {});
  const ok = await new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(PORT, '127.0.0.1', () => resolve(true));
  });
  if (!ok) { console.warn(`[live] port ${PORT} busy; monitor off for this call`); return { send() {}, async close() {} }; }
  console.log(`[live] monitor on http://localhost:${PORT}`);

  return {
    send(event) {
      if (event.type === 'call') {
        state.call = event;
        if (event.state === 'live') { state.transcript = []; state.turns = []; state.step = ''; state.scans = []; state.circuit = null; }   // a new call starts clean
      }
      if (event.type === 'step') state.step = event.text;
      if (event.type === 'brain') state.brain = event.brain;
      if (event.type === 'part') state.part = event;
      if (event.type === 'circuit') state.circuit = event;   // the latest project, replayed to a page that connects mid-call
      if (event.type === 'scan') { state.scans.push(event); state.scans = state.scans.slice(-6); }   // ~150 KB each with the photo
      if (event.type === 'interior') { const sc = state.scans.find(x => x.id === event.id); if (sc) sc.interior = event.interior; }   // replayed with its scan
      if (event.type === 'turn') { state.turns.push(event); state.turns = state.turns.slice(-40); }
      if (event.type === 'heard' || event.type === 'say') { state.transcript.push(event); state.transcript = state.transcript.slice(-40); }
      const msg = JSON.stringify(event);
      for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
    },
    async close() {
      for (const c of wss.clients) c.close();
      await new Promise(r => { wss.close(() => server.close(() => r())); setTimeout(r, 1000); });
    },
  };
}
