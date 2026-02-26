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
let workedQsos = new Map(); // callsign → [{date, ref}] from QSO log
let donorCallsigns = new Set(); // supporter callsigns from potacat.com
let expeditionCallsigns = new Set(); // active DX expeditions from Club Log
let activeEvents = [];                // events from remote endpoint
let eventCallsignMap = new Map();     // callsign pattern → event id (for badge matching)
let eventOverlayOpen = false;
let hideWorked = false;
let workedParksSet = new Set(); // park references from CSV for fast lookup
let workedParksData = new Map(); // reference → full park data for stats
let hideWorkedParks = false;
let showBearing = false;
let respotDefault = true; // default: re-spot on POTA after logging
let respotTemplate = '{rst} in {QTH} 73s {mycallsign} via POTACAT'; // park re-spot comment template
let dxRespotTemplate = 'Heard in {QTH} 73s {mycallsign} via POTACAT'; // DX cluster spot comment template
let quickRespotTemplate = 'Heard strong in {QTH}; 73s {callsign} via POTACAT'; // legacy — migrated below
let grid = ''; // home grid square for {QTH} template substitution
let myCallsign = '';
let lastTunedSpot = null; // last clicked/tuned spot for quick respot
let popoutOpen = false; // pop-out map window is open
let qsoPopoutOpen = false; // pop-out QSO log window is open
let actmapPopoutOpen = false; // pop-out activation map window is open
let dxccData = null;  // { entities: [...] } from main process
let enableWsjtx = false;
let wsjtxDecodes = []; // recent decodes from WSJT-X (FIFO, max 50)
let wsjtxState = null; // last WSJT-X status (freq, mode, etc.)
const qrzData = new Map(); // callsign → { fname, name, addr2, state, country }
let qrzFullName = false; // show first+last or just first

// --- Activator Mode State ---
let appMode = 'hunter'; // 'hunter' or 'activator'
let activatorParkRefs = [];   // [{ref:'K-1234', name:'Cedar Falls SP'}, ...]  max 3
let hunterParkRefs = [];      // [{ref:'K-5678', name:'Shenandoah NF'}]  max 3, resets per QSO
let activatorContacts = []; // in-memory QSO list for current activation session
let activatorFreqKhz = 0;  // from CAT
let activationActive = false; // true while activation is running
let activationStartTime = 0;  // Date.now() when activation started
let activationTimerInterval = null;

/** Get primary activator park ref */
function primaryParkRef() { return activatorParkRefs[0]?.ref || ''; }
/** Get primary activator park name */
function primaryParkName() { return activatorParkRefs[0]?.name || ''; }

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
let radioMode = null;

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
const spotsDxcc = document.getElementById('spots-dxcc');
const settingsBtn = document.getElementById('settings-btn');
const logbookBtn = document.getElementById('logbook-btn');
const settingsDialog = document.getElementById('settings-dialog');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');
const setGrid = document.getElementById('set-grid');
const setDistUnit = document.getElementById('set-dist-unit');
const setMaxAge = document.getElementById('set-max-age');
const setRefreshInterval = document.getElementById('set-refresh-interval');
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
const rigctldnetConfig = document.getElementById('rigctldnet-config');
const setRigctldnetHost = document.getElementById('set-rigctldnet-host');
const setRigctldnetPort = document.getElementById('set-rigctldnet-port');
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
const setRigctldPort = document.getElementById('set-rigctld-port');
const setRigSearch = document.getElementById('set-rig-search');
const hamlibTestBtn = document.getElementById('hamlib-test-btn');
const hamlibTestResult = document.getElementById('hamlib-test-result');
const spotsTable = document.getElementById('spots-table');
const mapContainer = document.getElementById('map-container');
const mapDiv = document.getElementById('map');
const bandActivityBar = document.getElementById('band-activity-bar');
const splitContainerEl = document.getElementById('split-container');
const tablePaneEl = document.getElementById('table-pane');
const tableScrollEl = document.getElementById('table-scroll-wrap');
const mapPaneEl = document.getElementById('map-pane');
const splitSplitterEl = document.getElementById('split-splitter');
const viewTableBtn = document.getElementById('view-table-btn');
const viewMapBtn = document.getElementById('view-map-btn');
const popoutMapBtn = document.getElementById('popout-map-btn');
const dxccBoardBtn = document.getElementById('dxcc-board-btn');
const dxccView = document.getElementById('dxcc-view');
const dxccMatrixBody = document.getElementById('dxcc-matrix-body');
const dxccCountEl = document.getElementById('dxcc-count');
const dxccPlaceholder = document.getElementById('dxcc-placeholder');
const dxccBandSelectEl = document.getElementById('dxcc-band-select');
const dxccModeSelectEl = document.getElementById('dxcc-mode-select');
const dxccAwardLabelEl = document.getElementById('dxcc-award-label');
const dxccChallengeEl = document.getElementById('dxcc-challenge');
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
const clusterConfig = document.getElementById('cluster-config');
const clusterNodeList = document.getElementById('cluster-node-list');
const clusterPresetSelect = document.getElementById('cluster-preset-select');
const clusterAddBtn = document.getElementById('cluster-add-btn');
const clusterCustomFields = document.getElementById('cluster-custom-fields');
const setShowBeacons = document.getElementById('set-show-beacons');
const setShowDxBar = document.getElementById('set-show-dx-bar');
const rbnConfig = document.getElementById('rbn-config');
// Settings connection pills
const connBar = document.getElementById('settings-conn-status');
const connCluster = document.getElementById('conn-cluster');
const connRbn = document.getElementById('conn-rbn');
const connPskr = document.getElementById('conn-pskr');
let clusterConnected = false;
let clusterNodeStatuses = []; // [{id, name, host, connected}, ...]
let currentClusterNodes = []; // live node list for settings UI

