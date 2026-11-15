// Serves recap pages from ../runs on localhost so a tunnel (cloudflared) can share them:
//   node serve-recaps.mjs   then   cloudflared tunnel --url http://localhost:8787
// Read-only, GET only, no directory listings; run folders have random names so links are unguessable.
import './env.mjs';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../runs/', import.meta.url));
const PORT = Number(process.env.RECAP_PORT || 8787);
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
// The Wokwi project files are served by exact name only, as downloads: other .json files in a run folder
// (recap.json, conversation.json with camera frames and transcripts) must never be served.
const DOWNLOADS = { 'sketch.ino': 'text/plain; charset=utf-8', 'diagram.json': 'application/json; charset=utf-8' };

createServer(async (req, res) => {
  try { await handle(req, res); } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
}).listen(PORT, '127.0.0.1', () => console.log(`[recaps] http://localhost:${PORT}/<run>/`));

async function handle(req, res) {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  const name = basename(file), download = Object.hasOwn(DOWNLOADS, name) ? DOWNLOADS[name] : null;
  const type = download || (Object.hasOwn(TYPES, extname(file)) ? TYPES[extname(file)] : null);
  if (!file.startsWith(ROOT) || !type || file.split(sep).some(p => p.startsWith('.'))) { res.writeHead(404).end(); return; }
  try {
    const st = await stat(file);
    if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) { res.writeHead(410).end('This recap has expired.'); return; }   // links live 24 h
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': type, ...(download ? { 'content-disposition': `attachment; filename="${name}"` } : {}), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" }).end(body);
  } catch { res.writeHead(404).end(); }
}
