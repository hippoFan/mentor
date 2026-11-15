import { createRequire } from 'node:module';
const { chromium } = createRequire('/home/plopee/zybooks-automation/')('playwright-core');
const O = '/home/plopee/.playwright-mcp/', B = 'http://localhost:8795';
const br = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await br.newContext({ viewport: { width: 1440, height: 900 }, permissions: [] });
const page = await ctx.newPage(); const con = [];
page.on('console', m => con.push(m.type() + ': ' + m.text())); page.on('pageerror', e => con.push('pageerror ' + e.message));
await page.goto(B + '/twin?fps'); await page.waitForFunction(() => window.mentorTwin?.state().model === 'uno-r4-wifi', null, { timeout: 30000 });
await page.keyboard.press('r'); await page.waitForTimeout(2000);
const tips = {}; let firstShot = false;
for (let y = 300; y < 650; y += 14) for (let x = 120; x < 620; x += 14) {
  await page.mouse.move(x, y); await page.waitForTimeout(25);
  const t = await page.locator('#tip').evaluate(e => e.hidden ? null : e.innerText.replace(/\n/g, ' | '));
  if (t && !tips[t]) { tips[t] = [x, y]; if (!firstShot) { firstShot = true; await page.screenshot({ path: O + 'qa-twin-tooltip.png' }); } }
}
console.log('tooltips', Object.keys(tips).length, JSON.stringify(tips).slice(0, 900));
// hand button, no camera
await page.click('#t-hands'); await page.waitForTimeout(4000);
console.log('toast', await page.locator('#toast').evaluate(e => e.hidden ? null : e.innerText), 'handsHidden', await page.locator('#t-hands').evaluate(e => e.hidden), 'handview', await page.locator('#handview').evaluate(e => e.hidden));
await page.screenshot({ path: O + 'qa-twin-hands-nocam.png' });
// copy wiring
await page.click('#copy'); await page.waitForTimeout(500); console.log('copy toast', await page.locator('#toast').evaluate(e => e.hidden ? null : e.innerText));
// accessibility names
console.log(await page.evaluate(() => ({ canvasRole: document.getElementById('view').getAttribute('role'), tabindex: document.getElementById('view').tabIndex, stageLabel: document.getElementById('stage').getAttribute('aria-label'), live: [...document.querySelectorAll('[aria-live]')].map(e => e.id), statusLive: document.querySelector('.status').getAttribute('role'), toastRole: document.getElementById('toast').getAttribute('role'), tipRole: document.getElementById('tip').getAttribute('role'),
  fpsContrast: getComputedStyle(document.getElementById('fps')).color, tagline: getComputedStyle(document.querySelector('.hint')).color })));
// scans: replay through window api
console.log('con', con.filter(c => !/GPU stall|swiftshader/i.test(c)));
await br.close();
