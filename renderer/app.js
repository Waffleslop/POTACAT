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
let enableLogging = false;
let defaultPower = 100;
let tuneClick = false;
let activeRigName = ''; // name of the currently active rig profile
let workedCallsigns = new Set(); // uppercase callsigns from QSO log
let hideWorked = false;
let workedParksSet = new Set(); // park references from CSV for fast lookup
let workedParksData = new Map(); // reference → full park data for stats
let hideWorkedParks = false;
let showBearing = false;
let respotDefault = true; // default: re-spot on POTA after logging
let respotTemplate = 'Thanks for {rst}. 73s {mycallsign} via POTA CAT'; // re-spot comment template
let myCallsign = '';
let dxccData = null;  // { entities: [...] } from main process
let enableWsjtx = false;
let wsjtxDecodes = []; // recent decodes from WSJT-X (FIFO, max 50)
let wsjtxState = null; // last WSJT-X status (freq, mode, etc.)

// --- Scan state ---
// --- Radio frequency tracking ---
let radioFreqKhz = null;

let scanning = false;
let scanTimer = null;
let scanIndex = 0;
let scanSkipped = new Set(); // frequencies to skip (as strings)
let pendingSpots = null;     // buffered spots during scan

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
const setHideWorked = document.getElementById('set-hide-worked');
const setTuneClick = document.getElementById('set-tune-click');
const setVerboseLog = document.getElementById('set-verbose-log');
const continentFilterEl = document.getElementById('continent-filter');
const scanBtn = document.getElementById('scan-btn');
const hamlibConfig = document.getElementById('hamlib-config');
const flexConfig = document.getElementById('flex-config');
const tcpcatConfig = document.getElementById('tcpcat-config');
const serialcatConfig = document.getElementById('serialcat-config');
const setTcpcatHost = document.getElementById('set-tcpcat-host');
const setTcpcatPort = document.getElementById('set-tcpcat-port');
const setFlexSlice = document.getElementById('set-flex-slice');
const setSerialcatPort = document.getElementById('set-serialcat-port');
const setSerialcatPortManual = document.getElementById('set-serialcat-port-manual');
const setSerialcatBaud = document.getElementById('set-serialcat-baud');
const setSerialcatDtrOff = document.getElementById('set-serialcat-dtr-off');
const serialcatTestBtn = document.getElementById('serialcat-test-btn');
const serialcatTestResult = document.getElementById('serialcat-test-result');
const radioTypeBtns = document.querySelectorAll('input[name="radio-type"]');
const myRigsList = document.getElementById('my-rigs-list');
const rigAddBtn = document.getElementById('rig-add-btn');
const rigEditor = document.getElementById('rig-editor');
const rigEditorTitle = document.getElementById('rig-editor-title');
const setRigName = document.getElementById('set-rig-name');
const rigSaveBtn = document.getElementById('rig-save-btn');
const rigCancelBtn = document.getElementById('rig-cancel-btn');
const setRigModel = document.getElementById('set-rig-model');
const setRigPort = document.getElementById('set-rig-port');
const setRigPortManual = document.getElementById('set-rig-port-manual');
const setRigBaud = document.getElementById('set-rig-baud');
const setRigDtrOff = document.getElementById('set-rig-dtr-off');
const setRigSearch = document.getElementById('set-rig-search');
const hamlibTestBtn = document.getElementById('hamlib-test-btn');
const hamlibTestResult = document.getElementById('hamlib-test-result');
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
const setEnableWsjtx = document.getElementById('set-enable-wsjtx');
const wsjtxConfig = document.getElementById('wsjtx-config');
const setWsjtxPort = document.getElementById('set-wsjtx-port');
const setWsjtxHighlight = document.getElementById('set-wsjtx-highlight');
const setWsjtxAutoLog = document.getElementById('set-wsjtx-auto-log');
const wsjtxStatusEl = document.getElementById('wsjtx-status');
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
const setPotaParksPath = document.getElementById('set-pota-parks-path');
const potaParksBrowseBtn = document.getElementById('pota-parks-browse-btn');
const potaParksPicker = document.getElementById('pota-parks-picker');
const setHideWorkedParks = document.getElementById('set-hide-worked-parks');
const parksStatsOverlay = document.getElementById('parks-stats-overlay');
const parksStatsTotal = document.getElementById('parks-stats-total');
const parksStatsQsos = document.getElementById('parks-stats-qsos');
const parksStatsLocations = document.getElementById('parks-stats-locations');
const parksStatsNewNow = document.getElementById('parks-stats-new-now');
const parksStatsToggleBtn = document.getElementById('parks-stats-toggle');
const parksStatsCloseBtn = document.getElementById('parks-stats-close');
let parksStatsOpen = false;
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
const setShowBearing = document.getElementById('set-show-bearing');
const setEnableLogging = document.getElementById('set-enable-logging');
const loggingConfig = document.getElementById('logging-config');
const setAdifLogPath = document.getElementById('set-adif-log-path');
const adifLogBrowseBtn = document.getElementById('adif-log-browse-btn');
const adifImportBtn = document.getElementById('adif-import-btn');
const adifImportResult = document.getElementById('adif-import-result');
const setDefaultPower = document.getElementById('set-default-power');
const setSendToLogbook = document.getElementById('set-send-to-logbook');
const logbookConfig = document.getElementById('logbook-config');
const setLogbookType = document.getElementById('set-logbook-type');
const logbookInstructions = document.getElementById('logbook-instructions');
const logbookPortConfig = document.getElementById('logbook-port-config');
const setLogbookHost = document.getElementById('set-logbook-host');
const setLogbookPort = document.getElementById('set-logbook-port');
const logbookHelp = document.getElementById('logbook-help');
const setEnableTelemetry = document.getElementById('set-enable-telemetry');
const setLightMode = document.getElementById('set-light-mode');
setLightMode.addEventListener('change', () => applyTheme(setLightMode.checked));
const setSmartSdrSpots = document.getElementById('set-smartsdr-spots');
const smartSdrConfig = document.getElementById('smartsdr-config');
const setSmartSdrHost = document.getElementById('set-smartsdr-host');
const setSmartSdrPota = document.getElementById('set-smartsdr-pota');
const setSmartSdrSota = document.getElementById('set-smartsdr-sota');
const setSmartSdrCluster = document.getElementById('set-smartsdr-cluster');
const setSmartSdrRbn = document.getElementById('set-smartsdr-rbn');
const logDialog = document.getElementById('log-dialog');
const logCallsign = document.getElementById('log-callsign');
const logFrequency = document.getElementById('log-frequency');
const logMode = document.getElementById('log-mode');
const logDate = document.getElementById('log-date');
const logTime = document.getElementById('log-time');
const logPower = document.getElementById('log-power');
const logRstSent = document.getElementById('log-rst-sent');
const logRstRcvd = document.getElementById('log-rst-rcvd');
const logRefDisplay = document.getElementById('log-ref-display');
const logComment = document.getElementById('log-comment');
const logSaveBtn = document.getElementById('log-save');
const logCancelBtn = document.getElementById('log-cancel');
const logDialogClose = document.getElementById('log-dialog-close');

// --- UTC Clock ---
function updateUtcClock() {
  const now = new Date();
  utcClockEl.textContent = now.toISOString().slice(11, 19) + 'z';
}
updateUtcClock();
setInterval(updateUtcClock, 1000);

// --- CAT Popover (rig switcher) ---
const catPopover = document.getElementById('cat-popover');
const catPopoverRigs = document.getElementById('cat-popover-rigs');
const catPopoverWsjtx = document.getElementById('cat-popover-wsjtx');
const catPopoverWsjtxPort = document.getElementById('cat-popover-wsjtx-port');
const catPopoverWsjtxPortInput = document.getElementById('cat-popover-wsjtx-port-input');
let catPopoverOpen = false;

function positionCatPopover() {
  const rect = catStatusEl.getBoundingClientRect();
  const headerRect = catStatusEl.closest('header').getBoundingClientRect();
  catPopover.style.top = (rect.bottom - headerRect.top + 4) + 'px';
  catPopover.style.left = (rect.left - headerRect.left) + 'px';
}

