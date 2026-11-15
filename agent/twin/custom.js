// A board Ody has no library model for: the brain describes its headers (hole positions in board mm + labels) and the
// twin builds a plain PCB slab with those header strips and labelled holes. Pure (no DOM, no three.js), so it can be
// tested in Node. Accepts a few spellings of the spec, because the producer is still settling on one; anything it
// cannot read gives null and the twin simply keeps what it shows.
//
// Accepted (any of these places): ev.headers | ev.spec.headers | ev.board.headers
//   header: { name|label, holes|pins: [ {x, y, label} | {x_mm, y_mm, name} | [x, y, label] ] }
// Board size: ev.size_mm | ev.outline_mm | ev.board_mm | ev.dims_mm | spec.* as {w, h} or [w, h]; else the holes + margin.
// Frame: x right, y down from the board's top-left corner, like data/parts.

const MAX_HOLES = 240, MAX_HEADERS = 24, MAX_MM = 300;
const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : null;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function size(o) {
  if (!o || typeof o !== 'object') return null;
  for (const k of ['size_mm', 'outline_mm', 'board_mm', 'dims_mm']) {
    const v = o[k];
    if (Array.isArray(v) && num(v[0]) && num(v[1])) return { w: num(v[0]), h: num(v[1]) };
    if (v && typeof v === 'object' && num(v.w) && num(v.h ?? v.d)) return { w: num(v.w), h: num(v.h ?? v.d) };
  }
  if (num(o.w_mm) && num(o.h_mm)) return { w: num(o.w_mm), h: num(o.h_mm) };
  return null;
}
function hole(h, i) {
  if (Array.isArray(h)) return { x: num(h[0]), y: num(h[1]), label: clean(h[2], 16) };
  if (!h || typeof h !== 'object') return null;
  const at = Array.isArray(h.pos) ? h.pos : Array.isArray(h.at) ? h.at : null;
  return { x: num(h.x_mm ?? h.x ?? at?.[0]), y: num(h.y_mm ?? h.y ?? at?.[1]), label: clean(h.label ?? h.name ?? h.pin, 16), fn: clean(h.function ?? h.fn ?? h.note, 60), i };
}

/**
 * @param {object} ev the `part` event (model 'custom')
 * @returns {null | {id: 'custom', name: string, outline_mm: {w: number, h: number}, headers: object[], pins: object[], orientation: object}}
 */
export function customPart(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const src = [ev, ev.spec, ev.board].find(o => o && typeof o === 'object' && Array.isArray(o.headers));
  if (!src) return null;
  const headers = [], pins = [], used = new Map();
  let n = 0;
  for (const [hi, raw] of src.headers.slice(0, MAX_HEADERS).entries()) {
    const list = Array.isArray(raw?.holes) ? raw.holes : Array.isArray(raw?.pins) ? raw.pins : Array.isArray(raw) ? raw : [];
    const hname = clean(raw?.name ?? raw?.label, 24) || `J${hi + 1}`;
    const keys = [];
    for (const [i, r] of list.entries()) {
      if (n >= MAX_HOLES) break;
      const h = hole(r, i);
      if (!h || h.x == null || h.y == null || Math.abs(h.x) > MAX_MM || Math.abs(h.y) > MAX_MM) continue;
      let name = h.label || `${hname}-${i + 1}`;
      // duplicate labels (GND twice) get .1, .2 like the library, so each hole stays its own pin
      const seen = used.get(name.toUpperCase()) || 0; used.set(name.toUpperCase(), seen + 1);
      if (seen) name = `${name}.${seen}`;
      pins.push({ name, x_mm: h.x, y_mm: h.y, kind: 'header', function: h.fn || `${hname} pin ${i + 1}` });
      keys.push(name); n++;
    }
    if (!keys.length) continue;
    const ps = pins.slice(-keys.length);
    const dx = Math.max(...ps.map(p => p.x_mm)) - Math.min(...ps.map(p => p.x_mm));
    const dy = Math.max(...ps.map(p => p.y_mm)) - Math.min(...ps.map(p => p.y_mm));
    headers.push({ name: hname, orientation: dy > dx ? 'column' : 'row', pitch_mm: 2.54, pins: keys });
  }
  if (!pins.length) return null;
  // shift so every hole sits on the board, then size the board (given, or holes + a 4 mm margin)
  const minX = Math.min(...pins.map(p => p.x_mm)), minY = Math.min(...pins.map(p => p.y_mm));
  const given = size(src) || size(ev) || size(ev.spec);
  const ox = minX < 1.5 || !given ? 4 - minX : 0, oy = minY < 1.5 || !given ? 4 - minY : 0;
  for (const p of pins) { p.x_mm += ox; p.y_mm += oy; }
  const needW = Math.max(...pins.map(p => p.x_mm)) + 4, needH = Math.max(...pins.map(p => p.y_mm)) + 4;
  const W = Math.min(MAX_MM, Math.max(needW, given?.w || 0, 12)), H = Math.min(MAX_MM, Math.max(needH, given?.h || 0, 12));
  const name = clean(ev.label ?? src.name ?? ev.name, 60) || 'Custom board';
  const type = ['female', 'maleUp', 'maleDown'].includes(src.header_type) ? src.header_type : 'maleUp';
  return {
    id: 'custom', name, outline_mm: { w: W, h: H }, headers, pins,
    orientation: { corners: { A: [0, 0], B: [W, 0], C: [W, H], D: [0, H] }, header: { type, z: type === 'female' ? 8.5 : type === 'maleUp' ? 6 : 1, polarity: 'bright' } },
  };
}

/** A key that changes when the spec does, so the twin rebuilds the model only then. */
export const customKey = p => (p ? `${p.name}|${p.outline_mm.w}x${p.outline_mm.h}|${p.pins.map(q => `${q.name}@${q.x_mm.toFixed(2)},${q.y_mm.toFixed(2)}`).join(';')}` : '');
