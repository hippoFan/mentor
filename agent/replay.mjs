// Plays a recorded Ody call into the always-on hub, so the laptop page shows a real session when a live call can't happen.
//   node replay.mjs [file.jsonl | backup] [--speed 1] [--from <s>] [--force]
//        default file: demo-data/backup-call.jsonl (built by build-backup.mjs); any logs/sessions/*.jsonl works too
//   test/dev options: --hub-port <p> (default MENTOR_HUB_PORT or 8789), --token-file <f>, --chert-log <f>
// Publishes exactly like a call does (live.mjs startLive: ws://127.0.0.1:<hub>/publish with the token in logs/hub.token).
// It FIRST sends {type:'call', state:'live', replay:true, label} so the page can badge it honestly, plus a step line
// "Replay of a real Ody call" that the current app already shows. Lines marked synth:true (the backup's circuit build)
// are announced first with label 'Simulated: circuit builder demo' and a step line saying so. Original timing (--speed scales it; --from skips ahead:
// the state before that point is sent at once, video only its last frame).
// Stops (sending call ended) on Ctrl-C, on SIGTERM, or the moment a real FaceTime call comes in ("Incoming" in
// logs/chert-dev.log). Refuses to start while a real call is live (the last of Incoming / Call ended is Incoming).
// Exit codes: 0 done or stopped, 3 a real call came in, 4 refused (real call live), 2 bad input / hub unreachable.
import { readFile, open, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import WebSocket from 'ws';

export const LABEL = 'Replay of a real Ody call';
export const SIM_LABEL = 'Simulated: circuit builder demo';
export const SIM_STEP = 'Demo of the circuit builder (simulated, not from the call)';
export const BACKUP = fileURLToPath(new URL('./demo-data/backup-call.jsonl', import.meta.url));
const LOGS = fileURLToPath(new URL('../logs/', import.meta.url));
const VIDEO = new Set(['frame', 'input']);

/** @returns {Promise<{meta: object, lines: {t: number, ev: object}[]}>} */
export async function loadSession(file) {
  const text = await readFile(file, 'utf8');
  let meta = {}; const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let o; try { o = JSON.parse(raw); } catch { continue; }
    if (o.meta) { meta = o.meta; continue; }
    if (o && Number.isFinite(o.t) && o.ev && typeof o.ev.type === 'string' && o.ev.type !== 'hello') lines.push({ t: o.t, ev: o.ev, ...(o.synth ? { synth: true } : {}) });
  }
  lines.sort((a, b) => a.t - b.t);
  return { meta, lines };
}

/**
 * What to send and when, relative to the replay's start. Pure.
 * @param {{t: number, ev: object}[]} lines @param {{speed?: number, from?: number, now?: number}} opts from in ms
 * @returns {{at: number, ev: object}[]}
 */
export function schedule(lines, { speed = 1, from = 0, now = Date.now() } = {}) {
  const sp = speed > 0 ? speed : 1;
  const out = [
    { at: 0, ev: { type: 'call', state: 'live', since: now, replay: true, label: LABEL } },
    { at: 0, ev: { type: 'step', text: LABEL } },
  ];
  const before = [], lastVideo = {};
  let greeted = false, simulated = false;
  const put = (t, e) => { if (t < from) before.push({ at: 0, ev: e }); else out.push({ at: Math.round((t - from) / sp), ev: e }); };
  for (const { t, ev, synth } of lines) {
    if (synth && !simulated) {   // honest badge: from here on it is not from the call (same since, so the page doesn't reset)
      simulated = true;
      put(t, { type: 'call', state: 'live', since: now, replay: true, label: SIM_LABEL });
      put(t, { type: 'step', text: SIM_STEP });
    }
    if (ev.type === 'call' && ev.state === 'live') continue;   // replaced by the replay's own live event above
    if (ev.type === 'step' && !greeted && /^show me your project$/i.test(String(ev.text || '').trim())) { greeted = true; continue; }   // keep the replay line up
    const e = ev.type === 'call' ? { type: 'call', state: ev.state, replay: true }
      : ev.type === 'scan' ? { ...ev, at: now + Math.max(0, t - from) / sp } : ev;
    if (t < from) {
      if (ev.type === 'call') continue;   // an end before the cut: ignore
      if (VIDEO.has(ev.type)) lastVideo[ev.type] = e; else before.push({ at: 0, ev: e });
    } else out.push({ at: Math.round((t - from) / sp), ev: e });
  }
  out.splice(2, 0, ...before, ...Object.values(lastVideo).map(ev => ({ at: 0, ev })));
  if (!out.some(x => x.ev.type === 'call' && x.ev.state !== 'live')) {
    const last = out.at(-1)?.at || 0;
    out.push({ at: last + 1500, ev: { type: 'call', state: 'ended', replay: true } });
  }
  return out;
}

