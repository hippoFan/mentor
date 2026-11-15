// Argos: the guide dog in the bottom-right corner of the Argo page (Odysseus's dog; the page is Argo, Jason's ship).
// Restyled in the Odyssey look (design guide v2: a brick shield with the bone hound, a pitch slab panel). Every element
// has an id / class starting with "argos-". Talks only to this laptop's own server (/argos/ routes, argos/server.mjs)
// and listens to {type:'argos'} events on the page's one socket (shell.js).
//   Chat     type or record ("explode it", "swap the LED for a distance sensor", "walk me through it", questions)
//   Refine   pick a design, say what to change; Multicode runs manager, researcher, developer and auditor agents
// Wispr Flow works with no setup: it types into the focused text box like any keyboard.
// The default model comes from localStorage['argos.provider'] (set on the Main page); a key saved on the Main page fires
// 'ody:keys' and the model picker refreshes without a reload.
import { subscribe } from './shell.js';

// Tokens come from /twin/odyssey.css; the fallbacks keep the panel readable on a page server without it.
const css = `
#argos-btn{position:fixed;right:calc(var(--gutter,24px) + 28px);bottom:calc(var(--gutter,24px) + 40px);z-index:60;width:76px;height:76px;border-radius:50%;border:0;padding:0;
  background:var(--brick,#983a34);color:var(--bone,#fdf5cc);cursor:pointer;display:grid;place-items:center;
  box-shadow:0 0 0 3px var(--parchment,#fdf5cc),0 0 0 5px var(--navy,#12233f),0 14px 28px #12233f80;transition:transform var(--t-hover,160ms) var(--ease-out,ease-out)}
#argos-btn:hover{transform:translateY(-3px)}
#argos-btn:active{transform:translateY(1px);transition-duration:var(--t-press,90ms)}
#argos-btn:focus-visible{outline:3px solid var(--torch,#ea872f);outline-offset:10px}
#argos-btn svg{width:54px;height:38px;margin-top:-4px}
#argos-btn .argos-name{position:absolute;bottom:-14px;left:50%;transform:translateX(-50%);padding:5px 10px;border-radius:999px;background:var(--torch,#ea872f);color:var(--navy,#12233f);
  font:600 14px/1 var(--f-body,Arial,sans-serif);white-space:nowrap;box-shadow:0 0 0 1.5px var(--navy,#12233f)}
#argos-btn[aria-expanded="true"]{box-shadow:0 0 0 3px var(--parchment,#fdf5cc),0 0 0 5px var(--torch,#ea872f),0 14px 28px #12233f80}
#argos-panel{position:fixed;right:var(--gutter,24px);bottom:calc(var(--gutter,24px) + 140px);z-index:61;width:min(460px,calc(100vw - 32px));height:min(560px,calc(100vh - 260px));min-height:300px;
  display:flex;flex-direction:column;background:var(--navy,#12233f);color:var(--bone,#fdf5cc);border-radius:var(--r-lg,20px);overflow:hidden;
  font:400 18px/1.4 var(--f-body,Arial,sans-serif);box-shadow:0 0 0 1.5px var(--navy,#12233f),0 24px 48px -16px #12233fcc}
#argos-panel[hidden]{display:none}

.argos-head{display:flex;align-items:center;gap:10px;padding:10px 12px 8px 16px}
.argos-head h2{flex:1;margin:0;font:400 26px/1 var(--f-title,Georgia,serif);color:var(--bone,#fdf5cc)}
.argos-head label{font:600 16px/1 var(--f-body,Arial,sans-serif);color:var(--mist,#c9d6e8)}
#argos-panel select{font:500 17px/1.2 var(--f-body,Arial,sans-serif);min-height:40px;border:0;border-radius:10px;background:var(--bone,#fdf5cc);color:var(--pitch,#191a16);padding:4px 8px;max-width:100%}
#argos-close{min-width:44px;min-height:44px;border:0;background:transparent;color:var(--bone,#fdf5cc);font:400 30px/1 var(--f-title,Georgia,serif);cursor:pointer}
.argos-tabs{display:grid;grid-template-columns:1fr 1fr;gap:var(--gap,8px);padding:0 12px 8px}
.argos-tabs button{min-height:44px;border:0;background:transparent;color:var(--bone,#fdf5cc);box-shadow:inset 0 0 0 1.5px #fdf5cc80;border-radius:999px;font:600 17px/1 var(--f-body,Arial,sans-serif);cursor:pointer}
.argos-tabs button[aria-selected="true"]{background:var(--torch,#ea872f);color:var(--pitch,#191a16);box-shadow:none}
.argos-row{display:flex;gap:10px;align-items:center;padding:0 12px 8px;font:500 17px/1.3 var(--f-body,Arial,sans-serif);color:var(--mist,#c9d6e8)}
.argos-row[hidden]{display:none}
.argos-row select{flex:1;min-width:0}
#argos-multi{width:22px;height:22px;accent-color:var(--torch,#ea872f);flex:none}
#argos-log{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:#0b172b;border-top:1px solid #fdf5cc22}
.argos-msg{max-width:90%;padding:8px 12px;white-space:pre-wrap;word-break:break-word;font:500 18px/1.35 var(--f-body,Arial,sans-serif)}
.argos-msg.me{align-self:flex-end;background:var(--bone,#fdf5cc);color:var(--pitch,#191a16)}
.argos-msg.dog{align-self:flex-start;background:var(--stone,#dfd3c7);color:var(--pitch,#191a16)}
.argos-msg.step{align-self:stretch;max-width:none;background:none;color:var(--mist,#c9d6e8);border-left:4px solid var(--torch,#ea872f);padding:2px 10px;font-size:17px}
.argos-msg.step.failed{border-color:var(--live,#ff6b5e)}
.argos-msg.err{background:var(--brick,#983a34);color:var(--bone,#fdf5cc)}
.argos-msg a{display:inline-flex;align-items:center;min-height:36px;margin:6px 8px 0 0;padding:0 12px;background:var(--pitch,#191a16);color:var(--bone,#fdf5cc);
  font:600 16px/1 var(--f-body,Arial,sans-serif);text-decoration:none;border-radius:999px}
.argos-msg a:focus-visible{outline:3px solid var(--pitch,#191a16);outline-offset:2px}
.argos-note{font:500 16px/1.35 var(--f-body,Arial,sans-serif);color:var(--mist,#c9d6e8);padding:8px 12px 0}
.argos-in{display:flex;gap:8px;padding:10px 12px 12px}
#argos-text{flex:1;resize:none;height:52px;font:500 18px/1.3 var(--f-body,Arial,sans-serif);border:0;border-radius:12px;padding:8px 10px;background:var(--bone,#fdf5cc);color:var(--pitch,#191a16)}
#argos-text::placeholder{color:#5d5a4c}
#argos-mic{flex:none;width:52px;height:52px;border-radius:50%;border:0;background:var(--brick,#983a34);color:var(--bone,#fdf5cc);cursor:pointer;display:grid;place-items:center;
  box-shadow:0 0 0 3px var(--pitch,#191a16),0 0 0 5px var(--torch,#ea872f)}
#argos-mic svg{width:26px;height:26px}
#argos-mic[aria-pressed="true"]{background:var(--live,#ff6b5e);color:var(--pitch,#191a16)}
.argos-send{flex:none;min-height:52px;padding:0 18px;border:0;border-radius:14px;background:var(--torch,#ea872f);color:var(--navy,#12233f);font:600 17px/1 var(--f-body,Arial,sans-serif);
  cursor:pointer;box-shadow:0 3px 0 #0a1426}
.argos-send:active{transform:translateY(3px);box-shadow:0 1px 0 var(--torch-edge,#9a5418)}
#argos-panel :focus-visible{outline:3px solid var(--torch,#ea872f);outline-offset:2px}
#argos-text:focus-visible,#argos-panel select:focus-visible{outline-offset:0}
.argos-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
html:not(.v2) #argos-btn{right:20px;bottom:20px;width:76px;height:76px}html:not(.v2) #argos-btn svg{width:54px;height:38px}html:not(.v2) #argos-panel{right:20px;bottom:116px}
body[data-page]:not([data-page="argo"]) #argos-btn,body[data-page]:not([data-page="argo"]) #argos-panel{display:none}
@media (prefers-reduced-motion:reduce){#argos-btn,.argos-send{transition:none}}`;

