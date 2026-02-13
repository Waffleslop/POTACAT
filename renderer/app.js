// Renderer process — UI logic
// Leaflet is loaded via <script> tag in index.html and exposes window.L

let allSpots = [];
let sortCol = 'distance';
let sortAsc = true;
let currentView = 'table'; // 'table', 'map', or 'dxcc'

// User preferences (loaded from settings)
let distUnit = 'mi';    // 'mi' or 'km'
let watchlist = new Set(); // uppercase callsigns
let maxAgeMin = 5;       // max spot age in minutes
let scanDwell = 7;       // seconds per frequency during scan
let enablePota = true;
let enableSota = false;
let enableDxcc = false;
let enableCluster = false;
let dxccData = null;  // { entities: [...] } from main process

// --- Scan state ---
// --- Radio frequency tracking ---
let radioFreqKhz = null;

let scanning = false;
let scanTimer = null;
let scanIndex = 0;
let scanSkipped = new Set(); // frequencies to skip (as strings)

const MI_TO_KM = 1.60934;

const bandFilterEl = document.getElementById('band-filter');
const modeFilterEl = document.getElementById('mode-filter');
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
const setMaxAge = document.getElementById('set-max-age');
const setScanDwell = document.getElementById('set-scan-dwell');
const setWatchlist = document.getElementById('set-watchlist');
const setEnablePota = document.getElementById('set-enable-pota');
const setEnableSota = document.getElementById('set-enable-sota');
const scanBtn = document.getElementById('scan-btn');
const hamlibConfig = document.getElementById('hamlib-config');
const flexConfig = document.getElementById('flex-config');
const setFlexSlice = document.getElementById('set-flex-slice');
const radioTypeBtns = document.querySelectorAll('input[name="radio-type"]');
const setRigModel = document.getElementById('set-rig-model');
const setRigPort = document.getElementById('set-rig-port');
const setRigBaud = document.getElementById('set-rig-baud');
const spotsTable = document.getElementById('spots-table');
const mapDiv = document.getElementById('map');
const viewTableBtn = document.getElementById('view-table-btn');
const viewMapBtn = document.getElementById('view-map-btn');
const viewDxccBtn = document.getElementById('view-dxcc-btn');
const dxccView = document.getElementById('dxcc-view');
const dxccMatrixBody = document.getElementById('dxcc-matrix-body');
const dxccCountEl = document.getElementById('dxcc-count');
const dxccPlaceholder = document.getElementById('dxcc-placeholder');
const dxccModeFilterEl = document.getElementById('dxcc-mode-filter');
const setEnableCluster = document.getElementById('set-enable-cluster');
const setMyCallsign = document.getElementById('set-my-callsign');
const setClusterHost = document.getElementById('set-cluster-host');
const setClusterPort = document.getElementById('set-cluster-port');
const clusterConfig = document.getElementById('cluster-config');
const clusterStatusEl = document.getElementById('cluster-status');
const setEnableDxcc = document.getElementById('set-enable-dxcc');
const setAdifPath = document.getElementById('set-adif-path');
const adifBrowseBtn = document.getElementById('adif-browse-btn');
const adifPicker = document.getElementById('adif-picker');
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
  enableDxcc = settings.enableDxcc === true;  // default false
  enableCluster = settings.enableCluster === true; // default false
  updateClusterStatusVisibility();
  updateDxccButton();
  // maxAgeMin: prefer localStorage (last-used filter) over settings.json
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY));
    if (saved && saved.maxAgeMin) { maxAgeMin = saved.maxAgeMin; }
    else { maxAgeMin = parseInt(settings.maxAgeMin, 10) || 5; }
  } catch { maxAgeMin = parseInt(settings.maxAgeMin, 10) || 5; }
  updateHeaders();
}

function updateHeaders() {
  distHeader.childNodes[0].textContent = distUnit === 'km' ? 'Dist (km)' : 'Dist (mi)';
}

// --- Radio config (inside Settings) ---
let hamlibFieldsLoaded = false;

function getSelectedRadioType() {
  const checked = document.querySelector('input[name="radio-type"]:checked');
  return checked ? checked.value : 'none';
}

function setRadioType(value) {
  const btn = document.querySelector(`input[name="radio-type"][value="${value}"]`);
  if (btn) btn.checked = true;
}

