# Next fixes after 1.13.9 — plan (2026-11-01)

Sources: Discord #bug-reports and #feature-requests to 2026-11-01 19:00 UTC
(discord agent's status read), open GitHub issues 108/109/111/115, and what
the downloaded logs showed. Every cause below was read in the code; where a
cause is a guess it says so and names the evidence that would settle it.

Order: wrong logs first, then transmit and radio control, then JTCAT band
handling, then crashes, then UI, then features. Each item = one commit with
a test, the same way as 11/1.

## Series 1 — logs that are wrong

### 1.1 Compressed-reply QSO is logged before they confirm
- Reporter: found in droidbot2's log while checking Halt TX.
- Where: `lib/jtcat-state-machine.js` CQ ladder, "Compressed-reply variant":
  on `<MyCall> <Their> <±NN>` it sets `phase = 'cq-rr73'` and calls
  `onDone()` at once, i.e. logs when WE send R+report, before their RR73.
  The normal ladder logs at the same phase only after THEIR R-report.
- Fix: stay in a new phase (`cq-r-report`) after sending R+report; log on
  their RR73/73 (or on the courtesy close-out after N tries, as
  `closeoutStalledQso` already does for the reply side). `replaceLogsQso`
  (1565f05a) keeps working because it keys on `cq-rr73`.
- Test: jtcat-test "compressed reply": not logged at R+report; logged on
  RR73; logged by close-out when they vanish after exchanging reports.

### 1.2 DX entity logged wrong on QRZ (level_death)
- Where: `lib/qso-expand.js` fills `country` from QRZ when the entry has
  none; JTCAT auto-log sets no country, so QRZ's answer for the full call
  wins. For a slash call (6W/IK2HKT) QRZ answers the HOME station's
  country (Italy), and for a special call it can answer the licensee's.
  cty.dat's `resolveCallsign` is never consulted for the logged country.
  (Guess until confirmed: level_death's log + the QRZ reply would settle it.)
- Fix: `logContact` resolves `country`/`dxcc` from cty.dat (prefix of the
  OPERATING call, slash-aware) before QRZ; QRZ fills name/state/grid only.
  Same rule for the spot-click log forms. Export COUNTRY exactly as the
  logger expects (N3FJP already gets "USA", 2db52208).
- Test: qso-expand-test: 6W/IK2HKT -> Senegal, VP2V/GU4YOX -> British
  Virgin Islands, K3SBP -> United States of America; QRZ never overrides.

### 1.3 "G" (new grid) badge stays after the QSO is logged (level_death)
- Where: `main.js` stamps `r.newGrid` per DECODE from `rosterWorkedGrids`;
  the live-add sites update the set (13378/13809), but rows already drawn
  in the window keep their badge, and the window never re-evaluates them.
  Same for `newCall`.
- Fix: on `qso-logged`, push `jtcat-worked-update {call, grid}` to the
  window and ECHOCAT; the row model clears G/C for that call/grid.
- Test: popout row-model unit (the window's render helpers are already
  source-tested in decode-row/layout tests) + a main wiring guard.

## Series 2 — transmit and radio control that silently fail

### 2.1 G90 + Digirig: locks into TX on connect, 0 W on FT8 (bankonthat)
- Evidence so far: Discord text only; his message.txt is attached to the
  thread (needs Casey's download approval in the discord agent's session).
- Likely cause, from the code: `spawnRigctld` passes `--ptt-type=RTS
  --ptt-file=<port>` only when a PTT port is configured; otherwise Hamlib
  opens the CAT port with the lines "Unset" and Windows raises RTS on open.
  A Digirig keys PTT on RTS of that same port, so the radio keys at connect
  and nothing ever lowers it ("ATU sequence unlocks it" = the G90 drops TX
  itself after a tune). 0 W on FT8 = audio not reaching the Digirig
  (device pick or TX gain); the log's `[JTCAT TX] Output device:` line says.
- Fix: for a rigctld rig whose PTT line is NOT one of the serial lines,
  pass `--set-conf=rts_state=OFF,dtr_state=OFF` (same as `dtrOff`), and say
  so in the log; the Ten-Tec exception (HAMLIB_LINES_POWER_RIG) stays. When
  the PTT port IS the CAT port, Hamlib drives the line and we leave it.
- Test: rigctld spawn-args test (exists for Ten-Tec) gains the Digirig case.

### 2.2 Bundled Hamlib crashes during G90 FT8 TX (GitHub #109)
- Evidence: edenundo's report with `*** stack smashing detected ***`;
  Hamlib 4.7.2 fixed a read_string overflow (GHSA-f72v-7gmh-m9mj).
- Two parts:
  a) Model quirk now: `G90.pollDuringTx = false` (the flag exists; the
     TS-480 uses it). The G90 answers no CAT in TX, so every poll is a
     timeout that feeds the crash. Zero risk, ships in the next release.
  b) Hamlib 4.7.1 -> 4.7.2 on all five runners (assets/hamlib on Windows
     from the official zip; macOS/Linux build it). Separate PR, needs a
     release build to verify. The rigctld-shim and rigctld tests cover
     the Windows binary.
