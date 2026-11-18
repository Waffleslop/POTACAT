// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS window, phase 7: "Beacon now (radio)", beside the internet beacon.
// The button is enabled only when main's gate (lib/aprs-rf-gate.js) would
// allow a beacon; otherwise one line says why. A press shows one
// confirmation line in the window (band, frequency, mode and the rig's power
// as it reads now; never a pop-up), and only Transmit sends. Main decides
// everything again at Transmit and at the key-down. No timer: one press, one
// packet. The internet beacon above is unchanged.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var s = null; // main's state (preload onRf)

  function ago(ms) {
    var sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return sec <= 1 ? 'just now' : sec + ' s ago';
    var m = Math.floor(sec / 60);
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago';
  }

  function powerWords(w) {
    return w > 0 ? 'at ' + w + ' W, the power the radio is set to now' : 'at the power set on the radio (POTACAT has no reading of it)';
  }

  function render() {
    if (!s) return;
    var busy = s.phase && s.phase !== 'idle';
    var btn = $('aprs-rf-now');
    btn.disabled = !s.allowed || busy || !!s.confirm;
    btn.title = s.allowed
      ? 'Send one APRS packet with your position over your radio on ' + s.bandLabel + ', ' + s.mhz + ' MHz. You confirm first.'
      : (s.why || 'Not available now.');

    var box = $('aprs-rf-confirm');
    if (s.confirm && !busy) {
      var c = s.confirm;
      $('aprs-rf-confirm-text').textContent = 'Transmit one APRS beacon on ' + c.bandLabel + ', ' + c.mhz + ' MHz ' + c.mode + ', ' + powerWords(c.powerW) + '?';
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }

    var st = $('aprs-rf-status'), dot = $('aprs-rf-dot'), txt = $('aprs-rf-text');
    var line;
    if (busy) {
      dot.className = 'aprs-dot wait';
      line = s.keyed ? 'Transmitting the beacon on ' + s.bandLabel + '.' : 'Sending the beacon on ' + s.bandLabel + ': waiting for a clear channel.';
    } else if (s.confirm) {
      dot.className = 'aprs-dot';
      line = '';
    } else if (s.sentence) {
      dot.className = 'aprs-dot bad';
      line = s.sentence;
    } else if (!s.allowed) {
      dot.className = 'aprs-dot';
      line = 'Radio beacon: ' + s.why;
    } else if (s.lastAt) {
      dot.className = 'aprs-dot ok';
      line = 'Last radio beacon ' + ago(Date.now() - s.lastAt) + ' on ' + (s.lastBand === '2m' ? '2 m' : '30 m') + '.';
    } else {
      dot.className = 'aprs-dot';
      line = 'Radio beacon: ready on ' + s.bandLabel + ', ' + s.mhz + ' MHz. Nothing is sent until you confirm.';
    }
    txt.textContent = line;
    st.classList.toggle('hidden', !line);
  }

  $('aprs-rf-now').addEventListener('click', function () { window.api.rfAsk(); });
  $('aprs-rf-send').addEventListener('click', function () { $('aprs-rf-send').disabled = true; window.api.rfSend(); setTimeout(function () { $('aprs-rf-send').disabled = false; }, 1500); });
  $('aprs-rf-cancel').addEventListener('click', function () { window.api.rfCancel(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && s && s.confirm) window.api.rfCancel(); });

  window.api.onRf(function (d) { if (d) { s = d; render(); } });
  window.api.rfGet();
  // The gate depends on the dial and the radio's state: ask again every second while the window is open.
  setInterval(function () { if (!document.hidden) window.api.rfGet(); }, 1000);
})();
