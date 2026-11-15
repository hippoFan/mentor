// Consent + privacy (consent.mjs): consent phrases, the gate (no brain call before a clear yes, checked with a fake
// brain wired the way agent.mjs wires it), "stop recording", and retention of call folders. Free, no keys.
//   node test/consent-test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSENT_DECLINED, CONSENT_REASK, CONSENT_THANKS, NO_RECORDING_SAY, RUN_DIR_RE, consentAnswer, createConsentGate, isNoRecord, pruneRuns } from '../consent.mjs';
import { isScanIntent } from '../scan.mjs';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };

await test('consent phrases: yes / no / unclear (20 cases)', () => {
  const cases = [
    ['yes', 'yes', ''], ['Yes.', 'yes', ''], ['yeah', 'yes', ''], ['Yeah, sure.', 'yes', ''], ['sure', 'yes', ''], ['okay', 'yes', ''],
    ['I agree', 'yes', ''], ['go ahead', 'yes', ''], ['Continue.', 'yes', ''], ['no problem', 'yes', ''],
    ['yes, scan this', 'yes', 'scan this'], ['Yeah, what is this board?', 'yes', 'what is this board?'], ['ok so explode it', 'yes', 'explode it'],
    ['no', 'no', ''], ['Nope.', 'no', ''], ["don't", 'no', ''], ['stop', 'no', ''], ['No thanks', 'no', ''], ['I do not agree', 'no', ''],
    ['what?', 'unclear', ''], ['yes?', 'unclear', ''], ['Hello?', 'unclear', ''], ["I don't know", 'unclear', ''], ['who is this', 'unclear', ''],
    ['yesterday I built a robot', 'unclear', ''], ['', 'unclear', ''],
  ];
  for (const [t, answer, rest] of cases) assert.deepEqual(consentAnswer(t), { answer, rest }, t);
  assert.ok(isScanIntent(consentAnswer('yes, scan this').rest));   // the rest is handled as a turn right after consent
});

await test('"stop recording" phrases', () => {
  for (const t of ['stop recording', "Don't save anything", 'please stop saving snapshots', 'turn off recording', 'no more snapshots', 'do not record']) assert.ok(isNoRecord(t), t);
  for (const t of ['save the model', 'export it', 'what is recording', 'stop spinning', 'record a video of the LED']) assert.ok(!isNoRecord(t), t);
});

/** The agent's routing before consent, with a fake brain that counts calls (agent.mjs onTurn does exactly this first). */
function fakeCall(enabled = true) {
  const said = [], sent = [], logged = [], brainCalls = [], scans = [];
  const brain = { turn: async heard => { brainCalls.push(heard); return { say: 'ok', marks: [] }; }, scan: async () => { scans.push(1); return {}; } };
  const gate = createConsentGate({ enabled, say: t => said.push(t), send: e => sent.push(e), log: r => logged.push(r) });
  const onTurn = async heard => {
    if (!gate.given) {
      if (isNoRecord(heard)) gate.stopRecording();
      const { pass: ok, rest } = gate.answer(heard);
      if (!ok) return;
      if (rest) return onTurn(rest);
      return;
    }
    if (isScanIntent(heard)) return brain.scan(heard);
    return brain.turn(heard);
  };
  return { gate, onTurn, said, sent, logged, brainCalls, scans };
}

await test('gate: no brain call, scan or snapshot before a clear yes', async () => {
  const c = fakeCall();
  c.gate.asked();
  assert.equal(c.sent[0].state, 'asked');
  for (const t of ['what is this board?', 'scan this', 'hmm', 'where is the USB port', 'explode it']) await c.onTurn(t);
  assert.equal(c.brainCalls.length, 0); assert.equal(c.scans.length, 0); assert.equal(c.gate.recording, false);
  assert.deepEqual(c.said, [CONSENT_REASK], 're-asks once, then waits quietly');
  await c.onTurn('yes, scan this');
  assert.equal(c.scans.length, 1, 'the scan in "yes, scan this" runs right after consent');
  assert.equal(c.gate.given, true); assert.equal(c.gate.recording, true);
  assert.equal(c.logged[0].state, 'given'); assert.ok(!Number.isNaN(Date.parse(c.logged[0].at)));
  assert.equal(c.sent.at(-1).state, 'given');
  await c.onTurn('what is this board?');
  assert.deepEqual(c.brainCalls, ['what is this board?']);
});

