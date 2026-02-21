// Renderer process — UI logic
// Leaflet is loaded via <script> tag in index.html and exposes window.L

let allSpots = [];
let sortCol = 'distance';
let sortAsc = true;

// Expose for DevTools console debugging
window._debug = { get spots() { return allSpots; }, get qrz() { return qrzData; }, get expeditions() { return expeditionCallsigns; }, render() { render(); } };
let currentView = 'table'; // 'table', 'map', 'dxcc', or 'rbn' (for exclusive views)
let showTable = true;
let showMap = false;
let splitOrientation = 'horizontal'; // 'horizontal' (side-by-side) or 'vertical' (stacked)
let enableSplitView = true; // allow Table+Map simultaneously

// User preferences (loaded from settings)
let distUnit = 'mi';    // 'mi' or 'km'
let watchlist = new Set(); // uppercase callsigns
let maxAgeMin = 5;       // max spot age in minutes
let scanDwell = 7;       // seconds per frequency during scan
let enablePota = true;
let enableSota = false;
let enableWwff = false;
let enableLlota = false;
let enableDxcc = false;
let enableCluster = false;
let enableRbn = false;
let enablePskr = false;
let enableSolar = false;
let enableBandActivity = false;
let licenseClass = 'none';
let hideOutOfBand = false;
let enableLogging = false;
let defaultPower = 100;
let tuneClick = false;
let enableSplit = false;
let activeRigName = ''; // name of the currently active rig profile
let workedCallsigns = new Set(); // uppercase callsigns from QSO log
let donorCallsigns = new Set(); // supporter callsigns from potacat.com
let expeditionCallsigns = new Set(); // active DX expeditions from Club Log
let hideWorked = false;
let workedParksSet = new Set(); // park references from CSV for fast lookup
let workedParksData = new Map(); // reference → full park data for stats
let hideWorkedParks = false;
let showBearing = false;
let respotDefault = true; // default: re-spot on POTA after logging
let respotTemplate = 'Thanks for {rst}. 73s {mycallsign} via POTACAT'; // re-spot comment template
let myCallsign = '';
let popoutOpen = false; // pop-out map window is open
let dxccData = null;  // { entities: [...] } from main process
let enableWsjtx = false;
let wsjtxDecodes = []; // recent decodes from WSJT-X (FIFO, max 50)
let wsjtxState = null; // last WSJT-X status (freq, mode, etc.)
const qrzData = new Map(); // callsign → { fname, name, addr2, state, country }
let qrzFullName = false; // show first+last or just first

/** Clean up QRZ name: title-case, drop trailing single-letter initial */
function cleanQrzName(raw) {
  if (!raw) return '';
  const parts = raw.trim().split(/\s+/);
  // Drop trailing single-letter initial (e.g. "Larry P" → "Larry", "Larry P." → "Larry")
  // But keep leading single letter (e.g. "J Doug" stays)
  if (parts.length > 1 && /^[A-Za-z]\.?$/.test(parts[parts.length - 1])) {
    parts.pop();
  }
  // Title-case each part: first letter upper, rest lower
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

/** Build display name from QRZ info, respecting full-name setting.
 *  Prefers nickname over fname when available. */
function qrzDisplayName(info) {
  if (!info) return '';
  const first = cleanQrzName(info.nickname) || cleanQrzName(info.fname);
  if (!qrzFullName) return first || cleanQrzName(info.name);
  const last = cleanQrzName(info.name);
  return [first, last].filter(Boolean).join(' ');
}

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
const spotsDropdown = document.getElementById('spots-dropdown');
const spotsBtn = document.getElementById('spots-btn');
const spotsPota = document.getElementById('spots-pota');
const spotsSota = document.getElementById('spots-sota');
const spotsWwff = document.getElementById('spots-wwff');
const spotsLlota = document.getElementById('spots-llota');
const spotsCluster = document.getElementById('spots-cluster');
const spotsRbn = document.getElementById('spots-rbn');
const spotsPskr = document.getElementById('spots-pskr');
const spotsHideWorked = document.getElementById('spots-hide-worked');
const spotsHideParks = document.getElementById('spots-hide-parks');
const spotsHideParksLabel = document.getElementById('spots-hide-parks-label');
const spotsHideOob = document.getElementById('spots-hide-oob');
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
const setEnableWwff = document.getElementById('set-enable-wwff');
const setEnableLlota = document.getElementById('set-enable-llota');
const setCwXit = document.getElementById('set-cw-xit');
const setCwFilter = document.getElementById('set-cw-filter');
const setSsbFilter = document.getElementById('set-ssb-filter');
const setDigitalFilter = document.getElementById('set-digital-filter');
const setNotifyPopup = document.getElementById('set-notify-popup');
const setNotifySound = document.getElementById('set-notify-sound');
const setNotifyTimeout = document.getElementById('set-notify-timeout');
const setLicenseClass = document.getElementById('set-license-class');
const setHideOutOfBand = document.getElementById('set-hide-out-of-band');
const setHideWorked = document.getElementById('set-hide-worked');
const setTuneClick = document.getElementById('set-tune-click');
const setEnableSplit = document.getElementById('set-enable-split');
const setEnableRotor = document.getElementById('set-enable-rotor');
const rotorConfig = document.getElementById('rotor-config');
const setRotorHost = document.getElementById('set-rotor-host');
const setRotorPort = document.getElementById('set-rotor-port');
const setVerboseLog = document.getElementById('set-verbose-log');
const setEnableSplitView = document.getElementById('set-enable-split-view');
const splitOrientationConfig = document.getElementById('split-orientation-config');
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
const splitContainerEl = document.getElementById('split-container');
const tablePaneEl = document.getElementById('table-pane');
const mapPaneEl = document.getElementById('map-pane');
const splitSplitterEl = document.getElementById('split-splitter');
const viewTableBtn = document.getElementById('view-table-btn');
const viewMapBtn = document.getElementById('view-map-btn');
const popoutMapBtn = document.getElementById('popout-map-btn');
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
const setEnablePskr = document.getElementById('set-enable-pskr');
const pskrConfig = document.getElementById('pskr-config');
const setMyCallsign = document.getElementById('set-my-callsign');
const setClusterHost = document.getElementById('set-cluster-host');
const setClusterPort = document.getElementById('set-cluster-port');
const clusterConfig = document.getElementById('cluster-config');
const rbnConfig = document.getElementById('rbn-config');
// Settings connection pills
const connBar = document.getElementById('settings-conn-status');
const connCluster = document.getElementById('conn-cluster');
const connRbn = document.getElementById('conn-rbn');
const connPskr = document.getElementById('conn-pskr');
let clusterConnected = false;
let rbnConnected = false;
let pskrConnected = false;
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
const setDisableAutoUpdate = document.getElementById('set-disable-auto-update');
const setEnableTelemetry = document.getElementById('set-enable-telemetry');
const setLightMode = document.getElementById('set-light-mode');
setLightMode.addEventListener('change', () => applyTheme(setLightMode.checked));
const setEnableQrz = document.getElementById('set-enable-qrz');
const qrzConfig = document.getElementById('qrz-config');
const setQrzUsername = document.getElementById('set-qrz-username');
const setQrzPassword = document.getElementById('set-qrz-password');
const setQrzFullName = document.getElementById('set-qrz-full-name');
const setSmartSdrSpots = document.getElementById('set-smartsdr-spots');
const smartSdrConfig = document.getElementById('smartsdr-config');
const setSmartSdrHost = document.getElementById('set-smartsdr-host');
const setSmartSdrPota = document.getElementById('set-smartsdr-pota');
const setSmartSdrSota = document.getElementById('set-smartsdr-sota');
const setSmartSdrCluster = document.getElementById('set-smartsdr-cluster');
const setSmartSdrRbn = document.getElementById('set-smartsdr-rbn');
const setSmartSdrWwff = document.getElementById('set-smartsdr-wwff');
const setSmartSdrLlota = document.getElementById('set-smartsdr-llota');
const setSmartSdrPskr = document.getElementById('set-smartsdr-pskr');
const setSmartSdrMaxAge = document.getElementById('set-smartsdr-max-age');
const logDialog = document.getElementById('log-dialog');
const logCallsign = document.getElementById('log-callsign');
const logOpName = document.getElementById('log-op-name');
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
  enableWwff = settings.enableWwff === true;  // default false
  enableLlota = settings.enableLlota === true; // default false
  enableDxcc = settings.enableDxcc === true;  // default false
  enableCluster = settings.enableCluster === true; // default false
  enableRbn = settings.enableRbn === true; // default false
  enablePskr = settings.enablePskr === true; // default false
  enableSolar = settings.enableSolar === true;   // default false
  enableBandActivity = settings.enableBandActivity === true; // default false
  updateSolarVisibility();
  qrzFullName = settings.qrzFullName === true;
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
  enableSplit = settings.enableSplit === true;
  catLogToggleBtn.classList.toggle('hidden', settings.verboseLog !== true);
  // Resolve active rig name
  const rigs = settings.rigs || [];
  const activeRig = rigs.find(r => r.id === settings.activeRigId);
  activeRigName = activeRig ? activeRig.name : '';
  enableWsjtx = settings.enableWsjtx === true;
  updateWsjtxStatusVisibility();
  updateRbnButton();
  updateDxccButton();
  // maxAgeMin: prefer localStorage (last-used filter) over settings.json
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY));
    if (saved && saved.maxAgeMin) { maxAgeMin = saved.maxAgeMin; }
    else { maxAgeMin = parseInt(settings.maxAgeMin, 10) || 5; }
  } catch { maxAgeMin = parseInt(settings.maxAgeMin, 10) || 5; }
  updateHeaders();

  // Restore view state
  splitOrientation = settings.splitOrientation || 'horizontal';
  enableSplitView = settings.enableSplitView !== false;
  try {
    const viewState = JSON.parse(localStorage.getItem(VIEW_STATE_KEY));
    if (viewState) {
      if (viewState.sortCol) { sortCol = viewState.sortCol; }
      if (typeof viewState.sortAsc === 'boolean') { sortAsc = viewState.sortAsc; }
      if (viewState.lastView === 'rbn' && enableRbn) {
        setView('rbn');
      } else if (viewState.lastView === 'dxcc' && enableDxcc) {
        setView('dxcc');
      } else {
        showTable = viewState.showTable !== false;
        showMap = viewState.showMap === true;
        if (!showTable && !showMap) showTable = true;
        currentView = showTable ? 'table' : 'map';
        updateViewLayout();
      }
    } else {
      updateViewLayout();
    }
  } catch {
    updateViewLayout();
  }
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

