// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS window, phase 7: "Beacon now (radio)", beside the internet beacon.
// One click transmits one packet (Casey 2026-11-19: "I should just be able
// to do a 1-click transmit"). Everything the old confirmation line showed is
// on the button and the line under it BEFORE the click: band, frequency and
// the radio's power on the button ("Beacon now on 30 m, 10.1476 MHz at 5 W"),
// mode, call, path and about how long on the air under it. The button is
// enabled only when main's gate (lib/aprs-rf-gate.js) would allow a beacon;
// otherwise one line says why. A click while a beacon is going out does
// nothing (the button is disabled at once, and main ignores it too). Main
// decides everything again at the click and at the key-down. No timer: one
// click, one packet. The internet beacon above is unchanged.
//
// Beside it, the radio: the S-meter while listening, SWR and RF out while
// the beacon transmits, the last beacon's peaks (lib/aprs-rf-meters.js), and
// the TX power control (lib/rig-power-view.js, the VFO window's control; the
// set goes through rig-control set-tx-power like every other window). The
// beacon itself never changes power.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var M = window.AprsRfMeters;
  var P = window.RigPowerView;
  var s = null;          // main's state (preload onRf)
  var clickedAt = -Infinity; // a click is on its way to main: the button stays disabled
  var CLICK_HOLD_MS = 1500;
  var meter = { smeter: null, swr: 0, swrRatioSeen: false, fwdW: 0 };

  function ago(ms) {
    var sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return sec <= 1 ? 'just now' : sec + ' s ago';
    var m = Math.floor(sec / 60);
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago';
  }

  function busyNow() {
    return !!(s && ((s.phase && s.phase !== 'idle') || s.sending)) || (Date.now() - clickedAt < CLICK_HOLD_MS);
  }

  function render() {
    if (!s) return;
    var busy = busyNow();
    var btn = $('aprs-rf-now');
    var pv = s.allowed && s.preview ? s.preview : null;
    btn.disabled = !s.allowed || busy;
    btn.textContent = pv ? pv.button : 'Beacon now (radio)';
    btn.title = s.allowed
      ? 'One click sends one APRS packet with your position over your radio' + (pv ? ': ' + pv.detail : '.')
      : (s.why || 'Not available now.');

    var det = $('aprs-rf-detail');
    det.textContent = pv && !busy ? 'Radio beacon: ' + pv.detail : '';
    det.classList.toggle('hidden', !det.textContent);

    var st = $('aprs-rf-status'), dot = $('aprs-rf-dot'), txt = $('aprs-rf-text');
    var line;
    if (busy) {
      dot.className = 'aprs-dot wait';
      line = s.keyed ? 'Transmitting the beacon on ' + s.bandLabel + '.' : 'Sending the beacon on ' + s.bandLabel + ': waiting for a clear channel.';
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
      line = '';
    }
    txt.textContent = line;
    st.classList.toggle('hidden', !line);
    renderMeters();
  }

  // ── the meters ────────────────────────────────────────────────────────────
  function renderMeters() {
    var v = M.meterView({
      txing: !!(s && s.keyed),
      smeter: meter.smeter,
      swr: meter.swr,
      fwdW: meter.fwdW,
      available: (s && s.meters) || {},
      last: s && s.lastPeak,
    });
    var box = $('aprs-rf-meters');
    box.textContent = '';
    v.items.forEach(function (it) {
      var el = document.createElement('span');
      el.className = 'aprs-rf-meter' + (it.cls ? ' ' + it.cls : '');
      el.setAttribute('data-meter', it.key);
      var lab = document.createElement('span');
      lab.className = 'aprs-rf-meter-label';
      lab.textContent = it.label;
      var val = document.createElement('span');
      val.className = 'aprs-rf-meter-val';
      val.textContent = it.text;
      if (it.label) el.appendChild(lab);
      el.appendChild(val);
      box.appendChild(el);
    });
    var last = $('aprs-rf-last');
    last.textContent = v.last;
    last.classList.toggle('hidden', !v.last);
  }
  window.api.onCatSmeter(function (v) { meter.smeter = Number(v); renderMeters(); });
  window.api.onCatSwr(function (v) { if (meter.swrRatioSeen) return; meter.swr = M.swrFromWire(v); renderMeters(); });
  window.api.onCatSwrRatio(function (v) { meter.swrRatioSeen = true; meter.swr = Number(v) || 0; renderMeters(); });
  window.api.onCatFwdPower(function (v) { meter.fwdW = Number(v) || 0; renderMeters(); });

  // ── TX power: the VFO window's control (lib/rig-power-view.js) ─────────────
  var pwrBox = $('aprs-rf-power'), pwrRange = $('aprs-rf-power-range'), pwrSel = $('aprs-rf-power-select'), pwrVal = $('aprs-rf-power-val');
  var pwrDecimals = 0, pwrInputAt = 0, pwrUnit = 'W';
  var pwrSend = P.createPowerSender(function (w) { window.api.rigControl({ action: 'set-tx-power', value: w }); });
  function applyPower(p) {
    var v = P.powerView(p);
    pwrBox.classList.toggle('hidden', !v.shown);
    if (!v.shown) return;
    pwrDecimals = v.decimals;
    pwrUnit = v.unit;
    pwrRange.hidden = v.useSelect;
    pwrSel.hidden = !v.useSelect;
    pwrRange.min = v.min;
    pwrRange.max = v.max;
    pwrRange.step = v.step;
    pwrRange.disabled = pwrSel.disabled = !v.enabled;
    pwrBox.title = v.enabled ? 'The radio\'s TX power, ' + v.min + ' to ' + v.max + ' ' + v.unit + '. The beacon goes out at this power.'
      : 'The radio\'s TX power (read only: no power control over CAT for this radio)';
    var want = v.choices.join('|');
    if (v.useSelect && pwrSel.dataset.choices !== want && document.activeElement !== pwrSel) {
      pwrSel.innerHTML = '';
      v.choices.forEach(function (c) {
        var o = document.createElement('option');
        o.value = String(c); o.textContent = P.formatWatts(c, v.decimals, v.unit);
        pwrSel.appendChild(o);
      });
      pwrSel.dataset.choices = want;
    }
    // The echo of our own set is in flight during a drag: leave the thumb alone.
    var dragging = document.activeElement === pwrRange || document.activeElement === pwrSel || (Date.now() - pwrInputAt) < 600;
    if (!dragging && v.known) {
      if (v.useSelect) pwrSel.value = v.selectValue;
      else pwrRange.value = v.watts;
    }
    // What the radio reads back, never just the slider's position.
    pwrVal.textContent = v.known ? 'radio reads ' + v.label : 'radio has not reported its power';
  }
  function pwrInput(el) {
    pwrInputAt = Date.now();
    var w = parseFloat(el.value);
    pwrVal.textContent = 'setting ' + P.formatWatts(w, pwrDecimals, pwrUnit);
    pwrSend(w);
  }
  pwrRange.addEventListener('input', function () { pwrInput(pwrRange); });
  pwrRange.addEventListener('change', function () { pwrRange.blur(); });
  pwrSel.addEventListener('change', function () { pwrInput(pwrSel); pwrSel.blur(); });
  window.api.onRigPower(applyPower);
  window.api.rigPowerGet();

  // ── the one click ─────────────────────────────────────────────────────────
  $('aprs-rf-now').addEventListener('click', function () {
    if (!s || !s.allowed || busyNow()) return; // a second click while a beacon is going out does nothing
    clickedAt = Date.now();
    $('aprs-rf-now').disabled = true;
    window.api.rfSend();
    render();
  });

  window.api.onRf(function (d) {
    if (!d) return;
    // A new key-down: the SWR and RF out start fresh, never the last transmission's.
    if (d.keyed && !(s && s.keyed)) { meter.swr = 0; meter.fwdW = 0; }
    s = d;
    render();
  });
  window.api.rfGet();
  // The gate depends on the dial and the radio's state: ask again every second while the window is open.
  setInterval(function () { if (!document.hidden) window.api.rfGet(); }, 1000);
})();
