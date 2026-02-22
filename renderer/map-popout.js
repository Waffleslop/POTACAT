/* map-popout.js — Self-contained Leaflet map for the POTACAT pop-out window */

// --- Titlebar + Platform ---
if (window.api.platform === 'darwin') {
  document.body.classList.add('platform-darwin');
} else {
  document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
  document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
  document.getElementById('tb-close').addEventListener('click', () => window.api.close());
}

// --- Helpers ---

function gridToLatLonLocal(grid) {
  if (!grid || grid.length < 4) return null;
  const g = grid.toUpperCase();
  const lonField = g.charCodeAt(0) - 65;
  const latField = g.charCodeAt(1) - 65;
  const lonSquare = parseInt(g[2], 10);
  const latSquare = parseInt(g[3], 10);
  let lon = lonField * 20 + lonSquare * 2 - 180;
  let lat = latField * 10 + latSquare * 1 - 90;
  if (grid.length >= 6) {
    const lonSub = g.charCodeAt(4) - 65;
    const latSub = g.charCodeAt(5) - 65;
    lon += lonSub * (2 / 24) + (1 / 24);
    lat += latSub * (1 / 24) + (1 / 48);
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}

function greatCircleArc(lat1, lon1, lat2, lon2, numPoints) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const p1 = lat1 * toRad, l1 = lon1 * toRad;
  const p2 = lat2 * toRad, l2 = lon2 * toRad;
  const d = Math.acos(
    Math.min(1, Math.max(-1,
      Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(l2 - l1)
    ))
  );
  if (d < 1e-10) return [[lat1, lon1], [lat2, lon2]];
  const points = [];
  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);
    points.push([
      Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg,
      Math.atan2(y, x) * toDeg,
    ]);
  }
  return points;
}

function tuneArcColor(source) {
  if (source === 'sota') return '#f0a500';
  if (source === 'dxc') return '#e040fb';
  if (source === 'rbn') return '#00bcd4';
  if (source === 'wwff') return '#26a69a';
  if (source === 'llota') return '#42a5f5';
  if (source === 'pskr') return '#ff6b6b';
  return '#4ecca3';
}

function formatAge(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr.endsWith('Z') ? isoStr : isoStr + 'Z');
    const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (secs < 60) return secs + 's';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm';
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return hrs + 'h ' + remMins + 'm';
  } catch {
    return isoStr;
  }
}

// --- Icon Definitions ---

function makeTeardropIcon(fill, stroke) {
  return L.divIcon({
    className: '',
    html: `<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="${fill}" stroke="${stroke}" stroke-width="1"/><circle cx="12.5" cy="12.5" r="5.5" fill="#fff" opacity="0.4"/></svg>`,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
  });
}

const potaIcon = makeTeardropIcon('#4ecca3', '#3ba882');
const sotaIcon = makeTeardropIcon('#f0a500', '#c47f00');
const rbnIcon = makeTeardropIcon('#00bcd4', '#0097a7');
const wwffIcon = makeTeardropIcon('#26a69a', '#1b7a71');
const llotaIcon = makeTeardropIcon('#42a5f5', '#1e88e5');
const dxcIcon = makeTeardropIcon('#e040fb', '#ab00d9');
const pskrIcon = makeTeardropIcon('#ff6b6b', '#d84343');
const oopIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#8a8a8a" stroke="#666" stroke-width="1"/><circle cx="12.5" cy="12.5" r="5.5" fill="#ff6b6b" opacity="0.7"/></svg>',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});
const expeditionIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#ff1744" stroke="#d50000" stroke-width="1"/><polygon points="12.5,5 14.5,10.5 20,10.5 15.5,14 17.5,19.5 12.5,16 7.5,19.5 9.5,14 5,10.5 10.5,10.5" fill="#ffd600" stroke="#ff9800" stroke-width="0.5"/></svg>',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

// --- Map State ---

let map = null;
let markerLayer = null;
let homeMarker = null;
let nightLayer = null;
let homePos = null;
let tuneArcLayers = [];
let tuneArcFreq = null;
let enableLogging = false;
let distUnit = 'mi';

const MI_TO_KM = 1.60934;
const MAP_STATE_KEY = 'pota-cat-popout-map-state';
const DEFAULT_CENTER = [40.35, -75.58];
let _mapSaveTimer = null;

