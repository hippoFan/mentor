// Records every call the laptop page sees, so each rehearsal becomes a reusable demo (replay.mjs plays it back).
//   node record.mjs [--port 8790] [--dir ../logs/sessions] [--fps 1]
// Connects to the laptop page's WebSocket exactly like the page does (ws://127.0.0.1:<port>, Origin http://localhost:<port>)
// and writes one file per call: logs/sessions/<YYYY-MM-DD-HHMMSS>.jsonl (logs/ is gitignored). Format (same as
// demo-data/backup-call.jsonl): line 1 {"meta": {...}}, then {"t": <ms since the call went live>, "ev": <event>}.
// Video ('frame' = the caller's phone view, 'input' = what Ody saw) is capped at --fps each (default 1, max 2), and
// oversized frames are skipped, so a 5-minute call stays ~20-40 MB. Replays (call.replay) are never recorded.
// Started by demo.sh. It holds one of the page server's 4 WebSocket slots.
import { mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import WebSocket from 'ws';

const VIDEO = new Set(['frame', 'input']);
const MAX_JPEG_B64 = 600_000;   // ~450 KB: anything bigger is not a normal frame

/** Pure recorder state machine (tested without sockets). push(event, now) -> lines to append, with the file they go to. */
export function createRecorder({ fps = 1, name = d => stamp(d) } = {}) {
  const gap = 1000 / Math.min(2, Math.max(0.1, fps));
  let file = null, t0 = 0, skipping = false, since = 0;
  const lastVideo = {};
  const stats = { written: 0, dropped: 0 };
  return {
    stats,
    get file() { return file; },
    /** @returns {{file: string, lines: string[]} | null} */
    push(ev, now = Date.now()) {
      if (!ev || typeof ev.type !== 'string') return null;
      if (ev.type === 'hello') {   // connected mid-call: start a session from here (the page state before is lost)
        if (ev.call?.state === 'live' && !ev.call.replay && !file) return start({ ...ev.call }, now, true);
        return null;
      }
      if (ev.type === 'call') {
        if (ev.state === 'live') {
          if (ev.replay) { skipping = true; file = null; return null; }
          skipping = false;
          if (file && ev.since && ev.since === since) return line(ev, now);   // same call re-announced
          return start(ev, now, false);
        }
        if (skipping) { skipping = false; return null; }
        if (!file) return null;
        const out = line(ev, now); file = null; return out;
      }
      if (!file || skipping) return null;
      if (VIDEO.has(ev.type)) {
        if (typeof ev.jpeg !== 'string' || ev.jpeg.length > MAX_JPEG_B64) { stats.dropped++; return null; }
        if (now - (lastVideo[ev.type] || 0) < gap) { stats.dropped++; return null; }
        lastVideo[ev.type] = now;
      }
      return line(ev, now);
    },
  };
  function start(callEv, now, partial) {
    file = name(new Date(now)); t0 = now; since = callEv.since || 0; for (const k in lastVideo) delete lastVideo[k];
    stats.written = 0; stats.dropped = 0;
    const meta = { kind: 'ody-session', version: 1, label: 'Recorded Ody call', recorded: new Date(now).toISOString(), ...(partial ? { partial: true } : {}) };
    const first = JSON.stringify({ t: 0, ev: { ...callEv, type: 'call', state: 'live' } });
    stats.written++;
    return { file, lines: [JSON.stringify({ meta }), first] };
  }
  function line(ev, now) { stats.written++; return { file, lines: [JSON.stringify({ t: now - t0, ev })] }; }
}

export function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jsonl`;
}

/** Connects (and reconnects) to the page server and appends to dir/<file>. @returns {{stop: () => void}} */
export function runRecorder({ port = 8790, dir, fps = 1, log = console.log } = {}) {
  const rec = createRecorder({ fps });
  let ws = null, stopped = false, delay = 1000, queue = Promise.resolve();
  const write = out => { queue = queue.then(() => appendFile(resolve(dir, out.file), out.lines.join('\n') + '\n')).catch(e => log(`[record] write failed: ${e.message}`)); };
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `http://localhost:${port}`, headers: { host: `localhost:${port}` } });
    ws.on('open', () => { delay = 1000; log(`[record] listening to the laptop page on :${port}; sessions go to ${dir}`); });
    ws.on('message', data => {
      let ev; try { ev = JSON.parse(String(data)); } catch { return; }
      const was = rec.file;
      const out = rec.push(ev);
      if (out) {
        if (out.file !== was) log(`[record] call live: recording ${out.file}`);
        write(out);
        if (ev.type === 'call' && ev.state !== 'live') log(`[record] call ended: ${out.file} (${rec.stats.written} events, ${rec.stats.dropped} video frames skipped)`);
      }
    });
    ws.on('close', () => { if (!stopped) setTimeout(connect, delay); delay = Math.min(delay * 2, 10_000); });
    ws.on('error', () => {});
  };
  mkdir(dir, { recursive: true }).then(connect);
  return { stop() { stopped = true; try { ws?.close(); } catch { /* gone */ } }, recorder: rec };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const port = Number(opt('--port', process.env.MENTOR_MONITOR_PORT || 8790));
  const dir = resolve(opt('--dir', fileURLToPath(new URL('../logs/sessions/', import.meta.url))));
  const r = runRecorder({ port, dir, fps: Number(opt('--fps', 1)) });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { r.stop(); setTimeout(() => process.exit(0), 200); });
}
