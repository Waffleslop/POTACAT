# Mobile Handoff — VFO screen: one scrollable, customizable page

**Audience:** ECHOCAT mobile (iOS / Android) team
**Scope:** **Mobile only.** The desktop VFO popout stays exactly as it is (a tabbed layout). Mobile is intentionally different — do **not** try to match the desktop's tabs.
**Design (K3SBP 2026-06-27):** the mobile VFO screen should be **one vertically-scrollable page** containing **all** the VFO components, where the user can **show/hide** each component and **drag to reorder** them. The arrangement is **device-local** (the phone keeps its own; it does not sync to/from the desktop).

---

## TL;DR

- **One scrollable screen.** No tabs, no separate "dial-only" view. Every component stacks in a single vertical scroll. (On desktop the dial historically hogged the space and the rest wasn't reachable — avoid that on mobile by making the whole thing one scroll with a sensibly-sized dial.)
- **Show/hide** each component (a "Customize" panel with a toggle per component).
- **Drag to reorder** components into the user's preferred order.
- **Layout = device-local.** Persist visibility + order in **phone-local storage only**. Never sync it — operators want different arrangements on phone vs desktop.
- **Content still syncs** (profiles, CW macros, voice macros) via the existing channels — unchanged.

---

## The components (single flat set on mobile)

These are every component the VFO offers. On the desktop they're split across tabs/zones, but on **mobile they're one flat list** the user shows/hides and reorders. The "Default" column is the suggested initial on/off (mirrors desktop defaults) — core operating bits on, optional extras off.

| Component | What it is | Default |
|---|---|---|
| `dial` | The VFO tuning knob/dial (one canvas) | on |
| `freq` | Frequency + mode readout (tap to type a freq) | on (pin near top) |
| `op-info` | Operator / spot info (call, park, photo) | on |
| `solar` | Solar indices (SFI / K / A) | on |
| `step` | Tuning step selector | on |
| `band` | Quick Band buttons | on |
| `filter` | Filter preset buttons | on |
| `filter-slider` | Filter bandwidth slider | on |
| `controls` | Rig DSP controls (NB/NR/ANF/AGC/etc.) | on |
| `keypad` | Numeric frequency entry | on (or on-demand via the freq readout) |
| `profiles` | Saved VFO presets list | on |
| `smeter` | S-meter / SWR | off |
| `ptt` | PTT (+ TX EQ) | off |
| `bearing` | Beam heading to the spot | off |
| `cw` | CW macros | off |
| `cw-controls` | CW speed / text input | off |
| `voice` | Voice macros | off |

> `freq` and `keypad` are tightly related — on desktop, tapping the frequency readout opens the keypad. On mobile, either keep the keypad as its own scroll section or surface it on-tap of the freq readout; your call, just don't make it a separate full-screen tab.

## Show / hide + reorder (device-local)

- Persist two things locally on the phone: a **visibility map** `{ componentId: bool }` and an **order array** `[componentId, …]`.
- Apply on load: render visible components in the saved order; append any new/unknown id at the end in its default position (forward-compatible as components are added).
- **Do not** route either through any synced settings path. The desktop's settings payload (`updateRemoteSettings`) is an allowlist that already excludes VFO layout, so layout never crosses the wire — keep it that way on the phone.

## What DOES sync (unchanged — keep as-is)

| Thing | Channel |
|---|---|
| **VFO Profiles** (presets + their order) | `vfo-profiles-update` (phone→desktop), `sendVfoProfiles` (desktop→phone) |
| **CW macros** | `save-cw-macros` (phone→desktop); `remoteCwMacros` in the settings payload (desktop→phone) |
| **Voice macros** | `voice-macro-sync` |

These are **content/data**, shared on purpose. Only **layout** (which components show, and their order) is device-local.

---

## Mobile work requested

1. Build the VFO as **one scrollable page** with all components stacked; size the dial so it doesn't dominate and the rest is reachable by scrolling.
2. Add a **Customize** panel: a toggle per component (ids/labels above; defaults applied).
3. Add **drag-to-reorder** of the visible components; persist visibility + order **locally on the phone**.
4. **Never sync layout** (visibility or order). Keep profiles / CW macros / voice macros syncing through their existing channels.

## Desktop references (for the component set + sync contracts only — do not mirror the desktop layout)

- Component set + default on/off: `renderer/vfo-popout.html` — `vfoSections` (core, default on) and `vfoWidgets` (optional, default off).
- Proof layout isn't synced: `main.js` `updateRemoteSettings()` (~8227) is an allowlist with no VFO-layout keys.
- Profile sync: `main.js` `remoteServer.on('vfo-profiles-update')` (~9884), `sendVfoProfiles()`.
