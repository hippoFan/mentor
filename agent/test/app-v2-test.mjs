// The app's v2 pieces in a real page: Ody modifies a part (a pen gets a brush tip), before / after (B), Combine sends
// analyze with modified[], the analysis reads as the new design; the "Parts to get" checklist (a buzzer) with the
// circuit view's placeholder; the shortcut sheet; the rail at desktop and phone widths. Mock call on :8798
// (test/mock-twin.mjs --circuit), headless Chrome, never 8790.
//   node test/app-v2-test.mjs        screenshots: ~/.playwright-mcp/app-v2-*.png
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import WebSocket from 'ws';
import { sanitizeScan } from '../scan.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8798, DEBUG = 9344;
const SHOTS = join(homedir(), '.playwright-mcp');
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
let pass = 0, fail = 0;
const test = async (name, fn) => { try { const d = await fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PEN = sanitizeScan({ name: 'Ballpoint pen', category: 'stationery', dims_mm: { w: 140, d: 12, h: 12 }, confidence: 0.8, parts: [
  { name: 'Barrel', shape: 'cylinder', size_mm: { x: 11, y: 11, z: 104 }, position_mm: { x: -8, y: 0, z: 6 }, rotation_deg: { x: 0, y: 90, z: 0 }, color: '#2f5fd0', material: 'plastic' },
  { name: 'Tip', shape: 'cone', size_mm: { x: 9, y: 9, z: 22 }, position_mm: { x: 55, y: 0, z: 6 }, rotation_deg: { x: 0, y: 90, z: 0 }, color: '#c9ccd2', material: 'metal' },
  { name: 'Clip', shape: 'box', size_mm: { x: 44, y: 3, z: 2 }, position_mm: { x: -30, y: 0, z: 13 }, color: '#c9ccd2', material: 'metal' }] });

await mkdir(SHOTS, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'app-v2-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const mock = spawn(process.execPath, ['test/mock-twin.mjs', '--circuit', '--port', String(PORT)], { cwd: HERE, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_GAP_MS: '700', MOCK_START_MS: '200' } });
try {
  let mockOut = '';
  await new Promise((res, rej) => { mock.stdout.on('data', d => { mockOut += d; if (/twin on/.test(mockOut)) res(); }); mock.on('exit', c => rej(new Error(`mock exited ${c}`))); });
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  let id = 0; const wait = new Map(), errors = [], sent = [];
  ws.on('message', m => {
    const d = JSON.parse(m);
    if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || 'exception');
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(`console.error ${d.params.args.map(a => a.value ?? a.description).join(' ')}`.slice(0, 300));
    if (d.method === 'Network.webSocketFrameSent') { try { sent.push(JSON.parse(d.params.response.payloadData)); } catch { /* not json */ } }
  });
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
  const until = async (expr, tries = 60, ms = 250) => { for (let i = 0; i < tries; i++) { const v = await evalJs(expr).catch(() => null); if (v) return v; await sleep(ms); } return null; };
  const shot = async name => { const s = await cdp('Page.captureScreenshot', { format: 'png' }); const p = join(SHOTS, name); await writeFile(p, Buffer.from(s.result.data, 'base64')); console.log(`      ${p}`); };
  const inject = ev => evalJs(`window.mentorTwin.inject(${JSON.stringify(ev)})`);
  const settle = async () => { await sleep(400); await until('!window.mentorTwin.boardState().flying && !window.mentorTwin.scanState().flying', 60, 250); await sleep(600); };
  const key = async (k, code, vk, shift = false) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, ...(k.length === 1 ? { text: k } : {}), windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: shift ? 8 : 0 });
  };
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://localhost:${PORT}/twin` });
  const built = await until("(s => s.built && s)(window.mentorTwin?.boardState?.())", 80, 250);
  await test('page built', () => { assert.ok(built, errors.join(' | ')); return built.name; });
  await until("document.querySelector('#mode-circuit') && !document.querySelector('#mode-circuit').hidden", 60, 250);
  await until("/holding/.test(document.title) || true", 1, 1);
  for (let i = 0; i < 40 && !/holding the last state/.test(mockOut); i++) await sleep(250);

  // ---------- checklist + circuit placeholder ----------
  await inject({ type: 'checklist', items: [
    { id: 'buzzer', name: 'Piezo buzzer', why: 'Beeps when something gets closer than 10 cm.', qty: 1, status: 'needed', source: 'Ody, for the distance alarm',
      suggested: { part: 'Active 5 V piezo buzzer (TMB12A05)', pins: ['+ (long leg) → pin 8', '− → GND rail'] } },
    { id: 'hc-sr04', name: 'Distance sensor', why: 'Measures how far your hand is.', qty: 1, status: 'have', suggested: { part: 'HC-SR04', pins: ['VCC → 5 V', 'TRIG → pin 9', 'ECHO → pin 10', 'GND → GND'] } },
    { id: 'r220', name: '220 Ω resistor', why: 'Limits the LED current.', qty: 2, status: 'needed', suggested: { part: '220 Ω, ¼ W', pins: [] } },
  ] });
  await evalJs("document.querySelector('#mode-circuit')?.click()"); await settle();
  await evalJs("document.querySelector('#checklist details')?.setAttribute('open', '')");
  await evalJs("document.getElementById('checkbox').scrollIntoView({ block: 'start' })"); await sleep(300);
  await test('checklist: rows, counts, how-to-wire, local tick', async () => {
    const st = await evalJs('window.mentorTwin.checklistState()');
    assert.equal(st.items.length, 3);
    const t = await evalJs("({ count: document.getElementById('checkCount').textContent, rows: document.querySelectorAll('#checklist .ck').length, have: document.querySelectorAll('#checklist .ck.have').length, how: document.querySelector('#checklist details')?.textContent })");
    assert.equal(t.rows, 3); assert.equal(t.have, 1); assert.equal(t.count, '2 to get'); assert.match(t.how, /pin 8/);
    await shot('app-v2-checklist.png');
    await evalJs("document.querySelectorAll('#checklist input')[2].click()");
    assert.equal(await evalJs("document.getElementById('checkCount').textContent"), '1 to get');
    return t.count;
  });
  await test('circuit view: unmodelled parts wait as placeholders at the breadboard edge', async () => {
    const st = await evalJs('window.mentorTwin.checklistState()');
    assert.ok(st.visible, 'placeholder group hidden in circuit view');
    assert.ok(st.placeholders.some(n => /buzzer/i.test(n)), JSON.stringify(st.placeholders));
    assert.ok(!st.placeholders.some(n => /Distance sensor/i.test(n)), 'a modelled part got a placeholder');
    await shot('app-v2-circuit-placeholder.png'); return st.placeholders.join(', ');
  });

  // ---------- modify: the pen gets a brush tip ----------
  await inject({ type: 'scan', id: 7, at: Date.now(), spec: PEN, photo: '', crop: null });
  await until("window.mentorTwin.scanState().current === 'Ballpoint pen'", 40, 250); await settle();
  const size0 = await evalJs("window.mentorTwin.partSize('part-1')");
  await shot('app-v2-pen-original.png');
  await inject({ type: 'modify', id: 'm1', scope: 'scan', target: { id: 'part-1', name: 'Tip' },
    change: { name: 'Brush tip', shape: 'capsule', color: '#1B1B1F', material: 'fabric', scale: [1.2, 1.2, 1.5], note: 'Soft nylon brush for lettering' }, say: 'Swapped the tip for a brush.' });
  await sleep(900);
  await test('modify: the part morphs, is renamed, tagged and listed as modified', async () => {
    const p = (await evalJs('window.mentorTwin.partsState()')).parts.find(q => q.id === 'part-1');
    assert.equal(p.name, 'Brush tip'); assert.equal(p.mod.material, 'fabric');
    const size1 = await evalJs("window.mentorTwin.partSize('part-1')");
    assert.ok(size1[0] > size0[0] * 1.3, `length ${size0[0].toFixed(1)} -> ${size1[0].toFixed(1)}`);
    const ui = await evalJs("({ chip: !document.getElementById('designChip').hidden, b: !document.getElementById('t-before').hidden, tag: [...document.querySelectorAll('#labels .tag.mod')].map(t => t.textContent), row: [...document.querySelectorAll('#partsList .where.mod')].length })");
    assert.ok(ui.chip && ui.b, JSON.stringify(ui)); assert.ok(ui.tag.some(t => /Brush tip/.test(t)), JSON.stringify(ui.tag)); assert.equal(ui.row, 1);
    await shot('app-v2-pen-modified.png');
    return `${size0[0].toFixed(0)} -> ${size1[0].toFixed(0)} mm long`;
  });
  await key('b', 'KeyB', 66); await sleep(700);
  await test('B shows the original, B again the new design', async () => {
    const sb = await evalJs("window.mentorTwin.partSize('part-1')");
    assert.ok(Math.abs(sb[0] - size0[0]) < 0.6, `before ${sb[0]} vs ${size0[0]}`);
    assert.equal((await evalJs('window.mentorTwin.partsState()')).before, true);
    await shot('app-v2-pen-before.png');
    const glb = await evalJs('window.mentorTwin.exportBytes()'); assert.equal(glb.magic, 'glTF');
    const after = await evalJs("window.mentorTwin.partSize('part-1')"); assert.ok(Math.abs(after[0] - size0[0]) < 0.6, 'export left the view changed');
    await key('b', 'KeyB', 66); await sleep(700);
    const sa = await evalJs("window.mentorTwin.partSize('part-1')"); assert.ok(sa[0] > size0[0] * 1.3);
    return `export ${glb.length} bytes`;
  });
  await test('Combine sends analyze with modified[]; the analysis reads as the new design', async () => {
    sent.length = 0;
    await evalJs("document.getElementById('combine').click()"); await sleep(400);
    const a = sent.find(m => m.type === 'analyze');
    assert.ok(a, `no analyze sent (${sent.map(m => m.type).join(',')})`);
    assert.equal(a.modified?.[0]?.id, 'part-1'); assert.equal(a.modified[0].change.shape, 'capsule');
    await inject({ type: 'analysis', id: 3, scope: 'scan', board: 'Ballpoint pen', kept: [], removed: [], modified: a.modified, title: 'Pen with a brush tip', works: true,
      summary: 'A brush tip makes it a lettering pen: wide strokes when pressed, thin when light.', pros: ['Expressive line width', 'Fine for calligraphy'], cons: ['Not for carbon copies'],
      needs: ['Water-based ink that flows through nylon'], verdict: 'It works, as a brush pen.' });
    await sleep(500);
    const card = await evalJs("({ title: document.querySelector('#analysisCard h4')?.textContent, badges: [...document.querySelectorAll('#analysisCard .an-badge')].map(b => b.textContent) })");
    assert.equal(card.title, 'Pen with a brush tip'); assert.ok(card.badges.includes('New design'), JSON.stringify(card));
    await settle(); await shot('app-v2-pen-analysis.png');
    return card.badges.join(' + ');
  });
  await test('revert restores the original part', async () => {
    await inject({ type: 'modify', revert: true, id: 'm1', scope: 'scan', target: { id: 'part-1', name: 'Brush tip' }, say: 'Back to the ballpoint.' });
    await sleep(800);
    const p = (await evalJs('window.mentorTwin.partsState()')).parts.find(q => q.id === 'part-1');
    assert.equal(p.name, 'Tip'); assert.equal(p.mod, null);
    const s = await evalJs("window.mentorTwin.partSize('part-1')"); assert.ok(Math.abs(s[0] - size0[0]) < 0.6, `${s[0]} vs ${size0[0]}`);
    assert.equal(await evalJs("document.getElementById('designChip').hidden"), true);
    return 'original';
  });
  await test('modify a board part by name (scope board), unknown material -> plastic', async () => {
    await inject({ type: 'modify', id: 'm2', scope: 'board', target: { name: 'reset button' }, change: { color: '#FF453A', material: 'unobtainium', note: 'A red reset button' } });
    await sleep(700);
    const p = (await evalJs('window.mentorTwin.partsState()')).parts.find(q => q.mod);
    assert.ok(p, 'no board part modified'); assert.equal(p.mod.material, 'plastic');
    return p.name;
  });
  await test('stacked toasts: newest on top, at most three', async () => {
    await evalJs("['One', 'Two', 'Three', 'Four'].forEach(t => window.odyHost.toast(t))");
    const t = await evalJs("[...document.querySelectorAll('#toast .toast-item')].map(x => x.textContent)");
    assert.deepEqual(t, ['Four', 'Three', 'Two']);
    await shot('app-v2-toasts.png'); return t.join(' / ');
  });

  // ---------- shortcut sheet, rails ----------
  await key('?', 'Slash', 191, true); await sleep(300);
  await test('? opens the shortcut sheet; Esc closes it', async () => {
    assert.equal(await evalJs("document.getElementById('keysheet').hidden"), false);
    assert.equal(await evalJs('document.activeElement?.id'), 'ksClose');
    await shot('app-v2-shortcuts.png');
    await key('Escape', 'Escape', 27); await sleep(150);
    assert.equal(await evalJs("document.getElementById('keysheet').hidden"), true); return 'ok';
  });
  await evalJs("document.querySelector('aside.rail').scrollTop = 0"); await sleep(200);
  await shot('app-v2-rail-1440.png');
  await test('rail: the now card stays on top while scrolling; empty sections sink', async () => {
    await evalJs("document.querySelector('aside.rail').scrollTop = 600"); await sleep(200);
    const top = await evalJs("(r => r.top - document.querySelector('aside.rail').getBoundingClientRect().top)(document.getElementById('stepbox').getBoundingClientRect())");
    assert.ok(Math.abs(top) < 2, `now card at ${top}`);
    await shot('app-v2-rail-1440-scrolled.png');
    return 'sticky';
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await test('phone width: no horizontal scroll', async () => {
    const w = await evalJs('[document.documentElement.scrollWidth, innerWidth]'); assert.ok(w[0] <= w[1] + 1, JSON.stringify(w));
    await shot('app-v2-rail-390.png');
    await evalJs("document.getElementById('checkbox').scrollIntoView({ block: 'start' })"); await sleep(300);
    await shot('app-v2-rail-390-checklist.png'); return `${w[0]} px`;
  });
  await test('no page errors', () => assert.deepEqual(errors, []));
  ws.close();
} finally {
  chrome.kill(); mock.kill();
  await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