await test('gate: no -> declined once, stays gated; a later clear yes still counts', async () => {
  const c = fakeCall();
  await c.onTurn('no'); await c.onTurn('no!'); await c.onTurn('what is this');
  assert.deepEqual(c.said, [CONSENT_DECLINED]);
  assert.equal(c.sent.filter(e => e.state === 'declined').length, 1);
  assert.equal(c.brainCalls.length, 0); assert.equal(c.gate.state, 'declined');
  await c.onTurn('okay, yes');
  assert.equal(c.gate.given, true); assert.deepEqual(c.said.at(-1), CONSENT_THANKS);
});

await test('gate: "stop recording" before or after consent', async () => {
  const a = fakeCall();
  await a.onTurn('stop recording');
  assert.equal(a.gate.given, false); assert.equal(a.gate.noRecording, true);
  await a.onTurn('yes'); assert.equal(a.gate.given, true); assert.equal(a.gate.recording, false, 'still no snapshots after a later yes');
  const b = fakeCall();
  await b.onTurn('yes');
  assert.equal(b.gate.recording, true);
  assert.equal(b.gate.stopRecording(), true); assert.equal(b.gate.stopRecording(), false);
  assert.equal(b.gate.recording, false); assert.equal(b.gate.given, true, 'calls still work');
  assert.equal(b.sent.at(-1).state, 'no-recording'); assert.equal(b.logged.at(-1).state, 'no-recording');
  assert.ok(NO_RECORDING_SAY.length < 80);
});

await test('gate off (ODY_CONSENT=0, owner testing): straight through', async () => {
  const c = fakeCall(false);
  await c.onTurn('what is this');
  assert.equal(c.brainCalls.length, 1); assert.equal(c.said.length, 0);
});

await test('retention: only dated call folders older than 7 days; never symlinks or anything else', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ody-retention-'));
  try {
    const runs = join(root, 'runs'), outside = join(root, 'outside');
    await mkdir(runs); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'x');
    const now = Date.UTC(2026, 10, 15, 12, 0);
    const old = ['2026-11-01-10-00-65b46f583e64', '2026-11-07-11-59-aaaaaa'], fresh = ['2026-11-08-12-01-bbbbbb', '2026-11-15-04-39-65b46f583e64'];
    for (const d of [...old, ...fresh]) { await mkdir(join(runs, d, 'frames'), { recursive: true }); await writeFile(join(runs, d, 'frames', '001-in.jpg'), 'x'); }
    // inside an old folder: a symlink to a folder outside runs/ (must be unlinked, never followed)
    await symlink(outside, join(runs, old[0], 'link-out'));
    const others = ['_test-2026-01-01', 'research-cache', '2026-01-01-00-00-NOTHEX', '2026-01-01-00-00', 'notes.txt'];
    for (const d of others) d.endsWith('.txt') ? await writeFile(join(runs, d), 'x') : await mkdir(join(runs, d));
    await symlink(outside, join(runs, '2026-01-01-00-00-cccccc'));   // a dated name that is a symlink: never touched
    const lines = [];
    const deleted = await pruneRuns(runs, { days: 7, now, log: l => lines.push(l) });
    assert.deepEqual(deleted.sort(), old.sort());
    const left = (await readdir(runs)).sort();
    assert.deepEqual(left, [...fresh, ...others, '2026-01-01-00-00-cccccc'].sort());
    assert.deepEqual(await readdir(outside), ['keep.txt'], 'the symlink target survived');
    assert.match(lines.join('\n'), /deleted 2 call folder/);
    assert.ok(RUN_DIR_RE.test('2026-11-15-04-39-65b46f583e64') && !RUN_DIR_RE.test('_test-2026-11-15-04-39-65b46f583e64'));
    assert.deepEqual(await pruneRuns(join(root, 'missing'), { now }), []);   // no runs/ yet: nothing, no throw
  } finally { await rm(root, { recursive: true, force: true }); }
});

console.log(`${pass} consent tests passed`);