function updateWsjtxStatusVisibility() {
  wsjtxStatusEl.classList.toggle('hidden', !enableWsjtx);
}

function updateSettingsConnBar() {
  const anyVisible = enableCluster || enableRbn || enablePskr;
  connBar.classList.toggle('hidden', !anyVisible);
  connCluster.classList.toggle('hidden', !enableCluster);
  connCluster.classList.toggle('connected', clusterConnected);
  connRbn.classList.toggle('hidden', !enableRbn);
  connRbn.classList.toggle('connected', rbnConnected);
  connPskr.classList.toggle('hidden', !enablePskr);
  connPskr.classList.toggle('connected', pskrConnected);
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
// QRZ checkbox toggles QRZ config visibility
setEnableQrz.addEventListener('change', () => {
  qrzConfig.classList.toggle('hidden', !setEnableQrz.checked);
});

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

setEnablePskr.addEventListener('change', () => {
  pskrConfig.classList.toggle('hidden', !setEnablePskr.checked);
});

// PstRotator checkbox toggles rotor config visibility
setEnableRotor.addEventListener('change', () => {
  rotorConfig.classList.toggle('hidden', !setEnableRotor.checked);
});

// Split view checkbox toggles orientation config visibility
setEnableSplitView.addEventListener('change', () => {
  splitOrientationConfig.classList.toggle('hidden', !setEnableSplitView.checked);
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
    instructions: 'In Log4OM 2: Settings > Program Configuration > Software Integration > ADIF Functions. In the ADIF Monitor tab, check "Enable ADIF monitor". Click the folder icon next to "ADIF file" and select the same ADIF log file used in POTACAT. Press the green + button to add it to the list, then press "Save and apply". Log4OM will automatically import new QSOs as they are saved.',
  },
  dxkeeper: { port: 52001, help: 'In DXKeeper: Configuration > Defaults tab > Network Service panel. The default base port is 52000 (DXKeeper listens on base + 1 = 52001). DXKeeper must be running to receive QSOs. QSOs will be logged with missing fields auto-deduced from callbook/entity databases.' },
  n3fjp: { port: 1100, help: 'In N3FJP: Settings > Application Program Interface > check "TCP API Enabled". Set the port to 1100 (default). N3FJP must be running to receive QSOs.' },
  hrd: { port: 2333, help: 'In HRD Logbook: Tools > Configure > QSO Forwarding. Under UDP Receive, check "Receive QSO notifications using UDP9/ADIF from other logging programs (eg. WSJT-X)". Set the receive port to 2333 and select your target database. POTACAT and WSJT-X can both send to this port simultaneously.' },
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
      (s.source === 'wwff' && !enableWwff) ||
      (s.source === 'llota' && !enableLlota) ||
      (s.source === 'dxc' && !enableCluster) ||
      (s.source === 'rbn' && !enableRbn) ||
      (s.source === 'pskr' && !enablePskr);
    const isWatched = watchlist.has(s.callsign.toUpperCase());

    if (sourceOff) {
      if (!isWatched || spotAgeSecs(s.spotTime) > 300) return false;
    } else if (s.source === 'pskr') {
      // PSKReporter already limits to 15 min server-side; don't apply client max-age
      if (spotAgeSecs(s.spotTime) > 900) return false;
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
    // Pin DX expeditions to the top
    const aExp = expeditionCallsigns.has(a.callsign.toUpperCase()) ? 1 : 0;
    const bExp = expeditionCallsigns.has(b.callsign.toUpperCase()) ? 1 : 0;
    if (aExp !== bExp) return bExp - aExp;

    let va = a[sortCol];
    let vb = b[sortCol];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') {
      return sortAsc ? va - vb : vb - va;
    }
    // Numeric strings (e.g. frequency "7268") — compare as numbers
    const na = Number(va), nb = Number(vb);
    if (!isNaN(na) && !isNaN(nb)) {
      return sortAsc ? na - nb : nb - na;
    }
    va = String(va);
    vb = String(vb);
    return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
  });
}

// --- Column Resizing ---
// --- Column Visibility (right-click header to toggle) ---
const HIDDEN_COLS_KEY = 'pota-cat-hidden-cols';
const HIDEABLE_COLUMNS = [
  { key: 'operator', label: 'Operator' },
  { key: 'frequency', label: 'Freq (kHz)' },
  { key: 'mode', label: 'Mode' },
  { key: 'reference', label: 'Ref' },
  { key: 'parkName', label: 'Name' },
  { key: 'locationDesc', label: 'State' },
  { key: 'distance', label: 'Distance' },
  { key: 'spotTime', label: 'Age' },
  { key: 'comments', label: 'Comments' },
  { key: 'skip', label: 'Skip' },
];

let hiddenColumns = new Set();

function loadHiddenColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_COLS_KEY));
    if (Array.isArray(saved)) return new Set(saved);
  } catch { /* ignore */ }
  // Default: hide comments column on fresh install
  return new Set(['comments']);
}

function saveHiddenColumns() {
  localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify([...hiddenColumns]));
}

function applyHiddenColumns() {
  for (const col of HIDEABLE_COLUMNS) {
    spotsTable.classList.toggle('hide-col-' + col.key, hiddenColumns.has(col.key));
  }
}

// Context menu
const colContextMenu = document.getElementById('col-context-menu');

function showColContextMenu(x, y) {
  colContextMenu.innerHTML = '<div class="col-ctx-title">Show Columns</div>';
  for (const col of HIDEABLE_COLUMNS) {
    const item = document.createElement('label');
    item.className = 'col-ctx-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !hiddenColumns.has(col.key);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        hiddenColumns.delete(col.key);
      } else {
        hiddenColumns.add(col.key);
      }
      saveHiddenColumns();
      applyHiddenColumns();
    });
    item.appendChild(cb);
    item.appendChild(document.createTextNode(col.label));
    colContextMenu.appendChild(item);
  }
  // Position within viewport
  colContextMenu.classList.remove('hidden');
  const menuW = colContextMenu.offsetWidth;
  const menuH = colContextMenu.offsetHeight;
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 4;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 4;
  colContextMenu.style.left = x + 'px';
  colContextMenu.style.top = y + 'px';
}

spotsTable.querySelector('thead').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showColContextMenu(e.clientX, e.clientY);
});

document.addEventListener('mousedown', (e) => {
  if (!colContextMenu.contains(e.target)) {
    colContextMenu.classList.add('hidden');
  }
});

// Load on init
hiddenColumns = loadHiddenColumns();
applyHiddenColumns();

// --- Compact mode for narrow table pane ---
const COMPACT_THRESHOLD = 600; // px
let isCompact = false;

const HEADER_LABELS = {
  callsign: { full: 'Callsign', compact: 'Call' },
  operator: { full: 'Operator', compact: 'Op' },
  frequency: { full: 'Freq (kHz)', compact: 'Freq' },
  locationDesc: { full: 'State', compact: 'St' },
  parkName: { full: 'Name', compact: 'Name' },
};

function updateCompactMode(width) {
  const compact = width < COMPACT_THRESHOLD;
  if (compact === isCompact) return;
  isCompact = compact;
  spotsTable.classList.toggle('compact', compact);
  // Update header text
  const ths = spotsTable.querySelectorAll('thead th[data-col]');
  ths.forEach(th => {
    const col = th.getAttribute('data-col');
    const labels = HEADER_LABELS[col];
    if (labels) {
      // Preserve sort indicator — only update first text node
      th.childNodes[0].textContent = compact ? labels.compact : labels.full;
    }
  });
}

const tableResizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    updateCompactMode(entry.contentRect.width);
  }
});
tableResizeObserver.observe(tablePaneEl);

// Invalidate Leaflet map size when map pane resizes (maximize, splitter drag, window resize)
let mapResizeRaf = null;
const mapResizeObserver = new ResizeObserver(() => {
  if (mapResizeRaf) cancelAnimationFrame(mapResizeRaf);
  mapResizeRaf = requestAnimationFrame(() => {
    if (map) map.invalidateSize();
    mapResizeRaf = null;
  });
});
mapResizeObserver.observe(mapPaneEl);

// --- Column Resizing ---
// Widths stored as percentages of table width so they always fit
const COL_WIDTHS_KEY = 'pota-cat-col-pct-v8';
// Log, Callsign, Operator, Freq, Mode, Ref, Name, State, Dist, Heading, Age, Comments, Skip
const DEFAULT_COL_PCT = [4, 8, 7, 6, 5, 6, 16, 8, 6, 5, 5, 10, 4];

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

// Teal teardrop pin for WWFF spots
const wwffIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#26a69a" stroke="#1b7a71" stroke-width="1"/>' +
    '<circle cx="12.5" cy="12.5" r="5.5" fill="#fff" opacity="0.4"/>' +
    '</svg>',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

// Blue teardrop pin for LLOTA spots
const llotaIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#42a5f5" stroke="#1e88e5" stroke-width="1"/>' +
    '<circle cx="12.5" cy="12.5" r="5.5" fill="#fff" opacity="0.4"/>' +
    '</svg>',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

// Green teardrop pin for POTA spots
const potaIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#4ecca3" stroke="#3ba882" stroke-width="1"/>' +
    '<circle cx="12.5" cy="12.5" r="5.5" fill="#fff" opacity="0.4"/>' +
    '</svg>',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

// Purple teardrop pin for DX Cluster spots
const dxcIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#e040fb" stroke="#ab00d9" stroke-width="1"/>' +
    '<circle cx="12.5" cy="12.5" r="5.5" fill="#fff" opacity="0.4"/>' +
    '</svg>',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

// Coral teardrop pin for PSKReporter/FreeDV spots
const pskrIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#ff6b6b" stroke="#d84343" stroke-width="1"/>' +
    '<circle cx="12.5" cy="12.5" r="5.5" fill="#fff" opacity="0.4"/>' +
    '</svg>',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