function formatDistance(miles) {
  if (miles == null) return '\u2014';
  if (distUnit === 'km') return Math.round(miles * MI_TO_KM);
  return miles;
}

// --- Night Overlay ---

function computeNightPolygon() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400000);
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const declRad = (-23.44 * Math.PI / 180) * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  const sunLon = -(utcHours - 12) * 15;
  const tanDecl = Math.tan(declRad);
  const terminator = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const lonRad = (lon - sunLon) * Math.PI / 180;
    const lat = Math.abs(tanDecl) < 1e-10
      ? 0
      : Math.atan(-Math.cos(lonRad) / tanDecl) * 180 / Math.PI;
    terminator.push([lat, lon]);
  }
  const darkPoleLat = declRad > 0 ? -90 : 90;
  const rings = [];
  for (const offset of [-360, 0, 360]) {
    const ring = terminator.map(([lat, lon]) => [lat, lon + offset]);
    ring.push([darkPoleLat, 180 + offset]);
    ring.push([darkPoleLat, -180 + offset]);
    ring.unshift([darkPoleLat, -180 + offset]);
    rings.push(ring);
  }
  return rings;
}

function updateNightOverlay() {
  if (!map) return;
  const rings = computeNightPolygon();
  if (nightLayer) {
    nightLayer.setLatLngs(rings);
  } else {
    nightLayer = L.polygon(rings, {
      fillColor: '#000',
      fillOpacity: 0.25,
      color: '#4fc3f7',
      weight: 1,
      opacity: 0.4,
      interactive: false,
    }).addTo(map);
  }
  if (markerLayer) markerLayer.bringToFront();
}

// --- Map Init ---

function initMap() {
  let initCenter = DEFAULT_CENTER;
  let initZoom = 5;
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_STATE_KEY));
    if (saved && Array.isArray(saved.center) && saved.center.length === 2 && typeof saved.zoom === 'number') {
      initCenter = saved.center;
      initZoom = saved.zoom;
    }
  } catch { /* use defaults */ }

  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView(initCenter, initZoom);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
    className: 'dark-tiles',
  }).addTo(map);

  markerLayer = L.featureGroup().addTo(map);
  bindPopupClickHandlers(map);
  updateNightOverlay();
  setInterval(updateNightOverlay, 60000);

  // Persist map center/zoom (debounced)
  map.on('moveend', () => {
    clearTimeout(_mapSaveTimer);
    _mapSaveTimer = setTimeout(() => {
      const c = map.getCenter();
      localStorage.setItem(MAP_STATE_KEY, JSON.stringify({
        center: [c.lat, c.lng],
        zoom: map.getZoom(),
      }));
    }, 500);
  });
}

// --- Home Marker ---

