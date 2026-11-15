// The Forge in a real browser (Playwright + headless Chromium, SwiftShader WebGL), against the REAL /argos/ routes with
// real OpenSCAD and a scratch design store (test/mock-forge.mjs, port 8798 or 8799; never the live 8789/8790).
// Covers: empty state; a mock call scan appears live (AI estimate, photo); Build 3D shows the model; STL + OpenSCAD
// downloads; the circuit's Arduino sketch; importing STL / OBJ / GLB (picker) and .scad (drag and drop), each with
// "Made outside Ody"; holo look; refine on an imported mesh shows the server's refusal and doesn't switch pages; refine
// on a scan calls openRefine; the server's import error text shown as is; filters; delete with confirmation; GPU
// resources disposed on switch; names rendered as text; reduced motion; no console errors.
//   node test/forge-test.mjs            screenshots: ~/.playwright-mcp/forge-*.png
// Needs playwright-core: from node_modules if installed, else PLAYWRIGHT_CORE=/path/to/playwright-core.
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CIRCUIT, LAMP, mockPhoto, startMockForge, tinyFiles } from './mock-forge.mjs';

async function playwright() {
  try { return await import('playwright-core'); } catch { /* not installed here */ }
  for (const p of [process.env.PLAYWRIGHT_CORE].filter(Boolean)) {
    const f = join(p, 'index.mjs'); if (existsSync(f)) return import(pathToFileURL(f).href);
  }
  console.error('playwright-core not found: npm i -D playwright-core, or set PLAYWRIGHT_CORE'); process.exit(2);
}
const { chromium } = await playwright();
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const SHOTS = join(homedir(), '.playwright-mcp');
await mkdir(SHOTS, { recursive: true });

const { createServer } = await import('node:net');
const free = p => new Promise(ok => { const s = createServer().once('error', () => ok(false)).listen(p, '127.0.0.1', () => s.close(() => ok(true))); });
const PORT = (await free(8798)) ? 8798 : (await free(8799)) ? 8799 : 0;
if (!PORT) { console.error('ports 8798 and 8799 are busy'); process.exit(2); }

let pass = 0, fail = 0;
const test = async (name, fn) => { try { const d = await fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); } };

