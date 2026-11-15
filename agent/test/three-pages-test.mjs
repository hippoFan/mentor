// The three-page app in a real browser (headless Chrome over CDP): Main is home, Argo and The Forge switch without a
// reload (pager, edge tabs, ← → keys), a live call keeps updating Argo while another page shows, the Argos panel opens
// only on Argo, a Gemini key set on Main flips Argos's model picker to ready without a reload, no full key ever reaches
// the DOM or a response, reduced motion stops every animation, and no console errors. Real live.mjs + argos/server.mjs
// on :8796 with a temp designs folder and a temp .env (ARGOS_ENV_FILE): never the live 8790, never the real .env.
//   node test/three-pages-test.mjs            screenshots: ../docs/app-{argo,main,forge}.png, ~/.playwright-mcp/pages-*.png
//   node test/three-pages-test.mjs --serve    just the seeded server on http://localhost:8796 (for looking at it)
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import WebSocket from 'ws';

const PORT = Number(process.env.PAGES_PORT || 8796), DEBUG = 9356;
if (PORT === 8790) { console.error('8790 is the live hub; pick another port'); process.exit(2); }
const SERVE = process.argv.includes('--serve');
const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const SHOTS = join(homedir(), '.playwright-mcp');
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the page server, seeded: no keys, one scanned design, one refined design ----
const dir = await mkdtemp(join(tmpdir(), 'ody-pages-'));
process.env.ARGOS_DESIGNS_DIR = join(dir, 'designs');
process.env.ARGOS_ENV_FILE = join(dir, 'test.env');
process.env.MENTOR_MONITOR_PORT = String(PORT);
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ARGOS_OPENAI_KEY', 'ARGOS_OPENAI_BASE', 'ARGOS_OPENAI_MODEL', 'ELEVENLABS_API_KEY', 'ELEVEN_API_KEY', 'CHERT_API_KEY']) delete process.env[k];
await writeFile(process.env.ARGOS_ENV_FILE, '# test settings\nKEEP=1\n', { mode: 0o600 });
const { createLiveServer } = await import('../live.mjs');
const { createArgos } = await import('../argos/server.mjs');
let argos;
const live = await createLiveServer({ onPageMessage: m => argos.onPageMessage(m), routes: (req, res) => argos.route(req, res) });
argos = createArgos({ send: e => live.send(e) });
argos.onPublished({ type: 'call', state: 'live' });
argos.onPublished({ type: 'scan', spec: { name: 'Sensor lamp', parts: [{ name: 'Base', shape: 'box', size_mm: { x: 60, y: 40, z: 12 } }, { name: 'Shade', shape: 'cylinder', size_mm: { x: 40, y: 40, z: 30 } }] } });
await sleep(800);
const base = `http://localhost:${PORT}`;
if (SERVE) { console.log(`three pages on ${base}  (designs + .env in ${dir}; Ctrl+C to stop)`); await new Promise(() => {}); }

