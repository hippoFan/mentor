// End-to-end video test on your LiveKit project, no Chert or phone needed:
//   npm run e2e -- <photo.jpg> [outDir]
// Starts a dispatch of AGENT_NAME into a fresh room, joins as a fake caller that streams the photo as its camera,
// and saves what Mentor publishes back (out-*.png). Run the agent first in another terminal:
//   MENTOR_TEST_TURN="how do I make it blink?" npm start   (or `npm run dev-agent`)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import {
  LocalVideoTrack, Room, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream,
} from '@livekit/rtc-node';

const [photo, outDir = '.'] = process.argv.slice(2);
if (!photo) { console.error('usage: npm run e2e -- <photo.jpg> [outDir]'); process.exit(2); }
const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
const agentName = process.env.AGENT_NAME || 'mentor-hackuta';
const host = url.replace(/^wss?:\/\//, 'https://');
const roomName = `mentor-e2e-${randomBytes(4).toString('hex')}`;
const SECONDS = Number(process.env.E2E_SECONDS || 30);
await mkdir(outDir, { recursive: true });

// The photo, letterboxed into a 1280x720 "phone camera" frame.
const img = await loadImage(await readFile(photo));
const W = 1280, H = 720, cam = createCanvas(W, H), cg = cam.getContext('2d');
const s = Math.min(W / img.width, H / img.height);
const camFrame = shake => {
  cg.fillStyle = '#222'; cg.fillRect(0, 0, W, H);
  cg.drawImage(img, (W - img.width * s) / 2 + shake, (H - img.height * s) / 2, img.width * s, img.height * s);
  return new Uint8Array(cg.getImageData(0, 0, W, H).data.buffer);
};

const dispatch = await new AgentDispatchClient(host, key, secret).createDispatch(roomName, agentName);
console.log(`[e2e] room ${roomName}, dispatched "${agentName}" (${dispatch.id})`);

const at = new AccessToken(key, secret, { identity: 'chert-bridge-e2e', ttl: '10m' });
at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
const room = new Room();
await room.connect(url, await at.toJwt(), { autoSubscribe: true, dynacast: false });
console.log('[e2e] fake caller joined');

const src = new VideoSource(W, H);
const track = LocalVideoTrack.createVideoTrack('facetime-remote-video', src);
await room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_CAMERA });
let t = 0;
const pump = setInterval(() => src.captureFrame(new VideoFrame(camFrame(Math.round(Math.sin(t++ / 8) * 3)), W, H, VideoBufferType.RGBA)), 1000 / 15);

let saved = 0, got = 0, firstAt = 0;
const shots = [3, 8, 12, 16, 20, 25].map(x => x * 1000);
room.on(RoomEvent.TrackSubscribed, async (trk, _pub, participant) => {
  if (trk.kind !== TrackKind.KIND_VIDEO) return;
  console.log(`[e2e] receiving Mentor's video "${trk.name}" from ${participant.identity}`);
  const start = Date.now();
  for await (const ev of new VideoStream(trk)) {
    got++; if (!firstAt) firstAt = Date.now();
    if (saved < shots.length && Date.now() - start >= shots[saved]) {
      const f = ev.frame.convert(VideoBufferType.RGBA);
      const c = createCanvas(f.width, f.height);
      c.getContext('2d').putImageData(new (await import('@napi-rs/canvas')).ImageData(new Uint8ClampedArray(f.data.buffer, f.data.byteOffset, f.width * f.height * 4), f.width, f.height), 0, 0);
      const file = `${outDir}/out-${String(shots[saved] / 1000).padStart(2, '0')}s.png`;
      await writeFile(file, await c.encode('png'));
      console.log(`[e2e] saved ${file} (${f.width}x${f.height})`);
      saved++;
    }
  }
});

await new Promise(r => setTimeout(r, SECONDS * 1000));
clearInterval(pump);
console.log(`[e2e] done: ${got} frames received from Mentor, ${saved} saved`);
await room.disconnect();
await new RoomServiceClient(host, key, secret).deleteRoom(roomName).catch(() => {});
process.exit(got ? 0 : 1);
