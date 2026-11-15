// Builds the premade backup demo (demo-data/backup-call.jsonl) from a real Ody call saved in runs/<call>/.
//   node build-backup.mjs [runs/<call-dir>] [--out demo-data/backup-call.jsonl]
// The session is a hand-picked cut of that call: only object-related exchanges, only frames that were checked by eye
// (no faces, no people, no screens, no FaceTime UI). Every frame loses its top 3 % (a sliver of the FaceTime status pill)
// and is downscaled. The wiring part ("add a distance sensor") is NOT from that call: it is circuit.mjs's own template
// output for the same board, marked synth:true on each line, so the replay is honest about what was real.
// Format (shared with record.mjs and replay.mjs): line 1 {"meta": {...}}, then {"t": <ms from start>, "ev": <hub event>}.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createProject, handleUtterance, circuitEvent, markDone, nextStep } from './circuit.mjs';
import { researchInterior } from './research.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));
export const DEFAULT_RUN = here('../runs/2026-11-15-04-39-65b46f583e64/');
export const DEFAULT_OUT = here('./demo-data/backup-call.jsonl');
const GREETING = "Hi, I'm Ody, an AI guide named for Homer's Odyssey. Show me what you're building, and tell me where you want to get to.";
const TOP_CUT = 0.03;   // the FaceTime status pill sits in the top ~2 % of every captured frame

// Frames used, by segment (3 s apart in the original call). Each one was looked at; why it is in is in FRAME_NOTES.
export const SEGMENTS = [
  { name: 'pen', frames: range(4, 12), start: 2000 },
  { name: 'phone', frames: range(46, 58), start: 29000 },
  { name: 'board', frames: range(69, 76), start: 68000 },
];
export const FRAME_NOTES = {
  used: {
    '004-012': 'red pen on a grey fabric chair; nothing else in view',
    '046-058': 'back of a phone in a plain black case on a wooden table (no screen, no text); a beige fabric edge at the bottom',
    '069-076': 'Arduino UNO R4 WiFi on the wooden table',
  },
  excluded: {
    '001-003': 'FaceTime call UI with the caller\'s number and call controls',
    '013-022': 'more pen (not needed; fine)',
    '023': 'camera moving over a chair (nothing to see)',
    '024-044': 'phone front: dark screen with reflections, boxes with labels at the top',
    '045': 'transition (phone being flipped)',
    '059-066': 'more phone back (not needed; fine)',
    '067': 'a person\'s legs and shoes',
    '077-078': 'a hand holding the paddle; blurry view of a person',
    '079-094': 'table tennis paddle (fine; cut for length)',
    '095-097': 'camera off (black)',
  },
};
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }
const pad = n => String(n).padStart(3, '0');

/** Crops the top strip off and downscales. @returns {Promise<{b64: string, w: number, h: number}>} */
export async function shrink(buf, width, quality = 70, topCut = TOP_CUT) {
  const img = await loadImage(buf);
  const y0 = Math.round(img.height * topCut), sh = img.height - y0;
  const s = Math.min(1, width / img.width), w = Math.round(img.width * s), h = Math.round(sh * s);
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(img, 0, y0, img.width, sh, 0, 0, w, h);
  return { b64: (await c.encode('jpeg', quality)).toString('base64'), w, h };
}

/** The crop rect scan.mjs's cropJpeg used for this bbox (3 % margin), so the twin maps the photo the same way. */
const cropRect = ([x0, y0, x1, y1]) => {
  const px = (x1 - x0) * 0.03, py = (y1 - y0) * 0.03;
  return [Math.max(0, x0 - px), Math.max(0, y0 - py), Math.min(1, x1 + px), Math.min(1, y1 + py)];
};

