# Argos (laptop assistant, Forge store, refinement)

Argos is the guide dog in the bottom-right corner of the **Argo** page. It runs inside the always-on hub (`hub.mjs`) on the
laptop page's own server, under `/argos/`. It is separate from the FaceTime call: the call uses Chert and Ody's brain,
while Argos uses its own model key (Gemini by default).

| File | Job |
|---|---|
| `server.mjs` | HTTP routes, refinement jobs, saving each call's scans to the Forge |
| `chat.mjs` | Chat mode. Routes each request to one of four places (see below). |
| `refine.mjs` | Refinement: `single`, or `multicode` (manager, researcher, developer, auditor) |
| `scad.mjs` | Scan to OpenSCAD, code checks, and OpenSCAD WASM compiles to STL (in a worker, with a time limit) |
| `forge.mjs` | Design store in `designs/` (git-ignored): scans, refined versions, imports |
| `providers.mjs` | Gemini (default), Claude, and any OpenAI-compatible API |
| `keys.mjs` | Keys for the Main page: write-only entry into `.env` (allowlisted names, validated values, atomic, mode 600); reads back set + last 4 only |
| `stt.mjs` | Record button: ElevenLabs Scribe. Wispr Flow works with no setup because it types into the text box. |
| `../twin/argos.js` | The panel: plain styling, every element starts with `argos-` |

How chat mode routes a request:

1. **View and part commands** go straight to the 3D stage, with no model call.
2. **Circuit changes** are built on the model.
3. **Real-board steps** are given only when the user asks for them.
4. **Anything else** is answered by the model, which may also start a refinement.

## Rules

- Everything Argos changes is **digital**. It walks the user through the real board only when they ask ("walk me through it").
- Files imported from the user's computer are marked `outside: true` and show a note. Ody can view and export them, but it
  can't promise AI edits of CAD made elsewhere. A mesh with no OpenSCAD source is refused for refinement, with that reason.
- Model-written OpenSCAD is untrusted. `include`, `use`, `import` and `surface` are refused, and the code is size-capped and
  compiled in a worker with a 20 s limit.
- Requests that change anything must come from the page's own Origin, and the server listens on 127.0.0.1 only.

## API

| Method and path | Body | Returns |
|---|---|---|
| `GET /argos/state` | | `{providers:[{id,name,ready,model}], keys, call, designs, modes, counts}` |
| `POST /argos/chat` | `{text, provider?, designId?}` | `{kind:'reply', text, route: twin\|circuit\|physical\|chat, refineJob?}` |
| `POST /argos/stt` | raw audio (`audio/webm`, `ogg`, `mp4`, `wav`) | `{text, language, ms}` |
| `POST /argos/refine` | `{designId, instruction, mode: single\|multicode, provider?, code?}` | `202 {jobId}` |
| `GET /argos/designs` | | `{designs:[meta]}`, newest first |
| `GET /argos/designs/<id>/<file>` | add `?download` to save the file | the file |
| `POST /argos/designs/<id>/compile` | | builds an STL from the design's source and saves it as a new version |
| `DELETE /argos/designs/<id>` | | |
| `POST /argos/import?name=<file>` | raw `.stl` / `.obj` / `.glb` / `.scad` file, 15 MB max | `{design}` |
| `GET /argos/keys` | | `{keys:[{name, label, group, set, settable, last4?}], providers}`, never a key |
| `POST /argos/keys` | `{name, value}` (`''` clears), page Origin only, 2 KB max | `{key:{name, set, last4?}, providers}` |
| `GET /argos/usage` | | `{eleven, argos: counts}` |

Design files are `source.scad`, `model.stl`, `model.obj`, `model.glb`, `photo.jpg` and `spec.json`.

A design's metadata looks like this:

```
{id, kind: scan|refined|imported, name, at, source: call|argos|computer, parts?, parent?, summary?, caveats?, outside, note?, files}
```

### Events on the page socket

Subscribe with `subscribe()` from `twin/shell.js`:

```
{type:'argos', kind:'heard'|'reply', text}
{type:'argos', kind:'design', design}                   a new design: a scan from a call, or an import
{type:'argos', kind:'refine', jobId, state:'started', mode, instruction}
{type:'argos', kind:'refine', jobId, state:'step', step:{role, state: working|done|failed, text}}
{type:'argos', kind:'refine', jobId, state:'done', design, summary, caveats, calls, ms}
{type:'argos', kind:'refine', jobId, state:'failed', error}
```

Chat also sends the stage's own events: `{type:'twin', action, target}` for view and part commands, and
`{type:'circuit', ...}` for circuit changes.

## Settings

All of these are optional and go in `.env`. They can also be set from the main page.

| Variable | What it does |
|---|---|
| `ARGOS_GEMINI_MODELS` | The Gemini models to fall through on rate limits |
| `ARGOS_CLAUDE_MODEL` | The Claude model |
| `ARGOS_OPENAI_KEY`, `ARGOS_OPENAI_BASE`, `ARGOS_OPENAI_MODEL`, `ARGOS_OPENAI_NAME` | Any OpenAI-compatible API, such as OpenAI/Codex models, AIsa, or a local server |
| `ARGOS_STT_MODEL` | Default `scribe_v2`, with `scribe_v1` as the fallback |

## Test

This runs with no keys: a fake model server and real OpenSCAD.

```bash
node test/argos-test.mjs
```

OpenSCAD comes from `openscad-wasm-prebuilt` and is licensed under GPL-2.0. It runs as a separate WASM program in a worker.
