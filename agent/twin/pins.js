// UNO pin table + breadboard holes + turning Mentor's marks into 3D targets. Pure (no DOM, no three.js), so Node
// tests can import it. Board frame (mm): u along the long edge from the USB edge, v from the power-header edge.

export const BOARD_W = 68.58, BOARD_H = 53.34, PCB_T = 1.6, HEADER_H = 8.5, PITCH = 2.54;

/** Prefers the shared table (data/uno-pins.json, from wokwi-elements, MIT); falls back to twin/uno-pins.json. */
export async function loadPins(fetchFn = globalThis.fetch) {
  for (const url of ['/data/uno-pins.json', '/twin/uno-pins.json']) {
    try {
      const r = await fetchFn(url);
      if (r.ok) { const t = await r.json(); if (t?.pins?.['13']) return { ...t, source: url }; }
    } catch { /* try the next */ }
  }
  throw new Error('no UNO pin table');
}

const PWM = new Set(['3', '5', '6', '9', '10', '11']);
const DIGITAL_FN = {
  0: 'RX · serial receive', 1: 'TX · serial transmit', 2: 'Digital · interrupt 0', 3: 'PWM~ · interrupt 1',
  4: 'Digital', 5: 'PWM~', 6: 'PWM~', 7: 'Digital', 8: 'Digital', 9: 'PWM~', 10: 'PWM~ · SPI CS',
  11: 'PWM~ · SPI COPI', 12: 'SPI CIPO', 13: 'LED_BUILTIN · SPI SCK',
};
/** Printed name and what the pin does, for the tooltip. */
export function pinInfo(key, model = 'uno-r3') {
  if (/^\d+$/.test(key)) return { name: `D${key}`, fn: DIGITAL_FN[key] || 'Digital', pwm: PWM.has(key) };
  const base = key.replace(/\.\d$/, '');
  const fn = {
    GND: 'Ground, 0 V', AREF: 'Analog reference voltage in', SDA: 'I²C data, same line as A4', SCL: 'I²C clock, same line as A5',
    IOREF: 'Tells shields the logic level: 5 V', RESET: 'Pull low to restart the board', '3.3V': '3.3 V out',
    '5V': '5 V out, from USB or the regulator', VIN: 'Supply in, 6–24 V on R4, 7–12 V on R3',
    A0: model === 'uno-r4-wifi' ? 'Analog in · DAC out' : 'Analog in', A1: 'Analog in', A2: 'Analog in', A3: 'Analog in',
    A4: 'Analog in · I²C SDA', A5: 'Analog in · I²C SCL',
  }[base];
  return { name: base, fn: fn || '', pwm: false };
}

/**
 * Canonical pin key for whatever a model or a person wrote ("Pin 13", "D13", "gnd", "3V3"), or null.
 * GND has three holes; `near` ({u,v}) picks the closest one (default: the one by pin 13).
 */
export function pinKey(table, name, near) {
  if (name == null) return null;
  if (table.resolve) return table.resolve(name, near);   // a library board (partpins.js)
  let s = String(name).trim().replace(/^(?:pin|arduino pin|uno pin)\s*/i, '').replace(/\s+/g, '');
  if (!s) return null;
  if (/^d\d{1,2}$/i.test(s)) s = s.slice(1);
  const up = s.toUpperCase();
  if (/^\d{1,2}$/.test(up)) return table.pins[String(Number(up))] ? String(Number(up)) : null;
  if (up === 'GND' || up === 'GROUND') {
    const gnds = Object.keys(table.pins).filter(k => k.startsWith('GND'));
    if (!near) return table.aliases?.GND && table.pins[table.aliases.GND] ? table.aliases.GND : gnds[0];
    return gnds.sort((a, b) => d2(table.pins[a], near) - d2(table.pins[b], near))[0];
  }
  const alias = Object.entries(table.aliases || {}).find(([k]) => k.toUpperCase() === up)?.[1];
  if (alias && table.pins[alias]) return alias;
  const direct = Object.keys(table.pins).find(k => k.toUpperCase() === up);
  if (direct) return direct;
  if (up === '5V' || up === '+5V') return '5V';
  if (up === 'VIN') return 'VIN';
  return null;
}
const d2 = (a, b) => (a.u - b.u) ** 2 + (a.v - b.v) ** 2;