// Bright red teardrop pin with gold star for DX expeditions
const expeditionIcon = L.divIcon({
  className: '',
  html: '<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="#ff1744" stroke="#d50000" stroke-width="1"/>' +
    '<polygon points="12.5,5 14.5,10.5 20,10.5 15.5,14 17.5,19.5 12.5,16 7.5,19.5 9.5,14 5,10.5 10.5,10.5" fill="#ffd600" stroke="#ff9800" stroke-width="0.5"/>' +
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
let mainHomePos = null; // { lat, lon } for tune arc drawing
let tuneArcLayers = []; // polylines showing arc from QTH to tuned station
let tuneArcFreq = null; // frequency string of the spot the arc points to

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

const MAP_STATE_KEY = 'pota-cat-map-state';
let _mapSaveTimer = null;

function initMap() {
  // Restore saved map center/zoom or use defaults
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

  markerLayer = L.layerGroup().addTo(map);

  // Bind tune/QRZ handlers inside popups
  bindPopupClickHandlers(map);

  // Add home marker
  updateHomeMarker();

  // Add day/night overlay and refresh every 60s
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

async function updateHomeMarker() {
  const settings = await window.api.getSettings();
  const grid = settings.grid || 'FN20jb';
  const pos = gridToLatLonLocal(grid);
  if (!pos) return;
  mainHomePos = { lat: pos.lat, lon: pos.lon };

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

function clearTuneArc() {
  for (const l of tuneArcLayers) map.removeLayer(l);
  tuneArcLayers = [];
  tuneArcFreq = null;
}

function tuneArcColor(source) {
  if (source === 'sota') return '#f0a500';
  if (source === 'dxc') return '#e040fb';
  if (source === 'rbn') return '#00bcd4';
  if (source === 'wwff') return '#26a69a';
  if (source === 'llota') return '#42a5f5';
  if (source === 'pskr') return '#ff6b6b';
  return '#4ecca3'; // pota / default
}

function showTuneArc(lat, lon, freq, source) {
  // Forward to pop-out map
  sendPopoutTuneArc(lat, lon, freq, source);

  if (!map || !mainHomePos || lat == null || lon == null) return;
  clearTuneArc();
  tuneArcFreq = freq || null;
  const color = tuneArcColor(source);
  const arcPoints = greatCircleArc(mainHomePos.lat, mainHomePos.lon, lat, lon, 200);
  // Split into segments at longitude discontinuities (antimeridian or polar traversals)
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

  // If a popup is open and its callsign is still in the filtered list, skip rebuild
  // to avoid flash/flicker from the 2s cluster/RBN flush cycles
  let hasOpenPopup = false;
  markerLayer.eachLayer((layer) => {
    if (layer.getPopup && layer.getPopup() && layer.getPopup().isOpen()) {
      const call = layer._spotCallsign;
      if (call && filtered.some(s => s.callsign === call)) {
        hasOpenPopup = true;
      }
    }
  });
  if (hasOpenPopup) return;

  markerLayer.clearLayers();

  // Clear tune arc if the tuned spot no longer exists
  if (tuneArcFreq && !filtered.some(s => s.frequency === tuneArcFreq)) {
    clearTuneArc();
    tuneArcFreq = null;
  }

  const unit = distUnit === 'km' ? 'km' : 'mi';

  for (const s of filtered) {
    if (s.lat == null || s.lon == null) continue;

    const distStr = s.distance != null ? formatDistance(s.distance) + ' ' + unit : '';
    const watched = watchlist.has(s.callsign.toUpperCase());

    const sourceLabel = (s.source || 'pota').toUpperCase();
    const sourceColor = s.source === 'sota' ? '#f0a500' : s.source === 'dxc' ? '#e040fb' : s.source === 'rbn' ? '#00bcd4' : s.source === 'wwff' ? '#26a69a' : s.source === 'llota' ? '#42a5f5' : s.source === 'pskr' ? '#ff6b6b' : '#4ecca3';
    const logBtnHtml = enableLogging
      ? ` <button class="log-popup-btn" data-call="${s.callsign}" data-freq="${s.frequency}" data-mode="${s.mode}" data-ref="${s.reference || ''}" data-name="${(s.parkName || '').replace(/"/g, '&quot;')}" data-source="${s.source || ''}" data-wwff-ref="${s.wwffReference || ''}" data-wwff-name="${(s.wwffParkName || '').replace(/"/g, '&quot;')}">Log</button>`
      : '';
    const mapNewPark = workedParksSet.size > 0 && (s.source === 'pota' || s.source === 'wwff') && s.reference && !workedParksSet.has(s.reference);
    const newBadge = mapNewPark ? ' <span style="background:#4ecca3;color:#000;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">NEW</span>' : '';
    const expeditionBadge = expeditionCallsigns.has(s.callsign.toUpperCase()) ? ' <span style="background:#ff1744;color:#fff;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">DXP</span>' : '';
    const wwffBadge = s.wwffReference ? ` <span style="background:#26a69a;color:#000;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">WWFF</span>` : '';
    const wwffRefLine = s.wwffReference ? `<br><b>${s.wwffReference}</b> ${s.wwffParkName || ''} <span style="color:#26a69a;font-size:11px;">[WWFF]</span>` : '';
    const qrzOp = qrzData.get(s.callsign.toUpperCase().split('/')[0]);
    const opName = qrzDisplayName(qrzOp);
    const opLine = opName ? `<span style="color:#b0bec5;font-size:11px;">${opName}</span><br>` : '';
    const popupContent = `
      <b>${watched ? '\u2B50 ' : ''}<a href="#" class="popup-qrz" data-call="${s.callsign}">${s.callsign}</a></b> <span style="color:${sourceColor};font-size:11px;">[${sourceLabel}]</span>${expeditionBadge}${newBadge}${wwffBadge}<br>
      ${opLine}${parseFloat(s.frequency).toFixed(1)} kHz &middot; ${s.mode}<br>
      <b>${s.reference}</b> ${s.parkName}${wwffRefLine}<br>
      ${distStr}<br>
      <button class="tune-btn" data-freq="${s.frequency}" data-mode="${s.mode}" data-bearing="${s.bearing != null ? s.bearing : ''}" data-lat="${s.lat != null ? s.lat : ''}" data-lon="${s.lon != null ? s.lon : ''}" data-source="${s.source || ''}">Tune</button>${logBtnHtml}
    `;

    // Pin color matches source: POTA green, SOTA orange, DXC purple, etc.
    const oop = isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass);
    const worked = workedCallsigns.has(s.callsign.toUpperCase());
    const isExpedition = expeditionCallsigns.has(s.callsign.toUpperCase());
    const sourceIcon = s.source === 'sota' ? sotaIcon
      : s.source === 'rbn' ? rbnIcon
      : s.source === 'wwff' ? wwffIcon
      : s.source === 'llota' ? llotaIcon
      : s.source === 'dxc' ? dxcIcon
      : s.source === 'pskr' ? pskrIcon
      : potaIcon;
    const markerOptions = isExpedition
      ? { icon: expeditionIcon, zIndexOffset: 500 }
      : oop
        ? { icon: oopIcon, opacity: 0.4 }
        : { icon: sourceIcon, ...(worked ? { opacity: 0.5 } : {}) };

    // Plot marker at canonical position and one world-copy in each direction
    for (const offset of [-360, 0, 360]) {
      const marker = L.marker([s.lat, s.lon + offset], markerOptions).bindPopup(popupContent);
      marker._spotCallsign = s.callsign;
      marker.addTo(markerLayer);
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
        const spot = {
          callsign: btn.dataset.call,
          frequency: btn.dataset.freq,
          mode: btn.dataset.mode,
          reference: btn.dataset.ref,
          parkName: btn.dataset.name,
          source: btn.dataset.source,
          wwffReference: btn.dataset.wwffRef || '',
          wwffParkName: btn.dataset.wwffName || '',
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
  window.api.tune(spot.frequency, spot.mode, spot.bearing);
  if (spot.lat != null && spot.lon != null) showTuneArc(spot.lat, spot.lon, spot.frequency, spot.source);
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
  // F1 — Hotkeys help
  if (e.key === 'F1' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    document.getElementById('hotkeys-dialog').showModal();
    return;
  }
  // F2 — Recent QSOs viewer
  if (e.key === 'F2' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    openRecentQsos();
    return;
  }
  // F11 — Welcome screen
  if (e.key === 'F11' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    checkFirstRun(true);
    return;
  }
  if (e.code === 'Space' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    if (scanning) { stopScan(); } else { startScan(); }
    return;
  }
  // S — Toggle split mode
  if (e.key === 's' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    enableSplit = !enableSplit;
    window.api.saveSettings({ enableSplit });
    showLogToast(enableSplit ? 'Split mode ON' : 'Split mode OFF', { duration: 1500 });
    return;
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
// Table and Map are toggleable (both can be active = split view).
// RBN and DXCC are exclusive views that hide the split container.

function setView(view) {
  // Called for exclusive views (rbn, dxcc) or to force a specific state
  if (view === 'rbn' || view === 'dxcc') {
    currentView = view;
    showTable = false;
    showMap = false;
  } else if (view === 'table') {
    currentView = 'table';
    showTable = true;
    showMap = false;
  } else if (view === 'map') {
    currentView = 'map';
    showTable = false;
    showMap = true;
  }
  updateViewLayout();
}

function updateViewLayout() {
  // Hide exclusive views
  dxccView.classList.add('hidden');
  rbnView.classList.add('hidden');

  // Deactivate all view buttons
  viewTableBtn.classList.remove('active');
  viewMapBtn.classList.remove('active');
  viewDxccBtn.classList.remove('active');
  viewRbnBtn.classList.remove('active');

  if (currentView === 'dxcc') {
    splitContainerEl.classList.add('hidden');
    dxccView.classList.remove('hidden');
    viewDxccBtn.classList.add('active');
    renderDxccMatrix();
    updateParksStatsOverlay();
    saveViewState();
    return;
  }

  if (currentView === 'rbn') {
    splitContainerEl.classList.add('hidden');
    rbnView.classList.remove('hidden');
    viewRbnBtn.classList.add('active');
    if (!rbnMap) initRbnMap();
    setTimeout(() => rbnMap.invalidateSize(), 0);
    renderRbnMarkers();
    renderRbnTable();
    updateParksStatsOverlay();
    saveViewState();
    return;
  }

  // Table/Map mode — show split container
  splitContainerEl.classList.remove('hidden');

  // Update orientation
  splitContainerEl.classList.toggle('split-horizontal', splitOrientation === 'horizontal');
  splitContainerEl.classList.toggle('split-vertical', splitOrientation === 'vertical');

  // Reset splitter-drag overrides when not in split mode
  if (!(showTable && showMap)) {
    tablePaneEl.style.flex = '';
    mapPaneEl.style.flex = '';
  }

  // Show/hide panes
  tablePaneEl.classList.toggle('hidden', !showTable);
  mapPaneEl.classList.toggle('hidden', !showMap);
  splitSplitterEl.classList.toggle('hidden', !(showTable && showMap));

  // Button states
  if (showTable) viewTableBtn.classList.add('active');
  if (showMap) viewMapBtn.classList.add('active');

  // Init and resize map if visible
  if (showMap) {
    if (!map) initMap();
    updateBandActivityVisibility();
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 0);
  }

  render();
  updateParksStatsOverlay();
  saveViewState();
}

const VIEW_STATE_KEY = 'pota-cat-view-state';

function saveViewState() {
  localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({
    lastView: currentView,
    showTable,
    showMap,
    sortCol,
    sortAsc,
  }));
}

viewTableBtn.addEventListener('click', () => {
  if (currentView === 'rbn' || currentView === 'dxcc') {
    // Switching from exclusive view → table only
    currentView = 'table';
    showTable = true;
    showMap = false;
  } else if (!enableSplitView) {
    // No split — switch to table only
    showTable = true;
    showMap = false;
    currentView = 'table';
  } else {
    // Toggle table
    if (!showTable) {
      showTable = true;
    } else if (showMap) {
      // Can turn off table since map is on
      showTable = false;
    }
    // else: table is the only view, do nothing
    currentView = showTable && !showMap ? 'table' : (showMap && !showTable ? 'map' : 'table');
  }
  updateViewLayout();
});

viewMapBtn.addEventListener('click', () => {
  // If pop-out map is open, clicking Map focuses the pop-out instead
  if (popoutOpen) {
    window.api.popoutMapOpen(); // focuses existing window
    return;
  }
  if (currentView === 'rbn' || currentView === 'dxcc') {
    // Switching from exclusive view → map only
    currentView = 'map';
    showTable = false;
    showMap = true;
  } else if (!enableSplitView) {
    // No split — switch to map only
    showTable = false;
    showMap = true;
    currentView = 'map';
  } else {
    // Toggle map
    if (!showMap) {
      showMap = true;
    } else if (showTable) {
      // Can turn off map since table is on
      showMap = false;
    }
    // else: map is the only view, do nothing
    currentView = showTable && !showMap ? 'table' : (showMap && !showTable ? 'map' : 'table');
  }
  updateViewLayout();
});

viewRbnBtn.addEventListener('click', () => setView('rbn'));
viewDxccBtn.addEventListener('click', () => setView('dxcc'));

// --- Pop-out map ---
popoutMapBtn.addEventListener('click', () => {
  if (popoutOpen) {
    window.api.popoutMapClose();
  } else {
    window.api.popoutMapOpen();
  }
});

let _prePopoutShowMap = false; // saved inline map state before pop-out opened

window.api.onPopoutMapStatus((open) => {
  popoutOpen = open;
  popoutMapBtn.classList.toggle('popout-active', open);
  if (open) {
    // Hide inline map — pop-out replaces it
    _prePopoutShowMap = showMap;
    if (showMap) {
      showMap = false;
      if (!showTable) { showTable = true; }
      updateViewLayout();
    }
    // Send initial data (small delay for pop-out to finish init)
    setTimeout(sendPopoutSpots, 300);
  } else {
    // Restore inline map if it was showing before
    if (_prePopoutShowMap) {
      showMap = true;
      updateViewLayout();
    }
  }
});

// Open log dialog when requested from pop-out map
window.api.onPopoutOpenLog((spot) => {
  if (enableLogging) openLogPopup(spot);
});

function enrichSpotsForPopout(filtered) {
  return filtered.map(s => ({
    ...s,
    isWorked: workedCallsigns.has(s.callsign.toUpperCase()),
    isExpedition: expeditionCallsigns.has(s.callsign.toUpperCase()),
    isNewPark: workedParksSet.size > 0 && (s.source === 'pota' || s.source === 'wwff') && s.reference && !workedParksSet.has(s.reference),
    isOop: isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass),
    isWatched: watchlist.has(s.callsign.toUpperCase()),
    opName: qrzDisplayName(qrzData.get(s.callsign.toUpperCase().split('/')[0])),
  }));
}

function sendPopoutSpots() {
  if (!popoutOpen) return;
  const filtered = sortSpots(getFiltered());
  window.api.sendPopoutSpots({
    spots: enrichSpotsForPopout(filtered),
    distUnit,
    enableLogging,
  });
}

function sendPopoutTuneArc(lat, lon, freq, source) {
  if (!popoutOpen) return;
  window.api.sendPopoutTuneArc({ lat, lon, freq, source });
}

// --- Split splitter drag ---
splitSplitterEl.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const isHoriz = splitOrientation === 'horizontal';
  const startPos = isHoriz ? e.clientX : e.clientY;
  const startTableSize = isHoriz ? tablePaneEl.offsetWidth : tablePaneEl.offsetHeight;
  const startMapSize = isHoriz ? mapPaneEl.offsetWidth : mapPaneEl.offsetHeight;

  const onMove = (ev) => {
    const delta = (isHoriz ? ev.clientX : ev.clientY) - startPos;
    const minSize = isHoriz ? 200 : 100;
    const newTableSize = Math.max(minSize, startTableSize + delta);
    const newMapSize = Math.max(minSize, startMapSize - delta);
    // Use flex-grow ratios so the split scales proportionally on window resize
    tablePaneEl.style.flex = newTableSize + ' 0 0px';
    mapPaneEl.style.flex = newMapSize + ' 0 0px';
    // Clear any leftover fixed dimensions
    tablePaneEl.style.width = '';
    tablePaneEl.style.height = '';
    mapPaneEl.style.width = '';
    mapPaneEl.style.height = '';
    if (map) map.invalidateSize();
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
  };

  document.body.style.cursor = isHoriz ? 'col-resize' : 'row-resize';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

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

  if (showTable) {
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
      if (s.source === 'wwff') tr.classList.add('spot-wwff');
      if (s.source === 'llota') tr.classList.add('spot-llota');
      if (s.source === 'pskr') tr.classList.add('spot-pskr');
      if (expeditionCallsigns.has(s.callsign.toUpperCase())) tr.classList.add('spot-expedition');
      if (s.comments && /POTA.?CAT/i.test(s.comments)) tr.classList.add('potacat-respot');

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
        window.api.tune(s.frequency, s.mode, s.bearing);
        if (s.lat != null && s.lon != null) showTuneArc(s.lat, s.lon, s.frequency, s.source);
      });

      // Log button cell (first column, hidden unless logging enabled)
      const logTd = document.createElement('td');
      logTd.className = 'log-cell log-col';
      logTd.setAttribute('data-col', 'log');
      const logButton = document.createElement('button');
      logButton.className = 'log-btn';
      logButton.textContent = isCompact ? 'L' : 'Log';
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
      callTd.setAttribute('data-col', 'callsign');
      if (myCallsign && s.callsign.toUpperCase() === myCallsign.toUpperCase()) {
        const cat = document.createElement('span');
        cat.textContent = '\uD83D\uDC08\u200D\u2B1B ';
        cat.className = 'watchlist-star';
        callTd.appendChild(cat);
      } else if (isWatched) {
        const star = document.createElement('span');
        star.textContent = '\u2B50 ';
        star.className = 'watchlist-star';
        callTd.appendChild(star);
      }
      const callLink = document.createElement('a');
      callLink.textContent = s.callsign;
      callLink.href = '#';
      callLink.className = 'qrz-link';
      const qrzHover = qrzData.get(s.callsign.toUpperCase().split('/')[0]);
      if (qrzHover) {
        const hoverName = qrzDisplayName(qrzHover);
        if (hoverName) callLink.title = hoverName;
      }
      callLink.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        window.api.openExternal(`https://www.qrz.com/db/${encodeURIComponent(s.callsign.split('/')[0])}`);
      });
      callTd.appendChild(callLink);
      if (donorCallsigns.has(s.callsign.toUpperCase())) {
        const paw = document.createElement('span');
        paw.className = 'donor-paw';
        paw.title = 'POTACAT Supporter';
        paw.textContent = '\uD83D\uDC3E';
        callTd.appendChild(paw);
      }
      if (expeditionCallsigns.has(s.callsign.toUpperCase())) {
        const dxp = document.createElement('span');
        dxp.className = 'expedition-badge';
        dxp.title = 'DX Expedition (Club Log)';
        dxp.textContent = 'DXP';
        callTd.appendChild(dxp);
      }
      tr.appendChild(callTd);

      // Operator name cell (from QRZ lookup)
      const operatorTd = document.createElement('td');
      operatorTd.setAttribute('data-col', 'operator');
      operatorTd.className = 'operator-col';
      const qrzInfo = qrzData.get(s.callsign.toUpperCase().split('/')[0]);
      if (qrzInfo) {
        operatorTd.textContent = qrzDisplayName(qrzInfo);
        operatorTd.title = [qrzInfo.nickname || qrzInfo.fname, qrzInfo.name].filter(Boolean).join(' ');
      }
      tr.appendChild(operatorTd);

      // Frequency cell — styled as clickable link
      const freqTd = document.createElement('td');
      freqTd.setAttribute('data-col', 'frequency');
      const freqLink = document.createElement('span');
      freqLink.textContent = parseFloat(s.frequency).toFixed(1);
      freqLink.className = 'freq-link';
      freqTd.appendChild(freqLink);
      tr.appendChild(freqTd);

      // Build reference display — dual-park shows both refs
      const refDisplay = s.wwffReference ? s.reference + ' / ' + s.wwffReference : s.reference;
      const parkDisplay = s.wwffReference ? s.parkName : s.parkName;

      const cells = [
        { val: s.mode, col: 'mode' },
        { val: refDisplay, wwff: !!s.wwffReference, col: 'reference' },
        { val: parkDisplay, col: 'parkName' },
        { val: s.locationDesc, col: 'locationDesc' },
        { val: formatDistance(s.distance), col: 'distance' },
        { val: formatBearing(s.bearing), cls: 'bearing-col', col: 'bearing' },
        { val: formatAge(s.spotTime), col: 'spotTime' },
        { val: s.comments || '', col: 'comments' },
      ];

      for (const cell of cells) {
        const td = document.createElement('td');
        td.textContent = cell.val;
        if (cell.col) td.setAttribute('data-col', cell.col);
        if (cell.cls) td.className = cell.cls;
        if (cell.col === 'comments' && cell.val) td.title = cell.val;
        if (cell.wwff) {
          const badge = document.createElement('span');
          badge.textContent = 'WWFF';
          badge.style.cssText = 'background:#26a69a;color:#000;font-size:9px;font-weight:bold;padding:1px 3px;border-radius:3px;margin-left:4px;';
          td.appendChild(badge);
        }
        tr.appendChild(td);
      }

      // Skip button (last cell)
      const skipTd = document.createElement('td');
      skipTd.className = 'skip-cell';
      skipTd.setAttribute('data-col', 'skip');
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
  }
  if (showMap) {
    updateMapMarkers(filtered);
    renderBandActivity();
  }
  if (popoutOpen) {
    sendPopoutSpots();
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
  const logQrz = qrzData.get((spot.callsign || '').toUpperCase().split('/')[0]);
  logOpName.value = logQrz ? [cleanQrzName(logQrz.nickname) || cleanQrzName(logQrz.fname), cleanQrzName(logQrz.name)].filter(Boolean).join(' ') : '';
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
    const sig = spot.source === 'sota' ? 'SOTA' : spot.source === 'pota' ? 'POTA' : spot.source === 'wwff' ? 'WWFF' : spot.source === 'llota' ? 'LLOTA' : '';
    logRefDisplay.textContent = sig ? `${sig}: ${spot.reference}` : spot.reference;
    if (spot.parkName) logRefDisplay.textContent += ` — ${spot.parkName}`;
    if (spot.wwffReference) logRefDisplay.textContent += `\nWWFF: ${spot.wwffReference}` + (spot.wwffParkName ? ` — ${spot.wwffParkName}` : '');
    logRefDisplay.classList.remove('hidden');
  } else {
    logRefDisplay.classList.add('hidden');
  }

  logComment.value = '';

  // Re-spot section: show for POTA, WWFF, and/or LLOTA spots when myCallsign is set
  const respotSection = document.getElementById('log-respot-section');
  const respotCheckbox = document.getElementById('log-respot');
  const respotComment = document.getElementById('log-respot-comment');
  const respotCommentLabel = document.getElementById('log-respot-comment-label');
  // WWFF respot checkbox (dynamically create/remove)
  let wwffRespotCheckbox = document.getElementById('log-wwff-respot');
  // LLOTA respot checkbox (dynamically create/remove)
  let llotaRespotCheckbox = document.getElementById('log-llota-respot');
  const isPota = spot.source === 'pota' && spot.reference;
  const isWwff = spot.source === 'wwff' && spot.reference;
  const isLlota = spot.source === 'llota' && spot.reference;
  const isDualPark = spot.source === 'pota' && spot.wwffReference;
  if (isPota || isWwff || isDualPark || isLlota) {
    respotSection.classList.remove('hidden');
    // Label the POTA checkbox appropriately
    if (isPota || isDualPark) {
      respotCheckbox.checked = respotDefault;
      respotCheckbox.parentElement.style.display = '';
      respotCheckbox.parentElement.querySelector('span') && (respotCheckbox.parentElement.childNodes[1].textContent = isDualPark ? ' Re-spot on POTA' : ' Re-spot on POTA');
    } else {
      // Non-POTA spot — hide POTA checkbox
      respotCheckbox.checked = false;
      respotCheckbox.parentElement.style.display = 'none';
    }
    // Show/create WWFF respot checkbox for WWFF-related spots
    if (isWwff || isDualPark) {
      if (!wwffRespotCheckbox) {
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        label.style.marginTop = '4px';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = 'log-wwff-respot';
        cb.checked = true;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' Re-spot on WWFF'));
        respotCheckbox.parentElement.parentElement.insertBefore(label, respotCommentLabel);
        wwffRespotCheckbox = cb;
      } else {
        wwffRespotCheckbox.checked = true;
        wwffRespotCheckbox.parentElement.style.display = '';
      }
    } else if (wwffRespotCheckbox) {
      wwffRespotCheckbox.parentElement.style.display = 'none';
      wwffRespotCheckbox.checked = false;
    }
    // Show/create LLOTA respot checkbox for LLOTA spots
    if (isLlota) {
      if (!llotaRespotCheckbox) {
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        label.style.marginTop = '4px';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = 'log-llota-respot';
        cb.checked = true;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' Re-spot on LLOTA'));
        respotCheckbox.parentElement.parentElement.insertBefore(label, respotCommentLabel);
        llotaRespotCheckbox = cb;
      } else {
        llotaRespotCheckbox.checked = true;
        llotaRespotCheckbox.parentElement.style.display = '';
      }
    } else if (llotaRespotCheckbox) {
      llotaRespotCheckbox.parentElement.style.display = 'none';
      llotaRespotCheckbox.checked = false;
    }
    respotComment.value = respotTemplate;
    const anyChecked = () => respotCheckbox.checked || (wwffRespotCheckbox && wwffRespotCheckbox.checked) || (llotaRespotCheckbox && llotaRespotCheckbox.checked);
    respotCommentLabel.style.display = anyChecked() ? '' : 'none';
    const updateCommentVis = () => { respotCommentLabel.style.display = anyChecked() ? '' : 'none'; };
    respotCheckbox.onchange = updateCommentVis;
    if (wwffRespotCheckbox) wwffRespotCheckbox.onchange = updateCommentVis;
    if (llotaRespotCheckbox) llotaRespotCheckbox.onchange = updateCommentVis;
  } else {
    respotSection.classList.add('hidden');
    if (wwffRespotCheckbox) {
      wwffRespotCheckbox.parentElement.style.display = 'none';
      wwffRespotCheckbox.checked = false;
    }
    if (llotaRespotCheckbox) {
      llotaRespotCheckbox.parentElement.style.display = 'none';
      llotaRespotCheckbox.checked = false;
    }
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
    else if (currentLogSpot.source === 'wwff') sig = 'WWFF';
    else if (currentLogSpot.source === 'llota') sig = 'LLOTA';
    sigInfo = currentLogSpot.reference;
  }

  // Re-spot checkbox state
  const respotCheckbox = document.getElementById('log-respot');
  const respotComment = document.getElementById('log-respot-comment');
  const respotSection = document.getElementById('log-respot-section');
  const wwffRespotCheckbox = document.getElementById('log-wwff-respot');
  const llotaRespotCheckbox = document.getElementById('log-llota-respot');
  const wantsRespot = !respotSection.classList.contains('hidden') && respotCheckbox.checked;
  const wantsWwffRespot = !respotSection.classList.contains('hidden') && wwffRespotCheckbox && wwffRespotCheckbox.checked;
  const wantsLlotaRespot = !respotSection.classList.contains('hidden') && llotaRespotCheckbox && llotaRespotCheckbox.checked;

  // Persist re-spot preference and template
  if (!respotSection.classList.contains('hidden')) {
    respotDefault = respotCheckbox.checked;
    respotTemplate = respotComment.value.trim() || respotTemplate;
    window.api.saveSettings({ respotDefault: respotCheckbox.checked, respotTemplate });
  }

  // Determine WWFF reference for respot
  const wwffRef = currentLogSpot ? (currentLogSpot.wwffReference || (currentLogSpot.source === 'wwff' ? currentLogSpot.reference : '')) : '';
  const commentText = respotComment.value.trim().replace(/\{rst\}/gi, logRstSent.value.trim() || '59').replace(/\{mycallsign\}/gi, myCallsign);

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
    wwffRespot: wantsWwffRespot,
    wwffReference: wantsWwffRespot ? wwffRef : '',
    llotaRespot: wantsLlotaRespot,
    llotaReference: wantsLlotaRespot && currentLogSpot && currentLogSpot.source === 'llota' ? currentLogSpot.reference : '',
    respotComment: (wantsRespot || wantsWwffRespot || wantsLlotaRespot) ? commentText : '',
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
      } else if (result.wwffRespotError) {
        showLogToast(`Logged ${callsign} to ADIF, but WWFF re-spot failed: ${result.wwffRespotError}`, { warn: true, duration: 8000 });
      } else if (result.llotaRespotError) {
        showLogToast(`Logged ${callsign} to ADIF, but LLOTA re-spot failed: ${result.llotaRespotError}`, { warn: true, duration: 8000 });
      } else if (result.resposted) {
        const sources = [wantsRespot && 'POTA', wantsWwffRespot && 'WWFF', wantsLlotaRespot && 'LLOTA'].filter(Boolean).join(' & ');
        showLogToast(`Logged ${callsign} — re-spotted on ${sources || 'POTA'}`);
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
  toast.className = 'log-toast' + (opts && opts.warn ? ' warn' : '') + (opts && opts.sticky ? ' sticky' : '');
  toast.textContent = message;
  if (opts && opts.sticky) {
    const dismiss = document.createElement('span');
    dismiss.className = 'log-toast-dismiss';
    dismiss.textContent = '\u00d7';
    toast.appendChild(dismiss);
    toast.addEventListener('click', () => toast.remove());
  }
  document.body.appendChild(toast);
  if (!(opts && opts.sticky)) {
    const duration = (opts && opts.duration) || 2200;
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, duration);
  }
}

