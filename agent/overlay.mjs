// Draws the picture the caller sees: their own camera frame, with Mentor's rings, leader lines and labels on top,
// plus a floating caption with the current step. Returns one RGBA frame (WIDTH x HEIGHT) for the outgoing video track.
// Look: thin yellow rings with a soft shadow (no outlines), solid yellow labels, a dark frosted caption pill. Inter.
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, ImageData } from '@napi-rs/canvas';

GlobalFonts.registerFromPath(fileURLToPath(new URL('./fonts/InterVariable.ttf', import.meta.url)), 'Inter');

// The caller holds a phone upright, so by default Mentor sends portrait video that fills their screen.
// MENTOR_OUT=landscape restores the Chert starter's 640x360 (x MENTOR_OUT_SCALE).
const PORTRAIT = (process.env.MENTOR_OUT || 'portrait') !== 'landscape';
const K = PORTRAIT ? 1.5 : Number(process.env.MENTOR_OUT_SCALE || 1);
export const WIDTH = PORTRAIT ? 540 : 640 * K;
export const HEIGHT = PORTRAIT ? 960 : 360 * K;
export const FPS = 15;

const ACCENT = '#FFC845';   // Mentor yellow: only Mentor's own marks
const INK = '#1D1D1F';
const SHADOW = 'rgba(0,0,0,0.45)';
const DANGER = '#FF3B30';   // a "warn" mark: something to fix before powering on
const FONT = (weight, px) => `${weight} ${px * K}px Inter, sans-serif`;
const out = createCanvas(WIDTH, HEIGHT);
const g = out.getContext('2d');
let src = createCanvas(16, 16);   // holds the caller frame at its native size; resized when the frame size changes

/**
 * Where the caller frame lands on the output (letterboxed, whole frame visible, so points map 1:1).
 * @param {number} w source width  @param {number} h source height
 */
export function fitRect(w, h) {
  // Fill the screen when the shapes are close (crop at most ~15% a side); otherwise show the whole frame.
  const cover = Math.max(WIDTH / w, HEIGHT / h), contain = Math.min(WIDTH / w, HEIGHT / h);
  const s = cover / contain <= 1.35 ? cover : contain;
  const dw = w * s, dh = h * s;
  return { x: (WIDTH - dw) / 2, y: (HEIGHT - dh) / 2, w: dw, h: dh };
}

/**
 * @param {{data: Uint8Array, width: number, height: number} | null} frame caller frame, RGBA, already upright
 * @param {{label: string, x: number, y: number, kind?: 'arrow' | 'circle'}[]} marks x,y normalised 0..1 in the frame
 * @param {{caption?: string, tick?: number, speaking?: boolean}} [opts]
 * @returns {Uint8Array} WIDTH*HEIGHT*4 RGBA
 */
export function render(frame, marks = [], opts = {}) {
  const { caption = '', tick = 0, speaking = false } = opts;
  g.fillStyle = '#1D1D1F';
  g.fillRect(0, 0, WIDTH, HEIGHT);

  let rect = { x: 0, y: 0, w: WIDTH, h: HEIGHT };
  if (frame) {
    if (src.width !== frame.width || src.height !== frame.height) src = createCanvas(frame.width, frame.height);
    const clamped = new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.width * frame.height * 4);
    src.getContext('2d').putImageData(new ImageData(clamped, frame.width, frame.height), 0, 0);
    rect = fitRect(frame.width, frame.height);
    g.drawImage(src, rect.x, rect.y, rect.w, rect.h);
  } else {
    g.textAlign = 'center';
    g.lineWidth = 3 * K; g.strokeStyle = ACCENT;
    g.beginPath(); g.arc(WIDTH / 2, HEIGHT / 2 - 34 * K, 13 * K, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#F5F5F7'; g.font = FONT(700, 22);
    g.fillText('Mentor', WIDTH / 2, HEIGHT / 2 + 8 * K);
    g.fillStyle = '#A1A1A6'; g.font = FONT(500, 14);
    g.fillText('Turn on your camera and show me your project', WIDTH / 2, HEIGHT / 2 + 32 * K);
    g.textAlign = 'left';
  }

  const pulse = 1 + 0.04 * Math.sin(tick * 0.35);   // a slight pulse so a mark reads as live, not painted on
  const pts = marks.map(m => ({ ...m, px: rect.x + m.x * rect.w, py: rect.y + m.y * rect.h }));
  for (const m of pts) if (m.kind === 'wire' && m.x2 >= 0) drawWire(m.px, m.py, rect.x + m.x2 * rect.w, rect.y + m.y2 * rect.h, tick);
  for (const c of layoutCallouts(pts)) {
    if (c.kind === 'circle' || c.kind === 'wire' || c.kind === 'warn') drawLeader(c.join, c.px, c.py, c.kind === 'warn' ? DANGER : ACCENT);
    else drawArrow(c.px, c.py, c.join);
    drawRing(c.px, c.py, 15 * K * (c.kind === 'warn' ? 1 + 0.18 * Math.abs(Math.sin(tick * 0.6)) : pulse), c.kind === 'warn' ? DANGER : ACCENT);
    drawBox(c);
  }

  if (caption) drawCaption(caption);
  if (speaking) drawSpeaking(tick);

  const img = g.getImageData(0, 0, WIDTH, HEIGHT);
  return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
}

