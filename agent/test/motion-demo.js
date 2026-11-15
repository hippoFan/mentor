// Demo of twin/motion.js + twin/ink.js on papyrus. ?auto runs the whole show once (used by the recorder).
import { initMotion, pageTransition, revealHeading, drawIn, stagger, pulse, combineMorph, toast, pop, gsap } from '/twin/motion.js';
import { inkify, uninkify, annotate, inkStroke, flourish } from '/twin/ink.js';

initMotion();
const $ = id => document.getElementById(id);
const wait = ms => new Promise(r => setTimeout(r, ms));

// the galley, inlined so its ink can draw itself
const svgText = await (await fetch('/twin/paper/ship.svg')).text();
const ship = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
ship.removeAttribute('width'); ship.removeAttribute('height'); ship.setAttribute('aria-hidden', 'true');
ship.style.width = '100%'; ship.style.height = 'auto';
$('ship-holder').appendChild(document.importNode(ship, true));

await document.fonts.ready;
let page = 'main';
const ORDER = ['argo', 'main', 'forge'];
pulse($('dot'));

function intro() {
  $('page-main').dataset.seen = '1';
  inkify($('page-main'));
  inkify(document.querySelector('.bar'));
  revealHeading($('h-home'));
  inkStroke(flourish(400, 22, { amp: 8, n: 2, x: 10 }), { svg: $('flourish'), size: 6, color: 'orange', animate: true, duration: 1.1, delay: 0.5 });
  drawIn($('ship-holder'), { delay: 0.3, speed: 0.8 });
  stagger($('cards'), { delay: 0.55 });
  setTimeout(() => annotate($('mk'), 'highlight'), 1500);
}

let seq = 0;
async function go(to) {
  if (to === page) return;
  const my = ++seq;
  const from = $(`page-${page}`), next = $(`page-${to}`);
  const dir = Math.sign(ORDER.indexOf(to) - ORDER.indexOf(page)) || 1;
  for (const p of document.querySelectorAll('.page')) p.hidden = p !== from && p !== next;
  const tl = pageTransition(from, next, dir);
  page = to;
  document.querySelectorAll('nav button').forEach(b => {
    const on = b.dataset.go === to;
    if (on) { b.setAttribute('aria-current', 'page'); b.dataset.ink = 'underline'; b.dataset.inkColor = 'orange'; }
    else { b.removeAttribute('aria-current'); uninkify(b); delete b.dataset.ink; delete b.dataset.inkStatic; }
  });
  inkify(document.querySelector('nav'));
  const h = next.querySelector('h1');
  if (!next.dataset.seen) { next.dataset.seen = '1'; revealHeading(h, { delay: 0.25 }); inkify(next); if (to === 'forge') stagger($('parts'), { delay: 0.3 }); }
  await tl;
  if (my === seq) from.hidden = true;
}

async function combine() {
  const chips = [...$('parts').children];
  await combineMorph(chips, {
    into: $('slot'), result: $('result'),
    morph: { path: $('glyph'), to: 'M90 22 C128 22 158 52 158 90 C158 128 128 158 90 158 C52 158 22 128 22 90 C22 52 52 22 90 22 Z' },
    onHit: () => inkify($('slot').parentElement),
  });
  inkify($('result'));
  drawIn($('result').querySelector('.ink-overlay'), { speed: 1.5 });
  const t = toast($('toast'), { hold: 2.4 });
  drawIn($('toast').querySelector('svg'), { delay: 0.2 });
  return t;
}

document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
$('go-forge').addEventListener('click', () => { pop($('go-forge')); go('forge'); });
$('combine').addEventListener('click', () => { pop($('combine')); combine(); });
$('ring').addEventListener('click', () => { pop($('ring')); annotate($('ring'), 'circle', { color: 'orange' }); });

document.body.dataset.t0 = '1';
intro();
window.demo = { go, combine, gsap };
if (new URLSearchParams(location.search).has('auto')) {
  await wait(3000);
  go('argo'); await wait(1500);          // (a) stall, Argo shoves Home out to the right
  go('main'); await wait(1500);          // (c) rubber band back
  pop($('go-forge')); go('forge'); await wait(1700);   // (b) mirrored
  pop($('combine')); await combine();
  await wait(300);
  go('main'); await wait(1400);          // (c) from the right
  go('argo'); await wait(330); go('main'); await wait(1400);   // interrupted mid-push: retargets cleanly
  document.body.dataset.done = '1';
}
document.body.dataset.ready = '1';
