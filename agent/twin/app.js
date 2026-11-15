// Mentor's digital twin: when Mentor recognises the board on the call, this page shows it in 3D, with Mentor's rings,
// warnings and wires on the exact pins. Same WebSocket as the call view (monitor.html); it only listens.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { loadPins, pinInfo, bbInfo, inferModel, resolveMarks, targetName, MODEL_NAMES, BB } from './pins.js';
import { buildUno, buildBreadboard } from './board.js';
import { partTable, normAlias, UNO_MODELS } from './partpins.js';
import { buildPart, PART_MODELS } from './parts3d.js';
import { clock, COLORS, holoMaterial, edgeMaterial, makeRing, makeArrow, makeWire, makeProjectorFloor, easeInOut } from './holo.js';
import { createGestures, applyToCamera } from './gestures.js';
import { buildScan, explodeScan, disposeScan } from './scan.js';

const $ = id => document.getElementById(id);
const stage = $('stage'), canvas = $('view');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const UNO_POS = new THREE.Vector3(-46, 0, 0), BB_POS = new THREE.Vector3(47, 0, 0);

// ---------- renderer, scene, camera ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
let pixelRatio = Math.min(devicePixelRatio || 1, 2);
renderer.setPixelRatio(pixelRatio);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 1, 4000);
const controls = new OrbitControls(camera, canvas);
Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 60, maxDistance: 520, maxPolarAngle: 1.45, rotateSpeed: 0.7, zoomSpeed: 0.9 });
const labels = new CSS2DRenderer({ element: $('labels') });

scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(-80, 220, 140); key.castShadow = true;
key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -150, right: 150, top: 120, bottom: -120, near: 10, far: 600 });
key.shadow.radius = 6; key.shadow.bias = -0.0005;
const fill = new THREE.HemisphereLight(0xdfe8ff, 0x202024, 0.6);
scene.add(key, fill);

// realistic floor: soft pool of light + contact shadow; hologram floor: the projector
const realFloor = new THREE.Group(); realFloor.userData.noExport = true;
{
  const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d');
  const gr = g.createRadialGradient(256, 256, 0, 256, 256, 256); gr.addColorStop(0, '#36363b'); gr.addColorStop(1, '#1d1d1f');
  g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshBasicMaterial({ map: t }));
  pool.rotation.x = -Math.PI / 2; pool.position.y = -0.05;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.ShadowMaterial({ opacity: 0.45 }));
  shadow.rotation.x = -Math.PI / 2; shadow.receiveShadow = true;
  realFloor.add(pool, shadow);
}
const holoFloor = makeProjectorFloor();
scene.add(realFloor, holoFloor);

// post: bloom at reduced resolution (cheap on an iGPU), MSAA target so edges stay clean
const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.55, 0.1);
let bloomScale = 0.5;
const bloomSetSize = bloom.setSize.bind(bloom);
bloom.setSize = (w, h) => bloomSetSize(Math.max(1, Math.round(w * bloomScale)), Math.max(1, Math.round(h * bloomScale)));
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- the twin ----------
const twin = new THREE.Group(); twin.name = 'Ody twin'; scene.add(twin);
const marksGroup = new THREE.Group(); marksGroup.name = 'Ody marks';
const wiresGroup = new THREE.Group(); wiresGroup.name = 'Wires';
const partTags = new THREE.Group(); partTags.userData.noExport = true;
twin.add(marksGroup, wiresGroup);
scene.add(partTags);
const hover = makeRing(0xffffff, { radius: 1.7 }); hover.visible = false; hover.userData.noExport = true; scene.add(hover);

const S = {
  table: null, model: null, uno: null, unos: {}, bb: null, holo: true, explode: 0, explodeTo: 0,
  turns: [], callMarks: [], wires: new Map(), current: [], step: '', done: false, bbIn: 0, fly: null, tipPinned: null,
  scans: [], scan: null, view: 'board',   // "scan anything": every object scanned this call; view = what the stage shows
  parts: {}, tables: {}, lookup: {}, pos: UNO_POS.clone(),   // library boards (twin/parts.json) and where the board sits
};
// ---------- which board: the UNO (pins.js + board.js) or a library board (partpins.js + parts3d.js) ----------
const isPart = m => PART_MODELS.includes(m) && !!S.parts[m];
const isBoard = m => UNO_MODELS.includes(m) || isPart(m);
function tableFor(m) {
  if (!isPart(m)) return S.table;
  if (!S.tables[m]) { const p = S.parts[m]; S.tables[m] = partTable(p, p.orientation); }
  return S.tables[m];
}
const T = () => tableFor(S.model);
const nameOf = m => MODEL_NAMES[m] || S.parts[m]?.name || 'Board';
const infoFor = k => (S.uno?.pinInfo ? S.uno.pinInfo(k) : pinInfo(k, S.model || 'uno-r3'));
const scanGroup = new THREE.Group(); scanGroup.name = 'Scanned object'; twin.add(scanGroup);

