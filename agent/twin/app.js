// Ody's digital twin, the hero of the laptop app: when Ody recognises the board on the call, it shows it in 3D, with
// Ody's rings, warnings and wires on the exact pins. Events come from the app shell's one WebSocket (shell.js); this
// module only listens (and obeys the agent's voice commands for the view: {type:'twin', action}).
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
import { createGestures, applyToCamera, createInertia } from './gestures.js';
import { createHandUI, toStage } from './handui.js';
import { cleanChange, describeChange, capture, transition as morphPart } from './modify.js';
import { buildScan, explodeScan, disposeScan } from './scan.js';
import { subscribe, swapped, send as sendUp } from './shell.js';
import { customPart, customKey } from './custom.js';
import { createCircuitView, legendHex, makeJumper } from './circuit3d.js';
import { buildInterior, explodeInterior, setInteriorXray, setInteriorLook, pickInterior, partInfo, highlightInterior, interiorItems, interiorBox, disposeInterior } from './interior.js';

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

let viewRoll = 0;   // radians about the view axis (two-hand twist), > 0 = the model turned clockwise on screen
const S = {
  table: null, model: null, uno: null, unos: {}, bb: null, holo: true, explode: 0, explodeTo: 0,
  turns: [], callMarks: [], wires: new Map(), current: [], step: '', done: false, bbIn: 0, fly: null, tipPinned: null,
  scans: [], scan: null, view: 'board',   // "scan anything": every object scanned this call; view = what the stage shows
  parts: {}, tables: {}, lookup: {}, pos: UNO_POS.clone(),   // library boards (twin/parts.json) and where the board sits
  callState: null, customKey: '', off: { x: 0, y: 0 }, tipKey: null, pinIdx: -1, handsWhy: '',
};
// ---------- which board: the UNO (pins.js + board.js) or a library board (partpins.js + parts3d.js) ----------
const isPart = m => PART_MODELS.includes(m) && !!S.parts[m];   // 'custom' too, once a spec arrived
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
  if (S.scan?.I) setInteriorLook(S.scan.I, on);   // after applyLook, which resets materials
  if (C.view) { C.view.setLook(on); renderProject(); }
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
    u.group.updateMatrixWorld(true); u.box = new THREE.Box3().setFromObject(u.group);   // for framing (layers at rest)
  }
  S.uno = S.unos[want];
  S.pos.copy(S.uno.group.position);
  S.uno.group.visible = S.view === 'board';
  twin.add(S.uno.group);
  applyLook(S.uno.group);
  buildLayerTags(); updatePartTags(); renderPins(); partsChanged();
}
function partsChanged() { if (P.sel) selectPart(null, { quiet: true }); P.anim = []; renderPartsPanel(); queueParts(); }

/** A `part` event for a board described by its headers: (re)builds the 'custom' model when the spec changes. */
function registerCustom(ev) {
  const p = customPart(ev);
  if (!p) { console.warn('[twin] custom board without a usable headers spec; keeping the current view'); return false; }
  const k = customKey(p);
  if (k === S.customKey) return true;
  S.customKey = k; S.parts.custom = p; delete S.tables.custom;
  const old = S.unos.custom;
  if (old) {
    if (S.uno === old) { twin.remove(old.group); S.uno = null; }
    old.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    delete S.unos.custom;
    if (S.model === 'custom') { showModel('custom'); boardPanel(); if (!S.replaying) flyHome(1.2); }
  }
  return true;
}

function boardPanel() {
  $('part').textContent = S.model ? nameOf(S.model) : 'No board yet';
  $('partsub').textContent = isPart(S.model) ? (S.uno?.sub || '') : S.model === 'uno-r4-wifi' ? 'USB-C, 12 × 8 LED matrix, Wi-Fi' : S.model ? 'USB-B, ATmega328P' : 'Ody names the board as soon as it sees it.';
  $('scaninfo').hidden = true;
}
function setPart(model, label) {
  if (!isBoard(model)) {
    if (model === 'other' && !S.model) { $('part').textContent = String(label || 'A board Ody can’t model yet').slice(0, 60); $('partsub').textContent = 'The twin covers Arduino UNO, Nano and Mega, ESP32, NodeMCU, Raspberry Pi and Pico, and boards Ody can describe pin by pin.'; }
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
  const marks = Array.isArray(turn.marks) ? turn.marks.filter(m => m && typeof m === 'object').slice(0, 12) : [];
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
        if (r.kind !== 'warn') {   // the label waits for the wire to arrive, then sits on its apex
          const t = tag(`${targetName(T(), S.model, r.from)} → ${targetName(T(), S.model, r.to)}`, 'wire'); t.position.copy(mid); t.visible = false; w.add(t);
          const grow = w.userData.update, born = clock.value;
          w.userData.update = () => { grow(); t.visible = clock.value - born > 1.15; };
        }
        S.wires.set(id, { ...r, obj: w });
      }
      if (r.kind === 'warn') {
        for (const [p, end] of [[a, r.from], [b, r.to]]) { const ring = makeRing(COLORS.warn, { radius: 2.1, warn: true }); ring.position.copy(p).add(new THREE.Vector3(0, 0.15, 0)); marksGroup.add(ring); }
        const t = tag(r.label || 'Stop', 'warn', /^stop/i.test(r.label) ? '' : 'Stop'); t.position.copy(a); marksGroup.add(t);
      }
      focus.push(a, b, S.wires.get(id)?.obj.userData.curve.getPoint(0.5));   // the arc's top too, so its label stays in view
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
  pointing();
  renderLists();
  updatePartTags();
  if (animate && !S.replaying) { if (turn.done) flyHome(1.6); else if (focus.length) flyTo(focus); }
}

