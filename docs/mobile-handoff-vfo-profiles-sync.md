# Mobile Handoff — VFO Profiles: editable + synced

**Audience:** ECHOCAT mobile (iOS / Android) team
**Scope:** Native app + a **one-line desktop schema correction** (see Status).
The desktop transport/persistence is done; build a native, editable VFO
Profiles feature that round-trips over the **existing** ECHOCAT WebSocket
contract.
**Origin:** K3SBP 2026-07-15 — make the desktop VFO "Profiles" (saved
frequency/mode/filter presets) fully editable on the phone and sync both ways.

---

## Status — 2026-07-15 (built)

**Mobile half is implemented and shipping-ready** (pending Casey's sign-off +
build/OTA). What landed, and the one thing that had to change on the desktop:

- **Desktop schema fix (required — the "no desktop changes" claim was wrong).**
  The registry declared `'apply-vfo-profile': { fields: { id: f.string } }`, but
  the wire, the reference client, and the desktop handler (`main.js` reads
  `msg.profile`) all use `{ profile }`. On the desktop this never bit anything —
  `validate()` only runs on `hello`. But the **mobile** client validates every
  outbound C2S through `encode()`, so a correctly-formed `apply-vfo-profile`
  (carrying `profile`, no `id`) threw `ProtocolEncodeError` and never left the
  phone — apply was dead on arrival. Corrected in **both** repos to
  `{ profile: f.object }`:
  - `lib/echocat-protocol.js` (desktop registry-of-record)
  - `src/protocol/echocatProtocol.ts` (mobile mirror)
  Registry-integrity + protocol tests pass on both sides.
- **Reorder is up/down arrows, not drag.** The mobile app has no
  gesture-handler/reanimated dependency, and its entire reorder UX (VFO layout,
  menu order) is arrow-based. Drag would mean a new native module → a native
  build, breaking OTA delivery, and would be a one-off interaction. Arrows are
  consistent + OTA-safe; **order still rides in the pushed array**, so the wire
  contract and desktop side are unaffected.
- **Capability-gated for a safe rollout.** Mobile can OTA ahead of the desktop
  release with zero crash risk (the desktop ignores unknown message types and
  only validates `hello`), but to avoid a "looks-live-but-won't-sync" card on an
  older desktop, the phone gates the feature on **receiving a `vfo-profiles` push
  this session** — a supporting desktop always sends one right after `auth-ok`,
  even with an empty list. No desktop capability flag needed; older desktops that
  never send it get a "needs a newer POTACAT desktop" notice instead of the
  editable card. (If you'd prefer an explicit `hello` capability string later,
  the client can switch to that — the push-signal works today with no change.)
- **Everything else matches this doc**: full-list replace both ways, sub-kHz
  precision snapshot (`round(freqHz)/1000`), `filterWidth` 0→omit, unknown-field
  passthrough, echo-while-editing guard, tap-to-apply with optimistic readout,
  empty state. The list content syncs; the section's show/hide/position is
  device-local (phone layout registry).

**Desktop-side notes surfaced during the build** (not blockers, worth knowing):

1. **Apply is silent when the rig is disconnected.** `on('apply-vfo-profile')`
   guards `if (cat && cat.connected)` and returns with no reply — the phone gets
   no ack and no error. Mobile therefore projects the freq/mode optimistically on
   tap (readout jumps immediately) rather than waiting on a `status` echo that
   may never come.
2. **The desktop now sanitizes the phone's list on ingest** (`vfo-profiles-update`
   → `sanitizeVfoProfiles`, added 2026-07-15): non-objects and entries without a
   usable `freqKhz` are dropped, `name` is clamped to 64, `filterWidth` ≤ 0 is
   dropped, unknown fields are preserved, and the list is capped. The desktop
   echoes the **cleaned** list back, so treat the returned `vfo-profiles` as
   authoritative and reconcile the phone's copy to it. Mobile still enforces the
   data-model constraints on the way out (defense in depth + instant local
   feedback). Previously the list was persisted verbatim, which could round-trip
   a malformed entry and corrupt the popout render.
