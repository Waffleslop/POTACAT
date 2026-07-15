# Plan — Sync VFO Profiles to the native iOS / Android app

**Author:** K3SBP, 2026-07-15
**Goal:** Make the VFO "Profiles" (saved frequency/mode/filter presets) fully
editable on the phone and sync both ways between desktop and mobile.

---

## TL;DR — most of this already exists

VFO Profiles already have a **complete, battle-tested two-way sync contract** on
the desktop:

- The desktop **persists** them (`settings.vfoProfiles`), **pushes** the list to
  the connected client, **accepts edits back**, **applies** a profile to the rig,
  and **echoes** every change to all surfaces (phone, desktop popout, main window).
- The **browser ECHOCAT web client already implements the full editable, syncing
  widget end-to-end** (`renderer/remote.js`). It is a working reference.

So **the remaining work is almost entirely in the native mobile app** — implement
the same three messages plus a native editable list UI. **No desktop protocol
changes are required to ship this.**

The mobile-facing spec is the companion handoff:
`docs/mobile-handoff-vfo-profiles-sync.md`.

---

## What a profile is

```
{ name: string (≤64), freqKhz: number, mode: string, filterWidth?: number (Hz) }
```

- One **global** list in `settings.vfoProfiles` (not per-rig). **Order matters**
  and is synced.
- `filterWidth` omitted/undefined = "don't touch the filter on apply". Never 0.
- `mode` is an opaque rig mode string (USB/LSB/CW/CWR/AM/FM/DIGU/DIGL/FT8/…).

## The sync contract (live today)

| Message | Dir | Meaning |
|---|---|---|
| `vfo-profiles` `{profiles:[]}` | S→C | Full-list push. Sent on `auth-ok` and after **every** change. |
| `vfo-profiles-update` `{profiles:[]}` | C→S | Client sends the **entire** edited list; desktop replaces `settings.vfoProfiles`, persists, echoes back. |
| `apply-vfo-profile` `{profile:{}}` | C→S | Tune the rig to the profile (freq + mode + filter). Does not change the list. |

**Semantics: full-list replace in both directions** (same model as CW/voice
macros). The desktop is the persistence source of truth; after any client edit it
saves and re-pushes the authoritative list to every surface. Apply feedback
reaches the phone through the **normal freq/mode status stream** (the tune fires
the usual radio-status echo), so mobile needs no special apply-ack handling.

**Desktop code map:**
- Push: `lib/remote-server.js` `sendVfoProfiles()` (~3517); message parse (~2918).
- Handlers: `main.js` `remoteServer.on('vfo-profiles-update')` (~11004),
  `on('apply-vfo-profile')` (~11022).
- Proactive pushes: `auth-ok` (~10701), settings-save re-push (~24733).
- Desktop popout UX (incl. drag-reorder): `renderer/vfo-popout.html` (~1249–1439).
- **Reference client (copy the flow):** `renderer/remote.js` (~10729–10878).

---

## Desktop work (this repo)

**None required to ship.** The contract and the web-client reference are complete
and proven.

**Optional hardening — defer unless a problem shows up:**

1. **Frequency precision.** ~~The web client snapshots `freqKhz` with
   `Math.round(currentFreqHz/1000)` — integer kHz, dropping sub-kHz offsets.~~
   **Fixed 2026-07-15** (`renderer/remote.js` ~10858, now
   `Math.round(currentFreqHz)/1000`) so the web reference client matches the
   desktop popout's full precision. The mobile app **must** likewise keep
   sub-kHz precision (store whole-Hz → kHz, don't round to integer kHz).
2. **Stable per-profile `id` + `updatedAt`.** Today identity is list position and
   edits are whole-list replaces, so two devices editing at the *same instant*
   could clobber (worst case: one lost edit). For the real use case — one operator,
   phone + desktop, rarely simultaneous — this is acceptable. If we ever add ids,
   do it backward-compatibly (backfill on load; treat unknown fields as opaque
   passthrough so older clients don't strip them).

Neither is on the critical path. Ship mobile against the current contract.

## Mobile work (handed off)

Full spec in `docs/mobile-handoff-vfo-profiles-sync.md`. In brief: receive
`vfo-profiles` and render; create (snapshot current VFO), rename, delete, reorder;
apply on tap; push the whole list back via `vfo-profiles-update`; treat every
inbound `vfo-profiles` as authoritative. Layout stays device-local (already
covered by `docs/mobile-handoff-vfo-layout.md`) — only profile **content** syncs.

## Acceptance

- Edit on desktop popout → appears on phone within ~1 s; edit on phone → appears
  on desktop popout + web + persists to `settings.json` (survives desktop restart).
- Tap a profile on phone → rig tunes (freq + mode + filter); desktop dial reflects it.
- Reorder on phone → order persists and shows on desktop.
- Round-trip preserves every field, including **sub-kHz** frequency and `filterWidth`.
