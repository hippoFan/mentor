// The voice circuit builder on the 3D twin: every part of the project (circuit.mjs layout) as a recognisable procedural
// model standing on the breadboard, and every jumper as a holographic braided tube from the exact board header hole to
// the exact breadboard hole, plugs seated. Parts drop in, wires draw themselves in, removed things fade out.
//
//   const view = createCircuitView({ boardPin: k => uno.pinPos(k).add(unoPos), bbOrigin: BB_POS, label: (text, cls) => tag(text, cls) });
//   twin.add(view.group);
//   view.setState(event);   // the agent's {type:'circuit', layout, ...} event (or a bare layout)
//   view.setLook(holo);     // hologram / realistic (also follows the app's applyLook: userData.real / holoMat)
//   per frame: view.update() (or the app's traverseVisible userData.update, which calls it)
//
// Same conventions as board.js / holo.js: millimetres, y up, every mesh carries userData.holo (its hologram tint) and is
// named, effects and labels carry userData.noExport, so the GLB export keeps clean, named meshes.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { clock, COLORS, holoMaterial, edgeMaterial, makeRing, easeInOut, easeOut } from './holo.js';
import { bbHole, bbRail, BB, PITCH } from './pins.js';

/** Jumper colours (same names as circuit.mjs WIRE_COLORS); the hologram shows black (ground) as blue. */
export const WIRE_HEX = { red: 0xff3b30, black: 0x1c1c1e, orange: 0xff9f0a, yellow: 0xffd60a, green: 0x30d158, blue: 0x0a84ff,
  purple: 0xbf5af2, cyan: 0x64d2ff, pink: 0xff375f, white: 0xf2f2f7, brown: 0xa2845e };
const HOLO_HEX = { ...WIRE_HEX, black: 0x3e7bfa, blue: 0x2f8bff, white: 0xd8f6ff, brown: 0xd8a070 };
export const legendHex = (color, holo = true) => `#${((holo ? HOLO_HEX : WIRE_HEX)[color] ?? 0xffffff).toString(16).padStart(6, '0')}`;

const UP = new THREE.Vector3(0, 1, 0);
const PLUG = 11;   // mm: the jumper's plug housing above the hole

// ---------- materials ----------
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...o });
const MAT = {
  metal: () => std(0xcfd3d8, { metalness: 1, roughness: 0.28 }), tin: () => std(0xb8bcc2, { metalness: 0.9, roughness: 0.4 }),
  black: () => std(0x141416), dark: () => std(0x060607, { roughness: 0.9 }), pcbBlue: () => std(0x1d5fc4, { roughness: 0.5 }),
  white: () => std(0xf1f1ec, { roughness: 0.7 }), cream: () => std(0xdcc79a, { roughness: 0.6 }),
};
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const FONT = '"Cooper Hewitt", ui-sans-serif, system-ui, sans-serif';

/** Adds a mesh to g with its hologram tint. */
function part(g, geom, mat, holo, name, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geom, mat); m.position.set(x, y, z); m.userData.holo = holo; if (name) m.name = name;
  m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
}
/** Remember both looks per mesh (the app's applyLook uses the same keys), plus an edge outline for the hologram. */
export function decorate(root, holoMaps = new Map()) {
  root.traverse(o => {
    if (!o.isMesh || !o.userData.holo || o.userData.real) return;
    o.userData.real = o.material;
    const mk = m => {
      const h = holoMaterial(o.userData.holo, m?.map ? holoMaps.get(m.map) || null : null);
      if (o.userData.holoColor != null) h.uniforms.uColor.value = new THREE.Vector3(...new THREE.Color(o.userData.holoColor).toArray());
      return h;
    };
    o.userData.holoMat = Array.isArray(o.material) ? o.material.map(mk) : mk(o.material);
    if (!o.userData.noEdges) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 30), edgeMaterial);
      e.userData.noExport = true; e.userData.edges = true; e.raycast = () => {}; o.add(e);
    }
  });
}
export function applyLook(root, holo) {
  root.traverse(o => {
    if (o.userData.real) { o.material = holo ? o.userData.holoMat : o.userData.real; o.castShadow = !holo; }
    if (o.userData.edges) o.visible = holo;
  });
}
/** Fade every material under root (0..1). Materials are per part, so this never touches the board's shared ones. */
function setFade(root, f) {
  root.traverse(o => {
    const ms = [o.userData.real, o.userData.holoMat, o.material].flat().filter(Boolean);
    for (const m of ms) {
      if (m.uniforms?.uOpacity) { m.userData.base ??= m.uniforms.uOpacity.value; m.uniforms.uOpacity.value = m.userData.base * f; }
      else if (m.uniforms?.uFade) m.uniforms.uFade.value = f;
      else if (m.isMaterial && m !== edgeMaterial) { m.userData.base ??= m.opacity; m.transparent = f < 0.999 || m.userData.wasTransparent || false; m.opacity = m.userData.base * f; }
    }
  });
}

// ---------- parts (local frame: x along the pin row, y up from the breadboard top, z toward the viewer) ----------
const pinRow = (g, n, { y0 = -1.5, len = 4.5, name = 'Header pins' } = {}) => {
  const geo = new THREE.BoxGeometry(0.64, len, 0.64), mat = MAT.tin();
  for (let i = 0; i < n; i++) part(g, geo, mat, 'metal', i ? '' : name, (i - (n - 1) / 2) * PITCH, y0 + len / 2, 0).userData.noEdges = true;
};
const spacer = (g, n, y = 0, h = 2.5) => part(g, new THREE.BoxGeometry(n * PITCH, h, 2.5), MAT.black(), 'body', 'Header spacer', 0, y + h / 2, 0);

