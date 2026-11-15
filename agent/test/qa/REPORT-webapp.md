# Ody web app QA report (call view `/` + 3D twin `/twin`)

Tester: automated Playwright (playwright-core, headless Chromium, SwiftShader software GL) against mocks on :8795.
Screenshots: `/home/plopee/.playwright-mcp/qa-*.png`. Drivers: `test/qa/qa-*.mjs`. Raw twin numbers: `/home/plopee/.playwright-mcp/qa-twin-results.json`.
Caveats: the `webapp-testing` / `frontend:design-review` Skill tool and the Playwright MCP tools were not available in this agent, so I drove Playwright directly and did the design review by hand. Software GL means fps numbers are a floor, not a real laptop result. NOT tested: scan list switching (`--scan <dir>` mock not run), real-camera hand control, Firefox/Safari, real-GPU fps.

Persona: hackathon judge + first-time Arduino builder, 1440x900, 1280x800, 390x844.

## Severity-ranked issues

### HIGH
1. **No visible route between the two views, and the call view hides the "wow".** (Nielsen: visibility of system status, recognition over recall, match with real world)
   Both pages are the same 1440 layout with a small "3D twin" / "Call view" outline button top-right. A judge looking at `/` sees a phone + headline + transcript and has no cue that a 3D hologram exists, nor that Ody's marks relate to it. Switching reloads the page: the twin starts at "No board yet", camera at the wait pose, and the call view loses its scroll position/tester state. See `qa-mon-1440.png`, `qa-twin-1440-board.png`.
   Fix: one app shell with a persistent two-tab switch (Call | Twin, keys `1`/`2`) or a split view (phone left, twin right) at >=1280. Keep WebSocket + state alive across switches (single page, or SharedWorker/BroadcastChannel). Put the primary "open 3D twin" affordance next to the live status as a filled button while a board is recognised ("Board found - see it in 3D").
2. **Unbroken long text blows the whole page layout** (call view). A 400-char step with no spaces (junk feed, but also a long URL/part code) makes `document.scrollWidth` 4072px at 1440 and 3558px on a 390 viewport; the phone is pushed off-screen on mobile and the tester stats overlap (`qa-call-1440.png`, `qa-call-1440-tester.png`, `qa-call-390.png`). `.route li` has `max-width:52ch` but no `overflow-wrap`.
   Fix: `overflow-wrap:anywhere; min-width:0` on `.route li`, `.line .text`, `.points li`, `.turns .what`, `h1`; clamp step text to 2 lines.
3. **Live dot stays red during "Reconnecting"** (`qa-mon-during-down.png`). `body.live` is derived from the last call state, so a dead socket looks like "Live" with a red recording dot; only the tiny word changes. A judge cannot tell the feed is frozen. The "Picture paused" pill does appear (good).
   Fix: in `status()` drop the `live` class (grey dot, amber "Reconnecting...") when `!S.sock`; dim the phone.

