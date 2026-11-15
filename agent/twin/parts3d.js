// Procedural 3D boards from the part library (twin/parts.json, built from data/parts): Raspberry Pi 3/4/5, ESP32
// DevKit V1 / DevKitC, NodeMCU, Raspberry Pi Pico / Pico W, Arduino Nano and Mega 2560. The PCB comes from outline_mm,
// every header pin sits at its library position, and each family gets its signature parts. Same contract as buildUno
// (board.js): userData.holo on every mesh, six explode layers, pinPos / featurePos / uvPos, an invisible pick pad per pin.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { M, canvas, tex, seeded, textTexture } from './board.js';

const PCB_T = 1.6, PITCH = 2.54;
const FONT = 'Inter, "Inter Variable", ui-sans-serif, system-ui, sans-serif';
const SS = 22;   // silkscreen px per mm

const FAMILY = {
  'raspberry-pi-4': 'pi', 'esp32-devkit-v1': 'esp', 'esp32-devkitc': 'esp', 'nodemcu-esp8266': 'esp',
  'raspberry-pi-pico': 'pico', 'raspberry-pi-pico-w': 'pico', 'arduino-nano': 'nano', 'arduino-mega-2560': 'mega',
  custom: 'custom',   // a board the brain described by its headers (twin/custom.js): slab + header strips + labelled holes
};
/** Ids the twin can build in 3D. */
export const PART_MODELS = Object.keys(FAMILY);

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...o });
const P = {
  blue: mat(0x2b62d9, { roughness: 0.45 }), white: mat(0xf4f4f0, { roughness: 0.5 }), brown: mat(0x6b4a2b),
  module: mat(0x1d2026, { roughness: 0.5 }), green: mat(0x2e7d32), sub: mat(0x3a5a3c),
};
const ledMat = c => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.25, roughness: 0.3 });

// ---------- textures ----------
/** Top of a header strip: one square funnel (female) or a dark plastic square (male) per pin, at the real positions. */
function stripTop(pins, x0, y0, w, d, female, holo) {
  const s = 16, c = canvas(Math.max(8, Math.round(w * s)), Math.max(8, Math.round(d * s))), g = c.getContext('2d');
  g.fillStyle = holo ? '#000' : '#18181a'; g.fillRect(0, 0, c.width, c.height);
  for (const p of pins) {
    const X = (p.x_mm - x0) * s, Y = (p.y_mm - y0) * s;
    if (holo) {
      g.strokeStyle = 'rgba(160,240,255,0.9)'; g.lineWidth = 2; g.strokeRect(X - 0.45 * s, Y - 0.45 * s, 0.9 * s, 0.9 * s);
      g.strokeStyle = 'rgba(80,200,255,0.3)'; g.lineWidth = 1; g.strokeRect(X - 1.2 * s, Y - 1.2 * s, 2.4 * s, 2.4 * s);
    } else if (female) {
      const gr = g.createLinearGradient(X - s, Y - s, X + s, Y + s); gr.addColorStop(0, '#2c2c30'); gr.addColorStop(1, '#0c0c0d');
      g.fillStyle = gr; g.fillRect(X - 0.95 * s, Y - 0.95 * s, 1.9 * s, 1.9 * s);
      g.fillStyle = '#020203'; g.fillRect(X - 0.45 * s, Y - 0.45 * s, 0.9 * s, 0.9 * s);
    } else {
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 1; g.strokeRect(X - 1.25 * s, Y - 1.25 * s, 2.5 * s, 2.5 * s);
    }
  }
  return tex(c);
}

/** The module's top: dark solder mask with the PCB antenna meander in gold. */
function antennaTex(w, d, antennaMm, holo) {
  const s = 24, c = canvas(Math.round(w * s), Math.round(d * s)), g = c.getContext('2d');
  g.fillStyle = holo ? '#000' : '#1d2026'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = holo ? 'rgba(170,240,255,0.95)' : '#c9a65a'; g.lineWidth = 0.55 * s; g.lineJoin = 'miter';
  g.beginPath();
  const top = 0.8 * s, bot = (antennaMm - 0.8) * s, n = 7;
  let x = 1.2 * s; g.moveTo(x, bot);
  for (let i = 0; i < n; i++) { g.lineTo(x, top); x += (w - 2.4) * s / (2 * n); g.lineTo(x, top); g.lineTo(x, bot - 1.2 * s); x += (w - 2.4) * s / (2 * n); g.lineTo(x, bot - 1.2 * s); }
  g.stroke();
  return tex(c);
}

