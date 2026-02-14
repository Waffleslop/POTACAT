// Renderer process — UI logic
// Leaflet is loaded via <script> tag in index.html and exposes window.L

let allSpots = [];
let sortCol = 'distance';
let sortAsc = true;
let currentView = 'table'; // 'table', 'map', 'dxcc', or 'rbn'

// User preferences (loaded from settings)
let distUnit = 'mi';    // 'mi' or 'km'
let watchlist = new Set(); // uppercase callsigns
let maxAgeMin = 5;       // max spot age in minutes
let scanDwell = 7;       // seconds per frequency during scan
let enablePota = true;
let enableSota = false;
let enableDxcc = false;
let enableCluster = false;
let enableRbn = false;
let enableSolar = false;
let enableBandActivity = false;
let licenseClass = 'none';
let hideOutOfBand = false;
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
const setCwXit = document.getElementById('set-cw-xit');
const setNotifyPopup = document.getElementById('set-notify-popup');
const setNotifySound = document.getElementById('set-notify-sound');
const setNotifyTimeout = document.getElementById('set-notify-timeout');
const setLicenseClass = document.getElementById('set-license-class');
const setHideOutOfBand = document.getElementById('set-hide-out-of-band');
const scanBtn = document.getElementById('scan-btn');
const hamlibConfig = document.getElementById('hamlib-config');
const flexConfig = document.getElementById('flex-config');
const setFlexSlice = document.getElementById('set-flex-slice');
const radioTypeBtns = document.querySelectorAll('input[name="radio-type"]');
const setRigModel = document.getElementById('set-rig-model');
const setRigPort = document.getElementById('set-rig-port');
const setRigBaud = document.getElementById('set-rig-baud');
const spotsTable = document.getElementById('spots-table');
const mapContainer = document.getElementById('map-container');
const mapDiv = document.getElementById('map');
const bandActivityBar = document.getElementById('band-activity-bar');
const viewTableBtn = document.getElementById('view-table-btn');
const viewMapBtn = document.getElementById('view-map-btn');
const viewDxccBtn = document.getElementById('view-dxcc-btn');
const dxccView = document.getElementById('dxcc-view');
const dxccMatrixBody = document.getElementById('dxcc-matrix-body');
const dxccCountEl = document.getElementById('dxcc-count');
const dxccPlaceholder = document.getElementById('dxcc-placeholder');
const dxccModeFilterEl = document.getElementById('dxcc-mode-filter');
const setEnableCluster = document.getElementById('set-enable-cluster');
const setEnableRbn = document.getElementById('set-enable-rbn');
const setMyCallsign = document.getElementById('set-my-callsign');
const setClusterHost = document.getElementById('set-cluster-host');
const setClusterPort = document.getElementById('set-cluster-port');
const clusterConfig = document.getElementById('cluster-config');
const rbnConfig = document.getElementById('rbn-config');
const clusterStatusEl = document.getElementById('cluster-status');
const rbnStatusEl = document.getElementById('rbn-status');
const viewRbnBtn = document.getElementById('view-rbn-btn');
const rbnView = document.getElementById('rbn-view');
const rbnCountEl = document.getElementById('rbn-count');
const rbnClearBtn = document.getElementById('rbn-clear-btn');
const rbnLegendEl = document.getElementById('rbn-legend');
const rbnSplitter = document.getElementById('rbn-splitter');
const rbnMapContainer = document.getElementById('rbn-map-container');
const rbnTableContainer = document.getElementById('rbn-table-container');
const rbnTableBody = document.getElementById('rbn-table-body');
const rbnDistHeader = document.getElementById('rbn-dist-header');
const rbnBandFilterEl = document.getElementById('rbn-band-filter');
const rbnMaxAgeInput = document.getElementById('rbn-max-age');
const rbnAgeUnitSelect = document.getElementById('rbn-age-unit');
const setEnableDxcc = document.getElementById('set-enable-dxcc');
const setAdifPath = document.getElementById('set-adif-path');
const adifBrowseBtn = document.getElementById('adif-browse-btn');
const adifPicker = document.getElementById('adif-picker');
const distHeader = document.getElementById('dist-header');
const utcClockEl = document.getElementById('utc-clock');
const sfiStatusEl = document.getElementById('sfi-status');
const kStatusEl = document.getElementById('k-status');
const aStatusEl = document.getElementById('a-status');
const setEnableSolar = document.getElementById('set-enable-solar');
const setEnableBandActivity = document.getElementById('set-enable-band-activity');

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
  enableRbn = settings.enableRbn === true; // default false
  enableSolar = settings.enableSolar === true;   // default false
  enableBandActivity = settings.enableBandActivity === true; // default false
  updateSolarVisibility();
  licenseClass = settings.licenseClass || 'none';
  hideOutOfBand = settings.hideOutOfBand === true;
  updateClusterStatusVisibility();
  updateRbnStatusVisibility();
  updateRbnButton();
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
function initMultiDropdown(container, label, onChange) {
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
    if (onChange) { onChange(); } else { render(); }
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
initMultiDropdown(rbnBandFilterEl, 'Band', rerenderRbn);

// RBN age filter — re-render on change
rbnMaxAgeInput.addEventListener('change', rerenderRbn);
rbnAgeUnitSelect.addEventListener('change', rerenderRbn);

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

function updateRbnStatusVisibility() {
  if (enableRbn) {
    rbnStatusEl.classList.remove('hidden');
  } else {
    rbnStatusEl.classList.add('hidden');
  }
}

function updateRbnButton() {
  if (enableRbn) {
    viewRbnBtn.classList.remove('hidden');
  } else {
    viewRbnBtn.classList.add('hidden');
    if (currentView === 'rbn') setView('table');
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

// RBN checkbox toggles RBN config visibility
setEnableRbn.addEventListener('change', () => {
  rbnConfig.classList.toggle('hidden', !setEnableRbn.checked);
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
    if (hideOutOfBand && isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass)) return false;
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

// Red/grey teardrop pin for out-of-privilege spots
const oopIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#8a8a8a" stroke="#666" stroke-width="1"/>' +
    '<circle cx="12.5" cy="12.5" r="5.5" fill="#ff6b6b" opacity="0.7"/>' +
    '</svg>',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

let map = null;
let markerLayer = null;
let homeMarker = null;
let nightLayer = null;

// RBN state
let rbnSpots = [];
let rbnMap = null;
let rbnMarkerLayer = null;
let rbnHomeMarker = null;
let rbnNightLayer = null;
let rbnHomePos = null; // { lat, lon } for arc drawing

const RBN_BAND_COLORS = {
  '160m': '#ff4444',
  '80m':  '#ff8c00',
  '60m':  '#ffd700',
  '40m':  '#4ecca3',
  '30m':  '#00cccc',
  '20m':  '#4488ff',
  '17m':  '#8844ff',
  '15m':  '#cc44ff',
  '12m':  '#ff44cc',
  '10m':  '#ff4488',
  '6m':   '#e0e0e0',
};

// Compute intermediate points along a great circle arc (geodesic)
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

// Default center: FN20jb (eastern PA) ≈ 40.35°N, 75.58°W
const DEFAULT_CENTER = [40.35, -75.58];

function computeNightPolygon() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400000);
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;

  // Solar declination (degrees)
  const declRad = (-23.44 * Math.PI / 180) * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  // Subsolar longitude
  const sunLon = -(utcHours - 12) * 15;

  const tanDecl = Math.tan(declRad);
  const terminator = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const lonRad = (lon - sunLon) * Math.PI / 180;
    // Guard against equinox singularity
    const lat = Math.abs(tanDecl) < 1e-10
      ? 0
      : Math.atan(-Math.cos(lonRad) / tanDecl) * 180 / Math.PI;
    terminator.push([lat, lon]);
  }

  // Dark pole: south pole when sun is in northern hemisphere, north pole otherwise
  const darkPoleLat = declRad > 0 ? -90 : 90;

  // Build polygon across three world copies for antimeridian scrolling
  const rings = [];
  for (const offset of [-360, 0, 360]) {
    const ring = terminator.map(([lat, lon]) => [lat, lon + offset]);
    // Close polygon by wrapping to the dark pole
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

  // Add day/night overlay and refresh every 60s
  updateNightOverlay();
  setInterval(updateNightOverlay, 60000);
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

// --- License privilege check (duplicated from lib/privileges.js — no require in renderer) ---
const PRIVILEGE_RANGES = {
  us_extra: [
    [1800, 2000, 'all'], [3500, 3600, 'cw_digi'], [3600, 4000, 'phone'],
    [7000, 7125, 'cw_digi'], [7125, 7300, 'phone'], [10100, 10150, 'all'],
    [14000, 14150, 'cw_digi'], [14150, 14350, 'phone'], [18068, 18168, 'all'],
    [21000, 21200, 'cw_digi'], [21200, 21450, 'phone'], [24890, 24990, 'all'],
    [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'], [50000, 54000, 'all'],
  ],
  us_general: [
    [1800, 2000, 'all'], [3525, 3600, 'cw_digi'], [3800, 4000, 'phone'],
    [7025, 7125, 'cw_digi'], [7175, 7300, 'phone'], [10100, 10150, 'all'],
    [14025, 14150, 'cw_digi'], [14225, 14350, 'phone'], [18068, 18168, 'all'],
    [21025, 21200, 'cw_digi'], [21275, 21450, 'phone'], [24890, 24990, 'all'],
    [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'], [50000, 54000, 'all'],
  ],
  us_technician: [
    [3525, 3600, 'cw_digi'], [7025, 7125, 'cw_digi'], [21025, 21200, 'cw_digi'],
    [28000, 28300, 'cw_digi'], [28300, 28500, 'phone'], [50000, 54000, 'all'],
  ],
  ca_basic: [
    [50000, 54000, 'all'],
  ],
  ca_honours: [
    [1800, 2000, 'all'], [3500, 4000, 'all'], [7000, 7300, 'all'],
    [10100, 10150, 'all'], [14000, 14350, 'all'], [18068, 18168, 'all'],
    [21000, 21450, 'all'], [24890, 24990, 'all'], [28000, 29700, 'all'],
    [50000, 54000, 'all'],
  ],
};

const CW_DIGI_MODES = new Set(['CW', 'FT8', 'FT4', 'RTTY', 'DIGI', 'JS8', 'PSK31', 'PSK']);
const PHONE_MODES = new Set(['SSB', 'USB', 'LSB', 'FM', 'AM']);

function isOutOfPrivilege(freqKhz, mode, cls) {
  if (!cls || cls === 'none') return false;
  const ranges = PRIVILEGE_RANGES[cls];
  if (!ranges) return false;
  if (!mode) return false;
  const modeUpper = mode.toUpperCase();
  for (const [lower, upper, allowed] of ranges) {
    if (freqKhz >= lower && freqKhz <= upper) {
      if (allowed === 'all') return false;
      if (allowed === 'cw_digi' && CW_DIGI_MODES.has(modeUpper)) return false;
      if (allowed === 'phone' && PHONE_MODES.has(modeUpper)) return false;
    }
  }
  return true;
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

    // Out-of-privilege gets grey/red pin, SOTA gets orange, POTA gets default blue
    const oop = isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass);
    const markerOptions = oop
      ? { icon: oopIcon, opacity: 0.5 }
      : s.source === 'sota'
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
  mapContainer.classList.add('hidden');
  dxccView.classList.add('hidden');
  rbnView.classList.add('hidden');

  // Deactivate all view buttons
  viewTableBtn.classList.remove('active');
  viewMapBtn.classList.remove('active');
  viewDxccBtn.classList.remove('active');
  viewRbnBtn.classList.remove('active');

  if (view === 'table') {
    spotsTable.classList.remove('hidden');
    viewTableBtn.classList.add('active');
    render();
  } else if (view === 'map') {
    mapContainer.classList.remove('hidden');
    viewMapBtn.classList.add('active');
    updateBandActivityVisibility();
    if (!map) {
      initMap();
    }
    setTimeout(() => map.invalidateSize(), 0);
    render();
  } else if (view === 'dxcc') {
    dxccView.classList.remove('hidden');
    viewDxccBtn.classList.add('active');
    renderDxccMatrix();
  } else if (view === 'rbn') {
    rbnView.classList.remove('hidden');
    viewRbnBtn.classList.add('active');
    if (!rbnMap) {
      initRbnMap();
    }
    setTimeout(() => rbnMap.invalidateSize(), 0);
    renderRbnMarkers();
    renderRbnTable();
  }
}

viewTableBtn.addEventListener('click', () => setView('table'));
viewMapBtn.addEventListener('click', () => setView('map'));
viewRbnBtn.addEventListener('click', () => setView('rbn'));
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

      // License privilege check
      if (isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass)) {
        tr.classList.add('out-of-privilege');
      }

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
    renderBandActivity();
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
  setCwXit.value = s.cwXit || 0;
  setWatchlist.value = s.watchlist || '';
  setNotifyPopup.checked = s.notifyPopup !== false;
  setNotifySound.checked = s.notifySound !== false;
  setNotifyTimeout.value = s.notifyTimeout || 10;
  setLicenseClass.value = s.licenseClass || 'none';
  setHideOutOfBand.checked = s.hideOutOfBand === true;
  setEnablePota.checked = s.enablePota !== false;
  setEnableSota.checked = s.enableSota === true;
  setEnableCluster.checked = s.enableCluster === true;
  setEnableRbn.checked = s.enableRbn === true;
  setMyCallsign.value = s.myCallsign || '';
  setClusterHost.value = s.clusterHost || 'w3lpl.net';
  setClusterPort.value = s.clusterPort || 7373;
  clusterConfig.classList.toggle('hidden', !s.enableCluster);
  rbnConfig.classList.toggle('hidden', !s.enableRbn);
  setEnableSolar.checked = s.enableSolar === true;
  setEnableBandActivity.checked = s.enableBandActivity === true;
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
  const cwXitVal = parseInt(setCwXit.value, 10) || 0;
  const notifyPopupEnabled = setNotifyPopup.checked;
  const notifySoundEnabled = setNotifySound.checked;
  const notifyTimeoutVal = parseInt(setNotifyTimeout.value, 10) || 10;
  const potaEnabled = setEnablePota.checked;
  const sotaEnabled = setEnableSota.checked;
  const clusterEnabled = setEnableCluster.checked;
  const rbnEnabled = setEnableRbn.checked;
  const myCallsign = setMyCallsign.value.trim().toUpperCase();
  const clusterHost = setClusterHost.value.trim() || 'w3lpl.net';
  const clusterPort = parseInt(setClusterPort.value, 10) || 7373;
  const solarEnabled = setEnableSolar.checked;
  const bandActivityEnabled = setEnableBandActivity.checked;
  const dxccEnabled = setEnableDxcc.checked;
  const licenseClassVal = setLicenseClass.value;
  const hideOob = setHideOutOfBand.checked;
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
    cwXit: cwXitVal,
    watchlist: watchlistRaw,
    notifyPopup: notifyPopupEnabled,
    notifySound: notifySoundEnabled,
    notifyTimeout: notifyTimeoutVal,
    enablePota: potaEnabled,
    enableSota: sotaEnabled,
    enableCluster: clusterEnabled,
    enableRbn: rbnEnabled,
    myCallsign: myCallsign,
    clusterHost: clusterHost,
    clusterPort: clusterPort,
    enableSolar: solarEnabled,
    enableBandActivity: bandActivityEnabled,
    enableDxcc: dxccEnabled,
    licenseClass: licenseClassVal,
    hideOutOfBand: hideOob,
    adifPath: adifPath,
  });
  distUnit = setDistUnit.value;
  maxAgeMin = maxAgeVal;
  scanDwell = dwellVal;
  watchlist = parseWatchlist(watchlistRaw);
  enablePota = potaEnabled;
  enableSota = sotaEnabled;
  enableCluster = clusterEnabled;
  enableRbn = rbnEnabled;
  updateClusterStatusVisibility();
  updateRbnStatusVisibility();
  updateRbnButton();
  enableSolar = solarEnabled;
  updateSolarVisibility();
  enableBandActivity = bandActivityEnabled;
  updateBandActivityVisibility();
  enableDxcc = dxccEnabled;
  licenseClass = licenseClassVal;
  hideOutOfBand = hideOob;
  updateDxccButton();
  updateHeaders();
  saveFilters();
  settingsDialog.close();
  render();
  // Update home marker if map is initialized
  if (map) updateHomeMarker();
  if (rbnMap) updateRbnHomeMarker();
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
  catStatusEl.textContent = 'CAT';
  catStatusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
});

