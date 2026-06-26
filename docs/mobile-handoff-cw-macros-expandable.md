# Mobile Handoff — expandable CW macros (1–25, like voice macros)

**Audience:** ECHOCAT mobile (iOS) team
**Desktop status:** shipped. Desktop now lets the operator add/remove CW macros up to 25 (was a fixed 5), using the same `+ Add` / `− Remove last` / `N / 25` UI as voice macros.
**Protocol:** **unchanged.** `remoteCwMacros` was already a variable-length array and `save-cw-macros` already accepts any length — so there is **no desktop-side work** and nothing to coordinate on the wire. This handoff is purely "let the phone show/edit more than 5."

---

## TL;DR

The desktop CW macro list used to be a hardcoded 5 (`CQ / 599 / 73 / AGN / TU`).
It's now a user-addable list of **1–25** macros. If the mobile CW macro editor
hard-caps at 5 (or renders a fixed 5 rows), it will **silently drop macros 6–25**
that the operator created on the desktop, and won't let the phone add more.

Update the mobile CW macro editor to render **however many macros arrive** and to
**add/remove up to 25** — mirroring the voice-macro editor that already exists on
mobile. No protocol changes.

---

## What changed on desktop (for context)

- `renderer/app.js`:
  - `CW_MACRO_MAX = 25`, `CW_MACRO_DEFAULT_SLOTS = 5`.
  - Visible row count stored in `localStorage['pota-cat-cw-macro-slots']` (machine-global, same pattern as `pota-cat-voice-macro-slots`).
  - `renderCwMacroEditor()` now draws `slots` rows + a footer with **`+ Add macro`**, **`− Remove last`** (only when the last row is empty), and an **`N / 25`** counter. Never shows fewer rows than there are populated macros.
  - `readCwMacroEditor()` reads all rows → `settings.cwMacros` on Settings Save.
- Runtime macro bar `updateCwMacroBar()` **skips any macro with no label and no text** — empty slots never become buttons. (This was already true; keep the same rule on mobile.)
- Per-macro shape is unchanged: `{ label: string, text: string }`. `label` is the button caption, ≤ 6 chars; `text` is the CW to send.

---

## Protocol (all unchanged — reference only)

### Desktop → phone (auth-ok handshake)
```jsonc
{
  // …other fields…
  "remoteCwMacros": [ { "label": "CQ", "text": "CQ CQ CQ DE {MYCALL} {MYCALL} K" }, … ]
  // now up to 25 entries (was up to 5). May be null if none configured.
}
```
- Source on desktop: `settings.remoteCwMacros || settings.cwMacros || null`
  (main.js ~8274). Phone-edited macros (`remoteCwMacros`) win; otherwise it falls
  back to the desktop's own `cwMacros`. **Render the full array length you receive.**

### Phone → desktop (save edits)
```jsonc
{ "type": "save-cw-macros", "macros": [ { "label": "…", "text": "…" }, … ] }
```
- Desktop handler (main.js ~11396) stores it to `settings.remoteCwMacros`, persists,
  and re-pushes to all connected clients. **Already accepts variable length** — send
  the whole list (1–25). Don't trim to 5.

### Phone → desktop (key a macro / cancel)
```jsonc
{ "type": "cw-text", "text": "<RAW macro text, e.g. '{call} UR 599 {state} BK'>" }
{ "type": "cw-cancel-text" }
```
- Send the **raw** macro `text` (with `{…}` variables intact). The desktop expands
  variables and keys the rig via whatever CW backend is active (Flex CW / WinKeyer /
  DTR / CAT). **Do not expand on the phone** — the desktop has the tuned-spot context.

### Variables (expanded desktop-side)
`{MYCALL}` · `{call}` (tuned spot callsign) · `{op_firstname}` · `{state}`

---

## Mobile work requested

1. **Remove the 5-macro cap** in the CW macro editor. Allow 1–25 with `+ Add` /
   `− Remove last` (reuse the voice-macro editor's slot logic; an `N / 25` counter
   is a nice-to-have for parity).
2. **Render the full `remoteCwMacros` array** received in auth-ok (could be > 5).
   **Skip empties** (no `label` and no `text`) so they don't become blank buttons.
3. **On save**, send the entire variable-length array via `save-cw-macros`.
4. **Keep `{label, text}` shape and the variable tokens** exactly as above; keep
   sending raw `text` on `cw-text`.

No desktop or protocol change is needed — the desktop is already emitting and
accepting variable-length CW macro lists.

---

## Desktop references

- UI / slot model: `renderer/app.js` → `renderCwMacroEditor()`, `loadCwMacroSlots()`,
  `saveCwMacroSlots()`, `readCwMacroEditor()`, `updateCwMacroBar()`.
- Handshake field: `main.js` ~8274 (`remoteCwMacros`).
- Save handler: `main.js` ~11396 (`save-cw-macros`).
- Key/cancel: `main.js` ~9875 (`cw-text`), ~9871 (`cw-cancel-text`).
- Voice-macro editor to mirror (already 1–25 on desktop): `renderer/app.js`
  `renderVoiceMacroEditor()`, `VOICE_MACRO_MAX = 25`.
