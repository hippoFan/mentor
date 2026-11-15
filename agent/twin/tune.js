// Ody live layout tuner. Dormant unless the URL has ?tune=1 or the user presses Ctrl+Alt+T: until then this module
// only adds one keydown listener and touches nothing else (no DOM, no styles, no storage reads).
// What it does once on: a floating panel with every --ody-* custom property found in the page's stylesheets (slider +
// number + unit, live on :root or on one page), plus direct manipulation (hover an element, drag to move, drag the
// handles to resize, Alt+scroll to scale), undo/redo, per-page scope, localStorage save, JSON export/import and
// "Copy CSS" so the choices can be baked into the real stylesheets. See twin/TUNE-README.md.

const KEY = 'ody-tune-v1';
const PAGES = ['page-argo', 'page-main', 'page-forge', 'page-profile', 'page-settings'];
const SKIP_TOKENS = new Set(['--ody-v2']);   // flags, not sizes
let T = null;   // the running tuner (null until enabled)

function wanted() { try { return new URLSearchParams(location.search).get('tune') === '1'; } catch { return false; } }

// One window-capture key listener, registered at load: when this file loads before the app's scripts it runs before
// their own capture listeners (pages.js swallows arrows and single letters), so the tuner's keys reach it.
addEventListener('keydown', e => {
  if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyT') {
    e.preventDefault(); e.stopImmediatePropagation();
    if (!T) T = start(); else T.toggle();
    return;
  }
  T?.onKey(e);
}, true);
if (wanted()) {
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => { T ||= start(); }, { once: true });
  else T ||= start();
}

