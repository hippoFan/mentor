// Page -> agent channel (live.mjs) + build-combo analysis (combo.mjs), free and without keys:
// validator, rate limit, analysis sanitiser and cache, then an e2e on the mock port 8798: a fake page (Origin-checked
// WebSocket) sends 'parts' and 'analyze' through createLiveServer, a fake brain answers, and the page gets {type:'analysis'}.
// Also: wrong-Origin sockets are refused, junk / oversized / flooding messages never reach the agent, /privacy is served.
//   node test/page-channel-test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import WebSocket from 'ws';

// Mocks only on 8796-8799 (8798 preferred); never the live 8790 / hub 8789. Another mock may hold one: take a free one.
const { createServer } = await import('node:net');
const free = p => new Promise(ok => { const s = createServer().once('error', () => ok(false)).listen(p, '127.0.0.1', () => s.close(() => ok(true))); });
let PORT = 0;
for (const p of [Number(process.env.MOCK_PORT) || 8798, 8799, 8797, 8796]) if (p >= 8796 && p <= 8799 && await free(p)) { PORT = p; break; }
if (!PORT) { console.error('ports 8796-8799 are all busy; stop a mock and re-run'); process.exit(2); }
process.env.MENTOR_MONITOR_PORT = String(PORT);
// A fake hub for startLive()'s client path, on another free mock port (never the real hub on 8789).
let HUB = 0;
for (const p of [8799, 8797, 8796, 8798]) if (p !== PORT && await free(p)) { HUB = p; break; }
if (HUB) process.env.MENTOR_HUB_PORT = String(HUB);
const { PAGE, startLive, createLiveServer, createPageRateLimiter, renderPrivacy, validatePageMessage } = await import('../live.mjs');
const { analysisPrompt, comboKey, createAnalyzer, partFact, sanitizeAnalysis } = await import('../combo.mjs');

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R4 = [{ id: 'mcu', name: 'RA4M1 microcontroller' }, { id: 'esp', name: 'ESP32-S3 module' }, { id: 'usb', name: 'USB-C port' }, { id: 'jack', name: 'Barrel jack' }];

await test('validator: good messages pass, cleaned', () => {
  const p = validatePageMessage(JSON.stringify({ type: 'parts', scope: 'board', board: 'Arduino UNO R4 WiFi', parts: R4, extra: 'dropped' }));
  assert.deepEqual(p, { type: 'parts', scope: 'board', board: 'Arduino UNO R4 WiFi', parts: R4 });
  const a = validatePageMessage(Buffer.from(JSON.stringify({ type: 'analyze', scope: 'scan', board: 'Phone', kept: [{ id: 1, name: 'Battery\u0000\u202e x' }], removed: [{ name: 'Display' }] })));
  assert.deepEqual(a, { type: 'analyze', scope: 'scan', board: 'Phone', kept: [{ id: '1', name: 'Battery x' }], removed: [{ id: 'Display', name: 'Display' }] });
  const long = validatePageMessage({ type: 'parts', scope: 'circuit', board: 'b', parts: [{ id: 'x'.repeat(200), name: `${'n'.repeat(100)}<script>` }] });
  assert.equal(long.parts[0].name.length, PAGE.nameLen); assert.equal(long.parts[0].id.length, PAGE.idLen);
  assert.ok(!/[<>]/.test(validatePageMessage({ type: 'parts', scope: 'board', parts: [{ name: '<img src=x onerror=1>' }] }).parts[0].name));
});

await test('validator: bad messages are dropped', () => {
  const bad = [
    'not json', '[]', 'null', JSON.stringify({ type: 'twin', scope: 'board', action: 'explode' }),
    JSON.stringify({ type: 'parts', scope: 'kitchen', parts: [] }), JSON.stringify({ type: 'parts', scope: 'board' }),
    JSON.stringify({ type: 'parts', scope: 'board', parts: 'esp' }), JSON.stringify({ type: 'parts', scope: 'board', parts: [null] }),
    JSON.stringify({ type: 'parts', scope: 'board', board: { x: 1 }, parts: [] }),
    JSON.stringify({ type: 'parts', scope: 'board', parts: Array.from({ length: 201 }, (_, i) => ({ id: `${i}`, name: 'p' })) }),
    JSON.stringify({ type: 'analyze', scope: 'board', kept: [] }), JSON.stringify({ type: 'analyze', scope: 'board', kept: [], removed: [] }),
    JSON.stringify({ type: 'analyze', scope: 'board', kept: Array(150).fill({ name: 'a' }), removed: Array(60).fill({ name: 'b' }) }),
    JSON.stringify({ type: 'analyze', scope: 'board', kept: [{ name: 'a' }], removed: [['b']] }),
    'x'.repeat(PAGE.maxPayload + 1),
  ];
  for (const b of bad) assert.equal(validatePageMessage(b), null, String(b).slice(0, 60));
});

