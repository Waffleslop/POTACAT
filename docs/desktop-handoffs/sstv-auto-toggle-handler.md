# SSTV auto-listen remote toggle handler (Gap 14)

Status: open
Filed: 2026-05-06
Repo for changes: d:/projects/potacat-dev

## Context

When the desktop is in SSTV idle-listen mode, the iOS app shows a yellow "AUTO-SSTV · 14.230 kHz" banner at the top of the SSTV tab. Tapping the banner sends `sstv-set-auto-enabled { enabled: false }` over the WS, expecting the desktop to flip auto-listen off. Currently the desktop has no handler for this message — the toggle is a visual no-op.

This is filed as Gap 14 in `docs/echocat-protocol-gaps.md`.

## What the iOS app already does

- `src/screens/SstvScreen.tsx` `toggleAutoSstv()` sends `{ type: 'sstv-set-auto-enabled', enabled: !isAutoRx }` on tap.
- The banner displays based on `tx.state === 'auto-rx'` from the existing `sstv-tx-status` push, so the state already round-trips back when the desktop reports it.

No iOS changes needed.

## What needs to change on desktop

### 1. Handler — `lib/remote-server.js`

Add a case in the message dispatch:

```js
case 'sstv-set-auto-enabled': {
  const enabled = !!msg.enabled;
  this.emit('sstv-set-auto-enabled', { enabled });
  break;
}
```

### 2. Main wiring — `main.js`

Listen for the emitted event and flip the SSTV engine's auto-listen mode:

```js
remoteServer.on('sstv-set-auto-enabled', ({ enabled }) => {
  if (sstvEngine) sstvEngine.setAutoListen(enabled);
  // Push current state back so all clients see the flip.
  remoteServer.broadcastSstvTxStatus({
    state: enabled ? 'auto-rx' : 'rx',
    freqKhz: sstvEngine?.autoListenFreqKhz,
  });
});
```

### 3. State broadcast

Make sure `sstv-tx-status` carries `state: 'auto-rx'` when the auto-listen mode is on, so the iOS banner appears/disappears in sync with the actual engine state. (May already work if the desktop popout already drives this state — verify.)

## Test path

1. Apply this change.
2. Enable auto-listen on the desktop (tick the desktop's auto-SSTV checkbox).
3. iOS SSTV tab should show the yellow banner.
4. Tap the banner.
5. Banner disappears; desktop's auto-listen indicator should flip off in sync.
6. Re-enable from desktop. Banner reappears on iOS within ~500ms.

## Reference

- Filed as Gap 14 in `docs/echocat-protocol-gaps.md`.
- Protocol type already registered in `lib/echocat-protocol.js` (`sstv-set-auto-enabled`).
- iOS handler: `D:\Projects\potacat-app\src\screens\SstvScreen.tsx` `toggleAutoSstv()`.
