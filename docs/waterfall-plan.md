# Unified Waterfall — Plan

Status: Phase 1 shipped (0054ec8, SSTV uses it). Phase 2 stashed 2026-05-24
— when revisited it is a stand-alone pop-out, not embedded. Phase 5 (Yaesu
FT-710 native scope) planned 2026-09-20 — see the end of this file.
Owner: POTACAT desktop

## Goal

One polished, GPU-accelerated spectrum waterfall that works on **every
radio POTACAT supports**, not just radios with an IQ stream. It lives in
the main operating view (popouts reuse the same component), supports
click-to-tune, draws RX/TX markers, and overlays POTA/SOTA/cluster spots
at their frequencies.

## Motivation

Two reasons this is the next big project:

1. **Flex Direct created a gap.** POTACAT never rendered its own
   panadapter — it always leaned on SmartSDR's. Now that Flex Direct
   lets a Flex run with *no SmartSDR*, those users have **no panadapter
   at all**. This project completes Flex Direct.
2. **Conventional radios have never had a waterfall.** A Yaesu / Icom /
   Kenwood / Elecraft operator gets no spectrum display in POTACAT
   today. An audio-passband waterfall is genuinely useful — see CW
   signals, judge whether a frequency is busy, tune by eye.

## The two-waterfalls reality

There is no single "RF panadapter for every radio" — physics won't allow
it. There are two cases, and the component must serve both:

| Radio class | What POTACAT can get | Waterfall it produces |
|---|---|---|
| Flex / SDR (IQ stream) | Wideband IQ → panadapter FFT | True **RF panadapter**, kHz–MHz span |
| Yaesu / Icom / Kenwood / Elecraft (CAT + USB audio) | Demodulated AF only | **Audio-passband** waterfall, ~0–3.5 kHz |
| *(future)* IC-7300/705 etc. | CI-V scope-waveform output | True panadapter for those Icoms |

The audio-passband waterfall shows only what's inside the rig's current
filter — it is not a band-scope. That is a hard physical limit, not a
shortcoming to fix; the UI labels the span accordingly ("0–3 kHz audio"
vs "14.000–14.300 MHz").

## Current state (audit, 2026-05-21)

POTACAT has **no band waterfall**. It has two bespoke *decode-aid*
waterfalls, both popout-only:

- **JTCAT FT8** (`renderer/jtcat-popout.js`) — Web Audio `AnalyserNode`
  FFT, Canvas-2D `putImageData` shift-scroll, click-to-tune, RX/TX
  markers. ~0–3 kHz.
- **SSTV** (`renderer/sstv-popout.js`) — custom radix-2 FFT (4096, Hann),
  adaptive noise-floor/peak ranging, Canvas-2D shift-scroll, no
  click-to-tune. ~1–2.5 kHz. Has per-slice mini waterfalls.

The Canvas-2D scroll (`getImageData`→`putImageData` shift + per-pixel new
row) is duplicated three times. **No WebGL anywhere.** Bandspread is a
spot map, not a waterfall.

## Architecture

One source-agnostic component plus thin per-source adapters.

### `Waterfall` component (`renderer/waterfall.js`)

A GPU-accelerated, `<script>`-loaded class (no ES modules in POTACAT's
renderer). It consumes **FFT magnitude frames** and knows nothing about
the radio.

Rendering technique — borrowed *in concept* from AetherSDR's QRhi
waterfall, reimplemented in WebGL2:

- The scrollback history is a fixed **ring-buffer texture**
  (`bins × historyRows`, single-channel `R8`).
- Each `pushFrame()` writes **one row** via `texSubImage2D` and advances
  a `rowOffset` uniform.
- The fragment shader wraps the vertical UV with `fract(uv.y + rowOffset)`
  — the whole waterfall scrolls with **no per-frame redraw, no pixel
  copy**. This is the ~70% CPU saving AetherSDR cites.
- The colormap (magnitude → heat colour) runs **in the fragment shader**,
  so changing palette/contrast recolours instantly.

API (Phase 1):

```
new Waterfall(canvas, { bins, historyRows, colormap, gamma, newestAtTop })
  .pushFrame(Float32Array magnitudes)   // any scale — component auto-ranges
  .setMarkers([{ pos: 0..1, color, kind }])   // RX/TX lines
  .onClick(fn)                          // fn(posFraction) — host maps to Hz
  .setColormap('classic'|'turbo'|'viridis')
  .resize()                             // devicePixelRatio-aware
  .destroy()
  .supported                            // false if WebGL2 unavailable
```

Auto-ranging: adaptive noise-floor (slow EMA) + peak (fast-attack /
slow-decay), then gamma — ported from the proven SSTV logic.

### Source adapters

Each adapter produces `Float32Array` magnitude frames and calls
`pushFrame()`:

- **Audio adapter** — captures the demodulated AF (USB CODEC / DAX /
  VITA-49 / K4 Opus — POTACAT already has all of these), runs an FFT
  (the SSTV radix-2 path, shared), emits ~0–3.5 kHz frames.
