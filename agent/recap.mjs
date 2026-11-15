// After the call: a recap page (annotated step screenshots + code) saved next to the screenshots, and a short
// iMessage through Chert with the summary, the code, a Wokwi link to try it, and a link to the recap page.
//
// Chert's documented Shared/trial message route is text only (POST /api/v1/shared-messages, max 4000 chars),
// so the pictures live on the recap page (served by serve-recaps.mjs) rather than in the message.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { writeFile } from 'node:fs/promises';

// FaceTime API base per docs.trychert.com/facetime/quickstart (skills.md shows app.trychert.com; override if needed).
const API = process.env.CHERT_API_BASE || 'https://facetime.trychert.com/api/v1';
// Wokwi's "new Arduino Uno project" opens with a ready-to-run Blink sketch; paste the code there to simulate.
const WOKWI = 'https://wokwi.com/projects/new/arduino-uno';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * @param {string} runDir folder holding step-NN.png and recap.json (ends with '/')
 * @param {{title: string, summary: string, next: string, code: string} | null} story from Brain.finish()
 * @param {{step: string, note: string, say: string, image: string}[]} steps
 */
export async function writeRecapPage(runDir, story, steps) {
  const items = steps.map((s, i) => `
    <figure><img src="${esc(basename(s.image))}" alt="Step ${i + 1}: ${esc(s.step)}" loading="lazy">
      <figcaption><b>${i + 1}. ${esc(s.step)}</b><br>${esc(s.note || s.say)}</figcaption></figure>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mentor recap</title>
<meta name="robots" content="noindex">
<style>
:root{--bg:#0b1a22;--fg:#eef4f7;--muted:#9fb3bd;--accent:#ffc845;--card:#132a35}
@media (prefers-color-scheme: light){:root{--bg:#f6f8f9;--fg:#10202a;--muted:#4c6170;--accent:#b7860b;--card:#fff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.6rem;margin:.2em 0}.kicker{color:var(--accent);font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:.8rem}
p{color:var(--fg)}.next{border-left:3px solid var(--accent);padding-left:12px;color:var(--muted)}
figure{margin:20px 0;background:var(--card);border-radius:14px;overflow:hidden}
figure img{display:block;width:100%;height:auto}figcaption{padding:12px 14px;color:var(--muted)}figcaption b{color:var(--fg)}
pre{background:var(--card);padding:14px;border-radius:12px;overflow-x:auto;font-size:.85rem}
a{color:var(--accent)}
</style></head><body><main>
<div class="kicker">Mentor recap</div>
<h1>${esc(story?.title || 'Your build session')}</h1>
<p>${esc(story?.summary || '')}</p>
${story?.next ? `<p class="next">Next: ${esc(story.next)}</p>` : ''}
${items}
${story?.code ? `<h2>Your code</h2><pre><code>${esc(story.code)}</code></pre>
<p><a href="${WOKWI}">Try it in the Wokwi simulator</a>: open it, replace the sketch with this code, press play.</p>` : ''}
<p class="next">Named for Mentor, the guide in Homer's Odyssey. Fair winds.</p>
</main></body></html>`;
  await writeFile(`${runDir}index.html`, html);
  return `${runDir}index.html`;
}

/** The iMessage text: under Chert's 4000-char limit, code trimmed if it is long. */
export function recapText(story, steps, pageUrl) {
  const lines = [`Mentor recap: ${story?.title || 'your build session'}`];
  if (story?.summary) lines.push('', story.summary);
  if (steps.length) lines.push('', ...steps.slice(0, 8).map((s, i) => `${i + 1}. ${s.step}`));
  if (story?.next) lines.push('', `Next: ${story.next}`);
  if (pageUrl) lines.push('', `Your annotated steps: ${pageUrl}`);
  if (story?.code) lines.push('', `Try it in a simulator: ${WOKWI}`);
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
