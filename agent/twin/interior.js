// "Researched interiors": builds what is inside a scanned object (research.mjs spec) inside the scan's own group
// (twin/scan.js buildScan), in the hologram and realistic looks the rest of the twin uses. The outer shell turns
// translucent (x-ray), and the explode separates the layers along the device's depth axis in teardown order, each
// layer named with the HUD's layer tag. Plain meshes in plain groups, so GLTFExporter includes them.
//
//   const I = buildInterior(scanBuilt, scanSpec, interiorSpec);   // adds I.group to scanBuilt.group
//   explodeInterior(I, e)   e = 0..1, eased (call instead of explodeScan while an interior is mounted)
//   setInteriorXray(I, on); setInteriorLook(I, holo)   (after the app's applyLook)
//   pickInterior(I, raycaster) -> {mesh, pos, title, body, said} | null   (hover / focus: one-line note)
//   highlightInterior(I, mesh | null); interiorBox(I) -> THREE.Box3 (world, current explode); disposeInterior(I)
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { COLORS, holoMaterial, edgeMaterial } from './holo.js';

const DEG = Math.PI / 180;
/** spec frame (x right, y away from the camera, z up) -> three (x right, y up, z toward the camera); as twin/scan.js */
const C = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const toThree = v => new THREE.Vector3(v.x, v.z, -v.y);
const MAT = {   // [roughness, metalness, hologram tint]
  plastic: [0.55, 0, 'body'], metal: [0.32, 0.9, 'metal'], pcb: [0.42, 0.08, 'pcb'], glass: [0.06, 0, 'metal'],
  rubber: [0.9, 0, 'dark'], screen: [0.18, 0.1, 'metal'], battery: [0.38, 0.55, 'body'], copper: [0.3, 1, 'metal'],
  chip: [0.4, 0.1, 'body'], magnet: [0.3, 0.85, 'metal'],
};
const GHOST = { real: 0.13, holo: 0.28 };   // shell opacity while the inside shows

// ---------- geometry, built in the spec frame (z up) ----------
function roundedRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  r = Math.max(0.05, Math.min(r, w / 2 - 0.01, h / 2 - 0.01));
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
const slab = (shape, z) => { const g = new THREE.ExtrudeGeometry(shape, { depth: z, bevelEnabled: false, curveSegments: 6 }); g.translate(0, 0, -z / 2); return g; };

