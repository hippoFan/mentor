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
import { BackgroundVoiceCancellation, NoiseCancellation } from '@livekit/noise-cancellation-node';
import {
  LocalVideoTrack, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream,
} from '@livekit/rtc-node';
import { createBrain } from './brain.mjs';
import { runAgent } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { FPS, HEIGHT, WIDTH, contentBox, crop, focusFor, maskSelfView, frameJpeg, outJpeg, render, rotate, snapshotPng } from './overlay.mjs';
import { startLive } from './live.mjs';
import { createMarkTracker } from './tracker.mjs';
import { cropJpeg, isScanIntent, parseModelCorrection, scanLine } from './scan.mjs';
import { researchInterior } from './research.mjs';
import { CIRCUIT_BOARDS, circuitEvent, circuitIntent, createProject, describe as describeCircuit, findComponent, handleUtterance, markDone, nextStep, setBoard } from './circuit.mjs';
import { MARK_TTL_MS, OVERLAY, overlayFrame, shouldDraw } from './overlay-policy.mjs';
import { matchPart, parseTwin, partList } from './twin-voice.mjs';
import { createAnalyzer } from './combo.mjs';
import { isShowHow, locateHole, stepMarks } from './connect.mjs';
import { CONSENT_GREETING, CONSENT_ON, KEEP_DAYS, NO_RECORDING_SAY, createConsentGate, isNoRecord, pruneRuns } from './consent.mjs';

// Accept the common alternative names for the same keys.
// (process.env stores strings: assigning undefined would make the text "undefined", so only copy a real value.)
if (!process.env.ELEVEN_API_KEY && process.env.ELEVENLABS_API_KEY) process.env.ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;

// With consent on (the default), the greeting is the consent question (consent.mjs); MENTOR_GREETING is for ODY_CONSENT=0.
const GREETING = CONSENT_ON ? CONSENT_GREETING : process.env.MENTOR_GREETING
  || "Hi, I'm Ody, an AI guide named for Homer's Odyssey. Show me what you're building, and tell me where you want to get to.";
