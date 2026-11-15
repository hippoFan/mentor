# QA: agent pipeline (no FaceTime), 11-14 night

Fake caller on LiveKit + the real brain (claude-code, 6 calls) + ElevenLabs (2 utterances).

## Fixed after this report
- **HIGH:** `startLive()` threw an uncaught EADDRINUSE when the monitor port was still held by the previous call's job.
  The whole call died with no video. Fixed with `wss.on('error')` + `server.on('error')`;
  `test/qa/port-busy.mjs` now passes.
- **COSMETIC:** swapped comments in agent.mjs.

## Open (low)
- A spoken warning without a `warn` mark (model-dependent) means no red ring.
- When the camera drops, LiveKit sends 8×8 frames for a moment, and a turn in that window sends a tiny image to the brain.
- A turn with no camera still calls the brain without an image.
- Replay ignores the overlay policy.
- board-test's frame-budget check fails under CPU load (render + tracker ~10–14 ms vs a 10 ms budget). Accuracy passes.

## Passed
- **Suites:** track (1.57 px, 1.9 ms), parts 80/80, recap, scan, overlay-policy 10/10, twin-gestures 8/8.
- **e2e with voice:**
  - video is 720×1280 at 22–24 fps
  - audio is −17.6 to −28.6 dBFS, 11 s audible
  - the USB-port mark landed on the port
- **Behaviour:**
  - no marks on a non-pointing turn
  - "okay" and replay skip the brain
  - "scan this" produces a scan (UNO R3, 12 parts, 9.5 s)
  - the monitor's Origin/Host checks and client cap hold
  - the recap is complete
  - brain failure gives a spoken fallback in 109–257 ms
  - 5 rapid turns cause no crash
  - camera off/on recovers
  - a hang-up mid-thought shuts down cleanly
- **Numbers:** brain 2.9 s per turn (Sonnet via claude-code), scan 9.5 s, filler at 1.5 s.
