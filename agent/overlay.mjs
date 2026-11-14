// Draws the picture the caller sees: their own camera frame, with Mentor's arrows, circles and labels on top,
// plus a caption bar with the current step. Returns one RGBA frame (WIDTH x HEIGHT) for the outgoing video track.
import { createCanvas, ImageData } from '@napi-rs/canvas';

export const WIDTH = 640;
export const HEIGHT = 360;
export const FPS = 15;

const ACCENT = '#FFC845';   // arrows + rings: warm yellow reads on most backgrounds
const INK = '#111111';
const out = createCanvas(WIDTH, HEIGHT);
const g = out.getContext('2d');
let src = createCanvas(16, 16);   // holds the caller frame at its native size; resized when the frame size changes

/**
 * Where the caller frame lands on the output (letterboxed, whole frame visible, so points map 1:1).
 * @param {number} w source width  @param {number} h source height
 */
export function fitRect(w, h) {
  const s = Math.min(WIDTH / w, HEIGHT / h);
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
  g.fillStyle = '#0B1A22';
  g.fillRect(0, 0, WIDTH, HEIGHT);

  let rect = { x: 0, y: 0, w: WIDTH, h: HEIGHT };
  if (frame) {
    if (src.width !== frame.width || src.height !== frame.height) src = createCanvas(frame.width, frame.height);
    const clamped = new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.width * frame.height * 4);
    src.getContext('2d').putImageData(new ImageData(clamped, frame.width, frame.height), 0, 0);
    rect = fitRect(frame.width, frame.height);
    g.drawImage(src, rect.x, rect.y, rect.w, rect.h);
  } else {
    g.fillStyle = '#E8F1F5';
    g.font = 'bold 26px sans-serif';
    g.textAlign = 'center';
    g.fillText('Mentor', WIDTH / 2, HEIGHT / 2 - 8);
    g.font = '16px sans-serif';
    g.fillText('Turn on your camera and show me your project', WIDTH / 2, HEIGHT / 2 + 20);
    g.textAlign = 'left';
  }

  const pulse = 1 + 0.12 * Math.sin(tick * 0.4);
  for (const m of marks) {
    const px = rect.x + m.x * rect.w, py = rect.y + m.y * rect.h;
    drawRing(px, py, 16 * pulse);
    const tail = tailFor(px, py);
    if (m.kind !== 'circle') drawArrow(px, py, tail);
    drawLabel(m.label, m.kind === 'circle' ? { x: px, y: py + (py < HEIGHT / 2 ? 50 : -50) } : tail);
  }

  if (caption) drawCaption(caption);
  if (speaking) { g.fillStyle = ACCENT; g.beginPath(); g.arc(WIDTH - 18, 18, 6 * pulse, 0, Math.PI * 2); g.fill(); }

  const img = g.getImageData(0, 0, WIDTH, HEIGHT);
  return new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
}

function drawRing(x, y, r) {
  g.lineWidth = 6; g.strokeStyle = INK; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 3; g.strokeStyle = ACCENT; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
}

// Arrow comes in from the side with more room, so it never leaves the picture; its label sits on the tail.
function tailFor(x, y) {
  return { x: x < WIDTH / 2 ? x + 90 : x - 90, y: y < HEIGHT / 2 ? y + 70 : y - 70 };
}

function drawArrow(x, y, tail) {
  const fromX = tail.x, fromY = tail.y;
  const ang = Math.atan2(y - fromY, x - fromX);
  const tipX = x - Math.cos(ang) * 20, tipY = y - Math.sin(ang) * 20;
  for (const [w, c] of [[9, INK], [5, ACCENT]]) {
    g.lineWidth = w; g.strokeStyle = c; g.fillStyle = c; g.lineCap = 'round';
    g.beginPath(); g.moveTo(fromX, fromY); g.lineTo(tipX, tipY); g.stroke();
    const h = w === 9 ? 18 : 14;
    g.beginPath();
    g.moveTo(tipX, tipY);
    g.lineTo(tipX - h * Math.cos(ang - 0.45), tipY - h * Math.sin(ang - 0.45));
    g.lineTo(tipX - h * Math.cos(ang + 0.45), tipY - h * Math.sin(ang + 0.45));
    g.closePath(); g.fill();
  }
}

function drawLabel(text, at) {
  if (!text) return;
  g.font = 'bold 15px sans-serif';
  const tw = g.measureText(text).width;
  const bw = tw + 16, bh = 24;
  let bx = at.x - bw / 2;
  let by = at.y < HEIGHT / 2 ? at.y - bh - 4 : at.y + 4;
  bx = Math.max(4, Math.min(WIDTH - bw - 4, bx));
  by = Math.max(4, Math.min(HEIGHT - bh - 44, by));
  g.fillStyle = ACCENT; roundRect(bx, by, bw, bh, 12); g.fill();
  g.fillStyle = INK; g.fillText(text, bx + 8, by + 17);
}

function drawCaption(text) {
  g.font = 'bold 16px sans-serif';
  const line = text.length > 70 ? text.slice(0, 67) + '...' : text;
  g.fillStyle = 'rgba(0,0,0,0.65)';
  g.fillRect(0, HEIGHT - 36, WIDTH, 36);
  g.fillStyle = '#FFFFFF';
  g.fillText(line, 12, HEIGHT - 12);
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

/** PNG of the current output picture (what the caller sees), for the recap. */
export function snapshotPng() {
  return out.encode('png');
}
