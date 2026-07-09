# SSTV ↔ MMSSTV Gap Plan + the 2026-06 Decode Outage

Source: full review 2026-07-07 (codebase deep-dive + MMSSTV v1.13A inventory from
EMMSSTV.TXT/hamsoft.ca + empirical impairment probes + git archaeology). Durable
backlog; the reference sections exist so future sessions don't re-research.

## Part 0 — Why users "can't decode" (the last ~30 days)

Two separate things, both real:

### 0a. HARD OUTAGE — Flex Direct 8000-series, v1.8.15→v1.8.17 (Jun 21–25)

Commit 066d053 (2026-06-16, shipped v1.8.15) default-muted the slice via
`audio_mute` to silence the 8600's front-panel speaker, **explicitly believing
the DAX tap was independent** ("so JTCAT/SSTV RX audio is unaffected"). On real
hardware (4.2.x at least) **audio_mute kills the DAX RX tap** — the tap rides
the slice monitor mix — so every Flex-Direct 8000-series user with the default
`flexOnboardSpeaker=off` had **zero JTCAT/SSTV decode audio** on v1.8.15–1.8.17.
Fixed 2026-06-26 (c531fd5, shipped v1.8.18/v1.9.0): never mute; `audio_level=0`
silences the speaker while DAX stays full-scale (hardware-confirmed on Casey's
8600). See main.js:6898-6917.

