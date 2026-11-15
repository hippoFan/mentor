// Optional hand control. MediaPipe Tasks Vision (Apache-2.0) runs in this page from files served by this laptop;
// the camera picture never leaves the browser (CSP connect-src 'self' also blocks the library's usage logging).
const BASE = '/vendor/mediapipe';
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

/** True when the library is served and the browser can open a camera. Cheap; downloads nothing large. */
export async function handsAvailable() {
  if (!navigator.mediaDevices?.getUserMedia || typeof WebAssembly !== 'object') return false;
  try { const r = await fetch(`${BASE}/vision_bundle.mjs`, { method: 'HEAD' }); return r.ok; } catch { return false; }
}

/**
 * Opens the camera (asks permission), tracks up to two hands, calls onHands(hands, tMs) with landmarks mirrored like
 * a selfie view, and draws a small skeleton preview. Returns { stop }.
 */
export async function startHands({ onHands, preview }) {
  // camera first, so the permission prompt answers the click straight away; then the model (about 20 MB, local)
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
  let landmarker;
  try {
    const { FilesetResolver, HandLandmarker } = await import(`${BASE}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    for (const delegate of ['GPU', 'CPU']) {
      try {
        landmarker = await HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: '/twin/models/hand_landmarker.task', delegate },
          runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.6, minTrackingConfidence: 0.5,
        });
        break;
      } catch (e) { if (delegate === 'CPU') throw e; }
    }
  } catch (e) { for (const tr of stream.getTracks()) tr.stop(); throw e; }
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  await video.play();
  const g = preview.getContext('2d');
  let running = true, lastVideoT = -1, raf = 0;
  const loop = () => {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === lastVideoT) return;
    lastVideoT = video.currentTime;
    const t = performance.now();
    let res;
    try { res = landmarker.detectForVideo(video, t); } catch { return; }
    const hands = (res.landmarks || []).map(lm => ({ landmarks: lm.map(p => ({ x: 1 - p.x, y: p.y, z: p.z })) }));
    // preview: the camera, dimmed and mirrored, with the tracked skeleton on top
    const W = preview.width, H = preview.height;
    g.save(); g.clearRect(0, 0, W, H); g.globalAlpha = 0.28; g.translate(W, 0); g.scale(-1, 1); g.drawImage(video, 0, 0, W, H); g.restore();
    g.strokeStyle = 'rgba(59,216,255,0.9)'; g.fillStyle = '#FFC845'; g.lineWidth = 1.5;
    for (const h of hands) {
      const lm = h.landmarks;
      g.beginPath(); for (const [a, b] of BONES) { g.moveTo(lm[a].x * W, lm[a].y * H); g.lineTo(lm[b].x * W, lm[b].y * H); } g.stroke();
      for (const i of [4, 8]) { g.beginPath(); g.arc(lm[i].x * W, lm[i].y * H, 2.5, 0, Math.PI * 2); g.fill(); }
    }
    onHands(hands, t);
  };
  loop();
  return {
    stop() {
      running = false; cancelAnimationFrame(raf);
      for (const tr of stream.getTracks()) tr.stop();
      video.srcObject = null; try { landmarker.close(); } catch { /* already closed */ }
      g.clearRect(0, 0, preview.width, preview.height);
      onHands([], performance.now());
    },
  };
}
