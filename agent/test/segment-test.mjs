// Scan cut-out test: the Interactive Segmenter (twin/segment.js) vs the old border flood fill (twin/scan.js floodMask)
// on real scan crops, in headless Chrome against the real live.mjs server (mock port, never 8790). Writes each photo's
// masks side by side (photo | segmenter | flood) to --shots, prints timing and IoU(segmenter, flood).
//   node test/segment-test.mjs [--port 8797] [--shots <dir>] <run dir with scan-NN.jpg + scan-NN.json> ...
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('--port', 8797));
if (PORT === 8790) throw new Error('8790 is the live agent');
const SHOTS = resolve(opt('--shots', join(homedir(), '.playwright-mcp')));
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const dirs = args.filter((a, i) => !a.startsWith('--') && !['--port', '--shots'].includes(args[i - 1]));

/** The crop rect cropJpeg (scan.mjs) made around a bbox: 3% margin each side, clamped. */
const cropOf = ([x0, y0, x1, y1]) => { const px = (x1 - x0) * 0.03, py = (y1 - y0) * 0.03; return [Math.max(0, x0 - px), Math.max(0, y0 - py), Math.min(1, x1 + px), Math.min(1, y1 + py)]; };
const cases = [];
for (const d of dirs) for (const f of (await readdir(d)).filter(f => /^scan-\d+\.jpg$/.test(f)).sort()) {
  const json = join(d, f.replace('.jpg', '.json'));
  if (!existsSync(json)) continue;
  const spec = JSON.parse(await readFile(json, 'utf8')), crop = cropOf(spec.bbox), [cx0, cy0, cx1, cy1] = crop;
  const box = [(spec.bbox[0] - cx0) / (cx1 - cx0), (spec.bbox[1] - cy0) / (cy1 - cy0), (spec.bbox[2] - cx0) / (cx1 - cx0), (spec.bbox[3] - cy0) / (cy1 - cy0)];
  cases.push({ name: `${d.split('/').filter(Boolean).pop().slice(-6)}-${f.replace('.jpg', '')}`, what: spec.name, box, photo: (await readFile(join(d, f))).toString('base64') });
}
if (!cases.length) { console.log('usage: node test/segment-test.mjs <run dir> ...'); process.exit(2); }

process.env.MENTOR_MONITOR_PORT = String(PORT);
const { createLiveServer } = await import('../live.mjs');
const live = await createLiveServer();
await mkdir(SHOTS, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'seg-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9337', `--user-data-dir=${profile}`, '--no-first-run',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch('http://127.0.0.1:9337/json')).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  let id = 0; const wait = new Map();
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } if (d.method === 'Runtime.consoleAPICalled' && d.params.type !== 'log') console.log('[page]', d.params.args.map(a => a.value ?? a.description).join(' ')); });
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600)); return r.result?.result?.value; };
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: `http://localhost:${PORT}/twin` });
  await sleep(2500);
  for (const c of cases) {
    const r = await evalJs(`(async () => {
      const { segmentObject } = await import('/twin/segment.js');
      const { floodMask } = await import('/twin/scan.js');
      const img = new Image(); img.src = 'data:image/jpeg;base64,${c.photo}'; await img.decode();
      const w = Math.min(512, img.naturalWidth), h = Math.round(w * img.naturalHeight / img.naturalWidth);
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, w, h);
      const t0 = performance.now(); const fl = floodMask(cv); const flMs = performance.now() - t0;
      const s = await segmentObject(cv, ${JSON.stringify(c.box)});
      let inter = 0, uni = 0, sOn = 0, fOn = 0;
      for (let k = 0; k < w * h; k++) { const a = s ? s.mask[k] : 0, b = fl ? fl[k] : 0; inter += a & b; uni += a | b; sOn += a; fOn += b; }
      // sheet: photo | segmenter mask (cyan over photo) | flood mask
      const out = document.createElement('canvas'); out.width = w * 3 + 16; out.height = h; const g = out.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, out.width, h); g.drawImage(cv, 0, 0);
      const paint = (m, x0) => { g.drawImage(cv, x0, 0); const im = g.getImageData(x0, 0, w, h); for (let k = 0; k < w * h; k++) { if (!m || !m[k]) { im.data[k*4] *= 0.15; im.data[k*4+1] *= 0.15; im.data[k*4+2] *= 0.15; } } g.putImageData(im, x0, 0); };
      paint(s?.mask, w + 8); paint(fl, 2 * w + 16);
      g.strokeStyle = '#ff0'; const b = ${JSON.stringify(c.box)}; g.strokeRect(w + 8 + b[0] * w, b[1] * h, (b[2] - b[0]) * w, (b[3] - b[1]) * h);
      return { w, h, segMs: s?.ms ?? null, floodMs: Math.round(flMs), seg: s ? sOn / (w * h) : null, flood: fl ? fOn / (w * h) : null, iou: s && fl ? inter / Math.max(1, uni) : null, png: out.toDataURL('image/png') };
    })()`);
    const path = join(SHOTS, `scan-v2-seg-${c.name}.png`);
    await writeFile(path, Buffer.from(r.png.split(',')[1], 'base64'));
    console.log(`${c.name} (${c.what}): ${r.w}x${r.h} segmenter ${r.seg == null ? 'FAILED' : `${(r.seg * 100).toFixed(0)}% in ${r.segMs} ms`}, flood ${r.flood == null ? 'none (busy border)' : `${(r.flood * 100).toFixed(0)}%`}, IoU ${r.iou == null ? '-' : r.iou.toFixed(2)}  ${path}`);
    try { assert.ok(r.seg != null, 'segmenter produced a mask'); } catch (e) { failed++; console.log(`FAIL ${c.name}: ${e.message}`); }
  }
  ws.close();
} finally {
  chrome.kill(); await live.close(); await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(failed ? `${failed} segmentation failures` : `segmenter masked all ${cases.length} photos`);
process.exit(failed ? 1 : 0);