function setHomeMarker(grid) {
  if (!map) return;
  const pos = gridToLatLonLocal(grid);
  if (!pos) return;
  homePos = { lat: pos.lat, lon: pos.lon };

  if (homeMarker) {
    for (const m of homeMarker) map.removeLayer(m);
  }

  const homeIcon = L.divIcon({
    className: 'home-marker-icon',
    html: '<div style="background:#e94560;width:14px;height:14px;border-radius:50%;border:2px solid #fff;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

  homeMarker = [-360, 0, 360].map((offset) =>
    L.marker([pos.lat, pos.lon + offset], { icon: homeIcon, zIndexOffset: 1000 })
      .bindPopup(`<b>My QTH</b><br>${grid}`)
      .addTo(map)
  );
}

// --- Tune Arc ---

function clearTuneArc() {
  if (!map) return;
  for (const l of tuneArcLayers) map.removeLayer(l);
  tuneArcLayers = [];
  tuneArcFreq = null;
}

async function ensureHomePos() {
  if (homePos) return;
  try {
    const settings = await window.api.getSettings();
    if (settings.grid) setHomeMarker(settings.grid);
  } catch { /* ignore */ }
}

function showTuneArc(lat, lon, freq, source) {
  if (!map || lat == null || lon == null) return;
  if (!homePos) {
    // Try to resolve homePos asynchronously, then redraw
    ensureHomePos().then(() => {
      if (homePos) showTuneArc(lat, lon, freq, source);
    });
    return;
  }
  clearTuneArc();
  tuneArcFreq = freq || null;
  const color = tuneArcColor(source);
  const arcPoints = greatCircleArc(homePos.lat, homePos.lon, lat, lon, 200);
  const segments = [[arcPoints[0]]];
  for (let i = 1; i < arcPoints.length; i++) {
    if (Math.abs(arcPoints[i][1] - arcPoints[i - 1][1]) > 180) {
      segments.push([]);
    }
    segments[segments.length - 1].push(arcPoints[i]);
  }
  for (const seg of segments) {
    if (seg.length < 2) continue;
    for (const offset of [-360, 0, 360]) {
      const offsetPoints = seg.map(([a, b]) => [a, b + offset]);
      tuneArcLayers.push(
        L.polyline(offsetPoints, {
          color,
          weight: 2,
          opacity: 0.7,
          dashArray: '6 4',
          interactive: false,
        }).addTo(map)
      );
    }
  }
}

// --- Marker Updates ---

function updateMapMarkers(spots) {
  if (!markerLayer) return;

  // Popup persistence: skip rebuild if a popup is open for a spot still in the list
  let hasOpenPopup = false;
  markerLayer.eachLayer((layer) => {
    if (layer.getPopup && layer.getPopup() && layer.getPopup().isOpen()) {
      const call = layer._spotCallsign;
      if (call && spots.some(s => s.callsign === call)) {
        hasOpenPopup = true;
      }
    }
  });
  if (hasOpenPopup) return;

  markerLayer.clearLayers();

  // Clear tune arc if the tuned spot is gone
  if (tuneArcFreq && !spots.some(s => s.frequency === tuneArcFreq)) {
    clearTuneArc();
  }

  const unit = distUnit === 'km' ? 'km' : 'mi';

  for (const s of spots) {
    if (s.lat == null || s.lon == null) continue;

    const distStr = s.distance != null ? formatDistance(s.distance) + ' ' + unit : '';
    const watched = !!s.isWatched;
    const sourceLabel = (s.source || 'pota').toUpperCase();
    const sourceColor = s.source === 'sota' ? '#f0a500' : s.source === 'dxc' ? '#e040fb' : s.source === 'rbn' ? '#00bcd4' : s.source === 'wwff' ? '#26a69a' : s.source === 'llota' ? '#42a5f5' : s.source === 'pskr' ? '#ff6b6b' : '#4ecca3';

    const logBtnHtml = enableLogging
      ? ` <button class="log-popup-btn" data-call="${s.callsign}" data-freq="${s.frequency}" data-mode="${s.mode}" data-ref="${s.reference || ''}" data-name="${(s.parkName || '').replace(/"/g, '&quot;')}" data-source="${s.source || ''}" data-wwff-ref="${s.wwffReference || ''}" data-wwff-name="${(s.wwffParkName || '').replace(/"/g, '&quot;')}">Log</button>`
      : '';

    const newBadge = s.isNewPark ? ' <span style="background:#4ecca3;color:#000;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">NEW</span>' : '';
    const expeditionBadge = s.isExpedition ? ' <span style="background:#ff1744;color:#fff;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">DXP</span>' : '';
    const wwffBadge = s.wwffReference ? ' <span style="background:#26a69a;color:#000;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">WWFF</span>' : '';
    const wwffRefLine = s.wwffReference ? `<br><b>${s.wwffReference}</b> ${s.wwffParkName || ''} <span style="color:#26a69a;font-size:11px;">[WWFF]</span>` : '';
    const opLine = s.opName ? `<span style="color:#b0bec5;font-size:11px;">${s.opName}</span><br>` : '';

    const popupContent = `
      <b>${watched ? '\u2B50 ' : ''}<a href="#" class="popup-qrz" data-call="${s.callsign}">${s.callsign}</a></b> <span style="color:${sourceColor};font-size:11px;">[${sourceLabel}]</span>${expeditionBadge}${newBadge}${wwffBadge}<br>
      ${opLine}${parseFloat(s.frequency).toFixed(1)} kHz &middot; ${s.mode}<br>
      <b>${s.reference || ''}</b> ${s.parkName || ''}${wwffRefLine}<br>
      ${distStr}<br>
      <button class="tune-btn" data-freq="${s.frequency}" data-mode="${s.mode}" data-bearing="${s.bearing != null ? s.bearing : ''}" data-lat="${s.lat != null ? s.lat : ''}" data-lon="${s.lon != null ? s.lon : ''}" data-source="${s.source || ''}">Tune</button>${logBtnHtml}
    `;

    const sourceIcon = s.source === 'sota' ? sotaIcon
      : s.source === 'rbn' ? rbnIcon
      : s.source === 'wwff' ? wwffIcon
      : s.source === 'llota' ? llotaIcon
      : s.source === 'dxc' ? dxcIcon
      : s.source === 'pskr' ? pskrIcon
      : potaIcon;

    const markerOptions = s.isExpedition
      ? { icon: expeditionIcon, zIndexOffset: 500 }
      : s.isOop
        ? { icon: oopIcon, opacity: 0.4 }
        : { icon: sourceIcon, ...(s.isWorked ? { opacity: 0.5 } : {}) };

    for (const offset of [-360, 0, 360]) {
      const marker = L.marker([s.lat, s.lon + offset], markerOptions).bindPopup(popupContent);
      marker._spotCallsign = s.callsign;
      marker.addTo(markerLayer);
    }
  }
}

// --- Popup Click Handlers ---

function bindPopupClickHandlers(mapInstance) {
  mapInstance.on('popupopen', (e) => {
    const container = e.popup.getElement();
    if (!container) return;
    container.querySelectorAll('.tune-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const b = btn.dataset.bearing;
        window.api.tune(btn.dataset.freq, btn.dataset.mode, b ? parseInt(b, 10) : undefined);
        const lat = parseFloat(btn.dataset.lat), lon = parseFloat(btn.dataset.lon);
        if (!isNaN(lat) && !isNaN(lon)) showTuneArc(lat, lon, btn.dataset.freq, btn.dataset.source);
      });
    });
    container.querySelectorAll('.popup-qrz').forEach((link) => {
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        window.api.openExternal(`https://www.qrz.com/db/${encodeURIComponent(link.dataset.call.split('/')[0])}`);
      });
    });
    container.querySelectorAll('.log-popup-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // Open the log dialog in the main window with spot data pre-filled
        window.api.openLogDialog({
          callsign: btn.dataset.call,
          frequency: btn.dataset.freq,
          mode: btn.dataset.mode,
          reference: btn.dataset.ref || '',
          parkName: btn.dataset.name || '',
          source: btn.dataset.source || '',
          wwffReference: btn.dataset.wwffRef || '',
          wwffParkName: btn.dataset.wwffName || '',
        });
      });
    });
  });
}

