// ECHOCAT — Phone-side client
// Runs in Safari/Chrome, no Electron dependencies
(function () {
  'use strict';

  // --- State ---
  let ws = null;
  let spots = [];
  let donorCallsigns = new Set();
  // bandFilter removed — now multi-select dropdown
  let pttDown = false;
  let storedToken = '';
  let reconnectTimer = null;
  let wasKicked = false;
  let authMode = 'token'; // 'token' | 'club' | 'none'
  let clubMember = null;  // { callsign, firstname, role, licenseClass }
  let pingInterval = null;
  let lastPingSent = 0;

  // WebRTC
  let pc = null;
  let localAudioStream = null;
  let audioEnabled = false;
  let remoteAudio = null; // <video> element for playback
  let audioCtx = null;   // Web Audio context for gain boost
  let gainNode = null;   // GainNode for RX volume
  let txGainNode = null; // GainNode for TX mic level
  let rxAnalyser = null; // AnalyserNode for RX metering
  let txAnalyser = null; // AnalyserNode for TX metering
  let meterAnimFrame = null; // requestAnimationFrame ID for meter rendering
  let volBoostLevel = 0; // 0=1x, 1=2x, 2=3x
  const VOL_STEPS = [1, 2, 3];
  let sessionKeepAlive = null; // silent <audio> loop for Media Session anchor

  // Scan
  let scanning = false;
  let scanIndex = 0;
  let scanTimer = null;
  let scanDwell = 7;
  var scanSkipped = new Set();
  var scanForceUnskipped = new Set();

  // Refresh rate
  let refreshInterval = 30;

  // --- Elements ---
  const connectScreen = document.getElementById('connect-screen');
  const tokenInput = document.getElementById('token-input');
  const connectBtn = document.getElementById('connect-btn');
  const connectError = document.getElementById('connect-error');
  const mainUI = document.getElementById('main-ui');
  const freqDisplay = document.getElementById('freq-display');
  const modeBadge = document.getElementById('mode-badge');
  const catDot = document.getElementById('cat-dot');
  const audioDot = document.getElementById('audio-dot');
  const latencyEl = document.getElementById('latency');
  const txBanner = document.getElementById('tx-banner');
  const spotList = document.getElementById('spot-list');
  const pttBtn = document.getElementById('ptt-btn');
  const estopBtn = document.getElementById('estop-btn');
  const audioBtn = document.getElementById('audio-btn');
  const bottomBar = document.getElementById('bottom-bar');
  const statusBar = document.getElementById('status-bar');
  const freqInput = document.getElementById('freq-input');
  const freqGo = document.getElementById('freq-go');
  const logSheet = document.getElementById('log-sheet');
  const logBackdrop = document.getElementById('log-sheet-backdrop');
  const logForm = document.getElementById('log-form');
  const logCall = document.getElementById('log-call');
  const logFreq = document.getElementById('log-freq');
  const logMode = document.getElementById('log-mode');
  const logRstSent = document.getElementById('log-rst-sent');
  const logRstRcvd = document.getElementById('log-rst-rcvd');
  const logSig = document.getElementById('log-sig');
  const logSigInfo = document.getElementById('log-sig-info');
  const logSaveBtn = document.getElementById('log-save');
  const logCancelBtn = document.getElementById('log-cancel');
  const logToast = document.getElementById('log-toast');
  const rigSelect = document.getElementById('rig-select');
  const volBoostBtn = document.getElementById('vol-boost-btn');
  const scanBtn = document.getElementById('scan-btn');
  const refreshRateBtn = document.getElementById('refresh-rate-btn');
  const filterToolbar = document.getElementById('filter-toolbar');
  const dirView = document.getElementById('dir-view');
  const dirList = document.getElementById('dir-list');
  const dirSearch = document.getElementById('dir-search');
  const sortSelect = document.getElementById('sort-select');
  const spotMapEl = document.getElementById('spot-map');
  const dialPad = document.getElementById('dial-pad');
  const dialPadBackdrop = document.getElementById('dial-pad-backdrop');
  const dpFreq = document.getElementById('dp-freq');
  const dpGo = document.getElementById('dp-go');
  const dpCancel = document.getElementById('dp-cancel');
  const dpClear = document.getElementById('dp-clear');
  const dpStepUp = document.getElementById('dp-step-up');
  const dpStepDown = document.getElementById('dp-step-down');
  const dpStepSize = document.getElementById('dp-step-size');
  const freqUpBtn = document.getElementById('freq-up-btn');
  const freqDownBtn = document.getElementById('freq-down-btn');
  let spotSort = 'age';
  let spotMap = null;
  let spotMapLayer = null;
  let spotTuneArcLayer = null;
  let spotMapHasFit = false;
  let currentFreqKhz = 0;
  let currentMode = '';
  let tunedFreqKhz = '';

  // Spot column visibility — persisted in localStorage
  var colPrefs = JSON.parse(localStorage.getItem('echocat-spot-cols') || '{}');
  var colShow = {
    freq: colPrefs.freq !== false,
    dist: colPrefs.dist !== false,
    ref: colPrefs.ref !== false,
    age: colPrefs.age !== false,
    mode: colPrefs.mode === true, // off by default
    band: colPrefs.band === true, // off by default
    name: colPrefs.name === true, // off by default — park name / comments
    region: colPrefs.region === true, // off by default — state/region (e.g. US-CO)
    src: colPrefs.src === true,   // off by default — source (POTA/SOTA/DXC)
    skip: colPrefs.skip !== false,
    log: colPrefs.log !== false,
  };
  // Column ordering — array of column keys in display order
  var defaultColOrder = ['freq', 'mode', 'band', 'dist', 'ref', 'name', 'region', 'src', 'age', 'skip', 'log'];
  var colOrder = colPrefs.order && Array.isArray(colPrefs.order) ? colPrefs.order : defaultColOrder.slice();
  // Ensure any new columns are present in colOrder
  for (var k of defaultColOrder) { if (colOrder.indexOf(k) === -1) colOrder.push(k); }
  function saveColPrefs() { localStorage.setItem('echocat-spot-cols', JSON.stringify({ ...colShow, order: colOrder })); }
  let tunedCallsign = '';
  let tunedOpName = '';
  var qrzNameCache = {}; // callsign → first name / nickname from QRZ
  let tunedState = '';
  let currentNb = false;
  let currentAtu = false;
  let currentVfo = 'A';
  let currentFilterWidth = 0;
  let rigCapabilities = { nb: false, atu: false, vfo: false, filter: false };
  let rigControlsOpen = false;
  let txState = false;
  let rotorEnabled = false;
  let directoryNets = [];
  let directorySwl = [];
  let dirActiveTab = 'nets';

  // --- Colorblind mode ---
  const CB_COLORS = {
    pota: '#4fc3f7', sota: '#ffb300', wwff: '#29b6f6',
    dxc: '#e040fb', rbn: '#81d4fa', pskr: '#ffa726'
  };
  function applyRemoteColorblind(enabled) {
    const root = document.documentElement;
    if (enabled) {
      root.style.setProperty('--pota', CB_COLORS.pota);
      root.style.setProperty('--sota', CB_COLORS.sota);
      root.style.setProperty('--dxc', CB_COLORS.dxc);
      root.style.setProperty('--rbn', CB_COLORS.rbn);
      root.style.setProperty('--pskr', CB_COLORS.pskr);
      // Update inline style attributes on type chips
      document.querySelectorAll('.setup-type-btn[data-type], .lt-type-chip[data-type]').forEach(el => {
        const src = el.dataset.type;
        if (CB_COLORS[src]) el.style.setProperty('--type-color', CB_COLORS[src]);
      });
    } else {
      root.style.removeProperty('--pota');
      root.style.removeProperty('--sota');
      root.style.removeProperty('--dxc');
      root.style.removeProperty('--rbn');
      root.style.removeProperty('--pskr');
    }
  }

  // --- Activator state ---
  let activeTab = 'spots';
  let activationRunning = false;
  let activationType = 'pota';   // 'pota' | 'sota' | 'other'
  let activationRef = '';        // e.g. 'US-1234' or 'W4C/CM-001' or free text
  let activationName = '';       // resolved name from server
  let activationSig = '';        // 'POTA', 'SOTA', or ''
  let phoneGrid = '';
  let activationStartTime = 0;  // Date.now() when activation started
  let activationTimerInterval = null;
  let sessionContacts = [];
  let offlineQueue = JSON.parse(localStorage.getItem('echocat-offline-queue') || '[]');
  let searchDebounce = null;
  let workedParksSet = new Set();  // park refs from CSV for new-to-me filter
  let showNewOnly = false;
  let workedQsos = new Map();     // callsign → [{date, ref, band, mode}]
  let hideWorked = false;
  let clusterConnected = false;
  let myCallsign = '';
  let logSelectedType = '';
  let respotDefault = true;
  let respotTemplate = '{rst} in {QTH} 73s {mycallsign} via POTACAT';
  let dxRespotTemplate = 'Heard in {QTH} 73s {mycallsign} via POTACAT';

  // --- Past Activations state ---
  let pastActivations = [];
  let actMap = null; // Leaflet map instance

  // --- Activator elements ---
  const activationBanner = document.getElementById('activation-banner');
  const activationRefEl = document.getElementById('activation-ref');
  const activationNameEl = document.getElementById('activation-name');
  const activationTimerEl = document.getElementById('activation-timer');
  const endActivationBtn = document.getElementById('end-activation-btn');
  const tabBar = document.getElementById('tab-bar');
  // tabLogBadge removed — badge is now on Activate tab (tabActivateBadge)
  const logView = document.getElementById('log-view');
  const activationSetup = document.getElementById('activation-setup');
  const setupRefInput = document.getElementById('setup-ref-input');
  const setupRefLabel = document.getElementById('setup-ref-label');
  const setupRefDropdown = document.getElementById('setup-ref-dropdown');
  const setupRefName = document.getElementById('setup-ref-name');
  const startActivationBtn = document.getElementById('start-activation-btn');
  const quickLogForm = document.getElementById('quick-log-form');
  const qlCall = document.getElementById('ql-call');
  const qlFreq = document.getElementById('ql-freq');
  const qlMode = document.getElementById('ql-mode');
  const qlRstSent = document.getElementById('ql-rst-sent');
  const qlRstRcvd = document.getElementById('ql-rst-rcvd');
  const qlLogBtn = document.getElementById('ql-log-btn');
  const qlCallInfo = document.getElementById('ql-call-info');
  const ltCallInfo = document.getElementById('lt-call-info');
  const logCallInfo = document.getElementById('log-call-info');
  let callLookupTimer = null;
  let callLookupSource = 'ql'; // 'ql' | 'lt' | 'log'
  const contactList = document.getElementById('contact-list');
  const logFooter = document.getElementById('log-footer');
  const logFooterCount = document.getElementById('log-footer-count');
  const logFooterQueued = document.getElementById('log-footer-queued');
  const exportAdifBtn = document.getElementById('export-adif-btn');
  const bandFilterEl = document.getElementById('rc-band-filter');
  const modeFilterEl = document.getElementById('rc-mode-filter');
  const regionFilterEl = document.getElementById('rc-region-filter');
  const spotsDropdown = document.getElementById('rc-spots-dropdown');
  const rcNewOnly = document.getElementById('rc-new-only');
  const rcHideWorked = document.getElementById('rc-hide-worked');
  const logRefSection = document.getElementById('log-ref-section');
  const logRefInput = document.getElementById('log-ref-input');
  const logRefName = document.getElementById('log-ref-name');
  const logRespotSection = document.getElementById('log-respot-section');
  const logRespotCb = document.getElementById('log-respot-cb');
  const logRespotLabel = document.getElementById('log-respot-label');
  const logRespotCommentWrap = document.getElementById('log-respot-comment-wrap');
  const logRespotComment = document.getElementById('log-respot-comment');

  // Past activations elements
  const pastActivationsDiv = document.getElementById('past-activations');
  const paList = document.getElementById('pa-list');
  const actMapOverlay = document.getElementById('act-map-overlay');
  const actMapEl = document.getElementById('act-map');
  const actMapBack = document.getElementById('act-map-back');
  const actMapTitle = document.getElementById('act-map-title');
  const actMapCount = document.getElementById('act-map-count');

  // Log tab elements
  const logTabView = document.getElementById('log-tab-view');
  const ltCall = document.getElementById('lt-call');
  const ltFreq = document.getElementById('lt-freq');
  const ltMode = document.getElementById('lt-mode');
  const ltRstSent = document.getElementById('lt-rst-sent');
  const ltRstRcvd = document.getElementById('lt-rst-rcvd');
  const ltRefSection = document.getElementById('lt-ref-section');
  const ltRefInput = document.getElementById('lt-ref-input');
  const ltRefName = document.getElementById('lt-ref-name');
  const ltCallHint = document.getElementById('lt-call-hint');
  const ltRespotSection = document.getElementById('lt-respot-section');
  const ltRespotLabel = document.getElementById('lt-respot-label');
  const ltRespotCommentWrap = document.getElementById('lt-respot-comment-wrap');
  const ltRespotComment = document.getElementById('lt-respot-comment');
  const ltSave = document.getElementById('lt-save');
  const ltNotes = document.getElementById('lt-notes');
  const logNotes = document.getElementById('log-notes');
  const qlNotes = document.getElementById('ql-notes');
  const tabActivateBadge = document.getElementById('tab-activate-badge');

  // Logbook view elements
  const logbookView = document.getElementById('logbook-view');
  const lbSearch = document.getElementById('lb-search');
  const lbCount = document.getElementById('lb-count');
  const lbList = document.getElementById('lb-list');
  let logbookQsos = [];
  let expandedQsoIdx = -1;
  let ltSelectedType = 'dx';

  // --- FT8/JTCAT state ---
  let ft8Running = false;
  let ft8DecodeLog = [];       // [{cycle, time, mode, results}]
  let ft8TxEnabled = false;
  let ft8TxSlot = 'auto';      // 'auto' | 'even' | 'odd'
  let ft8Transmitting = false;  // true when actively transmitting
  let ft8TxMsg = '';
  let ft8QsoState = null;       // {mode, call, grid, phase, txMsg, report, sentReport} or null
  let ft8CycleSlot = '--';
  let ft8CountdownTimer = null;
  let ft8CycleBoundary = 0;     // epoch ms of next cycle boundary
  let ft8Mode = 'FT8';
  let ft8HuntCall = '';        // callsign we're hunting from spot list
  let ft8UserScrolled = false; // true when user has scrolled up in decode log
  let ft8CqFilter = false;     // CQ-only filter
  let ft8WantedFilter = false; // Wanted-only filter (new DXCC/grid/call)
  let ft8SortSignal = false;   // Sort decodes by signal strength
  let ft8SearchFilter = '';    // Text search filter
  let ft8TxFreqHz = 1500;      // TX frequency in Hz (for waterfall marker)

  // FT2 dial frequencies (kHz) per band — from IU8LMC published table
  const FT2_BAND_FREQS = {
    '160m': 1843, '80m': 3578, '60m': 5360, '40m': 7052, '30m': 10144,
    '20m': 14084, '17m': 18108, '15m': 21144, '12m': 24923, '10m': 28184,
  };
  // FT4 dial frequencies (kHz) per band
  const FT4_BAND_FREQS = {
    '160m': 1840, '80m': 3568, '60m': 5357, '40m': 7047.5, '30m': 10140,
    '20m': 14080, '17m': 18104, '15m': 21140, '12m': 24919, '10m': 28180,
    '6m': 50318,
  };
  // FT8 dial frequencies (kHz) per band
  const FT8_BAND_FREQS = {
    '160m': 1840, '80m': 3573, '60m': 5357, '40m': 7074, '30m': 10136,
    '20m': 14074, '17m': 18100, '15m': 21074, '12m': 24915, '10m': 28074,
    '6m': 50313, '2m': 144174,
  };

  /** Update band button data-freq attributes for current mode */
  function updateBandFreqs() {
    const table = ft8Mode === 'FT2' ? FT2_BAND_FREQS : ft8Mode === 'FT4' ? FT4_BAND_FREQS : FT8_BAND_FREQS;
    Array.from(ft8BandSelect.options).forEach(opt => {
      const band = opt.value;
      if (table[band]) opt.dataset.freq = table[band];
    });
  }

  // FT8 DOM refs
  const ft8View = document.getElementById('ft8-view');
  const ft8BandSelect = document.getElementById('ft8-band-select');
  const ft8ModeSelect = document.getElementById('ft8-mode-select');
  const ft8RxTxBadge = document.getElementById('ft8-rx-tx-badge');
  const ft8CycleIndicator = document.getElementById('ft8-cycle-indicator');
  const ft8Countdown = document.getElementById('ft8-countdown');
  const ft8SyncStatus = document.getElementById('ft8-sync-status');
  const ft8EraseBtn = document.getElementById('ft8-erase-btn');
  const ft8DecodeLogEl = document.getElementById('ft8-decode-log');
  const ft8Waterfall = document.getElementById('ft8-waterfall');
  const ft8TxBtn = document.getElementById('ft8-tx-btn');
  const ft8SlotBtn = document.getElementById('ft8-slot-btn');
  const ft8CqBtn = document.getElementById('ft8-cq-btn');
  const ft8TxMsgEl = document.getElementById('ft8-tx-msg');
  const ft8LogBtn = document.getElementById('ft8-log-btn');
  const ft8QsoExchange = document.getElementById('ft8-qso-exchange');
  const ft8TxFreqDisplay = document.getElementById('ft8-tx-freq-display');
  const ft8CqFilterBtn = document.getElementById('ft8-cq-filter');
  const ft8WantedFilterBtn = document.getElementById('ft8-wanted-filter');

  // Rig controls elements (now inside settings overlay)
  const rigCtrlToggle = document.getElementById('rig-ctrl-toggle');
  const settingsOverlay = document.getElementById('settings-overlay');
  const soClose = document.getElementById('so-close');
  const soFilterRow = document.getElementById('so-filter-row');
  const soRigRow = document.getElementById('so-rig-row');
  const soRfGainRow = document.getElementById('so-rfgain-row');
  const soTxPowerRow = document.getElementById('so-txpower-row');
  const rcNbGroup = document.getElementById('rc-nb');
  const rcVfoGroup = document.getElementById('rc-vfo');
  const rcBwDn = document.getElementById('rc-bw-dn');
  const rcBwUp = document.getElementById('rc-bw-up');
  const rcBwLabel = document.getElementById('rc-bw-label');
  const rcNbBtn = document.getElementById('rc-nb-btn');
  const rcAtuGroup = document.getElementById('rc-atu');
  const rcAtuBtn = document.getElementById('rc-atu-btn');
  const rcRfGainSlider = document.getElementById('rc-rfgain-slider');
  const rcRfGainVal = document.getElementById('rc-rfgain-val');
  const rcTxPowerSlider = document.getElementById('rc-txpower-slider');
  const rcTxPowerVal = document.getElementById('rc-txpower-val');
  const rcVfoA = document.getElementById('rc-vfo-a');
  const rcVfoB = document.getElementById('rc-vfo-b');
  const rcVfoSwap = document.getElementById('rc-vfo-swap');
  const rcRotorGroup = document.getElementById('rc-rotor');
  const rcRotorBtn = document.getElementById('rc-rotor-btn');

  let rotorConfigured = false; // stays true once rotor has been seen enabled

  function updateRotorBtn() {
    if (!rcRotorGroup || !rcRotorBtn) return;
    if (rotorEnabled) rotorConfigured = true;
    rcRotorGroup.classList.toggle('hidden', !rotorConfigured);
    rcRotorBtn.classList.toggle('active', rotorEnabled);
  }

  if (rcRotorBtn) {
    rcRotorBtn.addEventListener('click', function() {
      rotorEnabled = !rotorEnabled;
      updateRotorBtn();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'toggle-rotor', enabled: rotorEnabled }));
      }
    });
  }

  // Mode picker
  const modePicker = document.getElementById('mode-picker');

  // Settings overlay steppers/toggles
  const soDwellDn = document.getElementById('so-dwell-dn');
  const soDwellUp = document.getElementById('so-dwell-up');
  const soDwellVal = document.getElementById('so-dwell-val');
  const soRefreshDn = document.getElementById('so-refresh-dn');
  const soRefreshUp = document.getElementById('so-refresh-up');
  const soRefreshVal = document.getElementById('so-refresh-val');
  const soMaxageDn = document.getElementById('so-maxage-dn');
  const soMaxageUp = document.getElementById('so-maxage-up');
  const soMaxageVal = document.getElementById('so-maxage-val');
  const soDistMi = document.getElementById('so-dist-mi');
  const soDistKm = document.getElementById('so-dist-km');
  const soThemeDark = document.getElementById('so-theme-dark');
  const soThemeLight = document.getElementById('so-theme-light');
  // Tuning settings overlay elements
  const soXitDn = document.getElementById('so-xit-dn');
  const soXitUp = document.getElementById('so-xit-up');
  const soXitVal = document.getElementById('so-xit-val');
  const soCwFiltDn = document.getElementById('so-cwfilt-dn');
  const soCwFiltUp = document.getElementById('so-cwfilt-up');
  const soCwFiltVal = document.getElementById('so-cwfilt-val');
  const soSsbFiltDn = document.getElementById('so-ssbfilt-dn');
  const soSsbFiltUp = document.getElementById('so-ssbfilt-up');
  const soSsbFiltVal = document.getElementById('so-ssbfilt-val');
  const soDigFiltDn = document.getElementById('so-digfilt-dn');
  const soDigFiltUp = document.getElementById('so-digfilt-up');
  const soDigFiltVal = document.getElementById('so-digfilt-val');
  const soSplitBtn = document.getElementById('so-split-btn');
  const soAtuAutoBtn = document.getElementById('so-atu-auto-btn');
  const soTuneClickBtn = document.getElementById('so-tune-click-btn');
  // Settings state from desktop
  let maxAgeMin = 5;
  let distUnit = 'mi';
  let cwXit = 0;
  let cwFilterWidth = 0;
  let ssbFilterWidth = 0;
  let digitalFilterWidth = 0;
  let enableSplit = false;
  let enableAtu = false;
  let tuneClick = false;

  // --- Theme ---
  function applyTheme(light) {
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
    soThemeDark.classList.toggle('active', !light);
    soThemeLight.classList.toggle('active', light);
    // Update mobile browser chrome color
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#e8eaed' : '#0f3460');
    localStorage.setItem('echocat-theme', light ? 'light' : 'dark');
  }
  // Apply saved theme on load
  applyTheme(localStorage.getItem('echocat-theme') === 'light');

  soThemeDark.addEventListener('click', () => applyTheme(false));
  soThemeLight.addEventListener('click', () => applyTheme(true));

  // --- Connect ---
  var clubCallInput = document.getElementById('club-callsign');
  var clubPassInput = document.getElementById('club-password');
  var tokenLoginDiv = document.getElementById('token-login');
  var clubLoginDiv = document.getElementById('club-login');
  var memberBadge = document.getElementById('member-badge');

  connectBtn.addEventListener('click', () => {
    if (authMode === 'club') {
      var call = clubCallInput.value.trim().toUpperCase();
      var pass = clubPassInput.value;
      if (!call || !pass) return;
      connectError.classList.add('hidden');
      connectBtn.textContent = 'Connecting...';
      connectBtn.disabled = true;
      connectClub(call, pass);
    } else {
      var token = tokenInput.value.trim().toUpperCase();
      if (authMode !== 'none' && !token) return;
      storedToken = token;
      connectError.classList.add('hidden');
      connectBtn.textContent = 'Connecting...';
      connectBtn.disabled = true;
      connect(token);
    }
  });

  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectBtn.click();
  });
  clubCallInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') clubPassInput.focus();
  });
  clubPassInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectBtn.click();
  });

  function openWs(onOpen) {
    wasKicked = false;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.onopen = onOpen;
    ws.onmessage = function(event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = function() {
      clearInterval(pingInterval);
      pingInterval = null;
      if (wasKicked) return;
      if (mainUI.classList.contains('hidden')) {
        connectBtn.textContent = 'Connect';
        connectBtn.disabled = false;
      } else {
        scheduleReconnect();
      }
    };
    ws.onerror = function() {};
  }

  function connect(token) {
    openWs(function() {
      if (token) {
        ws.send(JSON.stringify({ type: 'auth', token: token }));
      }
    });
  }

  function connectClub(callsign, password) {
    openWs(function() {
      ws.send(JSON.stringify({ type: 'auth', callsign: callsign, password: password }));
    });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'auth-mode':
        // Server tells us which login form to show
        authMode = msg.mode || 'token';
        if (authMode === 'club') {
          tokenLoginDiv.classList.add('hidden');
          clubLoginDiv.classList.remove('hidden');
          connectBtn.textContent = 'Log In';
        } else if (authMode === 'none') {
          tokenLoginDiv.classList.add('hidden');
          clubLoginDiv.classList.add('hidden');
          // Hide entire connect screen — server auto-authenticates
          connectScreen.classList.add('hidden');
        } else {
          tokenLoginDiv.classList.remove('hidden');
          clubLoginDiv.classList.add('hidden');
          connectBtn.textContent = 'Connect';
        }
        break;

      case 'auth-ok':
        connectScreen.classList.add('hidden');
        mainUI.classList.remove('hidden');
        tabBar.classList.remove('hidden');
        requestWakeLock(); // keep screen on while connected
        connectBtn.textContent = authMode === 'club' ? 'Log In' : 'Connect';
        connectBtn.disabled = false;
        // Club member info
        if (msg.member) {
          clubMember = msg.member;
          memberBadge.textContent = msg.member.firstname + ' (' + msg.member.callsign + ')';
          memberBadge.classList.remove('hidden');
        } else {
          clubMember = null;
          memberBadge.classList.add('hidden');
        }
        // Schedule advisory
        if (msg.scheduleAdvisory) {
          var sa = msg.scheduleAdvisory;
          showToast(sa.scheduledName + ' (' + sa.scheduledCallsign + ') is scheduled on ' + sa.radio + ' ' + sa.time, 6000);
        }
        startPing();
        showWelcome();
        drainOfflineQueue();
        if (activeTab === 'spots' || activeTab === 'map') {
          filterToolbar.classList.remove('hidden');
        }
        if (msg.colorblindMode) applyRemoteColorblind(true);
        // CW keyer availability
        cwAvailable = !!msg.cwAvailable;
        updateCwPanelVisibility();
        updateSsbPanelVisibility();
        if (msg.settings) {
          myCallsign = msg.settings.myCallsign || '';
          phoneGrid = msg.settings.grid || phoneGrid;
          clusterConnected = !!msg.settings.clusterConnected;
          respotDefault = msg.settings.respotDefault !== false;
          if (msg.settings.respotTemplate) respotTemplate = msg.settings.respotTemplate;
          if (msg.settings.dxRespotTemplate) dxRespotTemplate = msg.settings.dxRespotTemplate;
          scanDwell = msg.settings.scanDwell || 7;
          refreshInterval = msg.settings.refreshInterval || 30;
          refreshRateBtn.textContent = refreshInterval + 's';
          maxAgeMin = msg.settings.maxAgeMin != null ? msg.settings.maxAgeMin : 5;
          distUnit = msg.settings.distUnit || 'mi';
          // Tuning settings from desktop
          cwXit = msg.settings.cwXit || 0;
          cwFilterWidth = msg.settings.cwFilterWidth || 0;
          ssbFilterWidth = msg.settings.ssbFilterWidth || 0;
          digitalFilterWidth = msg.settings.digitalFilterWidth || 0;
          enableSplit = !!msg.settings.enableSplit;
          enableAtu = !!msg.settings.enableAtu;
          tuneClick = !!msg.settings.tuneClick;
          // Sync overlay values
          soDwellVal.textContent = scanDwell + 's';
          soRefreshVal.textContent = refreshInterval + 's';
          soMaxageVal.textContent = maxAgeMin + 'm';
          soDistMi.classList.toggle('active', distUnit === 'mi');
          soDistKm.classList.toggle('active', distUnit === 'km');
          syncTuningUI();
          if (msg.settings.remoteCwMacros) syncMacrosFromSettings(msg.settings.remoteCwMacros);
          if (msg.settings.customCatButtons) loadCustomCatButtons(msg.settings.customCatButtons);
          // PSTRotator toggle — show when configured, reflect active state
          if (msg.settings.enableRotor != null) {
            rotorConfigured = !!msg.settings.enableRotor;
            rotorEnabled = !!msg.settings.rotorActive;
            updateRotorBtn();
          }
        }
        updateCwEnableBtn();
        // Load WebSDR stations from settings
        if (msg.settings && typeof kiwiLoadStationsE === 'function') kiwiLoadStationsE(msg.settings);
        // Restore saved JTCAT gain levels to server
        var restoredRx = parseInt(localStorage.getItem('echocat-ft8-rx-gain'), 10);
        var restoredTx = parseInt(localStorage.getItem('echocat-ft8-tx-gain'), 10);
        if (!isNaN(restoredRx)) ft8Send({ type: 'jtcat-rx-gain', value: restoredRx / 100 });
        if (!isNaN(restoredTx)) ft8Send({ type: 'jtcat-tx-gain', value: (restoredTx / 100) * (restoredTx / 100) });
        break;

      case 'tune-blocked':
        showToast(msg.reason || 'Tune blocked by license restrictions', 4000);
        break;

      case 'rig-blocked':
        showToast(msg.reason || 'You do not have access to this radio', 4000);
        break;

      case 'colorblind-mode':
        applyRemoteColorblind(!!msg.enabled);
        break;

      case 'auth-fail':
        connectError.textContent = msg.reason || 'Authentication failed';
        connectError.classList.remove('hidden');
        connectBtn.textContent = authMode === 'club' ? 'Log In' : 'Connect';
        connectBtn.disabled = false;
        break;

      case 'audio-devices':
        populateAudioDevices(msg.devices, msg.current);
        break;

      case 'smeter':
        updateEchoSmeter(msg.value);
        break;

      case 'swr':
        updateEchoSwr(msg.value);
        break;

      case 'swr-ratio':
        updateEchoSwrRatio(msg.value);
        break;

      case 'tgxl-status':
        echoTgxlSection.classList.remove('hidden');
        echoTgxlUpdateButtons(msg.antenna || 0, msg.labels);
        break;

      case 'freedv-enabled':
        if (echoFreedvCb) echoFreedvCb.checked = !!msg.enabled;
        break;

      case 'voice-macro-sync': {
        // Incoming voice macro from desktop — store locally
        var vmBinary = atob(msg.audio);
        var vmBytes = new Uint8Array(vmBinary.length);
        for (var vi = 0; vi < vmBinary.length; vi++) vmBytes[vi] = vmBinary.charCodeAt(vi);
        var vmBlob = new Blob([vmBytes], { type: 'audio/webm' });
        ssbDbPut(msg.idx, vmBlob, function() { renderSsbMacros(); });
        if (msg.label != null) {
          ssbMacroLabels[msg.idx] = msg.label;
          localStorage.setItem('echocat-ssb-labels', JSON.stringify(ssbMacroLabels));
        }
        break;
      }
      case 'voice-macro-delete':
        ssbDbDelete(msg.idx, function() { renderSsbMacros(); });
        break;
      case 'voice-macro-labels':
        if (msg.labels) {
          ssbMacroLabels = msg.labels;
          localStorage.setItem('echocat-ssb-labels', JSON.stringify(ssbMacroLabels));
          renderSsbMacros();
        }
        break;

      case 'freedv-sync': {
        var syncEl = document.getElementById('echo-freedv-sync');
        var snrEl = document.getElementById('echo-freedv-snr');
        if (syncEl) syncEl.style.background = msg.sync ? '#4ecca3' : '#f0a500';
        if (snrEl) snrEl.textContent = 'SNR: ' + (msg.snr != null ? msg.snr.toFixed(1) : '--');
        break;
      }

      case 'qrz-result':
        if (msg.callsign && msg.callsign.toUpperCase() === tunedCallsign.toUpperCase().split('/')[0]) {
          tunedOpName = msg.fname || '';
          tunedState = msg.state || '';
        }
        break;

      case 'qrz-names':
        if (msg.data) {
          for (const [cs, name] of Object.entries(msg.data)) {
            qrzNameCache[cs.toUpperCase()] = name;
          }
          if (colShow.name) renderSpots();
        }
        break;

      case 'spots':
        spots = msg.data || [];
        renderSpots();
        if (activeTab === 'map') renderMapSpots();
        break;

      case 'directory':
        directoryNets = msg.nets || [];
        directorySwl = msg.swl || [];
        // Show/hide Dir tab based on whether we have data
        var dirTabBtn = document.getElementById('dir-tab-btn');
        if (dirTabBtn) dirTabBtn.classList.toggle('hidden', !directoryNets.length && !directorySwl.length);
        if (activeTab === 'dir') renderDirectoryTab();
        break;

      case 'donor-callsigns':
        donorCallsigns = new Set((msg.callsigns || []).map(function(cs) { return cs.toUpperCase(); }));
        renderSpots();
        break;

      case 'status':
        updateStatus(msg);
        break;

      case 'pong':
        if (msg.ts) {
          const latMs = Date.now() - msg.ts;
          latencyEl.textContent = latMs + 'ms';
        }
        break;

      case 'ptt-timeout':
      case 'ptt-force-rx':
        pttDown = false;
        pttBtn.classList.remove('active');
        txBanner.classList.add('hidden');
        muteRxAudio(false);
        break;

      case 'kicked':
        // Stop reconnect loop — another client took over intentionally
        wasKicked = true;
        releaseWakeLock();
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        mainUI.classList.add('hidden');
        connectScreen.classList.remove('hidden');
        connectError.textContent = 'Another client connected. Tap Connect to take over.';
        connectError.classList.remove('hidden');
        connectBtn.textContent = 'Connect';
        connectBtn.disabled = false;
        break;

      case 'cw-available':
        cwAvailable = !!msg.enabled;
        updateCwPanelVisibility();
        updateCwEnableBtn();
        break;

      case 'cw-state':
        stopCwTextSidetone(); // cancel text playback if paddle keying arrives
        cwIndicator.classList.toggle('active', !!msg.keying);
        handleCwSidetone(!!msg.keying);
        break;

      case 'cw-config-ack':
        if (msg.wpm) { cwWpm = msg.wpm; cwWpmLabel.textContent = cwWpm + ' WPM'; }
        if (msg.mode) {
          cwMode = msg.mode;
          cwModeB.classList.toggle('active', cwMode === 'iambicB');
          cwModeA.classList.toggle('active', cwMode === 'iambicA');
          cwModeStr.classList.toggle('active', cwMode === 'straight');
        }
        break;

      case 'sources':
        if (msg.data) {
          const map = { pota: 'pota', sota: 'sota', wwff: 'wwff', llota: 'llota', cluster: 'dxc' };
          for (const [settingKey, srcAttr] of Object.entries(map)) {
            const cb = spotsDropdown.querySelector(`input[data-src="${srcAttr}"]`);
            if (cb) cb.checked = !!msg.data[settingKey];
          }
        }
        break;

      case 'rigs':
        updateRigSelect(msg.data || [], msg.activeRigId);
        break;

      case 'echo-filters':
        applyFilters(msg.data);
        break;

      case 'log-ok':
        logSaveBtn.disabled = false;
        ltSave.disabled = false;
        if (msg.success) {
          closeLogSheet();
          resetLogTabForm();
          let toastMsg = 'Logged ' + (msg.callsign || '');
          if (msg.resposted) toastMsg += ' \u2014 re-spotted';
          if (msg.respotError) toastMsg += ' (respot failed)';
          showLogToast(toastMsg);
          if (msg.nr !== undefined) {
            handleLogOkContact(msg);
          }
        } else {
          showLogToast(msg.error || 'Log failed', true);
        }
        break;

      case 'activator-state':
        handleActivatorState(msg);
        break;

      case 'session-contacts':
        sessionContacts = msg.contacts || [];
        renderContacts();
        updateLogBadge();
        break;

      case 'worked-parks':
        workedParksSet = new Set(msg.refs || []);
        spotsDropdown.querySelector('.rc-new-only-row').style.display = workedParksSet.size > 0 ? '' : 'none';
        renderSpots();
        if (activeTab === 'map') renderMapSpots();
        break;

      case 'worked-qsos':
        workedQsos = new Map(msg.entries || []);
        spotsDropdown.querySelector('.rc-hide-worked-row').style.display = workedQsos.size > 0 ? '' : 'none';
        renderSpots();
        if (activeTab === 'map') renderMapSpots();
        break;

      case 'cluster-state':
        clusterConnected = !!msg.connected;
        break;

      case 'settings-update':
        if (msg.settings) {
          if (msg.settings.scanDwell != null) { scanDwell = msg.settings.scanDwell; soDwellVal.textContent = scanDwell + 's'; }
          if (msg.settings.refreshInterval != null) { refreshInterval = msg.settings.refreshInterval; refreshRateBtn.textContent = refreshInterval + 's'; soRefreshVal.textContent = refreshInterval + 's'; }
          if (msg.settings.maxAgeMin != null) { maxAgeMin = msg.settings.maxAgeMin; soMaxageVal.textContent = maxAgeMin + 'm'; }
          if (msg.settings.distUnit) { distUnit = msg.settings.distUnit; soDistMi.classList.toggle('active', distUnit === 'mi'); soDistKm.classList.toggle('active', distUnit === 'km'); }
          if (msg.settings.cwXit != null) cwXit = msg.settings.cwXit;
          if (msg.settings.cwFilterWidth != null) cwFilterWidth = msg.settings.cwFilterWidth;
          if (msg.settings.ssbFilterWidth != null) ssbFilterWidth = msg.settings.ssbFilterWidth;
          if (msg.settings.digitalFilterWidth != null) digitalFilterWidth = msg.settings.digitalFilterWidth;
          if (msg.settings.enableSplit != null) enableSplit = !!msg.settings.enableSplit;
          if (msg.settings.enableAtu != null) enableAtu = !!msg.settings.enableAtu;
          if (msg.settings.tuneClick != null) tuneClick = !!msg.settings.tuneClick;
          if (msg.settings.enableRotor != null) { rotorConfigured = !!msg.settings.enableRotor; rotorEnabled = !!msg.settings.rotorActive; updateRotorBtn(); }
          if (msg.settings.remoteCwMacros) syncMacrosFromSettings(msg.settings.remoteCwMacros);
          if (msg.settings.customCatButtons) loadCustomCatButtons(msg.settings.customCatButtons);
          syncTuningUI();
        }
        break;

      case 'call-lookup':
        showCallLookup(msg);
        break;

      case 'park-results':
        showSearchResults(msg.results || []);
        break;

      case 'past-activations':
        pastActivations = msg.data || [];
        renderPastActivations();
        break;

      case 'activation-map-data':
        showActivationMap(msg.data);
        break;

      case 'signal':
        handleSignal(msg.data);
        break;
      case 'stun-config':
        _useStun = !!msg.useStun;
        break;

      case 'all-qsos':
        logbookQsos = msg.data || [];
        renderLogbook();
        break;

      case 'qso-updated':
        if (msg.success && msg.idx !== undefined) {
          const entry = logbookQsos.find(q => q.idx === msg.idx);
          if (entry) Object.assign(entry, msg.fields);
          renderLogbook();
          showLogToast('QSO updated');
        } else {
          showLogToast(msg.error || 'Update failed', true);
        }
        break;

      case 'qso-deleted':
        if (msg.success && msg.idx !== undefined) {
          logbookQsos = logbookQsos.filter(q => q.idx !== msg.idx);
          // Re-index: entries after deleted one shift down
          logbookQsos.forEach(q => { if (q.idx > msg.idx) q.idx--; });
          expandedQsoIdx = -1;
          renderLogbook();
          showLogToast('QSO deleted');
        } else {
          showLogToast(msg.error || 'Delete failed', true);
        }
        break;

      // --- JTCAT (FT8/FT4) ---
      case 'jtcat-status':
        ft8Running = msg.running !== false;
        ft8Mode = msg.mode || ft8Mode;
        ft8ModeSelect.value = ft8Mode;
        ft8SyncStatus.textContent = 'Sync: ' + (msg.sync || '--');
        break;

      case 'jtcat-decode':
        ft8HandleDecode(msg);
        break;

      case 'jtcat-decode-batch':
        if (msg.entries) {
          msg.entries.forEach(e => ft8HandleDecode(e));
        }
        break;

      case 'jtcat-cycle':
        ft8CycleSlot = msg.slot || '--';
        ft8CycleIndicator.textContent = msg.slot === 'even' ? 'E' : msg.slot === 'odd' ? 'O' : '--';
        ft8CycleBoundary = Date.now();
        ft8StartCountdown();
        break;

      case 'jtcat-tx-status':
        ft8Transmitting = msg.state === 'tx';
        ft8TxMsg = msg.message || ft8TxMsg;
        ft8RxTxBadge.textContent = ft8Transmitting ? 'TX' : 'RX';
        ft8RxTxBadge.className = ft8Transmitting ? 'ft8-rx-badge ft8-txing' : 'ft8-rx-badge';
        ft8TxBtn.classList.toggle('ft8-txing', ft8Transmitting);
        txBanner.classList.toggle('hidden', !ft8Transmitting);
        if (msg.txFreq != null) {
          ft8TxFreqHz = msg.txFreq;
          ft8TxFreqDisplay.textContent = 'TX: ' + msg.txFreq + ' Hz';
        }
        if (ft8Transmitting && ft8TxMsg) {
          ft8AddTxRow(ft8TxMsg);
        }
        break;

      case 'jtcat-qso-state':
        if (msg.phase === 'error') {
          ft8QsoState = null;
          ft8RenderQsoExchange();
          ft8UpdateCqBtn();
          // Show error toast
          const toast = document.createElement('div');
          toast.className = 'ft8-error-toast';
          toast.textContent = msg.error || 'Error';
          ft8View.appendChild(toast);
          setTimeout(() => toast.remove(), 4000);
          break;
        }
        ft8QsoState = (msg.phase && msg.phase !== 'idle') ? msg : null;
        ft8RenderQsoExchange();
        ft8UpdateCqBtn();
        ft8TxMsgEl.textContent = (ft8QsoState && ft8QsoState.txMsg) ? ft8QsoState.txMsg : '--';
        break;

      case 'jtcat-spectrum':
        ft8RenderWaterfall(msg.bins);
        break;

      case 'jtcat-auto-cq-state':
        if (ft8AutoCqSelect) {
          ft8AutoCqSelect.value = msg.mode || 'off';
          ft8AutoCqSelect.style.borderColor = msg.mode !== 'off' ? 'var(--pota)' : '';
        }
        break;

      // Cloud Sync messages
      case 'cloud-status':
      case 'cloud-login-result':
      case 'cloud-register-result':
      case 'cloud-logout-result':
      case 'cloud-sync-result':
      case 'cloud-upload-result':
      case 'cloud-verify-result':
      case 'cloud-bmac-result':
        if (typeof handleCloudMessage === 'function') handleCloudMessage(msg);
        break;

      case 'kiwi-status':
      case 'kiwi-audio':
        if (typeof handleKiwiMessage === 'function') handleKiwiMessage(msg);
        break;
    }
  }

  // --- Status ---
  function updateStatus(s) {
    if (s.freq > 100000) { // ignore bogus values below 100 kHz
      freqDisplay.textContent = formatFreq(s.freq);
      currentFreqKhz = s.freq / 1000;
    }
    if (s.mode) {
      currentMode = s.mode;
      // Display friendly name for FreeDV modes
      const mUp = s.mode.toUpperCase();
      modeBadge.textContent = mUp.startsWith('FREEDV') ? (mUp.includes('RADE') ? 'RADE' : 'FreeDV') : s.mode;
      const isVoice = (mUp === 'SSB' || mUp === 'USB' || mUp === 'LSB' || mUp === 'FM' || mUp === 'AM' || mUp.startsWith('FREEDV'));
      pttBtn.classList.toggle('hidden', !isVoice);
      estopBtn.classList.toggle('hidden', !isVoice);
      updateCwPanelVisibility();
      updateSsbPanelVisibility();
    }
    if (s.catConnected !== undefined) {
      catDot.classList.toggle('connected', s.catConnected);
      catDot.title = s.catConnected ? 'Radio connected' : 'Radio disconnected';
      settingsOverlay.classList.toggle('disabled', !s.catConnected);
    }
    if (s.txState !== undefined) {
      txState = s.txState;
      txBanner.classList.toggle('hidden', !s.txState);
      settingsOverlay.classList.toggle('disabled', s.txState);
      if (s.txState && scanning) stopScan();
      if (!s.txState && pttDown) {
        pttDown = false;
        pttBtn.classList.remove('active');
        muteRxAudio(false);
      }
    }
    // Rig controls state
    if (s.nb !== undefined) {
      currentNb = s.nb;
      rcNbBtn.classList.toggle('active', s.nb);
    }
    if (s.atu !== undefined) {
      currentAtu = s.atu;
      rcAtuBtn.classList.toggle('active', s.atu);
    }
    if (s.vfo) {
      currentVfo = s.vfo;
      rcVfoA.classList.toggle('active', s.vfo === 'A');
      rcVfoB.classList.toggle('active', s.vfo === 'B');
    }
    if (s.filterWidth !== undefined) {
      currentFilterWidth = s.filterWidth;
      rcBwLabel.textContent = formatBw(s.filterWidth);
    }
    if (s.rfgain !== undefined) {
      rcRfGainSlider.value = s.rfgain;
      rcRfGainVal.textContent = s.rfgain;
    }
    if (s.txpower !== undefined) {
      rcTxPowerSlider.value = s.txpower;
      rcTxPowerVal.textContent = s.txpower;
    }
    if (s.capabilities) {
      rigCapabilities = s.capabilities;
      soFilterRow.classList.toggle('hidden', !s.capabilities.filter);
      rcNbGroup.classList.toggle('hidden', !s.capabilities.nb);
      rcAtuGroup.classList.toggle('hidden', !s.capabilities.atu);
      soRfGainRow.classList.toggle('hidden', !s.capabilities.rfgain);
      soTxPowerRow.classList.toggle('hidden', !s.capabilities.txpower);
      rcVfoGroup.classList.toggle('hidden', !s.capabilities.vfo);
      // Clamp TX power slider to radio's min/max
      if (s.capabilities.minPower != null) rcTxPowerSlider.min = s.capabilities.minPower;
      if (s.capabilities.maxPower != null) rcTxPowerSlider.max = s.capabilities.maxPower;
    }
  }

  function formatBw(hz) {
    if (!hz || hz <= 0) return '--';
    if (hz >= 1000) return (hz / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return hz + '';
  }

  function formatFreq(hz) {
    const mhz = Math.floor(hz / 1e6);
    const khz = Math.floor((hz % 1e6) / 1e3);
    const sub = Math.floor(hz % 1e3);
    return `${mhz}.${String(khz).padStart(3, '0')}.${String(sub).padStart(3, '0')}`;
  }

  // --- Spots ---
  function isNewPark(s) {
    return workedParksSet.size > 0 &&
      (s.source === 'pota' || s.source === 'wwff') &&
      s.reference && !workedParksSet.has(s.reference);
  }

  function isWorkedSpot(s) {
    const entries = workedQsos.get((s.callsign || '').toUpperCase());
    if (!entries || entries.length === 0) return false;
    const now = new Date();
    const todayUtc = now.getUTCFullYear().toString() +
      String(now.getUTCMonth() + 1).padStart(2, '0') +
      String(now.getUTCDate()).padStart(2, '0');
    const todayQsos = entries.filter(e => e.date === todayUtc);
    if (todayQsos.length === 0) return false;
    const spotBand = (s.band || '').toUpperCase();
    const spotMode = (s.mode || '').toUpperCase();
    if (spotBand || spotMode) {
      return todayQsos.some(e =>
        (!spotBand || e.band === spotBand) &&
        (!spotMode || e.mode === spotMode)
      );
    }
    return true;
  }

  function hasWorkedCallsign(s) {
    return workedQsos.has((s.callsign || '').toUpperCase());
  }

  // Map spot mode to filter category
  var KNOWN_MODES = new Set(['CW', 'SSB', 'FT8', 'FT4', 'FM', 'RTTY', 'FREEDV']);
  function spotModeCategory(mode) {
    if (!mode) return 'other';
    var m = mode.toUpperCase();
    if (m === 'USB' || m === 'LSB') return 'SSB';
    if (m === 'AM') return 'other';
    if (m === 'FREEDV' || m === 'DV' || m.startsWith('FREEDV')) return 'FREEDV';
    if (KNOWN_MODES.has(m)) return m;
    return 'other';
  }

  function getFilteredSpots() {
    const bands = getDropdownValues(bandFilterEl);
    const modes = getDropdownValues(modeFilterEl);
    const regions = getDropdownValues(regionFilterEl);
    const filtered = spots.filter(s => {
      if (bands && !bands.has(s.band)) return false;
      if (modes && !modes.has(spotModeCategory(s.mode))) return false;
      if (regions && s.continent && !regions.has(s.continent)) return false;
      if (showNewOnly && !isNewPark(s)) return false;
      if (hideWorked && isWorkedSpot(s)) return false;
      return true;
    });
    filtered.sort((a, b) => {
      const aNet = a.source === 'net' ? 1 : 0;
      const bNet = b.source === 'net' ? 1 : 0;
      if (aNet !== bNet) return bNet - aNet;
      if (spotSort === 'freq') {
        return parseFloat(a.frequency) - parseFloat(b.frequency);
      } else if (spotSort === 'dist') {
        const da = a.distance != null ? a.distance : 1e9;
        const db = b.distance != null ? b.distance : 1e9;
        return da - db;
      } else if (spotSort === 'source') {
        const sa = (a.source || '').localeCompare(b.source || '');
        if (sa !== 0) return sa;
        // Within same source, sort by age (newest first)
        return parseSpotTime(b.spotTime) - parseSpotTime(a.spotTime);
      }
      // default: age (newest first)
      const ta = parseSpotTime(a.spotTime);
      const tb = parseSpotTime(b.spotTime);
      return tb - ta;
    });
    return filtered;
  }

  function renderSpots() {
    const filtered = getFilteredSpots();

    if (filtered.length === 0) {
      spotList.innerHTML = '<div class="spot-empty">No spots</div>';
      return;
    }

    spotList.innerHTML = filtered.map(s => {
      const srcClass = 'source-' + (s.source || 'pota');
      const tunedClass = (tunedFreqKhz && s.frequency === tunedFreqKhz) ? ' tuned' : '';
      const newPark = isNewPark(s);
      const newClass = newPark ? ' new-park' : '';
      const workedToday = isWorkedSpot(s);
      const workedEver = !workedToday && hasWorkedCallsign(s);
      const workedClass = workedToday ? ' worked-today' : workedEver ? ' worked' : '';
      const isSkipped = scanSkipped.has(s.frequency) || (workedToday && !scanForceUnskipped.has(s.frequency));
      const skipClass = isSkipped ? ' scan-skipped' : '';
      const workedCheck = (workedToday || workedEver) ? '<span class="worked-check">\u2713</span>' : '';
      const refClass = s.source === 'sota' ? 'sota' : s.source === 'dxc' ? 'dxc' : '';
      // Ref column: only show actual park/summit references (e.g. K-1234, W7A/PE-097)
      // locationDesc is a region code like "US-FL" for POTA, or a country name for DXC — don't show country names here
      const ref = s.reference || '\u2014';
      const isNet = s.source === 'net';
      const age = isNet ? (s.comments || '') : formatAge(s.spotTime);
      const freqStr = formatSpotFreq(s.frequency);
      const src = s.source || 'pota';
      const srcLabel = src.toUpperCase();
      const newBadge = newPark ? '<span class="new-badge">NEW</span>' : '';
      const logBtn = isNet ? '' : '<button type="button" class="spot-log-btn">L</button>';
      const skipBtn = isNet ? '' : `<button type="button" class="spot-skip-btn" data-skipfreq="${s.frequency}">${isSkipped ? 'U' : 'S'}</button>`;
      const opName = qrzNameCache[(s.callsign || '').toUpperCase()] || '';
      const spotName = opName || s.parkName || s.comments || '';

      // Build columns in user-defined order
      const colHtml = colOrder.map(key => {
        if (!colShow[key]) return '';
        switch (key) {
          case 'freq': return `<span class="spot-freq">${freqStr}</span>`;
          case 'mode': return `<span class="spot-mode">${esc(s.mode || '')}</span>`;
          case 'band': return `<span class="spot-band">${esc(s.band || '')}</span>`;
          case 'dist': return `<span class="spot-dist">${formatSpotDist(s.distance)}</span>`;
          case 'ref': return `<span class="spot-ref ${refClass}">${esc(ref)}</span>`;
          case 'name': return `<span class="spot-name">${esc(spotName)}</span>`;
          case 'region': {
            let rgn = s.locationDesc || '';
            const fullName = rgn;
            // POTA region codes like "US-FL" are already short — pass through
            // Country names need abbreviation
            if (rgn.length > 6) rgn = abbreviateCountry(rgn);
            return rgn ? `<span class="spot-region" title="${esc(fullName)}">${esc(rgn)}</span>` : '<span class="spot-region">\u2014</span>';
          }
          case 'src': return `<span class="spot-src source-${src}">${srcLabel}</span>`;
          case 'age': return `<span class="spot-age">${age}</span>`;
          case 'skip': return isNet ? '' : skipBtn;
          case 'log': return isNet ? '' : logBtn;
          default: return '';
        }
      }).join('');

      return `<div class="spot-card ${srcClass}${tunedClass}${newClass}${workedClass}${skipClass}" data-freq="${s.frequency}" data-mode="${s.mode || ''}" data-bearing="${s.bearing || ''}" data-call="${esc(s.callsign)}" data-ref="${esc(ref)}" data-src="${src}">
        <span class="spot-call">${workedCheck}${esc(s.callsign)}${donorCallsigns.has((s.callsign || '').toUpperCase()) ? '<span class="donor-paw" title="POTACAT Supporter">\uD83D\uDC3E</span>' : ''}${(s.callsign || '').toUpperCase() === 'K3SBP' ? '<span class="donor-paw" title="POTACAT Creator">\uD83D\uDC08\u200D\u2B1B</span>' : ''}${newBadge}</span>
        ${colHtml}
      </div>`;
    }).join('');
  }

  function formatSpotFreq(kHz) {
    const num = parseFloat(kHz);
    if (isNaN(num)) return kHz;
    return num.toFixed(1);
  }

  function abbreviateCountry(name) {
    var map = {
      'United States':'USA','Canada':'CAN','Mexico':'MEX','Japan':'JPN','China':'CHN',
      'Australia':'AUS','New Zealand':'NZL','Brazil':'BRA','Argentina':'ARG',
      'Germany':'DEU','Fed. Rep. of Germany':'DEU','France':'FRA','Italy':'ITA',
      'Spain':'ESP','United Kingdom':'GBR','England':'ENG','Scotland':'SCO',
      'Wales':'WAL','Netherlands':'NLD','Belgium':'BEL','Switzerland':'CHE',
      'Austria':'AUT','Poland':'POL','Sweden':'SWE','Norway':'NOR','Denmark':'DNK',
      'Finland':'FIN','Portugal':'PRT','Czech Republic':'CZE','Hungary':'HUN',
      'Romania':'ROU','Greece':'GRC','Turkey':'TUR','Israel':'ISR',
      'South Korea':'KOR','India':'IND','Russia':'RUS',
      'European Russia':'RUS','Asiatic Russia':'RUS',
      'South Africa':'ZAF','Thailand':'THA','Philippines':'PHL',
      'Indonesia':'IDN','Colombia':'COL','Chile':'CHL','Peru':'PER',
      'Hawaii':'HI','Alaska':'AK','Puerto Rico':'PR',
      'Guadeloupe':'GLP','Curacao':'CUR','Bermuda':'BMU',
      'Turks & Caicos Islands':'TCA','Cayman Islands':'CYM',
      'US Virgin Islands':'USVI','British Virgin Islands':'BVI',
      'Trinidad & Tobago':'TTO','Dominican Republic':'DOM',
      'Costa Rica':'CRI','Panama':'PAN','Venezuela':'VEN',
      'Ukraine':'UKR','Ireland':'IRL','Croatia':'HRV','Serbia':'SRB',
      'Bulgaria':'BGR','Slovakia':'SVK','Slovenia':'SVN','Lithuania':'LTU',
      'Latvia':'LVA','Estonia':'EST','Iceland':'ISL','Luxembourg':'LUX',
      'Malta':'MLT','Cyprus':'CYP','Taiwan':'TWN','Singapore':'SGP',
      'Malaysia':'MYS','Vietnam':'VNM','Pakistan':'PAK','Bangladesh':'BGD',
      'Sri Lanka':'LKA','Egypt':'EGY','Morocco':'MAR','Kenya':'KEN',
      'Nigeria':'NGA','Ghana':'GHA','Algeria':'DZA','Tunisia':'TUN',
    };
    return map[name] || name.slice(0, 4);
  }

  const MI_TO_KM = 1.60934;
  function formatSpotDist(miles) {
    if (miles == null) return '';
    const d = distUnit === 'km' ? Math.round(miles * MI_TO_KM) : Math.round(miles);
    // Compact: 1.2k mi instead of 1,234 mi
    if (d >= 10000) return (d / 1000).toFixed(0) + 'k';
    if (d >= 1000) return (d / 1000).toFixed(1) + 'k';
    return d + (distUnit === 'km' ? 'km' : 'mi');
  }

  const SOURCE_COLORS_MAP = { pota: '#4ecca3', sota: '#f0a500', dxc: '#e040fb', rbn: '#4fc3f7', pskr: '#ff6b6b', net: '#ffd740', wwff: '#26a69a', llota: '#42a5f5' };

  function drawSpotTuneArc(lat, lon, source) {
    if (spotTuneArcLayer) { spotMap.removeLayer(spotTuneArcLayer); spotTuneArcLayer = null; }
    if (!spotMap || !phoneGrid) return;
    const home = gridToLatLonLocal(phoneGrid);
    if (!home) return;
    const color = SOURCE_COLORS_MAP[source] || SOURCE_COLORS_MAP.pota;
    const arcPoints = greatCircleArc([home.lat, home.lon], [lat, lon], 200);
    // Split at antimeridian discontinuities
    const segments = [[arcPoints[0]]];
    for (let i = 1; i < arcPoints.length; i++) {
      if (Math.abs(arcPoints[i][1] - arcPoints[i - 1][1]) > 180) {
        segments.push([]);
      }
      segments[segments.length - 1].push(arcPoints[i]);
    }
    const allLines = [];
    for (const seg of segments) {
      if (seg.length < 2) continue;
      allLines.push(L.polyline(seg, { color, weight: 2, opacity: 0.7, dashArray: '6 4', interactive: false }));
    }
    if (allLines.length) {
      spotTuneArcLayer = L.layerGroup(allLines).addTo(spotMap);
    }
  }

  function renderMapSpots() {
    if (!spotMap) return;
    if (spotMapLayer) spotMapLayer.clearLayers();
    else spotMapLayer = L.layerGroup().addTo(spotMap);

    const filtered = getFilteredSpots();
    const bounds = [];

    if (phoneGrid) {
      const home = gridToLatLonLocal(phoneGrid);
      if (home) {
        L.circleMarker([home.lat, home.lon], { radius: 8, color: '#e94560', fillColor: '#e94560', fillOpacity: 1 })
          .bindPopup('Home QTH').addTo(spotMapLayer);
        bounds.push([home.lat, home.lon]);
      }
    }

    filtered.forEach(s => {
      if (!s.lat || !s.lon) return;
      const color = SOURCE_COLORS_MAP[s.source] || '#888';
      const dist = formatSpotDist(s.distance);
      const ref = s.reference || s.locationDesc || '';
      const marker = L.circleMarker([s.lat, s.lon], {
        radius: 7, color, fillColor: color, fillOpacity: 0.8, weight: 1
      });
      marker.bindPopup('<b>' + esc(s.callsign) + '</b><br>' + esc(ref) + '<br>' + formatSpotFreq(s.frequency) + ' ' + dist);
      marker.on('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'tune', freqKhz: s.frequency, mode: s.mode, bearing: s.bearing ? parseFloat(s.bearing) : undefined }));
        }
        tunedFreqKhz = s.frequency;
        drawSpotTuneArc(s.lat, s.lon, s.source);
      });
      marker.addTo(spotMapLayer);
      bounds.push([s.lat, s.lon]);
    });

    // Only auto-zoom on first render; subsequent updates preserve user's pan/zoom
    if (!spotMapHasFit) {
      if (bounds.length > 1) spotMap.fitBounds(bounds, { padding: [30, 30] });
      else if (bounds.length === 1) spotMap.setView(bounds[0], 5);
      spotMapHasFit = true;
    }
  }

  function parseSpotTime(t) {
    if (!t) return 0;
    const s = t.endsWith('Z') ? t : t + 'Z';
    return new Date(s).getTime() || 0;
  }

  function formatAge(t) {
    const ms = Date.now() - parseSpotTime(t);
    if (ms < 0 || isNaN(ms)) return '';
    const min = Math.floor(ms / 60000);
    if (min < 1) return '<1m';
    if (min < 60) return min + 'm';
    const hr = Math.floor(min / 60);
    const rm = min % 60;
    return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`;
  }

  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Tune (tap on spot) or Log ---
  spotList.addEventListener('click', (e) => {
    const skipTarget = e.target.closest('.spot-skip-btn');
    if (skipTarget) {
      const freq = skipTarget.dataset.skipfreq;
      if (scanSkipped.has(freq)) {
        scanSkipped.delete(freq);
        scanForceUnskipped.add(freq);
      } else {
        scanSkipped.add(freq);
        scanForceUnskipped.delete(freq);
      }
      renderSpots();
      return;
    }
    const logTarget = e.target.closest('.spot-log-btn');
    if (logTarget) {
      const card = logTarget.closest('.spot-card');
      if (card) {
        openLogSheet({
          callsign: card.dataset.call || '',
          freqKhz: card.dataset.freq || '',
          mode: card.dataset.mode || '',
          sig: srcToSig(card.dataset.src),
          sigInfo: card.dataset.ref || '',
        });
      }
      return;
    }
    const card = e.target.closest('.spot-card');
    if (!card || !ws || ws.readyState !== WebSocket.OPEN) return;
    const freqKhz = card.dataset.freq;
    const mode = card.dataset.mode;
    const callsign = card.dataset.call || '';
    ws.send(JSON.stringify({
      type: 'tune',
      freqKhz,
      mode,
      bearing: card.dataset.bearing ? parseFloat(card.dataset.bearing) : undefined,
    }));
    const hz = parseFloat(freqKhz) * 1000;
    if (hz > 100000) { // ignore bogus values below 100 kHz
      freqDisplay.textContent = formatFreq(hz);
      currentFreqKhz = parseFloat(freqKhz);
    }
    if (mode) {
      const mu = mode.toUpperCase();
      modeBadge.textContent = mu.startsWith('FREEDV') ? (mu.includes('RADE') ? 'RADE' : 'FreeDV') : mode;
    }
    tunedFreqKhz = freqKhz;
    tunedCallsign = callsign;
    // Update spotted WPM for CW sync
    const tunedSpot = spots.find(s => s.callsign === callsign && s.frequency === freqKhz);
    echoSpotWpm = tunedSpot && tunedSpot.wpm ? tunedSpot.wpm : null;
    updateEchoCwSpotWpm();
    // Look up operator name and state from QRZ for CW macros
    tunedOpName = '';
    tunedState = '';
    if (callsign && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'qrz-lookup', callsign: callsign.toUpperCase().split('/')[0] }));
    }
    spotList.querySelectorAll('.spot-card.tuned').forEach(c => c.classList.remove('tuned'));
    card.classList.add('tuned');

    // FT8/FT4 spot → switch to FT8 tab and hunt the station
    const modeUpper = (mode || '').toUpperCase();
    if ((modeUpper === 'FT8' || modeUpper === 'FT4' || modeUpper === 'FT2') && callsign) {
      ft8Mode = modeUpper;
      ft8ModeSelect.value = ft8Mode;
      ft8HuntCall = callsign.toUpperCase();
      // Clear decode log for fresh start
      ft8DecodeLog = [];
      ft8DecodeLogEl.innerHTML = '<div class="ft8-empty">Hunting ' + esc(ft8HuntCall) + '...</div>';
      switchTab('ft8', { freqKhz: freqKhz });
    }
  });

  // --- Multi-select dropdown helpers ---
  var _filterScroll = document.getElementById('filter-toolbar-scroll');
  function closeAllDropdowns() {
    document.querySelectorAll('.rc-dropdown.open').forEach(d => d.classList.remove('open'));
    if (_filterScroll) _filterScroll.style.overflowX = '';
  }

  function initMultiDropdown(container, onChange) {
    const btn = container.querySelector('.rc-dropdown-btn');
    const menu = container.querySelector('.rc-dropdown-menu');
    const textEl = container.querySelector('.rc-dd-text');
    const allCb = menu.querySelector('input[value="all"]');
    const itemCbs = [...menu.querySelectorAll('input:not([value="all"])')];
    function updateText() {
      const checked = itemCbs.filter(cb => cb.checked);
      if (allCb.checked || checked.length === 0) { textEl.textContent = 'All'; }
      else if (checked.length <= 2) { textEl.textContent = checked.map(cb => cb.value).join(', '); }
      else { textEl.textContent = checked.length + ' sel'; }
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.rc-dropdown.open').forEach(d => {
        if (d !== container) d.classList.remove('open');
      });
      container.classList.toggle('open');
      if (container.classList.contains('open')) {
        _dropdownJustOpened = true;
        // Remove overflow clipping so position:fixed menus escape on mobile WebKit
        if (_filterScroll) _filterScroll.style.overflowX = 'visible';
        const rect = btn.getBoundingClientRect();
        menu.style.left = rect.left + 'px';
        menu.style.top = (rect.bottom + 4) + 'px';
      } else {
        if (_filterScroll) _filterScroll.style.overflowX = '';
      }
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
    menu.addEventListener('change', (e) => {
      const cb = e.target;
      if (cb.value === 'all') {
        itemCbs.forEach(c => { c.checked = cb.checked; });
      } else {
        allCb.checked = false;
        if (itemCbs.every(c => !c.checked)) allCb.checked = true;
        if (itemCbs.every(c => c.checked)) { allCb.checked = true; itemCbs.forEach(c => { c.checked = false; }); }
      }
      updateText();
      if (onChange) onChange();
    });
    updateText();
  }

  function getDropdownValues(container) {
    const allCb = container.querySelector('input[value="all"]');
    if (allCb && allCb.checked) return null;
    const checked = [...container.querySelectorAll('input:not([value="all"]):checked')];
    if (checked.length === 0) return null;
    return new Set(checked.map(cb => cb.value));
  }

  // Initialize band and region dropdowns
  initMultiDropdown(bandFilterEl, () => { renderSpots(); if (activeTab === 'map') renderMapSpots(); sendFilters(); });
  initMultiDropdown(modeFilterEl, () => { renderSpots(); if (activeTab === 'map') renderMapSpots(); sendFilters(); });
  initMultiDropdown(regionFilterEl, () => { renderSpots(); if (activeTab === 'map') renderMapSpots(); sendFilters(); });

  // --- Spots dropdown ---
  spotsDropdown.querySelector('.rc-dropdown-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.rc-dropdown.open').forEach(d => { if (d !== spotsDropdown) d.classList.remove('open'); });
    spotsDropdown.classList.toggle('open');
    if (spotsDropdown.classList.contains('open')) {
      _dropdownJustOpened = true;
      if (_filterScroll) _filterScroll.style.overflowX = 'visible';
      const rect = spotsDropdown.querySelector('.rc-dropdown-btn').getBoundingClientRect();
      const panel = spotsDropdown.querySelector('.rc-spots-panel');
      panel.style.left = rect.left + 'px';
      panel.style.top = (rect.bottom + 4) + 'px';
    } else {
      if (_filterScroll) _filterScroll.style.overflowX = '';
    }
  });

  spotsDropdown.querySelector('.rc-spots-panel').addEventListener('click', (e) => e.stopPropagation());
  spotsDropdown.querySelector('.rc-spots-panel').addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.dataset.src) {
      const sources = {};
      spotsDropdown.querySelectorAll('[data-src]').forEach(c => { sources[c.dataset.src] = c.checked; });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set-sources', sources }));
      }
    } else if (cb.id === 'rc-new-only') {
      showNewOnly = cb.checked;
      renderSpots();
      if (activeTab === 'map') renderMapSpots();
      sendFilters();
    } else if (cb.id === 'rc-hide-worked') {
      hideWorked = cb.checked;
      renderSpots();
      if (activeTab === 'map') renderMapSpots();
      sendFilters();
    }
  });

  // Close dropdowns on outside tap (delay to prevent immediate close on mobile)
  var _dropdownJustOpened = false;
  document.addEventListener('click', () => {
    if (_dropdownJustOpened) { _dropdownJustOpened = false; return; }
    closeAllDropdowns();
  });

  // --- Filter persistence (sync to desktop settings.json) ---
  function getFilterValues(container) {
    const allCb = container.querySelector('input[value="all"]');
    if (allCb && allCb.checked) return null;
    const checked = [...container.querySelectorAll('input:not([value="all"]):checked')];
    if (checked.length === 0) return null;
    return checked.map(cb => cb.value);
  }
  function sendFilters() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'set-echo-filters',
      filters: {
        bands: getFilterValues(bandFilterEl),
        modes: getFilterValues(modeFilterEl),
        regions: getFilterValues(regionFilterEl),
        sort: spotSort,
        newOnly: showNewOnly,
        hideWorked: hideWorked,
      }
    }));
  }
  function applyFilters(f) {
    if (!f) return;
    [bandFilterEl, modeFilterEl, regionFilterEl].forEach((el, i) => {
      const vals = [f.bands, f.modes, f.regions][i];
      const allCb = el.querySelector('input[value="all"]');
      const itemCbs = [...el.querySelectorAll('input:not([value="all"])')];
      if (!vals) {
        allCb.checked = true;
        itemCbs.forEach(cb => { cb.checked = false; });
      } else {
        const set = new Set(vals);
        allCb.checked = false;
        itemCbs.forEach(cb => { cb.checked = set.has(cb.value); });
      }
      // Update dropdown text
      const textEl = el.querySelector('.rc-dd-text');
      if (textEl) {
        const checked = itemCbs.filter(cb => cb.checked);
        if (allCb.checked || checked.length === 0) { textEl.textContent = 'All'; }
        else if (checked.length <= 2) { textEl.textContent = checked.map(cb => cb.value).join(', '); }
        else { textEl.textContent = checked.length + ' sel'; }
      }
    });
    if (f.sort) { spotSort = f.sort; sortSelect.value = f.sort; }
    if (f.newOnly != null) {
      showNewOnly = f.newOnly;
      const cb = document.getElementById('rc-new-only');
      if (cb) cb.checked = f.newOnly;
    }
    if (f.hideWorked != null) {
      hideWorked = f.hideWorked;
      const cb = document.getElementById('rc-hide-worked');
      if (cb) cb.checked = f.hideWorked;
    }
    renderSpots();
    if (activeTab === 'map') renderMapSpots();
  }

  // --- Sort ---
  sortSelect.addEventListener('change', () => {
    spotSort = sortSelect.value;
    renderSpots();
    if (activeTab === 'map') renderMapSpots();
    sendFilters();
  });

  // --- Frequency direct input (legacy — kept for keyboard fallback) ---
  freqDisplay.addEventListener('click', () => {
    openDialPad();
  });

  function submitFreq() {
    const val = parseFloat(freqInput.value);
    if (!val || isNaN(val) || val < 100 || val > 500000) {
      cancelFreqEdit();
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tune', freqKhz: val.toString(), mode: '' }));
    }
    cancelFreqEdit();
  }

  function cancelFreqEdit() {
    statusBar.classList.remove('editing');
    freqInput.blur();
  }

  freqGo.addEventListener('click', submitFreq);
  freqInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitFreq(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelFreqEdit(); }
  });
  freqInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (statusBar.classList.contains('editing')) cancelFreqEdit();
    }, 200);
  });

  // --- Dial Pad ---
  const STEP_SIZES = [0.01, 0.1, 0.5, 1, 5, 10, 25, 100];
  let dpStepIdx = parseInt(localStorage.getItem('echocat-step-idx') || '3', 10); // default 1 kHz
  if (dpStepIdx < 0 || dpStepIdx >= STEP_SIZES.length) dpStepIdx = 3;
  let dpInput = '';

  function openDialPad() {
    dpInput = currentFreqKhz ? (Math.round(currentFreqKhz * 10) / 10).toString() : '';
    updateDpDisplay();
    dialPad.classList.remove('hidden');
    dialPadBackdrop.classList.remove('hidden');
  }

  function closeDialPad() {
    dialPad.classList.add('hidden');
    dialPadBackdrop.classList.add('hidden');
  }

  function updateDpDisplay() {
    if (!dpInput) {
      dpFreq.textContent = '---.---.---';
      dpFreq.classList.add('empty');
    } else {
      dpFreq.classList.remove('empty');
      // Format as MHz.kHz.Hz display
      const val = parseFloat(dpInput);
      if (!isNaN(val) && val > 0) {
        const hz = Math.round(val * 1000);
        dpFreq.textContent = formatFreq(hz);
      } else {
        dpFreq.textContent = dpInput;
      }
    }
  }

  function dpTune(freqKhz) {
    if (!freqKhz || isNaN(freqKhz) || freqKhz < 100 || freqKhz > 500000) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tune', freqKhz: freqKhz.toString(), mode: '' }));
    }
    // Immediately update local display
    const hz = Math.round(freqKhz * 1000);
    freqDisplay.textContent = formatFreq(hz);
    currentFreqKhz = freqKhz;
  }

  // Number button clicks
  dialPad.querySelector('.dp-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.dp-btn');
    if (!btn) return;
    const val = btn.dataset.val;
    if (val === 'del') {
      dpInput = dpInput.slice(0, -1);
    } else if (val === '.') {
      if (!dpInput.includes('.')) dpInput += dpInput ? '.' : '0.';
    } else {
      dpInput += val;
    }
    updateDpDisplay();
  });

  dpGo.addEventListener('click', () => {
    const val = parseFloat(dpInput);
    dpTune(val);
    closeDialPad();
  });

  dpCancel.addEventListener('click', closeDialPad);
  dialPadBackdrop.addEventListener('click', closeDialPad);

  dpClear.addEventListener('click', () => {
    dpInput = '';
    updateDpDisplay();
  });

  // Step size cycle
  function updateStepLabel() {
    const s = STEP_SIZES[dpStepIdx];
    dpStepSize.textContent = s >= 1 ? s + ' kHz' : (s * 1000) + ' Hz';
  }
  updateStepLabel();

  dpStepSize.addEventListener('click', () => {
    dpStepIdx = (dpStepIdx + 1) % STEP_SIZES.length;
    localStorage.setItem('echocat-step-idx', dpStepIdx);
    updateStepLabel();
  });

  // Step up/down inside dial pad — tunes immediately
  dpStepUp.addEventListener('click', () => {
    const step = STEP_SIZES[dpStepIdx];
    const base = dpInput ? parseFloat(dpInput) : currentFreqKhz;
    if (!base || isNaN(base)) return;
    const newFreq = Math.round((base + step) * 100) / 100;
    dpInput = newFreq.toString();
    updateDpDisplay();
    dpTune(newFreq);
  });

  dpStepDown.addEventListener('click', () => {
    const step = STEP_SIZES[dpStepIdx];
    const base = dpInput ? parseFloat(dpInput) : currentFreqKhz;
    if (!base || isNaN(base)) return;
    const newFreq = Math.round((base - step) * 100) / 100;
    if (newFreq < 100) return;
    dpInput = newFreq.toString();
    updateDpDisplay();
    dpTune(newFreq);
  });

  // Status bar up/down buttons — quick step without opening dial pad
  freqUpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const step = STEP_SIZES[dpStepIdx];
    const newFreq = Math.round((currentFreqKhz + step) * 100) / 100;
    dpTune(newFreq);
  });

  freqDownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const step = STEP_SIZES[dpStepIdx];
    const newFreq = Math.round((currentFreqKhz - step) * 100) / 100;
    if (newFreq >= 100) dpTune(newFreq);
  });

  // --- VFO Dial ---
  var vfoView = document.getElementById('dp-vfo-view');
  var keypadView = document.getElementById('dp-keypad-view');
  var dpModeToggle = document.getElementById('dp-mode-toggle');
  var vfoFreqEl = document.getElementById('vfo-freq');
  var vfoStepSize = document.getElementById('vfo-step-size');
  var vfoCancel = document.getElementById('vfo-cancel');
  var vfoCanvas = document.getElementById('vfo-dial');
  var vfoCtx = vfoCanvas.getContext('2d');
  var vfoMode = localStorage.getItem('echocat-dial-mode') === 'vfo';
  var vfoAngle = 0;           // current visual rotation (radians)
  var vfoAccum = 0;           // accumulated angle since last step
  var vfoStepIdx = dpStepIdx; // share step index with keypad
  var vfoTouching = false;
  var vfoLastAngle = 0;
  var vfoVelocity = 0;
  var vfoInertiaFrame = null;

  function vfoStepRad() {
    // Radians per step — bigger steps = more rotation per step
    return Math.PI / 6; // 30° per step
  }

  function applyVfoMode() {
    if (vfoMode) {
      keypadView.classList.add('hidden');
      vfoView.classList.remove('hidden');
      dpModeToggle.innerHTML = '&#x2328;'; // keyboard icon
      dpModeToggle.title = 'Switch to keypad';
    } else {
      vfoView.classList.add('hidden');
      keypadView.classList.remove('hidden');
      dpModeToggle.innerHTML = '&#x25CE;'; // dial icon
      dpModeToggle.title = 'Switch to VFO dial';
    }
  }
  applyVfoMode();

  dpModeToggle.addEventListener('click', function(e) {
    e.stopPropagation();
    vfoMode = !vfoMode;
    localStorage.setItem('echocat-dial-mode', vfoMode ? 'vfo' : 'keypad');
    applyVfoMode();
    if (vfoMode) drawVfoDial();
  });

  function updateVfoFreqDisplay() {
    if (!currentFreqKhz) { vfoFreqEl.textContent = '---.---.---'; return; }
    vfoFreqEl.textContent = formatFreq(Math.round(currentFreqKhz * 1000));
  }

  function updateVfoStepLabel() {
    var s = STEP_SIZES[vfoStepIdx];
    vfoStepSize.textContent = s >= 1 ? s + ' kHz' : (s * 1000) + ' Hz';
  }
  updateVfoStepLabel();

  vfoStepSize.addEventListener('click', function() {
    vfoStepIdx = (vfoStepIdx + 1) % STEP_SIZES.length;
    dpStepIdx = vfoStepIdx; // sync with keypad
    localStorage.setItem('echocat-step-idx', dpStepIdx);
    updateVfoStepLabel();
    updateStepLabel();
  });

  vfoCancel.addEventListener('click', closeDialPad);

  // Draw the VFO knob — round housing with inset rotating dial and finger dimple
  function drawVfoDial() {
    var w = vfoCanvas.width, h = vfoCanvas.height;
    var cx = w / 2, cy = h / 2, R = w / 2 - 4;
    var ctx = vfoCtx;
    ctx.clearRect(0, 0, w, h);

    // === Housing (fixed, doesn't rotate) ===

    // Outer housing shadow
    ctx.beginPath();
    ctx.arc(cx, cy + 2, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fill();

    // Housing body — dark brushed metal
    var housingGrad = ctx.createRadialGradient(cx, cy - R * 0.3, 0, cx, cy, R);
    housingGrad.addColorStop(0, '#404058');
    housingGrad.addColorStop(0.7, '#2a2a3a');
    housingGrad.addColorStop(1, '#1a1a28');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = housingGrad;
    ctx.fill();

    // Housing bevel ring — subtle edge highlight
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.stroke();

    // Inner recess shadow (the groove the knob sits in)
    var knobR = R * 0.78;
    ctx.beginPath();
    ctx.arc(cx, cy, knobR + 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();

    // Indicator mark on housing (fixed, top center)
    ctx.beginPath();
    ctx.moveTo(cx, cy - R + 2);
    ctx.lineTo(cx, cy - knobR - 5);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#4ecca3';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';

    // === Rotating knob (rotates with vfoAngle) ===

    // Knob face — slightly convex look with offset highlight
    var knobGrad = ctx.createRadialGradient(cx - knobR * 0.15, cy - knobR * 0.2, 0, cx, cy, knobR);
    knobGrad.addColorStop(0, '#4a4a62');
    knobGrad.addColorStop(0.5, '#353548');
    knobGrad.addColorStop(1, '#28283a');
    ctx.beginPath();
    ctx.arc(cx, cy, knobR, 0, Math.PI * 2);
    ctx.fillStyle = knobGrad;
    ctx.fill();

    // Knob edge highlight (top-left rim catch)
    ctx.beginPath();
    ctx.arc(cx, cy, knobR, -Math.PI * 0.8, -Math.PI * 0.2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.stroke();

    // Grip ridges around the knob edge (rotate with knob)
    var numRidges = 48;
    for (var i = 0; i < numRidges; i++) {
      var a = (i / numRidges) * Math.PI * 2 + vfoAngle;
      var r1 = knobR * 0.90;
      var r2 = knobR * 0.98;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = i % 2 === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.15)';
      ctx.stroke();
    }

    // Finger dimple — inset circle at the edge of the knob
    var dimpleAngle = vfoAngle - Math.PI / 2; // starts at top
    var dimpleDist = knobR * 0.62;
    var dimpleR = knobR * 0.12;
    var dx = cx + Math.cos(dimpleAngle) * dimpleDist;
    var dy = cy + Math.sin(dimpleAngle) * dimpleDist;

    // Dimple shadow (inset effect)
    var dimpleGrad = ctx.createRadialGradient(dx - dimpleR * 0.3, dy - dimpleR * 0.3, 0, dx, dy, dimpleR);
    dimpleGrad.addColorStop(0, '#1a1a2a');
    dimpleGrad.addColorStop(0.6, '#222234');
    dimpleGrad.addColorStop(1, '#2e2e42');
    ctx.beginPath();
    ctx.arc(dx, dy, dimpleR, 0, Math.PI * 2);
    ctx.fillStyle = dimpleGrad;
    ctx.fill();
    // Dimple rim highlight
    ctx.beginPath();
    ctx.arc(dx, dy, dimpleR, 0, Math.PI * 2);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.stroke();
  }
  drawVfoDial();

  // Touch handling
  function vfoTouchAngle(e) {
    var rect = vfoCanvas.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var touch = e.touches ? e.touches[0] : e;
    return Math.atan2(touch.clientY - cy, touch.clientX - cx);
  }

  function vfoHaptic() {
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function vfoProcessDelta(delta) {
    vfoAngle += delta;
    vfoAccum += delta;
    var stepRad = vfoStepRad();
    var steps = Math.trunc(vfoAccum / stepRad);
    if (steps !== 0) {
      vfoAccum -= steps * stepRad;
      var step = STEP_SIZES[vfoStepIdx];
      var newFreq = Math.round((currentFreqKhz + steps * step) * 100) / 100;
      if (newFreq >= 100) {
        dpTune(newFreq);
        updateVfoFreqDisplay();
        vfoHaptic();
      }
    }
    drawVfoDial();
  }

  vfoCanvas.addEventListener('touchstart', function(e) {
    e.preventDefault();
    vfoTouching = true;
    vfoLastAngle = vfoTouchAngle(e);
    vfoAccum = 0;
    vfoVelocity = 0;
    if (vfoInertiaFrame) { cancelAnimationFrame(vfoInertiaFrame); vfoInertiaFrame = null; }
  }, { passive: false });

  vfoCanvas.addEventListener('touchmove', function(e) {
    e.preventDefault();
    if (!vfoTouching) return;
    var a = vfoTouchAngle(e);
    var delta = a - vfoLastAngle;
    // Handle wrap-around at ±PI
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    vfoVelocity = delta;
    vfoLastAngle = a;
    vfoProcessDelta(delta);
  }, { passive: false });

  vfoCanvas.addEventListener('touchend', function(e) {
    e.preventDefault();
    vfoTouching = false;
    // Inertia — decelerate the spin
    if (Math.abs(vfoVelocity) > 0.01) {
      (function inertia() {
        vfoVelocity *= 0.92;
        if (Math.abs(vfoVelocity) < 0.005) { vfoVelocity = 0; vfoInertiaFrame = null; return; }
        vfoProcessDelta(vfoVelocity);
        vfoInertiaFrame = requestAnimationFrame(inertia);
      })();
    }
  }, { passive: false });

  // Mouse support (for desktop testing)
  var vfoMouseDown = false;
  vfoCanvas.addEventListener('mousedown', function(e) {
    vfoMouseDown = true;
    vfoLastAngle = vfoTouchAngle(e);
    vfoAccum = 0;
    vfoVelocity = 0;
    if (vfoInertiaFrame) { cancelAnimationFrame(vfoInertiaFrame); vfoInertiaFrame = null; }
  });
  window.addEventListener('mousemove', function(e) {
    if (!vfoMouseDown) return;
    var a = vfoTouchAngle(e);
    var delta = a - vfoLastAngle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    vfoVelocity = delta;
    vfoLastAngle = a;
    vfoProcessDelta(delta);
  });
  window.addEventListener('mouseup', function() {
    if (!vfoMouseDown) return;
    vfoMouseDown = false;
    if (Math.abs(vfoVelocity) > 0.01) {
      (function inertia() {
        vfoVelocity *= 0.92;
        if (Math.abs(vfoVelocity) < 0.005) { vfoVelocity = 0; vfoInertiaFrame = null; return; }
        vfoProcessDelta(vfoVelocity);
        vfoInertiaFrame = requestAnimationFrame(inertia);
      })();
    }
  });

  // Scroll wheel support
  vfoCanvas.addEventListener('wheel', function(e) {
    e.preventDefault();
    var delta = e.deltaY > 0 ? -vfoStepRad() : vfoStepRad();
    vfoProcessDelta(delta);
  }, { passive: false });

  // Update VFO display when freq changes externally
  var _origOpenDialPad = openDialPad;
  openDialPad = function() {
    _origOpenDialPad();
    if (vfoMode) {
      updateVfoFreqDisplay();
      drawVfoDial();
    }
  };

  // --- PTT ---
  function muteRxAudio(mute) {
    if (remoteAudio) remoteAudio.muted = mute;
  }

  function pttStart() {
    // If SSB macro is playing and user presses PTT manually, cancel macro and go live
    if (typeof ssbPlayingIdx !== 'undefined' && ssbPlayingIdx >= 0) {
      stopSsbPlayback();
      return;
    }
    if (pttDown) return;
    pttDown = true;
    pttBtn.classList.add('active');
    txBanner.classList.remove('hidden');
    muteRxAudio(true);
    // Unmute mic track so audio reaches radio modulator
    if (localAudioStream) localAudioStream.getAudioTracks().forEach(t => { t.enabled = true; });
    if (typeof smConnected !== 'undefined' && smConnected && smMicTrack) smMicTrack.enabled = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ptt', state: true }));
    }
  }

  function pttStop() {
    if (!pttDown) return;
    pttDown = false;
    pttBtn.classList.remove('active');
    txBanner.classList.add('hidden');
    muteRxAudio(typeof kiwiRxConnected !== 'undefined' && kiwiRxConnected); // stay muted if SDR active
    // Re-mute mic track to prevent VOX/feedback TX cycling
    if (localAudioStream) localAudioStream.getAudioTracks().forEach(t => { t.enabled = false; });
    if (typeof smConnected !== 'undefined' && smConnected && smMicTrack) smMicTrack.enabled = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ptt', state: false }));
    }
  }

  pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); pttStart(); });
  pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); pttStop(); });
  pttBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); pttStop(); });
  pttBtn.addEventListener('mousedown', (e) => { e.preventDefault(); pttStart(); });
  pttBtn.addEventListener('mouseup', (e) => { e.preventDefault(); pttStop(); });
  pttBtn.addEventListener('mouseleave', (e) => { if (pttDown) pttStop(); });

  // Spacebar PTT (iPad keyboard)
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && !isInputFocused()) { e.preventDefault(); pttStart(); }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !isInputFocused()) { e.preventDefault(); pttStop(); }
  });
  function isInputFocused() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  // --- Bluetooth PTT (experimental) ---
  // Attempts to catch Bluetooth headset button presses (e.g. Inrico B01/B02)
  // via Media Session API. Requires active audio session to receive events.
  var btPttEnabled = false;
  var btPttAudioEl = null;
  var btPttBtn = document.getElementById('so-bt-ptt');
  var btPttStatus = document.getElementById('bt-ptt-status');

  function btPttUpdateStatus(text) {
    if (btPttStatus) btPttStatus.textContent = text;
  }

  function btPttToggle() {
    if (!pttDown) pttStart(); else pttStop();
  }

  function btPttStart() {
    if (btPttEnabled) return;
    btPttEnabled = true;
    if (btPttBtn) { btPttBtn.textContent = 'On'; btPttBtn.classList.add('active'); }

    // --- Method 1: Silent audio loop for media session ---
    // Android Chrome needs an active media session to deliver BT headset events.
    // (Does NOT work on iOS — HFP TALK is consumed by CallKit at the system level.)
    if (!btPttAudioEl) {
      btPttAudioEl = document.createElement('audio');
      btPttAudioEl.loop = true;
      btPttAudioEl.volume = 0.01;
      // Tiny silent WAV
      btPttAudioEl.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAABCxAgABAAgAZGF0YQAAAAA=';
      btPttAudioEl.addEventListener('pause', function() {
        if (!btPttEnabled) return;
        btPttUpdateStatus('BT: audio pause');
        btPttToggle();
        setTimeout(function() { if (btPttEnabled && btPttAudioEl) btPttAudioEl.play().catch(function(){}); }, 200);
      });
    }
    btPttAudioEl.play().catch(function() {
      // Autoplay blocked — retry on touch
      document.addEventListener('touchstart', function retry() {
        if (btPttEnabled && btPttAudioEl) btPttAudioEl.play().catch(function(){});
        document.removeEventListener('touchstart', retry);
      }, { once: true });
    });

    // --- Method 2: Media Session API ---
    // Android Chrome translates BT headset buttons to media session actions
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'ECHOCAT PTT', artist: 'POTACAT' });
        ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'].forEach(function(action) {
          try {
            navigator.mediaSession.setActionHandler(action, function() {
              if (!btPttEnabled) return;
              btPttUpdateStatus('BT: ' + action);
              btPttToggle();
              if (btPttAudioEl) btPttAudioEl.play().catch(function(){});
            });
          } catch(e) {}
        });
      } catch(e) {}
    }

    // --- Method 3: Keyboard media key events ---
    // Android translates BT HFP buttons to KEYCODE_MEDIA_PLAY_PAUSE → 'MediaPlayPause'
    document.addEventListener('keydown', btPttKeyHandler);

    btPttUpdateStatus('Listening...');
    console.log('[BT PTT] Enabled — media session + keyboard listeners active');
  }

  function btPttKeyHandler(e) {
    if (!btPttEnabled) return;
    var mediaKeys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
      'MediaTrackNext', 'MediaTrackPrevious', 'HeadsetHook'];
    if (mediaKeys.indexOf(e.code) >= 0 || mediaKeys.indexOf(e.key) >= 0) {
      e.preventDefault();
      btPttUpdateStatus('BT key: ' + (e.code || e.key));
      btPttToggle();
    }
  }

  function btPttStop() {
    btPttEnabled = false;
    if (btPttBtn) { btPttBtn.textContent = 'Off'; btPttBtn.classList.remove('active'); }
    if (btPttAudioEl) {
      btPttAudioEl.pause();
      btPttAudioEl.src = '';
      btPttAudioEl = null;
    }
    if ('mediaSession' in navigator) {
      ['play','pause','stop','nexttrack','previoustrack'].forEach(function(a) {
        try { navigator.mediaSession.setActionHandler(a, null); } catch(e){}
      });
    }
    document.removeEventListener('keydown', btPttKeyHandler);
    btPttUpdateStatus('');
    console.log('[BT PTT] Disabled');
  }

  if (btPttBtn) {
    btPttBtn.addEventListener('click', function() {
      if (btPttEnabled) btPttStop(); else btPttStart();
    });
  }

  estopBtn.addEventListener('click', () => {
    if (typeof ssbPlayingIdx !== 'undefined' && ssbPlayingIdx >= 0) stopSsbPlayback();
    pttDown = false;
    pttBtn.classList.remove('active');
    txBanner.classList.add('hidden');
    muteRxAudio(false);
    if (localAudioStream) localAudioStream.getAudioTracks().forEach(t => { t.enabled = false; });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'estop' }));
    }
  });

  // --- Earbud/headset PTT (Media Session API + MediaPlayPause key) ---
  // Supports Bluetooth (Pixel Buds, AirPods) and wired earbuds with play/pause button.
  // Toggle PTT: press to start transmitting, press again to stop.

  // Create a silent audio loop to reliably anchor the Media Session.
  // WebRTC <video> elements are unreliable as session anchors — iOS can pause them
  // and Android wired earbuds may not recognize them as active media.
  function startSessionKeepAlive() {
    if (sessionKeepAlive) return;
    // Build a minimal silent WAV in memory (0.25s, 8kHz, mono, 8-bit unsigned PCM)
    const numSamples = 2000;
    const buf = new ArrayBuffer(44 + numSamples);
    const v = new DataView(buf);
    // RIFF header
    v.setUint32(0, 0x52494646, false); v.setUint32(4, 36 + numSamples, true);
    v.setUint32(8, 0x57415645, false);
    // fmt chunk
    v.setUint32(12, 0x666d7420, false); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    // data chunk — 128 = silence for unsigned 8-bit PCM
    v.setUint32(36, 0x64617461, false); v.setUint32(40, numSamples, true);
    for (let i = 44; i < 44 + numSamples; i++) v.setUint8(i, 128);
    const blob = new Blob([buf], { type: 'audio/wav' });
    sessionKeepAlive = new Audio(URL.createObjectURL(blob));
    sessionKeepAlive.loop = true;
    sessionKeepAlive.volume = 0.01;
    sessionKeepAlive.play().catch(() => {});
  }

  function stopSessionKeepAlive() {
    if (!sessionKeepAlive) return;
    sessionKeepAlive.pause();
    if (sessionKeepAlive.src) URL.revokeObjectURL(sessionKeepAlive.src);
    sessionKeepAlive = null;
  }

  function mediaTogglePtt() {
    if (!audioEnabled) return;
    if (pttDown) pttStop(); else pttStart();
    // Re-assert playing state so the next button press fires again
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    if (sessionKeepAlive) sessionKeepAlive.play().catch(() => {});
  }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('pause', mediaTogglePtt);
    navigator.mediaSession.setActionHandler('play', mediaTogglePtt);
    // Some devices/OS versions fire 'stop' instead of 'pause'
    try { navigator.mediaSession.setActionHandler('stop', mediaTogglePtt); } catch (_) {}
  }

  // Wired earbud play/pause button — fires as a keyboard event on Android
  document.addEventListener('keydown', (e) => {
    if (e.key === 'MediaPlayPause') { e.preventDefault(); mediaTogglePtt(); }
  });

  // --- Settings Overlay ---
  rigCtrlToggle.addEventListener('click', () => {
    settingsOverlay.classList.remove('hidden');
    requestAudioDevices(); // refresh device list when settings opens
  });

  soClose.addEventListener('click', () => {
    settingsOverlay.classList.add('hidden');
  });

  // --- Mode Picker ---
  modeBadge.classList.add('tappable');
  modeBadge.addEventListener('click', () => {
    if (modePicker.classList.contains('hidden')) {
      // Highlight current mode
      modePicker.querySelectorAll('.mp-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === currentMode);
      });
      modePicker.classList.remove('hidden');
    } else {
      modePicker.classList.add('hidden');
    }
  });

  modePicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.mp-btn');
    if (!btn) return;
    const newMode = btn.dataset.mode;
    if (newMode === currentMode) {
      modePicker.classList.add('hidden');
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-mode', mode: newMode }));
    }
    modePicker.classList.add('hidden');
  });

  // Close mode picker on outside tap
  document.addEventListener('click', (e) => {
    if (!modePicker.classList.contains('hidden') &&
        !modePicker.contains(e.target) &&
        e.target !== modeBadge) {
      modePicker.classList.add('hidden');
    }
  });

  // --- Settings Overlay Steppers ---
  const DWELL_PRESETS = [3, 5, 7, 10, 15, 20, 30];
  soDwellDn.addEventListener('click', () => {
    const idx = DWELL_PRESETS.indexOf(scanDwell);
    if (idx > 0) scanDwell = DWELL_PRESETS[idx - 1];
    else if (idx === -1) scanDwell = DWELL_PRESETS[DWELL_PRESETS.length - 1];
    soDwellVal.textContent = scanDwell + 's';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-scan-dwell', value: scanDwell }));
    }
  });
  soDwellUp.addEventListener('click', () => {
    const idx = DWELL_PRESETS.indexOf(scanDwell);
    if (idx < DWELL_PRESETS.length - 1) scanDwell = DWELL_PRESETS[idx + 1];
    else if (idx === -1) scanDwell = DWELL_PRESETS[0];
    soDwellVal.textContent = scanDwell + 's';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-scan-dwell', value: scanDwell }));
    }
  });

  const REFRESH_PRESETS = [15, 30, 60, 120];
  soRefreshDn.addEventListener('click', () => {
    const idx = REFRESH_PRESETS.indexOf(refreshInterval);
    if (idx > 0) refreshInterval = REFRESH_PRESETS[idx - 1];
    soRefreshVal.textContent = refreshInterval + 's';
    refreshRateBtn.textContent = refreshInterval + 's';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-refresh-interval', value: refreshInterval }));
    }
  });
  soRefreshUp.addEventListener('click', () => {
    const idx = REFRESH_PRESETS.indexOf(refreshInterval);
    if (idx < REFRESH_PRESETS.length - 1) refreshInterval = REFRESH_PRESETS[idx + 1];
    soRefreshVal.textContent = refreshInterval + 's';
    refreshRateBtn.textContent = refreshInterval + 's';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-refresh-interval', value: refreshInterval }));
    }
  });

  const MAXAGE_PRESETS = [1, 2, 3, 5, 10, 15, 30, 60];
  soMaxageDn.addEventListener('click', () => {
    const idx = MAXAGE_PRESETS.indexOf(maxAgeMin);
    if (idx > 0) maxAgeMin = MAXAGE_PRESETS[idx - 1];
    else if (idx === -1) maxAgeMin = MAXAGE_PRESETS[MAXAGE_PRESETS.length - 1];
    soMaxageVal.textContent = maxAgeMin + 'm';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-max-age', value: maxAgeMin }));
    }
  });
  soMaxageUp.addEventListener('click', () => {
    const idx = MAXAGE_PRESETS.indexOf(maxAgeMin);
    if (idx < MAXAGE_PRESETS.length - 1) maxAgeMin = MAXAGE_PRESETS[idx + 1];
    else if (idx === -1) maxAgeMin = MAXAGE_PRESETS[0];
    soMaxageVal.textContent = maxAgeMin + 'm';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-max-age', value: maxAgeMin }));
    }
  });

  // Distance unit toggle
  soDistMi.addEventListener('click', () => {
    distUnit = 'mi';
    soDistMi.classList.add('active');
    soDistKm.classList.remove('active');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-dist-unit', value: 'mi' }));
    }
  });
  soDistKm.addEventListener('click', () => {
    distUnit = 'km';
    soDistKm.classList.add('active');
    soDistMi.classList.remove('active');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-dist-unit', value: 'km' }));
    }
  });

  // --- Tuning Settings Steppers & Toggles ---
  function syncTuningUI() {
    soXitVal.textContent = cwXit;
    soCwFiltVal.textContent = cwFilterWidth;
    soSsbFiltVal.textContent = ssbFilterWidth;
    soDigFiltVal.textContent = digitalFilterWidth;
    soSplitBtn.classList.toggle('active', enableSplit);
    soAtuAutoBtn.classList.toggle('active', enableAtu);
    soTuneClickBtn.classList.toggle('active', tuneClick);
  }

  function sendSetting(type, value) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: type, value: value }));
    }
  }

  soXitDn.addEventListener('click', () => {
    cwXit = Math.max(-999, cwXit - 10);
    soXitVal.textContent = cwXit;
    sendSetting('set-cw-xit', cwXit);
  });
  soXitUp.addEventListener('click', () => {
    cwXit = Math.min(999, cwXit + 10);
    soXitVal.textContent = cwXit;
    sendSetting('set-cw-xit', cwXit);
  });

  const CW_FILT_PRESETS = [0, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000];
  soCwFiltDn.addEventListener('click', () => {
    const idx = CW_FILT_PRESETS.indexOf(cwFilterWidth);
    if (idx > 0) cwFilterWidth = CW_FILT_PRESETS[idx - 1];
    else if (idx === -1) cwFilterWidth = CW_FILT_PRESETS[CW_FILT_PRESETS.length - 1];
    soCwFiltVal.textContent = cwFilterWidth;
    sendSetting('set-cw-filter', cwFilterWidth);
  });
  soCwFiltUp.addEventListener('click', () => {
    const idx = CW_FILT_PRESETS.indexOf(cwFilterWidth);
    if (idx < CW_FILT_PRESETS.length - 1) cwFilterWidth = CW_FILT_PRESETS[idx + 1];
    else if (idx === -1) cwFilterWidth = CW_FILT_PRESETS[0];
    soCwFiltVal.textContent = cwFilterWidth;
    sendSetting('set-cw-filter', cwFilterWidth);
  });

  const SSB_FILT_PRESETS = [0, 1000, 1500, 1800, 2000, 2200, 2400, 2700, 3000, 3500, 4000];
  soSsbFiltDn.addEventListener('click', () => {
    const idx = SSB_FILT_PRESETS.indexOf(ssbFilterWidth);
    if (idx > 0) ssbFilterWidth = SSB_FILT_PRESETS[idx - 1];
    else if (idx === -1) ssbFilterWidth = SSB_FILT_PRESETS[SSB_FILT_PRESETS.length - 1];
    soSsbFiltVal.textContent = ssbFilterWidth;
    sendSetting('set-ssb-filter', ssbFilterWidth);
  });
  soSsbFiltUp.addEventListener('click', () => {
    const idx = SSB_FILT_PRESETS.indexOf(ssbFilterWidth);
    if (idx < SSB_FILT_PRESETS.length - 1) ssbFilterWidth = SSB_FILT_PRESETS[idx + 1];
    else if (idx === -1) ssbFilterWidth = SSB_FILT_PRESETS[0];
    soSsbFiltVal.textContent = ssbFilterWidth;
    sendSetting('set-ssb-filter', ssbFilterWidth);
  });

  const DIGI_FILT_PRESETS = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000];
  soDigFiltDn.addEventListener('click', () => {
    const idx = DIGI_FILT_PRESETS.indexOf(digitalFilterWidth);
    if (idx > 0) digitalFilterWidth = DIGI_FILT_PRESETS[idx - 1];
    else if (idx === -1) digitalFilterWidth = DIGI_FILT_PRESETS[DIGI_FILT_PRESETS.length - 1];
    soDigFiltVal.textContent = digitalFilterWidth;
    sendSetting('set-digital-filter', digitalFilterWidth);
  });
  soDigFiltUp.addEventListener('click', () => {
    const idx = DIGI_FILT_PRESETS.indexOf(digitalFilterWidth);
    if (idx < DIGI_FILT_PRESETS.length - 1) digitalFilterWidth = DIGI_FILT_PRESETS[idx + 1];
    else if (idx === -1) digitalFilterWidth = DIGI_FILT_PRESETS[0];
    soDigFiltVal.textContent = digitalFilterWidth;
    sendSetting('set-digital-filter', digitalFilterWidth);
  });

  soSplitBtn.addEventListener('click', () => {
    enableSplit = !enableSplit;
    soSplitBtn.classList.toggle('active', enableSplit);
    sendSetting('set-enable-split', enableSplit);
  });

  soAtuAutoBtn.addEventListener('click', () => {
    enableAtu = !enableAtu;
    soAtuAutoBtn.classList.toggle('active', enableAtu);
    sendSetting('set-enable-atu', enableAtu);
  });

  soTuneClickBtn.addEventListener('click', () => {
    tuneClick = !tuneClick;
    soTuneClickBtn.classList.toggle('active', tuneClick);
    sendSetting('set-tune-click', tuneClick);
  });

  rcBwDn.addEventListener('click', () => {
    if (txState) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'filter-step', direction: 'narrower' }));
    }
  });

  rcBwUp.addEventListener('click', () => {
    if (txState) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'filter-step', direction: 'wider' }));
    }
  });

  rcNbBtn.addEventListener('click', () => {
    if (txState) return;
    const newState = !currentNb;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-nb', on: newState }));
    }
  });

  rcAtuBtn.addEventListener('click', () => {
    if (txState) return;
    const newState = !currentAtu;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-atu', on: newState }));
    }
  });

  document.getElementById('rc-power-on').addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'rig-control', data: { action: 'power-on' } }));
    }
  });

  document.getElementById('rc-power-off').addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'rig-control', data: { action: 'power-off' } }));
    }
  });

  // --- Custom CAT Buttons ---
  var customCatSection = document.getElementById('rc-custom-cat');
  var customCatBtnsEl = document.getElementById('rc-custom-cat-btns');
  // --- TunerGenius 1x3 antenna buttons ---
  var echoTgxlSection = document.getElementById('echo-tgxl-section');
  var echoTgxlBtns = document.getElementById('echo-tgxl-btns');
  var echoTgxlActiveAnt = 0;

  function echoTgxlUpdateButtons(activeAnt, labels) {
    echoTgxlActiveAnt = activeAnt;
    echoTgxlBtns.querySelectorAll('.echo-tgxl-btn').forEach(function(btn) {
      var ant = parseInt(btn.dataset.ant, 10);
      if (labels && labels[ant]) btn.textContent = labels[ant];
      var isActive = ant === activeAnt;
      btn.style.background = isActive ? '#2a6e4e' : 'var(--bg)';
      btn.style.color = isActive ? '#fff' : 'var(--text)';
      btn.style.borderColor = isActive ? '#2a6e4e' : '#555';
    });
  }

  echoTgxlBtns.addEventListener('click', function(e) {
    var btn = e.target.closest('.echo-tgxl-btn');
    if (!btn || !ws || ws.readyState !== WebSocket.OPEN) return;
    var ant = parseInt(btn.dataset.ant, 10);
    ws.send(JSON.stringify({ type: 'tgxl-select-antenna', port: ant }));
    echoTgxlUpdateButtons(ant); // optimistic
  });

  var customCatEditBtn = document.getElementById('rc-custom-cat-edit');
  var customCatData = [];
  var customCatEditing = false;

  function loadCustomCatButtons(buttons) {
    if (!buttons || !Array.isArray(buttons)) return;
    customCatData = buttons;
    while (customCatData.length < 5) customCatData.push({ name: '', command: '' });
    renderCustomCatButtons();
  }

  function renderCustomCatButtons() {
    customCatBtnsEl.innerHTML = '';
    var hasAny = false;
    for (var i = 0; i < customCatData.length; i++) {
      var entry = customCatData[i];
      if (!entry.name && !entry.command) continue;
      hasAny = true;
      var btn = document.createElement('button');
      btn.className = 'rc-custom-cat-btn';
      btn.textContent = entry.name || ('CAT ' + (i + 1));
      btn.dataset.idx = i;
      btn.addEventListener('click', function() {
        var idx = parseInt(this.dataset.idx);
        var cmd = customCatData[idx] && customCatData[idx].command;
        if (!cmd || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'rig-control', data: { action: 'send-custom-cat', command: cmd } }));
        this.classList.add('sent');
        var b = this;
        setTimeout(function() { b.classList.remove('sent'); }, 300);
      });
      customCatBtnsEl.appendChild(btn);
    }
    // Always show section — Edit button allows creating buttons from ECHOCAT
    // Re-render editor if open
    if (customCatEditing) renderCustomCatEditor();
  }

  function renderCustomCatEditor() {
    var existing = customCatSection.querySelector('.rc-custom-cat-editor');
    if (existing) existing.remove();
    var editor = document.createElement('div');
    editor.className = 'rc-custom-cat-editor';
    for (var i = 0; i < 5; i++) {
      var row = document.createElement('div');
      row.className = 'rc-custom-cat-editor-row';
      row.dataset.idx = i;
      var nameInput = document.createElement('input');
      nameInput.className = 'cce-name';
      nameInput.placeholder = 'Label';
      nameInput.maxLength = 12;
      nameInput.value = customCatData[i] ? customCatData[i].name || '' : '';
      var cmdInput = document.createElement('input');
      cmdInput.className = 'cce-cmd';
      cmdInput.placeholder = 'CAT command';
      cmdInput.maxLength = 64;
      cmdInput.value = customCatData[i] ? customCatData[i].command || '' : '';
      row.appendChild(nameInput);
      row.appendChild(cmdInput);
      editor.appendChild(row);
    }
    customCatSection.appendChild(editor);
    // Auto-save on blur
    editor.addEventListener('focusout', function() {
      for (var j = 0; j < 5; j++) {
        var r = editor.querySelectorAll('.rc-custom-cat-editor-row')[j];
        if (!r) continue;
        customCatData[j] = {
          name: r.querySelector('.cce-name').value.trim(),
          command: r.querySelector('.cce-cmd').value.trim(),
        };
      }
      renderCustomCatButtons();
      // Save back to POTACAT
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'save-custom-cat-buttons', buttons: customCatData }));
      }
    });
  }

  customCatEditBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    customCatEditing = !customCatEditing;
    customCatEditBtn.textContent = customCatEditing ? 'Done' : 'Edit';
    customCatSection.classList.remove('hidden');
    if (customCatEditing) {
      renderCustomCatEditor();
    } else {
      var existing = customCatSection.querySelector('.rc-custom-cat-editor');
      if (existing) existing.remove();
      renderCustomCatButtons();
    }
  });

  rcVfoA.addEventListener('click', () => {
    if (txState) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-vfo', vfo: 'A' }));
    }
  });

  rcVfoB.addEventListener('click', () => {
    if (txState) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-vfo', vfo: 'B' }));
    }
  });

  rcVfoSwap.addEventListener('click', () => {
    if (txState) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'swap-vfo' }));
    }
  });

  // RF Gain slider
  rcRfGainSlider.addEventListener('input', () => {
    rcRfGainVal.textContent = rcRfGainSlider.value;
  });
  rcRfGainSlider.addEventListener('change', () => {
    if (txState) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-rfgain', value: parseInt(rcRfGainSlider.value) }));
    }
  });

  // TX Power slider
  rcTxPowerSlider.addEventListener('input', () => {
    rcTxPowerVal.textContent = rcTxPowerSlider.value;
  });
  rcTxPowerSlider.addEventListener('change', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-txpower', value: parseInt(rcTxPowerSlider.value) }));
    }
  });

  // --- Audio Device Selection ---
  var rcAudioInput = document.getElementById('rc-audio-input');
  var rcAudioOutput = document.getElementById('rc-audio-output');
  var rcAudioRefresh = document.getElementById('rc-audio-refresh');

  function requestAudioDevices() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'get-audio-devices' }));
    }
  }

  function populateAudioDevices(devices, current) {
    rcAudioInput.innerHTML = '<option value="">(System Default)</option>';
    rcAudioOutput.innerHTML = '<option value="">(System Default)</option>';
    (devices || []).forEach(function(d) {
      var opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || d.deviceId.slice(0, 25);
      if (d.kind === 'audioinput') rcAudioInput.appendChild(opt);
      else if (d.kind === 'audiooutput') rcAudioOutput.appendChild(opt);
    });
    if (current) {
      rcAudioInput.value = current.input || '';
      rcAudioOutput.value = current.output || '';
    }
  }

  rcAudioInput.addEventListener('change', function() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-audio-device', kind: 'input', deviceId: rcAudioInput.value }));
    }
  });
  rcAudioOutput.addEventListener('change', function() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-audio-device', kind: 'output', deviceId: rcAudioOutput.value }));
    }
  });
  rcAudioRefresh.addEventListener('click', requestAudioDevices);

  // --- ECHOCAT S-Meter / SWR display ---
  var echoMeterStrip = document.getElementById('echo-meter-strip');
  var echoSmeterBar = document.getElementById('echo-smeter-bar');
  var echoSmeterText = document.getElementById('echo-smeter-text');
  var echoSwrBar = document.getElementById('echo-swr-bar');
  var echoSwrText = document.getElementById('echo-swr-text');
  var echoShowMeter = document.getElementById('echo-show-meter');
  var echoMeterEnabled = localStorage.getItem('echoMeterEnabled') === 'true';

  echoShowMeter.checked = echoMeterEnabled;
  if (echoMeterEnabled) echoMeterStrip.classList.remove('hidden');

  echoShowMeter.addEventListener('change', function() {
    echoMeterEnabled = echoShowMeter.checked;
    localStorage.setItem('echoMeterEnabled', echoMeterEnabled);
    echoMeterStrip.classList.toggle('hidden', !echoMeterEnabled);
  });

  // FreeDV toggle — sends setting to desktop
  var echoFreedvCb = document.getElementById('echo-enable-freedv');
  if (echoFreedvCb) {
    echoFreedvCb.addEventListener('change', function() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set-freedv', enabled: echoFreedvCb.checked }));
      }
    });
  }

  // FreeDV squelch slider
  var echoFreedvSquelch = document.getElementById('echo-freedv-squelch');
  var echoFreedvSquelchVal = document.getElementById('echo-freedv-squelch-val');
  if (echoFreedvSquelch) {
    echoFreedvSquelch.addEventListener('input', function() {
      var val = parseInt(echoFreedvSquelch.value, 10);
      echoFreedvSquelchVal.textContent = val + ' dB';
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'freedv-set-squelch', enabled: true, threshold: val }));
      }
    });
  }

  // Spot column order + toggles — dynamic list with up/down buttons
  var colLabels = { freq: 'Freq', mode: 'Mode', band: 'Band', dist: 'Dist', ref: 'Ref/Park', name: 'Name', region: 'Region', src: 'Source', age: 'Age', skip: 'Skip', log: 'Log' };
  function buildColOrderUI() {
    var container = document.getElementById('col-order-list');
    if (!container) return;
    container.innerHTML = '';
    colOrder.forEach(function(key, idx) {
      var row = document.createElement('div');
      row.className = 'col-order-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = colShow[key];
      cb.addEventListener('change', function() {
        colShow[key] = cb.checked;
        saveColPrefs();
        renderSpots();
      });
      var label = document.createElement('span');
      label.className = 'col-order-label';
      label.textContent = colLabels[key] || key;
      var upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'col-order-btn';
      upBtn.textContent = '\u25B2';
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', function() {
        if (idx > 0) { colOrder.splice(idx, 1); colOrder.splice(idx - 1, 0, key); saveColPrefs(); renderSpots(); buildColOrderUI(); }
      });
      var downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'col-order-btn';
      downBtn.textContent = '\u25BC';
      downBtn.disabled = idx === colOrder.length - 1;
      downBtn.addEventListener('click', function() {
        if (idx < colOrder.length - 1) { colOrder.splice(idx, 1); colOrder.splice(idx + 1, 0, key); saveColPrefs(); renderSpots(); buildColOrderUI(); }
      });
      row.appendChild(cb);
      row.appendChild(label);
      row.appendChild(upBtn);
      row.appendChild(downBtn);
      container.appendChild(row);
    });
  }
  buildColOrderUI();

  function drawEchoBar(canvas, level, color) {
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, Math.round(Math.max(0, Math.min(1, level)) * w), h);
  }

  function updateEchoSmeter(val) {
    if (!echoMeterEnabled) return;
    echoMeterStrip.classList.remove('hidden');
    var level = val / 255;
    var color = val < 80 ? '#4ecca3' : val < 160 ? '#ffd740' : '#e94560';
    drawEchoBar(echoSmeterBar, level, color);
    if (val <= 120) {
      echoSmeterText.textContent = 'S' + Math.round(val * 9 / 120);
    } else {
      echoSmeterText.textContent = 'S9+' + Math.round((val - 120) * 60 / 135);
    }
    echoSmeterText.style.color = color;
  }

  function updateEchoSwr(val) {
    if (!echoMeterEnabled || val <= 0) return;
    var swr = 1.0 + (val / 60);
    var level = Math.min(1, (swr - 1) / 4);
    var color = swr <= 1.5 ? '#4ecca3' : swr <= 2.0 ? '#ffd740' : swr <= 3.0 ? '#f0a500' : '#e94560';
    drawEchoBar(echoSwrBar, level, color);
    echoSwrText.textContent = swr < 10 ? swr.toFixed(1) : '>10';
    echoSwrText.style.color = color;
  }

  function updateEchoSwrRatio(swr) {
    if (!echoMeterEnabled) return;
    var level = Math.min(1, (swr - 1) / 4);
    var color = swr <= 1.5 ? '#4ecca3' : swr <= 2.0 ? '#ffd740' : swr <= 3.0 ? '#f0a500' : '#e94560';
    drawEchoBar(echoSwrBar, level, color);
    echoSwrText.textContent = swr < 10 ? swr.toFixed(1) : '>10';
    echoSwrText.style.color = color;
  }

  // --- Audio Level Meters & Gain Controls ---
  var rxMeterCanvas = document.getElementById('rx-meter');
  var txMeterCanvas = document.getElementById('tx-meter');
  var rcRxGain = document.getElementById('rc-rx-gain');
  var rcRxGainVal = document.getElementById('rc-rx-gain-val');
  var rcTxGain = document.getElementById('rc-tx-gain');
  var rcTxGainVal = document.getElementById('rc-tx-gain-val');

  rcRxGain.addEventListener('input', function() {
    var pct = parseInt(rcRxGain.value, 10);
    rcRxGainVal.textContent = pct + '%';
    if (gainNode) gainNode.gain.value = pct / 100;
  });
  rcTxGain.addEventListener('input', function() {
    var pct = parseInt(rcTxGain.value, 10);
    rcTxGainVal.textContent = pct + '%';
    if (txGainNode) txGainNode.gain.value = pct / 100;
  });

  function drawMeter(canvas, analyser) {
    if (!canvas || !analyser) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    // Calculate RMS level
    var sum = 0;
    for (var i = 0; i < data.length; i++) {
      var v = (data[i] - 128) / 128;
      sum += v * v;
    }
    var rms = Math.sqrt(sum / data.length);
    var db = rms > 0 ? 20 * Math.log10(rms) : -60;
    var level = Math.max(0, Math.min(1, (db + 40) / 40)); // -40dB to 0dB → 0-1
    // Draw bar
    ctx.clearRect(0, 0, w, h);
    var barW = Math.round(level * w);
    // Green → yellow → red gradient
    if (level < 0.6) ctx.fillStyle = '#4ecca3';
    else if (level < 0.85) ctx.fillStyle = '#ffd740';
    else ctx.fillStyle = '#e94560';
    ctx.fillRect(0, 0, barW, h);
    // Peak line
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(barW - 1, 0, 1, h);
  }

  function startMeterRendering() {
    if (meterAnimFrame) return;
    function renderMeters() {
      drawMeter(rxMeterCanvas, rxAnalyser);
      drawMeter(txMeterCanvas, txAnalyser);
      meterAnimFrame = requestAnimationFrame(renderMeters);
    }
    meterAnimFrame = requestAnimationFrame(renderMeters);
  }

  function stopMeterRendering() {
    if (meterAnimFrame) { cancelAnimationFrame(meterAnimFrame); meterAnimFrame = null; }
    // Clear meters
    if (rxMeterCanvas) rxMeterCanvas.getContext('2d').clearRect(0, 0, rxMeterCanvas.width, rxMeterCanvas.height);
    if (txMeterCanvas) txMeterCanvas.getContext('2d').clearRect(0, 0, txMeterCanvas.width, txMeterCanvas.height);
  }

  // --- Audio (WebRTC) ---
  const audioConnectBtn = document.getElementById('audio-connect-btn');
  const bbControls = document.getElementById('bb-controls');

  function showAudioControls() {
    audioConnectBtn.classList.add('hidden');
    bbControls.classList.remove('hidden');
    if (typeof smEnabled !== 'undefined' && smEnabled) document.getElementById('speakermic-btn').classList.remove('hidden');
    if (typeof kiwiRxEnabled !== 'undefined' && kiwiRxEnabled) kiwiUpdateSdrBtn();
  }
  function showConnectPrompt() {
    audioConnectBtn.textContent = 'Tap to Connect Audio';
    audioConnectBtn.classList.remove('hidden');
    bbControls.classList.add('hidden');
    document.getElementById('speakermic-btn').classList.add('hidden');
    if (kiwiSdrBtn) kiwiSdrBtn.classList.add('hidden');
  }

  audioConnectBtn.addEventListener('click', async () => {
    audioConnectBtn.textContent = 'Connecting...';
    await startAudio();
    // First startAudio() gets mic permission; second connects WebRTC
    if (micReady && !audioEnabled) {
      await startAudio();
    }
    if (!audioEnabled) {
      audioConnectBtn.textContent = 'Tap to Connect Audio';
    }
  });

  audioBtn.addEventListener('click', async () => {
    if (audioEnabled) {
      stopAudio();
    } else {
      await startAudio();
      if (micReady && !audioEnabled) {
        await startAudio();
      }
    }
  });

  function setAudioStatus(text) { audioBtn.textContent = text; }

  let micReady = false;
  var _useStun = false;

  async function startAudio() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!micReady) {
      try {
        setAudioStatus('Mic...');
        localAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        remoteAudio = document.getElementById('remote-audio');
        remoteAudio.srcObject = new MediaStream();
        remoteAudio.muted = false;
        await remoteAudio.play().catch(() => {});
        // Create AudioContext during user gesture so iOS Safari doesn't block it
        try {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          // RX chain: source → gainNode → rxAnalyser → destination
          gainNode = audioCtx.createGain();
          gainNode.gain.value = VOL_STEPS[volBoostLevel];
          rxAnalyser = audioCtx.createAnalyser();
          rxAnalyser.fftSize = 256;
          gainNode.connect(rxAnalyser);
          rxAnalyser.connect(audioCtx.destination);
          // TX chain: mic → txGainNode → txAnalyser (metering only, audio sent via WebRTC track)
          txGainNode = audioCtx.createGain();
          txGainNode.gain.value = 1.0;
          txAnalyser = audioCtx.createAnalyser();
          txAnalyser.fftSize = 256;
          var micSource = audioCtx.createMediaStreamSource(localAudioStream);
          micSource.connect(txGainNode);
          txGainNode.connect(txAnalyser);
          // Don't connect txAnalyser to destination — we don't want sidetone
          startMeterRendering();
        } catch (e) {
          console.warn('Web Audio API unavailable:', e.message);
        }
        // Mute mic by default — only unmute during PTT to prevent VOX/feedback TX cycling
        localAudioStream.getAudioTracks().forEach(t => { t.enabled = false; });
        micReady = true;
      } catch (err) {
        console.error('Audio error:', err);
        setAudioStatus('Audio');
        if (!navigator.mediaDevices) {
          alert('Audio requires HTTPS. Connect via https:// not http://');
        } else {
          alert('Could not access microphone: ' + err.message);
        }
        return;
      }
    }
    try {
      setAudioStatus('Wait...');
      var iceServers = _useStun ? [{ urls: 'stun:stun.l.google.com:19302' }] : [];
      pc = new RTCPeerConnection({ iceServers: iceServers });
      for (const track of localAudioStream.getTracks()) {
        pc.addTrack(track, localAudioStream);
      }
      pc.ontrack = (event) => {
        setAudioStatus('Live');
        // Route through pre-created GainNode for volume boost
        if (audioCtx && gainNode) {
          try {
            var source = audioCtx.createMediaStreamSource(event.streams[0]);
            source.connect(gainNode);
            // Keep video element playing (muted) as iOS keep-alive
            remoteAudio.srcObject = event.streams[0];
            remoteAudio.volume = 0;
            remoteAudio.play().catch(() => {});
          } catch (e) {
            console.warn('GainNode wiring failed, using direct playback:', e.message);
            remoteAudio.srcObject = event.streams[0];
            remoteAudio.volume = 1.0;
            remoteAudio.muted = false;
            remoteAudio.play().catch(() => {});
          }
        } else {
          // Fallback: no Web Audio, play through element directly
          remoteAudio.srcObject = event.streams[0];
          remoteAudio.volume = 1.0;
          remoteAudio.muted = false;
          remoteAudio.play().catch(() => {});
        }
        if (typeof smConnected !== 'undefined' && smConnected) smSetupRxBridge(event.streams[0]);
      };
      pc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'signal', data: { type: 'ice', candidate: event.candidate } }));
        }
      };
      pc.onconnectionstatechange = () => {
        const state = pc ? pc.connectionState : 'closed';
        audioDot.classList.toggle('connected', state === 'connected');
        if (state === 'connected') setAudioStatus('Live');
        else if (state === 'failed' || state === 'disconnected') stopAudio();
      };
      ws.send(JSON.stringify({ type: 'signal', data: { type: 'start-audio' } }));
      audioEnabled = true;
      audioBtn.classList.add('active');
      audioDot.classList.remove('hidden');
      volBoostBtn.classList.remove('hidden');
      showAudioControls();
      updateSsbPanelVisibility();
      // Activate Media Session so earbud play/pause button works for PTT
      startSessionKeepAlive();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'ECHOCAT', artist: 'POTACAT' });
        navigator.mediaSession.playbackState = 'playing';
      }
    } catch (err) {
      console.error('Audio error:', err);
      setAudioStatus('Error');
    }
  }

  function stopAudio() {
    if (ssbPlayingIdx >= 0) stopSsbPlayback();
    if (typeof smCleanupAudio === 'function') smCleanupAudio();
    if (pc) { pc.close(); pc = null; }
    if (localAudioStream) { localAudioStream.getTracks().forEach(t => t.stop()); localAudioStream = null; }
    if (remoteAudio) { remoteAudio.srcObject = null; }
    stopMeterRendering();
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; gainNode = null; txGainNode = null; rxAnalyser = null; txAnalyser = null; }
    stopSessionKeepAlive();
    audioEnabled = false;
    micReady = false;
    volBoostLevel = 0;
    audioBtn.classList.remove('active');
    volBoostBtn.classList.add('hidden');
    showConnectPrompt();
    volBoostBtn.classList.remove('active');
    volBoostBtn.textContent = 'Vol 1x';
    audioDot.classList.add('hidden');
    audioDot.classList.remove('connected');
    setAudioStatus('Audio');
    updateSsbPanelVisibility();
  }

  async function handleSignal(data) {
    if (!data || !pc) return;
    try {
      if (data.type === 'sdp') {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer' && pc && pc.signalingState === 'have-remote-offer') {
          var answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (pc && ws && ws.readyState === WebSocket.OPEN) {
            // Extract as plain object — RTCSessionDescription getters
            // don't survive JSON.stringify in Firefox/Safari
            ws.send(JSON.stringify({ type: 'signal', data: { type: 'sdp', sdp: {
              type: pc.localDescription.type,
              sdp: pc.localDescription.sdp,
            }}}));
          }
        }
      } else if (data.type === 'ice') {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (err) {
      console.error('WebRTC signal error:', err);
    }
  }

  // --- Volume Boost (cycles 1x → 2x → 3x) ---
  volBoostBtn.addEventListener('click', () => {
    volBoostLevel = (volBoostLevel + 1) % VOL_STEPS.length;
    var gain = VOL_STEPS[volBoostLevel];
    if (gainNode) gainNode.gain.value = gain;
    // iOS AudioContext may start suspended — resume on user gesture
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    volBoostBtn.textContent = 'Vol ' + gain + 'x';
    volBoostBtn.classList.toggle('active', volBoostLevel > 0);
    // Sync RX gain slider
    rcRxGain.value = Math.round(gain * 100);
    rcRxGainVal.textContent = Math.round(gain * 100) + '%';
  });

  // --- Scan ---
  function startScan() {
    const list = getFilteredSpots();
    if (!list.length) return;
    scanning = true;
    scanIndex = 0;
    // Start at the NEXT spot after the current frequency
    if (currentFreqKhz) {
      const match = list.findIndex(s => Math.abs(parseFloat(s.frequency) - currentFreqKhz) < 1);
      if (match !== -1) scanIndex = match + 1;
    }
    if (scanIndex >= list.length) scanIndex = 0;
    scanBtn.textContent = 'Stop';
    scanBtn.classList.add('scan-active');
    scanStep();
  }

  function scanStep() {
    if (!scanning) return;
    const list = getFilteredSpots().filter(function(s) {
      if (scanSkipped.has(s.frequency)) return false;
      var workedToday = isWorkedSpot(s);
      if (workedToday && !scanForceUnskipped.has(s.frequency)) return false;
      return true;
    });
    if (!list.length) { stopScan(); return; }
    if (scanIndex >= list.length) scanIndex = 0;
    const spot = list[scanIndex];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tune', freqKhz: spot.frequency, mode: spot.mode, bearing: spot.bearing ? parseFloat(spot.bearing) : undefined }));
    }
    tunedFreqKhz = spot.frequency;
    currentFreqKhz = parseFloat(spot.frequency);
    if (spot.mode) currentMode = spot.mode;
    renderSpots();
    // Auto-scroll the scanned spot into view
    var tunedCard = spotList.querySelector('.spot-card.tuned');
    if (tunedCard) tunedCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    scanTimer = setTimeout(() => {
      // Skip past spots on the same frequency (dwell once per frequency, not per spot)
      var curFreq = spot.frequency;
      scanIndex++;
      while (scanIndex < list.length && list[scanIndex].frequency === curFreq) scanIndex++;
      scanStep();
    }, scanDwell * 1000);
  }

  function stopScan() {
    scanning = false;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    scanBtn.textContent = 'Scan';
    scanBtn.classList.remove('scan-active');
  }

  scanBtn.addEventListener('click', () => {
    if (scanning) stopScan(); else startScan();
  });

  // --- Refresh Rate (chip tap cycles presets, same as overlay stepper) ---
  refreshRateBtn.addEventListener('click', () => {
    const idx = REFRESH_PRESETS.indexOf(refreshInterval);
    refreshInterval = REFRESH_PRESETS[(idx + 1) % REFRESH_PRESETS.length];
    refreshRateBtn.textContent = refreshInterval + 's';
    soRefreshVal.textContent = refreshInterval + 's';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-refresh-interval', value: refreshInterval }));
    }
  });

  // --- Ping / Latency ---
  function startPing() {
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        lastPingSent = Date.now();
        ws.send(JSON.stringify({ type: 'ping', ts: lastPingSent }));
      }
    }, 3000);
  }

  // --- Reconnect ---
  let noTokenMode = false;
  function scheduleReconnect() {
    if (reconnectTimer) return;
    latencyEl.textContent = '--ms';
    reconnectTimer = setTimeout(function() {
      reconnectTimer = null;
      if (authMode === 'club') {
        var call = clubCallInput.value.trim().toUpperCase();
        var pass = clubPassInput.value;
        if (call && pass) connectClub(call, pass);
      } else {
        connect(storedToken || '');
      }
    }, 3000);
  }

  // --- Log QSO Sheet (hunter mode) ---
  function srcToSig(src) {
    const map = { pota: 'POTA', sota: 'SOTA', wwff: 'WWFF', llota: 'LLOTA' };
    return map[src] || '';
  }

  function defaultRst(mode) {
    const m = (mode || '').toUpperCase();
    if (m === 'CW' || m === 'FT8' || m === 'FT4' || m === 'FT2' || m === 'RTTY') return '599';
    return '59';
  }

  function selectLogType(type) {
    logSelectedType = type;
    document.querySelectorAll('.log-type-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.type === type);
    });
    const hasRef = type && type !== 'dx';
    logRefSection.classList.toggle('hidden', !hasRef);
    // Set placeholder per type — park types hint at comma-separated
    const placeholders = { pota: 'e.g. US-1234 or US-1234, US-5678', sota: 'e.g. W4C/CM-001', wwff: 'e.g. KFF-1234 or KFF-1234, KFF-5678', llota: 'e.g. US-0001 or US-0001, US-0002' };
    logRefInput.placeholder = placeholders[type] || 'Reference';
    updateLogRespot();
  }

  function updateLogRespot() {
    const type = logSelectedType;
    const ref = (logRefInput.value || '').trim().toUpperCase();
    const targets = [];
    if (type === 'pota' && ref && myCallsign) targets.push('pota');
    if (type === 'wwff' && ref && myCallsign) targets.push('wwff');
    if (type === 'llota' && ref) targets.push('llota');
    if ((type === 'dx' || !type) && clusterConnected && myCallsign) targets.push('dxc');

    if (targets.length === 0) {
      logRespotSection.classList.add('hidden');
      return;
    }
    logRespotSection.classList.remove('hidden');
    // Label text
    const labels = { pota: 'Re-spot on POTA', wwff: 'Re-spot on WWFF', llota: 'Re-spot on LLOTA', dxc: 'Spot on DX Cluster' };
    const parts = targets.map(t => labels[t] || t);
    logRespotLabel.innerHTML = '<input type="checkbox" id="log-respot-cb"> ' + parts.join(' + ');
    // Re-acquire checkbox ref since we replaced innerHTML
    const cb = document.getElementById('log-respot-cb');
    cb.checked = respotDefault;
    logRespotCommentWrap.classList.toggle('hidden', !cb.checked);
    cb.addEventListener('change', () => {
      logRespotCommentWrap.classList.toggle('hidden', !cb.checked);
    });
    // Pre-fill comment template
    const tmpl = targets.includes('dxc') ? dxRespotTemplate : respotTemplate;
    const rstVal = logRstSent.value || '59';
    logRespotComment.value = tmpl
      .replace(/\{rst\}/gi, rstVal)
      .replace(/\{QTH\}/gi, phoneGrid || '')
      .replace(/\{mycallsign\}/gi, myCallsign || '');
    // Store targets for submit
    logRespotSection.dataset.targets = targets.join(',');
  }

  // =============================================
  // LOG TAB (standalone full-tab logging form)
  // =============================================

  function refreshLogTabFields() {
    // Pre-fill freq/mode from radio state
    if (currentFreqKhz && !ltFreq.value) {
      ltFreq.value = String(Math.round(currentFreqKhz * 10) / 10);
    }
    if (currentMode && ltMode.value === 'SSB') {
      ltMode.value = currentMode;
    }
    if (!ltRstSent.value) ltRstSent.value = defaultRst(ltMode.value);
    if (!ltRstRcvd.value) ltRstRcvd.value = defaultRst(ltMode.value);
    ltCall.focus();
  }

  function selectLtType(type) {
    ltSelectedType = type;
    document.querySelectorAll('.lt-type-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.type === type);
    });
    const hasRef = type && type !== 'dx';
    ltRefSection.classList.toggle('hidden', !hasRef);
    ltCallHint.classList.toggle('hidden', !hasRef);
    const placeholders = { pota: 'e.g. US-1234 or US-1234, US-5678', sota: 'e.g. W4C/CM-001', wwff: 'e.g. KFF-1234 or KFF-1234, KFF-5678', llota: 'e.g. US-0001 or US-0001, US-0002' };
    ltRefInput.placeholder = placeholders[type] || 'Reference';
    updateLtRespot();
  }

  function updateLtRespot() {
    const type = ltSelectedType;
    const ref = (ltRefInput.value || '').trim().toUpperCase();
    const targets = [];
    if (type === 'pota' && ref && myCallsign) targets.push('pota');
    if (type === 'wwff' && ref && myCallsign) targets.push('wwff');
    if (type === 'llota' && ref) targets.push('llota');
    if ((type === 'dx' || !type) && clusterConnected && myCallsign) targets.push('dxc');

    if (targets.length === 0) {
      ltRespotSection.classList.add('hidden');
      return;
    }
    ltRespotSection.classList.remove('hidden');
    const labels = { pota: 'Re-spot on POTA', wwff: 'Re-spot on WWFF', llota: 'Re-spot on LLOTA', dxc: 'Spot on DX Cluster' };
    const parts = targets.map(t => labels[t] || t);
    ltRespotLabel.innerHTML = '<input type="checkbox" id="lt-respot-cb"> ' + parts.join(' + ');
    const cb = document.getElementById('lt-respot-cb');
    cb.checked = respotDefault;
    ltRespotCommentWrap.classList.toggle('hidden', !cb.checked);
    cb.addEventListener('change', () => {
      ltRespotCommentWrap.classList.toggle('hidden', !cb.checked);
    });
    const tmpl = targets.includes('dxc') ? dxRespotTemplate : respotTemplate;
    const rstVal = ltRstSent.value || '59';
    ltRespotComment.value = tmpl
      .replace(/\{rst\}/gi, rstVal)
      .replace(/\{QTH\}/gi, phoneGrid || '')
      .replace(/\{mycallsign\}/gi, myCallsign || '');
    ltRespotSection.dataset.targets = targets.join(',');
  }

  // Log tab type picker
  document.getElementById('lt-type-picker').addEventListener('click', (e) => {
    const chip = e.target.closest('.lt-type-chip');
    if (!chip) return;
    selectLtType(chip.dataset.type);
  });

  // Log tab ref input → update respot
  ltRefInput.addEventListener('input', updateLtRespot);

  // Log tab mode change → update RST defaults + respot
  ltMode.addEventListener('change', () => {
    const rst = defaultRst(ltMode.value);
    ltRstSent.value = rst;
    ltRstRcvd.value = rst;
    updateLtRespot();
  });

  // Log tab Save button
  ltSave.addEventListener('click', submitLogTab);
  ltCall.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitLogTab(); }
  });

  function submitLogTab() {
    const raw = ltCall.value.trim().toUpperCase();
    const freq = ltFreq.value.trim();
    if (!raw) { ltCall.focus(); return; }
    if (!freq || isNaN(parseFloat(freq))) { ltFreq.focus(); return; }

    // Split comma-separated callsigns (multi-op at same park)
    const calls = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!calls.length) { ltCall.focus(); return; }

    ltSave.disabled = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const typeToSig = { pota: 'POTA', sota: 'SOTA', wwff: 'WWFF', llota: 'LLOTA' };
      const sig = typeToSig[ltSelectedType] || '';
      const rawRef = ltRefInput.value.trim().toUpperCase();
      const refs = rawRef.split(',').map(function (r) { return r.trim(); }).filter(Boolean);
      const typedRef = refs[0] || '';
      const addlRefs = refs.slice(1);
      const sigInfo = (ltSelectedType && ltSelectedType !== 'dx' && typedRef) ? typedRef : '';

      const userComment = ltNotes.value.trim();
      const baseData = {
        freqKhz: freq,
        mode: ltMode.value,
        rstSent: ltRstSent.value || '59',
        rstRcvd: ltRstRcvd.value || '59',
        sig,
        sigInfo,
      };
      if (userComment) baseData.userComment = userComment;

      // Respot flags
      const respotCb = document.getElementById('lt-respot-cb');
      if (respotCb && respotCb.checked) {
        const targets = (ltRespotSection.dataset.targets || '').split(',').filter(Boolean);
        const comment = ltRespotComment.value.trim();
        if (targets.includes('pota')) { baseData.respot = true; }
        if (targets.includes('wwff')) { baseData.wwffRespot = true; baseData.wwffReference = sigInfo; }
        if (targets.includes('llota')) { baseData.llotaRespot = true; baseData.llotaReference = sigInfo; }
        if (targets.includes('dxc')) { baseData.dxcRespot = true; }
        if (comment) baseData.respotComment = comment;
      }

      // Additional parks from comma-separated refs (two-fer / three-fer)
      if (addlRefs.length > 0) baseData.additionalParks = addlRefs;

      // Include activator fields when activation is running
      if (activationSig && activationRef) {
        baseData.mySig = activationSig;
        baseData.mySigInfo = activationRef;
      }
      if (phoneGrid) baseData.myGridsquare = phoneGrid;

      // Send one log-qso per callsign
      for (var ci = 0; ci < calls.length; ci++) {
        var logData = Object.assign({}, baseData, { callsign: calls[ci] });
        ws.send(JSON.stringify({ type: 'log-qso', data: logData }));
      }
    }
  }

  function resetLogTabForm() {
    ltCall.value = '';
    ltCallInfo.classList.add('hidden');
    ltCallInfo.textContent = '';
    ltNotes.value = '';
    // Keep freq/mode/RST for rapid logging
    // Reset ref, addl parks, respot
    ltRefInput.value = '';
    ltRefName.textContent = '';
    ltRespotComment.value = '';
    updateLtRespot();
    ltCall.focus();
  }

  // Initialize log tab type
  selectLtType('dx');

  // Type chip clicks
  document.getElementById('log-type-picker').addEventListener('click', (e) => {
    const chip = e.target.closest('.log-type-chip');
    if (!chip) return;
    selectLogType(chip.dataset.type);
  });

  // Update respot comment when ref changes
  logRefInput.addEventListener('input', updateLogRespot);

  function openLogSheet(prefill) {
    const p = prefill || {};
    logCall.value = p.callsign || '';
    logFreq.value = p.freqKhz || (currentFreqKhz ? String(Math.round(currentFreqKhz * 10) / 10) : '');
    const mode = p.mode || currentMode || 'SSB';
    logMode.value = mode;
    logRstSent.value = p.rstSent || defaultRst(mode);
    logRstRcvd.value = p.rstRcvd || defaultRst(mode);
    logSig.value = p.sig || '';
    logSigInfo.value = p.sigInfo || '';
    logSaveBtn.disabled = false;
    logCallInfo.classList.add('hidden');
    logCallInfo.textContent = '';
    logNotes.value = '';

    // Pre-select type from spot source
    const sigToType = { POTA: 'pota', SOTA: 'sota', WWFF: 'wwff', LLOTA: 'llota' };
    const type = sigToType[(p.sig || '').toUpperCase()] || (p.sig ? '' : 'dx');
    selectLogType(type);

    // Pre-fill reference from spot
    logRefInput.value = p.sigInfo || '';
    logRefName.textContent = '';

    // Reset respot
    logRespotComment.value = '';
    updateLogRespot();

    logSheet.classList.remove('hidden', 'slide-down');
    logBackdrop.classList.remove('hidden');
    if (!p.callsign) logCall.focus();
  }

  function closeLogSheet() {
    logSheet.classList.add('slide-down');
    setTimeout(() => {
      logSheet.classList.add('hidden');
      logSheet.classList.remove('slide-down');
      logBackdrop.classList.add('hidden');
    }, 250);
  }

  logMode.addEventListener('change', () => {
    const rst = defaultRst(logMode.value);
    logRstSent.value = rst;
    logRstRcvd.value = rst;
    updateLogRespot();
  });

  logCancelBtn.addEventListener('click', closeLogSheet);
  logBackdrop.addEventListener('click', closeLogSheet);

  logForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const rawCall = logCall.value.trim().toUpperCase();
    const freq = logFreq.value.trim();
    if (!rawCall) { logCall.focus(); return; }
    if (!freq || isNaN(parseFloat(freq))) { logFreq.focus(); return; }

    // Split comma-separated callsigns (pass-the-mic / multi-op)
    const calls = rawCall.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!calls.length) { logCall.focus(); return; }

    logSaveBtn.disabled = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Determine sig/sigInfo from type picker + ref input (comma-separated for two-fer)
      const typeToSig = { pota: 'POTA', sota: 'SOTA', wwff: 'WWFF', llota: 'LLOTA' };
      const sig = typeToSig[logSelectedType] || logSig.value || '';
      const rawRef = logRefInput.value.trim().toUpperCase();
      const logRefs = rawRef.split(',').map(function (r) { return r.trim(); }).filter(Boolean);
      const typedRef = logRefs[0] || '';
      const logAddlRefs = logRefs.slice(1);
      const sigInfo = (logSelectedType && logSelectedType !== 'dx' && typedRef) ? typedRef : logSigInfo.value || '';

      const logSheetComment = logNotes.value.trim();
      const baseData = {
        freqKhz: freq,
        mode: logMode.value,
        rstSent: logRstSent.value || '59',
        rstRcvd: logRstRcvd.value || '59',
        sig,
        sigInfo,
      };
      if (logSheetComment) baseData.userComment = logSheetComment;

      // Respot flags
      const respotCb = document.getElementById('log-respot-cb');
      if (respotCb && respotCb.checked) {
        const targets = (logRespotSection.dataset.targets || '').split(',').filter(Boolean);
        const comment = logRespotComment.value.trim();
        if (targets.includes('pota')) { baseData.respot = true; }
        if (targets.includes('wwff')) { baseData.wwffRespot = true; baseData.wwffReference = sigInfo; }
        if (targets.includes('llota')) { baseData.llotaRespot = true; baseData.llotaReference = sigInfo; }
        if (targets.includes('dxc')) { baseData.dxcRespot = true; }
        if (comment) baseData.respotComment = comment;
      }

      // Additional parks from comma-separated refs (two-fer / three-fer)
      if (logAddlRefs.length > 0) baseData.additionalParks = logAddlRefs;

      // Include activator fields when activation is running
      if (activationSig && activationRef) {
        baseData.mySig = activationSig;
        baseData.mySigInfo = activationRef;
      }
      if (phoneGrid) baseData.myGridsquare = phoneGrid;

      // Send one log-qso per callsign
      for (var ci = 0; ci < calls.length; ci++) {
        var logData = Object.assign({}, baseData, { callsign: calls[ci] });
        ws.send(JSON.stringify({ type: 'log-qso', data: logData }));
      }
    }
  });

  let toastTimer = null;
  function showLogToast(msg, isError) {
    showToast(msg, isError ? 3000 : 2500, isError);
  }
  function showToast(msg, duration, isError) {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    logToast.textContent = msg;
    logToast.classList.remove('hidden', 'fade-out', 'error');
    if (isError) logToast.classList.add('error');
    toastTimer = setTimeout(function() {
      logToast.classList.add('fade-out');
      setTimeout(function() {
        logToast.classList.add('hidden');
        logToast.classList.remove('fade-out', 'error');
      }, 400);
    }, duration || 2500);
  }

  // =============================================
  // ACTIVATOR MODE
  // =============================================

  // --- Activator state from desktop ---
  function handleActivatorState(msg) {
    const refs = msg.parkRefs || [];
    phoneGrid = msg.grid || '';
    // If desktop is in activator mode with a park, pre-fill the setup form
    // (don't auto-start — user must tap Start to begin a new activation)
    if (msg.appMode === 'activator' && refs.length > 0 && refs[0].ref) {
      if (!activationRunning) {
        setupRefInput.value = refs[0].ref;
        setupRefName.textContent = refs[0].name || '';
        activationName = refs[0].name || '';
        activationSig = 'POTA';
        activationType = 'pota';
        startActivationBtn.disabled = false;
        document.querySelectorAll('.setup-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'pota'));
      }
    }
  }

  // --- Tab Switching ---
  tabBar.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    switchTab(tab.dataset.tab);
  });

  function switchTab(tab, opts) {
    activeTab = tab;
    tabBar.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    // Hide all content areas
    spotList.classList.add('hidden');
    spotMapEl.classList.add('hidden');
    filterToolbar.classList.add('hidden');
    logTabView.classList.add('hidden');
    logView.classList.add('hidden');
    logbookView.classList.add('hidden');
    ft8View.classList.add('hidden');
    if (dirView) dirView.classList.add('hidden');
    if (scanning) stopScan();
    // Show/hide PTT button — hide when FT8 tab is active
    pttBtn.style.display = tab === 'ft8' ? 'none' : '';
    // Hide entire bottom bar (Audio/PTT/STOP) on FT8 tab — no voice audio needed
    bottomBar.style.display = tab === 'ft8' ? 'none' : '';
    // Hide Scan button and freq step arrows on FT8 tab — not relevant
    scanBtn.style.display = tab === 'ft8' ? 'none' : '';
    var freqStepBtns = document.getElementById('freq-step-btns');
    if (freqStepBtns) freqStepBtns.style.display = tab === 'ft8' ? 'none' : '';
    // Hide CW/SSB panels on tabs where they're not relevant
    updateCwPanelVisibility();
    updateSsbPanelVisibility();
    if (tab === 'spots') {
      spotList.classList.remove('hidden');
      filterToolbar.classList.remove('hidden');
    } else if (tab === 'map') {
      spotMapEl.classList.remove('hidden');
      filterToolbar.classList.remove('hidden');
      if (!spotMap) {
        spotMap = L.map('spot-map', {
          zoomControl: true,
          maxBounds: [[-85, -300], [85, 300]],
          maxBoundsViscosity: 1.0,
          minZoom: 2
        }).setView([39.8, -98.5], 4);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OSM',
          className: 'dark-tiles',
          noWrap: true
        }).addTo(spotMap);
      }
      setTimeout(() => spotMap.invalidateSize(), 100);
      renderMapSpots();
    } else if (tab === 'log') {
      logTabView.classList.remove('hidden');
      refreshLogTabFields();
    } else if (tab === 'logbook') {
      logbookView.classList.remove('hidden');
      requestAllQsos();
    } else if (tab === 'activate') {
      logView.classList.remove('hidden');
      updateLogViewState();
    } else if (tab === 'ft8') {
      ft8View.classList.remove('hidden');
      // Auto-start engine if not running
      if (!ft8Running) {
        ft8Send({ type: 'jtcat-start', mode: ft8Mode });
      }
      // If coming from a spot click with a specific frequency, select the matching band
      // and skip the default band tune (the spot already tuned the radio)
      var spotFreq = opts && opts.freqKhz ? parseFloat(opts.freqKhz) : 0;
      if (spotFreq > 0) {
        // Select the band dropdown option matching the spot frequency
        for (var oi = 0; oi < ft8BandSelect.options.length; oi++) {
          var optFreq = parseInt(ft8BandSelect.options[oi].dataset.freq, 10);
          if (Math.abs(optFreq - spotFreq) < 2) {
            ft8BandSelect.selectedIndex = oi;
            break;
          }
        }
        // Don't send jtcat-set-band — the spot tune already set the frequency
      } else {
        // Normal tab switch — tune to the active band
        var selectedOpt = ft8BandSelect.options[ft8BandSelect.selectedIndex];
        if (selectedOpt) {
          var freqKhz = parseInt(selectedOpt.dataset.freq, 10);
          ft8Send({ type: 'jtcat-set-band', band: selectedOpt.value, freqKhz: freqKhz });
        }
      }
      ft8StartCountdown();
    } else if (tab === 'dir') {
      if (dirView) dirView.classList.remove('hidden');
      renderDirectoryTab();
    }
  }

  function updateLogViewState() {
    if (activationRunning) {
      activationSetup.classList.add('hidden');
      pastActivationsDiv.classList.add('hidden');
      quickLogForm.classList.remove('hidden');
      logFooter.classList.remove('hidden');
      if (currentFreqKhz) qlFreq.value = String(Math.round(currentFreqKhz * 10) / 10);
      if (currentMode) qlMode.value = currentMode;
      qlCall.focus();
    } else {
      activationSetup.classList.remove('hidden');
      pastActivationsDiv.classList.remove('hidden');
      quickLogForm.classList.add('hidden');
      logFooter.classList.add('hidden');
      requestPastActivations();
      setupRefInput.focus();
    }
  }

  // --- Activation Type Chooser ---
  document.querySelector('.setup-type-row').addEventListener('click', (e) => {
    const btn = e.target.closest('.setup-type-btn');
    if (!btn) return;
    activationType = btn.dataset.type;
    document.querySelectorAll('.setup-type-btn').forEach(b => b.classList.toggle('active', b === btn));
    // Update label and placeholder
    if (activationType === 'pota') {
      setupRefLabel.textContent = 'Park Reference';
      setupRefInput.placeholder = 'US-1234';
    } else if (activationType === 'sota') {
      setupRefLabel.textContent = 'Summit Reference';
      setupRefInput.placeholder = 'W4C/CM-001';
    } else {
      setupRefLabel.textContent = 'Activation Name';
      setupRefInput.placeholder = 'Field Day, VOTA, etc.';
    }
    // Reset
    setupRefInput.value = '';
    setupRefName.textContent = '';
    setupRefDropdown.classList.add('hidden');
    startActivationBtn.disabled = true;
  });

  // --- Reference Input with Autocomplete ---
  setupRefInput.addEventListener('input', () => {
    const query = setupRefInput.value.trim();
    setupRefName.textContent = '';
    activationName = '';

    if (activationType === 'other') {
      // Free text — no autocomplete, enable start when non-empty
      startActivationBtn.disabled = !query;
      setupRefDropdown.classList.add('hidden');
      return;
    }

    if (query.length < 2) {
      setupRefDropdown.classList.add('hidden');
      startActivationBtn.disabled = true;
      return;
    }

    // Enable button for typed refs (user might know the exact ref)
    startActivationBtn.disabled = false;

    // Debounced search
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'search-parks', query }));
      }
    }, 150);
  });

  setupRefInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setupRefDropdown.classList.add('hidden');
      if (!startActivationBtn.disabled) doStartActivation();
    }
  });

  // Close dropdown when tapping outside
  document.addEventListener('click', (e) => {
    if (!setupRefDropdown.contains(e.target) && e.target !== setupRefInput) {
      setupRefDropdown.classList.add('hidden');
    }
  });

  function showSearchResults(results) {
    if (!results.length) {
      setupRefDropdown.classList.add('hidden');
      return;
    }
    setupRefDropdown.innerHTML = results.slice(0, 8).map((r, i) =>
      `<div class="setup-dropdown-item" data-idx="${i}">
        <span class="sdi-ref">${esc(r.reference)}</span>
        <span class="sdi-name">${esc(r.name || '')}</span>
        <span class="sdi-loc">${esc(r.locationDesc || '')}</span>
      </div>`
    ).join('');
    setupRefDropdown._results = results;
    setupRefDropdown.classList.remove('hidden');
  }

  setupRefDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.setup-dropdown-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx, 10);
    const results = setupRefDropdown._results || [];
    const park = results[idx];
    if (!park) return;
    setupRefInput.value = park.reference;
    activationName = park.name || '';
    setupRefName.textContent = activationName;
    setupRefDropdown.classList.add('hidden');
    startActivationBtn.disabled = false;
  });

  // --- Start Activation ---
  startActivationBtn.addEventListener('click', doStartActivation);

  function doStartActivation() {
    const ref = setupRefInput.value.trim().toUpperCase();
    if (!ref && activationType !== 'other') return;
    const refOrName = activationType === 'other' ? setupRefInput.value.trim() : ref;
    if (!refOrName) return;

    activationRef = refOrName;
    if (activationType === 'pota') activationSig = 'POTA';
    else if (activationType === 'sota') activationSig = 'SOTA';
    else activationSig = '';

    // Tell server
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'set-activator-park',
        parkRef: activationType !== 'other' ? ref : '',
        activationType,
        activationName: activationType === 'other' ? refOrName : '',
        sig: activationSig,
      }));
    }

    beginActivation();
  }

  function beginActivation() {
    activationRunning = true;
    activationStartTime = Date.now();
    sessionContacts = [];

    // Show banner
    activationBanner.classList.remove('hidden');
    activationRefEl.textContent = activationRef;
    activationRefEl.className = 'activation-ref' + (activationType === 'sota' ? ' sota' : activationType === 'other' ? ' other' : '');
    activationNameEl.textContent = activationName;
    updateActivationTimer();
    if (activationTimerInterval) clearInterval(activationTimerInterval);
    activationTimerInterval = setInterval(updateActivationTimer, 1000);

    // Update log view
    updateLogViewState();
    renderContacts();
    updateLogBadge();
    updateLogFooter();

    // Auto-switch to activate tab
    switchTab('activate');
  }

  function updateActivationTimer() {
    const elapsed = Math.floor((Date.now() - activationStartTime) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    if (h > 0) {
      activationTimerEl.textContent = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    } else {
      activationTimerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }
  }

  // --- End Activation ---
  endActivationBtn.addEventListener('click', () => {
    if (sessionContacts.length > 0) {
      if (!confirm(`End activation? ${sessionContacts.length} QSO${sessionContacts.length !== 1 ? 's' : ''} logged.`)) return;
    }
    endActivation();
  });

  function endActivation() {
    activationRunning = false;
    activationRef = '';
    activationName = '';
    activationSig = '';
    if (activationTimerInterval) { clearInterval(activationTimerInterval); activationTimerInterval = null; }
    activationBanner.classList.add('hidden');
    // Reset setup form
    setupRefInput.value = '';
    setupRefName.textContent = '';
    startActivationBtn.disabled = true;
    updateLogViewState();
  }

  // --- Quick Log Form ---
  qlLogBtn.addEventListener('click', submitQuickLog);
  qlCall.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitQuickLog(); }
  });

  qlMode.addEventListener('change', () => {
    const rst = defaultRst(qlMode.value);
    qlRstSent.value = rst;
    qlRstRcvd.value = rst;
  });

  // --- Callsign lookup (name/QTH) for all log forms ---
  function triggerCallLookup(inputEl, source) {
    if (callLookupTimer) clearTimeout(callLookupTimer);
    const infoEl = source === 'lt' ? ltCallInfo : source === 'log' ? logCallInfo : qlCallInfo;
    const call = inputEl.value.trim().toUpperCase();
    if (call.length < 3) {
      infoEl.classList.add('hidden');
      infoEl.textContent = '';
      return;
    }
    callLookupSource = source;
    callLookupTimer = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'lookup-call', callsign: call }));
      }
    }, 400);
  }

  qlCall.addEventListener('input', () => triggerCallLookup(qlCall, 'ql'));
  ltCall.addEventListener('input', () => triggerCallLookup(ltCall, 'lt'));
  logCall.addEventListener('input', () => triggerCallLookup(logCall, 'log'));

  function showCallLookup(msg) {
    const infoEl = callLookupSource === 'lt' ? ltCallInfo : callLookupSource === 'log' ? logCallInfo : qlCallInfo;
    const inputEl = callLookupSource === 'lt' ? ltCall : callLookupSource === 'log' ? logCall : qlCall;
    const currentCall = inputEl.value.trim().toUpperCase();
    if (msg.callsign !== currentCall) return; // stale response
    const parts = [];
    if (msg.name) parts.push(msg.name);
    if (msg.location) parts.push(msg.location);
    if (parts.length) {
      infoEl.textContent = parts.join(' \u2014 ');
      infoEl.classList.remove('hidden');
    } else {
      infoEl.classList.add('hidden');
      infoEl.textContent = '';
    }
  }

  function submitQuickLog() {
    const call = qlCall.value.trim().toUpperCase();
    if (!call) { qlCall.focus(); return; }
    const freq = qlFreq.value.trim();
    const mode = qlMode.value;
    const rstSent = qlRstSent.value || defaultRst(mode);
    const rstRcvd = qlRstRcvd.value || defaultRst(mode);

    const qlComment = qlNotes.value.trim();
    const data = {
      callsign: call,
      freqKhz: freq,
      mode,
      rstSent,
      rstRcvd,
    };
    if (qlComment) data.userComment = qlComment;

    // Add activator fields
    if (activationSig && activationRef) {
      data.mySig = activationSig;
      data.mySigInfo = activationRef;
    }
    if (phoneGrid) {
      data.myGridsquare = phoneGrid;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'log-qso', data }));
      qlLogBtn.disabled = true;
      setTimeout(() => { qlLogBtn.disabled = false; }, 3000);
    } else {
      // Offline — queue locally
      const now = new Date();
      offlineQueue.push({ ...data, _offline: true, _ts: now.toISOString() });
      localStorage.setItem('echocat-offline-queue', JSON.stringify(offlineQueue));
      sessionContacts.push({
        nr: sessionContacts.length + 1,
        callsign: call,
        timeUtc: now.toISOString().slice(11, 16).replace(':', ''),
        freqKhz: freq,
        mode,
        rstSent,
        rstRcvd,
        _offline: true,
      });
      renderContacts();
      updateLogBadge();
      showLogToast('Queued offline');
    }

    qlCall.value = '';
    qlCallInfo.classList.add('hidden');
    qlCallInfo.textContent = '';
    qlNotes.value = '';
    qlCall.focus();
    if (currentFreqKhz) qlFreq.value = String(Math.round(currentFreqKhz * 10) / 10);
  }

  function handleLogOkContact(msg) {
    const contact = {
      nr: msg.nr,
      callsign: msg.callsign || '',
      timeUtc: msg.timeUtc || '',
      freqKhz: msg.freqKhz || '',
      mode: msg.mode || '',
      band: msg.band || '',
      rstSent: msg.rstSent || '',
      rstRcvd: msg.rstRcvd || '',
    };
    const offIdx = sessionContacts.findIndex(c => c._offline && c.callsign === contact.callsign);
    if (offIdx >= 0) sessionContacts.splice(offIdx, 1);
    sessionContacts.push(contact);
    renderContacts();
    updateLogBadge();
    qlLogBtn.disabled = false;
  }

  // --- Contact List ---
  function renderContacts() {
    if (sessionContacts.length === 0) {
      contactList.innerHTML = '<div class="spot-empty">No contacts yet</div>';
    } else {
      const sorted = [...sessionContacts].reverse();
      contactList.innerHTML = sorted.map(c => {
        const offClass = c._offline ? ' offline' : '';
        const dupeClass = c.dupe ? ' dupe' : '';
        const time = c.timeUtc ? c.timeUtc.slice(0, 2) + ':' + c.timeUtc.slice(2, 4) : '';
        const freq = c.freqKhz ? parseFloat(c.freqKhz).toFixed(1) : '';
        const dupeTag = c.dupe ? ' <span class="dupe-tag">DUPE</span>' : '';
        return `<div class="contact-row${offClass}${dupeClass}">
          <span class="contact-nr">${c.nr || ''}</span>
          <span class="contact-time">${esc(time)}</span>
          <span class="contact-call">${esc(c.callsign)}${dupeTag}</span>
          <span class="contact-freq">${freq}</span>
          <span class="contact-mode">${esc(c.mode || '')}</span>
          <span class="contact-rst">${esc(c.rstSent || '')}/${esc(c.rstRcvd || '')}</span>
        </div>`;
      }).join('');
    }
    updateLogFooter();
  }

  function updateLogBadge() {
    const count = sessionContacts.length;
    const dupes = sessionContacts.filter(c => c.dupe).length;
    tabActivateBadge.textContent = dupes > 0 ? count + ' (' + dupes + ' dupe' + (dupes > 1 ? 's' : '') + ')' : count;
    tabActivateBadge.classList.toggle('hidden', count === 0);
  }

  function updateLogFooter() {
    const total = sessionContacts.length;
    const dupes = sessionContacts.filter(c => c.dupe).length;
    const queued = offlineQueue.length;
    logFooterCount.textContent = total + ' QSO' + (total !== 1 ? 's' : '') + (dupes > 0 ? ' (' + dupes + ' dupe' + (dupes > 1 ? 's' : '') + ')' : '');
    if (queued > 0) {
      logFooterQueued.textContent = queued + ' queued';
      logFooterQueued.classList.remove('hidden');
    } else {
      logFooterQueued.classList.add('hidden');
    }
  }

  // --- Offline Queue Drain ---
  function drainOfflineQueue() {
    if (offlineQueue.length === 0) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    showLogToast('Syncing ' + offlineQueue.length + ' offline QSO' + (offlineQueue.length > 1 ? 's' : '') + '...');
    drainNext();
  }

  function drainNext() {
    if (offlineQueue.length === 0) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const item = offlineQueue.shift();
    localStorage.setItem('echocat-offline-queue', JSON.stringify(offlineQueue));
    const data = { ...item };
    delete data._offline;
    delete data._ts;
    ws.send(JSON.stringify({ type: 'log-qso', data }));
    updateLogFooter();
    setTimeout(drainNext, 300);
  }

  // --- ADIF Export ---
  // --- Past Activations ---
  function requestPastActivations() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'get-past-activations' }));
    }
  }

  function formatPaDate(dateStr) {
    if (!dateStr || dateStr.length !== 8) return dateStr || '';
    return dateStr.slice(0, 4) + '-' + dateStr.slice(4, 6) + '-' + dateStr.slice(6, 8);
  }

  function formatPaTime(timeStr) {
    if (!timeStr || timeStr.length < 4) return timeStr || '';
    return timeStr.slice(0, 2) + ':' + timeStr.slice(2, 4);
  }

  function renderPastActivations() {
    if (!pastActivations.length) {
      paList.innerHTML = '<div class="spot-empty">No past activations</div>';
      return;
    }
    paList.innerHTML = pastActivations.map(function (act, i) {
      var dateStr = formatPaDate(act.date);
      var count = act.contacts.length;
      var badge = count >= 10 ? ' pa-badge-success' : '';
      var rows = act.contacts.map(function (c, j) {
        return '<div class="pa-contact-row">' +
          '<span class="pa-nr">' + (j + 1) + '</span>' +
          '<span class="pa-time">' + formatPaTime(c.timeOn) + '</span>' +
          '<span class="pa-call">' + esc(c.callsign) + '</span>' +
          '<span class="pa-freq">' + (c.freq ? parseFloat(c.freq).toFixed(3) : '') + '</span>' +
          '<span class="pa-mode">' + esc(c.mode) + '</span>' +
          '<span class="pa-rst">' + esc(c.rstSent) + '/' + esc(c.rstRcvd) + '</span>' +
          '</div>';
      }).join('');
      return '<div class="pa-card" data-idx="' + i + '">' +
        '<div class="pa-card-header" data-idx="' + i + '">' +
          '<span class="pa-ref">' + esc(act.parkRef) + '</span>' +
          '<span class="pa-date">' + dateStr + '</span>' +
          '<span class="pa-count' + badge + '">' + count + ' QSO' + (count !== 1 ? 's' : '') + '</span>' +
        '</div>' +
        '<div class="pa-detail hidden" data-detail="' + i + '">' +
          '<div class="pa-contacts">' + rows + '</div>' +
          '<div class="pa-actions">' +
            '<button type="button" class="pa-map-btn" data-idx="' + i + '">Map</button>' +
            '<button type="button" class="pa-export-btn" data-idx="' + i + '">Export ADIF</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  paList.addEventListener('click', function (e) {
    // Toggle expand/collapse on card header
    var header = e.target.closest('.pa-card-header');
    if (header && !e.target.closest('.pa-map-btn') && !e.target.closest('.pa-export-btn')) {
      var idx = header.dataset.idx;
      var detail = paList.querySelector('[data-detail="' + idx + '"]');
      if (detail) detail.classList.toggle('hidden');
      return;
    }
    // Map button
    var mapBtn = e.target.closest('.pa-map-btn');
    if (mapBtn) {
      var i = parseInt(mapBtn.dataset.idx, 10);
      var act = pastActivations[i];
      if (!act) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'get-activation-map-data',
          parkRef: act.parkRef,
          date: act.date,
          contacts: act.contacts,
        }));
      }
      return;
    }
    // Export ADIF button
    var exportBtn = e.target.closest('.pa-export-btn');
    if (exportBtn) {
      var idx2 = parseInt(exportBtn.dataset.idx, 10);
      var act2 = pastActivations[idx2];
      if (!act2) return;
      exportPastActivationAdif(act2);
      return;
    }
  });

  function exportPastActivationAdif(act) {
    var lines = ['POTACAT ECHOCAT Export\n<ADIF_VER:5>3.1.4\n<PROGRAMID:7>POTACAT\n<EOH>\n'];
    for (var i = 0; i < act.contacts.length; i++) {
      var c = act.contacts[i];
      var rec = '';
      rec += af('CALL', c.callsign);
      if (c.freq) rec += af('FREQ', c.freq);
      rec += af('MODE', c.mode);
      rec += af('BAND', c.band);
      rec += af('QSO_DATE', act.date);
      rec += af('TIME_ON', c.timeOn);
      if (c.rstSent) rec += af('RST_SENT', c.rstSent);
      if (c.rstRcvd) rec += af('RST_RCVD', c.rstRcvd);
      rec += af('MY_SIG', 'POTA');
      rec += af('MY_SIG_INFO', act.parkRef);
      if (c.sig) rec += af('SIG', c.sig);
      if (c.sigInfo) rec += af('SIG_INFO', c.sigInfo);
      if (c.myGridsquare) rec += af('MY_GRIDSQUARE', c.myGridsquare);
      if (myCallsign) rec += af('STATION_CALLSIGN', myCallsign);
      rec += '<EOR>\n';
      lines.push(rec);
    }
    var blob = new Blob([lines.join('')], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (myCallsign || 'POTACAT') + '@' + act.parkRef + '-' + formatPaDate(act.date) + '.adi';
    a.click();
    URL.revokeObjectURL(url);
    showLogToast('ADIF exported');
  }

  // --- Activation Map ---
  function gridToLatLonLocal(grid) {
    if (!grid || grid.length < 4) return null;
    var g = grid.toUpperCase();
    var lonField = g.charCodeAt(0) - 65;
    var latField = g.charCodeAt(1) - 65;
    var lonSquare = parseInt(g[2], 10);
    var latSquare = parseInt(g[3], 10);
    var lon = lonField * 20 + lonSquare * 2 - 180;
    var lat = latField * 10 + latSquare * 1 - 90;
    if (grid.length >= 6) {
      var lonSub = g.charCodeAt(4) - 65;
      var latSub = g.charCodeAt(5) - 65;
      lon += lonSub * (2 / 24) + (1 / 24);
      lat += latSub * (1 / 24) + (1 / 48);
    } else {
      lon += 1;
      lat += 0.5;
    }
    return { lat: lat, lon: lon };
  }

  function greatCircleArc(from, to, points) {
    var toRad = Math.PI / 180;
    var toDeg = 180 / Math.PI;
    var lat1 = from[0] * toRad, lon1 = from[1] * toRad;
    var lat2 = to[0] * toRad, lon2 = to[1] * toRad;
    var d = 2 * Math.asin(Math.sqrt(
      Math.pow(Math.sin((lat2 - lat1) / 2), 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin((lon2 - lon1) / 2), 2)
    ));
    if (d < 1e-10) return [from, to];
    var pts = [];
    for (var i = 0; i <= points; i++) {
      var f = i / points;
      var A = Math.sin((1 - f) * d) / Math.sin(d);
      var B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
      var y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
      var z = A * Math.sin(lat1) + B * Math.sin(lat2);
      pts.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg, Math.atan2(y, x) * toDeg]);
    }
    return pts;
  }

  function wrapLon(refLon, lon) {
    var best = lon, bestDist = Math.abs(lon - refLon);
    for (var oi = 0; oi < 2; oi++) {
      var offset = oi === 0 ? -360 : 360;
      var wrapped = lon + offset;
      if (Math.abs(wrapped - refLon) < bestDist) {
        best = wrapped;
        bestDist = Math.abs(wrapped - refLon);
      }
    }
    return best;
  }

  function showActivationMap(data) {
    actMapOverlay.classList.remove('hidden');
    actMapTitle.textContent = data.parkRef || '';
    if (data.park && data.park.name) actMapTitle.textContent = data.park.name;
    var resolved = data.resolvedContacts || [];
    var withLoc = resolved.filter(function (c) { return c.lat != null; });
    actMapCount.textContent = resolved.length + ' QSO' + (resolved.length !== 1 ? 's' : '');

    if (actMap) { actMap.remove(); actMap = null; }
    if (typeof L === 'undefined') {
      actMapEl.innerHTML = '<div style="padding:20px;color:var(--text-dim)">Map not available</div>';
      return;
    }
    actMap = L.map(actMapEl, { zoomControl: false, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, className: 'dark-tiles'
    }).addTo(actMap);

    var bounds = [];
    var amRefLon = (data.park && data.park.lon != null) ? data.park.lon : -98.5;

    // Park marker (green circle)
    if (data.park && data.park.lat != null) {
      var parkLL = [data.park.lat, data.park.lon];
      L.circleMarker(parkLL, { radius: 10, color: '#4ecca3', fillColor: '#4ecca3', fillOpacity: 0.8, weight: 2 })
        .bindPopup('<b>' + esc(data.parkRef || '') + '</b><br>' + esc(data.park.name || ''))
        .addTo(actMap);
      bounds.push(parkLL);
    }

    // Contact markers (blue circles) + arcs
    for (var i = 0; i < resolved.length; i++) {
      var c = resolved[i];
      if (c.lat == null) continue;
      var cLon = wrapLon(amRefLon, c.lon);
      var ll = [c.lat, cLon];
      L.circleMarker(ll, { radius: 6, color: '#4fc3f7', fillColor: '#4fc3f7', fillOpacity: 0.7, weight: 1 })
        .bindPopup('<b>' + esc(c.callsign) + '</b><br>' + esc(c.entityName || '') + '<br>' + (c.freq || '') + ' ' + (c.mode || ''))
        .addTo(actMap);
      bounds.push(ll);
      // Great circle arc from park to contact
      if (data.park && data.park.lat != null) {
        var arc = greatCircleArc([data.park.lat, data.park.lon], ll, 50);
        L.polyline(arc, { color: '#4fc3f7', weight: 1, opacity: 0.4, dashArray: '4,6' }).addTo(actMap);
      }
    }

    if (bounds.length > 1) {
      actMap.fitBounds(bounds, { padding: [30, 30] });
    } else if (bounds.length === 1) {
      actMap.setView(bounds[0], 6);
    } else {
      actMap.setView([39, -98], 4);
    }
  }

  actMapBack.addEventListener('click', function () {
    actMapOverlay.classList.add('hidden');
    if (actMap) { actMap.remove(); actMap = null; }
  });

  exportAdifBtn.addEventListener('click', exportAdif);

  function exportAdif() {
    const lines = ['POTACAT ECHOCAT ADIF Export\n<ADIF_VER:5>3.1.4\n<PROGRAMID:7>POTACAT\n<EOH>\n'];
    for (const c of sessionContacts) {
      if (c._offline) continue;
      let rec = '';
      rec += af('CALL', c.callsign);
      if (c.freqKhz) rec += af('FREQ', (parseFloat(c.freqKhz) / 1000).toFixed(6));
      if (c.mode) rec += af('MODE', c.mode);
      if (c.band) rec += af('BAND', c.band);
      if (c.timeUtc) {
        const d = new Date();
        const dateStr = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
        rec += af('QSO_DATE', dateStr);
        rec += af('TIME_ON', c.timeUtc);
      }
      if (c.rstSent) rec += af('RST_SENT', c.rstSent);
      if (c.rstRcvd) rec += af('RST_RCVD', c.rstRcvd);
      if (activationSig) rec += af('MY_SIG', activationSig);
      if (activationRef) rec += af('MY_SIG_INFO', activationRef);
      if (phoneGrid) rec += af('MY_GRIDSQUARE', phoneGrid);
      rec += '<EOR>\n';
      lines.push(rec);
    }
    for (const c of offlineQueue) {
      let rec = '';
      rec += af('CALL', c.callsign);
      if (c.freqKhz) rec += af('FREQ', (parseFloat(c.freqKhz) / 1000).toFixed(6));
      if (c.mode) rec += af('MODE', c.mode);
      if (c.rstSent) rec += af('RST_SENT', c.rstSent);
      if (c.rstRcvd) rec += af('RST_RCVD', c.rstRcvd);
      if (c._ts) {
        const d = new Date(c._ts);
        const dateStr = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
        rec += af('QSO_DATE', dateStr);
        rec += af('TIME_ON', String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0'));
      }
      if (activationSig) rec += af('MY_SIG', activationSig);
      if (activationRef) rec += af('MY_SIG_INFO', activationRef);
      if (phoneGrid) rec += af('MY_GRIDSQUARE', phoneGrid);
      rec += '<EOR>\n';
      lines.push(rec);
    }
    const blob = new Blob([lines.join('')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (activationRef || 'echocat') + '_' + new Date().toISOString().slice(0, 10) + '.adi';
    a.click();
    URL.revokeObjectURL(url);
    showLogToast('ADIF exported');
  }

  function af(name, val) {
    if (!val) return '';
    return `<${name}:${val.length}>${val}\n`;
  }

  // Refresh spot ages every 30s
  setInterval(() => {
    if (spots.length > 0) {
      renderSpots();
      if (activeTab === 'map') renderMapSpots();
    }
  }, 30000);

  // --- Welcome Tip ---
  const welcomeOverlay = document.getElementById('welcome-overlay');
  const welcomeHide = document.getElementById('welcome-hide');
  const welcomeOk = document.getElementById('welcome-ok');

  function showWelcome() {
    if (localStorage.getItem('echocat-welcome-dismissed')) return;
    welcomeOverlay.classList.remove('hidden');
  }

  welcomeOk.addEventListener('click', () => {
    if (welcomeHide.checked) {
      localStorage.setItem('echocat-welcome-dismissed', '1');
    }
    welcomeOverlay.classList.add('hidden');
  });

  // --- Rig Selector ---
  function updateRigSelect(rigs, activeRigId) {
    if (!rigs || rigs.length < 2) {
      soRigRow.classList.add('hidden');
      return;
    }
    rigSelect.innerHTML = rigs.map(r =>
      `<option value="${esc(r.id)}"${r.id === activeRigId ? ' selected' : ''}>${esc(r.name || 'Unnamed Rig')}</option>`
    ).join('');
    soRigRow.classList.remove('hidden');
  }

  rigSelect.addEventListener('change', () => {
    const rigId = rigSelect.value;
    if (!rigId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'switch-rig', rigId }));
  });

  // =============================================
  // LOGBOOK VIEW
  // =============================================

  function requestAllQsos() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'get-all-qsos' }));
    }
  }

  function getFilteredLogbook() {
    const query = (lbSearch.value || '').trim().toUpperCase();
    let filtered = logbookQsos;
    if (query) {
      filtered = logbookQsos.filter(q => {
        const call = (q.CALL || '').toUpperCase();
        const sigInfo = (q.SIG_INFO || '').toUpperCase();
        const comment = (q.COMMENT || '').toUpperCase();
        const mode = (q.MODE || '').toUpperCase();
        const band = (q.BAND || '').toUpperCase();
        return call.includes(query) || sigInfo.includes(query) || comment.includes(query) ||
               mode.includes(query) || band.includes(query);
      });
    }
    // Newest first (reverse index order)
    return [...filtered].reverse();
  }

  function formatLbDate(dateStr) {
    if (!dateStr || dateStr.length !== 8) return dateStr || '';
    return dateStr.slice(0, 4) + '-' + dateStr.slice(4, 6) + '-' + dateStr.slice(6, 8);
  }

  function formatLbTime(timeStr) {
    if (!timeStr || timeStr.length < 4) return timeStr || '';
    return timeStr.slice(0, 2) + ':' + timeStr.slice(2, 4);
  }

  function renderLogbook() {
    const filtered = getFilteredLogbook();
    lbCount.textContent = filtered.length + ' QSO' + (filtered.length !== 1 ? 's' : '');

    if (!filtered.length) {
      lbList.innerHTML = '<div class="lb-empty">No QSOs found</div>';
      return;
    }

    lbList.innerHTML = filtered.map(q => {
      const idx = q.idx;
      const call = esc(q.CALL || '');
      const freqMhz = q.FREQ ? parseFloat(q.FREQ).toFixed(3) : '';
      const mode = esc(q.MODE || '');
      const ref = esc(q.SIG_INFO || '');
      const date = formatLbDate(q.QSO_DATE || '');
      const time = formatLbTime(q.TIME_ON || '');
      const isExpanded = expandedQsoIdx === idx;

      let detail = '';
      if (isExpanded) {
        const band = esc(q.BAND || '');
        const rstSent = esc(q.RST_SENT || '');
        const rstRcvd = esc(q.RST_RCVD || '');
        const comment = esc(q.COMMENT || '');
        detail = `<div class="lb-detail">
          <div class="log-row">
            <div class="log-field"><label>Call</label><input type="text" data-field="CALL" value="${esc(q.CALL || '')}"></div>
            <div class="log-field"><label>Freq MHz</label><input type="text" data-field="FREQ" value="${esc(q.FREQ || '')}"></div>
          </div>
          <div class="log-row">
            <div class="log-field"><label>Mode</label><input type="text" data-field="MODE" value="${esc(q.MODE || '')}"></div>
            <div class="log-field"><label>Band</label><input type="text" data-field="BAND" value="${band}"></div>
          </div>
          <div class="log-row">
            <div class="log-field"><label>RST Sent</label><input type="text" data-field="RST_SENT" value="${rstSent}"></div>
            <div class="log-field"><label>RST Rcvd</label><input type="text" data-field="RST_RCVD" value="${rstRcvd}"></div>
          </div>
          <div class="log-row">
            <div class="log-field"><label>Date</label><input type="text" data-field="QSO_DATE" value="${esc(q.QSO_DATE || '')}"></div>
            <div class="log-field"><label>Time</label><input type="text" data-field="TIME_ON" value="${esc(q.TIME_ON || '')}"></div>
          </div>
          <div class="log-row">
            <div class="log-field"><label>Park/Ref</label><input type="text" data-field="SIG_INFO" value="${esc(q.SIG_INFO || '')}"></div>
            <div class="log-field"><label>Notes</label><input type="text" data-field="COMMENT" value="${comment}"></div>
          </div>
          <div class="lb-actions">
            <button type="button" class="lb-save-btn" data-idx="${idx}">Save</button>
            <button type="button" class="lb-delete-btn" data-idx="${idx}">Delete</button>
          </div>
        </div>`;
      }

      return `<div class="lb-card" data-idx="${idx}">
        <div class="lb-card-header" data-idx="${idx}">
          <span class="lb-call">${call}</span>
          <span class="lb-freq">${freqMhz}</span>
          <span class="lb-mode">${mode}</span>
          <span class="lb-ref">${ref}</span>
          <span class="lb-date">${date} ${time}</span>
        </div>
        ${detail}
      </div>`;
    }).join('');
  }

  // Search input
  lbSearch.addEventListener('input', () => {
    renderLogbook();
  });

  // Logbook click handlers (expand, save, delete)
  lbList.addEventListener('click', (e) => {
    // Save button
    const saveBtn = e.target.closest('.lb-save-btn');
    if (saveBtn) {
      const idx = parseInt(saveBtn.dataset.idx, 10);
      const card = saveBtn.closest('.lb-card');
      const fields = {};
      card.querySelectorAll('.lb-detail input[data-field]').forEach(input => {
        fields[input.dataset.field] = input.value;
      });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'update-qso', idx, fields }));
      }
      return;
    }

    // Delete button (two-tap confirm)
    const deleteBtn = e.target.closest('.lb-delete-btn');
    if (deleteBtn) {
      if (deleteBtn.classList.contains('confirming')) {
        const idx = parseInt(deleteBtn.dataset.idx, 10);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'delete-qso', idx }));
        }
      } else {
        deleteBtn.classList.add('confirming');
        deleteBtn.textContent = 'Sure?';
        setTimeout(() => {
          deleteBtn.classList.remove('confirming');
          deleteBtn.textContent = 'Delete';
        }, 3000);
      }
      return;
    }

    // Header tap — toggle expand
    const header = e.target.closest('.lb-card-header');
    if (header) {
      const idx = parseInt(header.dataset.idx, 10);
      expandedQsoIdx = expandedQsoIdx === idx ? -1 : idx;
      renderLogbook();
    }
  });

  // ============================================================
  // FT8/JTCAT — Phone-side client logic
  // ============================================================

  function ft8Send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // --- Decode handling ---
  function ft8HandleDecode(data) {
    ft8DecodeLog.push(data);
    // Cap at 50 cycles
    if (ft8DecodeLog.length > 50) ft8DecodeLog.shift();
    ft8RenderDecodeRow(data);
  }

  function ft8RenderDecodeRow(data) {
    const log = ft8DecodeLogEl;
    // Remove "Tap a band to start" placeholder
    const empty = log.querySelector('.ft8-empty');
    if (empty) empty.remove();

    const results = data.results || [];
    const time = data.time || '';

    // Cycle separator
    const sep = document.createElement('div');
    sep.className = 'ft8-cycle-sep';
    sep.textContent = time + ' UTC';
    log.appendChild(sep);

    if (results.length === 0) {
      if (ft8Transmitting && ft8TxMsg) {
        const row = document.createElement('div');
        row.className = 'ft8-row ft8-tx';
        row.innerHTML = '<span class="ft8-db">TX</span><span class="ft8-msg">' + esc(ft8TxMsg) + '</span>';
        log.appendChild(row);
      } else if (!ft8Transmitting) {
        const row = document.createElement('div');
        row.className = 'ft8-row';
        row.innerHTML = '<span class="ft8-msg" style="color:#666">No decodes</span>';
        log.appendChild(row);
      }
    } else {
      // Sort by signal strength if enabled
      var sortedResults = ft8SortSignal ? results.slice().sort((a, b) => (b.db || 0) - (a.db || 0)) : results;
      sortedResults.forEach(d => {
        const text = d.text || '';
        const upper = text.toUpperCase();
        const isCq = upper.startsWith('CQ ');
        const isDirected = myCallsign && upper.indexOf(myCallsign.toUpperCase()) >= 0;
        const isHunt = ft8HuntCall && upper.indexOf(ft8HuntCall) >= 0;
        const is73 = upper.indexOf('RR73') >= 0 || upper.indexOf(' 73') >= 0;

        // Auto-reply runs regardless of filter
        if (isHunt && isCq && !ft8QsoState) {
          const parts = upper.split(/\s+/);
          let callIdx = 1;
          if (parts.length > 3 && parts[1].length <= 4 && !/[0-9]/.test(parts[1])) callIdx = 2;
          const call = parts[callIdx] || '';
          const grid = parts[callIdx + 1] || '';
          if (call === ft8HuntCall) {
            ft8Send({ type: 'jtcat-reply', call, grid, df: d.df || 1500, sliceId: d.sliceId });
            ft8HuntCall = ''; // clear hunt — we've engaged
          }
        }

        // Always show decodes from/to our active QSO partner
        const isQsoPartner = ft8QsoState && ft8QsoState.call && upper.indexOf(ft8QsoState.call.toUpperCase()) >= 0;
        const isWanted = d.newDxcc || d.newCall || d.newGrid;

        // Apply CQ filter — always show CQ, 73, directed-at-me, hunted, and QSO partner
        if (ft8CqFilter && !isCq && !is73 && !isDirected && !isHunt && !isQsoPartner) return;
        if (ft8WantedFilter && !isWanted && !isDirected && !is73 && !isHunt && !isQsoPartner) return;
        if (ft8SearchFilter && upper.indexOf(ft8SearchFilter) === -1) return;

        // Build needed badges + entity
        let badges = '';
        if (d.newDxcc) badges += '<span class="ft8-badge ft8-badge-dxcc" title="New DXCC: ' + esc(d.entity || '') + '">D</span>';
        if (d.newGrid) badges += '<span class="ft8-badge ft8-badge-grid" title="New grid: ' + esc(d.grid || '') + '">G</span>';
        if (d.newCall) badges += '<span class="ft8-badge ft8-badge-call" title="New call: ' + esc(d.call || '') + '">C</span>';
        if (d.watched) badges += '<span class="ft8-badge ft8-badge-watch" title="Watchlist">W</span>';
        if (d.call && donorCallsigns.has(d.call.toUpperCase())) badges += '<span class="ft8-badge ft8-badge-donor" title="POTACAT Supporter">\uD83D\uDC3E</span>';
        if (d.call && d.call.toUpperCase() === 'K3SBP') badges += '<span class="ft8-badge ft8-badge-donor" title="POTACAT Creator">\uD83D\uDC08\u200D\u2B1B</span>';
        const entityStr = d.entity ? '<span class="ft8-entity">' + esc(d.entity) + '</span>' : '';

        const row = document.createElement('div');
        row.className = 'ft8-row' + (isCq ? ' ft8-cq' : '') + (isDirected ? ' ft8-directed' : '') + (isHunt ? ' ft8-hunt' : '') + (isWanted ? ' ft8-wanted' : '') + (d.watched ? ' ft8-watched' : '');
        row.innerHTML =
          '<span class="ft8-db">' + (d.db >= 0 ? '+' : '') + d.db + '</span>' +
          '<span class="ft8-dt">' + (d.dt != null ? (d.dt >= 0 ? '+' : '') + d.dt.toFixed(1) : '') + '</span>' +
          '<span class="ft8-df">' + Math.round(d.df) + '</span>' +
          '<span class="ft8-msg">' + esc(text) + '</span>' +
          (badges ? '<span class="ft8-badges">' + badges + '</span>' : '') +
          entityStr;
        // Click to reply
        row.addEventListener('click', () => ft8ClickDecode(d));
        log.appendChild(row);

        // Plot on FT8 map
        ft8PlotDecode(d);

        // Add directed decodes to My Activity
        if (isDirected) {
          var myLog = document.getElementById('ft8-my-activity');
          var myHeader = document.getElementById('ft8-my-activity-header');
          if (myLog && myHeader) {
            myHeader.classList.remove('hidden');
            myLog.classList.remove('hidden');
            var myRow = row.cloneNode(true);
            myRow.addEventListener('click', () => ft8ClickDecode(d));
            myLog.appendChild(myRow);
            myLog.scrollTop = myLog.scrollHeight;
          }
        }
      });
    }

    // Auto-scroll unless user has scrolled up
    if (!ft8UserScrolled) log.scrollTop = log.scrollHeight;
  }

  function ft8AddTxRow(message) {
    const log = ft8DecodeLogEl;
    const row = document.createElement('div');
    row.className = 'ft8-row ft8-tx';
    row.innerHTML =
      '<span class="ft8-db">TX</span>' +
      '<span class="ft8-msg">' + esc(message) + '</span>';
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function ft8ClickDecode(decode) {
    // If it's a CQ, reply to it
    const text = (decode.text || '').toUpperCase();
    if (text.startsWith('CQ ')) {
      // Parse: CQ [optional dx/na/etc] CALLSIGN GRID
      const parts = text.split(/\s+/);
      let callIdx = 1;
      // Skip CQ modifiers (CQ DX, CQ NA, etc.)
      if (parts.length > 3 && parts[1].length <= 4 && !/[0-9]/.test(parts[1])) callIdx = 2;
      const call = parts[callIdx] || '';
      const grid = parts[callIdx + 1] || '';
      if (call) {
        ft8Send({ type: 'jtcat-reply', call, grid, df: decode.df || 1500, sliceId: decode.sliceId });
      }
    } else if (myCallsign && text.indexOf(myCallsign.toUpperCase()) >= 0) {
      // Directed at us — parse caller and reply (handles CQ→QSO transition on click)
      const parts = text.split(/\s+/);
      const mc = myCallsign.toUpperCase();
      // Format: MYCALL THEIRCALL PAYLOAD — caller is the part that isn't our callsign
      const caller = parts.find(p => p !== mc && /^[A-Z0-9]{3,}/.test(p));
      const gridOrReport = parts[2] || '';
      const grid = /^[A-R]{2}[0-9]{2}$/i.test(gridOrReport) ? gridOrReport : '';
      if (caller) {
        ft8Send({ type: 'jtcat-reply', call: caller, grid, df: decode.df || 1500, sliceId: decode.sliceId });
      }
    } else {
      // Click on a non-CQ, non-directed decode — set TX freq to their freq
      if (decode.df) {
        ft8Send({ type: 'jtcat-set-tx-freq', hz: decode.df });
      }
    }
  }

  // --- QSO Exchange display ---
  function ft8RenderQsoExchange() {
    if (!ft8QsoState || ft8QsoState.phase === 'idle') {
      ft8QsoExchange.classList.add('hidden');
      ft8QsoExchange.innerHTML = '';
      return;
    }
    ft8QsoExchange.classList.remove('hidden');
    const q = ft8QsoState;
    let html = '<div class="ft8-qso-header">' +
      '<span style="font-weight:600;color:#fff">' + esc(q.call || '???') + '</span>' +
      (q.grid ? ' <span style="color:#4fc3f7">' + esc(q.grid) + '</span>' : '') +
      '<button type="button" class="ft8-qso-skip-btn" id="ft8-qso-skip" title="Skip to next message">Skip</button>' +
      '<button type="button" class="ft8-qso-cancel-btn" id="ft8-qso-cancel">&times;</button>' +
      '</div>';

    // Build exchange rows based on mode and phase
    const rows = ft8BuildExchangeRows(q);
    rows.forEach(r => {
      const cls = 'ft8-qso-row' + (r.tx ? ' ft8-qso-tx' : ' ft8-qso-rx') + (r.directed ? ' ft8-qso-directed' : '') + (r.done ? ' ft8-qso-done-row' : '');
      html += '<div class="' + cls + '">' +
        '<span class="ft8-msg">' + (r.tx ? 'TX: ' : 'RX: ') + esc(r.text) + '</span>' +
        (r.active ? ' <span style="color:#ffd740">&#x25C0;</span>' : '') +
        '</div>';
    });

    if (q.phase === 'done') {
      html += '<div class="ft8-qso-done">QSO Complete!</div>';
    }

    ft8QsoExchange.innerHTML = html;

    // Bind skip and cancel buttons
    const skipBtn = document.getElementById('ft8-qso-skip');
    if (skipBtn) skipBtn.addEventListener('click', () => ft8Send({ type: 'jtcat-skip-phase' }));
    const cancelBtn = document.getElementById('ft8-qso-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => ft8Send({ type: 'jtcat-cancel-qso' }));
  }

  function ft8BuildExchangeRows(q) {
    const rows = [];
    const myCall = q.myCall || myCallsign || '';
    if (q.mode === 'cq') {
      // CQ flow: CQ(tx) → reply(rx) → report(tx) → R+rpt(rx) → RR73(tx)
      rows.push({ tx: true, text: 'CQ ' + myCall + ' ' + (q.myGrid || ''), done: true, active: q.phase === 'cq' });
      if (q.call) {
        rows.push({ tx: false, text: q.call + ' ' + myCall + ' ' + (q.grid || ''), directed: true, done: q.phase !== 'cq', active: false });
        rows.push({ tx: true, text: q.call + ' ' + myCall + ' ' + (q.sentReport || '...'), done: ['cq-rr73', 'done'].includes(q.phase), active: q.phase === 'cq-report' });
      }
      if (q.report) {
        rows.push({ tx: false, text: q.call + ' ' + myCall + ' R' + q.report, directed: true, done: ['cq-rr73', 'done'].includes(q.phase), active: false });
        rows.push({ tx: true, text: q.call + ' ' + myCall + ' RR73', done: q.phase === 'done', active: q.phase === 'cq-rr73' });
      }
    } else {
      // Reply flow: reply(tx) → rpt(rx) → R+rpt(tx) → RR73(rx) → 73(tx)
      const theirCall = q.call || '';
      rows.push({ tx: true, text: theirCall + ' ' + myCall + ' ' + (q.myGrid || ''), done: true, active: q.phase === 'reply' });
      if (q.report) {
        rows.push({ tx: false, text: myCall + ' ' + theirCall + ' ' + q.report, directed: true, done: true, active: false });
        rows.push({ tx: true, text: theirCall + ' ' + myCall + ' R' + (q.sentReport || '...'), done: ['73', 'done'].includes(q.phase), active: q.phase === 'r+report' });
      }
      if (q.phase === '73' || q.phase === 'done') {
        rows.push({ tx: false, text: myCall + ' ' + theirCall + ' RR73', directed: true, done: true, active: false });
        rows.push({ tx: true, text: theirCall + ' ' + myCall + ' 73', done: q.phase === 'done', active: q.phase === '73' });
      }
    }
    return rows;
  }

  function ft8UpdateCqBtn() {
    const inQso = ft8QsoState && ft8QsoState.phase !== 'idle' && ft8QsoState.phase !== 'done';
    ft8CqBtn.classList.toggle('active', inQso && ft8QsoState.mode === 'cq');
    ft8CqBtn.textContent = inQso ? (ft8QsoState.call || 'QSO') : 'CQ';
  }

  // --- Countdown timer + progress bar ---
  var ft8CycleBar = document.getElementById('ft8-cycle-bar');
  function ft8StartCountdown() {
    if (ft8CountdownTimer) clearInterval(ft8CountdownTimer);
    const cycleSec = ft8Mode === 'FT2' ? 3.8 : ft8Mode === 'FT4' ? 7.5 : 15;
    ft8CountdownTimer = setInterval(() => {
      const now = Date.now() / 1000;
      const inCycle = now % cycleSec;
      const remaining = cycleSec - inCycle;
      const pct = (inCycle / cycleSec) * 100;
      ft8Countdown.textContent = remaining.toFixed(0) + 's';
      if (ft8CycleBar) ft8CycleBar.style.width = pct + '%';
    }, 250);
  }

  function ft8StopCountdown() {
    if (ft8CountdownTimer) { clearInterval(ft8CountdownTimer); ft8CountdownTimer = null; }
    ft8Countdown.textContent = '--';
    if (ft8CycleBar) ft8CycleBar.style.width = '0%';
  }

  // --- Waterfall rendering ---
  let ft8WfVisible = false;
  function ft8RenderWaterfall(bins) {
    if (!bins || !bins.length) return;
    if (!ft8WfVisible) return;
    const canvas = ft8Waterfall;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    // Shift existing image down by 1 pixel
    const imgData = ctx.getImageData(0, 0, w, h - 1);
    ctx.putImageData(imgData, 0, 1);
    // Draw new row at top
    const step = bins.length / w;
    for (let x = 0; x < w; x++) {
      const idx = Math.floor(x * step);
      const val = bins[idx] || 0;
      // Map 0-255 to color (blue→cyan→yellow→red)
      const r = val > 170 ? 255 : val > 85 ? (val - 85) * 3 : 0;
      const g = val > 170 ? 255 - (val - 170) * 3 : val > 85 ? 255 : val * 3;
      const b = val > 85 ? 0 : 255 - val * 3;
      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      ctx.fillRect(x, 0, 1, 1);
    }
    // Draw TX frequency marker (red bar with black border)
    const txX = Math.round(ft8TxFreqHz / 3000 * w);
    ctx.fillStyle = '#000';
    ctx.fillRect(txX - 2, 0, 5, h);
    ctx.fillStyle = '#ff2222';
    ctx.fillRect(txX - 1, 0, 3, h);
  }

  // --- Control bar event handlers ---

  // TX toggle
  ft8TxBtn.addEventListener('click', () => {
    ft8TxEnabled = !ft8TxEnabled;
    ft8TxBtn.classList.toggle('active', ft8TxEnabled);
    if (!ft8TxEnabled) {
      // Halt TX — also cancel any active QSO
      ft8Send({ type: 'jtcat-cancel-qso' });
    } else {
      ft8Send({ type: 'jtcat-enable-tx', enabled: true });
    }
  });

  // Slot cycle: auto → even → odd → auto
  ft8SlotBtn.addEventListener('click', () => {
    if (ft8TxSlot === 'auto') ft8TxSlot = 'even';
    else if (ft8TxSlot === 'even') ft8TxSlot = 'odd';
    else ft8TxSlot = 'auto';
    ft8SlotBtn.textContent = ft8TxSlot === 'auto' ? 'Auto' : ft8TxSlot === 'even' ? 'Even' : 'Odd';
    ft8Send({ type: 'jtcat-set-tx-slot', slot: ft8TxSlot });
  });

  // CQ button
  ft8CqBtn.addEventListener('click', () => {
    const inQso = ft8QsoState && ft8QsoState.phase !== 'idle' && ft8QsoState.phase !== 'done';
    if (inQso) {
      // Cancel current QSO
      ft8Send({ type: 'jtcat-cancel-qso' });
    } else {
      // Call CQ
      ft8TxEnabled = true;
      ft8TxBtn.classList.add('active');
      ft8Send({ type: 'jtcat-call-cq' });
    }
  });

  // Auto-CQ response
  const ft8AutoCqSelect = document.getElementById('ft8-auto-cq');
  ft8AutoCqSelect.addEventListener('change', () => {
    ft8Send({ type: 'jtcat-auto-cq-mode', mode: ft8AutoCqSelect.value });
    if (ft8AutoCqSelect.value !== 'off') {
      ft8TxEnabled = true;
      ft8TxBtn.classList.add('active');
      ft8Send({ type: 'jtcat-enable-tx', enabled: true });
    }
  });

  // LOG button
  ft8LogBtn.addEventListener('click', () => {
    if (ft8QsoState && ft8QsoState.call) {
      ft8Send({ type: 'jtcat-log-qso' });
      showLogToast('QSO logged: ' + ft8QsoState.call);
    }
  });

  // Track manual scroll in decode log
  ft8DecodeLogEl.addEventListener('scroll', () => {
    const el = ft8DecodeLogEl;
    ft8UserScrolled = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
  });

  // CQ-only filter toggle
  ft8CqFilterBtn.addEventListener('click', () => {
    ft8CqFilter = !ft8CqFilter;
    ft8CqFilterBtn.classList.toggle('active', ft8CqFilter);
  });

  // Wanted-only filter toggle
  if (ft8WantedFilterBtn) {
    ft8WantedFilterBtn.addEventListener('click', () => {
      ft8WantedFilter = !ft8WantedFilter;
      ft8WantedFilterBtn.classList.toggle('active', ft8WantedFilter);
    });
  }

  // Sort by signal strength toggle
  var ft8SortSignalBtn = document.getElementById('ft8-sort-signal');
  if (ft8SortSignalBtn) {
    ft8SortSignalBtn.addEventListener('click', () => {
      ft8SortSignal = !ft8SortSignal;
      ft8SortSignalBtn.classList.toggle('active', ft8SortSignal);
    });
  }

  // Search filter
  var ft8SearchInput = document.getElementById('ft8-search');
  if (ft8SearchInput) {
    ft8SearchInput.addEventListener('input', function() {
      ft8SearchFilter = ft8SearchInput.value.toUpperCase().trim();
    });
  }

  // Multi-slice toggle — tells desktop to start multi-slice engines
  var ft8MultiBtn = document.getElementById('ft8-multi-btn');
  var ft8MultiActive = false;
  if (ft8MultiBtn) {
    ft8MultiBtn.addEventListener('click', function() {
      ft8MultiActive = !ft8MultiActive;
      ft8MultiBtn.classList.toggle('active', ft8MultiActive);
      if (ft8MultiActive) {
        // Read saved multi-slice config or use defaults
        var saved = JSON.parse(localStorage.getItem('echocat-multi-slices') || 'null');
        var slices = saved || [
          { sliceId: 'slice-a', band: '20m', slicePort: 5002 },
          { sliceId: 'slice-b', band: '40m', slicePort: 5003 },
        ];
        // Send to desktop — desktop handles audio capture + engines
        ft8Send({ type: 'jtcat-start-multi-remote', slices: slices.map(function(s) {
          return { sliceId: s.sliceId, mode: ft8Mode, band: s.band, slicePort: s.slicePort, freqKhz: s.freqKhz || 0 };
        }) });
      } else {
        ft8Send({ type: 'jtcat-stop' });
      }
    });
  }

  // FT8 Map toggle
  var ft8MapContainer = document.getElementById('ft8-map-container');
  var ft8MapToggle = document.getElementById('ft8-map-toggle');
  var ft8Map = null;
  var ft8MapMarkers = [];
  var ft8MapVisible = false;

  if (ft8MapToggle) {
    ft8MapToggle.addEventListener('click', function() {
      ft8MapVisible = !ft8MapVisible;
      ft8MapToggle.classList.toggle('active', ft8MapVisible);
      ft8MapContainer.classList.toggle('hidden', !ft8MapVisible);
      if (ft8MapVisible && !ft8Map) {
        ft8Map = L.map(ft8MapContainer, { zoomControl: false, attributionControl: false }).setView([20, 0], 2);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18, className: 'dark-tiles',
        }).addTo(ft8Map);
        // Center on home QTH if available
        if (phoneGrid) {
          var pos = gridToLatLonLocal(phoneGrid);
          if (pos) ft8Map.setView([pos.lat, pos.lon], 4);
        }
      }
      if (ft8Map) setTimeout(function() { ft8Map.invalidateSize(); }, 100);
    });
  }

  function ft8PlotDecode(d) {
    if (!ft8Map || !ft8MapVisible) return;
    if (!d.grid || !d.call) return;
    var pos = gridToLatLonLocal(d.grid);
    if (!pos) return;
    var color = d.newDxcc ? '#e94560' : d.newCall ? '#f0a500' : '#4ecca3';
    var marker = L.circleMarker([pos.lat, pos.lon], {
      radius: 6, fillColor: color, color: color, weight: 1, fillOpacity: 0.7,
    }).bindPopup('<b>' + esc(d.call) + '</b><br>' + (d.entity || '') + '<br>' + (d.grid || ''));
    marker.addTo(ft8Map);
    ft8MapMarkers.push(marker);
    // Cap markers
    if (ft8MapMarkers.length > 200) {
      var old = ft8MapMarkers.shift();
      ft8Map.removeLayer(old);
    }
  }

  // FT8 RX/TX gain sliders — relay to desktop via WebSocket
  var ft8RxGain = document.getElementById('ft8-rx-gain');
  var ft8RxGainVal = document.getElementById('ft8-rx-gain-val');
  var ft8TxGain = document.getElementById('ft8-tx-gain');
  var ft8TxGainVal = document.getElementById('ft8-tx-gain-val');
  // Restore saved gain levels
  var savedFt8Rx = parseInt(localStorage.getItem('echocat-ft8-rx-gain'), 10);
  if (!isNaN(savedFt8Rx) && ft8RxGain) {
    ft8RxGain.value = savedFt8Rx;
    ft8RxGainVal.textContent = savedFt8Rx + '%';
  }
  var savedFt8Tx = parseInt(localStorage.getItem('echocat-ft8-tx-gain'), 10);
  if (!isNaN(savedFt8Tx) && ft8TxGain) {
    ft8TxGain.value = savedFt8Tx;
    ft8TxGainVal.textContent = savedFt8Tx + '%';
  }
  if (ft8RxGain) {
    ft8RxGain.addEventListener('input', function() {
      var pct = parseInt(ft8RxGain.value, 10);
      ft8RxGainVal.textContent = pct + '%';
      localStorage.setItem('echocat-ft8-rx-gain', pct);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'jtcat-rx-gain', value: pct / 100 }));
      }
    });
  }
  if (ft8TxGain) {
    ft8TxGain.addEventListener('input', function() {
      var pct = parseInt(ft8TxGain.value, 10);
      ft8TxGainVal.textContent = pct + '%';
      localStorage.setItem('echocat-ft8-tx-gain', pct);
      // Square curve — same as desktop JTCAT
      var gain = (pct / 100) * (pct / 100);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'jtcat-tx-gain', value: gain }));
      }
    });
  }

  // Waterfall toggle
  const ft8WfToggle = document.getElementById('ft8-wf-toggle');
  // Waterfall starts hidden — button not active until toggled
  ft8WfToggle.addEventListener('click', () => {
    ft8WfVisible = !ft8WfVisible;
    ft8Waterfall.classList.toggle('hidden', !ft8WfVisible);
    ft8WfToggle.classList.toggle('active', ft8WfVisible);
  });

  // Erase button
  ft8EraseBtn.addEventListener('click', () => {
    ft8DecodeLog = [];
    ft8DecodeLogEl.innerHTML = '<div class="ft8-empty">Cleared</div>';
    ft8UserScrolled = false;
  });

  // --- Mode select ---
  ft8ModeSelect.addEventListener('change', () => {
    ft8Mode = ft8ModeSelect.value;
    updateBandFreqs();
    ft8Send({ type: 'jtcat-set-mode', mode: ft8Mode });
    ft8StartCountdown(); // restart with new cycle duration
    // Retune to the active band's new frequency for the selected mode
    const opt = ft8BandSelect.options[ft8BandSelect.selectedIndex];
    if (opt) {
      const freqKhz = parseFloat(opt.dataset.freq);
      ft8Send({ type: 'jtcat-set-band', band: opt.value, freqKhz });
      const hz = freqKhz * 1000;
      if (hz > 100000) { freqDisplay.textContent = formatFreq(hz); currentFreqKhz = freqKhz; }
    }
  });

  // --- Band select ---
  ft8BandSelect.addEventListener('change', () => {
    const opt = ft8BandSelect.options[ft8BandSelect.selectedIndex];
    const band = opt.value;
    const freqKhz = parseFloat(opt.dataset.freq);
    ft8Send({ type: 'jtcat-set-band', band, freqKhz });
    // Immediately update frequency display (don't wait for CAT poll)
    const hz = freqKhz * 1000;
    if (hz > 100000) { freqDisplay.textContent = formatFreq(hz); currentFreqKhz = freqKhz; }
    // Clear decode log on band change
    ft8DecodeLog = [];
    ft8DecodeLogEl.innerHTML = '<div class="ft8-empty">Switching to ' + band + '...</div>';
    ft8UserScrolled = false;
    // Auto-start if not running
    if (!ft8Running) {
      ft8Send({ type: 'jtcat-start', mode: ft8Mode });
    }
  });

  // --- Waterfall tap to set TX freq ---
  ft8Waterfall.addEventListener('click', (e) => {
    const rect = ft8Waterfall.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const fraction = x / rect.width;
    const hz = Math.max(100, Math.min(3000, Math.round(fraction * 3000 / 10) * 10));
    ft8TxFreqHz = hz;
    ft8TxFreqDisplay.textContent = 'TX: ' + hz + ' Hz';
    ft8Send({ type: 'jtcat-set-tx-freq', hz });
  });

  // --- CW Keyer ---
  function updateCwPanelVisibility() {
    var cwTabs = { spots: 1, map: 1, log: 1, activate: 1 };
    var isCwMode = currentMode.toUpperCase() === 'CW';
    var show = cwAvailable && isCwMode && !!cwTabs[activeTab];
    cwPanel.classList.toggle('hidden', !show);
  }

  let cwAvailable = false;
  let cwWpm = 20;
  let cwMode = 'iambicB';
  let cwSidetoneFreq = 600;
  let cwSidetoneVol = 0.8;
  let cwAudioCtx = null;
  let cwOsc = null;
  let cwGain = null;
  let cwKeying = false;

  // Default macros — overridden by server settings if configured
  var DEFAULT_CW_MACROS = [
    { label: 'CQ', text: 'CQ CQ CQ DE {MYCALL} {MYCALL} K' },
    { label: '599', text: 'R UR 599 5NN BK' },
    { label: '73', text: 'RR 73 E E' },
    { label: 'AGN', text: 'AGN AGN PSE' },
    { label: 'TU', text: 'TU DE {MYCALL} K' },
  ];
  var cwMacros = JSON.parse(localStorage.getItem('echocat-cw-macros') || 'null') || DEFAULT_CW_MACROS.slice();

  const cwPanel = document.getElementById('cw-panel');
  const cwIndicator = document.getElementById('cw-indicator');
  const cwWpmLabel = document.getElementById('cw-wpm-label');
  const cwWpmDn = document.getElementById('cw-wpm-dn');
  const cwWpmUp = document.getElementById('cw-wpm-up');
  const cwModeB = document.getElementById('cw-mode-b');
  const cwModeA = document.getElementById('cw-mode-a');
  const cwModeStr = document.getElementById('cw-mode-str');
  const cwToneSlider = document.getElementById('cw-tone-slider');
  const cwToneVal = document.getElementById('cw-tone-val');
  const cwVolSlider = document.getElementById('cw-vol-slider');
  const cwMacroRow = document.getElementById('cw-macro-row');
  const cwTextInput = document.getElementById('cw-text-input');
  const cwTextSend = document.getElementById('cw-text-send');
  const soCwEnable = document.getElementById('so-cw-enable');
  const soCwMacros = document.getElementById('so-cw-macros');

  // Unlock AudioContext on first user interaction (Chromium autoplay policy)
  var cwAudioUnlocked = false;
  function ensureCwAudioCtx() {
    if (!cwAudioCtx) {
      cwAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (cwAudioCtx.state === 'suspended') {
      cwAudioCtx.resume();
    }
    return cwAudioCtx;
  }

  document.addEventListener('touchstart', function unlockCwAudio() {
    ensureCwAudioCtx();
    cwAudioUnlocked = true;
    document.removeEventListener('touchstart', unlockCwAudio);
  }, { once: true });
  document.addEventListener('click', function unlockCwAudioClick() {
    ensureCwAudioCtx();
    cwAudioUnlocked = true;
    document.removeEventListener('click', unlockCwAudioClick);
  }, { once: true });

  function handleCwSidetone(keying) {
    cwKeying = keying;
    if (!cwAudioCtx) ensureCwAudioCtx();
    if (keying) {
      if (cwOsc) return; // already playing
      cwOsc = cwAudioCtx.createOscillator();
      cwOsc.type = 'sine';
      cwOsc.frequency.value = cwSidetoneFreq;
      cwGain = cwAudioCtx.createGain();
      cwGain.gain.value = 0;
      cwOsc.connect(cwGain);
      cwGain.connect(cwAudioCtx.destination);
      cwOsc.start();
      cwGain.gain.linearRampToValueAtTime(cwSidetoneVol, cwAudioCtx.currentTime + 0.005);
    } else {
      if (cwGain) {
        cwGain.gain.linearRampToValueAtTime(0, cwAudioCtx.currentTime + 0.005);
      }
      if (cwOsc) {
        var osc = cwOsc;
        setTimeout(function() { try { osc.stop(); } catch(e){} }, 10);
        cwOsc = null;
        cwGain = null;
      }
    }
  }

  function sendCwConfig() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cw-config', wpm: cwWpm, mode: cwMode }));
    }
  }

  // --- CW text-to-sidetone: synthesize local sidetone for macro/text playback ---
  var MORSE_TABLE = {
    'A':'.-','B':'-...','C':'-.-.','D':'-..','E':'.','F':'..-.','G':'--.','H':'....',
    'I':'..','J':'.---','K':'-.-','L':'.-..','M':'--','N':'-.','O':'---','P':'.--.',
    'Q':'--.-','R':'.-.','S':'...','T':'-','U':'..-','V':'...-','W':'.--','X':'-..-',
    'Y':'-.--','Z':'--..','0':'-----','1':'.----','2':'..---','3':'...--','4':'....-',
    '5':'.....','6':'-....','7':'--...','8':'---..','9':'----.','?':'..--..','=':'-...-',
    '/':'-..-.','.':'.-.-.-',',':'--..--','+':'.-.-.','!':'-.-.--','(':'-.--.',')':'-.--.-',
    '&':'.-...',':':'---...',';':'-.-.-.','\'':'.----.','"':'.-..-.','$':'...-..-','@':'.--.-.',
    '-':'-....-','_':'..--.-'
  };
  var cwTextTimer = null;  // ID for cancelling in-progress playback
  var cwTextOsc = null;    // oscillator for text sidetone (separate from paddle sidetone)
  var cwTextGain = null;

  function playCwTextSidetone(text) {
    // Cancel any in-progress text sidetone
    stopCwTextSidetone();
    if (!text) return;
    ensureCwAudioCtx();

    // Expand {MYCALL} locally for accurate sidetone
    var expanded = text.replace(/\{MYCALL\}/gi, myCallsign || '');
    var upper = expanded.toUpperCase().replace(/[^A-Z0-9\s\?\=\/\.\,\+\!\(\)\&\:\;\'\"\$\@\-\_]/g, '');

    // Build element schedule: array of { tone: bool, durationUnits: N }
    var elements = [];
    for (var ci = 0; ci < upper.length; ci++) {
      var ch = upper[ci];
      if (ch === ' ') {
        // Word gap = 7 units total
        elements.push({ tone: false, units: 7 });
        continue;
      }
      var morse = MORSE_TABLE[ch];
      if (!morse) continue;
      // Inter-character gap (before this char, skip if after word gap)
      if (elements.length > 0 && !(elements[elements.length - 1].units >= 7)) {
        elements.push({ tone: false, units: 3 });
      }
      for (var ei = 0; ei < morse.length; ei++) {
        if (ei > 0) elements.push({ tone: false, units: 1 }); // inter-element gap
        elements.push({ tone: true, units: morse[ei] === '.' ? 1 : 3 });
      }
    }

    if (elements.length === 0) return;

    // Use Web Audio API scheduling for accurate timing (setTimeout is unreliable
    // on mobile — causes garbled sidetone where V sounds like K, etc.)
    var unitSec = 1.2 / cwWpm;
    var ramp = 0.003; // 3ms attack/decay to avoid clicks
    var now = cwAudioCtx.currentTime + 0.01; // small lookahead
    var t = now;

    cwTextOsc = cwAudioCtx.createOscillator();
    cwTextOsc.type = 'sine';
    cwTextOsc.frequency.value = cwSidetoneFreq;
    cwTextGain = cwAudioCtx.createGain();
    cwTextGain.gain.setValueAtTime(0, now);
    cwTextOsc.connect(cwTextGain);
    cwTextGain.connect(cwAudioCtx.destination);
    cwTextOsc.start(now);

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var dur = el.units * unitSec;
      if (el.tone) {
        // Ramp up at start of tone, hold, ramp down at end
        cwTextGain.gain.setValueAtTime(0, t);
        cwTextGain.gain.linearRampToValueAtTime(cwSidetoneVol, t + ramp);
        cwTextGain.gain.setValueAtTime(cwSidetoneVol, t + dur - ramp);
        cwTextGain.gain.linearRampToValueAtTime(0, t + dur);
      }
      t += dur;
    }

    cwTextOsc.stop(t + 0.01);
    cwIndicator.classList.add('active');

    // Clean up after playback completes
    var totalMs = (t - now) * 1000 + 50;
    cwTextTimer = setTimeout(function() {
      cwTextOsc = null;
      cwTextGain = null;
      cwTextTimer = null;
      cwIndicator.classList.remove('active');
    }, totalMs);
  }

  function stopCwTextSidetone() {
    if (cwTextOsc) {
      try { cwTextOsc.stop(); } catch(e) {}
      cwTextOsc = null;
      cwTextGain = null;
    }
    if (cwTextTimer) {
      clearTimeout(cwTextTimer);
      cwTextTimer = null;
    }
    handleCwSidetone(false);
    cwIndicator.classList.remove('active');
  }

  function sendCwText(text) {
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Expand macros: {op_firstname} → operator name or "OM", {call} → tuned callsign
    var expanded = text
      .replace(/\{op_firstname\}/gi, tunedOpName || '')
      .replace(/\{call\}/gi, tunedCallsign || '')
      .replace(/\{state\}/gi, tunedState || '');
    ws.send(JSON.stringify({ type: 'cw-text', text: expanded }));
    playCwTextSidetone(expanded);
  }

  // --- Macro buttons ---
  function renderCwMacros() {
    cwMacroRow.innerHTML = '';
    cwMacros.forEach(function(m, i) {
      if (!m.label && !m.text) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cw-macro-btn';
      btn.textContent = m.label || ('M' + (i + 1));
      btn.title = m.text || '';
      btn.addEventListener('click', function() {
        if (m.text) {
          sendCwText(m.text);
          btn.classList.add('sending');
          setTimeout(function() { btn.classList.remove('sending'); }, 500);
        }
      });
      cwMacroRow.appendChild(btn);
    });
  }
  renderCwMacros();

  // --- Free-text CW input ---
  cwTextSend.addEventListener('click', function() {
    var text = cwTextInput.value.trim();
    if (text) {
      sendCwText(text);
      cwTextInput.value = '';
    }
  });
  cwTextInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      cwTextSend.click();
    }
  });

  // --- Settings: CW enable toggle ---
  function updateCwEnableBtn() {
    soCwEnable.textContent = cwAvailable ? 'On' : 'Off';
    soCwEnable.classList.toggle('active', cwAvailable);
    soCwMacros.classList.toggle('hidden', !cwAvailable);
  }

  soCwEnable.addEventListener('click', function() {
    var newState = !cwAvailable;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cw-enable', enabled: newState }));
    }
    // Optimistic update — server will confirm with cw-available
    cwAvailable = newState;
    updateCwPanelVisibility();
    updateCwEnableBtn();
  });

  // --- Settings: CW macro editor ---
  function loadMacroEditor() {
    for (var i = 0; i < 5; i++) {
      var row = document.getElementById('so-macro-' + (i + 1));
      if (!row) continue;
      var labelInput = row.querySelector('.so-macro-label');
      var textInput = row.querySelector('.so-macro-text');
      var m = cwMacros[i] || { label: '', text: '' };
      labelInput.value = m.label || '';
      textInput.value = m.text || '';
    }
  }

  function saveMacrosFromEditor() {
    var newMacros = [];
    for (var i = 0; i < 5; i++) {
      var row = document.getElementById('so-macro-' + (i + 1));
      if (!row) continue;
      var labelInput = row.querySelector('.so-macro-label');
      var textInput = row.querySelector('.so-macro-text');
      newMacros.push({
        label: (labelInput.value || '').trim(),
        text: (textInput.value || '').trim().toUpperCase(),
      });
    }
    cwMacros = newMacros;
    localStorage.setItem('echocat-cw-macros', JSON.stringify(cwMacros));
    renderCwMacros();
  }

  // Auto-save macros on blur from any macro editor input
  soCwMacros.addEventListener('focusout', function() {
    saveMacrosFromEditor();
  });

  // Load macro editor when settings opened
  var origRigToggle = document.getElementById('rig-ctrl-toggle');
  if (origRigToggle) {
    origRigToggle.addEventListener('click', function() {
      loadMacroEditor();
      updateCwEnableBtn();
    });
  }

  // Sync macros from server settings (if configured on desktop)
  function syncMacrosFromSettings(serverMacros) {
    if (serverMacros && Array.isArray(serverMacros) && serverMacros.length > 0) {
      // Only overwrite if user hasn't customized locally
      var localCustom = localStorage.getItem('echocat-cw-macros');
      if (!localCustom) {
        cwMacros = serverMacros;
        renderCwMacros();
      }
    }
  }

  // WPM buttons
  cwWpmDn.addEventListener('click', function() {
    cwWpm = Math.max(5, cwWpm - 1);
    cwWpmLabel.textContent = cwWpm + ' WPM';
    sendCwConfig();
    updateEchoCwSpotWpm();
  });
  cwWpmUp.addEventListener('click', function() {
    cwWpm = Math.min(50, cwWpm + 1);
    cwWpmLabel.textContent = cwWpm + ' WPM';
    sendCwConfig();
    updateEchoCwSpotWpm();
  });

  // Spotted station WPM display + sync
  var echoSpotWpm = null;
  var echoSpotWpmEl = document.getElementById('cw-spot-wpm-echo');
  var echoWpmSyncBtn = document.getElementById('cw-wpm-sync-echo');

  function updateEchoCwSpotWpm() {
    if (!echoSpotWpmEl || !echoWpmSyncBtn) return;
    if (echoSpotWpm && echoSpotWpm !== cwWpm) {
      echoSpotWpmEl.textContent = 'Theirs: ' + echoSpotWpm;
      echoSpotWpmEl.classList.remove('hidden');
      echoWpmSyncBtn.classList.remove('hidden');
    } else {
      echoSpotWpmEl.classList.add('hidden');
      echoWpmSyncBtn.classList.add('hidden');
    }
  }

  if (echoWpmSyncBtn) {
    echoWpmSyncBtn.addEventListener('click', function() {
      if (echoSpotWpm) {
        cwWpm = echoSpotWpm;
        cwWpmLabel.textContent = cwWpm + ' WPM';
        sendCwConfig();
        updateEchoCwSpotWpm();
      }
    });
  }

  // Mode buttons
  [cwModeB, cwModeA, cwModeStr].forEach(function(btn) {
    btn.addEventListener('click', function() {
      cwMode = btn.dataset.mode;
      cwModeB.classList.toggle('active', cwMode === 'iambicB');
      cwModeA.classList.toggle('active', cwMode === 'iambicA');
      cwModeStr.classList.toggle('active', cwMode === 'straight');
      sendCwConfig();
    });
  });

  // Sidetone frequency slider
  cwToneSlider.addEventListener('input', function() {
    cwSidetoneFreq = parseInt(cwToneSlider.value, 10);
    cwToneVal.textContent = cwSidetoneFreq;
    if (cwOsc) cwOsc.frequency.value = cwSidetoneFreq;
  });

  // Sidetone volume slider
  cwVolSlider.addEventListener('input', function() {
    cwSidetoneVol = parseInt(cwVolSlider.value, 10) / 100;
    if (cwGain && cwKeying) cwGain.gain.value = cwSidetoneVol;
  });

  // --- Keyboard paddle input ---
  // Key mappings per paddle device type
  var PADDLE_KEYS = {
    tinymidi: { dit: '[', dah: ']', match: function(e) { return e.key; } },
    vail:     { dit: 'Control', dah: 'Control', match: function(e) {
      // Vail/VBand: Left Ctrl = dit, Right Ctrl = dah
      // Use e.code as primary (reliable on Android USB HID), e.location as fallback
      if (e.code === 'ControlLeft') return 'dit';
      if (e.code === 'ControlRight') return 'dah';
      if (e.key === 'Control') {
        if (e.location === 1) return 'dit';
        if (e.location === 2) return 'dah';
      }
      return null;
    }},
  };
  var paddleType = localStorage.getItem('echocat-paddle-type') || 'tinymidi';
  var ditDown = false;
  var dahDown = false;

  // --- Web MIDI state ---
  var webMidiSupported = !!navigator.requestMIDIAccess;
  var ecMidiAccess = null;
  var ecMidiInput = null;
  var ecMidiLearning = null; // 'dit' | 'dah' | null
  var ecMidiDitNote = parseInt(localStorage.getItem('echocat-midi-dit-note'), 10);
  var ecMidiDahNote = parseInt(localStorage.getItem('echocat-midi-dah-note'), 10);
  if (isNaN(ecMidiDitNote)) ecMidiDitNote = -1;
  if (isNaN(ecMidiDahNote)) ecMidiDahNote = -1;

  // MIDI DOM refs
  var soMidiConfig   = document.getElementById('so-midi-config');
  var soMidiDevice   = document.getElementById('so-midi-device');
  var midiRefreshBtn = document.getElementById('midi-refresh-btn');
  var midiLearnDit   = document.getElementById('midi-learn-dit');
  var midiLearnDah   = document.getElementById('midi-learn-dah');
  var midiDitDisplay = document.getElementById('midi-dit-note-display');
  var midiDahDisplay = document.getElementById('midi-dah-note-display');
  var midiStatusEl   = document.getElementById('midi-status');

  // Init dropdown from saved value
  var soPaddleType = document.getElementById('so-paddle-type');

  // If Web MIDI unavailable and user had it selected, fall back to keyboard mode
  if (!webMidiSupported && paddleType === 'midi') {
    paddleType = 'tinymidi';
    localStorage.setItem('echocat-paddle-type', paddleType);
  }

  if (soPaddleType) {
    soPaddleType.value = paddleType;
    soPaddleType.addEventListener('change', function() {
      paddleType = soPaddleType.value;
      localStorage.setItem('echocat-paddle-type', paddleType);
      updateMidiConfigVisibility();
    });
  }

  function sendPaddle(contact, state) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'paddle', contact: contact, state: state }));
    }
  }

  function matchPaddleKey(e) {
    var cfg = PADDLE_KEYS[paddleType] || PADDLE_KEYS.tinymidi;
    if (cfg.match !== PADDLE_KEYS.tinymidi.match) {
      // Custom match function (Vail/VBand: distinguish L/R Ctrl by location)
      return cfg.match(e);
    }
    // Simple key match (TinyMIDI: [ = dit, ] = dah)
    if (e.key === cfg.dit) return 'dit';
    if (e.key === cfg.dah) return 'dah';
    return null;
  }

  document.addEventListener('keydown', function(e) {
    if (!cwAvailable) return;
    if (e.repeat) return;
    if (isInputFocused()) return;
    var contact = matchPaddleKey(e);
    if (contact === 'dit') {
      e.preventDefault();
      if (!ditDown) { ditDown = true; sendPaddle('dit', 1); }
    } else if (contact === 'dah') {
      e.preventDefault();
      if (!dahDown) { dahDown = true; sendPaddle('dah', 1); }
    }
  });

  document.addEventListener('keyup', function(e) {
    if (!cwAvailable) return;
    if (isInputFocused()) return;
    var contact = matchPaddleKey(e);
    if (contact === 'dit') {
      e.preventDefault();
      ditDown = false;
      sendPaddle('dit', 0);
    } else if (contact === 'dah') {
      e.preventDefault();
      dahDown = false;
      sendPaddle('dah', 0);
    }
  });

  // --- Web MIDI paddle input ---

  function updateMidiConfigVisibility() {
    if (soMidiConfig) {
      soMidiConfig.classList.toggle('hidden', paddleType !== 'midi');
    }
    if (paddleType === 'midi') {
      if (webMidiSupported) {
        ecPopulateMidiDevices();
      } else {
        ecUpdateMidiStatus('Web MIDI not available in this browser. Try Safari 18+ or Chrome on desktop.', 'error');
      }
    } else {
      ecDisconnectMidi();
    }
  }

  function ecUpdateMidiStatus(text, cssClass) {
    if (!midiStatusEl) return;
    midiStatusEl.textContent = text;
    midiStatusEl.className = '';
    if (cssClass) midiStatusEl.classList.add(cssClass);
  }

  function updateMidiNoteDisplays() {
    if (midiDitDisplay) midiDitDisplay.textContent = ecMidiDitNote >= 0 ? ecMidiDitNote : '--';
    if (midiDahDisplay) midiDahDisplay.textContent = ecMidiDahNote >= 0 ? ecMidiDahNote : '--';
  }

  function ecStopMidiLearn() {
    ecMidiLearning = null;
    if (midiLearnDit) {
      midiLearnDit.textContent = 'Learn';
      midiLearnDit.classList.remove('learning');
    }
    if (midiLearnDah) {
      midiLearnDah.textContent = 'Learn';
      midiLearnDah.classList.remove('learning');
    }
  }

  function ecHandleMidiMessage(msg) {
    var data = msg.data;
    var status = data[0];
    var note = data[1];
    var velocity = data[2];
    var cmd = status & 0xF0;
    var isNoteOn = (cmd === 0x90 && velocity > 0);
    var isNoteOff = (cmd === 0x80 || (cmd === 0x90 && velocity === 0));

    // Learn mode — capture note number
    if (ecMidiLearning && isNoteOn) {
      if (ecMidiLearning === 'dit') {
        ecMidiDitNote = note;
        localStorage.setItem('echocat-midi-dit-note', note);
      } else if (ecMidiLearning === 'dah') {
        ecMidiDahNote = note;
        localStorage.setItem('echocat-midi-dah-note', note);
      }
      ecStopMidiLearn();
      updateMidiNoteDisplays();
      return;
    }

    // Normal operation — map notes to paddle contacts
    if (note === ecMidiDitNote) {
      if (isNoteOn) { if (!ditDown) { ditDown = true; sendPaddle('dit', 1); } }
      else if (isNoteOff) { ditDown = false; sendPaddle('dit', 0); }
    } else if (note === ecMidiDahNote) {
      if (isNoteOn) { if (!dahDown) { dahDown = true; sendPaddle('dah', 1); } }
      else if (isNoteOff) { dahDown = false; sendPaddle('dah', 0); }
    }
  }

  function ecConnectMidi(deviceId) {
    ecDisconnectMidi();
    if (!ecMidiAccess || !deviceId) return;
    var inp = ecMidiAccess.inputs.get(deviceId);
    if (!inp) {
      ecUpdateMidiStatus('Device not found', 'error');
      return;
    }
    ecMidiInput = inp;
    ecMidiInput.onmidimessage = ecHandleMidiMessage;
    localStorage.setItem('echocat-midi-device-id', deviceId);
    ecUpdateMidiStatus('Connected: ' + (inp.name || inp.id), 'connected');
  }

  function ecDisconnectMidi() {
    if (ecMidiInput) {
      ecMidiInput.onmidimessage = null;
      ecMidiInput = null;
    }
    ecStopMidiLearn();
  }

  async function ecPopulateMidiDevices() {
    if (!soMidiDevice) return;
    if (!webMidiSupported) {
      ecUpdateMidiStatus('Web MIDI not available in this browser', 'error');
      return;
    }
    soMidiDevice.innerHTML = '<option value="">— Scanning... —</option>';
    ecUpdateMidiStatus('Requesting MIDI access...', '');
    try {
      if (!ecMidiAccess) {
        ecMidiAccess = await navigator.requestMIDIAccess({ sysex: false });
        ecMidiAccess.onstatechange = function() {
          if (paddleType === 'midi') ecPopulateMidiDevices();
        };
      }
      var inputs = Array.from(ecMidiAccess.inputs.values());
      var outputs = Array.from(ecMidiAccess.outputs.values());
      if (inputs.length > 0) {
        soMidiDevice.innerHTML = '';
        for (var i = 0; i < inputs.length; i++) {
          var opt = document.createElement('option');
          opt.value = inputs[i].id;
          opt.textContent = inputs[i].name || inputs[i].id;
          soMidiDevice.appendChild(opt);
        }
        var savedDevice = localStorage.getItem('echocat-midi-device-id');
        if (savedDevice && ecMidiAccess.inputs.get(savedDevice)) {
          soMidiDevice.value = savedDevice;
        }
        ecConnectMidi(soMidiDevice.value);
        ecUpdateMidiStatus(inputs.length + ' device(s) found', '');
      } else {
        soMidiDevice.innerHTML = '<option value="">— No MIDI devices —</option>';
        var isAndroid = /android/i.test(navigator.userAgent);
        var hint = isAndroid
          ? 'No MIDI inputs found. Try: connect device before loading page, then tap Refresh.'
          : 'MIDI access OK but 0 inputs. Connect device and tap Refresh.';
        ecUpdateMidiStatus(hint, '');
      }
    } catch (err) {
      console.warn('Web MIDI error:', err);
      soMidiDevice.innerHTML = '<option value="">— No MIDI devices —</option>';
      ecUpdateMidiStatus('MIDI error: ' + err.message, 'error');
    }
  }

  // MIDI learn button listeners
  if (midiLearnDit) {
    midiLearnDit.addEventListener('click', function() {
      if (ecMidiLearning === 'dit') { ecStopMidiLearn(); return; }
      ecStopMidiLearn();
      ecMidiLearning = 'dit';
      midiLearnDit.textContent = 'Press...';
      midiLearnDit.classList.add('learning');
    });
  }
  if (midiLearnDah) {
    midiLearnDah.addEventListener('click', function() {
      if (ecMidiLearning === 'dah') { ecStopMidiLearn(); return; }
      ecStopMidiLearn();
      ecMidiLearning = 'dah';
      midiLearnDah.textContent = 'Press...';
      midiLearnDah.classList.add('learning');
    });
  }
  if (midiRefreshBtn) {
    midiRefreshBtn.addEventListener('click', function() {
      ecPopulateMidiDevices();
    });
  }
  if (soMidiDevice) {
    soMidiDevice.addEventListener('change', function() {
      ecConnectMidi(soMidiDevice.value);
    });
  }

  // Init MIDI displays and visibility
  updateMidiNoteDisplays();
  updateMidiConfigVisibility();

  // Auto-connect on page load if paddle type is midi
  if (paddleType === 'midi' && webMidiSupported) {
    setTimeout(function() { ecPopulateMidiDevices(); }, 500);
  }

  // --- SSB Voice Macros ---
  var SSB_MACRO_COUNT = 5;
  var SSB_MAX_DURATION = 30; // seconds
  var ssbMacroLabels = JSON.parse(localStorage.getItem('echocat-ssb-labels') || 'null') || ['CQ', 'ID', '73', '', ''];
  var ssbPanel = document.getElementById('ssb-panel');
  var ssbMacroRow = document.getElementById('ssb-macro-row');
  var ssbDb = null; // IndexedDB instance
  var ssbPlayingIdx = -1; // which macro is currently playing (-1 = none)
  var ssbPlaybackSource = null; // AudioBufferSourceNode
  var ssbPlaybackDest = null; // MediaStreamAudioDestinationNode
  var ssbPlaybackTimer = null;
  var ssbOrigTrack = null; // original mic track to restore after playback
  var ssbRecorder = null; // active MediaRecorder

  // Open IndexedDB for audio storage
  function openSsbDb(cb) {
    if (ssbDb) return cb(ssbDb);
    var req = indexedDB.open('echocat-ssb-macros', 1);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('clips')) {
        db.createObjectStore('clips');
      }
    };
    req.onsuccess = function(e) { ssbDb = e.target.result; cb(ssbDb); };
    req.onerror = function() { console.error('SSB macro DB error'); cb(null); };
  }

  function ssbDbPut(idx, blob, cb) {
    openSsbDb(function(db) {
      if (!db) return cb && cb(false);
      var tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').put(blob, idx);
      tx.oncomplete = function() { cb && cb(true); };
      tx.onerror = function() { cb && cb(false); };
    });
  }

  function ssbDbGet(idx, cb) {
    openSsbDb(function(db) {
      if (!db) return cb(null);
      var tx = db.transaction('clips', 'readonly');
      var req = tx.objectStore('clips').get(idx);
      req.onsuccess = function() { cb(req.result || null); };
      req.onerror = function() { cb(null); };
    });
  }

  function ssbDbDelete(idx, cb) {
    openSsbDb(function(db) {
      if (!db) return cb && cb();
      var tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').delete(idx);
      tx.oncomplete = function() { cb && cb(); };
    });
  }

  // Check which slots have recordings
  function ssbCheckSlots(cb) {
    openSsbDb(function(db) {
      if (!db) return cb([]);
      var tx = db.transaction('clips', 'readonly');
      var store = tx.objectStore('clips');
      var filled = [];
      var remaining = SSB_MACRO_COUNT;
      for (var i = 0; i < SSB_MACRO_COUNT; i++) {
        (function(idx) {
          var req = store.get(idx);
          req.onsuccess = function() {
            if (req.result) filled.push(idx);
            remaining--;
            if (remaining === 0) cb(filled);
          };
          req.onerror = function() {
            remaining--;
            if (remaining === 0) cb(filled);
          };
        })(i);
      }
    });
  }

  // Voice mode detection
  function isVoiceMode(mode) {
    var m = (mode || '').toUpperCase();
    return m === 'USB' || m === 'LSB' || m === 'SSB' || m === 'FM' || m === 'AM';
  }

  function updateSsbPanelVisibility() {
    var voiceTabs = { spots: 1, map: 1, log: 1, activate: 1 };
    var show = isVoiceMode(currentMode) && !!voiceTabs[activeTab] && audioEnabled;
    ssbPanel.classList.toggle('hidden', !show);
  }

  // Render SSB macro buttons in the panel
  function renderSsbMacros() {
    ssbMacroRow.innerHTML = '';
    ssbCheckSlots(function(filled) {
      for (var i = 0; i < SSB_MACRO_COUNT; i++) {
        if (!ssbMacroLabels[i] && filled.indexOf(i) === -1) continue;
        (function(idx) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ssb-macro-btn';
          btn.textContent = ssbMacroLabels[idx] || ('V' + (idx + 1));
          if (filled.indexOf(idx) === -1) {
            btn.style.opacity = '0.3';
            btn.title = 'No recording';
          } else {
            btn.title = 'Tap to play';
            btn.addEventListener('click', function() {
              if (ssbPlayingIdx === idx) {
                stopSsbPlayback();
              } else {
                playSsbMacro(idx, btn);
              }
            });
          }
          // Progress bar element
          var prog = document.createElement('div');
          prog.className = 'ssb-progress';
          prog.style.width = '0%';
          btn.appendChild(prog);
          ssbMacroRow.appendChild(btn);
        })(i);
      }
    });
  }

  // Play an SSB macro: PTT on, swap audio track, play clip, PTT off
  function playSsbMacro(idx, btn) {
    if (ssbPlayingIdx >= 0) stopSsbPlayback();
    if (!audioEnabled || !pc) return;

    ssbDbGet(idx, function(blob) {
      if (!blob) return;

      // Decode audio
      var reader = new FileReader();
      reader.onload = function() {
        var ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        ctx.decodeAudioData(reader.result, function(audioBuffer) {
          ssbPlayingIdx = idx;
          if (btn) btn.classList.add('playing');

          // Create playback graph: AudioBuffer → MediaStreamDestination
          ssbPlaybackDest = ctx.createMediaStreamDestination();
          ssbPlaybackSource = ctx.createBufferSource();
          ssbPlaybackSource.buffer = audioBuffer;
          ssbPlaybackSource.connect(ssbPlaybackDest);

          // Get the sender for our audio track
          var senders = pc.getSenders();
          var audioSender = null;
          for (var s = 0; s < senders.length; s++) {
            if (senders[s].track && senders[s].track.kind === 'audio') {
              audioSender = senders[s];
              break;
            }
          }

          if (!audioSender) {
            console.error('[SSB Macro] No audio sender on peer connection');
            ssbPlayingIdx = -1;
            if (btn) btn.classList.remove('playing');
            return;
          }

          // Save original track to restore later
          ssbOrigTrack = audioSender.track;

          // Swap to playback track
          var playTrack = ssbPlaybackDest.stream.getAudioTracks()[0];
          audioSender.replaceTrack(playTrack).then(function() {
            // Enable the playback track (it's new so enabled by default, but be explicit)
            playTrack.enabled = true;

            // Key PTT directly (can't use pttStart() — it has SSB macro guard that would cancel us)
            pttDown = true;
            pttBtn.classList.add('active');
            txBanner.classList.remove('hidden');
            muteRxAudio(true);
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ptt', state: true }));
            }

            // Start playback
            ssbPlaybackSource.start(0);

            // Progress animation
            var duration = audioBuffer.duration;
            var startTime = Date.now();
            ssbPlaybackTimer = setInterval(function() {
              var elapsed = (Date.now() - startTime) / 1000;
              var pct = Math.min(100, (elapsed / duration) * 100);
              var prog = btn ? btn.querySelector('.ssb-progress') : null;
              if (prog) prog.style.width = pct + '%';
            }, 100);

            // Auto-stop when clip ends
            ssbPlaybackSource.onended = function() {
              stopSsbPlayback();
            };
          }).catch(function(err) {
            console.error('[SSB Macro] replaceTrack failed:', err);
            ssbPlayingIdx = -1;
            if (btn) btn.classList.remove('playing');
          });
        }, function(err) {
          console.error('[SSB Macro] decodeAudioData failed:', err);
        });
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  function stopSsbPlayback() {
    if (ssbPlaybackTimer) { clearInterval(ssbPlaybackTimer); ssbPlaybackTimer = null; }
    if (ssbPlaybackSource) {
      try { ssbPlaybackSource.stop(); } catch(e) {}
      ssbPlaybackSource = null;
    }

    // Restore original mic track
    if (pc && ssbOrigTrack) {
      var senders = pc.getSenders();
      for (var s = 0; s < senders.length; s++) {
        if (senders[s].track && senders[s].track.kind === 'audio') {
          senders[s].replaceTrack(ssbOrigTrack).catch(function(e) {
            console.error('[SSB Macro] restore track failed:', e);
          });
          break;
        }
      }
      ssbOrigTrack = null;
    }

    // Unkey PTT
    pttStop();

    // Reset button state
    var btns = ssbMacroRow.querySelectorAll('.ssb-macro-btn');
    btns.forEach(function(b) {
      b.classList.remove('playing');
      var prog = b.querySelector('.ssb-progress');
      if (prog) prog.style.width = '0%';
    });

    ssbPlayingIdx = -1;
    ssbPlaybackDest = null;
  }

  // Initial render
  renderSsbMacros();

  // --- SSB Macro Recording (Settings) ---
  function initSsbMacroEditor() {
    ssbCheckSlots(function(filled) {
      for (var i = 0; i < SSB_MACRO_COUNT; i++) {
        (function(idx) {
          var row = document.getElementById('so-ssb-' + (idx + 1));
          if (!row) return;
          var labelInput = row.querySelector('.so-macro-label');
          var recBtn = row.querySelector('.so-ssb-rec-btn');
          var durSpan = row.querySelector('.so-ssb-duration');
          var playBtn = row.querySelector('.so-ssb-play-btn');
          var delBtn = row.querySelector('.so-ssb-del-btn');

          // Load label
          labelInput.value = ssbMacroLabels[idx] || '';

          var hasClip = filled.indexOf(idx) >= 0;
          playBtn.disabled = !hasClip;
          delBtn.disabled = !hasClip;

          // Show duration if clip exists
          if (hasClip) {
            ssbDbGet(idx, function(blob) {
              if (!blob) return;
              durSpan.textContent = (blob.size / 1000).toFixed(0) + 'kB';
              // Try to get actual duration
              var url = URL.createObjectURL(blob);
              var audio = new Audio();
              audio.addEventListener('loadedmetadata', function() {
                if (isFinite(audio.duration)) {
                  durSpan.textContent = audio.duration.toFixed(1) + 's';
                }
                URL.revokeObjectURL(url);
              });
              audio.addEventListener('error', function() { URL.revokeObjectURL(url); });
              audio.src = url;
            });
          } else {
            durSpan.textContent = '--';
          }

          // Label auto-save + sync to desktop
          labelInput.addEventListener('change', function() {
            ssbMacroLabels[idx] = (labelInput.value || '').trim();
            localStorage.setItem('echocat-ssb-labels', JSON.stringify(ssbMacroLabels));
            ft8Send({ type: 'voice-macro-sync', idx: idx, label: ssbMacroLabels[idx], audio: '' });
            renderSsbMacros();
          });

          // Record button
          recBtn.onclick = function() {
            if (ssbRecorder && ssbRecorder.state === 'recording') {
              // Stop recording
              ssbRecorder.stop();
              return;
            }
            // Start recording from mic
            navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            }).then(function(stream) {
              var chunks = [];
              var mimeType = getSsbMimeType();
              ssbRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
              ssbRecorder.ondataavailable = function(e) { if (e.data.size > 0) chunks.push(e.data); };
              ssbRecorder.onstop = function() {
                stream.getTracks().forEach(function(t) { t.stop(); });
                recBtn.textContent = 'Rec';
                recBtn.classList.remove('recording');
                if (chunks.length === 0) return;
                var blob = new Blob(chunks, { type: ssbRecorder.mimeType });
                ssbDbPut(idx, blob, function() {
                  initSsbMacroEditor();
                  renderSsbMacros();
                  // Sync to desktop
                  var syncReader = new FileReader();
                  syncReader.onload = function() {
                    var base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(syncReader.result)));
                    ft8Send({ type: 'voice-macro-sync', idx: idx, label: ssbMacroLabels[idx] || '', audio: base64 });
                  };
                  syncReader.readAsArrayBuffer(blob);
                });
              };
              recBtn.textContent = 'Stop';
              recBtn.classList.add('recording');
              ssbRecorder.start();
              // Auto-stop at max duration
              setTimeout(function() {
                if (ssbRecorder && ssbRecorder.state === 'recording') ssbRecorder.stop();
              }, SSB_MAX_DURATION * 1000);
            }).catch(function(err) {
              console.error('[SSB Macro] Record error:', err);
              alert('Could not access microphone: ' + err.message);
            });
          };

          // Preview button
          playBtn.onclick = function() {
            ssbDbGet(idx, function(blob) {
              if (!blob) return;
              var url = URL.createObjectURL(blob);
              var audio = new Audio(url);
              audio.onended = function() { URL.revokeObjectURL(url); };
              audio.play().catch(function() { URL.revokeObjectURL(url); });
            });
          };

          // Delete button
          delBtn.onclick = function() {
            ssbDbDelete(idx, function() {
              initSsbMacroEditor();
              renderSsbMacros();
            });
          };
        })(i);
      }
    });
  }

  function getSsbMimeType() {
    // Safari uses mp4/aac, Chrome uses webm/opus
    if (typeof MediaRecorder !== 'undefined') {
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
      if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
    }
    return '';
  }

  // Load SSB editor when settings opened
  if (origRigToggle) {
    origRigToggle.addEventListener('click', function() {
      initSsbMacroEditor();
    });
  }

  // --- Directory (HF Nets & SWL) ---
  function freqToBandDir(khz) {
    var f = parseFloat(khz);
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
    if (f >= 70000 && f <= 70500) return '4m';
    if (f >= 144000 && f <= 148000) return '2m';
    if (f >= 530 && f <= 1700) return 'MW';
    if (f >= 2300 && f <= 26100) return 'SW';
    return '';
  }

  function getNetCountdown(net) {
    var now = new Date();
    var nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    var parts = (net.startTimeUtc || '0:0').split(':');
    var startMin = parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
    var dur = net.duration || 60;
    var endMin = startMin + dur;
    var days = (net.days || 'Daily').toLowerCase();
    var scheduledToday = days === 'daily';
    if (!scheduledToday) {
      var dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      scheduledToday = days.includes(dayNames[now.getUTCDay()]);
    }
    if (!scheduledToday) return { status: 'off', label: '', sortKey: 9999 };
    var onAir = endMin > 1440 ? (nowMin >= startMin || nowMin < endMin - 1440) : (nowMin >= startMin && nowMin < endMin);
    if (onAir) {
      var remaining = endMin > 1440 && nowMin < startMin ? (endMin - 1440) - nowMin : (endMin > 1440 ? endMin - 1440 - nowMin : endMin - nowMin);
      var rh = Math.floor(remaining / 60), rm = remaining % 60;
      return { status: 'live', label: 'On air \u2014 ' + (rh > 0 ? rh + 'h ' + rm + 'm left' : rm + 'm left'), sortKey: -1000 + nowMin - startMin };
    }
    var minsUntil = startMin - nowMin;
    if (minsUntil < 0) minsUntil += 1440;
    if (minsUntil <= 60) return { status: 'soon', label: 'in ' + minsUntil + 'm', sortKey: minsUntil };
    var h = Math.floor(minsUntil / 60), m = minsUntil % 60;
    var timeStr = m > 0 ? 'in ' + h + 'h ' + m + 'm' : 'in ' + h + 'h';
    return { status: minsUntil <= 120 ? 'soon' : 'today', label: timeStr, sortKey: minsUntil };
  }

  function getSwlCountdown(entry) {
    if (!entry.startTimeUtc || !entry.endTimeUtc) return { status: 'off', label: '', sortKey: 9999 };
    var now = new Date();
    var nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    var sp = entry.startTimeUtc.split(':'), ep = entry.endTimeUtc.split(':');
    var startMin = parseInt(sp[0], 10) * 60 + parseInt(sp[1] || '0', 10);
    var endMin = entry.endTimeUtc === '24:00' ? 1440 : parseInt(ep[0], 10) * 60 + parseInt(ep[1] || '0', 10);
    var onAir = endMin <= startMin ? (nowMin >= startMin || nowMin < endMin) : (nowMin >= startMin && nowMin < endMin);
    if (onAir) {
      var remaining = endMin > nowMin ? endMin - nowMin : endMin + 1440 - nowMin;
      var rh = Math.floor(remaining / 60), rm = remaining % 60;
      return { status: 'live', label: 'On air \u2014 ' + (rh > 0 ? rh + 'h ' + rm + 'm left' : rm + 'm left'), sortKey: -1000 };
    }
    var minsUntil = startMin - nowMin;
    if (minsUntil < 0) minsUntil += 1440;
    if (minsUntil <= 60) return { status: 'soon', label: 'in ' + minsUntil + 'm', sortKey: minsUntil };
    var h = Math.floor(minsUntil / 60), m = minsUntil % 60;
    var timeStr = m > 0 ? 'in ' + h + 'h ' + m + 'm' : 'in ' + h + 'h';
    return { status: minsUntil <= 120 ? 'soon' : 'today', label: timeStr, sortKey: minsUntil };
  }

  function renderDirectoryTab() {
    if (!dirList) return;
    var search = (dirSearch ? dirSearch.value : '').toLowerCase().trim();
    dirList.innerHTML = '';
    if (dirActiveTab === 'nets') {
      renderDirNets(search);
    } else {
      renderDirSwl(search);
    }
  }

  function renderDirNets(search) {
    var entries = directoryNets.map(function(n) {
      return { n: n, band: freqToBandDir(n.frequency), cd: getNetCountdown(n) };
    });
    if (search) {
      entries = entries.filter(function(e) {
        return (e.n.name || '').toLowerCase().includes(search) ||
               (e.n.region || '').toLowerCase().includes(search) ||
               String(e.n.frequency).includes(search);
      });
    }
    entries.sort(function(a, b) { return a.cd.sortKey - b.cd.sortKey || (a.n.name || '').localeCompare(b.n.name || ''); });
    if (entries.length === 0) {
      dirList.innerHTML = '<div class="dir-empty">' + (directoryNets.length === 0 ? 'No directory data \u2014 enable Directory in POTACAT Settings' : 'No matching nets') + '</div>';
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i], n = e.n, cd = e.cd;
      if (cd.status === 'off') continue;
      var card = document.createElement('div');
      card.className = 'dir-card' + (cd.status === 'live' ? ' dir-live' : cd.status === 'soon' ? ' dir-soon' : '');
      var statusHtml = cd.label ? '<span class="dir-card-status ' + cd.status + '">' + cd.label + '</span>' : '';
      card.innerHTML = '<div class="dir-card-row"><span class="dir-card-name">' + (n.name || 'Unknown') + '</span>' + statusHtml + '</div>' +
        '<div class="dir-card-detail"><span class="dir-card-freq">' + (n.frequency || '?') + ' kHz</span> ' + (n.mode || '') + (e.band ? ' \u00b7 ' + e.band : '') +
        (n.days && n.days !== 'Daily' ? ' \u00b7 ' + n.days : '') + '</div>';
      (function(net, band) {
        card.addEventListener('click', function() {
          if (!net.frequency) return;
          var mode = (net.mode || '').toUpperCase();
          if (mode === 'SSB') {
            var lsbBands = { '160m': 1, '80m': 1, '60m': 1, '40m': 1 };
            mode = lsbBands[band] ? 'LSB' : 'USB';
          }
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'tune', freqKhz: String(net.frequency), mode: mode }));
          }
        });
      })(n, e.band);
      dirList.appendChild(card);
    }
  }

  function renderDirSwl(search) {
    var entries = directorySwl.map(function(s) {
      return { s: s, band: freqToBandDir(s.frequency), cd: getSwlCountdown(s) };
    });
    if (search) {
      entries = entries.filter(function(e) {
        return (e.s.station || '').toLowerCase().includes(search) ||
               (e.s.language || '').toLowerCase().includes(search) ||
               String(e.s.frequency).includes(search);
      });
    }
    entries.sort(function(a, b) { return a.cd.sortKey - b.cd.sortKey || (a.s.station || '').localeCompare(b.s.station || ''); });
    if (entries.length === 0) {
      dirList.innerHTML = '<div class="dir-empty">' + (directorySwl.length === 0 ? 'No directory data \u2014 enable Directory in POTACAT Settings' : 'No matching broadcasts') + '</div>';
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i], s = e.s, cd = e.cd;
      if (cd.status === 'off') continue;
      var card = document.createElement('div');
      card.className = 'dir-card' + (cd.status === 'live' ? ' dir-live' : cd.status === 'soon' ? ' dir-soon' : '');
      var statusHtml = cd.label ? '<span class="dir-card-status ' + cd.status + '">' + cd.label + '</span>' : '';
      card.innerHTML = '<div class="dir-card-row"><span class="dir-card-name">' + (s.station || 'Unknown') + '</span>' + statusHtml + '</div>' +
        '<div class="dir-card-detail"><span class="dir-card-freq">' + (s.frequency || '?') + ' kHz</span>' +
        (s.language ? ' \u00b7 ' + s.language : '') + (e.band ? ' \u00b7 ' + e.band : '') +
        (s.powerKw ? ' \u00b7 ' + s.powerKw + 'kW' : '') + '</div>';
      (function(swl) {
        card.addEventListener('click', function() {
          if (!swl.frequency) return;
          var mode = (swl.mode || 'AM').toUpperCase();
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'tune', freqKhz: String(swl.frequency), mode: mode }));
          }
        });
      })(s);
      dirList.appendChild(card);
    }
  }

  // Dir sub-tab clicks
  document.querySelectorAll('.dir-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      dirActiveTab = btn.dataset.dtab;
      document.querySelectorAll('.dir-tab').forEach(function(b) { b.classList.toggle('active', b === btn); });
      renderDirectoryTab();
    });
  });

  if (dirSearch) dirSearch.addEventListener('input', function() { renderDirectoryTab(); });

  // --- Screen Wake Lock (keep phone screen on while connected) ---
  var wakeLock = null;
  var wakeLockVideo = null; // iOS fallback: silent video loop

  async function requestWakeLock() {
    // Try the standard Screen Wake Lock API first
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', function() { wakeLock = null; });
        console.log('[WakeLock] Screen Wake Lock acquired');
        return; // success — no need for fallback
      } catch (e) {
        console.log('[WakeLock] API request failed:', e.message);
      }
    }
    // iOS fallback: use a hidden video element with a MediaStream from a canvas.
    // iOS Safari won't sleep the screen while a video with a live source is playing.
    if (!wakeLockVideo) {
      var canvas = document.createElement('canvas');
      canvas.width = 1; canvas.height = 1;
      wakeLockVideo = document.createElement('video');
      wakeLockVideo.setAttribute('playsinline', '');
      wakeLockVideo.setAttribute('muted', '');
      wakeLockVideo.muted = true;
      wakeLockVideo.style.cssText = 'position:fixed;top:-1px;left:-1px;width:1px;height:1px;opacity:0.01;pointer-events:none;';
      if (canvas.captureStream) {
        wakeLockVideo.srcObject = canvas.captureStream(1);  // 1 FPS
      }
      document.body.appendChild(wakeLockVideo);
    }
    try {
      await wakeLockVideo.play();
      console.log('[WakeLock] iOS canvas-stream fallback active');
    } catch (e) {
      console.log('[WakeLock] iOS fallback failed:', e.message);
    }
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(function() {}); wakeLock = null; }
    if (wakeLockVideo) { wakeLockVideo.pause(); }
  }

  // Re-acquire wake lock when page becomes visible again (OS may release it on tab switch)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && !mainUI.classList.contains('hidden')) {
      requestWakeLock();
    }
  });

  // ── Cloud Sync UI (ECHOCAT) ──────────────────────────────────────

  const echoCloudLogin = document.getElementById('echo-cloud-login');
  const echoCloudAccount = document.getElementById('echo-cloud-account');
  const echoCloudCallsign = document.getElementById('echo-cloud-callsign');
  const echoCloudEmail = document.getElementById('echo-cloud-email');
  const echoCloudPassword = document.getElementById('echo-cloud-password');
  const echoCloudRegisterBtn = document.getElementById('echo-cloud-register-btn');
  const echoCloudSigninBtn = document.getElementById('echo-cloud-signin-btn');
  const echoCloudLoginError = document.getElementById('echo-cloud-login-error');
  const echoCloudUserCallsign = document.getElementById('echo-cloud-user-callsign');
  const echoCloudUserEmail = document.getElementById('echo-cloud-user-email');
  const echoCloudSubStatus = document.getElementById('echo-cloud-sub-status');
  const echoCloudSyncBtn = document.getElementById('echo-cloud-sync-btn');
  const echoCloudUploadBtn = document.getElementById('echo-cloud-upload-btn');
  const echoCloudSyncMsg = document.getElementById('echo-cloud-sync-msg');
  const echoCloudBmacEmail = document.getElementById('echo-cloud-bmac-email');
  const echoCloudBmacVerifyBtn = document.getElementById('echo-cloud-bmac-verify-btn');
  const echoCloudVerifyToggle = document.getElementById('echo-cloud-verify-toggle');
  const echoCloudVerifyPanel = document.getElementById('echo-cloud-verify-panel');
  const echoCloudSignoutBtn = document.getElementById('echo-cloud-signout-btn');

  function echoCloudShowLogin() {
    if (echoCloudLogin) echoCloudLogin.classList.remove('hidden');
    if (echoCloudAccount) echoCloudAccount.classList.add('hidden');
  }

  function echoCloudShowAccount(user) {
    if (echoCloudLogin) echoCloudLogin.classList.add('hidden');
    if (echoCloudAccount) echoCloudAccount.classList.remove('hidden');
    if (echoCloudUserCallsign) echoCloudUserCallsign.textContent = user?.callsign || '';
    if (echoCloudUserEmail) echoCloudUserEmail.textContent = user?.email || '';
    const status = user?.subscriptionStatus || 'inactive';
    if (echoCloudSubStatus) {
      echoCloudSubStatus.textContent = status;
      echoCloudSubStatus.style.color = (status === 'active' || status === 'trial') ? '#4ecca3' : '#e94560';
    }
  }

  function echoCloudShowMsg(text) {
    if (echoCloudSyncMsg) {
      echoCloudSyncMsg.textContent = text;
      echoCloudSyncMsg.classList.remove('hidden');
      setTimeout(() => echoCloudSyncMsg.classList.add('hidden'), 5000);
    }
  }

  function echoCloudShowError(text) {
    if (echoCloudLoginError) {
      echoCloudLoginError.textContent = text;
      echoCloudLoginError.classList.remove('hidden');
      setTimeout(() => echoCloudLoginError.classList.add('hidden'), 6000);
    }
  }

  // Request cloud status when settings overlay opens
  function echoCloudRefresh() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'cloud-get-status' }));
    }
  }

  // Handle cloud messages from server
  function handleCloudMessage(msg) {
    switch (msg.type) {
      case 'cloud-status':
        if (msg.loggedIn) echoCloudShowAccount(msg.user);
        else echoCloudShowLogin();
        break;
      case 'cloud-login-result':
      case 'cloud-register-result':
        if (msg.error) echoCloudShowError(msg.error);
        else if (msg.success) { echoCloudShowAccount(msg.user); echoCloudShowMsg('Signed in!'); }
        break;
      case 'cloud-logout-result':
        echoCloudShowLogin();
        break;
      case 'cloud-sync-result':
        if (msg.error) echoCloudShowMsg('Sync failed: ' + msg.error);
        else echoCloudShowMsg('Synced! ' + (msg.pushed || 0) + ' pushed, ' + (msg.pulled || 0) + ' pulled');
        if (echoCloudSyncBtn) { echoCloudSyncBtn.disabled = false; echoCloudSyncBtn.textContent = 'Sync Now'; }
        break;
      case 'cloud-upload-result':
        if (msg.error) echoCloudShowMsg('Upload failed: ' + msg.error);
        else echoCloudShowMsg('Uploaded ' + (msg.imported || 0) + ' QSOs!');
        if (echoCloudUploadBtn) { echoCloudUploadBtn.disabled = false; echoCloudUploadBtn.textContent = 'Upload Log'; }
        break;
      case 'cloud-verify-result':
      case 'cloud-bmac-result':
        if (msg.status === 'active') echoCloudShowMsg('Membership verified!');
        else echoCloudShowMsg(msg.message || 'Not found');
        echoCloudRefresh();
        break;
    }
  }

  if (echoCloudRegisterBtn) {
    echoCloudRegisterBtn.addEventListener('click', function() {
      const cs = echoCloudCallsign ? echoCloudCallsign.value.trim().toUpperCase() : '';
      const email = echoCloudEmail ? echoCloudEmail.value.trim() : '';
      const pass = echoCloudPassword ? echoCloudPassword.value : '';
      if (!cs || !email || !pass) return echoCloudShowError('Fill in all fields');
      if (pass.length < 8) return echoCloudShowError('Password must be at least 8 characters');
      ws.send(JSON.stringify({ type: 'cloud-register', callsign: cs, email: email, password: pass }));
    });
  }

  if (echoCloudSigninBtn) {
    echoCloudSigninBtn.addEventListener('click', function() {
      const email = echoCloudEmail ? echoCloudEmail.value.trim() : '';
      const pass = echoCloudPassword ? echoCloudPassword.value : '';
      if (!email || !pass) return echoCloudShowError('Enter email and password');
      ws.send(JSON.stringify({ type: 'cloud-login', email: email, password: pass }));
    });
  }

  if (echoCloudSignoutBtn) {
    echoCloudSignoutBtn.addEventListener('click', function() {
      ws.send(JSON.stringify({ type: 'cloud-logout' }));
    });
  }

  if (echoCloudSyncBtn) {
    echoCloudSyncBtn.addEventListener('click', function() {
      echoCloudSyncBtn.disabled = true;
      echoCloudSyncBtn.textContent = 'Syncing...';
      ws.send(JSON.stringify({ type: 'cloud-sync-now' }));
    });
  }

  if (echoCloudUploadBtn) {
    echoCloudUploadBtn.addEventListener('click', function() {
      echoCloudUploadBtn.disabled = true;
      echoCloudUploadBtn.textContent = 'Uploading...';
      ws.send(JSON.stringify({ type: 'cloud-bulk-upload' }));
    });
  }

  if (echoCloudVerifyToggle && echoCloudVerifyPanel) {
    echoCloudVerifyToggle.addEventListener('click', function() {
      echoCloudVerifyPanel.classList.toggle('hidden');
      echoCloudVerifyToggle.textContent = echoCloudVerifyPanel.classList.contains('hidden') ? 'Verify Membership' : 'Cancel';
    });
  }
  if (echoCloudBmacVerifyBtn) {
    echoCloudBmacVerifyBtn.addEventListener('click', function() {
      const bmacEmail = echoCloudBmacEmail ? echoCloudBmacEmail.value.trim() : '';
      if (bmacEmail) {
        ws.send(JSON.stringify({ type: 'cloud-save-bmac-email', bmacEmail: bmacEmail }));
      } else {
        ws.send(JSON.stringify({ type: 'cloud-verify-subscription' }));
      }
      // Collapse panel after verify
      if (echoCloudVerifyPanel) echoCloudVerifyPanel.classList.add('hidden');
      if (echoCloudVerifyToggle) echoCloudVerifyToggle.textContent = 'Verify Membership';
    });
  }

  // Refresh cloud status when settings overlay is opened
  if (settingsOverlay) {
    new MutationObserver(function() {
      if (!settingsOverlay.classList.contains('hidden')) {
        echoCloudRefresh();
      }
    }).observe(settingsOverlay, { attributes: true, attributeFilter: ['class'] });
  }

  // --- Android back button handler ---
  // Intercept browser back to close overlays instead of exiting ECHOCAT
  history.replaceState({ echocat: true }, '');
  history.pushState({ echocat: true }, '');

  window.addEventListener('popstate', function(e) {
    // Try closing overlays in priority order
    if (!settingsOverlay.classList.contains('hidden')) {
      settingsOverlay.classList.add('hidden');
      history.pushState({ echocat: true }, '');
      return;
    }
    if (!modePicker.classList.contains('hidden')) {
      modePicker.classList.add('hidden');
      history.pushState({ echocat: true }, '');
      return;
    }
    if (logSheet && !logSheet.classList.contains('hidden')) {
      closeLogSheet();
      history.pushState({ echocat: true }, '');
      return;
    }
    if (quickLogForm && !quickLogForm.classList.contains('hidden')) {
      quickLogForm.classList.add('hidden');
      history.pushState({ echocat: true }, '');
      return;
    }
    // Nothing to close — push state back so next press also gets caught
    history.pushState({ echocat: true }, '');
  });

  // ── WebSDR (KiwiSDR) RX ──────────────────────────────────
  var kiwiSdrBtn = document.getElementById('kiwi-sdr-btn');
  var soKiwiEnable = document.getElementById('so-kiwi-enable');
  var soKiwiStations = document.getElementById('so-kiwi-stations');
  var soKiwiSave = document.getElementById('so-kiwi-save');
  var kiwiRxEnabled = localStorage.getItem('echocat-kiwi-enabled') === 'true';
  var kiwiRxConnected = false;
  var kiwiConnectedHostE = '';
  var kiwiAudioCtx = null;
  var kiwiNextPlayTime = 0;
  var kiwiStationListE = [];
  var kiwiSelectedIdx = 0;

  function kiwiSetEnabled(on) {
    kiwiRxEnabled = on;
    localStorage.setItem('echocat-kiwi-enabled', on);
    soKiwiEnable.classList.toggle('active', on);
    soKiwiEnable.textContent = on ? 'On' : 'Off';
    if (soKiwiStations) soKiwiStations.style.display = on ? '' : 'none';
    kiwiUpdateSdrBtn();
  }

  function kiwiUpdateSdrBtn() {
    if (!kiwiSdrBtn) return;
    if (kiwiRxEnabled && kiwiStationListE.length > 0 && audioEnabled) {
      kiwiSdrBtn.classList.remove('hidden');
    } else {
      kiwiSdrBtn.classList.add('hidden');
    }
    kiwiSdrBtn.classList.remove('kiwi-active', 'kiwi-connecting');
    if (kiwiRxConnected) {
      kiwiSdrBtn.classList.add('kiwi-active');
      var connSt = kiwiStationListE.find(function (s) { return s.fullHost === kiwiConnectedHostE; });
      kiwiSdrBtn.textContent = connSt ? connSt.label : 'SDR';
    } else {
      var st = kiwiStationListE[kiwiSelectedIdx] || kiwiStationListE[0];
      kiwiSdrBtn.textContent = st ? st.label : 'SDR';
    }
  }

  // Tap: connect/disconnect
  if (kiwiSdrBtn) {
    kiwiSdrBtn.addEventListener('click', function () { kiwiToggleConnect(); });
  }

  function kiwiToggleConnect() {
    if (!kiwiAudioCtx) {
      try { kiwiAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
    console.log('[ECHOCAT-Kiwi] toggle: connected=' + kiwiRxConnected + ' stations=' + kiwiStationListE.length + ' idx=' + kiwiSelectedIdx);
    if (kiwiRxConnected) {
      try { ws.send(JSON.stringify({ type: 'kiwi-disconnect' })); } catch (e) {}
      // Immediately update local state so button responds
      kiwiRxConnected = false;
      kiwiConnectedHostE = '';
      kiwiNextPlayTime = 0;
      muteRxAudio(false); // restore local radio audio
      kiwiUpdateSdrBtn();
    } else {
      var st = kiwiStationListE[kiwiSelectedIdx] || kiwiStationListE[0];
      if (st && ws && ws.readyState === WebSocket.OPEN) {
        var kiwiMsg = JSON.stringify({ type: 'kiwi-connect', host: st.fullHost });
        console.log('[ECHOCAT-Kiwi] sending: ' + kiwiMsg);
        try { ws.send(kiwiMsg); } catch (e) { console.error('[ECHOCAT-Kiwi] send error:', e); }
        _kiwiConnecting = true;
        kiwiConnectedHostE = st.fullHost;
        kiwiSdrBtn.classList.add('kiwi-connecting');
        kiwiSdrBtn.textContent = st.label + '...';
      } else {
        console.log('[ECHOCAT-Kiwi] no station or ws not open: st=' + !!st + ' ws=' + (ws ? ws.readyState : 'null'));
        kiwiSdrBtn.textContent = st ? 'Retry' : 'No SDR';
      }
    }
  }


  function kiwiSanitizeHost(h) {
    return (h || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }

  function kiwiLoadStationsE(s) {
    kiwiStationListE = [];
    var hosts = [s.kiwiSdrHost1 || s.kiwiSdrHost || '', s.kiwiSdrHost2 || '', s.kiwiSdrHost3 || ''];
    var labels = [s.kiwiSdrLabel1 || '', s.kiwiSdrLabel2 || '', s.kiwiSdrLabel3 || ''];
    hosts.forEach(function (h, i) {
      var clean = kiwiSanitizeHost(h);
      if (!clean) return;
      var parts = clean.split(':');
      kiwiStationListE.push({ label: labels[i] || parts[0], host: parts[0], port: parseInt(parts[1], 10) || 8073, fullHost: clean });
    });
    // Populate active station selector
    var sel = document.getElementById('so-kiwi-active');
    if (sel) {
      sel.innerHTML = '';
      kiwiStationListE.forEach(function (st, i) {
        var opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = st.label + ' (' + st.fullHost + ')';
        sel.appendChild(opt);
      });
      sel.value = String(kiwiSelectedIdx);
      sel.addEventListener('change', function () { kiwiSelectedIdx = parseInt(sel.value, 10) || 0; kiwiUpdateSdrBtn(); });
    }
    for (var n = 1; n <= 3; n++) {
      var lbl = document.getElementById('so-kiwi-label-' + n);
      var hst = document.getElementById('so-kiwi-host-' + n);
      if (lbl) lbl.value = labels[n - 1] || '';
      if (hst) hst.value = hosts[n - 1] || '';
    }
    kiwiUpdateSdrBtn();
  }

  if (soKiwiEnable) {
    kiwiSetEnabled(kiwiRxEnabled);
    soKiwiEnable.addEventListener('click', function () { kiwiSetEnabled(!kiwiRxEnabled); });
  }

  if (soKiwiSave) {
    soKiwiSave.addEventListener('click', function () {
      var data = {};
      for (var n = 1; n <= 3; n++) {
        var lbl = document.getElementById('so-kiwi-label-' + n);
        var hst = document.getElementById('so-kiwi-host-' + n);
        data['kiwiSdrLabel' + n] = lbl ? lbl.value.trim() : '';
        data['kiwiSdrHost' + n] = hst ? hst.value.trim() : '';
      }
      ws.send(JSON.stringify({ type: 'save-settings', settings: data }));
      kiwiStationListE = [];
      for (var m = 1; m <= 3; m++) {
        var h = data['kiwiSdrHost' + m];
        if (!h) continue;
        var parts = h.split(':');
        kiwiStationListE.push({ label: data['kiwiSdrLabel' + m] || parts[0], host: parts[0], port: parseInt(parts[1], 10) || 8073, fullHost: h });
      }
      kiwiUpdateSdrBtn();
      soKiwiSave.textContent = 'Saved!';
      setTimeout(function () { soKiwiSave.textContent = 'Save Stations'; }, 1500);
    });
  }

  var _kiwiConnecting = false;

  function handleKiwiMessage(msg) {
    if (msg.type === 'kiwi-status') {
      // Ignore transient disconnect during reconnect to a different station
      if (!msg.connected && _kiwiConnecting) return;
      kiwiRxConnected = msg.connected;
      _kiwiConnecting = false;
      if (msg.host) kiwiConnectedHostE = msg.host;
      if (!msg.connected) kiwiConnectedHostE = '';
      // Mute local radio RX when SDR is active, unmute when off
      muteRxAudio(msg.connected);
      kiwiUpdateSdrBtn();
      var kiwiBadge = document.getElementById('kiwi-rx-badge');
      if (kiwiBadge) kiwiBadge.style.display = msg.connected ? '' : 'none';
      if (!msg.connected) { kiwiNextPlayTime = 0; }
    }
    if (msg.type === 'kiwi-audio' && kiwiRxConnected) {
      if (!window._kiwiAudioRx) window._kiwiAudioRx = 0;
      window._kiwiAudioRx++;
      if (window._kiwiAudioRx <= 3) console.log('[ECHOCAT-Kiwi] audio packet #' + window._kiwiAudioRx + ' len=' + (msg.pcm ? msg.pcm.length : 0));
      try {
        // Use default sample rate (44100/48000) — browser resamples from 12kHz
        if (!kiwiAudioCtx) kiwiAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var sr = msg.sampleRate || 12000;
        var pcm = new Float32Array(msg.pcm);
        // Create buffer at the KiwiSDR's native sample rate — browser handles resampling
        var buf = kiwiAudioCtx.createBuffer(1, pcm.length, sr);
        buf.getChannelData(0).set(pcm);
        var src = kiwiAudioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(kiwiAudioCtx.destination);
        var now = kiwiAudioCtx.currentTime;
        if (kiwiNextPlayTime < now) kiwiNextPlayTime = now;
        src.start(kiwiNextPlayTime);
        kiwiNextPlayTime += pcm.length / sr;
      } catch (e) {
        console.error('[ECHOCAT-Kiwi] audio error:', e);
      }
    }
  }

  // ── POTACAT Speakermic ────────────────────────────────────
  // BLE-connected speaker/microphone for hands-free operation.
  // https://github.com/Waffleslop/potacat-speakermic

  // ── IMA-ADPCM Codec ──
  var SM_STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
  var SM_IDX = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];

  function smAdpcmDecode(input, state) {
    if (input.length < 4) return new Float32Array(0);
    state.p = (input[0] | (input[1] << 8)) << 16 >> 16;
    state.i = Math.min(88, Math.max(0, input[2]));
    var dl = input.length - 4, pcm = new Float32Array(dl * 2), sc = 0;
    for (var b = 0; b < dl; b++) {
      for (var ni = 0; ni < 2; ni++) {
        var nib = ni === 0 ? (input[4 + b] & 0x0F) : ((input[4 + b] >> 4) & 0x0F);
        var step = SM_STEP[state.i], delta = (step >> 3);
        if (nib & 4) delta += step;
        if (nib & 2) delta += (step >> 1);
        if (nib & 1) delta += (step >> 2);
        if (nib & 8) delta = -delta;
        state.p = Math.max(-32768, Math.min(32767, state.p + delta));
        state.i = Math.min(88, Math.max(0, state.i + SM_IDX[nib]));
        pcm[sc++] = state.p / 32768.0;
      }
    }
    return pcm.subarray(0, sc);
  }

  function smAdpcmEncode(pcmInt16, state) {
    var n = pcmInt16.length, out = new Uint8Array(4 + Math.ceil(n / 2));
    out[0] = state.p & 0xFF; out[1] = (state.p >> 8) & 0xFF;
    out[2] = state.i; out[3] = 0;
    var bi = 0, hi = false;
    for (var i = 0; i < n; i++) {
      var step = SM_STEP[state.i], diff = pcmInt16[i] - state.p, nib = 0;
      if (diff < 0) { nib = 8; diff = -diff; }
      if (diff >= step) { nib |= 4; diff -= step; }
      if (diff >= (step >> 1)) { nib |= 2; diff -= (step >> 1); }
      if (diff >= (step >> 2)) { nib |= 1; }
      var d2 = (SM_STEP[state.i] >> 3);
      if (nib & 4) d2 += SM_STEP[state.i];
      if (nib & 2) d2 += (SM_STEP[state.i] >> 1);
      if (nib & 1) d2 += (SM_STEP[state.i] >> 2);
      if (nib & 8) d2 = -d2;
      state.p = Math.max(-32768, Math.min(32767, state.p + d2));
      state.i = Math.min(88, Math.max(0, state.i + SM_IDX[nib]));
      if (!hi) { out[4 + bi] = nib & 0x0F; hi = true; }
      else { out[4 + bi] |= (nib << 4); bi++; hi = false; }
    }
    return out;
  }

  // ── BLE UUIDs ──
  var SM_SVC  = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  var SM_TX   = 'f47ac10b-58cc-4372-a567-0e02b2c30001';
  var SM_RX   = 'f47ac10b-58cc-4372-a567-0e02b2c30002';
  var SM_CTL  = 'f47ac10b-58cc-4372-a567-0e02b2c30003';
  var SM_DEV  = 'f47ac10b-58cc-4372-a567-0e02b2c30004';

  // ── State ──
  var smDevice = null, smServer = null;
  var smTxChar = null, smRxChar = null, smCtlChar = null, smDevChar = null;
  var smConnected = false;
  var smEnabled = localStorage.getItem('echocat-speakermic-enabled') === 'true';
  var smAutoReconnect = localStorage.getItem('echocat-speakermic-auto-reconnect') !== 'false';
  var smBatteryPct = 0;
  var smRxDecState = { p: 0, i: 0 };
  var smTxEncState = { p: 0, i: 0 };
  var smMicTrack = null;
  var smOriginalTrack = null;
  var smCaptureNode = null;
  var smMicAudioCtx = null;
  var smMicBufNode = null;
  var smMicPcmQueue = [];

  // ── DOM Elements ──
  var speakermicBtn = document.getElementById('speakermic-btn');
  var smIcon = document.getElementById('speakermic-icon');
  var smLabel = document.getElementById('speakermic-label');
  var soSmEnable = document.getElementById('so-speakermic-enable');
  var soSmSettings = document.getElementById('so-speakermic-settings');
  var soSmConnect = document.getElementById('so-speakermic-connect');
  var soSmStatus = document.getElementById('so-speakermic-status');
  var soSmDetails = document.getElementById('so-speakermic-details');
  var soSmVolRow = document.getElementById('so-speakermic-vol-row');
  var soSmBattFill = document.getElementById('so-speakermic-batt-fill');
  var soSmBattPct = document.getElementById('so-speakermic-batt-pct');
  var soSmVol = document.getElementById('so-speakermic-vol');
  var soSmVolLabel = document.getElementById('so-speakermic-vol-label');
  var soSmReconnect = document.getElementById('so-speakermic-reconnect');

  // ── Feature Detection ──
  var smHasBluetooth = !!(navigator.bluetooth);

  // ── Enable Toggle ──
  function smSetEnabled(on) {
    smEnabled = on;
    localStorage.setItem('echocat-speakermic-enabled', on);
    if (soSmEnable) {
      soSmEnable.classList.toggle('active', on);
      soSmEnable.textContent = on ? 'On' : 'Off';
    }
    if (soSmSettings) soSmSettings.style.display = on ? '' : 'none';
    if (on && audioEnabled) {
      speakermicBtn.classList.remove('hidden');
    } else {
      speakermicBtn.classList.add('hidden');
      if (smConnected) smDisconnect();
    }
  }

  // Restore saved state
  if (soSmEnable) {
    if (!smHasBluetooth) {
      soSmEnable.textContent = 'N/A';
      soSmEnable.disabled = true;
      soSmEnable.style.opacity = '0.4';
      soSmEnable.parentElement.querySelector('span').textContent = 'Web Bluetooth not supported';
    } else {
      smSetEnabled(smEnabled);
      soSmEnable.addEventListener('click', function () { smSetEnabled(!smEnabled); });
    }
  }

  // Restore volume
  var smSavedVol = localStorage.getItem('echocat-speakermic-vol');
  if (smSavedVol && soSmVol) { soSmVol.value = smSavedVol; soSmVolLabel.textContent = smSavedVol + '%'; }

  // Restore auto-reconnect
  if (soSmReconnect) {
    soSmReconnect.classList.toggle('active', smAutoReconnect);
    soSmReconnect.textContent = smAutoReconnect ? 'On' : 'Off';
    soSmReconnect.addEventListener('click', function () {
      smAutoReconnect = !smAutoReconnect;
      soSmReconnect.classList.toggle('active', smAutoReconnect);
      soSmReconnect.textContent = smAutoReconnect ? 'On' : 'Off';
      localStorage.setItem('echocat-speakermic-auto-reconnect', smAutoReconnect);
    });
  }

  // Volume slider
  if (soSmVol) {
    soSmVol.addEventListener('input', function () {
      var v = parseInt(soSmVol.value);
      soSmVolLabel.textContent = v + '%';
      smSendControl(0x04, v);
      localStorage.setItem('echocat-speakermic-vol', v);
    });
  }

  // ── Connect / Disconnect ──
  async function smConnect() {
    if (!smHasBluetooth) return;
    if (smConnected) return;
    smUpdateBtn('connecting');
    try {
      smDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SM_SVC] }]
      });
      smDevice.addEventListener('gattserverdisconnected', smOnDisconnect);
      smServer = await smDevice.gatt.connect();
      var svc = await smServer.getPrimaryService(SM_SVC);

      smTxChar = await svc.getCharacteristic(SM_TX);
      smRxChar = await svc.getCharacteristic(SM_RX);
      smCtlChar = await svc.getCharacteristic(SM_CTL);
      smDevChar = await svc.getCharacteristic(SM_DEV);

      await smTxChar.startNotifications();
      smTxChar.addEventListener('characteristicvaluechanged', smOnTxAudio);

      await smCtlChar.startNotifications();
      smCtlChar.addEventListener('characteristicvaluechanged', smOnControl);

      // Read initial device info
      try {
        var dv = await smDevChar.readValue();
        smBatteryPct = dv.getUint8(0);
      } catch (e) {}

      // Tell ESP32 to start audio
      smSendControl(0x05, 1);

      // Set saved volume
      var v = parseInt(localStorage.getItem('echocat-speakermic-vol') || '70');
      smSendControl(0x04, v);

      smRxDecState = { p: 0, i: 0 };
      smTxEncState = { p: 0, i: 0 };
      smConnected = true;

      // Set up audio bridges if WebRTC is already connected
      if (pc && audioEnabled) {
        smSetupTxBridge();
        if (remoteAudio && remoteAudio.srcObject) {
          smSetupRxBridge(remoteAudio.srcObject);
        }
      }

      smUpdateBtn('connected');
      smUpdateSettings();
      console.log('[Speakermic] Connected to ' + (smDevice.name || 'device'));
    } catch (err) {
      console.error('[Speakermic] Connect failed:', err);
      smUpdateBtn('error');
      setTimeout(function () { if (!smConnected) smUpdateBtn('idle'); }, 3000);
    }
  }

  function smDisconnect() {
    if (smDevice && smDevice.gatt.connected) {
      try { smSendControl(0x05, 0); } catch (e) {}
      smDevice.gatt.disconnect();
    }
    smCleanupAll();
  }

  function smOnDisconnect() {
    console.log('[Speakermic] Disconnected');
    smCleanupAll();
    if (smAutoReconnect && smEnabled) {
      smUpdateBtn('idle');
      if (soSmStatus) soSmStatus.textContent = 'Disconnected \u2014 tap Mic to reconnect';
    }
  }

  function smCleanupAll() {
    smCleanupAudio();
    smConnected = false;
    smTxChar = null; smRxChar = null; smCtlChar = null; smDevChar = null;
    smServer = null;
    smUpdateBtn('idle');
    smUpdateSettings();
  }

  function smCleanupAudio() {
    if (smOriginalTrack && pc) {
      try {
        var senders = pc.getSenders();
        var audioSender = senders.find(function (s) { return s.track && s.track.kind === 'audio'; });
        if (audioSender) audioSender.replaceTrack(smOriginalTrack).catch(function () {});
      } catch (e) {}
    }
    smOriginalTrack = null;
    smMicTrack = null;
    smMicPcmQueue = [];
    if (smMicBufNode) { try { smMicBufNode.disconnect(); } catch (e) {} smMicBufNode = null; }
    if (smMicAudioCtx) { try { smMicAudioCtx.close(); } catch (e) {} smMicAudioCtx = null; }
    if (smCaptureNode) { try { smCaptureNode.disconnect(); } catch (e) {} smCaptureNode = null; }
  }

  // ── TX Audio Bridge: ESP32 Mic -> WebRTC ──
  function smSetupTxBridge() {
    if (!pc) return;
    var senders = pc.getSenders();
    var audioSender = senders.find(function (s) { return s.track && s.track.kind === 'audio'; });
    if (!audioSender) { console.warn('[Speakermic] No audio sender on pc'); return; }

    smOriginalTrack = audioSender.track;
    smMicAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 8000 });
    smMicPcmQueue = [];

    smMicBufNode = smMicAudioCtx.createScriptProcessor(160, 0, 1);
    smMicBufNode.onaudioprocess = function (e) {
      var out = e.outputBuffer.getChannelData(0);
      if (smMicPcmQueue.length > 0) {
        var frame = smMicPcmQueue.shift();
        for (var i = 0; i < out.length && i < frame.length; i++) out[i] = frame[i];
        for (var j = frame.length; j < out.length; j++) out[j] = 0;
      } else {
        for (var k = 0; k < out.length; k++) out[k] = 0;
      }
    };

    var dest = smMicAudioCtx.createMediaStreamDestination();
    smMicBufNode.connect(dest);
    smMicTrack = dest.stream.getAudioTracks()[0];
    smMicTrack.enabled = false;

    audioSender.replaceTrack(smMicTrack).then(function () {
      console.log('[Speakermic] TX bridge active');
    }).catch(function (err) {
      console.error('[Speakermic] replaceTrack failed:', err);
    });
  }

  // ── RX Audio Bridge: WebRTC -> ESP32 Speaker ──
  function smSetupRxBridge(remoteStream) {
    if (!audioCtx || !gainNode || !smRxChar) return;
    if (smCaptureNode) { try { smCaptureNode.disconnect(); } catch (e) {} }

    var ratio = audioCtx.sampleRate / 8000;
    var buffer = [];
    smTxEncState = { p: 0, i: 0 };

    smCaptureNode = audioCtx.createScriptProcessor(4096, 1, 1);
    smCaptureNode.onaudioprocess = function (e) {
      if (!smConnected || !smRxChar) return;
      var input = e.inputBuffer.getChannelData(0);
      for (var i = 0; i < input.length; i += ratio) {
        var idx = Math.floor(i);
        if (idx < input.length) {
          buffer.push(Math.round(Math.max(-1, Math.min(1, input[idx])) * 32767));
        }
      }
      while (buffer.length >= 160) {
        var frame = new Int16Array(buffer.splice(0, 160));
        var adpcm = smAdpcmEncode(frame, smTxEncState);
        smRxChar.writeValueWithoutResponse(adpcm).catch(function () {});
      }
    };

    gainNode.connect(smCaptureNode);
    smCaptureNode.connect(audioCtx.destination);
    console.log('[Speakermic] RX bridge active');
  }

  // ── BLE Notification Handlers ──
  function smOnTxAudio(event) {
    if (!smConnected) return;
    var data = new Uint8Array(event.target.value.buffer);
    if (data.length < 5) return;
    var pcm = smAdpcmDecode(data, smRxDecState);
    if (pcm.length === 0) return;
    if (smMicTrack && smMicPcmQueue) {
      smMicPcmQueue.push(pcm);
      while (smMicPcmQueue.length > 10) smMicPcmQueue.shift();
    }
  }

  function smOnControl(event) {
    var d = new Uint8Array(event.target.value.buffer);
    if (d.length < 2) return;
    switch (d[0]) {
      case 0x01: // PTT from ESP32 button
        if (d[1] === 1) {
          if (smMicTrack) smMicTrack.enabled = true;
          pttStart();
        } else {
          pttStop();
          if (smMicTrack) smMicTrack.enabled = false;
        }
        break;
      case 0x02: // Battery
        smBatteryPct = d[1];
        smUpdateBtn(smConnected ? 'connected' : 'idle');
        smUpdateBattery(d[1]);
        break;
    }
  }

  function smSendControl(cmd, val) {
    if (!smCtlChar || !smConnected) return;
    var data = new Uint8Array([cmd, val]);
    smCtlChar.writeValueWithResponse(data).catch(function () {});
  }

  // ── UI Updates ──
  function smUpdateBtn(state) {
    if (!speakermicBtn) return;
    speakermicBtn.classList.remove('mic-connected', 'mic-connecting', 'mic-error');
    switch (state) {
      case 'connecting':
        speakermicBtn.classList.add('mic-connecting');
        smLabel.textContent = '...';
        break;
      case 'connected':
        speakermicBtn.classList.add('mic-connected');
        smLabel.textContent = smBatteryPct > 0 ? smBatteryPct + '%' : 'On';
        break;
      case 'error':
        speakermicBtn.classList.add('mic-error');
        smLabel.textContent = 'Err';
        break;
      default:
        smLabel.textContent = 'Mic';
        break;
    }
  }

  function smUpdateSettings() {
    if (!soSmConnect) return;
    if (smConnected) {
      soSmConnect.textContent = 'Disconnect';
      soSmConnect.style.borderColor = 'var(--accent)';
      soSmConnect.style.color = 'var(--accent)';
      soSmStatus.textContent = smDevice ? (smDevice.name || 'Connected') : 'Connected';
      soSmStatus.style.color = 'var(--pota)';
      if (soSmDetails) soSmDetails.style.display = '';
      if (soSmVolRow) soSmVolRow.style.display = '';
      smUpdateBattery(smBatteryPct);
    } else {
      soSmConnect.textContent = 'Connect';
      soSmConnect.style.borderColor = '';
      soSmConnect.style.color = '';
      soSmStatus.textContent = 'Not connected';
      soSmStatus.style.color = 'var(--text-dim)';
      if (soSmDetails) soSmDetails.style.display = 'none';
      if (soSmVolRow) soSmVolRow.style.display = 'none';
    }
  }

  function smUpdateBattery(pct) {
    if (soSmBattFill) soSmBattFill.style.width = pct + '%';
    if (soSmBattPct) soSmBattPct.textContent = pct + '%';
    if (soSmBattFill) {
      if (pct > 25) soSmBattFill.style.background = 'var(--pota)';
      else if (pct > 10) soSmBattFill.style.background = '#facc15';
      else soSmBattFill.style.background = 'var(--accent)';
    }
  }

  // ── Button Handlers ──
  if (speakermicBtn) {
    speakermicBtn.addEventListener('click', function () {
      if (smConnected) smDisconnect();
      else smConnect();
    });
  }
  if (soSmConnect) {
    soSmConnect.addEventListener('click', function () {
      if (smConnected) smDisconnect();
      else smConnect();
    });
  }

  // ── End Speakermic ───────────────────────────────────────

  // Auto-connect on page load
  connect('');
})();
