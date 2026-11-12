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
- The pop-out to shack bridge is lib/remote-bridge.js (a row per channel; the test fails otherwise).

## Operating rules that are settings (names only; semantics in each module's header)
Per profile: jtcatMaxQsoAttempts, jtcatReworkDays, jtcatHuntSpotted, jtcatNferParks, jtcatLogPrompt,
jtcatRelogCooldownMin, jtcatRunPauseAfter, jtcatModeHop*, jtcatFdMode/jtcatFdExch, jtcatHoundMode,
jtcatSkipTx1, jtcatApDecode, jtcatLateStartTx, jttyMacroStyle, jttyMacros, pskMacros.
Machine-wide (GLOBAL_KEY): ultracat, jtcatRxGain, jtcatTxGain (desktop-authoritative, one writer
`applyJtcatTxGain`), jtcatWaterfallSpeed, jtcatWaterfallFloor, jtcatShowBandScope.
Rule: a setting that is operating policy is per profile; a setting about this machine or its display is GLOBAL.

## Hard rules
- JTTY dials: 20 m 14090, 40 m 7090. Never 14080 (that is FT4). JTTY refuses more than 80 chars,
  16 frames or 120 s; it never trims. Frequency reported = lowest tone.
- A courtesy 73/RR73 leg ends when the message has been TRANSMITTED, never after a decode-cycle count.
- A TX try counts per TRANSMISSION (`shouldCountRetry`), never per decode period.
- Hunt answers a plain CQ from a spotted park station; a straddling grid only when every candidate
  state is wanted.
- Mode hop never changes band.
- Wrong-band and out-of-privilege TX guards trust only a LIVE dial reading.
- ULTRACAT (hidden, `settings.ultracat`): Run mode and unattended Hunt are the operator's
  responsibility; without it Hunt stops after 30 min idle (test/jtcat-hunt-off-test.js).
- The pop-out captures no audio while driving a remote shack; the shack's engines run, the laptop displays.
- Never copy GridTracker or WSJT-X copy or colours; parity with WSJT-X behaviour is fine and often the goal.

## Tests
lib/ft8-engine-test.js, lib/psk-engine-test.js, test/jtty-*.js, test/jtcat-*.js,
test/decode-contract-test.js (real worker, native and WASM), test/layout-alignment-test.js (rows at
phone and desktop widths, CI only), test/remote-bridge-test.js, test/k9cyt-requests-test.js.

## History
The long-form reasoning behind each rule (who reported it, what broke, the fix) is in docs/decisions/
(one file per decision, index in docs/decisions/README.md), docs/settings-reference-dev.md (every JTCAT
setting with its full note) and docs/modules.md (the engine and codec notes).
