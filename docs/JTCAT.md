# JTCAT — FT8 / FT4 / FT2 / JTTY / PSK31 in POTACAT

Read before touching lib/ft8-engine.js, lib/jtcat-*.js, lib/jtty*, lib/psk-engine.js,
lib/ft8_native, renderer/jtcat-popout.* or the ECHOCAT jtcat-* messages.

## Shape
- One engine contract (Ft8Engine): `startSlice({mode})`, decode events, `requestTx()`, `tx-start`.
  PSK31 (lib/psk-engine.js) and JTTY (lib/jtty-engine.js) are contract siblings hosted by
  jtcat-manager. `Ft8Engine.setMode` coerces unknown modes to FT8, so a family switch (FT, PSK, JTTY)
  REBUILDS the slice in both jtcat-set-mode handlers. `familyOf` decides the family.
- The FT8/FT4 decoder is native (lib/ft8_native) with a WASM fallback (`POTACAT_NO_NATIVE_FT8=1`).
  The JTTY receiver runs in a worker (lib/jtty/decoder-worker.js).
- Every decode carries `slot`, stamped per decode job at post time, never from the current slot at
  arrival. Consumers fall back to `ft8Engine._lastRxSlot`, never to a literal parity.
- Whole-dB SNR everywhere: `wholeDb()` in lib/ft8-worker.js plus the row formatters.
- QSO flow is lib/jtcat-state-machine.js (pure). Logging is `jtcatAutoLog` then `logContact`; the
  phone's jtcat-log-qso uses the same path. TIME_ON/OFF from lib/jtcat-qso-clock.js.
