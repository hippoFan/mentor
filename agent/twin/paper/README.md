# Papyrus ink kit

Hand-drawn ink motifs on papyrus for the Ody app. Ink lines in navy ink `#12233f` with a
wobble + dry-reed filter, sparse flat washes that sit slightly off-register from the line,
and a light, tileable papyrus ground. Palette (only these): parchment `#fdf5cc`, navy ink
`#12233f`, teal `#1b5a63`, sea-glass `#c1ddd0`, torch `#ea872f`, cork red `#983a34`,
near-black `#191a16`. Contact sheet: `paper-kit.png`. Licences: `LICENSES.md`.

## Rule of use
The ink is navy, so **put the motifs on papyrus (or parchment), not straight on the navy
ground** — on navy the lines disappear and only the washes show. Make a papyrus panel, then
place motifs on it.

```css
.papyrus{background:#fdf5cc url(/paper-kit/papyrus.svg) 0 0/256px 256px;color:#12233f}
.pk-border-top{height:40px;background:url(/paper-kit/border-meander.svg) 0 0/auto 100% repeat-x}
.pk-border-waves{height:40px;background:url(/paper-kit/border-waves.svg) 0 0/auto 100% repeat-x}
.pk-divider{height:24px;background:url(/paper-kit/divider-rule.svg) center/contain no-repeat}
```
Decorative: use `<img src="olive-sprig-r.svg" alt="">` (empty alt) or `aria-hidden="true"`.

## Files
| File | viewBox | Use at | Small (≤48px)? |
|---|---|---|---|
| `papyrus.svg` | 256² tile, seamless | background, `256px` tile (or 192–384) | n/a |
| `olive-sprig-l/-r`, `laurel-sprig-l/-r` | 220×360 | 120–360px tall; flank titles in pairs (l on the left) | yes, reads as a sprig at 40px |
| `acanthus-sprig-l/-r` | 300×340 | 120–300px, corner ornament | so-so |
| `waves-back/-mid/-front`, `waves` | 600×170, tile in x | full-width band as a CSS background, `background:url(waves.svg) 0 100%/auto 120px repeat-x` (don't stretch an `<img>`); stack the three for parallax | no |
| `border-meander` (384×40), `border-waves` (360×40) | seamless in x | `repeat-x`, 24–40px tall | yes (24px) |
| `divider-rule` (400×24), `divider-laurel` (400×60) | | between sections, 200–400px wide | rule yes, laurel ≥ 32px tall |
| `frame-corner` | 128² | panel corners; rotate 90/180/270 for the other three | yes |
| `ship` | 520×330 | 160–520px wide | silhouette only at 40px |
| `argos` | ~288×392 | 100–300px tall | yes |
| `tree-cypress` (160×420), `tree-olive` (360×340) | | 120–420px tall, scenery at the panel bottom | cypress yes |
| `column` | 150×420 | 120–420px, flanking a title or card | yes |
| `cloud-a` (320×120), `cloud-b` (260×90) | | 120–320px wide, sky; drift slowly if animated | yes |
| `sun` (220²), `star` (80²), `stars` (260×130) | | sun 80–220px; star 12–40px (the deck's 4-point star) | star yes, sun yes |
| `forge` | 340×300 | 120–340px, The Forge header/empty state | so-so (reads as an anvil) |
| `figure-torchbearer` (220×480), `figure-rower` (280×340) | | 160–480px tall | no |
| `panel-torn` | 600×400 | card background, `background-size:100% 100%` (the tear stretches; keep aspect within ~1.2–1.8) or use `papyrus.svg` + this as a frame | n/a |

## CSS hooks
Every SVG root has `class="pk pk-<name>"`. Inside: `.pk-fill` (washes) and `.pk-line` (ink).
When an SVG is **inlined** you can restyle it:
```css
.pk-calm .pk-line,.pk-calm .pk-fill{filter:none}   /* no wobble: cheaper, crisper at small size */
.pk-inkonly .pk-fill{display:none}                  /* line art only */
.pk-reverse .pk-line{stroke:#fdf5cc}               /* parchment ink, for use directly on navy */
.pk-flat .pk-shadow{display:none}                   /* panel-torn without its drop shadow */
```
Filter ids (`pk-ink`, `pk-wash`, `pk-fibre`) are identical in every file, so inlining several on
one page is safe. Via `<img>` they are sealed (no hooks) — fine for most uses.

Performance: each SVG uses 2 SVG filters. Fine for a handful on screen; for 20+ repeated
icons, inline them with `.pk-calm`, or rasterise once.

## Rebuild
`src/build.sh` regenerates all SVGs from `src/gen.py` and re-renders `paper-kit.png`
(headless Chromium, nothing opens on screen). `src/trace.py` is the photo → silhouette tracer.