function setStep(text) { S.step = String(text || '').slice(0, 160); }   // the rail's step is drawn by shell.js
/** "Ody is pointing at …" on the stage: the current marks, in the same words as on the phone. */
function pointing() {
  const labels = [...new Set(S.current.filter(c => c.from).map(c => c.label || targetName(T(), S.model, c.from)).filter(Boolean))];
  const on = labels.length && S.view === 'board';
  $('pointing').hidden = !on;
  if (on) $('pointingText').textContent = `Ody is pointing at ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ` and ${labels.length - 3} more` : ''}`;
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
  if (!builtIn(S.view)) return;
  if (S.view === 'scan') {
    if (!S.scan || S.explode > 0.01 || (S.scan.I && xray?.own && xray.on)) return;   // x-ray / exploded: the interior's own names
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
  const gone = new Set((P.cache.get(S.uno) || []).filter(q => q.removed).map(q => q.id));
  const FEAT_PART = { usb: 'usb', esp: 'esp32', matrix: 'matrix', chip: 'mcu', jack: 'jack', reset: 'reset' };
  for (const k of keys) { if (gone.has(FEAT_PART[k])) continue; const p = S.uno.featurePos(k); if (!p) continue; const t = tag(k === 'usb' && S.model === 'uno-r3' ? 'USB-B' : F[k], 'part'); t.position.copy(p.add(S.pos)); partTags.add(t); }
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
  requestAnimationFrame(renderPartsPanel);
  if (S.view === 'scan') { flyScan(1.1, on ? 1.45 : 1); return; }
  if (!builtIn(S.view)) { if (on && S.view === 'circuit') { S.explodeTo = 0; $('t-explode').setAttribute('aria-pressed', 'false'); toast('Explode works on the Board and Scan views'); } return; }
  if (on && S.uno?.box) {   // frame the whole stack: layers rise up to ~60 mm, their name tags sit to the right
    const b = S.uno.box.clone(); b.max.y += 64; b.max.x += 48; b.min.x -= 4;
    startFly(camState(), fitBox(b, { phi: 1.18, theta: 0.32 }, 1.04), 1.3);
  } else flyHome(1.1);
}
function stepExplode(dt) {
  if (!S.uno) return;
  const before = S.explode;
  S.explode += Math.sign(S.explodeTo - S.explode) * Math.min(Math.abs(S.explodeTo - S.explode), dt / (REDUCED ? 0.01 : 0.9));
  const e = easeInOut(S.explode);
  if ((before < 0.5) !== (S.explode < 0.5)) renderPartsPanel();
  if (!builtIn(S.view)) { if (before !== S.explode) { try { MODES.get(S.view)?.explode?.(e); } catch (err) { console.warn('[twin] mode explode', err); } } return; }
  if (S.view === 'scan') {
    if (S.scan && before !== S.explode) { if (S.scan.I) explodeInterior(S.scan.I, e); else explodeScan(S.scan.built, e); }
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
// The stage is shared with the phone card and the toolbar, so "framed" means: everything that matters (board +
// breadboard, or the scan) fits inside the free part of the stage, measured, not guessed. The camera's principal point
// is moved to the middle of that free area with a view offset, so orbiting still turns around the content.
const sph = new THREE.Spherical();
const HOME = { phi: 0.95, theta: 0.18 }, WAIT_ANGLES = { phi: 0.95, theta: 0.5 };
const stageSize = () => { const r = stage.getBoundingClientRect(); return { w: Math.max(1, r.width), h: Math.max(1, r.height), r }; };
function setOffset(cam, o, w, h) {
  const ax = Math.abs(o.x), ay = Math.abs(o.y), fw = w + 2 * ax, fh = h + 2 * ay;
  cam.aspect = fw / fh;
  if (ax < 0.5 && ay < 0.5) cam.clearViewOffset(); else cam.setViewOffset(fw, fh, o.x > 0 ? 0 : 2 * ax, o.y > 0 ? 0 : 2 * ay, w, h);
  cam.updateProjectionMatrix();
}
function applyOffset(o) { S.off = { x: o.x, y: o.y }; const { w, h } = stageSize(); setOffset(camera, S.off, w, h); }
/** Free rectangles of the stage (stage px): the whole stage minus the title, the toolbar, and each side of the phone. */
function freeRects() {
  const { w, h, r } = stageSize();
  if (swapped() || w < 300) return [{ l: 6, t: 6, r: w - 6, b: h - 6 }];
  const base = { l: 20, t: w < 700 ? 70 : 92, r: w - 20, b: h - (w < 700 ? 70 : 78) };
  const pr = $('phone').getBoundingClientRect();
  const p = { l: pr.left - r.left, t: pr.top - r.top, r: pr.right - r.left, b: pr.bottom - r.top };
  if (p.r <= 0 || p.l >= w || p.b <= 0 || p.t >= h) return [base];
  return [{ ...base, l: Math.max(base.l, p.r + 14) }, { ...base, r: Math.min(base.r, p.l - 14) }, { ...base, b: Math.min(base.b, p.t - 14) }, { ...base, t: Math.max(base.t, p.b + 14) }]
    .filter(q => q.r - q.l > 140 && q.b - q.t > 120);
}
const fitCam = new THREE.PerspectiveCamera(), corner = new THREE.Vector3();
/** Closest orbit radius at (phi, theta) that keeps the whole box inside one of the free rects; returns the camera state. */
function fitBox(box, { phi, theta }, pad = 1) {
  const { w, h } = stageSize(), c = box.getCenter(new THREE.Vector3());
  const pts = []; for (let i = 0; i < 8; i++) pts.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
  let best = null;
  for (const q of freeRects()) {
    const off = { x: (q.l + q.r) / 2 - w / 2, y: (q.t + q.b) / 2 - h / 2 };
    fitCam.copy(camera); setOffset(fitCam, off, w, h);
    const x0 = q.l / w * 2 - 1, x1 = q.r / w * 2 - 1, y0 = 1 - q.b / h * 2, y1 = 1 - q.t / h * 2;
    const fits = d => {
      sph.set(d, phi, theta); fitCam.position.copy(c).add(new THREE.Vector3().setFromSpherical(sph)); fitCam.lookAt(c); fitCam.updateMatrixWorld();
      for (const p of pts) {
        corner.copy(p).applyMatrix4(fitCam.matrixWorldInverse); if (corner.z > -fitCam.near) return false;
        corner.applyMatrix4(fitCam.projectionMatrix);
        if (corner.x < x0 || corner.x > x1 || corner.y < y0 || corner.y > y1) return false;
      }
      return true;
    };
    let lo = 20, hi = 3000; if (!fits(hi)) continue;
    for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
    if (!best || hi < best.radius) best = { target: c, radius: hi * pad, phi, theta, off };
  }
  return best || { target: c, radius: 320, phi, theta, off: { x: 0, y: 0 } };
}
/** What the board view shows: the board, plus the breadboard (it grows in once a board is known). */
function boardBox() {
  const box = new THREE.Box3();
  if (S.uno?.box) box.copy(S.uno.box); else box.setFromCenterAndSize(UNO_POS.clone().add(new THREE.Vector3(0, 6, 0)), new THREE.Vector3(68.6, 14, 53.3));
  if (S.model) box.union(new THREE.Box3(new THREE.Vector3(BB_POS.x - BB.w / 2, 0, -BB.d / 2), new THREE.Vector3(BB_POS.x + BB.w / 2, BB.h + 2, BB.d / 2)));
  return box;
}
function homeView() { return fitBox(boardBox(), S.model ? HOME : WAIT_ANGLES, 1.04); }
function camState() { sph.setFromVector3(camera.position.clone().sub(controls.target)); return { target: controls.target.clone(), radius: sph.radius, phi: sph.phi, theta: sph.theta, off: { ...S.off } }; }
function setCam(s) {
  if (s.off) applyOffset(s.off);
  sph.set(s.radius, s.phi, s.theta); camera.position.copy(s.target).add(new THREE.Vector3().setFromSpherical(sph)); controls.target.copy(s.target); camera.lookAt(s.target);
}
function flyTo(points, opts = {}) {
  const pts = points.filter(Boolean); if (!pts.length) return;
  const box = new THREE.Box3().setFromPoints(pts), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
  const now = camState(), phi = opts.phi ?? Math.min(1.05, Math.max(0.7, now.phi)), theta = opts.theta ?? now.theta;
  // measured, like home: the marks (+ 18 mm around them) fill the free part of the stage, never closer than a hand's width
  const pad = new THREE.Vector3(18, 10, 18), v = fitBox(new THREE.Box3(box.min.clone().sub(pad), box.max.clone().add(pad)), { phi, theta }, 1.05);
  void size; v.radius = opts.radius ?? Math.min(520, Math.max(170, v.radius));
  startFly(now, v, opts.dur ?? 1.3);
}
function flyHome(dur = 1.3) {
  if (S.view === 'scan' && S.scan) { flyScan(dur); return; }
  if (!builtIn(S.view)) { const b = MODES.get(S.view)?.box?.(); if (b && !b.isEmpty()) startFly(camState(), fitBox(b, HOME, 1.06), dur); return; }
  startFly(camState(), homeView(), dur);
}
/** Frames the scanned object (zoom > 1 steps back for the exploded view). */
function flyScan(dur = 1.3, zoom = 1) {
  const b = S.scan.built, sz = b.size.clone().multiplyScalar(b.scale);
  const box = S.scan.I ? interiorBox(S.scan.I, zoom > 1 ? 1 : 0)   // an interior opens along its own axis: frame the stack
    : new THREE.Box3(new THREE.Vector3(-sz.x / 2, 0, -sz.z / 2), new THREE.Vector3(sz.x / 2, sz.y * (zoom > 1 ? 2.2 : 1), sz.z / 2));
  if (S.scan.I) zoom = Math.min(zoom, 1.1);
  const v = fitBox(box, { phi: 0.98, theta: 0.32 }, 1.1 * zoom);
  v.radius = Math.max(90, v.radius);
  controls.maxDistance = Math.max(520, v.radius * 1.6);
  startFly(camState(), v, dur);
}
function startFly(from, to, dur) {
  controls.maxDistance = Math.max(520, to.radius * 1.4);   // a narrow stage (phone) can need more room than the default
  let dTheta = to.theta - from.theta; dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
  S.fly = { from, to: { ...to, theta: from.theta + dTheta, off: to.off || from.off }, t: 0, dur: REDUCED || dur <= 0 ? 0.01 : dur, rollFrom: viewRoll };
}
function stepFly(dt) {
  if (!S.fly) return;
  const f = S.fly; f.t = Math.min(1, f.t + dt / f.dur); const e = easeInOut(f.t), L = THREE.MathUtils.lerp;
  setCam({ target: f.from.target.clone().lerp(f.to.target, e), radius: L(f.from.radius, f.to.radius, e), phi: L(f.from.phi, f.to.phi, e), theta: L(f.from.theta, f.to.theta, e),
    off: { x: L(f.from.off.x, f.to.off.x, e), y: L(f.from.off.y, f.to.off.y, e) } });
  viewRoll = (f.rollFrom || 0) * (1 - e);   // every framing move stands the view upright again (a two-hand twist rolls it)
  if (f.t >= 1) S.fly = null;
}
/** Keyboard orbit / zoom (arrows, + and −), the same moves as a drag or a wheel. */
function nudge({ dTheta = 0, dPhi = 0, zoom = 1 }) {
  S.fly = null; controls.autoRotate = false;
  const s = camState();
  s.theta += dTheta; s.phi = THREE.MathUtils.clamp(s.phi + dPhi, 0.12, controls.maxPolarAngle);
  s.radius = THREE.MathUtils.clamp(s.radius * zoom, controls.minDistance, controls.maxDistance);
  startFly(camState(), s, 0.22);
}
let dragging = false;
controls.addEventListener('start', () => { S.fly = null; controls.autoRotate = false; dragging = true; spin.stop(); });
controls.addEventListener('end', () => { dragging = false; });

// ---------- picking + tooltip ----------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const tipEl = $('tip');
function pickAt(x, y) {   // x, y in stage pixels
  const r = stage.getBoundingClientRect();
  ndc.set((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (partsActive()) { const h = pickPart(); if (h) return partTip(h); }
  if (S.view === 'scan' && S.scan?.I) { const p = pickInterior(S.scan.I, ray); highlightInterior(S.scan.I, p?.mesh || null); return p; }
  if (!boardShown()) return null;
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
  hoverBox.visible = !!p?.part && p.part !== P.sel; if (hoverBox.visible) hoverBox.setFromObject(p.part.objs[0]);
  if (!p) { tipEl.hidden = true; hover.visible = false; return; }
  tipEl.hidden = false;
  tipEl.querySelector('strong').textContent = p.title;
  const span = tipEl.querySelector('span'); span.textContent = p.body;
  let said = tipEl.querySelector('.said'); if (!said) { said = document.createElement('span'); said.className = 'said'; tipEl.append(said); }
  said.textContent = p.said; said.hidden = !p.said;
  const r = stage.getBoundingClientRect();
  tipEl.style.left = `${Math.min(x, r.width - 280)}px`; tipEl.style.top = `${Math.max(40, y)}px`;
  hover.position.copy(p.pos).add(new THREE.Vector3(0, 0.2, 0)); hover.visible = !p.part;
}
// ---------- pins from the keyboard: the rail's listbox, and [ / ] anywhere ----------
function pinTip(k) {
  if (k.startsWith('i:')) {   // a part inside a scanned object (researched interior)
    const m = S.scan?.I?.meshes[Number(k.slice(2))]; if (!m) return null;
    const p = partInfo(m); return { ...p, said: `Layer: ${p.said}` };
  }
  const info = infoFor(k), said = S.current.find(c => c.from?.key === k || c.to?.key === k);
  return { pos: S.uno.pinPos(k).add(S.pos), title: info.name, body: info.fn, said: said ? `Ody: ${said.label}` : '' };
}
function placeKeyTip() {   // the keyboard tooltip follows its pin while the view moves
  if (!S.tipKey || (boardShown() ? !S.uno : !S.tipKey.startsWith('i:'))) return;
  const p = pinTip(S.tipKey); if (!p) return;
  const { w, h } = stageSize(), v = p.pos.clone().project(camera);
  if (v.z > 1) { tipEl.hidden = true; return; }
  showTip(p, (v.x + 1) / 2 * w, (1 - v.y) / 2 * h);
}
function renderPins() {
  const box = $('pins'); box.replaceChildren();
  const inside = S.view === 'scan' && S.scan?.I ? interiorItems(S.scan.I) : null;
  const keys = inside ? inside.map((_, i) => `i:${i}`) : boardShown() && S.uno ? S.uno.pickKeys : [];
  $('pinsTitleText').textContent = inside ? 'Parts inside' : 'Pins';
  box.classList.toggle('parts', !!inside);
  $('pinsHint').textContent = inside ? 'Arrow keys move through the parts and show each one in 3D, front to back. Enter flies the view there.' : 'Arrow keys move through the pins and show each one on the board. Enter flies the view there.';
  $('pinsCount').textContent = keys.length ? String(keys.length) : '';
  S.pinIdx = -1; box.removeAttribute('aria-activedescendant');
  keys.forEach((k, i) => {
    const info = inside ? { name: inside[i].name, fn: inside[i].layer } : infoFor(k), o = document.createElement('div');
    o.id = `pin-${i}`; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', 'false'); o.dataset.key = k;
    const b = document.createElement('b'); b.textContent = info.name; const sp = document.createElement('span'); sp.textContent = info.fn || 'Pin';
    o.append(b, sp); o.addEventListener('click', () => { selectPin(i); box.focus(); });
    box.append(o);
  });
  if (!keys.length) { const e = document.createElement('p'); e.className = 'empty'; e.textContent = S.view === 'scan' ? 'A scanned object has no pins.' : 'Pins appear when Ody knows the board.'; box.append(e); }
  box.tabIndex = keys.length ? 0 : -1;
}
function selectPin(i, { fly = false } = {}) {
  const box = $('pins'), opts = box.querySelectorAll('[role="option"]');
  if (!opts.length) return;
  i = (i + opts.length) % opts.length;
  opts[S.pinIdx]?.setAttribute('aria-selected', 'false');
  S.pinIdx = i; const o = opts[i]; o.setAttribute('aria-selected', 'true'); box.setAttribute('aria-activedescendant', o.id);
  o.scrollIntoView({ block: 'nearest' });
  S.tipKey = o.dataset.key; S.tipPinned = null;
  const t = pinTip(S.tipKey); if (!t) return;
  if (S.scan?.I) highlightInterior(S.scan.I, t.mesh || null); $('announce').textContent = `${t.title}. ${t.body}${t.said ? `. ${t.said}` : ''}`;
  if (fly) flyTo([t.pos], { radius: 150 }); else placeKeyTip();
}
function clearKeyTip() { S.tipKey = null; showTip(null); if (S.scan?.I) highlightInterior(S.scan.I, null); }
$('pins').addEventListener('keydown', e => {
  const n = $('pins').querySelectorAll('[role="option"]').length; if (!n) return;
  const map = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  if (e.key in map) selectPin(S.pinIdx < 0 ? 0 : S.pinIdx + map[e.key]);
  else if (e.key === 'Home') selectPin(0); else if (e.key === 'End') selectPin(n - 1);
  else if (e.key === 'Enter' || e.key === ' ') selectPin(S.pinIdx < 0 ? 0 : S.pinIdx, { fly: true });
  else if (e.key === 'Escape') clearKeyTip();
  else return;
  e.preventDefault(); e.stopPropagation();
});
$('pins').addEventListener('focus', () => { if (S.pinIdx < 0) selectPin(0); });
$('pins').addEventListener('blur', () => { if (!$('pins').contains(document.activeElement)) clearKeyTip(); });

let pointer = null, pointerDirty = false;
canvas.addEventListener('pointermove', e => { const r = stage.getBoundingClientRect(); pointer = { x: e.clientX - r.left, y: e.clientY - r.top }; pointerDirty = true; S.tipKey = null; });
canvas.addEventListener('pointerleave', () => { pointer = null; if (!S.tipPinned) showTip(null); });
let downAt = null;
canvas.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
  const r = stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const p = pickAt(x, y); S.tipPinned = p ? { p, x, y } : null; showTip(p, x, y);
});

// ---------- movable parts: take the twin apart, move, remove, combine, and ask Ody whether it still works ----------
// A part = one real component (board.js partId, an interior part, a circuit component). After Explode, a part is picked
// by click / tap / hand pinch, dragged on a plane facing the camera (Shift: toward / away), removed to the rail's tray
// (Delete, button or voice) and restored. Combine snaps the kept parts back to where they sit on the real thing, shows
// ghost outlines where removed ones were, sends {type:'analyze'} and shows the {type:'analysis'} answer.
const P = { cache: new WeakMap(), owner: new WeakMap(), sel: null, drag: null, handDrag: null, anim: [], morph: [], before: false, analysis: null, waiting: false, sent: '', sendTimer: 0 };
const selBox = new THREE.BoxHelper(undefined, COLORS.mentor); selBox.visible = false; selBox.userData.noExport = true; scene.add(selBox);
const hoverBox = new THREE.BoxHelper(undefined, 0xffffff); hoverBox.visible = false; hoverBox.userData.noExport = true;
hoverBox.material.transparent = true; hoverBox.material.opacity = 0.45; scene.add(hoverBox);
const ghostMat = new THREE.LineDashedMaterial({ color: 0xff9f0a, dashSize: 1.2, gapSize: 0.9, transparent: true, opacity: 0.9, depthWrite: false });   // a gap: amber dashes
const scopeNow = () => (S.view === 'board' || S.view === 'scan' || S.view === 'circuit' ? S.view : null);
const normName = s => String(s || '').toLowerCase().replace(/µ/g, 'u').replace(/[^a-z0-9]+/g, ' ').trim();
function record(id, name, objs, extra = {}) {
  const p = { id, name, objs, home: objs.map(o => o.position.clone()), scale: objs.map(o => o.scale.clone()), removed: false, moved: false, ghost: null, ...extra };
  for (const o of objs) P.owner.set(o, p);
  return p;
}
function boardPartsOf(u) {
  const byId = new Map();
  for (const layer of Object.values(u.layers)) {
    const groups = new Map();
    for (const c of [...layer.children]) {
      const id = c.userData.partId; if (!id) continue;
      let g = groups.get(id);
      if (!g) { g = new THREE.Group(); g.name = u.partNames[id] || id; layer.add(g); groups.set(id, g); }
      g.add(c);   // the group sits at the layer's origin, so the mesh keeps its place
    }
    for (const [id, g] of groups) { const p = byId.get(id); if (p) { p.objs.push(g); p.home.push(g.position.clone()); p.scale.push(g.scale.clone()); P.owner.set(g, p); } else byId.set(id, record(id, u.partNames[id] || id, [g])); }
  }
  return [...byId.values()];
}
function scanPartsOf(e) {
  if (e.I) return interiorItems(e.I).map((it, i) => record(`part-${i}`, it.name || `Part ${i + 1}`, [it.mesh], { layer: it.layer, note: it.note }));
  return e.built.meshes.map((m, i) => record(`part-${i}`, m.name || e.spec.parts[i]?.name || `Part ${i + 1}`, [m], { home0: true }));
}
function circuitPartsOf() {
  const holder = C.view?.group.getObjectByName('Circuit parts'); if (!holder) return [];
  const ids = new Set((C.ev?.layout?.components || []).map(c => c.id));
  return holder.children.filter(w => ids.has(w.children[0]?.userData.circuitId)).map(w => record(w.children[0].userData.circuitId, w.name, [w]));
}
/** The parts on stage now (cached per built model, so removed / moved state survives switching views). */
function stageParts() {
  const scope = scopeNow();
  if (scope === 'board' && S.uno?.partNames) { let r = P.cache.get(S.uno); if (!r) { r = boardPartsOf(S.uno); P.cache.set(S.uno, r); } return r; }
  if (scope === 'scan' && S.scan?.built) { const key = S.scan.I || S.scan.built; let r = P.cache.get(key); if (!r) { r = scanPartsOf(S.scan); P.cache.set(key, r); } return r; }
  if (scope === 'circuit' && C.view) {
    const sig = (C.ev?.layout?.components || []).map(c => c.id).join('|');
    let r = P.cache.get(C.view);
    if (!r || r.sig !== sig) { const old = r?.list || []; const list = circuitPartsOf(); for (const p of list) { const o = old.find(q => q.id === p.id); if (o?.removed) { p.removed = true; hidePart(p, true); } } r = { sig, list }; P.cache.set(C.view, r); }
    return r.list;
  }
  return [];
}
const changed = list => list.some(p => p.removed || p.moved);
/** Parts can be picked and dragged: once the board is exploded (or already changed), any scan, any circuit. */
function partsActive() {
  const s = scopeNow(), list = stageParts(); if (!list.length) return false;
  if (s === 'board') return S.explode > 0.5 || changed(list);
  if (s === 'scan') return !S.scan?.I || S.explode > 0.5 || !!xray?.on || changed(list);
  return s === 'circuit';
}
function pickPart() {   // uses the ray pickAt just set
  const list = stageParts().filter(p => !p.removed); if (!list.length) return null;
  const hits = ray.intersectObjects(list.flatMap(p => p.objs), true);
  for (const h of hits) {
    if (h.object.userData.pick || h.object.isLine || !h.object.visible) continue;
    let o = h.object; while (o && !P.owner.has(o)) o = o.parent;
    if (o) return { part: P.owner.get(o), point: h.point };
  }
  return null;
}
const partCenter = p => new THREE.Box3().setFromObject(p.objs[0]).getCenter(new THREE.Vector3());
function partTip(h) {
  const p = h.part;
  if (p.mod) return { pos: h.point, title: p.name, body: p.modNote || describeChange(p.mod), said: p.base && p.base.name !== p.name ? `Modified from ${p.base.name}` : 'Modified', part: p };
  return { pos: h.point, title: p.name, body: p.note || (P.sel === p ? 'Drag to move it. Shift-drag moves it toward you. Delete removes it.' : 'Click to pick it up.'), said: p.layer ? `Layer: ${p.layer}` : '', part: p };
}
function selectPart(p, { fly = false, quiet = false } = {}) {
  P.sel = p || null;
  selBox.visible = !!p; if (p) { selBox.setFromObject(p.objs[0]); if (!quiet) $('announce').textContent = `${p.name} selected. Delete removes it.`; }
  if (p && fly) flyTo([partCenter(p)], { radius: 240 });
  renderPartsPanel();
}
function movePart(p, dWorld) {
  for (const o of p.objs) {
    const w = o.getWorldPosition(new THREE.Vector3());
    const a = o.parent.worldToLocal(w.clone()), b = o.parent.worldToLocal(w.clone().add(dWorld));
    o.position.add(b.sub(a));
  }
  p.moved = true;
}
function hidePart(p, on) {   // scale, not visibility: modules (circuit) set .visible every frame
  if (p.modTag) p.modTag.visible = !on && !P.before;
  p.objs.forEach((o, i) => { if (on) o.scale.setScalar(1e-4); else o.scale.copy(p.scale[i]); });
}
/** Faint outline where a removed part sits on the real thing. */
function ghostOf(p) {
  if (p.ghost) return p.ghost;
  const g = [];   // one outline holder per mesh, each living in the part's own parent (so it explodes with it)
  p.objs.forEach((o, i) => {
    const s = o.scale.clone(); o.scale.copy(p.scale[i]); o.updateMatrixWorld(true);
    const inv = o.matrixWorld.clone().invert();
    o.traverse(m => {
      if (!m.isMesh || m.isInstancedMesh || !m.geometry || m.userData.pick) return;
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), ghostMat);
      l.computeLineDistances(); l.matrixAutoUpdate = false; l.matrix.copy(inv.clone().multiply(m.matrixWorld)); l.raycast = () => {};
      const holder = new THREE.Group(); holder.name = `Gap: ${p.name}`; holder.userData.noExport = true; holder.position.copy(p.home[i]); holder.add(l); o.parent.add(holder); g.push(holder);
    });
    o.scale.copy(s);
  });
  p.ghost = g; return g;
}
function showGhost(p, on) {
  if (!on && !p.ghost) return;
  const g = ghostOf(p);
  for (const h of g) h.visible = on;
}
function removePart(p, { voice = false, undo = !voice } = {}) {
  if (!p || p.removed) return;
  p.removed = true; hidePart(p, true); showGhost(p, true);
  if (P.sel === p) selectPart(null);
  if (P.handDrag?.part === p) P.handDrag = null;
  hoverBox.visible = false; showTip(null);
  toast(`${voice ? 'Ody: removed' : 'Removed'} ${p.name}`, { voice, ...(undo ? { ms: 6000, action: { label: 'Undo', run: () => restorePart(p) } } : {}) }); updatePartTags();
  $('announce').textContent = `${p.name} removed to the tray.`;
  clearAnalysis(); renderPartsPanel(); queueParts();
}
function restorePart(p, { voice = false, quiet = false } = {}) {
  if (!p) return;
  if (p.removed) { p.removed = false; hidePart(p, false); showGhost(p, false); }
  p.objs.forEach((o, i) => animateTo(o, p.home[i]));
  p.moved = false;
  if (!quiet) toast(`${voice ? 'Ody: restored' : 'Restored'} ${p.name}`, { voice });
  updatePartTags();
  clearAnalysis(); renderPartsPanel(); queueParts();
}
function restoreAll({ voice = false } = {}) {
  const list = stageParts(); for (const p of list) restorePart(p, { quiet: true });
  toast(voice ? 'Ody: back to stock' : 'Back to stock', { voice });
}
function animateTo(o, to, dur = 0.85) { P.anim = P.anim.filter(a => a.o !== o); P.anim.push({ o, from: o.position.clone(), to: to.clone(), t: 0, dur: REDUCED ? 0.01 : dur }); }
function stepParts(dt) {
  for (let i = P.morph.length - 1; i >= 0; i--) {
    const m = P.morph[i]; m.t = Math.min(1, m.t + dt / m.dur); m.step(easeInOut(m.t));
    if (m.t >= 1) { m.end(); P.morph.splice(i, 1); }
  }
  CL.group.visible = S.view === 'circuit';
  for (let i = P.anim.length - 1; i >= 0; i--) {
    const a = P.anim[i]; a.t = Math.min(1, a.t + dt / a.dur);
    a.o.position.lerpVectors(a.from, a.to, easeInOut(a.t));
    if (a.t >= 1) P.anim.splice(i, 1);
  }
  if (selBox.visible && P.sel) selBox.setFromObject(P.sel.objs[0]);
}
/** Combine: kept parts snap back together, gaps stay as ghosts; then Ody judges whether it still works. */
function combine({ voice = false } = {}) {
  const list = stageParts(); if (!list.length) return;
  for (const p of list) { if (!p.removed) p.objs.forEach((o, i) => animateTo(o, p.home[i], 1.1)); p.moved = false; showGhost(p, p.removed); }
  if (S.explodeTo > 0) setExplode(false);
  if (scopeNow() === 'scan' && S.scan?.I && list.some(p => p.removed)) setXray(true);   // show the assembled inside, with its gaps
  selectPart(null);
  const kept = list.filter(p => !p.removed).map(p => ({ id: p.id, name: p.name })), removed = list.filter(p => p.removed).map(p => ({ id: p.id, name: p.name }));
  toast(voice ? 'Ody: combined' : 'Combined', { voice });
  const modified = list.filter(p => p.mod && !p.removed).map(p => ({ id: p.id, name: p.name, change: p.mod })).slice(0, 50);
  if (P.before) setBefore(false, { quiet: true });   // combine shows the new design
  if (!removed.length && !modified.length) { clearAnalysis(); renderPartsPanel(); return; }
  const msg = { type: 'analyze', scope: scopeNow(), board: scopeBoard(), kept, removed, ...(modified.length ? { modified } : {}) };
  P.waiting = sendUp(msg); P.analysis = null; P.asked = msg; P.noAnswer = !P.waiting;
  clearTimeout(P.waitTimer);
  if (P.waiting) P.waitTimer = setTimeout(() => { if (P.waiting) { P.waiting = false; P.noAnswer = true; renderAnalysis(); } }, 25000);
  renderAnalysis();
}
const scopeBoard = () => (scopeNow() === 'scan' ? S.scan?.spec?.name || 'scan' : S.model || 'uno-r3');
function clearAnalysis() { P.analysis = null; P.waiting = false; P.noAnswer = false; clearTimeout(P.waitTimer); renderAnalysis(); }
/** "the ESP32", "wifi module", "esp32" -> the part, by id, whole name, or the best word overlap. */
function findPart(target) {
  const list = stageParts(); const t = normName(target); if (!t) return null;
  const exact = list.find(p => normName(p.id) === t || normName(p.name) === t); if (exact) return exact;
  const inName = list.filter(p => normName(p.name).includes(t) || t.includes(normName(p.id).replace(/ /g, '')));
  if (inName.length) return inName.sort((a, b) => a.name.length - b.name.length)[0];
  const words = t.split(' ').filter(w => w.length > 1 && !['the', 'a', 'an', 'part', 'chip', 'module'].includes(w));
  let best = null, score = 0;
  for (const p of list) {
    const n = normName(p.name).split(' '), s = words.reduce((k, w) => k + (n.some(x => x === w) ? 2 : n.some(x => x.startsWith(w) || w.startsWith(x)) ? 1 : 0), 0);
    if (s > score) { score = s; best = p; }
  }
  return score ? best : null;
}
/** {type:'parts'} upstream whenever the stage's part set changes, so voice can name parts. */
function queueParts(force = false) {
  clearTimeout(P.sendTimer);
  P.sendTimer = setTimeout(() => {
    const scope = scopeNow(), list = scope ? stageParts() : [];
    const msg = { type: 'parts', scope: scope || 'board', board: scopeBoard(), parts: list.map(p => ({ id: p.id, name: p.name, ...(p.removed ? { removed: true } : {}) })) };
    const key = JSON.stringify(msg);
    if (force || key !== P.sent) { if (sendUp(msg)) P.sent = key; }
  }, 250);
}
subscribe(e => { if (e.type === '_sock' && e.open) { P.sent = ''; queueParts(true); } });

// rail: the parts list, the removed tray, Combine, and the analysis
function renderPartsPanel() {
  const list = stageParts(), box = $('partsbox');
  box.hidden = !list.length;
  if (!list.length) return;
  $('partsCount').textContent = String(list.length);
  $('partsHint').textContent = partsActive() ? 'Pick a part here or in 3D, drag it, press Delete to remove it. Combine puts the rest back together.' : scopeNow() === 'scan' && S.scan?.I ? 'Explode (E) or X-ray (Y) first, then pick a part.' : 'Explode (E) first, then pick a part and drag it.';
  const ul = $('partsList'); ul.replaceChildren();
  for (const p of list.filter(q => !q.removed)) {
    const li = pEl('li'), b = pEl('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(P.sel === p));
    b.append(pEl('span', 'ico part'), pEl('span', 'what', p.name), pEl('span', p.mod ? 'where mod' : 'where', p.mod ? 'modified' : p.moved ? 'moved' : p.layer || ''));
    if (p.mod) b.title = p.modNote || describeChange(p.mod);
    b.addEventListener('click', () => { if (scopeNow() === 'board' && S.explodeTo < 1 && !changed(list)) setExplode(true); selectPart(P.sel === p ? null : p); });
    li.append(b);
    if (P.sel === p) {   // the picked part's own action, on its row
      const x = pEl('button', 'row-act', 'Remove'); x.type = 'button'; x.setAttribute('aria-label', `Remove ${p.name}`);
      x.addEventListener('click', () => removePart(p)); li.classList.add('has-act'); li.append(x);
    }
    ul.append(li);
  }
  $('partRemove').hidden = !P.sel; $('partRemove').textContent = P.sel ? `Remove ${P.sel.name}` : 'Remove';
  const tray = $('tray'); tray.replaceChildren();
  const gone = list.filter(p => p.removed);
  $('trayBox').hidden = !gone.length;
  for (const p of gone) {
    const li = pEl('li'), b = pEl('button', 'restore'); b.type = 'button'; b.textContent = 'Restore'; b.setAttribute('aria-label', `Restore ${p.name}`);
    b.addEventListener('click', () => restorePart(p));
    li.append(pEl('span', 'ghost-ico'), pEl('span', 'what', p.name), b); tray.append(li);
  }
  $('combine').disabled = false;
}
function renderAnalysis() {
  const a = P.analysis, card = $('analysis'), over = $('analysisCard');
  for (const root of [card, over]) {
    root.hidden = !a && !P.waiting && !P.noAnswer;
    const body = root.querySelector('.an-body'); body.replaceChildren();
    if (!a) {
      if (P.waiting) body.append(pEl('p', 'an-wait', 'Ody is checking whether it still works…'));
      else if (P.noAnswer) body.append(pEl('p', 'an-wait', 'No answer from Ody: the call isn’t connected. Combine again once it is.'));
      continue;
    }
    const head = pEl('div', 'an-head');
    const badges = pEl('span', 'an-badges');
    if (a.modified) badges.append(pEl('span', 'an-badge new', 'New design'));
    badges.append(pEl('span', 'an-badge ' + (a.works ? 'ok' : 'no'), a.works ? 'Works' : 'Won’t work'));
    head.append(pEl('h4', '', a.title || 'What happens now'), badges);
    body.append(head);
    if (a.summary) body.append(pEl('p', 'an-sum', a.summary));
    for (const [k, label] of [['pros', 'Good'], ['cons', 'Lost'], ['needs', 'It needs']]) {
      const items = Array.isArray(a[k]) ? a[k].filter(x => typeof x === 'string' && x.trim()).slice(0, 6) : [];
      if (!items.length || (root === over && k === 'needs')) continue;
      const ul = pEl('ul', 'an-' + k); for (const t of items) ul.append(pEl('li', '', t.slice(0, 200)));
      body.append(pEl('h5', '', label), ul);
    }
    if (a.verdict) body.append(pEl('p', 'an-verdict', a.verdict));
  }
}
function onAnalysis(ev) {
  const s = v => (typeof v === 'string' ? v.slice(0, 400) : '');
  P.analysis = { title: s(ev.title).slice(0, 100), works: ev.works === true, modified: (Array.isArray(ev.modified) && ev.modified.length > 0) || !!P.asked?.modified?.length, summary: s(ev.summary), pros: ev.pros, cons: ev.cons, needs: ev.needs, verdict: s(ev.verdict) };
  P.waiting = false; P.noAnswer = false; clearTimeout(P.waitTimer); renderAnalysis();
  $('analysisCard').hidden = false;
}
$('partRemove').addEventListener('click', () => removePart(P.sel));
$('combine').addEventListener('click', () => combine());
$('restoreAll').addEventListener('click', () => restoreAll());
$('analysisClose').addEventListener('click', () => { $('analysisCard').hidden = true; });

// pointer: pick + drag a part (capture phase on the stage, so OrbitControls never starts a turn under it)
const dragPlane = new THREE.Plane();
function rayAt(x, y) { const r = stage.getBoundingClientRect(); ndc.set((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); }
stage.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target !== canvas || !partsActive()) return;
  const r = stage.getBoundingClientRect(); rayAt(e.clientX - r.left, e.clientY - r.top);
  const h = pickPart(); if (!h) return;
  selectPart(h.part);
  dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), h.point);
  P.drag = { part: h.part, last: h.point.clone(), y: e.clientY, id: e.pointerId, moved: false };
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  controls.enabled = false; S.fly = null; controls.autoRotate = false;
  e.stopPropagation();
}, true);
stage.addEventListener('pointermove', e => {
  if (!P.drag) return;
  const r = stage.getBoundingClientRect();
  if (e.shiftKey) {   // depth: along the view direction
    const d = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar((e.clientY - P.drag.y) * camState().radius * 0.0035);
    movePart(P.drag.part, d); P.drag.last.add(d); dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), P.drag.last);
  } else {
    rayAt(e.clientX - r.left, e.clientY - r.top);
    const hit = ray.ray.intersectPlane(dragPlane, new THREE.Vector3());
    if (hit) { movePart(P.drag.part, hit.clone().sub(P.drag.last)); P.drag.last.copy(hit); }
  }
  P.drag.y = e.clientY; P.drag.moved = true; showTip(null);
  e.stopPropagation();
}, true);
function endDrag(e) {
  if (!P.drag) return;
  const moved = P.drag.moved; P.drag = null; controls.enabled = true;
  if (moved) { clearAnalysis(); renderPartsPanel(); }
  e?.stopPropagation();
}
stage.addEventListener('pointerup', endDrag, true);
stage.addEventListener('pointercancel', endDrag, true);

