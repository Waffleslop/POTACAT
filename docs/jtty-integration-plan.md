# JTTY in POTACAT — Integration Plan

Status: Casey said go on 2026-10-04 ("build something useful and elegant; it's
okay if it's just a beta"), against rc1. Phase 0 and Phase 1 BUILT the same day
(see the status notes in each phase). Phase 2's receiver is BUILT and verified
against WSJT-X's own tools: identical decisions to rjtty on 40 of 40 noise
files from -14 to -17 dB. Pi timing is open. Phase 3 (engine + main.js
wiring) is BUILT: JTTY is a JTCAT mode the app can run, headless included;
what it lacks is a pane (Phase 4). Pi timing is open.
Filed: 2026-10-04 (WSJT-X 3.2.0-rc1, released 2026-09-24)
Scope: desktop first (engine + JTCAT window), ECHOCAT Web second, mobile by handoff
Reference: WSJT-X `lib/jtty/jtty_design.md` and `lib/jtty/jtty_source_encoding.txt`
at tag v3.2.0-rc1 (GPL-3.0). Both are the normative spec; the Fortran is the
reference implementation.

## What JTTY is

A keyboard-to-keyboard mode built for RTTY-style contest exchanges, with far
better weak-signal performance than 45.45-baud RTTY. Unlike FT8/FT4 it has **no
timed T/R sequences**: a transmission starts whenever the operator sends and
lasts a few seconds. That makes it the sibling of our PSK31, not of FT8.

Facts from the design document (not inferred):

- **Frame:** 1.888 s. A 32-bit source word + 2 control bits (reserved-zero, EOM)
  + CRC-12 = 46 bits; tail-biting rate-1/2 convolutional code, K=10, gives 92
  coded bits = 46 four-tone symbols, preceded by a 13-symbol sync sequence.
- **Waveform:** Gaussian-smoothed 4-FSK (4-GFSK), 31.25 baud at 12 000 Hz with
  384 samples/symbol, 127 Hz occupied bandwidth (99% power). Our engines
  already run at 12 kHz, so no resampling.
- **Source grammar:** four message types in bits 31–32: call actions (`CQ
  <call> CQ`, `<call>`, `TU <call> CQ`, `<call> TU`, `<call> AGN?`, `TU NOW
  <call>`), STRUCT30 typed exchanges (serial, state/province, zone, Field Day
  class+section, GRID4, 18 control phrases, …), and TEXT5 (five six-bit chars).
  A dynamic program picks the fewest frames for arbitrary text.
- **Native macros F1–F8:** `CQ %M CQ`, `%H %E`, `%H TU CQ %M CQ`, `%M`, `%H`,
  `TU NOW %Q %E`, `%H AGN?`, `%E`. `%E` depends on an exchange profile:
  Unknown (decimal serial), Field Day (`<count><class> <section>`), RTTY
  Roundup (serial or state/province).
- **Receiver** verifies FEC, CRC, the reserved bit and the full grammar;
  a structurally invalid word is dropped before display.
- **Test material shipped by WSJT-X:** eight golden 34-bit vectors in the spec
  (e.g. `CQ K1ABC CQ` = `0x026F78D41`, `TEXT5 HELLO` = `0x11395558D`), a
  weak-signal sample `samples/JTTY/260807_134110.wav` (726 KB), and the
  command-line tools `sjtty` (message → waveform, with SNR/Doppler/time
  offset simulation) and `rjtty` (waveform → decodes).

## Why it grafts cleanly

- **Engine host exists.** `JtcatManager.startSlice()` already branches on
  mode to `PskEngine` and `Js8Engine`; JTTY is a third branch. The PSK31
  contract (continuous RX events, one-shot `requestTx()` emitting the
  `tx-start` payload) is exactly JTTY's shape. Every audio route (SmartSDR
  Direct, Icom UDP, renderer capture) feeds engines at the 12 kHz
  `feedAudio` choke points for free.
- **Native addon precedent.** `lib/ft8_native` (C) and `lib/js8_native`
  (C++) show the build: `binding.gyp`, `npm run build-<mode>`, release.yml
  builds on all five jobs with arch verification on macOS, Linux on
  ubuntu-22.04 (glibc 2.35 rule).