/** Silkscreen: solder mask colour, faint seeded traces, pin labels next to long headers, a few words of print. */
function silkscreen(table, look, holo) {
  const { W, H } = table;
  const c = canvas(Math.round(W * SS), Math.round(H * SS)), g = c.getContext('2d');
  const X = x => x * SS, Y = y => y * SS;
  const ink = holo ? 'rgba(190,245,255,0.95)' : look.ink || '#f4f7f6';
  g.fillStyle = holo ? '#000' : look.pcb; g.fillRect(0, 0, c.width, c.height);
  const rnd = seeded(look.seed || 5);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = holo ? 'rgba(60,200,255,0.2)' : look.trace; g.lineWidth = 0.25 * SS;
  for (let i = 0; i < Math.round(W * H / 70); i++) {
    let x = 3 + rnd() * (W - 6), y = 3 + rnd() * (H - 6); g.beginPath(); g.moveTo(X(x), Y(y));
    for (let k = 0; k < 3; k++) { if (rnd() < 0.5) x += (rnd() - 0.5) * W * 0.35; else y += (rnd() - 0.5) * H * 0.35; x = Math.min(W - 2, Math.max(2, x)); y = Math.min(H - 2, Math.max(2, y)); g.lineTo(X(x), Y(y)); }
    g.stroke();
  }
  // pads around every pin (tin / gold ring), castellations on the Pico
  for (const p of Object.values(table.pins)) {
    g.beginPath(); g.arc(X(p.x_mm), Y(p.y_mm), 0.85 * SS, 0, Math.PI * 2); g.fillStyle = holo ? 'rgba(140,235,255,0.45)' : look.pad || '#c9b26a'; g.fill();
    if (look.castellated) {
      const ex = p.x_mm < W / 2 ? 0 : W;
      g.beginPath(); g.arc(X(ex), Y(p.y_mm), 0.8 * SS, 0, Math.PI * 2); g.fill();
    }
  }
  const text = (t, x, y, size, { weight = 600, align = 'center', rot = 0, color = ink } = {}) => {
    g.save(); g.translate(X(x), Y(y)); g.rotate(rot); g.font = `${weight} ${size * SS}px ${FONT}`; g.fillStyle = color;
    g.textAlign = align; g.textBaseline = 'middle'; g.fillText(t, 0, 0); g.restore();
  };
  // pin labels: next to every header of 6+ pins, facing into the board
  if (look.labels !== false) for (const h of table.headers) {
    if ((h.pins.length < 6 && !look.labelAll) || h.name === 'J8') continue;
    const ps = h.pins.map(k => table.pins[k]).filter(Boolean);
    for (const k of h.pins) {
      const p = table.pins[k]; if (!p) continue;
      const name = k.replace(/\.\d+$/, ''), size = Math.min(1.05, look.labelSize || 1.0);
      if (h.orientation === 'column') {
        const left = p.x_mm < W / 2;
        text(name, p.x_mm + (left ? 1.7 : -1.7), p.y_mm, size, { align: left ? 'left' : 'right', weight: 600 });
      } else {
        const top = ps[0].y_mm < H / 2;
        text(name, p.x_mm, p.y_mm + (top ? 1.7 : -1.7), size, { align: top ? 'right' : 'left', rot: -Math.PI / 2 });
      }
    }
  }
  for (const t of look.print || []) text(t[0], t[1], t[2], t[3], { weight: t[4] || 700, rot: t[5] || 0 });
  for (const [x, y, r] of look.holes || []) {
    g.beginPath(); g.arc(X(x), Y(y), (r + 1.1) * SS, 0, Math.PI * 2); g.fillStyle = holo ? 'rgba(140,235,255,0.5)' : '#c8ccc9'; g.fill();
  }
  if (look.draw) look.draw(g, X, Y, ink, holo);
  return tex(c);
}

function outlineShape(W, H, r, holes) {
  const s = new THREE.Shape();   // shape (x, v) with v = H - y, so it maps onto the u/v board frame
  s.moveTo(r, 0); s.lineTo(W - r, 0); s.quadraticCurveTo(W, 0, W, r); s.lineTo(W, H - r); s.quadraticCurveTo(W, H, W - r, H);
  s.lineTo(r, H); s.quadraticCurveTo(0, H, 0, H - r); s.lineTo(0, r); s.quadraticCurveTo(0, 0, r, 0);
  for (const [x, y, rr] of holes) { const h = new THREE.Path(); h.absarc(x, H - y, rr, 0, Math.PI * 2, true); s.holes.push(h); }
  return s;
}

// ---------- the builder ----------
/**
 * One board from the library, in its own group. Local frame: x = x_mm − W/2, z = y_mm − H/2 (the drawing's top edge at
 * the back), y up, PCB bottom at y = lift (boards with pins pointing down stand on them, like on a breadboard).
 * @param {ReturnType<import('./partpins.js').partTable>} table
 * @param {string} id part id
 */
