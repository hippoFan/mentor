// End-to-end test of the backup demo on a TEST hub (never the live 8789/8790, never logs/hub.token):
//   node test/backup-e2e.mjs [--speed 4] [--shots ~/.playwright-mcp]
// 1. a test hub (publish :8796, the real app page via live.mjs on :8797) + headless Chrome on http://localhost:8797/
// 2. replay.mjs plays demo-data/backup-call.jsonl; event arrival times are checked against the schedule; three
//    screenshots: backup-1-phone.png, backup-2-board.png, backup-3-circuit.png
// 3. watchdog.mjs --arm 2 against simulated logs (temp dir): starts the backup by itself; a fake "Incoming" line stops it;
//    replay.mjs then refuses to start while that fake call is "live"
// 4. record.mjs records a small fake call from the test hub; replay.mjs plays that recording back
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, appendFile, readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SPEED = Number(opt('--speed', 4));
const SHOTS = resolve(opt('--shots', join(homedir(), '.playwright-mcp')));
const HUB = Number(opt('--hub-port', 8796)), PAGE = Number(opt('--page-port', 8797)), DBG = Number(opt('--dbg-port', 8799));   // other mocks may hold one: pick free ones
const CHROME = process.env.MENTOR_CHROME || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const HERE = fileURLToPath(new URL('..', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, fn) => { try { const d = fn(); pass++; console.log(`ok    ${name}${d ? `: ${d}` : ''}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

// ---------- the test hub: same shape as hub.mjs, its own token, its own ports ----------
const tmp = await mkdtemp(join(tmpdir(), 'ody-backup-e2e-'));
const token = 'test-' + Math.random().toString(36).slice(2);
await writeFile(join(tmp, 'hub.token'), token + '\n', { mode: 0o600 });
const chertLog = join(tmp, 'chert-dev.log');
await writeFile(chertLog, '✓ Connected to Chert.\n✓ "mentor-test" is in a waiting room. Call your line on FaceTime to talk to it.\n');
await writeFile(join(tmp, 'agent.log'), '{"level":30,"msg":"registered worker"}\n[mentor] brain: gemini\n');
process.env.MENTOR_MONITOR_PORT = String(PAGE);
const { createLiveServer } = await import('../live.mjs');
const live = await createLiveServer();
const pubServer = createServer((q, s) => s.writeHead(404).end());
const pub = new WebSocketServer({ server: pubServer, path: '/publish', maxPayload: 4 * 1024 * 1024,
  verifyClient: ({ req }) => req.headers['x-ody-token'] === token && !req.headers.origin });
pub.on('connection', ws => { ws.on('message', d => { try { live.send(JSON.parse(String(d))); } catch { /* junk */ } }); ws.on('close', () => live.send({ type: 'call', state: 'ended' })); });
await new Promise(r => pubServer.listen(HUB, '127.0.0.1', r));

// a page-like listener: what arrives, when
const seen = [];
const mon = new WebSocket(`ws://127.0.0.1:${PAGE}`, { origin: `http://localhost:${PAGE}` });
mon.on('message', d => { const e = JSON.parse(String(d)); seen.push({ at: Date.now(), e }); });
await new Promise(r => mon.once('open', r));
const waitFor = async (pred, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const x = seen.find(pred); if (x) return x; await sleep(100); } return null; };

// ---------- headless Chrome on the app ----------
const profile = await mkdtemp(join(tmpdir(), 'ody-backup-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let cdp, evalJs, shot;
const children = [];
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(r => ws.once('open', r));
  let id = 0; const wait = new Map(); const errors = [];
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || 'error'); });
  cdp = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  evalJs = async expr => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  shot = async name => { const s = await cdp('Page.captureScreenshot', { format: 'png' }); const p = join(SHOTS, name); await writeFile(p, Buffer.from(s.result.data, 'base64')); return p; };
  await mkdir(SHOTS, { recursive: true });
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://localhost:${PAGE}/` });
  for (let i = 0; i < 40 && !(await evalJs("document.getElementById('status')?.textContent || ''")); i++) await sleep(250);
  await sleep(1500);

  // ---------- 2. replay the backup into the test hub ----------
  const { runReplay, schedule, loadSession, BACKUP } = await import('../replay.mjs');
  const session = await loadSession(BACKUP);
  const t0 = Date.now();
  const rep = runReplay({ file: BACKUP, hubPort: HUB, tokenFile: join(tmp, 'hub.token'), chertLog, speed: SPEED, log: () => {} });
  const at = s => t0 + (s * 1000) / SPEED;
  const shots = [[57, 'backup-1-phone.png'], [88, 'backup-2-board.png'], [126, 'backup-3-circuit.png']];
  const texts = [];
  for (const [s, name] of shots) {
    await sleep(Math.max(0, at(s) - Date.now()));
    texts.push(await evalJs('document.body.innerText'));
    console.log(`      screenshot ${await shot(name)}`);
  }
  const why = await rep.done;
  const plan = schedule(session.lines, { speed: SPEED, now: 0 });
  check('replay: finished on its own', () => { assert.equal(why, 'done'); return `${((Date.now() - t0) / 1000).toFixed(1)} s at ${SPEED}x`; });
  const got = seen.filter(x => x.at >= t0 && x.e.type !== 'hello');
  check('replay: the first event is the honest replay call, then the replay line', () => {
    assert.deepEqual({ ...got[0].e, since: 0 }, { type: 'call', state: 'live', since: 0, replay: true, label: 'Replay of a real Ody call' });
    assert.deepEqual(got[1].e, { type: 'step', text: 'Replay of a real Ody call' });
  });
  check('replay: every event arrived, in order, on time', () => {
    assert.ok(got.length >= plan.length, `${got.length} of ${plan.length}`);   // (+ the hub's own "ended" when the publisher leaves)
    let worst = 0;
    for (const [i, p] of plan.entries()) { assert.equal(got[i].e.type, p.ev.type, `event ${i}`); worst = Math.max(worst, Math.abs(got[i].at - got[0].at - p.at)); }
    assert.ok(worst < 400, `worst drift ${worst} ms`);
    return `${plan.length} events, worst drift ${worst} ms`;
  });
  check('page: shows the replay line and the call content', () => {
    assert.match(texts[0], /Replay of a real Ody call/);
    assert.match(texts.join('\n'), /Arduino UNO R4 WiFi/);
    assert.match(texts[2], /distance sensor/i);
    assert.doesNotMatch(texts[1], /Simulated/, 'real part is not labelled simulated');
    assert.match(texts[2], /Simulated/, 'circuit part labelled simulated');
  });
  check('replay: badge switches to simulated before the circuit build', () => {
    const i = got.findIndex(x => x.e.label === 'Simulated: circuit builder demo'), c = got.findIndex(x => x.e.type === 'circuit');
    assert.ok(i > 1 && i < c, `label at ${i}, first circuit at ${c}`);
    assert.equal(got[i].e.since, got[0].e.since, 'same call: the page does not reset');
    assert.equal(got[i + 1].e.text, 'Demo of the circuit builder (simulated, not from the call)');
  });
  check('page: no script errors', () => { assert.deepEqual(errors, []); });

  // ---------- 3. watchdog: armed, simulated logs ----------
  seen.length = 0;
  const wd = spawn(process.execPath, [join(HERE, 'watchdog.mjs'), '--arm', '2', '--logs', tmp, '--hub-port', String(HUB), '--page-port', String(PAGE),
    '--replay-speed', '4', '--no-restart', '--ignore-chert-process'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(wd);
  let wdOut = ''; wd.stdout.on('data', d => { wdOut += d; }); wd.stderr.on('data', d => { wdOut += d; });
  const started = await waitFor(x => x.e.type === 'call' && x.e.state === 'live' && x.e.replay, 10_000);
  check('watchdog: no call within 2 s -> starts the backup by itself', () => { assert.ok(started, wdOut); assert.match(wdOut, /BACKUP DEMO RUNNING \(no call within 2 s\)/); });
  await sleep(2000);
  const tIncoming = Date.now();
  await appendFile(chertLog, '  13:00:00  Incoming FaceTime Video call.\n');
  const ended = await waitFor(x => x.at >= tIncoming && x.e.type === 'call' && x.e.state === 'ended', 5000);
  await sleep(2500);
  check('watchdog: a real incoming call stops the replay at once', () => { assert.ok(ended, 'no call ended'); assert.match(wdOut, /a real call came in/); return `${ended.at - tIncoming} ms`; });
  check('watchdog: does not restart the backup over the "live" call', () => {
    assert.equal(seen.filter(x => x.at > ended.at && x.e.type === 'call' && x.e.state === 'live').length, 0);
  });
  wd.kill('SIGTERM');
  const refused = await new Promise(r => { const c = spawn(process.execPath, [join(HERE, 'replay.mjs'), 'backup', '--hub-port', String(HUB), '--token-file', join(tmp, 'hub.token'), '--chert-log', chertLog], { stdio: 'ignore' }); c.on('exit', r); });
  check('replay CLI: refuses while a real call is live', () => { assert.equal(refused, 4); });
  await appendFile(chertLog, '  13:01:00  Call ended.\n');

  // ---------- 4. record a (fake, non-replay) call, then replay the recording ----------
  const { runRecorder } = await import('../record.mjs');
  const sessDir = join(tmp, 'sessions');
  const rec = runRecorder({ port: PAGE, dir: sessDir, fps: 1, log: () => {} });
  await sleep(800);
  const p = new WebSocket(`ws://127.0.0.1:${HUB}/publish`, { headers: { 'x-ody-token': token } });
  await new Promise(r => p.once('open', r));
  const send = e => p.send(JSON.stringify(e));
  send({ type: 'call', state: 'live', since: Date.now() }); send({ type: 'say', text: 'Hi, I am Ody.' });
  for (let i = 0; i < 12; i++) { send({ type: 'input', jpeg: 'QUJD', w: 4, h: 4 }); await sleep(250); }   // 4 fps in -> <= 1 fps recorded
  send({ type: 'heard', text: 'Scan this.' }); await sleep(300);
  send({ type: 'call', state: 'ended' }); await sleep(500); p.close(); await sleep(300); rec.stop();
  const files = (await readdir(sessDir)).filter(f => f.endsWith('.jsonl'));
  const recorded = files.length ? await loadSession(join(sessDir, files[0])) : { lines: [] };
  check('record: one session file, video capped to 1 fps', () => {
    assert.equal(files.length, 1, files.join(','));
    const n = recorded.lines.filter(l => l.ev.type === 'input').length;
    assert.ok(n >= 2 && n <= 4, `${n} inputs kept of 12`);
    assert.deepEqual(recorded.lines.map(l => l.ev.type).filter(t => t !== 'input'), ['call', 'say', 'heard', 'call']);
    return files[0];
  });
  seen.length = 0;
  const back = await runReplay({ file: join(sessDir, files[0]), hubPort: HUB, tokenFile: join(tmp, 'hub.token'), chertLog, speed: 4, log: () => {} }).done;
  check('replay: plays a recorded session back', () => {
    assert.equal(back, 'done');
    assert.ok(seen.some(x => x.e.type === 'heard' && x.e.text === 'Scan this.'));
    assert.ok(seen.some(x => x.e.type === 'call' && x.e.replay && x.e.state === 'live'));
  });
  ws.close();
} catch (e) { fail++; console.log('FAIL  e2e crashed:', e.stack || e); }
finally {
  for (const c of children) try { c.kill('SIGKILL'); } catch { /* gone */ }
  chrome.kill(); mon.close(); await live.close(); pubServer.close();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