// --- Events ---
// Band/mode dropdowns already wired via initMultiDropdown()
// --- Spots dropdown panel ---
spotsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  document.querySelectorAll('.multi-dropdown.open').forEach((d) => {
    if (d !== spotsDropdown) d.classList.remove('open');
  });
  const opening = !spotsDropdown.classList.contains('open');
  spotsDropdown.classList.toggle('open');
  if (opening) syncSpotsPanel();
});

function syncSpotsPanel() {
  spotsPota.checked = enablePota;
  spotsSota.checked = enableSota;
  spotsWwff.checked = enableWwff;
  spotsLlota.checked = enableLlota;
  spotsCluster.checked = enableCluster;
  spotsRbn.checked = enableRbn;
  spotsPskr.checked = enablePskr;
  spotsHideWorked.checked = hideWorked;
  spotsHideParks.checked = hideWorkedParks;
  spotsHideOob.checked = hideOutOfBand;
  spotsHideParksLabel.classList.toggle('hidden', workedParksSet.size === 0);
}

document.querySelector('.spots-dropdown-panel').addEventListener('click', (e) => e.stopPropagation());

document.querySelector('.spots-dropdown-panel').addEventListener('change', async (e) => {
  enablePota = spotsPota.checked;
  enableSota = spotsSota.checked;
  enableWwff = spotsWwff.checked;
  enableLlota = spotsLlota.checked;
  enableCluster = spotsCluster.checked;
  enableRbn = spotsRbn.checked;
  enablePskr = spotsPskr.checked;

  // DX Cluster and RBN require a callsign
  if (enableCluster && !myCallsign) {
    enableCluster = false;
    spotsCluster.checked = false;
    alert('DX Cluster requires a callsign. Please set your callsign in Settings first.');
  }
  if (enableRbn && !myCallsign) {
    enableRbn = false;
    spotsRbn.checked = false;
    alert('RBN requires a callsign. Please set your callsign in Settings first.');
  }
  hideWorked = spotsHideWorked.checked;
  hideWorkedParks = spotsHideParks.checked;
  hideOutOfBand = spotsHideOob.checked;

  // Sync Settings dialog checkboxes
  setEnablePota.checked = enablePota;
  setEnableSota.checked = enableSota;
  setEnableWwff.checked = enableWwff;
  setEnableLlota.checked = enableLlota;
  setEnableCluster.checked = enableCluster;
  setEnableRbn.checked = enableRbn;
  setEnablePskr.checked = enablePskr;
  setHideWorked.checked = hideWorked;
  setHideWorkedParks.checked = hideWorkedParks;
  setHideOutOfBand.checked = hideOutOfBand;

  updateRbnButton();

  // Save and let main process handle connect/disconnect
  await window.api.saveSettings({
    enablePota, enableSota, enableWwff, enableLlota,
    enableCluster, enableRbn, enablePskr,
    hideWorked, hideWorkedParks, hideOutOfBand,
  });

  render();
});

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
    saveViewState();
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
  setCwFilter.value = s.cwFilterWidth || 0;
  setSsbFilter.value = s.ssbFilterWidth || 0;
  setDigitalFilter.value = s.digitalFilterWidth || 0;
  setWatchlist.value = s.watchlist || '';
  setNotifyPopup.checked = s.notifyPopup !== false;
  setNotifySound.checked = s.notifySound !== false;
  setNotifyTimeout.value = s.notifyTimeout || 10;
  setLicenseClass.value = s.licenseClass || 'none';
  setHideOutOfBand.checked = s.hideOutOfBand === true;
  setHideWorked.checked = s.hideWorked === true;
  setTuneClick.checked = s.tuneClick === true;
  setEnableRotor.checked = s.enableRotor === true;
  setRotorHost.value = s.rotorHost || '127.0.0.1';
  setRotorPort.value = s.rotorPort || 12040;
  rotorConfig.classList.toggle('hidden', !s.enableRotor);
  setEnableSplit.checked = s.enableSplit === true;
  setVerboseLog.checked = s.verboseLog === true;
  setEnablePota.checked = s.enablePota !== false;
  setEnableSota.checked = s.enableSota === true;
  setEnableWwff.checked = s.enableWwff === true;
  setEnableLlota.checked = s.enableLlota === true;
  setEnableQrz.checked = s.enableQrz === true;
  setQrzUsername.value = s.qrzUsername || '';
  setQrzPassword.value = s.qrzPassword || '';
  setQrzFullName.checked = s.qrzFullName === true;
  qrzConfig.classList.toggle('hidden', !s.enableQrz);
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
  setEnablePskr.checked = s.enablePskr === true;
  pskrConfig.classList.toggle('hidden', !s.enablePskr);
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
  setEnableSplitView.checked = s.enableSplitView !== false;
  splitOrientationConfig.classList.toggle('hidden', !setEnableSplitView.checked);
  document.getElementById('set-split-orientation').value = s.splitOrientation || 'horizontal';
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
  setSmartSdrWwff.checked = s.smartSdrWwff !== false;
  setSmartSdrLlota.checked = s.smartSdrLlota !== false;
  setSmartSdrPskr.checked = s.smartSdrPskr !== false;
  setSmartSdrMaxAge.value = s.smartSdrMaxAge != null ? s.smartSdrMaxAge : 15;
  smartSdrConfig.classList.toggle('hidden', !s.smartSdrSpots);
  setDisableAutoUpdate.checked = s.disableAutoUpdate === true;
  setEnableTelemetry.checked = s.enableTelemetry === true;
  setLightMode.checked = s.lightMode === true;
  hamlibTestResult.textContent = '';
  hamlibTestResult.className = '';
  renderRigList(s.rigs || [], s.activeRigId || null);
  closeRigEditor();
  // Update connection status pills
  updateSettingsConnBar();
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
  const cwFilterVal = parseInt(setCwFilter.value, 10) || 0;
  const ssbFilterVal = parseInt(setSsbFilter.value, 10) || 0;
  const digitalFilterVal = parseInt(setDigitalFilter.value, 10) || 0;
  const notifyPopupEnabled = setNotifyPopup.checked;
  const notifySoundEnabled = setNotifySound.checked;
  const notifyTimeoutVal = parseInt(setNotifyTimeout.value, 10) || 10;
  const potaEnabled = setEnablePota.checked;
  const sotaEnabled = setEnableSota.checked;
  const wwffEnabled = setEnableWwff.checked;
  const llotaEnabled = setEnableLlota.checked;
  const qrzEnabled = setEnableQrz.checked;
  const qrzUsername = setQrzUsername.value.trim().toUpperCase();
  const qrzPassword = setQrzPassword.value;
  const qrzFullNameEnabled = setQrzFullName.checked;
  const myCallsign = setMyCallsign.value.trim().toUpperCase();
  let clusterEnabled = setEnableCluster.checked;
  let rbnEnabled = setEnableRbn.checked;
  const pskrEnabled = setEnablePskr.checked;

  // DX Cluster and RBN require a callsign
  if (clusterEnabled && !myCallsign) {
    clusterEnabled = false;
    setEnableCluster.checked = false;
    alert('DX Cluster requires a callsign. Please enter your callsign above.');
  }
  if (rbnEnabled && !myCallsign) {
    rbnEnabled = false;
    setEnableRbn.checked = false;
    alert('RBN requires a callsign. Please enter your callsign above.');
  }
  const clusterHost = setClusterHost.value.trim() || 'w3lpl.net';
  const clusterPort = parseInt(setClusterPort.value, 10) || 7373;
  const wsjtxEnabled = setEnableWsjtx.checked;
  const wsjtxPortVal = parseInt(setWsjtxPort.value, 10) || 2237;
  const wsjtxHighlightEnabled = setWsjtxHighlight.checked;
  const wsjtxAutoLogEnabled = setWsjtxAutoLog.checked;
  const solarEnabled = setEnableSolar.checked;
  const bandActivityEnabled = setEnableBandActivity.checked;
  const showBearingEnabled = setShowBearing.checked;
  const enableSplitViewVal = setEnableSplitView.checked;
  const splitOrientationVal = document.getElementById('set-split-orientation').value;
  const dxccEnabled = setEnableDxcc.checked;
  const licenseClassVal = setLicenseClass.value;
  const hideOob = setHideOutOfBand.checked;
  const hideWorkedEnabled = setHideWorked.checked;
  const tuneClickEnabled = setTuneClick.checked;
  const rotorEnabled = setEnableRotor.checked;
  const rotorHostVal = setRotorHost.value.trim() || '127.0.0.1';
  const rotorPortVal = parseInt(setRotorPort.value, 10) || 12040;
  const enableSplitEnabled = setEnableSplit.checked;
  const verboseLogEnabled = setVerboseLog.checked;
  const disableAutoUpdate = setDisableAutoUpdate.checked;
  const telemetryEnabled = setEnableTelemetry.checked;
  const lightModeEnabled = setLightMode.checked;
  const smartSdrSpotsEnabled = setSmartSdrSpots.checked;
  const smartSdrHostVal = setSmartSdrHost.value.trim() || '127.0.0.1';
  const smartSdrPotaEnabled = setSmartSdrPota.checked;
  const smartSdrSotaEnabled = setSmartSdrSota.checked;
  const smartSdrClusterEnabled = setSmartSdrCluster.checked;
  const smartSdrRbnEnabled = setSmartSdrRbn.checked;
  const smartSdrWwffEnabled = setSmartSdrWwff.checked;
  const smartSdrLlotaEnabled = setSmartSdrLlota.checked;
  const smartSdrPskrEnabled = setSmartSdrPskr.checked;
  const smartSdrMaxAgeVal = parseInt(setSmartSdrMaxAge.value, 10) || 0;
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
    cwFilterWidth: cwFilterVal,
    ssbFilterWidth: ssbFilterVal,
    digitalFilterWidth: digitalFilterVal,
    watchlist: watchlistRaw,
    notifyPopup: notifyPopupEnabled,
    notifySound: notifySoundEnabled,
    notifyTimeout: notifyTimeoutVal,
    enablePota: potaEnabled,
    enableSota: sotaEnabled,
    enableWwff: wwffEnabled,
    enableLlota: llotaEnabled,
    enableQrz: qrzEnabled,
    qrzUsername: qrzUsername,
    qrzPassword: qrzPassword,
    qrzFullName: qrzFullNameEnabled,
    enableCluster: clusterEnabled,
    enableRbn: rbnEnabled,
    enableWsjtx: wsjtxEnabled,
    enablePskr: pskrEnabled,
    wsjtxPort: wsjtxPortVal,
    wsjtxHighlight: wsjtxHighlightEnabled,
    wsjtxAutoLog: wsjtxAutoLogEnabled,
    myCallsign: myCallsign,
    clusterHost: clusterHost,
    clusterPort: clusterPort,
    enableSolar: solarEnabled,
    enableBandActivity: bandActivityEnabled,
    showBearing: showBearingEnabled,
    enableSplitView: enableSplitViewVal,
    splitOrientation: splitOrientationVal,
    enableDxcc: dxccEnabled,
    licenseClass: licenseClassVal,
    hideOutOfBand: hideOob,
    hideWorked: hideWorkedEnabled,
    tuneClick: tuneClickEnabled,
    enableRotor: rotorEnabled,
    rotorHost: rotorHostVal,
    rotorPort: rotorPortVal,
    enableSplit: enableSplitEnabled,
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
    disableAutoUpdate: disableAutoUpdate,
    enableTelemetry: telemetryEnabled,
    lightMode: lightModeEnabled,
    smartSdrSpots: smartSdrSpotsEnabled,
    smartSdrHost: smartSdrHostVal,
    smartSdrPota: smartSdrPotaEnabled,
    smartSdrSota: smartSdrSotaEnabled,
    smartSdrCluster: smartSdrClusterEnabled,
    smartSdrRbn: smartSdrRbnEnabled,
    smartSdrWwff: smartSdrWwffEnabled,
    smartSdrLlota: smartSdrLlotaEnabled,
    smartSdrPskr: smartSdrPskrEnabled,
    smartSdrMaxAge: smartSdrMaxAgeVal,
  });
  distUnit = setDistUnit.value;
  maxAgeMin = maxAgeVal;
  scanDwell = dwellVal;
  watchlist = parseWatchlist(watchlistRaw);
  enablePota = potaEnabled;
  enableSota = sotaEnabled;
  enableWwff = wwffEnabled;
  enableLlota = llotaEnabled;
  enableCluster = clusterEnabled;
  enableRbn = rbnEnabled;
  enablePskr = pskrEnabled;
  enableWsjtx = wsjtxEnabled;
  updateWsjtxStatusVisibility();
  updateRbnButton();
  enableSolar = solarEnabled;
  updateSolarVisibility();
  enableBandActivity = bandActivityEnabled;
  updateBandActivityVisibility();
  showBearing = showBearingEnabled;
  updateBearingVisibility();
  enableSplitView = enableSplitViewVal;
  splitOrientation = splitOrientationVal;
  // If split view was just disabled and both are showing, switch to table only
  if (!enableSplitView && showTable && showMap) {
    showMap = false;
    currentView = 'table';
  }
  if (showTable || showMap) updateViewLayout();
  qrzFullName = qrzFullNameEnabled;
  enableLogging = loggingEnabled;
  defaultPower = defaultPowerVal;
  updateLoggingVisibility();
  applyTheme(lightModeEnabled);
  if (popoutOpen) window.api.sendPopoutTheme(lightModeEnabled ? 'light' : 'dark');
  enableDxcc = dxccEnabled;
  licenseClass = licenseClassVal;
  hideOutOfBand = hideOob;
  hideWorked = hideWorkedEnabled;
  hideWorkedParks = hideWorkedParksEnabled;
  tuneClick = tuneClickEnabled;
  enableSplit = enableSplitEnabled;
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
  syncSpotsPanel();
  settingsDialog.close();
  render();
  // Update home marker if map is initialized
  if (map) updateHomeMarker();
  if (rbnMap) updateRbnHomeMarker();
  // Update pop-out map home marker
  if (popoutOpen) window.api.sendPopoutHome({ grid: document.getElementById('set-grid').value });
});

