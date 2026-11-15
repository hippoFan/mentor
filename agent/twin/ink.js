// Ody ink: hand-drawn strokes on papyrus. Rough.js borders in SVG overlays, rough-notation live highlights,
// perfect-freehand brush ornaments. All MIT, served from this laptop (/vendor/rough*, /vendor/perfect-freehand).
import rough from '/vendor/rough/rough.esm.js';
import { annotate as rnAnnotate } from '/vendor/rough-notation/rough-notation.esm.js';
import { getStroke } from '/vendor/perfect-freehand/index.mjs';
import { drawIn, reduced, gsap, DUR, EASE } from './motion.js';

/** The palette (only these). */
export const INK = Object.freeze({
  paper: '#fdf5cc', navy: '#12233f', teal: '#1b5a63', sea: '#c1ddd0', orange: '#ea872f', red: '#983a34',
});
const color = c => INK[c] || c || INK.navy;
const SVGNS = 'http://www.w3.org/2000/svg';
const PAD = 10;   // overlay bleeds this far past the element so strokes can overshoot

/** Stable small seed from a string (FNV-1a), never 0 (0 = random in Rough.js). */
function seedOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2147483646 + 1;
}
let counter = 0;
function seedFor(el) {
  if (!el.dataset.inkSeed) el.dataset.inkSeed = String(seedOf(`${el.id}|${el.dataset.ink}|${(el.textContent || '').trim().slice(0, 40)}|${counter++}`));
  return Number(el.dataset.inkSeed);
}

const inked = new Map();   // element -> { svg, w, h }
let ro = null, timer = 0;
const dirty = new Set();
function observe(el) {
  if (!ro && typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(entries => {
      for (const e of entries) dirty.add(e.target);
      clearTimeout(timer);
      timer = setTimeout(() => { for (const el of dirty) draw(el, false); dirty.clear(); }, 120);
    });
  }
  ro?.observe(el);
}

/** One element's overlay: an absolutely-positioned SVG child, PAD px larger on every side. */
function overlay(el) {
  let rec = inked.get(el);
  if (rec?.svg.isConnected) return rec;
  const cs = getComputedStyle(el);
  if (cs.position === 'static') el.style.position = 'relative';
  if (cs.isolation !== 'isolate' && !('inkOver' in el.dataset)) el.style.isolation = 'isolate';   // ink sits under the text, over the bg
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('ink-overlay');
  Object.assign(svg.style, { position: 'absolute', left: `${-PAD}px`, top: `${-PAD}px`, overflow: 'visible',
    pointerEvents: 'none', zIndex: 'inkOver' in el.dataset ? '1' : '-1' });
  el.appendChild(svg);
  rec = { svg, w: -1, h: -1 };
  inked.set(el, rec);
  return rec;
}