function shapeGeometry(p) {
  const { x, y, z } = p.size_mm;
  switch (p.shape) {
    case 'box': return new THREE.BoxGeometry(x, y, z);
    case 'rounded_box':   // thin plates (displays, batteries, boards) get real rounded corners; chunky parts a soft box
      return z < 0.3 * Math.min(x, y) ? slab(roundedRect(x, y, Math.min(x, y) * 0.13), z)
        : new RoundedBoxGeometry(x, y, z, 2, Math.max(0.1, Math.min(x, y, z) * 0.22));
    case 'cylinder': { const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); g.rotateX(Math.PI / 2); g.scale(x, y, z); return g; }
    case 'cone': { const g = new THREE.CylinderGeometry(0, 0.5, 1, 32); g.rotateX(Math.PI / 2); g.scale(x, y, z); return g; }
    case 'sphere': { const g = new THREE.SphereGeometry(0.5, 32, 18); g.scale(x, y, z); return g; }
    case 'capsule': {
      const r = Math.max(0.1, Math.min(x, y) / 2), g = new THREE.CapsuleGeometry(r, Math.max(0, z - 2 * r), 6, 24);
      g.rotateX(Math.PI / 2); g.scale(x / (2 * r), y / (2 * r), 1); return g;
    }
    case 'torus': {
      const tube = Math.max(0.1, Math.min(z, x / 2) / 2), R = Math.max(tube * 1.05, x / 2 - tube);
      const g = new THREE.TorusGeometry(R, tube, 10, 48); g.scale(1, y / Math.max(0.1, x), 1); return g;
    }
    case 'frame': {   // hollow rounded rectangle: a midframe, a bezel
      const w = THREE.MathUtils.clamp(Math.min(x, y) * 0.05, 0.8, 4), r = Math.min(x, y) * 0.13;
      const s = roundedRect(x, y, r); s.holes.push(roundedRect(Math.max(0.5, x - 2 * w), Math.max(0.5, y - 2 * w), Math.max(0.1, r - w)));
      return slab(s, z);
    }
    case 'dome': {   // hollow upper half-ellipsoid: a mouse's top shell
      const g = new THREE.SphereGeometry(0.5, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2);
      g.rotateX(Math.PI / 2); g.translate(0, 0, -0.25); g.scale(x, y, 2 * z); return g;
    }
    case 'coil': {   // flat wound coil: concentric copper turns
      const turns = 9, rOut = x / 2, rIn = x * 0.18, step = (rOut - rIn) / turns, tube = Math.max(0.08, Math.min(z / 2, step * 0.42));
      const rings = Array.from({ length: turns }, (_, i) => new THREE.TorusGeometry(rIn + step * (i + 0.5), tube, 4, 56));
      const g = mergeGeometries(rings); rings.forEach(r => r.dispose()); g.scale(1, y / Math.max(0.1, x), z / Math.max(0.1, 2 * tube)); return g;
    }
    case 'magnet_ring': {   // MagSafe: a ring of arc magnets
      const n = 18, rOut = x / 2, wid = Math.max(0.5, x * 0.09), rc = rOut - wid / 2, arc = 2 * Math.PI * rc / n * 0.82;
      const segs = Array.from({ length: n }, (_, i) => {
        const b = new THREE.BoxGeometry(arc, wid, z), a = i / n * Math.PI * 2;
        b.rotateZ(a + Math.PI / 2); b.translate(Math.cos(a) * rc, Math.sin(a) * rc, 0); return b;
      });
      const g = mergeGeometries(segs); segs.forEach(s => s.dispose()); g.scale(1, y / Math.max(0.1, x), 1); return g;
    }
    default: return new THREE.BoxGeometry(x, y, z);
  }
}

/** One part's geometry in the scan group's own (three) frame: shape -> rotation -> centre (spec) -> three -> offset. */
function partGeometry(p, offset) {
  const g = shapeGeometry(p), r = p.rotation_deg || { x: 0, y: 0, z: 0 };
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r.x * DEG, r.y * DEG, r.z * DEG, 'XYZ')));
  g.translate(p.position_mm.x, p.position_mm.y, p.position_mm.z);
  g.applyMatrix4(C);
  g.translate(offset.x, offset.y, offset.z);
  g.computeBoundingBox();
  return g;
}

// ---------- materials ----------
let pcbTex;
/** A fine trace / via pattern multiplied into PCB colours (one shared canvas texture, exported with the .glb). */
function pcbTexture() {
  if (pcbTex) return pcbTex;
  const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d');
  g.fillStyle = '#b4b4b4'; g.fillRect(0, 0, 512, 512);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.strokeStyle = '#e8e8e8'; g.lineCap = 'round';
  for (let i = 0; i < 140; i++) {   // manhattan traces with 45-degree jogs
    let x = rnd() * 512, y = rnd() * 512; g.lineWidth = rnd() < 0.2 ? 5 : 2; g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 4; k++) { const d = 20 + rnd() * 90, m = Math.floor(rnd() * 4); if (m === 0) x += d; else if (m === 1) y += d; else { x += d * 0.7; y += d * 0.7 * (m === 2 ? 1 : -1); } g.lineTo(x, y); }
    g.stroke();
  }
  g.fillStyle = '#f4f4f4';
  for (let i = 0; i < 260; i++) { g.beginPath(); g.arc(rnd() * 512, rnd() * 512, 1.5 + rnd() * 2, 0, Math.PI * 2); g.fill(); }
  pcbTex = new THREE.CanvasTexture(c); pcbTex.colorSpace = THREE.SRGBColorSpace; pcbTex.wrapS = pcbTex.wrapT = THREE.RepeatWrapping; pcbTex.anisotropy = 4;
  pcbTex.userData.shared = true;
  return pcbTex;
}
function realMaterial(p) {
  const [roughness, metalness] = MAT[p.material] || MAT.plastic;
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color), roughness, metalness, side: p.shape === 'dome' || p.shape === 'frame' ? THREE.DoubleSide : THREE.FrontSide });
  if (p.material === 'pcb') m.map = pcbTexture();
  if (p.material === 'screen') { m.emissive = new THREE.Color(0x0b0d18); }
  if (p.material === 'glass') { m.transparent = true; m.opacity = 0.72; }
  m.userData.emissive0 = m.emissive.clone();
  return m;
}
/** Layer i of n in the hologram: from the projector's cyan toward violet, so the stack reads layer by layer. */
const layerHue = (i, n) => new THREE.Color(COLORS.holo).lerp(new THREE.Color(COLORS.violet), n > 1 ? (i / (n - 1)) * 0.7 : 0);

