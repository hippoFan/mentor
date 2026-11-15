// Digital by default (teammate-notes/01-digital-by-default.md), end to end inside agent.mjs's real onTurn with no
// network (the same harness as modify-flow-test: fake LiveKit, voice, laptop page and brain). Checks where each line lands:
//   "swap the LED for a distance sensor" -> the circuit builder (remove + add + rewire), never a reshape of the LED
//   "make the clip gold"                 -> the shape editor (modify)
//   "walk me through it" / "done"        -> the real-board step guide, only when asked
//   "on my real board, where does ..."   -> an ordinary brain turn (the camera)
//   "add a distance sensor"              -> confirmed on the model, no step spoken until asked
// Free: no keys, no ports, nothing written to runs/.
//   node test/digital-default-test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

for (const k of ['ELEVEN_API_KEY', 'ELEVENLABS_API_KEY', 'MENTOR_TEST_TURN', 'MENTOR_WAKE', 'MENTOR_CONSENT', 'ODY_CONSENT', 'MENTOR_CIRCUIT']) delete process.env[k];
const agentDir = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'ody-digital-'));
let src = await readFile(`${agentDir}agent.mjs`, 'utf8');
const swap = (a, b) => { if (!src.includes(a)) throw new Error(`anchor not found: ${a.slice(0, 60)}`); src = src.replace(a, b); };
swap("import { AutoSubscribe, defineAgent, voice } from '@livekit/agents';", "const { AutoSubscribe, defineAgent, voice } = globalThis.__fake.agents;");
swap("import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';", 'const elevenlabs = {};');
swap("import { BackgroundVoiceCancellation, NoiseCancellation } from '@livekit/noise-cancellation-node';", 'const BackgroundVoiceCancellation = () => null, NoiseCancellation = () => null;');
src = src.replace(/import \{\s*LocalVideoTrack,[\s\S]*?\} from '@livekit\/rtc-node';/, 'const { LocalVideoTrack, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream } = globalThis.__fake.rtc;');
swap("import { createBrain } from './brain.mjs';", 'const createBrain = async () => globalThis.__fake.brain;');
swap("import { startLive } from './live.mjs';", 'const startLive = async () => globalThis.__fake.live;');
swap("import { greetOnBridgeReady } from './greet.mjs';", 'const greetOnBridgeReady = (_room, fn) => { fn(); return () => {}; };');
swap("import { runAgent } from './chert-rooms.mjs';", '');
swap("void pruneRuns(RUNS_DIR, { days: KEEP_DAYS });", '');
swap("await pruneRuns(RUNS_DIR, { days: KEEP_DAYS });", '');
swap("fileURLToPath(new URL('../runs/', import.meta.url))", JSON.stringify(`${dir}/runs/`));
swap("if (TEST_TURN) {   // test hook", "globalThis.__fake.onTurn = onTurn;\n    if (TEST_TURN) {   // test hook");
src = src.replace(/runAgent\(agent, [^\n]*\);/, '');
src = src.replace("import './env.mjs';", `import '${pathToFileURL(agentDir + 'env.mjs').href}';`);
src = src.replace(/from '\.\/([\w-]+\.mjs)'/g, (_, f) => `from '${pathToFileURL(agentDir + f).href}'`);
src = src.replace("new URL('.', import.meta.url)", `new URL('${pathToFileURL(agentDir).href}')`);

