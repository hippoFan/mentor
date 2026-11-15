// A scripted, headless SHOWCASE RECORDING of the laptop app for the demo video: Home -> The Forge (newest scan, Build 3D
// if needed, rotate, filters, hover the downloads) -> rubber band Home -> Argo (E, R, H) -> Argos chat (one message) ->
// Settings -> Profile -> Home. Paced for a human viewer, with a drawn cursor (headless video has no real one).
// Read-only use of the page: never imports, deletes, edits settings or keys. The page's own socket is proxied so the
// hub's events reach the page but NOTHING the page would send up the socket reaches the hub (--ws readonly), or the socket
// is not opened at all (--ws off). Headless Chromium only: nothing appears on the screen.
//   node test/showcase-record.mjs                     the real run against the live hub (one Argos message, Build 3D allowed)
//   node test/showcase-record.mjs --dry               no Argos message, no Build 3D, socket off; the video is still saved
//   flags: --base http://localhost:8790  --out <dir>  --ws readonly|off  --build (allow Build 3D in --dry)  --no-chat
//          --msg "text"  --refine (select the newest design in Argos first, so the reply can start a refinement)
// Needs playwright-core: from node_modules if installed, else PLAYWRIGHT_CORE=/path/to/playwright-core (1.64.x).
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = flag('dry');
const BASE = opt('base', 'http://localhost:8790').replace(/\/$/, '');
const OUT = opt('out', fileURLToPath(new URL('../../logs/call-videos/', import.meta.url)));
const WS = opt('ws', DRY ? 'off' : 'readonly');
const BUILD = !DRY || flag('build');
const CHAT = !DRY && !flag('no-chat');
const MSG = opt('msg', 'Make a phone stand 80 mm wide');
const REFINE = flag('refine');
const W = 1920, H = 1080;

async function playwright() {
  try { return await import('playwright-core'); } catch { /* not installed here */ }
  const cands = [process.env.PLAYWRIGHT_CORE, join(homedir(), '.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core')].filter(Boolean);
  for (const p of cands) { const f = join(p, 'index.mjs'); if (existsSync(f)) return import(pathToFileURL(f).href); }
  console.error('playwright-core not found: set PLAYWRIGHT_CORE'); process.exit(2);
}
const { chromium } = await playwright();
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

// a drawn cursor: a dot that follows the mouse and squeezes on press (CSSOM only, so the page CSP is untouched)
const CURSOR = () => {
  const mk = () => {
    if (document.getElementById('__showcase-cursor')) return;
    const c = document.createElement('div'); c.id = '__showcase-cursor';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', margin: '-11px 0 0 -11px', borderRadius: '50%',
      background: 'rgba(255,255,255,.55)', border: '2px solid rgba(18,35,63,.9)', boxShadow: '0 2px 8px rgba(0,0,0,.35)', pointerEvents: 'none',
      zIndex: '2147483647', transform: 'translate(-100px,-100px)', transition: 'width .12s, height .12s, margin .12s, background .12s' });
    document.documentElement.append(c);
    addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, { capture: true, passive: true });
    addEventListener('mousedown', () => Object.assign(c.style, { width: '16px', height: '16px', margin: '-8px 0 0 -8px', background: 'rgba(234,135,47,.75)' }), true);
    addEventListener('mouseup', () => Object.assign(c.style, { width: '22px', height: '22px', margin: '-11px 0 0 -11px', background: 'rgba(255,255,255,.55)' }), true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mk); else mk();
};