export function buildPart(table, id) {
  const fam = FAMILY[id];
  if (!fam) throw new Error(`no 3D model for ${id}`);
  const { W, H } = table;
  const down = table.header === 'maleDown';
  const lift = down ? 11 : 0;
  const group = new THREE.Group(); group.name = table.name;
  const layers = {};
  for (const name of ['pcb', 'parts', 'leds', 'chip', 'ports', 'headers']) { const l = new THREE.Group(); l.name = name; layers[name] = l; group.add(l); }
  const L = (x, h, y) => new THREE.Vector3(x - W / 2, lift + PCB_T + h, y - H / 2);
  const add = (layer, geom, material, holo, x, h, y, name) => {
    const m = new THREE.Mesh(geom, material); m.position.copy(L(x, h, y)); m.castShadow = true; m.receiveShadow = true;
    m.userData.holo = holo; if (name) m.name = name; layers[layer].add(m); return m;
  };
  /** Box with its bottom at h0 above the PCB top: w along x, hh up, d along y (drawing mm). */
  const box = (layer, w, hh, d, material, holo, x, y, h0 = 0, name, round = 0) =>
    add(layer, round ? new RoundedBoxGeometry(w, hh, d, 2, round) : new THREE.BoxGeometry(w, hh, d), material, holo, x, h0 + hh / 2, y, name);
  const child = (parent, geom, material, holo, x, y, z, name) => {
    const m = new THREE.Mesh(geom, material); m.position.set(x, y, z); m.userData.holo = holo; if (name) m.name = name; parent.add(m); return m;
  };
  const features = {};
  const feature = (key, x, y, h, name, r = 3) => { features[key] = { x, y, h, name, r, u: x, v: H - y }; };
  feature('board', W / 2, H / 2, 0, table.name, Math.max(W, H) * 0.42);

  const look = LOOKS[fam](id, table);

  // PCB
  const pcbGeom = new THREE.ExtrudeGeometry(outlineShape(W, H, look.radius ?? 1, look.holes || []), { depth: PCB_T, bevelEnabled: false, curveSegments: 12 });
  pcbGeom.rotateX(-Math.PI / 2); pcbGeom.translate(-W / 2, lift, H / 2);
  const uv = pcbGeom.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / W, uv.getY(i) / H);
  const pcb = new THREE.Mesh(pcbGeom, [
    new THREE.MeshStandardMaterial({ map: silkscreen(table, look, false), roughness: 0.5, metalness: 0.05 }),
    mat(look.edge ?? 0x0c3a20, { roughness: 0.7 }),
  ]);
  pcb.name = 'PCB'; pcb.receiveShadow = true; pcb.castShadow = true;
  pcb.userData.holo = 'pcb'; pcb.userData.holoMap = silkscreen(table, look, true);
  layers.pcb.add(pcb);

  // headers, from the library's header groups (each pin once)
  const seen = new Set(), up = new Set(look.pinsUp || []);
  const pinTop = k => (up.has(k) ? 6 : table.headerTop);
  const pinsUp = [], pinsDown = [];
  for (const h of table.headers) {
    const keys = h.pins.filter(k => table.pins[k] && !seen.has(k));
    if (!keys.length) continue;
    keys.forEach(k => seen.add(k));
    const ps = keys.map(k => table.pins[k]);
    const x0 = Math.min(...ps.map(p => p.x_mm)) - PITCH / 2, x1 = Math.max(...ps.map(p => p.x_mm)) + PITCH / 2;
    const y0 = Math.min(...ps.map(p => p.y_mm)) - PITCH / 2, y1 = Math.max(...ps.map(p => p.y_mm)) + PITCH / 2;
    const w = x1 - x0, d = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const isUp = keys.every(k => up.has(k));
    if (table.header === 'female') {
      const top = new THREE.MeshStandardMaterial({ map: stripTop(ps, x0, y0, w, d, true, false), roughness: 0.55 });
      const m = box('headers', w, 8.5, d, [M.black, M.black, top, M.black, M.black, M.black], 'body', cx, cy, 0, `Header ${h.name}`);
      m.userData.holoMap = stripTop(ps, x0, y0, w, d, true, true);
    } else if (table.header === 'maleUp' || isUp) {
      const top = new THREE.MeshStandardMaterial({ map: stripTop(ps, x0, y0, w, d, false, false), roughness: 0.55 });
      const m = box('headers', w, 2.5, d, [M.black, M.black, top, M.black, M.black, M.black], 'body', cx, cy, 0, `Header ${h.name}`);
      m.userData.holoMap = stripTop(ps, x0, y0, w, d, false, true);
      for (const k of keys) pinsUp.push([table.pins[k], pinTop(k)]);
    } else {
      // pins down into a breadboard: the plastic under the PCB, the pins below it, solder joints on top
      const m = add('headers', new THREE.BoxGeometry(w, 2.5, d), M.black, 'body', cx, -PCB_T - 1.25, cy, `Header ${h.name}`);
      void m;
      for (const k of keys) pinsDown.push(table.pins[k]);
    }
  }
  const o = new THREE.Object3D();
  if (pinsUp.length) {
    const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 1, 0.64), M.gold, pinsUp.length); pins.userData.holo = 'metal'; pins.name = 'Header pins';
    pinsUp.forEach(([p, top], i) => { o.position.set(p.x_mm - W / 2, lift + PCB_T + top / 2, p.y_mm - H / 2); o.scale.set(1, top + 3, 1); o.position.y -= 1.5; o.updateMatrix(); pins.setMatrixAt(i, o.matrix); });
    layers.headers.add(pins);
  }
  if (pinsDown.length) {
    const len = lift + PCB_T + 0.9;
    const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, len, 0.64), M.gold, pinsDown.length); pins.userData.holo = 'metal'; pins.name = 'Header pins';
    const joints = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.55, 0.95, 0.9, 12), M.tin, pinsDown.length); joints.userData.holo = 'metal'; joints.name = 'Solder joints';
    o.scale.set(1, 1, 1);
    pinsDown.forEach((p, i) => {
      o.position.set(p.x_mm - W / 2, len / 2, p.y_mm - H / 2); o.updateMatrix(); pins.setMatrixAt(i, o.matrix);
      o.position.set(p.x_mm - W / 2, lift + PCB_T + 0.45, p.y_mm - H / 2); o.updateMatrix(); joints.setMatrixAt(i, o.matrix);
    });
    layers.headers.add(pins, joints);
  }

  const kit = { add, box, child, feature, L, layers, W, H, lift, table, id };
  look.build(kit);

  // pin picking: one invisible pad per pin, on top of it
  const pickKeys = Object.keys(table.pins);
  const pick = new THREE.InstancedMesh(new THREE.BoxGeometry(2.3, 1.2, 2.3), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), pickKeys.length);
  pick.userData.pick = 'pin'; pick.userData.noExport = true;
  o.scale.set(1, 1, 1); o.rotation.set(0, 0, 0);
  pickKeys.forEach((k, i) => { const p = table.pins[k]; o.position.copy(L(p.x_mm, pinTop(k), p.y_mm)); o.updateMatrix(); pick.setMatrixAt(i, o.matrix); });
  layers.headers.add(pick);

  return {
    group, layers, model: id, pick, pickKeys, W, H, lift, features, tags: look.tags, layerNames: look.layers, sub: look.sub,
    pinInfo: k => table.info(k),
    pinPos: k => { const p = table.pins[k]; return p ? L(p.x_mm, pinTop(k), p.y_mm) : null; },
    featurePos: k => (features[k] ? L(features[k].x, features[k].h, features[k].y) : null),
    uvPos: (u, v, h = 0.2) => L(u, h, H - v),
  };
}

