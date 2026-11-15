// The three pages around one WebSocket (twin/shell.js): Argo (the ship: today's app), Main (home: the control centre)
// and The Forge (past and imported designs, twin/forge.js, mounted on first show). Edge tabs, the pager, ← → keys and
// swipes switch pages without a reload. Hidden pages keep receiving every event (they subscribe to the shell's bus);
// Argo is only made invisible, never display:none, so the 3D view keeps its size and keeps rendering a live call.
// Needs /twin/app.css: without it (an older page server) the page stays the one-page Argo app.
import { subscribe } from './shell.js';
import { selectDesign } from './argos.js';

const ORDER = ['argo', 'main', 'forge'];
const NAMES = { argo: 'Argo', main: 'Main', forge: 'The Forge' };
const root = document.documentElement;
const $ = id => document.getElementById(id);
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const v2 = getComputedStyle(root).getPropertyValue('--ody-v2').trim() === '1';

let current = v2 ? null : 'argo';
/** The page showing now: 'argo' | 'main' | 'forge'. */
export const page = () => current;
const listeners = new Set();
/** @param {(page: string) => void} fn  called after every switch @returns {() => void} */
export function onPage(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Toast at the bottom centre: role=status, or role=alert (stays until dismissed) for errors. */
export function toast(text, { error = false, ms = 6000 } = {}) {
  let box = document.querySelector('.ody-toasts.global');
  if (!box) { box = document.createElement('div'); box.className = 'ody-toasts global'; document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'ody-toast'; t.setAttribute('role', error ? 'alert' : 'status');
  t.append(String(text).slice(0, 300));
  if (error) {
    const x = document.createElement('button'); x.type = 'button'; x.textContent = 'Dismiss'; x.addEventListener('click', () => t.remove());
    t.append(x);
  } else setTimeout(() => t.remove(), ms);
  box.append(t);
  while (box.children.length > 3) box.firstElementChild.remove();
}
window.odyToast = (text, opts) => toast(text, opts);

// ---------- the ornament sprite: our own static file, inlined once so <use href="#o-..."> resolves everywhere ----------
async function inlineSprite() {
  try {
    const r = await fetch('/twin/ornaments.svg');
    if (!r.ok) return;
    const holder = $('ody-sprite');
    holder.innerHTML = await r.text();   // same-origin static asset we ship (design/preview/ornaments.svg)
    const svg = holder.querySelector('svg');
    if (svg) { svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true'); svg.style.position = 'absolute'; }
    holder.hidden = false;
  } catch { /* decorations only */ }
}

// ---------- The Forge: mounted on first show; a failure becomes a friendly empty state ----------
let forge = null;
function openRefine(id) { goTo('argo'); try { selectDesign(id); } catch (e) { console.warn('[ody] selectDesign', e); } }
function forgeEmpty(rootEl, why) {
  rootEl.replaceChildren();
  const h = document.createElement('h1'); h.id = 'forge-h'; h.className = 't-hero'; h.textContent = 'The Forge';
  const box = document.createElement('div'); box.className = 'ody-empty forge-fallback';
  box.innerHTML = '<svg class="o" viewBox="0 0 160 48" aria-hidden="true"><use href="#o-olive"/></svg>';   // static markup
  const p = document.createElement('p'); p.textContent = why; box.append(p);
  rootEl.append(h, box);
}
function mountForgePage() {
  if (forge) return forge;
  const rootEl = $('page-forge');
  if (!document.querySelector('link[href="/twin/forge.css"]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/twin/forge.css'; document.head.append(l);
  }
  forge = import('/twin/forge.js')
    .then(m => { if (typeof m.mountForge !== 'function') throw new Error('no mountForge'); return m.mountForge(rootEl, { subscribe, openRefine }); })
    .catch(err => {
      console.warn('[ody] The Forge did not load', err?.message || err);
      forgeEmpty(rootEl, 'The Forge didn’t open this time. Your designs are safe: Argos’s Refine tab lists them all.');
    });
  return forge;
}

// ---------- switching ----------
let pending = null;   // finishes an in-flight switch first, so fast key presses never show two pages
function setChrome(id) {
  for (const a of document.querySelectorAll('.pager a')) {
    if (a.dataset.go === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  for (const t of document.querySelectorAll('.edge-tab')) t.hidden = t.dataset.on !== id;
  document.body.dataset.page = id;
  document.title = id === 'main' ? 'Ody' : `${NAMES[id]} · Ody`;
}
function showOnly(next) {
  for (const p of document.querySelectorAll('#pages > .page')) {
    const on = p === next;
    p.classList.remove('leave-l', 'leave-r', 'from-l', 'from-r', 'enter');
    if (p.id === 'page-argo') { p.classList.toggle('off', !on); p.hidden = false; }
    else p.hidden = !on;
    p.inert = !on;
  }
}
/**
 * @param {'argo'|'main'|'forge'} id
 * @param {{focus?: boolean, push?: boolean}} [opts]
 */
export function goTo(id, { focus = false, push = true } = {}) {
  if (!v2 || !ORDER.includes(id)) return;
  if (pending) pending();
  const prev = current, next = $(`page-${id}`);
  if (prev === id) return;
  current = id;
  setChrome(id);
  if (push && location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  if (id === 'forge') mountForgePage();
  const dir = prev ? Math.sign(ORDER.indexOf(id) - ORDER.indexOf(prev)) : 0;
  const enter = () => {
    pending = null;
    showOnly(next);
    if (prev) { void next.offsetWidth; next.classList.add('enter'); if (dir) next.classList.add(dir > 0 ? 'from-r' : 'from-l'); }
    if (focus) next.querySelector('h1')?.focus({ preventScroll: true });
    for (const fn of listeners) { try { fn(id); } catch (e) { console.warn('[ody] page listener', e); } }
  };
  const out = prev && $(`page-${prev}`);
  if (out && dir && !reduce.matches) {
    pending = enter;
    out.classList.add(dir > 0 ? 'leave-l' : 'leave-r');
    out.addEventListener('animationend', () => { if (pending === enter) enter(); }, { once: true });
    setTimeout(() => { if (pending === enter) enter(); }, 400);   // never stuck if the animation is skipped
  } else enter();
}
const step = d => { const i = ORDER.indexOf(current) + d; if (i >= 0 && i < ORDER.length) goTo(ORDER[i], { focus: true }); };

function init() {
  root.classList.add('v2');
  for (const h of document.querySelectorAll('#pages > .page h1')) h.tabIndex = -1;
  for (const a of document.querySelectorAll('[data-go]')) a.addEventListener('click', e => { e.preventDefault(); goTo(a.dataset.go, { focus: true }); });
  addEventListener('hashchange', () => { const id = location.hash.slice(1); if (ORDER.includes(id)) goTo(id); });

  // keys: ← → switch pages (not while typing, nor inside the 3D view, a list, tabs or a dialog). Off Argo, the 3D view's
  // single-letter shortcuts (H, E, X, T…) are held back so they never act on a page you can't see.
  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target instanceof Element ? e.target : document.body;
    if (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.shiftKey || t.closest('[role="application"], [role="listbox"], [role="tablist"], [role="slider"], [role="dialog"], #argos-panel, #panel, #guide, .coach, .handhelp')) return;
      if (!$('keysheet').hidden) return;
      e.preventDefault(); e.stopImmediatePropagation();
      step(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (current !== 'argo' && e.key.length === 1) e.stopImmediatePropagation();
  }, true);

  // swipes: touch or pen drags across the page, and sideways trackpad swipes (not over the 3D view or a panel)
  const noSwipe = '#stage, #phone, #argos-panel, #panel, .keysheet, input, textarea, select, .rail, [data-noswipe]';
  let start = null;
  addEventListener('pointerdown', e => { start = (e.pointerType === 'touch' || e.pointerType === 'pen') && !e.target.closest?.(noSwipe) ? { x: e.clientX, y: e.clientY, t: Date.now() } : null; }, { passive: true });
  addEventListener('pointerup', e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y; start = null;
    if (Math.abs(dx) > 80 && Math.abs(dy) < Math.abs(dx) * 0.6) step(dx < 0 ? 1 : -1);
  }, { passive: true });
  let acc = 0, quietUntil = 0, accTimer = 0;
  addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5 || e.target.closest?.(noSwipe)) return;
    if (Date.now() < quietUntil) return;
    acc += e.deltaX; clearTimeout(accTimer); accTimer = setTimeout(() => { acc = 0; }, 220);
    if (Math.abs(acc) > 160) { step(acc > 0 ? 1 : -1); acc = 0; quietUntil = Date.now() + 800; }
  }, { passive: true });

  // ambient loops pause while the tab is hidden or a call is live (guide §7: only the Live dot moves during a call)
  const pause = () => root.classList.toggle('ody-paused', document.hidden || document.body.dataset.phase === 'live');
  document.addEventListener('visibilitychange', pause);
  new MutationObserver(pause).observe(document.body, { attributes: true, attributeFilter: ['data-phase'] });
  pause();

  void inlineSprite();
  const first = location.hash.slice(1);
  goTo(ORDER.includes(first) ? first : 'main', { push: false });
}

if (v2) init();

// for tests
window.odyPages = { page, goTo: id => goTo(id), openRefine, v2 };