// Argos: a Greek-vase hound in profile (our own drawing, design/preview/ornaments.svg "o-dog"), bone with a brick collar.
const DOG = '<svg viewBox="0 0 96 66" aria-hidden="true"><path fill="currentColor" d="M8 22C14 30 18 31 24 30C34 26 50 28 62 29C65 24 68 18 71 14L73 6L77 13C82 15 87 17 91 20L90 23C85 25 80 25 76 26C73 30 71 34 69 38L68 62H64L62 44C56 44 48 42 40 40C36 42 34 46 33 50L30 62H26L27 50C24 44 22 38 22 34C16 34 10 30 8 22Z"/><path d="M63 26C66 29 70 31 74 30" stroke="#983a34" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="80" cy="17" r="1.4" fill="#191a16"/></svg>';
const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a3.5 3.5 0 0 0-3.5 3.5v6a3.5 3.5 0 0 0 7 0v-6A3.5 3.5 0 0 0 12 2Zm-6.5 9.2h2a4.5 4.5 0 0 0 9 0h2a6.5 6.5 0 0 1-5.5 6.4V21h3v2h-8v-2h3v-3.4a6.5 6.5 0 0 1-5.5-6.4Z"/></svg>';
const STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" fill="currentColor"/></svg>';

const el = (tag, attrs = {}, text = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; return e; };
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const style = el('style'); style.textContent = css; document.head.append(style);

