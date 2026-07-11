'use strict';
/**
 * Unified Events/Contests registry — Phase A (events-roadmap #1, 2026-07-09).
 *
 * POTACAT grew two catalogs: server-fetched EVENTS (boards, banner, stamping;
 * ids like "13col-2026") and the static CONTESTS catalog (data/contests.json,
 * What's-Next buckets, contest history; ids like "13-colonies"). The same
 * real-world happening can exist in both — 13 Colonies does — with no link
 * between the ids. This module is the bridge, and the eventual single home:
 *
 *   Phase A (built 2026-07-09): alias resolution (event id ⇄ contest id) +
 *     unifiedCatalog() merge with supersedence marking. Consumers activate
 *     one at a time: contest-history provenance uses the alias map so a QSO
 *     stamped "13col-2026" attributes to the "13-colonies" catalog contest.
 *   Phase B (built 2026-07-10): the Contests view + contest-history are
 *     server-drivable — get-contests renders catalog rows linked to their
 *     superseding events (built with A) AND synthesizeContestEntry() rows
 *     for scheduled events with no catalog counterpart, so pushing a
 *     definition to events/active.json surfaces it in the Contests view +
 *     What's-Next + phone CNTST history with no desktop release. Remaining
 *     (Phase C): contests.json entries migrate to kind-tagged records;
 *     server schema carries `contestId` natively (client half of the
 *     conditional-GET is already live in fetchActiveEvents).
 *
 * Aliases resolve in order: the event's own `contestId` field (server-side,
 * additive — the long-term mechanism) → the builtin map (known pairs until
 * the server ships the field). Year-suffixed event ids ("13col-2026") map
 * with and without the suffix.
 */

// Known event-id → contest-id pairs. Keep SMALL: this is the bootstrap until
// potacat.com's events carry `contestId`; new pairs belong on the server.
// '13colonies' is the PRODUCTION id (BUILTIN_EVENTS + every APP_POTACAT_EVENT
// stamp written during 13 Colonies week uses '13colonies-2026' — website
// agent audit 2026-07-09); it must stay here even after the server ships
// contestId, because stamped-QSO history must keep attributing after the
// event leaves active.json (~14-day retention).
const BUILTIN_ALIASES = {
  '13colonies': '13-colonies',
  '13col': '13-colonies', // pre-audit guess, kept harmlessly for any stray data
};

/** Strip a trailing "-YYYY" year suffix from an event id. */
function baseEventId(id) {
  return String(id || '').replace(/-\d{4}$/, '');
}

/** The contests-catalog id an event maps to, or null. */
function contestIdForEvent(ev) {
  if (!ev || !ev.id) return null;
  if (ev.contestId) return ev.contestId;
  return BUILTIN_ALIASES[ev.id] || BUILTIN_ALIASES[baseEventId(ev.id)] || null;
}

/**
 * Map of eventId → contestId for every event that resolves to a catalog
 * contest. Feeds contest-history's provenance path (a stamp naming an event
 * id attributes to the aliased contest).
 */
function buildEventAliasMap(events, contests) {
  const contestIds = new Set((contests || []).map((c) => c && c.id).filter(Boolean));
  const map = new Map();
  for (const ev of events || []) {
    const cid = contestIdForEvent(ev);
    if (cid && contestIds.has(cid)) map.set(ev.id, cid);
  }
  return map;
}

/** Unified `kind` for an event definition (by board semantics). */
function kindForEvent(ev) {
  const board = (ev && (ev.board || (ev.tracking && ev.tracking.type))) || 'regions';
  if (board === 'checklist') return 'special-event';
  if (board === 'regions') return 'award-window';
  return 'contest-window'; // counter: participation window, no identity
}

/** Unified `kind` for a contests-catalog entry. */
function kindForContest(c) {
  return (c && c.category === 'special-event') ? 'special-event' : 'contest';
}

/**
 * Merge both catalogs into one list. Contests superseded by a live event
 * definition (via alias) are KEPT but marked `supersededBy: <eventId>` so
 * views can collapse the duplicate instead of double-listing 13 Colonies.
 *
 * @returns Array<{ id, kind, name, source: 'events'|'contests',
 *                  supersededBy?, def }>
 */
