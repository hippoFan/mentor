// "Make it a brush tip": Ody's {type:'modify'} changes to one part of the twin (colour, material, scale, shape,
// offset, name; always the part's TOTAL edit from the original, not a step), applied to both looks (realistic material + hologram shader) as a 300-500 ms morph, and undone by
// revert. The part's untouched state is captured once (part.base), so revert and the before / after toggle (B) are
// exact. Pure three.js on the app's part records { objs, home, scale, removed }; app.js owns the UI around it.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { primitive } from './scan.js';

/** [roughness, metalness] per material word the agent may send. */
export const MATERIALS = { plastic: [0.55, 0], metal: [0.28, 0.92], glass: [0.06, 0], rubber: [0.95, 0], pcb: [0.5, 0.05], fabric: [1, 0], wood: [0.75, 0], ceramic: [0.32, 0] };
const MAT_COLOR = { metal: '#B9BCC2', glass: '#CFE8FF', rubber: '#232327', pcb: '#1E6B3C', fabric: '#5E6372', wood: '#9A6B3F', ceramic: '#EFECE6' };
export const SHAPES = ['box', 'rounded_box', 'cylinder', 'cone', 'sphere', 'capsule', 'torus'];
const HEX = /^#[0-9a-f]{6}$/i;
const num3 = (v, lo, hi) => (Array.isArray(v) && v.length === 3 && v.every(x => Number.isFinite(Number(x))) ? v.map(x => Math.max(lo, Math.min(hi, Number(x)))) : null);

/** The agent's change, validated: unknown keys dropped, numbers clamped, strings capped. null when nothing usable. */
export function cleanChange(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  if (typeof c.name === 'string' && c.name.trim()) out.name = c.name.trim().slice(0, 60);
  if (typeof c.color === 'string' && HEX.test(c.color.trim())) out.color = c.color.trim();
  if (typeof c.material === 'string' && c.material.trim()) out.material = MATERIALS[c.material.trim().toLowerCase()] ? c.material.trim().toLowerCase() : 'plastic';   // unknown -> plastic
  const s = num3(c.scale, 0.2, 5); if (s) out.scale = s;   // on the part's size_mm axes: x width, y depth, z height
  if (typeof c.shape === 'string' && SHAPES.includes(c.shape)) out.shape = c.shape;
  const o = num3(c.offset_mm, -200, 200); if (o) out.offset_mm = o;
  if (typeof c.note === 'string' && c.note.trim()) out.note = c.note.trim().slice(0, 200);
  return Object.keys(out).length ? out : null;
}

/** Plain words for a change ("brush tip shape, 1.4× longer, black rubber"), for tips, the rail and toasts. */
export function describeChange(c) {
  if (!c) return '';
  const bits = [];
  if (c.shape) bits.push(`${c.shape.replace('_', ' ')} shape`);
  if (c.scale) { const k = c.scale, m = Math.max(...k), n = Math.min(...k); bits.push(m === n ? `${+m.toFixed(2)}× size` : `scaled ${k.map(v => +v.toFixed(2)).join(' × ')}`); }
  if (c.material) bits.push(c.material);
  if (c.color) bits.push(c.color.toUpperCase());
  if (c.offset_mm) bits.push('moved');
  return bits.join(', ');
}

const arr = m => [].concat(m || []);
const one = (list, like) => (Array.isArray(like) ? list : list[0]);
/** Captures the untouched part once: per object its home, scale and local centre; per mesh its materials + geometry. */
export function capture(p) {
  if (p.base) return p.base;
  const objs = p.objs.map(o => {
    o.updateMatrixWorld(true);
    const inv = o.matrixWorld.clone().invert(), box = new THREE.Box3(), meshes = [];
    o.traverse(m => {
      if (!m.isMesh || !m.userData.real) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld)));
      meshes.push({ m, real: m.userData.real, holoMat: m.userData.holoMat, geo: m.geometry, edge: m.userData.edgeLines?.geometry || null, shapes: {} });
    });
    return { lc: box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()), meshes };
  });
  p.base = { name: p.name, note: p.note || '', home: p.home.map(v => v.clone()), scale: p.scale.map(v => v.clone()), objs };
  return p.base;
}

