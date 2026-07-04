# RTL-SDR (and other receive-only SDRs) as a listening-only "rig" — Plan

**Status:** proposed, not started (written 2026-06-22). Saved for later.
**Why:** users who own only an RTL-SDR (no transceiver) want to enjoy POTACAT's
spots passively — click a spot, *hear* it, watch a waterfall, optionally decode
FT8/CW/SSTV — even though they can't transmit.

---

## 1. The core architectural fact (read first)

POTACAT's **"rigs" are transceivers** — every rig assumes CAT control **plus
TX/PTT**. There is **no receive-only rig type** today. But POTACAT already has a
"listen via a receiver" path that is 90% of the abstraction we need:

- **WebSDR / KiwiSDR RX-assist** (`lib/kiwisdr.js`, `lib/websdr.js`,
  `lib/sdr-directory.js`, `scripts/probe-sdrs.js`). These tune a receiver
  (freq + mode) and stream **already-demodulated audio** into POTACAT's audio +
  decode pipelines. Today they're a side-panel ("RX-assist"), not a "rig."

**The gap that makes RTL-SDR different from KiwiSDR:** an RTL-SDR emits **raw IQ**,
not audio. KiwiSDR/WebSDR demodulate **server-side**. POTACAT has **no local
IQ→audio demodulator** — it has FFT-for-waterfall (Flex DAX IQ + the WebGL
waterfall) but nothing that turns raw IQ into SSB/CW/AM/FM audio. That missing
demodulator is the entire difference in cost between the two paths below.

---

## 2. Two implementation paths

### Path A — bridge an external SDR app (LOW effort, mostly works today)
The user runs **SDR++ / GQRX / SDRangel**, which does the demod and exposes:
- a **rigctld-compatible control port** (GQRX "Remote control" :7356; SDR++
  `rigctl_server` module), and
- demodulated **audio** on an output device / virtual cable (VB-Cable, BlackHole,
  PulseAudio loopback).

POTACAT **already speaks rigctld CAT** (`RigctldCodec`) and **already captures
audio devices**, so it can treat the dongle (via that app) as a receiver with
little new code. The only real new piece is the **RX-only rig profile** (§3).
- **Pro:** ships fast, low risk, reuses everything, works for *any* SoapySDR
  device (Airspy, SDRplay, HackRF-RX, …), not just RTL-SDR.
- **Con:** user must run a second app and wire a virtual audio cable.

### Path B — native RTL-SDR (HIGH effort, the "real" feature)
POTACAT talks to the dongle directly — via **`rtl_tcp`'s IQ stream** (easiest,
cross-platform, no native build) or a **librtlsdr / SoapySDR native addon** — and
**demodulates IQ→audio itself**: tune within the captured bandwidth, channel
filter, SSB/CW/AM/FM demod, AGC, resample to 12 kHz for the decoders.
- **Pro:** "plug in a $30 dongle and just listen," no second app. POTACAT is a
  reasonable home for it — IQ-waterfall plumbing exists, and there's a strong
  native-DSP track record (FT8, SSTV, FreeDV/RADE).
- **Con:** building/porting a demodulator + IQ transport is real work; per-platform
  native build risk if we go the librtlsdr/Soapy route (prefer `rtl_tcp` first to
  avoid it — cf. [[reference_native_addon_glibc]]).

**Recommended sequencing:** Path A first (unblocks users now + builds the RX-only
abstraction), Path B later only if there's demand for the no-second-app UX.

---

## 3. The shared new piece either way: an **RX-only source/rig type**

A device that **has a VFO** (tunes on spot-click / keypad) and **feeds audio →
decode pipelines + waterfall**, but has **NO TX**. This is the load-bearing new
abstraction and it generalizes well (KiwiSDR/WebSDR should become first-class
RX-only rigs too, not a side panel — aligns with [[project_waterfall]]'s
"waterfall for all radios").

Concretely:
- **Rig model flag** in `lib/rig-models.js`: add `rxOnly: true` (and/or a
  `caps.tx: false`). Reuse the existing `caps` system (same mechanism as the
  Kenwood `commands` override and FT-710 caps).