function layerTag(text) {   // same DOM as app.js tag(text, 'layer'): dot, leader, label; styled by twin.html's .tag.layer
  const el = document.createElement('div'); el.className = 'tag layer';
  const lab = document.createElement('span'); lab.textContent = String(text).slice(0, 48);
  el.append(document.createElement('i'), document.createElement('b'), lab);
  const o = new CSS2DObject(el); o.userData.noExport = true; return o;
}

/**
 * @param {{group: THREE.Group, meshes: THREE.Mesh[], scale: number}} scan  buildScan's result
 * @param {object} scanSpec the sanitised scan it was built from
 * @param {object} spec the sanitised interior (research.mjs)
 */
export function buildInterior(scan, scanSpec, spec) {
  // buildScan grounds and centres its geometry; recover that offset from the main body (symmetric shapes keep their
  // centre), so interior parts land exactly where they sit in the scan's coordinates
  const p0 = scanSpec.parts[0], m0 = scan.meshes[0];
  const offset = m0 && p0 ? m0.userData.centre.clone().sub(toThree(p0.position_mm)) : new THREE.Vector3();
  const group = new THREE.Group(); group.name = `Inside: ${String(spec.object || scanSpec.name).slice(0, 40)}`;
  const n = spec.layers.length;
  const layers = [], meshes = [];
  spec.layers.forEach((L, i) => {
    const lg = new THREE.Group(); lg.name = L.name;
    const box = new THREE.Box3();
    const hue = layerHue(i, n);
    for (const p of L.parts) {
      const g = partGeometry(p, offset);
      box.union(g.boundingBox);
      const real = realMaterial(p), tint = (MAT[p.material] || MAT.plastic)[2];
      const mesh = new THREE.Mesh(g, real);
      mesh.name = p.name; mesh.castShadow = true; mesh.receiveShadow = true;
      // decorated here (the app's decorate() skips meshes that already have both looks)
      const holo = holoMaterial(tint, p.material === 'pcb' ? pcbTexture() : null);
      holo.uniforms.uColor.value.set(hue.r, hue.g, hue.b);
      if (p.material === 'pcb') holo.uniforms.uMapAmt.value = 0.3;
      if (p.shape === 'dome' || p.shape === 'frame') holo.side = THREE.DoubleSide;
      Object.assign(mesh.userData, { holo: tint, real, holoMat: holo, interior: { layer: i, layerName: L.name, note: p.note, part: p.name, material: p.material } });
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 28), edgeMaterial);
      e.userData.noExport = true; e.userData.edges = true; e.raycast = () => {}; mesh.add(e); mesh.userData.edgeLines = e;
      lg.add(mesh); meshes.push(mesh);
    }
    const tag = layerTag(L.name);
    const c = box.getCenter(new THREE.Vector3());
    tag.position.set(box.max.x + 2, c.y, c.z); tag.visible = false; lg.add(tag);
    group.add(lg);
    layers.push({ group: lg, name: L.name, order: i, box, tag, offset: new THREE.Vector3() });
  });

  // explode direction: the layers' depth axis (front_face), always opening upward or toward the camera, never into
  // the table; layer 0 (the front) travels furthest unless the front faces down, then the back does
  const face = String(spec.front_face || '+z'), k = face[1] || 'z', sgn = face[0] === '-' ? -1 : 1;
  const f = toThree({ x: k === 'x' ? sgn : 0, y: k === 'y' ? sgn : 0, z: k === 'z' ? sgn : 0 });
  const shell = new THREE.Box3(); for (const m of scan.meshes) { m.geometry.computeBoundingBox(); shell.union(m.geometry.boundingBox); }
  const ss = shell.getSize(new THREE.Vector3());
  const along = Math.abs(f.dot(ss)), foot = Math.max(...['x', 'y', 'z'].map(a => (Math.abs(f[a]) > 0.5 ? 0 : ss[a])));
  const down = f.y < -0.5, dir = down ? f.clone().negate() : f.clone();
  // stack them clear of each other: walking out from the anchored layer, each layer moves just far enough along dir
  // that its near side clears the previous layer's far side by a margin (a tall top shell doesn't swallow the wheel)
  const span = b => { let lo = Infinity, hi = -Infinity; for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) { const d = x * dir.x + y * dir.y + z * dir.z; lo = Math.min(lo, d); hi = Math.max(hi, d); } return [lo, hi]; };
  const thin = Math.abs(dir.y) > 0.5 && along < 0.3 * foot, margin = Math.max(4, foot * (thin ? 0.13 : 0.1));
  // thin, flat devices (phones, boards) also stagger the stack back along their long side, so every layer's face shows
  let slide = new THREE.Vector3();
  if (thin) slide = (ss.z >= ss.x ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(-1, 0, 0)).multiplyScalar(foot * 0.5 / Math.max(1, n - 1));
  const byRank = [...layers].sort((p, q) => (down ? p.order - q.order : q.order - p.order));
  let top = -Infinity;
  byRank.forEach((l, rank) => {
    const [lo, hi] = span(l.box), d = rank === 0 ? 0 : Math.max(0, top + margin - lo);
    l.offset.copy(dir).multiplyScalar(d).add(slide.clone().multiplyScalar(rank));
    top = hi + d;
  });

  scan.group.add(group);
  const I = { group, layers, meshes, scan, spec, shellMeshes: scan.meshes, xray: false, e: 0, holo: true, lit: null, axis: dir };
  group.visible = false;
  return I;
}