// --- IPC listeners ---
window.api.onSpots((spots) => {
  if (scanning) {
    pendingSpots = spots;
    return;
  }
  allSpots = spots;
  render();
});

window.api.onSpotsError((msg) => {
  console.warn('Spots error:', msg);
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
  if (!connected && error) {
    showLogToast(`CAT: ${error}`, { warn: true, sticky: true });
  }
});

// --- Update available listener ---
let updaterActive = false;

window.api.onUpdaterActive((active) => { updaterActive = active; });

window.api.onUpdateAvailable((data) => {
  const banner = document.getElementById('update-banner');
  const message = document.getElementById('update-message');
  const actionBtn = document.getElementById('update-action-btn');
  const updateLink = document.getElementById('update-link');
  const supportLink = document.getElementById('support-link');
  const dismissBtn = document.getElementById('update-dismiss');

  const version = data.version;
  const headline = data.releaseName || data.headline || '';
  message.textContent = headline
    ? `v${version}: ${headline}`
    : `POTACAT v${version} is available!`;

  if (updaterActive && !data.url) {
    // Installed build — show Upgrade button
    actionBtn.textContent = 'Upgrade';
    actionBtn.disabled = false;
    actionBtn.classList.remove('hidden');
    updateLink.classList.add('hidden');
    actionBtn.onclick = () => {
      actionBtn.textContent = 'Downloading... 0%';
      actionBtn.disabled = true;
      window.api.startDownload();
    };
  } else {
    // Portable build — show Download link
    actionBtn.classList.add('hidden');
    updateLink.classList.remove('hidden');
    const url = data.url || `https://github.com/Waffleslop/POTACAT/releases/latest`;
    updateLink.onclick = (e) => {
      e.preventDefault();
      window.api.openExternal(url);
    };
  }

  supportLink.onclick = (e) => {
    e.preventDefault();
    window.api.openExternal('https://buymeacoffee.com/potacat');
  };
  dismissBtn.onclick = () => {
    banner.classList.add('hidden');
  };
  banner.classList.remove('hidden');
});

