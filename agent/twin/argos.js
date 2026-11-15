// Argos: the guide dog in the bottom-right corner of the laptop app. A working, deliberately plain panel; the Odyssey
// design pass restyles it (every element has an id / class starting with "argos-"). Talks only to this laptop's own
// server (/argos/ routes, argos/server.mjs) and listens to {type:'argos'} events on the page's one socket (shell.js).
//   Chat     type or record ("explode it", "swap the LED for a distance sensor", "walk me through it", questions)
//   Refine   pick a design, say what to change; Multicode runs manager, researcher, developer and auditor agents
// Wispr Flow works with no setup: it types into the focused text box like any keyboard.
import { subscribe } from './shell.js';

const css = `
#argos-btn{position:fixed;right:20px;bottom:20px;z-index:60;width:64px;height:64px;border-radius:50%;border:2px solid #c9a227;
  background:#1b2a3a;color:#f3e7c9;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.35);display:grid;place-items:center}
#argos-btn:focus-visible{outline:3px solid #f3e7c9;outline-offset:3px}
#argos-panel{position:fixed;right:20px;bottom:96px;z-index:60;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 130px));
  display:flex;flex-direction:column;background:#f3e7c9;color:#1b2a3a;border:2px solid #1b2a3a;border-radius:14px;overflow:hidden;
  font:14px/1.4 Inter,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.4)}
#argos-panel[hidden]{display:none}
.argos-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1b2a3a;color:#f3e7c9}
.argos-head b{flex:1;font-size:15px}
.argos-head select,.argos-row select{font:inherit;border-radius:6px;border:1px solid #8a7a55;background:#fffaf0;color:#1b2a3a;padding:2px 4px}
.argos-tabs{display:flex;border-bottom:1px solid #c8b78f}
.argos-tabs button{flex:1;padding:8px;border:0;background:none;font:inherit;cursor:pointer;color:#1b2a3a}
.argos-tabs button[aria-selected="true"]{font-weight:700;box-shadow:inset 0 -3px #c9a227}
.argos-row{display:flex;gap:6px;align-items:center;padding:6px 12px;font-size:13px}
.argos-row select{flex:1;min-width:0}
#argos-log{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.argos-msg{max-width:88%;padding:7px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.argos-msg.me{align-self:flex-end;background:#1b2a3a;color:#f3e7c9}
.argos-msg.dog{align-self:flex-start;background:#fffaf0;border:1px solid #c8b78f}
.argos-msg.step{align-self:stretch;background:none;border-left:3px solid #c9a227;border-radius:0;padding:2px 8px;font-size:12.5px}
.argos-msg.step.failed{border-color:#b3261e}
.argos-msg.err{border-color:#b3261e}
.argos-msg a{color:#7a4f00}
.argos-in{display:flex;gap:6px;padding:10px 12px;border-top:1px solid #c8b78f}
#argos-text{flex:1;resize:none;height:40px;font:inherit;border-radius:8px;border:1px solid #8a7a55;padding:8px;background:#fffaf0;color:#1b2a3a}
.argos-in button{border:0;border-radius:8px;padding:0 12px;font:inherit;cursor:pointer;background:#1b2a3a;color:#f3e7c9}
#argos-mic[aria-pressed="true"]{background:#b3261e}
.argos-note{font-size:12px;color:#5b4d2e;padding:0 12px 6px}`;

const DOG = '<svg width="34" height="34" viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M18 12c-5 0-9 6-9 13 0 4 2 7 5 8v9c0 8 7 14 18 14s18-6 18-14v-9c3-1 5-4 5-8 0-7-4-13-9-13-3 0-5 2-6 4H24c-1-2-3-4-6-4Zm6 22a3 3 0 1 1 0 .1Zm16 0a3 3 0 1 1 0 .1ZM32 40c3 0 5 1.5 5 3s-2 3-5 3-5-1.5-5-3 2-3 5-3Z"/></svg>';

const el = (tag, attrs = {}, text = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; return e; };
const style = el('style'); style.textContent = css; document.head.append(style);

const btn = el('button', { id: 'argos-btn', type: 'button', 'aria-label': 'Open Argos', 'aria-expanded': 'false', 'aria-controls': 'argos-panel' });
btn.innerHTML = DOG;   // static markup above, no data
const panel = el('section', { id: 'argos-panel', 'aria-label': 'Argos', hidden: '' });
const head = el('div', { class: 'argos-head' }); head.append(el('b', {}, 'Argos'));
const provider = el('select', { id: 'argos-provider', 'aria-label': 'Model' }); head.append(provider);
const tabs = el('div', { class: 'argos-tabs', role: 'tablist' });
const tabChat = el('button', { role: 'tab', 'aria-selected': 'true', type: 'button' }, 'Chat');
const tabRefine = el('button', { role: 'tab', 'aria-selected': 'false', type: 'button' }, 'Refine');
tabs.append(tabChat, tabRefine);
const designRow = el('div', { class: 'argos-row' }); designRow.append(el('label', { for: 'argos-design' }, 'Design'));
const design = el('select', { id: 'argos-design' }); designRow.append(design);
const multiRow = el('div', { class: 'argos-row', hidden: '' });
const multi = el('input', { type: 'checkbox', id: 'argos-multi' }); multiRow.append(multi, el('label', { for: 'argos-multi' }, 'Multicode (manager, researcher, developer, auditor)'));
const log = el('div', { id: 'argos-log', 'aria-live': 'polite' });
const note = el('div', { class: 'argos-note' }, 'Changes go to the 3D model. Say "walk me through it" to wire the real board.');
const inRow = el('form', { class: 'argos-in' });
const text = el('textarea', { id: 'argos-text', 'aria-label': 'Message Argos', placeholder: 'Ask Argos, or say what to change…' });
const mic = el('button', { id: 'argos-mic', type: 'button', 'aria-label': 'Record', 'aria-pressed': 'false' }, '●');
const go = el('button', { type: 'submit' }, 'Send');
inRow.append(text, mic, go);
panel.append(head, tabs, designRow, multiRow, log, note, inRow);
document.body.append(btn, panel);