function shadow(on) {
  g.shadowColor = on ? SHADOW : 'transparent'; g.shadowBlur = on ? 6 * K : 0; g.shadowOffsetY = on ? 1 * K : 0;
}

function drawRing(x, y, r, color = ACCENT) {
  shadow(true);
  g.lineWidth = 3 * K; g.strokeStyle = color;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  shadow(false);
  g.lineWidth = 1 * K; g.strokeStyle = 'rgba(255,255,255,0.85)';   // hairline inside, so the ring reads on yellow parts too
  g.beginPath(); g.arc(x, y, r - 2 * K, 0, Math.PI * 2); g.stroke();
}

// Callouts: each label tries left, right, above, then below its own mark and takes the first spot that is inside the
// frame (clear of the caption) and overlaps no other label or ring. A line joins label and mark, so it is never ambiguous.
const GAP = 46 * K, BH = 22 * K, PAD = 9 * K, RING = 22 * K;
function layoutCallouts(pts) {
  g.font = FONT(600, 13);
  const placed = [];   // boxes already taken: labels, plus every ring's square
  const rings = pts.map(p => ({ x: p.px - RING, y: p.py - RING, w: RING * 2, h: RING * 2 }));
  const hit = (r, list) => list.some(b => r.x < b.x + b.w + 6 * K && r.x + r.w + 6 * K > b.x && r.y < b.y + b.h + 6 * K && r.y + r.h + 6 * K > b.y);
  const inside = r => r.x >= 6 * K && r.y >= 6 * K && r.x + r.w <= WIDTH - 6 * K && r.y + r.h <= HEIGHT - 52 * K;
  const out = [];
  for (const p of pts.filter(q => q.label)) {
    const w = g.measureText(p.label).width + PAD * 2;
    const sides = p.px < WIDTH / 2 ? ['left', 'right', 'up', 'down'] : ['right', 'left', 'up', 'down'];
    const at = side => ({
      left:  { x: p.px - GAP - w, y: p.py - BH / 2 },
      right: { x: p.px + GAP,     y: p.py - BH / 2 },
      up:    { x: p.px - w / 2,   y: p.py - GAP - BH },
      down:  { x: p.px - w / 2,   y: p.py + GAP },
    })[side];
    let best = null;
    for (let push = 0; push <= 4 && !best; push++) {           // if every side is blocked, try further out
      for (const side of sides) {
        const o = at(side), d = push * (BH + 6 * K);
        const r = { x: o.x + (side === 'left' ? -d : side === 'right' ? d : 0), y: o.y + (side === 'up' ? -d : side === 'down' ? d : 0), w, h: BH, side };
        if (inside(r) && !hit(r, placed) && !hit(r, rings)) { best = r; break; }
      }
    }
    if (!best) {   // nothing free: clamp the preferred spot into the frame
      const o = at(sides[0]);
      best = { x: Math.max(6 * K, Math.min(WIDTH - w - 6 * K, o.x)), y: Math.max(6 * K, Math.min(HEIGHT - BH - 52 * K, o.y)), w, h: BH, side: sides[0] };
    }
    placed.push(best);
    const join = best.side === 'left' ? { x: best.x + w, y: best.y + BH / 2 } : best.side === 'right' ? { x: best.x, y: best.y + BH / 2 }
      : best.side === 'up' ? { x: best.x + w / 2, y: best.y + BH } : { x: best.x + w / 2, y: best.y };
    out.push({ ...p, x: best.x, y: best.y, w, join });
  }
  return out;
}