/** A primitive of the given shape filling the box of the old geometry, painted with the old geometry's first uv. */
function shapeGeometry(shape, old) {
  if (!old.boundingBox) old.computeBoundingBox();
  const b = old.boundingBox, s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  const x = Math.max(0.2, s.x), y = Math.max(0.2, s.y), z = Math.max(0.2, s.z);
  let g;
  switch (shape) {
    case 'rounded_box': g = new RoundedBoxGeometry(x, y, z, 3, Math.max(0.2, Math.min(x, y, z) * 0.22)); break;
    case 'cylinder': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 40, 1); g.scale(x, y, z); break;
    case 'cone': g = new THREE.CylinderGeometry(0, 0.5, 1, 40, 1); g.scale(x, y, z); break;
    case 'sphere': g = new THREE.SphereGeometry(0.5, 40, 24); g.scale(x, y, z); break;
    case 'capsule': { const r = Math.max(0.25, Math.min(x, z) / 2); g = new THREE.CapsuleGeometry(r, Math.max(0, y - 2 * r), 8, 32); g.scale(x / (2 * r), 1, z / (2 * r)); break; }
    case 'torus': { const tube = Math.max(0.25, Math.min(y, x / 2) / 2), R = Math.max(tube * 1.05, x / 2 - tube); g = new THREE.TorusGeometry(R, tube, 16, 48); g.rotateX(Math.PI / 2); g.scale(1, 1, z / Math.max(1, x)); break; }
    default: g = new THREE.BoxGeometry(x, y, z);
  }
  g.translate(c.x, c.y, c.z);
  const flat = g.index ? g.toNonIndexed() : g; if (flat !== g) g.dispose();
  flat.computeVertexNormals(); flat.computeBoundingBox();
  const uv0 = old.attributes.uv ? [old.attributes.uv.getX(0), old.attributes.uv.getY(0)] : [0, 0];
  const uv = new Float32Array(flat.attributes.position.count * 2);
  for (let i = 0; i < uv.length; i += 2) { uv[i] = uv0[0]; uv[i + 1] = uv0[1]; }
  flat.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return flat;
}

/**
 * A scanned part rebuilt from its own spec with the new shape and size_mm scaled on its own axes (so a tip lying along
 * x grows along its length, whatever its rotation), centred where the original was. Painted with the old first uv.
 */
