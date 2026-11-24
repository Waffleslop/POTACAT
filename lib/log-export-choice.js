/**
 * What "Export ADIF" in the Logbook exports (#698): everything shown, a UTC
 * time range, or the selected rows. The rules live here; the window only
 * reads its controls and the file is written by the one 'export-adif' handler.
 *
 *   parseRange({ fromDate, fromTime, toDate, toTime })
 *                         the From / To controls ('YYYY-MM-DD', 'HH:MM', UTC) as a
 *                         range, or { ok: false, error } in words for the dialog.
 *                         An empty time is the whole day. One end may be open.
 *   inRange(q, range)     QSO_DATE + TIME_ON (UTC) inside the range: the start is
 *                         included, the end is included to the minute (21:00
 *                         takes 21:00:59). TIME_ON may be HHMM or HHMMSS.
 *                         A QSO with no time is kept when its day is inside the
 *                         range's days: leaving a contact out of an export is
 *                         worse than one extra. A QSO with no date is never in.
 *   filterByRange(qsos, range)
 *                         the same records, in the same order. An invalid range
 *                         gives none.
 *   stampOf(q)            'YYYYMMDDHHMM', 'YYYYMMDD' (no time) or ''.
 *   fileName(choice)      the suggested file name: it says what is in the file.
 *   safeFileName(name)    main's check on a name that came from a window.
 *   shownLabel / selectedLabel / exportLabel / rangeNote
 *                         the dialog's words, with their counts.
 *   defaultWhat(selectedCount)
 *                         the choice that starts ticked.
 *
 * Read-only: nothing here writes or rebuilds a record.
 *
 * Dual-mode: a CommonJS module in Node/tests, window.LogExportChoice in the Logbook.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LogExportChoice = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_NAME = 'potacat_export.adi';

  function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

  /** 'YYYYMMDD' from QSO_DATE or a date control, or ''. */
  function dayOf(v) {
    var d = digits(v);
    return d.length === 8 ? d : '';
  }

  /** 'HHMM' from TIME_ON (HHMM or HHMMSS) or a time control, or '' when there is none. */
  function minuteOf(v) {
    var d = digits(v);
    return d.length >= 4 ? d.slice(0, 4) : '';
  }

  function stampOf(q) {
    if (!q) return '';
    var day = dayOf(q.QSO_DATE);
    if (!day) return '';
    return day + minuteOf(q.TIME_ON);
  }

  function parseRange(input) {
    input = input || {};
    var fromRaw = String(input.fromDate || '').trim();
    var toRaw = String(input.toDate || '').trim();
    var fromDay = dayOf(fromRaw);
    var toDay = dayOf(toRaw);
    var fromMin = minuteOf(input.fromTime);
    var toMin = minuteOf(input.toTime);
    function bad(error) { return { ok: false, error: error }; }
    if ((fromRaw && !fromDay) || (toRaw && !toDay)) return bad('Choose a From or a To date.');
    if (fromMin && !fromDay) return bad('Add a date for the From time.');
    if (toMin && !toDay) return bad('Add a date for the To time.');
    if (!fromDay && !toDay) return bad('Choose a From or a To date.');
    var from = fromDay ? fromDay + (fromMin || '0000') : '';
    var to = toDay ? toDay + (toMin || '2359') : '';
    if (from && to && from > to) return bad('From is after To.');
    return {
      ok: true,
      from: from, to: to,
      fromDay: fromDay, toDay: toDay,
      fromTime: fromMin, toTime: toMin,
    };
  }

  function inRange(q, range) {
    if (!range || !range.ok) return false;
    var s = stampOf(q);
    if (!s) return false;
    if (s.length === 8) {
      // No time on the record: judge it by its day alone.
      if (range.fromDay && s < range.fromDay) return false;
      if (range.toDay && s > range.toDay) return false;
      return true;
    }
    if (range.from && s < range.from) return false;
    if (range.to && s > range.to) return false;
    return true;
  }

  function filterByRange(qsos, range) {
    if (!Array.isArray(qsos) || !range || !range.ok) return [];
    return qsos.filter(function (q) { return inRange(q, range); });
  }

  function dashed(day) { return day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6, 8); }
  function endName(day, time) { return dashed(day) + (time ? '_' + time + 'Z' : ''); }

  function fileName(choice) {
    choice = choice || {};
    if (choice.what === 'selected') {
      var n = Math.max(0, parseInt(choice.count, 10) || 0);
      return 'potacat_selected_' + n + (n === 1 ? '_qso' : '_qsos') + '.adi';
    }
    if (choice.what === 'range' && choice.range && choice.range.ok) {
      var r = choice.range;
      var a = r.fromDay ? endName(r.fromDay, r.fromTime) : '';
      var b = r.toDay ? endName(r.toDay, r.toTime) : '';
      if (a && b) return 'potacat_' + a + '_to_' + b + '.adi';
      if (a) return 'potacat_from_' + a + '.adi';
      if (b) return 'potacat_to_' + b + '.adi';
    }
    return DEFAULT_NAME;
  }

  /** A name from a window is used only when it is one fileName() could have made. */
  function safeFileName(name) {
    if (typeof name !== 'string' || name.length > 80) return DEFAULT_NAME;
    return /^potacat_[A-Za-z0-9_-]+\.adi$/.test(name) ? name : DEFAULT_NAME;
  }

  function qsos(n) { return n === 1 ? 'QSO' : 'QSOs'; }

  function shownLabel(count, filtered) {
    return filtered ? 'The ' + count + ' ' + qsos(count) + ' shown' : 'All ' + count + ' ' + qsos(count);
  }
  function selectedLabel(count) { return 'The ' + count + ' selected ' + qsos(count); }
  function exportLabel(count) { return count > 0 ? 'Export ' + count + ' ' + qsos(count) : 'Export'; }
  function rangeNote(count, shown, filtered) {
    if (!count) return 'No QSOs in this range';
    return count + ' ' + qsos(count) + ' in this range' + (filtered ? ', of the ' + shown + ' shown' : '');
  }

  /** One click on a row selects it, so one selected row is not a request; two or more are. */
  function defaultWhat(selectedCount) { return selectedCount >= 2 ? 'selected' : 'shown'; }

  return {
    DEFAULT_NAME: DEFAULT_NAME,
    stampOf: stampOf,
    parseRange: parseRange,
    inRange: inRange,
    filterByRange: filterByRange,
    fileName: fileName,
    safeFileName: safeFileName,
    shownLabel: shownLabel,
    selectedLabel: selectedLabel,
    exportLabel: exportLabel,
    rangeNote: rangeNote,
    defaultWhat: defaultWhat,
  };
});