function drawBox(c) {
  shadow(true);
  g.fillStyle = c.kind === 'warn' ? DANGER : ACCENT; roundRect(c.x, c.y, c.w, BH, BH / 2); g.fill();
  shadow(false);
  g.font = FONT(600, 13); g.fillStyle = c.kind === 'warn' ? '#FFFFFF' : INK; g.textBaseline = 'middle';
  g.fillText(c.label, c.x + PAD, c.y + BH / 2 + 0.5 * K);
  g.textBaseline = 'alphabetic';
}

function drawLeader(a, x, y, color = ACCENT) {
  const ang = Math.atan2(y - a.y, x - a.x);
  const ex = x - Math.cos(ang) * 16 * K, ey = y - Math.sin(ang) * 16 * K;
  shadow(true);
  g.lineWidth = 1.5 * K; g.strokeStyle = color; g.lineCap = 'round';
  g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(ex, ey); g.stroke();
  shadow(false);
}

function drawArrow(x, y, tail) {
  const ang = Math.atan2(y - tail.y, x - tail.x);
  const tipX = x - Math.cos(ang) * 19 * K, tipY = y - Math.sin(ang) * 19 * K;
  const h = 9 * K;
  shadow(true);
  g.lineWidth = 2.5 * K; g.strokeStyle = ACCENT; g.fillStyle = ACCENT; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(tail.x, tail.y); g.lineTo(tipX - Math.cos(ang) * h * 0.6, tipY - Math.sin(ang) * h * 0.6); g.stroke();
  g.beginPath();
  g.moveTo(tipX, tipY);
  g.lineTo(tipX - h * Math.cos(ang - 0.5), tipY - h * Math.sin(ang - 0.5));
  g.lineTo(tipX - h * Math.cos(ang + 0.5), tipY - h * Math.sin(ang + 0.5));
  g.closePath(); g.fill();
  shadow(false);
}

// AR wire: where a jumper goes, from (x1,y1) to (x2,y2): a curved cable with light flowing along it toward the
// destination, an end ring at the destination, so the caller sees the wire "placed" before touching anything.
function drawWire(x1, y1, x2, y2, tick) {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const bow = Math.min(90 * K, len * 0.28);                   // bow sideways like a real jumper wire
  const cx = mx + (-(y2 - y1) / len) * bow, cy = my + ((x2 - x1) / len) * bow;
  const path = () => { g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(cx, cy, x2, y2); };
  shadow(true);
  g.lineCap = 'round';
  g.lineWidth = 6 * K; g.strokeStyle = 'rgba(255,200,69,0.35)'; path(); g.stroke();   // the cable body
  shadow(false);
  g.lineWidth = 2.5 * K; g.strokeStyle = ACCENT; g.setLineDash([10 * K, 12 * K]);
  g.lineDashOffset = -tick * 2.2 * K; path(); g.stroke();                               // light flowing to the target
  g.setLineDash([]);
  g.fillStyle = ACCENT; g.beginPath(); g.arc(x1, y1, 4.5 * K, 0, Math.PI * 2); g.fill();   // start of the wire
  drawRing(x2, y2, 12 * K * (1 + 0.08 * Math.sin(tick * 0.5)));                           // where it goes in
}

// The current step, as a floating dark pill centred near the bottom (the caller's view stays uncovered).
function drawCaption(text) {
  g.font = FONT(600, 14);
  let line = text;
  const max = WIDTH - 64 * K;
  while (g.measureText(line).width > max && line.length > 4) line = line.slice(0, -2);
  if (line !== text) line = line.trimEnd() + '…';
  const w = g.measureText(line).width + 28 * K, h = 30 * K;
  const x = (WIDTH - w) / 2, y = HEIGHT - h - 14 * K;
  g.fillStyle = 'rgba(29,29,31,0.78)'; roundRect(x, y, w, h, h / 2); g.fill();
  g.fillStyle = '#FFFFFF'; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillText(line, WIDTH / 2, y + h / 2 + 0.5 * K);
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
}

// While Mentor talks: three small bars top-right, like a voice level.
function drawSpeaking(tick) {
  const x0 = WIDTH - 34 * K, y0 = 14 * K;
  g.fillStyle = 'rgba(29,29,31,0.6)'; roundRect(x0 - 8 * K, y0 - 4 * K, 36 * K, 24 * K, 12 * K); g.fill();
  g.fillStyle = ACCENT;
  for (let i = 0; i < 3; i++) {
    const hh = (5 + 7 * Math.abs(Math.sin(tick * 0.5 + i * 1.3))) * K;
    roundRect(x0 + i * 7 * K, y0 + 8 * K - hh / 2, 4 * K, hh, 2 * K); g.fill();
  }
}