**Residual failure classes that persist on current builds:**
1. **Firmware question (UNVERIFIED)**: `audio_level=0` keeping DAX alive was
   confirmed on ONE radio (8600M, Casey's firmware). If any firmware ties the
   DAX tap to slice AF gain the way 4.2.x tied it to audio_mute, those users are
   STILL deaf. → Ask an affected reporter (e.g. W2ECK, 8600) to run
   scripts/probe-flex.js's audio test on current firmware.
2. **DAX-channel conflict** (main.js:6944-6956): when SmartSDR runs alongside
   and fights for the channel, POTACAT deliberately stops re-taking it and
   warns once — decoder silent from then on. The exact population that ALSO
   runs MMSSTV (fed by SmartSDR's DAX program, which keeps working) — matching
   the "MMSSTV decodes, POTACAT doesn't" reports precisely.
3. **Slot-yield** (multiFlex off): opening SmartSDR makes POTACAT yield; while
   bound, audio depends on the host GUI's DAX config — silent in several
   arrangements.
4. **Asymmetric mic-fallback gate**: with `audioSource='smartsdr'`, the popout
   NEVER captures mic/DAX-device audio (renderer/sstv-popout.js:1577
   unconditional skip) while main only substitutes VITA-49 audio when the
   stream actually runs. Any smartsdr-flagged state without a live stream =
   guaranteed total silence with no error. The skip should mirror main's
   `&& smartSdrAudio` condition (renderer can't see it — needs an IPC state
   flag) or at minimum surface "no audio arriving" in the popout.

### 0b. CHRONIC SENSITIVITY — why "MMSSTV still remains better"

Empirical probes (test/sstv-e2e-test.js section B2, reproduced identically on
June-5 code — long-standing, not a regression):

| Condition | POTACAT | MMSSTV practice |
|---|---|---|
| Clean, on-frequency | ✓ decodes | ✓ |
| Off-tune +50 Hz | ✓ | ✓ |
| **Off-tune ≥100 Hz** | **NOTHING — no VIS, no image** | Decodes (shifted colors); operator sees markers |
| AWGN ≥8 dB SNR | ✓ | ✓ |
| **Joined late / missed VIS** | **NOTHING** | Sync-interval auto-start decodes the rest |
| Weak/borderline image | **Silently discarded** by the quality gate (`_decodeLooksReal`) | Always paints SOMETHING |

Root causes:
- **±75 Hz VIS front door**: the leader/VIS envelope resonators are
  1900 Hz Q=25 and 1100/1300 Hz Q=30 (BW ≈ 76/37 Hz) — a 100 Hz tuning error
  starves them (sstv-worker.js:435-438). Real 14.230 operation routinely has
  50–300 Hz spreads. This is the single biggest "MMSSTV works, we don't."
- **No sync-interval auto-start**: VIS-or-nothing. MMSSTV measures sync-pulse
  intervals and starts mid-transmission.
- **Silent discard**: failing `_decodeLooksReal` throws the whole image away
  with no user-visible trace (sstv-worker.js:1139). MMSSTV's model: show the
  noisy image, let the human judge.

## Part 1 — Parity roadmap (proposed priority)

1. **Silent-failure UX — BUILT 2026-07-07.** Two-tier decode gate
   (`_decodeQualityTier`: good/weak/reject — weak emits with `weak:true`,
   shown with an orange badge, never auto-saved; noise still dies at reject
   and the false-emit guard enforces it). Popout "✕ NO RX AUDIO" badge
   (5 s silence watchdog over both ingress paths). Recency-based smartsdr
   gates BOTH sides: popout mic capture resumes within 3 s of the VITA
   stream going quiet (the 0a outage class now self-heals); main mirrors via
   lib/sstv-feed-gate.js (pure, 24 table tests, CI-wired).
2. **AFC / wide VIS capture — BUILT 2026-07-07.** Idle-state tracker
   (`_afcTrack`: magnitude-qualified rawFreq EMA, ±300 Hz capture, 60 ms
   sustain) retunes all four ToneEnvelope resonators (`_setToneOffset`);
   leader gate validates against the retuned center; freqOffset stays
   absolute. Plus a time-based fresh-pulse arm fallback in decoding,
   STRICTLY gated on an active retune (two level-based variants cost the
   martin1 clean ratchet ~1 dB — see the comment in _stateDecoding).
   ±200 Hz off-tune and +150 Hz @ 10 dB now decode — locked as ratchets.
   NOTE: MMSSTV has no AFC at all; this is now a differentiator.
3. **Sync-interval auto-start — BUILT 2026-07-07.** `_trackIdleSync` (runs
   in IDLE **and** LEADER — content can false-lock the leader detector) with
   a rising-edge-over-slow-baseline onset detector (τ=200 ms EMA; the plain
   sync boolean can't fire mid-image), ≥5 consistent intervals matched to
   the mode table (M1/M3, M2/M4 timing collisions resolve by commonality),
   Scottie in-line sync offset backfilled. Late-join ratcheted.
4. **RX buffer + redecode — BUILT 2026-07-07.** Raw capture now re-arms per
   transmission (also fixes an unbounded cross-decode append). Worker
   `redecodeBuffer({slantPpm})` + engine/IPC/preload chain + popout
   "↻ Redecode" button (slant slider px → ppm). Human-initiated replays
   never hard-reject (worst case weak), display-only (no auto-save), and
   the final image now actually repaints the RX canvas (post-processed).
5. **Auto-resync mid-image**: on sync loss, re-acquire and continue (MMSSTV
   renders a glitch bar; we currently drift or stall to partial).
6. **Missing modes**: PD-50, PD-290, SC2-60/120/180 (Wraase), Pasokon P3/5/7,
   Robot B/W 8/12, AVT 90, MMSSTV MP/MR/ML families, narrow MP-N/MC-N. Priority
   order by on-air reality: **PD-50 + SC2-180 first** (heard on HF), MP/MR
   (MMSSTV-native users), the rest long-tail. All 15 current modes are already
   TX+RX.
7. **FSK ID (FSKID)**: decode the 45.45-baud callsign trailer + auto-fill log;
   encode after TX (before CW ID). Already a PENDING todo in sstv-test.js.
8. **Tuning aid parity**: 1200/1500/1900/2300 markers on the popout waterfall
   (we show 1000–2500 with no markers), plus a measured-offset readout once
   AFC exists.
9. **Notch + LMS filters**: click-to-notch on the waterfall; leaky-LMS noise
   filter toggle.
10. **Demodulator options**: MMSSTV offers zero-cross/PLL/Hilbert profiles; we
    have one Hilbert pipeline. Low value — ours is good — but a "sharpness"
    (OutLPF cutoff) control is cheap and users expect it.
11. **Repeater/beacon mode** (`-r` parity): tone-triggered repeat + periodic
    beacon from history/stock with template overlay. Niche; pairs naturally
    with our headless mode.
12. **PD quality push** (grade D+ → B): vertical chroma interpolation +
    chroma-aware two-pass replay (the deferred YCbCr resampler work).
13. **Clock calibration**: one-click WWV-style soundcard clock measure with
    separate RX/TX offsets persisted per audio device (our slant machinery
    already measures ppm — persist and pre-apply it).

**Deliberate non-goals**: TWAIN/scanner capture, IE-era import paths, digital
SSTV (EasyPal territory), AVT90 unless someone actually asks (no sync pulses —
whole special path for a dead mode).

### What we already have that MMSSTV doesn't
Auto slant via least-squares + MAD outlier rejection (MMSSTV-equivalent
"high-accuracy" method, automatic), two-pass drift replay, MMSSTV-style
post-processing defaults, templates with drag/rotate text layers + reply-PiP,
multi-slice (4 radios at once), ECHOCAT phone remote, auto-SSTV idle watch,
CW ID, headless operation, per-image JSON metadata sidecars.

## Part 2 — "Decoder never breaks" test strategy

**Shipped 2026-07-07: `test/sstv-e2e-test.js` (CI-wired, 23 s)** — closes the
two seams the outage proved: (A) live `SstvEngine` round-trips (real worker
thread, transferable buffers, event bridge, worklet-sized chunks) for Martin M2
+ Robot 36; (B) real-world front-door ratchets (clean/+50 Hz/8 dB AWGN/deep
QSB locked) + 5 PENDING MMSSTV-parity contracts (±100–200 Hz, late join, 5 dB)
that flip to assertions as roadmap items land.

Remaining test debt, in priority order:
1. **Ingress-gate unit tests**: extract the four feed gates (smartsdr/K4/
   icom/mic + `_sstvFeedPaused`) into a pure decision function
   (`lib/sstv-feed-gate.js`) à la rig-controls registry, and table-test every
   (audioSource, streamAlive, catType, breaker) combination — the 0a class of
   bug becomes a red test instead of a field report. Same for the popout skip
   gate once it mirrors main.
2. **Upsampler unit tests**: the 2× (SmartSDR), 4× (K4) and generic resample
   paths in main.js are pure loops — feed a sine, assert spectrum/energy.
   A wrong ratio = every decode fails at exactly one ingress.
3. **Sample-rate seam**: assert the worker rejects/adapts when
   `set-sample-rate` ≠ 48000 (today filters stay built for 48 k — either
   rebuild them or fail loudly; test whichever is chosen).
4. **Real off-air fixtures**: extend the single SmartSDR-noise .pcm with 3–4
   REAL received recordings (strong / weak / off-tune / QSB — record via the
   gallery's raw buffer) and assert decode/no-false-emit on each. Synthetic
   probes approximate; fixtures don't lie.
5. **VIS matrix**: all 15 VIS codes through the real state machine, plus the
   single-bit-error-correction path, plus truncated-leader cases.
6. **Quality-gate contract**: a borderline fixture asserting the gate's
   accept/reject boundary — so gate tightening (the bd7c629 class of change)
   shows up as a diff in a test, not as users going silent.
7. **TX chain smoke**: dax_tx decimation, Icom conditioning, CW-ID append —
   pure functions, assert lengths/spectra.

CI note: full battery (sstv-test + quality + e2e) ≈ 3 min of the 5-min job;
bump `timeout-minutes` if more fixtures push it over.

## Part 3 — MMSSTV reference (so we never re-research)

- Mode list (v1.13A): Robot B/W 8/12, Robot 24/36/72, AVT 90, Scottie 1/2/DX,
  Martin 1/2, SC2-60/120/180, PD50/90/120/160/180/240/290, P3/P5/P7,
  MP73/115/140/175, MR73/90/115/140/175, ML180/240/280/320, narrow MP73-N/
  MP110-N/MP140-N + MC110-N/MC140-N/MC180-N (video 2044–2300, sync 1900,
  separate narrow VIS). All modes TX+RX.
- RX: VIS auto-start + sync-interval mode inference fallback ("VIS only"
  option), 4-level squelch, auto restart on new VIS, auto stop on sync loss,
  auto resync mid-image, 270 s RAM/FILE RX buffer with redraw-after-adjust,
  real-time auto slant + least-squares high-accuracy slant (<2 ppm, ≥16
  lines), draw-a-line manual slant + phase click tools, 3 demodulators
  (zero-cross / PLL / Hilbert; Mori recommends Hilbert @11025), 8 demod
  profiles, RX BPF sharpness, click-to-notch FIR, leaky-LMS filter,
  linear/17th-poly level converter + 20 s self-cal, sharpness slider,
  spectrum markers 1200/1500/1900/2300, **NO AFC** (manual tuning by
  markers), WWV clock cal with separate TX offset, RX history 32+ (configurable)
  with auto-copy folder, FSKID decode → log callsign autofill.
- TX: template overlays with %c-style macros, transparent-color compositing,
  300-image stock gallery with per-image template association, clipboard/
  drag-drop everywhere, header-bar + 240-line geometry helpers, CW ID +
  FSKID (+contest number), 1750 Hz tune button, MMTTY-style PTT/radio
  commands, internal/external loopback, `-i` (tones −1000 Hz).
- Repeater mode (`MMSSTV -r`): 1750 Hz tone-answer CW ID, RX→replay,
  busy-channel squelch guards, periodic beacon from history/stock + templates.
- The decode core exists as the redistributable **MMSSTV Engine** COM/DLL —
  usable as a behavioral oracle for A/B fixture comparisons.
- Community verdict on "why MMSSTV just works": auto slant, replay-from-
  buffer, no-VIS start/resync — NOT AFC (it has none). Beating it on
  off-tune capture (roadmap #2) would be a genuine differentiator.
