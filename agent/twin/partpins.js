// Pin tables for the boards in data/parts (everything except the UNO, which keeps data/uno-pins.json). Pure (no DOM,
// no three.js, no fs): board.mjs (Node) and the 3D twin (browser) share it, so a pin name resolves the same way on the
// phone video and on the laptop.
//
// Frame: the part files draw the top view with x right and y DOWN. Here, like the UNO table, u = x_mm and
// v = outline height - y_mm (v up the drawing), z up out of the top face: a right-handed frame, so corners A -> B -> C -> D
// (data/parts/orientation.json) run clockwise on screen when the board is seen from above.

export const UNO_MODELS = ['uno-r3', 'uno-r4-wifi'];

const fill = (tpl, n) => (tpl ? tpl.replace('{n}', String(n)) : null);
const base = k => k.replace(/\.\d+$/, '');
/** Upper-case, no spaces, '3.3V' / '3V3' / '3.3' folded together. */
const fold = s => String(s).trim().toUpperCase().replace(/\s+/g, '');
const SYN = [['3V3', '3.3V', '3.3', '3V'], ['GND', 'GROUND', 'G'], ['RESET', 'RST'], ['5V', '+5V'], ['VIN', 'V_IN']];

/**
 * Pin table for one part.
 * @param {{id: string, name: string, outline_mm: {w: number, h: number}, pins: any[], headers?: any[]}} part data/parts/<id>.json
 * @param {object} [orient] its entry in data/parts/orientation.json
 * @returns {{id: string, name: string, W: number, H: number, pins: Record<string, {u: number, v: number, x_mm: number, y_mm: number, fn: string, number: number | null}>,
 *   corners: Record<'A'|'B'|'C'|'D', number[]> | null, headerTop: number, polarity: number, header: string,
 *   resolve: (name: any, near?: {u: number, v: number}) => string | null, info: (key: string) => {name: string, fn: string, pwm: boolean}}}
 */
export function partTable(part, orient = {}) {
  const W = part.outline_mm.w, H = part.outline_mm.h;
  const pins = {};
  for (const p of part.pins) pins[p.name] = { u: p.x_mm, v: H - p.y_mm, x_mm: p.x_mm, y_mm: p.y_mm, fn: p.function || '', number: Number.isInteger(p.number) ? p.number : null };
  // physical pin numbers: from the file ("number"), or by header position (Pico: H1 counts 1..20, H2 counts 40..21)
  if (orient.physical && typeof orient.physical === 'object') {
    for (const h of part.headers || []) {
      const rule = orient.physical[h.name];
      if (rule) h.pins.forEach((k, i) => { if (pins[k]) pins[k].number = rule[0] + rule[1] * i; });
    }
  }
  const byNumber = new Map(Object.entries(pins).filter(([, p]) => p.number != null).map(([k, p]) => [p.number, k]));
  const upper = new Map(Object.keys(pins).map(k => [k.toUpperCase(), k]));
  const aliases = new Map(Object.entries(orient.aliases || {}).map(([k, v]) => [k.toUpperCase(), v]));
  const gpioAliases = orient.gpioAliases || {};
  const d2 = (a, b) => (a.u - b.u) ** 2 + (a.v - b.v) ** 2;

  /** Exact key, or the nearest of its duplicates ("GND" -> GND.1 / GND.2 ...). */
  const direct = (s, near) => {
    if (upper.has(s)) return upper.get(s);
    const dups = Object.keys(pins).filter(k => base(k).toUpperCase() === s);
    if (!dups.length) return null;
    const suffix = k => Number(k.match(/\.(\d+)$/)?.[1] || 0);
    return near ? dups.sort((a, b) => d2(pins[a], near) - d2(pins[b], near))[0] : dups.sort((a, b) => suffix(a) - suffix(b))[0];
  };
  const named = (s, near) => {
    const k = direct(s, near);
    if (k) return k;
    if (aliases.has(s)) return direct(aliases.get(s).toUpperCase(), near);
    for (const group of SYN) if (group.includes(s)) for (const alt of group) { const a = direct(alt, near) || (aliases.has(alt) ? direct(aliases.get(alt).toUpperCase(), near) : null); if (a) return a; }
    return null;
  };
  const gpio = n => {
    const k = gpioAliases[String(n)] || fill(orient.gpio, n);
    return k ? direct(k.toUpperCase()) : null;
  };

  function resolve(name, near) {
    if (name == null) return null;
    let s = fold(name);
    if (!s) return null;
    const hasPhysical = byNumber.size > 0;
    let m = s.match(/^(?:PHYSICAL|PHYS|PIN|#)(?:NO\.?|NUMBER|#)?(\d{1,2})$/);
    if (m && hasPhysical) return byNumber.get(Number(m[1])) || null;
    s = s.replace(/^PIN/, '');
    if (!s) return null;
    const k = named(s, near);
    if (k) return k;
    m = s.match(/^(?:GPIO|IO|BCM|GP|G)(\d{1,2})$/);
    if (m) return gpio(Number(m[1]));
    m = s.match(/^D(\d{1,2})$/);   // Arduino style "D13" on a board that prints "13"
    if (m) return direct(fill(orient.bare || '{n}', Number(m[1])).toUpperCase()) || null;
    if (/^\d{1,2}$/.test(s)) {
      const n = Number(s);
      return (orient.bare ? direct(fill(orient.bare, n).toUpperCase()) : null) || gpio(n);
    }
    return null;
  }

  function info(key) {
    const p = pins[key];
    if (!p) return { name: key, fn: '', pwm: false };
    const name = /^\d+$/.test(key) ? `D${key}` : base(key);
    const parts = [p.fn && p.fn !== name ? p.fn : ''];
    if (p.number != null) parts.push(`pin ${p.number}`);
    return { name, fn: parts.filter(Boolean).join(' · '), pwm: /PWM/.test(p.fn) };
  }

  const corners = orient.corners
    ? Object.fromEntries(['A', 'B', 'C', 'D'].map(c => [c, [orient.corners[c][0], H - orient.corners[c][1]]]))
    : null;
  const header = orient.header?.type || 'maleDown';
  return {
    id: part.id, name: part.name, W, H, pins, corners, header,
    headerTop: Number.isFinite(orient.header?.z) ? orient.header.z : 1.0,
    polarity: orient.header?.polarity === 'dark' ? 1 : -1,
    headers: part.headers || [],
    resolve, info,
  };
}

/** Normalised alias -> part id, like data/parts/index.json's lookup ("Pi 4" -> raspberry-pi-4). */
export const normAlias = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The twin's bundle (twin/parts.json): every part with an orientation entry, plus the alias lookup. Built from
 * data/parts by test/parts-board-test.mjs --write; the test fails if the bundle is stale.
 */
export function twinBundle(index, parts, orientation) {
  const out = { _doc: 'Generated from data/parts (index.json, orientation.json, <id>.json) by node test/parts-board-test.mjs --write. Do not edit. Each part keeps its own license, source and attribution (see data/parts/LICENSES.md; Fritzing-derived entries are CC-BY-SA 3.0).', parts: {}, lookup: index.lookup };
  for (const id of Object.keys(orientation)) {
    if (id.startsWith('_') || !parts[id]) continue;
    const p = parts[id];
    out.parts[id] = { id, name: p.name, license: p.license, source: p.source, attribution: p.attribution, outline_mm: p.outline_mm, headers: p.headers, pins: p.pins, orientation: orientation[id] };
  }
  return out;
}