/** The last call line in the Chert log: 'live' (Incoming after the last Call ended), 'idle', or 'unknown'. Pure. */
export function lastCallState(text) {
  const i = text.lastIndexOf('Incoming FaceTime'), e = text.lastIndexOf('Call ended');
  if (i < 0 && e < 0) return 'unknown';
  return i > e ? 'live' : 'idle';
}

/** Calls onIncoming once when new text in `file` (appended after now) says "Incoming". @returns {() => void} stop */
export function watchIncoming(file, onIncoming, { every = 250 } = {}) {
  let offset = -1, busy = false, done = false;
  const tick = async () => {
    if (busy || done) return; busy = true;
    try {
      const s = await stat(file).catch(() => null);
      if (!s) return;
      if (offset < 0) { offset = s.size; return; }
      if (s.size < offset) offset = 0;   // demo.sh truncated the log on restart
      if (s.size === offset) return;
      const fh = await open(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(s.size - offset, 1 << 20));
        await fh.read(buf, 0, buf.length, offset);
        offset += buf.length;
        if (/Incoming FaceTime/.test(buf.toString('utf8')) && !done) { done = true; onIncoming(); }
      } finally { await fh.close(); }
    } finally { busy = false; }
  };
  const timer = setInterval(() => { tick().catch(() => {}); }, every);
  tick().catch(() => {});
  return () => { done = true; clearInterval(timer); };
}

/**
 * Plays `file` into the hub. Resolves with why it stopped: 'done' | 'stopped' | 'incoming' | 'hub-closed'.
 * @returns {{done: Promise<string>, stop: () => void}}
 */
export function runReplay({ file = BACKUP, hubPort = Number(process.env.MENTOR_HUB_PORT || 8789), tokenFile = `${LOGS}hub.token`,
  chertLog = `${LOGS}chert-dev.log`, speed = 1, from = 0, log = console.log } = {}) {
  let stopFn = () => {};
  const done = (async () => {
    const { lines, meta } = await loadSession(file);
    if (!lines.length) throw new Error(`no events in ${file}`);
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const ws = await new Promise((res, rej) => {
      const c = new WebSocket(`ws://127.0.0.1:${hubPort}/publish`, { headers: { 'x-ody-token': token } });
      const t = setTimeout(() => { c.terminate(); rej(new Error('hub timeout')); }, 2000);
      c.once('open', () => { clearTimeout(t); res(c); });
      c.once('error', e => { clearTimeout(t); rej(e); });
    });
    ws.on('error', () => {});
    const send = ev => { if (ws.readyState === 1) ws.send(JSON.stringify(ev)); };
    const start = Date.now();
    const plan = schedule(lines, { speed, from: from * 1000, now: start });
    const total = plan.at(-1).at;
    log(`[replay] ${meta.label || 'session'} from ${file.split('/').pop()}: ${plan.length} events, ${(total / 1000).toFixed(0)} s at ${speed}x`);
    return await new Promise(res => {
      const timers = [];
      let finished = false;
      const finish = (why, sendEnd) => {
        if (finished) return; finished = true;
        for (const t of timers) clearTimeout(t);
        stopWatch();
        if (sendEnd) send({ type: 'call', state: 'ended', replay: true });
        setTimeout(() => { try { ws.close(); } catch { /* gone */ } res(why); }, 150);
      };
      const stopWatch = chertLog ? watchIncoming(chertLog, () => { log('[replay] a real call is coming in: stopping the replay'); finish('incoming', true); }) : () => {};
      stopFn = () => finish('stopped', true);
      ws.on('close', () => finish('hub-closed', false));
      for (const { at, ev } of plan) {
        timers.push(setTimeout(() => {
          send(ev);
          if (ev.type === 'call' && ev.state !== 'live') finish('done', false);
        }, Math.max(0, at - (Date.now() - start))));
      }
    });
  })();
  return { done, stop: () => stopFn() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const valued = new Set(['--speed', '--from', '--hub-port', '--token-file', '--chert-log']);
  const pos = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
  const file = !pos || pos === 'backup' ? BACKUP : resolve(pos);
  const chertLog = resolve(opt('--chert-log', `${LOGS}chert-dev.log`));
  const state = lastCallState(await readFile(chertLog, 'utf8').catch(() => ''));
  if (state === 'live' && !args.includes('--force')) {
    console.error('[replay] a real call is live (chert log: last line is "Incoming"). Not starting. --force to override.');
    process.exit(4);
  }
  const r = runReplay({ file, chertLog, speed: Number(opt('--speed', 1)), from: Number(opt('--from', 0)),
    hubPort: Number(opt('--hub-port', process.env.MENTOR_HUB_PORT || 8789)), tokenFile: resolve(opt('--token-file', `${LOGS}hub.token`)) });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { r.stop(); setTimeout(() => process.exit(0), 1500).unref(); });
  try {
    const why = await r.done;
    console.log(`[replay] ${why}`);
    process.exit(why === 'incoming' ? 3 : 0);
  } catch (e) { console.error(`[replay] ${e.message}`); process.exit(2); }
}
