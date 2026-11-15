// Mentor: FaceTime an AI that sees your parts, draws where things go on your own live video, and talks you through it.
// Built on Chert's video-agent starter (chert-rooms.mjs, greet.mjs). Caller video in -> overlay -> video out;
// ElevenLabs hears and speaks; Claude Fable 5.2 (brain.mjs) decides what to say and where to point.
import './env.mjs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AutoSubscribe, defineAgent, voice } from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import {
  LocalVideoTrack, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream,
} from '@livekit/rtc-node';
import { createBrain } from './brain.mjs';
import { runAgent } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { FPS, HEIGHT, WIDTH, contentBox, crop, focusFor, maskSelfView, frameJpeg, outJpeg, render, rotate, snapshotPng } from './overlay.mjs';
import { startLive } from './live.mjs';
import { createMarkTracker } from './tracker.mjs';
import { cropJpeg, isScanIntent, scanLine } from './scan.mjs';
import { OVERLAY, overlayFrame, shouldDraw } from './overlay-policy.mjs';

// Accept the common alternative names for the same keys.
// (process.env stores strings: assigning undefined would make the text "undefined", so only copy a real value.)
if (!process.env.ELEVEN_API_KEY && process.env.ELEVENLABS_API_KEY) process.env.ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;

const GREETING = process.env.MENTOR_GREETING
  || "Hi, I'm Ody, an AI guide named for Homer's Odyssey. Show me what you're building, and tell me where you want to get to.";
const TASK = process.env.MENTOR_TASK || '';
const VOICE = Boolean(process.env.ELEVEN_API_KEY);   // without an ElevenLabs key: video-only test mode, no voice
const TEST_TURN = process.env.MENTOR_TEST_TURN || '';  // test hook: ask the brain this once the first camera frame arrives
const FILLER_MS = 1500;
const LANG = process.env.MENTOR_LANG || 'en';   // 'auto' = answer in whatever language the caller speaks
const MAX_TURNS = Number(process.env.MENTOR_MAX_TURNS || 60);      // brain calls per call before Ody wraps up (cost guard)
const FILLERS = ['Let me take a look.', 'One sec, looking.', 'Okay, checking.'];   // said if the brain is slower than FILLER_MS
const RUNS_DIR = fileURLToPath(new URL('../runs/', import.meta.url));

class MentorAgent extends voice.Agent {
  /** @param {{ onTurn: (text: string) => void }} hooks */
  constructor(hooks) {
    super({ instructions: 'Mentor (replies are produced in onUserTurnCompleted, not by a session LLM).' });
    this.hooks = hooks;
  }
  // No session LLM: the framework hands us each finished user turn and stops. We reply ourselves.
  async onUserTurnCompleted(_chatCtx, newMessage) {
    const text = (newMessage?.textContent ?? '').trim();
    if (text) this.hooks.onTurn(text);
  }
}