// ---------------------------------------------------------------------------------------------------------------
function start() {
  const root = document.documentElement;
  const $ = (sel, el = document) => el.querySelector(sel);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids) if (c != null) el.append(c);
    return el;
  };

  // ---- stylesheet + state --------------------------------------------------------------------------------------
  const css = h('link', { rel: 'stylesheet', href: '/twin/tune.css', 'data-ody-tune': '' });
  document.head.append(css);
  const out = h('style', { id: 'ody-tune-out', 'data-ody-tune': '' });   // the live overrides (last in <head>)
  document.head.append(out);

  /** state: { tokens: {scope: {name: value}}, elements: {scope: {selector: {dx,dy,w,h,s,inl}}} }  scope = 'all' | page id */
  let state = { tokens: {}, elements: {} };
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && typeof s === 'object') state = normal(s); } catch {}
  const undo = [], redo = [];
  let coalesceKey = '', coalesceAt = 0;
  let scope = 'all';          // where new edits go
  let compare = false;        // true = show the original design (overrides off)
  let editing = false;        // direct manipulation on/off
  let hover = null, sel = null, drag = null, depth = 0, lastStack = [];

  function normal(s) {
    const o = { tokens: {}, elements: {} };
    const okScope = k => k === 'all' || PAGES.includes(k);
    // accept the export shape too: {tokens:{name:v}, elements:{sel:{}}, pages:{'page-main':{tokens, elements}}}
    if (s.tokens && Object.values(s.tokens).some(v => typeof v !== 'object')) {
      o.tokens.all = clean(s.tokens, true); o.elements.all = clean(s.elements || {}, false);
      for (const [p, v] of Object.entries(s.pages || {})) if (okScope(p)) { o.tokens[p] = clean(v.tokens || {}, true); o.elements[p] = clean(v.elements || {}, false); }
      return o;
    }
    for (const [p, v] of Object.entries(s.tokens || {})) if (okScope(p)) o.tokens[p] = clean(v, true);
    for (const [p, v] of Object.entries(s.elements || {})) if (okScope(p)) o.elements[p] = clean(v, false);
    return o;
  }
  function clean(obj, tokens) {   // imported JSON is data: keep only plain names/values that cannot break out of a rule
    const r = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (tokens) { if (/^--ody-[a-z0-9-]+$/i.test(k) && typeof v === 'string' && /^[^;{}<>]{1,120}$/.test(v)) r[k] = v.trim(); continue; }
      if (typeof k !== 'string' || k.length > 400 || /[{}<;]/.test(k) || !v || typeof v !== 'object') continue;
      try { document.querySelector(k); } catch { continue; }
      const e = {};
      for (const f of ['dx', 'dy', 'w', 'h', 's']) if (Number.isFinite(+v[f]) && v[f] !== null && v[f] !== '') e[f] = +v[f];
      if (v.inl) e.inl = true;
      if (Object.keys(e).length) r[k] = e;
    }
    return r;
  }
  const snap = () => JSON.stringify(state);
  function before(key) {   // record an undo step; repeated edits of the same thing within 700 ms are one step
    const now = performance.now();
    if (key && key === coalesceKey && now - coalesceAt < 700) { coalesceAt = now; return; }
    coalesceKey = key || ''; coalesceAt = now;
    undo.push(snap()); if (undo.length > 200) undo.shift(); redo.length = 0;
  }
  function restore(json) { state = normal(JSON.parse(json)); changed(); }
  function save() { try { localStorage.setItem(KEY, snap()); flash('Saved'); } catch { flash('Not saved (storage blocked) – use Export'); } }
  let saveT = 0;
  function changed(light) {   // light: a slider/number edit; re-rendering the list mid-drag would drop the pointer
    apply();
    if (light) { undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length; } else render();
    clearTimeout(saveT); saveT = setTimeout(save, 300);
  }

  // ---- tokens: discover every --ody-* in the stylesheets --------------------------------------------------------
  function discover() {
    const names = new Map();   // name -> declared text (first seen)
    const walk = rules => {
      for (const r of rules) {
        if (r.cssRules && !(r instanceof CSSStyleRule)) { try { walk(r.cssRules); } catch {} continue; }
        if (!r.style) continue;
        for (let i = 0; i < r.style.length; i++) {
          const p = r.style[i];
          if (p.startsWith('--ody-') && !SKIP_TOKENS.has(p) && !names.has(p)) names.set(p, r.style.getPropertyValue(p).trim());
        }
        if (r.cssRules?.length) { try { walk(r.cssRules); } catch {} }
      }
    };
    for (const s of document.styleSheets) {
      if (s.ownerNode?.hasAttribute?.('data-ody-tune')) continue;
      try { walk(s.cssRules); } catch {}   // cross-origin sheets can't be read; the app has none
    }
    const disabled = out.disabled; out.disabled = true;   // defaults = the design without our overrides
    const cs = getComputedStyle(root);
    const list = [...names].map(([name, decl]) => {
      const def = cs.getPropertyValue(name).trim() || decl;
      return { name, def, group: name.slice(6).split('-')[0] || 'other', num: parseNum(def) };
    });
    out.disabled = disabled;
    return list.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  /** "12px", "1.5", or simple arithmetic like "calc(4px * 3)" (one unit, + - * / and brackets) -> {n, u}; else null */
  function parseNum(v) {
    const str = String(v).trim();
    const m = /^(-?\d*\.?\d+)(px|rem|em|%|vw|vh|vmin|vmax|ch|deg|s|ms|fr|)$/.exec(str);
    if (m) return { n: parseFloat(m[1]), u: m[2] };
    if (!/^calc\(/i.test(str) || !/^[\w\s.+\-*/()%]+$/.test(str)) return null;
    const toks = str.replace(/calc\(/gi, '(').match(/\d*\.?\d+[a-z%]*|[-+*/()]/gi) || [];
    let i = 0;
    const atom = () => {
      const t = toks[i++];
      if (t === '(') { const r = sum(); if (toks[i++] !== ')') throw 0; return r; }
      if (t === '-') { const r = atom(); return { n: -r.n, u: r.u }; }
      const a = /^(\d*\.?\d+)([a-z%]*)$/i.exec(t || ''); if (!a) throw 0;
      return { n: parseFloat(a[1]), u: a[2].toLowerCase() };
    };
    const prod = () => {
      let a = atom();
      while (toks[i] === '*' || toks[i] === '/') {
        const op = toks[i++], b = atom();
        if (op === '*') { if (a.u && b.u) throw 0; a = { n: a.n * b.n, u: a.u || b.u }; }
        else { if (b.u || !b.n) throw 0; a = { n: a.n / b.n, u: a.u }; }
      }
      return a;
    };
    const sum = () => {
      let a = prod();
      while (toks[i] === '+' || toks[i] === '-') {
        const op = toks[i++], b = prod();
        if (a.u !== b.u && a.n && b.n) throw 0;
        a = { n: op === '+' ? a.n + b.n : a.n - b.n, u: a.u || b.u };
      }
      return a;
    };
    try { const r = sum(); return i === toks.length && Number.isFinite(r.n) ? { n: Math.round(r.n * 1000) / 1000, u: r.u } : null; } catch { return null; }
  }
  function range(def) {
    const { n, u } = def;
    const big = { px: 120, rem: 8, em: 8, '%': 100, vw: 50, vh: 50, vmin: 50, vmax: 50, ch: 40, deg: 360, s: 3, ms: 2000, fr: 4, '': 3 }[u] ?? 100;
    let min = 0, max = n === 0 ? big : n * 3;
    if (n < 0) { min = n * 3; max = 0; }
    const span = Math.abs(max - min) || 1;
    const step = u === 'ms' ? 10 : span <= 3 ? 0.01 : span <= 12 ? 0.05 : span <= 60 ? 0.5 : 1;
    return { min, max, step };
  }
  let TOKENS = discover();
  const tokenVal = (scopeId, name) => state.tokens[scopeId]?.[name];
  const effective = name => (curPage() && tokenVal(curPage(), name)) ?? tokenVal('all', name);

  function setToken(name, value, row) {
    before('tok:' + scope + name);
    const m = (state.tokens[scope] ||= {});
    const t = TOKENS.find(x => x.name === name);
    if (value == null || value === '' || (t && value === t.def && scope === 'all')) delete m[name]; else m[name] = String(value);
    if (row) {
      row.classList.toggle('changed', m[name] != null);
      const rs = row.querySelector('.tn-ico'); if (rs) rs.disabled = m[name] == null;
    }
    changed(!!row);
  }

  // ---- elements: stable selector + overrides ------------------------------------------------------------------
  const ours = el => !!el?.closest?.('#ody-tune, #ody-tune-box, #ody-tune-hover, #ody-tune-toast');
  function selectorFor(el) {
    const esc = s => (window.CSS?.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== root; n = n.parentElement) {
      if (n.dataset?.tune) { parts.unshift(`[data-tune="${n.dataset.tune.replace(/["\\]/g, '\\$&')}"]`); break; }
      if (n.id && document.querySelectorAll('#' + esc(n.id)).length === 1) { parts.unshift('#' + esc(n.id)); break; }
      if (n === document.body) { parts.unshift('body'); break; }
      const tag = n.localName, sib = n.parentElement ? [...n.parentElement.children].filter(c => c.localName === tag) : [n];
      parts.unshift(sib.length > 1 ? `${tag}:nth-of-type(${sib.indexOf(n) + 1})` : tag);
    }
    return parts.join(' > ');
  }
  function labelFor(el) {
    if (!el) return '';
    let s = el.localName;
    if (el.id) s += '#' + el.id; else if (el.dataset?.tune) s += `[${el.dataset.tune}]`;
    const cls = [...(el.classList || [])].filter(c => !/^(on|off|rise|enter|leaving|is-|has-)/.test(c)).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    const name = el.getAttribute?.('aria-label') || (el.children.length < 4 ? el.textContent : '') || '';
    const t = name.replace(/\s+/g, ' ').trim().slice(0, 28);
    return t ? `${s} "${t}"` : s;
  }
  const elOv = (scopeId, s) => state.elements[scopeId]?.[s];
  function curOv(s) { return { ...(elOv('all', s) || {}), ...((curPage() && elOv(curPage(), s)) || {}) }; }
  function editEl(el, patch, key) {
    const s = selectorFor(el);
    before(key || 'el:' + scope + s);
    const m = (state.elements[scope] ||= {});
    const o = { ...curOv(s), ...(m[s] || {}), ...patch };
    for (const k of Object.keys(o)) if (o[k] == null || Number.isNaN(o[k])) delete o[k];
    if ((patch.w != null || patch.h != null) && getComputedStyle(el).display === 'inline') o.inl = true;
    if (!o.dx) delete o.dx; if (!o.dy) delete o.dy; if (o.s === 1) delete o.s;
    if (Object.keys(o).filter(k => k !== 'inl').length) m[s] = o; else delete m[s];
    changed();
  }
  function resetEl(s) {
    before();
    for (const sc of Object.keys(state.elements)) if (scope === 'all' || sc === scope) delete state.elements[sc][s];
    changed();
  }
  const r2 = n => Math.round(n * 100) / 100;
  function elRule(s, o, prefix, important) {
    const imp = important ? ' !important' : '';
    const d = [];
    if (o.dx || o.dy) d.push(`translate: ${r2(o.dx || 0)}px ${r2(o.dy || 0)}px${imp}`);
    if (o.s != null && o.s !== 1) d.push(`scale: ${r2(o.s)}${imp}`);
    if (o.w != null) d.push(`width: ${r2(o.w)}px${imp}`, `max-width: none${imp}`);
    if (o.h != null) d.push(`height: ${r2(o.h)}px${imp}`, `max-height: none${imp}`);
    if (o.w != null || o.h != null) { d.push(`box-sizing: border-box${imp}`); if (o.inl) d.push(`display: inline-block${imp}`); }
    if (!d.length) return '';
    const full = prefix && !s.startsWith(prefix) ? `${prefix} ${s}` : s;
    return `${full} { ${d.join('; ')}; }`;
  }
  function buildCSS(important) {
    const lines = [];
    const tokBlock = (sel, toks) => {
      const e = Object.entries(toks || {});
      if (e.length) lines.push(`${sel} {\n${e.map(([k, v]) => `  ${k}: ${v}${important ? ' !important' : ''};`).join('\n')}\n}`);
    };
    tokBlock(':root', state.tokens.all);
    for (const p of PAGES) tokBlock('#' + p, state.tokens[p]);
    for (const [s, o] of Object.entries(state.elements.all || {})) { const r = elRule(s, o, '', important); if (r) lines.push(r); }
    for (const p of PAGES) for (const [s, o] of Object.entries(state.elements[p] || {})) { const r = elRule(s, o, '#' + p, important); if (r) lines.push(r); }
    return lines.join('\n');
  }
  function apply() { out.textContent = compare ? '' : buildCSS(true); place(); }

  // ---- current page / viewport ----------------------------------------------------------------------------------
  function curPage() {
    const id = document.body.dataset.page;
    if (id && PAGES.includes('page-' + id)) return 'page-' + id;
    const vis = [...document.querySelectorAll('section.page')].find(p => !p.hidden && !p.classList.contains('off'));
    return vis && PAGES.includes(vis.id) ? vis.id : null;
  }
  const bp = w => (w < 600 ? 'phone' : w < 900 ? 'tablet' : w < 1280 ? 'laptop' : w < 1680 ? 'desktop' : 'wide');

  // ---- panel --------------------------------------------------------------------------------------------------
  const panel = h('aside', { id: 'ody-tune', class: 'dock-right', role: 'dialog', 'aria-label': 'Layout tuner', 'aria-modal': 'false' });
  const head = h('div', { class: 'tn-head' },
    h('span', { class: 'tn-grip', 'aria-hidden': 'true', text: '⠿' }),
    h('strong', { text: 'Layout tuner' }),
    h('span', { class: 'tn-vp', 'aria-live': 'off' }),
    h('button', { type: 'button', class: 'tn-ico', title: 'Dock on the other side', 'aria-label': 'Dock on the other side', onclick: () => dock(), text: '⇆' }),
    h('button', { type: 'button', class: 'tn-ico tn-collapse', title: 'Collapse', 'aria-label': 'Collapse panel', 'aria-expanded': 'true', onclick: () => collapse(), text: '–' }),
    h('button', { type: 'button', class: 'tn-ico', title: 'Hide (Ctrl+Alt+T)', 'aria-label': 'Hide tuner (Ctrl+Alt+T brings it back)', onclick: () => toggle(false), text: '×' }));
  const body = h('div', { class: 'tn-body' });
  const scopeSel = h('select', { 'aria-label': 'Where changes apply', onchange: e => { scope = e.target.value; render(); } });
  const editBtn = h('button', { type: 'button', class: 'tn-btn tn-edit', 'aria-pressed': 'false', onclick: () => setEditing(!editing), title: 'Ctrl+Alt+E' }, 'Move & resize');
  const cmpBtn = h('button', { type: 'button', class: 'tn-btn', 'aria-pressed': 'false', onclick: () => { compare = !compare; cmpBtn.setAttribute('aria-pressed', String(compare)); apply(); }, title: 'Show the original design' }, 'Compare');
  const undoBtn = h('button', { type: 'button', class: 'tn-btn', onclick: () => doUndo(), title: 'Ctrl+Z' }, 'Undo');
  const redoBtn = h('button', { type: 'button', class: 'tn-btn', onclick: () => doRedo(), title: 'Ctrl+Y' }, 'Redo');
  const search = h('input', { type: 'search', placeholder: 'Filter tokens…', 'aria-label': 'Filter tokens', oninput: () => renderTokens() });
  const selBox = h('div', { class: 'tn-sel' });
  const elList = h('div', { class: 'tn-ellist' });
  const tokBox = h('div', { class: 'tn-tokens' });
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: e => importFile(e.target.files?.[0]) });
  const toast = h('div', { id: 'ody-tune-toast', role: 'status', 'aria-live': 'polite' });
  body.append(
    h('div', { class: 'tn-row tn-tools' }, editBtn, cmpBtn, undoBtn, redoBtn),
    h('label', { class: 'tn-row tn-scope' }, h('span', { text: 'Apply to' }), scopeSel),
    selBox,
    h('details', { class: 'tn-group tn-els', open: true }, h('summary', { text: 'Moved / resized elements' }), elList),
    h('div', { class: 'tn-row' }, search),
    tokBox,
    h('div', { class: 'tn-row tn-io' },
      h('button', { type: 'button', class: 'tn-btn', onclick: () => { save(); } }, 'Save'),
      h('button', { type: 'button', class: 'tn-btn', onclick: () => exportJSON() }, 'Export'),
      h('button', { type: 'button', class: 'tn-btn', onclick: () => file.click() }, 'Import'),
      h('button', { type: 'button', class: 'tn-btn', onclick: () => copyCSS() }, 'Copy CSS'),
      h('button', { type: 'button', class: 'tn-btn tn-danger', onclick: () => resetAll() }, 'Reset all')),
    h('p', { class: 'tn-hint', text: 'Ctrl+Alt+E: move & resize · hover + click to pick · drag to move · handles to resize (Shift keeps shape) · Alt+scroll to scale · arrows nudge · P parent · D deeper · Esc done · Ctrl+Z / Ctrl+Y' }),
    file);
  panel.append(head, body);
  const hoverBox = h('div', { id: 'ody-tune-hover', 'aria-hidden': 'true' }, h('span', { class: 'tn-tag' }));
  const box = h('div', { id: 'ody-tune-box', 'aria-hidden': 'true' }, h('span', { class: 'tn-tag' }),
    ...['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'].map(d => h('i', { class: 'tn-h tn-' + d, 'data-dir': d })));
  document.body.append(panel, hoverBox, box, toast);

  // panel position (drag by header), dock side, collapse: remembered per browser
  let ui = { side: 'right', top: 72, collapsed: false, x: null };
  try { Object.assign(ui, JSON.parse(localStorage.getItem(KEY + '-ui') || '{}')); } catch {}
  const saveUi = () => { try { localStorage.setItem(KEY + '-ui', JSON.stringify(ui)); } catch {} };
  function layoutPanel() {
    panel.classList.toggle('dock-left', ui.side === 'left'); panel.classList.toggle('dock-right', ui.side !== 'left');
    panel.classList.toggle('collapsed', !!ui.collapsed);
    $('.tn-collapse', panel).setAttribute('aria-expanded', String(!ui.collapsed));
    $('.tn-collapse', panel).textContent = ui.collapsed ? '+' : '–';
    const top = Math.max(8, Math.min(innerHeight - 48, ui.top));
    panel.style.top = top + 'px';
    if (ui.x != null) { panel.style.left = Math.max(0, Math.min(innerWidth - 120, ui.x)) + 'px'; panel.style.right = 'auto'; }
    else { panel.style.left = ''; panel.style.right = ''; }
  }
  function dock() { ui.side = ui.side === 'left' ? 'right' : 'left'; ui.x = null; layoutPanel(); saveUi(); }
  function collapse() { ui.collapsed = !ui.collapsed; layoutPanel(); saveUi(); }
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const mv = ev => { ui.x = ev.clientX - ox; ui.top = ev.clientY - oy; layoutPanel(); };
    const up = () => {
      head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up);
      const pr = panel.getBoundingClientRect();   // snap to the nearer edge
      if (pr.left < 24 || pr.right > innerWidth - 24) { ui.side = pr.left + pr.width / 2 < innerWidth / 2 ? 'left' : 'right'; ui.x = null; }
      layoutPanel(); saveUi();
    };
    head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up);
  });
  head.addEventListener('dblclick', e => { if (!e.target.closest('button')) collapse(); });

  // ---- render ---------------------------------------------------------------------------------------------------
  const scopeName = p => ({ 'page-argo': 'Argo', 'page-main': 'Home', 'page-forge': 'Forge', 'page-profile': 'Profile', 'page-settings': 'Settings' }[p] || p);
  function render() {
    const cp = curPage();
    if (scope !== 'all' && scope !== cp && !PAGES.includes(scope)) scope = 'all';
    scopeSel.replaceChildren(h('option', { value: 'all', text: 'All pages' }),
      ...PAGES.filter(p => p === cp || p === scope || state.tokens[p] || state.elements[p])
        .map(p => h('option', { value: p, text: `${scopeName(p)} only${p === cp ? ' (this page)' : ''}` })));
    scopeSel.value = scope;
    undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length;
    renderTokens(); renderEls(); renderSel(); viewport();
  }
  const openGroups = new Set();
  function renderTokens() {
    const q = search.value.trim().toLowerCase();
    if (!TOKENS.length) {
      tokBox.replaceChildren(h('p', { class: 'tn-hint', text: 'No --ody-* tokens found in the stylesheets yet. Move & resize still works.' }),
        h('button', { type: 'button', class: 'tn-btn', onclick: () => { TOKENS = discover(); render(); } }, 'Rescan'));
      return;
    }
    const groups = new Map();
    for (const t of TOKENS) if (!q || t.name.includes(q)) { if (!groups.has(t.group)) groups.set(t.group, []); groups.get(t.group).push(t); }
    const frag = [];
    for (const [g, list] of groups) {
      const n = list.filter(t => tokenVal(scope, t.name) != null).length;
      const d = h('details', { class: 'tn-group', open: q || openGroups.has(g) ? true : null },
        h('summary', {}, h('span', { text: g }), h('small', { text: `${list.length}${n ? ` · ${n} changed` : ''}` })));
      d.addEventListener('toggle', () => { if (d.open) openGroups.add(g); else openGroups.delete(g); });
      for (const t of list) d.append(tokenRow(t));
      frag.push(d);
    }
    tokBox.replaceChildren(...frag);
  }
  function tokenRow(t) {
    const own = tokenVal(scope, t.name), cur = own ?? (scope === 'all' ? null : tokenVal('all', t.name)) ?? (getComputedStyle(root).getPropertyValue(t.name).trim() || t.def);
    const id = 'tn-' + t.name.slice(2);
    const row = h('div', { class: 'tn-tok' + (own != null ? ' changed' : '') });
    const label = h('label', { for: id, title: `${t.name}\ndefault: ${t.def}`, text: t.name.slice(6) });
    const reset = h('button', { type: 'button', class: 'tn-ico', title: 'Reset to default', 'aria-label': `Reset ${t.name}`, disabled: own == null ? true : null, onclick: () => setToken(t.name, null) }, '↺');
    const cn = parseNum(cur);
    if (t.num && cn) {
      const unit = cn.u;
      const { min, max, step } = range(t.num);
      const rng = h('input', { type: 'range', min, max: Math.max(max, cn.n), step, value: cn.n, 'aria-label': `${t.name} slider`, tabindex: '-1' });
      const num = h('input', { type: 'number', id, step, value: r2(cn.n), class: 'tn-num' });
      const us = h('select', { class: 'tn-unit', 'aria-label': `${t.name} unit` },
        ...[...new Set([unit, t.num.u, 'px', 'rem', 'em', '%', 'vw', 'vh'])].filter(u => u !== undefined)
          .filter(u => (t.num.u === '' ? u === '' : u !== '') || u === unit).map(u => h('option', { value: u, text: u || '×' })));
      us.value = unit;
      const set = (v, from) => { if (from !== num) num.value = r2(v); if (from !== rng) rng.value = v; setToken(t.name, `${r2(v)}${us.value}`, row); };
      rng.addEventListener('input', () => set(+rng.value, rng));
      num.addEventListener('input', () => { if (num.value !== '' && Number.isFinite(+num.value)) set(+num.value, num); });
      us.addEventListener('change', () => set(+num.value));
      row.append(label, rng, num, us, reset);
    } else {
      const txt = h('input', { type: 'text', id, value: cur, class: 'tn-txt', spellcheck: 'false' });
      txt.addEventListener('change', () => { if (/^[^;{}<>]{0,120}$/.test(txt.value)) setToken(t.name, txt.value.trim(), row); else flash('That value is not allowed'); });
      row.append(label, txt, reset);
    }
    return row;
  }
  function renderEls() {
    const items = [];
    for (const [sc, map] of Object.entries(state.elements)) for (const [s, o] of Object.entries(map || {})) items.push({ sc, s, o });
    if (!items.length) { elList.replaceChildren(h('p', { class: 'tn-hint', text: 'Nothing moved yet. Press "Move & resize", then pick something on the page.' })); return; }
    elList.replaceChildren(...items.map(({ sc, s, o }) => {
      let el = null; try { el = document.querySelector(sc === 'all' ? s : `#${sc} ${s}`) || document.querySelector(s); } catch {}
      const desc = [o.dx || o.dy ? `moved ${Math.round(o.dx || 0)},${Math.round(o.dy || 0)}` : '', o.s && o.s !== 1 ? `×${r2(o.s)}` : '',
        o.w != null ? `w ${Math.round(o.w)}` : '', o.h != null ? `h ${Math.round(o.h)}` : ''].filter(Boolean).join(' · ');
      return h('div', { class: 'tn-elrow' },
        h('button', { type: 'button', class: 'tn-link', title: s, onclick: () => { if (el) { setEditing(true); pick(el); el.scrollIntoView({ block: 'nearest' }); } else flash('Not on this page'); } },
          h('span', { text: (el ? labelFor(el) : s).slice(0, 40) }), h('small', { text: `${sc === 'all' ? 'all pages' : scopeName(sc)} · ${desc}` })),
        h('button', { type: 'button', class: 'tn-ico', title: 'Reset this element', 'aria-label': 'Reset element', onclick: () => { before(); delete state.elements[sc][s]; changed(); } }, '↺'));
    }));
  }
  function renderSel() {
    if (!sel || !sel.isConnected) { sel = null; selBox.replaceChildren(); selBox.hidden = true; return; }
    selBox.hidden = false;
    const s = selectorFor(sel), o = curOv(s);
    const f = (k, lbl, step, def) => {
      const inp = h('input', { type: 'number', step, value: o[k] != null ? r2(o[k]) : '', placeholder: def, 'aria-label': lbl, class: 'tn-num' });
      inp.addEventListener('change', () => editEl(sel, { [k]: inp.value === '' ? null : +inp.value }));
      return h('label', { class: 'tn-f' }, h('span', { text: lbl }), inp);
    };
    const r = sel.getBoundingClientRect();
    selBox.replaceChildren(
      h('div', { class: 'tn-selhead' }, h('strong', { text: labelFor(sel) }),
        h('button', { type: 'button', class: 'tn-ico', title: 'Select parent (P)', 'aria-label': 'Select parent', onclick: () => sel.parentElement && sel.parentElement !== document.body && pick(sel.parentElement) }, '↑'),
        h('button', { type: 'button', class: 'tn-ico', title: 'Reset this element', 'aria-label': 'Reset element', onclick: () => resetEl(s) }, '↺'),
        h('button', { type: 'button', class: 'tn-ico', title: 'Deselect (Esc)', 'aria-label': 'Deselect', onclick: () => pick(null) }, '×')),
      h('code', { class: 'tn-path', text: s }),
      h('div', { class: 'tn-fields' }, f('dx', 'Move X', 1, '0'), f('dy', 'Move Y', 1, '0'), f('w', 'Width', 1, Math.round(r.width)), f('h', 'Height', 1, Math.round(r.height)), f('s', 'Scale', 0.05, '1')));
  }
  function viewport() { $('.tn-vp', panel).textContent = `${innerWidth}×${innerHeight} · ${bp(innerWidth)}`; }

  // ---- direct manipulation ------------------------------------------------------------------------------------
  function setEditing(on) {
    editing = on; decoAt = 0; if (on) { try { getSelection()?.removeAllRanges(); } catch {} } editBtn.setAttribute('aria-pressed', String(on)); root.classList.toggle('ody-tuning', on);
    if (!on) { hover = null; pick(null); }
    place();
  }
  // decorations usually have pointer-events:none, so elementsFromPoint never reports them: keep our own list
  let decoList = [], decoAt = 0;
  function decos() {
    if (performance.now() - decoAt > 2000) {
      decoAt = performance.now();
      decoList = [...document.body.querySelectorAll('*')].filter(el => !ours(el) && el.localName !== 'script' && el.localName !== 'style' && !el.closest('svg *') && getComputedStyle(el).pointerEvents === 'none');
    }
    return decoList;
  }
  const seen = el => el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  function candidates(x, y) {
    const vw = innerWidth * innerHeight;
    const extra = decos().filter(el => { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width && seen(el); });
    const st = [...document.elementsFromPoint(x, y), ...extra].filter(el => !ours(el) && el !== root && el !== document.body && seen(el))
      .map(el => { const svg = el.closest('svg'); let top = svg; while (top?.parentElement?.closest('svg')) top = top.parentElement.closest('svg'); return top || el; });
    const uniq = [...new Set(st)];
    const area = el => { const r = el.getBoundingClientRect(); return r.width * r.height; };
    const sized = uniq.filter(el => { const a = area(el); return a < vw * 0.92 && a > 4; });
    return (sized.length ? sized : uniq).map(el => [el, area(el)]).sort((a, b) => a[1] - b[1]).map(e => e[0]);   // most specific first
  }
  function pick(el) { sel = el; renderSel(); place(); if (el) panel.querySelector('.tn-sel')?.scrollIntoView?.({ block: 'nearest' }); }
  function frame(boxEl, el) {
    if (!el || !el.isConnected) { boxEl.hidden = true; return; }
    const r = el.getBoundingClientRect();
    boxEl.hidden = false;
    Object.assign(boxEl.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    boxEl.querySelector('.tn-tag').textContent = `${labelFor(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    boxEl.classList.toggle('tag-below', r.top < 22);
  }
  function place() { frame(hoverBox, editing && visible && hover !== sel ? hover : null); frame(box, editing && visible ? sel : null); }
  addEventListener('scroll', () => visible && place(), true);
  addEventListener('resize', () => { if (visible) { viewport(); place(); } });

  const block = e => { if (editing && visible && !ours(e.target)) { e.preventDefault(); e.stopPropagation(); } };
  for (const t of ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'touchstart']) addEventListener(t, block, { capture: true, passive: false });

  addEventListener('pointermove', e => {
    if (!editing || !visible) return;
    if (drag) { dragMove(e); return; }
    if (ours(e.target) && !e.target.classList?.contains('tn-h')) { if (hover) { hover = null; place(); } return; }
    if (e.target.classList?.contains('tn-h')) return;
    lastStack = candidates(e.clientX, e.clientY);
    const next = lastStack[Math.min(depth, lastStack.length - 1)] || null;
    if (next !== hover) { hover = next; place(); }
  }, true);
  addEventListener('pointerdown', e => {
    if (!editing || !visible || e.button !== 0) return;
    const handle = e.target.classList?.contains('tn-h') ? e.target.dataset.dir : null;
    if (ours(e.target) && !handle) return;
    e.preventDefault(); e.stopPropagation();
    if (!handle) {
      const target = hover || candidates(e.clientX, e.clientY)[0];
      if (!target) return;
      if (target !== sel && !(sel && sel.contains(target) && e.altKey)) {
        // first press picks; a press inside the picked element starts a move
        if (!sel || !sel.contains(target)) { pick(target); }
      }
    }
    if (!sel) return;
    const s = selectorFor(sel), o = curOv(s), r = sel.getBoundingClientRect(), sc = o.s || 1;
    drag = { dir: handle || 'move', x: e.clientX, y: e.clientY, o, w0: o.w ?? r.width / sc, h0: o.h ?? r.height / sc, sc, ratio: r.width / Math.max(1, r.height), key: 'drag:' + performance.now() };
    try { e.target.setPointerCapture?.(e.pointerId); } catch {}
  }, true);
  addEventListener('pointerup', () => { if (drag) { drag = null; place(); } }, true);
  addEventListener('pointercancel', () => { drag = null; }, true);
  function dragMove(e) {
    const d = drag, dx = e.clientX - d.x, dy = e.clientY - d.y, p = {};
    if (d.dir === 'move') { p.dx = (d.o.dx || 0) + dx; p.dy = (d.o.dy || 0) + dy; }
    else {
      let w = d.w0, hh = d.h0;
      if (d.dir.includes('e')) w = d.w0 + dx / d.sc;
      if (d.dir.includes('w')) w = d.w0 - dx / d.sc;
      if (d.dir.includes('s')) hh = d.h0 + dy / d.sc;
      if (d.dir.includes('n')) hh = d.h0 - dy / d.sc;
      if (e.shiftKey && d.dir.length === 2) hh = w / d.ratio;   // corner + Shift keeps the shape
      if (/[ew]/.test(d.dir)) p.w = Math.max(4, w);
      if (/[ns]/.test(d.dir)) p.h = Math.max(4, hh);
      // a box grows from its top-left, so pulling the left/top edge also moves it to keep the far edge put
      if (d.dir.includes('w')) p.dx = (d.o.dx || 0) + (d.w0 - p.w) * d.sc;
      if (d.dir.includes('n')) p.dy = (d.o.dy || 0) + (d.h0 - p.h) * d.sc;
    }
    editEl(sel, p, d.key);
  }
  addEventListener('wheel', e => {
    if (!editing || !visible || !e.altKey) return;
    const el = hover || sel; if (!el || ours(el)) return;
    e.preventDefault(); e.stopPropagation();
    if (el !== sel) pick(el);
    const s = curOv(selectorFor(el)).s || 1;
    editEl(el, { s: Math.max(0.1, Math.min(6, r2(s * Math.exp(-Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0004)))) }, 'wheel:' + selectorFor(el));
  }, { capture: true, passive: false });

  // ---- keyboard (called from the module's single key listener) -------------------------------------------------------
  const stop = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  function onKey(e) {
    if (!visible) return;
    const inField = e.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
      if (inField && !ours(inField)) return;   // the app's own text fields keep native undo
      stop(e);
      if (e.key.toLowerCase() === 'y' || e.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (mod && e.altKey && e.code === 'KeyE') { stop(e); setEditing(!editing); return; }
    if (inField || mod || e.altKey) return;
    if (!editing) return;
    if (e.key === 'Escape') { stop(e); if (sel) pick(null); else setEditing(false); return; }
    if (!sel && hover && e.key === 'Enter') { stop(e); pick(hover); return; }
    if (e.key === 'd' || e.key === 'D') { stop(e); depth = (depth + 1) % Math.max(1, lastStack.length); hover = lastStack[depth] || hover; place(); flash(`Layer ${depth + 1} of ${lastStack.length}`); return; }
    if (!sel) return;
    const s = selectorFor(sel), o = curOv(s), step = e.shiftKey ? 10 : 1;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (arrows[e.key]) { stop(e); editEl(sel, { dx: (o.dx || 0) + arrows[e.key][0], dy: (o.dy || 0) + arrows[e.key][1] }, 'key:' + s); return; }
    if (e.key === '+' || e.key === '=') { stop(e); editEl(sel, { s: r2((o.s || 1) * 1.05) }, 'key:' + s); return; }
    if (e.key === '-' || e.key === '_') { stop(e); editEl(sel, { s: r2((o.s || 1) / 1.05) }, 'key:' + s); return; }
    if (e.key === 'p' || e.key === 'P') { stop(e); if (sel.parentElement && sel.parentElement !== document.body) pick(sel.parentElement); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { stop(e); resetEl(s); return; }
  }

  function doUndo() { if (!undo.length) return; redo.push(snap()); coalesceKey = ''; restore(undo.pop()); flash('Undone'); }
  function doRedo() { if (!redo.length) return; undo.push(snap()); coalesceKey = ''; restore(redo.pop()); flash('Redone'); }
  function resetAll() {
    if (!confirm(scope === 'all' ? 'Reset every token and element on all pages?' : `Reset everything set for ${scopeName(scope)} only?`)) return;
    before();
    if (scope === 'all') state = { tokens: {}, elements: {} }; else { delete state.tokens[scope]; delete state.elements[scope]; }
    changed();
  }

  // ---- save / export / import / copy ----------------------------------------------------------------------------
  function exportShape() {
    const o = { tokens: { ...(state.tokens.all || {}) }, elements: { ...(state.elements.all || {}) }, pages: {} };
    for (const p of PAGES) if (Object.keys(state.tokens[p] || {}).length || Object.keys(state.elements[p] || {}).length)
      o.pages[p] = { tokens: { ...(state.tokens[p] || {}) }, elements: { ...(state.elements[p] || {}) } };
    o.viewport = `${innerWidth}x${innerHeight}`; o.saved = new Date().toISOString();
    return o;
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name, hidden: true }); panel.append(a); a.click(); a.remove();   // inside the panel: edit mode blocks page clicks
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function exportJSON() { download('ody-layout.json', JSON.stringify(exportShape(), null, 2), 'application/json'); flash('Downloaded ody-layout.json'); }
  async function importFile(f) {
    if (!f) return;
    try {
      if (f.size > 512 * 1024) throw new Error('too big');
      const s = JSON.parse(await f.text());
      before(); state = normal(s); changed(); flash('Imported');
    } catch { flash('Could not read that file'); }
    file.value = '';
  }
  async function copyCSS() {
    const text = `/* Ody layout tuner — ${new Date().toISOString().slice(0, 16)} at ${innerWidth}x${innerHeight}. Paste at the end of the last stylesheet. */\n${buildCSS(false) || '/* no changes */'}\n`;
    try { await navigator.clipboard.writeText(text); flash('CSS copied'); }
    catch {
      const ta = h('textarea', { class: 'tn-copy', readonly: true, 'aria-label': 'CSS to copy' }); ta.value = text;
      body.append(ta); ta.select(); try { document.execCommand('copy'); flash('CSS copied'); } catch { flash('Select the text and copy it'); }
      setTimeout(() => ta.remove(), 8000);
    }
  }
  let toastT = 0;
  function flash(msg) { toast.textContent = msg; toast.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toast.classList.remove('on'), 1600); }

  // ---- show / hide ----------------------------------------------------------------------------------------------
  let visible = true;
  function toggle(on = !visible) {
    visible = on; panel.hidden = !on;
    if (!on) setEditing(false); else { TOKENS = discover(); render(); }
    place();
    flash(on ? 'Tuner on' : 'Tuner hidden — Ctrl+Alt+T to bring it back');
  }
  // page changes (body[data-page]) refresh the scope list and outline
  new MutationObserver(() => { if (scope !== 'all') scope = curPage() || 'all'; if (visible) { render(); place(); } }).observe(document.body, { attributes: true, attributeFilter: ['data-page'] });
  // tokens defined by sheets that load later (or by the other agent's edits) show up on the next rescan
  addEventListener('load', () => { TOKENS = discover(); render(); }, { once: true });

  layoutPanel(); apply(); render();
  flash('Layout tuner on');
  return { toggle, onKey };
}