const mock = await startMockForge({ port: PORT });
const browser = await chromium.launch({ executablePath: existsSync(CHROME) ? CHROME : undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const consoleProblems = [], expected = [];
// Chrome logs every 4xx answer as "Failed to load resource". Two are on purpose here: the refusal to refine an imported
// mesh (422) and the fake .glb import (400). Those are counted, not treated as page errors.
const EXPECTED = /^Failed to load resource: the server responded with a status of (422|400) /;
const watch = page => {
  page.on('console', m => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (EXPECTED.test(m.text())) expected.push(m.text()); else consoleProblems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', e => consoleProblems.push(`pageerror: ${e.message}`));
};
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, reducedMotion: 'no-preference' });
  const page = await ctx.newPage(); watch(page);
  const $ = s => page.locator(s);
  const stage = () => page.evaluate(() => window.__forge._state());
  const card = kind => $(`.forge-relic[data-kind=${kind}]`);
  const toasts = () => $('.forge-toast').allTextContents();
  const waitModel = () => page.waitForSelector('.forge-stage[data-has=model]', { timeout: 30_000 });
  const back = () => $('.forge-back').click();
  async function dl(locator) {
    const [d] = await Promise.all([page.waitForEvent('download'), locator.click()]);
    const buf = await readFile(await d.path());
    return { name: d.suggestedFilename(), buf };
  }

  await page.goto(`${mock.base}/`);
  await page.waitForSelector('#forge-h');

  await test('empty state says what to do', async () => {
    await page.waitForSelector('.forge-empty:not([hidden])');
    const t = await $('.forge-empty-text').textContent();
    assert.match(t, /No designs yet/); assert.match(t, /import/);
    assert.equal(await $('.forge-count').textContent(), '0 designs');
    return t;
  });

  let scanId;
  await test('a mock call scan appears in The Forge live, with its photo and the AI estimate badge', async () => {
    mock.argos.onPublished({ type: 'scan', spec: LAMP, photo: await mockPhoto() });
    await card('scan').waitFor({ timeout: 10_000 });
    scanId = await card('scan').getAttribute('data-id');
    assert.equal(await card('scan').locator('.forge-relic-name').textContent(), 'Desk lamp');
    assert.equal(await card('scan').locator('.forge-badge.is-estimate').textContent(), 'AI estimate');
    await page.waitForFunction(() => { const i = document.querySelector('.forge-relic[data-kind=scan] .forge-well img'); return i && i.complete && i.naturalWidth > 0; });
    assert.ok((await toasts()).some(t => /New scan from the call/.test(t)));
    return scanId;
  });

  await test('scan with no STL shows its photo and Build 3D; Build 3D compiles and shows the model', async () => {
    await card('scan').locator('.forge-open').click();
    await page.waitForSelector('.forge-photo:not([hidden])');
    assert.equal(await $('.forge-build').textContent(), 'Build 3D');
    await page.screenshot({ path: join(SHOTS, 'forge-scan-photo.png') });
    await $('.forge-build').click();
    await waitModel();
    const s = await stage();
    assert.ok(s.stage.meshes >= 1 && s.stage.tris > 10, JSON.stringify(s.stage));
    const chain = (await $('.forge-v-chain').textContent()).replace(/\s+/g, ' ');
    assert.match(chain, /v1 Scan.*v2 Built/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, 'forge-built.png') });
    return `${s.stage.tris} triangles, chain "${chain}"`;
  });

  await test('both downloads work: STL and OpenSCAD source', async () => {
    const stl = await dl($('.forge-dl-stl'));
    assert.match(stl.name, /model\.stl$/); assert.ok(stl.buf.length > 84 && !/^\s*</.test(stl.buf.subarray(0, 20).toString()));
    const scad = await dl($('.forge-dl-scad'));
    assert.match(scad.name, /source\.scad$/); assert.match(scad.buf.toString(), /module part_base/);
    // the scan itself now offers the built STL directly
    await $('.forge-v-chain .forge-chain-btn').first().click();
    await page.waitForSelector('.forge-build:not([hidden])');
    assert.equal(await $('.forge-build').textContent(), 'Show 3D model');
    const stl2 = await dl($('.forge-dl-stl'));
    assert.ok(stl2.buf.equals(stl.buf));
    return `${stl.name} ${stl.buf.length} B, ${scad.name} ${scad.buf.length} B`;
  });

  await test('refine on a scan opens Argos on that design (openRefine)', async () => {
    await $('.forge-refine').click();
    assert.deepEqual(await page.evaluate(() => window.__refineCalls), [scanId]);
    await back();
  });

  await test("a circuit from the call offers its Arduino sketch", async () => {
    mock.send(CIRCUIT);
    await card('circuit').waitFor();
    await card('circuit').locator('.forge-open').click();
    const ino = await dl($('.forge-dl-ino'));
    assert.match(ino.name, /\.ino$/); assert.match(ino.buf.toString(), /void setup/);
    assert.ok(await $('.forge-refine').isHidden() && await $('.forge-delete').isHidden());
    await back();
    return ino.name;
  });

  const files = tinyFiles();
  const imported = {};
  for (const [name, buf, mime] of [['bracket.stl', files.stl, 'model/stl'], ['cube.obj', files.obj, 'text/plain'], ['pyramid.glb', files.glb, 'model/gltf-binary']]) {
    await test(`import ${name} with the file picker: viewer shows the model with "Made outside Ody"`, async () => {
      if (await $('.forge-viewer').isVisible()) await back();
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), $('.forge-import').click()]);
      await chooser.setFiles({ name, mimeType: mime, buffer: buf });
      await page.waitForFunction(n => document.querySelector('.forge-v-name')?.textContent === n, name.split('.')[0], { timeout: 10_000 });
      await waitModel();
      const s = await stage(); imported[name] = s.open;
      assert.ok(s.stage.meshes >= 1, JSON.stringify(s.stage));
      assert.equal(await $('.forge-side .forge-badge.is-outside').textContent(), 'Made outside Ody');
      assert.match(await $('.forge-v-note').textContent(), /Made outside Ody/);
      assert.equal(await $(`.forge-relic[data-id="${s.open}"] .forge-badge.is-outside`).textContent(), 'Made outside Ody');
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, `forge-import-${name.split('.')[1]}.png`) });
      return `${s.stage.tris} triangles`;
    });
  }

  await test('hologram look and back; imported mesh exports an STL in the browser', async () => {
    await $('.forge-look[data-look=holo]').click();
    assert.equal((await stage()).stage.look, 'holo');
    assert.equal(await $('.forge-stage').getAttribute('data-look'), 'holo');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, 'forge-holo.png') });
    const stl = await dl($('.forge-dl-stl'));   // pyramid.glb -> STL (STLExporter)
    assert.match(stl.name, /pyramid\.stl$/); assert.equal(stl.buf.readUInt32LE(80), 4);
    const glb = await dl($('.forge-dl-orig'));
    assert.ok(glb.buf.equals(files.glb));
    await $('.forge-look[data-look=forge]').click();
    return `${stl.buf.length} B STL from the GLB`;
  });

  await test("refine on an imported mesh shows the server's honest refusal and stays on The Forge", async () => {
    await $('.forge-refine').click();
    await page.waitForSelector('.forge-refusal:not([hidden])');
    const t = await $('.forge-refusal').textContent();
    assert.match(t, /made outside Ody and has no OpenSCAD source/);
    assert.equal((await page.evaluate(() => window.__refineCalls)).length, 1);
    return t;
  });

  await test('GPU memory is released when switching designs', async () => {
    const ids = Object.values(imported), mem = [];
    for (let i = 0; i < 6; i++) { await page.evaluate(id => window.__forge.open(id), ids[i % 3]); await waitModel(); await page.waitForTimeout(150); mem.push((await stage()).stage.renderer.geometries); }
    assert.ok(mem[5] <= mem[2] + 1 && mem[4] <= mem[1] + 1, mem.join(','));
    return `geometries per switch: ${mem.join(', ')}`;
  });

  await test("a bad file shows the server's error text as it is", async () => {
    await back();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), $('.forge-import').click()]);
    await chooser.setFiles({ name: 'fake.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('not a glb at all') });
    await page.waitForSelector('.forge-toast.is-error');
    const t = await $('.forge-toast.is-error').first().textContent();
    assert.match(t, /fake\.glb: That \.glb file is not a valid glTF binary\./);
    await $('.forge-toast.is-error button').first().click();
    return t.replace('Dismiss', '');
  });

  await test('drag and drop imports a .scad file (source only: Build 3D)', async () => {
    await page.evaluate(() => {
      const dt = new DataTransfer(); dt.items.add(new File(['cube([20, 10, 5]);\n'], 'block.scad', { type: 'text/plain' }));
      const root = document.getElementById('page-forge');
      for (const type of ['dragenter', 'dragover', 'drop']) root.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelector('.forge-v-name')?.textContent === 'block');
    assert.equal(await $('.forge-build').textContent(), 'Build 3D');
    assert.ok(await $('.forge-drop').isHidden());
    await $('.forge-build').click(); await waitModel();
    await back();
  });

  await test('filters: All, From calls, Refined, Imported', async () => {
    const n = async f => { await $(`.forge-filter[data-filter=${f}]`).click(); return $('.forge-relic').count(); };
    const counts = { all: await n('all'), call: await n('call'), refined: await n('refined'), imported: await n('imported') };
    assert.deepEqual(counts, { all: 8, call: 2, refined: 2, imported: 4 }, JSON.stringify(counts));
    assert.equal(await $('.forge-filter[data-filter=imported]').getAttribute('aria-pressed'), 'true');
    await $('.forge-filter[data-filter=all]').click();
    return JSON.stringify(counts);
  });

  await test('cards are newest first; names are text, never HTML', async () => {
    const ats = await page.evaluate(async () => (await (await fetch('/argos/designs')).json()).designs.map(d => d.id));
    const shown = await $('.forge-relic:not([data-kind=circuit])').evaluateAll(els => els.map(e => e.dataset.id));
    assert.deepEqual(shown, ats);
    assert.equal(await $('.forge-relic-name img, .forge-relic-name b, .forge-v-name *').count(), 0);
  });

  await page.screenshot({ path: join(SHOTS, 'forge-gallery.png') });

  await test('delete asks first, then removes the design from the page and the server', async () => {
    const id = imported['cube.obj'];
    await $(`.forge-relic[data-id="${id}"] .forge-open`).click();
    await $('.forge-delete').click();
    await page.waitForSelector('.forge-confirm:not([hidden])');
    assert.match(await $('.forge-confirm-q').textContent(), /Delete “cube”\?/);
    await $('.forge-delete-no').click();
    assert.ok(await $('.forge-confirm').isHidden());
    await $('.forge-delete').click(); await $('.forge-delete-yes').click();
    await page.waitForSelector(`.forge-relic[data-id="${id}"]`, { state: 'detached' });
    assert.ok(await $('.forge-viewer').isHidden());
    const left = await page.evaluate(async () => (await (await fetch('/argos/designs')).json()).designs.map(d => d.id));
    assert.ok(!left.includes(id));
    assert.ok((await toasts()).some(t => /Deleted “cube”/.test(t)));
  });

  await test('keyboard: Enter opens a card, Escape closes the viewer and returns focus', async () => {
    await $('.forge-relic .forge-open').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.forge-viewer:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'forge-v-name');
    await page.keyboard.press('Escape');
    assert.ok(await $('.forge-viewer').isHidden());
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('forge-open')));
  });

  await test('no console errors or warnings (CSP included)', async () => {
    assert.deepEqual(consoleProblems, [], consoleProblems.join(' | '));
    assert.equal(expected.length, 2, expected.join(' | '));
    return 'only the 2 deliberate 4xx answers (422 refusal, 400 fake file)';
  });

  await test('reduced motion: nothing animates', async () => {
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const p2 = await c2.newPage(); watch(p2);
    await p2.goto(`${mock.base}/`); await p2.waitForSelector('.forge-relic'); await p2.waitForTimeout(500);
    const n = await p2.evaluate(() => document.getAnimations().length);
    await c2.close();
    assert.equal(n, 0); assert.deepEqual(consoleProblems, [], consoleProblems.join(' | '));
  });

  await test('narrow window (390 px): no horizontal scroll', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const over = await page.evaluate(() => { const s = document.querySelector('.forge-scroll'); return s.scrollWidth - s.clientWidth; });
    await page.screenshot({ path: join(SHOTS, 'forge-390.png') });
    assert.ok(over <= 0, `${over}px`);
  });
} finally {
  await browser.close();
  await mock.close();
}
console.log(`\n${pass} passed, ${fail} failed  (screenshots: ${SHOTS}/forge-*.png)`);
process.exit(fail ? 1 : 0);
