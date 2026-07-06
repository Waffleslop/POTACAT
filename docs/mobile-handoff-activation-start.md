# Mobile Handoff — Activation Start Screen

*2026-07-05 · For the potacat-app team. Parent plan: docs/activator-mode-plan.md.
Desktop Phase 0 (shipped on master alongside this doc) is the contract this
screen builds against.*

## Why this screen decides everything

This is the first thing an activator touches, and it's where PoLo currently
wins on muscle memory. It's also where N3VD hit "I tapped Start and nothing
happened" (BUG-N3VD-20260701-E442B8) — the current ActScreen is a fire-and-forget
stub. The replacement must never leave a tap unanswered.

The design brief from Casey: **elegant**. People activate from real POTA parks,
from their back garden, from non-POTA parks, from a Tiles on the Air grid
square, from a WWBOTA bunker — often several of those at once. The screen has
to make all of that feel like one simple question.

## The core design decision: location first, programs second

Do **not** open with "pick a program" (the current POTA/SOTA/Other segmented
control — that's the wrong question, and it's why multi-program activations
feel impossible today; N7BBQ's complaint). Open with **"Where are you?"** and
derive the programs from the answer.

The data model this produces:

```ts
interface ActivationDraft {
  name: string;              // human label, auto-composed, always editable
  location: {
    label: string;           // "Lake Superior SP", "Back Garden", "Miller's Field"
    lat?: number; lon?: number;
    grid?: string;           // Maidenhead, derived from lat/lon when present
  };
  refs: Array<{ program: 'POTA'|'SOTA'|'WWFF'|'LLOTA'|'WWBOTA'|'TILES'; ref: string; name?: string }>;
}
```

**Key insight: `refs` may be empty.** A back-garden session or a non-POTA park
outing is still an activation — a named logging session with a location. Don't
gate "Start" on having a program ref. This is what makes the screen cover
every persona instead of just POTA.

## Screen flow

```
┌──────────────────────────────────┐
│  New Activation                  │
│                                  │
│  WHERE ARE YOU?                  │
│  ┌────────────────────────────┐  │
│  │ 🔍 Search parks / refs…    │  │   ← search-parks over WS
│  └────────────────────────────┘  │
│                                  │
│  NEAR YOU                 📍 GPS │   ← nearby-parks over WS (NEW)
│  ▸ US-0512 Lake Superior SP      │
│      0.4 mi NE · POTA ✓ WWFF ✓   │   ← activated-before / worked badges
│  ▸ US-8721 Bluff Point Trail     │
│      0.9 mi N · POTA   [2fer? +] │   ← overlap nudge: tap + to add
│  ▸ B/US-0033 Ft. Meyer Bunker    │
│      3.1 mi SW · WWBOTA          │
│                                  │
│  ⌂ Home / Back Garden            │   ← no-ref session, grid from settings
│  ✎ Somewhere else…               │   ← freeform label (+ optional GPS pin)
│  ⟳ Same as last time             │   ← repeat previous setup, one tap
├──────────────────────────────────┤
│  US-0512 · Lake Superior SP      │   ← selection card (after a pick)
│  Programs: [POTA ✓] [WWFF ✓]     │   ← auto-suggested, toggleable
│            [TILES EN91ab +]      │   ← always offered when grid known
│  + Add another reference         │   ← n-fer / bunker / summit, search again
│                                  │
│  Name:  Lake Superior · Sat AM ✎ │   ← auto-composed, editable
│                                  │
│  ┌────────────────────────────┐  │
│  │       START ACTIVATION     │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

Design rules:

1. **One list, all programs mixed.** "Near you" interleaves POTA parks, WWFF
   refs, bunkers, summits — sorted by distance, each row badged with its
   program(s). The user picks a *place*, not a bureaucracy.
2. **Programs are chips on the selection, not a mode switch.** Picking
   US-0512 that is also KFF-0512 pre-checks both chips. TILES is always
   offered when we have a grid (the ref IS the grid square — compute it, never
   ask the user to type it). Unchecking a chip drops that program's records;
   nothing else changes.
3. **The three escape hatches are first-class, not buried**: Home/Back Garden
   (label defaults to "Back Garden", grid from the desktop QTH settings or
   phone GPS), Somewhere else (freeform label — covers non-POTA parks), and
   Same as last time (PoLo's operation-templates, the single highest-leverage
   convenience for regulars).
4. **Name auto-composes, never blocks.** `"<primary label> · <weekday> <AM/PM>"`
   (e.g. "Lake Superior · Sat AM", "Back Garden · Tue PM"). Tapping ✎ edits.
   Nobody should ever be forced to invent a name to proceed.
5. **Location fallback is explicit.** GPS denied/stale → show "using last
   known location" / "using home grid" inline, with a tap-to-retry. Never show
   an empty Near You list without saying why (PoLo's GPS flakiness is a known
   complaint — this is a flank we win on).
6. **Every tap answers.** Start shows a spinner on the button itself; success
   navigates forward; failure/timeout shows the reason inline. No silent
   returns (see wire contract below).

## Wire contract (what desktop already supports — shipped with this handoff)

- **`nearby-parks`** (C→S) `{ lat, lon, limit? }` → **`nearby-park-results`**
  (S→C) `{ results: [{ reference, name, latitude, longitude, distanceMi,
  bearingDeg, ... }] }`, nearest first, default 15. NEW — use it for the
  Near You list when a desktop is paired. (Currently POTA parks DB; other
  programs will merge into the same reply later — key rows by `reference`.)
- **`search-parks`** (C→S) `{ query }` → **`park-results`** (S→C). Existing.
- **`set-activator-park`** (C→S) `{ parkRefs: string[], sig?, activationType?,
  activationName? }` — still the start trigger. Desktop answers with an
  **`activator-state`** push `{ appMode, parkRefs: [{ref,name}], grid }`.
  **The ack pattern for the N3VD fix:** after sending, wait for the next
  `activator-state` whose `parkRefs` match what you sent (3 s timeout) →
  navigate to the activation screen; on timeout show "Desktop didn't
  respond — still paired?" with retry. Do not fire-and-forget.
- **`qso-delta` hello capability** (NEW): advertise it alongside
  `chunked-all-qsos`. Desktops from this commit push a single **`qso-added`**
  `{ data: <one record in all-qsos shape>, total }` after each save instead of
  re-sending the whole log. If `total` ≠ your local count + 1, resync with
  `get-all-qsos`. (Legacy desktops keep sending full snapshots; handle both.)
  Also note: the legacy single-frame `all-qsos` is now byte-capped at 256 KB
  desktop-side, so even build-59-era flows can't 1009 the socket anymore.
- **Known protocol gaps you will hit — design around them, asks filed in the
  parent plan (desktop Phase 1):**
  - No `stop-activation` message yet; the activation screen's QRT/stop button
    can be local-only for now (clear local state, leave desktop as-is) or
    hidden until Phase 1 lands.
  - `set-activator-park`'s `sig`/`activationType` are currently ignored by the
    desktop handler (it always sets POTA-style park refs). Send them anyway —
    correct data from day one, desktop catches up in Phase 1 with the
    `start-activation` message carrying the full `ActivationDraft`.

## Standalone mode (no desktop) — build it in from the start

Ron (N7BBQ) activates without a laptop. The screen must work identically when
`connectionManager` has no desktop:

- Near You: fall back to `https://api.pota.app` park search by location when
  online; cache the results per region for offline reuse (the parks-pack item
  in the parent plan, Phase 2 item 7).
- Start: create the activation session locally (persist the `ActivationDraft`
  + startedAt in AsyncStorage next to LocalQsoStore) instead of sending
  `set-activator-park`. QSOs go to LocalQsoStore + cloud sync exactly as
  LogQuickSheet already does — the infrastructure is shipped, this screen just
  needs to write the session record.
- The UI must not care which backend it got: give the activation screen a
  session interface, inject the WS-backed or local-backed implementation.

## What NOT to build on this screen

- No spot list, no VFO, no logging — this screen ends at Start.
- No per-program validation rules beyond "ref exists in search/nearby results
  or user confirmed a typed ref" (desktop now warns-not-blocks on unknown
  refs; mirror that posture).
