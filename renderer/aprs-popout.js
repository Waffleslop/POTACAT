// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS window: the map and the Stations list. Read-only: nothing here sends
// a packet or touches the radio. The cards, banners and Beacon panel around
// them are renderer/aprs-window.js (the layout Casey approved 2026-11-19).
//
// Main parses each line (lib/aprs-parser.js) and sends batches every 500 ms;
// lib/aprs-stations.js keeps one row per station or object and forgets those
// not heard for 6 hours (at most WINDOW_MAX_ROWS of them). "Show the last"
// (15 min to 6 h, 1 h by default, saved per profile) picks what the list and
// the map show; a station older than half of it is drawn fainter, in two steps
// (lib/aprs-window-state.js ageFade), its heard-by-my-radio ring at full
// colour. Clear forgets this window's stations and its Heard by my radio
// count; it sends nothing to main, so APRS-IS, listening and the phones'
// ECHOCAT list (its own store in main) carry on. Clicking a row centres the map on it; clicking a
// marker (or a row) shows the details below the list, with a QRZ link.
// The list is two lines a row (lib/aprs-window-state.js stationRow): the
// stations my radio heard first, marked, then the rest by distance. The map's
// "Heard by my radio" / "Everyone" switch filters the map only. There are no
// pop-ups.
//
// The map draws every station on one canvas layer (no DOM marker per
// station), so a few thousand stay fluid:
//  - icons are POTACAT's own (aprs-icons.js), picked by lib/aprs-symbols.js,
//    pre-drawn once per theme and stamped; car, boat and aircraft turn to
//    their course.
//  - zoomed out, nearby stations gather into a cluster with a count
//    (lib/aprs-map.js); a click on a cluster zooms to its stations.
//  - a station that moves glides to its new place over a second; a new one
//    fades in, and one that ages out fades away before it goes.
// The list draws only the rows in view (AprsStations.visibleRange).
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  $('tb-min').addEventListener('click', function () { window.api.minimize(); });
  $('tb-max').addEventListener('click', function () { window.api.maximize(); });
  $('tb-close').addEventListener('click', function () { window.api.close(); });

  var W = window.AprsWindowState;
  var KM_PER_MI = W.KM_PER_MI;
  var LABEL_ZOOM = 9;          // callsign labels from this zoom in
  var CLUSTER_OFF_ZOOM = 12;   // from this zoom in, every station is drawn on its own
  var CELL_PX = 56;            // cluster grid cell
  var ICON_PX = 22;
  var HOME_PX = 24;
  var GLIDE_MS = 1000, FADE_IN_MS = 450, FADE_OUT_MS = 650;

  var unit = 'mi';
  var home = null;
  var store = AprsStations.createStore({ maxAgeMs: AprsStations.WINDOW_MAX_AGE_MS, maxRows: AprsStations.WINDOW_MAX_ROWS });
  var showLastMin = W.DEFAULT_SHOW_LAST_MIN;   // "Show the last", minutes
  var shownTotal = 0;                          // stations within it (before the search)
  var query = '';
  var selected = null;
  var arrivals = [];           // packet times in the last minute
  var lastPacketAt = 0;
  var linkState = null;
  var listRows = [];           // the stations matching the search: my radio's first, then by distance (the list)
  var mapRows = [];            // what the map draws: listRows, or only my radio's with the switch on "Heard by my radio"
  var heardOnly = false;       // the map's switch (the list always shows everyone, mine marked)
  var heardKeys = new Set();   // stations my radio heard while this window is open (the "Heard by my radio" card)
  var lastHeardKey = null, lastHeardAt = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function symHtml(icon, course, px) { return AprsIcons.svg(icon, px || 20, course); }
  function zoomForKm(km) {
    return km <= 30 ? 10 : km <= 60 ? 9 : km <= 120 ? 8 : km <= 200 ? 7 : km <= 450 ? 6 : 5;
  }
  var now = function () { return performance.now(); };

  // ── theme ────────────────────────────────────────────────────────────────
  var theme = {};
  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, dflt) { return (cs.getPropertyValue(name) || '').trim() || dflt; }
    theme = {
      text: v('--text-primary', '#e0e0e0'),
      panel: v('--bg-secondary', '#16213e'),
      border: v('--border-primary', '#2a2a4a'),
      cluster: v('--accent-blue', '#4fc3f7'),
      sel: v('--accent-red', '#e94560'),
      rf: v('--accent-green', '#4ecca3'), // phase 2: the ring on a station the radio heard
    };
    AprsIcons.readColours();
  }
  readTheme();

  // ── map ──────────────────────────────────────────────────────────────────
  var map = L.map('aprs-map', { zoomControl: true, worldCopyJump: true }).setView([39, -96], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  // One canvas over the map. Leaflet's renderer base keeps it placed through
  // pans and scales it through the zoom animation; it is redrawn at the end
  // of each move and on every animation frame while something is moving.
  var AprsLayer = L.Renderer.extend({
    options: { padding: 0.35 },
    _initContainer: function () {
      var c = this._container = document.createElement('canvas');
      c.className = 'aprs-canvas';
      this._ctx = c.getContext('2d');
    },
    _destroyContainer: function () { L.DomUtil.remove(this._container); this._ctx = null; },
    _update: function () {
      if (this._map._animatingZoom && this._bounds) return;
      L.Renderer.prototype._update.call(this);
      var b = this._bounds, size = b.getSize(), dpr = window.devicePixelRatio || 1;
      L.DomUtil.setPosition(this._container, b.min);
      this._container.width = Math.round(size.x * dpr);
      this._container.height = Math.round(size.y * dpr);
      this._container.style.width = size.x + 'px';
      this._container.style.height = size.y + 'px';
      this._dpr = dpr;
      drawFrame();
    },
  });
  var layer = new AprsLayer();   // added to the map once the state below exists

  // ── map state: motion, fades, clusters ──────────────────────────────────
  var motion = {};        // key -> { from, to, t0 } while gliding
  var born = {};          // key -> time it arrived (fades in)
  var ghosts = [];        // { row, t0 } fading away
  var clusters = { singles: [], clusters: [] };
  var clusterZoom = null, clusterDirty = true;
  var hits = [];          // what the last frame drew, for clicks: { x, y, rad, row | cluster }
  var textW = new Map();  // label -> width at the label font
  var perf = { on: false, frames: [], draw: [], cluster: [], list: [], sort: [] };   // timings, only while aprsDev.measure runs
  function perfPush(a, v) { if (perf.on) a.push(v); }

  function shownPos(r, t) {
    var m = motion[r.key];
    if (!m) return { lat: r.lat, lon: r.lon };
    var f = (t - m.t0) / GLIDE_MS;
    if (f >= 1) { delete motion[r.key]; return { lat: r.lat, lon: r.lon }; }
    return AprsMap.glide(m.from, m.to, f);
  }

  // A cluster holding a station the radio heard draws the heard-by-me ring (Casey 2026-11-19).
  function heardOnRadio(pt) { return !!(pt && pt.row && pt.row.rf); }

  function recluster() {
    var z = map.getZoom();
    var pts = [];
    var sel = null;
    for (var i = 0; i < mapRows.length; i++) {
      var r = mapRows[i];
      var p = map.project([r.lat, r.lon], z);
      var pt = { x: p.x, y: p.y, row: r };
      if (r.key === selected) sel = pt; else pts.push(pt);
    }
    var t0 = now();
    clusters = z >= CLUSTER_OFF_ZOOM ? { singles: pts, clusters: [] } : AprsMap.cluster(pts, { cell: CELL_PX, ring: heardOnRadio });
    if (sel) clusters.singles.push(sel);   // the selected station is never hidden in a cluster
    perfPush(perf.cluster, now() - t0);
    clusterZoom = z;
    clusterDirty = false;
  }

  function labelWidth(ctx, s) {
    var w = textW.get(s);
    if (w == null) { w = ctx.measureText(s).width; textW.set(s, w); }
    return w;
  }

  function drawLabel(ctx, x, y, text, selectedOne) {
    var w = labelWidth(ctx, text) + 10;
    var lx = Math.round(x + ICON_PX / 2 + 4), ly = Math.round(y - 9);
    ctx.globalAlpha *= 0.94;
    ctx.fillStyle = theme.panel;
    ctx.strokeStyle = selectedOne ? theme.sel : theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(lx + 0.5, ly + 0.5, w, 18, 4); else ctx.rect(lx + 0.5, ly + 0.5, w, 18);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = theme.text;
    ctx.fillText(text, lx + 5.5, ly + 14);
  }

  // fade: the age fading (W.ageFade) for the icon only; the rings and label keep alpha.
  function drawStation(ctx, r, x, y, alpha, labels, fade) {
    if (fade == null) fade = 1;
    var headed = AprsIcons.isHeaded(r.cls) && r.course != null && r.course > 0 && r.course <= 360;
    var sp = AprsIcons.sprite(r.cls, ICON_PX, layer._dpr || 1, headed);
    var half = sp.size / 2;
    ctx.globalAlpha = alpha * fade;
    if (headed) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(r.course * Math.PI / 180);
      ctx.drawImage(sp.canvas, -half, -half, sp.size, sp.size);
      ctx.restore();
    } else {
      ctx.drawImage(sp.canvas, x - half, y - half, sp.size, sp.size);
    }
    ctx.globalAlpha = alpha;
    var isSel = r.key === selected;
    if (r.rf) {
      // Heard on the radio: a solid ring (phase 2).
      ctx.beginPath(); ctx.arc(x, y, ICON_PX / 2 + 1.5, 0, Math.PI * 2);
      ctx.lineWidth = 3; ctx.strokeStyle = theme.rf; ctx.stroke();
    }
    if (isSel) {
      ctx.beginPath(); ctx.arc(x, y, ICON_PX / 2 + 4, 0, Math.PI * 2);
      ctx.lineWidth = 3; ctx.strokeStyle = theme.sel; ctx.stroke();
    }
    if (labels || isSel) drawLabel(ctx, x, y, r.label, isSel);
    ctx.globalAlpha = 1;
  }

  function drawCluster(ctx, c, x, y) {
    var rad = 13 + Math.min(11, Math.log2(c.count) * 2.4);
    ctx.globalAlpha = 0.28;
    ctx.beginPath(); ctx.arc(x, y, rad + 5, 0, Math.PI * 2);
    ctx.fillStyle = theme.cluster; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = theme.panel; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = theme.cluster; ctx.stroke();
    if (c.ring) {
      // The same solid ring a single heard station has, just outside the halo.
      ctx.beginPath(); ctx.arc(x, y, rad + 6.5, 0, Math.PI * 2);
      ctx.lineWidth = 3; ctx.strokeStyle = theme.rf; ctx.stroke();
    }
    var n = c.count >= 10000 ? Math.round(c.count / 1000) + 'k' : c.count >= 1000 ? (c.count / 1000).toFixed(1) + 'k' : String(c.count);
    ctx.fillStyle = theme.text;
    ctx.font = '700 13px "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(n, x, y + 4.5);
    ctx.textAlign = 'left';
    return rad;
  }

  /** Draw one frame. Returns true while something is still moving or fading. */
  function draw(t) {
    var ctx = layer._ctx, b = layer._bounds;
    if (!ctx || !b) return false;
    var dpr = layer._dpr || 1;
    if (clusterDirty || clusterZoom !== map.getZoom()) recluster();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer._container.width, layer._container.height);
    ctx.setTransform(dpr, 0, 0, dpr, -b.min.x * dpr, -b.min.y * dpr);
    ctx.font = '700 12px "Segoe UI", Roboto, sans-serif';
    var origin = map.getPixelOrigin();
    var z = map.getZoom();
    var labels = z >= LABEL_ZOOM;
    var minX = b.min.x - 40, minY = b.min.y - 40, maxX = b.max.x + 160, maxY = b.max.y + 40;
    var busy = false;
    var wall = Date.now();
    hits = [];

    for (var i = 0; i < clusters.clusters.length; i++) {
      var c = clusters.clusters[i];
      var cx = c.x - origin.x, cy = c.y - origin.y;
      if (cx < minX || cx > maxX || cy < minY || cy > maxY) continue;
      var rad = drawCluster(ctx, c, cx, cy);
      hits.push({ x: cx, y: cy, rad: rad + 4, cluster: c });
    }
    ctx.font = '700 12px "Segoe UI", Roboto, sans-serif';

    for (var g = ghosts.length - 1; g >= 0; g--) {
      var gh = ghosts[g];
      var ga = AprsMap.fade(gh.t0, t, FADE_OUT_MS, true);
      if (ga <= 0) { ghosts.splice(g, 1); continue; }
      busy = true;
      var gp = map.latLngToLayerPoint([gh.row.lat, gh.row.lon]);
      drawStation(ctx, gh.row, gp.x, gp.y, ga, labels);
    }

    for (var s = 0; s < clusters.singles.length; s++) {
      var pt = clusters.singles[s], r = pt.row;
      var x, y;
      if (motion[r.key]) {
        var pos = shownPos(r, t);
        var lp = map.latLngToLayerPoint([pos.lat, pos.lon]);
        x = lp.x; y = lp.y;
        if (motion[r.key]) busy = true;
      } else {
        x = pt.x - origin.x; y = pt.y - origin.y;
      }
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      var a = 1;
      if (born[r.key] != null) {
        a = AprsMap.fade(born[r.key], t, FADE_IN_MS);
        if (a >= 1) delete born[r.key]; else busy = true;
      }
      drawStation(ctx, r, x, y, a, labels, W.ageFade(wall - r.lastHeard, showLastMin).alpha);
      hits.push({ x: x, y: y, rad: ICON_PX / 2 + 3, row: r });
    }

    if (home) {
      var hp = map.latLngToLayerPoint([home.lat, home.lon]);
      var sp = AprsIcons.sprite('you', HOME_PX, dpr, false);
      ctx.drawImage(sp.canvas, hp.x - sp.size / 2, hp.y - sp.size / 2, sp.size, sp.size);
      if (labels) drawLabel(ctx, hp.x + 1, hp.y, (home.call || 'You') + ' ' + (home.grid || ''), false);
    }
    return busy;
  }

  // Frame scheduling: one requestAnimationFrame at a time, only while needed.
  var rafId = 0;
  function requestDraw() { if (!rafId) rafId = requestAnimationFrame(frame); }
  function frame() {
    rafId = 0;
    if (map._animatingZoom) { requestDraw(); return; }
    var t = now();
    var busy = draw(t);
    perfPush(perf.draw, now() - t);
    perfPush(perf.frames, t);
    if (busy) requestDraw();
  }
  function drawFrame() { if (map._animatingZoom) return; var t = now(); if (draw(t)) requestDraw(); perfPush(perf.draw, now() - t); }

  function hitAt(lp) {
    for (var i = hits.length - 1; i >= 0; i--) {
      var h = hits[i], dx = h.x - lp.x, dy = h.y - lp.y;
      if (dx * dx + dy * dy <= h.rad * h.rad) return h;
    }
    return null;
  }
  map.on('click', function (e) {
    var h = hitAt(e.layerPoint);
    if (!h) return;
    if (h.row) { select(h.row.key, false); return; }
    var members = h.cluster.members;
    var bounds = L.latLngBounds(members.map(function (m) { return [m.row.lat, m.row.lon]; }));
    var zNow = map.getZoom();
    var zFit = map.getBoundsZoom(bounds, false, L.point(60, 60));
    if (zFit <= zNow) map.setView(bounds.getCenter(), Math.min(zNow + 2, CLUSTER_OFF_ZOOM));
    else map.fitBounds(bounds, { padding: [60, 60], maxZoom: CLUSTER_OFF_ZOOM });
  });
  var hoverPending = false, hoverPoint = null;
  map.on('mousemove', function (e) {
    hoverPoint = e.layerPoint;
    if (hoverPending) return;
    hoverPending = true;
    requestAnimationFrame(function () {
      hoverPending = false;
      $('aprs-map').classList.toggle('aprs-hover', !!(hoverPoint && hitAt(hoverPoint)));
    });
  });
  map.on('mouseout', function () { $('aprs-map').classList.remove('aprs-hover'); });

  layer.addTo(map);

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
  function kindName(icon) { return AprsIcons.LABEL[icon] || AprsIcons.LABEL.other; }
  function baseCall(c) { return String(c || '').toUpperCase().split('-')[0]; }

  // ── legend ───────────────────────────────────────────────────────────────
  function renderLegend() {
    var keys = AprsIcons.ICONS.concat(['you']);
    $('aprs-legend').innerHTML = keys.map(function (k) {
      return '<span title="' + esc(AprsIcons.LABEL[k]) + '">' + symHtml(k, null, 18) + esc(AprsIcons.SHORT[k]) + '</span>';
    }).join('') + '<span title="Stations your radio heard"><i class="aprs-key-rf"></i>Heard by my radio</span>';
  }
  renderLegend();

  // ── range ────────────────────────────────────────────────────────────────
  // Round numbers in the operator's units (lib/aprs-window-state.js): each
  // option's value is the whole km APRS-IS is asked for, so the choice reads
  // back exactly. Main converted an older saved range to the nearest one.
  var rangeSel = $('aprs-range');
  function fillRanges(km) {
    rangeSel.innerHTML = '';
    var pick = W.nearestRange(km, unit).km;
    W.rangeOptions(unit).forEach(function (o) {
      var el = document.createElement('option');
      el.value = String(o.km);
      el.textContent = o.label;
      if (o.km === pick) el.selected = true;
      rangeSel.appendChild(el);
    });
  }
  rangeSel.addEventListener('change', function () {
    var km = parseInt(rangeSel.value, 10);
    window.api.setRange(km);
    if (home) map.setView([home.lat, home.lon], zoomForKm(km));
  });

  // ── "Show the last" ─────────────────────────────────────────────────────
  var showSel = $('aprs-show-last');
  function fillShowLast() {
    showSel.innerHTML = '';
    W.showLastOptions().forEach(function (o) {
      var el = document.createElement('option');
      el.value = String(o.min);
      el.textContent = o.label;
      if (o.min === showLastMin) el.selected = true;
      showSel.appendChild(el);
    });
  }
  fillShowLast();
  showSel.addEventListener('change', function () {
    showLastMin = W.normShowLast(showSel.value);
    window.api.setShowLast(showLastMin);
    rebuild();
    if (selected && !listRows.some(function (r) { return r.key === selected; })) select(null, false);
  });

  // ── Clear: this window's stations only ────────────────────────────────────
  // No confirm: new packets fill the list again within seconds. Nothing goes
  // to main, so APRS-IS and listening keep running and ECHOCAT's list (its
  // own store in main, lib/aprs-echocat.js) is untouched.
  function clearStations() {
    store.clear();
    heardKeys.clear();
    lastHeardKey = null; lastHeardAt = 0;
    motion = {}; born = {}; ghosts = [];
    selected = null;
    wrap.scrollTop = 0;
    rebuild();
    renderDetail();
  }
  $('aprs-clear').addEventListener('click', clearStations);

  // ── what the cards read (renderer/aprs-window.js) ────────────────────────
  // The APRS-IS link, the packets a minute, and the stations my radio heard
  // while the window is open, with the last one.
  function feedChanged() { if (window.aprsMapApi && window.aprsMapApi.onFeed) window.aprsMapApi.onFeed(); }
  function setLink(s) {
    linkState = s || {};
    showEmpty();
    feedChanged();
  }
  function tickMarks() {
    var t = Date.now();
    while (arrivals.length && arrivals[0] < t - 60000) arrivals.shift();
  }
  function feedInfo() {
    tickMarks();
    var last = lastHeardKey && store.get(lastHeardKey);
    return {
      link: linkState, rate: arrivals.length, lastPacketAt: lastPacketAt, unit: unit,
      heard: { count: heardKeys.size, last: last ? { label: last.label, at: lastHeardAt, distanceKm: last.distanceKm } : null },
    };
  }

  function showEmpty() {
    var el = $('aprs-empty');
    var msg = '';
    if (linkState && linkState.state === 'no-grid') msg = 'Set your grid square in Settings to see the APRS stations near you.';
    else if (shownTotal === 0 && linkState && linkState.state === 'connected') msg = 'Connected. Stations appear here as APRS-IS reports them.';
    else if (heardOnly && shownTotal > 0 && mapRows.length === 0) msg = 'Your radio has not heard a station yet. Pick Everyone to see the stations from APRS-IS.';
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
  }

  // ── list: two lines a row, only the rows in view are in the page ─────────
  var wrap = $('aprs-list-wrap');
  var rowH = 58, rowMeasured = false;
  var rowsPending = false;

  // Phase 2: how the radio heard it ("direct" / "via KB1XYZ-1" / "via a digipeater").
  function rfText(rf) {
    if (!rf) return '';
    return rf.kind === 'digi' ? (rf.digi ? 'via ' + rf.digi : 'via a digipeater') : 'direct';
  }
  function rowHtml(r, t) {
    var v = W.stationRow(r, { unit: unit, now: t });
    var age = W.ageFade(t - r.lastHeard, showLastMin).step;
    var right = [v.dist, v.ago].filter(Boolean).join(' · ');
    return '<li class="aprs-st' + (v.mine ? ' mine' : '') + (age === 2 ? ' older' : age === 1 ? ' old' : '') + (r.key === selected ? ' sel' : '') + '" data-key="' + esc(r.key) + '"'
      + ' title="' + esc(kindName(r.cls) + (v.mine ? '. Heard by my radio, ' + rfText(r.rf) : '') + (v.comment ? '. ' + v.comment : '')) + '">'
      + '<span class="aprs-st-ico">' + symHtml(r.cls, r.course, 20) + '</span>'
      + '<span class="aprs-st-call">' + esc(v.call) + ' <span class="aprs-st-via">' + esc(v.via) + '</span></span>'
      + '<span class="aprs-st-right">' + esc(right) + '</span>'
      + '<span class="aprs-st-cmt">' + esc(v.comment) + '</span>'
      + '</li>';
  }
  function pad(h) { return h > 0 ? '<li class="aprs-pad" aria-hidden="true" style="height:' + h + 'px"></li>' : ''; }

  function renderRows() {
    var t0 = now();
    var v = AprsStations.visibleRange(wrap.scrollTop, wrap.clientHeight, rowH, listRows.length, 8);
    var t = Date.now();
    var html = pad(v.top);
    for (var i = v.start; i < v.end; i++) html += rowHtml(listRows[i], t);
    html += pad(v.bottom);
    $('aprs-rows').innerHTML = html;
    // Rows are a fixed height; if the theme's font makes them differ, follow it.
    // Measured once (and after a theme change), not every render.
    var first = !rowMeasured && document.querySelector('#aprs-rows li.aprs-st');
    if (first) {
      var h = first.getBoundingClientRect().height;
      rowMeasured = true;
      if (h > 0 && Math.abs(h - rowH) > 0.5) { rowH = h; renderRows(); return; }
    }
    perfPush(perf.list, now() - t0);
  }
  function scheduleRows() {
    if (rowsPending) return;
    rowsPending = true;
    requestAnimationFrame(function () { rowsPending = false; renderRows(); });
  }
  wrap.addEventListener('scroll', scheduleRows, { passive: true });
  window.addEventListener('resize', scheduleRows);

  /** The search or the data changed: re-sort, redraw the rows in view and the map. */
  function rebuild() {
    var t0 = now();
    var all = store.list({ sort: 'distance', query: query, withinMs: showLastMin * 60000 });
    shownTotal = query ? store.list({ sort: 'age', withinMs: showLastMin * 60000 }).length : all.length;
    // My radio's stations first (each marked), then the internet's, each by distance.
    listRows = all.filter(function (r) { return !!r.rf; }).concat(all.filter(function (r) { return !r.rf; }));
    mapRows = heardOnly ? listRows.filter(function (r) { return !!r.rf; }) : listRows;
    perfPush(perf.sort, now() - t0);
    clusterDirty = true;
    renderRows();
    var c = W.stationCounts(listRows);
    $('aprs-count').textContent = shownTotal === 0 ? 'No stations yet' : (query ? listRows.length + ' of ' + shownTotal + ': ' : '') + c.text;
    showEmpty();
    requestDraw();
    feedChanged();
  }

  function scrollToRow(key) {
    for (var i = 0; i < listRows.length; i++) {
      if (listRows[i].key !== key) continue;
      var view = wrap.clientHeight;
      var top = i * rowH;
      if (top < wrap.scrollTop || top + rowH > wrap.scrollTop + view) wrap.scrollTop = Math.max(0, top - view / 2);
      return;
    }
  }

  $('aprs-rows').addEventListener('click', function (e) {
    var li = e.target.closest('li.aprs-st');
    if (li && li.dataset.key) select(li.dataset.key, true);
  });
  $('aprs-search').addEventListener('input', function () {
    query = this.value.trim();
    rebuild();
  });
  // The map's switch: "Heard by my radio" or "Everyone" (the map only; the list keeps everyone, mine first).
  function setHeardOnly(on) {
    heardOnly = !!on;
    $('aprs-map-heard').setAttribute('aria-pressed', heardOnly ? 'true' : 'false');
    $('aprs-map-all').setAttribute('aria-pressed', heardOnly ? 'false' : 'true');
    rebuild();
  }
  $('aprs-map-heard').addEventListener('click', function () { setHeardOnly(true); });
  $('aprs-map-all').addEventListener('click', function () { setHeardOnly(false); });

  // ── details ──────────────────────────────────────────────────────────────
  function select(key, centre) {
    selected = key;
    var r = key && store.get(key);
    if (r && centre) map.setView([r.lat, r.lon], Math.max(map.getZoom(), 11));
    clusterDirty = true;
    if (key && !centre) scrollToRow(key);
    renderRows();
    renderDetail();
    requestDraw();
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
    add('Heard', esc(AprsStations.formatAge(Date.now() - r.lastHeard).replace(/^now$/, 'just now')) + (r.packets > 1 ? ' (' + r.packets + ' packets)' : ''));
    if (r.rf) add('Heard by me', esc(rfText(r.rf) + ', ' + AprsStations.formatAge(Date.now() - r.rf.lastHeard).replace(/^now$/, 'just now') + (r.rf.packets > 1 ? ' (' + r.rf.packets + ' packets)' : '')));
    if (r.igate) add('Via', esc(r.igate));
    add('Packet', '<span class="raw">' + esc(r.raw) + '</span>');
    var qrzCall = baseCall(r.call);
    el.innerHTML = '<div class="aprs-detail-head">' + symHtml(r.cls, r.course, 24)
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
  /** Parsed packets into the store, with a glide for each move and a fade for each arrival. */
  function ingest(packets) {
    var t = now();
    for (var i = 0; i < packets.length; i++) {
      var p = packets[i];
      if (!p || !p.from) continue;
      var k = AprsStations.stationKey(p);
      var prev = store.get(k);
      var was = prev ? (motion[k] ? shownPos(prev, t) : { lat: prev.lat, lon: prev.lon }) : null;
      var r = store.add(p);
      if (r && p.rf) { heardKeys.add(k); lastHeardKey = k; lastHeardAt = Date.now(); }
      if (r) {
        if (!was) born[k] = t;
        else if (was.lat !== r.lat || was.lon !== r.lon) motion[k] = { from: was, to: { lat: r.lat, lon: r.lon }, t0: t };
      } else if (prev && !store.get(k)) {
        // A killed object or item: let it fade away.
        ghosts.push({ row: prev, t0: t });
        delete motion[k]; delete born[k];
        if (selected === k) selected = null;
      }
    }
    rebuild();
    if (selected) renderDetail();
  }

  window.api.onInit(function (d) {
    d = d || {};
    unit = d.distUnit === 'km' ? 'km' : 'mi';
    fillRanges(d.km || 150);
    showLastMin = W.normShowLast(d.showLastMin);
    fillShowLast();
    home = d.home || null;
    store.setHome(home);
    if (home) map.setView([home.lat, home.lon], zoomForKm(d.km || 150));
    rebuild();
  });
  window.api.onStatus(setLink);
  window.api.onPackets(function (packets) {
    if (!Array.isArray(packets)) return;
    var t = Date.now();
    for (var i = 0; i < packets.length; i++) arrivals.push(t);
    if (packets.length) lastPacketAt = t;
    ingest(packets);
  });

  // Age-out and the ages move on their own.
  setInterval(function () { tickMarks(); renderRows(); }, 15000);
  // A station that leaves "Show the last" (or the store) fades away on the map.
  setInterval(function () {
    var before = {};
    listRows.forEach(function (r) { before[r.key] = r; });
    store.prune();
    rebuild();
    var still = {};
    listRows.forEach(function (r) { still[r.key] = true; });
    var t = now();
    Object.keys(before).forEach(function (k) {
      if (still[k]) return;
      ghosts.push({ row: before[k], t0: t });
      delete motion[k]; delete born[k];
      if (selected === k) selected = null;
    });
    if (ghosts.length) requestDraw();
    if (selected) renderDetail(); else $('aprs-detail').classList.add('hidden');
  }, 15000);

  // The theme can change while the window is open: re-read the colours.
  new MutationObserver(function () {
    readTheme();
    renderLegend();
    rowMeasured = false;
    renderRows();
    if (selected) renderDetail();
    drawFrame();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-ds', 'data-dark-variant', 'class'] });

  // ── performance numbers and a synthetic load (developer use, from DevTools) ──
  // F12 in this window, then:  aprsDev.synthetic(3000)  and  await aprsDev.measure(5000)
  function stats(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var sum = s.reduce(function (n, v) { return n + v; }, 0);
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    return { n: s.length, mean: r2(sum / s.length), p95: r2(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), max: r2(s[s.length - 1]) };
  }
  var synthTimer = null;
  window.aprsDev = {
    /** Add n made-up stations around home: a third of them move every few seconds. */
    synthetic: function (n, opts) {
      var o = opts || {};
      var c = home || { lat: map.getCenter().lat, lon: map.getCenter().lng };
      var km = o.km || 150;
      var syms = [['/', '>'], ['/', '-'], ['/', '#'], ['I', '&'], ['/', '_'], ['/', '['], ['/', 's'], ['/', '^'], ['/', 'r'], ['/', 'k'], ['/', 'Y'], ['/', "'"]];
      var seed = 12345;
      var rnd = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      var list = [];
      for (var i = 0; i < n; i++) {
        var d = Math.sqrt(rnd()) * km, a = rnd() * Math.PI * 2;
        var sym = syms[i % syms.length];
        var moving = sym[1] === '>' || sym[1] === 'k' || sym[1] === 's' || sym[1] === 'Y' || sym[1] === '^' || sym[1] === "'";
        list.push({
          type: 'position', from: 'SYN' + i + '-' + (i % 16),
          lat: c.lat + (d * Math.cos(a)) / 111, lon: c.lon + (d * Math.sin(a)) / (111 * Math.cos(c.lat * Math.PI / 180)),
          symbolTable: sym[0], symbol: sym[1], course: moving ? Math.floor(rnd() * 359) + 1 : null, speed: moving ? 20 + Math.floor(rnd() * 40) : null,
          comment: 'Synthetic station ' + i, raw: '(synthetic test station)', path: [],
        });
      }
      ingest(list);
      if (synthTimer) clearInterval(synthTimer);
      var movers = list.filter(function (p) { return p.course; });
      synthTimer = setInterval(function () {
        var batch = [];
        for (var j = 0; j < movers.length; j++) {
          if (rnd() > 0.33) continue;   // about a third move each tick, as a live feed would
          var p = movers[j];
          var step = (p.speed * 1.852 / 3600) * 30;   // 30 s of travel, in km
          p.lat += step * Math.cos(p.course * Math.PI / 180) / 111;
          p.lon += step * Math.sin(p.course * Math.PI / 180) / (111 * Math.cos(p.lat * Math.PI / 180));
          batch.push(Object.assign({}, p));
        }
        ingest(batch);
      }, o.everyMs || 2000);
      return store.size;
    },
    stop: function () { if (synthTimer) clearInterval(synthTimer); synthTimer = null; },
    map: map,
    home: function () { return home; },
    select: function (key) { select(key, true); },
    keys: function (icon) { return listRows.filter(function (r) { return !icon || r.cls === icon; }).map(function (r) { return r.key; }); },
    /** Screenshots without a radio: mark n stations as heard by my radio (the window's own copy only). */
    heardDemo: function (n) {
      listRows.slice(0, n || 3).forEach(function (r, i) {
        r.rf = { kind: i === 1 ? 'digi' : 'direct', digi: i === 1 ? 'W3EKT-1' : '', lastHeard: Date.now() - i * 60000, packets: 1 };
        heardKeys.add(r.key); lastHeardKey = r.key; lastHeardAt = Date.now() - i * 60000;
      });
      rebuild();
    },
    /** Frame and work times over ms (optionally panning the map), in milliseconds. */
    measure: function (ms, opts) {
      var o = opts || {};
      ['frames', 'draw', 'cluster', 'list', 'sort'].forEach(function (k) { perf[k] = []; });
      perf.on = true;
      var panT = o.pan ? setInterval(function () { map.panBy([o.pan, 0], { animate: true, duration: 0.25 }); o.pan = -o.pan; }, 300) : null;
      // Count every animation frame the page gets, busy or not, to see dropped frames.
      var ticks = [], live = true;
      (function tick(ts) { ticks.push(ts); if (live) requestAnimationFrame(tick); })(performance.now());
      return new Promise(function (resolve) {
        setTimeout(function () {
          live = false;
          perf.on = false;
          if (panT) clearInterval(panT);
          var gaps = [];
          for (var i = 1; i < ticks.length; i++) gaps.push(ticks[i] - ticks[i - 1]);
          resolve({
            stations: store.size, zoom: map.getZoom(),
            clusters: clusters.clusters.length, singles: clusters.singles.length,
            frameInterval: stats(gaps), longFrames: gaps.filter(function (g) { return g > 25; }).length,
            draw: stats(perf.draw), cluster: stats(perf.cluster), listRender: stats(perf.list), sort: stats(perf.sort),
            listRowsInPage: document.querySelectorAll('#aprs-rows li.aprs-st').length,
          });
        }, ms || 5000);
      });
    },
  };

  // Phase 5: the Beacon section picks a point on this map and draws it; the
  // cards read the feed from here (aprs-window.js sets onFeed).
  window.aprsMapApi = { map: map };
  window.aprsMapApi.feedInfo = feedInfo;

  rebuild();
  window.api.ready();
})();
