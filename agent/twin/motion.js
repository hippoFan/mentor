// Ody motion: one token set, one ease-out and one spring, transform/opacity only (DrawSVG's stroke reveal excepted).
// GSAP 3.15.1 (standard no-charge licence) served from this laptop: /vendor/gsap/*. prefers-reduced-motion => instant.
import { gsap } from '/vendor/gsap/index.js';
import { SplitText } from '/vendor/gsap/SplitText.js';
import { DrawSVGPlugin } from '/vendor/gsap/DrawSVGPlugin.js';
import { MorphSVGPlugin } from '/vendor/gsap/MorphSVGPlugin.js';
import { Flip } from '/vendor/gsap/Flip.js';
import { CustomEase } from '/vendor/gsap/CustomEase.js';

gsap.registerPlugin(SplitText, DrawSVGPlugin, MorphSVGPlugin, Flip, CustomEase);

/** Durations in seconds (CSS gets the same as --m-fast/--m-base/--m-slow in ms). */
export const DUR = Object.freeze({ fast: 0.15, base: 0.25, slow: 0.4 });
/** The one ease-out (same curve as the CSS cubic-bezier(.22,1,.36,1)) and the one spring. */
export const EASE = Object.freeze({ out: 'ody-out', in: 'ody-in', spring: 'ody-spring', push: 'ody-push', snap: 'ody-snap', css: 'cubic-bezier(.22,1,.36,1)' });
CustomEase.create('ody-out', '.22,1,.36,1');
CustomEase.create('ody-in', '.55,0,1,.45');
// a soft spring: ~8% overshoot, one settle (hand-tuned path, no wobble)
// the shove: gets going decisively after the stall, lands soft
CustomEase.create('ody-push', '.42,0,.18,1');
// rubber band snapping back: fast release, ~5% overshoot, one small damped wobble
CustomEase.create('ody-snap', 'M0,0 C0.1,0.7 0.2,1.06 0.34,1.055 0.46,1.05 0.54,0.982 0.66,0.986 0.76,0.99 0.84,1.004 1,1');
CustomEase.create('ody-spring', 'M0,0 C0.12,0.62 0.24,1.1 0.42,1.08 0.58,1.06 0.7,0.99 1,1');

let R = false;   // reduced motion
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const reduced = () => R;

/**
 * Call once at boot. `reduced` overrides the media query (e.g. an in-app setting); omit to follow the OS.
 * Writes the motion tokens to :root as CSS custom properties so CSS transitions share them.
 */
export function initMotion({ reduced: force } = {}) {
  const apply = () => {
    R = force ?? !!mq?.matches;
    gsap.globalTimeline.timeScale(1);
    document.documentElement.toggleAttribute('data-reduced-motion', R);
  };
  apply();
  if (force === undefined) mq?.addEventListener?.('change', apply);
  const s = document.documentElement.style;
  s.setProperty('--m-fast', `${DUR.fast * 1000}ms`);
  s.setProperty('--m-base', `${DUR.base * 1000}ms`);
  s.setProperty('--m-slow', `${DUR.slow * 1000}ms`);
  s.setProperty('--m-ease', EASE.css);
  s.setProperty('--m-spring', 'cubic-bezier(.34,1.4,.64,1)');
  gsap.defaults({ ease: EASE.out, duration: DUR.base });
  return { gsap, reduced };
}

const els = x => (typeof x === 'string' ? [...document.querySelectorAll(x)] : x instanceof Element ? [x] : [...(x || [])]);
const done = () => gsap.timeline().set({}, {}, 0);   // a zero-length timeline: completes on the next tick (thenable)

/**
 * Page move, physical: one panel shoves the other.
 *  push (to Argo / to The Forge): a ~140 ms stall (the current page leans toward its exit side and compresses a hair while
 *  the incoming edge peeks in), then both panels travel together (~660 ms). Total ~800 ms.
 *  snap (back to Home): a rubber band let go: fast release, ~5% overshoot, one small damped wobble, rest. ~820 ms.
 * dir = side the NEW page comes in from: 1 = from the right (Home → Forge, Argo → Home), -1 = from the left (Home → Argo,
 * Forge → Home). That is pages.js's Math.sign(rank(id) - rank(prev)) with ORDER = argo, main, forge.
 * Both pages must be laid over each other (same box, the stage clips: overflow hidden). Inside either page:
 *  [data-depth="0.2..2"] (and legacy .parallax = 1) decorative layers travel extra → parallax at different rates;
 *  [data-rip] (Argo's torn papyrus edge) leads the push, the page body catches up;
 *  [data-flip-id] elements present in both pages glide from the old spot to the new (Flip).
 * Interruptible: calling again mid-move kills the old move and starts the new one from where the panels are now.
 * Reduced motion: a 150 ms crossfade. Returns a GSAP timeline (thenable; a killed one never resolves, keep a fallback timer).
 * @param {HTMLElement|null} fromEl  @param {HTMLElement} toEl  @param {1|-1} dir
 * @param {{snap?: boolean}} [opts] snap: rubber-band return; default = toEl is #page-main or has [data-home]
 */
