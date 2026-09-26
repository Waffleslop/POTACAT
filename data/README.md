# POTACAT data files

Static datasets that POTACAT desktop / workers can consume. None of this
is scraped from third-party sites — every entry is sourced from the
sponsor's own publication of names, URLs, and date formulas.

## `contests.json`

Curated database of recurring amateur radio contests and on-air events:
worldwide DX, North American and state/provincial QSO parties, weekly and
monthly sprints, VHF/UHF, digital, special events and parks events. Seeded
2026-05-30 with 71 entries; 181 as of 2026-09-26.

This file is the one catalog everyone edits. The contests feed job on
api.potacat.com fetches it from `master`, resolves every rule into dates with
a vendored copy of `lib/contests-db.js`, and serves the result to desktop and
mobile (`docs/contests-feed.md`) — so a catalog fix pushed to `master` reaches
users within a day, without an app release.

Each contest has:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | kebab-case stable identifier (`cq-ww-ssb`). Never reuse or rename one — contest history and the mobile app key on it. |
| `name` | yes | Human-readable name (e.g. "CQ WW DX Contest, SSB") |
| `sponsor` | yes | Sponsoring org |
| `website` | yes | Sponsor's official site |
| `rulesUrl` | yes | Direct link to the rules. Often same as website. Prefer a stable page over a PDF whose path changes every year. |
| `whenRule` | yes | Plain-English cadence with UTC times (e.g. "Last full weekend of October, 0000z Sat - 2359z Sun") |
| `whenComputed` | yes | Parser-friendly cadence — see the syntax below |
| `durationHours` | yes* | Length of the window from the computed start. Covers every session of a multi-period contest (e.g. 1400z Sat – 2000z Sun = 30). *Optional only for `custom:` rules. |
| `bands` | yes | List of band labels ("160m", "80m", … "all HF", "VHF", "any") |
| `modes` | yes | `["CW"]`, `["SSB"]`, `["RTTY"]`, `["FT8","FT4"]`, `["DIGITAL"]`, `["any"]`, etc. |
| `category` | yes | `worldwide-dx`, `north-american`, `state-qso-party`, `special-event`, `operating-event`, `single-band`, `vhf-uhf`, `digital`, `weekly-sprint`, `monthly-qrp`, `monthly`, `newcomer`, `pota-sota`, `regional` |
| `explicitWindows` | optional | `[{ "start": ISO, "end": ISO }]` — sponsor-announced dates for an event **with no rule** (`custom:` only). See below. |
| `adifContestId` | optional | The ADIF `CONTEST_ID` enumeration value, when one exists. |
| `notes` | optional | Short freeform notes (exchange format quirks, power limits, etc.) |

`lib/contests-db.js` `validateCatalog()` enforces all of this, and
`test/contests-db-test.js` runs it in CI.

### `whenComputed` syntax

```
rule := form [ :HHMMz ] [ @YYYY[-YYYY] ] { ;YYYY=MM-DD }
```

A form computes the start **day** (0000z); the optional suffixes refine it.

**Annual forms** — one occurrence per year:

| Form | Example | Meaning |
|---|---|---|
| `nth-weekend-of:<MM>:<n>` | `nth-weekend-of:10:-1` | nth **full** Sat+Sun weekend of the month (both days inside it). `n=1..5`, `-1` last, `-2` second-to-last. Starts Saturday. |
| `nth-weekend-of:<MM>:<n>:<Sat\|Sun>[±d]` | `nth-weekend-of:3:2:Sun` | One day of that weekend: `:Sun` for a Sunday-only QSO party. An offset walks from that day: `:Sat-1` = the Friday a weekend contest opens on (`nth-weekend-of:1:-1:Sat-1:2200z`, CQ 160). |
| `nth-weekday-of:<MM>:<n>:<Day>[±d]` | `nth-weekday-of:4:3:Sun` | nth `Mon`…`Sun` of the month; `-1` last, `-2` second-to-last. The offset pins an event to a holiday: `nth-weekday-of:9:1:Mon+5` = the Saturday after Labor Day (Route 66, OSPOTA); `nth-weekday-of:2:1:Sat+1` = the Sunday UTC of a Saturday-evening US sprint. |
| `weekday-nearest:<MM-DD>:<Day>[±d]` | `weekday-nearest:09-27:Sat` | The `<Day>` closest to a date — "the weekend closest to 27 September". |
| `weekday-on-or-after:<MM-DD>:<Day>[±d]` | `weekday-on-or-after:01-02:Sat` | First `<Day>` on or after a date — "the first Saturday that isn't New Year's Day". |
| `weekday-on-or-before:<MM-DD>:<Day>[±d]` | `weekday-on-or-before:06-20:Sat` | Last `<Day>` on or before a date — "June 20 if a Saturday, else the Saturday before". |
| `fixed:<MM-DD>` | `fixed:01-01` | Same calendar date every year. |
| `range:<MM-DD>:<MM-DD>` | `range:07-01:07-07` | Starts on the first date each year (13 Colonies, YOTA Month). The second date is informational; `durationHours` sets the end. |

