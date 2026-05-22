# Heartbeat timeout investigation + decoupling

Status: open
Filed: 2026-05-06
Repo for changes: d:/projects/potacat-dev

## Context

Casey reported in an earlier session: phone locks during FT8 → iOS suspends → desktop fires `[Echo CAT] Client heartbeat timeout — closing` → `[JTCAT] Engine stopped` → `[JTCAT] Phone disconnected — engine stopped, audio released`. When the phone unlocks and reconnects, the engine is dead and the user has to manually restart FT8.

**iOS Build #4 mitigates the visible symptom** via an `AppState` hook in `connection.ts` that force-reconnects on iOS foreground. But the underlying behavior — desktop killing the engine because of one heartbeat timeout — is still suspect for a normal use case (phone in pocket).

This is a lower-priority follow-up to the JTCAT replay-on-reconnect handoff (which is the higher-impact fix).

## What the iOS app already does

- `src/state/connection.ts` listens to `AppState` changes; on iOS foreground transitions the manager calls `refreshConnection()` which tears down and reopens the WS. Default behavior in Build #4+.
- iOS has no control over heartbeat cadence; just sends pings on whatever interval the protocol expects.

No iOS changes needed.

## What needs to change on desktop

### 1. Investigate timeout values — `lib/remote-server.js`

Search for `heartbeat` and confirm the current timeout. iOS can take up to 30 seconds of "transition grace" plus various background-mode lifetimes. If the timeout is < 60s, consider extending — phone naps shouldn't sever the link.

Recommended values:
- Heartbeat interval: 15s (existing or thereabouts)
- Heartbeat timeout: 60s (3 missed heartbeats)

### 2. Decouple JTCAT engine from client presence

Currently `[JTCAT] Phone disconnected — engine stopped, audio released` indicates the engine ties its lifetime to the iOS client. That's wrong for the operator's mental model: the desktop is the operator's station, the phone is just a remote display.

Find where the JTCAT engine is stopped on `client-disconnected` (or equivalent) in `main.js` / `lib/jtcat-manager.js`. Remove the engine-stop call from the disconnect handler. Engine should run as long as the operator wants — independent of phone presence.

This pairs naturally with the JTCAT replay-on-reconnect handoff: if the engine keeps running while the phone is asleep, then on phone wake-up the desktop can replay recent decodes seamlessly.

### 3. Audio release behavior

The "audio released" line suggests CAT/audio resources also get freed on disconnect. Decide:
- If the operator is at the desk and is the one driving FT8, they probably want audio kept open.
- If the operator is operating remote-only and the phone is the only client, freeing audio when no one's listening makes sense.

Easiest answer: don't release audio on heartbeat timeout (too aggressive) but DO release on a clean `disconnect` message from the client. iOS Build #4's AppState hook calls `refreshConnection()` which doesn't send an explicit disconnect — the server just sees a fresh connect that might race with the heartbeat-timeout-close. Mark this whole flow as "WS-level transient" and don't touch CAT resources.

## Test path

1. Apply changes.
2. Start FT8 on desktop with iOS connected.
3. Lock iOS for 90 seconds (long enough to exceed any heartbeat).
4. Unlock; reconnect via Build #4's AppState hook should fire.
5. Desktop log should NOT show `[JTCAT] Engine stopped`.
6. iOS FT8 screen should immediately show recent decodes (combine with replay-on-reconnect handoff for the cleanest experience).

## Reference

- Companion handoff: [jtcat-replay-on-reconnect.md](jtcat-replay-on-reconnect.md).
- iOS reconnect hook: `D:\Projects\potacat-app\src\state\connection.ts` `refreshConnection()`.
- Original symptom captured in Casey's coordination log around 2026-05-04 / 2026-05-05.