// ---------- modify: Ody changes a part ("make the tip a brush"), revert, before / after (B) ----------
// {type:'modify', id, scope, target:{id,name}, change:{name?, color?, material?, scale?, shape?, offset_mm?, note}, say}
// carries the part's TOTAL edit from the original; {type:'modify', revert:true, target} undoes it. The morph is
// twin/modify.js; here: find the part, tag it "Modified", list it, and keep Combine / export / the analysis in step.
function scopeTo(scope) {
  if (!scope || scope === scopeNow()) return;
  if (scope === 'board') showBoard({ fly: false });
  else if (scope === 'scan') setMode('scan');
  else if (scope === 'circuit' && MODES.has('circuit')) setMode('circuit');
}
function runMorph(p, which, dur = 0.4) {
  for (const m of P.morph.filter(x => x.p === p)) m.end();
  P.morph = P.morph.filter(x => x.p !== p);
  P.anim = P.anim.filter(a => !p.objs.includes(a.o));
  const tw = morphPart(p, which, { holo: () => S.holo, dur: REDUCED || dur <= 0 ? 0.01 : dur });
  if (dur <= 0) tw.end(); else P.morph.push(tw);
}
function modTag(p) {
  if (!p.mod) { if (p.modTag) { p.modTag.removeFromParent(); p.modTag = null; } return; }
  if (!p.modTag) { p.modTag = tag('Modified', 'mod'); p.objs[0].add(p.modTag); }
  p.modTag.position.copy(p.base.objs[0].lc);
  p.modTag.element.querySelector('span').lastChild.textContent = `Modified: ${p.name}`;
  p.modTag.visible = !p.removed;
}
function designUI() {
  const mods = stageParts().filter(p => p.mod);
  $('designChip').hidden = !mods.length; $('t-before').hidden = !mods.length;
  if (!mods.length && P.before) { P.before = false; $('t-before').setAttribute('aria-pressed', 'false'); }
  for (const p of stageParts()) if (p.modTag) p.modTag.visible = !p.removed && !P.before;
}
function onModify(ev) {
  const t = ev?.target && typeof ev.target === 'object' ? ev.target : {};
  scopeTo(typeof ev.scope === 'string' ? ev.scope : '');
  const list = stageParts();
  const id = typeof t.id === 'string' ? t.id : typeof ev.id === 'string' ? ev.id : '';
  const p = list.find(q => q.id === id) || list.find(q => q.base?.name && normName(q.base.name) === normName(t.name)) || findPart(t.name || id);
  const say = typeof ev.say === 'string' ? ev.say.slice(0, 120) : '';
  if (!p) { toast(`Ody: couldn’t find “${String(t.name || id || 'that part').slice(0, 40)}” to change`, { voice: true }); return; }
  if (P.before) setBefore(false, { quiet: true });
  if (ev.revert === true) {
    if (!p.mod) return;
    p.mod = null; p.name = p.base.name; p.modNote = '';
    runMorph(p, 'before');
    toast(say ? `Ody: ${say}` : `Ody: ${p.name} is back to the original`, { voice: true });
  } else {
    const c = cleanChange(ev.change); if (!c) return;
    capture(p);   // the original, once, before anything changes
    p.mod = c; p.name = c.name || p.base.name; p.modNote = c.note || '';   // the total edit, not a step
    runMorph(p, 'after');
    toast(say ? `Ody: ${say}` : `Ody: changed ${p.name}`, { voice: true });
    $('announce').textContent = `${p.name} modified. ${p.modNote || describeChange(c)}`;
  }
  modTag(p); designUI(); clearAnalysis(); renderPartsPanel(); queueParts(); updatePartTags();
}
function setBefore(on, { quiet = false } = {}) {
  const mods = stageParts().filter(p => p.mod); if (!mods.length) on = false;
  P.before = on; $('t-before').setAttribute('aria-pressed', String(on));
  for (const p of mods) runMorph(p, on ? 'before' : 'after', 0.3);
  designUI();
  if (!quiet && mods.length) toast(on ? 'Showing the original' : 'Showing the new design');
}
/** For export: the modified design, whatever the B toggle shows; returns how to put the view back. */
function designForExport() {
  if (!P.before) return () => {};
  const mods = stageParts().filter(p => p.mod);
  for (const p of mods) runMorph(p, 'after', 0);
  return () => { for (const p of mods) runMorph(p, 'before', 0); };
}

