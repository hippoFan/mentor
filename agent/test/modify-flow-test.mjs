// The call agent's voice-edit + parts-list flow, end to end inside agent.mjs's real onTurn, with no network:
// builds a copy of agent.mjs in a temp folder whose LiveKit, voice, laptop page (startLive) and brain are fakes, then
// speaks scripted turns at it. Checks the consent gate (no brain call before "yes"), {type:'modify'} / revert /
// {type:'checklist'} events, the analysis of the new design and the project memory sent with an ordinary turn.
// Free: no keys, no ports, nothing written to runs/.
//   node test/modify-flow-test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

for (const k of ['ELEVEN_API_KEY', 'ELEVENLABS_API_KEY', 'MENTOR_TEST_TURN', 'MENTOR_WAKE', 'MENTOR_CONSENT', 'ODY_CONSENT', 'MENTOR_CIRCUIT']) delete process.env[k];
const agentDir = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'ody-flow-'));
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
const PEN = [{ id: 'part-0', name: 'Pen barrel' }, { id: 'part-1', name: 'Click button' }, { id: 'part-2', name: 'Pocket clip' }, { id: 'part-3', name: 'Tip cone' }];
const brain = {
  provider: 'fake', messages: [],
  async turn(text) { calls.turn.push(text); return { say: 'Here is what I see.', marks: [], step: '', done: false, note: '', ms: 1, board: { model: 'none', corners: [] } }; },
  async structured(prompt, _schema, _image, { system }) {
    calls.structured.push({ system, prompt });
    if (/design editor/.test(system)) {
      if (/clip/i.test(prompt.match(/Caller said: (.*)/)[1])) return { data: { target: { id: 'x', name: 'x' }, change: { name: 'Gold clip', color: '#d4af37', material: 'metal', shape: '', scale: [], offset_mm: [], note: 'Clip in gold-tone metal' }, say: 'Done: the clip is gold.', feasible: true, caveat: '' }, model: 'fake' };
      if (/smell/i.test(prompt)) return { data: { target: { id: 'x', name: 'x' }, change: { name: '', color: '', material: '', shape: '', scale: [], offset_mm: [], note: '' }, say: "A smell isn't something I can show on the model.", feasible: false, caveat: '' }, model: 'fake' };
      return { data: { target: { id: 'x', name: 'x' }, change: { name: 'Brush tip', color: '#1c1c1e', material: 'fabric', shape: 'capsule', scale: [1, 1, 1.2], offset_mm: [], note: 'Cone tip swapped for a soft brush' }, say: 'Done: the tip is now a soft brush.', feasible: true, caveat: 'Needs brush-pen ink' }, model: 'fake' };
    }
    if (/build checker/.test(system)) return { data: { title: 'Pen with a brush tip', works: true, summary: 'It works as a brush pen.', pros: ['Expressive lines'], cons: ['Needs new ink'], needs: ['Brush-pen ink'], verdict: 'A brush pen.' }, model: 'fake' };
    if (/parts planner/.test(system)) return { data: { name: 'Buzzer', why: 'Beeps on events', qty: 1, part: 'Active buzzer 5V', pins: ['+ -> pin 8', '- -> GND'] }, model: 'fake' };
    throw new Error(`unexpected structured call: ${system.slice(0, 40)}`);
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
const file = join(dir, 'agent-flow.gen.mjs');
await writeFile(file, src);
const { default: agent } = await import(pathToFileURL(file).href);
const room = { on() {}, off() {}, remoteParticipants: new Map(), localParticipant: { identity: 'agent', publishTrack: async () => {} } };
await agent.entry({ connect: async () => {}, waitForParticipant: async () => ({ identity: 'caller' }), job: { id: 'flow' }, room, addShutdownCallback: fn => shutdowns.push(fn) });
const turn = t => globalThis.__fake.onTurn(t);
const page = m => { for (const fn of pageFns) fn(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastOf = type => events.filter(e => e.type === type).at(-1);

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };
try {
  await test('consent gate: no brain call before "yes"', async () => {
    page({ type: 'parts', scope: 'scan', board: 'Red retractable pen', parts: PEN });
    await turn('change the tip to a brush'); await turn('add a buzzer');
    assert.equal(calls.structured.length + calls.turn.length, 0);
    assert.equal(events.some(e => e.type === 'modify' || e.type === 'checklist'), false);
    await turn('yes');
  });
  await test('"change the tip to a brush" -> one brain call -> {type:modify} with the tip and its scan spec', async () => {
    await turn('change the tip to a brush');
    assert.equal(calls.structured.length, 1);
    assert.match(calls.structured[0].prompt, /id "part-3", name "Tip cone"/);
    const m = lastOf('modify');
    assert.deepEqual({ scope: m.scope, target: m.target, revert: m.revert }, { scope: 'scan', target: { id: 'part-3', name: 'Tip cone' }, revert: undefined });
    assert.deepEqual(m.change, { name: 'Brush tip', color: '#1c1c1e', material: 'fabric', shape: 'capsule', scale: [1, 1, 1.2], note: 'Cone tip swapped for a soft brush' });
    assert.equal(m.say, 'Done: the tip is now a soft brush.'); assert.equal(says.at(-1), m.say);
  });
  await test('"make the clip gold", then "undo that" reverts the clip only', async () => {
    await turn('make the clip gold');
    assert.equal(lastOf('modify').target.id, 'part-2');
    await turn('undo that');
    const m = lastOf('modify');
    assert.deepEqual({ id: m.target.id, revert: m.revert }, { id: 'part-2', revert: true });
    assert.equal(calls.structured.length, 2);   // undo is free
  });
  await test('an impossible edit is refused out loud, nothing published', async () => {
    const n = events.filter(e => e.type === 'modify').length;
    await turn('make the barrel smell like lavender');
    await turn('change the barrel to a lavender smell');
    assert.equal(events.filter(e => e.type === 'modify').length, n);
    assert.match(says.at(-1), /smell/);
  });
  await test('negatives go to the ordinary brain turn, not the editor', async () => {
    const s = calls.structured.length, t = calls.turn.length;
    await turn('change the subject'); await turn("what's the tip for");
    assert.equal(calls.structured.length, s); assert.equal(calls.turn.length, t + 2);
  });
  await test('"add a buzzer" -> parts list with wiring; ops are free', async () => {
    const s = calls.structured.length;
    await turn('add a buzzer');
    assert.equal(calls.structured.length, s + 1);
    const c = lastOf('checklist');
    assert.equal(c.items.length, 1);
    assert.deepEqual({ ...c.items[0], id: 'x' }, { id: 'x', name: 'Buzzer', why: 'Beeps on events', qty: 1, status: 'needed', suggested: { part: 'Active buzzer 5V', pins: ['+ \u2192 pin 8', '- \u2192 GND'] }, source: 'voice' });
    assert.equal(says.at(-1), "I don't have a 3D model for a buzzer yet, so it's on your parts list with how to wire it.");
    await turn('add a buzzer');
    assert.match(says.at(-1), /already on your parts list/);
    await turn('what do I still need?');
    assert.equal(says.at(-1), 'Still needed: a buzzer.');
    await turn('I have the buzzer');
    assert.equal(lastOf('checklist').items[0].status, 'have');
    assert.equal(calls.structured.length, s + 1);
  });
  await test('project memory in an ordinary turn has the modification and the parts list', async () => {
    await turn('what do you think of it so far?');
    const m = calls.turn.at(-1);
    assert.match(m, /modified by voice.*Tip cone now "Brush tip"/); assert.match(m, /parts list.*Buzzer \(have, Active buzzer 5V\)/);
    assert.doesNotMatch(m, /Pocket clip/);   // reverted
  });
  await test('page analyze without modified[] -> the agent adds its edits; analysis of the new design', async () => {
    page({ type: 'analyze', scope: 'scan', board: 'Red retractable pen', kept: PEN, removed: [] });
    await sleep(50);
    const a = lastOf('analysis');
    assert.equal(a.title, 'Pen with a brush tip');
    assert.deepEqual(a.modified.map(x => x.id), ['part-3']);
    assert.match(calls.structured.at(-1).prompt, /Modified parts[\s\S]*Tip cone: now "Brush tip"/);
  });
  await test('"put the tip back" reverts it; "remove the buzzer from the list" empties the list', async () => {
    await turn('put the tip back');
    assert.deepEqual({ id: lastOf('modify').target.id, revert: lastOf('modify').revert }, { id: 'part-3', revert: true });
    await turn('remove the buzzer from the list');
    assert.equal(lastOf('checklist').items.length, 0);
  });
  await test('"show me the new design" after an edit: combine, and the agent checks it if the page sends no analyze', async () => {
    await turn('make the clip gold');
    const before = events.filter(e => e.type === 'analysis').length;
    await turn('show me the new design');
    assert.equal(lastOf('twin').action, 'combine');
    assert.match(says.at(-1), /new design/);
    await sleep(4300);
    assert.equal(events.filter(e => e.type === 'analysis').length, before + 1);
    assert.deepEqual(lastOf('analysis').modified.map(x => x.name), ['Pocket clip']);
  });
} finally {
  for (const fn of shutdowns) { try { await fn(); } catch { /* fake */ } }
  await rm(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed`);
process.exit(0);
