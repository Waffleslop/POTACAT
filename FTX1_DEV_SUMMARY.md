## FTX-1 support summary for POTACAT 1.7.5

This branch adds and validates FTX-1-specific support for:

- `FTX-1 field` and `FTX-1 optima` rig models
- power control via `PC1xxx` / `PC2xxx`
- filter width via `SH00xx`
- SWR / ALC meter routing via `RM6` / `RM4`
- physical TX polling via `TX`
- VOX on/off and VOX gain via `VX` / `VG`
- NB level via `NL`
- DNR level via `RL`
- AGC via `GT`
- monitor via `ML`
- compressor on/off and level via `PR` / `PL`
- mic gain via `MG`
- CLAR RX, CLAR TX, and shared CLAR offset via `CF`
- CW text playback using `KM` + `KY05`
- CW break-in via `BI`
- CW break-in delay via `SD`

## UI changes

The rig popover now exposes FTX-1-aware controls for:

- AGC
- compressor level
- DNR level
- NB level
- VOX and VOX level
- monitor and monitor level
- mic gain
- CLAR RX
- CLAR TX
- CLAR offset as a numeric Hz input
- CW break-in
- CW break-in delay
- preamp targeting

## Important model-specific behavior

- HF/50 preamp is currently mapped as `IPO` for off and `AMP1` for on.
- `AMP2` is still not exposed in the UI.
- CLAR RX and CLAR TX are separate enable states, but the offset is one shared value because that is how `CF` is modeled in the FTX-1 CAT manual.
- `Pre Target` is a practical workaround for dual-receive use. It lets the user manually send preamp commands for `HF/50`, `VHF`, or `UHF` even when MAIN-side frequency tracking is not the side they care about.

## What is intentionally not claimed as solved

- true independent MAIN/SUB preamp state
- separate RX and TX CLAR offset frequencies
- the SWR discrepancy seen in AM carrier versus SSB testing
- HF/50 `AMP2` UI exposure

## Validation status

Real-radio testing reported working for:

- mic gain
- AGC
- CLAR RX / TX / shared offset
- CW text timing
- break-in and break-in delay
- preamp behavior, including manual target selection

Local test status at snapshot time:

- `node --check main.js` passed
- `node --check renderer/app.js` passed
- `test/rig-test.js`: `113 passed, 4 failed`

The 4 failures are pre-existing unrelated tests:

- 3 `rigctld` mode/passband expectation mismatches
- 1 CI-V mode-frame expectation mismatch
