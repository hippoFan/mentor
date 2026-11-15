// Judging-day watchdog: a compact status board (every 2 s) and, armed, an automatic switch to the backup demo.
//   npm run watchdog                 status only
//   npm run watchdog -- --arm 60     presentation mode: starts the backup replay (replay.mjs) if no call comes in within
//                                    60 s, if the call ends or errors within 20 s, or if Chert is disconnected (>= 8 s)
// Keys: b = start the backup now, s = stop the replay, a = (re)arm, q = quit. It never starts a replay while a real call
// is live, and a real incoming call stops a running replay at once (replay.mjs watches the Chert log itself).
// Restarts: demo.sh supervises hub, agent and Chert; while it runs the watchdog only reports. Without demo.sh, a piece
// this watchdog saw running and then die is restarted when the line is idle (no call, no replay), at most every 30 s.
// Other options: --logs <dir> (default ../logs), --hub-port 8789, --page-port 8790, --no-restart, --once (print and exit),
//   --replay <file>, --replay-speed <x>  (tests)
import { readFile, readdir, stat, open } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// ---------- pure parsers (tested) ----------
/** Reads chert dev's output. @returns {{conn: string, call: 'live'|'idle', callAt: string, lastError: string}} */
export function parseChert(text) {
  const r = { conn: 'unknown', call: 'idle', callAt: '', lastError: '' };
  for (const line of text.split('\n')) {
    if (/Connected to Chert\.|Reconnected to Chert|is in a waiting room/.test(line)) r.conn = 'connected';
    else if (/Connection to Chert lost/.test(line)) r.conn = 'reconnecting';
    else if (/NOT in the waiting room/.test(line)) r.conn = 'agent-missing';
    else if (/gave up|could not connect|failed to connect|unauthori[sz]ed|invalid api key/i.test(line)) r.conn = 'down';
    const inc = line.match(/(\d{1,2}:\d{2}:\d{2})\s+Incoming FaceTime/);
    if (inc) { r.call = 'live'; r.callAt = inc[1]; }
    else if (/Call ended/.test(line)) r.call = 'idle';
    if (/is in a waiting room/.test(line)) r.lastError = '';   // recovered
    if (/^\s*✗/.test(line)) r.lastError = line.replace(/^\s*✗\s*/, '').trim();
  }
  return r;
}

