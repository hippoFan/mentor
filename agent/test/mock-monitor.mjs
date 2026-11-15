// Fake call for the laptop app (phone view + 3D twin), no API keys, LiveKit or phone needed:
//   node test/mock-monitor.mjs [photo.jpg] [--waiting] [--hold] [--port 8799]
// Serves the Ody app through the real live.mjs server on http://localhost:8799 (not 8790, which the live agent uses)
// and replays a realistic call: the photo as the caller's camera, Mentor's marks drawn by overlay.mjs, and
// heard / say / turn / step events. Loops (call, end, wait) unless --hold, which stays live after the last turn.
// --waiting never starts a call, for checking the waiting screen.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const portAt = args.indexOf('--port');
const PORT = portAt >= 0 ? Number(args[portAt + 1]) : 8799;
process.env.MENTOR_MONITOR_PORT = String(PORT);
const { createLiveServer: startLive } = await import('../live.mjs');   // never publish to the live hub
const { render, outJpeg, frameJpeg } = await import('../overlay.mjs');

const here = p => fileURLToPath(new URL(p, import.meta.url));
const photo = args.find(a => !a.startsWith('--') && (portAt < 0 || a !== args[portAt + 1]))
  || [here('../../../mentor-film/assets/uno-desk.jpg'),
      '/tmp/claude-1000/-home-plopee/c02e38dd-44ec-41ef-a7e2-9567a8304336/scratchpad/photos/uno-desk.jpg'].find(existsSync);
if (!photo) { console.error('no photo: pass one, e.g. node test/mock-monitor.mjs uno-desk.jpg'); process.exit(2); }

// The caller holds the phone upright over the board: a portrait crop of the right two thirds of the photo.
const img = await loadImage(await readFile(photo));
const CW = Math.round(img.height * 0.652), CH = img.height;
const X0 = Math.round(img.width * 0.4);
const cam = createCanvas(CW, CH), cg = cam.getContext('2d');
function camFrame(t) {
  const dx = Math.round(Math.sin(t / 900) * 10), dy = Math.round(Math.cos(t / 1300) * 8);   // a hand-held wobble
  cg.drawImage(img, X0 + dx, dy + 10, CW, CH - 20, 0, 0, CW, CH);
  const d = cg.getImageData(0, 0, CW, CH);
  return { data: new Uint8Array(d.data.buffer), width: CW, height: CH };
}

const live = await startLive();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let marks = [], caption = '', speakingUntil = 0, inCall = false, tick = 0;

// Streams like agent.mjs: the caller's view twice a second, Mentor's view once a second.
setInterval(async () => {
  if (!inCall) return;
  const f = camFrame(Date.now());
  render(f, marks, { caption, tick: tick++, speaking: Date.now() < speakingUntil });
  live.send({ type: 'frame', jpeg: (await outJpeg()).toString('base64') });
  if (tick % 2 === 0) {
    const j = await frameJpeg(f, 480);
    live.send({ type: 'input', jpeg: j.jpeg.toString('base64'), w: f.width, h: f.height });
  }
}, 500);

const say = (text, ms) => { live.send({ type: 'say', text, ...(ms ? { ms } : {}) }); speakingUntil = Date.now() + text.length * 55; };
const step = (text, done) => { caption = text; live.send({ type: 'step', text, ...(done ? { done: true } : {}) }); };
const turn = (ms, m, stepText, sayText, done = false) => {
  marks = m;
  live.send({ type: 'turn', brain: 'gemini', model: 'gemini-2.5-flash', ms, marks: m, step: stepText, done, board: { model: 'uno-r3' } });
  step(done ? 'Done. You made it home.' : stepText, done);
  say(sayText, ms);
};

const PIN13 = { x: 0.18, y: 0.174 }, GND = { x: 0.115, y: 0.174 }, LLED = { x: 0.156, y: 0.258 };
const CHIP = { x: 0.64, y: 0.665 }, ON = { x: 0.9, y: 0.35 };

async function call() {
  inCall = true; marks = []; caption = '';
  live.send({ type: 'call', state: 'live', since: Date.now() });
  live.send({ type: 'brain', brain: 'gemini' });
  await sleep(1200);
  step('Show me your project');
  say("Hi, I'm Mentor. Show me what you're building.");
  await sleep(4000);
  live.send({ type: 'heard', text: "Hey. It's an Arduino Uno, and I want to make an LED blink." });
  await sleep(2140);
  live.send({ type: 'part', model: 'uno-r3', label: 'Arduino UNO R3' });
  turn(2140, [{ label: 'Pin 13', ...PIN13, kind: 'circle', pin: '13' }, { label: 'GND', ...GND, kind: 'circle', pin: 'GND' }, { label: 'ATmega328P', ...CHIP, kind: 'circle' }],
    'Find pin 13 and the GND beside it',
    'Nice, an Uno. Your LED goes in pin 13, and its short leg into the GND right next to it.');
  await sleep(6500);
  live.send({ type: 'heard', text: 'Which leg is the long one again?' });
  await sleep(2870);
  turn(2870, [{ label: 'Long leg', ...PIN13, kind: 'arrow', pin: '13' }, { label: 'Short leg', ...GND, kind: 'arrow', pin: 'GND' }],
    'Long leg into 13, short leg into GND',
    'The long leg is positive. Push it into 13, and the short one into GND.');
  await sleep(6000);
  live.send({ type: 'heard', text: 'Okay.' });
  await sleep(2500);
  live.send({ type: 'heard', text: "It's in. What now?" });
  await sleep(4120);
  turn(4120, [{ label: 'L light', ...LLED, kind: 'wire', x2: PIN13.x, y2: PIN13.y }, { label: 'Power', ...ON, kind: 'circle' }],
    'Upload Blink from File, Examples, Basics',
    'Plug in the USB, open File, Examples, Basics, Blink, and press upload. Watch the L light, it shares pin 13.');
  await sleep(7000);
  live.send({ type: 'heard', text: "It's blinking!" });
  await sleep(1380);
  turn(1380, [{ label: 'Blinking', ...LLED, kind: 'circle' }], 'Upload Blink from File, Examples, Basics',
    "That's it. Your LED and the L light blink together. You made it home.", true);
}

console.log(`[mock] fake call on http://localhost:${PORT}  (photo: ${photo})`);
if (flag('--waiting')) { /* stay in the waiting state */ }
else if (flag('--hold')) { await sleep(1500); await call(); console.log('[mock] holding live'); }
else for (;;) {
  await sleep(1500); await call(); await sleep(12000);
  inCall = false; live.send({ type: 'call', state: 'ended' }); console.log('[mock] call ended, next in 8 s');
  await sleep(8000);
}