- **Licence.** WSJT-X is GPL-3.0; POTACAT is GPL-3.0-or-later. Porting the
  reference code with attribution is permitted, as with JS8.
- **UI precedent.** The JTCAT window's PSK31 pane (`#jp-psk-pane`: scrolling
  RX text + composer + six macro buttons) is the template; the ECHOCAT
  `jtcat-psk-rx` / `jtcat-psk-send` pair is the wire template.

## Why it is not a quick add

- **No bridge is possible.** WSJT-X's UDP `NetworkMessage.hpp` has nothing
  JTTY-specific, so POTACAT cannot listen to a running WSJT-X for JTTY the
  way the WSJT-X bridge does for FT8. POTACAT needs its own codec.
- **Size.** The reference is ~255 KB of Fortran in 31 files. The codec core
  is roughly: `jtty_source_codec.f90` (21 KB, grammar pack/unpack),
  `tbcc.f90` (21 KB, convolutional code), `jtty_tbcc_list_decoder.f90`
  (53 KB) + `jtty_tbcc_decoder.f90`, `jtty_mdecode.f90` (50 KB, the receiver:
  sync search, demod, candidate management), `jtty_peakup.f90`,
  `jtty_payload_correlators.f90`, `jtty_block_pow.f90`, `gen_jttywave.f90`
  (GFSK synthesis), `subtract_jtty.f90`. The rest is GUI/audio glue we do
  not need (`jttyaudio.c`, `portaudio.h`, `update.f90`, `transmit.f90`).
- **Port, not link.** A Fortran toolchain in all five CI jobs (MSVC on
  Windows especially) is a cost we have avoided for every other mode. The
  JS8 port went to C++; JTTY goes to C, like FT8.
- **It is a release candidate.** The design doc records one incompatible
  wire change already (the old `i2=2` "599 + five chars" became STRUCT30 with
  no discriminator) and the commit log calls the doc "final(?)". Build
  against rc1 exactly, pin the tag in the source header, and diff the spec
  again when 3.2.0 final ships.
- **ADIF has no JTTY.** Nothing to log it as until ADIF adds it.

## Phases

Each phase has a checkpoint that must pass before the next starts. Effort is
focused working time, not calendar time.

### Phase 0 — Reference toolchain and fixtures (½ day) — DONE 2026-10-04, one item open