let active = null;
const moving = new Set();
export function pageTransition(fromEl, toEl, dir = 1, { snap } = {}) {
  if (!toEl) return done();
  dir = dir < 0 ? -1 : 1;
  snap ??= toEl.id === 'page-main' || toEl.hasAttribute('data-home');
  const layers = root => (root ? [...root.querySelectorAll('[data-depth], .parallax')] : []);
  const rips = root => (root ? [...root.querySelectorAll('[data-rip]')] : []);
  const depth = el => (el.dataset.depth ? parseFloat(el.dataset.depth) || 1 : 1);
  const mid = el => moving.has(el);
  // retarget: stop the old move where it is; pages that drop out of the move lose their transforms
  if (active) { active.kill(); active = null; }
  for (const el of moving) if (el !== fromEl && el !== toEl && !fromEl?.contains(el) && !toEl.contains(el)) gsap.set(el, { clearProps: el.matches('[data-depth], .parallax, [data-rip]') ? 'transform,willChange' : 'transform,opacity,visibility,willChange' });
  const fromMid = !!fromEl && mid(fromEl), toMid = mid(toEl);
  const startTo = toMid ? gsap.getProperty(toEl, 'xPercent') : dir * 100;
  const all = [fromEl, toEl, ...layers(fromEl), ...layers(toEl), ...rips(toEl)].filter(Boolean);
  moving.clear(); all.forEach(el => moving.add(el));
  const shared = fromEl ? [...toEl.querySelectorAll('[data-flip-id]')].filter(t => fromEl.querySelector(`[data-flip-id="${CSS.escape(t.dataset.flipId)}"]`)) : [];
  const state = shared.length ? Flip.getState(shared.map(t => fromEl.querySelector(`[data-flip-id="${CSS.escape(t.dataset.flipId)}"]`))) : null;
  const pages = [fromEl, toEl].filter(Boolean), deco = all.filter(el => !pages.includes(el));
  const clear = () => {
    gsap.set(pages, { clearProps: 'transform,opacity,visibility,willChange' });
    gsap.set(deco, { clearProps: 'transform,willChange' });
    moving.clear(); if (active === tl) active = null;
  };
  const tl = gsap.timeline({ onComplete: clear });
  active = tl;
  if (R || !fromEl) {
    if (fromEl) tl.to(fromEl, { opacity: 0, duration: DUR.fast, ease: 'none' }, 0);
    tl.fromTo(toEl, { opacity: 0, xPercent: 0, x: 0 }, { opacity: 1, duration: DUR.fast, ease: 'none' }, 0);
    return tl;
  }
  gsap.set(all, { willChange: 'transform' });
  gsap.set(toEl, { autoAlpha: 1, opacity: 1 }); gsap.set(fromEl, { autoAlpha: 1, opacity: 1 });
  const W = () => innerWidth;
  let t0 = 0;
  if (snap) {
    // rubber band: no stall, the panels fly home together and settle
    const d = DUR.slow * 2.05, ease = EASE.snap;
    tl.fromTo(toEl, { xPercent: startTo }, { xPercent: 0, x: 0, scaleX: 1, duration: d, ease }, 0);
    tl.to(fromEl, { xPercent: -dir * 100, x: 0, scaleX: 1, duration: d, ease }, 0);
    for (const el of layers(toEl)) tl.fromTo(el, { x: () => dir * W() * 0.14 * depth(el) }, { x: 0, duration: d, ease }, 0);
    for (const el of layers(fromEl)) tl.to(el, { x: () => -dir * W() * 0.14 * depth(el), duration: d * 0.8, ease: EASE.out }, 0);
    if (state) tl.add(Flip.from(state, { targets: shared, duration: d, ease, absolute: true }), 0);
    return tl;
  }
  if (!fromMid && !toMid) {
    // the stall: current page leans toward its exit side and compresses; the incoming edge presses in
    t0 = 0.14;
    tl.to(fromEl, { x: -dir * 9, scaleX: 0.988, transformOrigin: dir > 0 ? '0% 50%' : '100% 50%', duration: t0, ease: 'power2.out' }, 0);
    tl.fromTo(toEl, { xPercent: startTo, x: 0 }, { x: -dir * 16, duration: t0, ease: 'power2.out' }, 0);
  } else {
    gsap.set(toEl, { xPercent: startTo });
  }
  const d = 0.64, ease = EASE.push;
  tl.to(fromEl, { xPercent: -dir * 100, x: 0, scaleX: 1, duration: d, ease }, t0);
  tl.to(toEl, { xPercent: 0, x: 0, duration: d, ease }, t0);
  for (const el of rips(toEl)) tl.fromTo(el, { x: -dir * 34 }, { x: 0, duration: d + 0.08, ease: 'power2.out' }, t0);
  for (const el of layers(toEl)) tl.fromTo(el, { x: () => dir * W() * 0.18 * depth(el) }, { x: 0, duration: d + 0.1 * depth(el), ease: EASE.out }, t0);
  for (const el of layers(fromEl)) tl.to(el, { x: () => -dir * W() * 0.18 * depth(el), duration: d, ease }, t0);
  if (state) tl.add(Flip.from(state, { targets: shared, duration: d, ease, absolute: true }), t0);
  return tl;
}

