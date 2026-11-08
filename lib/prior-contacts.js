/**
 * Prior contacts card (GitHub #154, hoogskev / nj2dx): the "Prior contacts"
 * item in the hunter table's and the FT8 decode list's right-click menus.
 * A small read-only card: worked N times and the last contact, the band/mode
 * grid (lib/worked-matrix.js), the last five contacts with their parks. The
 * data comes from main's 'prior-contacts' request (the log index, never QRZ).
 * workedHoverText() is the worked check mark's hover in the hunter table,
 * from the worked entries the table already holds.
 * Dual-mode: require() in tests, window.PriorContacts in the main window and
 * the JTCAT pop-out (load lib/worked-matrix.js first).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(function () { return require('./worked-matrix'); });
  else root.PriorContacts = factory(function () { return root.WorkedMatrix; });
})(typeof self !== 'undefined' ? self : this, function (getWorkedMatrix) {
  'use strict';

  var RECENT = 5;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
  /** '20261105' -> '2026-11-05' */
  function fmtDate(d) { var x = digits(d); return x.length === 8 ? x.slice(0, 4) + '-' + x.slice(4, 6) + '-' + x.slice(6) : ''; }
  /** '143200' -> '14:32' */
  function fmtTime(t) { var x = digits(t); return x.length >= 4 ? x.slice(0, 2) + ':' + x.slice(2, 4) : ''; }
  function fmtBand(b) { return String(b == null ? '' : b).trim().toLowerCase(); }
  function fmtMode(m) { return String(m == null ? '' : m).trim().toUpperCase(); }

  /** The newest entry by date then time, whatever order the list is in. */
  function newest(list) {
    var best = null, bestKey = '';
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (!q) continue;
      var k = digits(q.date) + digits(q.time);
      if (!best || k > bestKey) { best = q; bestKey = k; }
    }
    return best;
  }

  /** "Worked 3 times, last on 2026-11-05 14:32 UTC, 20m SSB, POTA US-1234" */
  function summaryText(count, last) {
    if (!count) return 'Not worked before';
    var s = count === 1 ? 'Worked once' : 'Worked ' + count + ' times';
    if (!last) return s;
    var parts = [];
    var when = fmtDate(last.date), at = fmtTime(last.time);
    if (when) parts.push('last on ' + when + (at ? ' ' + at + ' UTC' : ''));
    var bandMode = [fmtBand(last.band), fmtMode(last.mode)].filter(Boolean).join(' ');
    if (bandMode) parts.push(bandMode);
    if (last.ref) parts.push(String(last.ref));
    return parts.length ? s + ', ' + parts.join(', ') : s;
  }

  /** The check mark's hover from the hunter table's worked entries ('' when none). */
  function workedHoverText(entries) {
    var list = Array.isArray(entries) ? entries : [];
    return list.length ? summaryText(list.length, newest(list)) : '';
  }

  /** The card as HTML. data: { total, recent: [{date,time,band,mode,ref}] newest first, workedMatrix }. */
  function cardHtml(call, data) {
    var d = data || {};
    var recent = (Array.isArray(d.recent) ? d.recent : []).slice(0, RECENT);
    var total = d.total || 0;
    var cell = 'padding:1px 6px;text-align:left;white-space:nowrap;';
    var h = '<div class="pc-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px;">' +
      '<strong style="color:var(--accent-blue, #4fc3f7);">Prior contacts with ' + esc(call) + '</strong>' +
      '<button type="button" class="pc-close" title="Close" style="background:none;border:0;color:inherit;cursor:pointer;font-size:14px;padding:0 4px;">×</button></div>';
    h += '<div class="pc-summary" style="margin:4px 0;">' + esc(summaryText(total, recent[0])) + '</div>';
    if (!total) return h;
    var WM = getWorkedMatrix();
    if (WM && d.workedMatrix) h += WM.workedMatrixHtml(d.workedMatrix);
    if (recent.length) {
      h += '<div class="pc-section" style="margin-top:6px;font-weight:600;opacity:.8;">' + (recent.length === 1 ? 'Last contact' : 'Last ' + recent.length + ' contacts') + '</div>';
      h += '<table class="pc-recent" style="border-collapse:collapse;font-family:monospace;font-size:11px;">';
      h += '<tr><th style="' + cell + '">Date (UTC)</th><th style="' + cell + '">Band</th><th style="' + cell + '">Mode</th><th style="' + cell + '">Park</th></tr>';
      recent.forEach(function (q) {
        var when = [fmtDate(q.date), fmtTime(q.time)].filter(Boolean).join(' ');
        h += '<tr class="pc-row"><td style="' + cell + '">' + esc(when) + '</td><td style="' + cell + '">' + esc(fmtBand(q.band)) +
          '</td><td style="' + cell + '">' + esc(fmtMode(q.mode)) + '</td><td style="' + cell + '">' + (q.ref ? esc(q.ref) : '—') + '</td></tr>';
      });
      h += '</table>';
    }
    return h;
  }

  /** Open (or reuse) the card near x,y. Closes on its × button, Escape, or a click outside. */
  function showCard(call, data, x, y) {
    var doc = root.document;
    if (!doc || !doc.body) return null;
    var card = doc.getElementById('prior-contacts-card');
    if (!card) {
      card = doc.createElement('div');
      card.id = 'prior-contacts-card';
      card.setAttribute('role', 'dialog');
      card.style.cssText = 'position:fixed;z-index:10000;max-width:440px;padding:8px 10px;border-radius:8px;font-size:12px;' +
        'background:var(--bg-secondary, #16213e);color:var(--text-primary, #e0e0e0);' +
        'border:1px solid var(--border-primary, rgba(128,128,128,.4));box-shadow:0 6px 18px rgba(0,0,0,.45);';
      doc.body.appendChild(card);
      doc.addEventListener('mousedown', function (e) { if (!card.hidden && !card.contains(e.target)) card.hidden = true; });
      doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') card.hidden = true; });
      card.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('.pc-close')) card.hidden = true; });
    }
    card.setAttribute('aria-label', 'Prior contacts with ' + call);
    card.innerHTML = cardHtml(call, data);
    card.hidden = false;
    var w = root.innerWidth || 800, hgt = root.innerHeight || 600;
    card.style.left = Math.max(8, Math.min(x || 0, w - card.offsetWidth - 8)) + 'px';
    card.style.top = Math.max(8, Math.min(y || 0, hgt - card.offsetHeight - 8)) + 'px';
    return card;
  }

  return { RECENT: RECENT, summaryText: summaryText, workedHoverText: workedHoverText, cardHtml: cardHtml, showCard: showCard };
});