/** Reads the agent log. @returns {{registered: boolean, brain: string, lastError: string, eleven: string, gemini: string}} */
export function parseAgent(text) {
  const r = { registered: false, brain: '', lastError: '', eleven: '', gemini: '' };
  for (const line of text.split('\n')) {
    if (/\[demo\] .*starting agent/.test(line)) r.registered = false;   // a fresh start: wait for it to register again
    if (/"msg":"registered worker"/.test(line)) r.registered = true;
    const b = line.match(/\[mentor\] brain: (\S+)/); if (b) r.brain = b[1];
    let msg = '';
    if (line.startsWith('{')) {
      try { const j = JSON.parse(line); if (j.level >= 50) msg = `${j.msg}${j.error?.message ? `: ${j.error.message}` : ''}`; } catch { /* not json */ }
    } else if (/\b(failed|error)\b/i.test(line) && /^\[/.test(line)) msg = line;
    if (msg) r.lastError = msg;
    const bad = /\b(error|fail(ed)?|401|403|429|quota|rate.?limit|exhausted|invalid)\b/i;
    if (/eleven|scribe|\btts\b|\bstt\b/i.test(line) && bad.test(line)) r.eleven = shortErr(line);
    if (/gemini/i.test(line) && (bad.test(line) || /falling back|fallback/i.test(line))) r.gemini = shortErr(line);
  }
  return r;
}
const shortErr = line => { try { const j = JSON.parse(line); return `${j.msg || ''} ${j.error?.message || ''}`.trim(); } catch { return line.trim(); } };

/**
 * Presentation mode. tick() gets what changed since the last tick and says whether to start the backup now. Pure.
 * @param {{armSecs: number, endWithin?: number, chertGrace?: number, now?: number}} o
 */
export function createArm({ armSecs, endWithin = 20, chertGrace = 8, now = Date.now() }) {
  const s = { armed: true, armedAt: now, incomingAt: 0, chertBadSince: 0, reason: '', fired: false };
  return {
    state: s,
    /** @param {{now: number, newChert: string, callLive: boolean, chertOk: boolean, replaying: boolean}} x @returns {string|null} reason to start */
    tick({ now, newChert = '', callLive = false, chertOk = true, replaying = false }) {
      if (!s.armed) return null;
      const fire = reason => { s.armed = false; s.fired = true; s.reason = reason; return reason; };
      if (/Incoming FaceTime/.test(newChert)) s.incomingAt = now;
      if (callLive && !s.incomingAt) s.incomingAt = now;   // armed while a call was already up
      const endedNow = /Call ended|Call declined|^\s*✗/m.test(newChert.slice(Math.max(0, newChert.lastIndexOf('Incoming FaceTime'))));
      chertOk ? (s.chertBadSince = 0) : (s.chertBadSince ||= now);
      if (replaying) return null;
      if (s.incomingAt) {
        const age = now - s.incomingAt;
        if (endedNow && !callLive && age <= endWithin * 1000) return fire(`the call ended within ${endWithin} s`);
        if (callLive && age > endWithin * 1000) { s.armed = false; s.reason = 'real call is up: disarmed'; return null; }
        if (callLive) return null;
        if (age > endWithin * 1000) { s.armed = false; s.reason = 'call over: disarmed'; return null; }
      }
      if (callLive) return null;   // never over a real call
      if (s.chertBadSince && now - s.chertBadSince >= chertGrace * 1000) return fire('Chert is disconnected');
      if (!s.incomingAt && now - s.armedAt >= armSecs * 1000) return fire(`no call within ${armSecs} s`);
      return null;
    },
  };
}

// ---------- probes ----------
const portUp = (port, host = '127.0.0.1') => new Promise(res => {
  const c = connect({ port, host }); const t = setTimeout(() => { c.destroy(); res(false); }, 600);
  c.once('connect', () => { clearTimeout(t); c.destroy(); res(true); });
  c.once('error', () => { clearTimeout(t); res(false); });
});
/** Every process's command line, from /proc (no exec). */
async function procs() {
  const out = [];
  for (const d of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    const cmd = await readFile(`/proc/${d}/cmdline`, 'utf8').catch(() => '');
    if (cmd) out.push({ pid: Number(d), argv: cmd.split('\0').filter(Boolean) });
  }
  return out;
}
const find = (ps, test) => ps.find(p => test(p.argv.join(' '), p.argv))?.pid || 0;
async function tail(file, max = 256 * 1024) {
  const s = await stat(file).catch(() => null); if (!s) return '';
  const fh = await open(file, 'r');
  try { const n = Math.min(s.size, max), b = Buffer.alloc(n); await fh.read(b, 0, n, s.size - n); return b.toString('utf8'); } finally { await fh.close(); }
}
/** New text appended to a file since the last call (handles truncation). */
function follower(file) {
  let off = -1;
  return async () => {
    const s = await stat(file).catch(() => null); if (!s) return '';
    if (off < 0) { off = s.size; return ''; }
    if (s.size < off) off = 0;
    if (s.size === off) return '';
    const fh = await open(file, 'r');
    try { const b = Buffer.alloc(Math.min(s.size - off, 1 << 20)); await fh.read(b, 0, b.length, off); off += b.length; return b.toString('utf8'); } finally { await fh.close(); }
  };
}

export async function probe({ logs, hubPort, pagePort }) {
  const [ps, hubPub, hubPage, chertText, agentText] = await Promise.all([procs(), portUp(hubPort), portUp(pagePort),
    tail(join(logs, 'chert-dev.log')), tail(join(logs, 'agent.log'))]);
  const arg = (a, name) => a.some(x => x === name || x.endsWith(`/${name}`));   // a real argv element, not text in a shell line
  const node = a => /(^|\/)node$/.test(a[0] || '');
  const pids = {
    demo: find(ps, (s, a) => /(^|\/)(ba|z)?sh$/.test(a[0] || '') && arg(a, 'demo.sh')),
    hub: find(ps, (s, a) => node(a) && arg(a, 'hub.mjs')),
    agent: find(ps, (s, a) => node(a) && arg(a, 'agent.mjs') && a.includes('start')),
    chert: find(ps, (s, a) => a.some(x => /(^|\/)chert$/.test(x)) && a.includes('dev')),
    record: find(ps, (s, a) => node(a) && arg(a, 'record.mjs')),
  };
  return { pids, hubPub, hubPage, chert: parseChert(chertText), agent: parseAgent(agentText) };
}

// ---------- the board ----------
const C = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` };
const cut = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const ok = (good, s) => (good ? C.g('● ') : C.r('● ')) + s;
const callSecs = at => {
  const m = at.match(/(\d+):(\d+):(\d+)/); if (!m) return 0;
  const d = new Date(); d.setHours(+m[1], +m[2], +m[3], 0);
  let s = Math.round((Date.now() - d) / 1000); if (s < 0) s += 86400; return s;
};
const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function render(st, { arm, replay, notes = [] } = {}) {
  const { pids, chert, agent } = st;
  const L = [];
  L.push(C.b('Ody watchdog') + C.d(`  ${new Date().toLocaleTimeString()}   keys: b backup now · s stop replay · a arm · q quit`));
  L.push(ok(st.hubPage && st.hubPub, `hub        page :${st.pagePort} ${st.hubPage ? 'up' : 'DOWN'} · publish :${st.hubPort} ${st.hubPub ? 'up' : 'DOWN'}${pids.hub ? ` · pid ${pids.hub}` : ''}`));
  L.push(ok(pids.agent && agent.registered, `agent      ${pids.agent ? `pid ${pids.agent}` : 'NOT RUNNING'} · worker ${agent.registered ? 'registered' : 'not registered'}`));
  const chOk = pids.chert && chert.conn === 'connected';
  L.push(ok(chOk, `chert      ${pids.chert ? `pid ${pids.chert}` : 'NOT RUNNING'} · ${chert.conn}`));
  const live = chert.call === 'live';
  L.push((live ? C.g('● ') : C.d('○ ')) + `call       ${live ? C.b(`LIVE ${mmss(callSecs(chert.callAt))}`) : 'idle'}`);
  L.push(C.d('  ') + `brain      ${agent.brain || '?'}${agent.brain === 'claude-code' ? C.y('  (owner testing only, not for judges)') : ''}`);
  L.push(C.d('  ') + `supervisor ${pids.demo ? 'demo.sh is running (it restarts pieces)' : C.y('demo.sh not running')} · recorder ${pids.record ? 'on' : C.y('off')}`);
  if (agent.lastError) L.push(C.y('  last error  ') + cut(agent.lastError));
  if (chert.lastError) L.push(C.y('  chert       ') + cut(chert.lastError));
  if (agent.eleven) L.push(C.y('  ElevenLabs  ') + cut(agent.eleven));
  if (agent.gemini) L.push(C.y('  Gemini      ') + cut(agent.gemini));
  if (arm?.state.armed) {
    const left = Math.max(0, Math.ceil((arm.state.armedAt + arm.armSecs * 1000 - Date.now()) / 1000));
    L.push(C.y(`ARMED: backup starts ${arm.state.incomingAt ? 'if the call ends within 20 s' : `in ${left} s unless a call comes in`} (or if Chert disconnects)`));
  } else if (arm?.state.reason) L.push(C.d(`arm: ${arm.state.reason}`));
  if (replay) L.push('', C.b(C.r('█████  BACKUP DEMO RUNNING: replay of a real Ody call  █████')), C.d('       s = stop · a real incoming call stops it automatically'));
  for (const n of notes.slice(-3)) L.push(C.d(n));
  return L.join('\n');
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const logs = resolve(opt('--logs', join(HERE, '../logs')));
  const hubPort = Number(opt('--hub-port', process.env.MENTOR_HUB_PORT || 8789));
  const pagePort = Number(opt('--page-port', process.env.MENTOR_MONITOR_PORT || 8790));
  const replayFile = opt('--replay', 'backup');
  const replaySpeed = opt('--replay-speed', '1');
  const armArg = args.includes('--arm') ? Number(opt('--arm', 60)) : 0;
  const restartOn = !args.includes('--no-restart');
  const ignoreProc = args.includes('--ignore-chert-process');   // tests: judge Chert by its log only
  const tty = process.stdout.isTTY;
  const notes = [];
  const note = s => { notes.push(`${new Date().toLocaleTimeString()} ${s}`); if (!tty) console.log(s); };

  if (args.includes('--once')) { const st = await probe({ logs, hubPort, pagePort }); console.log(render({ ...st, hubPort, pagePort })); return; }

  let arm = armArg ? Object.assign(createArm({ armSecs: armArg }), { armSecs: armArg }) : null;
  if (arm) note(`armed: backup in ${armArg} s unless a call comes in`);
  let child = null, last = null;
  const newChert = follower(join(logs, 'chert-dev.log'));

  const startBackup = why => {
    if (child) return;
    if (last?.chert.call === 'live') { note('a real call is live: not starting the backup'); return; }
    note(`BACKUP DEMO RUNNING (${why})`);
    child = spawn(process.execPath, [join(HERE, 'replay.mjs'), replayFile, '--speed', replaySpeed, '--hub-port', String(hubPort),
      '--token-file', join(logs, 'hub.token'), '--chert-log', join(logs, 'chert-dev.log')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const c = child;
    c.stdout.on('data', d => { for (const l of String(d).trim().split('\n')) note(l); });
    c.stderr.on('data', d => { for (const l of String(d).trim().split('\n')) note(l); });
    c.on('exit', code => { if (child === c) child = null; note(`replay finished (${code === 3 ? 'a real call came in' : code === 4 ? 'refused: real call live' : code ? `exit ${code}` : 'done'})`); draw(); });
  };
  const stopBackup = () => { if (child) { child.kill('SIGTERM'); note('stopping the replay'); } };

  // restarts: only pieces seen alive in this run, only without demo.sh, only when idle
  const seen = {}, deadSince = {}, lastRestart = {};
  const CMDS = {
    hub: { log: 'hub.log', cmd: [process.execPath, 'hub.mjs'] },
    agent: { log: 'agent.log', cmd: [process.execPath, '--env-file=../.env', 'agent.mjs', 'start'] },
  };
  const restarts = st => {
    if (!restartOn || st.pids.demo || st.chert.call === 'live' || child) return;
    for (const [k, how] of Object.entries(CMDS)) {
      if (st.pids[k]) { seen[k] = true; deadSince[k] = 0; continue; }
      if (!seen[k]) continue;
      deadSince[k] ||= Date.now();
      if (Date.now() - deadSince[k] < 10_000 || Date.now() - (lastRestart[k] || 0) < 30_000) continue;
      lastRestart[k] = Date.now();
      const fd = openSync(join(logs, how.log), 'a');
      spawn(how.cmd[0], how.cmd.slice(1), { cwd: HERE, detached: true, stdio: ['ignore', fd, fd] }).unref();
      note(`restarted ${k} (it had died; demo.sh is not running)`);
    }
    if (st.pids.chert) seen.chert = true; else if (seen.chert) note('chert dev died and demo.sh is not running: restart it with ./demo.sh');
  };

  let drawing = false;
  const draw = () => { if (tty && last) process.stdout.write('\x1b[H\x1b[2J' + render({ ...last, hubPort, pagePort }, { arm, replay: !!child, notes }) + '\n'); };
  const tick = async () => {
    if (drawing) return; drawing = true;
    try {
      last = await probe({ logs, hubPort, pagePort });
      const fresh = await newChert();
      if (arm) {
        const why = arm.tick({ now: Date.now(), newChert: fresh, callLive: last.chert.call === 'live', chertOk: (ignoreProc || !!last.pids.chert) && last.chert.conn === 'connected', replaying: !!child });
        if (why) startBackup(why);
      }
      restarts(last);
      draw();
    } finally { drawing = false; }
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', k => {
      if (k === 'q' || k === '\u0003') quit();
      else if (k === 'b') startBackup('started by hand');
      else if (k === 's') stopBackup();
      else if (k === 'a') { arm = Object.assign(createArm({ armSecs: armArg || 60 }), { armSecs: armArg || 60 }); note(`armed: backup in ${arm.armSecs} s unless a call comes in`); }
      draw();
    });
  }
  const quit = () => { stopBackup(); if (process.stdin.isTTY) process.stdin.setRawMode(false); setTimeout(() => process.exit(0), child ? 600 : 0); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, quit);
  await tick();
  setInterval(() => { tick().catch(e => note(`watchdog error: ${e.message}`)); }, 2000);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