- No scheduling/planning (PoLo has it; it's not what makes activations smooth;
  later).

## Acceptance checklist

- [ ] Tap Start with paired desktop → desktop flips to activator mode, phone
      navigates forward, park name visible. Never a silent no-op.
- [ ] Tap Start with desktop unreachable → clear inline error within 3 s.
- [ ] Tap Start with no desktop paired → local session starts (standalone).
- [ ] Back garden session with zero refs starts and logs.
- [ ] US park that is also WWFF starts with both chips on → desktop receives
      both refs (until Phase 1: primary POTA ref via parkRefs, others held
      client-side for ADIF at export).
- [ ] TILES chip shows the computed grid, not an input.
- [ ] GPS off → "using home grid" fallback labeled, Near You still populates.
- [ ] "Same as last time" restores the full previous draft in one tap.
- [ ] Hello advertises `qso-delta` + `chunked-all-qsos`; `qso-added` appends
      to the local snapshot; count mismatch triggers `get-all-qsos` resync.

---

## Mobile status (2026-07-05)

**Built and shipped OTA** — the ActScreen stub is replaced with the
location-first flow: search (WS `search-parks`), Near You (WS `nearby-parks`),
the three escape hatches (Back Garden / Somewhere else / Same as last time),
program chips with a computed TILES grid chip, auto-composed editable name,
and Start with the 3 s `activator-state` ack + inline error/retry (the N3VD
fix — zero silent no-ops). Zero-ref drafts and standalone starts run as local
sessions persisted next to LocalQsoStore. Hello now advertises `qso-delta`;
`qso-added` appends with count-mismatch resync.

Phase-0 deviations the desktop should know about:

- **Near You centers on the home grid, not GPS** — `expo-location` isn't in
  the mobile binary; it's queued for the next native build. The center source
  is labeled inline per design rule 5. `nearby-parks` gets grid-center
  lat/lon until then.
- **Zero-ref drafts never send `set-activator-park`** (nothing for the Phase-0
  handler to do with an empty parkRefs) — they run as local phone sessions
  even when paired. Phase 1's `start-activation` carrying the full
  ActivationDraft is where that unifies.
- **2fer auto-suggestion needs data mobile doesn't have** — nearby/search
  replies carry no cross-program overlap (US-xxxx that is also KFF-xxxx), so
  multi-program starts go through "+ Add another reference" manually. When the
  desktop merges other programs into `nearby-park-results`, badge rows will
  light up with no mobile protocol change (rows are keyed by `reference` and
  program is inferred from ref shape).
- **Standalone nearby/name-search is desktop-gated for now** — the public
  POTA API has no reliable nearby/name-search endpoint; standalone falls back
  to exact-ref lookup (`GET api.pota.app/park/{ref}`) with honest inline copy
  otherwise. The parks-pack (parent plan Phase 2 item 7) is the real fix.
- End activation is local-only per the known-gaps guidance (no
  `stop-activation` yet) and says so in the UI.
