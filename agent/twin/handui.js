// What hand control looks like: the first-run coach (3 steps, drawn hand glyphs), the gesture legend, the status chip,
// the cursor ring, the live hand skeleton over the stage and the camera thumbnail. No three.js; app.js drives it.
// The glyphs are drawn from the same synthetic landmarks the tests use (gestures.js synthHand), as the same skeleton
// the user sees over the stage, so the coach looks like what happens next.
import { synthHand } from './gestures.js';

const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: forget it */ } },
};
const KEY_COACHED = 'ody.hands.coached', KEY_PREVIEW = 'ody.hands.preview';

/** Comfort zone: the middle 76 % of the camera picture covers the whole stage, so nobody has to reach the edges. */
export const toStage = (p, w, h, m = 0.12) => ({ x: Math.max(0, Math.min(1, (p.x - m) / (1 - 2 * m))) * w, y: Math.max(0, Math.min(1, (p.y - m) / (1 - 2 * m))) * h });

// ---------- glyphs ----------
const f1 = n => n.toFixed(1);
const bonesD = lm => BONES.map(([a, b]) => `M${f1(lm[a].x)} ${f1(lm[a].y)}L${f1(lm[b].x)} ${f1(lm[b].y)}`).join('');
const hand = (pose, cx, cy, s, o) => synthHand(pose, cx, cy, s, o);
/** One animated skeleton hand: poses morph through keyframes (SMIL on `d`, same command structure every frame). */
function handG({ poses, keyTimes, cx, cy, s, mirror = false, dur, reduced, still = 0, tipColor = true }) {
  const frames = poses.map(p => hand(p, cx, cy, s, { mirror }));
  const show = frames[Math.min(still, frames.length - 1)];
  const anim = (attr, vals) => (reduced ? '' : `<animate attributeName="${attr}" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keyTimes="${keyTimes.join(';')}" keySplines="${keyTimes.slice(1).map(() => '.45 0 .25 1').join(';')}" values="${vals.join(';')}"/>`);
  const tip = i => `<circle class="gj${tipColor ? ' gold' : ''}" r="${f1(s * 0.09 + 1)}" cx="${f1(show[i].x)}" cy="${f1(show[i].y)}">${anim('cx', frames.map(f => f1(f[i].x)))}${anim('cy', frames.map(f => f1(f[i].y)))}</circle>`;
  return `<path class="gb" d="${bonesD(show)}">${anim('d', frames.map(bonesD))}</path>${tip(4)}${tip(8)}`;
}
const move = (vals, keyTimes, dur, reduced) => (reduced ? '' : `<animateTransform attributeName="transform" type="translate" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keyTimes="${keyTimes.join(';')}" keySplines="${keyTimes.slice(1).map(() => '.45 0 .25 1').join(';')}" values="${vals.join(';')}"/>`);
const GLYPHS = {
  hover: r => {
    const kt = [0, 0.15, 0.45, 0.7, 1], dur = 3.2;
    return `<svg viewBox="0 0 160 100" class="glyph">
      <rect class="gpart" x="78" y="15" width="26" height="22" rx="4"${r ? ' opacity=".9"' : ''}>${r ? '' : `<animate attributeName="opacity" dur="${dur}s" repeatCount="indefinite" keyTimes="0;0.4;0.46;0.7;0.78;1" values=".3;.3;1;1;.3;.3"/>`}</rect>
      <g${r ? ' transform="translate(42 0)"' : ''}>${move(['0 0', '0 0', '42 0', '42 0', '0 0'], kt, dur, r)}
        ${handG({ poses: ['palm'], keyTimes: [0, 1], cx: 58, cy: 62, s: 30, dur, reduced: true })}
        <circle class="gring" cx="${f1(58 - 9)}" cy="${f1(62 - 34.2)}" r="8"/></g></svg>`;
  },
  pinch: r => {
    const dur = 3;
    return `<svg viewBox="0 0 160 100" class="glyph">
      <path class="garc" d="M118 30a26 26 0 0 1 0 40" />
      <g${r ? ' transform="translate(22 0)"' : ''}>${move(['0 0', '0 0', '22 0', '22 0', '0 0'], [0, 0.3, 0.6, 0.8, 1], dur, r)}
        ${handG({ poses: ['palm', 'pinch', 'pinch', 'palm'], keyTimes: [0, 0.25, 0.8, 1], cx: 66, cy: 62, s: 30, dur, reduced: r, still: 1 })}
        <circle class="gfill" cx="${f1(66 - 0.575 * 30)}" cy="${f1(62 - 0.735 * 30)}" r="7"${r ? ' opacity="1"' : ' opacity="0"'}>${r ? '' : `<animate attributeName="opacity" dur="${dur}s" repeatCount="indefinite" keyTimes="0;0.18;0.27;0.78;0.86;1" values="0;0;1;1;0;0"/>`}</circle></g></svg>`;
  },
  zoom: r => {
    const dur = 3, kt = [0, 0.45, 1];
    return `<svg viewBox="0 0 160 100" class="glyph">
      <g transform="translate(80 40)"><rect class="gpart lit" x="-9" y="-7" width="18" height="14" rx="3">${r ? '' : `<animateTransform attributeName="transform" type="scale" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.45;1" keySplines=".45 0 .25 1;.45 0 .25 1" values="1;1.7;1"/>`}</rect></g>
      <g${r ? ' transform="translate(-12 0)"' : ''}>${move(['0 0', '-12 0', '0 0'], kt, dur, r)}${handG({ poses: ['palm'], keyTimes: [0, 1], cx: 50, cy: 64, s: 24, mirror: true, dur, reduced: true })}</g>
      <g${r ? ' transform="translate(12 0)"' : ''}>${move(['0 0', '12 0', '0 0'], kt, dur, r)}${handG({ poses: ['palm'], keyTimes: [0, 1], cx: 110, cy: 64, s: 24, dur, reduced: true })}</g></svg>`;
  },
  fist: r => {
    const dur = 2.6, C = 2 * Math.PI * 13;
    return `<svg viewBox="0 0 100 100" class="glyph small">
      ${handG({ poses: ['palm', 'fist', 'fist', 'palm'], keyTimes: [0, 0.2, 0.85, 1], cx: 46, cy: 60, s: 28, dur, reduced: r, still: 1, tipColor: false })}
      <circle class="gtrack" cx="78" cy="22" r="13"/><circle class="gprog" cx="78" cy="22" r="13" stroke-dasharray="${f1(C)}" stroke-dashoffset="${r ? f1(C * 0.25) : f1(C)}" transform="rotate(-90 78 22)">${r ? '' : `<animate attributeName="stroke-dashoffset" dur="${dur}s" repeatCount="indefinite" keyTimes="0;0.25;0.8;0.86;1" values="${f1(C)};${f1(C)};0;0;${f1(C)}"/>`}</circle></svg>`;
  },
};
/** Small static glyph for the legend (the same skeleton, 24 px). */
function legendGlyph(kind) {
  if (kind === 'zoom') return `<svg viewBox="0 0 40 24" aria-hidden="true"><path class="gb" d="${bonesD(hand('palm', 11, 15, 7.5, { mirror: true }))}"/><path class="gb" d="${bonesD(hand('palm', 29, 15, 7.5))}"/></svg>`;
  const pose = { hover: 'palm', rotate: 'pinch', fist: 'fist', thumbs: 'thumbs' }[kind];
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="gb" d="${bonesD(hand(pose, 13, 14, 8))}"/></svg>`;
}

const STEPS = [
  { art: ['hover'], title: 'Open hand to point', body: 'Hold one hand up, palm to the screen. The ring follows your index finger and lights up the part under it. Hold a pointing finger still to read a pin.' },
  { art: ['pinch'], title: 'Pinch to grab', body: 'Pinch thumb and index finger, then move to turn the model. After Explode, pinch a part to pick it up and bring your hand closer or further to move it in depth. Open your hand to drop it.' },
  { art: ['zoom', 'fist'], title: 'Two hands to zoom, a fist to reset', body: 'Move both hands apart to zoom in and together to zoom out. Twist them like a steering wheel to tilt the view. Hold a fist for a moment to reset it.',
    extra: 'Flick a part sideways to remove it (Undo brings it back). Thumbs up combines the parts.' },
];
const STATUS = {
  none: 'Show your hand to the camera', ok: 'Hand found', close: 'Too close: move back a little', dark: 'Low light: face a lamp or a window',
};

/**
 * createHandUI({ reduced, onCoachClose }) -> { start(video), stop(), frame(g, info, opts), cursor(...), status(kind),
 * openCoach(), closeCoach(), coachOpen(), maybeCoach(), showHelp({title, body, retry}), hideHelp() }
 */
export function createHandUI({ reduced = false, returnFocus = null, onRetry = null } = {}) {
  const stage = $('stage'), layer = $('handlayer'), lg = layer.getContext('2d'), preview = $('handcanvas'), pg = preview.getContext('2d');
  const view = $('handview'), cur = $('cursor'), curLabel = cur.querySelector('.cur-label'), chip = $('hstatus'), chipText = $('hstatusText');
  const coach = $('coach'), help = $('handhelp');
  let video = null, on = false, step = 0, kindNow = '', modeNow = '', showVideo = store.get(KEY_PREVIEW) !== '0', drawn = false;

  // legend glyphs (static, decorative)
  for (const li of $('handlegend').querySelectorAll('li[data-g]')) li.querySelector('.lg').innerHTML = legendGlyph(li.dataset.g);
  const prevBtn = $('h-preview');
  const syncPreview = () => { prevBtn.setAttribute('aria-pressed', String(showVideo)); preview.hidden = !showVideo; };
  prevBtn.addEventListener('click', () => { showVideo = !showVideo; store.set(KEY_PREVIEW, showVideo ? '1' : '0'); syncPreview(); });
  $('h-help').addEventListener('click', () => openCoach());
  syncPreview();

  // ---------- coach ----------
  coach.innerHTML = `<div class="coach-card">
      <div class="coach-art" aria-hidden="true"></div>
      <div class="coach-text"><p class="coach-count" id="coachCount"></p><h3 id="coachTitle"></h3><p id="coachBody"></p><p class="coach-extra" id="coachExtra"></p></div>
      <div class="coach-nav">
        <button type="button" class="coach-skip" id="coachSkip">Skip</button>
        <span class="coach-dots" aria-hidden="true">${STEPS.map(() => '<i></i>').join('')}</span>
        <button type="button" class="btn" id="coachBack">Back</button>
        <button type="button" class="btn primary" id="coachNext">Next</button>
      </div>
      <p class="coach-privacy">Hand tracking runs on this laptop. The camera picture never leaves it.</p></div>`;
  coach.setAttribute('role', 'dialog'); coach.setAttribute('aria-modal', 'false');
  coach.setAttribute('aria-labelledby', 'coachTitle'); coach.setAttribute('aria-describedby', 'coachBody');
  const showStep = i => {
    step = Math.max(0, Math.min(STEPS.length - 1, i)); const s = STEPS[step];
    coach.querySelector('.coach-art').innerHTML = s.art.map(a => GLYPHS[a](reduced)).join('');
    $('coachCount').textContent = `Step ${step + 1} of ${STEPS.length}`;
    $('coachTitle').textContent = s.title; $('coachBody').textContent = s.body;
    $('coachExtra').textContent = s.extra || ''; $('coachExtra').hidden = !s.extra;
    $('coachBack').hidden = step === 0;
    $('coachNext').textContent = step === STEPS.length - 1 ? 'Start' : 'Next';
    coach.querySelectorAll('.coach-dots i').forEach((d, k) => d.classList.toggle('on', k === step));
    coach.dataset.step = String(step);
  };
  function openCoach() {
    showStep(0); coach.hidden = false; hideHelp();
    requestAnimationFrame(() => $('coachNext').focus({ preventScroll: true }));
  }
  function closeCoach() {
    if (coach.hidden) return;
    coach.hidden = true; store.set(KEY_COACHED, '1');
    const back = typeof returnFocus === 'function' ? returnFocus() : returnFocus;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }
  $('coachSkip').addEventListener('click', closeCoach);
  $('coachBack').addEventListener('click', () => showStep(step - 1));
  $('coachNext').addEventListener('click', () => (step === STEPS.length - 1 ? closeCoach() : showStep(step + 1)));
  coach.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCoach();
    else if (e.key === 'ArrowRight' && step < STEPS.length - 1) showStep(step + 1);
    else if (e.key === 'ArrowLeft') showStep(step - 1);
    else { e.stopPropagation(); return; }   // typing keys stay inside the coach (no H / E / R behind it)
    e.preventDefault(); e.stopPropagation();
  });

  // ---------- camera-blocked / unavailable help ----------
  function showHelp({ title, body, retry = false }) {
    help.replaceChildren();
    const h = document.createElement('h3'); h.textContent = title;
    const p = document.createElement('p'); p.textContent = body;
    const alt = document.createElement('p'); alt.className = 'hh-alt';
    alt.textContent = 'Without hands: drag to turn, scroll to zoom, E takes it apart, click a part and press Delete to remove it, R resets.';
    const nav = document.createElement('div'); nav.className = 'hh-nav';
    if (retry) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn primary'; b.textContent = 'Try again'; b.addEventListener('click', () => { hideHelp(); onRetry?.(); }); nav.append(b); }
    const c = document.createElement('button'); c.type = 'button'; c.className = 'btn'; c.textContent = 'Close'; c.addEventListener('click', hideHelp); nav.append(c);
    help.append(h, p, alt, nav); help.hidden = false;
    requestAnimationFrame(() => nav.firstElementChild?.focus({ preventScroll: true }));
  }
  function hideHelp() { if (help.hidden) return; help.hidden = true; const back = typeof returnFocus === 'function' ? returnFocus() : returnFocus; if (help.contains(document.activeElement) && back?.isConnected) back.focus({ preventScroll: true }); }
  help.addEventListener('keydown', e => { if (e.key === 'Escape') { hideHelp(); e.preventDefault(); e.stopPropagation(); } });

  // ---------- status, legend, cursor ----------
  function status(kind) {
    if (kind === kindNow) return; kindNow = kind;
    chip.dataset.kind = kind; chipText.textContent = STATUS[kind] || STATUS.none;
  }
  function legend(mode) {
    const g = { hover: 'hover', point: 'hover', rotate: 'rotate', zoom: 'zoom', fist: 'fist', thumbs: 'thumbs' }[mode] || '';
    if (g === modeNow) return; modeNow = g;
    for (const li of $('handlegend').querySelectorAll('li[data-g]')) li.classList.toggle('on', li.dataset.g === g);
  }
  function cursor(x, y, { state = 'hover', closeness = 0, dwell = 0, label = '' } = {}) {
    if (x == null) { cur.hidden = true; return; }
    cur.hidden = false; cur.dataset.state = state;
    cur.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    cur.style.setProperty('--p', closeness.toFixed(2)); cur.style.setProperty('--d', dwell.toFixed(2));
    if (curLabel.textContent !== label) curLabel.textContent = label;
    curLabel.hidden = !label;
  }

  // ---------- skeleton over the stage + the camera thumbnail ----------
  function drawHands(g, W, H, ctx, map, alpha = 1) {
    for (const h of g.skeleton || []) {
      const P = h.lm.map(p => map(p));
      ctx.globalAlpha = (h.primary ? 0.42 : 0.28) * alpha;
      ctx.strokeStyle = '#3BD8FF'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
      ctx.beginPath(); for (const [a, b] of BONES) { ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); } ctx.stroke();
      ctx.fillStyle = '#DDF7FF'; for (const p of P) { ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, 6.283); ctx.fill(); }
      if (h.closeness > 0.05) {   // the pinch closing: a gold thread between thumb and index tips
        ctx.globalAlpha = Math.min(1, h.closeness) * alpha; ctx.strokeStyle = '#FFC845'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(P[4].x, P[4].y); ctx.lineTo(P[8].x, P[8].y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  function frame(g) {
    const r = stage.getBoundingClientRect(), W = Math.round(r.width), H = Math.round(r.height);
    if (layer.width !== W || layer.height !== H) { layer.width = W; layer.height = H; }
    if (drawn || g.skeleton?.length) lg.clearRect(0, 0, W, H);
    drawn = !!g.skeleton?.length;
    if (drawn) drawHands(g, W, H, lg, p => toStage(p, W, H), reduced ? 0.6 : 1);
    if (showVideo) {
      const w = preview.width, h = preview.height;
      pg.clearRect(0, 0, w, h);
      if (video && video.readyState >= 2) { pg.save(); pg.globalAlpha = 0.55; pg.translate(w, 0); pg.scale(-1, 1); pg.drawImage(video, 0, 0, w, h); pg.restore(); }
      else { pg.fillStyle = '#0B1016'; pg.fillRect(0, 0, w, h); pg.fillStyle = '#7FA6B3'; pg.font = '11px system-ui, sans-serif'; pg.fillText(video === null ? 'Simulated hands' : 'Camera starting…', 8, h - 8); }
      pg.setLineDash([3, 3]); pg.strokeStyle = 'rgba(255,200,69,.55)'; pg.lineWidth = 1;   // the part of the picture that covers the stage
      pg.strokeRect(w * 0.12, h * 0.12, w * 0.76, h * 0.76); pg.setLineDash([]);
      drawHands(g, w, h, pg, p => ({ x: p.x * w, y: p.y * h }), 2);
    }
  }

  return {
    start(v) {
      video = v; on = true; view.hidden = false; kindNow = ''; modeNow = ''; status('none'); legend('');
      $('privacy').hidden = false;
    },
    stop() {
      on = false; video = null; view.hidden = true; cur.hidden = true; lg.clearRect(0, 0, layer.width, layer.height); drawn = false;
      closeCoach();
    },
    get on() { return on; },
    frame, cursor, status, legend, openCoach, closeCoach, showHelp, hideHelp,
    coachOpen: () => !coach.hidden,
    /** The coach opens by itself the first time hands start (remembered; skippable). */
    maybeCoach() { if (store.get(KEY_COACHED) !== '1') openCoach(); },
    statusKind: () => kindNow,
  };
}
