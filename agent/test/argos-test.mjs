// Argos backend, free and without keys: a fake OpenAI-compatible model server answers every role, OpenSCAD (WASM) really
// compiles, and the real /argos/ routes run on a mock page server (ports 8796-8799, never the live 8790).
// Covers: scan -> Forge design with OpenSCAD, compile, single refine (with an automatic fix after a compile error),
// multicode (manager, researcher, developer, auditor rounds), chat routing (twin command, circuit swap, physical steps
// only when asked, refine handoff), imports (outside label, bad files refused), keys (masked, validated), Origin checks.
//   node test/argos-test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'argos-'));
process.env.ARGOS_DESIGNS_DIR = dir;
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY']) delete process.env[k];

const { createServer: netServer } = await import('node:net');
const free = p => new Promise(ok => { const s = netServer().once('error', () => ok(false)).listen(p, '127.0.0.1', () => s.close(() => ok(true))); });
const ports = []; for (const p of [8798, 8799, 8797, 8796]) if (await free(p)) ports.push(p);
if (ports.length < 2) { console.error('need two free ports in 8796-8799'); process.exit(2); }
const [PAGE, MODEL] = ports;
process.env.MENTOR_MONITOR_PORT = String(PAGE);

// ---- the fake model: answers by role (from the system prompt) ----
const seen = [];
let devCalls = 0;
const GOOD = 'module part_plate() { cube([60, 40, 3], center = true); }\nmodule assembly() { color([0.5,0.5,0.5]) part_plate(); }\nassembly();\n';
const model = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const j = JSON.parse(body), sys = j.messages[0].content, user = j.messages[1].content;
  let out;
  if (/developer/.test(sys)) out = ++devCalls === 1 ? { code: 'cube([1,2', summary: 'broken first try' } : { code: GOOD, summary: 'Made the plate 3 mm thick.' };
  else if (/manager of a small CAD team/.test(sys)) out = { goal: 'Thicker plate', acceptance: ['plate is 3 mm thick'], questions: ['M3 clearance hole?'], steps: ['change thickness'] };
  else if (/researcher/.test(sys)) out = { facts: [{ fact: 'M3 clearance', value: '3.2 mm' }], unsure: [] };
  else if (/auditor/.test(sys)) out = /Compile: OK/.test(user) ? { pass: true, issues: [], fix: '' } : { pass: false, issues: ['does not compile'], fix: 'close the bracket' };
  else if (/You are the manager\. Summarise/.test(sys)) out = { summary: 'The plate is now 3 mm thick.', caveats: ['Not printed yet.'] };
  else if (/You are Argos/.test(sys)) out = /thicker/.test(user) ? { reply: 'Making it thicker.', refine: 'make the plate 3 mm thick' } : { reply: 'Hi, I am Argos.', refine: '' };
  else if (/circuit|Arduino/i.test(sys)) out = { say: 'Swapped the LED for a distance sensor.', actions: [{ op: 'remove', target: 'LED' }, { op: 'add', part: 'hc-sr04' }] };
  else out = {};
  seen.push(sys.slice(0, 40));
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
}).listen(MODEL, '127.0.0.1');
process.env.ARGOS_OPENAI_KEY = 'test-key-not-real-000';
process.env.ARGOS_OPENAI_BASE = `http://127.0.0.1:${MODEL}/v1`;

const { createLiveServer } = await import('../live.mjs');
const { createArgos } = await import('../argos/server.mjs');
const events = [];
let argos;
const live = await createLiveServer({ onPageMessage: m => argos.onPageMessage(m), routes: (req, res) => argos.route(req, res) });
argos = createArgos({ send: e => { events.push(e); live.send(e); } });
const base = `http://127.0.0.1:${PAGE}`, origin = { origin: base };
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...origin, ...headers }, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
const until = async (fn, ms = 60_000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } throw new Error('timed out'); };
let ok = 0; const pass = m => { ok++; console.log('ok ', m); };

