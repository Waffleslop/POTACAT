# Contests feed — contract (2026-09-26)

Casey: "Run a cron on the server to update at least once a week and push
updates to users on desktop and mobile app."

## The shape of it

- **One catalog.** `data/contests.json` in this repo is the only list anyone
  edits (reviewed in git, same rules as `data/README.md`). Desktop bundles it
  as the offline fallback.
- **The server resolves dates.** A daily systemd timer on api.potacat.com
  (potacat-cloudlog `scripts/refresh-contests.js`) fetches the catalog from
  `https://raw.githubusercontent.com/Waffleslop/POTACAT/master/data/contests.json`,
  resolves every `whenComputed` rule into concrete occurrences with a vendored
  copy of `lib/contests-db.js`, checks links weekly, and publishes the feed
  below. A catalog edit pushed to master reaches every user within a day, with
  no app release.
- **Clients only display dates.** Desktop and the ECHOCAT mobile app read
  `occurrences`; they never need to understand a new `whenComputed` form. The
  local resolver stays only as the fallback when the feed is unavailable or
  its occurrences have run out.
- **Never publish a broken feed.** If the catalog fails to fetch, fails to
  parse, fails validation, or shrinks by more than 20% versus the last
  published feed, the job logs why and leaves the previous feed in place.

## Endpoint

`GET https://api.potacat.com/v1/contests` — anonymous, `ETag` +
`If-None-Match` (304), `Cache-Control: public, max-age=3600`. Gzip via nginx.

```json
{
  "schemaVersion": 2,
  "generated": "2026-09-27T06:00:00.000Z",
  "catalogSha": "sha256 of the catalog bytes",
  "horizon": { "from": "2026-09-20T06:00:00.000Z", "to": "2027-10-31T06:00:00.000Z" },
  "linksCheckedAt": "2026-09-27T06:00:00.000Z",
  "contests": [
    {
      "id": "cq-ww-ssb",
      "...": "every catalog field, verbatim (name, sponsor, website, rulesUrl, whenRule, whenComputed, durationHours, bands, modes, category, notes, adifContestId, ...)",
      "occurrences": [
        { "start": "2026-10-24T00:00:00.000Z", "end": "2026-10-26T00:00:00.000Z" }
      ],
      "links": { "website": "ok", "rulesUrl": "dead" }
    }
  ]
}
```

### Occurrences

- Sorted by `start`, all with `end` after `horizon.from` (generated − 7 days).
- Year-bound rules (`fixed:`, `range:`, `nth-weekend-of:`, `nth-weekday-of:`,
  and any year-bound form added later): every occurrence starting before
  generated + 400 days (so always this one and next year's).
- Recurring rules (`weekly:`, `monthly-*`, multi-session weekly): every
  occurrence starting before generated + 60 days.
- A rule the resolver cannot resolve (`custom:`) or a one-off whose year has
  passed: `occurrences: []`. The client shows `whenRule`.

### Client rule

`next = first occurrence with end > now`. If none, fall back to the local
resolver on `whenComputed` (it may know the form), else show `whenRule`.
A client must keep working with a feed up to 60 days old — which the
horizons above guarantee for everything except a weekly event.

### Links

`"ok" | "dead" | "unchecked"`. `dead` = 404/410, DNS failure, or connection
refused on two consecutive weekly checks. 401/403/405/406/429/5xx are NOT
dead (sponsor sites block bot user-agents). Clients hide a dead `rulesUrl`
and fall back to `website`; a dead `website` is still shown (it's the only
name for the sponsor) but the weekly log lists it for a catalog fix.

## Desktop

`lib/contests-feed.js`: fetch at launch + every 6 h with `If-None-Match`,
cache at `userData/contests-feed.json`, validate the shape, then the Contests
view and `get-contests` use feed occurrences (bundled catalog + local resolver
when there is no usable feed). A changed feed pushes `contests-updated` to the
main window, which re-renders the Contests view if it is open.

## Mobile (ECHOCAT)

Same fetch/cache rule against the same endpoint (the mobile app talks to
api.potacat.com directly, no desktop needed); bundled `src/data/contests.json`
stays the fallback. Handoff: potacat-app `docs/desktop-handoffs/contests-feed.md`.