- Also from his comment: "cannot get POTACAT to sync on power ... mode,
  preamp, AGC" on the G90 = Hamlib's G90 backend reports little; note on
  the rig page, not a POTACAT fix.

### 2.3 External RF-sense tuner: power not restored (GitHub #111, df1vb)
- Where: `runExternalAtuTune` restores `restorePower` in its `finally`
  right after RX with no readback, and `restorePower` falls back to
  `settings.defaultPower` when `_currentTxPower` is 0 (no readback rig).
  Which radio he has is unknown (ask). A radio that ignores a PC command
  in its TX tail, or answers the pre-tune power late, keeps the low value.
- Fix: the Station Setup TX-test pattern: remember the pre-tune power
  (`setupTxPowerRestore` style), restore after a short settle, confirm by
  readback, retry twice, then `stationSetupReconcilePower` repairs it on the
  next power readback. Log one line either way.
- Test: external-atu test with a fake rig that ignores the first PC.

### 2.4 TS-890S S-meter query (found 11/1)
- Where: `rig-models.js` TS-890S `smQuery: 'SM0;'`; Kenwood's guide (p. 61)
  shows `SM;` with no P1 and a 0000-0070 answer. The TS-590 note says `SM;`
  is an error THERE, which is why the 890 inherited `SM0;`.
- Fix: `smQuery: 'SM;'` for the TS-890S, parse 4 digits. Mark as
  unverified on a radio; ask the first TS-890 owner (jgedmond has one).

### 2.5 IC-7100 Wideband FM VFO preset saves as FM (kg6odijohn)
- Where: `civ-codec.js` parses 0x06 as `WFM` (readback), but the
  mode->command table has no WFM entry, and the VFO profile sanitizer /
  mode select only know the standard mode list, so WFM is folded to FM.
- Fix: WFM as a first-class mode on Icoms that have it (7100, 705, 9700):
  codec set entry, profile sanitizer, VFO window mode list (shown only
  when caps say so), spot-filter mapping (WFM -> FM for spots).
- Test: rig-test "IC-7100 WFM round-trip"; vfo-profiles sanitizer keeps WFM.

### 2.6 FTX-1 NOAA on/off (hoogskev's log, after 1.13.9)
- 1.13.9's general-coverage fix removes the refusal. His log of it working
  then failing 20 min later is attached to the thread (needs approval); read
  it before 1.13.10 to confirm no second cause (SDR auto/idle hand-off).

## Series 3 — JTCAT band handling

### 3.1 JTCAT band does not follow the radio (GitHub #115, ianturo)
- Where: the window's band buttons (`.jp-band-opt`) change only on a click,
  idle-QSY, or open; `onCatFrequency` only updates the MHz text. Main's
  `_jtcatExpectedDialHz` is anchored by the window's choice, so after the
  operator turns the dial the guard refuses TX ("wrong band") while decodes
  keep flowing.
- Design: the guard exists for a SPOT click moving the radio under a
  running FT8 session (KF0U). A dial change that lands within +-2 kHz of a
  digital dial for the current mode (14074, 7074, 28074 ...) is unambiguous
  and re-anchors the guard; the window's band button follows. Any other
  dial keeps the guard, and the refusal names both bands and offers
  "Follow the radio" (one click re-anchors).
