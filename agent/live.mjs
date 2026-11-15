// The laptop screen for judging: serves monitor.html on http://localhost:8790 and streams the call to it over a
// WebSocket. Local only (127.0.0.1). Each call runs in its own job process, so the server opens with the call and
// closes when it ends; the page reconnects by itself and shows "waiting" in between.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MENTOR_MONITOR_PORT || 8790);
const PAGE = new URL('./monitor.html', import.meta.url);

/** @returns {Promise<{send: (event: object) => void, close: () => Promise<void>}>} never throws; a no-op if the port is busy */
export async function startLive() {
  const state = { call: null, step: '', transcript: [], brain: '', turns: [] };   // replayed to a page that connects mid-call
  // Only this machine's own page may connect (stops cross-site WebSocket hijacking and DNS rebinding).
  const okHost = h => h === `localhost:${PORT}` || h === `127.0.0.1:${PORT}`;
  const okOrigin = o => o === `http://localhost:${PORT}` || o === `http://127.0.0.1:${PORT}`;
  const server = createServer(async (req, res) => {
    if (!okHost(req.headers.host)) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer' }).end(await readFile(PAGE));
    } else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({
    server, maxPayload: 4096,   // the page never needs to send anything large
    verifyClient: ({ origin, req }) => okOrigin(origin) && okHost(req.headers.host) && wss.clients.size < 4,
  });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'hello', ...state }));
  });
  const ok = await new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(PORT, '127.0.0.1', () => resolve(true));
  });
  if (!ok) { console.warn(`[live] port ${PORT} busy; monitor off for this call`); return { send() {}, async close() {} }; }
  console.log(`[live] monitor on http://localhost:${PORT}`);

  return {
    send(event) {
      if (event.type === 'call') state.call = event;
      if (event.type === 'step') state.step = event.text;
      if (event.type === 'brain') state.brain = event.brain;
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
