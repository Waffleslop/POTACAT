// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS window, phase 5: the Beacon section. Your position goes to APRS-IS
// (the internet), never on the air. "Beacon now", a timer (Off, 10, 20 or
// 30 min; main enforces the 10 minute minimum), a symbol, a comment,
// "Approximate position" (on by default), and the position: the centre of
// the Settings grid, or a point picked by clicking the map (saved). Main
// (main.js aprsBeacon*) builds and sends the packet and decides every
// refusal; this shows its state and sends the operator's changes. No pop-ups.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var B = window.AprsBeacon;
  var s = null;          // main's state: { settings, call, position, lastAt, lastPacket, sentence, backAt, sending, timerOn, nextAt }
  var picking = false;
  var pickMarker = null;

  function ago(ms) {
    var sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return sec <= 1 ? 'just now' : sec + ' s ago';
    var m = Math.floor(sec / 60);
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago';
  }
  function inMin(ms) {
    var m = Math.max(0, Math.ceil(ms / 60000));
    return m <= 1 ? 'in about a minute' : 'in ' + m + ' min';
  }

  // The symbol chips, each drawn with the phase 1 icon for that symbol.
  function renderSymbols() {
    var box = $('aprs-beacon-syms');
    var cur = s ? s.settings.symbol : 'house';
    var key = cur + '|' + document.documentElement.getAttribute('data-theme') + document.documentElement.getAttribute('data-ds');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.textContent = '';
    B.SYMBOLS.forEach(function (sym) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'aprs-chip aprs-sym-chip' + (sym.id === cur ? ' on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', sym.id === cur ? 'true' : 'false');
      b.title = sym.label + ' (APRS symbol ' + sym.table + sym.code + ')';
      b.innerHTML = AprsIcons.svg(sym.icon, 18) + '<span>' + sym.label + '</span>';
      b.addEventListener('click', function () { if (s && s.settings.symbol !== sym.id) window.api.beaconSet({ symbol: sym.id }); });
      box.appendChild(b);
    });
  }

  function fmtPoint(lat, lon) {
    return Math.abs(lat).toFixed(4) + (lat >= 0 ? ' N' : ' S') + ', ' + Math.abs(lon).toFixed(4) + (lon >= 0 ? ' E' : ' W');
  }

  // Extra 1: the comment that will go out, shown before anything is sent.
  function renderSends() {
    var el = $('aprs-beacon-sends');
    var a = s.activation || { comment: s.settings.comment, added: false, text: '', running: false };
    var line;
    if (!s.settings.activation) line = a.running ? 'Your activation is not added. Comment sent: ' + (a.comment || '(none)') : '';
    else if (!a.running) line = 'No activation is running, so the comment goes as typed: ' + (a.comment || '(none)');
    else line = 'Comment sent: ' + a.comment;
    el.textContent = line;
    el.title = line ? 'At most 43 characters (' + (a.comment || '').length + ' now). The internet and radio beacons send the same comment.' : '';
    el.classList.toggle('hidden', !line);
  }

  // "My APRS SSID" for the radio beacon: 0 (none) to 15, each with its usual
  // meaning (lib/aprs-beacon.js SSID_CHOICES), and the default that keeps
  // the Settings callsign's own SSID. The call each beacon goes out as is
  // shown beside the buttons. The Settings callsign is never changed.
  function renderSsid() {
    var sel = $('aprs-rf-ssid');
    if (!sel.options.length) {
      var d = document.createElement('option');
      d.value = '';
      d.textContent = 'As my Settings callsign';
      sel.appendChild(d);
      B.SSID_CHOICES.forEach(function (c) {
        var o = document.createElement('option');
        o.value = String(c.ssid);
        o.textContent = (c.ssid === 0 ? 'No SSID' : '-' + c.ssid) + ': ' + c.label.replace(/^none: /, '');
        sel.appendChild(o);
      });
    }
    var v = s.settings.rfSsid == null ? '' : String(s.settings.rfSsid);
    if (document.activeElement !== sel) sel.value = v;
    var as = $('aprs-beacon-as');
    as.textContent = s.call ? 'Internet beacon as ' + s.call + (s.rfCall ? ', radio beacon as ' + s.rfCall : '') : '';
    as.classList.toggle('hidden', !as.textContent);
  }

  function render() {
    if (!s) return;
    renderSymbols();
    renderSsid();
    var iv = $('aprs-beacon-interval');
    if (document.activeElement !== iv) iv.value = String(s.settings.intervalMin || 0);
    var cm = $('aprs-beacon-comment');
    if (document.activeElement !== cm) cm.value = s.settings.comment;
    $('aprs-beacon-approx').checked = !!s.settings.approx;
    $('aprs-beacon-activation').checked = !!s.settings.activation;
    renderSends();

    var pos = $('aprs-beacon-pos');
    if (picking) pos.textContent = 'Click the map where you are';
    else if (!s.position) pos.textContent = 'No position';
    else if (s.position.source === 'map') pos.textContent = 'Map point ' + fmtPoint(s.position.lat, s.position.lon);
    else pos.textContent = 'Grid ' + (s.grid || '') + ' centre';
    $('aprs-beacon-pick').textContent = picking ? 'Cancel' : 'Pick on map';
    $('aprs-beacon-grid').classList.toggle('hidden', !(s.position && s.position.source === 'map') || picking);
    $('aprs-beacon-now').disabled = !!s.sending;

    var st = $('aprs-beacon-status'), dot = $('aprs-beacon-dot'), txt = $('aprs-beacon-text');
    var parts = [];
    if (s.sentence) {
      dot.className = 'aprs-dot bad';
      parts.push(s.sentence);
    } else if (s.sending) {
      dot.className = 'aprs-dot wait';
      parts.push('Sending to APRS-IS');
    } else if (s.lastAt) {
      dot.className = 'aprs-dot ok';
      parts.push('Last beacon ' + ago(Date.now() - s.lastAt) + ' as ' + s.call);
      if (s.backAt && s.backAt >= s.lastAt) parts.push('back from APRS-IS, on the map');
    } else {
      dot.className = 'aprs-dot';
      parts.push(s.call ? 'No beacon sent yet. It goes out as ' + s.call + ', over the internet only.' : 'No beacon sent yet.');
    }
    if (s.timerOn && s.nextAt && !s.sentence) parts.push('next ' + inMin(s.nextAt - Date.now()));
    txt.textContent = parts.join(', ');
    st.classList.remove('hidden');
    drawPick();
  }

  // The picked point on the map: a small ring in the accent colour, only while the point is in use.
  function drawPick() {
    var map = window.aprsMapApi && window.aprsMapApi.map;
    if (!map || !window.L) return;
    var p = s && s.position && s.position.source === 'map' ? s.position : null;
    if (!p) { if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; } return; }
    var colour = getComputedStyle(document.documentElement).getPropertyValue('--accent-red').trim() || '#e94560';
    if (!pickMarker) {
      pickMarker = L.circleMarker([p.lat, p.lon], { radius: 9, weight: 3, color: colour, fill: false, interactive: false }).addTo(map);
    } else {
      pickMarker.setLatLng([p.lat, p.lon]);
      pickMarker.setStyle({ color: colour });
    }
  }

  function setPicking(on) {
    picking = on;
    var map = window.aprsMapApi && window.aprsMapApi.map;
    if (map) map.getContainer().classList.toggle('aprs-picking', on);
    render();
  }

  $('aprs-beacon-now').addEventListener('click', function () { window.api.beaconNow(); });
  $('aprs-beacon-interval').addEventListener('change', function (e) { window.api.beaconSet({ intervalMin: Number(e.target.value) || 0 }); });
  $('aprs-beacon-comment').addEventListener('change', function (e) { window.api.beaconSet({ comment: e.target.value }); });
  $('aprs-beacon-approx').addEventListener('change', function (e) { window.api.beaconSet({ approx: e.target.checked }); });
  $('aprs-rf-ssid').addEventListener('change', function (e) { window.api.beaconSet({ rfSsid: e.target.value === '' ? null : Number(e.target.value) }); });
  $('aprs-beacon-activation').addEventListener('change', function (e) { window.api.beaconSet({ activation: e.target.checked }); });
  $('aprs-beacon-pick').addEventListener('click', function () { setPicking(!picking); });
  $('aprs-beacon-grid').addEventListener('click', function () { window.api.beaconSet({ lat: null, lon: null }); });
  document.addEventListener('keydown', function (e) { if (picking && e.key === 'Escape') setPicking(false); });

  // One click on the map while picking saves that point.
  function hookMap() {
    var map = window.aprsMapApi && window.aprsMapApi.map;
    if (!map) { setTimeout(hookMap, 200); return; }
    map.on('click', function (e) {
      if (!picking) return;
      var ll = e.latlng.wrap();
      setPicking(false);
      window.api.beaconSet({ lat: ll.lat, lon: ll.lng });
    });
  }
  hookMap();

  window.api.onBeacon(function (d) { if (d) { s = d; render(); } });
  window.api.beaconGet();
  new MutationObserver(function () { render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-ds', 'data-dark-variant'] });
  setInterval(render, 1000);
  // The activation, the dial and the mode change outside this window: ask for the comment again every few seconds.
  setInterval(function () { if (!document.hidden) window.api.beaconGet(); }, 3000);
})();