function decorate(root) {   // remember both looks per mesh, and give each an edge outline for the hologram
  root.traverse(o => {
    if (!o.isMesh || !o.userData.holo || o.userData.real) return;
    o.userData.real = o.material;
    // textured faces (PCB top, header tops, breadboard top) keep their print in the hologram; plain faces glow
    o.userData.holoMat = Array.isArray(o.material)
      ? o.material.map(m => holoMaterial(o.userData.holo, m.map ? o.userData.holoMap : null))
      : holoMaterial(o.userData.holo, o.userData.holoMap);
    if (!o.isInstancedMesh) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 28), edgeMaterial);
      e.userData.noExport = true; e.userData.edges = true; e.raycast = () => {}; o.add(e); o.userData.edgeLines = e;
    }
  });
}
function applyLook(root = twin) {
  root.traverse(o => {
    if (o.userData.real) { o.material = S.holo ? o.userData.holoMat : o.userData.real; o.castShadow = !S.holo; }
    if (o.userData.edges) o.visible = S.holo;
  });
}
function setHolo(on) {
  S.holo = on;
  document.body.classList.toggle('holo', on);
  $('t-holo').setAttribute('aria-pressed', String(on));
  scene.background = new THREE.Color(on ? 0x04070b : 0x1d1d1f);
  realFloor.visible = !on; holoFloor.visible = on;
  key.castShadow = !on;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = on ? 1.0 : 0.9;
  bloom.strength = on ? 0.75 : 0.45; bloom.threshold = on ? 0.2 : 1.05; bloom.radius = on ? 0.5 : 0.35;
  applyLook();
  updatePartTags();
}

function showModel(model) {
  if (!S.table) return;
  const want = model || 'uno-r3';
  if (S.uno?.model === want) return;
  if (S.uno) twin.remove(S.uno.group);
  if (!S.unos[want]) {
    let u;
    if (isPart(want)) {
      const t = tableFor(want);
      u = buildPart(t, want); t.features = u.features;   // marks name features ("USB-C power") through the table
      u.group.position.set(Math.min(UNO_POS.x, -6 - u.W / 2), 0, 0);   // keep clear of the breadboard on the right
    } else { u = buildUno(S.table, want); u.group.position.copy(UNO_POS); }
    decorate(u.group); S.unos[want] = u;
  }
  S.uno = S.unos[want];
  S.pos.copy(S.uno.group.position);
  S.uno.group.visible = S.view === 'board';
  twin.add(S.uno.group);
  applyLook(S.uno.group);
  buildLayerTags(); updatePartTags();
}

function boardPanel() {
  $('part').textContent = S.model ? nameOf(S.model) : 'No board yet';
  $('partsub').textContent = isPart(S.model) ? (S.uno?.sub || '') : S.model === 'uno-r4-wifi' ? 'USB-C, 12 × 8 LED matrix, Wi-Fi' : S.model ? 'USB-B, ATmega328P' : 'Ody names the board as soon as it sees it.';
  $('scaninfo').hidden = true;
}
function setPart(model, label) {
  if (!isBoard(model)) {
    if (model === 'other' && !S.model) { $('part').textContent = String(label || 'A board Ody can’t model yet').slice(0, 60); $('partsub').textContent = 'The twin covers Arduino UNO, Nano and Mega, ESP32, NodeMCU, Raspberry Pi and Pico.'; }
    return;
  }
  const first = !S.model, changed = S.model !== model;
  S.model = model;
  showModel(model);
  document.body.classList.add('has-part');
  if (S.view === 'board') boardPanel();
  renderScans();
  controls.autoRotate = false;
  if (first || changed) { S.bbIn = Math.max(S.bbIn, 0.0001); if (!S.replaying) flyHome(1.6); }
}

// ---------- Mentor's marks ----------
const world = t => {
  if (!t || !S.uno) return null;
  if (t.on === 'pin') return S.uno.pinPos(t.key)?.add(S.pos);
  if (t.on === 'bb') return new THREE.Vector3(t.hole.x, BB.h, t.hole.z).add(BB_POS);
  if (t.on === 'feature') return S.uno.featurePos(t.key)?.add(S.pos);
  if (t.on === 'board') return S.uno.uvPos(t.u, t.v).add(S.pos);
  return null;
};
const RING_R = { usb: 7, jack: 6.5, chip: 9, esp: 9, matrix: 12, reset: 4, icsp: 5, crystal: 6, reg: 4.5, board: 30, usbchip: 4, qwiic: 4 };
function tag(text, cls, sub) {
  const el = document.createElement('div'); el.className = `tag ${cls}`;
  const dot = document.createElement('i'), lead = document.createElement('b'), lab = document.createElement('span');
  if (sub) { const em = document.createElement('em'); em.textContent = sub; lab.append(em); }
  lab.append(document.createTextNode(text));
  el.append(dot, lead, lab);
  const o = new CSS2DObject(el); o.userData.noExport = true; return o;
}
function clearGroup(g) {
  for (const c of [...g.children]) {
    g.remove(c);
    c.traverse(o => { if (o.element) o.element.remove(); if (o.geometry && !o.userData.shared) o.geometry.dispose(); });
  }
}

