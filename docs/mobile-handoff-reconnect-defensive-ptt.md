# Mobile Handoff — defensive PTT release on reconnect truncates FT8 TX

**Audience:** ECHOCAT mobile (iOS) team
**Desktop status:** primary fix shipped (desktop-side, see below). Mobile change is **optional hardening** — desktop is now correct on its own.
**Origin:** K8IKO field report — FT8 TX cut by a brief phone Wi-Fi blip + reconnect.

---

## TL;DR

When the controlling phone's WebSocket drops and reconnects within the desktop's
60 s grace window, the phone fires a bare `{type:'ptt', state:false}` defensive
reset. On the desktop that landed as a real PTT release and **dropped the rig to
RX mid-slot, truncating an in-progress engine-driven FT8 transmission** (losing
the tail Costas array + CRC, so the far end can't decode that slot).

The desktop now **ignores any remote PTT-release while the FT8 engine owns TX**,
so the truncation is fixed regardless of mobile version. The optional mobile
change below lets the phone *self-identify* its defensive reset so the desktop
(and any future client) can ignore it unconditionally, not just during FT8.

---

## Root cause (for context)

- FT8 PTT is **engine-owned** on the desktop: the FT8 engine keys the rig from
  its `tx-start` handler and releases it on its own schedule (`txComplete` /
  failsafe). It does **not** route through the voice-PTT path.
- A WS close inside the grace window does **not** itself force RX — the engine
  keeps running (decoding survives by design).
- On **reconnect**, the phone's bare `ptt:false` reached the desktop's
  `remoteServer.on('ptt')` listener → `handleRemotePtt(false)` → rig forced to RX
  mid-transmission. That single slot is unrecoverable for the receiving station;
  it also burns one `jtcatMaxQsoAttempts` retry. Engine state (`Enable-Tx`,
  auto-seq, active QSO) was *not* cleared, so the QSO resumed the next slot — the
  damage was limited to the truncated slot.

---

## Desktop fix (already applied)

`main.js`, inside `remoteServer.on('ptt')`:

```js
if (state === false && ft8Engine && ft8Engine._txActive) {
  sendCatLog('[PTT] Ignored remote PTT-release during engine-owned FT8 TX');
  return;
}
```

- Covers **both** truncation paths (the reconnect `ptt:false` and
  `_onClientDisconnected`'s force-RX funnel through the same listener).
- Desktop-initiated releases (profile-switch, grace teardown, `stopJtcat`) call
  `handleRemotePtt(false)` directly and bypass this listener — unaffected.

---

## Optional mobile change — tag the defensive reset

If the phone sends a PTT release purely as a **reconnect-time defensive reset**
(i.e. not because the user lifted a PTT button), tag it so the desktop can
distinguish it from a genuine release.

### Wire format

Add a `source` field to the existing `ptt` message **only** for the defensive
reset:

```json
{ "type": "ptt", "state": false, "source": "reconnect-defensive" }
```

- **Field name:** `source`
- **Type:** string
- **Value the desktop keys on:** `"reconnect-defensive"`
- **Backward compatible:** the field is additive. Older desktops ignore it; the
  current desktop already protects engine TX without it.

### When to send it

- Send `source: "reconnect-defensive"` **only** for the automatic
  reset-to-known-state PTT the app emits right after the socket re-opens.
- Do **NOT** add `source` to a real user PTT release (finger off the PTT
  button) — those must stay un-tagged so the desktop honors them.

### Desktop follow-up (will be wired when mobile ships this)

The desktop will add, at the top of the same `ptt` handler:

```js
if (msg.source === 'reconnect-defensive') return; // a reset must never key/unkey anything
```

i.e. a defensive reset is ignored **unconditionally**, not just during FT8.
Until mobile sends the field, this branch is dead and the FT8-only guard above
carries the fix.

---

## Acceptance / test

1. Start JTCAT FT8 on the desktop with the phone connected and controlling.
2. Begin an engine-driven transmission (CAT connected, rig keys, tx meter live).
3. Mid-slot, force the phone's WS to drop and reconnect within ~2 s (toggle
   Wi-Fi / airplane mode briefly).
4. **Expected:** the transmission completes the full slot; PTT-off lands on time
   (~slot+13.14 s); the far end decodes normally; desktop log shows
   `Ignored remote PTT-release during engine-owned FT8 TX` if the phone sent a
   bare `ptt:false`.
5. If mobile ships the `source` tag: desktop log should instead show the
   defensive reset being dropped at the top of the handler, for any mode.

---

## Out of scope

- **Wi-Fi instability** is the separate root network cause of the blip; this
  handoff only addresses why a <2 s control-link blip was killing TX.
- No change to the 60 s grace window, decoding survival, or engine state
  persistence — all already correct.
