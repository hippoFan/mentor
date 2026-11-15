// Tiny mock for test/motion-demo.html on http://127.0.0.1:8799 with the app's strict self-only CSP.
// Routes mirror live.mjs's STATIC entries for /vendor/gsap, /vendor/rough*, /vendor/perfect-freehand, /twin, /fonts.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = Number(process.env.MOTION_DEMO_PORT || 8799);
const u = p => new URL(p, import.meta.url);
const TYPES = { js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', html: 'text/html; charset=utf-8', ttf: 'font/ttf', otf: 'font/otf', woff2: 'font/woff2' };
const ROUTES = [
  [/^\/(?:\?.*)?$/, () => u('./motion-demo.html')],
  [/^\/test\/(motion-demo\.js)$/, m => u(`./${m[1]}`)],
  [/^\/twin\/([a-z0-9-]+\.(?:js|css))$/, m => u(`../twin/${m[1]}`)],
  [/^\/twin\/paper\/([a-z0-9-]+\.svg)$/, m => u(`../twin/paper/${m[1]}`)],
  [/^\/fonts\/(GFSTheokritos\.otf|CinzelDecorative-(?:Regular|Bold)\.ttf|CooperHewitt-[456]00\.woff2)$/, m => u(`../fonts/${m[1]}`)],
  [/^\/vendor\/gsap\/((?:utils\/)?[A-Za-z0-9-]+\.js)$/, m => u(`../node_modules/gsap/${m[1]}`)],
  [/^\/vendor\/rough\/(rough\.esm\.js)$/, m => u(`../node_modules/roughjs/bundled/${m[1]}`)],
  [/^\/vendor\/rough-notation\/(rough-notation\.esm\.js)$/, m => u(`../node_modules/rough-notation/lib/${m[1]}`)],
  [/^\/vendor\/perfect-freehand\/(index\.mjs)$/, m => u(`../node_modules/perfect-freehand/dist/esm/${m[1]}`)],
];
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
createServer(async (req, res) => {
  for (const [re, f] of ROUTES) {
    const m = req.url.match(re);
    if (!m) continue;
    try {
      const file = f(m), ext = file.pathname.split('.').pop();
      res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'content-security-policy': CSP, 'cache-control': 'no-cache' })
        .end(await readFile(file));
    } catch { res.writeHead(404).end(); }
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`[motion-demo] http://127.0.0.1:${PORT}/`));
