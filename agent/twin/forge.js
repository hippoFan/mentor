// The Forge (right page): every design on this laptop, from three places — a call's scans (saved by Argos with their
// photo), Argos refinements (new versions linked to their parent) and files imported from the user's computer.
// Gallery (filters, version chains, honest badges) -> viewer (three.js, holo or forge-lit) -> convert (STL, OpenSCAD,
// Arduino sketch), schematic on demand (schematic + routed PCB + KiCad files of the design's circuit, POST
// /argos/designs/<id>/schematic), refine with Argos, import, delete. Data: /argos/designs (argos/server.mjs). Names and notes are
// always set with textContent, never as HTML.
//
//   const forge = mountForge(rootEl, { subscribe, openRefine });
//     subscribe(fn) -> unsubscribe   delivers every page-socket event (shell.js); The Forge reads hello, call, scan,
//                                    circuit and {type:'argos'} design/refine events
//     openRefine(id)                 switch to Argo with the Argos panel on its Refine tab, this design selected
//   forge.refresh()  forge.open(id)  forge.close()  forge.destroy()
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { holoMaterial } from './holo.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const FILTERS = [['all', 'All'], ['call', 'From calls'], ['refined', 'Refined'], ['imported', 'Imported']];
const MODEL_FILES = ['model.glb', 'model.stl', 'model.obj'];
const ACCEPT = '.stl,.obj,.glb,.scad';
const EDGE_TRIS = 120_000;     // above this, no edge lines (EdgesGeometry is O(n) but heavy on big imports)
const CIRCUIT_ID = 'circuit-live';
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- small DOM helpers (text only, never HTML) ----------
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}
function orn(id, viewBox, cls, style) {   // a symbol from the ornament sprite (inlined once by the shell)
  const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', viewBox); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false'); if (cls) s.setAttribute('class', `forge-o ${cls}`); if (style) s.setAttribute('style', style);
  const u = document.createElementNS(SVGNS, 'use'); u.setAttribute('href', `#${id}`); s.append(u); return s;
}

// ---------- design facts ----------
const has = (d, f) => Array.isArray(d?.files) && d.files.includes(f);
const modelFile = d => MODEL_FILES.find(f => has(d, f)) || null;
const isBuild = d => d.kind === 'refined' && d.mode === 'build';
const kindWord = d => d.kind === 'scan' ? 'Scan' : d.kind === 'imported' ? 'Import' : d.kind === 'circuit' ? 'Circuit' : isBuild(d) ? 'Built' : 'Refined';
function when(at) {
  const t = new Date(Number(at) || 0), now = new Date();
  const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t.getTime() >= day) return `today, ${time}`;
  if (t.getTime() >= day - 86_400_000) return `yesterday, ${time}`;
  return t.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function meta(d) {
  if (d.kind === 'scan') return `${d.parts?.length || 0} part${d.parts?.length === 1 ? '' : 's'} · ${when(d.at)}`;
  if (d.kind === 'imported') return `Imported .${d.format || 'file'} · ${when(d.at)}`;
  if (d.kind === 'circuit') return `${d.count} part${d.count === 1 ? '' : 's'} · Arduino sketch`;
  return `${isBuild(d) ? 'Built from the original' : 'Refined by Argos'} · ${when(d.at)}`;
}
const inFilter = (d, f) => f === 'all' || (f === 'call' && d.source === 'call') || (f === 'refined' && d.kind === 'refined') || (f === 'imported' && d.kind === 'imported');

/** Every design's file is fetched once per page session; the viewer and the card preview share it. */
const bufCache = new Map();
async function fileBuffer(d, f) {
  const key = `${d.id}/${f}`;
  if (!bufCache.has(key)) {
    bufCache.set(key, fetch(`/argos/designs/${encodeURIComponent(d.id)}/${f}`, { cache: 'no-store' }).then(async r => {
      if (!r.ok) throw new Error(`Couldn't load ${f} (the server answered ${r.status}).`);
      return r.arrayBuffer();
    }));
    if (bufCache.size > 6) bufCache.delete(bufCache.keys().next().value);
  }
  try { return await bufCache.get(key); } catch (e) { bufCache.delete(key); throw e; }
}

/** Parses a design's model into an Object3D (Y up). STL from OpenSCAD and most CAD is Z up, so it's turned upright. */
async function loadModel(d) {
  const f = modelFile(d); if (!f) throw new Error('This design has no 3D model yet.');
  const buf = await fileBuffer(d, f);
  let obj;
  if (f === 'model.stl') {
    const g = new STLLoader().parse(buf); if (!g.attributes.normal) g.computeVertexNormals();
    obj = new THREE.Mesh(g, new THREE.MeshStandardMaterial()); obj.rotation.x = -Math.PI / 2;
  } else if (f === 'model.obj') obj = new OBJLoader().parse(new TextDecoder().decode(buf));
  else obj = (await new GLTFLoader().parseAsync(buf.slice(0), '')).scene;
  let tris = 0;
  obj.traverse(o => { if (o.isMesh && o.geometry) { const g = o.geometry; if (!g.attributes.normal && g.attributes.position) g.computeVertexNormals(); tris += (g.index ? g.index.count : g.attributes.position?.count || 0) / 3; } });
  if (!tris) { disposeTree(obj); throw new Error('This file has no triangles to show.'); }
  const root = new THREE.Group(); root.add(obj); root.userData.tris = tris; root.userData.format = f.split('.')[1];
  return root;
}
function disposeMaterial(m) {
  for (const mat of Array.isArray(m) ? m : [m]) {
    if (!mat) continue;
    for (const v of Object.values(mat)) if (v && v.isTexture) v.dispose();
    mat.dispose();
  }
}
function disposeTree(root) {
  root.traverse(o => {
    o.geometry?.dispose?.();
    if (o.material) disposeMaterial(o.material);
    if (o.userData.orig) disposeMaterial(o.userData.orig);
  });
}
/** Centres the model on the origin, its base on y = 0. Returns its bounding radius and height. */
function centre(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const inner = root.children[0]; inner.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
  return { radius: Math.max(size.length() / 2, 1e-3), height: size.y };
}
function frameCamera(camera, controls, { radius, height }) {
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.08;
  camera.near = dist / 200; camera.far = dist * 50; camera.updateProjectionMatrix();
  const target = new THREE.Vector3(0, height / 2, 0);
  camera.position.copy(target).add(new THREE.Vector3(0.62, 0.42, 0.66).normalize().multiplyScalar(dist));
  if (controls) { controls.target.copy(target); controls.minDistance = radius * 0.4; controls.maxDistance = dist * 5; controls.update(); }
  else camera.lookAt(target);
}

