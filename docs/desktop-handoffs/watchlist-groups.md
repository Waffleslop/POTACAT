# Watchlist Groups — Mobile Handoff

**Desktop ref:** commit `17fa320` (master) on `D:\Projects\potacat-dev`.
**Mobile repo:** `D:\Projects\potacat-app`.

## What shipped on desktop

Three independent **color-coded watchlist groups** that decorate the callsign in
the spot table. Separate from the existing single `watchlist` setting (which
remains the only thing that triggers desktop notifications + the ⭐ badge).

Defaults — all three user-overridable via a color picker per group:

| Group | Default name | Default color |
|---|---|---|
| 0 | _(empty — user types e.g. "My Club")_ | `#ff7066` Coral |
| 1 | _(empty — user types e.g. "CW Group")_ | `#82b1ff` Sky |
| 2 | _(empty — user types e.g. "Discord")_ | `#b388ff` Lavender |

Decoration on desktop: a 2 px outline around the callsign cell with a 12%
background tint of the group's color. Outline lives inside the cell
(`outline-offset: -2px`) so the table grid stays unbroken and the existing
source-color left-border on the row stays visible. Cat-paw / donor badges sit
alongside, unchanged.

## Settings shape (the contract)

The desktop persists the groups under a new top-level settings key. Mobile sees
this on the next settings push exactly as written:

```ts
type WatchlistGroup = {
  name: string;        // user-visible, 0-40 chars, may be empty
  color: string;       // '#rrggbb', validated by the desktop on save
  callsigns: string;   // free-form text the user typed/imported.
                       // Separators: comma / whitespace / newline.
                       // Items may have legacy ':band:mode' qualifiers
                       // (from the original watchlist syntax) — ignore
                       // them in groups; group match is callsign-only.
};

type Settings = {
  // … existing fields …
  watchlist: string;                     // legacy single watchlist (unchanged)
  watchlistGroups?: [
    WatchlistGroup,
    WatchlistGroup,
    WatchlistGroup,
  ];
};
```

Always-three: when present the array is exactly length 3 (indices 0/1/2). When
absent (older desktops, or a user who never opened Settings), mobile should
treat it as the three defaults above with empty `name` and empty `callsigns`.

The desktop validates `color` against `/^#[0-9a-f]{6}$/i` before saving — if a
malformed value somehow reaches mobile, fall back to the defaults per index.

## What mobile needs to build

1. **Parse + lookup helper.** Mobile should build the same
   `Map<UPPERCASE_CALL, groupIdx>` once when the settings push lands, and rebuild
   when settings change. The desktop's parser logic (port verbatim):

   ```ts
   function parseCallsignList(str: string): string[] {
     if (!str) return [];
     return str
       .split(/[\s,;]+/)
       .map(s => s.split(':')[0].trim().toUpperCase())
       .filter(s => s.length > 0);
   }

   function buildLookup(groups: WatchlistGroup[]): Map<string, number> {
     const out = new Map<string, number>();
     for (let i = 0; i < groups.length; i++) {
       for (const call of parseCallsignList(groups[i].callsigns)) {
         if (!out.has(call)) out.set(call, i);   // first-match-wins
       }
     }
     return out;
   }
   ```

   First-match-wins matches desktop behavior — important so a call in multiple
   groups picks the same color on both surfaces.

2. **Apply to the spot row.** Wherever the spot table / list renders an
   activator's callsign, look up the group index. If `>= 0`:

   - Wrap the callsign (or its container view) in a colored 2 px border with
     the group's color.
   - Add a faint tint of the same color (≈ 12% alpha) as the background.
   - Set an accessibility label / long-press tooltip showing the group's
     `name` if non-empty (e.g. "Watchlist: My Club"). Empty name → still
     decorate, just no tooltip.

3. **Settings screen — UI parity.** Add three editors mirroring the desktop:

   - Name input (text).
   - Color picker (native iOS / Android color picker is fine — desktop uses
     `<input type="color">`).
   - Multi-line text area for callsigns. Accept comma / whitespace / newline.
   - **Import CSV** button using `expo-document-picker` (or platform
     equivalent). Read the file as text, take the first column of each row,
     validate each candidate against `/^[A-Z0-9\/]{3,15}$/i`, dedup against the
     existing list, and merge — don't replace. Tolerate quoted CSV fields and
     CRLF line endings. The desktop's algorithm:

     ```ts
     const calls: string[] = [];
     for (const row of text.split(/\r?\n/)) {
       if (!row.trim()) continue;
       let first = row.includes(',') ? row.split(',')[0] : row;
       first = first.replace(/^["\s]+|["\s]+$/g, '');
       if (first && /^[A-Z0-9\/]{3,15}$/i.test(first)) {
         calls.push(first.toUpperCase());
       }
     }
     ```

   - **Clear** button — wipes the textarea (user still has to Save).

   - **Save** flow — write the three groups back through the existing settings
     save pipe (the same one that owns `myCallsign`, `watchlist`, etc.) as
     `watchlistGroups`. Desktop merges via `{...settings, ...newSettings}`, so
     mobile partial saves are safe.

4. **Live color updates.** When the user drags the color picker, update the
   in-app CSS / style variable immediately so the spot list re-tints without
   waiting for Save. Match desktop UX (the color picker fires on every drag).

## What mobile should NOT do

- **Don't push notifications for group matches.** Notifications stay on the
  legacy `watchlist` setting only (already in place). The groups are a purely
  visual signal; promoting them to push would invert user expectations.
- **Don't trigger sounds / haptics on group match.** Same reason.
- **Don't decorate the entire row.** Decorate the callsign cell or callsign
  text only. The row-level decoration is reserved for the spot source (POTA /
  SOTA / DXC / RBN / etc.). Group + source are independent signals; both
  should be readable simultaneously.

## Versioning

- `watchlistGroups` ships in desktop v1.7.5 (next tagged release after
  `5f7dbe0`). Until users have v1.7.5 installed, mobile won't see this key in
  settings pushes — treat its absence as "no groups configured" and fall back
  to defaults.
- The shape is intentionally future-proof: if we add a 4th group later, the
  array length changes but the per-element schema doesn't. Mobile should
  iterate over `watchlistGroups.length` rather than hard-coding 3.

## Test checklist

- [ ] Decorated callsign visible on spot list AND map / cluster popups (if the
      map uses popups with callsigns).
- [ ] Multiple groups configured — distinct outline colors render per call.
- [ ] Call in two groups — picks the lower-indexed group (matches desktop).
- [ ] CSV import dedups against existing callsigns in the same group.
- [ ] Color picker update re-tints the visible spot list without app reload.
- [ ] Group name shows up as the accessibility label / long-press tooltip.
- [ ] `watchlistGroups` survives a settings round-trip (desktop save → mobile
      read → mobile save → desktop read) with no data loss.