function applyTurn(turn, { animate = true } = {}) {
  const marks = Array.isArray(turn.marks) ? turn.marks.slice(0, 12) : [];
  const model = inferModel({ board: turn.board, marks }, PART_MODELS.filter(isPart), S.model) || S.model;
  if (model && model !== S.model) setPart(model);
  if (turn.board && !Array.isArray(turn.board) && turn.board.model === 'other' && !S.model) setPart('other');
  if (!S.table || !S.uno) return;
  const resolved = resolveMarks(T(), S.model || 'uno-r3', marks, turn.board);
  S.current = resolved;
  if (S.view === 'scan' && S.model && resolved.some(r => r.from) && !S.replaying) showBoard({ fly: false });
  clearGroup(marksGroup);
  const focus = [];
  for (const r of resolved) {
    const a = world(r.from), b = world(r.to);
    S.callMarks.unshift({ ...r, step: turn.step || '' });
    if ((r.kind === 'wire' || r.kind === 'warn') && a && b) {
      const id = `${r.kind}:${targetName(T(), S.model, r.from)}>${targetName(T(), S.model, r.to)}`;
      const plugA = r.from.on === 'pin' || r.from.on === 'bb', plugB = r.to.on === 'pin' || (r.to.on === 'bb' && r.to.hole.kind !== 'area');
      if (!S.wires.has(id)) {
        const w = makeWire(a, b, { plugA, plugB, warn: r.kind === 'warn' });
        w.userData.id = id; wiresGroup.add(w);
        const mid = w.userData.curve.getPoint(0.5);
        if (r.kind !== 'warn') { const t = tag(`${targetName(T(), S.model, r.from)} → ${targetName(T(), S.model, r.to)}`, 'wire'); t.position.copy(mid); w.add(t); }
        S.wires.set(id, { ...r, obj: w });
      }
      if (r.kind === 'warn') {
        for (const [p, end] of [[a, r.from], [b, r.to]]) { const ring = makeRing(COLORS.warn, { radius: 2.1, warn: true }); ring.position.copy(p).add(new THREE.Vector3(0, 0.15, 0)); marksGroup.add(ring); }
        const t = tag(r.label || 'Stop', 'warn', /^stop/i.test(r.label) ? '' : 'Stop'); t.position.copy(a); marksGroup.add(t);
      }
      focus.push(a, b);
    } else if (a) {
      const col = r.kind === 'warn' ? COLORS.warn : COLORS.mentor;
      const rad = r.from.on === 'feature' ? (S.uno.features?.[r.from.key]?.r || RING_R[r.from.key] || 3) : 2.0;
      const ring = r.kind === 'arrow' ? makeArrow(col) : makeRing(col, { radius: rad, warn: r.kind === 'warn' });
      ring.position.copy(a).add(new THREE.Vector3(0, 0.15, 0)); marksGroup.add(ring);
      const where = r.from.on === 'pin' ? infoFor(r.from.key).name : '';
      const t = tag(r.label || where, r.kind === 'warn' ? 'warn' : 'mentor', where && r.label && !r.label.includes(where.replace(/^D/, '')) ? where : '');
      t.position.copy(a); marksGroup.add(t);
      focus.push(a);
    }
  }
  if (turn.step) setStep(turn.step, turn.done);
  if (turn.done) S.done = true;
  renderLists();
  updatePartTags();
  if (animate && !S.replaying) { if (turn.done) flyHome(1.6); else if (focus.length) flyTo(focus); }
}

function setStep(text, done) {
  S.step = String(text || '').slice(0, 160); $('step').textContent = done ? 'Done. You made it home.' : (S.step || '…');
  $('stepbox').classList.toggle('done', !!done);
}

function li(icon, what, where, onClick, old) {
  const el = document.createElement('li'); if (old) el.className = 'old';
  const b = document.createElement('button'); b.type = 'button';
  const i = document.createElement('span'); i.className = `ico ${icon}`;
  const w = document.createElement('span'); w.className = 'what'; w.textContent = what;
  const x = document.createElement('span'); x.className = 'where'; x.textContent = where;
  b.append(i, w, x); b.addEventListener('click', onClick); el.append(b); return el;
}
function renderLists() {
  const ul = $('marks'); ul.replaceChildren();
  const cur = new Set(S.current);
  S.callMarks.slice(0, 24).forEach(m => {
    const icon = !m.from ? 'miss' : m.kind === 'warn' ? 'warn' : m.kind === 'wire' ? 'wire' : '';
    const where = m.to ? `${targetName(T(), S.model, m.from)} → ${targetName(T(), S.model, m.to)}` : m.from ? targetName(T(), S.model, m.from) : 'not on the board';
    ul.append(li(icon, m.label || where, m.to || where === m.label ? '' : where, () => { const p = [world(m.from), world(m.to)].filter(Boolean); if (p.length) flyTo(p); }, ![...cur].some(c => c.label === m.label && c.kind === m.kind)));
  });
  $('marks-empty').hidden = S.callMarks.length > 0;
  const wl = $('wires'); wl.replaceChildren();
  for (const w of S.wires.values()) {
    wl.append(li(w.kind === 'warn' ? 'warn' : 'wire', `${targetName(T(), S.model, w.from)} → ${targetName(T(), S.model, w.to)}`, w.kind === 'warn' ? 'do not connect' : 'jumper',
      () => flyTo([world(w.from), world(w.to)].filter(Boolean))));
  }
  $('wires-empty').hidden = S.wires.size > 0;
}
function wiringText() {
  const lines = [...S.wires.values()].map(w => `${targetName(T(), S.model, w.from)} → ${targetName(T(), S.model, w.to)} (${w.kind === 'warn' ? 'do not connect: short' : 'jumper'})`);
  return lines.length ? `${nameOf(S.model)} wiring from Ody\n${lines.join('\n')}` : '';
}