// --- DXCC data listener ---
window.api.onDxccData((data) => {
  dxccData = data;
  if (currentView === 'dxcc') renderDxccMatrix();
});

// --- Cluster status listener ---
window.api.onClusterStatus(({ connected }) => {
  clusterStatusEl.textContent = 'Cluster';
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

// --- Solar data listener ---
function updateSolarVisibility() {
  const method = enableSolar ? 'remove' : 'add';
  sfiStatusEl.classList[method]('hidden');
  kStatusEl.classList[method]('hidden');
  aStatusEl.classList[method]('hidden');
}

window.api.onSolarData(({ sfi, kIndex, aIndex }) => {
  const hidden = enableSolar ? '' : ' hidden';

  // SFI: higher is better
  const sfiClass = sfi >= 100 ? 'connected' : sfi >= 70 ? 'warn' : 'disconnected';
  sfiStatusEl.textContent = `SFI ${sfi}`;
  sfiStatusEl.className = `status solar-pill ${sfiClass}${hidden}`;

  // K-index: lower is better
  const kClass = kIndex <= 2 ? 'connected' : kIndex <= 4 ? 'warn' : 'disconnected';
  kStatusEl.textContent = `K ${kIndex}`;
  kStatusEl.className = `status solar-pill ${kClass}${hidden}`;

  // A-index: lower is better
  const aClass = aIndex <= 7 ? 'connected' : aIndex <= 20 ? 'warn' : 'disconnected';
  aStatusEl.textContent = `A ${aIndex}`;
  aStatusEl.className = `status solar-pill ${aClass}${hidden}`;
});

// --- Band Activity Heatmap ---
const HEATMAP_BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
const HEATMAP_CONTINENTS = ['EU', 'NA', 'SA', 'AS', 'AF', 'OC'];

function updateBandActivityVisibility() {
  if (enableBandActivity && currentView === 'map') {
    bandActivityBar.classList.remove('hidden');
  } else {
    bandActivityBar.classList.add('hidden');
  }
  if (map) setTimeout(() => map.invalidateSize(), 0);
}

function renderBandActivity() {
  if (!enableBandActivity || currentView !== 'map') return;

  const now = Date.now();
  const oneHourAgo = now - 3600000;

  // Filter spots from the last 60 minutes
  const recentSpots = allSpots.filter((s) => {
    if (!s.spotTime) return false;
    try {
      const t = new Date(s.spotTime.endsWith('Z') ? s.spotTime : s.spotTime + 'Z').getTime();
      return t >= oneHourAgo;
    } catch { return false; }
  });

  // Aggregate by band × continent
  const counts = {}; // key: "band|continent" → count
  for (const s of recentSpots) {
    if (!s.band || !s.continent) continue;
    const key = `${s.band}|${s.continent}`;
    counts[key] = (counts[key] || 0) + 1;
  }

  // Build grid: columns = header + bands, rows = header + continents
  const cols = HEATMAP_BANDS.length + 1; // +1 for row labels
  bandActivityBar.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'band-activity-grid';
  grid.style.gridTemplateColumns = `auto repeat(${HEATMAP_BANDS.length}, 1fr)`;

  // Header row: empty corner + band labels
  const corner = document.createElement('div');
  corner.className = 'band-activity-header';
  corner.textContent = '';
  grid.appendChild(corner);

  for (const band of HEATMAP_BANDS) {
    const hdr = document.createElement('div');
    hdr.className = 'band-activity-header';
    hdr.textContent = band;
    grid.appendChild(hdr);
  }

  // Data rows: continent label + cells
  for (const cont of HEATMAP_CONTINENTS) {
    const label = document.createElement('div');
    label.className = 'band-activity-label';
    label.textContent = cont;
    grid.appendChild(label);

    for (const band of HEATMAP_BANDS) {
      const count = counts[`${band}|${cont}`] || 0;
      const cell = document.createElement('div');
      cell.className = 'band-activity-cell';

      // Heat level: 0 = empty, 1 = 1-2 spots, 2 = 3-5, 3 = 6+
      const heat = count === 0 ? 0 : count <= 2 ? 1 : count <= 5 ? 2 : 3;
      cell.classList.add(`heat-${heat}`);
      cell.textContent = count || '';
      cell.title = `${band} ${cont}: ${count} spot${count !== 1 ? 's' : ''}`;
      grid.appendChild(cell);
    }
  }

  bandActivityBar.appendChild(grid);
}

// --- RBN Map ---
function initRbnMap() {
  rbnMap = L.map('rbn-map', { zoomControl: true, worldCopyJump: true }).setView(DEFAULT_CENTER, 3);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
    className: 'dark-tiles',
  }).addTo(rbnMap);

  rbnMarkerLayer = L.layerGroup().addTo(rbnMap);

  // Add home marker
  updateRbnHomeMarker();

  // Add day/night overlay
  updateRbnNightOverlay();
  setInterval(updateRbnNightOverlay, 60000);
}

