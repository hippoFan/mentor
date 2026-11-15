// Hologram look: projected-light surfaces, edge lines, the projector floor, Mentor's rings and the holographic jumper.
import * as THREE from 'three';

export const clock = { value: 0 };   // shared uTime for every shader here
const hex = h => { const c = new THREE.Color(h); return new THREE.Vector3(c.r, c.g, c.b); };   // linear, like every other colour
export const COLORS = { holo: 0x3bd8ff, cyan: 0x3be8ff, violet: 0xa86bff, mentor: 0xffc845, warn: 0xff3b30, warn2: 0xff8a3d };

// ---------- hologram surface ----------
const HOLO_VERT = /* glsl */`
  varying vec3 vN; varying vec3 vW; varying vec2 vUv; varying vec3 vIC;
  void main() {
    vec4 p = vec4(position, 1.0); vec3 n = normal;
    #ifdef USE_INSTANCING
      p = instanceMatrix * p; n = mat3(instanceMatrix) * n;
    #endif
    vIC = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      vIC = instanceColor;
    #endif
    vec4 w = modelMatrix * p; vW = w.xyz; vN = normalize(mat3(modelMatrix) * n); vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const HOLO_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uTime, uFill, uRim, uOpacity, uMapAmt, uUseIC; uniform sampler2D uMap;
  varying vec3 vN; varying vec3 vW; varying vec2 vUv; varying vec3 vIC;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    vec3 V = normalize(cameraPosition - vW);
    float f = pow(1.0 - abs(dot(normalize(vN), V)), 2.2);
    float scan = 0.82 + 0.18 * sin(vW.y * 3.4 + vW.x * 0.02 - uTime * 2.2);          // fine horizontal scanlines
    float sweep = smoothstep(0.0, 0.08, 0.08 - abs(fract(vW.y * 0.025 - uTime * 0.18) - 0.5) + 0.42) * 0.35;  // slow rising band
    float flick = 0.94 + 0.06 * hash(floor(uTime * 24.0));
    float m = uMapAmt > 0.0 ? dot(texture2D(uMap, vUv).rgb, vec3(0.333)) * uMapAmt : 0.0;
    vec3 col = mix(uColor, vIC, uUseIC);
    float a = (uFill + f * uRim + m) * scan * flick * uOpacity + sweep * uFill * 2.0;
    gl_FragColor = vec4(col * a + vec3(m * 0.35), a);
  }`;
const TINTS = {   // fill, rim
  pcb: [0.035, 0.5], body: [0.03, 0.6], metal: [0.05, 0.8], dark: [0.01, 0.2], led: [0.4, 0.8],
};
export function holoMaterial(tint, map) {
  const [fill, rim] = TINTS[tint] || TINTS.body;
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: hex(COLORS.holo) }, uTime: clock, uFill: { value: fill }, uRim: { value: rim }, uOpacity: { value: 1 },
      uMap: { value: map || null }, uMapAmt: { value: map ? 0.55 : 0 }, uUseIC: { value: tint === 'led' ? 0.85 : 0 },
    },
    vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: tint === 'pcb' ? THREE.FrontSide : THREE.DoubleSide,
  });
}
export const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x8fefff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });

// ---------- radial glow sprite texture ----------
let haloTex;
export function haloTexture() {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  haloTex = new THREE.CanvasTexture(c); return haloTex;
}

// ---------- Mentor's ring on a hole / part ----------
export function makeRing(color, { radius = 2.0, warn = false } = {}) {
  const g = new THREE.Group(); g.name = warn ? 'Mentor warning' : 'Mentor ring';
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.78, radius, 48), mat); ring.rotation.x = -Math.PI / 2;
  const outer = new THREE.Mesh(new THREE.RingGeometry(radius * 1.45, radius * 1.6, 48), mat.clone()); outer.rotation.x = -Math.PI / 2;
  const hs = radius > 4 ? radius * 3.4 : radius * 6;
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(hs, hs), new THREE.MeshBasicMaterial({ color, map: haloTexture(), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  halo.rotation.x = -Math.PI / 2; halo.position.y = -0.02;
  g.add(halo, ring, outer);
  const born = clock.value;
  g.userData.update = () => {
    const t = clock.value - born, k = warn ? 5.5 : 2.4;
    const intro = Math.min(1, t / 0.45);
    ring.scale.setScalar((0.4 + 0.6 * easeOut(intro)) * (1 + 0.06 * Math.sin(t * k)));
    const p = (t * (warn ? 1.4 : 0.8)) % 1;
    outer.scale.setScalar(0.8 + p * 0.9); outer.material.opacity = (1 - p) * 0.8 * intro;
    halo.material.opacity = (0.4 + 0.25 * Math.sin(t * k)) * intro * (radius > 4 ? 0.45 : 1);
  };
  g.userData.update();
  return g;
}

/** Bobbing pointer for "arrow" marks. */
export function makeArrow(color) {
  const g = new THREE.Group(); g.name = 'Mentor arrow';
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1.8, 5, 24), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  cone.rotation.x = Math.PI; g.add(cone);
  const born = clock.value;
  g.userData.update = () => { cone.position.y = 7 + Math.sin((clock.value - born) * 3) * 1.4; };
  g.userData.update(); g.add(makeRing(color, { radius: 1.8 }));
  return g;
}

