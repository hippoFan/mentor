// The voice circuit builder inside the app: mock-twin --circuit on :8796 (never 8790), headless Chromium,
// screenshots ~/.playwright-mcp/app-circuit-*.png at 1440 (holo + real) and 390.
//   node test/qa/qa-circuit.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire('/home/plopee/zybooks-automation/');
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const O = '/home/plopee/.playwright-mcp/app-circuit-';
const mock = () => { const m = spawn(process.execPath, ['test/mock-twin.mjs', '--port', '8796', '--circuit'], { cwd: new URL('../..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_START_MS: '600', MOCK_GAP_MS: '9000' } });
  return new Promise(r => m.stdout.on('data', d => { if (/twin on/.test(String(d))) r(m); })); };
const br = await chromium.launch({ executablePath: '/home/plopee/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const out = { errors: [], external: [] };
let m;
try {
  m = await mock();
  const page = await br.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => out.errors.push(e.message)); page.on('console', x => { if (x.type() === 'error') out.errors.push(x.text()); });
  page.on('request', r => { if (!r.url().startsWith('http://localhost:8796') && !/^(data|blob):/.test(r.url())) out.external.push(r.url()); });
  await page.goto('http://localhost:8796/');
  const settle = async () => { await sleep(700); await page.waitForFunction(() => !window.mentorTwin.boardState().flying, null, { timeout: 20000 }).catch(() => {}); await sleep(1500); };
  await page.waitForFunction(() => window.odyHost?.view() === 'circuit', null, { timeout: 40000 }); await settle();
  await page.screenshot({ path: `${O}sensor-holo-1440.png` });
  out.afterSensor = await page.evaluate(() => ({ next: document.querySelector('.next-card')?.innerText, comps: document.querySelectorAll('#project-parts .comps li').length, legend: document.querySelectorAll('#project .legend li').length, tab: document.getElementById('mode-circuit').getAttribute('aria-selected') }));
  await page.evaluate(() => window.mentorTwin.setLook(false)); await settle(); await page.screenshot({ path: `${O}sensor-real-1440.png` });
  await page.evaluate(() => window.mentorTwin.setLook(true));
  await page.waitForFunction(() => /servo/i.test(document.getElementById('project-parts').innerText), null, { timeout: 40000 }); await sleep(2500); await settle();
  await page.screenshot({ path: `${O}servo-holo-1440.png` });
  await page.evaluate(() => window.mentorTwin.setLook(false)); await settle(); await page.screenshot({ path: `${O}servo-real-1440.png` });
  await page.evaluate(() => window.mentorTwin.setLook(true));
  await page.evaluate(() => document.querySelector('#project details').open = true);
  out.sketch = await page.evaluate(() => document.querySelector('#project pre')?.textContent.split('\n')[0]);
  await page.locator('#project').scrollIntoViewIfNeeded(); await sleep(400); await page.screenshot({ path: `${O}rail-1440.png` });
  out.glb = await page.evaluate(() => window.mentorTwin.exportBytes());
  await page.click('#mode-board'); await sleep(1500); out.boardView = await page.evaluate(() => window.odyHost.view());
  await page.click('#mode-circuit'); await sleep(1500);
  const p2 = await br.newPage({ viewport: { width: 390, height: 844 } });
  p2.on('pageerror', e => out.errors.push('390 ' + e.message));
  await p2.goto('http://localhost:8796/');
  await p2.waitForFunction(() => window.odyHost?.view() === 'circuit', null, { timeout: 40000 }); await sleep(3000); await p2.waitForFunction(() => !window.mentorTwin.boardState().flying, null, { timeout: 20000 }).catch(() => {}); await sleep(1500);
  await p2.screenshot({ path: `${O}servo-holo-390.png` }); await p2.screenshot({ path: `${O}servo-holo-390-full.png`, fullPage: true });
  out.overflow390 = await p2.evaluate(() => document.documentElement.scrollWidth);
} catch (e) { out.fatal = String(e.stack || e); }
finally { m?.kill(); await br.close(); }
console.log(JSON.stringify(out, null, 1));