/**
 * Letters rise out of their words (SplitText). The heading keeps its text for screen readers (aria-label);
 * the split is reverted when done so line breaks stay native. Returns the timeline.
 */
export function revealHeading(el, { delay = 0, by = 'chars' } = {}) {
  el = els(el)[0];
  if (!el) return done();
  if (R) { gsap.set(el, { autoAlpha: 1 }); return done(); }
  const split = SplitText.create(el, { type: 'words,chars', mask: 'words', aria: 'auto' });
  gsap.set(el, { autoAlpha: 1 });
  const tl = gsap.timeline({ delay, onComplete: () => split.revert() });
  tl.from(by === 'words' ? split.words : split.chars, {
    yPercent: 115, rotate: 6, opacity: 0, duration: DUR.slow * 1.4, ease: EASE.out,
    stagger: { each: by === 'words' ? 0.07 : 0.028 },
  });
  return tl;
}

/**
 * Ink lines draw themselves (DrawSVG). Works on an <svg> or a group: every stroked path/line/circle/... inside.
 * Fills fade in right behind the pen. Duration scales with the line's length (0.5–1.6 s), lines overlap.
 */
export function drawIn(svgEl, { delay = 0, speed = 1, fills = true } = {}) {
  const root = els(svgEl)[0];
  if (!root) return done();
  const shapes = [...root.querySelectorAll('path,line,polyline,polygon,circle,ellipse,rect')];
  if (root.matches?.('path,line,polyline,polygon,circle,ellipse,rect')) shapes.push(root);
  const stroked = shapes.filter(s => { const c = getComputedStyle(s); return c.stroke && c.stroke !== 'none' && parseFloat(c.strokeWidth) > 0; });
  const filled = fills ? shapes.filter(s => !stroked.includes(s) && getComputedStyle(s).fill !== 'none') : [];
  gsap.set(root, { autoAlpha: 1 });
  if (R) { gsap.set(stroked, { drawSVG: '0% 100%' }); gsap.set(filled, { opacity: 1 }); return done(); }
  const tl = gsap.timeline({ delay });
  stroked.forEach((s, i) => {
    let len = 300; try { len = DrawSVGPlugin.getLength(s) || 300; } catch { /* hidden */ }
    const d = gsap.utils.clamp(0.5, 1.6, len / 700) / speed;
    tl.fromTo(s, { drawSVG: '0% 0%' }, { drawSVG: '0% 100%', duration: d, ease: 'power2.inOut' }, i * 0.06 / speed);
  });
  if (filled.length) tl.from(filled, { opacity: 0, duration: DUR.slow, stagger: 0.03, ease: EASE.out }, 0.15 / speed);
  return tl;
}

/**
 * Cards are laid down like sheets on a desk: rise, settle with the spring, a hair of rotation that straightens.
 * `container` = parent (its element children animate) or a list/selector of items.
 */
export function stagger(container, { each = 0.06, delay = 0, selector } = {}) {
  const root = els(container);
  const items = selector ? root.flatMap(r => [...r.querySelectorAll(selector)])
    : (root.length === 1 && root[0].children.length ? [...root[0].children] : root);
  if (!items.length) return done();
  if (R) { gsap.set(items, { clearProps: 'transform', autoAlpha: 1 }); return done(); }
  return gsap.fromTo(items,
    { y: 28, rotate: () => gsap.utils.random(-2.2, 2.2), autoAlpha: 0, scale: 0.97 },
    { y: 0, rotate: 0, autoAlpha: 1, scale: 1, duration: DUR.slow * 1.5, ease: EASE.spring, stagger: each, delay,
      clearProps: 'transform' });
}

/**
 * Live status: an ink ring breathes out of the element. Returns { stop() }. The only ambient loop: pause it when hidden.
 */
