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

## Caller consent and the page channel
- Ody asks the caller to agree before any frame or snapshot is processed or saved (`consent.mjs`); "stop recording"
  stops snapshots for the rest of the call. Call folders are deleted after 7 days. See [PRIVACY.md](PRIVACY.md).
- The laptop page can send two things back to the agent: the parts on its 3D stage and "analyze this combo". Both are
  Origin-checked, schema-validated (≤200 parts, names ≤60 chars) and rate-limited, and they never reach a shell or a URL.

## Secrets
- Keys live in `.env`, which is git-ignored. Only `env.example` is committed.
- `npm run check-keys` verifies keys without printing them and without spending model requests.

## Reporting a vulnerability
Please open a private GitHub security advisory on this repo rather than a public issue.