await mkdir(OUT, { recursive: true });
const rawDir = await mkdtemp(join(tmpdir(), 'showcase-raw-'));
const browser = await chromium.launch({ headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [...(process.env.SHOWCASE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=gl']),   // headless on the laptop GPU
    '--ignore-gpu-blocklist', `--window-size=${W},${H}`] });
const problems = [];
let target = null;
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, acceptDownloads: false,
    reducedMotion: 'no-preference', recordVideo: { dir: rawDir, size: { width: W, height: H } } });
  await ctx.addInitScript(CURSOR);
  // the page socket: hub -> page only (readonly) or not at all (off). Nothing the page sends is ever forwarded.
  await ctx.routeWebSocket(/^wss?:\/\//, ws => {
    if (WS !== 'readonly') return;   // never connected: the page sees a silent socket
    const server = ws.connectToServer();
    ws.onMessage(() => { /* dropped: never forwarded to the hub */ });
    server.onMessage(m => ws.send(m));
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  // refuse any write the page could make, except the two this showcase means to: Build 3D (compile) and the Argos chat
  await page.route('**/argos/**', route => {
    const r = route.request(), u = new URL(r.url());
    if (r.method() === 'GET') return route.continue();
    const ok = (BUILD && /^\/argos\/designs\/[^/]+\/compile$/.test(u.pathname)) || (CHAT && u.pathname === '/argos/chat') || (CHAT && REFINE && u.pathname === '/argos/refine');
    if (!ok) { log(`blocked ${r.method()} ${u.pathname}`); return route.abort(); }
    return route.continue();
  });

  // ---- helpers: a mouse that glides, pauses a viewer can read ----
  const M = { x: W / 2, y: H / 2 };
  const pause = ms => page.waitForTimeout(ms);
  const glide = async (x, y, { speed = 1 } = {}) => {
    const d = Math.hypot(x - M.x, y - M.y), steps = Math.max(8, Math.min(40, Math.round(d / (14 * speed))));
    await page.mouse.move(x, y, { steps }); M.x = x; M.y = y;
  };
  const center = async sel => {
    const l = typeof sel === 'string' ? page.locator(sel).first() : sel;
    await l.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const b = await l.boundingBox(); if (!b) throw new Error(`not on screen: ${sel}`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
  };
  const hover = async (sel, ms = 1500) => { const c = await center(sel); await glide(c.x, c.y); await pause(ms); return c; };
  const click = async (sel, ms = 400) => { const c = await hover(sel, ms); await page.mouse.down(); await pause(90); await page.mouse.up(); return c; };
  const onPage = id => page.waitForFunction(p => window.odyPages?.page() === p, id, { timeout: 8000 });
  const visible = async sel => page.locator(sel).first().isVisible().catch(() => false);
  const key = async (k, ms) => { await page.keyboard.press(k); await pause(ms); };
  const wheelTo = async (scrollSel, el, { top = 140, ms = 1400 } = {}) => {   // an eased scroll a viewer can follow
    await page.evaluate(([sc, sel, top, ms]) => new Promise(done => {
      const box = document.querySelector(sc), e = document.querySelector(sel); if (!box || !e) return done();
      const from = box.scrollTop, to = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, from + e.getBoundingClientRect().top - top)), t0 = performance.now();
      const tick = now => { const k = Math.min(1, (now - t0) / ms), ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; box.scrollTop = from + (to - from) * ease; if (k < 1) requestAnimationFrame(tick); else done(); };
      requestAnimationFrame(tick);
    }), [scrollSel, el, top, ms]);
  };

  // ---- 1. Home ----
  log(`open ${BASE}/  (ws ${WS}, build ${BUILD ? 'on' : 'off'}, chat ${CHAT ? 'on' : 'off'})`);
  await page.goto(`${BASE}/#main`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.odyPages && document.fonts.status === 'loaded', null, { timeout: 20000 });
  await page.mouse.move(M.x, M.y);
  if (await page.evaluate(() => window.odyPages.page()) !== 'main') await page.evaluate(() => window.odyPages.goTo('main'));
  log('Home: let the pill settle'); await pause(3000);
  const pill = await center('.appbar .pager');
  log('Home: hover the pill (lift)');
  await glide(pill.x, pill.y + 140); await pause(500);
  await glide(pill.b.x + pill.b.width * 0.2, pill.y); await pause(1200);
  await glide(pill.b.x + pill.b.width * 0.5, pill.y, { speed: 0.4 }); await pause(900);
  await glide(pill.b.x + pill.b.width * 0.8, pill.y, { speed: 0.4 }); await pause(1200);
  await glide(W / 2, H * 0.55); await pause(1500);

  // ---- 2. The Forge ----
  log('Home -> The Forge (volcanic column)');
  await click('#page-main .home-column', 900);
  await onPage('forge');
  await page.waitForSelector('#page-forge #forge-h', { timeout: 15000 });
  await pause(2500);
  await page.waitForSelector('.forge-relic, .forge-empty:not([hidden])', { timeout: 10000 }).catch(() => {});
  const cards = await page.locator('.forge-relic:not([data-kind=circuit])').count();
  if (!cards) {
    log('The Forge: no designs yet, skipping the viewer');
    if (await visible('.forge-empty')) await hover('.forge-empty', 2500);
    if (await visible('.forge-import')) { log('The Forge: hover Import (no import)'); await hover('.forge-import', 1800); }
  } else {
    const scan = page.locator('.forge-relic[data-kind=scan]');
    const pick = (await scan.count()) ? scan.first() : page.locator('.forge-relic:not([data-kind=circuit])').first();
    const name = (await pick.locator('.forge-relic-name').textContent().catch(() => '')) || '(unnamed)';
    log(`The Forge: ${cards} design(s); open the newest ${await pick.getAttribute('data-kind')} "${name.trim()}"`);
    await hover(pick, 1200);
    await click(pick.locator('.forge-open'), 300);
    await page.waitForSelector('.forge-viewer:not([hidden])', { timeout: 5000 });
    await pause(2200);
    const hasModel = () => page.locator('.forge-stage[data-has=model]').count();
    if (!(await hasModel()) && await visible('.forge-build')) {
      const label = (await page.locator('.forge-build').textContent()).trim();
      if (label === 'Show 3D model') { log('viewer: Show 3D model'); await click('.forge-build', 900); }
      else if (BUILD) { log('viewer: Build 3D (OpenSCAD on this laptop)'); await click('.forge-build', 900); }
      else { log('viewer: would click Build 3D (skipped in --dry)'); await hover('.forge-build', 2000); }
    }
    const got = await page.waitForSelector('.forge-stage[data-has=model]', { timeout: BUILD ? 45000 : 12000 }).then(() => true, () => false);
    if (got) {
      log('viewer: model shown; rotate by dragging'); await pause(2000);
      const s = await center('.forge-stage canvas');
      await glide(s.x - 120, s.y); await pause(500);
      await page.mouse.down();
      for (let i = 0; i <= 40; i++) { const a = i / 40; await page.mouse.move(s.x - 120 + a * 320, s.y - Math.sin(a * Math.PI) * 60); await pause(25); }
      await page.mouse.up(); M.x = s.x + 200; M.y = s.y; await pause(1800);
      await page.mouse.down();
      for (let i = 0; i <= 40; i++) { const a = i / 40; await page.mouse.move(s.x + 200 - a * 260, s.y + Math.sin(a * Math.PI) * 50); await pause(25); }
      await page.mouse.up(); M.x = s.x - 60; M.y = s.y; await pause(2200);
    } else log('viewer: no 3D model to show (left the photo / message)');
    log('viewer: hover the downloads (no download)');
    for (const sel of ['.forge-dl-stl', '.forge-dl-scad', '.forge-dl-orig', '.forge-dl-ino']) {
      const l = page.locator(`.forge-viewer ${sel}`);
      for (let i = 0; i < await l.count(); i++) if (await l.nth(i).isVisible()) await hover(l.nth(i), 1300);
    }
    await pause(800);
    await click('.forge-back', 600); await pause(1500);
  }
  log('The Forge: filters');
  for (const f of ['call', 'refined', 'imported', 'all']) if (await visible(`.forge-filter[data-filter=${f}]`)) { await click(`.forge-filter[data-filter=${f}]`, 500); await pause(1300); }
  await pause(800);

  // ---- 3. rubber band back to Home, then Argo ----
  log('The Forge -> Home (rubber band)');
  await click('.pager a[data-go=main]', 700);
  await onPage('main'); await pause(2800);
  log('Home -> Argo (torn edge)');
  await click('#page-main .home-rip', 900);
  await onPage('argo'); await pause(3000);
  const st = await center('#stage');
  await glide(st.x, st.y); await pause(800);
  await page.evaluate(() => document.activeElement?.blur?.());
  if (await visible('#mode-circuit')) {   // the voice-built circuit, when the call made one
    log('Argo: Circuit view'); await click('#mode-circuit', 600); await pause(3000);
    await glide(st.x - 100, st.y); await page.mouse.down();
    for (let i = 0; i <= 30; i++) { await page.mouse.move(st.x - 100 + i * 8, st.y - Math.sin(i / 30 * Math.PI) * 40); await pause(25); }
    await page.mouse.up(); M.x = st.x + 140; M.y = st.y; await pause(2500);
    await click('#mode-board', 600); await pause(2000);
    await glide(st.x, st.y); await page.evaluate(() => document.activeElement?.blur?.());
  } else log('Argo: no circuit from a call, skipping the Circuit view');
  log('Argo: E explode'); await key('e', 3200);
  log('Argo: R reset view'); await key('r', 2500);
  log('Argo: E back together'); await key('e', 2500);
  const holo = async () => page.locator('#t-holo').getAttribute('aria-pressed');
  log(`Argo: H hologram -> realistic (was ${await holo()})`); await key('h', 3200);
  log(`Argo: H back (now ${await holo()})`); await key('h', 2500);

  // ---- 4. Argos ----
  log('Argo: open Argos');
  await click('#argos-btn', 700);
  await page.waitForSelector('#argos-panel:not([hidden])', { timeout: 5000 });
  await pause(2200);
  if (CHAT) {
    if (REFINE) {
      const id = await page.evaluate(async () => (await (await fetch('/argos/designs')).json()).designs.find(d => d.kind !== 'circuit' && !d.outside)?.id);
      if (id) { await page.selectOption('#argos-design', id); log(`Argos: design ${id} selected`); await pause(1000); }
    }
    const before = await page.locator('#argos-log .argos-msg').count();
    await click('#argos-text', 400);
    await page.keyboard.type(MSG, { delay: 70 }); await pause(1200);
    log(`Argos: send "${MSG}"`); await page.keyboard.press('Enter');
    const reply = await page.waitForFunction(n => { const m = [...document.querySelectorAll('#argos-log .argos-msg')].slice(n); return m.some(x => x.classList.contains('dog')) && m.filter(x => x.classList.contains('dog')).at(-1).textContent; }, before, { timeout: 60000 }).then(h => h.jsonValue(), () => null);
    log(`Argos reply: ${reply ? reply.replace(/\s+/g, ' ').slice(0, 160) : '(none within 60 s)'}`);
    await pause(3500);
    // a refinement it started streams steps; wait for it to finish (or 2 min)
    if (await page.locator('#argos-log .argos-msg.step').count() || /^Refining|^Multicode/.test(await page.locator('#argos-log .argos-msg').last().textContent())) {
      log('Argos: refinement running');
      await page.waitForFunction(() => /Download STL|Couldn’t finish/.test(document.getElementById('argos-log').innerText), null, { timeout: 120000 }).catch(() => log('Argos: refinement still running after 2 min'));
      await pause(3000);
    }
  } else { log('Argos: message skipped (--dry)'); await hover('#argos-text', 2000); }
  log('Argos: close'); await click('#argos-close', 600); await pause(1500);

  // ---- 5. avatar menu: Settings, Profile, Home ----
  log('avatar menu -> Settings');
  await click('#profile-btn', 600);
  await page.waitForSelector('#profile-menu:not([hidden])'); await pause(1800);
  await click(page.locator('#profile-menu [role=menuitem]', { hasText: 'Settings' }), 600);
  await onPage('settings'); await pause(2500);
  await glide(W * 0.78, H * 0.55);
  for (const h of ['#h-voice', '#h-look', '#h-priv']) { log(`Settings: ${h}`); await wheelTo('#page-settings', h, { top: 180 }); await pause(2000); }
  await wheelTo('#page-settings', '#settings-h', { top: 200 }); await pause(1200);
  log('avatar menu -> Profile');
  await click('#profile-btn', 600);
  await page.waitForSelector('#profile-menu:not([hidden])'); await pause(1500);
  await click(page.locator('#profile-menu [role=menuitem]', { hasText: 'Profile' }), 600);
  await onPage('profile'); await pause(3000);
  log('-> Home');
  await click('.pager a[data-go=main]', 700);
  await onPage('main'); await pause(3500);

  const video = page.video();
  await ctx.close();
  target = join(OUT, `showcase-${DRY ? 'dry-' : ''}${stamp()}.webm`);
  await video.saveAs(target); await video.delete();
  log(`saved ${target}`);
} catch (e) {
  console.error(`showcase failed: ${e.message.split('\n')[0]}`); process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  await rm(rawDir, { recursive: true, force: true });
}
if (problems.length) console.log(`page errors (${problems.length}):\n  ${[...new Set(problems)].slice(0, 12).join('\n  ')}`);
if (target) console.log(target);
