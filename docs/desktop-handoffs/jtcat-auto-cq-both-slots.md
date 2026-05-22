# JTCAT auto-CQ transmits on both even and odd slots back-to-back

Status: open
Filed: 2026-05-06
Repo for changes: d:/projects/potacat-dev

## Context

iOS user reports the FT8 screen calls CQ on both the even and odd
transmission slots back-to-back without ever waiting to listen for
replies. The expected behavior is the standard FT8 alternation:
operator picks a slot (or the engine picks one), TX on that slot,
then RX on the alternate slot to hear replies.

When the engine TXes on every cycle, no one can ever reply because
the operator's rig is transmitting through the entire window the
caller would need to send their answer.

## Symptom

- Tap "TX CQ" or set Auto-CQ to POTA / SOTA / All bands.
- Engine sends `AE7DX K3SBP FN20`-style frame on slot 0 (even, 0–15 s
  of each minute).
- Same frame goes out on slot 1 (odd, 15–30 s of each minute) without
  any RX gap to decode replies.
- Repeats indefinitely, no QSOs ever land because the rig is TXing
  whenever a station tries to call back.

## What the iOS app already does

- `Ft8Screen.tsx` `toggleAutoSeq()` sends `jtcat-set-auto-seq` with the
  current Auto Seq toggle state. Default is `true`.
- TX CQ button sends `jtcat-call-cq` (single-shot).
- Auto-CQ pill sends `jtcat-auto-cq-mode` with `'off' | 'pota' | 'sota' | 'all'`.
- TX slot can be chosen via the existing `jtcat-set-tx-slot` C2S
  message but the iOS UI doesn't expose it (the engine should pick).

No iOS changes needed. This is a desktop engine bug.

## What needs to change on desktop

### 1. Locate the auto-CQ transmit loop

Likely in `lib/jtcat-manager.js`. Search for where the engine decides
to transmit on each cycle boundary. The auto-CQ state machine should
have one of these patterns:

```js
// CORRECT — alternate
function onCycleBoundary() {
  if (autoCqEnabled) {
    if (currentSlot === txSlot) {
      transmit(buildCqFrame());
    } else {
      // RX cycle — listen for callers, advance state machine
    }
  }
}

// BUGGED — both slots
function onCycleBoundary() {
  if (autoCqEnabled) {
    transmit(buildCqFrame()); // fires on every cycle, no slot check
  }
}
```

### 2. Validate against operator's chosen slot

The auto-CQ engine should:
- Honor the operator's TX slot preference (`set-tx-slot` even / odd, or
  let the engine pick — usually odd for low-power or even for high-power).
- Only TX on that slot. Listen on the OTHER slot.
- If a decode in the RX slot contains the operator's callsign as the
  destination, advance the QSO state machine (we already have
  `phase=reply / report / 73 / done`).

### 3. Verify the regression isn't recent

Casey's `a6bead1` commit changed PTT timing — TX wraps on cycle
boundary even if started late. That fix shouldn't have changed
slot-alternation behavior, but check whether the auto-CQ scheduler
was inadvertently flipped to fire on every cycle instead of every
other cycle.

Likely culprit: the cycle boundary handler now fires `transmit()`
unconditionally rather than gated by `slotIndex === txSlot`.

### 4. Sanity check with WSJT-X behavior

WSJT-X's auto-CQ (the "Tx 1" / "Tx 2" / "Tx 3" sequence buttons + the
auto-seq feature) only transmits on the operator's chosen slot. RX
alternates. Match that contract.

## Test path

1. Apply the fix.
2. Connect iOS app to desktop running master.
3. On iOS: tap **TX CQ** once.
4. Desktop should transmit on the next available even/odd slot, then
   listen on the alternate slot for replies.
5. Watch the desktop log: should see one TX cycle followed by one RX
   cycle (with `[FT8 Worker] NATIVE decode: N decodes`).
6. Tap **Auto-CQ → POTA** on iOS. Same alternation pattern: TX, RX,
   TX, RX. Not TX, TX, TX, TX.
7. Verify a station can actually reply: have a friend / other rig
   call back during the RX cycle. Their call should decode + the
   QSO state machine should advance.

## Reference

- iOS auto-CQ control: `D:\Projects\potacat-app\src\screens\Ft8Screen.tsx`
  search for `jtcat-auto-cq-mode` and `jtcat-call-cq`.
- Likely fix location: `lib/jtcat-manager.js` cycle-boundary handler.
- Related shipped commits:
  - `a6bead1` — PTT timing fix (good — keep)
  - `fdb12fc` — Hold TX Freq + latency calibration (good — keep)
- Earlier engine timing log: Casey shared a session where `Immediate
  TX` happened 10281 ms into a cycle, suggesting the scheduler isn't
  consistently respecting cycle boundaries. Worth correlating with
  this bug.