// ---------- checklist: "Parts to get" (voice is the source of truth; a tick here is only this laptop) ----------
const CL = { items: [], have: new Map(), group: new THREE.Group() };
CL.group.name = 'Parts to get'; CL.group.userData.noExport = true; CL.group.visible = false; scene.add(CL.group);
function onChecklist(ev) {
  const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  CL.items = (Array.isArray(ev?.items) ? ev.items : []).slice(0, 40).map((it, i) => ({
    id: s(it?.id, 60) || `item-${i}`, name: s(it?.name, 80), why: s(it?.why, 240), source: s(it?.source, 120),
    qty: Number.isFinite(Number(it?.qty)) && Number(it.qty) > 0 ? Math.min(99, Math.round(Number(it.qty))) : 1,
    status: it?.status === 'have' ? 'have' : 'needed',
    suggested: { part: s(it?.suggested?.part, 120), pins: (Array.isArray(it?.suggested?.pins) ? it.suggested.pins : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 12).map(x => x.trim().slice(0, 120)) },
  })).filter(it => it.name);
  CL.have.clear();   // the whole list arrives each time: Ody's statuses replace local ticks
  renderChecklist(); placeholders();
}
function renderChecklist() {
  const box = $('checkbox'), ul = $('checklist');
  box.hidden = !CL.items.length; ul.replaceChildren(); if (!CL.items.length) return;
  const has = it => (CL.have.has(it.id) ? CL.have.get(it.id) : it.status === 'have');
  const left = CL.items.filter(it => !has(it)).length;
  $('checkCount').textContent = left ? `${left} to get` : 'all here';
  for (const it of CL.items) {
    const have = has(it), li = pEl('li', `ck${have ? ' have' : ''}`), lab = pEl('label', 'ck-row'), cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = have; cb.addEventListener('change', () => { CL.have.set(it.id, cb.checked); renderChecklist(); });
    lab.append(cb, pEl('span', 'ck-name', it.name), pEl('span', 'ck-qty', `× ${it.qty}`));
    li.append(lab);
    if (it.why) li.append(pEl('p', 'ck-why', it.why));
    if (it.suggested.part || it.suggested.pins.length) {
      const d = pEl('details', 'ck-how'); d.append(pEl('summary', '', 'How to wire it'));
      if (it.suggested.part) d.append(pEl('p', 'ck-part', it.suggested.part));
      if (it.suggested.pins.length) { const pins = pEl('ul', 'ck-pins'); for (const t of it.suggested.pins) pins.append(pEl('li', '', t)); d.append(pins); }
      li.append(d);
    }
    if (it.source) li.append(pEl('p', 'ck-src', `Source: ${it.source}`));
    ul.append(li);
  }
}
/** In the circuit view, each part Ody has no model for waits at the breadboard's front edge as a labelled ghost block. */
function placeholders() {
  clearGroup(CL.group);
  const comps = C.ev?.layout?.components || [];
  const known = it => { const n = normName(it.name); return comps.some(c => c.id === it.id || c.part === it.id || (n && [c.label, c.part].some(x => { const m = normName(x); return m && (m === n || m.includes(n) || n.includes(m)); }))); };
  const todo = CL.items.filter(it => !known(it)).slice(0, 8);
  if (!todo.length || !S.bb) return;
  const b = new THREE.Box3().setFromObject(S.bb.group);
  const x0 = (b.isEmpty() ? BB_POS.x - 40 : b.min.x) + 10, z = (b.isEmpty() ? BB_POS.z + 30 : b.max.z) + 16;
  todo.forEach((it, i) => {
    const g = new THREE.Group(); g.name = `To get: ${it.name}`; g.position.set(x0 + i * 22, 6, z);
    const geo = new THREE.BoxGeometry(16, 10, 12);
    const block = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffc845, transparent: true, opacity: 0.12, depthWrite: false }));
    block.raycast = () => {};
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineDashedMaterial({ color: 0xffc845, dashSize: 1.4, gapSize: 1, transparent: true, opacity: 0.9 }));
    edge.computeLineDistances(); edge.raycast = () => {};
    const label = tag(it.name, 'ph', 'To get'); label.position.set(0, 6, 0);
    g.add(block, edge, label); CL.group.add(g);
  });
}

// ---------- export ----------
async function exportGlb() {
  const swapped = [], undoDesign = designForExport();
  twin.traverse(o => {
    if (o.userData.noExport || o.isLine || o.userData.glowShell || o.isCSS2DObject || P.owner.get(o)?.removed) { swapped.push([o, 'visible', o.visible]); o.visible = false; return; }
    if (o.userData.real && o.material !== o.userData.real) { swapped.push([o, 'material', o.material]); o.material = o.userData.real; }
    else if (o.isMesh && o.material?.isShaderMaterial) {
      swapped.push([o, 'material', o.material]);
      const c = new THREE.Color(o.userData.exportColor ?? COLORS.holo);
      o.material = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1, roughness: 0.4 });
    }
  });
  try {
    return await new GLTFExporter().parseAsync(twin, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
  } finally { for (const [o, k, v] of swapped.reverse()) o[k] = v; undoDesign(); }
}
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
function glbName() {
  const what = S.view === 'scan' && S.scan ? S.scan.spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'scan' : 'twin';
  return `ody-${what}-${stamp()}.glb`;
}
function save(buf, name) {
  const url = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.hidden = true; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
/** Export button / X key: build, save, say so, and give focus back to where it was (never strand it on <body>). */
async function downloadGlb() {
  const back = document.activeElement;
  try {
    const buf = await exportGlb(), name = glbName();
    save(buf, name); toast(`Exported ${name}`);
  } catch (e) { toast('Export failed. Try again once the board has loaded.'); console.warn('[twin] export', e); }
  finally { requestAnimationFrame(() => { if (back && back !== document.body && back.isConnected) back.focus({ preventScroll: true }); }); }
}
/** Voice "export": a browser may refuse a download nobody clicked for, so without a recent click we offer one. */
async function voiceExport() {
  let buf;
  try { buf = await exportGlb(); } catch (e) { toast('Ody: export failed, the model isn’t ready yet', { voice: true }); console.warn('[twin] export', e); return; }
  const name = glbName();
  if (navigator.userActivation?.isActive) { save(buf, name); toast(`Ody: exported ${name}`, { voice: true }); return; }
  toast('Ody: export ready', { voice: true, ms: 15000, action: { label: 'Click to save', run: () => { save(buf, name); toast(`Exported ${name}`); } } });
}
async function copyWiring() {
  const text = wiringText();
  if (!text) { toast('No wires to copy yet'); return; }
  try { await navigator.clipboard.writeText(text); toast('Wiring copied'); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); toast('Wiring copied'); }
}
/**
 * Short status lines on the stage, newest on top, up to three at once, each leaving on its own timer. voice: Ody did it
 * from the call. action: one button (e.g. save an export, Undo). The same message again refreshes instead of stacking.
 */
function toast(msg, { voice = false, ms = 2600, action = null } = {}) {
  const box = $('toast');
  const same = [...box.children].find(x => x.dataset.msg === msg);
  if (same) { clearTimeout(same._t); same.remove(); }
  const t = document.createElement('div'); t.className = 'toast-item'; t.dataset.msg = msg; t.classList.toggle('voice', voice);
  const span = document.createElement('span'); span.textContent = msg; t.append(span);
  const drop = () => { clearTimeout(t._t); t.classList.add('out'); setTimeout(() => { t.remove(); box.hidden = !box.children.length; }, REDUCED ? 0 : 150); };
  if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.addEventListener('click', () => { drop(); action.run(); }); t.append(b); }
  box.prepend(t); box.hidden = false;
  while (box.children.length > 3) { const old = box.lastElementChild; clearTimeout(old._t); old.remove(); }
  t._t = setTimeout(drop, ms);
}