let mode = 'chat', designs = [];
const say = (who, msg, cls = '') => { const m = el('div', { class: `argos-msg ${who} ${cls}`.trim() }, msg); log.append(m); log.scrollTop = log.scrollHeight; return m; };
const api = async (path, opts = {}) => {
  const r = await fetch(`/argos/${path}`, { ...opts, headers: { ...(opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
  return j;
};

function setMode(m) {
  mode = m; tabChat.setAttribute('aria-selected', String(m === 'chat')); tabRefine.setAttribute('aria-selected', String(m === 'refine'));
  multiRow.hidden = m !== 'refine';
  text.placeholder = m === 'refine' ? 'What should change? e.g. "add four 3.2 mm mounting holes"' : 'Ask Argos, or say what to change…';
}
tabChat.addEventListener('click', () => setMode('chat')); tabRefine.addEventListener('click', () => setMode('refine'));

async function loadState() {
  try {
    const st = await api('state');
    provider.replaceChildren(...st.providers.map(p => { const o = el('option', { value: p.id }, `${p.name}${p.ready ? '' : ' (no key)'}`); if (!p.ready) o.disabled = true; return o; }));
    const first = st.providers.find(p => p.ready); if (first) provider.value = first.id;
  } catch { /* server without Argos */ }
  await loadDesigns();
}
async function loadDesigns(selectId) {
  try { designs = (await api('designs')).designs; } catch { designs = []; }
  const keep = selectId || design.value;
  design.replaceChildren(el('option', { value: '' }, designs.length ? 'None' : 'No designs yet: scan something'),
    ...designs.map(d => el('option', { value: d.id }, `${d.name}${d.outside ? ' (outside Ody)' : ''} · ${new Date(d.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)));
  if (keep && designs.some(d => d.id === keep)) design.value = keep;
}

async function submit(words) {
  const t = String(words ?? text.value).trim(); if (!t) return;
  text.value = ''; say('me', t);
  try {
    if (mode === 'refine') {
      if (!design.value) { say('dog', 'Pick a design first.', 'err'); return; }
      await api('refine', { method: 'POST', body: JSON.stringify({ designId: design.value, instruction: t, mode: multi.checked ? 'multicode' : 'single', provider: provider.value }) });
    } else {
      const r = await api('chat', { method: 'POST', body: JSON.stringify({ text: t, provider: provider.value, designId: design.value || undefined }) });
      say('dog', r.text, r.error ? 'err' : '');
    }
  } catch (e) { say('dog', e.message, 'err'); }
}
inRow.addEventListener('submit', e => { e.preventDefault(); void submit(); });
text.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } });

// ---- record button: MediaRecorder -> /argos/stt (ElevenLabs Scribe) -> sent like typed text ----
let rec = null;
mic.addEventListener('click', async () => {
  if (rec) { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = []; rec = new MediaRecorder(stream);
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); mic.setAttribute('aria-pressed', 'false'); mic.textContent = '●'; rec = null;
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      try { const r = await api('stt', { method: 'POST', body: blob, headers: { 'content-type': blob.type } }); if (r.text) void submit(r.text); else say('dog', "I didn't catch that.", 'err'); }
      catch (e) { say('dog', e.message, 'err'); }
    };
    rec.start(); mic.setAttribute('aria-pressed', 'true'); mic.textContent = '■';
    setTimeout(() => rec?.state === 'recording' && rec.stop(), 30_000);
  } catch { say('dog', 'Microphone not available. Type instead.', 'err'); }
});

// ---- live events ----
const jobMsg = new Map();
subscribe(e => {
  if (e.type !== 'argos') return;
  if (e.kind === 'design') void loadDesigns();
  if (e.kind !== 'refine') return;
  if (e.state === 'started') jobMsg.set(e.jobId, say('dog', `${e.mode === 'multicode' ? 'Multicode team' : 'Refining'}: ${e.instruction}`));
  if (e.state === 'step' && e.step) say('step', `${e.step.role}: ${e.step.text}`, e.step.state === 'failed' ? 'failed' : '');
  if (e.state === 'failed') say('dog', `Couldn't finish: ${e.error}`, 'err');
  if (e.state === 'done' && e.design) {
    const m = say('dog', `${e.summary || 'Done.'}${e.caveats?.length ? `\nNote: ${e.caveats.join(' ')}` : ''}\n`);
    for (const [label, file] of [['Download STL', 'model.stl'], ['OpenSCAD code', 'source.scad']]) {
      if (!e.design.files?.includes(file)) continue;
      const a = el('a', { href: `/argos/designs/${encodeURIComponent(e.design.id)}/${file}?download`, download: '' }, label); m.append(a, document.createTextNode('  '));
    }
    void loadDesigns(e.design.id);
  }
});

btn.addEventListener('click', () => {
  const open = panel.hidden; panel.hidden = !open; btn.setAttribute('aria-expanded', String(open));
  if (open) { void loadState(); text.focus(); if (!log.childElementCount) say('dog', 'Woof. I\'m Argos. Tell me what to change on the model, or ask me anything.'); }
});
addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