- Test: jtcat guard test: dial to 28074 re-anchors; dial to 14250 refuses
  with the button; spot click still refused.

### 3.2 "Switching to 20m..." never ends; decodes stop (bobve)
- Where: a band click calls `tune()` and shows "Switching..." until the
  next decode batch. Decodes stopping after the tune is the real fault and
  the code gives no cause; likely the mode set (USB -> DATA) restarting the
  engine family or audio capture, which 3.1's work touches.
- Needs: his Report a Bug after one failed switch (ask in the thread).
  Build 3.1 first, re-test the sequence in a scratch instance with a
  dummy rigctld (the rigctld-power-scale test shows how).

## Series 4 — crashes and stuck features

### 4.1 Winlink packet Send/Receive crashes POTACAT (artificialjump)
- Evidence: two photos in the thread (IMG_0886/0887.jpg), not downloaded.
  A crash dialog = a synchronous throw in an IPC handler (the FT-710 scope
  lesson). `winlink-cmd-connect` for packet spawns Dire Wolf + Pat; a
  missing helper, a bad KISS port or a settings field it did not expect
  would throw there.
- Fix: wrap the packet connect path so any throw becomes a session error
  shown in the window, not a crash; then the specific cause from his
  photo. Ask for his Report a Bug (the previous run's log is in it).
- Test: winlink-main-wiring: a throwing helper spawn yields session.error.

### 4.2 Voice macros: recording cuts off, no audio, button dead (ride1226)
- Where: `startVoiceRecording` uses MediaRecorder with no timeslice and a
  30 s stop timer. The "5-10 s cut-off" and "no audio" fit the saved
  mic device (`pota-cat-voice-macro-input-device`) being the rig's codec or
  a device that goes away; "button does nothing" fits an awaiting
  getUserMedia with no feedback (and `if (voiceRecorder) stop()` racing).
  His message.txt is attached (needs approval).
- Fix: feedback while getUserMedia is pending; `start(250)` timeslice so a
  cut-off still saves what was captured; a level meter during recording so
  silence is visible; a clear "Mic error: <reason>" naming the device.
- Test: renderer unit for the recorder state machine (fake MediaRecorder).

### 4.3 ECHOCAT and remote POTACAT fight for control (thedadnerd)
- Fixed in 1.13.8 (a36f28d3: a kicked RemoteClient yields). His report is
  from 10/30 00:49, before 1.13.8. Reply: update both PCs; no code.

### 4.4 GridTracker map blanks and recentres (_hawk71_) + roster lag when
    POTACAT calls first (jgedmond)
- Where: `lib/wsjtx.js encodeStatus` (type 1). GT2 recentres on a Status
  whose de_grid / dial changes; the roster keeps a QSO at the top from the
  Status's dxCall/dxGrid. When POTACAT initiates, `dxCall` comes from the
  TX message, which may be empty between periods.
- Fix: send Status with a stable de_grid and dial; hold dxCall/dxGrid for
  the whole QSO (from `popoutJtcatQso`), clear only on done. Compare with
  WSJT-X's field values on a real capture (jgedmond offered two rigs).
- Test: wsjtx-test: Status fields across a POTACAT-initiated QSO.

### 4.5 MSHV multi-stream decodes (level_death)
- Investigation only: our decoder runs one pass per candidate; MSHV
  multi-stream puts several signals within one FT8 bandwidth. Try a
  second pass after subtracting decoded signals (WSJT-X "subtract") on a
  recorded sample; this is weeks, not days. Ask for a WAV capture.

## Series 5 — UI (hoogskev, wayne)

### 5.1 HF Net Add/Remove overflow
- Where: Settings > Spots > Net Reminders; the row builder and the editor
  share a flex row whose remove button has no `flex-shrink: 0`.
  Screenshots attached (needs approval) but the CSS fix is visible: give
  the row `min-width:0`, the name `text-overflow`, the button `flex:none`.
- Test: layout-alignment fixture for a long net name.

### 5.2 Hunter-table logger does not follow the frequency
- The quick log under the hunter table (Activator mode, Hunt split) keeps
  the frequency it opened with; `quickLogFollowRadio` exists for the WEB
  quick log only. Mirror it on the desktop: follow the dial unless the
  operator typed in the field.
- Test: app.js source guard + a decode-row-style render check.

### 5.3 VFO window "Type a frequency" accepts no paste
- Where: `renderer/vfo-popout.html` keydown handler builds the number from
  key presses; `paste`/`input` events are ignored.
- Fix: accept paste and typed text (strip spaces, dots, "MHz"/"kHz"),
  same parser as the main window's Band/Calls box.
- Test: vfo-popout source guard + parser unit.

### 5.4 Screen goes blank, then WWFF, then POTA (wayne)
- Where: `renderSpots` rebuilds the whole table (`tbody.innerHTML = ''`)
  on every push, and the merged list is pushed per SOURCE refresh. If the
  POTA fetch fails or is rate-limited (`[Tiles] rate-limited` style), the
  push carries only the other sources for a few seconds.
- Fix: keep the last good POTA list through a failed fetch (as the parks
  DB now keeps its cache), and render by diff (keyed rows) instead of a
  full rebuild. Ask wayne for Report a Bug (Settings > left sidebar) to see
  the fetch errors.
- Test: spot-merge unit: a failed POTA fetch does not empty the list.

## Series 6 — features (after the bugs)

### 6.1 DXpedition frequencies in JTCAT (level_death)
- The feed has no frequencies today. DX-World/NG3K text often carries
  "FT8 on 14.090", and Club Log's expedition pages list them. Add
  `freqs: [{mode, khz}]` to the Worker (parse + manual overrides), then
  in JTCAT: a DXpedition row in the band menu / spot list that tunes to
  the published FT8/FT4 dial with the right slot (hound) settings.
- Two parts: Worker (deploy needs Casey), desktop + ECHOCAT handoff.

### 6.2 Region prefix overlay on the map (artemisstiles)
- `assets/geo/countries.json` carries `dxcc` names per polygon; cty.dat
  gives each entity's main prefix. A label layer (prefix at the polygon
  centroid, zoom-gated) on the Spots map, the JTCAT map and ECHOCAT Web,
  as one `lib/` module like worked-overlay. Toggle in the map legend.