// ---------- hands ----------
// Optional: the laptop camera + MediaPipe (twin/hands.js), or ?handsim=1 scripted landmarks (twin/handsim.js) for
// tests. gestures.js turns landmarks into camera moves, part grabs, flick-to-remove and thumbs-up-to-combine; the
// coach, legend, status chip, cursor and skeleton are twin/handui.js. Every hand action also has a mouse / key way.
const HANDSIM = new URLSearchParams(location.search).get('handsim');   // '1' scripted hands, 'deny' a blocked camera
const gestures = createGestures();
const handUI = createHandUI({ reduced: REDUCED, returnFocus: () => $('t-hands'), onRetry: () => toggleHands() });
let hands = null, gestureOut = null, handInfo = { lowLight: false }, handTip = false, handHover = null, combineAsk = 0;
const spin = createInertia({ decay: 0.92 });   // a turn let go mid-move coasts to a stop (not with reduced motion)
const MAX_ROLL = Math.PI / 3;
/** Screen-space turn [dx, dy] -> the unrolled camera's frame, so dragging right still turns right on a rolled view. */
const unroll = ([x, y]) => (viewRoll ? [x * Math.cos(-viewRoll) - y * Math.sin(-viewRoll), x * Math.sin(-viewRoll) + y * Math.cos(-viewRoll)] : [x, y]);
function turnBy(rotate) {
  const now = camState();
  const next = applyToCamera({ ...now, target: now.target.toArray() }, { rotate: unroll(rotate), pan: [0, 0], zoom: 1, reset: false }, null);
  setCam({ ...next, target: new THREE.Vector3().fromArray(next.target) });
}
/** Render-loop step of the coasting turn: stops for any other camera move. */
function stepSpin(dt) {
  if (!spin.active) return;
  if (dragging || S.fly || !hands) { spin.stop(); return; }
  const d = spin.step(dt); if (d[0] || d[1]) turnBy(d);
}
/** Detection can outpace the render loop: keep the newest pose, but add up the motion and keep every one-shot event. */
function mergeGestures(a, b) {
  if (!a) return b;
  return { ...b, rotate: [a.rotate[0] + b.rotate[0], a.rotate[1] + b.rotate[1]], pan: [a.pan[0] + b.pan[0], a.pan[1] + b.pan[1]], zoom: a.zoom * b.zoom, pull: a.pull + b.pull,
    reset: a.reset || b.reset, thumbsUp: a.thumbsUp || b.thumbsUp, flick: b.flick || a.flick, select: b.select || a.select,
    roll: (a.roll || 0) + (b.roll || 0), fling: b.fling || a.fling,
    grab: a.grab === 'start' && b.grab !== 'end' ? 'start' : b.grab || (a.grab === 'end' ? 'end' : null) };
}
/** Hands stays in the toolbar; when it can't work it says why instead of vanishing. */
function setHandsWhy(why) {
  const btn = $('t-hands'); S.handsWhy = why;
  btn.replaceChildren('Hands');
  if (why) {
    btn.setAttribute('aria-disabled', 'true'); btn.title = why;
    const sm = document.createElement('small'); sm.textContent = 'unavailable'; btn.append(' ', sm);
    $('handsWhy').textContent = `Hand control is off: ${why.replace(/\.$/, '')}.`;
  } else { btn.removeAttribute('aria-disabled'); btn.title = 'Control the view with your hands (camera)'; $('handsWhy').textContent = 'Hand control uses this laptop’s camera. Video never leaves it.'; }
}
async function checkHands() {
  let why = '';
  if (HANDSIM) { setHandsWhy(''); return; }
  try { const m = await import('./hands.js'); if (!(await m.handsAvailable())) why = 'this browser can’t open a camera or the hand model is missing'; }
  catch { why = 'the hand tracking files are missing on this laptop'; }
  if (!why && navigator.mediaDevices?.enumerateDevices) {
    try { const d = await navigator.mediaDevices.enumerateDevices(); if (!d.some(x => x.kind === 'videoinput')) why = 'no camera found on this laptop'; } catch { /* ask on click */ }
  }
  setHandsWhy(why);
}
const handsError = e => /NotAllowed|Security/.test(e?.name) ? 'camera permission was blocked; allow it in the address bar and try again'
  : /NotFound|NotReadable|Overconstrained|NotSupported/.test(e?.name) ? 'no usable camera found on this laptop'
  : /too long/.test(e?.message) ? 'the hand model took too long to load' : 'hand tracking couldn’t start here';
async function toggleHands() {
  const btn = $('t-hands');
  if (btn.getAttribute('aria-busy') === 'true') return;
  if (S.handsWhy) { handUI.showHelp({ title: 'Hands aren’t available here', body: `Hand control is off: ${S.handsWhy.replace(/\.$/, '')}.` }); return; }
  if (hands) { stopHands(); return; }
  btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Starting camera…';
  try {
    const mod = HANDSIM ? await import('./handsim.js') : await import('./hands.js');
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('camera or model took too long')), 45000));   // hands.js times both delegates; software GL is slow
    gestures.reset();
    hands = await Promise.race([mod.startHands({ deny: HANDSIM === 'deny', onHands: (h, t, info) => { if (info) handInfo = info; gestureOut = mergeGestures(gestureOut, gestures.update(h, t, info)); } }), timeout]);
    btn.setAttribute('aria-pressed', 'true'); handUI.start(hands.video);
    $('announce').textContent = 'Hand control on. Open hand to point, pinch to grab, two hands to zoom, a fist to reset.';
    handUI.maybeCoach();
  } catch (e) {
    console.warn('[twin] hands', e?.name || e);
    if (/NotAllowed|Security/.test(e?.name)) {   // not permanent: allowing the camera and pressing Hands again works
      handUI.showHelp({ title: 'The camera is blocked', body: 'Allow the camera for this page (the camera icon in the address bar), then try again. The picture stays on this laptop.', retry: true });
    } else { setHandsWhy(handsError(e)); handUI.showHelp({ title: 'Hands couldn’t start', body: `Hand control is off: ${S.handsWhy}.` }); }
  } finally {
    btn.removeAttribute('aria-busy');
    if (!S.handsWhy) btn.textContent = 'Hands';
  }
}
function stopHands() {
  hands?.stop(); hands = null; gestureOut = null; spin.stop();
  $('t-hands').setAttribute('aria-pressed', 'false'); handUI.stop(); dropHandDrag(true);
  if (handTip) { showTip(null); handTip = false; } handHover = null;
  $('announce').textContent = 'Hand control off.';
}
function dropHandDrag(quiet = false) {
  if (!P.handDrag) return;
  const { part, moved } = P.handDrag; P.handDrag = null;
  if (moved) { clearAnalysis(); renderPartsPanel(); }
  if (!quiet) $('announce').textContent = `Dropped ${part.name}.`;
}
/** Thumbs up asks first; a second thumbs up (or the toast's button) within 6 s combines. */
function thumbsCombine() {
  const list = stageParts();
  if (!list.length || !partsActive()) { toast('Thumbs up combines the parts once it’s taken apart (Explode)'); return; }
  const now = performance.now();
  if (now - combineAsk < 6000) { combineAsk = 0; combine(); return; }
  combineAsk = now;
  toast('Combine the parts? Thumbs up again to confirm', { ms: 6000, action: { label: 'Combine', run: () => { combineAsk = 0; combine(); } } });
}
/** The tester drawer's Hands row: which MediaPipe delegate won the start-up timing and what one detection costs. */
function handPerf() {
  const el = $('handPerf'); if (!el) return;
  const t = !hands ? 'Off' : hands.sim ? 'Simulated' : `${handInfo.delegate || '…'} in the ${handInfo.where || 'page'}, detect ${handInfo.detectMs != null ? handInfo.detectMs.toFixed(1) : '–'} ms, page ${handInfo.mainMs != null ? handInfo.mainMs.toFixed(1) : '–'} ms${handInfo.bench ? ` (start: GPU ${handInfo.bench.GPU ?? '–'}, CPU ${handInfo.bench.CPU ?? '–'} ms)` : ''}`;
  if (el.textContent !== t) el.textContent = t;
}
function stepHands() {
  const g = gestureOut; if (!g || !hands) return; gestureOut = null;
  const carried = !!P.handDrag;   // a part was held: letting go drops it, it doesn't throw the view
  const r = stage.getBoundingClientRect(), at = p => toStage(p, r.width, r.height);
  const coach = handUI.coachOpen(), act = !coach;   // with the coach open, hands can practise turning and zooming, nothing else
  handUI.frame(g);
  handUI.status(handInfo.lowLight ? 'dark' : g.status);
  handUI.legend(g.mode);
  const c = g.cursor ? at(g.cursor) : null;
  let state = 'hover', label = '';
  // pinch: at the start of a pinch on a part (taken apart) grab it; else the pinch turns the view
  if (g.mode === 'rotate' && c) {
    if (!P.handDrag && g.grab === 'start' && act && partsActive()) {
      rayAt(c.x, c.y); const h = pickPart();
      if (h) {
        selectPart(h.part, { quiet: true }); S.fly = null; controls.autoRotate = false;
        dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), h.point);
        P.handDrag = { part: h.part, last: h.point.clone(), moved: false };
        $('announce').textContent = `Holding ${h.part.name}. Move to carry it, bring your hand closer or further for depth, open your hand to drop it.`;
      }
    }
    if (P.handDrag) {
      const dir = camera.getWorldDirection(new THREE.Vector3()), d = P.handDrag;
      if (g.pull) {   // the hand grew (closer to the camera): the part comes toward you
        const step = dir.clone().multiplyScalar(-g.pull * camState().radius * 1.6);
        movePart(d.part, step); d.last.add(step); dragPlane.setFromNormalAndCoplanarPoint(dir, d.last); d.moved = true;
      }
      rayAt(c.x, c.y);
      const hit = ray.ray.intersectPlane(dragPlane, new THREE.Vector3());
      if (hit && hit.distanceTo(d.last) > 0.01) { movePart(d.part, hit.clone().sub(d.last)); d.last.copy(hit); d.moved = true; }
      g.rotate = [0, 0]; state = 'grab'; label = `Holding ${d.part.name}`;
      if (handTip) { showTip(null); handTip = false; }
    } else state = 'pinch';
  } else if (P.handDrag) dropHandDrag();
  // hover: the part or pin under the index fingertip lights up, with its tooltip
  if ((g.mode === 'hover' || g.mode === 'point') && c && !S.tipPinned && !P.drag) {
    const p = pickAt(c.x, c.y); showTip(p, c.x, c.y); handTip = !!p; handHover = p?.part || null;
    if (p) state = 'over';
    if (g.mode === 'point' && g.dwell > 0.12 && g.dwell < 1) state = 'hold';
  } else if (handTip && g.mode !== 'rotate') { showTip(null); handTip = false; handHover = null; }
  if (g.mode === 'fist') { state = 'hold'; label = act ? 'Hold to reset' : ''; }
  else if (g.mode === 'thumbs') { state = 'hold'; label = act ? 'Thumbs up: combine' : ''; }
  else if (g.mode === 'zoom') { state = 'zoom'; label = 'Zooming'; }
  handUI.cursor(c?.x, c?.y, { state, closeness: g.closeness, dwell: g.dwell, label });
  if (!act) g.reset = false;
  if (g.pinching || g.mode === 'zoom' || g.reset) spin.stop();
  if (g.fling && !carried && !REDUCED) spin.fling(...g.fling);
  if (g.roll) {   // two-hand twist: roll about the view axis, within +-60 degrees
    S.fly = null; controls.autoRotate = false;
    viewRoll = THREE.MathUtils.clamp(viewRoll + g.roll, -MAX_ROLL, MAX_ROLL);
  }
  if (g.rotate[0] || g.rotate[1] || g.pan[0] || g.pan[1] || g.zoom !== 1 || g.reset) {
    S.fly = null; controls.autoRotate = false;
    const home = homeView();
    const now = camState();
    const next = applyToCamera({ ...now, target: now.target.toArray() }, { ...g, rotate: unroll(g.rotate) }, { ...home, target: home.target.toArray() });
    if (g.reset) { flyHome(REDUCED ? 0 : 0.9); toast('View reset'); } else setCam({ ...next, target: new THREE.Vector3().fromArray(next.target) });
  }
  if (!act) return;
  if (g.flick && partsActive()) {   // a sideways flick throws the part that was under the ring into the tray
    const f = at(g.flick.from), p = pickAt(f.x, f.y);
    if (p?.part && !p.part.removed) removePart(p.part, { undo: true });
  }
  if (g.thumbsUp) thumbsCombine();
  if (g.select) { const s = at(g.select), p = pickAt(s.x, s.y); S.tipPinned = p ? { p, x: s.x, y: s.y } : null; showTip(p, s.x, s.y); }
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
  const entry = { id: Number.isFinite(Number(ev.id)) ? Number(ev.id) : -(S.scans.length + 1), interior: okInterior(ev.interior), I: null, spec, photo, crop: Array.isArray(ev.crop) && ev.crop.length === 4 ? ev.crop.map(Number) : null, known, built: null, at: ev.at || Date.now() };
  S.scans.push(entry);
  if (S.scans.length > 12) { const old = S.scans.shift(); if (old.built) { if (S.scan === old) showBoard({ fly: false }); if (old.I) disposeInterior(old.I); disposeScan(old.built); } }
  if (known) { setPart(known); if (show) showBoard(); }
  else if (show) showScan(entry);
  renderScans();
}
function showScan(entry) {
  leaveExternal();
  if (S.scan && S.scan !== entry) scanGroup.remove(S.scan.built.group);
  if (!entry.built) {
    entry.built = buildScan(entry.spec, entry.photo, entry.crop); decorate(entry.built.group);
    for (const m of entry.built.meshes) m.userData.holoMat.uniforms.uMapAmt.value = 0.38;   // a photo is busier than a silkscreen: keep the glow readable
  }
  S.scan = entry; S.view = 'scan';
  if (!scanGroup.children.includes(entry.built.group)) scanGroup.add(entry.built.group);
  attachInterior(entry);
  if (entry.I) explodeInterior(entry.I, easeInOut(S.explode)); else explodeScan(entry.built, easeInOut(S.explode));
  applyLook(entry.built.group);
  if (entry.I) { setInteriorLook(entry.I, S.holo); setInteriorXray(entry.I, !!xray?.on && xray.own); }
  interiorPanel();
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
  updatePartTags(); renderScans(); renderPins(); clearKeyTip(); pointing(); partsChanged();
  if (!S.replaying) flyScan(1.5);
}
function showBoard({ fly = true } = {}) {
  leaveExternal();
  if (S.scan?.I) { setInteriorXray(S.scan.I, false); highlightInterior(S.scan.I, null); }
  if (S.scan) scanGroup.remove(S.scan.built.group);
  S.scan = null; S.view = 'board';
  scanGroup.visible = false;
  if (S.uno) S.uno.group.visible = true;
  marksGroup.visible = wiresGroup.visible = S.explode < 0.02;
  controls.maxDistance = 520;
  document.body.classList.toggle('has-part', !!S.model);
  boardPanel(); updatePartTags(); renderScans(); renderPins(); pointing(); interiorPanel(); partsChanged(); queueParts(true);   // a fresh parts list on every mode switch
  if (fly && !S.replaying) flyHome(1.3);
}
// ---------- the voice circuit builder (twin/circuit3d.js): parts on the breadboard, jumpers to exact pins ----------
// {type:'circuit', rev, state, layout, legend, next, sketch, say, change}: the 'circuit' stage mode (board + breadboard +
// the project), auto-shown when a voice change lands; the rail's "Project" section lists parts, the next step, the wire
// legend and the sketch. Built lazily on the first event, so a call without a circuit costs nothing.
const boardShown = () => S.view === 'board' || S.view === 'circuit';
const C = { view: null, ev: null, nextFx: new THREE.Group() };
C.nextFx.name = 'Next step'; C.nextFx.userData.noExport = true;
function circuitView() {
  if (C.view) return C.view;
  C.view = createCircuitView({ boardPin: k => S.uno?.pinPos(k)?.add(S.pos) || null, bbOrigin: BB_POS, label: (text, cls) => tag(text, cls), holo: S.holo, reduced: REDUCED });
  C.view.group.visible = S.view === 'circuit';
  C.view.group.add(C.nextFx);
  twin.add(C.view.group);
  MODES.set('circuit', {
    enter() { if (S.uno) S.uno.group.visible = true; S.bbIn = Math.max(S.bbIn, 0.0001); C.view.group.visible = true; renderProject(); },
    exit() { C.view.group.visible = false; if (G.on) guideStop(); },
    box() { const b = boardBox(); const c = C.view.box(); if (!c.isEmpty()) b.union(c); return b; },
  });
  renderModes();
  return C.view;
}
function resetCircuit() {
  if (!C.view) return;
  C.ev = null; C.view.setState({ layout: { components: [], jumpers: [] } }); clearGroup(C.nextFx); G.on = false; clearGroup(G.fx); renderGuide();
  if (S.view === 'circuit') showBoard({ fly: false });
  MODES.delete('circuit'); renderModes(); renderProject();
}
function onCircuit(ev, { replay = false } = {}) {
  const L = ev?.layout;
  if (!L || !Array.isArray(L.components) || !Array.isArray(L.jumpers)) return;
  const board = ev.state?.board;
  if (typeof board === 'string' && board !== S.model && isBoard(board)) setPart(board);
  if (!S.model) setPart('uno-r3');
  const view = circuitView();
  if (!MODES.has('circuit')) { C.view = null; view.dispose(); return onCircuit(ev, { replay }); }   // after a reset: a fresh view
  C.ev = ev;
  try { view.setState(ev); } catch (e) { console.warn('[twin] circuit', e); }
  const changed = !replay && Array.isArray(ev.change?.applied) && ev.change.applied.length;
  if (S.view !== 'circuit' && (changed || replay || !C.shown)) { C.shown = true; setMode('circuit'); if (changed && !S.holo) setHolo(true); }
  else if (S.view === 'circuit' && changed && !S.replaying) setTimeout(() => flyHome(1.2), 250);   // new parts: re-frame once they are placed
  markNext(); renderProject(); if (S.view === 'circuit') { renderPartsPanel(); queueParts(); } guideSync(); placeholders();
}
// ---------- connection guide: one jumper at a time, drawn from the board pin to its breadboard hole ----------
const G = { on: false, i: 0, list: [], fx: new THREE.Group(), say: '' };
G.fx.name = 'Connection guide'; G.fx.userData.noExport = true;
const endName = e => (e?.board ? `${String(e.board).replace(/\.\d+$/, '')} pin` : e?.rail ? `${e.rail === '+' ? '+' : e.rail === '-' ? '−' : e.rail} rail` : e?.hole ? `hole ${e.hole}` : e?.lead ? `${e.lead} ${e.pin || ''}`.trim() : '?');
function guideList() { return (C.ev?.layout?.jumpers || []).filter(j => j && j.from && j.to); }
function guideShow(i, { fly = true, say = '' } = {}) {
  G.list = guideList(); if (!G.list.length || !C.view) { guideStop(); return; }
  G.on = true; G.i = (i + G.list.length) % G.list.length; G.say = say;
  if (S.view !== 'circuit') setMode('circuit');
  const j = G.list[G.i], wires = C.view.group.getObjectByName('Circuit wires');
  for (const w of wires?.children || []) w.userData.fade = w.name === `Jumper ${j.id}` ? 0.08 : 0.22;   // the step's own wire is redrawn on top
  clearGroup(G.fx); clearGroup(C.nextFx);
  if (!G.fx.parent) C.view.group.add(G.fx);
  const real = wires?.getObjectByName(`Jumper ${j.id}`);
  const a = real?.userData.curve ? real.userData.curve.v0.clone().add(new THREE.Vector3(0, -11, 0)) : null, b = real?.userData.curve ? real.userData.curve.v3.clone().add(new THREE.Vector3(0, -11, 0)) : null;
  if (a && b) {
    const w = makeJumper(a, b, j.color || 'yellow', { delay: 0.25, name: `Guide ${j.id}` }); w.userData.noExport = true;
    applyLookTo(w); G.fx.add(w);
    for (const [p, text] of [[a, endName(j.from)], [b, endName(j.to)]]) {
      const ring = makeRing(COLORS.mentor, { radius: 2.4 }); ring.position.copy(p).add(new THREE.Vector3(0, 0.25, 0)); G.fx.add(ring);
      const t = tag(text, 'mentor'); t.position.copy(p); G.fx.add(t);
    }
    if (fly) flyTo([a, b, real.userData.curve.getPoint(0.5)]);
  }
  renderGuide();
}
function applyLookTo(root) { root.traverse(o => { if (o.userData.real && o.userData.holoMat) o.material = S.holo ? o.userData.holoMat : o.userData.real; }); }
function guideStop() {
  G.on = false; clearGroup(G.fx);
  for (const w of C.view?.group.getObjectByName('Circuit wires')?.children || []) w.userData.fade = 0.999;   // < 1 so the module re-applies full opacity
  markNext(); renderGuide();
}
function guideSync() { if (G.on) guideShow(Math.min(G.i, guideList().length - 1), { fly: false }); else renderGuide(); }
/** {type:'circuit-step', index, total, step}: the voice "next" / "done" / "show me" moves the guide. */
function onCircuitStep(ev) {
  const step = ev?.step || {}, id = String(step.id || '').replace(/^wire:/, '');
  const list = guideList(), k = list.findIndex(j => j.id === id);
  const say = typeof step.say === 'string' ? step.say.slice(0, 200) : '';
  if (k >= 0) guideShow(k, { say });
  else { G.say = say; G.on = G.on && list.length > 0; renderGuide(); if (say) toast(`Ody: ${say}`, { voice: true, ms: 4000 }); }
  if (Number.isFinite(ev.index) && Number.isFinite(ev.total)) G.stepOf = `Step ${ev.index} of ${ev.total}`;
  renderGuide();
}
function renderGuide() {
  const box = $('guide'); if (!box) return;
  const list = guideList();
  box.hidden = !C.ev || !list.length;
  if (box.hidden) return;
  const j = G.on ? list[G.i] : null;
  $('guideStep').textContent = G.on ? `Wire ${G.i + 1} of ${list.length}` : `${list.length} wire${list.length === 1 ? '' : 's'} to connect`;
  $('guideText').textContent = G.on ? (G.say || `${endName(j.from)} → ${endName(j.to)}${j.color ? `, ${j.color} jumper` : ''}`) : 'Walk through them one at a time: the camera flies to each pin and the wire draws itself.';
  $('guideStart').hidden = G.on; $('guidePrev').hidden = $('guideNext').hidden = $('guideStop').hidden = !G.on;
}
$('guideStart').addEventListener('click', () => guideShow(0));
$('guidePrev').addEventListener('click', () => guideShow(G.i - 1));
$('guideNext').addEventListener('click', () => guideShow(G.i + 1));
$('guideStop').addEventListener('click', () => { guideStop(); $('guideStart').focus(); });

