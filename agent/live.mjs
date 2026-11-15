// The laptop screen for judging: serves the one Ody app (twin.html: the 3D twin as the hero, the caller's phone view,
// the voyage, the conversation and a tester drawer) on http://localhost:8790 (and /twin, a deep link to the same page),
// and streams the call to it over one WebSocket. Local only (127.0.0.1). Each call runs in its own job process, so the server opens with the call and
// closes when it ends; the page reconnects by itself and shows "waiting" in between.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { EDIT, hasChange, sanitizeChange } from './modify.mjs';

const PORT = Number(process.env.MENTOR_MONITOR_PORT || 8790);
const APP = new URL('./twin.html', import.meta.url);   // monitor.html is only a redirect for servers started before this
const APP_PATHS = new Set(['/', '/index.html', '/twin', '/twin.html']);

// The 3D twin (/twin) and its files. Each route is a fixed pattern of plain path segments (no dots except the one
// extension), so nothing outside these folders can be named: no traversal, no directory listing.
const TYPES = { js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  wasm: 'application/wasm', task: 'application/octet-stream', tflite: 'application/octet-stream', ttf: 'font/ttf' };
const STATIC = [
  [/^\/twin\/([a-z0-9-]+\.(?:js|json))$/, m => new URL(`./twin/${m[1]}`, import.meta.url)],
  [/^\/data\/(uno-pins\.json)$/, m => new URL(`./data/${m[1]}`, import.meta.url)],
  [/^\/vendor\/three\/(build\/three\.(?:module|core)\.js|examples\/jsm\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.js)$/,
    m => new URL(`./node_modules/three/${m[1]}`, import.meta.url)],
  // Optional hand control: MediaPipe Tasks Vision (Apache-2.0) and its hand model, all served from this laptop.
  [/^\/vendor\/mediapipe\/(vision_bundle\.mjs|wasm\/vision_wasm_(?:nosimd_)?internal\.(?:js|wasm))$/,
    m => new URL(`./node_modules/@mediapipe/tasks-vision/${m[1]}`, import.meta.url)],
  [/^\/twin\/models\/(hand_landmarker\.task|magic_touch\.tflite)$/, m => new URL(`./twin/models/${m[1]}`, import.meta.url)],
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
const PRIVACY = new URL('../PRIVACY.md', import.meta.url);

// ---------- page -> agent channel ----------
// The laptop page may send two kinds of message (everything else is dropped):
//   {type:'parts', scope, board, parts:[{id, name}]}                 what is on the 3D stage (so voice can target parts)
//   {type:'analyze', scope, board, kept:[{id, name}], removed:[{id, name}], modified?:[{id, name, change}]}
//                                                                    the user removed / modified parts and combined the rest
// Strict schema: known keys only, strings capped and stripped of control/bidi characters, at most 200 parts per list.
export const PAGE = { maxParts: 200, maxModified: EDIT.maxMods, nameLen: 60, idLen: 60, boardLen: 60, maxPayload: 32 * 1024, analyzeMs: 5000, partsPerSec: 4 };
export const PAGE_SCOPES = ['board', 'scan', 'circuit'];
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff<>]/g;
/** A page-supplied string: control, zero-width and bidi characters out, whitespace collapsed, capped. '' if not a string. */
export const pageText = (v, n) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v).replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
const plain = o => o !== null && typeof o === 'object' && !Array.isArray(o);
function pageParts(list) {
  if (!Array.isArray(list) || list.length > PAGE.maxParts) return null;
  const out = [];
  for (const p of list) {
    if (!plain(p)) return null;
    const name = pageText(p.name, PAGE.nameLen), id = pageText(p.id, PAGE.idLen) || name;
    if (!name) continue;   // a part with no name can't be spoken about
    out.push({ id, name });
  }
  return out;
}
/** modified:[{id, name, change}]: same caps as parts, at most 50; each change cleaned like a voice edit (modify.mjs). */
function pageModified(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > PAGE.maxModified) return null;
  const out = [];
  for (const p of list) {
    if (!plain(p) || (p.change !== undefined && !plain(p.change))) return null;
    const name = pageText(p.name, PAGE.nameLen), id = pageText(p.id, PAGE.idLen) || name;
    const change = sanitizeChange(p.change);
    if (!name || !hasChange(change)) continue;   // nothing to judge
    out.push({ id, name, change });
  }
  return out;
}
/**
 * Validates one message from the laptop page. Never throws.
 * @param {string | Buffer | object} data raw WebSocket data (or an already parsed object)
 * @returns {{type: 'parts', scope: string, board: string, parts: {id: string, name: string}[]}
 *   | {type: 'analyze', scope: string, board: string, kept: {id: string, name: string}[], removed: {id: string, name: string}[],
 *      modified?: {id: string, name: string, change: object}[]} | null}   modified only when the page sent some
 */