let pass = 0, fail = 0;
const test = async (name, fn) => { try { const d = await fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
await mkdir(SHOTS, { recursive: true }); await mkdir(DOCS, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'pages-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
const KEY = 'AIzaPagesTestOnly0000NotReal9Q7Z';
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  let id = 0; const wait = new Map(), errors = [], bodies = [];
  ws.on('message', m => {
    const d = JSON.parse(m);
    if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text || 'exception');
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(`console.error ${d.params.args.map(a => a.value ?? a.description).join(' ')}`.slice(0, 300));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(`log ${d.params.entry.text} ${d.params.entry.url || ''}`.slice(0, 300));
    if (d.method === 'Network.responseReceived' && /\/argos\//.test(d.params.response.url)) bodies.push(d.params.requestId);
  });
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
  const until = async (expr, tries = 60, ms = 200) => { for (let i = 0; i < tries; i++) { const v = await evalJs(expr).catch(() => null); if (v) return v; await sleep(ms); } return null; };
  const shot = async (...paths) => { const s = await cdp('Page.captureScreenshot', { format: 'png' }); for (const p of paths) { await writeFile(p, Buffer.from(s.result.data, 'base64')); console.log(`      ${p}`); } };
  const key = async (k, code, vk) => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
  const click = sel => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ${sel.replace(/'/g, '')}'); e.click(); return true; })()`);
  const visible = sel => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.closest('[inert]'); })()`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Page.enable'); await cdp('Log.enable');
  await cdp('Page.navigate', { url: `${base}/` });
  await until('window.odyPages && window.odyMain && document.fonts.status === "loaded"', 80);
  await sleep(1200);

  await test('Home is home: v2 shell, app bar with the Ody logo, nav says Home (no roman numerals), edges to Argo and The Forge', async () => {
    assert.equal(await evalJs('window.odyPages.v2'), true);
    assert.equal(await evalJs('window.odyPages.page()'), 'main');
    assert.equal(await evalJs('document.querySelector(".pager [aria-current=page]").dataset.go'), 'main');
    assert.deepEqual(await evalJs('[...document.querySelectorAll(".pager a")].map(a => a.dataset.go)'), ['argo', 'main', 'forge']);
    assert.deepEqual(await evalJs('[...document.querySelectorAll(".pager a")].map(a => a.textContent.trim() || a.getAttribute("aria-label"))'), ['Argo', 'Home', 'Forge']);
    assert.ok(await visible('.pager .nav-logo[aria-current=page] svg.logo'), 'the Ody wordmark is Home, highlighted');
    assert.ok(await visible('#profile-btn'), 'avatar in the app bar');
    assert.deepEqual(await evalJs('[...document.querySelectorAll("#page-main .home-rip, #page-main .home-column")].map(t => [t.dataset.go, t.getAttribute("aria-label")])'), [['argo', 'Go to Argo'], ['forge', 'Go to The Forge']]);
    assert.equal(await visible('#argos-btn'), false, 'the Argos button shows only on Argo');
  });
  await test('nav pill: says "Forge" (named The Forge for screen readers); rests after ~2.5 s (logo stays, greyer), wakes on pointer near, focus or a move', async () => {
    assert.equal(await evalJs('document.querySelector(".pager a[data-go=forge]").textContent.trim()'), 'Forge');
    assert.equal(await evalJs('document.querySelector(".pager a[data-go=forge]").getAttribute("aria-label")'), 'The Forge');
    assert.equal(await evalJs('document.getElementById("forge-h")?.textContent.trim() ?? "The Forge"'), 'The Forge', 'the page title stays The Forge');
    const op = sel => evalJs(`+getComputedStyle(document.querySelector(${JSON.stringify(sel)})).opacity`);
    const mouse = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await evalJs('document.activeElement?.blur(); true');
    await mouse(640, 600);
    assert.ok(await until('document.querySelector(".pager").classList.contains("idle")', 40, 200), 'pill rests after ~2.5 s');
    await sleep(800);
    assert.ok((await op('.pager a[data-go=argo]')) < 0.05, 'Argo link faded');
    assert.ok((await op('.pager a[data-go=forge]')) < 0.05, 'Forge link faded');
    const logo = await op('.pager .nav-logo');
    assert.ok(logo > 0.5 && logo < 0.8, `logo stays, greyer (${logo})`);
    assert.match(await evalJs('getComputedStyle(document.querySelector(".pager .nav-logo")).filter'), /grayscale/);
    assert.equal(await evalJs('getComputedStyle(document.querySelector(".pager a[data-go=forge]")).visibility'), 'visible', 'opacity only: still focusable');
    await mouse(640, 60);
    assert.ok(await until('!document.querySelector(".pager").classList.contains("idle")', 10, 50), 'pointer near the top wakes it');
    await sleep(400);
    assert.ok((await op('.pager a[data-go=forge]')) > 0.95, 'Forge link back');
    await mouse(640, 600);
    assert.ok(await until('document.querySelector(".pager").classList.contains("idle")', 40, 200));
    await evalJs('document.querySelector(".pager a[data-go=forge]").focus(); true');
    assert.ok(await until('!document.querySelector(".pager").classList.contains("idle")', 10, 50), 'keyboard focus wakes it');
    await evalJs('document.activeElement?.blur(); true');
    return `logo ${logo}`;
  });
  await test('profile menu: Profile, Settings, Sign in; a local profile only (no passwords), Sign out forgets it', async () => {
    await click('#profile-btn');
    assert.ok(await until('!document.getElementById("profile-menu").hidden'));
    const items = await evalJs('[...document.querySelectorAll("#profile-menu [role=menuitem]")].map(b => b.textContent.trim())');
    assert.deepEqual(items, ['Profile', 'Settings', 'Sign in']);
    assert.match(await evalJs('document.getElementById("profile-menu").innerText'), /Local profile on this laptop — accounts coming soon/);
    await key('Escape', 'Escape', 27);
    assert.ok(await until('document.getElementById("profile-menu").hidden'));
    await evalJs('window.odyPages.goTo("profile")'); await sleep(500);
    assert.equal(await evalJs('document.querySelectorAll("#page-profile input[type=password]").length'), 0, 'no password field');
    await evalJs('document.getElementById("pf-name").value = "Ada Lovelace"; document.querySelector("#page-profile form").requestSubmit()');
    assert.ok(await until('document.getElementById("profile-btn").textContent === "AL"'));
    assert.match(await evalJs('localStorage.getItem("ody.profile")'), /Ada Lovelace/);
    await click('#profile-btn');
    assert.deepEqual(await evalJs('[...document.querySelectorAll("#profile-menu [role=menuitem]")].map(b => b.textContent.trim())'), ['Profile', 'Settings', 'Sign out']);
    await evalJs('[...document.querySelectorAll("#profile-menu [role=menuitem]")].at(-1).click()');
    assert.ok(await until('localStorage.getItem("ody.profile") === null && document.getElementById("profile-btn").classList.contains("guest")'));
    await evalJs('window.odyPages.goTo("main")'); await sleep(500);
  });
  await test('Main: every number is real, Demo or Not tracked; fonts are the deck faces', async () => {
    await until('document.querySelector("#m-usage .usage .t-num")?.textContent !== "–"');
    const txt = await evalJs('document.getElementById("page-main").innerText');
    assert.match(txt, /Demo: Explorer plan/); assert.match(txt, /Not tracked/); assert.match(txt, /Frontier: not hardened/);
    assert.match(txt, /Running \d/); assert.doesNotMatch(txt, /\$\s?\d/);
    const fonts = await evalJs('[...document.fonts].filter(f => f.status === "loaded").map(f => f.family.replace(/"/g, ""))');
    for (const f of ['GFS Theokritos', 'Cooper Hewitt']) assert.ok(fonts.includes(f), `${f} loaded`);
    assert.ok(!fonts.some(f => /Cinzel|Inter/.test(f)), 'one display face + one text face only');
    const small = await evalJs('[...document.querySelectorAll("#page-main *")].filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && e.getClientRects().length).map(e => parseFloat(getComputedStyle(e).fontSize)).filter(s => s < 16).length');
    assert.equal(small, 0, 'no text under 16px on Main');
    return `fonts: ${[...new Set(fonts)].join(', ')}`;
  });
  await shot(join(DOCS, 'app-main.png'), join(SHOTS, 'pages-main.png'));

  await evalJs('window.odyPages.goTo("settings")'); await sleep(500);
  await test('Settings: a Gemini key set here flips Argos’s model picker to ready, no reload, no full key anywhere', async () => {
    assert.match(await evalJs('document.getElementById("argos-provider").innerText'), /Gemini \(no key\)/);
    await click('#m-act-gemini');
    await until('document.querySelector("#m-in-GEMINI_API_KEY")');
    assert.equal(await evalJs('document.querySelector("#m-in-GEMINI_API_KEY").type'), 'password');
    await evalJs(`document.querySelector("#m-in-GEMINI_API_KEY").focus()`);
    await cdp('Input.insertText', { text: KEY });
    await key('ArrowLeft', 'ArrowLeft', 37);   // typing in a field never switches pages
    assert.equal(await evalJs('window.odyPages.page()'), 'settings');
    await evalJs('document.querySelector("#m-keys .key-edit").requestSubmit()');
    assert.ok(await until('!document.querySelector("#m-in-GEMINI_API_KEY") && /····9Q7Z/.test(document.getElementById("m-keys").innerText)'), 'the row shows the last 4');
    const opt = await until('(() => { const o = document.querySelector("#argos-provider option[value=gemini]"); return o && !o.disabled && /ready/.test(o.textContent) ? o.textContent : null; })()');
    assert.ok(opt, 'Argos picker shows Gemini ready');
    assert.equal(await evalJs('document.getElementById("argos-provider").value'), 'gemini');
    assert.equal(await evalJs('performance.getEntriesByType("navigation").length'), 1);
    const html = await evalJs('document.documentElement.outerHTML + [...document.querySelectorAll("input")].map(i => i.value).join(" ")');
    assert.ok(!html.includes(KEY) && !html.includes(KEY.slice(0, 20)), 'DOM never holds the key');
    for (const rid of bodies) { const b = await cdp('Network.getResponseBody', { requestId: rid }); assert.ok(!(b.result?.body || '').includes(KEY), 'no response carries the key'); }
    for (const p of ['/argos/keys', '/argos/state']) assert.ok(!(await (await fetch(base + p)).text()).includes(KEY));
    return opt;
  });
  await test('Settings: a base URL off the allowlist is refused with a readable error', async () => {
    await click('#m-act-openai'); await until('document.querySelector("#m-in-ARGOS_OPENAI_BASE")');
    await evalJs('document.querySelector("#m-in-ARGOS_OPENAI_BASE").value = "https://evil.example/v1"; document.querySelector("#m-keys .key-edit").requestSubmit()');
    const t = await until('[...document.querySelectorAll("#m-toasts [role=alert]")].map(e => e.textContent).join(" ")');
    assert.match(t, /base URL must be/); await evalJs('document.querySelectorAll("#m-toasts [role=alert] button").forEach(b => b.click())');
    await click('#m-act-openai');
  });

  await evalJs('window.odyPages.goTo("main")'); await sleep(500);
  await test('→ / ← keys and the edge tab switch pages without a reload; Argo shows the Argos button', async () => {
    await evalJs('document.activeElement?.blur()');
    await key('ArrowLeft', 'ArrowLeft', 37);
    assert.ok(await until('window.odyPages.page() === "argo" && !document.getElementById("page-argo").classList.contains("off")'));
    await sleep(500);
    assert.equal(await visible('#argos-btn'), true);
    assert.ok(await until('[...document.querySelectorAll(".home-rip, .home-column")].every(t => t.closest("[hidden]"))'), 'Home (and its edges) hidden once the push lands');
    assert.equal(await evalJs('performance.getEntriesByType("navigation").length'), 1);
  });
  live.send({ type: 'call', state: 'live', since: Date.now() - 125_000 });
  live.send({ type: 'step', text: 'Plug the USB-C cable into the board' });
  await sleep(700);
  await shot(join(DOCS, 'app-argo.png'), join(SHOTS, 'pages-argo.png'));
  await test('Argo keeps every function: hologram stage, phone, voyage, talk, parts, pins, tester T, privacy, shortcuts', async () => {
    for (const s of ['#stage canvas#view', '#phone', '#voyage', '#log', '#pins', '#t-tester', 'a[href="/privacy"]', '#keysOpen', '#t-holo', '#t-hands', '#export'])
      assert.ok(await evalJs(`!!document.querySelector(${JSON.stringify(s)})`), s);
    await key('t', 'KeyT', 84);
    assert.ok(await until('!document.getElementById("panel").hidden'), 'T opens the tester');
    await key('Escape', 'Escape', 27);
    await click('#keysOpen'); assert.ok(await until('!document.getElementById("keysheet").hidden'), 'shortcuts sheet');
    await key('Escape', 'Escape', 27);
    assert.match(await evalJs('document.getElementById("status").textContent'), /Live 2:0/);
  });
  await test('Argos panel opens on Argo, with chat and refine tabs, model and design pickers, multicode, record', async () => {
    await click('#argos-btn');
    assert.ok(await until('!document.getElementById("argos-panel").hidden'));
    await click('#argos-tab-refine');
    for (const s of ['#argos-provider', '#argos-design', '#argos-multi', '#argos-mic', '#argos-text', '#argos-log']) assert.ok(await visible(s), s);
    await sleep(400);
  });
  await shot(join(SHOTS, 'pages-argos-panel.png'));
  await click('#argos-close');

  await test('The Forge mounts on first show (pager click)', async () => {
    await click('.pager a[data-go="forge"]');
    assert.ok(await until('window.odyPages.page() === "forge" && document.getElementById("page-forge").children.length > 0', 80));
    await sleep(1500);
    const fallback = await evalJs('!!document.querySelector("#page-forge .forge-fallback")');
    assert.ok(!fallback, 'forge.js mounted (no fallback)');
    assert.ok(await evalJs('!!document.querySelector("#page-forge #forge-h")'));
  });
  await shot(join(DOCS, 'app-forge.png'), join(SHOTS, 'pages-forge.png'));
  await test('openRefine(id): Argo, Argos panel open on Refine with that design selected', async () => {
    const id = (await (await fetch(`${base}/argos/designs`)).json()).designs[0].id;
    await evalJs(`window.odyPages.openRefine(${JSON.stringify(id)})`);
    assert.ok(await until(`window.odyPages.page() === "argo" && !document.getElementById("argos-panel").hidden && document.getElementById("argos-tab-refine").getAttribute("aria-selected") === "true" && document.getElementById("argos-design").value === ${JSON.stringify(id)}`));
    await click('#argos-close'); await evalJs('window.odyPages.goTo("forge")'); await sleep(500);
  });
  await test('a live call keeps updating Argo while The Forge shows (hidden pages get every event)', async () => {
    live.send({ type: 'step', text: 'Move the red wire to pin 13' });
    assert.ok(await until('window.odyShell.state().step === "Move the red wire to pin 13" && /pin 13/.test(document.getElementById("step").textContent)'));
    assert.equal(await evalJs('window.odyPages.page()'), 'forge');
    assert.equal(await visible('#argos-btn'), false);
  });
  await test('Argo’s letter shortcuts never act on another page', async () => {
    const before = await evalJs('document.getElementById("panel").hidden');
    await key('t', 'KeyT', 84);
    assert.equal(await evalJs('document.getElementById("panel").hidden'), before);
  });
  // the agent's view commands must land in the hologram the caller sees: Argo, the Board mode, the hologram look
  const { createProject, apply, fastPlan, circuitEvent } = await import('../circuit.mjs');
  await test('on Home, a twin explode → Argo, Board mode, hologram, exploded', async () => {
    live.send({ type: 'part', model: 'uno-r4-wifi', label: 'Arduino UNO R4 WiFi' });
    await sleep(400);
    await evalJs('window.mentorTwin.setLook(false)');
    await evalJs('window.odyPages.goTo("main")'); await sleep(600);
    assert.equal(await evalJs('window.odyPages.page()'), 'main');
    live.send({ type: 'twin', action: 'explode' });
    assert.ok(await until('window.odyPages.page() === "argo" && window.mentorTwin.scanState().view === "board" && window.mentorTwin.state().holo && window.mentorTwin.state().explode > 0.95', 60), JSON.stringify(await evalJs('({ page: window.odyPages.page(), view: window.mentorTwin.scanState().view, ...window.mentorTwin.state() })')));
    assert.ok(await until('!document.getElementById("page-argo").classList.contains("off")'));
    return `explode ${(await evalJs('window.mentorTwin.state().explode')).toFixed(2)}`;
  });
  await test('after a circuit event (Argo shows Circuit), a twin remove of the ESP32 module → Board mode, part in the tray', async () => {
    live.send({ type: 'twin', action: 'assemble' }); await sleep(300);
    await evalJs('window.odyPages.goTo("forge")'); await sleep(600);
    let st = createProject({ board: 'uno-r4-wifi' }); const r = apply(st, fastPlan(st, 'add a distance sensor').actions); st = r.state;
    live.send({ ...circuitEvent(st, r) });
    assert.ok(await until('window.odyPages.page() === "argo" && window.mentorTwin.scanState().view === "circuit"', 60), 'circuit shown on Argo');
    live.send({ type: 'twin', action: 'remove', target: 'ESP32 module' });
    assert.ok(await until('window.mentorTwin.scanState().view === "board" && window.mentorTwin.partsState().scope === "board" && window.mentorTwin.partsState().parts.some(p => p.id === "esp32" && p.removed)', 60), JSON.stringify(await evalJs('window.mentorTwin.partsState()')));
    assert.ok(await until('!document.getElementById("trayBox").hidden && /ESP32/.test(document.getElementById("tray").textContent)'), 'in the tray');
    assert.ok(await evalJs('window.mentorTwin.state().holo'));
    live.send({ type: 'twin', action: 'restore' }); await sleep(400);
  });
  await test('reduced motion: no animations at all, instant page cuts', async () => {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evalJs(`window.odyPages.goTo("main")`); await sleep(300);
    assert.equal(await evalJs('window.odyPages.page()'), 'main');
    const run = await evalJs('document.getAnimations().filter(a => a.playState === "running" && !(a instanceof CSSTransition && a.effect.getTiming().duration <= 1)).map(a => `${a.animationName || a.constructor.name} on ${a.effect?.target?.id || a.effect?.target?.className?.baseVal || a.effect?.target?.className || a.effect?.target?.tagName}`)');
    assert.deepEqual(run, []);
    await cdp('Emulation.setEmulatedMedia', { features: [] });
  });
  await test('no horizontal scroll at 1280×800 on any page', async () => {
    for (const p of ['main', 'argo', 'forge', 'profile', 'settings']) { await evalJs(`window.odyPages.goTo("${p}")`); await sleep(450); assert.ok(await evalJs('document.documentElement.scrollWidth <= 1280 && document.body.scrollWidth <= 1280'), p); }
  });
  const errCount = errors.length;
  await test('an older page server (no /twin/app.css) still gets the one-page Argo app, unchanged', async () => {
    await cdp('Network.setBlockedURLs', { urls: ['*/twin/app.css', '*/twin/odyssey.css', '*/fonts/CooperHewitt-500.woff2'] });
    await cdp('Page.navigate', { url: `${base}/` });
    await until('window.odyPages && window.odyShell', 80); await sleep(1500);
    assert.equal(await evalJs('window.odyPages.v2'), false);
    assert.ok(await visible('#stage') && await visible('#t-tester') && await visible('#argos-btn') && await visible('.rail'));
    assert.equal(await visible('#page-main'), false); assert.equal(await visible('.pager'), false); assert.equal(await visible('.home-rip'), false); assert.equal(await visible('.appbar'), false);
    assert.equal(await evalJs('getComputedStyle(document.body).display'), 'grid');
    await shot(join(SHOTS, 'pages-legacy-fallback.png'));
    errors.splice(errCount);   // the blocked stylesheets themselves log errors
    await cdp('Network.setBlockedURLs', { urls: [] });
  });
  await test('no console errors or exceptions', async () => {
    const expected = /status of 400 .*\/argos\/keys/;   // the refused base URL above, on purpose
    assert.deepEqual(errors.filter(e => !expected.test(e)), []);
  });
} finally {
  chrome.kill(); await new Promise(r => chrome.once('exit', r)); await live.close(); await rm(profile, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
