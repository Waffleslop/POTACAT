// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS window (phase 1): the stations APRS-IS reports around the operator's
// grid, on a map and in a list beside it. Read-only: nothing here sends a
// packet or touches the radio.
//
// Main parses each line (lib/aprs-parser.js) and sends batches every 500 ms;
// lib/aprs-stations.js keeps one row per station or object and forgets those
// not heard for an hour. Clicking a row centres the map on it; clicking a
// marker (or a row) shows the details below the list, with a QRZ link.
// Status is three small marks in the top bar; there are no pop-ups.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  $('tb-min').addEventListener('click', function () { window.api.minimize(); });
  $('tb-max').addEventListener('click', function () { window.api.maximize(); });
  $('tb-close').addEventListener('click', function () { window.api.close(); });

  var RANGES_KM = [25, 50, 100, 150, 250, 400, 600];
  var KM_PER_MI = 1.609344;
  var LABEL_ZOOM = 9;          // callsign labels from this zoom in

  var unit = 'mi';
  var home = null;
  var store = AprsStations.createStore({});
  var sortKey = 'distance', sortDesc = false;
  var query = '';
  var selected = null;
  var markers = {};            // key -> L.marker
  var arrivals = [];           // packet times in the last minute
  var lastPacketAt = 0;
  var linkState = null;

  // ── map ──────────────────────────────────────────────────────────────────
  var map = L.map('aprs-map', { zoomControl: true, worldCopyJump: true }).setView([39, -96], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  var layer = L.layerGroup().addTo(map);
  var homeMarker = null;
  function syncLabels() { $('aprs-map').classList.toggle('no-labels', map.getZoom() < LABEL_ZOOM); }
  map.on('zoomend', syncLabels);
  syncLabels();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function symHtml(cls, course) {
    var rot = cls === 'vehicle' && course != null ? ' style="transform: rotate(' + Math.round(course) + 'deg)"' : '';
    return '<i class="aprs-sym ' + cls + '"' + rot + '></i>';
  }
  function zoomForKm(km) {
    return km <= 30 ? 10 : km <= 60 ? 9 : km <= 120 ? 8 : km <= 200 ? 7 : km <= 450 ? 6 : 5;
  }

  // ── units ────────────────────────────────────────────────────────────────
  function fmtDist(km) {
    if (km == null) return '';
    var v = unit === 'km' ? km : km / KM_PER_MI;
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + unit;
  }
  function fmtSpeed(knots) {
    if (knots == null) return '';
    return unit === 'km' ? Math.round(knots * 1.852) + ' km/h' : Math.round(knots * 1.15078) + ' mph';
  }
  function fmtAlt(feet) {
    if (feet == null) return '';
    return unit === 'km' ? Math.round(feet * 0.3048).toLocaleString() + ' m' : Math.round(feet).toLocaleString() + ' ft';
  }
  function fmtLatLon(lat, lon) {
    return Math.abs(lat).toFixed(4) + (lat >= 0 ? ' N' : ' S') + ', ' + Math.abs(lon).toFixed(4) + (lon >= 0 ? ' E' : ' W');
  }
  function kindName(cls) {
    return { station: 'Station', vehicle: 'Moving', weather: 'Weather station', object: 'Object' }[cls] || 'Station';
  }
  function baseCall(c) { return String(c || '').toUpperCase().split('-')[0]; }

  // ── range ────────────────────────────────────────────────────────────────
  var rangeSel = $('aprs-range');
  function fillRanges(km) {
    rangeSel.innerHTML = '';
    var list = RANGES_KM.indexOf(km) < 0 ? RANGES_KM.concat([km]).sort(function (a, b) { return a - b; }) : RANGES_KM;
    list.forEach(function (k) {
      var o = document.createElement('option');
      o.value = String(k);
      o.textContent = unit === 'km' ? k + ' km' : Math.round(k / KM_PER_MI) + ' mi';
      if (k === km) o.selected = true;
      rangeSel.appendChild(o);
    });
  }
  rangeSel.addEventListener('change', function () {
    var km = parseInt(rangeSel.value, 10);
    window.api.setRange(km);
    if (home) map.setView([home.lat, home.lon], zoomForKm(km));
  });

  // ── status marks ─────────────────────────────────────────────────────────
  function setLink(s) {
    linkState = s || {};
    var dot = $('aprs-link-dot'), text = $('aprs-link-text');
    dot.className = 'aprs-dot';
    var st = linkState.state;
    var msg = '';
    if (st === 'connected') { dot.classList.add('ok'); msg = 'Connected to APRS-IS' + (linkState.server ? ' (' + linkState.server + ')' : ''); }
    else if (st === 'connecting') { dot.classList.add('wait'); msg = 'Connecting to APRS-IS'; }
    else if (st === 'waiting') { dot.classList.add('wait'); msg = 'Not connected, trying again in ' + Math.round((linkState.retryInMs || 0) / 1000) + ' s'; }
    else if (st === 'refused') { dot.classList.add('bad'); msg = 'APRS-IS refused the login, trying again in a minute'; }
    else if (st === 'no-grid') { dot.classList.add('bad'); msg = 'No grid square'; }
    else { msg = 'Not connected'; }
    text.textContent = msg;
    $('aprs-link').title = linkState.call ? 'Read-only login as ' + linkState.call + (linkState.anonymous ? ' (no callsign in Settings)' : '') : 'The internet link to APRS-IS';
    showEmpty();
  }

  function tickMarks() {
    var now = Date.now();
    while (arrivals.length && arrivals[0] < now - 60000) arrivals.shift();
    $('aprs-rate').textContent = arrivals.length + (arrivals.length === 1 ? ' packet a minute' : ' packets a minute');
    $('aprs-last').textContent = lastPacketAt ? 'Last packet ' + AprsStations.formatAge(now - lastPacketAt).replace('now', 'just now') + (now - lastPacketAt >= 60000 ? ' ago' : '') : 'No packets yet';
  }

  function showEmpty() {
    var el = $('aprs-empty');
    var msg = '';
    if (linkState && linkState.state === 'no-grid') msg = 'Set your grid square in Settings to see the APRS stations near you.';
    else if (store.size === 0 && linkState && linkState.state === 'connected') msg = 'Listening. Stations appear here as APRS-IS reports them.';
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
  }

  // ── markers ──────────────────────────────────────────────────────────────
  function markerIcon(r) {
    var label = esc(r.label);
    return L.divIcon({
      className: 'aprs-marker' + (selected === r.key ? ' sel' : ''),
      html: symHtml(r.cls, r.course) + '<span class="aprs-lbl">' + label + '</span>',
      iconSize: [16, 16], iconAnchor: [8, 8],
    });
  }
  function matches(r) {
    if (!query) return true;
    var q = query.toUpperCase();
    return r.label.toUpperCase().indexOf(q) >= 0 || r.call.toUpperCase().indexOf(q) >= 0
      || (r.comment || '').toUpperCase().indexOf(q) >= 0 || (r.status || '').toUpperCase().indexOf(q) >= 0;
  }
  function placeMarker(r) {
    var m = markers[r.key];
    if (!matches(r)) { if (m) { layer.removeLayer(m); delete markers[r.key]; } return; }
    if (!m) {
      m = L.marker([r.lat, r.lon], { icon: markerIcon(r), keyboard: false, riseOnHover: true });
      m.on('click', function () { select(r.key, false); });
      layer.addLayer(m);
      markers[r.key] = m;
    } else {
      m.setLatLng([r.lat, r.lon]);
      m.setIcon(markerIcon(r));
    }
  }
  function redrawMarkers() {
    var keep = {};
    store.list({}).forEach(function (r) { keep[r.key] = true; placeMarker(r); });
    Object.keys(markers).forEach(function (k) { if (!keep[k]) { layer.removeLayer(markers[k]); delete markers[k]; } });
  }

  // ── list ─────────────────────────────────────────────────────────────────
  function renderList() {
    var rows = store.list({ sort: sortKey, desc: sortDesc, query: query });
    var now = Date.now();
    var html = rows.map(function (r) {
      var brg = r.bearing == null ? '' : Math.round(r.bearing) + '&deg; ' + AprsStations.compass(r.bearing);
      return '<tr data-key="' + esc(r.key) + '"' + (r.key === selected ? ' class="sel"' : '') + '>'
        + '<td title="' + esc(kindName(r.cls)) + '">' + symHtml(r.cls, r.course) + '</td>'
        + '<td class="call">' + esc(r.label) + '</td>'
        + '<td class="num">' + esc(fmtDist(r.distanceKm)) + '</td>'
        + '<td class="num">' + brg + '</td>'
        + '<td class="num">' + esc(AprsStations.formatAge(now - r.lastHeard)) + '</td>'
        + '<td><span class="cmt" title="' + esc(r.comment || r.status) + '">' + esc(r.comment || r.status) + '</span></td>'
        + '</tr>';
    }).join('');
    $('aprs-rows').innerHTML = html;
    var total = store.size;
    $('aprs-count').textContent = total === 0 ? 'No stations yet'
      : (query ? rows.length + ' of ' + total + ' stations' : total + (total === 1 ? ' station' : ' stations')) + ' heard in the last hour';
    document.querySelectorAll('.aprs-table th').forEach(function (th) {
      th.classList.toggle('sorted', th.dataset.sort === sortKey);
      th.classList.toggle('desc', th.dataset.sort === sortKey && sortDesc);
    });
    showEmpty();
  }
  document.querySelector('.aprs-table thead').addEventListener('click', function (e) {
    var th = e.target.closest('th');
    if (!th || !th.dataset.sort) return;
    if (sortKey === th.dataset.sort) sortDesc = !sortDesc;
    else { sortKey = th.dataset.sort; sortDesc = false; }
    renderList();
  });
  $('aprs-rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (tr && tr.dataset.key) select(tr.dataset.key, true);
  });
  $('aprs-search').addEventListener('input', function () {
    query = this.value.trim();
    renderList();
    redrawMarkers();
  });

  // ── details ──────────────────────────────────────────────────────────────
  function select(key, centre) {
    var prev = selected;
    selected = key;
    var r = store.get(key);
    if (prev && markers[prev]) { var pr = store.get(prev); if (pr) markers[prev].setIcon(markerIcon(pr)); }
    if (r && markers[key]) markers[key].setIcon(markerIcon(r));
    if (r && centre) map.setView([r.lat, r.lon], Math.max(map.getZoom(), 11));
    renderList();
    renderDetail();
    var tr = document.querySelector('#aprs-rows tr.sel');
    if (tr && !centre) tr.scrollIntoView({ block: 'nearest' });
  }
  function renderDetail() {
    var el = $('aprs-detail');
    var r = selected && store.get(selected);
    if (!r) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    var rows = [];
    function add(k, v) { if (v !== '' && v != null) rows.push('<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'); }
    if (r.name) add('Sent by', esc(r.call));
    add('Position', esc(fmtLatLon(r.lat, r.lon)));
    if (r.distanceKm != null) add('From you', esc(fmtDist(r.distanceKm)) + ', ' + Math.round(r.bearing) + '&deg; ' + AprsStations.compass(r.bearing));
    if (r.speed != null || r.course != null) {
      add('Moving', esc([r.speed != null ? fmtSpeed(r.speed) : '', r.course != null ? 'heading ' + r.course + '°' : ''].filter(Boolean).join(', ')));
    }
    add('Altitude', esc(fmtAlt(r.altitude)));
    if (r.weather) {
      var w = r.weather, parts = [];
      if (w.tempF != null) parts.push(unit === 'km' ? Math.round((w.tempF - 32) * 5 / 9) + ' °C' : w.tempF + ' °F');
      if (w.windSpeed != null) parts.push('wind ' + (unit === 'km' ? Math.round(w.windSpeed * 1.609) + ' km/h' : w.windSpeed + ' mph')
        + (w.windDir != null ? ' from ' + w.windDir + '°' : '') + (w.windGust != null ? ', gusts ' + (unit === 'km' ? Math.round(w.windGust * 1.609) : w.windGust) : ''));
      if (w.humidity != null) parts.push('humidity ' + w.humidity + '%');
      if (w.pressure != null) parts.push(w.pressure.toFixed(1) + ' mbar');
      if (w.rain1h != null) parts.push('rain last hour ' + (unit === 'km' ? (w.rain1h * 0.254).toFixed(1) + ' mm' : (w.rain1h / 100).toFixed(2) + ' in'));
      add('Weather', esc(parts.join(', ')));
    }
    if (r.micEMessage) add('Mic-E', esc(r.micEMessage));
    add('Status', esc(r.status));
    add('Comment', esc(r.comment));
    add('Heard', esc(AprsStations.formatAge(Date.now() - r.lastHeard).replace(/^now$/, 'just now')) + (r.packets > 1 ? ' (' + r.packets + ' packets this hour)' : ''));
    if (r.igate) add('Via', esc(r.igate));
    add('Packet', '<span class="raw">' + esc(r.raw) + '</span>');
    var qrzCall = baseCall(r.call);
    el.innerHTML = '<div class="aprs-detail-head">' + symHtml(r.cls, r.course)
      + '<span class="aprs-detail-call">' + esc(r.label) + '</span>'
      + '<span class="aprs-detail-kind">' + esc(kindName(r.cls)) + '</span>'
      + '<span class="aprs-spacer"></span>'
      + '<button class="aprs-qrz" id="aprs-qrz" title="Look up ' + esc(qrzCall) + ' on QRZ.com in your browser">QRZ ' + esc(qrzCall) + '</button>'
      + '<button class="aprs-x" id="aprs-detail-x" title="Close the details">&#x2715;</button></div>'
      + '<dl>' + rows.join('') + '</dl>';
    el.classList.remove('hidden');
    $('aprs-qrz').addEventListener('click', function () { window.api.openExternal('https://www.qrz.com/db/' + encodeURIComponent(qrzCall)); });
    $('aprs-detail-x').addEventListener('click', function () { select(null, false); });
  }

  // ── data in ──────────────────────────────────────────────────────────────
  window.api.onInit(function (d) {
    d = d || {};
    unit = d.distUnit === 'km' ? 'km' : 'mi';
    fillRanges(d.km || 150);
    home = d.home || null;
    store.setHome(home);
    if (home) {
      if (homeMarker) layer.removeLayer(homeMarker);
      homeMarker = L.marker([home.lat, home.lon], {
        icon: L.divIcon({ className: 'aprs-marker', html: '<i class="aprs-sym home"></i><span class="aprs-lbl">' + esc(home.call || 'You') + ' ' + esc(home.grid) + '</span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        keyboard: false, zIndexOffset: 1000, interactive: false,
      }).addTo(map);
      map.setView([home.lat, home.lon], zoomForKm(d.km || 150));
    }
  });
  window.api.onStatus(setLink);
  window.api.onPackets(function (packets) {
    if (!Array.isArray(packets)) return;
    var now = Date.now();
    packets.forEach(function (p) {
      arrivals.push(now);
      lastPacketAt = now;
      var r = store.add(p);
      if (r) placeMarker(r);
      else if (p && (p.type === 'object' || p.type === 'item') && p.live === false) {
        var k = AprsStations.stationKey(p);
        if (markers[k]) { layer.removeLayer(markers[k]); delete markers[k]; }
        if (selected === k) selected = null;
      }
    });
    renderList();
    if (selected) renderDetail();
    tickMarks();
  });

  // Age-out and the "heard" column move on their own.
  setInterval(tickMarks, 1000);
  setInterval(function () {
    var gone = store.prune();
    gone.forEach(function (k) { if (markers[k]) { layer.removeLayer(markers[k]); delete markers[k]; } if (selected === k) selected = null; });
    renderList();
    if (selected) renderDetail(); else $('aprs-detail').classList.add('hidden');
  }, 15000);

  tickMarks();
  window.api.ready();
})();