export function validatePageMessage(data) {
  let m = data;
  if (typeof data === 'string' || Buffer.isBuffer(data)) {
    if (data.length > PAGE.maxPayload) return null;
    try { m = JSON.parse(String(data)); } catch { return null; }
  }
  if (!plain(m) || !PAGE_SCOPES.includes(m.scope)) return null;
  const board = pageText(m.board, PAGE.boardLen);
  if (m.board !== undefined && typeof m.board !== 'string') return null;
  if (m.type === 'parts') {
    const parts = pageParts(m.parts);
    return parts ? { type: 'parts', scope: m.scope, board, parts } : null;
  }
  if (m.type === 'analyze') {
    const kept = pageParts(m.kept), removed = pageParts(m.removed), modified = pageModified(m.modified);
    if (!kept || !removed || !modified || kept.length + removed.length > PAGE.maxParts || !removed.length && !kept.length) return null;
    return { type: 'analyze', scope: m.scope, board, kept, removed, ...(modified.length ? { modified } : {}) };
  }
  return null;
}
/** Rate limit for page messages (shared by every page socket): analyze <= 1 per 5 s, parts <= 4 per second. */
export function createPageRateLimiter({ analyzeMs = PAGE.analyzeMs, partsPerSec = PAGE.partsPerSec } = {}) {
  let lastAnalyze = -Infinity;
  const recent = [];
  return {
    allow(type, now = Date.now()) {
      if (type === 'analyze') { if (now - lastAnalyze < analyzeMs) return false; lastAnalyze = now; return true; }
      if (type === 'parts') {
        while (recent.length && now - recent[0] >= 1000) recent.shift();
        if (recent.length >= partsPerSec) return false;
        recent.push(now); return true;
      }
      return false;
    },
  };
}

// ---------- /privacy: PRIVACY.md as a small, fully escaped page ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Inline markdown on already-escaped text: **bold**, *italic*, `code`. No links, no raw HTML. */
const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>');
/** The small subset of Markdown PRIVACY.md uses (headings, paragraphs, "- " lists, pipe tables), escaped. */
export function renderPrivacy(md) {
  const lines = String(md).replace(/\r/g, '').split('\n'), out = [];
  let para = [], list = null, table = null;
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
    if (list) { out.push(`<ul>${list.map(l => `<li>${inline(l)}</li>`).join('')}</ul>`); list = null; }
    if (table) {
      const rows = table.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map(r => r.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim()));
      const [head, ...body] = rows;
      out.push(`<table><thead><tr>${(head || []).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      table = null;
    }
  };
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*\|/.test(line)) { if (para.length || list) { const t = table; table = null; flush(); table = t; } (table ||= []).push(line); continue; }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (para.length || table) flush(); (list ||= []).push(li[1]); continue; }
    if (!line.trim()) { flush(); continue; }
    if (list && /^\s+/.test(line)) { list[list.length - 1] += ` ${line.trim()}`; continue; }
    if (list || table) flush();
    para.push(line.trim());
  }
  flush();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ody privacy notice</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#f5f5f7;--muted:#a1a1a6;--line:#38383d}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 12px}h2{font-size:20px;margin:32px 0 8px}
p,li{color:var(--fg)}em{color:var(--muted)}table{border-collapse:collapse;width:100%;font-size:14px;display:block;overflow-x:auto}
th,td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}code{font:13px ui-monospace,monospace}
</style></head><body><main>${out.join('\n')}</main></body></html>`;
}
const PRIVACY_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Called by each call's job. If the always-on hub (hub.mjs) is running, the call publishes its events to the hub, so
 * the laptop page stays up between calls. Otherwise it falls back to serving the page itself for the call's duration.
 * @returns {Promise<{send: (event: object) => void, onPage: (fn: (msg: object) => void) => () => void, close: () => Promise<void>}>}
 *   never throws. onPage(fn): validated page -> agent messages (see validatePageMessage), on either path.
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
    // Page -> agent messages the hub forwards (it has validated and rate-limited them already; checked again here).
    const listeners = new Set();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const m = validatePageMessage(data);
      if (m) for (const fn of listeners) { try { fn(m); } catch (e) { console.warn('[live] page handler failed', e?.message || e); } }
    });
    console.log('[live] publishing to the always-on hub (laptop page at http://localhost:' + PORT + ')');
    return {
      send(event) { if (ws.readyState === 1) ws.send(JSON.stringify(event)); },
      onPage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async close() { try { ws.close(); } catch { /* gone */ } },
    };
  } catch { /* no hub running: serve the page for this call only */ }
  return createLiveServer();
}

/**
 * The laptop page + its WebSocket on 127.0.0.1:PORT. Used by hub.mjs (always on) or by a call when no hub runs.
 * @param {{onPageMessage?: (msg: object) => void}} [opts] called with each valid, rate-limited page message
 */