// ---------- part labels (hologram) and explode ----------
function updatePartTags() {
  clearGroup(partTags);
  if (S.view === 'scan') {
    if (!S.scan || S.explode > 0.01) return;
    for (const a of S.scan.built.anchors) { const t = tag(a.text, 'part'); t.position.copy(a.pos).multiplyScalar(S.scan.built.scale); partTags.add(t); }
    return;
  }
  if (!S.uno || !S.holo || S.explode > 0.01 || S.current.length || !S.model) return;
  if (S.uno.tags) {   // a library board names its own signature parts
    for (const [k, text] of S.uno.tags) { const p = S.uno.featurePos(k); if (!p) continue; const t = tag(text, 'part'); t.position.copy(p.add(S.pos)); partTags.add(t); }
    return;
  }
  const keys = S.model === 'uno-r4-wifi' ? ['usb', 'esp', 'matrix', 'chip', 'jack'] : ['usb', 'chip', 'jack', 'reset'];
  const F = { usb: 'USB-C', esp: 'ESP32-S3 Wi-Fi', matrix: 'LED matrix', chip: S.model === 'uno-r4-wifi' ? 'RA4M1' : 'ATmega328P', jack: 'Power jack', reset: 'Reset' };
  for (const k of keys) { const p = S.uno.featurePos(k); if (!p) continue; const t = tag(k === 'usb' && S.model === 'uno-r3' ? 'USB-B' : F[k], 'part'); t.position.copy(p.add(S.pos)); partTags.add(t); }
  const d = S.uno.pinPos('13'); if (d) { const t = tag('Digital pins', 'part'); t.position.copy(S.uno.pinPos('7').add(S.pos)); partTags.add(t); }
  const p = S.uno.pinPos('A2'); if (p) { const t = tag('Analog in', 'part'); t.position.copy(p.add(S.pos)); partTags.add(t); }
}
const LAYERS = { pcb: [0, 0], parts: [12, 0], leds: [30, 0], chip: [44, 0], ports: [21, -18], headers: [60, 0] };
function buildLayerTags() {
  if (!S.uno || S.uno.layerTags) return;
  const names = S.uno.layerNames || (S.uno.model === 'uno-r4-wifi'
    ? { pcb: 'Circuit board', parts: 'Regulator, capacitors, reset', leds: 'Status LEDs and 12 × 8 matrix', chip: 'RA4M1 and ESP32-S3', ports: 'USB-C and power jack', headers: 'Headers: digital, power, analog' }
    : { pcb: 'Circuit board', parts: 'Regulator, capacitors, crystal, reset', leds: 'L, TX, RX and ON LEDs', chip: 'ATmega328P and 16U2', ports: 'USB-B and power jack', headers: 'Headers: digital, power, analog' });
  S.uno.layerTags = [];
  for (const [k, name] of Object.entries(names)) {
    const t = tag(name, 'layer'); t.position.set(S.uno.W ? S.uno.W / 2 + 4 : 38, 3 + (S.uno.lift || 0), 0); t.visible = false; S.uno.layers[k].add(t); S.uno.layerTags.push(t);
  }
}
function setExplode(on) {
  S.explodeTo = on ? 1 : 0; $('t-explode').setAttribute('aria-pressed', String(on));
  if (S.view === 'scan') { flyScan(1.1, on ? 1.45 : 1); return; }
  if (on) { flyTo([S.pos.clone().add(new THREE.Vector3(14, 30, 0))], { radius: 250, phi: 1.22, theta: 0.32 }); }
  else flyHome(1.1);
}
function stepExplode(dt) {
  if (!S.uno) return;
  const before = S.explode;
  S.explode += Math.sign(S.explodeTo - S.explode) * Math.min(Math.abs(S.explodeTo - S.explode), dt / (REDUCED ? 0.01 : 0.9));
  const e = easeInOut(S.explode);
  if (S.view === 'scan') {
    if (S.scan && before !== S.explode) explodeScan(S.scan.built, e);
    if ((before < 0.02) !== (S.explode < 0.02) || (before > 0.01) !== (S.explode > 0.01)) updatePartTags();
    return;
  }
  for (const [k, [y, x]] of Object.entries(LAYERS)) { S.uno.layers[k].position.set(x * e, y * e, 0); }
  const show = S.explode < 0.02;
  marksGroup.visible = wiresGroup.visible = show;
  if (S.bb) S.bb.group.visible = show && S.bbIn > 0;
  for (const t of S.uno.layerTags || []) t.visible = S.explode > 0.85;
  if ((before < 0.02) !== (S.explode < 0.02) || (before > 0.01) !== (S.explode > 0.01)) updatePartTags();
}

