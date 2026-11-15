// Movable parts, combine + analysis, connection guide, consent and replay: mock-twin on :8796 (never 8790),
// headless Chromium, screenshots ~/.playwright-mcp/app-parts-*.png, app-consent-asked.png, app-replay.png.
//   node test/qa/qa-parts.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire('/home/plopee/zybooks-automation/');
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const O = '/home/plopee/.playwright-mcp/';
const out = { errors: [], external: [] };
const mock = (args, env = {}) => { const m = spawn(process.execPath, ['test/mock-twin.mjs', '--port', '8796', ...args], { cwd: new URL('../..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_START_MS: '600', ...env } });
  return new Promise(r => m.stdout.on('data', d => { if (/twin on/.test(String(d))) r(m); })); };
const br = await chromium.launch({ executablePath: '/home/plopee/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function open(w, h) {
  const page = await br.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', e => out.errors.push(`${w}: ${e.message}`)); page.on('console', x => { if (x.type() === 'error' && !/WebSocket connection/.test(x.text())) out.errors.push(`${w}: ${x.text()}`); });
  page.on('request', r => { if (!r.url().startsWith('http://localhost:8796') && !/^(data|blob):/.test(r.url())) out.external.push(r.url()); });
  await page.goto('http://localhost:8796/');
  return page;
}
const settle = async page => { await sleep(600); await page.waitForFunction(() => !window.mentorTwin.boardState().flying, null, { timeout: 20000 }).catch(() => {}); await sleep(1200); };
const ps = page => page.evaluate(() => window.mentorTwin.partsState());
let m;
try {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    m = await mock(['--parts'], { MOCK_GAP_MS: '7000' });
    const page = await open(w, h);
    await page.waitForFunction(() => window.mentorTwin?.state().explode > 0.99, null, { timeout: 40000 }); await settle(page);
    await page.screenshot({ path: `${O}app-parts-exploded-${w}.png` });
    if (w === 1440) {   // drag the main chip with the mouse
      const at = await page.evaluate(() => window.mentorTwin.partScreen('mcu'));
      await page.mouse.move(at[0], at[1]); await page.mouse.down(); await page.mouse.move(at[0] + 60, at[1] - 40, { steps: 8 }); await page.mouse.move(at[0] + 140, at[1] - 90, { steps: 8 }); await page.mouse.up();
      await sleep(800); await page.screenshot({ path: `${O}app-parts-dragged-${w}.png` });
      out.dragged = (await ps(page)).parts.find(p => p.id === 'mcu');
    }
    await page.waitForFunction(() => window.mentorTwin.partsState().parts.some(p => p.removed), null, { timeout: 40000 }); await sleep(1500);
    await page.locator('#trayBox').scrollIntoViewIfNeeded(); await sleep(300);
    await page.screenshot({ path: `${O}app-parts-removed-${w}.png` });
    out['removed' + w] = (await ps(page)).parts.filter(p => p.removed).map(p => p.name);
    await page.waitForFunction(() => window.mentorTwin.partsState().analysis, null, { timeout: 40000 }); await settle(page);
    await page.evaluate(() => document.getElementById('analysis').scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `${O}app-parts-combined-${w}.png` });
    out['analysis' + w] = await page.locator('#analysisCard').evaluate(e => e.hidden ? null : e.innerText.slice(0, 120));
    if (w === 1440) {   // keyboard: Tab into the parts list, Enter picks, Delete removes, Restore all
      await page.evaluate(() => window.mentorTwin.voice('explode'));
      await page.locator('#partsList button').first().focus(); await page.keyboard.press('Enter'); await sleep(300);
      out.kbSel = (await ps(page)).sel; await page.keyboard.press('Delete'); await sleep(300);
      out.kbRemoved = (await ps(page)).parts.filter(p => p.removed).length;
      await page.locator('#restoreAll').focus(); await page.keyboard.press('Enter'); await sleep(1500);
      out.afterRestore = (await ps(page)).parts.filter(p => p.removed || p.moved).length;
      out.glb = await page.evaluate(() => window.mentorTwin.exportBytes());
    }
    await page.close(); m.kill(); await sleep(800);
  }
  // connection guide (voice "next" -> step 2)
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    m = await mock(['--circuit'], { MOCK_GAP_MS: '2500' });
    const page = await open(w, h);
    await page.waitForFunction(() => window.mentorTwin?.partsState().guide, null, { timeout: 60000 }); await sleep(2500); await settle(page);
    if (w === 390) await page.evaluate(() => document.getElementById('guide').scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${O}app-parts-guide-${w}.png` });
    out['guide' + w] = { ...(await ps(page)).guide, text: await page.locator('#guideText').textContent() };
    if (w === 1440) { await page.locator('#stage').focus(); await page.keyboard.press('ArrowRight'); await sleep(800); out.guideNext = (await ps(page)).guide; }
    await page.close(); m.kill(); await sleep(800);
  }
  // consent asked, then a replay
  m = await mock(['--parts', '--consent'], { MOCK_GAP_MS: '60000' });
  let page = await open(1440, 900); await page.waitForFunction(() => !document.getElementById('consentCard').hidden, null, { timeout: 30000 }); await sleep(1500);
  await page.screenshot({ path: `${O}app-consent-asked.png` }); out.consent = await page.locator('#consent').textContent();
  await page.close(); m.kill(); await sleep(800);
  m = await mock(['--parts', '--replay'], { MOCK_GAP_MS: '60000' });
  page = await open(1440, 900); await page.waitForFunction(() => !document.getElementById('replayBadge').hidden, null, { timeout: 30000 }); await sleep(2500);
  await page.screenshot({ path: `${O}app-replay.png` }); await sleep(500); out.replay = { badge: await page.locator('#replayBadge').innerText(), status: await page.locator('#status').textContent(), dot: await page.locator('.status .dot').evaluate(e => getComputedStyle(e).backgroundColor) };
  await page.close();
} catch (e) { out.fatal = String(e.stack || e); }
finally { m?.kill(); await br.close(); }
console.log(JSON.stringify(out, null, 1));
