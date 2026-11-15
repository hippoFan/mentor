// The pages around one WebSocket (twin/shell.js): Argo (the ship: today's app), Home (#main: the control centre),
// The Forge (past and imported designs, twin/forge.js, mounted on first show), and Profile + Settings (twin/account.js).
// The app bar's nav, the logo (home), ← → keys and swipes switch pages without a reload. Hidden pages keep receiving every event (they subscribe to the shell's bus);
// Argo is only made invisible, never display:none, so the 3D view keeps its size and keeps rendering a live call.
// Needs /twin/app.css: without it (an older page server) the page stays the one-page Argo app.
import { subscribe } from './shell.js';
import { selectDesign } from './argos.js';

const ORDER = ['argo', 'main', 'forge'];                 // the swipe / ← → order
const PAGES = [...ORDER, 'profile', 'settings'];          // Profile and Settings open from the avatar menu
const NAMES = { argo: 'Argo Simulation', main: 'Home', forge: 'The Forge', profile: 'Profile', settings: 'Settings' };
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

// ---------- switching: a horizontal slide, decoration layers moving further than the page (parallax) ----------
// transform and opacity only; one ease-out for arrivals, an ease-in for exits (exits are faster); reduced motion cuts.
const reduced = () => reduce.matches || root.classList.contains('reduce-motion');
// The GSAP motion layer (twin/motion.js: the stall-and-shove push, the rubber-band return, parallax on [data-depth]).
// Loaded lazily: if its vendor files aren't served (an older page server), the WAAPI slide below is used instead.
let motion = null;
let ink = null;
if (v2) {
  import('./motion.js').then(m => { m.initMotion({ reduced: root.classList.contains('reduce-motion') || undefined }); motion = m; inkPage($(`page-${current}`)); })
    .catch(e => console.info('[ody] motion layer off:', e?.message || e));
  import('./ink.js').then(m => { ink = m; inkPage($(`page-${current}`)); }).catch(e => console.info('[ody] ink layer off:', e?.message || e));
}
// first sight of a page: its hand-drawn borders ink themselves in, its title rises
function inkPage(el) {
  if (!el || !ink || !motion || el.dataset.inked) return;
  el.dataset.inked = '1';
  try { ink.inkify(el); if (!reduced()) motion.revealHeading(el.querySelector('h1')); } catch (e) { console.warn('[ody] ink', e); }
}
let pending = null;   // finishes an in-flight switch first, so fast key presses never show two pages
function setChrome(id) {
  for (const a of document.querySelectorAll('.pager a')) {
    if (a.dataset.go === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.body.dataset.page = id;
  document.title = id === 'main' ? 'Ody' : `${NAMES[id]} · Ody`;
}
function showOnly(next) {
  for (const p of document.querySelectorAll('#pages > .page')) {
    const on = p === next;
    p.classList.remove('enter', 'leaving');
    if (p.id === 'page-argo') { p.classList.toggle('off', !on); p.hidden = false; }
    else p.hidden = !on;
    p.inert = !on;
  }
}
/**
 * @param {'argo'|'main'|'forge'|'profile'|'settings'} id
 * @param {{focus?: boolean, push?: boolean}} [opts]
 */
export function goTo(id, { focus = false, push = true } = {}) {
  if (!v2 || !PAGES.includes(id)) return;
  if (pending) pending();
  const prev = current, next = $(`page-${id}`);
  if (prev === id) return;
  current = id;
  setChrome(id);
  if (push && location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  if (id === 'forge') mountForgePage();
  const rank = x => (ORDER.includes(x) ? ORDER.indexOf(x) : ORDER.length);
  const dir = prev ? Math.sign(rank(id) - rank(prev)) || 1 : 0;
  const out = prev && $(`page-${prev}`);
  showOnly(next);
  if (prev && !motion) { void next.offsetWidth; next.classList.add('enter'); }
  if (id !== 'forge') inkPage(next);
  if (focus) next.querySelector('h1')?.focus({ preventScroll: true });
  for (const fn of listeners) { try { fn(id); } catch (e) { console.warn('[ody] page listener', e); } }
  if (!out || !dir || reduced()) return;
  out.hidden = false; out.classList.remove('off'); out.classList.add('leaving'); out.inert = true;
  const settle = () => { out.classList.remove('leaving'); if (current !== prev) { if (out.id === 'page-argo') out.classList.add('off'); else out.hidden = true; } };
  if (motion) {
    let tl = null;
    const finishGsap = () => { if (pending !== finishGsap) return; pending = null; settle(); };
    pending = finishGsap;
    try { tl = motion.pageTransition(out, next, dir); } catch (e) { console.warn('[ody] pageTransition', e); }
    if (tl?.then) tl.then(finishGsap);
    // never stuck: on a slow frame rate GSAP stretches time (lag smoothing), so land the move after 1.3 s at the latest;
    // a move retargeted by a newer goTo() is left alone (motion.js continues it from where the panels are)
    setTimeout(() => { if (pending !== finishGsap) return; try { if (tl && tl.isActive?.()) tl.progress(1); } catch { /* gone */ } finishGsap(); }, tl ? 1300 : 0);
    return;
  }
  const ease = 'cubic-bezier(.22,1,.36,1)';
  const anims = [
    out.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${-dir * 6}%)`, opacity: 0 }], { duration: 250, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' }),
    next.animate([{ transform: `translateX(${dir * 8}%)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], { duration: 400, easing: ease }),
    ...[...next.querySelectorAll('.parallax')].map(el => el.animate([{ transform: `translateX(${dir * 10}vw)` }, { transform: 'translateX(0)' }], { duration: 400, easing: ease, composite: 'add' })),
    ...[...out.querySelectorAll('.parallax')].map(el => el.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-dir * 10}vw)` }], { duration: 250, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards', composite: 'add' })),
  ];
  const finish = () => {
    if (pending !== finish) return;
    pending = null;
    for (const a of anims) { try { a.cancel(); } catch { /* gone */ } }
    settle();
  };
  pending = finish;
  anims[0].finished.then(finish, finish);
  setTimeout(finish, 600);   // never stuck if the animation is skipped
}
const step = d => { if (!ORDER.includes(current)) return; const i = ORDER.indexOf(current) + d; if (i >= 0 && i < ORDER.length) goTo(ORDER[i], { focus: true }); };

// the call, visible from every page: a pill in the app bar while a call is live (mirrors Argo's own status line)
function callPill() {
  const pill = $('callpill'), st = $('status');
  if (!pill || !st) return;
  const sync = () => { const live = document.body.dataset.phase === 'live' && !document.body.hasAttribute('data-replay'); pill.hidden = !live || current === 'argo'; if (live) pill.textContent = st.textContent.trim() || 'Live'; };
  new MutationObserver(sync).observe(st, { childList: true, characterData: true, subtree: true });
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['data-phase', 'data-replay', 'data-page'] });
  sync();
}

// float and settle: the nav pill and the avatar lift (shadow on) at load and after each move, then sink back over ~2 s
function lift(...els) {
  for (const el of els) {
    if (!el) continue;
    el.classList.add('lift'); void el.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('lift')));
  }
}

// the pill rests: ~2.5 s with no pointer near it (top ~120 px or over it) and no keyboard focus in it, everything but the
// Ody logo fades out (opacity only: still focusable, still read). Pointer near, focus or a page move bring it back with its
// lift. Touch-only devices (no hover) keep it on.
const PILL_IDLE_MS = 2500, PILL_NEAR_PX = 120;
let pillTimer = 0;
const touchOnly = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
function pillWake(pill, { lifted = true } = {}) {
  if (!pill) return;
  clearTimeout(pillTimer);
  if (pill.classList.contains('idle')) {
    pill.classList.add('woke'); pill.classList.remove('idle');
    setTimeout(() => pill.classList.remove('woke'), 260);
    if (lifted) lift(pill);
  }
  pillTimer = setTimeout(() => pillRest(pill), PILL_IDLE_MS);
}
function pillRest(pill) {
  if (pill.matches(':hover') || pill.querySelector(':focus-visible') || touchOnly()) { pillTimer = setTimeout(() => pillRest(pill), PILL_IDLE_MS); return; }
  pill.classList.add('idle');
}
function pillIdle(pill) {
  if (!pill) return;
  addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    const r = pill.getBoundingClientRect();
    const near = e.clientY <= Math.max(PILL_NEAR_PX, r.bottom + 24) || (e.clientX >= r.left && e.clientX <= r.right && e.clientY <= r.bottom);
    if (near) pillWake(pill);
  }, { passive: true });
  pill.addEventListener('focusin', () => pillWake(pill));
  pill.addEventListener('focusout', () => pillWake(pill, { lifted: false }));
  onPage(() => pillWake(pill));
  pillTimer = setTimeout(() => pillRest(pill), PILL_IDLE_MS);
}

// the avatar shove: on Argo the status / Privacy / Tester row would sit under the big avatar, so the row moves left by
// --argo-shove (measured). Arriving on Argo, the avatar leans in and the row is shoved left with a squash and settle;
// leaving, the row slides back as the avatar eases off. motion.js tokens; reduced motion = just the end state.
function measureShove() {
  const head = document.querySelector('#page-argo > header'), av = $('profile-btn'), pa = $('page-argo'), pages = $('pages');
  if (!head || !av || !pa || !pages) return 0;
  head.style.setProperty('--argo-shove', '0px');
  // untransformed geometry: a page move translates #page-argo, a shove tween translates the avatar
  const P = pa.getBoundingClientRect(), S = pages.getBoundingClientRect(), h = head.getBoundingClientRect();
  const right = h.right - (P.left - S.left), top = h.top - (P.top - S.top);
  const bar = av.parentElement.getBoundingClientRect(), left = bar.left + av.offsetLeft, bottom = bar.top + av.offsetTop + av.offsetHeight;
  const px = bottom > top && av.offsetWidth ? Math.max(0, Math.round(right - left + 12)) : 0;
  head.style.setProperty('--argo-shove', `${px}px`);
  return px;
}
function shoveRow(arriving) {
  const px = measureShove();
  const row = [...document.querySelectorAll('#page-argo > header > .replay:not([hidden]), #page-argo > header > .status, #page-argo > header > .consent:not([hidden]), #page-argo > header > .btn-top')];
  const av = $('profile-btn');
  if (!motion || reduced() || !px || !row.length || !av) return;
  const { gsap, EASE } = motion;
  gsap.killTweensOf([...row, av]);
  const tl = gsap.timeline();
  if (arriving) {
    // the row lands where the avatar is (unshoved), the avatar leans in, makes contact, the row is shoved and settles
    tl.set(row, { x: px, transformOrigin: '100% 50%' }, 0)
      .to(av, { x: -14, scaleX: 0.96, duration: 0.16, ease: EASE.in }, 0.32)
      .to(row, { x: -6, scaleX: 0.92, duration: 0.3, ease: EASE.push, stagger: { each: 0.025, from: 'end' } }, 0.44)
      .to(av, { x: 0, scaleX: 1, duration: 0.42, ease: EASE.spring }, 0.46)
      .to(row, { x: 0, scaleX: 1, duration: 0.36, ease: EASE.spring, stagger: { each: 0.02, from: 'end' } }, 0.74);
  } else {
    // leaving Argo: the row (going away with the page) slides back right under where the avatar sits; the avatar eases off
    tl.to(av, { x: 10, duration: 0.18, ease: EASE.out }, 0)
      .to(row, { x: px, duration: 0.4, ease: EASE.in, stagger: { each: 0.02, from: 'start' } }, 0)
      .to(av, { x: 0, duration: 0.4, ease: EASE.spring }, 0.18)
      .set(row, { clearProps: 'transform' }, 0.95);
  }
  return tl;
}

function init() {
  root.classList.add('v2');
  for (const h of document.querySelectorAll('#pages > .page h1')) h.tabIndex = -1;
  for (const a of document.querySelectorAll('[data-go]')) a.addEventListener('click', e => { e.preventDefault(); goTo(a.dataset.go, { focus: true }); });
  addEventListener('hashchange', () => { const id = location.hash.slice(1); if (PAGES.includes(id)) goTo(id); });

  // keys: ← → switch pages (not while typing, nor inside the 3D view, a list, tabs or a dialog). Off Argo, the 3D view's
  // single-letter shortcuts (H, E, X, T…) are held back so they never act on a page you can't see.
  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target instanceof Element ? e.target : document.body;
    if (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.shiftKey || t.closest('[role="application"], [role="listbox"], [role="tablist"], [role="slider"], [role="dialog"], #argos-panel, #panel, #guide, .coach, .handhelp, .menu')) return;
      if (!$('keysheet').hidden) return;
      e.preventDefault(); e.stopImmediatePropagation();
      step(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (current !== 'argo' && e.key.length === 1) e.stopImmediatePropagation();
  }, true);

  // swipes: touch or pen drags across the page, and sideways trackpad swipes (not over the 3D view or a panel)
  const noSwipe = '#stage, #phone, #argos-panel, #panel, .keysheet, .menu, input, textarea, select, .rail, [data-noswipe]';
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
  goTo(PAGES.includes(first) ? first : 'main', { push: false });
  callPill();
  lift(document.querySelector('.appbar .pager'), $('profile-btn'));
  onPage(() => lift(document.querySelector('.appbar .pager')));
  pillIdle(document.querySelector('.appbar .pager'));
  let was = current;
  onPage(id => { if (id === 'argo' || was === 'argo') { try { shoveRow(id === 'argo'); } catch (e) { console.warn('[ody] shove', e); } } was = id; });
  addEventListener('resize', () => measureShove(), { passive: true });
  measureShove();
}

if (v2) init();

// the agent's view commands and circuit changes from the call ({type:'twin'|'circuit'|'circuit-step'}) must land in the
// hologram the caller can see: off Argo, go there (the normal transition) and bring the stage into view. Live events
// only: the shell replays its history to a new subscriber synchronously, before primed is set.
let primed = false;
subscribe(e => {
  if (!primed || !e || (e.type !== 'twin' && e.type !== 'circuit' && e.type !== 'circuit-step')) return;
  if (v2 && current !== 'argo') goTo('argo');
  try { $('stage')?.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } catch { /* no stage */ }
});
primed = true;

// for tests
window.odyPages = { page, goTo: id => goTo(id), openRefine, v2 };