// ---------- breadboard (half size: 30 columns, rows a–j, two rails each side) ----------
export const BB = { cols: 30, w: 82.5, d: 54.6, h: 9.0 };
const ROW_Z = { a: 13.97, b: 11.43, c: 8.89, d: 6.35, e: 3.81, f: -3.81, g: -6.35, h: -8.89, i: -11.43, j: -13.97 };
/** Hole position in breadboard-local mm (x along columns, z toward rows a/e = front). */
export function bbHole(row, col) {
  const r = String(row).toLowerCase();
  if (ROW_Z[r] == null || col < 1 || col > BB.cols) return null;
  return { x: (col - 15.5) * PITCH, z: ROW_Z[r], key: `${r.toUpperCase()}${col}` };
}
/** Rail holes: side 'back' | 'front', pole '+' | '-', i 0..24 (groups of 5). */
export function bbRail(side, pole, i) {
  const x = (i + Math.floor(i / 5) - 14) * PITCH;
  const z = side === 'back' ? (pole === '+' ? -22.86 : -20.32) : (pole === '+' ? 22.86 : 20.32);
  return { x, z, key: `${side === 'back' ? 'top' : 'bottom'} ${pole} rail` };
}
export function allBbHoles() {
  const out = [];
  for (const r of Object.keys(ROW_Z)) for (let c = 1; c <= BB.cols; c++) out.push({ ...bbHole(r, c), kind: 'hole', row: r, col: c });
  for (const side of ['back', 'front']) for (const pole of ['+', '-']) for (let i = 0; i < 25; i++)
    out.push({ ...bbRail(side, pole, i), kind: 'rail', side, pole, i });
  return out;
}
export function bbInfo(h) {
  if (h.kind === 'rail') return { name: `Rail ${h.pole === '+' ? '+' : '−'}`, fn: h.pole === '+' ? 'Power rail: the whole line is connected' : 'Ground rail: the whole line is connected' };
  const half = 'abcde'.includes(h.row) ? 'A–E' : 'F–J';
  return { name: `Breadboard ${h.row.toUpperCase()}${h.col}`, fn: `Joined to column ${h.col}, holes ${half}` };
}

/** Breadboard hole named in text ("breadboard J10", "row 10 hole j", "+ rail"), or null. */
export function parseBreadboard(text, { force = false } = {}) {
  if (!text) return null;
  const s = String(text);
  const mentions = /bread\s?board|\bbb\b|\brow\b|\bhole\b|\brail\b|\bcolumn\b/i.test(s);
  if (!mentions && !force) return null;
  const rail = s.match(/(\+|plus|positive|red|power|5\s?v|−|-|minus|negative|ground|gnd|blue)\s*(?:power\s*)?rail/i);
  if (rail) {
    const pole = /\+|plus|positive|red|power|5\s?v/i.test(rail[1]) ? '+' : '-';
    return { ...bbRail('back', pole, 2), kind: 'rail', side: 'back', pole, i: 2 };
  }
  let m = s.match(/\b([a-j])\s?-?\s?(\d{1,2})\b/i) || s.match(/\b(\d{1,2})\s?-?\s?([a-j])\b/i);
  if (m) {
    const [row, col] = /\d/.test(m[1]) ? [m[2], Number(m[1])] : [m[1], Number(m[2])];
    const h = bbHole(row, col);
    if (h) return { ...h, kind: 'hole', row: row.toLowerCase(), col };
  }
  m = s.match(/\b(?:row|column)\s*(\d{1,2})\b/i);
  if (m) { const h = bbHole('j', Number(m[1])); if (h) return { ...h, kind: 'hole', row: 'j', col: Number(m[1]) }; }
  return mentions ? { x: 0, z: 0, key: 'breadboard', kind: 'area' } : null;
}

