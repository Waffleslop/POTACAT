# Route 66 On The Air 2026 — Event Plan and Definition of Record

**Written 2026-09-12 (the event opened at 0001Z today). Feed live since
11:25 EDT (website `8864128`); desktop side in 1.10.16 (`5067c0d`,
`e421a58`, `6524f12`, `af4cc06`).**

## The event

Route 66 On The Air is run by the Citrus Belt Amateur Radio Club (W6JBT,
San Bernardino CA); 2026 is the 27th running and the highway's centennial.
It opens **Saturday 2026-09-12 0001Z** and closes **Sunday 2026-09-20 2359Z**
(nine days — "the Saturday after Labor Day through the second Sunday").

22 special-event stations, all `W6<letter>` 1x1 calls: **W6A–W6T, W6W,
W6Z** (U, V, X and Y are unused this year). Eighteen sit at cities along
the road from Chicago to Santa Monica, one (W6M, Tribune KS) is a ~350-mile
spur off the route, and four are **rovers** with no fixed place and no
published coordinates. Mobiles sign `/m66`.

**Certificate rules:** work **any one** station on any band or mode. No
tiers, no clean sweep, no log submission — a mail-in application ($5 for
the certificate; decal and centennial coin optional) to the club. QSL each
station direct with an SASE. Stations self-spot on the DX cluster and run
FT8 on the standard dials, so every surface 13 Colonies exercised applies.

Frequency guideline (club): CW 3.533/7.033/10.110/14.033/18.080/21.033/
24.900/28.033/50.033; SSB 3.866/7.266/14.266/18.164/21.366/24.966/28.466/
50.166.

## Why this event got more than a list of calls

The 13 Colonies review confirmed the events system is table-driven: ~95%
of "a 13C-style event" is a `board: 'checklist'` entry in
`https://potacat.com/events/active.json`, mirrored in `BUILTIN_EVENTS`.
That entry alone buys the Settings > Events card, banner + snooze,
table/map badges, watchlist card + star, the checklist board with manual
ticks, live stamping (`APP_POTACAT_EVENT` + comment tag), the day-inclusive
log rebuild, JTCAT decode badges/stroke/Event filter, Event Focus, and the
ECHOCAT catalog.

What 13C never had is **geography** — each Route 66 station *is a place*.
Without it a `W6K` cluster spot lands on the W6 call-area centroid in
California (it is in Oklahoma City for nine days) and the board is 22
letters. So the build added generic per-item metadata and the code that
consumes it. Everything is generic: 13 Colonies and every future checklist
event inherit it.

## Definition of record

`route66-2026` — identical copies in `potacat-website/events/active.json`
(the copy every running install uses) and `main.js BUILTIN_EVENTS` (the
fallback for a cacheless fresh install and the definition of record for
the release). `scripts/validate-events.js --compare --require` asserts the
two are deep-equal — the "keep identical" rule enforced rather than
remembered.

