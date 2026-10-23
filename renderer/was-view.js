/**
 * Worked All States view (renderer): draws the states × bands matrix from
 * the worked roster main pushes (`worked-roster`, lib/worked-roster.js).
 * Pure DOM building; app.js owns the view switch, the filter persistence and
 * the IPC. Tints are POTACAT's own: blue = worked, green = confirmed
 * (styles.css .was-worked / .was-confirmed), never GridTracker's yellow.
 */
(function () {
  'use strict';

  var WR = window.WorkedRoster;

  /** { scope, mode } for the roster from the view's Mode select value. */
  function scopeFor(modeValue) {
    if (!modeValue || modeValue === 'all') return { scope: 'band', mode: '' };
    if (modeValue === 'phone' || modeValue === 'cw' || modeValue === 'digital') {
      // The family select: any logged mode of that family stands for it.
      var sample = modeValue === 'phone' ? 'SSB' : (modeValue === 'cw' ? 'CW' : 'FT8');
      return { scope: 'band-mode', mode: sample };
    }
    return { scope: 'band-exact', mode: modeValue };
  }

  function render(els, roster, opts) {
    var o = opts || {};
    var sc = scopeFor(o.modeValue);
    var confirmedOnly = o.countValue === 'confirmed';
    var rows = WR.matrix(roster || WR.empty(), 'state', WR.US_STATES, { scope: sc.scope, mode: sc.mode });
    var worked = 0, confirmed = 0;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.overall !== 'none') worked++;
      if (r.overall === 'confirmed') confirmed++;
      var tr = document.createElement('tr');
      var done = confirmedOnly ? r.overall === 'confirmed' : r.overall !== 'none';
      if (!done) tr.classList.add('dxcc-unworked');
      var nameTd = document.createElement('td');
      nameTd.textContent = r.name;
      nameTd.title = r.code;
      var codeSpan = document.createElement('span');
      codeSpan.className = 'was-code';
      codeSpan.textContent = r.code;
      nameTd.appendChild(codeSpan);
      tr.appendChild(nameTd);
      for (var b = 0; b < WR.BANDS.length; b++) {
        var td = document.createElement('td');
        var s = r.cells[WR.BANDS[b]];
        if (s === 'confirmed') { td.className = 'was-confirmed'; td.textContent = '✓'; td.title = r.name + ' confirmed on ' + WR.BANDS[b]; }
        else if (s === 'worked') { td.className = 'was-worked'; td.textContent = '•'; td.title = r.name + ' worked on ' + WR.BANDS[b] + ', not confirmed'; }
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    els.body.innerHTML = '';
    els.body.appendChild(frag);
    var n = confirmedOnly ? confirmed : worked;
    els.count.textContent = n + ' / 50';
    els.count.classList.toggle('was-count-confirmed', confirmedOnly);
    els.award.textContent = confirmed >= 50 ? 'WAS!' : (worked >= 50 && !confirmedOnly ? 'All 50 worked' : '');
    if (els.placeholder) els.placeholder.classList.toggle('hidden', worked > 0);
    return { worked: worked, confirmed: confirmed };
  }

  window.WasView = { render: render, scopeFor: scopeFor };
})();