- The Stations view (#557) is lib/jtcat-stations.js (one entry per call, folded from the decodes) drawn by
  DecodeRow.stationRowInner. A row double-click is onDecodeRowClick on that station's latest decode. A
  state shows only when QRZ knows it, never from a grid. Band, mode, Clear and Stop empty it.
  Part 2: the Need marks (D new country, state code, G new grid, C new call) are JtcatStations.marksOf:
  countries and states from the worked roster under the map overlay's scope (workedOverlayScope, F8),
  so list and map agree; grid and call are the decode's newGrid / newCall. Worked / confirmed colour the
  Country and State cells (--accent-blue / --accent-green). Wanted keeps stations with a needed mark.
  The Park column is d.spotRef (main's jtcatSpotRefEnrichDecode: the spot list Hunt reads, same call,
  same band) or a reference written in a CQ ("CQ POTA US-1234").
- The pop-out to shack bridge is lib/remote-bridge.js (a row per channel; the test fails otherwise).

## Operating rules that are settings (names only; semantics in each module's header)
Per profile: jtcatMaxQsoAttempts, jtcatCallingTimeMin, jtcatReworkDays, jtcatHuntSpotted, jtcatNferParks, jtcatLogPrompt,
jtcatRelogCooldownMin, jtcatRunPauseAfter, jtcatModeHop*, jtcatFdMode/jtcatFdExch, jtcatHoundMode,
jtcatSkipTx1, jtcatApDecode, jtcatLateStartTx, jttyMacroStyle, jttyMacros, pskMacros.
Machine-wide (GLOBAL_KEY): ultracat, jtcatRxGain, jtcatTxGain (desktop-authoritative, one writer
`applyJtcatTxGain`), jtcatWaterfallSpeed, jtcatWaterfallFloor, jtcatShowBandScope, jtcatShowWaterfall, jtcatStationsExpiryMin.
Rule: a setting that is operating policy is per profile; a setting about this machine or its display is GLOBAL.

## When a QSO is logged (#807, Casey 2026-11-20)
A QSO is logged when WE start transmitting a 73-family message (RR73, RRR or 73) to that station,
or when THEIR RR73, RRR or 73 for the QSO is received, whichever comes first, once. Not a setting.
A QSO that breaks before any 73 is not logged. The tx-start dispatch asks `txLogsQso`
(lib/jtcat-state-machine.js) in `jtcatNoteTxSent`; receipt logs in `advanceJtcatQso`. Every path
(window, ECHOCAT, Hunt, Auto CQ, Run, spot target, a click on a decode, Skip) reaches one of
those two points; none logs on its own. "Open the Log QSO window before saving" (jtcatLogPrompt)
opens at that same moment. The operator's Log button (ECHOCAT jtcat-log-qso) is a manual log.
WSJT-X raises its Log QSO prompt when it sends a message containing 73 (User Guide 2.7.0,
11.2 Button Row, "Log QSO"; 4.5 Reporting, "Prompt me to log QSO").

Departures from WSJT-X (do not "fix"):
1. POTACAT logs when our RR73 / 73 STARTS going out, not after it, so a missed courtesy cycle does
   not lose the log; and it also logs on receiving their RR73 / RRR / 73. (Until #807 it logged
   at "reports exchanged": the CQ side on their R+report, before our RR73 went out.)
2. A hard per-phase TX cap (`jtcatMaxQsoAttempts`, a try = a transmission). WSJT-X has only its Tx
   watchdog. At the cap with reports exchanged both ways and no RR73 from them, the QSO ends
   unlogged and no 73 is sent, the same as every other abort; the window (and ECHOCAT through
   `jtcat-qso-state` `phase: 'error'`, `send73: true`) shows "Not logged: W1ABC never sent RR73.
   Press Send 73 to log it." Send 73 (or Skip) sends the 73, which logs it. In Run the QSO is
   dropped and CQ resumes. (Until #807 the cap logged and sent a 73 by itself.)
   The Tx watchdog exists too: `jtcatCallingTimeMin` (#161, lib/jtcat-calling-time.js), minutes of
   FT8/FT4/FT2 transmitting with no QSO progress and no operator action before TX stops, default 6
   (WSJT-X's figure), 1-30. The ceiling is the 30-minute attended limit on Run and Hunt, which stays.
3. Field Day, CQ side: the ARRL FD sequence ends on their RR73 and we send no 73; it still logs at
   our R+exchange. The S&P side follows the rule (logs when our RR73 goes out).

## Hard rules
- JTTY dials: 20 m 14090, 40 m 7090. Never 14080 (that is FT4). JTTY refuses more than 80 chars,
  16 frames or 120 s; it never trims. Frequency reported = lowest tone.
- A courtesy 73/RR73 leg ends when the message has been TRANSMITTED, never after a decode-cycle count.
- A TX try counts per TRANSMISSION (`shouldCountRetry`), never per decode period.
- Hunt answers a plain CQ from a spotted park station; a straddling grid only when every candidate
  state is wanted.
- Mode hop never changes band.
- An OPERATOR mode change (pop-out, main window, ECHOCAT) stops TX, including Run, Hunt, the WSPR
  beacon and any QSO in progress, and clears the decode history and the calling list on every surface
  and in the server's replay buffer (#517; main.js jtcatOperatorModeChange, lib/jtcat-mode-change.js).
  The Spot Target a spot click just armed survives. An automatic mode hop is not an operator change:
  it calls the engine directly and Run keeps going. Never put the halt in the engine's setMode.
- A potacat://tune link (web pages carry them) stops every automatic transmission BEFORE it tunes:
  Run, Hunt, the WSPR beacon, the Spot Target, a QSO in progress, TX left enabled, Tune
  (main.js tuneLinkStopAutoTx: jtcatHaltTxNow + clearSpotTarget; lib/tune-link-guard.js). Receive
  keeps going. Spot clicks and every other tune are unchanged (test/tune-link-guard-test.js).
  A link never starts the band-change ATU tune ("Auto-tune ATU on band change" keys a carrier):
  bandChangeAtuTune asks tuneLinkAutoAtu, logs the skip to the CAT log, and the link's notice adds
  one clause when it is shown anyway.
- A mode that needs the radio's audio takes it from JTCAT by one tear-down (main.js releaseJtcatFor:
  windows closed, engine stopped whoever started it, the main window's capture released, ECHOCAT told
  running:false). Opening SSTV does it; so does the operator's APRS Start (2026-11-22), which halts
  JTCAT TX first (jtcatHaltTxNow) and says "Stopped FT8 so APRS can listen." (lib/aprs-listen.js
  startPlan). Automatic starts and Guest Pass guests never take it. Nothing restarts FT8 afterwards.
- Wrong-band and out-of-privilege TX guards trust only a LIVE dial reading.
- ULTRACAT (hidden, `settings.ultracat`): Run mode and unattended Hunt are the operator's
  responsibility; without it Hunt stops after 30 min idle (test/jtcat-hunt-off-test.js).
- The pop-out captures no audio while driving a remote shack; the shack's engines run, the laptop displays.
- Never copy GridTracker or WSJT-X copy or colours; parity with WSJT-X behaviour is fine and often the goal.
- The window's layout (#857, lib/jtcat-layout.js): Options > The picture > Layout, Automatic (default),
  Full or Compact, saved as jtcatLayout (GLOBAL_KEY, display). Automatic decides by the screen, not the
  window (2026-11-23): Full when the work area of the display the window is on is at least 840 CSS px,
  Compact below that (one edge, no hysteresis). The 840 is measured: Full needs about 790 px of window
  for four Band Activity lines, plus the title bar. So 1366x768 is Compact, 1920x1080 at 100% is Full
  even in the default 700 px window, 1920x1080 at 125% (824 px) is Compact. CSS px = work area / zoom,
  so Ctrl and minus can bring Full back. main.js sends the work area when the window moves to another
  display or a display changes ('jtcat-work-area'); a resize alone never switches. An explicit Full or
  Compact always wins and only that choice is saved. Compact is body.jp-compact: shorter chrome, same text sizes. The layout
  never moves or resizes the window (test/jtcat-auto-compact-test.js).

## Tests
lib/ft8-engine-test.js, lib/psk-engine-test.js, test/jtty-*.js, test/jtcat-*.js,
test/decode-contract-test.js (real worker, native and WASM), test/layout-alignment-test.js (rows at
phone and desktop widths, CI only), test/remote-bridge-test.js, test/k9cyt-requests-test.js.

## History
The long-form reasoning behind each rule (who reported it, what broke, the fix) is in docs/decisions/
(one file per decision, index in docs/decisions/README.md), docs/settings-reference-dev.md (every JTCAT
setting with its full note) and docs/modules.md (the engine and codec notes).