// --- IPC Listeners ---

// Register IPC listeners immediately (before async init) so they're ready
// when the main renderer sends initial data after did-finish-load
let _pendingSpots = null;
let _pendingArc = null;

window.api.onPopoutSpots((data) => {
  if (data.distUnit) distUnit = data.distUnit;
  if (data.enableLogging != null) enableLogging = data.enableLogging;
  if (!map) {
    _pendingSpots = data.spots || [];
  } else {
    updateMapMarkers(data.spots || []);
  }
});

window.api.onPopoutTuneArc((data) => {
  if (!map) {
    _pendingArc = data;
  } else if (data.clear) {
    clearTuneArc();
  } else {
    showTuneArc(data.lat, data.lon, data.freq, data.source);
  }
});

window.api.onPopoutHome((data) => {
  if (data.grid) setHomeMarker(data.grid);
});

window.api.onPopoutTheme((theme) => {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
});

async function init() {
  try {
    // Load settings for distUnit, enableLogging, and theme
    const settings = await window.api.getSettings();
    distUnit = settings.distUnit || 'mi';
    enableLogging = !!settings.enableLogging;

    // Apply theme
    if (settings.lightMode) {
      document.documentElement.setAttribute('data-theme', 'light');
    }

    initMap();

    // Set home marker from settings
    if (settings.grid) {
      console.log('[popout] setHomeMarker grid=' + settings.grid);
      setHomeMarker(settings.grid);
    } else {
      console.warn('[popout] No grid in settings — QTH marker will not be shown');
    }
  } catch (err) {
    console.error('[popout] init() failed:', err);
    // Still try to init map if it hasn't been created
    if (!map) initMap();
  }

  // Flush any data that arrived before the map was ready
  if (_pendingSpots) {
    updateMapMarkers(_pendingSpots);
    _pendingSpots = null;
  }
  if (_pendingArc) {
    if (_pendingArc.clear) clearTuneArc();
    else showTuneArc(_pendingArc.lat, _pendingArc.lon, _pendingArc.freq, _pendingArc.source);
    _pendingArc = null;
  }
}

init();
