// Mentor: FaceTime an AI that sees your parts, draws where things go on your own live video, and talks you through it.
// Built on Chert's video-agent starter (chert-rooms.mjs, greet.mjs). Caller video in -> overlay -> video out;
// ElevenLabs hears and speaks; Claude Fable 5.2 (brain.mjs) decides what to say and where to point.
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
import { Brain } from './brain.mjs';
import { runAgent } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { FPS, HEIGHT, WIDTH, frameJpeg, render, rotate, snapshotPng } from './overlay.mjs';

// Accept the common alternative names for the same keys.
process.env.ELEVEN_API_KEY ||= process.env.ELEVENLABS_API_KEY;

const GREETING = process.env.MENTOR_GREETING
  || "Hi, I'm Mentor, an AI. Show me what you're building and tell me what you want it to do.";
const TASK = process.env.MENTOR_TASK || '';
const MARK_TTL_MS = 25_000;   // marks fade if nobody talks for a while (camera moved, they are stale)
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

    // ---- caller video in: keep only the newest raw frame; convert + rotate lazily (<=15 fps, not per incoming frame) ----
    let raw = null;          // { frame: VideoFrame, rotation: number } from the current caller track
    let upright = null;      // cached RGBA upright version of `raw`
    let uprightOf = null;
    let currentSid = null;   // only the newest video track is read; older loops exit
    const getLatest = () => {
      if (!raw) return null;
      if (uprightOf !== raw) {
        const rgba = raw.frame.convert(VideoBufferType.RGBA);
        upright = rotate({ data: rgba.data, width: rgba.width, height: rgba.height }, raw.rotation);
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
          raw = { frame: ev.frame, rotation: Number(ev.rotation) || 0 };
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
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('mentor-video', source);
    const frame = () => {
      if (marks.length && Date.now() - marksAt > MARK_TTL_MS) marks = [];
      const px = render(getLatest(), marks, { caption, tick: tick++, speaking });
      source.captureFrame(new VideoFrame(px, WIDTH, HEIGHT, VideoBufferType.RGBA));
    };
    frame();
    await ctx.room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_CAMERA });
    const timer = setInterval(frame, 1000 / FPS);

    // ---- voice: ElevenLabs Scribe (hearing) + ElevenLabs TTS (speaking); no session LLM ----
    const brain = new Brain({ task: TASK });
    let turnSeq = 0, stepNo = 0;
    const recap = [];
    const session = new voice.AgentSession({
      stt: new elevenlabs.STT({ model: 'scribe_v2_realtime', languageCode: 'en' }),
      tts: new elevenlabs.TTS({
        model: 'eleven_flash_v2_5',
        ...(process.env.ELEVEN_VOICE_ID ? { voiceId: process.env.ELEVEN_VOICE_ID } : {}),
      }),
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, ev => { speaking = ev.newState === 'speaking'; });

    let ended = false;
    const say = text => {   // never throws: the call may have ended while the brain was thinking
      if (ended || !text) return;
      try { session.say(text); } catch (error) { console.error('[mentor] say failed', error?.message || error); }
    };
    const onTurn = async heard => {
      const seq = ++turnSeq;
      console.log(`[heard] ${heard}`);
      try {
        const now = getLatest();
        const image = now ? await frameJpeg(now) : null;
        const reply = await brain.turn(heard, image);
        if (seq !== turnSeq || ended) return;   // they spoke again while we were thinking; answer the newer turn
        marks = reply.marks; marksAt = Date.now();
        if (reply.step) caption = reply.step;
        console.log(`[say] ${reply.say}  marks=${JSON.stringify(reply.marks)}`);
        say(reply.say);
        if (reply.note || reply.marks.length) {
          await new Promise(r => setTimeout(r, 150));   // let one frame with the new marks render
          const file = `${runDir}step-${String(++stepNo).padStart(2, '0')}.png`;
          await writeFile(file, await snapshotPng());
          recap.push({ step: reply.step, note: reply.note, say: reply.say, image: file });
          await writeFile(`${runDir}recap.json`, JSON.stringify({ callId, task: TASK, recap }, null, 2));
        }
      } catch (error) {
        console.error('[mentor] brain failed', error?.status || '', error?.message || error);
        if (seq === turnSeq) say('Sorry, I lost my train of thought. Say that again?');
      }
    };

    ctx.addShutdownCallback(async () => {
      ended = true;
      clearInterval(timer);
      ctx.room.off(RoomEvent.TrackSubscribed, maybeVideo);
      ctx.room.off(RoomEvent.TrackUnsubscribed, lostVideo);
      ctx.room.off(RoomEvent.TrackMuted, mutedVideo);
      // Recap first (its own process, so it finishes even if this job is torn down), then close media.
      try {
        if (brain.messages.length) {
          await brain.idle();
          await writeFile(`${runDir}recap.json`, JSON.stringify({ callId, task: TASK, recap }, null, 2));
          await writeFile(`${runDir}conversation.json`, JSON.stringify(brain.messages));
          const log = openSync(`${runDir}recap.log`, 'a');
          const here = fileURLToPath(new URL('.', import.meta.url));
          const child = spawn(process.execPath, ['send-recap.mjs', runDir, ...(process.env.MENTOR_SEND_RECAP === '1' ? [] : ['--no-send'])],
            { cwd: here, detached: true, stdio: ['ignore', log, log], env: process.env });
          child.unref();
        }
      } catch (error) { console.error('[mentor] recap start failed', error?.message || error); }
      console.log(`[mentor] call ended; ${recap.length} recap steps in ${runDir}`);
      for (const close of [() => session.close(), () => track.close(), () => source.close()]) {
        try { await close(); } catch { /* already closed */ }
      }
    });

    await session.start({
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
    const stopGreeting = greetOnBridgeReady(ctx.room, () => { caption = 'Show me your project'; say(GREETING); });
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

export default agent;

runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'mentor-hackuta' });
