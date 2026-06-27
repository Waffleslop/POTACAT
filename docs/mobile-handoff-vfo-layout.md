# Mobile Handoff — VFO layout is device-local; content syncs

**Audience:** ECHOCAT mobile (iOS / Android) team
**Design decision (K3SBP 2026-06-27):** the VFO popout/screen **layout is per-device** — each device keeps its own component **visibility** and **order**. Operators want a different arrangement on the desktop vs the phone, so layout must **NOT** sync. **Content** (VFO profiles, CW macros, voice macros, …) **does** sync, exactly as today.

> Correction to the prior version of this doc: it claimed `vfoSections`/`vfoWidgets` ride the synced settings object. **They do not.** The desktop→phone settings payload (`updateRemoteSettings`, main.js) is an explicit **allowlist**, and the VFO layout keys are deliberately absent — so layout is already device-local. Build the phone's layout the same way: **local to the phone**.

---

## TL;DR

- **Layout = device-local.** The phone stores its own VFO component show/hide state and drag-reorder order in **phone-local storage**. Do not read or write the desktop's layout, and don't put layout in anything that syncs.
- **Content = synced**, each via its own existing channel (profiles, CW macros, voice macros). Unchanged.
- Both desktop and phone offer the **same UX** — toggle each component on/off, drag to reorder — but each keeps its own result.

---

## What syncs vs what doesn't

| Thing | Syncs desktop↔phone? | Channel |
|---|---|---|
| VFO **component visibility** (show/hide each part, incl. the VFO knob) | ❌ device-local | phone-local storage only |
| VFO **component order** (drag-reorder) | ❌ device-local | phone-local storage only |
| **VFO Profiles** (presets) + their order | ✅ yes | `vfo-profiles-update` (phone→desktop), `sendVfoProfiles` (desktop→phone) |
| **CW macros** | ✅ yes | `save-cw-macros` (phone→desktop); `remoteCwMacros` in the settings payload (desktop→phone) |
| **Voice macros** | ✅ yes | `voice-macro-sync` |

The desktop's settings allowlist (`updateRemoteSettings`, main.js ~8230) is the source of truth for "what the phone receives." Layout keys are intentionally not in it.

---

## 1. Component visibility (show/hide) — the contract to mirror

On the desktop these are the toggle-able components and their default on/off state. Build the phone's "Customize" panel with the same set so the two feel consistent (but each device persists its own choices locally):

**Core sections** (default ON):

| id | Label | Default |
|---|---|---|
| `dial` | **VFO Knob** | on |
| `solar` | Solar (SFI/K/A) | on |
| `step` | Tuning step | on |
| `band` | Quick Band | on |
| `filter` | Filter Buttons | on |
| `filter-slider` | Filter Slider | on |
| `controls` | Controls (rig DSP) | on |
| `profiles-inline` | Inline Profiles list | off |

**Optional widgets** (default OFF):

| id | Label | Default |
|---|---|---|
| `smeter` | S-meter / SWR | off |
| `ptt` | PTT | off |
| `log` | LOG | off |
| `bearing` | Beam Heading | off |
| `cw` | CW Macros | off |
| `cw-controls` | CW Speed / Text Input | off |
| `voice` | Voice Macros | off |

Store the phone's choices as a local `{ id: bool }` map (or however the RN app persists local prefs). Missing id ⇒ use the default above.

## 2. Drag-to-reorder (device-local)

Let the user drag components into their preferred order; persist the order as a **local** array of ids (e.g. `vfoLayoutOrder`). Apply it on load by laying out components in that order; append any unknown/new id at the end in its default position (forward-compatible as components are added). **Do not** send this order anywhere — it stays on the phone. (Desktop does the same with its own copy.)

## 3. Content sync — unchanged, keep as-is

- **VFO Profiles:** ordered array `settings.vfoProfiles`; reorder = mutate the array. Two-way: phone sends `{ type:'vfo-profiles-update', profiles:[...] }`; desktop persists, echoes back via `sendVfoProfiles`. Treat the desktop's pushed array as authoritative. (Profiles *content/order* is shared on purpose — it's data, not layout.)
- **CW macros:** `save-cw-macros` up; `remoteCwMacros` in the settings payload down.
- **Voice macros:** `voice-macro-sync`.

---

## Mobile work requested

1. **Customize panel** with a toggle per component (ids/labels above), grouped Sections / Widgets, defaults applied.
2. **Drag-to-reorder** the components; persist visibility + order **locally on the phone only**.
3. **Do not** route layout (visibility or order) through any synced settings path — it must stay device-local.
4. Keep **profiles / CW macros / voice macros** syncing through their existing channels (no change).

## Desktop references

- Settings allowlist sent to the phone (proof layout isn't synced): `main.js` `updateRemoteSettings()` (~8227–8307).
- Desktop layout state (device-local): `renderer/vfo-popout.html` — `vfoSections` / `applySections()`, `vfoWidgets` / `applyWidgets()`, persisted via `saveSettings({ vfoWidgets, vfoSections, vfoHiddenBands })` into the desktop's own `settings.json` (never forwarded to the phone). Desktop drag-reorder (`vfoLayoutOrder`) lands here too.
- Profile sync: `main.js` `remoteServer.on('vfo-profiles-update')` (~9884), `sendVfoProfiles()`.
