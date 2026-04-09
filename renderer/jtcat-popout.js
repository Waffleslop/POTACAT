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
    document.documentElement.setAttribute('data-theme', theme);
  });

  // --- State ---
  var decodeLog = [];
  var cqFilter = false;
  var wantedFilter = false;
  var sortBySignal = false;
  var searchFilter = '';
  var txEnabled = false;
  var transmitting = false;
  var jpTxFreqHz = 1500;
  var jpRxFreqHz = 1500;
  var myCallsign = '';
  var myGrid = '';
  var stations = {};   // callsign → {marker, grid, lat, lon, lastSeen}
  var qsoArcs = {};    // "A↔B" → {arc, from, to, lastSeen}
  var ARC_SEGMENTS = 32;
  var qrzCache = {};   // callsign → {name, fetched}

  // Load settings
  window.api.getSettings().then(function(s) {
    myCallsign = (s.myCallsign || '').toUpperCase();
    myGrid = (s.grid || '').toUpperCase().substring(0, 4);
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
  var cqFilterBtn = document.getElementById('jp-cq-filter');
  var wantedFilterBtn = document.getElementById('jp-wanted-filter');
  var cqBtn = document.getElementById('jp-cq');
  var enableTxBtn = document.getElementById('jp-enable-tx');
  var haltTxBtn = document.getElementById('jp-halt-tx');
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
    markerLayer.addTo(map);
    arcLayer.addTo(map);
    updateMapHome();
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
    // underlying point order might not match the current from→to direction.
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
      var idx = 1;
      if (parts.length > 3 && parts[1].length <= 4 && !/[0-9]/.test(parts[1])) idx = 2;
      var call = parts[idx] || '', grid = parts[idx + 1] || '';
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

  function clearOld() {
    var now = Date.now();
    Object.keys(qsoArcs).forEach(function(key) {
      if (qsoArcs[key].lastSeen < now - 45000) { arcLayer.removeLayer(qsoArcs[key].arc); delete qsoArcs[key]; }
    });
    Object.keys(stations).forEach(function(call) {
      if (call === myCallsign) return; // never expire our own station
      if (stations[call].lastSeen < now - 180000) { markerLayer.removeLayer(stations[call].marker); delete stations[call]; }
    });
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

  function onDecodeRowClick(d) {
    var text = (d.text || '').toUpperCase();
    var parts = text.split(/\s+/);
    if (text.startsWith('CQ ')) {
      var callIdx = 1;
      if (parts.length > 3 && parts[1].length <= 4 && !/[0-9]/.test(parts[1])) callIdx = 2;
      var call = parts[callIdx] || '';
      var grid = parts[callIdx + 1] || '';
      if (call) {
        jpTxFreqHz = d.df || 1500;
        jpRxFreqHz = d.df || 1500;
        txFreqLabel.textContent = 'TX: ' + jpTxFreqHz + ' Hz';

        console.log('[JTCAT popout] Reply to CQ:', call, grid, 'df:', d.df, 'slot:', d.slot);
        // Add the CQ message to My Activity as the start of the QSO thread
        addToMyActivity(d);
        window.api.jtcatReply({ call: call, grid: grid, df: d.df || 1500, slot: d.slot, sliceId: d.sliceId });
      }
    } else if (parts.length >= 2) {
      var toCall = parts[0], fromCall = parts[1], payload = (parts[2] || '');
      // If this message is directed at me (toCall === myCallsign), pick up the QSO
      if (toCall === myCallsign && fromCall) {
        var grid = /^[A-R]{2}[0-9]{2}$/i.test(payload) ? payload : '';
        var rptMatch = payload.match(/^R?([+-]\d{2})$/);
        var hasRR73 = payload === 'RR73' || payload === 'RRR' || payload === '73';
        jpTxFreqHz = d.df || 1500;
        txFreqLabel.textContent = 'TX: ' + jpTxFreqHz + ' Hz';

        console.log('[JTCAT popout] Pick up QSO with', fromCall, 'payload:', payload, 'df:', d.df);
        window.api.jtcatReply({
          call: fromCall, grid: grid, df: d.df || 1500, slot: d.slot,
          report: rptMatch ? rptMatch[1] : undefined,
          rr73: hasRR73 || undefined,
          snr: d.db,
        });
      } else {
        // Not directed at us — just set TX freq
        jpTxFreqHz = d.df || 1500;
        txFreqLabel.textContent = 'TX: ' + jpTxFreqHz + ' Hz';
        window.api.jtcatSetTxFreq(jpTxFreqHz);

      }
    }
  }

  // --- Decode rendering ---
  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // Add a single decode to My Activity pane (e.g. the CQ we clicked to start a QSO)
  function addToMyActivity(d) {
    var mEmpty = myActivity.querySelector('.jp-empty');
    if (mEmpty) mEmpty.remove();
    var now = new Date();
    var time = String(now.getUTCHours()).padStart(2, '0') + ':' + String(now.getUTCMinutes()).padStart(2, '0') + ':' + String(now.getUTCSeconds()).padStart(2, '0');
    var sep = document.createElement('div');
    sep.className = 'jp-cycle-sep';
    sep.textContent = time + ' UTC';
    myActivity.appendChild(sep);
    var text = d.text || '';
    var dtStr = d.dt != null ? (d.dt >= 0 ? '+' : '') + d.dt.toFixed(1) : '';
    var row = document.createElement('div');
    row.className = 'jp-row jp-cq';
    row.innerHTML =
      '<span class="jp-db">' + (d.db >= 0 ? '+' : '') + d.db + '</span>' +
      '<span class="jp-dt">' + dtStr + '</span>' +
      '<span class="jp-df">' + d.df + '</span>' +
      '<span class="jp-msg">' + esc(text) + '</span>';
    row.addEventListener('dblclick', (function(decode) { return function() { onDecodeRowClick(decode); }; })(d));
    myActivity.appendChild(row);
    myActivity.scrollTop = myActivity.scrollHeight;
  }

  function renderDecodes(data) {
    var results = data.results || [];
    var decodeSlot = data.slot || null; // slot the decoded audio was from
    var time = '';
    if (results.length > 0) {
      var now = new Date();
      time = String(now.getUTCHours()).padStart(2, '0') + ':' + String(now.getUTCMinutes()).padStart(2, '0') + ':' + String(now.getUTCSeconds()).padStart(2, '0');
      decodeLog.push({ time: time, results: results });
      if (decodeLog.length > 50) decodeLog.shift();
    }

    // Remove placeholder
    var empty = bandActivity.querySelector('.jp-empty');
    if (empty) empty.remove();

    if (!time) return;
    var sep = document.createElement('div');
    sep.className = 'jp-cycle-sep';
    sep.textContent = time + ' UTC';
    bandActivity.appendChild(sep);

    var myActivityHasSep = false; // only add separator to My Activity if there's a directed decode

    // Sort by signal strength if enabled (strongest first)
    if (sortBySignal) {
      results = results.slice().sort(function(a, b) { return (b.db || 0) - (a.db || 0); });
    }

    results.forEach(function(d) {
      d.slot = decodeSlot; // attach slot so click handler knows which slot this station was on
      var text = d.text || '';
      var upper = text.toUpperCase();
      var isCq = upper.startsWith('CQ ');
      var isDirected = myCallsign && (upper.indexOf(' ' + myCallsign + ' ') >= 0 || upper.startsWith(myCallsign + ' ') || upper.endsWith(' ' + myCallsign));
      var is73 = upper.indexOf('RR73') >= 0 || upper.indexOf(' 73') >= 0;
      var isWanted = d.newDxcc || d.newCall || d.newGrid;

      if (cqFilter && !isCq && !is73 && !isDirected) return;
      if (wantedFilter && !isWanted && !isDirected && !is73) return;
      if (searchFilter && upper.indexOf(searchFilter) === -1) return;

      // Build needed badges + entity
      var badges = '';
      if (d.newDxcc) badges += '<span class="jp-badge jp-badge-dxcc" title="New DXCC: ' + esc(d.entity || '') + '">D</span>';
      if (d.newGrid) badges += '<span class="jp-badge jp-badge-grid" title="New grid: ' + esc(d.grid || '') + '">G</span>';
      if (d.newCall) badges += '<span class="jp-badge jp-badge-call" title="New call: ' + esc(d.call || '') + '">C</span>';
      if (d.watched) badges += '<span class="jp-badge jp-badge-watch" title="Watchlist">W</span>';
      var entityStr = d.entity ? '<span class="jp-entity">' + esc(d.entity) + '</span>' : '';

      var row = document.createElement('div');
      row.className = 'jp-row' + (isCq ? ' jp-cq' : '') + (isDirected ? ' jp-directed' : '') + (isWanted ? ' jp-wanted' : '') + (d.watched ? ' jp-watched' : '');
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
        '<span class="jp-msg">' + esc(text) + '</span>' +
        (badges ? '<span class="jp-badges">' + badges + '</span>' : '') +
        entityStr;
      row.addEventListener('dblclick', (function(decode) { return function() { onDecodeRowClick(decode); }; })(d));
      bandActivity.appendChild(row);

      // Also add directed decodes to My Activity
      if (isDirected) {
        if (!myActivityHasSep) {
          var mEmpty = myActivity.querySelector('.jp-empty');
          if (mEmpty) mEmpty.remove();
          var mSep = document.createElement('div');
          mSep.className = 'jp-cycle-sep';
          mSep.textContent = time + ' UTC';
          myActivity.appendChild(mSep);
          myActivityHasSep = true;
        }
        var myRow = document.createElement('div');
        myRow.className = 'jp-row jp-directed';
        myRow.innerHTML = row.innerHTML;
        myRow.addEventListener('dblclick', (function(decode) { return function() { onDecodeRowClick(decode); }; })(d));
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
    renderDecodes(data);
    syncEl.textContent = 'Sync: OK';
    syncEl.classList.add('jtcat-synced');
  });

  window.api.onJtcatCycle(function(data) {
    if (data.mode === 'FT2') {
      cycleEl.textContent = 'FT2';
      cycleEl.className = 'jtcat-cycle';
    } else {
      cycleEl.textContent = data.slot === 'even' ? 'E' : data.slot === 'odd' ? 'O' : '--';
      cycleEl.className = 'jtcat-cycle' + (data.slot === 'even' ? ' jtcat-slot-even' : data.slot === 'odd' ? ' jtcat-slot-odd' : '');
    }
  });

  window.api.onJtcatStatus(function(data) {
    syncEl.textContent = 'Sync: ' + (data.sync || '--');
  });

  // PTT mode indicator (CAT vs VOX)
  var pttModeEl = document.getElementById('jp-ptt-mode');
  if (window.api.onCatStatus) {
    window.api.onCatStatus(function(s) {
      if (!pttModeEl) return;
      if (s.connected || s.wsjtxMode) {
        pttModeEl.textContent = 'PTT: CAT';
        pttModeEl.style.background = '#333';
        pttModeEl.style.color = '#aaa';
        pttModeEl.title = 'PTT via CAT command';
      } else {
        pttModeEl.textContent = 'PTT: VOX';
        pttModeEl.style.background = '#f0a500';
        pttModeEl.style.color = '#000';
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
      // Add TX row
      var now = new Date();
      var time = String(now.getUTCHours()).padStart(2, '0') + ':' + String(now.getUTCMinutes()).padStart(2, '0') + ':' + String(now.getUTCSeconds()).padStart(2, '0');
      var row = document.createElement('div');
      row.className = 'jp-row jp-tx';
      row.innerHTML = '<span class="jp-db">TX</span><span class="jp-df">--</span><span class="jp-msg">' + esc(data.message) + '</span>';
      bandActivity.appendChild(row);
      bandActivity.scrollTop = bandActivity.scrollHeight;
      // Also add TX row to My Activity
      var mEmpty = myActivity.querySelector('.jp-empty');
      if (mEmpty) mEmpty.remove();
      var myTxRow = document.createElement('div');
      myTxRow.className = 'jp-row jp-tx';
      myTxRow.innerHTML = '<span class="jp-db">TX</span><span class="jp-df">--</span><span class="jp-msg">' + esc(data.message) + '</span>';
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
      renderQsoTracker();
      return;
    } else {
      qsoState = data;
      // Draw arc to QSO partner — direction based on current phase
      if (qsoState.call && myCallsign) {
        if (qsoState.grid) registerStation(qsoState.call, qsoState.grid);
        // RX phases mean we just heard them → arc goes them→us
        // TX phases mean we're about to send → arc goes us→them
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
    // Focus main POTACAT window — QSO log is there
    window.api.focusMain();
  });

  // --- Countdown timer ---
  setInterval(function() {
    var mode = modeSelect.value;
    var cycleSec = mode === 'FT2' ? 3.8 : mode === 'FT4' ? 7.5 : 15;
    var cycleMs = cycleSec * 1000;
    var msInto = Date.now() % cycleMs;
    var remaining = (cycleMs - msInto) / 1000;
    countdownEl.textContent = (remaining < 10 ? remaining.toFixed(1) : Math.ceil(remaining)) + 's';
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
  function updateBandFreqs() {
    var m = modeSelect.value;
    var table = m === 'FT2' ? FT2_BAND_FREQS : m === 'FT4' ? FT4_BAND_FREQS : FT8_BAND_FREQS;
    document.querySelectorAll('.jtcat-band-btn').forEach(function(btn) {
      var band = btn.dataset.band;
      if (table[band]) btn.dataset.freq = table[band];
    });
  }

  // --- Mode change ---
  modeSelect.addEventListener('change', function() {
    updateBandFreqs();
    window.api.jtcatSetMode(modeSelect.value);
    // Retune to the active band's new frequency for the selected mode
    var activeBtn = document.querySelector('.jtcat-band-btn.active');
    if (activeBtn) selectBand(activeBtn, true);
  });

  // --- Controls ---
  cqFilterBtn.addEventListener('click', function() {
    cqFilter = !cqFilter;
    cqFilterBtn.classList.toggle('active', cqFilter);
  });

  wantedFilterBtn.addEventListener('click', function() {
    wantedFilter = !wantedFilter;
    wantedFilterBtn.classList.toggle('active', wantedFilter);
  });

  var sortSignalBtn = document.getElementById('jp-sort-signal');
  sortSignalBtn.addEventListener('click', function() {
    sortBySignal = !sortBySignal;
    sortSignalBtn.classList.toggle('active', sortBySignal);
  });

  var searchInput = document.getElementById('jp-search');
  searchInput.addEventListener('input', function() {
    searchFilter = searchInput.value.toUpperCase().trim();
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
  var multiAudioStreams = new Map(); // sliceId → { ctx, stream, processor }

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
          // Color: dark blue → cyan → yellow → red
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

  var cqModifierSelect = document.getElementById('jp-cq-modifier');
  cqBtn.addEventListener('click', function() {
    var mod = cqModifierSelect ? cqModifierSelect.value : '';
    window.api.jtcatCallCq(mod);
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

  // Band buttons
  function selectBand(btn, save) {
    var freq = parseFloat(btn.dataset.freq);
    window.api.tune(freq, modeSelect.value);
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

  // Auto-restore last band, tune, and start decoding
  window.api.getSettings().then(function(s) {
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
    startPopoutAudio(s.remoteAudioInput || '');
  });

  // Silence watchdog: engine detected 3+ cycles of zeros — restart audio capture
  if (window.api.onRestartPopoutAudio) {
    window.api.onRestartPopoutAudio(async function() {
      console.log('[JTCAT popout] Silence watchdog — restarting audio capture');
      var s = await window.api.getSettings();
      startPopoutAudio(s.remoteAudioInput || '');
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
  }

  async function startPopoutAudio(deviceId) {
    // Clean up any stale audio state (e.g. after ECHOCAT used the same device)
    stopPopoutAudio();
    await new Promise(function(r) { setTimeout(r, 300); });
    try {
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