async function updateRbnHomeMarker() {
  if (!rbnMap) return;
  const settings = await window.api.getSettings();
  const grid = settings.grid || 'FN20jb';
  const pos = gridToLatLonLocal(grid);
  if (!pos) return;
  rbnHomePos = pos;

  if (rbnHomeMarker) {
    for (const m of rbnHomeMarker) rbnMap.removeLayer(m);
  }

  const homeIcon = L.divIcon({
    className: 'home-marker-icon',
    html: '<div style="background:#e94560;width:14px;height:14px;border-radius:50%;border:2px solid #fff;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

  rbnHomeMarker = [-360, 0, 360].map((offset) =>
    L.marker([pos.lat, pos.lon + offset], { icon: homeIcon, zIndexOffset: 1000 })
      .bindPopup(`<b>My QTH</b><br>${grid}`)
      .addTo(rbnMap)
  );

  rbnMap.setView([pos.lat, pos.lon], rbnMap.getZoom());
}

function updateRbnNightOverlay() {
  if (!rbnMap) return;
  const rings = computeNightPolygon();
  if (rbnNightLayer) {
    rbnNightLayer.setLatLngs(rings);
  } else {
    rbnNightLayer = L.polygon(rings, {
      fillColor: '#000',
      fillOpacity: 0.25,
      color: '#4fc3f7',
      weight: 1,
      opacity: 0.4,
      interactive: false,
    }).addTo(rbnMap);
  }
  if (rbnMarkerLayer) rbnMarkerLayer.bringToFront();
}

function getFilteredRbnSpots() {
  const bands = getDropdownValues(rbnBandFilterEl);
  const maxAge = parseInt(rbnMaxAgeInput.value, 10) || 30;
  const ageUnit = rbnAgeUnitSelect.value; // 'm' or 'h'
  const maxAgeSecs = maxAge * (ageUnit === 'h' ? 3600 : 60);

  return rbnSpots.filter((s) => {
    if (bands && !bands.has(s.band)) return false;
    if (spotAgeSecs(s.spotTime) > maxAgeSecs) return false;
    return true;
  });
}

function rerenderRbn() {
  if (currentView === 'rbn') {
    renderRbnMarkers();
    renderRbnTable();
  }
}

function renderRbnMarkers() {
  if (!rbnMarkerLayer) return;
  rbnMarkerLayer.clearLayers();

  const filtered = getFilteredRbnSpots();
  const unit = distUnit === 'km' ? 'km' : 'mi';
  const activeBands = new Set();

  // Draw arcs first (underneath markers)
  if (rbnHomePos) {
    for (const s of filtered) {
      if (s.lat == null || s.lon == null) continue;
      const color = RBN_BAND_COLORS[s.band] || '#ffffff';
      const arcPoints = greatCircleArc(rbnHomePos.lat, rbnHomePos.lon, s.lat, s.lon, 50);
      for (const offset of [-360, 0, 360]) {
        const offsetPoints = arcPoints.map(([lat, lon]) => [lat, lon + offset]);
        L.polyline(offsetPoints, {
          color: color,
          weight: 1.5,
          opacity: 0.45,
          interactive: false,
        }).addTo(rbnMarkerLayer);
      }
    }
  }

  // Draw circle markers on top
  for (const s of filtered) {
    if (s.lat == null || s.lon == null) continue;
    if (s.band) activeBands.add(s.band);

    const color = RBN_BAND_COLORS[s.band] || '#ffffff';
    const distStr = s.distance != null ? formatDistance(s.distance) + ' ' + unit : '';
    const snrStr = s.snr != null ? s.snr + ' dB' : '';
    const wpmStr = s.wpm != null ? s.wpm + ' WPM' : '';
    const details = [snrStr, wpmStr].filter(Boolean).join(' / ');

    const popupContent = `
      <b><a href="#" class="popup-qrz" data-call="${s.spotter}">${s.spotter}</a></b><br>
      ${s.locationDesc}<br>
      ${s.band || ''} ${s.mode || ''} &middot; ${details}<br>
      ${distStr ? distStr + '<br>' : ''}
      <span style="color:#808090;font-size:11px;">${formatAge(s.spotTime)}</span>
    `;

    for (const offset of [-360, 0, 360]) {
      L.circleMarker([s.lat, s.lon + offset], {
        radius: 7,
        fillColor: color,
        color: color,
        weight: 1,
        opacity: 0.9,
        fillOpacity: 0.7,
      }).bindPopup(popupContent).addTo(rbnMarkerLayer);
    }
  }

  rbnCountEl.textContent = filtered.length;
  renderRbnLegend(activeBands);
}

function renderRbnLegend(activeBands) {
  rbnLegendEl.innerHTML = '';
  const sortedBands = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
  for (const band of sortedBands) {
    if (!activeBands.has(band)) continue;
    const item = document.createElement('span');
    item.className = 'rbn-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'rbn-legend-swatch';
    swatch.style.background = RBN_BAND_COLORS[band] || '#fff';
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(band));
    rbnLegendEl.appendChild(item);
  }
}

function renderRbnTable() {
  rbnTableBody.innerHTML = '';
  rbnDistHeader.textContent = distUnit === 'km' ? 'Dist (km)' : 'Dist (mi)';
  const unit = distUnit === 'km' ? 'km' : 'mi';

  // Show newest spots first
  const sorted = [...getFilteredRbnSpots()].reverse();

  for (const s of sorted) {
    const tr = document.createElement('tr');

    // Spotter (QRZ link)
    const spotterTd = document.createElement('td');
    const spotterLink = document.createElement('a');
    spotterLink.textContent = s.spotter;
    spotterLink.href = '#';
    spotterLink.className = 'qrz-link';
    spotterLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openExternal(`https://www.qrz.com/db/${encodeURIComponent(s.spotter)}`);
    });
    spotterTd.appendChild(spotterLink);
    tr.appendChild(spotterTd);

    // Spotted (location description)
    const spottedTd = document.createElement('td');
    spottedTd.textContent = s.locationDesc || '';
    tr.appendChild(spottedTd);

    // Distance
    const distTd = document.createElement('td');
    distTd.textContent = s.distance != null ? formatDistance(s.distance) : '—';
    tr.appendChild(distTd);

    // Freq
    const freqTd = document.createElement('td');
    freqTd.textContent = parseFloat(s.frequency).toFixed(1);
    tr.appendChild(freqTd);

    // Mode
    const modeTd = document.createElement('td');
    modeTd.textContent = s.mode || '';
    tr.appendChild(modeTd);

    // Type
    const typeTd = document.createElement('td');
    typeTd.textContent = s.type || '';
    tr.appendChild(typeTd);

    // SNR
    const snrTd = document.createElement('td');
    snrTd.textContent = s.snr != null ? s.snr + ' dB' : '';
    tr.appendChild(snrTd);

    // Speed
    const speedTd = document.createElement('td');
    speedTd.textContent = s.wpm != null ? s.wpm + ' WPM' : '';
    tr.appendChild(speedTd);

    // Time (HHMM from spotTime)
    const timeTd = document.createElement('td');
    try {
      const d = new Date(s.spotTime);
      timeTd.textContent = d.toISOString().slice(11, 16) + 'z';
    } catch { timeTd.textContent = ''; }
    tr.appendChild(timeTd);

    // Seen (relative age)
    const seenTd = document.createElement('td');
    seenTd.textContent = formatAge(s.spotTime);
    tr.appendChild(seenTd);

    rbnTableBody.appendChild(tr);
  }
}