// ---------- camera ----------
const sph = new THREE.Spherical();
const HOME = { target: new THREE.Vector3(2, 6, 4), radius: 300, phi: 0.95, theta: 0.18 };
/** HOME framed for the board in view: the UNO's view, widened for a board that reaches further left (Mega, Pi). */
function homeView() {
  const left = S.pos.x - (S.uno?.W ?? 68.58) / 2, extra = Math.max(0, (UNO_POS.x - 68.58 / 2) - left);
  if (extra) return { ...HOME, target: HOME.target.clone().add(new THREE.Vector3(-extra / 2, 0, 0)), radius: HOME.radius + extra * 1.6 };
  // a stick-sized board (ESP32, Nano, Pico): come closer, a little toward it
  if (S.uno?.W && S.uno.W * S.uno.H < 2000) return { ...HOME, target: HOME.target.clone().add(new THREE.Vector3(-14, 4, 0)), radius: 235 };
  return HOME;
}
const WAIT = { target: UNO_POS.clone().add(new THREE.Vector3(0, 4, 0)), radius: 190, phi: 0.95, theta: 0.5 };
function camState() { sph.setFromVector3(camera.position.clone().sub(controls.target)); return { target: controls.target.clone(), radius: sph.radius, phi: sph.phi, theta: sph.theta }; }
function setCam(s) { sph.set(s.radius, s.phi, s.theta); camera.position.copy(s.target).add(new THREE.Vector3().setFromSpherical(sph)); controls.target.copy(s.target); camera.lookAt(s.target); }
function flyTo(points, opts = {}) {
  const pts = points.filter(Boolean); if (!pts.length) return;
  const box = new THREE.Box3().setFromPoints(pts), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
  const now = camState();
  const to = { target: c, radius: opts.radius ?? Math.min(320, Math.max(185, size * 2.0 + 120)), phi: opts.phi ?? Math.min(1.05, Math.max(0.7, now.phi)), theta: opts.theta ?? now.theta };
  startFly(now, to, opts.dur ?? 1.3);
}
const fit = v => ({ ...v, radius: v.radius * Math.max(1, 1.3 / camera.aspect) });   // portrait screens: step back
function flyHome(dur = 1.3) { if (S.view === 'scan' && S.scan) { flyScan(dur); return; } startFly(camState(), fit(S.model ? homeView() : WAIT), dur); }
/** Frames the scanned object: radius from its displayed size and the 30° lens. */
function flyScan(dur = 1.3, zoom = 1) {
  const b = S.scan.built, sz = b.size.clone().multiplyScalar(b.scale);
  const span = Math.max(sz.x, sz.z, sz.y * 1.4, 30);
  const radius = Math.max(110, span / (2 * Math.tan(15 * Math.PI / 180)) * 1.25 * zoom);
  controls.maxDistance = Math.max(520, radius * 1.6);
  startFly(camState(), fit({ target: new THREE.Vector3(0, sz.y * (zoom > 1 ? 0.9 : 0.4), 0), radius, phi: 0.98, theta: 0.32 }), dur);
}
function startFly(from, to, dur) {
  let dTheta = to.theta - from.theta; dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
  S.fly = { from, to: { ...to, theta: from.theta + dTheta }, t: 0, dur: REDUCED ? 0.01 : dur };
}
function stepFly(dt) {
  if (!S.fly) return;
  const f = S.fly; f.t = Math.min(1, f.t + dt / f.dur); const e = easeInOut(f.t);
  setCam({ target: f.from.target.clone().lerp(f.to.target, e), radius: THREE.MathUtils.lerp(f.from.radius, f.to.radius, e), phi: THREE.MathUtils.lerp(f.from.phi, f.to.phi, e), theta: THREE.MathUtils.lerp(f.from.theta, f.to.theta, e) });
  if (f.t >= 1) S.fly = null;
}
controls.addEventListener('start', () => { S.fly = null; controls.autoRotate = false; });

// ---------- picking + tooltip ----------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const tipEl = $('tip');
function pickAt(x, y) {   // x, y in stage pixels
  const r = stage.getBoundingClientRect();
  ndc.set((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (S.view === 'scan') return null;
  const objs = [S.uno?.pick, S.bb?.group.visible && S.bbIn >= 1 ? S.bb.pick : null].filter(Boolean);
  const hit = ray.intersectObjects(objs, false)[0];
  if (!hit) return null;
  const m = new THREE.Matrix4(); hit.object.getMatrixAt(hit.instanceId, m);
  const pos = new THREE.Vector3().setFromMatrixPosition(m.premultiply(hit.object.matrixWorld));
  if (hit.object.userData.pick === 'pin') {
    const k = S.uno.pickKeys[hit.instanceId], info = infoFor(k);
    const said = S.current.find(c => c.from?.key === k || c.to?.key === k);
    return { pos, title: info.name, body: info.fn, said: said ? `Ody: ${said.label}` : '' };
  }
  const h = S.bb.holes[hit.instanceId], info = bbInfo(h);
  const said = S.current.find(c => c.to?.hole?.key === h.key || c.from?.hole?.key === h.key);
  return { pos, title: info.name, body: info.fn, said: said ? `Ody: ${said.label}` : '' };
}
function showTip(p, x, y) {
  if (!p) { tipEl.hidden = true; hover.visible = false; return; }
  tipEl.hidden = false;
  tipEl.querySelector('strong').textContent = p.title;
  const span = tipEl.querySelector('span'); span.textContent = p.body;
  let said = tipEl.querySelector('.said'); if (!said) { said = document.createElement('span'); said.className = 'said'; tipEl.append(said); }
  said.textContent = p.said; said.hidden = !p.said;
  const r = stage.getBoundingClientRect();
  tipEl.style.left = `${Math.min(x, r.width - 280)}px`; tipEl.style.top = `${Math.max(40, y)}px`;
  hover.position.copy(p.pos).add(new THREE.Vector3(0, 0.2, 0)); hover.visible = true;
}
let pointer = null, pointerDirty = false;
canvas.addEventListener('pointermove', e => { const r = stage.getBoundingClientRect(); pointer = { x: e.clientX - r.left, y: e.clientY - r.top }; pointerDirty = true; });
canvas.addEventListener('pointerleave', () => { pointer = null; if (!S.tipPinned) showTip(null); });
let downAt = null;
canvas.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
  const r = stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const p = pickAt(x, y); S.tipPinned = p ? { p, x, y } : null; showTip(p, x, y);
});

