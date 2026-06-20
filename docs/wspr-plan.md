# WSPR in POTACAT (JTCAT) — Plan

Adding WSPR beacon + receive to JTCAT, selected from the FT8/FT4/FT2 mode dropdown.

---

## 1. Why people use WSPR (this shapes everything)

WSPR ("whisper" — Weak Signal Propagation Reporter) is **not a QSO mode**. You never work anyone. It's a **propagation beacon + global reporting network**. The entire point is *answering propagation questions with data*:

- **"Where is my signal getting out right now?"** — TX a low-power beacon; every station that decodes you uploads a spot to **wsprnet.org**, which plots it on a map. You see your real-time footprint by band/time/power.
- **Antenna & station A/B testing** — objective SNR reports from fixed distant receivers let you compare antennas, heights, or grounds without a human on the other end.
- **Band-opening monitoring** — run **RX-only** and watch what's propagating to you, from where, on which bands.
- **Miles-per-watt / QRPp** — WSPR routinely decodes at −28 dB SNR, so people beacon at 1 W, 100 mW, even 10 mW to measure how far a whisper carries.
- **Unattended 24/7 operation** — a WSPR beacon is the classic "leave it running" propagation sensor.

Two consequences for our design: (1) **it's mostly RX with occasional, brief, low-power TX**, and (2) **the value is the wsprnet network** — a WSPR feature that doesn't report to/from wsprnet is half a feature.

---

## 2. How WSPR works (protocol, briefly)

- **Message:** callsign (28 b) + 4-char grid (15 b) + power in dBm (7 b) = **50 bits**. Non-standard/long calls use hashed "type-2/3" messages spread over two transmissions.
- **FEC:** K=32, rate-1/2 convolutional code → **162 channel symbols**.
- **Modulation:** continuous-phase **4-FSK**, **1.4648 baud**, 1.4648 Hz tone spacing → ~**6 Hz** occupied bandwidth. Each symbol = sync_bit + 2×data_bit (tones 0–3), sync from a fixed pseudo-random vector.
- **Timing:** 162 × 0.682 s ≈ **110.6 s** of TX inside a **120 s (2-minute) T/R window**; TX begins **~1 s after the even minute** (00, 02, 04…). RX integrates the full 2 minutes.
- **Spectrum:** a **200 Hz-wide sub-band** per band at a fixed dial (e.g. 20 m = 14.0956 MHz USB, audio 1400–1600 Hz).

This is a **slow mode** — a 2-minute cadence, not 15 seconds. That alone makes it a different rhythm from FT8/FT4/FT2.

---

## 3. How WSJT-X implements WSPR (what we're matching)

- A **dedicated WSPR mode** (not one of the "fast" QSO modes). One decode pass per 2-minute cycle on the captured audio.
- **Decoder = `wsprd`** (GPLv3, K1JT/K9AN): FFT candidate search across the 200 Hz window → synchronize on the sync vector → soft-symbol extraction → **Phil Karn sequential (Fano) decode** of the convolutional code → **two-pass decode that subtracts each successful signal**, so weaker spots hiding under stronger ones are recovered.
- **TX %** — a slider for the fraction of cycles to transmit (default ~20%). Beacon occasionally, listen the rest. Randomized so multiple stations don't always collide.
- **Power (dBm)** reported in the message; operators keep actual RF low.
- **Band hopping** — an optional coordinated schedule that QSYs the radio through a band list over the day so one station beacons many bands.
- **Auto-upload** decoded spots to **wsprnet.org** (keyed by your callsign + grid).

---

## 4. How it fits POTACAT — reuse vs. new

