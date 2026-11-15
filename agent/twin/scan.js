// "Scan anything": builds an approximate 3D twin of any object from the scanner's primitive spec (scan.mjs), with the
// camera photo projected onto the faces the camera saw. One texture atlas per scan: the photo on top, a strip of
// colour swatches below; each triangle samples either the photo (it faced the camera) or its part's swatch (it didn't),
// so the same plain MeshStandardMaterial looks right on screen AND in the exported .glb.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const ATLAS = 1024, STRIP = 96, SWATCHES = 40;   // atlas px; bottom strip height; one swatch per part (<= 40 parts)
const PHOTO_V0 = STRIP / ATLAS;                   // uv v where the photo starts (CanvasTexture flipY: v=0 is the bottom)
const FACING = 0.32;                              // triangles facing the camera more than this get the photo
const DEG = Math.PI / 180;
const MAT = {   // [roughness, metalness, hologram tint]
  plastic: [0.55, 0.0, 'body'], metal: [0.3, 0.9, 'metal'], pcb: [0.5, 0.05, 'pcb'], glass: [0.08, 0.0, 'metal'],
  rubber: [0.9, 0.0, 'dark'], screen: [0.25, 0.0, 'metal'],
};

/** spec frame (x right, y away from the camera, z up) -> three (x right, y up, z toward the camera) */
const C = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const CT = C.clone().transpose();

/** One part's geometry from its spec (also used by twin/modify.js to rebuild a part Ody changed). */
export function primitive(p) {
  const { x, y, z } = p.size_mm;   // spec extents: x width, y depth, z height
  let g;
  switch (p.shape) {
    case 'box': g = new THREE.BoxGeometry(x, z, y); break;
    case 'rounded_box': g = new RoundedBoxGeometry(x, z, y, 3, Math.max(0.2, Math.min(x, y, z) * 0.22)); break;
    case 'cylinder': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 40, 1); g.scale(x, z, y); break;
    case 'cone': g = new THREE.CylinderGeometry(0, 0.5, 1, 40, 1); g.scale(x, z, y); break;
    case 'sphere': g = new THREE.SphereGeometry(0.5, 40, 24); g.scale(x, z, y); break;
    case 'capsule': {
      const r = Math.max(0.25, Math.min(x, y) / 2);
      g = new THREE.CapsuleGeometry(r, Math.max(0, z - 2 * r), 8, 32); g.scale(x / (2 * r), 1, y / (2 * r)); break;
    }
    case 'torus': {
      const tube = Math.max(0.25, Math.min(z, x / 2) / 2), R = Math.max(tube * 1.05, x / 2 - tube);
      g = new THREE.TorusGeometry(R, tube, 16, 48); g.rotateX(Math.PI / 2); g.scale(1, 1, y / Math.max(1, x)); break;
    }
    default: g = new THREE.BoxGeometry(x, z, y);
  }
  // rotation: Euler XYZ about the spec axes, conjugated into three's frame; then the part's centre
  const r = p.rotation_deg;
  const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r.x * DEG, r.y * DEG, r.z * DEG, 'XYZ'));
  g.applyMatrix4(C.clone().multiply(R).multiply(CT));
  g.translate(p.position_mm.x, p.position_mm.z, -p.position_mm.y);
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  flat.computeVertexNormals();
  return flat;
}

function swatchUv(i) { return [((i % SWATCHES) + 0.5) / SWATCHES, PHOTO_V0 / 2]; }

/**
 * The crop still shows table/background around the object, and the primitives are only approximately the object's
 * silhouette, so background pixels would land on the model's edges. Flood-fill the background in from the crop's
 * border (pixels close to the border's average colour) and paint it with the main body's colour.
 */
