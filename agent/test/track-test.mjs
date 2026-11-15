// Offline tracker test: a synthetic 6 s, 15 fps "handheld" clip made from one photo (shift, zoom, tilt, blur), with
// known ground truth for two points. Reports tracking error (px) and time per frame. No network.
//   node test/track-test.mjs [photo.jpg]
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createTracker } from '../tracker.mjs';

const PHOTO = process.argv[2] || '/tmp/claude-1000/-home-plopee/c02e38dd-44ec-41ef-a7e2-9567a8304336/scratchpad/photos/uno-desk.jpg';
const W = 480, H = 850, FPS = 15, SECONDS = 6;
const SEEDS = [{ name: 'USB jack', u: 0.164, v: 0.303 }, { name: 'L LED', u: 0.470, v: 0.266 }];

const img = await loadImage(PHOTO);
const base = 900 / img.width;   // photo drawn ~900 px wide: a phone held close to the board, both points in view
const mu = (SEEDS[0].u + SEEDS[1].u) / 2, mv = (SEEDS[0].v + SEEDS[1].v) / 2;

// Smooth, non-periodic-looking hand motion: sums of sines. t in seconds.
const motion = t => ({
  tx: 60 * (0.6 * Math.sin(1.3 * t) + 0.4 * Math.sin(2.9 * t + 1)),
  ty: 60 * (0.55 * Math.sin(1.1 * t + 2) + 0.45 * Math.sin(3.3 * t)),
  s: 1 + 0.1 * Math.sin(0.9 * t + 0.5),
  r: (4 * Math.PI / 180) * Math.sin(1.7 * t + 0.3),
  blur: 0.6 + 0.6 * Math.abs(Math.sin(2.1 * t)),
});
// photo px -> frame px for a given pose (rotate+scale about the frame centre, then shift)
const project = (m, px, py) => {
  const x0 = (px - mu * img.width) * base, y0 = (py - mv * img.height) * base;
  const c = Math.cos(m.r), s = Math.sin(m.r);
  return [W / 2 + m.tx + m.s * (c * x0 - s * y0), H / 2 + m.ty + m.s * (s * x0 + c * y0)];
};

const canvas = createCanvas(W, H), g = canvas.getContext('2d');
function frameAt(m) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.filter = 'none';
  g.fillStyle = '#202020'; g.fillRect(0, 0, W, H);
  g.filter = `blur(${m.blur.toFixed(2)}px)`;
  g.translate(W / 2 + m.tx, H / 2 + m.ty); g.rotate(m.r); g.scale(m.s * base, m.s * base);
  g.drawImage(img, -mu * img.width, -mv * img.height);
  const d = g.getImageData(0, 0, W, H);
  return { data: new Uint8Array(d.data.buffer), width: W, height: H };
}

const frames = [], truth = [];
for (let i = 0; i < FPS * SECONDS; i++) {
  const m = motion(i / FPS);
  frames.push(frameAt(m));
  truth.push(SEEDS.map(p => project(m, p.u * img.width, p.v * img.height)));
}

function run(label, startAt) {
  // startAt: frames between the seed frame and the first update (the brain's thinking time: the tracker must catch up)
  const t = createTracker();
  t.reset(frames[0], truth[0].map(([x, y]) => ({ x: x / W, y: y / H })));
  const errs = [], ms = [];
  let hidden = 0;
  for (let i = startAt; i < frames.length; i++) {
    const t0 = performance.now();
    const pts = t.update(frames[i], i * 1000 / FPS);
    ms.push(performance.now() - t0);
    pts.forEach((p, k) => {
      const [gx, gy] = truth[i][k];
      const inView = gx >= 0 && gy >= 0 && gx < W && gy < H;
      if (!p.visible) { hidden++; return; }
      if (inView) errs.push(Math.hypot(p.x * W - gx, p.y * H - gy));
    });
  }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length, max = Math.max(...errs);
  const msMean = ms.reduce((a, b) => a + b, 0) / ms.length;
  ms.sort((a, b) => a - b);
  console.log(`${label}: mean ${mean.toFixed(2)} px, max ${max.toFixed(2)} px, hidden ${hidden}/${(frames.length - startAt) * SEEDS.length},`
    + ` ${msMean.toFixed(2)} ms/frame (p95 ${ms[Math.floor(ms.length * 0.95)].toFixed(2)})`);
  return { mean, max, msMean };
}

// warm up the JIT once, then measure
run('warmup', 1);
const a = run('every frame       ', 1);
const b = run('2 s brain delay   ', 30);
// 5 points (the task budget): time only
{
  const t = createTracker();
  t.reset(frames[0], [...truth[0], [240, 425], [200, 500], [300, 350]].map(([x, y]) => ({ x: x / W, y: y / H })));
  const t0 = performance.now();
  for (let i = 1; i < frames.length; i++) t.update(frames[i], i * 1000 / FPS);
  console.log(`5 points: ${((performance.now() - t0) / (frames.length - 1)).toFixed(2)} ms/frame`);
}
const pass = a.mean < 6 && a.max < 15 && b.mean < 6 && b.max < 15;
console.log(pass ? 'PASS' : 'FAIL');
process.exitCode = pass ? 0 : 1;
