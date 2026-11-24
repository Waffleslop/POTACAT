'use strict';

// Cloud delete guard (GitHub #245).
//
// A QSO deleted here is deleted from the Cloud copy, and from that copy every
// other device deletes it too. Operators with more than one station
// callsign have lost large parts of their log to delete pushes they did not
// mean, and no single code path is proven to be the cause. So the push itself is guarded, whatever wrote the delete (the
// Logbook, an ECHOCAT delete, Find Duplicates, the pull's duplicate guard):
//
//   1. A delete for a QSO whose STATION_CALLSIGN is another operator profile
//      on this PC is never pushed on its own. That QSO is the other
//      profile's; this profile's log should not hold it at all.
//   2. More than DELETE_LIMIT deletes in WINDOW_MS (counting the ones the
//      Cloud already took in that window) are never pushed on their own. All
//      of the pending ones are held, not the first 25: a mass delete that
//      trickles out 25 at a time is still a mass delete.
//
// Held deletes stay in the sync journal (the local log has already dropped
// the record; the Cloud copy is untouched) until the operator answers one
// plain dialog that names the count and the station callsigns. "Delete from
// Cloud" marks them confirmed and they go; "Keep in Cloud" marks them
// declined: they stay in the journal, are never pushed and are not asked
// about again. Creates and updates are never held.
//
// Why 25 an hour: an operator deletes a few QSOs at a time — a mistyped call,
// a busted contact, now and then a whole activation, which costs one dialog
// click. The unintended deletes this guards against ran to hundreds and
// thousands; a limit in the hundreds would let the smaller ones through.
//
// Pure: no Electron, no fs. cloud-ipc.js owns the journal, the dialog and the
// record of what was sent.

const DELETE_LIMIT = 25;
const WINDOW_MS = 60 * 60 * 1000;

const CONFIRMED = 'confirmed';
const DECLINED = 'declined';

const norm = (v) => {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return s || null;
};

/** The station callsign a journal entry's QSO was logged under, or null. */
function stationOf(entry) {
  return norm(entry && entry.adifFields && entry.adifFields.STATION_CALLSIGN);
}

/** Deletes sent within the window, from a list of epoch-ms send times. */
function recentCount(sentTimes, now, windowMs = WINDOW_MS) {
  if (!Array.isArray(sentTimes)) return 0;
  return sentTimes.filter((t) => Number.isFinite(t) && t > now - windowMs && t <= now).length;
}

/** Send times still inside the window (what is worth keeping on disk). */
function pruneSent(sentTimes, now, windowMs = WINDOW_MS) {
  return (Array.isArray(sentTimes) ? sentTimes : []).filter((t) => Number.isFinite(t) && t > now - windowMs && t <= now);
}

/**
 * Split pending journal entries into what may be pushed now and what is held.
 *
 * @param {object[]} entries - the journal view's entries, in journal order
 * @param {object} opts
 * @param {number} opts.now
 * @param {number[]} [opts.sentTimes] - when earlier deletes reached the Cloud
 * @param {Iterable<string>} [opts.otherProfiles] - every other profile on this PC
 * @param {number} [opts.limit]
 * @param {number} [opts.windowMs]
 * @returns {{ send: object[], held: object[], ask: object[], reason: string|null }}
 *   `held` is every delete not pushed this cycle; `ask` the held ones the
 *   operator has not answered yet (the dialog's subject).
 */
function planPush(entries, { now, sentTimes = [], otherProfiles = [], limit = DELETE_LIMIT, windowMs = WINDOW_MS } = {}) {
  const others = new Set([...otherProfiles].map(norm).filter(Boolean));
  const send = [];
  const held = [];
  const free = []; // deletes that need no answer if the volume allows

  for (const e of entries || []) {
    if (!e || e.action !== 'delete') { send.push(e); continue; }
    if (e.deleteGuard === CONFIRMED) { send.push(e); continue; }
    if (e.deleteGuard === DECLINED) { held.push(e); continue; }
    const st = stationOf(e);
    if (st && others.has(st)) { held.push(e); continue; }
    free.push(e);
  }

  const allowance = Math.max(0, limit - recentCount(sentTimes, now, windowMs));
  let reason = null;
  if (free.length > allowance) {
    held.push(...free);
    reason = 'volume';
  } else {
    send.push(...free);
  }
  if (!reason && held.some((e) => e.deleteGuard !== DECLINED)) reason = 'other-profile';

  // Keep journal order in what goes out.
  const order = new Map((entries || []).map((e, i) => [e, i]));
  send.sort((a, b) => order.get(a) - order.get(b));
  const ask = held.filter((e) => e.deleteGuard !== DECLINED);
  return { send, held, ask, reason };
}

/** Count per station callsign, largest first: [['LZ1ABC', 120], ['(none)', 3]]. */
function byStation(entries) {
  const m = new Map();
  for (const e of entries || []) {
    const k = stationOf(e) || '(no station callsign)';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The dialog's words. Plain, names the count and the callsigns, says what
 * each answer does. No emoji.
 * @returns {{ title, message, detail, buttons: string[], keepIndex: number, deleteIndex: number }}
 */
function dialogText(ask, { otherProfiles = [] } = {}) {
  const n = ask.length;
  const others = new Set([...otherProfiles].map(norm).filter(Boolean));
  const stations = byStation(ask);
  const list = stations.map(([call, c]) => `${call}: ${c}`).join(', ');
  const foreign = stations.filter(([call]) => others.has(call)).map(([call]) => call);
  const lines = [
    `${n} QSO${n === 1 ? ' was' : 's were'} deleted from this log and ${n === 1 ? 'is' : 'are'} waiting to be deleted from your POTACAT Cloud logbook too (${list}).`,
  ];
  if (foreign.length) {
    lines.push(`${foreign.join(', ')} ${foreign.length === 1 ? 'is another operator profile' : 'are other operator profiles'} on this computer. Deleting here would remove ${foreign.length === 1 ? 'its' : 'their'} QSOs from the Cloud and from every device.`);
  }
  lines.push('Keep in Cloud: the Cloud copies stay, and every other device keeps them.');
  lines.push('Delete from Cloud: they are removed from the Cloud and from every device that syncs.');
  return {
    title: 'POTACAT Cloud',
    message: `Delete ${n} QSO${n === 1 ? '' : 's'} from the Cloud?`,
    detail: lines.join('\n\n'),
    buttons: ['Keep in Cloud', `Delete ${n} from Cloud`],
    keepIndex: 0,
    deleteIndex: 1,
  };
}

/** One session-log line for what is held (stable for the same set). */
function heldLine(held) {
  const stations = byStation(held).map(([call, c]) => `${call} ${c}`).join(', ');
  return `[Cloud] sync: holding ${held.length} QSO deletion(s) (${stations}) — not sent to the Cloud until you confirm; the Cloud copies are untouched`;
}

module.exports = {
  DELETE_LIMIT, WINDOW_MS, CONFIRMED, DECLINED,
  planPush, byStation, dialogText, heldLine, recentCount, pruneSent, stationOf,
};
