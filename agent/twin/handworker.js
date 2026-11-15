// Hand detection off the page's main thread (a classic Worker, so MediaPipe's loader can use importScripts). The page
// (twin/hands.js) posts camera frames as ImageBitmaps; this answers with landmarks. Same files, same model, nothing
// leaves the laptop. Messages in:  {type:'init', bitmap, force, noGpu}  {type:'frame', bitmap, ts}
//              messages out: {type:'ready', delegate, bench}  {type:'hands', landmarks, ms, ts}  {type:'error', message}
const BASE = '/vendor/mediapipe';
let landmarker = null, stamp = 0;
const ts = t => (stamp = Math.max(stamp + 1, t || 0));   // VIDEO mode wants strictly rising timestamps
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : Infinity; };

async function init(bitmap, force, noGpu) {
  const { FilesetResolver, HandLandmarker } = await import(`${BASE}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  // numHands 2: with fewer hands in view than numHands, MediaPipe re-runs palm detection on every frame
  const make = d => HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/twin/models/hand_landmarker.task', delegate: d },
    ...(d === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),   // a worker has no DOM canvas: the GPU delegate needs one
    runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  /** Median ms of one detection after 3 warm-up frames; stops early past budgetMs, or once clearly slower than `beat`. */
  const time = (lm, beat = Infinity, budgetMs = 1500) => {
    const ms = [], t0 = performance.now();
    for (let i = 0; i < 33; i++) {
      const a = performance.now(); lm.detectForVideo(bitmap, ts(performance.now())); const d = performance.now() - a;
      if (i >= 3) ms.push(d);
      if (ms.length >= 1 && (performance.now() - t0 > budgetMs || (ms.length >= 4 && median(ms) > beat * 1.5))) break;
    }
    return median(ms);
  };
  if (force === 'GPU' || force === 'CPU') { landmarker = await make(force); return { delegate: force, bench: null }; }
  let cpu = null, gpu = null; const bench = {};
  try { cpu = await make('CPU'); bench.CPU = +time(cpu).toFixed(1); } catch { try { cpu?.close(); } catch { /* never opened */ } cpu = null; }
  if (noGpu) bench.GPU = 'software';
  else try { gpu = await make('GPU'); bench.GPU = +time(gpu, bench.CPU ?? Infinity, Math.min(2000, Math.max(800, 40 * (bench.CPU || 20)))).toFixed(1); }
  catch { try { gpu?.close(); } catch { /* never opened */ } gpu = null; }
  if (!cpu && !gpu) throw new Error('hand model failed to load');
  const useGpu = !!gpu && (!cpu || bench.GPU < bench.CPU * 0.85);   // a tie goes to the CPU (the GPU also draws the 3D)
  landmarker = useGpu ? gpu : cpu;
  try { (useGpu ? cpu : gpu)?.close(); } catch { /* already closed */ }
  return { delegate: useGpu ? 'GPU' : 'CPU', bench };
}

self.onmessage = async e => {
  const m = e.data || {};
  if (m.type === 'init') {
    try { const r = await init(m.bitmap, m.force, m.noGpu); self.postMessage({ type: 'ready', ...r }); }
    catch (err) { self.postMessage({ type: 'error', message: String(err?.message || err) }); }
    finally { m.bitmap?.close?.(); }
  } else if (m.type === 'frame') {
    let landmarks = [], ms = 0;
    try {
      if (landmarker) {
        const a = performance.now();
        const res = landmarker.detectForVideo(m.bitmap, ts(m.ts));
        ms = performance.now() - a;
        landmarks = (res.landmarks || []).map(lm => lm.map(p => ({ x: p.x, y: p.y, z: p.z })));
      }
    } catch { /* a frame that fails: report no hands, the gestures bridge it */ }
    finally { m.bitmap?.close?.(); }
    self.postMessage({ type: 'hands', landmarks, ms, ts: m.ts });
  } else if (m.type === 'close') { try { landmarker?.close(); } catch { /* gone */ } landmarker = null; self.close(); }
};