const STEP_TTL_MS = 30_000;   // a wiring step's wire stays up longer than an ordinary mark: they need both hands
const TASK = process.env.MENTOR_TASK || '';
const VOICE = Boolean(process.env.ELEVEN_API_KEY);   // without an ElevenLabs key: video-only test mode, no voice
const TEST_TURN = process.env.MENTOR_TEST_TURN || '';  // test hook: ask the brain this once the first camera frame arrives
const FILLER_MS = 1500;
const LANG = process.env.MENTOR_LANG || 'en';   // 'auto' = answer in whatever language the caller speaks
const MAX_TURNS = Number(process.env.MENTOR_MAX_TURNS || 60);
const NOISE = (process.env.MENTOR_NOISE || 'bvc').toLowerCase();   // bvc (default) | nc | off
// Wake word: with ODY_WAKE=1, Ody only acts on sentences that address it ("Ody, scan this"). Speech-to-text spells the
// name many ways, so accept the common ones; the name is stripped before the rest is handled.
const WAKE = process.env.MENTOR_WAKE === '1';
const WAKE_RE = /^\W*(hey |ok |okay )?(ody|odie|oddy|odi|oddie|audi|otie|odee|o\.?d\.?)\b[\s,.!:-]*/i;      // brain calls per call before Ody wraps up (cost guard)
const FILLERS = ['Let me take a look.', 'One sec, looking.', 'Okay, checking.'];   // said if the brain is slower than FILLER_MS
const RUNS_DIR = fileURLToPath(new URL('../runs/', import.meta.url));
// Retention (PRIVACY.md): call folders older than ODY_KEEP_DAYS (default 7) are deleted when the agent starts and when
// each call starts. Only dated call folders (YYYY-MM-DD-HH-MM-<hex>); never symlinks or anything else.
void pruneRuns(RUNS_DIR, { days: KEEP_DAYS });

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
    await pruneRuns(RUNS_DIR, { days: KEEP_DAYS });
    // The call's folder is created only once the caller has said yes (nothing is saved before consent).
    let runReady = null;
    const ensureRun = () => (runReady ??= mkdir(`${runDir}frames`, { recursive: true }).then(() => true, () => false));
    console.log(`[mentor] call ${callId}, caller ${caller.identity}`);
    const live = await startLive();   // laptop screen at http://localhost:8790
    live.send({ type: 'call', state: 'live', since: Date.now() });
    // Consent (consent.mjs, PRIVACY.md): until the caller says yes, no brain calls, scans, research, snapshot files or
    // camera frames to the laptop page. The gate is created once say() exists (below); before that nothing passes.
    let gate = null;
    const consented = () => !!gate?.given;
    const recording = () => !!gate?.recording;
    const consentLog = [];   // {type:'consent', state, at} records, written at the top of conversation.json
    const usage = { ttsChars: 0, brain: 0, scans: 0, research: 0, analyses: 0, holes: 0 };   // logged at call end

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
    let marks = [], marksAt = 0, marksTtl = MARK_TTL_MS, caption = '', speaking = false, tick = 0;
    const tracker = createMarkTracker();   // keeps each mark on its part as the caller's phone moves (tracker.mjs)
    const view = { cx: 0.5, cy: 0.5, zoom: 1 };   // what part of the caller's picture fills their screen
    const DETAIL_ZOOM = process.env.MENTOR_DETAIL_ZOOM !== '0';
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('mentor-video', source);
    const frame = () => {
      // overlays on demand (overlay-policy.mjs): plain camera unless the caller asked to be shown something
      if (!consented() && marks.length) marks = [];   // before consent the caller's video carries no overlay
      const o = overlayFrame({ marks, marksAt, caption, speaking, ...(marksTtl !== MARK_TTL_MS ? { ttl: marksTtl } : {}) });
      if (o.expired) { marks = []; marksTtl = MARK_TTL_MS; }
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
    // Only after consent, and never after "stop recording".
    let shot = 0;
    const shotTimer = setInterval(async () => {
      const now = getLatest(); if (!now || shot >= 200 || !recording()) return;   // cap: ~10 minutes of snapshots per call
      const n = String(++shot).padStart(3, '0');
      try {
        if (!await ensureRun()) return;
        await writeFile(`${runDir}frames/${n}-in.jpg`, (await frameJpeg(now, 720)).jpeg);
        await writeFile(`${runDir}frames/${n}-out.jpg`, await outJpeg(80));
      } catch { /* best effort */ }
    }, 3000);
    let pushing = false;   // the monitor gets the same picture as the caller, twice a second
    const monitorTimer = setInterval(() => {
      if (pushing || !consented()) return;   // the caller's camera reaches the laptop page only after consent
      pushing = true;
      outJpeg().then(b => live.send({ type: 'frame', jpeg: b.toString('base64') })).catch(() => {}).finally(() => { pushing = false; });
    }, 500);
    // What Mentor sees (the cropped caller picture), once a second, for the tester screen.
    const seeTimer = setInterval(async () => {
      const now = getLatest(); if (!now || !consented()) return;
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
      usage.ttsChars += text.length;   // ElevenLabs bills TTS per character
      if (!session) { console.log(`[say:muted] (${text.length} ch) ${text}`); return; }
      console.log(`[speak] (${text.length} ch) ${text.slice(0, 80)}`);
      try { session.say(text); } catch (error) { console.error('[mentor] say failed', error?.message || error); }
    };
    gate = createConsentGate({ say: t => say(t, 0), send: e => live.send(e), log: rec => { consentLog.push(rec); void saveConversation(); } });
    // conversation.json: the consent records first, then the brain's conversation (send-recap.mjs skips the records).
    // Written only once the caller has said yes: before that, nothing is saved.
    const saveConversation = async () => {
      if (!consented() || !await ensureRun()) return;
      try { await writeFile(`${runDir}conversation.json`, JSON.stringify([...consentLog, ...brain.messages])); } catch { /* best effort */ }
    };
    const saveRecap = async () => {
      if (!await ensureRun()) return;
      await writeFile(`${runDir}recap.json`, JSON.stringify({ callId, task: TASK, provider: brain.provider, recap }, null, 2));
    };
    /** A step picture for the voyage log, or '' when snapshots are off ("stop recording"). */
    const stepPicture = async () => {
      if (!recording() || !await ensureRun()) return '';
      const file = `${runDir}step-${String(++stepNo).padStart(2, '0')}.png`;
      await writeFile(file, await snapshotPng());
      return file;
    };
    // Saves brain requests (the free Gemini tier is ~20/day/model): a bare acknowledgement gets no model call.
    const ACKS = /^(ok(ay)?|yeah|yep|yes|sure|mm+|hm+|uh+|um+|cool|nice|got it|alright|thanks|thank you)[.!?]*$/i;
    // "Show me again": re-show the last marks and repeat the last line instantly, with no model call.
    const REPLAY = /^(.{0,20}\b)?(again|repeat( that)?|say (that|it) again|show me (that )?again|one more time|what\?|sorry\?|pardon)\W*$/i;
    let last = null, turns = 0, lastPart = null, scanning = false, scanNo = 0;
    const budget = () => {   // cost/DoS guard: a runaway call (e.g. a TV in the room) can't drain the quota
      if (++turns <= MAX_TURNS) return true;
      if (turns === MAX_TURNS + 1) say("We've covered a lot. Let's pick this up on a new call.");
      return false;
    };
    // Voice circuit builder ("add a distance sensor"): one project per call, wired to real pins (circuit.mjs).
    let circuit = createProject({ board: 'arduino-uno' }), circuitBusy = false;
    const CIRCUIT_ON = process.env.MENTOR_CIRCUIT !== '0';
    const DONE_RE = /^\W*(ok(ay)?[\s,]*)?(done|did it|got it|plugged( it)? in|it'?s in|finished|next( one| step| wire)?|what'?s next)\W*$/i;
    // "Show me how to connect it" (connect.mjs): the next jumper as a holographic wire on the caller's video, from the
    // exact board pin to the breadboard hole. One brain call per step finds the hole in the current frame; the laptop
    // gets {type:'circuit-step'} to animate the same step.
    let stepSeq = 0;
    const showNext = async ({ speak = false } = {}) => {
      const n = nextStep(circuit);
      if (!n) { if (speak) say(circuit.components.length ? 'Every wire is in. Your circuit is complete.' : 'There is nothing to wire yet. Tell me what to add, like a distance sensor.', 0); return; }
      live.send({ type: 'circuit-step', index: n.index, total: n.total, step: n });
      if (speak) say(n.say, 0);
      if (!consented() || ended || !brain.structured && !brain.client) return;
      const now = getLatest();
      if (!now) { if (speak) say('Point your camera at the board and the breadboard.', 0); return; }
      if (!budget()) return;
      const seq = ++stepSeq;
      const model = last?.board?.model && last.board.model !== 'none' && last.board.model !== 'other' ? last.board.model : circuit.variant;
      let hole = null;
      try { usage.brain++; usage.holes++; hole = await locateHole(brain, await frameJpeg(now, 1024), n, model); }
      catch (e) { console.warn('[connect] hole lookup failed:', e?.message || e); }
      if (seq !== stepSeq || ended || nextStep(circuit)?.id !== n.id) return;   // a newer step or request superseded this one
      const plan = stepMarks(n, hole);
      const board = hole?.corners?.length === 4 ? { model, corners: hole.corners, headers: [] } : last?.board || null;
      marks = plan.marks; marksAt = Date.now(); marksTtl = STEP_TTL_MS;
      tracker.seed(now, marks, board);
      if (plan.boardPin && !tracker.board) { marks = plan.fallback; tracker.seed(now, marks, null); }   // no guessed pin in mid-air
      console.log(`[connect] step ${n.index}/${n.total} ${n.id}: hole ${plan.toSeen ? `seen ${Math.round(hole.to.confidence * 100)}%` : 'not seen'}, board ${tracker.board ? 'registered' : 'not registered'}, ${marks.length} marks${hole ? ` (${hole.ms} ms)` : ''}`);
      live.send({ type: 'turn', brain: brain.provider, model: hole?.model || '', ms: hole?.ms || 0, marks, board: { model, corners: tracker.board ? tracker.board.corners() : [] }, step: n.say, done: false });
      if (!plan.toSeen && n.kind === 'jumper') say('Point the camera so I can see the breadboard.', 0);
      else if (!marks.length) say('Point the camera at the board and the breadboard so I can show you.', 0);
    };
    const circuitTurn = async heard => {
      if (circuitBusy) return true;
      const kind = circuitIntent(heard);
      const done = !kind && circuit.components?.length && DONE_RE.test(heard);
      if (!kind && !done) return false;
      circuitBusy = true;
      try {
        console.log(`[heard] ${heard} (circuit: ${kind || 'done'})`); live.send({ type: 'heard', text: heard });
        if (lastPart && CIRCUIT_BOARDS.includes(lastPart) && lastPart !== circuit.board) circuit = setBoard(circuit, lastPart);   // the board Ody recognised
        let sayText;
        if (done) {
          circuit = markDone(circuit); const n = nextStep(circuit);
          sayText = n ? n.say : 'That was the last wire. Your circuit is complete.';
          live.send(circuitEvent(circuit, { say: sayText }));
        } else {
          const now = getLatest(); const image = kind === 'change' && now ? await frameJpeg(now, 960) : null;
          const r = await handleUtterance(brain, circuit, heard, image);
          if (r.plan?.source === 'brain') usage.brain++;
          if (ended) return true;
          circuit = r.state;
          const n = nextStep(circuit);
          sayText = [r.say, r.changed && n ? `First: ${n.say}` : ''].filter(Boolean).join(' ');
          live.send(circuitEvent(circuit, { ...r, say: sayText }));
        }
        say(sayText, 0);
        void showNext();
      } catch (e) { console.warn('[circuit] failed:', e?.message || e); say("I couldn't change the circuit. Say it again, simply: add a distance sensor.", 0); }
      finally { circuitBusy = false; }
      return true;
    };
    // "Scan this": a dedicated brain call builds an approximate 3D model of whatever is on camera for the laptop's /twin.
    let lastScan = null;   // {id, spec, cut, at}: "it's actually a Galaxy S24 Ultra" corrects this one
    const interiors = new Map();   // scan name (lower case) -> researched interior, for the build-combo analysis
    const research = (id, spec, cut, opts = {}) => {
      if (process.env.MENTOR_RESEARCH === '0' || !consented()) return Promise.resolve(null);
      usage.research++;
      return researchInterior(brain, spec, { image: cut, ...opts })
        .then(i => {
          if (i && !ended) {
            interiors.set(spec.name.toLowerCase(), i);
            live.send({ type: 'interior', id, interior: i, model_guess: spec.model_guess || '', model_source: spec.model_source || 'scan' });
            console.log(`[scan] interior researched for ${spec.model_guess || spec.name}: ${i.layers?.length || 0} layers, ${i.sources?.length || 0} sources${i.cached ? ' (cached)' : ''}`);
          }
          return i;
        })
        .catch(e => { console.warn('[scan] interior research failed:', e?.message || e); return null; });
    };
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
        usage.brain++; usage.scans++;
        const spec = await brain.scan(image);
        if (ended) return;
        const cut = await cropJpeg(image.jpeg, spec.bbox, 1024);
        const n = ++scanNo;
        lastScan = { id: n, spec, cut, at: Date.now() };
        live.send({ type: 'scan', id: n, at: Date.now(), spec, photo: cut.jpeg.toString('base64'), crop: cut.rect, ms: spec.ms, model: spec.model || '' });
        // Researched interior: what's inside this object (public teardowns, for its exact model when the scan named
        // one), so the laptop's explode is realistic. Runs in the background (20-30 s, cached); the scan works without it.
        if (spec.known_model === 'none') void research(n, spec, cut);
        if (spec.known_model !== 'none' && spec.known_model !== lastPart) {
          lastPart = spec.known_model;
          live.send({ type: 'part', model: lastPart, label: { 'uno-r3': 'Arduino UNO R3', 'uno-r4-wifi': 'Arduino UNO R4 WiFi' }[lastPart] });
        }
        console.log(`[scan] ${spec.name}${spec.model_guess ? ` = ${spec.model_guess} (${Math.round(spec.model_confidence * 100)}%: ${spec.id_cues.join('; ')})` : ''} (${spec.parts.length} parts, ${Math.round(spec.confidence * 100)}%) in ${spec.ms} ms`);
        if (recording() && await ensureRun()) {
          await writeFile(`${runDir}scan-${String(n).padStart(2, '0')}.json`, JSON.stringify(spec, null, 2)).catch(() => {});
          await writeFile(`${runDir}scan-${String(n).padStart(2, '0')}.jpg`, cut.jpeg).catch(() => {});
        }
        if (seq === turnSeq) say(scanLine(spec));
        if (brain.provider === 'claude-code') brain.messages.push({ heard, say: scanLine(spec) });   // its recap reads the transcript
        recap.push({ step: `Scanned: ${spec.name}`, note: `Sent a 3D model of the ${spec.name.toLowerCase()} to the laptop.`, say: scanLine(spec), image: await stepPicture() });
        await saveRecap();
      } catch (error) {
        console.error('[mentor] scan failed', error?.status || '', error?.message || error);
        if (!ended) say("The scan didn't work. Hold it closer, in good light, and say scan again.");
      } finally { scanning = false; }
    };
    // "It's actually a Galaxy S24 Ultra": the caller names the last scan's real model; research that exact model again.
    const modelFix = async model => {
      const sc = lastScan;
      sc.spec = { ...sc.spec, model_guess: model, model_confidence: 1, model_source: 'user', id_cues: ['you told me'], alternatives: [] };
      live.send({ type: 'scan-model', id: sc.id, model_guess: model, model_confidence: 1, model_source: 'user' });
      say(`Got it, ${/^[aeiou]/i.test(model) ? 'an' : 'a'} ${model}. I'll update what's inside on your laptop.`, 0);
      const i = await research(sc.id, sc.spec, sc.cut, { fresh: true });
      if (i && !ended) say(`Updated: the inside of the ${model} is on your laptop.`, 0);
      else if (!ended) say("I couldn't research that model just now. The scan is still on your laptop.", 0);
    };

    // ---- the laptop page talks back (live.mjs validates and rate-limits): parts on the 3D stage, "analyze this combo" ----
    const stage = { board: null, scan: null, circuit: null }, removedStack = [];
    let stageScope = null, focusPart = null, analysisNo = 0, lastAnalysis = null;
    // Project memory: what the caller BUILT this call (by voice), so the brain never says "I don't see an LED" about a
    // part it added itself. Sent with every brain turn; short (≤ ~600 chars); the brain trusts it over the camera for
    // what exists in the plan, and uses the camera only for what is physically plugged in.
    const projectMemory = () => {
      const lines = [];
      const boardName = lastPart && lastPart !== 'none' ? lastPart : '';
      if (boardName) lines.push(`board recognised: ${boardName}`);
      if (circuit.components?.length) {
        const n = nextStep(circuit), done = circuit.done?.length || 0;
        lines.push(`circuit the caller asked for (by voice): ${describeCircuit(circuit)}`);
        lines.push(n ? `wiring progress: step ${n.index} of ${n.total}, next: ${n.say}` : `wiring: all ${done} steps done`);
      }
      if (removedStack.length) lines.push(`parts removed in the 3D twin: ${removedStack.map(p => p.name).join(', ')}`);
      if (lastAnalysis) lines.push(`last combo verdict: ${lastAnalysis.title} (${lastAnalysis.works ? 'works' : "won't work"})`);
      if (lastScan) lines.push(`last scan: ${lastScan.spec.model_guess || lastScan.spec.name}${lastScan.spec.model_source === 'user' ? ' (the caller confirmed the model)' : ''}`);
      if (!lines.length) return '';
      return `[Project memory from this call. Trust it for what the caller has planned and added. A part added by voice may not be plugged in yet: never say it is missing or that you don't have it; if you can't see it on camera, say it isn't plugged in yet and say where it goes. ${lines.join('; ').slice(0, 900)}]`;
    };
    const stageParts = () => (stageScope && stage[stageScope]?.parts) || [];
    const analyzer = createAnalyzer({ brain });
    const analyzeTurn = async msg => {
      if (!consented() || ended) return;
      const cached = analyzer.cached(msg);
      if (!cached && !budget()) return;
      if (!cached) { usage.brain++; usage.analyses++; }
      const interior = msg.scope === 'scan' ? interiors.get(msg.board.toLowerCase()) || null : null;
      try {
        console.log(`[analysis] ${msg.scope} ${msg.board}: removed ${msg.removed.map(p => p.name).join(', ') || 'nothing'}${cached ? ' (cached)' : ''}`);
        const r = await analyzer.analyze(msg, { interior });
        if (ended) return;
        live.send({ type: 'analysis', id: ++analysisNo, scope: msg.scope, board: msg.board, kept: msg.kept, removed: msg.removed,
          title: r.title, works: r.works, summary: r.summary, pros: r.pros, cons: r.cons, needs: r.needs, verdict: r.verdict, cached: r.cached, ms: r.ms, model: r.model });
        lastAnalysis = r;
        console.log(`[analysis] ${r.works ? 'works' : 'does not work'}: ${r.title} (${r.ms} ms${r.cached ? ', cached' : ''})`);
        say(`${r.summary} Details are on your laptop.`, 0);
      } catch (e) {
        console.warn('[analysis] failed:', e?.message || e);
        say("I couldn't check that combination just now. Try again in a moment.", 0);
      }
    };
    live.onPage?.(msg => {
      if (msg.type === 'parts') { stage[msg.scope] = msg; stageScope = msg.scope; return; }
      if (msg.type === 'analyze') void analyzeTurn(msg);
    });

    // ---- voice control of the laptop's 3D twin (twin-voice.mjs): instant, no brain call ----
    // Sends {type:'twin', action, target?, name?, query?, scope?}. Part actions target an id from the page's 'parts' list.
    const PART_SAY = { remove: n => `Removed the ${n}.`, restore: n => `Put the ${n} back.`, select: n => `There's the ${n}.`, focus: n => `Zooming in on the ${n}.` };
    /** @returns {boolean} true if handled */
    const twinTurn = heard => {
      if (isScanIntent(heard)) return false;
      const cmds = parseTwin(heard);
      if (!cmds) return false;
      const parts = stageParts();
      // "remove the LED" with an LED in the voice circuit: that's the circuit's (circuit.mjs handles it)
      if (cmds[0].action === 'remove' && circuit.components.length && circuitIntent(heard) === 'change' && findComponent(circuit, cmds[0].query)) return false;
      // "show me the X" / "zoom on the X" only when the hologram has an X; otherwise the brain points at it on camera
      if ((cmds[0].action === 'select' || cmds[0].action === 'focus') && !matchPart(cmds[0].query, parts)) return false;
      console.log(`[heard] ${heard} (twin: ${cmds.map(c => c.action + (c.query ? ` ${c.query}` : '')).join(', ')}, no brain call)`); live.send({ type: 'heard', text: heard });
      const lines = [];
      for (const c of cmds) {
        if (!c.query) {
          live.send({ type: 'twin', action: c.action, ...(stageScope ? { scope: stageScope } : {}) });
          if (c.action === 'restore') { removedStack.length = 0; lines.push('Everything is back.'); }
          else if (c.action === 'combine') lines.push("Combining the rest. I'll check whether it still works.");
          else lines.push(c.say);
          continue;
        }
        let hit = c.query === '__it' ? focusPart : c.query === '__last' ? removedStack.at(-1) : matchPart(c.query, parts);
        if (!hit && !parts.length && !c.query.startsWith('__')) {   // no parts list from the page yet: let the page match the words
          live.send({ type: 'twin', action: c.action, query: c.query });
          lines.push(PART_SAY[c.action](c.query));
          continue;
        }
        if (!hit) {
          const have = partList(parts, 5);
          lines.push(c.query.startsWith('__') ? 'Which part? Say its name, like the USB port.' : `I don't see a ${c.query} on the model.${have ? ` It has ${have}.` : ''}`);
          if (c.action === 'remove') return say(lines.join(' '), 0), true;   // don't combine without the part they meant
          continue;
        }
        live.send({ type: 'twin', action: c.action, target: hit.id, name: hit.name, ...(stageScope ? { scope: stageScope } : {}) });
        if (c.action === 'remove') removedStack.push(hit);
        if (c.action === 'restore') { const i = removedStack.findIndex(p => p.id === hit.id); if (i >= 0) removedStack.splice(i, 1); }
        focusPart = hit;
        lines.push(PART_SAY[c.action](hit.name));
      }
      say(lines.join(' '), 0);
      return true;
    };

    const onTurn = async (raw, { addressed = false } = {}) => {
      let heard = raw;
      if (WAKE && !addressed) {
        // While Ody waits for the consent answer, a plain "yes" counts without its name too.
        if (!WAKE_RE.test(raw) && consented()) { console.log(`[heard] ${raw} (not addressed to Ody, ignored)`); live.send({ type: 'heard', text: raw, ignored: true }); return; }
        heard = raw.replace(WAKE_RE, '').trim() || 'Hi';
      }
      // Consent first: nothing below runs (no brain, scans, research, snapshots) until the caller says yes.
      if (!consented()) {
        if (isNoRecord(heard)) gate.stopRecording();
        const { pass, rest } = gate.answer(heard);
        console.log(`[consent] answer heard: ${pass ? 'yes' : gate.state}`);   // not the words: nothing is kept before consent
        if (!pass) return;
        console.log(`[consent] given at ${new Date().toISOString()}`);
        await ensureRun(); void saveConversation();
        if (rest && !ACKS.test(rest)) return onTurn(rest, { addressed: true });   // "yes, scan this": the scan runs now
        return;
      }
      if (isNoRecord(heard)) {   // "stop recording" / "don't save": no snapshot files for the rest of the call
        console.log(`[heard] ${heard} (stop recording)`); live.send({ type: 'heard', text: heard });
        gate.stopRecording();   // publishes {type:'consent', state:'no-recording'} and logs it in conversation.json
        say(NO_RECORDING_SAY, 0); return;
      }
      const fix = lastScan && Date.now() - lastScan.at < 10 * 60_000 ? parseModelCorrection(heard) : null;
      if (fix) {
        console.log(`[heard] ${heard} (model correction: ${fix})`); live.send({ type: 'heard', text: heard });
        if (budget()) await modelFix(fix);
        return;
      }
      if (CIRCUIT_ON && circuit.components.length && isShowHow(heard)) {
        console.log(`[heard] ${heard} (show the current step)`); live.send({ type: 'heard', text: heard });
        await showNext({ speak: true }); return;
      }
      if (twinTurn(heard)) return;
      if (CIRCUIT_ON && !isScanIntent(heard) && await circuitTurn(heard)) return;
      if (ACKS.test(heard.trim())) { console.log(`[heard] ${heard} (acknowledgement, no brain call)`); live.send({ type: 'heard', text: heard }); return; }
      if (last && REPLAY.test(heard.trim())) {
        console.log(`[heard] ${heard} (replay, no brain call)`); live.send({ type: 'heard', text: heard });
        const now = getLatest();
        marks = last.marks; marksAt = Date.now(); marksTtl = MARK_TTL_MS; if (now) tracker.seed(now, marks, last.board);
        say(last.say, 0); return;
      }
      if (!budget()) return;
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
        usage.brain++;
        const memory = projectMemory();
        const reply = await brain.turn(memory ? `${heard}\n${memory}` : heard, image).finally(() => clearTimeout(filler));
        if (seq !== turnSeq || ended) return;   // they spoke again while we were thinking; answer the newer turn
        // Safety: if Ody says "Stop…" about something it marked, make sure the mark shows as a red warning.
        if (/^\s*stop\b/i.test(reply.say || '') && reply.marks.length && !reply.marks.some(m => m.kind === 'warn')) reply.marks[0] = { ...reply.marks[0], kind: 'warn' };
        // drawn on the caller's video only when asked for (or a warning); the laptop still gets every mark below
        const draw = shouldDraw(heard, reply.marks);
        marks = draw ? reply.marks : []; marksAt = Date.now(); marksTtl = MARK_TTL_MS;
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
          recap.push({ step: reply.step, note: reply.note, say: reply.say, image: await stepPicture() });
          await saveRecap();
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
      // One usage line per call (npm run usage sums them): ElevenLabs TTS characters, brain calls by kind.
      console.log(`[usage] call ${callId}: tts_chars=${usage.ttsChars} brain_calls=${usage.brain} scans=${usage.scans} research=${usage.research} analyses=${usage.analyses} hole_lookups=${usage.holes} provider=${brain.provider} consent=${gate?.state || 'none'}${gate?.noRecording ? ' no-recording' : ''}`);
      try {
        if (consented() && (brain.messages.length || recap.length)) {
          await brain.idle();
          await saveRecap();
          await saveConversation();
        }
        if (consented() && brain.messages.length) {
          const log = openSync(`${runDir}recap.log`, 'a');
          const here = fileURLToPath(new URL('.', import.meta.url));
          const child = spawn(process.execPath, ['send-recap.mjs', runDir, ...(process.env.MENTOR_SEND_RECAP === '1' ? [] : ['--no-send'])],
            { cwd: here, detached: true, stdio: ['ignore', log, log], env: process.env });
          child.unref();
        }
      } catch (error) { console.error('[mentor] recap start failed', error?.message || error); }
      console.log(consented() ? `[mentor] call ended; ${recap.length} recap steps in ${runDir}` : `[mentor] call ended without consent; nothing saved`);
      for (const close of [() => session?.close(), () => track.close(), () => source.close(), () => live.close(), () => brain.close?.()]) {
        try { await close(); } catch { /* already closed */ }
      }
    });

    if (TEST_TURN && CONSENT_ON) console.warn('[mentor] MENTOR_TEST_TURN waits for the consent "yes" like any turn; set ODY_CONSENT=0 (owner testing) to run it unattended');
    if (TEST_TURN) {   // test hook: once a camera frame exists, run one scripted turn
      const waitFrame = setInterval(() => { if (raw) { clearInterval(waitFrame); setTimeout(() => void onTurn(TEST_TURN).catch(() => {}), 800); } }, 200);
      ctx.addShutdownCallback(async () => clearInterval(waitFrame));
    }

    if (session) await session.start({
      room: ctx.room,
      agent: new MentorAgent({ onTurn: text => { onTurn(text).catch(e => console.error('[mentor] turn failed', e?.message || e)); } }),
      record: false,
      inputOptions: {
        // Ody's ears: Krisp background-voice cancellation (LiveKit Cloud) keeps the main, closest speaker and removes
        // other voices and room noise before speech-to-text. ODY_NOISE=nc (noise only) or off.
        ...(NOISE === 'off' ? {} : { noiseCancellation: NOISE === 'nc' ? NoiseCancellation() : BackgroundVoiceCancellation() }),
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
    const stopGreeting = greetOnBridgeReady(ctx.room, () => {
      console.log(`[mentor] FaceTime ready: greeting${CONSENT_ON ? ' (asking for consent)' : ''}`);
      caption = CONSENT_ON ? 'Say yes to continue' : 'Show me your project'; live.send({ type: 'step', text: caption });
      say(GREETING); gate.asked();
    });
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

export default agent;

runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'mentor-hackuta' });
