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
 *   Phase A (this file): alias resolution (event id ⇄ contest id) +
 *     unifiedCatalog() merge with supersedence marking. Consumers activate
 *     one at a time: contest-history provenance uses the alias map so a QSO
 *     stamped "13col-2026" attributes to the "13-colonies" catalog contest.
 *   Phase B (planned): Contests view + banner + ECHOCAT catalog read
 *     unifiedCatalog(); contests.json entries migrate to kind-tagged
 *     records; server schema carries `contestId` natively.
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

module.exports = {
  BUILTIN_ALIASES,
  baseEventId,
  contestIdForEvent,
  buildEventAliasMap,
  kindForEvent,
  kindForContest,
  adifContestIdForEvent,
  unifiedCatalog,
};