**Already there / reusable:**
- JTCAT engine cycle skeleton (`lib/ft8-engine.js` already parameterizes cycle length per mode — FT8 15 s, FT4 7.5 s, FT2 3.8 s; WSPR is just 120 s).
- The worker's **pluggable-decoder pattern** — FT4 and FT2 are already separate submodules (`lib/ft4/`, `lib/ft2/`) loaded alongside the native FT8 decoder. WSPR slots in the same way.
- Audio capture → worker pipeline; SmartSDR-Direct / DAX TX+RX audio paths.
- WSPR is **already a known mode** in the rig layer (`flexMode` mapping + band QSY tables in `main.js`/`app.js`), so tune-to-dial works.
- POTACAT **already ingests external WSJT-X WSPR decodes over UDP** (`lib/wsjtx.js`, `WSPR_DECODE = 10`) — useful as a Phase 0.
- Leaflet map + RBN/PSKReporter map views to reuse for a "where am I heard" overlay.

**New work:**
- 120 s cycle + **TX-at-+1s** + **TX% scheduler** (mostly-RX rhythm).
- **WSPR encoder** (beacon).
- **WSPR decoder** — the crux (see §5).
- **wsprnet.org upload** (RX spots) + optional "your spots" pull.
- A **WSPR-specific panel** — the QSO state machine (decode→reply→log) does **not** apply; WSPR has no QSOs.

---

## 5. The decoder — the crux (and a license decision)

`ft8_lib` (our MIT FT8 engine) has **no WSPR**. Every quality WSPR decoder in existence — `wsprd` (WSJT-X), `k9an-wsprd`, `pavel-demin/wsprd`, `WSPRpi/WSPR-Decoder` — descends from K1JT/K9AN and is **GPLv3**. There is **no permissive (MIT/BSD) equivalent**, because the hard part (sequential decode of the conv code, 2-pass subtraction) is K9AN's work.

POTACAT currently sets **no license** in `package.json`; `ft8_lib` is MIT. Linking GPLv3 `wsprd` into the POTACAT binary makes the **distributed app GPLv3** (copyleft).

**Options, best to worst for us:**

1. **Native `wspr_native` addon (recommended).** Port `k9an-wsprd`/`wsprd` to an N-API addon mirroring `lib/ft8_native/`, and **swap its `libfftw3` dependency for the `kiss_fft` already bundled with ft8_lib** — avoids a new third-party lib and the GLIBC/cross-build risk that bit us before. Decode quality = WSJT-X. **Cost: POTACAT must adopt GPLv3** (a relicense). Most ham apps are GPL and you're already "free & open source," so this is likely fine — but it's *your* call.
2. **Separate bundled `wsprd` process.** Ship the `wsprd` binary and shell out to it per cycle (write the 2-min audio to a `.wav`/`.c2`, read the decode lines). As "mere aggregation," this keeps POTACAT's own license separate from GPL. **Cost:** clunkier (process spawn + file handoff each cycle), and a binary to build/ship per platform.
3. **External-WSJT-X only.** Surface the WSPR decodes POTACAT already receives over UDP. Zero decoder work, but **requires the user to run WSJT-X** — which defeats "inside POTACAT."

**The encoder is not a license problem** — WSPR's 50-bit pack + conv code + sync vector are fully specified, and clean-room MIT encoders exist (Arduino/QRP-Labs style). We write our own (~150–200 lines).

**Recommendation:** Option 1 (native addon, kiss_fft) for the decoder, clean-room encoder, **and** use Option 3 as a no-cost **Phase 0** to build/validate the WSPR UI against real decodes while the native decoder is in progress.

---

## 6. Phased delivery

