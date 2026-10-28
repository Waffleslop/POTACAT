# Band Scope improvements: plan

Casey 2026-10-28: "Plan the scope improvements, all of them." This plan is for the existing Band Scope; no second scope window gets built. The goal is a display that reads and handles like a proper SDR panadapter (SmartSDR, Thetis, SDR#), while keeping what POTACAT already has and those programs mostly lack: spots drawn on the scope.

## Where the scope is drawn today

| Surface | File | Trace | Waterfall | Tuning |
|---|---|---|---|---|
| Band Scope pop-out (More > Band Scope) | `renderer/scope-popout.js` + `.html` | canvas 2D: 10x4 grid, no labels, a fixed 0.55 smoothing, optional peak hold | `renderer/waterfall.js` (WebGL2, auto-ranging, crop mode) | click tunes; Spots strip click tunes onto the spot |
| JTCAT window strip (gear > Display) | `renderer/jtcat-popout.js` ~2717 | none | `waterfall.js` | click |
| ECHOCAT Web Scope tab + FT8 "BS" strip | `renderer/remote.js` ~995-1180 | its own canvas 2D copy, no grid labels | its own canvas 2D row painter | tap |
| Phone app | potacat-app `BandScopeView.tsx`, `pan/PanCanvas.tsx` | the app's | the app's | tap, zoom, CENTER |
| Laptop driving a shack | the pop-out over the bridge | as the pop-out | | |

Shared already: `lib/scope-axis.js` (bin to Hz, `known`, `applyFloor`, `snapTapHz`, formatters). The pop-out and the web client draw traces with two separate copies of the same idea. The pop-out ignores `dbmMin`/`dbmMax`, which main sends only to ECHOCAT (`scopeCalibration()`).

### What each source can tell us

| Source | Levels | Axis | Who moves the window |
|---|---|---|---|
| FT-710 (USB) | 0-255, uncalibrated | known in CENTER only | the radio: CENTER follows the dial; span via `SS05` |
| Flex Direct pan | dBm: `min_dbm`/`max_dbm` from the pan status | known (pan centre/span) | POTACAT: `setPanCenter`, span steps |
| SDR (rtl_tcp) | dB relative to POTACAT's own FFT (we know dB per level) | known | POTACAT: centre = dial + offset |
| Icom (after captures) | 0..160 or 0..200 = -80/-100..0 dBm per Icom (a relative scale despite the name) | CENTER: known from the half-span; FIXED/SCROLL: edges in the frame | the radio; span via `27 15` |
| Synthetic (`--synth`) | arbitrary | known | POTACAT |

**Rule for every item below:** a number is shown only when the source gives it. dBm appears only when a source reports dBm (Flex, Icom labelled "radio scale"). An SDR gets "dB" relative to the source, and an FT-710 gets a grid with no numbers. Nothing is invented, in the same spirit as the axis's `known`.

## Phase 0: one drawing module (prerequisite)

Every improvement would otherwise be written three times (pop-out, web, JTCAT strip) and drift, which is what happened to the layout bug. So:

- **`lib/scope-view.js`**, dual-mode like `scope-axis.js`: `require` for tests, `window.ScopeView` in the renderer, inlined into the web page by remote-server (`<!-- scope-view-js -->`, the same mechanism `scope-axis` and `spot-row` use). Pure layout functions:
  - `frequencyTicks(axis, widthPx)`: round-number ticks (1/2/5 x 10^n Hz, label spacing of at least about 70 px)
  - `levelTicks(scale, heightPx)`
  - `passbandRect(...)`
  - `bandSegments(...)`
  - `spotLanes(...)`
  - `timeTicks(...)`
- A canvas 2D painter, `ScopeView.drawTrace(ctx, frame, view)`, which is the only trace drawing. The pop-out, the web client and the JTCAT strip all call it.
- The web client's own row painter is replaced by `waterfall.js` where WebGL2 exists. The 2D painter stays as the fallback (older phones), behind the same `pushFrame` API.
- Tests: `test/scope-view-test.js` (pure geometry), plus rendered checks in the layout harness (`test/layout/harness.js`). These check that labels never overlap and ticks land on round numbers at phone and desktop widths, in dark and light themes.

No visible change ships in Phase 0. It lands first so that every later phase is one change on every surface.

## Phase 1: readable scales

1. **Frequency scale.** A strip under the trace with round-number ticks and labels (14.070, 14.075 …). It replaces the lo/centre/hi text and has finer ticks between labels. When the axis is not `known` (FT-710 CURSOR/FIX), the strip says "axis assumed" as the trace does now.
2. **Level scale.** A left gutter with dB lines every 10 dB (every 5 dB when the range is under 40 dB). It shows dBm for Flex, the radio's scale for Icom, and dB relative for an SDR. The FT-710 gets unlabelled lines. `scope-state` gains `levelScale {unit: 'dBm'|'radio'|'dB'|null, min, max}` from main, which replaces the Flex-only `dbmMin`/`dbmMax`. Those two fields are kept on the wire for the phone app until it reads `levelScale`. An optional S-unit column (S9 = -73 dBm) is shown only for `unit: 'dBm'`.
3. **Cursor readout.** Hovering, or holding a touch, shows frequency and level under the pointer ("14.07415 MHz · -92 dBm"). This is what makes the scales useful.

## Phase 2: reference level, range, averaging

4. **Reference level and range.** These set the top and bottom of the display. They are display-only on every source and remap the 0-255 levels, as `applyFloor` does now.
   - Controls: drag the level scale up or down to move both; wheel over the scale to change the range; two sliders in the gear menu for touch.
   - The existing **Floor** slider becomes the bottom of the range. Its saved value carries over, so nobody's display changes on update.
   - The same top and bottom drive the waterfall's black and white points when its Auto (item 13) is off.
5. **Averaging.** Gear menu choice Off / Light / Medium / Heavy, as exponential smoothing of 1, 0.55, 0.3 and 0.15. The current 0.55 is Light, and it stays the default.
6. **Peak hold** gains a decay choice: Fast / Slow / Hold until cleared. A **Clear** button appears while it is on. It is still off by default.

## Phase 3: the receiver drawn on the scope

7. **Dial marker.** It exists; it gains a frequency flag at the top in the dial colour.
8. **Passband.** A shaded band where the receiver is listening, from the mode and the filter width:
   - USB / USB-D: dial to dial + width (from about 100 Hz up)
   - LSB: mirrored
   - CW: centred on the dial (the display frequency is the carrier; the pitch is already in the dial on every supported rig)
   - AM / FM: symmetric
   - Width comes from `_currentFilterWidth`, which main already tracks for the VFO window, and `scope-state` gains `passband {loHz, hiHz, reported}`.
   - **When the radio does not report a width**, a dashed outline of the mode's usual width (2.4 kHz SSB, 500 Hz CW, 3 kHz digital, 6 kHz AM, 12 kHz FM) is drawn, labelled "nominal". It is never filled solid, so it cannot be mistaken for a reading.
9. **TX marker when split.** When the radio reports split (`_currentSplit` plus the VFO B readback), a second marker in the TX colour is drawn at the transmit frequency. Not drawn otherwise.
10. **Band edges and sub-bands.** Built from `lib/privileges.js` for the operator's licence class (`settings.licenseClass`, already mirrored to ECHOCAT):
    - outside the band edge: dimmed
    - outside the operator's privileges: a hatched band, labelled with the class
    - the CW/digital and phone segments: a thin coloured line along the bottom
    - the FT8/FT4/JTTY/PSK dial frequencies, from the JTCAT band tables: small ticks
    - with no licence class set: only the band edges
    - Other countries' tables are drawn when `privileges.js` has them. Where it has none, only the band edges come from `lib/bands.js`.

## Phase 4: tuning with the mouse and finger

All tuning goes through the existing tune path, using the VFO window's optimistic pattern: the dial shows the target at once, and the readback corrects it (`_freqSuppressTarget`). The same Guest Pass rules apply as for any tune.

11. **Drag the passband** to tune smoothly. Sends are capped at about 15 per second; the last position always goes. A drag that starts anywhere else in the trace does not tune; it is the pan (item 12b).
12. **Wheel and drag**, by surface and source:
    - a. **Wheel over the trace or waterfall** steps the dial. Steps: 10 Hz in CW and digital, 100 Hz in SSB, 1 kHz with Shift. The scope gets its own step setting in the gear menu, defaulting by mode. Whether it shares the VFO window's step is a question below.
    - b. **Drag the frequency scale, or empty trace**, to pan. This depends on who owns the window:
      - On a Flex pan or an SDR, panning moves only the window (`setPanCenter`; for an SDR the centre offset), and the dial stays where it is.
      - On an FT-710 or Icom in CENTER mode, the window *is* centred on the dial. The trace slides as you drag, and on release the radio tunes to where you dropped it, with the drag preview drawn first. FIXED/SCROLL modes do not pan.
    - c. **Ctrl+wheel, or the - and + buttons**, zoom through `scope-state.spans`:
      - Flex steps: exists
      - FT-710: `SS05` spans; today the phone has it, the pop-out does not
      - Icom: `27 15`, when it ships
      - SDR: its three fixed rates
    - d. **Double-click** a spot label to tune and set its mode (single click does this today).
    - e. **Touch** (web and phone): a tap tunes, as now. A horizontal drag past about 12 px pans or drags the passband, and a vertical drag scrolls the page. Pinch zooms through the spans.
13. **Keyboard** (pop-out): Left/Right step the dial, PageUp/PageDown zoom, Home recentres a Flex/SDR window on the dial.

## Phase 5: the waterfall

14. **Draggable divider** between trace and waterfall. The split is kept per surface on the device (localStorage, like the colour map). A double-click resets it.
15. **Auto black level.** `waterfall.js` already auto-ranges (a slow noise floor and a fast-attack peak). This makes it a visible **Auto** toggle, on by default. When it is off, the waterfall's black and white points are the reference and range from item 4, so the trace and waterfall agree.
16. **Time scale.** A thin gutter on the left of the waterfall with UTC labels every 10, 30 or 60 s (chosen so they're at least about 40 px apart), plus faint lines across. Row timestamps are kept in a JS ring beside the texture ring. On FT8 bands an optional 15 s slot line shows period boundaries.
17. **Waterfall speed**, independent of the trace refresh rate. Choices from 1 to 30 lines per second, with frames *averaged* into a line rather than dropped, as the JTCAT waterfall's `jtcatWaterfallSpeed` does. The trace keeps the source's full frame rate. Default: one line per frame, which is today's look.

## Phase 6: overlays

18. **Spots in lanes.** Today a label that would overlap is skipped and only its tick is drawn. Instead, labels stack into up to three lanes (the Spots strip grows to fit), then show "+N" for the rest. Hovering shows the spot (call, ref, mode, age), and the colours stay the source colours.
19. **Other Flex slices.** On Flex Direct, each other slice on the pan is drawn as a lettered marker (A-D) with its passband outlined (not filled). Our own slice stays filled. Clicking another slice's marker does nothing. The list comes from the slice status `lib/smartsdr.js` already parses.
20. **TX highlight.** While we transmit, the passband turns the TX colour, a quick check that the radio is on the frequency you think.

## Phase 7: every surface, and handoffs

- **ECHOCAT Web:** the Scope tab and FT8 strip get everything above through `scope-view.js`, with the touch rules of item 12e. The FT8 strip keeps its compact height: no level gutter, the frequency scale on.
- **JTCAT window strip:** frequency scale, passband and band edges. No level gutter or divider (it is a strip).
- **Laptop driving a shack:** the pop-out runs as is. The `scope-state` additions ride the existing bridge.
- **Phone app:** a handoff with exact values, `docs/desktop-handoffs/scope-improvements.md` in potacat-app: the new `scope-state` fields, tick rules, nominal widths, privilege colours and the touch gestures (Casey 10/24: phone must match).
- **Docs:** the Band Scope page from the v1.13.6 handoff gains a "Reading and tuning the scope" section. **Website:** feature-page lines.

### Wire changes (additive)

- `scope-state` gains:
  - `levelScale {unit, min, max}`
  - `passband {loHz, hiHz, reported}`
  - `txHz` (when split)
  - `slices [{letter, hz, loHz, hiHz}]` (Flex Direct)
  - `owner: 'radio'|'potacat'` (whether panning moves the window or the dial)
- New C2S `scope-pan {centerHz}`, for Flex/SDR only. Refused for a source the radio owns, and refused for a Guest Pass unless zoom is allowed, matching today's guest zoom rule.
- Hello capability `scope-view-2` tells the app it may use them.

## Order and size

| Phase | Lands | Rough size |
|---|---|---|
| 0 shared module + tests | first, alone | medium |
| 1 scales + cursor readout | with 2 | medium |
| 2 ref/range/averaging/peak | with 1 | small |
| 3 passband, split, band edges | next | medium |
| 4 mouse/touch tuning, zoom, pan | next | medium (main: `scope-pan`, FT-710 span from the pop-out) |
| 5 waterfall divider/auto/time/speed | next | medium |
| 6 spot lanes, Flex slices, TX tint | last | small-medium |
| 7 handoffs | as each phase ships | |

Phases 1-2 alone already answer "make it look like a proper SDR display". Each phase is its own commit and is checked in a scratch `--user-data-dir` instance on `--synth`, plus the FT-710/Flex code paths against fixtures (`test/fixtures/flex-pan/8600-capture.txt`). Casey's own 8600 check comes when he says.

Icom plugs into all of this when its captures arrive (`docs/icom-band-scope-plan.md` steps 3-5). Nothing here waits for it.

## Questions for Casey

1. **No reported filter width:** draw the dashed "nominal" passband (recommended), or the dial line only?
2. **Wheel step:** the scope's own step, defaulting by mode (recommended), or shared with the VFO window's step select?
3. **FT-710/Icom CENTER pan:** dragging the scale retunes the radio on release (recommended; it is what the radio's own touchscreen does). Or should dragging be disabled on those sources?
4. **Privilege shading** on by default (recommended), or off until the operator ticks it?

## Not in this plan

3D/history views, a second pan per window, a TX panadapter, recording the scope, and decode markers (FT8 calls) on the scope. Each could follow if wanted.
