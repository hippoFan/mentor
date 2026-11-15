// Headless recording of the motion demo -> ~/.playwright-mcp/motion-demo.webm + motion-*.png. Needs motion-demo-server.mjs up.
// PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node test/motion-demo-record.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, rename, readdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

async function pw() {
  try { return await import('playwright-core'); } catch { /* not here */ }
  const f = join(process.env.PLAYWRIGHT_CORE || '', 'index.mjs');
  if (existsSync(f)) return import(pathToFileURL(f).href);
  console.error('set PLAYWRIGHT_CORE'); process.exit(2);
}
const { chromium } = await pw();
const OUT = join(homedir(), '.playwright-mcp'), TMP = join(OUT, 'motion-demo-tmp');
await mkdir(TMP, { recursive: true });
const URL_ = `http://127.0.0.1:${process.env.MOTION_DEMO_PORT || 8799}/`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome') });
const size = { width: 1280, height: 800 };
const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: TMP, size } });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
const shot = n => page.screenshot({ path: join(OUT, `motion-${n}.png`) });
await page.goto(`${URL_}?auto`);
await page.waitForSelector('body[data-t0]', { state: 'attached' }); if (errors.length) console.log('early errors:', errors);
const t0 = Date.now();
const at = async (ms, n) => { const w = ms - (Date.now() - t0); if (w > 0) await page.waitForTimeout(w); await shot(n); };
await at(500, '01-intro-mid');
await at(2800, '02-home');
await at(3130, '03-stall');
await at(3420, '04-argo-push');
await at(4300, '05-argo');
await at(4640, '06-snap-overshoot');
await at(6200, '07-forge-push');
await at(7600, '08-forge');
await at(8150, '09-combine');
await at(9300, '10-result-toast');
await page.waitForSelector('body[data-done]', { timeout: 20000 });
await shot('11-back-home');
// reduced motion: everything lands instantly
const rctx = await browser.newContext({ viewport: size, reducedMotion: 'reduce' });
const rp = await rctx.newPage();
rp.on('pageerror', e => errors.push(`reduced: ${e}`));
await rp.goto(URL_); await rp.waitForSelector('body[data-ready]'); await rp.waitForTimeout(300);
await rp.screenshot({ path: join(OUT, 'motion-8-reduced.png') });
await rctx.close();
const video = page.video();
await ctx.close();
const p = await video.path();
await rename(p, join(OUT, 'motion-demo.webm'));
for (const f of await readdir(TMP)) await rm(join(TMP, f));
await rm(TMP, { recursive: true, force: true });
await browser.close();
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