/** The next step, highlighted in 3D: a gold ring at each end of its jumper (or over its part) and a "Next" tag. */
function markNext() {
  clearGroup(C.nextFx);
  const n = C.ev?.next; if (!n || !C.view) return;
  let at = null, ends = [];
  const jid = String(n.id || '').replace(/^wire:/, '');
  const wire = C.view.group.getObjectByName(`Jumper ${jid}`);
  if (wire?.userData.curve) {
    const c = wire.userData.curve; at = c.getPoint(0.5);
    ends = [c.v0, c.v3].map(v => v.clone().add(new THREE.Vector3(0, -11, 0)));
  } else {
    const id = n.component || n.from?.component;
    C.view.group.traverse(o => { if (!at && id && o.userData.circuitId === id) { at = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()); at.y += 14; } });
  }
  for (const e of ends) { const r = makeRing(COLORS.mentor, { radius: 2.2 }); r.position.copy(e).add(new THREE.Vector3(0, 0.2, 0)); C.nextFx.add(r); }
  if (at) { const t = tag(`Step ${n.index} of ${n.total}`, 'mentor', 'Next'); t.position.copy(at); C.nextFx.add(t); }
}
const pEl = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
function renderProject() {
  const ev = C.ev, sec = $('project');
  sec.hidden = !ev;
  if (!ev) return;
  const parts = $('project-parts'), code = $('project-code');
  parts.replaceChildren(); code.replaceChildren();
  if (ev.next) {
    const card = pEl('div', 'next-card');
    card.append(pEl('small', '', `Step ${ev.next.index} of ${ev.next.total}`), pEl('p', '', ev.next.say || ev.next.mark?.label || 'Next step'));
    parts.append(card);
  } else if (ev.layout.components.length) parts.append(pEl('div', 'next-card done', 'Every step is done. Upload the sketch.'));
  const comps = ev.state?.components || [];
  const ul = pEl('ul', 'list comps');
  for (const c of ev.layout.components.slice(0, 20)) {
    const li = pEl('li'), b = pEl('button'); b.type = 'button';
    b.append(pEl('span', 'ico part'), pEl('span', 'what', c.label || c.part), pEl('span', 'where', c.part));
    b.title = c.place || ''; b.addEventListener('click', () => { if (S.view !== 'circuit') setMode('circuit'); C.view.group.traverse(o => { if (o.userData.circuitId === c.id) host.fit(new THREE.Box3().setFromObject(o).expandByScalar(25)); }); });
    li.append(b); ul.append(li);
  }
  if (!comps.length && !ev.layout.components.length) parts.append(pEl('p', 'empty', 'Say “add an LED on pin 6” or “add a distance sensor” on the call.'));
  else parts.append(ul);
  if (Array.isArray(ev.legend) && ev.legend.length) {
    const lg = pEl('ul', 'legend');
    for (const l of ev.legend.slice(0, 16)) { const li = pEl('li'), i = pEl('i'); i.style.background = legendHex(l.color, S.holo); li.append(i, pEl('span', '', l.text)); lg.append(li); }
    parts.append(pEl('h4', '', 'Wires'), lg);
  }
  if (typeof ev.sketch === 'string' && ev.sketch.trim()) {
    const d = pEl('details', 'sketch'), sum = pEl('summary', '', 'Arduino sketch'), pre = pEl('pre', '', ev.sketch.slice(0, 20000));
    pre.tabIndex = 0;
    const row = pEl('div', 'sketch-actions'), copy = pEl('button', 'btn', 'Copy sketch'), dl = pEl('button', 'btn', 'Download .ino');
    copy.type = dl.type = 'button';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(ev.sketch); } catch { const t = document.createElement('textarea'); t.value = ev.sketch; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); } toast('Sketch copied'); });
    dl.addEventListener('click', () => { const url = URL.createObjectURL(new Blob([ev.sketch], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = `ody-circuit-${stamp()}.ino`; a.hidden = true; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); toast('Sketch saved'); });
    row.append(copy, dl); d.append(sum, pre, row); code.append(d);
  }
}

// ---------- researched interiors (twin/interior.js): what is inside a scanned object, from public teardowns ----------
/** The interior as sent (research.mjs sanitises it); just enough shape-checking that buildInterior can't trip. */
function okInterior(v) {
  return v && typeof v === 'object' && Array.isArray(v.layers) && v.layers.length && v.layers.every(l => l && Array.isArray(l.parts)) ? v : null;
}
function attachInterior(entry) {
  if (entry.I || !entry.interior || !entry.built) return;
  try { entry.I = buildInterior(entry.built, entry.spec, entry.interior); }
  catch (e) { console.warn('[twin] interior', e); entry.interior = null; entry.I = null; }
}
/** {type:'interior', id, interior}: arrives after its scan (research takes a while); mounts it if that scan is on stage. */
function onInterior(ev) {
  const entry = S.scans.find(x => x.id === Number(ev.id)), it = okInterior(ev.interior);
  if (!entry || !it || entry.known) return;
  if (entry.I) { if (S.scan === entry) setInteriorXray(entry.I, false); disposeInterior(entry.I); entry.I = null; }
  entry.interior = it;
  renderScans();
  if (S.scan === entry) { showScan(entry); toast(`Ody: researched what’s inside the ${entry.spec.name.toLowerCase()}`, { voice: true, ms: 3600 }); }
}
function interiorPanel() {
  const e = S.view === 'scan' ? S.scan : null, it = e?.I ? e.interior : null;
  $('researched').hidden = !it;
  $('interiorinfo').hidden = !it;
  if (xray?.own) { $('t-xray').hidden = !it; if (!it && xray.on) { xray.on = false; $('t-xray').setAttribute('aria-pressed', 'false'); } }
  if (!it) return;
  const n = it.layers.length, parts = it.layers.reduce((a, l) => a + l.parts.length, 0);
  $('insideSum').textContent = `Inside: ${n} layer${n === 1 ? '' : 's'} · researched from public teardowns`;
  $('insideGuess').textContent = [it.model_guess, Number.isFinite(it.confidence) ? `${Math.round(it.confidence * 100)}% sure` : '', `${parts} parts`].filter(Boolean).join(', ');
  const ol = $('layers'); ol.replaceChildren();
  for (const l of it.layers) {
    const li = document.createElement('li'), b = document.createElement('b'), sp = document.createElement('span');
    b.textContent = String(l.name || 'Layer'); sp.textContent = l.parts.map(p => String(p?.name || '')).filter(Boolean).join(', ');
    li.append(b, sp); ol.append(li);
  }
  const ul = $('sources'); ul.replaceChildren();
  for (const src of Array.isArray(it.sources) ? it.sources.slice(0, 6) : []) {
    let u; try { u = new URL(String(src?.url || '')); } catch { continue; }
    if (u.protocol !== 'https:') continue;   // links only to https pages; everything else stays text-free
    const li = document.createElement('li'), a = document.createElement('a');
    a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = String(src.title || u.hostname).slice(0, 80);
    li.append(a); ul.append(li);
  }
  $('sourcesWrap').hidden = !ul.children.length;
  $('insideNote').textContent = String(it.notes || '').slice(0, 300);
  $('insideNote').hidden = !it.notes;
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
  renderModes();
}

