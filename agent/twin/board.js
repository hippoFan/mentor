// Procedural Arduino UNO (R3 / R4 WiFi) and half-size breadboard, built from the pin table in millimetres.
// Every mesh carries userData.holo (its hologram tint) and sits in an explode layer, so the page can switch between
// the realistic and the hologram look and pull the board apart.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BOARD_W, BOARD_H, PCB_T, HEADER_H, PITCH, BB, FEATURES, allBbHoles } from './pins.js';

const FONT = 'Inter, "Inter Variable", ui-sans-serif, system-ui, sans-serif';
const S = 24;   // silkscreen px per mm

// ---------- shared materials (realistic look) ----------
export const M = {
  metal: new THREE.MeshStandardMaterial({ color: 0xcfd3d8, metalness: 1, roughness: 0.28 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd8b25a, metalness: 1, roughness: 0.3 }),
  black: new THREE.MeshStandardMaterial({ color: 0x151517, metalness: 0, roughness: 0.55 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x050506, metalness: 0, roughness: 0.9 }),
  socket: new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.6 }),
  cream: new THREE.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.7 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.75 }),
  tin: new THREE.MeshStandardMaterial({ color: 0xb3b7bb, metalness: 0.85, roughness: 0.5 }),
};

export function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
export function tex(c, { repeat } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.repeat.set(repeat, 1); }
  return t;
}
export function seeded(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** Female header top: black plastic with a square funnel per pin; `holo` draws bright hole outlines on black. */
const holeCache = {};
function holeTexture(n, holo) {
  const key = `${n}${holo ? 'h' : 'r'}`;
  if (holeCache[key]) return holeCache[key];
  const c = canvas(64, 64), g = c.getContext('2d');
  if (holo) {
    g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(160,240,255,0.9)'; g.lineWidth = 3; g.strokeRect(20, 20, 24, 24);
    g.strokeStyle = 'rgba(80,200,255,0.35)'; g.lineWidth = 2; g.strokeRect(2, 2, 60, 60);
  } else {
    g.fillStyle = '#18181a'; g.fillRect(0, 0, 64, 64);
    const gr = g.createLinearGradient(14, 14, 50, 50); gr.addColorStop(0, '#2c2c30'); gr.addColorStop(1, '#0c0c0d');
    g.fillStyle = gr; g.beginPath(); g.moveTo(12, 12); g.lineTo(52, 12); g.lineTo(52, 52); g.lineTo(12, 52); g.fill();
    g.fillStyle = '#020203'; g.fillRect(22, 22, 20, 20);
    g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 1; g.strokeRect(1, 1, 62, 62);
  }
  const t = tex(c, { repeat: n }); holeCache[key] = t; return t;
}

export function textTexture(lines, w, h, { bg = '#18181a', color = '#9a9aa0', size = 22 } = {}) {
  const c = canvas(w, h), g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((l, i) => { g.font = `${i ? 500 : 600} ${i ? size * 0.8 : size}px ${FONT}`; g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.2); });
  return tex(c);
}

/** The board's outline (mm, u/v frame): 68.58 wide in the middle, 66.04 at the corners, as on the real PCB. */
function outline() {
  const s = new THREE.Shape();
  const r = 1.2;
  s.moveTo(r, 0); s.lineTo(66.04, 0); s.lineTo(68.58, 2.54); s.lineTo(68.58, 38.1); s.lineTo(66.04, 40.64);
  s.lineTo(66.04, 51.82); s.lineTo(64.52, 53.34); s.lineTo(r, 53.34); s.quadraticCurveTo(0, 53.34, 0, 53.34 - r);
  s.lineTo(0, r); s.quadraticCurveTo(0, 0, r, 0);
  for (const [u, v] of [[13.97, 2.54], [15.24, 50.8], [66.04, 7.62], [66.04, 35.56]]) {
    const h = new THREE.Path(); h.absarc(u, v, 1.6, 0, Math.PI * 2, true); s.holes.push(h);
  }
  return s;
}