export function pulse(el, { color = 'currentColor', period = 1.6 } = {}) {
  el = els(el)[0];
  if (!el) return { stop() {} };
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  const ring = document.createElement('span');
  ring.setAttribute('aria-hidden', 'true');
  ring.className = 'm-pulse-ring';
  Object.assign(ring.style, { position: 'absolute', inset: '0', borderRadius: '50%', border: `2px solid ${color}`,
    pointerEvents: 'none', opacity: '0' });
  el.appendChild(ring);
  if (R) return { stop() { ring.remove(); } };
  const tl = gsap.timeline({ repeat: -1 });
  tl.fromTo(ring, { scale: 1, opacity: 0.7 }, { scale: 2.6, opacity: 0, duration: period, ease: 'power2.out' }, 0);
  tl.fromTo(el, { scale: 1 }, { scale: 1.12, duration: period * 0.25, yoyo: true, repeat: 1, ease: 'sine.inOut' }, 0);
  const vis = () => (document.hidden ? tl.pause() : tl.resume());
  document.addEventListener('visibilitychange', vis);
  return { stop() { document.removeEventListener('visibilitychange', vis); tl.kill(); gsap.set(el, { clearProps: 'transform' }); ring.remove(); } };
}

/**
 * The combine, DOM side: part chips fly into `into` (the 3D stage or a slot), it takes the hit with a spring, then
 * `result` rises. Optional SVG morph: { morph: { path: <path>, to: 'M… d' | '#id' } } (e.g. the parts glyph turns into a board).
 * Hooks: onHit (start the 3D combine there), onDone. Returns the timeline. Parts are left hidden (caller removes them).
 * @param {Element[]|NodeList|string} parts
 */
export function combineMorph(parts, { into, result, morph, onHit, onDone } = {}) {
  const list = els(parts), target = els(into)[0];
  const tl = gsap.timeline({ onComplete: () => onDone?.() });
  if (R || !target) {
    gsap.set(list, { autoAlpha: 0 }); if (result) gsap.set(result, { autoAlpha: 1 });
    if (morph?.path) gsap.set(morph.path, { morphSVG: morph.to });
    onHit?.(); tl.call(() => {}); return tl;
  }
  const t = target.getBoundingClientRect(), cx = t.left + t.width / 2, cy = t.top + t.height / 2;
  list.forEach((p, i) => {
    const r = p.getBoundingClientRect();
    const dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    tl.to(p, { keyframes: [
      { y: -18, rotate: gsap.utils.random(-8, 8), scale: 1.06, duration: DUR.base, ease: EASE.out },
      { x: dx, y: dy, rotate: 0, scale: 0.35, opacity: 0, duration: DUR.slow * 1.2, ease: 'power3.in' },
    ] }, i * 0.08);
  });
  const hit = tl.duration();
  tl.call(() => onHit?.(), null, hit);
  tl.fromTo(target, { scale: 0.94 }, { scale: 1, duration: DUR.slow * 1.6, ease: EASE.spring, clearProps: 'transform' }, hit);
  if (morph?.path) tl.to(morph.path, { morphSVG: { shape: morph.to, type: 'rotational' }, duration: DUR.slow * 1.6, ease: EASE.out }, hit - 0.1);
  if (result) tl.fromTo(result, { autoAlpha: 0, y: 16, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: DUR.slow, ease: EASE.spring }, hit + 0.15);
  return tl;
}

/**
 * Toast: slides up with the spring, holds, sinks away. `el` stays in the DOM (hidden after). Pass hold: 0 to keep it.
 * Returns a Promise that resolves when it has gone (or right after showing when hold is 0).
 */
export function toast(el, { hold = 2.6 } = {}) {
  el = els(el)[0];
  if (!el) return Promise.resolve();
  gsap.killTweensOf(el);
  el.hidden = false;
  if (R) {
    gsap.set(el, { autoAlpha: 1, clearProps: 'transform' });
    return hold ? new Promise(res => setTimeout(() => { el.hidden = true; res(); }, hold * 1000)) : Promise.resolve();
  }
  const tl = gsap.timeline();
  tl.fromTo(el, { y: 28, autoAlpha: 0, scale: 0.96 }, { y: 0, autoAlpha: 1, scale: 1, duration: DUR.slow, ease: EASE.spring });
  if (hold) tl.to(el, { y: 16, autoAlpha: 0, duration: DUR.base, ease: EASE.in, onComplete: () => { el.hidden = true; } }, `+=${hold}`);
  return new Promise(res => tl.eventCallback('onComplete', res));
}

/** Small pop for confirmations (a button that just did its job). */
export function pop(el) {
  if (R) return done();
  return gsap.fromTo(els(el), { scale: 0.92 }, { scale: 1, duration: DUR.slow, ease: EASE.spring, clearProps: 'transform' });
}

export { gsap, Flip, SplitText, DrawSVGPlugin, MorphSVGPlugin };