```json
{
  "id": "route66-2026",
  "name": "Route 66 On The Air",
  "type": "special-event",
  "board": "checklist",
  "url": "https://w6jbt.org/",
  "badge": "R66",
  "badgeColor": "#c0392b",
  "contestId": "route-66-ota",
  "links": {
    "rules": "https://w6jbt.org/?page_id=23",
    "results": "https://w6jbt.org/wp-content/uploads/2026/09/FINAL-CERTIFICATE-APPLICATION-2026-rev.pdf",
    "stations": "https://w6jbt.org/2013-route-66-on-the-air-participating-clubs/",
    "frequencies": "https://w6jbt.org/operating-frequency-guidelines/"
  },
  "callsignPatterns": ["W6A","W6B","W6C","W6D","W6E","W6F","W6G","W6H","W6I","W6J","W6K","W6L","W6M","W6N","W6O","W6P","W6Q","W6R","W6S","W6T","W6W","W6Z"],
  "schedule": [{ "region": "ALL", "regionName": "Route 66 On The Air",
                 "start": "2026-09-12T00:01:00Z", "end": "2026-09-20T23:59:59Z" }],
  "tracking": {
    "type": "checklist", "total": 22, "label": "Stations",
    "items": [
      { "id": "W6Q", "name": "Chicago, IL",        "lat": 41.88, "lon": -87.63,  "route": 1 },
      { "id": "W6P", "name": "St. Louis, MO",      "lat": 38.63, "lon": -90.20,  "route": 2 },
      { "id": "W6O", "name": "Lebanon, MO",        "lat": 37.68, "lon": -92.66,  "route": 3 },
      { "id": "W6R", "name": "Springfield, MO",    "lat": 37.21, "lon": -93.29,  "route": 4 },
      { "id": "W6N", "name": "Joplin, MO",         "lat": 37.08, "lon": -94.51,  "route": 5 },
      { "id": "W6M", "name": "Tribune, KS",        "lat": 38.47, "lon": -101.75, "offRoute": true },
      { "id": "W6L", "name": "Tulsa, OK",          "lat": 36.15, "lon": -95.99,  "route": 6 },
      { "id": "W6K", "name": "Oklahoma City, OK",  "lat": 35.47, "lon": -97.52,  "route": 7 },
      { "id": "W6J", "name": "Elk City, OK",       "lat": 35.41, "lon": -99.40,  "route": 8 },
      { "id": "W6I", "name": "Amarillo, TX",       "lat": 35.22, "lon": -101.83, "route": 9 },
      { "id": "W6H", "name": "Albuquerque, NM",    "lat": 35.08, "lon": -106.65, "route": 10 },
      { "id": "W6G", "name": "Flagstaff, AZ",      "lat": 35.20, "lon": -111.65, "route": 11 },
      { "id": "W6F", "name": "Kingman, AZ",        "lat": 35.19, "lon": -114.05, "route": 12 },
      { "id": "W6E", "name": "Barstow, CA",        "lat": 34.90, "lon": -117.02, "route": 13 },
      { "id": "W6D", "name": "Oak Hills, CA",      "lat": 34.38, "lon": -117.43, "route": 14 },
      { "id": "W6C", "name": "San Bernardino, CA", "lat": 34.11, "lon": -117.29, "route": 15 },
      { "id": "W6B", "name": "Los Angeles, CA",    "lat": 34.05, "lon": -118.24, "route": 16 },
      { "id": "W6A", "name": "Santa Monica, CA",   "lat": 34.02, "lon": -118.49, "route": 17 },
      { "id": "W6S", "name": "Arizona Rover 1",    "group": "Rovers" },
      { "id": "W6T", "name": "Arizona Rover 2",    "group": "Rovers" },
      { "id": "W6W", "name": "Kingman Rover 1",    "group": "Rovers" },
      { "id": "W6Z", "name": "California Rover",   "group": "Rovers" }
    ]
  }
}
```

Decisions baked into the entry:

- **Exact-match patterns, never `W6*`.** `matchesEventPattern` treats a
  bare string as exact and only a trailing `/*` as a prefix; a wildcard
  would badge every California call. Same reasoning as WRTC's MB block
  (MB7Ixx gateways).
- **`contestId` on the definition, not `BUILTIN_ALIASES`** (Phase C retires
  that map). `adifContestIdForEvent` is null — there is no ADIF
  `CONTEST_ID` enumeration for a special event, so QSOs carry
  `APP_POTACAT_EVENT=route66-2026` plus the
  `[Route 66 On The Air - Oklahoma City, OK]` comment tag, as 13C does.
- **`links.results` is the certificate application**: the finished
  lifecycle sentence and the board's links row both read that key, so a
  special event's "results" link IS its award path.
- **Nothing invented.** No per-station sponsors (only three are known), no
  rover coordinates. A rover is a heading on the board, nothing on the map.

### Checklist item metadata (generic schema)

All optional and additive; an item with only `id`/`name` renders exactly as
before.

| field | meaning | consumers |
|---|---|---|
| `lat`, `lon` | where the station is | map pin, cluster-spot placement (`coordSource:'event'`), board distance/bearing tooltip |
| `route` | integer order along the polyline; absent = not on the line | map route line (sorted ascending, unique) |
| `offRoute` | true = pin only, never joined to the line | map |
| `group` | board sub-heading (e.g. `Rovers`); absent = top section | board, mobile board |

