// Renderer process — UI logic
// Leaflet is loaded via <script> tag in index.html and exposes window.L

let allSpots = [];
let sortCol = 'distance';
let sortAsc = true;

// Expose for DevTools console debugging
window._debug = { get spots() { return allSpots; }, get qrz() { return qrzData; }, get expeditions() { return expeditionCallsigns; }, render() { render(); } };
let currentView = 'table'; // 'table', 'map', 'dxcc', 'rbn', or 'directory' (for exclusive views)
let showTable = true;
let showMap = false;
let splitOrientation = 'horizontal'; // 'horizontal' (side-by-side) or 'vertical' (stacked)
let enableSplitView = true; // allow Table+Map simultaneously

// User preferences (loaded from settings)
let distUnit = 'mi';    // 'mi' or 'km'
let watchlist = []; // parsed watchlist rules: [{ callsign, band, mode }]
let maxAgeMin = 5;       // max spot age in minutes
let sotaMaxAgeMin = 30;  // SOTA max spot age in minutes
let scanDwell = 7;       // seconds per frequency during scan
let enablePota = true;
let enableSota = false;
let enableWwff = false;
let enableLlota = false;
let enableDxcc = false;
let enableCluster = false;
let enableCwSpots = false;
let enableRbn = false;
let enablePskr = false;
let enablePskrMap = false;
let enableDxe = true;
let enableSolar = false;
let enableBandActivity = false;
let licenseClass = 'none';
let hideOutOfBand = false;
let showHiddenSpots = false;
// Hidden spots: { CALLSIGN: { "*": expiryMs, "14074": expiryMs, ... } }
// Legacy compat: bare number values are treated as { "*": expiry }
const HIDDEN_SPOTS_KEY = 'pota-cat-hidden-spots';
let hiddenSpots = {};
try { hiddenSpots = JSON.parse(localStorage.getItem(HIDDEN_SPOTS_KEY)) || {}; } catch { hiddenSpots = {}; }
// Migrate legacy format (bare number/Infinity → { "*": value })
for (const call of Object.keys(hiddenSpots)) {
  if (typeof hiddenSpots[call] === 'number' || hiddenSpots[call] === Infinity) {
    hiddenSpots[call] = { '*': hiddenSpots[call] };
  }
}
function saveHiddenSpots() { localStorage.setItem(HIDDEN_SPOTS_KEY, JSON.stringify(hiddenSpots)); }
function pruneHiddenSpots() {
  const now = Date.now();
  let changed = false;
  for (const call of Object.keys(hiddenSpots)) {
    const entry = hiddenSpots[call];
    for (const freq of Object.keys(entry)) {
      if (entry[freq] !== Infinity && entry[freq] < now) { delete entry[freq]; changed = true; }
    }
    if (Object.keys(entry).length === 0) { delete hiddenSpots[call]; changed = true; }
  }
  if (changed) saveHiddenSpots();
}
function isSpotHidden(callsign, freqStr) {
  const entry = hiddenSpots[callsign.toUpperCase()];
  if (!entry) return false;
  const now = Date.now();
  // Check all-freq hide
  const allExp = entry['*'];
  if (allExp === Infinity || (allExp && allExp > now)) return true;
  // Check frequency-specific hide
  if (freqStr) {
    const fKey = String(Math.round(parseFloat(freqStr)));
    const fExp = entry[fKey];
    if (fExp === Infinity || (fExp && fExp > now)) return true;
  }
  return false;
}
function hideSpotEntry(callsign, freqKey, expiry) {
  const call = callsign.toUpperCase();
  if (!hiddenSpots[call]) hiddenSpots[call] = {};
  hiddenSpots[call][freqKey] = expiry;
  saveHiddenSpots();
}
function unhideSpot(callsign) {
  delete hiddenSpots[callsign.toUpperCase()];
  saveHiddenSpots();
}
function hiddenSpotCount() {
  pruneHiddenSpots();
  return Object.keys(hiddenSpots).length;
}
// Prune expired entries every 60s
setInterval(pruneHiddenSpots, 60000);
let enableLogging = false;
let enableBannerLogger = false;
let n1mmRst = false; // N1MM-style single-field RST inputs
let defaultPower = 100;
let tuneClick = false;
let enableSplit = false;
let activeRigName = ''; // name of the currently active rig profile
let workedQsos = new Map(); // callsign → [{date, ref}] from QSO log
let donorCallsigns = new Set(); // supporter callsigns from potacat.com
let expeditionCallsigns = new Set(); // active DX expeditions from Club Log + danplanet
let expeditionMeta = new Map(); // callsign → { entity, startDate, endDate, description }
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
let spotsPopoutOpen = false; // pop-out spots window is open
let actmapPopoutOpen = false; // pop-out activation map window is open
let clusterPopoutOpen = false; // pop-out cluster terminal is open
let jtcatPopoutOpen = false; // pop-out JTCAT window is open
let dxccData = null;  // { entities: [...] } from main process
let enableWsjtx = false;
let wsjtxDecodes = []; // recent decodes from WSJT-X (FIFO, max 50)
let wsjtxState = null; // last WSJT-X status (freq, mode, etc.)
const qrzData = new Map(); // callsign → { fname, name, addr2, state, country }
let qrzFullName = false; // show first+last or just first

// --- Activator Mode State ---
let appMode = 'hunter'; // 'hunter' or 'activator'
let activatorParkRefs = [];   // [{ref:'K-1234', name:'Cedar Falls SP'}, ...]  max 3
let activatorCrossRefs = [];  // [{program:'WWFF', ref:'KFF-1234'}, {program:'LLOTA', ref:'US-0001'}]
let activatorParkGrid = '';   // Maidenhead grid for active park (auto from lat/lon, user-editable)
let hunterParkRefs = [];      // [{ref:'K-5678', name:'Shenandoah NF'}]  max 3, resets per QSO
let activatorContacts = []; // in-memory QSO list for current activation session
let activatorFreqKhz = 0;  // from CAT
let activationActive = false; // true while activation is running
let activationStartTime = 0;  // Date.now() when activation started
let activationTimerInterval = null;
let activatorSpotsVisible = false; // show hunter spot table below activator view

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
const spotsCwSpots = document.getElementById('spots-cwspots');
const spotsRbn = document.getElementById('spots-rbn');
const spotsPskr = document.getElementById('spots-pskr');
const spotsDxe = document.getElementById('spots-dxe');
const spotsHideWorked = document.getElementById('spots-hide-worked');
const spotsHideParks = document.getElementById('spots-hide-parks');
const spotsHideParksLabel = document.getElementById('spots-hide-parks-label');
const spotsHideOob = document.getElementById('spots-hide-oob');
const spotsShowHidden = document.getElementById('spots-show-hidden');
const spotsHiddenCount = document.getElementById('spots-hidden-count');
const spotsDxcc = document.getElementById('spots-dxcc');
const settingsBtn = document.getElementById('settings-btn');
const logbookBtn = document.getElementById('logbook-btn');
const settingsDialog = document.getElementById('settings-dialog');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');
const setGrid = document.getElementById('set-grid');
const setDistUnit = document.getElementById('set-dist-unit');
const setMaxAge = document.getElementById('set-max-age');
const setSotaMaxAge = document.getElementById('set-sota-max-age');
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
const setEnableAtu = document.getElementById('set-enable-atu');
const setEnableRotor = document.getElementById('set-enable-rotor');
const rotorConfig = document.getElementById('rotor-config');
const setRotorMode = document.getElementById('set-rotor-mode');
const setRotorHost = document.getElementById('set-rotor-host');
const setRotorPort = document.getElementById('set-rotor-port');
const setEnableAg = document.getElementById('set-enable-ag');
const agConfig = document.getElementById('ag-config');
const setAgHost = document.getElementById('set-ag-host');
const setAgRadioPort = document.getElementById('set-ag-radio-port');
const agBandMapEl = document.getElementById('ag-band-map');
const agStatusEl = document.getElementById('ag-status');
const setVerboseLog = document.getElementById('set-verbose-log');
const setLightIcon = document.getElementById('set-light-icon');
const setEnableSplitView = document.getElementById('set-enable-split-view');
const splitOrientationConfig = document.getElementById('split-orientation-config');
const continentFilterEl = document.getElementById('continent-filter');
const scanBtn = document.getElementById('scan-btn');
const hamlibConfig = document.getElementById('hamlib-config');
const flexConfig = document.getElementById('flex-config');
const tcpcatConfig = document.getElementById('tcpcat-config');
const serialcatConfig = document.getElementById('serialcat-config');
const icomConfig = document.getElementById('icom-config');
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
const rigModelSelect = document.getElementById('set-rig-model-select');
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
const setEnableCwSpots = document.getElementById('set-enable-cwspots');
const setEnableRbn = document.getElementById('set-enable-rbn');
const setEnableWsjtx = document.getElementById('set-enable-wsjtx');
const wsjtxConfig = document.getElementById('wsjtx-config');
const setWsjtxPort = document.getElementById('set-wsjtx-port');
const setWsjtxHighlight = document.getElementById('set-wsjtx-highlight');
const setWsjtxAutoLog = document.getElementById('set-wsjtx-auto-log');
const wsjtxStatusEl = document.getElementById('wsjtx-status');
const setEnablePskr = document.getElementById('set-enable-pskr');
const pskrConfig = document.getElementById('pskr-config');
const setEnablePskrMap = document.getElementById('set-enable-pskr-map');
const pskrMapConfig = document.getElementById('pskr-map-config');
const connPskrMap = document.getElementById('conn-pskr-map');
const setMyCallsign = document.getElementById('set-my-callsign');
const setEnableClusterTerminal = document.getElementById('set-enable-cluster-terminal');
const clusterTerminalBtn = document.getElementById('cluster-terminal-btn');
const clusterConfig = document.getElementById('cluster-config');
const clusterNodeList = document.getElementById('cluster-node-list');
const clusterPresetSelect = document.getElementById('cluster-preset-select');
const clusterAddBtn = document.getElementById('cluster-add-btn');
const clusterCustomFields = document.getElementById('cluster-custom-fields');
const netReminderList = document.getElementById('net-reminder-list');
const netAddBtn = document.getElementById('net-add-btn');
const netEditor = document.getElementById('net-editor');
const netEditorTitle = document.getElementById('net-editor-title');
const setNetName = document.getElementById('set-net-name');
const setNetFreq = document.getElementById('set-net-freq');
const setNetMode = document.getElementById('set-net-mode');
const setNetTime = document.getElementById('set-net-time');
const setNetTz = document.getElementById('set-net-tz');
const setNetDuration = document.getElementById('set-net-duration');
const setNetLead = document.getElementById('set-net-lead');
const netWeeklyDays = document.getElementById('net-weekly-days');
const netSpecificDates = document.getElementById('net-specific-dates');
const setNetDates = document.getElementById('set-net-dates');
const netSaveBtn = document.getElementById('net-save-btn');
const netCancelBtn = document.getElementById('net-cancel-btn');
const setShowBeacons = document.getElementById('set-show-beacons');
const setShowDxBar = document.getElementById('set-show-dx-bar');
const rbnConfig = document.getElementById('rbn-config');
// Settings connection pills
const connBar = document.getElementById('settings-conn-status');
const connCluster = document.getElementById('conn-cluster');
const connRbn = document.getElementById('conn-rbn');
const connPskr = document.getElementById('conn-pskr');
const connRemote = document.getElementById('conn-remote');
let clusterConnected = false;
let enableRemote = false;
let remoteConnected = false;
let clusterNodeStatuses = []; // [{id, name, host, connected}, ...]
let currentClusterNodes = []; // live node list for settings UI
let currentNetReminders = []; // live net list for settings UI

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
const CW_SPOTS_PRESETS = [
  { name: 'CW Club Spotter (all clubs)', host: 'rbn.telegraphy.de', port: 7000 },
  { name: 'FOC Members', host: 'foc.dj1yfk.de', port: 7300 },
  { name: 'FOC + Nominees', host: 'foc.dj1yfk.de', port: 7373 },
];
let rbnConnected = false;
let pskrConnected = false;
let pskrMapConnected = false;
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
// Directory browser (inside Settings > Net Reminders)
const setEnableDirectory = document.getElementById('set-enable-directory');
const dirControls = document.getElementById('dir-controls');
const dirBrowseBtn = document.getElementById('dir-browse-btn');
const dirBrowser = document.getElementById('dir-browser');
const dirCloseBtn = document.getElementById('dir-close-btn');
const dirTabNets = document.getElementById('dir-tab-nets');
const dirTabSwl = document.getElementById('dir-tab-swl');
const dirSearchInput = document.getElementById('dir-search');
const dirRefreshBtn = document.getElementById('dir-refresh-btn');
const dirNetsContainer = document.getElementById('dir-nets-container');
const dirSwlContainer = document.getElementById('dir-swl-container');
const dirNetsBody = document.getElementById('dir-nets-body');
const dirSwlBody = document.getElementById('dir-swl-body');
const dirPlaceholder = document.getElementById('dir-placeholder');
const dirHoverPopup = document.getElementById('dir-hover-popup');
const dirSuggestSheet = document.getElementById('dir-suggest-sheet');
const DIR_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1fg6ZX9DokyThbvHO4VXKcKhKsscy7RYidmERrOB1inc/edit?usp=sharing';
let directoryNets = [];
let directorySwl = [];
let dirActiveTab = 'nets'; // 'nets' or 'swl'
// Directory View (top-level)
const viewDirectoryBtn = document.getElementById('view-directory-btn');
const directoryView = document.getElementById('directory-view');
const dirvTabNets = document.getElementById('dirv-tab-nets');
const dirvTabSwl = document.getElementById('dirv-tab-swl');
const dirvSearch = document.getElementById('dirv-search');
const dirvBandFilter = document.getElementById('dirv-band-filter');
const dirvStatusFilter = document.getElementById('dirv-status-filter');
const dirvRefreshBtn = document.getElementById('dirv-refresh-btn');
const dirvCount = document.getElementById('dirv-count');
const dirvNetsContainer = document.getElementById('dirv-nets-container');
const dirvSwlContainer = document.getElementById('dirv-swl-container');
const dirvNetsBody = document.getElementById('dirv-nets-body');
const dirvSwlBody = document.getElementById('dirv-swl-body');
const dirvPlaceholder = document.getElementById('dirv-placeholder');
const dirvSuggestSheet = document.getElementById('dirv-suggest-sheet');
let dirvActiveTab = 'nets';
let dirvAutoRefreshTimer = null;
const rbnMaxAgeInput = document.getElementById('rbn-max-age');
const rbnAgeUnitSelect = document.getElementById('rbn-age-unit');
// Propagation view source toggles and mode filter
const propShowRbnEl = document.getElementById('prop-show-rbn');
const propShowPskrEl = document.getElementById('prop-show-pskr');
const propModeFilterEl = document.getElementById('prop-mode-filter');

// JTCAT DOM refs
const viewJtcatBtn = document.getElementById('view-jtcat-btn');
const jtcatView = document.getElementById('jtcat-view');
const jtcatModeSelect = document.getElementById('jtcat-mode');
const jtcatCycleIndicator = document.getElementById('jtcat-cycle-indicator');
const jtcatCountdown = document.getElementById('jtcat-countdown');
const jtcatSyncStatus = document.getElementById('jtcat-sync-status');
const jtcatWaterfall = document.getElementById('jtcat-waterfall');
const jtcatTxFreqLabel = document.getElementById('jtcat-tx-freq-label');
const jtcatBandActivity = document.getElementById('jtcat-band-activity');
const jtcatRxActivity = document.getElementById('jtcat-rx-activity');
const jtcatRxFreqLabel = document.getElementById('jtcat-rx-freq-label');
const jtcatTxFreqInput = document.getElementById('jtcat-tx-freq');
const jtcatRxFreqInput = document.getElementById('jtcat-rx-freq');
const jtcatEnableTxBtn = document.getElementById('jtcat-enable-tx');
const jtcatHaltTxBtn = document.getElementById('jtcat-halt-tx');
const jtcatLogQsoBtn = document.getElementById('jtcat-log-qso');
const jtcatTxMsgText = document.getElementById('jtcat-tx-msg-text');
const jtcatTxSlotSelect = document.getElementById('jtcat-tx-slot');
const jtcatCallCqBtn = document.getElementById('jtcat-call-cq');
const jtcatQsoTracker = document.getElementById('jtcat-qso-tracker');
const jtcatQsoLabel = document.getElementById('jtcat-qso-label');
const jtcatQsoSteps = document.getElementById('jtcat-qso-steps');
const jtcatQsoCancelBtn = document.getElementById('jtcat-qso-cancel');
const jtcatQsoSkipBtn = document.getElementById('jtcat-qso-skip');
const jtcatCqFilterBtn = document.getElementById('jtcat-cq-filter');
const jtcatSliceSelect = document.getElementById('jtcat-slice');
const jtcatSliceContainer = document.getElementById('jtcat-slice-select');
let jtcatRunning = false;
let jtcatCountdownTimer = null;
let jtcatDecodes = []; // current cycle's decodes (for QSO state machine)
let jtcatDecodeLog = []; // accumulated decode history: [{cycle, time, slot, results}]
let jtcatRxFreq = 1500;
let jtcatTxFreq = 1500;
let jtcatCurrentBand = '20m';
let jtcatCqFilter = false;
// QSO state machine
let jtcatQso = null; // { call, grid, phase, txMsg, report, rrReport, txRetries }
// phase: 'reply' → 'report' → 'r+report' → '73' → 'done'
var JTCAT_MAX_CQ_RETRIES = 15;   // ~3.75 min of CQ on FT8 before giving up
var JTCAT_MAX_QSO_RETRIES = 6;   // per-phase retry limit during QSO exchange
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
const setSotaUpload = document.getElementById('set-sota-upload');
const sotaUploadConfig = document.getElementById('sota-upload-config');
const setSotaUsername = document.getElementById('set-sota-username');
const setSotaPassword = document.getElementById('set-sota-password');
const distHeader = document.getElementById('dist-header');
const utcClockEl = document.getElementById('utc-clock');
const sfiStatusEl = document.getElementById('sfi-status');
const kStatusEl = document.getElementById('k-status');
const aStatusEl = document.getElementById('a-status');
const setColorblind = document.getElementById('set-colorblind');
const setWcagMode = document.getElementById('set-wcag-mode');
const setColorRows = document.getElementById('set-color-rows');
const setEnableSolar = document.getElementById('set-enable-solar');
const setEnableBandActivity = document.getElementById('set-enable-band-activity');
const setShowBearing = document.getElementById('set-show-bearing');
const setEnableLogging = document.getElementById('set-enable-logging');
const setEnableBannerLogger = document.getElementById('set-enable-banner-logger');
const setN1mmRst = document.getElementById('set-n1mm-rst');
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
const logbookWavelogConfig = document.getElementById('logbook-wavelog-config');
const setWavelogUrl = document.getElementById('set-wavelog-url');
const setWavelogApiKey = document.getElementById('set-wavelog-api-key');
const setWavelogStationId = document.getElementById('set-wavelog-station-id');
const setDisableAutoUpdate = document.getElementById('set-disable-auto-update');
const setEnableTelemetry = document.getElementById('set-enable-telemetry');
const setLightMode = document.getElementById('set-light-mode');
setLightMode.addEventListener('change', () => applyTheme(setLightMode.checked));
const setEnableQrz = document.getElementById('set-enable-qrz');
const qrzConfig = document.getElementById('qrz-config');
const setQrzUsername = document.getElementById('set-qrz-username');
const setQrzPassword = document.getElementById('set-qrz-password');
const setQrzFullName = document.getElementById('set-qrz-full-name');
const qrzLogbookSection = document.getElementById('qrz-logbook-section');
const qrzSubStatus = document.getElementById('qrz-sub-status');
const qrzRecheckBtn = document.getElementById('qrz-recheck-btn');
const setQrzLogbook = document.getElementById('set-qrz-logbook');
const qrzLogbookConfig = document.getElementById('qrz-logbook-config');
const setQrzApiKey = document.getElementById('set-qrz-api-key');
const qrzApiStatus = document.getElementById('qrz-api-status');
const setSmartSdrSpots = document.getElementById('set-smartsdr-spots');
const smartSdrConfig = document.getElementById('smartsdr-config');
const setSmartSdrHost = document.getElementById('set-smartsdr-host');
const setSmartSdrMaxAge = document.getElementById('set-smartsdr-max-age');
const setSmartSdrMaxSpots = document.getElementById('set-smartsdr-max-spots');
const setTciSpots = document.getElementById('set-tci-spots');
const tciConfig = document.getElementById('tci-config');
const setTciHost = document.getElementById('set-tci-host');
const setTciPort = document.getElementById('set-tci-port');
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
// ECHOCAT
const setEnableRemote = document.getElementById('set-enable-remote');
const remoteConfig = document.getElementById('remote-config');
const setRemotePort = document.getElementById('set-remote-port');
const setRemoteRequireToken = document.getElementById('set-remote-require-token');
const remoteTokenRow = document.getElementById('remote-token-row');
const setRemoteToken = document.getElementById('set-remote-token');
const remoteRegenToken = document.getElementById('remote-regen-token');
const rigRemoteAudioInput = document.getElementById('rig-remote-audio-input');
const rigRemoteAudioOutput = document.getElementById('rig-remote-audio-output');
const remoteAudioSummary = document.getElementById('remote-audio-summary');
const setRemotePttTimeout = document.getElementById('set-remote-ptt-timeout');
const setRemoteCwEnabled = document.getElementById('set-remote-cw-enabled');
const setCwKeyPort = document.getElementById('set-cw-key-port');
const remoteUrlDisplay = document.getElementById('remote-url-display');
const remoteTxIndicator = document.getElementById('remote-tx-indicator');
const jtcatTxIndicator = document.getElementById('jtcat-tx-indicator');
// Club Station Mode
const setClubMode = document.getElementById('set-club-mode');
const clubConfig = document.getElementById('club-config');
const setClubCsvPath = document.getElementById('set-club-csv-path');
const clubCsvBrowse = document.getElementById('club-csv-browse');
const clubHashPasswords = document.getElementById('club-hash-passwords');
const clubCsvCreate = document.getElementById('club-csv-create');
const clubHashStatus = document.getElementById('club-hash-status');
const clubPreview = document.getElementById('club-preview');
const clubSchedule = document.getElementById('club-schedule');
const logDialog = document.getElementById('log-dialog');
const logCallsign = document.getElementById('log-callsign');
const logOpName = document.getElementById('log-op-name');
const logFrequency = document.getElementById('log-frequency');
const logMode = document.getElementById('log-mode');
const logDate = document.getElementById('log-date');
const logTime = document.getElementById('log-time');
const logPower = document.getElementById('log-power');
// RST helpers — support both split-digit and N1MM single-field modes
// Logical IDs map to DOM element IDs for each mode
const RST_ID_MAP = {
  'rst-sent-digits':    { split: 'rst-sent-split',           n1mm: 'rst-sent-n1mm' },
  'rst-rcvd-digits':    { split: 'rst-rcvd-split',           n1mm: 'rst-rcvd-n1mm' },
  'activator-rst-sent': { split: 'activator-rst-sent-digits', n1mm: 'activator-rst-sent' },
  'activator-rst-rcvd': { split: 'activator-rst-rcvd-digits', n1mm: 'activator-rst-rcvd' },
};

function setRstDigits(id, value) {
  const map = RST_ID_MAP[id];
  if (!map) return;
  const v = String(value);
  // Set split-digit container
  const splitEl = document.getElementById(map.split);
  if (splitEl) {
    const digits = splitEl.querySelectorAll('.rst-digit');
    const chars = v.split('');
    if (digits[0]) digits[0].value = chars[0] || '';
    if (digits[1]) digits[1].value = chars[1] || '';
    if (digits[2]) digits[2].value = chars[2] || '';
  }
  // Set N1MM single input
  const n1mmEl = document.getElementById(map.n1mm);
  if (n1mmEl) n1mmEl.value = v;
}

function getRstDigits(id, fallback) {
  const map = RST_ID_MAP[id];
  if (!map) return fallback;
  if (n1mmRst) {
    // N1MM mode uses split-digit boxes
    const splitEl = document.getElementById(map.split);
    if (splitEl) {
      const digits = splitEl.querySelectorAll('.rst-digit');
      const val = Array.from(digits).map(d => d.value).join('');
      return val || fallback;
    }
  } else {
    // Default uses single text field
    const el = document.getElementById(map.n1mm);
    return (el && el.value) || fallback;
  }
  return fallback;
}

function applyRstMode() {
  // n1mmRst=true → show split-digit boxes, hide single fields
  // n1mmRst=false (default) → show single fields, hide split-digit boxes
  document.querySelectorAll('.rst-split-mode').forEach(el => el.classList.toggle('hidden', !n1mmRst));
  document.querySelectorAll('.rst-n1mm-mode').forEach(el => el.classList.toggle('hidden', n1mmRst));
}
const logTypePicker = document.getElementById('log-type-picker');
const logRefInputSection = document.getElementById('log-ref-input-section');
const logRefInput = document.getElementById('log-ref-input');
const logRefName = document.getElementById('log-ref-name');
let logSelectedType = '';
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

let _catPopoverAnchor = catStatusEl; // which element the popover is anchored to

function positionCatPopover() {
  const anchor = _catPopoverAnchor || catStatusEl;
  const rect = anchor.getBoundingClientRect();
  catPopover.style.top = (rect.bottom + 4) + 'px';
  // Align right edge to anchor right, clamped to viewport
  catPopover.style.left = '';
  catPopover.style.right = '';
  const popW = catPopover.offsetWidth || 220;
  let left = rect.right - popW;
  if (left < 0) left = 0;
  if (left + popW > window.innerWidth) left = window.innerWidth - popW;
  catPopover.style.left = left + 'px';
}

async function openCatPopover(anchor) {
  if (anchor) _catPopoverAnchor = anchor;
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
      await window.api.saveSettings({
        activeRigId: rig.id,
        catTarget: rig.catTarget,
        remoteAudioInput: rig.remoteAudioInput || '',
        remoteAudioOutput: rig.remoteAudioOutput || '',
        cwKeyPort: rig.cwKeyPort || '',
      });
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
    if (typeof closeRigPopover === 'function') closeRigPopover();
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
  if (catPopoverOpen && !catPopover.contains(e.target) && e.target !== catStatusEl && e.target !== document.getElementById('activator-cat-status')) {
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
// Parse watchlist string into array of { callsign, band, mode } rules.
// Format: "K3SBP, K4SWL:20m, KI6NAZ:CW, W1AW:40m:SSB"
const WATCH_BANDS = new Set(['160m','80m','60m','40m','30m','20m','17m','15m','12m','10m','6m','4m','2m','70cm']);
function parseWatchlist(str) {
  if (!str) return [];
  const rules = [];
  for (const entry of str.split(',')) {
    const parts = entry.trim().toUpperCase().split(':').map(p => p.trim());
    if (!parts[0]) continue;
    const rule = { callsign: parts[0], band: null, mode: null };
    for (let i = 1; i < parts.length; i++) {
      if (WATCH_BANDS.has(parts[i].toLowerCase())) rule.band = parts[i].toLowerCase();
      else if (parts[i]) rule.mode = parts[i];
    }
    rules.push(rule);
  }
  return rules;
}

function watchlistMatch(rules, callsign, band, mode) {
  const cs = (callsign || '').toUpperCase();
  const b = (band || '').toLowerCase();
  const m = (mode || '').toUpperCase();
  for (const r of rules) {
    if (r.callsign !== cs) continue;
    if (r.band && r.band !== b) continue;
    if (r.mode && r.mode !== m) continue;
    return true;
  }
  return false;
}

function watchlistHasCallsign(rules, callsign) {
  const cs = (callsign || '').toUpperCase();
  for (const r of rules) {
    if (r.callsign === cs) return true;
  }
  return false;
}

function applyTheme(light) {
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
}

async function loadPrefs() {
  const settings = await window.api.getSettings();
  if (settings.appVersion) {
    window._appVersion = settings.appVersion;
    updateTitleBar();
    const verLabel = document.getElementById('settings-version-label');
    if (verLabel) verLabel.textContent = 'v' + settings.appVersion;
  }
  applyTheme(settings.lightMode === true);
  applyColorblindMode(settings.colorblindMode === true);
  applyWcagMode(settings.wcagMode === true);
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
  enableCwSpots = settings.enableCwSpots === true; // default false
  showDxBar = settings.showDxBar === true;
  dxCommandPreferredNode = localStorage.getItem('dx-command-node') || '';
  updateDxCommandBar();
  enableRbn = settings.enableRbn === true; // default false
  enablePskr = settings.enablePskr === true; // default false
  enablePskrMap = settings.enablePskrMap === true; // default false
  enableDxe = settings.enableDxe !== false; // default true
  enableSolar = settings.enableSolar === true;   // default false
  // PSTRotator — show quick-toggle when rotor is configured
  rotorConfigured = !!settings.enableRotor;
  quickRotor.checked = settings.rotorActive !== false; // defaults true when configured
  quickRotorLabel.classList.toggle('hidden', !rotorConfigured);
  quickRotorDivider.classList.toggle('hidden', !rotorConfigured);
  // Color rows — default true (on)
  spotsTable.classList.toggle('no-source-tint', settings.colorRows === false);
  enableBandActivity = settings.enableBandActivity === true; // default false
  updateSolarVisibility();
  qrzFullName = settings.qrzFullName === true;
  enableLogging = settings.enableLogging === true;
  enableBannerLogger = settings.enableBannerLogger === true;
  // Sync custom CAT buttons from settings.json (authoritative source for ECHOCAT sync)
  if (settings.customCatButtons && Array.isArray(settings.customCatButtons)) {
    customCatButtons = settings.customCatButtons;
    while (customCatButtons.length < 5) customCatButtons.push({ name: '', command: '' });
    localStorage.setItem('custom-cat-buttons', JSON.stringify(customCatButtons));
    if (typeof loadCustomButtons === 'function') loadCustomButtons();
  }
  n1mmRst = settings.n1mmRst === true;
  applyRstMode();
  defaultPower = parseInt(settings.defaultPower, 10) || 100;
  updateLoggingVisibility();
  updateBannerLoggerVisibility();
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
  // CW Keyer: init MIDI + connect saved device on load (requires pi access)
  if (settings.enableCwKeyer) {
    cwKeyerStatusEl.classList.remove('hidden');
    populateMidiDevices().then(() => {
      if (settings.cwMidiDevice) connectMidiDevice(settings.cwMidiDevice);
    });
  }
  // JTCAT Flex slice setting
  if (settings.jtcatFlexSlice) jtcatSliceSelect.value = settings.jtcatFlexSlice;
  // Show slice selector if active rig is Flex
  var isFlex = activeRig && activeRig.catTarget && activeRig.catTarget.type === 'tcp' &&
    [5002, 5003, 5004, 5005].includes(activeRig.catTarget.port);
  jtcatSliceContainer.classList.toggle('hidden', !isFlex);
  updateRbnButton();
  clusterTerminalBtn.classList.toggle('hidden', !settings.enableClusterTerminal);
  updateDxccButton();
  // Pi access — JTCAT button visibility on startup
  if (jtcatBtn) jtcatBtn.classList.remove('hidden');
  // Activator mode restore
  if (settings.appMode === 'activator') {
    appMode = 'activator';
    // Restore activator parks — migrate from legacy single string to array
    if (settings.activatorParkRefs && Array.isArray(settings.activatorParkRefs) && settings.activatorParkRefs.length) {
      activatorParkRefs = settings.activatorParkRefs;
      activatorParkRefInput.value = primaryParkRef();
      activatorParkNameEl.textContent = primaryParkName();
      updateParkExtraBadge();
      // Restore cross-program references
      if (settings.activatorCrossRefs && Array.isArray(settings.activatorCrossRefs)) {
        activatorCrossRefs = settings.activatorCrossRefs;
        if (crossRefWwff) for (const xr of activatorCrossRefs) { if (xr.program === 'WWFF') crossRefWwff.value = xr.ref; }
        if (crossRefLlota) for (const xr of activatorCrossRefs) { if (xr.program === 'LLOTA') crossRefLlota.value = xr.ref; }
        updateCrossRefToggle();
      }
      // Resolve names and grid if missing
      for (const p of activatorParkRefs) {
        if (!p.name) {
          window.api.getPark(p.ref).then(park => {
            if (park) { p.name = park.name || ''; updateParkDisplay(); }
          });
        }
      }
      // Auto-populate grid from primary park
      if (activatorParkRefs.length > 0) {
        window.api.getPark(activatorParkRefs[0].ref).then(park => {
          if (park && park.latitude && park.longitude) {
            activatorParkGrid = latLonToGridLocal(parseFloat(park.latitude), parseFloat(park.longitude));
            const gi = document.getElementById('activator-grid');
            if (gi) gi.value = activatorParkGrid;
          }
        });
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
  sotaMaxAgeMin = parseInt(settings.sotaMaxAge, 10) || 30;
  updateHeaders();

  // Restore view state
  splitOrientation = settings.splitOrientation || 'horizontal';
  enableSplitView = settings.enableSplitView !== false;
  try {
    const viewState = JSON.parse(localStorage.getItem(VIEW_STATE_KEY));
    if (viewState) {
      if (viewState.sortCol) { sortCol = viewState.sortCol; }
      if (typeof viewState.sortAsc === 'boolean') { sortAsc = viewState.sortAsc; }
      if (viewState.lastView === 'jtcat') {
        // JTCAT is always a pop-out now; restore to default table view
        setView('table');
        window.api.jtcatPopoutOpen();
      } else
      if (viewState.lastView === 'rbn' && (enableRbn || enablePskrMap)) {
        setView('rbn');
      } else if (viewState.lastView === 'dxcc' && enableDxcc) {
        setView('dxcc');
      } else if (viewState.lastView === 'directory' && settings.enableDirectory) {
        setView('directory');
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
  icomConfig.classList.toggle('hidden', type !== 'icom');
  hamlibConfig.classList.toggle('hidden', type !== 'hamlib');
  rigctldnetConfig.classList.toggle('hidden', type !== 'rigctldnet');
  if (type === 'serialcat' && !serialcatPortsLoaded) {
    loadSerialcatPorts();
  }
  if (type === 'icom' && !icomPortsLoaded) {
    loadIcomPorts();
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
  } else if (currentTarget.type === 'icom') {
    setRadioType('icom');
    icomPortsLoaded = true;
    await loadIcomPorts(currentTarget);
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
    opt.textContent = allRigOptions.length === 0 ? 'No rigs found — install Hamlib (Linux: sudo apt install libhamlib-utils)' : 'No matches';
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

let icomPortsLoaded = false;

function getEffectiveIcomPort() {
  const manual = document.getElementById('set-icom-port-manual').value.trim();
  return manual || document.getElementById('set-icom-port').value;
}

async function loadIcomPorts(savedTarget) {
  const ports = await window.api.listPorts();
  const portSelect = document.getElementById('set-icom-port');
  const portManual = document.getElementById('set-icom-port-manual');
  portSelect.innerHTML = '';
  portManual.value = '';
  const detectedPaths = new Set();
  for (const p of ports) {
    detectedPaths.add(p.path);
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = `${p.path} — ${p.friendlyName}`;
    if (savedTarget && savedTarget.path === p.path) opt.selected = true;
    portSelect.appendChild(opt);
  }
  if (savedTarget && savedTarget.path && !detectedPaths.has(savedTarget.path)) {
    portManual.value = savedTarget.path;
  }
  if (savedTarget && savedTarget.baudRate) {
    document.getElementById('set-icom-baud').value = String(savedTarget.baudRate);
  }
  if (savedTarget && savedTarget.civAddress) {
    const modelSelect = document.getElementById('set-icom-model');
    const addrHex = '0x' + savedTarget.civAddress.toString(16).toUpperCase();
    for (const opt of modelSelect.options) {
      if (opt.value.toUpperCase() === addrHex.toUpperCase()) { opt.selected = true; break; }
    }
  }
  icomPortsLoaded = true;
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
let rigModelData = []; // populated from main process on first use

async function populateRigModelDropdown() {
  if (!rigModelSelect) return;
  if (rigModelData.length > 0) return;
  try { rigModelData = await window.api.getRigModels(); } catch { return; }
  while (rigModelSelect.options.length > 1) rigModelSelect.remove(1);
  for (const group of rigModelData) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.brand;
    for (const name of group.models) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      optgroup.appendChild(opt);
    }
    rigModelSelect.appendChild(optgroup);
  }
}

if (rigModelSelect) rigModelSelect.addEventListener('change', () => {
  const modelName = rigModelSelect.value;
  if (!modelName) return;
  let brand = null;
  for (const group of rigModelData) {
    if (group.models.includes(modelName)) { brand = group.brand; break; }
  }
  if (!brand) return;
  if (brand === 'FlexRadio') setRadioType('flex');
  else if (brand === 'Icom') setRadioType('icom');
  else setRadioType('serialcat');
  updateRadioSubPanels();
  if (!setRigName.value.trim()) setRigName.value = modelName;
});

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
  if (target.type === 'icom') {
    return `${target.civModel || 'Icom'} CI-V on ${target.path || '?'} @ ${target.baudRate || 115200}`;
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
    descEl.textContent = (rig.model ? rig.model + ' \u2014 ' : '') + describeRigTarget(rig.catTarget);
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
  } else if (radioType === 'icom') {
    const modelSelect = document.getElementById('set-icom-model');
    return {
      type: 'icom',
      path: getEffectiveIcomPort(),
      baudRate: parseInt(document.getElementById('set-icom-baud').value, 10) || 115200,
      civAddress: parseInt(modelSelect.value, 16),
      civModel: modelSelect.options[modelSelect.selectedIndex].text,
    };
  } else if (radioType === 'hamlib') {
    return {
      type: 'rigctld',
      rigId: parseInt(setRigModel.value, 10),
      serialPort: getEffectivePort(),
      baudRate: parseInt(setRigBaud.value, 10) || 9600,
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
  icomPortsLoaded = false;

  await populateRigModelDropdown();

  if (mode === 'edit') {
    rigEditorTitle.textContent = 'Edit Rig';
    const rig = currentRigs.find(r => r.id === rigId);
    if (rig) {
      setRigName.value = rig.name || '';
      if (rigModelSelect) rigModelSelect.value = rig.model || '';
      await populateRadioSection(rig.catTarget);
      await populateRigAudioDevices(rig.remoteAudioInput, rig.remoteAudioOutput);
      // Restore per-rig CW key port
      if (setCwKeyPort && rig.cwKeyPort) setCwKeyPort.value = rig.cwKeyPort;
    }
  } else {
    rigEditorTitle.textContent = 'Add Rig';
    setRigName.value = '';
    if (rigModelSelect) rigModelSelect.value = '';
    setRadioType('flex');
    updateRadioSubPanels();
    await populateRigAudioDevices('', '');
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
  const model = rigModelSelect ? rigModelSelect.value || null : null;

  const rigAudioIn = rigRemoteAudioInput.value || '';
  const rigAudioOut = rigRemoteAudioOutput.value || '';
  const rigCwKeyPortVal = setCwKeyPort ? setCwKeyPort.value || '' : '';

  if (rigEditorMode === 'edit' && editingRigId) {
    const rig = currentRigs.find(r => r.id === editingRigId);
    if (rig) {
      rig.name = name;
      rig.model = model;
      rig.catTarget = catTarget;
      rig.remoteAudioInput = rigAudioIn;
      rig.remoteAudioOutput = rigAudioOut;
      rig.cwKeyPort = rigCwKeyPortVal;
    }
  } else {
    const newRig = {
      id: 'rig_' + Date.now(),
      name,
      model,
      catTarget,
      remoteAudioInput: rigAudioIn,
      remoteAudioOutput: rigAudioOut,
      cwKeyPort: rigCwKeyPortVal,
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
  const radioCb = menu.querySelector('input[value="radio"]');  // only exists on band & mode filters
  const itemCbs = [...menu.querySelectorAll('input:not([value="all"]):not([value="radio"])')];

  container._updateText = updateText;

  function updateText() {
    if (radioCb && radioCb.checked) {
      let detail = null;
      if (label === 'Band') {
        detail = radioFreqKhz ? freqToBandActivator(radioFreqKhz) : null;
      } else if (label === 'Mode') {
        detail = radioMode ? radioModeToFilter(radioMode) : null;
      }
      textEl.textContent = detail ? `Radio (${detail})` : 'Radio';
      return;
    }
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
      if (radioCb) radioCb.checked = false;
      itemCbs.forEach((c) => { c.checked = nowChecked; });
    } else if (cb.value === 'radio') {
      // Radio is exclusive — uncheck All and all individual bands
      if (cb.checked) {
        allCb.checked = false;
        itemCbs.forEach((c) => { c.checked = false; });
      } else {
        // Unchecking Radio with nothing else → fall back to All
        allCb.checked = true;
      }
    } else {
      // Uncheck "All" and "Radio" when toggling individual items
      allCb.checked = false;
      if (radioCb) radioCb.checked = false;
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
  const radioCb = container.querySelector('input[value="radio"]');
  if (radioCb && radioCb.checked) {
    if (container === bandFilterEl) {
      const band = radioFreqKhz ? freqToBandActivator(radioFreqKhz) : null;
      return band ? new Set([band]) : null;
    } else if (container === modeFilterEl) {
      const mode = radioMode ? radioModeToFilter(radioMode) : null;
      return mode ? new Set([mode]) : null;
    }
  }
  const checked = [...container.querySelectorAll('input:not([value="all"]):not([value="radio"]):checked')];
  if (checked.length === 0) return null;
  return new Set(checked.map((cb) => cb.value));
}

initMultiDropdown(bandFilterEl, 'Band', () => { updateBandButtonsVisibility(); render(); });
initMultiDropdown(modeFilterEl, 'Mode');
initMultiDropdown(continentFilterEl, 'Region');
initMultiDropdown(rbnBandFilterEl, 'Band', rerenderRbn);
initMultiDropdown(propModeFilterEl, 'Mode', rerenderRbn);

// --- Band QSY buttons (shown when Radio band filter is active) ---
const BAND_QSY_FREQS = {
  // SSB calling frequencies (kHz) — used for SSB/phone modes
  ssb: { '160m': 1900, '80m': 3860, '60m': 5357, '40m': 7200, '30m': 10130, '20m': 14260, '17m': 18130, '15m': 21300, '12m': 24960, '10m': 28400, '6m': 50125, '4m': 70200, '2m': 144200, '70cm': 432100 },
  // CW calling frequencies
  cw: { '160m': 1820, '80m': 3530, '60m': 5332, '40m': 7030, '30m': 10110, '20m': 14030, '17m': 18080, '15m': 21030, '12m': 24900, '10m': 28030, '6m': 50090, '4m': 70100, '2m': 144050, '70cm': 432050 },
  // Digital/FT8 frequencies
  digi: { '160m': 1840, '80m': 3573, '60m': 5357, '40m': 7074, '30m': 10136, '20m': 14074, '17m': 18100, '15m': 21074, '12m': 24915, '10m': 28074, '6m': 50313, '4m': 70154, '2m': 144174, '70cm': 432065 },
};
const BAND_QSY_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm'];
const BAND_QSY_LABELS = { '160m': '160', '80m': '80', '60m': '60', '40m': '40', '30m': '30', '20m': '20', '17m': '17', '15m': '15', '12m': '12', '10m': '10', '6m': '6', '4m': '4', '2m': '2', '70cm': '70cm' };
const bandButtonsEl = document.getElementById('band-buttons');

function buildBandButtons() {
  bandButtonsEl.innerHTML = '';
  for (const band of BAND_QSY_ORDER) {
    const btn = document.createElement('button');
    btn.textContent = BAND_QSY_LABELS[band];
    btn.dataset.band = band;
    btn.title = `QSY to ${band}`;
    bandButtonsEl.appendChild(btn);
  }
}
buildBandButtons();

function getBandQsyFreq(band) {
  const mode = (radioMode || '').toUpperCase();
  if (mode === 'CW') return BAND_QSY_FREQS.cw[band];
  if (['FT8', 'FT4', 'FT2', 'RTTY', 'JT65', 'JT9', 'WSPR', 'DIGI', 'DIGU', 'DIGL', 'PKTUSB', 'PKTLSB'].includes(mode)) return BAND_QSY_FREQS.digi[band];
  return BAND_QSY_FREQS.ssb[band];
}

function updateBandButtonActive() {
  const curBand = radioFreqKhz ? freqToBandActivator(radioFreqKhz) : null;
  bandButtonsEl.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.band === curBand);
  });
}

function updateBandButtonsVisibility() {
  const radioCb = bandFilterEl.querySelector('input[value="radio"]');
  const show = radioCb && radioCb.checked;
  bandButtonsEl.classList.toggle('hidden', !show);
  if (show) updateBandButtonActive();
}

bandButtonsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const band = btn.dataset.band;
  const freq = getBandQsyFreq(band);
  if (freq) {
    const curMode = (radioMode || 'USB').toUpperCase();
    let mode = curMode;
    // Flip sideband for SSB: LSB below 10 MHz, USB at/above 10 MHz
    if (curMode === 'USB' || curMode === 'LSB' || curMode === 'SSB') {
      const lsbBands = new Set(['160m', '80m', '60m', '40m']);
      mode = lsbBands.has(band) ? 'LSB' : 'USB';
    }
    window.api.tune(String(freq), mode);
  }
});

// RBN age filter — re-render on change
rbnMaxAgeInput.addEventListener('change', rerenderRbn);
rbnAgeUnitSelect.addEventListener('change', rerenderRbn);
// Propagation source toggles
propShowRbnEl.addEventListener('change', () => { propShowRbn = propShowRbnEl.checked; rerenderRbn(); });
propShowPskrEl.addEventListener('change', () => { propShowPskr = propShowPskrEl.checked; rerenderRbn(); });

// DXCC filter constants
const DXCC_MODE_GROUPS = {
  phone:   new Set(['SSB', 'AM', 'FM', 'USB', 'LSB']),
  cw:      new Set(['CW']),
  digital: new Set(['FT8', 'FT4', 'FT2', 'RTTY', 'PSK31', 'JT65', 'JT9', 'DATA', 'OLIVIA', 'MFSK'])
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
  const anyVisible = enableCluster || enableRbn || enablePskr || enablePskrMap || enableRemote;
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
  connPskrMap.classList.toggle('hidden', !enablePskrMap);
  connPskrMap.classList.toggle('connected', pskrMapConnected);
  connRemote.classList.toggle('hidden', !enableRemote);
  connRemote.classList.toggle('connected', remoteConnected);
}

function updateRbnButton() {
  const propEnabled = enableRbn || enablePskrMap;
  if (propEnabled) {
    viewRbnBtn.classList.remove('hidden');
  } else {
    viewRbnBtn.classList.add('hidden');
    if (currentView === 'rbn') setView('table');
  }
  // Update source toggle visibility based on which sources are enabled
  propShowRbnEl.closest('label').classList.toggle('hidden', !enableRbn);
  propShowPskrEl.closest('label').classList.toggle('hidden', !enablePskrMap);
  // Also update the activator toolbar RBN button (safe even before DOM ref is set)
  if (typeof updateActivatorRbnButton === 'function') updateActivatorRbnButton();
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

// --- Banner Logger ---
const bannerLoggerEl = document.getElementById('banner-logger');
const blType = document.getElementById('bl-type');
const blRef = document.getElementById('bl-ref');
const blCallsign = document.getElementById('bl-callsign');
const blName = document.getElementById('bl-name');
const blFreq = document.getElementById('bl-freq');
const blMode = document.getElementById('bl-mode');
const blRstSent = document.getElementById('bl-rst-sent');
const blRstRcvd = document.getElementById('bl-rst-rcvd');
const blTime = document.getElementById('bl-time');
const blNotes = document.getElementById('bl-notes');
const blRespot = document.getElementById('bl-respot');
const blRespotLabel = document.getElementById('bl-respot-label');
const blLogBtn = document.getElementById('bl-log-btn');
let blFreqEdited = false;  // user manually edited freq — don't auto-fill
let blModeEdited = false;  // user manually edited mode — don't auto-fill
let blTimeEdited = false;  // user manually edited time — don't auto-fill
let blClockTimer = null;
let blLookupTimer = null;

function updateBannerLoggerVisibility() {
  const show = enableBannerLogger && enableLogging && appMode === 'hunter';
  bannerLoggerEl.classList.toggle('hidden', !show);
  document.querySelector('main').classList.toggle('banner-logger-active', show);
  if (show && !blClockTimer) {
    updateBlClock();
    blClockTimer = setInterval(updateBlClock, 1000);
  } else if (!show && blClockTimer) {
    clearInterval(blClockTimer);
    blClockTimer = null;
  }
}

function updateBlClock() {
  if (blTimeEdited) return;
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  blTime.value = hh + ':' + mm;
}

function updateBlFreqFromRadio() {
  if (blFreqEdited || !radioFreqKhz) return;
  blFreq.value = (radioFreqKhz / 1000).toFixed(3);
}

function updateBlModeFromRadio() {
  if (blModeEdited || !radioMode) return;
  const m = radioMode.toUpperCase();
  const mapped = m === 'USB' || m === 'LSB' ? m : m === 'CW' || m === 'CW-R' || m === 'CWR' ? 'CW' : m === 'FT8' ? 'FT8' : m === 'FT4' ? 'FT4' : m === 'FM' || m === 'NFM' ? 'FM' : m === 'AM' ? 'AM' : m === 'RTTY' || m === 'RTTY-R' ? 'RTTY' : 'SSB';
  const prev = blMode.value;
  blMode.value = mapped;
  // Only reset RST defaults when mode actually changes (not every poll cycle)
  if (mapped !== prev) updateBlRstDefaults(mapped);
}

/** Set RST defaults: 59 for phone, 599 for CW/digital */
function updateBlRstDefaults(mode) {
  const isPhone = mode === 'SSB' || mode === 'USB' || mode === 'LSB' || mode === 'FM' || mode === 'AM';
  const def = isPhone ? '59' : '599';
  blRstSent.value = def;
  blRstRcvd.value = def;
}

function updateBlRespotVisibility() {
  const type = blType.value;
  // Show respot checkbox for park/summit types or DX cluster contacts
  const canRespot = (type === 'pota' || type === 'wwff' || type === 'llota') ||
                    (type === '' && clusterConnected);
  blRespotLabel.classList.toggle('hidden', !canRespot);
}

// Type dropdown: show/hide ref field, update respot visibility
blType.addEventListener('change', () => {
  const type = blType.value;
  const needsRef = type === 'pota' || type === 'sota' || type === 'wwff' || type === 'llota';
  blRef.classList.toggle('hidden', !needsRef);
  blRef.placeholder = type === 'pota' ? 'K-1234' : type === 'sota' ? 'W4C/CM-001' : type === 'wwff' ? 'KFF-1234' : type === 'llota' ? 'US-0001' : 'Ref';
  if (needsRef) blRef.focus();
  updateBlRespotVisibility();
});

// User-edit flags: reset after each QSO save
blFreq.addEventListener('input', () => { blFreqEdited = true; });
blMode.addEventListener('change', () => {
  blModeEdited = true;
  updateBlRstDefaults(blMode.value);
});
blTime.addEventListener('input', () => { blTimeEdited = true; });

// QRZ lookup on callsign input (debounced)
blCallsign.addEventListener('input', () => {
  blCallsign.value = blCallsign.value.toUpperCase();
  clearTimeout(blLookupTimer);
  const cs = blCallsign.value.trim();
  if (cs.length < 3) { blName.value = ''; return; }
  blLookupTimer = setTimeout(async () => {
    const cached = qrzData.get(cs.split('/')[0]);
    if (cached) { blName.value = qrzDisplayName(cached); return; }
    try {
      const result = await window.api.qrzLookup(cs);
      if (result && blCallsign.value.trim().toUpperCase() === cs) {
        qrzData.set(cs.split('/')[0], result);
        blName.value = qrzDisplayName(result);
      }
    } catch {}
  }, 400);
});

// Save QSO from banner logger
async function saveBannerQso() {
  const callsign = blCallsign.value.trim().toUpperCase();
  if (!callsign) { blCallsign.focus(); return; }
  const frequency = blFreq.value.trim();
  if (!frequency) { blFreq.focus(); return; }
  const type = blType.value;
  const ref = blRef.value.trim().toUpperCase();
  const needsRef = type === 'pota' || type === 'sota' || type === 'wwff' || type === 'llota';
  if (needsRef && !ref) { blRef.focus(); return; }
  const mode = blMode.value;
  const rstSent = blRstSent.value.trim() || '59';
  const rstRcvd = blRstRcvd.value.trim() || '59';
  const timeVal = blTime.value.trim();
  const now = new Date();
  const qsoDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeParts = timeVal.replace(':', '');
  const timeOn = timeParts.length === 4 ? timeParts + '00' : String(now.getUTCHours()).padStart(2, '0') + String(now.getUTCMinutes()).padStart(2, '0') + '00';
  const freqMhz = parseFloat(frequency);
  const freqKhz = freqMhz * 1000;
  const band = freqToBandActivator(freqKhz) || '';
  const qrzInfo = qrzData.get(callsign.split('/')[0]);

  // Build sig/sigInfo/ref fields based on type
  let sig = '', sigInfo = '', potaRef = '', sotaRef = '', wwffRef = '';
  if (type === 'pota' && ref) { sig = 'POTA'; potaRef = ref; sigInfo = ref; }
  else if (type === 'sota' && ref) { sig = 'SOTA'; sotaRef = ref; sigInfo = ref; }
  else if (type === 'wwff' && ref) { sig = 'WWFF'; wwffRef = ref; sigInfo = ref; }
  else if (type === 'llota' && ref) { sig = 'LLOTA'; sigInfo = ref; }
  const notes = blNotes.value.trim();
  const commentBase = [notes, sigInfo ? `[${sig} ${sigInfo}]` : ''].filter(Boolean).join(' ');

  // Respot
  const wantsRespot = blRespot.checked && !blRespotLabel.classList.contains('hidden');
  const opQrz = qrzData.get(callsign.split('/')[0]);
  const opFirstname = (opQrz && (cleanQrzName(opQrz.nickname) || cleanQrzName(opQrz.fname))) || 'OM';
  let respotCommentText = '';
  if (wantsRespot) {
    const tmpl = (type === '' && clusterConnected) ? dxRespotTemplate : respotTemplate;
    respotCommentText = tmpl.replace(/\{rst\}/gi, rstSent).replace(/\{QTH\}/gi, grid).replace(/\{mycallsign\}/gi, myCallsign).replace(/\{op_firstname\}/gi, opFirstname);
  }

  // Park location lookup for POTA
  let parkLocState = '', parkLocGrid = '';
  if (sig === 'POTA' && potaRef) {
    try {
      const parkData = await window.api.getPark(potaRef);
      if (parkData) {
        const locParts = (parkData.locationDesc || '').split('-');
        if (locParts.length >= 2) parkLocState = locParts.slice(1).join('-');
        parkLocGrid = parkData.grid || '';
      }
    } catch {}
  }

  const qsoData = {
    callsign,
    frequency: String(freqKhz),
    mode,
    qsoDate,
    timeOn,
    rstSent,
    rstRcvd,
    txPower: String(defaultPower),
    band,
    sig,
    sigInfo,
    potaRef,
    sotaRef,
    wwffRef,
    name: qrzInfo ? [cleanQrzName(qrzInfo.nickname) || cleanQrzName(qrzInfo.fname), cleanQrzName(qrzInfo.name)].filter(Boolean).join(' ') : '',
    state: parkLocState || (!sig && qrzInfo ? (qrzInfo.state || '') : ''),
    county: !parkLocState && !sig && qrzInfo && qrzInfo.state && qrzInfo.county ? `${qrzInfo.state},${qrzInfo.county}` : '',
    gridsquare: parkLocGrid || (qrzInfo ? (qrzInfo.grid || '') : ''),
    country: qrzInfo ? (qrzInfo.country || '') : '',
    comment: commentBase,
    // Include activation context if activator mode is running
    ...(appMode === 'activator' && activationActive && activatorParkRefs.length > 0
      ? { mySig: 'POTA', mySigInfo: activatorParkRefs[0].ref }
      : {}),
    respot: wantsRespot && type === 'pota',
    wwffRespot: wantsRespot && type === 'wwff',
    wwffReference: wantsRespot && type === 'wwff' ? ref : '',
    llotaRespot: wantsRespot && type === 'llota',
    llotaReference: wantsRespot && type === 'llota' ? ref : '',
    dxcRespot: wantsRespot && type === '' && clusterConnected,
    respotComment: wantsRespot ? respotCommentText : '',
  };

  blLogBtn.disabled = true;
  blLogBtn.textContent = 'Saving\u2026';
  try {
    const result = await window.api.saveQso(qsoData);
    if (result && result.success) {
      // Keep type and ref sticky across QSOs (user is likely logging same park)
      blCallsign.value = '';
      blName.value = '';
      blNotes.value = '';
      blFreqEdited = false;
      blModeEdited = false;
      blTimeEdited = false;
      updateBlFreqFromRadio();
      updateBlModeFromRadio();
      updateBlClock();
      blCallsign.focus();
      // If in activator mode, add to activation log so it shows immediately
      if (appMode === 'activator' && activationActive && activatorParkRefs.length > 0) {
        const contact = {
          callsign,
          frequency: String(freqKhz),
          mode,
          rstSent,
          rstRcvd,
          timestamp: new Date().toISOString(),
          source: 'banner-log',
        };
        activatorContacts.push(contact);
        renderActivatorLog();
        updateActivatorCounter();
        window.api.qrzLookup(callsign).then(info => {
          if (info) {
            contact.name = qrzDisplayName(info);
            if (info.grid) contact.grid = info.grid;
            if (info.state) contact.state = info.state;
            renderActivatorLog();
          }
        }).catch(() => {});
      }
    } else {
      console.error('[BannerLogger] Save failed:', result);
    }
  } catch (err) {
    console.error('[BannerLogger] Save error:', err);
  } finally {
    blLogBtn.disabled = false;
    blLogBtn.textContent = 'Log';
  }
}

blLogBtn.addEventListener('click', saveBannerQso);

// Enter key flow: callsign → RST Sent → RST Rcvd → save
blCallsign.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); blRstSent.focus(); blRstSent.select(); }
});
blRstSent.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); blRstRcvd.focus(); blRstRcvd.select(); }
});
blRstRcvd.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveBannerQso(); }
});
blRef.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); blCallsign.focus(); }
});
blFreq.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); blMode.focus(); }
});
blMode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); blRstSent.focus(); blRstSent.select(); }
});

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
  const bandRadioCb = bandFilterEl.querySelector('input[value="radio"]');
  const bandRadio = bandRadioCb && bandRadioCb.checked;
  const modeRadioCb = modeFilterEl.querySelector('input[value="radio"]');
  const modeRadio = modeRadioCb && modeRadioCb.checked;
  const bands = bandRadio ? null : getDropdownValues(bandFilterEl);
  const modes = modeRadio ? null : getDropdownValues(modeFilterEl);
  const continents = getDropdownValues(continentFilterEl);
  const data = {
    bands: bands ? [...bands] : null,
    bandRadio,
    modes: modes ? [...modes] : null,
    modeRadio,
    continents: continents ? [...continents] : null,
    maxAgeMin,
  };
  localStorage.setItem(FILTERS_KEY, JSON.stringify(data));
}

function restoreFilters() {
  try {
    const data = JSON.parse(localStorage.getItem(FILTERS_KEY));
    if (!data) {
      // First run — ensure filters default to "All" (override any HTML-hardcoded checks)
      [bandFilterEl, modeFilterEl, continentFilterEl].forEach((container) => {
        container.querySelector('input[value="all"]').checked = true;
        const radioCb = container.querySelector('input[value="radio"]');
        if (radioCb) radioCb.checked = false;
        container.querySelectorAll('input:not([value="all"]):not([value="radio"])').forEach((cb) => { cb.checked = false; });
        if (container._updateText) container._updateText();
      });
      return;
    }

    // Restore band checkboxes
    if (data.bandRadio) {
      bandFilterEl.querySelector('input[value="all"]').checked = false;
      const radioCb = bandFilterEl.querySelector('input[value="radio"]');
      if (radioCb) radioCb.checked = true;
      bandFilterEl.querySelectorAll('input:not([value="all"]):not([value="radio"])').forEach((cb) => { cb.checked = false; });
    } else if (data.bands) {
      const bandSet = new Set(data.bands);
      bandFilterEl.querySelector('input[value="all"]').checked = false;
      const radioCb = bandFilterEl.querySelector('input[value="radio"]');
      if (radioCb) radioCb.checked = false;
      bandFilterEl.querySelectorAll('input:not([value="all"]):not([value="radio"])').forEach((cb) => {
        cb.checked = bandSet.has(cb.value);
      });
    } else {
      bandFilterEl.querySelector('input[value="all"]').checked = true;
      bandFilterEl.querySelectorAll('input:not([value="all"])').forEach((cb) => { cb.checked = false; });
    }

    // Restore mode checkboxes
    if (data.modeRadio) {
      modeFilterEl.querySelector('input[value="all"]').checked = false;
      const radioCb = modeFilterEl.querySelector('input[value="radio"]');
      if (radioCb) radioCb.checked = true;
      modeFilterEl.querySelectorAll('input:not([value="all"]):not([value="radio"])').forEach((cb) => { cb.checked = false; });
    } else if (data.modes) {
      const modeSet = new Set(data.modes);
      modeFilterEl.querySelector('input[value="all"]').checked = false;
      const radioCb = modeFilterEl.querySelector('input[value="radio"]');
      if (radioCb) radioCb.checked = false;
      modeFilterEl.querySelectorAll('input:not([value="all"]):not([value="radio"])').forEach((cb) => {
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
updateBandButtonsVisibility();

// Toggle radio sub-panels when radio type changes
radioTypeBtns.forEach((btn) => {
  btn.addEventListener('change', () => updateRadioSubPanels());
});

// Cluster checkbox toggles cluster config visibility
// QRZ checkbox toggles QRZ config visibility
setEnableQrz.addEventListener('change', () => {
  qrzConfig.classList.toggle('hidden', !setEnableQrz.checked);
  updateQrzLogbookVisibility();
});

// QRZ Logbook section visibility — show when QRZ enabled AND credentials entered
function updateQrzLogbookVisibility() {
  const show = setEnableQrz.checked && setQrzUsername.value.trim() && setQrzPassword.value;
  qrzLogbookSection.classList.toggle('hidden', !show);
  if (!show) {
    setQrzLogbook.checked = false;
    setQrzLogbook.disabled = true;
    qrzLogbookConfig.classList.add('hidden');
  }
}

// Recheck subscription button
qrzRecheckBtn.addEventListener('click', async () => {
  qrzSubStatus.textContent = 'Checking...';
  qrzSubStatus.style.color = '';
  qrzRecheckBtn.disabled = true;
  try {
    const result = await window.api.qrzCheckSub(true);
    if (result.error) {
      qrzSubStatus.textContent = result.error;
      qrzSubStatus.style.color = '#e94560';
      setQrzLogbook.disabled = true;
    } else if (result.subscriber) {
      qrzSubStatus.textContent = `XML Subscriber \u2014 expires ${result.expiry}`;
      qrzSubStatus.style.color = '#4ecca3';
      setQrzLogbook.disabled = false;
    } else {
      const msg = result.expiry && result.expiry !== 'non-subscriber'
        ? `QRZ XML subscription expired (${result.expiry})`
        : 'No active QRZ XML subscription';
      qrzSubStatus.textContent = msg;
      qrzSubStatus.style.color = '#e94560';
      setQrzLogbook.disabled = true;
      setQrzLogbook.checked = false;
      qrzLogbookConfig.classList.add('hidden');
    }
  } catch {
    qrzSubStatus.textContent = 'Check failed';
    qrzSubStatus.style.color = '#e94560';
  }
  qrzRecheckBtn.disabled = false;
});

// Toggle QRZ Logbook config visibility
setQrzLogbook.addEventListener('change', () => {
  qrzLogbookConfig.classList.toggle('hidden', !setQrzLogbook.checked);
});

// Verify API key on blur
setQrzApiKey.addEventListener('blur', async () => {
  const key = setQrzApiKey.value.trim();
  if (!key) { qrzApiStatus.textContent = ''; return; }
  qrzApiStatus.textContent = 'Verifying...';
  qrzApiStatus.style.color = '';
  try {
    const result = await window.api.qrzVerifyApiKey(key);
    if (result.ok) {
      qrzApiStatus.textContent = 'API key valid';
      qrzApiStatus.style.color = '#4ecca3';
    } else {
      qrzApiStatus.textContent = result.reason || result.message || 'Invalid key';
      qrzApiStatus.style.color = '#e94560';
    }
  } catch {
    qrzApiStatus.textContent = 'Verification failed';
    qrzApiStatus.style.color = '#e94560';
  }
});

// Update logbook section when credentials change
setQrzUsername.addEventListener('input', updateQrzLogbookVisibility);
setQrzPassword.addEventListener('input', updateQrzLogbookVisibility);

// QRZ Logbook download button
document.getElementById('qrz-download-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('qrz-download-status');
  statusEl.textContent = 'Downloading...';
  statusEl.style.color = '';
  try {
    const result = await window.api.qrzDownloadLogbook();
    if (result.ok) {
      statusEl.textContent = `Imported ${result.imported} new QSOs (${result.total} total in QRZ)`;
      statusEl.style.color = '#4ecca3';
    } else {
      statusEl.textContent = result.error || 'Download failed';
      statusEl.style.color = '#e94560';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = '#e94560';
  }
});

setEnableCluster.addEventListener('change', () => {
  clusterConfig.classList.toggle('hidden', !setEnableCluster.checked);
});

setEnableCwSpots.addEventListener('change', () => {
  const cfg = document.getElementById('cwspots-config');
  if (cfg) cfg.classList.toggle('hidden', !setEnableCwSpots.checked);
});

// CW Spots preset selector
(function() {
  const preset = document.getElementById('set-cwspots-preset');
  const custom = document.getElementById('cwspots-custom-fields');
  const clubs = document.getElementById('cwspots-clubs');
  if (preset) {
    preset.addEventListener('change', () => {
      custom.classList.toggle('hidden', preset.value !== 'custom');
      if (clubs) clubs.style.display = preset.value === 'rbn.telegraphy.de:7000' ? '' : 'none';
    });
  }
})();

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

// --- Net reminder list rendering ---
let editingNetId = null;

function renderNetList(nets) {
  netReminderList.innerHTML = '';
  for (const net of nets) {
    const item = document.createElement('div');
    item.className = 'net-item';
    item.dataset.id = net.id;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = net.enabled;
    cb.addEventListener('change', () => { net.enabled = cb.checked; });

    const info = document.createElement('div');
    info.className = 'net-item-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'net-item-name';
    nameEl.textContent = net.name;
    const detailEl = document.createElement('div');
    detailEl.className = 'net-item-detail';
    const schedStr = net.schedule?.type === 'weekly'
      ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].filter((_,i) => (net.schedule.days || []).includes(i)).join(', ')
      : net.schedule?.type === 'dates'
        ? (net.schedule.dates || []).join(', ')
        : 'Daily';
    detailEl.textContent = `${net.frequency} kHz ${net.mode} \u2022 ${net.startTime} ${net.timeZone === 'utc' ? 'UTC' : 'Local'} \u2022 ${schedStr}`;
    info.appendChild(nameEl);
    info.appendChild(detailEl);

    const editBtn = document.createElement('button');
    editBtn.className = 'node-item-btn';
    editBtn.textContent = '\u270E';
    editBtn.title = 'Edit net';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNetEditor('edit', net.id);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'node-item-btn node-delete-btn';
    delBtn.textContent = '\u2715';
    delBtn.title = 'Remove net';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentNetReminders = currentNetReminders.filter(n => n.id !== net.id);
      renderNetList(currentNetReminders);
    });

    item.appendChild(cb);
    item.appendChild(info);
    item.appendChild(editBtn);
    item.appendChild(delBtn);
    netReminderList.appendChild(item);
  }
}

function openNetEditor(mode, netId) {
  editingNetId = netId || null;
  if (mode === 'edit') {
    netEditorTitle.textContent = 'Edit Net';
    const net = currentNetReminders.find(n => n.id === netId);
    if (net) {
      setNetName.value = net.name || '';
      setNetFreq.value = net.frequency || '';
      setNetMode.value = net.mode || 'SSB';
      setNetTime.value = net.startTime || '17:00';
      setNetTz.value = net.timeZone || 'local';
      setNetDuration.value = net.duration || 60;
      setNetLead.value = net.leadTime != null ? net.leadTime : 15;
      const schedType = net.schedule?.type || 'daily';
      document.querySelector(`input[name="net-schedule"][value="${schedType}"]`).checked = true;
      updateNetScheduleUI(schedType);
      if (schedType === 'weekly') {
        netWeeklyDays.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.checked = (net.schedule.days || []).includes(parseInt(cb.value));
        });
      }
      if (schedType === 'dates') {
        setNetDates.value = (net.schedule.dates || []).join(', ');
      }
    }
  } else {
    netEditorTitle.textContent = 'Add Net';
    setNetName.value = '';
    setNetFreq.value = '';
    setNetMode.value = 'SSB';
    setNetTime.value = '17:00';
    setNetTz.value = 'local';
    setNetDuration.value = 60;
    setNetLead.value = 15;
    document.querySelector('input[name="net-schedule"][value="daily"]').checked = true;
    updateNetScheduleUI('daily');
    netWeeklyDays.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    setNetDates.value = '';
  }
  netEditor.classList.remove('hidden');
  netAddBtn.classList.add('hidden');
  setNetName.focus();
}

function updateNetScheduleUI(type) {
  netWeeklyDays.classList.toggle('hidden', type !== 'weekly');
  netSpecificDates.classList.toggle('hidden', type !== 'dates');
}

document.querySelectorAll('input[name="net-schedule"]').forEach(r => {
  r.addEventListener('change', () => updateNetScheduleUI(r.value));
});

netAddBtn.addEventListener('click', () => openNetEditor('add'));

netCancelBtn.addEventListener('click', () => {
  netEditor.classList.add('hidden');
  netAddBtn.classList.remove('hidden');
  editingNetId = null;
});

netSaveBtn.addEventListener('click', () => {
  const name = setNetName.value.trim();
  const freq = parseInt(setNetFreq.value, 10);
  if (!name || !freq) { alert('Name and frequency are required.'); return; }

  const schedType = document.querySelector('input[name="net-schedule"]:checked').value;
  const schedule = { type: schedType };
  if (schedType === 'weekly') {
    schedule.days = [];
    netWeeklyDays.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
      schedule.days.push(parseInt(cb.value));
    });
  }
  if (schedType === 'dates') {
    schedule.dates = setNetDates.value.split(',').map(d => d.trim()).filter(Boolean);
  }

  const netObj = {
    id: editingNetId || Date.now().toString(36),
    name,
    frequency: freq,
    mode: setNetMode.value,
    startTime: setNetTime.value || '17:00',
    timeZone: setNetTz.value || 'local',
    duration: parseInt(setNetDuration.value, 10) || 60,
    leadTime: parseInt(setNetLead.value, 10) || 0,
    schedule,
    enabled: true,
  };

  if (editingNetId) {
    const idx = currentNetReminders.findIndex(n => n.id === editingNetId);
    if (idx !== -1) {
      netObj.enabled = currentNetReminders[idx].enabled;
      currentNetReminders[idx] = netObj;
    }
  } else {
    currentNetReminders.push(netObj);
  }

  renderNetList(currentNetReminders);
  netEditor.classList.add('hidden');
  netAddBtn.classList.remove('hidden');
  editingNetId = null;
});

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
setEnablePskrMap.addEventListener('change', () => {
  pskrMapConfig.classList.toggle('hidden', !setEnablePskrMap.checked);
});

// PstRotator checkbox toggles rotor config visibility
setEnableRotor.addEventListener('change', () => {
  rotorConfig.classList.toggle('hidden', !setEnableRotor.checked);
});
// Antenna Genius checkbox toggles config visibility
setEnableAg.addEventListener('change', () => {
  agConfig.classList.toggle('hidden', !setEnableAg.checked);
});

// Antenna Genius band map UI
const AG_BANDS = ['160m','80m','60m','40m','30m','20m','17m','15m','12m','10m','6m','4m','2m','70cm'];
function buildAgBandMap(bandMap) {
  agBandMapEl.innerHTML = '';
  for (const band of AG_BANDS) {
    const label = document.createElement('span');
    label.textContent = band;
    label.style.textAlign = 'right';
    label.style.paddingRight = '4px';
    const select = document.createElement('select');
    select.id = `ag-band-${band}`;
    select.style.width = '100%';
    select.innerHTML = '<option value="">—</option>';
    for (let i = 1; i <= 8; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = agAntennaNames[i] ? `${i}: ${agAntennaNames[i]}` : String(i);
      select.appendChild(opt);
    }
    if (bandMap && bandMap[band]) select.value = String(bandMap[band]);
    agBandMapEl.appendChild(label);
    agBandMapEl.appendChild(select);
  }
}
let agAntennaNames = {};
function getAgBandMap() {
  const map = {};
  for (const band of AG_BANDS) {
    const sel = document.getElementById(`ag-band-${band}`);
    if (sel && sel.value) map[band] = parseInt(sel.value, 10);
  }
  return map;
}
// IPC: Antenna Genius status + antenna names
if (window.api.onAgStatus) {
  window.api.onAgStatus((status) => {
    agStatusEl.textContent = status.connected ? 'Connected' : '';
    agStatusEl.style.color = status.connected ? '#4ecca3' : '';
  });
}
if (window.api.onAgAntennaNames) {
  window.api.onAgAntennaNames((names) => {
    agAntennaNames = names;
    // Rebuild dropdowns with antenna names, preserving current selections
    const currentMap = getAgBandMap();
    buildAgBandMap(currentMap);
  });
}

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
// SOTA upload checkbox toggles config visibility
setSotaUpload.addEventListener('change', () => {
  sotaUploadConfig.classList.toggle('hidden', !setSotaUpload.checked);
});

// ECHOCAT checkbox toggles config visibility
setEnableRemote.addEventListener('change', async () => {
  remoteConfig.classList.toggle('hidden', !setEnableRemote.checked);
  if (setEnableRemote.checked) {
    await populateRemoteURLs();
  }
});

setRemoteRequireToken.addEventListener('change', () => {
  remoteTokenRow.classList.toggle('hidden', !setRemoteRequireToken.checked);
});

// --- Remote Launcher ---
const setEnableLauncher = document.getElementById('set-enable-launcher');
const launcherConfig = document.getElementById('launcher-config');
const launcherUrlDisplay = document.getElementById('launcher-url-display');
const launcherStatus = document.getElementById('launcher-status');

if (setEnableLauncher) {
  setEnableLauncher.addEventListener('change', async () => {
    if (launcherConfig) launcherConfig.classList.toggle('hidden', !setEnableLauncher.checked);
    if (setEnableLauncher.checked) {
      if (launcherStatus) launcherStatus.textContent = 'Installing...';
      const result = await window.api.installLauncher();
      if (launcherStatus) {
        if (result.ok) {
          launcherStatus.textContent = 'Installed. Will auto-start at next login.';
          launcherStatus.style.color = '#4ecca3';
        } else {
          launcherStatus.textContent = 'Install failed: ' + (result.error || 'unknown');
          launcherStatus.style.color = '#e94560';
        }
      }
      // Show URL
      try {
        const ips = await window.api.getLocalIPs();
        const tsIp = ips.find(ip => ip.tailscale);
        const lanIp = ips.find(ip => !ip.tailscale);
        const ip = tsIp || lanIp;
        if (launcherUrlDisplay) launcherUrlDisplay.textContent = ip ? 'https://' + ip.address + ':7301/' : 'https://YOUR_IP:7301/';
      } catch { if (launcherUrlDisplay) launcherUrlDisplay.textContent = 'https://YOUR_IP:7301/'; }
    } else {
      if (launcherStatus) launcherStatus.textContent = 'Removing...';
      const result = await window.api.uninstallLauncher();
      if (launcherStatus) {
        launcherStatus.textContent = result.ok ? 'Removed.' : 'Error: ' + (result.error || 'unknown');
        launcherStatus.style.color = result.ok ? '#aaa' : '#e94560';
      }
      if (launcherUrlDisplay) launcherUrlDisplay.textContent = '';
    }
  });
}

remoteRegenToken.addEventListener('click', () => {
  const arr = new Uint8Array(3);
  crypto.getRandomValues(arr);
  setRemoteToken.value = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
});

// Club Station Mode event handlers
setClubMode.addEventListener('change', () => {
  clubConfig.classList.toggle('hidden', !setClubMode.checked);
  if (setClubMode.checked && setClubCsvPath.value) {
    refreshClubPreview(setClubCsvPath.value);
  }
});

clubCsvBrowse.addEventListener('click', async () => {
  const filePath = await window.api.chooseClubCsvFile();
  if (filePath) {
    setClubCsvPath.value = filePath;
    refreshClubPreview(filePath);
  }
});

clubCsvCreate.addEventListener('click', async () => {
  // Get rig names from current settings to use as CSV radio columns
  const s = await window.api.getSettings();
  const rigNames = (s.rigs || []).map(r => r.name).filter(Boolean);
  const filePath = await window.api.createClubCsv(rigNames);
  if (filePath) {
    setClubCsvPath.value = filePath;
    refreshClubPreview(filePath);
  }
});

clubHashPasswords.addEventListener('click', async () => {
  const csvPath = setClubCsvPath.value;
  if (!csvPath) return;
  if (!confirm('This will hash all plaintext passwords in the CSV file. A .bak backup will be created. Continue?')) return;
  clubHashStatus.textContent = 'Hashing...';
  const result = await window.api.hashClubPasswords(csvPath);
  if (result.error) {
    clubHashStatus.textContent = 'Error: ' + result.error;
    clubHashStatus.style.color = '#e94560';
  } else {
    clubHashStatus.textContent = result.hashed + ' hashed, ' + result.alreadyHashed + ' already hashed';
    clubHashStatus.style.color = '#4ecca3';
    refreshClubPreview(csvPath);
  }
});

let clubScheduleDay = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];
let lastClubData = null;

async function refreshClubPreview(csvPath) {
  if (!csvPath) { clubPreview.innerHTML = ''; clubSchedule.innerHTML = ''; return; }
  const data = await window.api.previewClubCsv(csvPath);
  lastClubData = data;
  if (data.errors && data.errors.length > 0) {
    clubPreview.innerHTML = '<div style="color:#e94560">' + data.errors.join('<br>') + '</div>';
    clubSchedule.innerHTML = '';
    return;
  }
  if (!data.members || data.members.length === 0) {
    clubPreview.innerHTML = '<div style="color:#aaa">No members found</div>';
    clubSchedule.innerHTML = '';
    return;
  }
  const radioCols = data.radioColumns || [];
  let html = '<table style="width:100%;border-collapse:collapse;font-size:11px;">';
  html += '<tr style="border-bottom:1px solid #444;"><th style="text-align:left;padding:2px 4px;">Call</th>';
  html += '<th style="text-align:left;padding:2px 4px;">Name</th>';
  html += '<th style="text-align:left;padding:2px 4px;">License</th>';
  html += '<th style="text-align:left;padding:2px 4px;">Role</th>';
  for (const rc of radioCols) {
    html += '<th style="text-align:center;padding:2px 4px;">' + rc + '</th>';
  }
  html += '</tr>';
  for (const m of data.members) {
    html += '<tr>';
    html += '<td style="padding:2px 4px;color:#4fc3f7;">' + m.callsign + '</td>';
    html += '<td style="padding:2px 4px;">' + m.firstname + ' ' + m.lastname + '</td>';
    html += '<td style="padding:2px 4px;">' + m.license + '</td>';
    html += '<td style="padding:2px 4px;">' + m.role + '</td>';
    for (const rc of radioCols) {
      const has = m.radios && m.radios[rc];
      html += '<td style="text-align:center;padding:2px 4px;">' + (has ? '\u2713' : '') + '</td>';
    }
    html += '</tr>';
  }
  html += '</table>';
  clubPreview.innerHTML = html;

  // Schedule view
  if (data.hasSchedule) {
    renderClubSchedule(data);
  } else {
    clubSchedule.innerHTML = '';
  }
}

function renderClubSchedule(data) {
  if (!data || !data.members) { clubSchedule.innerHTML = ''; return; }
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const todayName = days[new Date().getDay()];
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

  // Day picker tabs
  let html = '<div style="margin-top:4px;font-size:12px;font-weight:600;color:#aaa;">Schedule</div>';
  html += '<div style="display:flex;gap:2px;margin:4px 0;">';
  for (const d of days) {
    const active = d === clubScheduleDay;
    const isToday = d === todayName;
    const bg = active ? '#4fc3f7' : 'transparent';
    const fg = active ? '#000' : (isToday ? '#4fc3f7' : '#aaa');
    const border = isToday && !active ? '1px solid #4fc3f7' : '1px solid transparent';
    html += `<button type="button" class="club-day-btn" data-day="${d}" style="padding:2px 6px;font-size:11px;border-radius:4px;cursor:pointer;background:${bg};color:${fg};border:${border};font-weight:${active ? '700' : '400'}">${d}</button>`;
  }
  html += '</div>';

  // Collect slots for selected day
  const slots = [];
  for (const m of data.members) {
    if (!m.schedule) continue;
    for (const s of m.schedule) {
      if (s.day === clubScheduleDay) {
        slots.push({ callsign: m.callsign, firstname: m.firstname, ...s });
      }
    }
  }
  slots.sort((a, b) => (a.startH * 60 + a.startM) - (b.startH * 60 + b.startM));

  if (slots.length === 0) {
    html += '<div style="font-size:11px;color:#666;padding:4px 0;">No slots scheduled for ' + clubScheduleDay + '</div>';
  } else {
    html += '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:2px;">';
    html += '<tr style="border-bottom:1px solid #444;"><th style="text-align:left;padding:2px 4px;">Time</th><th style="text-align:left;padding:2px 4px;">Radio</th><th style="text-align:left;padding:2px 4px;">Operator</th></tr>';
    for (const s of slots) {
      const startStr = String(s.startH).padStart(2, '0') + ':' + String(s.startM).padStart(2, '0');
      const endStr = String(s.endH).padStart(2, '0') + ':' + String(s.endM).padStart(2, '0');
      const slotStart = s.startH * 60 + s.startM;
      const slotEnd = s.endH * 60 + s.endM;
      const isNow = clubScheduleDay === todayName && nowMin >= slotStart && nowMin < slotEnd;
      const rowStyle = isNow ? 'background:rgba(79,195,247,0.15);' : '';
      const nowDot = isNow ? '<span style="color:#4ecca3;margin-right:3px;" title="Active now">\u25CF</span>' : '';
      html += `<tr style="${rowStyle}">`;
      html += `<td style="padding:2px 4px;">${nowDot}${startStr}\u2013${endStr}</td>`;
      html += `<td style="padding:2px 4px;">${s.radio}</td>`;
      html += `<td style="padding:2px 4px;color:#4fc3f7;">${s.callsign} <span style="color:#aaa;">${s.firstname}</span></td>`;
      html += '</tr>';
    }
    html += '</table>';
  }

  clubSchedule.innerHTML = html;

  // Day picker click handlers
  clubSchedule.querySelectorAll('.club-day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      clubScheduleDay = btn.dataset.day;
      renderClubSchedule(data);
    });
  });
}

async function populateRigAudioDevices(restoreIn, restoreOut) {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    rigRemoteAudioInput.innerHTML = '<option value="">-- system default --</option>' +
      inputs.map(d => `<option value="${d.deviceId}">${d.label || d.deviceId.slice(0, 20)}</option>`).join('');
    rigRemoteAudioOutput.innerHTML = '<option value="">-- system default --</option>' +
      outputs.map(d => `<option value="${d.deviceId}">${d.label || d.deviceId.slice(0, 20)}</option>`).join('');
    if (restoreIn) rigRemoteAudioInput.value = restoreIn;
    if (restoreOut) rigRemoteAudioOutput.value = restoreOut;
  } catch (e) {
    console.warn('Could not enumerate audio devices:', e.message);
  }
}

async function updateRemoteAudioSummary(audioInId, audioOutId) {
  if (!remoteAudioSummary) return;
  if (!audioInId && !audioOutId) {
    remoteAudioSummary.textContent = 'not configured';
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inLabel = audioInId ? (devices.find(d => d.deviceId === audioInId)?.label || audioInId.slice(0, 16)) : 'default';
    const outLabel = audioOutId ? (devices.find(d => d.deviceId === audioOutId)?.label || audioOutId.slice(0, 16)) : 'default';
    remoteAudioSummary.textContent = `${inLabel} / ${outLabel}`;
  } catch {
    remoteAudioSummary.textContent = audioInId || audioOutId ? 'configured' : 'not configured';
  }
}

// "Edit in Radio tab" link in ECHOCAT audio display
const remoteAudioEditLink = document.getElementById('remote-audio-edit-link');
if (remoteAudioEditLink) {
  remoteAudioEditLink.addEventListener('click', (e) => {
    e.preventDefault();
    switchSettingsTab('radio');
  });
}

async function populateRemoteURLs() {
  try {
    const ips = await window.api.getLocalIPs();
    const port = setRemotePort.value || 7300;
    remoteUrlDisplay.innerHTML = '';
    for (const ip of ips) {
      if (ip.tailscale && ip.tailscaleHostname) {
        const url = `https://${ip.tailscaleHostname}:${port}`;
        const row = document.createElement('div');
        const label = document.createElement('strong');
        label.style.color = '#4ecca3';
        label.textContent = 'Tailscale: ';
        const link = document.createElement('span');
        link.textContent = url;
        link.style.cssText = 'cursor:pointer;text-decoration:underline;';
        link.title = 'Click to copy';
        const hint = document.createElement('span');
        hint.style.cssText = 'font-size:10px;color:#888;margin-left:6px;';
        hint.textContent = '(click to copy)';
        link.addEventListener('click', () => {
          navigator.clipboard.writeText(url).then(() => {
            hint.textContent = 'Copied!';
            setTimeout(() => { hint.textContent = '(click to copy)'; }, 1500);
          });
        });
        row.appendChild(label);
        row.appendChild(link);
        row.appendChild(hint);
        remoteUrlDisplay.appendChild(row);
        const ipRow = document.createElement('div');
        ipRow.style.cssText = 'color:#888;font-size:11px;margin-left:12px;';
        ipRow.textContent = `IP: https://${ip.address}:${port}`;
        remoteUrlDisplay.appendChild(ipRow);
      } else {
        const row = document.createElement('div');
        row.textContent = `https://${ip.address}:${port}`;
        if (ip.tailscale) {
          const tag = document.createElement('strong');
          tag.style.color = '#4ecca3';
          tag.textContent = '(Tailscale) ';
          row.prepend(tag);
        }
        remoteUrlDisplay.appendChild(row);
      }
    }
  } catch {}
}

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
    port: 2237,
    help: 'In Log4OM 2: Settings > Program Configuration > Software Integration > UDP Inbound tab. Click the green "+" button to add a new entry. Set Type to "ADIF-MESSAGE" and Port to "2237". Click "Save and apply". Leave Host at 127.0.0.1 in POTACAT. Log4OM must be running to receive QSOs. Only live-logged QSOs are forwarded — importing logs into POTACAT will not create duplicates.',
  },
  dxkeeper: { port: 52001, help: 'In DXKeeper: Configuration > Defaults tab > Network Service panel. The default base port is 52000 (DXKeeper listens on base + 1 = 52001). DXKeeper must be running to receive QSOs. QSOs will be logged with missing fields auto-deduced from callbook/entity databases.' },
  hamrs: { port: 2237, help: 'In HamRS: enable WSJT-X integration in Settings and set the UDP port to 2237 (default). POTACAT speaks the WSJT-X binary protocol so HamRS sees it as a WSJT-X connection. The port here must match the port in HamRS. HamRS must be running to receive QSOs.' },
  n3fjp: { port: 1100, help: 'In N3FJP: Settings > Application Program Interface > check "TCP API Enabled". Set the port to 1100 (default). N3FJP must be running to receive QSOs. When using with WSJT-X, open WSJT-X first, then POTACAT, then N3FJP.' },
  hrd: { port: 2333, help: 'In HRD Logbook: Tools > Configure > QSO Forwarding. Under UDP Receive, check "Receive QSO notifications using UDP9/ADIF from other logging programs (eg. WSJT-X)". Set the receive port to 2333 and select your target database. POTACAT and WSJT-X can both send to this port simultaneously.' },
  macloggerdx: { port: 2237, help: 'In MacLoggerDX: Settings > enable "Receive and log WSJT-X UDP broadcasts" and set the port to 2237. POTACAT speaks the WSJT-X binary protocol. MacLoggerDX must be running to receive QSOs.' },
  wavelog: { apiConfig: true },
  wrl: { port: 12060, help: 'Requires WRL Cat Control running on this computer. Download it from worldradioleague.com. WRL Cat receives QSOs via the N1MM UDP protocol. In WRL Cat: enable N1MM integration and set the UDP port to 12060. QSOs logged in POTACAT will appear in your WRL logbook automatically.' },
};

function updateLogbookPortConfig() {
  const type = setLogbookType.value;
  const defaults = LOGBOOK_DEFAULTS[type];
  if (defaults && defaults.fileWatch) {
    logbookInstructions.innerHTML = defaults.instructions;
    logbookInstructions.classList.remove('hidden');
    logbookPortConfig.classList.add('hidden');
    logbookWavelogConfig.classList.add('hidden');
    logbookHelp.textContent = '';
  } else if (defaults && defaults.apiConfig) {
    logbookInstructions.classList.add('hidden');
    logbookPortConfig.classList.add('hidden');
    logbookWavelogConfig.classList.remove('hidden');
  } else if (defaults) {
    logbookInstructions.classList.add('hidden');
    logbookPortConfig.classList.remove('hidden');
    logbookWavelogConfig.classList.add('hidden');
    const currentPort = parseInt(setLogbookPort.value, 10);
    if (!currentPort || currentPort === defaults.port) setLogbookPort.value = defaults.port;
    logbookHelp.textContent = defaults.help;
  } else {
    logbookInstructions.classList.add('hidden');
    logbookPortConfig.classList.add('hidden');
    logbookWavelogConfig.classList.add('hidden');
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
      adifImportResult.style.color = SOURCE_COLORS_ACTIVE.pota;
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


// Icom CI-V test connection
document.getElementById('icom-test-btn').addEventListener('click', async () => {
  const portPath = getEffectiveIcomPort();
  const baudRate = parseInt(document.getElementById('set-icom-baud').value, 10);
  const civAddress = parseInt(document.getElementById('set-icom-model').value, 16);
  const resultEl = document.getElementById('icom-test-result');
  const btn = document.getElementById('icom-test-btn');

  if (!portPath) {
    resultEl.textContent = 'Select a serial port first';
    resultEl.className = 'hamlib-test-fail';
    return;
  }

  btn.disabled = true;
  resultEl.textContent = 'Testing...';
  resultEl.className = '';

  try {
    const result = await window.api.testIcomCiv({ portPath, baudRate, civAddress });
    if (result.success) {
      resultEl.textContent = `Connected! Freq: ${result.frequency} MHz`;
      resultEl.className = 'hamlib-test-success';
    } else {
      resultEl.textContent = `Failed: ${result.error}`;
      resultEl.className = 'hamlib-test-fail';
    }
  } catch (err) {
    resultEl.textContent = `Error: ${err.message}`;
    resultEl.className = 'hamlib-test-fail';
  } finally {
    btn.disabled = false;
  }
});

// Close dropdowns when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.multi-dropdown.open').forEach((d) => d.classList.remove('open'));
  closeActivatorSettingsPanel();
});

// --- Filtering ---
const DIGI_MODES = new Set(['FT8', 'FT4', 'FT2', 'RTTY', 'FREEDV', 'JT65', 'JT9', 'PSK31', 'OLIVIA', 'MFSK', 'DATA', 'DIGU', 'DIGL']);
function modeMatches(spotMode, selectedModes) {
  if (!selectedModes) return true;
  if (selectedModes.has(spotMode)) return true;
  if (selectedModes.has('SSB') && (spotMode === 'USB' || spotMode === 'LSB')) return true;
  if (selectedModes.has('DIGI') && DIGI_MODES.has(spotMode)) return true;
  return false;
}

/** Map CAT radio mode (USB, LSB, CW, FM, RTTY, etc.) to filter category. */
function radioModeToFilter(catMode) {
  if (!catMode) return null;
  const m = catMode.toUpperCase();
  if (m === 'CW' || m === 'CW-L' || m === 'CWL' || m === 'CW-U' || m === 'CWU' || m === 'CWR') return 'CW';
  if (m === 'USB' || m === 'LSB' || m === 'SSB' || m === 'AM') return 'SSB';
  if (m === 'FM' || m === 'NFM' || m === 'WFM' || m === 'FM-N' || m === 'FMN') return 'FM';
  if (m === 'RTTY' || m === 'RTTY-U' || m === 'RTTY-L' || m === 'RTTYR' || m === 'RTTY-LSB' || m === 'RTTY-USB') return 'RTTY';
  if (m === 'FT8') return 'FT8';
  if (m === 'FT4') return 'FT4';
  if (m === 'FREEDV') return 'FREEDV';
  // DATA modes (DIGU/PKTUSB/DIGL/PKTLSB) → show all digital spots
  if (m === 'DIGU' || m === 'PKTUSB' || m === 'DIGL' || m === 'PKTLSB') return 'DIGI';
  return null;
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
  // Match on band + mode — only hide if worked on same band AND mode today
  const spotBand = (spot.band || '').toUpperCase();
  const spotMode = (spot.mode || '').toUpperCase();
  if (spotBand || spotMode) {
    return todayQsos.some(e =>
      (!spotBand || e.band === spotBand) &&
      (!spotMode || e.mode === spotMode)
    );
  }
  return true;
}

function getFiltered() {
  const bands = getDropdownValues(bandFilterEl);
  const modes = getDropdownValues(modeFilterEl);
  const continents = getDropdownValues(continentFilterEl);
  const maxAgeSecs = maxAgeMin * 60;
  return allSpots.filter((s) => {
    // Net spots always pass through all filters
    if (s.source === 'net') return true;
    const sourceOff =
      (s.source === 'pota' && !enablePota) ||
      (s.source === 'sota' && !enableSota) ||
      (s.source === 'wwff' && !enableWwff) ||
      (s.source === 'llota' && !enableLlota) ||
      (s.source === 'dxc' && !enableCluster) ||
      (s.source === 'cwspots' && !enableCwSpots) ||
      (s.source === 'rbn' && !enableRbn) ||
      (s.source === 'pskr' && !enablePskr);
    const isWatched = watchlistMatch(watchlist, s.callsign, s.band, s.mode);

    if (sourceOff) {
      if (!isWatched || spotAgeSecs(s.spotTime) > 300) return false;
    } else if (s.source === 'pskr') {
      // PSKReporter already limits to 15 min server-side; don't apply client max-age
      if (spotAgeSecs(s.spotTime) > 900) return false;
    } else if (s.source === 'sota') {
      // SOTA spots are posted once by a human (not re-spotted like POTA)
      if (spotAgeSecs(s.spotTime) > sotaMaxAgeMin * 60) return false;
    } else {
      if (spotAgeSecs(s.spotTime) > maxAgeSecs) return false;
    }
    if (bands && !bands.has(s.band)) return false;
    if (!modeMatches(s.mode, modes)) return false;
    if (continents && !continents.has(s.continent)) return false;
    if (hideOutOfBand && isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass)) return false;
    if (hideWorked && isWorkedSpot(s)) return false;
    if (hideWorkedParks && s.source === 'pota' && s.reference && workedParksSet.has(s.reference)) return false;
    if (!showHiddenSpots && isSpotHidden(s.callsign, s.frequency)) return false;
    return true;
  });
}

// --- Sorting ---
function sortSpots(spots) {
  return spots.slice().sort((a, b) => {
    // Pin net spots above everything
    const aNet = a.source === 'net' ? 1 : 0;
    const bNet = b.source === 'net' ? 1 : 0;
    if (aNet !== bNet) return bNet - aNet;
    // Pin DX expeditions to the top (only when DXE display enabled)
    const aExp = enableDxe && expeditionCallsigns.has(a.callsign.toUpperCase()) ? 1 : 0;
    const bExp = enableDxe && expeditionCallsigns.has(b.callsign.toUpperCase()) ? 1 : 0;
    if (aExp !== bExp) return bExp - aExp;

    let va, vb;
    if (sortCol === 'grid') {
      va = (a.lat != null && a.lon != null) ? latLonToGridLocal(a.lat, a.lon).slice(0, 4) : null;
      vb = (b.lat != null && b.lon != null) ? latLonToGridLocal(b.lat, b.lon).slice(0, 4) : null;
    } else {
      va = a[sortCol];
      vb = b[sortCol];
    }
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
  { key: 'grid', label: 'Grid' },
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
  // Default: hide comments and grid columns on fresh install
  return new Set(['comments', 'grid']);
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
  'parkName','locationDesc','grid','distance','bearing','spotTime','comments','skip'
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
  parkName: 14, locationDesc: 7, grid: 5, distance: 6, bearing: 5, spotTime: 5, comments: 10, skip: 4
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

// --- Colorblind-safe dual palettes ---
const SOURCE_COLORS_NORMAL = {
  pota: '#4ecca3', sota: '#f0a500', wwff: '#26a69a',
  llota: '#42a5f5', dxc: '#e040fb', cwspots: '#ffd740', rbn: '#00bcd4', pskr: '#ff6b6b'
};
const SOURCE_COLORS_CB = {
  pota: '#4fc3f7', sota: '#ffb300', wwff: '#29b6f6',
  llota: '#42a5f5', dxc: '#e040fb', cwspots: '#ffd740', rbn: '#81d4fa', pskr: '#ffa726'
};
const SOURCE_STROKES_NORMAL = {
  pota: '#3ba882', sota: '#c47f00', wwff: '#1b7a71',
  llota: '#1e88e5', dxc: '#ab00d9', cwspots: '#c6a700', rbn: '#0097a7', pskr: '#d84343'
};
const SOURCE_STROKES_CB = {
  pota: '#2196f3', sota: '#e6a200', wwff: '#0288d1',
  llota: '#1e88e5', dxc: '#ab00d9', cwspots: '#c6a700', rbn: '#4fc3f7', pskr: '#e68a00'
};
const RBN_BAND_COLORS_NORMAL = {
  '160m': '#ff4444', '80m': '#ff8c00', '60m': '#ffd700', '40m': '#4ecca3',
  '30m': '#00cccc', '20m': '#4488ff', '17m': '#8844ff', '15m': '#cc44ff',
  '12m': '#ff44cc', '10m': '#ff4488', '6m': '#e0e0e0', '4m': '#b0e0e6', '2m': '#88ff88', '70cm': '#ffaa44',
};
const RBN_BAND_COLORS_CB = {
  '160m': '#ffa726', '80m': '#ffca28', '60m': '#fff176', '40m': '#4fc3f7',
  '30m': '#00cccc', '20m': '#4488ff', '17m': '#8844ff', '15m': '#cc44ff',
  '12m': '#ff44cc', '10m': '#ff4488', '6m': '#e0e0e0', '4m': '#b0e0e6', '2m': '#88ff88', '70cm': '#ffaa44',
};

let SOURCE_COLORS_ACTIVE = { ...SOURCE_COLORS_NORMAL };
let SOURCE_STROKES_ACTIVE = { ...SOURCE_STROKES_NORMAL };
let RBN_BAND_COLORS_ACTIVE = { ...RBN_BAND_COLORS_NORMAL };

// --- Teardrop icon factory ---
function makeTeardropIcon(fill, stroke) {
  return L.divIcon({
    className: '',
    html: `<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 21.9 12.5 41 12.5 41S25 21.9 25 12.5C25 5.6 19.4 0 12.5 0Z" fill="${fill}" stroke="${stroke}" stroke-width="1"/><circle cx="12.5" cy="12.5" r="5.5" fill="#fff" opacity="0.4"/></svg>`,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
  });
}

let sourceIcons = {};
function rebuildSourceIcons() {
  for (const src of Object.keys(SOURCE_COLORS_ACTIVE)) {
    sourceIcons[src] = makeTeardropIcon(SOURCE_COLORS_ACTIVE[src], SOURCE_STROKES_ACTIVE[src]);
  }
}
rebuildSourceIcons(); // initial build with normal palette

function applyColorblindMode(enabled) {
  const wcag = setWcagMode && setWcagMode.checked;
  if (enabled) {
    Object.assign(SOURCE_COLORS_ACTIVE, SOURCE_COLORS_CB);
    Object.assign(SOURCE_STROKES_ACTIVE, SOURCE_STROKES_CB);
    Object.assign(RBN_BAND_COLORS_ACTIVE, RBN_BAND_COLORS_CB);
  } else if (wcag) {
    Object.assign(SOURCE_COLORS_ACTIVE, SOURCE_COLORS_WCAG);
    Object.assign(SOURCE_STROKES_ACTIVE, SOURCE_STROKES_WCAG);
    Object.assign(RBN_BAND_COLORS_ACTIVE, RBN_BAND_COLORS_NORMAL);
  } else {
    Object.assign(SOURCE_COLORS_ACTIVE, SOURCE_COLORS_NORMAL);
    Object.assign(SOURCE_STROKES_ACTIVE, SOURCE_STROKES_NORMAL);
    Object.assign(RBN_BAND_COLORS_ACTIVE, RBN_BAND_COLORS_NORMAL);
  }
  rebuildSourceIcons();
  // Update CSS variables
  const root = document.documentElement;
  root.style.setProperty('--accent-green', enabled ? '#4fc3f7' : '');
  root.style.setProperty('--accent-green-btn', enabled ? '#4fc3f7' : '');
  for (const [src, color] of Object.entries(SOURCE_COLORS_ACTIVE)) {
    root.style.setProperty('--source-' + src, color);
  }
  // Update inline source label colors in Spots dropdown
  const srcLabels = { pota: '#spots-pota', sota: '#spots-sota', wwff: '#spots-wwff',
    llota: '#spots-llota', dxc: '#spots-cluster', rbn: '#spots-rbn', pskr: '#spots-pskr' };
  for (const [src, sel] of Object.entries(srcLabels)) {
    const span = document.querySelector(sel + ' + span') || document.querySelector(sel)?.parentElement?.querySelector('span');
    if (span) span.style.color = SOURCE_COLORS_ACTIVE[src];
  }
  // Refresh map markers if map is visible
  if (typeof renderMarkers === 'function') try { renderMarkers(); } catch {}
  if (typeof renderRbnMarkers === 'function') try { renderRbnMarkers(); } catch {}
}

// WCAG AA high-contrast source palettes
const SOURCE_COLORS_WCAG = {
  pota: '#5ed8ad', sota: '#f0a500', wwff: '#3cc4b8',
  llota: '#42a5f5', dxc: '#e87fff', cwspots: '#ffe066', rbn: '#00bcd4', pskr: '#ff9090'
};
const SOURCE_STROKES_WCAG = {
  pota: '#42b88a', sota: '#c47f00', wwff: '#2a9e92',
  llota: '#1e88e5', dxc: '#c040e0', cwspots: '#c6a700', rbn: '#0097a7', pskr: '#d06060'
};

function applyWcagMode(enabled) {
  const root = document.documentElement;
  if (enabled) {
    root.setAttribute('data-wcag', '');
  } else {
    root.removeAttribute('data-wcag');
  }
  // Re-apply colorblind mode on top (colorblind takes priority for source colors)
  const isCb = setColorblind && setColorblind.checked;
  if (isCb) {
    // Colorblind palettes already handle contrast
    return;
  }
  // Swap source colors for WCAG-boosted versions
  if (enabled) {
    Object.assign(SOURCE_COLORS_ACTIVE, SOURCE_COLORS_WCAG);
    Object.assign(SOURCE_STROKES_ACTIVE, SOURCE_STROKES_WCAG);
  } else {
    Object.assign(SOURCE_COLORS_ACTIVE, SOURCE_COLORS_NORMAL);
    Object.assign(SOURCE_STROKES_ACTIVE, SOURCE_STROKES_NORMAL);
  }
  rebuildSourceIcons();
  for (const [src, color] of Object.entries(SOURCE_COLORS_ACTIVE)) {
    root.style.setProperty('--source-' + src, color);
  }
  const srcLabels = { pota: '#spots-pota', sota: '#spots-sota', wwff: '#spots-wwff',
    llota: '#spots-llota', dxc: '#spots-cluster', rbn: '#spots-rbn', pskr: '#spots-pskr' };
  for (const [src, sel] of Object.entries(srcLabels)) {
    const span = document.querySelector(sel + ' + span') || document.querySelector(sel)?.parentElement?.querySelector('span');
    if (span) span.style.color = SOURCE_COLORS_ACTIVE[src];
  }
  if (typeof renderMarkers === 'function') try { renderMarkers(); } catch {}
  if (typeof renderRbnMarkers === 'function') try { renderRbnMarkers(); } catch {}
}

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

// PSKReporter Map state (spots shown on the shared Propagation map)
let pskrMapSpots = [];
let propShowRbn = true;   // source toggle: show RBN spots on propagation map
let propShowPskr = true;  // source toggle: show PSKReporter spots on propagation map

// RBN_BAND_COLORS is now managed by RBN_BAND_COLORS_ACTIVE (see colorblind palettes above)

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

// Pick the copy of lon (lon, lon-360, lon+360) closest to refLon
// Used to keep activation map bounds tight across the antimeridian
function wrapLon(refLon, lon) {
  let best = lon, bestDist = Math.abs(lon - refLon);
  for (const offset of [-360, 360]) {
    const wrapped = lon + offset;
    if (Math.abs(wrapped - refLon) < bestDist) {
      best = wrapped;
      bestDist = Math.abs(wrapped - refLon);
    }
  }
  return best;
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
  if (markerLayer && markerLayer.bringToFront) markerLayer.bringToFront();
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

  markerLayer = L.featureGroup().addTo(map);

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
  return SOURCE_COLORS_ACTIVE[source] || SOURCE_COLORS_ACTIVE.pota;
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

// Returns [[south, west], [north, east]] bounds for a 4-char grid
function gridToBoundsLocal(grid) {
  if (!grid || grid.length < 4) return null;
  const g = grid.toUpperCase();
  const lonField = g.charCodeAt(0) - 65;
  const latField = g.charCodeAt(1) - 65;
  const lonSquare = parseInt(g[2], 10);
  const latSquare = parseInt(g[3], 10);
  const west = lonField * 20 + lonSquare * 2 - 180;
  const south = latField * 10 + latSquare * 1 - 90;
  return [[south, west], [south + 1, west + 2]];
}

// Lightweight lat/lon → Maidenhead grid for the renderer (no require of Node module)
function latLonToGridLocal(lat, lon) {
  let lng = lon + 180;
  let la = lat + 90;
  const A = 'A'.charCodeAt(0);
  const a = 'a'.charCodeAt(0);
  const field1 = String.fromCharCode(A + Math.floor(lng / 20));
  const field2 = String.fromCharCode(A + Math.floor(la / 10));
  lng %= 20;
  la %= 10;
  const sq1 = Math.floor(lng / 2);
  const sq2 = Math.floor(la / 1);
  lng -= sq1 * 2;
  la -= sq2 * 1;
  const sub1 = String.fromCharCode(a + Math.floor(lng / (2 / 24)));
  const sub2 = String.fromCharCode(a + Math.floor(la / (1 / 24)));
  return `${field1}${field2}${sq1}${sq2}${sub1}${sub2}`;
}

// --- License privilege check (duplicated from lib/privileges.js — no require in renderer) ---
const PRIVILEGE_RANGES = {
  us_extra: [
    [1800, 2000, 'all'], [3500, 3600, 'cw_digi'], [3600, 4000, 'phone'],
    [7000, 7125, 'cw_digi'], [7125, 7300, 'phone'], [10100, 10150, 'all'],
    [14000, 14150, 'cw_digi'], [14150, 14350, 'phone'], [18068, 18168, 'all'],
    [21000, 21200, 'cw_digi'], [21200, 21450, 'phone'], [24890, 24990, 'all'],
    [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'], [50000, 54000, 'all'],
    [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
  us_advanced: [
    [1800, 2000, 'all'], [3525, 3600, 'cw_digi'], [3700, 4000, 'phone'],
    [7025, 7125, 'cw_digi'], [7125, 7300, 'phone'], [10100, 10150, 'all'],
    [14025, 14150, 'cw_digi'], [14175, 14350, 'phone'], [18068, 18168, 'all'],
    [21025, 21200, 'cw_digi'], [21225, 21450, 'phone'], [24890, 24990, 'all'],
    [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'], [50000, 54000, 'all'],
    [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
  us_general: [
    [1800, 2000, 'all'], [3525, 3600, 'cw_digi'], [3800, 4000, 'phone'],
    [7025, 7125, 'cw_digi'], [7175, 7300, 'phone'], [10100, 10150, 'all'],
    [14025, 14150, 'cw_digi'], [14225, 14350, 'phone'], [18068, 18168, 'all'],
    [21025, 21200, 'cw_digi'], [21275, 21450, 'phone'], [24890, 24990, 'all'],
    [28000, 28300, 'cw_digi'], [28300, 29700, 'phone'], [50000, 54000, 'all'],
    [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
  us_technician: [
    [3525, 3600, 'cw'], [7025, 7125, 'cw'], [21025, 21200, 'cw'],
    [28000, 28300, 'cw_digi'], [28300, 28500, 'phone'], [50000, 54000, 'all'],
    [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
  ca_basic: [
    [50000, 54000, 'all'], [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
  ca_honours: [
    [1800, 2000, 'all'], [3500, 4000, 'all'], [7000, 7300, 'all'],
    [10100, 10150, 'all'], [14000, 14350, 'all'], [18068, 18168, 'all'],
    [21000, 21450, 'all'], [24890, 24990, 'all'], [28000, 29700, 'all'],
    [50000, 54000, 'all'], [144000, 148000, 'all'], [420000, 450000, 'all'],
  ],
};

const SOURCE_LABELS = {
  pota: 'POTA', sota: 'SOTA', dxc: 'DX', cwspots: 'CW',
  rbn: 'RBN', wwff: 'WWFF', llota: 'LLOTA', pskr: 'FreeDV', net: 'NET',
};
const CW_DIGI_MODES = new Set(['CW', 'FT8', 'FT4', 'FT2', 'RTTY', 'DIGI', 'JS8', 'PSK31', 'PSK']);
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
      if (allowed === 'cw' && modeUpper === 'CW') return false;
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
    const watched = watchlistMatch(watchlist, s.callsign, s.band, s.mode);

    const sourceLabel = (s.source || 'pota').toUpperCase();
    const sourceColor = SOURCE_COLORS_ACTIVE[s.source] || SOURCE_COLORS_ACTIVE.pota;
    const logBtnHtml = enableLogging
      ? ` <button class="log-popup-btn" data-call="${s.callsign}" data-freq="${s.frequency}" data-mode="${s.mode}" data-ref="${s.reference || ''}" data-name="${(s.parkName || '').replace(/"/g, '&quot;')}" data-source="${s.source || ''}" data-wwff-ref="${s.wwffReference || ''}" data-wwff-name="${(s.wwffParkName || '').replace(/"/g, '&quot;')}">Log</button>`
      : '';
    const mapNewPark = workedParksSet.size > 0 && (s.source === 'pota' || s.source === 'wwff') && s.reference && !workedParksSet.has(s.reference);
    const newBadge = mapNewPark ? ` <span style="background:${SOURCE_COLORS_ACTIVE.pota};color:#000;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">NEW</span>` : '';
    const expMeta = expeditionMeta.get(s.callsign.toUpperCase());
    const expTitle = expMeta ? `DX Expedition: ${expMeta.entity}` : 'DX Expedition';
    const expeditionBadge = enableDxe && expeditionCallsigns.has(s.callsign.toUpperCase()) ? ` <span style="background:#ff1744;color:#fff;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;" title="${expTitle}">DXP</span>` : '';
    const mapEvent = getEventForCallsign(s.callsign);
    const eventBadgeHtml = mapEvent ? ` <span style="background:${mapEvent.badgeColor || '#ff6b00'};color:#fff;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">${mapEvent.badge || 'EVT'}</span>` : '';
    const wwffBadge = s.wwffReference ? ` <span style="background:${SOURCE_COLORS_ACTIVE.wwff};color:#000;font-size:10px;font-weight:bold;padding:1px 4px;border-radius:3px;">WWFF</span>` : '';
    const wwffRefLine = s.wwffReference ? `<br><b>${s.wwffReference}</b> ${s.wwffParkName || ''} <span style="color:${SOURCE_COLORS_ACTIVE.wwff};font-size:11px;">[WWFF]</span>` : '';
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
    const isExpedition = enableDxe && expeditionCallsigns.has(s.callsign.toUpperCase());
    const sourceIcon = sourceIcons[s.source] || sourceIcons.pota;
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
  return filtered.filter((s) => s.source !== 'net' && !scanSkipped.has(s.frequency) && !isWorkedSpot(s));
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
  // F4 — Test cat celebration animation (Shift+F4 for mega)
  if (e.key === 'F4' && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    if (e.shiftKey) {
      showMegaCelebration('500 QSOs today! You are UNSTOPPABLE!');
    } else {
      showCatCelebration('10 QSOs today! Keep going!');
    }
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
  // Arrow Up/Down — navigate spots in table view
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.target.matches('input, select, textarea') && showTable && !scanning) {
    e.preventDefault();
    const filtered = sortSpots(getFiltered());
    if (filtered.length === 0) return;
    // Find current index
    let idx = -1;
    if (lastTunedSpot) {
      idx = filtered.findIndex(s => s.callsign === lastTunedSpot.callsign && s.frequency === lastTunedSpot.frequency);
    }
    // Move
    if (e.key === 'ArrowDown') {
      idx = idx < filtered.length - 1 ? idx + 1 : 0;
    } else {
      idx = idx > 0 ? idx - 1 : filtered.length - 1;
    }
    const spot = filtered[idx];
    lastTunedSpot = spot;
    prefillDxCommand(spot);
    window.api.tune(spot.frequency, spot.mode, spot.bearing);
    if (spot.lat != null && spot.lon != null) showTuneArc(spot.lat, spot.lon, spot.frequency, spot.source);
    render();
    // Scroll the tuned row into view
    const onFreqRow = tbody.querySelector('.on-freq');
    if (onFreqRow) onFreqRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  // Enter — tune to selected spot (same as clicking the row)
  if (e.key === 'Enter' && !e.target.matches('input, select, textarea') && showTable && !scanning && lastTunedSpot) {
    e.preventDefault();
    window.api.tune(lastTunedSpot.frequency, lastTunedSpot.mode, lastTunedSpot.bearing);
    return;
  }
  // Arrow Left/Right — nudge frequency ±1 kHz
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.matches('input, select, textarea') && showTable && !scanning && lastTunedSpot) {
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1000 : -1000;
    const newFreq = lastTunedSpot.frequency + delta;
    lastTunedSpot = { ...lastTunedSpot, frequency: newFreq };
    window.api.tune(newFreq, lastTunedSpot.mode, lastTunedSpot.bearing);
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
  if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey) && !e.target.matches('input, select, textarea')) {
    e.preventDefault();
    return;
  }
  // Ctrl+M — Multi-park dialog (activator mode)
  if (e.key.toLowerCase() === 'm' && (e.ctrlKey || e.metaKey) && appMode === 'activator') {
    e.preventDefault();
    const context = document.activeElement === document.getElementById('activator-hunter-park') ? 'hunter' : 'my';
    openMultiparkDialog(context);
    return;
  }
  // Alt+R — Reload last entry (activator mode)
  if (e.key.toLowerCase() === 'r' && e.altKey && appMode === 'activator' && activationActive && activatorContacts.length > 0) {
    e.preventDefault();
    const last = activatorContacts[activatorContacts.length - 1];
    activatorCallsignInput.value = last.callsign;
    setRstDigits('activator-rst-sent', last.rstSent);
    setRstDigits('activator-rst-rcvd', last.rstRcvd);
    activatorCallsignInput.select();
    return;
  }
  // Ctrl+R / Cmd+R — Quick re-spot
  if (e.key.toLowerCase() === 'r' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    openQuickRespot();
    return;
  }
  // Ctrl+L / Cmd+L — Quick Log (unspotted QSO)
  if (e.key.toLowerCase() === 'l' && (e.ctrlKey || e.metaKey)) {
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
// SOURCE_COLORS is now managed by SOURCE_COLORS_ACTIVE (see colorblind palettes above)
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
  bar.style.borderColor = SOURCE_COLORS_ACTIVE[targets[0]];
  bar.style.color = SOURCE_COLORS_ACTIVE[targets[0]];
  dlg.dataset.targets = JSON.stringify(targets);

  // Comment template — pick based on network type
  const commentField = document.getElementById('respot-comment');
  const tmpl = targets.includes('dxc') ? dxRespotTemplate : respotTemplate;
  const spotQrz = s.callsign ? qrzData.get(s.callsign.toUpperCase().split('/')[0]) : null;
  const spotFirstname = (spotQrz && (cleanQrzName(spotQrz.nickname) || cleanQrzName(spotQrz.fname))) || 'OM';
  commentField.value = tmpl
    .replace(/\{QTH\}/gi, grid)
    .replace(/\{rst\}/gi, '')
    .replace(/\{callsign\}/gi, myCallsign)
    .replace(/\{mycallsign\}/gi, myCallsign)
    .replace(/\{op_firstname\}/gi, spotFirstname);

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
const dxSpotCall = document.getElementById('dx-spot-call');
const dxSpotFreq = document.getElementById('dx-spot-freq');
const dxSpotNote = document.getElementById('dx-spot-note');
let showDxBar = false;
let dxCommandPreferredNode = '';
let dxSpotComment = localStorage.getItem('dx-spot-comment') || 'great signal';

function prefillDxCommand(spot) {
  if (!spot || spot.source !== 'dxc' || !showDxBar || !enableCluster) return;
  dxSpotCall.value = spot.callsign || '';
  dxSpotFreq.value = parseFloat(spot.frequency).toFixed(1);
  dxSpotNote.value = dxSpotComment;
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
  const call = dxSpotCall.value.trim();
  const freq = dxSpotFreq.value.trim();
  if (!call || !freq) {
    showLogToast('Callsign and frequency are required', { warn: true, duration: 3000 });
    if (!call) dxSpotCall.focus();
    else dxSpotFreq.focus();
    return;
  }
  const note = dxSpotNote.value.trim();
  if (note) {
    dxSpotComment = note;
    localStorage.setItem('dx-spot-comment', dxSpotComment);
  }
  const text = 'DX ' + freq + ' ' + call + (note ? ' ' + note : '');
  const nodeId = dxCommandNode.value || undefined;
  btn.disabled = true;
  try {
    const result = await window.api.sendClusterCommand(text, nodeId);
    if (result.error) {
      showLogToast(result.error, { warn: true, duration: 5000 });
    } else {
      dxSpotCall.value = '';
      dxSpotFreq.value = '';
      dxSpotNote.value = '';
      const nodeName = nodeId ? dxCommandNode.options[dxCommandNode.selectedIndex].textContent : result.sent + ' node' + (result.sent > 1 ? 's' : '');
      showLogToast('Spotted ' + call + ' on ' + freq + ' kHz \u2192 ' + nodeName, { duration: 3000 });
    }
  } catch (err) {
    showLogToast('DX command failed: ' + err.message, { warn: true, duration: 5000 });
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('dx-command-send').addEventListener('click', sendDxCommand);
[dxSpotCall, dxSpotFreq, dxSpotNote].forEach(el => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendDxCommand(); }
  });
});

// --- Log Type Picker ---
const LOG_TYPE_SOURCE_MAP = { pota: 'pota', sota: 'sota', wwff: 'wwff', llota: 'llota', dx: 'dxc' };
const LOG_TYPE_PLACEHOLDERS = { pota: 'e.g. US-1234 or US-1234, US-5678', sota: 'e.g. W6/CT-001', wwff: 'e.g. KFF-1234 or KFF-1234, KFF-5678', llota: 'e.g. US-0001 or US-0001, US-0002' };

function selectLogType(type) {
  logSelectedType = type;
  logTypePicker.querySelectorAll('.log-type-chip').forEach(chip => {
    const ct = chip.dataset.type;
    const isActive = ct === type;
    chip.classList.toggle('active', isActive);
    if (isActive) {
      const color = ct === 'dx' ? SOURCE_COLORS_ACTIVE.dxc : SOURCE_COLORS_ACTIVE[ct] || '#888';
      chip.style.borderColor = color;
      chip.style.color = color;
    } else {
      chip.style.borderColor = '';
      chip.style.color = '';
    }
  });
  // Show/hide reference input (not for DX or no selection)
  const showRef = type && type !== 'dx';
  logRefInputSection.classList.toggle('hidden', !showRef);
  if (showRef) {
    logRefInput.placeholder = LOG_TYPE_PLACEHOLDERS[type] || '';
  }
  if (!showRef) {
    logRefInput.value = '';
    logRefName.textContent = '';
  }
  updateLogRespot();
}

function updateLogRespot() {
  const respotSection = document.getElementById('log-respot-section');
  const respotCheckbox = document.getElementById('log-respot');
  const respotLabel = document.getElementById('log-respot-label');
  const respotComment = document.getElementById('log-respot-comment');
  const respotCommentLabel = document.getElementById('log-respot-comment-label');
  const ref = logRefInput.value.trim().toUpperCase();
  const targets = [];
  if (!myCallsign) { /* no respot without callsign */ }
  else if (logSelectedType === 'pota' && ref) {
    targets.push('pota');
    // Check for dual-park WWFF
    if (currentLogSpot && currentLogSpot.wwffReference) targets.push('wwff');
  } else if (logSelectedType === 'wwff' && ref) {
    targets.push('wwff');
  } else if (logSelectedType === 'llota' && ref) {
    targets.push('llota');
  } else if (logSelectedType === 'dx' && clusterConnected) {
    targets.push('dxc');
  }

  if (targets.length) {
    respotSection.classList.remove('hidden');
    respotSection.dataset.targets = JSON.stringify(targets);
    const labelNames = targets.map(t => RESPOT_NAMES[t]).join(' & ');
    const verb = targets.includes('dxc') ? 'Spot on ' : 'Re-spot on ';
    const inputEl = respotLabel.querySelector('input');
    let labelTextNode = inputEl.nextSibling;
    if (!labelTextNode || labelTextNode.nodeType !== 3) {
      labelTextNode = document.createTextNode('');
      respotLabel.appendChild(labelTextNode);
    }
    labelTextNode.textContent = ' ' + verb + labelNames;
    respotLabel.style.color = SOURCE_COLORS_ACTIVE[targets[0]];
    respotCheckbox.checked = respotDefault;
    respotComment.value = targets.includes('dxc') ? dxRespotTemplate : respotTemplate;
    respotCommentLabel.style.display = respotCheckbox.checked ? '' : 'none';
    respotCheckbox.onchange = () => { respotCommentLabel.style.display = respotCheckbox.checked ? '' : 'none'; };
  } else {
    respotSection.classList.add('hidden');
    respotSection.dataset.targets = '[]';
    respotCheckbox.checked = false;
  }
}

// Type chip click handlers
logTypePicker.addEventListener('click', (e) => {
  const chip = e.target.closest('.log-type-chip');
  if (!chip) return;
  const type = chip.dataset.type;
  selectLogType(logSelectedType === type ? '' : type);
});

// Debounced reference lookup — supports comma-separated refs
let logRefLookupTimer = null;
logRefInput.addEventListener('input', () => {
  clearTimeout(logRefLookupTimer);
  const raw = logRefInput.value.trim().toUpperCase();
  if (raw.length < 3) { logRefName.textContent = ''; updateLogRespot(); return; }
  logRefLookupTimer = setTimeout(async () => {
    const refs = raw.split(',').map(r => r.trim()).filter(Boolean);
    const names = [];
    for (const ref of refs) {
      if (ref.length < 3) continue;
      try {
        const park = await window.api.getPark(ref);
        if (park && park.name) names.push(`${ref}: ${park.name}`);
      } catch { /* skip */ }
    }
    logRefName.textContent = names.join('\n');
    updateLogRespot();
  }, 400);
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
  selectLogType('');
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

// --- Cluster Terminal Pop-out ---
window.api.onClusterPopoutStatus((open) => {
  clusterPopoutOpen = open;
});

clusterTerminalBtn.addEventListener('click', () => {
  window.api.clusterPopoutOpen();
});

// --- Spots Pop-out ---
window.api.onSpotsPopoutStatus((open) => {
  spotsPopoutOpen = open;
  // In activator mode, close inline spots when pop-out opens, restore when it closes
  if (appMode === 'activator') {
    if (open && activatorSpotsVisible) {
      toggleActivatorSpots(); // hide inline
    } else if (!open && !activatorSpotsVisible) {
      toggleActivatorSpots(); // restore inline
    }
  }
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

// --- JTCAT Pop-out ---
window.api.onJtcatPopoutStatus((open) => {
  jtcatPopoutOpen = open;
  if (open) {
    // Start engine + audio capture in the main renderer when pop-out opens
    if (!jtcatRunning) startJtcatView();
    // Send current QSO state to the new popout
    broadcastJtcatQsoState();
  } else {
    // Stop engine + audio when pop-out closes (unless phone is driving)
    if (jtcatRunning && !jtcatRemoteActive) stopJtcatView();
  }
});

// Popout QSO commands are handled directly in main.js (no relay needed)

// --- View Toggle ---
// Table and Map are toggleable (both can be active = split view).
// RBN and DXCC are exclusive views that hide the split container.

function setView(view) {
  // Called for exclusive views (rbn, dxcc, directory) or to force a specific state
  if (view === 'rbn' || view === 'dxcc' || view === 'directory') {
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
  updateTitleBar();
  // Hide exclusive views
  dxccView.classList.add('hidden');
  rbnView.classList.add('hidden');
  jtcatView.classList.add('hidden');
  if (directoryView) directoryView.classList.add('hidden');
  stopDirvAutoRefresh();

  // Deactivate all view buttons
  viewTableBtn.classList.remove('active');
  viewMapBtn.classList.remove('active');
  viewRbnBtn.classList.remove('active');
  if (viewDirectoryBtn) viewDirectoryBtn.classList.remove('active');

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

  if (currentView === 'directory') {
    splitContainerEl.classList.add('hidden');
    if (directoryView) directoryView.classList.remove('hidden');
    if (viewDirectoryBtn) viewDirectoryBtn.classList.add('active');
    renderDirectoryView();
    startDirvAutoRefresh();
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
  if (currentView === 'rbn' || currentView === 'dxcc' || currentView === 'jtcat' || currentView === 'directory') {
    // Switching from exclusive view → table only
    if (currentView === 'jtcat') stopJtcatView();
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
  if (currentView === 'rbn' || currentView === 'dxcc' || currentView === 'jtcat' || currentView === 'directory') {
    // Switching from exclusive view → map only
    if (currentView === 'jtcat') stopJtcatView();
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
if (viewDirectoryBtn) viewDirectoryBtn.addEventListener('click', () => {
  if (directoryNets.length === 0 && directorySwl.length === 0) {
    window.api.fetchDirectory();
  }
  setView('directory');
});
viewJtcatBtn.addEventListener('click', () => {
  window.api.jtcatPopoutOpen();
});
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
    isExpedition: enableDxe && expeditionCallsigns.has(s.callsign.toUpperCase()),
    expeditionEntity: (expeditionMeta.get(s.callsign.toUpperCase()) || {}).entity || '',
    isNewPark: workedParksSet.size > 0 && (s.source === 'pota' || s.source === 'wwff') && s.reference && !workedParksSet.has(s.reference),
    isOop: isOutOfPrivilege(parseFloat(s.frequency), s.mode, licenseClass),
    isWatched: watchlistMatch(watchlist, s.callsign, s.band, s.mode),
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
const DXCC_BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm'];

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
      if (s.source === 'cwspots') tr.classList.add('spot-cwspots');
      if (s.source === 'rbn') tr.classList.add('spot-rbn');
      if (s.source === 'wwff') tr.classList.add('spot-wwff');
      if (s.source === 'llota') tr.classList.add('spot-llota');
      if (s.source === 'pskr') tr.classList.add('spot-pskr');
      if (s.source === 'net') tr.classList.add('spot-net');
      if (enableDxe && expeditionCallsigns.has(s.callsign.toUpperCase())) tr.classList.add('spot-expedition');
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

      // Mark hidden spots visually when "show hidden" is on
      if (showHiddenSpots && isSpotHidden(s.callsign, s.frequency)) {
        tr.classList.add('spot-hidden-row');
      }

      // Right-click to hide spot
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showHideSpotMenu(e.clientX, e.clientY, s.callsign, s.frequency);
      });

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
        // Auto-open JTCAT popout for digital mode spots
        const dm = (s.mode || '').toUpperCase();
        if (dm === 'FT8' || dm === 'FT4' || dm === 'FT2') {
          // Save the spot freq as JTCAT band so the popout opens on the right band
          const spotFreqKhz = Math.round(parseFloat(s.frequency));
          window.api.saveSettings({ jtcatLastBandFreq: spotFreqKhz });
          window.api.jtcatPopoutOpen();
        }
        render(); // highlight the clicked row immediately
      });

      // Build all cells into a map keyed by data-col, then append in colOrder
      const cellMap = new Map();

      // Log button cell (hidden for net spots)
      const logTd = document.createElement('td');
      logTd.className = 'log-cell log-col';
      logTd.setAttribute('data-col', 'log');
      if (s.source !== 'net') {
        const logButton = document.createElement('button');
        logButton.className = 'log-btn';
        logButton.textContent = isCompact ? 'L' : 'Log';
        logButton.addEventListener('click', (e) => {
          e.stopPropagation();
          openLogPopup(s);
        });
        logTd.appendChild(logButton);
      }
      cellMap.set('log', logTd);

      // Callsign cell — clickable link to QRZ
      const isWatched = watchlistMatch(watchlist, s.callsign, s.band, s.mode);
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
      if (s.source === 'net') {
        // Net spots use the net name as callsign — no QRZ link
        const callSpan = document.createElement('span');
        callSpan.textContent = s.callsign;
        callSpan.className = 'qrz-link';
        callTd.appendChild(callSpan);
      } else {
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
      }
      if (donorCallsigns.has(s.callsign.toUpperCase())) {
        const paw = document.createElement('span');
        paw.className = 'donor-paw';
        paw.title = 'POTACAT Supporter';
        paw.textContent = '\uD83D\uDC3E';
        callTd.appendChild(paw);
      }
      if (enableDxe && expeditionCallsigns.has(s.callsign.toUpperCase())) {
        const dxp = document.createElement('span');
        dxp.className = 'expedition-badge';
        const meta = expeditionMeta.get(s.callsign.toUpperCase());
        dxp.title = meta
          ? `DX Expedition: ${meta.entity}${meta.startDate ? ` (${meta.startDate} – ${meta.endDate})` : ''}`
          : 'DX Expedition (Club Log)';
        dxp.textContent = 'DXP';
        callTd.appendChild(dxp);
      }
      if (s.source === 'net') {
        const netBadge = document.createElement('span');
        netBadge.className = 'net-badge';
        netBadge.title = 'Scheduled Net';
        netBadge.textContent = 'NET';
        callTd.appendChild(netBadge);
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
      sourceBadge.textContent = (s.source === 'cwspots' && s.cwClub && s.cwClub !== 'CW') ? s.cwClub : (SOURCE_LABELS[s.source] || s.source || '');
      sourceTd.appendChild(sourceBadge);
      cellMap.set('source', sourceTd);

      const cells = [
        { val: s.mode, col: 'mode' },
        { val: refDisplay, wwff: !!s.wwffReference, newPark: isNewPark, col: 'reference' },
        { val: parkDisplay, col: 'parkName' },
        { val: s.locationDesc, col: 'locationDesc' },
        { val: (s.lat != null && s.lon != null) ? latLonToGridLocal(s.lat, s.lon).slice(0, 4) : '', col: 'grid' },
        { val: formatDistance(s.distance), col: 'distance' },
        { val: formatBearing(s.bearing), cls: 'bearing-col', col: 'bearing' },
        { val: formatAge(s.spotTime), col: 'spotTime' },
        { val: s.comments || '', col: 'comments' },
      ];

      for (const cell of cells) {
        const td = document.createElement('td');
        // Make park ref and name clickable links to park/summit pages
        if ((cell.col === 'reference' || cell.col === 'parkName') && s.reference && s.source !== 'net') {
          let url;
          if (s.source === 'sota') url = `https://www.sotadata.org.uk/en/summit/${s.reference}`;
          else if (s.source === 'wwff') url = `https://wwff.co/directory/?showRef=${s.reference}`;
          else if (s.source === 'llota') url = `https://llota.app/lighthouse/${s.reference}`;
          else url = `https://pota.app/#/park/${s.reference}`;
          const a = document.createElement('a');
          a.textContent = cell.val;
          a.href = '#';
          a.className = 'park-link';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.api.openExternal(url);
          });
          td.appendChild(a);
        } else {
          td.textContent = cell.val;
        }
        if (cell.col) td.setAttribute('data-col', cell.col);
        if (cell.cls) td.className = cell.cls;
        // Bearing column: clickable in manual rotor mode
        if (cell.col === 'bearing' && cell.val && s.bearing != null) {
          td.classList.add('bearing-clickable');
          td.title = `Click to rotate antenna to ${Math.round(s.bearing)}\u00B0`;
          td.addEventListener('click', (e) => {
            e.stopPropagation(); // don't tune the radio
            window.api.rotateTo(s.bearing);
            td.classList.add('bearing-sent');
            setTimeout(() => td.classList.remove('bearing-sent'), 1500);
          });
        }
        if (cell.col === 'comments' && cell.val) td.title = cell.val;
        if (cell.newPark) {
          const nb = document.createElement('span');
          nb.textContent = 'NEW';
          nb.style.cssText = `background:${SOURCE_COLORS_ACTIVE.pota};color:#000;font-size:9px;font-weight:bold;padding:1px 3px;border-radius:3px;margin-left:4px;`;
          td.appendChild(nb);
        }
        if (cell.wwff) {
          const badge = document.createElement('span');
          badge.textContent = 'WWFF';
          badge.style.cssText = `background:${SOURCE_COLORS_ACTIVE.wwff};color:#000;font-size:9px;font-weight:bold;padding:1px 3px;border-radius:3px;margin-left:4px;`;
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
const CW_DIGI_MODES_SET = new Set(['CW', 'FT8', 'FT4', 'FT2', 'RTTY', 'DIGI', 'JS8', 'PSK31', 'PSK']);

// Band lookup for ADIF (frequency in kHz → band string)
const BAND_RANGES = [
  [1800, 2000, '160m'], [3500, 4000, '80m'], [5330, 5410, '60m'],
  [7000, 7300, '40m'], [10100, 10150, '30m'], [14000, 14350, '20m'],
  [18068, 18168, '17m'], [21000, 21450, '15m'], [24890, 24990, '12m'],
  [28000, 29700, '10m'], [50000, 54000, '6m'], [70000, 70500, '4m'], [144000, 148000, '2m'],
  [420000, 450000, '70cm'],
];

function freqKhzToBand(khz) {
  const f = parseFloat(khz);
  for (const [lo, hi, band] of BAND_RANGES) {
    if (f >= lo && f <= hi) return band;
  }
  return '';
}

let currentLogSpot = null;

/** Parse comma-separated park refs from the reference input.
 *  Returns { primary, additional } where additional is the 2nd+ refs. */
function parseRefParks() {
  const raw = logRefInput.value.trim().toUpperCase();
  const refs = raw.split(',').map(r => r.trim()).filter(Boolean);
  return { primary: refs[0] || '', additional: refs.slice(1) };
}

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

  // Pre-fill power: use last-entered value if set, otherwise CAT reading, otherwise default
  logPower.value = lastLogPower > 0 ? lastLogPower : (radioPower > 0 ? radioPower : (defaultPower || 100));

  // Pre-fill RST based on mode
  const isCwDigi = CW_DIGI_MODES_SET.has(mode);
  const defaultRst = isCwDigi ? '599' : '59';
  const rstMaxLen = isCwDigi ? '3' : '2';
  setRstDigits('rst-sent-digits', defaultRst);
  setRstDigits('rst-rcvd-digits', defaultRst);
  const n1mmSentEl = document.getElementById('rst-sent-n1mm');
  const n1mmRcvdEl = document.getElementById('rst-rcvd-n1mm');
  if (n1mmSentEl) n1mmSentEl.maxLength = rstMaxLen;
  if (n1mmRcvdEl) n1mmRcvdEl.maxLength = rstMaxLen;

  // Type picker: map spot source to chip type
  const sourceToType = { pota: 'pota', sota: 'sota', wwff: 'wwff', llota: 'llota', dxc: 'dx' };
  const mappedType = sourceToType[spot.source] || '';
  // Pre-fill reference before selectLogType so respot can see it
  logRefInput.value = spot.reference || '';
  logRefName.textContent = spot.parkName || '';
  if (spot.wwffReference) {
    logRefName.textContent += (logRefName.textContent ? '\n' : '') + 'WWFF: ' + spot.wwffReference + (spot.wwffParkName ? ' — ' + spot.wwffParkName : '');
  }
  selectLogType(mappedType);

  logComment.value = '';

  logDialog.showModal();
  // Focus RST Sent so user can immediately type signal report
  if (n1mmRst) {
    const firstDigit = document.querySelector('#rst-sent-split .rst-digit');
    if (firstDigit) firstDigit.focus();
  } else {
    const n1mmSent = document.getElementById('rst-sent-n1mm');
    if (n1mmSent) { n1mmSent.focus(); n1mmSent.select(); }
  }
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

// --- Split-digit RST navigation (default mode) ---
document.querySelectorAll('.rst-digits').forEach((container) => {
  const inputs = container.querySelectorAll('.rst-digit');
  inputs.forEach((inp, i) => {
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('input', () => {
      if (inp.value.length > 1) inp.value = inp.value.slice(-1);
      if (inp.value && i < inputs.length - 1) inputs[i + 1].focus();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && i > 0) {
        inputs[i - 1].focus();
      }
    });
  });
});

// --- N1MM RST auto-advance ---
function setupRstAutoAdvance(sentId, rcvdId, getExpectedLen) {
  const sent = document.getElementById(sentId);
  const rcvd = document.getElementById(rcvdId);
  if (!sent || !rcvd) return;
  [sent, rcvd].forEach(el => el.addEventListener('focus', () => el.select()));
  sent.addEventListener('input', () => {
    const expected = getExpectedLen();
    if (sent.value.length >= expected) {
      rcvd.focus();
    }
  });
}

// Log dialog N1MM auto-advance
setupRstAutoAdvance('rst-sent-n1mm', 'rst-rcvd-n1mm', () => {
  const mode = logMode.value.toUpperCase();
  return CW_DIGI_MODES_SET.has(mode) ? 3 : 2;
});

// Mode change updates RST defaults
logMode.addEventListener('change', () => {
  const mode = logMode.value.toUpperCase();
  const isCwDigi = CW_DIGI_MODES_SET.has(mode);
  const defaultRst = isCwDigi ? '599' : '59';
  const maxLen = isCwDigi ? '3' : '2';
  setRstDigits('rst-sent-digits', defaultRst);
  setRstDigits('rst-rcvd-digits', defaultRst);
  const n1mmSent = document.getElementById('rst-sent-n1mm');
  const n1mmRcvd = document.getElementById('rst-rcvd-n1mm');
  if (n1mmSent) n1mmSent.maxLength = maxLen;
  if (n1mmRcvd) n1mmRcvd.maxLength = maxLen;
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
  const rawCallsign = logCallsign.value.trim().toUpperCase();
  const frequency = logFrequency.value.trim();
  const mode = logMode.value;
  const date = logDate.value;
  const time = logTime.value;

  if (!rawCallsign || !frequency || !mode || !date || !time) {
    logCallsign.focus();
    return;
  }

  // Support comma-separated callsigns (multiple activators at same park)
  const callsigns = rawCallsign.split(',').map(c => c.trim()).filter(Boolean);
  if (!callsigns.length) { logCallsign.focus(); return; }
  const callsign = callsigns[0]; // primary callsign for legacy references below

  const qsoDate = date.replace(/-/g, ''); // YYYYMMDD
  const timeOn = time.replace(':', '');     // HHMM
  const band = freqKhzToBand(frequency);

  // Determine SIG/SIG_INFO from type picker + reference input
  // Supports comma-separated refs for two-fer/three-fer (e.g. US-1234, US-5678)
  let sig = '';
  let sigInfo = '';
  let potaRef = '';
  let sotaRef = '';
  let wwffRef = '';
  const { primary: typedRef, additional: addlParks } = parseRefParks();
  if (logSelectedType && typedRef) {
    if (logSelectedType === 'pota') { sig = 'POTA'; potaRef = typedRef; }
    else if (logSelectedType === 'sota') { sig = 'SOTA'; sotaRef = typedRef; }
    else if (logSelectedType === 'wwff') { sig = 'WWFF'; wwffRef = typedRef; }
    else if (logSelectedType === 'llota') sig = 'LLOTA';
    sigInfo = typedRef;
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
  const respotWwffRef = (currentLogSpot && currentLogSpot.wwffReference) ? currentLogSpot.wwffReference : (logSelectedType === 'wwff' ? typedRef : '');
  // Resolve {op_firstname} from QRZ data for the primary callsign; fall back to "OM"
  const primaryCall = callsigns[0] || '';
  const primaryQrz = qrzData.get(primaryCall.split('/')[0]);
  const opFirstname = (primaryQrz && (cleanQrzName(primaryQrz.nickname) || cleanQrzName(primaryQrz.fname))) || 'OM';
  const commentText = respotComment.value.trim().replace(/\{rst\}/gi, getRstDigits('rst-sent-digits', '59')).replace(/\{QTH\}/gi, grid).replace(/\{mycallsign\}/gi, myCallsign).replace(/\{op_firstname\}/gi, opFirstname);

  const rstSent = getRstDigits('rst-sent-digits', '59');
  const rstRcvd = getRstDigits('rst-rcvd-digits', '59');
  const txPower = logPower.value.trim();
  lastLogPower = parseInt(txPower, 10) || 0; // remember for next log
  const commentBase = [logComment.value.trim(), sigInfo && !logComment.value.includes(sigInfo) ? `[${sig} ${sigInfo}]` : ''].filter(Boolean).join(' ');

  logSaveBtn.disabled = true;
  const origText = logSaveBtn.textContent;
  logSaveBtn.textContent = 'Saving\u2026';
  try {
    // For POTA/WWFF spots, look up the park's actual location for state/grid/country
    let parkLocState = '', parkLocGrid = '', parkLocCountry = '';
    if (sig === 'POTA' && potaRef) {
      try {
        const parkData = await window.api.getPark(potaRef);
        if (parkData) {
          // locationDesc is e.g. "US-ME", "VE-ON" — extract state portion after dash
          const locParts = (parkData.locationDesc || '').split('-');
          if (locParts.length >= 2) parkLocState = locParts.slice(1).join('-');
          parkLocGrid = parkData.grid || '';
        }
      } catch {}
    }

    let lastResult = null;
    for (let ci = 0; ci < callsigns.length; ci++) {
      const cs = callsigns[ci];
      const logQrzInfo = qrzData.get(cs.split('/')[0]);

      const qsoData = {
        callsign: cs,
        frequency,
        mode,
        qsoDate,
        timeOn,
        rstSent,
        rstRcvd,
        txPower,
        band,
        sig,
        sigInfo,
        potaRef,
        sotaRef,
        wwffRef,
        name: logQrzInfo ? [cleanQrzName(logQrzInfo.nickname) || cleanQrzName(logQrzInfo.fname), cleanQrzName(logQrzInfo.name)].filter(Boolean).join(' ') : '',
        // For park/summit activators, use park location instead of QRZ home QTH
        // For POTA activators, use the park's state/grid instead of QRZ home QTH
        state: parkLocState || (!sig && logQrzInfo ? logQrzInfo.state : ''),
        county: !parkLocState && !sig && logQrzInfo && logQrzInfo.state && logQrzInfo.county ? `${logQrzInfo.state},${logQrzInfo.county}` : '',
        gridsquare: parkLocGrid || (logQrzInfo ? logQrzInfo.grid : ''),
        country: logQrzInfo ? logQrzInfo.country : '',
        comment: commentBase,
        // Include activation context if activator mode is running
        ...(appMode === 'activator' && activationActive && activatorParkRefs.length > 0
          ? { mySig: 'POTA', mySigInfo: activatorParkRefs[0].ref }
          : {}),
        // Only respot on the first callsign
        respot: ci === 0 && wantsRespot,
        wwffRespot: ci === 0 && wantsWwffRespot,
        wwffReference: ci === 0 && wantsWwffRespot ? respotWwffRef : '',
        llotaRespot: ci === 0 && wantsLlotaRespot,
        llotaReference: ci === 0 && wantsLlotaRespot && logSelectedType === 'llota' ? typedRef : '',
        dxcRespot: ci === 0 && wantsDxcRespot,
        respotComment: ci === 0 && (wantsRespot || wantsWwffRespot || wantsLlotaRespot || wantsDxcRespot) ? commentText : '',
      };

      lastResult = await window.api.saveQso(qsoData);
      if (!lastResult.success) break;

      // Save additional park records (two-fer / three-fer) from comma-separated refs
      for (const addlRef of addlParks) {
        const addlComment = [logComment.value.trim(), `[${sig} ${addlRef}]`].filter(Boolean).join(' ');
        const addlData = {
          ...qsoData,
          sigInfo: addlRef,
          potaRef: sig === 'POTA' ? addlRef : qsoData.potaRef,
          wwffRef: sig === 'WWFF' ? addlRef : qsoData.wwffRef,
          comment: addlComment,
          respot: false,
          wwffRespot: false,
          llotaRespot: false,
          dxcRespot: false,
          respotComment: '',
          skipLogbookForward: true,
        };
        const addlResult = await window.api.saveQso(addlData);
        if (!addlResult.success) { lastResult = addlResult; break; }
      }
      if (lastResult && !lastResult.success) break;
    }

    const displayCalls = callsigns.join(', ');
    if (lastResult && lastResult.success) {
      logDialog.close();
      // If in activator mode, add to activation log so it shows immediately
      if (appMode === 'activator' && activationActive && activatorParkRefs.length > 0) {
        for (const cs of callsigns) {
          const contact = {
            callsign: cs,
            frequency: frequency,
            mode,
            rstSent: getRstDigits('rst-sent-digits', '59'),
            rstRcvd: getRstDigits('rst-rcvd-digits', '59'),
            timestamp: new Date().toISOString(),
            source: 'spot-log',
          };
          activatorContacts.push(contact);
          // Fire-and-forget QRZ lookup
          window.api.qrzLookup(cs).then(info => {
            if (info) {
              contact.name = qrzDisplayName(info);
              if (info.grid) contact.grid = info.grid;
              if (info.state) contact.state = info.state;
              renderActivatorLog();
            }
          }).catch(() => {});
        }
        renderActivatorLog();
        updateActivatorCounter();
      }
      // Advance selection to the next spot by frequency so the highlight
      // doesn't disappear when "hide worked" removes the logged station
      if (lastTunedSpot && hideWorked) {
        const freq = parseFloat(lastTunedSpot.frequency);
        const filtered = getFiltered().filter(s =>
          s.callsign !== lastTunedSpot.callsign || s.frequency !== lastTunedSpot.frequency
        );
        if (filtered.length > 0) {
          // Find nearest spot by frequency (prefer next higher, then lower)
          const sorted = [...filtered].sort((a, b) => parseFloat(a.frequency) - parseFloat(b.frequency));
          const next = sorted.find(s => parseFloat(s.frequency) >= freq) || sorted[sorted.length - 1];
          if (next) lastTunedSpot = next;
        }
      }
      if (lastResult.logbookError) {
        const friendly = lastResult.logbookError.includes('ECONNREFUSED')
          ? 'Could not reach logbook — is it running and configured correctly?'
          : lastResult.logbookError;
        showLogToast(`Logged ${displayCalls} to ADIF, but logbook forwarding failed: ${friendly}`, { warn: true, duration: 8000 });
      } else if (lastResult.respotError) {
        showLogToast(`Logged ${displayCalls} to ADIF, but POTA re-spot failed: ${lastResult.respotError}`, { warn: true, duration: 8000 });
      } else if (lastResult.resposted) {
        const sources = logTargets.filter(t => respotCheckbox.checked).map(t => RESPOT_NAMES[t]).join(' & ');
        showLogToast(`Logged ${displayCalls} — re-spotted on ${sources || 'POTA'}`);
      } else {
        showLogToast(`Logged ${displayCalls}`);
      }
    } else if (lastResult) {
      showLogToast(`Error: ${lastResult.error}`, { warn: true, duration: 5000 });
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

// --- Cat Celebration ---
const QSO_MILESTONES = [10, 25, 50, 100, 150, 200, 250, 500];
const celebratedMilestones = new Set();
let lastKnownDailyQsoCount = 0;

function showCatCelebration(message) {
  const existing = document.querySelector('.cat-celebration');
  if (existing) existing.remove();
  const container = document.createElement('div');
  container.className = 'cat-celebration';
  container.innerHTML = `<div class="cat-speech">${message}</div><div class="cat-emoji">\ud83d\udc08\u200d\u2b1b</div>`;
  document.body.appendChild(container);
  container.addEventListener('animationend', () => container.remove());
}

function showMegaCelebration(message) {
  const existing = document.querySelector('.mega-celebration');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'mega-celebration';
  overlay.innerHTML = `
    <div class="mega-cats">
      <span class="mega-cat mc-1">\ud83d\udc08\u200d\u2b1b</span>
      <span class="mega-cat mc-2">\ud83d\udc08</span>
      <span class="mega-cat mc-3">\ud83d\udc08\u200d\u2b1b</span>
      <span class="mega-cat mc-4">\ud83d\udc08</span>
      <span class="mega-cat mc-5">\ud83d\udc08\u200d\u2b1b</span>
    </div>
    <div class="mega-banner">${message}</div>
    <div class="mega-sparkles">\u2728\ud83c\udf89\ud83c\udf8a\u2728\ud83c\udf89\ud83c\udf8a\u2728</div>
  `;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
  setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 8000);
}

function getTodayUtcQsoCount() {
  const now = new Date();
  const todayUtc = now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0');
  let count = 0;
  for (const entries of workedQsos.values()) {
    for (const e of entries) {
      if (e.date === todayUtc) count++;
    }
  }
  return count;
}

function checkQsoMilestone() {
  const count = getTodayUtcQsoCount();
  // Reset celebrated milestones if day rolled over (count dropped)
  if (count < lastKnownDailyQsoCount) celebratedMilestones.clear();
  lastKnownDailyQsoCount = count;
  for (const m of QSO_MILESTONES) {
    if (count >= m && !celebratedMilestones.has(m)) {
      celebratedMilestones.add(m);
      if (m === 500) {
        showMegaCelebration(`500 QSOs today! You are UNSTOPPABLE!`);
      } else {
        showCatCelebration(`${m} QSOs today! Keep going!`);
      }
      break; // one celebration at a time
    }
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
  spotsCwSpots.checked = enableCwSpots;
  spotsRbn.checked = enableRbn;
  spotsPskr.checked = enablePskr;
  spotsDxe.checked = enableDxe;
  spotsHideWorked.checked = hideWorked;
  spotsHideParks.checked = hideWorkedParks;
  spotsHideOob.checked = hideOutOfBand;
  spotsShowHidden.checked = showHiddenSpots;
  const hCount = hiddenSpotCount();
  spotsHiddenCount.textContent = hCount;
  spotsHiddenCount.classList.toggle('hidden', hCount === 0);
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
  enableCwSpots = spotsCwSpots.checked;
  enableRbn = spotsRbn.checked;
  enablePskr = spotsPskr.checked;
  enableDxe = spotsDxe.checked;

  // DX Cluster and RBN require a callsign
  if (enableCluster && !myCallsign) {
    enableCluster = false;
    spotsCluster.checked = false;
    alert('DX Cluster requires a callsign. Please set your callsign in Settings first.');
  }
  if (enableCwSpots && !myCallsign) {
    enableCwSpots = false;
    spotsCwSpots.checked = false;
    alert('CW Spots requires a callsign. Please set your callsign in Settings first.');
  }
  if (enableRbn && !myCallsign) {
    enableRbn = false;
    spotsRbn.checked = false;
    alert('RBN requires a callsign. Please set your callsign in Settings first.');
  }
  hideWorked = spotsHideWorked.checked;
  hideWorkedParks = spotsHideParks.checked;
  hideOutOfBand = spotsHideOob.checked;
  showHiddenSpots = spotsShowHidden.checked;
  enableDxcc = spotsDxcc.checked;

  // Sync Settings dialog checkboxes
  setEnablePota.checked = enablePota;
  setEnableSota.checked = enableSota;
  setEnableWwff.checked = enableWwff;
  setEnableLlota.checked = enableLlota;
  setEnableCluster.checked = enableCluster;
  setEnableCwSpots.checked = enableCwSpots;
  setEnableRbn.checked = enableRbn;
  setEnablePskr.checked = enablePskr;
  setHideWorked.checked = hideWorked;
  setHideWorkedParks.checked = hideWorkedParks;
  quickHideWorkedParks.checked = hideWorkedParks;
  setHideOutOfBand.checked = hideOutOfBand;
  setEnableDxcc.checked = enableDxcc;

  updateRbnButton();
  updateDxccButton();
  updateDxCommandBar();

  // Save and let main process handle connect/disconnect
  await window.api.saveSettings({
    enablePota, enableSota, enableWwff, enableLlota,
    enableCluster, enableCwSpots, enableRbn, enablePskr, enableDxe,
    hideWorked, hideWorkedParks, hideOutOfBand,
    enableDxcc,
  });

  render();
});

// --- Hide spot context menu ---
const hideSpotMenu = document.getElementById('hide-spot-menu');
const hideSpotCallEl = document.getElementById('hide-spot-call');
const hideSpotFreqLabel = document.getElementById('hide-spot-freq-label');
let hideSpotTarget = '';
let hideSpotFreq = '';

function showHideSpotMenu(x, y, callsign, frequency) {
  hideSpotTarget = callsign.toUpperCase();
  hideSpotFreq = String(Math.round(parseFloat(frequency)));
  hideSpotCallEl.textContent = callsign;
  hideSpotFreqLabel.textContent = `Hide on ${frequency} kHz only`;
  // Show unhide button if already hidden
  const unhideBtn = hideSpotMenu.querySelector('.hide-spot-unhide');
  unhideBtn.classList.toggle('hidden', !isSpotHidden(callsign, frequency));
  hideSpotMenu.classList.remove('hidden');
  // Position near click, keep on screen
  const rect = hideSpotMenu.getBoundingClientRect();
  hideSpotMenu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  hideSpotMenu.style.top = Math.min(y, window.innerHeight - rect.height - 10) + 'px';
}

function closeHideSpotMenu() {
  hideSpotMenu.classList.add('hidden');
}

document.addEventListener('click', (e) => {
  if (!hideSpotMenu.contains(e.target)) closeHideSpotMenu();
});

function computeExpiry(dur) {
  if (dur === 'forever') return Infinity;
  if (dur === 'today') {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).getTime();
  }
  return Date.now() + parseInt(dur, 10);
}

hideSpotMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('.hide-spot-btn');
  if (!btn || !hideSpotTarget) return;
  const dur = btn.dataset.dur;
  const scope = btn.dataset.scope;
  if (dur === 'unhide') {
    unhideSpot(hideSpotTarget);
  } else if (scope === 'freq') {
    hideSpotEntry(hideSpotTarget, hideSpotFreq, computeExpiry(dur));
  } else {
    hideSpotEntry(hideSpotTarget, '*', computeExpiry(dur));
  }
  closeHideSpotMenu();
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

// --- Settings quick-access dropdown ---
const settingsDropdown = document.getElementById('settings-dropdown');
const quickLightMode = document.getElementById('quick-light-mode');
const quickActivatorMode = document.getElementById('quick-activator-mode');
const quickHideWorkedParks = document.getElementById('quick-hide-worked-parks');
const openSettingsBtn = document.getElementById('open-settings-btn');

settingsDropdown.querySelector('.settings-dropdown-panel').addEventListener('click', (e) => {
  e.stopPropagation();
});

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  document.querySelectorAll('.multi-dropdown.open').forEach((d) => {
    if (d !== settingsDropdown) d.classList.remove('open');
  });
  const opening = !settingsDropdown.classList.contains('open');
  settingsDropdown.classList.toggle('open');
  if (opening) {
    // Sync switches to current state
    quickLightMode.checked = document.documentElement.getAttribute('data-theme') === 'light';
    quickActivatorMode.checked = appMode === 'activator';
    quickHideWorkedParks.checked = hideWorkedParks;
    // Show rotor toggle only when PSTRotator is configured in Settings
    quickRotorLabel.classList.toggle('hidden', !rotorConfigured);
    quickRotorDivider.classList.toggle('hidden', !rotorConfigured);
    refreshEchoCatInfo();
  }
});

quickLightMode.addEventListener('change', async () => {
  const light = quickLightMode.checked;
  applyTheme(light);
  setLightMode.checked = light;
  if (popoutOpen) window.api.sendPopoutTheme(light ? 'light' : 'dark');
  if (qsoPopoutOpen) window.api.sendQsoPopoutTheme(light ? 'light' : 'dark');
  if (actmapPopoutOpen) window.api.actmapPopoutTheme(light ? 'light' : 'dark');
  if (spotsPopoutOpen) window.api.sendSpotsPopoutTheme(light ? 'light' : 'dark');
  if (clusterPopoutOpen) window.api.sendClusterPopoutTheme(light ? 'light' : 'dark');
  if (jtcatPopoutOpen) window.api.jtcatPopoutTheme(light ? 'light' : 'dark');
  await window.api.saveSettings({ lightMode: light });
});

quickActivatorMode.addEventListener('change', async () => {
  const mode = quickActivatorMode.checked ? 'activator' : 'hunter';
  setAppMode(mode);
  settingsDropdown.classList.remove('open');
  closeActivatorSettingsPanel();
  await window.api.saveSettings({ appMode: mode });
});

quickHideWorkedParks.addEventListener('change', async () => {
  hideWorkedParks = quickHideWorkedParks.checked;
  spotsHideParks.checked = hideWorkedParks;
  setHideWorkedParks.checked = hideWorkedParks;
  renderTable();
  renderMap();
  await window.api.saveSettings({ hideWorkedParks });
});

// PSTRotator quick toggle — visible once rotor has been enabled in settings
const quickRotor = document.getElementById('quick-rotor');
const quickRotorLabel = document.getElementById('quick-rotor-label');
const quickRotorDivider = document.getElementById('quick-rotor-divider');
let rotorConfigured = false; // true when enableRotor is on (user has a PSTRotator)

quickRotor.addEventListener('change', async () => {
  // Quick toggle changes rotorActive (operational state), NOT enableRotor (config)
  await window.api.saveSettings({ rotorActive: quickRotor.checked });
});

openSettingsBtn.addEventListener('click', () => {
  settingsDropdown.classList.remove('open');
  closeActivatorSettingsPanel();
  openSettingsDialog();
});

// ECHOCAT quick toggle
const quickEchoCat = document.getElementById('quick-echo-cat');
const echoCatInfo = document.getElementById('echo-cat-info');
const echoCatUrl = document.getElementById('echo-cat-url');
const echoCatToken = document.getElementById('echo-cat-token');
const echoCatCopy = document.getElementById('echo-cat-copy');

const quickAudioInput = document.getElementById('quick-audio-input');
const quickAudioOutput = document.getElementById('quick-audio-output');

async function refreshEchoCatInfo() {
  const s = await window.api.getSettings();
  const on = s.enableRemote === true;
  quickEchoCat.checked = on;
  echoCatInfo.classList.toggle('hidden', !on);
  if (on) {
    const port = s.remotePort || 7300;
    const token = s.remoteToken || '';
    const ips = await window.api.getLocalIPs();
    const best = ips.find(ip => ip.tailscale) || ips[0];
    if (best) {
      echoCatUrl.innerHTML = `<span class="echo-cat-ip">https://${best.address}:${port}</span>`;
    } else {
      echoCatUrl.textContent = 'No network found';
    }
    const requireToken = s.remoteRequireToken !== false;
    const tokenRow = echoCatToken.closest('.echo-cat-token-row');
    if (requireToken && token) {
      echoCatToken.textContent = token;
      if (tokenRow) tokenRow.classList.remove('hidden');
    } else {
      echoCatToken.textContent = '';
      if (tokenRow) tokenRow.classList.add('hidden');
    }
    // Populate quick audio device dropdowns
    await populateQuickAudioDevices(s.remoteAudioInput || '', s.remoteAudioOutput || '');
  }
}

async function populateQuickAudioDevices(restoreIn, restoreOut) {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    quickAudioInput.innerHTML = '<option value="">System Default</option>' +
      inputs.map(d => `<option value="${d.deviceId}">${d.label || d.deviceId.slice(0, 20)}</option>`).join('');
    quickAudioOutput.innerHTML = '<option value="">System Default</option>' +
      outputs.map(d => `<option value="${d.deviceId}">${d.label || d.deviceId.slice(0, 20)}</option>`).join('');
    if (restoreIn) quickAudioInput.value = restoreIn;
    if (restoreOut) quickAudioOutput.value = restoreOut;
  } catch (e) {
    console.warn('Could not enumerate audio devices:', e.message);
  }
}

quickAudioInput.addEventListener('change', async () => {
  const s = await window.api.getSettings();
  const rigs = s.rigs || [];
  const activeRig = rigs.find(r => r.id === s.activeRigId);
  if (activeRig) {
    activeRig.remoteAudioInput = quickAudioInput.value;
    await window.api.saveSettings({ rigs, remoteAudioInput: quickAudioInput.value });
  } else {
    await window.api.saveSettings({ remoteAudioInput: quickAudioInput.value });
  }
});

quickAudioOutput.addEventListener('change', async () => {
  const s = await window.api.getSettings();
  const rigs = s.rigs || [];
  const activeRig = rigs.find(r => r.id === s.activeRigId);
  if (activeRig) {
    activeRig.remoteAudioOutput = quickAudioOutput.value;
    await window.api.saveSettings({ rigs, remoteAudioOutput: quickAudioOutput.value });
  } else {
    await window.api.saveSettings({ remoteAudioOutput: quickAudioOutput.value });
  }
});

quickEchoCat.addEventListener('change', async () => {
  const on = quickEchoCat.checked;
  enableRemote = on;
  setEnableRemote.checked = on;
  remoteConfig.classList.toggle('hidden', !on);
  echoCatInfo.classList.toggle('hidden', !on);
  await window.api.saveSettings({ enableRemote: on });
  if (on) {
    await populateRemoteURLs();
    await refreshEchoCatInfo();
  }
  updateSettingsConnBar();
});

// Copy just the URL
const echoCatCopyUrl = document.getElementById('echo-cat-copy-url');
echoCatCopyUrl.addEventListener('click', async () => {
  const s = await window.api.getSettings();
  const port = s.remotePort || 7300;
  const ips = await window.api.getLocalIPs();
  const best = ips.find(ip => ip.tailscale) || ips[0];
  const url = best ? `https://${best.address}:${port}` : '';
  try {
    await navigator.clipboard.writeText(url);
    echoCatCopyUrl.textContent = '\u2705';
    setTimeout(() => { echoCatCopyUrl.textContent = '\u{1F4CB}'; }, 1500);
  } catch {}
});

// Copy URL + token
echoCatCopy.addEventListener('click', async () => {
  const s = await window.api.getSettings();
  const port = s.remotePort || 7300;
  const token = s.remoteToken || '';
  const ips = await window.api.getLocalIPs();
  const best = ips.find(ip => ip.tailscale) || ips[0];
  const url = best ? `https://${best.address}:${port}` : '';
  const requireToken = s.remoteRequireToken !== false;
  const text = (requireToken && token) ? `${url}\nToken: ${token}` : url;
  try {
    await navigator.clipboard.writeText(text);
    echoCatCopy.textContent = 'Copied!';
    echoCatCopy.classList.add('copied');
    setTimeout(() => { echoCatCopy.textContent = 'Copy'; echoCatCopy.classList.remove('copied'); }, 1500);
  } catch {}
});

// Settings tabs
const settingsTabBar = document.querySelector('.settings-tabs-row');
const settingsSearch = document.getElementById('settings-search');
const settingsScrollArea = document.querySelector('.settings-scroll-area');

function switchSettingsTab(tabName) {
  if (!settingsTabBar) return;
  // Update active tab button
  settingsTabBar.querySelectorAll('.settings-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  // Show/hide fieldsets
  settingsScrollArea.querySelectorAll('fieldset[data-settings-tab]').forEach(fs => {
    fs.classList.toggle('tab-visible', fs.dataset.settingsTab === tabName);
  });
  settingsDialog.classList.add('tabbed');
  settingsDialog.classList.remove('searching');
  // Save active tab
  try { localStorage.setItem('settings-active-tab', tabName); } catch {}
  // Scroll to top of the new tab
  settingsScrollArea.scrollTop = 0;
}

if (settingsTabBar) {
  settingsTabBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-tab');
    if (!btn) return;
    settingsSearch.value = '';
    settingsTabBar.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('has-match'));
    switchSettingsTab(btn.dataset.tab);
  });
}

if (settingsSearch) {
  settingsSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (settingsSearch.value) {
        e.stopPropagation(); // Don't close the dialog
        settingsSearch.value = '';
        settingsSearch.dispatchEvent(new Event('input'));
      }
    }
  });
  settingsSearch.addEventListener('input', () => {
    const q = settingsSearch.value.trim().toLowerCase();
    if (!q) {
      // Restore tab view
      settingsDialog.classList.remove('searching');
      const oldMsg = settingsScrollArea.querySelector('.settings-no-results');
      if (oldMsg) oldMsg.remove();
      const activeTab = settingsTabBar.querySelector('.settings-tab.active');
      if (activeTab) switchSettingsTab(activeTab.dataset.tab);
      settingsTabBar.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('has-match'));
      return;
    }
    settingsDialog.classList.remove('tabbed');
    settingsDialog.classList.add('searching');
    // Remove old no-results message
    const oldMsg = settingsScrollArea.querySelector('.settings-no-results');
    if (oldMsg) oldMsg.remove();
    // Check each fieldset for matches
    const tabMatches = {};
    let anyMatch = false;
    settingsScrollArea.querySelectorAll('fieldset[data-settings-tab]').forEach(fs => {
      const text = fs.textContent.toLowerCase();
      const match = text.includes(q);
      fs.classList.toggle('search-match', match);
      if (match) { tabMatches[fs.dataset.settingsTab] = true; anyMatch = true; }
    });
    // Show which tabs have matches
    settingsTabBar.querySelectorAll('.settings-tab').forEach(btn => {
      btn.classList.toggle('has-match', !!tabMatches[btn.dataset.tab]);
    });
    // No results message
    if (!anyMatch) {
      const msg = document.createElement('div');
      msg.className = 'settings-no-results';
      msg.textContent = `No settings matching "${settingsSearch.value.trim()}"`;
      settingsScrollArea.appendChild(msg);
    }
  });
}

// Settings dialog
let _openSettingsTab = null;
async function openSettingsDialog(tab) {
  if (tab) _openSettingsTab = tab;
  const s = await window.api.getSettings();
  setGrid.value = s.grid || '';
  setDistUnit.value = s.distUnit || 'mi';
  setMaxAge.value = s.maxAgeMin || 5;
  setSotaMaxAge.value = s.sotaMaxAge || 30;
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
  if (s.enableRotor) rotorConfigured = true;
  if (setRotorMode) setRotorMode.value = s.rotorMode || 'auto';
  setRotorHost.value = s.rotorHost || '127.0.0.1';
  setRotorPort.value = s.rotorPort || 12040;
  rotorConfig.classList.toggle('hidden', !s.enableRotor);
  setEnableAg.checked = s.enableAntennaGenius === true;
  setAgHost.value = s.agHost || '';
  setAgRadioPort.value = s.agRadioPort || '1';
  buildAgBandMap(s.agBandMap || {});
  agConfig.classList.toggle('hidden', !s.enableAntennaGenius);
  setEnableSplit.checked = s.enableSplit === true;
  setEnableAtu.checked = s.enableAtu === true;
  setVerboseLog.checked = s.verboseLog === true;
  setLightIcon.checked = s.lightIcon === true;
  setEnablePota.checked = s.enablePota !== false;
  setEnableSota.checked = s.enableSota === true;
  setEnableWwff.checked = s.enableWwff === true;
  setEnableLlota.checked = s.enableLlota === true;
  setEnableQrz.checked = s.enableQrz === true;
  setQrzUsername.value = s.qrzUsername || '';
  setQrzPassword.value = s.qrzPassword || '';
  setQrzFullName.checked = s.qrzFullName === true;
  qrzConfig.classList.toggle('hidden', !s.enableQrz);
  // QRZ Logbook
  setQrzLogbook.checked = s.qrzLogbook === true;
  setQrzApiKey.value = s.qrzApiKey || '';
  qrzLogbookConfig.classList.toggle('hidden', !s.qrzLogbook);
  updateQrzLogbookVisibility();
  // Auto-check subscription status on load if QRZ is enabled with credentials
  if (s.enableQrz && s.qrzUsername && s.qrzPassword) {
    window.api.qrzCheckSub().then(result => {
      if (result.subscriber) {
        qrzSubStatus.textContent = `XML Subscriber \u2014 expires ${result.expiry}`;
        qrzSubStatus.style.color = '#4ecca3';
        setQrzLogbook.disabled = false;
      } else if (result.error) {
        qrzSubStatus.textContent = result.error;
        qrzSubStatus.style.color = '#e94560';
      } else {
        const msg = result.expiry && result.expiry !== 'non-subscriber'
          ? `QRZ XML subscription expired (${result.expiry})`
          : 'No active QRZ XML subscription';
        qrzSubStatus.textContent = msg;
        qrzSubStatus.style.color = '#e94560';
        setQrzLogbook.disabled = true;
        setQrzLogbook.checked = false;
        qrzLogbookConfig.classList.add('hidden');
      }
    }).catch(() => {});
  }
  setEnableCluster.checked = s.enableCluster === true;
  setShowBeacons.checked = s.showBeacons === true;
  setShowDxBar.checked = s.showDxBar === true;
  showDxBar = s.showDxBar === true;
  updateDxCommandBar();
  setEnableCwSpots.checked = s.enableCwSpots === true;
  // CW Spots preset selector
  const cwSpotsPreset = document.getElementById('set-cwspots-preset');
  const cwSpotsCustom = document.getElementById('cwspots-custom-fields');
  const cwSpotsConfig = document.getElementById('cwspots-config');
  if (cwSpotsPreset) {
    const h = s.cwSpotsHost || 'rbn.telegraphy.de';
    const p = s.cwSpotsPort || 7000;
    const key = h + ':' + p;
    const match = [...cwSpotsPreset.options].find(o => o.value === key);
    cwSpotsPreset.value = match ? key : 'custom';
    if (!match) {
      document.getElementById('set-cwspots-host').value = h;
      document.getElementById('set-cwspots-port').value = p;
      cwSpotsCustom.classList.remove('hidden');
    }
  }
  if (cwSpotsConfig) cwSpotsConfig.classList.toggle('hidden', !s.enableCwSpots);
  // Restore club checkboxes
  const savedClubs = s.cwSpotsClubs || [];
  document.querySelectorAll('#cwspots-clubs input[data-club]').forEach(cb => {
    cb.checked = savedClubs.includes(cb.dataset.club);
  });
  // Restore max WPM
  const cwMaxWpmEl = document.getElementById('set-cwspots-max-wpm');
  if (cwMaxWpmEl) cwMaxWpmEl.value = s.cwSpotsMaxWpm || 0;
  // Show/hide club checkboxes based on preset (only for rbn.telegraphy.de)
  const cwClubsDiv = document.getElementById('cwspots-clubs');
  if (cwClubsDiv && cwSpotsPreset) {
    cwClubsDiv.style.display = cwSpotsPreset.value === 'rbn.telegraphy.de:7000' ? '' : 'none';
  }
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
  setEnableClusterTerminal.checked = s.enableClusterTerminal === true;
  clusterTerminalBtn.classList.toggle('hidden', !s.enableClusterTerminal);
  // Load net reminders
  currentNetReminders = Array.isArray(s.netReminders) ? JSON.parse(JSON.stringify(s.netReminders)) : [];
  renderNetList(currentNetReminders);
  netEditor.classList.add('hidden');
  netAddBtn.classList.remove('hidden');
  // Directory opt-in
  setEnableDirectory.checked = s.enableDirectory === true;
  dirControls.classList.toggle('hidden', !s.enableDirectory);
  updateDirectoryButton();
  if (dirBrowser) dirBrowser.classList.add('hidden');
  if (dirBrowseBtn) dirBrowseBtn.classList.remove('hidden');
  clusterConfig.classList.toggle('hidden', !s.enableCluster);
  rbnConfig.classList.toggle('hidden', !s.enableRbn);
  setEnableWsjtx.checked = s.enableWsjtx === true;
  setWsjtxPort.value = s.wsjtxPort || 2237;
  setWsjtxHighlight.checked = s.wsjtxHighlight !== false;
  setWsjtxAutoLog.checked = s.wsjtxAutoLog === true;
  wsjtxConfig.classList.toggle('hidden', !s.enableWsjtx);
  setEnablePskr.checked = s.enablePskr === true;
  pskrConfig.classList.toggle('hidden', !s.enablePskr);
  setEnablePskrMap.checked = s.enablePskrMap === true;
  pskrMapConfig.classList.toggle('hidden', !s.enablePskrMap);
  setEnableLogging.checked = s.enableLogging === true;
  setEnableBannerLogger.checked = s.enableBannerLogger === true;
  setN1mmRst.checked = s.n1mmRst === true;
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
  setWavelogUrl.value = s.wavelogUrl || '';
  setWavelogApiKey.value = s.wavelogApiKey || '';
  setWavelogStationId.value = s.wavelogStationId || '';
  loggingConfig.classList.toggle('hidden', !s.enableLogging);
  logbookConfig.classList.toggle('hidden', !s.sendToLogbook);
  updateLogbookPortConfig();
  setColorblind.checked = s.colorblindMode === true;
  setWcagMode.checked = s.wcagMode === true;
  setColorRows.checked = s.colorRows !== false; // default true
  setEnableSolar.checked = s.enableSolar === true;
  setEnableBandActivity.checked = s.enableBandActivity === true;
  setShowBearing.checked = s.showBearing === true;
  setEnableSplitView.checked = s.enableSplitView !== false;
  splitOrientationConfig.classList.toggle('hidden', !setEnableSplitView.checked);
  document.getElementById('set-split-orientation').value = s.splitOrientation || 'horizontal';
  setEnableDxcc.checked = s.enableDxcc === true;
  setSotaUpload.checked = s.sotaUpload === true;
  setSotaUsername.value = s.sotaUsername || '';
  setSotaPassword.value = s.sotaPassword || '';
  sotaUploadConfig.classList.toggle('hidden', !s.sotaUpload);
  setPotaParksPath.value = s.potaParksPath || '';
  potaParksClearBtn.style.display = s.potaParksPath ? '' : 'none';
  setHideWorkedParks.checked = s.hideWorkedParks === true;
  setSmartSdrSpots.checked = s.smartSdrSpots === true;
  setSmartSdrHost.value = s.smartSdrHost || '127.0.0.1';
  setSmartSdrMaxAge.value = s.smartSdrMaxAge != null ? s.smartSdrMaxAge : 15;
  setSmartSdrMaxSpots.value = s.smartSdrMaxSpots != null ? s.smartSdrMaxSpots : 0;
  smartSdrConfig.classList.toggle('hidden', !s.smartSdrSpots);
  setTciSpots.checked = s.tciSpots === true;
  setTciHost.value = s.tciHost || '127.0.0.1';
  setTciPort.value = s.tciPort || 50001;
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
  // ECHOCAT
  enableRemote = s.enableRemote === true;
  setEnableRemote.checked = enableRemote;
  remoteConfig.classList.toggle('hidden', !enableRemote);
  setRemotePort.value = s.remotePort || 7300;
  const requireToken = s.remoteRequireToken !== false; // default true for existing users
  setRemoteRequireToken.checked = requireToken;
  remoteTokenRow.classList.toggle('hidden', !requireToken);
  setRemoteToken.value = s.remoteToken || '';
  setRemotePttTimeout.value = s.remotePttTimeout || 180;
  setRemoteCwEnabled.checked = !!s.remoteCwEnabled;
  // Populate CW Key Port dropdown
  try {
    const cwPorts = await window.api.listPorts();
    setCwKeyPort.innerHTML = '<option value="">(none)</option>';
    for (const p of cwPorts) {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = `${p.path} — ${p.friendlyName}`;
      if (s.cwKeyPort === p.path) opt.selected = true;
      setCwKeyPort.appendChild(opt);
    }
  } catch { /* ports unavailable */ }
  if (enableRemote) {
    populateRemoteURLs();
  }
  updateRemoteAudioSummary(s.remoteAudioInput, s.remoteAudioOutput);
  // Remote Launcher
  if (setEnableLauncher) {
    setEnableLauncher.checked = s.enableLauncher === true;
    if (launcherConfig) launcherConfig.classList.toggle('hidden', !s.enableLauncher);
    if (s.enableLauncher) {
      try {
        const ips = await window.api.getLocalIPs();
        const tsIp = ips.find(ip => ip.tailscale);
        const lanIp = ips.find(ip => !ip.tailscale);
        const ip = tsIp || lanIp;
        if (ip && launcherUrlDisplay) launcherUrlDisplay.textContent = 'https://' + ip.address + ':7301/';
      } catch {}
      if (launcherStatus) { launcherStatus.textContent = 'Installed'; launcherStatus.style.color = '#4ecca3'; }
    }
  }
  // Club Station Mode
  setClubMode.checked = s.clubMode === true;
  setClubCsvPath.value = s.clubCsvPath || '';
  clubConfig.classList.toggle('hidden', !s.clubMode);
  clubHashStatus.textContent = '';
  if (s.clubMode && s.clubCsvPath) {
    refreshClubPreview(s.clubCsvPath);
  } else {
    clubPreview.innerHTML = '';
    clubSchedule.innerHTML = '';
  }
  updateSettingsConnBar();
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
  // Pi access (The Net easter egg) — unlock gated features if previously authorized
  if (typeof applyPiAccess === 'function') applyPiAccess(!!s.piAccess);
  // Restore settings tab (or navigate to specified tab)
  if (settingsSearch) settingsSearch.value = '';
  const targetTab = _openSettingsTab || localStorage.getItem('settings-active-tab') || 'station';
  _openSettingsTab = null;
  switchSettingsTab(targetTab);
  settingsDialog.showModal();
}

settingsCancel.addEventListener('click', async () => {
  // Revert theme to saved state on cancel
  const s = await window.api.getSettings();
  applyTheme(s.lightMode === true);
  settingsDialog.close();
});

settingsSave.addEventListener('click', async () => {
  const watchlistRaw = setWatchlist.value.trim();
  const maxAgeVal = parseInt(setMaxAge.value, 10) || 5;
  const sotaMaxAgeVal = parseInt(setSotaMaxAge.value, 10) || 30;
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
  const qrzLogbookEnabled = setQrzLogbook.checked;
  const qrzApiKeyVal = setQrzApiKey.value.trim();
  const myCallsign = setMyCallsign.value.trim().toUpperCase();
  let clusterEnabled = setEnableCluster.checked;
  let cwSpotsEnabled = setEnableCwSpots.checked;
  let rbnEnabled = setEnableRbn.checked;
  const pskrEnabled = setEnablePskr.checked;
  const pskrMapEnabled = setEnablePskrMap.checked;

  // DX Cluster and RBN require a callsign
  if (clusterEnabled && !myCallsign) {
    clusterEnabled = false;
    setEnableCluster.checked = false;
    alert('DX Cluster requires a callsign. Please enter your callsign above.');
  }
  if (cwSpotsEnabled && !myCallsign) {
    cwSpotsEnabled = false;
    setEnableCwSpots.checked = false;
    alert('CW Spots requires a callsign. Please enter your callsign above.');
  }
  if (rbnEnabled && !myCallsign) {
    rbnEnabled = false;
    setEnableRbn.checked = false;
    alert('RBN requires a callsign. Please enter your callsign above.');
  }
  let pskrMapEnabledVal = pskrMapEnabled;
  if (pskrMapEnabledVal && !myCallsign) {
    pskrMapEnabledVal = false;
    setEnablePskrMap.checked = false;
    alert('PSKReporter Map requires a callsign. Please enter your callsign above.');
  }
  const clusterNodes = currentClusterNodes;
  const showBeaconsEnabled = setShowBeacons.checked;
  const showDxBarEnabled = setShowDxBar.checked;
  showDxBar = showDxBarEnabled;
  updateDxCommandBar();
  const clusterTerminalEnabled = setEnableClusterTerminal.checked;
  clusterTerminalBtn.classList.toggle('hidden', !clusterTerminalEnabled);
  const wsjtxEnabled = setEnableWsjtx.checked;
  const wsjtxPortVal = parseInt(setWsjtxPort.value, 10) || 2237;
  const wsjtxHighlightEnabled = setWsjtxHighlight.checked;
  const wsjtxAutoLogEnabled = setWsjtxAutoLog.checked;
  const colorblindEnabled = setColorblind.checked;
  const wcagEnabled = setWcagMode.checked;
  const colorRowsEnabled = setColorRows.checked;
  const solarEnabled = setEnableSolar.checked;
  const bandActivityEnabled = setEnableBandActivity.checked;
  const showBearingEnabled = setShowBearing.checked;
  const enableSplitViewVal = setEnableSplitView.checked;
  const splitOrientationVal = document.getElementById('set-split-orientation').value;
  const dxccEnabled = setEnableDxcc.checked;
  const sotaUploadEnabled = setSotaUpload.checked;
  const sotaUsernameVal = setSotaUsername.value.trim();
  const sotaPasswordVal = setSotaPassword.value;
  const licenseClassVal = setLicenseClass.value;
  const hideOob = setHideOutOfBand.checked;
  const hideWorkedEnabled = setHideWorked.checked;
  const tuneClickEnabled = setTuneClick.checked;
  const rotorEnabledVal = setEnableRotor.checked;
  const rotorModeVal = setRotorMode ? setRotorMode.value : 'auto';
  const rotorHostVal = setRotorHost.value.trim() || '127.0.0.1';
  const rotorPortVal = parseInt(setRotorPort.value, 10) || 12040;
  const agEnabled = setEnableAg.checked;
  const agHostVal = setAgHost.value.trim();
  const agRadioPortVal = parseInt(setAgRadioPort.value, 10) || 1;
  const agBandMapVal = getAgBandMap();
  const enableSplitEnabled = setEnableSplit.checked;
  const atuEnabled = setEnableAtu.checked;
  const verboseLogEnabled = setVerboseLog.checked;
  const lightIconEnabled = setLightIcon.checked;
  const disableAutoUpdate = setDisableAutoUpdate.checked;
  const telemetryEnabled = setEnableTelemetry.checked;
  const lightModeEnabled = setLightMode.checked;
  const smartSdrSpotsEnabled = setSmartSdrSpots.checked;
  const smartSdrHostVal = setSmartSdrHost.value.trim() || '127.0.0.1';
  const smartSdrMaxAgeVal = parseInt(setSmartSdrMaxAge.value, 10) || 0;
  const smartSdrMaxSpotsVal = parseInt(setSmartSdrMaxSpots.value, 10) || 0;
  const tciSpotsEnabled = setTciSpots.checked;
  const tciHostVal = setTciHost.value.trim() || '127.0.0.1';
  const tciPortVal = parseInt(setTciPort.value, 10) || 50001;
  const tciMaxAgeVal = parseInt(setTciMaxAge.value, 10) || 0;
  // ECHOCAT
  const remoteEnabled = setEnableRemote.checked;
  const remotePortVal = parseInt(setRemotePort.value, 10) || 7300;
  const remoteRequireTokenVal = setRemoteRequireToken.checked;
  const remoteTokenVal = setRemoteToken.value;
  const remotePttTimeoutVal = parseInt(setRemotePttTimeout.value, 10) || 180;
  const remoteCwEnabledVal = setRemoteCwEnabled.checked;
  const cwKeyPortVal = setCwKeyPort.value || '';
  const launcherEnabled = setEnableLauncher ? setEnableLauncher.checked : false;
  const clubModeEnabled = setClubMode.checked;
  const clubCsvPathVal = setClubCsvPath.value || '';
  // Audio comes from the active rig (resolved after selectedRig below)
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
  const n1mmRstEnabled = setN1mmRst.checked;
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
    sotaMaxAge: sotaMaxAgeVal,
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
    qrzLogbook: qrzLogbookEnabled,
    qrzApiKey: qrzApiKeyVal,
    enableCluster: clusterEnabled,
    enableCwSpots: cwSpotsEnabled,
    cwSpotsHost: (() => { const p = document.getElementById('set-cwspots-preset'); if (!p || p.value === 'custom') return (document.getElementById('set-cwspots-host') || {}).value || 'rbn.telegraphy.de'; return p.value.split(':')[0]; })(),
    cwSpotsPort: (() => { const p = document.getElementById('set-cwspots-preset'); if (!p || p.value === 'custom') return parseInt((document.getElementById('set-cwspots-port') || {}).value, 10) || 7000; return parseInt(p.value.split(':')[1], 10) || 7000; })(),
    cwSpotsClubs: [...document.querySelectorAll('#cwspots-clubs input[data-club]:checked')].map(cb => cb.dataset.club),
    cwSpotsMaxWpm: parseInt((document.getElementById('set-cwspots-max-wpm') || {}).value, 10) || 0,
    enableRbn: rbnEnabled,
    enableWsjtx: wsjtxEnabled,
    enablePskr: pskrEnabled,
    enablePskrMap: pskrMapEnabledVal,
    wsjtxPort: wsjtxPortVal,
    wsjtxHighlight: wsjtxHighlightEnabled,
    wsjtxAutoLog: wsjtxAutoLogEnabled,
    myCallsign: myCallsign,
    clusterNodes: clusterNodes,
    netReminders: currentNetReminders,
    enableDirectory: setEnableDirectory.checked,
    showBeacons: showBeaconsEnabled,
    showDxBar: showDxBarEnabled,
    enableClusterTerminal: clusterTerminalEnabled,
    colorblindMode: colorblindEnabled,
    wcagMode: wcagEnabled,
    colorRows: colorRowsEnabled,
    enableSolar: solarEnabled,
    enableBandActivity: bandActivityEnabled,
    showBearing: showBearingEnabled,
    enableSplitView: enableSplitViewVal,
    splitOrientation: splitOrientationVal,
    enableDxcc: dxccEnabled,
    sotaUpload: sotaUploadEnabled,
    sotaUsername: sotaUsernameVal,
    sotaPassword: sotaPasswordVal,
    licenseClass: licenseClassVal,
    hideOutOfBand: hideOob,
    hideWorked: hideWorkedEnabled,
    tuneClick: tuneClickEnabled,
    enableRotor: rotorEnabledVal,
    rotorMode: rotorModeVal,
    rotorHost: rotorHostVal,
    rotorPort: rotorPortVal,
    enableAntennaGenius: agEnabled,
    agHost: agHostVal,
    agRadioPort: agRadioPortVal,
    agBandMap: agBandMapVal,
    enableSplit: enableSplitEnabled,
    enableAtu: atuEnabled,
    verboseLog: verboseLogEnabled,
    lightIcon: lightIconEnabled,
    potaParksPath: potaParksPath,
    hideWorkedParks: hideWorkedParksEnabled,
    enableLogging: loggingEnabled,
    enableBannerLogger: setEnableBannerLogger.checked,
    n1mmRst: n1mmRstEnabled,
    adifLogPath: adifLogPath,
    defaultPower: defaultPowerVal,
    sendToLogbook: sendToLogbook,
    logbookType: logbookTypeVal,
    logbookHost: logbookHostVal,
    logbookPort: logbookPortVal,
    wavelogUrl: setWavelogUrl.value.trim(),
    wavelogApiKey: setWavelogApiKey.value.trim(),
    wavelogStationId: setWavelogStationId.value.trim(),
    disableAutoUpdate: disableAutoUpdate,
    enableTelemetry: telemetryEnabled,
    lightMode: lightModeEnabled,
    smartSdrSpots: smartSdrSpotsEnabled,
    smartSdrHost: smartSdrHostVal,
    smartSdrMaxAge: smartSdrMaxAgeVal,
    smartSdrMaxSpots: smartSdrMaxSpotsVal,
    tciSpots: tciSpotsEnabled,
    tciHost: tciHostVal,
    tciPort: tciPortVal,
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
    enableRemote: remoteEnabled,
    remotePort: remotePortVal,
    remoteRequireToken: remoteRequireTokenVal,
    remoteToken: remoteTokenVal,
    remotePttTimeout: remotePttTimeoutVal,
    remoteCwEnabled: remoteCwEnabledVal,
    cwKeyPort: cwKeyPortVal,
    enableLauncher: launcherEnabled,
    clubMode: clubModeEnabled,
    clubCsvPath: clubCsvPathVal,
    remoteAudioInput: selectedRig ? (selectedRig.remoteAudioInput || '') : '',
    remoteAudioOutput: selectedRig ? (selectedRig.remoteAudioOutput || '') : '',
    appMode: document.querySelector('input[name="set-app-mode"]:checked')?.value || 'hunter',
  });
  grid = setGrid.value.trim();
  distUnit = setDistUnit.value;
  maxAgeMin = maxAgeVal;
  sotaMaxAgeMin = sotaMaxAgeVal;
  scanDwell = dwellVal;
  watchlist = parseWatchlist(watchlistRaw);
  enablePota = potaEnabled;
  enableSota = sotaEnabled;
  enableWwff = wwffEnabled;
  enableLlota = llotaEnabled;
  enableCluster = clusterEnabled;
  enableRbn = rbnEnabled;
  enablePskr = pskrEnabled;
  enablePskrMap = pskrMapEnabledVal;
  enableRemote = remoteEnabled;
  enableWsjtx = wsjtxEnabled;
  updateWsjtxStatusVisibility();
  updateRbnButton();
  updateDirectoryButton();
  // Sync rotor quick-toggle visibility
  rotorConfigured = !!rotorEnabledVal;
  quickRotorLabel.classList.toggle('hidden', !rotorConfigured);
  quickRotorDivider.classList.toggle('hidden', !rotorConfigured);
  // When enabling rotor config, default rotorActive to on
  if (rotorEnabledVal) quickRotor.checked = true;
  spotsTable.classList.toggle('no-source-tint', !colorRowsEnabled);
  applyColorblindMode(colorblindEnabled);
  applyWcagMode(wcagEnabled);
  window.api.sendColorblindMode(colorblindEnabled);
  window.api.sendWcagMode(wcagEnabled);
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
  enableBannerLogger = setEnableBannerLogger.checked;
  n1mmRst = n1mmRstEnabled;
  applyRstMode();
  defaultPower = defaultPowerVal;
  updateLoggingVisibility();
  updateBannerLoggerVisibility();
  applyTheme(lightModeEnabled);
  if (popoutOpen) window.api.sendPopoutTheme(lightModeEnabled ? 'light' : 'dark');
  if (qsoPopoutOpen) window.api.sendQsoPopoutTheme(lightModeEnabled ? 'light' : 'dark');
  if (actmapPopoutOpen) window.api.actmapPopoutTheme(lightModeEnabled ? 'light' : 'dark');
  if (spotsPopoutOpen) window.api.sendSpotsPopoutTheme(lightModeEnabled ? 'light' : 'dark');
  if (clusterPopoutOpen) window.api.sendClusterPopoutTheme(lightModeEnabled ? 'light' : 'dark');
  if (jtcatPopoutOpen) window.api.jtcatPopoutTheme(lightModeEnabled ? 'light' : 'dark');
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

/** Sync activator toolbar CAT pill with main CAT status */
function syncActivatorCatPill(className, title) {
  const el = document.getElementById('activator-cat-status');
  if (el) {
    el.className = className;
    el.style.cursor = 'pointer';
    el.style.fontSize = '11px';
    el.style.marginLeft = '4px';
    el.textContent = 'CAT';
    el.title = title;
  }
}

window.api.onCatStatus(({ connected, error, wsjtxMode }) => {
  catConnected = connected;
  // Update JTCAT PTT mode indicator
  const pttModeEl = document.getElementById('jtcat-ptt-mode');
  if (pttModeEl) {
    if (connected || wsjtxMode) {
      pttModeEl.textContent = 'PTT: CAT';
      pttModeEl.classList.remove('vox');
      pttModeEl.title = 'PTT via CAT command — radio switches TX/RX automatically';
    } else {
      pttModeEl.textContent = 'PTT: VOX';
      pttModeEl.classList.add('vox');
      pttModeEl.title = 'No CAT connected — enable VOX on your radio. Audio tones trigger TX.';
    }
  }
  if (wsjtxMode) {
    if (catDisconnectTimer) { clearTimeout(catDisconnectTimer); catDisconnectTimer = null; }
    catStatusEl.textContent = 'CAT';
    catStatusEl.className = 'status connected';
    catStatusEl.title = 'Radio controlled by WSJT-X';
    syncActivatorCatPill('status connected', 'Radio controlled by WSJT-X');
    return;
  }
  if (connected) {
    // Reconnected — cancel any pending disconnect display
    if (catDisconnectTimer) { clearTimeout(catDisconnectTimer); catDisconnectTimer = null; }
    catStatusEl.textContent = 'CAT';
    catStatusEl.className = 'status connected';
    const connTitle = activeRigName ? `Connected to ${activeRigName}` : 'Connected';
    catStatusEl.title = connTitle;
    syncActivatorCatPill('status connected', connTitle);
  } else {
    // Grace period: delay showing red so transient reconnects don't flash
    if (!catDisconnectTimer) {
      catDisconnectTimer = setTimeout(() => {
        catDisconnectTimer = null;
        catStatusEl.textContent = 'CAT';
        catStatusEl.className = 'status disconnected';
        const discTitle = error || 'Disconnected';
        catStatusEl.title = discTitle;
        syncActivatorCatPill('status disconnected', discTitle);
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
let workedQsosInitialized = false;
window.api.onWorkedQsos((entries) => {
  workedQsos = new Map(entries);
  if (!workedQsosInitialized) {
    // Seed count and pre-mark passed milestones on first load
    workedQsosInitialized = true;
    lastKnownDailyQsoCount = getTodayUtcQsoCount();
    for (const m of QSO_MILESTONES) {
      if (lastKnownDailyQsoCount >= m) celebratedMilestones.add(m);
    }
  } else {
    checkQsoMilestone();
  }
  render();
});

// --- Donor callsigns listener ---
window.api.onDonorCallsigns((list) => {
  donorCallsigns = new Set(list.map(cs => cs.toUpperCase()));
  render();
});

// --- DX Expedition callsigns listener ---
window.api.onExpeditionCallsigns((data) => {
  if (Array.isArray(data)) {
    // backward compat: plain array of callsigns
    expeditionCallsigns = new Set(data.map(cs => cs.toUpperCase()));
    expeditionMeta = new Map();
  } else {
    expeditionCallsigns = new Set((data.callsigns || []).map(cs => cs.toUpperCase()));
    expeditionMeta = new Map();
    if (data.metadata) {
      for (const [cs, m] of Object.entries(data.metadata)) {
        expeditionMeta.set(cs.toUpperCase(), m);
      }
    }
  }
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

let eventBannerSessionDismissed = false; // dismissal persists across mode switches within session

function updateEventBanner() {
  const banner = document.getElementById('event-banner');
  const message = document.getElementById('event-message');
  const progressCount = document.getElementById('event-progress-count');
  const optinBtn = document.getElementById('event-optin-btn');
  const progressBtn = document.getElementById('event-progress-btn');
  const badge = document.getElementById('event-badge');

  if (eventBannerSessionDismissed) {
    banner.classList.add('hidden');
    return;
  }

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
    eventBannerSessionDismissed = true;
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

// --- Directory (HF Nets & SWL Broadcasts) ---

function isNetActiveNow(net) {
  if (!net.startTimeUtc) return false;
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const nowMin = utcH * 60 + utcM;
  const parts = net.startTimeUtc.split(':');
  const startMin = parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
  const endMin = startMin + (net.duration || 60);
  // Check day of week
  const days = (net.days || 'Daily').toLowerCase();
  if (days !== 'daily') {
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const todayAbbr = dayNames[now.getUTCDay()];
    if (!days.includes(todayAbbr) && !days.includes(dayNames[now.getUTCDay()].substring(0, 2))) {
      return false;
    }
  }
  if (endMin > 1440) {
    // Wraps midnight
    return nowMin >= startMin || nowMin < (endMin - 1440);
  }
  return nowMin >= startMin && nowMin < endMin;
}

function isSwlOnAirNow(entry) {
  if (!entry.startTimeUtc || !entry.endTimeUtc) return false;
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const nowMin = utcH * 60 + utcM;
  const sp = entry.startTimeUtc.split(':');
  const ep = entry.endTimeUtc.split(':');
  const startMin = parseInt(sp[0], 10) * 60 + parseInt(sp[1] || '0', 10);
  let endMin = parseInt(ep[0], 10) * 60 + parseInt(ep[1] || '0', 10);
  if (entry.endTimeUtc === '24:00') endMin = 1440;
  if (endMin <= startMin) {
    // Wraps midnight
    return nowMin >= startMin || nowMin < endMin;
  }
  return nowMin >= startMin && nowMin < endMin;
}

// === Directory View (top-level) ===

function freqToBandDir(khz) {
  const f = parseFloat(khz);
  if (!f) return '';
  if (f >= 1800 && f <= 2000) return '160m';
  if (f >= 3500 && f <= 4000) return '80m';
  if (f >= 5330 && f <= 5410) return '60m';
  if (f >= 7000 && f <= 7300) return '40m';
  if (f >= 10100 && f <= 10150) return '30m';
  if (f >= 14000 && f <= 14350) return '20m';
  if (f >= 18068 && f <= 18168) return '17m';
  if (f >= 21000 && f <= 21450) return '15m';
  if (f >= 24890 && f <= 24990) return '12m';
  if (f >= 28000 && f <= 29700) return '10m';
  if (f >= 50000 && f <= 54000) return '6m';
  if (f >= 144000 && f <= 148000) return '2m';
  if (f >= 530 && f <= 1700) return 'MW';
  if (f >= 2300 && f <= 26100) return 'SW';
  return '';
}

function getNetCountdown(net) {
  // Returns { status: 'live'|'soon'|'today'|'off', label: string, sortKey: number }
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const nowMin = utcH * 60 + utcM;
  const parts = (net.startTimeUtc || '0:0').split(':');
  const startMin = parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
  const dur = net.duration || 60;
  const endMin = startMin + dur;
  const days = (net.days || 'Daily').toLowerCase();

  // Check if scheduled today
  let scheduledToday = days === 'daily';
  if (!scheduledToday) {
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const todayAbbr = dayNames[now.getUTCDay()];
    scheduledToday = days.includes(todayAbbr);
  }

  if (!scheduledToday) {
    return { status: 'off', label: '', sortKey: 9999 };
  }

  // Check if on-air
  let onAir = false;
  if (endMin > 1440) {
    onAir = nowMin >= startMin || nowMin < (endMin - 1440);
  } else {
    onAir = nowMin >= startMin && nowMin < endMin;
  }

  if (onAir) {
    const remaining = endMin > 1440 && nowMin < startMin
      ? (endMin - 1440) - nowMin
      : (endMin > 1440 ? endMin - 1440 - nowMin : endMin - nowMin);
    const rh = Math.floor(remaining / 60);
    const rm = remaining % 60;
    const timeLeft = rh > 0 ? `${rh}h ${rm}m left` : `${rm}m left`;
    return { status: 'live', label: `On air \u2014 ${timeLeft}`, sortKey: -1000 + nowMin - startMin };
  }

  // Upcoming today
  let minsUntil = startMin - nowMin;
  if (minsUntil < 0) minsUntil += 1440; // past for today, would be tomorrow
  if (minsUntil < 0 || minsUntil > 1440) {
    return { status: 'today', label: `${parts[0].padStart(2,'0')}:${(parts[1]||'00').padStart(2,'0')} UTC`, sortKey: minsUntil };
  }
  if (minsUntil <= 60) {
    return { status: 'soon', label: `in ${minsUntil}m`, sortKey: minsUntil };
  }
  const h = Math.floor(minsUntil / 60);
  const m = minsUntil % 60;
  const timeStr = m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  return { status: minsUntil <= 120 ? 'soon' : 'today', label: timeStr, sortKey: minsUntil };
}

function getSwlCountdown(entry) {
  if (!entry.startTimeUtc || !entry.endTimeUtc) return { status: 'off', label: '', sortKey: 9999 };
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const sp = entry.startTimeUtc.split(':');
  const ep = entry.endTimeUtc.split(':');
  const startMin = parseInt(sp[0], 10) * 60 + parseInt(sp[1] || '0', 10);
  let endMin = parseInt(ep[0], 10) * 60 + parseInt(ep[1] || '0', 10);
  if (entry.endTimeUtc === '24:00') endMin = 1440;

  let onAir;
  if (endMin <= startMin) {
    onAir = nowMin >= startMin || nowMin < endMin;
  } else {
    onAir = nowMin >= startMin && nowMin < endMin;
  }

  if (onAir) {
    const effEnd = endMin <= startMin && nowMin < endMin ? endMin : endMin;
    const remaining = effEnd > nowMin ? effEnd - nowMin : effEnd + 1440 - nowMin;
    const rh = Math.floor(remaining / 60);
    const rm = remaining % 60;
    const timeLeft = rh > 0 ? `${rh}h ${rm}m left` : `${rm}m left`;
    return { status: 'live', label: `On air \u2014 ${timeLeft}`, sortKey: -1000 };
  }

  let minsUntil = startMin - nowMin;
  if (minsUntil < 0) minsUntil += 1440;
  if (minsUntil <= 60) return { status: 'soon', label: `in ${minsUntil}m`, sortKey: minsUntil };
  const h = Math.floor(minsUntil / 60);
  const m = minsUntil % 60;
  const timeStr = m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  return { status: minsUntil <= 120 ? 'soon' : 'today', label: timeStr, sortKey: minsUntil };
}

let dirvInited = false;
function renderDirectoryView() {
  if (!directoryView || directoryView.classList.contains('hidden')) return;
  const search = (dirvSearch ? dirvSearch.value : '').toLowerCase().trim();
  const bandFilter = dirvBandFilter ? dirvBandFilter.value : 'all';
  const statusFilter = dirvStatusFilter ? dirvStatusFilter.value : 'all';

  if (dirvActiveTab === 'nets') {
    renderDirvNets(search, bandFilter, statusFilter);
    const table = dirvNetsContainer?.querySelector('.directory-view-table');
    if (table) {
      initDirvColumnResizing(table);
      applyDirvHiddenCols(table);
      if (!table._dirvMenuInited) { initDirvHeaderMenu(table); table._dirvMenuInited = true; }
    }
  } else {
    renderDirvSwl(search, bandFilter, statusFilter);
    const table = dirvSwlContainer?.querySelector('.directory-view-table');
    if (table) {
      initDirvColumnResizing(table);
      applyDirvHiddenCols(table);
      if (!table._dirvMenuInited) { initDirvHeaderMenu(table); table._dirvMenuInited = true; }
    }
  }
}

function renderDirvNets(search, bandFilter, statusFilter) {
  if (!dirvNetsBody) return;
  dirvNetsBody.innerHTML = '';
  // Merge community directory nets + user custom nets
  let entries = [];
  // Community nets
  for (const net of directoryNets) {
    const band = freqToBandDir(net.frequency);
    const cd = getNetCountdown(net);
    entries.push({ ...net, band, _cd: cd, _src: 'community' });
  }
  // User custom net reminders
  for (const nr of currentNetReminders) {
    // Skip if it matches a community net (avoid duplicates)
    const isDup = directoryNets.some(d => d.name === nr.name && String(d.frequency) === String(nr.frequency));
    if (isDup) continue;
    const band = freqToBandDir(nr.frequency);
    // Build a fake directory entry from the reminder
    const days = nr.schedule?.type === 'daily' ? 'Daily' :
      nr.schedule?.type === 'weekly' ? (nr.schedule.days || []).map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(',') : 'Custom';
    const fakeNet = {
      name: nr.name, frequency: nr.frequency, mode: nr.mode || 'SSB',
      days, startTimeUtc: nr.startTime, duration: nr.duration || 60,
      region: '', notes: '(My Net)', band,
      _cd: getNetCountdown({ startTimeUtc: nr.startTime, days, duration: nr.duration || 60 }),
      _src: 'user', _netId: nr.id
    };
    entries.push(fakeNet);
  }

  // Filter
  if (search) {
    entries = entries.filter(n =>
      (n.name || '').toLowerCase().includes(search) ||
      (n.region || '').toLowerCase().includes(search) ||
      (n.notes || '').toLowerCase().includes(search) ||
      (n.mode || '').toLowerCase().includes(search) ||
      String(n.frequency).includes(search)
    );
  }
  if (bandFilter !== 'all') {
    entries = entries.filter(n => n.band === bandFilter);
  }
  if (statusFilter === 'live') {
    entries = entries.filter(n => n._cd.status === 'live');
  } else if (statusFilter === 'today') {
    entries = entries.filter(n => n._cd.status !== 'off');
  }

  // Sort: live first, then soon, then today by countdown, then off alphabetically
  entries.sort((a, b) => {
    if (a._cd.sortKey !== b._cd.sortKey) return a._cd.sortKey - b._cd.sortKey;
    return (a.name || '').localeCompare(b.name || '');
  });

  if (dirvCount) dirvCount.textContent = `${entries.length} net${entries.length !== 1 ? 's' : ''}`;

  if (entries.length === 0) {
    if (dirvPlaceholder) {
      dirvPlaceholder.textContent = directoryNets.length === 0 ? 'Loading directory data...' : 'No matching nets found.';
      dirvPlaceholder.classList.remove('hidden');
    }
    return;
  }
  if (dirvPlaceholder) dirvPlaceholder.classList.add('hidden');

  const lsbBands = new Set(['160m', '80m', '60m', '40m']);

  for (const net of entries) {
    const tr = document.createElement('tr');
    const cd = net._cd;
    if (cd.status === 'live') tr.classList.add('dirv-on-air');
    else if (cd.status === 'soon') tr.classList.add('dirv-upcoming');

    const statusBadge = cd.status === 'live' ? '<span class="dirv-status-badge live">Live</span>'
      : cd.status === 'soon' ? '<span class="dirv-status-badge soon">Soon</span>'
      : cd.status === 'today' ? '<span class="dirv-status-badge today">Today</span>'
      : '<span class="dirv-status-badge off">\u2014</span>';

    const nextLabel = cd.label
      ? `<span class="dirv-next-countdown${cd.status === 'live' ? ' live' : ''}">${esc(cd.label)}</span>`
      : '\u2014';

    const duration = net.duration ? `${net.duration}m` : '';
    const alreadyAdded = net._src === 'user' || currentNetReminders.some(r =>
      r.name === net.name && String(r.frequency) === String(net.frequency)
    );
    const actionCell = alreadyAdded
      ? '<span class="dir-added-label">\u2713</span>'
      : '<button class="dir-add-btn" type="button">+ Add</button>';

    tr.innerHTML = `<td class="dirv-status-col">${statusBadge}</td>`
      + `<td class="dirv-name-col">${esc(net.name)}</td>`
      + `<td class="dirv-freq-col">${net.frequency || ''}</td>`
      + `<td class="dirv-mode-col">${esc(net.mode)}</td>`
      + `<td class="dirv-band-col">${esc(net.band)}</td>`
      + `<td class="dirv-days-col">${esc(net.days)}</td>`
      + `<td class="dirv-time-col">${esc(net.startTimeUtc)}</td>`
      + `<td class="dirv-next-col">${nextLabel}</td>`
      + `<td class="dirv-dur-col">${duration}</td>`
      + `<td class="dirv-region-col">${esc(net.region)}</td>`
      + `<td class="dirv-notes-col">${esc(net.notes)}</td>`
      + `<td class="dirv-action-col">${actionCell}</td>`;

    // Click row to tune
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.dir-add-btn')) return; // don't tune on Add click
      const freq = String(net.frequency);
      if (!freq) return;
      let mode = (net.mode || '').toUpperCase();
      if (mode === 'SSB') {
        const band = net.band;
        mode = lsbBands.has(band) ? 'LSB' : 'USB';
      }
      window.api.tune(freq, mode);
    });

    // Hover popup
    attachDirHover(tr, [
      { label: 'Net', value: net.name },
      { label: 'Frequency', value: net.frequency ? `${net.frequency} kHz` : '' },
      { label: 'Mode', value: net.mode },
      { label: 'Schedule', value: `${net.days || 'Daily'} at ${net.startTimeUtc || '?'} UTC` },
      { label: 'Duration', value: duration },
      { label: 'Region', value: net.region },
      { label: 'Notes', value: net.notes },
    ]);

    // Add button
    const addBtn = tr.querySelector('.dir-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addDirectoryNetToReminders(net);
        renderDirectoryView();
        renderNetList(currentNetReminders);
        // Persist immediately so the net reminder survives app restart
        window.api.saveSettings({ netReminders: currentNetReminders });
      });
    }

    dirvNetsBody.appendChild(tr);
  }
}

function renderDirvSwl(search, bandFilter, statusFilter) {
  if (!dirvSwlBody) return;
  dirvSwlBody.innerHTML = '';
  let entries = [];
  for (const entry of directorySwl) {
    const band = freqToBandDir(entry.frequency);
    const cd = getSwlCountdown(entry);
    entries.push({ ...entry, band, _cd: cd });
  }

  if (search) {
    entries = entries.filter(e =>
      (e.station || '').toLowerCase().includes(search) ||
      (e.language || '').toLowerCase().includes(search) ||
      (e.regionTarget || '').toLowerCase().includes(search) ||
      (e.notes || '').toLowerCase().includes(search) ||
      String(e.frequency).includes(search)
    );
  }
  if (bandFilter !== 'all') {
    entries = entries.filter(e => e.band === bandFilter);
  }
  if (statusFilter === 'live') {
    entries = entries.filter(e => e._cd.status === 'live');
  } else if (statusFilter === 'today') {
    entries = entries.filter(e => e._cd.status !== 'off');
  }

  entries.sort((a, b) => {
    if (a._cd.sortKey !== b._cd.sortKey) return a._cd.sortKey - b._cd.sortKey;
    return (a.station || '').localeCompare(b.station || '');
  });

  if (dirvCount) dirvCount.textContent = `${entries.length} broadcast${entries.length !== 1 ? 's' : ''}`;

  if (entries.length === 0) {
    if (dirvPlaceholder) {
      dirvPlaceholder.textContent = directorySwl.length === 0 ? 'Loading directory data...' : 'No matching broadcasts found.';
      dirvPlaceholder.classList.remove('hidden');
    }
    return;
  }
  if (dirvPlaceholder) dirvPlaceholder.classList.add('hidden');

  for (const entry of entries) {
    const tr = document.createElement('tr');
    const cd = entry._cd;
    if (cd.status === 'live') tr.classList.add('dirv-on-air');
    else if (cd.status === 'soon') tr.classList.add('dirv-upcoming');

    const statusBadge = cd.status === 'live' ? '<span class="dirv-status-badge live">Live</span>'
      : cd.status === 'soon' ? '<span class="dirv-status-badge soon">Soon</span>'
      : cd.status === 'today' ? '<span class="dirv-status-badge today">Today</span>'
      : '<span class="dirv-status-badge off">\u2014</span>';

    const nextLabel = cd.label
      ? `<span class="dirv-next-countdown${cd.status === 'live' ? ' live' : ''}">${esc(cd.label)}</span>`
      : '\u2014';

    const powerStr = entry.powerKw ? `${entry.powerKw} kW` : '';

    tr.innerHTML = `<td class="dirv-status-col">${statusBadge}</td>`
      + `<td class="dirv-name-col">${esc(entry.station)}</td>`
      + `<td class="dirv-freq-col">${entry.frequency || ''}</td>`
      + `<td class="dirv-mode-col">${esc(entry.mode)}</td>`
      + `<td class="dirv-band-col">${esc(entry.band)}</td>`
      + `<td class="dirv-time-col">${esc(entry.startTimeUtc)}</td>`
      + `<td class="dirv-time-col">${esc(entry.endTimeUtc)}</td>`
      + `<td class="dirv-next-col">${nextLabel}</td>`
      + `<td class="dirv-lang-col">${esc(entry.language)}</td>`
      + `<td class="dirv-power-col">${powerStr}</td>`
      + `<td class="dirv-region-col">${esc(entry.regionTarget)}</td>`
      + `<td class="dirv-notes-col">${esc(entry.notes)}</td>`;

    // Click row to tune
    tr.addEventListener('click', () => {
      const freq = String(entry.frequency);
      if (!freq) return;
      window.api.tune(freq, (entry.mode || 'AM').toUpperCase());
    });

    attachDirHover(tr, [
      { label: 'Station', value: entry.station },
      { label: 'Frequency', value: entry.frequency ? `${entry.frequency} kHz` : '' },
      { label: 'Mode', value: entry.mode },
      { label: 'Schedule', value: `${entry.startTimeUtc || '?'} \u2013 ${entry.endTimeUtc || '?'} UTC` },
      { label: 'Language', value: entry.language },
      { label: 'Power', value: powerStr },
      { label: 'Target', value: entry.regionTarget },
      { label: 'Notes', value: entry.notes },
    ]);

    dirvSwlBody.appendChild(tr);
  }
}

// Auto-refresh countdowns every 30s while directory view is open
function startDirvAutoRefresh() {
  stopDirvAutoRefresh();
  dirvAutoRefreshTimer = setInterval(() => {
    if (currentView === 'directory') renderDirectoryView();
  }, 30000);
}
function stopDirvAutoRefresh() {
  if (dirvAutoRefreshTimer) { clearInterval(dirvAutoRefreshTimer); dirvAutoRefreshTimer = null; }
}

// --- Directory View: Column Resize & Visibility ---
const DIRV_COL_KEY = 'dirv-col-widths';
const DIRV_HIDDEN_KEY = 'dirv-hidden-cols';

const DIRV_NETS_COLS = ['status','name','freq','mode','band','days','time','next','dur','region','notes','action'];
const DIRV_SWL_COLS = ['status','name','freq','mode','band','startTime','endTime','next','lang','power','region','notes'];

const DIRV_DEFAULT_WIDTHS = {
  status: 70, name: 0, freq: 90, mode: 50, band: 50, days: 100,
  time: 80, next: 90, dur: 40, region: 110, notes: 0, action: 60,
  startTime: 80, endTime: 80, lang: 60, power: 60
};

function loadDirvColWidths() {
  try { const s = JSON.parse(localStorage.getItem(DIRV_COL_KEY)); if (s) return s; } catch {}
  return {};
}
function saveDirvColWidths(w) { localStorage.setItem(DIRV_COL_KEY, JSON.stringify(w)); }
function loadDirvHiddenCols() {
  try { const s = JSON.parse(localStorage.getItem(DIRV_HIDDEN_KEY)); if (Array.isArray(s)) return new Set(s); } catch {}
  return new Set();
}
function saveDirvHiddenCols(s) { localStorage.setItem(DIRV_HIDDEN_KEY, JSON.stringify([...s])); }

let dirvColWidths = loadDirvColWidths();
let dirvHiddenCols = loadDirvHiddenCols();

function initDirvColumnResizing(table) {
  if (!table) return;
  const ths = table.querySelectorAll('thead th');
  ths.forEach(th => {
    // Remove any old handle
    const old = th.querySelector('.col-resize-handle');
    if (old) old.remove();

    const col = th.dataset.dirCol;
    if (!col) return;

    // Apply saved width
    if (dirvColWidths[col]) th.style.width = dirvColWidths[col] + 'px';

    // Apply hidden state
    th.classList.toggle('dirv-col-hidden', dirvHiddenCols.has(col));

    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.style.position = 'relative';
    th.appendChild(handle);

    handle.addEventListener('dragstart', (e) => e.preventDefault());
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = th.offsetWidth;
      document.body.style.cursor = 'col-resize';

      const onMove = (ev) => {
        const w = Math.max(30, startW + ev.clientX - startX);
        th.style.width = w + 'px';
        dirvColWidths[col] = w;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        saveDirvColWidths(dirvColWidths);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

function applyDirvHiddenCols(table) {
  if (!table) return;
  const ths = table.querySelectorAll('thead th');
  const colIndices = new Map();
  ths.forEach((th, i) => {
    const col = th.dataset.dirCol;
    if (!col) return;
    const hidden = dirvHiddenCols.has(col);
    th.classList.toggle('dirv-col-hidden', hidden);
    colIndices.set(i, hidden);
  });
  table.querySelectorAll('tbody tr').forEach(tr => {
    const tds = tr.querySelectorAll('td');
    colIndices.forEach((hidden, i) => {
      if (tds[i]) tds[i].classList.toggle('dirv-col-hidden', hidden);
    });
  });
}

// Right-click context menu on header to toggle columns
let dirvColMenu = null;
function showDirvColMenu(e, table) {
  e.preventDefault();
  closeDirvColMenu();
  const ths = table.querySelectorAll('thead th[data-dir-col]');
  const menu = document.createElement('div');
  menu.className = 'dirv-col-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  ths.forEach(th => {
    const col = th.dataset.dirCol;
    const label = th.textContent.replace(/\s+/g, ' ').trim();
    if (!col || !label) return;
    const item = document.createElement('label');
    item.className = 'dirv-col-menu-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !dirvHiddenCols.has(col);
    cb.addEventListener('change', () => {
      if (cb.checked) dirvHiddenCols.delete(col);
      else dirvHiddenCols.add(col);
      saveDirvHiddenCols(dirvHiddenCols);
      applyDirvHiddenCols(table);
    });
    item.appendChild(cb);
    item.appendChild(document.createTextNode(' ' + label));
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  dirvColMenu = menu;
  // Keep within viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

  setTimeout(() => {
    document.addEventListener('click', closeDirvColMenu, { once: true });
  }, 0);
}
function closeDirvColMenu() {
  if (dirvColMenu) { dirvColMenu.remove(); dirvColMenu = null; }
}

// Attach context menu to both directory tables
function initDirvHeaderMenu(table) {
  if (!table) return;
  const thead = table.querySelector('thead');
  if (thead) thead.addEventListener('contextmenu', (e) => showDirvColMenu(e, table));
}

// Directory view tab switching
if (dirvTabNets) dirvTabNets.addEventListener('click', () => {
  dirvActiveTab = 'nets';
  dirvTabNets.classList.add('active');
  dirvTabSwl.classList.remove('active');
  dirvNetsContainer.classList.remove('hidden');
  dirvSwlContainer.classList.add('hidden');
  renderDirectoryView();
});
if (dirvTabSwl) dirvTabSwl.addEventListener('click', () => {
  dirvActiveTab = 'swl';
  dirvTabSwl.classList.add('active');
  dirvTabNets.classList.remove('active');
  dirvSwlContainer.classList.remove('hidden');
  dirvNetsContainer.classList.add('hidden');
  renderDirectoryView();
});

// Directory view filters
if (dirvSearch) dirvSearch.addEventListener('input', () => renderDirectoryView());
if (dirvBandFilter) dirvBandFilter.addEventListener('change', () => renderDirectoryView());
if (dirvStatusFilter) dirvStatusFilter.addEventListener('change', () => renderDirectoryView());
if (dirvRefreshBtn) dirvRefreshBtn.addEventListener('click', () => { window.api.fetchDirectory(); });
if (dirvSuggestSheet) dirvSuggestSheet.addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal(DIR_SHEET_URL);
});

function updateDirectoryButton() {
  if (!viewDirectoryBtn) return;
  // Show when directory is enabled, OR user has custom net reminders
  const show = setEnableDirectory?.checked || (currentNetReminders && currentNetReminders.length > 0);
  viewDirectoryBtn.classList.toggle('hidden', !show);
  if (!show && currentView === 'directory') setView('table');
}

function renderDirectory() {
  if (!dirBrowser || dirBrowser.classList.contains('hidden')) return;
  const search = (dirSearchInput.value || '').toLowerCase().trim();
  if (dirActiveTab === 'nets') {
    renderNetsTable(search);
  } else {
    renderSwlTable(search);
  }
}

function renderNetsTable(search) {
  dirNetsBody.innerHTML = '';
  let filtered = directoryNets;
  if (search) {
    filtered = filtered.filter(n =>
      (n.name || '').toLowerCase().includes(search) ||
      (n.region || '').toLowerCase().includes(search) ||
      (n.notes || '').toLowerCase().includes(search) ||
      (n.mode || '').toLowerCase().includes(search) ||
      String(n.frequency).includes(search)
    );
  }
  if (filtered.length === 0) {
    dirPlaceholder.textContent = directoryNets.length === 0 ? 'Loading directory data...' : 'No matching nets found.';
    dirPlaceholder.classList.remove('hidden');
    return;
  }
  dirPlaceholder.classList.add('hidden');
  // Sort: on-air first, then by name
  filtered.sort((a, b) => {
    const aOn = isNetActiveNow(a) ? 0 : 1;
    const bOn = isNetActiveNow(b) ? 0 : 1;
    if (aOn !== bOn) return aOn - bOn;
    return (a.name || '').localeCompare(b.name || '');
  });
  for (const net of filtered) {
    const tr = document.createElement('tr');
    const onAir = isNetActiveNow(net);
    const dot = onAir ? '<span class="dir-status-dot on-air"></span>' : '<span class="dir-status-dot"></span>';
    const nameCell = net.url
      ? `<a class="dir-name-link" href="#" data-url="${net.url.replace(/"/g, '&quot;')}">${esc(net.name)}</a>`
      : esc(net.name);
    const duration = net.duration ? `${net.duration}m` : '';
    const alreadyAdded = currentNetReminders.some(r =>
      r.name === net.name && r.frequency === net.frequency
    );
    const actionCell = alreadyAdded
      ? '<span class="dir-added-label">Added</span>'
      : '<button class="dir-add-btn" type="button">+ Add</button>';
    tr.innerHTML = `<td class="dir-status-col">${dot}</td>`
      + `<td class="dir-name-col">${nameCell}</td>`
      + `<td class="dir-freq-col">${net.frequency || ''}</td>`
      + `<td class="dir-mode-col">${esc(net.mode)}</td>`
      + `<td class="dir-days-col">${esc(net.days)}</td>`
      + `<td class="dir-time-col">${esc(net.startTimeUtc)}</td>`
      + `<td class="dir-dur-col">${duration}</td>`
      + `<td class="dir-region-col">${esc(net.region)}</td>`
      + `<td class="dir-notes-col">${esc(net.notes)}</td>`
      + `<td class="dir-action-col">${actionCell}</td>`;
    // Hover popup
    attachDirHover(tr, [
      { label: 'Net', value: net.name },
      { label: 'Frequency', value: net.frequency ? `${net.frequency} kHz` : '' },
      { label: 'Mode', value: net.mode },
      { label: 'Schedule', value: `${net.days || 'Daily'} at ${net.startTimeUtc || '?'} UTC` },
      { label: 'Duration', value: duration },
      { label: 'Region', value: net.region },
      { label: 'Notes', value: net.notes },
    ]);
    // Add to My Nets
    const addBtn = tr.querySelector('.dir-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        addDirectoryNetToReminders(net);
        renderDirectory();
        renderNetList(currentNetReminders);
        // Persist immediately so the net reminder survives app restart
        window.api.saveSettings({ netReminders: currentNetReminders });
      });
    }
    // URL link
    const link = tr.querySelector('.dir-name-link');
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        window.api.openExternal(link.dataset.url);
      });
    }
    dirNetsBody.appendChild(tr);
  }
}

function renderSwlTable(search) {
  dirSwlBody.innerHTML = '';
  let filtered = directorySwl;
  if (search) {
    filtered = filtered.filter(e =>
      (e.station || '').toLowerCase().includes(search) ||
      (e.language || '').toLowerCase().includes(search) ||
      (e.regionTarget || '').toLowerCase().includes(search) ||
      (e.notes || '').toLowerCase().includes(search) ||
      String(e.frequency).includes(search)
    );
  }
  if (filtered.length === 0) {
    dirPlaceholder.textContent = directorySwl.length === 0 ? 'Loading directory data...' : 'No matching broadcasts found.';
    dirPlaceholder.classList.remove('hidden');
    return;
  }
  dirPlaceholder.classList.add('hidden');
  // Sort: on-air first, then by station name
  filtered.sort((a, b) => {
    const aOn = isSwlOnAirNow(a) ? 0 : 1;
    const bOn = isSwlOnAirNow(b) ? 0 : 1;
    if (aOn !== bOn) return aOn - bOn;
    return (a.station || '').localeCompare(b.station || '');
  });
  for (const entry of filtered) {
    const tr = document.createElement('tr');
    const onAir = isSwlOnAirNow(entry);
    const dot = onAir ? '<span class="dir-status-dot on-air"></span>' : '<span class="dir-status-dot"></span>';
    const powerStr = entry.powerKw ? `${entry.powerKw} kW` : '';
    tr.innerHTML = `<td class="dir-status-col">${dot}</td>`
      + `<td class="dir-name-col">${esc(entry.station)}</td>`
      + `<td class="dir-freq-col">${entry.frequency || ''}</td>`
      + `<td class="dir-mode-col">${esc(entry.mode)}</td>`
      + `<td class="dir-time-col">${esc(entry.startTimeUtc)}</td>`
      + `<td class="dir-time-col">${esc(entry.endTimeUtc)}</td>`
      + `<td class="dir-lang-col">${esc(entry.language)}</td>`
      + `<td class="dir-power-col">${powerStr}</td>`
      + `<td class="dir-region-col">${esc(entry.regionTarget)}</td>`
      + `<td class="dir-notes-col">${esc(entry.notes)}</td>`;
    // Hover popup
    attachDirHover(tr, [
      { label: 'Station', value: entry.station },
      { label: 'Frequency', value: entry.frequency ? `${entry.frequency} kHz` : '' },
      { label: 'Mode', value: entry.mode },
      { label: 'Schedule', value: `${entry.startTimeUtc || '?'} \u2013 ${entry.endTimeUtc || '?'} UTC` },
      { label: 'Language', value: entry.language },
      { label: 'Power', value: powerStr },
      { label: 'Target', value: entry.regionTarget },
      { label: 'Notes', value: entry.notes },
    ]);
    dirSwlBody.appendChild(tr);
  }
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Hover popup for directory rows
let dirHoverTimer = null;
function attachDirHover(tr, fields) {
  tr.addEventListener('mouseenter', (e) => {
    dirHoverTimer = setTimeout(() => {
      if (!dirHoverPopup) return;
      let html = '';
      for (const f of fields) {
        if (!f.value) continue;
        html += `<div class="dir-popup-field"><span class="dir-popup-label">${esc(f.label)}</span><br>${esc(f.value)}</div>`;
      }
      if (!html) return;
      dirHoverPopup.innerHTML = html;
      dirHoverPopup.classList.remove('hidden');
      // Position near cursor, keep within viewport
      const rect = dirHoverPopup.getBoundingClientRect();
      let x = e.clientX + 12;
      let y = e.clientY + 12;
      if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - 12;
      if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - 12;
      dirHoverPopup.style.left = x + 'px';
      dirHoverPopup.style.top = y + 'px';
    }, 350);
  });
  tr.addEventListener('mouseleave', () => {
    clearTimeout(dirHoverTimer);
    if (dirHoverPopup) dirHoverPopup.classList.add('hidden');
  });
  tr.addEventListener('mousemove', (e) => {
    if (!dirHoverPopup || dirHoverPopup.classList.contains('hidden')) return;
    const rect = dirHoverPopup.getBoundingClientRect();
    let x = e.clientX + 12;
    let y = e.clientY + 12;
    if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - 12;
    if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - 12;
    dirHoverPopup.style.left = x + 'px';
    dirHoverPopup.style.top = y + 'px';
  });
}

// Google Sheet suggestion link
if (dirSuggestSheet) dirSuggestSheet.addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal(DIR_SHEET_URL);
});

// Add a directory net to My Net Reminders
function addDirectoryNetToReminders(net) {
  // Parse days from the directory entry to build a schedule
  const daysStr = (net.days || 'Daily').toLowerCase();
  let schedule;
  if (daysStr === 'daily') {
    schedule = { type: 'daily' };
  } else {
    const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const dayNums = [];
    for (const [abbr, num] of Object.entries(dayMap)) {
      if (daysStr.includes(abbr)) dayNums.push(num);
    }
    schedule = dayNums.length > 0 ? { type: 'weekly', days: dayNums } : { type: 'daily' };
  }
  const newNet = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: net.name,
    frequency: net.frequency,
    mode: net.mode || 'SSB',
    startTime: net.startTimeUtc || '00:00',
    timeZone: 'utc',
    duration: net.duration || 60,
    leadTime: 15,
    schedule,
    enabled: true,
  };
  currentNetReminders.push(newNet);
}

// Directory tab switching
if (dirTabNets) dirTabNets.addEventListener('click', () => {
  dirActiveTab = 'nets';
  dirTabNets.classList.add('active');
  dirTabSwl.classList.remove('active');
  dirNetsContainer.classList.remove('hidden');
  dirSwlContainer.classList.add('hidden');
  renderDirectory();
});
if (dirTabSwl) dirTabSwl.addEventListener('click', () => {
  dirActiveTab = 'swl';
  dirTabSwl.classList.add('active');
  dirTabNets.classList.remove('active');
  dirSwlContainer.classList.remove('hidden');
  dirNetsContainer.classList.add('hidden');
  renderDirectory();
});

// Directory search
if (dirSearchInput) dirSearchInput.addEventListener('input', () => { renderDirectory(); });

// Directory refresh button
if (dirRefreshBtn) dirRefreshBtn.addEventListener('click', () => { window.api.fetchDirectory(); });

// Directory opt-in checkbox
if (setEnableDirectory) setEnableDirectory.addEventListener('change', () => {
  const on = setEnableDirectory.checked;
  dirControls.classList.toggle('hidden', !on);
  if (!on && dirBrowser) {
    dirBrowser.classList.add('hidden');
    dirBrowseBtn.classList.remove('hidden');
  }
});

// Browse / close directory browser — now opens the full Directory View
if (dirBrowseBtn) dirBrowseBtn.addEventListener('click', () => {
  if (directoryNets.length === 0 && directorySwl.length === 0) {
    window.api.fetchDirectory();
  }
  settingsDialog.close();
  setView('directory');
});
if (dirCloseBtn) dirCloseBtn.addEventListener('click', () => {
  dirBrowser.classList.add('hidden');
  dirBrowseBtn.classList.remove('hidden');
});

// Receive directory data from main process
window.api.onDirectoryData((data) => {
  directoryNets = data.nets || [];
  directorySwl = data.swl || [];
  renderDirectory();
  renderDirectoryView();
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

// WSJT-X QSO logged while in activator mode — add to activator contact list
window.api.onWsjtxActivatorQso((contact) => {
  if (appMode !== 'activator' || !activationActive) return;
  activatorContacts.push(contact);
  renderActivatorLog();
  updateActivatorCounter();
  // Push to activation map pop-out
  if (actmapPopoutOpen) {
    window.api.actmapPopoutContact({
      parkRefs: activatorParkRefs.map(p => p.ref),
      contact,
    });
  }
  // Fire-and-forget QRZ lookup for name + grid + state
  window.api.qrzLookup(contact.callsign).then(info => {
    if (info) {
      contact.name = qrzDisplayName(info);
      if (info.grid) contact.grid = info.grid;
      if (!contact.state && info.state) contact.state = info.state;
      renderActivatorLog();
      if (actmapPopoutOpen && info.grid) {
        window.api.actmapPopoutContact({
          parkRefs: activatorParkRefs.map(p => p.ref),
          contact,
          update: true,
        });
      }
    }
  }).catch(() => {});
});

// --- Radio frequency tracking ---
window.api.onCatFrequency((hz) => {
  const newKhz = Math.round(hz / 1000);
  if (newKhz === radioFreqKhz) return;
  const oldBand = radioFreqKhz ? freqToBandActivator(radioFreqKhz) : null;
  radioFreqKhz = newKhz;
  const newBand = freqToBandActivator(newKhz);
  // Update band filter text and re-filter when band changes in Radio mode
  const radioBandCb = bandFilterEl.querySelector('input[value="radio"]');
  if (radioBandCb && radioBandCb.checked) {
    if (newBand !== oldBand && bandFilterEl._updateText) bandFilterEl._updateText();
    updateBandButtonActive();
  }
  playTuneClick();
  updateBlFreqFromRadio();
  if (showTable || showMap) render();
});

window.api.onCatMode((mode) => {
  const oldFilter = radioMode ? radioModeToFilter(radioMode) : null;
  radioMode = mode;
  const newFilter = radioModeToFilter(mode);
  updateBlModeFromRadio();
  const radioModeCb = modeFilterEl.querySelector('input[value="radio"]');
  if (radioModeCb && radioModeCb.checked && newFilter !== oldFilter) {
    if (modeFilterEl._updateText) modeFilterEl._updateText();
    if (showTable || showMap) render();
  }
});

let radioPower = 0; // last known TX power from CAT (watts)
let lastLogPower = 0; // last power value entered by user in log dialog (sticky)
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
const HEATMAP_BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm'];
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
  const modes = getDropdownValues(propModeFilterEl);
  const maxAge = parseInt(rbnMaxAgeInput.value, 10) || 30;
  const ageUnit = rbnAgeUnitSelect.value; // 'm' or 'h'
  const maxAgeSecs = maxAge * (ageUnit === 'h' ? 3600 : 60);

  // Merge RBN and PSKReporter spots based on source toggles
  const merged = [];
  if (propShowRbn) {
    for (const s of rbnSpots) merged.push({ ...s, _source: 'rbn', _station: s.spotter });
  }
  if (propShowPskr) {
    for (const s of pskrMapSpots) merged.push({ ...s, _source: 'pskr', _station: s.receiver });
  }

  return merged.filter((s) => {
    if (bands && !bands.has(s.band)) return false;
    if (modes && !modes.has(s.mode)) return false;
    if (spotAgeSecs(s.spotTime) > maxAgeSecs) return false;
    return true;
  });
}

function rerenderRbn() {
  if (currentView === 'rbn' || activatorRbnVisible) {
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
      const color = RBN_BAND_COLORS_ACTIVE[s.band] || '#ffffff';
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

    const color = RBN_BAND_COLORS_ACTIVE[s.band] || '#ffffff';
    const distStr = s.distance != null ? formatDistance(s.distance) + ' ' + unit : '';
    const snrStr = s.snr != null ? s.snr + ' dB' : '';
    const wpmStr = s.wpm != null ? s.wpm + ' WPM' : '';
    const details = [snrStr, wpmStr].filter(Boolean).join(' / ');
    const srcLabel = s._source === 'pskr' ? 'PSKReporter' : 'RBN';

    const popupContent = `
      <b><a href="#" class="popup-qrz" data-call="${s._station}">${s._station}</a></b> <span class="help-text">${srcLabel}</span><br>
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
  const sortedBands = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm'];
  for (const band of sortedBands) {
    if (!activeBands.has(band)) continue;
    const item = document.createElement('span');
    item.className = 'rbn-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'rbn-legend-swatch';
    swatch.style.background = RBN_BAND_COLORS_ACTIVE[band] || '#fff';
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(band));
    rbnLegendEl.appendChild(item);
  }
}

function renderRbnTable() {
  rbnTableBody.innerHTML = '';
  rbnDistHeader.textContent = distUnit === 'km' ? 'Dist (km)' : 'Dist (mi)';

  // Show newest spots first
  const sorted = [...getFilteredRbnSpots()].reverse();

  for (const s of sorted) {
    const tr = document.createElement('tr');

    // Station (QRZ link with source dot)
    const stationTd = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'prop-source-dot';
    dot.style.background = s._source === 'pskr' ? '#ff6b6b' : 'var(--source-rbn)';
    dot.title = s._source === 'pskr' ? 'PSKReporter' : 'RBN';
    stationTd.appendChild(dot);
    const stationLink = document.createElement('a');
    stationLink.textContent = s._station;
    stationLink.href = '#';
    stationLink.className = 'qrz-link';
    stationLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openExternal(`https://www.qrz.com/db/${encodeURIComponent(s._station.split('/')[0])}`);
    });
    stationTd.appendChild(stationLink);
    tr.appendChild(stationTd);

    // Location
    const locTd = document.createElement('td');
    locTd.textContent = s.locationDesc || '';
    tr.appendChild(locTd);

    // Distance
    const distTd = document.createElement('td');
    distTd.textContent = s.distance != null ? formatDistance(s.distance) : '\u2014';
    tr.appendChild(distTd);

    // Freq
    const freqTd = document.createElement('td');
    freqTd.textContent = parseFloat(s.frequency).toFixed(1);
    tr.appendChild(freqTd);

    // Mode
    const modeTd = document.createElement('td');
    modeTd.textContent = s.mode || '';
    tr.appendChild(modeTd);

    // SNR
    const snrTd = document.createElement('td');
    snrTd.textContent = s.snr != null ? s.snr + ' dB' : '';
    tr.appendChild(snrTd);

    // Time
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
  window.api.clearPskrMap();
  rbnSpots = [];
  pskrMapSpots = [];
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

// --- PSKReporter Map IPC listeners (feeds into shared Propagation view) ---
window.api.onPskrMapSpots((spots) => {
  pskrMapSpots = spots;
  if (currentView === 'rbn') {
    renderRbnMarkers();
    renderRbnTable();
  }
});

let pskrMapNextPollAt = null;
window.api.onPskrMapStatus(({ connected, error, spotCount, nextPollAt, pollUpdate }) => {
  pskrMapConnected = connected;
  if (nextPollAt) pskrMapNextPollAt = nextPollAt;
  updateSettingsConnBar();
  if (!pollUpdate) {
    if (connected && spotCount != null) showLogToast(`PSKReporter: ${spotCount} spots (polling every 5 min)`, { duration: 4000 });
    if (error) showLogToast(error, { warn: true, duration: 5000 });
  }
});

// ECHOCAT status
window.api.onRemoteStatus((s) => {
  remoteConnected = s.connected;
  updateSettingsConnBar();
});

// ECHOCAT TX indicator removed — JTCAT TX indicator remains

// Reload prefs when ECHOCAT changes settings remotely
window.api.onReloadPrefs(() => {
  loadPrefs();
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
  if (typeof closeRigPopover === 'function') closeRigPopover();
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

// --- Rig Control Panel (popover from status bar) ---
const rigPanelBtn = document.getElementById('rig-panel-btn');
const rigPopover = document.getElementById('rig-popover');
const rigAtuBtn = document.getElementById('rig-atu-btn');
const rigNbBtn = document.getElementById('rig-nb-btn');
const rigPowerOnBtn = document.getElementById('rig-power-on-btn');
const rigPowerOffBtn = document.getElementById('rig-power-off-btn');
const rigRfGain = document.getElementById('rig-rfgain');
const rigRfGainLabel = document.getElementById('rig-rfgain-label');
const rigTxPower = document.getElementById('rig-txpower');
const rigTxPowerLabel = document.getElementById('rig-txpower-label');
const rigFilterPresets = document.getElementById('rig-filter-presets');
let rigPopoverOpen = false;
let rigCurrentCaps = {};
let rigCurrentMode = '';

const RIG_FILTER_PRESETS = {
  SSB: [1800, 2100, 2400, 2700, 3000, 3600],
  CW:  [50, 100, 200, 500, 1000, 1500, 2400],
  DIG: [500, 1000, 2000, 3000, 4000],
};

function formatFilterWidth(hz) {
  return hz >= 1000 ? (hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1) + 'k' : hz + '';
}

function rigGetFilterPresets(mode) {
  const m = (mode || '').toUpperCase();
  if (m === 'CW') return RIG_FILTER_PRESETS.CW;
  if (['FT8','FT4','FT2','DIGU','DIGL','RTTY','PKTUSB','PKTLSB'].includes(m)) return RIG_FILTER_PRESETS.DIG;
  return RIG_FILTER_PRESETS.SSB;
}

function rigBuildFilterPresets(mode, currentWidth) {
  const presets = rigGetFilterPresets(mode);
  rigFilterPresets.innerHTML = '';
  for (const w of presets) {
    const btn = document.createElement('button');
    btn.textContent = formatFilterWidth(w);
    btn.title = w + ' Hz';
    if (currentWidth && Math.abs(currentWidth - w) < 25) btn.classList.add('active');
    btn.addEventListener('click', () => {
      window.api.rigControl({ action: 'set-filter-width', value: w });
    });
    rigFilterPresets.appendChild(btn);
  }
}

function rigApplyCapabilities(caps) {
  rigCurrentCaps = caps || {};
  rigAtuBtn.style.display = caps.atu ? '' : 'none';
  rigNbBtn.style.display = caps.nb ? '' : 'none';
  rigPowerOnBtn.style.display = caps.power ? '' : 'none';
  rigPowerOffBtn.style.display = caps.power ? '' : 'none';
  rigRfGain.closest('.rig-popover-row').style.display = caps.rfgain ? '' : 'none';
  rigTxPower.closest('.rig-popover-row').style.display = caps.txpower ? '' : 'none';
  rigFilterPresets.closest('.rig-popover-row').style.display = caps.filter ? '' : 'none';
  // Clamp TX power slider to radio's min/max
  if (caps.minPower != null) rigTxPower.min = caps.minPower;
  if (caps.maxPower != null) rigTxPower.max = caps.maxPower;
}

function positionRigPopover() {
  const rect = rigPanelBtn.getBoundingClientRect();
  const bar = rigPanelBtn.closest('.status-bar');
  const barRect = bar.getBoundingClientRect();
  rigPopover.style.top = (rect.bottom - barRect.top + 4) + 'px';
  // Align right edge to anchor right, clamped to parent
  const popW = rigPopover.offsetWidth || 280;
  let left = rect.right - barRect.left - popW;
  if (left < 0) left = 0;
  if (left + popW > barRect.width) left = barRect.width - popW;
  rigPopover.style.left = left + 'px';
}

function openRigPopover() {
  positionRigPopover();
  rigPopover.classList.remove('hidden');
  rigPopoverOpen = true;
  // Request current state from main process
  window.api.rigControl({ action: 'get-state' });
}

function closeRigPopover() {
  rigPopover.classList.add('hidden');
  rigPopoverOpen = false;
}

rigPanelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (rigPopoverOpen) { closeRigPopover(); return; }
  if (typeof closeCatPopover === 'function') closeCatPopover();
  if (typeof closeCwPopover === 'function') closeCwPopover();
  document.querySelectorAll('.multi-dropdown.open').forEach((d) => d.classList.remove('open'));
  openRigPopover();
});

rigPopover.addEventListener('click', (e) => e.stopPropagation());

// Close rig popover on outside click (extend existing document click handler)
document.addEventListener('click', () => { if (rigPopoverOpen) closeRigPopover(); });

// Button handlers
rigAtuBtn.addEventListener('click', () => {
  window.api.rigControl({ action: 'atu-tune' });
});

rigNbBtn.addEventListener('click', () => {
  const newState = !rigNbBtn.classList.contains('active');
  window.api.rigControl({ action: 'set-nb', value: newState });
});

rigPowerOnBtn.addEventListener('click', () => {
  window.api.rigControl({ action: 'power-on' });
});

rigPowerOffBtn.addEventListener('click', () => {
  window.api.rigControl({ action: 'power-off' });
});

// Slider handlers
// Throttle rig control sliders to prevent flooding serial port
let rigSliderTimer = null;
function throttledRigControl(action, value) {
  if (rigSliderTimer) clearTimeout(rigSliderTimer);
  rigSliderTimer = setTimeout(() => {
    rigSliderTimer = null;
    window.api.rigControl({ action, value });
  }, 80);
}

rigRfGain.addEventListener('input', () => {
  const val = parseInt(rigRfGain.value, 10);
  rigRfGainLabel.textContent = val;
  throttledRigControl('set-rf-gain', val);
});

rigTxPower.addEventListener('input', () => {
  const val = parseInt(rigTxPower.value, 10);
  rigTxPowerLabel.textContent = val + 'W';
  throttledRigControl('set-tx-power', val);
});

// Listen for rig state updates from main process
window.api.onRigState((state) => {
  if (!state) return;
  // Update NB button
  if (state.nb) {
    rigNbBtn.classList.add('active');
  } else {
    rigNbBtn.classList.remove('active');
  }
  // Update sliders (only if user is not actively dragging)
  if (document.activeElement !== rigRfGain && state.rfGain != null) {
    rigRfGain.value = state.rfGain;
    rigRfGainLabel.textContent = state.rfGain;
  }
  if (document.activeElement !== rigTxPower && state.txPower != null) {
    rigTxPower.value = state.txPower;
    rigTxPowerLabel.textContent = state.txPower + 'W';
  }
  // Update filter presets
  if (state.mode) rigCurrentMode = state.mode;
  rigBuildFilterPresets(state.mode || rigCurrentMode, state.filterWidth);
  // Update capabilities (show/hide controls)
  if (state.capabilities) rigApplyCapabilities(state.capabilities);
});

// Show/hide rig panel button based on CAT connection status
window.api.onCatStatus((s) => {
  if (s.connected) {
    rigPanelBtn.classList.remove('hidden');
  } else {
    rigPanelBtn.classList.add('hidden');
    if (rigPopoverOpen) closeRigPopover();
  }
});

// --- Rig Popover Tabs ---
const rigTabBtns = rigPopover.querySelectorAll('.rig-tab-btn');
const rigTabControls = document.getElementById('rig-tab-controls');
const rigTabCustom = document.getElementById('rig-tab-custom');

rigTabBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const tab = btn.dataset.rigTab;
    rigTabBtns.forEach(b => b.classList.toggle('active', b === btn));
    rigTabControls.classList.toggle('hidden', tab !== 'controls');
    rigTabCustom.classList.toggle('hidden', tab !== 'custom');
  });
});

// --- Custom CAT Buttons ---
const rigCustomSlotsContainer = document.getElementById('rig-custom-slots');
const rigCustomAddBtn = document.getElementById('rig-custom-add');
let customCatButtons = JSON.parse(localStorage.getItem('custom-cat-buttons') || '[]');
// Start with at least 1 blank slot
if (customCatButtons.length === 0) customCatButtons.push({ name: '', command: '' });
// Clean up legacy: remove trailing empty slots beyond the last non-empty one
while (customCatButtons.length > 1 && !customCatButtons[customCatButtons.length - 1].name && !customCatButtons[customCatButtons.length - 1].command) {
  customCatButtons.pop();
}

function createCustomSlot(i) {
  const slot = document.createElement('div');
  slot.className = 'rig-custom-slot';
  slot.dataset.slot = i;
  const nameInput = document.createElement('input');
  nameInput.className = 'rig-custom-name';
  nameInput.placeholder = 'Label';
  nameInput.maxLength = 12;
  nameInput.value = customCatButtons[i] ? customCatButtons[i].name || '' : '';
  const cmdInput = document.createElement('input');
  cmdInput.className = 'rig-custom-cmd';
  cmdInput.placeholder = 'CAT command';
  cmdInput.maxLength = 64;
  cmdInput.value = customCatButtons[i] ? customCatButtons[i].command || '' : '';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'rig-btn rig-custom-send';
  sendBtn.title = 'Send command';
  sendBtn.textContent = 'Send';
  const removeBtn = document.createElement('button');
  removeBtn.className = 'rig-btn rig-custom-remove';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '\u00d7';
  removeBtn.style.cssText = 'padding:2px 5px;font-size:13px;color:#e94560;min-width:auto;';

  nameInput.addEventListener('change', () => {
    if (customCatButtons[i]) customCatButtons[i].name = nameInput.value.trim();
    saveCustomButtons();
  });
  cmdInput.addEventListener('change', () => {
    if (customCatButtons[i]) customCatButtons[i].command = cmdInput.value.trim();
    saveCustomButtons();
  });
  sendBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    window.api.rigControl({ action: 'send-custom-cat', command: cmd });
    sendBtn.style.background = '#2a6e4e';
    setTimeout(() => { sendBtn.style.background = ''; }, 300);
  });
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    customCatButtons.splice(i, 1);
    if (customCatButtons.length === 0) customCatButtons.push({ name: '', command: '' });
    saveCustomButtons();
    renderCustomSlots();
  });

  slot.appendChild(nameInput);
  slot.appendChild(cmdInput);
  slot.appendChild(sendBtn);
  slot.appendChild(removeBtn);
  return slot;
}

function renderCustomSlots() {
  rigCustomSlotsContainer.innerHTML = '';
  for (let i = 0; i < customCatButtons.length; i++) {
    rigCustomSlotsContainer.appendChild(createCustomSlot(i));
  }
}

function loadCustomButtons() {
  renderCustomSlots();
}

function saveCustomButtons() {
  localStorage.setItem('custom-cat-buttons', JSON.stringify(customCatButtons));
  window.api.saveSettings({ customCatButtons });
}

renderCustomSlots();
// Migrate localStorage buttons to settings.json if not already synced
if (customCatButtons.some(b => b.name || b.command)) {
  window.api.saveSettings({ customCatButtons });
}

if (rigCustomAddBtn) {
  rigCustomAddBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    customCatButtons.push({ name: '', command: '' });
    saveCustomButtons();
    renderCustomSlots();
    // Focus the new slot's label input
    const slots = rigCustomSlotsContainer.querySelectorAll('.rig-custom-name');
    if (slots.length > 0) slots[slots.length - 1].focus();
  });
}

// --- Pi Access (The Net easter egg) ---
// Ctrl+Shift+Click (Cmd+Shift+Click on Mac) on π unlocks JTCAT + Remote CW
const piAccessEl = document.getElementById('pi-access');
const piOverlay = document.getElementById('pi-overlay');
const piGatedEls = document.querySelectorAll('.pi-gated');
const jtcatBtn = document.getElementById('view-jtcat-btn');
let piUnlocked = false;

function applyPiAccess(_unlocked) {
  piUnlocked = true; // CW keyer, JTCAT, and remote CW are now public
  for (const el of piGatedEls) {
    el.classList.remove('hidden');
  }
  if (jtcatBtn) jtcatBtn.classList.remove('hidden');
}

piAccessEl.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || !e.shiftKey) return;
  // Ctrl+Alt+Shift+Click (Cmd+Alt+Shift on Mac) → revoke access
  if (e.altKey && piUnlocked) {
    const txt = piOverlay.querySelector('.pi-overlay-text');
    txt.textContent = 'ACCESS: REVOKED';
    txt.style.color = '#ff1744';
    txt.style.textShadow = '0 0 10px #ff1744, 0 0 30px #ff174480';
    piOverlay.classList.remove('hidden');
    setTimeout(() => {
      piOverlay.classList.add('hidden');
      txt.textContent = 'ACCESS: AUTHORIZED';
      txt.style.color = '';
      txt.style.textShadow = '';
    }, 1800);
    applyPiAccess(false);
    window.api.saveSettings({ piAccess: false });
    return;
  }
  // Ctrl+Shift+Click (Cmd+Shift on Mac) → grant access
  if (piUnlocked) return;
  piOverlay.classList.remove('hidden');
  setTimeout(() => {
    piOverlay.classList.add('hidden');
  }, 1800);
  applyPiAccess(true);
  window.api.saveSettings({ piAccess: true });
});

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
document.getElementById('docs-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://docs.potacat.com/');
});
document.getElementById('discord-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://discord.gg/cuNQpES38C');
});
document.getElementById('welcome-discord-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://discord.gg/cuNQpES38C');
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
let welcomeIcomLoaded = false;
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
  document.getElementById('welcome-icom-config').classList.toggle('hidden', type !== 'icom');
  document.getElementById('welcome-hamlib-config').classList.toggle('hidden', type !== 'hamlib');
  document.getElementById('welcome-rigctldnet-config').classList.toggle('hidden', type !== 'rigctldnet');
  if (type === 'serialcat' && !welcomeSerialcatLoaded) {
    welcomeSerialcatLoaded = true;
    loadWelcomeSerialcatPorts();
  }
  if (type === 'icom' && !welcomeIcomLoaded) {
    welcomeIcomLoaded = true;
    loadWelcomeIcomPorts();
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

async function loadWelcomeIcomPorts() {
  const ports = await window.api.listPorts();
  const sel = document.getElementById('welcome-icom-port');
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
  } else if (type === 'icom') {
    const manual = document.getElementById('welcome-icom-port-manual').value.trim();
    const modelSelect = document.getElementById('welcome-icom-model');
    return {
      type: 'icom',
      path: manual || document.getElementById('welcome-icom-port').value,
      baudRate: parseInt(document.getElementById('welcome-icom-baud').value, 10) || 115200,
      civAddress: parseInt(modelSelect.value, 16),
      civModel: modelSelect.options[modelSelect.selectedIndex].text,
    };
  } else if (type === 'hamlib') {
    const manual = document.getElementById('welcome-rig-port-manual').value.trim();
    return {
      type: 'rigctld',
      rigId: parseInt(document.getElementById('welcome-rig-model').value, 10),
      serialPort: manual || document.getElementById('welcome-rig-port').value,
      baudRate: parseInt(document.getElementById('welcome-rig-baud').value, 10) || 9600,
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
  window.api.openExternal('https://discord.gg/cuNQpES38C');
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
document.getElementById('welcome-start').addEventListener('click', async () => {
  const myCallsign = (welcomeCallsignInput.value.trim() || '').toUpperCase();
  const grid = welcomeGridInput.value.trim() || 'FN20jb';
  const distUnitVal = document.getElementById('welcome-dist-unit').value;
  const licenseClassVal = document.getElementById('welcome-license-class').value;
  const hideOobChecked = document.getElementById('welcome-hide-oob').checked;
  const lightModeEnabled = welcomeLightMode.checked;
  const qrzUser = (document.getElementById('welcome-qrz-user')?.value || '').trim().toUpperCase();
  const qrzPass = document.getElementById('welcome-qrz-pass')?.value || '';
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
    lightMode: lightModeEnabled,
  };
  // Only set QRZ if user filled it in (don't overwrite existing with blank)
  if (qrzUser) {
    saveData.qrzUsername = qrzUser;
    saveData.enableQrz = true;
  }
  if (qrzPass) saveData.qrzPassword = qrzPass;
  delete saveData.appVersion; // runtime-only, don't persist

  // Add rig if configured in welcome (skip if already exists)
  if (welcomeRig) {
    const existingRigs = currentSettings.rigs || [];
    if (!existingRigs.some(r => r.id === welcomeRig.id)) {
      saveData.rigs = [...existingRigs, welcomeRig];
    }
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
      const welcomeQrzUser = document.getElementById('welcome-qrz-user');
      const welcomeQrzPass = document.getElementById('welcome-qrz-pass');
      if (welcomeQrzUser) welcomeQrzUser.value = s.qrzUsername || '';
      if (welcomeQrzPass) welcomeQrzPass.value = s.qrzPassword || '';
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
  // Strip everything from download/install/checksum/smartscreen sections onward
  md = md.replace(/\n---[\s\S]*/m, '').trim();
  md = md.replace(/\n#{1,4} *(Install|Download|Checksum|SHA-?256|SmartScreen)[\s\S]*/i, '').trim();
  // Strip any "Generated with" / Claude / Anthropic footer lines
  md = md.replace(/^.*(?:generated with|claude|anthropic).*$/gim, '').trim();

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
const activatorStateInput = document.getElementById('activator-state');
const activatorLogBtn = document.getElementById('activator-log-btn');
const activatorLogBody = document.getElementById('activator-log-body');
const activatorExportBtn = document.getElementById('activator-export');
const activatorSpotBtn = document.getElementById('activator-spot-btn');
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
const activatorSpotsBtn = document.getElementById('activator-spots-btn');
const activatorSpotsSplitter = document.getElementById('activator-spots-splitter');

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
    // Hide hunter UI — unless activator spots are visible
    if (!activatorSpotsVisible) {
      if (headerEl) headerEl.classList.add('hidden');
      if (mainEl) mainEl.classList.add('hidden');
    }
    if (eventBannerEl) eventBannerEl.classList.add('hidden');
    if (dxCommandBarEl) dxCommandBarEl.classList.add('hidden');
    if (bannerLoggerEl) bannerLoggerEl.classList.add('hidden');
    // Show activator
    activatorView.classList.remove('hidden');
    // Apply activator-spots or activator-rbn layout if toggled on
    applyActivatorSpotsLayout();
    applyActivatorRbnLayout();
    updateActivatorRbnButton();
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
    updateBannerLoggerVisibility();
    // Hide activator
    activatorView.classList.add('hidden');
    // Clean up activator-spots and activator-rbn layout
    document.body.classList.remove('activator-spots-on');
    document.body.classList.remove('activator-rbn-on');
    activatorSpotsSplitter.classList.add('hidden');
    activatorSpotsBtn.classList.remove('active');
    activatorRbnVisible = false;
    if (activatorRbnBtn) activatorRbnBtn.classList.remove('active');
    // Restore event banner visibility via its own logic
    updateEventBanner();
    render();
  }
}

// --- Activator Spots Toggle ---

const ACTIVATOR_SPOTS_KEY = 'pota-cat-activator-spots';
const ACTIVATOR_SPLIT_KEY = 'pota-cat-activator-split-height';

// Restore persisted state
activatorSpotsVisible = localStorage.getItem(ACTIVATOR_SPOTS_KEY) === '1';

/** Apply or remove the activator-spots split layout */
function applyActivatorSpotsLayout() {
  if (activatorSpotsVisible && appMode === 'activator') {
    document.body.classList.add('activator-spots-on');
    activatorSpotsSplitter.classList.remove('hidden');
    activatorSpotsBtn.classList.add('active');
    if (headerEl) headerEl.classList.remove('hidden');
    if (mainEl) mainEl.classList.remove('hidden');
    // Restore saved height or use default
    const savedHeight = localStorage.getItem(ACTIVATOR_SPLIT_KEY);
    activatorView.style.height = savedHeight || '40%';
    render();
  } else {
    document.body.classList.remove('activator-spots-on');
    activatorSpotsSplitter.classList.add('hidden');
    activatorSpotsBtn.classList.remove('active');
    activatorView.style.height = '';
  }
}

/** Toggle hunter spots visibility in activator mode */
function toggleActivatorSpots() {
  activatorSpotsVisible = !activatorSpotsVisible;
  localStorage.setItem(ACTIVATOR_SPOTS_KEY, activatorSpotsVisible ? '1' : '0');
  // Close RBN if opening spots (mutually exclusive)
  if (activatorSpotsVisible && activatorRbnVisible) {
    activatorRbnVisible = false;
    applyActivatorRbnLayout();
  }
  if (!activatorSpotsVisible && !activatorRbnVisible) {
    if (headerEl) headerEl.classList.add('hidden');
    if (mainEl) mainEl.classList.add('hidden');
  }
  applyActivatorSpotsLayout();
}

activatorSpotsBtn.addEventListener('click', toggleActivatorSpots);

document.getElementById('activator-spots-popout-btn').addEventListener('click', () => {
  // Close inline spots immediately when popping out
  if (activatorSpotsVisible) toggleActivatorSpots();
  window.api.spotsPopoutOpen();
});

// --- Activator RBN Toggle ---
const activatorRbnBtn = document.getElementById('activator-rbn-btn');
let activatorRbnVisible = false;

function updateActivatorRbnButton() {
  if (enableRbn) {
    activatorRbnBtn.classList.remove('hidden');
  } else {
    activatorRbnBtn.classList.add('hidden');
    if (activatorRbnVisible) toggleActivatorRbn();
  }
}

function applyActivatorRbnLayout() {
  if (activatorRbnVisible && appMode === 'activator') {
    document.body.classList.add('activator-rbn-on');
    activatorRbnBtn.classList.add('active');
    if (mainEl) mainEl.classList.remove('hidden');
    // Init RBN map if needed and refresh
    if (!rbnMap) initRbnMap();
    setTimeout(() => { if (rbnMap) rbnMap.invalidateSize(); }, 0);
    renderRbnMarkers();
    renderRbnTable();
  } else {
    document.body.classList.remove('activator-rbn-on');
    activatorRbnBtn.classList.remove('active');
  }
}

function toggleActivatorRbn() {
  activatorRbnVisible = !activatorRbnVisible;
  // RBN and spots are mutually exclusive
  if (activatorRbnVisible && activatorSpotsVisible) {
    activatorSpotsVisible = false;
    localStorage.setItem(ACTIVATOR_SPOTS_KEY, '0');
    applyActivatorSpotsLayout();
  }
  if (!activatorRbnVisible && !activatorSpotsVisible) {
    if (headerEl) headerEl.classList.add('hidden');
    if (mainEl) mainEl.classList.add('hidden');
  }
  applyActivatorRbnLayout();
}

activatorRbnBtn.addEventListener('click', toggleActivatorRbn);

// --- Activator toolbar: Logbook, Settings, CAT ---
const activatorCatStatusEl = document.getElementById('activator-cat-status');

document.getElementById('activator-logbook-btn').addEventListener('click', () => {
  window.api.qsoPopoutOpen();
});

const activatorSettingsPanel = settingsDropdown.querySelector('.settings-dropdown-panel');
let activatorSettingsPanelOpen = false;

function closeActivatorSettingsPanel() {
  if (!activatorSettingsPanelOpen) return;
  activatorSettingsPanelOpen = false;
  // Move panel back into its original parent and reset styles
  settingsDropdown.appendChild(activatorSettingsPanel);
  activatorSettingsPanel.style.display = '';
  activatorSettingsPanel.style.position = '';
  activatorSettingsPanel.style.top = '';
  activatorSettingsPanel.style.right = '';
}

document.getElementById('activator-settings-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  // Close other open dropdowns
  document.querySelectorAll('.multi-dropdown.open').forEach((d) => d.classList.remove('open'));

  if (activatorSettingsPanelOpen) {
    closeActivatorSettingsPanel();
    return;
  }

  // Sync switches to current state
  quickLightMode.checked = document.documentElement.getAttribute('data-theme') === 'light';
  quickActivatorMode.checked = appMode === 'activator';

  // Move panel to body so it's not blocked by hidden header ancestor
  document.body.appendChild(activatorSettingsPanel);
  const btnRect = e.currentTarget.getBoundingClientRect();
  activatorSettingsPanel.style.display = 'block';
  activatorSettingsPanel.style.position = 'fixed';
  activatorSettingsPanel.style.top = (btnRect.bottom + 4) + 'px';
  activatorSettingsPanel.style.right = (window.innerWidth - btnRect.right) + 'px';
  activatorSettingsPanelOpen = true;
});

// Prevent clicks inside the settings panel from closing it via document click handler
activatorSettingsPanel.addEventListener('click', (e) => {
  if (activatorSettingsPanelOpen) e.stopPropagation();
});

activatorCatStatusEl.addEventListener('click', (e) => {
  e.stopPropagation();
  if (catPopoverOpen) {
    closeCatPopover();
  } else {
    openCatPopover(activatorCatStatusEl);
  }
});

// --- Activator-spots splitter drag ---
activatorSpotsSplitter.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = activatorView.offsetHeight;
  const bodyHeight = document.body.offsetHeight;

  const onMove = (ev) => {
    const delta = ev.clientY - startY;
    const minActivator = 150;
    const minSpots = 150;
    const maxHeight = bodyHeight - minSpots;
    const newHeight = Math.max(minActivator, Math.min(maxHeight, startHeight + delta));
    activatorView.style.height = newHeight + 'px';
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    // Persist height
    localStorage.setItem(ACTIVATOR_SPLIT_KEY, activatorView.style.height);
  };

  document.body.style.cursor = 'row-resize';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

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
  // Look up park name and grid
  const gridInput = document.getElementById('activator-grid');
  window.api.getPark(activation.parkRef).then(park => {
    if (park) {
      activatorParkRefs[0].name = park.name || '';
      activatorParkNameEl.textContent = park.name || '';
      if (park.latitude && park.longitude) {
        activatorParkGrid = latLonToGridLocal(parseFloat(park.latitude), parseFloat(park.longitude));
        if (gridInput) gridInput.value = activatorParkGrid;
      }
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
      state: c.state || '',
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
  const maxLen = isPhone ? '2' : '3';
  setRstDigits('activator-rst-sent', def);
  setRstDigits('activator-rst-rcvd', def);
  const n1mmSent = document.getElementById('activator-rst-sent');
  const n1mmRcvd = document.getElementById('activator-rst-rcvd');
  if (n1mmSent) n1mmSent.maxLength = maxLen;
  if (n1mmRcvd) n1mmRcvd.maxLength = maxLen;
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
  const total = activatorContacts.length;
  const totalRecords = activatorContacts.reduce((sum, c) => sum + (c.qsoDataList ? c.qsoDataList.length : 1), 0);
  // Count contacts for the current UTC day (POTA requires 10 per UTC day)
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayCount = activatorContacts.filter(c => {
    const ts = c.qsoData?.timeOn || c.qsoData?.spotTime || c.timestamp;
    return ts && ts.startsWith(todayStr);
  }).length;
  // If activation spans midnight, show today's count; otherwise show total
  const spansDay = total > 0 && todayCount < total;
  const displayCount = spansDay ? todayCount : total;
  activatorCounterEl.textContent = spansDay ? `${todayCount}/${total}` : String(total);
  activatorCounterEl.classList.toggle('valid', displayCount >= 10);
  const recordNote = totalRecords > total ? ` (${totalRecords} ADIF records)` : '';
  const dayNote = spansDay ? ` (${todayCount} today UTC / ${total} total session)` : '';
  activatorCounterEl.title = spansDay
    ? `${todayCount} today UTC / ${total} total session${recordNote}${todayCount >= 10 ? ' — valid activation today!' : ` (need ${10 - todayCount} more today)`}`
    : `${total} contact${total !== 1 ? 's' : ''} logged${recordNote}${total >= 10 ? ' — valid activation!' : ` (need ${10 - total} more)`}`;
}

function renderActivatorLog() {
  activatorLogBody.innerHTML = '';
  // Newest on top
  for (let i = activatorContacts.length - 1; i >= 0; i--) {
    const c = activatorContacts[i];
    const tr = document.createElement('tr');
    tr.dataset.idx = i;
    // Check if this callsign has been worked before (from main logbook)
    const workedBefore = workedQsos.has(c.callsign.toUpperCase());
    const dupeFlag = workedBefore ? '<span class="act-log-dupe" title="Worked before">PREV</span>' : '';
    const p2pBadge = (c.theirParks && c.theirParks.length > 0) ? `<span class="act-log-p2p" title="P2P: ${c.theirParks.join(', ')}">P2P</span>` : '';
    tr.innerHTML = `
      <td class="act-log-num">${i + 1}</td>
      <td class="act-log-time act-log-editable" data-field="timeUtc">${c.timeUtc || ''}</td>
      <td class="act-log-call act-log-editable" data-field="callsign">${c.callsign || ''}${dupeFlag}${p2pBadge}</td>
      <td class="act-log-name">${c.name || ''}</td>
      <td class="act-log-state act-log-editable" data-field="state">${c.state || ''}</td>
      <td class="act-log-freq act-log-editable" data-field="freqDisplay">${c.freqDisplay || ''}</td>
      <td class="act-log-mode act-log-editable" data-field="mode">${c.mode || ''}</td>
      <td class="act-log-rst act-log-editable" data-field="rstSent">${c.rstSent || ''}</td>
      <td class="act-log-rst act-log-editable" data-field="rstRcvd">${c.rstRcvd || ''}</td>
      <td class="act-log-band">${c.band || ''}</td>
      <td class="act-log-del"><button class="act-log-del-btn" data-idx="${i}" title="Delete this contact">&times;</button></td>
    `;
    activatorLogBody.appendChild(tr);
  }

  // Bind delete buttons
  activatorLogBody.querySelectorAll('.act-log-del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      deleteActivatorContact(idx);
    });
  });
}

// --- Activator log inline edit (double-click) ---
activatorLogBody.addEventListener('dblclick', (e) => {
  const td = e.target.closest('td.act-log-editable');
  if (!td || td.querySelector('input, select')) return;
  const tr = td.closest('tr');
  const idx = parseInt(tr.dataset.idx, 10);
  const field = td.dataset.field;
  const c = activatorContacts[idx];
  if (!c) return;

  // Get the raw value (not innerHTML which may contain badges)
  const rawValue = c[field] || '';

  if (field === 'mode') {
    // Use a dropdown for mode
    const select = document.createElement('select');
    select.className = 'act-log-edit-select';
    const modes = ['SSB', 'CW', 'FT8', 'FT4', 'FT2', 'FM', 'RTTY', 'PSK31', 'USB', 'LSB', 'AM'];
    for (const m of modes) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === rawValue) opt.selected = true;
      select.appendChild(opt);
    }
    td.textContent = '';
    td.appendChild(select);
    select.focus();

    function finish() {
      const newVal = select.value;
      select.removeEventListener('change', finish);
      select.removeEventListener('blur', finish);
      if (newVal !== rawValue) {
        saveActivatorEdit(idx, field, newVal);
      } else {
        renderActivatorLog();
      }
    }
    select.addEventListener('change', finish);
    select.addEventListener('blur', finish);
  } else {
    // Text input for other fields
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'act-log-edit-input';
    input.value = rawValue;
    if (field === 'callsign' || field === 'state') input.style.textTransform = 'uppercase';
    td.textContent = '';
    td.appendChild(input);
    input.focus();
    input.select();

    let committed = false;
    function cancel() {
      if (committed) return;
      committed = true;
      renderActivatorLog();
    }
    function save() {
      if (committed) return;
      committed = true;
      const newVal = input.value.trim();
      if (newVal && newVal !== rawValue) {
        saveActivatorEdit(idx, field, field === 'callsign' ? newVal.toUpperCase() : newVal);
      } else {
        renderActivatorLog();
      }
    }
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); save(); }
      if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', save);
  }
});

/** Save an inline edit to an activator contact and update the ADIF log */
async function saveActivatorEdit(idx, field, newVal) {
  const c = activatorContacts[idx];
  if (!c) return;

  // Build match criteria from the original contact's QSO data
  const qso = c.qsoData || {};
  const match = {
    callsign: c.callsign,
    qsoDate: qso.qsoDate || '',
    timeOn: qso.timeOn || '',
    frequency: qso.frequency || '',
  };

  // Map the in-memory field to ADIF field updates
  const adifUpdates = {};
  switch (field) {
    case 'callsign':
      c.callsign = newVal;
      adifUpdates.CALL = newVal;
      break;
    case 'freqDisplay': {
      c.freqDisplay = newVal;
      const freqKhz = Math.round(parseFloat(newVal) * 1000);
      c.band = freqToBandActivator(freqKhz) || c.band;
      adifUpdates.FREQ = (freqKhz / 1000).toFixed(6);
      adifUpdates.BAND = c.band;
      // Update qsoData frequency for future match reference
      if (c.qsoData) c.qsoData.frequency = String(freqKhz);
      if (c.qsoDataList) c.qsoDataList.forEach(q => { q.frequency = String(freqKhz); });
      break;
    }
    case 'mode':
      c.mode = newVal;
      adifUpdates.MODE = newVal;
      break;
    case 'rstSent':
      c.rstSent = newVal;
      adifUpdates.RST_SENT = newVal;
      break;
    case 'rstRcvd':
      c.rstRcvd = newVal;
      adifUpdates.RST_RCVD = newVal;
      break;
    case 'state':
      c.state = newVal.toUpperCase();
      adifUpdates.STATE = c.state;
      if (c.qsoData) c.qsoData.state = c.state;
      if (c.qsoDataList) c.qsoDataList.forEach(q => { q.state = c.state; });
      break;
    case 'timeUtc': {
      c.timeUtc = newVal;
      // Convert HH:MM display to HHMMSS for ADIF
      const cleaned = newVal.replace(/:/g, '');
      const timeOn = cleaned.length === 4 ? cleaned + '00' : cleaned;
      adifUpdates.TIME_ON = timeOn;
      if (c.qsoData) c.qsoData.timeOn = timeOn;
      if (c.qsoDataList) c.qsoDataList.forEach(q => { q.timeOn = timeOn; });
      break;
    }
  }

  // Update ADIF log file
  try {
    const result = await window.api.updateQsosByMatch({ match, updates: adifUpdates });
    if (!result.success) {
      console.error('[Activator] Failed to update QSO in log:', result.error);
    }
  } catch (err) {
    console.error('[Activator] Update QSO error:', err);
  }

  // Also update qsoData/qsoDataList references for callsign changes (affects future match/delete)
  if (field === 'callsign') {
    if (c.qsoData) c.qsoData.callsign = newVal;
    if (c.qsoDataList) c.qsoDataList.forEach(q => { q.callsign = newVal; });
    // Re-fetch operator name from QRZ for the new callsign
    c.name = '';
    window.api.qrzLookup(newVal).then(info => {
      if (info) {
        c.name = qrzDisplayName(info);
        renderActivatorLog();
      }
    }).catch(() => {});
  }

  renderActivatorLog();
}

/** Delete an activator contact by index — removes from memory and ADIF log */
async function deleteActivatorContact(idx) {
  if (idx < 0 || idx >= activatorContacts.length) return;
  const c = activatorContacts[idx];

  // Build match criteria from the first QSO record
  const qso = c.qsoData || {};
  const match = {
    callsign: c.callsign,
    qsoDate: qso.qsoDate || '',
    timeOn: qso.timeOn || '',
    frequency: qso.frequency || '',
  };

  // Remove from ADIF log
  try {
    const result = await window.api.deleteQsosByMatch(match);
    if (!result.success) {
      console.error('[Activator] Failed to delete QSO from log:', result.error);
    }
  } catch (err) {
    console.error('[Activator] Delete QSO error:', err);
  }

  // Remove from in-memory list
  activatorContacts.splice(idx, 1);
  updateActivatorCounter();
  renderActivatorLog();
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
  activatorHistoryBtn.addEventListener('click', () => {
    if (activatorHistoryPanel.classList.contains('hidden')) {
      showPastActivations();
      activatorHistoryBtn.classList.add('active');
    } else {
      activatorHistoryPanel.classList.add('hidden');
      activatorHistoryBtn.classList.remove('active');
      if (!activationActive && activatorContacts.length === 0) {
        activatorIdleMsg.classList.remove('hidden');
      }
    }
  });
}
if (activatorHistoryClose) {
  activatorHistoryClose.addEventListener('click', () => {
    activatorHistoryPanel.classList.add('hidden');
    activatorHistoryBtn.classList.remove('active');
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
          <button class="act-hist-share-btn" title="Save map as shareable image">Share Image</button>
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
      // Share Image button
      detail.querySelector('.act-hist-share-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await renderShareImage(act);
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
    sig: c.sig || '',
    sigInfo: c.sigInfo || '',
    myGridsquare: c.myGridsquare || '',
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
  // Hide spots table if visible — map needs the full view
  if (activatorSpotsVisible) toggleActivatorSpots();
  if (activatorRbnVisible) toggleActivatorRbn();

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

  // Contact markers — one per QSO, positioned via QRZ grid (precise)
  // or cty.dat (country/call-area fallback), jittered to avoid stacking
  const bounds = [];
  const refLon = parkLon ?? -98.5; // reference for antimeridian wrapping
  if (parkLat != null && parkLon != null) bounds.push([parkLat, parkLon]);
  const usedPositions = []; // track placed positions for jitter
  for (let i = 0; i < act.contacts.length; i++) {
    const c = act.contacts[i];
    // Prefer QRZ grid for precise positioning
    const gridPos = c.grid ? gridToLatLonLocal(c.grid) : null;
    const loc = gridPos || locations[c.callsign];
    if (!loc) continue;
    let cLat = loc.lat, cLon = wrapLon(refLon, loc.lon);
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
    const locName = loc.name || (locations[c.callsign] && locations[c.callsign].name) || '';
    const gridLabel = c.grid ? ` (${c.grid})` : '';
    const popupHtml = `<b>${c.callsign}</b>${c.name ? ' — ' + c.name : ''}<br>${t} UTC  ${fMhz} ${c.mode || ''}<br><span style="color:#aaa">${locName}${gridLabel}</span>`;
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
    const fullVal = activatorParkRefInput.value.trim().toUpperCase();
    // Support comma-separated park refs — parse all segments
    const segments = fullVal.split(',').map(s => s.trim()).filter(Boolean);
    const lastSeg = segments.length > 0 ? segments[segments.length - 1] : '';

    if (!fullVal) {
      activatorParkDropdown.classList.add('hidden');
      activatorStartBtn.disabled = true;
      activatorParkNameEl.textContent = '';
      activatorParkRefs = [];
      activatorCrossRefs = [];
      if (crossRefWwff) crossRefWwff.value = '';
      if (crossRefLlota) crossRefLlota.value = '';
      updateParkExtraBadge();
      return;
    }

    // Resolve completed segments (before the last comma) into activatorParkRefs
    if (segments.length > 1) {
      parseCommaSeparatedParks(segments);
    }

    // Only search for the last segment (the one being typed)
    const query = lastSeg;
    if (query.length < 2) {
      activatorParkDropdown.classList.add('hidden');
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
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectParkMulti(park);
        });
        activatorParkDropdown.appendChild(item);
      }
      activatorParkDropdown.classList.remove('hidden');
    }, 150);
  });

  // Close dropdown on blur — also finalize comma-separated refs
  activatorParkRefInput.addEventListener('blur', () => {
    setTimeout(() => {
      activatorParkDropdown.classList.add('hidden');
      finalizeCommaSeparatedParks();
    }, 150);
  });

  // Allow Enter to select first dropdown item
  activatorParkRefInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = activatorParkDropdown.querySelector('.activator-dropdown-item');
      if (first && !activatorParkDropdown.classList.contains('hidden')) {
        first.click();
        e.preventDefault();
      } else {
        // No dropdown — finalize comma-separated refs
        finalizeCommaSeparatedParks();
      }
    }
  });

  // Grid input: manual override
  const gridInput = document.getElementById('activator-grid');
  if (gridInput) {
    gridInput.addEventListener('input', () => {
      activatorParkGrid = gridInput.value.trim().toUpperCase();
    });
  }
}

function selectPark(park) {
  activatorParkRefs = [{ ref: park.reference, name: park.name || '' }];
  activatorParkRefInput.value = park.reference;
  activatorParkNameEl.textContent = park.name || '';
  activatorParkDropdown.classList.add('hidden');
  updateParkExtraBadge();
  // Auto-populate grid from park lat/lon
  const gridInput = document.getElementById('activator-grid');
  if (park.latitude && park.longitude) {
    activatorParkGrid = latLonToGridLocal(parseFloat(park.latitude), parseFloat(park.longitude));
    if (gridInput) gridInput.value = activatorParkGrid;
  } else {
    activatorParkGrid = '';
    if (gridInput) gridInput.value = '';
  }
  // Enable start button
  activatorStartBtn.disabled = false;
  // Persist to settings
  window.api.saveSettings({ activatorParkRefs });
}

/** Select a park from dropdown when in multi-park (comma-separated) mode */
function selectParkMulti(park) {
  // Replace the last segment in the input with the selected park ref
  const fullVal = activatorParkRefInput.value;
  const lastComma = fullVal.lastIndexOf(',');
  const prefix = lastComma >= 0 ? fullVal.substring(0, lastComma + 1) + ' ' : '';
  activatorParkRefInput.value = prefix + park.reference;
  activatorParkDropdown.classList.add('hidden');

  // Rebuild activatorParkRefs from the full input
  const segments = activatorParkRefInput.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  activatorParkRefs = segments.map(ref => ({ ref, name: '' }));
  // Fill in the selected park's name for the last one
  activatorParkRefs[activatorParkRefs.length - 1].name = park.name || '';

  // Look up names for any earlier refs we don't have names for
  for (let i = 0; i < activatorParkRefs.length - 1; i++) {
    if (!activatorParkRefs[i].name) {
      window.api.getPark(activatorParkRefs[i].ref).then(p => {
        if (p) { activatorParkRefs[i].name = p.name || ''; updateParkExtraBadge(); }
      }).catch(() => {});
    }
  }

  // Display: show first park name, badge shows +N
  if (activatorParkRefs.length === 1) {
    activatorParkNameEl.textContent = park.name || '';
  } else {
    activatorParkNameEl.textContent = (activatorParkRefs[0].name || activatorParkRefs[0].ref);
  }
  updateParkExtraBadge();

  // Grid from the first park
  const gridInput = document.getElementById('activator-grid');
  if (activatorParkRefs.length === 1 && park.latitude && park.longitude) {
    activatorParkGrid = latLonToGridLocal(parseFloat(park.latitude), parseFloat(park.longitude));
    if (gridInput) gridInput.value = activatorParkGrid;
  }

  activatorStartBtn.disabled = false;
  window.api.saveSettings({ activatorParkRefs });
}

/** Parse comma-separated park refs typed directly (without dropdown selection) */
function parseCommaSeparatedParks(segments) {
  // Rebuild activatorParkRefs from completed segments
  const newRefs = segments.map(ref => {
    const existing = activatorParkRefs.find(p => p.ref === ref);
    return existing || { ref, name: '' };
  });
  activatorParkRefs = newRefs;

  if (activatorParkRefs.length > 0) {
    activatorStartBtn.disabled = false;
    updateParkExtraBadge();
  }
}

/** Finalize comma-separated refs on blur/Enter — look up names, set grid from first park */
function finalizeCommaSeparatedParks() {
  const fullVal = activatorParkRefInput.value.trim().toUpperCase();
  if (!fullVal) return;
  const segments = fullVal.split(',').map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return;

  activatorParkRefs = segments.map(ref => {
    const existing = activatorParkRefs.find(p => p.ref === ref);
    return existing || { ref, name: '' };
  });

  // Look up names for refs we don't have
  for (let i = 0; i < activatorParkRefs.length; i++) {
    if (!activatorParkRefs[i].name) {
      const idx = i;
      window.api.getPark(activatorParkRefs[idx].ref).then(p => {
        if (p) {
          activatorParkRefs[idx].name = p.name || '';
          if (idx === 0) activatorParkNameEl.textContent = p.name || '';
          // Set grid from first park if not already set
          if (idx === 0 && p.latitude && p.longitude) {
            activatorParkGrid = latLonToGridLocal(parseFloat(p.latitude), parseFloat(p.longitude));
            const gridInput = document.getElementById('activator-grid');
            if (gridInput) gridInput.value = activatorParkGrid;
          }
          updateParkExtraBadge();
        }
      }).catch(() => {});
    }
  }

  if (activatorParkRefs.length === 1) {
    activatorParkNameEl.textContent = activatorParkRefs[0].name || '';
  } else {
    activatorParkNameEl.textContent = activatorParkRefs[0].name || activatorParkRefs[0].ref;
  }
  updateParkExtraBadge();
  activatorStartBtn.disabled = false;
  window.api.saveSettings({ activatorParkRefs });
}

/** Update the park display: input value, name, and extra badge */
function updateParkDisplay() {
  // Show comma-separated refs if multiple parks
  if (activatorParkRefs.length > 1) {
    activatorParkRefInput.value = activatorParkRefs.map(p => p.ref).join(', ');
  } else {
    activatorParkRefInput.value = primaryParkRef();
  }
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
  updateCrossRefToggle();
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

// --- Cross-Program References ---
const crossRefWrap = document.getElementById('activator-crossref-wrap');
const crossRefToggle = document.getElementById('activator-crossref-toggle');
const crossRefPopover = document.getElementById('activator-crossref-popover');
const crossRefWwff = document.getElementById('activator-crossref-wwff');
const crossRefLlota = document.getElementById('activator-crossref-llota');

function rebuildCrossRefs() {
  activatorCrossRefs = [];
  const wwffVal = crossRefWwff ? crossRefWwff.value.trim().toUpperCase() : '';
  const llotaVal = crossRefLlota ? crossRefLlota.value.trim().toUpperCase() : '';
  if (wwffVal) activatorCrossRefs.push({ program: 'WWFF', ref: wwffVal });
  if (llotaVal) activatorCrossRefs.push({ program: 'LLOTA', ref: llotaVal });
  window.api.saveSettings({ activatorCrossRefs });
  updateCrossRefToggle();
}

function updateCrossRefToggle() {
  if (!crossRefToggle || !crossRefWrap) return;
  const hasRefs = activatorCrossRefs.length > 0;
  crossRefToggle.classList.toggle('has-refs', hasRefs);
  crossRefToggle.textContent = hasRefs ? `X-Ref (${activatorCrossRefs.length})` : 'X-Ref';
  // Show the wrap when a park ref is entered
  crossRefWrap.classList.toggle('hidden', !primaryParkRef());
}

if (crossRefToggle) {
  crossRefToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    crossRefPopover.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!crossRefPopover.contains(e.target) && e.target !== crossRefToggle) {
      crossRefPopover.classList.add('hidden');
    }
  });
}
if (crossRefWwff) crossRefWwff.addEventListener('blur', rebuildCrossRefs);
if (crossRefLlota) crossRefLlota.addEventListener('blur', rebuildCrossRefs);

// --- Quick Log ---
async function activatorLogContact() {
  if (!activationActive) return; // must have an active activation
  const rawCallsign = activatorCallsignInput.value.trim().toUpperCase();
  if (!rawCallsign) return;

  // If hunter park input has a value but hunterParkRefs is empty (user typed directly
  // without selecting from dropdown), parse the input as a park reference
  const hunterInput = document.getElementById('activator-hunter-park');
  if (hunterInput && hunterInput.value.trim() && hunterParkRefs.length === 0) {
    const typed = hunterInput.value.trim().toUpperCase();
    // Accept anything that looks like a park ref (e.g. K-1234, VE-0456, US-1234)
    if (/^[A-Z]{1,3}-\d{3,5}$/.test(typed)) {
      hunterParkRefs = [{ ref: typed, name: '' }];
    }
  }
  if (!primaryParkRef()) {
    activatorParkRefInput.focus();
    return;
  }

  // Support comma-separated callsigns (multiple activators at same park)
  const callsigns = rawCallsign.split(',').map(c => c.trim()).filter(Boolean);
  if (!callsigns.length) return;

  const mode = activatorModeSelect.value;
  const rstSent = getRstDigits('activator-rst-sent', mode === 'SSB' || mode === 'FM' ? '59' : '599');
  const rstRcvd = getRstDigits('activator-rst-rcvd', mode === 'SSB' || mode === 'FM' ? '59' : '599');

  // State: prefer user-edited value, auto-filled from QRZ
  const stateVal = activatorStateInput ? activatorStateInput.value.trim().toUpperCase() : '';

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

  const myParks = activatorParkRefs;                              // always >= 1
  const theirParks = hunterParkRefs.length > 0 ? hunterParkRefs : [null];

  // Log each callsign as a separate QSO with identical fields
  for (const callsign of callsigns) {
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
      state: stateVal,
      stationCallsign: myCallsign || '',
      operator: myCallsign || '',
      myGridsquare: activatorParkGrid || '',
    };

    // Cross-product: one ADIF record per MY_SIG_INFO × SIG_INFO combination
    const allQsoData = [];
    for (const myPark of myParks) {
      for (const theirPark of theirParks) {
        const qsoData = { ...baseFields, mySig: 'POTA', mySigInfo: myPark.ref };
        if (theirPark) { qsoData.sig = 'POTA'; qsoData.sigInfo = theirPark.ref; }
        allQsoData.push(qsoData);
      }
    }
    // Cross-program records: WWFF/LLOTA refs for the same physical park
    for (const xr of activatorCrossRefs) {
      for (const theirPark of theirParks) {
        const qsoData = { ...baseFields, mySig: xr.program.toUpperCase(), mySigInfo: xr.ref };
        if (xr.program === 'WWFF') qsoData.myWwffRef = xr.ref;
        if (theirPark) { qsoData.sig = 'POTA'; qsoData.sigInfo = theirPark.ref; }
        allQsoData.push(qsoData);
      }
    }

    // Save all cross-product records via existing pipeline
    // Only forward the first record to external logbook — ACLog etc. only
    // need one QSO per physical contact, not one per park ref
    try {
      for (let qi = 0; qi < allQsoData.length; qi++) {
        const qsoData = allQsoData[qi];
        if (qi > 0) qsoData.skipLogbookForward = true;
        await window.api.saveQso(qsoData);
      }
      // Fire cross-program self-spots (WWFF/LLOTA) via quick-respot
      for (const xr of activatorCrossRefs) {
        if (xr.program === 'WWFF' && xr.ref) {
          window.api.quickRespot({
            callsign: myCallsign,
            frequency: freqKhz ? String(freqKhz) : '',
            mode,
            wwffRespot: true,
            wwffReference: xr.ref,
            comment: '',
          }).catch(err => console.warn('[Activator] WWFF self-spot failed:', err));
        }
        if (xr.program === 'LLOTA' && xr.ref) {
          window.api.quickRespot({
            callsign: myCallsign,
            frequency: freqKhz ? String(freqKhz) : '',
            mode,
            llotaRespot: true,
            llotaReference: xr.ref,
            comment: '',
          }).catch(err => console.warn('[Activator] LLOTA self-spot failed:', err));
        }
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
      state: stateVal,
      name: '',
      myParks: [...myParks.map(p => p.ref), ...activatorCrossRefs.map(xr => xr.ref)],
      theirParks: hunterParkRefs.map(p => p.ref),
      qsoData: allQsoData[0], // backward compat
      qsoDataList: allQsoData, // all cross-product records for export
    };
    activatorContacts.push(contact);

    // Push to activation map pop-out
    if (actmapPopoutOpen) {
      window.api.actmapPopoutContact({
        parkRefs: activatorParkRefs.map(p => p.ref),
        contact,
      });
    }

    // Fire-and-forget QRZ lookup for name + grid + state (if not already set)
    window.api.qrzLookup(callsign).then(info => {
      if (info) {
        contact.name = qrzDisplayName(info);
        if (info.grid) contact.grid = info.grid;
        if (!contact.state && info.state) contact.state = info.state;
        renderActivatorLog();
        // Update pop-out map with precise grid location
        if (actmapPopoutOpen && info.grid) {
          window.api.actmapPopoutContact({
            parkRefs: activatorParkRefs.map(p => p.ref),
            contact,
            update: true, // signal this is a location update, not a new contact
          });
        }
      }
    }).catch(() => {});
  }

  updateActivatorCounter();
  renderActivatorLog();

  // Clear and refocus
  activatorCallsignInput.value = '';
  activatorOpNameEl.textContent = '';
  if (activatorStateInput) activatorStateInput.value = '';
  resetActivatorRst();
  // Reset hunter parks for next QSO
  hunterParkRefs = [];
  updateHunterParkDisplay();
  activatorCallsignInput.focus();
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
            if (activatorStateInput) activatorStateInput.value = info.state || '';
          }
        }).catch(() => {});
      }
    }
  });
}

// Activator RST: N1MM auto-advance + Enter to log
setupRstAutoAdvance('activator-rst-sent', 'activator-rst-rcvd', () => {
  const mode = activatorModeSelect.value;
  return (mode === 'SSB' || mode === 'FM') ? 2 : 3;
});

// Enter key in state field triggers log
if (activatorStateInput) {
  activatorStateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); activatorLogContact(); }
  });
}

// Enter key in any activator RST field (both modes) triggers log
document.querySelectorAll('#activator-rst-sent, #activator-rst-rcvd, #activator-rst-sent-digits .rst-digit, #activator-rst-rcvd-digits .rst-digit').forEach(el => {
  el.addEventListener('keydown', (e) => {
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

    // Multi-park or cross-program: offer per-park or combined export
    if (activatorParkRefs.length > 1 || activatorCrossRefs.length > 0) {
      const dlg = document.getElementById('export-choice-dlg');
      dlg.showModal();
      const chosen = await new Promise(resolve => {
        const onPerPark = () => { cleanup(); resolve('perpark'); };
        const onCombined = () => { cleanup(); resolve('combined'); };
        const onClose = () => { cleanup(); resolve(null); };
        const cleanup = () => {
          document.getElementById('export-choice-perpark').removeEventListener('click', onPerPark);
          document.getElementById('export-choice-combined').removeEventListener('click', onCombined);
          document.getElementById('export-choice-close').removeEventListener('click', onClose);
          dlg.close();
        };
        document.getElementById('export-choice-perpark').addEventListener('click', onPerPark);
        document.getElementById('export-choice-combined').addEventListener('click', onCombined);
        document.getElementById('export-choice-close').addEventListener('click', onClose);
      });
      if (!chosen) return;
      if (chosen === 'perpark') {
        // Group QSOs by mySigInfo (park ref)
        const qsosByPark = {};
        for (const q of qsos) {
          const ref = q.mySigInfo || 'UNKNOWN';
          (qsosByPark[ref] ||= []).push(q);
        }
        const result = await window.api.exportActivationAdifPerPark({
          qsosByPark,
          myCallsign: myCallsign || '',
        });
        if (result && result.success) {
          showLogToast(`Exported ${result.totalQsos} QSOs across ${result.fileCount} files`);
        }
        return;
      }
      // else 'combined' — fall through to existing single-file export
    }

    const result = await window.api.exportActivationAdif({
      qsos,
      parkRef: primaryParkRef(),
      myCallsign: myCallsign || '',
    });
    if (result && result.success) {
      showLogToast(`Exported ${qsos.length} QSOs to ${result.path.split(/[\\/]/).pop()}`);
    }
  });
}

// --- Self-spot button ---
if (activatorSpotBtn) {
  activatorSpotBtn.addEventListener('click', async () => {
    const ref = primaryParkRef();
    if (!ref) { showLogToast('Set a park reference first', { warn: true }); return; }
    if (!myCallsign) { showLogToast('Set your callsign in Settings first', { warn: true }); return; }
    const freq = activatorFreqKhz;
    if (!freq) { showLogToast('No frequency — tune your radio first', { warn: true }); return; }
    const mode = document.getElementById('activator-mode').value || _currentMode || 'SSB';
    try {
      const result = await window.api.quickRespot({
        callsign: myCallsign,
        frequency: String(Math.round(freq * 10) / 10),
        mode,
        potaRespot: true,
        potaReference: ref,
        comment: `${myCallsign} activating ${ref} via POTACAT`,
      });
      if (result && result.success) {
        showLogToast(`Spotted on POTA: ${ref} ${Math.round(freq)} kHz ${mode}`);
      } else {
        showLogToast('Self-spot failed: ' + (result?.error || 'unknown error'), { warn: true });
      }
    } catch (err) {
      showLogToast('Self-spot failed: ' + (err.message || err), { warn: true });
    }
  });
}

/**
 * Render a 1080x1080 social-sharable activation image.
 * @param {object} [pastAct] — Past activation object. If omitted, uses live activation state.
 */
async function renderShareImage(pastAct) {
  // Show loading overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(10,10,24,0.85);';
  overlay.innerHTML = '<style>@keyframes _shareSpin{to{transform:rotate(360deg)}}</style><div style="text-align:center;color:#fff;font-family:Segoe UI,sans-serif;"><div style="width:36px;height:36px;border:3px solid rgba(255,255,255,0.2);border-top-color:#4ecca3;border-radius:50%;animation:_shareSpin 0.8s linear infinite;margin:0 auto 16px;"></div><div style="font-size:16px;">Building image\u2026</div></div>';
  document.body.appendChild(overlay);
  try {
  // Determine data source: past activation or live
  const isPast = !!pastAct;
  let shareCallsign, shareRefs, shareParkName, shareContacts, shareParkRef;

  if (isPast) {
    shareCallsign = myCallsign || '';
    shareRefs = [pastAct.parkRef].filter(Boolean);
    shareContacts = pastAct.contacts || [];
    shareParkRef = pastAct.parkRef || '';
    // Look up park name from DB
    try {
      const parkData = await window.api.getPark(pastAct.parkRef);
      shareParkName = parkData?.name || '';
    } catch { shareParkName = ''; }
  } else {
    shareCallsign = myCallsign || '';
    shareRefs = activatorParkRefs.map(p => p.ref).filter(Boolean);
    shareParkName = primaryParkName();
    shareContacts = activatorContacts;
    shareParkRef = primaryParkRef();
  }

  if (!shareContacts.length) {
    alert('No contacts to share.');
    return;
  }

  // --- Render a dedicated square map fitted to park + contacts ---
  // Create an offscreen container for a square Leaflet map
  // 9:16 portrait container for social sharing (1080x1920)
  const W = 1080, H = 1920;
  // Map container must match 9:16 aspect so cover-crop doesn't cut sides
  const mapH = Math.min(window.innerHeight - 20, H);
  const mapW = Math.round(mapH * (W / H));
  const mapContainer = document.createElement('div');
  mapContainer.style.cssText = `position:fixed;left:0;top:0;width:${mapW}px;height:${mapH}px;z-index:9999;`;
  document.body.appendChild(mapContainer);

  const shareMap = L.map(mapContainer, {
    zoomControl: false, attributionControl: false, worldCopyJump: true,
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, className: 'dark-tiles',
  }).addTo(shareMap);

  // Resolve park location
  let parkLat = null, parkLon = null;
  try {
    const parkData = await window.api.getPark(shareParkRef);
    if (parkData?.latitude && parkData?.longitude) {
      parkLat = parseFloat(parkData.latitude);
      parkLon = parseFloat(parkData.longitude);
    }
  } catch {}

  // Park marker
  if (parkLat != null) {
    const parkIcon = L.divIcon({
      className: '',
      html: `<div style="background:${SOURCE_COLORS_ACTIVE.pota};width:18px;height:18px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 8px rgba(78,204,163,0.6);"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9],
    });
    L.marker([parkLat, parkLon], { icon: parkIcon, zIndexOffset: 1000 }).addTo(shareMap);
  }

  // Resolve contact locations
  const callsigns = [...new Set(shareContacts.map(c => c.callsign).filter(Boolean))];
  let locations = {};
  try { locations = await window.api.resolveCallsignLocations(callsigns); } catch {}

  // Haversine distance in miles
  const _hav = (lat1, lon1, lat2, lon2) => {
    const R = 3959; // Earth radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const bounds = [];
  const shareRefLon = parkLon ?? -98.5;
  if (parkLat != null) bounds.push([parkLat, parkLon]);
  const usedPositions = [];
  let furthestCall = null, furthestDist = 0;

  for (const c of shareContacts) {
    const gridPos = c.grid ? gridToLatLonLocal(c.grid) : null;
    const loc = gridPos || locations[c.callsign];
    if (!loc) continue;
    let cLat = loc.lat, cLon = wrapLon(shareRefLon, loc.lon);

    // Track furthest QSO from park
    if (parkLat != null) {
      const d = _hav(parkLat, parkLon, cLat, cLon);
      if (d > furthestDist) { furthestDist = d; furthestCall = c.callsign; }
    }
    // Jitter overlapping positions
    const overlap = usedPositions.filter(p => Math.abs(p[0] - cLat) < 0.01 && Math.abs(p[1] - cLon) < 0.01).length;
    if (overlap > 0) {
      const angle = (overlap * 137.5) * Math.PI / 180;
      const r = 0.8 + overlap * 0.3;
      cLat += r * Math.cos(angle);
      cLon += r * Math.sin(angle);
    }
    usedPositions.push([cLat, cLon]);

    L.circleMarker([cLat, cLon], {
      radius: 7, fillColor: '#4fc3f7', color: '#fff', weight: 1.5, fillOpacity: 0.85,
    }).addTo(shareMap);
    bounds.push([cLat, cLon]);

    // Arc from park to contact
    if (parkLat != null) {
      const arcPts = greatCircleArc(parkLat, parkLon, cLat, cLon, 50);
      L.polyline(arcPts, { color: '#4fc3f7', weight: 1.5, opacity: 0.5, dashArray: '6,4' }).addTo(shareMap);
    }
  }

  // Fit bounds: zoom as close as possible while keeping all markers visible.
  // 20px edge padding (scaled to map container), plus extra for text overlays.
  // Text overlays: top ~25% of image, bottom ~18% — convert to map container px.
  const edgePx = Math.round(20 * (mapW / W));   // 20px at final 1080w
  const textTop = Math.round(mapH * 0.25);      // top text overlay zone
  const textBot = Math.round(mapH * 0.18);      // bottom branding zone
  if (bounds.length > 1) {
    shareMap.fitBounds(bounds, {
      paddingTopLeft: [edgePx, textTop + edgePx],
      paddingBottomRight: [edgePx, textBot + edgePx],
    });
  } else if (parkLat != null) {
    shareMap.setView([parkLat, parkLon], 5);
  } else {
    shareMap.setView([39.8, -98.5], 4);
  }

  // Wait for tiles to load
  await new Promise(resolve => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    shareMap.once('idle', done);
    setTimeout(done, 4000); // max 4s
  });
  // Extra buffer for tile rendering
  await new Promise(r => setTimeout(r, 500));

  // Hide overlay during capture so it doesn't darken the map
  overlay.style.display = 'none';
  await new Promise(r => setTimeout(r, 50)); // let repaint
  const rect = mapContainer.getBoundingClientRect();
  const capture = await window.api.captureMainWindowRect({
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });

  // Clean up offscreen map (overlay stays hidden — save dialog comes next)
  shareMap.remove();
  document.body.removeChild(mapContainer);

  if (!capture || !capture.success || !capture.dataUrl) {
    alert('Could not capture map: ' + (capture?.error || 'unknown error'));
    return;
  }

  // Load the captured map into an Image
  const mapImg = new Image();
  await new Promise((resolve, reject) => {
    mapImg.onload = resolve;
    mapImg.onerror = () => reject(new Error('Failed to decode map image'));
    mapImg.src = capture.dataUrl;
  });

  // Load the POTACAT icon
  const iconImg = new Image();
  await new Promise((resolve) => {
    iconImg.onload = resolve;
    iconImg.onerror = resolve; // proceed even if icon fails
    iconImg.src = '../assets/icon-256.png';
  });

  // --- Canvas layout: 1080x1920 (9:16 portrait) ---
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Draw map as background, cover-crop to fill 1080x1920
  const mw = mapImg.naturalWidth, mh = mapImg.naturalHeight;
  const canvasAspect = W / H;
  const imgAspect = mw / mh;
  let sx = 0, sy = 0, sw = mw, sh = mh;
  if (imgAspect > canvasAspect) {
    // Image is wider — crop sides
    sw = Math.round(mh * canvasAspect);
    sx = Math.round((mw - sw) / 2);
  } else {
    // Image is taller — crop top/bottom
    sh = Math.round(mw / canvasAspect);
    sy = Math.round((mh - sh) / 2);
  }
  ctx.drawImage(mapImg, sx, sy, sw, sh, 0, 0, W, H);

  // Gradient overlays for text readability
  // Top: ~400px gradient for callsign/park/QSO text
  const topGrad = ctx.createLinearGradient(0, 0, 0, 480);
  topGrad.addColorStop(0, 'rgba(10, 10, 24, 0.94)');
  topGrad.addColorStop(0.55, 'rgba(10, 10, 24, 0.7)');
  topGrad.addColorStop(1, 'rgba(10, 10, 24, 0)');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, 480);

  // Bottom: ~350px gradient for branding (above IG/FB comment zones)
  const botGrad = ctx.createLinearGradient(0, H - 350, 0, H);
  botGrad.addColorStop(0, 'rgba(10, 10, 24, 0)');
  botGrad.addColorStop(0.4, 'rgba(10, 10, 24, 0.7)');
  botGrad.addColorStop(1, 'rgba(10, 10, 24, 0.94)');
  ctx.fillStyle = botGrad;
  ctx.fillRect(0, H - 350, W, 350);

  // --- Top text (safe zone: 80px margins, start at y=120) ---
  const safeX = 80;
  let textY = 184;

  // Callsign (large bold)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 64px "Segoe UI", sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(shareCallsign || 'ACTIVATOR', safeX, textY);
  textY += 84;

  // "Activated US-1234" or multi-park
  const parkLine = shareRefs.length > 0
    ? 'Activated ' + shareRefs.join(', ')
    : 'Activation';
  ctx.fillStyle = SOURCE_COLORS_ACTIVE.pota;
  ctx.font = 'bold 44px "Segoe UI", sans-serif';
  ctx.fillText(parkLine, safeX, textY);
  textY += 60;

  // Park name
  if (shareParkName && shareParkName.length <= 50) {
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '32px "Segoe UI", sans-serif';
    ctx.fillText(shareParkName, safeX, textY);
    textY += 46;
  }

  // QSO count and modes
  const modes = [...new Set(shareContacts.map(c => c.mode).filter(Boolean))];
  const qsoCount = shareContacts.length;
  const modeLine = modes.length > 0 ? ' on ' + modes.join(', ') : '';
  ctx.fillStyle = '#ffffff';
  ctx.font = '38px "Segoe UI", sans-serif';
  ctx.fillText(`${qsoCount} QSO${qsoCount !== 1 ? 's' : ''}${modeLine}`, safeX, textY);
  textY += 52;

  // Furthest QSO line
  if (furthestCall && furthestDist > 0) {
    const distVal = distUnit === 'km' ? Math.round(furthestDist * MI_TO_KM) : Math.round(furthestDist);
    const distLabel = distUnit === 'km' ? 'km' : 'mi';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '32px "Segoe UI", sans-serif';
    ctx.fillText(`Furthest QSO: ${furthestCall} \u2014 ${distVal.toLocaleString()} ${distLabel}`, safeX, textY);
  }

  // --- Bottom branding (above IG/FB safe zone, ~270px from bottom) ---
  const brandY = H - 270;
  const iconSize = 48;
  if (iconImg.naturalWidth > 0) {
    ctx.drawImage(iconImg, safeX, brandY - iconSize + 8, iconSize, iconSize);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '26px "Segoe UI", sans-serif';
  ctx.textBaseline = 'bottom';
  const brandX = iconImg.naturalWidth > 0 ? safeX + iconSize + 14 : safeX;
  const trackedText = 'Tracked with ';
  const trackedWidth = ctx.measureText(trackedText).width;
  ctx.fillText(trackedText, brandX, brandY - 4);
  ctx.fillStyle = '#4fc3f7';
  ctx.font = 'bold 26px "Segoe UI", sans-serif';
  ctx.fillText('POTACAT', brandX + trackedWidth, brandY - 4);

  // Date stamp (bottom right, same line as branding)
  let dateLabel;
  if (isPast && pastAct.date) {
    const y = pastAct.date.substring(0, 4), m = pastAct.date.substring(4, 6), d = pastAct.date.substring(6, 8);
    dateLabel = new Date(`${y}-${m}-${d}`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  } else {
    dateLabel = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '22px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(dateLabel, W - 80, brandY - 4);
  ctx.textAlign = 'left';

  // Convert to JPG and save
  const jpgDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const jpgBase64 = jpgDataUrl.split(',')[1];
  const result = await window.api.saveShareImage({
    jpgBase64,
    parkRef: shareParkRef,
    callsign: shareCallsign,
  });
  if (result && result.success) {
    showLogToast(`Share image saved to ${result.path.split(/[\\/]/).pop()}`);
  }
  } catch (err) {
    console.error('Share image error:', err);
    alert('Error creating share image: ' + (err?.message || String(err)));
  } finally {
    overlay.remove();
  }
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
  else if (m === 'FT2') activatorModeSelect.value = 'FT2';
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
      if (activatorStateInput) activatorStateInput.value = '';
      return;
    }
    activatorQrzTimeout = setTimeout(async () => {
      const info = await window.api.qrzLookup(val);
      if (info && activatorCallsignInput.value.trim().toUpperCase() === val) {
        activatorOpNameEl.textContent = qrzDisplayName(info);
        if (activatorStateInput) activatorStateInput.value = info.state || '';
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
  if (khz >= 420000 && khz <= 450000) return '70cm';
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
      <input type="text" class="multipark-ref-input" placeholder="Park ref (e.g. K-1234)" maxlength="20" spellcheck="false" autocomplete="off" value="${ref || ''}">
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
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
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
    setTimeout(() => dropdown.classList.add('hidden'), 150);
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
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
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
    setTimeout(() => hunterParkDropdown.classList.add('hidden'), 150);
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


// ===== JTCAT (FT8/FT4 Digital Modes) =====

var jtcatAudioCtx = null;
var jtcatAudioStream = null;
var jtcatAudioProcessor = null;
var jtcatAnalyser = null;
var jtcatAudioSource = null; // strong ref to prevent GC in Chromium 134+
var jtcatRemoteActive = false; // true when phone is driving JTCAT
var jtcatQuietFreq = 1500;     // auto-detected quiet TX frequency (Hz)
var jtcatQuietFreqFrame = 0;   // frame counter for throttling quiet freq updates
var jtcatSpectrumFrame = 0;    // frame counter for throttling spectrum IPC to ~10fps

async function startJtcatAudio() {
  try {
    var s = await window.api.getSettings();
    var audioConstraints = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    // Use the same audio input device as ECHOCAT (remoteAudioInput)
    if (s.remoteAudioInput) {
      audioConstraints.deviceId = { exact: s.remoteAudioInput };
    }
    try {
      jtcatAudioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (e) {
      // Fall back to default device if configured one fails
      console.warn('[JTCAT] Configured audio input not found, using default:', e.message);
      delete audioConstraints.deviceId;
      jtcatAudioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    }

    // Use native sample rate and downsample properly to 12kHz for FT8 decoder.
    jtcatAudioCtx = new AudioContext();
    if (jtcatAudioCtx.state === 'suspended') {
      await jtcatAudioCtx.resume();
    }
    var source = jtcatAudioCtx.createMediaStreamSource(jtcatAudioStream);
    jtcatAudioSource = source; // prevent GC — Chromium 134+ may collect unrooted audio nodes

    // AnalyserNode for waterfall FFT
    jtcatAnalyser = jtcatAudioCtx.createAnalyser();
    jtcatAnalyser.fftSize = 2048;
    jtcatAnalyser.smoothingTimeConstant = 0.3;
    source.connect(jtcatAnalyser);

    var nativeRate = jtcatAudioCtx.sampleRate;
    var dsRatio = nativeRate / 12000;
    console.log('[JTCAT] AudioContext sample rate:', nativeRate, 'dsRatio:', dsRatio.toFixed(2));

    // Try AudioWorklet first (reliable on Chromium 134+), fall back to ScriptProcessorNode
    try {
      await jtcatAudioCtx.audioWorklet.addModule('jtcat-audio-worklet.js');
      var workletNode = new AudioWorkletNode(jtcatAudioCtx, 'jtcat-processor', {
        processorOptions: { dsRatio: dsRatio },
      });
      workletNode.port.onmessage = function(e) {
        window.api.jtcatAudio(e.data);
      };
      source.connect(workletNode);
      workletNode.connect(jtcatAudioCtx.destination);
      jtcatAudioProcessor = workletNode;
      console.log('[JTCAT] Using AudioWorkletNode for audio capture');
    } catch (workletErr) {
      console.warn('[JTCAT] AudioWorklet failed:', workletErr.message, '— falling back to ScriptProcessorNode');
      var bufSize = dsRatio > 1 ? 4096 * Math.ceil(dsRatio) : 4096;
      bufSize = Math.pow(2, Math.ceil(Math.log2(bufSize)));
      if (bufSize > 16384) bufSize = 16384;
      jtcatAudioProcessor = jtcatAudioCtx.createScriptProcessor(bufSize, 1, 1);
      // Build anti-alias FIR filter for proper downsampling
      var firCoeffs = null, firHistory = null, firIdx = 0, decCounter = 0;
      if (dsRatio > 1.01) {
        var cutoff = 0.45 / dsRatio;
        var taps = Math.max(31, Math.round(dsRatio * 16) | 1);
        firCoeffs = new Float32Array(taps);
        firHistory = new Float32Array(taps);
        var mid = (taps - 1) / 2, fsum = 0;
        for (var t = 0; t < taps; t++) {
          var n = t - mid;
          var h = Math.abs(n) < 1e-6 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
          var w = 0.42 - 0.5 * Math.cos(2 * Math.PI * t / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * t / (taps - 1));
          firCoeffs[t] = h * w; fsum += firCoeffs[t];
        }
        for (var t = 0; t < taps; t++) firCoeffs[t] /= fsum;
      }
      jtcatAudioProcessor.onaudioprocess = function(e) {
        try {
          var rawSamples = e.inputBuffer.getChannelData(0);
          var samples;
          if (dsRatio > 1.01) {
            var out = [];
            var ratio = Math.round(dsRatio);
            for (var i = 0; i < rawSamples.length; i++) {
              firHistory[firIdx] = rawSamples[i];
              firIdx = (firIdx + 1) % firCoeffs.length;
              decCounter++;
              if (decCounter >= ratio) {
                decCounter = 0;
                var sum = 0, idx = firIdx;
                for (var t = 0; t < firCoeffs.length; t++) {
                  sum += firHistory[idx] * firCoeffs[t];
                  idx = (idx + 1) % firCoeffs.length;
                }
                out.push(sum);
              }
            }
            samples = out;
          } else {
            samples = Array.from(rawSamples);
          }
          window.api.jtcatAudio(samples);
        } catch (err) {
          console.error('[JTCAT] Audio processor error:', err.message || err);
        }
      };
      source.connect(jtcatAudioProcessor);
      jtcatAudioProcessor.connect(jtcatAudioCtx.destination);
    }

    // Monitor audio stream — some rigs (e.g. Yaesu FT-710) disconnect USB audio during TX
    var audioTrack = jtcatAudioStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.addEventListener('ended', function() {
        console.warn('[JTCAT] Audio track ended (device disconnected?) — restarting capture in 2s');
        setTimeout(function() {
          if (jtcatRunning || jtcatRemoteActive) {
            stopJtcatAudio();
            startJtcatAudio();
          }
        }, 2000);
      });
    }

    // Start waterfall rendering loop
    jtcatWaterfallLoop();

    console.log('[JTCAT] Audio capture started, device:', s.remoteAudioInput || 'default', 'sample rate:', jtcatAudioCtx.sampleRate);
  } catch (err) {
    console.error('[JTCAT] Audio capture failed:', err.message || err);
  }
}

function stopJtcatAudio() {
  if (waterfallAnimFrame) {
    cancelAnimationFrame(waterfallAnimFrame);
    waterfallAnimFrame = null;
  }
  jtcatAnalyser = null;
  jtcatAudioSource = null;
  if (jtcatAudioProcessor) {
    jtcatAudioProcessor.disconnect();
    jtcatAudioProcessor = null;
  }
  if (jtcatAudioCtx) {
    jtcatAudioCtx.close().catch(function() {});
    jtcatAudioCtx = null;
  }
  if (jtcatAudioStream) {
    jtcatAudioStream.getTracks().forEach(function(t) { t.stop(); });
    jtcatAudioStream = null;
  }
}

function startJtcatView() {
  if (jtcatRunning) return;
  jtcatRunning = true;
  jtcatDecodes = [];
  jtcatDecodeLog = [];
  jtcatMapClear();
  // If remote is already driving the engine, just start the UI — don't restart engine/audio
  // If popout is open, it handles its own engine start + audio capture
  if (!jtcatRemoteActive && !jtcatPopoutOpen) {
    window.api.jtcatStart(jtcatModeSelect.value);
    startJtcatAudio();
  }
  startJtcatCountdown();
}

function stopJtcatView() {
  if (!jtcatRunning) return;
  jtcatRunning = false;
  // If the phone is driving JTCAT, keep audio capture and engine running
  if (!jtcatRemoteActive) {
    window.api.jtcatStop();
    stopJtcatAudio();
  }
  if (jtcatCountdownTimer) {
    clearInterval(jtcatCountdownTimer);
    jtcatCountdownTimer = null;
  }
  jtcatCountdown.textContent = '\u2014';
  jtcatCycleIndicator.textContent = '\u2014';
  jtcatSyncStatus.textContent = 'Sync: \u2014';
}

function startJtcatCountdown() {
  if (jtcatCountdownTimer) clearInterval(jtcatCountdownTimer);
  jtcatCountdownTimer = setInterval(() => {
    if (!jtcatRunning) return;
    const now = Date.now();
    const mode = jtcatModeSelect.value;
    const cycleMs = (mode === 'FT4' ? 7.5 : 15) * 1000;
    const msInto = now % cycleMs;
    const remaining = Math.ceil((cycleMs - msInto) / 1000);
    jtcatCountdown.textContent = remaining + 's';
    const cycleSec = mode === 'FT4' ? 7.5 : 15;
    const slot = Math.floor(now / 1000 / cycleSec) % 2 === 0 ? 'Even' : 'Odd';
    jtcatCycleIndicator.textContent = slot;
    jtcatCycleIndicator.className = 'jtcat-cycle ' + (slot === 'Even' ? 'jtcat-slot-even' : 'jtcat-slot-odd');
  }, 200);
}

// Band buttons
document.querySelectorAll('.jtcat-band-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var freq = parseInt(btn.dataset.freq, 10);
    var band = btn.dataset.band;
    // Use JTCAT-specific slice if configured, otherwise main CAT
    var slicePort = jtcatSliceSelect.value ? parseInt(jtcatSliceSelect.value, 10) : 0;
    if (slicePort) {
      window.api.tune(freq, jtcatModeSelect.value, null, slicePort);
    } else {
      window.api.tune(freq, jtcatModeSelect.value);
    }
    jtcatCurrentBand = band;
    document.querySelectorAll('.jtcat-band-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
  });
});

// Mode select
jtcatModeSelect.addEventListener('change', function() {
  if (jtcatRunning) window.api.jtcatSetMode(jtcatModeSelect.value);
  jtcatDecodes = [];
  jtcatDecodeLog = [];
  jtcatMapClear();
  renderJtcatDecodes();
});

// JTCAT Flex slice change — save setting
jtcatSliceSelect.addEventListener('change', async function() {
  var s = await window.api.getSettings();
  s.jtcatFlexSlice = jtcatSliceSelect.value || '';
  await window.api.saveSettings(s);
});

// TX/RX freq inputs
jtcatTxFreqInput.addEventListener('change', function() {
  jtcatTxFreq = parseInt(jtcatTxFreqInput.value, 10) || 1500;
  jtcatTxFreqLabel.textContent = 'TX: ' + jtcatTxFreq + ' Hz';
  if (jtcatRunning) window.api.jtcatSetTxFreq(jtcatTxFreq);
});
jtcatRxFreqInput.addEventListener('change', function() {
  jtcatRxFreq = parseInt(jtcatRxFreqInput.value, 10) || 1500;
  jtcatRxFreqLabel.textContent = jtcatRxFreq + ' Hz';
  if (jtcatRunning) window.api.jtcatSetRxFreq(jtcatRxFreq);
});
jtcatTxSlotSelect.addEventListener('change', function() {
  window.api.jtcatSetTxSlot(jtcatTxSlotSelect.value);
});

// Enable TX / Halt TX
jtcatEnableTxBtn.addEventListener('click', function() {
  var enabled = jtcatEnableTxBtn.classList.toggle('active');
  jtcatEnableTxBtn.textContent = enabled ? 'TX Enabled' : 'Enable TX';
  window.api.jtcatEnableTx(enabled);
});
jtcatHaltTxBtn.addEventListener('click', function() {
  jtcatDisableTxUi();
  jtcatClearQso();
});

// CQ-only filter toggle
jtcatCqFilterBtn.addEventListener('click', function() {
  jtcatCqFilter = !jtcatCqFilter;
  jtcatCqFilterBtn.classList.toggle('active', jtcatCqFilter);
  renderJtcatDecodes();
});

function renderJtcatDecodes() {
  // --- Band Activity: full scrolling log grouped by cycle ---
  var wasAtBottom = jtcatBandActivity.scrollTop + jtcatBandActivity.clientHeight >= jtcatBandActivity.scrollHeight - 20;

  if (jtcatDecodeLog.length === 0) {
    jtcatBandActivity.innerHTML = '<div class="jtcat-empty">Waiting for decodes...</div>';
  } else {
    var html = '';
    var myCall = getMyCallsign();
    for (var i = 0; i < jtcatDecodeLog.length; i++) {
      var entry = jtcatDecodeLog[i];
      var rows = '';
      for (var j = 0; j < entry.results.length; j++) {
        var d = entry.results[j];
        if (jtcatCqFilter) {
          var upper = (d.text || '').toUpperCase();
          var isCq = upper.startsWith('CQ ');
          var is73 = upper.indexOf('RR73') >= 0 || upper.indexOf(' 73') >= 0;
          var isDirected = myCall && upper.indexOf(' ' + myCall + ' ') >= 0;
          if (!isCq && !is73 && !isDirected) continue;
        }
        var cls = getJtcatDecodeClass(d);
        rows += '<div class="jtcat-decode-row ' + cls + '" data-df="' + d.df + '" data-text="' + escJtcat(d.text) + '">' + formatJtcatDecode(d) + '</div>';
      }
      if (!jtcatCqFilter || rows) {
        html += '<div class="jtcat-cycle-separator">' + entry.time + ' UTC &mdash; ' + entry.mode + '</div>' + rows;
      }
    }
    jtcatBandActivity.innerHTML = html || '<div class="jtcat-empty">No CQ/73 decodes yet</div>';
  }

  // Auto-scroll to bottom if user was already near the bottom
  if (wasAtBottom) {
    jtcatBandActivity.scrollTop = jtcatBandActivity.scrollHeight;
  }

  // --- RX Frequency panel: only current cycle, filtered by RX freq ---
  var rxNear = jtcatDecodes.filter(function(d) { return Math.abs(d.df - jtcatRxFreq) <= 50; });
  if (rxNear.length === 0) {
    jtcatRxActivity.innerHTML = '<div class="jtcat-empty">\u2014</div>';
  } else {
    jtcatRxActivity.innerHTML = rxNear.map(function(d) {
      var cls = getJtcatDecodeClass(d);
      return '<div class="jtcat-decode-row ' + cls + '" data-df="' + d.df + '" data-text="' + escJtcat(d.text) + '">' + formatJtcatDecode(d) + '</div>';
    }).join('');
  }

  // Click handlers
  jtcatBandActivity.querySelectorAll('.jtcat-decode-row').forEach(function(row) {
    row.addEventListener('dblclick', onJtcatDecodeClick);
  });
  jtcatRxActivity.querySelectorAll('.jtcat-decode-row').forEach(function(row) {
    row.addEventListener('dblclick', onJtcatDecodeClick);
  });

  // Auto-advance QSO state machine on incoming decodes
  if (jtcatQso && jtcatQso.phase !== 'done') {
    jtcatProcessQsoResponse();
  }
}

function onJtcatDecodeClick(e) {
  var row = e.currentTarget;
  var df = parseInt(row.dataset.df, 10);
  var text = row.dataset.text || '';
  var upper = text.toUpperCase();
  var myCall = getMyCallsign();

  // Set RX freq to this decode's offset
  jtcatRxFreq = df;
  jtcatRxFreqInput.value = df;
  jtcatRxFreqLabel.textContent = df + ' Hz';
  if (jtcatRunning) window.api.jtcatSetRxFreq(df);

  // If it's a CQ, start a QSO (reply to their CQ)
  var cqMatch = upper.match(/^CQ\s+(?:(\w+)\s+)?([A-Z0-9/]+)\s+([A-R]{2}\d{2})/);
  if (cqMatch) {
    var theirCall = cqMatch[2];
    var theirGrid = cqMatch[3];
    jtcatStartQso(theirCall, theirGrid, df);
  }
  // If it's directed at me (MYCALL THEIRCALL PAYLOAD), pick up the QSO
  else if (myCall) {
    var parts = upper.split(/\s+/);
    if (parts.length >= 2 && parts[0] === myCall) {
      var fromCall = parts[1];
      var payload = parts[2] || '';
      var grid = /^[A-R]{2}[0-9]{2}$/.test(payload) ? payload : '';
      var rptMatch = payload.match(/^R?([+-]\d{2})$/);
      var hasRR73 = payload === 'RR73' || payload === 'RRR' || payload === '73';
      var snr = parseInt(row.dataset.db, 10) || 0;

      if (hasRR73) {
        // QSO complete — just send 73 back
        var txMsg = fromCall + ' ' + myCall + ' 73';
        jtcatQso = { mode: 'reply', call: fromCall, grid: '', phase: '73',
          txMsg: txMsg, report: null, sentReport: null, myCall: myCall, myGrid: getMyGrid(), txRetries: 0 };
        jtcatSetTxAndSend(txMsg);
        jtcatEnableTxUi();
        renderJtcatQsoTracker();
      } else if (rptMatch) {
        // They sent us a report — reply with R+our-report
        var ourReport = snr >= 0 ? '+' + String(snr).padStart(2, '0') : String(snr).padStart(3, '0');
        var txMsg = fromCall + ' ' + myCall + ' R' + ourReport;
        jtcatQso = { mode: 'reply', call: fromCall, grid: grid, phase: 'r+report',
          txMsg: txMsg, report: rptMatch[1], sentReport: ourReport, myCall: myCall, myGrid: getMyGrid(), txRetries: 0 };
        jtcatSetTxAndSend(txMsg);
        jtcatEnableTxUi();
        renderJtcatQsoTracker();
      } else {
        // They sent grid or other — start normal reply QSO
        jtcatStartQso(fromCall, grid, df);
      }
      // Set TX freq to their freq
      jtcatTxFreq = df;
      jtcatTxFreqInput.value = df;
      jtcatTxFreqLabel.textContent = 'TX: ' + df + ' Hz';
      if (jtcatRunning) window.api.jtcatSetTxFreq(df);
      console.log('[JTCAT] Picked up QSO with', fromCall, 'payload:', payload);
    }
  }
  renderJtcatDecodes();
}

// --- QSO State Machine ---
//
// Two flows:
//   CQ caller:   cq → cq-report → cq-rr73 → done
//   Responder:   reply → r+report → 73 → done
//
// Each phase has a direction (tx/rx) and a message template.

function getMyCallsign() {
  var el = document.getElementById('set-my-callsign');
  return el ? el.value.toUpperCase().trim() : '';
}

function getMyGrid() {
  var el = document.getElementById('set-grid');
  return el ? el.value.toUpperCase().trim().substring(0, 4) : '';
}

// Phase definitions for the sequence display
var QSO_PHASES_CQ = [
  { key: 'cq',        dir: 'tx', label: function(q) { return 'CQ ' + q.myCall + ' ' + q.myGrid; } },
  { key: 'cq-reply',  dir: 'rx', label: function(q) { return (q.call || '?') + ' ' + q.myCall + ' ' + (q.grid || '??'); } },
  { key: 'cq-report', dir: 'tx', label: function(q) { return (q.call || '?') + ' ' + q.myCall + ' ' + (q.sentReport || '-XX'); } },
  { key: 'cq-r+rpt',  dir: 'rx', label: function(q) { return q.myCall + ' ' + (q.call || '?') + ' R' + (q.report || '-XX'); } },
  { key: 'cq-rr73',   dir: 'tx', label: function(q) { return (q.call || '?') + ' ' + q.myCall + ' RR73'; } },
  { key: 'done',      dir: '--', label: function()  { return 'QSO Complete'; } },
];

var QSO_PHASES_REPLY = [
  { key: 'reply',     dir: 'tx', label: function(q) { return q.call + ' ' + q.myCall + ' ' + q.myGrid; } },
  { key: 'rpt-rx',    dir: 'rx', label: function(q) { return q.myCall + ' ' + q.call + ' ' + (q.report || '-XX'); } },
  { key: 'r+report',  dir: 'tx', label: function(q) { return q.call + ' ' + q.myCall + ' R' + (q.sentReport || '-XX'); } },
  { key: 'rr73-rx',   dir: 'rx', label: function(q) { return q.myCall + ' ' + q.call + ' RR73'; } },
  { key: '73',        dir: 'tx', label: function(q) { return q.call + ' ' + q.myCall + ' 73'; } },
  { key: 'done',      dir: '--', label: function()  { return 'QSO Complete'; } },
];

function jtcatSetTxAndSend(msg) {
  jtcatTxMsgText.textContent = msg;
  window.api.jtcatSetTxMsg(msg);
}

function jtcatEnableTxUi() {
  jtcatEnableTxBtn.classList.add('active');
  jtcatEnableTxBtn.textContent = 'TX Enabled';
  window.api.jtcatEnableTx(true);
}

function jtcatDisableTxUi() {
  jtcatEnableTxBtn.classList.remove('active');
  jtcatEnableTxBtn.textContent = 'Enable TX';
  window.api.jtcatHaltTx();
  window.api.jtcatSetTxMsg('');
}

// --- CQ Calling ---

jtcatCallCqBtn.addEventListener('click', function() {
  jtcatCallCq();
});

function jtcatCallCq() {
  var myCall = getMyCallsign();
  var myGrid = getMyGrid();
  if (!myCall || !myGrid) {
    jtcatTxMsgText.textContent = 'Set callsign & grid in Settings first';
    console.warn('[JTCAT] CQ aborted — callsign:', myCall || '(empty)', 'grid:', myGrid || '(empty)');
    return;
  }

  var txMsg = 'CQ ' + myCall + ' ' + myGrid;
  jtcatQso = {
    mode: 'cq',
    call: null,
    grid: null,
    phase: 'cq',
    txMsg: txMsg,
    report: null,
    sentReport: null,
    myCall: myCall,
    myGrid: myGrid,
    txRetries: 0,
  };
  jtcatSetTxAndSend(txMsg);
  jtcatEnableTxUi();
  jtcatCallCqBtn.classList.add('active');
  renderJtcatQsoTracker();
  console.log('[JTCAT] Calling CQ:', txMsg);
}

// --- Reply to CQ (existing, refactored) ---

function jtcatStartQso(theirCall, theirGrid, df) {
  var myCall = getMyCallsign();
  var myGrid = getMyGrid();
  if (!myCall) return;

  // Set TX freq to their freq
  jtcatTxFreq = df;
  jtcatTxFreqInput.value = df;
  jtcatTxFreqLabel.textContent = 'TX: ' + df + ' Hz';
  if (jtcatRunning) window.api.jtcatSetTxFreq(df);

  // Build initial reply message: "THEIRCALL MYCALL MYGRID"
  var txMsg = theirCall + ' ' + myCall + ' ' + myGrid;
  jtcatQso = {
    mode: 'reply',
    call: theirCall,
    grid: theirGrid,
    phase: 'reply',
    txMsg: txMsg,
    report: null,
    sentReport: null,
    myCall: myCall,
    myGrid: myGrid,
    txRetries: 0,
  };
  jtcatSetTxAndSend(txMsg);
  jtcatEnableTxUi();
  renderJtcatQsoTracker();
  console.log('[JTCAT] QSO started with', theirCall, '— sending:', txMsg);
}

// --- Process incoming decodes for QSO advancement ---

function jtcatProcessQsoResponse() {
  if (!jtcatQso || jtcatQso.phase === 'done') return;
  var myCall = jtcatQso.myCall;
  var phaseBefore = jtcatQso.phase;

  if (jtcatQso.mode === 'cq') {
    jtcatProcessCqResponse(myCall);
  } else {
    jtcatProcessReplyResponse(myCall);
  }

  // Count retries — if phase didn't advance, increment; if it did, reset
  if (jtcatQso && jtcatQso.phase === phaseBefore && jtcatQso.phase !== 'done') {
    jtcatQso.txRetries = (jtcatQso.txRetries || 0) + 1;
    var max = (jtcatQso.phase === 'cq') ? JTCAT_MAX_CQ_RETRIES : JTCAT_MAX_QSO_RETRIES;
    if (jtcatQso.txRetries >= max) {
      console.log('[JTCAT] TX retry limit reached (' + max + ') in phase ' + jtcatQso.phase + ' — giving up');
      jtcatTxMsgText.textContent = 'No response — TX stopped';
      jtcatDisableTxUi();
      jtcatClearQso();
    }
  } else if (jtcatQso && jtcatQso.phase !== phaseBefore) {
    jtcatQso.txRetries = 0; // reset on phase advance
  }
}

function jtcatProcessCqResponse(myCall) {
  var q = jtcatQso;

  if (q.phase === 'cq') {
    // Waiting for someone to reply: look for "MYCALL THEIRCALL GRID"
    var reply = jtcatDecodes.find(function(d) {
      var t = (d.text || '').toUpperCase();
      // Must contain our call but NOT start with CQ, and not be our own message
      return t.indexOf(myCall) >= 0 && !t.startsWith('CQ ') && t.indexOf(myCall) !== 0;
    });
    if (!reply) return;
    var text = (reply.text || '').toUpperCase();
    // Parse "MYCALL THEIRCALL GRID" or "MYCALL THEIRCALL GRID"
    var m = text.match(new RegExp(myCall.replace(/[/]/g, '\\/') + '\\s+([A-Z0-9/]+)\\s+([A-R]{2}\\d{2})', 'i'));
    if (!m) return;
    q.call = m[1];
    q.grid = m[2];
    // Send report: "THEIRCALL MYCALL -XX"
    var rpt = reply.db >= 0 ? '+' + String(reply.db).padStart(2, '0') : String(reply.db).padStart(3, '0');
    q.sentReport = rpt;
    q.txMsg = q.call + ' ' + myCall + ' ' + rpt;
    q.phase = 'cq-report';
    jtcatSetTxAndSend(q.txMsg);
    // Set RX freq to their offset
    jtcatRxFreq = reply.df;
    jtcatRxFreqInput.value = reply.df;
    if (jtcatRunning) window.api.jtcatSetRxFreq(reply.df);
    renderJtcatQsoTracker();
    console.log('[JTCAT] CQ answered by', q.call, '— sending report:', q.txMsg);
    return;
  }

  if (q.phase === 'cq-report') {
    // Expect "MYCALL THEIRCALL R-XX"
    var response = jtcatDecodes.find(function(d) {
      var t = (d.text || '').toUpperCase();
      return t.indexOf(myCall) >= 0 && t.indexOf(q.call) >= 0;
    });
    if (!response) return;
    var text = (response.text || '').toUpperCase();
    var rptMatch = text.match(/R([+-]\d{2})/);
    if (!rptMatch) return;
    q.report = rptMatch[1];
    q.txMsg = q.call + ' ' + myCall + ' RR73';
    q.phase = 'cq-rr73';
    jtcatSetTxAndSend(q.txMsg);
    renderJtcatQsoTracker();
    console.log('[JTCAT] CQ got R+report from', q.call, '— sending RR73');
    return;
  }

  if (q.phase === 'cq-rr73') {
    // QSO complete after we send RR73 (they may send 73 back but we're done)
    q.phase = 'done';
    jtcatDisableTxUi();
    jtcatCallCqBtn.classList.remove('active');
    jtcatTxMsgText.textContent = 'QSO complete: ' + q.call;
    renderJtcatQsoTracker();
    console.log('[JTCAT] CQ QSO complete with', q.call);
  }
}

function jtcatProcessReplyResponse(myCall) {
  var q = jtcatQso;
  var theirCall = q.call;

  var response = jtcatDecodes.find(function(d) {
    var t = (d.text || '').toUpperCase();
    return t.indexOf(myCall) >= 0 && t.indexOf(theirCall) >= 0;
  });
  if (!response) return;
  var text = (response.text || '').toUpperCase();

  if (q.phase === 'reply') {
    // Expect their signal report: "MYCALL THEIRCALL -XX" or "MYCALL THEIRCALL R-XX"
    var rptMatch = text.match(/[R]?([+-]\d{2})/);
    if (!rptMatch) return;
    q.report = rptMatch[1];
    var ourReport = response.db >= 0 ? '+' + String(response.db).padStart(2, '0') : String(response.db).padStart(3, '0');
    q.sentReport = ourReport;
    if (text.indexOf('R' + rptMatch[1]) >= 0 || text.indexOf('R+') >= 0 || text.indexOf('R-') >= 0) {
      q.txMsg = theirCall + ' ' + myCall + ' RR73';
      q.phase = '73';
    } else {
      q.txMsg = theirCall + ' ' + myCall + ' R' + ourReport;
      q.phase = 'r+report';
    }
    jtcatSetTxAndSend(q.txMsg);
    renderJtcatQsoTracker();
    console.log('[JTCAT] QSO phase:', q.phase, '— sending:', q.txMsg);

  } else if (q.phase === 'r+report') {
    if (text.indexOf('RR73') >= 0 || text.indexOf('RRR') >= 0 || text.indexOf(' 73') >= 0) {
      q.txMsg = theirCall + ' ' + myCall + ' 73';
      q.phase = '73';
      jtcatSetTxAndSend(q.txMsg);
      renderJtcatQsoTracker();
      console.log('[JTCAT] QSO phase: 73 — sending:', q.txMsg);
    }

  } else if (q.phase === '73') {
    q.phase = 'done';
    jtcatDisableTxUi();
    jtcatTxMsgText.textContent = 'QSO complete: ' + theirCall;
    renderJtcatQsoTracker();
    console.log('[JTCAT] QSO complete with', theirCall);
    // TODO: auto-log the QSO
  }
}

// --- Skip to next QSO phase ---
function jtcatSkipPhase() {
  if (!jtcatQso || jtcatQso.phase === 'done' || jtcatQso.phase === 'idle') return;
  var q = jtcatQso;
  var myCall = q.myCall;
  if (q.mode === 'cq') {
    if (q.phase === 'cq-report') {
      q.txMsg = q.call + ' ' + myCall + ' RR73';
      q.phase = 'cq-rr73';
    } else if (q.phase === 'cq-rr73') {
      q.phase = 'done';
      jtcatDisableTxUi();
      jtcatCallCqBtn.classList.remove('active');
      jtcatTxMsgText.textContent = 'QSO complete: ' + q.call;
    }
  } else {
    if (q.phase === 'reply') {
      var rpt = q.sentReport || '-10';
      q.txMsg = q.call + ' ' + myCall + ' R' + rpt;
      q.phase = 'r+report';
    } else if (q.phase === 'r+report') {
      q.txMsg = q.call + ' ' + myCall + ' RR73';
      q.phase = '73';
    } else if (q.phase === '73') {
      q.phase = 'done';
      jtcatDisableTxUi();
      jtcatTxMsgText.textContent = 'QSO complete: ' + q.call;
    }
  }
  q.txRetries = 0;
  jtcatSetTxAndSend(q.txMsg || '');
  renderJtcatQsoTracker();
  console.log('[JTCAT] Manual skip to phase:', q.phase, '— TX:', q.txMsg);
}

// --- QSO state broadcast to pop-out ---
function broadcastJtcatQsoState() {
  if (!jtcatPopoutOpen) return;
  if (jtcatQso) {
    window.api.sendJtcatQsoState({
      mode: jtcatQso.mode,
      call: jtcatQso.call,
      grid: jtcatQso.grid,
      phase: jtcatQso.phase,
      txMsg: jtcatQso.txMsg,
      report: jtcatQso.report,
      sentReport: jtcatQso.sentReport,
      myCall: jtcatQso.myCall,
      myGrid: jtcatQso.myGrid,
    });
  } else {
    window.api.sendJtcatQsoState({ phase: 'idle' });
  }
}

// --- QSO Sequence Display ---

function renderJtcatQsoTracker() {
  broadcastJtcatQsoState();
  if (!jtcatQso) {
    jtcatQsoTracker.classList.add('hidden');
    return;
  }
  jtcatQsoTracker.classList.remove('hidden');
  var q = jtcatQso;
  var phases = q.mode === 'cq' ? QSO_PHASES_CQ : QSO_PHASES_REPLY;

  // Header
  if (q.mode === 'cq') {
    jtcatQsoLabel.textContent = q.call ? 'CQ \u2192 ' + q.call : 'Calling CQ...';
  } else {
    jtcatQsoLabel.textContent = 'Reply \u2192 ' + q.call;
  }

  // Find current phase index
  var currentIdx = -1;
  for (var i = 0; i < phases.length; i++) {
    if (phases[i].key === q.phase) { currentIdx = i; break; }
  }
  // For CQ mode, cq-reply is implicit (rx between cq and cq-report)
  // Map actual phase to display index
  if (q.mode === 'cq' && q.phase === 'cq-report') currentIdx = 2;
  if (q.mode === 'cq' && q.phase === 'cq-rr73') currentIdx = 4;
  if (q.mode === 'cq' && q.phase === 'done') currentIdx = 5;
  if (q.mode === 'reply' && q.phase === 'r+report') currentIdx = 2;
  if (q.mode === 'reply' && q.phase === '73') currentIdx = 4;
  if (q.mode === 'reply' && q.phase === 'done') currentIdx = 5;

  var html = '';
  for (var i = 0; i < phases.length; i++) {
    var p = phases[i];
    var cls = 'jtcat-qso-step';
    if (i < currentIdx) cls += ' step-done';
    else if (i === currentIdx) cls += ' step-current step-' + p.dir;

    var dirTag = '';
    if (p.dir === 'tx') dirTag = '<span class="step-dir">TX</span> ';
    else if (p.dir === 'rx') dirTag = '<span class="step-dir">RX</span> ';

    if (i > 0) html += '<span class="jtcat-qso-arrow">\u25B6</span>';
    html += '<span class="' + cls + '">' + dirTag + escJtcat(p.label(q)) + '</span>';
  }
  jtcatQsoSteps.innerHTML = html;
}

function jtcatClearQso() {
  jtcatQso = null;
  jtcatTxMsgText.textContent = '\u2014';
  jtcatCallCqBtn.classList.remove('active');
  window.api.jtcatSetTxMsg('');
  renderJtcatQsoTracker();
}

// Cancel QSO button
jtcatQsoSkipBtn.addEventListener('click', function() {
  jtcatSkipPhase();
});
jtcatQsoCancelBtn.addEventListener('click', function() {
  jtcatDisableTxUi();
  jtcatClearQso();
});

// --- POTA activator lookup ---

function jtcatGetActivatorSpot(callsign) {
  var upper = callsign.toUpperCase();
  return allSpots.find(function(s) {
    return (s.source === 'pota' || s.source === 'sota') && s.callsign && s.callsign.toUpperCase() === upper;
  });
}

function formatJtcatDecode(d) {
  var db = String(d.db).padStart(3, ' ');
  var dt = d.dt >= 0 ? '+' + d.dt.toFixed(1) : d.dt.toFixed(1);
  var df = String(d.df).padStart(4, ' ');
  var text = (d.text || '');
  var html = '<span class="jtcat-db">' + db + '</span> <span class="jtcat-dt">' + dt + '</span> <span class="jtcat-df">' + df + '</span> <span class="jtcat-msg">' + escJtcat(text) + '</span>';

  // Check for POTA/SOTA activator badge
  var words = text.split(/\s+/);
  for (var i = 0; i < words.length; i++) {
    var spot = jtcatGetActivatorSpot(words[i]);
    if (spot) {
      var badge = spot.source === 'pota' ? 'POTA' : 'SOTA';
      var ref = spot.reference || '';
      html += ' <span class="jtcat-pota-badge" title="' + escJtcat(ref + ' ' + (spot.parkName || '')) + '">' + badge + '</span>';
      break;
    }
  }
  return html;
}

function escJtcat(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getJtcatDecodeClass(d) {
  var text = d.text || '';
  if (text.startsWith('CQ ')) return 'jtcat-cq';
  var myCall = getMyCallsign();
  if (myCall && text.toUpperCase().indexOf(' ' + myCall + ' ') >= 0) return 'jtcat-directed';
  // Highlight if callsign is a POTA/SOTA activator
  var words = text.split(/\s+/);
  for (var i = 0; i < words.length; i++) {
    if (jtcatGetActivatorSpot(words[i])) return 'jtcat-cq'; // green highlight for activators too
  }
  return '';
}

// --- JTCAT Map ---
var jtcatMap = null;
var jtcatMapMarkers = L.layerGroup();  // station dot markers
var jtcatMapArcs = L.layerGroup();     // animated QSO arcs
var jtcatMapHome = null;
var jtcatMapStations = {};  // callsign → {marker, grid, lat, lon, lastSeen}
var jtcatMapQsos = {};      // "CALL1↔CALL2" → {arc, from, to, lastSeen, dir}
var JTCAT_ARC_SEGMENTS = 32;

function initJtcatMap() {
  var myGrid = getMyGrid();
  var center = [20, 0];
  var zoom = 2;
  if (myGrid) {
    var pos = gridToLatLonLocal(myGrid);
    if (pos) { center = [pos.lat, pos.lon]; zoom = 4; }
  }
  jtcatMap = L.map('jtcat-map', { zoomControl: true, worldCopyJump: true }).setView(center, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OSM',
    maxZoom: 18,
    className: 'dark-tiles',
  }).addTo(jtcatMap);
  jtcatMapMarkers.addTo(jtcatMap);
  jtcatMapArcs.addTo(jtcatMap);
  updateJtcatMapHome();
}

function updateJtcatMapHome() {
  if (jtcatMapHome) { jtcatMap.removeLayer(jtcatMapHome); jtcatMapHome = null; }
  var myGrid = getMyGrid();
  if (!myGrid || !jtcatMap) return;
  var bounds = gridToBoundsLocal(myGrid);
  if (!bounds) return;
  jtcatMapHome = L.rectangle(bounds, {
    fillColor: '#e94560', fillOpacity: 0.35, color: '#e94560', weight: 2,
  }).addTo(jtcatMap).bindTooltip(getMyCallsign() || 'Home', { permanent: false });
}

// Register/update a station's grid on the map
function jtcatMapRegisterStation(call, grid) {
  if (!jtcatMap || !call || call.length < 3) return;
  if (!grid || !/^[A-R]{2}[0-9]{2}$/i.test(grid)) return;
  grid = grid.toUpperCase();
  var bounds = gridToBoundsLocal(grid);
  var pos = gridToLatLonLocal(grid);
  if (!bounds || !pos) return;
  var existing = jtcatMapStations[call];
  if (existing) {
    existing.lastSeen = Date.now();
    if (grid !== existing.grid) {
      existing.grid = grid;
      existing.lat = pos.lat;
      existing.lon = pos.lon;
      existing.marker.setBounds(bounds);
      existing.marker.setTooltipContent(call + ' [' + grid + ']');
    }
    return;
  }
  var myCall = getMyCallsign();
  var isMe = myCall && call === myCall;
  var color = isMe ? '#e94560' : '#4fc3f7';
  var marker = L.rectangle(bounds, {
    fillColor: color, fillOpacity: isMe ? 0.35 : 0.25, color: color, weight: 1,
  }).addTo(jtcatMapMarkers).bindTooltip(call + ' [' + grid + ']', { permanent: false });
  jtcatMapStations[call] = { marker: marker, grid: grid, lat: pos.lat, lon: pos.lon, lastSeen: Date.now() };
}

// Compute a curved arc between two lat/lon points (returns array of [lat,lon])
function jtcatComputeArc(lat1, lon1, lat2, lon2) {
  var points = [];
  var n = JTCAT_ARC_SEGMENTS;
  // Great circle midpoint + offset for curvature
  var toRad = Math.PI / 180;
  var toDeg = 180 / Math.PI;
  var dLat = lat2 - lat1;
  var dLon = lon2 - lon1;
  var dist = Math.sqrt(dLat * dLat + dLon * dLon); // approx degree-distance
  var bulge = dist * 0.2; // arc bulge = 20% of distance
  // Perpendicular direction (rotate 90 deg)
  var perpLat = -dLon / (dist || 1);
  var perpLon = dLat / (dist || 1);
  for (var i = 0; i <= n; i++) {
    var t = i / n;
    // Linear interpolation
    var lat = lat1 + dLat * t;
    var lon = lon1 + dLon * t;
    // Parabolic offset (peaks at t=0.5)
    var offset = 4 * t * (1 - t) * bulge;
    lat += perpLat * offset;
    lon += perpLon * offset;
    points.push([lat, lon]);
  }
  return points;
}

// Draw or update an animated arc for a QSO
function jtcatMapDrawQsoArc(fromCall, toCall) {
  var fromStn = jtcatMapStations[fromCall];
  var toStn = jtcatMapStations[toCall];
  if (!fromStn || !toStn) return;
  var key = [fromCall, toCall].sort().join('\u2194');
  var existing = jtcatMapQsos[key];
  var arcPoints = jtcatComputeArc(fromStn.lat, fromStn.lon, toStn.lat, toStn.lon);

  var myCall = getMyCallsign();
  var involvesMe = (fromCall === myCall || toCall === myCall);
  var color = involvesMe ? '#e94560' : '#4fc3f7';

  if (existing) {
    existing.arc.setLatLngs(arcPoints);
    existing.arc.setTooltipContent(fromCall + ' \u2192 ' + toCall);
    existing.lastSeen = Date.now();
    existing.from = fromCall;
    existing.to = toCall;
    // Update animation direction
    jtcatAnimateArc(existing.arc, fromCall, toCall, fromStn, toStn, color);
    return;
  }
  var arc = L.polyline(arcPoints, {
    color: color, weight: 2, opacity: 0.8,
    dashArray: '8 6', lineCap: 'round',
  }).addTo(jtcatMapArcs);
  arc.bindTooltip(fromCall + ' \u2192 ' + toCall, { sticky: true });
  jtcatMapQsos[key] = { arc: arc, from: fromCall, to: toCall, lastSeen: Date.now() };
  // SVG element may not be available immediately after addTo()
  setTimeout(function() { jtcatAnimateArc(arc, fromCall, toCall, fromStn, toStn, color); }, 0);
}

// Animate the arc's dash to flow from transmitter → receiver
function jtcatAnimateArc(arc, fromCall, toCall, fromStn, toStn, color) {
  var el = arc.getElement();
  if (!el) return;
  el.style.stroke = color;
  // Determine if the arc's geometry goes from→to or to→from
  // Arc points always go from sorted-first to sorted-second
  var sorted = [fromCall, toCall].sort();
  var forward = sorted[0] === fromCall; // true = SVG path goes in TX direction
  el.classList.remove('jtcat-arc-forward', 'jtcat-arc-reverse');
  el.classList.add(forward ? 'jtcat-arc-forward' : 'jtcat-arc-reverse');
}

function jtcatMapPlotDecode(d) {
  if (!jtcatMap) return;
  var text = (d.text || '').toUpperCase();
  var parts = text.split(/\s+/);

  if (text.startsWith('CQ ')) {
    // CQ [DX] CALL GRID — register the CQ caller
    var idx = 1;
    if (parts.length > 3 && parts[1].length <= 4 && !/[0-9]/.test(parts[1])) idx = 2;
    var call = parts[idx] || '';
    var grid = parts[idx + 1] || '';
    jtcatMapRegisterStation(call, grid);
    // Mark CQ callers green
    var stn = jtcatMapStations[call];
    if (stn) {
      stn.marker.setStyle({ fillColor: '#4ecca3', color: '#4ecca3' });
    }
  } else if (parts.length >= 2) {
    // TOCALL FROMCALL [GRID|REPORT|RR73|73]
    var toCall = parts[0];
    var fromCall = parts[1];
    var payload = parts[2] || '';

    // Learn grid if it's in the message
    if (/^[A-R]{2}[0-9]{2}$/i.test(payload)) {
      jtcatMapRegisterStation(fromCall, payload);
    }

    // Update lastSeen for both
    if (jtcatMapStations[fromCall]) jtcatMapStations[fromCall].lastSeen = Date.now();
    if (jtcatMapStations[toCall]) jtcatMapStations[toCall].lastSeen = Date.now();

    // Draw QSO arc if both stations have known positions
    if (jtcatMapStations[fromCall] && jtcatMapStations[toCall]) {
      jtcatMapDrawQsoArc(fromCall, toCall);
    }
  }
}

function jtcatMapClearOld() {
  var now = Date.now();
  // Remove QSO arcs not seen in last 45 seconds (3 FT8 cycles)
  var arcCutoff = now - 45000;
  Object.keys(jtcatMapQsos).forEach(function(key) {
    var q = jtcatMapQsos[key];
    if (q.lastSeen < arcCutoff) {
      jtcatMapArcs.removeLayer(q.arc);
      delete jtcatMapQsos[key];
    }
  });
  // Remove stations not seen in 3 minutes
  var stnCutoff = now - 180000;
  Object.keys(jtcatMapStations).forEach(function(call) {
    var s = jtcatMapStations[call];
    if (s.lastSeen < stnCutoff) {
      jtcatMapMarkers.removeLayer(s.marker);
      delete jtcatMapStations[call];
    }
  });
}

function jtcatMapClear() {
  jtcatMapMarkers.clearLayers();
  jtcatMapArcs.clearLayers();
  jtcatMapStations = {};
  jtcatMapQsos = {};
}

// Waterfall rendering
var waterfallCtx = jtcatWaterfall.getContext('2d');
var waterfallAnimFrame = null;

function jtcatWaterfallLoop() {
  if ((!jtcatRunning && !jtcatRemoteActive) || !jtcatAnalyser) return;

  try {
  var freqData = new Uint8Array(jtcatAnalyser.frequencyBinCount);
  jtcatAnalyser.getByteFrequencyData(freqData);

  // AnalyserNode covers 0 to sampleRate/2. FT8 passband is 0–3000 Hz.
  // At native rate (e.g. 48kHz), bins cover 0–24000 Hz, so 3000 Hz = 3000/24000 * 1024 = ~128 bins.
  var nyquist = (jtcatAudioCtx ? jtcatAudioCtx.sampleRate : 12000) / 2;
  var passbandBins = Math.floor(3000 / nyquist * freqData.length);

  var w = jtcatWaterfall.width;
  var h = jtcatWaterfall.height;

  // Scroll existing image down by 1 pixel
  var imgData = waterfallCtx.getImageData(0, 0, w, h - 1);
  waterfallCtx.putImageData(imgData, 0, 1);

  // Draw new line at top row
  var lineData = waterfallCtx.createImageData(w, 1);
  for (var x = 0; x < w; x++) {
    var binIdx = Math.floor(x * passbandBins / w);
    var val = freqData[binIdx]; // 0–255

    // Color map: dark blue → cyan → yellow → red → white
    var norm = val / 255;
    var r, g, b;
    if (norm < 0.2) {
      // Black to dark blue
      r = 0;
      g = 0;
      b = Math.floor(norm * 5 * 140);
    } else if (norm < 0.4) {
      // Dark blue to cyan
      var t = (norm - 0.2) * 5;
      r = 0;
      g = Math.floor(t * 255);
      b = 140 + Math.floor(t * 115);
    } else if (norm < 0.6) {
      // Cyan to yellow
      var t = (norm - 0.4) * 5;
      r = Math.floor(t * 255);
      g = 255;
      b = Math.floor((1 - t) * 255);
    } else if (norm < 0.8) {
      // Yellow to red
      var t = (norm - 0.6) * 5;
      r = 255;
      g = Math.floor((1 - t) * 255);
      b = 0;
    } else {
      // Red to white
      var t = (norm - 0.8) * 5;
      r = 255;
      g = Math.floor(t * 255);
      b = Math.floor(t * 255);
    }

    var i = x * 4;
    lineData.data[i] = r;
    lineData.data[i + 1] = g;
    lineData.data[i + 2] = b;
    lineData.data[i + 3] = 255;
  }
  waterfallCtx.putImageData(lineData, 0, 0);

  // Draw frequency markers directly on waterfall canvas
  var rxX = Math.round(jtcatRxFreq / 3000 * w);
  var txX = Math.round(jtcatTxFreq / 3000 * w);

  // RX marker (green bar only)
  if (rxX !== txX) {
    waterfallCtx.fillStyle = '#000';
    waterfallCtx.fillRect(rxX - 2, 0, 5, h);
    waterfallCtx.fillStyle = '#00ff00';
    waterfallCtx.fillRect(rxX - 1, 0, 3, h);
  }

  // TX marker (red bar only — freq shown in toolbar)
  waterfallCtx.fillStyle = '#000';
  waterfallCtx.fillRect(txX - 2, 0, 5, h);
  waterfallCtx.fillStyle = '#ff2222';
  waterfallCtx.fillRect(txX - 1, 0, 3, h);

  // Auto-detect quietest TX frequency — analyze every ~30 frames (~0.5s)
  jtcatQuietFreqFrame++;
  if (jtcatQuietFreqFrame % 30 === 0) {
    // Scan 200–2800 Hz in 50Hz windows (avoid edges)
    var binHz = nyquist / freqData.length;
    var windowBins = Math.round(50 / binHz); // ~8-9 bins per 50Hz window
    var startBin = Math.round(200 / binHz);
    var endBin = Math.round(2800 / binHz);
    var bestEnergy = Infinity;
    var bestBin = Math.round(1500 / binHz);
    for (var b = startBin; b <= endBin - windowBins; b++) {
      var energy = 0;
      for (var j = 0; j < windowBins; j++) energy += freqData[b + j];
      if (energy < bestEnergy) {
        bestEnergy = energy;
        bestBin = b + Math.floor(windowBins / 2);
      }
    }
    var quietHz = Math.round(bestBin * binHz / 10) * 10; // snap to 10Hz
    jtcatQuietFreq = Math.max(200, Math.min(2800, quietHz));
    window.api.jtcatQuietFreq(jtcatQuietFreq);
  }

  // Send spectrum bins to main process for ECHOCAT/popout (~10fps)
  jtcatSpectrumFrame++;
  if (jtcatSpectrumFrame % 6 === 0) {
    var specBins = new Array(w);
    for (var sx = 0; sx < w; sx++) {
      specBins[sx] = freqData[Math.floor(sx * passbandBins / w)];
    }
    window.api.jtcatSpectrum(specBins);
  }

  } catch (err) {
    console.error('[JTCAT] Waterfall error (will retry):', err.message || err);
  }
  waterfallAnimFrame = requestAnimationFrame(jtcatWaterfallLoop);
}

// Click waterfall to set TX frequency
jtcatWaterfall.addEventListener('click', function(e) {
  var rect = jtcatWaterfall.getBoundingClientRect();
  var x = e.clientX - rect.left;
  var freq = Math.round(x / rect.width * 3000);
  freq = Math.max(100, Math.min(3000, freq));
  // Snap to nearest 10 Hz
  freq = Math.round(freq / 10) * 10;

  jtcatTxFreq = freq;
  jtcatTxFreqInput.value = freq;
  jtcatTxFreqLabel.textContent = 'TX: ' + freq + ' Hz';
  if (jtcatRunning) window.api.jtcatSetTxFreq(freq);

  // If no active QSO, also set RX freq to match
  if (!jtcatQso || jtcatQso.phase === 'done') {
    jtcatRxFreq = freq;
    jtcatRxFreqInput.value = freq;
    jtcatRxFreqLabel.textContent = freq + ' Hz';
    if (jtcatRunning) window.api.jtcatSetRxFreq(freq);
  }

  // Update the TX message if there's an active QSO (re-encode at new freq)
  if (jtcatQso && jtcatQso.txMsg) {
    window.api.jtcatSetTxMsg(jtcatQso.txMsg);
  }

  console.log('[JTCAT] Waterfall click — TX freq:', freq, 'Hz');
});

// JTCAT IPC listeners
window.api.onJtcatDecode(function(data) {
  jtcatDecodes = data.results || [];
  // Accumulate into the log
  if (jtcatDecodes.length > 0) {
    var now = new Date();
    var timeStr = String(now.getUTCHours()).padStart(2, '0') + ':' +
                  String(now.getUTCMinutes()).padStart(2, '0') + ':' +
                  String(now.getUTCSeconds()).padStart(2, '0');
    jtcatDecodeLog.push({
      cycle: data.cycle,
      time: timeStr,
      mode: data.mode,
      results: jtcatDecodes,
    });
  }
  jtcatSyncStatus.textContent = 'Sync: OK';
  jtcatSyncStatus.classList.add('jtcat-synced');
  // Plot decodes on JTCAT map
  jtcatDecodes.forEach(function(d) { jtcatMapPlotDecode(d); });
  jtcatMapClearOld();
  renderJtcatDecodes();
});

window.api.onJtcatCycle(function(data) {
  jtcatCycleIndicator.textContent = data.slot === 'even' ? 'Even' : 'Odd';
  jtcatCycleIndicator.className = 'jtcat-cycle ' + (data.slot === 'even' ? 'jtcat-slot-even' : 'jtcat-slot-odd');
});

// Spectrum/waterfall is rendered directly from AnalyserNode in jtcatWaterfallLoop()

window.api.onJtcatStatus(function(data) {
  if (data.state === 'running') {
    jtcatSyncStatus.textContent = 'Sync: OK';
    jtcatSyncStatus.classList.add('jtcat-synced');
  } else if (data.state === 'stopped') {
    jtcatSyncStatus.textContent = 'Sync: \u2014';
    jtcatSyncStatus.classList.remove('jtcat-synced');
  }
});

// --- JTCAT TX Audio Playback ---
var jtcatTxAudioCtx = null;
var jtcatTxPlaying = false;

async function playJtcatTxAudio(data) {
  var samplesArray = data.samples || data;
  var offsetMs = data.offsetMs || 0;
  if (jtcatTxPlaying) return;
  jtcatTxPlaying = true;
  try {
    var s = await window.api.getSettings();
    var outputDeviceId = s.remoteAudioOutput || '';

    // Create or reuse TX audio context at 12kHz (FT8 native sample rate)
    if (!jtcatTxAudioCtx || jtcatTxAudioCtx.state === 'closed') {
      jtcatTxAudioCtx = new AudioContext({ sampleRate: 12000 });
    }
    if (jtcatTxAudioCtx.state === 'suspended') {
      await jtcatTxAudioCtx.resume();
    }

    // Route to the configured output device (DAX TX, USB soundcard, digirig, etc.)
    if (outputDeviceId && jtcatTxAudioCtx.setSinkId) {
      try {
        await jtcatTxAudioCtx.setSinkId(outputDeviceId);
      } catch (e) {
        console.warn('[JTCAT] Could not set TX audio output device:', e.message);
      }
    }

    var samples = new Float32Array(samplesArray);
    var buffer = jtcatTxAudioCtx.createBuffer(1, samples.length, 12000);
    buffer.getChannelData(0).set(samples);

    var source = jtcatTxAudioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(jtcatTxAudioCtx.destination);

    var txDone = false;
    function finishTx() {
      if (txDone) return;
      txDone = true;
      jtcatTxPlaying = false;
      window.api.jtcatTxComplete();
      console.log('[JTCAT] TX audio playback complete');
    }
    source.onended = finishTx;
    // Skip into the audio buffer for late-start TX so we stay within the cycle
    var offsetSec = offsetMs / 1000;
    var durationSec = buffer.duration - offsetSec;
    if (durationSec > 0) {
      source.start(0, offsetSec, durationSec);
    } else {
      source.start(0, offsetSec);
    }
    // Safety: force TX complete if onended never fires (device glitch, etc.)
    var safetyDur = Math.max(durationSec, buffer.duration) + 2;
    setTimeout(function() {
      if (!txDone) {
        console.warn('[JTCAT] TX audio safety timeout — forcing tx-complete');
        finishTx();
      }
    }, safetyDur * 1000);
    console.log('[JTCAT] TX audio playing, samples=' + samples.length + ', bufDur=' + buffer.duration.toFixed(2) + 's, offset=' + offsetSec.toFixed(1) + 's, dur=' + durationSec.toFixed(1) + 's, device:', outputDeviceId || 'default');
  } catch (err) {
    jtcatTxPlaying = false;
    window.api.jtcatTxComplete();
    console.error('[JTCAT] TX audio playback error:', err.message || err);
  }
}

window.api.onJtcatTxAudio(function(data) {
  playJtcatTxAudio(data);
});

window.api.onJtcatTxStatus(function(data) {
  if (data.state === 'tx') {
    jtcatEnableTxBtn.classList.add('jtcat-transmitting');
    jtcatTxMsgText.textContent = 'TX: ' + (data.message || '');
    if (jtcatTxIndicator) jtcatTxIndicator.classList.remove('hidden');
  } else {
    jtcatEnableTxBtn.classList.remove('jtcat-transmitting');
    if (jtcatTxIndicator) jtcatTxIndicator.classList.add('hidden');
  }
});

// Remote JTCAT: start/stop audio capture when phone activates FT8
window.api.onJtcatStartForRemote(function() {
  console.log('[JTCAT] Remote requested audio start');
  jtcatRemoteActive = true;
  if (!jtcatAudioCtx) startJtcatAudio();
});
window.api.onJtcatStopForRemote(function() {
  console.log('[JTCAT] Remote requested audio stop');
  jtcatRemoteActive = false;
  // Only stop audio if the desktop JTCAT view isn't active
  if (!jtcatRunning) stopJtcatAudio();
});

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