const btn = el('button', { id: 'argos-btn', type: 'button', 'aria-label': 'Open Argos, the assistant', 'aria-expanded': 'false', 'aria-controls': 'argos-panel' });
btn.innerHTML = DOG;   // static markup above, no data
btn.append(el('span', { class: 'argos-name', 'aria-hidden': 'true' }, 'Argos'));
const panel = el('section', { id: 'argos-panel', 'aria-labelledby': 'argos-title', hidden: '' });
const head = el('div', { class: 'argos-head' }); head.append(el('h2', { id: 'argos-title' }, 'Argos'));
head.append(el('label', { for: 'argos-provider' }, 'Model'));
const provider = el('select', { id: 'argos-provider' }); head.append(provider);
const close = el('button', { id: 'argos-close', type: 'button', 'aria-label': 'Close Argos' }, '×'); head.append(close);
const tabs = el('div', { class: 'argos-tabs', role: 'tablist', 'aria-label': 'What Argos does' });
const tabChat = el('button', { role: 'tab', id: 'argos-tab-chat', 'aria-selected': 'true', type: 'button' }, 'Chat');
const tabRefine = el('button', { role: 'tab', id: 'argos-tab-refine', 'aria-selected': 'false', type: 'button', tabindex: '-1' }, 'Refine');
tabs.append(tabChat, tabRefine);
const designRow = el('div', { class: 'argos-row' }); designRow.append(el('label', { for: 'argos-design' }, 'Design'));
const design = el('select', { id: 'argos-design' }); designRow.append(design);
const multiRow = el('div', { class: 'argos-row', hidden: '' });
const multi = el('input', { type: 'checkbox', id: 'argos-multi' }); multiRow.append(multi, el('label', { for: 'argos-multi' }, 'Multicode: manager, researcher, developer, auditor'));
const log = el('div', { id: 'argos-log', role: 'log', 'aria-live': 'polite', tabindex: '0', 'aria-label': 'Conversation with Argos' });
const note = el('div', { class: 'argos-note' }, 'Changes go to the 3D model. Say “walk me through it” to wire the real board.');
const inRow = el('form', { class: 'argos-in' });
const text = el('textarea', { id: 'argos-text', 'aria-label': 'Message Argos', placeholder: 'Ask Argos, or say what to change…' });
const mic = el('button', { id: 'argos-mic', type: 'button', 'aria-label': 'Record a message', 'aria-pressed': 'false' }); mic.innerHTML = MIC;
const go = el('button', { type: 'submit', class: 'argos-send' }, 'Send');
inRow.append(text, mic, go);
panel.append(head, tabs, designRow, multiRow, log, note, inRow);
document.body.append(btn, panel);