## Two-track deployment (the recipe)

1. **Feed first — `potacat-website/events/active.json`.** This is the only
   way *existing* installs get the event: the app refetches on launch and
   every 4 h with `If-None-Match`, so the entry must be live ~4 h before
   the opening for every running install to have it at the start. Append
   to `events[]`, bump `updated`, validate, stage that one file, commit,
   push master (the workflow rsyncs to DigitalOcean and purges the CDN).
   Verify `curl -sI …/active.json` shows a **new ETag** — if the ETag did
   not change, clients 304 forever. Record:
   `potacat-meta/work/closed/route66-active-json-deploy.md`.
2. **Desktop — `BUILTIN_EVENTS` in `main.js`**, byte-for-byte the feed's
   entry. The feed wins on a running install (fetch overwrites the cache),
   so drift self-heals, but the validator's `--compare --require` turns
   drift into a failing test instead of a surprise.

Validation: `node scripts/validate-events.js ../potacat-website/events/active.json --compare --require 13colonies-2026,wrtc-2026,route66-2026`
(pattern set == item id set, `total` == items, dated windows that parse
with start < end, lat/lon in range, unique route numbers, exact patterns
only). `test/events-catalog-test.js` runs the same rules against
`BUILTIN_EVENTS` in CI.

## What the build added (all generic)

**Track A (`5067c0d`)** — the definition, the validator + catalog test,
`test/event-progress-test.js` (W6K matches, W6KA/W6U do not; a QSO at
00:00:30Z on the 12th — before 0001Z — is still stamped by the
day-inclusive rebuild; the 21st is not), `test/event-registry-test.js`
(feed `contestId` resolves without an alias), and the Contests catalog
card `route-66-ota` rewritten (it said 21 stations W6A–W6U with a Clean
Sweep, dead URLs, and a `whenComputed: custom:` rule that resolved to
nothing). New `whenComputed` verb in `lib/contests-db.js`:
`nth-weekday-of:9:1:Mon+5` = "the Saturday after Labor Day" — an optional
day offset on `nth-weekday-of`, because `nth-weekend-of:9:2` is a week
late whenever September opens on a Sunday or Monday (2024, 2025).

**Track B1–B4 (`e421a58`)**
- `lib/event-geo.js` `eventStationGeo(events, call, {now, graceMs})` —
  a cluster spot from a tracked station plots at the event's city.
  `coordSource:'event'` is **terminal**: `refineClusterSpotWithQrz` returns
  early on it (the club station's QRZ address is somebody's house). Not
  gated on opt-in — location is a fact about the station. Rovers have no
  coordinates and fall through to the normal ladder. `locationDesc` reads
  `Oklahoma City, OK (Route 66 On The Air)`. `test/event-geo-test.js`.
- Map overlay (`renderer/app.js` `buildEventMapOverlay()`, mirrored in
  `map-popout.js`): a pin per station in `badgeColor`, hollow while needed
  and filled once worked, and a dashed line through the items in `route`
  order over the tune arc's black halo; drawn at the −360/0/+360 offsets
  like everything else. Geometry is built once and rides the pop-out spot
  push so both windows draw the same thing; rebuilt on every
  `active-events` push so a logged QSO fills its pin. "Show on map" /
  "Hide from map" on the board is device-local (`EVENT_MAP_HIDDEN_KEY`,
  like the pill dismissal). Live *spot* markers stay in `markerLayer` — a
  spotted needed station shows its spot on top of its hollow pin.
- Board: `group` sub-headings, distance/bearing-from-home tooltip on any
  station with coordinates.
- Links row (`renderEventLinksRow`): Event site / Rules / Certificate
  application / Stations / Frequencies from `links`; the finished
  lifecycle sentence links the certificate application. `main.js
  eventUrlAllowed(url)`: any URL an active event names is an allowed
  link-out for both `open-external` and `open-contest-url`, so sponsor
  hostnames are never enumerated in an allowlist.

