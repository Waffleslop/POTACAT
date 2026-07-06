# Mobile Handoff — Rig Reconnect ("my radio is back on")

**From:** POTACAT desktop
**To:** ECHOCAT mobile
**Status:** Desktop side BUILT on master 2026-07-06 (post-v1.9.5).

## The scenario (Casey, 2026-07-06)

Storms → radio powered off, POTACAT desktop left running. Radio comes back
hours later. Desktop showed **"SmartSDR API unreachable at …:4992"** forever:
the SmartSDR client retried 3 times over ~35 s, then set a permanent
give-up flag that only a desktop-side Rig-settings save cleared. The operator
(possibly away from the desktop, phone in hand) had no way to kick it.

## What the desktop now does (context for mobile UX)

1. **Self-heals.** After give-up, a quiet background probe re-dials the radio
   every 60 s indefinitely. A power-cycled radio reconnects by itself within
   ~1 min of being back on the network — no human needed. The desktop's red
   banner also auto-dismisses on recovery.
2. **Accepts a phone-initiated immediate retry** — the subject of this
   handoff. For when the operator is watching the phone and doesn't want to
   wait out the probe interval, or wants to force a full CAT re-dial for any
   rig type (serial/Icom/K4 too, not just Flex).

## Protocol

**C2S** (over the existing authed WS):

```json
{ "type": "rig-reconnect" }
```

No payload. Desktop rate-limits to one per 5 s (extra sends are silently
dropped — don't disable the button client-side beyond a short debounce).

**S2C ack**, sent immediately when the command is accepted:

```json
{ "type": "rig-reconnect-ack" }
```

The ack means "reconnect cycle started", **not** "radio is back". The actual
outcome arrives through the existing `cat-status` / radio-status broadcasts
you already render — a successful Flex recovery lands as the normal
connected-status flip within a few seconds.

Desktop behavior on receipt: re-dials the active rig's CAT target
(`connectCat()`, skipped when WSJT-X mode owns the radio) and restarts the
SmartSDR API client (`connectSmartSdr()`, no-op for non-Flex rigs). This is
the same blessed pair the desktop settings-save and switch-rig paths use,
and it resets the SmartSDR give-up state.

## Suggested mobile UX

- Put a **"Reconnect radio"** action where the rig status already lives —
  the same overlay as the rig switcher (`soRigRow`) is the natural home; it
  should be reachable when the CAT status shows disconnected.
- On tap: send the message, toast "Asking desktop to reconnect…". On
  `rig-reconnect-ack`: toast "Reconnecting — watch the rig status." Then let
  the existing status pipeline tell the truth.
- **Older-desktop tolerance:** desktops before this change ignore unknown WS
  types silently — no ack will come. If no ack within ~3 s, toast something
  like "No response — desktop may need an update." Don't hide the button on
  version sniffing; the ack IS the capability signal.
- Consider surfacing it contextually: if CAT status has been disconnected
  for > 1 min while the WS link itself is healthy, a small inline
  "Radio offline — reconnect?" affordance beats hunting through menus. Your
  call on placement.

## Notes

- Works for every rig type; for non-Flex serial rigs `connectCat()` re-opens
  the COM port, which also recovers "USB re-enumerated after power cycle"
  cases IF the port name didn't change (a moved COM port still needs
  desktop-side settings).
- Nothing persists: the command mutates no settings, so it's safe to expose
  without confirmation.
- Desktop pieces, for reference: `lib/smartsdr.js` (`_scheduleProbe`, give-up
  now non-terminal), `lib/remote-server.js` (`rig-reconnect` case, 5 s rate
  limit), `main.js` (`remoteServer.on('rig-reconnect')`, banner clear via
  `smartsdr-reachable`), `test/smartsdr-reconnect-test.js` (11 cases, CI).

---

## Mobile status (2026-07-06)

**Built and shipped OTA.** Two notes for the record:

- **Naming correction:** there is no `cat-status` / `radio-status` message in
  either repo — the rig-connectivity signal is the `catConnected` boolean on
  the regular `status` broadcast. Mobile keys everything off that field.
  Desktops that omit it (older builds) simply never trigger the contextual
  affordance; the manual action still works via the ack path.
- **Placement:** mobile has no `soRigRow` equivalent (the header rig chip was
  never shipped). The action lives in Settings → Radio in use ("RADIO LINK →
  Reconnect radio", not Pro-gated, hidden during Guest Pass sessions), and —
  the discoverable half — a warn-styled "Radio offline — Reconnect" banner
  that appears app-wide when the WS is healthy but `catConnected` has been
  false for 60 s. Toast flow exactly per spec: send → "asking…", ack →
  "reconnecting — watch the rig status", no ack in 3 s → "desktop may need an
  update". Client debounce is 3 s; the desktop's 5 s rate limit is the
  backstop.
