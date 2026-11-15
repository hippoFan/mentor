// The always-on laptop page: keeps http://localhost:8790 (call view) and /twin (3D twin) up between calls, and relays
// each call's events to them. Calls publish to ws://127.0.0.1:8789/publish with a random token that only this user can
// read (logs/hub.token, mode 600). Started by demo.sh; or run it alone: node hub.mjs
import './env.mjs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { createLiveServer } from './live.mjs';

const HUB_PORT = Number(process.env.MENTOR_HUB_PORT || 8789);
const token = randomBytes(24).toString('hex');
await mkdir(new URL('../logs/', import.meta.url), { recursive: true });
await writeFile(new URL('../logs/hub.token', import.meta.url), token + '\n', { mode: 0o600 });

// Page -> agent: the laptop page's validated, rate-limited messages (parts on the stage, "analyze this combination")
// go to the call that is publishing right now, and only to it.
let publisher = null;
const live = await createLiveServer({
  onPageMessage: msg => { if (publisher?.readyState === 1) publisher.send(JSON.stringify(msg)); },
});
const server = createServer((req, res) => res.writeHead(404).end());
const pub = new WebSocketServer({
  server, path: '/publish', maxPayload: 4 * 1024 * 1024,   // frames + scan photos
  verifyClient: ({ req }) => req.headers['x-ody-token'] === token && !req.headers.origin,   // only local processes, never a browser
});
pub.on('error', () => {}); server.on('error', e => { console.error('[hub] publish port error', e.message); process.exit(1); });
pub.on('connection', ws => {
  console.log('[hub] a call connected');
  publisher = ws;   // one call at a time on a line; the newest publisher gets the page's messages
  ws.on('message', data => { try { live.send(JSON.parse(String(data))); } catch { /* ignore junk */ } });
  ws.on('close', () => { if (publisher === ws) publisher = null; console.log('[hub] call disconnected'); live.send({ type: 'call', state: 'ended' }); });
  ws.on('error', () => {});
});
server.listen(HUB_PORT, '127.0.0.1', () => console.log(`[hub] laptop page always on; calls publish to 127.0.0.1:${HUB_PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await live.close(); process.exit(0); });
