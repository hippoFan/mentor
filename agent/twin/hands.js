// Optional hand control. MediaPipe Tasks Vision (Apache-2.0) runs in this page from files served by this laptop;
// the camera picture never leaves the browser (CSP connect-src 'self' also blocks the library's usage logging).
// Detection runs in a Worker (twin/handworker.js) once per new camera frame (requestVideoFrameCallback) at 20-30 Hz,
// one frame in flight, so the 3D view keeps its frame rate; if the worker can't start it runs here instead.
// Drawing is left to the page's render loop (twin/handui.js).
const BASE = '/vendor/mediapipe';

/** True when the library is served and the browser can open a camera. Cheap; downloads nothing large. */
export async function handsAvailable() {
  if (!navigator.mediaDevices?.getUserMedia || typeof WebAssembly !== 'object') return false;
  try { const r = await fetch(`${BASE}/vision_bundle.mjs`, { method: 'HEAD' }); return r.ok; } catch { return false; }
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : Infinity; };
const yieldFrame = () => new Promise(r => setTimeout(r, 0));
const mirror = lms => (lms || []).map(lm => ({ landmarks: lm.map(p => ({ x: 1 - p.x, y: p.y, z: p.z })) }));

/** True when WebGL is software-rendered here (no point timing MediaPipe's GPU delegate). */
function softwareGL() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software/i.test(name);
  } catch { return false; }
}

/** Detection in a Worker: resolves { detect(video, t, cb) -> started?, delegate, bench, close } or rejects. */
async function workerDetector(video, force, noGpu) {
  if (typeof Worker !== 'function' || typeof createImageBitmap !== 'function') throw new Error('no worker');
  const w = new Worker('/twin/handworker.js');
  const first = await createImageBitmap(video);
  const ready = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('hand worker took too long')), 25000);   // a CPU busy drawing software GL can take ~15 s
    w.onmessage = e => { if (e.data?.type === 'ready') { clearTimeout(to); res(e.data); } else if (e.data?.type === 'error') { clearTimeout(to); rej(new Error(e.data.message)); } };
    w.onerror = e => { clearTimeout(to); e.preventDefault?.(); rej(new Error('hand worker failed')); };
    w.postMessage({ type: 'init', bitmap: first, force, noGpu }, [first]);
  }).catch(e => { w.terminate(); throw e; });
  let busy = false, cb = null;
  w.onmessage = e => { if (e.data?.type !== 'hands') return; busy = false; const f = cb; cb = null; f?.(mirror(e.data.landmarks), e.data.ms); };
  w.onerror = e => { e.preventDefault?.(); busy = false; cb = null; };
  return {
    delegate: ready.delegate, bench: ready.bench, where: 'worker',
    detect(t, done) {
      if (busy) return false;
      busy = true; cb = done;
      createImageBitmap(video).then(bm => w.postMessage({ type: 'frame', bitmap: bm, ts: t }, [bm]), () => { busy = false; cb = null; });
      return true;
    },
    close() { try { w.postMessage({ type: 'close' }); } catch { /* gone */ } setTimeout(() => w.terminate(), 200); },
  };
}

