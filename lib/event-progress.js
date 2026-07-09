'use strict';

// Pure date-window matcher for event-progress rebuilds (scanLogForEvents).
//
// Event progress ("did I work this station during the event?") is a multi-day
// checklist, so a logged QSO's membership in a schedule window is decided at UTC
// *day* granularity, inclusive of the window's start and end days.
//
// This deliberately replaces the earlier instant-precise comparison, which
// synthesized every logged QSO at 12:00Z and required `instant >= start`. For a
// window that begins or ends at a non-midnight UTC time — 13 Colonies runs
// 1300z Jul 1 → 0400z Jul 8 — that discarded every start-day QSO (noon precedes
// the 1300z start) and every end-day QSO (noon follows the 0400z end), wiping
// the checklist on the next launch when the log is re-scanned. The live marker
// (checkEventQso) uses the real clock, so stations ticked correctly during the
// session and then vanished on restart.
//
// Regions/WAS windows are already full-day (00:00:00–23:59:59), so day-level
// matching yields identical results there. Counter events don't use this path.

/**
 * @param {string} qsoDateStr - ADIF QSO_DATE, "YYYYMMDD"
 * @param {{start:string,end:string}} entry - schedule entry with ISO start/end
 * @returns {boolean} true if the QSO's UTC day is within [start-day, end-day] inclusive
 */
function qsoDayInScheduleEntry(qsoDateStr, entry) {
  if (!qsoDateStr || qsoDateStr.length < 8 || !entry) return false;
  const day = `${qsoDateStr.slice(0, 4)}-${qsoDateStr.slice(4, 6)}-${qsoDateStr.slice(6, 8)}`;
  const startDay = String(entry.start || '').slice(0, 10);
  const endDay = String(entry.end || '').slice(0, 10);
  if (!startDay || !endDay) return false;
  return day >= startDay && day <= endDay;
}

// ---------------------------------------------------------------------------
// Identity-proven event matching (2026-07-09). Shared by checkEventQso's
// progress marking AND saveQsoRecord's event stamping so the two can't drift.
// ---------------------------------------------------------------------------

/** Checklist boards: exact station call (or CALL/suffix) against tracking items. */
function matchChecklistItem(items, call) {
  const c = String(call || '').toUpperCase();
  if (!c) return null;
  return (items || []).find((it) =>
    it && it.id && (c === it.id.toUpperCase() || c.startsWith(it.id.toUpperCase() + '/'))) || null;
}

/** Regions/WAS boards: callsign pattern list ("W2S/*" wildcard or exact). */
function matchRegionPatterns(patterns, call) {
  const c = String(call || '').toUpperCase();
  if (!c) return false;
  return (patterns || []).some((p) =>
    String(p).endsWith('/*') ? c.startsWith(String(p).slice(0, -1)) : c === String(p).toUpperCase());
}

/** The schedule entry covering `now`, or null. */
function activeScheduleEntry(ev, now) {
  return ((ev && ev.schedule) || []).find((s) =>
    now >= new Date(s.start) && now < new Date(s.end)) || null;
}

/**
 * Should this QSO carry an event stamp in the log?
 *
 * Only IDENTITY-PROVEN matches stamp: checklist boards (the worked call IS an
 * event station — 13 Colonies K2A…GB13COL) and regions boards (the call
 * matches the event's pattern list — America250/WAS-style). Counter boards
 * ("any QSO during the window counts") are deliberately excluded — being on
 * the air during a contest weekend is not proof of participation, and a false
 * CONTEST/event tag in the log is worse than a missing one. Gated on the
 * operator tracking the event (optedIn), mirroring progress marking.
 *
 * @returns {null | {eventId, eventName, item, itemName}}
 */
function matchEventQsoForStamp(activeEvents, eventsState, call, now) {
  for (const ev of activeEvents || []) {
    const state = eventsState && eventsState[ev.id];
    if (!state || !state.optedIn) continue;
    const entry = activeScheduleEntry(ev, now);
    if (!entry) continue;
    const board = ev.board || (ev.tracking && ev.tracking.type) || 'regions';
    if (board === 'checklist') {
      const item = matchChecklistItem(ev.tracking && ev.tracking.items, call);
      if (item) return { eventId: ev.id, eventName: ev.name || ev.id, item: item.id, itemName: item.name || '' };
    } else if (board === 'regions') {
      if (matchRegionPatterns(ev.callsignPatterns, call)) {
        return { eventId: ev.id, eventName: ev.name || ev.id, item: entry.region || '', itemName: entry.regionName || '' };
      }
    }
    // board === 'counter': never stamp (see above)
  }
  return null;
}

module.exports = {
  qsoDayInScheduleEntry,
  matchChecklistItem,
  matchRegionPatterns,
  activeScheduleEntry,
  matchEventQsoForStamp,
};