// ---------- holographic jumper ----------
const WIRE_VERT = /* glsl */`
  varying vec2 vUv; varying vec3 vN; varying vec3 vW;
  void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const WIRE_FRAG = /* glsl */`
  uniform vec3 uA, uB; uniform float uTime, uLen, uProgress, uGlow, uSpeed;
  varying vec2 vUv; varying vec3 vN; varying vec3 vW;
  void main() {
    float s = vUv.x;
    if (s > uProgress) discard;
    vec3 V = normalize(cameraPosition - vW);
    float ndv = abs(dot(normalize(vN), V));
    vec3 base = mix(uA, uB, smoothstep(0.0, 1.0, s));
    float L = s * uLen, ang = vUv.y * 6.2831853;
    // two counter-wound helices = a braid
    float h1 = smoothstep(0.55, 0.95, sin(ang * 3.0 + L * 1.25));
    float h2 = smoothstep(0.55, 0.95, sin(-ang * 3.0 + L * 1.25 + 1.4));
    float braid = max(h1, h2);
    float pulse = 0.0;
    for (int i = 0; i < 2; i++) { float p = fract(L / 34.0 - uTime * uSpeed - float(i) * 0.5); pulse += pow(smoothstep(0.82, 1.0, p), 3.0); }
    float head = smoothstep(0.06, 0.0, uProgress - s) * step(uProgress, 0.999);   // bright tip while it draws in
    if (uGlow > 0.5) {   // soft outer shell: bright in the middle of the tube, fading to the silhouette
      float a = pow(ndv, 1.6) * (0.28 + 0.5 * pulse + 0.6 * head);
      gl_FragColor = vec4(base * a, a);
    } else {
      float fres = pow(1.0 - ndv, 2.0);
      vec3 col = base * (0.45 + 0.75 * braid) + mix(base, vec3(1.0), 0.6) * fres * 1.3 + vec3(1.0) * (pulse * 0.9 + head);
      gl_FragColor = vec4(col, 1.0);
    }
  }`;
function wireMaterial(a, b, len, glow, speed) {
  return new THREE.ShaderMaterial({
    uniforms: { uA: { value: hex(a) }, uB: { value: hex(b) }, uTime: clock, uLen: { value: len }, uProgress: { value: 0 }, uGlow: { value: glow ? 1 : 0 }, uSpeed: { value: speed } },
    vertexShader: WIRE_VERT, fragmentShader: WIRE_FRAG,
    ...(glow ? { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } : {}),
  });
}

/**
 * Jumper from `a` to `b` (world points on the hole tops). Plugs stand in the holes when `plugA` / `plugB` is set.
 * warn = the red "do not connect" span (lower arc, no plugs, faster pulses).
 */
export function makeWire(a, b, { plugA = true, plugB = true, warn = false } = {}) {
  const g = new THREE.Group(); g.name = warn ? 'Warning span' : 'Holographic jumper';
  const cA = warn ? COLORS.warn : COLORS.cyan, cB = warn ? COLORS.warn2 : COLORS.violet;
  const PLUG = 12.5;
  const p0 = a.clone().add(new THREE.Vector3(0, plugA ? PLUG : 0.4, 0));
  const p3 = b.clone().add(new THREE.Vector3(0, plugB ? PLUG : 0.4, 0));
  const d = p0.distanceTo(p3), lift = Math.min(70, warn ? Math.max(5, d * 0.7) : Math.max(22, d * 0.5));
  const curve = new THREE.CubicBezierCurve3(p0, p0.clone().add(new THREE.Vector3(0, lift, 0)), p3.clone().add(new THREE.Vector3(0, lift, 0)), p3);
  const len = curve.getLength();
  const core = new THREE.Mesh(new THREE.TubeGeometry(curve, 180, warn ? 0.75 : 1.05, 18, false), wireMaterial(cA, cB, len, false, warn ? 1.6 : 0.85));
  const shell = new THREE.Mesh(new THREE.TubeGeometry(curve, 120, warn ? 2.0 : 2.7, 14, false), wireMaterial(cA, cB, len, true, warn ? 1.6 : 0.85));
  core.name = 'Jumper core'; shell.name = 'Jumper glow'; shell.userData.noExport = false;
  core.userData.exportColor = cA; shell.userData.exportColor = cB; shell.userData.glowShell = true;
  g.add(shell, core);
  const coreMat = core.material, shellMat = shell.material;   // export swaps materials for a moment; keep ours

  const ends = [];
  const plug = (at, color) => {
    const e = new THREE.Group(); e.position.copy(at);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(2.45, PLUG - 2.2, 2.45), new THREE.MeshStandardMaterial({ color: 0x141418, roughness: 0.45, metalness: 0.1, emissive: color, emissiveIntensity: 0.05 }));
    housing.position.y = 2.2 + (PLUG - 2.2) / 2; housing.name = 'Plug housing';
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.2, 2.2, 16), new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 1, roughness: 0.25 }));
    collar.position.y = 1.1; collar.name = 'Plug pin';
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 2.4, 16), new THREE.MeshStandardMaterial({ color: 0x0e0e12, roughness: 0.5, emissive: color, emissiveIntensity: 0.3 }));
    boot.position.y = PLUG + 0.6; boot.name = 'Plug boot';
    e.add(housing, collar, boot);
    return e;
  };
  if (plugA && !warn) { const e = plug(a, cA); g.add(e); ends.push(e); }
  if (plugB && !warn) { const e = plug(b, cB); g.add(e); ends.push(e); }
  const contactA = makeRing(cA, { radius: 1.9, warn }); contactA.position.copy(a).add(new THREE.Vector3(0, 0.12, 0));
  const contactB = makeRing(cB, { radius: 1.9, warn }); contactB.position.copy(b).add(new THREE.Vector3(0, 0.12, 0));
  g.add(contactA, contactB);
  ends.forEach(e => { e.visible = false; });
  contactB.visible = false;

  const born = clock.value;
  g.userData.curve = curve;
  g.userData.update = () => {
    const t = clock.value - born;
    const prog = Math.min(1, t / 1.1);
    coreMat.uniforms.uProgress.value = shellMat.uniforms.uProgress.value = easeInOut(prog);
    if (ends[0]) { ends[0].visible = true; ends[0].position.y = a.y + Math.max(0, 6 * (1 - Math.min(1, t / 0.35))); }
    if (prog >= 1) { if (ends[1]) { ends[1].visible = true; ends[1].position.y = b.y + Math.max(0, 6 * (1 - Math.min(1, (t - 1.1) / 0.3))); } contactB.visible = true; }
    contactA.userData.update(); contactB.userData.update();
  };
  g.userData.update();
  return g;
}

// ---------- projector floor (hologram mode) ----------
const FLOOR_FRAG = /* glsl */`
  uniform float uTime; varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0; float r = length(p), a = atan(p.y, p.x);
    float R = r * 260.0;                                   // mm from the centre
    float rings = smoothstep(0.9, 0.0, abs(fract(R / 20.0) - 0.5) * 20.0) * 0.12;
    float spokes = smoothstep(0.012, 0.0, abs(fract(a / 6.2831853 * 24.0) - 0.5) * 0.08 * R / 40.0) * 0.05 * step(30.0, R);
    vec2 gp = abs(fract(p * 260.0 / 10.0) - 0.5);
    float grid = smoothstep(0.06, 0.0, min(gp.x, gp.y)) * 0.035;
    float rim = smoothstep(3.0, 0.0, abs(R - 200.0)) * 0.35 + smoothstep(1.5, 0.0, abs(R - 214.0)) * 0.18;
    float sweep = pow(max(0.0, cos(a - uTime * 0.6)), 24.0) * smoothstep(200.0, 40.0, R) * 0.06;
    float fade = smoothstep(1.0, 0.55, r);
    float glow = smoothstep(160.0, 0.0, R) * 0.05;
    float v = (rings + spokes + grid + sweep) * fade + rim * step(r, 1.0) + glow;
    vec3 col = vec3(0.23, 0.85, 1.0);
    gl_FragColor = vec4(col * v, v);
  }`;
export function makeProjectorFloor() {
  const g = new THREE.Group(); g.name = 'Projector floor'; g.userData.noExport = true;
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(520, 520), new THREE.ShaderMaterial({
    uniforms: { uTime: clock }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: FLOOR_FRAG,
  }));
  disc.rotation.x = -Math.PI / 2;
  // tick ring: slow turn, like a projector's bezel
  const c = document.createElement('canvas'); c.width = c.height = 1024; const x = c.getContext('2d');
  x.translate(512, 512); x.strokeStyle = 'rgba(160,240,255,0.9)';
  for (let i = 0; i < 180; i++) { const a = i / 180 * Math.PI * 2, l = i % 15 === 0 ? 34 : i % 5 === 0 ? 20 : 10; x.lineWidth = i % 15 === 0 ? 4 : 2; x.beginPath(); x.moveTo(Math.cos(a) * (500 - l), Math.sin(a) * (500 - l)); x.lineTo(Math.cos(a) * 500, Math.sin(a) * 500); x.stroke(); }
  x.lineWidth = 6; for (const [s, e] of [[0.1, 0.9], [2.2, 3.4], [4.1, 4.5]]) { x.beginPath(); x.arc(0, 0, 450, s, e); x.stroke(); }
  const t = new THREE.CanvasTexture(c);
  const ticks = new THREE.Mesh(new THREE.PlaneGeometry(470, 470), new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  ticks.rotation.x = -Math.PI / 2; ticks.position.y = 0.05;
  g.add(disc, ticks);
  g.userData.update = () => { ticks.rotation.z = clock.value * 0.05; };
  return g;
}

export function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
export function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
