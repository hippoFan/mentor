// Optional hand control. MediaPipe Tasks Vision (Apache-2.0) runs in this page from files served by this laptop;
// the camera picture never leaves the browser (CSP connect-src 'self' also blocks the library's usage logging).
// Detection runs once per new camera frame (requestVideoFrameCallback) at 20-30 Hz, backing off when the detector is
// slow, so the 3D view keeps its frame rate; drawing is left to the page's render loop (twin/handui.js).
const BASE = '/vendor/mediapipe';

/** True when the library is served and the browser can open a camera. Cheap; downloads nothing large. */
export async function handsAvailable() {
  if (!navigator.mediaDevices?.getUserMedia || typeof WebAssembly !== 'object') return false;
  try { const r = await fetch(`${BASE}/vision_bundle.mjs`, { method: 'HEAD' }); return r.ok; } catch { return false; }
}

/**
 * Opens the camera (asks permission), tracks up to four hands (the gestures keep the closest), and calls
 * onHands(hands, tMs, { aspect, lowLight, detectMs }) with landmarks mirrored like a selfie view.
 * Returns { video, stop }; the video element stays in this page (for the optional preview thumbnail).
 */
export async function startHands({ onHands }) {
  // camera first, so the permission prompt answers the click straight away; then the model (about 8 MB, local)
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' }, audio: false });
  let landmarker;
  try {
    const { FilesetResolver, HandLandmarker } = await import(`${BASE}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    for (const delegate of ['GPU', 'CPU']) {
      try {
        landmarker = await HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: '/twin/models/hand_landmarker.task', delegate },
          // 4, not 2: someone walking behind you must not crowd your own hands out; gestures.js ignores small hands
          runningMode: 'VIDEO', numHands: 4, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        break;
      } catch (e) { if (delegate === 'CPU') throw e; }
    }
  } catch (e) { for (const tr of stream.getTracks()) tr.stop(); throw e; }
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  await video.play();
  const aspect = (video.videoWidth || 640) / (video.videoHeight || 480);
  // low light: the mean brightness of a 16 x 12 copy of the picture, once a second
  const probe = document.createElement('canvas'); probe.width = 16; probe.height = 12;
  const pg = probe.getContext('2d', { willReadFrequently: true });
  let running = true, lastVideoT = -1, raf = 0, vfc = 0, nextAt = 0, cost = 10, lowLight = false, lightAt = 0;
  const detect = () => {
    const t = performance.now();
    if (t < nextAt || video.readyState < 2 || video.currentTime === lastVideoT) return;
    lastVideoT = video.currentTime;
    let res;
    const t0 = performance.now();
    try { res = landmarker.detectForVideo(video, t); } catch { return; }
    cost += 0.2 * (performance.now() - t0 - cost);
    nextAt = t + Math.min(50, Math.max(33, cost * 2.2)) - 4;   // 20-30 Hz: a slow detector backs off, the 3D keeps its frames
    if (t - lightAt > 1000) {
      lightAt = t;
      try {
        pg.drawImage(video, 0, 0, 16, 12);
        const d = pg.getImageData(0, 0, 16, 12).data; let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        lowLight = s / (d.length / 4) / 255 < 0.16;
      } catch { /* a frame that can't be read: keep the last answer */ }
    }
    const hands = (res.landmarks || []).map(lm => ({ landmarks: lm.map(p => ({ x: 1 - p.x, y: p.y, z: p.z })) }));
    onHands(hands, t, { aspect, lowLight, detectMs: cost });
  };
  const useVfc = typeof video.requestVideoFrameCallback === 'function';
  const loop = () => {
    if (!running) return;
    if (useVfc) vfc = video.requestVideoFrameCallback(loop); else raf = requestAnimationFrame(loop);
    detect();
  };
  loop();
  return {
    video,
    stop() {
      running = false; cancelAnimationFrame(raf); if (useVfc) try { video.cancelVideoFrameCallback(vfc); } catch { /* gone */ }
      for (const tr of stream.getTracks()) tr.stop();
      video.srcObject = null; try { landmarker.close(); } catch { /* already closed */ }
      onHands([], performance.now(), { aspect, lowLight: false });
    },
  };
}