/** Rough.js shapes for one data-ink type at size w×h (coordinates already offset by PAD). */
function shapes(rc, type, w, h, o, el) {
  const x0 = PAD, y0 = PAD, x1 = PAD + w, y1 = PAD + h;
  switch (type) {
    case 'box': {
      const out = [];
      const wash = el.dataset.inkWash;   // flat wash slightly off-register from the line (papyrus kit rule)
      if (wash) out.push(rc.rectangle(x0 + 4, y0 + 4, w - 2, h - 2, { ...o, stroke: 'none', fill: color(wash), fillStyle: 'solid', roughness: 0.6 }));
      out.push(rc.rectangle(x0, y0, w, h, o));
      return out;
    }
    case 'underline': {
      const y = y1 + 3;
      return [rc.curve([[x0 - 2, y + 1], [x0 + w * 0.35, y - 1.5], [x0 + w * 0.7, y + 1.2], [x1 + 4, y - 1]], { ...o, roughness: o.roughness * 0.8 })];
    }
    case 'circle':
      return [rc.ellipse(x0 + w / 2, y0 + h / 2, w * 1.14 + 12, h * 1.32 + 10, { ...o, roughness: o.roughness * 0.9 })];
    case 'divider': {
      const y = y0 + h / 2, mid = x0 + w / 2, gap = Math.min(18, w * 0.06);
      const wave = (a, b) => { const pts = []; const n = Math.max(3, Math.round((b - a) / 60)); for (let i = 0; i <= n; i++) pts.push([a + (b - a) * i / n, y + (i % 2 ? -2 : 2)]); return pts; };
      return [
        rc.curve(wave(x0 + 8, mid - gap), o),
        rc.curve(wave(mid + gap, x1 - 8), o),
        rc.polygon([[mid, y - 6], [mid + 6, y], [mid, y + 6], [mid - 6, y]], { ...o, fill: color(el.dataset.inkFill || 'orange'), fillStyle: 'solid' }),
      ];
    }
    case 'bracket': {
      const t = Math.min(14, w * 0.08);
      return [
        rc.linearPath([[x0 + t, y0 - 4], [x0 - 4, y0 - 4], [x0 - 4, y1 + 4], [x0 + t, y1 + 4]], o),
        rc.linearPath([[x1 - t, y0 - 4], [x1 + 4, y0 - 4], [x1 + 4, y1 + 4], [x1 - t, y1 + 4]], o),
      ];
    }
    default: return [];
  }
}

function draw(el, animate) {
  const type = el.dataset.ink;
  if (!type || !el.isConnected) return;
  const w = el.offsetWidth, h = el.offsetHeight;
  const rec = overlay(el);
  if (Math.abs(rec.w - w) < 1 && Math.abs(rec.h - h) < 1) return;
  rec.w = w; rec.h = h;
  const { svg } = rec;
  svg.setAttribute('width', w + PAD * 2);
  svg.setAttribute('height', h + PAD * 2);
  svg.replaceChildren();
  if (!w || !h) return;
  const rc = rough.svg(svg);
  const o = {
    stroke: color(el.dataset.inkColor), strokeWidth: Number(el.dataset.inkWidth) || 1.6,
    roughness: Number(el.dataset.inkRough) || 1.2, bowing: 1, seed: seedFor(el), preserveVertices: false,
    disableMultiStroke: type === 'divider',
  };
  for (const node of shapes(rc, type, w, h, o, el)) svg.appendChild(node);
  if (animate && !reduced()) drawIn(svg, { speed: 1.4, delay: Number(el.dataset.inkDelay) || 0 });
}

/**
 * Draw every [data-ink="box|underline|circle|divider|bracket"] under root (idempotent: call again after rendering new
 * content; already-inked elements only redraw when their size changes). Optional attributes on the element:
 * data-ink-color (navy|teal|orange|red|sea|#hex), data-ink-wash (box fill, e.g. "sea"), data-ink-width, data-ink-rough,
 * data-ink-delay (s), data-ink-static (no draw-in), data-ink-over (draw over the content instead of under it).
 * Elements get position:relative (if static) and isolation:isolate so the ink sits between their background and their text.
 * @param {ParentNode} [root=document]  @param {{animate?: boolean}} [opts]  animate = pen draws the line in (first time only)
 */
export function inkify(root = document, { animate = true } = {}) {
  const list = [...(root.querySelectorAll?.('[data-ink]') || [])];
  if (root instanceof Element && root.matches('[data-ink]')) list.unshift(root);
  for (const el of list) {
    const first = !inked.has(el);
    draw(el, animate && first && !('inkStatic' in el.dataset));
    if (first) observe(el);
  }
  return list.length;
}

/** Remove an element's ink (e.g. before discarding it). */
export function uninkify(el) {
  const rec = inked.get(el);
  if (!rec) return;
  ro?.unobserve(el); rec.svg.remove(); inked.delete(el);
}

const NOTE = { highlight: INK.sea, underline: INK.orange, box: INK.navy, circle: INK.orange, bracket: INK.teal,
  'strike-through': INK.red, 'crossed-off': INK.red };