const agent = defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    const caller = await ctx.waitForParticipant();
    const callId = ctx.job?.id || `call-${Date.now()}`;
    const runDir = `${RUNS_DIR}${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${randomBytes(6).toString('hex')}/`;
    await mkdir(runDir, { recursive: true });
    console.log(`[mentor] call ${callId}, caller ${caller.identity}`);
    const live = await startLive();   // laptop screen at http://localhost:8790
    live.send({ type: 'call', state: 'live', since: Date.now() });

    // ---- caller video in: keep only the newest raw frame; convert + rotate lazily (<=15 fps, not per incoming frame) ----
    let raw = null;          // { frame: VideoFrame, rotation: number } from the current caller track
    let upright = null;      // cached RGBA upright version of `raw`
    let uprightOf = null;
    let currentSid = null;   // only the newest video track is read; older loops exit
    let box = null, boxAge = 0;   // where the caller's real picture sits inside the FaceTime frame
    const stats = { inFrames: 0, outFrames: 0, renderMs: 0, size: '' };   // logged every 5 s: is the lag ours or the network's?
    const getLatest = () => {
      if (!raw) return null;
      if (uprightOf !== raw) {
        const rgba = raw.frame.convert(VideoBufferType.RGBA);
        const up = rotate({ data: rgba.data, width: rgba.width, height: rgba.height }, raw.rotation);
        if (!box || ++boxAge > 30 || box.fw !== up.width || box.fh !== up.height) {
          box = { ...contentBox(up), fw: up.width, fh: up.height }; boxAge = 0;
        }
        upright = maskSelfView(crop(up, box));
        uprightOf = raw;
      }
      return upright;
    };
    const readVideo = async track => {
      const sid = track.sid || `${Date.now()}`;
      currentSid = sid;
      console.log(`[mentor] reading caller video track "${track.name}"`);
      try {
        for await (const ev of new VideoStream(track)) {
          if (currentSid !== sid) break;
          if (ev.frame.width < 64 || ev.frame.height < 64) continue;   // LiveKit sends 8x8 frames as a camera drops: not a picture
          raw = { frame: ev.frame, rotation: Number(ev.rotation) || 0 };
          stats.inFrames++;
        }
      } catch (error) { console.error('[mentor] caller video stopped', error?.message || error); }
    };
    const maybeVideo = (track, _pub, participant) => {
      if (track.kind === TrackKind.KIND_VIDEO && participant.identity !== ctx.room.localParticipant?.identity) void readVideo(track);
    };
    // Camera off / track replaced: drop the stale frame so the brain never judges an old view.
    const lostVideo = track => {
      if (track.kind === TrackKind.KIND_VIDEO && (!track.sid || track.sid === currentSid)) { raw = null; currentSid = null; console.log('[mentor] caller video gone'); }
    };
    const mutedVideo = (pub, participant) => {
      if (pub.kind === TrackKind.KIND_VIDEO && participant?.identity !== ctx.room.localParticipant?.identity) raw = null;
    };
    ctx.room.on(RoomEvent.TrackSubscribed, maybeVideo);
    ctx.room.on(RoomEvent.TrackUnsubscribed, lostVideo);
    ctx.room.on(RoomEvent.TrackMuted, mutedVideo);
    for (const p of ctx.room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) if (pub.track) maybeVideo(pub.track, pub, p);
    }

    // ---- video out: caller frame + Mentor's marks, 15 fps ----
    let marks = [], marksAt = 0, caption = '', speaking = false, tick = 0;
    const tracker = createMarkTracker();   // keeps each mark on its part as the caller's phone moves (tracker.mjs)
    const view = { cx: 0.5, cy: 0.5, zoom: 1 };   // what part of the caller's picture fills their screen
    const DETAIL_ZOOM = process.env.MENTOR_DETAIL_ZOOM !== '0';
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('mentor-video', source);
    const frame = () => {
      // overlays on demand (overlay-policy.mjs): plain camera unless the caller asked to be shown something
      const o = overlayFrame({ marks, marksAt, caption, speaking });
      if (o.expired) marks = [];
      const latest = getLatest();
      const t0 = performance.now();
      const shown = marks.length ? tracker.update(latest) : marks;
      // Detail zoom: ease toward the marked parts (zoom ≤1.8x) while marks are on screen, back out when they fade.
      const target = DETAIL_ZOOM && latest && shown.length ? focusFor(shown, latest.width, latest.height) : { cx: 0.5, cy: 0.5, zoom: 1 };
      for (const k of ['cx', 'cy', 'zoom']) view[k] += (target[k] - view[k]) * 0.08;
      const px = render(latest, shown, { caption: o.caption, tick: tick++, speaking: o.speaking, view });
      source.captureFrame(new VideoFrame(px, WIDTH, HEIGHT, VideoBufferType.RGBA));
      stats.outFrames++; stats.renderMs += performance.now() - t0; if (latest) stats.size = `${latest.width}x${latest.height}`;
    };
    frame();
    // One crisp layer (no simulcast) at a generous bitrate: the picture the caller sees is the product.
    await ctx.room.localParticipant.publishTrack(track, {
      source: TrackSource.SOURCE_CAMERA, simulcast: false,
      videoEncoding: { maxBitrate: BigInt(Number(process.env.MENTOR_OUT_BITRATE || 2_500_000)), maxFramerate: FPS },
    });
    const timer = setInterval(frame, 1000 / FPS);
    const statsTimer = setInterval(() => {
      if (!stats.outFrames) return;
      const line = `[video] in ${(stats.inFrames / 5).toFixed(1)} fps (${stats.size || 'no camera'}) -> out ${(stats.outFrames / 5).toFixed(1)} fps, ${(stats.renderMs / stats.outFrames).toFixed(1)} ms/frame`;
      console.log(line); live.send({ type: 'video', in: stats.inFrames / 5, out: stats.outFrames / 5, ms: stats.renderMs / stats.outFrames, size: stats.size });
      stats.inFrames = 0; stats.outFrames = 0; stats.renderMs = 0;
    }, 5000);
    // "Tester" snapshots: what Mentor saw and what it sent, every 3 s, saved locally in runs/<call>/frames/ for review.
    await mkdir(`${runDir}frames`, { recursive: true });
    let shot = 0;
    const shotTimer = setInterval(async () => {
      const now = getLatest(); if (!now || shot >= 200) return;   // cap: ~10 minutes of snapshots per call
      const n = String(++shot).padStart(3, '0');
      try {
        await writeFile(`${runDir}frames/${n}-in.jpg`, (await frameJpeg(now, 720)).jpeg);
        await writeFile(`${runDir}frames/${n}-out.jpg`, await outJpeg(80));
      } catch { /* best effort */ }
    }, 3000);
    let pushing = false;   // the monitor gets the same picture as the caller, twice a second
    const monitorTimer = setInterval(() => {
      if (pushing) return;
      pushing = true;
      outJpeg().then(b => live.send({ type: 'frame', jpeg: b.toString('base64') })).catch(() => {}).finally(() => { pushing = false; });
    }, 500);
    // What Mentor sees (the cropped caller picture), once a second, for the tester screen.
    const seeTimer = setInterval(async () => {
      const now = getLatest(); if (!now) return;
      try { const j = await frameJpeg(now, 480); live.send({ type: 'input', jpeg: j.jpeg.toString('base64'), w: now.width, h: now.height }); } catch { /* skip */ }
    }, 1000);

    // ---- voice: ElevenLabs Scribe (hearing) + ElevenLabs TTS (speaking); no session LLM ----
    const brain = await createBrain({ task: TASK });
    console.log(`[mentor] brain: ${brain.provider}`);
    live.send({ type: 'brain', brain: brain.provider });
    let turnSeq = 0, stepNo = 0;
    const recap = [];
    const session = VOICE ? new voice.AgentSession({
      // Snappier turns in a noisy room: commit after 0.5 s of silence, and ignore quieter (farther) voices.
      // MENTOR_LANG=auto lets Scribe detect the language (Mentor then answers in it; the TTS voice is multilingual).
      stt: new elevenlabs.STT({ model: 'scribe_v2_realtime', ...(LANG === 'auto' ? {} : { languageCode: LANG }),
        serverVad: { vadSilenceThresholdSecs: 0.5, vadThreshold: 0.6, minSpeechDurationMs: 150, minSilenceDurationMs: 300 } }),
      turnDetection: 'vad', minEndpointingDelay: 0.4, maxEndpointingDelay: 2.0,
      tts: new elevenlabs.TTS({
        model: 'eleven_flash_v2_5',
        ...(process.env.ELEVEN_VOICE_ID ? { voiceId: process.env.ELEVEN_VOICE_ID } : {}),
      }),
    }) : null;
    if (!VOICE) console.warn('[mentor] no ELEVENLABS_API_KEY: voice off (video-only test mode)');
    session?.on(voice.AgentSessionEventTypes.AgentStateChanged, ev => { speaking = ev.newState === 'speaking'; });

    let ended = false;
    const say = (text, ms) => {   // never throws: the call may have ended while the brain was thinking
      if (ended || !text) return;
      live.send({ type: 'say', text, ms });
      if (!session) { console.log(`[say:muted] ${text}`); return; }
      console.log(`[speak] ${text.slice(0, 80)}`);
      try { session.say(text); } catch (error) { console.error('[mentor] say failed', error?.message || error); }
    };
    // Saves brain requests (the free Gemini tier is ~20/day/model): a bare acknowledgement gets no model call.
    const ACKS = /^(ok(ay)?|yeah|yep|yes|sure|mm+|hm+|uh+|um+|cool|nice|got it|alright|thanks|thank you)[.!?]*$/i;
    // "Show me again": re-show the last marks and repeat the last line instantly, with no model call.
    const REPLAY = /^(.{0,20}\b)?(again|repeat( that)?|say (that|it) again|show me (that )?again|one more time|what\?|sorry\?|pardon)\W*$/i;
    let last = null, turns = 0, lastPart = null, scanning = false, scanNo = 0;
    // "Scan this": a dedicated brain call builds an approximate 3D model of whatever is on camera for the laptop's /twin.
    const scanTurn = async heard => {
      if (scanning) { say('Still scanning, hold it there.'); return; }
      scanning = true;
      const seq = ++turnSeq;   // a scan is a turn: a later question supersedes its spoken answer, not the model
      try {
        say('Scanning, hold it steady.');
        await new Promise(r => setTimeout(r, 700));   // they hear the line and hold still; then take a fresh frame
        const now = getLatest();
        if (!now) { say("I can't see anything yet. Point your camera at it and say scan again."); return; }
        const image = await frameJpeg(now, 1280);
        const spec = await brain.scan(image);
        if (ended) return;
        const cut = await cropJpeg(image.jpeg, spec.bbox, 1024);
        const n = ++scanNo;
        live.send({ type: 'scan', id: n, at: Date.now(), spec, photo: cut.jpeg.toString('base64'), crop: cut.rect, ms: spec.ms, model: spec.model || '' });
        if (spec.known_model !== 'none' && spec.known_model !== lastPart) {
          lastPart = spec.known_model;
          live.send({ type: 'part', model: lastPart, label: { 'uno-r3': 'Arduino UNO R3', 'uno-r4-wifi': 'Arduino UNO R4 WiFi' }[lastPart] });
        }
        console.log(`[scan] ${spec.name} (${spec.parts.length} parts, ${Math.round(spec.confidence * 100)}%) in ${spec.ms} ms`);
        await writeFile(`${runDir}scan-${String(n).padStart(2, '0')}.json`, JSON.stringify(spec, null, 2)).catch(() => {});
        await writeFile(`${runDir}scan-${String(n).padStart(2, '0')}.jpg`, cut.jpeg).catch(() => {});
        if (seq === turnSeq) say(scanLine(spec));
        if (brain.provider === 'claude-code') brain.messages.push({ heard, say: scanLine(spec) });   // its recap reads the transcript
        const file = `${runDir}step-${String(++stepNo).padStart(2, '0')}.png`;
        await writeFile(file, await snapshotPng());
        recap.push({ step: `Scanned: ${spec.name}`, note: `Sent a 3D model of the ${spec.name.toLowerCase()} to the laptop.`, say: scanLine(spec), image: file });
        await writeFile(`${runDir}recap.json`, JSON.stringify({ callId, task: TASK, provider: brain.provider, recap }, null, 2));
      } catch (error) {
        console.error('[mentor] scan failed', error?.status || '', error?.message || error);
        if (!ended) say("The scan didn't work. Hold it closer, in good light, and say scan again.");
      } finally { scanning = false; }
    };
    // Voice control of the laptop's 3D twin: instant, no brain call. The twin page acts on {type:'twin', action}.
    const TWIN_CMDS = [
      [/\b(un-?explode|put it (back )?together|collapse|assemble)\b/i, 'assemble', 'Put it back together on your laptop.'],
      [/\b(explode|exploded view|take it apart|break it apart|pull it apart)\b/i, 'explode', 'Exploded it on your laptop.'],
      [/\b(rotate|spin) (it|that|the model|the hologram)\b|\bturn it around\b/i, 'rotate', 'Spinning it on your laptop.'],
      [/\b(stop (spinning|rotating))\b/i, 'stop', 'Stopped.'],
      [/\b(reset|recenter|re-center) (the )?(view|model|hologram|camera)\b/i, 'reset', 'Reset the view.'],
      [/\b(realistic|real (view|look|mode)|make it look real)\b/i, 'realistic', 'Switched to the realistic look.'],
      [/\b(hologram (view|mode|look)|holographic)\b/i, 'hologram', 'Back to the hologram.'],
      [/\b(export|download|save) (it|the model|the 3d|a 3d file|the hologram)\b/i, 'export', 'Exported the 3D file on your laptop.'],
    ];
    // Only short, direct commands ("Ody, explode it"), so a sentence that merely mentions a word isn't hijacked.
    const twinCommand = text => text.trim().split(/\s+/).length <= 7 && TWIN_CMDS.find(([re]) => re.test(text));
    const onTurn = async heard => {
      const cmd = !isScanIntent(heard) && twinCommand(heard);
      if (cmd) {
        console.log(`[heard] ${heard} (twin: ${cmd[1]}, no brain call)`); live.send({ type: 'heard', text: heard });
        live.send({ type: 'twin', action: cmd[1] }); say(cmd[2], 0); return;
      }
      if (ACKS.test(heard.trim())) { console.log(`[heard] ${heard} (acknowledgement, no brain call)`); live.send({ type: 'heard', text: heard }); return; }
      if (last && REPLAY.test(heard.trim())) {
        console.log(`[heard] ${heard} (replay, no brain call)`); live.send({ type: 'heard', text: heard });
        const now = getLatest();
        marks = last.marks; marksAt = Date.now(); if (now) tracker.seed(now, marks, last.board);
        say(last.say, 0); return;
      }
      if (++turns > MAX_TURNS) {   // cost/DoS guard: a runaway call (e.g. a TV in the room) can't drain the quota
        if (turns === MAX_TURNS + 1) say("We've covered a lot. Let's pick this up on a new call.");
        return;
      }
      if (isScanIntent(heard) && typeof brain.scan === 'function') {
        console.log(`[heard] ${heard} (scan)`); live.send({ type: 'heard', text: heard });
        await scanTurn(heard); return;
      }
      const seq = ++turnSeq;
      console.log(`[heard] ${heard}`);
      live.send({ type: 'heard', text: heard });
      try {
        const filler = setTimeout(() => { if (seq === turnSeq) say(FILLERS[seq % FILLERS.length]); }, FILLER_MS);
        const now = getLatest();
        const image = now ? await frameJpeg(now) : null;
        const reply = await brain.turn(heard, image).finally(() => clearTimeout(filler));
        if (seq !== turnSeq || ended) return;   // they spoke again while we were thinking; answer the newer turn
        // Safety: if Ody says "Stop…" about something it marked, make sure the mark shows as a red warning.
        if (/^\s*stop\b/i.test(reply.say || '') && reply.marks.length && !reply.marks.some(m => m.kind === 'warn')) reply.marks[0] = { ...reply.marks[0], kind: 'warn' };
        // drawn on the caller's video only when asked for (or a warning); the laptop still gets every mark below
        const draw = shouldDraw(heard, reply.marks);
        marks = draw ? reply.marks : []; marksAt = Date.now();
        if (!draw && reply.marks.length) console.log(`[overlay] ${reply.marks.length} marks not drawn (not asked for; MENTOR_OVERLAY=${OVERLAY})`);
        last = { marks: reply.marks, say: reply.say, board: reply.board };
        // The laptop's 3D twin (/twin) builds the recognised board; tell it once per new part.
        if (reply.board?.model && reply.board.model !== 'none' && reply.board.model !== 'other' && reply.board.model !== lastPart) {
          lastPart = reply.board.model;
          live.send({ type: 'part', model: lastPart, label: { 'uno-r3': 'Arduino UNO R3', 'uno-r4-wifi': 'Arduino UNO R4 WiFi' }[lastPart] || 'Board' });
        }
        tracker.seed(now, marks, reply.board);   // the brain judged `now` (the frame from the turn start): track from there;
        // A board nobody mapped (custom PCB): headers.mjs read its headers; send that board to the laptop twin once.
        const cb = tracker.board?.part?.custom;
        if (cb && cb.key !== lastPart) { lastPart = cb.key; live.send({ type: 'part', model: 'custom', label: cb.name, custom: cb }); }
        // with UNO corners the tracker registers the board and snaps pin marks/wires to their exact holes (board.mjs)
        live.send({ type: 'turn', brain: brain.provider, model: reply.model || '', ms: reply.ms, marks: reply.marks, board: { model: reply.board?.model || 'none', corners: tracker.board ? tracker.board.corners() : (reply.board?.corners || []) }, step: reply.step, done: !!reply.done });
        if (reply.step) caption = reply.step;
        if (reply.done) caption = 'Done. You made it home.';   // nostos: the Odyssey's homecoming
        if (reply.step || reply.done) live.send({ type: 'step', text: caption, done: !!reply.done });
        console.log(`[say] ${reply.say}  marks=${JSON.stringify(reply.marks)}`);
        say(reply.say, reply.ms);
        if (reply.note || reply.marks.length) {
          await new Promise(r => setTimeout(r, 150));   // let one frame with the new marks render
          const file = `${runDir}step-${String(++stepNo).padStart(2, '0')}.png`;
          await writeFile(file, await snapshotPng());
          recap.push({ step: reply.step, note: reply.note, say: reply.say, image: file });
          await writeFile(`${runDir}recap.json`, JSON.stringify({ callId, task: TASK, provider: brain.provider, recap }, null, 2));
        }
      } catch (error) {
        console.error('[mentor] brain failed', error?.status || '', error?.message || error);
        if (seq === turnSeq) say('Sorry, I lost my train of thought. Say that again?');
      }
    };

    ctx.addShutdownCallback(async () => {
      ended = true;
      clearInterval(timer);
      clearInterval(monitorTimer);
      clearInterval(shotTimer);
      clearInterval(seeTimer);
      clearInterval(statsTimer);
      live.send({ type: 'call', state: 'ended' });
      ctx.room.off(RoomEvent.TrackSubscribed, maybeVideo);
      ctx.room.off(RoomEvent.TrackUnsubscribed, lostVideo);
      ctx.room.off(RoomEvent.TrackMuted, mutedVideo);
      // Recap first (its own process, so it finishes even if this job is torn down), then close media.
      try {
        if (brain.messages.length) {
          await brain.idle();
          await writeFile(`${runDir}recap.json`, JSON.stringify({ callId, task: TASK, provider: brain.provider, recap }, null, 2));
          await writeFile(`${runDir}conversation.json`, JSON.stringify(brain.messages));
          const log = openSync(`${runDir}recap.log`, 'a');
          const here = fileURLToPath(new URL('.', import.meta.url));
          const child = spawn(process.execPath, ['send-recap.mjs', runDir, ...(process.env.MENTOR_SEND_RECAP === '1' ? [] : ['--no-send'])],
            { cwd: here, detached: true, stdio: ['ignore', log, log], env: process.env });
          child.unref();
        }
      } catch (error) { console.error('[mentor] recap start failed', error?.message || error); }
      console.log(`[mentor] call ended; ${recap.length} recap steps in ${runDir}`);
      for (const close of [() => session?.close(), () => track.close(), () => source.close(), () => live.close(), () => brain.close?.()]) {
        try { await close(); } catch { /* already closed */ }
      }
    });

    if (TEST_TURN) {   // test hook: once a camera frame exists, run one scripted turn
      const waitFrame = setInterval(() => { if (raw) { clearInterval(waitFrame); setTimeout(() => void onTurn(TEST_TURN).catch(() => {}), 800); } }, 200);
      ctx.addShutdownCallback(async () => clearInterval(waitFrame));
    }

    if (session) await session.start({
      room: ctx.room,
      agent: new MentorAgent({ onTurn: text => { onTurn(text).catch(e => console.error('[mentor] turn failed', e?.message || e)); } }),
      record: false,
      inputOptions: {
        participantIdentity: caller.identity,
        audioEnabled: true,
        videoEnabled: false,   // we read video ourselves above
        textEnabled: false,
        closeOnDisconnect: true,
        deleteRoomOnClose: false,
      },
      outputOptions: { audioEnabled: true, transcriptionEnabled: false },
    });

    // The Mac hangs up if it hears nothing within 10 s of bridge_ready: greet then, with a fixed line (no model wait).
    const stopGreeting = greetOnBridgeReady(ctx.room, () => { console.log('[mentor] FaceTime ready: greeting'); caption = 'Show me your project'; live.send({ type: 'step', text: caption }); say(GREETING); });
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

export default agent;

runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'mentor-hackuta' });