/** @returns {Promise<{meta: object, lines: {t: number, ev: object, synth?: boolean}[]}>} */
export async function buildSession(runDir = DEFAULT_RUN) {
  const run = p => resolve(runDir, p);
  const lines = [];
  const at = (t, ev, synth = false) => lines.push({ t, ev, ...(synth ? { synth: true } : {}) });
  const scan = async (n, id) => {
    const spec = JSON.parse(await readFile(run(`scan-${String(n).padStart(2, '0')}.json`), 'utf8'));
    const photo = await shrink(await readFile(run(`scan-${String(n).padStart(2, '0')}.jpg`)), 640, 80, 0);
    return { spec, ev: { type: 'scan', id, at: 0, spec, photo: photo.b64, crop: cropRect(spec.bbox), ms: spec.ms, model: spec.model || '' } };
  };

  // greeting (the agent's fixed first line, spoken in this call)
  at(0, { type: 'call', state: 'live', since: 0 });
  at(50, { type: 'brain', brain: 'claude-code' });
  at(800, { type: 'step', text: 'Show me your project' });
  at(900, { type: 'say', text: GREETING });

  // the caller's camera: what Ody saw (input) and what the caller's phone showed (frame), every 3 s
  for (const seg of SEGMENTS) {
    for (const [i, n] of seg.frames.entries()) {
      const t = seg.start + i * 3000;
      const inp = await shrink(await readFile(run(`frames/${pad(n)}-in.jpg`)), 480, 74);
      const out = await shrink(await readFile(run(`frames/${pad(n)}-out.jpg`)), 540, 72);
      at(t, { type: 'input', jpeg: inp.b64, w: inp.w, h: inp.h, src: pad(n) });
      at(t + 40, { type: 'frame', jpeg: out.b64, src: pad(n) });
    }
  }

  // 1. "Scan this" -> the pen (the caller's words trimmed to the request; Ody's lines verbatim)
  at(9000, { type: 'heard', text: 'Scan this.' });
  at(9300, { type: 'say', text: 'Scanning, hold it steady.' });
  const pen = await scan(1, 1);
  at(15000, pen.ev);
  at(15100, { type: 'say', text: "Got it, a red retractable pen. It's on your laptop." });

  // 2. the back of the phone, then its researched interior (from runs/research-cache, made from this scan)
  at(33000, { type: 'heard', text: 'This is the back of the phone. Could you scan this as well?' });
  at(33300, { type: 'say', text: 'Scanning, hold it steady.' });
  const phone = await scan(3, 2);
  at(40000, phone.ev);
  at(40100, { type: 'say', text: "Got it, a phone in black magsafe case. It's on your laptop." });
  const interior = await researchInterior(null, phone.spec).catch(() => null);
  if (interior) at(52000, { type: 'interior', id: 2, interior });

  // 3. the Arduino: scanned and recognised as a library board
  at(72000, { type: 'heard', text: 'Could you scan this?' });
  at(72300, { type: 'say', text: 'Scanning, hold it steady.' });
  const uno = await scan(4, 3);
  at(79000, uno.ev);
  at(79050, { type: 'part', model: 'uno-r4-wifi', label: 'Arduino UNO R4 WiFi' });
  at(79100, { type: 'say', text: "Got it, your Arduino UNO R4 WiFi. It's on your laptop." });

  // 4. voice circuit build (synthesized: circuit.mjs templates, no brain), as agent.mjs's circuitTurn sends it
  let circuit = createProject({ board: 'arduino-uno' });
  at(93000, { type: 'heard', text: 'Ody, add a distance sensor.' }, true);
  const r = await handleUtterance(null, circuit, 'add a distance sensor');
  circuit = r.state;
  let n = nextStep(circuit);
  let sayText = [r.say, r.changed && n ? `First: ${n.say}` : ''].filter(Boolean).join(' ');
  at(93600, circuitEvent(circuit, { ...r, say: sayText }), true);
  at(93700, { type: 'step', text: n.say }, true);
  at(93800, { type: 'say', text: sayText }, true);
  for (const t of [110000, 121000, 132000]) {
    at(t, { type: 'heard', text: 'Done.' }, true);
    circuit = markDone(circuit); n = nextStep(circuit);
    sayText = n ? n.say : 'That was the last wire. Your circuit is complete.';
    at(t + 400, circuitEvent(circuit, { say: sayText }), true);
    if (n) at(t + 500, { type: 'step', text: n.say }, true);
    at(t + 600, { type: 'say', text: sayText }, true);
  }
  at(146000, { type: 'call', state: 'ended' });
  lines.sort((a, b) => a.t - b.t);

  const meta = {
    kind: 'ody-session', version: 1, label: 'Replay of a real Ody call',
    source: `runs/${runDir.replace(/\/$/, '').split('/').pop()}`, built: new Date().toISOString(), durationMs: 146000,
    note: 'Camera frames, scans and Ody\'s lines are from the real call (caller lines trimmed to the request). Lines marked synth:true (the distance-sensor build) are circuit.mjs template output on the same board, not from that call. The interior comes from the research cache built from this scan.',
    frames: FRAME_NOTES,
  };
  return { meta, lines };
}

export async function writeSession(out, { meta, lines }) {
  await mkdir(dirname(out), { recursive: true });
  const body = [JSON.stringify({ meta }), ...lines.map(l => JSON.stringify(l))].join('\n') + '\n';
  await writeFile(out, body);
  return body.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const out = resolve(oi >= 0 ? args[oi + 1] : DEFAULT_OUT);
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out') || DEFAULT_RUN;
  const s = await buildSession(resolve(dir) + '/');
  const bytes = await writeSession(out, s);
  console.log(`[backup] ${s.lines.length} events, ${(s.meta.durationMs / 1000).toFixed(0)} s, ${(bytes / 1e6).toFixed(1)} MB -> ${out}`);
}
