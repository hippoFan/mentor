// Schematics on demand (argos/server.mjs): POST /argos/designs/<id>/schematic draws a design's circuit (tscircuit) and
// saves the files in that design's folder; GET serves them (fixed names, sanitised SVG, sandbox CSP); the same circuit
// again comes from the cache; no circuit -> 422; another site's Origin -> 403; one run at a time.
// Uses the real routes on the mock Forge server (test/mock-forge.mjs, ports 8798/8799) with a scratch design store.
// Free, no keys.   node test/schematic-route-test.mjs
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as C from '../circuit.mjs';
import { drawingsAvailable } from '../blueprint.mjs';
import { LAMP, startMockForge } from './mock-forge.mjs';

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { const d = await fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};
const { createServer } = await import('node:net');
const free = p => new Promise(ok => { const s = createServer().once('error', () => ok(false)).listen(p, '127.0.0.1', () => s.close(() => ok(true))); });
const PORT = (await free(8799)) ? 8799 : (await free(8798)) ? 8798 : 0;
if (!PORT) { console.error('ports 8798 and 8799 are busy'); process.exit(2); }

const mock = await startMockForge({ port: PORT });
const post = (id, origin = mock.base) => fetch(`${mock.base}/argos/designs/${id}/schematic`, { method: 'POST', headers: origin ? { origin } : {} });
const build = utterances => { let st = C.createProject({ board: 'arduino-uno' }); for (const u of utterances) st = C.apply(st, C.fastPlan(st, u).actions).state; return st; };
const drawings = await drawingsAvailable();
try {
  await test('no circuit yet: 422 with a plain message', async () => {
    const r = await post('circuit-live');
    assert.equal(r.status, 422); assert.equal((await r.json()).error, 'This design has no circuit to draw yet.');
  });

  await test('a scan design has no circuit: 422; an unknown design: 404', async () => {
    mock.argos.onPublished({ type: 'scan', spec: LAMP });
    let id = null;
    for (let i = 0; i < 40 && !id; i++) { await new Promise(r => setTimeout(r, 50)); id = (await (await fetch(`${mock.base}/argos/designs`)).json()).designs[0]?.id; }
    assert.ok(id, 'scan saved');
    assert.equal((await post(id)).status, 422);
    assert.equal((await post('2026-01-01-scan-deadbeef')).status, 404);
  });

  await test("another site's Origin is refused (403) before anything runs", async () => {
    mock.argos.onPublished(C.circuitEvent(build(['add a distance sensor']), {}));
    assert.equal((await post('circuit-live', 'http://evil.example')).status, 403);
  });

  const st = build(['add a distance sensor', 'add an LED']);
  mock.argos.onPublished(C.circuitEvent(st, {}));
  let first = null;
  await test('the call circuit draws: urls, netlist, traces; files saved in fixed names', async () => {
    const r = await post('circuit-live'), b = await r.json();
    if (!drawings) { assert.equal(r.status, 503); assert.match(b.error, /optional drawing library/); assert.ok(b.netlist.length); return 'skipped drawings: tscircuit not installed (503 + netlist checked)'; }
    assert.equal(r.status, 200, b.error);
    first = b;
    assert.equal(b.schematicUrl, '/argos/designs/circuit-live/schematic/schematic.svg');
    assert.equal(b.pcbUrl, '/argos/designs/circuit-live/schematic/pcb.svg');
    assert.ok(b.kicad.sch && b.kicad.pcb && b.kicad.pro && b.netlistUrl);
    assert.ok(b.netlist.some(n => n.name === 'GND')); assert.ok(b.traces >= 5, `${b.traces} traces`);
    assert.ok(existsSync(join(mock.dir, '_circuit-live', 'schematic.svg')));
    return `${b.traces} traces in ${b.ms} ms`;
  });

  await test('GET serves the files: SVG with sandbox CSP and nosniff, KiCad as text, ?download as attachment', async () => {
    if (!first) return 'skipped (no drawings)';
    const svg = await fetch(mock.base + first.schematicUrl);
    assert.equal(svg.status, 200); assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    assert.match(svg.headers.get('content-security-policy'), /sandbox/); assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
    const body = await svg.text(); assert.match(body, /^<svg/); assert.ok(!/<script|\son[a-z]+=/i.test(body));
    const sch = await fetch(`${mock.base}${first.kicad.sch}?download`);
    assert.match(sch.headers.get('content-disposition'), /^attachment; filename="ody-circuit.kicad_sch"/); assert.match(await sch.text(), /^\(kicad_sch/);
    assert.equal((await fetch(`${mock.base}/argos/designs/circuit-live/schematic/meta.json`)).status, 404, 'only fixed names');
    assert.equal((await fetch(`${mock.base}/argos/designs/circuit-live/schematic/schematic.json`)).status, 404, 'the cache info is not served');
  });

  await test('the same circuit again comes from the cache at once; a changed circuit redraws', async () => {
    if (!first) return 'skipped (no drawings)';
    const t0 = Date.now(), again = await (await post('circuit-live')).json();
    assert.equal(again.cached, true); assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms`);
    mock.argos.onPublished(C.circuitEvent({ ...st, done: ['x'], rev: st.rev + 1 }, {}));   // progress only: still cached
    assert.equal((await (await post('circuit-live')).json()).cached, true);
    mock.argos.onPublished(C.circuitEvent(build(['add a distance sensor', 'add an LED', 'add a button']), {}));
    const fresh = await (await post('circuit-live')).json();
    assert.ok(!fresh.cached); assert.ok(fresh.netlist.some(n => n.nodes.some(x => x.ref.startsWith('btn'))));
  });

  await test('one run at a time: two requests at once route once; the second waits and gets the saved result', async () => {
    if (!first) return 'skipped (no drawings)';
    mock.argos.onPublished(C.circuitEvent(build(['add a servo', 'add an LED']), {}));
    const rs = await Promise.all([post('circuit-live'), post('circuit-live')]);
    const bodies = await Promise.all(rs.map(r => r.json()));
    const routed = rs.filter((r, i) => r.status === 200 && !bodies[i].cached).length;
    assert.equal(routed, 1, JSON.stringify(rs.map((r, i) => [r.status, bodies[i].cached])));
    assert.ok(rs.every(r => r.status === 200)); assert.equal(bodies.filter(b => b.cached).length, 1);
    return rs.map((r, i) => `${r.status}${bodies[i].cached ? ' cached' : ''}`).join(', ');
  });
} finally { await mock.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