function sonar() {   // HC-SR04: blue PCB standing up, two silver transducers with mesh fronts, crystal on top
  const g = new THREE.Group(); g.name = 'HC-SR04 ultrasonic sensor';
  pinRow(g, 4); spacer(g, 4, 0);
  const pcbY = 3.2, H = 20.5, W = 45;
  const print = canvasTex(900, 410, (x, w, h) => {
    x.fillStyle = '#1d5fc4'; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,255,255,.92)'; x.font = `700 34px ${FONT}`; x.textAlign = 'center'; x.fillText('HC-SR04', w / 2, 58);
    x.font = `600 30px ${FONT}`; x.fillText('T', 150, 385); x.fillText('R', w - 150, 385);
    x.font = `600 22px ${FONT}`; ['Vcc', 'Trig', 'Echo', 'Gnd'].forEach((s, i) => x.fillText(s, w / 2 + (i - 1.5) * 51, 392));
  });
  const holoPrint = canvasTex(900, 410, (x, w, h) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(170,240,255,.9)'; x.lineWidth = 6; x.strokeRect(6, 6, w - 12, h - 12);
    x.fillStyle = 'rgba(190,245,255,.95)'; x.font = `700 34px ${FONT}`; x.textAlign = 'center'; x.fillText('HC-SR04', w / 2, 58);
    x.font = `600 22px ${FONT}`; ['VCC', 'TRIG', 'ECHO', 'GND'].forEach((s, i) => x.fillText(s, w / 2 + (i - 1.5) * 51, 392));
  });
  const front = std(0xffffff, { map: print, roughness: 0.5 }), side = MAT.pcbBlue();
  const pcb = part(g, new THREE.BoxGeometry(W, H, 1.6), [side, side, side, side, front, side], 'pcb', 'Sensor PCB', 0, pcbY + H / 2, 0);
  const maps = new Map([[print, holoPrint]]);
  const can = MAT.metal(), meshTex = canvasTex(256, 256, (x, w) => {
    x.fillStyle = '#16171a'; x.fillRect(0, 0, w, w); x.strokeStyle = '#4a4d55'; x.lineWidth = 3;
    for (let i = 0; i < w; i += 14) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, w); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(w, i); x.stroke(); }
  });
  const transducers = [];
  for (const [sx, name] of [[-13.2, 'Transmitter'], [13.2, 'Receiver']]) {
    const c = part(g, new THREE.CylinderGeometry(8, 8, 12, 40, 1, true), can, 'metal', `${name} can`, sx, pcbY + H / 2, 0.8 + 6);
    c.rotation.x = Math.PI / 2;
    const face = part(g, new THREE.CircleGeometry(7.6, 40), std(0xffffff, { map: meshTex, roughness: 0.9 }), 'dark', `${name} mesh`, sx, pcbY + H / 2, 12.75);
    face.userData.noEdges = true;
    const lip = part(g, new THREE.TorusGeometry(7.8, 0.45, 8, 40), can, 'metal', '', sx, pcbY + H / 2, 12.8); lip.userData.noEdges = true;
    transducers.push(new THREE.Vector3(sx, pcbY + H / 2, 13));
  }
  part(g, new RoundedBoxGeometry(10.5, 3.6, 4, 2, 1.6), MAT.tin(), 'metal', 'Crystal', 0, pcbY + H - 3.2, 2.4);
  for (const x of [-6, 6]) part(g, new THREE.BoxGeometry(5, 4, 1.2), MAT.black(), 'body', 'IC', x, pcbY + 9, -1.4);
  return { g, maps, top: pcbY + H, transducers, front: 13 };
}

