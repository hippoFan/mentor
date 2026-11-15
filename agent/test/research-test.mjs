// Researched interiors test: unit checks (sanitiser, teardown order, fits inside the shell, cache, timeout fallback,
// one research per object), free and without a brain. Then, owner testing only, real research calls:
//   node test/research-test.mjs                                   unit checks only
//   MENTOR_BRAIN=claude-code MENTOR_OWNER_TESTING=1 node test/research-test.mjs --live [--web] [--fresh] [--only phone]
//     one research per case (phone, mouse, Arduino UNO R4 WiFi; cached in runs/research-cache), writes
//     <out>/<case>.case.json for test/mock-research.mjs --shoot
// Options: --out <dir> (default: $TMPDIR/ody-research-out)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeScan } from '../scan.mjs';
import { MAX_INTERIOR_PARTS, MAX_LAYERS, RESEARCH_SHAPES, RESEARCH_MATERIALS, claudeResearch, cleanUrl, extractUrls, faceAxis, fitInterior,
  halfExtents, researchAsk, researchInterior, sanitizeInterior, shellBox, slugify } from '../research.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const OUT = resolve(opt('--out', join(tmpdir(), 'ody-research-out')));
const RUNS = fileURLToPath(new URL('../../runs/', import.meta.url));
let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };

const phoneScan = sanitizeScan({ name: 'Phone in black MagSafe case', category: 'phone', dims_mm: { w: 79, d: 163, h: 10 }, confidence: 0.7,
  parts: [{ name: 'Case body', shape: 'rounded_box', size_mm: { x: 79, y: 163, z: 10 }, position_mm: { x: 0, y: 0, z: 5 }, color: '#141414', material: 'rubber' }] });
/** Every part's rotated box lies inside the shell (with a hair of float slack). */
function inside(interior, scan) {
  const b = shellBox(scan);
  for (const l of interior.layers) for (const p of l.parts) {
    const h = halfExtents(p.size_mm, p.rotation_deg);
    for (const k of 'xyz') {
      if (p.position_mm[k] - h[k] < b.min[k] - 0.02 || p.position_mm[k] + h[k] > b.max[k] + 0.02) return `${p.name} leaves the shell on ${k}`;
    }
  }
  return '';
}
const part = (name, z, extra = {}) => ({ name, shape: 'rounded_box', size_mm: { x: 70, y: 146, z: 1 }, position_mm: { x: 0, y: 0, z }, rotation_deg: { x: 0, y: 0, z: 0 },
  color: '#222222', material: 'metal', note: `${name} note`, ...extra });
const goodRaw = { object: 'iPhone', model_guess: 'iPhone 15 Pro', confidence: 0.7, front_face: '-z', notes: 'Estimated.', sources: [],
  layers: [{ name: 'Back glass', order: 5, parts: [part('Back glass', 9)] }, { name: 'Display', order: 0, parts: [part('OLED panel', 1, { material: 'screen' })] },
    { name: 'Battery', order: 3, parts: [part('Battery cell', 6, { material: 'battery' })] }] };

