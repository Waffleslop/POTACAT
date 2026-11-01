/**
 * The worked grid in the log windows (GitHub #108, AE5JE, from OpsLog): the
 * bands and modes already worked with the callsign being logged, one row per
 * award family (CW / Phone / Digital, lib/worked-roster.js awardFamily), one
 * column per band. A cell is worked (POTACAT blue #4fc3f7) or confirmed
 * (green #4ecca3, LoTW or QSL received). Built from the same worked-QSO
 * entries every worked-before check reads ({band, mode, confirmed?}).
 * Dual-mode: require() in main/tests, window.WorkedMatrix in the Log QSO
 * window, the log pop-out and ECHOCAT Web (inlined by remote-server).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkedMatrix = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Always shown, in this order; any other band worked is added after.
  var HF_BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
  var BAND_ORDER = ['2200m', '630m'].concat(HF_BANDS, ['4m', '2m', '1.25m', '70cm', '33cm', '23cm', '13cm']);
  var FAMILIES = [['cw', 'CW'], ['phone', 'Phone'], ['digital', 'Digital']];

  function family(mode) {
    var m = String(mode == null ? '' : mode).trim().toUpperCase();
    if (!m) return '';
    if (m === 'SSB' || m === 'USB' || m === 'LSB' || m === 'AM' || m === 'FM' || m === 'FMN' ||
        m === 'DV' || m === 'DSTAR' || m === 'C4FM' || m === 'DMR' || m === 'FREEDV' || m === 'DIGITALVOICE' || m === 'PHONE') return 'phone';
    if (m === 'CW' || m === 'CWR') return 'cw';
    return 'digital';
  }
  function normBand(b) { return String(b == null ? '' : b).trim().toLowerCase(); }

  /** Entries for `call` and every other form of the same base call (K1ABC, K1ABC/P, W4/K1ABC). */
  function entriesForCall(map, call, baseCall) {
    var want = String(call || '').trim().toUpperCase();
    if (!want || !map) return [];
    var base = baseCall ? baseCall(want) : want;
    var out = [];
    var add = function (list) { if (Array.isArray(list)) for (var i = 0; i < list.length; i++) out.push(list[i]); };
    var it = typeof map.entries === 'function' ? map.entries() : Object.entries(map);
    for (var e of it) {
      var k = String(e[0]).toUpperCase();
      if (k === want || (baseCall && baseCall(k) === base)) add(e[1]);
    }
    return out;
  }

  /** @returns {{bands:string[], rows:{family,label,cells:Object<string,'worked'|'confirmed'>}[], total:number}} */
  function buildWorkedMatrix(entries) {
    var cells = { cw: {}, phone: {}, digital: {} };
    var seenBands = {};
    var total = 0;
    (entries || []).forEach(function (q) {
      if (!q) return;
      var f = family(q.mode), b = normBand(q.band);
      if (!f || !b) return;
      total++;
      seenBands[b] = true;
      if (q.confirmed) cells[f][b] = 'confirmed';
      else if (!cells[f][b]) cells[f][b] = 'worked';
    });
    var bands = HF_BANDS.slice();
    Object.keys(seenBands).forEach(function (b) { if (bands.indexOf(b) < 0) bands.push(b); });
    bands.sort(function (a, z) {
      var ia = BAND_ORDER.indexOf(a), iz = BAND_ORDER.indexOf(z);
      return (ia < 0 ? 999 : ia) - (iz < 0 ? 999 : iz);
    });
    return { bands: bands, rows: FAMILIES.map(function (f) { return { family: f[0], label: f[1], cells: cells[f[0]] }; }), total: total };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** The grid as HTML ('' for nothing to show unless opts.showEmpty). */
  function workedMatrixHtml(matrix, opts) {
    var o = opts || {};
    if (!matrix || !matrix.total) return o.showEmpty ? '<div class="wm-empty" style="font-size:11px;opacity:.7;">' + esc(o.emptyText || 'Not worked before') + '</div>' : '';
    var cellCss = 'padding:1px 4px;text-align:center;font-size:10px;min-width:22px;border:1px solid var(--border-primary, rgba(128,128,128,.35));';
    var h = '<table class="wm-table" style="border-collapse:collapse;font-family:monospace;margin-top:4px;" title="Bands and modes already worked with this call: W = worked, C = confirmed">';
    h += '<tr><th style="' + cellCss + 'text-align:left;"></th>';
    matrix.bands.forEach(function (b) { h += '<th style="' + cellCss + 'font-weight:600;">' + esc(b.replace(/m$/, '')) + '</th>'; });
    h += '</tr>';
    matrix.rows.forEach(function (r) {
      h += '<tr><th style="' + cellCss + 'text-align:left;font-weight:600;">' + esc(r.label) + '</th>';
      matrix.bands.forEach(function (b) {
        var st = r.cells[b];
        var css = st === 'confirmed' ? 'background:#4ecca3;color:#000;font-weight:700;' : st === 'worked' ? 'background:#4fc3f7;color:#000;' : '';
        h += '<td class="wm-' + (st || 'none') + '" style="' + cellCss + css + '">' + (st === 'confirmed' ? 'C' : st === 'worked' ? 'W' : '') + '</td>';
      });
      h += '</tr>';
    });
    return h + '</table>';
  }

  return { buildWorkedMatrix, workedMatrixHtml, entriesForCall, family, HF_BANDS };
});
