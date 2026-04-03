// Propagation Map Pop-out — RBN + PSKReporter spots
(function() {
  'use strict';

  // --- Window controls ---
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
  var rbnSpots = [];
  var pskrSpots = [];
  var showRbn = true;
  var showPskr = true;
  var distUnit = 'mi';
  var homePos = null;
  var myCallsign = '';

  var BAND_COLORS = {
    '160m': '#ff4444', '80m': '#ff8c00', '60m': '#ffd700', '40m': '#4ecca3',
    '30m': '#00cccc', '20m': '#4488ff', '17m': '#8844ff', '15m': '#cc44ff',
    '12m': '#ff44cc', '10m': '#ff4488', '6m': '#e0e0e0', '4m': '#b0e0e6', '2m': '#88ff88', '70cm': '#ffaa44',
  };

  var MI_TO_KM = 1.60934;

  // --- DOM refs ---
  var showRbnEl = document.getElementById('pp-show-rbn');
  var showPskrEl = document.getElementById('pp-show-pskr');
  var bandFilterEl = document.getElementById('pp-band-filter');
  var modeFilterEl = document.getElementById('pp-mode-filter');
  var maxAgeInput = document.getElementById('pp-max-age');
  var ageUnitSelect = document.getElementById('pp-age-unit');
  var countEl = document.getElementById('pp-count');
  var legendEl = document.getElementById('pp-legend');
  var tableBody = document.getElementById('pp-table-body');
  var distHeader = document.getElementById('pp-dist-header');
  var mapContainer = document.querySelector('.pp-map-container');
  var tableContainer = document.getElementById('pp-table-container');

  // --- Load settings ---
  window.api.getSettings().then(function(s) {
    myCallsign = (s.myCallsign || '').toUpperCase();
    distUnit = s.distUnit || 'mi';
    distHeader.textContent = distUnit === 'km' ? 'Dist (km)' : 'Dist (mi)';
    var grid = s.grid || 'FN20jb';
    homePos = gridToLatLon(grid);
    if (homePos && map) {
      map.setView([homePos.lat, homePos.lon], 3);
      updateHomeMarker();
    }
  });

  // --- Helpers ---
  function gridToLatLon(grid) {
    if (!grid || grid.length < 4) return null;
    var g = grid.toUpperCase();
    var lonField = g.charCodeAt(0) - 65;
    var latField = g.charCodeAt(1) - 65;
    var lonSquare = parseInt(g[2], 10);
    var latSquare = parseInt(g[3], 10);
    var lon = lonField * 20 + lonSquare * 2 - 180;
    var lat = latField * 10 + latSquare * 1 - 90;
    if (grid.length >= 6) {
      lon += (g.charCodeAt(4) - 65) * (2 / 24) + (1 / 24);
      lat += (g.charCodeAt(5) - 65) * (1 / 24) + (1 / 48);
    } else {
      lon += 1; lat += 0.5;
    }
    return { lat: lat, lon: lon };
  }

  function greatCircleArc(lat1, lon1, lat2, lon2, n) {
    var R = Math.PI / 180, D = 180 / Math.PI;
    var p1 = lat1 * R, l1 = lon1 * R, p2 = lat2 * R, l2 = lon2 * R;
    var d = Math.acos(Math.min(1, Math.max(-1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(l2 - l1))));
    if (d < 1e-10) return [[lat1, lon1], [lat2, lon2]];
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var f = i / n;
      var a = Math.sin((1 - f) * d) / Math.sin(d);
      var b = Math.sin(f * d) / Math.sin(d);
      var x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
      var y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
      var z = a * Math.sin(p1) + b * Math.sin(p2);
      pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * D, Math.atan2(y, x) * D]);
    }
    return pts;
  }

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

  function spotAgeSecs(spotTime) {
    if (!spotTime) return Infinity;
    try {
      var d = new Date(spotTime.endsWith('Z') ? spotTime : spotTime + 'Z');
      return Math.max(0, (Date.now() - d.getTime()) / 1000);
    } catch (e) { return Infinity; }
  }

  function formatAge(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr.endsWith('Z') ? isoStr : isoStr + 'Z');
      var secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
      if (secs < 60) return secs + 's';
      var mins = Math.floor(secs / 60);
      if (mins < 60) return mins + 'm';
      var hrs = Math.floor(mins / 60);
      return hrs + 'h ' + (mins % 60) + 'm';
    } catch (e) { return isoStr; }
  }

  function formatDistance(miles) {
    if (miles == null) return '\u2014';
    if (distUnit === 'km') return Math.round(miles * MI_TO_KM);
    return miles;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // --- Multi-dropdown ---
  function initDropdown(el, label, onChange) {
    var btn = el.querySelector('.pp-dropdown-btn');
    var text = el.querySelector('.pp-dropdown-text');
    var checks = el.querySelectorAll('input[type="checkbox"]');
    var allCb = el.querySelector('input[value="all"]');

    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      // Close other dropdowns
      document.querySelectorAll('.pp-dropdown.open').forEach(function(d) { if (d !== el) d.classList.remove('open'); });
      el.classList.toggle('open');
    });

    function update() {
      var vals = [];
      checks.forEach(function(c) { if (c.value !== 'all' && c.checked) vals.push(c.value); });
      if (allCb && allCb.checked) { text.textContent = 'All'; }
      else if (vals.length === 0) { text.textContent = 'None'; }
      else if (vals.length <= 2) { text.textContent = vals.join(', '); }
      else { text.textContent = vals.length + ' sel'; }
      onChange();
    }

    checks.forEach(function(c) {
      c.addEventListener('change', function() {
        if (c.value === 'all') {
          checks.forEach(function(x) { if (x !== c) x.checked = false; });
        } else {
          if (allCb) allCb.checked = false;
          // If nothing checked, re-check All
          var anyChecked = false;
          checks.forEach(function(x) { if (x.value !== 'all' && x.checked) anyChecked = true; });
          if (!anyChecked && allCb) allCb.checked = true;
        }
        update();
      });
    });
  }

  function getDropdownValues(el) {
    var allCb = el.querySelector('input[value="all"]');
    if (allCb && allCb.checked) return null; // null = all
    var vals = new Set();
    el.querySelectorAll('input[type="checkbox"]').forEach(function(c) {
      if (c.value !== 'all' && c.checked) vals.add(c.value);
    });
    return vals.size > 0 ? vals : null;
  }

  // Close dropdowns on outside click
  document.addEventListener('click', function() {
    document.querySelectorAll('.pp-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
  });

  // --- Map ---
  var map = null;
  var markerLayer = null;
  var nightLayer = null;
  var homeMarkers = null;

  function initMap() {
    var center = homePos ? [homePos.lat, homePos.lon] : [40.35, -75.58];
    map = L.map('pp-map', { zoomControl: true, worldCopyJump: true }).setView(center, 3);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OSM', maxZoom: 18, className: 'dark-tiles',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    updateHomeMarker();
    updateNightOverlay();
    setInterval(updateNightOverlay, 60000);
  }

  function updateHomeMarker() {
    if (!map || !homePos) return;
    if (homeMarkers) homeMarkers.forEach(function(m) { map.removeLayer(m); });
    var icon = L.divIcon({
      className: 'home-marker-icon',
      html: '<div style="background:#e94560;width:14px;height:14px;border-radius:50%;border:2px solid #fff;"></div>',
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
    homeMarkers = [-360, 0, 360].map(function(offset) {
      return L.marker([homePos.lat, homePos.lon + offset], { icon: icon, zIndexOffset: 1000 })
        .bindPopup('<b>My QTH</b>').addTo(map);
    });
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
    if (markerLayer) markerLayer.bringToFront();
  }

  // --- Filtering ---
  function getFilteredSpots() {
    var bands = getDropdownValues(bandFilterEl);
    var modes = getDropdownValues(modeFilterEl);
    var maxAge = parseInt(maxAgeInput.value, 10) || 30;
    var ageUnit = ageUnitSelect.value;
    var maxAgeSecs = maxAge * (ageUnit === 'h' ? 3600 : 60);

    var merged = [];
    if (showRbn) {
      rbnSpots.forEach(function(s) { merged.push(Object.assign({}, s, { _source: 'rbn', _station: s.spotter })); });
    }
    if (showPskr) {
      pskrSpots.forEach(function(s) { merged.push(Object.assign({}, s, { _source: 'pskr', _station: s.receiver })); });
    }

    return merged.filter(function(s) {
      if (bands && !bands.has(s.band)) return false;
      if (modes && !modes.has(s.mode)) return false;
      if (spotAgeSecs(s.spotTime) > maxAgeSecs) return false;
      return true;
    });
  }

  // --- Rendering ---
  function render() {
    renderMarkers();
    renderTable();
  }

  function renderMarkers() {
    if (!markerLayer) return;
    markerLayer.clearLayers();

    var filtered = getFilteredSpots();
    var activeBands = new Set();

    // Arcs
    if (homePos) {
      filtered.forEach(function(s) {
        if (s.lat == null || s.lon == null) return;
        var color = BAND_COLORS[s.band] || '#ffffff';
        var arcPoints = greatCircleArc(homePos.lat, homePos.lon, s.lat, s.lon, 50);
        [-360, 0, 360].forEach(function(offset) {
          L.polyline(arcPoints.map(function(p) { return [p[0], p[1] + offset]; }), {
            color: color, weight: 1.5, opacity: 0.45, interactive: false,
          }).addTo(markerLayer);
        });
      });
    }

    // Circle markers
    filtered.forEach(function(s) {
      if (s.lat == null || s.lon == null) return;
      if (s.band) activeBands.add(s.band);

      var color = BAND_COLORS[s.band] || '#ffffff';
      var distStr = s.distance != null ? formatDistance(s.distance) + ' ' + (distUnit === 'km' ? 'km' : 'mi') : '';
      var snrStr = s.snr != null ? s.snr + ' dB' : '';
      var wpmStr = s.wpm != null ? s.wpm + ' WPM' : '';
      var details = [snrStr, wpmStr].filter(Boolean).join(' / ');
      var srcLabel = s._source === 'pskr' ? 'PSKReporter' : 'RBN';

      var popup = '<b>' + esc(s._station) + '</b> <span style="color:var(--text-dim)">' + srcLabel + '</span><br>' +
        esc(s.locationDesc || '') + '<br>' +
        (s.band || '') + ' ' + (s.mode || '') + ' &middot; ' + details + '<br>' +
        (distStr ? distStr + '<br>' : '') +
        '<span style="color:var(--text-dim)">' + formatAge(s.spotTime) + '</span>';

      [-360, 0, 360].forEach(function(offset) {
        L.circleMarker([s.lat, s.lon + offset], {
          radius: 7, fillColor: color, color: color, weight: 1, opacity: 0.9, fillOpacity: 0.7,
        }).bindPopup(popup).addTo(markerLayer);
      });
    });

    countEl.textContent = filtered.length;
    renderLegend(activeBands);
  }

  function renderLegend(activeBands) {
    legendEl.innerHTML = '';
    ['160m','80m','60m','40m','30m','20m','17m','15m','12m','10m','6m','4m','2m','70cm'].forEach(function(band) {
      if (!activeBands.has(band)) return;
      var item = document.createElement('span');
      item.className = 'pp-legend-item';
      var swatch = document.createElement('span');
      swatch.className = 'pp-legend-swatch';
      swatch.style.background = BAND_COLORS[band] || '#fff';
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(band));
      legendEl.appendChild(item);
    });
  }

  function renderTable() {
    tableBody.innerHTML = '';
    var sorted = getFilteredSpots().reverse(); // newest first

    sorted.forEach(function(s) {
      var tr = document.createElement('tr');

      // Station
      var stationTd = document.createElement('td');
      var dot = document.createElement('span');
      dot.className = 'pp-source-dot';
      dot.style.background = s._source === 'pskr' ? '#ff6b6b' : '#4fc3f7';
      dot.title = s._source === 'pskr' ? 'PSKReporter' : 'RBN';
      stationTd.appendChild(dot);
      var link = document.createElement('a');
      link.className = 'pp-qrz-link';
      link.href = '#';
      link.textContent = s._station;
      link.addEventListener('click', function(e) {
        e.preventDefault();
        window.api.openExternal('https://www.qrz.com/db/' + encodeURIComponent(s._station.split('/')[0]));
      });
      stationTd.appendChild(link);
      tr.appendChild(stationTd);

      // Location
      var locTd = document.createElement('td');
      locTd.textContent = s.locationDesc || '';
      tr.appendChild(locTd);

      // Dist
      var distTd = document.createElement('td');
      distTd.textContent = s.distance != null ? formatDistance(s.distance) : '\u2014';
      tr.appendChild(distTd);

      // Freq
      var freqTd = document.createElement('td');
      freqTd.textContent = parseFloat(s.frequency).toFixed(1);
      tr.appendChild(freqTd);

      // Mode
      var modeTd = document.createElement('td');
      modeTd.textContent = s.mode || '';
      tr.appendChild(modeTd);

      // SNR
      var snrTd = document.createElement('td');
      snrTd.textContent = s.snr != null ? s.snr + ' dB' : '';
      tr.appendChild(snrTd);

      // Time
      var timeTd = document.createElement('td');
      try { timeTd.textContent = new Date(s.spotTime).toISOString().slice(11, 16) + 'z'; }
      catch (e) { timeTd.textContent = ''; }
      tr.appendChild(timeTd);

      // Seen
      var seenTd = document.createElement('td');
      seenTd.textContent = formatAge(s.spotTime);
      tr.appendChild(seenTd);

      tableBody.appendChild(tr);
    });
  }

  // --- Event handlers ---
  initDropdown(bandFilterEl, 'Band', render);
  initDropdown(modeFilterEl, 'Mode', render);

  maxAgeInput.addEventListener('change', render);
  ageUnitSelect.addEventListener('change', render);

  showRbnEl.addEventListener('change', function() { showRbn = showRbnEl.checked; render(); });
  showPskrEl.addEventListener('change', function() { showPskr = showPskrEl.checked; render(); });

  document.getElementById('pp-clear-btn').addEventListener('click', function() {
    rbnSpots = [];
    pskrSpots = [];
    render();
  });

  // --- IPC ---
  window.api.onRbnSpots(function(data) {
    rbnSpots = data || [];
    render();
  });

  window.api.onPskrMapSpots(function(data) {
    pskrSpots = data || [];
    render();
  });

  // --- Splitter ---
  var splitter = document.getElementById('pp-splitter');
  splitter.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var startY = e.clientY;
    var startMapH = mapContainer.offsetHeight;
    var startTableH = tableContainer.offsetHeight;

    function onMove(ev) {
      var delta = ev.clientY - startY;
      mapContainer.style.flex = 'none';
      tableContainer.style.flex = 'none';
      mapContainer.style.height = Math.max(80, startMapH + delta) + 'px';
      tableContainer.style.height = Math.max(60, startTableH - delta) + 'px';
      if (map) map.invalidateSize();
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // --- Init ---
  initMap();
})();