/**
 * Live hand-drawn annotation (rough-notation): 'highlight'|'underline'|'box'|'circle'|'bracket'|'strike-through'|'crossed-off'.
 * Shows it immediately (400 ms draw; instant when reduced). Returns the annotation ({show, hide, remove}).
 */
export function annotate(el, type = 'highlight', opts = {}) {
  const a = rnAnnotate(el, {
    type, color: color(opts.color) === INK.navy && !opts.color ? NOTE[type] || INK.navy : color(opts.color),
    strokeWidth: type === 'highlight' ? 1 : 1.8, padding: type === 'highlight' ? 2 : 4, iterations: type === 'highlight' ? 1 : 2,
    animate: !reduced(), animationDuration: DUR.slow * 1000 * (type === 'highlight' ? 1.6 : 1.2),
    multiline: true, brackets: ['left', 'right'], ...opts,
  });
  if (opts.show !== false) a.show();
  return a;
}

/** perfect-freehand outline -> SVG path data (quadratic smoothing between outline midpoints). */
function outlineD(pts) {
  if (!pts.length) return '';
  const d = pts.reduce((acc, [x0, y0], i, arr) => {
    const [x1, y1] = arr[(i + 1) % arr.length];
    acc.push(x0.toFixed(2), y0.toFixed(2), ((x0 + x1) / 2).toFixed(2), ((y0 + y1) / 2).toFixed(2));
    return acc;
  }, ['M', ...pts[0].map(v => v.toFixed(2)), 'Q']);
  return d.join(' ') + ' Z';
}
let maskId = 0;
/**
 * A brush stroke (reed pen on papyrus) through `points` ([[x,y] or [x,y,pressure]]). Returns an SVG <g> with the filled
 * stroke; append it to an <svg>. With animate:true (and an svg to live in), it paints itself along its centre line.
 * @param {number[][]} points  @param {{size?:number, color?:string, thinning?:number, svg?:SVGSVGElement, animate?:boolean, duration?:number, delay?:number}} [opts]
 */
export function inkStroke(points, { size = 7, color: c = 'navy', thinning = 0.65, svg, animate = false, duration = 0.9, delay = 0 } = {}) {
  const outline = getStroke(points, { size, thinning, smoothing: 0.55, streamline: 0.45, simulatePressure: points[0]?.length < 3,
    start: { taper: size * 4, cap: true }, end: { taper: size * 5, cap: true } });
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', outlineD(outline));
  path.setAttribute('fill', color(c));
  g.appendChild(path);
  if (svg) svg.appendChild(g);
  if (animate && svg && !reduced() && points.length > 1) {
    const id = `ink-mask-${++maskId}`;
    const mask = document.createElementNS(SVGNS, 'mask');
    mask.id = id;
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    const spine = document.createElementNS(SVGNS, 'path');
    spine.setAttribute('d', `M${points.map(p => `${p[0]},${p[1]}`).join(' L')}`);
    Object.entries({ fill: 'none', stroke: '#fff', 'stroke-width': size * 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
      .forEach(([k, v]) => spine.setAttribute(k, v));
    mask.appendChild(spine);
    g.insertBefore(mask, path);
    path.setAttribute('mask', `url(#${id})`);
    gsap.fromTo(spine, { drawSVG: '0% 0%' }, { drawSVG: '0% 100%', duration, delay, ease: 'power1.inOut',
      onComplete: () => { path.removeAttribute('mask'); mask.remove(); } });
  }
  return g;
}

/** A ready-made ornament: a flourish of `n` waves across width w at height y (points for inkStroke). */
export function flourish(w, y = 20, { amp = 9, n = 3, x = 0 } = {}) {
  const pts = [];
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    pts.push([x + t * w, y + Math.sin(t * Math.PI * 2 * n) * amp * Math.sin(t * Math.PI), 0.25 + 0.75 * Math.sin(t * Math.PI)]);
  }
  return pts;
}

export { EASE };