**Recurring forms** — many occurrences a year:

| Form | Example | Meaning |
|---|---|---|
| `weekly:<Day>:<HHMM>z[,<Day>:<HHMM>z…]` | `weekly:Wed:1300z,Wed:1900z,Thu:0300z,Thu:0700z` | One or more weekly sessions, each its own occurrence of `durationHours` (CWT, K1USN SST, MST). |
| `monthly-nth:<n>:<Day>[±d]` | `monthly-nth:3:Sun:2300z` | nth weekday of every month. |
| `monthly-first-weekend` | — | First full weekend of every month. |

**No formula:**

| Form | Example | Meaning |
|---|---|---|
| `custom:<text>` | `custom:dates announced at ssbsprint.com` | Nothing to compute; the UI shows `whenRule`. Add `explicitWindows` when the sponsor has published dates. |

**Suffixes:**

| Suffix | Example | Meaning |
|---|---|---|
| `:HHMMz` | `nth-weekend-of:9:3:1400z` | UTC start time (any non-weekly form). Without it the start is 0000z. |
| `@YYYY` / `@YYYY-YYYY` | `range:01-01:12-31@2026` | Only occurrences starting in those years — a one-off event stops resolving afterwards (ARRL America250 WAS). |
| `;YYYY=MM-DD` | `nth-weekend-of:4:3:Sun:1800z;2028=04-09` | The sponsor moved that one year (ARRL Rookie Roundup SSB steps a week early when its Sunday is Easter). Repeatable. Annual forms only. |

Weekends are UTC calendar days. "Full weekend" always means Saturday and
Sunday both fall inside the month — a month that ends on a Saturday does not
have its last full weekend there.

### Irregular dates

Pick the lightest tool that says what the sponsor says:

1. **A rule** whenever the sponsor states one, even with a year or two of
   exceptions — `;YYYY=MM-DD` carries the exceptions inside the rule, so the
   feed, the desktop fallback and contest history (which only sees the rule)
   all agree.
2. **`custom:` + `explicitWindows`** when the sponsor sets dates each year
   with no rule (NA SSB Sprint, UK/EI DX SSB, Chasing Cornwallis). Add each
   year's dates as the sponsor announces them. `explicitWindows` is only
   allowed with a `custom:` rule, because contest history reads the windows
   *instead of* the rule.

There is no separate exceptions file on purpose: the feed job fetches only
`contests.json`.

### Adding entries

Rules to keep this maintainable:

1. **Only public facts.** Sponsor's own site + sponsor's own date rule.
   Contest names, sponsor URLs, and date formulas published by the
   sponsor are first-principles ham-radio public information — not
   copied from any third-party index. Third-party calendars are fine for
   cross-checking a rule against past dates, never as the source.
2. **Verify the URL responds 2xx or 3xx** with a browser User-Agent. A few
   sponsors return 403/406 to bot UAs; those entries are kept (the URL is
   correct, the site just blocks bots). DNS failures, 404s and soft 404s
   (a 200 "page not found") mean the URL is wrong — fix or drop the entry.
   Never use a lapsed domain (flspota.org is now a spam redirect; Florida
   state parks is fspota.org).
3. **Check the rule against the sponsor's own published dates** for this
   year and next, and add those dates to `test/contests-db-test.js` when you
   fix a rule. ARRL publishes six years ahead at
   https://contests.arrl.org/calendar.php.
4. **Never guess.** If the sponsor gives no rule and no dates, leave the
   entry out (or `custom:`) rather than infer a weekend.

### Out of scope (for now)

Contest scoring rules, exchanges beyond a short note, and log-submission
deadlines.