function ghostShell(I, on) {
  for (const m of I.shellMeshes) {
    const r = m.userData.real || m.material, h = m.userData.holoMat;
    if (r && !Array.isArray(r)) {
      if (!r.userData.ghost0) r.userData.ghost0 = { transparent: r.transparent, opacity: r.opacity, depthWrite: r.depthWrite };
      const o = r.userData.ghost0;
      r.transparent = on || o.transparent; r.opacity = on ? GHOST.real : o.opacity; r.depthWrite = on ? false : o.depthWrite; r.needsUpdate = true;
    }
    if (h?.uniforms?.uOpacity) h.uniforms.uOpacity.value = on ? GHOST.holo : 1;
    m.castShadow = !on && !I.holo;
  }
}
/** A part's own see-through look (the enclosure layers in x-ray), on both materials; off restores it. */
function ghostPart(m, on) {
  const r = m.userData.real;
  if (!r.userData.ghost0) r.userData.ghost0 = { transparent: r.transparent, opacity: r.opacity, depthWrite: r.depthWrite };
  const o = r.userData.ghost0;
  r.transparent = on || o.transparent; r.opacity = on ? 0.2 : o.opacity; r.depthWrite = on ? false : o.depthWrite; r.needsUpdate = true;
  m.userData.ghosted = on;
  if (I0(m)) m.userData.holoMat.uniforms.uOpacity.value = on ? 0.45 : 1;
}
const I0 = m => m.userData.holoMat?.uniforms?.uOpacity;
function refresh(I) {
  const inside = I.xray || I.e > 0.01;
  I.group.visible = inside;
  ghostShell(I, inside);
  for (const m of I.shellMeshes) { const r = m.userData.real; if (inside && r?.userData.ghost0) r.opacity = I.e > 0.5 ? GHOST.real * 0.5 : GHOST.real; }
  // x-ray at rest: the device's own enclosure (first and last layers: display / back glass, top / bottom shell) also
  // turns see-through, or it would hide everything inside it; exploded, every layer is solid
  const n = I.layers.length, see = I.xray && I.e < 0.5 && n > 2;
  for (const l of I.layers) for (const m of l.group.children) if (m.isMesh) {
    const want = see && (l.order === 0 || l.order === n - 1);
    if (want !== !!m.userData.ghosted) ghostPart(m, want);
  }
  for (const l of I.layers) l.tag.visible = I.e > 0.85;
}