// ---------- unit ----------
await test('sanitiser caps and validates', () => {
  const evil = sanitizeInterior({
    object: '<script>alert(1)</script> phone https://evil.example/x with a name that goes on and on and on and on forever', model_guess: 42, confidence: 9,
    front_face: 'up', notes: 'n'.repeat(999), sources: [{ title: 'x', url: 'javascript:alert(1)' }, { title: 'fake', url: 'https://invented.example/teardown' }],
    layers: Array.from({ length: 20 }, (_, i) => ({ name: `L${i}\u0007`, order: 20 - i, parts: Array.from({ length: 8 }, (_, j) => ({
      name: `p${j}<b>`, shape: j ? 'box' : 'teapot', size_mm: { x: 1e9, y: NaN, z: -4 }, position_mm: { x: 1e7, y: 'a', z: -50 }, rotation_deg: { x: 9999, y: 0, z: 0 },
      color: j % 2 ? 'red' : '#ABC', material: 'lava', note: `see https://x.example ${'z'.repeat(300)}` })) })),
  }, phoneScan, { found: [] });
  assert.ok(evil.object.length <= 60 && !/[<>]/.test(evil.object) && !/https?:/.test(evil.object));
  assert.equal(evil.model_guess, '42'); assert.equal(evil.confidence, 1); assert.equal(evil.front_face, '+z');
  assert.ok(evil.notes.length <= 300);
  assert.equal(evil.sources.length, 0, 'invented and non-https URLs are dropped');
  assert.ok(evil.layers.length <= MAX_LAYERS);
  const parts = evil.layers.flatMap(l => l.parts);
  assert.ok(parts.length <= MAX_INTERIOR_PARTS);
  assert.ok(parts.every(p => RESEARCH_SHAPES.includes(p.shape) && RESEARCH_MATERIALS.includes(p.material) && /^#[0-9a-f]{6}$/.test(p.color)));
  assert.equal(parts[0].shape, 'box'); assert.equal(parts[0].color, '#aabbcc'); assert.equal(parts[1].color, '#8a8f98'); assert.equal(parts[0].material, 'plastic');
  assert.ok(parts.every(p => p.note.length <= 120 && !/https?:/.test(p.note) && !/[<>\u0000-\u001f]/.test(p.name + p.note)));
  assert.ok(evil.layers.every((l, i) => l.order === i && !/[\u0000-\u001f]/.test(l.name)));
  assert.equal(inside(evil, phoneScan), '');
  assert.equal(sanitizeInterior(null, phoneScan), null);
  assert.equal(sanitizeInterior({ layers: [{ name: 'x', parts: [] }] }, phoneScan), null);
});
await test('sources: only URLs a search really returned', () => {
  const raw = { ...goodRaw, sources: [{ title: 'iFixit teardown', url: 'https://www.ifixit.com/Teardown/iPhone+15+Pro+Teardown/166747#s1' },
    { title: 'made up', url: 'https://www.ifixit.com/Teardown/Not+Real/1' }, { title: 'dup', url: 'https://www.ifixit.com/Teardown/iPhone+15+Pro+Teardown/166747/' }] };
  const s = sanitizeInterior(raw, phoneScan, { found: [{ url: 'https://www.ifixit.com/Teardown/iPhone+15+Pro+Teardown/166747' }] });
  assert.equal(s.sources.length, 1);
  assert.equal(s.sources[0].url, 'https://www.ifixit.com/Teardown/iPhone+15+Pro+Teardown/166747');
  assert.equal(cleanUrl('http://a.example/x'), ''); assert.equal(cleanUrl('https://user:pw@a.example/'), ''); assert.equal(cleanUrl('https://a.example/x y'), '');
  const u = extractUrls('Links: [{"title":"T","url":"https://www.ifixit.com/News/1."}] and https://support.apple.com/kb/SP901).');
  assert.deepEqual(u.map(x => x.url), ['https://www.ifixit.com/News/1', 'https://support.apple.com/kb/SP901']);
});
await test('teardown order: layers sorted by order, renumbered from 0', () => {
  const s = sanitizeInterior(goodRaw, phoneScan);
  assert.deepEqual(s.layers.map(l => l.name), ['Display', 'Battery', 'Back glass']);
  assert.deepEqual(s.layers.map(l => l.order), [0, 1, 2]);
  assert.equal(s.front_face, '-z'); assert.deepEqual(faceAxis(s.front_face), { axis: 'z', sign: -1 });
});
await test('every part fits inside the scanned shell', () => {
  const raw = { ...goodRaw, layers: [{ name: 'Big', order: 0, parts: [
    part('Too big', 5, { size_mm: { x: 300, y: 400, z: 50 } }), part('Outside', 40, { position_mm: { x: 200, y: -300, z: 40 } }),
    part('Tilted', 5, { shape: 'cylinder', size_mm: { x: 8, y: 8, z: 60 }, rotation_deg: { x: 90, y: 0, z: 0 } })] }] };
  const s = sanitizeInterior(raw, phoneScan);
  assert.equal(inside(s, phoneScan), '');
  const t = s.layers[0].parts[2]; assert.ok(halfExtents(t.size_mm, t.rotation_deg).y <= 163 / 2 + 0.01);
  const b = shellBox(phoneScan); assert.deepEqual([b.min.z, b.max.z, b.max.x], [0, 10, 39.5]);
  assert.match(researchAsk(phoneScan), /Shell box \(mm\): x -39\.5\.\.39\.5, y -81\.5\.\.81\.5, z 0\.\.10/);
});
await test('cache: the same object never costs twice, and refits to a new scan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ody-research-cache-'));
  try {
    let calls = 0;
    const brain = { research: async () => { calls++; return { raw: goodRaw, found: [], model: 'fake', web: false }; } };
    const a = await researchInterior(brain, phoneScan, { cacheDir: dir, tried: new Set() });
    assert.ok(a && !a.cached); assert.equal(calls, 1);
    assert.ok(existsSync(join(dir, `${slugify(phoneScan.name)}.json`)));
    const bigger = sanitizeScan({ ...phoneScan, parts: [{ ...phoneScan.parts[0], size_mm: { x: 79, y: 163, z: 20 }, position_mm: { x: 0, y: 0, z: 10 } }] });
    const b = await researchInterior(brain, bigger, { cacheDir: dir, tried: new Set() });
    assert.equal(calls, 1, 'second call came from the cache'); assert.equal(b.cached, true);
    assert.equal(inside(b, bigger), '');
    assert.equal(b.layers[2].parts[0].position_mm.z, 18, 'z refit from a 10 mm shell to a 20 mm one');
    assert.equal(fitInterior(null, bigger), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
await test('timeout or failure: no interior, the scan carries on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ody-research-cache-'));
  try {
    let aborted = false;
    const hang = { research: (_s, { signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }) };
    const t0 = Date.now();
    assert.equal(await researchInterior(hang, phoneScan, { cacheDir: dir, tried: new Set(), timeoutMs: 1200 }), null);
    assert.ok(Date.now() - t0 < 3000, 'gave up on time'); assert.ok(aborted, 'the research was told to stop');
    let calls = 0; const tried = new Set();
    const bad = { research: async () => { calls++; throw new Error('boom'); } };
    assert.equal(await researchInterior(bad, phoneScan, { cacheDir: dir, tried }), null);
    assert.equal(await researchInterior(bad, phoneScan, { cacheDir: dir, tried }), null);
    assert.equal(calls, 1, 'one research per new object per call');
    assert.equal(await researchInterior({ research: async () => ({ raw: { layers: 'nope' } }) }, phoneScan, { cacheDir: dir, tried: new Set() }), null);
    assert.equal(await researchInterior({}, phoneScan, { cacheDir: dir }), null, 'a brain without research()');
    assert.equal(await researchInterior(bad, { name: '' }, { cacheDir: dir }), null);
    assert.equal((await readdir(dir)).length, 0, 'failures are not cached');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
await test('claude-code research refuses without owner testing', async () => {
  const was = process.env.MENTOR_OWNER_TESTING; delete process.env.MENTOR_OWNER_TESTING;
  try { await assert.rejects(claudeResearch({ scan: phoneScan }), /owner testing/); } finally { if (was !== undefined) process.env.MENTOR_OWNER_TESTING = was; }
});

// ---------- real research (owner testing; one call per case, cached) ----------
const MOUSE = sanitizeScan({ name: 'Wireless mouse', category: 'computer accessory', known_model: 'none', dims_mm: { w: 66, d: 108, h: 40 }, confidence: 0.75,
  top_face: 'xy', camera_elev_deg: 60, bbox: [0.2, 0.2, 0.8, 0.8], parts: [
    { name: 'Shell', shape: 'sphere', size_mm: { x: 64, y: 106, z: 40 }, position_mm: { x: 0, y: 0, z: 20 }, color: '#2b2d33', material: 'plastic', label: 'Mouse' },
    { name: 'Base', shape: 'rounded_box', size_mm: { x: 62, y: 104, z: 4 }, position_mm: { x: 0, y: 0, z: 2 }, color: '#1b1c20', material: 'plastic' },
    { name: 'Left button', shape: 'rounded_box', size_mm: { x: 26, y: 40, z: 3 }, position_mm: { x: -13, y: 28, z: 33 }, color: '#34373f', material: 'plastic', label: 'Left button' },
    { name: 'Right button', shape: 'rounded_box', size_mm: { x: 26, y: 40, z: 3 }, position_mm: { x: 13, y: 28, z: 33 }, color: '#34373f', material: 'plastic' },
    { name: 'Scroll wheel', shape: 'cylinder', size_mm: { x: 7, y: 18, z: 18 }, position_mm: { x: 0, y: 30, z: 35 }, rotation_deg: { x: 0, y: 90, z: 0 }, color: '#5a5e66', material: 'rubber', label: 'Scroll wheel' }] });
async function runScan(dir, n) {
  const f = join(RUNS, dir, `scan-0${n}.json`), j = join(RUNS, dir, `scan-0${n}.jpg`);
  if (!existsSync(f)) return null;
  const scan = sanitizeScan(JSON.parse(await readFile(f, 'utf8')));
  const [x0, y0, x1, y1] = scan.bbox, px = (x1 - x0) * 0.03, py = (y1 - y0) * 0.03;   // the crop rect cropJpeg used
  const crop = [Math.max(0, x0 - px), Math.max(0, y0 - py), Math.min(1, x1 + px), Math.min(1, y1 + py)];
  const jpeg = existsSync(j) ? await readFile(j) : null;
  return { scan, photo: jpeg ? jpeg.toString('base64') : '', crop, image: jpeg ? { jpeg, width: 0, height: 0 } : null };
}
if (args.includes('--live')) {
  const night = '2026-11-15-04-39-65b46f583e64';
  const cases = [
    ['phone', await runScan(night, 3)],
    ['mouse', { scan: MOUSE, photo: '', crop: null, image: null }],
    ['uno-r4-wifi', await runScan(night, 4)],
  ].filter(([k, c]) => c && (!opt('--only') || k === opt('--only')));
  if (cases.length > 6) throw new Error('at most 6 research calls per run');
  const { createBrain } = await import('../brain.mjs');
  const brain = await createBrain({});
  console.log(`[research-test] brain: ${brain.provider}, web: ${args.includes('--web')}`);
  await mkdir(OUT, { recursive: true });
  for (const [key, c] of cases) {
    const interior = await researchInterior(brain, c.scan, { web: args.includes('--web'), image: c.image, fresh: args.includes('--fresh') });
    if (interior) await writeFile(join(OUT, `${key}.case.json`), JSON.stringify({ scan: c.scan, photo: c.photo, crop: c.crop, interior }));
    if (interior) {
      console.log(`[research-test] ${key}: ${interior.object} / ${interior.model_guess || '?'} (${Math.round(interior.confidence * 100)}%), front ${interior.front_face}, ` +
        `${interior.cached ? 'cached' : `${interior.ms} ms`}, sources: ${interior.sources.map(s => s.url).join(' ') || 'none'}`);
      for (const l of interior.layers) console.log(`    ${l.order}. ${l.name}: ${l.parts.map(p => p.name).join(', ')}`);
    }
    await test(`live research: ${key}`, () => {
      assert.ok(interior, 'an interior came back');
      const parts = interior.layers.flatMap(l => l.parts);
      assert.ok(interior.layers.length >= 3 && parts.length >= 8 && parts.length <= MAX_INTERIOR_PARTS, `${interior.layers.length} layers, ${parts.length} parts`);
      assert.equal(inside(interior, c.scan), '');
      assert.ok(interior.sources.every(s => s.url.startsWith('https://')));
      if (key === 'phone') {   // iPhones open at the display, most Android phones at the back glass
        const [first, last] = [interior.layers[0].name, interior.layers.at(-1).name];
        assert.ok(/display|screen/i.test(first) ? /back|glass|housing/i.test(last) : /back|glass/i.test(first) && /display|screen/i.test(last), `${first} ... ${last}`);
        assert.ok(!interior.layers.flatMap(l => l.parts).some(p => /\bcase\b/i.test(p.name)), 'the case is the shell, not the interior');
        assert.ok(parts.some(p => /battery/i.test(p.name)) && parts.some(p => /logic|board|soc/i.test(p.name)));
      }
      if (key === 'mouse') assert.match(interior.layers[0].name, /top|shell|cover|button/i);
    });
  }
  await brain.close?.();
}
console.log(`${pass} research tests passed`);
