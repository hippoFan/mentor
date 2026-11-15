import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const { chromium } = createRequire('/home/plopee/zybooks-automation/')('playwright-core');
const O = '/home/plopee/.playwright-mcp/qa-', B = 'http://localhost:8795';
const br = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function open(w, h, path = '/', o = {}) {
  const ctx = await br.newContext({ viewport: { width: w, height: h }, ...o }); const page = await ctx.newPage(); const log = { con: [], net: [] };
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) log.con.push(m.text()); }); page.on('pageerror', e => log.con.push('pageerror ' + e.message));
  page.on('dialog', d => { log.con.push('DIALOG ' + d.message()); d.dismiss(); });
  page.on('request', r => log.net.push(r.url())); await page.goto(B + path); await page.waitForTimeout(1500); return { ctx, page, log };
}
let { ctx, page, log } = await open(1440, 900); await page.screenshot({ path: O + 'call-1440.png' });
console.log('1440 overflow', await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.getElementById('log').scrollHeight, document.getElementById('log').clientHeight, document.getElementById('headline').innerText.length, document.querySelector('.story').getBoundingClientRect().height, [...document.querySelectorAll('#log .line')].length]));
console.log('xss', await page.evaluate(() => document.querySelectorAll('#log img, #log b').length));
await page.keyboard.press('t'); await page.waitForTimeout(500); await page.screenshot({ path: O + 'call-1440-tester.png' });
console.log('tester', await page.evaluate(() => [document.body.className, document.getElementById('panel').getBoundingClientRect().width]));
await page.keyboard.press('Escape');
// keyboard tab order
const tabs = []; for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); tabs.push(await page.evaluate(() => { const a = document.activeElement; return a.tagName + '#' + a.id + ' ' + getComputedStyle(a).outlineStyle + ' ' + (a.textContent || '').trim().slice(0, 20); })); }
console.log('tabs', tabs); await page.screenshot({ path: O + 'call-focus.png', clip: { x: 900, y: 0, width: 540, height: 80 } });
console.log('external', log.net.filter(u => !u.startsWith(B) && !u.startsWith('data:')), 'con', log.con); await ctx.close();
({ ctx, page, log } = await open(1280, 800)); await page.screenshot({ path: O + 'call-1280.png' });
await page.keyboard.press('t'); await page.waitForTimeout(500); await page.screenshot({ path: O + 'call-1280-tester.png' }); await ctx.close();
({ ctx, page, log } = await open(390, 844, '/', { hasTouch: true, isMobile: true })); await page.screenshot({ path: O + 'call-390.png' });
console.log('390', await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.body.scrollHeight]));
await page.screenshot({ path: O + 'call-390-full.png', fullPage: true }); await ctx.close();
({ ctx, page, log } = await open(1440, 900, '/', { reducedMotion: 'reduce' })); console.log('reduced anim', await page.evaluate(() => getComputedStyle(document.getElementById('headline')).animationName)); await ctx.close();
// twin with junk feed
({ ctx, page, log } = await open(1440, 900, '/twin?fps')); await page.waitForTimeout(6000); await page.screenshot({ path: O + 'twin-junk.png' });
console.log('twin junk con', log.con.filter(c => !/GPU stall|swiftshader/i.test(c)), await page.evaluate(() => window.mentorTwin.state().model));
// reconnect: keep page open on call view
await ctx.close();
({ ctx, page, log } = await open(1440, 900));
console.log('status before', await page.locator('#status').innerText());
await br.close();