/** Explode: e = 0..1 (eased). The shell stays where it is (translucent), the layers slide apart in teardown order. */
export function explodeInterior(I, e) {
  I.e = THREE.MathUtils.clamp(Number(e) || 0, 0, 1);
  for (const m of I.shellMeshes) m.position.set(0, 0, 0);   // undo explodeScan's spread: the shell is the reference
  for (const l of I.layers) l.group.position.copy(l.offset).multiplyScalar(I.e);
  refresh(I);
}
/** X-ray: the shell turns translucent and the interior shows in place. */
export function setInteriorXray(I, on) { I.xray = !!on; refresh(I); }
/** Call after the app switched looks (its applyLook resets materials and shadows). */
export function setInteriorLook(I, holo) {
  I.holo = !!holo;
  for (const m of I.meshes) { m.material = holo ? m.userData.holoMat : m.userData.real; m.castShadow = !holo; if (m.userData.edgeLines) m.userData.edgeLines.visible = holo; }
  refresh(I);
  if (I.lit) highlightInterior(I, I.lit);
}

/** Hover / focus: the part under the ray, with its one-line note. */
export function pickInterior(I, raycaster) {
  if (!I?.group.visible) return null;
  const hit = raycaster.intersectObjects(I.meshes, false).find(h => h.object.visible);
  return hit ? partInfo(hit.object, hit.point) : null;
}
export function partInfo(mesh, at) {
  const d = mesh.userData.interior;
  if (!at) { mesh.geometry.computeBoundingBox(); at = mesh.geometry.boundingBox.getCenter(new THREE.Vector3()); mesh.localToWorld(at); }
  return { mesh, pos: at.clone(), title: d.part, body: d.note, said: d.layerName, layer: d.layer };
}
/** Brightens one part (null clears). */
export function highlightInterior(I, mesh) {
  if (I.lit && I.lit !== mesh) {
    const r = I.lit.userData.real; r.emissive.copy(r.userData.emissive0); r.emissiveIntensity = 1;
    I.lit.userData.holoMat.uniforms.uOpacity.value = I.lit.userData.ghosted ? 0.45 : 1;
  }
  I.lit = mesh || null;
  if (!mesh) return;
  const r = mesh.userData.real; r.emissive.set(0x3bd8ff); r.emissiveIntensity = 0.35;
  mesh.userData.holoMat.uniforms.uOpacity.value = 2.4;
}
/** Every part, in teardown order, for a list / keyboard focus. */
export const interiorItems = I => I.meshes.map(m => ({ mesh: m, layer: m.userData.interior.layerName, order: m.userData.interior.layer, name: m.name, note: m.userData.interior.note }));

/** World box of the shell plus the interior at explode e (default: fully exploded), for framing the camera. */
export function interiorBox(I, e = 1) {
  I.scan.group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of I.shellMeshes) box.union(m.geometry.boundingBox.clone().applyMatrix4(I.scan.group.matrixWorld));
  for (const l of I.layers) box.union(l.box.clone().translate(l.offset.clone().multiplyScalar(e)).applyMatrix4(I.scan.group.matrixWorld));
  return box;
}

export function disposeInterior(I) {
  I.scan.group.remove(I.group);
  ghostShell(I, false);
  I.group.traverse(o => {
    if (o.element) o.element.remove();
    if (o.geometry) o.geometry.dispose();
    if (o.isMesh) { o.userData.real?.dispose(); o.userData.holoMat?.dispose(); }
  });
}
