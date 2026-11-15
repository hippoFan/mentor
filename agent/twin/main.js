// Main (the centre, home page): a small control centre. Status, credits and usage, the Ody plan, models and keys,
// integrations with vibe-coding tools, voice input. Data: GET /argos/state, /argos/usage, /argos/keys, /argos/designs
// (argos/server.mjs) and the page's one socket (shell.js). Every number is real, labelled Demo, or shown as Not tracked.
// Keys are write-only: a password box sends {name, value} to POST /argos/keys; the page only ever shows "set" and the
// last 4 characters. Saving fires 'ody:keys' so Argos's model picker updates without a reload.
import { phase, subscribe } from './shell.js';
import { onPage, page } from './pages.js';

const $ = id => document.getElementById(id);
if (!$('page-main')) throw new Error('no Main page');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const fmt = n => Number(n).toLocaleString('en-US');
const api = async (path, opts = {}) => {
  const r = await fetch(`/argos/${path}`, { ...opts, headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `failed (${r.status})`), { status: r.status });
  return j;
};
function toast(text, { error = false } = {}) {
  const box = $('m-toasts'); const t = el('div', 'ody-toast');
  t.setAttribute('role', error ? 'alert' : 'status'); t.append(String(text).slice(0, 300));
  if (error) { const x = el('button', '', 'Dismiss'); x.type = 'button'; x.addEventListener('click', () => t.remove()); t.append(x); } else setTimeout(() => t.remove(), 6000);
  box.append(t); while (box.children.length > 3) box.firstElementChild.remove();
}
const tile = (cls, text) => el('div', `tile ${cls || ''}`.trim(), text);
const row = (...tiles) => { const r = el('div', 'row'); r.append(...tiles); return r; };

const M = { state: null, usage: null, keys: null, designs: [], since: 0, sock: false, asked: new Map(), editing: null, loaded: false };

