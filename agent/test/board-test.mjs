// Board registration test (board.mjs + tracker.mjs + overlay.mjs). Offline except one optional brain call.
//   node test/board-test.mjs [photo.jpg]            (a) synthetic homography + 3D pin test, (b)-(c) debug renders from the
//                                                     cached brain answer, (d) handheld tracking sequence, perf
//   MENTOR_BRAIN=claude-code MENTOR_OWNER_TESTING=1 node test/board-test.mjs --brain   asks the brain once for the
//                                                     corners and caches the answer next to the photo
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { UNO, createBoard, refineCorners } from '../board.mjs';
import { render, snapshotPng, frameJpeg, WIDTH, HEIGHT } from '../overlay.mjs';
import { createMarkTracker } from '../tracker.mjs';

const args = process.argv.slice(2);
const PHOTO = args.find(a => !a.startsWith('--')) || '/tmp/claude-1000/-home-plopee/c02e38dd-44ec-41ef-a7e2-9567a8304336/scratchpad/photos/uno-desk.jpg';
const OUT = PHOTO.replace(/\.[a-z]+$/i, '');
const CACHE = `${OUT}.board-brain.json`;
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);

// ---------- (a) synthetic: known camera, known corners ----------
{
  const W = 720, H = 960, f = 0.8 * Math.max(W, H);
  // A camera looking down at the board, tilted 32 deg, board turned 20 deg, 170 mm away (a phone held over a desk).
  const rot = (ax, ang) => { const c = Math.cos(ang), s = Math.sin(ang);
    return ax === 'x' ? [[1, 0, 0], [0, c, -s], [0, s, c]] : [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
  const mm = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
  // board axes: u right, v up the screen (v = -camera y), z toward the camera (-camera z), tilted, then turned
  const R = mm(rot('x', 32 * Math.PI / 180), mm(rot('z', 20 * Math.PI / 180), [[1, 0, 0], [0, -1, 0], [0, 0, -1]]));
  const T = [-34, 22, 170];
  const truth = (u, v, z) => {
    const X = R[0][0] * u + R[0][1] * v + R[0][2] * z + T[0], Y = R[1][0] * u + R[1][1] * v + R[1][2] * z + T[1];
    const Z = R[2][0] * u + R[2][1] * v + R[2][2] * z + T[2];
    return [W / 2 + f * X / Z, H / 2 + f * Y / Z];
  };
  const corners = ['A', 'B', 'C', 'D'].map(k => truth(...UNO.corners[k], 0)).map(([x, y]) => [x / W, y / H]);
  const b = createBoard(corners, { w: W, h: H });
  if (!b) check('synthetic board accepted', false, 'createBoard returned null');
  else {
    const e0 = [], e8 = [];
    for (const [name, p] of Object.entries(UNO.pins)) {
      const [x, y] = b.norm(p.u, p.v, 0), [tx, ty] = truth(p.u, p.v, 0);
      e0.push(Math.hypot(x * W - tx, y * H - ty));
      const [x8, y8] = b.pinPoint(name), [tx8, ty8] = truth(p.u, p.v, UNO.headerTop);
      e8.push(Math.hypot(x8 * W - tx8, y8 * H - ty8));
    }
    check('homography, pins on the board plane', Math.max(...e0) < 1, `max ${Math.max(...e0).toFixed(3)} px over ${e0.length} pins`);
    check('pose, holes on top of the 8.5 mm headers', Math.max(...e8) < 1, `max ${Math.max(...e8).toFixed(3)} px`);

    // A rendered warped board: dark hole dots on a header strip on a PCB on a desk; find each dot's centroid in the image.
    const Hinv = b.Hinv, img = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ww = Hinv[6] * x + Hinv[7] * y + Hinv[8];
      const u = (Hinv[0] * x + Hinv[1] * y + Hinv[2]) / ww, v = (Hinv[3] * x + Hinv[4] * y + Hinv[5]) / ww;
      let c = 150;
      if (u >= 0 && u <= 66.04 && v >= 0 && v <= 53.34) {
        c = 90;
        const row = Math.abs(v - 50.8) < 1.27 || Math.abs(v - 2.54) < 1.27;
        if (row) c = 200;
        for (const p of Object.values(UNO.pins)) if ((u - p.u) ** 2 + (v - p.v) ** 2 < 0.5 ** 2) { c = 0; break; }
      }
      img[y * W + x] = c;
    }
    const ec = [];
    for (const p of Object.values(UNO.pins)) {
      const [px, py] = b.norm(p.u, p.v, 0).map((q, i) => q * (i ? H : W));
      let sx = 0, sy = 0, n = 0;
      const R = Math.ceil(1.15 * b.pxPerMm);   // less than half the 2.54 mm pitch: only this hole's dot
      for (let y = Math.floor(py - R); y <= py + R; y++) for (let x = Math.floor(px - R); x <= px + R; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (img[y * W + x] < 30) { sx += x; sy += y; n++; }
      }
      if (n) ec.push(Math.hypot(sx / n - px, sy / n - py));
    }
    check('warped synthetic image, hole centroids', ec.length === 31 && Math.max(...ec) < 1, `max ${Math.max(...ec).toFixed(3)} px, mean ${mean(ec).toFixed(3)} px over ${ec.length} holes`);
    const bad = createBoard([corners[0], corners[3], corners[2], corners[1]], { w: W, h: H });
    check('mirrored corner order rejected', bad === null, bad ? 'accepted' : 'rejected');
    const squash = createBoard([[0.1, 0.4], [0.9, 0.4], [0.9, 0.45], [0.1, 0.45]], { w: W, h: H });
    check('implausible aspect rejected', squash === null, squash ? 'accepted' : 'rejected');
  }
}

// ---------- the photo + the brain's corners ----------
const img = await loadImage(await readFile(PHOTO));
const FW = 1200, FH = Math.round(img.height * FW / img.width);
const fc = createCanvas(FW, FH); fc.getContext('2d').drawImage(img, 0, 0, FW, FH);
const fd = fc.getContext('2d').getImageData(0, 0, FW, FH);
const frame = { data: new Uint8Array(fd.data.buffer), width: FW, height: FH };

if (args.includes('--brain')) {
  const { createBrain } = await import('../brain.mjs');
  const brain = await createBrain({ task: 'Blink an LED on an Arduino UNO' });
  console.log(`brain: ${brain.provider}`);
  const reply = await brain.turn('I want to run a jumper wire from pin 13 to GND. Show me exactly where it goes.', await frameJpeg(frame));
  await brain.close?.();
  console.log(JSON.stringify({ board: reply.board, marks: reply.marks, say: reply.say }, null, 1));
  await writeFile(CACHE, JSON.stringify({ photo: PHOTO, board: reply.board, marks: reply.marks, say: reply.say }, null, 1));
}
if (!existsSync(CACHE)) {
  console.log(`no cached brain answer (${CACHE}); run once with --brain for the photo renders`);
} else {
  const cached = JSON.parse(await readFile(CACHE, 'utf8'));
  const raw = createBoard(cached.board.corners, { w: FW, h: FH });
  check('brain corners give a plausible board', Boolean(raw), `${cached.board.model} ${JSON.stringify(cached.board.corners.map(c => c.map(v => +v.toFixed(3))))}`);
  const t0 = performance.now();
  const ref = refineCorners(frame, cached.board.corners);
  console.log(`snap to holes: score ${ref.score?.toFixed(3)}, gain ${ref.gain.toFixed(3)}, corners moved up to ${ref.moved.toFixed(2)} mm, ${(performance.now() - t0).toFixed(0)} ms`);
  const board = createBoard(ref.corners, { w: FW, h: FH });

  // (b) every header hole as a dot + label, plus the PCB outline from the corners
  if (board) {
    const c = createCanvas(FW, FH), g = c.getContext('2d');
    g.drawImage(fc, 0, 0);
    g.strokeStyle = '#FFC845'; g.lineWidth = 2;
    g.beginPath(); board.corners().forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, x * FW, y * FH)); g.closePath(); g.stroke();
    g.font = '600 13px Inter, sans-serif';
    board.corners().forEach(([x, y], i) => { g.fillStyle = '#FFC845'; g.fillText('ABCD'[i], x * FW + 6, y * FH + 16); });
    for (const [name, p] of Object.entries(UNO.pins)) {
      const [bx, by] = board.norm(p.u, p.v, 0), [x, y] = board.pinPoint(name);
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(bx * FW, by * FH); g.lineTo(x * FW, y * FH); g.stroke();   // header base -> hole on top
      g.fillStyle = '#FF2D55'; g.beginPath(); g.arc(x * FW, y * FH, 3, 0, Math.PI * 2); g.fill();
      g.save(); g.translate(x * FW, y * FH + (p.row === 'digital' ? -10 : 18)); g.rotate(-Math.PI / 2.6);
      g.fillStyle = '#FFFFFF'; g.fillText(name.replace(/\.\d$/, ''), 0, 0); g.restore();
    }
    await writeFile(`${OUT}.pins.png`, await c.encode('png'));
    console.log(`wrote ${OUT}.pins.png`);
  }

  // (c) wire 13 -> GND, and a holographic wire 13 -> a stand-in breadboard hole on the desk, through the real pipeline
  const scene = async (name, marks) => {
    const t = createMarkTracker();
    t.seed(frame, marks, cached.board);
    const m = t.update(frame);
    render(frame, m, { caption: marks[0].label, tick: 12 });
    await writeFile(`${OUT}.${name}.png`, await snapshotPng());
    console.log(`wrote ${OUT}.${name}.png  (board ${t.board ? 'registered' : 'NOT registered'})`);
    const ms = [];
    for (let i = 0; i < 40; i++) { const t0 = performance.now(); render(frame, t.update(frame), { caption: 'x', tick: i }); ms.push(performance.now() - t0); }
    return mean(ms.slice(10));
  };
  const msWire = await scene('wire', [{ kind: 'wire', label: 'Pin 13 to GND', x: 0.5, y: 0.1, x2: 0.48, y2: 0.1, pin: '13', pin2: 'GND' }]);
  const msHolo = await scene('holo', [{ kind: 'wire', label: 'Pin 13 to breadboard', x: 0.5, y: 0.1, x2: 0.975, y2: 0.62, pin: '13', pin2: '' }]);
  const msBusy = await scene('busy', [
    { kind: 'wire', label: '5V to + rail', x: 0.5, y: 0.9, x2: 0.975, y2: 0.75, pin: '5V', pin2: '' },
    { kind: 'wire', label: 'GND to - rail', x: 0.5, y: 0.9, x2: 0.975, y2: 0.85, pin: 'GND.2', pin2: '' },
    { kind: 'wire', label: 'Pin 13', x: 0.5, y: 0.1, x2: 0.975, y2: 0.55, pin: '13', pin2: '' },
    { kind: 'circle', label: 'USB port', x: 0.1, y: 0.28, x2: -1, y2: -1, pin: '', pin2: '' },
    { kind: 'circle', label: 'L LED', x: 0.47, y: 0.26, x2: -1, y2: -1, pin: '', pin2: '' },
    { kind: 'circle', label: 'Power jack', x: 0.15, y: 0.83, x2: -1, y2: -1, pin: '', pin2: '' },
  ]);
  // the overlay without the caller frame cost: one bare-frame render to subtract
  const bare = []; for (let i = 0; i < 30; i++) { const t0 = performance.now(); render(frame, [], { caption: 'x', tick: i }); bare.push(performance.now() - t0); }
  console.log(`render ${WIDTH}x${HEIGHT}: frame only ${mean(bare.slice(10)).toFixed(2)} ms, with 3D wire ${msWire.toFixed(2)} ms (13->GND), ${msHolo.toFixed(2)} ms (13->desk), ${msBusy.toFixed(2)} ms (3 wires + 3 rings)`);
  const msRender = Math.max(msWire, msHolo, msBusy);

  // (d) synthetic handheld clip: the pins must stay on their holes as the "phone" moves
  if (board) {
    const W = 480, H = 850, FPS = 15, SECONDS = 6, base = 520 / FW;
    const motion = t => ({
      tx: 60 * (0.6 * Math.sin(1.3 * t) + 0.4 * Math.sin(2.9 * t + 1)),
      ty: 60 * (0.55 * Math.sin(1.1 * t + 2) + 0.45 * Math.sin(3.3 * t)),
      s: 1 + 0.1 * Math.sin(0.9 * t + 0.5),
      r: (4 * Math.PI / 180) * Math.sin(1.7 * t + 0.3),
      blur: 0.6 + 0.6 * Math.abs(Math.sin(2.1 * t)),
    });
    const project = (m, px, py) => {
      const x0 = (px - FW / 2) * base, y0 = (py - FH / 2) * base, c = Math.cos(m.r), s = Math.sin(m.r);
      return [W / 2 + m.tx + m.s * (c * x0 - s * y0), H / 2 + m.ty + m.s * (s * x0 + c * y0)];
    };
    const cv = createCanvas(W, H), g = cv.getContext('2d');
    const frameAt = m => {
      g.setTransform(1, 0, 0, 1, 0, 0); g.filter = 'none'; g.fillStyle = '#202020'; g.fillRect(0, 0, W, H);
      g.filter = `blur(${m.blur.toFixed(2)}px)`;
      g.translate(W / 2 + m.tx, H / 2 + m.ty); g.rotate(m.r); g.scale(m.s * base, m.s * base);
      g.drawImage(fc, -FW / 2, -FH / 2);
      const d = g.getImageData(0, 0, W, H);
      return { data: new Uint8Array(d.data.buffer), width: W, height: H };
    };
    const n = FPS * SECONDS, frames = [], poses = [];
    for (let i = 0; i < n; i++) { poses.push(motion(i / FPS)); frames.push(frameAt(poses[i])); }
    const corners0 = board.corners().map(([x, y]) => project(poses[0], x * FW, y * FH)).map(([x, y]) => [x / W, y / H]);
    const pins = Object.keys(UNO.pins);
    // a frame-0 point (normalised) carried to frame i by the known hand motion
    const moved = ([nx, ny], i) => {
      const m = poses[0], c = Math.cos(-m.r), sn = Math.sin(-m.r), x = (nx * W - W / 2 - m.tx) / m.s, y = (ny * H - H / 2 - m.ty) / m.s;
      return project(poses[i], (c * x - sn * y) / base + FW / 2, (sn * x + c * y) / base + FH / 2);
    };
    const run = async (label, startAt) => {
      const t = createMarkTracker();
      t.seed(frames[0], [{ kind: 'wire', label: 'Pin 13 to GND', x: 0.5, y: 0.3, x2: 0.4, y2: 0.3, pin: '13', pin2: 'GND' }],
        { model: 'uno-r3', corners: corners0 }, 0);
      const seedBoard = t.board;   // registration is judged against the board as seeded (seed accuracy is checked in (b))
      const errs = [], herrs = [], ms = []; let lost = 0;
      for (let i = startAt; i < n; i++) {
        const t0 = performance.now();
        const marks = t.update(frames[i], i * 1000 / FPS);
        ms.push(performance.now() - t0);
        const b = t.board;
        if (!b || !marks[0]?.geo) { lost++; continue; }
        // where each pin is on the board, vs where the seeded board moved by the known hand motion puts it
        for (const name of pins) {
          const pin = UNO.pins[name];
          const [x, y] = b.norm(pin.u, pin.v, 0), [gx, gy] = moved(seedBoard.norm(pin.u, pin.v, 0), i);
          if (gx >= 0 && gy >= 0 && gx < W && gy < H) errs.push(Math.hypot(x * W - gx, y * H - gy));
          const [hx, hy] = b.pinPoint(name), [ghx, ghy] = moved(seedBoard.pinPoint(name), i);
          if (ghx >= 0 && ghy >= 0 && ghx < W && ghy < H) herrs.push(Math.hypot(hx * W - ghx, hy * H - ghy));
        }
      }
      const e = mean(errs), mx = Math.max(...errs), msm = mean(ms);
      console.log(`${label}: pin error mean ${e.toFixed(2)} px, max ${mx.toFixed(2)} px over ${errs.length} pin-frames (hole tops ${mean(herrs).toFixed(2)} px), board lost ${lost}/${n - startAt} frames, ${msm.toFixed(2)} ms/frame`);
      return { e, mx, lost, msm };
    };
    await run('warmup         ', 1);
    const a = await run('every frame    ', 1);
    const b2 = await run('2 s brain delay', 30);
    check('frame budget (worst render + tracker)', msRender + a.msm < 10, `${msRender.toFixed(2)} + ${a.msm.toFixed(2)} = ${(msRender + a.msm).toFixed(2)} ms (budget 10)`);
    check('pins stay registered (handheld)', a.e < 4 && b2.e < 4 && a.lost === 0 && b2.lost === 0, `mean ${a.e.toFixed(2)} / ${b2.e.toFixed(2)} px (< 4), tracker ${a.msm.toFixed(2)} ms/frame`);
  }
}

const pass = results.every(Boolean);
console.log(pass ? 'PASS' : 'FAIL');
process.exitCode = pass ? 0 : 1;
