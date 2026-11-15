<div align="center">

<img src="docs/ar-wire.gif" alt="Ody drawing an AR wire into pin 13 on a live camera view of an Arduino, staying locked to the board as the camera moves" width="640">

# Ody

**FaceTime an AI that can see your project and point at it.**

You call it from the normal FaceTime app. It looks through your camera, draws on *your own live video*,<br>
talks you through the build one step at a time, builds a 3D hologram twin on your laptop that you can take apart with your hands, and texts you a voyage log when you hang up.

[![HackUTA 2026](https://img.shields.io/badge/HackUTA-2026-1D1D1F?style=flat-square)](#built-at-hackuta-2026)
[![FaceTime via Chert](https://img.shields.io/badge/FaceTime-via%20Chert-1D1D1F?style=flat-square)](https://www.trychert.com)
[![LiveKit Agents](https://img.shields.io/badge/LiveKit-Agents-1D1D1F?style=flat-square)](https://github.com/livekit/agents-js)
[![ElevenLabs](https://img.shields.io/badge/ElevenLabs-voice-1D1D1F?style=flat-square)](https://elevenlabs.io)
[![Gemini](https://img.shields.io/badge/Gemini-brain-1D1D1F?style=flat-square)](https://ai.google.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-FFC845?style=flat-square)](LICENSE)

[Watch the film](docs/ody-film.mp4) · [How it works](#how-it-works) · [Features](#features) · [Run it](#run-it) · [Security](SECURITY.md)

</div>

---

> *In the Odyssey, a goddess disguised herself as an old friend to guide a lost young man home. His name was Mentor.*

## The idea

When you're stuck on something physical, like a first Arduino, a loose wire or a kit with no manual, instructions
and videos can't see *your* parts, and a chatbot can't point. The person who could help is rarely sitting next to you.

Ody is that person, on a FaceTime call:

1. **You FaceTime it.** It's a plain FaceTime Video call from an iPhone. There's no app to install.
2. **It asks to see your parts** and works out exactly what you have (an UNO R3 is not an UNO R4).
3. **It points on your own video.** Rings, labels and wires land on the real port, LED or pin, and stay on them as you move.
4. **It talks you through it**, one short step at a time, and checks each step on camera before moving on.
5. **It texts you a voyage log** when you hang up: every step with its annotated picture, your final code, and a runnable simulator project.

<table>
<tr>
<td width="50%"><img src="docs/real-overlay.jpg" alt="Ody's real overlay on an Arduino Uno: rings and labels on the USB port and the L LED"><br><sub><b>Real model output.</b> Gemini found the USB port and the L LED; Ody's overlay drew them.</sub></td>
<td width="50%"><img src="docs/laptop-screen.jpg" alt="Ody's live laptop screen: the caller's view, the current step and the conversation"><br><sub><b>The laptop screen</b> at <code>localhost:8790</code> mirrors the call for judges (shown with mock data).</sub></td>
</tr>
</table>

## The Odyssey, mapped

| In Homer | In Ody |
|---|---|
| Telemachus, young and stuck, not knowing where to start | You, holding a board you've never used |
| Athena arrives *disguised* as Mentor, an old friend | An AI that arrives as an ordinary FaceTime contact: no app, no new interface |
| She doesn't sail the ship for him; she shows him what to do next | Ody never does the build. It points at the next thing on *your* camera and waits for you |
| The voyage, one island at a time | The build, one leg at a time, each one checked on camera |
| *Nostos*, the homecoming | "Done. You made it home." The LED blinks, and the voyage log arrives |

**Every Telemachus deserves a Mentor.**

## Features

| | |
|---|---|
| **AR marks that stick** | Rings and labels follow each part as your phone moves: a pyramidal Lucas-Kanade tracker in plain JS, with no dependencies. Synthetic handheld test: 1.6 px mean error at about 1 ms per frame. |
| **AR wires on the exact hole** | "Where does this wire go?" On an Arduino UNO (R3 / R4 WiFi), Ody registers the board from its 4 corners, snaps them to the real header holes, and draws a holographic 3D jumper from the exact pin hole, arcing up out of the board and staying registered as the phone moves (`board.mjs`). |
| **3D hologram on your laptop** | The board Ody recognises appears at `localhost:8790/twin` as an Iron Man-style hologram: Ody's rings and holographic jumpers in 3D between the exact holes, explode view (E), hover any pin for its name and function, export the scene as `.glb`. Hand control: pinch to rotate and pinch to grab, tracked on the laptop with MediaPipe, and the video never leaves it. |
| **Scan anything** | "Scan this" turns whatever is on camera into an approximate 3D model (an AI-built shape assembly with your photo wrapped on), shown in the hologram and exportable. Known boards use their exact model. Labelled as an AI estimate from one view. |
| **Parts library** | 18 boards and modules with exact pin maps (Arduino UNO, Mega, Nano; ESP32; Raspberry Pi 4 and Pico; NodeMCU; breadboard; HC-SR04, DHT22, SG90, MPU6050…), imported from Wokwi and Fritzing by `tools/import-parts.mjs`. |
| **Any board, even custom** | Library boards (UNO, Mega, Nano, ESP32, Raspberry Pi 3/4/5, Pico, NodeMCU) get pin-exact wires. On a custom PCB, Ody reads each header (2.54 mm grid + silkscreen labels), snaps every hole to the real one, and wires to it. |
| **Voice controls the hologram** | "Explode it", "put it back together", "rotate it", "reset the view", "make it look real", "export the model": instant, with no model call. |
| **Always-on laptop page** | `hub.mjs` keeps `localhost:8790` up between calls; each call streams into it live (token-gated, local only). |
| **Clean view by default** | Your phone shows just your camera. Ody draws only when you ask where, what, or how to connect something, and marks fade after about 10 s. Safety warnings always show. |
| **Stop signs** | It circles a short, a missing resistor or reversed polarity in red and says "Stop," before you power on. |
| **Knows your exact board** | It identifies the part first (UNO R3 USB-B vs UNO R4 USB-C) and points at *that* board's layout. |
| **"Show me again"** | Instantly re-shows the last marks and repeats the last line, with no model call. |
| **Your language** | `ODY_LANG=auto`: speak Spanish or Hindi and Ody answers in it. |
| **Portrait, full-screen** | It finds your real picture inside FaceTime's frame, drops the self-view, and sends portrait video back that fills your phone. |
| **Voyage log** | After the call: the steps as legs of a journey, each with its annotated picture, ending in "Home". It also writes `sketch.ino` and `diagram.json` for the Wokwi simulator. |
| **Laptop screen + tester panel** | Judges see the call live. Press **T** to see what Ody sees, where it pointed, latency per answer, the model and the frame rate. |
| **Asks first** | Before it sees anything, Ody says what it uses (Google, ElevenLabs, LiveKit) and waits for "yes". Nothing is sent to a model, scanned or saved until then; "stop recording" stops snapshots. Notice at [`PRIVACY.md`](PRIVACY.md) and `localhost:8790/privacy`. |
| **Hears you, not the room** | Background-voice cancellation (Krisp, via LiveKit) keeps the closest speaker before speech-to-text. Optional wake word (`ODY_WAKE=1`): Ody only acts on sentences that start with "Ody, …". |
| **Remembers your build** | Every turn carries the project so far: parts you added by voice and their pins, wiring progress, removed parts, edits, the confirmed model. Ask "where's my LED?" before plugging it in and Ody says it isn't plugged in yet and circles pin 6. |
| **Voice circuit builder** | "Ody, add a distance sensor." It picks safe pins (no shorts, a resistor on every LED, one part per pin), shows the build on a 3D breadboard with neon jumpers, writes the Arduino sketch, and guides you one wire at a time ("done" → next). On your phone it draws the wire from the exact board pin to the breadboard hole. |
| **Parts to get** | Ask for something Ody can't model yet ("add a buzzer") and it goes on a checklist with the suggested part and how to wire it. "I have the buzzer" ticks it off; "what do I still need?" reads the list. |
| **Exact model + researched insides** | A scan guesses the exact model from visible cues ("Galaxy S23 Ultra, about 60% sure, from the four-lens column"); "it's actually an S24" corrects it. Ody then researches what's inside (public teardowns, sources kept) so the explode view shows the real layers in teardown order. Labelled "Researched estimate". |
| **Take it apart, rebuild it** | After an explode, every part is real and movable (mouse or pinch). Remove parts ("remove the Wi-Fi module"), edit them ("change the tip to a brush", "make the clip gold"), then "combine": the rest snaps back together and Ody judges the new design: works or not, pros, cons, what it needs. **B** flips before/after. |
| **Hand control** | MediaPipe on the laptop: a live hand cursor, pinch to grab and turn, two hands to zoom, flick to remove, thumbs-up to combine, fist to reset. Ignores people behind you. The hand video never leaves the laptop. |
| **Backup demo + watchdog** | `npm run watchdog -- --arm 60` watches the hub, agent and line, and replays a real recorded call (honestly badged "Replay") if a live call can't happen. Every rehearsal call is recorded on the laptop. |
| **Robust brain** | Gemini, Claude, or (owner testing only) Claude Code. On a rate limit it falls through Gemini models. Acknowledgements like "okay" skip the model. |

<table>
<tr>
<td width="50%"><img src="docs/film-2.6.jpg" alt="Film opening: In the Odyssey, a goddess disguised herself as an old friend"></td>
<td width="50%"><img src="docs/tester-panel.jpg" alt="Tester panel: connection, brain, latency bars and what Ody sees with its marks"><br><sub>The tester panel (press <b>T</b>), shown with mock data.</sub></td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="docs/twin-hologram.jpg" alt="Ody's 3D digital twin: a cyan hologram of an Arduino UNO R4 WiFi with a holographic jumper from pin 13 to a breadboard"><br><sub><b>The 3D twin</b> at <code>/twin</code>: Ody's marks and wires in 3D (mock replay).</sub></td>
<td width="50%"><img src="docs/scan-multimeter.jpg" alt="A scanned multimeter rebuilt as a 3D hologram with labelled parts"><br><sub><b>Scan anything:</b> a multimeter from one camera view, about 13 s (AI estimate).</sub></td>
</tr>
</table>

## How it works

```mermaid
flowchart LR
    P["iPhone<br/>FaceTime Video"] <-->|Chert| R(("LiveKit<br/>room"))
    R -->|caller video| C["crop to your picture<br/>+ AR tracker"]
    R -->|caller voice| S["ElevenLabs Scribe<br/>speech → text"]
    C --> B{{"Brain: Gemini / Claude<br/>what to say · where to point"}}
    S --> B
    B -->|marks · wires · step| O["overlay<br/>tracked rings, labels, wires"]
    C --> O
    O -->|portrait video, 24 fps| R
    B -->|reply| T["ElevenLabs TTS"] -->|voice| R
    B -.->|after the call| X["voyage log<br/>+ Wokwi project"]
```

- **[Chert](https://www.trychert.com)** gives the agent a real Apple line. It answers FaceTime, bridges the call into a
  [LiveKit](https://livekit.io) room, and sends iMessages.
- **The agent** (Node, `@livekit/agents`) reads the caller's camera and keeps only the newest frame. It crops away
  FaceTime's bars and self-view, and publishes its own portrait video track: your picture with Ody's tracked marks on top.
- **ElevenLabs** listens (Scribe v2 realtime) and speaks (Flash v2.5).
- **The brain** gets what you said plus the frame from the moment you finished speaking, and returns structured JSON:
  - what to say
  - where to point (circles, arrows, wires, warnings)
  - the current step
  - a note for the log

  It's called once per spoken turn, never per frame. Between answers, the tracker keeps the marks on their parts.

## Run it

**You need:**
- Node 22.23+ / 24 / 26
- an iPhone with FaceTime
- a [Chert](https://www.trychert.com) line (free trial)
- a LiveKit Cloud project (free)
- an ElevenLabs key
- a Gemini key (free in Google AI Studio) or an Anthropic API key

```sh
git clone https://github.com/hippoFan/ody && cd ody
cp env.example .env              # fill it in; never commit .env
cd agent && npm install
npm run fetch-models             # optional: the depth model for scan reliefs (Depth Anything V2 Small, 27 MB, sha256-checked)
npm run check-keys               # verifies every key without printing it or spending model requests

npm start                        # terminal 1: the agent
chert setup --env-file ../.env --project <project-id>    # terminal 2, once (chert = npx @trychert/facetime@0.1.0-beta.21)
chert dev --agent <your AGENT_NAME>
```

FaceTime **Video** the number `chert dev` shows, and open **http://localhost:8790** on the laptop.

<details>
<summary><b>Test without a phone</b></summary>

```sh
npm run usage                                               # ElevenLabs characters used + per-call counts
npm run watchdog -- --arm 60                                # judging: status board + automatic backup demo
npm run replay -- logs/sessions/<file>.jsonl                # replay a recorded call into the laptop page
npm run try-brain -- photo.jpg "where is the USB port?"   # one brain answer drawn on a photo
ODY_TEST_TURN="what is this board?" npm start            # terminal 1
npm run e2e -- photo.jpg ./e2e-out                          # terminal 2: a fake caller streams the photo, saves Ody's
                                                            # frames and measures Ody's audio loudness
node test/track-test.mjs                                    # AR tracker accuracy + speed
node test/recap-test.mjs                                    # voyage log, escaping, recap server hardening
node test/mock-monitor.mjs                                  # the laptop screen with a replayed call, on :8799
```
</details>

<details>
<summary><b>Configuration</b> (all in <code>.env</code>, see <a href="env.example"><code>env.example</code></a>)</summary>

Settings are named `ODY_*`. The older `MENTOR_*` names still work.

| Variable | Required | What it is |
|---|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | yes | One LiveKit project, the same one `chert setup` uses |
| `AGENT_NAME` | yes | Unique dispatch name, also passed to `chert dev --agent` |
| `ELEVENLABS_API_KEY` | yes | ElevenLabs key with Text to Speech + Speech to Text |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | one of them | The brain |
| `ODY_BRAIN` | no | `gemini`, `claude`, or `claude-code` (**owner testing only**, also needs `ODY_OWNER_TESTING=1`; see [SECURITY.md](SECURITY.md)) |
| `ODY_GEMINI_MODELS` | no | Models to fall through on rate limits (default `gemini-3.5-flash,gemini-3.5-flash-lite,gemini-2.5-flash`) |
| `ODY_TASK` | no | What Ody guides, e.g. `Make the Arduino's onboard LED blink` |
| `ODY_LANG` | no | `en` (default) or `auto` (answer in the caller's language) |
| `ODY_OUT` / `ODY_FPS` | no | `portrait` (default, 540×960) or `landscape`; frames per second back into the call (default 24) |
| `ODY_OVERLAY` | no | `demand` (default): the caller's video stays a plain camera; marks appear only when they ask where/what/show/connect (or for a safety warning) and fade after 10 s. `always`: the old always-on overlay (step caption, voice bars, every mark) |
| `ODY_SHOW_SPEAKING` | no | `1` shows Ody's voice bars on the caller's video |
| `ODY_SCAN_EFFORT` | no | Effort for "scan this" 3D scans (default `medium`) |
| `ODY_MAX_TURNS` | no | Brain calls per call before Ody wraps up (default 60) |
| `ODY_CONSENT` | no | `1` (default): ask the caller to agree before anything is processed. `0` skips it (owner testing only) |
| `ODY_WAKE` | no | `1`: Ody only answers sentences that start with "Ody, …" (recommended in noisy rooms) |
| `ODY_NOISE` | no | `bvc` (default, background-voice cancellation), `nc` (noise only) or `off` |
| `ODY_RESEARCH` / `ODY_RESEARCH_WEB` | no | Researched interiors after a scan (default on) / allow a web search for them (default off) |
| `ODY_CIRCUIT` | no | Voice circuit builder (default on) |
| `ODY_KEEP_DAYS` | no | Delete local call folders older than this (default 7) |
| `ELEVEN_VOICE_ID`, `ODY_GREETING` | no | Ody's voice and first line |
| `CHERT_API_KEY`, `CHERT_PROJECT_ID`, `ODY_RECAP_TO`, `ODY_PUBLIC_URL`, `ODY_SEND_RECAP=1` | for the iMessage recap | Off unless `ODY_SEND_RECAP=1` |
</details>

<details>
<summary><b>Project layout</b></summary>

```
agent/
  agent.mjs            the call: camera in, tracked marks out, voice, snapshots, stats
  brain.mjs            prompt, schema, output sanitiser, brain picker (+ Claude API brain)
  brain-gemini.mjs     Gemini brain with model fallback
  brain-claude-code.mjs  owner-testing brain on the local Claude Code CLI (locked down)
  overlay.mjs          what the caller sees: crop, rings, labels, AR wires, warnings
  tracker.mjs          pyramidal Lucas-Kanade point tracker (no deps)
  board.mjs            UNO registration: homography + pose from 4 corners, hole snapping, 3D jumper geometry
  data/uno-pins.json   UNO header hole positions (from wokwi-elements, MIT)
  live.mjs, monitor.html   the laptop screen (local only, Origin/Host checked)
  recap.mjs, send-recap.mjs, serve-recaps.mjs   voyage log, Wokwi files, iMessage
  headers.mjs          custom PCBs: read headers on a 2.54 mm grid, snap to the real holes
  scan.mjs, research.mjs   scan anything; exact model guess; researched interiors (cached)
  circuit.mjs, connect.mjs   voice circuit builder; phone-side "how to connect it" wires
  twin-voice.mjs, modify.mjs, combo.mjs, checklist.mjs, memory.mjs   voice part control, edits, build analysis, parts list, project memory
  consent.mjs          the consent gate, "stop recording", 7-day retention
  hub.mjs              always-on laptop page (token-gated publish, page -> agent channel)
  watchdog.mjs, replay.mjs, record.mjs, build-backup.mjs   judging-day safety net
  twin.html, twin/     the laptop app: hologram, parts, interiors, circuit, hands, edits
  check-keys.mjs, status.mjs, usage.mjs   key, line and usage checks
  chert-rooms.mjs, greet.mjs   from Chert's video-agent starter
  test/                e2e fake caller, tracker, recap, dashboard mock
docs/                  README media and the film
```
</details>

<details>
<summary><b>Design notes</b></summary>

- **Point at what it can see, ask for the rest.** Ody never guesses a pin it can't see. It asks you to move closer.
- **One model call per turn, not per frame.** The tracker carries the marks between answers.
- **Greets on time.** FaceTime hangs up on an agent that's silent for 10 s, so the greeting is a fixed line spoken the
  moment Chert reports the bridge is ready.
- **Model output is data.** Replies are capped and cleaned, nothing is executed, and text seen on camera is never treated as an instruction.
- **The voyage log survives the hang-up.** It's built in its own process.
- **Measured, not guessed:** per-frame cost is about 6 ms (crop, track, render), Ody's voice measures about −20 dBFS,
  and video stats are logged every 5 s.
</details>

## Security and privacy

See **[SECURITY.md](SECURITY.md)** and the caller-facing **[PRIVACY.md](PRIVACY.md)**. In short:
- Ody asks the caller to agree before anything is processed, and "stop recording" stops snapshots.
- Audio and frames go to ElevenLabs and your chosen brain.
- Everything else stays on the host laptop in `runs/`, deleted after 7 days.
- The laptop screen accepts only its own page, and recap links expire after 24 h.
- Model output is untrusted.
- The `claude-code` brain is for the owner's own testing only.

## Limits

- Chert's free trial allows calls of up to 5 minutes, and a line handles one call at a time.
- FaceTime routes the video through Chert's Mac and LiveKit, which adds roughly half a second each way.
- Gemini's free tier allows about 20 requests a day per model. Use a paid key for a full demo day.
- Pin-level pointing on tiny headers depends on how close and how sharp the camera is.
- Scanned objects and researched interiors are estimates, and are labelled that way. Library boards are exact.
- The circuit builder models about 10 common parts; anything else goes on the parts checklist.

## Built at HackUTA 2026

Built for the theme *Homer's Odyssey*, for **Best Use of FaceTime (Chert)** and **Best Use of ElevenLabs**.

**Built with:** Chert · LiveKit Agents (+ Krisp background-voice cancellation) · ElevenLabs (Scribe v2 realtime, Flash v2.5) ·
Gemini · Claude · three.js · MediaPipe Tasks Vision · @napi-rs/canvas · Node.js · [HyperFrames](https://github.com/heygen-com/hyperframes) (the film)

## License

MIT for Ody's own code ([LICENSE](LICENSE)), with these exceptions:
- `agent/chert-rooms.mjs` and `agent/greet.mjs` come from Chert's starter, and Chert's terms apply.
- Inter is under the SIL Open Font License, and the MediaPipe hand and interactive-segmenter models are under Apache-2.0.
- Scan reliefs use Depth Anything V2 Small (Apache-2.0; the larger checkpoints are non-commercial and not used) via onnxruntime-node (MIT); see `agent/models/LICENSES.md`.
- Parts pin data comes from wokwi-elements (MIT) and Fritzing (CC-BY-SA 3.0); see `agent/data/parts/LICENSES.md`.
- `agent/data/uno-pins.json` pin names/positions derive from [wokwi-elements](https://github.com/wokwi/wokwi-elements) (MIT, Copyright (c) 2019 Uri Shaked).
- The film and README images use a public-domain (CC0) Arduino photo from Wikimedia Commons.
