# JTCAT QSO "waiting" phase display for ECHOCAT iOS

Status: open
Filed: 2026-05-14
Repo for changes: D:\Projects\potacat-app

## Context

When you reply to a CQ on FT8 and the station you called answers *someone else* instead of you, the desktop used to hard-abort the QSO. K3SBP hit this: tapped a CQ from KE4QEG on the iOS app, KE4QEG came back to W2HTS instead, and the QSO just ended with no clear reason.

The desktop now handles this better — instead of aborting, it **holds**: keeps the QSO alive in a new `waiting` phase, watches for the station to come free (their next CQ, or them signing off the other QSO), and automatically re-sends your reply when they're available. Timeout after ~3 minutes if they never return.

The hold-and-re-arm logic works on the iOS path already — `remoteJtcatSetTxMsg` broadcasts the phase change. **But the iOS app doesn't know how to render `phase: 'waiting'`**, so the user gets no feedback about *why* their reply didn't go out. That's what this handoff covers.

## What the desktop already does (pending — ships in v1.5.22)

The shared QSO state machine `advanceJtcatQso` in `main.js` gained a `waiting` phase. The state is broadcast over the existing `jtcat-qso-state` S2C message (`lib/echocat-protocol.js:224`, `{ dir: Dir.S2C, feature: 'jtcat' }`) — no new message type.

When the called station picks someone else, the `jtcat-qso-state` payload looks like:

```jsonc
// desktop → phone
{
  "type": "jtcat-qso-state",
  "phase": "waiting",
  "mode": "reply",
  "call": "KE4QEG",            // the station we were calling / still want
  "waitingPartner": "W2HTS",   // who they answered instead (may be "" if unknown)
  "myCall": "K3SBP",
  "myGrid": "FN20",
  "txMsg": "KE4QEG K3SBP FN20", // our reply, preserved — re-sent on re-arm
  "waitCycles": 1              // increments each 15s cycle we keep waiting
  // ...other standard q fields (grid, report, etc.) carried through
}
```

Lifecycle on the desktop side:

1. **Enter `waiting`** — TX is disabled, the slot lock is *kept* (so re-arming is a clean flip), the engine TX message is cleared, this state is broadcast.
2. **Each 15 s cycle in `waiting`** — desktop watches the decodes for the station coming free:
   - a fresh `CQ <call>` from them, OR
   - them signing off their other QSO as the sender (`<other> <call> RR73/73/RRR`)
   - `waitCycles` increments and re-broadcasts each cycle.
3. **Re-arm** — when they're free, desktop sets `phase` back to `reply`, re-enables TX, re-sends `txMsg`, and broadcasts the normal `reply` state. From the iOS app's perspective the QSO just resumes at the reply step.
4. **Timeout** — after 12 cycles (~3 min) with no sign of them, desktop sets `phase: "done"` with `error` populated and broadcasts that (existing `done`/`error` handling already covers this).

Desktop renderers (`renderer/jtcat-popout.js`, `renderer/app.js`) show it as a header line:

> ⏸ KE4QEG is working W2HTS — waiting to reply

…and hold the QSO step tracker at the **reply** step (index 0 of the reply-mode phase list) so it visibly reads "stuck before sending our reply."

## What needs to change in the iOS app

### 1. Recognize `phase: "waiting"` in the QSO-state handler

Wherever the app handles `jtcat-qso-state` (the QSO tracker / sequencer screen — likely a Zustand store reducer or a `useJtcat`-style hook), add `waiting` as a known phase. **Critical: do NOT treat it as `done` or `error`** — the QSO is still live, just paused. Don't clear the QSO state, don't show a failure toast.

### 2. Show the flag

The user's stated ask: a flag telling them *why* nothing is being sent. Mirror the desktop wording:

> ⏸ KE4QEG is working W2HTS — waiting to reply

If `waitingPartner` is empty, fall back to "…is working another station — waiting to reply". Put it wherever the QSO header / current-phase label lives on the FT8 screen. A subtle paused-style treatment (the ⏸ glyph, muted color) reads better than an error/red treatment — this is a normal, expected hold, not a fault.

### 3. Hold the QSO tracker at the reply step

If the FT8 screen has a step tracker (CQ → reply → report → RR73 → 73 → done style), keep it parked at the **reply** step while `phase === 'waiting'`, same as the desktop. Don't advance it, don't collapse it.

### 4. No action buttons strictly required

The desktop handles re-arm and timeout automatically — the iOS app is display-only here. *Optional* nicety: a "Stop waiting" / "Cancel" button that fires the existing `jtcat-cancel-qso` C2S message (`lib/echocat-protocol.js:215`) if the user doesn't want to wait out the 3-minute timeout. Only add it if there's already a natural place for it; not required for v1.

### 5. Test path

1. Pair the iOS app to a desktop running the v1.5.22 batch (or current `master` once committed).
2. On the iOS FT8 screen, tap a CQ from a station that's likely to get multiple callers (a strong/rare one).
3. If that station answers someone else, confirm the iOS screen shows the "⏸ … waiting to reply" flag instead of the QSO vanishing.
4. Confirm the QSO automatically resumes (back to the reply step, TX fires) when the station calls CQ again or finishes their other QSO — no user action needed.
5. Confirm that if the station never returns, after ~3 minutes the QSO ends with the normal error/done treatment.

## Open questions for the iOS team

- Does the QSO-state reducer use an explicit phase allow-list (so an unknown `waiting` is dropped/ignored) or pass-through? If allow-list, `waiting` needs to be added there too, not just in the renderer.
- Is there an existing "paused"/"holding" visual idiom on the FT8 screen, or should this be a fresh treatment?
- Worth adding the optional "Stop waiting" button, or leave it desktop-/timeout-driven for v1?