3. **`freqKhz` is a NUMBER here** (`14074.0`), but the sibling `tune` message
   requires `freqKhz` as a STRING (`'14074.000'`, enforced by the registry).
   Same field name, two types across two rig features — easy to cross-wire.

---

## TL;DR

- A profile is a saved VFO preset: **`{ name, freqKhz, mode, filterWidth? }`**.
  One **global** list; **order matters**.
- The desktop already **pushes** the list, **accepts your edits**, **applies**
  them to the rig, and **persists** them. You implement the phone UI + the same
  **three messages**.
- **Full-list replace, both directions.** You always send the **entire** list;
  the desktop replaces its copy, persists it, and echoes the authoritative list
  back to everyone. **Treat every inbound `vfo-profiles` as the source of truth.**
- **Reference implementation — copy the flow (not the DOM):**
  `renderer/remote.js` ~10729–10878. Desktop popout UX:
  `renderer/vfo-popout.html` ~1249–1439 — note the popout reorders by **drag**,
  but the phone deliberately uses **up/down arrows** instead (see Status); copy
  the sync flow, not the gesture.

---

## Data model

| field | type | notes |
|---|---|---|
| `name` | string ≤64 | user label; required to save |
| `freqKhz` | number | frequency in **kHz**. **Keep sub-kHz precision** (~3 decimals, e.g. `14074.000`, `10118.5`). **Do NOT round to integer kHz.** |
| `mode` | string | opaque rig mode (`USB`/`LSB`/`CW`/`CWR`/`AM`/`FM`/`DIGU`/`DIGL`/`FT8`/…). Capture the current mode, send it back verbatim. |
| `filterWidth` | number (Hz), optional | omit / `undefined` = "don't set a filter on apply". **Never store `0`.** |

Profiles are **global** (not per-rig) — mirror that. **List order is meaningful
and synced.**

---

## Wire contract (live on the desktop)

> The transport and desktop message handlers were always live; the only
> 2026-07-15 change was the `apply-vfo-profile` **registry schema** fix (detailed
> in that subsection below). The desktop also now **sanitizes** an inbound
> `vfo-profiles-update` list before persisting it (drops non-objects / entries
> without a usable freq, clamps `name`, drops `filterWidth` ≤ 0, preserves
> unknown fields) — so a malformed push is cleaned server-side, not just on the
> phone.

### Inbound — desktop → phone
```json
{ "type": "vfo-profiles", "profiles": [ { "name": "…", "freqKhz": 14074.0, "mode": "FT8", "filterWidth": 500 }, … ] }
```
- Arrives right after `auth-ok`, and again after **any** change (your own edit
  echoed back, or a desktop-side edit).
- **Action:** replace your local list **wholesale** and re-render. Authoritative.

### Outbound — save / rename / delete / reorder (phone → desktop)
```json
{ "type": "vfo-profiles-update", "profiles": [ …ENTIRE list, in order… ] }
```
- Send after **every** create / rename / delete / reorder. Always the **whole**
  list, in the intended order.
- The desktop persists to `settings.json` and echoes `vfo-profiles` back to all
  surfaces (you included).

### Outbound — apply (phone → desktop)
```json
{ "type": "apply-vfo-profile", "profile": { "name": "…", "freqKhz": 14074.0, "mode": "FT8", "filterWidth": 500 } }
```
- On tap. The desktop tunes freq + mode and sets `filterWidth` (if present). It
  does **not** change the list.
- **Payload is the whole `profile` object, not an id.** The registry schema was
  corrected on 2026-07-15 from `{ id: f.string }` to `{ profile: f.object }` in
  both `lib/echocat-protocol.js` and the mobile mirror (see Status) — the old
  shape made the mobile `encode()` validator reject a valid apply.