// ---------- modes: Board, Scan, and modes other modules mount (e.g. Circuit, from twin/circuit3d.js) ----------
// A mode module calls host.registerMode(name, { enter(), exit(), box?() -> THREE.Box3, explode?(e 0..1) }) once; the
// tab with id mode-<name> (twin.html) appears, and host.setMode(name) shows it. Board and Scan stay built in.
const MODES = new Map();
const builtIn = v => v === 'board' || v === 'scan';
function leaveExternal() { if (!builtIn(S.view)) { const m = MODES.get(S.view); S.view = 'board'; try { m?.exit?.(); } catch (e) { console.warn('[twin] mode exit', e); } } }
function setMode(name) {
  if (name === 'board') return showBoard();
  if (name === 'scan') { const e = S.scan || [...S.scans].reverse().find(x => !x.known); if (e) showScan(e); return; }
  const m = MODES.get(name); if (!m || S.view === name) return;
  leaveExternal();
  if (S.scan) { scanGroup.remove(S.scan.built.group); S.scan = null; }
  scanGroup.visible = false; if (S.uno) S.uno.group.visible = false; if (S.bb) S.bb.group.visible = false;
  marksGroup.visible = wiresGroup.visible = false;
  S.view = name; clearKeyTip(); updatePartTags(); renderPins(); pointing(); renderScans();
  try { m.enter?.(); } catch (e) { console.warn('[twin] mode enter', e); }
  partsChanged(); queueParts(true);
  flyHome(1.2);
}
function renderModes() {
  const tabs = [...$('modes').querySelectorAll('[role="tab"]')];
  for (const t of tabs) {
    const n = t.dataset.mode;
    t.hidden = n === 'board' ? false : n === 'scan' ? !S.scans.some(x => !x.known) : !MODES.has(n);
    const on = S.view === n; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
  }
  $('modes').hidden = tabs.filter(t => !t.hidden).length < 2;
}
$('modes').addEventListener('click', e => { const t = e.target.closest('[role="tab"]'); if (t) setMode(t.dataset.mode); });
$('modes').addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = [...$('modes').querySelectorAll('[role="tab"]:not([hidden])')], i = tabs.indexOf(document.activeElement);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  next.focus(); setMode(next.dataset.mode); e.preventDefault(); e.stopPropagation();
});

// ---------- WebSocket (same feed as the call view) ----------
function resetCall() {
  S.turns = []; S.callMarks = []; S.current = []; S.done = false;
  if (S.view === 'scan') showBoard({ fly: false });
  for (const e of S.scans) if (e.built) { if (e.I) disposeInterior(e.I); disposeScan(e.built); }
  S.scans = []; renderScans();
  for (const w of S.wires.values()) void w; S.wires.clear();
  clearGroup(marksGroup); clearGroup(wiresGroup); renderLists(); setStep(''); pointing();
  resetCircuit();
}
// the part actions land on the board hologram: off the circuit (or an empty) stage, switch to Board first, so
// "explode" / "remove the Wi-Fi module" always act on the board twin. A scan stays when the action fits it
// (no target, or a target that names one of its parts); a circuit stays only for one of its own parts.
const BOARD_ACTS = new Set(['explode', 'assemble', 'remove', 'restore', 'combine', 'select']);
function stageFor(action, target) {
  if (!BOARD_ACTS.has(action)) return;
  const here = S.view === 'scan' && S.scan ? 'scan' : S.view === 'circuit' ? 'circuit' : null;
  let stay = false;
  if (here && target) stay = !!findPart(target);
  else if (here === 'scan') stay = true;
  else if (here === 'circuit' && (action === 'restore' || action === 'combine')) stay = changed(stageParts());
  if (!stay) { if (!S.model) setPart('uno-r3'); if (S.view !== 'board') showBoard(); }
  if (!S.holo) setHolo(true);
}
/** The agent's voice commands for the view ("Ody, explode it"). Unknown actions are ignored. */
function voice(action, target) {
  const say = m => toast(`Ody: ${m}`, { voice: true });
  try { stageFor(action, target); } catch (e) { console.warn('[twin] voice stage', e); }
  switch (action) {
    case 'explode': setExplode(true); say('exploded'); break;
    case 'assemble': setExplode(false); say('assembled'); break;
    case 'rotate': S.fly = null; controls.autoRotate = true; controls.autoRotateSpeed = REDUCED ? 0.3 : 1.1; say('turning slowly'); break;
    case 'stop': controls.autoRotate = false; say('stopped turning'); break;
    case 'reset': clearKeyTip(); flyHome(1.0); say('view reset'); break;
    case 'realistic': setHolo(false); say('realistic look'); break;
    case 'hologram': setHolo(true); say('hologram'); break;
    case 'export': voiceExport(); break;
    case 'select': { const p = findPart(target); if (!p) { say(`couldn’t find “${String(target || '').slice(0, 40)}”`); break; } if (scopeNow() === 'board' && S.explodeTo < 1) setExplode(true); selectPart(p, { fly: true }); say(`picked the ${p.name}`); break; }
    case 'remove': { const p = target ? findPart(target) : P.sel; if (!p) { say(target ? `couldn’t find “${String(target).slice(0, 40)}”` : 'pick a part first'); break; } if (scopeNow() === 'board' && S.explodeTo < 1) setExplode(true); removePart(p, { voice: true }); break; }
    case 'restore': { if (!target) { restoreAll({ voice: true }); break; } const p = findPart(target); if (p) restorePart(p, { voice: true }); else say(`couldn’t find “${String(target).slice(0, 40)}”`); break; }
    case 'combine': combine({ voice: true }); break;
    default: break;
  }
}
function handle(ev) {
  if (!ev || typeof ev.type !== 'string') return;
  switch (ev.type) {
    case 'hello':
      resetCall();
      S.callState = ev.call?.state || null;
      S.replaying = true;
      if (ev.part && (ev.part.model !== 'custom' || registerCustom(ev.part))) setPart(ev.part.model, ev.part.label);
      for (const t of (Array.isArray(ev.turns) ? ev.turns : []).slice(-20)) applyTurn(t, { animate: false });
      { const sc = (Array.isArray(ev.scans) ? ev.scans : []).slice(-12); sc.forEach((x, i) => addScan(x, { show: i === sc.length - 1 })); }
      if (ev.circuit) onCircuit(ev.circuit, { replay: true });
      S.replaying = false;
      if (ev.step) setStep(ev.step);
      if (S.model) S.bbIn = 1;
      if (S.model || S.scan) flyHome(1.2);
      break;
    case 'call':
      if (ev.state === 'live' && S.callState !== 'live') resetCall();
      S.callState = ev.state || null; break;
    case 'part':
      if (ev.model === 'custom' && !registerCustom(ev)) break;
      setPart(ev.model, ev.label); break;
    case 'turn': applyTurn(ev); break;
    case 'scan': addScan(ev); break;
    case 'interior': onInterior(ev); break;
    case 'circuit': onCircuit(ev); break;
    case 'step': setStep(ev.text); if (ev.done) S.done = true; break;
    case 'twin': if (typeof ev.action === 'string') voice(ev.action, typeof ev.target === 'string' ? ev.target.slice(0, 80) : ''); break;
    case 'analysis': onAnalysis(ev); break;
    case 'modify': onModify(ev); break;
    case 'checklist': onChecklist(ev); break;
    case 'circuit-step': onCircuitStep(ev); break;
    default: break;
  }
}

// ---------- controls ----------
$('t-holo').addEventListener('click', () => setHolo(!S.holo));
$('t-explode').addEventListener('click', () => setExplode(S.explodeTo < 1));
// X-ray: hidden until a module (twin/interior.js) offers it through host.enableXray(onToggle)
let xray = { on: false, own: true, onToggle: on => { if (S.scan?.I) { setInteriorXray(S.scan.I, on); updatePartTags(); } } };   // the interior's x-ray; a module may take it over
function setXray(on) { if (!xray) return; xray.on = on; $('t-xray').setAttribute('aria-pressed', String(on)); try { xray.onToggle(on); } catch (e) { console.warn('[twin] x-ray', e); } }
$('t-xray').addEventListener('click', () => setXray(!xray?.on));
$('t-reset').addEventListener('click', () => { S.tipPinned = null; showTip(null); flyHome(1.0); });
$('reset2').addEventListener('click', () => { S.tipPinned = null; showTip(null); flyHome(1.0); });
$('t-hands').addEventListener('click', toggleHands);
$('t-before').addEventListener('click', () => setBefore(!P.before));
// the shortcut sheet (? or the rail's link): a modal with every key, focus kept inside, Esc / Close return focus
let keysBack = null;
function openKeys() { const k = $('keysheet'); if (!k.hidden) return closeKeys(); keysBack = document.activeElement; k.hidden = false; $('ksClose').focus({ preventScroll: true }); }
function closeKeys() { $('keysheet').hidden = true; if (keysBack?.isConnected && keysBack !== document.body) keysBack.focus({ preventScroll: true }); keysBack = null; }
$('keysOpen').addEventListener('click', openKeys);
$('ksClose').addEventListener('click', closeKeys);
$('keysheet').addEventListener('click', e => { if (e.target === $('keysheet')) closeKeys(); });
$('keysheet').addEventListener('keydown', e => {
  if (e.key === 'Escape' || e.key === '?') { closeKeys(); e.preventDefault(); }
  else if (e.key === 'Tab') { e.preventDefault(); $('ksClose').focus(); }   // one control: Tab stays on it
  e.stopPropagation();
});
$('export').addEventListener('click', downloadGlb);
$('copy').addEventListener('click', copyWiring);
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, [role="listbox"]')) return;
  const k = e.key.toLowerCase();
  const onStage = e.target === document.body || e.target === stage || e.target === canvas;
  if (k === 'h') setHolo(!S.holo);
  else if (k === 'e') setExplode(S.explodeTo < 1);
  else if (k === 'r') { clearKeyTip(); flyHome(1.0); }
  else if (k === 'x') downloadGlb();
  else if (k === 'y' && xray && !$('t-xray').hidden) setXray(!xray.on);
  else if (k === 'b' && !$('t-before').hidden) setBefore(!P.before);
  else if (e.key === '?') openKeys();
  else if (k === 'f') { fpsEl.hidden = !fpsEl.hidden; showFps = !fpsEl.hidden; }
  else if (k === ']' || k === '[') selectPin(S.pinIdx < 0 ? (k === ']' ? 0 : -1) : S.pinIdx + (k === ']' ? 1 : -1));
  else if (G.on && S.view === 'circuit' && (k === 'arrowleft' || k === 'arrowright') && (onStage || e.target.closest?.('#guide'))) guideShow(G.i + (k === 'arrowright' ? 1 : -1));
  else if (onStage && k === 'arrowleft') nudge({ dTheta: -0.14 });
  else if (onStage && k === 'arrowright') nudge({ dTheta: 0.14 });
  else if (onStage && k === 'arrowup') nudge({ dPhi: -0.09 });
  else if (onStage && k === 'arrowdown') nudge({ dPhi: 0.09 });
  else if (onStage && (k === '+' || k === '=')) nudge({ zoom: 0.86 });
  else if (onStage && (k === '-' || k === '_')) nudge({ zoom: 1.16 });
  else if ((k === 'delete' || k === 'backspace') && P.sel) removePart(P.sel);
  else if (k === 'escape' && (handUI.coachOpen() || !$('handhelp').hidden)) { handUI.closeCoach(); handUI.hideHelp(); }
  else if (k === 'escape' && (S.tipPinned || S.tipKey || !tipEl.hidden || P.sel)) { S.tipPinned = null; clearKeyTip(); selectPart(null); }
  else return;
  e.preventDefault();
});
addEventListener('ody:layout', () => { resize(); if (S.explodeTo > 0 && builtIn(S.view) && S.view === 'board') setExplode(true); else flyHome(0.5); });

// ---------- size + loop ----------
function resize() {
  const r = stage.getBoundingClientRect(), w = Math.max(1, r.width), h = Math.max(1, r.height);
  renderer.setPixelRatio(pixelRatio); renderer.setSize(w, h, false);
  composer.setPixelRatio(pixelRatio); composer.setSize(w, h);
  labels.setSize(w, h);
  applyOffset(S.off);
}
let refit = 0;   // after the stage changes size, re-frame once it settles (not on every pixel of a drag-resize)
new ResizeObserver(() => { clearTimeout(refit); refit = setTimeout(() => { if (!controls.autoRotate && !dragging) { if (S.explodeTo > 0 && S.view === 'board') setExplode(true); else flyHome(0.4); } }, 250); }).observe(stage);
new ResizeObserver(resize).observe(stage);

