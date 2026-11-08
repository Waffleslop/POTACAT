'use strict';
// When a forgotten activation ends (GitHub #147, Casey 2026-11-07): at the
// UTC day change or after 6 hours with no contacts, whichever comes first.
// An ECHOCAT activation that was never ended pulled 36 later home FT8
// contacts into the park log.
//
// Pure. main.js keeps the clock ({startedAt, lastContactAt, refs}) and asks
// decide() before a contact is attached to the activation and on a periodic
// tick. A contact belongs to whichever side of the end its OWN timestamp is
// on (contactTime), so one logged at 23:59:59 UTC is the activation's and one
// at 00:00:01 UTC is a home contact.

const IDLE_LIMIT_MS = 6 * 3600 * 1000;

const REASON_LOG = { day: 'UTC day changed', idle: 'no contacts for 6 hours' };
const REASON_NOTICE = { day: 'the UTC day changed', idle: 'no contacts for 6 hours' };

function nextUtcMidnight(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function startClock(now, refs) {
  return { startedAt: now, lastContactAt: 0, refs: String(refs || '') };
}

function noteContact(clock, t) {
  if (!clock) return clock;
  return { ...clock, lastContactAt: Math.max(Number(clock.lastContactAt) || 0, Number(t) || 0) };
}

/**
 * Is the activation still live at time t?
 * → { live, reason: null | 'day' | 'idle', endsAt }
 * A tie (the 6 hours run out exactly at midnight) reads as the day change.
 */
function decide(clock, t) {
  const startedAt = clock && Number(clock.startedAt);
  if (!clock || !Number.isFinite(startedAt) || startedAt <= 0) return { live: true, reason: null, endsAt: null };
  const dayEnd = nextUtcMidnight(startedAt);
  const lastActivity = Math.max(startedAt, Number(clock.lastContactAt) || 0);
  const idleEnd = lastActivity + IDLE_LIMIT_MS;
  const endsAt = Math.min(dayEnd, idleEnd);
  if (t < endsAt) return { live: true, reason: null, endsAt };
  return { live: false, reason: dayEnd <= idleEnd ? 'day' : 'idle', endsAt };
}

/** The contact's own time (epoch ms): qsoAt, else qsoDate + timeOn, else now. */
function contactTime(entry, now) {
  const e = entry || {};
  if (e.qsoAt != null) {
    const n = typeof e.qsoAt === 'number' ? e.qsoAt : Date.parse(e.qsoAt);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const date = String(e.qsoDate || '');
  const time = String(e.timeOn || '');
  if (/^\d{8}$/.test(date) && /^\d{4}(\d{2})?$/.test(time)) {
    const n = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8),
      +time.slice(0, 2), +time.slice(2, 4), time.length === 6 ? +time.slice(4, 6) : 0);
    if (Number.isFinite(n)) return n;
  }
  return now;
}

function refsText(refs) {
  const list = (refs || []).map(String).filter(Boolean);
  return list.length ? list.join(', ') : 'the park';
}

function logLine(refs, reason) {
  return `[Activation] ${refsText(refs)} ended automatically: ${REASON_LOG[reason] || reason}`;
}

function noticeText(refs, reason) {
  return `Your activation at ${refsText(refs)} ended automatically: ${REASON_NOTICE[reason] || reason}. Contacts from now on are logged as home contacts.`;
}

module.exports = { IDLE_LIMIT_MS, nextUtcMidnight, startClock, noteContact, decide, contactTime, logLine, noticeText };