- **Apply feedback comes through the normal freq/mode status stream** — your VFO
  readout/dial updates from the usual radio-status push. No special ack to handle.
  (Caveat: if the rig is disconnected the desktop no-ops silently — the phone
  projects the freq optimistically on tap so the readout still moves.)

---

## UX requirements (parity with the desktop popout)

1. **List** each profile: name + a detail line like `14.074 MHz FT8 BW:500`.
2. **Create:** name field + Save → snapshot the **current** VFO
   (`freqKhz` / `mode` / `filterWidth`) into a new profile, append, push the list.
   (See `renderer/remote.js` save handler ~10843.)
3. **Rename:** inline edit; commit on done, cancel on dismiss; push on change.
4. **Delete:** remove + push.
5. **Reorder:** the phone ships **up/down arrows** (the app's existing reorder
   idiom; drag would need a new native module and break OTA — see Status). Either
   way, persist by pushing the reordered list — **order rides in the array**, so
   the desktop side is identical regardless of the phone's reorder gesture.
6. **Apply (tap the row):** send `apply-vfo-profile`; give haptic/visual feedback.
   **Suppress apply while a row is in edit mode** (so an accidental tap during a
   rename doesn't tune).
7. **Empty state:** "No profiles. Tune somewhere, name it, tap Save."

---

## Edge cases / gotchas

- **Precision:** keep **sub-kHz** frequency. Snapshot as
  `round(currentFreqHz) / 1000` (whole Hz → kHz), **not** `round(freqHz/1000)`
  (integer kHz), which would destroy CW/digital dial offsets. The desktop popout
  and the web reference client both now do this correctly, so you can copy the
  reference flow as-is.
- **`filterWidth` 0:** store `undefined`, not `0` (a 0-Hz filter would mute RX on
  apply). Only set it when the rig has actually reported a width > 0.
- **Echo while editing:** right after you push, the desktop echoes the list back.
  Don't let that inbound replace **stomp an input the user still has open** —
  commit/finish the in-flight edit first, or ignore inbound refreshes while an
  edit field is focused, then reconcile.
- **Single active client:** ECHOCAT serves **one** remote client at a time; the
  desktop popout stays in sync via IPC regardless. You don't need multi-client
  logic.
- **Layout stays device-local** (unchanged from `docs/mobile-handoff-vfo-layout.md`):
  the Profiles component's show/hide/position is **phone-local**; only the profile
  **content** syncs. Never route profile layout through a synced settings path.
- **Unknown fields = opaque passthrough.** There are no stable ids today (identity
  is list position, which is fine because every op sends the whole list). If the
  desktop later adds `id`/`updatedAt`, **don't drop fields you don't recognize** —
  echo them back untouched so you stay forward-compatible.

---

## Acceptance

- Create on phone → shows on desktop popout **and** persists (survives a desktop
  restart).
- Rename / delete / reorder on phone → reflected on desktop within ~1 s.
- Edit on the desktop popout → reflected on phone within ~1 s.
- Tap → rig tunes to the **exact** freq (sub-kHz), mode, and filter.
- Round-trip preserves **all** fields, including sub-kHz `freqKhz` and `filterWidth`.

---

## Desktop references

- Contract + persistence: `main.js` `on('vfo-profiles-update')` (~11004),
  `on('apply-vfo-profile')` (~11022), `auth-ok` push (~10701), settings re-push
  (~24733).
- Transport: `lib/remote-server.js` `sendVfoProfiles()` (~3517), message parse
  (~2918).
- **Reference client (copy the flow):** `renderer/remote.js` ~10729–10878.
- Desktop popout UX incl. drag-reorder: `renderer/vfo-popout.html` ~1249–1439.
- Protocol doc: `docs/echocat-protocol.md` (`vfo-profiles` / `vfo-profiles-update`
  / `apply-vfo-profile` rows).
- Prior VFO handoff (layout is device-local; profiles = content, synced):
  `docs/mobile-handoff-vfo-layout.md`.