- **Flex panadapter adapter** — POTACAT, as the GUI client under Flex
  Direct, creates a panadapter on the radio and subscribes to its FFT
  data stream; emits wideband RF frames.

## What we borrow from AetherSDR — and the license

AetherSDR (`github.com/ten9876/AetherSDR`, C++/Qt6, **GPL-3.0**). We do
**not** copy its source. We borrow the *technique*: the ring-buffer
texture + `fract` UV scroll, GPU rendering, the heat-map idea. That trick
is textbook graphics used by countless waterfalls — reimplementing it in
WebGL is clean (the same posture POTACAT already took with AetherSDR's
VITA-49 byte layout). Study for technique; reimplement; never paste.

## User-first decisions

Where "best for the operator" diverged from "easiest to build", we chose
the operator:

- A real **wideband RF panadapter** for the Flex (subscribe to the
  radio's `pan` stream) — not an audio FFT shortcut.
- The waterfall lives in the **main operating view**, not a popout.
- **WebGL**, not the existing Canvas-2D.
- **Spot overlay** — POTA/SOTA/RBN calls drawn on the waterfall. POTACAT
  has the spot data; no other SDR app does. This is the differentiator.

## Phases

Each phase ships operator value. Phase 3 is the hard one and is **core,
not optional** — it is sequenced after its foundation, not deferred for
being hard.

### Phase 1 — `Waterfall` core component *(in progress)*

Build `renderer/waterfall.js`: WebGL2 ring-buffer waterfall, in-shader
colormap, auto-ranging, RX/TX marker lines, click-to-tune callback,
devicePixelRatio resize. Validate by replacing the SSTV popout's
Canvas-2D waterfall with the component — instant smoother result and a
real-world shakedown.

### Phase 2 — Audio adapter + main-view integration

Audio-FFT source adapter (shared radix-2 FFT). Embed the waterfall in the
main operating view for **every radio**, with click-to-tune and the
**spot overlay**. This is the headline ("works on all radios") and the
differentiator, shipped together.

### Phase 3 — Flex true RF panadapter

POTACAT-as-GUI-client creates a Flex panadapter and subscribes to its FFT
tiles → wideband RF into the same component. Flex Direct users get a real
panadapter back — better than what they lost.

### Phase 4 — Consolidate

Move the JTCAT FT8 and SSTV waterfalls onto the shared component; delete
the triplicated Canvas-2D scroll code.

## Testing

- Phase 1: SSTV popout renders on the new component; real SSTV signal
  still shows a clean trace; CPU usage drops vs the Canvas-2D path.
- Phase 2: every rig type shows a live audio waterfall in the main view;
  clicking it tunes the rig; spots appear at the right x-positions.
- Phase 3: a Flex under Flex Direct shows a wideband panadapter that
  tracks the slice.

## Future source adapters (architecture supports, not scheduled)

- Icom CI-V scope-waveform → real panadapter for IC-7300 / IC-705 / etc.
- KiwiSDR / WebSDR remote waterfall data.
- Yaesu FT-710 native scope over USB — **now planned, see Phase 5.**

## Phase 5 — Yaesu FT-710 native band scope *(planned 2026-09-20)*

Requested three times in one Discord thread and as GitHub issue #91 the
same day. This is the first **real RF panadapter for a conventional
radio**, and it lands before Phase 3 because the protocol is documented
to the byte and the operator already owns every part of the path.

### Why it is cheap

The FT-710 has no IF OUT (it is direct sampling), but it puts its own
band scope on the **USB cable that already carries CAT and audio**,
through an FTDI **FT4222 USB→SPI bridge** on the main board. The
SCU-LAN10 LAN box is not required — only its **menu item** enabled.
wfview (`ft4222handler.cpp`), 710 Console, VLSC's MRRC Modern and
kd9taw/Nexus all read it. Everything below is from their published
write-ups; **wfview and Nexus are GPL-3.0 — technique only, never
paste** (the AetherSDR posture). MRRC Modern's licence is unspecified:
do not read its source until that is settled.

### Protocol (verify on a real radio before trusting any of it)

| Item | Value |
|---|---|
| Device | FTDI descriptor `"FT4222 A"`, SPI master, single I/O |
| Clock | SYS_CLK_24 ÷ 64 = 375 kHz; CPOL/CPHA idle-high, leading edge; slave select 0x01 |
| Read | 4096 bytes per transaction, ~30 frames/s from the radio |
| Frame | 850 bins per receiver — WF1 at 0–849, WF2 at 850–1699; 150 B metadata at 2900–3049; sync tail `FF 01 EE 01` |
| Encoding | bins are **inverted**: `~b & 0xFF` |
| Radio menu | SCU-LAN10 enabled (`EX 03-01-26`) |
| After connect | send `EX040101;` (scope output on) and `EX040200;` (CENTER mode) — without both the bridge stays silent |
| Driver | FTDI **LibFT4222** (SPI-master API; bundles D2XX). Closed source. Windows + Linux confirmed by wfview; FTDI ships macOS but the FT-710 path is unreported there |

What the 150-byte metadata block carries (span, centre, mode?) is not
in any write-up read so far. If it names the span, the axis comes from
the frame; if not, it comes from CAT (`EX0402xx` scope span settings).
**Find out in step 0 — the placement maths depends on it.**

### Design

**A native helper process, not an N-API addon.** No Node binding to
LibFT4222 exists (npm `ftdi-d2xx` is D2XX only, no SPI master, three
years stale), and an addon would put a closed-source FTDI library
inside the Electron ABI on three platforms — the glibc and macOS-dyld
lessons argue against it. Instead:

- `helpers/yaesu-scope/` — a small C program linking LibFT4222. Opens
  `"FT4222 A"`, configures SPI, reads 4096-byte transactions, finds the
  sync tail, de-inverts, and writes one **850-byte row per frame** to
  stdout with a 4-byte header (receiver id, sequence, span code, flags).
  Exit codes name the failure: no FT4222 device, LibFT4222 missing,
  bridge opened but silent for 3 s. Nothing else — no CAT, no UI.
- `lib/yaesu-scope.js` — `findYaesuScopeHelper` / `spawnYaesuScope` /
  frame parser, cloned from the rigctld / Mercury supervision pattern
  in main.js (find → spawn → restart with backoff → kill in
  `gracefulCleanup`). Pure parser + placement maths unit-tested.
- main.js sends `EX040101;` / `EX040200;` through the live CAT link once
  the helper reports frames flowing, and **restores the radio's
  previous scope mode on disconnect** — the WSPR power-cap lesson:
  never leave a setting changed behind the operator's back.
- **Source adapter** → `Waterfall.pushFrame()` in a stand-alone
  **pop-out** (the Phase 2 direction), with the spot overlay, RX marker
  from the live dial, and click-to-tune mapping bin → Hz from the span.
- **ECHOCAT** from day one: S2C `scope-frame` (850 B, downsampled to
  ~10 fps ≈ 8 KB/s), hydrated on connect; `renderer/remote.js` draws it
  with the same `waterfall.js` component; hello capability `scope`.
  The mobile app consumes it in its own handoff.

### Diagnostics — the part every silent failure in this project argues for

Nexus got this right and it is copied as behaviour: the pop-out and the
log say **which** piece is missing, in severity order, and never send
the operator into the radio menu on a build that cannot open the
bridge:

1. no LibFT4222 → "Install FTDI's LibFT4222" with the download link
2. no `"FT4222 A"` device → "the FT-710 USB driver is not installed / the radio is not on this USB port"
3. device opens, no frames → "SCU-LAN10 is off in the radio menu (EX 03-01-26)"
4. frames but no sync → protocol drift, log the first 64 bytes hex

Each is a `session.log` line and a bug-report field.

### Scope and gating

- Rig-scoped: the pop-out entry and settings appear only for
  `rigFamily() === 'yaesu'` models that declare `caps.nativeScope`
  (FT-710 first; the FTDX10 may share the bridge — **unknown**, verify
  before declaring it).
- Windows and Linux at launch; macOS ships as unverified until someone
  reports it.
- The Icom CI-V `0x27` scope adapter is the same shape and is the
  natural Phase 6; do not fold it in here.

### Steps

0. Read LibFT4222's redistribution terms; confirm the helper may ship
   inside the installer (wfview redistributes FTDI drivers, which is
   the precedent). Decide bundle vs. "install from FTDI" on that.
1. Helper: build on Windows, open the bridge on a real FT-710, dump raw
   frames to a file. **Needs a tester with the radio** — Casey has no
   FT-710. Candidates: the #91 author, the two Discord askers, KB2UXB.
2. Parser + placement from the dumped frames, unit-tested against the
   captures (`test/yaesu-scope-test.js`, fixtures under `test/fixtures/`).
3. Supervision + CAT enable/restore + diagnostics in main.js.
4. Pop-out on `waterfall.js` with spots and click-to-tune.
5. ECHOCAT wire + web client.
6. Linux build of the helper in the release workflow; macOS attempted,
   shipped as unverified.

### Testing

- Fixtures: at least one raw 4096-byte capture per span setting, with
  the CAT-reported centre and span recorded alongside.
- Parser: sync recovery from an arbitrary byte offset; inverted-byte
  correction; a frame with a corrupt tail is dropped, not drawn.
- Placement: a known carrier at a known frequency lands on the right
  bin for every span.
- Live: the pop-out tracks a VFO turn within one frame; the radio's
  scope mode is back to what it was after POTACAT disconnects.

### Explicitly not this phase

An **external SDR on an IF OUT** (the Yaesu Web Control model — SDRplay
/ RTL-SDR via SoapySDR on a 9 MHz IF tap). Different feature, different
radios (FTDX10/FTDX101 class), heavy native dependencies, and the
operator must own the SDR. Filed with `docs/rtlsdr-rx-only-plan.md`.