// ---------- shared pieces ----------
function microUsb(k, x, y, { facing = 'down', w = 7.6, d = 5.6, h = 2.7, over = 1.1 } = {}) {
  const yy = facing === 'down' ? k.H - d / 2 + over : d / 2 - over;
  const usb = k.box('ports', w, h, d, M.metal, 'metal', x, yy, 0, 'micro-USB port', 0.5);
  k.child(usb, new THREE.BoxGeometry(w - 1.6, h - 1.2, 0.3), M.dark, 'dark', 0, 0, facing === 'down' ? d / 2 : -d / 2);
  k.feature('usb', x, facing === 'down' ? k.H - 1 : 1, h, 'micro-USB port', 4.5);
  return usb;
}
function tactile(k, x, y, name, { cap = M.black, w = 4, d = 3, round = false } = {}) {
  k.box('parts', w, 1.4, d, M.tin, 'metal', x, y, 0, name);
  if (round) k.add('parts', new THREE.CylinderGeometry(1.25, 1.25, 1.0, 20), cap, 'body', x, 1.9, y, `${name} cap`);
  else k.box('parts', w * 0.45, 0.9, d * 0.55, cap, 'body', x, y, 1.4, `${name} cap`);
}
function ic(k, w, d, x, y, name, lines, { h = 0.9, rot = 0, legs = 0, layer = 'chip' } = {}) {
  const top = new THREE.MeshStandardMaterial({ map: textTexture(lines, 256, Math.round(256 * d / w) || 256, { size: 30, color: '#8d8d93' }), roughness: 0.45 });
  const m = k.box(layer, w, h, d, [M.black, M.black, top, M.black, M.black, M.black], 'body', x, y, legs ? 0.15 : 0, name);
  m.rotation.y = rot;
  if (legs) {
    const n = legs / 4, g = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.15, 0.9), M.metal, legs); g.userData.holo = 'metal'; g.name = `${name} legs`;
    const o = new THREE.Object3D(); let i = 0;
    for (let side = 0; side < 4; side++) for (let j = 0; j < n; j++) {
      const t = (j - (n - 1) / 2) * (w * 0.8 / n), a = side * Math.PI / 2, r = w / 2 + 0.35;
      o.position.set(Math.cos(a) * r - Math.sin(a) * t, 0.1, Math.sin(a) * r + Math.cos(a) * t); o.rotation.y = -a + Math.PI / 2; o.updateMatrix(); g.setMatrixAt(i++, o.matrix);
    }
    g.position.copy(k.L(x, 0, y)); g.rotation.y = rot; k.layers[layer].add(g);
  }
  return m;
}
function led(k, x, y, color, name, blink = false) {
  const m = k.box('leds', 1.4, 0.6, 0.8, ledMat(color), 'led', x, y, 0, name);
  if (blink) m.userData.blink = true; else { m.material.emissiveIntensity = 1.4; m.userData.lit = true; }
  return m;
}
function moduleCan(k, { x, y0, w, d, antenna, can, text }) {
  // ESP-WROOM-32 / ESP-12: a small PCB with the antenna meander at the board's end, a tin can over the radio
  const top = new THREE.MeshStandardMaterial({ map: antennaTex(w, d, antenna, false), roughness: 0.5 });
  const m = k.box('chip', w, 0.8, d, [P.module, P.module, top, P.module, P.module, P.module], 'body', x, y0 + d / 2, 0, 'Module PCB');
  m.userData.holoMap = antennaTex(w, d, antenna, true);
  const lid = new THREE.MeshStandardMaterial({ map: textTexture(text, 256, Math.round(256 * can[1] / can[0]), { bg: '#c5c9cd', color: '#4a4d52', size: 26 }), metalness: 0.85, roughness: 0.35 });
  k.box('chip', can[0], 2.4, can[1], [M.tin, M.tin, lid, M.tin, M.tin, M.tin], 'metal', x, y0 + antenna + 0.6 + can[1] / 2, 0.8, 'Shield can', 0);
  k.feature('esp', x, y0 + antenna + 0.6 + can[1] / 2, 3.2, `${text[0]} module`, Math.max(can[0], can[1]) * 0.6);
  k.feature('antenna', x, y0 + antenna / 2, 0.8, 'PCB antenna', w * 0.5);
}