await test('rate limit: analyze <= 1 per 5 s, parts <= 4 per second', () => {
  const r = createPageRateLimiter();
  assert.ok(r.allow('analyze', 1000)); assert.ok(!r.allow('analyze', 5999)); assert.ok(r.allow('analyze', 6000));
  assert.deepEqual([0, 100, 200, 300, 400].map(t => r.allow('parts', t)), [true, true, true, true, false]);
  assert.ok(r.allow('parts', 1001)); assert.ok(!r.allow('twin', 0));
});

await test('analysis sanitiser + facts + cache key', () => {
  const s = sanitizeAnalysis({ title: '<b>Plain UNO R4</b> https://evil.example', works: 'yes', summary: 'Works.\u0000 See www.x.com', pros: ['a', '', 'b', 'c', 'd', 'e'], cons: 'nope', needs: [1, 2], verdict: 'ok' });
  assert.equal(s.works, false);   // only a real boolean true counts
  assert.ok(!/[<>]|https?:|www\./.test(s.title + s.summary)); assert.equal(s.pros.length, 4); assert.deepEqual(s.cons, []); assert.deepEqual(s.needs, ['1', '2']);
  const d = sanitizeAnalysis(null);
  assert.equal(d.works, false); assert.ok(d.summary && d.title);
  assert.match(partFact('ESP32-S3 module'), /Wi-Fi/); assert.match(partFact('RA4M1 microcontroller'), /Cortex-M4/); assert.match(partFact('Battery'), /power/);
  assert.equal(partFact('Mystery blob'), '');
  assert.equal(comboKey({ scope: 'board', board: 'UNO', kept: [{ name: 'B' }, { name: 'A' }], removed: [] }), comboKey({ scope: 'board', board: 'uno', kept: [{ name: 'A' }, { name: 'B' }], removed: [] }));
  const prompt = analysisPrompt({ scope: 'board', board: 'Arduino UNO R4 WiFi', kept: R4.filter(p => p.id !== 'esp'), removed: [R4[1]] });
  assert.match(prompt, /Removed parts:\n- ESP32-S3 module: ESP32-S3 co-processor/);
});

await test('analyzer: one call per identical combination (cache + in-flight share)', async () => {
  let calls = 0;
  const call = async () => { calls++; await sleep(20); return { data: { title: 'Plain UNO R4', works: true, summary: 'Works as an UNO R4 Minima.', pros: [], cons: [], needs: [], verdict: 'v' }, model: 'fake' }; };
  const an = createAnalyzer({ brain: {}, call });
  const msg = { scope: 'board', board: 'Arduino UNO R4 WiFi', kept: R4.slice(0, 1), removed: R4.slice(1, 2) };
  const [a, b] = await Promise.all([an.analyze(msg), an.analyze({ ...msg })]);
  assert.equal(calls, 1); assert.equal(a.title, 'Plain UNO R4'); assert.equal(b.title, 'Plain UNO R4');
  const c = await an.analyze(msg);
  assert.equal(calls, 1); assert.equal(c.cached, true); assert.ok(an.cached(msg));
});

await test('privacy page is escaped', () => {
  const h = renderPrivacy('# T <script>alert(1)</script>\n- **b** <img src=x>\n| a | b |\n|---|---|\n| `c` | <i> |');
  assert.ok(!/<script|<img|<i>/.test(h)); assert.match(h, /<strong>b<\/strong>/); assert.match(h, /<code>c<\/code>/);
});

