# Mobile Handoff — VFO popout: show/hide components + sortable profiles

**Audience:** ECHOCAT mobile (iOS / Android) team
**Goal:** mirror the desktop VFO popout's customization on the phone — let the operator **show/hide each component** (e.g. the VFO knob) and **reorder** the sortable content, using the **same settings keys** so it stays in sync across desktop and phone.
**Desktop status:** implemented and shipped. This documents the existing contract; no desktop change required to mirror show/hide + profile sorting.

---

## TL;DR

The VFO popout's layout is driven by two **boolean maps** in the desktop settings object — one for always-available "sections" (on by default) and one for optional "widgets" (off by default). Each component is just an id → `true`/`false`. The only **reorderable** content today is the **VFO Profiles** list (drag-to-reorder, persisted as array order, fully two-way synced). Sections/widgets are show/hide only — they render in a fixed order (see "Reordering components" at the end for the future contract).

All of this lives in the desktop `settings` object the phone already receives in `auth-ok` (and on every `settings-update`), so the phone reads the same keys and writes them back to stay in sync.

---

## 1. Show / hide — `settings.vfoSections` (core sections, default ON)

Map of `sectionId → bool`. Desktop applies it by toggling `display` on `#sec-<id>` (and the keypad-tab mirror `#sec-<id>-kp`).

| id | Label (desktop checkbox) | Default |
|---|---|---|
| `dial` | **VFO Knob** | on |
| `solar` | Solar (SFI/K/A) | on |
| `step` | Tuning step buttons | on |
| `band` | Quick Band | on |
| `filter` | Filter Buttons | on |
| `filter-slider` | Filter Slider | on |
| `controls` | Controls (rig DSP buttons) | on |
| `profiles-inline` | Inline VFO Profiles list | **off** |

## 2. Show / hide — `settings.vfoWidgets` (optional add-ons, default OFF)

Map of `widgetId → bool`. Desktop applies it by toggling a `.visible` class on `#widget-<id>`.

| id | Label | Default |
|---|---|---|
| `smeter` | S-meter / SWR | off |
| `ptt` | PTT | off |
| `log` | LOG | off |
| `bearing` | Beam Heading (bearing to spot) | off |
| `cw` | CW Macros | off |
| `cw-controls` | CW Speed / Text Input | off |
| `voice` | Voice Macros | off |

> Merge semantics matter: the desktop does `vfoSections = { ...defaults, ...settings.vfoSections }` (same for widgets), so a missing key falls back to the default. Send/store only the keys you change if you like, but the safe move is to send the full map. Treat an **absent** map as "all defaults."

## 3. Persistence & sync

- Desktop persists with `window.api.saveSettings({ vfoWidgets, vfoSections, vfoHiddenBands })` → `settings.json`.
- These keys are part of the global `settings` object, so they're already in the **`auth-ok`** payload and every **`settings-update`** push the phone receives — i.e. a desktop-side change reaches the phone automatically.
- To change them **from the phone**, write them back through the same settings-save path the phone uses for other prefs (they land in `settings.vfoWidgets` / `settings.vfoSections`). There is no dedicated message for these two maps — they ride the generic settings sync.
- `settings.vfoHiddenBands` is a companion map for the Quick-Band grid (which band buttons to hide); same pattern if you mirror the band grid.

## 4. Sorting — the VFO Profiles list (the one reorderable thing)

VFO Profiles are an **ordered array**: `settings.vfoProfiles` (each entry is a saved freq/mode/filter/label preset). The array's order **is** the display order; reordering = mutating the array and persisting it. The desktop UI implements HTML5 drag-to-reorder (grab the ☰ handle, drag the row).

Two-way sync (dedicated messages, unlike the maps above):
- **Phone → desktop:** send `{ type: 'vfo-profiles-update', profiles: [...] }` with the full reordered array. Desktop saves it to `settings.vfoProfiles`, echoes it back to all clients, and live-refreshes its own popout (main.js `remoteServer.on('vfo-profiles-update')`).
- **Desktop → phone:** the desktop pushes the canonical list via `sendVfoProfiles(...)` on connect and after any change. Treat the received array order as authoritative and re-render.

So on the phone: render profiles in array order, support drag-to-reorder, and on drop send the whole new array via `vfo-profiles-update`. Add/delete/rename go through the same array + message.

---

## Mobile work requested

1. **A "Customize" panel** on the phone's VFO screen with a toggle per component, grouped as **Sections** (on by default) and **Widgets** (off by default), using the exact ids/labels above.
2. **Render each component's visibility** from `settings.vfoSections` / `settings.vfoWidgets` (defaults applied for missing keys). The **VFO Knob** is `vfoSections.dial`.
3. **Persist toggles** back into `settings.vfoSections` / `settings.vfoWidgets` via the phone's settings-save path, so a change on either device syncs to the other.
4. **VFO Profiles:** render in array order, support drag-to-reorder, and emit `vfo-profiles-update` with the full array on change; apply the desktop's pushed list as authoritative.

## Reordering the components themselves (future — NOT yet in the contract)

Today, sections and widgets are **show/hide only** and render in a fixed order; only the *profiles* list is sortable. If we want users to drag-reorder the components (e.g. move the S-meter above the knob), that needs a **new shared key** the desktop must implement first — proposed: `settings.vfoLayoutOrder` = an array of component ids in render order, with unknown/absent ids appended in their default order (forward-compatible as we add components). **Do not build phone-side component reordering against this yet** — it would diverge from the desktop. Flag it and we'll spec + ship it on both sides together.

## Desktop references

- Maps + apply: `renderer/vfo-popout.html` — `WIDGETS` / `vfoWidgets` / `applyWidgets()`, `SECTIONS` / `vfoSections` / `applySections()`, `loadWidgets()`, `saveWidgets()`.
- Customize checkboxes: `renderer/vfo-popout.html` ids `w-*` (widgets) and `s-*` (sections).
- Profiles + drag-reorder: `renderer/vfo-popout.html` (`profiles` array, `profileDragFrom`, `dragstart`/`dragover` handlers, `saveProfiles()`).
- Profile sync: `main.js` `remoteServer.on('vfo-profiles-update')` (~9884) and `remoteServer.sendVfoProfiles()`; popout refresh via `vfo-profiles-changed`.