function cutBackground(img, fill) {
  const w = Math.max(1, Math.min(512, img.naturalWidth)), h = Math.max(1, Math.round(w * img.naturalHeight / Math.max(1, img.naturalWidth)));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  const im = g.getImageData(0, 0, w, h), d = im.data;
  let r = 0, gg = 0, b = 0, n = 0;
  const edge = (x, y) => { const i = (y * w + x) * 4; r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; };
  for (let x = 0; x < w; x++) { edge(x, 0); edge(x, h - 1); }
  for (let y = 0; y < h; y++) { edge(0, y); edge(w - 1, y); }
  r /= n; gg /= n; b /= n;
  // a busy border (object touching the edges, cluttered desk) has no one background colour: leave the photo alone
  let spread = 0;
  for (let x = 0; x < w; x += 4) { const i = x * 4; spread += Math.abs(d[i] - r) + Math.abs(d[i + 1] - gg) + Math.abs(d[i + 2] - b); }
  if (spread / Math.ceil(w / 4) > 90) return c;
  const near = i => Math.abs(d[i] - r) + Math.abs(d[i + 1] - gg) + Math.abs(d[i + 2] - b) < 75;
  const seen = new Uint8Array(w * h), stack = [];
  const push = (x, y) => { const k = y * w + x; if (!seen[k] && near(k * 4)) { seen[k] = 1; stack.push(k); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const k = stack.pop(), x = k % w, y = (k - x) / w;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  const hx = /^#[0-9a-f]{6}$/i.test(fill) ? parseInt(fill.slice(1), 16) : 0x808080, fr = hx >> 16, fg = (hx >> 8) & 255, fb = hx & 255;   // sRGB, like the photo
  for (let k = 0; k < w * h; k++) if (seen[k]) { d[k * 4] = fr; d[k * 4 + 1] = fg; d[k * 4 + 2] = fb; }
  g.putImageData(im, 0, 0);
  return c;
}

/** Atlas: swatches now, the photo when it has loaded. */
function makeAtlas(parts, photoUrl) {
  const c = document.createElement('canvas'); c.width = c.height = ATLAS;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, ATLAS, ATLAS);
  parts.forEach((p, i) => { g.fillStyle = p.color; g.fillRect((i % SWATCHES) * ATLAS / SWATCHES, ATLAS - STRIP, Math.ceil(ATLAS / SWATCHES), STRIP); });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.generateMipmaps = true;
  if (photoUrl) {
    const img = new Image();
    img.onload = () => {
      g.drawImage(cutBackground(img, parts[0]?.color || '#808080'), 0, 0, ATLAS, ATLAS - STRIP);
      tex.needsUpdate = true; tex.userData.photo = true;
    };
    img.src = photoUrl;
  }
  return tex;
}

/**
 * @param {object} spec sanitised scan (scan.mjs)
 * @param {string} photoUrl data: URL of the object's crop, or '' (then colours only)
 * @param {number[]} crop the crop's rect in 0..1 of the camera frame (bbox sits inside it)
 * @returns {{group: THREE.Group, meshes: THREE.Mesh[], anchors: {text: string, pos: THREE.Vector3, mesh: THREE.Mesh}[],
 *   size: THREE.Vector3, scale: number, atlas: THREE.Texture}}
 */
export function buildScan(spec, photoUrl, crop) {
  const group = new THREE.Group(); group.name = String(spec.name || 'Scanned object').slice(0, 40);
  const parts = spec.parts.slice(0, SWATCHES);
  const geoms = parts.map(primitive);

  // ground + centre the whole object (the model is told to, but never trust it): bottom at y=0, centred in x/z
  const box = new THREE.Box3();
  for (const g of geoms) { g.computeBoundingBox(); box.union(g.boundingBox); }
  const centre = box.getCenter(new THREE.Vector3());
  for (const g of geoms) g.translate(-centre.x, -box.min.y, -centre.z);
  box.translate(new THREE.Vector3(-centre.x, -box.min.y, -centre.z));
  const size = box.getSize(new THREE.Vector3());

  // photo projection: orthographic from the camera's elevation e (90 = straight down)
  const e = THREE.MathUtils.clamp(spec.camera_elev_deg ?? 60, 0, 90) * DEG;
  const toCam = new THREE.Vector3(0, Math.sin(e), Math.cos(e));          // direction from the object toward the camera
  const up = new THREE.Vector3(0, Math.cos(e), -Math.sin(e));            // image "up" on the projection plane
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  const tmp = new THREE.Vector3();
  for (const g of geoms) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      const u = tmp.x, v = tmp.dot(up);
      if (u < umin) umin = u; if (u > umax) umax = u; if (v < vmin) vmin = v; if (v > vmax) vmax = v;
    }
  }
  // where the object's box sits inside the cropped photo (the crop has a little margin around the bbox)
  const [bx0, by0, bx1, by1] = spec.bbox, [cx0, cy0, cx1, cy1] = crop || spec.bbox;
  const cw = Math.max(1e-6, cx1 - cx0), ch = Math.max(1e-6, cy1 - cy0);
  const ix0 = (bx0 - cx0) / cw, ix1 = (bx1 - cx0) / cw, iy0 = (by0 - cy0) / ch, iy1 = (by1 - cy0) / ch;

  const atlas = makeAtlas(parts, photoUrl);
  const meshes = [], anchors = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  geoms.forEach((g, pi) => {
    const pos = g.attributes.position, uv = new Float32Array(pos.count * 2);
    const sw = swatchUv(pi);
    for (let t = 0; t < pos.count; t += 3) {
      a.fromBufferAttribute(pos, t); b.fromBufferAttribute(pos, t + 1); c.fromBufferAttribute(pos, t + 2);
      n.subVectors(c, b).cross(tmp.subVectors(a, b)).normalize();
      const photo = photoUrl && n.dot(toCam) > FACING;
      for (let k = 0; k < 3; k++) {
        const P = [a, b, c][k];
        if (photo) {
          const su = (P.x - umin) / Math.max(1e-6, umax - umin), sv = (vmax - P.dot(up)) / Math.max(1e-6, vmax - vmin);   // 0..1, top-left origin
          const px = ix0 + su * (ix1 - ix0), py = iy0 + sv * (iy1 - iy0);   // 0..1 in the crop
          uv[(t + k) * 2] = THREE.MathUtils.clamp(px, 0.001, 0.999);
          uv[(t + k) * 2 + 1] = 1 - THREE.MathUtils.clamp(py, 0.001, 0.999) * (1 - PHOTO_V0);
        } else { uv[(t + k) * 2] = sw[0]; uv[(t + k) * 2 + 1] = sw[1]; }
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const p = parts[pi], [rough, metal, tint] = MAT[p.material] || MAT.plastic;
    const mat = new THREE.MeshStandardMaterial({ map: atlas, roughness: rough, metalness: metal,
      ...(p.material === 'screen' ? { emissive: 0x111111 } : {}) });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = p.name; mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.holo = tint; mesh.userData.holoMap = atlas; mesh.userData.scanPart = pi; mesh.userData.scanSpec = p;
    g.computeBoundingBox();
    mesh.userData.centre = g.boundingBox.getCenter(new THREE.Vector3());
    group.add(mesh); meshes.push(mesh);
    if (p.label) {
      const top = mesh.userData.centre.clone(); top.y = g.boundingBox.max.y;
      anchors.push({ text: p.label, pos: top, mesh });
    }
  });
  if (!anchors.length && meshes[0]) {   // always name the object itself
    const m = meshes[0], top = m.userData.centre.clone(); top.y = m.geometry.boundingBox.max.y; anchors.push({ text: group.name, pos: top, mesh: m });
  }
  // very large objects are shown smaller so they fit the projector (the panel still gives the real size)
  const scale = Math.min(1, 300 / Math.max(size.x, size.y, size.z, 1));
  group.scale.setScalar(scale);
  return { group, meshes, anchors: anchors.slice(0, 8), size, scale, atlas };
}

/** Explode: every part slides away from the object's centre, higher parts rise more. e = 0..1 (eased). */
export function explodeScan(scan, e) {
  const s = scan.size, k = Math.max(s.x, s.z) * 0.55;
  for (const m of scan.meshes) {
    const c = m.userData.centre, dx = c.x, dz = c.z, len = Math.hypot(dx, dz) || 1;
    const out = Math.min(1, len / (Math.max(s.x, s.z) * 0.25));
    const lift = Math.max(0, c.y - s.y * 0.3) * 1.6 + (m.userData.scanPart ? Math.max(6, s.y * 0.25) : 0);
    m.position.set(dx / len * k * out * e, lift * e, dz / len * k * out * e);
  }
}

export function disposeScan(scan) {
  scan.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && !Array.isArray(o.material)) o.material.dispose(); });
  scan.atlas.dispose();
}