window.api.onDownloadProgress(({ percent }) => {
  const actionBtn = document.getElementById('update-action-btn');
  actionBtn.textContent = `Downloading... ${percent}%`;
});

window.api.onUpdateDownloaded(() => {
  const actionBtn = document.getElementById('update-action-btn');
  actionBtn.textContent = 'Restart to Upgrade';
  actionBtn.disabled = false;
  actionBtn.onclick = () => {
    window.api.installUpdate();
  };
});

// --- Worked callsigns listener ---
window.api.onWorkedCallsigns((list) => {
  workedCallsigns = new Set(list);
  render();
});

// --- Donor callsigns listener ---
window.api.onDonorCallsigns((list) => {
  donorCallsigns = new Set(list.map(cs => cs.toUpperCase()));
  render();
});

// --- DX Expedition callsigns listener ---
window.api.onExpeditionCallsigns((list) => {
  expeditionCallsigns = new Set(list.map(cs => cs.toUpperCase()));
  render();
});

// --- Worked parks listener ---
window.api.onQrzData((data) => {
  for (const [cs, info] of Object.entries(data)) {
    qrzData.set(cs.toUpperCase(), info);
  }
  render(); // re-render to show operator names
});

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

  // Show/hide the toggle button based on whether CSV is loaded and POTA is enabled
  const hasData = workedParksData.size > 0 && enablePota;
  parksStatsToggleBtn.classList.toggle('hidden', !hasData);

  // Panel visibility: only when toggled open, has data, and on table/map view
  if (!parksStatsOpen || !hasData || (!showTable && !showMap)) {
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
  clusterConnected = connected;
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
  if (showTable || showMap) render();
});

