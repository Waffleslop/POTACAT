// ECHOCAT — Phone-side client
// Runs in Safari/Chrome, no Electron dependencies
(function () {
  'use strict';

  // --- State ---
  let ws = null;
  let spots = [];
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
  let gainNode = null;   // GainNode for volume amplification
  let volBoostLevel = 0; // 0=1x, 1=2x, 2=3x
  const VOL_STEPS = [1, 2, 3];
  let sessionKeepAlive = null; // silent <audio> loop for Media Session anchor

  // Scan
  let scanning = false;
  let scanIndex = 0;
  let scanTimer = null;
  let scanDwell = 7;

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
  let currentNb = false;
  let currentAtu = false;
  let currentVfo = 'A';
  let currentFilterWidth = 0;
  let rigCapabilities = { nb: false, atu: false, vfo: false, filter: false };
  let rigControlsOpen = false;
  let txState = false;

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
  // Settings state from desktop
  let maxAgeMin = 5;
  let distUnit = 'mi';

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
      if (!token) return;
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
        cwPanel.classList.toggle('hidden', !cwAvailable);
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
          // Sync overlay values
          soDwellVal.textContent = scanDwell + 's';
          soRefreshVal.textContent = refreshInterval + 's';
          soMaxageVal.textContent = maxAgeMin + 'm';
          soDistMi.classList.toggle('active', distUnit === 'mi');
          soDistKm.classList.toggle('active', distUnit === 'km');
          if (msg.settings.remoteCwMacros) syncMacrosFromSettings(msg.settings.remoteCwMacros);
        }
        updateCwEnableBtn();
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

      case 'spots':
        spots = msg.data || [];
        renderSpots();
        if (activeTab === 'map') renderMapSpots();
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
        cwPanel.classList.toggle('hidden', !cwAvailable);
        updateCwEnableBtn();
        break;

      case 'cw-state':
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
    }
  }

  // --- Status ---
  function updateStatus(s) {
    if (s.freq > 100000) { // ignore bogus values below 100 kHz
      freqDisplay.textContent = formatFreq(s.freq);
      currentFreqKhz = s.freq / 1000;
    }
    if (s.mode) {
      modeBadge.textContent = s.mode;
      currentMode = s.mode;
      const m = s.mode.toUpperCase();
      const isVoice = (m === 'SSB' || m === 'USB' || m === 'LSB' || m === 'FM' || m === 'AM');
      pttBtn.classList.toggle('hidden', !isVoice);
      estopBtn.classList.toggle('hidden', !isVoice);
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
  var KNOWN_MODES = new Set(['CW', 'SSB', 'FT8', 'FT4', 'FM', 'RTTY']);
  function spotModeCategory(mode) {
    if (!mode) return 'other';
    var m = mode.toUpperCase();
    if (m === 'USB' || m === 'LSB') return 'SSB';
    if (m === 'AM') return 'other';
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
      const workedCheck = (workedToday || workedEver) ? '<span class="worked-check">\u2713</span>' : '';
      const refClass = s.source === 'sota' ? 'sota' : s.source === 'dxc' ? 'dxc' : '';
      const ref = s.reference || s.locationDesc || '';
      const isNet = s.source === 'net';
      const age = isNet ? (s.comments || '') : formatAge(s.spotTime);
      const freqStr = formatSpotFreq(s.frequency);
      const src = s.source || 'pota';
      const newBadge = newPark ? '<span class="new-badge">NEW</span>' : '';
      const logBtn = isNet ? '' : '<button type="button" class="spot-log-btn">Log</button>';
      return `<div class="spot-card ${srcClass}${tunedClass}${newClass}${workedClass}" data-freq="${s.frequency}" data-mode="${s.mode || ''}" data-bearing="${s.bearing || ''}" data-call="${esc(s.callsign)}" data-ref="${esc(ref)}" data-src="${src}">
        <span class="spot-call">${workedCheck}${esc(s.callsign)}${newBadge}</span>
        <span class="spot-freq">${freqStr}</span>
        <span class="spot-dist">${formatSpotDist(s.distance)}</span>
        <span class="spot-ref ${refClass}">${esc(ref)}</span>
        <span class="spot-age">${age}</span>
        ${logBtn}
      </div>`;
    }).join('');
  }

  function formatSpotFreq(kHz) {
    const num = parseFloat(kHz);
    if (isNaN(num)) return kHz;
    return num.toFixed(1);
  }

  const MI_TO_KM = 1.60934;
  function formatSpotDist(miles) {
    if (miles == null) return '';
    const d = distUnit === 'km' ? Math.round(miles * MI_TO_KM) : Math.round(miles);
    return d.toLocaleString() + (distUnit === 'km' ? 'km' : 'mi');
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
    if (mode) modeBadge.textContent = mode;
    tunedFreqKhz = freqKhz;
    spotList.querySelectorAll('.spot-card.tuned').forEach(c => c.classList.remove('tuned'));
    card.classList.add('tuned');
  });

  // --- Multi-select dropdown helpers ---
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
      document.querySelectorAll('.rc-dropdown.open').forEach(d => { if (d !== container) d.classList.remove('open'); });
      container.classList.toggle('open');
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
  initMultiDropdown(bandFilterEl, () => { renderSpots(); if (activeTab === 'map') renderMapSpots(); });
  initMultiDropdown(modeFilterEl, () => { renderSpots(); if (activeTab === 'map') renderMapSpots(); });
  initMultiDropdown(regionFilterEl, () => { renderSpots(); if (activeTab === 'map') renderMapSpots(); });

  // --- Spots dropdown ---
  spotsDropdown.querySelector('.rc-dropdown-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.rc-dropdown.open').forEach(d => { if (d !== spotsDropdown) d.classList.remove('open'); });
    spotsDropdown.classList.toggle('open');
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
    } else if (cb.id === 'rc-hide-worked') {
      hideWorked = cb.checked;
      renderSpots();
      if (activeTab === 'map') renderMapSpots();
    }
  });

  // Close dropdowns on outside tap
  document.addEventListener('click', () => {
    document.querySelectorAll('.rc-dropdown.open').forEach(d => d.classList.remove('open'));
  });

  // --- Sort ---
  sortSelect.addEventListener('change', () => {
    spotSort = sortSelect.value;
    renderSpots();
    if (activeTab === 'map') renderMapSpots();
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
  const STEP_SIZES = [0.1, 0.5, 1, 5, 10, 25, 100];
  let dpStepIdx = 2; // default 1 kHz
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
    updateStepLabel();
  });

  // Step up/down inside dial pad — tunes immediately
  dpStepUp.addEventListener('click', () => {
    const step = STEP_SIZES[dpStepIdx];
    const base = dpInput ? parseFloat(dpInput) : currentFreqKhz;
    if (!base || isNaN(base)) return;
    const newFreq = Math.round((base + step) * 10) / 10;
    dpInput = newFreq.toString();
    updateDpDisplay();
    dpTune(newFreq);
  });

  dpStepDown.addEventListener('click', () => {
    const step = STEP_SIZES[dpStepIdx];
    const base = dpInput ? parseFloat(dpInput) : currentFreqKhz;
    if (!base || isNaN(base)) return;
    const newFreq = Math.round((base - step) * 10) / 10;
    if (newFreq < 100) return;
    dpInput = newFreq.toString();
    updateDpDisplay();
    dpTune(newFreq);
  });

  // Status bar up/down buttons — quick step without opening dial pad
  freqUpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const step = STEP_SIZES[dpStepIdx];
    const newFreq = Math.round((currentFreqKhz + step) * 10) / 10;
    dpTune(newFreq);
  });

  freqDownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const step = STEP_SIZES[dpStepIdx];
    const newFreq = Math.round((currentFreqKhz - step) * 10) / 10;
    if (newFreq >= 100) dpTune(newFreq);
  });

  // --- PTT ---
  function muteRxAudio(mute) {
    if (remoteAudio) remoteAudio.muted = mute;
  }

  function pttStart() {
    if (pttDown) return;
    pttDown = true;
    pttBtn.classList.add('active');
    txBanner.classList.remove('hidden');
    muteRxAudio(true);
    // Unmute mic track so audio reaches radio modulator
    if (localAudioStream) localAudioStream.getAudioTracks().forEach(t => { t.enabled = true; });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ptt', state: true }));
    }
  }

  function pttStop() {
    if (!pttDown) return;
    pttDown = false;
    pttBtn.classList.remove('active');
    txBanner.classList.add('hidden');
    muteRxAudio(false);
    // Re-mute mic track to prevent VOX/feedback TX cycling
    if (localAudioStream) localAudioStream.getAudioTracks().forEach(t => { t.enabled = false; });
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

  estopBtn.addEventListener('click', () => {
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

  // --- Audio (WebRTC) ---
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

  const audioLabel = audioBtn.querySelector('.audio-label');
  function setAudioStatus(text) { audioLabel.textContent = text; }

  let micReady = false;

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
          gainNode = audioCtx.createGain();
          gainNode.gain.value = VOL_STEPS[volBoostLevel];
          gainNode.connect(audioCtx.destination);
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
      pc = new RTCPeerConnection({ iceServers: [] });
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
    if (pc) { pc.close(); pc = null; }
    if (localAudioStream) { localAudioStream.getTracks().forEach(t => t.stop()); localAudioStream = null; }
    if (remoteAudio) { remoteAudio.srcObject = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; gainNode = null; }
    stopSessionKeepAlive();
    audioEnabled = false;
    micReady = false;
    volBoostLevel = 0;
    audioBtn.classList.remove('active');
    volBoostBtn.classList.add('hidden');
    volBoostBtn.classList.remove('active');
    volBoostBtn.querySelector('.speaker-label').textContent = 'Vol 1x';
    audioDot.classList.add('hidden');
    audioDot.classList.remove('connected');
    setAudioStatus('Audio');
  }

  function handleSignal(data) {
    if (!data) return;
    if (data.type === 'sdp') {
      if (!pc) return;
      pc.setRemoteDescription(data.sdp)
        .then(() => {
          if (data.sdp.type === 'offer') {
            return pc.createAnswer().then(answer => {
              return pc.setLocalDescription(answer).then(() => {
                ws.send(JSON.stringify({ type: 'signal', data: { type: 'sdp', sdp: pc.localDescription } }));
              });
            });
          }
        })
        .catch(err => { console.error('SDP error (may recover):', err); });
    } else if (data.type === 'ice') {
      if (pc) pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  // --- Volume Boost (cycles 1x → 2x → 3x) ---
  volBoostBtn.addEventListener('click', () => {
    volBoostLevel = (volBoostLevel + 1) % VOL_STEPS.length;
    var gain = VOL_STEPS[volBoostLevel];
    if (gainNode) gainNode.gain.value = gain;
    // iOS AudioContext may start suspended — resume on user gesture
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    volBoostBtn.querySelector('.speaker-label').textContent = 'Vol ' + gain + 'x';
    volBoostBtn.classList.toggle('active', volBoostLevel > 0);
  });

  // --- Scan ---
  function startScan() {
    const list = getFilteredSpots();
    if (!list.length) return;
    scanning = true;
    scanIndex = 0;
    if (currentFreqKhz) {
      const match = list.findIndex(s => Math.abs(parseFloat(s.frequency) - currentFreqKhz) < 1);
      if (match !== -1) scanIndex = match;
    }
    scanBtn.textContent = 'Stop';
    scanBtn.classList.add('scan-active');
    scanStep();
  }

  function scanStep() {
    if (!scanning) return;
    const list = getFilteredSpots();
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
    scanTimer = setTimeout(() => { scanIndex++; scanStep(); }, scanDwell * 1000);
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

  function switchTab(tab) {
    activeTab = tab;
    tabBar.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    // Hide all content areas
    spotList.classList.add('hidden');
    spotMapEl.classList.add('hidden');
    filterToolbar.classList.add('hidden');
    logTabView.classList.add('hidden');
    logView.classList.add('hidden');
    logbookView.classList.add('hidden');
    if (scanning) stopScan();
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
        const time = c.timeUtc ? c.timeUtc.slice(0, 2) + ':' + c.timeUtc.slice(2, 4) : '';
        const freq = c.freqKhz ? parseFloat(c.freqKhz).toFixed(1) : '';
        return `<div class="contact-row${offClass}">
          <span class="contact-nr">${c.nr || ''}</span>
          <span class="contact-time">${esc(time)}</span>
          <span class="contact-call">${esc(c.callsign)}</span>
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
    tabActivateBadge.textContent = count;
    tabActivateBadge.classList.toggle('hidden', count === 0);
  }

  function updateLogFooter() {
    const total = sessionContacts.length;
    const queued = offlineQueue.length;
    logFooterCount.textContent = total + ' QSO' + (total !== 1 ? 's' : '');
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

  // --- CW Keyer ---
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

  function sendCwText(text) {
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'cw-text', text: text }));
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
    cwPanel.classList.toggle('hidden', !cwAvailable);
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
  });
  cwWpmUp.addEventListener('click', function() {
    cwWpm = Math.min(50, cwWpm + 1);
    cwWpmLabel.textContent = cwWpm + ' WPM';
    sendCwConfig();
  });

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

  // --- Keyboard paddle input (TinyMIDI Keyboard mode: [ = dit, ] = dah) ---
  var ditDown = false;
  var dahDown = false;

  function sendPaddle(contact, state) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'paddle', contact: contact, state: state }));
    }
  }

  document.addEventListener('keydown', function(e) {
    if (!cwAvailable) return;
    if (e.repeat) return;
    if (isInputFocused()) return;
    if (e.key === '[') {
      e.preventDefault();
      if (!ditDown) { ditDown = true; sendPaddle('dit', 1); }
    } else if (e.key === ']') {
      e.preventDefault();
      if (!dahDown) { dahDown = true; sendPaddle('dah', 1); }
    }
  });

  document.addEventListener('keyup', function(e) {
    if (!cwAvailable) return;
    if (isInputFocused()) return;
    if (e.key === '[') {
      e.preventDefault();
      ditDown = false;
      sendPaddle('dit', 0);
    } else if (e.key === ']') {
      e.preventDefault();
      dahDown = false;
      sendPaddle('dah', 0);
    }
  });

  // Auto-connect on page load
  connect('');
})();
