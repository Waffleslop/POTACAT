// Theme applier — handles both legacy string payloads ('light'/'dark')
// and the v1.9+ {theme, variant} object form so older + newer senders
// both work. Sets data-theme and (in charcoal dark variant only) the
// data-dark-variant attribute on <html>.
function _applyPopoutTheme(payload) {
  const theme = typeof payload === 'string'
    ? payload
    : ((payload && payload.theme) || 'dark');
  const variant = (payload && typeof payload === 'object' && payload.variant) || 'navy';
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'dark' && variant !== 'navy') {
    document.documentElement.setAttribute('data-dark-variant', variant);
  } else {
    document.documentElement.removeAttribute('data-dark-variant');
  }
}
// JTCAT Pop-out Window — decode log, map, and controls
(function() {
  'use strict';

  // --- Window controls ---
  // macOS uses native traffic light buttons (hiddenInset) — hide custom controls
  if (window.api.platform === 'darwin') {
    document.querySelector('.titlebar-controls').style.display = 'none';
  }
  document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
  document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
  document.getElementById('tb-close').addEventListener('click', () => window.api.close());

  // --- Theme ---
  window.api.onPopoutTheme(function(theme) {
    _applyPopoutTheme(theme);
  });

  // --- State ---
  var decodeLog = [];
  var cqFilter = false;
  var wantedFilter = false;
  var chaseFilter = false;
  var chaseTarget = '';   // current chase tag ('' = none); shared with phone
  var sortBySignal = false;
  var searchFilter = '';
  var txEnabled = false;
  var transmitting = false;
  var jpTxFreqHz = 1500;
  var jpRxFreqHz = 1500;
  var myCallsign = '';
  var myGrid = '';
  var stations = {};   // callsign -> {marker, grid, lat, lon, lastSeen}
  var qsoArcs = {};    // "A↔B" -> {arc, from, to, lastSeen}
  var ARC_SEGMENTS = 32;
  var qrzCache = {};   // callsign -> {name, fetched}
  // Map of UPPERCASE callsign -> {isNewPark, reference} for calls currently
  // visible in POTACAT's main filtered spot list. Pushed from main renderer
  // on each render(); drives the .jp-spotted / .jp-new-park row classes.
  var spottedCalls = new Map();

  // ULTRACAT (tier-2 easter egg) — reveal/hide the Full Auto CQ controls.
  function applyUltracat(on) {
    document.body.classList.toggle('ultracat', !!on);
    var els = document.querySelectorAll('.ultracat-gated');
    for (var i = 0; i < els.length; i++) els[i].classList.toggle('hidden', !on);
  }
  window.api.onJtcatUltracat(applyUltracat);

  // Load settings
  window.api.getSettings().then(function(s) {
    myCallsign = (s.myCallsign || '').toUpperCase();
    myGrid = (s.grid || '').toUpperCase().substring(0, 4);
    applyUltracat(!!s.ultracat);
    chaseTarget = s.jtcatChaseTarget || '';
    reflectChaseTarget(chaseTarget);
    if (maxAttemptsInput && typeof s.jtcatMaxQsoAttempts === 'number') {
      maxAttemptsInput.value = s.jtcatMaxQsoAttempts;
    }
    fdMode = !!s.jtcatFdMode;
    if (fdExchInput) fdExchInput.value = s.jtcatFdExch || '';
    reflectFd();
    // Rig-scoped UI: multi-slice is a FlexRadio concept (slices A-D + DAX RX
    // channels) — hide the Multi button when the active rig isn't a Flex.
    // Evaluated at popout open; a rig switch mid-session re-opens JTCAT anyway.
    if (window.RigFamily) {
      var activeRigForMulti = (s.rigs || []).find(function(r) { return r && r.id === s.activeRigId; });
      if (!window.RigFamily.isFlex(activeRigForMulti)) {
        var multiBtnEl = document.getElementById('jp-multi-btn');
        if (multiBtnEl) multiBtnEl.classList.add('hidden');
        var multiPanelEl = document.getElementById('jp-multi-panel');
        if (multiPanelEl) multiPanelEl.classList.add('hidden');
      }
    }
    updateMapHome();
    // Center map on home QTH if grid is available
    if (myGrid && map) {
      var pos = gridToLatLon(myGrid);
      if (pos) map.setView([pos.lat, pos.lon], 4);
    }
    // Register own station so QSO arcs can be drawn to/from us
    if (myCallsign && myGrid) registerStation(myCallsign, myGrid);
  });

  var qsoState = null; // current QSO state from main renderer

  // --- DOM refs ---
  var bandActivity = document.getElementById('jp-band-activity');
  var myActivity = document.getElementById('jp-my-activity');
  var modeSelect = document.getElementById('jp-mode');
  var cycleEl = document.getElementById('jp-cycle');
  var countdownEl = document.getElementById('jp-countdown');
  var syncEl = document.getElementById('jp-sync');
  var utcClockEl = document.getElementById('jp-utc-clock');

  // UTC clock — updates every second
  function updateUtcClock() {
    var now = new Date();
    var d = now.toISOString().slice(0, 10);
    var t = now.toISOString().slice(11, 19);
    utcClockEl.textContent = d + ' ' + t + 'Z';
  }
  updateUtcClock();
  setInterval(updateUtcClock, 1000);
  var cqFilterBtn = document.getElementById('jp-cq-filter');
  var wantedFilterBtn = document.getElementById('jp-wanted-filter');
  var chaseFilterBtn = document.getElementById('jp-chase-filter');
  var chaseSelect = document.getElementById('jp-chase-target');
  var chaseCustom = document.getElementById('jp-chase-custom');
  var cqBtn = document.getElementById('jp-cq');
  var fullAutoCqBtn = document.getElementById('jp-full-auto-cq');
  var maxAttemptsInput = document.getElementById('jp-max-attempts');
  var fdToggle = document.getElementById('jp-fd-toggle');
  var fdExchInput = document.getElementById('jp-fd-exch');
  var fdMode = false;
  var FD_EXCH_RE = /^\d{1,2}[A-F]\s+[A-Z]{2,3}$/;
  function reflectFd() {
    if (fdToggle) fdToggle.classList.toggle('active', fdMode);
    if (fdExchInput) fdExchInput.style.display = fdMode ? '' : 'none';
  }
  var enableTxBtn = document.getElementById('jp-enable-tx');
  var haltTxBtn = document.getElementById('jp-halt-tx');
  var tuneBtn = document.getElementById('jp-tune');
  var txMsgEl = document.getElementById('jp-tx-msg');
  var rxTxEl = document.getElementById('jp-rx-tx');
  var txFreqLabel = document.getElementById('jp-tx-freq-label');
  var qsoTracker = document.getElementById('jp-qso-tracker');
  var qsoLabel = document.getElementById('jp-qso-label');
  var qsoSteps = document.getElementById('jp-qso-steps');
  var qsoCancelBtn = document.getElementById('jp-qso-cancel');
  var qsoSkipBtn = document.getElementById('jp-qso-skip');

  // --- Map ---
  var map = null;
  var markerLayer = L.layerGroup();
  var arcLayer = L.layerGroup();
  var homeMarker = null;
  var nightLayer = null;

  function initMap() {
    var center = [20, 0];
    var zoom = 2;
    if (myGrid) {
      var pos = gridToLatLon(myGrid);
      if (pos) { center = [pos.lat, pos.lon]; zoom = 4; }
    }
    map = L.map('jp-map', { zoomControl: true, worldCopyJump: true }).setView(center, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OSM', maxZoom: 18, className: 'dark-tiles',
    }).addTo(map);
    // Day/night terminator first so it sits beneath markers/arcs (matches the
    // Propagation map). setLatLngs on refresh preserves this z-order.
    updateNightOverlay();
    setInterval(updateNightOverlay, 60000);
    markerLayer.addTo(map);
    arcLayer.addTo(map);
    updateMapHome();
  }

  // Day/night terminator — ported from the Propagation popout (prop-popout.js).
  // Subsolar point from date + UTC time, terminator latitude per longitude,
  // closed into a dark polygon over the night hemisphere. Drawn at three
  // longitude offsets so it wraps with worldCopyJump panning.
  function computeNightPolygon() {
    var now = new Date();
    var start = new Date(now.getFullYear(), 0, 0);
    var dayOfYear = Math.floor((now - start) / 86400000);
    var utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    var declRad = (-23.44 * Math.PI / 180) * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
    var sunLon = -(utcHours - 12) * 15;
    var tanDecl = Math.tan(declRad);
    var terminator = [];
    for (var lon = -180; lon <= 180; lon += 2) {
      var lonRad = (lon - sunLon) * Math.PI / 180;
      var lat = Math.abs(tanDecl) < 1e-10 ? 0 : Math.atan(-Math.cos(lonRad) / tanDecl) * 180 / Math.PI;
      terminator.push([lat, lon]);
    }
    var darkPoleLat = declRad > 0 ? -90 : 90;
    var rings = [];
    [-360, 0, 360].forEach(function(offset) {
      var ring = terminator.map(function(p) { return [p[0], p[1] + offset]; });
      ring.push([darkPoleLat, 180 + offset]);
      ring.push([darkPoleLat, -180 + offset]);
      ring.unshift([darkPoleLat, -180 + offset]);
      rings.push(ring);
    });
    return rings;
  }

  function updateNightOverlay() {
    if (!map) return;
    var rings = computeNightPolygon();
    if (nightLayer) {
      nightLayer.setLatLngs(rings);
    } else {
      nightLayer = L.polygon(rings, {
        fillColor: '#000', fillOpacity: 0.25, color: '#4fc3f7', weight: 1, opacity: 0.4, interactive: false,
      }).addTo(map);
    }
  }

  function updateMapHome() {
    if (homeMarker && map) { map.removeLayer(homeMarker); homeMarker = null; }
    if (!myGrid || !map) return;
    var bounds = gridToBounds(myGrid);
    if (!bounds) return;
    homeMarker = L.rectangle(bounds, {
      fillColor: '#e94560', fillOpacity: 0.35, color: '#e94560', weight: 2,
    }).addTo(map).bindTooltip(myCallsign || 'Home', { permanent: false });
  }

  function gridToLatLon(grid) {
    if (!grid || grid.length < 4) return null;
    var g = grid.toUpperCase();
    var lonField = g.charCodeAt(0) - 65;
    var latField = g.charCodeAt(1) - 65;
    var lonSquare = parseInt(g[2], 10);
    var latSquare = parseInt(g[3], 10);
    var lon = lonField * 20 + lonSquare * 2 - 180 + 1;
    var lat = latField * 10 + latSquare * 1 - 90 + 0.5;
    return { lat: lat, lon: lon };
  }

  // Returns [[south, west], [north, east]] bounds for a 4-char grid
  function gridToBounds(grid) {
    if (!grid || grid.length < 4) return null;
    var g = grid.toUpperCase();
    var lonField = g.charCodeAt(0) - 65;
    var latField = g.charCodeAt(1) - 65;
    var lonSquare = parseInt(g[2], 10);
    var latSquare = parseInt(g[3], 10);
    var west = lonField * 20 + lonSquare * 2 - 180;
    var south = latField * 10 + latSquare * 1 - 90;
    return [[south, west], [south + 1, west + 2]];
  }

  function cleanQrzName(name) {
    if (!name) return '';
    // Title-case if all-caps
    if (name === name.toUpperCase()) name = name.replace(/\w\S*/g, function(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
    // Drop trailing single-letter initials like "John D."
    name = name.replace(/\s+[A-Z]\.?$/, '');
    return name.trim();
  }

  function stationPopupHtml(call, grid) {
    var isMe = call === myCallsign;
    var qrz = qrzCache[call];
    var nameLine = qrz && qrz.name ? '<div style="color:#aaa;font-size:11px;">' + esc(qrz.name) + '</div>' : '';
    var qsoBtn = isMe ? '' : '<button class="jp-popup-qso" data-call="' + esc(call) + '" data-grid="' + esc(grid) + '" style="margin-top:4px;padding:3px 10px;border-radius:4px;border:1px solid #4ecca3;background:#4ecca3;color:#000;font-size:11px;font-weight:600;cursor:pointer;">QSO</button>';
    return '<div style="font-family:monospace;font-size:12px;line-height:1.5;">' +
      '<b style="color:#fff;">' + esc(call) + '</b> <span style="color:#666;">[' + esc(grid) + ']</span>' +
      nameLine + qsoBtn + '</div>';
  }

  function fetchQrzName(call) {
    if (call === myCallsign || qrzCache[call]) return;
    qrzCache[call] = { name: '', fetched: true };
    if (!window.api.qrzLookup) return;
    window.api.qrzLookup(call).then(function(data) {
      if (!data) return;
      var name = cleanQrzName(data.nickname || data.fname || '');
      if (!name && data.name) name = cleanQrzName(data.fname ? data.fname + ' ' + data.name : data.name);
      qrzCache[call] = { name: name, fetched: true };
      // Update popup if station still exists
      var stn = stations[call];
      if (stn && stn.marker) stn.marker.setPopupContent(stationPopupHtml(call, stn.grid));
    }).catch(function() {});
  }

  function registerStation(call, grid) {
    if (!map || !call || !grid || !/^[A-R]{2}[0-9]{2}$/i.test(grid)) return;
    grid = grid.toUpperCase();
    var bounds = gridToBounds(grid);
    var pos = gridToLatLon(grid);
    if (!bounds || !pos) return;
    var existing = stations[call];
    if (existing) {
      existing.lastSeen = Date.now();
      if (grid !== existing.grid) {
        existing.grid = grid; existing.lat = pos.lat; existing.lon = pos.lon;
        existing.marker.setBounds(bounds);
        existing.marker.setPopupContent(stationPopupHtml(call, grid));
      }
      return;
    }
    var isMe = call === myCallsign;
    var color = isMe ? '#e94560' : '#4fc3f7';
    var marker = L.rectangle(bounds, {
      fillColor: color, fillOpacity: isMe ? 0.35 : 0.25, color: color, weight: 1,
    }).addTo(markerLayer);
    marker.bindPopup(stationPopupHtml(call, grid), { className: 'jp-station-popup', closeButton: false });
    marker.on('popupopen', function() {
      var el = marker.getPopup().getElement();
      if (!el) return;
      var btn = el.querySelector('.jp-popup-qso');
      if (btn) {
        btn.addEventListener('click', function() {
          var c = btn.dataset.call, g = btn.dataset.grid;
          if (c) {
            window.api.jtcatReply({ call: c, grid: g || '', df: 1500, slot: null });
            marker.closePopup();
          }
        });
      }
    });
    stations[call] = { marker: marker, grid: grid, lat: pos.lat, lon: pos.lon, lastSeen: Date.now() };
    // Fetch QRZ name in background
    if (!isMe) fetchQrzName(call);
  }

  function computeArc(lat1, lon1, lat2, lon2) {
    var points = [];
    var n = ARC_SEGMENTS;
    var dLat = lat2 - lat1, dLon = lon2 - lon1;
    var dist = Math.sqrt(dLat * dLat + dLon * dLon);
    var bulge = dist * 0.2;
    var perpLat = -dLon / (dist || 1), perpLon = dLat / (dist || 1);
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var lat = lat1 + dLat * t;
      var lon = lon1 + dLon * t;
      var offset = 4 * t * (1 - t) * bulge;
      points.push([lat + perpLat * offset, lon + perpLon * offset]);
    }
    return points;
  }

  function drawQsoArc(fromCall, toCall) {
    var fromStn = stations[fromCall], toStn = stations[toCall];
    if (!fromStn || !toStn) return;
    var key = [fromCall, toCall].sort().join('\u2194');
    var existing = qsoArcs[key];
    var arcPoints = computeArc(fromStn.lat, fromStn.lon, toStn.lat, toStn.lon);
    var involvesMe = (fromCall === myCallsign || toCall === myCallsign);
    var color = involvesMe ? '#e94560' : '#4fc3f7';
    if (existing) {
      existing.arc.setLatLngs(arcPoints);
      existing.arc.setTooltipContent(fromCall + ' \u2192 ' + toCall);
      existing.lastSeen = Date.now(); existing.from = fromCall; existing.to = toCall;
      animateArc(existing.arc, fromCall, toCall, color);
      return;
    }
    var arc = L.polyline(arcPoints, { color: color, weight: 2, opacity: 0.8, dashArray: '8 6', lineCap: 'round' }).addTo(arcLayer);
    arc.bindTooltip(fromCall + ' \u2192 ' + toCall, { sticky: true });
    qsoArcs[key] = { arc: arc, from: fromCall, to: toCall, lastSeen: Date.now() };
    setTimeout(function() { animateArc(arc, fromCall, toCall, color); }, 0);
  }

  function animateArc(arc, fromCall, toCall, color) {
    var el = arc.getElement();
    if (!el) return;
    el.style.stroke = color;
    // Arc geometry is always drawn from fromStn to toStn.
    // But we reuse the same polyline (keyed by sorted callsigns), so the
    // underlying point order might not match the current from->to direction.
    // Compare the first point of the polyline with fromStn's position to
    // determine if the polyline direction matches the intended direction.
    var fromStn = stations[fromCall];
    var pts = arc.getLatLngs();
    var polylineMatchesFrom = false;
    if (fromStn && pts && pts.length > 0) {
      var p0 = pts[0];
      polylineMatchesFrom = (Math.abs(p0.lat - fromStn.lat) < 1 && Math.abs(p0.lng - fromStn.lon) < 1);
    }
    el.classList.remove('jtcat-arc-forward', 'jtcat-arc-reverse');
    el.classList.add(polylineMatchesFrom ? 'jtcat-arc-forward' : 'jtcat-arc-reverse');
  }

  function plotDecode(d) {
    if (!map) return;
    var text = (d.text || '').toUpperCase();
    var parts = text.split(/\s+/);
    if (text.startsWith('CQ ')) {
      var pc = JtcatParser.parseCq(text);
      var call = pc.call, grid = pc.grid;
      registerStation(call, grid);
      var stn = stations[call];
      if (stn) stn.marker.setStyle({ fillColor: '#4ecca3', color: '#4ecca3' });
    } else if (parts.length >= 2) {
      var toCall = parts[0], fromCall = parts[1], payload = parts[2] || '';
      if (/^[A-R]{2}[0-9]{2}$/i.test(payload)) registerStation(fromCall, payload);
      if (stations[fromCall]) stations[fromCall].lastSeen = Date.now();
      if (stations[toCall]) stations[toCall].lastSeen = Date.now();
      if (stations[fromCall] && stations[toCall]) drawQsoArc(fromCall, toCall);
    }
  }

  // Cap how many FT8 decode cycles stay in each panel's DOM. renderDecodes()
  // appends a separator + rows every cycle (~4/min) and they were never
  // removed — the live document can't GC attached nodes, so the popout
  // renderer leaked ~4.5 MB/min and Chromium eventually CHECK()-aborted after
  // a few hours of continuous decoding. (78hawkeye, PR #54.)
  var MAX_BA_CYCLES = 10;  // Band Activity — ~2.5 min of visible history
  var MAX_MY_ROWS = 60;    // My Activity grows much slower (directed/TX only); capped by row, not cycle

  // My Activity inlines its time per row (no .jp-cycle-sep), so prune by row
  // count instead of cycle. Same PR #54 leak guard, different key.
  function pruneRowPanel(container, maxRows) {
    var rows = container.querySelectorAll('.jp-row');
    for (var i = 0; i < rows.length - maxRows; i++) {
      rows[i].remove();
    }
  }

  // Remove the oldest cycles (a .jp-cycle-sep and everything up to the next
  // separator) until at most maxCycles remain.
  function pruneCyclePanel(container, maxCycles) {
    var seps = container.querySelectorAll('.jp-cycle-sep');
    if (seps.length <= maxCycles) return;
    var toRemove = seps.length - maxCycles;
    for (var i = 0; i < toRemove; i++) {
      var sep = container.querySelector('.jp-cycle-sep');
      if (!sep) break;
      var next = sep.nextSibling;
      sep.remove();
      while (next && !(next.classList && next.classList.contains('jp-cycle-sep'))) {
        var tmp = next.nextSibling;
        if (next.remove) next.remove();
        next = tmp;
      }
    }
  }

  function clearOld() {
    var now = Date.now();
    Object.keys(qsoArcs).forEach(function(key) {
      if (qsoArcs[key].lastSeen < now - 45000) { arcLayer.removeLayer(qsoArcs[key].arc); delete qsoArcs[key]; }
    });
    Object.keys(stations).forEach(function(call) {
      if (call === myCallsign) return; // never expire our own station
      if (stations[call].lastSeen < now - 180000) { markerLayer.removeLayer(stations[call].marker); delete stations[call]; }
    });
    pruneCyclePanel(bandActivity, MAX_BA_CYCLES);
    pruneRowPanel(myActivity, MAX_MY_ROWS);
  }

  // --- QSO phase definitions ---
  var QSO_PHASES_CQ = [
    { key: 'cq',        dir: 'tx', label: function(q) { return 'CQ ' + q.myCall + ' ' + q.myGrid; } },
    { key: 'cq-reply',  dir: 'rx', label: function(q) { return (q.call || '?') + ' ' + q.myCall + ' ' + (q.grid || '??'); } },
    { key: 'cq-report', dir: 'tx', label: function(q) { return (q.call || '?') + ' ' + q.myCall + ' ' + (q.sentReport || '-XX'); } },
    { key: 'cq-r+rpt',  dir: 'rx', label: function(q) { return q.myCall + ' ' + (q.call || '?') + ' R' + (q.report || '-XX'); } },
    { key: 'cq-rr73',   dir: 'tx', label: function(q) { return (q.call || '?') + ' ' + q.myCall + ' RR73'; } },
    { key: 'done',      dir: '--', label: function()  { return 'QSO Complete'; } },
  ];
  var QSO_PHASES_REPLY = [
    { key: 'reply',     dir: 'tx', label: function(q) { return q.call + ' ' + q.myCall + ' ' + q.myGrid; } },
    { key: 'rpt-rx',    dir: 'rx', label: function(q) { return q.myCall + ' ' + q.call + ' ' + (q.report || '-XX'); } },
    { key: 'r+report',  dir: 'tx', label: function(q) { return q.call + ' ' + q.myCall + ' R' + (q.sentReport || '-XX'); } },
    { key: 'rr73-rx',   dir: 'rx', label: function(q) { return q.myCall + ' ' + q.call + ' RR73'; } },
    { key: '73',        dir: 'tx', label: function(q) { return q.call + ' ' + q.myCall + ' 73'; } },
    { key: 'done',      dir: '--', label: function()  { return 'QSO Complete'; } },
  ];

  function renderQsoTracker() {
    if (!qsoState || qsoState.phase === 'idle') {
      qsoTracker.classList.add('hidden');
      return;
    }
    qsoTracker.classList.remove('hidden');
    // Show Skip button when QSO is active (not done)
    qsoSkipBtn.style.display = qsoState.phase !== 'done' ? '' : 'none';
    var q = qsoState;
    var phases = q.mode === 'cq' ? QSO_PHASES_CQ : QSO_PHASES_REPLY;

    // Header
    if (q.mode === 'cq') {
      qsoLabel.textContent = q.call ? 'CQ \u2192 ' + q.call : 'Calling CQ...';
    } else {
      qsoLabel.textContent = 'Reply \u2192 ' + q.call;
    }

    // Map phase to display index
    var currentIdx = -1;
    for (var i = 0; i < phases.length; i++) {
      if (phases[i].key === q.phase) { currentIdx = i; break; }
    }
    if (q.mode === 'cq' && q.phase === 'cq-report') currentIdx = 2;
    if (q.mode === 'cq' && q.phase === 'cq-rr73') currentIdx = 4;
    if (q.mode === 'cq' && q.phase === 'done') currentIdx = 5;
    if (q.mode === 'reply' && q.phase === 'r+report') currentIdx = 2;
    if (q.mode === 'reply' && q.phase === '73') currentIdx = 4;
    if (q.mode === 'reply' && q.phase === 'done') currentIdx = 5;

    var html = '';
    for (var i = 0; i < phases.length; i++) {
      var p = phases[i];
      var cls = 'jp-qso-step';
      if (i < currentIdx) cls += ' step-done';
      else if (i === currentIdx) cls += ' step-current step-' + p.dir;
      if (i > 0) html += '<span class="jp-qso-arrow">\u25B6</span>';
      html += '<span class="' + cls + '">' + esc(p.label(q)) + '</span>';
    }
    qsoSteps.innerHTML = html;
  }

  // Decide the *next* TX message based on the CONTENT of a received decode.
  // Standard FT8 sequence:
  //   1. CQ <call> <grid>            (we hear)
  //   2. <us> <them> <their grid>     (we hear, after our CQ)
  //   3. <us> <them> <-SNR>           (we hear, signal report — no R prefix)
  //   4. <us> <them> R<-SNR>          (we hear, R-rogered report — distinct from 3!)
  //   5. <us> <them> RR73 / RRR
  //   6. <us> <them> 73
  //
  // Old code conflated steps 3 and 4 (`R?[+-]\d{2}` matched both, lost the R)
  // and treated step 2 (their grid reply) the same as a fresh CQ-reply,
  // causing double-clicks on a stale step-2 message after we'd already
  // advanced to send a signal report to roll the QSO back to step 2 (us
  // sending grid again). Chris N4RDX 2026-04-29.
  //
  // Returns { step, call, theirGrid?, theirReport? } or null when the
  // message isn't actionable (not a CQ, not addressed to us).
  // Classifier + callsign-shape now live in the shared renderer/jtcat-parser.js
  // (window.JtcatParser), the single source of truth shared with app.js,
  // main.js, and the test suite. These thin delegators keep the existing call
  // sites readable. NOTE: main.js re-derives the step authoritatively from the
  // raw text + the configured callsign (see jtcat-popout-reply), so this local
  // classification only drives popout UI (retune-vs-reply, My Activity).
  function inferReplyStep(decode, myCall) {
    return JtcatParser.inferReplyStep(decode, myCall);
  }

  function _jpLooksLikeCallsign(tok) {
    return JtcatParser.looksLikeCallsign(tok);
  }

  function onDecodeRowClick(d) {
    var action = inferReplyStep(d, myCallsign);
    if (!action) {
      // Not a CQ, not addressed to us — just retune.
      jpTxFreqHz = d.df || 1500;
      txFreqLabel.textContent = 'TX: ' + jpTxFreqHz + ' Hz';
      window.api.jtcatSetTxFreq(jpTxFreqHz);
      return;
    }

    jpTxFreqHz = d.df || 1500;
    jpRxFreqHz = d.df || 1500;
    txFreqLabel.textContent = 'TX: ' + jpTxFreqHz + ' Hz';

    console.log('[JTCAT popout]', action.step, '→', action.call, 'df:', d.df, 'slot:', d.slot, 'theirReport:', action.theirReport, 'theirGrid:', action.theirGrid);
    if (action.step === 'reply-cq') addToMyActivity(d);

    window.api.jtcatReply({
      call: action.call,
      // Raw decode text — main re-derives the step from this against the
      // configured callsign, so a stale popout call can't pick the wrong line.
      text: d.text,
      df: d.df || 1500,
      slot: d.slot,
      sliceId: d.sliceId,
      snr: d.db,
      nextStep: action.step,
      theirGrid: action.theirGrid,
      theirReport: action.theirReport,
      // Legacy fields for back-compat with any older main.js handler:
      grid: action.theirGrid || '',
      report: action.theirReport,
      rr73: action.step === 'send-73' || undefined,
    });
  }

  // --- Decode rendering ---
  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // Each FT8/FT4 decode belongs to a fixed cycle that STARTS on a period
  // boundary (:00/:15/:30/:45 for FT8's 15 s; :00/:07.5/… for FT4's 7.5 s).
  // The decode is produced ~800 ms BEFORE the next boundary, so stamping
  // `new Date()` at render time showed :44/:14 instead of the period start.
  // Floor the clock to the current mode's cycle so the time column reads the
  // WSJT-X-style period start. K3SBP 2026-06-15.
  function cycleBoundaryUtc() {
    var mode = modeSelect ? modeSelect.value : 'FT8';
    var cycleMs = (mode === 'FT2' ? 3800 : mode === 'FT4' ? 7500 : 15000);
    var d = new Date(Math.floor(Date.now() / cycleMs) * cycleMs);
    return String(d.getUTCHours()).padStart(2, '0') + ':' +
           String(d.getUTCMinutes()).padStart(2, '0') + ':' +
           String(d.getUTCSeconds()).padStart(2, '0');
  }

  // Add a single decode to My Activity pane (e.g. the CQ we clicked to start a QSO)
  function addToMyActivity(d) {
    var mEmpty = myActivity.querySelector('.jp-empty');
    if (mEmpty) mEmpty.remove();
    var time = cycleBoundaryUtc();
    var text = d.text || '';
    var dtStr = d.dt != null ? (d.dt >= 0 ? '+' : '') + d.dt.toFixed(1) : '';
    var row = document.createElement('div');
    row.className = 'jp-row jp-cq';
    row.innerHTML =
      '<span class="jp-time">' + time + '</span>' +
      '<span class="jp-db">' + (d.db >= 0 ? '+' : '') + d.db + '</span>' +
      '<span class="jp-dt">' + dtStr + '</span>' +
      '<span class="jp-df">' + d.df + '</span>' +
      '<span class="jp-msg">' + esc(text) + '</span>' +
      (d.ap ? '<span class="jp-badges"><span class="jp-badge jp-badge-ap" title="A priori decode — recovered a weak or late reply by hypothesizing your call">AP</span></span>' : '');
    row.addEventListener('dblclick', (function(decode) { return function() { onDecodeRowClick(decode); }; })(d));
    myActivity.appendChild(row);
    myActivity.scrollTop = myActivity.scrollHeight;
  }

  // Classify a decode for filtering + row styling. Shared by the live append
  // path and the rebuild-on-toggle path so the two never drift apart.
  function classifyDecode(d) {
    var text = d.text || '';
    var upper = text.toUpperCase();
    return {
      d: d,
      text: text,
      upper: upper,
      isCq: upper.startsWith('CQ '),
      isDirected: myCallsign && (upper.indexOf(' ' + myCallsign + ' ') >= 0 || upper.startsWith(myCallsign + ' ') || upper.endsWith(' ' + myCallsign)),
      is73: upper.indexOf('RR73') >= 0 || upper.indexOf(' 73') >= 0,
      isWanted: d.newDxcc || d.newCall || d.newGrid,
    };
  }

  // Current CQ/73 / Wanted / Chase / search filter state. Directed decodes
  // (and 73s) always pass so the operator never loses a reply to their own
  // CQ behind a filter — matches the mobile app + in-window view.
  function decodeVisible(c) {
    if (cqFilter && !c.isCq && !c.is73 && !c.isDirected) return false;
    if (wantedFilter && !c.isWanted && !c.isDirected && !c.is73) return false;
    if (chaseFilter && !c.d.chaseMatch && !c.isDirected && !c.is73) return false;
    if (searchFilter && c.upper.indexOf(searchFilter) === -1) return false;
    return true;
  }

  function sortDecodes(results) {
    // Sort by signal strength (strongest first) when enabled.
    return sortBySignal ? results.slice().sort(function(a, b) { return (b.db || 0) - (a.db || 0); }) : results;
  }

  // Build one Band Activity row element from a classified decode.
  function buildBandRow(c) {
    var d = c.d;
    var badges = '';
    if (d.ap) badges += '<span class="jp-badge jp-badge-ap" title="A priori decode — recovered a weak or late reply by hypothesizing your call">AP</span>';
    if (d.chaseMatch) badges += '<span class="jp-badge jp-badge-chase" title="Chase target: ' + esc(chaseTarget) + '">◎</span>';
    if (d.newDxcc) badges += '<span class="jp-badge jp-badge-dxcc" title="New DXCC: ' + esc(d.entity || '') + '">D</span>';
    if (d.newGrid) badges += '<span class="jp-badge jp-badge-grid" title="New grid: ' + esc(d.grid || '') + '">G</span>';
    if (d.newCall) badges += '<span class="jp-badge jp-badge-call" title="New call: ' + esc(d.call || '') + '">C</span>';
    if (d.watched) badges += '<span class="jp-badge jp-badge-watch" title="Watchlist">W</span>';
    var entityStr = d.entity ? '<span class="jp-entity">' + esc(d.entity) + '</span>' : '';

    var row = document.createElement('div');
    // Spot-list highlight — match on the decoded DX call. isNewPark bumps
    // the styling from a subtle stripe to a stronger green tint so the op
    // can spot unworked parks at a glance during multi-slice operating.
    var spotMatch = d.call ? spottedCalls.get(String(d.call).toUpperCase()) : null;
    var spotClass = spotMatch ? (spotMatch.isNewPark ? ' jp-new-park' : ' jp-spotted') : '';
    row.className = 'jp-row' + (c.isCq ? ' jp-cq' : '') + (c.isDirected ? ' jp-directed' : '') + (c.isWanted ? ' jp-wanted' : '') + (d.chaseMatch ? ' jp-chase' : '') + (d.watched ? ' jp-watched' : '') + spotClass;
    if (spotMatch && spotMatch.reference) row.title = 'Spotted at ' + spotMatch.reference + (spotMatch.isNewPark ? ' (new park)' : '');
    var dtStr = d.dt != null ? (d.dt >= 0 ? '+' : '') + d.dt.toFixed(1) : '';
    // Band badge for multi-slice decodes
    var bandBadge = '';
    if (d.band && multiActive) {
      var bColor = BAND_COLORS[d.band] || '#888';
      bandBadge = '<span class="jp-badge jp-badge-band" style="background:' + bColor + ';color:#000;">' + d.band + '</span>';
    }
    row.innerHTML =
      (bandBadge ? bandBadge : '') +
      '<span class="jp-db">' + (d.db >= 0 ? '+' : '') + d.db + '</span>' +
      '<span class="jp-dt">' + dtStr + '</span>' +
      '<span class="jp-df">' + Math.round(d.df) + '</span>' +
      '<span class="jp-msg">' + esc(c.text) + '</span>' +
      (badges ? '<span class="jp-badges">' + badges + '</span>' : '') +
      entityStr;
    row.addEventListener('dblclick', (function(decode) { return function() { onDecodeRowClick(decode); }; })(d));
    return row;
  }

  // Append one cycle's decodes to Band Activity, applying the current filters
  // + sort. Pure DOM build off the supplied results — no My Activity, no map
  // plot, no decodeLog mutation — so the rebuild path can replay it safely.
  // Returns the number of rows actually shown (0 = fully filtered out).
  function appendBandCycle(time, results) {
    var rows = [];
    sortDecodes(results).forEach(function(d) {
      var c = classifyDecode(d);
      if (!decodeVisible(c)) return;
      rows.push(buildBandRow(c));
    });
    // A filter that hides every decode in this cycle should hide its separator
    // too, so the log doesn't fill with empty timestamps.
    if (rows.length === 0 && (cqFilter || wantedFilter || chaseFilter || searchFilter)) return 0;
    var sep = document.createElement('div');
    sep.className = 'jp-cycle-sep';
    sep.textContent = time + ' UTC';
    bandActivity.appendChild(sep);
    rows.forEach(function(r) { bandActivity.appendChild(r); });
    return rows.length;
  }

  // Rebuild the WHOLE Band Activity pane from the retained decodeLog, applying
  // the current filters + sort. The CQ/73 / Wanted / Chase / dB / search
  // controls call this so toggling them re-filters and re-sorts the decodes
  // ALREADY on screen — not just future cycles. My Activity and the map are
  // left untouched (their content isn't filter-dependent: directed decodes
  // always pass, and the map shows all CQ/QSO geometry).
  function rebuildBandActivity() {
    var wasAtBottom = bandActivity.scrollTop + bandActivity.clientHeight >= bandActivity.scrollHeight - 20;
    bandActivity.innerHTML = '';
    var shown = 0;
    for (var i = 0; i < decodeLog.length; i++) {
      shown += appendBandCycle(decodeLog[i].time, decodeLog[i].results);
    }
    if (decodeLog.length === 0) {
      bandActivity.innerHTML = '<div class="jp-empty">Waiting for decodes...</div>';
    } else if (shown === 0) {
      bandActivity.innerHTML = '<div class="jp-empty">No decodes match the current filter</div>';
    } else {
      // Respect the same DOM cap as the live append path (leak fix, PR #54).
      // Empty-after-filter cycles add no separator, so this keeps up to
      // MAX_BA_CYCLES *matching* cycles drawn from the full retained log.
      pruneCyclePanel(bandActivity, MAX_BA_CYCLES);
    }
    if (wasAtBottom) bandActivity.scrollTop = bandActivity.scrollHeight;
  }

  function renderDecodes(data) {
    var results = data.results || [];
    var decodeSlot = data.slot || null; // slot the decoded audio was from
    var time = '';
    if (results.length > 0) {
      time = cycleBoundaryUtc();
      decodeLog.push({ time: time, results: results });
      if (decodeLog.length > 50) decodeLog.shift();
    }

    // Remove placeholder
    var empty = bandActivity.querySelector('.jp-empty');
    if (empty) empty.remove();

    if (!time) return;

    // Band Activity — append just this cycle (filtered + sorted exactly like
    // the rebuild path). Live decodes stay an efficient append; only toggles
    // pay for a full rebuild.
    appendBandCycle(time, results);

    // My Activity + map plot — driven off the same filter so a hidden decode
    // doesn't leak into the map / My Activity (faithful to the original single
    // loop). Directed decodes always pass, so My Activity is unaffected by the
    // CQ/Wanted filters in practice.
    sortDecodes(results).forEach(function(d) {
      d.slot = decodeSlot; // attach slot so click handler knows which slot this station was on
      var c = classifyDecode(d);
      if (!decodeVisible(c)) return;

      if (c.isDirected) {
        var mEmpty = myActivity.querySelector('.jp-empty');
        if (mEmpty) mEmpty.remove();
        // My Activity inlines the cycle time per row instead of a separator
        // line (it's sparse — usually one entry per cycle, so a dedicated
        // header line just wastes vertical space). Band Activity keeps its
        // separators, where one header amortizes across many decodes.
        var myRow = buildBandRow(c);
        myRow.className = 'jp-row jp-directed';
        myRow.insertAdjacentHTML('afterbegin', '<span class="jp-time">' + time + '</span>');
        myActivity.appendChild(myRow);
      }

      plotDecode(d);
    });

    clearOld();
    // Auto-scroll
    bandActivity.scrollTop = bandActivity.scrollHeight;
    myActivity.scrollTop = myActivity.scrollHeight;
  }

  // --- Event handlers ---
  window.api.onJtcatDecode(function(data) {
    // Keep our cached callsign current from the authoritative copy main stamps
    // on every batch, so classification never runs against a stale/empty call
    // (the original "reply to my CQ → grid instead of report" trigger).
    if (data && data.myCall) myCallsign = data.myCall.toUpperCase();
    renderDecodes(data);
    // NOTE: do NOT set "Sync: OK" here. Decodes arriving says nothing about
    // the PC clock — the real sync status comes from the NTP monitor via
    // onJtcatClock below. (K3SBP 2026-06-10: old code lit "Sync: OK" on every
    // cycle even with the clock 10 s off UTC and 0 decodes.)
  });

  // Spot-list highlight push from the main renderer. Rebuild the Map, then
  // re-tag already-rendered rows in place so existing decodes recolor
  // instantly when the user flips a filter in the main spot table.
  if (window.api.onJtcatSpotsHighlight) {
    window.api.onJtcatSpotsHighlight(function(data) {
      spottedCalls.clear();
      var calls = (data && data.calls) || [];
      for (var i = 0; i < calls.length; i++) {
        var c = calls[i];
        if (!c || !c.call) continue;
        spottedCalls.set(String(c.call).toUpperCase(), { isNewPark: !!c.isNewPark, reference: c.reference || '' });
      }
      // Repaint existing rows — iterate both band-activity and my-activity
      // because both may hold matching decodes.
      [bandActivity, myActivity].forEach(function(container) {
        if (!container) return;
        var rows = container.querySelectorAll('.jp-row');
        rows.forEach(function(row) {
          var msg = row.querySelector('.jp-msg');
          if (!msg) return;
          // Extract the DX call from the message (token 1 for CQ, token 1
          // for direct — good enough heuristic for FT8/FT4 grammar).
          var parts = (msg.textContent || '').trim().split(/\s+/);
          var dxCall = '';
          if (parts[0] === 'CQ') dxCall = parts[1] === 'DX' ? parts[2] : parts[1];
          else dxCall = parts[1] || '';
          if (!dxCall) { row.classList.remove('jp-spotted', 'jp-new-park'); return; }
          var match = spottedCalls.get(dxCall.toUpperCase());
          row.classList.toggle('jp-spotted', !!(match && !match.isNewPark));
          row.classList.toggle('jp-new-park', !!(match && match.isNewPark));
          if (match && match.reference) row.title = 'Spotted at ' + match.reference + (match.isNewPark ? ' (new park)' : '');
          else if (!match) row.removeAttribute('title');
        });
      });
    });
  }

  window.api.onJtcatCycle(function(data) {
    if (data.mode === 'FT2') {
      cycleEl.textContent = 'FT2';
      cycleEl.className = 'jtcat-cycle';
    } else {
      cycleEl.textContent = data.slot === 'even' ? 'E' : data.slot === 'odd' ? 'O' : '--';
      cycleEl.className = 'jtcat-cycle' + (data.slot === 'even' ? ' jtcat-slot-even' : data.slot === 'odd' ? ' jtcat-slot-odd' : '');
    }
  });

  var lastClockState = null; // last offset the monitor reported (set in applyClock)
  window.api.onJtcatStatus(function(data) {
    // Engine stopped. Clear the sync readout for an OK/unknown clock, BUT keep a
    // bad/warn banner up — the clock is still wrong and must be fixed before the
    // next run, so engine restarts (e.g. a SmartSDR/AetherSDR handoff cycling
    // the engine) must not flicker the warning away.
    if (data && data.state === 'stopped') {
      if (lastClockState && (lastClockState.level === 'bad' || lastClockState.level === 'warn')) {
        applyClock(lastClockState);
      } else {
        applyClock(null);
      }
    }
  });

  // --- Real clock-sync indicator + notice banner ---
  // Driven by the NTP offset monitor in main (jtcat-clock). FT8 is time-locked,
  // so a PC clock off by more than ~1 s silently kills decoding even though the
  // audio and waterfall look perfect.
  var clockBanner   = document.getElementById('jp-clock-banner');
  var clockMsg      = document.getElementById('jp-clock-msg');
  var clockSyncBtn  = document.getElementById('jp-clock-sync');
  var clockSetBtn   = document.getElementById('jp-clock-settings');
  var clockReBtn    = document.getElementById('jp-clock-recheck');
  var clockBannerHideTimer = null;

  function fmtOffset(ms) {
    return (ms > 0 ? '+' : '') + (ms / 1000).toFixed(1) + 's';
  }

  function applyClock(d) {
    if (!syncEl) return;
    lastClockState = d; // remembered so engine-stop can keep a bad banner up
    syncEl.classList.remove('jtcat-synced');
    syncEl.style.color = '';
    if (clockBanner) clockBanner.classList.add('hidden');

    if (!d) { syncEl.textContent = 'Sync: —'; return; }

    if (d.level === 'unknown') {
      // NTP unreachable — don't claim bad, just show we couldn't check.
      syncEl.textContent = 'Sync: ? (no NTP)';
      syncEl.style.color = '#888';
      syncEl.title = 'Could not reach an NTP server to measure clock offset' + (d.error ? ' (' + d.error + ')' : '');
      return;
    }

    var off = fmtOffset(d.offsetMs || 0);
    syncEl.title = 'PC clock offset vs ' + (d.server || 'NTP') + ': ' + off;

    if (d.level === 'ok') {
      syncEl.textContent = 'Sync: OK';
      syncEl.classList.add('jtcat-synced');
      if (d.rebaselined && clockBanner && clockMsg) {
        clockMsg.textContent = '✓ Clock corrected — FT8 timing re-baselined, decoding resumed.';
        clockBanner.style.background = '#1a5a2a';
        clockBanner.style.borderBottom = '2px solid #4ecca3';
        clockBanner.classList.remove('hidden');
        clearTimeout(clockBannerHideTimer);
        clockBannerHideTimer = setTimeout(function () { clockBanner.classList.add('hidden'); }, 6000);
      }
      return;
    }

    // warn / bad — light the indicator and raise the banner.
    var bad = d.level === 'bad';
    syncEl.textContent = 'Sync: ' + off + (bad ? ' ✕' : ' ⚠');
    syncEl.style.color = bad ? '#e94560' : '#f0a500';
    if (clockBanner && clockMsg) {
      clockMsg.textContent = bad
        ? '⚠ PC clock is ' + off + ' off UTC — FT8 will NOT decode until you fix it.'
        : '⚠ PC clock is ' + off + ' off UTC — decoding may be unreliable. Sync recommended.';
      clockBanner.style.background    = bad ? '#5a1a1a' : '#5a4a1a';
      clockBanner.style.borderBottom  = '2px solid ' + (bad ? '#e94560' : '#f0a500');
      clockBanner.classList.remove('hidden');
    }
  }

  if (window.api.onJtcatClock) window.api.onJtcatClock(applyClock);

  if (clockSetBtn && window.api.jtcatOpenTimeSettings) {
    clockSetBtn.addEventListener('click', function() { window.api.jtcatOpenTimeSettings(); });
  }
  if (clockReBtn && window.api.jtcatCheckClock) {
    clockReBtn.addEventListener('click', function() {
      if (clockMsg) clockMsg.textContent = 'Checking clock…';
      window.api.jtcatCheckClock().then(function(c) { if (c) applyClock(c); });
    });
  }
  if (clockSyncBtn && window.api.jtcatSyncClock) {
    clockSyncBtn.addEventListener('click', function() {
      if (clockMsg) clockMsg.textContent = 'Syncing clock…';
      window.api.jtcatSyncClock().then(function(res) {
        if (res && res.clock) applyClock(res.clock);
        if (res && res.sync && !res.sync.success && clockMsg) {
          // w32tm failed (usually: not Administrator). Tell the user, and the
          // "Time settings…" button is right there as the no-admin path.
          clockMsg.textContent = '⚠ ' + (res.sync.message || 'Sync failed') + ' — use “Time settings…”.';
        }
      });
    });
  }

  // Fetch whatever the monitor last measured (the engine may already have been
  // running before this popout opened, so we won't get a fresh broadcast).
  if (window.api.jtcatGetClock) {
    window.api.jtcatGetClock().then(function(c) { if (c) applyClock(c); });
  }

  // PTT mode indicator (CAT vs VOX)
  var pttModeEl = document.getElementById('jp-ptt-mode');
  if (window.api.onCatStatus) {
    window.api.onCatStatus(function(s) {
      if (!pttModeEl) return;
      if (s.connected || s.wsjtxMode) {
        pttModeEl.textContent = 'PTT: CAT';
        pttModeEl.classList.remove('is-vox');
        pttModeEl.classList.add('is-cat');
        pttModeEl.title = 'PTT via CAT command';
      } else {
        pttModeEl.textContent = 'PTT: VOX';
        pttModeEl.classList.remove('is-cat');
        pttModeEl.classList.add('is-vox');
        pttModeEl.title = 'No CAT connected — enable VOX on your radio';
      }
    });
  }

  // Radio frequency display
  var radioFreqEl = document.getElementById('jp-radio-freq');
  if (window.api.onCatFrequency) {
    window.api.onCatFrequency(function(hz) {
      if (!radioFreqEl || !hz) return;
      radioFreqEl.textContent = (hz / 1000000).toFixed(3) + ' MHz';
    });
  }

  window.api.onJtcatTxStatus(function(data) {
    transmitting = data.state === 'tx';
    rxTxEl.textContent = transmitting ? 'TX' : 'RX';
    rxTxEl.style.color = transmitting ? '#e94560' : '';
    // Highlight the TX waterfall pane in multi-slice mode
    if (multiActive) {
      document.querySelectorAll('.jp-wf-pane.wf-tx-active').forEach(function(el) { el.classList.remove('wf-tx-active'); });
      if (transmitting && data.sliceId) {
        for (var p of multiWfPanes) {
          if (p.sliceId === data.sliceId) {
            p.canvas.parentElement.classList.add('wf-tx-active');
            break;
          }
        }
      }
    }
    // Draw TX arc to the station we're working
    if (transmitting && qsoState && qsoState.call && myCallsign) {
      drawQsoArc(myCallsign, qsoState.call);
    }
    // Pulse the active QSO step when transmitting
    qsoSteps.querySelectorAll('.step-pulsing').forEach(function(el) { el.classList.remove('step-pulsing'); });
    if (transmitting) {
      var active = qsoSteps.querySelector('.step-current.step-tx');
      if (active) active.classList.add('step-pulsing');
    }
    if (transmitting && data.message) {
      txMsgEl.textContent = data.message;
      // Add TX row — prefixed with a .jp-cycle-sep so pruneCyclePanel() can
      // evict it like any decode cycle. Without the separator the row is
      // orphaned and accumulates forever (one per TX slot). (78hawkeye, PR #54.)
      var txTime = cycleBoundaryUtc();
      var txRowHtml = '<span class="jp-db">TX</span><span class="jp-df">--</span><span class="jp-msg">' + esc(data.message) + '</span>';
      var baEmpty = bandActivity.querySelector('.jp-empty');
      if (baEmpty) baEmpty.remove();
      var baSep = document.createElement('div');
      baSep.className = 'jp-cycle-sep';
      baSep.textContent = txTime + ' UTC';
      bandActivity.appendChild(baSep);
      var row = document.createElement('div');
      row.className = 'jp-row jp-tx';
      row.innerHTML = txRowHtml;
      bandActivity.appendChild(row);
      bandActivity.scrollTop = bandActivity.scrollHeight;
      // Also add TX row to My Activity — but inline the time per row (no
      // separator line) to match the directed-decode rows in this pane.
      var mEmpty = myActivity.querySelector('.jp-empty');
      if (mEmpty) mEmpty.remove();
      var myTxRow = document.createElement('div');
      myTxRow.className = 'jp-row jp-tx';
      myTxRow.innerHTML = '<span class="jp-time">' + txTime + '</span>' + txRowHtml;
      myActivity.appendChild(myTxRow);
      myActivity.scrollTop = myActivity.scrollHeight;
    }
  });

  // --- QSO state from main process ---
  window.api.onJtcatQsoState(function(data) {
    if (!data || data.phase === 'idle') {
      qsoState = null;
    } else if (data.phase === 'error') {
      qsoState = null;
      txEnabled = false;
      cqBtn.classList.remove('active');
      enableTxBtn.classList.remove('active');
      enableTxBtn.textContent = 'Enable TX';
      txMsgEl.textContent = data.error || 'Error';
      // Raise the same toast slot used for QSO-Logged success so the
      // "TX stopped" event is visible without DevTools. Red variant
      // distinguishes it from the green success toast. (K3SBP 2026-05-05:
      // the retry-limit was previously only logged to console.)
      showJtcatErrorToast(data.error || 'TX stopped');
      renderQsoTracker();
      return;
    } else {
      qsoState = data;
      // Draw arc to QSO partner — direction based on current phase
      if (qsoState.call && myCallsign) {
        if (qsoState.grid) registerStation(qsoState.call, qsoState.grid);
        // RX phases mean we just heard them -> arc goes them->us
        // TX phases mean we're about to send -> arc goes us->them
        var rxPhases = { 'cq-reply': 1, 'cq-r+rpt': 1, 'rpt-rx': 1, 'rr73-rx': 1 };
        var theyAreSource = rxPhases[qsoState.phase];
        if (theyAreSource) {
          drawQsoArc(qsoState.call, myCallsign);
        } else {
          drawQsoArc(myCallsign, qsoState.call);
        }
      }
    }
    renderQsoTracker();
    // Sync CQ button active state
    var cqActive = qsoState && qsoState.mode === 'cq' && qsoState.phase !== 'done';
    cqBtn.classList.toggle('active', !!cqActive);
    // Keep TX msg in sync
    if (qsoState && qsoState.txMsg) txMsgEl.textContent = qsoState.txMsg;
    else if (!qsoState) txMsgEl.textContent = '\u2014';
    // Sync TX button state
    if (qsoState && qsoState.phase !== 'done') {
      txEnabled = true;
      enableTxBtn.classList.add('active');
      enableTxBtn.textContent = 'TX On';
    }
    if (qsoState && qsoState.phase === 'done') {
      txEnabled = false;
      enableTxBtn.classList.remove('active');
      enableTxBtn.textContent = 'Enable TX';
    }
  });

  // --- QSO Logged notification ---
  var qsoToast = document.getElementById('jp-qso-toast');
  var qsoToastTimer = null;

  window.api.onJtcatQsoLogged(function(data) {
    if (qsoToastTimer) clearTimeout(qsoToastTimer);
    qsoToast.innerHTML = 'QSO with <b>' + esc(data.callsign) + '</b> Logged' +
      '<div class="jp-toast-sub">' + [data.band, data.mode, data.rstSent, data.rstRcvd, data.grid].filter(Boolean).join(' &middot; ') +
      ' &mdash; click to edit</div>';
    qsoToast.classList.add('visible');
    qsoToastTimer = setTimeout(function() {
      qsoToast.classList.remove('visible');
    }, 5000);
  });

  qsoToast.addEventListener('click', function() {
    if (qsoToastTimer) clearTimeout(qsoToastTimer);
    qsoToast.classList.remove('visible');
    qsoToast.classList.remove('error');
    // Focus main POTACAT window — QSO log is there (only meaningful for
    // the success toast; clicking an error toast just dismisses it).
    if (!qsoToast.dataset.errorToast) window.api.focusMain();
    delete qsoToast.dataset.errorToast;
  });

  // Shared "TX stopped / something went wrong" toast. Reuses jp-qso-toast
  // with the .error variant so we don't introduce a second floating UI
  // element. Stays up longer than the success toast (8s vs 5s) since the
  // user may need a moment to read why TX gave up.
  function showJtcatErrorToast(message, sub) {
    if (qsoToastTimer) clearTimeout(qsoToastTimer);
    qsoToast.innerHTML = esc(message) +
      (sub ? '<div class="jp-toast-sub">' + esc(sub) + '</div>' : '');
    qsoToast.classList.add('visible');
    qsoToast.classList.add('error');
    qsoToast.dataset.errorToast = '1';
    qsoToastTimer = setTimeout(function() {
      qsoToast.classList.remove('visible');
      qsoToast.classList.remove('error');
      delete qsoToast.dataset.errorToast;
    }, 8000);
  }

  // --- Countdown timer ---
  setInterval(function() {
    var mode = modeSelect.value;
    var cycleSec = mode === 'WSPR' ? 120 : mode === 'FT2' ? 3.8 : mode === 'FT4' ? 7.5 : 15;
    var cycleMs = cycleSec * 1000;
    var msInto = Date.now() % cycleMs;
    var remaining = (cycleMs - msInto) / 1000;
    countdownEl.textContent = (remaining < 10 ? remaining.toFixed(1) : Math.ceil(remaining)) + 's';
    if (mode === 'WSPR') updateWsprNext(msInto, remaining);
  }, 200);

  // FT2 dial frequencies (kHz) per band — from IU8LMC published table
  var FT2_BAND_FREQS = {
    '160m': 1843, '80m': 3578, '60m': 5360, '40m': 7052, '30m': 10144,
    '20m': 14084, '17m': 18108, '15m': 21144, '12m': 24923, '10m': 28184,
  };
  // FT4 dial frequencies (kHz) per band
  var FT4_BAND_FREQS = {
    '160m': 1840, '80m': 3568, '60m': 5357, '40m': 7047.5, '30m': 10140,
    '20m': 14080, '17m': 18104, '15m': 21140, '12m': 24919, '10m': 28180,
    '6m': 50318,
  };
  var FT8_BAND_FREQS = {
    '160m': 1840, '80m': 3573, '60m': 5357, '40m': 7074, '30m': 10136,
    '20m': 14074, '17m': 18100, '15m': 21074, '12m': 24915, '10m': 28074,
    '6m': 50313,
  };
  // WSPR USB dial frequencies (kHz) — the radio tunes here; signals sit
  // 1400–1600 Hz above. Matches lib/wspr/bands.js.
  var WSPR_BAND_FREQS = {
    '160m': 1836.6, '80m': 3568.6, '60m': 5287.2, '40m': 7038.6, '30m': 10138.7,
    '20m': 14095.6, '17m': 18104.6, '15m': 21094.6, '12m': 24924.6, '10m': 28124.6,
    '6m': 50293.0,
  };
  function updateBandFreqs() {
    var m = modeSelect.value;
    var table = m === 'WSPR' ? WSPR_BAND_FREQS : m === 'FT2' ? FT2_BAND_FREQS : m === 'FT4' ? FT4_BAND_FREQS : FT8_BAND_FREQS;
    document.querySelectorAll('.jtcat-band-btn').forEach(function(btn) {
      var band = btn.dataset.band;
      if (table[band]) btn.dataset.freq = table[band];
    });
  }

  // --- Mode change ---
  modeSelect.addEventListener('change', function() {
    updateBandFreqs();
    applyWsprMode(modeSelect.value === 'WSPR');
    window.api.jtcatSetMode(modeSelect.value);
    // Persist the mode so reopening JTCAT comes back in FT4/FT2 instead of
    // silently reverting to FT8 (which left the radio parked on the FT8 sub-
    // band and looked like "FT4 never decodes"). K3SBP 2026-06-10.
    window.api.saveSettings({ jtcatLastMode: modeSelect.value });
    // Retune to the active band's new frequency for the selected mode
    var activeBtn = document.querySelector('.jtcat-band-btn.active');
    if (activeBtn) selectBand(activeBtn, true);
  });

  // --- Controls ---
  cqFilterBtn.addEventListener('click', function() {
    cqFilter = !cqFilter;
    cqFilterBtn.classList.toggle('active', cqFilter);
    rebuildBandActivity();
  });

  wantedFilterBtn.addEventListener('click', function() {
    wantedFilter = !wantedFilter;
    wantedFilterBtn.classList.toggle('active', wantedFilter);
    rebuildBandActivity();
  });

  // --- Chase target picker (CqTarget shared module) ---
  // Quick-pick tags that live in the dropdown directly; anything else (a US
  // state or DXCC prefix) lives in the custom input under the "Custom…" option.
  var CHASE_QUICK = (window.CqTarget && window.CqTarget.QUICK_PICKS) || [];
  var chaseQuickSet = {};
  CHASE_QUICK.forEach(function(p) { chaseQuickSet[p.tag] = true; });

  (function buildChasePicker() {
    if (!chaseSelect) return;
    var html = '<option value="">Chase: --</option>';
    var lastCat = '';
    CHASE_QUICK.forEach(function(p) {
      if (p.category !== lastCat) {
        if (lastCat) html += '</optgroup>';
        html += '<optgroup label="' + esc(p.category) + '">';
        lastCat = p.category;
      }
      html += '<option value="' + esc(p.tag) + '">' + esc(p.tag) + '</option>';
    });
    if (lastCat) html += '</optgroup>';
    html += '<option value="__custom">Custom (state/prefix)…</option>';
    chaseSelect.innerHTML = html;
  })();

  // Reflect a tag into the picker UI without firing change handlers.
  function reflectChaseTarget(tag) {
    if (!chaseSelect) return;
    tag = tag || '';
    if (!tag) { chaseSelect.value = ''; if (chaseCustom) chaseCustom.style.display = 'none'; return; }
    if (chaseQuickSet[tag]) {
      chaseSelect.value = tag;
      if (chaseCustom) chaseCustom.style.display = 'none';
    } else {
      chaseSelect.value = '__custom';
      if (chaseCustom) { chaseCustom.style.display = ''; chaseCustom.value = tag; }
    }
  }

  // Validate + apply locally, then tell main (which persists + syncs the phone).
  function applyChaseTarget(rawTag) {
    var v = window.CqTarget ? window.CqTarget.validateTag(rawTag) : { ok: true, tag: (rawTag || '').toUpperCase() };
    if (!v.ok) { reflectChaseTarget(chaseTarget); return; } // revert on invalid (too long)
    chaseTarget = v.tag;
    reflectChaseTarget(chaseTarget);
    if (window.api.jtcatSetChaseTarget) window.api.jtcatSetChaseTarget(chaseTarget);
  }

  if (chaseSelect) {
    chaseSelect.addEventListener('change', function() {
      if (chaseSelect.value === '__custom') {
        if (chaseCustom) { chaseCustom.style.display = ''; chaseCustom.focus(); }
        return; // wait for the custom field to commit
      }
      applyChaseTarget(chaseSelect.value);
    });
  }
  if (chaseCustom) {
    var commitCustom = function() { applyChaseTarget(chaseCustom.value); };
    chaseCustom.addEventListener('change', commitCustom);
    chaseCustom.addEventListener('blur', commitCustom);
    chaseCustom.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); commitCustom(); chaseCustom.blur(); } });
  }
  if (chaseFilterBtn) {
    chaseFilterBtn.addEventListener('click', function() {
      chaseFilter = !chaseFilter;
      chaseFilterBtn.classList.toggle('active', chaseFilter);
      rebuildBandActivity();
    });
  }
  // Live sync from main (phone changed it, or echo of our own change).
  if (window.api.onJtcatChaseTarget) {
    window.api.onJtcatChaseTarget(function(state) {
      chaseTarget = (state && state.tag) || '';
      reflectChaseTarget(chaseTarget);
    });
  }

  var sortSignalBtn = document.getElementById('jp-sort-signal');
  sortSignalBtn.addEventListener('click', function() {
    sortBySignal = !sortBySignal;
    sortSignalBtn.classList.toggle('active', sortBySignal);
    rebuildBandActivity();
  });

  var searchInput = document.getElementById('jp-search');
  searchInput.addEventListener('input', function() {
    searchFilter = searchInput.value.toUpperCase().trim();
    rebuildBandActivity();
  });

  // --- Multi-slice ---
  var multiPanel = document.getElementById('jp-multi-panel');
  var multiSlicesEl = document.getElementById('jp-multi-slices');
  var multiBtn = document.getElementById('jp-multi-btn');
  var multiAddBtn = document.getElementById('jp-multi-add');
  var multiStartBtn = document.getElementById('jp-multi-start');
  var multiStopBtn = document.getElementById('jp-multi-stop');
  var multiActive = false;
  var multiSliceConfigs = JSON.parse(localStorage.getItem('jtcat-multi-slices') || '[]');
  var audioDeviceList = []; // cached device list

  function saveMultiSliceConfigs() {
    localStorage.setItem('jtcat-multi-slices', JSON.stringify(multiSliceConfigs));
  }

  var BAND_COLORS = {
    '160m': '#ff4444', '80m': '#ff8c00', '60m': '#ffd700', '40m': '#4ecca3',
    '30m': '#00cccc', '20m': '#4488ff', '17m': '#8844ff', '15m': '#cc44ff',
    '12m': '#ff44cc', '10m': '#ff4488', '6m': '#e0e0e0', '2m': '#88ff88',
  };
  var BAND_FREQS = { '80m': 3573, '40m': 7074, '30m': 10136, '20m': 14074, '17m': 18100, '15m': 21074, '12m': 24915, '10m': 28074, '6m': 50313 };
  var SLICE_NAMES = { 5002: 'A', 5003: 'B', 5004: 'C', 5005: 'D' };

  if (multiBtn) multiBtn.addEventListener('click', function() {
    multiPanel.classList.toggle('hidden');
    multiBtn.classList.toggle('active', !multiPanel.classList.contains('hidden'));
    if (!multiPanel.classList.contains('hidden')) {
      if (multiSliceConfigs.length === 0) {
        multiSliceConfigs = [
          { sliceId: 'slice-a', slicePort: 5002, band: '20m', audioDeviceId: '' },
          { sliceId: 'slice-b', slicePort: 5003, band: '40m', audioDeviceId: '' },
        ];
      }
      refreshAudioDevices();
    }
  });

  function refreshAudioDevices() {
    window.api.enumerateAudioDevices().then(function(devices) {
      audioDeviceList = devices;
      renderMultiSlices();
    });
  }

  function renderMultiSlices() {
    multiSlicesEl.innerHTML = '';
    multiSliceConfigs.forEach(function(cfg, idx) {
      var row = document.createElement('div');
      row.className = 'jp-multi-row';

      // Slice selector
      var sliceSel = document.createElement('select');
      sliceSel.title = 'Flex slice';
      [5002, 5003, 5004, 5005].forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p;
        opt.textContent = 'Slice ' + SLICE_NAMES[p];
        if (p === cfg.slicePort) opt.selected = true;
        sliceSel.appendChild(opt);
      });
      sliceSel.addEventListener('change', function() {
        cfg.slicePort = parseInt(sliceSel.value, 10);
        cfg.sliceId = 'slice-' + SLICE_NAMES[cfg.slicePort].toLowerCase();
        saveMultiSliceConfigs();
      });
      row.appendChild(sliceSel);

      // Band selector
      var bandSel = document.createElement('select');
      bandSel.title = 'Band';
      Object.keys(BAND_FREQS).forEach(function(b) {
        var opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b;
        if (b === cfg.band) opt.selected = true;
        bandSel.appendChild(opt);
      });
      bandSel.addEventListener('change', function() { cfg.band = bandSel.value; saveMultiSliceConfigs(); });
      row.appendChild(bandSel);

      // Audio device selector
      var audioSel = document.createElement('select');
      audioSel.title = 'Audio input (DAX RX channel)';
      audioSel.style.width = '160px';
      var defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = '(default)';
      audioSel.appendChild(defOpt);
      audioDeviceList.forEach(function(d) {
        var opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || d.deviceId.slice(0, 20);
        if (d.deviceId === cfg.audioDeviceId) opt.selected = true;
        audioSel.appendChild(opt);
      });
      audioSel.addEventListener('change', function() { cfg.audioDeviceId = audioSel.value; saveMultiSliceConfigs(); });
      row.appendChild(audioSel);

      // Remove button
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '\u2715';
      delBtn.style.cssText = 'font-size:12px;color:#e94560;background:none;border:none;cursor:pointer;padding:0 4px;';
      delBtn.addEventListener('click', function() {
        multiSliceConfigs.splice(idx, 1);
        saveMultiSliceConfigs();
        renderMultiSlices();
      });
      row.appendChild(delBtn);

      multiSlicesEl.appendChild(row);
    });
  }

  if (multiAddBtn) multiAddBtn.addEventListener('click', function() {
    var usedPorts = multiSliceConfigs.map(function(c) { return c.slicePort; });
    var nextPort = [5002, 5003, 5004, 5005].find(function(p) { return usedPorts.indexOf(p) === -1; }) || 5005;
    var usedBands = multiSliceConfigs.map(function(c) { return c.band; });
    var nextBand = Object.keys(BAND_FREQS).find(function(b) { return usedBands.indexOf(b) === -1; }) || '20m';
    multiSliceConfigs.push({ sliceId: 'slice-' + SLICE_NAMES[nextPort].toLowerCase(), slicePort: nextPort, band: nextBand, audioDeviceId: '' });
    saveMultiSliceConfigs();
    renderMultiSlices();
  });

  // Multi-slice audio capture state
  var multiAudioStreams = new Map(); // sliceId -> { ctx, stream, processor }

  async function startMultiAudio() {
    stopMultiAudio();
    for (var cfg of multiSliceConfigs) {
      try {
        var constraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        if (cfg.audioDeviceId) constraints.deviceId = { exact: cfg.audioDeviceId };
        var stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        var ctx = new AudioContext();
        if (ctx.state === 'suspended') await ctx.resume();
        var source = ctx.createMediaStreamSource(stream);
        var dsRatio = ctx.sampleRate / 12000;

        var sliceId = cfg.sliceId;
        try {
          await ctx.audioWorklet.addModule('jtcat-audio-worklet.js');
          var worklet = new AudioWorkletNode(ctx, 'jtcat-processor', { processorOptions: { dsRatio: dsRatio } });
          worklet.port.onmessage = (function(id) { return function(e) { window.api.jtcatSliceAudio(id, e.data); }; })(sliceId);
          source.connect(worklet);
          worklet.connect(ctx.destination);
          multiAudioStreams.set(sliceId, { ctx: ctx, stream: stream, processor: worklet });
        } catch (wErr) {
          var bufSize = Math.pow(2, Math.ceil(Math.log2(4096 * Math.ceil(dsRatio))));
          if (bufSize > 16384) bufSize = 16384;
          var sp = ctx.createScriptProcessor(bufSize, 1, 1);
          var acc = new Float32Array(0);
          sp.onaudioprocess = (function(id, ratio) {
            return function(e) {
              var input = e.data ? e.data : e.inputBuffer.getChannelData(0);
              var step = Math.floor(ratio);
              var out = new Float32Array(Math.floor(input.length / step));
              for (var i = 0; i < out.length; i++) out[i] = input[i * step];
              window.api.jtcatSliceAudio(id, out);
            };
          })(sliceId, dsRatio);
          source.connect(sp);
          sp.connect(ctx.destination);
          multiAudioStreams.set(sliceId, { ctx: ctx, stream: stream, processor: sp });
        }
        console.log('[Multi] Audio started for ' + sliceId + ' device=' + (cfg.audioDeviceId || 'default'));
      } catch (err) {
        console.error('[Multi] Audio failed for ' + cfg.sliceId + ':', err.message);
      }
    }
  }

  function stopMultiAudio() {
    multiAudioStreams.forEach(function(entry) {
      if (entry.processor) try { entry.processor.disconnect(); } catch(e) {}
      if (entry.ctx) entry.ctx.close().catch(function() {});
      if (entry.stream) entry.stream.getTracks().forEach(function(t) { t.stop(); });
    });
    multiAudioStreams.clear();
  }

  if (multiStartBtn) multiStartBtn.addEventListener('click', async function() {
    if (multiSliceConfigs.length === 0) return;
    multiActive = true;
    multiStartBtn.style.display = 'none';
    multiStopBtn.style.display = '';

    // Tune each slice to its band
    for (var cfg of multiSliceConfigs) {
      var freqKhz = BAND_FREQS[cfg.band] || 14074;
      window.api.tune(String(freqKhz), 'FT8', undefined, cfg.slicePort);
    }

    // Start engines in main process
    var sliceData = multiSliceConfigs.map(function(c) {
      return { sliceId: c.sliceId, mode: modeSelect.value, band: c.band, freqKhz: BAND_FREQS[c.band] || 14074, slicePort: c.slicePort };
    });
    window.api.jtcatStartMulti(sliceData);

    // Start audio captures
    await startMultiAudio();

    // Clear decode log
    bandActivity.innerHTML = '<div class="jp-empty">Multi-slice decoding...</div>';
    myActivity.innerHTML = '<div class="jp-empty">No activity yet</div>';

    // Auto-focus first slice for waterfall
    focusedSlice = multiSliceConfigs[0].sliceId;
    setTimeout(function() {
      buildWaterfallSliceBar();
      buildMultiWaterfalls();
    }, 500); // delay to let audio streams init
  });

  if (multiStopBtn) multiStopBtn.addEventListener('click', function() {
    multiActive = false;
    multiStartBtn.style.display = '';
    multiStopBtn.style.display = 'none';
    stopMultiAudio();
    window.api.jtcatStop();
    // Hide waterfall slice bar and multi-waterfalls
    var wfSliceBar = document.getElementById('jp-wf-slice-bar');
    if (wfSliceBar) { wfSliceBar.classList.add('hidden'); wfSliceBar.innerHTML = ''; }
    focusedSlice = null;
    buildMultiWaterfalls(); // will hide multi, show single
  });

  // Waterfall slice selector — switch which slice's audio drives the waterfall analyser
  var focusedSlice = null; // sliceId of the slice currently shown in waterfall

  function buildWaterfallSliceBar() {
    var wfSliceBar = document.getElementById('jp-wf-slice-bar');
    if (!wfSliceBar || !multiActive) return;
    wfSliceBar.classList.remove('hidden');
    wfSliceBar.style.display = 'flex';
    wfSliceBar.innerHTML = '';
    multiSliceConfigs.forEach(function(cfg) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = cfg.band + ' (' + SLICE_NAMES[cfg.slicePort] + ')';
      btn.style.cssText = 'font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid ' +
        (BAND_COLORS[cfg.band] || '#888') + ';background:' +
        (focusedSlice === cfg.sliceId ? (BAND_COLORS[cfg.band] || '#888') : 'transparent') +
        ';color:' + (focusedSlice === cfg.sliceId ? '#000' : (BAND_COLORS[cfg.band] || '#888')) +
        ';cursor:pointer;font-weight:600;';
      btn.addEventListener('click', function() {
        focusedSlice = cfg.sliceId;
        // Switch the analyser to this slice's audio context
        var entry = multiAudioStreams.get(cfg.sliceId);
        if (entry && entry.ctx) {
          // Create or reuse analyser on this slice's context
          if (!entry.analyser) {
            entry.analyser = entry.ctx.createAnalyser();
            entry.analyser.fftSize = 2048;
            entry.analyser.smoothingTimeConstant = 0.3;
            // Connect the source to the analyser
            var src = entry.ctx.createMediaStreamSource(entry.stream);
            src.connect(entry.analyser);
          }
          popoutAnalyser = entry.analyser;
        }
        buildWaterfallSliceBar(); // re-render to update active state
      });
      wfSliceBar.appendChild(btn);
    });
  }

  // Side-by-side waterfalls — one per slice
  var multiWfPanes = []; // [{sliceId, canvas, ctx, analyser}]
  var multiWfAnim = null;

  function buildMultiWaterfalls() {
    var container = document.getElementById('jp-wf-multi');
    var singleWf = document.getElementById('jp-wf-single');
    if (!container) return;

    // Stop existing animation
    if (multiWfAnim) { cancelAnimationFrame(multiWfAnim); multiWfAnim = null; }
    multiWfPanes = [];
    container.innerHTML = '';

    if (!multiActive || multiSliceConfigs.length === 0) {
      container.classList.add('hidden');
      if (singleWf) singleWf.style.display = '';
      return;
    }

    // Hide single waterfall, show multi
    if (singleWf) singleWf.style.display = 'none';
    container.classList.remove('hidden');

    multiSliceConfigs.forEach(function(cfg) {
      var pane = document.createElement('div');
      pane.className = 'jp-wf-pane';

      // Band label
      var label = document.createElement('div');
      label.className = 'jp-wf-label';
      label.textContent = cfg.band;
      label.style.background = BAND_COLORS[cfg.band] || '#888';
      label.style.color = '#000';
      pane.appendChild(label);

      // Canvas
      var canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 60;
      pane.appendChild(canvas);

      // TX marker line
      var txLine = document.createElement('div');
      txLine.className = 'jp-wf-tx-line';
      txLine.style.left = '50%';
      pane.appendChild(txLine);

      // TX freq label
      var txHz = document.createElement('div');
      txHz.className = 'jp-wf-tx-hz';
      txHz.textContent = '1500';
      txHz.style.left = '50%';
      pane.appendChild(txHz);

      // Click to set TX freq on this slice
      (function(sliceId, canvasEl, txLineEl, txHzEl) {
        canvasEl.addEventListener('click', function(e) {
          var rect = canvasEl.getBoundingClientRect();
          var x = e.clientX - rect.left;
          var fraction = x / rect.width;
          var hz = Math.max(100, Math.min(3000, Math.round(fraction * 3000 / 10) * 10));
          // Update TX marker
          var pct = (hz / 3000) * 100;
          txLineEl.style.left = pct + '%';
          txHzEl.textContent = hz;
          txHzEl.style.left = pct + '%';
          // Set TX freq on the engine for this slice
          window.api.jtcatSetTxFreq(hz);
          // Focus this slice for TX
          if (jtcatManager) window.api.saveSettings({ _multiTxSlice: sliceId });
        });
      })(cfg.sliceId, canvas, txLine, txHz);

      container.appendChild(pane);

      // Get analyser from audio stream
      var entry = multiAudioStreams.get(cfg.sliceId);
      var analyser = null;
      if (entry && entry.ctx && entry.stream) {
        analyser = entry.ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.3;
        var src = entry.ctx.createMediaStreamSource(entry.stream);
        src.connect(analyser);
      }

      multiWfPanes.push({ sliceId: cfg.sliceId, canvas: canvas, ctx: canvas.getContext('2d'), analyser: analyser, sampleRate: entry ? entry.ctx.sampleRate : 48000, txLine: txLine, txHz: txHz });
    });

    // Start waterfall animation loop
    function drawMultiWf() {
      for (var p of multiWfPanes) {
        if (!p.analyser || !p.ctx) continue;
        var w = p.canvas.width, h = p.canvas.height;
        // Scroll down
        var imgData = p.ctx.getImageData(0, 0, w, h - 1);
        p.ctx.putImageData(imgData, 0, 1);
        // Draw new line at top
        var bins = new Uint8Array(p.analyser.frequencyBinCount);
        p.analyser.getByteFrequencyData(bins);
        // Map 0-3kHz (FT8 passband) to canvas width
        // AudioContext sample rate is typically 48kHz, so 3kHz = bins * (3000 / (sampleRate/2))
        var nyquist = (p.sampleRate || 48000) / 2;
        var useBins = Math.max(1, Math.floor(bins.length * 3000 / nyquist));
        for (var x = 0; x < w; x++) {
          var binIdx = Math.floor(x * useBins / w);
          var val = bins[binIdx];
          // Color: dark blue -> cyan -> yellow -> red
          var r, g, b;
          if (val < 85) { r = 0; g = 0; b = Math.floor(val * 2); }
          else if (val < 170) { r = 0; g = Math.floor((val - 85) * 3); b = 170; }
          else { r = Math.floor((val - 170) * 3); g = 255; b = 170 - Math.floor((val - 170) * 2); }
          p.ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
          p.ctx.fillRect(x, 0, 1, 1);
        }
      }
      multiWfAnim = requestAnimationFrame(drawMultiWf);
    }
    multiWfAnim = requestAnimationFrame(drawMultiWf);
  }

  document.getElementById('jp-clear').addEventListener('click', function() {
    bandActivity.innerHTML = '<div class="jp-empty">Waiting for decodes...</div>';
    myActivity.innerHTML = '<div class="jp-empty">No activity yet</div>';
  });

  cqBtn.addEventListener('click', function() {
    // Call CQ directed at the current chase target (CQ <tag> <call> <grid>).
    window.api.jtcatCallCq(chaseTarget);
  });

  enableTxBtn.addEventListener('click', function() {
    txEnabled = !txEnabled;
    enableTxBtn.classList.toggle('active', txEnabled);
    enableTxBtn.textContent = txEnabled ? 'TX On' : 'Enable TX';
    window.api.jtcatEnableTx(txEnabled);
  });

  haltTxBtn.addEventListener('click', function() {
    txEnabled = false;
    enableTxBtn.classList.remove('active');
    enableTxBtn.textContent = 'Enable TX';
    window.api.jtcatCancelQso();
    txMsgEl.textContent = '--';
  });

  if (tuneBtn) {
    tuneBtn.addEventListener('click', function() { window.api.jtcatTuneToggle(); });
  }
  window.api.onJtcatTuneState(function(state) {
    if (!tuneBtn) return;
    if (state.active) {
      tuneBtn.classList.add('active');
      tuneBtn.textContent = 'Tune ' + state.secondsRemaining;
    } else {
      tuneBtn.classList.remove('active');
      tuneBtn.textContent = 'Tune';
    }
  });

  qsoCancelBtn.addEventListener('click', function() {
    window.api.jtcatCancelQso();
  });

  qsoSkipBtn.addEventListener('click', function() {
    window.api.jtcatSkipPhase();
  });

  document.getElementById('jp-open-log').addEventListener('click', function() {
    window.api.openQsoLog();
  });

  // Auto-CQ response
  var autoCqSelect = document.getElementById('jp-auto-cq');
  autoCqSelect.addEventListener('change', function() {
    window.api.jtcatSetAutoCqMode(autoCqSelect.value);
    if (autoCqSelect.value !== 'off') {
      txEnabled = true;
      enableTxBtn.classList.add('active');
      enableTxBtn.textContent = 'TX On';
      window.api.jtcatEnableTx(true);
    }
  });
  window.api.onJtcatAutoCqState(function(state) {
    autoCqSelect.value = state.mode || 'off';
    autoCqSelect.style.borderColor = state.mode !== 'off' ? 'var(--pota)' : '';
  });

  // ULTRACAT — Full Auto CQ run mode (button hidden unless π-unlocked)
  var fullAutoCqActive = false;
  if (fullAutoCqBtn) {
    fullAutoCqBtn.addEventListener('click', function() {
      var turningOn = !fullAutoCqActive;
      window.api.jtcatSetFullAutoCq({ on: turningOn, modifier: chaseTarget });
      if (turningOn) { // run mode drives TX
        txEnabled = true;
        enableTxBtn.classList.add('active');
        enableTxBtn.textContent = 'TX On';
        window.api.jtcatEnableTx(true);
      }
    });
  }
  window.api.onJtcatFullAutoCqState(function(state) {
    fullAutoCqActive = !!(state && state.active);
    if (fullAutoCqBtn) {
      fullAutoCqBtn.classList.toggle('active', fullAutoCqActive);
      fullAutoCqBtn.textContent = fullAutoCqActive ? 'Auto CQ ●' : 'Auto CQ';
    }
    if (!fullAutoCqActive) {
      enableTxBtn.classList.remove('active');
      enableTxBtn.textContent = 'Enable TX';
      txEnabled = false;
    }
  });
  if (maxAttemptsInput) {
    maxAttemptsInput.addEventListener('change', function() {
      var n = parseInt(maxAttemptsInput.value, 10);
      if (!isFinite(n) || n < 1) n = 1;
      if (n > 60) n = 60;
      maxAttemptsInput.value = n;
      window.api.saveSettings({ jtcatMaxQsoAttempts: n });
    });
  }

  // ARRL Field Day mode toggle + exchange entry
  if (fdToggle) {
    fdToggle.addEventListener('click', function() {
      fdMode = !fdMode;
      reflectFd();
      window.api.saveSettings({ jtcatFdMode: fdMode });
      if (fdMode && fdExchInput) {
        fdExchInput.focus();
        if (!FD_EXCH_RE.test((fdExchInput.value || '').toUpperCase().trim())) {
          fdExchInput.style.borderColor = 'var(--accent-red, #e94560)';
        }
      }
    });
  }
  if (fdExchInput) {
    fdExchInput.addEventListener('change', function() {
      var v = (fdExchInput.value || '').toUpperCase().trim().replace(/\s+/g, ' ');
      fdExchInput.value = v;
      var ok = FD_EXCH_RE.test(v);
      fdExchInput.style.borderColor = ok || !v ? '' : 'var(--accent-red, #e94560)';
      if (ok) window.api.saveSettings({ jtcatFdExch: v });
    });
  }

  // Band buttons
  function selectBand(btn, save) {
    var freq = parseFloat(btn.dataset.freq);
    window.api.tune(freq, modeSelect.value);
    // WSPR: tell the decoder which dial we're on (MHz) so it reports absolute
    // spot frequencies and picks the band.
    if (modeSelect.value === 'WSPR' && window.api.jtcatSetWsprDial) {
      window.api.jtcatSetWsprDial(btn.dataset.band);
      wsprClearSpots();
    }
    document.querySelectorAll('.jtcat-band-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    // Clear decodes
    decodeLog = [];
    bandActivity.innerHTML = '<div class="jp-empty">' + (save ? 'Switching to ' + btn.dataset.band + '...' : 'Waiting for signals...') + '</div>';
    myActivity.innerHTML = '<div class="jp-empty">No activity yet</div>';
    markerLayer.clearLayers();
    arcLayer.clearLayers();
    stations = {};
    qsoArcs = {};
    // Re-register own station so QSO arcs can draw to/from us
    if (myCallsign && myGrid && map) registerStation(myCallsign, myGrid);
    if (save) {
      // Partial save — only save the band freq, don't trigger full CAT reconnect
      window.api.saveSettings({ jtcatLastBandFreq: freq });
    }
  }

  document.querySelectorAll('.jtcat-band-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { selectBand(btn, true); });
  });

  // ===================== WSPR =====================
  // WSPR is a beacon/propagation mode, not a QSO mode. This pane swaps in for
  // the FT8 decode/QSO UI: a rich spot list (who heard what, how far) + beacon
  // controls. Decode comes from the separate wsprd process via main.js.
  var wsprPane = document.getElementById('jp-wspr-pane');
  var decodePane = document.querySelector('.jp-decode-pane');
  var controlsBar = document.querySelector('.jp-controls');
  var wsprListEl = document.getElementById('jp-wspr-list');
  var wsprMetaEl = document.getElementById('jp-wspr-meta');
  var wsprNextEl = document.getElementById('jp-wspr-next');
  var wsprTxEnable = document.getElementById('jp-wspr-tx-enable');
  var wsprTxPctEl = document.getElementById('jp-wspr-txpct');
  var wsprTxPctVal = document.getElementById('jp-wspr-txpct-val');
  var wsprDbmEl = document.getElementById('jp-wspr-dbm');
  var wsprUploadEl = document.getElementById('jp-wspr-upload');
  var wsprSortBtn = document.getElementById('jp-wspr-sort');
  var wsprClearBtn = document.getElementById('jp-wspr-clear');
  var wsprStatsEl = document.getElementById('jp-wspr-stats');
  var wsprShowHeard = document.getElementById('jp-wspr-show-heard');
  var wsprHopCb = document.getElementById('jp-wspr-hop');
  var wsprHopBandsEl = document.getElementById('jp-wspr-hop-bands');
  var wsprHopSel = [];
  var wsprSpots = [];
  var wsprHeard = [];           // "where am I heard" reception reports (wspr.live)
  var wsprSortByDx = false;
  var wsprDistUnit = 'mi';
  var wsprMarkerLayer = L.layerGroup();   // who I hear (RX spots)
  var wsprHeardLayer = L.layerGroup();    // who hears me (TX footprint)

  function wsprFmtDist(mi) {
    return wsprDistUnit === 'km' ? Math.round(mi * 1.60934) + ' km' : mi + ' mi';
  }

  function wsprEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function wsprFmtTime(t) {
    if (t && /^\d{4}$/.test(t)) return t.slice(0, 2) + ':' + t.slice(2);
    return t || '';
  }
  function wsprSnrColor(snr) {
    if (snr == null) return '#888';
    if (snr >= -10) return '#4ecca3';   // strong — green
    if (snr >= -20) return '#f0a500';   // moderate — amber
    return '#e94560';                   // weak — red
  }

  function applyWsprMode(on) {
    if (wsprPane) wsprPane.classList.toggle('hidden', !on);
    if (decodePane) decodePane.classList.toggle('hidden', on);
    if (controlsBar) controlsBar.classList.toggle('hidden', on);
    if (on && qsoTracker) qsoTracker.classList.add('hidden');
    // The toolbar "TX: 1500 Hz" is the FT8/FT4/FT2 audio offset — meaningless in
    // WSPR, where each transmission picks a random spot in the 200 Hz sub-band.
    if (txFreqLabel) txFreqLabel.style.display = on ? 'none' : '';
    if (map) {
      if (on) {
        markerLayer.clearLayers(); arcLayer.clearLayers();
        if (!map.hasLayer(wsprMarkerLayer)) wsprMarkerLayer.addTo(map);
        if (wsprShowHeard.checked && !map.hasLayer(wsprHeardLayer)) wsprHeardLayer.addTo(map);
      } else {
        if (map.hasLayer(wsprMarkerLayer)) wsprMarkerLayer.remove();
        if (map.hasLayer(wsprHeardLayer)) wsprHeardLayer.remove();
      }
    }
    if (on) wsprRender();
  }

  function wsprInit(s) {
    s = s || {};
    wsprDistUnit = s.distUnit === 'km' ? 'km' : 'mi';
    if (s.wsprTxPct != null) wsprTxPctEl.value = s.wsprTxPct;
    wsprTxPctVal.textContent = wsprTxPctEl.value + '%';
    // Power is capped at 30 dBm (1 W). Clamp a restored value and fall back to
    // 30 if it doesn't match an offered (<=1 W) option.
    var savedDbm = Math.min(30, s.wsprDbm != null ? s.wsprDbm : 30);
    wsprDbmEl.value = String(savedDbm);
    if (wsprDbmEl.selectedIndex < 0) wsprDbmEl.value = '30';
    wsprUploadEl.checked = !!s.wsprUpload;

    wsprTxPctEl.addEventListener('input', function() { wsprTxPctVal.textContent = wsprTxPctEl.value + '%'; });
    wsprTxPctEl.addEventListener('change', function() {
      var v = parseInt(wsprTxPctEl.value, 10);
      window.api.saveSettings({ wsprTxPct: v });
      if (window.api.jtcatWsprBeacon) window.api.jtcatWsprBeacon({ txPct: v });
    });
    wsprDbmEl.addEventListener('change', function() {
      var v = Math.min(30, parseInt(wsprDbmEl.value, 10) || 0); // 30 dBm = 1 W cap
      window.api.saveSettings({ wsprDbm: v });
      if (window.api.jtcatWsprBeacon) window.api.jtcatWsprBeacon({ dBm: v });
    });
    wsprUploadEl.addEventListener('change', function() {
      window.api.saveSettings({ wsprUpload: wsprUploadEl.checked });
    });
    wsprTxEnable.addEventListener('change', function() {
      if (window.api.jtcatWsprBeacon) window.api.jtcatWsprBeacon({
        enabled: wsprTxEnable.checked,
        txPct: parseInt(wsprTxPctEl.value, 10),
        dBm: parseInt(wsprDbmEl.value, 10),
      });
    });
    wsprSortBtn.addEventListener('click', function() {
      wsprSortByDx = !wsprSortByDx;
      wsprSortBtn.classList.toggle('active', wsprSortByDx);
      wsprRender();
    });
    wsprClearBtn.addEventListener('click', wsprClearSpots);
    wsprShowHeard.addEventListener('change', function() {
      if (!map) return;
      if (wsprShowHeard.checked && modeSelect.value === 'WSPR') {
        if (!map.hasLayer(wsprHeardLayer)) wsprHeardLayer.addTo(map);
      } else if (map.hasLayer(wsprHeardLayer)) {
        wsprHeardLayer.remove();
      }
    });
    // Band-hop chips + toggle
    wsprHopSel = Array.isArray(s.wsprHopBands) ? s.wsprHopBands.slice() : [];
    wsprBuildHopChips();
    wsprHopCb.checked = !!s.wsprHopEnabled && wsprHopSel.length >= 2;
    wsprHopCb.addEventListener('change', function() {
      window.api.jtcatWsprHop({ enabled: wsprHopCb.checked, bands: wsprHopSel });
    });
  }

  // One toggle chip per WSPR band; click to include/exclude from the hop set.
  function wsprBuildHopChips() {
    if (!wsprHopBandsEl) return;
    var order = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
    wsprHopBandsEl.innerHTML = '';
    order.forEach(function(b) {
      if (!WSPR_BAND_FREQS[b]) return;
      var chip = document.createElement('span');
      chip.className = 'jp-wspr-chip' + (wsprHopSel.indexOf(b) >= 0 ? ' on' : '');
      chip.textContent = b.replace('m', '');
      chip.title = b + ' — ' + WSPR_BAND_FREQS[b] + ' kHz';
      chip.dataset.band = b;
      chip.addEventListener('click', function() {
        var i = wsprHopSel.indexOf(b);
        if (i >= 0) wsprHopSel.splice(i, 1); else wsprHopSel.push(b);
        chip.classList.toggle('on', wsprHopSel.indexOf(b) >= 0);
        window.api.jtcatWsprHop({ bands: wsprHopSel, enabled: wsprHopCb.checked });
      });
      wsprHopBandsEl.appendChild(chip);
    });
  }

  function wsprClearSpots() {
    wsprSpots = [];
    wsprMarkerLayer.clearLayers();
    wsprRender();
  }

  function updateWsprNext(msInto, remaining) {
    if (!wsprNextEl) return;
    var armed = wsprTxEnable && wsprTxEnable.checked;
    var inTxWin = armed && msInto >= 1000 && msInto < 111600;
    wsprNextEl.classList.toggle('tx', !!inTxWin);
    var label = inTxWin ? 'TX' : (armed ? 'Beacon' : 'RX');
    var t = remaining < 60 ? Math.ceil(remaining) + 's'
      : Math.floor(remaining / 60) + ':' + (Math.ceil(remaining % 60) < 10 ? '0' : '') + Math.ceil(remaining % 60);
    wsprNextEl.textContent = label + ' · ' + t;
  }

  function wsprAddSpots(payload) {
    if (!payload) return;
    if (payload.error) wsprMetaEl.textContent = '⚠ ' + payload.error;
    var spots = payload.spots || [];
    spots.forEach(function(s) {
      s._key = (s.call || '?') + '|' + (s.freqMHz || 0).toFixed(6);
      s._new = true;
      var i = wsprSpots.findIndex(function(x) { return x._key === s._key; });
      if (i >= 0) wsprSpots.splice(i, 1);
      wsprSpots.unshift(s);
    });
    if (wsprSpots.length > 300) wsprSpots.length = 300;
    wsprRender();
    spots.forEach(wsprAddMarker);
  }

  function wsprRender() {
    if (!wsprListEl) return;
    var rows = wsprSpots.slice();
    if (wsprSortByDx) rows.sort(function(a, b) { return (b.distanceMi || 0) - (a.distanceMi || 0); });
    var maxDist = 0;
    wsprSpots.forEach(function(s) { if (s.distanceMi > maxDist) maxDist = s.distanceMi; });
    if (!rows.length) {
      wsprListEl.innerHTML = '<div class="jp-empty">No WSPR spots yet — listening on a 2-minute cycle…</div>';
    } else {
      wsprListEl.innerHTML = rows.map(function(s) {
        var dist = s.distanceMi != null
          ? (wsprDistUnit === 'km' ? Math.round(s.distanceMi * 1.60934) + ' km' : s.distanceMi + ' mi') : '';
        var isDx = s.distanceMi && s.distanceMi === maxDist && maxDist > 0;
        return '<div class="jp-wspr-row' + (s._new ? ' is-new' : '') + (isDx ? ' is-dx' : '') + '">' +
          '<span class="w-time">' + wsprEsc(wsprFmtTime(s.timeUtc)) + '</span>' +
          '<span class="w-db">' + (s.snr != null ? s.snr : '') + '</span>' +
          '<span class="w-dt">' + (s.dt != null ? s.dt.toFixed(1) : '') + '</span>' +
          '<span class="w-freq">' + (s.freqMHz != null ? s.freqMHz.toFixed(4) : '') + '</span>' +
          '<span class="w-dr">' + (s.drift != null ? s.drift : '') + '</span>' +
          '<span class="w-call">' + wsprEsc(s.call || '') + '</span>' +
          '<span class="w-grid">' + wsprEsc(s.grid || '') + '</span>' +
          '<span class="w-country" title="' + wsprEsc(s.entity || '') + '">' + wsprEsc(s.entity || '') + '</span>' +
          '<span class="w-reg">' + wsprEsc(s.continent || '') + '</span>' +
          '<span class="w-dist">' + dist + '</span>' +
          '<span class="w-az">' + (s.bearing != null ? s.bearing + '°' : '') + '</span>' +
          '</div>';
      }).join('');
    }
    var calls = {};
    wsprSpots.forEach(function(s) { if (s.call) calls[s.call] = 1; });
    wsprMetaEl.textContent = wsprSpots.length + ' spot' + (wsprSpots.length !== 1 ? 's' : '') +
      ' · ' + Object.keys(calls).length + ' call' + (Object.keys(calls).length !== 1 ? 's' : '');
    wsprRenderStats();
    setTimeout(function() { wsprSpots.forEach(function(s) { s._new = false; }); }, 1300);
  }

  // The data that makes WSPR sing: coverage counts, best DX, miles-per-watt,
  // and how many stations are hearing YOU. Uses the shared WsprStats module.
  function wsprRenderStats() {
    if (!wsprStatsEl) return;
    var st = window.WsprStats ? window.WsprStats.computeWsprStats(wsprSpots) : null;
    var heardCalls = {};
    wsprHeard.forEach(function(r) { if (r.rxCall) heardCalls[r.rxCall] = 1; });
    var heardN = Object.keys(heardCalls).length;
    if ((!st || st.spots === 0) && !heardN) {
      wsprStatsEl.innerHTML = '<span class="jp-wspr-stat-dim">Listening… spots and your footprint appear each 2-minute cycle.</span>';
      return;
    }
    var p = [];
    if (st && st.spots) {
      p.push('<span class="s-k">RX</span> <span class="s-v">' + st.spots + '</span>');
      p.push('<span class="s-v">' + st.uniqueCalls + '</span> <span class="s-k">calls</span>');
      if (st.uniqueEntities) p.push('<span class="s-v">' + st.uniqueEntities + '</span> <span class="s-k">DXCC</span>');
      if (st.uniqueContinents) p.push('<span class="s-v">' + st.uniqueContinents + '</span> <span class="s-k">cont</span>');
      if (st.bestDx) p.push('<span class="s-k">DX</span> <span class="s-dx">' + wsprEsc(st.bestDx.call) + ' ' + wsprFmtDist(st.bestDx.distanceMi) + '</span>');
      if (st.bestMpw && window.WsprStats) p.push('<span class="s-mpw">' + window.WsprStats.formatMpw(st.bestMpw.milesPerWatt) + '</span>');
    }
    if (heardN) {
      var farHeard = wsprHeard.reduce(function(m, r) { return Math.max(m, r.distanceMi || 0); }, 0);
      p.push('<span class="s-k">heard by</span> <span class="s-heard">' + heardN + '</span>' +
        (farHeard ? ' <span class="s-k">to</span> <span class="s-heard">' + wsprFmtDist(farHeard) + '</span>' : ''));
    }
    wsprStatsEl.innerHTML = p.join('&nbsp;&nbsp; ');
  }

  // "Where am I heard" — render the beacon footprint: a dashed line from home to
  // every receiver that decoded us, SNR-colored, with white-ringed markers so
  // it reads distinctly from the RX-spot layer (who I hear).
  function wsprRenderHeard(payload) {
    wsprHeard = (payload && payload.reports) || [];
    wsprHeardLayer.clearLayers();
    if (map) {
      if (wsprShowHeard.checked && modeSelect.value === 'WSPR' && !map.hasLayer(wsprHeardLayer)) wsprHeardLayer.addTo(map);
      var home = myGrid ? gridToLatLon(myGrid) : null;
      wsprHeard.forEach(function(r) {
        var lat = r.lat, lon = r.lon;
        if ((lat == null || lon == null) && r.rxGrid) { var ll = gridToLatLon(r.rxGrid); if (ll) { lat = ll.lat; lon = ll.lon; } }
        if (lat == null || lon == null) return;
        var color = wsprSnrColor(r.snr);
        if (home) wsprHeardLayer.addLayer(L.polyline([[home.lat, home.lon], [lat, lon]], { color: color, weight: 1, opacity: 0.55, dashArray: '4 3' }));
        var m = L.circleMarker([lat, lon], { radius: 4, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9 });
        m.bindPopup(wsprQrzCallHtml(r.rxCall) + ' heard you' +
          '<br>' + (r.snr != null ? r.snr + ' dB' : '') +
          (r.distanceMi != null ? ' · ' + wsprFmtDist(r.distanceMi) : '') +
          (r.bearing != null ? ' · ' + r.bearing + '°' : ''), { className: 'jp-station-popup' });
        wsprWireQrz(m);
        wsprHeardLayer.addLayer(m);
      });
    }
    wsprRenderStats();
  }

  // A QRZ-clickable callsign for map popups. CSP-safe: rendered as a link and
  // wired on popupopen to open qrz.com in the external browser.
  function wsprQrzCallHtml(call) {
    return '<a href="#" class="wspr-qrz" data-call="' + wsprEsc(call || '') + '" ' +
      'style="color:#4fc3f7;font-weight:700;text-decoration:underline;cursor:pointer;">' + wsprEsc(call || '') + '</a>';
  }
  function wsprWireQrz(marker) {
    marker.on('popupopen', function() {
      var el = marker.getPopup().getElement();
      if (!el) return;
      var a = el.querySelector('.wspr-qrz');
      if (!a) return;
      a.addEventListener('click', function(ev) {
        ev.preventDefault();
        var c = a.dataset.call;
        if (c && window.api.openExternal) window.api.openExternal('https://www.qrz.com/db/' + encodeURIComponent(c));
      });
    });
  }

  function wsprAddMarker(s) {
    if (!map || !s.grid) return;
    var ll = gridToLatLon(s.grid);
    if (!ll) return;
    if (!map.hasLayer(wsprMarkerLayer)) wsprMarkerLayer.addTo(map);
    var color = wsprSnrColor(s.snr);
    var m = L.circleMarker([ll.lat, ll.lon], { radius: 5, color: color, weight: 1, fillColor: color, fillOpacity: 0.7 });
    m.bindPopup(wsprQrzCallHtml(s.call) + ' ' + wsprEsc(s.grid || '') +
      '<br>' + (s.snr != null ? s.snr + ' dB' : '') +
      (s.distanceMi != null ? ' · ' + (wsprDistUnit === 'km' ? Math.round(s.distanceMi * 1.60934) + ' km' : s.distanceMi + ' mi') : '') +
      (s.entity ? '<br>' + wsprEsc(s.entity) : ''), { className: 'jp-station-popup' });
    wsprWireQrz(m);
    wsprMarkerLayer.addLayer(m);
    if (myGrid) {
      var home = gridToLatLon(myGrid);
      if (home) wsprMarkerLayer.addLayer(L.polyline([[home.lat, home.lon], [ll.lat, ll.lon]], { color: color, weight: 1, opacity: 0.22 }));
    }
  }

  if (window.api.onJtcatWsprSpots) {
    window.api.onJtcatWsprSpots(function(payload) { wsprAddSpots(payload); });
  }
  if (window.api.onJtcatWsprHeard) {
    window.api.onJtcatWsprHeard(function(payload) { wsprRenderHeard(payload); });
  }
  // Band hop QSY'd the radio — reflect the new active band in the toolbar + chip.
  if (window.api.onJtcatWsprHopBand) {
    window.api.onJtcatWsprHopBand(function(d) {
      if (!d || !d.band) return;
      document.querySelectorAll('.jtcat-band-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.band === d.band);
      });
      if (wsprHopBandsEl) {
        var chips = wsprHopBandsEl.querySelectorAll('.jp-wspr-chip');
        for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('hopping', chips[i].dataset.band === d.band);
      }
    });
  }
  // Main process confirms/reverts the beacon toggle (e.g. if arming failed
  // because the operator's call/grid isn't set, or we're not in WSPR mode).
  if (window.api.onJtcatWsprBeaconState) {
    window.api.onJtcatWsprBeaconState(function(st) {
      if (wsprTxEnable) wsprTxEnable.checked = !!(st && st.enabled);
    });
  }
  // ================== end WSPR ==================

  // Auto-restore last band, tune, and start decoding
  window.api.getSettings().then(function(s) {
    // Restore the last mode FIRST so the band buttons carry the correct
    // (FT4/FT2) sub-band frequencies before we match/select a band below.
    if (s.jtcatLastMode === 'FT4' || s.jtcatLastMode === 'FT2' || s.jtcatLastMode === 'WSPR') {
      modeSelect.value = s.jtcatLastMode;
      updateBandFreqs();
    }
    wsprInit(s);
    applyWsprMode(modeSelect.value === 'WSPR');
    var lastFreq = s.jtcatLastBandFreq || 14074;
    var bandBtn = document.querySelector('.jtcat-band-btn[data-freq="' + lastFreq + '"]');
    // If no exact match, find the band button closest to the requested frequency
    if (!bandBtn) {
      var bestBtn = null, bestDist = Infinity;
      document.querySelectorAll('.jtcat-band-btn').forEach(function(btn) {
        var d = Math.abs(parseInt(btn.dataset.freq, 10) - lastFreq);
        if (d < bestDist) { bestDist = d; bestBtn = btn; }
      });
      bandBtn = bestBtn;
    }
    if (!bandBtn) bandBtn = document.querySelector('.jtcat-band-btn[data-band="20m"]');
    if (bandBtn) selectBand(bandBtn, false);
    window.api.jtcatStart(modeSelect.value);
    // Start audio capture directly in the popout window
    startPopoutAudio(s.remoteAudioInput || '', s.audioSource);
  });

  // Silence watchdog: engine detected 3+ cycles of zeros — restart audio capture
  if (window.api.onRestartPopoutAudio) {
    window.api.onRestartPopoutAudio(async function() {
      console.log('[JTCAT popout] Silence watchdog — restarting audio capture');
      var s = await window.api.getSettings();
      startPopoutAudio(s.remoteAudioInput || '', s.audioSource);
    });
  }

  // --- Audio capture (runs in the popout window, sends samples to main process) ---
  var popoutAudioCtx = null;
  var popoutAudioStream = null;
  var popoutAudioProcessor = null;
  var popoutAnalyser = null;
  var popoutRxGainNode = null;
  var popoutRxGainLevel = 1.0;
  var popoutTxGainLevel = 1.0;
  var popoutWaterfallAnim = null;
  var popoutQuietFreqFrame = 0;
  var popoutSpectrumFrame = 0;

  // --- SmartSDR Direct: synthetic audio stream for the pop-out waterfall ---
  // On "SmartSDR Direct" the pop-out's audio is VITA-49 dax_rx frames
  // forwarded by main, not a Windows DAX device. A single source
  // AudioWorkletNode owns a ring buffer + linear-interp resampler; the
  // frame handler port.postMessages PCM at it. The MediaStreamDestination
  // it feeds is plugged into startPopoutAudio() the same place
  // getUserMedia's stream would go, so the rest of the pipeline (gain,
  // analyser, waterfall, worklet) is unchanged. K3SBP 2026-06-02 —
  // replaces the per-frame createBuffer+createBufferSource churn that
  // drove the renderer-backpressure log.
  var popoutVita49Ctx = null;
  var popoutVita49Dest = null;
  var popoutVita49Node = null;

  if (window.api.onJtcatVita49Audio) {
    window.api.onJtcatVita49Audio(function (frame) {
      // Return false so the preload acks immediately when this window
      // isn't the live consumer — see preload-jtcat-popout.js.
      if (!popoutVita49Node || !frame || !frame.pcm || !frame.pcm.length) return false;
      if (popoutVita49Ctx && popoutVita49Ctx.state === 'suspended') popoutVita49Ctx.resume().catch(function () {});
      var pcm = (frame.pcm instanceof Float32Array) ? frame.pcm : new Float32Array(frame.pcm);
      popoutVita49Node.port.postMessage(pcm);
      return true;
    });
  }

  // RX Gain slider — persisted in localStorage
  var jpRxGain = document.getElementById('jp-rx-gain');
  var jpRxGainVal = document.getElementById('jp-rx-gain-val');
  var savedRxPct = parseInt(localStorage.getItem('jtcat-rx-gain'), 10);
  if (!isNaN(savedRxPct) && jpRxGain) {
    jpRxGain.value = savedRxPct;
    jpRxGainVal.textContent = savedRxPct + '%';
    popoutRxGainLevel = savedRxPct / 100;
  }
  if (jpRxGain) {
    jpRxGain.addEventListener('input', function() {
      var pct = parseInt(jpRxGain.value, 10);
      jpRxGainVal.textContent = pct + '%';
      popoutRxGainLevel = pct / 100;
      if (popoutRxGainNode) popoutRxGainNode.gain.value = popoutRxGainLevel;
      localStorage.setItem('jtcat-rx-gain', pct);
    });
  }

  // TX Power slider — persisted in localStorage
  var jpTxGain = document.getElementById('jp-tx-gain');
  var jpTxGainVal = document.getElementById('jp-tx-gain-val');
  // TX Pwr: square curve for fine low-end control (same as main window)
  function txPwrToGain(pct) { return (pct / 100) * (pct / 100); }
  var savedTxPct = parseInt(localStorage.getItem('jtcat-tx-gain'), 10);
  if (!isNaN(savedTxPct) && jpTxGain) {
    jpTxGain.value = savedTxPct;
    jpTxGainVal.textContent = savedTxPct + '%';
    popoutTxGainLevel = txPwrToGain(savedTxPct);
  }
  if (jpTxGain) {
    jpTxGain.addEventListener('input', function() {
      var pct = parseInt(jpTxGain.value, 10);
      jpTxGainVal.textContent = pct + '%';
      popoutTxGainLevel = txPwrToGain(pct);
      window.api.jtcatSetTxGain(popoutTxGainLevel);
      localStorage.setItem('jtcat-tx-gain', pct);
    });
  }

  function stopPopoutAudio() {
    if (popoutAudioProcessor) { popoutAudioProcessor.disconnect(); popoutAudioProcessor = null; }
    popoutAnalyser = null;
    popoutRxGainNode = null;
    if (popoutAudioCtx) { popoutAudioCtx.close().catch(function() {}); popoutAudioCtx = null; }
    if (popoutAudioStream) { popoutAudioStream.getTracks().forEach(function(t) { t.stop(); }); popoutAudioStream = null; }
    // SmartSDR Direct synthetic-stream context — the frame handler no-ops
    // once popoutVita49Node is null, cleanly stopping the synthetic feed.
    if (popoutVita49Node) {
      try { popoutVita49Node.disconnect(); } catch (e) { /* already gone */ }
      popoutVita49Node = null;
    }
    if (popoutVita49Ctx) { popoutVita49Ctx.close().catch(function() {}); popoutVita49Ctx = null; }
    popoutVita49Dest = null;
  }

  async function startPopoutAudio(deviceId, audioSource) {
    // Clean up any stale audio state (e.g. after ECHOCAT used the same device)
    stopPopoutAudio();
    await new Promise(function(r) { setTimeout(r, 300); });
    try {
      if (audioSource === 'smartsdr') {
        // SmartSDR Direct: audio is the VITA-49 dax_rx stream that main
        // forwards as 'jtcat-vita49-audio' frames. A single AudioWorkletNode
        // owns the ring buffer + linear-interp resampler and feeds a
        // MediaStreamDestination; downstream is identical to the
        // getUserMedia path. K3SBP 2026-06-02 — eliminates per-frame
        // BufferSource churn.
        popoutVita49Ctx = new AudioContext();
        if (popoutVita49Ctx.state === 'suspended') {
          try { await popoutVita49Ctx.resume(); } catch (e) { /* logged below if it bites */ }
        }
        try {
          await popoutVita49Ctx.audioWorklet.addModule('jtcat-vita49-source-worklet.js');
        } catch (e) {
          console.error('[JTCAT popout] failed to load VITA-49 source worklet:', e);
          throw e;
        }
        popoutVita49Node = new AudioWorkletNode(popoutVita49Ctx, 'jtcat-vita49-source', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { sourceRate: 24000 },
        });
        popoutVita49Dest = popoutVita49Ctx.createMediaStreamDestination();
        popoutVita49Node.connect(popoutVita49Dest);
        popoutAudioStream = popoutVita49Dest.stream;
        console.log('[JTCAT popout] Audio source: SmartSDR Direct (VITA-49 dax_rx via AudioWorklet)');
      } else {
        var constraints = {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        };
        if (deviceId) constraints.deviceId = { exact: deviceId };
        try {
          popoutAudioStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        } catch (e) {
          console.warn('[JTCAT popout] Configured input failed, using default:', e.message);
          delete constraints.deviceId;
          popoutAudioStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        }
      }
      popoutAudioCtx = new AudioContext();
      if (popoutAudioCtx.state === 'suspended') await popoutAudioCtx.resume();
      var nativeRate = popoutAudioCtx.sampleRate;
      var dsRatio = nativeRate / 12000;
      var source = popoutAudioCtx.createMediaStreamSource(popoutAudioStream);

      // AnalyserNode for waterfall FFT (driven locally, no IPC needed)
      // RX gain node
      popoutRxGainNode = popoutAudioCtx.createGain();
      popoutRxGainNode.gain.value = popoutRxGainLevel;
      source.connect(popoutRxGainNode);

      popoutAnalyser = popoutAudioCtx.createAnalyser();
      popoutAnalyser.fftSize = 2048;
      popoutAnalyser.smoothingTimeConstant = 0.3;
      popoutRxGainNode.connect(popoutAnalyser);

      console.log('[JTCAT popout] AudioContext sample rate:', nativeRate, 'dsRatio:', dsRatio.toFixed(2));

      // Try AudioWorklet first (proper anti-alias FIR filter), fall back to ScriptProcessorNode
      try {
        await popoutAudioCtx.audioWorklet.addModule('jtcat-audio-worklet.js');
        var workletNode = new AudioWorkletNode(popoutAudioCtx, 'jtcat-processor', {
          processorOptions: { dsRatio: dsRatio },
        });
        workletNode.port.onmessage = function(e) {
          window.api.jtcatAudio(e.data);
        };
        popoutRxGainNode.connect(workletNode);
        workletNode.connect(popoutAudioCtx.destination);
        popoutAudioProcessor = workletNode;
        console.log('[JTCAT popout] Using AudioWorkletNode for audio capture');
      } catch (workletErr) {
        console.warn('[JTCAT popout] AudioWorklet failed:', workletErr.message, '— falling back to ScriptProcessorNode');
        var bufSize = dsRatio > 1 ? 4096 * Math.ceil(dsRatio) : 4096;
        bufSize = Math.pow(2, Math.ceil(Math.log2(bufSize)));
        if (bufSize > 16384) bufSize = 16384;
        popoutAudioProcessor = popoutAudioCtx.createScriptProcessor(bufSize, 1, 1);
        // Build anti-alias FIR filter for proper downsampling
        var firCoeffs = null, firHistory = null, firIdx = 0, decCounter = 0;
        if (dsRatio > 1.01) {
          var cutoff = 0.45 / dsRatio;
          var taps = Math.max(31, Math.round(dsRatio * 16) | 1);
          firCoeffs = new Float32Array(taps);
          firHistory = new Float32Array(taps);
          var mid = (taps - 1) / 2, fsum = 0;
          for (var t = 0; t < taps; t++) {
            var n = t - mid;
            var h = Math.abs(n) < 1e-6 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
            var w = 0.42 - 0.5 * Math.cos(2 * Math.PI * t / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * t / (taps - 1));
            firCoeffs[t] = h * w; fsum += firCoeffs[t];
          }
          for (var t = 0; t < taps; t++) firCoeffs[t] /= fsum;
        }
        popoutAudioProcessor.onaudioprocess = function(e) {
          try {
            var rawSamples = e.inputBuffer.getChannelData(0);
            var samples;
            if (dsRatio > 1.01) {
              var out = [];
              var ratio = Math.round(dsRatio);
              for (var i = 0; i < rawSamples.length; i++) {
                firHistory[firIdx] = rawSamples[i];
                firIdx = (firIdx + 1) % firCoeffs.length;
                decCounter++;
                if (decCounter >= ratio) {
                  decCounter = 0;
                  var sum = 0, idx = firIdx;
                  for (var t = 0; t < firCoeffs.length; t++) {
                    sum += firHistory[idx] * firCoeffs[t];
                    idx = (idx + 1) % firCoeffs.length;
                  }
                  out.push(sum);
                }
              }
              samples = out;
            } else {
              samples = Array.from(rawSamples);
            }
            window.api.jtcatAudio(samples);
          } catch (err) {
            console.error('[JTCAT popout] Audio processor error:', err.message || err);
          }
        };
        popoutRxGainNode.connect(popoutAudioProcessor);
        popoutAudioProcessor.connect(popoutAudioCtx.destination);
      }
      console.log('[JTCAT popout] Audio capture started, sample rate:', nativeRate);
      // Start local waterfall rendering loop
      popoutWaterfallLoop();
    } catch (err) {
      console.error('[JTCAT popout] Audio capture failed:', err.message);
    }
  }

  // --- Map toggle & popout ---
  var mapPane = document.querySelector('.jp-map-pane');
  var mapToggleBtn = document.getElementById('jp-map-toggle');
  var mapPopoutBtn = document.getElementById('jp-map-popout');
  var mapVisible = true;

  mapToggleBtn.addEventListener('click', function() {
    mapVisible = !mapVisible;
    mapPane.classList.toggle('hidden', !mapVisible);
    mapToggleBtn.classList.toggle('active', mapVisible);
    if (mapVisible && map) setTimeout(function() { map.invalidateSize(); }, 100);
  });

  mapPopoutBtn.addEventListener('click', function() {
    window.api.jtcatMapPopout();
  });

  // --- Waterfall ---
  var jpWaterfall = document.getElementById('jp-waterfall');
  var jpWfCtx = jpWaterfall.getContext('2d');

  function resizeWaterfall() {
    var rect = jpWaterfall.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var newW = Math.round(rect.width * dpr);
    var newH = Math.round(rect.height * dpr);
    if (newW > 0 && newH > 0 && (jpWaterfall.width !== newW || jpWaterfall.height !== newH)) {
      // Save existing content before resize (setting width/height clears canvas)
      var oldData = null;
      try { oldData = jpWfCtx.getImageData(0, 0, jpWaterfall.width, jpWaterfall.height); } catch(e) {}
      jpWaterfall.width = newW;
      jpWaterfall.height = newH;
      if (oldData) {
        jpWfCtx.putImageData(oldData, 0, 0);
      }
    }
  }
  resizeWaterfall();
  window.addEventListener('resize', resizeWaterfall);

  // Waterfall rendering loop — driven by local AnalyserNode (no IPC)
  function popoutWaterfallLoop() {
    if (!popoutAnalyser) return;
    try {
      var freqData = new Uint8Array(popoutAnalyser.frequencyBinCount);
      popoutAnalyser.getByteFrequencyData(freqData);

      // AnalyserNode covers 0 to sampleRate/2. FT8 passband is 0–3000 Hz.
      var nyquist = (popoutAudioCtx ? popoutAudioCtx.sampleRate : 12000) / 2;
      var passbandBins = Math.floor(3000 / nyquist * freqData.length);

      var w = jpWaterfall.width;
      var h = jpWaterfall.height;

      // Scroll existing image down by 1 pixel
      var imgData = jpWfCtx.getImageData(0, 0, w, h - 1);
      jpWfCtx.putImageData(imgData, 0, 1);

      // Draw new line at top row
      var lineData = jpWfCtx.createImageData(w, 1);
      for (var x = 0; x < w; x++) {
        var binIdx = Math.floor(x * passbandBins / w);
        var val = freqData[binIdx];
        var norm = val / 255;
        var r, g, b;
        if (norm < 0.2) { r = 0; g = 0; b = Math.floor(norm * 5 * 140); }
        else if (norm < 0.4) { var t = (norm - 0.2) * 5; r = 0; g = Math.floor(t * 255); b = 140 + Math.floor(t * 115); }
        else if (norm < 0.6) { var t = (norm - 0.4) * 5; r = Math.floor(t * 255); g = 255; b = Math.floor((1 - t) * 255); }
        else if (norm < 0.8) { var t = (norm - 0.6) * 5; r = 255; g = Math.floor((1 - t) * 255); b = 0; }
        else { var t = (norm - 0.8) * 5; r = 255; g = Math.floor(t * 255); b = Math.floor(t * 255); }
        var i = x * 4;
        lineData.data[i] = r; lineData.data[i + 1] = g; lineData.data[i + 2] = b; lineData.data[i + 3] = 255;
      }
      jpWfCtx.putImageData(lineData, 0, 0);

      // RX marker (green) — pulses when receiving
      var rxX = Math.round(jpRxFreqHz / 3000 * w);
      var txX = Math.round(jpTxFreqHz / 3000 * w);
      var pulse = (Math.sin(Date.now() / 200) + 1) / 2; // 0-1 oscillation
      var rxGlow = !transmitting ? 2 + pulse * 4 : 0;
      var txGlow = transmitting ? 2 + pulse * 4 : 0;
      // RX line
      if (rxGlow > 0) {
        jpWfCtx.shadowColor = '#4ecca3';
        jpWfCtx.shadowBlur = rxGlow;
      }
      jpWfCtx.fillStyle = '#000';
      jpWfCtx.fillRect(rxX - 3, 0, 7, h);
      jpWfCtx.fillStyle = '#4ecca3';
      jpWfCtx.fillRect(rxX - 2, 0, 5, h);
      jpWfCtx.shadowBlur = 0;
      // TX marker (red) — pulses when transmitting
      if (txGlow > 0) {
        jpWfCtx.shadowColor = '#ff2222';
        jpWfCtx.shadowBlur = txGlow;
      }
      jpWfCtx.fillStyle = '#000';
      jpWfCtx.fillRect(txX - 2, 0, 5, h);
      jpWfCtx.fillStyle = '#ff2222';
      jpWfCtx.fillRect(txX - 1, 0, 3, h);
      jpWfCtx.shadowBlur = 0;

      // Auto-detect quietest TX frequency (~every 0.5s)
      popoutQuietFreqFrame++;
      if (popoutQuietFreqFrame % 30 === 0) {
        var binHz = nyquist / freqData.length;
        var windowBins = Math.round(50 / binHz);
        var startBin = Math.round(200 / binHz);
        var endBin = Math.round(2800 / binHz);
        var bestEnergy = Infinity;
        var bestBin = Math.round(1500 / binHz);
        for (var b = startBin; b <= endBin - windowBins; b++) {
          var energy = 0;
          for (var j = 0; j < windowBins; j++) energy += freqData[b + j];
          if (energy < bestEnergy) {
            bestEnergy = energy;
            bestBin = b + Math.floor(windowBins / 2);
          }
        }
        var quietHz = Math.round(bestBin * binHz / 10) * 10;
        window.api.jtcatQuietFreq(Math.max(200, Math.min(2800, quietHz)));
      }

      // Send spectrum to main process for remote/ECHOCAT (~10fps)
      popoutSpectrumFrame++;
      if (popoutSpectrumFrame % 6 === 0) {
        var specBins = new Array(w);
        for (var sx = 0; sx < w; sx++) {
          specBins[sx] = freqData[Math.floor(sx * passbandBins / w)];
        }
        window.api.jtcatSpectrum(specBins);
      }
    } catch (err) {
      console.error('[JTCAT popout] Waterfall error:', err.message || err);
    }
    popoutWaterfallAnim = requestAnimationFrame(popoutWaterfallLoop);
  }

  // TX marker is now drawn on the canvas by popoutWaterfallLoop — hide CSS overlay
  var txMarkerEl = document.getElementById('jp-wf-tx-marker');
  if (txMarkerEl) txMarkerEl.style.display = 'none';

  // Click TX freq label to manually enter frequency
  txFreqLabel.addEventListener('click', function() {
    var input = document.createElement('input');
    input.type = 'number'; input.min = '100'; input.max = '3000'; input.step = '10';
    input.value = jpTxFreqHz;
    input.style.cssText = 'width:60px;font-size:12px;font-weight:bold;color:#ff4444;background:var(--bg-primary);border:1px solid #ff4444;border-radius:3px;padding:1px 4px;font-family:monospace;';
    txFreqLabel.textContent = 'TX: ';
    txFreqLabel.appendChild(input);
    input.focus(); input.select();
    function apply() {
      var hz = Math.round(parseInt(input.value, 10) / 10) * 10;
      if (hz >= 100 && hz <= 3000) {
        jpTxFreqHz = hz;
        window.api.jtcatSetTxFreq(hz);
        window.api.jtcatSetRxFreq(hz);
      }
      txFreqLabel.textContent = 'TX: ' + jpTxFreqHz + ' Hz';
    }
    input.addEventListener('blur', apply);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { txFreqLabel.textContent = 'TX: ' + jpTxFreqHz + ' Hz'; } });
  });

  jpWaterfall.addEventListener('click', function(e) {
    var rect = jpWaterfall.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var hz = Math.round(x / rect.width * 3000 / 10) * 10;
    if (e.shiftKey) {
      // Shift+click: set TX only (split TX/RX)
      jpTxFreqHz = hz;
      txFreqLabel.textContent = 'TX: ' + hz + ' Hz';
      window.api.jtcatSetTxFreq(hz);
    } else {
      // Normal click: set both RX and TX
      jpTxFreqHz = hz;
      jpRxFreqHz = hz;
      txFreqLabel.textContent = 'TX: ' + hz + ' Hz';
      window.api.jtcatSetTxFreq(hz);
      window.api.jtcatSetRxFreq(hz);
    }
  });

  // --- Zoom (Ctrl+/Ctrl-) ---
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      var z = window.api.getZoom();
      window.api.setZoom(Math.min(z + 0.1, 2.0));
    } else if (e.ctrlKey && e.key === '-') {
      e.preventDefault();
      var z = window.api.getZoom();
      window.api.setZoom(Math.max(z - 0.1, 0.5));
    } else if (e.ctrlKey && e.key === '0') {
      e.preventDefault();
      window.api.setZoom(1.0);
    }
  });

  // --- VFO Lock: tune-blocked toast ---
  window.api.onTuneBlocked((msg) => {
    let t = document.getElementById('tune-blocked-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'tune-blocked-toast';
      t.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#e94560;color:#fff;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:bold;z-index:9999;pointer-events:none;box-shadow:0 4px 20px rgba(233,69,96,0.5);opacity:0;transition:opacity 0.2s';
      document.body.appendChild(t);
    }
    t.textContent = msg || 'VFO Locked — Unlock VFO to change frequency';
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2000);
  });

  // --- Init map ---
  initMap();
})();