window.api.onWsjtxClear(() => {
  wsjtxDecodes = [];
  if (showTable || showMap) render();
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
  if (showTable || showMap) render();
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
  if (enableBandActivity && showMap) {
    bandActivityBar.classList.remove('hidden');
  } else {
    bandActivityBar.classList.add('hidden');
  }
  if (map) setTimeout(() => map.invalidateSize(), 0);
}

function renderBandActivity() {
  if (!enableBandActivity || !showMap) return;

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
  rbnConnected = connected;
});

// --- PSKReporter status listener ---
let pskrNextPollAt = null;
window.api.onPskrStatus(({ connected, error, spotCount, nextPollAt, pollUpdate }) => {
  pskrConnected = connected;
  if (nextPollAt) pskrNextPollAt = nextPollAt;
  if (!pollUpdate) {
    if (connected && spotCount != null) showLogToast(`FreeDV: ${spotCount} spots (polling every 5 min)`, { duration: 4000 });
    if (error) showLogToast(error, { warn: true, duration: 5000 });
  }
});

// FreeDV tooltip — show countdown to next poll on hover
(function setupPskrTooltip() {
  const label = spotsPskr.closest('label');
  if (!label) return;
  let tipTimer = null;
  const updateTip = () => {
    if (!pskrNextPollAt) { label.title = 'FreeDV spots from PSKReporter'; return; }
    const secsLeft = Math.max(0, Math.round((pskrNextPollAt - Date.now()) / 1000));
    if (secsLeft === 0) { label.title = 'Updating now\u2026'; return; }
    const m = Math.floor(secsLeft / 60);
    const s = secsLeft % 60;
    label.title = `Next update in ${m}m ${String(s).padStart(2, '0')}s`;
  };
  label.addEventListener('mouseenter', () => {
    updateTip();
    tipTimer = setInterval(updateTip, 1000);
  });
  label.addEventListener('mouseleave', () => {
    if (tipTimer) { clearInterval(tipTimer); tipTimer = null; }
  });
})();

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
  window.api.openExternal('https://github.com/Waffleslop/POTACAT/issues');
});
document.getElementById('hamlib-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://hamlib.github.io/');
});

// --- Collapsible settings sections ---
document.querySelectorAll('.collapsible-legend').forEach(legend => {
  const fieldset = legend.closest('fieldset');
  const key = 'potacat-collapse-' + legend.dataset.target;
  // Restore collapsed state
  if (localStorage.getItem(key) === '1') fieldset.classList.add('collapsed');
  legend.addEventListener('click', () => {
    fieldset.classList.toggle('collapsed');
    localStorage.setItem(key, fieldset.classList.contains('collapsed') ? '1' : '0');
  });
});

// --- Hotkeys dialog ---
document.getElementById('hotkeys-dialog-close').addEventListener('click', () => {
  document.getElementById('hotkeys-dialog').close();
});
document.getElementById('hotkeys-hint').addEventListener('click', () => {
  document.getElementById('hotkeys-dialog').showModal();
});
document.getElementById('hotkeys-link').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('settings-dialog').close();
  document.getElementById('hotkeys-dialog').showModal();
});

// --- Titlebar controls ---
if (window.api.platform === 'darwin') {
  document.body.classList.add('platform-darwin');
} else {
  document.getElementById('tb-min').addEventListener('click', () => window.api.minimize());
  document.getElementById('tb-max').addEventListener('click', () => window.api.maximize());
  document.getElementById('tb-close').addEventListener('click', () => window.api.close());
}

// --- Welcome dialog (first run) ---
const welcomeDialog = document.getElementById('welcome-dialog');
const welcomeGridInput = document.getElementById('welcome-grid');
const welcomeLightMode = document.getElementById('welcome-light-mode');
const welcomeCallsignInput = document.getElementById('welcome-callsign');

welcomeLightMode.addEventListener('change', () => applyTheme(welcomeLightMode.checked));

// --- Welcome rig editor ---
let welcomeRig = null; // rig configured in welcome dialog
let welcomeHamlibLoaded = false;
let welcomeSerialcatLoaded = false;
let welcomeAllRigOptions = [];

function getWelcomeRadioType() {
  const checked = document.querySelector('input[name="welcome-radio-type"]:checked');
  return checked ? checked.value : 'flex';
}

function updateWelcomeRadioSubPanels() {
  const type = getWelcomeRadioType();
  document.getElementById('welcome-flex-config').classList.toggle('hidden', type !== 'flex');
  document.getElementById('welcome-tcpcat-config').classList.toggle('hidden', type !== 'tcpcat');
  document.getElementById('welcome-serialcat-config').classList.toggle('hidden', type !== 'serialcat');
  document.getElementById('welcome-hamlib-config').classList.toggle('hidden', type !== 'hamlib');
  if (type === 'serialcat' && !welcomeSerialcatLoaded) {
    welcomeSerialcatLoaded = true;
    loadWelcomeSerialcatPorts();
  }
  if (type === 'hamlib' && !welcomeHamlibLoaded) {
    welcomeHamlibLoaded = true;
    loadWelcomeHamlibFields();
  }
}

async function loadWelcomeSerialcatPorts() {
  const ports = await window.api.listPorts();
  const sel = document.getElementById('welcome-serialcat-port');
  sel.innerHTML = '';
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = `${p.path} — ${p.friendlyName}`;
    sel.appendChild(opt);
  }
}