// ---------- named parts of the board (feature anchors, board mm) ----------
export const FEATURES = {
  'uno-r3': {
    usb: { u: 1.8, v: 37.8, h: 11, name: 'USB-B port' }, jack: { u: 5.2, v: 7.7, h: 11, name: 'Barrel jack' },
    chip: { u: 47.6, v: 16.5, h: 4.5, name: 'ATmega328P' }, usbchip: { u: 19.5, v: 38, h: 1.2, name: 'ATmega16U2' },
    led_l: { u: 27.9, v: 44.5, h: 0.8, name: 'L LED' }, led_tx: { u: 27.9, v: 41.9, h: 0.8, name: 'TX LED' },
    led_rx: { u: 27.9, v: 39.4, h: 0.8, name: 'RX LED' }, led_on: { u: 62.2, v: 44.2, h: 0.8, name: 'ON LED' },
    reset: { u: 6.2, v: 49.2, h: 3.5, name: 'Reset button' }, icsp: { u: 63.5, v: 27.94, h: 8.5, name: 'ICSP header' },
    crystal: { u: 21.5, v: 26.5, h: 3.6, name: '16 MHz crystal' }, reg: { u: 6.5, v: 18.5, h: 1.8, name: '5 V regulator' },
    board: { u: 34, v: 27, h: 0, name: 'Arduino UNO R3' },
  },
  'uno-r4-wifi': {
    usb: { u: 3.0, v: 37.2, h: 3.3, name: 'USB-C port' }, jack: { u: 5.2, v: 7.7, h: 11, name: 'Barrel jack' },
    chip: { u: 31.5, v: 17.5, h: 1.6, name: 'RA4M1' }, esp: { u: 18.5, v: 27.0, h: 3.2, name: 'ESP32-S3' },
    matrix: { u: 50.5, v: 29.0, h: 1.0, name: 'LED matrix' },
    led_l: { u: 27.9, v: 44.5, h: 0.8, name: 'L LED' }, led_tx: { u: 31.0, v: 44.5, h: 0.8, name: 'TX LED' },
    led_rx: { u: 34.0, v: 44.5, h: 0.8, name: 'RX LED' }, led_on: { u: 62.2, v: 44.2, h: 0.8, name: 'ON LED' },
    reset: { u: 6.2, v: 49.2, h: 2.5, name: 'Reset button' }, icsp: { u: 63.5, v: 27.94, h: 8.5, name: 'ICSP header' },
    qwiic: { u: 63.6, v: 14.8, h: 3, name: 'Qwiic connector' }, reg: { u: 6.5, v: 18.5, h: 1.8, name: '5 V regulator' },
    board: { u: 34, v: 27, h: 0, name: 'Arduino UNO R4 WiFi' },
  },
};
const FEATURE_WORDS = [
  [/usb|cable|computer|port/i, 'usb'], [/barrel|dc jack|power jack|wall adapter|9\s?v/i, 'jack'],
  [/matrix/i, 'matrix'], [/esp32|wi-?fi module|wireless/i, 'esp'], [/qwiic|stemma/i, 'qwiic'],
  [/16u2/i, 'usbchip'], [/wi-?fi|cyw43/i, 'wifi'], [/atmega|ra4m1|chip|processor|micro\s?controller|\bmcu\b|brain/i, 'chip'],
  [/\bL\b.*(?:led|light)|\bL$|built-?in led|led_builtin|L light/i, 'led_l'], [/\btx\b/i, 'led_tx'], [/\brx\b/i, 'led_rx'],
  [/\bon\b.*(?:led|light)|power (?:led|light)|^power$/i, 'led_on'], [/reset/i, 'reset'], [/icsp/i, 'icsp'],
  [/crystal|oscillator/i, 'crystal'], [/regulator/i, 'reg'], [/arduino|uno|the board|your board/i, 'board'],
  // library boards (parts3d.js); the UNO has none of these keys, so its matches above are unchanged
  [/hdmi\s?-?1|second hdmi|hdmi 2/i, 'hdmi1'], [/hdmi/i, 'hdmi0'], [/ethernet|rj-?45|\blan\b|network/i, 'ethernet'],
  [/usb\s?-?3|blue usb/i, 'usb3'], [/usb\s?-?2|black usb|usb-?a/i, 'usb2'], [/usb-?c|type-?c|power (?:port|in)/i, 'usbc'],
  [/audio|headphone|3\.5\s?mm/i, 'audio'], [/gpio|40-?pin|pin header/i, 'gpio'], [/micro\s?sd|sd card|\bsd\b/i, 'sd'],
  [/camera|\bcsi\b/i, 'csi'], [/display|\bdsi\b/i, 'dsi'], [/\bram\b|memory|lpddr/i, 'ram'], [/antenna/i, 'antenna'],
  [/wroom|esp-?12|module|shield/i, 'esp'], [/bootsel/i, 'bootsel'], [/\bboot\b|flash button|\bflash\b.*button/i, 'boot'],
  [/\ben\b|enable|\brst\b/i, 'en'], [/wi-?fi|cyw43|wireless|bluetooth/i, 'wifi'], [/\bflash\b/i, 'flash'], [/debug|\bswd\b/i, 'debug'],
  [/\bled\b|light/i, 'led_l'], [/raspberry|\bpi\b|pico|esp32|esp8266|nodemcu|nano|mega|devkit/i, 'board'],
];
/** Feature key named in a label, among `feats` (a library board's features) or the UNO model's. */
export function featureFor(label, model, feats) {
  const f = feats || FEATURES[model] || FEATURES['uno-r3'];
  for (const [re, k] of FEATURE_WORDS) if (re.test(label || '') && f[k]) return k;
  return null;
}
/** Pin named inside a free-text label ("Pin 13", "GND", "5V", "A0"), or null. */
export function pinFromLabel(table, label) {
  const s = String(label || '');
  if (table.resolve) {   // library board: try each pin-like word ("GPIO17", "pin 11", "D5", "GP15", "3V3", "GND")
    const re = /\b(?:GPIO\s?\d{1,2}|GP\d{1,2}|D\d{1,2}|A\d{1,2}|pin\s*\d{1,2}|3V3|3\.3\s?V|5\s?V|GND|VIN|VBUS|VSYS|SDA|SCL|TX\d?|RX\d?|VP|VN)\b/gi;
    for (const m of s.matchAll(re)) { const k = table.resolve(m[0]); if (k) return k; }
    return null;
  }
  let m = s.match(/\b(?:pin|d)\s*(\d{1,2})\b/i) || s.match(/^\s*(\d{1,2})\s*$/);
  if (m) return pinKey(table, m[1]);
  m = s.match(/\b(A[0-5])\b/); if (m) return pinKey(table, m[1]);
  m = s.match(/\b(5\s?V|3\.3\s?V|3V3|GND|VIN|AREF|IOREF|SDA|SCL)\b/i); if (m) return pinKey(table, m[1].replace(/\s/g, ''));
  return null;
}

