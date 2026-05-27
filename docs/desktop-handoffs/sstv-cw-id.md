# SSTV CW ID after TX

Status: shipped (2026-05-26)
Filed: 2026-05-06
Repo for changes: d:/projects/potacat-dev

## Resolution

- `generateMorseSamples()` already lives at `main.js:224` (Float32Array
  output, PARIS timing, 5 ms attack/decay ramp, 60% peak amplitude).
- SSTV encode-complete handler at `main.js:13290-13346` already appends
  the Morse tail when `settings.sstvCwId && settings.myCallsign`:
  - 250 ms silence between image end and CW ID
  - 20 WPM, 800 Hz, sampled at `SSTV_SAMPLE_RATE`
  - merged length feeds the recomputed `durationSec` so
    `broadcastSstvTxStatus({ state: 'tx', durationSec })` reflects the
    real TX length and iOS's countdown banner stays accurate.
- The `save-settings` handler at `main.js:7883` is a generic
  `Object.assign(settings, partial)`, so mobile's `save-settings
  { sstvCwId }` write is persisted on the desktop.

Closed the one remaining gap on 2026-05-26: `updateRemoteSettings()`
now includes `sstvCwId` in the `setRemoteSettings(...)` snapshot so a
mobile client reconnecting sees the persisted desktop state instead of
falling back to the `false` default in its local store.

## Context

The iOS app's Settings → SSTV section now has a "CW ID after TX" toggle. Some regulators (UK, parts of EU) require every transmission to end with a station identifier in CW; many US hams use it as good operating practice.

The toggle is a `boolean` in `desktopSettings.sstvCwId`, persisted via `save-settings { sstvCwId: bool }` and round-tripped via the existing `applySettings` path (`auth-ok` + `settings-update`). When ON, the user expects every SSTV transmission to end with a Morse-encoded callsign.

## What the iOS app already does

- Settings UI in `src/screens/SettingsScreen.tsx` (SSTV section) — toggle calls `useDesktopSettings.setSstvCwId(bool)`.
- `setSstvCwId` sends `save-settings { sstvCwId }` and updates local state.
- `applySettings` in `src/state/desktopSettings.ts` already absorbs `sstvCwId` from `auth-ok` and `settings-update` push payloads, so changes from desktop or web client mirror back.

No iOS changes needed.

## What needs to change on desktop

### 1. Settings shape

Add `sstvCwId: bool` to the desktop settings schema (default `false`). Persist alongside other SSTV settings (`sstvMode`, `sstvTxGain`, etc.). Include in the broadcast settings payload so all clients see updates.

### 2. CW Morse FSK encoder

If a Morse-FSK helper doesn't already exist (it might, for FT8 CW ID), add one. Standard SSTV CW ID parameters:

- Center frequency: 800 Hz (within SSTV passband)
- Keying: ±400 Hz or simple OOK (on-off keying) at 800 Hz
- Speed: 20 WPM default — could expose `sstvCwIdWpm` setting later
- Sample rate: 12 kHz (matches SSTV baseband)

### 3. Append to TX

In `lib/sstv-engine.js`'s transmit pipeline, after the standard SSTV envelope completes, if `settings.sstvCwId === true && settings.myCallsign`, append a 1-second silence + Morse callsign + 1-second tail:

```js
async transmit(audioBuffer, mode) {
  const samples = await this.encodeMode(audioBuffer, mode);
  if (this.settings.sstvCwId && this.settings.myCallsign) {
    samples.push(silence(1000)); // 1s gap
    samples.push(generateMorseFsk(this.settings.myCallsign, {
      wpm: 20, freq: 800, sampleRate: 12_000,
    }));
    samples.push(silence(500));
  }
  this.playOut(samples);
}
```

### 4. Update TX duration estimate

The `sstv-tx-status { durationSec }` message should include the CW ID time when the flag is on. Roughly: `morse_dits = 50 * callsign_length`, at 20 WPM = 60 ms/dit, so `cwIdSec = (50 * callsign.length * 0.06) + 1.5` extra seconds. Add to the mode's base duration before pushing.

iOS uses `durationSec` for the countdown banner, so an accurate estimate keeps the "23s left" indicator honest.

## Test path

1. Apply this change.
2. On iOS, Settings → SSTV → toggle "CW ID after TX" ON.
3. Verify the toggle persists across app restart (settings round-trip via desktop).
4. SSTV → Compose → Send a Martin M1 card.
5. Listen via local SDR or another receiver. The image should decode normally, then ~1s of silence, then your callsign in clear Morse, then silence.
6. Verify the iOS TX countdown banner reflects the longer total duration (e.g., Martin M1 ~114s base + ~3s CW ID = ~117s).

## Reference

- iOS settings UI: `D:\Projects\potacat-app\src\screens\SettingsScreen.tsx` (SSTV section).
- iOS state: `D:\Projects\potacat-app\src\state\desktopSettings.ts` — `sstvCwId` field, `setSstvCwId` action, applySettings absorption.
- Mirror pattern from FT8 CW ID if one exists in `lib/jtcat-manager.js`.
