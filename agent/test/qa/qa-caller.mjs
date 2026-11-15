// QA fake caller: streams a photo as the camera (static, so any change in Mentor's output is Ody's drawing),
// measures Mentor's video (size, fps, drawing-diff vs baseline), audio (dBFS), watches the laptop monitor websocket,
// and runs a scenario. Usage: SCEN=main|gemini QA_CMD=/path/cmd.txt AGENT_NAME=x PHOTO=.. OUT=dir node --env-file=../../../.env qa-caller.mjs
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import WebSocket from 'ws';
import { AudioStream, LocalVideoTrack, Room, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream } from '@livekit/rtc-node';

const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
const { AGENT_NAME: agentName, PHOTO, OUT, QA_CMD, SCEN = 'main', MON = '8794' } = process.env;
const host = url.replace(/^wss?:\/\//, 'https://');
const roomName = `ody-qa-${randomBytes(4).toString('hex')}`;
await mkdir(OUT, { recursive: true });
const T0 = Date.now(), now = () => ((Date.now() - T0) / 1000).toFixed(2);
const log = (...a) => { const l = `[qa ${now()}s] ${a.join(' ')}`; console.log(l); return appendFile(`${OUT}/caller.log`, l + '\n'); };
const cmd = async t => { await appendFile(QA_CMD, t + '\n'); log('CMD', t); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const img = await loadImage(await readFile(PHOTO));
const W = 1280, H = 720, cam = createCanvas(W, H), cg = cam.getContext('2d');
const s = Math.min(W / img.width, H / img.height);
cg.fillStyle = '#222'; cg.fillRect(0, 0, W, H); cg.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
const camPx = new Uint8Array(cg.getImageData(0, 0, W, H).data.buffer);

await new AgentDispatchClient(host, key, secret).createDispatch(roomName, agentName);
log('dispatched', agentName, roomName);
const at = new AccessToken(key, secret, { identity: 'chert-bridge-qa', ttl: '20m' });
at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
const room = new Room();
await room.connect(url, await at.toJwt(), { autoSubscribe: true, dynacast: false });

const src = new VideoSource(W, H);
let vtrack = LocalVideoTrack.createVideoTrack('facetime-remote-video', src), vpub = null;
const publish = async () => { vtrack = LocalVideoTrack.createVideoTrack('facetime-remote-video', src); vpub = await room.localParticipant.publishTrack(vtrack, { source: TrackSource.SOURCE_CAMERA }); };
await publish();
const pump = setInterval(() => src.captureFrame(new VideoFrame(camPx, W, H, VideoBufferType.RGBA)), 1000 / 15);

// ---- Mentor video: frame count, size, drawing diff (mean abs luma diff on a 36x64 grid vs baseline) ----
let got = 0, size = '', lastGrid = null, baseline = null, lastFrame = null, winCount = 0, winStart = Date.now();
const fpsSamples = [];
const grid = f => { const g = new Float32Array(36 * 64); for (let y = 0; y < 64; y++) for (let x = 0; x < 36; x++) { const i = ((Math.floor(y * f.height / 64)) * f.width + Math.floor(x * f.width / 36)) * 4; g[y * 36 + x] = f.data[i] * .3 + f.data[i + 1] * .59 + f.data[i + 2] * .11; } return g; };
const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
room.on(RoomEvent.TrackSubscribed, async (trk) => {
  if (trk.kind === TrackKind.KIND_VIDEO) {
    log('mentor video track', trk.name);
    for await (const ev of new VideoStream(trk)) {
      const f = ev.frame.convert(VideoBufferType.RGBA);
      got++; winCount++; size = `${f.width}x${f.height}`; lastFrame = f; lastGrid = grid(f);
      if (Date.now() - winStart >= 2000) { fpsSamples.push(+(winCount / ((Date.now() - winStart) / 1000)).toFixed(1)); winCount = 0; winStart = Date.now(); }
    }
  } else if (trk.kind === TrackKind.KIND_AUDIO) {
    log('mentor audio track', trk.name);
    let sum = 0, n = 0, t0 = Date.now(), peak = 0;
    for await (const f of new AudioStream(trk)) {
      for (const v of f.data) { sum += v * v; n++; peak = Math.max(peak, Math.abs(v)); }
      if (Date.now() - t0 >= 1000) { const db = n ? 20 * Math.log10(Math.sqrt(sum / n) / 32768 + 1e-9) : -120; if (db > -60) log(`AUDIO ${db.toFixed(1)} dBFS peak ${(20 * Math.log10(peak / 32768 + 1e-9)).toFixed(1)}`); sum = 0; n = 0; peak = 0; t0 = Date.now(); }
    }
  }
});
const savePng = async (name) => { if (!lastFrame) return; const c = createCanvas(lastFrame.width, lastFrame.height); c.getContext('2d').putImageData(new (await import('@napi-rs/canvas')).ImageData(new Uint8ClampedArray(lastFrame.data.buffer, lastFrame.data.byteOffset, lastFrame.width * lastFrame.height * 4), lastFrame.width, lastFrame.height), 0, 0); await writeFile(`${OUT}/${name}.png`, await c.encode('png')); };
const drawn = async name => { await sleep(300); const d = baseline && lastGrid ? diff(baseline, lastGrid) : NaN; log(`DIFF[${name}] vs baseline = ${d.toFixed(2)} (>~1.5 means drawing visible)`); await savePng(name); return d; };

// ---- monitor websocket ----
const events = [];
const waiters = [];
let ws = null;
const onMsg = m => {
  const e = JSON.parse(m.toString());
  if (e.type === 'hello') { log('WS hello; keys', Object.keys(e).join(',')); return; }
  if (e.type === 'frame' || e.type === 'input') return;
  const slim = { ...e }; for (const k of ['photo', 'jpeg']) if (slim[k]) slim[k] = `<${slim[k].length}b>`; if (slim.spec) slim.spec = `<spec ${slim.spec.name} parts=${slim.spec.parts?.length}>`;
  events.push({ t: Date.now(), e }); log('WS', JSON.stringify(slim).slice(0, 300));
  for (const w of waiters.slice()) if (w.type === e.type && (!w.pred || w.pred(e))) { waiters.splice(waiters.indexOf(w), 1); w.res(e); }
};
for (let i = 0; i < 30 && !(ws && ws.readyState === 1); i++) {   // the monitor opens only once the agent job has started
  ws = new WebSocket(`ws://localhost:${MON}`, { origin: `http://localhost:${MON}` });
  ws.on('message', onMsg); ws.on('error', () => {});
  await sleep(1000);
}
log('WS state', ws.readyState);
const waitEvent = (type, ms, pred) => new Promise(res => { const w = { type, pred, res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res(null); } }, ms); });

