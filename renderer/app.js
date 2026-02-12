// Renderer process — UI logic
// Leaflet is loaded via <script> tag in index.html and exposes window.L

let allSpots = [];
let sortCol = 'distance';
let sortAsc = true;
let currentView = 'table'; // 'table' or 'map'

// User preferences (loaded from settings)
let distUnit = 'mi';    // 'mi' or 'km'

const MI_TO_KM = 1.60934;

const bandFilter = document.getElementById('band-filter');
const modeFilter = document.getElementById('mode-filter');
const catSelector = document.getElementById('cat-selector');
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
async function loadPrefs() {
  const settings = await window.api.getSettings();
  distUnit = settings.distUnit || 'mi';
  updateHeaders();
}

function updateHeaders() {
  distHeader.childNodes[0].textContent = distUnit === 'km' ? 'Dist (km)' : 'Dist (mi)';
}

// --- CAT selector ---
// Known SmartSDR CAT TCP ports (Slice A=5002, B=5003, etc.)
const TCP_PORTS = [
  { label: 'Slice A - TCP 5002', type: 'tcp', host: '127.0.0.1', port: 5002 },
  { label: 'Slice B - TCP 5003', type: 'tcp', host: '127.0.0.1', port: 5003 },
  { label: 'Slice C - TCP 5004', type: 'tcp', host: '127.0.0.1', port: 5004 },
  { label: 'Slice D - TCP 5005', type: 'tcp', host: '127.0.0.1', port: 5005 },
];

async function populateCatSelector() {
  const settings = await window.api.getSettings();
  const ports = await window.api.listPorts();

  // Clear existing options except "None"
  while (catSelector.options.length > 1) catSelector.remove(1);

  // Add TCP options
  for (const tcp of TCP_PORTS) {
    const opt = document.createElement('option');
    opt.value = JSON.stringify({ type: tcp.type, host: tcp.host, port: tcp.port });
    opt.textContent = tcp.label;
    catSelector.appendChild(opt);
  }

  // Add detected COM ports
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = JSON.stringify({ type: 'serial', path: p.path });
    opt.textContent = `${p.path} (${p.friendlyName})`;
    catSelector.appendChild(opt);
  }

  // Select the current target
  if (settings.catTarget) {
    const targetStr = JSON.stringify(settings.catTarget);
    for (const opt of catSelector.options) {
      if (opt.value === targetStr) {
        opt.selected = true;
        break;
      }
    }
  }
}

catSelector.addEventListener('change', () => {
  const val = catSelector.value;
  if (!val) return;
  const target = JSON.parse(val);
  window.api.connectCat(target);
});

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
const COL_WIDTHS_KEY = 'pota-cat-col-pct';
// Callsign, Freq, Mode, Ref, Park Name, State, Dist, Age
const DEFAULT_COL_PCT = [10, 10, 6, 9, 30, 12, 8, 7];

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

    const popupContent = `
      <b><a href="#" class="popup-qrz" data-call="${s.callsign}">${s.callsign}</a></b><br>
      ${parseFloat(s.frequency).toFixed(1)} kHz &middot; ${s.mode}<br>
      <b>${s.reference}</b> ${s.parkName}<br>
      ${distStr}<br>
      <button class="tune-btn" data-freq="${s.frequency}" data-mode="${s.mode}">Tune</button>
    `;

    // Plot marker at canonical position and one world-copy in each direction
    for (const offset of [-360, 0, 360]) {
      const marker = L.marker([s.lat, s.lon + offset]).bindPopup(popupContent);
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

    for (const s of filtered) {
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => {
        window.api.tune(s.frequency, s.mode);
      });

      // Callsign cell — clickable link to QRZ
      const callTd = document.createElement('td');
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
    const d = new Date(isoStr);
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
bandFilter.addEventListener('change', render);
modeFilter.addEventListener('change', render);
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
  settingsDialog.showModal();
});

settingsCancel.addEventListener('click', () => settingsDialog.close());

settingsSave.addEventListener('click', async () => {
  await window.api.saveSettings({
    grid: setGrid.value.trim() || 'FN20jb',
    distUnit: setDistUnit.value,
  });
  distUnit = setDistUnit.value;
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
populateCatSelector();
initColumnResizing();