export async function createLiveServer(opts = {}) {
  const state = { call: null, step: '', transcript: [], brain: '', turns: [], part: null, scans: [], circuit: null, analysis: null, consent: null, modifications: [], checklist: null };
  const listeners = new Set(opts.onPageMessage ? [opts.onPageMessage] : []);
  const limit = createPageRateLimiter();   // one budget for all page sockets: analyze costs a brain call   // replayed to a page that connects mid-call
  // Only this machine's own page may connect (stops cross-site WebSocket hijacking and DNS rebinding).
  const okHost = h => h === `localhost:${PORT}` || h === `127.0.0.1:${PORT}`;
  const okOrigin = o => o === `http://localhost:${PORT}` || o === `http://127.0.0.1:${PORT}`;
  const server = createServer(async (req, res) => {
    if (!okHost(req.headers.host)) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && req.url.split('?')[0] === '/privacy') {
      try {
        const html = renderPrivacy(await readFile(PRIVACY, 'utf8'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
          'content-security-policy': PRIVACY_CSP, 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
          'permissions-policy': 'camera=(), microphone=(), geolocation=()' }).end(html);
      } catch { res.writeHead(404).end(); }
    } else if (req.method === 'GET' && APP_PATHS.has(req.url.split('?')[0])) {
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
    server, maxPayload: PAGE.maxPayload,   // the page sends only part lists (<= 200 short names)
    verifyClient: ({ origin, req }) => okOrigin(origin) && okHost(req.headers.host) && wss.clients.size < 4,
  });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'hello', ...state }));
    // Only sockets that passed verifyClient (this machine's own page: Origin + Host checked) get here.
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const m = validatePageMessage(data);
      if (!m || !limit.allow(m.type)) return;
      for (const fn of listeners) { try { fn(m); } catch (e) { console.warn('[live] page handler failed', e?.message || e); } }
    });
    ws.on('error', () => {});
  });
  // The ws server re-emits the http server's errors; without these listeners a busy port (the previous call's job
  // still holding it) was an uncaught EADDRINUSE that killed the whole call. Now the monitor just sits this call out.
  wss.on('error', () => {});
  server.on('error', () => {});
  const ok = await new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(PORT, '127.0.0.1', () => resolve(true));
  });
  if (!ok) { console.warn(`[live] port ${PORT} busy; monitor off for this call`); return { send() {}, onPage() { return () => {}; }, async close() {} }; }
  console.log(`[live] monitor on http://localhost:${PORT}`);

  return {
    send(event) {
      if (event.type === 'call') {
        state.call = event;
        if (event.state === 'live') { state.transcript = []; state.turns = []; state.step = ''; state.scans = []; state.circuit = null; state.analysis = null; state.consent = null; state.modifications = []; state.checklist = null; }   // a new call starts clean
      }
      if (event.type === 'step') state.step = event.text;
      if (event.type === 'brain') state.brain = event.brain;
      if (event.type === 'part') state.part = event;
      if (event.type === 'circuit') state.circuit = event;   // the latest project, replayed to a page that connects mid-call
      if (event.type === 'scan') { state.scans.push(event); state.scans = state.scans.slice(-6); state.modifications = state.modifications.filter(x => x.scope !== 'scan'); }   // ~150 KB each with the photo; a new scan has no edits yet
      // Voice edits (modify.mjs): the latest cumulative edit per part, replayed in order; a revert drops that part's edit.
      if (event.type === 'modify' && event.target) {
        const key = x => `${x.scope}:${x.target?.id}`;
        state.modifications = state.modifications.filter(x => key(x) !== key(event));
        if (!event.revert) state.modifications = [...state.modifications, event].slice(-EDIT.maxMods);
      }
      if (event.type === 'checklist') state.checklist = event;   // the whole parts list each time
      if (event.type === 'scan-depth') { const sc = state.scans.find(x => x.id === event.id); if (sc) sc.depth = { depth: event.depth, width: event.width, height: event.height, near: event.near, far: event.far }; }   // replayed with its scan (<= ~20 KB PNG)
      if (event.type === 'interior') { const sc = state.scans.find(x => x.id === event.id); if (sc) sc.interior = event.interior; }   // replayed with its scan
      if (event.type === 'analysis') state.analysis = event;
      if (event.type === 'consent') state.consent = event;
      if (event.type === 'turn') { state.turns.push(event); state.turns = state.turns.slice(-40); }
      if (event.type === 'heard' || event.type === 'say') { state.transcript.push(event); state.transcript = state.transcript.slice(-40); }
      const msg = JSON.stringify(event);
      for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
    },
    onPage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async close() {
      for (const c of wss.clients) c.close();
      await new Promise(r => { wss.close(() => server.close(() => r())); setTimeout(r, 1000); });
    },
  };
}
