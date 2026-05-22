# Unified Waterfall — Phase 2 (resume here)

Status: open — Phase 1 shipped, Phase 2 not started
Filed: 2026-05-22
Repo: POTACAT desktop (`D:\Projects\potacat-dev`)
Canonical plan: `docs/waterfall-plan.md` (read it first — full architecture + all 4 phases)

## Where we left off

The unified-waterfall project (one polished, GPU waterfall for *every*
radio, not just IQ-stream radios). **Phase 1 is done and pushed**
(commit `0054ec8`):

- `renderer/waterfall.js` — the `Waterfall` component. WebGL2 ring-buffer
  texture + `fract(uv.y+offset)` scroll (AetherSDR's technique,
  reimplemented). One `texSubImage2D` row per frame, no redraw.
- It was validated by replacing the **SSTV popout's** Canvas-2D
  waterfall — `feedWaterfall()` keeps the FFT, `drawWaterfallLine()` is
  now just `sstvWaterfall.pushFrame(mags)`.

### The component API (already built)

```
new Waterfall(canvas, { bins, historyRows, colormap, gamma })
  .pushFrame(Float32Array mags)   // any length/scale — resampled + auto-ranged
  .setMarkers([{ pos: 0..1, color: [r,g,b,a] }])
  .onClick(fn)                    // fn(0..1) — host maps to a frequency
  .setColormap('classic' | 'turbo')
  .resize()                       // also auto via a ResizeObserver
  .destroy()
  .supported                      // false if WebGL2 unavailable
```

`<script>`-loaded global class (no ES modules in this renderer). The
canvas must have no prior 2D context — WebGL2 can't share one.

## Phase 2 — what to build

Goal: the waterfall in the **main operating view** for **every radio**,
with click-to-tune and a spot overlay. This is the "works on all radios"
headline and the differentiator, shipped together.

1. **Audio-FFT source adapter.** Capture the demodulated AF (POTACAT
   already has every transport: USB CODEC, DAX, VITA-49, K4 Opus), run
   an FFT, call `pushFrame()` ~10–30×/s. Reuse the SSTV radix-2 FFT
   (`renderer/sstv-popout.js` `fft()`, FFT 4096, Hann) — extract it into
   a shared module rather than copying. Audio passband ≈ 0–3.5 kHz.
2. **Main-view integration.** Embed a `<canvas>` + `Waterfall` in the
   main window's operating area (near the VFO / rig panel). Decide:
   always-visible strip vs. collapsible. Reuse for the VFO popout too.
3. **Click-to-tune.** Wire `onClick(frac)` → map the fraction to a
   frequency (audio-passband offset, or RF for the Flex panadapter in
   Phase 3) → `tuneRadio()` / the rig-control IPC. RX/TX markers via
   `setMarkers()` — see how `jtcat-popout.js` positions its RX/TX lines.
4. **Spot overlay.** Draw POTA/SOTA/RBN/cluster spot callsigns at their
   frequencies over the waterfall. POTACAT already has the spot list in
   the renderer. This is the POTACAT-unique feature — no other SDR app
   has the spot data. (Likely a thin 2D `<canvas>` layered over the
   WebGL canvas for text — text in WebGL is painful.)

## Open notes / gotchas

- **WebGL2 required.** `.supported` is `false` otherwise; hosts should
  check it and fall back (or just leave the waterfall blank).
- **Wrap-seam.** The ring-buffer texture uses `LINEAR` filtering +
  `REPEAT` wrap, so one faint horizontal line can appear at the
  oldest/newest seam. Cosmetic; fix later by hiding the seam row or
  switching that axis to `NEAREST` if it's visible.
- **Frame resample is nearest** — downsampling a large FFT to `bins`
  can miss narrow peaks. Fine for now; max-pooling is a later refinement.
- **Phase 4** (not Phase 2) consolidates the JTCAT FT8 waterfall and the
  SSTV multi-slice mini waterfalls onto the component — they're still
  Canvas-2D.

## Test path

- Phase 2 done: every rig type shows a live audio waterfall in the main
  view; clicking it tunes the rig; spot calls appear at the right
  x-positions and track as you QSY.

## References

- `docs/waterfall-plan.md` — canonical plan.
- `renderer/waterfall.js` — the component.
- `renderer/sstv-popout.js` — Phase 1 integration example + the FFT.
- `renderer/jtcat-popout.js` — existing click-to-tune + RX/TX markers.