function updateRadioSubPanels() {
  const type = getSelectedRadioType();
  flexConfig.classList.toggle('hidden', type !== 'flex');
  hamlibConfig.classList.toggle('hidden', type !== 'hamlib');
  if (type === 'hamlib' && !hamlibFieldsLoaded) {
    hamlibFieldsLoaded = true;
    populateHamlibFields(null);
  }
}

async function populateRadioSection(currentTarget) {
  hamlibFieldsLoaded = false;
  if (!currentTarget) {
    setRadioType('none');
  } else if (currentTarget.type === 'tcp') {
    setRadioType('flex');
    setFlexSlice.value = String(currentTarget.port);
  } else if (currentTarget.type === 'rigctld') {
    setRadioType('hamlib');
    hamlibFieldsLoaded = true;
    await populateHamlibFields(currentTarget);
  } else {
    setRadioType('none');
  }
  updateRadioSubPanels();
}

async function populateHamlibFields(savedTarget) {
  // Populate rig model dropdown
  setRigModel.innerHTML = '<option value="">Loading rigs...</option>';
  const rigs = await window.api.listRigs();
  setRigModel.innerHTML = '';
  if (rigs.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No rigs found — is Hamlib installed?';
    setRigModel.appendChild(opt);
  } else {
    for (const rig of rigs) {
      const opt = document.createElement('option');
      opt.value = rig.id;
      opt.textContent = `${rig.mfg} ${rig.model}`;
      if (savedTarget && savedTarget.rigId === rig.id) opt.selected = true;
      setRigModel.appendChild(opt);
    }
  }

  // Populate serial port dropdown
  const ports = await window.api.listPorts();
  setRigPort.innerHTML = '';
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = `${p.path} — ${p.friendlyName}`;
    if (savedTarget && savedTarget.serialPort === p.path) opt.selected = true;
    setRigPort.appendChild(opt);
  }

  // Restore baud rate
  if (savedTarget && savedTarget.baudRate) {
    setRigBaud.value = String(savedTarget.baudRate);
  }
}

// --- Multi-select dropdowns ---
function initMultiDropdown(container, label) {
  const btn = container.querySelector('.multi-dropdown-btn');
  const menu = container.querySelector('.multi-dropdown-menu');
  const textEl = container.querySelector('.multi-dropdown-text');
  const allCb = menu.querySelector('input[value="all"]');
  const itemCbs = [...menu.querySelectorAll('input:not([value="all"])')];

  function updateText() {
    const checked = itemCbs.filter((cb) => cb.checked);
    if (allCb.checked || checked.length === 0) {
      textEl.textContent = 'All';
    } else if (checked.length <= 3) {
      textEl.textContent = checked.map((cb) => cb.value).join(', ');
    } else {
      textEl.textContent = checked.length + ' selected';
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close any other open dropdowns
    document.querySelectorAll('.multi-dropdown.open').forEach((d) => {
      if (d !== container) d.classList.remove('open');
    });
    container.classList.toggle('open');
  });

  menu.addEventListener('click', (e) => e.stopPropagation());

  menu.addEventListener('change', (e) => {
    if (scanning) stopScan();
    const cb = e.target;
    if (cb.value === 'all') {
      const nowChecked = cb.checked;
      itemCbs.forEach((c) => { c.checked = nowChecked; });
    } else {
      // Uncheck "All" when toggling individual items
      allCb.checked = false;
      // If nothing checked, check "All"
      if (itemCbs.every((c) => !c.checked)) allCb.checked = true;
      // If everything checked, switch to "All"
      if (itemCbs.every((c) => c.checked)) {
        allCb.checked = true;
        itemCbs.forEach((c) => { c.checked = false; });
      }
    }
    updateText();
    render();
    if (typeof saveFilters === 'function') saveFilters();
  });

  updateText();
}

function getDropdownValues(container) {
  const allCb = container.querySelector('input[value="all"]');
  if (allCb.checked) return null;
  const checked = [...container.querySelectorAll('input:not([value="all"]):checked')];
  if (checked.length === 0) return null;
  return new Set(checked.map((cb) => cb.value));
}

initMultiDropdown(bandFilterEl, 'Band');
initMultiDropdown(modeFilterEl, 'Mode');