let mode = 'chat', designs = [], providerList = [];
const say = (who, msg, cls = '') => { const m = el('div', { class: `argos-msg ${who} ${cls}`.trim() }, msg); log.append(m); log.scrollTop = log.scrollHeight; return m; };
const api = async (path, opts = {}) => {
  const r = await fetch(`/argos/${path}`, { ...opts, headers: { ...(opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
  return j;
};

function setMode(m) {
  mode = m;
  tabChat.setAttribute('aria-selected', String(m === 'chat')); tabRefine.setAttribute('aria-selected', String(m === 'refine'));
  tabChat.tabIndex = m === 'chat' ? 0 : -1; tabRefine.tabIndex = m === 'refine' ? 0 : -1;
  multiRow.hidden = m !== 'refine';
  text.placeholder = m === 'refine' ? 'What should change? e.g. “add four 3.2 mm mounting holes”' : 'Ask Argos, or say what to change…';
}
tabChat.addEventListener('click', () => setMode('chat')); tabRefine.addEventListener('click', () => setMode('refine'));
tabs.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault(); const next = mode === 'chat' ? 'refine' : 'chat'; setMode(next); (next === 'chat' ? tabChat : tabRefine).focus();
});

/** Fills the model picker: the stored default if it has a key, else the first provider with one. */
function renderProviders(list) {
  providerList = Array.isArray(list) ? list : [];
  const keep = provider.value;
  provider.replaceChildren(...providerList.map(p => { const o = el('option', { value: p.id }, `${p.name}${p.ready ? ' · ready' : ' (no key)'}`); if (!p.ready) o.disabled = true; return o; }));
  const ready = id => providerList.some(p => p.id === id && p.ready);
  const want = [store.get('argos.provider'), keep].find(ready) || providerList.find(p => p.ready)?.id;
  if (want) provider.value = want;
}
provider.addEventListener('change', () => { store.set('argos.provider', provider.value); dispatchEvent(new CustomEvent('ody:provider', { detail: provider.value })); });

async function loadState() {
  try { renderProviders((await api('state')).providers); } catch { /* server without Argos */ }
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
      stream.getTracks().forEach(t => t.stop()); mic.setAttribute('aria-pressed', 'false'); mic.setAttribute('aria-label', 'Record a message'); mic.innerHTML = MIC; rec = null;
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      try { const r = await api('stt', { method: 'POST', body: blob, headers: { 'content-type': blob.type } }); if (r.text) void submit(r.text); else say('dog', 'I didn’t catch that. Try again, or type.', 'err'); }
      catch (e) { say('dog', e.message, 'err'); }
    };
    rec.start(); mic.setAttribute('aria-pressed', 'true'); mic.setAttribute('aria-label', 'Stop recording and send'); mic.innerHTML = STOP;
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
  if (e.state === 'failed') say('dog', `Couldn’t finish: ${e.error}`, 'err');
  if (e.state === 'done' && e.design) {
    const m = say('dog', `${e.summary || 'Done.'}${e.caveats?.length ? `\nNote: ${e.caveats.join(' ')}` : ''}\n`);
    for (const [label, file] of [['Download STL', 'model.stl'], ['OpenSCAD code', 'source.scad']]) {
      if (!e.design.files?.includes(file)) continue;
      const a = el('a', { href: `/argos/designs/${encodeURIComponent(e.design.id)}/${file}?download`, download: '' }, label); m.append(a, document.createTextNode(' '));
    }
    void loadDesigns(e.design.id);
  }
});
// keys saved on the Main page: the model picker shows the new state at once (no reload)
addEventListener('ody:keys', e => { if (Array.isArray(e.detail?.providers)) renderProviders(e.detail.providers); else void loadState(); });
addEventListener('ody:provider', e => { if (typeof e.detail === 'string' && providerList.some(p => p.id === e.detail && p.ready)) provider.value = e.detail; });
addEventListener('storage', e => { if (e.key === 'argos.provider') renderProviders(providerList); });

function setOpen(open, { focus = true } = {}) {
  if (open === !panel.hidden) return;
  panel.hidden = !open; btn.setAttribute('aria-expanded', String(open));
  if (open) { void loadState(); if (focus) text.focus(); if (!log.childElementCount) say('dog', 'Woof. I’m Argos. Tell me what to change on the model, or ask me anything.'); }
  else if (focus) btn.focus();
}
btn.addEventListener('click', () => setOpen(panel.hidden));
close.addEventListener('click', () => setOpen(false));
addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) setOpen(false); });
void loadState();   // the picker is right even before the panel opens

/** Opens the panel's Refine tab with this design selected (The Forge's "Refine with Argos"). */
export async function selectDesign(id) {
  setOpen(true, { focus: false });
  setMode('refine');
  await loadDesigns(String(id || ''));
  if (designs.some(d => d.id === id)) design.value = id;
  text.focus();
}
/** For the Main page and tests: open or close the panel. */
export function openArgos(open = true) { setOpen(open); }