/** Silkscreen: the real board's printing (teal) or the hologram's (bright lines on black). */
function silkscreen(table, model, holo) {
  const c = canvas(Math.round(BOARD_W * S), Math.round(BOARD_H * S)), g = c.getContext('2d');
  const X = u => u * S, Y = v => (BOARD_H - v) * S;
  const ink = holo ? 'rgba(190,245,255,0.95)' : '#f4f7f6';
  g.fillStyle = holo ? '#000' : (model === 'uno-r4-wifi' ? '#00818a' : '#00878f');
  g.fillRect(0, 0, c.width, c.height);
  // copper traces under the solder mask: faint, seeded so the board looks the same every time
  const rnd = seeded(model === 'uno-r4-wifi' ? 7 : 3);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = holo ? 'rgba(60,200,255,0.22)' : 'rgba(0,70,76,0.55)'; g.lineWidth = 0.28 * S;
  for (let i = 0; i < 46; i++) {
    let u = 8 + rnd() * 56, v = 6 + rnd() * 42; g.beginPath(); g.moveTo(X(u), Y(v));
    for (let k = 0; k < 3; k++) { if (rnd() < 0.5) u += (rnd() - 0.5) * 24; else v += (rnd() - 0.5) * 20; u = Math.min(64, Math.max(4, u)); v = Math.min(49, Math.max(5, v)); g.lineTo(X(u), Y(v)); }
    g.stroke();
    g.beginPath(); g.arc(X(u), Y(v), 0.45 * S, 0, Math.PI * 2); g.fillStyle = holo ? 'rgba(120,230,255,0.4)' : 'rgba(0,60,66,0.7)'; g.fill();
  }
  // header outlines
  g.strokeStyle = ink; g.lineWidth = 0.18 * S;
  for (const [a, b, v] of [[17.5, 42.95, 50.8], [44.45, 64.77, 50.8], [26.67, 46.99, 2.54], [49.53, 64.77, 2.54]])
    g.strokeRect(X(a), Y(v + 1.55), (b - a) * S, 3.1 * S);
  // pin labels: vertical text, as printed next to the headers
  const PWM = new Set(['3', '5', '6', '9', '10', '11']);
  const vtext = (txt, u, v, size = 1.25, align = 'left') => {
    g.save(); g.translate(X(u), Y(v)); g.rotate(-Math.PI / 2); g.font = `600 ${size * S}px ${FONT}`; g.fillStyle = ink;
    g.textAlign = align; g.textBaseline = 'middle'; g.fillText(txt, 0, 0); g.restore();
  };
  for (const [k, p] of Object.entries(table.pins)) {
    const name = /^\d+$/.test(k) ? (PWM.has(k) ? `~${k}` : k === '1' ? 'TX→1' : k === '0' ? 'RX←0' : k) : k.replace(/\.\d$/, '');
    if (p.row === 'digital') vtext(name, p.u, 48.6, 1.15, 'right');
    else vtext(name, p.u, 4.7, 1.1, 'left');
  }
  const text = (t, u, v, size, weight = 600, align = 'center', font = FONT) => {
    g.font = `${weight} ${size * S}px ${font}`; g.fillStyle = ink; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(t, X(u), Y(v));
  };
  text('DIGITAL (PWM~)', 53, 40.4, 1.5);
  text('POWER', 37, 10.6, 1.5); text('ANALOG IN', 57.2, 10.6, 1.5);
  const F = FEATURES[model];
  text('L', F.led_l.u - 2.2, F.led_l.v, 1.3); text('TX', F.led_tx.u - 2.6, F.led_tx.v, 1.1); text('RX', F.led_rx.u - 2.6, F.led_rx.v, 1.1);
  text('ON', F.led_on.u + 3, F.led_on.v, 1.3); text('RESET', F.reset.u + 7, F.reset.v + 1.8, 1.0); text('ICSP', 63.5, 32.2, 1.0);
  if (model === 'uno-r4-wifi') {
    text('UNO R4 WiFi', 50.5, 37.6, 2.4, 700);
    g.strokeStyle = ink; g.lineWidth = 0.15 * S; g.strokeRect(X(39.7), Y(36.0), 21.6 * S, 14 * S);
  } else {
    // the infinity mark and the UNO wordmark
    g.strokeStyle = ink; g.lineWidth = 0.7 * S;
    for (const du of [-2.6, 2.6]) { g.beginPath(); g.arc(X(42.5 + du), Y(36.5), 2.6 * S, 0, Math.PI * 2); g.stroke(); }
    g.lineWidth = 0.45 * S; g.beginPath(); g.moveTo(X(38.9), Y(36.5)); g.lineTo(X(40.9), Y(36.5)); g.moveTo(X(44.1), Y(36.5)); g.lineTo(X(46.1), Y(36.5)); g.moveTo(X(45.1), Y(37.5)); g.lineTo(X(45.1), Y(35.5)); g.stroke();
    text('ARDUINO', 42.5, 32.4, 1.6, 700);
    text('UNO', 55.5, 37.2, 4.2, 800);
  }
  // mounting-hole pads
  for (const [u, v] of [[13.97, 2.54], [15.24, 50.8], [66.04, 7.62], [66.04, 35.56]]) {
    g.beginPath(); g.arc(X(u), Y(v), 2.6 * S, 0, Math.PI * 2); g.fillStyle = holo ? 'rgba(140,235,255,0.5)' : '#c8ccc9'; g.fill();
  }
  return tex(c);
}