> **STATUS (2026-06-19).** The entire pure/testable layer is built — **53 tests
> passing**, zero GPL in POTACAT's own code:
> - ✅ Decode bridge `lib/wspr-decoder.js` (separate-process wsprd, parser) — 10
> - ✅ Engine/worker WSPR mode wiring (120 s capture → `wspr-spots`) — JTCAT 162/162
> - ✅ Clean-room encoder `lib/wspr/encode.js` (pack→conv→ilace→sync→4-FSK) — 19
> - ✅ Beacon scheduler `lib/wspr/scheduler.js` (TX%, timing) — 13
> - ✅ Bands/dials + wsprnet upload `lib/wspr/{bands,wsprnet}.js` — 11
>
> **Remaining (needs Casey's environment to run/verify):**
> - ⏳ Build the GPLv3 `wsprd` binary — runbook at `third_party/wsprd/BUILD.md`.
>   Unlocks RX **and** the encoder loopback gate (`SYNC_VECTOR_VERIFIED`).
> - ⏳ main.js + renderer UI wiring (mode dropdown, WSPR panel, spot list,
>   beacon TX scheduling controls) — the data/engine layer makes this mechanical.


**Phase 0 — WSPR view via external decodes (optional, ~1 day).** Render the WSPR decodes POTACAT already gets from a running WSJT-X (UDP) in a new WSPR spot list. Proves the UI and the wsprnet display with no decoder.

**Phase 1 — Native WSPR RX + decode.**
- Worker mode `wspr-decode`; capture a full **120 s** audio buffer (extend the engine's per-mode buffer/cycle table).
- `wspr_native` addon (wsprd port + kiss_fft) → `[{ call, grid, dBm, snr, dt, freqHz, drift }]`.
- Engine: `WSPR_CYCLE_SEC = 120`, decode fires near cycle end (audio is the whole window).
- UI: WSPR spot list (time, call, grid, SNR, drift, freq, distance/bearing).

**Phase 2 — WSPR TX beacon.**
- Clean-room WSPR encoder: pack 50 bits → conv encode → interleave → sync vector → 4-FSK synth → 12 kHz audio.
- TX at **+1 s into the even minute**; **TX% scheduler** (default 20%, randomized); **Power (dBm)** field; reuse the SmartSDR-Direct/DAX TX path.
- Part-97: WSPR is unattended-friendly *as a beacon*, but keep the existing attended-operator watchdog story coherent (WSPR runs on its own calling sub-bands, unlike the ULTRACAT FT8 case).

**Phase 3 — Network + band hopping.**
- **Upload RX decodes to wsprnet.org** (the propagation map — keyed by callsign+grid). This is what makes it WSPR.
- **"Where am I heard"** — pull your spots from wsprnet and overlay on the existing Leaflet map (reuse RBN/PSKR map plumbing).
- Optional **band hopping** (coordinated schedule) for multi-band beaconing — most powerful on the Flex (QSY via the API).

---

## 7. UI

- Add **WSPR** to the JTCAT mode dropdown (`FT8 / FT4 / FT2 / WSPR`).
- Selecting WSPR **swaps the QSO panel for a WSPR panel** (the reply/sequence controls don't apply):
  - **TX% slider**, **Power (dBm)** dropdown, **TX enable** toggle, **next-TX countdown**, band selector / **Hop** toggle.
  - **Spot list:** time, call, grid, SNR, drift, freq, distance + bearing.
  - **Upload to WSPRnet** toggle + a link to your wsprnet map.
  - Reuse the waterfall, zoomed to the 200 Hz WSPR window.
- Because it's a slow, mostly-RX mode, make the **TX% and next-TX countdown prominent** so the 2-minute rhythm is obvious.

---

## 8. Decisions for Casey (in priority order)

1. **License — the gating decision.** Accept **GPLv3** for POTACAT (native wsprd link, cleanest integration) vs. **separate-process wsprd** (keeps license flexible, clunkier) vs. **external-WSJT-X-only** (no native decode). Everything downstream depends on this.
2. **Scope of v1:** full beacon + RX + wsprnet, or RX + wsprnet-report first (beacon later)?
3. **Band hopping** in v1, or single-band first?
4. **wsprnet identity:** reuse callsign + grid from Settings; add a wsprnet upload toggle (and confirm we attribute uploads correctly under multi-op profiles).

**My recommendation:** Phase 0 now (free, proves the UI), commit to **Option 1 (native addon + GPLv3 relicense)** for real decode, then Phases 1→2→3. If GPLv3 is a hard no, fall back to the separate-process decoder.