// --- RBN splitter drag ---
rbnSplitter.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const rbnViewEl = document.getElementById('rbn-view');
  const startY = e.clientY;
  const startMapH = rbnMapContainer.offsetHeight;
  const startTableH = rbnTableContainer.offsetHeight;

  const onMove = (ev) => {
    const delta = ev.clientY - startY;
    const newMapH = Math.max(80, startMapH + delta);
    const newTableH = Math.max(60, startTableH - delta);
    rbnMapContainer.style.flex = 'none';
    rbnTableContainer.style.flex = 'none';
    rbnMapContainer.style.height = newMapH + 'px';
    rbnTableContainer.style.height = newTableH + 'px';
    if (rbnMap) rbnMap.invalidateSize();
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
  };

  document.body.style.cursor = 'row-resize';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// RBN clear button
rbnClearBtn.addEventListener('click', () => {
  window.api.clearRbn();
  rbnSpots = [];
  renderRbnMarkers();
  renderRbnTable();
});

// --- RBN IPC listeners ---
window.api.onRbnSpots((spots) => {
  rbnSpots = spots;
  if (currentView === 'rbn') {
    renderRbnMarkers();
    renderRbnTable();
  }
});

window.api.onRbnStatus(({ connected }) => {
  rbnStatusEl.textContent = 'RBN';
  rbnStatusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
  if (enableRbn) rbnStatusEl.classList.remove('hidden');
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
