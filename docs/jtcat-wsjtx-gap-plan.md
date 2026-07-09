# JTCAT ↔ WSJT-X Gap Plan

Source: full review 2026-07-07 (four-track: codebase deep-dive, WSJT-X 2.7.0 user-guide
inventory, nonstandard-callsign protocol brief, satellite/EME usage brief). This doc is
the durable backlog; the protocol reference sections at the bottom exist so future
sessions don't have to re-research.

## Priority order (Casey, 2026-07-07)

1. **Nonstandard-call TX encode fix** — **BUILT 2026-07-07.** Native: pack28
   bracketed-hash support, encode_std one-hash rule (ack legs → type 4),
   encode_nonstd bracket-strip + len_call_de fix, live hash_if in the addon
   encode. JS: JtcatParser.isStandardCall/formatDirectedMsg feeding every TX
   builder, bracket-tolerant state-machine matching + bare two-call CQ branch,
   AP2 gated for nonstd DX. Tests: scripts/test-nonstd-roundtrip.js (19) +
   state-machine groups 4e (nonstd ladders). Caveat: native-encoder-only (ft8js
   WASM fallback can't pack brackets). Needs on-air validation.
2. **Skip-grid reply toggle** — **BUILT 2026-07-07.** `jtcatSkipTx1` + popout
   "Skip Grid" toggle; both reply handlers send the report opener with
   sentReport pre-set; state machine preserves the transmitted report at the
   R-branch. Group 4f tests. Ignored in FD/Hound.
3. **Manual/free-text TX message field** — **BUILT 2026-07-07.** Click the TX
   message → inline editor; `jtcat-validate-tx-msg` IPC validates via the real
   native encode; display writes guarded while editing. Does not arm TX.
4. **Dupe warning on manual reply** — **BUILT 2026-07-07.** Band/mode-aware
   orange toast (`jtcat-dupe-warning` → showJtcatWarnToast); auto paths still
   skip silently. Popout-owner only; phone UX is a follow-up.
5. **Hound mode** — **BUILT 2026-07-07** (old-style F/H, hound side). Type-0.1
   dual-message codec added to message.c (encode+decode, h10 fox hash, r5
   report −30..+32 in 2 dB steps); state machine: segment-wise dual parsing,
   QSY-to-fox on R+rpt leg, RR73 closes with no 73; handlers: ≥1000 Hz initial
   call, base-call rebasing, q.hound on both owners; popout "Hound" toggle
   (`jtcatHoundMode`). Group 4g tests. **Needs on-air validation against a real
   fox.** **SuperFox = BLOCKED**: hound TX is plain FT8 but decoding the fox
   needs the sfox waveform decoder (constant-envelope 1512 Hz, polar-coded —
   NOT in ft8_lib); OTP verification is moot until that exists. Revisit if/when
   an open sfox implementation appears.
6. **WSJT-X UDP server protocol** — speak Status/Decode/Reply/Highlight/Logged-ADIF
   so GridTracker/JTAlert can attach to JTCAT. (We already emit N1MM/HAMRS-style UDP.)
7. **Transverter offsets + decode-during-TX (full duplex)** — the entire QO-100
   satellite story. Also: a "don't fight external CAT" mode for LEO-FT4-behind-
   SatPC32/GPredict. Document IO-117 (packet) and ARISS (APRS/SSTV/FM) as non-goals.
8. **Worked-before decode badges — REDESIGN (Casey 2026-07-07)**: today we badge
   `[C]` new call, `[G]` new grid, `[D]` new DXCC (computed against
   rosterWorkedDxcc/Calls/Grids in main.js). Full re-think required:
   - Keep `[c][g][d]` semantics as notes for *needed* (never-worked) entities.
   - Add **`[b]` = worked this call before but never on this band** and
     **`[m]` = worked this call before but never in this mode** (FT8/FT4/FT2 counted
     as distinct modes).
   - Requires the worked-roster to track per-call band sets and mode sets, not just
     membership. Compare WSJT-X's "±on Band" highlight dimension + Highlight-by-Mode
     option; ours should stay badge-based (POTACAT style), not color-scheme-based.
   Follow-ups in the same family: decode-depth control (Fast/Normal/Deep),
   .wav save/replay for debugging, LoTW-user flagging.

## Full gap list (WSJT-X has it, JTCAT doesn't)

### A. Message control & manual operation
- Tx1–Tx6 editable fields, Next (next slot) vs Now (mid-transmission switch — safe in
  first 10–20% of a slot) selection
- Free text (13 chars) + Tx Macros store + `$DXCALL` substitution
- Skip-Tx1 toggle (→ priority 2)
- Tx4 RRR↔RR73 toggle (we always send RR73; WSJT-X FT4 also locks RR73)
- Generate Std Msgs / F4 clear / Ctrl+L lookup-and-generate
- Message Creator + QSY Monitor + reply popups (2.7 "Message System")
- Keyboard shortcuts: Alt+1–6 send-now, Ctrl+1–6 select-next, Alt+H halt, Alt+Q log,
  F11/F12 RX ±1 Hz, Shift+F11/F12 TX ±60 Hz (FT8) / 90 Hz (FT4), alternate F1–F6
  contest bindings. JTCAT has only zoom keys.
- Waterfall Ctrl-click (both freqs), double-click-to-decode-here, Tx←Rx/Rx←Tx buttons

### B. Auto-sequencing refinements
- Auto Seq desktop toggle (ours exists, phone-only — no popout control)
- "CQ: None / First / Max Dist" answer policy (ours: strongest SNR, fixed)
- Per-transmission Tx watchdog with visible countdown (we have retry ceilings + the
  30-min Full-Auto watchdog only)
- "Disable Tx after sending 73" option; Esc = halt + abort + clear queue
- "Double-click on call sets Tx enable"; "calling CQ forces Call 1st"

### C. Special operating activities (we have ARRL FD only)
- Fox/Hound DXpedition mode, both sides (→ hound side is priority 5)
- SuperFox/Super Hound + NCDXF OTP verification (2.7)
- NA VHF / ARRL Digi contest (grid exchange, /R rover, Active Stations score window)
- EU VHF contest (serial + 6-char grid, i3=2/5 hashed both-calls)
- FT Roundup / RTTY RU (RST+state/serial; "convert mode to RTTY" logging)
- WW Digi contest
- "CQ with individual contest name" (`CQ PACC`)
- Cabrillo export + Contest Log window (our FD logs ADIF contest fields only)
- Q65 Pileup mode

### D. Nonstandard / special-event callsigns (→ priority 1)
- Type-4 (i3=4) TX + hashed `<CALL>` message generation
- `<...>` unresolved-hash rendering; hash-table seeding from typed DX call
- /R and /P flag-bit decode display (i3=1 r1 / i3=2 p1)
- 3DA0→3D0 and 3X→Q basecall quirks (in ft8_lib, untested by us)
- Both-nonstandard-calls warning

### E. Decode & UI
- Priority-ordered user-colorable highlighting incl. worked-before **by band/mode**
  from the log (→ priority 8 badge redesign), New Continent/CQ-Zone/ITU-Zone
- LoTW-user flagging (ARRL CSV fetch + freshness window)
- Decode depth (Fast/Normal/Deep; FT8 Deep = 3 passes)
- AP transparency: a1–a7 suffixes, `?` low-confidence marks excluded from PSKReporter
  (we badge `AP` only and don't exclude `?` decodes — we don't mark them at all)
- Mode character + confidence codes on decode lines
- Erase/Clear-Avg semantics, per-pane context menus
- Wide Graph tooling: bins/pixel, palettes, Flatten, reference spectrum, spectra modes
- Working Frequencies table (multi-per-band, preferred, dated contest entries);
  FreqCal mode + calibration solver
- Active Stations window; SWL mode; Save/open .wav + decode-again on recordings
- AutoGrid (live locator; pairs with PSKReporter mid-session locator updates)
- WSJT-X UDP *server* protocol (→ priority 6)

### F. Rig/TX control
- Split "Fake It" (VFO shifted per T/R so TX audio stays 1500–2000 Hz)
- Test CAT / Test PTT pre-flight buttons
- Per-band remembered power, separate Tune power
- TX delay; x2/x4 tone spacing (LF/MF); CW ID after 73
- Transverter offsets (→ priority 7)
- "Allow Tx frequency changes while transmitting" (EME hook)

### G. Modes (we have FT8, FT4, FT2*, WSPR+hopping; *FT2 is ours alone)
- MSK144 meteor scatter (streaming real-time decode, Sh hashed shorts, 15 s) —
  only mode worth considering, and only if VHF contesters ask
- Q65 (EME/scatter; submodes A–E × 15–300 s; averaging; always-on AP)
- JT65/JT9/JT4 legacy (incl. EME OOO/shorthand dialect)
- FST4/FST4W (LF/MF to −44 dB)
- Echo mode + Astro window + five EME Doppler CAT modes (EME-only — skip)
- Message averaging; full-duplex decode-during-TX (fork-only upstream; QO-100 needs it)

### H. Logging
- Editable pre-log confirmation dialog option (we auto-log + toast-to-edit)
- QSO start time captured at first Tx2/Tx3 (we stamp at completion)
- Op Call multi-op field; dB-reports-to-comments option

## What we have that WSJT-X doesn't (keep — don't "fix" toward parity)
Integrated rig control; FT2; late-start TX; compressed-reply receive; auto-CQ responder
with dupe-skip; Full Auto CQ (ULTRACAT); quiet-freq CQ auto-placement; chase-target
directed CQs + highlighting; NTP monitor + one-click resync; adaptive latency
calibration; multi-slice; ECHOCAT mobile; POTA-aware logging; integrated map/PSKReporter
views; log-at-reports-exchanged.

## Protocol reference (so we never re-research)

### Skip-Tx1 (WSJT-X mechanics)
No settings checkbox: double-click the Tx1 radio button (Next column) or Tx 1 button
(Now column) to toggle. Not default in any mode incl. FT4. A labeled "Skip Tx1"
checkbox is JTDX/MSHV, not WSJT-X.

### Nonstandard callsigns (77-bit)
- Standard c28 call = right-aligned 6 chars, digit forced to position 3:
  `[sp/0-9/A-Z][0-9/A-Z][0-9][A-Z/sp][A-Z/sp][A-Z/sp]`. **1x1/2x1 special-event calls
  (W1A, K2A–K2M) are fully standard** — no special handling. Slash calls and
  displaced-digit calls (GB13COL, TM13COL, YW18FIFA) are nonstandard.
- Type 4 (i3=4) = h12 + c58 + h1 + r2 + c1: full nonstandard call ≤11 chars base-38,
  other call as 12-bit hash. **No room for a grid** — nonstandard CQs have no locator.
- Hash: pack call base-38 into n58; `n22 = (47055833459 × n58) >> 42`;
  h12 = n22 >> 10; h10 = n22 >> 12. One table keyed by n22 serves all widths.
  WSJT-X's table is RAM-only, rebuilt each start; seeds from every decode AND the
  typed DX-call box.
- Rules: max one nonstandard call per message; brackets mark the hashed call; **if the
  message carries a grid or report, brackets must enclose the nonstandard call**;
  render `< . . . >` until the full call has been copied once; two nonstandard calls
  cannot work each other (except /P //R VHF cases); log the true call, never brackets.
- Model QSO (hunter W9XYZ standard, DX PJ4/K1ABC nonstandard):
  `CQ PJ4/K1ABC` (t4) → `<PJ4/K1ABC> W9XYZ` (t1, no grid) → `W9XYZ <PJ4/K1ABC> +03`
  (t1) → `<PJ4/K1ABC> W9XYZ R-08` → `<W9XYZ> PJ4/K1ABC RRR` (t4) →
  `PJ4/K1ABC <W9XYZ> 73` (t4 from hunter: DX full call in c58, own call hashed).
- /R rides i3=1 r1 bits (NA VHF), /P rides i3=2 p1 bits (EU VHF); ordinary HF treats
  suffixed calls as nonstandard.
- Interop quirks: 3DA0XYZ packs as 3D0XYZ; 3X… packs with leading Q.
- ft8_lib returns `FTX_MESSAGE_RC_ERROR_CALLSIGN2` from the type-1 packer when a call
  needs type 4 — honor it.
- AP note: AP masks hypothesize standard-call c28 bit ranges; gate AP2 ("both") off
  when the DX call is nonstandard.

### Fox/Hound rules (old-style)
Off the FT8 subbands (e.g. 14.090). Fox TX 300–900 Hz, ≤5 streams 60 Hz apart, must
CQ single-stream ≥ every 5 min; QSO capped 3 min; calls a hound ≤3× awaiting R+rpt,
sends RR73 ≤3×. Hounds: initial calls 1000–4000 Hz (Fox ignores <1000); decode-above-
1000-only unless Rx All Freqs; hounds call the Fox's **base call**; when Fox answers,
hound's TX **auto-moves** to Fox's frequency (nominally 300–540 Hz, ±300 Hz shifts on
repeats) to send R+rpt — this auto-TX fires even with Enable Tx off; Enable Tx must be
re-pressed ≥ every 2 min (attended rule). Fox dual message (type 0.1, h10 fox-call
hash): `K1ABC RR73; W9XYZ <KH1/KH7Z> -17`. Compound hounds send `DE W2/G4XYZ` legs.

### SuperFox (2.7)
Fox = single constant-envelope 1512 Hz waveform (lowest tone 750 Hz), ≤9 hounds/slot
(≤4 reports + RR73s), ~+10 dB vs 5-slot Fox. Hounds TX ordinary FT8 anywhere
200–3000 Hz — no ≥1000 Hz rule, no forced QSY. SF decodes in even 15 s slots, normal
FT8 in odd. Hound must decode the SF waveform before calling (needs the sfox decoder,
which ft8_lib does NOT have). OTP verification against https://www.9dx.cc (keys from
NCDXF; also usable for old-style Fox). Logged as mode FT8.

### Satellites (bottom line)
FT8 belongs on QO-100 only (GEO, ~0 Doppler; 10489.540 down / 2400.040 up, ≤500 Hz
digimode rule; the real enemy is LNB drift → GPSDO or beacon-referenced correction).
LEO linear transponders = FT4 behind an external full-Doppler CAT engine
(SatPC32 "SSB/CW Interval 0" ≈ 200 ms updates; GPredict; CSN S.A.T) — FT8 does not
survive LEO Doppler rate; don't try. WSJT-X has zero satellite awareness (its Doppler
machinery is Earth–Moon only). Client needs: transverter offsets, decode-during-TX,
external-CAT-friendly mode. Non-goals: IO-117/GreenCube (1200 bps packet),
ARISS (APRS/SSTV/FM voice).
