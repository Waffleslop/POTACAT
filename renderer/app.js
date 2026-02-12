// Renderer process — UI logic
// Leaflet is loaded via <script> tag in index.html and exposes window.L

let allSpots = [];
let sortCol = 'distance';
let sortAsc = true;
let currentView = 'table'; // 'table' or 'map'

// User preferences (loaded from settings)
let distUnit = 'mi';    // 'mi' or 'km'
let watchlist = new Set(); // uppercase callsigns
let scanDwell = 7;       // seconds per frequency during scan
let enablePota = true;
let enableSota = false;

// --- Scan state ---
let scanning = false;
let scanTimer = null;
let scanIndex = 0;
let scanSkipped = new Set(); // frequencies to skip (as strings)

const MI_TO_KM = 1.60934;

const bandFilter = document.getElementById('band-filter');
const modeFilter = document.getElementById('mode-filter');
const catOptions = document.getElementById('cat-options');
const tbody = document.getElementById('spots-body');
const noSpots = document.getElementById('no-spots');
const catStatusEl = document.getElementById('cat-status');
const spotCountEl = document.getElementById('spot-count');
const lastRefreshEl = document.getElementById('last-refresh');
const refreshBtn = document.getElementById('refresh-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsDialog = document.getElementById('settings-dialog');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');
const setGrid = document.getElementById('set-grid');
const setDistUnit = document.getElementById('set-dist-unit');
const setScanDwell = document.getElementById('set-scan-dwell');
const setWatchlist = document.getElementById('set-watchlist');
const setEnablePota = document.getElementById('set-enable-pota');
const setEnableSota = document.getElementById('set-enable-sota');
const scanBtn = document.getElementById('scan-btn');
const spotsTable = document.getElementById('spots-table');
const mapDiv = document.getElementById('map');
const viewTableBtn = document.getElementById('view-table-btn');
const viewMapBtn = document.getElementById('view-map-btn');
const distHeader = document.getElementById('dist-header');
const utcClockEl = document.getElementById('utc-clock');

// --- UTC Clock ---
function updateUtcClock() {
  const now = new Date();
  utcClockEl.textContent = now.toISOString().slice(11, 19) + 'z';
}
updateUtcClock();
setInterval(updateUtcClock, 1000);

// --- Load preferences from settings ---
function parseWatchlist(str) {
  if (!str) return new Set();
  return new Set(str.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean));
}

async function loadPrefs() {
  const settings = await window.api.getSettings();
  distUnit = settings.distUnit || 'mi';
  scanDwell = parseInt(settings.scanDwell, 10) || 7;
  watchlist = parseWatchlist(settings.watchlist);
  enablePota = settings.enablePota !== false; // default true
  enableSota = settings.enableSota === true;  // default false
  updateHeaders();
}

function updateHeaders() {
  distHeader.childNodes[0].textContent = distUnit === 'km' ? 'Dist (km)' : 'Dist (mi)';
}

// --- CAT selector (inside Settings) ---
const TCP_PORTS = [
  { label: 'Slice A', detail: 'TCP 127.0.0.1:5002', type: 'tcp', host: '127.0.0.1', port: 5002 },
  { label: 'Slice B', detail: 'TCP 127.0.0.1:5003', type: 'tcp', host: '127.0.0.1', port: 5003 },
  { label: 'Slice C', detail: 'TCP 127.0.0.1:5004', type: 'tcp', host: '127.0.0.1', port: 5004 },
  { label: 'Slice D', detail: 'TCP 127.0.0.1:5005', type: 'tcp', host: '127.0.0.1', port: 5005 },
];

let selectedCatValue = ''; // tracks selection within the open dialog

