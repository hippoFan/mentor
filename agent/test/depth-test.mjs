// Depth Anything V2 Small on real scan crops (pen, phones, Arduino, paddle, pen): timing per photo
// (the first includes the session load), sanity asserts, depth PNGs written for a visual check.
//   node test/depth-test.mjs            PNGs: $DEPTH_TEST_OUT or <tmpdir>/ody-depth-test/
// Skips (exit 0) when the model is not downloaded (`npm run fetch-models`).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { estimateDepth, depthAvailable, DEPTH_MODEL } from '../depth.mjs';

if (!depthAvailable()) {
  console.log(`skip  depth model ${DEPTH_MODEL} not downloaded; run \`npm run fetch-models\``);
  process.exit(0);
}

const RUNS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'runs');
const PHOTOS = [
  ['pen', '2026-11-15-04-39-65b46f583e64/scan-01.jpg'],
  ['phone', '2026-11-15-04-39-65b46f583e64/scan-02.jpg'],
  ['phone', '2026-11-15-04-39-65b46f583e64/scan-03.jpg'],
  ['arduino', '2026-11-15-04-39-65b46f583e64/scan-04.jpg'],
  ['paddle', '2026-11-15-04-39-65b46f583e64/scan-05.jpg'],
  ['pen', '2026-11-15-07-32-7c46eb77122b/scan-01.jpg'],
].map(([label, rel]) => ({ label, path: join(RUNS, rel) })).filter(p => existsSync(p.path));
if (!PHOTOS.length) { console.log('skip  no scan photos under runs/'); process.exit(0); }

const OUT = process.env.DEPTH_TEST_OUT || join(tmpdir(), 'ody-depth-test');
await mkdir(OUT, { recursive: true });

// decode the PNG back (also proves it is a valid PNG) and return the gray-level std dev
async function pngStd(png, w, h) {
  const img = await loadImage(png);
  assert.equal(img.width, w); assert.equal(img.height, h);
  const c = createCanvas(w, h).getContext('2d');
  c.drawImage(img, 0, 0);
  const d = c.getImageData(0, 0, w, h).data;
  let s = 0, s2 = 0; const n = w * h;
  for (let p = 0; p < d.length; p += 4) { s += d[p]; s2 += d[p] * d[p]; }
  return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
}

let pass = 0, fail = 0;
const warm = [];
for (const [i, p] of PHOTOS.entries()) {
  const name = `${i + 1}-${p.label}-${basename(dirname(p.path)).slice(-6)}-${basename(p.path, '.jpg')}`;
  try {
    const jpg = await readFile(p.path);
    const r = await estimateDepth(jpg);
    assert.ok(Buffer.isBuffer(r.png) && r.png.length > 100, `png too small (${r.png?.length})`);
    assert.equal(r.png.subarray(1, 4).toString(), 'PNG');
    assert.ok(r.width <= 256 && r.height <= 256 && r.width > 0 && r.height > 0, `bad dims ${r.width}x${r.height}`);
    assert.equal(r.png.readUInt32BE(16), r.width); assert.equal(r.png.readUInt32BE(20), r.height);
    assert.ok(r.near > r.far, `near ${r.near} <= far ${r.far}`);
    const sd = await pngStd(r.png, r.width, r.height);
    assert.ok(sd > 20, `depth map nearly constant (std ${sd.toFixed(1)})`);
    // second run: warm timing, and it must be deterministic
    const r2 = await estimateDepth(jpg);
    assert.ok(r2.png.equals(r.png), 'non-deterministic output');
    warm.push(r2.ms);
    await writeFile(join(OUT, `${name}.png`), r.png);
    pass++;
    console.log(`ok    ${name}: ${r.width}x${r.height} png ${r.png.length}B std ${sd.toFixed(0)} near ${r.near.toFixed(3)} far ${r.far.toFixed(3)} ` +
      `${i === 0 ? 'cold' : 'first'} ${r.ms}ms warm ${r2.ms}ms`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\nwarm mean ${Math.round(warm.reduce((a, b) => a + b, 0) / (warm.length || 1))}ms; PNGs in ${OUT}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
