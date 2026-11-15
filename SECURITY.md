# Security and privacy

Ody is a hackathon project (HackUTA 2026), not a production service.

## What Ody handles
- Live camera video and voice from the person who FaceTimes the Ody line.
- Speech transcripts and what Ody said.
- Images of your project, which also show whatever else is in view (including other people).

## Who receives it
- **ElevenLabs:** audio, for speech-to-text and Ody's voice.
- **Your configured brain:** camera frames and transcripts go to Google (Gemini) or Anthropic (Claude API).
- **Chert and LiveKit:** carry the call's video and audio.
- Ody says it is an AI in its greeting. It never calls a circuit "safe", tells you to unplug power before rewiring,
  and tells you to stop and ask a qualified person for mains voltage, damaged batteries or anything hot.

## Where it is stored
- **On the host laptop only**, in `runs/<call>/`, which is git-ignored. It holds:
  - camera snapshots every 3 s (for testing)
  - the annotated step images
  - `conversation.json`
  - the recap page

  Delete `runs/` after the event.
- **Live laptop screen:** at http://localhost:8790. It binds to 127.0.0.1 and accepts only its own page (Host and
  Origin checks), so other websites can't read the live camera.
- **Recap pages:** served only through a tunnel you start yourself (`npm run recaps` + `cloudflared`). Links use a
  random id and expire after 24 h. An unlisted link is not access control, so stop the tunnel when you're done.
- **Recap iMessage:** off by default (`ODY_SEND_RECAP=1`), and sent only to the configured, verified number.

## Model output is untrusted
- **What the brain can return:** only JSON (what to say, where to point, the step). Nothing it returns is executed or
  fetched.
- **Cleaning and escaping:**
  - Replies are capped and cleaned: URLs and control characters are stripped.
  - The screen uses `textContent`.
  - The recap HTML is escaped.
- **Injection:** Ody is told that text on camera or speech from bystanders is information, never instructions. Even
  so, a determined person in view can influence what it says.
- **Recap code:** review any code from a recap before you flash it to real hardware.

## Subscription testing boundary
`ODY_BRAIN=claude-code` runs the local Claude Code CLI on the **owner's own Claude subscription**, for the owner's
own testing only.
- **Off by default.** It also refuses to start unless `ODY_OWNER_TESTING=1` is set.
- **Locked down:**
  - no tools, MCP servers, settings, hooks or skills
  - no saved session
  - only basic environment variables passed
- **Never for anyone else.** It must not serve judges, users or the public. Their calls use an API key
  (`ODY_BRAIN=gemini` or `claude`).
- **Argos too, same boundary.** `ODY_BRAIN=claude-code ODY_OWNER_TESTING=1 ./demo.sh` also gives the hub
  `MENTOR_OWNER_TESTING=1`, so Argos (the laptop assistant) lists a `claude-code` model, labelled
  "Claude (owner's subscription — testing)", and tries it first (then Gemini, then the rest). It is the same locked-down
  `claude -p` (`agent/claude-code-cli.mjs`, shared with the call brain): no tools, MCP, settings, hooks, skills or slash
  commands, no saved session, an allowlisted environment with none of Ody's keys, an empty temp folder, killed on its
  timeout. Without the flag in the hub's environment it is not listed and refuses to run. Any other `./demo.sh` start
  strips the flag from the hub (keep `MENTOR_OWNER_TESTING` out of `.env`). This extends owner testing to Argos; it is
  still **never** for a public deployment, judges or users.

## Caller consent and the page channel
- Ody asks the caller to agree before any frame or snapshot is processed or saved (`consent.mjs`); "stop recording"
  stops snapshots for the rest of the call. Call folders are deleted after 7 days. See [PRIVACY.md](PRIVACY.md).
- The laptop page can send two things back to the agent: the parts on its 3D stage and "analyze this combo". Both are
  Origin-checked, schema-validated (≤200 parts, names ≤60 chars) and rate-limited, and they never reach a shell or a URL.

## Argos (laptop assistant)
- Routes live under `/argos/` on the same 127.0.0.1 page server: Host-checked, and every non-GET must carry the page's
  own Origin. Design files are served with `nosniff`, `no-store` and same-origin CORP.
- Model-written OpenSCAD is compiled by OpenSCAD's WASM build in a worker thread: no shell, an in-memory file system
  only (no host files), `include`/`use`/`import`/`surface` refused, 60 000-character cap, 20 s time limit.

## Secrets
- Keys live in `.env`, which is git-ignored. Only `env.example` is committed.
- Keys can be entered on the Main page (`POST /argos/keys {name, value}`, `agent/argos/keys.mjs`), locked down: only this
  page's Origin and Host, same-origin fetches, JSON of 2 KB or less, a fixed allowlist of names (Gemini, Anthropic,
  OpenAI-compatible key/base URL/model, ElevenLabs; never Chert), one-line values from a fixed character set with length
  caps, and a base URL that may point only at `https://api.openai.com`, `https://api.aisa.one` or `http://127.0.0.1` /
  `http://localhost` (never Ody's own ports 8789/8790; the same check runs again before every model call, so a hand-edited
  `.env` can't point the key elsewhere). `''` clears a key. Only keys of 24+ characters show their last 4. The `.env` write is atomic (temp file + rename), keeps every other line, and is
  mode 600. Entry is write-only: the page reads back whether a key is set and its last 4 characters, never the key, and
  values are never logged.
- `npm run check-keys` verifies keys without printing them and without spending model requests.

## Reporting a vulnerability
Please open a private GitHub security advisory on this repo rather than a public issue.
