# JTCAT replay-on-reconnect

Status: open
Filed: 2026-05-06
Repo for changes: d:/projects/potacat-dev

## Context

iOS users routinely lock their phone mid-FT8 session. iOS suspends the app, the WebSocket dies, and on unlock the app force-reconnects (Build #4 ships an `AppState` hook in `connection.ts` that does this deterministically). The reconnect succeeds, but the JTCAT engine doesn't replay any state to the freshly-connected client — so the user sees ~15 seconds of empty UI before the next live decode lands.

This is a felt-as-broken experience: lock screen → unlock → "where did all the decodes go?"

## What the iOS app already does

- `Ft8Screen.tsx` listens for `jtcat-decode-batch` and merges incoming entries via `append()`. The store dedupes by cycle time (the `time` field), so receiving the same cycle twice is safe — no duplicate rows.
- The connection layer (`src/state/connection.ts`) auto-reconnects on iOS foreground transitions, with full handshake and authentication.
- `Ft8Screen.tsx` already resets `running=false` when the connection drops and flips it back to `true` on the first `jtcat-decode` push, so a reconnected client just needs decodes to flow again.

No iOS changes needed.

## What needs to change on desktop

In `lib/remote-server.js`, mirror the cached-state replay pattern that already works for `rbn-prop-spots` and `pskr-map-spots`. On `client-connected` (after auth completes), if the JTCAT engine is running, push a `jtcat-decode-batch` containing the last 5–10 cycles' decodes:

```js
// After the existing rbn-prop-spots / pskr-map-spots cached replay block.
if (this._jtcatRunning && this._jtcatRecentBatches?.length) {
  const recent = this._jtcatRecentBatches.slice(-10);
  this._sendTo(client, {
    type: 'jtcat-decode-batch',
    entries: recent,
  });
}
```

The desktop already keeps a recent-cycles buffer (or can introduce one — a circular buffer of the last 10 `{ time, results }` entries that `_onCycleBoundary` writes to alongside the live broadcast).

While we're touching the connect path, also push current snapshots of:

- `jtcat-status` — running flag + active mode
- `jtcat-tx-status` — current TX state (so the "ON AIR" banner restores immediately)
- `jtcat-qso-state` — active QSO if any
- `jtcat-hold-tx-state` — Hold TX Freq toggle state (already pushed on connect per `fdb12fc` — verify still wired)

## Test path

1. Start FT8 on desktop with the iOS app connected.
2. Wait for two or three decode cycles to land on the iOS FT8 screen.
3. Lock the iOS device for 60 seconds, then unlock.
4. Within ~1 second, the FT8 screen should show the last 5–10 cycles of decodes immediately — not wait 15s for the next live decode.
5. The TX banner / QSO bar should also restore if a TX or QSO was active when the lock happened.

## Reference

- iOS Build #4 includes the foreground-reconnect: `D:\Projects\potacat-app\src\state\connection.ts` lines added 2026-05-05 (`AppState` listener + `refreshConnection` method).
- Mirror pattern lives at `lib/remote-server.js` — search for `cached-state` / `client-connected` to find the existing rbn-prop-spots replay.
- Related desktop commits already shipped: `b49e81c`, `cecbc01`, `651c356` (gaps 1–20).
