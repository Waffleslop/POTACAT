// JTCAT Pop-out Window — decode log, map, and controls
(function() {
  'use strict';

  // --- Window controls ---
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
  var txEnabled = false;
  var transmitting = false;
  var jpTxFreqHz = 1500;
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
    var sorted = [fromCall, toCall].sort();
    var forward = sorted[0] === fromCall;
    el.classList.remove('jtcat-arc-forward', 'jtcat-arc-reverse');
    el.classList.add(forward ? 'jtcat-arc-forward' : 'jtcat-arc-reverse');
  }

  function plotDecode(d) {
    if (!map) return;
    var text = (d.text || '').toUpperCase();
    var parts = text.split(/\s+/);
    if (text.startsWith('CQ ')) {
      var idx = 1;
      if (parts.length > 3 && parts[1].length <= 3 && !/[0-9]/.test(parts[1])) idx = 2;
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
      if (parts.length > 3 && parts[1].length <= 3 && !/[0-9]/.test(parts[1])) callIdx = 2;
      var call = parts[callIdx] || '';
      var grid = parts[callIdx + 1] || '';
      if (call) {
        console.log('[JTCAT popout] Reply to CQ:', call, grid, 'df:', d.df, 'slot:', d.slot);
        window.api.jtcatReply({ call: call, grid: grid, df: d.df || 1500, slot: d.slot });
      }
    } else if (parts.length >= 2) {
      var toCall = parts[0], fromCall = parts[1], payload = (parts[2] || '');
      // If this message is directed at me (toCall === myCallsign), pick up the QSO
      if (toCall === myCallsign && fromCall) {
        var grid = /^[A-R]{2}[0-9]{2}$/i.test(payload) ? payload : '';
        var rptMatch = payload.match(/^R?([+-]\d{2})$/);
        var hasRR73 = payload === 'RR73' || payload === 'RRR' || payload === '73';
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

    results.forEach(function(d) {
      d.slot = decodeSlot; // attach slot so click handler knows which slot this station was on
      var text = d.text || '';
      var upper = text.toUpperCase();
      var isCq = upper.startsWith('CQ ');
      var isDirected = myCallsign && (upper.indexOf(' ' + myCallsign + ' ') >= 0 || upper.startsWith(myCallsign + ' ') || upper.endsWith(' ' + myCallsign));
      var is73 = upper.indexOf('RR73') >= 0 || upper.indexOf(' 73') >= 0;

      if (cqFilter && !isCq && !is73 && !isDirected) return;

      var row = document.createElement('div');
      row.className = 'jp-row' + (isCq ? ' jp-cq' : '') + (isDirected ? ' jp-directed' : '');
      row.innerHTML =
        '<span class="jp-db">' + (d.db >= 0 ? '+' : '') + d.db + '</span>' +
        '<span class="jp-df">' + d.df + '</span>' +
        '<span class="jp-msg">' + esc(text) + '</span>';
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

  window.api.onJtcatTxStatus(function(data) {
    transmitting = data.state === 'tx';
    rxTxEl.textContent = transmitting ? 'TX' : 'RX';
    rxTxEl.style.color = transmitting ? '#e94560' : '';
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
      // Draw arc to QSO partner as soon as the QSO is active
      if (qsoState.call && myCallsign) {
        if (qsoState.grid) registerStation(qsoState.call, qsoState.grid);
        drawQsoArc(myCallsign, qsoState.call);
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
  var FT8_BAND_FREQS = {
    '160m': 1840, '80m': 3573, '60m': 5357, '40m': 7074, '30m': 10136,
    '20m': 14074, '17m': 18100, '15m': 21074, '12m': 24915, '10m': 28074,
    '6m': 50313,
  };
  function updateBandFreqs() {
    var table = modeSelect.value === 'FT2' ? FT2_BAND_FREQS : FT8_BAND_FREQS;
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

  cqBtn.addEventListener('click', function() {
    window.api.jtcatCallCq();
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

  // Band buttons
  function selectBand(btn, save) {
    var freq = parseInt(btn.dataset.freq, 10);
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
      window.api.getSettings().then(function(s) {
        s.jtcatLastBandFreq = freq;
        window.api.saveSettings(s);
      });
    }
  }

  document.querySelectorAll('.jtcat-band-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { selectBand(btn, true); });
  });

  // Auto-restore last band, tune, and start decoding
  window.api.getSettings().then(function(s) {
    var lastFreq = s.jtcatLastBandFreq || 14074;
    var bandBtn = document.querySelector('.jtcat-band-btn[data-freq="' + lastFreq + '"]');
    if (!bandBtn) bandBtn = document.querySelector('.jtcat-band-btn[data-band="20m"]');
    if (bandBtn) selectBand(bandBtn, false);
    window.api.jtcatStart(modeSelect.value);
  });

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

  window.api.onJtcatSpectrum(function(data) {
    var bins = data.bins;
    if (!bins || !bins.length) return;
    var w = jpWaterfall.width;
    var h = jpWaterfall.height;
    // Scroll existing image down by 1 pixel
    var imgData = jpWfCtx.getImageData(0, 0, w, h - 1);
    jpWfCtx.putImageData(imgData, 0, 1);
    // Draw new row at top
    var lineData = jpWfCtx.createImageData(w, 1);
    var step = bins.length / w;
    for (var x = 0; x < w; x++) {
      var val = bins[Math.floor(x * step)] || 0;
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

    // TX frequency marker (red bar with black border)
    var txX = Math.round(jpTxFreqHz / 3000 * w);
    jpWfCtx.fillStyle = '#000';
    jpWfCtx.fillRect(txX - 2, 0, 5, h);
    jpWfCtx.fillStyle = '#ff2222';
    jpWfCtx.fillRect(txX - 1, 0, 3, h);
  });

  jpWaterfall.addEventListener('click', function(e) {
    var rect = jpWaterfall.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var hz = Math.round(x / rect.width * 3000 / 10) * 10;
    jpTxFreqHz = hz;
    txFreqLabel.textContent = 'TX: ' + hz + ' Hz';
    window.api.jtcatSetTxFreq(hz);
    window.api.jtcatSetRxFreq(hz);
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

  // --- Init map ---
  initMap();
})();
