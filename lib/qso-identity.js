/**
 * Which QSO a Logbook edit or delete means (#988).
 *
 * The Logbook (desktop pop-out, ECHOCAT Web, the phone) names a record by
 * its position in the log file (idx). A position goes stale the moment the
 * log changes elsewhere, and in #988 the pop-out's own positions went stale
 * after its first delete: every later delete removed a different QSO. So a
 * caller now sends the record's identity with the idx, and the main process
 * acts only on a record that matches it.
 *
 * The identity is the record's own fields, echoed back as received:
 *   APP_POTACAT_UUID, CALL, QSO_DATE, TIME_ON, BAND, MODE
 * (the phone's older guard fields expectCall / expectTime read as CALL and
 * TIME_ON). A record is the QSO an identity names when:
 *   - both carry a valid uuid: the uuids are equal (nothing else counts);
 *   - otherwise (an older non-Cloud log, another program's ADIF, a record
 *     that got its uuid on its first edit): every one of CALL, QSO_DATE,
 *     TIME_ON, BAND, MODE that the identity carries equals the record's,
 *     compared case- and spacing-blind, TIME_ON as HHMMSS (HHMM = HHMM00).
 *
 * locate() prefers the identity over the index: the record at idx when it
 * matches, else the one record in the log that matches. None, or more than
 * one, is refused, so a stale index can never edit or delete another QSO.
 * No identity at all (an older client) keeps the index-only behaviour.
 *
 * Dual-mode: require() in main and tests, window.QsoIdentity in the pages.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QsoIdentity = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY_FIELDS = ['CALL', 'QSO_DATE', 'TIME_ON', 'BAND', 'MODE'];
  var FIELDS = ['APP_POTACAT_UUID'].concat(KEY_FIELDS);
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var NOT_FOUND = 'Nothing was changed: that QSO is no longer in the log.';
  var AMBIGUOUS = 'Nothing was changed: the log changed since the Logbook was loaded. Try again.';

  function str(v) { return v == null ? '' : String(v).trim(); }
  function present(v) { return str(v) !== ''; }
  function uuidOf(rec) {
    var u = rec ? str(rec.APP_POTACAT_UUID) : '';
    return UUID_RE.test(u) ? u.toLowerCase() : '';
  }
  function norm(field, v) {
    var s = str(v);
    if (field === 'QSO_DATE') return s.replace(/\D/g, '');
    if (field === 'TIME_ON') { var d = s.replace(/\D/g, ''); return d.length === 4 ? d + '00' : d; }
    return s.toUpperCase();
  }

  /** The identity a caller sends for a record: those of its fields that are set. */
  function of(rec) {
    var out = {};
    if (!rec) return out;
    for (var i = 0; i < FIELDS.length; i++) {
      var k = FIELDS[i];
      if (present(rec[k])) out[k] = String(rec[k]);
    }
    return out;
  }

  /**
   * The identity a request carries: `identity`, else the phone's guard
   * fields (expectCall / expectTime), else null (an older client).
   */
  function fromRequest(msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (isIdentity(msg.identity)) return msg.identity;
    if (present(msg.expectCall)) {
      var id = { CALL: String(msg.expectCall) };
      if (present(msg.expectTime)) id.TIME_ON = String(msg.expectTime);
      return id;
    }
    return null;
  }

  /** Does `identity` name anything (a uuid or at least one key field)? */
  function isIdentity(identity) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
    if (uuidOf(identity)) return true;
    for (var i = 0; i < KEY_FIELDS.length; i++) if (present(identity[KEY_FIELDS[i]])) return true;
    return false;
  }

  /** Is `rec` the QSO `identity` names? */
  function matches(rec, identity) {
    if (!rec || !isIdentity(identity)) return false;
    var a = uuidOf(rec), b = uuidOf(identity);
    if (a && b) return a === b;
    var any = false;
    for (var i = 0; i < KEY_FIELDS.length; i++) {
      var k = KEY_FIELDS[i];
      if (!present(identity[k])) continue;
      if (norm(k, rec[k]) !== norm(k, identity[k])) return false;
      any = true;
    }
    return any;
  }

  /**
   * Which record of `qsos` an edit or delete for (idx, identity) means.
   * @returns {{ index: number, moved?: boolean, legacy?: boolean } | { error: string, reason: string }}
   *   moved = found by identity at another position; legacy = no identity was
   *   sent (an older client), so the index alone decided, as before #988.
   *   reason: 'invalid-index' | 'not-found' | 'ambiguous'.
   */
  function locate(qsos, idx, identity) {
    var list = Array.isArray(qsos) ? qsos : [];
    var i = typeof idx === 'number' ? idx : parseInt(idx, 10);
    var inRange = Number.isInteger(i) && i >= 0 && i < list.length;
    if (!isIdentity(identity)) {
      return inRange ? { index: i, legacy: true } : { error: 'Invalid index', reason: 'invalid-index' };
    }
    if (inRange && matches(list[i], identity)) return { index: i };
    var found = -1;
    for (var j = 0; j < list.length; j++) {
      if (!matches(list[j], identity)) continue;
      if (found !== -1) return { error: AMBIGUOUS, reason: 'ambiguous' };
      found = j;
    }
    if (found === -1) return { error: NOT_FOUND, reason: 'not-found' };
    return { index: found, moved: true };
  }

  return {
    FIELDS: FIELDS, of: of, fromRequest: fromRequest, isIdentity: isIdentity,
    matches: matches, locate: locate, NOT_FOUND: NOT_FOUND, AMBIGUOUS: AMBIGUOUS,
  };
});