function unifiedCatalog(contests, events) {
  const out = [];
  const aliasByContest = new Map(); // contestId -> eventId
  for (const ev of events || []) {
    const cid = contestIdForEvent(ev);
    if (cid) aliasByContest.set(cid, ev.id);
    out.push({ id: ev.id, kind: kindForEvent(ev), name: ev.name || ev.id, source: 'events', def: ev });
  }
  for (const c of contests || []) {
    if (!c || !c.id) continue;
    const entry = { id: c.id, kind: kindForContest(c), name: c.name || c.id, source: 'contests', def: c };
    if (aliasByContest.has(c.id)) entry.supersededBy = aliasByContest.get(c.id);
    out.push(entry);
  }
  return out;
}

/**
 * The real ADIF CONTEST_ID for an event, or null. Set ONLY when the event
 * aliases to a contests-catalog entry that explicitly declares
 * `adifContestId` (a value from the ADIF Contest_ID enumeration — curated,
 * never guessed: "13-colonies" has none because it isn't in the vocabulary
 * and inventing one upsets downstream loggers). This is what lets stamping
 * write a genuine CONTEST_ID for kind-contest happenings while special
 * events keep riding APP_POTACAT_EVENT.
 */
function adifContestIdForEvent(ev, contests) {
  const cid = contestIdForEvent(ev);
  if (!cid) return null;
  const c = (contests || []).find((x) => x && x.id === cid);
  return (c && c.adifContestId) || null;
}

/**
 * Phase B — the server-drivable half of the Contests view: a scheduled event
 * with NO contests-catalog counterpart (WRTC 2026 was the motivating case)
 * synthesizes a contest-shaped row so pushing a definition to
 * events/active.json makes it "appear for the user" everywhere — Contests
 * view + What's-Next buckets AND (via `explicitWindows`) the phone's CNTST
 * history once stamped QSOs exist. Catalog-aliased events return null: their
 * catalog row already renders, linked via supersedence.
 *
 * Optional event-def fields pass through when the server provides them
 * (category, sponsor, bands, modes, notes, rulesUrl, whenRule); category
 * defaults by kind to a key the desktop filter menu already knows. Unknown
 * categories still render (the view treats them as visible, raw-key label)
 * so a future server-side category is additive, not breaking.
 */
function synthesizeContestEntry(ev, contests) {
  if (!ev || !ev.id) return null;
  if (contestIdForEvent(ev)) return null; // catalog row renders it (superseded link)
  const sched = (ev.schedule || [])
    .filter((s) => s && s.start && s.end)
    .slice()
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  if (!sched.length) return null; // unscheduled → Events board only
  if ((contests || []).some((c) => c && c.id === ev.id)) return null; // id collision — catalog wins
  const first = sched[0];
  const last = sched[sched.length - 1];
  const kind = kindForEvent(ev);
  const durationHours = Math.max(1, Math.round(
    (new Date(last.end).getTime() - new Date(first.start).getTime()) / 3600000));
  return {
    id: ev.id,
    name: ev.name || ev.id,
    sponsor: ev.sponsor || '',
    website: ev.url || '',
    rulesUrl: ev.rulesUrl || '',
    whenRule: ev.whenRule || '',
    durationHours,
    bands: Array.isArray(ev.bands) ? ev.bands : [],
    modes: Array.isArray(ev.modes) ? ev.modes : [],
    category: ev.category || (kind === 'special-event' ? 'special-event' : 'operating-event'),
    notes: ev.notes || '',
    kind,
    source: 'events',
    start: new Date(first.start).toISOString(),
    end: new Date(last.end).toISOString(),
    // Explicit one-shot windows for contest-history (whenComputed rules
    // don't exist for pushed events — see buildContestHistory).
    explicitWindows: sched.map((s) => ({ start: s.start, end: s.end })),
  };
}

module.exports = {
  BUILTIN_ALIASES,
  baseEventId,
  contestIdForEvent,
  buildEventAliasMap,
  kindForEvent,
  kindForContest,
  adifContestIdForEvent,
  unifiedCatalog,
  synthesizeContestEntry,
};