async function openCatPopover() {
  const settings = await window.api.getSettings();
  const rigs = settings.rigs || [];
  const activeId = settings.activeRigId || null;

  // Build rig list
  catPopoverRigs.innerHTML = '';

  // "None" option
  const noneEl = document.createElement('div');
  noneEl.className = 'cat-popover-rig' + (!activeId ? ' active' : '');
  noneEl.innerHTML = `
    <span class="cat-popover-rig-dot"></span>
    <div class="cat-popover-rig-info">
      <div class="cat-popover-rig-name">None</div>
      <div class="cat-popover-rig-desc">No radio connected</div>
    </div>
  `;
  noneEl.addEventListener('click', async () => {
    window.api.connectCat(null);
    await window.api.saveSettings({ activeRigId: null });
    activeRigName = '';
    closeCatPopover();
  });
  catPopoverRigs.appendChild(noneEl);

  for (const rig of rigs) {
    const isActive = rig.id === activeId;
    const rigEl = document.createElement('div');
    rigEl.className = 'cat-popover-rig' + (isActive ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'cat-popover-rig-dot';
    const info = document.createElement('div');
    info.className = 'cat-popover-rig-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'cat-popover-rig-name';
    nameEl.textContent = rig.name || 'Unnamed Rig';
    const descEl = document.createElement('div');
    descEl.className = 'cat-popover-rig-desc';
    descEl.textContent = describeRigTarget(rig.catTarget);
    info.appendChild(nameEl);
    info.appendChild(descEl);
    rigEl.appendChild(dot);
    rigEl.appendChild(info);
    rigEl.addEventListener('click', async () => {
      window.api.connectCat(rig.catTarget);
      await window.api.saveSettings({ activeRigId: rig.id, catTarget: rig.catTarget });
      activeRigName = rig.name || '';
      closeCatPopover();
    });
    catPopoverRigs.appendChild(rigEl);
  }

  // WSJT-X toggle
  catPopoverWsjtx.checked = settings.enableWsjtx === true;
  catPopoverWsjtxPortInput.value = settings.wsjtxPort || 2237;
  catPopoverWsjtxPort.classList.toggle('hidden', !settings.enableWsjtx);

  positionCatPopover();
  catPopover.classList.remove('hidden');
  catPopoverOpen = true;
}

function closeCatPopover() {
  catPopover.classList.add('hidden');
  catPopoverOpen = false;
}

catStatusEl.addEventListener('click', (e) => {
  e.stopPropagation();
  if (catPopoverOpen) {
    closeCatPopover();
  } else {
    openCatPopover();
  }
});

catPopoverWsjtx.addEventListener('change', async () => {
  const enabled = catPopoverWsjtx.checked;
  catPopoverWsjtxPort.classList.toggle('hidden', !enabled);
  const port = parseInt(catPopoverWsjtxPortInput.value, 10) || 2237;
  await window.api.saveSettings({ enableWsjtx: enabled, wsjtxPort: port });
  enableWsjtx = enabled;
  updateWsjtxStatusVisibility();
  closeCatPopover();
});

catPopoverWsjtxPortInput.addEventListener('click', (e) => e.stopPropagation());

// Close popover on outside click
document.addEventListener('click', (e) => {
  if (catPopoverOpen && !catPopover.contains(e.target) && e.target !== catStatusEl) {
    closeCatPopover();
  }
});

// Close popover on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && catPopoverOpen) {
    closeCatPopover();
  }
});

// --- Load preferences from settings ---
function parseWatchlist(str) {
  if (!str) return new Set();
  return new Set(str.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean));
}

function applyTheme(light) {
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
}

