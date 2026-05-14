# PSK31 + RTTY mode parity for the iOS app

Status: shipped
Filed: 2026-05-06
Shipped: 2026-05-06
Repo for changes: D:\Projects\potacat-app

## Context

The desktop POTACAT (this repo, master at v1.5.16+) just added first-class support for PSK31 and RTTY across the spot table, mode filters, log sheet, and rig tune mappings. The iOS app needs the same modes to be filterable, displayable in spot rows, selectable when logging, and not fall through to an "Other" bucket. RTTY was partially supported already; PSK31 is fully new.

## What the desktop now sends

- **Spots over WebSocket** can carry `mode: "PSK31"` or `mode: "RTTY"` from any source — POTA / SOTA / WWFF / LLOTA APIs, PSKReporter, RBN, DX cluster (now infers `PSK31` from comment text). Pass-through; no protocol change.
- **`log-qso` reply**: when the user logs a QSO via `LogQuickSheet`, the desktop accepts the mode field as-is. Already works for any string. The desktop's QSO-list `all-qsos` push (which the app already subscribes to) will include PSK31/RTTY entries naturally.
- **Pairing tokens / cert / WebRTC**: unchanged.

## What needs to change in the iOS app

Investigate `D:\Projects\potacat-app\src` and add PSK31/RTTY at these surfaces. RTTY may already be in some of them — check before adding.

### 1. Spot row display

Wherever a spot's `mode` field is rendered, make sure `"PSK31"` and `"RTTY"` render as-is. They probably already do; verify no "unknown mode" handling drops them.

### 2. Mode filter UI

Find the spot-table filter component (likely in `src/components/` or `src/screens/SpotsScreen.tsx`). Wherever there's a list of mode options like `['CW', 'SSB', 'FT8', 'FT4', 'FM', 'RTTY']`, add `'PSK31'`. If RTTY is missing too, add both. Multi-select pattern should match the desktop's mode multi-dropdown.

### 3. Log sheet — `src/components/LogQuickSheet.tsx`

The mode picker in the modal. Add PSK31 option to the dropdown/picker. If there's a `defaultRst(mode)` helper similar to the desktop's, treat PSK31 (and bare `'PSK'`) as a 599-style mode:

```ts
if (m === 'CW' || m === 'FT8' || m === 'FT4' || m === 'FT2' || m === 'RTTY' || m === 'PSK31' || m === 'PSK') return '599';
```

Look for `defaultRst` or similar in `LogQuickSheet.tsx` near the `useState('59')` for `rstSent` / `rstRcvd`.

### 4. Mode classification set

If there's a `KNOWN_MODES` or `DIGITAL_MODES` set (probably in `src/state/spots.ts` or `src/utils/modes.ts` if that exists), add PSK31 there so it's not bucketed as "Other" / unknown.

### 5. Mode picker for setting the rig's mode

If there's a touchscreen mode pad like the desktop's (USB / LSB / CW / FT8 / FT4 / FM / AM / RTTY / RADE), add a PSK31 button. Tapping it sends `set-mode` (or whichever) over the WebSocket; the desktop's rig-utils now translates `PSK31` → USB+DATA / PKTUSB / Icom 0x01 correctly per backend.

### 6. N-fer / ragchew screens

Anywhere there's a mode-aware UI, the same one-line addition.

## Test path

1. Connect iOS app to desktop running master.
2. Watch the spot table for a PSK31 spot from RBN (rare but happens) or PSKReporter Map. It should render with the mode visible. Filter by PSK31 → only PSK31 spots show.
3. Tap a PSK31 spot → desktop should tune to that frequency in USB+DATA mode (PKTUSB on Hamlib, MD9 on Flex). Verify the rig went to data mode.
4. Tap the L (log) button on a PSK31 spot → mode picker should default to PSK31, RST should pre-fill 599. Send → desktop logs it correctly into the ADIF.
5. Repeat for RTTY (which lives in the same digital sub-bands).

## Reference: desktop changes (commits on master)

Two commits, both small:

- `225a8b1` — PSK31 + RTTY support across spot table, filters, and rig tune
- `0912fb7` — ECHOCAT Web: PSK31 + RTTY parity with desktop

The desktop diff is ~25 lines across `lib/rig-utils.js`, `lib/dxcluster.js`, `renderer/index.html`, `renderer/spots-popout.html`, `renderer/remote.html`, `renderer/remote.js`. Grep those for `PSK31` to see the exact patterns and mirror them in TypeScript.

## Open question to confirm with the user

Is there a "Digital (all)" group filter that selects PSK31, RTTY, FT8, FT4, JS8 in one click? The desktop doesn't have it yet (deferred). If iOS users would benefit from a one-tap "all digital" mode filter, propose it.

## Resolution

Shipped iOS-side 2026-05-06. Four small edits:

- **`src/state/spotsFilters.ts`** — `ALL_MODES` now includes `'PSK31'` (RTTY was already there). Surfaces as a chip in the spot mode-filter UI.
- **`src/utils/spotsFilter.ts`** — `spotModeCategory()` now classifies `PSK31` and bare `PSK` as the `'PSK31'` bucket so spots aren't routed to "Other."
- **`src/components/LogQuickSheet.tsx`** — `defaultRst()` extended to recognize PSK / PSK31 / FT2 as 599-class modes (uses `.includes()` so any prefix variant works).
- **`src/screens/VfoScreen.tsx`** — rig mode picker (the MODE card) now lists `RTTY` and `PSK31` alongside the existing LSB/USB/CW/CW-R/AM/FM/DIGU/DIGL. Tapping sends `set-mode { mode: 'PSK31' }` verbatim; desktop's rig-utils translates per backend (PKTUSB / Icom 0x01 / Flex MD9 / Yaesu DATA-USB).

The spot tap path passes `spot.mode` through unchanged (`SpotsScreen.tsx` line 120 — `...(spot.mode ? { mode: spot.mode } : {})`), so a PSK31 spot tunes the rig to PSK31 with no extra change.

`utils/modes.ts` already had PSK31 and bare PSK in `isDigitalMode()` from earlier work; no edit needed.

**"Digital (all)" group filter — RESOLVED 2026-05-06.** Casey said "Add it." Done iOS-side:
- `DIGITAL_MODE_GROUP = ['FT8', 'FT4', 'RTTY', 'PSK31', 'JS8']` exported from `src/state/spotsFilters.ts`. CW omitted (Morse classification debate); FREEDV omitted (digitally-encoded voice, treated as voice elsewhere); SSTV omitted (image, separate workflow).
- `FilterDropdown` extended with a `presets` prop — array of `{ label, values }`. Tap toggles the preset's values into the current selection: if all already set, removes; else adds (preserves any other modes already chosen).
- `SpotsScreen` Mode dropdown now passes `presets={[{ label: 'Digital (all)', values: DIGITAL_MODE_GROUP }]}`.
- JS8 is now in `ALL_MODES` (was missing from spots filter; `PropScreen` already had it in its own list, no harm in unifying).
- `spotModeCategory()` now classifies `JS8` and `JS8CALL` as the `'JS8'` bucket.

UX: tap **Mode** filter pill → dropdown opens → "Digital (all)" preset chip at the top — tap to set FT8/FT4/RTTY/PSK31/JS8 in one action; tap again to clear them.

iOS testcheck: `npx tsc --noEmit` clean, all 28 protocol tests pass.
