# Worked states and countries: map overlays and "wanted" decodes (plan)

Casey, 2026-10-23, from GridTracker's map: shade each US state and each country by
whether it has been worked, on the main Spots map and the FT8/FT4/FT2 maps, toggled
with F-keys, by band and mode, for the Worked All States award; and mark FT8 decodes
and spots from a state or country still needed.

## What exists today (reuse, do not rebuild)

| Piece | Where | Reused for |
|---|---|---|
| Worked-QSO map from the operator's log, call -> `{date, band, mode, ref, myRef}` | `lib/adif.js parseWorkedQsos`, `main.js loadWorkedQsos`, `worked-qsos` push | the roster; gains `state` and `entity` per entry |
| Worked DXCC per band, `"Entity|20m"` | `main.js rosterWorkedDxcc`, `buildRosterSets` | becomes `lib/worked-roster.js` with states beside entities, mode family, confirmed |
| Decode enrichment: `r.entity`, `r.newDxcc` (per band) | `main.js` ~15079 and ~40887 (single and multi-slice) | gains `r.state`, `r.wanted` |
| Decode row badges, event stroke, `jp-new-dxcc` | `renderer/jtcat-popout.js` ~950, `lib/decode-row.js` | the WAS badge |
| cty.dat: call -> entity name, continent, lat/lon | `lib/cty.js resolveCallsign` | countries, and a centre point for entities with no polygon |
| Grid -> lat/lon | `lib/grid.js` | the grid -> state table build script |
| DXCC tracker: confirmed = `QSL_RCVD=Y` or `LOTW_QSL_RCVD=Y`, band × mode matrix, All-bands/band filter | `lib/adif.js parseDxcc*`, `renderer/app.js renderDxccMatrix` | the WAS tracker view is its twin; same confirmation rule |
| QRZ lookup with cache, returns `state` | `main.js qrz.lookup`, `qrz-cache.json` | state for a call with no grid; log backfill |
| States in the watchlist: a spot's states from its park `locationDesc` | `lib/watchlist-groups.js spotStates` | a spot's state is exact and free |
| CQ chase target classifies US-state tags | `renderer/cq-target.js` | the "CQ NJ" case |
| Event map overlay built once and pushed to both map windows | `renderer/app.js buildEventMapOverlay` | the pattern for the overlay layer |
| JTCAT window map plots CQ grids as rectangles, QSO arcs | `renderer/jtcat-popout.js plotDecode`, `jtcat-map-popout` | the overlay sits under those rectangles |
| Hunt filter with the event option | `lib/jtcat-state-machine.js matchesHuntFilter`, `eventHunt` | a "Wanted states" hunt option |

## Decisions

1. **"Worked" comes from the operator's own log**, the same file every worked-before
   check reads (`qsoLogPath()`). The DXCC tracker reads that same file (the
   `adifPath` import setting is gone), and the LoTW download writes its
   confirmations into it, so there is ONE source. Never from the spot list or the
   decode history.