### 6.3 Separate FT8 / FT4 / FT2 spot checkboxes (jgedmond)
- `renderer/index.html` mode filter has one `FT` entry ("FT8/4/2"); split
  it into three, keep `FT` as the stored value for old settings, and map
  the spot's mode. ECHOCAT Web has the same filter (`remote.js`).

### 6.4 Callsign and QRZ in the map popup (kilrath8954)
- The popup already shows the callsign as a QRZ link (`popup-qrz`); his
  report says it shows only operator and grid. Check the JTCAT map popup
  (`worked-overlay`/decode pins), which may be the one he means; add the
  same header there.

### 6.5 Worked band/mode grid in the Log QSO window (GitHub #108, AE5JE)
- `workedQsos` (main) holds `{band, mode}` per call; expose a
  `worked-matrix-for-call` IPC and draw the small grid in the Log QSO
  dialog, the log pop-out and the web quick log.

## Not code: replies owed on Discord after 1.13.9

The discord agent lists 27 unanswered user threads. The ones 1.13.9 fixes
(droidbot2 Halt, artificialjump's Technician, jholler mode flip, lloyd
FT8 stop, frank9425 FTX-1 CW, stein COM port, og3e parks, hoogskev NOAA,
w0tlp FT-710 filters via #114, level_death/jgedmond false log, the two
"fixed in next" promises) get a reply naming the release. og3e: ask for a
screenshot. bobve, artificialjump (Winlink), wayne: ask for Report a Bug.
thedadnerd: update to 1.13.8.

## Evidence still needed (Casey's approval in the discord agent's session)

- bankonthat message.txt (G90), ride1226 message.txt (voice macros),
  hoogskev's two FTX-1 logs and the three UI screenshots, artificialjump's
  two crash photos, level_death's log for the DXE case.
