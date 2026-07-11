# WRTC 2026 — Event Tracking Plan (13-Colonies-style)

**Written 2026-07-10. The event is 2026-07-11 12:00Z → 2026-07-12 12:00Z (tomorrow).**

## The event

WRTC 2026 (World Radiosport Team Championship) runs inside the IARU HF
Championship: 50 two-operator teams at identical 100 W stations in South East
England, CW + SSB on 80/40/20/15/10m, 24 hours. Chasers get downloadable
certificates with award tiers by total QSO count (each station workable per
band per mode → 500 QSO ceiling; 250 per mode).

**Callsigns** (announced 2026-07-09, official list v2 from wrtc2026.org):
50 calls, all `MB<digit><letter>`:

```
MB1A MB1I MB1N MB1S MB1T
MB2A MB2D MB2H MB2M MB2N MB2R MB2S MB2U
MB3B MB3D MB3F MB3G MB3H MB3K MB3L MB3M MB3R MB3V MB3W
MB4C MB4F MB4G MB4L MB4O MB4P MB4V MB4W MB4X MB4Z
MB5C MB5J MB5O MB5P MB5Q MB5X MB5Y MB5Z
MB7D MB7F MB7G MB7K MB7L MB7M MB7V MB7W
```

Notes that shaped the design:
- The **MB block is otherwise unallocated** in the UK (that's why Ofcom
  granted it) — but MB7Ixx gateways exist, so we use **exact-match patterns,
  no wildcards** (`matchesEventPattern` is exact unless a pattern ends `/*`).
- **Team↔callsign mapping is sealed** until after the contest → checklist
  items carry empty `name`s (the watchlist-card chip renderer handles
  name-less items; chips show just the call).
- WRTC/RBN pre-arranged SCP + RBN pattern updates, so the DX cluster + our
  CW Spots feed will carry these calls heavily. No FT8 — `event-decode-match`
  is naturally inert for this event.

## Design (mirrors 13 Colonies)

One event definition, id **`wrtc-2026`**, `board: 'checklist'`:

- `badge: 'WRTC'`, `badgeColor: '#c8102e'` (UK red) — spot-table badge, map
  popup badge, banner, Events board button all key off these existing paths.
- `callsignPatterns`: the 50 calls → spot decoration + watchlist-overlay
  (OR'd into watchlistMatch, non-destructive) + banner activation.
- `schedule`: single window `2026-07-11T12:00:00Z → 2026-07-12T12:00:00Z`
  (IARU HF is 1200Z–1200Z).
- `tracking`: `checklist`, `total: 50`, `label: 'Stations'`, 50 name-less
  items. Worked-state comes from the existing day-inclusive log scanner
  (`lib/event-progress.js`), which covers both contest days.

Everything else is free: banner + snooze-until-start, ECHOCAT board via the
settings blob (availableEvents/eventSubscriptions), identity-proven
`APP_POTACAT_EVENT=wrtc-2026` stamping in saveQsoRecord (checklist boards
stamp), retro-stamp for QSOs logged before the definition arrives, Events↔
Contests registry needs no alias (working WRTC stations ≠ entering IARU —
distinct happenings; `kindForEvent('checklist')` → special-event is right).

**Checklist vs counter:** the award is QSO-count-tiered (multi-band/mode),
but "did I work each of the 50" is the 13-Colonies-style board Casey asked
for and the more engaging chase. A per-band 500-cell matrix would be a new
board type — out of scope for a next-day event.

## Deployment — two tracks, one critical path

1. **CRITICAL — potacat.com `events/active.json`** (website repo, not this
   one). This is the ONLY way existing installs get the event: the app
   refetches every 4 h + on launch (conditional GET). **Deploy by ~07:00Z
   Saturday** to guarantee every 4-hour cycle lands before the 12:00Z start
   (earlier is better; tonight is ideal). Ready-to-paste JSON is in
   `potacat-meta/work/open/wrtc-2026-active-json-deploy.md`.
   Remember: if the server ships ETags, the content change must change the
   ETag or clients will 304 forever.
2. **Done in this repo — `BUILTIN_EVENTS` in main.js**: fallback for fresh
   installs with no cache and the definition of record for the next release.
   Server copy wins on running installs (fetch overwrites cache), so drift
   between the two copies self-heals; keep them identical anyway.

## Verification (same-day)

- Temp-edit the schedule start to now-1h in a dev run (or wait for 12:00Z):
  cluster/CW spot for any MB call shows the red WRTC badge in the table and
  map popup; Events board lists 50 chips; logging one (banner logger or
  JTCAT is N/A — CW/SSB, so banner/manual paths) checks its chip and stamps
  APP_POTACAT_EVENT.
- `getEventForCallsign('MB7I…')` (a real gateway) must NOT match — exact
  patterns guarantee it; worth one console check.
- Phone: event appears in the ECHOCAT Events board after the settings blob
  refresh (updateRemoteSettings fires on event refetch).

## Explicitly out of scope (post-event follow-ups if wanted)

- Per-band/per-mode 500-cell chase matrix (new board type).
- IARU HF Championship as a WSJT-X-style contest mode — different feature,
  gated on the unified-registry roadmap item.
- Post-contest team-name reveal (could update item names server-side after
  the mapping unseals; checklist state keys off item id, so names are safe
  to add later).