/**
 * Which board this is, from a turn's `board`, a `part` event, or (last resort) the words in Mentor's marks.
 * `known`: extra model ids the twin can show (library boards); the words only ever pick an UNO, and not while
 * `current` is a library board.
 */
export function inferModel({ board, part, marks } = {}, known = [], current = null) {
  const ok = m => m === 'uno-r3' || m === 'uno-r4-wifi' || known.includes(m);
  if (board && !Array.isArray(board) && ok(board.model)) return board.model;
  if (part && ok(part.model)) return part.model;
  if (current && known.includes(current)) return null;
  const text = (marks || []).map(m => m.label).join(' ');
  if (/usb-?c|\br4\b|wi-?fi|matrix|esp32|ra4m1/i.test(text)) return 'uno-r4-wifi';
  if (/usb-?b|\br3\b|atmega|16u2/i.test(text)) return 'uno-r3';
  if (/arduino|\buno\b|\bpin\s*\d|\bgnd\b|\b5\s?v\b|\bA[0-5]\b/i.test(text)) return 'uno-r3';
  return null;
}
export const MODEL_NAMES = { 'uno-r3': 'Arduino UNO R3', 'uno-r4-wifi': 'Arduino UNO R4 WiFi' };

// ---------- homography: image point -> board mm, from the brain's 4 corners ----------
/** 3x3 homography (row-major, 9 numbers) mapping src[i] -> dst[i] for 4 point pairs, or null. */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}
function solve(A, b) {   // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
export function boardHomography(table, board) {
  const corners = Array.isArray(board) ? board : board?.corners;
  if (!Array.isArray(corners) || corners.length !== 4) return null;
  const dst = ['A', 'B', 'C', 'D'].map(k => table.corners[k]);
  return homography(corners.map(c => [Number(c[0]), Number(c[1])]), dst);
}

/**
 * One end of a mark → a target: {on:'pin', key} | {on:'bb', hole} | {on:'feature', key} | {on:'board', u, v} | null.
 * Order: explicit pin name, breadboard hole in the label, feature named in the label, pin named in the label,
 * then the image point mapped through the board corners.
 */
export function resolveEnd(table, model, { pin, label, x, y, other, H, preferBb = false }) {
  const near = other && other.u != null ? other : undefined;
  const k = pinKey(table, pin, near);
  if (k) return { on: 'pin', key: k };
  const bb = parseBreadboard(pin, { force: true }) || (preferBb ? parseBreadboard(label) : null);
  if (bb) return { on: 'bb', hole: bb };
  if (!preferBb) {
    const lp = pinFromLabel(table, label);
    if (lp) return { on: 'pin', key: pinKey(table, lp, near) };
    const f = featureFor(label, model, table.features);
    if (f && f !== 'board') return { on: 'feature', key: f };
  }
  if (H && x >= 0 && y >= 0) {
    const [u, v] = applyH(H, x, y);
    const bw = table.W || BOARD_W, bh = table.H || BOARD_H;
    if (u > -8 && u < bw + 2 && v > -2 && v < bh + 2) return { on: 'board', u, v };
  }
  return null;
}

/**
 * Mentor's marks for one turn → 3D targets. Wires give a `from` and `to`; a warn with pin2 is drawn as a red
 * "don't connect these" span. Everything stays data; the page only places geometry from it.
 */
export function resolveMarks(table, model, marks, board) {
  const H = boardHomography(table, board);
  const out = [];
  for (const m of Array.isArray(marks) ? marks : []) {
    const label = String(m.label || '').slice(0, 60);
    const kind = ['circle', 'arrow', 'wire', 'warn'].includes(m.kind) ? m.kind : 'circle';
    const hasEnd2 = (kind === 'wire' || kind === 'warn') && (m.pin2 || (m.x2 >= 0 && m.y2 >= 0) || /→|->|\bto\b/i.test(label));
    const from = resolveEnd(table, model, { pin: m.pin, label: label.split(/→|->|\bto\b/i)[0], x: m.x, y: m.y, H });
    let to = null;
    if (hasEnd2) {
      const tail = label.split(/→|->|\bto\b/i).slice(1).join(' ') || label;
      const fromUV = from?.on === 'pin' ? table.pins[from.key] : null;
      to = resolveEnd(table, model, { pin: m.pin2, label: tail, x: m.x2, y: m.y2, H, other: fromUV, preferBb: /bread|rail|\bhole\b|\brow\b/i.test(tail) })
        || resolveEnd(table, model, { pin: m.pin2, label: tail, x: m.x2, y: m.y2, H, other: fromUV });
      if (to && from && JSON.stringify(to) === JSON.stringify(from)) to = null;
    }
    out.push({ label, kind, from, to, pin: m.pin || '', pin2: m.pin2 || '' });
  }
  return out;
}

/** Human name of a target, for the wiring list ("13", "breadboard J10", "USB-C port"). */
export function targetName(table, model, t) {
  if (!t) return '?';
  if (t.on === 'pin') return table.info ? (/^\d+$/.test(t.key) ? t.key : table.info(t.key).name) : pinInfo(t.key, model).name.replace(/^D(\d)/, '$1');
  if (t.on === 'bb') return t.hole.kind === 'area' ? 'breadboard' : t.hole.kind === 'rail' ? `breadboard ${t.hole.key}` : `breadboard ${t.hole.key}`;
  if (t.on === 'feature') return (table.features || FEATURES[model] || FEATURES['uno-r3'])[t.key]?.name || t.key;
  return 'board';
}