// ---------- status ----------
function dur(s) { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`; }
function renderStatus() {
  const box = $('m-status'), p = phase();
  const live = p === 'live' || (p !== 'ended' && M.state?.call === true);
  const replay = document.body.hasAttribute('data-replay');
  const call = live
    ? row(tile('key', 'Call'), replay ? tile('state c-plum', 'Replay') : (() => { const t = tile('state c-brick'); t.append(el('span', 'live-dot'), 'Live'); return t; })(),
      tile('', replay ? 'A replay of a real call, not live' : `On a call with Ody${M.since ? ` · ${dur((Date.now() - M.since) / 1000)}` : ''}`))
    : row(tile('key', 'Call'), tile('state c-stone', p === 'ended' ? 'Ended' : 'Waiting'),
      tile('', p === 'ended' ? 'Ended, recap saved' : 'FaceTime Ody to start'));
  const chertSet = M.keys?.find(k => k.name === 'CHERT_API_KEY')?.set;
  const chert = M.keys == null ? row(tile('key', 'Chert'), tile('state dash', 'Not tracked'), tile('', 'Line status unavailable'))
    : chertSet ? row(tile('key', 'Chert'), tile('state c-slate', 'Set'), tile('', 'FaceTime line key on this laptop'))
      : row(tile('key', 'Chert'), tile('state c-stone', 'Not set'), tile('', 'No line key in .env'));
  const up = M.sock && Number.isFinite(M.state?.uptime);
  const hub = up ? row(tile('key', 'Hub'), tile('state c-slate', 'Up'), tile('', `Running ${dur(M.state.uptime + (Date.now() - M.state._at) / 1000)}`))
    : row(tile('key', 'Hub'), tile('state c-stone', M.sock ? 'Up' : 'Down'), tile('', M.sock ? 'Connected' : 'Reconnecting to this laptop’s hub…'));
  box.replaceChildren(call, chert, hub);
}

// ---------- credits and usage ----------
function renderUsage() {
  const box = $('m-usage'); box.replaceChildren();
  const e = M.usage?.eleven;
  const voice = el('div', 'row voice-row');
  if (e?.ok && e.limit > 0) {
    const used = Math.min(e.used, e.limit), left = Math.max(0, e.limit - e.used), pct = Math.round((used / e.limit) * 100);
    const d = tile('meter-tile');
    const top = el('div', 'meter-top'); top.append(el('span', '', 'ElevenLabs'), el('span', 'sp'));
    const nums = el('span'); nums.append(el('b', '', fmt(used)), ' used · ', el('b', '', fmt(left)), ' left'); top.append(nums);
    const meter = el('div', 'meter'); meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', `${pct} percent of ElevenLabs characters used`);
    const on = Math.round((used / e.limit) * 20); for (let i = 0; i < 20; i++) meter.append(el('i', i < on ? '' : 'left'));
    d.append(top, meter); voice.append(tile('key', 'Voice'), d);
  } else {
    const why = M.usage == null ? 'Checking…' : !M.keys?.find(k => k.name === 'ELEVENLABS_API_KEY')?.set ? 'No ElevenLabs key yet' : 'ElevenLabs didn’t answer';
    const d = tile('dash stack'); d.append(el('b', '', 'Not tracked'), el('span', 'sub', `ElevenLabs credits. ${why}.`));
    voice.append(tile('key', 'Voice'), d);
  }
  const c = M.usage?.argos || M.state?.counts;
  const grid = el('div', 'usage');
  const num = (n, label) => { const t = tile('c-bone'); t.append(el('span', 't-num', n == null ? '–' : fmt(n)), el('small', '', label)); return t; };
  const nt = label => { const t = tile('dash'); t.append(el('span', 'nt', 'Not tracked'), el('small', '', label)); return t; };
  grid.append(num(c?.chat, 'Argos chats'), num(c?.refine, 'Refinements'), num(c?.multicode, 'Multicode runs'), num(c?.modelCalls, 'Model calls'));
  const none = tile('dash wide'); none.append(el('span', 'nt', 'Not tracked'), el('small', '', 'Tokens and spend: Ody doesn’t meter them, so it shows no number'));
  box.append(voice, grid, none, el('p', 't-note', 'Counts since the hub started.'));
}

// ---------- models and keys ----------
const PROVIDERS = [
  { id: 'gemini', label: 'Gemini', key: 'GEMINI_API_KEY', hint: 'Starts with AIza… (Google AI Studio)' },
  { id: 'claude', label: 'Claude', key: 'ANTHROPIC_API_KEY', hint: 'Starts with sk-ant-… (Anthropic Console)' },
  { id: 'openai', label: 'OpenAI-compatible', key: 'ARGOS_OPENAI_KEY', hint: 'OpenAI/Codex models, AIsa, or a local server' },
];
const keyOf = name => M.keys?.find(k => k.name === name);
const defaultProvider = () => {
  const ready = id => M.state?.providers?.some(p => p.id === id && p.ready);
  return [store.get('argos.provider')].find(ready) || ['gemini', 'claude', 'openai'].find(ready) || null;
};
function keyText(k) { return k?.set ? `Key set${k.last4 ? ` ····${k.last4}` : ''}` : 'No key yet'; }

function editor(p) {
  const f = el('form', 'key-edit'); f.setAttribute('aria-label', `${p.label} settings`); f.autocomplete = 'off';
  const fields = [];
  const add = (name, label, type, extra = {}) => {
    const id = `m-in-${name}`, lab = el('label', '', label); lab.htmlFor = id;
    const i = el('input'); i.id = id; i.name = name; i.type = type; i.autocomplete = type === 'password' ? 'new-password' : 'off'; i.spellcheck = false;
    Object.assign(i, extra); fields.push(i); const w = el('div', 'kf'); w.append(lab, i); f.append(w); return i;
  };
  if (p.id === 'openai') {
    const base = keyOf('ARGOS_OPENAI_BASE'), model = keyOf('ARGOS_OPENAI_MODEL');
    add('ARGOS_OPENAI_BASE', 'Base URL', 'url', { placeholder: base?.host ? `now ${base.host}` : 'https://api.openai.com/v1', maxLength: 200 });
    const dl = el('datalist'); dl.id = 'm-bases'; for (const v of ['https://api.openai.com/v1', 'https://api.aisa.one/v1', 'http://127.0.0.1:11434/v1']) { const o = el('option'); o.value = v; dl.append(o); }
    f.append(dl); f.querySelector('#m-in-ARGOS_OPENAI_BASE').setAttribute('list', 'm-bases');
    add('ARGOS_OPENAI_MODEL', 'Model', 'text', { placeholder: model?.value || 'gpt-5.1-codex-mini', maxLength: 120 });
  }
  add(p.key, 'API key', 'password', { placeholder: keyOf(p.key)?.set ? 'Type a new key to replace it' : p.hint, maxLength: 300 });
  const acts = el('div', 'kf-acts');
  const save = el('button', 'btn small', 'Save'); save.type = 'submit';
  const cancel = el('button', 'btn small quiet', 'Cancel'); cancel.type = 'button';
  acts.append(save);
  if (keyOf(p.key)?.set) { const clr = el('button', 'btn small quiet', 'Remove key'); clr.type = 'button'; clr.addEventListener('click', () => void saveKeys(p, [[p.key, '']], 'removed')); acts.append(clr); }
  acts.append(cancel);
  f.append(acts, el('p', 'kf-note', 'Saved to .env on this laptop only. Ody shows the last 4 characters, never the key.'));
  cancel.addEventListener('click', () => { M.editing = null; renderKeys(); $(`m-act-${p.id}`)?.focus(); });
  f.addEventListener('submit', e => {
    e.preventDefault();
    const changes = fields.filter(i => i.value.trim()).map(i => [i.name, i.value.trim()]);
    if (!changes.length) { toast('Nothing to save: type a value first.'); return; }
    void saveKeys(p, changes, 'saved');
  });
  return f;
}
async function saveKeys(p, changes, verb) {
  let last = null;
  try {
    for (const [name, value] of changes) last = await api('keys', { method: 'POST', body: JSON.stringify({ name, value }) });
  } catch (e) {
    toast(`${p.label} not ${verb}: ${e.message}`, { error: true });
    await refreshKeys(); return;
  } finally {
    for (const i of document.querySelectorAll('.key-edit input')) i.value = '';   // never leave a key in the DOM
  }
  M.editing = null;
  await refreshKeys(last?.providers);
  toast(`${p.label} key ${verb}.`);
  $(`m-act-${p.id}`)?.focus();
}
async function refreshKeys(providers) {
  try { const k = await api('keys'); M.keys = k.keys; if (M.state) M.state.providers = k.providers; providers = k.providers; } catch { /* keep the last */ }
  dispatchEvent(new CustomEvent('ody:keys', { detail: { providers } }));
  renderKeys(); renderStatus(); renderUsage();
}
function renderKeys() {
  const box = $('m-keys'); box.replaceChildren();
  if (!M.keys) { box.append(row(tile('key', 'Keys'), tile('state dash', 'Not tracked'), tile('', 'Argos isn’t on this page server'))); return; }
  const def = defaultProvider();
  for (const p of PROVIDERS) {
    const k = keyOf(p.key), ready = M.state?.providers?.some(x => x.id === p.id && x.ready);
    const r = el('div', 'keyrow');
    const key = tile('key', p.label); if (p.id === 'openai') key.classList.add('long');
    const d = tile(ready ? '' : 'c-stone');
    let detail = keyText(k);
    if (p.id === 'openai') { const b = keyOf('ARGOS_OPENAI_BASE'), m = keyOf('ARGOS_OPENAI_MODEL'); detail = k?.set ? `${b?.host || 'api.openai.com'} · ${m?.value || 'default model'} · ····${k.last4 || ''}` : 'Base URL, model and key'; }
    d.append(el('span', 'kt', detail), el('span', 'sp'));
    if (ready && def === p.id) d.append(el('span', 'badge default', 'Default'));
    else if (ready) {
      const mk = el('button', 'badge make-default', 'Make default'); mk.type = 'button';
      mk.addEventListener('click', () => { store.set('argos.provider', p.id); dispatchEvent(new CustomEvent('ody:provider', { detail: p.id })); renderKeys(); toast(`${p.label} is now Argos’s default model.`); });
      d.append(mk);
    }
    const act = el('button', 'btn small', M.editing === p.id ? 'Close' : k?.set ? 'Change' : p.id === 'openai' ? 'Set up' : 'Add key');
    act.type = 'button'; act.id = `m-act-${p.id}`; act.setAttribute('aria-expanded', String(M.editing === p.id));
    act.addEventListener('click', () => { M.editing = M.editing === p.id ? null : p.id; renderKeys(); if (M.editing) box.querySelector('.key-edit input')?.focus(); else $(`m-act-${p.id}`)?.focus(); });
    r.append(key, d, act); box.append(r);
    if (M.editing === p.id) box.append(editor(p));
  }
  // ElevenLabs (voice) lives with Voice input
  const vb = $('m-voicekey'); vb.replaceChildren();
  const vk = keyOf('ELEVENLABS_API_KEY'), vp = { id: 'eleven', label: 'ElevenLabs', key: 'ELEVENLABS_API_KEY', hint: 'ElevenLabs API key (sk_…)' };
  const vr = el('div', 'keyrow');
  const va = el('button', 'btn small', M.editing === 'eleven' ? 'Close' : vk?.set ? 'Change' : 'Add key'); va.type = 'button'; va.id = 'm-act-eleven'; va.setAttribute('aria-expanded', String(M.editing === 'eleven'));
  va.addEventListener('click', () => { M.editing = M.editing === 'eleven' ? null : 'eleven'; renderKeys(); if (M.editing) vb.querySelector('.key-edit input')?.focus(); else $('m-act-eleven')?.focus(); });
  vr.append(tile('key', 'Scribe'), tile(vk?.set ? '' : 'c-stone', keyText(vk)), va); vb.append(vr);
  if (M.editing === 'eleven') vb.append(editor(vp));
}

// ---------- integrations: "Export to agent" hands a design to a vibe-coding tool ----------
const TOOLS = {
  'Claude Code': 'Open your project folder, run claude, and say: “Read ody-handoff.md and do what it asks.”',
  Codex: 'In Codex (CLI or app), add ody-handoff.md to the task and ask it to follow the file.',
  Cursor: 'Drop ody-handoff.md into the chat (or @-mention it) and ask the agent to follow it.',
  Lovable: 'Paste the contents of ody-handoff.md into a new prompt.',
  'Another tool': 'Any coding agent that reads Markdown can follow the file.',
};
const RULES = ['Write plain OpenSCAD only: no include, use or import statements, no external files.', 'All sizes are in millimetres.',
  'Keep every existing module name (they are the parts Ody names and points at).', 'Return the whole file as one ```openscad code block, then one sentence on what changed.'];
let tool = 'Claude Code';
function renderInts() {
  const box = $('m-ints'); box.replaceChildren();
  const card = el('div', 'tile int-card');
  const top = el('div', 'int-top'); top.append(el('h3', '', 'Export to agent'), el('span', 'badge frontier', 'Frontier: not hardened'));
  const pick = el('div', 'int-pick');
  const tl = el('label', '', 'Tool'); tl.htmlFor = 'm-tool';
  const ts = el('select'); ts.id = 'm-tool'; for (const t of Object.keys(TOOLS)) { const o = el('option', '', t); o.value = t; ts.append(o); } ts.value = tool;
  ts.addEventListener('change', () => { tool = ts.value; how.textContent = TOOLS[tool]; });
  const dl = el('label', '', 'Design'); dl.htmlFor = 'm-design';
  const ds = el('select'); ds.id = 'm-design';
  const withCode = M.designs.filter(d => d.files?.includes('source.scad'));
  if (!withCode.length) { const o = el('option', '', 'No design with OpenSCAD code yet'); o.value = ''; ds.append(o); ds.disabled = true; }
  for (const d of withCode) { const o = el('option', '', `${d.name}${d.outside ? ' (outside Ody)' : ''}`); o.value = d.id; ds.append(o); }
  pick.append(tl, ts, dl, ds);
  const how = el('p', 'int-how', TOOLS[tool]);
  const foot = el('div', 'int-foot');
  const back = el('p', 'int-back', 'Bring it back: save the .scad file the agent returns and import it in The Forge.');
  const ex = el('button', 'btn small on-light', 'Export to agent'); ex.type = 'button'; ex.disabled = !withCode.length;
  ex.addEventListener('click', () => void exportHandoff(ds.value));
  foot.append(back, ex);
  card.append(top, pick, how, foot); box.append(card);
}
async function exportHandoff(id) {
  const d = M.designs.find(x => x.id === id);
  if (!d) { toast('Pick a design first.', { error: true }); return; }
  let code = '';
  try { const r = await fetch(`/argos/designs/${encodeURIComponent(id)}/source.scad`); if (!r.ok) throw new Error(); code = await r.text(); }
  catch { toast('That design has no OpenSCAD code to export.', { error: true }); return; }
  const asked = M.asked.get(id) || d.summary || '';
  const md = [`# Ody handoff: ${d.name}`, '', `Made by Ody (HackUTA 2026) on ${new Date().toLocaleString()} for ${tool}.`, '',
    '## What the user asked for', '', asked ? `> ${asked.replace(/\n/g, '\n> ')}` : '> (No instruction recorded. Ask the user what to change.)', '',
    '## Rules', '', ...RULES.map(r => `- ${r}`), '', '## How to bring it back', '', 'Save the result as a `.scad` file and import it in Ody’s The Forge page (Import a design).', '',
    `## Current OpenSCAD (${d.kind || 'design'}${d.outside ? ', made outside Ody' : ''})`, '', '```openscad', code.replace(/```/g, '`​``'), '```', ''].join('\n');
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
  const a = el('a'); a.href = url; a.download = 'ody-handoff.md'; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Exported ody-handoff.md for ${tool}.`);
}

// ---------- data ----------
async function loadAll() {
  const [st, keys, designs] = await Promise.allSettled([api('state'), api('keys'), api('designs')]);
  if (st.status === 'fulfilled') { M.state = { ...st.value, _at: Date.now() }; }
  if (keys.status === 'fulfilled') { M.keys = keys.value.keys; if (M.state) M.state.providers = keys.value.providers; }
  if (designs.status === 'fulfilled') M.designs = designs.value.designs || [];
  M.loaded = true;
  renderStatus(); renderUsage(); if (!M.editing) renderKeys(); renderInts();
}
let usageAt = 0;
async function loadUsage(force = false) {
  if (!force && Date.now() - usageAt < 120_000) return;
  usageAt = Date.now();
  try { M.usage = await api('usage'); } catch { M.usage = { eleven: null, argos: M.state?.counts }; }
  renderUsage();
}

subscribe(e => {
  if (e.type === '_sock') { M.sock = e.open; renderStatus(); if (e.open) void loadAll(); return; }
  if (e.type === 'hello') { M.sock = true; if (e.call?.state === 'live') M.since = Number(e.call.since) || Date.now(); renderStatus(); return; }
  if (e.type === 'call') { if (e.state === 'live') M.since = Number(e.since) || Date.now(); if (M.state) M.state.call = e.state === 'live'; renderStatus(); return; }
  if (e.type !== 'argos') return;
  if (e.kind === 'refine' && e.state === 'started' && e.designId) M.asked.set(`job:${e.jobId}`, e.instruction);
  if (e.kind === 'refine' && e.state === 'done' && e.design?.id) M.asked.set(e.design.id, M.asked.get(`job:${e.jobId}`) || e.summary || '');
  if (e.kind === 'design' || (e.kind === 'refine' && (e.state === 'done' || e.state === 'failed'))) { clearTimeout(M.t); M.t = setTimeout(() => { void loadAll(); if (page() === 'main') void loadUsage(true); }, 400); }
});
onPage(p => { if (p === 'main' || p === 'settings') { void loadAll(); void loadUsage(); } });
addEventListener('ody:provider', () => { if (!M.editing) renderKeys(); });
setInterval(() => { if (page() === 'main' && !document.hidden) renderStatus(); }, 15_000);
setInterval(() => { if ((page() === 'main' || page() === 'settings') && !document.hidden && !M.editing) void loadAll(); }, 30_000);

renderStatus(); renderUsage(); renderKeys(); renderInts();
void loadAll(); void loadUsage(true);

// for tests
window.odyMain = { reload: () => loadAll(), state: () => ({ keys: M.keys, usage: M.usage, designs: M.designs.length }) };