### MEDIUM
4. **FPS HUD is opt-in via `?fps` only** and undiscoverable (twin.html hint line lists H/E/R/X but not the HUD). Measured with `/twin?fps` under software GL: 20-22 fps at 1440x900 and 1280x800 (HUD `21 fps · 48 ms · bloom 0.5 · dpr 1`; auto-quality stepped bloom down to 0.3, reaching 32 fps). A real iGPU/GPU should be far better, but check on the actual demo laptop. Fix: add `F` key to toggle the HUD; contrast of the HUD text (#6E6E73 on near-black) is ~3:1, make it #A1A1A6.
5. **Pins/tooltips are mouse-only.** The canvas is `tabindex=-1`, no role, no keyboard equivalent for orbit, zoom or pin inspection. Tab order works (Call view link, Hologram, Explode, Reset, Hands, then the right-hand list), focus ring is a visible 2px outline on all buttons (good), but the "Marked this call" / "Wiring" entries are buttons that presumably fly to the target; nothing tells the keyboard user that. (Nielsen: flexibility, accessibility.)
   Fix: arrow keys to orbit, +/- zoom, `[`/`]` step through pins, announce selection in an `aria-live` region; give the stage `role="application"` with a label listing keys.
6. **Tab order starts oddly after using the side panel**: after Export, Tab went Copy -> Reset -> `BODY` (focus fell on body with outline none) -> Call view link. A "ghost" stop on body (`qa-twin-1440-focus.png`). Also the focus ring on the wiring-list rows is clipped on the right by the `aside` overflow container (visible in the screenshot: ring flattened at x=1412).
   Fix: add `padding-right/inset` or `outline-offset:-2px` on `ul.list button`; find what moves focus to body (the toast / blurred Export?).
7. **Hologram scene composition: breadboard is cut off by the stage** after "Reset view" at 1440x900 (`qa-twin-1440-board.png`, `qa-twin-1440-focus.png`): the board fills the left half, the breadboard bleeds off the right edge, and the wire label floats in empty space before the wire arrives. The first impression of the twin is "half a scene". Fix: fit camera to the union bbox of board + breadboard (+ marks) with padding; keep the label glued to the wire end.
8. **Mark labels collide in the phone view** (`qa-mon-1440.png`): "Long leg" label is struck through by the wire arrow, and both rings sit on the left edge of the phone, partially clipped by the rounded screen. Fix: draw the wire under label pills, and inset marks that fall within ~6% of the edge.
9. **Hands button is offered when there is no camera**, then silently disappears after a failed attempt (console: `[twin] hands NotSupportedError`; toast shown briefly, button `hidden` afterwards). Degradation is graceful (no crash, no errors surfaced) but the toolbar shifts under the user and the toast is easy to miss. Fix: only show after `enumerateDevices()` finds a videoinput; otherwise keep it visible but disabled with title "No camera found". Also the `/vendor/mediapipe/vision_bundle.mjs` request shows `ERR_ABORTED` (preload cancelled when navigation/close happened) - harmless, but check it isn't fetched before the user clicks.
10. **Judge's first-look hierarchy (call view):** the phone is the biggest object but is an empty dark rounded rectangle with a yellow ring until the first frame (`qa-call-1440.png`). The headline ("Step 69. Ody is listening.") reads well, but the single most interesting fact (what Ody is pointing at) is a 14px-high pill on the phone. Fix: when a mark exists, echo it in the headline column as a chip ("Pointing at: Pin 13"), and add a one-line "What am I looking at?" under the phone.
11. **Tester panel at 1280 squeezes the story column to ~350px** (`qa-mon-1280-tester.png`): the voyage text wraps, the conversation is cut mid-line at the top with no fade (`qa-mon-during-down.png` shows half a line). Between 1180 and 1440 the third column feels cramped. Fix: collapse the panel to an overlay below 1360, add a top fade mask to `.log`.

### LOW
12. **Status mismatch on twin when call ended**: right panel says "Done. You made it home." while the header says "Call ended" and the red short warning is still listed under "Marked this call" (`qa-twin-1440-board.png`). Fine as a recap, but give the ended state a "Recap" label.
13. **`aria`:** `#toast` and `#tip` have no role (screen readers miss "Exported ..." / "Wiring copied"). Add `role="status"` to the toast. `.status` already has `role="status"` (good).
14. **Mobile twin (390x844)**: works, no horizontal overflow (page 390 wide), toolbar scrolls horizontally (362 vs 340px; "Hands" is half cut, the edge hints scrollability) and kbd hints are hidden (good). The 3D stage is 62vh so the board is readable (`qa-twin-390-top.png`). No pinch hint.
15. **Tester panel jargon** ("Brain", "Turns", "Median", "Pictures Caller 2.0/s") is fine for engineers but the "T" shortcut is shown in a toggle that looks like a normal nav item to a judge; consider hiding it behind `?tester` for the demo.
16. **Per-spec**: `tabindex` order puts the right-hand Export/Copy/Reset buttons BEFORE the header and toolbar (DOM order: main -> stage -> aside, but focus began on Copy after the click). Verify first Tab stop is the header link.

## Verified OK (no bug)
- Twin: Explode (E) sets explode=1 and animates; E again returns. Hologram/Realistic (H) toggles (`state.holo` true/false). Reset (R) flies home. Drag-rotate and wheel zoom work (`qa-twin-1440-rotzoom.png`).
- Export (.glb): download triggered, filename `ody-twin-20261114-220725.glb`, 1,868,440 bytes, magic `glTF`; toast "Exported ...". Copy wiring toast "Wiring copied".
- Pin hover tooltips: 21 distinct tooltips found over a grid sweep (SCL, D9 "PWM~", D2 "Digital · interrupt 0", IOREF, A4 "Analog in · I²C SDA", breadboard H1 "Joined to column 1, holes F-J", rails). Clear beginner-friendly wording, `qa-twin-tooltip.png`.
- Resilience: unknown event types, `frame` without jpeg, `turn` with null/garbage marks, out-of-range coordinates, unknown pin `ZZ99`, `scan` with no spec, `part` with no body, 70 long transcript lines + 70 steps, and an HTML-injection string in a transcript line: no console errors, no `pageerror`, no dialogs, no injected `<img>`/`<b>` nodes (text rendered via textContent). The twin kept the previous model through the junk feed. Transcript is capped at 60 lines, scrolls to bottom.
- Reconnect: server killed for 12 s; call view showed "Reconnecting" + "Picture paused", retried every 1 s, reconnected and picked up the new call ("Live 0:11") with no reload. Only console noise is the browser's own WebSocket connection-refused messages (12 in 30 s; cosmetic).
- Network: zero external requests on both pages (all `localhost:8795`; fonts fall back to system stack, Inter is not loaded). 27 distinct requests for the twin (three.js modules from `/vendor`). No CSP violations logged (CSP is strict: `default-src 'self'`, hash-pinned importmap).
- Reduced motion: twin `autoRotate` disabled via `matchMedia` (checked in code, `qa-twin-reduced.png`); call view headline swap and route animation are inside `prefers-reduced-motion: no-preference` (computed `animation-name: none` verified).
- Call view keyboard: Tab order is 3D twin -> Tester -> log (scrollable, focusable) -> body; `T` toggles tester, `Esc` closes it; focus outlines visible.
- No horizontal overflow at 1440 and 1280 with normal data; 390 call view stacks cleanly (phone at 360px, headline below, `scrollWidth` 390).

## What worked well
- Clean visual language: Apple-ish light ground for the call view, dark holographic stage for the twin, yellow only for Ody's marks. The two-tone headline ("Step. / Ody is listening.") is excellent at a glance.
- Voyage metaphor (route with islands and "Ithaca - the project, done") communicates progress without a progress bar.
- Toolbar kbd hints (H/E/R) and the right-hand "Marked this call" / "Wiring" lists make the twin self-explanatory; "do not connect" on the 5V->GND short is the best moment for a beginner.
- Tooltips use plain language, not datasheet jargon.
- Defensive code: junk events cannot break either page.

## Redesign pointers (layout/flow)
1. One shell, two panes: phone/call on the left (always visible), twin on the right with the step + mark list beneath; the transcript becomes a collapsible drawer. Judge sees the live camera + the hologram together, which is the whole pitch.
2. When Ody marks something, flash the corresponding pin in the twin and show the same label in both places (single source of truth for "what Ody is pointing at").
3. Make "Export", "Copy wiring" secondary; make "Explode" and "Hologram/Realistic" the visible hero controls (judges poke those).
4. Treat connection state as first-class (grey dot + banner when reconnecting).
5. Fix text wrapping everywhere before adding content.
