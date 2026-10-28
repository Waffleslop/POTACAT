# Icom band scope over CI-V — plan

Casey, 2026-10-28: "Let's bring in ICOM next." The fourth source for POTACAT's band
scope, after the FT-710 (lib/yaesu-scope.js), the Flex panadapter (lib/flex-scope.js)
and a separate SDR (lib/sdr-scope.js). Every Icom with a spectrum scope streams it over
the same CI-V link POTACAT already drives the radio with, so nothing new is plugged in:
no helper binary, no driver, no second cable.

Status: PLANNED. Nothing built yet.

## 1. What the radio does (Icom's own references, checked)

Sources: IC-705 CI-V Reference Guide (Icom Europe, 2020-07-21) and IC-7300 Information
v1.40 (CI-V section); Hamlib `rigs/icom/icom.c icom_parse_spectrum_frame` and the
per-model `spectrum_scope_caps`, which have been field-tested against these radios.

Command 27 (scope), subcommands:

| Sub | Meaning | Read | Write |
|---|---|---|---|
| 00 | Waveform data (the radio SENDS this, unsolicited, while 10 and 11 are ON) | - | never |
| 10 | Scope ON/OFF (the radio's own scope screen) | yes | 00/01 |
| 11 | Scope wave data output to the controller | yes | 00/01 |
| 12 | Main/Sub scope (00 Main; 7610/7851 have a Sub) | yes | yes |
| 13 | Single/Dual | yes | yes |
| 14 | Mode: 00 Center, 01 Fixed, 02 Scroll-C, 03 Scroll-F | yes | yes |
| 15 | Span in Center mode, 5-byte BCD Hz (2.5k 5k 10k 25k 50k 100k 250k 500k; 7610 adds 1M) | yes | yes |
| 16 | Edge number in Fixed mode, 01-04 (705: 01-03) | yes | yes |
| 17 | Hold | yes | yes |
| 19 | Reference level, ±20 dB in 0.5 dB | yes | yes |
| 1E | Fixed edge frequencies per band range and edge number | yes | yes |

The 27 00 frame, after `FE FE E0 <radio> 27 00`:

```
byte 0   scope id        00 Main, 01 Sub
byte 1   division        BCD, 01..max  (which piece of this sweep)
byte 2   max division    BCD: 01 over LAN (whole sweep in one frame), 11 over USB
--- only when division == 1 ---
byte 3   mode            00 Center / 01 Fixed / 02 Scroll-C / 03 Scroll-F
bytes 4-8   Center mode: centre Hz (5-byte BCD, little-endian, the 03 frequency format)
            other modes: LOWER edge Hz
bytes 9-13  Center mode: HALF span Hz  (Hamlib: span = value * 2 - the radio sends ±)
            other modes: HIGHER edge Hz
byte 14  out of range     00 in range, 01 out (then no data follows)
bytes 15.. waveform data
--- division >= 2 (USB only) ---
bytes 3.. waveform data (50 points per piece)
```

Per model (Hamlib `spectrum_scope_caps`):

| Model | Points per sweep | Level range | dBm at 0 / max | Scopes |
|---|---|---|---|---|
| IC-7300, IC-7300 MK II, IC-705, IC-9700, IC-905 | 475 | 0..160 | -80 / 0 | Main |
| IC-7610, IC-7851 | 689 | 0..200 | -100 / 0 | Main + Sub |
| IC-7760 | not in Hamlib; assume the 7610 shape, VERIFY with an owner (K3FZT/W3AOK) | | | |

Over USB a sweep is 11 CI-V frames (one header-only, ten of 50 points; the last is short).
Over Icom Network (RS-BA1 UDP: IC-705, 7610, 9700, 7760, 7851; wfserver for a 7300) the
whole sweep is one CI-V frame, ~500-700 bytes; `RsBa1Transport` already reassembles and
emits CI-V bytes, `CivCodec._parseFrames` is FE FE..FD delimited, so a long frame is fine.

Firmware: the 7610 v1.10 and 7300 v1.30 had a known 27 00 format fault, fixed in later
firmware. Say so in the diagnostics when a sweep never assembles ("update the radio").

### The one thing we must get right: CI-V bandwidth over USB

A sweep over USB is ~660 bytes with framing. At 19200 baud that is ~0.34 s of bus time
per sweep, and the IC-7300 sends sweeps as fast as its scope sweeps: the bus would be
saturated and POTACAT's own frequency/mode/meter polls starved. At 115200 a sweep is
~57 ms.

- Docs today recommend 19200 for the IC-7300 (CI-V reliability). POTACAT's Icom
  transport default is 115200. Both stay as they are; the scope simply REQUIRES
  >= 57600 and says so.
- Rule: with `catTarget.type === 'icom'` and `baudRate < 57600`, the scope does not
  start. Diag (blocker): "The band scope needs a faster CI-V link. Set CI-V USB Baud
  Rate to 115200 on the radio (MENU > SET > Connectors > CI-V) and in Settings > My Rigs
  > this radio. 19200 cannot carry the scope and your controls at the same time."
- civ-tcp (ser2net etc.) and icom-network: no gate (the radio's USB-side rate is out of
  our sight; wfserver on a Pi still has one - mention in the docs).

## 2. Design

Same shape as the other three: a pure module owns the bytes, main.js owns the state
machine inside the existing `yaesuScopeState` / watchers / fan-out, every surface sees
the same `scope-frame` / `scope-state`.

### 2.1 lib/icom-scope.js (pure, tested)

- `MODELS`: the table above (points, levelMax, dbmMin, dbmMax, scopes, spans).
  `scopeModelFor(modelName)` -> entry or null. The IC-7760 entry is marked
  `unverified: true` so the log says so once.
- `parseScopeFrame(payload)`: the 27 00 payload (after cmd/sub) -> `{ id, division,
  maxDivision, mode, centerHz, spanHz, lowHz, highHz, outOfRange, data: Uint8Array }`.
  Span = header value × 2 (Hamlib's reading; a one-line change if an owner's capture says
  otherwise - that is why the capture switch ships FIRST).
- `SweepAssembler` (EventEmitter): feeds frames, keeps per-scope-id state, emits
  `'sweep'` `{ id, mode, centerHz, spanHz, lowHz, highHz, levels: Uint8Array(points),
  points, levelMax }` when `division === maxDivision`; a header with a new sweep replaces a
  half-built one; `outOfRange` emits a sweep with `empty: true`; counts `dropped`.
  Over LAN (max 1) a single frame is a whole sweep.
- `toScopeFrame(sweep, model)`: resample `points` -> 850 (linear interpolation so a
  carrier survives: 475 -> 850 is ~1.8 points per bin), scale `0..levelMax` -> `0..255`.
  Returns `{ seq, kind: 0, wf1: Uint8Array(850), aligned: true }` - the lib/yaesu-scope.js
  frame, so `yaesuScopeOnFrame` takes it unchanged.
- `axisFor(sweep)`: Center -> `{ anchor: 'center', centerHz, spanHz }`; Fixed/Scroll ->
  `{ anchor: 'fixed', centerHz: (low+high)/2, spanHz: high-low }` - KNOWN either way,
  because the radio states its edges.
- Encoders for what main writes: `scopeOnOff(on)`, `dataOutput(on)`, `setMode(code)`,
  `setSpan(hz)` (5-byte BCD of the FULL span? No: 27 15 takes the span value the radio
  shows, 2500..1000000 - Icom labels Center spans "±2.5k" but the 27 15 table is in
  "Span (kHz) 2.5 ... 500"; the frame's bytes 9-13 are what Hamlib doubles. Test both
  readings against the first capture; the encoder gets the mapping from one table).
- `parseScopeStatus(sub, payload)` for the 27 1x replies -> `{ sub, value }` in plain
  terms (on/off, mode code, span Hz, edge number).

### 2.2 lib/codecs/civ-codec.js

- In `_handleFrame`, BEFORE `_noteUnhandledFrame`: `cmd === 0x27` → sub 0x00 emits
  `'scope-data'` with the raw payload (not parsed here; the codec stays a codec), subs
  0x10-0x1E emit `'scope-status'` `{ sub, payload }`. The 27 00 frames must never count
  as unhandled (they would fill the 8-slot dedupe set and hide a real baud warning).
- Setters: `setScopeOutput(on)`, `setScopeOn(on)`, `setScopeMode(code)`,
  `setScopeSpan(bcd5)`, `readScope(sub)`; all through `_buildFrame(0x27, sub, data)`.
- `lib/rig-controller.js` re-emits `'scope-data'` and `'scope-status'` from the codec
  (it forwards `nb`, `powerMeter` etc. the same way) and exposes the setters.
  `RigController` has no `queryRaw` for CI-V (that is a Kenwood/rigctld method), so the
  Icom state poll is fire-and-listen: send the four reads, consume the status events.
- `_checkPollStaleness`: an inbound 27 00 frame IS proof the link is alive; count it
  as a reply so a scope-heavy bus never looks "DOWN".

### 2.3 main.js

- `ICOM_SCOPE_TRANSPORTS = ['icom', 'civ-tcp', 'icom-network']`.
  `icomScopeModel()` = `IcomScope.scopeModelFor(activeModelName)` when the active rig's
  catTarget is one of those (never rigctld/flrig: they do not pass 27 00 through).
- `getRigCapabilities`: `if (!caps.nativeScope && icomScopeModel()) caps.nativeScope = 'icom'`
  (after flex, before sdr; the SDR `preferSdr` rule keeps working through
  `scopeSourceKind`).
- `scopeSourceKind()`: `'icom'` between native-yaesu and flex.
- `startIcomScope()` / `stopIcomScope(why)` behind `startYaesuScope` / `stopYaesuScope`
  exactly where the flex and sdr branches hook in. State: `source: 'icom'`, `kind 0`,
  `catReads`, `spanCode null`, plus `scopeOutputWeSet` / `scopeOnWeSet` (what to put back).
  - Preflight: baud gate (2.1 above) → diag `baud`; model unknown → diag `no-rig`
    wording for Icoms ("this Icom has no scope POTACAT knows how to read").
  - Start: read 27 10, 27 11, 27 14, 27 15 (and 27 16 / 27 1E in Fixed). On the status
    replies: remember the original 10/11 values; if 11 is OFF send `27 11 01`; if 10 is
    OFF send `27 10 01` (the radio only streams while its scope is on). Log one line:
    `[Scope] IC-7300: scope output turned on (27 11); POTACAT puts it back when the scope closes`.
  - Stop: restore 10 and 11 to what they were (the FT-710 SCU-LAN10 rule: a setting
    POTACAT changes is a setting POTACAT restores), stop the poll, emit stopped.
  - Frames: `cat.on('scope-data')` → `assembler.feed(parse(payload))`; `'sweep'` →
    update `centerHz/spanHz/anchor` from `axisFor`, then `yaesuScopeOnFrame(toScopeFrame(...))`.
    Only scope id 0 (Main) for now; Sub is a follow-up (a second strip).
  - Poll: 27 14 / 27 15 every 2 s (`yaesuScopeReadRadio` pattern) so a span changed on
    the front panel re-scales the axis; `catReads` 'unanswered' after 3 silent cycles →
    diag `silent` ("the radio is not sending scope data: is its scope screen on? firmware
    1.10/1.30 had a scope-data fault").
  - Measured frame rate: a 10-sweep rolling average of arrival gaps feeds
    `scopeSourceFrameMs()` for `source === 'icom'` (the radio's sweep rate is not ours
    to set; the phone's time scale wants the truth).
- `scopeSpans()`: the model's span list → zoom works. `setScopeSpan` → `27 15`, then
  re-read; guest handling via `scopeGuestNote('Icom span')` / `scopeGuestOwnerSet('spanHz')`.
  `setScopeAnchor('center')` → `27 14 00`; guest note `'Icom scope mode'`.
  `scopeGuestRestoreOwner`: a third branch, `source: 'icom'` → write back span and mode.
- `scopeCalibration()`: for `source === 'icom'` return the model's `dbmMin/dbmMax` so the
  phone's dBm readout (built for the Flex pan) works on an Icom too.
- `yaesuScopeNoteFrequency`: in Center mode the radio recentres itself; POTACAT only
  updates `centerHz` from the frame header, never from the dial (Fixed mode must not be
  faked as centred).
- Capture switch, shipped FIRST: `POTACAT_CIV_SCOPE_CAPTURE=<file>` appends every 27 00
  frame as a hex line with a timestamp (the Flex `POTACAT_FLEX_FFT_CAPTURE` pattern). The
  first owner's file becomes `test/fixtures/icom-scope/<model>-capture.txt`.
- `yaesuScopeEnableOnRadio()` for an Icom = re-send 27 10 01 / 27 11 01 (the pop-out's
  Enable button and ECHOCAT `scope-enable-radio` already call it); guest refused as today.

### 2.4 Surfaces

- `lib/scope-axis.js`: `scopeAxis` treats `anchor === 'fixed'` as KNOWN; `anchorLabel`
  → "FIXED". (Inlined into the web page by remote-server, so ECHOCAT Web follows; the
  mobile app has its own copy → handoff.)
- `renderer/scope-popout.js` / `.html`: `source === 'icom'` hides the sweep-speed and
  SCU-LAN rows, shows an "Icom" badge beside the SDR one; the Enable button's text comes
  from `diag.action`, so an Icom reads "Turn the radio's scope output on" and an FT-710
  keeps SCU-LAN10. Zoom buttons already appear whenever `spans.length >= 2`.
- `renderer/remote.js` Scope tab + FT8 BS strip, `renderer/jtcat-popout.js` strip: same
  `needEnable` rule (`scuLan === '0'` is FT-710-only, so add `diag.key === 'output-off'`).
- `renderer/app.js`: More ▾ Band Scope already gates on `caps.nativeScope`; nothing.
- Station Setup (`lib/station-setup.js`): a `band-scope` step for `nativeScope === 'icom'`:
  ok when live; `needs` with the baud instruction when `live.scope.diagKey === 'baud'`;
  `optional` otherwise ("Open the Band Scope from the More menu").
  `stationSetupLive` fills `scope` for Icom models too (today only yaesu-ft4222).
- `lib/rig-setup-notes.js`: `icom-scope-baud` (recommended, feature 'Band scope', Icom
  scope models, radioTypes ['icom']): "For the band scope, set CI-V USB Baud Rate to
  115200 on the radio and in POTACAT." Source: this plan, until an owner confirms.
- Rig models: no new caps key; the scope list lives in lib/icom-scope.js so the models
  file stays about CAT.

### 2.5 ECHOCAT (handoff to the echocat session, potacat-app docs/desktop-handoffs/icom-band-scope.md)

Nothing new on the wire. What changes in values:
- `caps.nativeScope: 'icom'`; `scope-state.source: 'icom'`.
- `scope-state.anchor` may be `'fixed'` with a KNOWN axis (`axis.known: true`): tap-to-tune
  allowed; label FIXED, not "axis assumed". (The app's copy of scope-axis needs the rule.)
- `scope-state.spans` is the model's list (2.5 kHz .. 500 kHz / 1 MHz) → zoom buttons;
  `scope-anchor {anchor:'center'}` works; `dbmMin/dbmMax` present (dBm readout as on Flex).
- `speed` and `scuLan` null; new `diag.key` values: `baud`, `output-off`, `silent`,
  `unverified-model`.
- `frameMs` is measured (varies with the radio's sweep speed).

### 2.6 Tests

- `test/icom-scope-test.js`: parser on hand-built frames in BOTH shapes (USB 11-piece,
  LAN single) for 475 and 689 points; Center and Fixed headers; span doubling; out of
  range; a sweep abandoned mid-way and replaced; resample 475→850 keeps a one-point
  carrier; level scaling 160→255 and 200→255; axis known for both anchors; the real
  `CivCodec` + `RigController` over a fake transport receiving a synthesized sweep →
  `'scope-data'` events, 27 00 never logged as unhandled, link not declared stale;
  encoders byte-exact (27 11 01, 27 14 00, 27 15 BCD); main.js source guards: baud gate
  present, 10/11 restored in stop, `scopeSourceKind` knows 'icom', the capture env var,
  Guest restore has an icom branch, `scopeCalibration` returns the model dBm.
- `test/yaesu-scope-test.js`'s "never send EX0401xx" guard gets a sibling: main.js never
  WRITES 27 00 and never writes 27 1E (edge frequencies are the operator's).
- `scripts/run-tests.js`: add the file beside flex-scope-test.
- When a capture arrives: a fixture-driven test replaces the hand-built frames.

### 2.7 Docs (handoff DESKTOP_TO_DOCS_HANDOFF_<date>_ICOM_BAND_SCOPE.md to the potacat docs session)

There is NO band-scope page in the docs today (only one line in remote-desktop.md), so:
- New page `nested/band-scope.md` ("Band Scope"), in SUMMARY under Features: what it is
  (the radio's own spectrum in POTACAT's Band Scope window, under the FT8 waterfall, and
  on the phone's Scope tab, spots drawn on it, tap to tune, runs only while watched), then
  a section per source with its requirements:
  - FT-710 over USB: FTDI LibFT4222 (Station Setup finds it), SCU-LAN10 menu ON (POTACAT
    turns it on and back off), zoom/CENTER, click-to-tune in CENTER only.
  - FlexRadio (Flex Direct only; SmartSDR keeps its own panadapter).
  - Icom over CI-V: the model list; USB needs CI-V USB Baud Rate 115200 on the radio and in
    POTACAT (and why); Icom Network needs nothing extra; POTACAT turns scope output on and
    puts it back; zoom, Center, click-to-tune in Center AND Fixed; the Sub scope is not
    shown; firmware note. Guest Pass: a guest may zoom/centre; the owner's settings return.
  - A separate SDR (rtl_tcp/rsp_tcp) for any radio.
  - Display noise floor slider; the JTCAT strip toggle (⚙ > Display); phone Pan tab.
- `nested/rig-ic-7300.md`: a "Band scope" section + a THIRD row in the baud table ("Band
  scope: 115200 on both sides"); the same section on the 705/7610/9700 pages if they exist
  (today the 7300 page "also covers the IC-7610").
- `nested/remote-desktop.md` Band scope line: "from an FT-710, an Icom, a Flex or a
  separate SDR".
- `changelog.md` highlight line; FAQ entry "Which radios have a band scope in POTACAT?".
- `settings-reference.md`: no new setting (the capture switch is an env var, undocumented).

### 2.8 Website (handoff to the potacat website session; generator is redesign/v3/remote/_rigs.js)

- `/remote/ic-7300/`: the "Spots on the radio's scope. Not yet" paragraph in `extra`
  becomes "Yes, since 1.13.x: POTACAT reads the IC-7300's own scope over the USB cable and
  shows it in its Band Scope window and on your phone, spots drawn on it; set CI-V USB
  Baud Rate to 115200." Title/description/og gain "and band scope" like the FT-710 page;
  a "what works" row; a troubleshooting card "The band scope stays blank → baud 115200,
  scope screen on, firmware"; the comparison table's wfview row ("the radio's scope on
  your computer screen") loses its edge → reword; FAQ "Can I see the IC-7300's scope
  remotely?".
- `/remote/ic-705/`: same, Icom Network needs no baud change.
- `/remote/` hub: IC-7300 and IC-705 cards gain "its own band scope on your phone" (the
  FT-710 card has it today). The hub's FT-710 USP ("no SCU-LAN10") is untouched.
- Home page feature list / What's New: one line when released. The website's own
  `sync-download.js` run as usual.
- Pages exist for 7300 and 705 only; 7610/9700 get no page (list them on the band-scope
  doc page instead).

### 2.9 Release notes (for the release that carries it)

> **Band scope on Icoms.** The IC-7300 (both), IC-705, IC-7610, IC-9700, IC-7851 and
> IC-905 stream their spectrum scope over the CI-V link POTACAT already uses. Open More >
> Band Scope, or the Scope tab on your phone: zoom, Center, click to tune in Center and
> Fixed modes, spots drawn on it. Over USB set CI-V USB Baud Rate to 115200 on the radio
> and in Settings > My Rigs. POTACAT turns the radio's scope output on and puts it back
> when the scope closes. Verified on <model> by <callsign>.

The last sentence is written only when true.

## 3. Order of work

1. **Capture switch + codec events** (civ-codec, rig-controller, main env var; ~1 h).
   Ship nothing visible; ask an IC-7300 owner (KQ4DX, N2FSM, EA1BZN) and a 7610 owner
   (WF4I) on Discord for a 30 s capture with the scope screen on, and whether 27 11 had
   to be turned on by hand. This settles the span reading and the header layout before
   the UI exists.
2. **lib/icom-scope.js + tests** on hand-built frames (~2 h). Re-run on the capture.
3. **main.js source + surfaces + Guest restore + Station Setup + setup note** (~3 h).
   Bench: `--synth` is FT-710-shaped; add an `IcomScope.synthSweep()` and a dev flag
   `POTACAT_CIV_SCOPE_REPLAY=<capture>` that feeds a capture through the real codec path
   in a scratch instance, so the whole chain is seen on screen with no radio.
4. **Handoffs**: mobile (2.5), docs (2.7), website (2.8); memory + STATE.
5. **Live check** with an owner on the release build; then the "Verified on" sentence.

## 4. Open questions

- Does Casey have an Icom in the shack? If not, step 1's capture is the gate for 2-3.
- Span field: ×2 (Hamlib) vs ×1 (manual's "Span (kHz) 2.5" wording). Capture decides.
- IC-7760: 475 or 689 points? dBm range? K3FZT/W3AOK can capture.
- Does the radio stream 27 00 while its own scope SCREEN is closed (27 10 = ON but the
  operator has the meter screen up)? Hamlib turns 27 10 on; we do the same and watch.
- Icom Network with wfserver: does wfserver forward 27 00 frames whole or re-split them?
- CI-V Transceive OFF (the docs' recommendation) does not affect 27 00 output (it is
  addressed to the controller, not broadcast) - confirm on the first capture.