// ---------- export ----------
async function exportGlb() {
  const swapped = [];
  twin.traverse(o => {
    if (o.userData.noExport || o.isLine || o.userData.glowShell || o.isCSS2DObject) { swapped.push([o, 'visible', o.visible]); o.visible = false; return; }
    if (o.userData.real && o.material !== o.userData.real) { swapped.push([o, 'material', o.material]); o.material = o.userData.real; }
    else if (o.isMesh && o.material?.isShaderMaterial) {
      swapped.push([o, 'material', o.material]);
      const c = new THREE.Color(o.userData.exportColor ?? COLORS.holo);
      o.material = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1, roughness: 0.4 });
    }
  });
  try {
    return await new GLTFExporter().parseAsync(twin, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
  } finally { for (const [o, k, v] of swapped.reverse()) o[k] = v; }
}
async function downloadGlb() {
  try {
    const buf = await exportGlb();
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const what = S.view === 'scan' && S.scan ? S.scan.spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'scan' : 'twin';
    const name = `ody-${what}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.glb`;
    const url = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`Exported ${name}`);
  } catch (e) { toast('Export failed. Try again after the board loads.'); console.warn('[twin] export', e); }
}
async function copyWiring() {
  const text = wiringText();
  if (!text) { toast('No wires to copy yet'); return; }
  try { await navigator.clipboard.writeText(text); toast('Wiring copied'); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); toast('Wiring copied'); }
}
let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2400); }

// ---------- hands ----------
const gestures = createGestures();
let hands = null, gestureOut = null;
async function toggleHands() {
  const btn = $('t-hands');
  if (hands) { hands.stop(); hands = null; btn.setAttribute('aria-pressed', 'false'); $('handview').hidden = true; $('cursor').hidden = true; return; }
  btn.disabled = true; btn.textContent = 'Starting camera…';
  try {
    const { startHands } = await import('./hands.js');
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('camera or model took too long')), 20000));
    hands = await Promise.race([startHands({ preview: $('handcanvas'), onHands: (h, t) => { gestureOut = gestures.update(h, t); } }), timeout]);
    btn.setAttribute('aria-pressed', 'true'); $('handview').hidden = false; $('privacy').hidden = false;
  } catch (e) {
    console.warn('[twin] hands', e); toast('Camera or hand tracking isn’t available here'); btn.hidden = true;
  } finally { btn.disabled = false; btn.textContent = 'Hands'; }
}
function stepHands() {
  const g = gestureOut; if (!g) return; gestureOut = null;
  const cur = $('cursor'), r = stage.getBoundingClientRect();
  $('handmode').textContent = { none: g.hands ? 'Hand seen' : 'Show a hand', rotate: 'Turning', zoom: 'Zooming', grab: 'Moving', palm: 'Hold to reset', point: 'Pointing' }[g.mode] || 'Hand seen';
  if (g.cursor) { cur.hidden = false; cur.style.left = `${g.cursor.x * r.width}px`; cur.style.top = `${g.cursor.y * r.height}px`; cur.style.setProperty('--d', (g.mode === 'point' || g.mode === 'palm') ? g.dwell.toFixed(2) : 0); }
  else cur.hidden = true;
  if (g.rotate[0] || g.rotate[1] || g.pan[0] || g.pan[1] || g.zoom !== 1 || g.reset) {
    S.fly = null; controls.autoRotate = false;
    const home = S.model ? homeView() : WAIT;
    const now = camState();
    const next = applyToCamera({ ...now, target: now.target.toArray() }, g, { ...home, target: home.target.toArray() });
    if (g.reset) { flyHome(0.9); toast('View reset'); } else setCam({ ...next, target: new THREE.Vector3().fromArray(next.target) });
  }
  if (g.select) { const x = g.select.x * r.width, y = g.select.y * r.height; const p = pickAt(x, y); S.tipPinned = p ? { p, x, y } : null; showTip(p, x, y); }
}

// ---------- scan anything ----------
const fmt = n => n >= 100 ? Math.round(n / 5) * 5 : Math.round(n);
function addScan(ev, { show = true } = {}) {
  const spec = ev?.spec;
  if (!spec || !Array.isArray(spec.parts) || typeof spec.name !== 'string') return;
  // the photo is our own agent's JPEG; accept only a plain base64 JPEG
  const photo = typeof ev.photo === 'string' && /^[A-Za-z0-9+/=]+$/.test(ev.photo) && ev.photo.length < 3_000_000 ? `data:image/jpeg;base64,${ev.photo}` : '';
  // a known board: the scanner's model, or (library boards) the scanned name matched against the part aliases
  const byName = S.lookup[normAlias(spec.name)];
  const known = isBoard(spec.known_model) ? spec.known_model : isPart(byName) ? byName : null;
  const entry = { id: S.scans.length + 1, spec, photo, crop: Array.isArray(ev.crop) && ev.crop.length === 4 ? ev.crop.map(Number) : null, known, built: null, at: ev.at || Date.now() };
  S.scans.push(entry);
  if (S.scans.length > 12) { const old = S.scans.shift(); if (old.built) { if (S.scan === old) showBoard({ fly: false }); disposeScan(old.built); } }
  if (known) { setPart(known); if (show) showBoard(); }
  else if (show) showScan(entry);
  renderScans();
}
function showScan(entry) {
  if (S.scan && S.scan !== entry) scanGroup.remove(S.scan.built.group);
  if (!entry.built) {
    entry.built = buildScan(entry.spec, entry.photo, entry.crop); decorate(entry.built.group);
    for (const m of entry.built.meshes) m.userData.holoMat.uniforms.uMapAmt.value = 0.38;   // a photo is busier than a silkscreen: keep the glow readable
  }
  S.scan = entry; S.view = 'scan';
  if (!scanGroup.children.includes(entry.built.group)) scanGroup.add(entry.built.group);
  explodeScan(entry.built, easeInOut(S.explode));
  applyLook(entry.built.group);
  if (S.uno) S.uno.group.visible = false;
  marksGroup.visible = wiresGroup.visible = false;
  if (S.bb) S.bb.group.visible = false;
  scanGroup.visible = true;
  document.body.classList.add('has-part');
  S.tipPinned = null; showTip(null);
  controls.autoRotate = false;
  const s = entry.spec, d = s.dims_mm;
  $('part').textContent = s.name;
  $('partsub').textContent = `About ${fmt(d.w)} × ${fmt(d.d)} × ${fmt(d.h)} mm`;
  $('scaninfo').hidden = false;
  $('scanphoto').hidden = !entry.photo; if (entry.photo) $('scanphoto').src = entry.photo;
  $('scanconf').textContent = `${Math.round(s.confidence * 100)}% sure`;
  $('scanparts').textContent = `${s.parts.length} part${s.parts.length === 1 ? '' : 's'}${entry.built.scale < 1 ? `, shown at ${Math.round(entry.built.scale * 100)}%` : ''}`;
  updatePartTags(); renderScans();
  if (!S.replaying) flyScan(1.5);
}
function showBoard({ fly = true } = {}) {
  if (S.scan) scanGroup.remove(S.scan.built.group);
  S.scan = null; S.view = 'board';
  scanGroup.visible = false;
  if (S.uno) S.uno.group.visible = true;
  marksGroup.visible = wiresGroup.visible = S.explode < 0.02;
  controls.maxDistance = 520;
  document.body.classList.toggle('has-part', !!S.model);
  boardPanel(); updatePartTags(); renderScans();
  if (fly && !S.replaying) flyHome(1.3);
}
function renderScans() {
  const ul = $('scans'); ul.replaceChildren();
  const items = [];
  if (S.model) items.push({ label: nameOf(S.model), where: 'board', on: S.view === 'board', go: () => showBoard() });
  for (const e of [...S.scans].reverse()) {
    if (e.known) continue;
    items.push({ label: e.spec.name, where: `${Math.round(e.spec.confidence * 100)}%`, on: S.scan === e, go: () => showScan(e) });
  }
  for (const it of items) {
    const el = li(it.on ? 'scan on' : 'scan', it.label, it.where, it.go);
    el.querySelector('button').setAttribute('aria-current', String(it.on));
    ul.append(el);
  }
  $('scans-empty').hidden = items.length > 0;
}

