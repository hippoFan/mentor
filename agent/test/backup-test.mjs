// Unit tests for the judging-day safety net (no network, no hub): the backup session build, the recorder's state
// machine, replay scheduling, and the watchdog's log parsers + arm logic with simulated Chert/agent logs.
//   node test/backup-test.mjs
import { strict as assert } from 'node:assert';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSession, SEGMENTS, FRAME_NOTES, DEFAULT_OUT } from '../build-backup.mjs';
import { createRecorder } from '../record.mjs';
import { schedule, lastCallState, loadSession, LABEL, SIM_LABEL, SIM_STEP } from '../replay.mjs';
import { createArm, parseChert, parseAgent } from '../watchdog.mjs';

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { const d = await fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

// ---------- the backup session ----------
const { meta, lines } = await buildSession();
const types = t => lines.filter(l => l.ev.type === t);
await test('session: starts live, ends ended, 2-3 minutes', () => {
  assert.equal(lines[0].ev.type, 'call'); assert.equal(lines[0].ev.state, 'live');
  const last = lines.at(-1); assert.equal(last.ev.type, 'call'); assert.equal(last.ev.state, 'ended');
  assert.ok(last.t >= 120_000 && last.t <= 180_000, `${last.t} ms`);
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].t >= lines[i - 1].t, 'sorted');
  return `${(last.t / 1000).toFixed(0)} s, ${lines.length} events`;
});
await test('session: greeting, scans with photos, interior, part, circuit, steps', () => {
  assert.match(types('say')[0].ev.text, /^Hi, I'm Ody/);
  const scans = types('scan');
  assert.equal(scans.length, 3);
  for (const s of scans) { assert.ok(s.ev.photo.length > 5000, 'photo'); assert.equal(s.ev.crop.length, 4); assert.ok(s.ev.spec.parts.length > 0); }
  assert.deepEqual(scans.map(s => s.ev.spec.name), ['Red retractable pen', 'Phone in black MagSafe case', 'Arduino UNO R4 WiFi']);
  assert.equal(types('interior').length, 1, 'interior from the research cache');
  assert.equal(types('part')[0].ev.model, 'uno-r4-wifi');
  const circ = types('circuit'); assert.ok(circ.length >= 3);
  assert.ok(circ[0].ev.state.components.some(c => c.part === 'hc-sr04'), 'distance sensor added');
  assert.ok(types('step').length >= 4);
  return `${circ.length} circuit events`;
});
await test('session: only the checked frames, input + frame each, sane sizes', () => {
  const used = new Set(SEGMENTS.flatMap(s => s.frames).map(n => String(n).padStart(3, '0')));
  const inp = types('input'), frm = types('frame');
  assert.equal(inp.length, used.size); assert.equal(frm.length, used.size);
  for (const l of [...inp, ...frm]) assert.ok(used.has(l.ev.src), `frame ${l.ev.src} not in the checked list`);
  for (const bad of ['001', '002', '003', '067', '077', '078', '095', '096', '097']) assert.ok(!used.has(bad), `excluded frame ${bad} used`);
  for (const l of inp) { assert.ok(l.ev.w > 0 && l.ev.h > 0); assert.ok(l.ev.jpeg.length < 200_000); }
  assert.ok(Object.keys(FRAME_NOTES.excluded).length >= 8);
  return `${used.size} frames`;
});
await test('session: no side chatter or personal info in the lines', () => {
  const text = lines.filter(l => l.ev.type === 'heard' || l.ev.type === 'say').map(l => l.ev.text).join(' | ');
  assert.doesNotMatch(text, /sponsor|snack|discord|notion|dev ?post|points|recording|contest|\+?1? ?\(?\d{3}\)? ?\d{3}-\d{4}/i);
  for (const l of types('heard')) assert.ok(l.ev.text.length < 80, `long caller line: ${l.ev.text}`);
  return `${types('heard').length} caller lines`;
});
await test('session: the synthesized part is labelled', () => {
  const synth = lines.filter(l => l.synth);
  assert.ok(synth.length > 0);
  for (const l of synth) assert.ok(['heard', 'say', 'step', 'circuit'].includes(l.ev.type), l.ev.type);
  assert.ok(lines.filter(l => l.ev.type === 'circuit').every(l => l.synth));
  assert.match(meta.note, /synth/);
});
await test('session file: built, < 15 MB, loads', async () => {
  const size = statSync(DEFAULT_OUT).size;
  assert.ok(size < 15e6, `${size} bytes`);
  const s = await loadSession(DEFAULT_OUT);
  assert.equal(s.meta.label, 'Replay of a real Ody call');
  assert.ok(s.lines.length > 50);
  return `${(size / 1e6).toFixed(1)} MB`;
});

// ---------- recorder ----------
await test('recorder: one file per call, video capped, replays skipped', () => {
  let n = 0;
  const r = createRecorder({ fps: 1, name: () => `s${++n}.jsonl` });
  assert.equal(r.push({ type: 'hello', call: null }, 0), null);
  assert.equal(r.push({ type: 'say', text: 'x' }, 10), null, 'nothing before a call');
  const first = r.push({ type: 'call', state: 'live', since: 5 }, 100);
  assert.equal(first.file, 's1.jsonl'); assert.ok(JSON.parse(first.lines[0]).meta);
  let kept = 0;
  for (let t = 100; t < 3100; t += 100) if (r.push({ type: 'input', jpeg: 'AAAA', w: 1, h: 1 }, t)) kept++;
  assert.ok(kept >= 3 && kept <= 4, `kept ${kept} of 30 in 3 s`);
  assert.equal(r.push({ type: 'frame', jpeg: 'A'.repeat(700_000) }, 5000), null, 'huge frame dropped');
  const h = r.push({ type: 'heard', text: 'hi' }, 1100); assert.equal(JSON.parse(h.lines[0]).t, 1000);
  const end = r.push({ type: 'call', state: 'ended' }, 9000); assert.equal(end.file, 's1.jsonl');
  assert.equal(r.push({ type: 'say', text: 'after' }, 9100), null);
  assert.equal(r.push({ type: 'call', state: 'live', replay: true }, 10000), null, 'replay not recorded');
  assert.equal(r.push({ type: 'say', text: 'replayed' }, 10100), null);
  r.push({ type: 'call', state: 'ended', replay: true }, 11000);
  assert.equal(r.push({ type: 'call', state: 'live', since: 9 }, 12000).file, 's2.jsonl');
  const mid = createRecorder({ name: () => 'm.jsonl' }).push({ type: 'hello', call: { type: 'call', state: 'live', since: 1 } }, 0);
  assert.equal(mid.file, 'm.jsonl', 'joins a call in progress');
});

// ---------- replay schedule ----------
await test('replay: replay call first, timing, speed, from', () => {
  const ls = [{ t: 0, ev: { type: 'call', state: 'live', since: 1 } }, { t: 800, ev: { type: 'step', text: 'Show me your project' } },
    { t: 1000, ev: { type: 'say', text: 'a' } }, { t: 2000, ev: { type: 'input', jpeg: 'A' } }, { t: 3000, ev: { type: 'input', jpeg: 'B' } },
    { t: 4000, ev: { type: 'scan', id: 1, at: 0 } }, { t: 6000, ev: { type: 'call', state: 'ended' } }];
  const p = schedule(ls, { now: 1000 });
  assert.deepEqual(p[0].ev, { type: 'call', state: 'live', since: 1000, replay: true, label: LABEL });
  assert.deepEqual(p[1].ev, { type: 'step', text: LABEL });
  assert.ok(!p.some(x => x.ev.text === 'Show me your project'), 'greeting caption dropped so the replay line stays');
  assert.equal(p.filter(x => x.ev.type === 'call').length, 2);
  assert.equal(p.at(-1).at, 6000); assert.equal(p.at(-1).ev.replay, true);
  assert.equal(p.find(x => x.ev.type === 'scan').ev.at, 5000);
  const fast = schedule(ls, { speed: 2, now: 0 }); assert.equal(fast.at(-1).at, 3000);
  const cut = schedule(ls, { from: 3500, now: 0 });
  const zero = cut.filter(x => x.at === 0).map(x => x.ev.type);
  assert.deepEqual(zero, ['call', 'step', 'say', 'input'], 'state before the cut at once, video only the latest');
  assert.equal(cut.find(x => x.ev.type === 'input').ev.jpeg, 'B');
  assert.equal(cut.find(x => x.ev.type === 'scan').at, 500);
  const open = schedule(ls.slice(0, 3), { now: 0 }); assert.equal(open.at(-1).ev.state, 'ended', 'a cut-off recording still ends');
});
await test('replay: the simulated part is announced before its first line, same since', async () => {
  const { lines: ls } = await loadSession(DEFAULT_OUT);
  const p = schedule(ls, { now: 7 });
  const i = p.findIndex(x => x.ev.label === SIM_LABEL);
  assert.ok(i > 0, 'no simulated label');
  assert.deepEqual(p[i].ev, { type: 'call', state: 'live', since: 7, replay: true, label: SIM_LABEL });
  assert.deepEqual(p[i + 1].ev, { type: 'step', text: SIM_STEP });
  const firstCircuit = p.findIndex(x => x.ev.type === 'circuit');
  assert.ok(i < firstCircuit, 'label before the circuit');
  assert.ok(!p.slice(0, i).some(x => x.ev.type === 'circuit'));
  assert.equal(p.filter(x => x.ev.label === SIM_LABEL).length, 1);
  const late = schedule(ls, { from: 120_000, now: 7 });
  assert.ok(late.filter(x => x.at === 0).some(x => x.ev.label === SIM_LABEL), 'still announced when --from skips past it');
});
await test('replay: last call state from the Chert log', () => {
  assert.equal(lastCallState('  22:39:16  Incoming FaceTime Video call.\n  22:39:39  Call ended.\n'), 'idle');
  assert.equal(lastCallState('  22:39:39  Call ended.\n  23:47:02  Incoming FaceTime Video call.\n✓ Answered'), 'live');
  assert.equal(lastCallState('✓ Connected to Chert.'), 'unknown');
});

// ---------- watchdog ----------
const CHERT = `✓ Connected to Chert.
✓ "mentor-x" is in a waiting room. Call your line on FaceTime to talk to it. Ctrl+C to stop.
  21:10:40  Incoming FaceTime Video call.
✓ 21:10:41  Answered in 0.2 s.
`;
await test('watchdog: parses Chert states', () => {
  assert.deepEqual(parseChert(CHERT), { conn: 'connected', call: 'live', callAt: '21:10:40', lastError: '' });
  const ended = parseChert(CHERT + '  21:13:31  Call ended.\n! Connection to Chert lost (no heartbeat from the relay for 5 s): reconnecting, attempt 1 of 30 in 0.5 s…\n');
  assert.equal(ended.call, 'idle'); assert.equal(ended.conn, 'reconnecting');
  const missing = parseChert(CHERT + '✗ "mentor-x" is NOT in the waiting room, so every call is declined.\n');
  assert.equal(missing.conn, 'agent-missing'); assert.match(missing.lastError, /NOT in the waiting room/);
  const back = parseChert(CHERT + '✗ "mentor-x" is NOT in the waiting room.\n✓ "mentor-x" is in a waiting room. Call your line.\n');
  assert.equal(back.conn, 'connected'); assert.equal(back.lastError, '', 'recovered clears the error');
});
await test('watchdog: parses the agent log', () => {
  const a = parseAgent([
    '[demo] 12:00:00 starting agent',
    '{"level":30,"msg":"registered worker"}',
    '[mentor] brain: gemini',
    '{"level":50,"msg":"error in entry function","error":{"message":"Room disconnected"}}',
    '[brain:gemini] gemini-2.5-flash 429 RESOURCE_EXHAUSTED, falling back to gemini-2.5-flash-lite',
    '{"level":50,"msg":"ElevenLabs TTS failed","error":{"message":"401 invalid_api_key"}}',
  ].join('\n'));
  assert.equal(a.registered, true); assert.equal(a.brain, 'gemini');
  assert.match(a.lastError, /ElevenLabs TTS failed: 401/); assert.match(a.gemini, /429/); assert.match(a.eleven, /401/);
  assert.equal(parseAgent('{"level":30,"msg":"registered worker"}\n[demo] 12:01:00 starting agent').registered, false, 'restart resets');
});
// simulate the 2 s ticks: [time s, new chert text, callLive, chertOk]
const run = (armSecs, ticks, replaying = () => false) => {
  const arm = createArm({ armSecs, now: 0 });
  for (const [s, text = '', live = false, ok = true] of ticks) {
    const why = arm.tick({ now: s * 1000, newChert: text, callLive: live, chertOk: ok, replaying: replaying(s) });
    if (why) return { at: s, why };
  }
  return { at: null, why: arm.state.reason };
};
const INC = '  13:00:00  Incoming FaceTime Video call.\n';
await test('watchdog arm: no call within 60 s -> backup at 60 s', () => {
  const r = run(60, Array.from({ length: 40 }, (_, i) => [i * 2]));
  assert.equal(r.at, 60); assert.match(r.why, /no call within 60 s/);
});
await test('watchdog arm: call ends within 20 s -> backup', () => {
  const r = run(60, [[0], [2], [4, INC, true], [6, '', true], [8, '', true], [10, '  13:00:06  Call ended.\n', false], [12]]);
  assert.equal(r.at, 10); assert.match(r.why, /ended within 20 s/);
});
await test('watchdog arm: call declined (error) -> backup', () => {
  const r = run(60, [[0], [2, INC + '✗ 13:00:03  Call declined: the agent did not join in time.\n  13:00:04  Call ended.\n', false]]);
  assert.equal(r.at, 2);
});
await test('watchdog arm: a real call that lasts -> disarmed, never fires', () => {
  const ticks = [[0], [2, INC, true]];
  for (let s = 4; s <= 120; s += 2) ticks.push([s, '', true]);
  ticks.push([122, '  13:02:00  Call ended.\n', false], [124], [200]);
  const r = run(60, ticks);
  assert.equal(r.at, null); assert.match(r.why, /disarmed/);
});
await test('watchdog arm: never fires over a live call, even past the timer', () => {
  const ticks = [];
  for (let s = 0; s <= 100; s += 2) ticks.push([s, '', true, false]);
  assert.equal(run(30, ticks).at, null);
});
await test('watchdog arm: Chert disconnected >= 8 s -> backup; a 4 s blip does not', () => {
  const blip = run(60, [[0], [2, '', false, false], [4, '', false, false], [6, '', false, true], [8], [10]]);
  assert.equal(blip.at, null);
  const down = run(60, [[0], [2, '', false, false], [4, '', false, false], [6, '', false, false], [8, '', false, false], [10, '', false, false]]);
  assert.equal(down.at, 10); assert.match(down.why, /Chert/);
});
await test('watchdog arm: not while a replay is already running', () => {
  assert.equal(run(10, Array.from({ length: 20 }, (_, i) => [i * 2]), () => true).at, null);
});

// the demo.sh wiring (text checks: the script itself is not run)
await test('demo.sh starts the recorder and prints the arm command', () => {
  const sh = readFileSync(fileURLToPath(new URL('../demo.sh', import.meta.url)), 'utf8');
  assert.match(sh, /keep record .* node record\.mjs &/);
  assert.match(sh, /npm run watchdog -- --arm 60/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
