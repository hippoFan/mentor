import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const { chromium } = createRequire('/home/plopee/zybooks-automation/')('playwright-core');
const O = '/home/plopee/.playwright-mcp/qa-', B = 'http://localhost:8795';
const br = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function open(w, h, o = {}) { const ctx = await br.newContext({ viewport: { width: w, height: h }, ...o }); const page = await ctx.newPage(); const con = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) con.push(m.text()); }); page.on('pageerror', e => con.push('pageerror ' + e.message)); await page.goto(B + '/'); return { ctx, page, con }; }
let { ctx, page, con } = await open(1440, 900); await page.waitForTimeout(22000); await page.screenshot({ path: O + 'mon-1440.png' });
await page.keyboard.press('t'); await page.waitForTimeout(800); await page.screenshot({ path: O + 'mon-1440-tester.png' });
console.log('overflow', await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), con); await ctx.close();
({ ctx, page, con } = await open(1280, 800)); await page.waitForTimeout(18000); await page.screenshot({ path: O + 'mon-1280.png' });
await page.keyboard.press('t'); await page.waitForTimeout(800); await page.screenshot({ path: O + 'mon-1280-tester.png' }); await ctx.close();
({ ctx, page, con } = await open(390, 844, { hasTouch: true, isMobile: true })); await page.waitForTimeout(16000); await page.screenshot({ path: O + 'mon-390.png' });
console.log('390', await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.body.scrollHeight])); await page.screenshot({ path: O + 'mon-390-full.png', fullPage: true }); await ctx.close();
// reconnect
({ ctx, page, con } = await open(1440, 900)); await page.waitForTimeout(3000); console.log('before', await page.locator('#status').innerText()); await page.screenshot({ path: O + 'mon-pre-restart.png' });
console.log('RESTART'); await new Promise(r => setTimeout(r, 15000)); // parent kills/restarts server in this window
console.log('during', await page.locator('#status').innerText(), 'view', await page.evaluate(() => [document.getElementById('view').hidden, document.getElementById('stale').hidden]));
await page.screenshot({ path: O + 'mon-during-down.png' });
await new Promise(r => setTimeout(r, 15000));
console.log('after', await page.locator('#status').innerText()); await page.screenshot({ path: O + 'mon-after-restart.png' }); console.log(con); await br.close();