// DXCC mode filter — re-render matrix on change instead of spot table
function initDxccModeFilter() {
  const btn = dxccModeFilterEl.querySelector('.multi-dropdown-btn');
  const menu = dxccModeFilterEl.querySelector('.multi-dropdown-menu');
  const textEl = dxccModeFilterEl.querySelector('.multi-dropdown-text');
  const allCb = menu.querySelector('input[value="all"]');
  const itemCbs = [...menu.querySelectorAll('input:not([value="all"])')];

  function updateText() {
    const checked = itemCbs.filter((cb) => cb.checked);
    if (allCb.checked || checked.length === 0) {
      textEl.textContent = 'All';
    } else if (checked.length <= 3) {
      textEl.textContent = checked.map((cb) => cb.value).join(', ');
    } else {
      textEl.textContent = checked.length + ' selected';
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.multi-dropdown.open').forEach((d) => {
      if (d !== dxccModeFilterEl) d.classList.remove('open');
    });
    dxccModeFilterEl.classList.toggle('open');
  });

  menu.addEventListener('click', (e) => e.stopPropagation());

  menu.addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.value === 'all') {
      const nowChecked = cb.checked;
      itemCbs.forEach((c) => { c.checked = nowChecked; });
    } else {
      allCb.checked = false;
      if (itemCbs.every((c) => !c.checked)) allCb.checked = true;
      if (itemCbs.every((c) => c.checked)) {
        allCb.checked = true;
        itemCbs.forEach((c) => { c.checked = false; });
      }
    }
    updateText();
    if (currentView === 'dxcc') renderDxccMatrix();
  });

  updateText();
}
initDxccModeFilter();

function getDxccModeFilter() {
  return getDropdownValues(dxccModeFilterEl);
}

function updateDxccButton() {
  if (enableDxcc) {
    viewDxccBtn.classList.remove('hidden');
  } else {
    viewDxccBtn.classList.add('hidden');
    // Fall back to table if currently on DXCC view
    if (currentView === 'dxcc') setView('table');
  }
}

function updateClusterStatusVisibility() {
  if (enableCluster) {
    clusterStatusEl.classList.remove('hidden');
  } else {
    clusterStatusEl.classList.add('hidden');
  }
}

// --- Persist filters to localStorage ---
const FILTERS_KEY = 'pota-cat-filters';

function saveFilters() {
  const bands = getDropdownValues(bandFilterEl);
  const modes = getDropdownValues(modeFilterEl);
  const data = {
    bands: bands ? [...bands] : null,
    modes: modes ? [...modes] : null,
    maxAgeMin,
  };
  localStorage.setItem(FILTERS_KEY, JSON.stringify(data));
}

function restoreFilters() {
  try {
    const data = JSON.parse(localStorage.getItem(FILTERS_KEY));
    if (!data) return;

    // Restore band checkboxes
    if (data.bands) {
      const bandSet = new Set(data.bands);
      bandFilterEl.querySelector('input[value="all"]').checked = false;
      bandFilterEl.querySelectorAll('input:not([value="all"])').forEach((cb) => {
        cb.checked = bandSet.has(cb.value);
      });
    } else {
      bandFilterEl.querySelector('input[value="all"]').checked = true;
      bandFilterEl.querySelectorAll('input:not([value="all"])').forEach((cb) => { cb.checked = false; });
    }

    // Restore mode checkboxes
    if (data.modes) {
      const modeSet = new Set(data.modes);
      modeFilterEl.querySelector('input[value="all"]').checked = false;
      modeFilterEl.querySelectorAll('input:not([value="all"])').forEach((cb) => {
        cb.checked = modeSet.has(cb.value);
      });
    } else {
      modeFilterEl.querySelector('input[value="all"]').checked = true;
      modeFilterEl.querySelectorAll('input:not([value="all"])').forEach((cb) => { cb.checked = false; });
    }

    // Restore max age
    if (data.maxAgeMin) maxAgeMin = data.maxAgeMin;

    // Update dropdown button text
    [bandFilterEl, modeFilterEl].forEach((container) => {
      const textEl = container.querySelector('.multi-dropdown-text');
      const allCb = container.querySelector('input[value="all"]');
      const itemCbs = [...container.querySelectorAll('input:not([value="all"])')];
      const checked = itemCbs.filter((cb) => cb.checked);
      if (allCb.checked || checked.length === 0) {
        textEl.textContent = 'All';
      } else if (checked.length <= 3) {
        textEl.textContent = checked.map((cb) => cb.value).join(', ');
      } else {
        textEl.textContent = checked.length + ' selected';
      }
    });
  } catch { /* ignore corrupt data */ }
}

restoreFilters();

