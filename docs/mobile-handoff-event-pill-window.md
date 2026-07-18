# Mobile Handoff — Event pills only for short events (≤5-day window) + per-pill dismiss

**Audience:** POTACAT mobile (iOS / Android) team
**Scope:** UI policy port, mobile-side only. No wire-contract changes, no
desktop work pending — the events catalog already carries everything needed.
**Origin:** K3SBP, 2026-07-17 — the ARRL America 250 WAS pill sat parked at
the top of the desktop for a months-long event. Pills are wanted for
weekend-scale contests only; long events already have the banner (which can
be hidden). Desktop shipped the policy in v1.9.11 (`potacat-dev` commit
`6c497e4`, renderer/app.js ~16280–16314); mobile should adopt the same rules
so the two surfaces agree on which events earn a pill.

---

## The policy (mirror exactly)

An event earns a pill only when ALL of these hold:

1. **Tracked/opted-in** and **near-active** — `now` is within the grace
   period of one of the event's schedule windows:
   `start − 24h ≤ now ≤ end + 24h`.
2. **The window that makes it near-active spans ≤ 120 hours (5 days).**
   This is evaluated **per schedule window, not per event**: an event whose
   `schedule` array contains a weekend sub-window inside a months-long
   campaign still earns a pill *during that weekend* — but an event whose
   only qualifying window is weeks long never does.
3. **Not dismissed on this device** (below).

Constants — keep numerically identical to desktop so the platforms never
disagree about the same event:

```
EVENT_CHIP_MAX_WINDOW_MS = 120 * 3600 * 1000   // 5 days — umbrella-contest threshold
EVENT_BADGE_GRACE_MS     = 24 * 3600 * 1000    // near-active grace, both ends
```

Desktop's eligibility check, for reference (renderer/app.js:16303):

```js
function _eventChipEligible(ev) {
  if (_eventChipDismissedIds().includes(ev.id)) return false;
  const now = Date.now();
  return (ev.schedule || []).some((s) => {
    const start = new Date(s.start).getTime();
    const end = new Date(s.end).getTime();
    if (!(now >= start - EVENT_BADGE_GRACE_MS && now <= end + EVENT_BADGE_GRACE_MS)) return false;
    return (end - start) <= EVENT_CHIP_MAX_WINDOW_MS;
  });
}
```

## Per-pill dismissal

Every pill gets a dismiss control (desktop uses an ✕ on the chip). Rules:

- Dismissing hides **only the pill** for that event — the banner, badges,
  checklist/board, and notifications are untouched.
- Dismissals are a **device-local UI preference**. Do NOT sync them through
  settings or the wire — this deliberately matches the Event Focus contract
  (focus itself is session-only and never synced; hiding a pill is a local
  preference). Desktop persists to localStorage
  (`pota-cat-event-chip-dismissed`); use the mobile equivalent.
- **Prune the dismissed list to live event ids** (ids present in the current
  events catalog) every time you write it, so it can't grow forever. Prune
  against the catalog, not against subscriptions — an unsubscribed event's
  dismissal should fall out when the event leaves the catalog, not before.
- A dismissed event that later gets a NEW short window (e.g. next quarter's
  Support Your Parks) stays dismissed only if it is the SAME event id and
  that id remained in the catalog the whole time; ids that left the catalog
  and return later arrive undismissed. (Same behavior as desktop — the
  pruning gives you this for free.)

## Data source

Everything needed is already on the phone: the events catalog
(`availableEvents` in the settings blob) carries each event's `schedule`
array of `{start, end}` windows, and subscriptions ride
`eventSubscriptions`. This is a pure client-side filter in the pill
renderer.

## Worked examples

| Event | Window | Pill? |
|---|---|---|
| Summer Support Your Parks | 48 h | Yes — the target case |
| Typical weekend contest (WRTC, QSO parties) | 24–48 h | Yes |
| 13 Colonies | ~7 days (168 h) | No — banner/checklist only |
| ARRL America 250 WAS | months | No — the originating complaint |
| Long campaign with weekend sub-windows in `schedule` | weekend entries ≤120 h | Yes, during those weekends only |

## Edge cases (desktop behavior — match it)

- No `schedule` array, or empty: never near-active → no pill (unchanged).
- Malformed dates (`NaN`): every comparison is false → no pill, no crash.
- The 24 h grace applies on both ends, so a pill may appear up to a day
  before the window opens and linger up to a day after it closes — this is
  deliberate and matches the badge/banner grace, so don't "fix" it.
- Do NOT apply the 120 h limit to banners, badges, or notifications — it
  governs pills only. Long events keep their banner; that's the intended
  home for them.