async function populateCatOptions(currentTarget) {
  const ports = await window.api.listPorts();
  const currentStr = currentTarget ? JSON.stringify(currentTarget) : '';
  selectedCatValue = currentStr;

  catOptions.innerHTML = '';

  // "None" option
  catOptions.appendChild(buildCatOption('None', 'Disconnect CAT', '', currentStr));

  // TCP section
  const tcpLabel = document.createElement('div');
  tcpLabel.className = 'cat-section-label';
  tcpLabel.textContent = 'SmartSDR TCP';
  catOptions.appendChild(tcpLabel);

  for (const tcp of TCP_PORTS) {
    const val = JSON.stringify({ type: tcp.type, host: tcp.host, port: tcp.port });
    catOptions.appendChild(buildCatOption(tcp.label, tcp.detail, val, currentStr));
  }

  // Serial section (only if ports detected)
  if (ports.length > 0) {
    const serialLabel = document.createElement('div');
    serialLabel.className = 'cat-section-label';
    serialLabel.textContent = 'Serial Ports';
    catOptions.appendChild(serialLabel);

    for (const p of ports) {
      const val = JSON.stringify({ type: 'serial', path: p.path });
      catOptions.appendChild(buildCatOption(p.path, p.friendlyName, val, currentStr));
    }
  }
}

function buildCatOption(label, detail, value, currentStr) {
  const div = document.createElement('div');
  div.className = 'cat-option' + (value === currentStr ? ' selected' : '');
  div.innerHTML = `<div class="cat-option-label">${label}</div><div class="cat-option-detail">${detail}</div>`;
  div.addEventListener('click', () => {
    selectedCatValue = value;
    catOptions.querySelectorAll('.cat-option').forEach((el) => el.classList.remove('selected'));
    div.classList.add('selected');
  });
  return div;
}

// --- Filtering ---
function modeMatches(spotMode, filter) {
  if (filter === 'all') return true;
  if (filter === 'SSB') return spotMode === 'USB' || spotMode === 'LSB' || spotMode === 'SSB';
  return spotMode === filter;
}

function getFiltered() {
  const band = bandFilter.value;
  const mode = modeFilter.value;
  return allSpots.filter((s) => {
    if (s.source === 'pota' && !enablePota) return false;
    if (s.source === 'sota' && !enableSota) return false;
    if (band !== 'all' && s.band !== band) return false;
    if (!modeMatches(s.mode, mode)) return false;
    return true;
  });
}

// --- Sorting ---
function sortSpots(spots) {
  return spots.slice().sort((a, b) => {
    let va = a[sortCol];
    let vb = b[sortCol];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') {
      return sortAsc ? va - vb : vb - va;
    }
    va = String(va);
    vb = String(vb);
    return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
  });
}

// --- Column Resizing ---
// --- Column Resizing ---
// Widths stored as percentages of table width so they always fit
const COL_WIDTHS_KEY = 'pota-cat-col-pct-v4';
// Callsign, Freq, Mode, Ref, Name, State, Dist, Age, Skip
const DEFAULT_COL_PCT = [10, 9, 5, 8, 26, 11, 7, 7, 6];

function loadColWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY));
    if (Array.isArray(saved) && saved.length === DEFAULT_COL_PCT.length) return saved;
  } catch { /* ignore */ }
  return [...DEFAULT_COL_PCT];
}

function saveColWidths(widths) {
  localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(widths));
}

function applyColWidths(widths) {
  const ths = spotsTable.querySelectorAll('thead th');
  ths.forEach((th, i) => {
    if (widths[i] != null) th.style.width = widths[i] + '%';
  });
}