// Toggle radio sub-panels when radio type changes
radioTypeBtns.forEach((btn) => {
  btn.addEventListener('change', () => updateRadioSubPanels());
});

// Cluster checkbox toggles cluster config visibility
setEnableCluster.addEventListener('change', () => {
  clusterConfig.classList.toggle('hidden', !setEnableCluster.checked);
});

// DXCC checkbox toggles ADIF picker visibility
setEnableDxcc.addEventListener('change', () => {
  adifPicker.classList.toggle('hidden', !setEnableDxcc.checked);
});

// ADIF file browser
adifBrowseBtn.addEventListener('click', async () => {
  const filePath = await window.api.chooseAdifFile();
  if (filePath) {
    setAdifPath.value = filePath;
  }
});

// Close dropdowns when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.multi-dropdown.open').forEach((d) => d.classList.remove('open'));
});

// --- Filtering ---
function modeMatches(spotMode, selectedModes) {
  if (!selectedModes) return true;
  if (selectedModes.has(spotMode)) return true;
  if (selectedModes.has('SSB') && (spotMode === 'USB' || spotMode === 'LSB')) return true;
  return false;
}

function spotAgeSecs(spotTime) {
  if (!spotTime) return Infinity;
  try {
    const d = new Date(spotTime.endsWith('Z') ? spotTime : spotTime + 'Z');
    return Math.max(0, (Date.now() - d.getTime()) / 1000);
  } catch { return Infinity; }
}

