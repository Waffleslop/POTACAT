/**
 * One logged QSO record -> one worked-QSOs entry: the shape every
 * "have I worked this" check reads (spot checks, the worked matrix, the
 * worked roster). lib/adif.js parseWorkedQsos builds the full list with it,
 * and ECHOCAT Web merges each `qso-added` record with it (#731), so the full
 * list and a live addition can never disagree.
 *
 * Dual-mode: require() in Node/tests, window.WorkedEntry in the pages
 * (inlined into ECHOCAT Web by remote-server, next to adif-mode.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./adif-mode'));
  else root.WorkedEntry = factory(root.AdifMode);
})(typeof self !== 'undefined' ? self : this, function (AdifMode) {
  'use strict';

  function up(v) { return String(v == null ? '' : v).toUpperCase(); }

  /** A record counts as confirmed (QSL, LoTW, eQSL, or N3FJP's confirmed-by). */
  function isConfirmedRecord(f) {
    if (!f) return false;
    var y = function (k) { return up(f[k]) === 'Y'; };
    return y('QSL_RCVD') || y('LOTW_QSL_RCVD') || y('EQSL_QSL_RCVD')
      || /B/.test(up(f.APP_N3FJP_QSL_CONF_BY_R));
  }

  /** Logged MODE/SUBMODE -> the app mode, with USB/LSB as SSB. */
  function workedMode(mode, submode) {
    if (!mode) return '';
    var m = AdifMode.adifAppMode(mode, submode);
    if (m === 'USB' || m === 'LSB') return 'SSB';
    return m;
  }

  /**
   * @param {object} f  ADIF fields (upper-case keys: CALL, QSO_DATE, BAND, ...)
   * @param {function} [freqToBand]  MHz -> band name; gives a BAND-less record its freqBand (#683)
   * @returns {{call:string, entry:object}|null}
   */
  function fromRecord(f, freqToBand) {
    if (!f || !f.CALL) return null;
    var call = up(f.CALL);
    // ref = the OTHER station's park (SIG_INFO, e.g. P2P). myRef = MY park for
    // this QSO (MY_SIG_INFO / MY_POTA_REF): the activator log's PREV badge
    // tells this activation's contacts from prior work by it (Casey 2026-06-16).
    var entry = {
      date: f.QSO_DATE || '',
      ref: up(f.SIG_INFO || f.POTA_REF || ''),
      myRef: up(f.MY_SIG_INFO || f.MY_POTA_REF || ''),
      band: up(f.BAND || ''),
      mode: workedMode(f.MODE, f.SUBMODE),
    };
    // Worked roster inputs: set only when present, so the payload grows by
    // nothing for the usual record.
    var state = String(f.STATE || '').trim().toUpperCase();
    if (state) entry.state = state;
    if (isConfirmedRecord(f)) entry.confirmed = true;
    if (!entry.band && f.FREQ && typeof freqToBand === 'function') {
      var fb = freqToBand(parseFloat(f.FREQ));
      if (fb) entry.freqBand = String(fb).toUpperCase();
    }
    return { call: call, entry: entry };
  }

  function sameQso(a, b) {
    return !!a && !!b && a.date === b.date && a.band === b.band && a.mode === b.mode
      && (a.ref || '') === (b.ref || '');
  }

  /**
   * Merge one logged record into a Map(call -> entries). When the call's last
   * entry is the same QSO (the full list already carried it, or the
   * worked-today copy arrived first) it is replaced by this fuller entry, not
   * counted twice. Returns the call, or '' when the record has no call.
   */
  function mergeRecord(map, f, freqToBand) {
    var r = fromRecord(f, freqToBand);
    if (!r || !map) return '';
    var list = map.get(r.call) || [];
    if (list.length && sameQso(list[list.length - 1], r.entry)) list[list.length - 1] = r.entry;
    else list.push(r.entry);
    map.set(r.call, list);
    return r.call;
  }

  return { isConfirmedRecord: isConfirmedRecord, workedMode: workedMode, fromRecord: fromRecord, mergeRecord: mergeRecord };
});
