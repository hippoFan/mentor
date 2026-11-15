// The Forge on its own, without the three-page shell, keys or a call: serves test/forge-harness.html (which mounts
// twin/forge.js) plus the REAL /argos/ routes (argos/server.mjs) and one page WebSocket, the same way live.mjs does
// (127.0.0.1 only, Host checked, Origin checked for writes and the socket, the page CSP with the import-map hash).
// Designs go to a scratch folder, never the real designs/ store. Ports 8798/8799 only (never the live 8789/8790).
//   node test/mock-forge.mjs [--port 8798] [--seed]      then open http://localhost:8798/
//   stdin commands while it runs: scan | circuit | import | quit
// In a test: const m = await startMockForge({ port: 8798 }); m.argos.onPublished({type:'scan', ...}); await m.close();
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const AGENT = new URL('../', import.meta.url);
const PREVIEW = new URL('../../../teammate-notes/design/preview/', import.meta.url);   // design kit (fonts, sprite) until the shell ships its own
const TYPES = { js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8', svg: 'image/svg+xml', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', jpg: 'image/jpeg', html: 'text/html; charset=utf-8' };
const first = (...urls) => urls.find(u => existsSync(fileURLToPath(u)));
// Fixed patterns only (no dots except the extension): nothing outside these folders can be named.
const STATIC = [
  [/^\/twin\/([a-z0-9-]+\.(?:js|json|css|svg))$/, m => new URL(`twin/${m[1]}`, AGENT)],
  [/^\/test\/(forge-harness\.js)$/, m => new URL(`test/${m[1]}`, AGENT)],
  [/^\/vendor\/three\/(build\/three\.(?:module|core)\.js|examples\/jsm\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*\.js)$/, m => new URL(`node_modules/three/${m[1]}`, AGENT)],
  [/^\/fonts\/([A-Za-z0-9-]+\.(?:woff2|ttf|otf))$/, m => first(new URL(`fonts/${m[1]}`, AGENT), new URL(`fonts/${m[1]}`, PREVIEW)) || new URL(`fonts/${m[1]}`, AGENT)],
  [/^\/design\/(ornaments\.(?:svg|css))$/, m => first(new URL(`twin/${m[1]}`, AGENT), new URL(m[1], PREVIEW)) || new URL(m[1], PREVIEW)],
];
const HTML = new URL('test/forge-harness.html', AGENT);

/** A small scan like the brain returns for "scan this" (a desk lamp: base, arm, shade). */
export const LAMP = { name: 'Desk lamp', category: 'lighting', dims_mm: { w: 120, d: 120, h: 210 }, confidence: 0.7, parts: [
  { name: 'Base', shape: 'cylinder', size_mm: { x: 120, y: 120, z: 18 }, position_mm: { x: 0, y: 0, z: 9 }, rotation_deg: { x: 0, y: 0, z: 0 }, color: '#2b2b30', material: 'metal', label: '' },
  { name: 'Arm', shape: 'cylinder', size_mm: { x: 14, y: 14, z: 150 }, position_mm: { x: 0, y: 0, z: 93 }, rotation_deg: { x: 0, y: 12, z: 0 }, color: '#c9ccd2', material: 'metal', label: '' },
  { name: 'Shade', shape: 'cone', size_mm: { x: 90, y: 90, z: 60 }, position_mm: { x: 18, y: 0, z: 180 }, rotation_deg: { x: 0, y: 180, z: 0 }, color: '#ea872f', material: 'plastic', label: '' }] };

/** A small photo for a mock scan (base64 JPEG), cut from the film's desk shot when it exists. */
export async function mockPhoto() {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const src = fileURLToPath(new URL('../../mentor-film/assets/uno-desk.jpg', AGENT));
    const c = createCanvas(480, 320), g = c.getContext('2d');
    if (existsSync(src)) { const img = await loadImage(await readFile(src)); g.drawImage(img, 300, 200, 1800, 1200, 0, 0, 480, 320); }
    else { g.fillStyle = '#3a3026'; g.fillRect(0, 0, 480, 320); g.fillStyle = '#ea872f'; g.beginPath(); g.arc(240, 160, 70, 0, 7); g.fill(); }
    return (await c.encode('jpeg', 80)).toString('base64');
  } catch { return ''; }
}

/** Tiny valid test meshes: a binary STL tetrahedron, an OBJ cube, a GLB triangle pyramid. */
export function tinyFiles() {
  const tris = [[[0, 0, 0], [20, 0, 0], [0, 20, 0]], [[0, 0, 0], [0, 20, 0], [0, 0, 20]], [[0, 0, 0], [0, 0, 20], [20, 0, 0]], [[20, 0, 0], [0, 0, 20], [0, 20, 0]]];
  const stl = Buffer.alloc(84 + tris.length * 50); stl.write('ody test tetrahedron', 0); stl.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => { let o = 84 + i * 50 + 12; for (const v of t) for (const c of v) { stl.writeFloatLE(c, o); o += 4; } });
  const obj = Buffer.from(['# ody test cube', 'v -10 -10 -10', 'v 10 -10 -10', 'v 10 10 -10', 'v -10 10 -10', 'v -10 -10 10', 'v 10 -10 10', 'v 10 10 10', 'v -10 10 10',
    'f 1 3 2', 'f 1 4 3', 'f 5 6 7', 'f 5 7 8', 'f 1 2 6', 'f 1 6 5', 'f 2 3 7', 'f 2 7 6', 'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8', ''].join('\n'));
  // GLB: one mesh, 4 vertices / 4 faces, positions + indices in one buffer
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 0, 0.9, 0.5, 0.8, 0.3]), idx = new Uint16Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const gltf = { asset: { version: '2.0', generator: 'ody-test' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Pyramid' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.85, 0.55, 0.2, 1], metallicFactor: 0.2, roughnessFactor: 0.6 } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 0.8, 0.9] }, { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' }] };
  let js = Buffer.from(JSON.stringify(gltf)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const bn = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bn.length, 8);
  const ch = (buf, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.write(type, 4); return Buffer.concat([h, buf]); };
  const glb = Buffer.concat([head, ch(js, 'JSON'), ch(bn, 'BIN\0')]);
  return { stl, obj, glb };
}