function getFiltered() {
  const bands = getDropdownValues(bandFilterEl);
  const modes = getDropdownValues(modeFilterEl);
  const maxAgeSecs = maxAgeMin * 60;
  return allSpots.filter((s) => {
    if (s.source === 'pota' && !enablePota) return false;
    if (s.source === 'sota' && !enableSota) return false;
    if (s.source === 'dxc' && !enableCluster) return false;
    if (bands && !bands.has(s.band)) return false;
    if (!modeMatches(s.mode, modes)) return false;
    if (spotAgeSecs(s.spotTime) > maxAgeSecs) return false;
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

  // Preserve open popup across re-render
  let openPopupCallsign = null;
  let openPopupLatLng = null;
  markerLayer.eachLayer((layer) => {
    if (layer.getPopup && layer.getPopup() && layer.getPopup().isOpen()) {
      openPopupCallsign = layer._spotCallsign || null;
      openPopupLatLng = layer.getLatLng();
    }
  });

  markerLayer.clearLayers();

  const unit = distUnit === 'km' ? 'km' : 'mi';

  for (const s of filtered) {
    if (s.lat == null || s.lon == null) continue;

    const distStr = s.distance != null ? formatDistance(s.distance) + ' ' + unit : '';
    const watched = watchlist.has(s.callsign.toUpperCase());

    const sourceLabel = (s.source || 'pota').toUpperCase();
    const sourceColor = s.source === 'sota' ? '#f0a500' : s.source === 'dxc' ? '#e040fb' : '#4ecca3';
    const popupContent = `
      <b>${watched ? '\u2B50 ' : ''}<a href="#" class="popup-qrz" data-call="${s.callsign}">${s.callsign}</a></b> <span style="color:${sourceColor};font-size:11px;">[${sourceLabel}]</span><br>
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
      marker._spotCallsign = s.callsign;
      marker.addTo(markerLayer);

      // Re-open popup if it was open before re-render
      if (openPopupCallsign && s.callsign === openPopupCallsign && openPopupLatLng &&
          Math.abs(marker.getLatLng().lng - openPopupLatLng.lng) < 1) {
        marker.openPopup();
      }
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

  // Hide all views
  spotsTable.classList.add('hidden');
  noSpots.classList.add('hidden');
  mapDiv.classList.add('hidden');
  dxccView.classList.add('hidden');

  // Deactivate all view buttons
  viewTableBtn.classList.remove('active');
  viewMapBtn.classList.remove('active');
  viewDxccBtn.classList.remove('active');

  if (view === 'table') {
    spotsTable.classList.remove('hidden');
    viewTableBtn.classList.add('active');
    render();
  } else if (view === 'map') {
    mapDiv.classList.remove('hidden');
    viewMapBtn.classList.add('active');
    if (!map) {
      initMap();
    }
    setTimeout(() => map.invalidateSize(), 0);
    render();
  } else if (view === 'dxcc') {
    dxccView.classList.remove('hidden');
    viewDxccBtn.classList.add('active');
    renderDxccMatrix();
  }
}

viewTableBtn.addEventListener('click', () => setView('table'));
viewMapBtn.addEventListener('click', () => setView('map'));
viewDxccBtn.addEventListener('click', () => setView('dxcc'));

// --- DXCC Matrix Rendering ---
const DXCC_BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];

function renderDxccMatrix() {
  if (!dxccData || !dxccData.entities) {
    dxccMatrixBody.innerHTML = '';
    dxccPlaceholder.classList.remove('hidden');
    dxccCountEl.textContent = '0 / 0';
    return;
  }

  dxccPlaceholder.classList.add('hidden');
  const modeFilter = getDxccModeFilter(); // null = all modes

  let confirmedCount = 0;
  const rows = [];

  for (const ent of dxccData.entities) {
    let hasAny = false;
    const bandCells = [];

    for (const band of DXCC_BANDS) {
      const modes = ent.confirmed[band];
      let confirmed = false;
      if (modes && modes.length > 0) {
        if (!modeFilter) {
          confirmed = true;
        } else {
          confirmed = modes.some((m) => modeFilter.has(m));
        }
      }
      if (confirmed) hasAny = true;
      bandCells.push(confirmed);
    }

    if (hasAny) confirmedCount++;
    rows.push({ ent, bandCells, hasAny });
  }

  dxccCountEl.textContent = `${confirmedCount} / ${dxccData.entities.length}`;

  // Build table rows
  const fragment = document.createDocumentFragment();
  for (const { ent, bandCells, hasAny } of rows) {
    const tr = document.createElement('tr');
    if (!hasAny) tr.classList.add('dxcc-unworked');

    // Entity name
    const nameTd = document.createElement('td');
    nameTd.textContent = ent.name;
    nameTd.title = ent.prefix;
    tr.appendChild(nameTd);

    // Continent
    const contTd = document.createElement('td');
    contTd.textContent = ent.continent;
    tr.appendChild(contTd);

    // Band cells
    for (const confirmed of bandCells) {
      const td = document.createElement('td');
      if (confirmed) {
        td.textContent = '\u2713';
        td.classList.add('dxcc-confirmed');
      }
      tr.appendChild(td);
    }

    fragment.appendChild(tr);
  }

  dxccMatrixBody.innerHTML = '';
  dxccMatrixBody.appendChild(fragment);
}

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
      if (s.source === 'dxc') tr.classList.add('spot-dxc');

      // Highlight the row currently being scanned
      if (scanSpot && s.frequency === scanSpot.frequency) {
        tr.classList.add('scan-highlight');
      }
      // Highlight row matching radio's current frequency
      if (radioFreqKhz !== null && Math.abs(parseFloat(s.frequency) - radioFreqKhz) < 1) {
        tr.classList.add('on-freq');
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
// Band/mode dropdowns already wired via initMultiDropdown()
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
  setMaxAge.value = s.maxAgeMin || 5;
  setScanDwell.value = s.scanDwell || 7;
  setWatchlist.value = s.watchlist || '';
  setEnablePota.checked = s.enablePota !== false;
  setEnableSota.checked = s.enableSota === true;
  setEnableCluster.checked = s.enableCluster === true;
  setMyCallsign.value = s.myCallsign || '';
  setClusterHost.value = s.clusterHost || 'w3lpl.net';
  setClusterPort.value = s.clusterPort || 7373;
  clusterConfig.classList.toggle('hidden', !s.enableCluster);
  setEnableDxcc.checked = s.enableDxcc === true;
  setAdifPath.value = s.adifPath || '';
  adifPicker.classList.toggle('hidden', !s.enableDxcc);
  await populateRadioSection(s.catTarget);
  settingsDialog.showModal();
});

settingsCancel.addEventListener('click', () => settingsDialog.close());

settingsSave.addEventListener('click', async () => {
  const watchlistRaw = setWatchlist.value.trim();
  const maxAgeVal = parseInt(setMaxAge.value, 10) || 5;
  const dwellVal = parseInt(setScanDwell.value, 10) || 7;
  const potaEnabled = setEnablePota.checked;
  const sotaEnabled = setEnableSota.checked;
  const clusterEnabled = setEnableCluster.checked;
  const myCallsign = setMyCallsign.value.trim().toUpperCase();
  const clusterHost = setClusterHost.value.trim() || 'w3lpl.net';
  const clusterPort = parseInt(setClusterPort.value, 10) || 7373;
  const dxccEnabled = setEnableDxcc.checked;
  const adifPath = setAdifPath.value.trim() || '';

  // Apply radio selection
  const radioType = getSelectedRadioType();
  if (radioType === 'flex') {
    window.api.connectCat({ type: 'tcp', host: '127.0.0.1', port: parseInt(setFlexSlice.value, 10) });
  } else if (radioType === 'hamlib') {
    window.api.connectCat({
      type: 'rigctld',
      rigId: parseInt(setRigModel.value, 10),
      serialPort: setRigPort.value,
      baudRate: parseInt(setRigBaud.value, 10),
    });
  } else {
    window.api.connectCat(null);
  }

  await window.api.saveSettings({
    grid: setGrid.value.trim() || 'FN20jb',
    distUnit: setDistUnit.value,
    maxAgeMin: maxAgeVal,
    scanDwell: dwellVal,
    watchlist: watchlistRaw,
    enablePota: potaEnabled,
    enableSota: sotaEnabled,
    enableCluster: clusterEnabled,
    myCallsign: myCallsign,
    clusterHost: clusterHost,
    clusterPort: clusterPort,
    enableDxcc: dxccEnabled,
    adifPath: adifPath,
  });
  distUnit = setDistUnit.value;
  maxAgeMin = maxAgeVal;
  scanDwell = dwellVal;
  watchlist = parseWatchlist(watchlistRaw);
  enablePota = potaEnabled;
  enableSota = sotaEnabled;
  enableCluster = clusterEnabled;
  updateClusterStatusVisibility();
  enableDxcc = dxccEnabled;
  updateDxccButton();
  updateHeaders();
  saveFilters();
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

// --- DXCC data listener ---
window.api.onDxccData((data) => {
  dxccData = data;
  if (currentView === 'dxcc') renderDxccMatrix();
});

// --- Cluster status listener ---
window.api.onClusterStatus(({ connected }) => {
  clusterStatusEl.textContent = connected ? 'Cluster: Connected' : 'Cluster: Disconnected';
  clusterStatusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
  if (enableCluster) clusterStatusEl.classList.remove('hidden');
});

// --- Radio frequency tracking ---
window.api.onCatFrequency((hz) => {
  const newKhz = Math.round(hz / 1000);
  if (newKhz === radioFreqKhz) return;
  radioFreqKhz = newKhz;
  if (currentView === 'table') render();
});

// --- Settings footer links ---
document.getElementById('bio-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://caseystanton.com/?utm_source=potacat&utm_medium=bio');
});
document.getElementById('issues-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://github.com/Waffleslop/POTA-CAT/issues');
});
document.getElementById('hamlib-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://hamlib.github.io/');
});

// --- Titlebar controls ---
document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
document.getElementById('tb-close').addEventListener('click', () => window.api.close());

// --- Welcome dialog (first run) ---
const welcomeDialog = document.getElementById('welcome-dialog');
const welcomeGridInput = document.getElementById('welcome-grid');
const welcomeChoices = document.querySelectorAll('.welcome-choice');
let welcomeRadioType = null;

welcomeChoices.forEach((btn) => {
  btn.addEventListener('click', () => {
    welcomeChoices.forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    welcomeRadioType = btn.dataset.radio;
    finishWelcome();
  });
});

async function finishWelcome() {
  const grid = welcomeGridInput.value.trim() || 'FN20jb';
  let catTarget = null;

  if (welcomeRadioType === 'flex') {
    catTarget = { type: 'tcp', host: '127.0.0.1', port: 5002 };
  }
  // hamlib: save null for now — user will configure details in Settings
  // none: catTarget stays null

  await window.api.saveSettings({
    grid,
    catTarget,
    firstRun: false,
    distUnit: 'mi',
    maxAgeMin: 5,
    scanDwell: 7,
    enablePota: true,
    enableSota: false,
  });

  welcomeDialog.close();

  // If they chose hamlib, open full settings so they can pick rig/port/baud
  if (welcomeRadioType === 'hamlib') {
    settingsBtn.click();
  }
}

async function checkFirstRun() {
  const s = await window.api.getSettings();
  if (s.firstRun) {
    welcomeDialog.showModal();
  }
}

// Init
loadPrefs().then(() => {
  render();
  checkFirstRun();
});
initColumnResizing();
