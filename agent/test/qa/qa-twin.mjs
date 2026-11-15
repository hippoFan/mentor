// QA driver for the twin page. node test/qa/qa-twin.mjs  (needs a mock on :8795)
import { createRequire } from 'node:module';
const require = createRequire('/home/plopee/zybooks-automation/');
const { chromium } = require('playwright-core');
import fs from 'node:fs';
const O = '/home/plopee/.playwright-mcp/', B = 'http://localhost:8795';
const out = {};
const br = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function open(w, h, opts = {}, path = '/twin?fps') {
  const ctx = await br.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage(); const log = { console: [], net: [], fail: [] };
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) log.console.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => log.console.push('pageerror: ' + e.message));
  page.on('request', r => log.net.push(r.url()));
  page.on('requestfailed', r => log.fail.push(r.url() + ' ' + r.failure()?.errorText));
  await page.goto(B + path); return { ctx, page, log };
}
const shot = (p, n) => p.screenshot({ path: O + 'qa-' + n + '.png' });
let { ctx, page, log } = await open(1440, 900);
await page.waitForTimeout(2000); await shot(page, 'twin-1440-wait');
await page.waitForTimeout(9000); await shot(page, 'twin-1440-board');
out.state1 = await page.evaluate(() => window.mentorTwin.state());
out.fps = await page.locator('#fps').textContent();
// toolbar / keys
await page.keyboard.press('e'); await page.waitForTimeout(2000); await shot(page, 'twin-1440-explode'); out.explode = await page.evaluate(() => window.mentorTwin.state().explode);
await page.keyboard.press('e'); await page.waitForTimeout(1500);
await page.keyboard.press('h'); await page.waitForTimeout(800); await shot(page, 'twin-1440-realistic'); out.holo = await page.evaluate(() => window.mentorTwin.state().holo);
await page.keyboard.press('h');
// drag + wheel
const box = await page.locator('#view').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 - 80, { steps: 10 }); await page.mouse.up();
await page.mouse.wheel(0, -600); await page.waitForTimeout(1000); await shot(page, 'twin-1440-rotzoom');
await page.keyboard.press('r'); await page.waitForTimeout(1500); await shot(page, 'twin-1440-reset');
// pin hover: sweep tooltip
const pk = await page.evaluate(() => { const s = window.mentorTwin; return ['13','GND','5V','A0','D13','USB'].map(k => [k, s.pinScreen(k)]); });
out.pins = pk;
for (const [k, xy] of pk) { if (!xy) continue; await page.mouse.move(xy[0], xy[1], { steps: 4 }); await page.waitForTimeout(400);
  const t = await page.locator('#tip').evaluate(e => e.hidden ? null : e.innerText); if (t) { out.tip = out.tip || {}; out.tip[k] = t; if (!out.tipShot) { out.tipShot = 1; await shot(page, 'twin-1440-tooltip'); } } }
// export
const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
await page.click('#export'); const d = await dl;
if (d) { const p = await d.path(); const b = fs.readFileSync(p); out.export = { name: d.suggestedFilename(), magic: b.slice(0, 4).toString(), len: b.length }; } else out.export = 'NO DOWNLOAD';
out.hint = await page.locator('#toast').evaluate(e => e.hidden ? null : e.innerText);
out.handsBtnHidden = await page.locator('#t-hands').evaluate(e => e.hidden);
await shot(page, 'twin-1440-afterexport');
// keyboard-only tab order
const tabs = []; await page.mouse.move(2, 2); await page.evaluate(() => document.activeElement.blur());
for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); tabs.push(await page.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a); return a.tagName + '#' + a.id + '.' + a.className + ' [' + (a.textContent || '').trim().slice(0, 24) + '] outline=' + cs.outlineStyle + ' ' + cs.outlineWidth; })); }
out.tabs = tabs; await shot(page, 'twin-1440-focus');
// unknown events can't be injected from the page; check ws message handler by sending via second page? skipped
out.console = log.console; out.external = log.net.filter(u => !u.startsWith(B) && !u.startsWith('data:') && !u.startsWith('blob:')); out.failed = log.fail;
out.nets = [...new Set(log.net.map(u => u.replace(B, '')))].length;
await ctx.close();
// 1280x800
({ ctx, page, log } = await open(1280, 800)); await page.waitForTimeout(11000); await shot(page, 'twin-1280-board');
out.overflow1280 = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.querySelector('aside').scrollHeight, document.querySelector('aside').clientHeight]);
out.fps1280 = await page.locator('#fps').textContent(); await ctx.close();
// 390
({ ctx, page, log } = await open(390, 844, { hasTouch: true, isMobile: true })); await page.waitForTimeout(11000); await shot(page, 'twin-390-top');
await page.evaluate(() => scrollTo(0, 99999)); await shot(page, 'twin-390-bottom');
out.m390 = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.body.scrollHeight]); 
out.toolbar390 = await page.evaluate(() => { const t = document.querySelector('.toolbar'); return [t.scrollWidth, t.clientWidth]; }); await ctx.close();
// reduced motion
({ ctx, page, log } = await open(1440, 900, { reducedMotion: 'reduce' })); await page.waitForTimeout(3000);
out.reducedAutoRotate = 'see shot'; await shot(page, 'twin-reduced'); await ctx.close();
// no camera hands click (fake none)
fs.writeFileSync(O + 'qa-twin-results.json', JSON.stringify(out, null, 1)); console.log(JSON.stringify(out, null, 1));
await br.close();
