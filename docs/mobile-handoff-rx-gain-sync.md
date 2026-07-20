# Mobile Handoff — Synced RX gain slider (blank-waterfall guard)

**Audience:** POTACAT mobile (iOS / Android) team
**Scope:** Wire contract + UX for a desktop-synced JTCAT RX gain slider.
**ALL desktop work is BUILT (2026-07-20).**
**Origin:** K3SBP — on 2026-07-18 the desktop popout's RX gain slider was at
0, which blanked the FT8 waterfall on the desktop AND on iOS (the phone's
waterfall spectrum is computed downstream of that gain node). Nothing on the
mobile device could see the cause, let alone fix it. Casey's ask: "create a
sync-able slider for RX audio gain so the mobile app can control it."

---

## What the desktop now does

`settings.jtcatRxGain` (float 0–1, default 1) is the ONE authoritative RX
gain. The three desktop surfaces (main-window JTCAT view, JTCAT popout,
ECHOCAT web client) all read and write it through main, which:

- clamps to 0–1, persists it (survives restarts — the old popout value was
  localStorage-only, which is why the blackout persisted for days),
- relays every change to the other desktop windows live,
- echoes every change to the connected remote client as
  **`jtcat-rx-gain-state`** — EXCEPT changes that came from the remote
  client itself, so your slider is never fought by its own echo mid-drag.

## Wire contract

All of this rides the existing ECHOCAT WS session. Register both types in
the mobile protocol registry.

**Set (C2S — already existed, unchanged):**

```json
{ "type": "jtcat-rx-gain", "value": 0.85 }
```

`value` is a float 0–1 (slider percent / 100). Send on user drag (throttle
to ~10/s is plenty). Note for registry accuracy: the wire field has always
been `value` — the desktop registry briefly documented `level`, which never
matched reality and was corrected 2026-07-20.

**State (S2C — NEW):**

```json
{ "type": "jtcat-rx-gain-state", "value": 0.85 }
```

Sent (a) once at connect (hydration, alongside `jtcat-hold-tx-state` in the
same burst), and (b) whenever any OTHER surface moves the value — desktop
sliders, the web client, a second session. Apply it to the slider UI
verbatim. You will NOT receive echoes of your own sets.

**Capability gate:** the hello's `capabilities` array now includes
**`rx-gain-sync`**. Gate the slider on it — against an older desktop,
without the capability, show nothing new (your `jtcat-rx-gain` sets still
work as before; you just won't get state back).

## UX guidance

- Put the slider on the FT8 screen near the waterfall (the desktop popout
  keeps it in the bottom bar as "RX").
- **The whole point:** when `value` is at or near 0, say so on the
  waterfall — the desktop shows "Waterfall muted — RX gain is at 0" right
  on the strip. A blank waterfall with a silent zeroed gain is exactly the
  failure this shipped to prevent; a hint plus the slider is the cure.
- Do NOT push a locally-saved gain to the desktop at connect. The desktop
  is authoritative; hydrate from `jtcat-rx-gain-state`. (The web client
  used to push its saved copy on every connect — that was removed as part
  of this work, since a stale 0 from a client would re-blank the shack.)

## Sanity checks against the desktop

1. Connect → you receive `jtcat-rx-gain-state` within the auth-ok burst.
2. Drag the phone slider → desktop popout + main-window sliders move live,
   waterfall brightness follows, and no state echo comes back to you.
3. Move the desktop popout slider → phone receives state within ~100 ms.
4. Set 0 from the phone → desktop waterfall shows the muted callout; set
   back to 80% → it recovers. Restart the desktop → value persists and
   re-hydrates on reconnect.
