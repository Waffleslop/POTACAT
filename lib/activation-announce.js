'use strict';
// Which logged contacts join the live activation list (GitHub #508).
//
// Every log surface writes through logContact, and logContact attaches the
// running activation's MY park(s). The activation window's live list (and
// its Export ADIF) only hears of a contact when someone tells it, so main
// tells it once, right after logContact, for every surface that does not
// list the contact itself: the Log window (Ctrl+L), the QSO log window,
// JTCAT, the WSJT-X bridge and ECHOCAT.
//
// The main window's own forms (the activation's Log button, the banner log
// and the spot log dialog) add their contact to the list themselves, so a
// save from the main window is never announced: that would list it twice.

/** Records of this contact that were logged at the running activation's
 *  MY park(s). `liveRefs` is [{ sig, ref }] (activationMyRefs); none = no
 *  activation, nothing to announce. A record with the operator's own,
 *  different MY park is not this activation's. */
function activationRecords(records, liveRefs) {
  if (!Array.isArray(records) || !Array.isArray(liveRefs) || !liveRefs.length) return [];
  const live = new Set();
  for (const r of liveRefs) {
    if (r && r.ref) live.add(`${String(r.sig || 'POTA').toUpperCase().trim()}|${String(r.ref).toUpperCase().trim()}`);
  }
  return records.filter((r) => r && r.mySig && r.mySigInfo
    && live.has(`${String(r.mySig).toUpperCase().trim()}|${String(r.mySigInfo).toUpperCase().trim()}`));
}

/** Where a saved contact is announced.
 *  - listed: the saving surface puts it in the live list itself (the main
 *    window's forms) -> nowhere.
 *  - origin 'ws-log-qso' (ECHOCAT): the phone's session list already got it
 *    from the log handler -> the activation window only.
 *  - anything else -> the activation window and the phone's session list. */
function announceTargets(opts) {
  opts = opts || {};
  if (opts.listed) return { window: false, session: false };
  if (opts.origin === 'ws-log-qso') return { window: true, session: false };
  return { window: true, session: true };
}

/** One live-list row per callsign, as the activation's Log button adds:
 *  every record of that call (multi-park expansion) rides in qsoDataList. */
function groupByCall(records) {
  const out = [];
  const seen = new Map();
  for (const r of records || []) {
    if (!r) continue;
    const call = String(r.callsign || '').toUpperCase();
    if (!seen.has(call)) { const g = { callsign: r.callsign, records: [] }; seen.set(call, g); out.push(g); }
    seen.get(call).records.push(r);
  }
  return out;
}

module.exports = { activationRecords, announceTargets, groupByCall };