// ---------- WebSocket (same feed as the call view) ----------
function resetCall() {
  S.turns = []; S.callMarks = []; S.current = []; S.done = false;
  if (S.view === 'scan') showBoard({ fly: false });
  for (const e of S.scans) if (e.built) disposeScan(e.built);
  S.scans = []; renderScans();
  for (const w of S.wires.values()) void w; S.wires.clear();
  clearGroup(marksGroup); clearGroup(wiresGroup); renderLists(); setStep('Waiting for the call to start');
}
function handle(ev) {
  if (!ev || typeof ev.type !== 'string') return;
  switch (ev.type) {
    case 'hello':
      resetCall();
      callState(ev.call?.state);
      if (ev.brain) $('brain').textContent = String(ev.brain).slice(0, 24);
      S.replaying = true;
      if (ev.part) setPart(ev.part.model, ev.part.label);
      for (const t of (Array.isArray(ev.turns) ? ev.turns : []).slice(-20)) applyTurn(t, { animate: false });
      { const sc = (Array.isArray(ev.scans) ? ev.scans : []).slice(-12); sc.forEach((x, i) => addScan(x, { show: i === sc.length - 1 })); }
      S.replaying = false;
      if (ev.step) setStep(ev.step, S.done);
      if (S.model) S.bbIn = 1;
      if (S.model || S.scan) flyHome(1.2);
      break;
    case 'call':
      if (ev.state === 'live' && !document.body.classList.contains('live')) resetCall();
      callState(ev.state); break;
    case 'brain': $('brain').textContent = String(ev.brain || '').slice(0, 24); break;
    case 'part': setPart(ev.model, ev.label); break;
    case 'turn': applyTurn(ev); break;
    case 'scan': addScan(ev); break;
    case 'step': setStep(ev.text, ev.done); if (ev.done) S.done = true; break;
    default: break;
  }
}
function callState(state) {
  document.body.classList.toggle('live', state === 'live');
  $('status').textContent = state === 'live' ? 'Live call' : state === 'ended' ? 'Call ended' : 'Waiting for a call';
}
let wsDelay = 500;
function connect() {
  let ws;
  try { ws = new WebSocket(`ws://${location.host}`); } catch { setTimeout(connect, wsDelay); return; }
  ws.onopen = () => { wsDelay = 500; };
  ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch (err) { console.warn('[twin] bad event', err); } };
  ws.onclose = () => { callState(null); setTimeout(connect, wsDelay); wsDelay = Math.min(wsDelay * 2, 5000); };
}

// ---------- controls ----------
$('t-holo').addEventListener('click', () => setHolo(!S.holo));
$('t-explode').addEventListener('click', () => setExplode(S.explodeTo < 1));
$('t-reset').addEventListener('click', () => { S.tipPinned = null; showTip(null); flyHome(1.0); });
$('reset2').addEventListener('click', () => { S.tipPinned = null; showTip(null); flyHome(1.0); });
$('t-hands').addEventListener('click', toggleHands);
$('export').addEventListener('click', downloadGlb);
$('copy').addEventListener('click', copyWiring);
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'h') setHolo(!S.holo);
  else if (k === 'e') setExplode(S.explodeTo < 1);
  else if (k === 'r') flyHome(1.0);
  else if (k === 'x') downloadGlb();
  else if (k === 'escape') { S.tipPinned = null; showTip(null); }
  else return;
  e.preventDefault();
});