const CLUSTER_PRESETS = [
  { name: 'W3LPL', host: 'w3lpl.net', port: 7373 },
  { name: 'VE7CC', host: 'dxc.ve7cc.net', port: 23 },
  { name: 'DXUSA', host: 'dxc.dxusa.net', port: 7373 },
  { name: 'NC7J', host: 'dxc.nc7j.com', port: 7373 },
  { name: 'K1TTT', host: 'k1ttt.net', port: 7373 },
  { name: 'W6CUA', host: 'w6cua.no-ip.org', port: 7300 },
  { name: 'G6NHU', host: 'dxspider.co.uk', port: 7300 },
  { name: 'EA4RCH', host: 'dxfun.com', port: 8000 },
  { name: 'DA0BCC', host: 'dx.da0bcc.de', port: 7300 },
  { name: 'PI4CC', host: 'dxc.pi4cc.nl', port: 8000 },
  { name: 'WA9PIE', host: 'dxc.wa9pie.net', port: 7373 },
  { name: 'W0MU', host: 'dxc.w0mu.net', port: 7373 },
  { name: 'OH2AQ', host: 'oh2aq.kolumbus.fi', port: 8000 },
];
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
const potaParksClearBtn = document.getElementById('pota-parks-clear-btn');
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
const distHeader = document.getElementById('dist-header');
const utcClockEl = document.getElementById('utc-clock');
const sfiStatusEl = document.getElementById('sfi-status');
const kStatusEl = document.getElementById('k-status');
const aStatusEl = document.getElementById('a-status');
const setColorRows = document.getElementById('set-color-rows');
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
const setTciSpots = document.getElementById('set-tci-spots');
const tciConfig = document.getElementById('tci-config');
const setTciHost = document.getElementById('set-tci-host');
const setTciPort = document.getElementById('set-tci-port');
const setTciPota = document.getElementById('set-tci-pota');
const setTciSota = document.getElementById('set-tci-sota');
const setTciCluster = document.getElementById('set-tci-cluster');
const setTciRbn = document.getElementById('set-tci-rbn');
const setTciWwff = document.getElementById('set-tci-wwff');
const setTciLlota = document.getElementById('set-tci-llota');
const setTciPskr = document.getElementById('set-tci-pskr');
const setTciMaxAge = document.getElementById('set-tci-max-age');
// CW Keyer
const setEnableCwKeyer = document.getElementById('set-enable-cw-keyer');
const cwKeyerConfig = document.getElementById('cw-keyer-config');
const setCwKeyerMode = document.getElementById('set-cw-keyer-mode');
const setCwWpm = document.getElementById('set-cw-wpm');
const setCwSwapPaddles = document.getElementById('set-cw-swap-paddles');
const setCwMidiDevice = document.getElementById('set-cw-midi-device');
const cwMidiRefreshBtn = document.getElementById('cw-midi-refresh-btn');
const setCwMidiDitNote = document.getElementById('set-cw-midi-dit-note');
const setCwMidiDahNote = document.getElementById('set-cw-midi-dah-note');
const cwLearnDitBtn = document.getElementById('cw-learn-dit-btn');
const cwLearnDahBtn = document.getElementById('cw-learn-dah-btn');
const setCwSidetone = document.getElementById('set-cw-sidetone');
const setCwSidetonePitch = document.getElementById('set-cw-sidetone-pitch');
const setCwSidetoneVolume = document.getElementById('set-cw-sidetone-volume');
const cwSidetoneVolumeLabel = document.getElementById('cw-sidetone-volume-label');
const cwKeyerStatusEl = document.getElementById('cw-keyer-status');
const logDialog = document.getElementById('log-dialog');
const logCallsign = document.getElementById('log-callsign');
const logOpName = document.getElementById('log-op-name');
const logFrequency = document.getElementById('log-frequency');
const logMode = document.getElementById('log-mode');
const logDate = document.getElementById('log-date');
const logTime = document.getElementById('log-time');
const logPower = document.getElementById('log-power');
// RST split-digit helpers
function setRstDigits(containerId, value) {
  const digits = document.querySelectorAll(`#${containerId} .rst-digit`);
  const chars = String(value).split('');
  digits[0].value = chars[0] || '';
  digits[1].value = chars[1] || '';
  digits[2].value = chars[2] || '';
}
function getRstDigits(containerId, fallback) {
  const digits = document.querySelectorAll(`#${containerId} .rst-digit`);
  const val = Array.from(digits).map(d => d.value).join('');
  return val || fallback;
}
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
  if (settings.appVersion) {
    window._appVersion = settings.appVersion;
    updateTitleBar();
  }
  applyTheme(settings.lightMode === true);
  grid = settings.grid || '';
  distUnit = settings.distUnit || 'mi';
  scanDwell = parseInt(settings.scanDwell, 10) || 7;
  watchlist = parseWatchlist(settings.watchlist);
  enablePota = settings.enablePota !== false; // default true
  enableSota = settings.enableSota === true;  // default false
  enableWwff = settings.enableWwff === true;  // default false
  enableLlota = settings.enableLlota === true; // default false
  enableDxcc = settings.enableDxcc === true;  // default false
  enableCluster = settings.enableCluster === true; // default false
  showDxBar = settings.showDxBar === true;
  dxCommandPreferredNode = localStorage.getItem('dx-command-node') || '';
  updateDxCommandBar();
  enableRbn = settings.enableRbn === true; // default false
  enablePskr = settings.enablePskr === true; // default false
  enableSolar = settings.enableSolar === true;   // default false
  // Color rows — default true (on)
  spotsTable.classList.toggle('no-source-tint', settings.colorRows === false);
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
  if (settings.dxRespotTemplate != null) dxRespotTemplate = settings.dxRespotTemplate;
  if (settings.quickRespotTemplate != null) quickRespotTemplate = settings.quickRespotTemplate;
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
  // CW Keyer: init MIDI + connect saved device on load
  if (settings.enableCwKeyer) {
    cwKeyerStatusEl.classList.remove('hidden');
    populateMidiDevices().then(() => {
      if (settings.cwMidiDevice) connectMidiDevice(settings.cwMidiDevice);
    });
  }
  updateRbnButton();
  updateDxccButton();
  // Activator mode restore
  if (settings.appMode === 'activator') {
    appMode = 'activator';
    // Restore activator parks — migrate from legacy single string to array
    if (settings.activatorParkRefs && Array.isArray(settings.activatorParkRefs) && settings.activatorParkRefs.length) {
      activatorParkRefs = settings.activatorParkRefs;
      activatorParkRefInput.value = primaryParkRef();
      activatorParkNameEl.textContent = primaryParkName();
      updateParkExtraBadge();
      // Resolve names if missing
      for (const p of activatorParkRefs) {
        if (!p.name) {
          window.api.getPark(p.ref).then(park => {
            if (park) { p.name = park.name || ''; updateParkDisplay(); }
          });
        }
      }
    } else if (settings.activatorParkRef) {
      activatorParkRefs = [{ ref: settings.activatorParkRef, name: '' }];
      activatorParkRefInput.value = settings.activatorParkRef;
      window.api.getPark(settings.activatorParkRef).then(park => {
        if (park) {
          activatorParkRefs[0].name = park.name || '';
          activatorParkNameEl.textContent = park.name || '';
        }
      });
      // Migrate to new format
      window.api.saveSettings({ activatorParkRefs, activatorParkRef: undefined });
    }
    setAppMode('activator');
  }
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
  rigctldnetConfig.classList.toggle('hidden', type !== 'rigctldnet');
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
  } else if (currentTarget.type === 'rigctldnet') {
    setRadioType('rigctldnet');
    setRigctldnetHost.value = currentTarget.host || '127.0.0.1';
    setRigctldnetPort.value = currentTarget.port || 4532;
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

  // Restore rigctld port
  setRigctldPort.value = (savedTarget && savedTarget.rigctldPort) || 4532;
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
    const comPort = target.serialPort || '?';
    const rPort = target.rigctldPort && target.rigctldPort !== 4532 ? ` (port ${target.rigctldPort})` : '';
    return `Hamlib on ${comPort}${rPort}`;
  }
  if (target.type === 'rigctldnet') {
    return `rigctld on ${target.host || '127.0.0.1'}:${target.port || 4532}`;
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
      rigctldPort: parseInt(setRigctldPort.value, 10) || 4532,
    };
  } else if (radioType === 'rigctldnet') {
    return {
      type: 'rigctldnet',
      host: setRigctldnetHost.value.trim() || '127.0.0.1',
      port: parseInt(setRigctldnetPort.value, 10) || 4532,
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

// DXCC filter constants
const DXCC_MODE_GROUPS = {
  phone:   new Set(['SSB', 'AM', 'FM', 'USB', 'LSB']),
  cw:      new Set(['CW']),
  digital: new Set(['FT8', 'FT4', 'RTTY', 'PSK31', 'JT65', 'JT9', 'DATA', 'OLIVIA', 'MFSK'])
};
const DXCC_CHALLENGE_BANDS = ['160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m']; // excludes 60m per ARRL rules

// DXCC band/mode filter — re-render matrix on change
function initDxccFilters() {
  // Restore saved filter state
  try {
    const saved = JSON.parse(localStorage.getItem('pota-cat-dxcc-filter'));
    if (saved) {
      if (saved.band) dxccBandSelectEl.value = saved.band;
      if (saved.mode) dxccModeSelectEl.value = saved.mode;
    }
  } catch (e) { /* ignore */ }

  function onFilterChange() {
    localStorage.setItem('pota-cat-dxcc-filter', JSON.stringify({
      band: dxccBandSelectEl.value,
      mode: dxccModeSelectEl.value
    }));
    if (currentView === 'dxcc') renderDxccMatrix();
  }

  dxccBandSelectEl.addEventListener('change', onFilterChange);
  dxccModeSelectEl.addEventListener('change', onFilterChange);
}
initDxccFilters();

function getDxccModeFilter() {
  const val = dxccModeSelectEl.value;
  return val === 'all' ? null : DXCC_MODE_GROUPS[val] || null;
}

function updateDxccButton() {
  if (!enableDxcc && currentView === 'dxcc') setView('table');
}

function updateWsjtxStatusVisibility() {
  wsjtxStatusEl.classList.toggle('hidden', !enableWsjtx);
}

function updateSettingsConnBar() {
  const anyVisible = enableCluster || enableRbn || enablePskr;
  connBar.classList.toggle('hidden', !anyVisible);
  connCluster.classList.toggle('hidden', !enableCluster);
  connCluster.classList.toggle('connected', clusterConnected);
  // Tooltip showing per-node status breakdown
  if (clusterNodeStatuses.length > 0) {
    connCluster.title = clusterNodeStatuses.map(n => n.name + ': ' + (n.connected ? 'connected' : 'disconnected')).join('\n');
  } else {
    connCluster.title = '';
  }
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

// --- Cluster node list rendering ---
function renderClusterNodeList(nodes) {
  clusterNodeList.innerHTML = '';
  for (const node of nodes) {
    const item = document.createElement('div');
    item.className = 'node-item';
    item.dataset.id = node.id;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = node.enabled;
    cb.addEventListener('change', () => {
      node.enabled = cb.checked;
      // Enforce max 3 enabled
      const enabledCount = currentClusterNodes.filter(n => n.enabled).length;
      if (enabledCount > 3) {
        cb.checked = false;
        node.enabled = false;
        alert('Maximum 3 simultaneous cluster connections.');
      }
    });

    const info = document.createElement('div');
    info.className = 'node-item-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'node-item-name';
    nameEl.textContent = node.name;
    const hostEl = document.createElement('div');
    hostEl.className = 'node-item-host';
    hostEl.textContent = node.host + ':' + node.port;
    info.appendChild(nameEl);
    info.appendChild(hostEl);

    const dot = document.createElement('span');
    dot.className = 'node-status-dot';
    // Update from live status
    const status = clusterNodeStatuses.find(s => s.id === node.id);
    if (status && status.connected) dot.classList.add('connected');

    const delBtn = document.createElement('button');
    delBtn.className = 'node-item-btn node-delete-btn';
    delBtn.textContent = '\u2715';
    delBtn.title = 'Remove node';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentClusterNodes = currentClusterNodes.filter(n => n.id !== node.id);
      renderClusterNodeList(currentClusterNodes);
    });

    item.appendChild(cb);
    item.appendChild(info);
    item.appendChild(dot);
    item.appendChild(delBtn);
    clusterNodeList.appendChild(item);
  }
}

// Populate preset dropdown
function populateClusterPresets() {
  clusterPresetSelect.innerHTML = '<option value="">Add a node...</option>';
  for (const p of CLUSTER_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name + ' (' + p.host + ':' + p.port + ')';
    clusterPresetSelect.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = 'Custom node...';
  clusterPresetSelect.appendChild(customOpt);
}
populateClusterPresets();

clusterPresetSelect.addEventListener('change', () => {
  clusterCustomFields.classList.toggle('hidden', clusterPresetSelect.value !== '__custom__');
});

clusterAddBtn.addEventListener('click', () => {
  const val = clusterPresetSelect.value;
  if (!val) return;

  if (currentClusterNodes.length >= 3) {
    alert('Maximum 3 cluster nodes. Remove one before adding another.');
    return;
  }

  let newNode;
  if (val === '__custom__') {
    const name = document.getElementById('set-cluster-custom-name').value.trim();
    const host = document.getElementById('set-cluster-custom-host').value.trim();
    const port = parseInt(document.getElementById('set-cluster-custom-port').value, 10) || 7373;
    if (!host) { alert('Please enter a hostname.'); return; }
    newNode = { id: Date.now().toString(36), name: name || host, host, port, enabled: true, preset: null };
    document.getElementById('set-cluster-custom-name').value = '';
    document.getElementById('set-cluster-custom-host').value = '';
    document.getElementById('set-cluster-custom-port').value = '7373';
  } else {
    const preset = CLUSTER_PRESETS.find(p => p.name === val);
    if (!preset) return;
    // Check for duplicate host
    if (currentClusterNodes.some(n => n.host === preset.host && n.port === preset.port)) {
      alert(preset.name + ' is already in the list.');
      return;
    }
    newNode = { id: Date.now().toString(36), name: preset.name, host: preset.host, port: preset.port, enabled: true, preset: preset.name };
  }

  currentClusterNodes.push(newNode);
  renderClusterNodeList(currentClusterNodes);
  clusterPresetSelect.value = '';
  clusterCustomFields.classList.add('hidden');
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

// TCI checkbox toggles config visibility
setTciSpots.addEventListener('change', () => {
  tciConfig.classList.toggle('hidden', !setTciSpots.checked);
});

// CW Keyer checkbox toggles config visibility + auto-connect MIDI
setEnableCwKeyer.addEventListener('change', () => {
  cwKeyerConfig.classList.toggle('hidden', !setEnableCwKeyer.checked);
  if (setEnableCwKeyer.checked) {
    populateMidiDevices().then(() => connectMidiDevice(setCwMidiDevice.value));
  }
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

potaParksBrowseBtn.addEventListener('click', async () => {
  const filePath = await window.api.choosePotaParksFile();
  if (filePath) {
    setPotaParksPath.value = filePath;
    potaParksClearBtn.style.display = '';
  }
});

potaParksClearBtn.addEventListener('click', () => {
  setPotaParksPath.value = '';
  potaParksClearBtn.style.display = 'none';
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

function isWorkedSpot(spot) {
  const entries = workedQsos.get(spot.callsign.toUpperCase());
  if (!entries || entries.length === 0) return false;
  const now = new Date();
  const todayUtc = now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0');
  const todayQsos = entries.filter(e => e.date === todayUtc);
  if (todayQsos.length === 0) return false;
  // Match on band — only grey out if worked on same band today
  const spotBand = (spot.band || '').toUpperCase();
  if (spotBand) return todayQsos.some(e => e.band === spotBand);
  return true;
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
    if (hideWorked && isWorkedSpot(s)) return false;
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
  { key: 'source', label: 'Source' },
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
  // Separator + Reset Column Order
  const sep = document.createElement('div');
  sep.style.cssText = 'border-top:1px solid #444;margin:4px 0;';
  colContextMenu.appendChild(sep);
  const resetItem = document.createElement('div');
  resetItem.className = 'col-ctx-item';
  resetItem.style.cssText = 'cursor:pointer;padding:4px 8px;';
  resetItem.textContent = 'Reset Column Order';
  resetItem.addEventListener('click', () => {
    colOrder = [...DEFAULT_COL_ORDER];
    saveColOrder();
    applyColOrder();
    applyColWidths(loadColWidths());
    render();
    colContextMenu.classList.add('hidden');
  });
  colContextMenu.appendChild(resetItem);

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

// --- Column Order (drag-and-drop reordering) ---
const COL_ORDER_KEY = 'pota-cat-col-order-v1';
const DEFAULT_COL_ORDER = [
  'log','callsign','operator','frequency','mode','source','reference',
  'parkName','locationDesc','distance','bearing','spotTime','comments','skip'
];

function loadColOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(COL_ORDER_KEY));
    if (Array.isArray(saved)) {
      // Migrate: insert new columns that didn't exist in older versions
      for (const col of DEFAULT_COL_ORDER) {
        if (!saved.includes(col)) {
          const defaultIdx = DEFAULT_COL_ORDER.indexOf(col);
          // Find best insertion point: after the previous default column
          const prev = DEFAULT_COL_ORDER[defaultIdx - 1];
          const prevIdx = prev ? saved.indexOf(prev) : -1;
          saved.splice(prevIdx + 1, 0, col);
        }
      }
      // Remove any columns no longer in default
      const filtered = saved.filter(c => DEFAULT_COL_ORDER.includes(c));
      if (filtered.length === DEFAULT_COL_ORDER.length &&
          DEFAULT_COL_ORDER.every(k => filtered.includes(k))) return filtered;
    }
  } catch { /* ignore */ }
  return [...DEFAULT_COL_ORDER];
}

function saveColOrder() {
  localStorage.setItem(COL_ORDER_KEY, JSON.stringify(colOrder));
}

function applyColOrder() {
  const thead = spotsTable.querySelector('thead tr');
  if (!thead) return;
  const thMap = new Map();
  thead.querySelectorAll('th').forEach(th => thMap.set(th.getAttribute('data-col'), th));
  for (const col of colOrder) {
    const th = thMap.get(col);
    if (th) thead.appendChild(th);
  }
}

let colOrder = loadColOrder();

// --- Column Resizing ---
// Widths stored as { colKey: pct } object so they follow columns regardless of position
const COL_WIDTHS_KEY = 'pota-cat-col-pct-v10';
const COL_WIDTHS_KEY_V9 = 'pota-cat-col-pct-v9';
const DEFAULT_COL_PCT_OBJ = {
  log: 4, callsign: 8, operator: 7, frequency: 6, mode: 5, source: 5, reference: 6,
  parkName: 15, locationDesc: 7, distance: 6, bearing: 5, spotTime: 5, comments: 10, skip: 4
};

function loadColWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
  } catch { /* ignore */ }
  // Migrate from v9 object format — add missing columns with defaults
  try {
    const v9 = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY_V9));
    if (v9 && typeof v9 === 'object' && !Array.isArray(v9)) {
      for (const col of DEFAULT_COL_ORDER) {
        if (v9[col] == null) v9[col] = DEFAULT_COL_PCT_OBJ[col] || 5;
      }
      saveColWidths(v9);
      return v9;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_COL_PCT_OBJ };
}

function saveColWidths(widths) {
  localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(widths));
}

function applyColWidths(widths) {
  const ths = spotsTable.querySelectorAll('thead th');
  ths.forEach(th => {
    const col = th.getAttribute('data-col');
    if (col && widths[col] != null) th.style.width = widths[col] + '%';
  });
}

function initColumnResizing() {
  const colPcts = loadColWidths();
  applyColWidths(colPcts);

  const ths = spotsTable.querySelectorAll('thead th');
  ths.forEach(th => {
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.style.position = 'relative';
    th.appendChild(handle);

    // Prevent drag-and-drop from firing on resize handle
    handle.addEventListener('dragstart', (e) => { e.preventDefault(); });

    let startX, startPct;
    const col = th.getAttribute('data-col');

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't trigger sort
      startX = e.clientX;
      startPct = colPcts[col] || 5;
      const tableW = spotsTable.offsetWidth;
      document.body.style.cursor = 'col-resize';

      const onMove = (ev) => {
        const deltaPx = ev.clientX - startX;
        const deltaPct = (deltaPx / tableW) * 100;
        colPcts[col] = Math.max(3, startPct + deltaPct);
        th.style.width = colPcts[col] + '%';
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

// --- Column Drag-and-Drop Reordering ---
function initColumnDragging() {
  const ths = spotsTable.querySelectorAll('thead th');
  ths.forEach(th => {
    th.setAttribute('draggable', 'true');

    th.addEventListener('dragstart', (e) => {
      const col = th.getAttribute('data-col');
      e.dataTransfer.setData('text/plain', col);
      e.dataTransfer.effectAllowed = 'move';
      th.classList.add('col-dragging');
    });

    th.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Show drop indicator based on mouse position vs column midpoint
      const rect = th.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      th.classList.toggle('col-drop-left', e.clientX < midX);
      th.classList.toggle('col-drop-right', e.clientX >= midX);
    });

    th.addEventListener('dragleave', () => {
      th.classList.remove('col-drop-left', 'col-drop-right');
    });

    th.addEventListener('drop', (e) => {
      e.preventDefault();
      th.classList.remove('col-drop-left', 'col-drop-right');
      const sourceCol = e.dataTransfer.getData('text/plain');
      const targetCol = th.getAttribute('data-col');
      if (sourceCol === targetCol) return;

      const srcIdx = colOrder.indexOf(sourceCol);
      if (srcIdx === -1) return;
      colOrder.splice(srcIdx, 1);

      // Insert before or after target based on mouse position
      const rect = th.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      let tgtIdx = colOrder.indexOf(targetCol);
      if (e.clientX >= midX) tgtIdx++;
      colOrder.splice(tgtIdx, 0, sourceCol);

      saveColOrder();
      applyColOrder();
      applyColWidths(loadColWidths());
      render();
    });

    th.addEventListener('dragend', () => {
      th.classList.remove('col-dragging');
      // Clean up all drop indicators
      spotsTable.querySelectorAll('thead th').forEach(h => {
        h.classList.remove('col-drop-left', 'col-drop-right');
      });
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
let pendingTuneArc = null; // stashed arc data when map isn't ready yet

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
  pendingTuneArc = null;
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

  // Stash arc data so it can be drawn when map becomes visible
  if (lat != null && lon != null) {
    pendingTuneArc = { lat, lon, freq, source };
  }

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

const SOURCE_LABELS = {
  pota: 'POTA', sota: 'SOTA', dxc: 'DX', rbn: 'RBN',
  wwff: 'WWFF', llota: 'LLOTA', pskr: 'FreeDV',
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
    const mapEvent = getEventForCallsign(s.callsign);
    const eventBadgeHtml = mapEvent ? ` <span style="background:${mapEvent.badgeColor || '#ff6b00'};color:#fff;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">${mapEvent.badge || 'EVT'}</span>` : '';
    const wwffBadge = s.wwffReference ? ` <span style="background:#26a69a;color:#000;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">WWFF</span>` : '';
    const wwffRefLine = s.wwffReference ? `<br><b>${s.wwffReference}</b> ${s.wwffParkName || ''} <span style="color:#26a69a;font-size:11px;">[WWFF]</span>` : '';
    const qrzOp = qrzData.get(s.callsign.toUpperCase().split('/')[0]);
    const opName = qrzDisplayName(qrzOp);
    const opLine = opName ? `<span style="color:#b0bec5;font-size:11px;">${opName}</span><br>` : '';
    const popupContent = `
      <b>${watched ? '\u2B50 ' : ''}<a href="#" class="popup-qrz" data-call="${s.callsign}">${s.callsign}</a></b> <span style="color:${sourceColor};font-size:11px;">[${sourceLabel}]</span>${expeditionBadge}${eventBadgeHtml}${newBadge}${wwffBadge}<br>
      ${opLine}${parseFloat(s.frequency).toFixed(1)} kHz &middot; ${s.mode}<br>
      <b>${s.reference}</b> ${s.parkName}${wwffRefLine}<br>
      ${distStr}<br>
      <button class="tune-btn" data-freq="${s.frequency}" data-mode="${s.mode}" data-bearing="${s.bearing != null ? s.bearing : ''}" data-lat="${s.lat != null ? s.lat : ''}" data-lon="${s.lon != null ? s.lon : ''}" data-source="${s.source || ''}">Tune</button>${logBtnHtml}
    `;

    // Pin color matches source: POTA green, SOTA orange, DXC purple, etc.
    const oop = isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass);
    const worked = workedQsos.has(s.callsign.toUpperCase());
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
        : { icon: sourceIcon, ...(worked && isWorkedSpot(s) ? { opacity: 0.5 } : {}) };

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
        // Find matching spot in allSpots for quick respot
        const match = allSpots.find(s => s.frequency === btn.dataset.freq && s.callsign && s.mode === btn.dataset.mode);
        if (match) { lastTunedSpot = match; prefillDxCommand(match); }
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
  return filtered.filter((s) => !scanSkipped.has(s.frequency) && !isWorkedSpot(s));
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
  lastTunedSpot = spot;
  prefillDxCommand(spot);
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
  // F2 — QSO Log pop-out window
  if (e.key === 'F2' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    window.api.qsoPopoutOpen(); // opens or focuses existing pop-out
    return;
  }
  // F5 — Check for updates
  if (e.key === 'F5' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    window.api.checkForUpdates();
    showLogToast('Checking for updates...', { duration: 2000 });
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
  // Ctrl+A — Prevent select-all
  if (e.key === 'a' && (e.ctrlKey || e.metaKey) && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    return;
  }
  // Ctrl+M — Multi-park dialog (activator mode)
  if (e.key === 'm' && (e.ctrlKey || e.metaKey) && appMode === 'activator') {
    e.preventDefault();
    const context = document.activeElement === document.getElementById('activator-hunter-park') ? 'hunter' : 'my';
    openMultiparkDialog(context);
    return;
  }
  // Alt+R — Reload last entry (activator mode)
  if (e.key === 'r' && e.altKey && appMode === 'activator' && activationActive && activatorContacts.length > 0) {
    e.preventDefault();
    const last = activatorContacts[activatorContacts.length - 1];
    activatorCallsignInput.value = last.callsign;
    setRstDigits('activator-rst-sent', last.rstSent);
    setRstDigits('activator-rst-rcvd', last.rstRcvd);
    activatorCallsignInput.select();
    return;
  }
  // Ctrl+R / Cmd+R — Quick re-spot
  if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    openQuickRespot();
    return;
  }
  // Ctrl+L / Cmd+L — Quick Log (unspotted QSO)
  if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    openQuickLog();
    return;
  }
  // Ctrl+= / Ctrl+- / Ctrl+0 — UI zoom
  if (e.ctrlKey || e.metaKey) {
    const ZOOM_KEY = 'pota-cat-zoom';
    const ZOOM_MIN = 0.6, ZOOM_MAX = 2.0, ZOOM_STEP = 0.1;
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      const z = Math.min(ZOOM_MAX, window.api.getZoom() + ZOOM_STEP);
      window.api.setZoom(z);
      localStorage.setItem(ZOOM_KEY, z.toFixed(1));
    } else if (e.key === '-') {
      e.preventDefault();
      const z = Math.max(ZOOM_MIN, window.api.getZoom() - ZOOM_STEP);
      window.api.setZoom(z);
      localStorage.setItem(ZOOM_KEY, z.toFixed(1));
    } else if (e.key === '0') {
      e.preventDefault();
      window.api.setZoom(1.0);
      localStorage.removeItem(ZOOM_KEY);
    }
  }
});

// --- Quick Re-spot (Ctrl+R) ---
const SOURCE_COLORS = {
  pota: '#4ecca3', sota: '#f0a500', wwff: '#26a69a',
  llota: '#42a5f5', dxc: '#e040fb', rbn: '#00bcd4', pskr: '#ff6b6b'
};
const RESPOT_NAMES = { pota: 'POTA', wwff: 'WWFF', llota: 'LLOTA', dxc: 'DX Cluster' };

function getRespotTargets(s) {
  const targets = [];
  if (s.source === 'pota' && s.reference) {
    targets.push('pota');
    if (s.wwffReference) targets.push('wwff');
  } else if (s.source === 'wwff' && s.reference) {
    targets.push('wwff');
  } else if (s.source === 'llota' && s.reference) {
    targets.push('llota');
  } else if (clusterConnected) {
    targets.push('dxc');
  }
  return targets;
}

async function openQuickRespot() {
  if (!lastTunedSpot) {
    showLogToast('No respottable spot selected', { duration: 2000 });
    return;
  }
  const s = lastTunedSpot;
  const targets = getRespotTargets(s);
  if (!targets.length) {
    showLogToast('No respottable spot selected', { duration: 2000 });
    return;
  }
  if (!myCallsign) {
    showLogToast('Set your callsign in Settings to re-spot', { warn: true, duration: 3000 });
    return;
  }

  const dlg = document.getElementById('respot-dialog');
  const currentSettings = await window.api.getSettings();
  const grid = currentSettings.grid || '';

  // Populate read-only fields
  document.getElementById('respot-callsign').textContent = s.callsign;
  const qrz = qrzData.get(s.callsign.toUpperCase());
  document.getElementById('respot-name').textContent = qrz ? qrzDisplayName(qrz) : '';
  document.getElementById('respot-freq').textContent = parseFloat(s.frequency).toFixed(1) + ' kHz';

  // Reference display
  let refText = '';
  if (s.source === 'pota' && s.reference) refText = 'POTA: ' + s.reference + (s.parkName ? ' \u2014 ' + s.parkName : '');
  else if (s.source === 'wwff') refText = 'WWFF: ' + s.reference + (s.parkName ? ' \u2014 ' + s.parkName : '');
  else if (s.source === 'llota') refText = 'LLOTA: ' + s.reference + (s.parkName ? ' \u2014 ' + s.parkName : '');
  else if (s.source === 'dxc') refText = s.callsign + (s.locationDesc ? ' \u2014 ' + s.locationDesc : '');
  document.getElementById('respot-ref').textContent = refText;

  // Network indicator bar
  const bar = document.getElementById('respot-network-bar');
  const labels = targets.map(t => RESPOT_NAMES[t]);
  bar.textContent = (targets.includes('dxc') ? 'Spotting to ' : 'Re-spotting to ') + labels.join(' & ');
  bar.style.borderColor = SOURCE_COLORS[targets[0]];
  bar.style.color = SOURCE_COLORS[targets[0]];
  dlg.dataset.targets = JSON.stringify(targets);

  // Comment template — pick based on network type
  const commentField = document.getElementById('respot-comment');
  const tmpl = targets.includes('dxc') ? dxRespotTemplate : respotTemplate;
  commentField.value = tmpl
    .replace(/\{QTH\}/gi, grid)
    .replace(/\{rst\}/gi, '')
    .replace(/\{callsign\}/gi, myCallsign)
    .replace(/\{mycallsign\}/gi, myCallsign);

  dlg.showModal();
}

// Quick respot send handler
document.getElementById('respot-send').addEventListener('click', async () => {
  const s = lastTunedSpot;
  if (!s) return;

  const dlg = document.getElementById('respot-dialog');
  const targets = JSON.parse(dlg.dataset.targets || '[]');
  const commentText = document.getElementById('respot-comment').value.trim();
  const sendBtn = document.getElementById('respot-send');

  // Persist template based on network type
  if (targets.includes('dxc')) {
    dxRespotTemplate = commentText || dxRespotTemplate;
    window.api.saveSettings({ dxRespotTemplate });
  } else {
    respotTemplate = commentText || respotTemplate;
    window.api.saveSettings({ respotTemplate });
  }

  const data = {
    callsign: s.callsign,
    frequency: s.frequency,
    mode: s.mode,
    comment: commentText,
    potaRespot: targets.includes('pota'),
    potaReference: s.reference || '',
    wwffRespot: targets.includes('wwff'),
    wwffReference: s.wwffReference || (s.source === 'wwff' ? s.reference : ''),
    llotaRespot: targets.includes('llota'),
    llotaReference: s.source === 'llota' ? s.reference : '',
    dxcRespot: targets.includes('dxc'),
  };

  sendBtn.disabled = true;
  try {
    const result = await window.api.quickRespot(data);
    dlg.close();
    if (result.error) {
      showLogToast('Re-spot failed: ' + result.error, { warn: true, duration: 5000 });
    } else {
      const sources = targets.map(t => RESPOT_NAMES[t]).join(' & ');
      showLogToast('Re-spotted ' + s.callsign + ' on ' + sources);
    }
  } catch (err) {
    dlg.close();
    showLogToast('Re-spot failed: ' + err.message, { warn: true, duration: 5000 });
  } finally {
    sendBtn.disabled = false;
  }
});

document.getElementById('respot-cancel').addEventListener('click', () => {
  document.getElementById('respot-dialog').close();
});

// --- DX Command Bar ---
const dxCommandNode = document.getElementById('dx-command-node');
const dxCommandInput = document.getElementById('dx-command-input');
let showDxBar = false;
let dxCommandPreferredNode = '';
let dxSpotComment = localStorage.getItem('dx-spot-comment') || 'great signal';

function prefillDxCommand(spot) {
  if (!spot || spot.source !== 'dxc' || !showDxBar || !enableCluster) return;
  const freq = parseFloat(spot.frequency).toFixed(1);
  dxCommandInput.value = 'DX ' + freq + ' ' + spot.callsign + ' ' + dxSpotComment;
}

function updateDxCommandBar() {
  const bar = document.getElementById('dx-command-bar');
  bar.classList.toggle('hidden', !enableCluster || !showDxBar);
  updateDxCommandNodeList();
}

function updateDxCommandNodeList() {
  const prev = dxCommandNode.value || dxCommandPreferredNode;
  dxCommandNode.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'All nodes';
  dxCommandNode.appendChild(allOpt);
  for (const ns of clusterNodeStatuses) {
    const opt = document.createElement('option');
    opt.value = ns.id;
    opt.textContent = ns.name + (ns.connected ? '' : ' (offline)');
    dxCommandNode.appendChild(opt);
  }
  // Restore previous selection if still present
  if (prev && [...dxCommandNode.options].some(o => o.value === prev)) {
    dxCommandNode.value = prev;
  }
}

dxCommandNode.addEventListener('change', () => {
  dxCommandPreferredNode = dxCommandNode.value;
  localStorage.setItem('dx-command-node', dxCommandPreferredNode);
});

async function sendDxCommand() {
  const btn = document.getElementById('dx-command-send');
  const text = dxCommandInput.value.trim();
  if (!text) return;
  // Extract comment from "DX freq call comment..." and remember it
  const dxMatch = text.match(/^DX\s+[\d.]+\s+\S+\s+(.+)$/i);
  if (dxMatch) {
    dxSpotComment = dxMatch[1].trim();
    localStorage.setItem('dx-spot-comment', dxSpotComment);
  }
  const nodeId = dxCommandNode.value || undefined;
  btn.disabled = true;
  try {
    const result = await window.api.sendClusterCommand(text, nodeId);
    if (result.error) {
      showLogToast(result.error, { warn: true, duration: 5000 });
    } else {
      dxCommandInput.value = '';
      const nodeName = nodeId ? dxCommandNode.options[dxCommandNode.selectedIndex].textContent : result.sent + ' node' + (result.sent > 1 ? 's' : '');
      showLogToast('Sent to ' + nodeName);
    }
  } catch (err) {
    showLogToast('DX command failed: ' + err.message, { warn: true, duration: 5000 });
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('dx-command-send').addEventListener('click', sendDxCommand);
document.getElementById('dx-command-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendDxCommand(); }
});

// --- Quick Log (Ctrl+L) ---
let quickLogLookupTimer = null;

function openQuickLog() {
  if (!enableLogging) {
    showLogToast('Enable QSO Logging in Settings first', { warn: true, duration: 3000 });
    return;
  }
  // Build a synthetic spot from the radio's current frequency/mode
  const freqKhz = radioFreqKhz || 14074;
  const mode = radioMode || 'SSB';
  const syntheticSpot = {
    callsign: '',
    frequency: String(freqKhz),
    mode: mode,
    source: '',
    reference: '',
    parkName: '',
  };
  openLogPopup(syntheticSpot);
  // Clear callsign and name fields, make callsign editable & focused
  logCallsign.value = '';
  logCallsign.readOnly = false;
  logOpName.value = '';
  logRefDisplay.classList.add('hidden');
  logCallsign.focus();
}

// Debounced QRZ name lookup when typing callsign in Quick Log mode
logCallsign.addEventListener('input', () => {
  // Only do live lookup in Quick Log mode (no pre-existing callsign on the spot)
  if (currentLogSpot && currentLogSpot.callsign) return;
  clearTimeout(quickLogLookupTimer);
  const cs = logCallsign.value.trim().toUpperCase();
  if (cs.length < 3) { logOpName.value = ''; return; }
  quickLogLookupTimer = setTimeout(async () => {
    // Check local cache first
    const cached = qrzData.get(cs.split('/')[0]);
    if (cached) {
      logOpName.value = qrzDisplayName(cached);
      return;
    }
    // Fetch from QRZ via IPC
    const result = await window.api.qrzLookup(cs);
    if (result && logCallsign.value.trim().toUpperCase() === cs) {
      qrzData.set(cs.split('/')[0], result);
      logOpName.value = qrzDisplayName(result);
    }
  }, 500);
});

// --- QSO Log Pop-out (F2) ---
window.api.onQsoPopoutStatus((open) => {
  qsoPopoutOpen = open;
});

// --- Activation Map Pop-out ---
window.api.onActmapPopoutStatus((open) => {
  actmapPopoutOpen = open;
  if (open) {
    // Push full state when pop-out becomes ready
    window.api.actmapPopoutData({
      parkRefs: activatorParkRefs.map(p => p.ref),
      contacts: activatorContacts,
    });
  }
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
  viewRbnBtn.classList.remove('active');

  if (currentView === 'dxcc') {
    splitContainerEl.classList.add('hidden');
    dxccView.classList.remove('hidden');
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
      // Draw any pending tune arc that was stashed while map was hidden
      if (map && pendingTuneArc && mainHomePos) {
        const a = pendingTuneArc;
        showTuneArc(a.lat, a.lon, a.freq, a.source);
      }
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
dxccBoardBtn.addEventListener('click', () => {
  if (!enableDxcc) {
    enableDxcc = true;
    spotsDxcc.checked = true;
    setEnableDxcc.checked = true;
    window.api.saveSettings({ enableDxcc: true });
  }
  // Close the spots dropdown
  document.getElementById('spots-dropdown').classList.remove('open');
  setView('dxcc');
});

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
    setTimeout(() => {
      sendPopoutSpots();
      // Send current tune arc if one is active
      if (lastTunedSpot && lastTunedSpot.lat != null && lastTunedSpot.lon != null) {
        window.api.sendPopoutTuneArc({ lat: lastTunedSpot.lat, lon: lastTunedSpot.lon, freq: lastTunedSpot.frequency, source: lastTunedSpot.source });
      }
    }, 300);
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
    isWorked: workedQsos.has(s.callsign.toUpperCase()),
    isWorkedToday: workedQsos.has(s.callsign.toUpperCase()) && isWorkedSpot(s),
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

function isEntityConfirmedOnBand(ent, band, modeFilter) {
  const modes = ent.confirmed[band];
  if (!modes || modes.length === 0) return false;
  if (!modeFilter) return true;
  return modes.some((m) => modeFilter.has(m));
}

function renderDxccMatrix() {
  if (!dxccData || !dxccData.entities) {
    dxccMatrixBody.innerHTML = '';
    dxccPlaceholder.classList.remove('hidden');
    dxccCountEl.textContent = '0 / 100';
    dxccAwardLabelEl.textContent = '';
    dxccChallengeEl.classList.add('hidden');
    return;
  }

  dxccPlaceholder.classList.add('hidden');
  const modeFilter = getDxccModeFilter(); // null = all modes
  const bandFilter = dxccBandSelectEl.value; // 'all' or specific band
  const isAllBands = bandFilter === 'all';

  // Show/hide band columns in thead
  const theadThs = document.querySelectorAll('.dxcc-matrix thead th.dxcc-band-col');
  theadThs.forEach((th) => {
    if (isAllBands) {
      th.style.display = '';
    } else {
      th.style.display = 'none';
    }
  });

  let confirmedCount = 0;
  let challengeCount = 0;
  const rows = [];

  for (const ent of dxccData.entities) {
    let hasAny = false;
    const bandCells = [];

    if (isAllBands) {
      // All Bands: full matrix
      for (const band of DXCC_BANDS) {
        const confirmed = isEntityConfirmedOnBand(ent, band, modeFilter);
        if (confirmed) hasAny = true;
        bandCells.push(confirmed);
        // DXCC Challenge: count band-entities on challenge bands only
        if (confirmed && DXCC_CHALLENGE_BANDS.includes(band)) challengeCount++;
      }
    } else {
      // Specific band selected
      hasAny = isEntityConfirmedOnBand(ent, bandFilter, modeFilter);
    }

    if (hasAny) confirmedCount++;
    rows.push({ ent, bandCells, hasAny });
  }

  // Update progress counter
  dxccCountEl.textContent = `${confirmedCount} / 100`;
  dxccAwardLabelEl.textContent = confirmedCount >= 100 ? 'DXCC!' : '';

  // DXCC Challenge counter (All Bands view only)
  if (isAllBands) {
    dxccChallengeEl.textContent = `Challenge: ${challengeCount}`;
    dxccChallengeEl.classList.remove('hidden');
  } else {
    dxccChallengeEl.classList.add('hidden');
  }

  // Build table rows
  const fragment = document.createDocumentFragment();
  for (const { ent, bandCells, hasAny } of rows) {
    const tr = document.createElement('tr');
    if (!hasAny) tr.classList.add('dxcc-unworked');

    // Entity name
    const nameTd = document.createElement('td');
    if (!isAllBands && hasAny) {
      nameTd.textContent = '\u2713 ' + ent.name;
    } else {
      nameTd.textContent = ent.name;
    }
    nameTd.title = ent.prefix;
    tr.appendChild(nameTd);

    // Continent
    const contTd = document.createElement('td');
    contTd.textContent = ent.continent;
    tr.appendChild(contTd);

    // Band cells (only in All Bands view)
    if (isAllBands) {
      for (const confirmed of bandCells) {
        const td = document.createElement('td');
        if (confirmed) {
          td.textContent = '\u2713';
          td.classList.add('dxcc-confirmed');
        }
        tr.appendChild(td);
      }
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
      const isWorked = workedQsos.has(s.callsign.toUpperCase());
      const isWorkedToday = isWorked && isWorkedSpot(s);
      const isSkipped = scanSkipped.has(s.frequency) || isWorkedToday;

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

      // Already-worked check — checkmark for any prior QSO, dim only if worked today
      if (isWorked) {
        tr.classList.add('already-worked');
        if (isWorkedToday) tr.classList.add('worked-today');
      }

      // New park indicator (POTA/WWFF spot with a reference not in worked parks)
      const isNewPark = workedParksSet.size > 0 && (s.source === 'pota' || s.source === 'wwff') && s.reference && !workedParksSet.has(s.reference);
      if (isNewPark) {
        tr.classList.add('new-park');
      }

      // Highlight the row currently being scanned
      if (scanSpot && s.frequency === scanSpot.frequency) {
        tr.classList.add('scan-highlight');
      }
      // Highlight row matching radio's current frequency or last tuned spot
      if (radioFreqKhz !== null && Math.abs(parseFloat(s.frequency) - radioFreqKhz) < 0.5) {
        tr.classList.add('on-freq');
      } else if (lastTunedSpot && s.callsign === lastTunedSpot.callsign && s.frequency === lastTunedSpot.frequency) {
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
        lastTunedSpot = s;
        prefillDxCommand(s);
        window.api.tune(s.frequency, s.mode, s.bearing);
        if (s.lat != null && s.lon != null) showTuneArc(s.lat, s.lon, s.frequency, s.source);
        render(); // highlight the clicked row immediately
      });

      // Build all cells into a map keyed by data-col, then append in colOrder
      const cellMap = new Map();

      // Log button cell
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
      cellMap.set('log', logTd);

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
      // Event badge (e.g. "250" for America 250 WAS)
      const matchedEvent = getEventForCallsign(s.callsign);
      if (matchedEvent) {
        const evBadge = document.createElement('span');
        evBadge.className = 'event-badge';
        evBadge.style.background = matchedEvent.badgeColor || '#ff6b00';
        evBadge.title = matchedEvent.name || 'Event';
        evBadge.textContent = matchedEvent.badge || 'EVT';
        callTd.appendChild(evBadge);
      }
      cellMap.set('callsign', callTd);

      // Operator name cell (from QRZ lookup)
      const operatorTd = document.createElement('td');
      operatorTd.setAttribute('data-col', 'operator');
      operatorTd.className = 'operator-col';
      const qrzInfo = qrzData.get(s.callsign.toUpperCase().split('/')[0]);
      if (qrzInfo) {
        operatorTd.textContent = qrzDisplayName(qrzInfo);
        operatorTd.title = [qrzInfo.nickname || qrzInfo.fname, qrzInfo.name].filter(Boolean).join(' ');
      }
      cellMap.set('operator', operatorTd);

      // Frequency cell — styled as clickable link
      const freqTd = document.createElement('td');
      freqTd.setAttribute('data-col', 'frequency');
      const freqLink = document.createElement('span');
      freqLink.textContent = parseFloat(s.frequency).toFixed(1);
      freqLink.className = 'freq-link';
      freqTd.appendChild(freqLink);
      cellMap.set('frequency', freqTd);

      // Build reference display — dual-park shows both refs
      const refDisplay = s.wwffReference ? s.reference + ' / ' + s.wwffReference : s.reference;
      const parkDisplay = s.wwffReference ? s.parkName : s.parkName;

      // Source badge cell
      const sourceTd = document.createElement('td');
      sourceTd.setAttribute('data-col', 'source');
      const sourceBadge = document.createElement('span');
      sourceBadge.className = 'source-badge source-badge-' + (s.source || 'pota');
      sourceBadge.textContent = SOURCE_LABELS[s.source] || s.source || '';
      sourceTd.appendChild(sourceBadge);
      cellMap.set('source', sourceTd);

      const cells = [
        { val: s.mode, col: 'mode' },
        { val: refDisplay, wwff: !!s.wwffReference, newPark: isNewPark, col: 'reference' },
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
        if (cell.newPark) {
          const nb = document.createElement('span');
          nb.textContent = 'NEW';
          nb.style.cssText = 'background:#4ecca3;color:#000;font-size:9px;font-weight:bold;padding:1px 3px;border-radius:3px;margin-left:4px;';
          td.appendChild(nb);
        }
        if (cell.wwff) {
          const badge = document.createElement('span');
          badge.textContent = 'WWFF';
          badge.style.cssText = 'background:#26a69a;color:#000;font-size:9px;font-weight:bold;padding:1px 3px;border-radius:3px;margin-left:4px;';
          td.appendChild(badge);
        }
        cellMap.set(cell.col, td);
      }

      // Skip button cell
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
      cellMap.set('skip', skipTd);

      // Append cells in user-configured column order
      for (const col of colOrder) {
        const td = cellMap.get(col);
        if (td) tr.appendChild(td);
      }

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

  // Pre-fill power: use CAT reading if available, otherwise settings default
  logPower.value = radioPower > 0 ? radioPower : (defaultPower || 100);

  // Pre-fill RST based on mode
  const defaultRst = CW_DIGI_MODES_SET.has(mode) ? '599' : '59';
  setRstDigits('rst-sent-digits', defaultRst);
  setRstDigits('rst-rcvd-digits', defaultRst);
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

  // Re-spot section: single checkbox, auto-determined by spot source
  const respotSection = document.getElementById('log-respot-section');
  const respotCheckbox = document.getElementById('log-respot');
  const respotLabel = document.getElementById('log-respot-label');
  const respotComment = document.getElementById('log-respot-comment');
  const respotCommentLabel = document.getElementById('log-respot-comment-label');
  const targets = myCallsign ? getRespotTargets(spot) : [];
  if (targets.length) {
    respotSection.classList.remove('hidden');
    respotSection.dataset.targets = JSON.stringify(targets);
    const labelNames = targets.map(t => RESPOT_NAMES[t]).join(' & ');
    const verb = targets.includes('dxc') ? 'Spot on ' : 'Re-spot on ';
    // Update checkbox label text — find the text node after the <input>
    const inputEl = respotLabel.querySelector('input');
    let labelTextNode = inputEl.nextSibling;
    if (!labelTextNode || labelTextNode.nodeType !== 3) {
      labelTextNode = document.createTextNode('');
      respotLabel.appendChild(labelTextNode);
    }
    labelTextNode.textContent = ' ' + verb + labelNames;
    respotLabel.style.color = SOURCE_COLORS[targets[0]];
    respotCheckbox.checked = respotDefault;
    respotComment.value = targets.includes('dxc') ? dxRespotTemplate : respotTemplate;
    respotCommentLabel.style.display = respotCheckbox.checked ? '' : 'none';
    respotCheckbox.onchange = () => { respotCommentLabel.style.display = respotCheckbox.checked ? '' : 'none'; };
  } else {
    respotSection.classList.add('hidden');
    respotSection.dataset.targets = '[]';
    respotCheckbox.checked = false;
  }

  logDialog.showModal();
  // Start live UTC clock — ticks every second until dialog closes or user edits time
  logTimeUserEdited = false;
  startLogClock();
}

// --- Live UTC clock in log dialog ---
let logClockTimer = null;
let logTimeUserEdited = false;

function startLogClock() {
  stopLogClock();
  logClockTimer = setInterval(() => {
    if (logTimeUserEdited) return; // user touched the field, stop updating
    const now = new Date();
    logTime.value = now.toISOString().slice(11, 16);
    logDate.value = now.toISOString().slice(0, 10);
  }, 1000);
}

function stopLogClock() {
  if (logClockTimer) { clearInterval(logClockTimer); logClockTimer = null; }
}

logTime.addEventListener('input', () => { logTimeUserEdited = true; });

logDialog.addEventListener('close', () => { stopLogClock(); });

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
    setRstDigits(btn.dataset.target, btn.dataset.value);
  });
});

// RST digit auto-advance and backspace navigation
document.querySelectorAll('.rst-digits').forEach((container) => {
  const inputs = container.querySelectorAll('.rst-digit');
  inputs.forEach((inp, i) => {
    // Select content on focus so typing immediately overwrites
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('input', () => {
      // Keep only the last typed digit (handles overwrite)
      if (inp.value.length > 1) inp.value = inp.value.slice(-1);
      // Auto-advance to next digit
      if (inp.value && i < inputs.length - 1) inputs[i + 1].focus();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && i > 0) {
        inputs[i - 1].focus();
      }
    });
  });
});

// Mode change updates RST defaults
logMode.addEventListener('change', () => {
  const mode = logMode.value.toUpperCase();
  const defaultRst = CW_DIGI_MODES_SET.has(mode) ? '599' : '59';
  setRstDigits('rst-sent-digits', defaultRst);
  setRstDigits('rst-rcvd-digits', defaultRst);
  updateRstButtons();
});

// Log dialog close/cancel
logCancelBtn.addEventListener('click', () => logDialog.close());
logDialogClose.addEventListener('click', () => logDialog.close());

// Enter key saves QSO from anywhere in the log dialog
logDialog.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !logSaveBtn.disabled) {
    e.preventDefault();
    logSaveBtn.click();
  }
});

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

  // Determine SIG/SIG_INFO and program-specific ref fields from spot
  let sig = '';
  let sigInfo = '';
  let potaRef = '';
  let sotaRef = '';
  let wwffRef = '';
  if (currentLogSpot && currentLogSpot.reference) {
    if (currentLogSpot.source === 'pota') { sig = 'POTA'; potaRef = currentLogSpot.reference; }
    else if (currentLogSpot.source === 'sota') { sig = 'SOTA'; sotaRef = currentLogSpot.reference; }
    else if (currentLogSpot.source === 'wwff') { sig = 'WWFF'; wwffRef = currentLogSpot.reference; }
    else if (currentLogSpot.source === 'llota') sig = 'LLOTA';
    sigInfo = currentLogSpot.reference;
  }
  // Dual-park: POTA spot that's also a WWFF park
  if (currentLogSpot && currentLogSpot.wwffReference) {
    wwffRef = currentLogSpot.wwffReference;
  }

  // Re-spot state from stored targets
  const respotCheckbox = document.getElementById('log-respot');
  const respotComment = document.getElementById('log-respot-comment');
  const respotSection = document.getElementById('log-respot-section');
  const logTargets = JSON.parse(respotSection.dataset.targets || '[]');
  const wantsRespot = respotCheckbox.checked && logTargets.includes('pota');
  const wantsWwffRespot = respotCheckbox.checked && logTargets.includes('wwff');
  const wantsLlotaRespot = respotCheckbox.checked && logTargets.includes('llota');
  const wantsDxcRespot = respotCheckbox.checked && logTargets.includes('dxc');

  // Persist re-spot preference and template
  if (!respotSection.classList.contains('hidden')) {
    respotDefault = respotCheckbox.checked;
    const tmplText = respotComment.value.trim();
    if (logTargets.includes('dxc')) {
      dxRespotTemplate = tmplText || dxRespotTemplate;
      window.api.saveSettings({ respotDefault: respotCheckbox.checked, dxRespotTemplate });
    } else {
      respotTemplate = tmplText || respotTemplate;
      window.api.saveSettings({ respotDefault: respotCheckbox.checked, respotTemplate });
    }
  }

  // Determine WWFF reference for respot
  const respotWwffRef = currentLogSpot ? (currentLogSpot.wwffReference || (currentLogSpot.source === 'wwff' ? currentLogSpot.reference : '')) : '';
  const commentText = respotComment.value.trim().replace(/\{rst\}/gi, getRstDigits('rst-sent-digits', '59')).replace(/\{QTH\}/gi, grid).replace(/\{mycallsign\}/gi, myCallsign);

  // Pull QRZ data for ADIF fields (name, state, county, grid)
  const logQrzInfo = qrzData.get(callsign.split('/')[0]);

  const qsoData = {
    callsign,
    frequency,
    mode,
    qsoDate,
    timeOn,
    rstSent: getRstDigits('rst-sent-digits', '59'),
    rstRcvd: getRstDigits('rst-rcvd-digits', '59'),
    txPower: logPower.value.trim(),
    band,
    sig,
    sigInfo,
    potaRef,
    sotaRef,
    wwffRef,
    name: logQrzInfo ? [cleanQrzName(logQrzInfo.nickname) || cleanQrzName(logQrzInfo.fname), cleanQrzName(logQrzInfo.name)].filter(Boolean).join(' ') : '',
    state: logQrzInfo ? logQrzInfo.state : '',
    county: logQrzInfo && logQrzInfo.state && logQrzInfo.county ? `${logQrzInfo.state},${logQrzInfo.county}` : '',
    gridsquare: logQrzInfo ? logQrzInfo.grid : '',
    country: logQrzInfo ? logQrzInfo.country : '',
    comment: [logComment.value.trim(), sigInfo && !logComment.value.includes(sigInfo) ? `[${sig} ${sigInfo}]` : ''].filter(Boolean).join(' '),
    respot: wantsRespot,
    wwffRespot: wantsWwffRespot,
    wwffReference: wantsWwffRespot ? respotWwffRef : '',
    llotaRespot: wantsLlotaRespot,
    llotaReference: wantsLlotaRespot && currentLogSpot && currentLogSpot.source === 'llota' ? currentLogSpot.reference : '',
    dxcRespot: wantsDxcRespot,
    respotComment: (wantsRespot || wantsWwffRespot || wantsLlotaRespot || wantsDxcRespot) ? commentText : '',
  };

  logSaveBtn.disabled = true;
  const origText = logSaveBtn.textContent;
  logSaveBtn.textContent = 'Saving\u2026';
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
      } else if (result.dxcRespotError) {
        showLogToast(`Logged ${callsign} to ADIF, but DX Cluster spot failed: ${result.dxcRespotError}`, { warn: true, duration: 8000 });
      } else if (result.resposted) {
        const sources = logTargets.filter(t => respotCheckbox.checked).map(t => RESPOT_NAMES[t]).join(' & ');
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
    logSaveBtn.textContent = origText;
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
  spotsDxcc.checked = enableDxcc;
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
  enableDxcc = spotsDxcc.checked;

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
  setEnableDxcc.checked = enableDxcc;

  updateRbnButton();
  updateDxccButton();
  updateDxCommandBar();

  // Save and let main process handle connect/disconnect
  await window.api.saveSettings({
    enablePota, enableSota, enableWwff, enableLlota,
    enableCluster, enableRbn, enablePskr,
    hideWorked, hideWorkedParks, hideOutOfBand,
    enableDxcc,
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

// Logbook button
logbookBtn.addEventListener('click', () => window.api.qsoPopoutOpen());

// Settings dialog
settingsBtn.addEventListener('click', async () => {
  const s = await window.api.getSettings();
  setGrid.value = s.grid || '';
  setDistUnit.value = s.distUnit || 'mi';
  setMaxAge.value = s.maxAgeMin || 5;
  setRefreshInterval.value = s.refreshInterval || 30;
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
  setShowBeacons.checked = s.showBeacons === true;
  setShowDxBar.checked = s.showDxBar === true;
  showDxBar = s.showDxBar === true;
  updateDxCommandBar();
  setEnableRbn.checked = s.enableRbn === true;
  setMyCallsign.value = s.myCallsign || '';
  // Load cluster nodes (migrate legacy if needed)
  if (s.clusterNodes && s.clusterNodes.length > 0) {
    currentClusterNodes = JSON.parse(JSON.stringify(s.clusterNodes));
  } else {
    // Legacy migration: convert single host/port to node list
    const host = s.clusterHost || 'w3lpl.net';
    const port = s.clusterPort || 7373;
    const preset = CLUSTER_PRESETS.find(p => p.host === host && p.port === port);
    currentClusterNodes = [{ id: Date.now().toString(36), name: preset ? preset.name : host, host, port, enabled: true, preset: preset ? preset.name : null }];
  }
  renderClusterNodeList(currentClusterNodes);
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
  setColorRows.checked = s.colorRows !== false; // default true
  setEnableSolar.checked = s.enableSolar === true;
  setEnableBandActivity.checked = s.enableBandActivity === true;
  setShowBearing.checked = s.showBearing === true;
  setEnableSplitView.checked = s.enableSplitView !== false;
  splitOrientationConfig.classList.toggle('hidden', !setEnableSplitView.checked);
  document.getElementById('set-split-orientation').value = s.splitOrientation || 'horizontal';
  setEnableDxcc.checked = s.enableDxcc === true;
  setPotaParksPath.value = s.potaParksPath || '';
  potaParksClearBtn.style.display = s.potaParksPath ? '' : 'none';
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
  setTciSpots.checked = s.tciSpots === true;
  setTciHost.value = s.tciHost || '127.0.0.1';
  setTciPort.value = s.tciPort || 50001;
  setTciPota.checked = s.tciPota !== false;
  setTciSota.checked = s.tciSota !== false;
  setTciCluster.checked = s.tciCluster !== false;
  setTciRbn.checked = s.tciRbn === true;
  setTciWwff.checked = s.tciWwff !== false;
  setTciLlota.checked = s.tciLlota !== false;
  setTciPskr.checked = s.tciPskr !== false;
  setTciMaxAge.value = s.tciMaxAge != null ? s.tciMaxAge : 15;
  tciConfig.classList.toggle('hidden', !s.tciSpots);
  // CW Keyer
  setEnableCwKeyer.checked = s.enableCwKeyer === true;
  setCwKeyerMode.value = s.cwKeyerMode || 'iambicB';
  setCwWpm.value = s.cwWpm || 20;
  setCwSwapPaddles.checked = s.cwSwapPaddles === true;
  setCwMidiDitNote.value = s.cwMidiDitNote != null ? s.cwMidiDitNote : 20;
  setCwMidiDahNote.value = s.cwMidiDahNote != null ? s.cwMidiDahNote : 21;
  setCwSidetone.checked = s.cwSidetone === true;
  setCwSidetonePitch.value = s.cwSidetonePitch || 600;
  setCwSidetoneVolume.value = s.cwSidetoneVolume != null ? s.cwSidetoneVolume : 30;
  cwSidetoneVolumeLabel.textContent = setCwSidetoneVolume.value + '%';
  cwKeyerConfig.classList.toggle('hidden', !s.enableCwKeyer);
  if (s.enableCwKeyer) {
    populateMidiDevices().then(() => {
      if (s.cwMidiDevice) setCwMidiDevice.value = s.cwMidiDevice;
      connectMidiDevice(setCwMidiDevice.value);
    });
  }
  setDisableAutoUpdate.checked = s.disableAutoUpdate === true;
  setEnableTelemetry.checked = s.enableTelemetry === true;
  setLightMode.checked = s.lightMode === true;
  hamlibTestResult.textContent = '';
  hamlibTestResult.className = '';
  renderRigList(s.rigs || [], s.activeRigId || null);
  closeRigEditor();
  // Update connection status pills
  updateSettingsConnBar();
  // Populate events list
  populateSettingsEvents();
  // App mode radio
  const modeRadio = document.querySelector(`input[name="set-app-mode"][value="${appMode}"]`);
  if (modeRadio) modeRadio.checked = true;
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
  const refreshIntervalVal = Math.max(15, parseInt(setRefreshInterval.value, 10) || 30);
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
  const clusterNodes = currentClusterNodes;
  const showBeaconsEnabled = setShowBeacons.checked;
  const showDxBarEnabled = setShowDxBar.checked;
  showDxBar = showDxBarEnabled;
  updateDxCommandBar();
  const wsjtxEnabled = setEnableWsjtx.checked;
  const wsjtxPortVal = parseInt(setWsjtxPort.value, 10) || 2237;
  const wsjtxHighlightEnabled = setWsjtxHighlight.checked;
  const wsjtxAutoLogEnabled = setWsjtxAutoLog.checked;
  const colorRowsEnabled = setColorRows.checked;
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
  const tciSpotsEnabled = setTciSpots.checked;
  const tciHostVal = setTciHost.value.trim() || '127.0.0.1';
  const tciPortVal = parseInt(setTciPort.value, 10) || 50001;
  const tciPotaEnabled = setTciPota.checked;
  const tciSotaEnabled = setTciSota.checked;
  const tciClusterEnabled = setTciCluster.checked;
  const tciRbnEnabled = setTciRbn.checked;
  const tciWwffEnabled = setTciWwff.checked;
  const tciLlotaEnabled = setTciLlota.checked;
  const tciPskrEnabled = setTciPskr.checked;
  const tciMaxAgeVal = parseInt(setTciMaxAge.value, 10) || 0;
  // CW Keyer
  const cwKeyerEnabled = setEnableCwKeyer.checked;
  const cwKeyerModeVal = setCwKeyerMode.value;
  const cwWpmVal = parseInt(setCwWpm.value, 10) || 20;
  const cwSwapPaddlesVal = setCwSwapPaddles.checked;
  const cwMidiDeviceVal = setCwMidiDevice.value;
  const cwMidiDitNoteVal = parseInt(setCwMidiDitNote.value, 10);
  const cwMidiDahNoteVal = parseInt(setCwMidiDahNote.value, 10);
  const cwSidetoneVal = setCwSidetone.checked;
  const cwSidetonePitchVal = parseInt(setCwSidetonePitch.value, 10) || 600;
  const cwSidetoneVolumeVal = parseInt(setCwSidetoneVolume.value, 10);
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
    refreshInterval: refreshIntervalVal,
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
    clusterNodes: clusterNodes,
    showBeacons: showBeaconsEnabled,
    showDxBar: showDxBarEnabled,
    colorRows: colorRowsEnabled,
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
    tciSpots: tciSpotsEnabled,
    tciHost: tciHostVal,
    tciPort: tciPortVal,
    tciPota: tciPotaEnabled,
    tciSota: tciSotaEnabled,
    tciCluster: tciClusterEnabled,
    tciRbn: tciRbnEnabled,
    tciWwff: tciWwffEnabled,
    tciLlota: tciLlotaEnabled,
    tciPskr: tciPskrEnabled,
    tciMaxAge: tciMaxAgeVal,
    enableCwKeyer: cwKeyerEnabled,
    cwKeyerMode: cwKeyerModeVal,
    cwWpm: cwWpmVal,
    cwSwapPaddles: cwSwapPaddlesVal,
    cwMidiDevice: cwMidiDeviceVal,
    cwMidiDitNote: cwMidiDitNoteVal,
    cwMidiDahNote: cwMidiDahNoteVal,
    cwSidetone: cwSidetoneVal,
    cwSidetonePitch: cwSidetonePitchVal,
    cwSidetoneVolume: cwSidetoneVolumeVal,
    appMode: document.querySelector('input[name="set-app-mode"]:checked')?.value || 'hunter',
  });
  grid = setGrid.value.trim();
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
  spotsTable.classList.toggle('no-source-tint', !colorRowsEnabled);
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
  if (qsoPopoutOpen) window.api.sendQsoPopoutTheme(lightModeEnabled ? 'light' : 'dark');
  if (actmapPopoutOpen) window.api.actmapPopoutTheme(lightModeEnabled ? 'light' : 'dark');
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
  // App mode switch
  const newAppMode = document.querySelector('input[name="set-app-mode"]:checked')?.value || 'hunter';
  if (newAppMode !== appMode) {
    setAppMode(newAppMode);
  }
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
let catDisconnectTimer = null; // grace period before showing red pill

window.api.onCatStatus(({ connected, error, wsjtxMode }) => {
  catConnected = connected;
  if (wsjtxMode) {
    if (catDisconnectTimer) { clearTimeout(catDisconnectTimer); catDisconnectTimer = null; }
    catStatusEl.textContent = 'CAT';
    catStatusEl.className = 'status connected';
    catStatusEl.title = 'Radio controlled by WSJT-X';
    return;
  }
  if (connected) {
    // Reconnected — cancel any pending disconnect display
    if (catDisconnectTimer) { clearTimeout(catDisconnectTimer); catDisconnectTimer = null; }
    catStatusEl.textContent = 'CAT';
    catStatusEl.className = 'status connected';
    catStatusEl.title = activeRigName ? `Connected to ${activeRigName}` : 'Connected';
  } else {
    // Grace period: delay showing red so transient reconnects don't flash
    if (!catDisconnectTimer) {
      catDisconnectTimer = setTimeout(() => {
        catDisconnectTimer = null;
        catStatusEl.textContent = 'CAT';
        catStatusEl.className = 'status disconnected';
        catStatusEl.title = error || 'Disconnected';
        if (error) {
          showLogToast(`CAT: ${error}`, { warn: true, sticky: true });
        }
      }, 3000);
    }
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

window.api.onUpdateUpToDate(() => {
  showLogToast('You\'re up to date!', { duration: 3000 });
});

window.api.onDownloadProgress(({ percent }) => {
  const actionBtn = document.getElementById('update-action-btn');
  actionBtn.textContent = `Downloading... ${percent}%`;
});

window.api.onUpdateError((msg) => {
  const actionBtn = document.getElementById('update-action-btn');
  actionBtn.textContent = 'Upgrade';
  actionBtn.disabled = false;
  console.error('Update error:', msg);
});

window.api.onUpdateDownloaded(() => {
  const actionBtn = document.getElementById('update-action-btn');
  actionBtn.textContent = 'Restart to Upgrade';
  actionBtn.disabled = false;
  actionBtn.onclick = () => {
    window.api.installUpdate();
  };
});

// --- Worked QSOs listener ---
window.api.onWorkedQsos((entries) => {
  workedQsos = new Map(entries);
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

// --- Active Events system ---
const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

function matchesEventPattern(callsign, patterns) {
  const call = callsign.toUpperCase();
  return (patterns || []).some(pattern => {
    if (pattern.endsWith('/*')) {
      return call.startsWith(pattern.slice(0, -1).toUpperCase());
    }
    return call === pattern.toUpperCase();
  });
}

function getActiveScheduleEntry(event) {
  const now = new Date();
  return (event.schedule || []).find(s => {
    return now >= new Date(s.start) && now < new Date(s.end);
  });
}

function getEventForCallsign(callsign) {
  for (const ev of activeEvents) {
    if (matchesEventPattern(callsign, ev.callsignPatterns)) {
      return ev;
    }
  }
  return null;
}

function updateEventBanner() {
  const banner = document.getElementById('event-banner');
  const message = document.getElementById('event-message');
  const progressCount = document.getElementById('event-progress-count');
  const optinBtn = document.getElementById('event-optin-btn');
  const progressBtn = document.getElementById('event-progress-btn');
  const badge = document.getElementById('event-badge');

  // Find first event with an active or upcoming schedule entry
  let activeEvent = null;
  let activeEntry = null;
  let isUpcoming = false;
  const now = new Date();
  for (const ev of activeEvents) {
    // Check for currently active entry first
    const current = getActiveScheduleEntry(ev);
    if (current) {
      activeEvent = ev;
      activeEntry = current;
      break;
    }
    // Fall back to next upcoming entry (within 7 days)
    if (!activeEvent) {
      const upcoming = (ev.schedule || []).find(s => {
        const start = new Date(s.start);
        return start > now && (start - now) < 7 * 24 * 3600000;
      });
      if (upcoming) {
        activeEvent = ev;
        activeEntry = upcoming;
        isUpcoming = true;
      }
    }
  }

  if (!activeEvent || !activeEntry) {
    banner.classList.add('hidden');
    return;
  }

  // If dismissed and not opted in, stay hidden
  if (activeEvent.dismissed && !activeEvent.optedIn) {
    banner.classList.add('hidden');
    return;
  }

  badge.textContent = activeEvent.badge || '250';
  badge.style.background = activeEvent.badgeColor || '#ff6b00';

  const endDate = new Date(activeEntry.end);
  const endStr = endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const startDate = new Date(activeEntry.start);
  const startStr = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const callPattern = (activeEvent.callsignPatterns || [])[0] || '';
  let callText = '';
  if (callPattern) {
    // For W1AW/* pattern, resolve to W1AW/<district> using the active region's call district
    if (callPattern === 'W1AW/*' && activeEntry.region) {
      const stateToDistrict = {
        CT: 1, ME: 1, MA: 1, NH: 1, RI: 1, VT: 1,
        NJ: 2, NY: 2,
        DE: 3, DC: 3, MD: 3, PA: 3,
        AL: 4, FL: 4, GA: 4, KY: 4, NC: 4, SC: 4, TN: 4, VA: 4,
        AR: 5, LA: 5, MS: 5, NM: 5, OK: 5, TX: 5,
        CA: 6, HI: 6,
        AZ: 7, ID: 7, MT: 7, NV: 7, OR: 7, UT: 7, WA: 7, WY: 7,
        CO: 8, IA: 8, KS: 8, MN: 8, MO: 8, NE: 8, ND: 8, SD: 8,
        IL: 9, IN: 9, WI: 9,
        MI: 0, OH: 0, WV: 0,
        AK: 'KL7', GU: 'KH2', PR: 'KP4', VI: 'KP2',
      };
      const d = stateToDistrict[activeEntry.region];
      callText = d !== undefined ? ` \u2014 W1AW/${d}` : ` \u2014 W1AW/*`;
    } else {
      callText = ` \u2014 ${callPattern.replace('/*', '/')}*`;
    }
  }
  const trackingLabel = (activeEvent.tracking && activeEvent.tracking.label) || 'items';
  const board = activeEvent.board || (activeEvent.tracking && activeEvent.tracking.type) || 'regions';
  const isRegions = board === 'regions';

  if (activeEvent.optedIn) {
    const worked = Object.keys(activeEvent.progress || {}).length;
    const total = activeEvent.tracking ? activeEvent.tracking.total : 0;
    if (isUpcoming) {
      if (isRegions) {
        message.textContent = `${activeEntry.regionName} week starts ${startStr}${callText}`;
      } else {
        message.textContent = `${activeEvent.name} starts ${startStr}`;
      }
    } else {
      if (isRegions) {
        message.textContent = `${activeEntry.regionName} week${callText} through ${endStr}`;
      } else {
        message.textContent = `${activeEvent.name} active through ${endStr}`;
      }
    }
    if (total > 0) {
      progressCount.textContent = `${worked}/${total} ${trackingLabel}`;
    } else {
      progressCount.textContent = `${worked} ${trackingLabel}`;
    }
    optinBtn.classList.add('hidden');
    progressBtn.classList.remove('hidden');
  } else {
    if (isUpcoming) {
      if (isRegions) {
        message.textContent = `${activeEvent.name} \u2014 ${activeEntry.regionName}${callText} starts ${startStr}`;
      } else {
        message.textContent = `${activeEvent.name} starts ${startStr}`;
      }
    } else {
      if (isRegions) {
        message.textContent = `${activeEvent.name} \u2014 ${activeEntry.regionName}${callText} active through ${endStr}`;
      } else {
        message.textContent = `${activeEvent.name} active through ${endStr}`;
      }
    }
    progressCount.textContent = '';
    optinBtn.classList.remove('hidden');
    progressBtn.classList.add('hidden');
  }

  banner.classList.remove('hidden');
}

let currentBoardEventId = null;

function renderEventBoard(event) {
  const board = event.board || (event.tracking && event.tracking.type) || 'regions';
  if (board === 'regions') renderRegionsBoard(event);
  else if (board === 'checklist') renderChecklistBoard(event);
  else if (board === 'counter') renderCounterBoard(event);
}

function renderRegionsBoard(event) {
  const content = document.getElementById('event-board-content');
  const countEl = document.getElementById('event-overlay-count');
  const titleEl = document.getElementById('event-overlay-title');
  const labelEl = document.getElementById('event-overlay-label');
  if (!content || !event) return;

  titleEl.textContent = event.name || 'Event Progress';
  labelEl.textContent = (event.tracking && event.tracking.label) ? `${event.tracking.label} Worked` : 'States Worked';
  const progress = event.progress || {};
  const now = new Date();
  const activeRegions = new Set();
  for (const s of (event.schedule || [])) {
    if (now >= new Date(s.start) && now < new Date(s.end)) {
      activeRegions.add(s.region);
    }
  }

  const worked = Object.keys(progress).length;
  const total = event.tracking ? event.tracking.total : US_STATES.length;
  countEl.textContent = `${worked} / ${total}`;

  const scheduleByRegion = {};
  for (const s of (event.schedule || [])) {
    if (!scheduleByRegion[s.region]) scheduleByRegion[s.region] = [];
    scheduleByRegion[s.region].push(s);
  }

  content.innerHTML = '';
  const grid = document.createElement('div');
  grid.id = 'event-state-grid';
  for (const st of US_STATES) {
    const cell = document.createElement('div');
    cell.className = 'event-state-cell';
    cell.textContent = st;

    const entries = scheduleByRegion[st] || [];
    const tipParts = [];
    if (entries.length) {
      const dateFmt = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      for (const entry of entries) {
        tipParts.push(`${entry.regionName}: ${dateFmt(entry.start)} – ${dateFmt(entry.end)}`);
      }
    } else {
      tipParts.push(`${st}: Schedule TBD`);
    }

    if (progress[st]) {
      cell.classList.add('worked');
      const p = progress[st];
      tipParts.push(`Worked: ${p.call} on ${p.band} ${p.mode} (${p.date})`);
    }
    if (activeRegions.has(st)) {
      cell.classList.add('active-week');
      if (!progress[st]) tipParts.push('Active this week!');
    }
    cell.title = tipParts.join('\n');
    grid.appendChild(cell);
  }
  content.appendChild(grid);
}

function renderChecklistBoard(event) {
  const content = document.getElementById('event-board-content');
  const countEl = document.getElementById('event-overlay-count');
  const titleEl = document.getElementById('event-overlay-title');
  const labelEl = document.getElementById('event-overlay-label');
  if (!content || !event) return;

  titleEl.textContent = event.name || 'Event Progress';
  const trackingLabel = (event.tracking && event.tracking.label) || 'Items';
  labelEl.textContent = `${trackingLabel} Worked`;
  const progress = event.progress || {};
  const items = (event.tracking && event.tracking.items) || [];
  const worked = items.filter(it => progress[it.id]).length;
  const total = event.tracking ? event.tracking.total : items.length;
  countEl.textContent = `${worked} / ${total}`;

  content.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'event-checklist-item' + (progress[item.id] ? ' worked' : '');
    const marker = document.createElement('span');
    marker.textContent = progress[item.id] ? '\u2713' : '\u25CB';
    marker.style.cssText = 'font-size:14px;width:16px;text-align:center;flex-shrink:0;';
    const callEl = document.createElement('span');
    callEl.style.cssText = 'font-weight:600;min-width:60px;';
    callEl.textContent = item.id;
    const nameEl = document.createElement('span');
    nameEl.style.color = 'var(--text-secondary)';
    nameEl.textContent = item.name;
    row.append(marker, callEl, nameEl);

    if (progress[item.id]) {
      const p = progress[item.id];
      const info = document.createElement('span');
      info.style.cssText = 'margin-left:auto;font-size:10px;color:var(--text-tertiary);';
      info.textContent = [p.band, p.mode, p.date].filter(Boolean).join(' ');
      row.appendChild(info);
    }

    content.appendChild(row);
  }
}

function renderCounterBoard(event) {
  const content = document.getElementById('event-board-content');
  const countEl = document.getElementById('event-overlay-count');
  const titleEl = document.getElementById('event-overlay-title');
  const labelEl = document.getElementById('event-overlay-label');
  if (!content || !event) return;

  titleEl.textContent = event.name || 'Event Progress';
  const trackingLabel = (event.tracking && event.tracking.label) || 'QSOs';
  labelEl.textContent = trackingLabel;
  const progress = event.progress || {};
  const qsos = Object.values(progress).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const count = qsos.length;
  countEl.textContent = `${count}`;

  content.innerHTML = '';
  const counter = document.createElement('div');
  counter.className = 'event-counter-value';
  counter.textContent = count;
  content.appendChild(counter);

  if (qsos.length) {
    const list = document.createElement('div');
    list.style.cssText = 'max-height:200px;overflow-y:auto;padding:0 8px 8px;';
    for (const qso of qsos.slice(0, 50)) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;font-size:11px;padding:2px 4px;color:var(--text-secondary);';
      row.innerHTML = `<span style="font-weight:600;min-width:70px;">${qso.call || ''}</span>` +
        `<span>${qso.band || ''}</span>` +
        `<span>${qso.mode || ''}</span>` +
        `<span style="margin-left:auto;color:var(--text-tertiary);">${qso.date || ''}</span>`;
      list.appendChild(row);
    }
    content.appendChild(list);
  } else {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;padding:8px;font-size:11px;color:var(--text-tertiary);';
    empty.textContent = 'No QSOs logged yet';
    content.appendChild(empty);
  }
}

function openEventBoard(eventId) {
  const ev = activeEvents.find(e => e.id === eventId);
  if (!ev) return;
  currentBoardEventId = eventId;
  renderEventBoard(ev);
  document.getElementById('event-progress-overlay').classList.remove('hidden');
  eventOverlayOpen = true;
}

function toggleEventOverlay(forceOpen) {
  const overlay = document.getElementById('event-progress-overlay');
  eventOverlayOpen = forceOpen !== undefined ? forceOpen : !eventOverlayOpen;
  if (eventOverlayOpen) {
    // Open the board for currentBoardEventId, or first opted-in event
    const ev = (currentBoardEventId && activeEvents.find(e => e.id === currentBoardEventId))
      || activeEvents.find(e => e.optedIn);
    if (ev) {
      currentBoardEventId = ev.id;
      renderEventBoard(ev);
      overlay.classList.remove('hidden');
    }
  } else {
    overlay.classList.add('hidden');
  }
}

function updateSpotsEventsSection() {
  const container = document.getElementById('spots-events-container');
  container.innerHTML = '';

  // Filter to events that are active or upcoming within 7 days
  const now = new Date();
  const relevantEvents = activeEvents.filter(ev => {
    if (getActiveScheduleEntry(ev)) return true;
    return (ev.schedule || []).some(s => {
      const start = new Date(s.start);
      return start > now && (start - now) < 7 * 86400000;
    });
  });

  for (const ev of relevantEvents) {
    const row = document.createElement('div');
    row.className = 'spots-toggle';
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!ev.optedIn;
    cb.addEventListener('change', async () => {
      await window.api.setEventOptIn({ eventId: ev.id, optedIn: cb.checked, dismissed: false });
    });
    const span = document.createElement('span');
    span.style.color = ev.badgeColor || '#cf6a00';
    span.textContent = ev.name;
    lbl.append(cb, span);

    const boardBtn = document.createElement('button');
    boardBtn.type = 'button';
    boardBtn.className = 'event-overlay-btn';
    boardBtn.style.cssText = 'font-size:10px;padding:1px 6px;';
    boardBtn.textContent = 'Board';
    boardBtn.addEventListener('click', () => openEventBoard(ev.id));

    row.append(lbl, boardBtn);
    container.appendChild(row);
  }
}

// Event banner button handlers
function findBannerEvent() {
  // Same logic as updateEventBanner — find active or upcoming event
  const now = new Date();
  for (const ev of activeEvents) {
    if (getActiveScheduleEntry(ev)) return ev;
    const upcoming = (ev.schedule || []).find(s => {
      const start = new Date(s.start);
      return start > now && (start - now) < 7 * 24 * 3600000;
    });
    if (upcoming) return ev;
  }
  return null;
}

document.getElementById('event-optin-btn').addEventListener('click', async () => {
  const ev = findBannerEvent();
  if (ev) {
    await window.api.setEventOptIn({ eventId: ev.id, optedIn: true });
  }
});

document.getElementById('event-dismiss').addEventListener('click', async () => {
  const ev = findBannerEvent();
  if (ev) {
    if (ev.optedIn) {
      document.getElementById('event-banner').classList.add('hidden');
    } else {
      await window.api.setEventOptIn({ eventId: ev.id, dismissed: true });
    }
  }
});

document.getElementById('event-progress-btn').addEventListener('click', toggleEventOverlay);

document.getElementById('event-overlay-close').addEventListener('click', () => {
  toggleEventOverlay(false);
});

document.getElementById('event-export-btn').addEventListener('click', async () => {
  const ev = currentBoardEventId && activeEvents.find(e => e.id === currentBoardEventId);
  if (!ev) return;
  const result = await window.api.exportEventAdif({ eventId: ev.id });
  if (result && result.success) {
    alert(`Exported ${result.count} QSOs to ${result.filePath}`);
  }
});

function populateSettingsEvents() {
  const container = document.getElementById('settings-events-list');
  if (!container) return;
  container.innerHTML = '';
  if (!activeEvents.length) {
    container.textContent = 'No active events';
    return;
  }
  for (const ev of activeEvents) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 0;';
    const left = document.createElement('div');
    left.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const badge = document.createElement('span');
    badge.className = 'event-badge-inline';
    badge.style.background = ev.badgeColor || '#ff6b00';
    badge.textContent = ev.badge || 'EVT';
    const label = document.createElement('span');
    label.textContent = ev.name || ev.id;
    label.style.color = 'var(--text-primary)';
    left.appendChild(badge);
    left.appendChild(label);
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:3px;border:1px solid var(--border-secondary);cursor:pointer;';
    if (ev.optedIn) {
      toggle.textContent = 'Tracking';
      toggle.style.background = 'var(--accent-green)';
      toggle.style.color = '#1a1a2e';
      toggle.style.borderColor = 'var(--accent-green)';
    } else {
      toggle.textContent = 'Track';
      toggle.style.background = 'var(--bg-tertiary)';
      toggle.style.color = 'var(--text-secondary)';
    }
    toggle.addEventListener('click', async () => {
      await window.api.setEventOptIn({ eventId: ev.id, optedIn: !ev.optedIn });
      // Refresh events and re-render settings list
      const events = await window.api.getActiveEvents();
      activeEvents = events;
      populateSettingsEvents();
      updateEventBanner();
    });
    right.appendChild(toggle);
    // Reset progress button (only if opted in and has progress)
    if (ev.optedIn && Object.keys(ev.progress || {}).length > 0) {
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.textContent = 'Reset';
      resetBtn.title = 'Reset all progress for this event';
      resetBtn.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid var(--border-secondary);background:var(--bg-tertiary);color:var(--accent-red);cursor:pointer;';
      resetBtn.addEventListener('click', async () => {
        if (!confirm(`Reset all progress for ${ev.name}? This cannot be undone.`)) return;
        await window.api.resetEventProgress(ev.id);
        const events = await window.api.getActiveEvents();
        activeEvents = events;
        populateSettingsEvents();
        updateEventBanner();
      });
      right.appendChild(resetBtn);
    }
    row.appendChild(left);
    row.appendChild(right);
    container.appendChild(row);
  }
}

// Listen for events from main process
window.api.onActiveEvents((events) => {
  activeEvents = events;
  updateEventBanner();
  updateSpotsEventsSection();
  // Refresh overlay if open
  if (eventOverlayOpen && currentBoardEventId) {
    const ev = activeEvents.find(e => e.id === currentBoardEventId);
    if (ev) renderEventBoard(ev);
  }
  render(); // re-render table for badges
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
window.api.onClusterStatus((s) => {
  if (s.nodes) {
    clusterNodeStatuses = s.nodes;
    clusterConnected = s.nodes.some(n => n.connected);
    // Update status dots in settings node list if visible
    for (const ns of s.nodes) {
      const dot = clusterNodeList.querySelector(`.node-item[data-id="${ns.id}"] .node-status-dot`);
      if (dot) dot.classList.toggle('connected', ns.connected);
    }
  } else {
    // Legacy single-node format fallback
    clusterConnected = s.connected === true;
    clusterNodeStatuses = [];
  }
  updateSettingsConnBar();
  updateDxCommandNodeList();
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

window.api.onCatMode((mode) => {
  radioMode = mode;
});

let radioPower = 0; // last known TX power from CAT (watts)
window.api.onCatPower((watts) => {
  radioPower = watts;
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

// --- CW Keyer: MIDI + Sidetone ---
let midiAccess = null;
let midiInput = null;
let cwLearningTarget = null; // 'dit' | 'dah' | null
let sidetoneCtx = null;
let sidetoneOsc = null;
let sidetoneGain = null;

async function populateMidiDevices() {
  setCwMidiDevice.innerHTML = '<option value="">— No MIDI devices —</option>';
  try {
    if (!midiAccess) midiAccess = await navigator.requestMIDIAccess();
    const inputs = Array.from(midiAccess.inputs.values());
    if (inputs.length > 0) {
      setCwMidiDevice.innerHTML = '';
      for (const inp of inputs) {
        const opt = document.createElement('option');
        opt.value = inp.id;
        opt.textContent = inp.name || inp.id;
        setCwMidiDevice.appendChild(opt);
      }
    }
  } catch (err) {
    console.warn('MIDI not available:', err.message);
  }
}

function connectMidiDevice(id) {
  if (midiInput) {
    midiInput.onmidimessage = null;
    midiInput = null;
  }
  if (!midiAccess || !id) return;
  const inp = midiAccess.inputs.get(id);
  if (!inp) return;
  midiInput = inp;
  midiInput.onmidimessage = handleMidiMessage;
}

function handleMidiMessage(msg) {
  const [status, note, velocity] = msg.data;
  const cmd = status & 0xF0;
  const isNoteOn = cmd === 0x90 && velocity > 0;
  const isNoteOff = cmd === 0x80 || (cmd === 0x90 && velocity === 0);

  // Learn mode — capture note number
  if (cwLearningTarget && isNoteOn) {
    if (cwLearningTarget === 'dit') {
      setCwMidiDitNote.value = note;
    } else if (cwLearningTarget === 'dah') {
      setCwMidiDahNote.value = note;
    }
    stopLearning();
    return;
  }

  const ditNote = parseInt(setCwMidiDitNote.value, 10);
  const dahNote = parseInt(setCwMidiDahNote.value, 10);

  if (note === ditNote) {
    if (isNoteOn) window.api.cwPaddleDit(true);
    else if (isNoteOff) window.api.cwPaddleDit(false);
  } else if (note === dahNote) {
    if (isNoteOn) window.api.cwPaddleDah(true);
    else if (isNoteOff) window.api.cwPaddleDah(false);
  }
}

function stopLearning() {
  cwLearningTarget = null;
  cwLearnDitBtn.classList.remove('learning');
  cwLearnDitBtn.textContent = 'Learn';
  cwLearnDahBtn.classList.remove('learning');
  cwLearnDahBtn.textContent = 'Learn';
}

cwLearnDitBtn.addEventListener('click', () => {
  if (cwLearningTarget === 'dit') { stopLearning(); return; }
  stopLearning();
  cwLearningTarget = 'dit';
  cwLearnDitBtn.classList.add('learning');
  cwLearnDitBtn.textContent = 'Press...';
});

cwLearnDahBtn.addEventListener('click', () => {
  if (cwLearningTarget === 'dah') { stopLearning(); return; }
  stopLearning();
  cwLearningTarget = 'dah';
  cwLearnDahBtn.classList.add('learning');
  cwLearnDahBtn.textContent = 'Press...';
});

cwMidiRefreshBtn.addEventListener('click', () => {
  populateMidiDevices().then(() => connectMidiDevice(setCwMidiDevice.value));
});

// Auto-connect MIDI device when dropdown changes
setCwMidiDevice.addEventListener('change', () => {
  connectMidiDevice(setCwMidiDevice.value);
});

// Sidetone
function initSidetone() {
  if (sidetoneCtx) return;
  sidetoneCtx = new (window.AudioContext || window.webkitAudioContext)();
  sidetoneOsc = sidetoneCtx.createOscillator();
  sidetoneOsc.type = 'sine';
  sidetoneOsc.frequency.value = parseInt(setCwSidetonePitch.value, 10) || 600;
  sidetoneGain = sidetoneCtx.createGain();
  sidetoneGain.gain.value = 0;
  sidetoneOsc.connect(sidetoneGain);
  sidetoneGain.connect(sidetoneCtx.destination);
  sidetoneOsc.start();
}

function sidetoneKey(down) {
  if (!sidetoneCtx || !sidetoneGain) return;
  // Resume AudioContext if suspended (Chromium requires user gesture to start)
  if (sidetoneCtx.state === 'suspended') sidetoneCtx.resume();
  const now = sidetoneCtx.currentTime;
  sidetoneGain.gain.cancelScheduledValues(now);
  sidetoneGain.gain.setValueAtTime(sidetoneGain.gain.value, now);
  const vol = (parseInt(setCwSidetoneVolume.value, 10) || 30) / 100;
  sidetoneGain.gain.linearRampToValueAtTime(down ? vol : 0, now + 0.005);
}

function updateSidetonePitch() {
  if (sidetoneOsc) {
    sidetoneOsc.frequency.value = parseInt(setCwSidetonePitch.value, 10) || 600;
  }
}

setCwSidetonePitch.addEventListener('change', updateSidetonePitch);
setCwSidetoneVolume.addEventListener('input', () => {
  cwSidetoneVolumeLabel.textContent = setCwSidetoneVolume.value + '%';
  if (cwPopoverVolume) { cwPopoverVolume.value = setCwSidetoneVolume.value; cwPopoverVolumeLabel.textContent = setCwSidetoneVolume.value + '%'; }
});

// Live WPM adjustment — send to main immediately and sync popover
setCwWpm.addEventListener('change', () => {
  const wpm = parseInt(setCwWpm.value, 10);
  if (wpm >= 5 && wpm <= 50) {
    window.api.cwSetWpm(wpm);
    if (cwPopoverWpm) cwPopoverWpm.value = wpm;
  }
});

// CW key events from main process → sidetone
window.api.onCwKey(({ down }) => {
  console.log(`[Sidetone] key down=${down} checked=${setCwSidetone.checked} ctx=${!!sidetoneCtx}`);
  if (setCwSidetone.checked) {
    initSidetone();
    sidetoneKey(down);
  }
});

// CW keyer status
const cwTextDisplay = document.getElementById('cw-text-display');
window.api.onCwKeyerStatus(({ enabled, cwAuth }) => {
  cwKeyerStatusEl.classList.toggle('hidden', !enabled);
  cwTextDisplay.classList.toggle('hidden', !enabled);
  if (!enabled) { cwTextDisplay.textContent = ''; closeCwPopover(); }
  if (cwAuth) {
    cwKeyerStatusEl.textContent = cwAuth === 'bind' ? 'CW' : 'CW (?)';
    cwKeyerStatusEl.title = `CW keyer active — ${cwAuth === 'bind' ? 'bound to SmartSDR' : 'unbound (CW may still work)'}`;
    cwKeyerStatusEl.style.background = '#b8860b';
  }
});

// --- CW Popover (volume/WPM dropdown from CW status pill) ---
const cwPopover = document.getElementById('cw-popover');
const cwPopoverVolume = document.getElementById('cw-popover-volume');
const cwPopoverVolumeLabel = document.getElementById('cw-popover-volume-label');
const cwPopoverWpm = document.getElementById('cw-popover-wpm');
let cwPopoverOpen = false;

function positionCwPopover() {
  const rect = cwKeyerStatusEl.getBoundingClientRect();
  const bar = cwKeyerStatusEl.closest('.status-bar');
  const barRect = bar.getBoundingClientRect();
  cwPopover.style.top = (rect.bottom - barRect.top + 4) + 'px';
  cwPopover.style.left = (rect.left - barRect.left) + 'px';
}

function openCwPopover() {
  // Sync popover controls with settings controls
  cwPopoverVolume.value = setCwSidetoneVolume.value;
  cwPopoverVolumeLabel.textContent = setCwSidetoneVolume.value + '%';
  cwPopoverWpm.value = setCwWpm.value;
  positionCwPopover();
  cwPopover.classList.remove('hidden');
  cwPopoverOpen = true;
}

function closeCwPopover() {
  cwPopover.classList.add('hidden');
  cwPopoverOpen = false;
}

cwKeyerStatusEl.addEventListener('click', (e) => {
  e.stopPropagation();
  if (cwPopoverOpen) { closeCwPopover(); return; }
  // Close other popovers
  if (typeof closeCatPopover === 'function') closeCatPopover();
  document.querySelectorAll('.multi-dropdown.open').forEach((d) => d.classList.remove('open'));
  openCwPopover();
});

cwPopover.addEventListener('click', (e) => e.stopPropagation());

// Volume slider — sync with settings and update live
cwPopoverVolume.addEventListener('input', () => {
  const val = cwPopoverVolume.value;
  cwPopoverVolumeLabel.textContent = val + '%';
  setCwSidetoneVolume.value = val;
  cwSidetoneVolumeLabel.textContent = val + '%';
});

// WPM — sync with settings and send to main process live
cwPopoverWpm.addEventListener('change', () => {
  const wpm = parseInt(cwPopoverWpm.value, 10);
  if (wpm >= 5 && wpm <= 50) {
    setCwWpm.value = wpm;
    window.api.cwSetWpm(wpm);
  }
});

// Close CW popover when clicking outside
document.addEventListener('click', () => { if (cwPopoverOpen) closeCwPopover(); });

// CW decoded text display in status bar
window.api.onCwText(({ total }) => {
  // Show last ~40 characters of sent text, right-aligned so newest is visible
  const display = total.length > 40 ? total.slice(-40) : total;
  cwTextDisplay.textContent = display;
  cwTextDisplay.classList.remove('hidden');
});

// Unlock AudioContext on first user interaction (Chromium autoplay policy)
document.addEventListener('click', function unlockAudio() {
  document.removeEventListener('click', unlockAudio);
  if (setCwSidetone.checked) {
    initSidetone();
    if (sidetoneCtx && sidetoneCtx.state === 'suspended') sidetoneCtx.resume();
  }
}, { once: true });

// MIDI hot-plug: re-enumerate when devices change
(async function initMidiHotplug() {
  try {
    if (!midiAccess) midiAccess = await navigator.requestMIDIAccess();
    midiAccess.onstatechange = () => {
      if (setEnableCwKeyer.checked) populateMidiDevices();
    };
  } catch { /* MIDI not available */ }
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
document.getElementById('check-update-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.checkForUpdates();
  document.getElementById('settings-dialog').close();
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
  document.getElementById('welcome-rigctldnet-config').classList.toggle('hidden', type !== 'rigctldnet');
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
  } else if (type === 'rigctldnet') {
    return {
      type: 'rigctldnet',
      host: document.getElementById('welcome-rigctldnet-host').value.trim() || '127.0.0.1',
      port: parseInt(document.getElementById('welcome-rigctldnet-port').value, 10) || 4532,
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

  // Merge with existing settings so upgrade doesn't wipe user preferences
  const saveData = {
    ...currentSettings,
    myCallsign,
    grid,
    distUnit: distUnitVal,
    licenseClass: licenseClassVal,
    hideOutOfBand: hideOobChecked,
    firstRun: false,
    lastVersion: currentSettings.appVersion,
    enablePota: enablePotaVal,
    enableSota: enableSotaVal,
    enableWwff: enableWwffVal,
    enableLlota: enableLlotaVal,
    lightMode: lightModeEnabled,
    appMode: document.querySelector('input[name="welcome-app-mode"]:checked')?.value || 'hunter',
  };
  delete saveData.appVersion; // runtime-only, don't persist

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

  if (force || s.firstRun) {
    // Reset welcome rig state
    welcomeRig = null;
    const welcomeRigDisplay = document.getElementById('welcome-rig-display');
    welcomeRigDisplay.innerHTML = '';
    welcomeRigDisplay.classList.add('hidden');
    document.getElementById('welcome-rig-add-btn').classList.remove('hidden');
    document.getElementById('welcome-rig-editor').classList.add('hidden');
    // Pre-fill with existing settings when forced (not fresh install)
    if (force) {
      welcomeCallsignInput.value = s.myCallsign || '';
      welcomeGridInput.value = s.grid || '';
      if (s.distUnit) document.getElementById('welcome-dist-unit').value = s.distUnit;
      if (s.licenseClass) document.getElementById('welcome-license-class').value = s.licenseClass;
      document.getElementById('welcome-hide-oob').checked = s.hideOutOfBand === true;
      document.getElementById('welcome-enable-pota').checked = s.enablePota !== false;
      document.getElementById('welcome-enable-sota').checked = s.enableSota === true;
      if (document.getElementById('welcome-enable-wwff')) document.getElementById('welcome-enable-wwff').checked = s.enableWwff === true;
      if (document.getElementById('welcome-enable-llota')) document.getElementById('welcome-enable-llota').checked = s.enableLlota === true;
      const welcomeModeRadio = document.querySelector(`input[name="welcome-app-mode"][value="${s.appMode || 'hunter'}"]`);
      if (welcomeModeRadio) welcomeModeRadio.checked = true;
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
  } else if (isNewVersion) {
    // Version changed — show "What's New" release notes, not the welcome screen
    await window.api.saveSettings({ lastVersion: s.appVersion });
    showWhatsNew(s.appVersion);
  }
}

async function showWhatsNew(version) {
  const dialog = document.getElementById('whats-new-dialog');
  const title = document.getElementById('whats-new-title');
  const body = document.getElementById('whats-new-body');
  const closeBtn = document.getElementById('whats-new-close');

  title.textContent = `What's New in v${version}`;
  body.innerHTML = '<em>Loading release notes...</em>';
  dialog.showModal();

  closeBtn.onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  }, { once: true });

  const data = await window.api.getReleaseNotes(version);
  if (data && data.body) {
    // Convert markdown-ish release notes to simple HTML
    body.innerHTML = formatReleaseNotes(data.body);
    // Open links externally
    body.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (a.href) window.api.openExternal(a.href);
      });
    });
  } else {
    body.innerHTML = '<p>No release notes available for this version.</p>';
  }
}

function formatReleaseNotes(md) {
  // Strip everything from "## Install" or "## Checksums" onward
  md = md.replace(/\n## (Install|Checksums)[\s\S]*/i, '').trim();

  // Simple markdown → HTML for release notes
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^## (.+)$/gm, '<h4 style="margin:12px 0 6px;color:var(--text-primary);">$1</h4>')
    .replace(/^### (.+)$/gm, '<h5 style="margin:10px 0 4px;color:var(--text-primary);">$1</h5>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => '<ul style="margin:4px 0;padding-left:20px;">' + m + '</ul>')
    .replace(/```[\s\S]*?```/g, (m) => '<pre style="background:var(--bg-primary);padding:8px;border-radius:4px;font-size:11px;overflow-x:auto;">' + m.replace(/```\w*\n?/g, '').trim() + '</pre>')
    .replace(/\n\n/g, '<br>')
    .replace(/\n/g, '\n');
}

// =============================================================================
// ACTIVATOR MODE
// =============================================================================

const activatorView = document.getElementById('activator-view');
const activatorParkRefInput = document.getElementById('activator-park-ref');
const activatorParkDropdown = document.getElementById('activator-park-dropdown');
const activatorParkNameEl = document.getElementById('activator-park-name');
const activatorFreqInput = document.getElementById('activator-freq');
const activatorBandLabel = document.getElementById('activator-band-label');
const activatorModeSelect = document.getElementById('activator-mode');
const activatorCounterEl = document.getElementById('activator-counter');
const activatorUtcEl = document.getElementById('activator-utc');
const activatorTimerEl = document.getElementById('activator-timer');
const activatorCallsignInput = document.getElementById('activator-callsign');
const activatorOpNameEl = document.getElementById('activator-op-name');
const activatorLogBtn = document.getElementById('activator-log-btn');
const activatorLogBody = document.getElementById('activator-log-body');
const activatorExportBtn = document.getElementById('activator-export');
const activatorMapBtn = document.getElementById('activator-map-btn');
const activatorBackBtn = document.getElementById('activator-back');
const activatorStartBtn = document.getElementById('activator-start-btn');
const activatorContinueBtn = document.getElementById('activator-continue-btn');
const activatorStopBtn = document.getElementById('activator-stop-btn');
const activatorHistoryBtn = document.getElementById('activator-history-btn');
const activatorQuickLog = document.getElementById('activator-quick-log');
const activatorIdleMsg = document.getElementById('activator-idle-msg');
const activatorHistoryPanel = document.getElementById('activator-history-panel');
const activatorHistoryList = document.getElementById('activator-history-list');
const activatorHistoryClose = document.getElementById('activator-history-close');
const headerEl = document.querySelector('header');
const mainEl = document.querySelector('main');
const eventBannerEl = document.getElementById('event-banner');
const dxCommandBarEl = document.querySelector('.dx-command-bar');

/** Update the title bar text based on current mode */
function updateTitleBar() {
  const v = window._appVersion || '';
  const ttEl = document.querySelector('.titlebar-title');
  if (!ttEl) return;
  if (appMode === 'activator') {
    ttEl.textContent = `POTACAT - Activator Mode${v ? ` - v${v}` : ''}`;
  } else {
    ttEl.textContent = `POTACAT - Hunter Mode${v ? ` - v${v}` : ''}`;
  }
}

/**
 * Toggle between Hunter and Activator mode.
 */
function setAppMode(mode) {
  appMode = mode;
  updateTitleBar();
  if (mode === 'activator') {
    // Hide hunter UI — including event banner
    if (headerEl) headerEl.classList.add('hidden');
    if (mainEl) mainEl.classList.add('hidden');
    if (eventBannerEl) eventBannerEl.classList.add('hidden');
    if (dxCommandBarEl) dxCommandBarEl.classList.add('hidden');
    // Show activator
    activatorView.classList.remove('hidden');
    // Focus park ref if empty, otherwise callsign
    if (!primaryParkRef()) {
      activatorParkRefInput.focus();
    } else if (activationActive) {
      activatorCallsignInput.focus();
    } else {
      activatorParkRefInput.focus();
    }
    // Seed freq/mode from current CAT state
    if (radioFreqKhz) {
      activatorFreqKhz = radioFreqKhz;
      activatorFreqInput.value = (radioFreqKhz / 1000).toFixed(3);
      updateActivatorBandLabel(radioFreqKhz);
    }
    if (radioMode) updateActivatorModeFromCat(radioMode);
    // Init activator RST defaults
    resetActivatorRst();
    // Start activator UTC clock
    updateActivatorUtc();
    // Update activation UI state
    updateActivationUi();
    // Trigger parks DB load
    window.api.fetchParksDb('auto');
  } else {
    // Show hunter UI
    if (headerEl) headerEl.classList.remove('hidden');
    if (mainEl) mainEl.classList.remove('hidden');
    if (dxCommandBarEl) dxCommandBarEl.classList.remove('hidden');
    // Hide activator
    activatorView.classList.add('hidden');
    // Restore event banner visibility via its own logic
    updateEventBanner();
    render();
  }
}

/** Start a brand-new activation for the current park */
function startActivation() {
  if (!primaryParkRef()) {
    activatorParkRefInput.focus();
    return;
  }
  // New activation — clears in-memory contacts
  activatorContacts = [];
  beginActivation();
}

/** Continue the current stopped activation (keep existing contacts) */
function continueActivation() {
  if (!primaryParkRef() || activatorContacts.length === 0) return;
  beginActivation();
}

/** Resume a past activation from the log */
function resumeActivation(activation) {
  activatorParkRefs = [{ ref: activation.parkRef, name: '' }];
  hunterParkRefs = [];
  activatorParkRefInput.value = activation.parkRef;
  activatorParkNameEl.textContent = '';
  updateParkExtraBadge();
  // Look up park name
  window.api.getPark(activation.parkRef).then(park => {
    if (park) {
      activatorParkRefs[0].name = park.name || '';
      activatorParkNameEl.textContent = park.name || '';
    }
  });
  window.api.saveSettings({ activatorParkRefs });
  // Restore contacts from log data
  activatorContacts = activation.contacts.map(c => {
    const timeOn = c.timeOn || '';
    const hh = timeOn.substring(0, 2);
    const mm = timeOn.substring(2, 4);
    const freqMhz = c.freq ? parseFloat(c.freq).toFixed(3) : '';
    return {
      callsign: c.callsign,
      timeUtc: (hh && mm) ? `${hh}:${mm}` : '',
      freqDisplay: freqMhz,
      mode: c.mode || '',
      band: c.band || '',
      rstSent: c.rstSent || '',
      rstRcvd: c.rstRcvd || '',
      name: c.name || '',
      myParks: [activation.parkRef],
      theirParks: c.sigInfo ? [c.sigInfo] : [],
      qsoData: {
        callsign: c.callsign,
        frequency: c.freq ? String(Math.round(parseFloat(c.freq) * 1000)) : '',
        mode: c.mode || '',
        band: c.band || '',
        qsoDate: activation.date,
        timeOn: c.timeOn || '',
        rstSent: c.rstSent || '',
        rstRcvd: c.rstRcvd || '',
        mySig: 'POTA',
        mySigInfo: activation.parkRef,
        stationCallsign: myCallsign || '',
        operator: myCallsign || '',
      },
      qsoDataList: [{
        callsign: c.callsign,
        frequency: c.freq ? String(Math.round(parseFloat(c.freq) * 1000)) : '',
        mode: c.mode || '',
        band: c.band || '',
        qsoDate: activation.date,
        timeOn: c.timeOn || '',
        rstSent: c.rstSent || '',
        rstRcvd: c.rstRcvd || '',
        mySig: 'POTA',
        mySigInfo: activation.parkRef,
        stationCallsign: myCallsign || '',
        operator: myCallsign || '',
      }],
    };
  });
  // Hide history panel
  activatorHistoryPanel.classList.add('hidden');
  beginActivation();
}

/** Common activation start logic (used by start, continue, and resume) */
function beginActivation() {
  activationActive = true;
  activationStartTime = Date.now();
  updateActivationUi();
  updateActivatorCounter();
  renderActivatorLog();
  activatorCallsignInput.focus();
  // Start the timer
  if (activationTimerInterval) clearInterval(activationTimerInterval);
  activationTimerInterval = setInterval(updateActivationTimer, 1000);
  updateActivationTimer();
}

/** Stop the current activation */
function stopActivation() {
  activationActive = false;
  if (activationTimerInterval) {
    clearInterval(activationTimerInterval);
    activationTimerInterval = null;
  }
  updateActivationUi();
}

/** Update which UI elements are visible based on activation state */
function updateActivationUi() {
  const hasContacts = activatorContacts.length > 0;
  if (activationActive) {
    // Running: show Stop, hide Start/Continue
    activatorStartBtn.classList.add('hidden');
    activatorContinueBtn.classList.add('hidden');
    activatorStopBtn.classList.remove('hidden');
    activatorQuickLog.classList.remove('hidden');
    activatorIdleMsg.classList.add('hidden');
    activatorHistoryPanel.classList.add('hidden');
    activatorTimerEl.classList.add('active');
    // Lock park ref input while active
    activatorParkRefInput.disabled = true;
  } else {
    // Stopped
    activatorStopBtn.classList.add('hidden');
    activatorQuickLog.classList.add('hidden');
    activatorTimerEl.classList.remove('active');
    activatorTimerEl.textContent = '--:--';
    // Unlock park ref
    activatorParkRefInput.disabled = false;

    if (hasContacts) {
      // Stopped with contacts — show Continue + New
      activatorContinueBtn.classList.remove('hidden');
      activatorStartBtn.classList.remove('hidden');
      activatorStartBtn.textContent = 'New Activation';
      activatorStartBtn.disabled = !primaryParkRef();
      activatorIdleMsg.classList.add('hidden');
    } else {
      // No contacts — show Start, hide Continue
      activatorContinueBtn.classList.add('hidden');
      activatorStartBtn.classList.remove('hidden');
      activatorStartBtn.textContent = 'Start Activation';
      activatorStartBtn.disabled = !primaryParkRef();
      // Show idle message only when history panel is not open
      if (activatorHistoryPanel.classList.contains('hidden')) {
        activatorIdleMsg.classList.remove('hidden');
      }
    }
  }
}

/** Format and display the running activation timer */
function updateActivationTimer() {
  if (!activationActive || !activationStartTime) return;
  const elapsed = Math.floor((Date.now() - activationStartTime) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  if (h > 0) {
    activatorTimerEl.textContent = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  } else {
    activatorTimerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }
}

function resetActivatorRst() {
  const mode = activatorModeSelect.value;
  const isPhone = (mode === 'SSB' || mode === 'FM');
  const def = isPhone ? '59' : '599';
  setRstDigits('activator-rst-sent', def);
  setRstDigits('activator-rst-rcvd', def);
}

function updateActivatorUtc() {
  if (appMode !== 'activator') return;
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  activatorUtcEl.textContent = `${hh}:${mm}:${ss}Z`;
  setTimeout(updateActivatorUtc, 1000);
}

function updateActivatorCounter() {
  const count = activatorContacts.length;
  const totalRecords = activatorContacts.reduce((sum, c) => sum + (c.qsoDataList ? c.qsoDataList.length : 1), 0);
  activatorCounterEl.textContent = count;
  activatorCounterEl.classList.toggle('valid', count >= 10);
  const recordNote = totalRecords > count ? ` (${totalRecords} ADIF records)` : '';
  activatorCounterEl.title = `${count} contact${count !== 1 ? 's' : ''} logged${recordNote}${count >= 10 ? ' — valid activation!' : ` (need ${10 - count} more)`}`;
}

function renderActivatorLog() {
  activatorLogBody.innerHTML = '';
  // Newest on top
  for (let i = activatorContacts.length - 1; i >= 0; i--) {
    const c = activatorContacts[i];
    const tr = document.createElement('tr');
    // Check if this callsign has been worked before (from main logbook)
    const workedBefore = workedQsos.has(c.callsign.toUpperCase());
    const dupeFlag = workedBefore ? '<span class="act-log-dupe" title="Worked before">PREV</span>' : '';
    const p2pBadge = (c.theirParks && c.theirParks.length > 0) ? `<span class="act-log-p2p" title="P2P: ${c.theirParks.join(', ')}">P2P</span>` : '';
    tr.innerHTML = `
      <td class="act-log-num">${i + 1}</td>
      <td class="act-log-time">${c.timeUtc || ''}</td>
      <td class="act-log-call">${c.callsign || ''}${dupeFlag}${p2pBadge}</td>
      <td class="act-log-name">${c.name || ''}</td>
      <td class="act-log-freq">${c.freqDisplay || ''}</td>
      <td class="act-log-mode">${c.mode || ''}</td>
      <td class="act-log-rst">${c.rstSent || ''}</td>
      <td class="act-log-rst">${c.rstRcvd || ''}</td>
      <td class="act-log-band">${c.band || ''}</td>
    `;
    activatorLogBody.appendChild(tr);
  }
}

// --- Start / Stop / Continue / History buttons ---
if (activatorStartBtn) {
  activatorStartBtn.addEventListener('click', startActivation);
}
if (activatorContinueBtn) {
  activatorContinueBtn.addEventListener('click', continueActivation);
}
if (activatorStopBtn) {
  activatorStopBtn.addEventListener('click', stopActivation);
}
if (activatorHistoryBtn) {
  activatorHistoryBtn.addEventListener('click', showPastActivations);
}
if (activatorHistoryClose) {
  activatorHistoryClose.addEventListener('click', () => {
    activatorHistoryPanel.classList.add('hidden');
    // Restore idle message if appropriate
    if (!activationActive && activatorContacts.length === 0) {
      activatorIdleMsg.classList.remove('hidden');
    }
  });
}
// Activation map close button
const activationMapClose = document.getElementById('activation-map-close');
if (activationMapClose) {
  activationMapClose.addEventListener('click', () => {
    document.getElementById('activation-map-panel').classList.add('hidden');
    if (activationMap) { activationMap.remove(); activationMap = null; }
  });
}

async function showPastActivations() {
  activatorIdleMsg.classList.add('hidden');
  activatorHistoryPanel.classList.remove('hidden');
  activatorHistoryList.innerHTML = '<div style="padding:12px;color:var(--text-tertiary);">Loading...</div>';
  try {
    const activations = await window.api.getPastActivations();
    activatorHistoryList.innerHTML = '';
    if (!activations || activations.length === 0) {
      activatorHistoryList.innerHTML = '<div style="padding:12px;color:var(--text-tertiary);">No past POTA activations found in your logbook.</div>';
      return;
    }
    for (const act of activations) {
      const count = act.contacts.length;
      const dateStr = act.date ? `${act.date.substring(0, 4)}-${act.date.substring(4, 6)}-${act.date.substring(6, 8)}` : '?';
      const validClass = count >= 10 ? 'valid' : '';
      const wrapper = document.createElement('div');
      wrapper.className = 'activator-history-wrapper';
      // Header row (clickable to expand)
      const item = document.createElement('div');
      item.className = 'activator-history-item';
      item.innerHTML = `
        <span class="activator-history-item-expand">&#x25B6;</span>
        <span class="activator-history-item-ref">${act.parkRef}</span>
        <span class="activator-history-item-date">${dateStr}</span>
        <span class="activator-history-item-count"><span class="${validClass}">${count} QSO${count !== 1 ? 's' : ''}</span></span>
        <button class="activator-history-item-resume">Resume</button>
      `;
      item.querySelector('.activator-history-item-resume').addEventListener('click', (e) => {
        e.stopPropagation();
        resumeActivation(act);
      });
      // Expandable detail section
      const detail = document.createElement('div');
      detail.className = 'activator-history-detail hidden';
      detail.innerHTML = `
        <div class="activator-history-actions">
          <button class="act-hist-export-btn" title="Export this activation as ADIF">Export ADIF</button>
          <button class="act-hist-map-btn" title="Show contacts on map">Map</button>
          <button class="act-hist-delete-btn" title="Delete this activation">Delete</button>
        </div>
        <table class="act-hist-table">
          <thead><tr><th>#</th><th>Time</th><th>Call</th><th>Name</th><th>Freq</th><th>Mode</th><th>RST S</th><th>RST R</th></tr></thead>
          <tbody>${act.contacts.map((c, i) => {
            const hh = (c.timeOn || '').substring(0, 2);
            const mm = (c.timeOn || '').substring(2, 4);
            const t = (hh && mm) ? `${hh}:${mm}` : '';
            const fMhz = c.freq ? parseFloat(c.freq).toFixed(3) : '';
            return `<tr><td>${i + 1}</td><td>${t}</td><td>${c.callsign}</td><td>${c.name || ''}</td><td>${fMhz}</td><td>${c.mode || ''}</td><td>${c.rstSent || ''}</td><td>${c.rstRcvd || ''}</td></tr>`;
          }).join('')}</tbody>
        </table>
      `;
      // Toggle expand on header click
      item.addEventListener('click', () => {
        const wasHidden = detail.classList.contains('hidden');
        detail.classList.toggle('hidden');
        item.querySelector('.activator-history-item-expand').innerHTML = wasHidden ? '&#x25BC;' : '&#x25B6;';
      });
      // Export button
      detail.querySelector('.act-hist-export-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        exportPastActivation(act);
      });
      // Map button
      detail.querySelector('.act-hist-map-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showActivationMap(act);
      });
      // Delete button (two-click confirmation)
      const deleteBtn = detail.querySelector('.act-hist-delete-btn');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (deleteBtn.dataset.confirm === 'yes') {
          deletePastActivation(act, wrapper);
        } else {
          deleteBtn.dataset.confirm = 'yes';
          deleteBtn.textContent = 'Confirm Delete?';
          deleteBtn.classList.add('confirm');
          setTimeout(() => {
            deleteBtn.dataset.confirm = '';
            deleteBtn.textContent = 'Delete';
            deleteBtn.classList.remove('confirm');
          }, 3000);
        }
      });
      wrapper.appendChild(item);
      wrapper.appendChild(detail);
      activatorHistoryList.appendChild(wrapper);
    }
  } catch (err) {
    activatorHistoryList.innerHTML = `<div style="padding:12px;color:var(--accent-red);">Error loading activations: ${err.message}</div>`;
  }
}

/** Export a past activation's QSOs as ADIF */
async function exportPastActivation(act) {
  const qsos = act.contacts.map(c => ({
    callsign: c.callsign,
    frequency: c.freq ? String(Math.round(parseFloat(c.freq) * 1000)) : '',
    mode: c.mode || '',
    band: c.band || '',
    qsoDate: act.date,
    timeOn: c.timeOn || '',
    rstSent: c.rstSent || '',
    rstRcvd: c.rstRcvd || '',
    mySig: 'POTA',
    mySigInfo: act.parkRef,
    stationCallsign: myCallsign || '',
    operator: myCallsign || '',
    name: c.name || '',
  }));
  try {
    const result = await window.api.exportActivationAdif({ qsos, parkRef: act.parkRef, myCallsign: myCallsign || '' });
    if (result && result.success) {
      showLogToast(`Exported ${qsos.length} QSOs to ${result.path.split(/[\\/]/).pop()}`);
    }
  } catch (err) {
    console.error('[Activator] Export failed:', err);
  }
}

/** Delete a past activation and its QSOs from the log */
async function deletePastActivation(act, wrapperEl) {
  try {
    const result = await window.api.deleteActivation(act.parkRef, act.date);
    if (result && result.success) {
      wrapperEl.remove();
      showLogToast(`Deleted ${result.removed} QSO${result.removed !== 1 ? 's' : ''} from ${act.parkRef} (${act.date})`);
      // If no items left, show empty message
      if (activatorHistoryList.children.length === 0) {
        activatorHistoryList.innerHTML = '<div style="padding:12px;color:var(--text-tertiary);">No past POTA activations found in your logbook.</div>';
      }
    } else {
      showLogToast('Delete failed: ' + (result?.error || 'unknown error'));
    }
  } catch (err) {
    showLogToast('Delete failed: ' + err.message);
  }
}

/** Show activation contacts on a Leaflet map centered on the park */
let activationMap = null;
let activationMapMarkers = [];

async function showActivationMap(act) {
  const mapPanel = document.getElementById('activation-map-panel');
  const mapTitle = document.getElementById('activation-map-title');
  mapPanel.classList.remove('hidden');
  mapTitle.textContent = `${act.parkRef} — ${act.contacts.length} QSO${act.contacts.length !== 1 ? 's' : ''}`;

  // Get park location
  let parkLat = null, parkLon = null;
  try {
    const park = await window.api.getPark(act.parkRef);
    if (park && park.latitude && park.longitude) {
      parkLat = parseFloat(park.latitude);
      parkLon = parseFloat(park.longitude);
    }
  } catch {}

  // Resolve contact callsign locations via cty.dat
  const callsigns = [...new Set(act.contacts.map(c => c.callsign).filter(Boolean))];
  let locations = {};
  try {
    locations = await window.api.resolveCallsignLocations(callsigns);
  } catch {}

  // Initialize or reuse map
  if (activationMap) {
    activationMap.remove();
    activationMap = null;
  }
  activationMapMarkers = [];

  const centerLat = parkLat ?? 39.8;
  const centerLon = parkLon ?? -98.5;
  activationMap = L.map('activation-map', { zoomControl: true, worldCopyJump: true }).setView([centerLat, centerLon], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(activationMap);

  // Park marker (green, prominent)
  if (parkLat != null && parkLon != null) {
    const parkIcon = L.divIcon({ className: 'activation-map-park-icon', html: '<div class="act-map-park-pin"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });
    L.marker([parkLat, parkLon], { icon: parkIcon, zIndexOffset: 1000 })
      .bindPopup(`<b>${act.parkRef}</b><br>${act.contacts.length} contacts`)
      .addTo(activationMap);
  }

  // Contact markers — one per QSO, jittered to avoid stacking when
  // multiple contacts resolve to the same cty.dat country-level position
  const bounds = [];
  if (parkLat != null && parkLon != null) bounds.push([parkLat, parkLon]);
  const usedPositions = []; // track placed positions for jitter
  for (let i = 0; i < act.contacts.length; i++) {
    const c = act.contacts[i];
    const loc = locations[c.callsign];
    if (!loc) continue;
    // Jitter: offset markers that land on the same cty.dat position
    let cLat = loc.lat, cLon = loc.lon;
    const overlap = usedPositions.filter(p => Math.abs(p[0] - cLat) < 0.01 && Math.abs(p[1] - cLon) < 0.01).length;
    if (overlap > 0) {
      // Spread in a small circle around the base point using golden angle
      const angle = (overlap * 137.5) * Math.PI / 180;
      const r = 0.8 + overlap * 0.3; // degrees offset
      cLat += r * Math.cos(angle);
      cLon += r * Math.sin(angle);
    }
    usedPositions.push([cLat, cLon]);

    const hh = (c.timeOn || '').substring(0, 2);
    const mm = (c.timeOn || '').substring(2, 4);
    const t = (hh && mm) ? `${hh}:${mm}` : '';
    const fMhz = c.freq ? parseFloat(c.freq).toFixed(3) : '';
    const popupHtml = `<b>${c.callsign}</b>${c.name ? ' — ' + c.name : ''}<br>${t} UTC  ${fMhz} ${c.mode || ''}<br><span style="color:#aaa">${loc.name}</span>`;
    const marker = L.circleMarker([cLat, cLon], {
      radius: 6, fillColor: '#4fc3f7', color: '#fff', weight: 1, fillOpacity: 0.85,
    }).bindPopup(popupHtml).addTo(activationMap);
    activationMapMarkers.push(marker);
    bounds.push([cLat, cLon]);

    // Draw great circle arc from park to contact
    if (parkLat != null && parkLon != null) {
      const arcPoints = greatCircleArc(parkLat, parkLon, cLat, cLon, 50);
      L.polyline(arcPoints, {
        color: '#4fc3f7', weight: 1.5, opacity: 0.5, dashArray: '6,4',
      }).addTo(activationMap);
    }
  }

  // Fit bounds if we have points
  if (bounds.length > 1) {
    activationMap.fitBounds(bounds, { padding: [30, 30] });
  }

  // Force a resize after the panel becomes visible
  setTimeout(() => { if (activationMap) activationMap.invalidateSize(); }, 100);
}

// --- Park autocomplete ---
let parkSearchTimeout = null;

if (activatorParkRefInput) {
  activatorParkRefInput.addEventListener('input', () => {
    clearTimeout(parkSearchTimeout);
    const query = activatorParkRefInput.value.trim();
    if (query.length < 2) {
      activatorParkDropdown.classList.add('hidden');
      // Disable start if park cleared
      activatorStartBtn.disabled = true;
      activatorParkNameEl.textContent = '';
      activatorParkRefs = [];
      updateParkExtraBadge();
      return;
    }
    parkSearchTimeout = setTimeout(async () => {
      const results = await window.api.searchParks(query);
      if (!results || !results.length) {
        activatorParkDropdown.classList.add('hidden');
        return;
      }
      activatorParkDropdown.innerHTML = '';
      for (const park of results) {
        const item = document.createElement('div');
        item.className = 'activator-dropdown-item';
        item.innerHTML = `<span class="activator-dropdown-ref">${park.reference}</span><span class="activator-dropdown-name">${park.name || ''}</span><span class="activator-dropdown-loc">${park.locationDesc || ''}</span>`;
        item.addEventListener('click', () => selectPark(park));
        activatorParkDropdown.appendChild(item);
      }
      activatorParkDropdown.classList.remove('hidden');
    }, 150);
  });

  // Close dropdown on blur (delayed to allow click)
  activatorParkRefInput.addEventListener('blur', () => {
    setTimeout(() => activatorParkDropdown.classList.add('hidden'), 200);
  });

  // Allow Enter to select first dropdown item
  activatorParkRefInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = activatorParkDropdown.querySelector('.activator-dropdown-item');
      if (first && !activatorParkDropdown.classList.contains('hidden')) {
        first.click();
        e.preventDefault();
      }
    }
  });
}

function selectPark(park) {
  activatorParkRefs = [{ ref: park.reference, name: park.name || '' }];
  activatorParkRefInput.value = park.reference;
  activatorParkNameEl.textContent = park.name || '';
  activatorParkDropdown.classList.add('hidden');
  updateParkExtraBadge();
  // Enable start button
  activatorStartBtn.disabled = false;
  // Persist to settings
  window.api.saveSettings({ activatorParkRefs });
}

/** Update the park display: input value, name, and extra badge */
function updateParkDisplay() {
  activatorParkRefInput.value = primaryParkRef();
  activatorParkNameEl.textContent = primaryParkName();
  updateParkExtraBadge();
}

/** Show/hide the +N badge for additional MY_SIG_INFO parks */
function updateParkExtraBadge() {
  const badge = document.getElementById('activator-park-extra');
  if (!badge) return;
  const extra = activatorParkRefs.length - 1;
  if (extra > 0) {
    badge.textContent = `+${extra}`;
    badge.classList.remove('hidden');
    badge.title = activatorParkRefs.slice(1).map(p => p.ref).join(', ');
  } else {
    badge.textContent = '';
    badge.classList.add('hidden');
  }
}

/** Update hunter park input display and extra badge */
function updateHunterParkDisplay() {
  const input = document.getElementById('activator-hunter-park');
  const badge = document.getElementById('activator-hunter-park-extra');
  if (input) {
    input.value = hunterParkRefs[0]?.ref || '';
  }
  if (!badge) return;
  const extra = hunterParkRefs.length - 1;
  if (extra > 0) {
    badge.textContent = `+${extra}`;
    badge.classList.remove('hidden');
    badge.title = hunterParkRefs.slice(1).map(p => p.ref).join(', ');
  } else {
    badge.textContent = '';
    badge.classList.add('hidden');
  }
}

// --- Quick Log ---
async function activatorLogContact() {
  if (!activationActive) return; // must have an active activation
  const callsign = activatorCallsignInput.value.trim().toUpperCase();
  if (!callsign) return;
  if (!primaryParkRef()) {
    activatorParkRefInput.focus();
    return;
  }

  const mode = activatorModeSelect.value;
  const rstSent = getRstDigits('activator-rst-sent', mode === 'SSB' || mode === 'FM' ? '59' : '599');
  const rstRcvd = getRstDigits('activator-rst-rcvd', mode === 'SSB' || mode === 'FM' ? '59' : '599');

  // Frequency: prefer the input field (may have been manually entered), fall back to CAT
  const inputMhz = parseFloat(activatorFreqInput.value);
  const freqKhz = inputMhz > 0 ? Math.round(inputMhz * 1000) : (activatorFreqKhz || radioFreqKhz || 0);
  const freqMhz = freqKhz ? (freqKhz / 1000).toFixed(3) : '';
  const band = freqToBandActivator(freqKhz) || '';

  const now = new Date();
  const qsoDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  const timeOn = `${hh}${mm}${ss}`;
  const timeUtc = `${hh}:${mm}`;

  // Build base fields for cross-product
  const baseFields = {
    callsign,
    frequency: freqKhz ? String(freqKhz) : '',
    mode,
    band,
    qsoDate,
    timeOn,
    rstSent,
    rstRcvd,
    txPower: defaultPower ? String(defaultPower) : '',
    stationCallsign: myCallsign || '',
    operator: myCallsign || '',
  };

  // Cross-product: one ADIF record per MY_SIG_INFO × SIG_INFO combination
  const myParks = activatorParkRefs;                              // always >= 1
  const theirParks = hunterParkRefs.length > 0 ? hunterParkRefs : [null];
  const allQsoData = [];

  for (const myPark of myParks) {
    for (const theirPark of theirParks) {
      const qsoData = { ...baseFields, mySig: 'POTA', mySigInfo: myPark.ref };
      if (theirPark) { qsoData.sig = 'POTA'; qsoData.sigInfo = theirPark.ref; }
      allQsoData.push(qsoData);
    }
  }

  // Save all cross-product records via existing pipeline
  try {
    for (const qsoData of allQsoData) {
      await window.api.saveQso(qsoData);
    }
  } catch (err) {
    console.error('[Activator] Failed to save QSO:', err);
  }

  // Add to in-memory list — one entry per physical QSO
  const contact = {
    callsign,
    timeUtc,
    freqDisplay: freqMhz,
    mode,
    band,
    rstSent,
    rstRcvd,
    name: '',
    myParks: myParks.map(p => p.ref),
    theirParks: hunterParkRefs.map(p => p.ref),
    qsoData: allQsoData[0], // backward compat
    qsoDataList: allQsoData, // all cross-product records for export
  };
  activatorContacts.push(contact);
  updateActivatorCounter();
  renderActivatorLog();

  // Push to activation map pop-out
  if (actmapPopoutOpen) {
    window.api.actmapPopoutContact({
      parkRefs: activatorParkRefs.map(p => p.ref),
      contact,
    });
  }

  // Clear and refocus
  activatorCallsignInput.value = '';
  activatorOpNameEl.textContent = '';
  resetActivatorRst();
  // Reset hunter parks for next QSO
  hunterParkRefs = [];
  updateHunterParkDisplay();
  activatorCallsignInput.focus();

  // Fire-and-forget QRZ lookup for name
  window.api.qrzLookup(callsign).then(info => {
    if (info) {
      const name = qrzDisplayName(info);
      contact.name = name;
      renderActivatorLog();
    }
  }).catch(() => {});
}

if (activatorLogBtn) {
  activatorLogBtn.addEventListener('click', activatorLogContact);
}

// Enter key in callsign or RST fields triggers log
if (activatorCallsignInput) {
  activatorCallsignInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      activatorLogContact();
    }
    // Tab — trigger QRZ lookup immediately (let Tab proceed to next field)
    if (e.key === 'Tab') {
      const val = activatorCallsignInput.value.trim().toUpperCase();
      if (val.length >= 3) {
        clearTimeout(activatorQrzTimeout);
        window.api.qrzLookup(val).then(info => {
          if (info && activatorCallsignInput.value.trim().toUpperCase() === val) {
            activatorOpNameEl.textContent = qrzDisplayName(info);
          }
        }).catch(() => {});
      }
    }
  });
}

// RST digit navigation for activator RST fields
document.querySelectorAll('#activator-rst-sent .rst-digit, #activator-rst-rcvd .rst-digit').forEach(input => {
  input.addEventListener('input', () => {
    if (input.value && input.dataset.idx !== '2') {
      const next = input.parentElement.querySelector(`.rst-digit[data-idx="${parseInt(input.dataset.idx) + 1}"]`);
      if (next) next.focus();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && input.dataset.idx !== '0') {
      const prev = input.parentElement.querySelector(`.rst-digit[data-idx="${parseInt(input.dataset.idx) - 1}"]`);
      if (prev) prev.focus();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      activatorLogContact();
    }
  });
});

// Map button — open activation map pop-out
if (activatorMapBtn) {
  activatorMapBtn.addEventListener('click', () => {
    window.api.actmapPopoutOpen();
  });
}

// Export button
if (activatorExportBtn) {
  activatorExportBtn.addEventListener('click', async () => {
    if (!activatorContacts.length) return;
    // Flatten all cross-product records for export
    const qsos = activatorContacts.flatMap(c => c.qsoDataList || [c.qsoData]);
    const result = await window.api.exportActivationAdif({
      qsos,
      parkRef: primaryParkRef(),
      myCallsign: myCallsign || '',
    });
    if (result && result.success) {
      const toast = document.createElement('div');
      toast.textContent = `Exported ${qsos.length} QSOs to ${result.path}`;
      toast.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);background:var(--accent-green);color:#111;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:600;z-index:9999;';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
  });
}

// Back to Hunter button
if (activatorBackBtn) {
  activatorBackBtn.addEventListener('click', () => {
    setAppMode('hunter');
    window.api.saveSettings({ appMode: 'hunter' });
  });
}

// CAT integration for activator mode — freq from VFO updates the input
window.api.onCatFrequency((hz) => {
  if (appMode !== 'activator') return;
  const khz = Math.round(hz / 1000);
  activatorFreqKhz = khz;
  // Only update the input if it's not focused (don't fight the user while typing)
  if (document.activeElement !== activatorFreqInput) {
    activatorFreqInput.value = (khz / 1000).toFixed(3);
  }
  updateActivatorBandLabel(khz);
});

window.api.onCatMode((mode) => {
  if (appMode !== 'activator') return;
  updateActivatorModeFromCat(mode);
});

/** Update the band label from a frequency in kHz */
function updateActivatorBandLabel(khz) {
  const bandStr = freqToBandActivator(khz);
  activatorBandLabel.textContent = bandStr || '--';
}

/** Map a CAT mode string to the activator mode selector */
function updateActivatorModeFromCat(mode) {
  const m = (mode || '').toUpperCase();
  if (m === 'USB' || m === 'LSB') activatorModeSelect.value = 'SSB';
  else if (m === 'CW' || m === 'CWR') activatorModeSelect.value = 'CW';
  else if (m === 'FM') activatorModeSelect.value = 'FM';
  else if (m === 'FT8') activatorModeSelect.value = 'FT8';
  else if (m === 'FT4') activatorModeSelect.value = 'FT4';
  else if (m === 'RTTY') activatorModeSelect.value = 'RTTY';
}

// Frequency input: Enter or blur → tune radio
if (activatorFreqInput) {
  activatorFreqInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      tuneActivatorFreq();
      activatorCallsignInput.focus();
    }
  });
  activatorFreqInput.addEventListener('blur', () => {
    tuneActivatorFreq();
  });
}

function tuneActivatorFreq() {
  const mhz = parseFloat(activatorFreqInput.value);
  if (!mhz || mhz <= 0) return;
  const khz = Math.round(mhz * 1000);
  if (khz === activatorFreqKhz) return; // already there
  activatorFreqKhz = khz;
  updateActivatorBandLabel(khz);
  window.api.tune(khz, activatorModeSelect.value);
}

// Mode selector change → tune radio to same freq with new mode
if (activatorModeSelect) {
  activatorModeSelect.addEventListener('change', () => {
    resetActivatorRst();
    const khz = activatorFreqKhz || radioFreqKhz;
    if (khz) {
      window.api.tune(khz, activatorModeSelect.value);
    }
  });
}

// QRZ lookup on callsign input (debounced)
let activatorQrzTimeout = null;
if (activatorCallsignInput) {
  activatorCallsignInput.addEventListener('input', () => {
    clearTimeout(activatorQrzTimeout);
    const val = activatorCallsignInput.value.trim().toUpperCase();
    if (val.length < 3) {
      activatorOpNameEl.textContent = '';
      return;
    }
    activatorQrzTimeout = setTimeout(async () => {
      const info = await window.api.qrzLookup(val);
      if (info && activatorCallsignInput.value.trim().toUpperCase() === val) {
        activatorOpNameEl.textContent = qrzDisplayName(info);
      }
    }, 400);
  });
}

/** Simple freq → band for activator. Input in kHz. */
function freqToBandActivator(khz) {
  if (khz >= 1800 && khz <= 2000) return '160m';
  if (khz >= 3500 && khz <= 4000) return '80m';
  if (khz >= 5330 && khz <= 5410) return '60m';
  if (khz >= 7000 && khz <= 7300) return '40m';
  if (khz >= 10100 && khz <= 10150) return '30m';
  if (khz >= 14000 && khz <= 14350) return '20m';
  if (khz >= 18068 && khz <= 18168) return '17m';
  if (khz >= 21000 && khz <= 21450) return '15m';
  if (khz >= 24890 && khz <= 24990) return '12m';
  if (khz >= 28000 && khz <= 29700) return '10m';
  if (khz >= 50000 && khz <= 54000) return '6m';
  if (khz >= 144000 && khz <= 148000) return '2m';
  return '';
}

// --- Multi-Park Dialog ---
let multiparkContext = null; // 'my' or 'hunter'
const multiparkDialog = document.getElementById('multipark-dialog');
const multiparkTitle = document.getElementById('multipark-title');
const multiparkSlots = document.getElementById('multipark-slots');
const multiparkAddBtn = document.getElementById('multipark-add');
const multiparkOkBtn = document.getElementById('multipark-ok');
const multiparkCancelBtn = document.getElementById('multipark-cancel');
const multiparkCloseBtn = document.getElementById('multipark-close');

function openMultiparkDialog(context) {
  multiparkContext = context; // 'my' or 'hunter'
  multiparkTitle.textContent = context === 'my' ? 'My Parks (MY_SIG_INFO)' : "Hunter's Parks (SIG_INFO)";
  const refs = context === 'my' ? activatorParkRefs : hunterParkRefs;
  multiparkSlots.innerHTML = '';
  // Populate existing slots
  if (refs.length === 0) {
    addMultiparkSlot('', '');
  } else {
    for (const p of refs) {
      addMultiparkSlot(p.ref, p.name);
    }
  }
  updateMultiparkAddBtn();
  multiparkDialog.showModal();
  // Focus first input
  const first = multiparkSlots.querySelector('.multipark-ref-input');
  if (first) first.focus();
}

function addMultiparkSlot(ref, name) {
  const slotCount = multiparkSlots.querySelectorAll('.multipark-slot').length;
  if (slotCount >= 3) return;
  const slot = document.createElement('div');
  slot.className = 'multipark-slot';
  slot.innerHTML = `
    <div class="multipark-slot-row">
      <input type="text" class="multipark-ref-input" placeholder="Park ref (e.g. K-1234)" maxlength="12" spellcheck="false" autocomplete="off" value="${ref || ''}">
      <button type="button" class="multipark-remove-btn" title="Remove">&times;</button>
    </div>
    <span class="multipark-name">${name || ''}</span>
    <div class="multipark-dropdown activator-dropdown hidden"></div>
  `;
  multiparkSlots.appendChild(slot);

  const input = slot.querySelector('.multipark-ref-input');
  const nameEl = slot.querySelector('.multipark-name');
  const dropdown = slot.querySelector('.multipark-dropdown');
  const removeBtn = slot.querySelector('.multipark-remove-btn');

  // Autocomplete
  let searchTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = input.value.trim();
    if (query.length < 2) { dropdown.classList.add('hidden'); nameEl.textContent = ''; return; }
    searchTimer = setTimeout(async () => {
      const results = await window.api.searchParks(query);
      if (!results || !results.length) { dropdown.classList.add('hidden'); return; }
      dropdown.innerHTML = '';
      for (const park of results) {
        const item = document.createElement('div');
        item.className = 'activator-dropdown-item';
        item.innerHTML = `<span class="activator-dropdown-ref">${park.reference}</span><span class="activator-dropdown-name">${park.name || ''}</span><span class="activator-dropdown-loc">${park.locationDesc || ''}</span>`;
        item.addEventListener('click', () => {
          input.value = park.reference;
          nameEl.textContent = park.name || '';
          dropdown.classList.add('hidden');
        });
        dropdown.appendChild(item);
      }
      dropdown.classList.remove('hidden');
    }, 150);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.add('hidden'), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = dropdown.querySelector('.activator-dropdown-item');
      if (first && !dropdown.classList.contains('hidden')) {
        first.click();
        e.preventDefault();
      }
    }
  });

  // Remove
  removeBtn.addEventListener('click', () => {
    slot.remove();
    updateMultiparkAddBtn();
    // Ensure at least one slot
    if (multiparkSlots.querySelectorAll('.multipark-slot').length === 0) {
      addMultiparkSlot('', '');
    }
  });

  updateMultiparkAddBtn();
}

function updateMultiparkAddBtn() {
  const slotCount = multiparkSlots.querySelectorAll('.multipark-slot').length;
  multiparkAddBtn.style.display = slotCount >= 3 ? 'none' : '';
}

if (multiparkAddBtn) {
  multiparkAddBtn.addEventListener('click', () => addMultiparkSlot('', ''));
}

if (multiparkOkBtn) {
  multiparkOkBtn.addEventListener('click', () => {
    const slots = multiparkSlots.querySelectorAll('.multipark-slot');
    const refs = [];
    for (const slot of slots) {
      const ref = slot.querySelector('.multipark-ref-input').value.trim().toUpperCase();
      const name = slot.querySelector('.multipark-name').textContent.trim();
      if (ref) refs.push({ ref, name });
    }
    if (multiparkContext === 'my') {
      if (refs.length === 0) { multiparkDialog.close(); return; }
      activatorParkRefs = refs;
      updateParkDisplay();
      activatorStartBtn.disabled = !primaryParkRef();
      window.api.saveSettings({ activatorParkRefs });
    } else {
      hunterParkRefs = refs;
      updateHunterParkDisplay();
    }
    multiparkDialog.close();
  });
}

if (multiparkCancelBtn) {
  multiparkCancelBtn.addEventListener('click', () => multiparkDialog.close());
}
if (multiparkCloseBtn) {
  multiparkCloseBtn.addEventListener('click', () => multiparkDialog.close());
}

// Click the +N badge to open multi-park dialog
const activatorParkExtraBadge = document.getElementById('activator-park-extra');
if (activatorParkExtraBadge) {
  activatorParkExtraBadge.addEventListener('click', () => openMultiparkDialog('my'));
}
const hunterParkExtraBadge = document.getElementById('activator-hunter-park-extra');
if (hunterParkExtraBadge) {
  hunterParkExtraBadge.addEventListener('click', () => openMultiparkDialog('hunter'));
}

// --- Hunter Park Autocomplete ---
const hunterParkInput = document.getElementById('activator-hunter-park');
const hunterParkDropdown = document.getElementById('activator-hunter-dropdown');
let hunterParkSearchTimeout = null;

if (hunterParkInput) {
  hunterParkInput.addEventListener('input', () => {
    clearTimeout(hunterParkSearchTimeout);
    const query = hunterParkInput.value.trim();
    if (query.length < 2) { hunterParkDropdown.classList.add('hidden'); hunterParkRefs = []; return; }
    hunterParkSearchTimeout = setTimeout(async () => {
      const results = await window.api.searchParks(query);
      if (!results || !results.length) { hunterParkDropdown.classList.add('hidden'); return; }
      hunterParkDropdown.innerHTML = '';
      for (const park of results) {
        const item = document.createElement('div');
        item.className = 'activator-dropdown-item';
        item.innerHTML = `<span class="activator-dropdown-ref">${park.reference}</span><span class="activator-dropdown-name">${park.name || ''}</span><span class="activator-dropdown-loc">${park.locationDesc || ''}</span>`;
        item.addEventListener('click', () => {
          hunterParkRefs = [{ ref: park.reference, name: park.name || '' }];
          hunterParkInput.value = park.reference;
          hunterParkDropdown.classList.add('hidden');
          updateHunterParkDisplay();
        });
        hunterParkDropdown.appendChild(item);
      }
      hunterParkDropdown.classList.remove('hidden');
    }, 150);
  });
  hunterParkInput.addEventListener('blur', () => {
    setTimeout(() => hunterParkDropdown.classList.add('hidden'), 200);
  });
  hunterParkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = hunterParkDropdown.querySelector('.activator-dropdown-item');
      if (first && !hunterParkDropdown.classList.contains('hidden')) {
        first.click();
        e.preventDefault();
      } else {
        // Enter in hunter park triggers log
        e.preventDefault();
        activatorLogContact();
      }
    }
  });
}

// Restore saved zoom level
(function restoreZoom() {
  const saved = parseFloat(localStorage.getItem('pota-cat-zoom'));
  if (saved && saved >= 0.6 && saved <= 2.0) window.api.setZoom(saved);
})();

// Init
loadPrefs().then(() => {
  render();
  checkFirstRun();
});
// Fetch active events on startup
window.api.getActiveEvents().then((events) => {
  console.log('[Events] loaded', events.length, 'events:', events.map(e => e.id));
  activeEvents = events;
  updateEventBanner();
  updateSpotsEventsSection();
  render();
}).catch(err => console.error('[Events] failed to load:', err));
applyColOrder();
initColumnResizing();
initColumnDragging();

// Sticky table header via JS transform on each th
// (CSS position:sticky and transform on <thead> are unreliable in Chromium table rendering)
(function initStickyHeader() {
  const ths = spotsTable.querySelectorAll('thead th');
  if (!ths.length) return;
  let ticking = false;
  tableScrollEl.addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(() => {
        const y = tableScrollEl.scrollTop;
        for (let i = 0; i < ths.length; i++) {
          ths[i].style.transform = `translateY(${y}px)`;
        }
        ticking = false;
      });
    }
  });
})();