/**
 * The UNO, in its own group. Local frame: x = u − W/2, z = H/2 − v, y up, PCB bottom at y = 0.
 * @returns {{group, layers, pinPos, featurePos, uvPos, pick, pickKeys, model}}
 */
export function buildUno(table, model) {
  const group = new THREE.Group(); group.name = model === 'uno-r4-wifi' ? 'Arduino UNO R4 WiFi' : 'Arduino UNO R3';
  const layers = {};
  for (const name of ['pcb', 'parts', 'leds', 'chip', 'ports', 'headers']) { const l = new THREE.Group(); l.name = name; layers[name] = l; group.add(l); }
  const L = (u, h, v) => new THREE.Vector3(u - BOARD_W / 2, PCB_T + h, BOARD_H / 2 - v);
  const add = (layer, geom, mat, holo, u, h, v, name) => {
    const m = new THREE.Mesh(geom, mat); m.position.copy(L(u, h, v)); m.castShadow = true; m.receiveShadow = true;
    m.userData.holo = holo; if (name) m.name = name; layers[layer].add(m); return m;
  };

  // PCB
  const pcbGeom = new THREE.ExtrudeGeometry(outline(), { depth: PCB_T, bevelEnabled: false, curveSegments: 16 });
  pcbGeom.rotateX(-Math.PI / 2); pcbGeom.translate(-BOARD_W / 2, 0, BOARD_H / 2);
  // ExtrudeGeometry's caps use the shape's (u, v) as uv; fit them to the silkscreen
  const uv = pcbGeom.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / BOARD_W, uv.getY(i) / BOARD_H);
  const silk = silkscreen(table, model, false);
  const pcb = new THREE.Mesh(pcbGeom, [
    new THREE.MeshStandardMaterial({ map: silk, roughness: 0.5, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ color: 0x0c5a57, roughness: 0.7 }),
  ]);
  pcb.name = 'PCB'; pcb.receiveShadow = true; pcb.castShadow = true;
  pcb.userData.holo = 'pcb'; pcb.userData.holoMap = silkscreen(table, model, true);
  layers.pcb.add(pcb);

  // female headers, at the table's real hole positions
  const P = table.pins;
  const strips = [
    ['SCL', 'SDA', 'AREF', 'GND.1', '13', '12', '11', '10', '9', '8'].map(k => P[k]),
    ['7', '6', '5', '4', '3', '2', '1', '0'].map(k => P[k]),
    [{ u: P.IOREF.u - PITCH, v: P.IOREF.v }, ...['IOREF', 'RESET', '3.3V', '5V', 'GND.2', 'GND.3', 'VIN'].map(k => P[k])],
    ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'].map(k => P[k]),
  ];
  strips.forEach((pins, i) => {
    if (pins.some(p => !p)) return;
    const n = pins.length, cu = pins.reduce((s, p) => s + p.u, 0) / n, cv = pins[0].v;
    const geom = new THREE.BoxGeometry(n * PITCH, HEADER_H, PITCH);
    const top = new THREE.MeshStandardMaterial({ map: holeTexture(n, false), roughness: 0.55 });
    const m = add('headers', geom, [M.black, M.black, top, M.black, M.black, M.black], 'body', cu, HEADER_H / 2, cv, `Header ${['digital 8–SCL', 'digital 0–7', 'power', 'analog'][i]}`);
    m.userData.holoMap = holeTexture(n, true);
  });

  // ICSP (2x3 male) near the far edge
  {
    const f = FEATURES[model].icsp;
    add('headers', new THREE.BoxGeometry(2 * PITCH, 2.5, 3 * PITCH), M.black, 'body', f.u, 1.25, f.v, 'ICSP header');
    const pg = new THREE.BoxGeometry(0.64, 6, 0.64);
    for (let a = 0; a < 2; a++) for (let b = 0; b < 3; b++) add('headers', pg, M.gold, 'metal', f.u + (a - 0.5) * PITCH, 3, f.v + (b - 1) * PITCH);
  }

  // ports
  const F = FEATURES[model];
  if (model === 'uno-r4-wifi') {
    const usb = add('ports', new RoundedBoxGeometry(7.35, 3.26, 8.94, 3, 1.4), M.metal, 'metal', 2.35, 1.63, F.usb.v, 'USB-C port');
    const slot = new THREE.Mesh(new RoundedBoxGeometry(0.6, 1.9, 7.4, 2, 0.9), M.dark); slot.position.set(-3.5, 0, 0); slot.userData.holo = 'dark'; usb.add(slot);
    const tongue = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 5.6), M.black); tongue.position.set(-3.4, 0, 0); tongue.userData.holo = 'body'; usb.add(tongue);
  } else {
    const usb = add('ports', new THREE.BoxGeometry(16.25, 10.9, 12.05), M.metal, 'metal', 1.775, 5.45, F.usb.v, 'USB-B port');
    const hole = new THREE.Mesh(new THREE.BoxGeometry(0.4, 7.7, 8.4), M.dark); hole.position.set(-8.0, 0, 0); hole.userData.holo = 'dark'; usb.add(hole);
    const tongue = new THREE.Mesh(new THREE.BoxGeometry(0.6, 3.2, 5.2), M.cream); tongue.position.set(-7.9, -0.6, 0); tongue.userData.holo = 'body'; usb.add(tongue);
  }
  {
    const jack = add('ports', new THREE.BoxGeometry(14.2, 11, 8.9), M.black, 'body', 5.2, 5.5, F.jack.v, 'Barrel jack');
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 0.6, 28), M.dark); hole.rotation.z = Math.PI / 2; hole.position.set(-7.0, 0.6, 0); hole.userData.holo = 'dark'; jack.add(hole);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.0, 16), M.metal); pin.rotation.z = Math.PI / 2; pin.position.set(-7.0, 0.6, 0); pin.userData.holo = 'metal'; jack.add(pin);
  }

  // main chip
  if (model === 'uno-r4-wifi') {
    const f = F.chip;
    const chip = add('chip', new THREE.BoxGeometry(10, 1.4, 10), [M.black, M.black, new THREE.MeshStandardMaterial({ map: textTexture(['RENESAS', 'R7FA4M1AB'], 256, 256, { size: 30 }), roughness: 0.45 }), M.black, M.black, M.black], 'body', f.u, 0.75, f.v, 'RA4M1 microcontroller');
    chip.userData.label = 'RA4M1';
    const legs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.15, 1.1), M.metal, 64); legs.userData.holo = 'metal';
    const o = new THREE.Object3D(); let i = 0;
    for (let side = 0; side < 4; side++) for (let k = 0; k < 16; k++) {
      const t = (k - 7.5) * 0.5, a = side * Math.PI / 2;
      o.position.set(Math.cos(a) * 5.45 - Math.sin(a) * t, 0.1, Math.sin(a) * 5.45 + Math.cos(a) * t); o.rotation.y = -a + Math.PI / 2; o.updateMatrix(); legs.setMatrixAt(i++, o.matrix);
    }
    legs.position.copy(L(f.u, 0, f.v)); layers.chip.add(legs);
    // ESP32-S3 module: metal can on a small PCB, antenna toward the edge
    const e = F.esp;
    add('chip', new THREE.BoxGeometry(15.4, 0.8, 15.4), new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.6 }), 'body', e.u, 0.4, e.v, 'ESP32-S3 module');
    add('chip', new RoundedBoxGeometry(12.5, 2.2, 11.5, 2, 0.4), M.tin, 'metal', e.u + 1.2, 1.9, e.v, 'ESP32-S3 shield').userData.label = 'ESP32-S3';
    // 12 x 8 LED matrix, a heart lit
    const m = F.matrix, heart = ['000110011000', '001111111100', '001111111100', '000111111000', '000011110000', '000001100000', '000000000000', '000000000000'];
    const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.5, 0.6), new THREE.MeshBasicMaterial(), 96);
    leds.userData.holo = 'led'; leds.name = 'LED matrix';
    let n = 0; const col = new THREE.Color();
    for (let r = 0; r < 8; r++) for (let c2 = 0; c2 < 12; c2++) {
      o.position.set((c2 - 5.5) * 1.75, 0.25, (r - 3.5) * 1.6); o.rotation.set(0, 0, 0); o.updateMatrix(); leds.setMatrixAt(n, o.matrix);
      leds.setColorAt(n++, col.set(heart[r][c2] === '1' ? 0xff4a2e : 0x3a2622));
    }
    leds.position.copy(L(m.u, 0, m.v)); layers.leds.add(leds);
    add('parts', new THREE.BoxGeometry(4.3, 3, 6), M.white, 'body', F.qwiic.u, 1.5, F.qwiic.v, 'Qwiic connector');
  } else {
    const f = F.chip;
    add('chip', new THREE.BoxGeometry(37.6, 1.6, 10.2), M.socket, 'body', f.u, 0.8, f.v, 'DIP socket');
    const chip = add('chip', new THREE.BoxGeometry(35.3, 3.3, 7.4), [M.black, M.black, new THREE.MeshStandardMaterial({ map: textTexture(['ATMEGA328P-PU', 'ATMEL'], 1024, 214, { size: 64 }), roughness: 0.45 }), M.black, M.black, M.black], 'body', f.u, 3.25, f.v, 'ATmega328P');
    chip.userData.label = 'ATmega328P';
    const legs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 3.2, 0.3), M.tin, 28); legs.userData.holo = 'metal';
    const o = new THREE.Object3D();
    for (let i = 0; i < 28; i++) { const side = i < 14 ? 1 : -1, k = i % 14; o.position.set((k - 6.5) * PITCH, 2.6, side * 3.85); o.updateMatrix(); legs.setMatrixAt(i, o.matrix); }
    legs.position.copy(L(f.u, 0, f.v)); layers.chip.add(legs);
    add('chip', new THREE.BoxGeometry(5, 0.9, 5), M.black, 'body', F.usbchip.u, 0.45, F.usbchip.v, 'ATmega16U2');
    add('parts', new RoundedBoxGeometry(11, 3.6, 4.6, 2, 1.7), M.tin, 'metal', F.crystal.u, 1.8, F.crystal.v, '16 MHz crystal');
  }

  // regulator, capacitors, reset button
  add('parts', new THREE.BoxGeometry(6.5, 1.8, 3.5), M.black, 'body', F.reg.u, 0.9, F.reg.v, '5 V regulator');
  add('parts', new THREE.BoxGeometry(3.0, 0.3, 3.5), M.tin, 'metal', F.reg.u, 0.15, F.reg.v + 3.4);
  for (const v of [5, 11.6]) {
    add('parts', new THREE.BoxGeometry(6.6, 1, 6.6), M.black, 'body', 16.6, 0.5, v);
    add('parts', new THREE.CylinderGeometry(3.15, 3.15, 5.2, 28), M.tin, 'metal', 16.6, 3.4, v, 'Capacitor 47 µF');
  }
  add('parts', new THREE.BoxGeometry(6, 2, 6), M.tin, 'metal', F.reset.u, 1, F.reset.v, 'Reset button');
  add('parts', new THREE.CylinderGeometry(1.75, 1.75, 1.6, 24), model === 'uno-r4-wifi' ? M.black : M.black, 'body', F.reset.u, 2.6, F.reset.v);

  // status LEDs
  const ledMat = c => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.25, roughness: 0.3 });
  const LED = { led_l: 0xffb000, led_tx: 0xffd257, led_rx: 0xffd257, led_on: 0x39ff6a };
  for (const [k, c] of Object.entries(LED)) {
    const f = F[k];
    const m = add('leds', new THREE.BoxGeometry(1.6, 0.6, 0.8), ledMat(c), 'led', f.u, 0.3, f.v, f.name);
    if (k === 'led_on') { m.material.emissiveIntensity = 1.6; m.userData.lit = true; }
    if (k === 'led_l') m.userData.blink = true;
  }

  // pin picking: one invisible pad per hole, on top of the header
  const pickKeys = Object.keys(P);
  const pick = new THREE.InstancedMesh(new THREE.BoxGeometry(2.3, 1.2, 2.3), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), pickKeys.length);
  pick.userData.pick = 'pin'; pick.userData.noExport = true;
  const o = new THREE.Object3D();
  pickKeys.forEach((k, i) => { o.position.copy(L(P[k].u, HEADER_H, P[k].v)); o.updateMatrix(); pick.setMatrixAt(i, o.matrix); });
  layers.headers.add(pick);

  return {
    group, layers, model, pick, pickKeys,
    /** top of a header hole (group-local); the hole's layer is 'headers' */
    pinPos: k => (P[k] ? L(P[k].u, HEADER_H, P[k].v) : null),
    featurePos: k => (F[k] ? L(F[k].u, F[k].h, F[k].v) : null),
    uvPos: (u, v, h = 0.2) => L(u, h, v),
  };
}

