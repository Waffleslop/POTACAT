// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS window: the "Listen on my radio" switch (receive only), the band
// chips (phase 3: 2 m, 30 m, one per band the rig has; main decides which)
// and its small marks: radio listening, the last packet the radio heard, the
// count this session, and the one sentence when it cannot listen. Main does
// the work (main.js aprsListenStart); this only shows its state and sends the
// switch. No pop-ups.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var sw = $('aprs-listen-on');
  var s = { on: false, state: 'off', sentence: '', band: '', bands: [], modeLabel: 'FM', mhz: '', heard: 0, lastAt: 0, note: '' };
  var LABEL = { '2m': '2 m', '30m': '30 m' };
  var TITLE = {
    '2m': 'Listen on 2 m: the regional APRS frequency, FM, 1200 baud',
    '30m': 'Listen on 30 m: 10.1476 MHz USB, 300 baud (HF APRS, one frequency worldwide)',
  };
  var chipsKey = '';

  function renderChips() {
    var box = $('aprs-listen-bands');
    var bands = Array.isArray(s.bands) ? s.bands : [];
    var key = bands.join(',') + '|' + s.band;
    if (key === chipsKey) return;
    chipsKey = key;
    box.textContent = '';
    bands.forEach(function (b) {
      var c = document.createElement('button');
      c.type = 'button';
      c.className = 'aprs-chip aprs-band-chip' + (b === s.band ? ' on' : '');
      c.textContent = LABEL[b] || b;
      c.title = TITLE[b] || '';
      c.setAttribute('aria-pressed', b === s.band ? 'true' : 'false');
      c.addEventListener('click', function () { if (b !== s.band) window.api.listenBand(b); });
      box.appendChild(c);
    });
  }

  function ago(ms) {
    var sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return sec <= 1 ? 'just now' : sec + ' s ago';
    var m = Math.floor(sec / 60);
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago';
  }

  function render() {
    var active = s.on && (s.state === 'starting' || s.state === 'listening' || s.state === 'paused');
    sw.checked = active;
    renderChips();
    $('aprs-listen-freq').textContent = s.mhz ? s.mhz + ' MHz ' + (s.modeLabel || 'FM') : '';
    $('aprs-listen-freq').classList.toggle('hidden', !s.mhz || !active);

    var st = $('aprs-listen-state'), dot = $('aprs-listen-dot'), txt = $('aprs-listen-text');
    st.classList.toggle('hidden', !active);
    dot.className = 'aprs-dot' + (s.state === 'listening' ? ' ok' : ' wait');
    txt.textContent = s.state === 'listening' ? 'Radio listening' : s.state === 'starting' ? 'Tuning the radio' : 'Paused';

    var heardMark = $('aprs-listen-heard');
    heardMark.classList.toggle('hidden', !active && !s.heard);
    $('aprs-listen-last').textContent = s.lastAt ? 'Last heard on the radio ' + ago(Date.now() - s.lastAt) : 'Nothing heard on the radio yet';
    $('aprs-listen-count').textContent = s.heard + (s.heard === 1 ? ' packet' : ' packets') + ' heard this session';

    var why = $('aprs-listen-why');
    why.textContent = s.sentence || '';
    why.classList.toggle('hidden', !s.sentence);

    var note = $('aprs-listen-note');
    note.textContent = s.note || '';
    note.classList.toggle('hidden', !(s.note && active));
  }

  sw.addEventListener('change', function () { window.api.listenSet(sw.checked); });
  window.api.onListen(function (d) { s = d || s; render(); });
  // The push that answers 'aprs-ready' can come before this script has loaded;
  // ask now that the listener is attached.
  if (window.api.listenGet) window.api.listenGet();
  setInterval(render, 1000);
  render();
})();
