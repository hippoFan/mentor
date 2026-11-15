// Hand control in the real page, no camera: headless Chrome (SwiftShader, no window) opens the twin with ?handsim=1,
// which feeds scripted synthetic landmarks (twin/handsim.js) through the same gestures, cursor and coach. Mock call on
// :8796 (test/mock-twin.mjs --parts with the voice beats pushed far away), never 8790.
//   node test/twin-gestures-test.mjs      screenshots: ~/.playwright-mcp/hands-*.png
// Checks: first-run coach (3 steps, skippable, remembered), status chips, hover highlight from the index fingertip,
// pinch-grab + move + pinch-pull depth, flick-to-tray with Undo, thumbs-up combine with a confirm, two-hand zoom, fist
// reset, a tiny background hand ignored, blocked camera help + keyboard fallback, reduced motion, no network for hands.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import WebSocket from 'ws';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8796, DEBUG = 9343;
const SHOTS = join(homedir(), '.playwright-mcp');
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
let pass = 0, fail = 0;
const test = async (name, fn) => { try { const d = await fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const range = (n, f) => Array.from({ length: n }, (_, i) => f(n > 1 ? i / (n - 1) : 0, i));

await mkdir(SHOTS, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'twin-hands-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const mock = spawn(process.execPath, ['test/mock-twin.mjs', '--parts', '--port', String(PORT)], { cwd: HERE, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_GAP_MS: '900000', MOCK_START_MS: '200' } });
try {
  await new Promise((res, rej) => { mock.stdout.on('data', d => { if (/twin on/.test(String(d))) res(); }); mock.on('exit', c => rej(new Error(`mock exited ${c}`))); });
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json(); } catch { await sleep(200); } }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  let id = 0; const wait = new Map();
  const errors = [], requests = [];
  ws.on('message', m => {
    const d = JSON.parse(m);
    if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text || 'exception');
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(`console.error ${d.params.args.map(a => a.value ?? a.description).join(' ')}`.slice(0, 300));
    if (d.method === 'Network.requestWillBeSent') requests.push(d.params.request.url);
  });
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
  const until = async (expr, tries = 60, ms = 250) => { for (let i = 0; i < tries; i++) { const v = await evalJs(expr).catch(() => null); if (v) return v; await sleep(ms); } return null; };
  const shot = async name => { const s = await cdp('Page.captureScreenshot', { format: 'png' }); const p = join(SHOTS, name); await writeFile(p, Buffer.from(s.result.data, 'base64')); console.log(`      ${p}`); };
  const hs = () => evalJs('window.mentorTwin.handsState()');
  const play = frames => evalJs(`window.mentorTwin.handsPlay(${JSON.stringify(frames)})`);
  const hold = (spec, extra = {}) => evalJs(`window.mentorTwin.handsHold(${JSON.stringify(spec)}, ${JSON.stringify(extra)})`);
  const settle = async () => { await sleep(400); await until('!window.mentorTwin.boardState().flying', 60, 250); await sleep(500); };
  let loads = 0;
  const load = async q => {
    await cdp('Page.navigate', { url: `http://localhost:${PORT}/twin${q}${q ? '&' : '?'}load=${++loads}#argo` });   // a fresh query each time: a same-URL #hash navigation would not reload
    return until('(s => s?.built && s)(window.mentorTwin?.boardState?.())', 80, 250);
  };
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Page.enable');

  // camera fractions for "the index fingertip of a palm / the pinch point is over screen point (x, y)"
  const camAt = async ([x, y]) => {
    const r = await evalJs("(r => [r.left, r.top, r.width, r.height])(document.getElementById('stage').getBoundingClientRect())");
    return { x: 0.12 + 0.76 * (x - r[0]) / r[2], y: 0.12 + 0.76 * (y - r[1]) / r[3] };
  };
  const S = 0.12;
  const palmAt = p => ['palm', p.x + 0.3 * S, p.y + 1.14 * S, S];          // tip = (cx - 0.3 s, cy - 1.14 s)
  const pinchAt = (p, size = S, o) => ['pinch', p.x + 0.575 * size, p.y + 0.735 * size, size, ...(o ? [o] : [])];   // pinch point
  const openAt = (p, size = S) => pinchAt(p, size, { gap: 1 });   // the same hand, fingers open (a pinch must close to engage)

  const st = await load('?handsim=1');
  await test('page built with ?handsim=1', () => { assert.ok(st, `no board ${errors.join(' | ').slice(0, 400)}`); return `${st.name}`; });
  await evalJs("document.getElementById('t-reset').click()"); await settle();

  // ---------- onboarding ----------
  await evalJs("document.getElementById('t-hands').click()");
  const on = await until('(s => s.on && s)(window.mentorTwin.handsState())', 40, 200);
  await test('first Hands: the coach opens on step 1 with drawn glyphs', async () => {
    assert.ok(on?.sim, 'hands did not start'); assert.ok(on.coach, 'coach not open');
    const c = await evalJs("({ step: document.getElementById('coach').dataset.step, svgs: document.querySelectorAll('#coach .coach-art svg').length, anim: document.querySelectorAll('#coach animate, #coach animateTransform').length, title: document.getElementById('coachTitle').textContent, focus: document.activeElement?.id })");
    assert.equal(c.step, '0'); assert.ok(c.svgs >= 1 && c.anim > 0, JSON.stringify(c));
    assert.ok(await until("document.activeElement?.id === 'coachNext'", 20, 100), 'focus moves into the coach');
    return c.title;
  });
  await hold([palmAt({ x: 0.5, y: 0.45 })]); await sleep(400);
  await shot('hands-onboarding.png');
  await evalJs("document.getElementById('coachNext').click()"); await sleep(150);
  await shot('hands-onboarding-2.png');
  await evalJs("document.getElementById('coachNext').click()"); await sleep(150);
  await test('coach step 3 covers zoom + fist, extras, then Start closes and is remembered', async () => {
    const c = await evalJs("({ step: document.getElementById('coach').dataset.step, title: document.getElementById('coachTitle').textContent, next: document.getElementById('coachNext').textContent, svgs: document.querySelectorAll('#coach .coach-art svg').length })");
    assert.equal(c.step, '2'); assert.match(c.title, /zoom/i); assert.match(c.title, /fist/i); assert.equal(c.next, 'Start'); assert.equal(c.svgs, 2);
    await shot('hands-onboarding-3.png');
    await evalJs("document.getElementById('coachNext').click()");
    const s = await hs(); assert.equal(s.coach, false);
    assert.equal(await evalJs("localStorage.getItem('ody.hands.coached')"), '1');
    assert.equal(await evalJs('document.activeElement?.id'), 't-hands', 'focus returns to the Hands button');
    return c.title;
  });

  // ---------- status chips ----------
  const status = async (spec, extra, want, file) => {
    await hold(spec, extra); await sleep(300);
    await until(`window.mentorTwin.handsState().status === ${JSON.stringify(want)}`, 20, 150);
    const s = await hs(); assert.equal(s.status, want, JSON.stringify(s)); if (file) await shot(file); return s.statusText;
  };
  await test('status: no hand', () => status([], { lowLight: false }, 'none', 'hands-status-none.png'));
  await test('status: a tiny hand behind you is ignored (still "show your hand")', () => status([['palm', 0.3, 0.5, 0.035]], {}, 'none'));
  await test('status: too close', () => status([['palm', 0.5, 0.55, 0.42]], {}, 'close', 'hands-status-close.png'));
  await test('status: low light', () => status([palmAt({ x: 0.5, y: 0.4 })], { lowLight: true }, 'dark', 'hands-status-dark.png'));
  await test('status: hand found + legend lights the open hand', async () => {
    const t = await status([palmAt({ x: 0.5, y: 0.4 })], { lowLight: false }, 'ok', 'hands-status-ok.png');
    const s = await hs(); assert.deepEqual(s.legend, ['hover']); assert.ok(s.cursor, 'cursor shown'); return t;
  });

  // ---------- explode, then hover a part ----------
  await evalJs("document.getElementById('t-explode').click()");
  await until('window.mentorTwin.boardState().explode > 0.99', 60, 250); await settle();
  const parts = await evalJs('window.mentorTwin.partsState().parts.map(p => p.id)');
  let target = null, targetCam = null;
  for (const pid of ['esp32', ...parts]) {
    const sc = await evalJs(`window.mentorTwin.partScreen(${JSON.stringify(pid)})`); if (!sc) continue;
    const c = await camAt(sc); if (c.x < 0.2 || c.x > 0.8 || c.y < 0.2 || c.y > 0.8) continue;
    await hold([palmAt(c)]); await sleep(350);
    const s = await hs(); if (s.hover === pid) { target = pid; targetCam = c; break; }
  }
  await test('open hand hovers: the part under the index fingertip lights up', async () => {
    assert.ok(target, `no part hovered among ${parts.length}`);
    const s = await hs(); assert.equal(s.cursorState, 'over'); assert.ok(s.tip, 'tooltip shown');
    await shot('hands-hover.png'); return `${target}: ${s.tip}`;
  });

  // ---------- pinch-grab, carry, pull for depth, drop ----------
  if (target) {
    const before = await evalJs(`window.mentorTwin.partWorld(${JSON.stringify(target)})`);
    await hold([]); await sleep(300);
    await play(range(6, () => [openAt(targetCam)]));
    await hold([pinchAt(targetCam)]); await sleep(450);
    await test('pinch on a part grabs it', async () => { const s = await hs(); assert.equal(s.holding, target, JSON.stringify(s)); assert.equal(s.cursorState, 'grab'); return s.label; });
    await play(range(20, t => [pinchAt({ x: targetCam.x + 0.12 * t, y: targetCam.y })]));
    await sleep(150);
    const moved = await evalJs(`window.mentorTwin.partWorld(${JSON.stringify(target)})`);
    await shot('hands-grab.png');
    await test('moving the pinch carries the part', () => { const d = Math.hypot(moved[0] - before[0], moved[1] - before[1], moved[2] - before[2]); assert.ok(d > 8, `moved ${d.toFixed(1)} mm`); return `${d.toFixed(0)} mm`; });
    const end = { x: targetCam.x + 0.12, y: targetCam.y };
    const dist = async () => { const [p, c] = await Promise.all([evalJs(`window.mentorTwin.partWorld(${JSON.stringify(target)})`), evalJs('window.mentorTwin.camera().pos')]); return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]); };
    const d0 = await dist();
    await play(range(24, t => [pinchAt(end, S + 0.05 * t)])); await sleep(150);
    const d1 = await dist();
    await test('pinch-pull (hand grows) brings the part toward the camera', () => { assert.ok(d0 - d1 > 10, `camera distance ${d0.toFixed(0)} -> ${d1.toFixed(0)}`); return `${d0.toFixed(0)} -> ${d1.toFixed(0)} mm`; });
    await hold([palmAt(end)]); await sleep(450);
    await test('opening the hand drops it (moved, still on stage)', async () => {
      const s = await hs(); assert.equal(s.holding, null);
      const p = (await evalJs('window.mentorTwin.partsState()')).parts.find(q => q.id === target); assert.ok(p.moved && !p.removed); return 'dropped';
    });
    // pinch-onset rewind: aim at the part, then drift sideways while the fingers close; the grab lands where you aimed
    const sc2 = await evalJs(`window.mentorTwin.partScreen(${JSON.stringify(target)})`);
    if (sc2) {
      const c2 = await camAt(sc2), dx = 0.045;
      await hold([openAt(c2)]); await sleep(450);
      const aimedOver = (await hs()).hover;
      await play([...range(3, (t, i) => [pinchAt({ x: c2.x + dx * (i + 1) / 3, y: c2.y }, S, { gap: 0.66 - 0.33 * i })]), ...range(8, () => [pinchAt({ x: c2.x + dx, y: c2.y })])]);
      await sleep(100);
      await test('pinch-onset rewind: drifting while pinching still grabs the part you aimed at', async () => {
        const s = await hs(); assert.equal(aimedOver, target, `aimed over ${aimedOver}`); assert.equal(s.holding, target, JSON.stringify(s));
        await shot('hands-v3-rewind.png'); return `held ${s.holding} after a ${(dx * 100).toFixed(1)} % drift`;
      });
      await play(range(8, () => [openAt({ x: c2.x + dx, y: c2.y })])); await sleep(300);
      await test('an edge-on hand (tips overlap on screen, not in depth) does not grab', async () => {
        await hold([pinchAt(c2, S, { thumbZ: 0.5 })]); await sleep(500);
        const s = await hs(); assert.equal(s.holding, null); assert.notEqual(s.cursorState, 'grab'); return s.cursorState;
      });
      await hold([palmAt(c2)]); await sleep(300);
    }
  }

  // ---------- flick a part to the tray, Undo ----------
  let flicked = null;
  for (const pid of parts.filter(p => p !== target)) {
    const sc = await evalJs(`window.mentorTwin.partScreen(${JSON.stringify(pid)})`); if (!sc) continue;
    const c = await camAt(sc); if (c.x < 0.2 || c.x > 0.62 || c.y < 0.2 || c.y > 0.8) continue;
    await hold([palmAt(c)]); await sleep(400);
    if ((await hs()).hover !== pid) continue;
    await play([...range(8, () => [palmAt(c)]), ...range(4, t => [palmAt({ x: c.x + 0.33 * t, y: c.y })])]);
    await sleep(200); flicked = pid; break;
  }
  await test('a fast sideways flick removes the hovered part, with Undo', async () => {
    assert.ok(flicked, 'no part to flick');
    await until(`window.mentorTwin.partsState().parts.find(q => q.id === ${JSON.stringify(flicked)})?.removed`, 20, 150);
    const p = (await evalJs('window.mentorTwin.partsState()')).parts.find(q => q.id === flicked);
    assert.ok(p.removed, `${flicked} not removed`);
    const s = await hs(); assert.match(s.toast, /Removed/); assert.match(s.toast, /Undo/);
    await shot('hands-flick.png');
    await evalJs("document.querySelector('#toast button').click()");
    await until(`!window.mentorTwin.partsState().parts.find(q => q.id === ${JSON.stringify(flicked)})?.removed`, 20, 150);
    const q = (await evalJs('window.mentorTwin.partsState()')).parts.find(x => x.id === flicked);
    assert.ok(!q.removed, 'Undo did not restore'); return flicked;
  });
  await test('an ordinary (slow) move removes nothing', async () => {
    await play(range(40, t => [palmAt({ x: 0.3 + 0.4 * t, y: 0.45 })])); await sleep(200);
    const n = (await evalJs('window.mentorTwin.partsState()')).parts.filter(p => p.removed).length; assert.equal(n, 0); return 'nothing removed';
  });

  // ---------- thumbs up: confirm, then combine ----------
  await hold([['thumbs', 0.5, 0.5, S]]); await sleep(900);
  await test('thumbs up asks before combining', async () => { const s = await hs(); assert.match(s.toast, /Combine the parts\?/); assert.ok((await evalJs('window.mentorTwin.boardState().explode')) > 0.9, 'combined without asking'); await shot('hands-thumbs.png'); return s.toast; });
  await hold([palmAt({ x: 0.5, y: 0.45 })]); await sleep(400);
  await hold([['thumbs', 0.5, 0.5, S]]); await sleep(900);
  await test('a second thumbs up combines', async () => { const v = await until('window.mentorTwin.boardState().explode < 0.5', 30, 200); assert.ok(v, 'still exploded'); return (await hs()).toast; });
  await hold([]); await sleep(300);
  await evalJs("document.getElementById('t-reset').click()"); await settle();

  // ---------- two-hand zoom ----------
  const r0 = (await evalJs('window.mentorTwin.camera()')).radius;
  await play(range(26, t => [['palm', 0.4 - 0.16 * t, 0.55, 0.11], ['palm', 0.6 + 0.16 * t, 0.55, 0.11]]));
  await sleep(120);
  await shot('hands-zoom.png');
  const r1 = (await evalJs('window.mentorTwin.camera()')).radius;
  await test('two hands apart zoom in', async () => { assert.ok(r1 < r0 * 0.75, `radius ${r0.toFixed(0)} -> ${r1.toFixed(0)}`); const s = await hs(); assert.deepEqual(s.legend, ['zoom']); return `${r0.toFixed(0)} -> ${r1.toFixed(0)}`; });
  await play(range(20, t => [['palm', 0.24 + 0.14 * t, 0.55, 0.11], ['palm', 0.76 - 0.14 * t, 0.55, 0.11]]));
  await sleep(120);
  const r2 = (await evalJs('window.mentorTwin.camera()')).radius;
  await test('two hands together zoom out', () => { assert.ok(r2 > r1 * 1.25, `radius ${r1.toFixed(0)} -> ${r2.toFixed(0)}`); return `${r1.toFixed(0)} -> ${r2.toFixed(0)}`; });

  // ---------- two-hand twist rolls the view ----------
  const pair = (deg, r = 0.17) => { const a = deg * Math.PI / 180, dx = Math.cos(a) * r, dy = Math.sin(a) * r; return [['palm', 0.5 - dx, 0.55 - dy, 0.11], ['palm', 0.5 + dx, 0.55 + dy, 0.11]]; };
  await hold([]); await sleep(300);
  const ids = (await evalJs('window.mentorTwin.partsState()')).parts.map(p => p.id);
  const stageC = await evalJs("(r => [r.left + r.width / 2, r.top + r.height / 2])(document.getElementById('stage').getBoundingClientRect())");
  const angles = async () => { const out = {}; for (const id of ids) { const p = await evalJs(`window.mentorTwin.partScreen(${JSON.stringify(id)})`); if (p && Math.hypot(p[0] - stageC[0], p[1] - stageC[1]) > 60) out[id] = Math.atan2(p[1] - stageC[1], p[0] - stageC[0]); } return out; };
  const a0 = await angles();
  await play([...range(6, () => pair(0)), ...range(26, t => pair(35 * t))]); await sleep(200);
  const a1 = await angles(), roll1 = (await evalJs('window.mentorTwin.camera()')).roll;
  await shot('hands-v3-twist.png');
  await test('two hands twisted clockwise roll the model clockwise on screen', () => {
    assert.ok(roll1 > 0.3, `roll ${roll1}`);
    const turns = Object.keys(a0).filter(id => a1[id] != null).map(id => Math.atan2(Math.sin(a1[id] - a0[id]), Math.cos(a1[id] - a0[id])));
    assert.ok(turns.length >= 1, 'no part to watch'); const m = turns.sort((x, y) => x - y)[turns.length >> 1];
    assert.ok(m > 0.2, `parts turned ${m.toFixed(2)} rad on screen (clockwise > 0)`);
    return `roll ${(roll1 * 180 / Math.PI).toFixed(0)} deg, parts turned ${(m * 180 / Math.PI).toFixed(0)} deg`;
  });
  await hold([]); await sleep(300);

  // ---------- fist reset ----------
  await hold([['fist', 0.5, 0.5, S]]); await sleep(1300);
  await test('a held fist resets the view (and stands it upright)', async () => { await settle(); const c = await evalJs('window.mentorTwin.camera()'), r = c.radius; assert.ok(Math.abs(r - r0) / r0 < 0.05, `radius ${r.toFixed(0)} vs home ${r0.toFixed(0)}`); assert.ok(Math.abs(c.roll) < 1e-3, `roll ${c.roll}`); return `radius ${r.toFixed(0)}`; });

  // ---------- inertia: let go of a turn while moving and the view coasts to a stop ----------
  await hold([]); await sleep(300);
  {
    const p0 = { x: 0.3, y: 0.5 };
    const go = (x, o) => pinchAt({ x, y: p0.y }, S, o);
    await play([...range(6, () => [go(p0.x, { gap: 1 })]), ...range(6, () => [go(p0.x)]), ...range(10, t => [go(p0.x + 0.25 * t)]),
      ...range(7, (t, i) => [go(p0.x + 0.25 + 0.015 * (i + 1), { gap: 1.2 })])]);
    const t1 = (await evalJs('window.mentorTwin.camera()')).theta;
    await sleep(1400);
    const c2 = await evalJs('window.mentorTwin.camera()');
    await shot('hands-v3-coast.png');
    await test('a turn let go mid-move coasts on, then stops', () => {
      assert.ok(Math.abs(c2.theta - t1) > 0.05, `theta after release ${t1.toFixed(3)} -> ${c2.theta.toFixed(3)}`);
      assert.equal(c2.coasting, false, 'still coasting after 1.4 s'); return `coasted ${((c2.theta - t1) * 180 / Math.PI).toFixed(0)} deg`;
    });
    await evalJs("document.getElementById('t-reset').click()"); await settle();
  }

  // ---------- a tiny background hand changes nothing ----------
  await hold([]); await sleep(300);
  const c0 = await evalJs('window.mentorTwin.camera()');
  await play(range(30, t => [['pinch', 0.3 + 0.4 * t, 0.5, 0.035], ['fist', 0.7, 0.3, 0.03]]));
  await sleep(200);
  await test('tiny background hands are ignored', async () => { const c1 = await evalJs('window.mentorTwin.camera()'); assert.ok(Math.abs(c1.theta - c0.theta) < 1e-3 && Math.abs(c1.radius - c0.radius) < 0.5); assert.equal((await hs()).status, 'none'); return 'no change'; });
  await test('tester drawer shows the hand detector', async () => {
    const s = await hs(); await evalJs("document.getElementById('t-tester').click()"); await sleep(400);
    const t = await evalJs("document.getElementById('handPerf').textContent"); await shot('hands-v3-drawer-sim.png');
    await evalJs("document.getElementById('panelclose').click()"); assert.equal(t, 'Simulated'); assert.equal(s.perf, 'Simulated'); return t;
  });
  await test('Hands off stops everything (button toggles)', async () => { await evalJs("document.getElementById('t-hands').click()"); const s = await hs(); assert.equal(s.on, false); assert.equal(s.cursor, null); return 'off'; });
  await test('hands made no network requests beyond this laptop', () => {
    const outside = requests.filter(u => !u.startsWith(`http://localhost:${PORT}`) && !/^(data|blob):/.test(u) && !u.startsWith(`ws://localhost:${PORT}`));
    assert.deepEqual(outside, []); return `${requests.length} local requests`;
  });

  // ---------- coach remembered; reduced motion; blocked camera ----------
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await load('?handsim=1');
  await evalJs("document.getElementById('t-hands').click()"); await until('window.mentorTwin.handsState().on', 40, 200);
  await test('the coach does not reopen once seen; "How it works" opens it, reduced motion = still glyphs', async () => {
    assert.equal((await hs()).coach, false);
    await evalJs("document.getElementById('h-help').click()"); await sleep(100);
    const c = await evalJs("({ open: !document.getElementById('coach').hidden, anim: document.querySelectorAll('#coach animate, #coach animateTransform').length, svgs: document.querySelectorAll('#coach .coach-art svg').length })");
    assert.ok(c.open); assert.equal(c.anim, 0); assert.ok(c.svgs >= 1);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(100); assert.equal((await hs()).coach, false, 'Escape skips');
    return 'remembered';
  });
  await cdp('Emulation.setEmulatedMedia', { features: [] });
  await load('?handsim=deny');
  await evalJs("document.getElementById('t-hands').click()");
  const help = await until("(h => !h.hidden && h.textContent)(document.getElementById('handhelp'))", 30, 200);
  await test('blocked camera: a friendly message, Try again, and the keyboard / mouse way', async () => {
    assert.match(help || '', /camera is blocked/i); assert.match(help, /Try again/); assert.match(help, /drag to turn/i);
    await shot('hands-denied.png');
    assert.equal(await evalJs("document.getElementById('t-hands').getAttribute('aria-disabled')"), null, 'retry stays possible');
    await evalJs("[...document.querySelectorAll('#handhelp button')].find(b => b.textContent === 'Close').click()");
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'e', code: 'KeyE', text: 'e', windowsVirtualKeyCode: 69 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69 });
    assert.ok(await until('window.mentorTwin.boardState().explode > 0.5', 30, 200), 'E still explodes');
    return 'E works';
  });
  await test('no page errors', () => assert.deepEqual(errors, []));
  ws.close();
} finally {
  chrome.kill(); mock.kill();
  await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