/** Half-size breadboard: 30 columns, rows a–j, two rails on each side. Local frame: centre at 0, top at y = BB.h. */
export function buildBreadboard() {
  const group = new THREE.Group(); group.name = 'Breadboard';
  const holes = allBbHoles();
  const draw = holo => {
    const s = 20, c = canvas(Math.round(BB.w * s), Math.round(BB.d * s)), g = c.getContext('2d');
    const X = x => (x + BB.w / 2) * s, Z = z => (z + BB.d / 2) * s;
    g.fillStyle = holo ? '#000' : '#f1f0ea'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = holo ? 'rgba(80,200,255,0.25)' : '#d9d7cf'; g.fillRect(0, Z(-1.3), c.width, 2.6 * s);   // centre channel
    for (const [z, col] of [[-24.4, '#e5484d'], [-18.8, '#3e7bfa'], [18.8, '#3e7bfa'], [24.4, '#e5484d']]) {
      g.strokeStyle = holo ? (col === '#e5484d' ? 'rgba(255,120,140,0.8)' : 'rgba(120,170,255,0.8)') : col;
      g.lineWidth = 0.35 * s; g.beginPath(); g.moveTo(X(-37), Z(z)); g.lineTo(X(37), Z(z)); g.stroke();
    }
    for (const h of holes) {
      if (holo) { g.strokeStyle = 'rgba(170,240,255,0.85)'; g.lineWidth = 0.18 * s; g.strokeRect(X(h.x) - 0.55 * s, Z(h.z) - 0.55 * s, 1.1 * s, 1.1 * s); }
      else { g.fillStyle = '#c9c7bf'; g.fillRect(X(h.x) - 0.75 * s, Z(h.z) - 0.75 * s, 1.5 * s, 1.5 * s); g.fillStyle = '#1c1c1e'; g.fillRect(X(h.x) - 0.5 * s, Z(h.z) - 0.5 * s, 1.0 * s, 1.0 * s); }
    }
    g.fillStyle = holo ? 'rgba(190,245,255,0.9)' : '#8a8a86'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `600 ${1.25 * s}px ${FONT}`;
    for (let col = 1; col <= 30; col++) if (col === 1 || col % 5 === 0) {
      const x = X((col - 15.5) * PITCH); g.fillText(String(col), x, Z(-16.2)); g.fillText(String(col), x, Z(16.2));
    }
    for (const [r, z] of Object.entries({ a: 13.97, b: 11.43, c: 8.89, d: 6.35, e: 3.81, f: -3.81, g: -6.35, h: -8.89, i: -11.43, j: -13.97 })) {
      g.fillText(r, X(-39.6), Z(z)); g.fillText(r, X(39.6), Z(z));
    }
    return tex(c);
  };
  const side = new THREE.MeshStandardMaterial({ color: 0xe9e8e1, roughness: 0.8 });
  const top = new THREE.MeshStandardMaterial({ map: draw(false), roughness: 0.75 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(BB.w, BB.h, BB.d), [side, side, top, side, side, side]);
  body.position.y = BB.h / 2; body.castShadow = true; body.receiveShadow = true;
  body.userData.holo = 'body'; body.userData.holoMap = draw(true); body.name = 'Breadboard body';
  group.add(body);
  const pick = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 1, 2.2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), holes.length);
  pick.userData.pick = 'bb'; pick.userData.noExport = true;
  const o = new THREE.Object3D();
  holes.forEach((h, i) => { o.position.set(h.x, BB.h, h.z); o.updateMatrix(); pick.setMatrixAt(i, o.matrix); });
  group.add(pick);
  return { group, pick, holes, holePos: h => new THREE.Vector3(h.x, BB.h, h.z) };
}