/** A circuit event like agent.mjs sends (only the fields The Forge reads). */
export const CIRCUIT = { type: 'circuit', rev: 3, state: { board: 'uno-r4-wifi', components: [{ id: 'sonar1', part: 'hc-sr04' }, { id: 'led1', part: 'led-5mm' }] },
  sketch: '// Ody circuit: distance sensor + LED\nconst int TRIG = 9, ECHO = 10, LED = 6;\nvoid setup() { pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT); pinMode(LED, OUTPUT); }\nvoid loop() { digitalWrite(LED, HIGH); delay(500); digitalWrite(LED, LOW); delay(500); }\n',
  say: 'Added a distance sensor.' };

/**
 * @param {{port?: number, dir?: string}} [opts] dir: the design store (default: a new scratch folder, removed on close)
 * @returns {Promise<{base: string, argos: object, send: (e: object) => void, close: () => Promise<void>, dir: string}>}
 */
export async function startMockForge({ port = 8798, dir } = {}) {
  if (![8798, 8799].includes(port)) throw new Error('mock-forge uses ports 8798/8799 only');
  const scratch = !dir;
  dir ||= await mkdtemp(join(tmpdir(), 'forge-'));
  process.env.ARGOS_DESIGNS_DIR = dir;
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ARGOS_OPENAI_KEY', 'ELEVENLABS_API_KEY']) delete process.env[k];
  const { createArgos } = await import(pathToFileURL(fileURLToPath(new URL('argos/server.mjs', AGENT))).href);

  const okHost = h => h === `localhost:${port}` || h === `127.0.0.1:${port}`;
  const okOrigin = o => o === `http://localhost:${port}` || o === `http://127.0.0.1:${port}`;
  const hello = { type: 'hello', call: null, step: '', transcript: [], brain: '', turns: [], part: null, scans: [], circuit: null, consent: null };
  let argos;
  const server = createServer(async (req, res) => {
    if (!okHost(req.headers.host)) { res.writeHead(403).end(); return; }
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && (path === '/' || path === '/forge-harness.html')) {
      const html = await readFile(HTML, 'utf8');
      const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
      const hash = map ? ` 'sha256-${createHash('sha256').update(map[1]).digest('base64')}'` : '';
      res.writeHead(200, { 'content-type': TYPES.html, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'${hash}; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` }).end(html);
    } else if ((req.method === 'GET' || req.method === 'HEAD') && STATIC.some(([re]) => re.test(path))) {
      const [re, file] = STATIC.find(([r]) => r.test(path)), m = path.match(re);
      try { res.writeHead(200, { 'content-type': TYPES[m[1].split('.').pop()], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }).end(await readFile(file(m))); }
      catch { res.writeHead(404).end(); }
    } else if (path.startsWith('/argos/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && !okOrigin(req.headers.origin)) { res.writeHead(403).end(); return; }
      try { await argos.route(req, res); } catch { if (!res.headersSent) res.writeHead(500).end(); }
    } else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, maxPayload: 32 * 1024, verifyClient: ({ origin, req }) => okOrigin(origin) && okHost(req.headers.host) });
  wss.on('connection', ws => { ws.send(JSON.stringify(hello)); ws.on('error', () => {}); });
  const send = e => {
    if (e.type === 'circuit') hello.circuit = e;
    if (e.type === 'call') hello.call = e;
    const msg = JSON.stringify(e);
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };
  argos = createArgos({ send });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  return {
    base: `http://localhost:${port}`, argos, send, dir,
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise(r => { wss.close(() => server.close(() => r())); setTimeout(r, 1000); });
      if (scratch) await rm(dir, { recursive: true, force: true });
    },
  };
}

// ---------- CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const m = await startMockForge({ port: Number(opt('--port', 8798)) });
  const photo = await mockPhoto();
  const scan = () => m.argos.onPublished({ type: 'scan', spec: LAMP, photo });
  const importAll = async () => {
    const f = tinyFiles();
    for (const [name, body] of [['bracket.stl', f.stl], ['cube.obj', f.obj], ['pyramid.glb', f.glb]]) {
      const r = await fetch(`${m.base}/argos/import?name=${name}`, { method: 'POST', headers: { origin: m.base, 'content-type': 'application/octet-stream' }, body });
      console.log(`[mock-forge] import ${name}: ${r.status}`);
    }
  };
  if (args.includes('--seed')) { scan(); await importAll(); m.send(CIRCUIT); }
  console.log(`[mock-forge] The Forge on ${m.base}/  (designs in ${m.dir}; type scan | circuit | import | quit)`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async line => {
    const c = line.trim();
    if (c === 'scan') scan();
    else if (c === 'circuit') m.send({ ...CIRCUIT, rev: Date.now() });
    else if (c === 'import') await importAll();
    else if (c === 'quit') { await m.close(); process.exit(0); }
  });
  const stop = async () => { await m.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
