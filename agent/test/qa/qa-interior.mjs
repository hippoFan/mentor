// The researched interior inside the app: mock-twin --interior on :8796 (never 8790), headless Chromium, screenshots
// ~/.playwright-mcp/app-interior-<case>-{closed,xray,exploded}-{holo,real}.png
//   node test/qa/qa-interior.mjs [case-prefix]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire('/home/plopee/zybooks-automation/');
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const only = process.argv[2] || 'phone', O = '/home/plopee/.playwright-mcp/app-interior-';
const m = spawn(process.execPath, ['test/mock-twin.mjs', '--port', '8796', '--interior', '--only', only], { cwd: new URL('../..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_START_MS: '800', MOCK_RESEARCH_MS: '3000' } });
await new Promise(r => m.stdout.on('data', d => { if (/twin on/.test(String(d))) r(); }));
const br = await chromium.launch({ executablePath: '/home/plopee/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const out = { errors: [], external: [] };
try {
  const page = await br.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => out.errors.push(e.message)); page.on('console', x => { if (x.type() === 'error') out.errors.push(x.text()); });
  page.on('request', r => { if (!r.url().startsWith('http://localhost:8796') && !/^(data|blob):/.test(r.url())) out.external.push(r.url()); });
  await page.goto('http://localhost:8796/');
  await page.waitForFunction(() => window.mentorTwin?.scanState().view === 'scan', null, { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('interiorinfo').hidden, null, { timeout: 30000 });
  const settle = async () => { await sleep(600); await page.waitForFunction(() => !window.mentorTwin.boardState().flying, null, { timeout: 20000 }).catch(() => {}); await sleep(900); };
  const states = async look => {
    await page.evaluate(h => window.mentorTwin.setLook(h), look === 'holo'); await settle();
    await page.screenshot({ path: `${O}${only}-closed-${look}.png` });
    await page.keyboard.press('y'); await settle(); await page.screenshot({ path: `${O}${only}-xray-${look}.png` });
    await page.keyboard.press('y'); await page.keyboard.press('e');
    await page.waitForFunction(() => window.mentorTwin.state().explode > 0.99, null, { timeout: 20000 }); await settle();
    await page.screenshot({ path: `${O}${only}-exploded-${look}.png` });
    await page.keyboard.press('e'); await page.waitForFunction(() => window.mentorTwin.state().explode < 0.01, null, { timeout: 20000 }); await settle();
  };
  await states('holo'); await states('real');
  out.rail = await page.evaluate(() => ({ sum: document.getElementById('insideSum').textContent, badge: !document.getElementById('researched').hidden, layers: document.querySelectorAll('#layers li').length,
    links: [...document.querySelectorAll('#sources a')].map(a => [a.protocol, a.target, a.rel]), xrayBtn: !document.getElementById('t-xray').hidden, parts: document.querySelectorAll('#pins [role=option]').length }));
  await page.evaluate(() => window.mentorTwin.setLook(true));
  await page.locator('#pins').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await sleep(800);
  out.partTip = await page.locator('#tip').evaluate(e => e.hidden ? null : e.innerText.replace(/\n/g, ' | '));
  await page.screenshot({ path: `${O}${only}-parttip.png` });
  out.glb = await page.evaluate(() => window.mentorTwin.exportBytes());
  await page.evaluate(() => window.mentorTwin.showScan(-1)); await sleep(800);
  out.onBoard = await page.evaluate(() => ({ badge: !document.getElementById('researched').hidden, xrayBtn: !document.getElementById('t-xray').hidden }));
} catch (e) { out.fatal = String(e.stack || e); }
finally { m.kill(); await br.close(); }
console.log(JSON.stringify(out, null, 1));
