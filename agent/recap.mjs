// After the call: a "voyage log" page (annotated step screenshots as legs of the journey, the code, and a runnable
// Wokwi project) saved next to the screenshots, and a short iMessage through Chert with the voyage, the code and a
// link to the page.
//
// Chert's documented Shared/trial message route is text only (POST /api/v1/shared-messages, max 4000 chars),
// so the pictures live on the page (served by serve-recaps.mjs) rather than in the message.
// Everything from the brain (titles, notes, code) is untrusted: it is escaped into HTML and only ever written as data.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { unlink, writeFile } from 'node:fs/promises';

// FaceTime API base per docs.trychert.com/facetime/quickstart (skills.md shows app.trychert.com; override if needed).
const API = process.env.CHERT_API_BASE || 'https://facetime.trychert.com/api/v1';
// Wokwi's "new Arduino Uno project". Wokwi documents no URL parameter that preloads code, so the page offers
// sketch.ino + diagram.json downloads to paste in.
const WOKWI = 'https://wokwi.com/projects/new/arduino-uno';
const CODE_CAP = 8000;     // longest code we package for the simulator
const MAX_LEGS = 20;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Consecutive turns on the same step become one leg (a caller who needed 12 nudges to plug in a cable made one leg,
 * not twelve). The leg keeps the first picture and note, and counts the check-ins.
 * @param {{step: string, note: string, say: string, image: string, done?: boolean}[]} steps
 */
export function buildLegs(steps) {
  const legs = [];
  for (const s of steps || []) {
    const title = clean(s.step, 80) || 'Looking at your build';
    const last = legs[legs.length - 1];
    if (last && last.title.toLowerCase() === title.toLowerCase()) { last.tries++; last.done ||= !!s.done; continue; }
    legs.push({ title, note: clean(s.note || s.say, 300), image: basename(String(s.image || '')), tries: 1, done: !!s.done });
  }
  return legs.slice(0, MAX_LEGS);
}

/** True when any brain reply in the saved conversation said the task was done (Gemini parts or Claude content). */
export function reachedHome(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== 'model' && m?.role !== 'assistant') continue;
    const blocks = Array.isArray(m.parts) ? m.parts : Array.isArray(m.content) ? m.content : [{ text: m.content }];
    for (const b of blocks) {
      if (b?.thought || (b?.type && b.type !== 'text')) continue;
      if (/"done"\s*:\s*true\b/.test(String(b?.text ?? ''))) return true;
    }
  }
  return false;
}

