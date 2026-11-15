// QA driver for the one-page Ody app. Starts its own mock (test/mock-twin.mjs on :8796, never 8790), drives headless
// Chromium (SwiftShader, no window) and writes screenshots to ~/.playwright-mcp/app-*.png plus a JSON of findings.
//   node test/qa/qa-app.mjs [quick]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire('/home/plopee/zybooks-automation/');
const { chromium } = require('playwright-core');
const O = '/home/plopee/.playwright-mcp/', PORT = 8796, B = `http://localhost:${PORT}`;
const quick = process.argv.includes('quick');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { errors: [], external: [], csp: [], checks: {} };
function mock(extra, env = {}) {
  const m = spawn(process.execPath, ['test/mock-twin.mjs', '--port', String(PORT), ...extra], { cwd: new URL('../..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  return new Promise((res, rej) => { m.stdout.on('data', d => { if (/twin on/.test(String(d))) res(m); }); m.on('exit', c => rej(new Error('mock exited ' + c))); });
}
const br = await chromium.launch({ executablePath: '/home/plopee/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function open(w, h, path = '/') {
  const ctx = await br.newContext({ viewport: { width: w, height: h }, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => { addEventListener('securitypolicyviolation', e => { (window.__csp ||= []).push(e.violatedDirective + ' ' + e.blockedURI); }); });
  page.on('console', m => { if (m.type() === 'error') out.errors.push(`${w}: ${m.text()}`); });
  page.on('pageerror', e => out.errors.push(`${w} pageerror: ${e.message}`));
  page.on('request', r => { const u = r.url(); if (!u.startsWith(B) && !u.startsWith('data:') && !u.startsWith('blob:')) out.external.push(u); });
  await page.goto(B + path);
  return { ctx, page };
}
const shot = (p, n) => p.screenshot({ path: O + 'app-' + n + '.png' });
const until = async (page, fn, arg, ms = 30000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 200 });
const csp = async page => { const v = await page.evaluate(() => window.__csp || []); out.csp.push(...v); };
let m;
try {
  // ---- 1440: the full call, with video, voice commands, scans, done, ended ----
  m = await mock(['--video', '--scan-demo', '--end'], { MOCK_GAP_MS: '4500' });
  let { ctx, page } = await open(1440, 900);
  await sleep(900); await shot(page, '1440-waiting');
  out.checks.waitingTitle = await page.locator('#waitTitle').textContent();
  await until(page, () => window.mentorTwin?.state().model === 'uno-r4-wifi');
  await until(page, () => window.mentorTwin.state().wires.length > 0); await sleep(2600); await shot(page, '1440-wire');
  out.checks.fitted = await page.evaluate(() => window.mentorTwin.fitted());
  out.checks.labelsBeforeWire = null;
  await until(page, () => /exploded/.test(document.getElementById('toast').textContent) && !document.getElementById('toast').hidden);
  await sleep(2500); await shot(page, '1440-voice-explode');
  out.checks.toast = await page.locator('#toast').textContent();
  await until(page, () => window.mentorTwin.state().marks.some(m => m.kind === 'warn')); await sleep(2200); await shot(page, '1440-warn');
  out.checks.labelBoxes = await page.evaluate(() => window.mentorTwin.labelBoxes());
  await until(page, () => window.mentorTwin.scanState().current === 'Coffee mug'); await sleep(2000); await shot(page, '1440-scan');
  // swap views
  await page.keyboard.press('v'); await sleep(1200); await shot(page, '1440-swapped');
  await page.keyboard.press('v'); await sleep(600);
  await until(page, () => window.odyShell.state().done); await sleep(1500); await shot(page, '1440-done');
  // tester drawer
  await page.keyboard.press('t'); await sleep(600); await shot(page, '1440-tester');
  out.checks.testerFocus = await page.evaluate(() => document.activeElement.id);
  await page.keyboard.press('Escape'); await sleep(300);
  out.checks.testerClosedFocus = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
  await until(page, () => window.odyShell.phase() === 'ended', null, 20000); await sleep(800); await shot(page, '1440-ended');
  out.checks.endedStatus = await page.locator('#status').textContent();
  // keyboard: export focus restore, pins listbox, orbit
  await page.locator('#export').focus(); const dl = page.waitForEvent('download', { timeout: 10000 });
  await page.keyboard.press('Enter'); const d = await dl; out.checks.exportName = d.suggestedFilename();
  await sleep(600); out.checks.focusAfterExport = await page.evaluate(() => document.activeElement.id);
  await page.evaluate(() => window.mentorTwin.showScan(-1)); await sleep(1500);
  await page.locator('#pins').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await sleep(500);
  out.checks.pinTip = await page.locator('#tip').evaluate(e => e.hidden ? null : e.innerText.replace(/\n/g, ' | '));
  out.checks.announce = await page.locator('#announce').textContent();
  await shot(page, '1440-pintip');
  await page.locator('#stage').focus(); const before = await page.evaluate(() => window.mentorTwin.fitted().theta);
  await page.keyboard.press('ArrowLeft'); await sleep(400); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('+'); await sleep(1500);
  out.checks.orbit = { before, after: await page.evaluate(() => window.mentorTwin.fitted().theta) };
  out.checks.hands = await page.locator('#t-hands').evaluate(e => ({ hidden: e.hidden, disabled: e.getAttribute('aria-disabled'), text: e.textContent, why: document.getElementById('handsWhy').textContent }));
  await page.locator('#t-hands').click(); await sleep(5000);
  out.checks.handsAfter = await page.locator('#t-hands').evaluate(e => ({ hidden: e.hidden, disabled: e.getAttribute('aria-disabled'), text: e.textContent, toast: document.getElementById('toast').textContent }));
  // tab order sanity
  await page.evaluate(() => document.activeElement.blur()); const tabs = [];
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); tabs.push(await page.evaluate(() => { const a = document.activeElement; return (a.id || a.tagName) + ':' + (a.textContent || '').trim().slice(0, 18); })); }
  out.checks.tabs = tabs;
  out.checks.overflow = await page.evaluate(() => document.documentElement.scrollWidth);
  await csp(page); await ctx.close();
  // reconnecting: kill the mock
  ({ ctx, page } = await open(1280, 800));
  await until(page, () => window.mentorTwin?.state().model === 'uno-r4-wifi' && window.odyShell.phase() !== 'connecting');
  await sleep(quick ? 1000 : 7000); await shot(page, '1280-live');
  // voice export with no click on this page -> "Export ready, Click to save"
  // (Playwright's evaluate counts as a user gesture, so pretend there was none: the path a voice command takes)
  await page.evaluate(() => { Object.defineProperty(navigator, 'userActivation', { value: { isActive: false, hasBeenActive: false } }); window.mentorTwin.voice('export'); });
  await sleep(2500); await shot(page, '1280-voice-export');
  out.checks.voiceExport = await page.locator('#toast').innerText();
  m.kill(); await sleep(2500); await shot(page, '1280-reconnecting');
  out.checks.reconnecting = { phase: await page.evaluate(() => window.odyShell.phase()), status: await page.locator('#status').textContent(), dot: await page.locator('.status .dot').evaluate(e => getComputedStyle(e).backgroundColor) };
  m = await mock(['--custom'], { MOCK_GAP_MS: '3000', MOCK_START_MS: '300' });
  await until(page, () => window.mentorTwin.state().model === 'custom', null, 20000); await sleep(4500); await shot(page, '1280-custom');
  out.checks.custom = await page.evaluate(() => ({ ...window.mentorTwin.boardState(), wires: window.mentorTwin.state().wires }));
  await csp(page); await ctx.close(); m.kill(); await sleep(800);
  // 390 phone + long text
  m = await mock(['--part', 'esp32-devkit-v1'], { MOCK_GAP_MS: '3000', MOCK_START_MS: '300' });
  ({ ctx, page } = await open(390, 844));
  await until(page, () => window.mentorTwin?.state().model === 'esp32-devkit-v1'); await sleep(4500); await shot(page, '390-esp32');
  out.checks.overflow390 = await page.evaluate(() => document.documentElement.scrollWidth);
  await page.screenshot({ path: O + 'app-390-full.png', fullPage: true });
  await csp(page); await ctx.close(); m.kill(); await sleep(800);
  m = await mock(['--part', 'raspberry-pi-4'], { MOCK_GAP_MS: '3000', MOCK_START_MS: '300' });
  ({ ctx, page } = await open(1440, 900, '/twin'));
  await until(page, () => window.mentorTwin?.state().model === 'raspberry-pi-4'); await sleep(4500); await shot(page, '1440-pi4');
  await csp(page); await ctx.close();
} catch (e) { out.fatal = String(e.stack || e); }
finally { m?.kill(); await br.close(); }
fs.writeFileSync(O + 'app-qa.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