function scanGeometry(spec, mod, old) {
  const k = mod.scale || [1, 1, 1], sz = spec.size_mm;
  const g = primitive({ ...spec, shape: mod.shape || spec.shape, size_mm: { x: sz.x * k[0], y: sz.y * k[1], z: sz.z * k[2] } });
  const ref = primitive(spec);
  ref.computeBoundingBox(); g.computeBoundingBox(); if (!old.boundingBox) old.computeBoundingBox();
  const shift = old.boundingBox.getCenter(new THREE.Vector3()).sub(ref.boundingBox.getCenter(new THREE.Vector3()));   // buildScan's grounding + centring
  ref.dispose(); g.translate(shift.x, shift.y, shift.z); g.computeBoundingBox();
  const uv0 = old.attributes.uv ? [old.attributes.uv.getX(0), old.attributes.uv.getY(0)] : [0, 0];
  const uv = new Float32Array(g.attributes.position.count * 2);
  for (let i = 0; i < uv.length; i += 2) { uv[i] = uv0[0]; uv[i + 1] = uv0[1]; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
const holoColorLike = (base, hex) => { const c = new THREE.Color(hex); return base?.isColor ? c : new THREE.Vector3(c.r, c.g, c.b); };
const lerpInto = (dst, a, b, e) => (dst.isColor ? dst.lerpColors(a, b, e) : dst.lerpVectors(a, b, e));
/** The modified materials of one mesh (cloned once per mesh, so shared materials elsewhere are never touched). */
function modMaterials(e, mod) {
  if (!e.modReal) {
    e.modReal = arr(e.real).map(r => r.clone());
    e.modHolo = arr(e.holoMat).map(h => { const c = h.clone(); for (const k of ['uTime', 'uMap']) if (h.uniforms?.[k]) c.uniforms[k] = h.uniforms[k]; return c; });
  }
  const base = arr(e.real), baseH = arr(e.holoMat), to = [], toH = [];
  e.modReal.forEach((r, j) => {
    r.copy(base[j]);
    const hex = mod.color || (mod.material && MAT_COLOR[mod.material]) || null;
    if (mod.material && 'roughness' in r) { [r.roughness, r.metalness] = MATERIALS[mod.material]; r.transparent = mod.material === 'glass' || base[j].transparent; r.opacity = mod.material === 'glass' ? 0.42 : base[j].opacity; }
    if (hex && r.color) { if (r.map) { r.map = null; r.needsUpdate = true; } to[j] = new THREE.Color(hex); } else to[j] = r.color?.clone() || null;
  });
  e.modHolo.forEach((h, j) => {
    const b = baseH[j]?.uniforms?.uColor?.value, hex = mod.color || (mod.material && MAT_COLOR[mod.material]);
    if (!b || !h.uniforms?.uColor) { toH[j] = null; return; }
    h.uniforms.uColor.value = b.clone();
    toH[j] = hex ? lerpInto(b.clone(), b, holoColorLike(b, hex), 0.7) : b.clone();   // the hologram keeps its light, takes the hue
  });
  return { to, toH };
}

/**
 * The tween that takes part p to 'after' (its p.mod applied) or 'before' (as captured). Call step(e) with eased
 * e = 0..1 each frame, then end(). Sets p.home / p.scale to the new resting state at once (Combine and restore use
 * them). holo: which look is on now.
 */
export function transition(p, which, { holo = true, dur = 0.4 } = {}) {
  const base = capture(p), mod = which === 'after' ? p.mod || {} : {};
  const sc = mod.scale || [1, 1, 1], k = new THREE.Vector3(sc[0], sc[2], sc[1]);   // size_mm (x, y depth, z up) -> three (x, y up, z)
  const objs = p.objs.map((o, i) => {
    const S = o.userData.scanSpec ? base.scale[i].clone() : base.scale[i].clone().multiply(k);   // scanned parts are rebuilt instead
    const shift = base.scale[i].clone().sub(S).multiply(base.objs[i].lc).applyQuaternion(o.quaternion);   // keep the part's centre in place
    let off = new THREE.Vector3();
    if (mod.offset_mm && o.parent) {   // offset in world mm, converted to the parent's frame (scans are shown scaled)
      const w = o.getWorldPosition(new THREE.Vector3());
      off = o.parent.worldToLocal(w.clone().add(new THREE.Vector3(...mod.offset_mm))).sub(o.parent.worldToLocal(w.clone()));
    }
    const home = base.home[i].clone().add(shift).add(off);
    const from = { pos: o.position.clone(), scale: o.scale.clone() };
    const to = { pos: o.position.clone().add(home.clone().sub(p.home[i])), scale: p.removed ? o.scale.clone() : S.clone() };
    const e0 = base.objs[i].meshes[0];
    if (o.userData.scanSpec && e0?.m === o && !p.removed) {   // rebuilt geometry: start at the old size, grow / shrink into the new one
      const key = JSON.stringify([mod.shape || '', mod.scale || '']);
      const geo = which === 'after' && (mod.shape || mod.scale) ? (e0.shapes[key] ||= scanGeometry(o.userData.scanSpec, mod, e0.geo)) : e0.geo;
      if (o.geometry !== geo) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); if (!geo.boundingBox) geo.computeBoundingBox();
        const a = o.geometry.boundingBox.getSize(new THREE.Vector3()), b = geo.boundingBox.getSize(new THREE.Vector3()), c = geo.boundingBox.getCenter(new THREE.Vector3());
        const r = new THREE.Vector3(a.x / Math.max(b.x, 1e-3), a.y / Math.max(b.y, 1e-3), a.z / Math.max(b.z, 1e-3));
        from.scale = S.clone().multiply(r);
        from.pos = o.position.clone().add(S.clone().sub(from.scale).multiply(c));
        o.geometry = geo;
        if (o.userData.edgeLines) o.userData.edgeLines.geometry = geo === e0.geo ? e0.edge : (e0.shapes[`${key}:edges`] ||= new THREE.EdgesGeometry(geo, 28));
      }
    }
    p.home[i] = home; p.scale[i] = S;
    return { o, from, to };
  });
  const colors = [], swapBack = [];
  for (const ob of base.objs) for (const e of ob.meshes) {
    const m = e.m;
    // shape: scanned / researched primitives only (board parts are built from many pieces)
    const rebuilt = which === 'after' && m.userData.scanSpec && (mod.shape || mod.scale);
    const shaped = which === 'after' && !rebuilt && mod.shape && m.userData.interior;
    const key = JSON.stringify([mod.shape || '', mod.scale || '']);
    const geo = rebuilt ? (e.shapes[key] ||= scanGeometry(m.userData.scanSpec, mod, e.geo)) : shaped ? (e.shapes[key] ||= shapeGeometry(mod.shape, e.geo)) : e.geo;
    if (m.geometry !== geo) {
      m.geometry = geo;
      if (m.userData.edgeLines) m.userData.edgeLines.geometry = geo === e.geo ? e.edge : (e.shapes[`${key}:edges`] ||= new THREE.EdgesGeometry(geo, 28));
    }
    if (which === 'after' && (mod.color || mod.material)) {
      const fromR = arr(m.userData.real).map(r => r.color?.clone() || null), fromH = arr(m.userData.holoMat).map(h => h.uniforms?.uColor?.value?.clone() || null);
      const { to, toH } = modMaterials(e, mod);
      m.userData.real = one(e.modReal, e.real); m.userData.holoMat = one(e.modHolo, e.holoMat);
      m.material = holoNow() ? m.userData.holoMat : m.userData.real;
      e.modReal.forEach((r, j) => { if (r.color && to[j]) colors.push({ c: r.color, a: fromR[j] || r.color.clone(), b: to[j] }); });
      e.modHolo.forEach((h, j) => { if (toH[j]) colors.push({ c: h.uniforms.uColor.value, a: fromH[j] || toH[j].clone(), b: toH[j] }); });
    } else if (e.modReal && m.userData.real !== e.real) {   // back to the captured materials: fade, then swap
      e.modReal.forEach((r, j) => { const b = arr(e.real)[j]; if (r.color && b?.color) colors.push({ c: r.color, a: r.color.clone(), b: b.color.clone() }); });
      e.modHolo.forEach((h, j) => { const b = arr(e.holoMat)[j]?.uniforms?.uColor?.value; if (b && h.uniforms?.uColor) colors.push({ c: h.uniforms.uColor.value, a: h.uniforms.uColor.value.clone(), b: b.clone() }); });
      swapBack.push(e);
    }
  }
  return {
    p, dur, t: 0,
    step(e) {
      for (const { o, from, to } of objs) { o.position.lerpVectors(from.pos, to.pos, e); o.scale.lerpVectors(from.scale, to.scale, e); }
      for (const c of colors) lerpInto(c.c, c.a, c.b, e);
    },
    end() {
      this.step(1);
      for (const e of swapBack) { e.m.userData.real = e.real; e.m.userData.holoMat = e.holoMat; e.m.material = holoNow() ? e.holoMat : e.real; }
    },
  };
  function holoNow() { return typeof holo === 'function' ? holo() : holo; }
}