/** Output pins that drive an external part (pin 13 / LED_BUILTIN is the Uno's onboard LED, which needs no parts). */
export function externalLedPins(code) {
  const src = String(code || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const names = {}, arrays = {};
  for (const m of src.matchAll(/#define\s+(\w+)\s+(\d+)\b/g)) names[m[1]] = +m[2];
  for (const m of src.matchAll(/\b(?:const\s+)?(?:int|byte|uint8_t|short|long|unsigned\s+int)\s+(\w+)\s*=\s*(\d+)\s*;/g)) names[m[1]] = +m[2];
  for (const m of src.matchAll(/\b(\w+)\s*\[\s*\d*\s*\]\s*=\s*\{([\d\s,]+)\}/g)) arrays[m[1]] = m[2].split(',').map(Number).filter(Number.isFinite);
  const pins = new Set();
  for (const m of src.matchAll(/pinMode\s*\(\s*([\w]+)\s*(\[[^\]]*\])?\s*,\s*OUTPUT\s*\)/g)) {
    const [, arg, index] = m;
    const found = index ? arrays[arg] || [] : [/^\d+$/.test(arg) ? +arg : names[arg]];
    for (const p of found) if (Number.isInteger(p) && p >= 0 && p <= 12) pins.add(p);
  }
  return [...pins].slice(0, 6);
}

/** A Wokwi diagram.json: the Uno, plus a resistor + LED wired from each external output pin to GND. */
export function wokwiDiagram(code) {
  const parts = [{ type: 'wokwi-arduino-uno', id: 'uno', top: 0, left: 0, attrs: {} }];
  const connections = [];
  externalLedPins(code).forEach((pin, i) => {
    const x = 120 + i * 58;
    parts.push({ type: 'wokwi-resistor', id: `r${i + 1}`, top: -78, left: x - 30, rotate: 90, attrs: { value: '220' } });
    parts.push({ type: 'wokwi-led', id: `led${i + 1}`, top: -170, left: x - 10, attrs: { color: ['red', 'green', 'yellow', 'blue', 'orange', 'white'][i] } });
    connections.push([`uno:${pin}`, `r${i + 1}:2`, 'green', []]);
    connections.push([`r${i + 1}:1`, `led${i + 1}:A`, 'green', []]);
    connections.push([`led${i + 1}:C`, 'uno:GND.1', 'black', []]);
  });
  return { version: 1, author: 'Mentor', editor: 'wokwi', parts, connections, dependencies: {} };
}

/** Writes sketch.ino + diagram.json for the call (or removes stale ones). @returns {boolean} whether it wrote them */
async function writeWokwi(runDir, code) {
  if (!code || code.length > CODE_CAP) {
    for (const f of ['sketch.ino', 'diagram.json']) await unlink(`${runDir}${f}`).catch(() => {});
    return false;
  }
  await writeFile(`${runDir}sketch.ino`, code.endsWith('\n') ? code : code + '\n');
  await writeFile(`${runDir}diagram.json`, JSON.stringify(wokwiDiagram(code), null, 2) + '\n');
  return true;
}

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * @param {string} runDir folder holding step-NN.png and recap.json (ends with '/')
 * @param {{title: string, summary: string, next: string, code: string, done?: boolean} | null} story from Brain.finish()
 * @param {{step: string, note: string, say: string, image: string, done?: boolean}[]} steps
 * @param {{done?: boolean}} [opts] done: the brain said the task was finished during the call
 */
export async function writeRecapPage(runDir, story, steps, opts = {}) {
  const legs = buildLegs(steps);
  const done = !!(opts.done || story?.done || legs.some(l => l.done));
  const title = clean(story?.title, 90) || 'Your build session';
  const code = String(story?.code || '').trim();
  const shown = code.length > CODE_CAP ? code.slice(0, CODE_CAP) + '\n// ... (trimmed)' : code;
  const wokwi = await writeWokwi(runDir, code);
  const external = wokwi && externalLedPins(code).length > 0;

  const legHtml = legs.map((l, i) => `
<li class="leg">
  <span class="mark" aria-hidden="true">${i + 1}</span>
  <div class="body">
    <h2><span class="vh">Leg ${i + 1}: </span>${esc(l.title)}</h2>
    ${l.note ? `<p>${esc(l.note)}</p>` : ''}
    ${l.tries > 1 ? `<p class="tries">Mentor checked this ${l.tries} times on camera.</p>` : ''}
  </div>
  ${/^step-\d+\.png$/.test(l.image) ? `<img src="${esc(l.image)}" alt="What Mentor pointed at: ${esc(l.title)}" width="540" height="960"${i ? ' loading="lazy"' : ''}>` : ''}
</li>`).join('');

  const end = done ? `
<li class="leg home">
  <span class="mark" aria-hidden="true">${CHECK}</span>
  <div class="body">
    <h2>Home: ${esc(title)}</h2>
    <p>You made it. The voyage is done.</p>
    ${story?.next ? `<p class="next">Where to next: ${esc(story.next)}</p>` : ''}
  </div>
</li>` : story?.next ? `
<li class="leg ahead">
  <span class="mark" aria-hidden="true"></span>
  <div class="body">
    <h2><span class="dim">Next: </span>${esc(story.next)}</h2>
    <p>The next leg. Call Mentor again when you're ready to sail on.</p>
  </div>
</li>` : '';

  const codeHtml = code ? `
<section class="code" aria-labelledby="code-h">
  <h2 id="code-h" class="two">Your code. <span>Ready for the simulator.</span></h2>
  <pre tabindex="0"><code>${esc(shown)}</code></pre>
  ${wokwi ? `<div class="sim">
    <h3>Try it in the simulator</h3>
    <ol class="how">
      <li>Open a new Arduino Uno project in Wokwi and paste sketch.ino over its code.</li>
      <li>${external ? 'Paste diagram.json into the diagram.json tab to add the LED wiring, then' : 'The onboard LED is already there, so just'} press the green play button.</li>
    </ol>
    <div class="actions">
      <a class="btn primary" href="${WOKWI}" target="_blank" rel="noopener noreferrer">Open Wokwi</a>
      <a class="btn" href="sketch.ino" download="sketch.ino">Download sketch.ino</a>
      <a class="btn" href="diagram.json" download="diagram.json">Download diagram.json</a>
    </div>
  </div>` : `<p class="fine">This code is too long to package for the simulator. Copy it into the Arduino IDE instead.</p>`}
  <p class="fine">Read code from a recap before you flash it to real hardware.</p>
</section>` : '';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">
<title>${esc(title)} · Mentor</title>
<style>
:root{--bg:#F5F5F7;--fg:#1D1D1F;--muted:#86868B;--line:#D2D2D7;--card:#FFFFFF;--mentor:#FFC845;--on-mentor:#1D1D1F;--code:#FFFFFF;--btn:#1D1D1F;--on-btn:#FFFFFF}
@media (prefers-color-scheme: dark){:root{--bg:#000000;--fg:#F5F5F7;--muted:#86868B;--line:#38383A;--card:#1C1C1E;--code:#1C1C1E;--btn:#F5F5F7;--on-btn:#1D1D1F}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.47 Inter,-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif;letter-spacing:-.011em;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:max(28px,env(safe-area-inset-top)) 20px 64px}
.brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;margin:0 0 40px}
.brand i{width:12px;height:12px;border-radius:50%;background:var(--mentor);display:inline-block}
.brand span{color:var(--muted);font-weight:500}
h1{font-size:clamp(34px,9vw,56px);line-height:1.07;letter-spacing:-.028em;font-weight:700;margin:0 0 16px;text-wrap:balance}
h1 span,.two span{color:var(--muted)}
.lead{font-size:clamp(19px,4.6vw,21px);line-height:1.4;color:var(--fg);margin:0 0 56px;max-width:36em}
.trail{list-style:none;margin:0;padding:0;position:relative}
.leg{position:relative;display:grid;grid-template-columns:36px 1fr;column-gap:18px;padding-bottom:48px}
.leg::before{content:"";position:absolute;left:17px;top:40px;bottom:4px;width:2px;background:var(--line);border-radius:1px}
.leg:last-child::before{display:none}
.mark{grid-row:1/span 2;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-weight:600;font-size:15px;
  font-variant-numeric:tabular-nums;background:var(--card);color:var(--fg);box-shadow:inset 0 0 0 1.5px var(--line)}
.mark svg{width:18px;height:18px}
.home .mark{background:var(--mentor);color:var(--on-mentor);box-shadow:none}
.ahead .mark{background:transparent;box-shadow:inset 0 0 0 1.5px var(--muted);border:0;outline:2px dashed var(--line);outline-offset:3px}
.body{padding-top:4px;min-width:0}
.leg h2{font-size:22px;line-height:1.2;letter-spacing:-.02em;font-weight:600;margin:0 0 6px;text-wrap:balance}
.leg p{margin:0 0 6px;color:var(--muted)}
.leg .tries{font-size:15px}
.leg .dim{color:var(--muted)}
.leg .next{color:var(--fg)}
.home h2{font-size:28px}
.leg img{grid-column:2;display:block;width:100%;max-width:300px;height:auto;aspect-ratio:9/16;object-fit:cover;margin-top:14px;
  border-radius:22px;background:var(--card);box-shadow:0 1px 2px rgba(0,0,0,.06),0 12px 32px -12px rgba(0,0,0,.22)}
.code{margin-top:32px;padding-top:48px;border-top:1px solid var(--line)}
.two{font-size:clamp(28px,7vw,40px);line-height:1.1;letter-spacing:-.025em;font-weight:700;margin:0 0 20px}
pre{margin:0;background:var(--code);border-radius:18px;padding:18px 20px;overflow-x:auto;font:14px/1.6 ui-monospace,"SF Mono",Menlo,monospace;tab-size:2}
.sim{margin-top:24px;background:var(--card);border-radius:22px;padding:22px 20px;border-left:4px solid var(--mentor)}
.sim h3{margin:0 0 10px;font-size:21px;letter-spacing:-.02em}
.how{margin:0 0 18px;padding-left:1.2em;color:var(--muted)}
.how li{margin-bottom:4px}
.actions{display:flex;flex-wrap:wrap;gap:10px}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:980px;font-size:16px;font-weight:500;text-decoration:none;
  color:var(--fg);box-shadow:inset 0 0 0 1.5px var(--line)}
.btn.primary{background:var(--btn);color:var(--on-btn);box-shadow:none}
.btn:focus-visible,pre:focus-visible{outline:3px solid var(--mentor);outline-offset:2px}
.fine{font-size:14px;color:var(--muted);margin:16px 0 0}
footer{margin-top:64px;padding-top:24px;border-top:1px solid var(--line);font-size:14px;color:var(--muted)}
footer p{margin:0 0 8px;max-width:38em}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (min-width:720px){
  main{padding-top:56px}
  .leg{grid-template-columns:44px 1fr 220px;column-gap:28px;padding-bottom:48px}
  .leg::before{left:21px;top:48px}
  .mark{width:44px;height:44px;font-size:16px}
  .leg img{grid-column:3;grid-row:1/span 2;margin-top:0;max-width:220px}
  .leg .body:last-child{grid-column:2/span 2}
  .leg h2{font-size:24px}
  .home h2{font-size:32px}
}
</style></head><body><main>
<p class="brand"><i aria-hidden="true"></i>Mentor <span>voyage log</span></p>
<h1>${esc(title)}. <span>${done ? 'You made it home.' : 'The voyage so far.'}</span></h1>
${story?.summary ? `<p class="lead">${esc(clean(story.summary, 700))}</p>` : '<p class="lead">Every leg of your call with Mentor, with what it pointed at.</p>'}
${legs.length || end ? `<ol class="trail" aria-label="Your voyage">${legHtml}${end}</ol>` : ''}
${codeHtml}
<footer>
  <p>In Homer's Odyssey, Athena takes the form of an old friend, Mentor, and guides Telemachus home one step at a time. Fair winds.</p>
  <p>This page is private to you and expires 24 hours after your call.</p>
</footer>
</main></body></html>`;
  await writeFile(`${runDir}index.html`, html);
  return `${runDir}index.html`;
}

/** The iMessage text: a short voyage log under Chert's 4000-char limit, code trimmed if it is long. */
export function recapText(story, steps, pageUrl, opts = {}) {
  const legs = buildLegs(steps);
  const done = !!(opts.done || story?.done || legs.some(l => l.done));
  const title = clean(story?.title, 90) || 'your build session';
  const lines = [`Mentor voyage log: ${title}`];
  if (story?.summary) lines.push('', clean(story.summary, 700));
  if (legs.length) lines.push('', 'Your voyage:', ...legs.slice(0, 8).map((l, i) => `${i + 1}. ${l.title}`));
  if (legs.length > 8) lines.push(`(+${legs.length - 8} more on the page)`);
  if (done) lines.push(`Home: ${title}`);
  if (story?.next) lines.push('', `Next: ${clean(story.next, 300)}`);
  if (pageUrl) lines.push('', `Your voyage log, with pictures: ${pageUrl}`);
  if (story?.code) lines.push('', `Try it in a simulator: ${WOKWI} (paste the code, press play)`);
  lines.push('', 'Fair winds. Mentor');
  let text = lines.join('\n');
  if (story?.code) {
    const room = 3900 - text.length - 10;
    const code = story.code.length > room ? story.code.slice(0, Math.max(0, room - 30)) + '\n... (full code on the page)' : story.code;
    if (room > 200) text += `\n\nCode:\n${code}`;
  }
  return text.slice(0, 4000);
}

function chertHeaders(post) {
  const h = {
    authorization: `Bearer ${process.env.CHERT_API_KEY}`,
    'x-chert-project-id': process.env.CHERT_PROJECT_ID,
    'content-type': 'application/json',
  };
  if (post) h['idempotency-key'] = `mentor-${randomUUID()}`;
  return h;
}

/** The project's lines (id and status fields). */
export async function chertLines() {
  const r = await fetch(`${API}/lines`, { headers: chertHeaders(false), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`GET /lines -> ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300));
  const body = await r.json();
  return Array.isArray(body) ? body : body.lines || body.data || [];
}

/**
 * Sends the recap over iMessage on the Shared/trial line. Trial rule: the line may only reply to a phone
 * that texted it in the last 24 hours, so the recipient must text the line first.
 * @returns {Promise<{sent: boolean, why?: string}>}
 */
export async function sendRecap(text) {
  const to = process.env.MENTOR_RECAP_TO;
  if (!process.env.CHERT_API_KEY || !process.env.CHERT_PROJECT_ID || !to) {
    return { sent: false, why: 'CHERT_API_KEY, CHERT_PROJECT_ID or MENTOR_RECAP_TO not set' };
  }
  const lineId = process.env.CHERT_LINE_ID || (await chertLines())[0]?.id;
  if (!lineId) return { sent: false, why: 'no line on this project' };
  const r = await fetch(`${API}/shared-messages`, {
    method: 'POST', headers: chertHeaders(true), signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ line_id: lineId, recipient: to, text }),
  });
  const body = await r.text().catch(() => '');
  if (!r.ok) return { sent: false, why: `POST /shared-messages -> ${r.status} ${body.slice(0, 200)}` };
  return { sent: true, why: body.slice(0, 200) };
}