function servo() {   // SG90: translucent blue case, mounting tabs, output boss and a white horn; leads end in a 3-pin plug
  const g = new THREE.Group(); g.name = 'SG90 micro servo';
  const blue = std(0x2a62ff, { roughness: 0.35, transparent: true, opacity: 0.92 }); blue.userData.wasTransparent = true;
  part(g, new RoundedBoxGeometry(23, 22.5, 12.2, 2, 0.8), blue, 'body', 'Servo case', 0, 11.25, 0);
  part(g, new THREE.BoxGeometry(32.5, 2.4, 12.2), blue, 'body', 'Mounting tabs', 0, 16, 0);
  part(g, new THREE.CylinderGeometry(5.9, 5.9, 4, 32), blue, 'body', 'Output boss', 5.6, 24.5, 0);
  part(g, new THREE.CylinderGeometry(2.3, 2.3, 3, 20), MAT.white(), 'body', 'Spline', 5.6, 27.5, 0);
  const horn = new THREE.Group(); horn.name = 'Horn'; horn.position.set(5.6, 29.2, 0); g.add(horn);
  const hornShape = new THREE.Shape(); hornShape.absarc(0, 0, 3.4, Math.PI / 2, Math.PI * 1.5, false); hornShape.lineTo(15, -1.6); hornShape.absarc(15, 0, 1.6, -Math.PI / 2, Math.PI / 2, false); hornShape.lineTo(0, 3.4);
  const hg = new THREE.ExtrudeGeometry(hornShape, { depth: 1.6, bevelEnabled: false, curveSegments: 16 }); hg.rotateX(-Math.PI / 2);
  part(horn, hg, MAT.white(), 'body', 'Horn arm', 0, -0.8, 0);
  return { g, horn, top: 31 };
}
/** The servo's 3 leads (brown, red, orange) from the case to its female plug, which jumpers plug into from above. */
function servoLeads(from, plugAt) {
  const g = new THREE.Group(); g.name = 'Servo leads';
  const cols = [0x5a3a22, 0xd8352a, 0xf08a1c], keys = ['GND', 'V+', 'PWM'];
  const housing = part(g, new THREE.BoxGeometry(3 * PITCH, 14, 2.6), MAT.black(), 'body', 'Servo plug', plugAt.x, 7, plugAt.z);
  housing.userData.noEdges = false;
  const holes = {};
  keys.forEach((k, i) => {
    const x = plugAt.x + (i - 1) * PITCH;
    holes[k] = new THREE.Vector3(x, 14, plugAt.z);
    const a = new THREE.Vector3(from.x - 11.5, 4 + i * 0.1, from.z + (i - 1) * 1.1), b = new THREE.Vector3(x, 0.8, plugAt.z - 1.4);
    const curve = new THREE.CatmullRomCurve3([a, new THREE.Vector3(a.x - 8, 0.8, a.z), new THREE.Vector3((a.x + b.x) / 2, 0.8, (a.z + b.z) / 2 - 3), b.clone().add(new THREE.Vector3(0, 0, -5)), b]);
    const m = part(g, new THREE.TubeGeometry(curve, 60, 0.55, 8, false), std(cols[i], { roughness: 0.5 }), 'metal', `Lead ${k}`);
    m.userData.holoColor = cols[i]; m.userData.noEdges = true;
  });
  return { g, holes };
}

