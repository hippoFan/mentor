// Junk / long-text / injection feed against the one-page app (live.mjs createLiveServer on :8796, never 8790).
//   node test/qa/qa-app-junk.mjs     screenshots: ~/.playwright-mcp/app-junk-{1440,390}.png
import { createRequire } from 'node:module';
process.env.MENTOR_MONITOR_PORT = '8796';
const { createLiveServer } = await import('../../live.mjs');
const require = createRequire('/home/plopee/zybooks-automation/');
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const live = await createLiveServer();
const br = await chromium.launch({ executablePath: '/home/plopee/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const res = {};
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const page = await br.newPage({ viewport: { width: w, height: h } });
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('dialog', d => { errs.push('dialog ' + d.message()); d.dismiss(); });
  await page.goto('http://localhost:8796/');
  await page.waitForFunction(() => ['waiting', 'live'].includes(window.odyShell?.phase()), null, { timeout: 20000 }).catch(async e => { console.log(errs, await page.evaluate(() => [typeof window.odyShell, window.odyShell?.phase(), document.body.dataset.phase, JSON.stringify(window.odyShell.state()), document.getElementById('status').textContent])); throw e; });
  const long = 'X'.repeat(420), inj = '<img src=x onerror=alert(1)><b>bold</b>';
  live.send({ type: 'call', state: 'live', since: Date.now() });
  live.send({ type: 'part', model: 'uno-r3', label: long });
  live.send({ type: 'part', model: 'custom', label: inj, headers: 'nope' });
  live.send({ type: 'part', model: 'custom' });
  for (let i = 0; i < 70; i++) { live.send({ type: 'step', text: long + i }); live.send({ type: 'heard', text: i % 2 ? inj : long }); live.send({ type: 'say', text: long, ms: 'x' }); }
  live.send({ type: 'turn', marks: [{ label: long, kind: 'circle', pin: '13', x: 0.5, y: 0.5 }, { label: inj, kind: 'wire', pin: '13', pin2: 'breadboard J10' }, null, { x: 'a' }], step: long });
  live.send({ type: 'turn', marks: 'garbage' }); live.send({ type: 'frame' }); live.send({ type: 'frame', jpeg: '<script>' }); live.send({ type: 'input', jpeg: 'AAAA', w: 'q' });
  live.send({ type: 'twin', action: 'selfdestruct' }); live.send({ type: 'twin', action: 'explode' }); live.send({ type: 'twin' }); live.send({ type: 'scan', spec: { name: long, parts: [] } }); live.send({ type: 'nonsense' });
  await sleep(5000);
  await page.click('#logmore'); await sleep(500);
  await page.screenshot({ path: `/home/plopee/.playwright-mcp/app-junk-${w}.png` });
  res[w] = { errs, scrollW: await page.evaluate(() => document.documentElement.scrollWidth), injected: await page.evaluate(() => document.querySelectorAll('main img[src="x"], main .line b').length), model: await page.evaluate(() => window.mentorTwin.state().model) };
  await page.close();
}
console.log(JSON.stringify(res, null, 1));
await br.close(); await live.close();