- **Suppress all TX paths** when `rxOnly`: PTT/Halt, CW keyer, SSB-over-DATA mode
  switch, ATU, power set, split, XIT-on-TX, the JTCAT/WSPR/SSTV **transmit**
  sides, voice macros. Audit every `setTransmit` / `gatedSetTransmit` /
  `handleRemotePtt` entry and gate on `model.rxOnly`. The UI must hide TX controls
  (don't just disable — these users will never TX).
- **Tuning maps to the receiver:** spot-click / VFO → set receiver center/VFO
  (rigctld `F`/`M`, or native IQ retune). No mode-before-freq transceiver dance.
- **Audio source:** a new `audioSource` value (e.g. `'sdr-rx'`) or reuse the
  device-capture path; for Path B, the demodulator output feeds the same internal
  audio bus the decoders + the "listen" output already consume.
- **ECHOCAT / remote:** RX-only naturally fits the thin-client model — the phone
  could listen to an RX-only host with **TX controls hidden** (ties into the
  broader RX-only-UI work; cf. the mobile VFO-controls items).

---

## 4. Caveats to surface in UI / docs (set expectations)

- **HF needs the right hardware.** A stock RTL2832U starts ~24 MHz. HF POTA
  listening requires a **direct-sampling RTL-SDR Blog V3/V4** or an **upconverter**.
  State this up front or 20 m users will be disappointed.
- **Listen-only by definition.** Log/QSO flows are read-only for these users
  (they can still log manually, but there's no TX/answer). That's the ask, not a
  bug — but the UI should make "receive only" obvious.
- **Sample-rate / CPU:** RTL is happiest ≤2.4 Msps; demod + waterfall on a Pi
  (cf. [[project_linux_alsa_native_addon]] RPi/SDR users) needs care.

---

## 5. Phasing

- **Phase 1 — RX-only rig profile + external-app bridge (Path A).**
  `rxOnly` cap, TX-suppression audit, rigctld RX rig profile (preset pointing at
  GQRX/SDR++ rigctl port), audio-source wiring, UI hides TX. Acceptance: connect
  GQRX driving an RTL-SDR, click a POTA spot → POTACAT tunes GQRX → audio plays
  and FT8/CW decode runs; no TX control is reachable.
- **Phase 2 — native RTL-SDR via `rtl_tcp` + IQ demod (Path B).**
  `rtl_tcp` IQ transport, an SSB/CW/AM/FM demodulator (tune-within-bandwidth +
  AGC + 12 kHz resample), feed the waterfall from the same IQ. Acceptance: plug a
  V4 dongle (or run `rtl_tcp`), pick "RTL-SDR" as the rig, no second app needed.
- **Phase 3 (optional) — SoapySDR backend** to cover Airspy/SDRplay/HackRF-RX with
  one code path; only if demand justifies the native-build cost.

---

## 6. Open questions for the requesting user / Casey

1. **Does the user already run SDR++/GQRX, or do they want POTACAT to talk to the
   dongle directly?** This decides whether Phase 1 alone satisfies them.
2. What hardware do they actually have (plain RTL2832U vs V3/V4 vs upconverter)? —
   determines whether HF even works.
3. Scope of "listening": just audio + waterfall, or full passive **decode**
   (FT8/CW/SSTV) too? (Decode mostly comes for free once audio is on the bus.)

---

## 7. Reuse map (where the code already lives)

- `lib/kiwisdr.js` — tune + stream-demodulated-audio pattern (closest template).
- `lib/websdr.js`, `lib/sdr-directory.js`, `scripts/probe-sdrs.js` — receiver
  picker / directory plumbing.
- `lib/rig-models.js` + `caps` — where `rxOnly` hangs.
- `RigctldCodec` (rig-test references) — Path A control backend, already supported.
- WebGL waterfall ([[project_waterfall]], `docs/waterfall-plan.md`) — IQ→spectrum
  display already exists; Path B feeds it from RTL IQ.
- `handleRemotePtt` / `gatedSetTransmit` / `setTransmit` — the TX entry points to
  gate behind `rxOnly`.