function led(color) {   // 5 mm LED: coloured epoxy dome, rim flange, long anode leg (local x = +PITCH/2), short cathode
  const g = new THREE.Group(); g.name = 'LED 5 mm';
  const hex = { red: 0xff2a1f, green: 0x22e05a, yellow: 0xffd21f, blue: 0x2f7bff, white: 0xf4f7ff, orange: 0xff8a1c }[color] || 0xff2a1f;
  const legs = MAT.tin();
  for (const [x, h, name] of [[PITCH / 2, 7.4, 'Anode leg (long)'], [-PITCH / 2, 6.6, 'Cathode leg']]) part(g, new THREE.CylinderGeometry(0.25, 0.25, h + 1.5, 8), legs, 'metal', name, x, h / 2 - 0.75, 0).userData.noEdges = true;
  const epoxy = new THREE.MeshPhysicalMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.3, roughness: 0.15, clearcoat: 1, transparent: true, opacity: 0.9 });
  epoxy.userData.wasTransparent = true;
  const y0 = 6.6;
  part(g, new THREE.CylinderGeometry(2.9, 2.9, 1, 32), epoxy, 'led', 'LED rim', 0, y0 + 0.5, 0).userData.holoColor = hex;
  part(g, new THREE.CylinderGeometry(2.5, 2.5, 5.2, 32), epoxy, 'led', 'LED body', 0, y0 + 3.6, 0).userData.holoColor = hex;
  const dome = part(g, new THREE.SphereGeometry(2.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), epoxy, 'led', 'LED dome', 0, y0 + 6.2, 0); dome.userData.holoColor = hex;
  return { g, epoxy, hex, top: y0 + 9 };
}
function resistor(span) {   // 220 ohm: beige body, bands red-red-brown-gold, legs bent down into holes `span` mm apart
  const g = new THREE.Group(); g.name = 'Resistor 220 Ω';
  const yb = 3.4, legMat = MAT.tin();
  const legPath = s => new THREE.CatmullRomCurve3([new THREE.Vector3(s * span / 2, -1.2, 0), new THREE.Vector3(s * span / 2, yb - 0.8, 0), new THREE.Vector3(s * (span / 2 - 0.8), yb, 0), new THREE.Vector3(s * 2.6, yb, 0)], false, 'catmullrom', 0.1);
  for (const s of [-1, 1]) part(g, new THREE.TubeGeometry(legPath(s), 24, 0.25, 6, false), legMat, 'metal', s < 0 ? 'Resistor leg 1' : 'Resistor leg 2').userData.noEdges = true;
  const body = part(g, new THREE.CapsuleGeometry(1.15, 4.4, 6, 18), MAT.cream(), 'body', 'Resistor body', 0, yb, 0); body.rotation.z = Math.PI / 2;
  [[0xd21f1f, -1.5], [0xd21f1f, -0.6], [0x6b3b12, 0.3], [0xc9a24a, 1.7]].forEach(([c, x], i) => {
    const b = part(g, new THREE.CylinderGeometry(1.2, 1.2, 0.45, 18), std(c, { metalness: i === 3 ? 0.8 : 0, roughness: 0.4 }), 'metal', `Band ${i + 1}`, x, yb, 0);
    b.rotation.z = Math.PI / 2; b.userData.holoColor = c; b.userData.noEdges = true;
  });
  return { g };
}
function pot() {   // rotary potentiometer facing the viewer: metal can, threaded bushing, black knurled knob with a pointer
  const g = new THREE.Group(); g.name = 'Potentiometer';
  pinRow(g, 3, { y0: -1.5, len: 5.5 });
  const cy = 10.5;
  const can = part(g, new THREE.CylinderGeometry(8.2, 8.2, 6.5, 40), MAT.metal(), 'metal', 'Pot body', 0, cy, -0.6); can.rotation.x = Math.PI / 2;
  part(g, new THREE.BoxGeometry(9, 3.4, 1.4), std(0x2a2b30), 'body', 'Terminal tab', 0, 2.6, 0.6);
  const bush = part(g, new THREE.CylinderGeometry(3.5, 3.5, 4.5, 24), MAT.tin(), 'metal', 'Bushing', 0, cy, 4.6); bush.rotation.x = Math.PI / 2;
  const knob = new THREE.Group(); knob.name = 'Knob'; knob.position.set(0, cy, 12); g.add(knob);
  const kb = part(knob, new THREE.CylinderGeometry(6.3, 6.6, 10, 24), std(0x18181b, { roughness: 0.6 }), 'body', 'Knob body'); kb.rotation.x = Math.PI / 2;
  const ptr = part(knob, new THREE.BoxGeometry(0.9, 4.5, 0.4), MAT.white(), 'led', 'Knob pointer', 0, 3.4, 5.05); ptr.userData.holoColor = 0xffffff; ptr.userData.noEdges = true;
  return { g, knob, top: cy + 9, front: 17 };
}
function button(color, dx = 2 * PITCH, dz = 7.62) {   // 12 mm tactile switch straddling the channel: black base, metal plate, round coloured cap
  const g = new THREE.Group(); g.name = 'Pushbutton 12 mm';
  const hex = { red: 0xe5332a, green: 0x22b357, yellow: 0xf5c518, blue: 0x2f6bff, white: 0xeeeeee, orange: 0xff8a1c }[color] || 0xe5332a;
  const legs = MAT.tin();
  for (const x of [-dx / 2, dx / 2]) for (const z of [-dz / 2, dz / 2]) part(g, new THREE.BoxGeometry(0.7, 4.5, 0.3), legs, 'metal', '', x, 0.6, z).userData.noEdges = true;
  part(g, new RoundedBoxGeometry(12, 3.5, 12, 2, 0.5), MAT.black(), 'body', 'Switch base', 0, 1.75 + 0.6, 0);
  part(g, new THREE.BoxGeometry(12.2, 0.5, 12.2), MAT.metal(), 'metal', 'Switch plate', 0, 4.4, 0);
  const capM = std(hex, { roughness: 0.45 });
  const c = part(g, new THREE.CylinderGeometry(3.6, 3.6, 3.6, 32), capM, 'led', 'Button cap', 0, 6.4, 0); c.userData.holoColor = hex;
  return { g, cap: c, top: 9 };
}
function dht() {   // DHT22: white case standing up, slotted grille on the front, pins at the bottom
  const g = new THREE.Group(); g.name = 'DHT22 sensor';
  pinRow(g, 4, { y0: -1.5, len: 5 });
  const y0 = 3.2, W = 15.1, H = 25, D = 7.7;
  const draw = holo => canvasTex(302, 500, (x, w, h) => {
    x.fillStyle = holo ? '#000' : '#f3f3ef'; x.fillRect(0, 0, w, h);
    x.fillStyle = holo ? 'rgba(170,240,255,.9)' : '#2a2b2f';
    for (let r = 0; r < 7; r++) for (let c = 0; c < 3; c++) { const rx = 38 + c * 80, ry = 30 + r * 46; x.beginPath(); x.roundRect(rx, ry, 66, 28, 6); holo ? (x.lineWidth = 3, x.strokeStyle = x.fillStyle, x.stroke()) : x.fill(); }
    x.font = `700 40px ${FONT}`; x.textAlign = 'center'; x.fillStyle = holo ? 'rgba(190,245,255,.95)' : '#4a4b50'; x.fillText('DHT22', w / 2, 440);
  });
  const real = draw(false), holo = draw(true);
  const front = std(0xffffff, { map: real, roughness: 0.75 }), side = MAT.white();
  part(g, new RoundedBoxGeometry(W, H, D, 2, 0.8), [side, side, side, side, front, side], 'body', 'DHT22 case', 0, y0 + H / 2, 0);
  return { g, maps: new Map([[real, holo]]), top: y0 + H, front: D / 2 + 0.5 };
}
function imu() {   // GY-521 (MPU-6050): blue breakout standing up, black QFN chip, regulator, labelled 8-pin header
  const g = new THREE.Group(); g.name = 'MPU-6050 (GY-521)';
  pinRow(g, 8); spacer(g, 8, 0);
  const y0 = 3.2, W = 21.6, H = 16.2;
  const names = ['INT', 'AD0', 'XCL', 'XDA', 'SDA', 'SCL', 'GND', 'VCC'];
  const draw = holo => canvasTex(432, 324, (x, w, h) => {
    x.fillStyle = holo ? '#000' : '#1d5fc4'; x.fillRect(0, 0, w, h);
    x.fillStyle = holo ? 'rgba(190,245,255,.95)' : 'rgba(255,255,255,.92)'; x.font = `600 15px ${FONT}`; x.textAlign = 'center';
    names.forEach((s, i) => { x.save(); x.translate(w / 2 + (i - 3.5) * 50.8, h - 34); x.rotate(-Math.PI / 2); x.fillText(s, 0, 5); x.restore(); });
    x.font = `700 20px ${FONT}`; x.fillText('GY-521', w / 2, 34);
    x.strokeStyle = x.fillStyle; x.lineWidth = 3; for (const cx of [26, w - 26]) { x.beginPath(); x.arc(cx, 30, 14, 0, Math.PI * 2); x.stroke(); }
  });
  const real = draw(false), holo = draw(true);
  const front = std(0xffffff, { map: real, roughness: 0.5 }), side = MAT.pcbBlue();
  part(g, new THREE.BoxGeometry(W, H, 1.6), [side, side, side, side, front, side], 'pcb', 'Breakout PCB', 0, y0 + H / 2, 0);
  part(g, new THREE.BoxGeometry(4, 4, 0.9), MAT.black(), 'body', 'MPU-6050 chip', 0, y0 + H / 2 + 1.2, 1.25).userData.label = 'MPU-6050';
  part(g, new THREE.BoxGeometry(3, 1.6, 1.2), MAT.black(), 'body', 'Regulator', -6.5, y0 + H - 4.5, 1.4);
  for (const x of [4.5, 6.5, -3.5]) part(g, new THREE.BoxGeometry(1.2, 0.7, 0.7), std(0xb08a5a), 'metal', '', x, y0 + H - 4.2, 1.2).userData.noEdges = true;
  return { g, maps: new Map([[real, holo]]), top: y0 + H };
}

