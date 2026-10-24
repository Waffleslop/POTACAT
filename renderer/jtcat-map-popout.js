
  (function() {
    'use strict';

    // Window controls
    document.getElementById('tb-min').addEventListener('click', function() { window.api.minimize(); });
    document.getElementById('tb-max').addEventListener('click', function() { window.api.maximize(); });
    document.getElementById('tb-close').addEventListener('click', function() { window.api.close(); });

    // Theme: main sends the {theme, variant} payload (the JTCAT window's
    // form) right after this window loads and on every change. Writing that
    // object straight into data-theme gave "[object Object]" — no theme at
    // all, over the correct first paint the bootstrap had made (K3SBP
    // 2026-10-23: the pop-out ignored light mode and the dark variant).
    window.api.onPopoutTheme(function(payload) {
      var theme = typeof payload === 'string' ? payload : ((payload && payload.theme) || 'dark');
      var variant = (payload && typeof payload === 'object' && payload.variant) || 'navy';
      document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
      if (theme !== 'light' && variant !== 'navy') document.documentElement.setAttribute('data-dark-variant', variant);
      else document.documentElement.removeAttribute('data-dark-variant');
    });

    // State
    var myCallsign = '';
    var myGrid = '';
    var stations = {};
    var qsoArcs = {};
    var qsoState = null;
    var ARC_SEGMENTS = 32;

    window.api.getSettings().then(function(s) {
      myCallsign = (s.myCallsign || '').toUpperCase();
      myGrid = (s.grid || '').toUpperCase().substring(0, 4);
      updateHome();
    });

    // Map
    var map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OSM', maxZoom: 18, className: 'dark-tiles',
    }).addTo(map);
    var markerLayer = L.layerGroup().addTo(map);
    var arcLayer = L.layerGroup().addTo(map);
    var homeMarker = null;
    // Worked-states / countries tints under the grid rectangles + F6/F7/F8
    // legend (lib/worked-overlay.js). Main owns the state.
    if (window.WorkedOverlay) {
      var workedOverlayCtl = WorkedOverlay.attach(L, map, window.api);
      document.addEventListener('keydown', function (e) { workedOverlayCtl.onKey(e); });
      // "Worked" in the title bar: the same machine-wide box preference as the JTCAT window's button.
      var workedBtn = document.getElementById('tb-worked');
      if (workedBtn) {
        var paintWorkedBtn = function (on) { workedBtn.style.color = on ? 'var(--accent-blue, #4fc3f7)' : ''; workedBtn.style.opacity = on ? '1' : '.6'; };
        paintWorkedBtn(workedOverlayCtl.legendVisible);
        workedOverlayCtl.onLegendVisible = paintWorkedBtn;
        workedBtn.addEventListener('click', function () { workedOverlayCtl.setLegendVisible(!workedOverlayCtl.legendVisible); });
      }
    }

    function gridToLatLon(grid) {
      if (!grid || grid.length < 4) return null;
      var g = grid.toUpperCase();
      var lon = (g.charCodeAt(0) - 65) * 20 + parseInt(g[2], 10) * 2 - 180 + 1;
      var lat = (g.charCodeAt(1) - 65) * 10 + parseInt(g[3], 10) * 1 - 90 + 0.5;
      return { lat: lat, lon: lon };
    }

    function gridToBounds(grid) {
      if (!grid || grid.length < 4) return null;
      var g = grid.toUpperCase();
      var west = (g.charCodeAt(0) - 65) * 20 + parseInt(g[2], 10) * 2 - 180;
      var south = (g.charCodeAt(1) - 65) * 10 + parseInt(g[3], 10) * 1 - 90;
      return [[south, west], [south + 1, west + 2]];
    }

    function updateHome() {
      if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
      if (!myGrid) return;
      var bounds = gridToBounds(myGrid);
      if (!bounds) return;
      homeMarker = L.rectangle(bounds, { fillColor: '#e94560', fillOpacity: 0.35, color: '#e94560', weight: 2 }).addTo(map).bindTooltip(myCallsign || 'Home', { permanent: false });
      map.setView(gridToLatLon(myGrid), 4);
    }

    function registerStation(call, grid) {
      if (!call || !grid || !/^[A-R]{2}[0-9]{2}$/i.test(grid)) return;
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
          existing.marker.setTooltipContent(call + ' [' + grid + ']');
        }
        return;
      }
      var isMe = call === myCallsign;
      var color = isMe ? '#e94560' : '#4fc3f7';
      var marker = L.rectangle(bounds, {
        fillColor: color, fillOpacity: isMe ? 0.35 : 0.25, color: color, weight: 1,
      }).addTo(markerLayer).bindTooltip(call + ' [' + grid + ']', { permanent: false });
      stations[call] = { marker: marker, grid: grid, lat: pos.lat, lon: pos.lon, lastSeen: Date.now() };
    }

    function computeArc(lat1, lon1, lat2, lon2) {
      var points = [];
      var dLat = lat2 - lat1, dLon = lon2 - lon1;
      var dist = Math.sqrt(dLat * dLat + dLon * dLon);
      var bulge = dist * 0.2;
      var perpLat = -dLon / (dist || 1), perpLon = dLat / (dist || 1);
      for (var i = 0; i <= ARC_SEGMENTS; i++) {
        var t = i / ARC_SEGMENTS;
        var lat = lat1 + dLat * t, lon = lon1 + dLon * t;
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
        existing.lastSeen = Date.now();
        var el = existing.arc.getElement();
        if (el) el.style.stroke = color;
        return;
      }
      var arc = L.polyline(arcPoints, { color: color, weight: 2, opacity: 0.8, dashArray: '8 6', lineCap: 'round' }).addTo(arcLayer);
      arc.bindTooltip(fromCall + ' \u2192 ' + toCall, { sticky: true });
      qsoArcs[key] = { arc: arc, from: fromCall, to: toCall, lastSeen: Date.now() };
      var el = arc.getElement();
      if (el) {
        var sorted = [fromCall, toCall].sort();
        el.classList.add(sorted[0] === fromCall ? 'jtcat-arc-forward' : 'jtcat-arc-reverse');
      }
    }

    function plotDecode(d) {
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
      Object.keys(qsoArcs).forEach(function(k) {
        if (qsoArcs[k].lastSeen < now - 45000) { arcLayer.removeLayer(qsoArcs[k].arc); delete qsoArcs[k]; }
      });
      Object.keys(stations).forEach(function(c) {
        if (stations[c].lastSeen < now - 180000) { markerLayer.removeLayer(stations[c].marker); delete stations[c]; }
      });
    }

    // Events
    window.api.onJtcatDecode(function(data) {
      (data.results || []).forEach(plotDecode);
      clearOld();
    });

    window.api.onJtcatQsoState(function(data) {
      qsoState = (!data || data.phase === 'idle') ? null : data;
    });

    window.api.onJtcatTxStatus(function(data) {
      if (data.state === 'tx' && qsoState && qsoState.call && myCallsign) {
        drawQsoArc(myCallsign, qsoState.call);
      }
    });
  })();
  
