# Events System Roadmap

Approved by Casey 2026-07-09 ("Yes" to the six-point proposal). Context: the
13 Colonies week exposed the seams — event stamping and boundary-tick
retirement landed the same week (188d83c, ab53d14); this roadmap is the rest.

## Current state (2026-07-09)

- **Events**: server-fetched `https://potacat.com/events/active.json` (4 h,
  silent-fail) + builtin fallback + cache. Boards: `checklist` (13 Colonies),
  `regions` (WAS-style), `counter`. Per-event opt-in, banner w/ snooze, event
  watchlist overlay, JTCAT decode badges (needed/new-slot/worked), progress
  marking (`checkEventQso`) + day-granular log re-scan (`scanLogForEvents`),
  identity-proven log stamping (`matchEventQsoForStamp` →
  `APP_POTACAT_EVENT`/`_ITEM` + comment tag), schedule-boundary ticks
  (renderer 1-min presentation, main 5-min ECHOCAT blob).
- **Contests**: separate `data/contests.json` (14 categories, What's-Next
  buckets) + contest-history blob (per-contest per-year heuristic log scan,
  contract with mobile). **Two different 13 Colonies definitions exist across
  the two systems.**

## Execution order

Ship order chosen so users feel each step: 5 → 4 → 2 → 3 → 6, with 1 as the
standalone project gating any NEW contest modes.

### 5. Fetch reliability + provenance keying (afternoon) — FIRST
- Surface refetch failure: one cat-log warning when every fetch has failed
  for >24 h; "events data as of <time>" staleness note in the Events UI.
- Contest-history: key on `APP_POTACAT_EVENT` when present; date-window
  heuristics remain the fallback for pre-stamp history. Tallies become exact.
- **Server-side (potacat.com, separate deploy)**: ETag/If-Modified-Since on
  active.json; keep ended events listed ~14 days so late log scans and
  retro-stamping still have definitions.

### 4. FT8 event-aware behavior (afternoon)
- JTCAT popout **Event filter** button (Chase-style): show only decodes whose
  event badge says needed/new-slot.
- Auto-CQ responder prefers event-needed callers when choosing whom to
  answer (extra sort key in candidate selection; SNR remains the tiebreak).

### 2. Post-event lifecycle (with #3, a day or two — land right after an event ends)
- Schedule end → board enters **finished** state: header summary ("12 of 13
  colonies + 1 bonus, 9 on FT8" — mode/band breakdown from stamps/progress
  meta), surfaced actions: the existing per-event ADIF export + the event's
  cert/QSL link (`ev.links.results` — needs schema field, see server notes).
- After N days (default 14) finished events collapse into a "Past events"
  section. `activeEvents` still never pruned client-side.

### 3. Retroactive stamping — explicit, never automatic
- Per-event button: "Stamp <N> matching past QSOs" — N computed with the
  same identity predicates (`matchChecklistItem`/`matchRegionPatterns`) +
  `qsoDayInScheduleEntry` day windows used by the re-scan.
- Rewrites matched records (eventId/eventName/eventItem + APP fields +
  comment tag via the log-comment authority; strip-before-append so re-runs
  are idempotent). Counter boards excluded, same as live stamping.
- Log rewrite goes through the existing record-update path (uuid-keyed), one
  undo-friendly pass, with a summary toast ("Stamped 11 QSOs").

### 6. Mobile parity (work item, potacat-meta)
- Event-stroke watchlist extension (previously awaiting go — GO given with
  this roadmap), finished-state board rendering, stamped-event display in
  the phone log view, catalog boundary-refresh already shipped (ab53d14).

### 1. Unified Events/Contests registry (multi-day project — the structural fix)

**Phase A — SHIPPED 2026-07-09**: `lib/event-registry.js` — alias resolution
(event `contestId` field → builtin map, year-suffix tolerant),
`buildEventAliasMap`, `unifiedCatalog()` merge with `supersededBy` marking,
`kind` mapping (checklist→special-event, regions→award-window,
counter→contest-window; contests category passes through). First consumer
live: contest-history resolves event-id stamps through the alias map, using
UNCAPPED provenance windows (umbrella contests like 13 Colonies' 159 h are
heuristic-excluded by MAX_WINDOW_HOURS but a stamp is proof) — a QSO stamped
`13col-2026` now attributes exactly to the `13-colonies` history. 21 tests,
CI-wired.

**Phase B (client side) — SHIPPED 2026-07-09**:
- Contests view: superseded rows (13 Colonies) render as ONE connected
  entry — a "◉ Tracked — 8/13 worked" chip (or "◎ Event available") that
  jumps to the live event board instead of the static drawer. `get-contests`
  carries `kind` + `supersededBy`/`eventTracked`/`eventProgress`/`eventTotal`.
- `kind` + `contestId` ride the renderer events payload AND the ECHOCAT
  catalog (additive) — the phone can link an event board to its
  contestHistory tally.
- Stamping writes a REAL ADIF `CONTEST_ID` when the stamped event aliases
  to a catalog entry with a curated `adifContestId` (never invented —
  13 Colonies gets none; ARRL-FIELD-DAY / CQ-WW-SSB / CQ-WW-CW curated,
  the FD value matching what JTCAT FD mode already writes). Contest modes
  that set CONTEST_ID themselves always win.

**Phase C — remaining (server + data)**:
- potacat.com events carry `contestId` natively (retire BUILTIN_ALIASES)
  + `schemaVersion`; ETag + ~14-day ended-event retention on active.json.
- Curate `adifContestId` across the contests catalog where the ADIF
  Contest_ID vocabulary genuinely covers the entry (verify each against the
  spec — never guess).
- Optional: contests.json entries gain explicit `kind` tags (today computed
  from `category` via kindForContest — adequate).
- **Gate**: unified definitions BEFORE building new WSJT-X contest modes
  (FT Roundup / WW Digi from docs/jtcat-wsjtx-gap-plan.md).

## Design invariants (carry forward)
- Stamping is identity-proven only; counter/date-window presence never
  stamps. `CONTEST_ID` only from real contest modes.
- Presentation retires on schedule boundaries; definitions/progress are
  never pruned client-side.
- All matching predicates live in lib/event-progress.js — one source for
  marking, stamping, re-scan, and retro-stamp.