// ---------- holographic jumper ----------
const WIRE_VERT = /* glsl */`
  varying vec2 vUv; varying vec3 vN; varying vec3 vW;
  void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const WIRE_FRAG = /* glsl */`
  uniform vec3 uA, uB; uniform float uTime, uLen, uProgress, uGlow, uSpeed, uFade, uPhase;
  varying vec2 vUv; varying vec3 vN; varying vec3 vW;
  void main() {
    float s = vUv.x;
    if (s > uProgress) discard;
    vec3 V = normalize(cameraPosition - vW);
    float ndv = abs(dot(normalize(vN), V));
    vec3 base = mix(uA, uB, smoothstep(0.0, 1.0, s));
    float L = s * uLen, ang = vUv.y * 6.2831853;
    float h1 = smoothstep(0.55, 0.95, sin(ang * 3.0 + L * 1.25));          // two counter-wound helices: a braid
    float h2 = smoothstep(0.55, 0.95, sin(-ang * 3.0 + L * 1.25 + 1.4));
    float braid = max(h1, h2);
    float pulse = 0.0;
    for (int i = 0; i < 2; i++) { float p = fract(L / 30.0 - uTime * uSpeed - float(i) * 0.5 - uPhase); pulse += pow(smoothstep(0.8, 1.0, p), 3.0); }
    float head = smoothstep(0.07, 0.0, uProgress - s) * step(uProgress, 0.999);
    if (uGlow > 0.5) {
      float a = pow(ndv, 2.0) * (0.13 + 0.38 * pulse + 0.6 * head) * uFade;
      gl_FragColor = vec4(base * a, a);
    } else {
      float fres = pow(1.0 - ndv, 2.0);
      vec3 col = base * (0.38 + 0.62 * braid) + mix(base, vec3(1.0), 0.5) * fres * 0.9 + mix(base, vec3(1.0), 0.5) * (pulse * 0.7 + head);
      gl_FragColor = vec4(col * uFade, uFade);
    }
  }`;
const vec3c = h => { const c = new THREE.Color(h); return new THREE.Vector3(c.r, c.g, c.b); };
function wireShader(a, b, len, glow, phase) {
  return new THREE.ShaderMaterial({
    uniforms: { uA: { value: vec3c(a) }, uB: { value: vec3c(b) }, uTime: clock, uLen: { value: len }, uProgress: { value: 0 }, uGlow: { value: glow ? 1 : 0 },
      uSpeed: { value: 0.8 }, uFade: { value: 1 }, uPhase: { value: phase } },
    vertexShader: WIRE_VERT, fragmentShader: WIRE_FRAG,
    transparent: true, depthWrite: !glow, ...(glow ? { blending: THREE.AdditiveBlending } : {}),
  });
}

/**
 * A jumper from a to b (world points on the hole tops), plugs standing in both holes. color: a WIRE_HEX name.
 * lift: how high the arc rises above the plugs. Returns a group with userData.update (draws in) and .curve.
 */
export function makeJumper(a, b, color, { lift, delay = 0, phase = 0, name = 'Jumper' } = {}) {
  const g = new THREE.Group(); g.name = name;
  const p0 = a.clone().addScaledVector(UP, PLUG), p3 = b.clone().addScaledVector(UP, PLUG);
  const d = Math.hypot(p3.x - p0.x, p3.z - p0.z);
  const L = lift ?? Math.min(70, Math.max(8, d * 0.42));
  const top = Math.max(p0.y, p3.y) + L;
  const curve = new THREE.CubicBezierCurve3(p0, new THREE.Vector3(p0.x + (p3.x - p0.x) * 0.08, top, p0.z + (p3.z - p0.z) * 0.08),
    new THREE.Vector3(p3.x + (p0.x - p3.x) * 0.08, top, p3.z + (p0.z - p3.z) * 0.08), p3);
  const len = curve.getLength();
  const hA = HOLO_HEX[color] ?? 0xffffff, hB = new THREE.Color(hA).lerp(new THREE.Color(COLORS.violet), 0.45).getHex();
  const realMat = std(WIRE_HEX[color] ?? 0xffffff, { roughness: 0.42, metalness: 0.05 });
  const coreGeo = new THREE.TubeGeometry(curve, Math.max(40, Math.round(len * 1.2)), 0.95, 12, false);
  const core = new THREE.Mesh(coreGeo, realMat); core.name = `${name} cable`; core.castShadow = true;
  core.userData.real = realMat; core.userData.holoMat = wireShader(hA, hB, len, false, phase); core.userData.exportColor = WIRE_HEX[color];
  const shellGeo = new THREE.TubeGeometry(curve, Math.max(30, Math.round(len * 0.8)), 1.9, 10, false);
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const shell = new THREE.Mesh(shellGeo, hidden); shell.name = `${name} glow`; shell.userData.noExport = true; shell.raycast = () => {};
  shell.userData.real = hidden; shell.userData.holoMat = wireShader(hA, hB, len, true, phase);
  g.add(shell, core);
  const ends = [a, b].map((at, i) => {
    const e = new THREE.Group(); e.name = `${name} plug ${i ? 'B' : 'A'}`; e.position.copy(at);
    const housingReal = std(0x141418, { roughness: 0.45 });
    const housing = new THREE.Mesh(new THREE.BoxGeometry(2.5, PLUG - 2.2, 2.5), housingReal); housing.position.y = 2.2 + (PLUG - 2.2) / 2; housing.name = 'Plug housing';
    housing.userData.real = housingReal; housing.userData.holoMat = holoMaterial('body'); housing.userData.holoMat.uniforms.uColor.value = vec3c(i ? hB : hA);
    const pinReal = std(0xc9ccd2, { metalness: 1, roughness: 0.25 });
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.6, 10), pinReal); pin.position.y = 0.9; pin.name = 'Plug pin';
    pin.userData.real = pinReal; pin.userData.holoMat = holoMaterial('metal');
    const bootReal = std(WIRE_HEX[color] ?? 0xffffff, { roughness: 0.5 });
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.3, 2.2, 14), bootReal); boot.position.y = PLUG + 0.5; boot.name = 'Plug boot';
    boot.userData.real = bootReal; boot.userData.holoMat = holoMaterial('led'); boot.userData.holoMat.uniforms.uColor.value = vec3c(i ? hB : hA);
    for (const m of [housing, pin, boot]) { m.castShadow = true; m.userData.wireEnd = true; }
    e.add(housing, pin, boot); g.add(e); e.visible = false;
    return e;
  });
  const contact = [a, b].map((at, i) => { const r = makeRing(i ? hB : hA, { radius: 1.8 }); r.position.copy(at).add(new THREE.Vector3(0, 0.15, 0)); r.userData.noExport = true; r.visible = false; g.add(r); return r; });
  const born = clock.value + delay;
  const segs = coreGeo.index.count;
  g.userData.curve = curve;
  g.userData.fade = 1;
  g.userData.holo = true;
  g.userData.update = () => {
    const t = clock.value - born;
    const dur = Math.max(0.6, Math.min(1.3, len / 150)), prog = Math.max(0, Math.min(1, t / dur));
    const e = easeInOut(prog);
    core.userData.holoMat.uniforms.uProgress.value = shell.userData.holoMat.uniforms.uProgress.value = e;
    coreGeo.setDrawRange(0, Math.ceil(segs * e / 6) * 6);
    ends[0].visible = t > 0; ends[0].position.y = a.y + Math.max(0, 6 * (1 - Math.min(1, Math.max(0, t) / 0.3)));
    ends[1].visible = prog >= 1; ends[1].position.y = b.y + Math.max(0, 6 * (1 - Math.min(1, Math.max(0, t - dur) / 0.3)));
    contact[0].visible = t > 0 && g.userData.holo; contact[1].visible = prog >= 1 && g.userData.holo;
    for (const c of contact) if (c.visible) c.userData.update();
    const f = g.userData.fade;
    core.userData.holoMat.uniforms.uFade.value = shell.userData.holoMat.uniforms.uFade.value = f;
    if (f < 1) setFade(g, f);
  };
  g.userData.update();
  return g;
}

// ---------- the view ----------
const holePos = (name, origin) => {
  const m = String(name).match(/^([A-Ja-j])(\d{1,2})$/);
  const h = m ? bbHole(m[1], Number(m[2])) : null;
  return h ? new THREE.Vector3(h.x, BB.h, h.z).add(origin) : null;
};
const railPos = (pole, i, origin) => { const r = bbRail('back', pole, i); return new THREE.Vector3(r.x, BB.h, r.z).add(origin); };
const colX = (c, origin) => (c - 15.5) * PITCH + origin.x;

/**
 * @param {{boardPin: (key: string) => THREE.Vector3 | null, bbOrigin?: THREE.Vector3, label?: (text: string, cls: string) => THREE.Object3D,
 *   holo?: boolean, reduced?: boolean}} opts boardPin: world position of the top of a board header hole (circuit.mjs pin keys)
 */
export function createCircuitView({ boardPin, bbOrigin = new THREE.Vector3(47, 0, 0), label = null, holo = true, reduced = false } = {}) {
  const group = new THREE.Group(); group.name = 'Ody circuit';
  const partsG = new THREE.Group(); partsG.name = 'Circuit parts';
  const wiresG = new THREE.Group(); wiresG.name = 'Circuit wires';
  const fx = new THREE.Group(); fx.name = 'Circuit effects'; fx.userData.noExport = true;
  group.add(partsG, wiresG, fx);
  const S = { holo, parts: new Map(), wires: new Map(), leaving: [], layout: null, servoLeads: new Map() };
  const T = () => clock.value;

  function buildPart(c) {
    let built, pos, rotY = 0;
    const pinX = (name) => { const h = holePos(c.pins[name], bbOrigin); return h; };
    if (c.part === 'led-5mm') {
      const L = led(c.color);
      const g = new THREE.Group(); g.name = `${c.label || 'LED'} (${c.id})`;
      const A = holePos(c.pins.A, bbOrigin), C = holePos(c.pins.C, bbOrigin);
      L.g.position.copy(A).add(C).multiplyScalar(0.5); L.g.position.y = BB.h;
      const r1 = holePos(c.resistor?.from || `C${c.col}`, bbOrigin), r2 = holePos(c.resistor?.to || `C${c.col + 3}`, bbOrigin);
      const R = resistor(r2.x - r1.x); R.g.position.copy(r1).add(r2).multiplyScalar(0.5); R.g.position.y = BB.h;
      g.add(L.g, R.g);
      built = { g, top: L.g.position.y + L.top, anchor: L.g.position.clone(), led: L, mode: c.mode };
      decorate(g);
      return built;
    }
    if (c.part.startsWith('pushbutton')) {
      const legs = ['1.l', '1.r', '2.l', '2.r'].map(k => holePos(c.pins[k], bbOrigin));
      const B = button(c.color, Math.abs(legs[2].x - legs[0].x), Math.abs(legs[1].z - legs[0].z));
      B.g.position.copy(legs[0]).add(legs[3]).multiplyScalar(0.5); B.g.position.y = BB.h;
      decorate(B.g);
      return { g: B.g, top: B.g.position.y + B.top, anchor: B.g.position.clone(), button: B };
    }
    if (c.part === 'servo-sg90') {
      const Sv = servo();
      const off = c.off || 0;
      Sv.g.position.set(bbOrigin.x + 24 - off * 38, 0, bbOrigin.z - 46);
      const leads = servoLeads(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-20, 0, 15));
      Sv.g.add(leads.g);
      decorate(Sv.g);
      const holes = Object.fromEntries(Object.entries(leads.holes).map(([k, v]) => [k, v.clone().add(Sv.g.position)]));
      return { g: Sv.g, top: Sv.top, anchor: Sv.g.position.clone(), servo: Sv, holes };
    }
    const make = { 'hc-sr04': sonar, dht22: dht, potentiometer: pot, mpu6050: imu }[c.part];
    if (!make) return null;
    const M = make();
    const first = holePos(c.pins[Object.keys(c.pins)[0]], bbOrigin), last = holePos(c.pins[Object.keys(c.pins).at(-1)], bbOrigin);
    pos = first.clone().add(last).multiplyScalar(0.5); pos.y = BB.h;
    M.g.position.copy(pos); M.g.rotation.y = rotY;
    decorate(M.g, M.maps);
    return { g: M.g, top: pos.y + M.top, anchor: pos.clone(), model: M, part: c.part };
  }

  function addPart(c, i) {
    const b = buildPart(c);
    if (!b) return;
    b.g.userData.circuitId = c.id;
    applyLook(b.g, S.holo);
    const wrap = new THREE.Group(); wrap.name = b.g.name; wrap.add(b.g); partsG.add(wrap);
    b.wrap = wrap; b.born = T() + (reduced ? 0 : i * 0.08); b.c = c;
    if (label) { const tg = label(c.label || c.part, 'part'); tg.position.copy(b.anchor).add(new THREE.Vector3(0, (b.top - b.anchor.y) + 4, 0)); tg.userData.noExport = true; wrap.add(tg); b.tag = tg; }
    S.parts.set(c.id + ':' + c.part + ':' + (c.col ?? `o${c.off}`) + ':' + (c.color || '') + ':' + (c.mode || ''), b);
  }
  function endPoint(e) {
    if (e.board) return boardPin(e.board);
    if (e.rail) return railPos(e.rail, e.i, bbOrigin);
    if (e.hole) return holePos(e.hole, bbOrigin);
    if (e.lead) { const p = [...S.parts.values()].find(x => x.c.id === e.lead); return p?.holes?.[e.pin]?.clone() || null; }
    return null;
  }
  const endKey = e => (e.board ? `b:${e.board}` : e.rail ? `r:${e.rail}${e.i}` : e.hole ? `h:${e.hole}` : `l:${e.lead}.${e.pin}`);

  /** Renders a circuit event ({layout}) or a bare layout; animates what changed. */
  function setState(ev) {
    const L = ev?.layout || ev;
    if (!L || !Array.isArray(L.components)) return;
    S.layout = L;
    const keep = new Set();
    L.components.forEach((c, i) => {
      const k = c.id + ':' + c.part + ':' + (c.col ?? `o${c.off}`) + ':' + (c.color || '') + ':' + (c.mode || '');
      keep.add(k);
      if (!S.parts.has(k)) addPart(c, i);
    });
    for (const [k, b] of S.parts) if (!keep.has(k)) { S.parts.delete(k); S.leaving.push({ obj: b.wrap, t0: T(), kind: 'part' }); }
    const keepW = new Set();
    let n = 0, fresh = 0;
    const order = [...L.jumpers];
    for (const j of order) {
      const k = `${j.id}|${endKey(j.from)}|${endKey(j.to)}|${j.color}`;
      keepW.add(k); n++;
      if (S.wires.has(k)) continue;
      const a = endPoint(j.from), b = endPoint(j.to);
      if (!a || !b) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      const lift = j.kind === 'signal' || j.kind === 'rail' ? Math.min(66, Math.max(16, d * 0.36)) + (n % 6) * 2.6 : Math.min(26, 5 + d * 0.3) + (n % 3) * 1.5;
      const w = makeJumper(a, b, j.color, { lift, delay: reduced ? 0 : 0.35 + fresh * 0.22, phase: (n * 0.37) % 1, name: `Jumper ${j.id}` });
      w.userData.holo = S.holo;
      applyLook(w, S.holo);
      wiresG.add(w); S.wires.set(k, w); fresh++;
    }
    for (const [k, w] of S.wires) if (!keepW.has(k)) { S.wires.delete(k); S.leaving.push({ obj: w, t0: T(), kind: 'wire' }); }
  }

  function setLook(on) {
    S.holo = on;
    applyLook(group, on);
    fx.visible = on;
    for (const w of S.wires.values()) w.userData.holo = on;
  }

  const pings = [];
  function ping(at) {   // a sonar pulse leaving the transmitter (hologram only)
    const m = new THREE.Mesh(new THREE.RingGeometry(5.6, 6.2, 40), new THREE.MeshBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    m.position.copy(at); m.userData.noExport = true; fx.add(m); pings.push({ m, t0: T() });
  }
  let lastPing = 0;
  function update() {
    const t = T();
    for (const b of S.parts.values()) {
      const age = t - b.born, k = reduced ? 1 : easeOut(Math.min(1, Math.max(0, age) / 0.55));
      b.g.position.y = (b.g.userData.y0 ??= b.g.position.y) + (1 - k) * 22;
      if (k < 1 || b.fading !== undefined) { setFade(b.g, k); b.fading = k < 1 ? k : undefined; }
      b.wrap.visible = age > -0.01;
      if (b.led) {   // the sketch's behaviour, live: blink once a second or fade
        const level = b.mode === 'fade' ? 0.5 - 0.5 * Math.cos(t * 2.4) : (Math.floor(t * 1) % 2 ? 1 : 0.05);
        b.led.epoxy.emissiveIntensity = 0.15 + 1.6 * level;
        b.g.traverse(o => { if (o.userData.holo === 'led' && o.userData.holoMat?.uniforms) o.userData.holoMat.uniforms.uOpacity.value = 0.5 + 0.9 * level; });
      }
      if (b.servo) b.servo.horn.rotation.y = Math.sin(t * 1.3) * 1.35;
      if (b.part === 'hc-sr04' && S.holo && t - lastPing > 0.9 && age > 1) { lastPing = t; const tr = b.model.transducers[0].clone(); b.g.localToWorld(tr); ping(tr); }
    }
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i], a = (t - p.t0) / 1.6;
      if (a >= 1) { fx.remove(p.m); p.m.geometry.dispose(); p.m.material.dispose(); pings.splice(i, 1); continue; }
      p.m.position.z += 0.5; p.m.scale.setScalar(1 + a * 0.9); p.m.material.opacity = 0.5 * (1 - a) * (1 - a);
    }
    for (let i = S.leaving.length - 1; i >= 0; i--) {
      const l = S.leaving[i], a = Math.min(1, (t - l.t0) / (reduced ? 0.01 : 0.6));
      if (l.kind === 'wire') l.obj.userData.fade = 1 - a; else { setFade(l.obj, 1 - a); l.obj.position.y = a * 8; }
      if (a >= 1) {
        (l.kind === 'wire' ? wiresG : partsG).remove(l.obj);
        l.obj.traverse(o => { if (o.element) o.element.remove(); if (o.geometry) o.geometry.dispose(); });
        S.leaving.splice(i, 1);
      }
    }
  }
  // the app's frame loop calls userData.update on every visible object: the wires update themselves, this does the rest
  group.userData.update = update;

  function dispose() {
    for (const o of [partsG, wiresG, fx]) o.traverse(x => { if (x.element) x.element.remove(); if (x.geometry) x.geometry.dispose(); });
    group.removeFromParent();
  }
  /** Bounding box of the circuit (parts + wires) for camera framing. */
  const box = () => new THREE.Box3().setFromObject(group);
  const stats = () => ({ parts: S.parts.size, wires: S.wires.size, leaving: S.leaving.length, meshes: (() => { let n = 0; group.traverse(o => { if (o.isMesh) n++; }); return n; })(),
    drawing: [...S.wires.values()].some(w => w.children.find(c => c.userData.holoMat?.uniforms?.uProgress)?.userData.holoMat.uniforms.uProgress.value < 1) });
  return { group, setState, setLook, update, dispose, box, stats, colX: c => colX(c, bbOrigin) };
}