// ---------- fakes ----------
const events = [], says = [], shutdowns = [], pageFns = [];
const calls = { structured: [], turn: [] };
const BOARD = [{ id: 'led-l', name: 'L LED' }, { id: 'usb', name: 'USB-B port' }, { id: 'reset', name: 'Reset button' }];
const PEN = [{ id: 'part-0', name: 'Pen barrel' }, { id: 'part-1', name: 'Click button' }, { id: 'part-2', name: 'Pocket clip' }, { id: 'part-3', name: 'Tip cone' }];
const brain = {
  provider: 'fake', messages: [],
  async turn(text) { calls.turn.push(text); return { say: 'The red wire goes to 5V on your board.', marks: [], step: '', done: false, note: '', ms: 1, board: { model: 'none', corners: [] } }; },
  async structured(prompt, _schema, _image, { system }) {
    calls.structured.push({ system, prompt });
    if (/design editor/.test(system)) return { data: { target: { id: 'x', name: 'x' }, change: { name: 'Gold clip', color: '#d4af37', material: 'metal', shape: '', scale: [], offset_mm: [], note: 'Clip in gold-tone metal' }, say: 'Done: the clip is gold now.', feasible: true, caveat: '' }, model: 'fake' };
    throw new Error(`unexpected structured call: ${system.slice(0, 40)}`);   // swaps and adds must not need the planner
  },
  idle: async () => {}, close: async () => {},
};
const live = { send(e) { events.push(e); if (e.type === 'say') says.push(e.text); }, onPage(fn) { pageFns.push(fn); return () => {}; }, async close() {} };
class FakeAgent { constructor() {} }
globalThis.__fake = {
  brain, live,
  agents: { AutoSubscribe: { SUBSCRIBE_ALL: 1 }, defineAgent: a => a, voice: { Agent: FakeAgent, AgentSession: class {}, AgentSessionEventTypes: {} } },
  rtc: { LocalVideoTrack: { createVideoTrack: () => ({ close() {} }) }, RoomEvent: {}, TrackKind: {}, TrackSource: {}, VideoBufferType: { RGBA: 0 },
    VideoFrame: class {}, VideoSource: class { captureFrame() {} close() {} }, VideoStream: class {} },
};
const file = join(dir, 'agent-digital.gen.mjs');
await writeFile(file, src);
const { default: agent } = await import(pathToFileURL(file).href);
const room = { on() {}, off() {}, remoteParticipants: new Map(), localParticipant: { identity: 'agent', publishTrack: async () => {} } };
await agent.entry({ connect: async () => {}, waitForParticipant: async () => ({ identity: 'caller' }), job: { id: 'flow' }, room, addShutdownCallback: fn => shutdowns.push(fn) });
const turn = t => globalThis.__fake.onTurn(t);
const page = m => { for (const fn of pageFns) fn(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastOf = type => events.filter(e => e.type === type).at(-1);

const circuitNow = () => lastOf('circuit')?.state || lastOf('circuit');
const parts = () => (circuitNow()?.components || []).map(c => c.part).sort();
const stepEvents = () => events.filter(e => e.type === 'circuit-step').length;
const JUMPER = /\b(?:jumper|breadboard|rail|from (?:5V|GND|pin))\b/i;

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };
try {
  await turn('yes');
  page({ type: 'parts', scope: 'board', board: 'uno-r3', parts: BOARD });

  await test('"add a distance sensor": confirmed on the model, no step spoken, nothing ringed on the video', async () => {
    const n = says.length, s0 = stepEvents();
    await turn('add a distance sensor');
    assert.deepEqual(parts(), ['hc-sr04']);
    assert.match(says.at(-1), /^Added it on the model: the distance sensor's trigger is on pin \d+ and echo on pin \d+\.$/);
    assert.equal(says.length, n + 1); assert.doesNotMatch(says.at(-1), JUMPER);
    assert.equal(stepEvents(), s0); assert.equal(events.filter(e => e.type === 'turn').length, 0);
    assert.equal(calls.structured.length + calls.turn.length, 0);
  });

  await test('"done" before any walk-through is not a wiring step', async () => {
    const c = events.filter(e => e.type === 'circuit').length, s0 = stepEvents(), n = says.length;
    await turn('done');
    assert.equal(events.filter(e => e.type === 'circuit').length, c); assert.equal(stepEvents(), s0);
    assert.deepEqual(circuitNow().done, []); assert.ok(says.slice(n).every(x => !JUMPER.test(x)));
  });

  await test('"swap the LED for a distance sensor" (board shows an L LED) -> the circuit builder, not modify', async () => {
    await turn('add an LED');
    assert.deepEqual(parts(), ['hc-sr04', 'led-5mm']);
    const sensors = circuitNow().components.filter(c => c.part === 'hc-sr04').length;
    await turn('swap the LED for a distance sensor');
    assert.equal(events.filter(e => e.type === 'modify').length, 0);
    assert.deepEqual(parts(), Array(sensors + 1).fill('hc-sr04'));
    assert.match(says.at(-1), /^Swapped it on the model: the distance sensor's trigger is on pin \d+ and echo on pin \d+\.$/);
    for (const w of circuitNow().connections) assert.ok(w.from && w.to, 'wired');
    assert.equal(calls.structured.length, 0);   // a template, no planner call
  });

  await test('"change the LED to a sensor" asks which one, then swaps', async () => {
    await turn('add an LED');
    await turn('change the LED to a sensor');
    assert.equal(says.at(-1), 'Which sensor? Distance, temperature, or motion?');
    await turn('temperature');
    assert.ok(parts().includes('dht22') && !parts().includes('led-5mm'));
    assert.match(says.at(-1), /^Swapped it on the model: the temperature sensor/);
    assert.equal(events.filter(e => e.type === 'modify').length, 0);
  });

  await test('"walk me through it" -> the step guide; "done" steps forward', async () => {
    const s0 = stepEvents();
    await turn('walk me through it');
    const first = events.filter(e => e.type === 'circuit-step').at(-1);
    assert.equal(stepEvents(), s0 + 1); assert.equal(first.index, 1);
    assert.ok(says.includes(first.step.say));
    await turn('done');
    await sleep(20);
    const second = events.filter(e => e.type === 'circuit-step').at(-1);
    assert.equal(second.index, 2); assert.ok(says.includes(second.step.say));
  });

  await test('mid-build, a change asks once: "On the model or your real board?"', async () => {
    await turn('add a servo');
    assert.equal(says.at(-1), 'On the model or your real board?');
    assert.ok(!parts().includes('servo-sg90'));
    await turn('just the model');
    assert.ok(parts().includes('servo-sg90'));
    assert.match(says.at(-1), /^Added it on the model: the servo is on pin \d+\.$/);
    const s0 = stepEvents();
    await turn('add an LED');   // never asked again
    assert.match(says.at(-1), /^Added it on the model/); assert.equal(stepEvents(), s0);
  });

  await test('"on my real board, where does the red wire go" -> an ordinary brain turn (camera)', async () => {
    const t = calls.turn.length, c = events.filter(e => e.type === 'circuit').length;
    await turn('on my real board, where does the red wire go');
    assert.equal(calls.turn.length, t + 1); assert.match(calls.turn.at(-1), /on my real board, where does the red wire go/);
    assert.equal(events.filter(e => e.type === 'circuit').length, c);
  });

  await test('other walk-through phrases start the guide', async () => {
    for (const p of ['how do I wire this', 'physically', "what's the next step", 'on the real board']) {
      const s0 = stepEvents();
      await turn('add a button');   // a change ends the walk-through
      await turn(p);
      assert.equal(stepEvents(), s0 + 1, p);
    }
  });

  await test('scan: "make the clip gold" -> modify; the 7-word stage commands stay instant', async () => {
    page({ type: 'parts', scope: 'scan', board: 'Red retractable pen', parts: PEN });
    const s = calls.structured.length;
    await turn('make the clip gold');
    const m = lastOf('modify');
    assert.equal(m.target.id, 'part-2'); assert.equal(calls.structured.length, s + 1);
    assert.match(calls.structured.at(-1).system, /design editor/);
    await turn('explode it');
    assert.equal(lastOf('twin').action, 'explode'); assert.equal(calls.structured.length, s + 1);
  });
} finally {
  for (const fn of shutdowns) { try { await fn(); } catch { /* fake */ } }
  await rm(dir, { recursive: true, force: true });
}
console.log(`\n${pass} digital-default tests passed`);
process.exit(0);