// wait for Mentor's first frame, then baseline
for (let i = 0; i < 300 && !got; i++) await sleep(100);
if (!got) { log('FAIL no Mentor video received'); process.exit(1); }
const tFirst = Date.now();
await sleep(5000); baseline = lastGrid; await savePng('00-baseline');
log(`BASELINE size=${size} fps samples so far ${JSON.stringify(fpsSamples)}`);
const turn = async (text, waitFor = 'turn', ms = 90000) => { const t = Date.now(); const p = waitEvent(waitFor, ms); await cmd(text); const e = await p; log(`LATENCY "${text}" -> ${waitFor}: ${e ? Date.now() - t : 'TIMEOUT'} ms`); return e; };

if (SCEN === 'main') {
  let e = await turn('how do I make the LED blink?'); log('marks for non-pointing turn:', e?.marks?.length); await sleep(800); await drawn('01-nonpointing');
  const sayE = await waitEvent('say', 20000);
  await cmd('okay'); await sleep(800); log('ack: any new turn event?', events.filter(x => x.e.type === 'turn').length);
  const nTurn = events.filter(x => x.e.type === 'turn').length;
  const t = Date.now(); await cmd('show me again'); const sy = await waitEvent('say', 5000); log(`REPLAY say after ${sy ? Date.now() - t : 'TIMEOUT'} ms:`, sy?.text, 'turns', events.filter(x => x.e.type === 'turn').length, 'vs', nTurn); await drawn('02-replay');
  await sleep(11500); await drawn('03-after-ttl');
  e = await turn('scan this', 'scan', 170000); log('scan event', e ? `${e.spec?.name} parts=${e.spec?.parts?.length} ms=${e.ms}` : 'NONE');
  await sleep(1500);
  e = await turn('can I plug the 5 volt pin straight into ground?'); log('warn turn marks:', JSON.stringify(e?.marks)); await drawn('04-warn');
  await sleep(11500); await drawn('05-warn-after-ttl');
  // rapid: two turns 700 ms apart, then hang up while the second is still thinking
  await cmd('where is the USB port?'); await sleep(700); await cmd('where does pin 13 go?'); await sleep(1500);
  log('HANGUP while brain thinking');
}
if (SCEN === 'main2') {
  let e;
  // rapid: two turns 700 ms apart, then hang up while the second is still thinking
  await cmd('where is the USB port?'); await sleep(700); await cmd('where does pin 13 go?'); await sleep(1500);
  log('HANGUP while brain thinking');
}
if (SCEN === 'gemini') {
  let e = await turn('where is the USB port?', 'say', 60000); log('fallback say:', e?.text);
  // 5 very fast turns
  const before = events.filter(x => x.e.type === 'say').length;
  for (let i = 1; i <= 5; i++) { await cmd(`where is pin ${i}?`); await sleep(100); }
  await sleep(8000);
  log('FAST-5: says emitted', events.filter(x => x.e.type === 'say').length - before, JSON.stringify(events.filter(x => x.e.type === 'say').slice(before).map(x => x.e.text)));
  // camera off
  const inBefore = events.length;
  await room.localParticipant.unpublishTrack(vpub.sid); log('camera OFF'); await sleep(4000);
  e = await turn('scan this', 'say', 20000); await sleep(1500); log('scan while camera off said:', e?.text);
  e = await turn('where is the USB port?', 'say', 20000); log('turn while camera off said:', e?.text);
  await publish(); log('camera ON again'); await sleep(5000); await drawn('06-cam-back');
  log('frames still flowing after cam off/on: got=', got);
}
log(`VIDEO size=${size} fps(2s windows)=${JSON.stringify(fpsSamples)} total=${got} firstFrameDelay=${tFirst - T0}ms`);
await writeFile(`${OUT}/events.json`, JSON.stringify(events.map(x => ({ t: x.t - T0, ...x.e, jpeg: undefined, photo: undefined, spec: x.e.spec ? { name: x.e.spec.name, n: x.e.spec.parts?.length } : undefined })), null, 1));
clearInterval(pump); ws.close();
await room.disconnect();
await sleep(500);
await new RoomServiceClient(host, key, secret).deleteRoom(roomName).catch(() => {});
process.exit(0);