Done: source tarball and Windows package downloaded and SHA-256 verified; the
sample WAV is `test/fixtures/jtty/260807_134110.wav` with its expected decode
in the README there (`RAN ALL NIGHT ON BAND NOISE - NO FALSE DECODES!` at
1507 Hz, from the user guide's screenshot). Reference sources read in full:
jtty_source_codec, jtty_mod (pack_jtty), tbcc, the code profile, jtty_fec_mod,
gen_jttywave, gfsk_pulse, packjt77 pack28/unpack28/callok, chkcall,
packjt77_grammar sections.
Reference tools: built later the same day in a throwaway container (Casey
started Docker Desktop; nothing installed on the machine). Recipe: `gcc:13`
image + `apt-get install libfftw3-dev`; multi-pass `gfortran -O2 -c
-ffree-line-length-none -fallow-argument-mismatch` over lib/jtty/*.f90,
lib/77bit/*.f90 and from lib/: fftw3mod, wavhdr, gfsk_pulse, four2a, twkfreq,
db, chkcall, smo121, hash, hashing, shell, indexx, pctile, fmtmsg,
ft8/watterson; C: lib/lookup3.c, lib/wsprd/nhash.c, lib/wsprd/gran.c; link
sjtty.o / rjtty.o against the rest EXCLUDING the 77bit test programs
(call_to_c28, encode77, free_text, hash22calc, nonstd_to_c58, parse77,
test28) with -lfftw3f -lfftw3. Skip jtty.f90, sjtty_qrm, update, transmit,
jtty_codewords, jtty_spec, jttycom, c_funcs, cdatetime.
Finding: rc1's ARRL section table has 86 entries (GH, NS, TER replace GTA,
MAR, NT; PE and NB appended). POTACAT's FT8 Field Day table in
lib/ft8_native/ft8_lib/ft8/message.c still has the 84-entry list — if WSJT-X
3.2 uses the new table for FT8 Field Day too, that is a separate FT8
interoperability bug to check (not JTTY's).

- Install WSJT-X 3.2.0-rc1 on the dev PC. The release notes say the assets
  include "standalone command-line utilities"; confirm `sjtty` and `rjtty`
  are in the Windows package. If not, build them in WSL from
  `wsjtx-3.2.0-rc1-src.tar.gz` (gfortran).
- Collect fixtures under `test/fixtures/jtty/`: the sample WAV; `sjtty`
  waveforms for a message set covering every grammar family (CQ, call,
  TU/CQ, serial, state, zone+loc, class/section, serial/time, GRID4,
  control phrases, TEXT5 with `#` substitution, multi-frame text) at
  clean, −10 dB and −15 dB with the `sjtty` SNR argument; `rjtty` decodes of
  each as the expected text.
- Pin: `JTTY_SPEC_TAG = 'v3.2.0-rc1'` in the codec header and in the test,
  so a later spec diff is a deliberate step.

### Phase 1 — Encoder (~2 days) — GO/NO-GO — DONE 2026-10-04, in JavaScript

Built as `lib/jtty/` (source-codec.js, fec.js, waveform.js, index.js), pure
JS rather than the C planned here: the encoder is milliseconds of work per
message, POTACAT's WSPR and PSK31 encoders are already pure JS, and this way
it ships with no native build, no CI change and no per-arch verification.
C stays the plan for the Phase 2 decoder, where speed matters.
Checkpoint met (test/jtty-codec-test.js, in npm test and CI): all ten golden
vectors bit-exact; every frame count in jtty_design.md's tables; the RTTY
Roundup normalizations; all 19 jtty_msgs.txt messages round-trip; CRC-12
against an independent polynomial division; the TBCC is linear, tail-biting
and all-zero-preserving; the GFSK waveform (384 sps, BT=2, nsps/8 ramps)
self-demodulates with zero symbol errors. API: `pack(text, profile)`,
`encode(text, {profile, f0, sampleRate})`, `decodeFrames(frames)`.
Cross-checked against sjtty: our 59 channel symbols for `CQ K1ABC CQ` are
identical to sjtty's (now a golden case in the test), and rjtty decodes our
1-, 2- and 9-frame waveforms and the Field Day frame.

- Source grammar **pack**: TEXT5 alphabet, the six call-action forms and the
  standard callsign codec (shared with FT8's `pack28`? JTTY uses "Call8";
  check `jtty_source_codec.f90` before assuming), the STRUCT30 subset the
  GUI actually transmits (serial, state/province, Field Day class+section,
  GRID4, control phrases, GENERIC_NUMERIC, GENERIC_QTH), the minimum-frame
  dynamic program, the three exchange profiles' normalization.
- CRC-12, tail-biting K=10 rate-1/2 encoder (port `tbcc.f90` encode half),
  13-symbol sync, symbol mapping, 4-GFSK synthesis at 12 kHz / 384 sps
  (port `gen_jttywave.f90`; its BT value comes from `jtty_mod.f90`).
- **Checkpoint:** all eight golden vectors bit-exact; every Phase 0 message
  round-trips through `rjtty` to the expected text; our waveform
  cross-correlates with `sjtty`'s for the same message at > 0.99. Node
  addon exposes `encode(text, profile) → {frames, text, pcm}` and
  `pack(text, profile) → {words[]}`.
- If the grammar proves larger than this estimate, stop here and report.

### Phase 2 — Decoder (~4–6 days, the hard part) — BUILT 2026-10-04, in JavaScript

Built as `lib/jtty/dsp.js` (FFT, analytic signal, frequency shift, complex
GFSK reference), `lib/jtty/list-decoder.js` (the packed-survivor WAVA list
decoder and the L=1/2/4 + half-symbol ladder) and `lib/jtty/decoder.js`
(sync surface, QSO-window peak-up, band windows, sync gate, payload
correlations, subtraction and second pass, message assembly). JavaScript
first, as the reference implementation a C port would have to match anyway;
the C port is now a decision for the Pi measurement, not a prerequisite.
Not ported: the retro re-sweep of previous windows after a subtraction, and
the Bluestein narrow-window FFT.
Checkpoint (test/jtty-decoder-test.js, in npm test and CI): the WSJT-X
sample decodes to `RAN ALL NIGHT ON BAND NOISE - NO FALSE DECODES!` at
1506.9 Hz; clean one- and multi-frame messages assemble with EOM; a signal
in a band window and two overlapping signals (second found after
subtraction) decode; 0/-5/-10 dB (sjtty's SNR) decode; 30 s of noise gives
zero decodes. 30.2 s of audio took 7.9 s on the dev PC with every band
window on (~26% of a core); rjtty takes 1.4 s for the same file.
Against rjtty on identical sjtty noise files ("CQ K1ABC CQ", 10 per level):
decodes at -10/-12/-13/-14/-15/-16/-17 dB were 10/10/10/9/9/4/1 for BOTH, and
file by file the two make the same decision on all 40 files from -14 to
-17 dB (test/fixtures/jtty/sjtty-16dB holds five of the -16 dB files with
rjtty's verdicts, checked in CI). rjtty also printed one junk decode on the
WSJT-X sample (`4>-P'` at 1696 Hz) that ours did not. Open: the Pi 5
measurement, and the retro re-sweep.

- Sync search (`jtty_peakup.f90`, `jtty_payload_correlators.f90`,
  `jtty_block_pow.f90`): candidates in time and frequency over a continuous
  12 kHz stream; JTTY has no slot clock, so the search is a sliding one.
- 4-FSK soft demodulation, TBCC list decoder (`jtty_tbcc_list_decoder.f90`),
  CRC and reserved-bit check, grammar validation, EOM assembly of
  multi-frame messages into one displayed text with start time.
- Subtraction of decoded frames (`subtract_jtty.f90`) for overlapping
  signals: second pass, same shape as the FT8 multipass work.
- **Checkpoint:** the sample WAV decodes to the text WSJT-X shows; every
  Phase 0 fixture decodes at clean and −10 dB, and the −15 dB set at a rate
  within a few percent of `rjtty`'s on the same files; **zero decodes** on
  60 s of synthesized noise (the FT8 false-decode test). CPU: continuous
  decode must stay under one core on the Pi 5 (headless target).
- Addon exposes `decoder_create(sampleRate)`, `decoder_feed(pcm)`,
  `decoder_poll() → [{text, tStart, dt, freqHz, snrDb, eom, nframes}]`.

### Phase 3 — `lib/jtty-engine.js` and main.js wiring (~1 day) — DONE 2026-10-04

- `JttyEngine` with the PSK engine contract: `feedAudio()`, continuous
  decode, emits `jtty-rx` (one event per completed message, plus a
  `partial:true` event per frame so the operator sees text arriving as
  WSJT-X does), `requestTx(text, profile)` → one `tx-start` payload (whole
  message, trimmed under the 130 s failsafe like PSK31), `encode-failed` on
  a rejected native macro (the spec says reject, never transmit altered
  meaning).
- `JtcatManager.startSlice({mode:'JTTY'})` branch; `jtcat-set-mode` rebuilds
  the slice on a family switch (the `Ft8Engine.setMode` coercion rule).
- main.js: `jtty-rx` → IPC `jtcat-jtty-rx` (batched like psk-text) and the
  radio-owner lock for TX; no slot or clock-sync logic (none applies).
- Tests: `lib/jtty-engine-test.js` driving the engine with the fixtures.

**Status 2026-10-04 — built, with these departures from the sketch above:**

- The decoder runs in a **worker thread** (`lib/jtty/decoder-worker.js`),
  not inline like PSK31: one quarter-frame step costs ~120 ms of CPU every
  0.47 s, which would stall the Electron main process. `JttyEngine` is the
  thin host — stream clock, UTC stamps, worker lifecycle (restart on exit,
  like JS8's). `new JttyEngine({ worker: false })` runs the decoder inline
  for deterministic tests.
- One event, `jtty-rx`, per decoder update — `complete:false` while a
  message grows, `complete:true` on its EOM — rather than a separate
  `partial:true` event. main.js batches by message id (`jtcat-jtty-rx
  { updates }`, ~250 ms) and logs every completed message as
  `[JTTY] HHMMSS 1506.9 Hz -2 dB: TEXT`.
- During our own transmission the receiver is fed **silence** of the same
  length, not skipped: the decoder's clock stays continuous (a message
  spanning our over still assembles) and a loopback echo of our own TX is
  never decoded.
- **Refuse, never trim.** The reference packer truncates to character*80
  because WSJT-X's text box holds no more; `validateMessage()` refuses an
  81st character, a 17th frame, and anything over the 120 s cap (which the
  16-frame grammar limit makes unreachable, 30 s). The same function answers
  `jtcat-validate-tx-msg`, so the composer's verdict is the transmitter's.
- Rig-mode mapping: everywhere main.js treats `PSK*` as a USB data mode
  (filter presets, QSY-stops-engine test, mode category, SmartSDR DIGU,
  `jtcatUseDataMode`), `JTTY` is beside it; the engine test counts the sites.
- IPC: `jtcat-jtty-send {text, profile}`, `jtcat-jtty-set-profile`
  (`settings.jttyProfile`, applied live), `jtcat-jtty-rx` out; preload
  `jtcatJttySend` / `jtcatJttySetProfile` / `onJtcatJttyRx`. Both
  `familyOf` switches (popout and remote `jtcat-set-mode`) rebuild the
  slice for JTTY, so a remote client that sends `set-mode JTTY` already
  works; the remote RX stream and `jtcat-jtty-send` twin are Phase 6.
- Tests: `test/jtty-engine-test.js` (loopback on both decoder hosts,
  own-echo silence, refusals, re-render on freq/profile change, contract
  surface, manager branch, static wiring guards) in `npm test` and CI.

### Phase 4 — JTCAT window: JTTY pane (~2 days) — DONE 2026-10-04 (beta; live visual check owed)

- Mode select gains JTTY. Pane modelled on `#jp-psk-pane`: a decodes list
  (UTC, DT, freq, SNR, text; rows addressed to `%M` highlighted; click a row
  to set His Call), a composer, F1–F8 buttons with the native templates and
  `%M %H %E %Q`, a serial-number spinner, a queued-call field, and an
  exchange profile selector (Unknown / Field Day / RTTY Roundup; Field Day
  follows `jtcatFdMode` when on). Macro text is user-editable; an edited
  template falls back to literal packing exactly as WSJT-X does, and the
  composer shows the frame count before Send.
- Band dials: JTTY has no watering holes yet. Start from the RTTY segments
  (e.g. 14.080–14.099) as a user-editable table, same mechanism as
  `PSK_BAND_FREQS`.
- Waterfall: 127 Hz marker at the TX frequency; click-to-set.

**Status 2026-10-04 — built (`renderer/jtcat-popout.html/.js`, `#jp-jtty-pane`):**

- JTTY is a visible entry in the mode select (PSK/WSPR stay hidden); the
  pane swaps in like PSK31's and shares its chrome. Decodes are `.jp-row`
  MESSAGES keyed by decoder id: a row appears on the first frame (italic,
  trailing …) and is rewritten until its EOM; CQ rows green, rows naming
  `myCallsign` red-bordered like FT8's directed rows. Click a row → His Call.
  Our own transmissions are red `TX` rows.
- Composer: one `<input maxlength=80>`; Enter sends; the frame counter
  beside it (`jtcat-jtty-validate`, debounced) shows `N frames · X s` or the
  refusal in red and disables Send. F1–F8 buttons and F-keys compose
  (Shift = compose and send); right-click edits a template
  (`settings.jttyTemplates`, null = the eight WSJT-X defaults).
- Fields: His Call (`%H`), Exchange (`%E`, follows the serial/profile until
  edited; Field Day takes `jtcatFdExch`), serial spinner (`settings.jttySerial`),
  Next Call (`%Q`). Exchange profile select (Serial / Field Day / RTTY Roundup →
  `settings.jttyProfile` via `jtcat-jtty-set-profile`).
- **Native-serial rule:** an unedited default template containing `%E` under
  the Serial/Unknown profile is sent with a per-message `rtty-roundup`
  profile (`JttyEngine.setTxMessage(text, {profile})`), so `K1ABC 599 001`
  packs as call + SERIAL (2 frames) instead of three text frames — the design
  doc's "native macros default to serial exchanges". The operator's profile
  never moves from a Send.
- Band dials `JTTY_BAND_FREQS`: the RTTY sub-band edges (14080 etc.) until
  the community settles — not yet a user-editable table.
- Waterfall: a translucent 127 Hz footprint to the right of the (lowest-tone)
  marker; Shift+click split is refused in JTTY as in PSK31 (`isKeyboardMode()`).
  The status strip sweeps across a Send using the PSK31 sweep variables.
- `settings.jttyAudioFreq` persists the audio frequency on Send and is pushed
  after `jtcat-start` (`jttySyncFreq`), the PSK ordering lesson.
- Guards: `test/jtty-engine-test.js` "JTCAT pop-out: the JTTY pane (static)".
  Not yet done: a live look at the pane in a dev instance.

### Phase 5 — Logging (½ day)

- ADIF has no JTTY mode. Interim: `MODE=MFSK SUBMODE=JTTY`, the pattern ADIF
  used for FT4 and JS8 (both are MFSK submodes). `lib/adif-writer.js`
  `adifModeSubmode` gains the mapping; `lib/adif.js normalizeMode` maps it
  back so the worked check mark works. LoTW/TQSL will reject the submode
  until their config updates; say so in the log once per upload. Revisit
  when ADIF assigns it.
- QSO popout prefill from a clicked decode: call, exchange received, our
  serial sent.

### Phase 6 — ECHOCAT (~1–2 days desktop; mobile by handoff)

- Protocol: S2C `jtcat-jtty-rx` (frames with the fields above, replay tail
  on reconnect like PSK), C2S `jtcat-jtty-send {text, profile}`; remote
  `jtcat-start`/`set-mode` accept `JTTY`; hello capability `jtty`.
- ECHOCAT Web: the JTTY pane in the FT8 tab, mirroring Phase 4.
- Mobile: handoff `potacat-meta/work/open/jtty-mobile.md` after the wire is
  final; the app's PSK31 screen is the template.

### Phase 7 — Later (documented, not built)

- Contest auto-sequencing (run/S&P state machine over the native actions,
  the frame table in the design doc's "Contest exchange example").
- N1MM tagged actions (`[[JTTY:<ACTION>]]`) via the existing N1MM UDP port.
- PSK Reporter spotting of JTTY decodes, if/when PSK Reporter accepts it.
- Headless ECHOCAT-only operation (works once Phase 3 lands, untested).

Total: roughly two weeks of focused work, Phase 2 being the uncertain half.

## Risks

- **RC drift.** The wire format changed once already during development
  with no discriminator. Mitigation: pin the tag, keep the fixtures, re-run
  Phase 1/2 checkpoints against 3.2.0 final's `sjtty`/`rjtty`.
- **Decoder fidelity.** The list decoder is 53 KB of Fortran; a port that is
  "nearly" right decodes fine in the clean fixtures and loses the weak ones.
  Mitigation: the −15 dB comparison against `rjtty` is the acceptance test,
  not the clean set.
- **CPU.** A slotless sliding sync search over a continuous stream costs
  more than FT8's once-per-15-s decode. Measure on the Pi 5 in Phase 2.
- **Adoption.** No watering holes, no PSK Reporter support, no ADIF mode,
  no contest sponsor has adopted it. If 3.2.0 final is delayed or JTTY
  changes, the work is parked at whichever checkpoint it reached.

## Decisions for Casey

1. **Go on Phase 0 + Phase 1** as the go/no-go, with Phase 2 only on a
   clean Phase 1 checkpoint?
2. **Build against rc1** knowing the format may still change before 3.2.0
   final, or wait for the final tag?