try {
  // state + Origin
  let r = await fetch(`${base}/argos/state`); const st = await r.json();
  assert.equal(st.providers.find(p => p.id === 'openai').ready, true); assert.ok(!JSON.stringify(st).includes('test-key-not-real')); pass('state lists providers, never the key');
  r = await fetch(`${base}/argos/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
  assert.equal(r.status, 403); pass('cross-site POST refused');

  // a call's scan becomes a design
  argos.onPublished({ type: 'scan', spec: { name: 'Plate', dims_mm: { w: 60, d: 40, h: 2 }, parts: [{ name: 'Plate', shape: 'box', size_mm: { x: 60, y: 40, z: 2 }, position_mm: { x: 0, y: 0, z: 1 }, rotation_deg: { x: 0, y: 0, z: 0 }, color: '#888888', material: 'plastic', label: '' }] }, photo: Buffer.from('jpeg').toString('base64') });
  const scanEv = await until(() => events.find(e => e.kind === 'design'));
  const id = scanEv.design.id;
  assert.equal(scanEv.design.kind, 'scan'); assert.ok(scanEv.design.files.includes('source.scad')); pass('scan saved to the Forge with OpenSCAD source');
  r = await fetch(`${base}/argos/designs/${id}/source.scad`); assert.match(await r.text(), /module part_plate/); pass('source.scad served');
  r = await fetch(`${base}/argos/designs/${id}/../../etc/passwd`); assert.equal(r.status, 404); pass('no path traversal');

  // compile the original
  r = await post(`/argos/designs/${id}/compile`, {}); const built = await r.json();
  assert.equal(r.status, 200); assert.ok(built.design.files.includes('model.stl')); pass(`original compiled to STL (${built.ms} ms)`);

  // single refine: first try fails to compile, the fix compiles
  r = await post('/argos/refine', { designId: id, instruction: 'make it 3 mm thick', mode: 'single', provider: 'openai' });
  assert.equal(r.status, 202); const { jobId } = await r.json();
  const done1 = await until(() => events.find(e => e.kind === 'refine' && e.jobId === jobId && (e.state === 'done' || e.state === 'failed')));
  assert.equal(done1.state, 'done', done1.error); assert.ok(events.some(e => e.jobId === jobId && /found a problem/.test(e.step?.text || ''))); pass('single refine: compile error fixed automatically, saved as a new version');

  // multicode
  devCalls = 1;   // developer answers well from now on
  r = await post('/argos/refine', { designId: id, instruction: 'make it 3 mm thick', mode: 'multicode', provider: 'openai' });
  const j2 = (await r.json()).jobId;
  const done2 = await until(() => events.find(e => e.kind === 'refine' && e.jobId === j2 && (e.state === 'done' || e.state === 'failed')));
  assert.equal(done2.state, 'done', done2.error);
  const roles = new Set(events.filter(e => e.jobId === j2 && e.step).map(e => e.step.role));
  for (const role of ['manager', 'researcher', 'developer', 'auditor']) assert.ok(roles.has(role), role);
  assert.equal(done2.summary, 'The plate is now 3 mm thick.'); pass(`multicode: manager, researcher, developer, auditor (${done2.calls} model calls)`);

  // chat routing
  argos.onPageMessage({ type: 'parts', scope: 'board', board: 'uno-r3', parts: [{ id: 'reset_button', name: 'Reset button' }] });
  r = await post('/argos/chat', { text: 'remove the reset button' }); let c = await r.json();
  assert.equal(c.route, 'twin'); assert.ok(events.some(e => e.type === 'twin' && e.action === 'remove' && e.target === 'reset_button')); pass('chat: part command goes straight to the 3D stage');
  r = await post('/argos/chat', { text: 'add an LED', provider: 'openai' }); c = await r.json(); assert.equal(c.route, 'circuit');
  r = await post('/argos/chat', { text: 'swap the LED for a distance sensor', provider: 'openai' }); c = await r.json();
  assert.equal(c.route, 'circuit'); assert.ok(events.some(e => e.type === 'circuit')); pass(`chat: circuit change is digital (${c.text})`);
  assert.ok(!/Step \d/.test(c.text)); pass('chat: no physical walk-through unless asked');
  r = await post('/argos/chat', { text: 'walk me through it' }); c = await r.json(); assert.equal(c.route, 'physical'); pass(`chat: physical steps on request (${c.text.slice(0, 60)}…)`);
  r = await post('/argos/chat', { text: 'make it thicker', designId: id, provider: 'openai' }); c = await r.json();
  assert.equal(c.route, 'chat'); assert.ok(c.refineJob); pass('chat: a shape change starts a refinement of the selected design');
  await until(() => events.find(e => e.jobId === c.refineJob && (e.state === 'done' || e.state === 'failed')));

  // imports
  const stl = Buffer.alloc(184); stl.write('binary stl'); stl.writeUInt32LE(2, 80);
  r = await post('/argos/import?name=bracket.stl', stl, { 'content-type': 'application/octet-stream' }); const imp = await r.json();
  assert.equal(imp.design.outside, true); assert.match(imp.design.note, /outside Ody/); pass('import: STL accepted and labelled as made outside Ody');
  r = await post('/argos/refine', { designId: imp.design.id, instruction: 'thicker' }); assert.equal(r.status, 422); assert.match((await r.json()).error, /outside Ody/); pass('import: honest refusal to AI-edit a mesh with no source');
  r = await post('/argos/import?name=evil.exe', Buffer.from('MZ'), { 'content-type': 'application/octet-stream' }); assert.equal(r.status, 400); pass('import: unknown file type refused');
  r = await post('/argos/import?name=fake.glb', Buffer.from('not a glb at all'), { 'content-type': 'application/octet-stream' }); assert.equal(r.status, 400); pass('import: fake GLB refused');

  // keys
  r = await fetch(`${base}/argos/keys`); const ks = await r.json(); assert.ok(!JSON.stringify(ks).includes('test-key-not-real')); pass('keys: never returned');
  assert.ok(!JSON.stringify(ks).includes('-000')); assert.equal(ks.keys.find(k => k.name === 'ARGOS_OPENAI_BASE').value, `127.0.0.1:${MODEL}`); pass('keys: no last 4 characters, base URL shown as host only');
  r = await post('/argos/keys', { name: 'GEMINI_API_KEY', value: 'AIzaFakeFakeFake' }); assert.equal(r.status, 403); assert.equal(process.env.GEMINI_API_KEY, undefined); pass('keys: the page can never set a key');
  r = await post('/argos/keys', { name: 'ARGOS_OPENAI_BASE', value: 'https://evil.example/v1' }); assert.equal(r.status, 403); assert.equal(process.env.ARGOS_OPENAI_BASE, `http://127.0.0.1:${MODEL}/v1`); pass('keys: the page can never move the model base URL');
  r = await fetch(`${base}/argos/designs/${id}/source.scad`); assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin'); pass('design files: same-origin only (CORP)');

  // privacy: no scan saved after "stop recording" or a decline; a new call resets; call scans expire like call folders
  const scanSpec = { name: 'Private', parts: [{ name: 'Box', shape: 'box', size_mm: { x: 10, y: 10, z: 10 } }] };
  const nDesigns = async () => (await (await fetch(`${base}/argos/designs`)).json()).designs.length;
  const before = await nDesigns();
  argos.onPublished({ type: 'consent', state: 'no-recording' }); argos.onPublished({ type: 'scan', spec: scanSpec, photo: '' });
  await new Promise(r => setTimeout(r, 300)); assert.equal(await nDesigns(), before); pass('privacy: no scan saved after "stop recording"');
  argos.onPublished({ type: 'call', state: 'live' }); argos.onPublished({ type: 'consent', state: 'declined' }); argos.onPublished({ type: 'scan', spec: scanSpec });
  await new Promise(r => setTimeout(r, 300)); assert.equal(await nDesigns(), before); pass('privacy: no scan saved after a decline');
  argos.onPublished({ type: 'call', state: 'live' }); argos.onPublished({ type: 'scan', spec: scanSpec });
  await new Promise(r => setTimeout(r, 300)); assert.equal(await nDesigns(), before + 1); pass('privacy: a new call saves scans again');
  const { pruneCallScans } = await import('../argos/forge.mjs');
  const gone = await pruneCallScans({ days: 7, now: Date.now() + 8 * 86_400_000 });
  const left = (await (await fetch(`${base}/argos/designs`)).json()).designs;
  assert.ok(gone.length >= 2 && left.every(d => d.source !== 'call') && left.some(d => d.kind === 'refined')); pass(`privacy: call scans deleted after 7 days (${gone.length}), refinements and imports kept`);

  // designs list
  r = await fetch(`${base}/argos/designs`); const list = (await r.json()).designs;
  assert.ok(list.length >= 3 && list[0].at >= list.at(-1).at); pass(`Forge lists ${list.length} designs, newest first`);
  console.log(`\n${ok} Argos tests passed`);
} finally {
  await live.close(); model.close(); await rm(dir, { recursive: true, force: true });
}
process.exit(0);
