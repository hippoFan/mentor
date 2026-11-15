# tools/

## import-parts.mjs

Turns open-source part libraries into Mentor pin maps (`data/parts/*.json`) so Mentor can register boards and modules other than the UNO.

```
node tools/import-parts.mjs                 # fetch sources (cached) and regenerate data/parts/
node tools/import-parts.mjs --offline       # use the cache only
node tools/import-parts.mjs --only hc-sr04  # one part (does not rewrite index.json)
node tools/import-parts.mjs --src DIR --out DIR
node test/parts-test.mjs                    # validate the output
```

Sources are pinned to commits (see `SRC` in the script), downloaded from raw.githubusercontent.com into `--src` (default `$TMPDIR/mentor-parts-src`),
and parsed as data only (regex/XML parsing; nothing downloaded is executed). Licenses: `data/parts/LICENSES.md`.

Part file shape: `{id, name, aliases[], source, license, attribution, outline_mm:{w,h}, frame, pins:[{name, x_mm, y_mm, kind:'header'|'pad'|'pin', number?, function?}], headers:[{name, side, orientation, pitch_mm, pins:[names]}]}`.

Frame: origin = top-left of `outline_mm` as drawn in the top view, `x_mm` right, `y_mm` DOWN, z up from the top face. `data/uno-pins.json` uses `v = outline.h - y_mm`
with `u = x_mm` for the UNO. Arduino header pins are snapped to the 0.1" grid like uno-pins.json. Pi 4/5 pins carry `number` (physical pin 1..40).

`data/parts/index.json` maps part id to name/aliases; `lookup` maps a normalised alias (lowercase, non-alphanumerics removed:
"ESP32 DevKit V1" becomes `esp32devkitv1`) to a part id, for matching what a model says.

Adding a part: add an entry to `PARTS` (wokwi-el needs a file from wokwi-elements `src/<file>-element.ts`; wokwi-board a `boards/<dir>/board.json`; Fritzing needs the .fzp + breadboard SVG).