function initColumnResizing() {
  const colPcts = loadColWidths();
  applyColWidths(colPcts);

  const ths = spotsTable.querySelectorAll('thead th');
  ths.forEach((th, i) => {
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.style.position = 'relative';
    th.appendChild(handle);

    let startX, startPct;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't trigger sort
      startX = e.clientX;
      startPct = colPcts[i];
      const tableW = spotsTable.offsetWidth;
      document.body.style.cursor = 'col-resize';

      const onMove = (ev) => {
        const deltaPx = ev.clientX - startX;
        const deltaPct = (deltaPx / tableW) * 100;
        colPcts[i] = Math.max(3, startPct + deltaPct);
        th.style.width = colPcts[i] + '%';
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        saveColWidths(colPcts);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// --- Leaflet Map ---
// Fix Leaflet default icon paths for bundled usage
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: '../node_modules/leaflet/dist/images/marker-icon-2x.png',
  iconUrl: '../node_modules/leaflet/dist/images/marker-icon.png',
  shadowUrl: '../node_modules/leaflet/dist/images/marker-shadow.png',
});

// Orange teardrop pin for SOTA spots (same shape as default Leaflet marker)
const sotaIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#f0a500" stroke="#c47f00" stroke-width="1"/>' +
    '<circle cx="12.5" cy="12.5" r="5.5" fill="#fff" opacity="0.4"/>' +
    '</svg>',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

let map = null;
let markerLayer = null;
let homeMarker = null;

// Default center: FN20jb (eastern PA) ≈ 40.35°N, 75.58°W
const DEFAULT_CENTER = [40.35, -75.58];

function initMap() {
  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView(DEFAULT_CENTER, 5);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
    className: 'dark-tiles',
  }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);

  // Add home marker
  updateHomeMarker();
}

async function updateHomeMarker() {
  const settings = await window.api.getSettings();
  const grid = settings.grid || 'FN20jb';
  const pos = gridToLatLonLocal(grid);
  if (!pos) return;

  // Remove old home markers
  if (homeMarker) {
    for (const m of homeMarker) map.removeLayer(m);
  }

  const homeIcon = L.divIcon({
    className: 'home-marker-icon',
    html: '<div style="background:#e94560;width:14px;height:14px;border-radius:50%;border:2px solid #fff;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

  // Place home marker at canonical position plus world-copies
  homeMarker = [-360, 0, 360].map((offset) =>
    L.marker([pos.lat, pos.lon + offset], { icon: homeIcon, zIndexOffset: 1000 })
      .bindPopup(`<b>My QTH</b><br>${grid}`)
      .addTo(map)
  );

  map.setView([pos.lat, pos.lon], map.getZoom());
}

// Lightweight Maidenhead conversion for the renderer (no require of Node module)
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

function formatDistance(miles) {
  if (miles == null) return '—';
  if (distUnit === 'km') return Math.round(miles * MI_TO_KM);
  return miles;
}

function updateMapMarkers(filtered) {
  if (!markerLayer) return;
  markerLayer.clearLayers();

  const unit = distUnit === 'km' ? 'km' : 'mi';

  for (const s of filtered) {
    if (s.lat == null || s.lon == null) continue;

    const distStr = s.distance != null ? formatDistance(s.distance) + ' ' + unit : '';
    const watched = watchlist.has(s.callsign.toUpperCase());

    const sourceLabel = (s.source || 'pota').toUpperCase();
    const popupContent = `
      <b>${watched ? '\u2B50 ' : ''}<a href="#" class="popup-qrz" data-call="${s.callsign}">${s.callsign}</a></b> <span style="color:${s.source === 'sota' ? '#f0a500' : '#4ecca3'};font-size:11px;">[${sourceLabel}]</span><br>
      ${parseFloat(s.frequency).toFixed(1)} kHz &middot; ${s.mode}<br>
      <b>${s.reference}</b> ${s.parkName}<br>
      ${distStr}<br>
      <button class="tune-btn" data-freq="${s.frequency}" data-mode="${s.mode}">Tune</button>
    `;

    // SOTA gets orange pin, POTA gets default blue marker
    const markerOptions = s.source === 'sota'
      ? { icon: sotaIcon }
      : {};

    // Plot marker at canonical position and one world-copy in each direction
    for (const offset of [-360, 0, 360]) {
      const marker = L.marker([s.lat, s.lon + offset], markerOptions).bindPopup(popupContent);
      marker.addTo(markerLayer);
    }
  }
}

// Handle popup clicks (delegated)
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('tune-btn')) {
    const freq = e.target.dataset.freq;
    const mode = e.target.dataset.mode;
    window.api.tune(freq, mode);
  }
  if (e.target.classList.contains('popup-qrz')) {
    e.preventDefault();
    const call = e.target.dataset.call;
    window.api.openExternal(`https://www.qrz.com/db/${encodeURIComponent(call)}`);
  }
});

