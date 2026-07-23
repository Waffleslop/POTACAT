# Mobile Handoff — FM squelch (rig-hardware SQL)

**Audience:** ECHOCAT mobile (iOS / Android) team
**Scope:** Add an FM squelch slider to the rig-controls UI. Desktop + web client
are BUILT; the native app needs the slider added (it doesn't auto-render new
registry controls).
**Origin:** K3SBP — POTACAT now drives the radio's real FM squelch (Yaesu `SQ`,
Icom CI-V `0x14 03`, Hamlib `L SQL`, Flex slice squelch). This is the **rig's**
squelch, distinct from the decoder DSP squelch in FT8/PSK31/FreeDV — label it
**"SQL"** to avoid confusion.

---

## Wire contract — reuse the generic `rig-control` path (nothing new)

No new protocol message. Squelch rides the existing generic dispatcher, exactly
like power on/off and the custom-CAT command already do.

**Set (C2S):**
```json
{ "type": "rig-control", "data": { "action": "set-squelch", "value": 55 } }
```
`value` is an integer **0–100**. Send on slider release/commit (the desktop
throttles internally; a change-end event is plenty).

**Read (S2C — on the existing `status` snapshot, sent on connect + each poll):**
- `status.squelch` — integer 0–100, the current threshold. Bind the slider to it
  (guard against clobbering while the user is dragging).
- `status.capabilities.squelch` — boolean. True for every CAT rig (see below).
- `status.mode` — the current mode string; `"FM"` is the one that matters here.

There is **no** dedicated `set-squelch` message and no new S2C type — do not add
one. (The desktop's `set-rfgain`/`set-txpower` use dedicated messages for legacy
reasons; squelch deliberately uses the generic path, which needs no per-control
server handler.)

## Visibility — gate on FM mode, not band

Show the SQL slider only when **`capabilities.squelch && (mode === "FM" || squelch > 0)`**:
- Squelch is an FM function, so it's hidden on SSB/CW/digital where it does
  nothing — keeps the panel uncluttered during the 90% of HF operating.
- It's shown on **any** band while in FM — 10m, 6m, 2m, 70cm all run FM. Do NOT
  gate on VHF/UHF band; 6m/10m FM are legitimate and POTACAT has no per-rig
  band-coverage model anyway.
- The `|| squelch > 0` clause keeps the control reachable if it's engaged and the
  op then leaves FM, so they can always turn it back down (matches desktop).
- When `mode` is momentarily absent from a partial status update (suppressed
  during a tune) and squelch isn't engaged, leave the row's visibility as-is to
  avoid flicker.

## Capability breadth

`capabilities.squelch` is `true` for every real CAT backend — Yaesu, Kenwood,
Icom CI-V, Hamlib/rigctld, and Flex — resolved centrally on the desktop
(`getRigCapabilities`). An unsupported `SQ` just returns a harmless rejection.
So you can rely on the cap flag; the FM-mode gate does the actual filtering.

## UI guidance

- Put "SQL" next to RF Gain in the rig-controls panel (that's its desktop home).
- Range 0–100, same slider style as RF Gain / NB level.
- Optimistically update the slider on drag; reconcile from `status.squelch`.

## Desktop reference (already shipped)

- Registry: `lib/rig-controls.js` → `'set-squelch'` (`kind:'level'`, `caps:'squelch'`, label `SQL`).
- Dispatcher: `applyRigControl` `case 'set-squelch'` (main.js) — clamps 0–100,
  Flex→`smartSdr.setSquelch`, rigctld→`/100` for `L SQL`, else 0–100 to the codec;
  persists `settings.squelchDefault`; echoes `squelch` in `broadcastRigState` +
  `broadcastRemoteRadioStatus`.
- Codecs: `setSquelch` in kenwood (`SQ0nnn;`), civ (`0x14 03` BCD), rigctld
  (`L SQL <0-1>` / `w SQ0nnn;`), smartsdr (`slice set N squelch=1 squelch_level=nn`).
- Web client: `#rc-squelch-slider` in `renderer/remote.js` sends the exact
  `rig-control` message above and reads `s.squelch` — copy that behavior.

## Sanity checks vs the desktop

1. FT-991 (or any rig) in FM → SQL slider appears; drag → RX mutes/opens at the
   threshold; the desktop rig popover mirrors the value live.
2. Switch to SSB → slider hides (unless engaged).
3. Reconnect → `status.squelch` re-hydrates the slider; the value survived on the
   desktop (`settings.squelchDefault`).