const fpsEl = $('fps'); let showFps = new URLSearchParams(location.search).has('fps'); fpsEl.hidden = !showFps;
let last = performance.now(), acc = 0, frames = 0, slow = 0;
const stats = { ms: 0, fps: 0 };
function frame(now) {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000, dt = Math.min(0.05, raw); last = now;
  clock.value += dt;
  stepFly(Math.min(0.25, raw)); stepExplode(Math.min(0.25, raw)); stepHands(); stepSpin(Math.min(0.25, raw)); stepParts(Math.min(0.25, raw));   // camera moves and explode keep wall-clock time on a slow GPU
  if (S.bb && S.bbIn > 0 && S.bbIn < 1) { S.bbIn = Math.min(1, S.bbIn + dt / 0.9); }
  if (S.bb) { const e = easeInOut(Math.min(1, S.bbIn)); S.bb.group.scale.set(1, Math.max(0.001, e), 1); S.bb.group.visible = S.bbIn > 0 && S.explode < 0.02 && boardShown(); }
  controls.update(dt);
  if (viewRoll) camera.rotateZ(viewRoll);   // after OrbitControls' lookAt, which always stands the camera upright
  scene.traverseVisible(o => { if (o.userData.update) o.userData.update(); });
  if (S.uno) for (const l of S.uno.layers.leds.children) if (l.userData.blink) {
    const on = S.done ? (Math.floor(clock.value * 2) % 2 === 0) : false;
    l.userData.holoMat.uniforms.uOpacity.value = on ? 3 : 1; l.userData.real.emissiveIntensity = on ? 3 : 0.25;
  }
  if (pointerDirty && pointer && !S.tipPinned) { pointerDirty = false; showTip(pickAt(pointer.x, pointer.y), pointer.x, pointer.y); }
  if (S.tipKey) placeKeyTip();
  composer.render(dt);
  labels.render(scene, camera);
  if (++declutterTick % 3 === 0) { tightLabels(); declutter(); occlude(); }
  // frame time: drop bloom resolution, then pixel ratio, if the laptop can't hold 60 fps
  acc += dt; frames++;
  if (acc >= 1) {
    stats.fps = frames / acc; stats.ms = 1000 * acc / frames; acc = 0; frames = 0;
    handPerf();
    if (showFps) fpsEl.textContent = `${stats.fps.toFixed(0)} fps, ${stats.ms.toFixed(1)} ms, bloom ${bloomScale}, dpr ${pixelRatio}`;
    if (stats.fps < 52 && document.visibilityState === 'visible') { if (++slow >= 3) { slow = 0; if (bloomScale > 0.3) bloomScale = 0.3; else if (pixelRatio > 1.25) pixelRatio = 1.25; else if (pixelRatio > 1) pixelRatio = 1; resize(); } } else slow = 0;
  }
}

// ---------- labels never hide behind a panel, and turn into numbered dots on a narrow stage ----------
const OVERLAYS = ['handview', 'analysisCard', 'handhelp', 'phone', 'labelkey'];
function occlude() {
  const rects = OVERLAYS.map(id => $(id)).filter(e => e && !e.hidden && e.offsetParent !== null).map(e => e.getBoundingClientRect())
    .concat([...document.querySelectorAll('.coach:not([hidden]) .coach-card, .stage .toolbar')].map(e => e.getBoundingClientRect()));
  for (const t of $('labels').querySelectorAll('.tag')) {
    const s = t.querySelector('span'), dot = t.querySelector('i'); if (!s) continue;
    const a = s.getBoundingClientRect(), d = dot ? dot.getBoundingClientRect() : a;
    const hit = r => (a.left < r.right && a.right > r.left && a.top < r.bottom && a.bottom > r.top) || (d.left < r.right && d.right > r.left && d.top < r.bottom && d.bottom > r.top);
    t.classList.toggle('occluded', rects.some(hit));
  }
}
let tightKey = '';
function tightLabels() {
  const tight = stage.getBoundingClientRect().width < 560;
  document.body.classList.toggle('tight-labels', tight);
  const tags = tight ? [...$('labels').querySelectorAll('.tag:not(.layer)')].filter(t => t.style.display !== 'none') : [];
  const names = tags.map(t => t.querySelector('span')?.textContent || '');
  const key = names.join('|');
  $('labelkey').hidden = !tags.length;
  if (key === tightKey) return; tightKey = key;
  for (const t of $('labels').querySelectorAll('.tag[data-n]')) t.removeAttribute('data-n');
  const order = names.map((n, i) => [n, i]).sort((x, y) => x[0].localeCompare(y[0]));
  const ol = $('labelkeyList'); ol.replaceChildren();
  order.forEach(([n, i], k) => { tags[i].querySelector('span').dataset.n = String(k + 1); tags[i].dataset.n = String(k + 1); ol.append(pEl('li', '', n)); });
  $('labelkeyBtn').textContent = `Labels (${tags.length})`;
}
$('labelkeyBtn').addEventListener('click', () => { const ol = $('labelkeyList'); ol.hidden = !ol.hidden; $('labelkeyBtn').setAttribute('aria-expanded', String(!ol.hidden)); });

// ---------- labels never sit on top of each other: later (lower-priority) labels lift until they are clear ----------
let declutterTick = 0;
const PRIO = { warn: 0, mentor: 1, wire: 2, part: 3 };
function declutter() {
  const tags = [...$('labels').querySelectorAll('.tag:not(.layer)')].filter(t => t.style.display !== 'none');
  if (tags.length < 2) { for (const t of tags) if (t.style.getPropertyValue('--dy')) t.style.removeProperty('--dy'); return; }
  const sr = stage.getBoundingClientRect();
  const items = tags.map(t => {
    const span = t.querySelector('span'), a = t.getBoundingClientRect(), kind = Object.keys(PRIO).find(k => t.classList.contains(k)) || 'part';
    const x = a.left + span.offsetLeft, y = a.top + span.offsetTop;
    return { t, prio: PRIO[kind], x, y, w: span.offsetWidth, h: span.offsetHeight, dx: Math.round(Math.min(0, sr.right - 8 - (x + span.offsetWidth)) + Math.max(0, sr.left + 8 - x)) };
  }).sort((p, q) => p.prio - q.prio || p.y - q.y);
  const placed = [], minY = stage.getBoundingClientRect().top + 8;
  for (const it of items) {
    let dy = Math.min(0, it.y - minY);   // negative: pulled down into the stage when its anchor is near the top
    const hit = d => placed.some(p => it.x < p.x + p.w + 4 && it.x + it.w + 4 > p.x && it.y - d < p.y - p.dy + p.h + 3 && it.y - d + it.h + 3 > p.y - p.dy);
    const dy0 = dy;
    while (dy < 160 && hit(dy)) dy += 8;
    if (dy >= 160) dy = dy0;
    placed.push({ ...it, dy });
    const cur = Number(it.t.style.getPropertyValue('--dy') || 0), curX = Number(it.t.style.getPropertyValue('--dx') || 0);
    if (Math.abs(cur - dy) > 0.5) { if (dy) it.t.style.setProperty('--dy', String(Math.round(dy))); else it.t.style.removeProperty('--dy'); }
    if (curX !== it.dx) { if (it.dx) it.t.style.setProperty('--dx', String(it.dx)); else it.t.style.removeProperty('--dx'); }
  }
}

// ---------- start ----------
(async () => {
  setHolo(true);
  resize(); setCam(homeView()); controls.autoRotate = !REDUCED; controls.autoRotateSpeed = 0.8;
  renderPins(); checkHands();
  try { S.table = await loadPins(); } catch (e) { toast('Pin table missing: the twin can’t place pins'); console.warn(e); return; }
  try {   // the other boards (twin/parts.json, generated from data/parts); without it the twin stays UNO-only
    const r = await fetch('/twin/parts.json');
    if (r.ok) { const b = await r.json(); if (b?.parts && typeof b.parts === 'object') { S.parts = b.parts; S.lookup = b.lookup || {}; } }
  } catch (e) { console.warn('[twin] parts', e); }
  S.bb = buildBreadboard(); S.bb.group.position.copy(BB_POS); S.bb.group.visible = false; decorate(S.bb.group); twin.add(S.bb.group); applyLook(S.bb.group);
  showModel('uno-r3');
  resize(); setCam(homeView());
  requestAnimationFrame(frame);
  subscribe(handle);   // the shell's one socket; replays the last hello and everything since
})();

/**
 * Seams for modules mounted later (twin/interior.js, twin/circuit3d.js): import { host } from './app.js'.
 *  - host.subscribe(fn)                    the shell's event feed (e.g. {type:'circuit'} / {type:'interior'} / scan.interior)
 *  - host.registerMode(name, impl)          adds a stage mode tab (twin.html #mode-<name>): impl { enter, exit, box?, explode?(e) }
 *  - host.setMode(name), host.view()        switch / read what the stage shows ('board' | 'scan' | a mounted mode)
 *  - host.enableXray(onToggle)              shows the X-ray toggle next to Explode (key Y)
 *  - host.project                           the rail's "Project" section (#project, with #project-parts and #project-code)
 *  - host.scene / host.twin / host.camera / host.controls / host.THREE, host.decorate(root) + host.applyLook(root)
 *    give a module's meshes the same hologram/realistic looks; host.toast(msg, {voice}); host.fit(box3) frames a box.
 *  - host.currentScan() the scan on stage ({ spec, built: { group, meshes, ... } }) for interiors.
 */
export const host = {
  THREE, scene, twin, camera, controls, subscribe, toast, decorate, applyLook, setMode,
  view: () => S.view, holo: () => S.holo, explode: () => S.explode, currentScan: () => S.scan,
  registerMode(name, impl) { MODES.set(String(name), impl || {}); renderModes(); },
  enableXray(onToggle) { xray = { on: false, own: false, onToggle }; $('t-xray').hidden = false; },
  fit(box, dur = 1.2) { if (box && !box.isEmpty()) startFly(camState(), fitBox(box, HOME, 1.06), dur); },
  project: { section: $('project'), parts: $('project-parts'), code: $('project-code'), show(on = true) { $('project').hidden = !on; } },
};
window.odyHost = host;

// for tests: a read-only view of what the page placed, and the export as bytes
window.mentorTwin = {
  showScan: i => { const e = S.scans[i]; if (e && !e.known) showScan(e); else showBoard(); },
  setLook: holo => setHolo(!!holo),
  boardState: () => ({ model: S.model, built: S.uno?.model || null, pins: S.uno?.pickKeys.length || 0, name: S.model ? nameOf(S.model) : '', part: $('part').textContent, sub: $('partsub').textContent,
    meshes: (() => { let n = 0; S.uno?.group.traverse(o => { if (o.isMesh) n++; }); return n; })(), flying: !!S.fly, explode: S.explode }),
  pinTip: k => infoFor(k),
  scanState: () => ({ view: S.view, scans: S.scans.map(e => ({ name: e.spec.name, known: e.known, parts: e.spec.parts.length })), current: S.scan?.spec.name || null,
    flying: !!S.fly, meshes: S.scan?.built.meshes.length || 0, photoLoaded: !!S.scan?.built.atlas.userData.photo, explode: S.explode, fps: stats.fps }),
  home: () => { const v = homeView(); return { radius: v.radius, off: v.off, rects: freeRects(), box: boardBox().toArray?.() ?? [boardBox().min.toArray(), boardBox().max.toArray()] }; },
  voice: (a, t) => voice(a, t), inject: ev => handle(ev),
  partsState: () => ({ scope: scopeNow(), active: partsActive(), sel: P.sel?.id || null, before: P.before, parts: stageParts().map(p => ({ id: p.id, name: p.name, removed: p.removed, moved: p.moved, mod: p.mod || null })), analysis: P.analysis, waiting: P.waiting, guide: G.on ? { i: G.i, n: G.list.length } : null }),
  partWorld: id => { const p = stageParts().find(q => q.id === id); return p ? partCenter(p).toArray() : null; },
  camera: () => { const c = camState(); return { radius: c.radius, theta: c.theta, phi: c.phi, pos: camera.position.toArray(), roll: viewRoll, coasting: spin.active }; },
  handsState: () => ({ on: !!hands, sim: !!hands?.sim, coach: handUI.coachOpen(), help: !$('handhelp').hidden, status: handUI.statusKind(), statusText: $('hstatusText').textContent,
    cursor: $('cursor').hidden ? null : $('cursor').style.transform, cursorState: $('cursor').dataset.state || '', label: $('cursor').querySelector('.cur-label').textContent,
    detectMs: handInfo.detectMs ?? null, mainMs: handInfo.mainMs ?? null, where: handInfo.where || null, delegate: handInfo.delegate || null, bench: handInfo.bench || null, perf: $('handPerf')?.textContent || '',
    hover: handHover?.id || null, holding: P.handDrag?.part.id || null, tip: tipEl.hidden ? null : tipEl.querySelector('strong').textContent,
    legend: [...document.querySelectorAll('#handlegend li.on')].map(li => li.dataset.g), toast: $('toast').hidden ? '' : $('toast').textContent }),
  handsPlay: frames => (hands?.play ? hands.play(frames).then(() => true) : Promise.resolve(false)),
  handsHold: (spec, extra) => { hands?.hold?.(spec, extra); return !!hands?.hold; },
  partScreen: id => { const p = stageParts().find(q => q.id === id); if (!p) return null; const v = partCenter(p).project(camera), r = stage.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; },
  fitted: () => ({ off: { ...S.off }, ...(c => ({ radius: c.radius, phi: c.phi, theta: c.theta }))(camState()) }),
  labelBoxes: () => [...$('labels').querySelectorAll('.tag:not(.layer)')].filter(t => t.style.display !== 'none').map(t => { const r = t.querySelector('span').getBoundingClientRect(); return [r.left, r.top, r.width, r.height, t.className]; }),
  state: () => ({ model: S.model, holo: S.holo, explode: S.explode, autoRotate: controls.autoRotate, wires: [...S.wires.keys()], marks: S.current.map(c => ({ label: c.label, kind: c.kind, from: c.from, to: c.to })), fps: stats.fps, ms: stats.ms, step: S.step }),
  partSize: id => { const p = stageParts().find(q => q.id === id); return p ? new THREE.Box3().setFromObject(p.objs[0]).getSize(new THREE.Vector3()).toArray() : null; },
  checklistState: () => ({ items: CL.items.map(it => ({ id: it.id, status: it.status, have: CL.have.get(it.id) ?? null })), placeholders: CL.group.children.map(g => g.name), visible: CL.group.visible }),
  pinWorld: k => S.uno?.pinPos(k)?.add(S.pos).toArray(),
  pinScreen: k => { const p = S.uno?.pinPos(k)?.add(S.pos).project(camera); const r = stage.getBoundingClientRect(); return p && [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; },
  exportBytes: async () => { const b = new Uint8Array(await exportGlb()); return { magic: String.fromCharCode(...b.slice(0, 4)), length: b.length }; },
};