// ---------- size + loop ----------
function resize() {
  const r = stage.getBoundingClientRect(), w = Math.max(1, r.width), h = Math.max(1, r.height);
  renderer.setPixelRatio(pixelRatio); renderer.setSize(w, h, false);
  composer.setPixelRatio(pixelRatio); composer.setSize(w, h);
  labels.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

const fpsEl = $('fps'); const showFps = new URLSearchParams(location.search).has('fps'); fpsEl.hidden = !showFps;
let last = performance.now(), acc = 0, frames = 0, slow = 0;
const stats = { ms: 0, fps: 0 };
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  clock.value += dt;
  stepFly(dt); stepExplode(dt); stepHands();
  if (S.bb && S.bbIn > 0 && S.bbIn < 1) { S.bbIn = Math.min(1, S.bbIn + dt / 0.9); }
  if (S.bb) { const e = easeInOut(Math.min(1, S.bbIn)); S.bb.group.scale.set(1, Math.max(0.001, e), 1); S.bb.group.visible = S.bbIn > 0 && S.explode < 0.02 && S.view === 'board'; }
  controls.update(dt);
  scene.traverseVisible(o => { if (o.userData.update) o.userData.update(); });
  if (S.uno) for (const l of S.uno.layers.leds.children) if (l.userData.blink) {
    const on = S.done ? (Math.floor(clock.value * 2) % 2 === 0) : false;
    l.userData.holoMat.uniforms.uOpacity.value = on ? 3 : 1; l.userData.real.emissiveIntensity = on ? 3 : 0.25;
  }
  if (pointerDirty && pointer && !S.tipPinned) { pointerDirty = false; showTip(pickAt(pointer.x, pointer.y), pointer.x, pointer.y); }
  composer.render(dt);
  labels.render(scene, camera);
  // frame time: drop bloom resolution, then pixel ratio, if the laptop can't hold 60 fps
  acc += dt; frames++;
  if (acc >= 1) {
    stats.fps = frames / acc; stats.ms = 1000 * acc / frames; acc = 0; frames = 0;
    if (showFps) fpsEl.textContent = `${stats.fps.toFixed(0)} fps · ${stats.ms.toFixed(1)} ms · bloom ${bloomScale} · dpr ${pixelRatio}`;
    if (stats.fps < 52 && document.visibilityState === 'visible') { if (++slow >= 3) { slow = 0; if (bloomScale > 0.3) bloomScale = 0.3; else if (pixelRatio > 1.25) pixelRatio = 1.25; else if (pixelRatio > 1) pixelRatio = 1; resize(); } } else slow = 0;
  }
}

// ---------- start ----------
(async () => {
  setHolo(true);
  resize(); setCam(fit(WAIT)); controls.autoRotate = !REDUCED; controls.autoRotateSpeed = 0.8;
  try { S.table = await loadPins(); } catch (e) { toast('Pin table missing: the twin can’t place pins'); console.warn(e); return; }
  try {   // the other boards (twin/parts.json, generated from data/parts); without it the twin stays UNO-only
    const r = await fetch('/twin/parts.json');
    if (r.ok) { const b = await r.json(); if (b?.parts && typeof b.parts === 'object') { S.parts = b.parts; S.lookup = b.lookup || {}; } }
  } catch (e) { console.warn('[twin] parts', e); }
  S.bb = buildBreadboard(); S.bb.group.position.copy(BB_POS); S.bb.group.visible = false; decorate(S.bb.group); twin.add(S.bb.group); applyLook(S.bb.group);
  showModel('uno-r3');
  resize();
  requestAnimationFrame(frame);
  connect();
  import('./hands.js').then(m => m.handsAvailable()).then(ok => { $('t-hands').hidden = !ok; }).catch(() => {});
})();

// for tests: a read-only view of what the page placed, and the export as bytes
window.mentorTwin = {
  showScan: i => { const e = S.scans[i]; if (e && !e.known) showScan(e); else showBoard(); },
  setLook: holo => setHolo(!!holo),
  boardState: () => ({ model: S.model, built: S.uno?.model || null, pins: S.uno?.pickKeys.length || 0, name: S.model ? nameOf(S.model) : '', part: $('part').textContent, sub: $('partsub').textContent,
    meshes: (() => { let n = 0; S.uno?.group.traverse(o => { if (o.isMesh) n++; }); return n; })(), flying: !!S.fly, explode: S.explode }),
  pinTip: k => infoFor(k),
  scanState: () => ({ view: S.view, scans: S.scans.map(e => ({ name: e.spec.name, known: e.known, parts: e.spec.parts.length })), current: S.scan?.spec.name || null,
    flying: !!S.fly, meshes: S.scan?.built.meshes.length || 0, photoLoaded: !!S.scan?.built.atlas.userData.photo, explode: S.explode, fps: stats.fps }),
  state: () => ({ model: S.model, holo: S.holo, explode: S.explode, wires: [...S.wires.keys()], marks: S.current.map(c => ({ label: c.label, kind: c.kind, from: c.from, to: c.to })), fps: stats.fps, ms: stats.ms, step: S.step }),
  pinWorld: k => S.uno?.pinPos(k)?.add(S.pos).toArray(),
  pinScreen: k => { const p = S.uno?.pinPos(k)?.add(S.pos).project(camera); const r = stage.getBoundingClientRect(); return p && [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; },
  exportBytes: async () => { const b = new Uint8Array(await exportGlb()); return { magic: String.fromCharCode(...b.slice(0, 4)), length: b.length }; },
};