function roundRect(x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/**
 * Rotates an RGBA frame upright (FaceTime may send a rotation flag instead of rotated pixels).
 * @param {{data: Uint8Array, width: number, height: number}} f  @param {number} quarterTurns 0..3 clockwise
 */
export function rotate(f, quarterTurns) {
  if (!quarterTurns) return f;
  const { width: w, height: h, data } = f;
  const swap = quarterTurns % 2 === 1;
  const ow = swap ? h : w, oh = swap ? w : h;
  const o = new Uint8Array(ow * oh * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let nx, ny;
    if (quarterTurns === 1) { nx = h - 1 - y; ny = x; }
    else if (quarterTurns === 2) { nx = w - 1 - x; ny = h - 1 - y; }
    else { nx = y; ny = w - 1 - x; }
    const si = (y * w + x) * 4, di = (ny * ow + nx) * 4;
    o[di] = data[si]; o[di + 1] = data[si + 1]; o[di + 2] = data[si + 2]; o[di + 3] = data[si + 3];
  }
  return { data: o, width: ow, height: oh };
}

/**
 * Finds the real picture inside a FaceTime frame (which arrives pillarboxed / letterboxed in black) so Mentor works on
 * the caller's camera only: a bigger, clearer image for the brain and a screen-filling picture for the caller.
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function contentBox(f) {
  const { width: w, height: h, data } = f;
  const lit = (x, y) => { const i = (y * w + x) * 4; return data[i] + data[i + 1] + data[i + 2] > 60; };
  const colLit = x => { let n = 0; for (let y = 0; y < h; y += Math.max(1, h >> 5)) n += lit(x, y); return n > 3; };
  const rowLit = y => { let n = 0; for (let x = 0; x < w; x += Math.max(1, w >> 5)) n += lit(x, y); return n > 3; };
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
  while (x0 < x1 && !colLit(x0)) x0++;
  while (x1 > x0 && !colLit(x1)) x1--;
  while (y0 < y1 && !rowLit(y0)) y0++;
  while (y1 > y0 && !rowLit(y1)) y1--;
  const bw = x1 - x0 + 1;
  // FaceTime's own self-view (a picture-in-picture of Mentor's video) sits in the bottom ~20% of the picture, and a
  // status icon in the top ~6%: drop both so Mentor never sees or re-shows its own output.
  const top = y0 + Math.round((y1 - y0) * 0.06), bottom = y0 + Math.round((y1 - y0) * 0.80);
  const bh = bottom - top + 1;
  if (bw < w * 0.25 || bh < h * 0.25) return { x: 0, y: 0, w, h };   // mostly dark scene: keep everything
  return { x: x0, y: top, w: bw, h: bh };
}

/** A copy of one rectangle of an RGBA frame. */
export function crop(f, b) {
  if (b.x === 0 && b.y === 0 && b.w === f.width && b.h === f.height) return f;
  const o = new Uint8Array(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) o.set(f.data.subarray(((b.y + y) * f.width + b.x) * 4, ((b.y + y) * f.width + b.x + b.w) * 4), y * b.w * 4);
  return { data: o, width: b.w, height: b.h };
}

/** JPEG of the raw caller frame (no overlays), downscaled so the long side is at most `max` px, for the brain. */
export async function frameJpeg(frame, max = 1024) {
  if (src.width !== frame.width || src.height !== frame.height) src = createCanvas(frame.width, frame.height);
  const clamped = new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.width * frame.height * 4);
  src.getContext('2d').putImageData(new ImageData(clamped, frame.width, frame.height), 0, 0);
  const s = Math.min(1, max / Math.max(frame.width, frame.height));
  const w = Math.round(frame.width * s), h = Math.round(frame.height * s);
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  return { jpeg: await c.encode('jpeg', 85), width: w, height: h };
}

/** JPEG of the current output picture, for the laptop monitor. */
export function outJpeg(quality = 70) {
  return out.encode('jpeg', quality);
}

/** PNG of the current output picture (what the caller sees), for the recap. */
export function snapshotPng() {
  return out.encode('png');
}
