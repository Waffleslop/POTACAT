# Mobile Handoff — Support Your Parks shows the wrong date (stale bundled catalog)

**Audience:** POTACAT mobile (iOS / Android) team
**Scope:** Data-only fix in the app's bundled contest catalog. No resolver
changes, no wire-contract changes, no desktop work pending.
**Origin:** K3SBP, 2026-07-18 — the iOS Contests tab shows "POTA Support Your
Parks Weekend" on **Aug 1** ("two weeks away") while the event is actually
running **right now** (July 18–19, 2026). Desktop shows the correct dates.

---

## The bug

`src/data/contests.json` (mobile repo) still carries the ORIGINAL seed entry:

```json
{
  "id": "pota-plaque",
  "name": "POTA Support Your Parks Weekend",
  "whenRule": "First full weekend of every month (alternating Winter/Spring/Summer/Fall recognition)",
  "whenComputed": "monthly-first-weekend",
  ...
}
```

That rule was **wrong from the day it was seeded** — POTA's Support Your Parks
is not monthly and not first-weekend. W7RTA reported it on the desktop
(2026-07-14) and desktop fixed it in v1.9.9 (`potacat-dev` commit `c3ea3b9`),
but the mobile bundle is a fork of the pre-fix catalog, so the phone still
resolves the next "first full weekend of a month" = **Aug 1–2** — exactly the
date Casey sees.

**Ground truth** (https://docs.pota.app/docs/events.html and
https://docs.pota.app/docs/support_your_parks.html): Support Your Parks is
**quarterly**, on the **3rd full weekend** (Saturday + Sunday, UTC) of
January, April, July, and October. The page currently lists: Summer
**Jul 18–19 2026**, Autumn Oct 17–18 2026, Winter Jan 16–17 2027, Spring
Apr 17–18 2027.

## The fix — copy desktop's four corrected entries

Delete the single `pota-plaque` entry and add the four seasonal entries,
verbatim from desktop `potacat-dev/data/contests.json` (lines ~923–978 on
master today). They are:

```json
{
  "id": "pota-syp-winter",
  "name": "Winter Support Your Parks Weekend",
  "sponsor": "Parks On The Air (parksontheair.com)",
  "website": "https://parksontheair.com/",
  "rulesUrl": "https://docs.pota.app/docs/support_your_parks.html",
  "whenRule": "Third full weekend of January",
  "whenComputed": "nth-weekend-of:1:3",
  "durationHours": 48,
  "bands": ["all HF"],
  "modes": ["any"],
  "category": "pota-sota",
  "notes": "POTA's seasonal Support Your Parks operating weekend (Saturday and Sunday UTC)."
}
```

…and the same shape for `pota-syp-spring` (`nth-weekend-of:4:3`),
`pota-syp-summer` (`nth-weekend-of:7:3`), `pota-syp-autumn`
(`nth-weekend-of:10:3`). Only the `id`, `name`, `whenRule`, and
`whenComputed` month differ between the four.

**No resolver work needed.** Verified 2026-07-18 against
`src/services/ContestsDb.ts`: `nth-weekend-of:<MM>:<n>` is already parsed
(line ~162) and `nthFullWeekendOf()` (line ~85) already implements the same
"full weekend" semantics as desktop — a weekend counts only when BOTH the
Saturday and its Sunday fall inside the month, `-1` means last, and an
out-of-range `n` returns null. This is purely a data swap.

## Why desktop can't push the correction over the wire

`contestCatalogExtras` in the settings blob only carries **server-pushed
events with explicit start/end dates** (events/active.json synthesis) — it
deliberately does not re-ship the recurring bundled catalog, which each
platform owns locally. A recurring-rule entry has no explicit dates to
synthesize, so the stale bundle can only be fixed in the app.

## Side effect worth knowing: contest history labels

Desktop's `contestHistory` blob (read-only on the phone) keys per-contest
QSO summaries by **catalog id**, and the phone labels those ids from its own
bundle. Desktop now emits SYP history under the four `pota-syp-*` ids, so on
today's app those rows have no catalog match. The data swap fixes that too.
Drop `pota-plaque` entirely — desktop did; nothing references the old id.

## Verification (mirror of desktop's `test/contests-db-test.js`)

Resolver outputs to assert after the swap (start date, UTC):

| Rule | Year | Expected start |
|---|---|---|
| `nth-weekend-of:7:3` | 2026 | **2026-07-18** (the live event) |
| `nth-weekend-of:10:3` | 2026 | 2026-10-17 |
| `nth-weekend-of:1:3` | 2027 | 2027-01-16 |
| `nth-weekend-of:4:3` | 2027 | 2027-04-17 |
| `nth-weekend-of:10:-1` | 2026 | 2026-10-24 — NOT Oct 31 (Sat Oct 31's Sunday is Nov 1, so it's not a full weekend) |
| `nth-weekend-of:10:5` | 2026 | null (no 5th full weekend) |

UI checks: Contests tab shows "Summer Support Your Parks Weekend" as
**running now** through Sunday (Jul 19, 48h from Sat 00:00 UTC), and the next
SYP shown after this weekend is Autumn, Oct 17 — nothing on Aug 1.

## Longer-term (optional, noted for the roadmap)

This is the second time the two bundled catalogs drifted (events roadmap
"Phase C" already tracks catalog unification ideas). If drift keeps biting,
the catalogs could be generated from one shared source at build time — but
that's a roadmap conversation, not part of this fix.