// ---------- e2e through the real server ----------
await test(`e2e on :${PORT}: page parts + analyze -> agent -> analysis back to the page`, async () => {
  const got = [];
  let analyzer = null, live = null;
  live = await createLiveServer({ onPageMessage: async m => {
    got.push(m);
    if (m.type !== 'analyze') return;
    const r = await analyzer.analyze(m);
    live.send({ type: 'analysis', id: 1, scope: m.scope, board: m.board, kept: m.kept, removed: m.removed, title: r.title, works: r.works, summary: r.summary, pros: r.pros, cons: r.cons, needs: r.needs, verdict: r.verdict });
  } });
  analyzer = createAnalyzer({ brain: {}, call: async (_b, { prompt }) => ({ data: { title: 'Plain UNO R4', works: !/^- RA4M1/m.test(prompt.split('Kept')[0]), summary: 'It works as a plain UNO R4 Minima, without Wi-Fi.', pros: ['Cheaper'], cons: ['No Wi-Fi or Bluetooth'], needs: ['Add the ESP32-S3 back for Wi-Fi'], verdict: 'Fine for offline projects.' }, model: 'fake' }) });
  try {
    // a foreign origin is refused at the handshake
    await assert.rejects(new Promise((ok, fail) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: 'http://evil.example' }); w.once('open', () => { w.close(); ok(); }); w.once('error', fail); w.once('unexpected-response', (_r, res) => fail(new Error(`HTTP ${res.statusCode}`))); }));
    const page = new WebSocket(`ws://localhost:${PORT}`, { origin: `http://localhost:${PORT}` });
    const inbox = [];
    page.on('message', d => inbox.push(JSON.parse(String(d))));
    await new Promise((ok, fail) => { page.once('open', ok); page.once('error', fail); });
    page.send(JSON.stringify({ type: 'parts', scope: 'board', board: 'Arduino UNO R4 WiFi', parts: R4 }));
    page.send('garbage'); page.send(JSON.stringify({ type: 'twin', action: 'explode' }));
    page.send(JSON.stringify({ type: 'analyze', scope: 'board', board: 'Arduino UNO R4 WiFi', kept: R4.filter(p => p.id !== 'esp'), removed: [R4[1]] }));
    page.send(JSON.stringify({ type: 'analyze', scope: 'board', board: 'Arduino UNO R4 WiFi', kept: R4.slice(1), removed: [R4[0]] }));   // inside 5 s: dropped
    for (let i = 0; i < 8; i++) page.send(JSON.stringify({ type: 'parts', scope: 'board', board: 'x', parts: [] }));   // flood: max 4/s
    for (let i = 0; i < 50 && !inbox.some(e => e.type === 'analysis'); i++) await sleep(50);
    const an = inbox.find(e => e.type === 'analysis');
    assert.ok(an, 'analysis came back to the page');
    assert.equal(an.works, true); assert.equal(an.title, 'Plain UNO R4'); assert.deepEqual(an.removed, [R4[1]]);
    assert.equal(got.filter(m => m.type === 'analyze').length, 1, 'second analyze within 5 s was rate limited');
    assert.equal(got.filter(m => m.type === 'parts').length, 4, 'parts limited to 4 per second');
    assert.ok(got.every(m => m.type === 'parts' || m.type === 'analyze'));
    // a page that connects later gets the last analysis in its hello
    const late = new WebSocket(`ws://localhost:${PORT}`, { origin: `http://localhost:${PORT}` });
    const hello = await new Promise((ok, fail) => { late.once('message', d => ok(JSON.parse(String(d)))); late.once('error', fail); });
    assert.equal(hello.analysis?.title, 'Plain UNO R4');
    late.close();
    // oversized frames close the socket (maxPayload 32 KB), the server keeps running
    page.send(JSON.stringify({ type: 'parts', scope: 'board', parts: [{ name: 'x'.repeat(40_000) }] }));
    await new Promise(r => { page.once('close', r); setTimeout(r, 1000); });
    // /privacy: the notice, escaped, with a strict CSP; a foreign Host is refused
    const res = await fetch(`http://localhost:${PORT}/privacy`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await res.text(), /<h1>Ody: privacy notice<\/h1>/);
    const foreign = await new Promise(ok => { import('node:http').then(({ request }) => request({ host: '127.0.0.1', port: PORT, path: '/privacy', headers: { host: 'evil.example' } }, r => ok(r.statusCode)).end()); });
    assert.equal(foreign, 403);
  } finally { await live.close(); }
});

if (HUB && existsSync(new URL('../../logs/hub.token', import.meta.url))) await test(`hub client path: startLive() surfaces forwarded page messages (fake hub on :${HUB})`, async () => {
  const { WebSocketServer } = await import('ws');
  const hub = new WebSocketServer({ host: '127.0.0.1', port: HUB, path: '/publish' });
  await new Promise(r => hub.once('listening', r));
  hub.on('connection', ws => setTimeout(() => {   // what hub.mjs does: forward the page's (validated) messages to the publishing call
    ws.send(JSON.stringify({ type: 'parts', scope: 'scan', board: 'Phone', parts: [{ id: 'b', name: 'Battery' }] }));
    ws.send(JSON.stringify({ type: 'say', text: 'not a page message' }));
  }, 150));
  try {
    const l = await startLive();
    const seen = [];
    l.onPage(m => seen.push(m));
    for (let i = 0; i < 40 && !seen.length; i++) await sleep(25);
    assert.deepEqual(seen, [{ type: 'parts', scope: 'scan', board: 'Phone', parts: [{ id: 'b', name: 'Battery' }] }]);
    await l.close();
  } finally { for (const c of hub.clients) c.terminate(); await new Promise(r => hub.close(r)); }
});

console.log(`${pass} page channel tests passed`);