// ---------- card previews: one small offscreen renderer, the model glowing in the kiln ----------
let thumbR = null; const thumbs = new Map(); const thumbQueue = []; let thumbBusy = false;
function thumbFor(d, onDone) {
  if (thumbs.has(d.id)) return onDone(thumbs.get(d.id));
  thumbQueue.push({ d, onDone }); if (!thumbBusy) void runThumbs();
}
async function runThumbs() {
  thumbBusy = true;
  while (thumbQueue.length) {
    const { d, onDone } = thumbQueue.shift();
    if (thumbs.has(d.id)) { onDone(thumbs.get(d.id)); continue; }
    let url = null;
    try { url = await renderThumb(d); } catch { url = null; }
    thumbs.set(d.id, url); onDone(url);
  }
  thumbBusy = false;
}
async function renderThumb(d) {
  if (!thumbR) {
    try { thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); }
    catch { return null; }   // no WebGL: the card keeps its glyph
    thumbR.setPixelRatio(1); thumbR.setSize(640, 352, false); thumbR.setClearColor(0x000000, 0);
  }
  const root = await loadModel(d), made = [];
  const body = new THREE.MeshStandardMaterial({ color: 0x3a1a10, emissive: 0x983a34, emissiveIntensity: 0.32, roughness: 0.55, metalness: 0.2 });
  const edge = new THREE.LineBasicMaterial({ color: 0xea872f, transparent: true, opacity: 0.85 });
  made.push(body, edge);
  root.traverse(o => {
    if (!o.isMesh) return;
    o.userData.orig = o.material; o.material = body;
    if (root.userData.tris < EDGE_TRIS) { const eg = new THREE.EdgesGeometry(o.geometry, 28); made.push(eg); o.add(new THREE.LineSegments(eg, edge)); }
  });
  const dims = centre(root);
  const scene = new THREE.Scene(); scene.add(root);
  scene.add(new THREE.HemisphereLight(0x2a3550, 0x5a2414, 1.2));
  const key = new THREE.DirectionalLight(0xea872f, 3.2); key.position.set(2, 1.4, 2.4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xe2e76e, 2.2); rim.position.set(-2, 2.2, -2); scene.add(rim);
  const cam = new THREE.PerspectiveCamera(32, 640 / 352);
  frameCamera(cam, null, dims);
  thumbR.render(scene, cam);
  const url = thumbR.domElement.toDataURL('image/png');
  root.traverse(o => { if (o.isMesh && o.userData.orig) { disposeMaterial(o.userData.orig); delete o.userData.orig; } if (o.isMesh) o.geometry.dispose(); });
  for (const m of made) m.dispose();
  thumbR.renderLists.dispose();
  return url;
}