// --- Scan ---
function getScanList() {
  const filtered = sortSpots(getFiltered());
  return filtered.filter((s) => !scanSkipped.has(s.frequency));
}

function startScan() {
  const list = getScanList();
  if (list.length === 0) return;
  scanning = true;
  scanIndex = 0;
  scanBtn.textContent = 'Stop';
  scanBtn.classList.add('scan-active');
  scanStep();
}

function stopScan() {
  scanning = false;
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  scanBtn.textContent = 'Scan';
  scanBtn.classList.remove('scan-active');
  render(); // clear highlight
}

function scanStep() {
  if (!scanning) return;
  const list = getScanList();
  if (list.length === 0) { stopScan(); return; }
  if (scanIndex >= list.length) scanIndex = 0;

  const spot = list[scanIndex];
  window.api.tune(spot.frequency, spot.mode);
  render(); // update highlight

  scanTimer = setTimeout(() => {
    scanIndex++;
    scanStep();
  }, scanDwell * 1000);
}

scanBtn.addEventListener('click', () => {
  if (scanning) { stopScan(); } else { startScan(); }
});

// --- View Toggle ---
function setView(view) {
  currentView = view;

  if (view === 'table') {
    spotsTable.classList.remove('hidden');
    mapDiv.classList.add('hidden');
    viewTableBtn.classList.add('active');
    viewMapBtn.classList.remove('active');
  } else {
    spotsTable.classList.add('hidden');
    noSpots.classList.add('hidden');
    mapDiv.classList.remove('hidden');
    viewTableBtn.classList.remove('active');
    viewMapBtn.classList.add('active');

    if (!map) {
      initMap();
    }
    // Leaflet needs a size recalc when container becomes visible
    setTimeout(() => map.invalidateSize(), 0);
  }

  render();
}

viewTableBtn.addEventListener('click', () => setView('table'));
viewMapBtn.addEventListener('click', () => setView('map'));

// --- Rendering ---
function render() {
  const filtered = sortSpots(getFiltered());

  spotCountEl.textContent = `${filtered.length} spots`;

  if (currentView === 'table') {
    tbody.innerHTML = '';

    if (filtered.length === 0) {
      noSpots.classList.remove('hidden');
    } else {
      noSpots.classList.add('hidden');
    }

    // Determine which spot is currently being scanned
    const scanList = scanning ? getScanList() : [];
    const scanSpot = scanning && scanList.length > 0 ? scanList[scanIndex % scanList.length] : null;

    for (const s of filtered) {
      const tr = document.createElement('tr');
      const isSkipped = scanSkipped.has(s.frequency);

      // Source color-coding
      if (s.source === 'pota') tr.classList.add('spot-pota');
      if (s.source === 'sota') tr.classList.add('spot-sota');

      // Highlight the row currently being scanned
      if (scanSpot && s.frequency === scanSpot.frequency) {
        tr.classList.add('scan-highlight');
      }
      if (isSkipped) {
        tr.classList.add('scan-skipped');
      }

      tr.addEventListener('click', () => {
        if (scanning) stopScan(); // clicking a row stops scan
        window.api.tune(s.frequency, s.mode);
      });

      // Callsign cell — clickable link to QRZ
      const isWatched = watchlist.has(s.callsign.toUpperCase());
      const callTd = document.createElement('td');
      if (isWatched) {
        const star = document.createElement('span');
        star.textContent = '\u2B50 ';
        star.className = 'watchlist-star';
        callTd.appendChild(star);
      }
      const callLink = document.createElement('a');
      callLink.textContent = s.callsign;
      callLink.href = '#';
      callLink.className = 'qrz-link';
      callLink.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        window.api.openExternal(`https://www.qrz.com/db/${encodeURIComponent(s.callsign)}`);
      });
      callTd.appendChild(callLink);
      tr.appendChild(callTd);

      // Frequency cell — styled as clickable link
      const freqTd = document.createElement('td');
      const freqLink = document.createElement('span');
      freqLink.textContent = parseFloat(s.frequency).toFixed(1);
      freqLink.className = 'freq-link';
      freqTd.appendChild(freqLink);
      tr.appendChild(freqTd);

      const cells = [
        s.mode,
        s.reference,
        s.parkName,
        s.locationDesc,
        formatDistance(s.distance),
        formatAge(s.spotTime),
      ];

      for (const val of cells) {
        const td = document.createElement('td');
        td.textContent = val;
        tr.appendChild(td);
      }

      // Skip button (last cell)
      const skipTd = document.createElement('td');
      skipTd.className = 'skip-cell';
      const skipButton = document.createElement('button');
      skipButton.className = 'skip-btn' + (isSkipped ? ' skipped' : '');
      skipButton.textContent = isSkipped ? 'Unskip' : 'Skip';
      skipButton.title = isSkipped ? 'Include in scan' : 'Skip during scan';
      skipButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isSkipped) {
          scanSkipped.delete(s.frequency);
        } else {
          scanSkipped.add(s.frequency);
        }
        render();
      });
      skipTd.appendChild(skipButton);
      tr.appendChild(skipTd);

      tbody.appendChild(tr);
    }

    // Update sort indicators
    document.querySelectorAll('thead th').forEach((th) => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.sort === sortCol) {
        th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
      }
    });
  } else {
    updateMapMarkers(filtered);
  }
}