async function loadWelcomeHamlibFields() {
  const rigModel = document.getElementById('welcome-rig-model');
  const rigPort = document.getElementById('welcome-rig-port');
  rigModel.innerHTML = '<option value="">Loading rigs...</option>';
  const rigs = await window.api.listRigs();
  welcomeAllRigOptions = rigs;
  rigModel.innerHTML = '';
  for (const rig of rigs) {
    const opt = document.createElement('option');
    opt.value = rig.id;
    opt.textContent = `${rig.mfg} ${rig.model}`;
    rigModel.appendChild(opt);
  }
  const ports = await window.api.listPorts();
  rigPort.innerHTML = '';
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = `${p.path} — ${p.friendlyName}`;
    rigPort.appendChild(opt);
  }
}

function buildWelcomeCatTarget() {
  const type = getWelcomeRadioType();
  if (type === 'flex') {
    return { type: 'tcp', host: '127.0.0.1', port: parseInt(document.getElementById('welcome-flex-slice').value, 10) };
  } else if (type === 'tcpcat') {
    return { type: 'tcp', host: document.getElementById('welcome-tcpcat-host').value.trim() || '127.0.0.1', port: parseInt(document.getElementById('welcome-tcpcat-port').value, 10) || 5002 };
  } else if (type === 'serialcat') {
    const manual = document.getElementById('welcome-serialcat-port-manual').value.trim();
    return {
      type: 'serial',
      path: manual || document.getElementById('welcome-serialcat-port').value,
      baudRate: parseInt(document.getElementById('welcome-serialcat-baud').value, 10) || 9600,
      dtrOff: document.getElementById('welcome-serialcat-dtr-off').checked,
    };
  } else if (type === 'hamlib') {
    const manual = document.getElementById('welcome-rig-port-manual').value.trim();
    return {
      type: 'rigctld',
      rigId: parseInt(document.getElementById('welcome-rig-model').value, 10),
      serialPort: manual || document.getElementById('welcome-rig-port').value,
      baudRate: parseInt(document.getElementById('welcome-rig-baud').value, 10),
      dtrOff: document.getElementById('welcome-rig-dtr-off').checked,
    };
  }
  return null;
}

function showWelcomeRigItem(rig) {
  const display = document.getElementById('welcome-rig-display');
  display.innerHTML = '';
  const item = document.createElement('div');
  item.className = 'rig-item active';
  item.innerHTML = `
    <div class="rig-item-info">
      <div class="rig-item-name">${rig.name || 'Unnamed Rig'}</div>
      <div class="rig-item-desc">${describeRigTarget(rig.catTarget)}</div>
    </div>
  `;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'rig-item-btn rig-delete-btn';
  removeBtn.textContent = '\u2715';
  removeBtn.title = 'Remove';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    welcomeRig = null;
    display.innerHTML = '';
    display.classList.add('hidden');
    document.getElementById('welcome-rig-add-btn').classList.remove('hidden');
  });
  item.appendChild(removeBtn);
  display.appendChild(item);
  display.classList.remove('hidden');
}

document.querySelectorAll('input[name="welcome-radio-type"]').forEach((btn) => {
  btn.addEventListener('change', () => updateWelcomeRadioSubPanels());
});

document.getElementById('welcome-rig-add-btn').addEventListener('click', () => {
  welcomeHamlibLoaded = false;
  welcomeSerialcatLoaded = false;
  document.getElementById('welcome-rig-editor').classList.remove('hidden');
  document.getElementById('welcome-rig-add-btn').classList.add('hidden');
  document.getElementById('welcome-rig-name').value = '';
  document.querySelector('input[name="welcome-radio-type"][value="flex"]').checked = true;
  updateWelcomeRadioSubPanels();
  document.getElementById('welcome-rig-name').focus();
});

document.getElementById('welcome-rig-cancel-btn').addEventListener('click', () => {
  document.getElementById('welcome-rig-editor').classList.add('hidden');
  document.getElementById('welcome-rig-add-btn').classList.remove('hidden');
});

document.getElementById('welcome-rig-save-btn').addEventListener('click', () => {
  const name = document.getElementById('welcome-rig-name').value.trim() || 'My Radio';
  const catTarget = buildWelcomeCatTarget();
  welcomeRig = { id: 'rig_' + Date.now(), name, catTarget };
  showWelcomeRigItem(welcomeRig);
  document.getElementById('welcome-rig-editor').classList.add('hidden');
  document.getElementById('welcome-rig-add-btn').classList.add('hidden');
});

document.getElementById('welcome-radio-help-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://potacat.com/radios.html');
});

document.getElementById('welcome-radio-discord-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://discord.gg/JjdKSshej');
});

// Welcome hamlib rig search filter
document.getElementById('welcome-rig-search').addEventListener('input', () => {
  const query = document.getElementById('welcome-rig-search').value.toLowerCase().trim();
  const sel = document.getElementById('welcome-rig-model');
  sel.innerHTML = '';
  const filtered = query ? welcomeAllRigOptions.filter(r => `${r.mfg} ${r.model}`.toLowerCase().includes(query)) : welcomeAllRigOptions;
  for (const rig of filtered) {
    const opt = document.createElement('option');
    opt.value = rig.id;
    opt.textContent = `${rig.mfg} ${rig.model}`;
    sel.appendChild(opt);
  }
});

// Welcome import buttons
document.getElementById('welcome-import-adif').addEventListener('click', async () => {
  const resultEl = document.getElementById('welcome-adif-result');
  resultEl.textContent = 'Importing...';
  resultEl.className = 'welcome-import-result';
  try {
    const result = await window.api.importAdif();
    if (!result) {
      resultEl.textContent = '';
    } else if (result.success) {
      resultEl.textContent = `${result.imported} QSOs imported`;
      resultEl.className = 'welcome-import-result success';
    } else {
      resultEl.textContent = 'Import failed';
      resultEl.className = 'welcome-import-result error';
    }
  } catch (err) {
    resultEl.textContent = 'Import failed';
    resultEl.className = 'welcome-import-result error';
  }
});

document.getElementById('welcome-import-parks').addEventListener('click', async () => {
  const resultEl = document.getElementById('welcome-parks-result');
  try {
    const filePath = await window.api.choosePotaParksFile();
    if (filePath) {
      const currentSettings = await window.api.getSettings();
      await window.api.saveSettings(Object.assign({}, currentSettings, { potaParksPath: filePath }));
      resultEl.textContent = 'Parks loaded';
      resultEl.className = 'welcome-import-result success';
    }
  } catch (err) {
    resultEl.textContent = 'Load failed';
    resultEl.className = 'welcome-import-result error';
  }
});

document.getElementById('welcome-pota-csv-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://pota.app');
});

document.getElementById('welcome-start').addEventListener('click', async () => {
  const myCallsign = (welcomeCallsignInput.value.trim() || '').toUpperCase();
  const grid = welcomeGridInput.value.trim() || 'FN20jb';
  const distUnitVal = document.getElementById('welcome-dist-unit').value;
  const licenseClassVal = document.getElementById('welcome-license-class').value;
  const hideOobChecked = document.getElementById('welcome-hide-oob').checked;
  const enablePotaVal = document.getElementById('welcome-enable-pota').checked;
  const enableSotaVal = document.getElementById('welcome-enable-sota').checked;
  const enableWwffVal = document.getElementById('welcome-enable-wwff') ? document.getElementById('welcome-enable-wwff').checked : false;
  const enableLlotaVal = document.getElementById('welcome-enable-llota') ? document.getElementById('welcome-enable-llota').checked : false;
  const lightModeEnabled = welcomeLightMode.checked;
  const currentSettings = await window.api.getSettings();

  const saveData = {
    myCallsign,
    grid,
    distUnit: distUnitVal,
    licenseClass: licenseClassVal,
    hideOutOfBand: hideOobChecked,
    firstRun: false,
    lastVersion: currentSettings.appVersion,
    maxAgeMin: 5,
    scanDwell: 7,
    enablePota: enablePotaVal,
    enableSota: enableSotaVal,
    enableWwff: enableWwffVal,
    enableLlota: enableLlotaVal,
    lightMode: lightModeEnabled,
  };

  // Add rig if configured in welcome
  if (welcomeRig) {
    saveData.rigs = [...(currentSettings.rigs || []), welcomeRig];
    saveData.activeRigId = welcomeRig.id;
  }

  await window.api.saveSettings(saveData);

  welcomeDialog.close();
  // Reload prefs so the main UI reflects welcome choices
  loadPrefs();
});

async function checkFirstRun(force = false) {
  const s = await window.api.getSettings();
  const isNewVersion = s.appVersion && s.lastVersion !== s.appVersion;
  if (force || s.firstRun || isNewVersion) {
    // Reset welcome rig state
    welcomeRig = null;
    const welcomeRigDisplay = document.getElementById('welcome-rig-display');
    welcomeRigDisplay.innerHTML = '';
    welcomeRigDisplay.classList.add('hidden');
    document.getElementById('welcome-rig-add-btn').classList.remove('hidden');
    document.getElementById('welcome-rig-editor').classList.add('hidden');
    // Pre-fill with existing settings on upgrade (not fresh install)
    if (force || !s.firstRun) {
      welcomeCallsignInput.value = s.myCallsign || '';
      welcomeGridInput.value = s.grid || '';
      if (s.distUnit) document.getElementById('welcome-dist-unit').value = s.distUnit;
      if (s.licenseClass) document.getElementById('welcome-license-class').value = s.licenseClass;
      document.getElementById('welcome-hide-oob').checked = s.hideOutOfBand === true;
      document.getElementById('welcome-enable-pota').checked = s.enablePota !== false;
      document.getElementById('welcome-enable-sota').checked = s.enableSota === true;
      if (document.getElementById('welcome-enable-wwff')) document.getElementById('welcome-enable-wwff').checked = s.enableWwff === true;
      if (document.getElementById('welcome-enable-llota')) document.getElementById('welcome-enable-llota').checked = s.enableLlota === true;
      welcomeLightMode.checked = s.lightMode === true;
      // Show existing active rig if any
      const rigs = s.rigs || [];
      const activeRig = rigs.find(r => r.id === s.activeRigId) || rigs[0];
      if (activeRig) {
        welcomeRig = activeRig;
        showWelcomeRigItem(activeRig);
      }
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

// Sticky table header via JS transform on each th
// (CSS position:sticky and transform on <thead> are unreliable in Chromium table rendering)
(function initStickyHeader() {
  const ths = spotsTable.querySelectorAll('thead th');
  if (!ths.length) return;
  let ticking = false;
  tablePaneEl.addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(() => {
        const y = tablePaneEl.scrollTop;
        for (let i = 0; i < ths.length; i++) {
          ths[i].style.transform = `translateY(${y}px)`;
        }
        ticking = false;
      });
    }
  });
})();