// ---------- the families ----------
const LOOKS = {
  /** A described board: plain green slab, its header strips, every hole labelled. Nothing invented on top. */
  custom: (id, table) => {
    const n = Object.keys(table.pins).length, hs = table.headers.length;
    return {
      pcb: '#1e5a3c', trace: 'rgba(8,45,25,0.5)', pad: '#d6bc64', edge: 0x163f2b, radius: 1.2, seed: 41, labelAll: true,
      labelSize: Math.min(1.0, Math.max(0.6, Math.min(table.W, table.H) / 30)),
      print: [[table.name.slice(0, 28), table.W / 2, table.H / 2, Math.max(1.2, Math.min(3, table.W / 14)), 700]],
      sub: `Custom board: ${n} pin${n === 1 ? '' : 's'} on ${hs} header${hs === 1 ? '' : 's'}, positions from Ody`,
      tags: [],
      layers: { pcb: 'Circuit board', headers: `${hs} header${hs === 1 ? '' : 's'}, ${n} pins` },
      build() {},
    };
  },
  /** Raspberry Pi 3 / 4 / 5 (drawn as the Pi 4 Model B). */
  pi: () => ({
    pcb: '#2a7c45', trace: 'rgba(10,60,30,0.55)', pad: '#cdb86c', edge: 0x175a2e, radius: 3, seed: 11, labels: false,
    holes: [[3.5, 3.5, 1.375], [61.5, 3.5, 1.375], [3.5, 52.5, 1.375], [61.5, 52.5, 1.375]],
    print: [['Raspberry Pi 4 Model B', 30, 11.5, 2.0, 700], ['© Raspberry Pi 2018', 30, 14.4, 1.1, 500], ['J8', 4.8, 5.3, 1.2, 700]],
    sub: '40-pin GPIO, 2 × micro-HDMI, USB 3, Gigabit Ethernet',
    tags: [['gpio', 'GPIO 40-pin'], ['usbc', 'USB-C power'], ['hdmi0', 'micro-HDMI'], ['ethernet', 'Ethernet'], ['usb3', 'USB 3.0'], ['usb2', 'USB 2.0'], ['chip', 'BCM2711']],
    layers: { pcb: 'Circuit board', parts: 'Wi-Fi, power chip, camera and display ports', leds: 'Power and activity LEDs', chip: 'BCM2711 SoC, RAM, USB controller', ports: 'USB, Ethernet, USB-C, micro-HDMI, audio', headers: '40-pin GPIO header' },
    build(k) {
      const { box, child, feature } = k;
      // SoC with its metal lid, RAM, USB controller, PMIC, the Wi-Fi can
      box('chip', 16.5, 0.7, 16.5, P.sub, 'body', 29, 32, 0, 'SoC substrate');
      box('chip', 14.5, 1.8, 14.5, M.metal, 'metal', 29, 32, 0.7, 'BCM2711 SoC', 0.6);
      feature('chip', 29, 32, 2.5, 'BCM2711 SoC', 10);
      ic(k, 14, 10, 46, 32, 'LPDDR4 RAM', ['MICRON', 'D9WHZ LPDDR4'], { h: 1.1 }); feature('ram', 46, 32, 1.1, 'LPDDR4 RAM', 8);
      ic(k, 6, 6, 60, 33, 'VL805 USB 3 controller', ['VL805'], { h: 0.9 });
      ic(k, 5, 5, 14, 41, 'Power chip (PMIC)', ['MXL7704'], { h: 0.8, layer: 'parts' });
      box('parts', 10.5, 1.5, 12, M.tin, 'metal', 10, 17, 0, 'Wi-Fi / Bluetooth can', 0.3); feature('wifi', 10, 17, 1.5, 'Wi-Fi and Bluetooth', 7);
      // display (DSI) and camera (CSI) ribbon connectors
      box('parts', 3.6, 5.5, 22, M.black, 'body', 2.2, 30, 0, 'Display connector (DSI)'); box('parts', 1.2, 1.0, 21, P.brown, 'body', 2.6, 30, 5.5);
      feature('dsi', 2.2, 30, 5.5, 'Display connector (DSI)', 6);
      box('parts', 22, 5.5, 3.6, M.black, 'body', 45, 45.5, 0, 'Camera connector (CSI)'); box('parts', 21, 1.0, 1.2, P.brown, 'body', 45, 45.1, 5.5);
      feature('csi', 45, 45.5, 5.5, 'Camera connector (CSI)', 6);
      // PoE header 2x2
      box('headers', 5.08, 2.5, 5.08, M.black, 'body', 64.5, 9.5, 0, 'PoE header');
      for (const dx of [-1.27, 1.27]) for (const dy of [-1.27, 1.27]) box('headers', 0.64, 8, 0.64, M.gold, 'metal', 64.5 + dx, 9.5 + dy, 0);
      // right edge: Ethernet, USB 3 (blue), USB 2 (black)
      const eth = box('ports', 21, 13.5, 16, M.metal, 'metal', 85 - 10.5 + 2.6, 10.25, 0, 'Ethernet port', 0.4);
      child(eth, new THREE.BoxGeometry(0.4, 9, 12), M.dark, 'dark', 10.55, -1.2, 0);
      child(eth, new THREE.BoxGeometry(0.3, 1.2, 2.2), ledMat(0x39ff6a), 'led', 10.6, 5, -4.6); child(eth, new THREE.BoxGeometry(0.3, 1.2, 2.2), ledMat(0xffb000), 'led', 10.6, 5, 4.6);
      feature('ethernet', 85, 10.25, 7, 'Gigabit Ethernet', 9);
      for (const [y, tongue, key, name] of [[29, P.blue, 'usb3', 'USB 3.0 ports'], [47, M.black, 'usb2', 'USB 2.0 ports']]) {
        const u = box('ports', 17.5, 16, 14.5, M.metal, 'metal', 85 - 8.75 + 2.6, y, 0, name, 0.4);
        for (const hy of [-3.9, 3.9]) {
          child(u, new THREE.BoxGeometry(0.4, 5.6, 12.4), M.dark, 'dark', 8.6, hy, 0);
          child(u, new THREE.BoxGeometry(0.5, 1.8, 11.4), tongue, 'body', 8.4, hy - 0.9, 0);
        }
        feature(key, 85, y, 8, name, 9);
      }
      // bottom edge: USB-C power, 2 micro-HDMI, audio
      const c = box('ports', 8.9, 3.2, 7.4, M.metal, 'metal', 11.2, 56 - 3.7 + 1.2, 0, 'USB-C power port', 1.4);
      child(c, new THREE.BoxGeometry(7.2, 1.6, 0.3), M.dark, 'dark', 0, 0, 3.6);
      feature('usbc', 11.2, 56, 3.2, 'USB-C power', 5);
      for (const [x, key, n] of [[26, 'hdmi0', 'micro-HDMI 0'], [39.5, 'hdmi1', 'micro-HDMI 1']]) {
        const hd = box('ports', 6.6, 3.0, 7.6, M.metal, 'metal', x, 56 - 3.8 + 1.3, 0, n, 0.4);
        child(hd, new THREE.BoxGeometry(5.4, 1.6, 0.3), M.dark, 'dark', 0, 0, 3.75);
        feature(key, x, 56, 3, n, 4.5);
      }
      box('ports', 7, 6, 12, M.black, 'body', 53.5, 56 - 6 + 2.2, 0, 'Audio jack');
      k.add('ports', new THREE.CylinderGeometry(3, 3, 2.6, 24).rotateX(Math.PI / 2), M.black, 'body', 53.5, 3, 56 + 2.2 + 1.2, 'Audio jack sleeve');
      feature('audio', 53.5, 56, 3, 'Audio / video jack', 4.5);
      // microSD slot underneath, at the left edge
      k.add('ports', new THREE.BoxGeometry(12, 1.4, 11.5), M.metal, 'metal', 6.5, -PCB_T - 0.7, 28, 'microSD slot');
      feature('sd', 1, 28, -1, 'microSD card slot', 5);
      led(k, 3.5, 44.5, 0xff3b30, 'PWR LED'); led(k, 3.5, 47, 0x39ff6a, 'ACT LED', true);
      feature('led_on', 3.5, 44.5, 0.6, 'Power LED', 2); feature('led_l', 3.5, 47, 0.6, 'Activity LED', 2);
      feature('gpio', 32.5, 4.8, 8.5, '40-pin GPIO header', 4);
    },
  }),

  /** ESP32 DevKit V1 / DevKitC and NodeMCU ESP8266: a module with an antenna, micro-USB, two buttons. */
  esp: (id, table) => {
    const W = table.W, H = table.H;
    const v = {
      'esp32-devkit-v1': { mod: [18, 25.5, 0.5], antenna: 6, can: [15.8, 17.6], text: ['ESP-WROOM-32', 'ESPRESSIF'], buttons: [[5.2, 48.8, 'EN'], [23, 48.8, 'BOOT']], print: [['ESP32 DEVKIT V1', W / 2, 30, 1.6], ['DOIT', W / 2, 32.4, 1.2]], pcb: '#17181b', name: 'ESP32 DevKit V1' },
      'esp32-devkitc': { mod: [18, 25.5, 0], antenna: 6, can: [15.8, 17.6], text: ['ESP32-WROOM-32', 'ESPRESSIF'], buttons: [[6.4, 51.4, 'EN'], [21.5, 51.4, 'BOOT']], print: [['ESP32-DevKitC V4', W / 2, 29.5, 1.5]], pcb: '#202226', name: 'ESP32-DevKitC' },
      'nodemcu-esp8266': { mod: [16, 24, 0.3], antenna: 6.5, can: [12, 15], text: ['ESP8266MOD', 'AI-THINKER'], buttons: [[5.4, 45.6, 'RST'], [19.4, 45.6, 'FLASH']], print: [['NodeMCU', W / 2, 28.5, 1.8], ['ESP-12E', W / 2, 31, 1.1]], pcb: '#18191c', name: 'NodeMCU' },
    }[id];
    const bottomRow = Math.max(...Object.values(table.pins).map(p => p.y_mm));
    return {
      pcb: v.pcb, trace: 'rgba(60,62,70,0.6)', pad: '#c8ccd0', edge: 0x101114, radius: 1.0, seed: 17, print: v.print,
      holes: id === 'esp32-devkit-v1' ? [[2.6, 2.6, 1.3], [25.6, 2.6, 1.3], [2.6, 51.5, 1.3], [25.6, 51.5, 1.3]] : [],
      sub: id === 'nodemcu-esp8266' ? 'ESP-12E module, micro-USB, RST + FLASH buttons' : `ESP32 module with PCB antenna, micro-USB, ${v.buttons.map(b => b[2]).join(' + ')}`,
      tags: [['esp', v.text[0]], ['usb', 'micro-USB'], ['boot', v.buttons[1][2]]],
      layers: { pcb: 'Circuit board', parts: 'Regulator and buttons', leds: 'Power and user LEDs', chip: `${v.text[0]} module`, ports: 'micro-USB', headers: `${Object.keys(table.pins).length} pins` },
      build(k) {
        const [mw, md, my] = v.mod;
        moduleCan(k, { x: W / 2, y0: my, w: mw, d: md, antenna: v.antenna, can: v.can, text: v.text });
        microUsb(k, W / 2, H, { facing: 'down' });
        const [b1, b2] = v.buttons;
        tactile(k, b1[0], b1[1], `${b1[2]} button`); tactile(k, b2[0], b2[1], `${b2[2]} button`);
        k.feature('en', b1[0], b1[1], 2.3, `${b1[2]} button`, 2.6); k.feature('boot', b2[0], b2[1], 2.3, `${b2[2]} button`, 2.6);
        k.feature('reset', b1[0], b1[1], 2.3, `${b1[2]} button`, 2.6);
        const midY = (my + md + Math.min(bottomRow, H - 6)) / 2 + 3;
        ic(k, 6.5, 3.5, W / 2 - 6, midY, '3.3 V regulator', ['AMS1117'], { h: 1.6, layer: 'parts' }); k.feature('reg', W / 2 - 6, midY, 1.6, '3.3 V regulator', 3);
        ic(k, 5, 5, W / 2 + 4.5, midY, 'USB-serial chip', [id === 'esp32-devkitc' ? 'CP2102N' : 'CP2102'], { h: 0.9 });
        led(k, W / 2 - 3, H - 9, 0xff3b30, 'Power LED'); led(k, W / 2 + 3, H - 9, 0x3b7bff, 'User LED (GPIO2)', id !== 'nodemcu-esp8266');
        k.feature('led_on', W / 2 - 3, H - 9, 0.6, 'Power LED', 2); k.feature('led_l', W / 2 + 3, H - 9, 0.6, 'Blue LED', 2);
      },
    };
  },

  /** Raspberry Pi Pico / Pico W. */
  pico: id => {
    const w = id === 'raspberry-pi-pico-w';
    return {
      pcb: '#1f7039', trace: 'rgba(8,55,25,0.55)', pad: '#d6bc64', edge: 0x175a2e, radius: 1.0, seed: 23, castellated: true, labelSize: 0.85,
      holes: [[4.75, 2.0, 1.05], [16.15, 2.0, 1.05], [4.75, 50.75, 1.05], [16.15, 50.75, 1.05]],
      print: [[w ? 'Raspberry Pi Pico W' : 'Raspberry Pi Pico', 10.45, 31.5, 1.15, 700], ['© 2020', 10.45, 33.3, 0.8, 500], ['BOOTSEL', 10.45, 14.6, 0.75, 600], ['DEBUG', 10.45, 49.3, 0.75, 600]],
      draw(g, X, Y, ink, holo) {   // the 3 debug pads, and the Pico W's antenna
        for (const x of [8.0, 10.45, 12.9]) { g.beginPath(); g.arc(X(x), Y(51.4), 0.7 * SS, 0, Math.PI * 2); g.fillStyle = holo ? 'rgba(140,235,255,0.6)' : '#d6bc64'; g.fill(); }
        if (w) { g.strokeStyle = holo ? 'rgba(170,240,255,0.9)' : '#d6bc64'; g.lineWidth = 0.4 * SS; g.beginPath(); g.moveTo(X(5), Y(47.4)); for (let i = 0; i < 6; i++) { g.lineTo(X(5 + i * 2.2), Y(i % 2 ? 47.4 : 45.6)); } g.stroke(); }
      },
      sub: w ? 'RP2040, Wi-Fi (CYW43439), micro-USB, BOOTSEL' : 'RP2040, micro-USB, BOOTSEL button, castellated pins',
      tags: [['usb', 'micro-USB'], ['bootsel', 'BOOTSEL'], ['chip', 'RP2040'], ...(w ? [['wifi', 'Wi-Fi']] : [])],
      layers: { pcb: 'Circuit board', parts: 'Flash, crystal, regulator', leds: 'User LED', chip: w ? 'RP2040 and the Wi-Fi chip' : 'RP2040 microcontroller', ports: 'micro-USB', headers: '40 castellated pins' },
      build(k) {
        microUsb(k, 10.45, 0, { facing: 'up', w: 8, d: 5.4, h: 2.8, over: 1.3 });
        tactile(k, 10.45, 11.5, 'BOOTSEL button', { cap: P.white, w: 4.4, d: 3.4, round: true }); k.feature('bootsel', 10.45, 11.5, 2.4, 'BOOTSEL button', 2.6);
        ic(k, 7, 7, 10.45, 25, 'RP2040 microcontroller', ['RP2-B2', 'RP2040'], { h: 0.9, legs: 56 }); k.feature('chip', 10.45, 25, 0.9, 'RP2040', 5.5);
        ic(k, 4, 5, 10.45, 18, 'QSPI flash', ['W25Q16'], { h: 0.8, layer: 'parts' }); k.feature('flash', 10.45, 18, 0.8, '2 MB flash', 3);
        k.box('parts', 3.2, 0.8, 2.5, M.tin, 'metal', 6.8, 34, 0, '12 MHz crystal', 0.3);
        k.box('parts', 3.4, 1.6, 3.4, M.black, 'body', 14.2, 38.5, 0, 'Inductor', 0.6); ic(k, 2.8, 2.8, 9.4, 38.5, 'Buck-boost regulator', ['RT6150'], { h: 0.7, layer: 'parts' });
        k.feature('debug', 10.45, 51.4, 0.2, 'Debug pads (SWD)', 3);
        if (w) { k.box('chip', 10, 1.4, 10.5, M.tin, 'metal', 10.45, 41.5, 0, 'Wi-Fi chip can (CYW43439)', 0.3); k.feature('wifi', 10.45, 41.5, 1.4, 'Wi-Fi chip (CYW43439)', 7); k.feature('antenna', 10.45, 46.5, 0.2, 'Antenna', 6); }
        else { led(k, 5.6, 4.6, 0x39ff6a, 'User LED (GP25)', true); k.feature('led_l', 5.6, 4.6, 0.6, 'LED (GP25)', 2); }
      },
    };
  },

  /** Arduino Nano. */
  nano: () => ({
    pcb: '#145ea8', trace: 'rgba(5,40,85,0.55)', pad: '#d6bc64', edge: 0x0c3c70, radius: 0.6, seed: 29, labelSize: 0.95,
    print: [['NANO', 33.5, 8.9, 1.6, 800, -Math.PI / 2]], pinsUp: ['12.2', '5V.2', '13.2', '11.2', 'RESET.3', 'GND.3'],
    sub: 'ATmega328P, mini-USB, 30 pins + ICSP',
    tags: [['usb', 'mini-USB'], ['chip', 'ATmega328P'], ['icsp', 'ICSP']],
    layers: { pcb: 'Circuit board', parts: 'Regulator, crystal, reset', leds: 'L, PWR, TX and RX LEDs', chip: 'ATmega328P', ports: 'mini-USB', headers: '30 pins and ICSP' },
    build(k) {
      const usb = k.box('ports', 9.2, 4, 7.7, M.metal, 'metal', 9.2 / 2 - 1.6, 8.89, 0, 'mini-USB port', 0.5);
      k.child(usb, new THREE.BoxGeometry(0.3, 2.6, 6.2), M.dark, 'dark', -4.6, 0, 0);
      k.feature('usb', 0, 8.89, 4, 'mini-USB port', 4.5);
      ic(k, 7, 7, 26.5, 8.89, 'ATmega328P', ['ATMEGA328P', 'AU'], { rot: Math.PI / 4, legs: 32 }); k.feature('chip', 26.5, 8.89, 1, 'ATmega328P', 5.5);
      tactile(k, 18, 8.89, 'Reset button', { w: 4.6, d: 3.6, round: true }); k.feature('reset', 18, 8.89, 2.4, 'Reset button', 3);
      ic(k, 6.5, 3.5, 11.5, 13.2, '5 V regulator', ['LM1117'], { h: 1.6, layer: 'parts' }); k.feature('reg', 11.5, 13.2, 1.6, '5 V regulator', 3);
      k.box('parts', 3.2, 0.8, 2.5, M.tin, 'metal', 34, 4.4, 0, '16 MHz crystal', 0.3);
      const L = [[11.4, 4.4, 0x39ff6a, 'PWR LED', 'led_on'], [13.4, 4.4, 0xffb000, 'L LED', 'led_l'], [15.4, 4.4, 0xffd257, 'TX LED', 'led_tx'], [15.4, 13.2, 0xffd257, 'RX LED', 'led_rx']];
      for (const [x, y, c, n, key] of L) { led(k, x, y, c, n, key === 'led_l'); k.feature(key, x, y, 0.6, n, 1.8); }
      k.feature('icsp', 40.6, 8.9, 6, 'ICSP header', 4);
    },
  }),

  /** Arduino Mega 2560. */
  mega: () => ({
    pcb: '#00878f', trace: 'rgba(0,70,76,0.55)', pad: '#c8ccc9', edge: 0x0c5a57, radius: 1.2, seed: 31, labelSize: 1.0,
    holes: [[13.97, 50.8, 1.6], [15.24, 2.54, 1.6], [66.04, 45.72, 1.6], [66.04, 17.78, 1.6], [90.17, 50.8, 1.6], [96.52, 2.54, 1.6]],
    print: [['MEGA 2560', 60, 41, 3.2, 800], ['ARDUINO', 37, 41, 1.8, 700], ['DIGITAL', 76, 9.5, 1.3, 600], ['POWER', 40, 43.6, 1.2, 600], ['ANALOG IN', 70, 43.6, 1.2, 600]],
    sub: 'ATmega2560, USB-B, 54 digital + 16 analog pins',
    tags: [['usb', 'USB-B'], ['jack', 'Power jack'], ['chip', 'ATmega2560'], ['reset', 'Reset']],
    layers: { pcb: 'Circuit board', parts: 'Regulator, capacitors, crystal, reset', leds: 'L, TX, RX and ON LEDs', chip: 'ATmega2560 and 16U2', ports: 'USB-B and power jack', headers: 'Headers: digital, power, analog, 22–53' },
    build(k) {
      const usb = k.box('ports', 16.25, 10.9, 12.05, M.metal, 'metal', 16.25 / 2 - 6.35, 15.5, 0, 'USB-B port');
      k.child(usb, new THREE.BoxGeometry(0.4, 7.7, 8.4), M.dark, 'dark', -8.0, 0, 0);
      k.child(usb, new THREE.BoxGeometry(0.6, 3.2, 5.2), M.cream, 'body', -7.9, -0.6, 0);
      k.feature('usb', 1.8, 15.5, 11, 'USB-B port', 7);
      const jack = k.box('ports', 14.2, 11, 8.9, M.black, 'body', 14.2 / 2 - 1.9, 45.6, 0, 'Barrel jack');
      k.child(jack, new THREE.CylinderGeometry(3.1, 3.1, 0.6, 28).rotateZ(Math.PI / 2), M.dark, 'dark', -7.0, 0.6, 0);
      k.feature('jack', 5.2, 45.6, 11, 'Barrel jack', 6.5);
      ic(k, 14, 14, 58, 26, 'ATmega2560', ['ATMEGA2560', '16AU'], { rot: Math.PI / 4, legs: 100 }); k.feature('chip', 58, 26, 1, 'ATmega2560', 11);
      ic(k, 5, 5, 20, 15.5, 'ATmega16U2', ['16U2'], { rot: Math.PI / 4, legs: 32 }); k.feature('usbchip', 20, 15.5, 1, 'ATmega16U2', 4);
      k.box('parts', 11, 3.6, 4.6, M.tin, 'metal', 40, 33, 0, '16 MHz crystal', 1.7); k.feature('crystal', 40, 33, 3.6, '16 MHz crystal', 6);
      ic(k, 6.5, 3.5, 6.5, 34.8, '5 V regulator', ['NCP1117'], { h: 1.8, layer: 'parts' }); k.feature('reg', 6.5, 34.8, 1.8, '5 V regulator', 4.5);
      for (const y of [48.3, 41.7]) { k.box('parts', 6.6, 1, 6.6, M.black, 'body', 16.6, y, 0); k.add('parts', new THREE.CylinderGeometry(3.15, 3.15, 5.2, 28), M.tin, 'metal', 16.6, 3.6, y, 'Capacitor 47 µF'); }
      tactile(k, 6.2, 4.1, 'Reset button', { w: 6, d: 6, round: true }); k.feature('reset', 6.2, 4.1, 3, 'Reset button', 4);
      const L = [[27.9, 8.8, 0xffb000, 'L LED', 'led_l'], [27.9, 11.4, 0xffd257, 'TX LED', 'led_tx'], [27.9, 13.9, 0xffd257, 'RX LED', 'led_rx'], [72, 30, 0x39ff6a, 'ON LED', 'led_on']];
      for (const [x, y, c, n, key] of L) { led(k, x, y, c, n, key === 'led_l'); k.feature(key, x, y, 0.6, n, 2); }
    },
  }),
};