async function loadPrefs() {
  const settings = await window.api.getSettings();
  applyTheme(settings.lightMode === true);
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
  enableLogging = settings.enableLogging === true;
  defaultPower = parseInt(settings.defaultPower, 10) || 100;
  updateLoggingVisibility();
  showBearing = settings.showBearing === true;
  updateBearingVisibility();
  licenseClass = settings.licenseClass || 'none';
  hideOutOfBand = settings.hideOutOfBand === true;
  hideWorked = settings.hideWorked === true;
  hideWorkedParks = settings.hideWorkedParks === true;
  respotDefault = settings.respotDefault !== false; // default true
  if (settings.respotTemplate != null) respotTemplate = settings.respotTemplate;
  myCallsign = settings.myCallsign || '';
  tuneClick = settings.tuneClick === true;
  catLogToggleBtn.classList.toggle('hidden', settings.verboseLog !== true);
  // Resolve active rig name
  const rigs = settings.rigs || [];
  const activeRig = rigs.find(r => r.id === settings.activeRigId);
  activeRigName = activeRig ? activeRig.name : '';
  enableWsjtx = settings.enableWsjtx === true;
  updateWsjtxStatusVisibility();
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
let allRigOptions = []; // cached rig list from listRigs()

function getEffectivePort() {
  const manual = setRigPortManual.value.trim();
  return manual || setRigPort.value;
}

function getSelectedRadioType() {
  const checked = document.querySelector('input[name="radio-type"]:checked');
  return checked ? checked.value : 'none';
}

function setRadioType(value) {
  const btn = document.querySelector(`input[name="radio-type"][value="${value}"]`);
  if (btn) btn.checked = true;
}

function getEffectiveSerialcatPort() {
  const manual = setSerialcatPortManual.value.trim();
  return manual || setSerialcatPort.value;
}

function updateRadioSubPanels() {
  const type = getSelectedRadioType();
  flexConfig.classList.toggle('hidden', type !== 'flex');
  tcpcatConfig.classList.toggle('hidden', type !== 'tcpcat');
  serialcatConfig.classList.toggle('hidden', type !== 'serialcat');
  hamlibConfig.classList.toggle('hidden', type !== 'hamlib');
  if (type === 'serialcat' && !serialcatPortsLoaded) {
    loadSerialcatPorts();
  }
  if (type === 'hamlib' && !hamlibFieldsLoaded) {
    hamlibFieldsLoaded = true;
    populateHamlibFields(null);
  }
}

async function populateRadioSection(currentTarget) {
  hamlibFieldsLoaded = false;
  if (!currentTarget) {
    setRadioType('flex');
  } else if (currentTarget.type === 'tcp') {
    // Check if it matches a standard Flex slice (localhost + 5002-5005)
    const isFlexSlice = (currentTarget.host === '127.0.0.1' || !currentTarget.host) &&
      [5002, 5003, 5004, 5005].includes(currentTarget.port);
    if (isFlexSlice) {
      setRadioType('flex');
      setFlexSlice.value = String(currentTarget.port);
    } else {
      setRadioType('tcpcat');
      setTcpcatHost.value = currentTarget.host || '127.0.0.1';
      setTcpcatPort.value = currentTarget.port || 5002;
    }
  } else if (currentTarget.type === 'serial') {
    setRadioType('serialcat');
    serialcatPortsLoaded = true;
    await loadSerialcatPorts(currentTarget);
  } else if (currentTarget.type === 'rigctld') {
    setRadioType('hamlib');
    hamlibFieldsLoaded = true;
    await populateHamlibFields(currentTarget);
  } else {
    setRadioType('flex');
  }
  updateRadioSubPanels();
}

function renderRigOptions(filteredList, selectedId) {
  setRigModel.innerHTML = '';
  if (filteredList.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = allRigOptions.length === 0 ? 'No rigs found — is Hamlib installed?' : 'No matches';
    setRigModel.appendChild(opt);
  } else {
    for (const rig of filteredList) {
      const opt = document.createElement('option');
      opt.value = rig.id;
      opt.textContent = `${rig.mfg} ${rig.model}`;
      if (selectedId && rig.id === selectedId) opt.selected = true;
      setRigModel.appendChild(opt);
    }
  }
}

async function populateHamlibFields(savedTarget) {
  // Populate rig model list box
  setRigModel.innerHTML = '<option value="">Loading rigs...</option>';
  setRigSearch.value = '';
  const rigs = await window.api.listRigs();
  allRigOptions = rigs;
  const selectedId = savedTarget ? savedTarget.rigId : null;
  renderRigOptions(allRigOptions, selectedId);

  // Populate serial port dropdown
  const ports = await window.api.listPorts();
  setRigPort.innerHTML = '';
  setRigPortManual.value = '';
  const detectedPaths = new Set();
  for (const p of ports) {
    detectedPaths.add(p.path);
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = `${p.path} — ${p.friendlyName}`;
    if (savedTarget && savedTarget.serialPort === p.path) opt.selected = true;
    setRigPort.appendChild(opt);
  }

  // If the saved port isn't in the detected list, put it in the manual input
  if (savedTarget && savedTarget.serialPort && !detectedPaths.has(savedTarget.serialPort)) {
    setRigPortManual.value = savedTarget.serialPort;
  }

  // Restore baud rate
  if (savedTarget && savedTarget.baudRate) {
    setRigBaud.value = String(savedTarget.baudRate);
  }

  // Restore DTR/RTS checkbox
  setRigDtrOff.checked = !!(savedTarget && savedTarget.dtrOff);
}

let serialcatPortsLoaded = false;

async function loadSerialcatPorts(savedTarget) {
  const ports = await window.api.listPorts();
  setSerialcatPort.innerHTML = '';
  setSerialcatPortManual.value = '';
  const detectedPaths = new Set();
  for (const p of ports) {
    detectedPaths.add(p.path);
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = `${p.path} — ${p.friendlyName}`;
    if (savedTarget && savedTarget.path === p.path) opt.selected = true;
    setSerialcatPort.appendChild(opt);
  }
  if (savedTarget && savedTarget.path && !detectedPaths.has(savedTarget.path)) {
    setSerialcatPortManual.value = savedTarget.path;
  }
  if (savedTarget && savedTarget.baudRate) {
    setSerialcatBaud.value = String(savedTarget.baudRate);
  }
  setSerialcatDtrOff.checked = !!(savedTarget && savedTarget.dtrOff);
  serialcatPortsLoaded = true;
}

// --- Rig profile management ---
let rigEditorMode = null; // null | 'add' | 'edit'
let editingRigId = null;
let currentRigs = []; // local copy of settings.rigs
let currentActiveRigId = null; // local copy of settings.activeRigId

function describeRigTarget(target) {
  if (!target) return 'Not configured';
  if (target.type === 'tcp') {
    const host = target.host || '127.0.0.1';
    const port = target.port || 5002;
    if ((host === '127.0.0.1' || host === 'localhost') && port >= 5002 && port <= 5005) {
      const sliceLetter = String.fromCharCode(65 + port - 5002);
      return `FlexRadio Slice ${sliceLetter} (TCP :${port})`;
    }
    return `TCP ${host}:${port}`;
  }
  if (target.type === 'serial') {
    return `Serial CAT on ${target.path || '?'} @ ${target.baudRate || 9600}`;
  }
  if (target.type === 'rigctld') {
    const port = target.serialPort || '?';
    return `Hamlib on ${port}`;
  }
  return 'Unknown';
}

function renderRigList(rigs, activeRigId) {
  myRigsList.innerHTML = '';
  currentRigs = rigs || [];
  currentActiveRigId = activeRigId || null;

  // "None" option
  const noneItem = document.createElement('div');
  noneItem.className = 'rig-item' + (!activeRigId ? ' active' : '');
  noneItem.innerHTML = `
    <input type="radio" name="active-rig" value="" ${!activeRigId ? 'checked' : ''}>
    <div class="rig-item-info">
      <div class="rig-item-name">None</div>
      <div class="rig-item-desc">No radio connected</div>
    </div>
  `;
  noneItem.addEventListener('click', () => {
    noneItem.querySelector('input[type="radio"]').checked = true;
    myRigsList.querySelectorAll('.rig-item').forEach(el => el.classList.remove('active'));
    noneItem.classList.add('active');
  });
  myRigsList.appendChild(noneItem);

  for (const rig of rigs) {
    const isActive = rig.id === activeRigId;
    const item = document.createElement('div');
    item.className = 'rig-item' + (isActive ? ' active' : '');
    item.dataset.rigId = rig.id;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'active-rig';
    radio.value = rig.id;
    if (isActive) radio.checked = true;

    const info = document.createElement('div');
    info.className = 'rig-item-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'rig-item-name';
    nameEl.textContent = rig.name || 'Unnamed Rig';
    const descEl = document.createElement('div');
    descEl.className = 'rig-item-desc';
    descEl.textContent = describeRigTarget(rig.catTarget);
    info.appendChild(nameEl);
    info.appendChild(descEl);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'rig-item-btn';
    editBtn.textContent = 'Edit';
    editBtn.title = 'Edit this rig';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRigEditor('edit', rig.id);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'rig-item-btn rig-delete-btn';
    deleteBtn.textContent = '\u2715';
    deleteBtn.title = 'Delete this rig';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteRig(rig.id);
    });

    item.appendChild(radio);
    item.appendChild(info);
    item.appendChild(editBtn);
    item.appendChild(deleteBtn);

    item.addEventListener('click', () => {
      radio.checked = true;
      myRigsList.querySelectorAll('.rig-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    });

    myRigsList.appendChild(item);
  }
}

function buildCatTargetFromForm() {
  const radioType = getSelectedRadioType();
  if (radioType === 'flex') {
    return { type: 'tcp', host: '127.0.0.1', port: parseInt(setFlexSlice.value, 10) };
  } else if (radioType === 'tcpcat') {
    return { type: 'tcp', host: setTcpcatHost.value.trim() || '127.0.0.1', port: parseInt(setTcpcatPort.value, 10) || 5002 };
  } else if (radioType === 'serialcat') {
    return {
      type: 'serial',
      path: getEffectiveSerialcatPort(),
      baudRate: parseInt(setSerialcatBaud.value, 10) || 9600,
      dtrOff: setSerialcatDtrOff.checked,
    };
  } else if (radioType === 'hamlib') {
    return {
      type: 'rigctld',
      rigId: parseInt(setRigModel.value, 10),
      serialPort: getEffectivePort(),
      baudRate: parseInt(setRigBaud.value, 10),
      dtrOff: setRigDtrOff.checked,
    };
  }
  return null;
}

async function openRigEditor(mode, rigId) {
  rigEditorMode = mode;
  editingRigId = rigId || null;
  hamlibFieldsLoaded = false;
  serialcatPortsLoaded = false;

  if (mode === 'edit') {
    rigEditorTitle.textContent = 'Edit Rig';
    const rig = currentRigs.find(r => r.id === rigId);
    if (rig) {
      setRigName.value = rig.name || '';
      await populateRadioSection(rig.catTarget);
    }
  } else {
    rigEditorTitle.textContent = 'Add Rig';
    setRigName.value = '';
    setRadioType('flex');
    updateRadioSubPanels();
  }

  rigEditor.classList.remove('hidden');
  rigAddBtn.classList.add('hidden');
  setRigName.focus();
}

function closeRigEditor() {
  rigEditorMode = null;
  editingRigId = null;
  rigEditor.classList.add('hidden');
  rigAddBtn.classList.remove('hidden');
  hamlibTestResult.textContent = '';
  hamlibTestResult.className = '';
}

async function deleteRig(rigId) {
  currentRigs = currentRigs.filter(r => r.id !== rigId);
  // If deleted the active rig, select none
  if (currentActiveRigId === rigId) {
    currentActiveRigId = null;
  }
  renderRigList(currentRigs, currentActiveRigId);
  closeRigEditor();
}

// Rig editor event handlers
rigAddBtn.addEventListener('click', () => openRigEditor('add'));

rigCancelBtn.addEventListener('click', () => closeRigEditor());

rigSaveBtn.addEventListener('click', async () => {
  const name = setRigName.value.trim() || 'Unnamed Rig';
  const catTarget = buildCatTargetFromForm();

  if (rigEditorMode === 'edit' && editingRigId) {
    const rig = currentRigs.find(r => r.id === editingRigId);
    if (rig) {
      rig.name = name;
      rig.catTarget = catTarget;
    }
  } else {
    const newRig = {
      id: 'rig_' + Date.now(),
      name,
      catTarget,
    };
    currentRigs.push(newRig);
  }

  renderRigList(currentRigs, currentActiveRigId);
  closeRigEditor();
});

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
initMultiDropdown(continentFilterEl, 'Region');
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

function updateWsjtxStatusVisibility() {
  wsjtxStatusEl.classList.toggle('hidden', !enableWsjtx);
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

function updateLoggingVisibility() {
  if (enableLogging) {
    spotsTable.classList.add('logging-enabled');
  } else {
    spotsTable.classList.remove('logging-enabled');
  }
}

function updateBearingVisibility() {
  if (showBearing) {
    spotsTable.classList.add('bearing-enabled');
  } else {
    spotsTable.classList.remove('bearing-enabled');
  }
}

// --- Tune confirmation click ---
let audioCtx = null;
function playTuneClick() {
  if (!tuneClick) return;
  if (!audioCtx) audioCtx = new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1200;
  gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.06);
}


// --- Persist filters to localStorage ---
const FILTERS_KEY = 'pota-cat-filters';

function saveFilters() {
  const bands = getDropdownValues(bandFilterEl);
  const modes = getDropdownValues(modeFilterEl);
  const continents = getDropdownValues(continentFilterEl);
  const data = {
    bands: bands ? [...bands] : null,
    modes: modes ? [...modes] : null,
    continents: continents ? [...continents] : null,
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

    // Restore continent checkboxes
    if (data.continents) {
      const contSet = new Set(data.continents);
      continentFilterEl.querySelector('input[value="all"]').checked = false;
      continentFilterEl.querySelectorAll('input:not([value="all"])').forEach((cb) => {
        cb.checked = contSet.has(cb.value);
      });
    } else {
      continentFilterEl.querySelector('input[value="all"]').checked = true;
      continentFilterEl.querySelectorAll('input:not([value="all"])').forEach((cb) => { cb.checked = false; });
    }

    // Restore max age
    if (data.maxAgeMin) maxAgeMin = data.maxAgeMin;

    // Update dropdown button text
    [bandFilterEl, modeFilterEl, continentFilterEl].forEach((container) => {
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

// WSJT-X checkbox toggles config visibility
setEnableWsjtx.addEventListener('change', () => {
  wsjtxConfig.classList.toggle('hidden', !setEnableWsjtx.checked);
});

// SmartSDR checkbox toggles config visibility
setSmartSdrSpots.addEventListener('change', () => {
  smartSdrConfig.classList.toggle('hidden', !setSmartSdrSpots.checked);
});

// DXCC checkbox toggles ADIF picker visibility
setEnableDxcc.addEventListener('change', () => {
  adifPicker.classList.toggle('hidden', !setEnableDxcc.checked);
});

// Logging checkbox toggles logging config visibility
setEnableLogging.addEventListener('change', () => {
  loggingConfig.classList.toggle('hidden', !setEnableLogging.checked);
});

// Send to Logbook checkbox toggles logbook dropdown visibility
setSendToLogbook.addEventListener('change', () => {
  logbookConfig.classList.toggle('hidden', !setSendToLogbook.checked);
  updateLogbookPortConfig();
});

// Logbook type dropdown — show port config and contextual help
const LOGBOOK_DEFAULTS = {
  log4om: {
    fileWatch: true,
    instructions: 'In Log4OM 2: Settings > Program Configuration > Software Integration > ADIF Functions. In the ADIF Monitor tab, check "Enable ADIF monitor". Click the folder icon next to "ADIF file" and select the same ADIF log file used in POTA CAT. Press the green + button to add it to the list, then press "Save and apply". Log4OM will automatically import new QSOs as they are saved.',
  },
  n3fjp: { port: 1100, help: 'In N3FJP: Settings > Application Program Interface > check "TCP API Enabled". Set the port to 1100 (default). N3FJP must be running to receive QSOs.' },
  hrd: { port: 2333, help: 'In HRD Logbook: Tools > Configure > QSO Forwarding. Under UDP Receive, check "Receive QSO notifications using UDP9/ADIF from other logging programs (eg. WSJT-X)". Set the receive port to 2333 and select your target database. POTA CAT and WSJT-X can both send to this port simultaneously.' },
};

function updateLogbookPortConfig() {
  const type = setLogbookType.value;
  const defaults = LOGBOOK_DEFAULTS[type];
  if (defaults && defaults.fileWatch) {
    // File-based integration (e.g. Log4OM) — show instructions, hide port config
    logbookInstructions.innerHTML = defaults.instructions;
    logbookInstructions.classList.remove('hidden');
    logbookPortConfig.classList.add('hidden');
    logbookHelp.textContent = '';
  } else if (defaults) {
    logbookInstructions.classList.add('hidden');
    logbookPortConfig.classList.remove('hidden');
    const currentPort = parseInt(setLogbookPort.value, 10);
    const isDefaultPort = !currentPort || Object.values(LOGBOOK_DEFAULTS).some(d => d.port === currentPort);
    if (isDefaultPort) setLogbookPort.value = defaults.port;
    logbookHelp.textContent = defaults.help;
  } else {
    logbookInstructions.classList.add('hidden');
    logbookPortConfig.classList.add('hidden');
    logbookHelp.textContent = '';
  }
}

setLogbookType.addEventListener('change', updateLogbookPortConfig);

// ADIF log file browser (save dialog, starts at current path or default)
adifLogBrowseBtn.addEventListener('click', async () => {
  const currentPath = setAdifLogPath.value || await window.api.getDefaultLogPath();
  const filePath = await window.api.chooseLogFile(currentPath);
  if (filePath) {
    setAdifLogPath.value = filePath;
  }
});

// ADIF import
adifImportBtn.addEventListener('click', async () => {
  adifImportResult.textContent = 'Importing...';
  adifImportResult.style.color = '';
  try {
    const result = await window.api.importAdif();
    if (!result) {
      adifImportResult.textContent = '';
    } else if (result.success) {
      adifImportResult.textContent = `${result.imported} QSOs imported`;
      adifImportResult.style.color = '#4ecca3';
    } else {
      adifImportResult.textContent = 'Import failed';
      adifImportResult.style.color = '#e94560';
    }
  } catch (err) {
    adifImportResult.textContent = 'Import failed';
    adifImportResult.style.color = '#e94560';
  }
});

// ADIF file browser
adifBrowseBtn.addEventListener('click', async () => {
  const filePath = await window.api.chooseAdifFile();
  if (filePath) {
    setAdifPath.value = filePath;
  }
});

potaParksBrowseBtn.addEventListener('click', async () => {
  const filePath = await window.api.choosePotaParksFile();
  if (filePath) {
    setPotaParksPath.value = filePath;
  }
});

// Rig search filtering
setRigSearch.addEventListener('input', () => {
  const query = setRigSearch.value.toLowerCase();
  const selectedId = parseInt(setRigModel.value, 10) || null;
  if (!query) {
    renderRigOptions(allRigOptions, selectedId);
  } else {
    const filtered = allRigOptions.filter((r) =>
      `${r.mfg} ${r.model}`.toLowerCase().includes(query)
    );
    renderRigOptions(filtered, selectedId);
  }
});

// Hamlib test button
hamlibTestBtn.addEventListener('click', async () => {
  const rigId = parseInt(setRigModel.value, 10);
  const serialPort = getEffectivePort();
  const baudRate = parseInt(setRigBaud.value, 10);

  if (!rigId) {
    hamlibTestResult.textContent = 'Select a rig model first';
    hamlibTestResult.className = 'hamlib-test-fail';
    return;
  }
  if (!serialPort) {
    hamlibTestResult.textContent = 'Select a serial port first';
    hamlibTestResult.className = 'hamlib-test-fail';
    return;
  }

  hamlibTestBtn.disabled = true;
  hamlibTestResult.textContent = 'Testing...';
  hamlibTestResult.className = '';

  try {
    const dtrOff = setRigDtrOff.checked;
    const result = await window.api.testHamlib({ rigId, serialPort, baudRate, dtrOff });
    if (result.success) {
      const freqMHz = (parseInt(result.frequency, 10) / 1e6).toFixed(6);
      hamlibTestResult.textContent = `Connected! Freq: ${freqMHz} MHz`;
      hamlibTestResult.className = 'hamlib-test-success';
    } else {
      hamlibTestResult.textContent = `Failed: ${result.error}`;
      hamlibTestResult.className = 'hamlib-test-fail';
    }
  } catch (err) {
    hamlibTestResult.textContent = `Error: ${err.message}`;
    hamlibTestResult.className = 'hamlib-test-fail';
  } finally {
    hamlibTestBtn.disabled = false;
  }
});

// Serial CAT test connection
serialcatTestBtn.addEventListener('click', async () => {
  const portPath = getEffectiveSerialcatPort();
  const baudRate = parseInt(setSerialcatBaud.value, 10);
  const dtrOff = setSerialcatDtrOff.checked;

  if (!portPath) {
    serialcatTestResult.textContent = 'Select a serial port first';
    serialcatTestResult.className = 'hamlib-test-fail';
    return;
  }

  serialcatTestBtn.disabled = true;
  serialcatTestResult.textContent = 'Testing...';
  serialcatTestResult.className = '';

  try {
    const result = await window.api.testSerialCat({ portPath, baudRate, dtrOff });
    if (result.success) {
      serialcatTestResult.textContent = `Connected! Freq: ${result.frequency} MHz`;
      serialcatTestResult.className = 'hamlib-test-success';
    } else {
      serialcatTestResult.textContent = `Failed: ${result.error}`;
      serialcatTestResult.className = 'hamlib-test-fail';
    }
  } catch (err) {
    serialcatTestResult.textContent = `Error: ${err.message}`;
    serialcatTestResult.className = 'hamlib-test-fail';
  } finally {
    serialcatTestBtn.disabled = false;
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
  const continents = getDropdownValues(continentFilterEl);
  const maxAgeSecs = maxAgeMin * 60;
  return allSpots.filter((s) => {
    const sourceOff =
      (s.source === 'pota' && !enablePota) ||
      (s.source === 'sota' && !enableSota) ||
      (s.source === 'dxc' && !enableCluster) ||
      (s.source === 'rbn' && !enableRbn);
    const isWatched = watchlist.has(s.callsign.toUpperCase());

    if (sourceOff) {
      if (!isWatched || spotAgeSecs(s.spotTime) > 300) return false;
    } else {
      if (spotAgeSecs(s.spotTime) > maxAgeSecs) return false;
    }
    if (bands && !bands.has(s.band)) return false;
    if (!modeMatches(s.mode, modes)) return false;
    if (continents && !continents.has(s.continent)) return false;
    if (hideOutOfBand && isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass)) return false;
    if (hideWorked && workedCallsigns.has(s.callsign.toUpperCase())) return false;
    if (hideWorkedParks && s.source === 'pota' && s.reference && workedParksSet.has(s.reference)) return false;
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
const COL_WIDTHS_KEY = 'pota-cat-col-pct-v6';
// Log, Callsign, Freq, Mode, Ref, Name, State, Dist, Heading, Age, Skip
const DEFAULT_COL_PCT = [4, 10, 8, 5, 8, 22, 10, 7, 5, 7, 6];

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

// Cyan teardrop pin for RBN watchlist spots
const rbnIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#00bcd4" stroke="#0097a7" stroke-width="1"/>' +
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

  // Bind tune/QRZ handlers inside popups
  bindPopupClickHandlers(map);

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
  us_advanced: [
    [1800, 2000, 'all'], [3525, 3600, 'cw_digi'], [3700, 4000, 'phone'],
    [7025, 7125, 'cw_digi'], [7125, 7300, 'phone'], [10100, 10150, 'all'],
    [14025, 14150, 'cw_digi'], [14175, 14350, 'phone'], [18068, 18168, 'all'],
    [21025, 21200, 'cw_digi'], [21225, 21450, 'phone'], [24890, 24990, 'all'],
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

const COMPASS_POINTS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

function formatBearing(deg) {
  if (deg == null) return '—';
  const idx = Math.round(deg / 22.5) % 16;
  return deg + '\u00B0 ' + COMPASS_POINTS[idx];
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
    const sourceColor = s.source === 'sota' ? '#f0a500' : s.source === 'dxc' ? '#e040fb' : s.source === 'rbn' ? '#00bcd4' : '#4ecca3';
    const logBtnHtml = enableLogging
      ? ` <button class="log-popup-btn" data-call="${s.callsign}" data-freq="${s.frequency}" data-mode="${s.mode}" data-ref="${s.reference || ''}" data-name="${(s.parkName || '').replace(/"/g, '&quot;')}" data-source="${s.source || ''}">Log</button>`
      : '';
    const mapNewPark = workedParksSet.size > 0 && s.source === 'pota' && s.reference && !workedParksSet.has(s.reference);
    const newBadge = mapNewPark ? ' <span style="background:#4ecca3;color:#000;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">NEW</span>' : '';
    const popupContent = `
      <b>${watched ? '\u2B50 ' : ''}<a href="#" class="popup-qrz" data-call="${s.callsign}">${s.callsign}</a></b> <span style="color:${sourceColor};font-size:11px;">[${sourceLabel}]</span>${newBadge}<br>
      ${parseFloat(s.frequency).toFixed(1)} kHz &middot; ${s.mode}<br>
      <b>${s.reference}</b> ${s.parkName}<br>
      ${distStr}<br>
      <button class="tune-btn" data-freq="${s.frequency}" data-mode="${s.mode}">Tune</button>${logBtnHtml}
    `;

    // Out-of-privilege gets grey/red pin, SOTA gets orange, POTA gets default blue
    const oop = isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass);
    const worked = workedCallsigns.has(s.callsign.toUpperCase());
    const markerOptions = oop
      ? { icon: oopIcon, opacity: 0.4 }
      : s.source === 'sota'
        ? { icon: sotaIcon, ...(worked ? { opacity: 0.5 } : {}) }
        : s.source === 'rbn'
          ? { icon: rbnIcon, ...(worked ? { opacity: 0.5 } : {}) }
          : worked ? { opacity: 0.5 } : {};

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

// Handle popup clicks — Leaflet stops click propagation inside popups,
// so we bind handlers directly when a popup opens instead of delegating to document.
function bindPopupClickHandlers(mapInstance) {
  mapInstance.on('popupopen', (e) => {
    const container = e.popup.getElement();
    if (!container) return;
    container.querySelectorAll('.tune-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.api.tune(btn.dataset.freq, btn.dataset.mode);
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
        const spot = {
          callsign: btn.dataset.call,
          frequency: btn.dataset.freq,
          mode: btn.dataset.mode,
          reference: btn.dataset.ref,
          parkName: btn.dataset.name,
          source: btn.dataset.source,
        };
        openLogPopup(spot);
      });
    });
  });
}

// --- Scan ---
function getScanList() {
  const filtered = sortSpots(getFiltered());
  return filtered.filter((s) => !scanSkipped.has(s.frequency) && !workedCallsigns.has(s.callsign.toUpperCase()));
}

function startScan() {
  const list = getScanList();
  if (list.length === 0) return;
  scanning = true;
  // Resume from the spot matching the radio's current frequency, or start at 0
  scanIndex = 0;
  if (radioFreqKhz !== null) {
    const match = list.findIndex(s => Math.abs(parseFloat(s.frequency) - radioFreqKhz) < 1);
    if (match !== -1) scanIndex = match;
  }
  scanBtn.textContent = 'Stop';
  scanBtn.title = 'Press Stop or Spacebar to stop scanning';
  scanBtn.classList.add('scan-active');
  scanStep();
}

function stopScan() {
  scanning = false;
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  // Flush any buffered spots so table shows latest data
  if (pendingSpots) {
    allSpots = pendingSpots;
    pendingSpots = null;
  }
  scanBtn.textContent = 'Scan';
  scanBtn.title = 'Scan through spots';
  scanBtn.classList.remove('scan-active');
  render();
}

function scanStep() {
  if (!scanning) return;

  // Apply buffered spot updates between dwell steps
  if (pendingSpots) {
    const prevList = getScanList();
    const prevFreq = prevList.length > 0 && scanIndex < prevList.length
      ? prevList[scanIndex].frequency : null;
    allSpots = pendingSpots;
    pendingSpots = null;
    // Re-find position in updated list
    if (prevFreq) {
      const newList = getScanList();
      const idx = newList.findIndex(s => s.frequency === prevFreq);
      if (idx >= 0) scanIndex = idx;
      // if not found, scanIndex stays — will be clamped below
    }
  }

  const list = getScanList();
  if (list.length === 0) { stopScan(); return; }
  if (scanIndex >= list.length) scanIndex = 0;

  const spot = list[scanIndex];
  window.api.tune(spot.frequency, spot.mode);
  render();

  scanTimer = setTimeout(() => {
    scanIndex++;
    scanStep();
  }, scanDwell * 1000);
}

scanBtn.addEventListener('click', () => {
  if (scanning) { stopScan(); } else { startScan(); }
});

document.addEventListener('keydown', (e) => {
  // F2 — Recent QSOs viewer
  if (e.key === 'F2' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    openRecentQsos();
    return;
  }
  if (!scanning) return;
  if (e.code === 'Space' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    stopScan();
  }
});

// --- Recent QSOs (F2) ---
async function openRecentQsos() {
  const dlg = document.getElementById('recent-qsos-dialog');
  const tbody = document.getElementById('recent-qsos-tbody');
  const emptyMsg = document.getElementById('recent-qsos-empty');
  const table = document.getElementById('recent-qsos-table');
  tbody.innerHTML = '';

  const qsos = await window.api.getRecentQsos();
  if (qsos.length === 0) {
    table.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
  } else {
    table.classList.remove('hidden');
    emptyMsg.classList.add('hidden');
    for (const q of qsos) {
      const tr = document.createElement('tr');
      const date = q.qsoDate ? q.qsoDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '';
      const time = q.timeOn ? q.timeOn.slice(0, 2) + ':' + q.timeOn.slice(2, 4) : '';
      tr.innerHTML =
        `<td>${q.call}</td><td>${date}</td><td>${time}</td>` +
        `<td>${q.band}</td><td>${q.mode}</td>` +
        `<td>${q.rstSent}</td><td>${q.rstRcvd}</td>` +
        `<td>${q.comment}</td>`;
      tbody.appendChild(tr);
    }
  }
  // Show log file path
  const pathLink = document.getElementById('recent-qsos-path-link');
  const settings = await window.api.getSettings();
  const logPath = settings.adifLogPath || await window.api.getDefaultLogPath();
  pathLink.textContent = logPath;
  pathLink.onclick = (e) => {
    e.preventDefault();
    window.api.openExternal('file://' + logPath);
  };

  dlg.showModal();
}

document.getElementById('recent-qsos-close').addEventListener('click', () => {
  document.getElementById('recent-qsos-dialog').close();
});
document.getElementById('recent-qsos-close-btn').addEventListener('click', () => {
  document.getElementById('recent-qsos-dialog').close();
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
    setTimeout(() => {
      map.invalidateSize();
      render();
    }, 0);
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
  updateParksStatsOverlay();
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
  updateParksStatsOverlay();

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
      const isWorked = workedCallsigns.has(s.callsign.toUpperCase());
      const isSkipped = scanSkipped.has(s.frequency) || isWorked;

      // Source color-coding
      if (s.source === 'pota') tr.classList.add('spot-pota');
      if (s.source === 'sota') tr.classList.add('spot-sota');
      if (s.source === 'dxc') tr.classList.add('spot-dxc');
      if (s.source === 'rbn') tr.classList.add('spot-rbn');

      // License privilege check
      if (isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass)) {
        tr.classList.add('out-of-privilege');
      }

      // Already-worked check
      if (isWorked) {
        tr.classList.add('already-worked');
      }

      // New park indicator (POTA spot with a reference not in worked parks)
      const isNewPark = workedParksSet.size > 0 && s.source === 'pota' && s.reference && !workedParksSet.has(s.reference);
      if (isNewPark) {
        tr.classList.add('new-park');
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

      // WSJT-X decode indicator — show if this activator was recently decoded
      const wsjtxDecode = enableWsjtx && wsjtxDecodes.find(d => d.isPota && d.dxCall && d.dxCall.toUpperCase() === s.callsign.toUpperCase());
      if (wsjtxDecode) {
        tr.classList.add('wsjtx-heard');
      }

      tr.addEventListener('click', () => {
        if (scanning) stopScan(); // clicking a row stops scan
        window.api.tune(s.frequency, s.mode);
      });

      // Log button cell (first column, hidden unless logging enabled)
      const logTd = document.createElement('td');
      logTd.className = 'log-cell log-col';
      const logButton = document.createElement('button');
      logButton.className = 'log-btn';
      logButton.textContent = 'Log';
      logButton.addEventListener('click', (e) => {
        e.stopPropagation();
        openLogPopup(s);
      });
      logTd.appendChild(logButton);
      tr.appendChild(logTd);

      // Callsign cell — clickable link to QRZ
      const isWatched = watchlist.has(s.callsign.toUpperCase());
      const callTd = document.createElement('td');
      callTd.className = 'callsign-cell';
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
        window.api.openExternal(`https://www.qrz.com/db/${encodeURIComponent(s.callsign.split('/')[0])}`);
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
        { val: s.mode },
        { val: s.reference },
        { val: s.parkName },
        { val: s.locationDesc },
        { val: formatDistance(s.distance) },
        { val: formatBearing(s.bearing), cls: 'bearing-col' },
        { val: formatAge(s.spotTime) },
      ];

      for (const cell of cells) {
        const td = document.createElement('td');
        td.textContent = cell.val;
        if (cell.cls) td.className = cell.cls;
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

    // Auto-scroll to the row being scanned so it stays visible
    if (scanning) {
      const highlighted = tbody.querySelector('.scan-highlight');
      if (highlighted) highlighted.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

// --- QSO Logging ---
const CW_DIGI_MODES_SET = new Set(['CW', 'FT8', 'FT4', 'RTTY', 'DIGI', 'JS8', 'PSK31', 'PSK']);

// Band lookup for ADIF (frequency in kHz → band string)
const BAND_RANGES = [
  [1800, 2000, '160m'], [3500, 4000, '80m'], [5330, 5410, '60m'],
  [7000, 7300, '40m'], [10100, 10150, '30m'], [14000, 14350, '20m'],
  [18068, 18168, '17m'], [21000, 21450, '15m'], [24890, 24990, '12m'],
  [28000, 29700, '10m'], [50000, 54000, '6m'],
];

function freqKhzToBand(khz) {
  const f = parseFloat(khz);
  for (const [lo, hi, band] of BAND_RANGES) {
    if (f >= lo && f <= hi) return band;
  }
  return '';
}

let currentLogSpot = null;

function openLogPopup(spot) {
  currentLogSpot = spot;
  logCallsign.value = spot.callsign || '';
  logFrequency.value = parseFloat(spot.frequency).toFixed(1);

  // Set mode dropdown
  const mode = (spot.mode || '').toUpperCase();
  const modeOption = logMode.querySelector(`option[value="${mode}"]`);
  if (modeOption) {
    logMode.value = mode;
  } else if (mode === 'USB' || mode === 'LSB') {
    logMode.value = mode;
  } else {
    logMode.value = 'SSB';
  }

  // Pre-fill date/time with current UTC
  const now = new Date();
  logDate.value = now.toISOString().slice(0, 10);
  logTime.value = now.toISOString().slice(11, 16);

  // Pre-fill power from settings
  logPower.value = defaultPower || 100;

  // Pre-fill RST based on mode
  const defaultRst = CW_DIGI_MODES_SET.has(mode) ? '599' : '59';
  logRstSent.value = defaultRst;
  logRstRcvd.value = defaultRst;
  updateRstButtons();

  // Show park/summit reference if applicable
  if (spot.reference) {
    const sig = spot.source === 'sota' ? 'SOTA' : spot.source === 'pota' ? 'POTA' : '';
    logRefDisplay.textContent = sig ? `${sig}: ${spot.reference}` : spot.reference;
    if (spot.parkName) logRefDisplay.textContent += ` — ${spot.parkName}`;
    logRefDisplay.classList.remove('hidden');
  } else {
    logRefDisplay.classList.add('hidden');
  }

  logComment.value = '';

  // Re-spot section: only show for POTA spots when myCallsign is set
  const respotSection = document.getElementById('log-respot-section');
  const respotCheckbox = document.getElementById('log-respot');
  const respotComment = document.getElementById('log-respot-comment');
  const respotCommentLabel = document.getElementById('log-respot-comment-label');
  if (spot.source === 'pota' && spot.reference) {
    respotSection.classList.remove('hidden');
    respotCheckbox.checked = respotDefault;
    respotComment.value = respotTemplate;
    respotCommentLabel.style.display = respotCheckbox.checked ? '' : 'none';
    respotCheckbox.onchange = () => {
      respotCommentLabel.style.display = respotCheckbox.checked ? '' : 'none';
    };
  } else {
    respotSection.classList.add('hidden');
  }

  logDialog.showModal();
}

function updateRstButtons() {
  const mode = logMode.value.toUpperCase();
  const isDigiCw = CW_DIGI_MODES_SET.has(mode);
  document.querySelectorAll('#log-dialog .rst-quick-btn').forEach((btn) => {
    const val = btn.dataset.value;
    btn.classList.toggle('active', (isDigiCw && val === '599') || (!isDigiCw && val === '59'));
  });
}

// RST quick-fill buttons
document.querySelectorAll('#log-dialog .rst-quick-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const target = document.getElementById(btn.dataset.target);
    if (target) target.value = btn.dataset.value;
  });
});

// Mode change updates RST defaults
logMode.addEventListener('change', () => {
  const mode = logMode.value.toUpperCase();
  const defaultRst = CW_DIGI_MODES_SET.has(mode) ? '599' : '59';
  logRstSent.value = defaultRst;
  logRstRcvd.value = defaultRst;
  updateRstButtons();
});

// Log dialog close/cancel
logCancelBtn.addEventListener('click', () => logDialog.close());
logDialogClose.addEventListener('click', () => logDialog.close());

// Save QSO
logSaveBtn.addEventListener('click', async () => {
  const callsign = logCallsign.value.trim().toUpperCase();
  const frequency = logFrequency.value.trim();
  const mode = logMode.value;
  const date = logDate.value;
  const time = logTime.value;

  if (!callsign || !frequency || !mode || !date || !time) {
    logCallsign.focus();
    return;
  }

  const qsoDate = date.replace(/-/g, ''); // YYYYMMDD
  const timeOn = time.replace(':', '');     // HHMM
  const band = freqKhzToBand(frequency);

  // Determine SIG/SIG_INFO from spot
  let sig = '';
  let sigInfo = '';
  if (currentLogSpot && currentLogSpot.reference) {
    if (currentLogSpot.source === 'pota') sig = 'POTA';
    else if (currentLogSpot.source === 'sota') sig = 'SOTA';
    sigInfo = currentLogSpot.reference;
  }

  // Re-spot checkbox state
  const respotCheckbox = document.getElementById('log-respot');
  const respotComment = document.getElementById('log-respot-comment');
  const respotSection = document.getElementById('log-respot-section');
  const wantsRespot = !respotSection.classList.contains('hidden') && respotCheckbox.checked;

  // Persist re-spot preference and template
  if (!respotSection.classList.contains('hidden')) {
    respotDefault = respotCheckbox.checked;
    respotTemplate = respotComment.value.trim() || respotTemplate;
    window.api.saveSettings({ respotDefault: respotCheckbox.checked, respotTemplate });
  }

  const qsoData = {
    callsign,
    frequency,
    mode,
    qsoDate,
    timeOn,
    rstSent: logRstSent.value.trim() || '59',
    rstRcvd: logRstRcvd.value.trim() || '59',
    txPower: logPower.value.trim(),
    band,
    sig,
    sigInfo,
    comment: logComment.value.trim(),
    respot: wantsRespot,
    respotComment: wantsRespot ? respotComment.value.trim().replace(/\{rst\}/gi, logRstSent.value.trim() || '59').replace(/\{mycallsign\}/gi, myCallsign) : '',
  };

  logSaveBtn.disabled = true;
  try {
    const result = await window.api.saveQso(qsoData);
    if (result.success) {
      logDialog.close();
      if (result.logbookError) {
        const friendly = result.logbookError.includes('ECONNREFUSED')
          ? 'Could not reach logbook — is it running and configured correctly?'
          : result.logbookError;
        showLogToast(`Logged ${callsign} to ADIF, but logbook forwarding failed: ${friendly}`, { warn: true, duration: 8000 });
      } else if (result.respotError) {
        showLogToast(`Logged ${callsign} to ADIF, but POTA re-spot failed: ${result.respotError}`, { warn: true, duration: 8000 });
      } else if (result.resposted) {
        showLogToast(`Logged ${callsign} — re-spotted on POTA`);
      } else {
        showLogToast(`Logged ${callsign}`);
      }
    } else {
      showLogToast(`Error: ${result.error}`, { warn: true, duration: 5000 });
    }
  } catch (err) {
    showLogToast(`Error: ${err.message}`, { warn: true, duration: 5000 });
  } finally {
    logSaveBtn.disabled = false;
  }
});

function showLogToast(message, opts) {
  const existing = document.querySelector('.log-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'log-toast' + (opts && opts.warn ? ' warn' : '');
  toast.textContent = message;
  document.body.appendChild(toast);
  const duration = (opts && opts.duration) || 2200;
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, duration);
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
      sortAsc = col === 'distance' || col === 'bearing';
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
  setHideWorked.checked = s.hideWorked === true;
  setTuneClick.checked = s.tuneClick === true;
  setVerboseLog.checked = s.verboseLog === true;
  setEnablePota.checked = s.enablePota !== false;
  setEnableSota.checked = s.enableSota === true;
  setEnableCluster.checked = s.enableCluster === true;
  setEnableRbn.checked = s.enableRbn === true;
  setMyCallsign.value = s.myCallsign || '';
  setClusterHost.value = s.clusterHost || 'w3lpl.net';
  setClusterPort.value = s.clusterPort || 7373;
  clusterConfig.classList.toggle('hidden', !s.enableCluster);
  rbnConfig.classList.toggle('hidden', !s.enableRbn);
  setEnableWsjtx.checked = s.enableWsjtx === true;
  setWsjtxPort.value = s.wsjtxPort || 2237;
  setWsjtxHighlight.checked = s.wsjtxHighlight !== false;
  setWsjtxAutoLog.checked = s.wsjtxAutoLog === true;
  wsjtxConfig.classList.toggle('hidden', !s.enableWsjtx);
  setEnableLogging.checked = s.enableLogging === true;
  if (s.adifLogPath) {
    setAdifLogPath.value = s.adifLogPath;
  } else {
    setAdifLogPath.value = await window.api.getDefaultLogPath();
  }
  setDefaultPower.value = s.defaultPower || 100;
  setSendToLogbook.checked = s.sendToLogbook === true;
  setLogbookType.value = s.logbookType || '';
  setLogbookHost.value = s.logbookHost || '127.0.0.1';
  setLogbookPort.value = s.logbookPort || '';
  loggingConfig.classList.toggle('hidden', !s.enableLogging);
  logbookConfig.classList.toggle('hidden', !s.sendToLogbook);
  updateLogbookPortConfig();
  setEnableSolar.checked = s.enableSolar === true;
  setEnableBandActivity.checked = s.enableBandActivity === true;
  setShowBearing.checked = s.showBearing === true;
  setEnableDxcc.checked = s.enableDxcc === true;
  setAdifPath.value = s.adifPath || '';
  adifPicker.classList.toggle('hidden', !s.enableDxcc);
  setPotaParksPath.value = s.potaParksPath || '';
  setHideWorkedParks.checked = s.hideWorkedParks === true;
  setSmartSdrSpots.checked = s.smartSdrSpots === true;
  setSmartSdrHost.value = s.smartSdrHost || '127.0.0.1';
  setSmartSdrPota.checked = s.smartSdrPota !== false;
  setSmartSdrSota.checked = s.smartSdrSota !== false;
  setSmartSdrCluster.checked = s.smartSdrCluster !== false;
  setSmartSdrRbn.checked = s.smartSdrRbn === true;
  smartSdrConfig.classList.toggle('hidden', !s.smartSdrSpots);
  setEnableTelemetry.checked = s.enableTelemetry === true;
  setLightMode.checked = s.lightMode === true;
  hamlibTestResult.textContent = '';
  hamlibTestResult.className = '';
  renderRigList(s.rigs || [], s.activeRigId || null);
  closeRigEditor();
  settingsDialog.showModal();
});

settingsCancel.addEventListener('click', async () => {
  // Revert theme to saved state on cancel
  const s = await window.api.getSettings();
  applyTheme(s.lightMode === true);
  settingsDialog.close();
});

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
  const wsjtxEnabled = setEnableWsjtx.checked;
  const wsjtxPortVal = parseInt(setWsjtxPort.value, 10) || 2237;
  const wsjtxHighlightEnabled = setWsjtxHighlight.checked;
  const wsjtxAutoLogEnabled = setWsjtxAutoLog.checked;
  const solarEnabled = setEnableSolar.checked;
  const bandActivityEnabled = setEnableBandActivity.checked;
  const showBearingEnabled = setShowBearing.checked;
  const dxccEnabled = setEnableDxcc.checked;
  const licenseClassVal = setLicenseClass.value;
  const hideOob = setHideOutOfBand.checked;
  const hideWorkedEnabled = setHideWorked.checked;
  const tuneClickEnabled = setTuneClick.checked;
  const verboseLogEnabled = setVerboseLog.checked;
  const telemetryEnabled = setEnableTelemetry.checked;
  const lightModeEnabled = setLightMode.checked;
  const smartSdrSpotsEnabled = setSmartSdrSpots.checked;
  const smartSdrHostVal = setSmartSdrHost.value.trim() || '127.0.0.1';
  const smartSdrPotaEnabled = setSmartSdrPota.checked;
  const smartSdrSotaEnabled = setSmartSdrSota.checked;
  const smartSdrClusterEnabled = setSmartSdrCluster.checked;
  const smartSdrRbnEnabled = setSmartSdrRbn.checked;
  const adifPath = setAdifPath.value.trim() || '';
  const potaParksPath = setPotaParksPath.value.trim() || '';
  const hideWorkedParksEnabled = setHideWorkedParks.checked;
  const loggingEnabled = setEnableLogging.checked;
  const adifLogPath = setAdifLogPath.value.trim() || '';
  const defaultPowerVal = parseInt(setDefaultPower.value, 10) || 100;
  const sendToLogbook = setSendToLogbook.checked;
  const logbookTypeVal = setLogbookType.value;
  const logbookHostVal = setLogbookHost.value.trim() || '127.0.0.1';
  const logbookPortVal = parseInt(setLogbookPort.value, 10) || 0;

  // Apply rig selection from list
  const selectedRigRadio = document.querySelector('input[name="active-rig"]:checked');
  const selectedRigId = selectedRigRadio ? selectedRigRadio.value : '';
  const selectedRig = selectedRigId ? currentRigs.find(r => r.id === selectedRigId) : null;
  const rigTarget = selectedRig ? selectedRig.catTarget : null;
  window.api.connectCat(rigTarget);

  await window.api.saveSettings({
    rigs: currentRigs,
    activeRigId: selectedRigId || null,
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
    enableWsjtx: wsjtxEnabled,
    wsjtxPort: wsjtxPortVal,
    wsjtxHighlight: wsjtxHighlightEnabled,
    wsjtxAutoLog: wsjtxAutoLogEnabled,
    myCallsign: myCallsign,
    clusterHost: clusterHost,
    clusterPort: clusterPort,
    enableSolar: solarEnabled,
    enableBandActivity: bandActivityEnabled,
    showBearing: showBearingEnabled,
    enableDxcc: dxccEnabled,
    licenseClass: licenseClassVal,
    hideOutOfBand: hideOob,
    hideWorked: hideWorkedEnabled,
    tuneClick: tuneClickEnabled,
    verboseLog: verboseLogEnabled,
    adifPath: adifPath,
    potaParksPath: potaParksPath,
    hideWorkedParks: hideWorkedParksEnabled,
    enableLogging: loggingEnabled,
    adifLogPath: adifLogPath,
    defaultPower: defaultPowerVal,
    sendToLogbook: sendToLogbook,
    logbookType: logbookTypeVal,
    logbookHost: logbookHostVal,
    logbookPort: logbookPortVal,
    enableTelemetry: telemetryEnabled,
    lightMode: lightModeEnabled,
    smartSdrSpots: smartSdrSpotsEnabled,
    smartSdrHost: smartSdrHostVal,
    smartSdrPota: smartSdrPotaEnabled,
    smartSdrSota: smartSdrSotaEnabled,
    smartSdrCluster: smartSdrClusterEnabled,
    smartSdrRbn: smartSdrRbnEnabled,
  });
  distUnit = setDistUnit.value;
  maxAgeMin = maxAgeVal;
  scanDwell = dwellVal;
  watchlist = parseWatchlist(watchlistRaw);
  enablePota = potaEnabled;
  enableSota = sotaEnabled;
  enableCluster = clusterEnabled;
  enableRbn = rbnEnabled;
  enableWsjtx = wsjtxEnabled;
  updateWsjtxStatusVisibility();
  updateClusterStatusVisibility();
  updateRbnStatusVisibility();
  updateRbnButton();
  enableSolar = solarEnabled;
  updateSolarVisibility();
  enableBandActivity = bandActivityEnabled;
  updateBandActivityVisibility();
  showBearing = showBearingEnabled;
  updateBearingVisibility();
  enableLogging = loggingEnabled;
  defaultPower = defaultPowerVal;
  updateLoggingVisibility();
  applyTheme(lightModeEnabled);
  enableDxcc = dxccEnabled;
  licenseClass = licenseClassVal;
  hideOutOfBand = hideOob;
  hideWorked = hideWorkedEnabled;
  hideWorkedParks = hideWorkedParksEnabled;
  tuneClick = tuneClickEnabled;
  catLogToggleBtn.classList.toggle('hidden', !verboseLogEnabled);
  if (!verboseLogEnabled) {
    catLogPanel.classList.add('hidden');
    catLogToggleBtn.classList.remove('active');
    document.body.classList.remove('cat-log-open');
  }
  activeRigName = selectedRig ? selectedRig.name : '';
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
  if (scanning) {
    pendingSpots = spots;
    lastRefreshEl.textContent = `Updated ${new Date().toISOString().slice(11, 19)}z`;
    return;
  }
  allSpots = spots;
  lastRefreshEl.textContent = `Updated ${new Date().toISOString().slice(11, 19)}z`;
  render();
});

window.api.onSpotsError((msg) => {
  lastRefreshEl.textContent = `Error: ${msg}`;
});

let catConnected = false; // track CAT state for WSJT-X tune decisions

window.api.onCatStatus(({ connected, error, wsjtxMode }) => {
  catConnected = connected;
  if (wsjtxMode) {
    catStatusEl.textContent = 'CAT';
    catStatusEl.className = 'status connected';
    catStatusEl.title = 'Radio controlled by WSJT-X';
    return;
  }
  catStatusEl.textContent = 'CAT';
  catStatusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
  catStatusEl.title = connected
    ? (activeRigName ? `Connected to ${activeRigName}` : 'Connected')
    : (error || 'Disconnected');
});

// --- Update available listener ---
window.api.onUpdateAvailable(({ version, url, headline }) => {
  const banner = document.getElementById('update-banner');
  const message = document.getElementById('update-message');
  const updateLink = document.getElementById('update-link');
  const supportLink = document.getElementById('support-link');
  const dismissBtn = document.getElementById('update-dismiss');

  message.textContent = headline
    ? `v${version}: ${headline}`
    : `POTA CAT v${version} is available!`;
  updateLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal(url);
  });
  supportLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal('https://buymeacoffee.com/potacat');
  });
  dismissBtn.addEventListener('click', () => {
    banner.classList.add('hidden');
  });
  banner.classList.remove('hidden');
});

// --- Worked callsigns listener ---
window.api.onWorkedCallsigns((list) => {
  workedCallsigns = new Set(list);
  render();
});

// --- Worked parks listener ---
window.api.onWorkedParks((entries) => {
  workedParksSet = new Set();
  workedParksData = new Map();
  if (entries && entries.length > 0) {
    for (const [ref, data] of entries) {
      workedParksSet.add(ref);
      workedParksData.set(ref, data);
    }
  }
  updateParksStatsOverlay();
  render();
});

function updateParksStatsOverlay() {
  if (!parksStatsOverlay) return;

  // Show/hide the toggle button based on whether CSV is loaded
  const hasData = workedParksData.size > 0;
  parksStatsToggleBtn.classList.toggle('hidden', !hasData);

  // Panel visibility: only when toggled open, has data, and on table/map view
  if (!parksStatsOpen || !hasData || (currentView !== 'table' && currentView !== 'map')) {
    parksStatsOverlay.classList.add('hidden');
    parksStatsToggleBtn.classList.remove('active');
    return;
  }

  parksStatsOverlay.classList.remove('hidden');
  parksStatsToggleBtn.classList.add('active');

  // Total parks
  parksStatsTotal.textContent = workedParksData.size.toLocaleString();

  // Total QSOs
  let totalQsos = 0;
  const locations = new Set();
  for (const [, data] of workedParksData) {
    totalQsos += data.qsoCount || 0;
    if (data.location) locations.add(data.location);
  }
  parksStatsQsos.textContent = totalQsos.toLocaleString();
  parksStatsLocations.textContent = locations.size.toLocaleString();

  // New parks on air right now — POTA spots whose reference is NOT in worked set
  let newOnAir = 0;
  const seenRefs = new Set();
  for (const s of allSpots) {
    if (s.source === 'pota' && s.reference && !seenRefs.has(s.reference)) {
      seenRefs.add(s.reference);
      if (!workedParksSet.has(s.reference)) newOnAir++;
    }
  }
  parksStatsNewNow.textContent = newOnAir;
}

parksStatsToggleBtn.addEventListener('click', () => {
  parksStatsOpen = !parksStatsOpen;
  updateParksStatsOverlay();
});

parksStatsCloseBtn.addEventListener('click', () => {
  parksStatsOpen = false;
  updateParksStatsOverlay();
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

// --- WSJT-X listeners ---
window.api.onWsjtxStatus(({ connected }) => {
  wsjtxStatusEl.textContent = 'WSJT-X';
  wsjtxStatusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
  if (enableWsjtx) wsjtxStatusEl.classList.remove('hidden');
  if (!connected) {
    wsjtxDecodes = [];
    wsjtxState = null;
  }
});

window.api.onWsjtxState((state) => {
  wsjtxState = state;
});

window.api.onWsjtxDecode((decode) => {
  // Check if this decode's dxCall matches any active POTA spot
  if (decode.dxCall) {
    const upper = decode.dxCall.toUpperCase();
    const matchingSpot = allSpots.find(s => s.source === 'pota' && s.callsign.toUpperCase() === upper);
    if (matchingSpot) {
      decode.isPota = true;
      decode.reference = matchingSpot.reference;
      decode.parkName = matchingSpot.parkName;
    }
  }
  wsjtxDecodes.push(decode);
  if (wsjtxDecodes.length > 50) wsjtxDecodes.shift();
  if (currentView === 'table') render();
});

window.api.onWsjtxClear(() => {
  wsjtxDecodes = [];
  if (currentView === 'table') render();
});

window.api.onWsjtxQsoLogged((qso) => {
  // Show a toast when WSJT-X logs a QSO
  const freqMHz = (qso.txFrequency / 1e6).toFixed(3);
  showLogToast(`WSJT-X logged ${qso.dxCall} on ${freqMHz} MHz ${qso.mode}`);
});

// --- Radio frequency tracking ---
window.api.onCatFrequency((hz) => {
  const newKhz = Math.round(hz / 1000);
  if (newKhz === radioFreqKhz) return;
  radioFreqKhz = newKhz;
  playTuneClick();
  if (currentView === 'table') render();
});

// --- CAT Log Panel ---
const catLogPanel = document.getElementById('cat-log-panel');
const catLogOutput = document.getElementById('cat-log-output');
const catLogCopyBtn = document.getElementById('cat-log-copy');
const catLogClearBtn = document.getElementById('cat-log-clear');
const catLogToggleBtn = document.getElementById('cat-log-toggle');
const catLogLines = [];
const CAT_LOG_MAX = 500;

window.api.onCatLog((msg) => {
  console.log(msg);
  catLogLines.push(msg);
  if (catLogLines.length > CAT_LOG_MAX) catLogLines.shift();
  catLogOutput.value = catLogLines.join('\n');
  catLogOutput.scrollTop = catLogOutput.scrollHeight;
});

catLogToggleBtn.addEventListener('click', () => {
  const isHidden = catLogPanel.classList.toggle('hidden');
  catLogToggleBtn.classList.toggle('active', !isHidden);
  document.body.classList.toggle('cat-log-open', !isHidden);
});

catLogCopyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(catLogOutput.value).then(() => {
    catLogCopyBtn.textContent = 'Copied!';
    setTimeout(() => { catLogCopyBtn.textContent = 'Copy'; }, 1500);
  });
});

catLogClearBtn.addEventListener('click', () => {
  catLogLines.length = 0;
  catLogOutput.value = '';
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

  // Bind QRZ handlers inside popups
  bindPopupClickHandlers(rbnMap);

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
      <span class="help-text">${formatAge(s.spotTime)}</span>
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
      window.api.openExternal(`https://www.qrz.com/db/${encodeURIComponent(s.spotter.split('/')[0])}`);
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
document.getElementById('coffee-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://buymeacoffee.com/potacat');
});
document.getElementById('discord-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://discord.gg/JjdKSshej');
});
document.getElementById('welcome-discord-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://discord.gg/JjdKSshej');
});
document.getElementById('welcome-coffee-btn').addEventListener('click', () => {
  window.api.openExternal('https://buymeacoffee.com/potacat');
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
const welcomeLightMode = document.getElementById('welcome-light-mode');
const welcomeCallsignInput = document.getElementById('welcome-callsign');
const welcomeWatchlistInput = document.getElementById('welcome-watchlist');

welcomeLightMode.addEventListener('change', () => applyTheme(welcomeLightMode.checked));

// Pre-fill watchlist with callsign as user types
welcomeCallsignInput.addEventListener('input', () => {
  const call = welcomeCallsignInput.value.trim().toUpperCase();
  if (call && !welcomeWatchlistInput.value.trim()) {
    welcomeWatchlistInput.placeholder = `${call}, K4SWL, KI6NAZ`;
  } else if (!call) {
    welcomeWatchlistInput.placeholder = 'K3SBP, K4SWL, KI6NAZ';
  }
});

document.getElementById('welcome-start').addEventListener('click', async () => {
  const myCallsign = (welcomeCallsignInput.value.trim() || '').toUpperCase();
  const grid = welcomeGridInput.value.trim() || 'FN20jb';
  const distUnitVal = document.getElementById('welcome-dist-unit').value;
  const licenseClassVal = document.getElementById('welcome-license-class').value;
  const watchlistVal = welcomeWatchlistInput.value.trim();
  const enablePotaVal = document.getElementById('welcome-enable-pota').checked;
  const enableSotaVal = document.getElementById('welcome-enable-sota').checked;
  const telemetryOptIn = document.getElementById('welcome-telemetry').checked;
  const lightModeEnabled = welcomeLightMode.checked;
  const currentSettings = await window.api.getSettings();

  await window.api.saveSettings({
    myCallsign,
    grid,
    distUnit: distUnitVal,
    licenseClass: licenseClassVal,
    watchlist: watchlistVal,
    firstRun: false,
    lastVersion: currentSettings.appVersion,
    maxAgeMin: 5,
    scanDwell: 7,
    enablePota: enablePotaVal,
    enableSota: enableSotaVal,
    enableTelemetry: telemetryOptIn,
    lightMode: lightModeEnabled,
  });

  welcomeDialog.close();
  // Reload prefs so the main UI reflects welcome choices
  loadPrefs();
});

async function checkFirstRun() {
  const s = await window.api.getSettings();
  const isNewVersion = s.appVersion && s.lastVersion !== s.appVersion;
  if (s.firstRun || isNewVersion) {
    // Pre-fill with existing settings on upgrade (not fresh install)
    if (!s.firstRun) {
      welcomeCallsignInput.value = s.myCallsign || '';
      welcomeGridInput.value = s.grid || '';
      welcomeWatchlistInput.value = s.watchlist || '';
      if (s.distUnit) document.getElementById('welcome-dist-unit').value = s.distUnit;
      if (s.licenseClass) document.getElementById('welcome-license-class').value = s.licenseClass;
      document.getElementById('welcome-enable-pota').checked = s.enablePota !== false;
      document.getElementById('welcome-enable-sota').checked = s.enableSota === true;
      document.getElementById('welcome-telemetry').checked = s.enableTelemetry === true;
      welcomeLightMode.checked = s.lightMode === true;
    }
    welcomeDialog.showModal();
  }
}

// Init
loadPrefs().then(() => {
  render();
  checkFirstRun();
});
initColumnResizing();