2. **Two states per place: worked and confirmed.** WAS and DXCC are awarded on
   confirmations, so the map shows three tints: not worked = no fill (a faint outline
   only), worked = POTACAT blue (`#4fc3f7`, the link colour, ~35 % fill), confirmed =
   POTA green (`#4ecca3`, ~45 % fill) drawn over worked. Casey 2026-10-23: "make the
   colors OUR color. I don't want to copy GridTracker" (no yellow/green). Confirmed =
   the DXCC tracker's rule. The tints are the one table in `lib/worked-overlay.js
   styleFor` and the legend reads them from there.
3. **Scope is band and mode family, with a switch.** Scope values: *any* (ever),
   *band* (this band, any mode), *band + mode*. Mode = the award family
   (phone / CW / digital, `modeFamily` as rig-presets uses it), because the WAS digital
   endorsement counts FT8 and FT4 together; an *exact mode* option exists for people
   chasing a mode-specific sheet. Default: band + mode family, following the radio
   (dial band, current mode) so the map answers "what can I work right now".
4. **A decode's state is a guess with a certainty, and the badge says so.**
   - Grid first (CQ decodes carry one; the window remembers a station's grid for the
     session): a precomputed table `grid4 -> [state candidates]` answers instantly with
     no geometry at run time. A 4-character grid wholly inside one state is *certain*;
     a straddler lists its states (`NJ/PA`) and counts as wanted if any is wanted.
   - QRZ second, from the cache only on the decode path (the home state; wrong for a
     station operating portable, so the grid wins when both exist and disagree).
     A bounded background lookup (CQ callers in US/VE, at most a few per minute, only
     while the state overlay or badge is on, only with QRZ configured) fills the cache.
   - Country is exact from cty.dat, as today.
   - **Hunt never answers on a guess**: the "Wanted states" hunt option answers a CQ
     when the state is certain, or when the grid straddles states and EVERY candidate
     is wanted (Casey 2026-10-23: a `NJ/PA` straddler with both needed is answered;
     `NJ/PA` with PA worked is not). The badge shows `NJ/PA?` for a straddler.
5. **The roster never guesses.** A logged QSO counts for a state only from its `STATE`
   field. Older records with no `STATE` can be filled from the QRZ cache with a button
   ("Fill missing states from QRZ"), recorded as a log edit through `lib/qso-log.js`,
   never silently. DC counts as Maryland for WAS (ARRL rule); Alaska and Hawaii are
   both a state and a DXCC entity, so each layer colours them by its own meaning.
6. **Polygons are data files, public domain.** Natural Earth 1:110m admin-0 countries
   and admin-1 states/provinces (US, Canada, Australia), simplified to about 400 KB
   total in `assets/geo/`, loaded the first time an overlay is switched on. DXCC
   entities that are not countries (islands, Antarctic bases) draw as a circle at
   cty.dat's lat/lon. A DXCC-name -> ISO table maps the rest; unmapped entities are
   listed by a test so none vanish silently.
7. **F-keys: F6 states, F7 countries, F8 cycles the scope.** F1 is the Hotkeys help,
   F2 the log window, F4/F5/F11 are taken, and F1 to F12 send CW macros while the CW
   box is open; in the JTCAT window F1 to F12 are the JTTY macros on the JTTY pane.
   F6/F7/F8 are free in both windows and work on the FT8/FT4/FT2 panes; the JTTY pane
   keeps its macros. Every toggle also has a legend checkbox for mouse and phone.

## Build

### New files
| File | Responsibility (pure unless noted) |
|---|---|
| `lib/worked-roster.js` | `buildRoster(entries, {ctyDb})` -> `{states, entities}` maps keyed `KEY|band|family|exactMode` with `worked`/`confirmed`; `isWanted(roster, kind, key, {band, mode, scope, confirmedOnly})`; `summary(roster, scope)` for the tracker (counts, per-band cells). Dual-mode (web client). |
| `lib/grid-state.js` | `statesForGrid(grid4)` -> `{states:[], certain}` from `assets/geo/grid-states.json`; `stateForDecode({grid, qrzState})` applies the grid-over-QRZ rule. Dual-mode. |
| `lib/worked-overlay.js` | `styleFor(status)` (the three tints), `entityShape(entity)` (polygon id or circle), `overlayPayload(roster, scope)` -> what the maps draw. Dual-mode. |
| `scripts/build-geo-assets.js` | one-time: Natural Earth GeoJSON -> simplified `assets/geo/countries.json`, `states.json`, and the `grid-states.json` table (every 4-char grid intersecting US/CA/AU admin-1 polygons). Output checked in; the script is for refreshes. |
| `assets/geo/` | the three files + `LICENSE` (Natural Earth, public domain) |
| `renderer/was-view.js` | WAS tracker view (states × bands matrix, worked/confirmed, "37 / 50", the backfill button) modelled on the DXCC matrix |
| Tests | `test/worked-roster-test.js` (fixture ADIF: band/family/confirmed rules, DC -> MD, union with the DXCC import), `test/grid-state-test.js` (every state has a certain grid; known straddlers), `test/worked-overlay-test.js` (payload shape, unmapped DXCC entities), wiring guards in `test/worked-overlay-wiring-test.js`, a layout fixture row with the WAS badge |

### Existing files
| File | Change |
|---|---|
| `lib/adif.js parseWorkedQsos` | entry gains `state` (STATE), `qslRcvd`/`lotwRcvd`, and `entity` via cty (resolved once per call) |
| `main.js` | `buildRosterSets` -> `worked-roster`; decode enrichment (both sites) adds `r.state {code, certain, source}` and `r.wanted {state, country}` for the live scope; `overlay-state` push to the main window, JTCAT window, map pop-outs; IPC `worked-overlay-set {states, countries, scope}`; QRZ background lookup budget; `worked-overlay` line in bug reports |
| `renderer/app.js` | the overlay layer under the markers (`L.geoJSON`, rebuilt on roster or scope change, not on every spot refresh); F6/F7/F8 in the keydown handler and the Hotkeys dialog; legend chip with the three tints, scope select, counts ("WAS 37/50 on 20m digital"); spot rows get the badge from `spotStates` |
| `renderer/jtcat-popout.js`, `jtcat-map-popout.js` | same layer on `jp-map`; F6/F7/F8 on the FT-mode panes; the badge in `buildRow` beside the event badge; a `jp-wanted-state` stroke, below watchlist and event in the precedence list |
| `lib/decode-row.js` | nothing new in the cells; the badge is `badgesHtml` (one element) |
| `lib/jtcat-state-machine.js` | `matchesHuntFilter(text, 'wanted-state', {stateOf})` answering a CQ only on a certain wanted state |
| `renderer/remote.js`, `lib/remote-server.js`, `lib/echocat-protocol.js` | S2C `worked-overlay {scope, states:{NJ:'worked'…}, countries:{…}}` hydrated at connect; decodes already carry `state`/`wanted`; the web map draws the same files served as static assets; hello capability `worked-overlay` |
| Settings | `workedOverlayStates`, `workedOverlayCountries` (bool), `workedOverlayScope` (`any`/`band`/`band-mode`/`band-exact`), `workedOverlayConfirmedOnly` (bool); per profile |

### Phases
1. **Roster and WAS tracker** (no map): state and confirmation in the worked entries,
   `worked-roster`, the WAS view with counts and the QRZ backfill. Proves the data.
   **BUILT 2026-10-23**: `lib/worked-roster.js` (+ `test/worked-roster-test.js`),
   `parseWorkedQsos` entries carry `state`/`confirmed` only when present (the
   ECHOCAT worked-qsos payload is size-capped), main builds `workedRoster` in
   `loadWorkedQsos` and folds in both live-add sites, pushes `worked-roster`;
   More > Worked All States (`renderer/was-view.js`, Mode: any/phone/CW/digital/
   FT8/FT4/RTTY, Count: worked/confirmed, blue/green cells); "Fill missing states
   from QRZ" = IPC `was-backfill-states` (park state for a single-state park
   contact, QRZ for the rest, 150 live lookups per press, a `mutateLog` edit).
   Checked live in a scratch profile with a six-QSO log.
2. **Badges and Hunt**: decode and spot badges with certainty, the Hunt option.
3. **Map overlays**: geo assets, the layer on the three maps, F6/F7/F8, legend, scope
   following the radio.
4. **ECHOCAT**: web map and rows, hello capability, mobile handoff
   (`potacat-app/docs/desktop-handoffs/worked-overlay.md`).

Rough size: phase 1 a day, 2 half a day, 3 a day and a half (most of it the asset
build and three map surfaces), 4 half a day plus the app's own work.

## Answered by Casey (2026-10-23)
- F6 / F7 / F8: yes.
- Default scope band + mode family, following the radio: yes.
- Hunt answers a straddler when all of its states are wanted: yes.
- Worked as the headline tint with confirmed on top: yes, in POTACAT's own colours
  (blue worked, green confirmed), never GridTracker's yellow/green.