// ---------- the viewer's 3D stage ----------
function createStage(host) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
  catch { return null; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.className = 'forge-canvas';
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = 0.08;
  // forge light: torch key, lime rim, night fill from above and ember from below
  const lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight(0x8fa6c8, 0x5a2414, 1.1));
  const key = new THREE.DirectionalLight(0xffb070, 3.0); key.position.set(3, 4, 3); lights.add(key);
  const rim = new THREE.DirectionalLight(0xe2e76e, 1.6); rim.position.set(-3, 2.5, -3); lights.add(rim);
  const fill = new THREE.DirectionalLight(0x6f8fbf, 0.6); fill.position.set(-3, 1, 3); lights.add(fill);
  scene.add(lights);
  // the hearth plate under the model (forge look) / projector glow (holo look)
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.25)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const plateTex = new THREE.CanvasTexture(c);
  const plateMat = new THREE.MeshBasicMaterial({ map: plateTex, color: 0xea872f, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), plateMat); plate.rotation.x = -Math.PI / 2; scene.add(plate);
  const clock = { value: 0 };   // our own uTime: the Argo stage advances holo.js's shared clock on its own schedule

  let model = null, made = [], look = 'forge', dims = null, raf = 0, last = 0, active = false;
  const size = () => {
    const w = Math.max(1, host.clientWidth), hgt = Math.max(1, host.clientHeight);
    renderer.setSize(w, hgt, false); camera.aspect = w / hgt; camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(() => { size(); draw(); }); ro.observe(host);
  function draw() { if (model || active) renderer.render(scene, camera); }
  function tick(t) {
    raf = 0; if (!active || document.hidden) return;
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0; last = t; clock.value += dt;
    controls.update(); renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  function setActive(on) {
    active = on; last = 0;
    if (on && !raf) raf = requestAnimationFrame(tick);
    if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function clearMade() { for (const m of made) { if (m.isObject3D) m.parent?.remove(m); m.geometry?.dispose?.(); m.dispose?.(); } made = []; }
  function applyLook() {
    if (!model) return;
    clearMade();
    const glb = model.userData.format === 'glb';
    const stone = new THREE.MeshStandardMaterial({ color: 0xdfd3c7, roughness: 0.62, metalness: 0.08 });
    const holo = holoMaterial('body'); holo.uniforms.uTime = clock;
    const edgeMat = new THREE.LineBasicMaterial({ color: look === 'holo' ? 0x8fefff : 0x2a1610, transparent: true, opacity: look === 'holo' ? 0.45 : 0.25, depthWrite: false,
      blending: look === 'holo' ? THREE.AdditiveBlending : THREE.NormalBlending });
    made.push(stone, holo, edgeMat);
    model.traverse(o => {
      if (!o.isMesh) return;
      if (!o.userData.orig) o.userData.orig = o.material;
      o.material = look === 'holo' ? holo : glb ? o.userData.orig : stone;
      if (model.userData.tris < EDGE_TRIS) {
        const eg = new THREE.EdgesGeometry(o.geometry, 28), ls = new THREE.LineSegments(eg, edgeMat);
        o.add(ls); made.push(ls);
      }
    });
    lights.visible = look !== 'holo';
    plateMat.color.set(look === 'holo' ? 0x3bd8ff : 0xea872f); plateMat.opacity = look === 'holo' ? 0.35 : 0.55;
    draw();
  }
  function clear() {
    clearMade();
    if (model) {   // our own materials are in made; the model's originals are disposed here
      model.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); if (o.userData.orig) disposeMaterial(o.userData.orig); } });
      scene.remove(model); model = null;
    }
    renderer.renderLists.dispose();
    draw();
  }
  return {
    get el() { return renderer.domElement; },
    get model() { return model; },
    show(root) {
      clear(); model = root; scene.add(root); dims = centre(root);
      plate.scale.setScalar(dims.radius * 2.6); plate.position.y = 0.001 * dims.radius;
      size(); frameCamera(camera, controls, dims); applyLook();
    },
    setLook(l) { look = l; applyLook(); },
    frame() { if (dims) { frameCamera(camera, controls, dims); draw(); } },
    clear, setActive,
    info() { return { meshes: model ? countMeshes(model) : 0, tris: model?.userData.tris || 0, look, renderer: renderer.info.memory }; },
    destroy() { setActive(false); clear(); ro.disconnect(); controls.dispose(); plate.geometry.dispose(); plateMat.dispose(); plateTex.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
}
const countMeshes = root => { let n = 0; root.traverse(o => { if (o.isMesh) n++; }); return n; };

// =====================================================================================================================
/**
 * Mounts The Forge into rootEl.
 * @param {HTMLElement} rootEl an empty element that fills the page (The Forge positions everything inside it)
 * @param {{subscribe: (fn: (event: object) => void) => (() => void), openRefine: (id: string) => void}} io
 * @returns {{refresh: () => Promise<void>, open: (id: string) => void, close: () => void, destroy: () => void}}
 */
export function mountForge(rootEl, { subscribe, openRefine } = {}) {
  const S = { designs: [], filter: 'all', open: null, look: 'forge', circuit: null, fresh: new Set(), busy: false, liveCall: false, schem: null, schemBusy: false };
  const byId = id => id === CIRCUIT_ID ? S.circuit : S.designs.find(d => d.id === id);
  if (!document.querySelector('link[href="/twin/forge.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: '/twin/forge.css' }));
  rootEl.classList.add('forge', 'is-offscreen');   // the first sight of the page plays its entrance
  rootEl.replaceChildren();

  // ---------- layout ----------
  const ink = h('div', { class: 'forge-ink', 'aria-hidden': 'true' });
  const sky = h('div', { class: 'forge-sky', 'aria-hidden': 'true' },
    orn('o-star', '0 0 24 24', 'forge-star', 'left:118px;top:78px;width:26px;height:26px;--d:.5s'),
    orn('o-star', '0 0 24 24', 'forge-star', 'left:160px;top:112px;width:14px;height:14px;--d:1.6s'),
    orn('o-star', '0 0 24 24', 'forge-star', 'right:126px;top:70px;width:22px;height:22px;--d:1s'),
    orn('o-cloud', '0 0 72 24', 'forge-cloud', 'right:-40px;top:24px'));
  const title = h('h1', { class: 'forge-title forge-rise', id: 'forge-h', text: 'The Forge' });
  const header = h('header', { class: 'forge-head' },
    h('div', { class: 'forge-head-row' }, orn('o-brazier', '0 0 80 120', 'forge-flank forge-flank-l forge-flicker'), title,
      orn('o-brazier', '0 0 80 120', 'forge-flank forge-flank-r forge-flicker', '--d:-.5s')),
    h('p', { class: 'forge-sub forge-rise', style: '--i:1', text: 'Past builds and designs you brought in' }));

  const count = h('span', { class: 'forge-count', text: 'Designs' });
  const filterBtns = FILTERS.map(([id, label]) => h('button', { class: 'forge-btn forge-quiet forge-filter', type: 'button', 'data-filter': id, 'aria-pressed': id === 'all' ? 'true' : 'false',
    onclick: () => { S.filter = id; renderGallery(); } }, h('span', { text: label }), h('b', { class: 'forge-n', text: '0' })));
  const fileInput = h('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true, class: 'forge-file', 'aria-hidden': 'true', tabindex: '-1' });
  const importBtn = h('button', { class: 'forge-btn forge-torch forge-import', type: 'button', onclick: () => fileInput.click() }, 'Import a design');
  const bar = h('div', { class: 'forge-bar forge-rise', style: '--i:2' },
    h('h2', { class: 'forge-sect' }, orn('o-anvil-icon', '0 0 32 32'), count),
    h('div', { class: 'forge-filters', role: 'group', 'aria-label': 'Show designs' }, filterBtns),
    importBtn, fileInput);
  const grid = h('ul', { class: 'forge-relics', 'aria-label': 'Designs' });
  const empty = h('div', { class: 'forge-empty', hidden: true }, orn('o-olive', '0 0 160 48', 'forge-olive'), h('p', { class: 'forge-empty-text' }));
  const scroller = h('div', { class: 'forge-scroll' }, bar, grid, empty);
  const hearth = h('div', { class: 'forge-hearth', 'aria-hidden': 'true' }, h('div', { class: 'forge-glow' }),
    (() => { const s = orn('o-anvil', '0 0 96 96', 'forge-anvil'); return s; })(), h('div', { class: 'forge-sea' }));

  // viewer
  const vName = h('h2', { class: 'forge-v-name', id: 'forge-v-name', tabindex: '-1' });
  const vMeta = h('p', { class: 'forge-v-meta' });
  const vBadges = h('div', { class: 'forge-badges' });
  const vNote = h('p', { class: 'forge-v-note', hidden: true });
  const vSummary = h('p', { class: 'forge-v-summary', hidden: true });
  const vCaveats = h('ul', { class: 'forge-v-caveats', hidden: true });
  const vChain = h('ol', { class: 'forge-chain forge-v-chain', 'aria-label': 'Versions, oldest first' });
  const actions = h('div', { class: 'forge-actions' });
  const refineBtn = h('button', { class: 'forge-btn forge-quiet forge-refine', type: 'button', onclick: () => refine() }, 'Refine with Argos');
  const refineMsg = h('p', { class: 'forge-refusal', role: 'alert', hidden: true });
  const delBtn = h('button', { class: 'forge-btn forge-quiet forge-delete', type: 'button', onclick: () => askDelete(true) }, 'Delete design');
  const delAsk = h('div', { class: 'forge-confirm', hidden: true, role: 'group', 'aria-labelledby': 'forge-confirm-q' },
    h('p', { id: 'forge-confirm-q', class: 'forge-confirm-q' }),
    h('div', { class: 'forge-confirm-row' },
      h('button', { class: 'forge-btn forge-ink-btn forge-delete-yes', type: 'button', onclick: () => doDelete() }, 'Delete'),
      h('button', { class: 'forge-btn forge-quiet forge-delete-no', type: 'button', onclick: () => askDelete(false) }, 'Keep it')));
  const schemBtn = h('button', { class: 'forge-btn forge-quiet forge-schematic', type: 'button', onclick: () => drawSchematic() }, 'Schematic');
  const schemWhy = h('p', { class: 'forge-why forge-schem-why', id: 'forge-schem-why', hidden: true });
  const side = h('aside', { class: 'forge-side', 'aria-labelledby': 'forge-v-name' },
    vName, vMeta, vBadges, vNote, vSummary, vCaveats,
    h('h3', { class: 'forge-side-h', text: 'Versions' }), vChain,
    h('h3', { class: 'forge-side-h', text: 'Convert' }), actions,
    h('h3', { class: 'forge-side-h', text: 'Circuit' }), schemBtn, schemWhy,
    refineBtn, refineMsg, delBtn, delAsk);
  const stageMsg = h('p', { class: 'forge-stage-msg', role: 'status' });
  const photo = h('img', { class: 'forge-photo', alt: '', hidden: true });
  const buildBtn = h('button', { class: 'forge-btn forge-torch forge-build', type: 'button', hidden: true, onclick: () => build() }, 'Build 3D');
  const lookBtns = [['forge', 'Forge-lit'], ['holo', 'Hologram']].map(([id, label]) => h('button', { class: 'forge-btn forge-quiet forge-small forge-look', type: 'button', 'data-look': id,
    'aria-pressed': id === S.look ? 'true' : 'false', onclick: () => setLook(id) }, label));
  const frameBtn = h('button', { class: 'forge-btn forge-quiet forge-small forge-frame', type: 'button', onclick: () => stage?.frame() }, 'Frame');
  const tools = h('div', { class: 'forge-tools', role: 'group', 'aria-label': 'View' }, lookBtns, frameBtn);
  const stageEl = h('div', { class: 'forge-stage', 'data-look': S.look, role: 'img', 'aria-label': '3D view' }, photo, stageMsg, buildBtn, tools);
  // schematic view (replaces the 3D stage while it's open): Schematic / PCB toggle, a caption for students, downloads
  const SCHEM_VIEWS = { schematic: ['Schematic', 'Schematic: how the parts connect.', 'Schematic of the circuit'],
    pcb: ['PCB', 'PCB: a 2-layer carrier board, auto-routed. Red is top copper, blue is bottom.', 'Printed circuit board layout of the circuit'] };
  const schemTabs = Object.entries(SCHEM_VIEWS).map(([id, [label]]) => h('button', { class: 'forge-btn forge-quiet forge-small forge-schem-tab', type: 'button', 'data-view': id,
    'aria-pressed': id === 'schematic' ? 'true' : 'false', onclick: () => setSchemView(id) }, label));
  const schemTabsEl = h('div', { class: 'forge-schem-tabs', role: 'group', 'aria-label': 'Drawing' }, schemTabs);
  const schemMsg = h('p', { class: 'forge-schem-msg', role: 'status' });
  const schemImg = h('img', { class: 'forge-schem-img', alt: '', decoding: 'async' });
  const schemCap = h('figcaption', { class: 'forge-schem-cap' });
  const schemFig = h('figure', { class: 'forge-schem-fig', hidden: true, 'data-view': 'schematic' }, h('div', { class: 'forge-schem-frame' }, schemImg), schemCap);
  const schemDl = h('div', { class: 'forge-schem-dl', role: 'group', 'aria-label': 'Download the circuit files' });
  const schemBack = h('button', { class: 'forge-btn forge-quiet forge-small forge-schem-back', type: 'button', onclick: () => { hideSchem(); schemBtn.focus(); } }, 'Back to 3D view');
  const schemEl = h('section', { class: 'forge-schem', hidden: true, 'aria-label': 'Schematic and PCB' },
    h('div', { class: 'forge-schem-bar' }, schemTabsEl, schemBack), schemMsg, schemFig, schemDl);
  const backBtn = h('button', { class: 'forge-btn forge-quiet forge-small forge-back', type: 'button', onclick: () => close() }, '‹ All designs');
  const viewer = h('section', { class: 'forge-viewer', hidden: true, 'aria-labelledby': 'forge-v-name' },
    h('div', { class: 'forge-v-top' }, backBtn), h('div', { class: 'forge-v-body' }, h('div', { class: 'forge-kiln' }, stageEl, schemEl), side));

  const drop = h('div', { class: 'forge-drop', hidden: true, 'aria-hidden': 'true' }, h('p', { text: 'Drop .stl, .obj, .glb or .scad files to import them' }));
  const toasts = h('div', { class: 'forge-toasts' });
  rootEl.append(h('div', { class: 'forge-page' }, sky, ink, header, scroller, hearth, viewer, drop, toasts));
  let enterTimer = 0;
  const enter = () => { rootEl.classList.add('forge-enter'); clearTimeout(enterTimer); enterTimer = setTimeout(() => rootEl.classList.remove('forge-enter'), 1200); };

  let stage = null;   // created on first open (WebGL only when it's needed)
  const getStage = () => { if (!stage) stage = createStage(stageEl); return stage; };

  // ---------- toasts ----------
  function toast(text, { error = false } = {}) {
    const t = h('div', { class: `forge-toast${error ? ' is-error' : ''}`, role: error ? 'alert' : 'status' }, h('span', { text }));
    if (error) t.append(h('button', { class: 'forge-btn forge-quiet forge-small', type: 'button', onclick: () => t.remove() }, 'Dismiss'));
    else setTimeout(() => t.remove(), 6000);
    toasts.append(t); while (toasts.children.length > 2) toasts.firstChild.remove();
    return t;
  }

  // ---------- data ----------
  async function api(path, opts = {}) {
    let r;
    try { r = await fetch(path, { cache: 'no-store', ...opts }); }
    catch { throw new Error("Couldn't reach Ody on this laptop. Check that the hub is running, then try again."); }
    let body = null; try { body = await r.json(); } catch { /* no JSON */ }
    if (!r.ok) throw new Error(body?.error || (r.status === 403 ? 'The server refused this request (403). Reload the page and try again.' : `The server answered ${r.status}.`));
    return body || {};
  }
  function upsert(d, { fresh = false } = {}) {
    if (!d?.id) return;
    const i = S.designs.findIndex(x => x.id === d.id);
    if (i >= 0) S.designs[i] = d; else { S.designs.push(d); if (fresh) S.fresh.add(d.id); }
    S.designs.sort((a, b) => b.at - a.at);
  }
  async function refresh() {
    try {
      const { designs = [] } = await api('/argos/designs');
      S.designs = designs.filter(d => d && typeof d.id === 'string');
      renderGallery();
      if (S.open && !byId(S.open)) close();
    } catch (e) { toast(e.message, { error: true }); }
  }

  // ---------- version chain ----------
  function lineage(d) {
    if (d.kind === 'circuit') return [d];
    const seen = new Set([d.id]), up = [d];
    for (let p = byId(d.parent); p && !seen.has(p.id); p = byId(p.parent)) { seen.add(p.id); up.unshift(p); }
    for (let cur = d; ;) {
      const kids = S.designs.filter(x => x.parent === cur.id && !seen.has(x.id)).sort((a, b) => a.at - b.at);
      if (!kids.length) break; cur = kids.at(-1); seen.add(cur.id); up.push(cur);
    }
    return up;
  }
  function chainEl(d, { buttons = false } = {}) {
    const chain = lineage(d), ol = buttons ? vChain : h('ol', { class: 'forge-chain', 'aria-label': `Versions of ${d.name}` });
    ol.replaceChildren();
    const shown = buttons ? chain : chain.length > 4 ? [chain[0], null, ...chain.slice(-2)] : chain;
    shown.forEach((v, i) => {
      if (!v) { ol.append(h('li', { class: 'forge-chain-more', text: `+${chain.length - 3}` })); return; }
      const n = chain.indexOf(v) + 1, label = `v${n} ${kindWord(v)}`, cur = v.id === d.id;
      const li = h('li', { class: cur ? 'is-current' : '', 'aria-current': cur ? 'true' : null });
      if (buttons && !cur) li.append(h('button', { class: 'forge-chain-btn', type: 'button', onclick: () => open(v.id) }, label));
      else li.append(h('span', { text: label }));
      ol.append(li);
      if (i < shown.length - 1) ol.append(h('li', { class: 'forge-chain-arrow', 'aria-hidden': 'true', text: '›' }));
    });
    return ol;
  }
  function badges(d) {
    const out = [];
    if (d.estimate) out.push(h('span', { class: 'forge-badge is-estimate', title: d.estimate, text: 'AI estimate' }));
    if (d.outside) out.push(h('span', { class: 'forge-badge is-outside', text: 'Made outside Ody' }));
    if (d.kind === 'refined' && d.caveats?.length) out.push(h('span', { class: 'forge-badge is-caveat', text: `${d.caveats.length} caveat${d.caveats.length === 1 ? '' : 's'}` }));
    if (d.kind === 'circuit') out.push(h('span', { class: 'forge-badge is-session', text: 'This call only' }));
    return out;
  }

  // ---------- gallery ----------
  function well(d) {
    const w = h('div', { class: 'forge-well' });
    const glyph = () => w.append(orn(d.kind === 'circuit' ? 'o-anvil-icon' : 'o-anvil-icon', '0 0 32 32', 'forge-well-glyph'),
      h('span', { class: 'forge-well-note', text: d.kind === 'circuit' ? 'Arduino sketch' : has(d, 'source.scad') ? 'OpenSCAD source, no 3D yet' : 'No preview' }));
    if (d.kind === 'scan' && has(d, 'photo.jpg')) {
      w.classList.add('is-photo');
      w.append(h('img', { src: `/argos/designs/${encodeURIComponent(d.id)}/photo.jpg`, alt: '', loading: 'lazy', decoding: 'async' }));
    } else if (modelFile(d)) {
      w.classList.add('is-loading');
      thumbFor(d, url => {
        w.classList.remove('is-loading');
        if (url) w.append(h('img', { src: url, alt: '', decoding: 'async' })); else glyph();
      });
    } else glyph();
    return w;
  }
  function card(d, i, newestId) {
    const openBtn = h('button', { class: 'forge-open', type: 'button', onclick: () => open(d.id) }, h('span', { text: d.name || 'Untitled design' }));
    const li = h('li', { class: `forge-relic${S.fresh.has(d.id) ? ' is-fresh' : ''}`, 'data-id': d.id, 'data-kind': d.kind, style: `--i:${Math.min(i, 6) + 3}` },
      d.id === newestId ? orn('o-star', '0 0 24 24', 'forge-relic-star') : null,
      well(d),
      h('div', { class: 'forge-txt' }, h('h3', { class: 'forge-relic-name' }, openBtn), h('p', { class: 'forge-relic-meta', text: meta(d) }),
        h('div', { class: 'forge-badges' }, badges(d)), chainEl(d)));
    if (d.id === newestId) li.append(h('span', { class: 'forge-sr', text: 'Newest design.' }));
    return li;
  }
  function allDesigns() { return S.circuit ? [S.circuit, ...S.designs].sort((a, b) => b.at - a.at) : S.designs; }
  function renderGallery() {
    const all = allDesigns(), list = all.filter(d => inFilter(d, S.filter));
    count.textContent = `${all.length} design${all.length === 1 ? '' : 's'}`;
    for (const b of filterBtns) {
      const f = b.dataset.filter; b.setAttribute('aria-pressed', String(f === S.filter));
      b.querySelector('.forge-n').textContent = String(all.filter(d => inFilter(d, f)).length);
    }
    const newestId = all[0]?.id;
    grid.replaceChildren(...list.map((d, i) => card(d, i, newestId)));
    S.fresh.clear();
    empty.hidden = list.length > 0;
    empty.querySelector('.forge-empty-text').textContent = all.length === 0
      ? 'No designs yet. Scan something on a call, or import a .stl, .obj, .glb or .scad file.'
      : { call: 'No designs from calls yet. Say "scan this" on a call and the scan lands here.', refined: 'No refined versions yet. Open a design and choose Refine with Argos.', imported: 'Nothing imported yet. Import a .stl, .obj, .glb or .scad file.' }[S.filter] || 'Nothing here.';
    if (S.open && byId(S.open)) fillSide(byId(S.open));
  }

  // ---------- viewer ----------
  let opener = null, openSeq = 0;
  const builtChild = d => S.designs.filter(x => x.parent === d.id && isBuild(x) && has(x, 'model.stl')).sort((a, b) => b.at - a.at)[0] || null;
  function link(href, label, cls = '') { return h('a', { class: `forge-btn ${cls}`.trim(), href, download: '' }, label); }
  function fillSide(d) {
    vName.textContent = d.name || 'Untitled design';
    vMeta.textContent = meta(d);
    vBadges.replaceChildren(...badges(d));
    vNote.hidden = !d.note; vNote.textContent = d.note || '';
    vSummary.hidden = !d.summary; vSummary.textContent = d.summary || '';
    vCaveats.replaceChildren(...(d.caveats || []).map(c => h('li', { text: c }))); vCaveats.hidden = !d.caveats?.length;
    chainEl(d, { buttons: true });
    const base = `/argos/designs/${encodeURIComponent(d.id)}`;
    const acts = [];
    if (d.kind === 'circuit') {
      acts.push(h('button', { class: 'forge-btn forge-torch forge-dl-ino', type: 'button', onclick: () => saveText(d.sketch, `ody-circuit-${d.rev || 'sketch'}.ino`, 'Saved the Arduino sketch.') }, 'Download sketch (.ino)'));
    } else {
      const child = builtChild(d);
      if (has(d, 'model.stl')) acts.push(link(`${base}/model.stl?download`, 'Download STL', 'forge-torch forge-dl-stl'));
      else if (child) acts.push(link(`/argos/designs/${encodeURIComponent(child.id)}/model.stl?download`, 'Download STL', 'forge-torch forge-dl-stl'));
      else if (has(d, 'source.scad')) acts.push(h('button', { class: 'forge-btn forge-torch forge-dl-stl', type: 'button', onclick: () => build({ download: true }) }, 'Build and download STL'));
      else if (modelFile(d)) acts.push(h('button', { class: 'forge-btn forge-torch forge-dl-stl', type: 'button', onclick: () => exportStl(d) }, 'Download STL'));
      if (has(d, 'source.scad')) acts.push(link(`${base}/source.scad?download`, 'Download OpenSCAD', 'forge-on-light forge-dl-scad'));
      else acts.push(h('p', { class: 'forge-why', text: d.outside ? 'No OpenSCAD code: this file was made outside Ody.' : 'No OpenSCAD code for this design.' }));
      for (const f of ['model.glb', 'model.obj']) if (has(d, f)) acts.push(link(`${base}/${f}?download`, `Download original .${f.split('.')[1]}`, 'forge-quiet forge-dl-orig'));
      if (S.circuit && d.source === 'call') acts.push(h('button', { class: 'forge-btn forge-quiet forge-dl-ino', type: 'button', onclick: () => saveText(S.circuit.sketch, 'ody-circuit.ino', 'Saved the Arduino sketch.') }, "This call's Arduino sketch"));
    }
    actions.replaceChildren(...acts);
    refineBtn.hidden = d.kind === 'circuit';
    delBtn.hidden = d.kind === 'circuit';
    const circ = hasCircuit(d);
    schemBtn.setAttribute('aria-disabled', String(!circ));
    schemBtn.title = circ ? 'Draw the schematic and a routed PCB of this circuit' : 'No circuit in this design';
    if (circ) schemBtn.removeAttribute('aria-describedby'); else schemBtn.setAttribute('aria-describedby', 'forge-schem-why');
    schemWhy.hidden = circ; schemWhy.textContent = circ ? '' : 'No circuit in this design.';
  }
  const hasCircuit = d => (d.kind === 'circuit' ? d.count > 0 : has(d, 'circuit.json'));
  async function showModel(d, seq) {
    const st = getStage();
    photo.hidden = true; buildBtn.hidden = true; tools.hidden = true;
    if (!st) { stageMsg.textContent = "This laptop's browser can't show 3D here (WebGL is off). Downloads still work."; return; }
    stageMsg.textContent = 'Loading the model…'; stageEl.classList.add('is-busy');
    try {
      const root = await loadModel(d);
      if (seq !== openSeq) { disposeTree(root); return; }   // the user picked another design meanwhile
      st.show(root); st.setLook(S.look); st.setActive(true);
      stageMsg.textContent = ''; tools.hidden = false;
      stageEl.dataset.has = 'model';
    } catch (e) { if (seq === openSeq) stageMsg.textContent = e.message; }
    finally { stageEl.classList.remove('is-busy'); }
  }
  function open(id) {
    const d = byId(id); if (!d) return;
    const seq = ++openSeq;
    if (viewer.hidden) opener = document.activeElement;
    S.open = id; viewer.hidden = false; rootEl.classList.add('is-viewing');
    askDelete(false); refineMsg.hidden = true; hideSchem();
    fillSide(d);
    stageEl.setAttribute('aria-label', `3D view of ${d.name || 'the design'}`);
    stageEl.dataset.has = ''; stage?.clear(); stage?.setActive(false);
    photo.hidden = true; buildBtn.hidden = true; tools.hidden = true; stageMsg.textContent = '';
    if (modelFile(d)) void showModel(d, seq);
    else if (d.kind === 'circuit') stageMsg.textContent = 'This circuit is on the Argo page. Download its Arduino sketch here.';
    else {
      if (has(d, 'photo.jpg')) { photo.src = `/argos/designs/${encodeURIComponent(d.id)}/photo.jpg`; photo.alt = `Photo of ${d.name} from the call`; photo.hidden = false; stageEl.dataset.has = 'photo'; }
      const child = builtChild(d);
      if (child) { buildBtn.textContent = 'Show 3D model'; buildBtn.hidden = false; buildBtn.onclick = () => open(child.id); stageMsg.textContent = 'This scan already has a 3D version.'; }
      else if (has(d, 'source.scad')) { buildBtn.textContent = 'Build 3D'; buildBtn.hidden = false; buildBtn.onclick = () => build(); stageMsg.textContent = d.kind === 'scan' ? 'No 3D model yet. Build one from the scan.' : 'OpenSCAD source only. Build the 3D model from it.'; }
      else stageMsg.textContent = 'This design has no 3D model.';
    }
    vName.focus({ preventScroll: true });
  }
  function close() {
    if (viewer.hidden) return;
    openSeq++; hideSchem(); S.open = null; viewer.hidden = true; rootEl.classList.remove('is-viewing');
    stage?.setActive(false); stage?.clear();
    const back = opener && rootEl.contains(opener) ? opener : grid.querySelector('.forge-open');
    back?.focus({ preventScroll: true }); opener = null;
  }
  function setLook(l) {
    S.look = l; stageEl.dataset.look = l;
    for (const b of lookBtns) b.setAttribute('aria-pressed', String(b.dataset.look === l));
    stage?.setLook(l);
  }

  // ---------- schematic (on demand) ----------
  let schemSeq = 0;
  function showSchem() { stageEl.hidden = true; stage?.setActive(false); schemEl.hidden = false; }
  function hideSchem() {
    schemSeq++; S.schem = null; schemEl.hidden = true; schemEl.classList.remove('is-busy'); schemImg.removeAttribute('src');
    if (stageEl.hidden) { stageEl.hidden = false; if (stageEl.dataset.has === 'model') stage?.setActive(true); }
  }
  function setSchemView(v) {
    const r = S.schem, url = r && (v === 'pcb' ? r.pcbUrl : r.schematicUrl);
    if (!url) return;
    const [, caption, alt] = SCHEM_VIEWS[v];
    for (const b of schemTabs) b.setAttribute('aria-pressed', String(b.dataset.view === v));
    schemFig.dataset.view = v; schemImg.alt = alt; schemImg.src = `${url}?v=${r.stamp}`; schemCap.textContent = caption;
  }
  async function drawSchematic() {
    const d = byId(S.open);
    if (!d || !hasCircuit(d) || S.schemBusy) return;
    const seq = ++schemSeq, id = d.id;
    S.schemBusy = true; S.schem = null; schemBtn.setAttribute('aria-busy', 'true'); schemBtn.textContent = 'Drawing…';
    showSchem(); schemFig.hidden = true; schemTabsEl.hidden = true; schemDl.replaceChildren(); schemEl.classList.add('is-busy');
    schemMsg.textContent = 'Drawing schematic…';
    const later = setTimeout(() => { if (seq === schemSeq) schemMsg.textContent = 'Drawing schematic… routing PCB…'; }, 500);
    let r = null, body = null;
    try {
      r = await fetch(`/argos/designs/${encodeURIComponent(id)}/schematic`, { method: 'POST', cache: 'no-store' });
      try { body = await r.json(); } catch { /* no JSON */ }
    } catch { body = { error: "Couldn't reach Ody on this laptop. Check that the hub is running, then try again." }; }
    finally { clearTimeout(later); S.schemBusy = false; schemBtn.removeAttribute('aria-busy'); schemBtn.textContent = 'Schematic'; }
    if (seq !== schemSeq || S.open !== id) return;   // the user moved on meanwhile
    schemEl.classList.remove('is-busy');
    const netBtn = nets => h('button', { class: 'forge-btn forge-quiet forge-small forge-dl-netlist', type: 'button',
      onclick: () => saveBlob(new Blob([JSON.stringify(nets, null, 2)], { type: 'application/json' }), 'netlist.json', 'Saved the netlist.') }, 'Netlist (JSON)');
    if (!r?.ok || !body?.schematicUrl) {
      schemMsg.textContent = body?.error || (r?.status === 403 ? 'The server refused this request (403). Reload the page and try again.' : `The server answered ${r?.status}.`);
      if (Array.isArray(body?.netlist) && body.netlist.length) schemDl.append(netBtn(body.netlist));
      return;
    }
    S.schem = { ...body, stamp: Date.now() };
    schemMsg.textContent = `Ready: ${body.traces} copper trace${body.traces === 1 ? '' : 's'} routed${body.cached ? ' (unchanged since the last drawing)' : ''}.`;
    schemTabsEl.hidden = false; schemFig.hidden = false;
    const dls = [['sch', 'KiCad schematic'], ['pcb', 'KiCad PCB'], ['pro', 'KiCad project']].filter(([k]) => body.kicad?.[k])
      .map(([k, label]) => link(`${body.kicad[k]}?download`, label, `forge-quiet forge-small forge-dl-kicad-${k}`));
    schemDl.replaceChildren(...dls, body.netlistUrl ? link(`${body.netlistUrl}?download`, 'Netlist (JSON)', 'forge-quiet forge-small forge-dl-netlist') : netBtn(body.netlist || []));
    setSchemView('schematic');
  }

  // ---------- convert ----------
  function saveBlob(blob, name, msg) {
    const url = URL.createObjectURL(blob), a = h('a', { href: url, download: name, hidden: true });
    rootEl.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (msg) toast(msg);
  }
  const saveText = (text, name, msg) => saveBlob(new Blob([String(text || '')], { type: 'text/plain' }), name, msg);
  function download(href) { const a = h('a', { href, download: '', hidden: true }); rootEl.append(a); a.click(); a.remove(); }
  async function exportStl(d) {
    try {
      const root = await loadModel(d);   // a fresh copy in its own coordinates, not the one on the stage
      root.updateMatrixWorld(true);
      const data = new STLExporter().parse(root, { binary: true });
      disposeTree(root);
      saveBlob(new Blob([data], { type: 'model/stl' }), `${(d.name || 'design').replace(/[^\w.-]+/g, '-')}.stl`, 'Saved the STL.');
    } catch (e) { toast(`Couldn't export the STL: ${e.message}`, { error: true }); }
  }
  async function build({ download: dl = false } = {}) {
    const d = byId(S.open); if (!d || S.busy) return;
    S.busy = true; buildBtn.disabled = true; buildBtn.setAttribute('aria-busy', 'true'); const label = buildBtn.textContent; buildBtn.textContent = 'Building…';
    stageMsg.textContent = 'OpenSCAD is building the model on this laptop (up to 20 seconds)…'; stageEl.classList.add('is-busy');
    try {
      const r = await api(`/argos/designs/${encodeURIComponent(d.id)}/compile`, { method: 'POST' });
      upsert(r.design, { fresh: true }); renderGallery();
      toast(`Built the 3D model of “${d.name}”.`);
      if (dl && has(r.design, 'model.stl')) download(`/argos/designs/${encodeURIComponent(r.design.id)}/model.stl?download`);
      if (S.open === d.id) open(r.design.id);
    } catch (e) {
      if (S.open === d.id) stageMsg.textContent = `Build failed: ${e.message}`;
      toast(`Build failed: ${e.message}`, { error: true });
    } finally {
      S.busy = false; buildBtn.disabled = false; buildBtn.removeAttribute('aria-busy'); if (buildBtn.textContent === 'Building…') buildBtn.textContent = label; stageEl.classList.remove('is-busy');
    }
  }
  async function refine() {
    const d = byId(S.open); if (!d) return;
    refineMsg.hidden = true;
    // A design with no OpenSCAD source (an imported mesh) can't be refined. Ask the server, so the user reads its own
    // honest reason. This can't start a job: the server refuses before any model call when there is no source.
    if (!has(d, 'source.scad') && !(d.kind === 'scan' && has(d, 'spec.json'))) {
      try {
        await api('/argos/refine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ designId: d.id, instruction: 'check', mode: 'single' }) });
      } catch (e) { refineMsg.textContent = e.message; refineMsg.hidden = false; return; }
    }
    try { openRefine?.(d.id); } catch (e) { toast(`Couldn't open Argos: ${e.message}`, { error: true }); }
  }
  function askDelete(on) {
    const d = byId(S.open);
    delAsk.hidden = !on; delBtn.hidden = on || d?.kind === 'circuit';
    if (on && d) { delAsk.querySelector('.forge-confirm-q').textContent = `Delete “${d.name}”? Its files are removed from this laptop. This can't be undone.`; delAsk.querySelector('.forge-delete-no').focus(); }
  }
  async function doDelete() {
    const d = byId(S.open); if (!d) return;
    try {
      const r = await fetch(`/argos/designs/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) { let msg = ''; try { msg = (await r.json()).error; } catch { /* none */ } throw new Error(msg || `The server answered ${r.status}.`); }
      S.designs = S.designs.filter(x => x.id !== d.id); thumbs.delete(d.id); for (const k of [...bufCache.keys()]) if (k.startsWith(`${d.id}/`)) bufCache.delete(k);
      close(); renderGallery();
      toast(r.status === 404 ? `“${d.name}” was already deleted.` : `Deleted “${d.name}”.`);
    } catch (e) { toast(`Couldn't delete: ${e.message}`, { error: true }); askDelete(false); }
  }

  // ---------- import ----------
  async function importFiles(files) {
    let lastId = null;
    for (const f of files) {
      const t = toast(`Importing ${f.name}…`);
      try {
        const r = await api(`/argos/import?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
        t.remove(); upsert(r.design, { fresh: true }); lastId = r.design.id;
        toast(`Imported “${r.design.name}”. Made outside Ody: viewing and exporting work, AI edits may not.`);
      } catch (e) { t.remove(); toast(`${f.name}: ${e.message}`, { error: true }); }
    }
    renderGallery();
    if (lastId && files.length === 1) open(lastId);
  }
  fileInput.addEventListener('change', () => { const fs = [...fileInput.files]; fileInput.value = ''; if (fs.length) void importFiles(fs); });
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  rootEl.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; drop.hidden = false; });
  rootEl.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  rootEl.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
  rootEl.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; drop.hidden = true; const fs = [...e.dataTransfer.files]; if (fs.length) void importFiles(fs); });
  const onKey = e => { if (e.key === 'Escape' && !viewer.hidden && rootEl.contains(document.activeElement)) { e.preventDefault(); close(); } };
  rootEl.addEventListener('keydown', onKey);

  // ---------- live events ----------
  let scanTimer = 0;
  function onEvent(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'hello') {
      setLiveCall(e.call?.state === 'live');
      if (e.circuit) setCircuit(e.circuit);
      void refresh();
    } else if (e.type === 'call') setLiveCall(e.state === 'live');
    else if (e.type === 'circuit') setCircuit(e);
    else if (e.type === 'scan') {   // Argos saves it and sends a design event; refresh as a fallback if that is missed
      clearTimeout(scanTimer); scanTimer = setTimeout(() => void refresh(), 2500);
    } else if (e.type === 'argos' && e.kind === 'design' && e.design) {
      const isNew = !byId(e.design.id); upsert(e.design, { fresh: isNew }); renderGallery();
      if (isNew && e.design.source === 'call') toast(`New scan from the call: “${e.design.name}”.`);
    } else if (e.type === 'argos' && e.kind === 'design-removed' && Array.isArray(e.ids)) {   // deleted here, in Argos's chat, or on another page
      const gone = new Set(e.ids.map(String)); if (!S.designs.some(x => gone.has(x.id))) return;
      if (S.open && gone.has(S.open)) close();
      S.designs = S.designs.filter(x => !gone.has(x.id));
      for (const id of gone) { thumbs.delete(id); for (const k of [...bufCache.keys()]) if (k.startsWith(`${id}/`)) bufCache.delete(k); }
      renderGallery();
    } else if (e.type === 'argos' && e.kind === 'refine' && e.state === 'done' && e.design) {
      upsert(e.design, { fresh: !byId(e.design.id) }); renderGallery();
    }
  }
  function setLiveCall(on) { S.liveCall = !!on; rootEl.classList.toggle('is-live-call', S.liveCall); }
  function setCircuit(e) {
    if (typeof e.sketch !== 'string' || !e.sketch.trim()) return;
    const n = Array.isArray(e.state?.components) ? e.state.components.length : 0;
    const prev = S.circuit;
    S.circuit = { id: CIRCUIT_ID, kind: 'circuit', source: 'call', name: 'Circuit from the call', at: prev?.at || Date.now(), count: n, sketch: e.sketch.slice(0, 200_000), rev: e.rev, files: [] };
    renderGallery();
  }
  // ambient loops pause while The Forge is off screen or the tab is hidden (DESIGN-GUIDE §7)
  const io = new IntersectionObserver(([en]) => {
    const on = en.isIntersecting && en.intersectionRatio > 0;
    if (on && rootEl.classList.contains('is-offscreen')) enter();   // the page's one entrance, each time it is shown
    rootEl.classList.toggle('is-offscreen', !on);
    if (S.open) stage?.setActive(on && !document.hidden);
  }, { threshold: [0, 0.01] });
  io.observe(rootEl);
  const onVis = () => { if (S.open) stage?.setActive(!document.hidden && !rootEl.classList.contains('is-offscreen')); };
  document.addEventListener('visibilitychange', onVis);

  const unsub = typeof subscribe === 'function' ? subscribe(onEvent) : null;
  void refresh();
  renderGallery();

  const api_ = {
    refresh, open, close,
    /** test hook: what the viewer holds right now */
    _state: () => ({ open: S.open, designs: S.designs.length, filter: S.filter, look: S.look, stage: stage?.info() || null, reduced: reduce() }),
    destroy() {
      unsub?.(); io.disconnect(); document.removeEventListener('visibilitychange', onVis); rootEl.removeEventListener('keydown', onKey);
      clearTimeout(scanTimer); clearTimeout(enterTimer); stage?.destroy(); stage = null; thumbR?.dispose(); thumbR = null; thumbQueue.length = 0; rootEl.replaceChildren(); rootEl.classList.remove('forge', 'is-viewing', 'is-live-call', 'is-offscreen');
    },
  };
  return api_;
}