/** Detection on this thread (the fallback): same delegate timing as the worker. */
async function inlineDetector(video, force, noGpu) {
  let stamp = 0;
  const ts = () => (stamp = Math.max(stamp + 1, performance.now()));   // VIDEO mode wants strictly rising timestamps
  const { FilesetResolver, HandLandmarker } = await import(`${BASE}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  // 2, not 4: with fewer hands in view than numHands, MediaPipe re-runs palm detection on every frame (the expensive
  // model) looking for the missing ones; gestures.js ignores small hands, so someone behind you rarely matters
  const make = d => HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/twin/models/hand_landmarker.task', delegate: d },
    runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  const time = async (lm, beat = Infinity, budgetMs = 1500) => {
    const ms = [], t0 = performance.now();
    for (let i = 0; i < 33; i++) {
      const a = performance.now(); lm.detectForVideo(video, ts()); const d = performance.now() - a;
      if (i >= 3) ms.push(d);
      if (ms.length >= 1 && (performance.now() - t0 > budgetMs || (ms.length >= 4 && median(ms) > beat * 1.5))) break;
      await yieldFrame();
    }
    return median(ms);
  };
  let landmarker, delegate = force, bench = null;
  if (force === 'GPU' || force === 'CPU') landmarker = await make(force);
  else {
    let cpu = null, gpu = null; bench = {};
    try { cpu = await make('CPU'); bench.CPU = +(await time(cpu)).toFixed(1); } catch { try { cpu?.close(); } catch { /* never opened */ } cpu = null; }
    if (noGpu) bench.GPU = 'software';
    else try { gpu = await make('GPU'); bench.GPU = +(await time(gpu, bench.CPU ?? Infinity, Math.min(2000, Math.max(800, 40 * (bench.CPU || 20))))).toFixed(1); }
    catch { try { gpu?.close(); } catch { /* never opened */ } gpu = null; }
    if (!cpu && !gpu) throw new Error('hand model failed to load');
    const useGpu = !!gpu && (!cpu || bench.GPU < bench.CPU * 0.85);   // a tie goes to the CPU (the GPU also draws the 3D)
    landmarker = useGpu ? gpu : cpu; delegate = useGpu ? 'GPU' : 'CPU';
    try { (useGpu ? cpu : gpu)?.close(); } catch { /* already closed */ }
  }
  return {
    delegate, bench, where: 'page',
    detect(t, done) {
      let res; const a = performance.now();
      try { res = landmarker.detectForVideo(video, ts()); } catch { return false; }
      done(mirror(res.landmarks), performance.now() - a);
      return true;
    },
    close() { try { landmarker.close(); } catch { /* already closed */ } },
  };
}

/**
 * Opens the camera (asks permission), tracks up to two hands (the gestures keep the closest), and calls
 * onHands(hands, tMs, { aspect, lowLight, detectMs, mainMs, delegate, bench, where }) with landmarks mirrored like a
 * selfie view. Returns { video, stop }; the video element stays in this page (for the optional preview thumbnail).
 * The delegate is measured, not assumed: CPU and GPU each run up to ~30 frames at start and the faster one stays (a GPU
 * without hardware GL, e.g. SwiftShader on Linux, is far slower than the CPU and fights three.js for the same GPU).
 * ?handsDelegate=GPU|CPU skips the timing; ?handsWorker=0 keeps detection on the page.
 */
export async function startHands({ onHands }) {
  // camera first, so the permission prompt answers the click straight away; then the model (about 8 MB, local)
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' }, audio: false });
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  const q = new URLSearchParams(location.search), force = (q.get('handsDelegate') || '').toUpperCase();
  // a GPU without hardware GL (SwiftShader, llvmpipe) is far slower than the CPU: don't even time it
  const noGpu = !force && softwareGL();
  let det;
  try {
    await video.play();
    if (q.get('handsWorker') !== '0') { try { det = await workerDetector(video, force, noGpu); } catch (e) { console.warn('[twin] hand worker off:', e?.message || e); } }
    if (!det) det = await inlineDetector(video, force, noGpu);
  } catch (e) { for (const tr of stream.getTracks()) tr.stop(); video.srcObject = null; throw e; }
  const { delegate, bench, where } = det;
  const aspect = (video.videoWidth || 640) / (video.videoHeight || 480);
  // low light: the mean brightness of a 16 x 12 copy of the picture, once a second
  const probe = document.createElement('canvas'); probe.width = 16; probe.height = 12;
  const pg = probe.getContext('2d', { willReadFrequently: true });
  let running = true, lastVideoT = -1, raf = 0, vfc = 0, nextAt = 0, lowLight = false, lightAt = 0, mainMs = 0;
  let cost = Number.isFinite(bench?.[delegate]) ? bench[delegate] : 10;
  const detect = () => {
    const t = performance.now();
    if (t < nextAt || video.readyState < 2 || video.currentTime === lastVideoT) return;
    const a = performance.now();
    const started = det.detect(t, (lms, ms) => {
      if (!running) return;
      cost += 0.2 * (ms - cost);
      onHands(lms, t, { aspect, lowLight, detectMs: cost, mainMs, delegate, bench, where });
    });
    if (!started) return;
    lastVideoT = video.currentTime;
    mainMs += 0.2 * (performance.now() - a - mainMs);   // what detection costs this thread (the whole detection, inline)
    // 20-30 Hz: a slow detector backs off, the 3D keeps its frames (in a worker only the one-in-flight rule limits it)
    nextAt = t + Math.min(50, Math.max(33, (where === 'worker' ? 0.5 : 2.2) * cost)) - 4;
    if (t - lightAt > 1000) {
      lightAt = t;
      try {
        pg.drawImage(video, 0, 0, 16, 12);
        const d = pg.getImageData(0, 0, 16, 12).data; let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        lowLight = s / (d.length / 4) / 255 < 0.16;
      } catch { /* a frame that can't be read: keep the last answer */ }
    }
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
      video.srcObject = null; det.close();
      onHands([], performance.now(), { aspect, lowLight: false, delegate, bench, where });
    },
  };
}