**Track B5 (`6524f12`) — Hunt: Event stations.**
- `matchesHuntFilter(text, 'event', {eventNeeded})` in
  `lib/jtcat-state-machine.js`: answers a CQ from a station the event
  classification says is still needed (or a new band/mode slot). Still
  requires a `CQ` — tail-ending a needed station's RR73 is how you QRM
  the QSO you came to make.
- `jtcatHuntProgramMatch` (main.js) supplies `eventNeeded` from the SAME
  `eventDecodeMatch()` the popout badge uses (`status !== 'worked'`), and
  logs once per call why it answered.
- Availability is `eventHuntAvailability()` in `lib/event-decode-match.js`:
  an opted-in checklist event within ±24 h (`HUNT_GRACE_MS`) of a schedule
  entry. The grace is for the *control* (arm it the evening before), never
  for matching — a decode outside the window is still unclassified.
- Wire: `jtcat-auto-cq-state` carries `eventHunt: {available, events:
  [{id, name, badge}]}` and is hydrated at ECHOCAT connect and at popout
  open (before, it was broadcast only on change). `jtcatEventHuntSync()`
  re-broadcasts when availability flips (events refetch, 5-min boundary
  ticker, opt-in/out). The popout and web client append/remove the
  `event` option like the Field Day option, and keep it while selected.
- `jtcat-auto-cq-mode` accepts `event` from popout, in-window and remote
  clients (`setJtcatHuntMode` is the one setter; it has no whitelist).

**Track B6 (`af4cc06`) — ECHOCAT catalog.** `buildEventCatalogPayload`:
`available[]` gains `badgeColor` + `links`; `subscriptions[]` gains `url`,
`badge`, `badgeColor`, `links`. `eventLinksForClients()` keeps http(s)
strings only — the mobile device is never handed a `javascript:` URL.
`tracking` passes through verbatim, which is how `lat/lon/route/offRoute/
group` reach the mobile device. No new message types.

## Deliberately not changed

- **Event Focus pill cap** (`EVENT_CHIP_MAX_WINDOW_MS`, 120 h): Casey's
  2026-07-17 rule. 13C (159 h) gets no pill; Route 66 (216 h) matches that
  parity, and the board's Focus Spots button gives the lens anyway. A
  change here needs a mobile twin.
- WD4DAN's unofficial `spots.json` relay — one volunteer, no CORS/terms;
  the cluster already carries the stations' self-spots.
- Rover coordinates / per-station sponsors — not published, not invented.

## Verified (dev instance against the live feed, 2026-09-12)

Board shows the Rovers heading and five links; Hide/Show toggles 54 pins
(18 × 3 offsets) + 6 route segments; marking W6K fills its pin. A fake
cluster node's W6K spot lands at 35.47,-97.52 "Oklahoma City, OK (Route 66
On The Air)" with the R66 badge while W6S (rover) and W6KA stay on the
call-area centroid. Hunt select hydrates "Hunt: Event stations" on popout
open, keeps it while selected after opt-out, drops it once Off. Catalog
payload: `badgeColor "#c0392b"`, four links, `contestId "route-66-ota"`;
subscription items carry lat/lon/route and `group "Rovers"`. Web-client
option hunk not live-exercised (same logic as the popout).

## 2027 checklist

The station list churns every year, so a new id, never an edit:

1. New id `route66-2027`; leave `route66-2026` in the feed for retention
   (a year-old QSO still needs its board), same as 13C/America250.
2. Verify the letters actually issued (2026 skipped U/V/X/Y) and each
   station's city — W6D's city (Oak Hills) and the rover count changed
   between years. Re-check `W6M`'s off-route status.
3. Dates: `nth-weekday-of:9:1:Mon+5` gives the Saturday; the window is
   that day 0001Z through the second Sunday 2359Z.
4. New certificate-application PDF URL (`links.results`) — the club posts
   a new rev each year.
5. Run the validator with `--compare --require` after mirroring into
   `BUILTIN_EVENTS`; deploy the feed at least 4 h before 0001Z; confirm the
   ETag changed.
