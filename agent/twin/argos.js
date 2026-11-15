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
#argos-btn{position:fixed;right:calc(var(--gutter,var(--ody-space-6)) + var(--ody-space-7));bottom:calc(var(--gutter,var(--ody-space-6)) + var(--ody-space-8));z-index:60;width:calc(var(--ody-space-unit) * 19);height:calc(var(--ody-space-unit) * 19);border-radius:50%;border:0;padding:0;
  background:var(--brick,#983a34);color:var(--bone,#fdf5cc);cursor:pointer;display:grid;place-items:center;
  box-shadow:0 0 0 3px var(--parchment,#fdf5cc),0 0 0 5px var(--navy,#12233f),0 14px 28px #12233f80;transition:transform var(--t-hover,160ms) var(--ease-out,ease-out)}
#argos-btn:hover{transform:translateY(-3px)}
#argos-btn:active{transform:translateY(1px);transition-duration:var(--t-press,90ms)}
#argos-btn:focus-visible{outline:calc(var(--ody-space-unit) * 0.75) solid var(--torch,#ea872f);outline-offset:calc(var(--ody-space-unit) * 2.5)}
#argos-btn svg{width:calc(var(--ody-space-unit) * 13.5);height:calc(var(--ody-space-unit) * 9.5);margin-top:calc(var(--ody-space-1) * -1)}
#argos-btn .argos-name{position:absolute;bottom:calc(var(--ody-space-4) * -1);left:50%;transform:translateX(-50%);padding:var(--ody-space-1) var(--ody-space-3);border-radius:var(--ody-radius-pill);background:var(--torch,#ea872f);color:var(--navy,#12233f);
  font:600 var(--ody-text-xs)/1 var(--f-body,Arial,sans-serif);white-space:nowrap;box-shadow:0 0 0 1.5px var(--navy,#12233f)}
#argos-btn[aria-expanded="true"]{box-shadow:0 0 0 3px var(--parchment,#fdf5cc),0 0 0 5px var(--torch,#ea872f),0 14px 28px #12233f80}
#argos-panel{position:fixed;right:var(--gutter,var(--ody-space-6));bottom:calc(var(--gutter,var(--ody-space-6)) + calc(var(--ody-space-unit) * 35));z-index:61;width:min(calc(var(--ody-space-unit) * 115),calc(100vw - calc(var(--ody-space-unit) * 8)));height:min(calc(var(--ody-space-unit) * 140),calc(100vh - calc(var(--ody-space-unit) * 65)));min-height:calc(var(--ody-space-unit) * 75);
  display:flex;flex-direction:column;background:var(--navy,#12233f);color:var(--bone,#fdf5cc);border-radius:var(--r-lg,var(--ody-radius-md));overflow:hidden;
  font:400 var(--ody-text-md)/1.4 var(--f-body,Arial,sans-serif);box-shadow:0 0 0 1.5px var(--navy,#12233f),0 24px 48px -16px #12233fcc}
#argos-panel[hidden]{display:none}

.argos-head{display:flex;align-items:center;gap:var(--ody-space-3);padding:var(--ody-space-3) var(--ody-space-3) var(--ody-space-2) var(--ody-space-4)}
.argos-head h2{flex:1;margin:0;font:400 var(--ody-text-xl)/1 var(--f-title,Georgia,serif);color:var(--bone,#fdf5cc)}
.argos-head label{font:600 var(--ody-text-sm)/1 var(--f-body,Arial,sans-serif);color:var(--mist,#c9d6e8)}
#argos-panel select{font:500 var(--ody-text-md)/1.2 var(--f-body,Arial,sans-serif);min-height:var(--ody-control-md);border:0;border-radius:var(--ody-radius-sm);background:var(--bone,#fdf5cc);color:var(--pitch,#191a16);padding:var(--ody-space-1) var(--ody-space-2);max-width:100%}
#argos-close{min-width:calc(var(--ody-space-unit) * 11);min-height:var(--ody-control-lg);border:0;background:transparent;color:var(--bone,#fdf5cc);font:400 var(--ody-text-xl)/1 var(--f-title,Georgia,serif);cursor:pointer}
.argos-tabs{display:grid;grid-template-columns:1fr 1fr;gap:var(--gap,var(--ody-space-2));padding:0 var(--ody-space-3) var(--ody-space-2)}
.argos-tabs button{min-height:var(--ody-control-lg);border:0;background:transparent;color:var(--bone,#fdf5cc);box-shadow:inset 0 0 0 1.5px #fdf5cc80;border-radius:var(--ody-radius-pill);font:600 var(--ody-text-md)/1 var(--f-body,Arial,sans-serif);cursor:pointer}
.argos-tabs button[aria-selected="true"]{background:var(--torch,#ea872f);color:var(--pitch,#191a16);box-shadow:none}
.argos-row{display:flex;gap:var(--ody-space-3);align-items:center;padding:0 var(--ody-space-3) var(--ody-space-2);font:500 var(--ody-text-md)/1.3 var(--f-body,Arial,sans-serif);color:var(--mist,#c9d6e8)}
.argos-row[hidden]{display:none}
.argos-row select{flex:1;min-width:0}
#argos-multi{width:calc(var(--ody-space-unit) * 5.5);height:calc(var(--ody-space-unit) * 5.5);accent-color:var(--torch,#ea872f);flex:none}
#argos-log{flex:1;overflow:auto;padding:var(--ody-space-3) var(--ody-space-3);display:flex;flex-direction:column;gap:var(--ody-space-2);background:#0b172b;border-top:var(--ody-border-thin) solid #fdf5cc22}
.argos-msg{max-width:90%;padding:var(--ody-space-2) var(--ody-space-3);white-space:pre-wrap;word-break:break-word;font:500 var(--ody-text-md)/1.35 var(--f-body,Arial,sans-serif)}
.argos-msg.me{align-self:flex-end;background:var(--bone,#fdf5cc);color:var(--pitch,#191a16)}
.argos-msg.dog{align-self:flex-start;background:var(--stone,#dfd3c7);color:var(--pitch,#191a16)}
.argos-msg.step{align-self:stretch;max-width:none;background:none;color:var(--mist,#c9d6e8);border-left:calc(var(--ody-space-unit) * 1) solid var(--torch,#ea872f);padding:calc(var(--ody-space-unit) * 0.5) var(--ody-space-3);font-size:var(--ody-text-md)}
.argos-msg.step.failed{border-color:var(--live,#ff6b5e)}
.argos-msg.err{background:var(--brick,#983a34);color:var(--bone,#fdf5cc)}
.argos-msg a{display:inline-flex;align-items:center;min-height:var(--ody-control-md);margin:var(--ody-space-2) var(--ody-space-2) 0 0;padding:0 var(--ody-space-3);background:var(--pitch,#191a16);color:var(--bone,#fdf5cc);
  font:600 var(--ody-text-sm)/1 var(--f-body,Arial,sans-serif);text-decoration:none;border-radius:var(--ody-radius-pill)}
.argos-msg a:focus-visible{outline:calc(var(--ody-space-unit) * 0.75) solid var(--pitch,#191a16);outline-offset:calc(var(--ody-space-unit) * 0.5)}
.argos-note{font:500 var(--ody-text-sm)/1.35 var(--f-body,Arial,sans-serif);color:var(--mist,#c9d6e8);padding:var(--ody-space-2) var(--ody-space-3) 0}
.argos-in{display:flex;gap:var(--ody-space-2);padding:var(--ody-space-3) var(--ody-space-3) var(--ody-space-3)}
#argos-text{flex:1;resize:none;height:calc(var(--ody-space-unit) * 13);font:500 var(--ody-text-md)/1.3 var(--f-body,Arial,sans-serif);border:0;border-radius:var(--ody-radius-md);padding:var(--ody-space-2) var(--ody-space-3);background:var(--bone,#fdf5cc);color:var(--pitch,#191a16)}
#argos-text::placeholder{color:#5d5a4c}
#argos-mic{flex:none;width:calc(var(--ody-space-unit) * 13);height:calc(var(--ody-space-unit) * 13);border-radius:50%;border:0;background:var(--brick,#983a34);color:var(--bone,#fdf5cc);cursor:pointer;display:grid;place-items:center;
  box-shadow:0 0 0 3px var(--pitch,#191a16),0 0 0 5px var(--torch,#ea872f)}
#argos-mic svg{width:calc(var(--ody-space-unit) * 6.5);height:calc(var(--ody-space-unit) * 6.5)}
#argos-mic[aria-pressed="true"]{background:var(--live,#ff6b5e);color:var(--pitch,#191a16)}
.argos-send{flex:none;min-height:var(--ody-control-lg);padding:0 var(--ody-space-5);border:0;border-radius:var(--ody-radius-md);background:var(--torch,#ea872f);color:var(--navy,#12233f);font:600 var(--ody-text-md)/1 var(--f-body,Arial,sans-serif);
  cursor:pointer;box-shadow:0 3px 0 #0a1426}
.argos-send:active{transform:translateY(3px);box-shadow:0 1px 0 var(--torch-edge,#9a5418)}
#argos-panel :focus-visible{outline:calc(var(--ody-space-unit) * 0.75) solid var(--torch,#ea872f);outline-offset:calc(var(--ody-space-unit) * 0.5)}
#argos-text:focus-visible,#argos-panel select:focus-visible{outline-offset:0}
.argos-sr{position:absolute;width:calc(var(--ody-space-unit) * 0.25);height:calc(var(--ody-space-unit) * 0.25);overflow:hidden;clip-path:inset(50%);white-space:nowrap}
html:not(.v2) #argos-btn{right:var(--ody-space-5);bottom:var(--ody-space-5);width:calc(var(--ody-space-unit) * 19);height:calc(var(--ody-space-unit) * 19)}html:not(.v2) #argos-btn svg{width:calc(var(--ody-space-unit) * 13.5);height:calc(var(--ody-space-unit) * 9.5)}html:not(.v2) #argos-panel{right:var(--ody-space-5);bottom:calc(var(--ody-space-unit) * 29)}
body[data-page]:not([data-page="argo"]) #argos-btn,body[data-page]:not([data-page="argo"]) #argos-panel{display:none}
@media (prefers-reduced-motion:reduce){#argos-btn,.argos-send{transition:none}}
/* ---- v8: the panel is a slab of the call panel's honey oak (same grain, plank seams, cream EB Garamond, walnut/espresso controls) ---- */
#argos-panel{--a-oak:var(--oak,#865628);--a-walnut:var(--walnut,#3b2414);--a-espresso:var(--espresso,#2a170b);--a-cream:var(--oak-text,#fdf5cc);--a-cream-2:var(--oak-muted,#f3e6c0);
  font-family:var(--f-serif,"EB Garamond",Georgia,serif);color:var(--a-cream);border-radius:var(--r-lg,var(--ody-radius-md));
  background:repeating-linear-gradient(90deg,transparent 0 71px,#2a170b8c 71px 72.5px,#c99a5f40 72.5px 73.5px,transparent 73.5px 144px) -20px 0/144px 100%,
    var(--wood,none) 0 0/360px 720px,linear-gradient(90deg,#7d5025,#8c5b2b 40%,#81532a);
  box-shadow:inset 0 0 0 1px #c99a5f55,inset 0 0 24px #2a170b66,0 0 0 3px var(--a-espresso),0 0 0 5px var(--a-walnut),0 18px 40px -18px #000c}
#argos-panel *{font-family:inherit}
#argos-panel .argos-head{align-items:center}
#argos-panel .argos-head h2{font:400 var(--ody-text-xl)/1 var(--f-title,Georgia,serif);color:var(--a-cream);text-shadow:0 1px 0 #2a170b99}
#argos-panel .argos-head label,#argos-panel .argos-row{font:700 var(--ody-text-sm)/1.3 var(--f-serif,Georgia,serif);color:var(--a-cream);letter-spacing:.02em}
#argos-panel select,#argos-text{font:500 var(--ody-text-md)/1.3 var(--f-serif,Georgia,serif);background:var(--a-espresso);color:var(--a-cream);box-shadow:inset 0 0 0 1.5px #c99a5f88,inset 0 2px 6px #0007}
#argos-panel select option{background:var(--a-espresso);color:var(--a-cream)}
#argos-text::placeholder{color:var(--a-cream-2);opacity:.85}
#argos-close{color:var(--a-cream);border-radius:var(--ody-radius-pill)}
#argos-close:hover{background:#2a170b55}
.argos-tabs button{font:700 var(--ody-text-md)/1 var(--f-serif,Georgia,serif);color:var(--a-cream);box-shadow:inset 0 0 0 1.5px #fdf5cc80}
.argos-tabs button:hover{background:#2a170b33}
.argos-tabs button[aria-selected="true"]{background:var(--a-walnut);color:var(--a-cream);box-shadow:inset 0 0 0 1.5px #c99a5f88,0 2px 0 var(--a-espresso)}
#argos-multi{accent-color:var(--a-walnut)}
#argos-log{background:linear-gradient(#2a170b59,#2a170b40);border-top:0;box-shadow:inset 0 1.5px 0 #2a170b80,inset 0 -1.5px 0 #2a170b80}
.argos-msg{font:500 var(--ody-text-md)/1.35 var(--f-serif,Georgia,serif);border-radius:var(--ody-radius-sm)}
.argos-msg.me{background:var(--a-walnut);color:var(--a-cream);box-shadow:inset 0 0 0 1px #c99a5f55}
.argos-msg.dog{background:var(--a-espresso);color:var(--a-cream);box-shadow:inset 0 0 0 1px #c99a5f40}
.argos-msg.step{color:var(--a-cream);border-left-color:var(--a-espresso);background:#2a170b40}
.argos-msg.step.failed{border-color:#ff8a7a}
.argos-msg.err{background:#5c1f17;color:var(--a-cream);box-shadow:inset 0 0 0 1px #ff8a7a66}
.argos-msg a{background:var(--a-walnut);color:var(--a-cream);font:700 var(--ody-text-sm)/1 var(--f-serif,Georgia,serif);box-shadow:inset 0 0 0 1.5px #c99a5f88}
.argos-msg a:hover{background:var(--a-espresso)}
.argos-msg a:focus-visible{outline-color:var(--a-cream)}
.argos-note{font:500 var(--ody-text-sm)/1.35 var(--f-serif,Georgia,serif);color:var(--a-cream);text-shadow:0 1px 0 #2a170b80}
#argos-mic{background:var(--a-espresso);color:var(--a-cream);box-shadow:inset 0 0 0 1.5px #c99a5f88,0 2px 0 #1a0e06}
#argos-mic:hover{background:var(--a-walnut)}
#argos-mic[aria-pressed="true"]{background:#8e2d22;color:var(--a-cream)}
.argos-send{background:var(--a-walnut);color:var(--a-cream);font:700 var(--ody-text-md)/1 var(--f-serif,Georgia,serif);box-shadow:inset 0 0 0 1.5px #c99a5f88,0 3px 0 var(--a-espresso)}
.argos-send:hover{background:var(--a-espresso)}
.argos-send:active{box-shadow:inset 0 0 0 1.5px #c99a5f88,0 1px 0 var(--a-espresso)}
#argos-panel :focus-visible{outline-color:var(--a-cream)}
/* ---- the living dog (inline SVG, GSAP in this file; transform only, never takes a click) ---- */
svg.argos-dog{display:block;pointer-events:none;overflow:visible}
html.v2 #argos-btn.argos-has-dog{background:var(--oak,#865628)}
html.v2 #argos-btn.argos-has-dog > svg.argos-dog,#argos-btn.argos-has-dog > svg.argos-dog{visibility:visible;width:66%;height:78%;margin:0 0 6% 4%}
.argos-head-dog{flex:none;width:calc(var(--ody-space-unit) * 11);height:calc(var(--ody-space-unit) * 12);margin:calc(var(--ody-space-1) * -1) calc(var(--ody-space-1) * -1) 0 calc(var(--ody-space-1) * -1);pointer-events:none}
.argos-head-dog svg{width:100%;height:100%}
.argos-head-dog:empty{display:none}`;

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
const head = el('div', { class: 'argos-head' }); const headDog = el('span', { class: 'argos-head-dog', 'aria-hidden': 'true' }); head.append(headDog, el('h2', { id: 'argos-title' }, 'Argos'));
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

/** Fills the model picker: the stored default if it has a key, else the first provider with one. While the hub is in
 *  owner testing, the server lists 'claude-code' (owner: true, "Claude (owner's subscription — testing)") first, and it
 *  is preselected until the user picks a model here. */
let picked = false;
function renderProviders(list) {
  providerList = Array.isArray(list) ? list : [];
  const keep = provider.value;
  provider.replaceChildren(...providerList.map(p => { const o = el('option', { value: p.id }, `${p.name}${p.ready ? ' · ready' : p.owner ? ' (claude CLI not found)' : ' (no key)'}`); if (!p.ready) o.disabled = true; return o; }));
  const ready = id => providerList.some(p => p.id === id && p.ready);
  const want = [picked ? keep : null, providerList.find(p => p.owner && p.ready)?.id, store.get('argos.provider'), keep].find(ready) || providerList.find(p => p.ready)?.id;
  if (want) provider.value = want;
}
provider.addEventListener('change', () => { picked = true; store.set('argos.provider', provider.value); dispatchEvent(new CustomEvent('ody:provider', { detail: provider.value })); });

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
      dogThink(true);
      let r;
      try { r = await api('chat', { method: 'POST', body: JSON.stringify({ text: t, provider: provider.value, designId: design.value || undefined }) }); } finally { dogThink(false); }
      say('dog', r.text, r.error ? 'err' : '');
      if (!r.error) dogHop();
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


// ---- the living dog: twin/paper/argos.svg cut at the collar into head / body, plus a tail; GSAP (twin/motion.js) drives it.
// idle: breathing + a slow wag · hover/focus: ears perk, head tilts toward the pointer · thinking: fast wag + sniff bob ·
// reply / refine done: a happy hop · ~60 s with nothing from you: lies down and sleeps, wakes on hover.
// Transform only; pointer-events none; reduced motion (or no GSAP) keeps the static drawing.
const dogs = [];
let G = null, dogState = 'idle', hoverOn = false, sleepTimer = 0, thinking = false;
const DOG_SLEEP_MS = 60_000;
async function buildDogs() {
  let txt;
  try { const r = await fetch('/twin/paper/argos.svg'); if (!r.ok) return; txt = await r.text(); } catch { return; }
  const src = new DOMParser().parseFromString(txt, 'image/svg+xml');
  const fills = [...src.querySelectorAll('.pk-fill > g > *')], lines = [...src.querySelectorAll('.pk-line > g > *')];
  const defs = src.querySelector('defs')?.innerHTML || '';
  if (fills.length < 3 || lines.length < 8) return;
  const x = n => n.outerHTML;
  const make = (uid, cls = '') => {
    const id = k => `${k}-${uid}`;
    const fillG = inner => `<g filter="url(#${id('pk-wash')})" transform="translate(2.5 2)"><g transform="translate(20 20) scale(0.62)">${inner}</g></g>`;
    const lineG = inner => `<g filter="url(#${id('pk-ink')})" fill="none" stroke="#12233f" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(20 20) scale(0.62)">${inner}</g></g>`;
    const seam = 'L66 129Q92 137 119 131L150 133L215 126';
    return `<svg class="argos-dog ${cls}" viewBox="-6 -20 320 420" aria-hidden="true" focusable="false"><defs>${defs.replace(/id="pk-(ink|wash)"/g, (m, k) => `id="pk-${k}-${uid}"`)}
<clipPath id="${id('ch')}"><path d="M-40 -60H215V126L150 133L119 131Q92 137 66 129L-40 124Z"/></clipPath>
<clipPath id="${id('cb')}"><path d="M-40 420V124${seam}V-60H340V420Z"/></clipPath></defs>
<g class="argos-d-hop"><g class="argos-d-all">
 <g class="argos-d-tail"><path d="M250 352C280 346 300 326 297 296C296 288 292 282 288 279" fill="none" stroke="#12233f" stroke-width="14" stroke-linecap="round"/><path d="M250 352C280 346 300 326 297 296C296 288 292 282 288 279" fill="none" stroke="#fdf5cc" stroke-width="8.5" stroke-linecap="round"/></g>
 <g clip-path="url(#${id('cb')})">${fillG(x(fills[0]) + x(fills[2]))}${lineG(x(lines[0]) + x(lines[6]) + x(lines[7]))}</g>
 <g class="argos-d-pose"><g class="argos-d-head" clip-path="url(#${id('ch')})">${fillG(x(fills[0]))}${lineG(x(lines[0]) + x(lines[1]) + x(lines[3]))}
  <g class="argos-d-eye">${lineG(x(lines[2]))}</g><g class="argos-d-ear">${fillG(x(fills[1]))}${lineG(x(lines[4]))}</g></g></g>
 ${lineG(x(lines[5]))}
 <text class="argos-d-z" x="150" y="40" fill="#12233f" opacity="0" font-family="Georgia,serif" font-weight="700" font-size="62">z</text>
</g></g></svg>`;
  };
  btn.insertAdjacentHTML('afterbegin', make('b'));
  const old = btn.querySelector('svg:not(.argos-dog)'); if (old) old.remove();
  btn.classList.add('argos-has-dog');
  headDog.innerHTML = make('h');   // our own static drawing (same-origin asset), no user data
  try { G = (await import('./motion.js')).gsap; } catch { G = null; }
  for (const svg of [btn.querySelector('svg.argos-dog'), headDog.querySelector('svg.argos-dog')]) {
    const q = c => svg.querySelector(`.argos-d-${c}`);
    dogs.push({ svg, hop: q('hop'), all: q('all'), tail: q('tail'), pose: q('pose'), head: q('head'), ear: q('ear'), eye: q('eye'), z: q('z'), loops: {} });
  }
  if (!G || dogReduced()) return;
  for (const d of dogs) {
    d.loops.breath = G.to(d.all, { scaleY: 1.03, scaleX: 0.995, svgOrigin: '150 392', duration: 1.7, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    d.loops.tail = G.fromTo(d.tail, { rotation: -12 }, { rotation: 14, svgOrigin: '252 350', duration: 0.6, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    d.tilt = G.quickTo(d.head, 'rotation', { duration: 0.35, ease: 'power2.out' });
    G.set(d.head, { svgOrigin: '95 132' }); G.set(d.ear, { svgOrigin: '76 72' }); G.set(d.pose, { svgOrigin: '95 132' }); G.set(d.eye, { svgOrigin: '56 77' });
  }
  pauseIfBusy(); armSleep();
}
const dogReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');
const dogOk = () => G && dogs.length && !dogReduced();
// the page pauses ambient loops while a call is live or the tab is hidden (pages.js: html.ody-paused)
function pauseIfBusy() {
  if (!dogOk()) return;
  const busy = document.documentElement.classList.contains('ody-paused') && !thinking;
  for (const d of dogs) for (const t of Object.values(d.loops)) busy ? t.pause() : (dogState !== 'sleep' || t !== d.loops.tail) && t.play();
}
new MutationObserver(pauseIfBusy).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
function armSleep() { clearTimeout(sleepTimer); sleepTimer = setTimeout(() => { if (!thinking && !hoverOn) dogSleep(); }, DOG_SLEEP_MS); }
function dogSleep() {
  if (!dogOk() || dogState === 'sleep') return;
  dogState = 'sleep';
  for (const d of dogs) {
    d.loops.tail.pause(); G.to(d.tail, { rotation: 18, duration: 0.8 });
    d.loops.breath.timeScale(0.45);
    G.to(d.all, { y: 46, duration: 0.9, ease: 'ody-out' });
    G.to(d.pose, { rotation: -20, y: 18, duration: 0.9, ease: 'ody-out' });
    G.to(d.ear, { rotation: 28, scaleY: 0.85, duration: 0.6 });
    G.to(d.eye, { scaleY: 0.12, duration: 0.3 });
    d.loops.z = G.fromTo(d.z, { opacity: 0, y: 0, x: 0 }, { keyframes: [{ opacity: 0.85, y: -20, x: 10, duration: 1.1 }, { opacity: 0, y: -46, x: 22, duration: 1.1 }], repeat: -1, repeatDelay: 0.6, ease: 'none' });
  }
}
function dogWake() {
  if (dogState !== 'sleep') { armSleep(); return; }
  dogState = 'idle';
  for (const d of dogs) {
    d.loops.z?.kill(); delete d.loops.z; G.set(d.z, { opacity: 0 });
    d.loops.breath.timeScale(1); d.loops.tail.play();
    G.to(d.all, { y: 0, duration: 0.45, ease: 'ody-spring' });
    G.to(d.pose, { rotation: 0, y: 0, duration: 0.45, ease: 'ody-spring' });
    G.to(d.ear, { rotation: 0, scaleY: 1, duration: 0.3 });
    G.to(d.eye, { scaleY: 1, duration: 0.2 });
  }
  armSleep();
}
function dogHover(on, e) {
  hoverOn = on;
  if (!dogOk()) return;
  if (on) dogWake();
  for (const d of dogs) G.to(d.ear, { rotation: on ? -16 : 0, scaleY: on ? 1.18 : 1, duration: on ? 0.22 : 0.4, ease: on ? 'back.out(3)' : 'ody-out' });
  if (on && e) dogLook(e); else if (!on) for (const d of dogs) d.tilt(0);
  if (!on) armSleep();
}
// head toward the pointer: up/down and a little for left/right (the dog faces left), at most 12 degrees
function dogLook(e) {
  if (!dogOk() || dogState === 'sleep') return;
  for (const d of dogs) {
    const r = d.svg.getBoundingClientRect(); if (!r.width) continue;
    const dx = e.clientX - (r.left + r.width * 0.3), dy = e.clientY - (r.top + r.height * 0.25);
    d.tilt(Math.max(-12, Math.min(12, -dy / 6 + dx / 14)));
  }
}
function dogThink(on) {
  thinking = on;
  if (!dogOk()) return;
  if (on) dogWake();
  for (const d of dogs) {
    d.loops.tail.timeScale(on ? 3.4 : 1);
    if (on && !d.loops.sniff) d.loops.sniff = G.to(d.pose, { y: 7, rotation: -5, duration: 0.18, ease: 'sine.inOut', yoyo: true, repeat: -1, repeatDelay: 0.12 });
    if (!on && d.loops.sniff) { d.loops.sniff.kill(); delete d.loops.sniff; G.to(d.pose, { y: 0, rotation: 0, duration: 0.3 }); }
  }
  pauseIfBusy(); if (!on) armSleep();
}
function dogHop() {
  if (!dogOk()) return;
  dogWake();
  for (const d of dogs) {
    G.timeline().to(d.hop, { y: -70, scaleY: 1.06, svgOrigin: '150 392', duration: 0.22, ease: 'power2.out' })
      .to(d.hop, { y: 0, scaleY: 0.92, duration: 0.2, ease: 'power2.in' })
      .to(d.hop, { scaleY: 1, duration: 0.35, ease: 'ody-spring' });
    d.loops.tail.pause();
    G.fromTo(d.tail, { rotation: -20 }, { rotation: 20, duration: 0.12, yoyo: true, repeat: 5, ease: 'sine.inOut', onComplete: () => d.loops.tail.restart() });
  }
}
for (const t of [btn, panel]) {
  t.addEventListener('pointerenter', e => dogHover(true, e));
  t.addEventListener('pointerleave', () => dogHover(false));
  t.addEventListener('pointermove', e => { if (hoverOn) dogLook(e); }, { passive: true });
}
btn.addEventListener('focus', () => { if (btn.matches(':focus-visible')) dogHover(true); });
btn.addEventListener('blur', () => dogHover(false));
panel.addEventListener('input', () => { if (dogState === 'sleep') dogWake(); else armSleep(); });
void buildDogs();
/** For tests and the demo: the dog's state and its moves. */
window.argosDog = { state: () => (thinking ? 'think' : dogState), ready: () => dogs.length > 0, animated: () => !!dogOk(), sleep: dogSleep, wake: dogWake, think: dogThink, hop: dogHop };

// ---- live events ----
const jobMsg = new Map();
subscribe(e => {
  if (e.type !== 'argos') return;
  if (e.kind === 'design') void loadDesigns();
  if (e.kind !== 'refine') return;
  if (e.state === 'started') { dogThink(true); jobMsg.set(e.jobId, say('dog', `${e.mode === 'multicode' ? 'Multicode team' : 'Refining'}: ${e.instruction}`)); }
  if (e.state === 'step' && e.step) say('step', `${e.step.role}: ${e.step.text}`, e.step.state === 'failed' ? 'failed' : '');
  if (e.state === 'failed') { dogThink(false); say('dog', `Couldn’t finish: ${e.error}`, 'err'); }
  if (e.state === 'done') { dogThink(false); dogHop(); }
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
addEventListener('ody:provider', e => { if (typeof e.detail === 'string' && providerList.some(p => p.id === e.detail && p.ready)) { provider.value = e.detail; picked = true; } });
addEventListener('storage', e => { if (e.key === 'argos.provider') renderProviders(providerList); });

function setOpen(open, { focus = true } = {}) {
  if (open === !panel.hidden) return;
  panel.hidden = !open; btn.setAttribute('aria-expanded', String(open));
  if (open) { dogWake(); void loadState(); if (focus) text.focus(); if (!log.childElementCount) say('dog', 'Woof. I’m Argos. Tell me what to change on the model, or ask me anything.'); }
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
