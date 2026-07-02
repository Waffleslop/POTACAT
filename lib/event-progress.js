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

module.exports = { qsoDayInScheduleEntry };