function formatAge(isoStr) {
  if (!isoStr) return '';
  try {
    // POTA API returns UTC times without a Z suffix — append it
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

// --- Events ---
bandFilter.addEventListener('change', () => { if (scanning) stopScan(); render(); });
modeFilter.addEventListener('change', () => { if (scanning) stopScan(); render(); });
refreshBtn.addEventListener('click', () => window.api.refresh());

// Column sorting
document.querySelectorAll('thead th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortCol === col) {
      sortAsc = !sortAsc;
    } else {
      sortCol = col;
      sortAsc = col === 'distance';
    }
    render();
  });
});

// Settings dialog
settingsBtn.addEventListener('click', async () => {
  const s = await window.api.getSettings();
  setGrid.value = s.grid || '';
  setDistUnit.value = s.distUnit || 'mi';
  setScanDwell.value = s.scanDwell || 7;
  setWatchlist.value = s.watchlist || '';
  setEnablePota.checked = s.enablePota !== false;
  setEnableSota.checked = s.enableSota === true;
  await populateCatOptions(s.catTarget);
  settingsDialog.showModal();
});

settingsCancel.addEventListener('click', () => settingsDialog.close());

settingsSave.addEventListener('click', async () => {
  const watchlistRaw = setWatchlist.value.trim();
  const dwellVal = parseInt(setScanDwell.value, 10) || 7;
  const potaEnabled = setEnablePota.checked;
  const sotaEnabled = setEnableSota.checked;

  // Apply CAT selection
  if (selectedCatValue) {
    window.api.connectCat(JSON.parse(selectedCatValue));
  }

  await window.api.saveSettings({
    grid: setGrid.value.trim() || 'FN20jb',
    distUnit: setDistUnit.value,
    scanDwell: dwellVal,
    watchlist: watchlistRaw,
    enablePota: potaEnabled,
    enableSota: sotaEnabled,
  });
  distUnit = setDistUnit.value;
  scanDwell = dwellVal;
  watchlist = parseWatchlist(watchlistRaw);
  enablePota = potaEnabled;
  enableSota = sotaEnabled;
  updateHeaders();
  settingsDialog.close();
  render();
  // Update home marker if map is initialized
  if (map) updateHomeMarker();
});

// --- IPC listeners ---
window.api.onSpots((spots) => {
  allSpots = spots;
  lastRefreshEl.textContent = `Updated ${new Date().toISOString().slice(11, 19)}z`;
  render();
});

window.api.onSpotsError((msg) => {
  lastRefreshEl.textContent = `Error: ${msg}`;
});

window.api.onCatStatus(({ connected }) => {
  catStatusEl.textContent = connected ? 'CAT: Connected' : 'CAT: Disconnected';
  catStatusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
});

// Init
loadPrefs().then(() => {
  render();
});
initColumnResizing();
