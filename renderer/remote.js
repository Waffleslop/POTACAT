// ECHOCAT — Phone-side client
// Runs in Safari/Chrome, no Electron dependencies

// Top-level error trap — paints any uncaught error or rejected promise
// onto the page in a fixed banner so users don't need DevTools to
// diagnose a broken renderer (KK4DF / KM4CFT / "table won't load"
// reports on v1.5.7 came in with no actionable info because the IIFE
// threw silently and the page rendered partially).
//
// Banner contains a selectable <pre> + a "Copy" button so users on
// phones can ship the stack to support without retyping it.
(function installErrorBanner() {
  function buildBanner() {
    const el = document.createElement('div');
    el.id = 'echocat-fatal-banner';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:var(--accent, #e94560);color:#fff;padding:8px 12px;font:12px/1.4 monospace;max-height:50vh;overflow:auto;border-bottom:2px solid #fff;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';

    const title = document.createElement('span');
    title.textContent = 'ECHOCAT JS error';
    title.style.cssText = 'font-weight:bold;flex:1;';
    header.appendChild(title);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.style.cssText = 'background:#fff;color:#e94560;border:0;padding:4px 10px;border-radius:3px;font:bold 11px monospace;cursor:pointer;flex-shrink:0;';
    copyBtn.addEventListener('click', () => {
      const txt = pre.textContent || '';
      const done = () => {
        const old = copyBtn.textContent;
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = old; }, 1500);
      };
      // Modern path. Fall back to a hidden textarea + execCommand for
      // browsers / contexts where clipboard.writeText isn't available
      // (older Safari, non-HTTPS pages, etc.).
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, () => fallback(txt, done));
      } else {
        fallback(txt, done);
      }
    });
    header.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Reload';
    closeBtn.style.cssText = 'background:#fff;color:#e94560;border:0;padding:4px 10px;border-radius:3px;font:bold 11px monospace;cursor:pointer;flex-shrink:0;';
    closeBtn.addEventListener('click', () => location.reload());
    header.appendChild(closeBtn);

    el.appendChild(header);

    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-user-select:text;cursor:text;';
    el.appendChild(pre);

    const footer = document.createElement('div');
    footer.style.cssText = 'margin-top:6px;font-size:11px;opacity:0.85;';
    footer.textContent = 'Tap Copy and email to casey@potacat.com, then Reload.';
    el.appendChild(footer);

    return { el, pre };
  }

  function fallback(txt, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;top:-9999px;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok && done) done();
    } catch { /* nothing more we can do */ }
  }

  let cached = null;
  function show(msg, src) {
    try {
      if (!cached) {
        cached = buildBanner();
        const append = () => { if (cached && document.body) document.body.appendChild(cached.el); };
        if (document.body) append();
        else document.addEventListener('DOMContentLoaded', append);
      }
      cached.pre.textContent = `${src}\n\n${msg}`;
    } catch (_) { /* don't recurse */ }
  }

  window.addEventListener('error', (e) => {
    // Suppress Safari's "Script error." cross-origin mask. When an async
    // error fires from a script Safari can't fully introspect (CORS-less
    // resource, certain ITP states, transient cert-pinning hiccup) the
    // browser reports `message="Script error."` with empty filename and
    // empty lineno — no stack, no source, no actionable info. The
    // banner ends up showing ":?" / "Script error." which confuses
    // users (cssta@cmox.co 2026-05-05: iOS Safari at the login screen,
    // Reload clears it). Drop it on the floor; the next reload runs
    // clean. Real same-origin errors come through with a stack and
    // useful filename so they still surface.
    const filename = e.filename || '';
    const msg = e.message || '';
    if (!filename && !e.lineno && msg === 'Script error.') return;
    show((e.error && (e.error.stack || e.error.message)) || msg || 'unknown',
         filename + ':' + (e.lineno || '?'));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason || {};
    show(r.stack || r.message || String(r), 'unhandledrejection');
  });
})();

(function () {
  'use strict';

  // --- Popout mode ---
  // A popout window opens via /?view=<tabname>. It shares the main tab's WebSocket
  // state by listening to BroadcastChannel('echocat') instead of authenticating its
  // own WS. User actions (e.g. click-to-tune on the map) are posted back to main
  // as { kind: 'forward', message: {...} } and main forwards them to the server.
  const _popoutParams = new URLSearchParams(location.search);
  const popoutView = _popoutParams.get('view');
  const isPopout = !!popoutView;
  if (isPopout) {
    document.body.classList.add('popout-mode');
    if (popoutView) document.body.classList.add('popout-mode-' + popoutView);
  }
  let bc = null;
  const _popoutClientId = Math.random().toString(36).slice(2, 10);

  // --- State ---
  let ws = null;

  // --- Worked-states / countries map tints (lib/worked-overlay.js, inlined) ---
  // The shack decides which places are worked under ITS scope and sends the
  // statuses (S2C worked-overlay); this page only draws them on the Spots and
  // FT8 maps and relays the legend's switches back (C2S worked-overlay-set,
  // the same settings F6/F7/F8 drive on the desktop).
  let workedOverlayLast = null;
  const workedOverlaySubs = [];
  const workedOverlayApi = {
    workedOverlayGet: () => Promise.resolve(workedOverlayLast),
    onWorkedOverlayState: (cb) => { workedOverlaySubs.push(cb); },
    workedOverlayGeo: () => fetch('/geo/worked-overlay.json', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    workedOverlaySet: (patch) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(Object.assign({ type: 'worked-overlay-set' }, patch || {}))); },
  };
  function workedOverlayReceive(msg) {
    workedOverlayLast = {
      states: !!(msg.show && msg.show.states), countries: !!(msg.show && msg.show.countries),
      scope: msg.scope || 'band-mode', band: msg.band || '', mode: msg.mode || '', confirmedOnly: !!msg.confirmedOnly,
      stateMap: msg.states || {}, countryMap: msg.countries || {}, counts: msg.counts || null,
    };
    for (const cb of workedOverlaySubs) { try { cb(workedOverlayLast); } catch { /* one map's failure never blanks the other */ } }
  }
  function workedOverlayAttach(map) {
    if (!map || map._workedOverlay || !window.WorkedOverlay) return;
    map._workedOverlay = WorkedOverlay.attach(L, map, workedOverlayApi, { web: true });
  }
  let spots = [];
  let donorCallsigns = new Set();
  // bandFilter removed — now multi-select dropdown
  let pttDown = false;
  let storedToken = '';
  let reconnectTimer = null;
  let wasKicked = false;
  let authMode = window.__authMode || 'token'; // 'token' | 'club' | 'none' | 'cookie' — injected by server
  // ECHOCAT Web over POTACAT Cloud: 'cookie' means the HTTP gate served
  // this page on a __Host- cookie (owner device or Guest Pass) and the WS
  // will pre-authenticate on the same cookie — no token box, like 'none'.
  const servedAuthMode = authMode;
  const webCookieMode = () => authMode === 'cookie';
  // A sign-in fragment (#pair=<token> / #pass=<code>.<session>) is consumed
  // by the connect page — but a browser that ALREADY holds a live cookie
  // gets this SPA for that same URL, and then nothing stripped it: the pass
  // code and session id (together, the cookie's value) sat in the address
  // bar, history and any copied link (re-opening a share link, 2026-09-12).
  // Drop it before anything else runs; the credential has done its job.
  if (/^#(pair|pass)=/.test(location.hash || '')) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }
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
  let rxSource = null;   // MediaStreamAudioSourceNode tapping the remote track
  let rxDestConnected = false; // is rxAnalyser → audioCtx.destination wired?
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
  // Skip keys are callsign + TAB + frequency, as on the desktop. The set is
  // the desktop's (spot-hides push, memory only, cleared at 0000Z), so a skip
  // here shows on the desktop and in the app. scanForceUnskipped (un-skipping
  // a WORKED spot) stays this page's own.
  var scanSkipped = new Set();
  var scanForceUnskipped = new Set();
  function spotSkipKey(s) { return s.callsign + '\t' + s.frequency; }

  // Hidden spots: the desktop's ONE list (lib/spot-hides.js), pushed as
  // spot-hides on connect and after every change from any surface, so a hide
  // made here, on the desktop or in the app shows everywhere (K8IKO
  // 2026-10-01). { CALL: { '*' | whole kHz | 'band:20m': expiresAt|null } },
  // null = forever. The row's H button is the band scope: hidden on this band
  // until they QSY to another. The band hides this browser kept before sync
  // are sent up once (first spot-hides), then removed.
  const ECHO_HIDDEN_KEY = 'echocat-hidden-bands';
  var spotHides = {};
  // Mirrors isSpotHidden() in renderer/app.js (pinned by test/spot-hides-test.js).
  function isSpotHiddenByList(call, freq, band) {
    const entry = call && spotHides[String(call).toUpperCase()];
    if (!entry) return false;
    const now = Date.now();
    const live = (exp) => exp === null || (typeof exp === 'number' && exp > now);
    if ('*' in entry && live(entry['*'])) return true;
    if (freq) {
      const k = String(Math.round(parseFloat(freq)));
      if (k in entry && live(entry[k])) return true;
    }
    if (band && ('band:' + band) in entry && live(entry['band:' + band])) return true;
    return false;
  }
  function sendSpotHideOp(obj) {
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch { /* not connected */ }
  }
  function adoptSpotHides(hides) {
    spotHides = (hides && typeof hides === 'object') ? hides : {};
    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem(ECHO_HIDDEN_KEY) || 'null'); } catch { legacy = null; }
    if (legacy && typeof legacy === 'object') {
      for (const call of Object.keys(legacy)) {
        if (!Array.isArray(legacy[call])) continue;
        for (const band of legacy[call]) sendSpotHideOp({ type: 'hide-spot', call: call, key: 'band:' + band });
      }
      try { localStorage.removeItem(ECHO_HIDDEN_KEY); } catch {}
    }
  }
  function toggleCallBandHidden(call, band) {
    if (!call || !band) return false;
    const c = call.toUpperCase();
    const key = 'band:' + band;
    const entry = Object.assign({}, spotHides[c] || {});
    const hidden = key in entry;
    // Applied here at once, then sent; the desktop's echo confirms it.
    if (hidden) delete entry[key]; else entry[key] = null;
    spotHides = Object.assign({}, spotHides);
    if (Object.keys(entry).length) spotHides[c] = entry; else delete spotHides[c];
    sendSpotHideOp(hidden ? { type: 'unhide-spot', call: c, key: key } : { type: 'hide-spot', call: c, key: key });
    return !hidden;
  }

  // Refresh rate
  let refreshInterval = 30;

  // --- Elements ---
  const connectScreen = document.getElementById('connect-screen');
  const tokenInput = document.getElementById('token-input');
  const connectBtn = document.getElementById('connect-btn');
  const connectError = document.getElementById('connect-error');
  const mainUI = document.getElementById('main-ui');

  // Pre-hide connect screen when no token required (server injects __authMode)
  if (authMode === 'none' || authMode === 'cookie') {
    connectScreen.classList.add('hidden');
    mainUI.classList.remove('hidden');
  }
  // Served through the POTACAT Cloud tunnel: a real certificate, so the
  // self-signed "Advanced > Proceed" help would only mislead.
  if (/\.potacat\.com$/i.test(location.hostname)) {
    var certHelpEl = document.getElementById('connect-help-cert');
    if (certHelpEl) certHelpEl.classList.add('hidden');
  }
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
  const logDate = document.getElementById('log-date');
  const logTime = document.getElementById('log-time');
  // "Untouched" flags. The form tracks the radio and the clock until the
  // operator types in a field — after that it is THEIRS and nothing
  // overwrites it. Without this the log sheet froze whatever the frequency
  // happened to be when it opened, so a QSO logged after any retune went
  // into the log on the wrong frequency (LZ3AW 2026-08-29: "WEB Log doesn't
  // follow the frequency").
  let logFreqDirty = false;
  // The callsign being worked as main sees it across EVERY surface (S2C
  // typed-call) — the most recently changed non-empty field, desktop or web.
  let sharedTypedCall = '';
  // A sheet opened from a spot is frozen at the spot's frequency — until the
  // radio actually arrives there, after which it follows the dial like any
  // other (the "only gets the frequency from a spot" half of LZ3AW #12).
  let logFreqPinnedKhz = 0;
  // Activator quick log: same contract, its own flags. It was filled once on
  // tab open and never again — "only after page refresh" (LZ3AW #12).
  let qlFreqDirty = false;
  let qlModeDirty = false;
  let logTimeDirty = false;
  if (logFreq) logFreq.addEventListener('input', () => { logFreqDirty = true; logFreqPinnedKhz = 0; });
  if (logDate) logDate.addEventListener('input', () => { logTimeDirty = true; });
  if (logTime) logTime.addEventListener('input', () => { logTimeDirty = true; });

  /** Stamp the date/time inputs with 'now' in UTC. */
  function logStampNow() {
    const d = new Date();
    if (logDate) logDate.value = d.toISOString().slice(0, 10);
    if (logTime) logTime.value = d.toISOString().slice(11, 16);
  }

  /** Epoch ms from the (possibly edited) UTC date/time inputs; null = now. */
  function logQsoAt() {
    if (!logDate || !logTime || !logDate.value || !logTime.value) return null;
    const ms = Date.parse(logDate.value + 'T' + logTime.value + ':00Z');
    return Number.isFinite(ms) ? ms : null;
  }

  /** Keep the open log sheet in step with the radio and the clock. */
  function logSheetFollowRadio() {
    if (!logSheet || logSheet.classList.contains('hidden')) return;
    if (logFreqDirty && logFreqPinnedKhz && currentFreqKhz && Math.abs(currentFreqKhz - logFreqPinnedKhz) < 0.5) {
      logFreqDirty = false; // the radio reached the spot: follow it from here
      logFreqPinnedKhz = 0;
    }
    if (!logFreqDirty && currentFreqKhz) {
      logFreq.value = String(Math.round(currentFreqKhz * 10) / 10);
    }
    if (!logTimeDirty) logStampNow();
  }
  /** Keep the activator quick log in step with the radio unless the operator typed over it. */
  function quickLogFollowRadio() {
    if (!qlFreq) return;
    if (!qlFreqDirty && currentFreqKhz) qlFreq.value = String(Math.round(currentFreqKhz * 10) / 10);
    if (!qlModeDirty && qlMode && currentMode && qlMode.querySelector('option[value="' + currentMode + '"]')) qlMode.value = currentMode;
  }
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
  const propView = document.getElementById('prop-view'); // here, not with its code: switchTab can run during the initial restore
  const dirList = document.getElementById('dir-list');
  const dirSearch = document.getElementById('dir-search');
  const sortSelect = document.getElementById('sort-select');
  const spotMapEl = document.getElementById('spot-map');
  const mapPopoutBtn = document.getElementById('map-popout-btn');
  if (mapPopoutBtn) {
    mapPopoutBtn.addEventListener('click', () => {
      // Shared window name makes a second click focus the existing popout rather than duplicate it
      const popup = window.open('/?view=map', 'echocat-map', 'width=900,height=700,resizable=yes');
      // Switch main tab to Spots so the user isn't looking at two maps
      if (popup) {
        try { switchTab('spots'); } catch {}
        try { popup.focus(); } catch {}
      }
    });
  }
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
  // Callsign whose map-marker popup should stay open across re-renders. Cleared
  // when the user clicks empty map area or clicks a different spot. Null means
  // "no sticky popup".
  let _openPopupCall = null;
  // Differential marker cache for renderMapSpots — lets us update spots without
  // clearLayers/re-add (which would destroy any open popup and flicker the map).
  // Keys: "<callsign>|<frequency>". Also tracks the home-QTH marker separately.
  const _mapMarkers = {};
  let _mapHomeMarker = null;
  let _mapHomeGrid = null;
  let currentFreqKhz = 0;
  let currentMode = '';
  let currentNoCat = false; // status.noCat: a "No CAT control (VOX)" rig, keyed by its sound card
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
    // LZ3AW items 2 and 30 (2026-10-19), off by default like the desktop's.
    spotter: colPrefs.spotter === true, // who spotted the station
    cqz: colPrefs.cqz === true,         // CQ zone (from the desktop's cty.dat)
    ituz: colPrefs.ituz === true,       // ITU zone
    skip: colPrefs.skip !== false,
    log: colPrefs.log !== false,
    hide: colPrefs.hide !== false,
  };
  // Column ordering — array of column keys in display order
  var defaultColOrder = SpotRow.DEFAULT_COL_ORDER.slice(); // lib/spot-row.js
  var colOrder = colPrefs.order && Array.isArray(colPrefs.order) ? colPrefs.order : defaultColOrder.slice();
  // Ensure any new columns are present in colOrder
  for (var k of defaultColOrder) { if (colOrder.indexOf(k) === -1) colOrder.push(k); }
  function saveColPrefs() { localStorage.setItem('echocat-spot-cols', JSON.stringify({ ...colShow, order: colOrder })); }
  let tunedCallsign = '';
  let tunedOpName = '';
  let tunedCountry = '';
  let tunedRef = '';
  let tunedSig = '';
  let tunedBearing = null; // degrees, computed by main from grid → grid haversine
  let showVfoBearing = localStorage.getItem('echocat-show-vfo-bearing') === 'true';
  let tunedDupe = null; // {callsign, timeUtc, freqKhz, mode} when current tune matches a session contact

  // Phone-side POTA dupe check — same call + same band + same mode anywhere
  // in the current activation's sessionContacts. The session resets when an
  // activation starts/stops on the desktop, so "today UTC" is implicit; we
  // compare on call+band+mode only. Mirrors the desktop's isActivatorDupe.
  function findEchoSessionDupe(call, freqKhz, mode) {
    if (!call || !sessionContacts || !sessionContacts.length) return null;
    const upper = String(call).toUpperCase().trim();
    if (!upper) return null;
    const norm = (x) => {
      const u = (x || '').toUpperCase();
      if (u === 'USB' || u === 'LSB') return 'SSB';
      return u;
    };
    const targetMode = norm(mode);
    const targetBand = freqKhz ? freqToBandLocal(parseFloat(freqKhz)) : null;
    for (const c of sessionContacts) {
      if (!c.callsign || c.callsign.toUpperCase() !== upper) continue;
      if (targetMode && c.mode && norm(c.mode) !== targetMode) continue;
      if (targetBand && c.band && c.band !== targetBand) continue;
      return c;
    }
    return null;
  }
  function freqToBandLocal(khz) {
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
    return null;
  }
  // VFO Lock — mirrors desktop _vfoLocked, synced via WS.
  let vfoLocked = false;
  var qrzNameCache = {}; // callsign -> first name / nickname from QRZ
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
  let directoryLandmarks = [];        // the Landmarks tab (lib/landmarks.js)
  let directoryChannels = [];         // the Channels tab: the shack's saved frequency chart (lib/channels.js)
  let directoryLandmarkCategories = [];
  let dirActiveTab = 'nets';          // 'nets' | 'swl' | 'landmarks'

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
  let dxOnly = false; // only spots the shack stamped isDx (lib/dx-rule.js)
  let workedQsos = new Map();     // callsign -> [{date, ref, band, mode}]
  let wqChunkAccum = [];          // in-flight chunked worked-qsos accumulator
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
  // Callsign filter — VERBATIM copy of lib/call-filter.js (this page cannot
  // load node modules; test/call-filter-test.js pins the copy). Device-local.
  function parseCallFilter(spec) {
    const tokens = String(spec || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
    return tokens.map((t) => ({
      token: t,
      re: new RegExp('^' + t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')),
    }));
  }
  function callMatchesFilter(callsign, matchers) {
    if (!matchers || !matchers.length) return true;
    const c = String(callsign || '').toUpperCase();
    for (let i = 0; i < matchers.length; i++) if (matchers[i].re.test(c)) return true;
    return false;
  }
  const callFilterEl = document.getElementById('rc-call-filter');
  let callFilter = [];
  if (callFilterEl) {
    try { callFilterEl.value = localStorage.getItem('echocat-call-filter') || ''; } catch {}
    callFilter = parseCallFilter(callFilterEl.value);
    callFilterEl.addEventListener('input', () => {
      callFilter = parseCallFilter(callFilterEl.value);
      try { localStorage.setItem('echocat-call-filter', callFilterEl.value); } catch {}
      renderSpots();
      if (activeTab === 'map') renderMapSpots();
    });
  }
  const spotsDropdown = document.getElementById('rc-spots-dropdown');
  // A toolbar dropdown's panel is MOVED to <body> while it is open
  // (openDropdownPanel — the phone toolbar fix), so container.querySelector
  // stops finding it: every filter then read as "nothing checked", the
  // Spots menu's second tap threw, and the worked-row toggles threw inside
  // the worked-qsos handler (LZ3AW round 6, 2026-09-21). Look panels up
  // through here; the first call (at load, while the panel is still in its
  // container) remembers it.
  function ddPanel(container) {
    if (!container) return null;
    if (!container._rcPanel) container._rcPanel = container.querySelector('.rc-dropdown-menu, .rc-spots-panel');
    return container._rcPanel || container;
  }
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

  // A signal report field selects its whole value on focus, as in the
  // ECHOCAT app, so typing "57" replaces the "59" instead of appending to it
  // (KW4FM). One delegated listener covers every form: the Log tab, the quick
  // log, the log sheet and the logbook editor. The deferred setSelectionRange
  // is what iOS Safari needs; select() alone is undone by its tap handling.
  function isRstField(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    if (/(^|-)rst-(sent|rcvd)$/.test(el.id || '')) return true;
    const f = el.getAttribute('data-field');
    return f === 'RST_SENT' || f === 'RST_RCVD';
  }
  // Typing a full report in RST Sent moves on to RST Rcvd, as the desktop's
  // log does (setupRstAutoAdvance): 2 characters on phone modes ("57"), 3 on
  // CW and digital ("579", "-10"). Only typing jumps; deleting never does.
  // The focus handler below then selects Rcvd, so it can be typed over too.
  document.addEventListener('input', (e) => {
    const el = e.target;
    const m = el && el.tagName === 'INPUT' && /^(lt|ql|log)-rst-sent$/.exec(el.id || '');
    if (!m) return;
    if (e.inputType && !e.inputType.startsWith('insert')) return;
    const modeEl = document.getElementById(m[1] + '-mode');
    const mode = ((modeEl && modeEl.value) || '').toUpperCase();
    const want = /^(SSB|USB|LSB|AM|FM)/.test(mode) ? 2 : 3;
    if (el.value.length >= want) {
      const rcvd = document.getElementById(m[1] + '-rst-rcvd');
      if (rcvd) rcvd.focus();
    }
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!isRstField(el)) return;
    setTimeout(() => {
      if (document.activeElement !== el) return;
      try { el.setSelectionRange(0, el.value.length); } catch { el.select(); }
    }, 0);
  });

  // Persistent custom respot text — survives between contacts (KE4WLE bug).
  // Two slots: one for OTA respots (POTA/WWFF/LLOTA share the same template)
  // and one for DX-cluster spots. Saved as raw text WITH placeholders intact
  // so {rst}/{QTH}/{mycallsign} stay dynamic on each render.
  const respotPersist = {
    get(isDxc) {
      try {
        const v = localStorage.getItem(isDxc ? 'echocat-respot-dxc' : 'echocat-respot-ota');
        return v != null ? v : null;
      } catch { return null; }
    },
    set(isDxc, text) {
      try { localStorage.setItem(isDxc ? 'echocat-respot-dxc' : 'echocat-respot-ota', text); } catch {}
    },
  };
  // Save user edits as soon as they leave the field (one-time blur is enough —
  // input event would write on every keystroke). Safe even when the wrap is
  // hidden because the listener is bound once and fields are stable elements.
  function bindRespotPersist(el) {
    if (!el) return;
    el.addEventListener('change', () => {
      const isDxc = el.dataset.dxc === '1';
      respotPersist.set(isDxc, el.value);
    });
  }
  bindRespotPersist(logRespotComment);
  bindRespotPersist(ltRespotComment);
  const ltSave = document.getElementById('lt-save');

  // --- Log as another operator (KD9WI 2026-10-16) ---
  // S2C operators {active, profiles} (desktop capability 'log-as'): with two
  // or more operators set up on the desktop, every log form here shows a
  // chooser, and the pick rides as log-qso.logAs so the desktop writes the
  // QSO into THAT operator's logbook, callsign, QRZ and Cloud. ONE choice for
  // all three forms (one person holds this device), kept until changed; it
  // is dropped if the operator list no longer holds it. A Guest Pass never
  // receives the list.
  let logAsOperators = { active: '', profiles: [] };
  let logAsCall = ''; // '' = the desktop's active operator; LOG_AS_ALL = every operator
  // "Log as: both" (KD9WI 2026-10-17): one choice logs the QSO once for every
  // operator, each into their own logbook (the desktop takes an array).
  const LOG_AS_ALL = '__all';
  const logAsSelects = ['lt-log-as', 'log-log-as', 'ql-log-as'].map(function (id) { return document.getElementById(id); }).filter(Boolean);
  function logAsAllCalls() {
    const active = logAsOperators.active;
    return [active].concat(logAsOperators.profiles.filter(function (c) { return c !== active; }));
  }
  // What log-qso.logAs carries: '' / one callsign / every callsign.
  function logAsValue() { return logAsCall === LOG_AS_ALL ? logAsAllCalls() : logAsCall; }
  function logAsTail() { return logAsCall === LOG_AS_ALL ? ' for ' + logAsAllCalls().join(' and ') : logAsCall ? ' for ' + logAsCall : ''; }
  function logAsSaveLabel(plain) { return logAsCall === LOG_AS_ALL ? 'Save for ' + logAsAllCalls().join(' + ') : logAsCall ? 'Save for ' + logAsCall : plain; }
  function renderLogAsChoosers() {
    const active = logAsOperators.active;
    const others = logAsOperators.profiles.filter(function (c) { return c !== active; });
    const show = !!active && others.length > 0;
    if (logAsCall && logAsCall !== LOG_AS_ALL && !others.includes(logAsCall)) logAsCall = '';
    if (logAsCall === LOG_AS_ALL && !show) logAsCall = '';
    logAsSelects.forEach(function (sel) {
      const wrap = sel.parentElement && sel.parentElement.classList.contains('log-as-wrap') ? sel.parentElement : sel;
      wrap.classList.toggle('hidden', !show);
      sel.innerHTML = show
        ? [active].concat(others).map(function (c) { return '<option value="' + c + '">' + c + (c === active ? ' (active)' : '') + '</option>'; }).join('') +
          '<option value="' + LOG_AS_ALL + '">' + (others.length === 1 ? 'Both (' + active + ' + ' + others[0] + ')' : 'All ' + (others.length + 1) + ' operators') + '</option>'
        : '';
      if (show) sel.value = logAsCall || active;
    });
    if (ltSave) ltSave.textContent = logAsSaveLabel('Save QSO');
    if (logSaveBtn) logSaveBtn.textContent = logAsSaveLabel('Save');
  }
  logAsSelects.forEach(function (sel) {
    sel.addEventListener('change', function () {
      const v = String(sel.value || '');
      logAsCall = v === LOG_AS_ALL ? LOG_AS_ALL : (v.toUpperCase() && v.toUpperCase() !== logAsOperators.active ? v.toUpperCase() : '');
      renderLogAsChoosers();
    });
  });
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
  let lastSolarData = null; // latest solar-data blob (tap the pills for detail)
  let lastFreqOtherHz = 0;  // split TX-side frequency, 0 = split off/hidden

  // Both of these live in the status bar AND in the Full VFO View, which
  // COVERS the status bar — so each renders into both surfaces, and the
  // fullview's renderAll() calls them on open (the data usually arrived long
  // before the panel did). LZ3AW 2026-08-28.
  function renderFreqOther() {
    const on = lastFreqOtherHz > 100000;
    for (const id of ['freq-other-display', 'vf-freq-other']) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (on) {
        el.textContent = 'TX ' + formatFreq(lastFreqOtherHz);
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  }

  function renderSolarPills() {
    const d = lastSolarData;
    if (!d) return;
    const cls = (v, goodMax, warnMax, invert) => {
      if (v == null) return 'sp-warn';
      if (invert) return v >= goodMax ? 'sp-good' : v >= warnMax ? 'sp-warn' : 'sp-bad';
      return v <= goodMax ? 'sp-good' : v <= warnMax ? 'sp-warn' : 'sp-bad';
    };
    for (const id of ['solar-pills', 'vf-solar-pills']) {
      const sp = document.getElementById(id);
      if (!sp) continue;
      sp.innerHTML = '';
      const mk = (label, klass) => {
        const el = document.createElement('span');
        el.className = 'sp-pill ' + klass;
        el.textContent = label;
        sp.appendChild(el);
      };
      if (d.sfi != null) mk('SFI ' + d.sfi, cls(d.sfi, 100, 70, true));
      if (d.kIndex != null) mk('K ' + d.kIndex, cls(d.kIndex, 2, 4, false));
      if (d.aIndex != null) mk('A ' + d.aIndex, cls(d.aIndex, 7, 20, false));
      sp.classList.remove('hidden');
    }
  }
  let lbChunkAccum = [];   // in-flight chunked all-qsos accumulation
  let lbTotal = 0;         // full-log size reported by the server
  let lbTruncated = false; // legacy path only: showing newest slice
  let expandedQsoIdx = -1;
  let ltSelectedType = 'dx';

  // --- FT8/JTCAT state ---
  let ft8Running = false;
  let ft8DecodeLog = [];       // [{cycle, time, mode, results}]
  let ft8TxEnabled = false;
  let ft8TxSlot = 'auto';      // 'auto' | 'even' | 'odd'
  let ft8Transmitting = false;  // true when actively transmitting
  let ft8TxMsg = '';
  // K3SBP 2026-05-03: when a cycle is spent transmitting, the engine's
  // jtcat-decode for that cycle arrives with results=[] (you can't decode
  // while you're transmitting), and the cycle's slot in the decode log
  // ended up blank. Defer the TX row from tx-status to the cycle-decode
  // handler so it lands AFTER the cycle separator instead of before.
  let ft8PendingTxMsg = '';
  let ft8QsoState = null;       // {mode, call, grid, phase, txMsg, report, sentReport} or null
  let ft8CycleSlot = '--';
  let ft8CountdownTimer = null;
  let ft8CycleBoundary = 0;     // epoch ms of next cycle boundary
  let ft8Mode = 'FT8';
  let ft8HuntCall = '';        // callsign we're hunting from spot list
  let ft8UserScrolled = false; // true when user has scrolled up in decode log
  let ft8CqFilter = false;     // CQ-only filter
  let ft8WantedFilter = false; // Wanted-only filter (new DXCC/grid/call)
  let ft8ChaseFilter = false;  // Chase-only filter (matches the chase target)
  let ft8ChaseTarget = '';     // chase tag ('' = none); shared with the desktop
  let ft8SortSignal = false;   // Sort decodes by signal strength
  let ft8SearchFilter = '';    // Text search filter
  let ft8SearchTokens = [];    // split on commas/spaces; a line shows if it contains ANY (LZ3AW 2026-10-16)
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
    '6m': 50313, '2m': 144174, '1.25m': 222065, '23cm': 1296174,
  };

  // WSPR USB dial frequencies (kHz) — kept ONLY for the frequency display;
  // the actual WSPR dial is derived HOST-side from the band name
  // (jtcat-set-band → wsprBands.dialForBand), so the client never tunes
  // from this table. Matches lib/wspr/bands.js.
  const WSPR_BAND_FREQS = {
    '160m': 1836.6, '80m': 3568.6, '60m': 5287.2, '40m': 7038.6, '30m': 10138.7,
    '20m': 14095.6, '17m': 18104.6, '15m': 21094.6, '12m': 24924.6, '10m': 28124.6,
    '6m': 50293.0,
  };
  // JTTY USB dial frequencies (kHz) — the WSJT team's preliminary list for
  // 3.2.0-rc1 (14090 = main meeting place; 14080 is FT4's). Mirrors the
  // popout's JTTY_BAND_FREQS.
  const JTTY_BAND_FREQS = {
    '160m': 1838, '80m': 3575, '60m': 5357, '40m': 7090, '30m': 10140,
    '20m': 14090, '17m': 18100, '15m': 21090, '12m': 24920, '10m': 28090,
    '6m': 50160, '2m': 144160,
  };
  // PSK31 USB dial frequencies (kHz) — the conventional watering holes
  // (40m: 7070 Americas convention). Mirrors the popout's table.
  const PSK_BAND_FREQS = {
    '160m': 1838, '80m': 3580, '60m': 5357, '40m': 7070, '30m': 10142,
    '20m': 14070, '17m': 18100, '15m': 21070, '12m': 24920, '10m': 28120,
    '6m': 50291,
  };

  // Where the FT8 tab last was ({freqKhz, band, mode}); restored on return.
  var ft8TabDial = null;
  /**
   * The dial to return to on the FT8 tab: the remembered one when it is on
   * the band the select shows and the mode is unchanged; otherwise null (the
   * band's own dial). Pure — test/lz3aw-round14-test.js.
   */
  function ft8ReturnDial(left, band, mode) {
    if (!left || !(left.freqKhz > 0)) return null;
    if (left.band !== band || left.mode !== mode) return null;
    return left.freqKhz;
  }

  /** Update band button data-freq attributes for current mode */
  function updateBandFreqs() {
    const table = ft8Mode === 'WSPR' ? WSPR_BAND_FREQS
      : ft8Mode === 'PSK31' ? PSK_BAND_FREQS
      : ft8Mode === 'JTTY' ? JTTY_BAND_FREQS
      : ft8Mode === 'FT2' ? FT2_BAND_FREQS
      : ft8Mode === 'FT4' ? FT4_BAND_FREQS : FT8_BAND_FREQS;
    Array.from(ft8BandSelect.options).forEach(opt => {
      const band = opt.value;
      if (table[band]) opt.dataset.freq = table[band];
    });
  }

  // SSTV DOM refs
  var echoSettings = null; // full settings object — used for SSTV templates
  const sstvView = document.getElementById('sstv-view');

  // ─── Band scope (the radio's own spectrum — FT-710 over USB) ─────────────
  // Mirrors the FT8 strip: subscribe while the view is on screen, the shack
  // streams peak-held bins at ~10 fps, Canvas-2D scroll. Axis maths is the
  // inlined lib/scope-axis.js — the same code the desktop uses, so a tap
  // lands where the label says. Shown only when the shack advertises
  // 'scope' AND the active rig declares nativeScope.
  const scopeView = document.getElementById('scope-view');
  const mailView = document.getElementById('mail-view');
  const scopeTabBtn = document.getElementById('scope-tab-btn');
  let scopeServerOk = false;
  // The desktop replays this page's own keyer (cw-key) instead of re-keying
  // from forwarded paddle contacts. See sendCwKeyStream.
  var cwKeyStreamOk = false;
  let scopeState = null;
  let scopeLatest = null;
  let scopeSubscribedSent = false;
  let scopeTuneStepHz = 1000;   // the shack's synced tuning step (S2C tune-step)
  const scopeLsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
  const scopeLsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } };
  // Level window (plan item 4): the bottom IS the old Floor ('echocat-scope-floor',
  // same key, so a saved floor carries over); the top starts at full scale.
  let scopeRange = { lo: Number(scopeLsGet('echocat-scope-floor', 0)) || 0, hi: Number(scopeLsGet('echocat-scope-top', 255)) || 255 };
  let scopeAvg = scopeLsGet('echocat-scope-avg', 'light');
  let scopePeakOn = scopeLsGet('echocat-scope-peak', '0') === '1';
  let scopePeakDecay = scopeLsGet('echocat-scope-peak-decay', 'slow');
  let scopeSUnits = scopeLsGet('echocat-scope-sunits', '0') === '1';
  // Licence-privilege shading: on by default (Casey 10/28).
  let scopePrivileges = scopeLsGet('echocat-scope-privileges', '1') !== '0';
  // Averaging + peak hold run on the RAW levels (the readout reads them).
  let scopeSmooth = null, scopePeak = null;
  let ft8BsOn = (() => { try { return localStorage.getItem('echocat-ft8-bandscope') === '1'; } catch { return false; } })();

  // Two places draw the same stream: the Scope tab, and a strip above the FT8
  // tab's audio waterfall. One frame handler, one state handler, N surfaces.
  // `full` = the Scope tab: level gutter, readout, peak hold; the FT8 strip
  // gets the frequency scale only.
  const scopeSurfaces = [
    { trace: document.getElementById('scope-phone-trace'), wf: document.getElementById('scope-phone-wf'), freq: document.getElementById('scope-phone-freq'),
      status: 'scope-phone-status', span: 'scope-phone-span', full: true,
      visible: (tab) => tab === 'scope' },
    { trace: document.getElementById('ft8-bs-trace'), wf: document.getElementById('ft8-bs-wf'), freq: document.getElementById('ft8-bs-freq'),
      status: 'ft8-bs-status', span: 'ft8-bs-span', full: false,
      visible: (tab) => tab === 'ft8' && ft8BsOn && scopeAvailable() },
  ];

  function ft8ScopeIsFlex() { return !!(rigCapabilities && rigCapabilities.nativeScope === 'flex'); }
  function scopeAvailable() {
    return !!(scopeServerOk && window.ScopeAxis && rigCapabilities && rigCapabilities.nativeScope);
  }
  function scopeWantsFeed(tab) {
    return scopeSurfaces.some((sf) => sf.visible(tab));
  }
  function scopeSubscribe(on) {
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'scope-subscribe', on: !!on })); } catch { /* not connected */ }
  }
  /** Send subscribe/unsubscribe only when the wanted state changes. `tab` is the tab about to be (or now) active. */
  function scopeSyncSubscription(tab) {
    const want = scopeWantsFeed(tab);
    if (want === scopeSubscribedSent) return;
    scopeSubscribedSent = want;
    scopeSubscribe(want);
  }
  function scopeUpdateTabVisibility() {
    const show = scopeAvailable();
    if (scopeTabBtn) scopeTabBtn.classList.toggle('hidden', !show);
    const bsBtn = document.getElementById('ft8-bs-toggle');
    if (bsBtn) { bsBtn.classList.toggle('hidden', !show); bsBtn.classList.toggle('active', show && ft8BsOn); }
    const strip = document.getElementById('ft8-bandscope');
    if (strip) {
      strip.classList.toggle('hidden', !(show && ft8BsOn));
      // A Flex: the radio's waterfall alone, no header or trace (as the desktop FT8 window).
      strip.classList.toggle('ft8-bs-radio-wf', ft8ScopeIsFlex());
    }
    if (!show && activeTab === 'scope') switchTab('spots');
    scopeSyncSubscription(activeTab);
  }
  // The dial the scope draws around: where a drag, wheel or pinch just put
  // it until the radio's readback arrives within 25 Hz (or 1.5 s pass) — the
  // VFO window's optimistic pattern, so an old readback never snaps it back.
  let scopeDialTarget = { hz: 0, until: 0 };
  function scopeDialHz() {
    const live = Math.round((currentFreqKhz || 0) * 1000);
    if (scopeDialTarget.hz && Date.now() < scopeDialTarget.until && Math.abs(live - scopeDialTarget.hz) > 25) return scopeDialTarget.hz;
    scopeDialTarget = { hz: 0, until: 0 };
    return live;
  }
  function scopeAxisNow() {
    const A = window.ScopeAxis;
    const st = scopeState || {};
    const centerHz = A.axisCenterFor(st, scopeDialHz());
    return A.scopeAxis({ centerHz, spanHz: st.spanHz || 0, anchor: st.anchor || 'center', bins: scopeLatest ? scopeLatest.length : 256 });
  }
  function scopeSizeCanvases() {
    for (const sf of scopeSurfaces) {
      for (const c of [sf.trace, sf.wf, sf.freq]) {
        if (!c) continue;
        const w = Math.max(160, Math.floor(c.clientWidth || 320));
        const h = Math.max(c === sf.freq ? 12 : 40, Math.floor(c.clientHeight || c.height));
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
      }
    }
  }
  function scopeApplyState(st) {
    scopeState = st || null;
    const A = window.ScopeAxis;
    const status = (st && st.status) || 'stopped';
    const label = ({ stopped: 'Stopped', starting: 'Starting', live: 'Live', blocked: 'Blocked', error: 'Error', unavailable: 'Unavailable' })[status] || status;
    const color = status === 'live' ? '#4ecca3' : (status === 'blocked' || status === 'error') ? '#e94560' : 'var(--text-dim)';
    for (const sf of scopeSurfaces) {
      const statusEl = document.getElementById(sf.status);
      if (statusEl) { statusEl.textContent = label; statusEl.style.color = color; }
      const spanEl = document.getElementById(sf.span);
      if (spanEl) spanEl.textContent = st && st.spanHz && A ? A.formatSpan(st.spanHz) : '';
    }
    const synthEl = document.getElementById('scope-phone-synth');
    if (synthEl) synthEl.classList.toggle('hidden', !(st && st.kind === 1));
    const modeEl = document.getElementById('scope-phone-mode');
    if (modeEl) modeEl.textContent = (st && st.modeLabel) || (st && st.anchor ? ScopeAxis.anchorLabel(st.anchor) : '');
    const suWrap = document.getElementById('scope-phone-sunits-wrap');
    if (suWrap) suWrap.classList.toggle('hidden', !(st && st.levelScale && st.levelScale.unit === 'dBm'));
    const needEnable = !!(st && st.kind !== 1 && (st.scuLan === '0' || (st.diag && st.diag.key === 'silent')));
    const enableEl = document.getElementById('scope-phone-enable');
    if (enableEl) {
      enableEl.classList.toggle('hidden', !needEnable);
      enableEl.textContent = (st && st.enableLabel) || 'Enable SCU-LAN10';
    }
    const diag = document.getElementById('scope-phone-diag');
    if (diag) {
      if (st && st.diag && status !== 'live') {
        diag.textContent = '';
        const h = document.createElement('div'); h.style.fontWeight = '700'; h.textContent = st.diag.headline || '';
        const d = document.createElement('div'); d.style.color = 'var(--text-dim)'; d.textContent = [st.diag.detail, st.diag.action].filter(Boolean).join(' ');
        diag.appendChild(h); diag.appendChild(d);
        diag.classList.remove('hidden');
      } else {
        diag.classList.add('hidden');
      }
    }
    scopeDrawAll();
  }
  function scopePaintRow(canvas, bins) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    if (w <= 1 || h <= 1) return;
    // Shift the picture down one row, paint the newest on top.
    const img = ctx.getImageData(0, 0, w, h - 1);
    ctx.putImageData(img, 0, 1);
    const row = ctx.createImageData(w, 1);
    const step = bins.length / w;
    for (let x = 0; x < w; x++) {
      const v = bins[Math.min(bins.length - 1, Math.floor(x * step))] || 0;
      // Same colour ramp as the FT8 strip.
      const r = v > 170 ? 255 : v > 85 ? (v - 85) * 3 : 0;
      const g = v > 170 ? 255 - (v - 170) * 3 : v > 85 ? 255 : v * 3;
      const b = v > 85 ? 0 : 255 - v * 3;
      row.data[x * 4] = r; row.data[x * 4 + 1] = g; row.data[x * 4 + 2] = b; row.data[x * 4 + 3] = 255;
    }
    ctx.putImageData(row, 0, 0);
  }
  function scopeRenderFrame(rawBins) {
    if (!rawBins || !rawBins.length) return;
    const V = window.ScopeView;
    scopeLatest = rawBins;
    if (V) {
      if (!scopeSmooth || scopeSmooth.length !== rawBins.length) { scopeSmooth = Float32Array.from(rawBins); scopePeak = new Float32Array(rawBins.length); }
      V.smoothInto(scopeSmooth, rawBins, V.AVERAGING[scopeAvg] || V.AVERAGING.light);
      V.peakInto(scopePeak, rawBins, V.PEAK_DECAY[scopePeakDecay] != null ? V.PEAK_DECAY[scopePeakDecay] : V.PEAK_DECAY.slow);
    }
    const bins = V ? V.applyRange(rawBins, scopeRange.lo, scopeRange.hi) : rawBins;
    let any = false;
    for (const sf of scopeSurfaces) {
      if (!sf.visible(activeTab) || !sf.wf) continue;
      scopePaintRow(sf.wf, bins);
      any = true;
    }
    if (any) scopeDrawAll();
    if (scopeReadoutAt) scopeShowReadout(scopeReadoutAt.el, scopeReadoutAt.x, scopeReadoutAt.y);
  }
  // The one trace painter (lib/scope-view.js, inlined) — the desktop Band
  // Scope window draws with the same function. The page shows the mode line
  // itself, so the painter's "axis assumed" notice stays off here.
  function scopeDrawTrace(sf, axis, centerHz) {
    const st = scopeState || {};
    const V = window.ScopeView;
    const canvas = sf.trace;
    const shown = scopeSmooth ? V.applyRange(scopeSmooth, scopeRange.lo, scopeRange.hi) : null;
    const peak = sf.full && scopePeakOn && scopePeak ? V.applyRange(scopePeak, scopeRange.lo, scopeRange.hi) : null;
    window.ScopeView.drawTrace(canvas.getContext('2d'), { bins: shown, peak },
      { w: canvas.width, h: canvas.height, dpr: 1, axis, dialHz: centerHz, spanHz: st.spanHz, anchor: st.anchor, notice: false,
        peakHold: !!peak, scale: V.displayScale(st.levelScale, scopeRange.lo, scopeRange.hi), gutter: sf.full, sUnits: sf.full && scopeSUnits,
        // Phase 3: passband, split TX, band plan. The FT8 strip draws edges
        // and shading only (labels:false — it is too short for them).
        overlay: { passband: st.passband, txHz: st.txHz, bandPlan: st.bandPlan, privileges: scopePrivileges, labels: sf.full, flag: sf.full } });
  }
  function scopeDrawAll() {
    const A = window.ScopeAxis;
    if (!A || !window.ScopeView) return;
    const axis = scopeAxisNow();
    const centerHz = scopeDialHz();
    for (const sf of scopeSurfaces) {
      if (!sf.visible(activeTab) || !sf.trace) continue;
      scopeDrawTrace(sf, axis, centerHz);
      if (sf.freq) window.ScopeView.drawFreqScale(sf.freq.getContext('2d'), { w: sf.freq.width, h: sf.freq.height, dpr: 1, axis, dialHz: centerHz });
    }
  }
  function scopeSetRange(next, from) {
    scopeRange = window.ScopeView.clampRange(next.lo, next.hi);
    scopeLsSet('echocat-scope-floor', scopeRange.lo);
    scopeLsSet('echocat-scope-top', scopeRange.hi);
    const f = document.getElementById('scope-phone-floor');
    if (f && from !== 'floor') f.value = String(Math.min(Number(f.max), scopeRange.lo));
    const t = document.getElementById('scope-phone-top');
    if (t && from !== 'top') t.value = String(scopeRange.hi);
    scopeDrawAll();
  }
  // Cursor readout on the Scope tab: hover, or touch and hold (plan item 3).
  const scopeReadoutEl = document.getElementById('scope-phone-readout');
  let scopeReadoutAt = null;
  function scopeShowReadout(el, clientX, clientY) {
    const V = window.ScopeView;
    const axis = scopeAxisNow();
    const r = el.getBoundingClientRect();
    if (!scopeReadoutEl || !V || !(r.width > 0) || !axis.hzPerBin) { if (scopeReadoutEl) scopeReadoutEl.style.display = 'none'; return; }
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const st = scopeState || {};
    let text = V.formatReadout(window.ScopeAxis.binToHz(axis, frac * (axis.bins - 1)), scopeSmooth ? V.levelAt(scopeSmooth, frac) : null, st.levelScale, st.spanHz);
    if (!axis.known) text += ' (axis assumed)';
    scopeReadoutEl.textContent = text;
    scopeReadoutEl.style.display = 'block';
    const box = scopeReadoutEl.parentElement.getBoundingClientRect();
    const w = scopeReadoutEl.offsetWidth;
    let x = clientX - box.left + 12;
    if (x + w > box.width - 4) x = clientX - box.left - w - 12;
    scopeReadoutEl.style.left = Math.max(4, x) + 'px';
    scopeReadoutEl.style.top = Math.max(2, clientY - box.top - 30) + 'px';
  }
  function scopeHideReadout() { scopeReadoutAt = null; if (scopeReadoutEl) scopeReadoutEl.style.display = 'none'; }
  function scopeTuneDial(hz) {
    if (!(hz > 0)) return;
    scopeDialTarget = { hz, until: Date.now() + 1500 };
    sendToServer({ type: 'tune', freqKhz: (hz / 1000).toFixed(3), mode: '' });
    scopeDrawAll();
  }
  const scopeLiveTune = window.ScopeView ? window.ScopeView.throttleLast(scopeTuneDial, 66) : null;
  function scopeZoom(dir) {
    const st = scopeState || {};
    const next = window.ScopeView.zoomSpan(st.spans, st.spanHz, dir);
    if (next) sendToServer({ type: 'scope-span', spanHz: next });
  }
  function scopeWireTuneGestures(el, withPassband) {
    const V = window.ScopeView;
    let drag = null;          // { kind, x0, y0, dial0, width, moved, decided }
    const touches = new Map();
    let pinch = null;         // { d0 }
    const slide = (dx) => { const t = dx ? 'translateX(' + dx + 'px)' : ''; for (const sf2 of scopeSurfaces) if (sf2.full) { if (sf2.trace) sf2.trace.style.transform = t; if (sf2.wf) sf2.wf.style.transform = t; } };
    const pbPx = () => {
      const axis = scopeAxisNow();
      const pb = V.passbandHz((scopeState || {}).passband, scopeDialHz());
      const k = V.hzPerPx(axis, el.getBoundingClientRect().width);
      return pb && k ? { x0: (pb.loHz - axis.startHz) / k, x1: (pb.hiHz - axis.startHz) / k } : null;
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          const [a, b] = [...touches.values()];
          pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) };
          drag = null; slide(0);
          return;
        }
      }
      if (e.button !== 0 || (withPassband && scopeInGutter(el, e))) return;
      const axis = scopeAxisNow();
      const r = el.getBoundingClientRect();
      const kind = V.dragKind(axis, e.clientX - r.left, withPassband ? pbPx() : null);
      if (kind === 'none' || !scopeDialHz()) return;
      drag = { kind, x0: e.clientX, y0: e.clientY, dial0: scopeDialHz(), width: r.width, moved: false, touch: e.pointerType === 'touch' };
    });
    el.addEventListener('pointermove', (e) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const step = V.pinchStep(pinch.d0, Math.hypot(a.x - b.x, a.y - b.y));
        if (step) { scopeZoom(step); pinch.d0 = Math.hypot(a.x - b.x, a.y - b.y); }
        scopeSuppressClick = true;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (!drag.moved) {
        if (drag.touch ? !V.touchIsHorizontal(dx, dy, 12) : Math.abs(dx) < 4) {
          if (drag.touch && Math.abs(dy) > 12) drag = null;   // the page is scrolling
          return;
        }
        drag.moved = true;
        scopeSuppressClick = true;
        clearTimeout(scopeHoldTimer);
        try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      }
      const axis = scopeAxisNow();
      if (drag.kind === 'passband') scopeLiveTune.push(V.dragDialHz('passband', drag.dial0, dx, axis, drag.width));
      else slide(dx);
    });
    const end = (e) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      const d = drag;
      drag = null;
      if (!d || !d.moved) return;
      try { el.releasePointerCapture(e.pointerId); } catch { /* released */ }
      if (d.kind === 'passband') { scopeLiveTune.flush(); return; }
      const axis = scopeAxisNow();
      slide(0);
      if (e.type !== 'pointercancel') scopeTuneDial(V.dragDialHz('pan', d.dial0, e.clientX - d.x0, axis, d.width));
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      if (withPassband && scopeInGutter(el, e)) return;   // the level window's own wheel
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { scopeZoom(e.deltaY > 0 ? +1 : -1); return; }
      if (!scopeAxisNow().known || !scopeDialHz()) return;
      const step = V.wheelStepHz(scopeTuneStepHz, e.deltaY, e.shiftKey);
      if (step) scopeTuneDial(scopeDialHz() + step);
    }, { passive: false });
  }
  function scopeTuneAt(clientX, el) {
    const axis = scopeAxisNow();
    if (!axis.known) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const hz = window.ScopeAxis.snapTapHz(window.ScopeAxis.binToHz(axis, frac * (axis.bins - 1)), scopeState && scopeState.spanHz);
    sendToServer({ type: 'tune', freqKhz: (hz / 1000).toFixed(3), mode: '' });
  }
  // A drag on the Scope tab's level scale (left edge) moves the level window
  // and never tunes; the wheel there widens or narrows it.
  let scopeGutterDrag = null;
  let scopeSuppressClick = false;
  let scopeHoldTimer = null;
  const scopeInGutter = (el, e) => e.clientX - el.getBoundingClientRect().left <= window.ScopeView.GUTTER_PX;
  for (const sf of scopeSurfaces) {
    for (const c of [sf.trace, sf.wf, sf.freq]) if (c) c.addEventListener('click', (e) => {
      if (scopeSuppressClick) { scopeSuppressClick = false; return; }
      scopeTuneAt(e.clientX, c);
    });
    if (!sf.full || !window.ScopeView) continue;
    const tr = sf.trace;
    tr.addEventListener('pointerdown', (e) => {
      scopeSuppressClick = false;
      if (!scopeInGutter(tr, e)) return;
      scopeGutterDrag = { y0: e.clientY, range0: { lo: scopeRange.lo, hi: scopeRange.hi } };
      scopeSuppressClick = true;
      try { tr.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    });
    tr.addEventListener('pointermove', (e) => {
      tr.style.cursor = scopeGutterDrag || scopeInGutter(tr, e) ? 'ns-resize' : 'crosshair';
      if (!scopeGutterDrag) return;
      const plotH = Math.max(1, tr.getBoundingClientRect().height - 6);
      const d = (e.clientY - scopeGutterDrag.y0) * (scopeGutterDrag.range0.hi - scopeGutterDrag.range0.lo) / plotH;
      scopeSetRange(window.ScopeView.shiftRange(scopeGutterDrag.range0, d));
    });
    const endDrag = (e) => { if (scopeGutterDrag) { scopeGutterDrag = null; try { tr.releasePointerCapture(e.pointerId); } catch { /* released */ } } };
    tr.addEventListener('pointerup', endDrag);
    tr.addEventListener('pointercancel', endDrag);
    tr.addEventListener('wheel', (e) => {
      if (!scopeInGutter(tr, e)) return;
      e.preventDefault();
      scopeSetRange(window.ScopeView.zoomRange(scopeRange, e.deltaY > 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
    // Phase 4 (plan items 11, 12, 12e): drag the passband to tune, drag
    // elsewhere to slide the spectrum and tune on release, wheel steps the
    // dial (Ctrl = zoom), pinch zooms. Touch: a sideways drag past 12 px is a
    // scope gesture, an up/down one scrolls the page (touch-action: pan-y).
    for (const el of [tr, sf.wf]) scopeWireTuneGestures(el, el === tr);
    for (const el of [sf.trace, sf.wf]) {
      el.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch' && !scopeReadoutAt) { clearTimeout(scopeHoldTimer); return; }
        if (el === tr && (scopeGutterDrag || scopeInGutter(tr, e))) { scopeHideReadout(); return; }
        scopeReadoutAt = { el, x: e.clientX, y: e.clientY };
        scopeShowReadout(el, e.clientX, e.clientY);
      });
      el.addEventListener('pointerleave', scopeHideReadout);
      el.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        clearTimeout(scopeHoldTimer);
        const x = e.clientX, y = e.clientY;
        // A hold shows the readout; lifting after it does not tune.
        scopeHoldTimer = setTimeout(() => { scopeReadoutAt = { el, x, y }; scopeSuppressClick = true; scopeShowReadout(el, x, y); }, 400);
      });
      el.addEventListener('pointerup', (e) => { clearTimeout(scopeHoldTimer); if (e.pointerType === 'touch' && scopeReadoutAt) setTimeout(scopeHideReadout, 1500); });
    }
  }
  const scopeFloorEl = document.getElementById('scope-phone-floor');
  if (scopeFloorEl) scopeFloorEl.addEventListener('input', (e) => scopeSetRange({ lo: Number(e.target.value) || 0, hi: scopeRange.hi }, 'floor'));
  const scopeTopEl = document.getElementById('scope-phone-top');
  if (scopeTopEl) scopeTopEl.addEventListener('input', (e) => scopeSetRange({ lo: scopeRange.lo, hi: Number(e.target.value) || 255 }, 'top'));
  const scopeRangeResetEl = document.getElementById('scope-phone-range-reset');
  if (scopeRangeResetEl) scopeRangeResetEl.addEventListener('click', () => scopeSetRange({ lo: 0, hi: 255 }));
  const scopeDisplayBtn = document.getElementById('scope-phone-display-btn');
  if (scopeDisplayBtn) scopeDisplayBtn.addEventListener('click', () => {
    const p = document.getElementById('scope-phone-display');
    if (p) p.classList.toggle('hidden');
    scopeSizeCanvases(); scopeDrawAll();
  });
  const scopeAvgEl = document.getElementById('scope-phone-avg');
  if (scopeAvgEl) {
    scopeAvgEl.value = scopeAvg;
    scopeAvgEl.addEventListener('change', (e) => { scopeAvg = e.target.value; scopeLsSet('echocat-scope-avg', scopeAvg); });
  }
  function scopeApplyPeakUi() {
    const clr = document.getElementById('scope-phone-peak-clear');
    if (clr) clr.classList.toggle('hidden', !scopePeakOn);
    const dw = document.getElementById('scope-phone-peak-decay-wrap');
    if (dw) dw.classList.toggle('hidden', !scopePeakOn);
  }
  const scopePeakEl = document.getElementById('scope-phone-peak');
  if (scopePeakEl) {
    scopePeakEl.checked = scopePeakOn;
    scopePeakEl.addEventListener('change', (e) => { scopePeakOn = e.target.checked; scopeLsSet('echocat-scope-peak', scopePeakOn ? '1' : '0'); if (!scopePeakOn && scopePeak) scopePeak.fill(0); scopeApplyPeakUi(); scopeDrawAll(); });
  }
  const scopePeakDecayEl = document.getElementById('scope-phone-peak-decay');
  if (scopePeakDecayEl) {
    scopePeakDecayEl.value = scopePeakDecay;
    scopePeakDecayEl.addEventListener('change', (e) => { scopePeakDecay = e.target.value; scopeLsSet('echocat-scope-peak-decay', scopePeakDecay); });
  }
  const scopePeakClearEl = document.getElementById('scope-phone-peak-clear');
  if (scopePeakClearEl) scopePeakClearEl.addEventListener('click', () => { if (scopePeak) scopePeak.fill(0); scopeDrawAll(); });
  const scopeSUnitsEl = document.getElementById('scope-phone-sunits');
  if (scopeSUnitsEl) {
    scopeSUnitsEl.checked = scopeSUnits;
    scopeSUnitsEl.addEventListener('change', (e) => { scopeSUnits = e.target.checked; scopeLsSet('echocat-scope-sunits', scopeSUnits ? '1' : '0'); scopeDrawAll(); });
  }
  const scopePrivilegesEl = document.getElementById('scope-phone-privileges');
  if (scopePrivilegesEl) {
    scopePrivilegesEl.checked = scopePrivileges;
    scopePrivilegesEl.addEventListener('change', (e) => { scopePrivileges = e.target.checked; scopeLsSet('echocat-scope-privileges', scopePrivileges ? '1' : '0'); scopeDrawAll(); });
  }
  scopeApplyPeakUi();
  if (window.ScopeView) scopeSetRange(scopeRange);
  const scopeEnableBtn = document.getElementById('scope-phone-enable');
  if (scopeEnableBtn) scopeEnableBtn.addEventListener('click', () => sendToServer({ type: 'scope-enable-radio' }));
  const ft8BsToggle = document.getElementById('ft8-bs-toggle');
  if (ft8BsToggle) {
    ft8BsToggle.addEventListener('click', () => {
      ft8BsOn = !ft8BsOn;
      try { localStorage.setItem('echocat-ft8-bandscope', ft8BsOn ? '1' : '0'); } catch { /* private mode */ }
      // On a Flex the radio's waterfall and the audio one are one choice (Casey 2026-10-30).
      const wfBtn = document.getElementById('ft8-wf-toggle');
      if (ft8BsOn && ft8ScopeIsFlex() && wfBtn && wfBtn.classList.contains('active')) wfBtn.click();
      scopeUpdateTabVisibility();
      if (ft8BsOn) { scopeSizeCanvases(); scopeDrawAll(); }
    });
  }
  window.addEventListener('resize', () => { if (scopeWantsFeed(activeTab)) { scopeSizeCanvases(); scopeDrawAll(); } });
  const sstvCameraPreview = document.getElementById('sstv-camera-preview');
  const sstvPhoneCompose = document.getElementById('sstv-phone-compose');
  const sstvPhoneComposeCtx = sstvPhoneCompose ? sstvPhoneCompose.getContext('2d') : null;
  const sstvPhoneGallery = document.getElementById('sstv-phone-gallery');
  const sstvPhoneStatus = document.getElementById('sstv-phone-status');
  let sstvCameraStream = null;
  let sstvPhoneBg = null; // current background (canvas or video frame)
  let sstvPhoneBgZoom = 1.0;    // zoom factor (1 = fit, >1 = zoomed in)
  let sstvPhoneBgPanX = 0;      // pan offset in source image pixels
  let sstvPhoneBgPanY = 0;
  let sstvPhoneGalleryItems = [];
  // PiP reply inset — draws the received image over the outgoing compose so
  // the standard "reply with your image + their image overlaid" workflow
  // works on the phone. See desktop sstv-popout.js for the matching feature.
  let sstvPhoneReplyImage = null;              // HTMLImageElement or null
  let sstvPhoneReplyInset = { x: -1, y: -1, scale: 0.28 }; // -1 = auto (bottom-right)

  // FT8 DOM refs
  const ft8View = document.getElementById('ft8-view');
  const ft8BandSelect = document.getElementById('ft8-band-select');
  const ft8ModeSelect = document.getElementById('ft8-mode-select');
  const ft8RxTxBadge = document.getElementById('ft8-rx-tx-badge');
  // ft8-cycle-indicator was a separate "E"/"O" letter badge that was
  // replaced by the ft8-cycle-bar progress strip — the element no longer
  // exists in remote.html but the const + the textContent assignment in
  // the jtcat-cycle handler below were left behind. Stale getElementById
  // returns null, then setting textContent on null throws and kills the
  // WS handler. Removed.
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
  const soSquelchRow = document.getElementById('so-squelch-row');
  const rcSquelchSlider = document.getElementById('rc-squelch-slider');
  const rcSquelchVal = document.getElementById('rc-squelch-val');
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

  // --- Split layout (iPad-sized screens: dock the VFO panel on a side) ---
  // Modes: 'right' (default), 'left', 'off'. Only actually engages when the
  // viewport is >= 1000px wide — below that the phone stacked layout is used
  // regardless of the saved preference.
  const SPLIT_MQ = window.matchMedia('(min-width: 1000px)');
  const soLayoutLeft = document.getElementById('so-layout-left');
  const soLayoutRight = document.getElementById('so-layout-right');
  const soLayoutOff = document.getElementById('so-layout-off');
  let splitMode = localStorage.getItem('echocat-split-layout') || 'right';
  if (splitMode !== 'left' && splitMode !== 'right' && splitMode !== 'off') splitMode = 'right';

  // Remember the original DOM parents/positions of elements we relocate into
  // the VFO panel when docked, so we can restore them exactly when undocking.
  const _relocHomes = { latency: null, gear: null };
  function _captureReloc() {
    const latency = document.getElementById('latency');
    const gear = document.getElementById('rig-ctrl-toggle');
    if (latency && latency.parentNode && !_relocHomes.latency) {
      _relocHomes.latency = { parent: latency.parentNode, next: latency.nextSibling };
    }
    if (gear && gear.parentNode && !_relocHomes.gear) {
      _relocHomes.gear = { parent: gear.parentNode, next: gear.nextSibling };
    }
  }

  function applySplitLayout() {
    const mainUI = document.getElementById('main-ui');
    const fullview = document.getElementById('vfo-fullview');
    const toggleBtn = document.getElementById('vfo-fullview-btn');
    if (!mainUI || !fullview || !toggleBtn) return;
    _captureReloc();

    const wantDocked = (splitMode === 'left' || splitMode === 'right') && SPLIT_MQ.matches;
    const wasDocked = fullview.classList.contains('vfo-docked');

    if (wantDocked) {
      mainUI.setAttribute('data-split', splitMode);
      fullview.classList.add('vfo-docked');
      // Force the fullview into "open" state so its render/draw loop runs.
      if (fullview.classList.contains('hidden')) toggleBtn.click();

      // Relocate latency into the dial wrap (top-right floater) and the gear
      // button into the VFO header (right of the frequency display).
      const latency = document.getElementById('latency');
      const gear = document.getElementById('rig-ctrl-toggle');
      const dialWrap = fullview.querySelector('.vf-dial-wrap');
      const vfHeader = fullview.querySelector('.vf-header');
      if (latency && dialWrap && latency.parentNode !== dialWrap) dialWrap.appendChild(latency);
      if (gear && vfHeader && gear.parentNode !== vfHeader) vfHeader.appendChild(gear);
    } else {
      mainUI.removeAttribute('data-split');
      fullview.classList.remove('vfo-docked');
      // If we were the ones keeping it open (docked), close it now.
      if (wasDocked && !fullview.classList.contains('hidden')) toggleBtn.click();

      // Put latency and gear back where they started (insertBefore with a null
      // next-sibling appends at end, matching the original tail position).
      const latency = document.getElementById('latency');
      const gear = document.getElementById('rig-ctrl-toggle');
      if (latency && _relocHomes.latency && latency.parentNode !== _relocHomes.latency.parent) {
        _relocHomes.latency.parent.insertBefore(latency, _relocHomes.latency.next);
      }
      if (gear && _relocHomes.gear && gear.parentNode !== _relocHomes.gear.parent) {
        _relocHomes.gear.parent.insertBefore(gear, _relocHomes.gear.next);
      }
    }

    if (soLayoutLeft)  soLayoutLeft.classList.toggle('active',  splitMode === 'left');
    if (soLayoutRight) soLayoutRight.classList.toggle('active', splitMode === 'right');
    if (soLayoutOff)   soLayoutOff.classList.toggle('active',   splitMode === 'off');
  }

  function setSplitLayout(mode) {
    splitMode = mode;
    try { localStorage.setItem('echocat-split-layout', mode); } catch {}
    applySplitLayout();
  }

  if (soLayoutLeft)  soLayoutLeft.addEventListener('click',  () => setSplitLayout('left'));
  if (soLayoutRight) soLayoutRight.addEventListener('click', () => setSplitLayout('right'));
  if (soLayoutOff)   soLayoutOff.addEventListener('click',   () => setSplitLayout('off'));

  // Re-evaluate when the viewport crosses the breakpoint (rotation, resize).
  if (SPLIT_MQ.addEventListener) SPLIT_MQ.addEventListener('change', applySplitLayout);
  else if (SPLIT_MQ.addListener) SPLIT_MQ.addListener(applySplitLayout);

  // Apply once on load. The VFO IIFE runs later on auth-ok so we also
  // re-apply there (see setupVfoFullview) to cover cold-load ordering.
  applySplitLayout();
  window.__echocatApplySplitLayout = applySplitLayout;

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
      // 'cookie' re-dials with the browser's cookie (after a kick, "Tap
      // Connect to take over") — there is no token to type.
      if (authMode !== 'none' && authMode !== 'cookie' && !token) return;
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

  // --- BroadcastChannel (main-window side) ---
  // Opens a BC so any popout windows opened from this session can mirror state.
  // Called after auth succeeds; safe to call multiple times (idempotent).
  function setupMainBroadcastChannel() {
    if (isPopout || bc) return;
    try { bc = new BroadcastChannel('echocat'); } catch { return; }
    bc.addEventListener('message', (ev) => {
      const m = ev.data;
      if (!m || !m.kind) return;
      if (m.kind === 'hello') {
        sendStateSnapshot();
      } else if (m.kind === 'forward' && m.message) {
        // Log forwards so issues (e.g. WS disconnected when a popout click arrives)
        // are visible in DevTools.
        const wsOpen = !!(ws && ws.readyState === WebSocket.OPEN);
        console.log('[BC main] forward', m.message && m.message.type, 'wsOpen=', wsOpen, m.message);
        if (wsOpen) {
          try { ws.send(JSON.stringify(m.message)); } catch (err) { console.warn('[BC main] forward send failed', err); }
        }
      }
    });
  }

  function sendStateSnapshot() {
    if (!bc) return;
    try {
      bc.postMessage({
        kind: 'state-snapshot',
        spots: spots,
        currentFreqKhz: currentFreqKhz,
        mode: modeBadge ? modeBadge.textContent : '',
        clubMember: clubMember,
        phoneGrid: phoneGrid,
        distUnit: distUnit,
        online: !!(ws && ws.readyState === WebSocket.OPEN),
      });
    } catch {}
  }

  // Unified send helper — main mode sends over WS; popout mode forwards via BC.
  function sendToServer(message) {
    if (isPopout) {
      if (bc) {
        console.log('[BC popout] forward', message && message.type, message);
        try { bc.postMessage({ kind: 'forward', message: message }); } catch (err) {
          console.warn('[BC popout] postMessage failed', err);
        }
      } else {
        console.warn('[BC popout] no BroadcastChannel — dropping', message);
      }
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(message)); } catch {}
    }
  }

  // Notify any popouts that this (main) window is going away. Popouts will show
  // a "disconnected from main" banner until a new main window opens and answers
  // their retried `hello`.
  window.addEventListener('beforeunload', () => {
    if (!isPopout && bc) {
      try { bc.postMessage({ kind: 'main-closing' }); } catch {}
    }
  });

  function openWs(onOpen) {
    wasKicked = false;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.onopen = function() {
      // v1 protocol: send `hello` first so the server knows our
      // capabilities. Legacy servers (pre-v1.5.14) treat it as an
      // unknown message and ignore it; the rest of the flow is
      // unchanged for them.
      try {
        ws.send(JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          clientVersion: 'web',
          clientPlatform: 'web',
          // Without these the server falls back to the legacy single-frame
          // all-qsos path: newest 2000 records halved until the JSON fits in
          // 256 KB - which is the "logbook only shows 125 QSOs" report
          // (LZ3AW item 2). Chunked delivery has no cap; qso-delta appends
          // one record per log write instead of re-pushing the whole log.
          // local-cw-sidetone: this page plays its own sidetone for the CW it
          // sends, so the desktop must not mix a second copy into RX audio.
          capabilities: ['chunked-all-qsos', 'qso-delta', 'chunked-worked-qsos', 'local-cw-sidetone'],
        }));
      } catch {}
      onOpen();
    };
    ws.onmessage = function(event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = function() {
      clearInterval(pingInterval);
      pingInterval = null;
      if (bc) { try { bc.postMessage({ kind: 'connection', online: false, reason: wasKicked ? 'kicked' : 'closed' }); } catch {} }
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
      case 'hello':
        // Server's protocol-version + version banner. Store on the ws
        // for later UI use; no behavior change today.
        // `now`: the desktop's wall clock at send time. The FT8 period bar
        // and countdown run on it, not on this device's clock, which can be
        // seconds off (LZ3AW 2026-10-16: "moving line for the period is not
        // on time"). One sample at connect; the hop latency is tens of ms.
        if (typeof msg.now === 'number' && Number.isFinite(msg.now)) serverClockOffsetMs = msg.now - Date.now();
        try {
          ws._serverProtocolVersion = msg.protocolVersion | 0;
          ws._serverVersion = String(msg.serverVersion || '');
          // This page came from the desktop that answered the FIRST hello.
          // A reconnect to an updated desktop leaves an open tab running the
          // old page against the new server: LZ3AW kept a tab open across
          // 1.10.27 and his paddle still went the old way (round 11). Load
          // the new page once; the guard stops a loop if a reload does not
          // change the version.
          if (ws._serverVersion) {
            if (!window.__echocatPageServerVersion) {
              window.__echocatPageServerVersion = ws._serverVersion;
            } else if (window.__echocatPageServerVersion !== ws._serverVersion) {
              var reloadKey = 'echocat-reloaded-for-' + ws._serverVersion;
              var already = false;
              try { already = sessionStorage.getItem(reloadKey) === '1'; sessionStorage.setItem(reloadKey, '1'); } catch (e) {}
              if (!already) { location.reload(); return; }
            }
          }
          ws._serverCapabilities = Array.isArray(msg.capabilities) ? msg.capabilities : [];
          scopeServerOk = ws._serverCapabilities.indexOf('scope') !== -1;
          cwKeyStreamOk = ws._serverCapabilities.indexOf('cw-key-stream') !== -1;
          scopeUpdateTabVisibility();
          scopeSubscribedSent = false; // a fresh connection knows nothing — re-send if a scope surface is up
          scopeSyncSubscription(activeTab);
          // Billing at connect: a trial ending or a failed card shows at the
          // top of the page without opening Settings.
          if (ws._serverCapabilities.indexOf('cloud-billing') !== -1 && typeof echoCloudRefresh === 'function') setTimeout(echoCloudRefresh, 800);
        } catch {}
        break;
      case 'auth-mode':
        // Server tells us which login form to show
        authMode = msg.mode || 'token';
        if (servedAuthMode === 'cookie' && authMode !== 'cookie') {
          // The page was served on a cookie the WebSocket just refused
          // (revoked between page load and upgrade, pass expired, or the
          // upgrade came without our Origin). Never leave the user on a
          // token box they cannot fill: drop the cookie and land on the
          // connect page with a notice.
          webSignOutAndReload('link-expired');
          break;
        }
        if (authMode === 'cookie') {
          tokenLoginDiv.classList.add('hidden');
          clubLoginDiv.classList.add('hidden');
          // Same as 'none': the server authenticates on the cookie and
          // auth-ok follows. Keep the connect screen hidden unless a kick
          // put it up (then the Connect button re-dials on the cookie).
          if (!wasKicked) connectScreen.classList.add('hidden');
          connectBtn.textContent = 'Connect';
        } else if (authMode === 'club') {
          // The injected __authMode may have pre-hidden the connect
          // screen (it pre-hides only for 'none', but be defensive) —
          // an auth-requiring mode must always re-show it, or the user
          // is stranded on a dead main-UI shell with no way to log in.
          connectScreen.classList.remove('hidden');
          mainUI.classList.add('hidden');
          tokenLoginDiv.classList.add('hidden');
          clubLoginDiv.classList.remove('hidden');
          connectBtn.textContent = 'Log In';
        } else if (authMode === 'none') {
          tokenLoginDiv.classList.add('hidden');
          clubLoginDiv.classList.add('hidden');
          // Hide entire connect screen — server auto-authenticates
          connectScreen.classList.add('hidden');
        } else {
          // Token mode — same defensive re-show as the club branch.
          connectScreen.classList.remove('hidden');
          mainUI.classList.add('hidden');
          tokenLoginDiv.classList.remove('hidden');
          clubLoginDiv.classList.add('hidden');
          connectBtn.textContent = 'Connect';
        }
        break;

      case 'auth-ok':
        connectScreen.classList.add('hidden');
        mainUI.classList.remove('hidden');
        tabBar.classList.remove('hidden');
        applyNavMode(); // hamburger setting wins over the unconditional reveal above
        // Open BroadcastChannel so any popout windows opened from this session mirror our state
        setupMainBroadcastChannel();
        if (bc) { try { bc.postMessage({ kind: 'connection', online: true }); sendStateSnapshot(); } catch {} }
        requestWakeLock(); // keep screen on while connected
        connectBtn.textContent = authMode === 'club' ? 'Log In' : 'Connect';
        connectBtn.disabled = false;
        // Adopt the current VFO lock state so the button paints correctly
        // on reconnect / page reload.
        vfoLocked = !!msg.vfoLocked;
        updateVfoLockUi();
        // ECHOCAT Web session (POTACAT Cloud): pass banner + Sign out row
        renderPassBanner(msg.passSession);
        renderWebSessionRow(msg.passSession);
        try { sessionStorage.removeItem('echocat-web-reload'); } catch {}
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
        // Re-upload any voice macros we have locally that the desktop
        // may not have received. If the user records a voice macro
        // while WS is briefly disconnected (network blip, desktop
        // restart), the original ft8Send silently drops the upload —
        // the phone has the recording in IndexedDB but the desktop
        // doesn't. Later when phone IndexedDB clears (Safari ITP),
        // the recording is gone. Re-uploading on every connect catches
        // that case. Server's "if audio is non-empty, write file" is
        // idempotent, so re-pushes of recordings the desktop already
        // has are harmless.
        try { reuploadLocalVoiceMacros(); } catch (e) { console.warn('voice-macro reupload failed:', e); }
        // Reset JTCAT state on reconnect — desktop may have stopped the engine while we were away
        ft8Running = false;
        // If already on FT8 tab, restart engine + tune to the active band
        if (activeTab === 'ft8') {
          ft8Send({ type: 'jtcat-start', mode: ft8Mode });
          var selOpt = ft8BandSelect.options[ft8BandSelect.selectedIndex];
          if (selOpt) ft8Send({ type: 'jtcat-set-band', band: selOpt.value, freqKhz: parseInt(selOpt.dataset.freq, 10) });
        }
        // If already on SSTV tab, refresh the gallery — any images decoded
        // while we were backgrounded / asleep would have broadcast to a dead
        // socket and been lost. Replace-style request drops stale thumbnails
        // and pulls the newest 10 from disk. (Tab-switch already covers the
        // case where the user navigates to SSTV fresh.)
        if (activeTab === 'sstv' && typeof sstvPhoneRequestGallery === 'function') {
          sstvPhoneRequestGallery(10, 0, true);
        }
        if (activeTab === 'spots' || activeTab === 'map') {
          filterToolbar.classList.remove('hidden');
        }
        if (msg.colorblindMode) applyRemoteColorblind(true);
        // CW keyer availability
        cwAvailable = !!msg.cwAvailable;
        // Default to true when not specified — desktop only sends false when
        // it's actively determined paddle keying can't reach the radio.
        cwPaddleAvailable = msg.cwPaddleAvailable !== false;
        updateCwPanelVisibility();
        updateSsbPanelVisibility();
        if (msg.settings) {
          echoSettings = msg.settings;
          myCallsign = msg.settings.myCallsign || '';
          phoneGrid = msg.settings.grid || phoneGrid;
          // Seed the chase-target picker from the desktop's current value.
          if (typeof window.__ft8ReflectChase === 'function') window.__ft8ReflectChase(msg.settings.jtcatChaseTarget || '');
          clusterConnected = !!msg.settings.clusterConnected;
          respotDefault = msg.settings.respotDefault !== false;
          if (msg.settings.respotTemplate) respotTemplate = msg.settings.respotTemplate;
          if (msg.settings.dxRespotTemplate) dxRespotTemplate = msg.settings.dxRespotTemplate;
          scanDwell = msg.settings.scanDwell || 7;
          dxeState.enable = msg.settings.enableDxe === true;
          if (msg.settings.enableDxeSources && typeof msg.settings.enableDxeSources === 'object') {
            dxeState.sources = Object.assign({}, DXE_DEFAULT_SOURCES, msg.settings.enableDxeSources);
          }
          reflectDxeToggles();
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
          // Sync local iambic keyer with desktop's keyer config. Mode is
          // usually phone-driven (user toggles it here), but the desktop
          // owns paddle-swap so we have to learn it from settings.
          if (msg.settings.cwKeyerMode) {
            cwMode = msg.settings.cwKeyerMode;
            localCwKeyer.setMode(cwMode);
          }
          if (typeof msg.settings.cwSwapPaddles === 'boolean') {
            cwSwapPaddles = msg.settings.cwSwapPaddles;
            localCwKeyer.setSwap(cwSwapPaddles);
          }
        }
        updateCwEnableBtn();
        // Load WebSDR stations from settings
        if (msg.settings && typeof kiwiLoadStationsE === 'function') kiwiLoadStationsE(msg.settings);
        // JTCAT RX *and* TX gain are DESKTOP-authoritative — jtcat-rx-gain-state
        // / jtcat-tx-gain-state hydrate our sliders at connect. This client used
        // to push its saved TX copy here ("TX is not desktop-persisted"), which
        // is precisely how one phone's 5% became the shack's 5% for good: every
        // later transmission from the desktop keyed the radio with no audio,
        // and the desktop's own slider still read 100% (NA7C, 2026-09-09 —
        // the 2026-07-18 blank-waterfall incident, from the transmit side).
        break;

      case 'tune-blocked':
        showToast(msg.reason || 'Tune blocked by license restrictions', 4000);
        break;

      case 'vfo-lock-state':
        vfoLocked = !!msg.locked;
        updateVfoLockUi();
        break;

      case 'rig-blocked':
        showToast(msg.reason || 'You do not have access to this radio', 4000);
        break;

      case 'colorblind-mode':
        applyRemoteColorblind(!!msg.enabled);
        break;

      case 'auth-fail':
        if (webCookieMode()) {
          // The cookie the server pre-authenticated on was refused after
          // all (expired device row, Guest Pass no longer valid). Nothing
          // the user can type here fixes that.
          webSignOutAndReload('link-expired');
          break;
        }
        connectError.textContent = msg.reason || 'Authentication failed';
        connectError.classList.remove('hidden');
        connectBtn.textContent = authMode === 'club' ? 'Log In' : 'Connect';
        connectBtn.disabled = false;
        break;

      case 'revoked':
        // Settings > ECHOCAT > My devices > Revoke on the desktop. The
        // server closes the socket right after this.
        if (webCookieMode()) { webSignOutAndReload('revoked'); break; }
        wasKicked = true;
        endAudioWithSession();
        releaseWakeLock();
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        mainUI.classList.add('hidden');
        connectScreen.classList.remove('hidden');
        connectError.textContent = msg.reason || 'Access revoked by the desktop operator';
        connectError.classList.remove('hidden');
        connectBtn.textContent = authMode === 'club' ? 'Log In' : 'Connect';
        connectBtn.disabled = false;
        break;

      case 'pass-ended':
        // The owner ended or revoked the Guest Pass, or it expired.
        if (webCookieMode()) { webSignOutAndReload('pass-ended'); break; }
        renderPassBanner(null);
        showToast('Guest Pass ended' + (msg.reason ? ': ' + msg.reason : ''), 6000, true);
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

      case 'typed-call':
        sharedTypedCall = String(msg.call || '').trim().toUpperCase();
        break;

      case 'swr-ratio':
        updateEchoSwrRatio(msg.value);
        break;

      case 'alc':
        updateEchoAlc(msg.value);
        break;

      case 'power':
        // Power SETTING readback — yields to live measured watts for 3s
        // after any fwd-power frame so the two can share one bar honestly.
        if (Date.now() - echoFwdLiveAt > 3000) updateEchoPower(msg.value);
        break;

      case 'fwd-power':
        // Measured watts during TX (Flex TX bridge). Takes over the PWR bar
        // while frames flow; 0 = decayed after TX.
        echoFwdLiveAt = Date.now();
        updateEchoPower(msg.value);
        break;

      case 'tx-meter':
        updateEchoTxMeter(msg.value);
        break;

      // Shack-side TX drive — desktop is authoritative. Sent at connect and on
      // every change from any surface. Don't clobber the slider mid-drag.
      case 'tune-step':
        // The shack's tuning step (VFO + scope, one value); kept for the
        // scope's wheel/step tuning (docs/scope-improvements-plan.md 12a).
        if (Number(msg.hz) > 0) scopeTuneStepHz = Number(msg.hz);
        break;
      case 'rx-level-state': {
        var rlRow = document.getElementById('so-rx-level-row');
        var rlEl = document.getElementById('rc-rx-level');
        var rlVal = document.getElementById('rc-rx-level-val');
        if (rlRow) rlRow.classList.remove('hidden'); // desktop supports it
        var rlDb = Math.round(Number(msg.value));
        if (rlEl && isFinite(rlDb) && document.activeElement !== rlEl) {
          rlEl.value = rlDb;
          if (rlVal) rlVal.textContent = (rlDb > 0 ? '+' : '') + rlDb + ' dB';
        }
        break;
      }
      case 'tx-drive-state': {
        var tdRow = document.getElementById('so-tx-drive-row');
        var tdEl = document.getElementById('rc-tx-drive');
        var tdVal = document.getElementById('rc-tx-drive-val');
        if (tdRow) tdRow.classList.remove('hidden'); // desktop supports it
        var tdPct = Math.round(Number(msg.value));
        if (tdEl && isFinite(tdPct) && document.activeElement !== tdEl) {
          tdEl.value = tdPct;
          if (tdVal) tdVal.textContent = tdPct + '%';
        }
        break;
      }

      case 'tgxl-status':
        echoTgxlSection.classList.remove('hidden');
        echoTgxlUpdateButtons(msg.antenna || 0, msg.labels);
        break;

      case 'freedv-enabled':
        if (echoFreedvCb) echoFreedvCb.checked = !!msg.enabled;
        break;

      case 'voice-macro-sync': {
        // Incoming voice macro from desktop — store locally. Guard
        // against empty audio: a label-only update with audio:'' would
        // otherwise put an empty blob into IndexedDB and wipe the
        // existing recording. Today's desktop never sends with empty
        // audio (3rd-party / future paths might), but the cost of the
        // guard is zero so let's be safe.
        if (msg.audio) {
          var vmBinary = atob(msg.audio);
          var vmBytes = new Uint8Array(vmBinary.length);
          for (var vi = 0; vi < vmBinary.length; vi++) vmBytes[vi] = vmBinary.charCodeAt(vi);
          var vmBlob = new Blob([vmBytes], { type: 'audio/webm' });
          ssbDbPut(msg.idx, vmBlob, function() { renderSsbMacros(); });
        }
        if (msg.label != null) {
          ssbMacroLabels[msg.idx] = msg.label;
          localStorage.setItem('echocat-ssb-labels', JSON.stringify(ssbMacroLabels));
          if (!msg.audio) renderSsbMacros();
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
      case 'vfo-profiles':
        // Desktop pushed the current profile list (initial or after a change).
        // Hand off to the VFO widget IIFE — it owns the rendering.
        if (typeof window.__vfReceiveProfiles === 'function') {
          window.__vfReceiveProfiles(Array.isArray(msg.profiles) ? msg.profiles : []);
        }
        break;
      case 'rig-presets':
        // The active rig's presets (lib/rig-presets.js), hydrated at connect
        // and after every change on any surface.
        if (typeof window.__vfReceiveRigPresets === 'function') window.__vfReceiveRigPresets(msg);
        break;
      case 'worked-overlay':
        // Worked-states / countries map tints: statuses under the shack's scope.
        workedOverlayReceive(msg);
        break;
      case 'worked-overlay-refused':
        showToast('Only the owner can change the map shading');
        break;
      case 'rig-preset-applied':
        // A preset went on (a tap here or elsewhere, or the shack on a mode
        // change): say so, since AF gain has no readback and the power only
        // arrives through the next status.
        showToast('Rig preset ' + (msg.name || '') + ': ' + (msg.text || '') + (msg.why && msg.why !== 'tap' ? ' — ' + msg.why : ''), 4000);
        break;
      case 'winlink-state':
        mailState = msg;
        mailRenderState();
        break;
      case 'winlink-account':
        mailAcctAnswer(msg);
        break;
      case 'winlink-mailbox':
        mailLists[msg.box] = msg.messages || [];
        if (msg.box === mailBox) mailRenderList();
        break;
      case 'winlink-session':
        if (mailState) mailState.session = msg.session || {};
        mailRenderSession();
        break;
      case 'winlink-message':
        mailShowMessage(msg);
        break;
      case 'winlink-gateways':
        mailGateways = msg.list || [];
        mailGatewayNote = msg.note || '';
        mailRenderGateways();
        break;
      case 'winlink-attachment':
        try {
          var bin = atob(msg.dataBase64 || '');
          var bytes = new Uint8Array(bin.length);
          for (var bi = 0; bi < bin.length; bi++) bytes[bi] = bin.charCodeAt(bi);
          var url = URL.createObjectURL(new Blob([bytes]));
          var a = document.createElement('a'); a.href = url; a.download = msg.name || 'attachment';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        } catch (e) { showToast('Could not save the attachment', 3000, true); }
        break;
      case 'winlink-result':
        if (msg.op === 'account-check' || msg.op === 'register' || msg.op === 'set-password') { mailAcctResult(msg); break; }
        if (!msg.ok && msg.error) showToast(msg.error, 5000, true);
        else if (msg.ok && msg.op === 'compose') { showToast('In the Outbox. It goes out on the next Send / Receive.', 3000); mailShowList(); }
        break;
      case 'winlink-refused':
        showToast(msg.reason === 'guest-pass' ? 'Winlink mail belongs to the shack\'s owner — not available on a Guest Pass' : 'Not available', 4000, true);
        break;
      case 'rig-presets-refused':
        showToast('A Guest Pass cannot change the rig presets', 3000, true);
        break;

      case 'freedv-sync': {
        var syncEl = document.getElementById('echo-freedv-sync');
        var snrEl = document.getElementById('echo-freedv-snr');
        if (syncEl) syncEl.style.background = msg.sync ? '#4ecca3' : '#f0a500';
        if (snrEl) snrEl.textContent = 'SNR: ' + (msg.snr != null ? msg.snr.toFixed(1) : '--');
        break;
      }

      case 'qrz-result':
        if (msg.callsign && msg.callsign.toUpperCase() === JtcatParser.baseCall(tunedCallsign)) {
          // Prefer nickname over fname (matches desktop QRZ display logic)
          tunedOpName = msg.nickname || msg.fname || '';
          tunedState = msg.state || '';
          tunedCountry = msg.country || '';
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
        if (typeof resolveEchoSpotWpm === 'function') resolveEchoSpotWpm();
        renderSpots();
        if (activeTab === 'map') renderMapSpots();
        if (bc) { try { bc.postMessage({ kind: 'spots', data: spots }); } catch {} }
        break;

      case 'directory':
        directoryNets = msg.nets || [];
        directorySwl = msg.swl || [];
        if (Array.isArray(msg.landmarks)) directoryLandmarks = msg.landmarks;
        if (Array.isArray(msg.channels)) directoryChannels = msg.channels;
        if (Array.isArray(msg.landmarkCategories)) directoryLandmarkCategories = msg.landmarkCategories;
        // Show/hide Dir tab based on whether we have data
        var dirTabBtn = document.getElementById('dir-tab-btn');
        if (dirTabBtn) dirTabBtn.classList.toggle('hidden', !directoryNets.length && !directorySwl.length && !directoryLandmarks.length);
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
        // Drop this page's audio too. WebRTC runs peer to peer, so closing
        // the WebSocket leaves the call — and this device's microphone —
        // live into the shack after another device has taken the rig
        // (KF0U 2026-10-17: two tabs open, the FT-710 sat keyed at 0 W until
        // one tab was closed; HALT on the other did nothing).
        endAudioWithSession();
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

      case 'cw-paddle-available':
        // Desktop reports whether paddle keying can actually reach the
        // radio. False = TIOCMSET unsupported AND no pyserial fallback;
        // suppress local sidetone so the user doesn't get confused by
        // tone with no RF (KM4CFT 2026-04-29).
        cwPaddleAvailable = msg.available !== false;
        if (!cwPaddleAvailable) {
          // Stop any in-progress paddle immediately — sidetone, hold
          // keepalives and the server's keyer (a held contact otherwise
          // kept the radio keyed with no release ever sent).
          if (window.__echocatReleasePaddles) window.__echocatReleasePaddles(true);
        }
        updatePaddleHelp();
        break;

      case 'cw-state':
        // Sidetone is driven locally (see createLocalCwKeyer) — server echo
        // here just reflects what the radio is actually keying, used for
        // the visual indicator. Text-macro sidetone still yields to paddle.
        stopCwTextSidetone();
        cwIndicator.classList.toggle('active', !!msg.keying);
        // Paddle-link diagnostics (LZ3AW TinyMidi report): rolling round-trip
        // from paddle press to the server's keying echo. Local sidetone is
        // zero-latency by design; this number is the LAG between what you
        // hear and what the radio keys — the doubled-audio suspect when the
        // rig monitor also returns via the audio bridge.
        if (msg.keying && _paddleRttSentAt) {
          const rtt = performance.now() - _paddleRttSentAt;
          _paddleRttSentAt = 0;
          _paddleRttAvg = _paddleRttAvg ? (_paddleRttAvg * 0.8 + rtt * 0.2) : rtt;
          const el = document.getElementById('cw-paddle-rtt');
          if (el) {
            el.textContent = 'paddle link ~' + Math.round(_paddleRttAvg) + ' ms';
            el.classList.remove('hidden');
          }
        }
        break;

      case 'cw-config-ack':
        if (msg.wpm) {
          cwWpm = msg.wpm;
          cwWpmLabel.textContent = cwWpm + ' WPM';
          localCwKeyer.setWpm(msg.wpm);
          if (window.__vfSyncCw) window.__vfSyncCw();
          if (typeof updateEchoCwSpotWpm === 'function') updateEchoCwSpotWpm();
        }
        if (msg.mode) {
          cwMode = msg.mode;
          localCwKeyer.setMode(msg.mode);
          cwModeB.classList.toggle('active', cwMode === 'iambicB');
          cwModeA.classList.toggle('active', cwMode === 'iambicA');
          cwModeStr.classList.toggle('active', cwMode === 'straight');
        }
        if (typeof msg.swap === 'boolean') {
          cwSwapPaddles = msg.swap;
          localCwKeyer.setSwap(msg.swap);
        }
        break;

      case 'sources':
        if (msg.data) {
          const map = { pota: 'pota', sota: 'sota', wwff: 'wwff', llota: 'llota', cluster: 'dxc' };
          for (const [settingKey, srcAttr] of Object.entries(map)) {
            const cb = ddPanel(spotsDropdown).querySelector(`input[data-src="${srcAttr}"]`);
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

      case 'spot-hides':
        adoptSpotHides(msg.hides);
        if (Array.isArray(msg.skips)) scanSkipped = new Set(msg.skips);
        renderSpots();
        break;

      case 'operators':
        logAsOperators = {
          active: String(msg.active || '').toUpperCase(),
          profiles: Array.isArray(msg.profiles) ? msg.profiles.map(function (c) { return String(c).toUpperCase(); }) : [],
        };
        renderLogAsChoosers();
        break;

      case 'log-ok':
        logSaveBtn.disabled = false;
        ltSave.disabled = false;
        if (msg.success) {
          closeLogSheet();
          resetLogTabForm();
          let toastMsg = 'Logged ' + (msg.callsign || '') + logAsTail();
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
        // Re-check the currently tuned spot — a freshly logged contact could
        // turn the current tune into a dupe.
        if (tunedCallsign) {
          tunedDupe = findEchoSessionDupe(tunedCallsign, tunedFreqKhz, currentMode);
          if (typeof window.__vfRenderAll === 'function') window.__vfRenderAll();
        }
        break;

      case 'worked-parks':
        workedParksSet = new Set(msg.refs || []);
        ddPanel(spotsDropdown).querySelector('.rc-new-only-row').style.display = workedParksSet.size > 0 ? '' : 'none';
        renderSpots();
        if (activeTab === 'map') renderMapSpots();
        break;

      case 'worked-qsos': {
        // Chunked delivery (we advertise chunked-worked-qsos): accumulate
        // until the last chunk, then swap the map in once. Same contract as
        // all-qsos — chunks arrive in order on one socket, and a fresh
        // chunk 0 (or an unchunked frame) starts over.
        let entries = msg.entries || [];
        if (typeof msg.chunk === 'number' && typeof msg.totalChunks === 'number') {
          if (msg.chunk === 0) wqChunkAccum = [];
          wqChunkAccum = wqChunkAccum.concat(entries);
          if (msg.chunk !== msg.totalChunks - 1) break; // wait for the rest
          entries = wqChunkAccum;
          wqChunkAccum = [];
        }
        workedQsos = new Map(entries);
        ddPanel(spotsDropdown).querySelector('.rc-hide-worked-row').style.display = workedQsos.size > 0 ? '' : 'none';
        // The full history arrived, so "today only" no longer applies — the
        // banner used to stay for the whole session once shown (LZ3AW).
        { const wn = document.getElementById('spot-worked-note'); if (wn) wn.classList.add('hidden'); }
        renderSpots();
        if (activeTab === 'map') renderMapSpots();
        break;
      }

      case 'worked-today': {
        // Fallback / supplement for the full worked-qsos push when it
        // gets size-capped for active loggers (>256 KB). Today-only
        // payload is bounded so it's always delivered. Merge into the
        // workedQsos Map so isWorkedSpot() finds these entries.
        if (Array.isArray(msg.entries)) {
          for (const e of msg.entries) {
            if (!e || !e.call) continue;
            const call = String(e.call).toUpperCase();
            const log = { date: e.date || '', ref: e.ref || '', band: e.band || '', mode: e.mode || '' };
            const list = workedQsos.get(call) || [];
            // Skip exact duplicates from the full push.
            const dup = list.some(l => l.date === log.date && l.ref === log.ref && l.band === log.band && l.mode === log.mode);
            if (!dup) {
              list.push(log);
              workedQsos.set(call, list);
            }
          }
          if (workedQsos.size > 0) {
            ddPanel(spotsDropdown).querySelector('.rc-hide-worked-row').style.display = '';
          }
          renderSpots();
          if (activeTab === 'map') renderMapSpots();
        }
        break;
      }

      case 'worked-qsos-skipped': {
        // The full per-call history was too large to push (>256 KB serialized)
        // — the desktop still sends the bounded worked-today summary, so
        // today's dimming works but the "worked before" check covers today
        // only. Say so instead of silently showing fewer checks (LZ3AW item
        // 1: big logs lost the marks with no explanation).
        const note = document.getElementById('spot-worked-note');
        if (note) {
          note.textContent = 'Worked history too large to sync in full - check marks cover today only';
          note.classList.remove('hidden');
        }
        break;
      }

      // Where this station is heard — the desktop pushes both at connect and
      // on every change (they were sent to the page and never drawn).
      case 'jtcat-tune-state': {
        // The tune tone is on: light the PSK31 pane's Tune button.
        const tb = document.getElementById('psk-tune');
        if (tb) tb.classList.toggle('active', !!msg.active);
        break;
      }
      case 'expedition-callsigns':
        dxeState.calls = new Set((msg.callsigns || []).map(c => String(c).toUpperCase()));
        dxeState.meta = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
        renderSpots();
        break;
      case 'rbn-prop-spots':
        propRbn = Array.isArray(msg.spots) ? msg.spots : [];
        if (activeTab === 'prop') renderProp();
        break;
      case 'pskr-map-spots':
        propPskr = Array.isArray(msg.spots) ? msg.spots : [];
        if (activeTab === 'prop') renderProp();
        break;

      case 'solar-data': {
        // Desktop status-bar parity: SFI/K/A pills with the same color
        // thresholds (SFI >=100 good / >=70 warn; K <=2 / <=4; A <=7 / <=20).
        if (msg.sfi != null || msg.kIndex != null || msg.aIndex != null) {
          lastSolarData = msg;
          renderSolarPills();
        }
        break;
      }

      case 'freq-other': {
        // Other-VFO (TX side) frequency while split is on; 0 = hide. The
        // desktop pushed this all along — the web client just never listened.
        lastFreqOtherHz = Number(msg.value) || 0;
        renderFreqOther();
        break;
      }

      case 'cluster-state':
        clusterConnected = !!msg.connected;
        break;

      case 'cluster-node-result':
        if (msg.ok === false && msg.error) showToast(msg.error, 4000, true);
        break;
      case 'settings-update':
        if (msg.settings && msg.settings.pskSquelch != null) {
          const sqEl = document.getElementById('psk-sql');
          const sqVal = document.getElementById('psk-sql-val');
          if (sqEl && document.activeElement !== sqEl) {
            sqEl.value = msg.settings.pskSquelch;
            if (sqVal) sqVal.textContent = msg.settings.pskSquelch;
          }
        }
        if (msg.settings) {
          if (Array.isArray(msg.settings.clusterNodeChoices)) renderClusterNodeChoices(msg.settings.clusterNodeChoices);
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
          if (msg.settings.cwKeyerMode) {
            cwMode = msg.settings.cwKeyerMode;
            localCwKeyer.setMode(cwMode);
          }
          if (typeof msg.settings.cwSwapPaddles === 'boolean') {
            cwSwapPaddles = msg.settings.cwSwapPaddles;
            localCwKeyer.setSwap(cwSwapPaddles);
          }
          syncTuningUI();
          // JTTY macros, style, serial, profile: the pane renders from echoSettings.
          if (['jttyMacros', 'jttyTemplates', 'jttyFt8Macros', 'jttyMacroStyle', 'jttySerial', 'jttyProfile', 'jtcatFdExch'].some((k) => k in msg.settings)) {
            echoSettings = Object.assign(echoSettings || {}, msg.settings);
            if (typeof jttyOnSettings === 'function') jttyOnSettings(msg.settings);
          }
          // Sync SSTV templates if updated
          if (msg.settings.sstvTemplates || msg.settings.sstvTextElements) {
            echoSettings = Object.assign(echoSettings || {}, msg.settings);
            sstvPhoneLoadSettings();
          }
          // Re-hydrate the WebSDR / KiwiSDR station list. Without this, an
          // auth-ok that arrived before the desktop's _remoteSettings was
          // fully populated leaves the station selector empty for the rest
          // of the session — only a fresh reconnect (or an unrelated
          // settings round-trip) ever brings the list back. KO6M
          // 2026-05-05 ("did it once and now it shows nothing").
          if (typeof kiwiLoadStationsE === 'function' && (
              'kiwiSdrHost1' in msg.settings ||
              'kiwiSdrHost2' in msg.settings ||
              'kiwiSdrHost3' in msg.settings ||
              'kiwiSdrLabel1' in msg.settings ||
              'kiwiSdrLabel2' in msg.settings ||
              'kiwiSdrLabel3' in msg.settings ||
              'kiwiSdrHost' in msg.settings)) {
            kiwiLoadStationsE(msg.settings);
          }
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
        // Cloud TURN relay creds (Model A: minted by the desktop, handed to
        // us here). Adopt them for the next ICE gather. A useStun-only message
        // must NOT wipe a TURN list we already hold (re-mint sends the full
        // list; an interim useStun ping shouldn't downgrade us).
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) {
          _turnIceServers = msg.iceServers;
          // If audio is already live, apply before the next gather. On a
          // healthy PC this is harmless; it takes effect on reconnect/re-gather.
          if (pc) { try { pc.setConfiguration({ iceServers: _turnIceServers }); } catch (e) {} }
        }
        break;

      case 'all-qsos': {
        // Chunked delivery (we advertise chunked-all-qsos): accumulate until
        // the last chunk, then render once. Chunks arrive in order on one
        // socket; a fresh chunk 0 (or an unchunked frame) starts over.
        if (typeof msg.chunk === 'number' && typeof msg.totalChunks === 'number') {
          if (msg.chunk === 0) lbChunkAccum = [];
          lbChunkAccum = lbChunkAccum.concat(msg.data || []);
          if (msg.chunk === msg.totalChunks - 1) {
            logbookQsos = lbChunkAccum;
            lbChunkAccum = [];
            lbTotal = msg.total || logbookQsos.length;
            lbTruncated = false;
            renderLogbook();
          }
          break;
        }
        logbookQsos = msg.data || [];
        lbTotal = msg.total || logbookQsos.length;
        lbTruncated = !!msg.truncated;
        renderLogbook();
        break;
      }

      case 'qso-added':
        // qso-delta capability: one record per log write instead of a full
        // re-push. Records carry their full-log idx already.
        if (msg.data) {
          logbookQsos.push(msg.data);
          lbTotal = msg.total || logbookQsos.length;
          renderLogbook();
        }
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
      case 'rig-bands':
        // The shack's active rig is used on these bands only (null = all).
        webRigBands = Array.isArray(msg.bands) ? msg.bands : null;
        applyWebRigBands();
        break;
      case 'jtcat-tx-slot-state':
        if (typeof reflectFt8TxSlot === 'function') reflectFt8TxSlot(msg.lock);
        break;
      case 'jtcat-slot-refused':
        if (typeof showFt8SlotRefused === 'function') showFt8SlotRefused(msg);
        break;
      case 'jtcat-rx-gain-state': {
        // Desktop-authoritative synced RX gain — sent at connect and whenever
        // any surface moves it. Our own drags aren't echoed back (the desktop
        // skips the origin), so this can't fight the slider mid-drag.
        var rgPct = Math.round(Number(msg.value) * 100);
        if (isFinite(rgPct)) {
          var rgEl = document.getElementById('ft8-rx-gain');
          var rgVal = document.getElementById('ft8-rx-gain-val');
          if (rgEl) {
            rgEl.value = rgPct;
            if (rgVal) rgVal.textContent = rgPct + '%';
          }
          try { localStorage.setItem('echocat-ft8-rx-gain', rgPct); } catch (e) {}
        }
        break;
      }

      case 'jtcat-tx-gain-state': {
        // Same for TX power (2026-09-09). The wire value is the GAIN —
        // (pct/100)^2, the square curve every TX slider uses — so invert it.
        var tgPct = Math.round(Math.sqrt(Math.max(0, Number(msg.value))) * 100);
        if (isFinite(tgPct)) {
          var tgEl = document.getElementById('ft8-tx-gain');
          var tgVal = document.getElementById('ft8-tx-gain-val');
          if (tgEl) {
            tgEl.value = tgPct;
            if (tgVal) tgVal.textContent = tgPct + '%';
          }
          try { localStorage.setItem('echocat-ft8-tx-gain', tgPct); } catch (e) {}
        }
        break;
      }

      case 'jtcat-status':
        ft8Running = msg.running !== false;
        ft8Mode = msg.mode || ft8Mode;
        ft8ModeSelect.value = ft8Mode;
        ft8SyncStatus.textContent = 'Sync: ' + (msg.sync || '--');
        applyDigitalPanes(); // host-driven mode change (popout/phone) swaps panes too
        break;

      // --- PSK31 / WSPR (web parity: docs/desktop-handoffs/echocat-web-parity-wspr-psk-menu.md) ---
      case 'jtcat-jtty-rx':
        jttyHandleRx(msg);
        break;
      case 'jtcat-jtty-refused':
        jttyShowRefused(msg);
        break;
      case 'jtcat-psk-rx':
        pskHandleRx(msg);
        break;

      case 'jtcat-wspr-spots':
        wsprHandleSpots(msg);
        break;

      case 'jtcat-wspr-beacon-state':
        wsprBeaconEcho(msg);
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
          ft8TxFreqDisplay.textContent = 'TX: ' + Math.round(msg.txFreq) + ' Hz';
        }
        if (ft8Transmitting && ft8TxMsg) {
          // Remember what we're sending so the cycle-decode handler can
          // render this in the correct cycle slot once the engine reports
          // results=[] for the TX cycle. Don't render directly here — by
          // the time the cycle decode arrives (~14s later), live append
          // would land in the *previous* cycle's section.
          ft8PendingTxMsg = ft8TxMsg;
        }
        // JTTY has no cycles: our transmission is a row in its list right now.
        if (ft8Mode === 'JTTY') jttyOnTxStatus(msg);
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
        if (typeof jttyFeedSpectrum === 'function') jttyFeedSpectrum(msg.bins);
        break;
      case 'jtcat-hold-tx-state':
        // The desktop's Hold TX frequency (one setting for FT8 and JTTY).
        if (typeof jttySetHold === 'function') jttySetHold(!!msg.enabled);
        break;

      case 'scope-frame':
        scopeRenderFrame(msg.bins);
        break;
      case 'scope-state':
        scopeApplyState(msg);
        break;

      case 'jtcat-auto-cq-state':
        if (ft8AutoCqSelect) {
          // "Event" (Hunt: Event stations) is offered only while the shack
          // says a tracked event is near (msg.eventHunt) — and kept while it
          // is the selected mode, so the select never loses its value.
          const evOffer = !!(msg.eventHunt && msg.eventHunt.available);
          let evOpt = ft8AutoCqSelect.querySelector('option[value="event"]');
          if ((evOffer || msg.mode === 'event') && !evOpt) {
            evOpt = document.createElement('option');
            evOpt.value = 'event';
            evOpt.textContent = 'Event';
            ft8AutoCqSelect.appendChild(evOpt);
          } else if (!evOffer && msg.mode !== 'event' && evOpt) {
            evOpt.remove();
            evOpt = null;
          }
          if (evOpt) {
            const names = ((msg.eventHunt && msg.eventHunt.events) || []).map((e) => e.name).filter(Boolean);
            evOpt.title = 'Hunt: answer CQs from stations you still need for '
              + (names.length ? names.join(', ') : 'a tracked event');
          }
          ft8AutoCqSelect.value = msg.mode || 'off';
          ft8AutoCqSelect.style.borderColor = msg.mode !== 'off' ? 'var(--pota)' : '';
        }
        break;

      case 'jtcat-chase-target':
        // Desktop (or another client) changed the shared chase target.
        if (typeof window.__ft8ReflectChase === 'function') window.__ft8ReflectChase(msg.tag || '');
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

      // --- SSTV ---
      case 'sstv-tx-status':
        sstvPhoneRxActive = false;
        if (msg.state === 'tx') {
          sstvPhoneStartTxProgress(msg.durationSec || 0);
          if (sstvPhoneStatus) { sstvPhoneStatus.textContent = 'Transmitting...'; sstvPhoneStatus.style.color = 'var(--accent)'; }
        } else if (msg.state === 'auto-rx') {
          if (sstvPhoneStatus) {
            sstvPhoneStatus.textContent = 'Auto-SSTV ' + (msg.freqKhz ? (msg.freqKhz / 1000).toFixed(3) : '') + ' MHz';
            sstvPhoneStatus.style.color = 'var(--pota)';
          }
        } else {
          sstvPhoneStopTxProgress();
          if (sstvPhoneStatus) { sstvPhoneStatus.textContent = 'Ready'; sstvPhoneStatus.style.color = 'var(--text-dim)'; }
        }
        sstvPhoneUpdateSendBtn();
        break;
      case 'sstv-rx-progress': {
        var pct = Math.round((msg.progress || 0) * 100);
        sstvPhoneRxActive = true;
        if (sstvPhoneStatus) {
          sstvPhoneStatus.textContent = 'Receiving ' + pct + '%';
          sstvPhoneStatus.style.color = 'var(--pota)';
        }
        if (sstvPhoneDecodeStatus) {
          sstvPhoneDecodeStatus.style.display = '';
          sstvPhoneDecodeStatus.textContent = 'Decoding ' + (msg.line || 0) + '/' + (msg.totalLines || '?') + ' (' + pct + '%)';
        }
        sstvPhoneUpdateSendBtn();
        break;
      }
      case 'sstv-rx-image':
        sstvPhoneRxActive = false;
        if (sstvPhoneStatus) { sstvPhoneStatus.textContent = 'Ready'; sstvPhoneStatus.style.color = 'var(--text-dim)'; }
        sstvPhoneUpdateSendBtn();
        sstvPhoneAddRxImage(msg);
        break;
      case 'sstv-gallery':
        sstvPhoneHandleGallery(msg);
        break;
      case 'sstv-wf-bins':
        sstvPhoneDrawWfLine(msg.bins);
        break;
      case 'sstv-compose-state':
        sstvPhoneApplyComposeState(msg);
        break;
    }
  }

  // --- Status ---
  function updateStatus(s) {
    // Merged copy for custom toggles that follow the radio (fields a push
    // leaves out keep their last value).
    if (s && typeof s === 'object') {
      for (var ck in s) if (Object.prototype.hasOwnProperty.call(s, ck) && s[ck] !== undefined) customRadioState[ck] = s[ck];
      refreshCustomToggles();
    }
    if (s.freq > 100000) { // ignore bogus values below 100 kHz
      freqDisplay.textContent = formatFreq(s.freq);
      const prevFreqKhz = currentFreqKhz;
      currentFreqKhz = s.freq / 1000;
      if (Math.abs(currentFreqKhz - prevFreqKhz) > 0.05 && typeof resolveEchoSpotWpm === 'function') resolveEchoSpotWpm();
      logSheetFollowRadio();
      quickLogFollowRadio();
      if (bc) { try { bc.postMessage({ kind: 'vfo', freqKhz: currentFreqKhz, mode: (modeBadge && modeBadge.textContent) || '' }); } catch {} }
      // Repaint the Dir list so the tuned net/broadcast ring tracks the radio
      // (e.g. someone spinning the VFO on desktop while ECHOCAT shows Dir).
      if (activeTab === 'dir' && Math.abs(currentFreqKhz - prevFreqKhz) > 0.05) {
        renderDirectoryTab();
      }
      // Sync SSTV phone frequency dropdown
      if (sstvFreqPhone) {
        var khz = Math.round(s.freq / 1000);
        for (var i = 0; i < sstvFreqPhone.options.length; i++) {
          if (parseInt(sstvFreqPhone.options[i].value) === khz) {
            sstvFreqPhone.selectedIndex = i;
            break;
          }
        }
      }
    }
    if (typeof s.noCat === 'boolean' && s.noCat !== currentNoCat) { currentNoCat = s.noCat; updateSsbPanelVisibility(); }
    if (s.mode) {
      currentMode = s.mode;
      quickLogFollowRadio();
      // Display friendly name for FreeDV modes
      const mUp = s.mode.toUpperCase();
      modeBadge.textContent = mUp.startsWith('FREEDV') ? (mUp.includes('RADE') ? 'RADE' : 'FreeDV') : s.mode;
      // PKTUSB / PKTLSB / DIGU / DIGL are SSB sub-band positions used for
      // FT8/FT4/FreeDV — they're voice-capable carriers, not CW. Without
      // these, FreeDV (which lands the rig on PKTLSB on lower bands and
      // PKTUSB on upper) hides the PTT button on phones. (G7-Chris report.)
      const isVoice = (mUp === 'SSB' || mUp === 'USB' || mUp === 'LSB' ||
                       mUp === 'FM' || mUp === 'AM' ||
                       mUp === 'AMN' || mUp === 'FMN' ||
                       mUp === 'PKTUSB' || mUp === 'PKTLSB' ||
                       mUp === 'DIGU' || mUp === 'DIGL' ||
                       mUp === 'USB-D' || mUp === 'LSB-D' ||
                       mUp.startsWith('FREEDV'));
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
      // VK3AWA: cut SDR audio while transmitting so the operator doesn't
      // hear themselves through the remote receiver.
      if (kiwiGainNodeE) kiwiGainNodeE.gain.value = s.txState ? 0 : 1;
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
    if (s.split != null) {
      const sp = document.getElementById('rc-split');
      if (sp) sp.classList.toggle('active', !!s.split);
      // Split off means there is no TX side to show. rig-state arrives on
      // every change AND at connect, so gating the TX line on it here clears
      // the readout even if the freq-other push was missed or raced — the
      // stale "TX <freq>" LZ3AW saw survive split going off (2026-08-28).
      if (!s.split && lastFreqOtherHz) {
        lastFreqOtherHz = 0;
        renderFreqOther();
      }
    }
    if (s.filterWidth !== undefined) {
      currentFilterWidth = s.filterWidth;
      rcBwLabel.textContent = formatBw(s.filterWidth);
    }
    if (s.rfgain !== undefined) {
      rcRfGainSlider.value = s.rfgain;
      rcRfGainVal.textContent = s.rfgain;
    }
    if (s.squelch !== undefined && rcSquelchSlider && document.activeElement !== rcSquelchSlider) {
      rcSquelchSlider.value = s.squelch;
      rcSquelchVal.textContent = s.squelch;
    }
    if (s.txpower !== undefined) {
      rcTxPowerSlider.value = s.txpower;
      rcTxPowerVal.textContent = s.txpower;
    }
    if (s.micGain !== undefined && s.micGain !== null) applyMicGainState(s.micGain);
    if (s.capabilities) {
      setMicGainVisible(!!s.capabilities.micGain);
      rigCapabilities = s.capabilities;
      soFilterRow.classList.toggle('hidden', !s.capabilities.filter);
      rcNbGroup.classList.toggle('hidden', !s.capabilities.nb);
      rcAtuGroup.classList.toggle('hidden', !s.capabilities.atu);
      // vfoSelect:false — the radio swaps A/B but cannot SELECT one (FT-991A
      // has no VS command); the A | B pair hides, the swap stays.
      if (rcVfoA && rcVfoB) {
        const noSelect = s.capabilities.vfoSelect === false;
        rcVfoA.classList.toggle('hidden', noSelect);
        rcVfoB.classList.toggle('hidden', noSelect);
      }
      scopeUpdateTabVisibility();
      soRfGainRow.classList.toggle('hidden', !s.capabilities.rfgain);
      // FM squelch — mode-gated like the desktop: shown in FM (any band) or
      // while engaged. When mode is momentarily unknown (suppressed during a
      // tune) and squelch isn't engaged, leave the row as-is to avoid flicker.
      if (soSquelchRow) {
        const sqCap = !!s.capabilities.squelch;
        if (sqCap && (s.squelch || 0) > 0) soSquelchRow.classList.remove('hidden');
        else if (s.mode !== undefined) soSquelchRow.classList.toggle('hidden', !(sqCap && s.mode === 'FM'));
      }
      soTxPowerRow.classList.toggle('hidden', !s.capabilities.txpower);
      rcVfoGroup.classList.toggle('hidden', !s.capabilities.vfo && !s.capabilities.split);
      const rcSplitBtn = document.getElementById('rc-split');
      if (rcSplitBtn) rcSplitBtn.classList.toggle('hidden', !s.capabilities.split);
      // Rig On/Off — show wherever the radio's CAT set supports PS0/PS1, 0x18, or equivalent.
      // Applies to both the Settings-overlay group and the VFO widget row.
      const rcPowerGroup = document.getElementById('rc-power');
      if (rcPowerGroup) rcPowerGroup.classList.toggle('hidden', !s.capabilities.power);
      const vfPowerRow = document.getElementById('vf-power-row');
      if (vfPowerRow) vfPowerRow.classList.toggle('hidden', !s.capabilities.power);
      // Clamp TX power slider to radio's min/max
      if (s.capabilities.minPower != null) rcTxPowerSlider.min = s.capabilities.minPower;
      if (s.capabilities.maxPower != null) rcTxPowerSlider.max = s.capabilities.maxPower;
    }
    // Mirror the same state into the optional VFO panel widgets.
    if (window.__vfUpdateRig) window.__vfUpdateRig(s);
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
    const spotMode = spotModeKey(s); // normalized like the logged mode (KC1SSY)
    const spotRef = (s.reference || '').toUpperCase();
    // Same roving-activator fix as the desktop: match on the park/summit
    // reference too when the spot has one, otherwise a different park for a
    // previously-worked call would be falsely grayed. (NG9P report, 2026-04)
    if (spotRef) {
      return todayQsos.some(e =>
        (e.ref || '').toUpperCase() === spotRef &&
        (!spotBand || e.band === spotBand) &&
        (!spotMode || e.mode === spotMode)
      );
    }
    if (spotBand || spotMode) {
      return todayQsos.some(e =>
        (!spotBand || e.band === spotBand) &&
        (!spotMode || e.mode === spotMode)
      );
    }
    return true;
  }

  // The check mark means worked on THIS band and mode, any date — a call
  // worked once on 40 m CW is still a fresh contact on 20 m SSB (LZ3AW #14).
  // Modes compare as the worked map stores them (USB/LSB logged as SSB).
  // A spot's mode the way logged modes are normalized (USB/LSB -> SSB; a
  // generic data mode matches any). Same rule as spotModeKey() in app.js.
  function spotModeKey(s) {
    const m = String(s.mode || '').toUpperCase();
    if (m === 'USB' || m === 'LSB') return 'SSB';
    if (m === 'DIGI' || m === 'DATA' || m === 'DIGITAL') return '';
    return m;
  }
  function hasWorkedOnBandMode(s) {
    const entries = workedQsos.get((s.callsign || '').toUpperCase());
    if (!entries || !entries.length) return false;
    const band = String(s.band || '').toUpperCase();
    const mode = spotModeKey(s);
    return entries.some((e) => (!band || e.band === band) && (!mode || e.mode === mode));
  }

  // Map spot mode to filter category
  var KNOWN_MODES = new Set(['CW', 'SSB', 'FT8', 'FT4', 'JS8', 'FM', 'RTTY', 'PSK31', 'JTTY', 'FREEDV']);
  function spotModeCategory(mode) {
    // Distinguish "no mode listed" (some POTA activators only spot a
    // freq) from "mode listed but exotic" (AM, etc.). Lets users untick
    // FreeDV/Other while keeping no-mode activations visible.
    if (!mode) return 'unknown';
    var m = mode.toUpperCase();
    if (m === 'USB' || m === 'LSB') return 'SSB';
    if (m === 'AM') return 'other';
    if (m === 'FREEDV' || m === 'DV' || m.startsWith('FREEDV')) return 'FREEDV';
    if (KNOWN_MODES.has(m)) return m;
    return 'other';
  }

  // DX Expeditions — the desktop's Spots > DX Expeditions toggles. Main
  // pushes the merged expedition list ('expedition-callsigns'); a call is
  // flagged only while the master toggle is on and at least one of the feeds
  // that listed it is on (app.js isExpeditionVisible). A DXpedition gets the
  // red DXP badge and sorts to the top, a contest station a CONTEST badge.
  const DXE_DEFAULT_SOURCES = { clublog: true, 'dx-world': true, dxnews: true, ng3k: true };
  const dxeState = { enable: false, sources: Object.assign({}, DXE_DEFAULT_SOURCES), calls: new Set(), meta: {} };
  function dxeKind(callsign, st) {
    if (!st || !st.enable) return '';
    const up = String(callsign || '').toUpperCase();
    if (!st.calls || !st.calls.has(up)) return '';
    const m = st.meta ? st.meta[up] : null;
    let visible = !m || !m.sources;
    if (!visible) {
      for (const src of String(m.sources).split(',')) {
        if (st.sources && st.sources[src.trim()]) { visible = true; break; }
      }
    }
    if (!visible) return '';
    return m && m.kind === 'contest' ? 'contest' : 'dxpedition';
  }
  function dxeTitle(callsign) {
    const m = dxeState.meta[String(callsign || '').toUpperCase()];
    if (!m) return '';
    return [m.contest, m.entity, m.dates, m.operators ? 'By ' + m.operators : '', m.qsl ? 'QSL ' + m.qsl : '']
      .filter(Boolean).join(' · ');
  }
  function reflectDxeToggles() {
    const master = document.getElementById('rc-dxe');
    if (!master) return;
    master.checked = dxeState.enable;
    const box = document.querySelector('.rc-dxe-sources');
    if (box) box.classList.toggle('off', !dxeState.enable);
    document.querySelectorAll('[data-dxe-src]').forEach(c => { c.checked = !!dxeState.sources[c.dataset.dxeSrc]; });
  }

  function getFilteredSpots() {
    const bands = getDropdownValues(bandFilterEl);
    const modes = getDropdownValues(modeFilterEl);
    const regions = getDropdownValues(regionFilterEl);
    const filtered = spots.filter(s => {
      if (bands && !bands.has(s.band)) return false;
      if (modes && !modes.has(spotModeCategory(s.mode))) return false;
      if (callFilter.length && !callMatchesFilter(s.callsign, callFilter)) return false;
      if (regions && s.continent && !regions.has(s.continent)) return false;
      if (spotMatchesMuteRule(s)) return false;
      if (showNewOnly && !isNewPark(s)) return false;
      if (hideWorked && isWorkedSpot(s)) return false;
      if (dxOnly && !s.isDx) return false;
      // Hidden on the desktop's list: every spot of the call, this kHz, or
      // this band (the row's H button; lifts when they QSY to another band).
      if (isSpotHiddenByList(s.callsign, s.frequency, s.band)) return false;
      return true;
    });
    filtered.sort((a, b) => {
      const aNet = a.source === 'net' ? 1 : 0;
      const bNet = b.source === 'net' ? 1 : 0;
      if (aNet !== bNet) return bNet - aNet;
      const aDxp = dxeKind(a.callsign, dxeState) === 'dxpedition' ? 1 : 0;
      const bDxp = dxeKind(b.callsign, dxeState) === 'dxpedition' ? 1 : 0;
      if (aDxp !== bDxp) return bDxp - aDxp;
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

  // Grid, cells and formatters live in lib/spot-row.js (inlined above), the
  // one copy the layout test renders (test/layout-alignment-test.js).
  function computeSpotGrid() { return SpotRow.computeSpotGrid(colOrder, colShow); }

  function renderSpots() {
    const filtered = getFilteredSpots();

    if (filtered.length === 0) {
      spotList.innerHTML = '<div class="spot-empty">No spots</div>';
      return;
    }

    // Grid template shared by every card — recomputed each render in case
    // the user toggled column visibility or reordered columns in Settings.
    spotList.style.setProperty('--spot-grid', computeSpotGrid());

    spotList.innerHTML = filtered.map(s => {
      const newPark = isNewPark(s);
      const workedToday = isWorkedSpot(s);
      const workedEver = !workedToday && hasWorkedOnBandMode(s);
      let workedOther = '';
      if (!workedToday && !workedEver) {
        const d = new Date();
        const today = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
        workedOther = SpotRow.workedElsewhereTitle(SpotRow.workedElsewhereToday(workedQsos.get((s.callsign || '').toUpperCase()), s.band, spotModeKey(s), today));
      }
      const isSkipped = scanSkipped.has(spotSkipKey(s)) || (workedToday && !scanForceUnskipped.has(spotSkipKey(s)));
      const dxe = dxeKind(s.callsign, dxeState);
      const call = (s.callsign || '').toUpperCase();
      return SpotRow.spotRowHtml(s, {
        tuned: !!(tunedFreqKhz && s.frequency === tunedFreqKhz),
        newPark, workedToday, workedEver, workedOther, isSkipped,
        dxe: dxe === 'contest' ? 'contest' : dxe ? 'dxpedition' : '',
        dxeTitle: dxe ? dxeTitle(s.callsign) : '',
        opName: qrzNameCache[call] || '',
        age: formatAge(s.spotTime),
        donor: donorCallsigns.has(call),
        creator: call === 'K3SBP',
        distUnit,
      }, { colOrder, colShow });
    }).join('');
  }

  function formatSpotFreq(kHz) { return SpotRow.formatSpotFreq(kHz); }
  function abbreviateCountry(name) { return SpotRow.abbreviateCountry(name); }

  function formatSpotDist(miles) { return SpotRow.formatSpotDist(miles, distUnit); }

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

  // Call once per spotMap instance — wires the map-level click handler that
  // clears the sticky popup when the user clicks an empty area.
  function wireSpotMapClicks(map) {
    if (!map || map._popoutClickWired) return;
    map._popoutClickWired = true;
    map.on('click', () => {
      _openPopupCall = null;
    });
  }

  function renderMapSpots() {
    if (!spotMap) return;
    wireSpotMapClicks(spotMap);
    if (!spotMapLayer) spotMapLayer = L.layerGroup().addTo(spotMap);

    const filtered = getFilteredSpots();
    const bounds = [];
    const initialRender = !spotMapHasFit;

    // Home-QTH marker — reuse across renders unless the grid changed (no flicker).
    if (phoneGrid) {
      const home = gridToLatLonLocal(phoneGrid);
      if (home) {
        if (_mapHomeGrid !== phoneGrid) {
          if (_mapHomeMarker) { try { spotMapLayer.removeLayer(_mapHomeMarker); } catch {} }
          _mapHomeMarker = L.circleMarker([home.lat, home.lon], { radius: 8, color: '#e94560', fillColor: '#e94560', fillOpacity: 1 })
            .bindPopup('Home QTH');
          _mapHomeMarker.addTo(spotMapLayer);
          _mapHomeGrid = phoneGrid;
        }
        bounds.push([home.lat, home.lon]);
      }
    } else if (_mapHomeMarker) {
      try { spotMapLayer.removeLayer(_mapHomeMarker); } catch {}
      _mapHomeMarker = null;
      _mapHomeGrid = null;
    }

    // Differential spot markers — update existing, add new, remove missing.
    // Keeps any open popup intact across the ~2s spot-push cycle.
    const presentKeys = new Set();
    filtered.forEach(s => {
      if (!s.lat || !s.lon) return;
      const key = s.callsign + '|' + s.frequency;
      presentKeys.add(key);
      const color = SOURCE_COLORS_MAP[s.source] || '#888';
      const dist = formatSpotDist(s.distance);
      const ref = s.reference || s.locationDesc || '';
      const popupHtml = '<b>' + esc(s.callsign) + '</b><br>' + esc(ref) + '<br>' + formatSpotFreq(s.frequency) + ' ' + dist;
      let marker = _mapMarkers[key];
      if (marker) {
        // Existing marker — refresh popup content (distance/time) without recreating.
        try { marker.setPopupContent(popupHtml); } catch {}
        bounds.push([s.lat, s.lon]);
        return;
      }
      marker = L.circleMarker([s.lat, s.lon], {
        radius: 7, color, fillColor: color, fillOpacity: 0.8, weight: 1
      });
      marker.bindPopup(popupHtml, { autoClose: false, closeOnClick: false });
      marker.on('click', (ev) => {
        _openPopupCall = s.callsign;
        sendToServer({ type: 'tune', freqKhz: s.frequency, mode: s.mode, bearing: s.bearing ? parseFloat(s.bearing) : undefined });
        tunedFreqKhz = s.frequency;
        drawSpotTuneArc(s.lat, s.lon, s.source);
        // Prevent the click from bubbling up to the map's click handler (which
        // would clear _openPopupCall immediately).
        if (ev && ev.originalEvent && L && L.DomEvent) L.DomEvent.stopPropagation(ev.originalEvent);
      });
      marker.addTo(spotMapLayer);
      _mapMarkers[key] = marker;
      // If this is the sticky-popup spot and it just appeared, open its popup.
      if (_openPopupCall && s.callsign === _openPopupCall && !marker.isPopupOpen()) {
        setTimeout(() => { try { marker.openPopup(); } catch {} }, 0);
      }
      bounds.push([s.lat, s.lon]);
    });

    // Remove markers that dropped out of the filter.
    for (const key of Object.keys(_mapMarkers)) {
      if (!presentKeys.has(key)) {
        try { spotMapLayer.removeLayer(_mapMarkers[key]); } catch {}
        delete _mapMarkers[key];
      }
    }

    // Only auto-zoom on first render; subsequent updates preserve user's pan/zoom
    if (initialRender) {
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
      const call = skipTarget.dataset.skipcall;
      const freq = skipTarget.dataset.skipfreq;
      const key = call + '\t' + freq;
      const skipped = !scanSkipped.has(key);
      if (!skipped) {
        scanSkipped.delete(key);
        scanForceUnskipped.add(key);
      } else {
        scanSkipped.add(key);
        scanForceUnskipped.delete(key);
      }
      sendSpotHideOp({ type: 'skip-spot', call: call, frequency: freq, skipped: skipped });
      renderSpots();
      return;
    }
    const hideTarget = e.target.closest('.spot-hide-btn');
    if (hideTarget) {
      toggleCallBandHidden(hideTarget.dataset.hidecall, hideTarget.dataset.hideband);
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
          // Multi-type cross-program refs from the spot card.
          potaRef:  card.dataset.potaRef  || '',
          sotaRef:  card.dataset.sotaRef  || '',
          wwffRef:  card.dataset.wwffRef  || '',
          llotaRef: card.dataset.llotaRef || '',
        });
      }
      return;
    }
    // The callsign opens QRZ, as on the desktop; the rest of the card (the
    // frequency included) tunes (LZ3AW 2026-10-16).
    const callTarget = e.target.closest('.spot-call');
    if (callTarget) {
      const callCard = callTarget.closest('.spot-card');
      const base = JtcatParser.baseCall((callCard && callCard.dataset.call) || '');
      if (base) window.open('https://www.qrz.com/db/' + encodeURIComponent(base), '_blank', 'noopener');
      return;
    }
    const card = e.target.closest('.spot-card');
    if (!card || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Lock stops the whole selection flow: no tune, no highlight, no VFO
    // op-info update. Skip/log buttons above still work.
    if (vfoLocked) {
      showToast('VFO Locked — Unlock VFO to change frequency', 2000);
      return;
    }
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
    // Look up operator name and state from QRZ for CW macros / VFO op-info
    tunedOpName = '';
    tunedState = '';
    tunedCountry = '';
    // Park ref + program (POTA/SOTA/WWFF/LLOTA) come from the spot card itself
    tunedRef = (card.dataset.ref || '').toUpperCase();
    tunedSig = (typeof srcToSig === 'function' ? srcToSig(card.dataset.src) : '') || '';
    // Beam heading from main's haversine on the spot — present on every
    // spot that has lat/lon/grid resolution (most POTA/SOTA/WWFF/LLOTA, plus
    // RBN/cluster after cty.dat lookup). Card data-bearing is the source.
    {
      const b = parseFloat(card.dataset.bearing);
      tunedBearing = isFinite(b) ? b : null;
    }
    // POTA dupe check — flag if this call+band+mode is already in the
    // activation's session contacts.
    tunedDupe = findEchoSessionDupe(callsign, freqKhz, mode);
    if (callsign && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'qrz-lookup', callsign: JtcatParser.baseCall(callsign) }));
    }
    spotList.querySelectorAll('.spot-card.tuned').forEach(c => c.classList.remove('tuned'));
    card.classList.add('tuned');

    // FT8/FT4 spot -> switch to FT8 tab and hunt the station
    const modeUpper = (mode || '').toUpperCase();
    if ((modeUpper === 'FT8' || modeUpper === 'FT4' || modeUpper === 'FT2') && callsign) {
      // The spot's mode becomes the tab's mode — the band dials follow it, and
      // a RUNNING engine is told (it only heard 'jtcat-start' when stopped, so
      // an FT4 spot was hunted by an FT8 engine; LZ3AW item 15).
      const modeChanged = ft8Mode !== modeUpper;
      ft8Mode = modeUpper;
      ft8ModeSelect.value = ft8Mode;
      if (modeChanged) {
        updateBandFreqs();
        if (ft8Running) ft8Send({ type: 'jtcat-set-mode', mode: ft8Mode });
        if (typeof applyDigitalPanes === 'function') applyDigitalPanes();
      }
      ft8HuntCall = callsign.toUpperCase();
      // Clear decode log for fresh start
      ft8DecodeLog = [];
      ft8DecodeLogEl.innerHTML = '<div class="ft8-empty">Hunting ' + esc(ft8HuntCall) + '...</div>';
      switchTab('ft8', { freqKhz: freqKhz });
    }
  });

  // --- Multi-select dropdown helpers ---
  //
  // The toolbar scrolls sideways on a phone, and these panels are
  // position:fixed, which mobile WebKit still clips to a scrolling ancestor.
  // The old answer was to flip the bar to overflow-x:visible while a panel
  // was open. That RESETS scrollLeft to 0 — the browser cannot keep a scroll
  // offset on a box that no longer scrolls — so on any bar too wide for the
  // screen the toolbar jumped back to the start under the operator's finger,
  // the button they had just tapped slid away (often off-screen, taking the
  // panel's computed position with it), and the bar stayed unscrollable until
  // something closed the panel: "push it does nothing and the whole bar line
  // stucks", phone only, desktop browser fine (LZ3AW 2026-09-19; the bar grew
  // past a phone's width when the callsign filter joined it in 1.10.18).
  // Now the open panel is MOVED to <body>, where no ancestor can clip it, and
  // the bar is never touched. Panels keep their listeners across the move.
  var _filterScroll = document.getElementById('filter-toolbar-scroll');
  function closeAllDropdowns() {
    document.querySelectorAll('.rc-dropdown.open').forEach(d => d.classList.remove('open'));
    document.querySelectorAll('.rc-open').forEach(p => p.classList.remove('rc-open'));
  }

  // Park the panel on <body> and place it under its button, kept inside the
  // viewport (a button near the right edge would otherwise open a panel half
  // off-screen on a phone).
  function openDropdownPanel(btn, panel) {
    if (panel.parentNode !== document.body) document.body.appendChild(panel);
    panel.classList.add('rc-open');
    const rect = btn.getBoundingClientRect();
    const margin = 8;
    const width = panel.offsetWidth || 180;
    let left = rect.left;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    panel.style.left = Math.max(margin, left) + 'px';
    panel.style.top = (rect.bottom + 4) + 'px';
    // Fit the screen below the button, so every item is reachable by
    // scrolling the panel itself (never the page).
    panel.style.maxHeight = Math.max(120, Math.min(300, window.innerHeight - rect.bottom - 4 - margin)) + 'px';
    // A fixed panel does not follow its button, so scrolling the bar (or the
    // page) closes it rather than leaving it pointing at nothing. Scrolling
    // INSIDE the panel is the one scroll that must not close it: the capture
    // listener below sees that too, and a menu taller than a phone screen
    // vanished the moment a finger moved on it (LZ3AW 2026-10-20).
    const close = (e) => {
      if (e && e.target && e.target !== window && e.target !== document && panel.contains(e.target)) return;
      closeAllDropdowns(); detach();
    };
    const detach = () => {
      if (_filterScroll) _filterScroll.removeEventListener('scroll', close);
      window.removeEventListener('scroll', close, true);
    };
    detach();
    if (_filterScroll) _filterScroll.addEventListener('scroll', close, { once: true });
    window.addEventListener('scroll', close, true);
  }

  function initMultiDropdown(container, onChange) {
    const btn = container.querySelector('.rc-dropdown-btn');
    const menu = ddPanel(container);
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
        openDropdownPanel(btn, menu);
      } else {
        menu.classList.remove('rc-open');
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
    const panel = ddPanel(container);
    const allCb = panel.querySelector('input[value="all"]');
    if (allCb && allCb.checked) return null;
    const checked = [...panel.querySelectorAll('input:not([value="all"]):checked')];
    if (checked.length === 0) return null;
    return new Set(checked.map(cb => cb.value));
  }

  // Initialize band and region dropdowns
  initMultiDropdown(bandFilterEl, () => { renderSpots(); if (activeTab === 'map') renderMapSpots(); sendFilters(); });
  initMultiDropdown(modeFilterEl, () => { renderSpots(); if (activeTab === 'map') renderMapSpots(); sendFilters(); });
  initMultiDropdown(regionFilterEl, () => { renderSpots(); if (activeTab === 'map') renderMapSpots(); sendFilters(); });

  // --- Spots dropdown ---
  // DX cluster node choice (LZ3AW item 1): the nodes saved in the desktop's
  // Settings, never a server this page names itself. Built with DOM nodes,
  // never innerHTML — node names are free text.
  function renderClusterNodeChoices(list) {
    const box = document.getElementById('rc-cluster-nodes');
    if (!box) return;
    box.textContent = '';
    if (!list.length) return;
    for (const n of list) {
      const label = document.createElement('label');
      label.className = 'rc-spots-toggle rc-cluster-node';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.clusterNode = n.id;
      cb.checked = !!n.enabled;
      const span = document.createElement('span');
      span.textContent = n.name || n.host || n.id;
      if (n.host && n.name && n.name !== n.host) span.title = n.host;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' '));
      label.appendChild(span);
      box.appendChild(label);
    }
  }

  spotsDropdown.querySelector('.rc-dropdown-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.rc-dropdown.open').forEach(d => { if (d !== spotsDropdown) d.classList.remove('open'); });
    spotsDropdown.classList.toggle('open');
    const spotsPanel = ddPanel(spotsDropdown);
    if (spotsDropdown.classList.contains('open')) {
      _dropdownJustOpened = true;
      openDropdownPanel(spotsDropdown.querySelector('.rc-dropdown-btn'), spotsPanel);
    } else {
      spotsPanel.classList.remove('rc-open');
    }
  });

  ddPanel(spotsDropdown).addEventListener('click', (e) => e.stopPropagation());
  ddPanel(spotsDropdown).addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.dataset.clusterNode) {
      // One of the cluster nodes saved in the desktop's Settings (LZ3AW
      // item 1). The desktop decides and echoes the true list back in
      // settings-update; a refusal (Guest Pass, 3-node cap) arrives as
      // cluster-node-result and the next echo puts the box back.
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set-cluster-node', id: cb.dataset.clusterNode, enabled: cb.checked }));
      }
      return;
    }
    if (cb.dataset.src) {
      // Desktop's set-sources handler keys on settings-flag names
      // (enable<Foo> minus the prefix), and the receive path on this side
      // already translates `cluster` → `dxc` so the DOM checkbox uses `dxc`.
      // The send path was missing the reverse — phone shipped {..., dxc:true}
      // and the desktop's map skipped the unknown key, so the DX Cluster
      // toggle was a no-op. AA6C report. Mirror the existing receive map.
      const SRC_DOM_TO_WIRE = { dxc: 'cluster' };
      const sources = {};
      ddPanel(spotsDropdown).querySelectorAll('[data-src]').forEach(c => {
        const wireKey = SRC_DOM_TO_WIRE[c.dataset.src] || c.dataset.src;
        sources[wireKey] = c.checked;
      });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set-sources', sources }));
      }
    } else if (cb.id === 'rc-dxe' || cb.dataset.dxeSrc) {
      // Same settings the desktop's Spots > DX Expeditions toggles write;
      // main merges a partial enableDxeSources (dxe-remote-test).
      if (cb.id === 'rc-dxe') dxeState.enable = cb.checked;
      else dxeState.sources[cb.dataset.dxeSrc] = cb.checked;
      reflectDxeToggles();
      renderSpots();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'save-settings', settings: { enableDxe: dxeState.enable, enableDxeSources: Object.assign({}, dxeState.sources) } }));
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
    } else if (cb.id === 'rc-dx-only') {
      dxOnly = cb.checked;
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
    const panel = ddPanel(container);
    const allCb = panel.querySelector('input[value="all"]');
    if (allCb && allCb.checked) return null;
    const checked = [...panel.querySelectorAll('input:not([value="all"]):checked')];
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
        dxOnly: dxOnly,
      }
    }));
  }
  function applyFilters(f) {
    if (!f) return;
    [bandFilterEl, modeFilterEl, regionFilterEl].forEach((el, i) => {
      const vals = [f.bands, f.modes, f.regions][i];
      const allCb = ddPanel(el).querySelector('input[value="all"]');
      const itemCbs = [...ddPanel(el).querySelectorAll('input:not([value="all"])')];
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
    if (f.dxOnly != null) {
      dxOnly = !!f.dxOnly;
      const cb = document.getElementById('rc-dx-only');
      if (cb) cb.checked = dxOnly;
    }
    // Per-band region mutes — desktop-owned (settings.spotMuteRules), merged
    // into this payload at send. Applied here, displayed under the region
    // filter so an active mute is never invisible. (N7BBQ 2026-08-03.)
    if (f.muteRules !== undefined) {
      spotMuteRules = Array.isArray(f.muteRules) ? f.muteRules.filter(function(r) {
        return r && r.continent && r.band;
      }) : [];
      renderMuteRuleNote();
    }
    renderSpots();
    if (activeTab === 'map') renderMapSpots();
  }

  var CONTINENT_NAMES = { AF:'Africa', AN:'Antarctica', AS:'Asia', EU:'Europe', NA:'North America', OC:'Oceania', SA:'South America' };
  var spotMuteRules = []; // mirrors the desktop lib/spot-mute-rules.js predicate
  function spotMatchesMuteRule(s) {
    if (!spotMuteRules.length || !s.continent || !s.band) return false;
    var cont = String(s.continent).toUpperCase();
    var band = String(s.band).toLowerCase();
    for (var i = 0; i < spotMuteRules.length; i++) {
      if (spotMuteRules[i].continent === cont && spotMuteRules[i].band === band) return true;
    }
    return false;
  }
  function renderMuteRuleNote() {
    var host = regionFilterEl && regionFilterEl.parentElement;
    if (!host) return;
    var note = document.getElementById('rc-mute-rules-note');
    if (!note) {
      note = document.createElement('div');
      note.id = 'rc-mute-rules-note';
      note.style.cssText = 'font-size:11px;color:var(--text-secondary,#888);padding:2px 4px;';
      host.appendChild(note);
    }
    if (!spotMuteRules.length) { note.textContent = ''; note.style.display = 'none'; return; }
    note.style.display = '';
    note.textContent = 'Muted: ' + spotMuteRules.map(function(r) {
      return (CONTINENT_NAMES[r.continent] || r.continent) + ' on ' + r.band;
    }).join(', ') + ' (edit on desktop)';
  }

  // --- Sort ---
  sortSelect.addEventListener('change', () => {
    spotSort = sortSelect.value;
    renderSpots();
    if (activeTab === 'map') renderMapSpots();
    sendFilters();
  });

  // --- Frequency direct input ---
  // Tapping the status-bar frequency opens the new Full VFO view (dial,
  // bands, op info, PTT). The old dial-pad keypad is still reachable via
  // the freq display INSIDE the VFO view for direct kHz entry.
  freqDisplay.addEventListener('click', () => {
    const vfo = document.getElementById('vfo-fullview');
    const vfoBtn = document.getElementById('vfo-fullview-btn');
    if (vfo && vfoBtn && vfo.classList.contains('hidden')) {
      vfoBtn.click();
    } else {
      openDialPad();
    }
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
    if (vfoLocked) {
      showToast('VFO Locked — Unlock VFO to change frequency', 2000);
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tune', freqKhz: freqKhz.toString(), mode: '' }));
    }
    // Immediately update local display
    const hz = Math.round(freqKhz * 1000);
    freqDisplay.textContent = formatFreq(hz);
    currentFreqKhz = freqKhz;
  }

  // Shared between WS handler and button click — updates the lock pill visual.
  function updateVfoLockUi() {
    const btn = document.getElementById('vf-lock-btn');
    if (!btn) return;
    if (vfoLocked) {
      btn.innerHTML = '&#x1F512;';
      btn.classList.add('locked');
      btn.title = 'VFO Locked — tap to unlock';
    } else {
      btn.innerHTML = '&#x1F513;';
      btn.classList.remove('locked');
      btn.title = 'Tap to lock VFO';
    }
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
  if (freqUpBtn) freqUpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const step = STEP_SIZES[dpStepIdx];
    const newFreq = Math.round((currentFreqKhz + step) * 100) / 100;
    dpTune(newFreq);
  });

  if (freqDownBtn) freqDownBtn.addEventListener('click', (e) => {
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
    if (kiwiGainNodeE) kiwiGainNodeE.gain.value = 0;
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
    if (kiwiGainNodeE) kiwiGainNodeE.gain.value = 1;
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
    // Android translates BT HFP buttons to KEYCODE_MEDIA_PLAY_PAUSE -> 'MediaPlayPause'
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

  // NOTE: previously we registered Media Session play/pause/stop handlers
  // unconditionally so wired earbuds could toggle PTT. That made every
  // EarPod / wired-headset play-pause press hijack PTT regardless of
  // whether the user wanted it (G7-Chris report). The explicit "BT PTT"
  // toggle in Settings is the opt-in path for headset-button PTT — it
  // registers the same handlers via btPttStart() and tears them down on
  // disable. The unconditional registration that lived here has been
  // removed; the silent session-keepalive (used as a Media Session anchor
  // by audio start) remains, since it doesn't itself bind any handlers.

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
      ws.send(JSON.stringify({ type: 'set-max-age', minutes: maxAgeMin }));
    }
  });
  soMaxageUp.addEventListener('click', () => {
    const idx = MAXAGE_PRESETS.indexOf(maxAgeMin);
    if (idx < MAXAGE_PRESETS.length - 1) maxAgeMin = MAXAGE_PRESETS[idx + 1];
    else if (idx === -1) maxAgeMin = MAXAGE_PRESETS[0];
    soMaxageVal.textContent = maxAgeMin + 'm';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-max-age', minutes: maxAgeMin }));
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

  // Text size S/M/L (localStorage) - drives the --ui-scale CSS variable.
  (function initTextSize() {
    const saved = parseFloat(localStorage.getItem('echocat-ui-scale')) || 1;
    const apply = (v) => {
      document.documentElement.style.setProperty('--ui-scale', v);
      document.querySelectorAll('.text-size-btn').forEach((b) => {
        b.classList.toggle('active', parseFloat(b.dataset.scale) === v);
      });
    };
    apply(saved);
    document.querySelectorAll('.text-size-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const v = parseFloat(b.dataset.scale) || 1;
        localStorage.setItem('echocat-ui-scale', String(v));
        apply(v);
      });
    });
  })();

  // Tap the solar pills for the band-conditions detail.
  (function initSolarTap() {
    // Both surfaces: the status bar row and its Full VFO View mirror.
    const targets = ['solar-pills', 'vf-solar-pills']
      .map((id) => document.getElementById(id)).filter(Boolean);
    if (!targets.length) return;
    targets.forEach((sp) => sp.addEventListener('click', () => {
      if (!lastSolarData) return;
      const d = lastSolarData;
      const lines = [];
      if (d.sunspots != null) lines.push('Sunspots ' + d.sunspots);
      if (d.xray) lines.push('X-ray ' + d.xray);
      if (d.solarWind) lines.push('Wind ' + d.solarWind);
      (d.bands || []).forEach((b) => lines.push(b.band + ' (' + b.time + '): ' + b.condition));
      if (lines.length && typeof showLogToast === 'function') showLogToast(lines.join('  |  '));
    }));
  })();

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

  // Fine width steps (LZ3AW item 7): absolute set-filter in 50 Hz steps for
  // CW/digital, 100 Hz for voice — the coarse arrows jump between presets,
  // which is useless when the QRM calls for "just 50 Hz narrower". Uses the
  // width the radio last reported, so steps track reality, not local state.
  function bwFineStep(dirSign) {
    if (!currentFilterWidth) return;
    const m = (currentMode || '').toUpperCase();
    const fine = (m === 'CW' || m === 'CW-R' || m.indexOf('FT') === 0 || m.indexOf('DIG') === 0 ||
      m.indexOf('PSK') === 0 || m === 'RTTY' || m.indexOf('PKT') === 0) ? 50 : 100;
    const width = Math.max(50, currentFilterWidth + dirSign * fine);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-filter', width }));
    }
  }
  const rcBwFineDn = document.getElementById('rc-bw-fine-dn');
  const rcBwFineUp = document.getElementById('rc-bw-fine-up');
  if (rcBwFineDn) rcBwFineDn.addEventListener('click', () => bwFineStep(-1));
  if (rcBwFineUp) rcBwFineUp.addEventListener('click', () => bwFineStep(1));
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
    const before = customCatData;
    customCatData = buttons;
    while (customCatData.length < 5) customCatData.push({ name: '', command: '' });
    // A lit toggle describes the last command sent from THAT slot. Forget it
    // only where the slot's commands changed — settings-update arrives on
    // every cluster connect and clock check, and resetting every toggle each
    // time made the next press send On again (LZ3AW #7).
    const sig = (e) => (e ? [e.type || 'button', e.command || '', e.commandOff || ''].join('\u0001') : '');
    const kept = {};
    for (const i of Object.keys(customToggleState)) {
      if (customToggleState[i] && sig(before[i]) === sig(customCatData[i])) kept[i] = true;
    }
    customToggleState = kept;
    // Slider slots: the value THIS device last sent wins over the desktop's
    // saved copy, which a browser never updates. Every settings-update used
    // to put the old value back, so the thumb and readout snapped back while
    // the radio had moved (LZ3AW round 6: "the value on the radio changes,
    // but on the slider doesn't").
    // Whichever moved LAST wins: a change on the desktop's own slider shows
    // up as a new saved value, and then that one is shown instead.
    for (let i = 0; i < customCatData.length; i++) {
      const e = customCatData[i];
      const incoming = e ? e.value : undefined;
      const deskMoved = customSliderDesk[i] !== undefined && incoming !== customSliderDesk[i];
      customSliderDesk[i] = incoming;
      if (!(i in customSliderSent)) continue;
      if (e && !deskMoved && sig(before[i]) === sig(e)) e.value = customSliderSent[i];
      else delete customSliderSent[i];
    }
    // Nothing a slot shows changed: do not rebuild. A rebuild also replaced
    // the slider under the operator's finger in the middle of a drag.
    const view = (arr) => JSON.stringify((arr || []).map(e => e ? [e.type || 'button', e.name || '', e.command || '', e.commandOff || '', e.min, e.max, e.value] : null));
    if (view(before) === view(customCatData) && document.getElementById('rc-custom-cat-btns') && document.getElementById('rc-custom-cat-btns').children.length) return;
    renderCustomCatButtons();
  }

  // Session-only last-sent state for custom TOGGLE slots, mirroring the
  // desktop's customToggleState: POTACAT cannot parse arbitrary rigs' replies
  // to user-typed raw commands, so the lit state means "the last thing this
  // button sent" and nothing more. Not persisted; reset when slots change.
  var customToggleState = {};
  // The radio's last reported state, merged across status pushes (a push may
  // leave fields out), for toggles that FOLLOW it (lib/custom-cat-follow.js).
  var customRadioState = {};
  function customToggleView(e, idx) {
    return window.CustomCatFollow
      ? CustomCatFollow.toggleView(e || {}, customRadioState, customToggleState[idx])
      : { on: !!customToggleState[idx], fromRadio: false, nextCommand: customToggleState[idx] ? 'off' : 'on' };
  }
  function paintCustomToggle(btn, e, idx) {
    var v = customToggleView(e, idx);
    btn.textContent = (e.name || ('CAT ' + (idx + 1))) + ' ' + (v.on ? 'On' : 'Off');
    btn.classList.toggle('rc-custom-cat-on', v.on);
    btn.title = v.fromRadio ? 'Shows what the radio reports.' : 'Shows the last command sent, not the radio state.';
  }
  // A status push relights every toggle that follows the radio, in place.
  function refreshCustomToggles() {
    var btns = document.querySelectorAll('.rc-custom-cat-btn[data-toggle="1"]');
    var changed = false;
    for (var n = 0; n < btns.length; n++) {
      var idx = parseInt(btns[n].dataset.idx, 10);
      if (!customCatData[idx]) continue;
      var before = btns[n].textContent;
      paintCustomToggle(btns[n], customCatData[idx], idx);
      if (btns[n].textContent !== before) changed = true;
    }
    // The VFO panel's row is a snapshot of these buttons.
    if (changed && window.__vfRenderCustomCat) window.__vfRenderCustomCat();
  }
  var customSliderTimers = {};
  var customSliderSent = {};   // slot -> value this device last sent (see loadCustomCatButtons)
  var customSliderDesk = {};   // slot -> the desktop's saved value as last received

  // Substitute the slider value into a command template — SAME contract as the
  // desktop's customSliderCommand(): {v} bare, {v2}/{v3}/{v4} zero-padded,
  // {bcd} an Icom CI-V level as two BCD bytes ("02 55"), and
  // a template with no placeholder gets the value appended.
  function customSliderCommand(template, value) {
    var v = String(Math.round(value));
    var out = template;
    var found = false;
    var bcd = ('0000' + v).slice(-4);
    var bcdOut = /\s/.test(template) ? bcd.slice(0, 2) + ' ' + bcd.slice(2) : bcd; // {bcd}: Icom level, 255 -> "02 55"
    while (out.indexOf('{bcd}') !== -1) { out = out.replace('{bcd}', bcdOut); found = true; }
    var widths = [4, 3, 2];
    for (var w = 0; w < widths.length; w++) {
      var ph = '{v' + widths[w] + '}';
      while (out.indexOf(ph) !== -1) {
        var padded = v;
        while (padded.length < widths[w]) padded = '0' + padded;
        out = out.replace(ph, padded);
        found = true;
      }
    }
    while (out.indexOf('{v}') !== -1) { out = out.replace('{v}', v); found = true; }
    return found ? out : out + v;
  }

  function sendCustomCat(cmd) {
    if (!cmd || !ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: 'rig-control', data: { action: 'send-custom-cat', command: cmd } }));
    return true;
  }

  function renderCustomCatButtons(opts) {
    customCatBtnsEl.innerHTML = '';
    var hasAny = false;
    for (var i = 0; i < customCatData.length; i++) {
      var entry = customCatData[i];
      if (!entry.name && !entry.command) continue;
      hasAny = true;
      // Slot TYPE, same vocabulary the desktop writes (renderer/app.js
      // createCustomSlot). The web client used to render EVERY slot as a plain
      // button that fired `command`, so a toggle only ever sent its On command
      // ("not working as toggle, at all" — LZ3AW 2026-08-28) and a slider sent
      // its raw template, placeholders and all, straight at the radio.
      var type = (entry.type === 'toggle' || entry.type === 'slider') ? entry.type : 'button';

      if (type === 'slider') {
        var wrap = document.createElement('span');
        wrap.className = 'rc-custom-cat-slider';
        var lbl = document.createElement('span');
        lbl.className = 'rc-ccs-label';
        lbl.textContent = entry.name || ('CAT ' + (i + 1));
        var lo = Number.isFinite(entry.min) ? entry.min : 0;
        var hi = Number.isFinite(entry.max) ? entry.max : 255;
        var range = document.createElement('input');
        range.type = 'range';
        range.className = 'rc-ccs-range';
        range.min = lo;
        range.max = hi;
        range.value = Number.isFinite(entry.value) ? entry.value : lo;
        var out = document.createElement('span');
        out.className = 'rc-ccs-value';
        out.textContent = range.value;
        range.dataset.idx = i;
        range.addEventListener('input', function() {
          var idx = parseInt(this.dataset.idx, 10);
          var self = this;
          this.parentElement.querySelector('.rc-ccs-value').textContent = this.value;
          // Same 150ms debounce as the desktop: a drag fires dozens of input
          // events and the rig's serial port should see one command per pause.
          clearTimeout(customSliderTimers[idx]);
          customSliderTimers[idx] = setTimeout(function() {
            var e = customCatData[idx];
            if (!e || !e.command) return;
            if (sendCustomCat(customSliderCommand(e.command, +self.value))) { e.value = +self.value; customSliderSent[idx] = +self.value; }
          }, 150);
        });
        wrap.appendChild(lbl);
        wrap.appendChild(range);
        wrap.appendChild(out);
        customCatBtnsEl.appendChild(wrap);
        continue;
      }

      var btn = document.createElement('button');
      btn.className = 'rc-custom-cat-btn';
      btn.dataset.idx = i;
      var label = entry.name || ('CAT ' + (i + 1));
      if (type === 'toggle') {
        btn.dataset.toggle = '1';
        paintCustomToggle(btn, entry, i);
        btn.addEventListener('click', function() {
          var idx = parseInt(this.dataset.idx, 10);
          var e = customCatData[idx];
          if (!e) return;
          // Following the radio: the command that moves it AWAY from what it reports.
          var goingOn = customToggleView(e, idx).nextCommand === 'on';
          var cmd = (goingOn ? e.command : e.commandOff) || '';
          if (!sendCustomCat(cmd.trim())) return;
          customToggleState[idx] = goingOn;
          paintCustomToggle(this, e, idx);
          // The VFO panel's copy of this row is a snapshot — refresh it.
          if (window.__vfRenderCustomCat) window.__vfRenderCustomCat();
        });
      } else {
        btn.textContent = label;
        btn.addEventListener('click', function() {
          var idx = parseInt(this.dataset.idx, 10);
          var cmd = customCatData[idx] && customCatData[idx].command;
          if (!sendCustomCat(cmd)) return;
          this.classList.add('sent');
          var b = this;
          setTimeout(function() { b.classList.remove('sent'); }, 300);
        });
      }
      customCatBtnsEl.appendChild(btn);
    }
    // Always show section — Edit button allows creating buttons from ECHOCAT
    // Re-render editor if open — except from the editor's own blur handler:
    // rebuilding the editor there destroyed the field the operator had just
    // clicked into, so the Off command of a toggle could never be typed from
    // a browser and every toggle saved with an empty Off (LZ3AW #7).
    if (customCatEditing && !(opts && opts.keepEditor)) renderCustomCatEditor();
    // Mirror to the optional VFO Custom CAT widget if it's enabled.
    if (window.__vfRenderCustomCat) window.__vfRenderCustomCat();
  }

  function saveCustomCatButtons() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'save-custom-cat-buttons', buttons: customCatData }));
    }
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
      // Slot TYPE. Rendering a toggle correctly is only half of parity: with
      // no type control here, a browser could only ever CREATE plain buttons,
      // so "the toggle doesn't work as a toggle, at all" survived the render
      // fix for anyone who configures from the web (LZ3AW, round 3).
      var entry = customCatData[i] || {};
      var slotType = (entry.type === 'toggle' || entry.type === 'slider') ? entry.type : 'button';
      var typeSel = document.createElement('select');
      typeSel.className = 'cce-type';
      typeSel.dataset.idx = i;
      var TYPES = [['button', 'Button'], ['toggle', 'Toggle'], ['slider', 'Slider']];
      for (var t = 0; t < TYPES.length; t++) {
        var o = document.createElement('option');
        o.value = TYPES[t][0];
        o.textContent = TYPES[t][1];
        typeSel.appendChild(o);
      }
      typeSel.value = slotType;
      typeSel.title = 'Button sends one command. Toggle alternates an On and an Off command. Slider sends a command with a value in it.';
      typeSel.addEventListener('change', function() {
        var idx = parseInt(this.dataset.idx, 10);
        if (!customCatData[idx]) customCatData[idx] = { name: '', command: '' };
        customCatData[idx].type = this.value;
        customToggleState = {};
        saveCustomCatButtons();
        renderCustomCatEditor();   // the extra fields appear/disappear with the type
        renderCustomCatButtons();
      });

      var cmdInput = document.createElement('input');
      cmdInput.className = 'cce-cmd';
      cmdInput.placeholder = slotType === 'toggle' ? 'On command'
        : slotType === 'slider' ? 'Command with {v}' : 'CAT command';
      if (slotType === 'slider') cmdInput.title = 'Use {v} for the value, {v3} to zero-pad to 3 digits (e.g. SQ0{v3}; ), {bcd} for an Icom level as two bytes (FE FE 94 E0 14 02 {bcd} FD sends 255 as 02 55). No placeholder = value appended.';
      else cmdInput.title = 'Text commands as your manual prints them (FA014074000; ). Icom CI-V as hex bytes (FE FE 80 E0 12 00 FD).';
      cmdInput.maxLength = 64;
      cmdInput.value = entry.command || '';
      row.appendChild(nameInput);
      row.appendChild(typeSel);
      row.appendChild(cmdInput);

      if (slotType === 'toggle') {
        var offInput = document.createElement('input');
        offInput.className = 'cce-cmd cce-off';
        offInput.placeholder = 'Off command';
        offInput.maxLength = 64;
        offInput.value = entry.commandOff || '';
        row.appendChild(offInput);
        // Follow a state the radio reports (same list as the desktop).
        var followSel = document.createElement('select');
        followSel.className = 'cce-type cce-follow';
        followSel.title = 'Follow the radio: the light shows what the radio reports, and a click sends whichever command moves it the other way.';
        var FOLLOWS = [['', 'Last sent']].concat(((window.CustomCatFollow && CustomCatFollow.FOLLOWABLE) || []).map(function (f) { return [f.key, 'Follows ' + f.label]; }));
        for (var fo = 0; fo < FOLLOWS.length; fo++) {
          var fopt = document.createElement('option');
          fopt.value = FOLLOWS[fo][0];
          fopt.textContent = FOLLOWS[fo][1];
          followSel.appendChild(fopt);
        }
        followSel.value = (window.CustomCatFollow && CustomCatFollow.isFollowable(entry.follows)) ? entry.follows : '';
        row.appendChild(followSel);
      } else if (slotType === 'slider') {
        var minInput = document.createElement('input');
        minInput.className = 'cce-num cce-min';
        minInput.type = 'number';
        minInput.placeholder = 'min';
        minInput.value = Number.isFinite(entry.min) ? entry.min : 0;
        var maxInput = document.createElement('input');
        maxInput.className = 'cce-num cce-max';
        maxInput.type = 'number';
        maxInput.placeholder = 'max';
        maxInput.value = Number.isFinite(entry.max) ? entry.max : 255;
        row.appendChild(minInput);
        row.appendChild(maxInput);
      }
      editor.appendChild(row);
    }
    customCatSection.appendChild(editor);
    // Auto-save on blur — but a move between the editor's own fields is not
    // a blur worth saving on, and never rebuilds the editor mid-edit.
    editor.addEventListener('focusout', function(ev) {
      if (ev && ev.relatedTarget && editor.contains(ev.relatedTarget)) return;
      for (var j = 0; j < 5; j++) {
        var r = editor.querySelectorAll('.rc-custom-cat-editor-row')[j];
        if (!r) continue;
        // PRESERVE the slot fields this editor does not expose. Rebuilding
        // the object from the two inputs silently downgraded a
        // desktop-configured toggle/slider to a plain button — type,
        // commandOff, min/max and value were dropped and then SAVED BACK to
        // the desktop, destroying the operator's configuration just for
        // opening Edit in the browser (LZ3AW 2026-08-28).
        var prev = customCatData[j] || {};
        var next = {};
        for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
        next.name = r.querySelector('.cce-name').value.trim();
        next.command = r.querySelector('.cce-cmd').value.trim();
        var offEl = r.querySelector('.cce-off');
        if (offEl) next.commandOff = offEl.value.trim();
        var followEl = r.querySelector('.cce-follow');
        if (followEl) { if (followEl.value) next.follows = followEl.value; else delete next.follows; }
        var minEl = r.querySelector('.cce-min');
        var maxEl = r.querySelector('.cce-max');
        if (minEl) next.min = Number(minEl.value) || 0;
        if (maxEl) next.max = Number(maxEl.value) || 0;
        customCatData[j] = next;
      }
      renderCustomCatButtons({ keepEditor: true });
      saveCustomCatButtons();
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

  // Split — rides the generic rig-control demux; state settles from the
  // readback-fed status echo rather than latching the tap (LZ3AW 2026-08-03).
  const rcSplit = document.getElementById('rc-split');
  if (rcSplit) {
    rcSplit.addEventListener('click', () => {
      if (txState) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Canonical rig-control shape nests under `data` (the demux reads
        // msg.data.action — a top-level action was silently dropped until
        // the 2026-08-03 hardening).
        ws.send(JSON.stringify({ type: 'rig-control', data: { action: 'set-split', value: !rcSplit.classList.contains('active') } }));
      }
    });
  }

  // RF Gain slider
  // The radio's own MIC GAIN over CAT (K6RBJ: "a Mic Gain slider ... I could
  // dump my custom commands"). Two copies — Settings and the Full VFO pane —
  // kept in step; sent through the one rig-control dispatcher, like the app.
  const MIC_GAIN_IDS = [['rc-micgain-slider', 'rc-micgain-val'], ['vf-micgain-slider', 'vf-micgain-val']];
  function micGainPairs() {
    return MIC_GAIN_IDS.map(([s, v]) => [document.getElementById(s), document.getElementById(v)]).filter(([s]) => s);
  }
  function applyMicGainState(val) {
    for (const [sl, lbl] of micGainPairs()) {
      if (document.activeElement === sl) continue; // don't fight a drag
      sl.value = val;
      if (lbl) lbl.textContent = val;
    }
  }
  function setMicGainVisible(on) {
    ['so-micgain-row', 'vf-micgain-row'].forEach((id) => {
      const row = document.getElementById(id);
      if (row) row.classList.toggle('hidden', !on);
    });
  }
  for (const [sl, lbl] of micGainPairs()) {
    sl.addEventListener('input', () => {
      for (const [o, ol] of micGainPairs()) { o.value = sl.value; if (ol) ol.textContent = sl.value; }
    });
    sl.addEventListener('change', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'rig-control', data: { action: 'set-mic-gain', value: parseInt(sl.value, 10) } }));
      }
    });
  }

  rcRfGainSlider.addEventListener('input', () => {
    rcRfGainVal.textContent = rcRfGainSlider.value;
  });
  rcRfGainSlider.addEventListener('change', () => {
    if (txState) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set-rfgain', value: parseInt(rcRfGainSlider.value) }));
    }
  });

  // FM squelch slider — rides the generic rig-control path (no dedicated
  // message), so the desktop's one applyRigControl dispatcher handles it.
  if (rcSquelchSlider) {
    rcSquelchSlider.addEventListener('input', () => {
      rcSquelchVal.textContent = rcSquelchSlider.value;
    });
    rcSquelchSlider.addEventListener('change', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'rig-control', data: { action: 'set-squelch', value: parseInt(rcSquelchSlider.value, 10) } }));
      }
    });
  }

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
  var echoAlcBar = document.getElementById('echo-alc-bar');
  var echoAlcText = document.getElementById('echo-alc-text');
  var echoPwrBar = document.getElementById('echo-pwr-bar');
  var echoPwrText = document.getElementById('echo-pwr-text');
  var echoTxBar = document.getElementById('echo-tx-bar');
  var echoTxText = document.getElementById('echo-tx-text');
  var soTxBar = document.getElementById('so-tx-bar');
  var soTxText = document.getElementById('so-tx-text');
  // PC-side TX peak pushed from the desktop's remote-audio bridge (ECHOCAT
  // phone audio reaching the radio's USB CODEC). Peaks arrive every ~30ms;
  // local peak-hold + decay drives the bar so brief peaks stay readable and
  // the bar fades to "—" when transmission stops.
  var _txPeakHold = 0;
  var _txPeakHoldUntil = 0;
  var _txLastPeak = 0;
  var _txLastPeakAt = 0;
  var _txDecayRaf = null;
  function _drawTxBars(pct, color) {
    var bg = pct < 0.005 ? '#333' : color;
    if (echoTxBar) drawEchoBar(echoTxBar, pct, bg);
    if (soTxBar) drawEchoBar(soTxBar, pct, bg);
    var txt = pct < 0.005 ? '—' : Math.round(pct * 100) + '%';
    if (echoTxText) { echoTxText.textContent = txt; echoTxText.style.color = color; }
    if (soTxText) { soTxText.textContent = txt; soTxText.style.color = color; }
  }
  function _txDecayTick() {
    var now = Date.now();
    var raw = (now - _txLastPeakAt < 200) ? _txLastPeak : 0;
    if (raw >= _txPeakHold) { _txPeakHold = raw; _txPeakHoldUntil = now + 800; }
    else if (now > _txPeakHoldUntil) { _txPeakHold *= 0.92; }
    var pct = Math.min(1, _txPeakHold);
    var color = pct < 0.005 ? '#666' : pct < 0.5 ? '#4ecca3' : pct < 0.85 ? '#ffd740' : '#e94560';
    _drawTxBars(pct, color);
    if (raw > 0.005 || _txPeakHold > 0.005) {
      _txDecayRaf = requestAnimationFrame(_txDecayTick);
    } else {
      _txDecayRaf = null;
    }
  }
  // The TX audio meter shows the mic audio POTACAT feeds the radio's USB
  // CODEC, so on a CW or voice-over-mic station it never moves: it stays
  // hidden until it actually carries audio (LZ3AW: "it shows nothing").
  var echoTxGroup = document.getElementById('echo-tx-group');
  function updateEchoTxMeter(peak) {
    _txLastPeak = Math.max(0, Math.min(1, +peak || 0));
    if (_txLastPeak > 0.01 && echoTxGroup && echoTxGroup.classList.contains('hidden')) echoTxGroup.classList.remove('hidden');
    _txLastPeakAt = Date.now();
    if (!_txDecayRaf) _txDecayRaf = requestAnimationFrame(_txDecayTick);
  }
  // Track the highest watt value seen this session so the bar auto-scales for
  // QRP (5W), 100W, and amp (1500W) users without needing per-rig config.
  var echoPwrMaxSeen = 100;
  let echoFwdLiveAt = 0; // last measured fwd-power frame (wins over the setting)
  var echoShowMeter = document.getElementById('echo-show-meter');
  var echoMeterEnabled = localStorage.getItem('echoMeterEnabled') === 'true';

  echoShowMeter.checked = echoMeterEnabled;
  if (echoMeterEnabled) echoMeterStrip.classList.remove('hidden');

  echoShowMeter.addEventListener('change', function() {
    echoMeterEnabled = echoShowMeter.checked;
    localStorage.setItem('echoMeterEnabled', echoMeterEnabled);
    echoMeterStrip.classList.toggle('hidden', !echoMeterEnabled);
  });

  // Beam heading toggle on the VFO operator card. Hidden by default; users
  // who want to swing a beam to a station can flip it on (KM4CFT request).
  var echoShowBearing = document.getElementById('echo-show-bearing');
  if (echoShowBearing) {
    echoShowBearing.checked = showVfoBearing;
    echoShowBearing.addEventListener('change', function() {
      showVfoBearing = echoShowBearing.checked;
      localStorage.setItem('echocat-show-vfo-bearing', showVfoBearing);
      // Re-render the op-card so bearing shows/hides immediately. The full-
      // view's renderAll is the only path that reads showVfoBearing, and
      // it's safe to call when fullview is closed (no-ops gracefully).
      if (typeof window.__vfRenderAll === 'function') window.__vfRenderAll();
    });
  }

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
  var colLabels = { freq: 'Freq', mode: 'Mode', band: 'Band', dist: 'Dist', ref: 'Ref/Park', name: 'Name', region: 'Region', src: 'Source', age: 'Age', spotter: 'Spotter', cqz: 'CQ zone', ituz: 'ITU zone', skip: 'Skip', log: 'Log' };
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
    // VFO panel pill mirror (no-op when widget hidden / not initialised)
    if (window.__vfSetMeter) window.__vfSetMeter(val);
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
    if (val > 0 && window.__vfSetSwr) window.__vfSetSwr(1.0 + val / 60);
    if (!echoMeterEnabled || val <= 0) return;
    var swr = 1.0 + (val / 60);
    var level = Math.min(1, (swr - 1) / 4);
    var color = swr <= 1.5 ? '#4ecca3' : swr <= 2.0 ? '#ffd740' : swr <= 3.0 ? '#f0a500' : '#e94560';
    drawEchoBar(echoSwrBar, level, color);
    echoSwrText.textContent = swr < 10 ? swr.toFixed(1) : '>10';
    echoSwrText.style.color = color;
  }

  function updateEchoSwrRatio(swr) {
    if (window.__vfSetSwr) window.__vfSetSwr(swr);
    if (!echoMeterEnabled) return;
    var level = Math.min(1, (swr - 1) / 4);
    var color = swr <= 1.5 ? '#4ecca3' : swr <= 2.0 ? '#ffd740' : swr <= 3.0 ? '#f0a500' : '#e94560';
    drawEchoBar(echoSwrBar, level, color);
    echoSwrText.textContent = swr < 10 ? swr.toFixed(1) : '>10';
    echoSwrText.style.color = color;
  }

  function updateEchoAlc(val) {
    if (!echoMeterEnabled) return;
    var pct = Math.min(1, val / 255);
    var color = pct <= 0 ? '#666' : pct < 0.4 ? '#4ecca3' : pct < 0.7 ? '#ffd740' : pct < 0.9 ? '#f0a500' : '#e94560';
    drawEchoBar(echoAlcBar, pct, pct <= 0 ? '#333' : color);
    // A reading of ZERO is a reading. Rendering it as an em dash made it
    // identical to "this rig reports no ALC at all", so a K3 running with
    // drive set correctly — no ALC action, which is how Elecraft tell you to
    // run it — looked like a broken meter (jbkerkhoff 2026-09-03, whose SWR
    // worked on the same rig in the same session). The dash now means only
    // "nothing has arrived yet": it is the markup's initial text, and the
    // first callback replaces it, zero or not.
    echoAlcText.textContent = Math.round(pct * 100) + '%';
    echoAlcText.style.color = color;
  }

  function updateEchoPower(watts) {
    if (window.__vfSetPwr) window.__vfSetPwr(watts);
    if (!echoMeterEnabled) return;
    var w = Math.max(0, +watts || 0);
    if (w > echoPwrMaxSeen) echoPwrMaxSeen = w;
    var level = Math.min(1, w / echoPwrMaxSeen);
    // Color hot when within 90% of the highest TX seen this session — gives
    // useful visual feedback regardless of QRP / 100W / amp setup.
    var color = w === 0 ? '#4ecca3'
              : level < 0.5 ? '#4ecca3'
              : level < 0.9 ? '#ffd740'
              : '#e94560';
    drawEchoBar(echoPwrBar, level, color);
    echoPwrText.textContent = w >= 100 ? Math.round(w) + 'W' : w.toFixed(1) + 'W';
    echoPwrText.style.color = color;
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
    // Re-pick element vs Web-Audio output for the new gain (and keep
    // volBoostLevel roughly in sync so the boost button stays meaningful).
    volBoostLevel = pct > 100 ? 1 : 0;
    applyRxOutput();
  });
  rcTxGain.addEventListener('input', function() {
    var pct = parseInt(rcTxGain.value, 10);
    rcTxGainVal.textContent = pct + '%';
    if (txGainNode) txGainNode.gain.value = pct / 100;
  });

  // Shack-side TX drive — what POTACAT feeds the RADIO (vs rcTxGain above,
  // which scales this browser's own mic and never leaves the page). Sends on
  // release, not per-input, so a drag doesn't spray the wire; the desktop
  // echoes tx-drive-state back and every client stays in sync. The row is
  // revealed by that echo, so it stays hidden against older desktops.
  var rcTxDrive = document.getElementById('rc-tx-drive');
  var rcTxDriveVal = document.getElementById('rc-tx-drive-val');
  if (rcTxDrive) {
    rcTxDrive.addEventListener('input', function() {
      if (rcTxDriveVal) rcTxDriveVal.textContent = parseInt(rcTxDrive.value, 10) + '%';
    });
    rcTxDrive.addEventListener('change', function() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set-tx-drive', value: parseInt(rcTxDrive.value, 10) }));
      }
    });
  }

  // Shack-side receive level — the receive twin of the TX drive slider above:
  // dB on the radio's audio before it reaches this device. Same send-on-release
  // and echo rules; the row is revealed by rx-level-state.
  var rcRxLevel = document.getElementById('rc-rx-level');
  var rcRxLevelVal = document.getElementById('rc-rx-level-val');
  if (rcRxLevel) {
    rcRxLevel.addEventListener('input', function() {
      var d = parseInt(rcRxLevel.value, 10) || 0;
      if (rcRxLevelVal) rcRxLevelVal.textContent = (d > 0 ? '+' : '') + d + ' dB';
    });
    rcRxLevel.addEventListener('change', function() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set-rx-level', value: parseInt(rcRxLevel.value, 10) || 0 }));
      }
    });
  }

  // RX clipping telemetry — when samples hit ±full-scale the ADC is pinning
  // and POTACAT's sliders can't rescue the signal. Throttled to one toast per
  // 5 minutes so it stays informative rather than nagging.
  let _rxClipUntil = 0;      // timestamp: show the on-meter CLIP pip until then
  let _lastRxClipToast = 0;

  function drawMeter(canvas, analyser) {
    if (!canvas || !analyser) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    // Calculate RMS level + peak sample (peak catches transient clipping that
    // RMS smears away)
    var sum = 0;
    var peak = 0;
    for (var i = 0; i < data.length; i++) {
      var v = (data[i] - 128) / 128;
      sum += v * v;
      var a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    var rms = Math.sqrt(sum / data.length);
    var db = rms > 0 ? 20 * Math.log10(rms) : -60;
    var level = Math.max(0, Math.min(1, (db + 40) / 40)); // -40dB to 0dB -> 0-1
    var clipping = canvas === rxMeterCanvas && peak >= 0.985;
    if (clipping) {
      _rxClipUntil = Date.now() + 600; // keep the indicator up for 600 ms
      maybeShowClipToast();
    }
    // Draw bar
    ctx.clearRect(0, 0, w, h);
    var barW = Math.round(level * w);
    if (level < 0.6) ctx.fillStyle = '#4ecca3';
    else if (level < 0.85) ctx.fillStyle = '#ffd740';
    else ctx.fillStyle = '#e94560';
    ctx.fillRect(0, 0, barW, h);
    // Peak line
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(barW - 1, 0, 1, h);
    // Clipping pip — a bright red "CLIP" block at the far right of the RX
    // meter when recent peaks hit full-scale
    if (canvas === rxMeterCanvas && Date.now() < _rxClipUntil) {
      ctx.fillStyle = '#ff1744';
      ctx.fillRect(w - 3, 0, 3, h);
    }
  }

  function maybeShowClipToast() {
    var now = Date.now();
    if (now - _lastRxClipToast < 5 * 60 * 1000) return;
    _lastRxClipToast = now;
    if (typeof showToast === 'function') {
      showToast('RX audio is clipping — lower your rig\u2019s USB AF Output (Icom: Menu \u2192 Set \u2192 Connectors \u2192 USB AF Output Level) or your OS Recording level. POTACAT\u2019s RX slider cannot undo ADC clipping.', 7000, true);
    }
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
    // Watchdog: if the first tap only managed to grant mic permission but the
    // audio channel didn't finish opening (common on iOS Safari / some
    // Chromium builds where the post-getUserMedia continuation loses its
    // "user gesture" status, so AudioContext / media play() won't start),
    // relabel the button so the user knows exactly what to do next instead
    // of staring at "Connecting..." forever.
    const watchdog = setTimeout(() => {
      if (!audioEnabled && !audioConnectBtn.classList.contains('hidden')) {
        audioConnectBtn.textContent = micReady ? 'Tap once more to finish' : 'Tap to retry';
      }
    }, 2000);
    try {
      await startAudio();
      // First startAudio() gets mic permission; second connects WebRTC
      if (micReady && !audioEnabled) {
        await startAudio();
      }
    } finally {
      clearTimeout(watchdog);
      if (!audioEnabled && !audioConnectBtn.classList.contains('hidden')) {
        audioConnectBtn.textContent = micReady ? 'Tap once more to finish' : 'Tap to Connect Audio';
      }
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

  // Decide which path actually drives the speakers, based on the current
  // RX gain (gainNode, 0–3x). At <=100% the <video> element plays directly
  // (element.volume caps at 1.0) — the robust path that survives a suspended
  // AudioContext and Chromium's remote-MediaStream-through-Web-Audio silence.
  // Above 100% we need real amplification, so we route the gain node to the
  // Web Audio destination and mute the element to avoid double audio. Either
  // way the analyser keeps tapping the gain node for the RX meter.
  function applyRxOutput() {
    if (!remoteAudio) return;
    var g = gainNode ? gainNode.gain.value : 1;
    var boosting = g > 1.0001;
    if (audioCtx && rxAnalyser) {
      if (boosting && !rxDestConnected) {
        try { rxAnalyser.connect(audioCtx.destination); rxDestConnected = true; } catch (e) {}
      } else if (!boosting && rxDestConnected) {
        try { rxAnalyser.disconnect(audioCtx.destination); } catch (e) {}
        rxDestConnected = false;
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    remoteAudio.muted = boosting;
    // When boosting, the element is muted and Web Audio carries the audio;
    // otherwise the element plays at the requested attenuation (0–100%).
    remoteAudio.volume = boosting ? 0 : Math.max(0, Math.min(1, g));
    remoteAudio.play().catch(() => {});
  }

  let micReady = false;
  var _useStun = false;
  var _turnIceServers = null; // Cloudflare TURN relay creds from stun-config (Model A)

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
          // Chrome can hand back a SUSPENDED context even when created inside
          // a gesture if the gesture went stale across the await getUserMedia
          // above — a suspended context means the Web Audio destination is
          // silent, which is exactly "connected peer, frames flowing, no
          // sound" (K3SBP 2026-06-14, LAN web client). Resume eagerly.
          if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
          // RX chain: source -> gainNode -> rxAnalyser (-> destination only
          // when boosting >100%; see applyRxOutput). At <=100% we let the
          // media element play the audio directly, which is immune to a
          // suspended AudioContext AND to the long-standing Chromium bug
          // where a remote WebRTC MediaStream routed through Web Audio is
          // silent. The analyser still taps the gain node for the RX meter
          // regardless of whether its output is connected.
          gainNode = audioCtx.createGain();
          gainNode.gain.value = VOL_STEPS[volBoostLevel];
          rxAnalyser = audioCtx.createAnalyser();
          rxAnalyser.fftSize = 256;
          gainNode.connect(rxAnalyser);
          rxDestConnected = false;
          // TX chain: mic -> txGainNode -> txAnalyser (metering only, audio sent via WebRTC track)
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
      // Prefer the Cloudflare TURN relay creds (so a CGNAT path gets a relay
      // candidate); else plain STUN; else local/VPN-only. ICE still picks a
      // direct pair when one exists, so TURN never needlessly relays on LAN.
      var iceServers = (_turnIceServers && _turnIceServers.length)
        ? _turnIceServers
        : (_useStun ? [{ urls: 'stun:stun.l.google.com:19302' }] : []);
      pc = new RTCPeerConnection({ iceServers: iceServers });
      for (const track of localAudioStream.getTracks()) {
        pc.addTrack(track, localAudioStream);
      }
      pc.ontrack = (event) => {
        setAudioStatus('Live');
        // The media element is the reliable audible output (immune to a
        // suspended AudioContext / the Chromium remote-stream-through-Web-
        // Audio silence bug). The Web Audio graph taps the same stream for
        // the RX meter and supplies the >100% boost. applyRxOutput() picks
        // which one actually reaches the speakers based on the gain.
        remoteAudio.srcObject = event.streams[0];
        if (audioCtx && gainNode) {
          try {
            if (rxSource) { try { rxSource.disconnect(); } catch (e) {} }
            rxSource = audioCtx.createMediaStreamSource(event.streams[0]);
            rxSource.connect(gainNode);
          } catch (e) {
            console.warn('RX Web Audio tap failed, element-only playback:', e.message);
          }
        }
        applyRxOutput();
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

  // A session that ends for good (kicked, revoked, signed out) ends its audio
  // with it: the WebRTC call is peer to peer and outlives the WebSocket.
  function endAudioWithSession() {
    try { if (audioEnabled || pc || localAudioStream) stopAudio(); } catch (e) { /* page tearing down */ }
  }

  function stopAudio() {
    if (ssbPlayingIdx >= 0) stopSsbPlayback();
    if (typeof smCleanupAudio === 'function') smCleanupAudio();
    if (pc) { pc.close(); pc = null; }
    if (localAudioStream) { localAudioStream.getTracks().forEach(t => t.stop()); localAudioStream = null; }
    if (remoteAudio) { remoteAudio.srcObject = null; }
    stopMeterRendering();
    if (rxSource) { try { rxSource.disconnect(); } catch (e) {} rxSource = null; }
    rxDestConnected = false;
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

  // --- Volume Boost (cycles 1x -> 2x -> 3x) ---
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
    // Switch the audible path (element ↔ Web Audio) for the new gain.
    applyRxOutput();
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
      if (scanSkipped.has(spotSkipKey(s))) return false;
      var workedToday = isWorkedSpot(s);
      if (workedToday && !scanForceUnskipped.has(spotSkipKey(s))) return false;
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

  // --- ECHOCAT Web session (POTACAT Cloud) ---
  // This page can be served because the browser carried a valid __Host-
  // cookie (owner device minted by /api/pair-account {web:true}, or a Guest
  // Pass from /api/pass-gate). When the server later refuses that
  // credential — revoked in Settings > ECHOCAT > My devices, pass ended,
  // or the cookie the WS saw disagrees with the one the page was served
  // on — the only honest recovery is to drop the cookie SERVER-SIDE and
  // land on the connect page with a notice. The sign-out POST is what
  // breaks a reload loop (a page served on a cookie the WS keeps refusing
  // would otherwise reload forever); sessionStorage is the backstop for
  // the case where even that POST fails.
  const WEB_RELOAD_KEY = 'echocat-web-reload';
  function webSignOutAndReload(notice) {
    var now = Date.now();
    try {
      var last = parseInt(sessionStorage.getItem(WEB_RELOAD_KEY) || '0', 10);
      if (last && now - last < 10000) { showWebSessionEnded(notice); return; }
      sessionStorage.setItem(WEB_RELOAD_KEY, String(now));
    } catch {}
    webSignOut(notice);
  }
  function webSignOut(notice) {
    wasKicked = true; // stop the reconnect loop
    endAudioWithSession();
    releaseWakeLock();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { if (ws) ws.close(); } catch {}
    var go = function() { location.replace('/?notice=' + encodeURIComponent(notice || 'signed-out')); };
    try {
      // Same-origin POST: the browser attaches Origin, which the server
      // requires on this endpoint. No body needed.
      fetch('/api/web-signout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
        .catch(function() {})
        .then(go, go);
    } catch { go(); }
  }
  var WEB_SESSION_ENDED_COPY = {
    'pass-ended': 'Your Guest Pass session has ended.',
    'revoked': 'This browser\'s access was revoked by the station owner.',
    'signed-out': 'You were signed out of this station.',
    'link-expired': 'Your sign-in for this station ended.'
  };
  function showWebSessionEnded(notice) {
    wasKicked = true;
    endAudioWithSession();
    releaseWakeLock();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    mainUI.classList.add('hidden');
    connectScreen.classList.remove('hidden');
    tokenLoginDiv.classList.add('hidden');
    clubLoginDiv.classList.add('hidden');
    connectBtn.classList.add('hidden');
    connectError.textContent = (WEB_SESSION_ENDED_COPY[notice] || WEB_SESSION_ENDED_COPY['link-expired']) + ' Reload this page to sign in again.';
    connectError.classList.remove('hidden');
  }
  // Guest Pass banner under the status bar: who issued it and what it
  // allows, so a guest is never surprised by a refused mode or power.
  function renderPassBanner(ps) {
    // A Guest Pass session must never see the owner's billing (Cloud section
    // + top banner read this flag).
    window.__echoGuestPass = !!(ps && ps.code);
    var el = document.getElementById('pass-banner');
    if (!el) return;
    if (!ps || !ps.code) { el.classList.add('hidden'); el.textContent = ''; return; }
    var head = 'Guest Pass' + (ps.ownerCallsign ? ' from ' + ps.ownerCallsign : '');
    var limits = [];
    if (ps.privilegeClass) limits.push(String(ps.privilegeClass).toUpperCase() + ' privileges');
    if (ps.maxPowerW) limits.push('max ' + ps.maxPowerW + ' W');
    if (Array.isArray(ps.allowedModes) && ps.allowedModes.length) limits.push(ps.allowedModes.join('/'));
    if (ps.expiresAt) {
      var d = new Date(ps.expiresAt);
      if (!isNaN(d.getTime())) limits.push('until ' + d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    }
    el.textContent = head + (limits.length ? ' \u2014 ' + limits.join(', ') : '');
    el.classList.remove('hidden');
  }
  // Settings > "This browser": what this browser is signed in as, and Sign out.
  function renderWebSessionRow(ps) {
    var row = document.getElementById('so-web-session');
    var text = document.getElementById('so-web-session-text');
    if (!row || !text) return;
    if (!webCookieMode()) { row.classList.add('hidden'); return; }
    text.textContent = ps && ps.code
      ? 'Guest Pass' + (ps.ownerCallsign ? ' from ' + ps.ownerCallsign : '')
      : 'Signed in with POTACAT Cloud';
    row.classList.remove('hidden');
  }
  (function() {
    var btn = document.getElementById('so-web-signout-btn');
    if (btn) btn.addEventListener('click', function() { webSignOut('signed-out'); });
  })();

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
    if (m === 'CW' || m === 'FT8' || m === 'FT4' || m === 'FT2' || m === 'JS8' || m === 'RTTY' || m === 'PSK31' || m === 'PSK' || m === 'JTTY') return '599';
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
    // Pre-fill comment — prefer the user's last-customized value if any,
    // otherwise fall back to the configured template. Placeholder substitution
    // applies to BOTH so {rst}/{QTH}/{mycallsign} stay dynamic regardless.
    const isDxc = targets.includes('dxc');
    const tmpl = isDxc ? dxRespotTemplate : respotTemplate;
    const saved = respotPersist.get(isDxc);
    const base = saved != null ? saved : tmpl;
    const rstVal = logRstSent.value || '59';
    logRespotComment.value = base
      .replace(/\{rst\}/gi, rstVal)
      .replace(/\{QTH\}/gi, phoneGrid || '')
      .replace(/\{mycallsign\}/gi, myCallsign || '');
    // Store targets for submit + persist
    logRespotSection.dataset.targets = targets.join(',');
    logRespotComment.dataset.dxc = isDxc ? '1' : '';
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
    const isDxc = targets.includes('dxc');
    const tmpl = isDxc ? dxRespotTemplate : respotTemplate;
    const saved = respotPersist.get(isDxc);
    const base = saved != null ? saved : tmpl;
    const rstVal = ltRstSent.value || '59';
    ltRespotComment.value = base
      .replace(/\{rst\}/gi, rstVal)
      .replace(/\{QTH\}/gi, phoneGrid || '')
      .replace(/\{mycallsign\}/gi, myCallsign || '');
    ltRespotSection.dataset.targets = targets.join(',');
    ltRespotComment.dataset.dxc = isDxc ? '1' : '';
  }

  // Log tab type picker
  document.getElementById('lt-type-picker').addEventListener('click', (e) => {
    const chip = e.target.closest('.lt-type-chip');
    if (!chip) return;
    selectLtType(chip.dataset.type);
  });

  // Log tab ref input -> update respot
  ltRefInput.addEventListener('input', updateLtRespot);

  // Log tab mode change -> update RST defaults + respot
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
      const typeToSig = { pota: 'POTA', sota: 'SOTA', wwff: 'WWFF', llota: 'LLOTA', wwbota: 'WWBOTA' };
      const sig = typeToSig[ltSelectedType] || '';
      const rawRef = ltRefInput.value.trim().toUpperCase();
      const refs = rawRef.split(',').map(function (r) { return r.trim(); }).filter(Boolean);
      const typedRef = refs[0] || '';
      // Every ref (a two-fer is a comma list); the desktop writes one record each.
      const sigInfo = (ltSelectedType && ltSelectedType !== 'dx' && typedRef) ? refs.join(',') : '';

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
      // A past QSO: both UTC fields filled. Blank = now, stamped by the
      // desktop exactly as before (same qsoAt contract as the hunter sheet).
      const ltDate = document.getElementById('lt-date');
      const ltTime = document.getElementById('lt-time');
      if (ltDate && ltTime && ltDate.value && ltTime.value) {
        const ms = Date.parse(ltDate.value + 'T' + ltTime.value + ':00Z');
        if (Number.isFinite(ms)) baseData.qsoAt = ms;
      }

      // Respot flags
      const respotCb = document.getElementById('lt-respot-cb');
      if (respotCb && respotCb.checked) {
        const targets = (ltRespotSection.dataset.targets || '').split(',').filter(Boolean);
        const comment = ltRespotComment.value.trim();
        if (targets.includes('pota')) { baseData.respot = true; }
        if (targets.includes('wwff')) { baseData.wwffRespot = true; baseData.wwffReference = typedRef; }
        if (targets.includes('llota')) { baseData.llotaRespot = true; baseData.llotaReference = typedRef; }
        if (targets.includes('dxc')) { baseData.dxcRespot = true; }
        if (comment) baseData.respotComment = comment;
      }

      // Include activator fields when activation is running
      if (activationSig && activationRef) {
        baseData.mySig = activationSig;
        baseData.mySigInfo = activationRef;
      }
      if (phoneGrid) baseData.myGridsquare = phoneGrid;

      if (logAsCall) baseData.logAs = logAsValue(); // another operator (or all of them) on the desktop

      // ONE contact, every callsign and ref in it: the desktop's logContact
      // writes one record per call × park and re-spots once. One message per
      // callsign used to re-spot the activator once per operator.
      ws.send(JSON.stringify({ type: 'log-qso', data: Object.assign({}, baseData, { callsign: calls.join(',') }) }));
    }
  }

  // Date/time on the Log tab: stamped with now (UTC) and kept current until
  // the operator edits either field, then left alone (LZ3AW 2026-10-16:
  // "show the current time and date with option to change it"). The log
  // sheet has done this since round 12; this is the same contract.
  const ltDateEl = document.getElementById('lt-date');
  const ltTimeEl = document.getElementById('lt-time');
  let ltTimeDirty = false;
  function ltStampNow() {
    const d = new Date();
    if (ltDateEl) ltDateEl.value = d.toISOString().slice(0, 10);
    if (ltTimeEl) ltTimeEl.value = d.toISOString().slice(11, 16);
  }
  if (ltDateEl) ltDateEl.addEventListener('input', () => { ltTimeDirty = true; });
  if (ltTimeEl) ltTimeEl.addEventListener('input', () => { ltTimeDirty = true; });
  setInterval(() => { if (!ltTimeDirty) ltStampNow(); }, 15000);
  ltStampNow();

  function resetLogTabForm() {
    ltTimeDirty = false;
    ltStampNow();
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

  // Map a CAT-reported mode to one of the log-sheet dropdown options.
  // The phone log dropdown only carries ADIF-style modes (SSB / CW /
  // FT8 / etc.) — without this, modes coming straight from CAT (USB /
  // LSB / PKTUSB / PKTLSB / DIGU / DIGL / USB-D / LSB-D) didn't match
  // any option and the dropdown rendered blank. The spots-table "L"
  // button worked because spot data already carries normalized ADIF
  // modes; the VFO full-view LOG button used currentMode directly,
  // which is what the rig reports.
  const LOG_MODE_OPTIONS = ['SSB','CW','FT8','FT4','FT2','JS8','FM','RTTY','PSK31','JTTY','AM'];
  function aliasModeForLogSheet(rawMode) {
    const m = (rawMode || '').toUpperCase();
    if (!m) return 'SSB';
    if (LOG_MODE_OPTIONS.indexOf(m) !== -1) return m;
    if (m === 'USB' || m === 'LSB') return 'SSB';
    if (m === 'PKTUSB' || m === 'PKTLSB' || m === 'DIGU' || m === 'DIGL' ||
        m === 'USB-D' || m === 'LSB-D' || m === 'DATA' || m === 'DATAU' || m === 'DATAL') {
      return 'FT8';
    }
    return 'SSB';
  }

  // Multi-OTA refs from the spot card. Held while the log sheet is open
  // and forwarded on the log-qso payload so the desktop can populate
  // POTA_REF / SOTA_REF / WWFF_REF / LLOTA_REF independently in ADIF.
  let logMultiRefs = { pota: '', sota: '', wwff: '', llota: '' };
  const logMultiChipsEl = document.getElementById('log-multi-chips');

  function renderMultiChips() {
    const order = ['pota', 'sota', 'wwff', 'llota'];
    const labels = { pota: 'POTA', sota: 'SOTA', wwff: 'WWFF', llota: 'LLOTA' };
    const parts = [];
    for (const t of order) {
      if (logMultiRefs[t]) {
        parts.push(`<span class="log-multi-chip" data-type="${t}">${labels[t]} ${logMultiRefs[t]}</span>`);
      }
    }
    logMultiChipsEl.innerHTML = parts.join('');
    logMultiChipsEl.classList.toggle('hidden', parts.length === 0);
  }

  function openLogSheet(prefill) {
    const p = prefill || {};
    logCall.value = p.callsign || '';
    reportTypedCall('log', logCall.value); // a value set in code counts too
    logFreq.value = p.freqKhz || (currentFreqKhz ? String(Math.round(currentFreqKhz * 10) / 10) : '');
    // INVARIANT: passing freqKhz means "this frequency is NOT the dial's" —
    // a spot's, a decode's — so it is treated as the operator's choice and
    // frozen. A caller whose frequency IS just the current dial must pass
    // nothing and let the fallback above fill it, or the sheet is born dirty
    // and never follows the radio again. That is exactly what the VFO panel's
    // Log button and the PSK Log buttons did: they handed back `currentFreqKhz`
    // and re-broke "the web log doesn't follow the frequency" for everyone who
    // logs from the VFO panel (LZ3AW, still reported after the 1.10.13 fix).
    logFreqDirty = !!p.freqKhz;
    logFreqPinnedKhz = Number(p.freqKhz) || 0;
    logTimeDirty = false;
    logStampNow();
    const mode = aliasModeForLogSheet(p.mode || currentMode);
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

    // Capture multi-OTA secondary refs from the spot card data
    // attributes (set by the spot list renderer when cross-source
    // dedup tagged the spot with multiple programs). Casey decision
    // #3 — show them visibly without an expand click.
    logMultiRefs = {
      pota:  (p.potaRef  || '').toUpperCase(),
      sota:  (p.sotaRef  || '').toUpperCase(),
      wwff:  (p.wwffRef  || '').toUpperCase(),
      llota: (p.llotaRef || '').toUpperCase(),
    };
    // The primary type's ref came in via sigInfo; absorb it into the
    // matching multi-ref slot so the chip strip + payload are the
    // single source of truth on which programs apply to this QSO.
    if (type && type !== 'dx' && p.sigInfo) {
      logMultiRefs[type] = p.sigInfo.toUpperCase();
    }
    renderMultiChips();

    // Reset respot
    logRespotComment.value = '';
    updateLogRespot();

    logSheet.classList.remove('hidden', 'slide-down');
    logBackdrop.classList.remove('hidden');
    if (!p.callsign) logCall.focus();
  }

  function closeLogSheet() {
    reportTypedCall('log', ''); // a closed sheet is not holding a call
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
      const typeToSig = { pota: 'POTA', sota: 'SOTA', wwff: 'WWFF', llota: 'LLOTA', wwbota: 'WWBOTA' };
      const sig = typeToSig[logSelectedType] || logSig.value || '';
      const rawRef = logRefInput.value.trim().toUpperCase();
      const logRefs = rawRef.split(',').map(function (r) { return r.trim(); }).filter(Boolean);
      const typedRef = logRefs[0] || '';
      // Every ref (a two-fer is a comma list); the desktop writes one record
      // each, each with its own POTA_REF (this sheet sent "US-1,US-2" as the
      // POTA_REF of both records).
      const sigInfo = (logSelectedType && logSelectedType !== 'dx' && typedRef) ? logRefs.join(',') : logSigInfo.value || '';

      const logSheetComment = logNotes.value.trim();
      const baseData = {
        freqKhz: freq,
        mode: logMode.value,
        rstSent: logRstSent.value || '59',
        rstRcvd: logRstRcvd.value || '59',
        sig,
        sigInfo,
      };
      // The EXCHANGE time, not the tap time — the desktop's log-qso handler
      // has accepted qsoAt since the JS8 logging work; the web form simply
      // never offered it, so a QSO written up later was stamped 'now'.
      const qsoAt = logQsoAt();
      if (qsoAt) baseData.qsoAt = qsoAt;
      if (logSheetComment) baseData.userComment = logSheetComment;

      // Multi-OTA: forward every program ref the spot was tagged with
      // (or that the user typed into the primary input). Desktop's
      // log-qso handler accepts these and writes them to POTA_REF /
      // SOTA_REF / WWFF_REF / LLOTA_REF independently in ADIF. The
      // primary type's typed ref overrides whatever came from the
      // spot card (n-fer support: comma-separated values flow as-is).
      const liveMulti = Object.assign({}, logMultiRefs);
      if (logSelectedType && logSelectedType !== 'dx' && rawRef) {
        liveMulti[logSelectedType] = rawRef;
      }
      if (liveMulti.pota)  baseData.potaRef  = liveMulti.pota;
      if (liveMulti.sota)  baseData.sotaRef  = liveMulti.sota;
      if (liveMulti.wwff)  baseData.wwffRef  = liveMulti.wwff;
      if (liveMulti.llota) baseData.llotaRef = liveMulti.llota;

      // Respot flags
      const respotCb = document.getElementById('log-respot-cb');
      if (respotCb && respotCb.checked) {
        const targets = (logRespotSection.dataset.targets || '').split(',').filter(Boolean);
        const comment = logRespotComment.value.trim();
        if (targets.includes('pota')) { baseData.respot = true; }
        if (targets.includes('wwff')) { baseData.wwffRespot = true; baseData.wwffReference = typedRef || sigInfo; }
        if (targets.includes('llota')) { baseData.llotaRespot = true; baseData.llotaReference = typedRef || sigInfo; }
        if (targets.includes('dxc')) { baseData.dxcRespot = true; }
        if (comment) baseData.respotComment = comment;
      }

      // Include activator fields when activation is running
      if (activationSig && activationRef) {
        baseData.mySig = activationSig;
        baseData.mySigInfo = activationRef;
      }
      if (phoneGrid) baseData.myGridsquare = phoneGrid;

      if (logAsCall) baseData.logAs = logAsValue(); // another operator (or all of them) on the desktop

      // ONE contact, every callsign in it — the desktop's logContact writes
      // one record per call × park and re-spots once (one message per
      // callsign re-spotted the activator once per operator).
      ws.send(JSON.stringify({ type: 'log-qso', data: Object.assign({}, baseData, { callsign: calls.join(',') }) }));
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
    // Spectrum feed follows visibility: pause the desktop's FFT loop when
    // the FT8 tab (and its waterfall) leaves the screen, resume on return.
    // try: switchTab can run during initial view restore, before the FT8
    // section's declarations have evaluated (let = TDZ, typeof included).
    try {
      if (ft8WfVisible && activeTab !== tab) {
        if (activeTab === 'ft8' && tab !== 'ft8') ft8WfSubscribe(false);
        else if (tab === 'ft8' && activeTab !== 'ft8') ft8WfSubscribe(true);
      }
    } catch { /* pre-init switch — nothing subscribed yet */ }
    try { scopeSyncSubscription(tab); } catch { /* pre-init */ }
    // Leaving FT8: remember where it was, to come back to it (item 15).
    try {
      if (activeTab === 'ft8' && tab !== 'ft8' && currentFreqKhz > 0) {
        ft8TabDial = { freqKhz: currentFreqKhz, band: freqToBandLocal(currentFreqKhz), mode: ft8Mode };
      }
    } catch { /* pre-init */ }
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
    if (propView) propView.classList.add('hidden');
    if (dirView) dirView.classList.add('hidden');
    if (sstvView) { sstvView.classList.add('hidden'); sstvView.style.display = 'none'; }
    if (scopeView) { scopeView.classList.add('hidden'); scopeView.style.display = 'none'; }
    if (mailView) { mailView.classList.add('hidden'); mailView.style.display = 'none'; }
    // Popout trigger: visible only on the Map tab, and only in non-popout windows
    if (mapPopoutBtn) mapPopoutBtn.classList.toggle('hidden', isPopout || tab !== 'map');
    if (scanning) stopScan();
    // Show/hide PTT button — hide when FT8/SSTV tab is active
    pttBtn.style.display = (tab === 'ft8' || tab === 'sstv' || tab === 'scope' || tab === 'mail') ? 'none' : '';
    // Hide entire bottom bar on FT8/SSTV tab
    bottomBar.style.display = (tab === 'ft8' || tab === 'sstv' || tab === 'scope' || tab === 'mail') ? 'none' : '';
    // Hide Scan button and freq step arrows on FT8/SSTV tab
    scanBtn.style.display = (tab === 'ft8' || tab === 'sstv' || tab === 'scope' || tab === 'mail') ? 'none' : '';
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
        workedOverlayAttach(spotMap); // worked-states / countries tints + legend
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
        // The BAND field follows the spot by its band, not by nearness to a
        // dial: a spot 2 kHz off the watering hole (or an FT4 spot judged
        // against FT8 dials) matched nothing and left the old band showing.
        var spotBand = freqToBandLocal(spotFreq);
        for (var oi = 0; oi < ft8BandSelect.options.length; oi++) {
          if (ft8BandSelect.options[oi].value === spotBand) { ft8BandSelect.selectedIndex = oi; break; }
        }
        ft8TabDial = { freqKhz: spotFreq, band: spotBand, mode: ft8Mode };
        // Don't send jtcat-set-band — the spot tune already set the frequency
      } else {
        // Back on the FT8 tab: return to where FT8 was left (a spot's dial or
        // a band dial), not the band's default — and not wherever another
        // tab moved the rig. The band select still decides the band.
        var selectedOpt = ft8BandSelect.options[ft8BandSelect.selectedIndex];
        if (selectedOpt) {
          var back = ft8ReturnDial(ft8TabDial, selectedOpt.value, ft8Mode);
          var freqKhz = back || parseInt(selectedOpt.dataset.freq, 10);
          ft8Send({ type: 'jtcat-set-band', band: selectedOpt.value, freqKhz: freqKhz });
        }
      }
      ft8StartCountdown();
      if (ft8BsOn && scopeAvailable()) { scopeSizeCanvases(); scopeDrawAll(); }
    } else if (tab === 'prop') {
      showPropView();
    } else if (tab === 'dir') {
      if (dirView) dirView.classList.remove('hidden');
      renderDirectoryTab();
    } else if (tab === 'mail') {
      if (mailView) { mailView.classList.remove('hidden'); mailView.style.display = 'flex'; }
      mailOnOpen();
    } else if (tab === 'scope') {
      if (scopeView) { scopeView.classList.remove('hidden'); scopeView.style.display = 'flex'; }
      scopeSizeCanvases();
      scopeDrawAll();
    } else if (tab === 'sstv') {
      if (sstvView) { sstvView.classList.remove('hidden'); sstvView.style.display = 'flex'; }
      // Open SSTV on desktop + fetch recent decodes
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'sstv-open' }));
        // Ask desktop to push its current compose so the phone mirrors what the
        // user already built (background image + text layers). Desktop replies
        // with an 'sstv-compose-state' message.
        ws.send(JSON.stringify({ type: 'sstv-get-compose' }));
        // QSY the radio to the phone's selected SSTV freq — otherwise it stays
        // on whatever POTA spot was last tuned.
        try {
          var freqEl = document.getElementById('sstv-freq-phone');
          if (freqEl && freqEl.value) {
            var fOpt = freqEl.options[freqEl.selectedIndex];
            var fMode = (fOpt && fOpt.dataset.mode) || (parseInt(freqEl.value) < 10000 ? 'LSB' : 'USB');
            ws.send(JSON.stringify({ type: 'tune', freqKhz: freqEl.value, mode: fMode }));
          }
        } catch (e) {}
      }
      sstvPhoneRequestGallery(10, 0);
      // Paint the compose canvas immediately — otherwise it sits blank until
      // the user taps it (which triggers a redraw via the touch handlers).
      if (typeof sstvRenderPhoneCompose === 'function') sstvRenderPhoneCompose();
    }
  }

  function updateLogViewState() {
    if (activationRunning) {
      activationSetup.classList.add('hidden');
      pastActivationsDiv.classList.add('hidden');
      quickLogForm.classList.remove('hidden');
      logFooter.classList.remove('hidden');
      qlFreqDirty = false; qlModeDirty = false;
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

  if (qlFreq) qlFreq.addEventListener('input', () => { qlFreqDirty = true; });
  qlMode.addEventListener('change', () => {
    qlModeDirty = true;
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
  // Every field that can hold the call being worked reports it (CW {call}).
  qlCall.addEventListener('input', () => reportTypedCall('ql', qlCall.value));
  ltCall.addEventListener('input', () => reportTypedCall('lt', ltCall.value));
  logCall.addEventListener('input', () => reportTypedCall('log', logCall.value));

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

    if (logAsCall) data.logAs = logAsValue(); // another operator (or all of them) on the desktop

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'log-qso', data }));
      qlLogBtn.disabled = true;
      setTimeout(() => { qlLogBtn.disabled = false; }, 3000);
    } else {
      // Offline — queue locally
      const now = new Date();
      // qsoAt: when the contact was made — the desktop stamps the drain time
      // otherwise (logging parity audit 2026-10-19).
      offlineQueue.push({ ...data, qsoAt: now.getTime(), _offline: true, _ts: now.toISOString() });
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
    reportTypedCall('ql', '');
    qlCallInfo.classList.add('hidden');
    qlCallInfo.textContent = '';
    qlNotes.value = '';
    qlCall.focus();
    qlFreqDirty = false; qlModeDirty = false;
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
    // Items queued by an older page carry only _ts.
    if (!data.qsoAt && data._ts) { const ms = Date.parse(data._ts); if (Number.isFinite(ms)) data.qsoAt = ms; }
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
    // Check both: phone localStorage (fast path) AND server-pushed flag
    // (survives Safari ITP wiping localStorage on the phone). The server
    // flag is set in echoSettings via auth-ok handshake.
    if (localStorage.getItem('echocat-welcome-dismissed')) return;
    if (echoSettings && echoSettings.echocatWelcomeDismissed) return;
    welcomeOverlay.classList.remove('hidden');
  }

  welcomeOk.addEventListener('click', () => {
    if (welcomeHide.checked) {
      localStorage.setItem('echocat-welcome-dismissed', '1');
      // Mirror to desktop so it survives a phone-side localStorage wipe
      // (Safari ITP, browser cache clear, etc.). The user shouldn't have
      // to dismiss this every login.
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'save-echo-pref', key: 'echocatWelcomeDismissed', value: true }));
      }
    }
    welcomeOverlay.classList.add('hidden');
  });

  // --- Rig Selector ---
  function updateRigSelect(rigs, activeRigId) {
    // Rig-scoped UI: FT8 multi-slice is Flex-only (slices A-D / DAX). The
    // desktop stamps each rig with `family`; hide the Multi button when the
    // active rig isn't a Flex. Fail open when family is absent (older
    // desktop build) — the desktop side also guards the start message.
    const activeRigEntry = (rigs || []).find(r => r && r.id === activeRigId);
    const famKnown = activeRigEntry && activeRigEntry.family;
    const multiBtnEl = document.getElementById('ft8-multi-btn');
    if (multiBtnEl) multiBtnEl.style.display = (famKnown && famKnown !== 'flex') ? 'none' : '';
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
  // PROP VIEW — RBN + PSKReporter (LZ3AW): where this station is heard
  // =============================================
  const propList = document.getElementById('prop-list');
  const propCount = document.getElementById('prop-count');
  const propSrcRbn = document.getElementById('prop-src-rbn');
  const propSrcPskr = document.getElementById('prop-src-pskr');
  const propBandSel = document.getElementById('prop-band');
  const propAgeSel = document.getElementById('prop-age');
  let propRbn = [];
  let propPskr = [];
  let propMap = null;
  let propLayer = null;
  // Band colours of the desktop Prop view (RBN_BAND_COLORS_NORMAL).
  const PROP_BAND_COLORS = {
    '160m': '#ff4444', '80m': '#ff8c00', '60m': '#ffd700', '40m': '#4ecca3', '30m': '#00cccc',
    '20m': '#4488ff', '17m': '#8844ff', '15m': '#cc44ff', '12m': '#ff44cc', '10m': '#ff4488',
    '6m': '#e0e0e0', '2m': '#88ff88',
  };

  /**
   * Pure: the reports the Prop tab shows, newest first — RBN and/or
   * PSKReporter, one band or all, no older than ageMin. Each row carries
   * its source and the station that heard us. test/lz3aw-round14-test.js.
   */
  function propFilter(rbn, pskr, f) {
    const now = f.now || Date.now();
    const maxAgeMs = (Number(f.ageMin) || 60) * 60000;
    const out = [];
    const take = (list, source, station) => {
      for (const s of list || []) {
        if (!s) continue;
        if (f.band && s.band !== f.band) continue;
        const t = Date.parse(s.spotTime);
        if (Number.isFinite(t) && now - t > maxAgeMs) continue;
        out.push({ source, station: s[station] || '', band: s.band || '', mode: s.mode || '', snr: s.snr,
          wpm: s.wpm, distance: s.distance, lat: s.lat, lon: s.lon, locationDesc: s.locationDesc || '', at: Number.isFinite(t) ? t : 0 });
      }
    };
    if (f.rbn !== false) take(rbn, 'RBN', 'spotter');
    if (f.pskr !== false) take(pskr, 'PSKR', 'receiver');
    return out.sort((a, b) => b.at - a.at);
  }

  function propAgeText(at) {
    if (!at) return '';
    const m = Math.max(0, Math.round((Date.now() - at) / 60000));
    return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h';
  }

  function renderProp() {
    if (!propList) return;
    const rows = propFilter(propRbn, propPskr, {
      rbn: propSrcRbn ? propSrcRbn.checked : true,
      pskr: propSrcPskr ? propSrcPskr.checked : true,
      band: propBandSel ? propBandSel.value : '',
      ageMin: propAgeSel ? propAgeSel.value : 60,
    });
    if (propCount) propCount.textContent = rows.length + (rows.length === 1 ? ' report' : ' reports');
    propList.innerHTML = rows.length ? rows.map(r =>
      '<div class="prop-row">' +
        '<span class="prop-age">' + propAgeText(r.at) + '</span>' +
        '<span class="prop-station">' + esc(r.station) + '<span class="prop-src-tag">' + r.source + (r.locationDesc ? ' ' + esc(r.locationDesc) : '') + '</span></span>' +
        '<span class="prop-band" style="color:' + (PROP_BAND_COLORS[r.band] || 'var(--text)') + '">' + esc(r.band) + '</span>' +
        '<span class="prop-snr">' + (r.snr != null && r.snr !== '' ? esc(String(r.snr)) + ' dB' : '') + '</span>' +
        '<span class="prop-dist">' + formatSpotDist(r.distance) + '</span>' +
      '</div>').join('')
      : '<div class="prop-empty">No reports in this window. RBN hears CW; PSKReporter hears FT8 and the other digital modes — they appear here after you transmit.</div>';
    if (propMap && propLayer) {
      propLayer.clearLayers();
      for (const r of rows) {
        if (typeof r.lat !== 'number' || typeof r.lon !== 'number') continue;
        L.circleMarker([r.lat, r.lon], {
          radius: 6, color: PROP_BAND_COLORS[r.band] || '#ffffff', weight: 1, fillOpacity: 0.7,
        }).bindPopup(esc(r.station) + ' (' + r.source + ')<br>' + esc(r.band) + ' ' + esc(r.mode) +
          (r.snr != null && r.snr !== '' ? ' ' + esc(String(r.snr)) + ' dB' : '')).addTo(propLayer);
      }
    }
  }

  function showPropView() {
    if (!propView) return;
    propView.classList.remove('hidden');
    if (!propMap && typeof L !== 'undefined') {
      propMap = L.map('prop-map', { zoomControl: true, minZoom: 1, worldCopyJump: true }).setView([30, -40], 2);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OSM', className: 'dark-tiles',
      }).addTo(propMap);
      propLayer = L.layerGroup().addTo(propMap);
    }
    if (propMap) setTimeout(() => propMap.invalidateSize(), 100);
    renderProp();
  }
  [propSrcRbn, propSrcPskr, propBandSel, propAgeSel].forEach(el => {
    if (el) el.addEventListener('change', renderProp);
  });

  // =============================================
  // LOGBOOK VIEW
  // =============================================

  function requestAllQsos() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'get-all-qsos' }));
    }
  }

  // Filter bar (band, mode, date range), as in the desktop Logbook window.
  const lbFilterBand = document.getElementById('lb-filter-band');
  const lbFilterMode = document.getElementById('lb-filter-mode');
  const lbFilterFrom = document.getElementById('lb-filter-from');
  const lbFilterTo = document.getElementById('lb-filter-to');
  const lbFilterClear = document.getElementById('lb-filter-clear');

  /**
   * The mode a QSO is filed under in the Mode filter — the family, as the
   * desktop Logbook shows it: USB/LSB are SSB, MFSK+SUBMODE FT4 is FT4,
   * PSK31/63 are PSK.
   */
  function lbModeFamily(q) {
    const sub = String(q.SUBMODE || '').toUpperCase();
    const m = String(q.MODE || '').toUpperCase();
    const v = (m === 'MFSK' && sub) ? sub : m;
    if (v === 'USB' || v === 'LSB') return 'SSB';
    if (/^PSK/.test(v)) return 'PSK';
    return v;
  }

  /** Pure: the QSOs a search + filter set shows. test/lz3aw-round14-test.js. */
  function lbFilterQsos(qsos, f) {
    const query = String(f.query || '').trim().toUpperCase();
    const band = String(f.band || '').toUpperCase();
    const mode = String(f.mode || '').toUpperCase();
    const from = String(f.from || '').replace(/-/g, '');
    const to = String(f.to || '').replace(/-/g, '');
    return qsos.filter(q => {
      if (band && String(q.BAND || '').toUpperCase() !== band) return false;
      if (mode && lbModeFamily(q) !== mode) return false;
      const d = String(q.QSO_DATE || '');
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (!query) return true;
      return [q.CALL, q.SIG_INFO, q.COMMENT, q.MODE, q.BAND].some(v => String(v || '').toUpperCase().includes(query));
    });
  }

  function getFilteredLogbook() {
    const filtered = lbFilterQsos(logbookQsos, {
      query: lbSearch.value,
      band: lbFilterBand ? lbFilterBand.value : '',
      mode: lbFilterMode ? lbFilterMode.value : '',
      from: lbFilterFrom ? lbFilterFrom.value : '',
      to: lbFilterTo ? lbFilterTo.value : '',
    });
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
    lbCount.textContent = lbTruncated && lbTotal > logbookQsos.length
      ? 'newest ' + filtered.length + ' of ' + lbTotal + ' QSOs'
      : filtered.length + ' QSO' + (filtered.length !== 1 ? 's' : '');

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
      // CQ/ITU zones (LZ3AW item 30): the record's own CQZ/ITUZ, else the
      // desktop's cty.dat answer (_cqz/_ituz, display only). Shown when the
      // zone columns are on in the spot list — one zone choice per device.
      const cqz = q.CQZ || (q._cqz != null ? String(q._cqz) : '');
      const ituz = q.ITUZ || (q._ituz != null ? String(q._ituz) : '');
      let zones = '';
      if (colShow.cqz && cqz) zones += `CQ ${esc(cqz)}`;
      if (colShow.ituz && ituz) zones += (zones ? ' · ' : '') + `ITU ${esc(ituz)}`;

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
          <div class="log-row">
            <div class="log-field"><label>CQ zone</label><input type="text" inputmode="numeric" data-field="CQZ" data-orig="${esc(q.CQZ || '')}" value="${esc(q.CQZ || '')}" placeholder="${q._cqz != null ? esc(String(q._cqz)) : ''}"></div>
            <div class="log-field"><label>ITU zone</label><input type="text" inputmode="numeric" data-field="ITUZ" data-orig="${esc(q.ITUZ || '')}" value="${esc(q.ITUZ || '')}" placeholder="${q._ituz != null ? esc(String(q._ituz)) : ''}"></div>
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
          ${zones ? `<span class="lb-zones">${zones}</span>` : ''}
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
  [lbFilterBand, lbFilterMode, lbFilterFrom, lbFilterTo].forEach(el => {
    if (el) el.addEventListener('change', renderLogbook);
  });
  if (lbFilterClear) lbFilterClear.addEventListener('click', () => {
    [lbFilterBand, lbFilterMode, lbFilterFrom, lbFilterTo].forEach(el => { if (el) el.value = ''; });
    lbSearch.value = '';
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
        // A zone the record never had and nobody typed stays absent — the
        // cty.dat guess in the placeholder is never written to the log.
        if (input.dataset.orig != null && input.value === '' && input.dataset.orig === '') return;
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
      if (ft8PendingTxMsg) {
        // We transmitted during this cycle — show what we sent in the
        // history so the operator can see "what step did I send" without
        // looking at the QSO tracker. Cleared after rendering so the
        // next quiet cycle shows "No decodes" again.
        const row = document.createElement('div');
        row.className = 'ft8-row ft8-tx';
        row.innerHTML = DecodeRow.txRowInner(ft8PendingTxMsg, 'ft8');
        log.appendChild(row);
        ft8PendingTxMsg = '';
      } else {
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
        const isDirected = !!myCallsign && (typeof JtcatParser !== 'undefined' && JtcatParser.isAddressedTo
          ? JtcatParser.isAddressedTo(upper, myCallsign)
          : upper.indexOf(myCallsign.toUpperCase()) >= 0);
        const isHunt = ft8HuntCall && upper.indexOf(ft8HuntCall) >= 0;
        const is73 = upper.indexOf('RR73') >= 0 || upper.indexOf(' 73') >= 0;

        // Auto-reply runs regardless of filter.
        // The CQ is parsed by the SHARED parser, which strips the <...> a
        // decoder puts around a call it resolved from a hash. This hand-rolled
        // copy did not: a hunt target that decoded as "CQ <SP9ABC/P> KO02"
        // never matched, so the one station the operator had asked for was
        // the one station the web client would not answer (LZ3AW 2026-09-19).
        if (isHunt && isCq && !ft8QsoState) {
          let call = '', grid = '';
          if (typeof JtcatParser !== 'undefined' && JtcatParser.parseCq) {
            const pc = JtcatParser.parseCq(upper);
            call = pc.call || '';
            grid = pc.grid || '';
          } else {
            const parts = upper.split(/\s+/);
            let callIdx = -1;
            for (let i = 1; i < parts.length; i++) {
              if (_rmtLooksLikeCall(parts[i])) { callIdx = i; break; }
            }
            if (callIdx === -1) callIdx = 1;
            call = parts[callIdx] || '';
            grid = parts[callIdx + 1] || '';
          }
          // Compare on the base call so a portable or hash-rendered form of
          // the hunted station still counts as the station.
          const sameCall = call && (call === ft8HuntCall ||
            (typeof JtcatParser !== 'undefined' && JtcatParser.normalizeCall &&
             JtcatParser.normalizeCall(call) === JtcatParser.normalizeCall(ft8HuntCall)));
          if (sameCall) {
            ft8Send({ type: 'jtcat-reply', call, grid, df: d.df || 1500, sliceId: d.sliceId,
              snr: d.db, slot: d.slot, text: text || '', nextStep: 'reply-cq' });
            ft8HuntCall = ''; // clear hunt — we've engaged
          }
        }

        // Always show decodes from/to our active QSO partner
        const isQsoPartner = ft8QsoState && ft8QsoState.call && upper.indexOf(ft8QsoState.call.toUpperCase()) >= 0;
        const isWanted = d.newDxcc || d.newCall || d.newGrid || d.wantedState;

        // Apply CQ filter — always show CQ, 73, directed-at-me, hunted, and QSO partner
        if (ft8CqFilter && !isCq && !is73 && !isDirected && !isHunt && !isQsoPartner) return;
        if (ft8WantedFilter && !isWanted && !isDirected && !is73 && !isHunt && !isQsoPartner) return;
        if (ft8ChaseFilter && !d.chaseMatch && !isDirected && !is73 && !isHunt && !isQsoPartner) return;
        if (ft8SearchTokens.length && !ft8SearchTokens.some(function (t) { return upper.indexOf(t) !== -1; })) return;

        // Build needed badges + entity
        let badges = '';
        if (d.chaseMatch) badges += '<span class="ft8-badge ft8-badge-chase" title="Chase target: ' + esc(ft8ChaseTarget) + '">◎</span>';
        if (d.newDxcc) badges += '<span class="ft8-badge ft8-badge-dxcc" title="New DXCC: ' + esc(d.entity || '') + '">D</span>';
        if (d.wantedState && d.state && d.state.code) badges += '<span class="ft8-badge ft8-badge-state" title="' + esc(d.state.certain ? 'New state: ' + d.state.code : 'New state? ' + d.state.code) + '">' + esc(d.state.code) + (d.state.certain ? '' : '?') + '</span>';
        if (d.newGrid) badges += '<span class="ft8-badge ft8-badge-grid" title="New grid: ' + esc(d.grid || '') + '">G</span>';
        if (d.newCall) badges += '<span class="ft8-badge ft8-badge-call" title="New call: ' + esc(d.call || '') + '">C</span>';
        if (d.watched) badges += '<span class="ft8-badge ft8-badge-watch" title="Watchlist">W</span>';
        if (d.call && donorCallsigns.has(d.call.toUpperCase())) badges += '<span class="ft8-badge ft8-badge-donor" title="POTACAT Supporter">\uD83D\uDC3E</span>';
        if (d.call && d.call.toUpperCase() === 'K3SBP') badges += '<span class="ft8-badge ft8-badge-donor" title="POTACAT Creator">\uD83D\uDC08\u200D\u2B1B</span>';
        const entityStr = d.entity ? '<span class="ft8-entity">' + esc(d.entity) + '</span>' : '';

        const row = document.createElement('div');
        row.className = 'ft8-row' + (isCq ? ' ft8-cq' : '') + (isDirected ? ' ft8-directed' : '') + (isHunt ? ' ft8-hunt' : '') + (isWanted ? ' ft8-wanted' : '') + (d.chaseMatch ? ' ft8-chase' : '') + (d.watched ? ' ft8-watched' : '');
        // Cells and number formats: lib/decode-row.js (inlined above).
        row.innerHTML = DecodeRow.webRowInner(d, text, badges, entityStr);
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

  // My Activity is an append-only view of decodes directed at us; over a long
  // session it becomes a wall. Clearing is a VIEW action only — the log, the
  // QSO state machine and Band Activity are untouched (LZ3AW 2026-08-29).
  (function initMyActivityClear() {
    const btn = document.getElementById('ft8-my-activity-clear');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const myLog = document.getElementById('ft8-my-activity');
      const myHeader = document.getElementById('ft8-my-activity-header');
      if (myLog) myLog.innerHTML = '';
      // Re-hide the empty pane so the layout returns to its pre-activity
      // state; the next directed decode unhides both again.
      if (myLog) myLog.classList.add('hidden');
      if (myHeader) myHeader.classList.add('hidden');
    });
  })();

  function ft8AddTxRow(message) {
    const log = ft8DecodeLogEl;
    const row = document.createElement('div');
    row.className = 'ft8-row ft8-tx';
    row.innerHTML = DecodeRow.txRowInner(message, 'ft8');
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  // Same FT8 next-step inference as renderer/jtcat-popout.js — see the
  // comment block there for the why. Conflating steps 3 and 4 (R-prefixed
  // signal report vs plain signal report) and treating their step-2 grid
  // reply as a fresh CQ-reply caused double-click sequencing to roll back
  // the QSO. Chris N4RDX 2026-04-29.
  // Mirror of renderer/jtcat-parser.js (the phone can't load the shared module
  // — the ECHOCAT server serves a fixed asset whitelist). Keep in sync.
  function _rmtLooksLikeCall(tok) {
    if (!tok || tok.length < 3 || tok.length > 11) return false;
    if (/^(CQ|DE|RR73|RRR|73|TU|TNX|QRZ)$/i.test(tok)) return false;
    if (/^R?[+-]\d{2}$/.test(tok)) return false;
    if (/^[A-R]{2}\d{2}([A-X]{2})?$/i.test(tok)) return false;
    if (!/[A-Z]/i.test(tok) || !/\d/.test(tok)) return false;
    return /^[A-Z0-9/]+$/i.test(tok);
  }
  function _rmtBaseCall(call) {
    if (!call) return '';
    var c = String(call).toUpperCase().replace(/[<>]/g, '');
    if (c.indexOf('/') >= 0) {
      var segs = c.split('/').filter(Boolean), best = '';
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (/[0-9]/.test(s) && /[A-Z]/.test(s) && s.length > best.length) best = s;
      }
      c = best || segs[0] || '';
    }
    return c;
  }
  // Reply-step classification delegates to the SHARED parser
  // (jtcat-parser.js, inlined into this page by the server) — the same
  // module the desktop popout and main.js use. This replaces a hand-copied
  // fork that was missing the tail-end branch, which made taps on stations
  // mid-QSO with someone else dead-end into a bare retune: web could only
  // answer CQ lines (LZ3AW item 3). The host re-derives authoritatively
  // from the raw text, so client and host can no longer drift apart.
  function ft8InferReplyStep(decode, myCall) {
    if (typeof JtcatParser === 'undefined' || !JtcatParser.inferReplyStep) return null;
    return JtcatParser.inferReplyStep({ text: (decode && decode.text) || '' }, myCall);
  }

  function ft8ClickDecode(decode) {
    const action = ft8InferReplyStep(decode, myCallsign);
    if (!action) {
      // Not a CQ, not addressed to us — just retune.
      if (decode.df) ft8Send({ type: 'jtcat-set-tx-freq', hz: decode.df });
      return;
    }
    ft8Send({
      type: 'jtcat-reply',
      call: action.call,
      df: decode.df || 1500,
      sliceId: decode.sliceId,
      snr: decode.db,
      slot: decode.slot,
      // Raw decode text — the host re-derives the step from this
      // authoritatively (immune to a stale classifier on our side).
      text: decode.text || '',
      nextStep: action.step,
      theirGrid: action.theirGrid,
      theirReport: action.theirReport,
      // Legacy fields for back-compat:
      grid: action.theirGrid || '',
      report: action.theirReport,
      rr73: action.step === 'send-73' || undefined,
    });
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
      // CQ flow: CQ(tx) -> reply(rx) -> report(tx) -> R+rpt(rx) -> RR73(tx)
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
      // Reply flow: reply(tx) -> rpt(rx) -> R+rpt(tx) -> RR73(rx) -> 73(tx)
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
  // Desktop clock minus this device's clock, from the server hello (item 17).
  var serverClockOffsetMs = 0;
  var ft8CycleBar = document.getElementById('ft8-cycle-bar');
  function ft8StartCountdown() {
    if (ft8CountdownTimer) clearInterval(ft8CountdownTimer);
    const cycleSec = ft8Mode === 'FT2' ? 3.8 : ft8Mode === 'FT4' ? 7.5 : 15;
    ft8CountdownTimer = setInterval(() => {
      const now = (Date.now() + serverClockOffsetMs) / 1000; // the desktop's clock, not the phone's
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
      // Map 0-255 to color (blue->cyan->yellow->red)
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

  // Bands the shack's rig is used on (S2C rig-bands, lib/rig-bands.js inlined):
  // every band button and band picker on this page hides the others. The
  // spot list itself is filtered on the shack.
  var webRigBands = null;
  function applyWebRigBands() {
    var RB = window.RigBands;
    if (!RB) return;
    RB.applyToElements(document, '.vf-band', webRigBands);
    RB.applyToElements(document, '#rc-band-filter .rc-dropdown-item', webRigBands);
    var mailSel = document.getElementById('mail-band');
    if (mailSel) { RB.applyToElements(mailSel, 'option', webRigBands); RB.fixSelect(mailSel); }
    var ft8Sel = document.getElementById('ft8-band-select');
    if (ft8Sel) {
      var cur = ft8Sel.value;
      RB.applyToElements(ft8Sel, 'option', webRigBands, function (o) { return o.value === cur ? '' : o.value; });
    }
    var sstvSel = document.getElementById('sstv-freq-phone');
    if (sstvSel) {
      sstvSel.querySelectorAll('optgroup').forEach(function (g) {
        var ok = RB.allowed(webRigBands, g.label);
        g.hidden = !ok;
        g.querySelectorAll('option').forEach(function (o) { o.hidden = !ok; o.disabled = !ok; });
      });
    }
    // The Landmarks tab hides what the shack's radio cannot tune.
    if (activeTab === 'dir' && dirActiveTab === 'landmarks') renderDirectoryTab();
  }

  // TX slot LOCK: Auto -> 1st (even) -> 2nd (odd) -> Auto. The desktop
  // persists it and echoes jtcat-tx-slot-state to every client (main.js
  // applyJtcatTxSlotLock), so this button always shows the shack's lock.
  function reflectFt8TxSlot(lock) {
    ft8TxSlot = (lock === 'even' || lock === 'odd') ? lock : 'auto';
    ft8SlotBtn.textContent = ft8TxSlot === 'auto' ? 'Slot: Auto' : ft8TxSlot === 'even' ? 'Slot: 1st' : 'Slot: 2nd';
    ft8SlotBtn.classList.toggle('locked', ft8TxSlot !== 'auto');
    ft8SlotBtn.title = ft8TxSlot === 'auto'
      ? 'TX slot: Auto. Replies go opposite the station; a new CQ stays in the slot you last transmitted in. Tap to lock.'
      : 'TX slot locked to ' + (ft8TxSlot === 'even' ? '1st (even)' : '2nd (odd)') + ': every CQ and reply stays there. Tap to change.';
  }
  ft8SlotBtn.addEventListener('click', () => {
    const next = ft8TxSlot === 'auto' ? 'even' : ft8TxSlot === 'even' ? 'odd' : 'auto';
    reflectFt8TxSlot(next);
    ft8Send({ type: 'jtcat-set-tx-slot', slot: next });
  });
  reflectFt8TxSlot('auto');
  // A tap on a station in the locked slot was refused by the shack: say why,
  // and offer to unlock and send the same reply again.
  let ft8SlotToast = null;
  function hideFt8SlotToast() {
    if (ft8SlotToast) { ft8SlotToast.remove(); ft8SlotToast = null; }
  }
  function showFt8SlotRefused(r) {
    hideFt8SlotToast();
    const el = document.createElement('div');
    el.className = 'ft8-slot-toast';
    const msgEl = document.createElement('span');
    msgEl.textContent = (r && r.text) || 'That station transmits in the slot you locked.';
    el.appendChild(msgEl);
    if (r && r.retry && r.retryType) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Unlock and call';
      b.addEventListener('click', () => {
        hideFt8SlotToast();
        reflectFt8TxSlot('auto');
        ft8Send({ type: 'jtcat-set-tx-slot', slot: 'auto' });
        ft8Send(Object.assign({}, r.retry, { type: r.retryType }));
      });
      el.appendChild(b);
    }
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = 'Keep locked';
    keep.addEventListener('click', hideFt8SlotToast);
    el.appendChild(keep);
    document.body.appendChild(el);
    ft8SlotToast = el;
    setTimeout(() => { if (ft8SlotToast === el) hideFt8SlotToast(); }, 12000);
  }

  // CQ button
  ft8CqBtn.addEventListener('click', () => {
    const inQso = ft8QsoState && ft8QsoState.phase !== 'idle' && ft8QsoState.phase !== 'done';
    if (inQso) {
      // Cancel current QSO
      ft8Send({ type: 'jtcat-cancel-qso' });
    } else {
      // Call CQ directed at the current chase target (CQ <tag> <call> <grid>).
      ft8TxEnabled = true;
      ft8TxBtn.classList.add('active');
      ft8Send({ type: 'jtcat-call-cq', modifier: ft8ChaseTarget });
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

  // --- Chase target (shared CqTarget module, synced with the desktop) ---
  var ft8ChaseFilterBtn = document.getElementById('ft8-chase-filter');
  var ft8ChaseSelect = document.getElementById('ft8-chase');
  var ft8ChaseCustom = document.getElementById('ft8-chase-custom');
  var ft8ChaseQuick = (window.CqTarget && window.CqTarget.QUICK_PICKS) || [];
  var ft8ChaseQuickSet = {};
  ft8ChaseQuick.forEach(function(p) { ft8ChaseQuickSet[p.tag] = true; });

  (function buildFt8ChasePicker() {
    if (!ft8ChaseSelect) return;
    var html = '<option value="">Chase: --</option>';
    var lastCat = '';
    ft8ChaseQuick.forEach(function(p) {
      if (p.category !== lastCat) {
        if (lastCat) html += '</optgroup>';
        html += '<optgroup label="' + esc(p.category) + '">';
        lastCat = p.category;
      }
      html += '<option value="' + esc(p.tag) + '">' + esc(p.tag) + '</option>';
    });
    if (lastCat) html += '</optgroup>';
    html += '<option value="__custom">Custom…</option>';
    ft8ChaseSelect.innerHTML = html;
  })();

  function reflectFt8ChaseTarget(tag) {
    if (!ft8ChaseSelect) return;
    tag = tag || '';
    if (!tag) { ft8ChaseSelect.value = ''; if (ft8ChaseCustom) ft8ChaseCustom.style.display = 'none'; return; }
    if (ft8ChaseQuickSet[tag]) {
      ft8ChaseSelect.value = tag;
      if (ft8ChaseCustom) ft8ChaseCustom.style.display = 'none';
    } else {
      ft8ChaseSelect.value = '__custom';
      if (ft8ChaseCustom) { ft8ChaseCustom.style.display = ''; ft8ChaseCustom.value = tag; }
    }
  }

  function applyFt8ChaseTarget(rawTag) {
    var v = window.CqTarget ? window.CqTarget.validateTag(rawTag) : { ok: true, tag: (rawTag || '').toUpperCase() };
    if (!v.ok) { reflectFt8ChaseTarget(ft8ChaseTarget); return; } // revert on invalid
    ft8ChaseTarget = v.tag;
    reflectFt8ChaseTarget(ft8ChaseTarget);
    ft8Send({ type: 'jtcat-set-chase-target', tag: ft8ChaseTarget });
  }

  if (ft8ChaseSelect) {
    ft8ChaseSelect.addEventListener('change', function() {
      if (ft8ChaseSelect.value === '__custom') {
        if (ft8ChaseCustom) { ft8ChaseCustom.style.display = ''; ft8ChaseCustom.focus(); }
        return;
      }
      applyFt8ChaseTarget(ft8ChaseSelect.value);
    });
  }
  if (ft8ChaseCustom) {
    var commitFt8Custom = function() { applyFt8ChaseTarget(ft8ChaseCustom.value); };
    ft8ChaseCustom.addEventListener('change', commitFt8Custom);
    ft8ChaseCustom.addEventListener('blur', commitFt8Custom);
    ft8ChaseCustom.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); commitFt8Custom(); ft8ChaseCustom.blur(); } });
  }
  if (ft8ChaseFilterBtn) {
    ft8ChaseFilterBtn.addEventListener('click', function() {
      ft8ChaseFilter = !ft8ChaseFilter;
      ft8ChaseFilterBtn.classList.toggle('active', ft8ChaseFilter);
    });
  }
  // Expose for the settings-blob seed + the jtcat-chase-target dispatcher.
  window.__ft8ReflectChase = function(tag) { ft8ChaseTarget = tag || ''; reflectFt8ChaseTarget(ft8ChaseTarget); };

  // Search filter
  var ft8SearchInput = document.getElementById('ft8-search');
  if (ft8SearchInput) {
    ft8SearchInput.addEventListener('input', function() {
      ft8SearchFilter = ft8SearchInput.value.toUpperCase().trim();
      ft8SearchTokens = ft8SearchFilter.split(/[\s,;]+/).filter(Boolean);
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
        workedOverlayAttach(ft8Map); // worked-states / countries tints + legend
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
  function ft8WfSubscribe(on) {
    // Ask the desktop to run its own FFT loop for us. Without this the
    // waterfall rides the desktop renderer's requestAnimationFrame forward
    // and freezes whenever the desktop window is minimized/occluded.
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'jtcat-spectrum-subscribe', on: !!on })); } catch {}
  }
  function ft8WfSizeCanvas() {
    // Match the backing store to the on-screen width so a phone rotation or
    // tablet layout doesn't smear a fixed 320px bitmap. History clears on
    // resize — acceptable for a 100px strip.
    const cssW = ft8Waterfall.clientWidth || 320;
    const w = Math.max(160, Math.min(640, Math.round(cssW)));
    if (ft8Waterfall.width !== w) ft8Waterfall.width = w;
  }
  ft8WfToggle.addEventListener('click', () => {
    ft8WfVisible = !ft8WfVisible;
    if (ft8WfVisible && ft8BsOn && ft8ScopeIsFlex()) { const bs = document.getElementById('ft8-bs-toggle'); if (bs) bs.click(); }
    ft8Waterfall.classList.toggle('hidden', !ft8WfVisible);
    ft8WfToggle.classList.toggle('active', ft8WfVisible);
    if (ft8WfVisible) ft8WfSizeCanvas();
    ft8WfSubscribe(ft8WfVisible);
  });
  window.addEventListener('resize', () => { if (ft8WfVisible) ft8WfSizeCanvas(); });

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
    applyDigitalPanes(); // WSPR/PSK panes replace the decode log for those modes
    // Retune to the active band's new frequency for the selected mode
    const opt = ft8BandSelect.options[ft8BandSelect.selectedIndex];
    if (opt) {
      if (ft8Mode === 'WSPR') {
        // WSPR dials are derived HOST-side from the band name (the handler
        // calls wsprBands.dialForBand) — send the band WITHOUT freqKhz so the
        // host sets the correct dial; never tune from a client table.
        ft8Send({ type: 'jtcat-set-band', band: opt.value });
        const wKhz = WSPR_BAND_FREQS[opt.value];
        if (wKhz) { freqDisplay.textContent = formatFreq(wKhz * 1000); currentFreqKhz = wKhz; }
      } else {
        const freqKhz = parseFloat(opt.dataset.freq);
        ft8Send({ type: 'jtcat-set-band', band: opt.value, freqKhz });
        const hz = freqKhz * 1000;
        if (hz > 100000) { freqDisplay.textContent = formatFreq(hz); currentFreqKhz = freqKhz; }
      }
    }
  });

  // --- Band select ---
  ft8BandSelect.addEventListener('change', () => {
    const opt = ft8BandSelect.options[ft8BandSelect.selectedIndex];
    const band = opt.value;
    ft8TabDial = null; // a band chosen here is its dial
    if (ft8Mode === 'WSPR') {
      // Host derives the WSPR dial from the band name — no client freq.
      ft8Send({ type: 'jtcat-set-band', band });
      const wKhz = WSPR_BAND_FREQS[band];
      if (wKhz) { freqDisplay.textContent = formatFreq(wKhz * 1000); currentFreqKhz = wKhz; }
    } else {
      const freqKhz = parseFloat(opt.dataset.freq);
      ft8Send({ type: 'jtcat-set-band', band, freqKhz });
      // Immediately update frequency display (don't wait for CAT poll)
      const hz = freqKhz * 1000;
      if (hz > 100000) { freqDisplay.textContent = formatFreq(hz); currentFreqKhz = freqKhz; }
    }
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

  // ======================================================================
  // WSPR + PSK31 panes + hamburger nav — web parity with the mobile app
  // (docs/desktop-handoffs/echocat-web-parity-wspr-psk-menu.md). WSPR is a
  // propagation-beacon mode (no QSO, no cycles UI); PSK31 is a continuous
  // keyboard mode (no cycles, one deliberate Send). Both panes replace the
  // decode table when their mode is selected.
  // ======================================================================
  const wsprPane = document.getElementById('wspr-pane');
  const pskPane = document.getElementById('psk-pane');
  const ft8ControlBar = document.getElementById('ft8-control-bar');

  /** Show/hide the WSPR/PSK panes vs the FT8 decode table for the current mode. */
  function applyDigitalPanes() {
    const wspr = ft8Mode === 'WSPR';
    const psk = ft8Mode === 'PSK31';
    const jtty = ft8Mode === 'JTTY';
    if (wsprPane) { wsprPane.classList.toggle('hidden', !wspr); wsprPane.style.display = wspr ? 'flex' : ''; }
    if (pskPane) { pskPane.classList.toggle('hidden', !psk); pskPane.style.display = psk ? 'flex' : ''; }
    if (jttyPane) { jttyPane.classList.toggle('hidden', !jtty); jttyPane.style.display = jtty ? 'flex' : ''; }
    ft8DecodeLogEl.classList.toggle('hidden', wspr || psk || jtty);
    // The FT8 TX/CQ/auto controls have no meaning in beacon/keyboard modes.
    if (ft8ControlBar) ft8ControlBar.classList.toggle('hidden', wspr || psk || jtty);
    if (wspr) { wsprSeedControls(); wsprStartClock(); } else { wsprStopClock(); }
    if (psk) pskRenderMacros();
    if (jtty) jttySeed();
  }

  // ---------------- WSPR ----------------
  let wsprSpots = [];      // host-enriched, rendered verbatim, cap 300
  let wsprBeaconOn = false; // AUTHORITATIVE state — set only from the host echo
  let wsprClockTimer = null;
  const wsprTxEnable = document.getElementById('wspr-tx-enable');
  const wsprTxPct = document.getElementById('wspr-txpct');
  const wsprTxPctVal = document.getElementById('wspr-txpct-val');
  const wsprDbm = document.getElementById('wspr-dbm');
  const wsprNext = document.getElementById('wspr-next');
  const wsprList = document.getElementById('wspr-list');

  function wsprSeedControls() {
    // Seed TX%/dBm from the host's persisted settings when available.
    if (echoSettings) {
      if (typeof echoSettings.wsprTxPct === 'number') {
        wsprTxPct.value = echoSettings.wsprTxPct;
        wsprTxPctVal.textContent = echoSettings.wsprTxPct + '%';
      }
      if (typeof echoSettings.wsprDbm === 'number') wsprDbm.value = String(Math.min(30, echoSettings.wsprDbm));
    }
  }

  function wsprHandleSpots(msg) {
    if (msg.error) {
      wsprList.innerHTML = '<div class="ft8-empty">' + String(msg.error).replace(/</g, '&lt;') + '</div>';
      return;
    }
    const incoming = Array.isArray(msg.spots) ? msg.spots : [];
    for (const s of incoming) {
      const key = (s.call || '') + '|' + (typeof s.freqMHz === 'number' ? s.freqMHz.toFixed(6) : '');
      const idx = wsprSpots.findIndex((x) => x._key === key);
      if (idx !== -1) wsprSpots.splice(idx, 1);
      wsprSpots.unshift({ ...s, _key: key });
    }
    if (wsprSpots.length > 300) wsprSpots.length = 300; // desktop convention
    wsprRender();
  }

  function wsprRender() {
    if (!wsprList) return;
    if (!wsprSpots.length) {
      wsprList.innerHTML = '<div class="ft8-empty">Listening for WSPR&hellip; spots appear as the host decodes (120s cycles)</div>';
      return;
    }
    const esc = (v) => String(v == null ? '' : v).replace(/</g, '&lt;');
    wsprList.innerHTML = wsprSpots.map((s) =>
      '<div style="display:flex;gap:6px;padding:2px 10px;border-bottom:1px solid var(--border);">' +
      '<span style="width:44px;">' + esc(s.timeUtc) + '</span>' +
      '<span style="width:28px;text-align:right;">' + esc(s.snr) + '</span>' +
      '<span style="width:30px;text-align:right;">' + esc(s.dt) + '</span>' +
      '<span style="width:70px;">' + (typeof s.freqMHz === 'number' ? s.freqMHz.toFixed(4) : '') + '</span>' +
      '<span style="width:24px;text-align:right;">' + esc(s.drift) + '</span>' +
      '<span style="width:70px;font-weight:600;">' + esc(s.call) + '</span>' +
      '<span style="width:44px;">' + esc(s.grid) + '</span>' +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(s.entity) + '</span>' +
      '<span style="width:26px;">' + esc(s.continent) + '</span>' +
      '<span style="width:40px;text-align:right;">' + esc(s.distanceMi) + '</span>' +
      '<span style="width:30px;text-align:right;">' + esc(s.bearing) + '</span>' +
      '</div>').join('');
  }

  function wsprBeaconEcho(msg) {
    // The echo is the truth (arming can fail host-side) — the checkbox
    // renders ONLY from here, never from the local tap.
    wsprBeaconOn = !!msg.enabled;
    if (wsprTxEnable) wsprTxEnable.checked = wsprBeaconOn;
  }

  if (wsprTxEnable) wsprTxEnable.addEventListener('change', () => {
    const wanted = wsprTxEnable.checked;
    wsprTxEnable.checked = wsprBeaconOn; // optimistic-free: revert; the state echo flips it
    ft8Send({ type: 'jtcat-wspr-beacon', enabled: wanted, txPct: parseInt(wsprTxPct.value, 10), dBm: Math.min(30, parseInt(wsprDbm.value, 10)) });
  });
  if (wsprTxPct) wsprTxPct.addEventListener('input', () => {
    wsprTxPctVal.textContent = wsprTxPct.value + '%';
  });
  if (wsprTxPct) wsprTxPct.addEventListener('change', () => {
    ft8Send({ type: 'jtcat-wspr-beacon', txPct: parseInt(wsprTxPct.value, 10) });
  });
  if (wsprDbm) wsprDbm.addEventListener('change', () => {
    ft8Send({ type: 'jtcat-wspr-beacon', dBm: Math.min(30, parseInt(wsprDbm.value, 10)) });
  });

  // 120s cycle phase/countdown — same window math as the popout: the TX
  // window is ~1s..111.6s into the slot, the tail is decode/RX turnaround.
  function wsprTickClock() {
    const cycleMs = 120000;
    const msInto = Date.now() % cycleMs;
    const remaining = Math.ceil((cycleMs - msInto) / 1000);
    const inTxWindow = msInto >= 1000 && msInto < 111600;
    let phase;
    if (wsprBeaconOn && inTxWindow) phase = 'Beacon window';
    else if (inTxWindow) phase = 'RX';
    else phase = 'Decode';
    if (wsprNext) wsprNext.textContent = phase + ' · next cycle in ' + remaining + 's';
  }
  function wsprStartClock() {
    if (wsprClockTimer) return;
    wsprTickClock();
    wsprClockTimer = setInterval(wsprTickClock, 1000);
  }
  function wsprStopClock() {
    if (wsprClockTimer) { clearInterval(wsprClockTimer); wsprClockTimer = null; }
  }

  // ---------------- PSK31 ----------------
  const PSK_RX_CAP = 20000; // chars kept in the RX scrollback (popout parity)
  const PSK_MACRO_SLOTS = 6;
  // Mirrors the popout's defaults — lowercase body text is deliberate (short
  // varicode); used when settings.pskMacros is absent from the blob.
  const PSK_DEFAULT_MACROS = [
    { label: 'CQ',   text: 'CQ CQ CQ de $MYCALL $MYCALL $MYCALL pse K\n' },
    { label: 'Call', text: '$CALL $CALL de $MYCALL $MYCALL $MYCALL K\n' },
    { label: 'Exch', text: '$CALL de $MYCALL  UR RSQ 599 599  QTH grid $GRID $GRID  BTU $CALL de $MYCALL K\n' },
    { label: 'Brag', text: '$CALL de $MYCALL  rig [RIG] es [WATTS]w to [ANTENNA]  op [NAME] QTH [TOWN]  hw cpy? $CALL de $MYCALL K\n' },
    { label: '73',   text: '$CALL de $MYCALL  TNX FER QSO 73 73  sk\n' },
    { label: 'Txt',  text: '' },
  ];
  const pskRxEl = document.getElementById('psk-rx');
  const pskTxEl = document.getElementById('psk-tx');
  const pskTheirEl = document.getElementById('psk-their');
  const pskMacrosEl = document.getElementById('psk-macros');
  const pskChipsEl = document.getElementById('psk-chips');
  const pskFreqEl = document.getElementById('psk-freq');
  const pskQualityEl = document.getElementById('psk-quality');
  let pskChipScanTimer = null;

  function pskNormalizeMacros(saved) {
    const src = Array.isArray(saved) && saved.length ? saved : null;
    const out = [];
    for (let i = 0; i < PSK_MACRO_SLOTS; i++) {
      const m = src ? src[i] : PSK_DEFAULT_MACROS[i];
      if (m && typeof m.label === 'string' && m.label.trim()) {
        out.push({ label: m.label.trim().slice(0, 8), text: String(m.text == null ? '' : m.text) });
      } else {
        out.push(src ? { label: 'M' + (i + 1), text: '' } : PSK_DEFAULT_MACROS[i]);
      }
    }
    return out;
  }

  function pskSubstituteMacro(text) {
    // $CALL: the PSK "their call" box first (it is the mode's own entry
    // field), then the log form — same rule as CW's {call}.
    let their = (pskTheirEl && pskTheirEl.value ? pskTheirEl.value : '').toUpperCase().trim();
    if (!their) their = (logCall && logCall.value ? logCall.value : '').trim().toUpperCase();
    return String(text || '')
      .replace(/\$MYCALL/g, myCallsign || '')
      .replace(/\$GRID/g, (phoneGrid || '').substring(0, 4))
      .replace(/\$CALL/g, their);
  }

  // Macro editor — the desktop pane's: long-press / right-click a macro, an
  // empty slot opens it on a tap; Save writes all six (settings.pskMacros,
  // the key the desktop pop-out reads), Reset all = the defaults.
  const pskMacroEditor = document.getElementById('psk-macro-editor');
  const pskMeLabel = document.getElementById('psk-me-label');
  const pskMeText = document.getElementById('psk-me-text');
  let pskEditIdx = -1;
  function pskOpenMacroEditor(i) {
    if (!pskMacroEditor) return;
    const defs = pskNormalizeMacros(echoSettings && echoSettings.pskMacros);
    pskEditIdx = i;
    pskMeLabel.value = defs[i].label;
    pskMeText.value = defs[i].text.replace(/\n$/, '');
    pskMacroEditor.classList.remove('hidden');
    pskMacroEditor.style.display = 'flex';
    pskMeText.focus();
  }
  function pskCloseMacroEditor() {
    pskEditIdx = -1;
    if (pskMacroEditor) { pskMacroEditor.classList.add('hidden'); pskMacroEditor.style.display = 'none'; }
  }
  function pskSaveMacros(list) {
    if (!echoSettings) echoSettings = {};
    echoSettings.pskMacros = list;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'save-settings', settings: { pskMacros: list } }));
    pskRenderMacros();
  }
  const pskMeSave = document.getElementById('psk-me-save');
  if (pskMeSave) pskMeSave.addEventListener('click', () => {
    if (pskEditIdx < 0) return;
    const defs = pskNormalizeMacros(echoSettings && echoSettings.pskMacros);
    const label = pskMeLabel.value.trim().slice(0, 8) || ('M' + (pskEditIdx + 1));
    const body = pskMeText.value.replace(/\s+$/, '');
    defs[pskEditIdx] = { label, text: body ? body + '\n' : '' };
    pskSaveMacros(defs);
    pskCloseMacroEditor();
  });
  const pskMeCancel = document.getElementById('psk-me-cancel');
  if (pskMeCancel) pskMeCancel.addEventListener('click', pskCloseMacroEditor);
  const pskMeReset = document.getElementById('psk-me-reset');
  if (pskMeReset) pskMeReset.addEventListener('click', () => { pskSaveMacros(null); pskCloseMacroEditor(); });

  function pskRenderMacros() {
    if (!pskMacrosEl) return;
    const defs = pskNormalizeMacros(echoSettings && echoSettings.pskMacros);
    pskMacrosEl.innerHTML = '';
    defs.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ft8-ctrl-btn';
      btn.style.fontSize = '11px';
      btn.textContent = m.label;
      btn.title = m.text ? m.text.trim().slice(0, 120) : 'Empty - tap to write a macro';
      if (!m.text) btn.style.opacity = '0.55';
      // Long-press (touch) or right-click edits; a tap on an empty slot too.
      let pressTimer = null;
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); pskOpenMacroEditor(i); });
      btn.addEventListener('touchstart', () => { pressTimer = setTimeout(() => { pressTimer = 'fired'; pskOpenMacroEditor(i); }, 550); }, { passive: true });
      btn.addEventListener('touchend', () => { if (pressTimer && pressTimer !== 'fired') clearTimeout(pressTimer); });
      btn.addEventListener('click', () => {
        if (pressTimer === 'fired') { pressTimer = null; return; }
        if (!m.text) { pskOpenMacroEditor(i); return; }
        // Insert the substituted text at the cursor (popout parity).
        const sub = pskSubstituteMacro(m.text);
        const start = pskTxEl.selectionStart == null ? pskTxEl.value.length : pskTxEl.selectionStart;
        const end = pskTxEl.selectionEnd == null ? start : pskTxEl.selectionEnd;
        pskTxEl.value = pskTxEl.value.slice(0, start) + sub + pskTxEl.value.slice(end);
        pskTxEl.focus();
      });
      pskMacrosEl.appendChild(btn);
    });
  }

  function pskHandleRx(msg) {
    if (!pskRxEl || !msg.chars) return;
    const nearBottom = pskRxEl.scrollHeight - pskRxEl.scrollTop - pskRxEl.clientHeight < 40;
    pskRxEl.textContent = (pskRxEl.textContent + msg.chars).slice(-PSK_RX_CAP);
    if (nearBottom || msg.replay) pskRxEl.scrollTop = pskRxEl.scrollHeight;
    if (msg.freqHz != null && pskFreqEl) pskFreqEl.textContent = 'AFC: ' + Math.round(msg.freqHz) + ' Hz';
    if (pskQualityEl && (msg.metric != null || msg.snrDb != null)) {
      pskQualityEl.textContent = 'Q ' + (msg.metric != null ? Math.round(msg.metric) : '--') +
        ' · SNR ' + (msg.snrDb != null ? Math.round(msg.snrDb) + ' dB' : '--');
    }
    // Callsign capture — debounced scan of the RX tail (replay included:
    // chips are passive affordances, not notifications).
    if (pskChipScanTimer) clearTimeout(pskChipScanTimer);
    pskChipScanTimer = setTimeout(pskScanCallsigns, 500);
  }

  const pskClearBtn = document.getElementById('psk-clear');
  if (pskClearBtn) pskClearBtn.addEventListener('click', () => {
    if (pskRxEl) pskRxEl.textContent = '';
    if (pskChipsEl) { pskChipsEl.innerHTML = ''; pskChipsEl.style.display = 'none'; }
  });
  // Tune / ATU: the pane hides the FT8 controls bar, so it carries its own,
  // as the desktop JTTY/PSK31 panes do.
  const pskTuneBtn = document.getElementById('psk-tune');
  if (pskTuneBtn) pskTuneBtn.addEventListener('click', () => ft8Send({ type: 'jtcat-tune-toggle' }));
  const pskAtuBtn = document.getElementById('psk-atu');
  if (pskAtuBtn) pskAtuBtn.addEventListener('click', () => { if (rcAtuBtn) rcAtuBtn.click(); });

  function pskScanCallsigns() {
    if (!pskChipsEl || !pskRxEl) return;
    // Mobile's rule: 3-10 chars of [A-Z0-9/], must contain a letter AND a
    // digit, scanned over the last ~800 chars of the RX stream.
    const tail = pskRxEl.textContent.slice(-800).toUpperCase();
    const seen = [];
    const re = /[A-Z0-9/]{3,10}/g;
    let m;
    while ((m = re.exec(tail)) !== null) {
      const tok = m[0];
      if (!/[A-Z]/.test(tok) || !/[0-9]/.test(tok)) continue;
      if (myCallsign && tok === myCallsign.toUpperCase()) continue;
      if (!seen.includes(tok)) seen.push(tok);
    }
    const chips = seen.slice(-6);
    pskChipsEl.style.display = chips.length ? 'flex' : 'none';
    pskChipsEl.innerHTML = '';
    chips.forEach((call) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ft8-ctrl-btn';
      chip.style.cssText = 'font-size:11px;padding:1px 8px;border-radius:10px;';
      chip.textContent = call;
      chip.title = 'Set as their call and open logging pre-filled';
      chip.addEventListener('click', () => {
        if (pskTheirEl) pskTheirEl.value = call;
        openLogSheet({ callsign: call, mode: 'PSK31' }); // dial freq: see openLogSheet
      });
      pskChipsEl.appendChild(chip);
    });
  }

  function pskAppendTxEcho(text) {
    // fldigi/DigiPan convention (and the popout's): your own transmitted
    // text appears in the RX stream in red so the QSO reads as one thread.
    if (!pskRxEl) return;
    const span = document.createElement('span');
    span.className = 'p-tx-echo';
    span.textContent = text.endsWith(String.fromCharCode(10)) ? text : text + String.fromCharCode(10);
    pskRxEl.appendChild(span);
    pskRxEl.scrollTop = pskRxEl.scrollHeight;
  }
  const pskSendBtn = document.getElementById('psk-send');
  if (pskSendBtn) pskSendBtn.addEventListener('click', () => {
    const text = pskTxEl.value; // VERBATIM — varicode is case-sensitive,
    if (!text) return;          // lowercase is the on-air convention.
    ft8Send({ type: 'jtcat-psk-send', text });
    pskAppendTxEcho(text);
    pskTxEl.value = '';
  });
  // Squelch — hydrates from the settings blob, live-applies via the same
  // clamp+persist path as the popout slider.
  const pskSqlEl = document.getElementById('psk-sql');
  const pskSqlVal = document.getElementById('psk-sql-val');
  if (pskSqlEl) {
    pskSqlEl.addEventListener('input', () => {
      if (pskSqlVal) pskSqlVal.textContent = pskSqlEl.value;
      ft8Send({ type: 'jtcat-psk-set-sql', value: parseInt(pskSqlEl.value, 10) || 50 });
    });
  }
  const pskStopBtn = document.getElementById('psk-stop');
  if (pskStopBtn) pskStopBtn.addEventListener('click', () => {
    ft8Send({ type: 'jtcat-halt-tx' });
  });
  const pskLogBtn = document.getElementById('psk-log');
  if (pskLogBtn) pskLogBtn.addEventListener('click', () => {
    openLogSheet({
      callsign: (pskTheirEl && pskTheirEl.value ? pskTheirEl.value : '').toUpperCase().trim(),
      mode: 'PSK31',
      // No freqKhz — see the invariant in openLogSheet.
    });
  });

  // ---------------- JTTY ----------------
  // Web parity with the popout's JTTY pane (renderer/jtcat-popout.js). The
  // host owns packing and refusal; this pane renders message rows, composes
  // from WSJT-X's eight templates, and sends one line. The one rule the web
  // can check itself is the grammar's 80 characters (the counter under the
  // composer); everything else comes back as jtcat-jtty-refused.
  const jttyPane = document.getElementById('jtty-pane');
  const jttyListEl = document.getElementById('jtty-list');
  const jttyTxEl = document.getElementById('jtty-tx');
  const jttyNoteEl = document.getElementById('jtty-note');
  const jttyProfileEl = document.getElementById('jtty-profile');
  const jttyHisEl = document.getElementById('jtty-his');
  const jttyExchEl = document.getElementById('jtty-exch');
  const jttySerialEl = document.getElementById('jtty-serial');
  const jttyQueuedEl = document.getElementById('jtty-queued');
  const jttyTemplatesEl = document.getElementById('jtty-templates');
  const jttyStyleEl = document.getElementById('jtty-style');
  const jttyRptEl = document.getElementById('jtty-rpt');
  const JTTY_ROW_CAP = 200;
  // Per sender (JttyMacros.senderOf): the SNR measured on them (their %R),
  // their grid, and the report they gave us — the FT8 style's Log prefill.
  const jttySnrByCall = {};
  const jttyGridByCall = {};
  const jttyRcvdRptByCall = {};
  // Frequency etiquette (lib/jtty-macros.js), as the pop-out: tapping a CQ or
  // a station working someone else moves onto them; a station calling us
  // never moves us; Hold TX (the desktop's setting) freezes it. jttyOcc is a
  // ~30 s running average of the spectrum the desktop streams, for Clear spot.
  let jttyHoldTx = false;
  let jttyOcc = null;
  let jttyOccMs = 0;
  let jttyOccLastTs = 0;
  function jttySetHold(on) {
    jttyHoldTx = !!on;
    const b = document.getElementById('jtty-hold');
    if (b) b.classList.toggle('active', jttyHoldTx);
  }
  function jttyFeedSpectrum(bins) {
    if (ft8Mode !== 'JTTY' || ft8Transmitting || !bins || !bins.length) return;
    const now = Date.now();
    const dt = jttyOccLastTs ? Math.min(1000, now - jttyOccLastTs) : 0;
    jttyOccLastTs = now;
    jttyOcc = JttyMacros.accumulateLevels(jttyOcc, bins, dt / 30000);
    jttyOccMs += dt;
  }
  function jttyMoveTo(hz, note) {
    const f = Math.max(JttyMacros.TONE_MIN, Math.min(JttyMacros.TONE_MAX, Math.round(Number(hz) || 0)));
    if (!f) return;
    ft8TxFreqHz = f;
    if (ft8TxFreqDisplay) ft8TxFreqDisplay.textContent = 'TX: ' + f + ' Hz';
    ft8Send({ type: 'jtcat-set-tx-freq', hz: f });
    // The desktop restores the JTTY audio frequency from this on reopen.
    ft8Send({ type: 'save-settings', settings: { jttyAudioFreq: f } });
    if (note) jttyNote(note.replace('%F', String(f)), false);
  }
  const JTTY_PROFILES = ['unknown', 'field-day', 'rtty-roundup'];
  const jttyRows = {};           // decoder message id -> row element
  let jttyComposeNative = -1;    // macro index that filled the composer; -1 = typed/edited
  let jttySeeded = false;

  function jttyPad2(n) { return (n < 10 ? '0' : '') + n; }
  // Macros {label, text, key} — lib/jtty-macros.js, inlined by remote-server
  // as window.JttyMacros; the desktop owns the lists (settings.jttyFt8Macros
  // for the FT8 style, the default, and settings.jttyMacros for Contest).
  function jttyStyle() { return JttyMacros.styleOf((echoSettings || {}).jttyMacroStyle); }
  function jttyMacros() {
    return JttyMacros.forSettings(echoSettings || {}).macros;
  }
  function jttyApplyStyle() {
    const ft8 = jttyStyle() === 'ft8';
    if (jttyStyleEl) jttyStyleEl.value = jttyStyle();
    if (jttyPane) {
      jttyPane.querySelectorAll('.jtty-contest-only').forEach((el) => { el.style.display = ft8 ? 'none' : ''; });
      jttyPane.querySelectorAll('.jtty-ft8-only').forEach((el) => { el.style.display = ft8 ? '' : 'none'; });
    }
  }
  // The report follows the SNR measured on Their Call until one is typed.
  function jttyRefreshReport(force) {
    if (!jttyRptEl) return;
    if (!force && jttyRptEl.dataset.auto === '0') return;
    const his = String((jttyHisEl && jttyHisEl.value) || '').trim().toUpperCase();
    jttyRptEl.value = his && jttySnrByCall[his] != null ? JttyMacros.formatReport(jttySnrByCall[his]) : '';
    jttyRptEl.dataset.auto = '1';
  }
  /** A settings-update carried JTTY keys: redraw from the merged blob. */
  function jttyOnSettings(changed) {
    if (changed && parseInt(changed.jttySerial, 10) > 0 && jttySerialEl && document.activeElement !== jttySerialEl) {
      jttySerialEl.value = String(parseInt(changed.jttySerial, 10));
      jttyRefreshExchange(false);
    }
    if (changed && JTTY_PROFILES.includes(changed.jttyProfile) && jttyProfileEl) jttyProfileEl.value = changed.jttyProfile;
    if (changed && 'jttyMacroStyle' in changed) jttyComposeNative = -1;
    jttyApplyStyle();
    jttyRenderTemplates();
  }
  function jttyProfile() {
    const p = jttyProfileEl ? jttyProfileEl.value : 'unknown';
    return JTTY_PROFILES.includes(p) ? p : 'unknown';
  }
  function jttySerial() {
    const n = parseInt(jttySerialEl && jttySerialEl.value, 10);
    return Math.max(1, Math.min(9999, n > 0 ? n : 1));
  }
  function jttyDefaultExchange() {
    if (jttyProfile() === 'field-day') return String((echoSettings && echoSettings.jtcatFdExch) || '').trim().toUpperCase();
    const n = jttySerial();
    return '599 ' + (n < 100 ? ('00' + n).slice(-3) : String(n));
  }
  function jttyRefreshExchange(force) {
    if (!jttyExchEl) return;
    if (force || jttyExchEl.dataset.auto !== '0') { jttyExchEl.value = jttyDefaultExchange(); jttyExchEl.dataset.auto = '1'; }
  }
  function jttySubstitute(t) {
    const n = jttySerial();
    return JttyMacros.substitute(t, {
      myCall: myCallsign || '',
      theirCall: (jttyHisEl && jttyHisEl.value) || '',
      nextCall: (jttyQueuedEl && jttyQueuedEl.value) || '',
      exchange: (jttyExchEl && jttyExchEl.value) || '',
      grid: (echoSettings && echoSettings.grid) || '',
      serial: n < 100 ? ('00' + n).slice(-3) : String(n),
      report: (jttyRptEl && jttyRptEl.value) || '',
    });
  }
  // Same rule as the popout: a macro whose text is one of WSJT-X's eight,
  // with %E, under the Serial profile packs its exchange as a native serial
  // (rtty-roundup rules, one frame fewer); any other text is literal under
  // the operator's profile. Per message — never moves the selector.
  function jttyPackProfile() {
    if (jttyStyle() === 'ft8') return 'unknown'; // picker hidden: no unseen contest profile
    const p = jttyProfile();
    const m = jttyComposeNative >= 0 ? jttyMacros()[jttyComposeNative] : null;
    if (jttyStyle() === 'contest' && p === 'unknown' && m && JttyMacros.isNativeText(m.text) && /%E/.test(m.text)) return 'rtty-roundup';
    return p;
  }
  function jttyNote(text, bad) {
    if (!jttyNoteEl) return;
    jttyNoteEl.textContent = text;
    jttyNoteEl.style.color = bad ? '#e94560' : '';
  }
  function jttyCount() {
    if (!jttyTxEl) return;
    const n = jttyTxEl.value.trim().replace(/\s+/g, ' ').length;
    jttyNote(n + '/80', n > 80);
  }
  function jttyShowRefused(msg) {
    jttyNote((msg && msg.reason) || 'refused', true);
  }
  function jttySend() {
    if (!jttyTxEl) return;
    const text = jttyTxEl.value;
    const n = text.trim().replace(/\s+/g, ' ').length;
    if (!n || ft8Transmitting) return;
    if (n > 80) { jttyNote(n + ' characters — JTTY carries at most 80 in one message', true); return; }
    ft8Send({ type: 'jtcat-jtty-send', text, profile: jttyPackProfile() });
  }
  function jttyUseTemplate(i, send) {
    const m = jttyMacros()[i];
    if (!m || !jttyTxEl) return;
    const need = JttyMacros.needs(m.text);
    if (need.theirCall && !String((jttyHisEl && jttyHisEl.value) || '').trim()) { if (jttyHisEl) jttyHisEl.focus(); jttyNote('Tap a decoded row or type Their Call first', true); return; }
    if (need.nextCall && !String((jttyQueuedEl && jttyQueuedEl.value) || '').trim()) { if (jttyQueuedEl) jttyQueuedEl.focus(); jttyNote('Type the next call first', true); return; }
    if (need.grid && !String((echoSettings && echoSettings.grid) || '').trim()) { jttyNote('Set your grid in the desktop Settings first', true); return; }
    if (need.report && !String((jttyRptEl && jttyRptEl.value) || '').trim()) { if (jttyRptEl) jttyRptEl.focus(); jttyNote('No report yet: tap their row, or type one', true); return; }
    jttyTxEl.value = jttySubstitute(m.text);
    jttyComposeNative = i;
    jttyCount();
    if (send) jttySend();
  }
  function jttyRenderTemplates() {
    if (!jttyTemplatesEl) return;
    jttyTemplatesEl.innerHTML = '';
    jttyMacros().forEach((m, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ft8-ctrl-btn';
      btn.style.cssText = 'font-size:11px;padding:2px 8px;font-weight:700;';
      btn.textContent = m.label;
      if (m.key) {
        const k = document.createElement('span');
        k.style.cssText = 'font-size:9px;font-weight:400;opacity:0.65;margin-left:5px;font-family:monospace;';
        k.textContent = m.key;
        btn.appendChild(k);
      }
      btn.title = m.text + ' → ' + (jttySubstitute(m.text) || '(empty)') + '. Hold Shift to send at once. Edit macros in the desktop JTCAT window.';
      btn.addEventListener('click', (e) => jttyUseTemplate(i, e.shiftKey));
      jttyTemplatesEl.appendChild(btn);
    });
  }
  function jttyAtBottom() { return jttyListEl.scrollHeight - jttyListEl.scrollTop - jttyListEl.clientHeight < 40; }
  function jttyPrune() {
    while (jttyListEl.children.length > JTTY_ROW_CAP) {
      const first = jttyListEl.firstChild;
      if (first.dataset && first.dataset.id) delete jttyRows[first.dataset.id];
      jttyListEl.removeChild(first);
    }
  }
  function jttyMakeRow() {
    const row = document.createElement('div');
    row.className = 'ft8-decode-line';
    row.style.cssText = 'display:flex;gap:8px;padding:2px 10px;font-family:monospace;font-size:12px;cursor:pointer;';
    row.innerHTML = '<span class="j-time" style="color:var(--text-dim);min-width:60px;"></span><span class="j-db" style="min-width:28px;text-align:right;"></span><span class="j-df" style="min-width:36px;text-align:right;color:var(--text-dim);"></span><span class="j-msg" style="flex:1;word-break:break-word;"></span>';
    return row;
  }
  function jttyPickCall(text) {
    const my = String(myCallsign || '').toUpperCase().trim();
    for (const raw of String(text).toUpperCase().split(/\s+/)) {
      const w = raw.replace(/[^A-Z0-9/]/g, '');
      if (w && w !== my && w !== 'CQ' && /^[A-Z0-9/]{3,10}$/.test(w) && /\d/.test(w) && /[A-Z]/.test(w) && !/^\d+$/.test(w)) {
        if (jttyHisEl) jttyHisEl.value = w;
        jttyRefreshReport(true);
        jttyRenderTemplates();
        return;
      }
    }
  }
  function jttyApplyUpdate(u, replay) {
    if (!jttyListEl || !u || u.id == null) return;
    const pinned = jttyAtBottom();
    if (u.marker) {
      // Idle JTTY changed band at sunrise/sunset: a divider, not a decode.
      if (jttyRows[u.id]) return;
      const m = document.createElement('div');
      m.dataset.id = String(u.id);
      m.style.cssText = 'text-align:center;color:var(--accent-blue,#4fc3f7);border-top:1px solid currentColor;border-bottom:1px solid currentColor;margin:4px 0;padding:2px 0;font-weight:bold;';
      const d = new Date(u.utcMs || Date.now());
      m.textContent = jttyPad2(d.getUTCHours()) + ':' + jttyPad2(d.getUTCMinutes()) + 'Z  ' + u.text;
      jttyListEl.appendChild(m);
      jttyRows[u.id] = m;
      jttyPrune();
      if (pinned || replay) jttyListEl.scrollTop = jttyListEl.scrollHeight;
      return;
    }
    let row = jttyRows[u.id];
    if (!row) {
      row = jttyMakeRow();
      row.dataset.id = String(u.id);
      row.addEventListener('click', () => {
        const text = row.dataset.text || '';
        jttyPickCall(text);
        if (row.dataset.freq && JttyMacros.shouldFollowStation(text, String(myCallsign || ''), jttyHoldTx)) {
          jttyMoveTo(row.dataset.freq, 'On their freq: %F Hz');
        }
      });
      jttyListEl.appendChild(row);
      jttyRows[u.id] = row;
      jttyPrune();
    }
    const d = new Date(u.utcMs || Date.now());
    row.querySelector('.j-time').textContent = jttyPad2(d.getUTCHours()) + ':' + jttyPad2(d.getUTCMinutes()) + ':' + jttyPad2(d.getUTCSeconds());
    row.querySelector('.j-db').textContent = (u.snrDb > 0 ? '+' : '') + u.snrDb;
    row.querySelector('.j-df').textContent = String(Math.round(u.freqHz));
    const msgEl = row.querySelector('.j-msg');
    msgEl.textContent = u.text + (u.complete ? '' : ' …');
    msgEl.style.fontStyle = u.complete ? '' : 'italic';
    msgEl.style.color = u.complete ? '' : 'var(--text-dim)';
    row.dataset.text = u.text || '';
    if (u.freqHz > 0) row.dataset.freq = String(Math.round(u.freqHz));
    const up = String(u.text || '').toUpperCase();
    const my = String(myCallsign || '').toUpperCase().trim();
    const sender = JttyMacros.senderOf(u.text);
    if (sender) {
      if (typeof u.snrDb === 'number') jttySnrByCall[sender] = u.snrDb;
      const g = JttyMacros.gridOf(u.text);
      if (g) jttyGridByCall[sender] = g;
      const r = JttyMacros.reportTo(u.text, my);
      if (r) jttyRcvdRptByCall[sender] = r;
      if (sender === String((jttyHisEl && jttyHisEl.value) || '').trim().toUpperCase()) jttyRefreshReport(false);
    }
    const directed = !!my && (' ' + up + ' ').indexOf(' ' + my + ' ') >= 0;
    row.style.background = directed ? 'rgba(180,30,30,0.22)' : /^CQ\b/.test(up) ? 'rgba(0,120,0,0.25)' : '';
    row.style.borderLeft = directed ? '3px solid #e94560' : '';
    if (pinned || replay) jttyListEl.scrollTop = jttyListEl.scrollHeight;
  }
  let jttyEpoch = 0; // the engine the on-screen rows belong to; ids restart with each engine
  function jttyClearRows() {
    if (jttyListEl) jttyListEl.innerHTML = '';
    for (const k of Object.keys(jttyRows)) delete jttyRows[k];
  }
  function jttyHandleRx(msg) {
    if (!msg || !Array.isArray(msg.updates)) return;
    if (msg.epoch && msg.epoch !== jttyEpoch) { jttyClearRows(); jttyEpoch = msg.epoch; }
    msg.updates.forEach((u) => jttyApplyUpdate(u, !!msg.replay));
  }
  function jttyOnTxStatus(msg) {
    if (!jttyListEl) return;
    if (msg.state === 'tx' && msg.message) {
      const pinned = jttyAtBottom();
      const row = jttyMakeRow();
      row.style.opacity = '0.75';
      const d = new Date();
      row.querySelector('.j-time').textContent = jttyPad2(d.getUTCHours()) + ':' + jttyPad2(d.getUTCMinutes()) + ':' + jttyPad2(d.getUTCSeconds());
      const db = row.querySelector('.j-db'); db.textContent = 'TX'; db.style.color = '#e94560';
      row.querySelector('.j-df').textContent = String(msg.txFreq || ft8TxFreqHz || '');
      row.querySelector('.j-msg').textContent = msg.message;
      jttyListEl.appendChild(row);
      jttyPrune();
      if (pinned) jttyListEl.scrollTop = jttyListEl.scrollHeight;
      jttyNote('Sending…', false);
    } else if (msg.state !== 'tx') {
      jttyCount();
    }
  }
  /** Seed the pane from the settings blob the first time (and whenever the mode lands on JTTY). */
  function jttySeed() {
    if (!jttyPane) return;
    if (!jttySeeded && echoSettings) {
      jttySeeded = true;
      if (jttyProfileEl && JTTY_PROFILES.includes(echoSettings.jttyProfile)) jttyProfileEl.value = echoSettings.jttyProfile;
      if (jttySerialEl && parseInt(echoSettings.jttySerial, 10) > 0) jttySerialEl.value = String(parseInt(echoSettings.jttySerial, 10));
      jttyRefreshExchange(true);
    }
    jttyApplyStyle();
    jttyRenderTemplates();
    jttyCount();
  }
  if (jttyStyleEl) jttyStyleEl.addEventListener('change', () => {
    const style = JttyMacros.styleOf(jttyStyleEl.value);
    // The desktop keeps the style (settings.jttyMacroStyle), like the serial.
    echoSettings = Object.assign(echoSettings || {}, { jttyMacroStyle: style });
    jttyComposeNative = -1;
    jttyApplyStyle();
    jttyRenderTemplates();
    ft8Send({ type: 'save-settings', settings: { jttyMacroStyle: style } });
  });
  if (jttyRptEl) jttyRptEl.addEventListener('input', () => { jttyRptEl.dataset.auto = jttyRptEl.value.trim() ? '0' : '1'; jttyRenderTemplates(); });
  if (jttyProfileEl) jttyProfileEl.addEventListener('change', () => {
    ft8Send({ type: 'jtcat-jtty-set-profile', profile: jttyProfile() });
    jttyRefreshExchange(true);
    jttyRenderTemplates();
  });
  function jttySerialChanged() {
    if (jttySerialEl) jttySerialEl.value = String(jttySerial());
    jttyRefreshExchange(true);
    jttyRenderTemplates();
    // The desktop keeps the serial (settings.jttySerial) — one number per station, not per screen.
    ft8Send({ type: 'save-settings', settings: { jttySerial: jttySerial() } });
  }
  if (jttySerialEl) jttySerialEl.addEventListener('change', jttySerialChanged);
  const jttyUp = document.getElementById('jtty-serial-up');
  const jttyDn = document.getElementById('jtty-serial-dn');
  if (jttyUp) jttyUp.addEventListener('click', () => { jttySerialEl.value = String(jttySerial() + 1); jttySerialChanged(); });
  if (jttyDn) jttyDn.addEventListener('click', () => { jttySerialEl.value = String(jttySerial() - 1); jttySerialChanged(); });
  if (jttyExchEl) jttyExchEl.addEventListener('input', () => { jttyExchEl.dataset.auto = '0'; jttyRenderTemplates(); });
  if (jttyHisEl) jttyHisEl.addEventListener('input', () => { jttyRefreshReport(false); jttyRenderTemplates(); });
  if (jttyQueuedEl) jttyQueuedEl.addEventListener('input', jttyRenderTemplates);
  if (jttyTxEl) {
    jttyTxEl.addEventListener('input', () => { jttyComposeNative = -1; jttyCount(); });
    jttyTxEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jttySend(); } });
  }
  const jttySendBtn = document.getElementById('jtty-send');
  if (jttySendBtn) jttySendBtn.addEventListener('click', jttySend);
  const jttyStopBtn = document.getElementById('jtty-stop');
  if (jttyStopBtn) jttyStopBtn.addEventListener('click', () => ft8Send({ type: 'jtcat-halt-tx' }));
  const jttyLogBtn = document.getElementById('jtty-log');
  if (jttyLogBtn) jttyLogBtn.addEventListener('click', () => {
    const his = String((jttyHisEl && jttyHisEl.value) || '').toUpperCase().trim();
    // FT8 style: the report we sent and the one they gave us. Contest style
    // leaves both to the sheet's 599 default.
    const ft8 = jttyStyle() === 'ft8';
    openLogSheet({
      callsign: his,
      mode: 'JTTY',
      rstSent: ft8 ? String((jttyRptEl && jttyRptEl.value) || '').trim() : '',
      rstRcvd: ft8 ? (jttyRcvdRptByCall[his] || '') : '',
      // No freqKhz — see the invariant in openLogSheet.
    });
  });
  const jttyClearBtn = document.getElementById('jtty-clear');
  if (jttyClearBtn) jttyClearBtn.addEventListener('click', jttyClearRows);
  const jttyClearSpotBtn = document.getElementById('jtty-clearspot');
  if (jttyClearSpotBtn) jttyClearSpotBtn.addEventListener('click', () => {
    if (!jttyOcc || jttyOccMs < 5000) { jttyNote('Listening, try again shortly', false); return; }
    // The streamed spectrum spans 0-3000 Hz, like the waterfall it draws.
    const spot = JttyMacros.clearestSpot(jttyOcc, 3000 / jttyOcc.length, { prefer: ft8TxFreqHz });
    if (!spot) { jttyNote('No audio to measure yet', false); return; }
    jttyMoveTo(spot.hz, spot.hz === ft8TxFreqHz ? 'Already quietest (%F Hz)' : 'Quietest spot: %F Hz');
  });
  const jttyHoldBtn = document.getElementById('jtty-hold');
  if (jttyHoldBtn) jttyHoldBtn.addEventListener('click', () => {
    jttySetHold(!jttyHoldTx);
    ft8Send({ type: 'jtcat-set-hold-tx-freq', enabled: jttyHoldTx });
  });

  // ---------------- Hamburger nav (mobile TabMenu parity) ----------------
  // One nav, one order: the user's tab order drives BOTH the bar and the
  // menu. Order persists client-side; the repair rule on load (drop unknown
  // ids/dupes, append missing in default order) means a future release that
  // adds a tab SURFACES it instead of a stale saved order hiding it.
  const TAB_DEFS = [
    { id: 'spots',    menuLabel: 'Spots' },
    { id: 'map',      menuLabel: 'Map' },
    { id: 'log',      menuLabel: 'Log' },
    { id: 'logbook',  menuLabel: 'Logbook' },
    { id: 'activate', menuLabel: 'Activate' },
    { id: 'ft8',      menuLabel: 'FT8 / Digital' },
    { id: 'dir',      menuLabel: 'Directory' },
    { id: 'sstv',     menuLabel: 'SSTV' },
  ];
  const TAB_ORDER_KEY = 'echocat-tab-order';
  const NAV_MODE_KEY = 'echocat-hamburger';
  const menuBtn = document.getElementById('menu-btn');
  const tabMenuPanel = document.getElementById('tab-menu-panel');

  function normalizeTabOrder(saved) {
    const known = TAB_DEFS.map((t) => t.id);
    const out = [];
    if (Array.isArray(saved)) {
      for (const id of saved) {
        if (known.includes(id) && !out.includes(id)) out.push(id);
      }
    }
    for (const id of known) if (!out.includes(id)) out.push(id);
    return out;
  }

  function loadTabOrder() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) || 'null'); } catch {}
    return normalizeTabOrder(saved);
  }

  function saveTabOrder(order) {
    try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order)); } catch {}
  }

  /** Reorder the tab BAR buttons to match — one order drives both surfaces. */
  function applyTabOrder(order) {
    for (const id of order) {
      const btn = tabBar.querySelector('.tab[data-tab="' + id + '"]');
      if (btn) tabBar.appendChild(btn);
    }
  }

  function navMenuEnabled() {
    try { return localStorage.getItem(NAV_MODE_KEY) === '1'; } catch { return false; }
  }

  function applyNavMode() {
    const menuMode = navMenuEnabled();
    if (menuBtn) menuBtn.classList.toggle('hidden', !menuMode);
    // Only hide the bar when authenticated UI is visible; auth reveal calls
    // this again so the setting wins after connect too.
    if (menuMode) tabBar.classList.add('hidden');
    else if (!mainUI.classList.contains('hidden')) tabBar.classList.remove('hidden');
    const tabsBtn = document.getElementById('so-nav-tabs');
    const menuModeBtn = document.getElementById('so-nav-menu');
    if (tabsBtn) tabsBtn.classList.toggle('active', !menuMode);
    if (menuModeBtn) menuModeBtn.classList.toggle('active', menuMode);
    if (!menuMode && tabMenuPanel) tabMenuPanel.classList.add('hidden');
  }

  function renderTabMenu() {
    if (!tabMenuPanel) return;
    const order = loadTabOrder();
    applyTabOrder(order);
    tabMenuPanel.innerHTML = '';
    const dirHidden = (() => { const b = document.getElementById('dir-tab-btn'); return b ? b.classList.contains('hidden') : true; })();
    order.forEach((id, i) => {
      const def = TAB_DEFS.find((t) => t.id === id);
      if (!def) return;
      if (id === 'dir' && dirHidden) return; // same gating as the bar
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:2px;';
      const item = document.createElement('button');
      item.type = 'button';
      item.style.cssText = 'flex:1;text-align:left;background:none;border:none;color:var(--text);font-size:14px;padding:9px 10px;cursor:pointer;border-radius:6px;';
      item.textContent = def.menuLabel;
      if (typeof activeTab !== 'undefined' && activeTab === id) item.style.fontWeight = '700';
      item.addEventListener('click', () => {
        tabMenuPanel.classList.add('hidden');
        switchTab(id);
      });
      row.appendChild(item);
      // Reorder handles — the persisted order drives bar AND menu.
      const mk = (glyph, delta, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = title;
        b.style.cssText = 'background:none;border:none;color:var(--text-dim);font-size:12px;padding:6px;cursor:pointer;';
        b.textContent = glyph;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const ord = loadTabOrder();
          const from = ord.indexOf(id);
          const to = from + delta;
          if (from < 0 || to < 0 || to >= ord.length) return;
          ord.splice(from, 1);
          ord.splice(to, 0, id);
          saveTabOrder(ord);
          renderTabMenu();
        });
        return b;
      };
      row.appendChild(mk('▲', -1, 'Move up'));
      row.appendChild(mk('▼', 1, 'Move down'));
      tabMenuPanel.appendChild(row);
    });
  }

  if (menuBtn) menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tabMenuPanel.classList.contains('hidden')) {
      renderTabMenu();
      tabMenuPanel.classList.remove('hidden');
    } else {
      tabMenuPanel.classList.add('hidden');
    }
  });
  document.addEventListener('click', (e) => {
    if (tabMenuPanel && !tabMenuPanel.classList.contains('hidden') &&
        !tabMenuPanel.contains(e.target) && e.target !== menuBtn) {
      tabMenuPanel.classList.add('hidden');
    }
  });

  const soNavTabs = document.getElementById('so-nav-tabs');
  const soNavMenu = document.getElementById('so-nav-menu');
  if (soNavTabs) soNavTabs.addEventListener('click', () => {
    try { localStorage.setItem(NAV_MODE_KEY, '0'); } catch {}
    applyNavMode();
  });
  if (soNavMenu) soNavMenu.addEventListener('click', () => {
    try { localStorage.setItem(NAV_MODE_KEY, '1'); } catch {}
    applyNavMode();
  });
  // Apply the persisted order to the bar at load + reflect the nav setting.
  applyTabOrder(loadTabOrder());
  applyNavMode();

  // --- CW Keyer ---
  function updateCwPanelVisibility() {
    var cwTabs = { spots: 1, map: 1, log: 1, activate: 1 };
    var isCwMode = currentMode.toUpperCase() === 'CW';
    var show = cwAvailable && isCwMode && !!cwTabs[activeTab];
    cwPanel.classList.toggle('hidden', !show);
  }

  let cwAvailable = false;
  let cwPaddleAvailable = true;
  let cwWpm = 20;
  let cwMode = 'iambicB';
  let cwSwapPaddles = false;
  let cwSidetoneFreq = 600;
  let cwSidetoneVol = 0.8;
  let cwAudioCtx = null;
  let cwOsc = null;
  let cwGain = null;
  let cwKeying = false;

  // --- Local iambic CW keyer ---
  // Runs in the browser in parallel with the desktop's keyer. The desktop
  // still does the real radio keying; this one only drives phone sidetone,
  // so paddle → tone has zero network round-trip. As long as WPM / mode /
  // swap stay in sync (server echoes via cw-config-ack), the two produce
  // identical element patterns from identical paddle inputs.
  function createLocalCwKeyer(onKey) {
    var IDLE = 0, TONE = 1, IES = 2;
    var state = IDLE;
    var wpm = 20, mode = 'iambicB', swap = false;
    var ditPressed = false, dahPressed = false;
    var ditLatch = false, dahLatch = false;
    var currentIsDit = false;
    var bothAtStart = false;
    var toneTimer = null, iesTimer = null;
    var ditPressStart = 0, dahPressStart = 0;
    var GHOST_MS = 12;
    // A contact that bounces as it closes (down, up, down within a few ms)
    // pressed again while its own element was sounding, which latched one
    // more of the same element: a dot tap sent "..", a dash tap "--", in
    // iambic A and B alike (LZ3AW 2026-10-01, heard in his own sidetone).
    // A press this soon after the same contact's release is that bounce, not
    // a new press; 15 ms is a whole dot at 80 WPM. Same rule in lib/keyer.js.
    var BOUNCE_MS = 15;
    var ditReleaseAt = -1e9, dahReleaseAt = -1e9;
    function ditMs() { return Math.round(1200 / wpm); }
    function dahMs() { return ditMs() * 3; }
    function clearTimers() {
      if (toneTimer) { clearTimeout(toneTimer); toneTimer = null; }
      if (iesTimer)  { clearTimeout(iesTimer);  iesTimer  = null; }
    }
    function startElement(isDit, continued) {
      state = TONE;
      currentIsDit = isDit;
      bothAtStart = ditPressed && dahPressed;
      ditLatch = false; dahLatch = false;
      onKey(true, isDit ? ditMs() : dahMs(), { continued: !!continued, spaceMs: ditMs() });
      clearTimers();
      timerDue = performance.now() + (isDit ? ditMs() : dahMs());
      toneTimer = setTimeout(onToneEnd, isDit ? ditMs() : dahMs());
    }
    // How late each timer fires (the page's main thread is busy): reported to
    // the desktop log per over (cw-diag, LZ3AW 2026-10-02).
    var timerDue = 0;
    function noteTimerLate() {
      if (typeof cwDiagNote === 'function') cwDiagNote('timer', performance.now() - timerDue);
    }
    function onToneEnd() {
      toneTimer = null;
      noteTimerLate();
      onKey(false, 0); // the scheduled element already ends itself
      state = IES;
      timerDue = performance.now() + ditMs();
      iesTimer = setTimeout(onIesEnd, ditMs());
    }
    function onIesEnd() {
      iesTimer = null;
      noteTimerLate();
      var oppLatch = currentIsDit ? dahLatch : ditLatch;
      var oppDown  = currentIsDit ? dahPressed : ditPressed;
      var sameLatch = currentIsDit ? ditLatch : dahLatch;
      var sameDown  = currentIsDit ? ditPressed : dahPressed;
      if (oppLatch || oppDown) { startElement(!currentIsDit, true); return; }
      if (sameLatch || sameDown) { startElement(currentIsDit, true); return; }
      if (mode === 'iambicB' && bothAtStart && !ditPressed && !dahPressed) {
        bothAtStart = false;
        startElement(!currentIsDit, true);
        return;
      }
      state = IDLE;
    }
    function handleDit(pressed) {
      ditPressed = pressed;
      if (mode === 'straight') { onKey(pressed); return; }
      if (pressed) {
        if (Date.now() - ditReleaseAt < BOUNCE_MS) return;
        ditPressStart = Date.now();
        if (state === IDLE) startElement(true);
        else ditLatch = true;
      } else {
        ditReleaseAt = Date.now();
        // Ghost-press cleanup (Android BT MIDI etc. — matches server keyer)
        var held = Date.now() - ditPressStart;
        if (ditLatch && held < GHOST_MS && state !== IDLE) ditLatch = false;
      }
    }
    function handleDah(pressed) {
      dahPressed = pressed;
      if (mode === 'straight') return;
      if (pressed) {
        if (Date.now() - dahReleaseAt < BOUNCE_MS) return;
        dahPressStart = Date.now();
        if (state === IDLE) startElement(false);
        else dahLatch = true;
      } else {
        dahReleaseAt = Date.now();
        var held = Date.now() - dahPressStart;
        if (dahLatch && held < GHOST_MS && state !== IDLE) dahLatch = false;
      }
    }
    return {
      paddleDit: function(pressed) { swap ? handleDah(pressed) : handleDit(pressed); },
      paddleDah: function(pressed) { swap ? handleDit(pressed) : handleDah(pressed); },
      setWpm: function(v) { wpm = Math.max(5, Math.min(50, v | 0)); },
      setMode: function(m) {
        if (m === 'iambicA' || m === 'iambicB' || m === 'straight') {
          mode = m;
          if (state !== IDLE) { clearTimers(); state = IDLE; onKey(false, undefined, { cancel: true }); }
        }
      },
      setSwap: function(b) { swap = !!b; },
      stop: function() {
        clearTimers();
        ditPressed = dahPressed = ditLatch = dahLatch = false;
        if (state !== IDLE) { state = IDLE; onKey(false, undefined, { cancel: true }); }
      },
    };
  }
  // Phone-side sidetone is driven by the local keyer, not by the server's
  // cw-state echo (the indicator class still comes from cw-state, so it shows
  // what the radio actually keyed).
  //
  // Iambic elements are SCHEDULED on the audio clock at their exact length,
  // like the macro sidetone: switching the tone from setTimeout callbacks
  // carried their jitter (several ms on desktop, more on phones — and the
  // audio clock only advances in blocks) into every dit and dah, which is
  // the "choppy, not correct dot and dash" LZ3AW heard on paddle but not on
  // macros (2026-09-26). The keyer's timers now only choose the NEXT element;
  // its sound, and the one-dit space after it, are exact. Straight-key mode
  // still follows the contact — that timing is the operator's fist.
  var paddleOsc = null, paddleGain = null, paddleNextAt = 0;
  function ensurePaddleVoice() {
    ensureCwAudioCtx();
    if (!paddleOsc) {
      paddleOsc = cwAudioCtx.createOscillator();
      paddleOsc.type = 'sine';
      paddleGain = cwAudioCtx.createGain();
      paddleGain.gain.setValueAtTime(0, cwAudioCtx.currentTime);
      paddleOsc.connect(paddleGain);
      paddleGain.connect(cwAudioCtx.destination);
      paddleOsc.start();
    }
    paddleOsc.frequency.value = cwSidetoneFreq;
  }
  function schedulePaddleElement(ms) {
    ensurePaddleVoice();
    var now = cwAudioCtx.currentTime;
    var ramp = 0.003, dur = ms / 1000, ditSec = 1.2 / Math.max(5, cwWpm || 20);
    // Continue exactly one dit after the previous element when that point is
    // still ahead; otherwise start 20 ms out. That lead is what lets every
    // later element land exactly even when the keyer's timer fires up to
    // ~18 ms late (phones), at the cost of 20 ms before the first element.
    var t = (paddleNextAt > now + 0.002) ? paddleNextAt : now + 0.020;
    var g = paddleGain.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(cwSidetoneVol, t + ramp);
    g.setValueAtTime(cwSidetoneVol, t + dur - ramp);
    g.linearRampToValueAtTime(0, t + dur);
    paddleNextAt = t + dur + ditSec;
    return (t - now) * 1000; // how far ahead of the keyer's choice it sounds
  }

  // --- Paddle timing diagnostic (LZ3AW 2026-10-02) ---
  // He hears extra dots and dashes in this page's own sidetone, in iambic A
  // and B alike, while typed CW is perfect. The keyer chooses each element on
  // its timers; the operator releases on what he HEARS. If the sound arrives
  // well after the choice (scheduling lead + the device's output latency, a
  // Bluetooth headset adds 150-250 ms) or the timers fire late (a busy page),
  // he releases late and the keyer honestly sends one more. One line per
  // over in the desktop log says which: cw-diag, sent after 1.5 s of quiet.
  var cwDiag = null, cwDiagTimer = null;
  function cwDiagNote(kind, ms) {
    ms = Math.max(0, Number(ms) || 0);
    if (!cwDiag) cwDiag = { elements: 0, timerMax: 0, timerSum: 0, timerN: 0, inputMax: 0, aheadMax: 0, aheadSum: 0 };
    if (kind === 'timer') { cwDiag.timerMax = Math.max(cwDiag.timerMax, ms); cwDiag.timerSum += ms; cwDiag.timerN++; }
    else if (kind === 'input') cwDiag.inputMax = Math.max(cwDiag.inputMax, ms);
    else if (kind === 'ahead') { cwDiag.elements++; cwDiag.aheadMax = Math.max(cwDiag.aheadMax, ms); cwDiag.aheadSum += ms; }
    if (cwDiagTimer) clearTimeout(cwDiagTimer);
    cwDiagTimer = setTimeout(sendCwDiag, 1500);
  }
  function noteCwInputLag(e) {
    // Event.timeStamp and performance.now() share the page's time origin.
    if (e && e.timeStamp > 0) cwDiagNote('input', performance.now() - e.timeStamp);
  }
  function sendCwDiag() {
    cwDiagTimer = null;
    const d = cwDiag;
    cwDiag = null;
    if (!d || !d.elements) return;
    const outMs = cwAudioCtx ? Math.round(((cwAudioCtx.baseLatency || 0) + (cwAudioCtx.outputLatency || 0)) * 1000) : 0;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
        type: 'cw-diag', elements: d.elements, wpm: cwWpm,
        soundAfterChoiceMaxMs: Math.round(d.aheadMax + outMs),
        soundAfterChoiceAvgMs: Math.round(d.aheadSum / d.elements + outMs),
        outputLatencyMs: outMs,
        timerLateMaxMs: Math.round(d.timerMax),
        timerLateAvgMs: d.timerN ? Math.round(d.timerSum / d.timerN) : 0,
        inputLagMaxMs: Math.round(d.inputMax),
      }));
    } catch { /* not connected */ }
  }
  function cancelPaddleTones() {
    if (paddleGain && cwAudioCtx) {
      var now = cwAudioCtx.currentTime;
      paddleGain.gain.cancelScheduledValues(now);
      paddleGain.gain.setValueAtTime(0, now);
    }
    paddleNextAt = 0;
  }
  // The keying the operator hears is the keying the radio sends: with a
  // desktop that supports it, every element this keyer makes goes to the
  // shack with its ideal start time and length, and the shack replays them at
  // that spacing behind a jitter buffer. Forwarding the paddle CONTACTS for a
  // second keyer at the shack meant network jitter decided the elements:
  // a dit release that arrived late became two dits (LZ3AW, 400 km from his
  // TS-480, 2026-09-29: "errors ... especially with the dots").
  var cwStreamNextAt = 0;
  function sendCwKeyStream(down, durMs, info) {
    if (!cwKeyStreamOk || !ws || ws.readyState !== WebSocket.OPEN) return;
    var now = performance.now();
    var msg;
    if (down && durMs) {
      // A continued element starts exactly one space after the previous
      // one, whatever this page's timers did; a new streak starts now.
      var at = (info && info.continued && cwStreamNextAt) ? cwStreamNextAt : now;
      cwStreamNextAt = at + durMs + ((info && info.spaceMs) || 0);
      msg = { type: 'cw-key', at: at, down: true, ms: durMs };
    } else if (down) {
      cwStreamNextAt = 0;
      msg = { type: 'cw-key', at: now, down: true };
    } else {
      cwStreamNextAt = 0;
      msg = { type: 'cw-key', at: now, down: false };
      if (info && info.cancel) msg.cancel = true;
    }
    ws.send(JSON.stringify(msg));
  }
  var localCwKeyer = createLocalCwKeyer(function(down, durMs, info) {
    if (durMs) { sendCwKeyStream(true, durMs, info); cwDiagNote('ahead', schedulePaddleElement(durMs)); return; } // iambic element
    if (durMs === 0) return;                              // its end is already scheduled
    // Straight key, or a keyer stop/mode change.
    sendCwKeyStream(down, 0, info);
    if (!down) cancelPaddleTones();
    handleCwSidetone(down);
  });

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

  // iOS Safari (and to a lesser extent Android Chrome) takes 1-3 seconds
  // after AudioContext.resume() before the audio thread is actually
  // producing samples. Events scheduled inside that warmup window are
  // silently dropped, so the first part of any oscillator-based sidetone
  // (CW macro, paddle) gets eaten — KM4CFT on v1.5.8 reported ~3s of
  // silence before sidetone begins, with a "click" right before. The
  // standard iOS unlock trick is to schedule a 1-sample silent
  // buffer-source play immediately after creating/resuming — it forces
  // the audio thread to actually spin up so the next real schedule is
  // on a warm engine.
  function primeCwAudio() {
    if (!cwAudioCtx) return;
    try {
      var buf = cwAudioCtx.createBuffer(1, 1, cwAudioCtx.sampleRate);
      var src = cwAudioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(cwAudioCtx.destination);
      src.start(0);
    } catch (e) { /* nothing more we can do */ }
  }

  // Perpetual silent anchor — a zero-gain oscillator that runs forever
  // (until tab close) to keep the audio thread from going to sleep
  // between bursts of activity. The 1-sample prime above wakes the
  // engine but iOS will doze it again after ~30s of silence; for paddle
  // keying that meant the FIRST dit after a quiet pause hit the cold-
  // start window all over again (KM4CFT: macros work, TinyMIDI paddle
  // has a pause before sidetone — the macro's multi-second sequence
  // keeps the engine awake, a single brief dit doesn't). Connecting a
  // continuously-running oscillator at gain 0 prevents the doze
  // entirely, so every paddle event lands on a fully-warm engine.
  // Battery cost is negligible (gain 0 = no actual audio output).
  var cwAnchorOsc = null;
  function ensureCwAnchor() {
    if (!cwAudioCtx || cwAnchorOsc) return;
    try {
      var osc = cwAudioCtx.createOscillator();
      osc.frequency.value = 1;        // anything; gain is 0 so it's silent
      var g = cwAudioCtx.createGain();
      g.gain.value = 0;
      osc.connect(g);
      g.connect(cwAudioCtx.destination);
      osc.start();
      cwAnchorOsc = osc;
    } catch (e) { /* skip on platforms that refuse */ }
  }

  function ensureCwAudioCtx() {
    if (!cwAudioCtx) {
      cwAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      primeCwAudio();
      ensureCwAnchor();
    }
    if (cwAudioCtx.state === 'suspended') {
      // resume() is async on Safari — fire-and-forget is fine because the
      // prime below kicks the engine awake regardless of when the promise
      // settles.
      try { cwAudioCtx.resume(); } catch (e) {}
      primeCwAudio();
      ensureCwAnchor(); // re-arm in case the anchor was torn down on suspend
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
    var now = cwAudioCtx.currentTime;
    var ramp = 0.003; // 3ms attack/decay (matches text sidetone path)
    if (keying) {
      if (cwOsc) return; // already playing
      cwOsc = cwAudioCtx.createOscillator();
      cwOsc.type = 'sine';
      cwOsc.frequency.value = cwSidetoneFreq;
      cwGain = cwAudioCtx.createGain();
      // Anchor the ramp start so the attack is a precise 0→vol slope.
      // Without setValueAtTime, the implicit start of linearRampToValueAtTime
      // is browser-dependent and produced clicks / clipped attacks on phones.
      cwGain.gain.setValueAtTime(0, now);
      cwGain.gain.linearRampToValueAtTime(cwSidetoneVol, now + ramp);
      cwOsc.connect(cwGain);
      cwGain.connect(cwAudioCtx.destination);
      cwOsc.start(now);
    } else {
      if (cwGain) {
        // Freeze whatever the gain is right now, then ramp down — otherwise
        // a still-rising attack ramp would override our decay target.
        var v = cwGain.gain.value;
        cwGain.gain.cancelScheduledValues(now);
        cwGain.gain.setValueAtTime(v, now);
        cwGain.gain.linearRampToValueAtTime(0, now + ramp);
      }
      if (cwOsc) {
        // Stop on the audio clock, not setTimeout — keeps element gaps clean
        // when the JS event loop is busy (the bug that produced clipped /
        // truncated sidetone on phones).
        try { cwOsc.stop(now + ramp + 0.001); } catch (e) {}
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

  // Queued text-sidetone voices (one per chunk) and when the queue ends, so
  // key-as-I-type APPENDS to what is still sounding. It used to call
  // stopCwTextSidetone() on every keystroke, cutting off the letters before
  // it — fast live typing sounded chopped (LZ3AW 2026-09-26).
  var cwTextVoices = [];
  var cwTextEndAt = 0;
  function playCwTextSidetone(text, opts) {
    var append = !!(opts && opts.append);
    if (!append) stopCwTextSidetone();
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
    // Appending while the previous chunk is still sounding: start after it,
    // with the letter gap the two chunks would have had as one string (a
    // chunk that begins with a space already carries its word gap).
    if (append && cwTextEndAt > now) {
      now = cwTextEndAt + (elements[0] && !elements[0].tone ? 0 : 3 * unitSec);
    }
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
    cwTextVoices.push(cwTextOsc);
    cwTextEndAt = t;
    cwIndicator.classList.add('active');

    // Clean up after the whole queue has played.
    var totalMs = (t - cwAudioCtx.currentTime) * 1000 + 50;
    if (cwTextTimer) clearTimeout(cwTextTimer);
    cwTextTimer = setTimeout(function() {
      cwTextOsc = null;
      cwTextGain = null;
      cwTextTimer = null;
      cwTextVoices = [];
      cwTextEndAt = 0;
      cwIndicator.classList.remove('active');
    }, totalMs);
  }

  function stopCwTextSidetone() {
    for (var vi = 0; vi < cwTextVoices.length; vi++) {
      try { cwTextVoices[vi].stop(); } catch(e) {}
    }
    cwTextVoices = [];
    cwTextEndAt = 0;
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

  // Key-as-I-type (LZ3AW item 8): stream characters as typed. Default off,
  // localStorage-persisted. Sent characters cannot be unsent - deleting
  // typed text only resyncs the local cursor.
  let cwLiveMode = localStorage.getItem('echocat-cw-live') === '1';
  let cwLiveSent = 0;
  const cwLiveBtn = document.getElementById('cw-live-btn');
  const vfCwLiveBtn = document.getElementById('vf-cw-live');
  let vfCwLiveSent = 0; // the VFO pane's own cursor into its own field
  function reflectCwLive() {
    if (cwLiveBtn) cwLiveBtn.classList.toggle('active', cwLiveMode);
    if (vfCwLiveBtn) vfCwLiveBtn.classList.toggle('active', cwLiveMode);
  }
  // Key-as-I-type for one text field: send what was appended since the last
  // input event; a deletion only moves the cursor back (nothing to unsend).
  function cwLiveInputDelta(inputEl, sent) {
    const v = inputEl.value.toUpperCase();
    if (v.length <= sent) return { sent: v.length, delta: '' };
    return { sent: v.length, delta: v.slice(sent) };
  }
  function cwLiveSend(delta) {
    if (!delta.trim() && !delta.includes(' ')) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cw-text', text: delta, live: true }));
    }
    playCwTextSidetone(delta, { append: true });
  }
  // The VFO pane's CW field shares the Live state with the CW tab (one
  // keyer, one mode) — LZ3AW 2026-10-16 asked for the button there too.
  if (vfCwLiveBtn) vfCwLiveBtn.addEventListener('click', () => {
    cwLiveMode = !cwLiveMode;
    const vfIn = document.getElementById('vf-cw-input');
    vfCwLiveSent = vfIn ? vfIn.value.length : 0;
    cwLiveSent = cwTextInput ? cwTextInput.value.length : 0;
    localStorage.setItem('echocat-cw-live', cwLiveMode ? '1' : '0');
    reflectCwLive();
  });
  (function () {
    const vfIn = document.getElementById('vf-cw-input');
    if (!vfIn) return;
    vfIn.addEventListener('input', () => {
      if (!cwLiveMode) return;
      const r = cwLiveInputDelta(vfIn, vfCwLiveSent);
      vfCwLiveSent = r.sent;
      if (r.delta) cwLiveSend(r.delta);
    });
  })();
  reflectCwLive();
  if (cwLiveBtn) cwLiveBtn.addEventListener('click', () => {
    cwLiveMode = !cwLiveMode;
    cwLiveSent = cwTextInput ? cwTextInput.value.length : 0;
    localStorage.setItem('echocat-cw-live', cwLiveMode ? '1' : '0');
    reflectCwLive();
  });
  if (cwTextInput) cwTextInput.addEventListener('input', () => {
    if (!cwLiveMode) return;
    const r = cwLiveInputDelta(cwTextInput, cwLiveSent);
    cwLiveSent = r.sent;
    if (r.delta) cwLiveSend(r.delta);
  });

  /** The callsign a macro's {call} should send RIGHT NOW.
   *  A callsign TYPED into the log form wins over the last tuned spot: while
   *  running a frequency you answer callers you were never tuned to, and
   *  N1MM has always sent what's in the entry field (LZ3AW 2026-08-29).
   *  Falls back to the tuned spot so tap-a-spot-then-macro is unchanged. */
  /** Tell main what a callsign field holds now (typed, filled or cleared). */
  function reportTypedCall(source, value) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'typed-call', source, call: String(value || '').trim().toUpperCase() }));
  }

  function macroCallsign() {
    // Main's merged view first: the most recently changed non-empty field on
    // ANY surface, which is the call the operator means. Reading the panel
    // box first let a call typed there an hour ago beat the one just typed
    // into the log sheet (LZ3AW #13). Local fields are the offline fallback.
    if (sharedTypedCall) return sharedTypedCall;
    const vfCall = document.getElementById('vf-cw-call');
    const panel = (vfCall && vfCall.value ? vfCall.value : '').trim().toUpperCase();
    if (panel) return panel;
    const typed = (logCall && logCall.value ? logCall.value : '').trim().toUpperCase();
    if (typed) return typed;
    return tunedCallsign || '';
  }

  function sendCwText(text) {
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Expand macros: {op_firstname} -> operator name or "OM", {call} -> the
    // callsign being worked (typed in the log form, else the tuned spot).
    var expanded = text
      .replace(/\{op_firstname\}/gi, tunedOpName || '')
      .replace(/\{call\}/gi, macroCallsign())
      .replace(/\{state\}/gi, tunedState || '');
    ws.send(JSON.stringify({ type: 'cw-text', text: expanded }));
    playCwTextSidetone(expanded);
  }

  // --- Macro buttons ---
  // The macros render into the CW tab AND the Full VFO View's CW widget. The
  // VFO panel is a fullscreen overlay, so an operator running the radio from
  // it could reach the WPM control and the free-text box but not one macro —
  // they had to leave the panel to send "TU 73" (LZ3AW item 10).
  function renderCwMacros() {
    var rows = [cwMacroRow, document.getElementById('vf-cw-macro-row')];
    rows.forEach(function(row) {
      if (!row) return;
      row.innerHTML = '';
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
        row.appendChild(btn);
      });
    });
  }
  renderCwMacros();

  // Typing the call in the VFO panel carries it to the log form, so the QSO
  // can be logged without retyping it — "entered manually in the callsign
  // field" should mean one field, wherever the operator is standing.
  const vfCwCall = document.getElementById('vf-cw-call');
  if (vfCwCall) {
    vfCwCall.addEventListener('input', function() {
      const v = this.value.toUpperCase();
      if (this.value !== v) this.value = v;
      if (logCall && logSheet && logSheet.classList.contains('hidden')) logCall.value = v;
      reportTypedCall('vf', v);
    });
  }

  // --- Free-text CW input ---
  cwTextSend.addEventListener('click', function() {
    var text = cwTextInput.value.trim();
    if (cwLiveMode) {
      // Key-as-I-type: the text has already gone to air character by
      // character. Send/Enter only clears the box — re-sending aborted the
      // letters still keying and played the whole line a second time, and
      // leaving cwLiveSent at the old length swallowed the next characters
      // until the new line was longer than the old one (LZ3AW).
      cwTextInput.value = '';
      cwLiveSent = 0;
      return;
    }
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

  // Stop / cancel any CW macro mid-flight. AA6C 2026-05-05: tapping the
  // wrong macro button used to mean waiting it out — the desktop already
  // had ESC, ECHOCAT didn't. Uses the existing cw-stop WS message; the
  // server now both halts the paddle keyer locally AND emits cw-cancel-text
  // so main.js aborts the macro across every CW backend.
  var cwTextStop = document.getElementById('cw-text-stop');
  if (cwTextStop) {
    cwTextStop.addEventListener('click', function() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'cw-stop' }));
      stopCwTextSidetone();
      // STOP also clears this page's paddle state. A contact it still thought
      // was down made every later press a no-op (`if (!ditDown)`), which read
      // as "the paddle doesn't work until POTACAT is restarted" (LZ3AW).
      if (window.__echocatReleasePaddles) window.__echocatReleasePaddles(false);
    });
  }

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
    // Push to desktop so the user's edits survive a phone-side
    // localStorage wipe (Safari ITP and similar). Without this push,
    // a localStorage clear on the phone took the macros down with it
    // because the desktop's settings.remoteCwMacros was only ever
    // received by the phone, never sent. (User report: "every time I
    // log in via ECHOCAT I must adjust the macros again.")
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'save-cw-macros', macros: cwMacros }));
    }
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

  // Sync macros from server settings. Server is now authoritative —
  // when the user edits on the phone we push to the desktop, so the
  // server-pushed copy is always the user's most recent edits (or
  // defaults if they've never edited). Always trust server. Without
  // this, a stale-defaults localStorage on the phone outranked the
  // user's actual edits sitting on the desktop after a localStorage
  // wipe brought back the defaults file.
  function syncMacrosFromSettings(serverMacros) {
    if (serverMacros && Array.isArray(serverMacros) && serverMacros.length > 0) {
      cwMacros = serverMacros;
      try { localStorage.setItem('echocat-cw-macros', JSON.stringify(cwMacros)); } catch {}
      renderCwMacros();
    }
  }

  // WPM buttons
  cwWpmDn.addEventListener('click', function() {
    cwWpm = Math.max(5, cwWpm - 1);
    cwWpmLabel.textContent = cwWpm + ' WPM';
    sendCwConfig();
    updateEchoCwSpotWpm();
    if (window.__vfSyncCw) window.__vfSyncCw();
  });
  cwWpmUp.addEventListener('click', function() {
    cwWpm = Math.min(50, cwWpm + 1);
    cwWpmLabel.textContent = cwWpm + ' WPM';
    sendCwConfig();
    updateEchoCwSpotWpm();
    if (window.__vfSyncCw) window.__vfSyncCw();
  });

  // Spotted station WPM display + sync
  var echoSpotWpm = null;
  var echoSpotWpmEl = document.getElementById('cw-spot-wpm-echo');
  var echoWpmSyncBtn = document.getElementById('cw-wpm-sync-echo');

  // Auto-sync (KE4WLE 2026-09-25: "automatically slows or increases the WPM
  // to match the spotted station without having to click sync every time.
  // Maybe single press for sync and double press for auto sync?"). One press
  // matches once; a double press or press-and-hold turns auto-sync on/off.
  // With it on, the speed follows the TUNED spot's WPM — re-resolved when the
  // dial moves and when the spot list refreshes — in CW modes only. Per
  // device, like the rest of this page's layout choices.
  var cwAutoSync = (function() { try { return localStorage.getItem('echoCwAutoSync') === '1'; } catch (e) { return false; } })();
  function cwWpmClamp(w) { return Math.max(5, Math.min(50, Math.round(w))); }
  function isCwModeNow() { return /^CW/i.test(currentMode || '') || /^CW/i.test((modeBadge && modeBadge.textContent) || ''); }
  function applySpotWpm() {
    if (!echoSpotWpm) return;
    var w = cwWpmClamp(echoSpotWpm);
    if (w === cwWpm) return;
    cwWpm = w;
    cwWpmLabel.textContent = cwWpm + ' WPM';
    sendCwConfig();
    if (window.__vfSyncCw) window.__vfSyncCw();
  }
  function updateEchoCwSpotWpm() {
    if (!echoSpotWpmEl || !echoWpmSyncBtn) return;
    if (cwAutoSync && echoSpotWpm && isCwModeNow()) applySpotWpm();
    var differs = !!(echoSpotWpm && cwWpmClamp(echoSpotWpm) !== cwWpm);
    echoSpotWpmEl.textContent = echoSpotWpm ? ('Theirs: ' + echoSpotWpm) : '';
    echoSpotWpmEl.classList.toggle('hidden', !differs);
    // Auto-sync keeps the button on screen: once the speeds match it would
    // otherwise vanish, and with it the only way to turn auto-sync off.
    echoWpmSyncBtn.classList.toggle('hidden', !differs && !cwAutoSync);
    echoWpmSyncBtn.classList.toggle('auto', cwAutoSync);
    echoWpmSyncBtn.textContent = cwAutoSync ? 'Auto' : 'Sync';
    echoWpmSyncBtn.title = cwAutoSync
      ? 'Auto-sync is on: the speed follows the tuned spot. Double-press or hold to turn it off.'
      : 'Press: match their speed once. Double-press or hold: match it automatically.';
  }
  function setCwAutoSync(on) {
    cwAutoSync = !!on;
    try { localStorage.setItem('echoCwAutoSync', cwAutoSync ? '1' : '0'); } catch (e) {}
    updateEchoCwSpotWpm();
  }
  // The tuned spot's WPM, from the dial — so auto-sync follows the VFO, not
  // only a tap on a spot card (a scan step, the knob, the map all land here).
  function resolveEchoSpotWpm() {
    if (!currentFreqKhz || !Array.isArray(spots)) return;
    var best = null, bestD = 0.6;
    for (var i = 0; i < spots.length; i++) {
      var sp = spots[i];
      if (!sp || !sp.wpm) continue;
      var d = Math.abs(parseFloat(sp.frequency) - currentFreqKhz);
      if (d < bestD) { best = sp; bestD = d; }
    }
    var w = best ? best.wpm : null;
    if (w !== echoSpotWpm) { echoSpotWpm = w; updateEchoCwSpotWpm(); }
  }

  if (echoWpmSyncBtn) {
    var _syncClickTimer = null, _syncHoldTimer = null, _syncHeld = false;
    echoWpmSyncBtn.addEventListener('pointerdown', function() {
      _syncHeld = false;
      clearTimeout(_syncHoldTimer);
      _syncHoldTimer = setTimeout(function() { _syncHeld = true; setCwAutoSync(!cwAutoSync); }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function(ev) {
      echoWpmSyncBtn.addEventListener(ev, function() { clearTimeout(_syncHoldTimer); });
    });
    echoWpmSyncBtn.addEventListener('contextmenu', function(e) { e.preventDefault(); }); // long-press on a phone
    echoWpmSyncBtn.addEventListener('click', function() {
      if (_syncHeld) { _syncHeld = false; return; }          // the hold already toggled
      if (_syncClickTimer) {                                  // second press: toggle auto
        clearTimeout(_syncClickTimer);
        _syncClickTimer = null;
        setCwAutoSync(!cwAutoSync);
        return;
      }
      _syncClickTimer = setTimeout(function() {               // single press: match once
        _syncClickTimer = null;
        applySpotWpm();
        updateEchoCwSpotWpm();
      }, 260);
    });
    updateEchoCwSpotWpm();
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
      updatePaddleHelp();
    });
  }

  // Platform-aware paddle setup help. Three real-world pain points this tries
  // to head off (from the KM4CFT thread, 2026-04-20):
  //   1. Users on iOS don't get MIDI support at all — say so up front.
  //   2. Android users need a BLE-to-WebMIDI bridge app; point them at one.
  //   3. Safari / older browsers without Web MIDI need a Chromium browser.
  function updatePaddleHelp() {
    var helpEl = document.getElementById('paddle-help');
    if (!helpEl) return;
    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isAndroid = /Android/.test(ua);
    var hasWebMidi = !!navigator.requestMIDIAccess;
    var bits = [];
    // Highest-priority message: desktop has reported paddle keying can't
    // reach the radio. This trumps every other tip — the user needs to
    // know paddle won't work at all until they fix it on the desktop.
    if (!cwPaddleAvailable) {
      bits.push(
        '<b style="color:var(--accent-red, #e94560);">Paddle keying is currently disabled.</b> ' +
        'POTACAT Desktop reported it can’t reach the radio’s key line per element. ' +
        'Common causes: (a) Linux + USB-CDC radio (IC-7300, FT-710, QMX/QDX) where the cdc_acm ' +
        'kernel driver rejects DTR control; (b) connecting via Hamlib / rigctld, which has ' +
        'no per-element CW command in its protocol — only mic PTT. ' +
        'Workaround for either case: wire an external USB-UART adapter (FTDI / CH340) to the ' +
        'radio’s CW KEY jack and set it as <i>CW Key Port</i> in Settings → Rig. ' +
        'CW macros and text-send still work without it — only paddle is affected.'
      );
      helpEl.innerHTML = bits.join('<br>');
      helpEl.classList.remove('hidden');
      return;
    }
    if (!hasWebMidi) {
      if (isIOS) {
        bits.push('<b>MIDI paddles are not supported on iOS.</b> For paddle use, switch to a desktop / Android browser with Web MIDI (Chrome or Edge).');
      } else {
        bits.push('<b>This browser doesn\u2019t support Web MIDI.</b> Switch to Chrome, Edge, or another Chromium browser for USB / Bluetooth MIDI paddles.');
      }
    } else if (paddleType === 'midi') {
      if (isAndroid) {
        bits.push('<b>Android:</b> install a MIDI bridge like <i>MIDI BLE Connect</i> (Play Store) to expose your Bluetooth paddle to Chrome\u2019s Web MIDI.');
      } else if (isIOS) {
        bits.push('<b>iOS:</b> MIDI paddles aren\u2019t supported in mobile Safari. Use a Chromium browser on desktop or Android.');
      } else {
        bits.push('<b>Desktop:</b> install <a href="https://potacat.com/tinymidi" target="_blank" rel="noopener" style="color:var(--pota);">TinyMIDI</a> (or your paddle\u2019s own helper app) so ECHOCAT can see the device. If your paddle disconnects after a few seconds, re-open this tab after pairing.');
      }
    } else if (paddleType === 'tinymidi') {
      bits.push('<b>Keyboard mode:</b> paddle sends <code>[</code> (dit) and <code>]</code> (dah). Works in every browser — no MIDI required.');
    } else if (paddleType === 'vail') {
      bits.push('<b>Vail / VBand:</b> uses Left/Right Ctrl for dit/dah.');
    }
    if (bits.length === 0) { helpEl.classList.add('hidden'); return; }
    helpEl.innerHTML = bits.join('<br>');
    helpEl.classList.remove('hidden');
  }
  updatePaddleHelp();

  // Per-contact "release safety" — if we told the server a paddle was pressed
  // but never got around to telling it released (browser keyup lost, MIDI
  // note-off dropped on Android Bluetooth, tab backgrounded mid-press, etc.),
  // fire an unconditional release after 8 s. Server has a 1.5 s watchdog too;
  // this is an extra belt in case spurious keydowns keep resetting it while
  // the true release is missing.
    let _paddleRttSentAt = 0;  // press-to-echo round-trip stamp (diagnostics)
  let _paddleRttAvg = 0;
var _paddleReleaseTimer = { dit: null, dah: null };
var _paddleHoldTimer = { dit: null, dah: null };
  // The hold keepalive ticks from a WORKER when it can. A page whose window
  // is hidden or covered (the browser behind POTACAT on the same PC) has its
  // timers clamped to once a second, and after five minutes to once a
  // MINUTE — the 400 ms keepalive then misses the server's 1.5 s paddle
  // watchdog and keying stops mid-hold, a few seconds in (LZ3AW round 6:
  // "TinyMidi paddle - no change"; MIDI keeps arriving in a hidden tab).
  // Dedicated-worker timers are not clamped that way.
  var _paddleHoldActive = { dit: false, dah: false };
  var _holdTickWorker = null;
  function _sendPaddleHold(contact) {
    if (!_paddleHoldActive[contact] || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Stream mode: the keepalive only matters for a held straight key.
    if (cwKeyStreamOk) { ws.send(JSON.stringify({ type: 'cw-key', hold: true })); return; }
    ws.send(JSON.stringify({ type: 'paddle', contact: contact, state: 1, hold: true }));
  }
  function _holdTicker() {
    if (_holdTickWorker !== null) return _holdTickWorker;
    try {
      var src = 'var t={};onmessage=function(e){var d=e.data;clearInterval(t[d.id]);delete t[d.id];' +
        'if(d.start){t[d.id]=setInterval(function(){postMessage(d.id);},d.ms);}};';
      _holdTickWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      _holdTickWorker.onmessage = function(e) { _sendPaddleHold(e.data); };
    } catch (err) {
      _holdTickWorker = false; // fall back to page timers
    }
    return _holdTickWorker;
  }
  function _startPaddleHold(contact) {
    _paddleHoldActive[contact] = true;
    var w = _holdTicker();
    if (w) w.postMessage({ id: contact, start: true, ms: 400 });
    else _paddleHoldTimer[contact] = setInterval(function() { _sendPaddleHold(contact); }, 400);
  }
  function _stopPaddleHold(contact) {
    _paddleHoldActive[contact] = false;
    if (_holdTickWorker) _holdTickWorker.postMessage({ id: contact, start: false });
    if (_paddleHoldTimer[contact]) { clearInterval(_paddleHoldTimer[contact]); _paddleHoldTimer[contact] = null; }
  }
  // Release every contact: stop the hold keepalives, cancel the 8 s fallback,
  // silence the local keyer, and (when asked) tell the server. A release is
  // never gated — it cannot key the radio, and dropping one left the desktop
  // keyer sending dits until STOP (LZ3AW, 1.10.25).
  function releaseAllPaddles(tellServer) {
    ['dit', 'dah'].forEach(function(contact) {
      var wasDown = contact === 'dit' ? ditDown : dahDown;
      _stopPaddleHold(contact);
      if (_paddleReleaseTimer[contact]) { clearTimeout(_paddleReleaseTimer[contact]); _paddleReleaseTimer[contact] = null; }
      if (contact === 'dit') ditDown = false; else dahDown = false;
      try {
        if (contact === 'dit') localCwKeyer.paddleDit(false); else localCwKeyer.paddleDah(false);
      } catch (e) {}
      if (tellServer && wasDown && !cwKeyStreamOk && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'paddle', contact: contact, state: 0 }));
      }
    });
    // Stream mode: this page's keyer IS the radio's keyer, so stopping keying
    // means stopping it (its stop sends the cancelling key-up).
    if (cwKeyStreamOk) { try { localCwKeyer.stop(); } catch (e) {} }
  }

  // Reachable from the message handler and the STOP button whatever scope
  // they sit in (a silent `typeof` miss would bring the stuck key back).
  window.__echocatReleasePaddles = releaseAllPaddles;

  function sendPaddle(contact, state) {
    // Drive the local iambic keyer first (zero-latency sidetone) then forward
    // to the server over WS (which does the real radio keying). Skip both
    // sides when desktop has reported paddle keying can't reach the radio
    // (cwPaddleAvailable=false) — playing sidetone for keys that don't
    // produce RF was misleading users into thinking POTACAT was broken.
    // Presses only: a release always goes out (see releaseAllPaddles).
    if (!cwPaddleAvailable && state) return;
    ensureCwAudioCtx();
    if (contact === 'dit') localCwKeyer.paddleDit(!!state);
    else if (contact === 'dah') localCwKeyer.paddleDah(!!state);
    if (ws && ws.readyState === WebSocket.OPEN && !cwKeyStreamOk) {
      if (state && !_paddleRttSentAt) _paddleRttSentAt = performance.now();
      ws.send(JSON.stringify({ type: 'paddle', contact: contact, state: state }));
    }
    // Hold keepalive: a held contact sends one press and nothing more, and
    // the server's paddle watchdog used to read that silence as a lost
    // key-up and stop the keyer 1.5 s in, mid-character (LZ3AW's TinyMidi
    // paddle). Repeating the press proves the contact is still down, so the
    // watchdog keeps its short window and still catches a real lost key-up.
    _stopPaddleHold(contact);
    if (state) _startPaddleHold(contact);
    if (_paddleReleaseTimer[contact]) {
      clearTimeout(_paddleReleaseTimer[contact]);
      _paddleReleaseTimer[contact] = null;
    }
    if (state) {
      _paddleReleaseTimer[contact] = setTimeout(function() {
        _paddleReleaseTimer[contact] = null;
        _stopPaddleHold(contact);
        if (contact === 'dit') { ditDown = false; localCwKeyer.paddleDit(false); }
        else { dahDown = false; localCwKeyer.paddleDah(false); }
        if (ws && ws.readyState === WebSocket.OPEN && !cwKeyStreamOk) {
          ws.send(JSON.stringify({ type: 'paddle', contact: contact, state: 0 }));
        }
      }, 8000);
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

  // Throttled diagnostic: log once per minute when a paddle key arrives
  // but cwAvailable is false. KM4CFT on Android: TinyMIDI paddle had
  // delayed sidetone + radio not keying. If the keydown is silently
  // dropped here we never see it; surfacing it tells us the desktop
  // hasn't enabled CW for this client.
  var _paddleDropLogTs = 0;
  function logPaddleDrop(reason) {
    var now = Date.now();
    if (now - _paddleDropLogTs < 60_000) return;
    _paddleDropLogTs = now;
    console.warn('[CW paddle] Ignoring key — ' + reason);
  }

  document.addEventListener('keydown', function(e) {
    if (e.repeat) return;
    if (isInputFocused()) return;
    var contact = matchPaddleKey(e);
    if (!contact) return;
    if (!cwAvailable) {
      logPaddleDrop('cwAvailable is false (desktop hasn\'t enabled CW for this session)');
      return;
    }
    if (!cwPaddleAvailable) {
      logPaddleDrop('cwPaddleAvailable is false (desktop has determined paddle keying can\'t reach the radio — see verbose log for cause)');
      return;
    }
    noteCwInputLag(e);
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
    if (contact) noteCwInputLag(e);
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
    noteCwInputLag(msg);
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
  // Desktop now authors up to 25 macros and syncs them here. The bar renders
  // every synced slot that has a label or recording; the inline editor below
  // only edits the first few (its rows are static HTML — so-ssb-1.. in the
  // page), which is fine: the phone is a remote, the desktop is the author.
  var SSB_MACRO_COUNT = 25;
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

  // Re-upload every voice-macro recording we have locally to the
  // desktop. Called on auth-ok so any recording the user made while
  // the WS was disconnected (and ft8Send silently dropped) finally
  // makes its way to the desktop's persistent storage.
  function reuploadLocalVoiceMacros() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ssbCheckSlots(function (filled) {
      if (!filled || !filled.length) return;
      filled.forEach(function (idx) {
        ssbDbGet(idx, function (blob) {
          if (!blob) return;
          var reader = new FileReader();
          reader.onload = function () {
            try {
              var b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(reader.result)));
              ft8Send({
                type: 'voice-macro-sync',
                idx: idx,
                label: ssbMacroLabels[idx] || '',
                audio: b64,
              });
            } catch (e) { /* swallow — best-effort */ }
          };
          reader.readAsArrayBuffer(blob);
        });
      });
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

  // Voice mode detection — includes data sub-bands (PKTUSB/PKTLSB/DIGU/DIGL)
  // and USB-D/LSB-D which are voice-capable SSB carriers used for FT8/
  // FreeDV/etc. Keeping these as "voice" lets the SSB macro panel and PTT
  // button work in FreeDV mode.
  function isVoiceMode(mode) {
    var m = (mode || '').toUpperCase();
    return m === 'USB' || m === 'LSB' || m === 'SSB' || m === 'FM' || m === 'AM' ||
           m === 'PKTUSB' || m === 'PKTLSB' || m === 'DIGU' || m === 'DIGL' ||
           m === 'USB-D' || m === 'LSB-D' || m.indexOf('FREEDV') === 0;
  }

  // A "No CAT control (VOX)" rig never reports a mode: the sound card keys it,
  // so voice is the default whenever no digital engine is running (Digirig
  // Lite + CM108 tester, 2026-10-24: Live / Vol / Scan and no PTT on the web).
  function voiceByDefault() {
    return !!currentNoCat && !currentMode && !ft8Running;
  }
  function updateSsbPanelVisibility() {
    var voiceTabs = { spots: 1, map: 1, log: 1, activate: 1 };
    var show = (isVoiceMode(currentMode) || voiceByDefault()) && !!voiceTabs[activeTab] && audioEnabled;
    ssbPanel.classList.toggle('hidden', !show);
  }

  // Render SSB macro buttons in the panel.
  // ssbCheckSlots is async (IndexedDB) and this function can be called in
  // rapid succession (one per incoming voice-macro-sync message). Without a
  // guard, overlapping callbacks each append their own full set of buttons,
  // so the row ends up with N copies of every macro. Use a generation token
  // so only the latest render's callback actually mutates the DOM.
  var ssbRenderGen = 0;
  function renderSsbMacros() {
    var gen = ++ssbRenderGen;
    ssbMacroRow.innerHTML = '';
    ssbCheckSlots(function(filled) {
      if (gen !== ssbRenderGen) return; // superseded by a later render
      ssbMacroRow.innerHTML = ''; // clear again in case a racing callback slipped in
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
      if (window.__vfRenderVoiceMacros) window.__vfRenderVoiceMacros();
    });
  }

  // Play an SSB macro: PTT on, swap audio track, play clip, PTT off
  // Hear a voice macro on this device while it transmits (KW4FM 2026-09-25).
  // The same decoded source feeds the radio's track and this device's
  // speaker, so the two stay sample-locked. Safe from feedback on this side:
  // the phone mic is swapped OFF the sender for the whole clip. Per device.
  var ssbMonitorOn = (function() { try { return localStorage.getItem('echoSsbMonitor') === '1'; } catch (e) { return false; } })();
  var ssbMonitorGain = null;
  var ssbMonitorCb = document.getElementById('echo-ssb-monitor');
  if (ssbMonitorCb) {
    ssbMonitorCb.checked = ssbMonitorOn;
    ssbMonitorCb.addEventListener('change', function() {
      ssbMonitorOn = ssbMonitorCb.checked;
      try { localStorage.setItem('echoSsbMonitor', ssbMonitorOn ? '1' : '0'); } catch (e) {}
    });
  }

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

          // Create playback graph: AudioBuffer -> MediaStreamDestination
          ssbPlaybackDest = ctx.createMediaStreamDestination();
          ssbPlaybackSource = ctx.createBufferSource();
          ssbPlaybackSource.buffer = audioBuffer;
          ssbPlaybackSource.connect(ssbPlaybackDest);
          if (ssbMonitorOn) {
            ssbMonitorGain = ctx.createGain();
            ssbMonitorGain.gain.value = 0.8;
            ssbPlaybackSource.connect(ssbMonitorGain);
            ssbMonitorGain.connect(ctx.destination);
          }

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
    if (ssbMonitorGain) { try { ssbMonitorGain.disconnect(); } catch (e) {} ssbMonitorGain = null; }
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
    if (dirActiveTab === 'landmarks') {
      renderDirLandmarks(search);
    } else if (dirActiveTab === 'channels') {
      renderDirChannels(search);
    } else if (dirActiveTab === 'nets') {
      renderDirNets(search);
    } else {
      renderDirSwl(search);
    }
  }

  // --- Landmarks (lib/landmarks.js, inlined into this page) ---
  // Signals to dial into at any time. A card shows the one-line "what it is";
  // a tap opens it in place with What you'll hear / Why it matters / Try this
  // and a Tune button, so the text is read before the radio moves.
  var lmkOpenId = null;
  var lmkShowAll = false;
  var lmkTickTimer = null;
  var LMK_HINT_KEY = 'echocat-landmarks-hint-dismissed';
  function lmkHintDismissed() { try { return localStorage.getItem(LMK_HINT_KEY) === '1'; } catch (e) { return false; } }
  function lmkTune(lm) {
    if (!lm || !lm.khz) return;
    if (vfoLocked) { showToast('VFO Locked — Unlock VFO to change frequency', 2000); return; }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tune', freqKhz: String(lm.khz), mode: lm.mode }));
    }
  }
  function renderDirLandmarks(search) {
    var L = window.Landmarks;
    if (!L) return;
    if (!directoryLandmarks.length) {
      dirList.innerHTML = '<div class="dir-empty">Waiting for landmarks from POTACAT</div>';
      return;
    }
    var now = Date.now();
    var rows = directoryLandmarks.map(function(lm, i) {
      return { lm: lm, i: i, band: L.bandLabel(lm.khz), cd: L.status(lm, now), ok: L.receivable(lm, webRigBands) };
    });
    if (search) {
      rows = rows.filter(function(r) {
        return [r.lm.name, r.lm.line, r.lm.region, r.lm.mode].some(function(v) { return (v || '').toLowerCase().indexOf(search) >= 0; })
          || String(r.lm.khz).indexOf(search) >= 0;
      });
    }
    var hidden = rows.filter(function(r) { return !r.ok; });
    var shown = lmkShowAll ? rows : rows.filter(function(r) { return r.ok; });

    if (!lmkHintDismissed() && !search && directoryLandmarks.some(function(l) { return l.id === 'wwv-10000'; })) {
      var hint = document.createElement('div');
      hint.className = 'lmk-hint';
      hint.innerHTML = '<p><b>New radio?</b> Tune <b>WWV on 10000 kHz</b>. A tick every second means the radio, the antenna and the audio all work.</p>'
        + '<div class="lmk-actions"><button type="button" class="lmk-btn lmk-btn-tint" data-act="tune">Tune WWV</button>'
        + '<button type="button" class="lmk-btn lmk-btn-plain" data-act="close">Got it</button></div>';
      hint.addEventListener('click', function(ev) {
        var act = ev.target && ev.target.dataset ? ev.target.dataset.act : '';
        if (!act) return;
        if (act === 'tune') {
          var wwv = directoryLandmarks.filter(function(l) { return l.id === 'wwv-10000'; })[0];
          if (wwv) { lmkOpenId = wwv.id; lmkTune(wwv); }
        }
        try { localStorage.setItem(LMK_HINT_KEY, '1'); } catch (e) { /* shows again next time */ }
        renderDirectoryTab();
      });
      dirList.appendChild(hint);
    }

    var cats = directoryLandmarkCategories.length ? directoryLandmarkCategories
      : L.CATEGORY_IDS.map(function(id) { return { id: id, label: id, reason: '' }; });
    cats.forEach(function(cat) {
      var inCat = shown.filter(function(r) { return r.lm.category === cat.id; });
      if (!inCat.length) return;
      // Live first, then by when it is next on, then in the catalog's own
      // (curated) order: the most useful station first.
      inCat.sort(function(a, b) { return (a.cd.sortKey - b.cd.sortKey) || (a.i - b.i); });
      var head = document.createElement('div');
      head.className = 'lmk-group';
      head.innerHTML = esc(cat.label) + (cat.reason ? '<span>' + esc(cat.reason) + '</span>' : '');
      dirList.appendChild(head);
      inCat.forEach(function(r) {
        var lm = r.lm, cd = r.cd;
        var open = lm.id === lmkOpenId;
        var tuned = currentFreqKhz && Math.abs(Number(lm.khz) - currentFreqKhz) < 0.5;
        var card = document.createElement('div');
        card.className = 'dir-card lmk-card' + (cd.status === 'live' ? ' dir-live' : cd.status === 'soon' ? ' dir-soon' : '')
          + (tuned ? ' tuned' : '') + (open ? ' open' : '') + (r.ok ? '' : ' lmk-out');
        var statusHtml = cd.label ? '<span class="dir-card-status ' + cd.status + '">' + esc(cd.label) + '</span>' : '';
        var html = '<div class="dir-card-row"><span class="dir-card-name">' + esc(lm.name) + '</span>' + statusHtml + '</div>'
          + '<div class="dir-card-detail"><span class="dir-card-freq">' + lm.khz + ' kHz</span> ' + esc(lm.mode) + ' · ' + esc(r.band) + '</div>'
          + '<div class="lmk-line">' + esc(lm.line) + (lm.ncdxf ? '<span class="lmk-now" data-khz="' + lm.khz + '"></span>' : '') + '</div>';
        if (open) {
          html += '<div class="lmk-detail">'
            + (lm.ncdxf ? '<div class="lmk-beacon" data-khz="' + lm.khz + '"><span class="lmk-beacon-now"></span>'
              + '<div class="lmk-beacon-track"><div class="lmk-beacon-fill"></div></div><span class="lmk-beacon-next"></span></div>' : '')
            + (r.ok ? '' : '<p class="lmk-note">The radio at the shack is not set up for this frequency.</p>')
            + (lm.hear ? '<div class="lmk-sec"><b>What you’ll hear</b><p>' + esc(lm.hear) + '</p></div>' : '')
            + (lm.why ? '<div class="lmk-sec"><b>Why it matters</b><p>' + esc(lm.why) + '</p></div>' : '')
            + (lm.try ? '<div class="lmk-sec lmk-try"><b>Try this</b><p>' + esc(lm.try) + '</p></div>' : '')
            + '<div class="lmk-actions"><button type="button" class="lmk-btn lmk-btn-tint" data-act="tune">Tune ' + lm.khz + ' kHz</button>'
            + (lm.region ? '<span class="lmk-region">' + esc(lm.region) + '</span>' : '') + '</div>'
            + '</div>';
        }
        card.innerHTML = html;
        card.addEventListener('click', function(ev) {
          if (ev.target && ev.target.dataset && ev.target.dataset.act === 'tune') { ev.stopPropagation(); lmkTune(lm); return; }
          lmkOpenId = open ? null : lm.id;
          renderDirectoryTab();
        });
        dirList.appendChild(card);
      });
    });
    if (hidden.length) {
      var note = document.createElement('div');
      note.className = 'lmk-hidden-note';
      note.innerHTML = (lmkShowAll
        ? 'Greyed cards are outside the bands the radio at the shack is set up for. '
        : hidden.length + (hidden.length === 1 ? ' landmark is' : ' landmarks are') + ' hidden: the radio at the shack is not set up for '
          + (hidden.length === 1 ? 'its band' : 'their bands') + '. ')
        + '<button type="button" class="lmk-btn lmk-btn-plain">' + (lmkShowAll ? 'Hide them' : 'Show anyway') + '</button>';
      note.querySelector('button').addEventListener('click', function() { lmkShowAll = !lmkShowAll; renderDirectoryTab(); });
      dirList.appendChild(note);
    }
    lmkUpdateLive();
    if (!lmkTickTimer) lmkTickTimer = setInterval(function() {
      if (activeTab !== 'dir' || dirActiveTab !== 'landmarks') { clearInterval(lmkTickTimer); lmkTickTimer = null; return; }
      lmkUpdateLive();
    }, 1000);
  }
  function lmkUpdateLive() {
    var L = window.Landmarks;
    if (!L || !dirList) return;
    var now = Date.now();
    dirList.querySelectorAll('.lmk-now').forEach(function(el) {
      var b = L.beaconAt(el.dataset.khz, now);
      el.textContent = b ? ' · now ' + b.now.call : '';
    });
    dirList.querySelectorAll('.lmk-beacon').forEach(function(box) {
      var b = L.beaconAt(box.dataset.khz, now);
      if (!b) return;
      box.querySelector('.lmk-beacon-now').innerHTML = esc(b.now.call) + ' <span>' + esc(b.now.place) + '</span>';
      box.querySelector('.lmk-beacon-fill').style.width = Math.min(100, (b.secondsInto / 10) * 100) + '%';
      box.querySelector('.lmk-beacon-next').textContent = 'Next: ' + b.next.call + ', ' + b.next.place + ', in ' + Math.ceil(b.secondsLeft) + ' s';
    });
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
      var isTunedNet = n.frequency && currentFreqKhz && Math.abs(parseFloat(n.frequency) - currentFreqKhz) < 0.5;
      card.className = 'dir-card' + (cd.status === 'live' ? ' dir-live' : cd.status === 'soon' ? ' dir-soon' : '') + (isTunedNet ? ' tuned' : '');
      var statusHtml = cd.label ? '<span class="dir-card-status ' + cd.status + '">' + cd.label + '</span>' : '';
      card.innerHTML = '<div class="dir-card-row"><span class="dir-card-name">' + (n.name || 'Unknown') + '</span>' + statusHtml + '</div>' +
        '<div class="dir-card-detail"><span class="dir-card-freq">' + (n.frequency || '?') + ' kHz</span> ' + (n.mode || '') + (e.band ? ' \u00b7 ' + e.band : '') +
        (n.days && n.days !== 'Daily' ? ' \u00b7 ' + n.days : '') + '</div>';
      (function(net, band) {
        card.addEventListener('click', function() {
          if (!net.frequency) return;
          if (vfoLocked) {
            showToast('VFO Locked — Unlock VFO to change frequency', 2000);
            return;
          }
          var mode = (net.mode || '').toUpperCase();
          if (mode === 'SSB') {
            var lsbBands = { '160m': 1, '80m': 1, '60m': 1, '40m': 1 };
            mode = lsbBands[band] ? 'LSB' : 'USB';
          }
          var freqStr = String(net.frequency);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'tune', freqKhz: freqStr, mode: mode }));
          }
          // Local state update so (a) the matching net row in the spots
          // table gets the .tuned highlight when the user switches back,
          // and (b) the VFO op-card shows the net name instead of staying
          // on the last op/park. Net spots land in `spots` with
          // source:'net' and frequency matching net.frequency.
          var hz = parseFloat(freqStr) * 1000;
          if (hz > 100000) {
            freqDisplay.textContent = formatFreq(hz);
            currentFreqKhz = parseFloat(freqStr);
          }
          if (mode) modeBadge.textContent = mode;
          tunedFreqKhz = freqStr;
          tunedCallsign = net.name || 'HF Net';
          tunedOpName = '';
          tunedRef = 'HF NET';
          tunedSig = '';
          tunedState = '';
          tunedCountry = '';
          renderSpots();
          // Repaint the Dir list immediately so THIS net gets the tuned
          // ring (don't wait for the server's freq echo to round-trip).
          renderDirectoryTab();
        });
      })(n, e.band);
      dirList.appendChild(card);
    }
  }

  // --- Channels: the shack's saved frequency chart (lib/channels.js). Edited on
  // the desktop (Directory > Channels); a tap here tunes, and where the shack's
  // radio cannot reach it the shack's SDR plays it (lib/listen-source.js).
  function channelTuneMode(m) {
    var u = String(m || 'FM').toUpperCase();
    return (u === 'NFM' || u === 'WFM' || u === 'DIG' || u === 'DV') ? 'FM' : u;
  }
  function channelOffsetText(k) {
    k = Number(k) || 0;
    if (!k) return '';
    var a = Math.abs(k), sign = k > 0 ? '+' : '-';
    return a >= 1000 ? sign + (a / 1000).toFixed(a % 1000 ? 3 : 1).replace(/\.0$/, '') + ' MHz' : sign + a + ' kHz';
  }
  function renderDirChannels(search) {
    if (!directoryChannels.length) {
      dirList.innerHTML = '<div class="dir-empty">No channels yet. Add them on the desktop: Directory > Channels.</div>';
      return;
    }
    var rows = directoryChannels.filter(function(c) {
      if (!search) return true;
      return [c.name, c.note, c.group, c.mode].some(function(v) { return String(v || '').toLowerCase().indexOf(search) >= 0; })
        || String(c.khz).indexOf(search) >= 0 || (c.khz / 1000).toFixed(3).indexOf(search) >= 0;
    });
    var groups = [];
    rows.forEach(function(c) { var g = c.group || 'Other'; if (groups.indexOf(g) < 0) groups.push(g); });
    groups.forEach(function(g) {
      var head = document.createElement('div');
      head.className = 'lmk-group';
      head.textContent = g;
      dirList.appendChild(head);
      rows.filter(function(c) { return (c.group || 'Other') === g; }).forEach(function(c) {
        var card = document.createElement('div');
        card.className = 'dir-card';
        var mhz = (c.khz / 1000).toFixed(c.khz % 1 ? 5 : 4).replace(/0+$/, '').replace(/\.$/, '');
        var off = channelOffsetText(c.offsetKhz);
        card.innerHTML = '<div class="dir-card-row"><span class="dir-card-name"></span><span class="dir-card-freq"></span></div>'
          + '<div class="dir-card-detail"></div>';
        card.querySelector('.dir-card-name').textContent = c.name;
        card.querySelector('.dir-card-freq').textContent = mhz + ' ' + (c.mode || 'FM') + (off ? ' ' + off : '') + (c.tone ? ' T' + c.tone : '');
        card.querySelector('.dir-card-detail').textContent = c.note || '';
        card.addEventListener('click', function() {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tune', freqKhz: String(c.khz), mode: channelTuneMode(c.mode) }));
        });
        dirList.appendChild(card);
      });
    });
    if (!rows.length) dirList.innerHTML = '<div class="dir-empty">Nothing matches.</div>';
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
      var isTunedSwl = s.frequency && currentFreqKhz && Math.abs(parseFloat(s.frequency) - currentFreqKhz) < 0.5;
      card.className = 'dir-card' + (cd.status === 'live' ? ' dir-live' : cd.status === 'soon' ? ' dir-soon' : '') + (isTunedSwl ? ' tuned' : '');
      var statusHtml = cd.label ? '<span class="dir-card-status ' + cd.status + '">' + cd.label + '</span>' : '';
      card.innerHTML = '<div class="dir-card-row"><span class="dir-card-name">' + (s.station || 'Unknown') + '</span>' + statusHtml + '</div>' +
        '<div class="dir-card-detail"><span class="dir-card-freq">' + (s.frequency || '?') + ' kHz</span>' +
        (s.language ? ' \u00b7 ' + s.language : '') + (e.band ? ' \u00b7 ' + e.band : '') +
        (s.powerKw ? ' \u00b7 ' + s.powerKw + 'kW' : '') + '</div>';
      (function(swl) {
        card.addEventListener('click', function() {
          if (!swl.frequency) return;
          if (vfoLocked) {
            showToast('VFO Locked — Unlock VFO to change frequency', 2000);
            return;
          }
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

  // ── Billing (lib/cloud-billing-ui.js, inlined by the server) ──────
  // The trial countdown, the billing strip, subscribe and manage — the same
  // decision the desktop Cloud card draws from. A Guest Pass sees none of
  // it (not their account).
  var echoCloudSub = null;        // last subscription object
  var echoCloudBilling = null;    // its billing object
  var echoCloudStripeOk = true;   // false after stripe_not_configured
  var echoCloudPendingTab = null; // a tab opened on click, pointed at the URL when it arrives
  var echoCloudBannerDismissed = {};
  var echoCloudBannerCurrent = null;
  function echoCloudIsGuest() { return !!window.__echoGuestPass; }

  function echoCloudRenderBilling(sub) {
    var B = window.CloudBillingUi;
    echoCloudSub = sub || null;
    echoCloudBilling = (sub && sub.billing) || null;
    var strip = document.getElementById('echo-cloud-billing-strip');
    var trialLine = document.getElementById('echo-cloud-trial-line');
    var manageRow = document.getElementById('echo-cloud-manage-row');
    var manageBtn = document.getElementById('echo-cloud-manage-btn');
    var accessThrough = document.getElementById('echo-cloud-access-through');
    var subscribe = document.getElementById('echo-cloud-subscribe');
    var heading = document.getElementById('echo-cloud-subscribe-heading');
    var stripeBtns = document.getElementById('echo-cloud-stripe-buttons');
    var verifyToggle = document.getElementById('echo-cloud-verify-toggle');
    if (!B || !sub || echoCloudIsGuest()) {
      [strip, manageRow, subscribe].forEach(function (el) { if (el) el.classList.add('hidden'); });
      if (trialLine) trialLine.classList.add('hidden');
      return;
    }
    var d = B.describeBilling(sub, { stripeConfigured: echoCloudStripeOk });
    if (echoCloudSubStatus) {
      echoCloudSubStatus.textContent = d.pill.text;
      echoCloudSubStatus.style.color = d.pill.tone === 'ok' ? '#4ecca3' : d.pill.tone === 'warn' ? '#f0a500' : '#e94560';
    }
    if (trialLine) {
      if (d.trialLine) { trialLine.textContent = '— ' + d.trialLine.text.replace('Free trial — ', ''); trialLine.className = 'echo-trial-line' + (d.trialLine.urgent ? ' urgent' : ''); }
      else trialLine.className = 'echo-trial-line hidden';
    }
    if (strip) {
      if (d.strip) {
        strip.className = 'echo-billing-strip ' + d.strip.tone;
        strip.querySelector('.ebs-msg').textContent = d.strip.message;
        strip.querySelector('.ebs-action').textContent = d.strip.actionLabel;
      } else strip.className = 'echo-billing-strip hidden';
    }
    if (manageRow) {
      manageRow.classList.toggle('hidden', !(d.manage || d.accessThrough));
      if (manageBtn) { manageBtn.classList.toggle('hidden', !d.manage); if (d.manage) manageBtn.textContent = d.manage.label; }
      if (accessThrough) accessThrough.textContent = d.accessThrough || '';
    }
    if (subscribe) {
      subscribe.classList.toggle('hidden', !d.subscribe.show);
      if (heading) heading.textContent = d.subscribe.heading;
      if (stripeBtns) stripeBtns.classList.toggle('hidden', !d.subscribe.stripe);
    }
    if (verifyToggle) verifyToggle.classList.toggle('hidden', !d.verify.show);
    echoCloudRenderBanner(d);
  }

  function echoCloudRenderBanner(d) {
    var banner = document.getElementById('cloud-billing-banner');
    var text = document.getElementById('cloud-billing-banner-text');
    var action = document.getElementById('cloud-billing-banner-action');
    if (!banner) return;
    var b = d && d.banner;
    if (!b || echoCloudBannerDismissed[b.key] || echoCloudIsGuest()) { banner.className = 'hidden'; echoCloudBannerCurrent = null; return; }
    echoCloudBannerCurrent = b;
    banner.className = b.tone;
    if (text) text.textContent = b.message;
    if (action) action.textContent = b.actionLabel;
  }

  // Stripe URLs arrive over the WebSocket, so the tab is opened on the
  // click (synchronously, or the browser blocks it) and pointed at the URL
  // when it comes back; on an error the blank tab is closed.
  function echoCloudOpenLater() {
    try { echoCloudPendingTab = window.open('', '_blank'); } catch (e) { echoCloudPendingTab = null; }
  }
  function echoCloudResolveTab(url) {
    if (echoCloudPendingTab && !echoCloudPendingTab.closed) {
      if (url) { try { echoCloudPendingTab.location = url; } catch (e) { window.open(url, '_blank'); } }
      else { try { echoCloudPendingTab.close(); } catch (e) {} }
    } else if (url) {
      window.open(url, '_blank');
    }
    echoCloudPendingTab = null;
  }
  function echoCloudCheckout(plan) {
    if (!ws || ws.readyState !== 1) return;
    echoCloudOpenLater();
    ws.send(JSON.stringify({ type: 'cloud-stripe-checkout', plan: plan === 'yearly' ? 'yearly' : 'monthly' }));
  }
  function echoCloudPortal() {
    if (!ws || ws.readyState !== 1) return;
    echoCloudOpenLater();
    ws.send(JSON.stringify({ type: 'cloud-stripe-portal' }));
  }
  function echoCloudOpenBillingAction(b) {
    if (b && b.action && b.action.url) { window.open(b.action.url, '_blank'); return; }
    if (b && b.provider === 'stripe') { echoCloudPortal(); return; }
    window.open(window.CloudBillingUi ? window.CloudBillingUi.BMAC_MEMBERSHIP_URL : 'https://buymeacoffee.com/potacat/membership', '_blank');
  }
  function echoCloudOpenManage() {
    var m = window.CloudBillingUi ? window.CloudBillingUi.manageFor(echoCloudSub) : null;
    if (m && m.kind === 'portal') { if (m.url) window.open(m.url, '_blank'); else echoCloudPortal(); return; }
    if (m && m.url) { window.open(m.url, '_blank'); return; }
    window.open('https://buymeacoffee.com/potacat/membership', '_blank');
  }
  function echoCloudShowCheckoutWait(on) {
    var el = document.getElementById('echo-cloud-checkout-wait');
    if (el) el.classList.toggle('hidden', !on);
  }
  // Render hook for a live check (nothing in the page calls it).
  window.__echoCloudRender = echoCloudRenderBilling;

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
        if (msg.loggedIn) {
          echoCloudShowAccount(msg.user);
          echoCloudRenderBilling(msg.subscription || null);
          echoCloudShowCheckoutWait(!!(msg.checkout && msg.checkout.phase === 'waiting'));
          if (msg.checkout && msg.checkout.stripeConfigured === false) echoCloudStripeOk = false;
        } else {
          echoCloudShowLogin();
          echoCloudRenderBilling(null);
        }
        break;
      case 'cloud-billing-state':
        // Pushed by the desktop: launch check, checkout watch, any status
        // fetch. Repaint from the payload — never fetch again (that loops).
        if (msg.subscription) echoCloudRenderBilling(msg.subscription);
        break;
      case 'cloud-checkout-state':
        if (msg.stripeConfigured === false) echoCloudStripeOk = false;
        echoCloudShowCheckoutWait(msg.phase === 'waiting');
        if (msg.phase === 'active') { showToast('POTACAT Cloud is active. Thank you for subscribing.', 6000); echoCloudRefresh(); }
        if (msg.phase === 'timeout') echoCloudRefresh();
        break;
      case 'cloud-stripe-result':
        if (msg.error === 'stripe_not_configured') {
          echoCloudStripeOk = false;
          echoCloudResolveTab(window.CloudBillingUi ? window.CloudBillingUi.BMAC_MEMBERSHIP_URL : 'https://buymeacoffee.com/potacat/membership');
          echoCloudRenderBilling(echoCloudSub);
        } else if (msg.error === 'guest_pass') {
          echoCloudResolveTab(null);
          showToast('A Guest Pass cannot change the owner’s subscription.', 4000, true);
        } else if (msg.error) {
          echoCloudResolveTab(null);
          showToast('Could not open ' + (msg.kind === 'portal' ? 'your billing page' : 'checkout') + ': ' + (msg.message || msg.error), 5000, true);
        } else {
          echoCloudResolveTab(msg.url);
          if (msg.kind === 'checkout') echoCloudShowCheckoutWait(true);
        }
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
      if (!email || !pass) return echoCloudShowError('Enter your email or callsign, and your password');
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
      echoCloudVerifyToggle.textContent = echoCloudVerifyPanel.classList.contains('hidden') ? 'Paying on Buy Me a Coffee?' : 'Cancel';
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
      if (echoCloudVerifyToggle) echoCloudVerifyToggle.textContent = 'Paying on Buy Me a Coffee?';
    });
  }

  // Billing buttons (lib/cloud-billing-ui.js decides what is visible).
  (function echoCloudBillingInit() {
    var monthly = document.getElementById('echo-cloud-subscribe-monthly');
    var yearly = document.getElementById('echo-cloud-subscribe-yearly');
    var manage = document.getElementById('echo-cloud-manage-btn');
    var strip = document.getElementById('echo-cloud-billing-strip');
    var bannerAction = document.getElementById('cloud-billing-banner-action');
    var bannerDismiss = document.getElementById('cloud-billing-banner-dismiss');
    var banner = document.getElementById('cloud-billing-banner');
    if (monthly) monthly.addEventListener('click', function () { echoCloudCheckout('monthly'); });
    if (yearly) yearly.addEventListener('click', function () { echoCloudCheckout('yearly'); });
    if (manage) manage.addEventListener('click', echoCloudOpenManage);
    if (strip) strip.querySelector('.ebs-action').addEventListener('click', function () { echoCloudOpenBillingAction(echoCloudBilling); });
    if (bannerAction) bannerAction.addEventListener('click', function () {
      var b = echoCloudBannerCurrent;
      if (!b) return;
      if (b.action === 'subscribe') echoCloudCheckout(b.plan || 'monthly');
      else echoCloudOpenBillingAction(echoCloudBilling);
    });
    if (bannerDismiss) bannerDismiss.addEventListener('click', function () {
      if (echoCloudBannerCurrent) echoCloudBannerDismissed[echoCloudBannerCurrent.key] = true;
      if (banner) banner.className = 'hidden';
      echoCloudBannerCurrent = null;
    });
  })();

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
  var kiwiGainNodeE = null;
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
        try { ws.send(kiwiMsg); } catch (e) {}
        _kiwiConnecting = true;
        kiwiConnectedHostE = st.fullHost;
        kiwiSdrBtn.classList.add('kiwi-connecting');
        kiwiSdrBtn.textContent = st.label + '...';
      } else {
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
      try {
        // Use default sample rate (44100/48000) — browser resamples from 12kHz
        if (!kiwiAudioCtx) kiwiAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (!kiwiGainNodeE) {
          // Persistent gain node so TX-mute (VK3AWA) can cut the SDR audio
          // without tearing down the context.
          kiwiGainNodeE = kiwiAudioCtx.createGain();
          kiwiGainNodeE.gain.value = txState ? 0 : 1;
          kiwiGainNodeE.connect(kiwiAudioCtx.destination);
        }
        var sr = msg.sampleRate || 12000;
        var pcm = new Float32Array(msg.pcm);
        // Create buffer at the KiwiSDR's native sample rate — browser handles resampling
        var buf = kiwiAudioCtx.createBuffer(1, pcm.length, sr);
        buf.getChannelData(0).set(pcm);
        var src = kiwiAudioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(kiwiGainNodeE);
        var now = kiwiAudioCtx.currentTime;
        if (kiwiNextPlayTime < now) kiwiNextPlayTime = now;
        src.start(kiwiNextPlayTime);
        kiwiNextPlayTime += pcm.length / sr;
      } catch (e) {
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

  // ── SSTV Phone Logic ────────────────────────────────────

  var sstvPhoneRxActive = false;
  var sstvPhoneTxBar = document.getElementById('sstv-phone-tx-bar');
  var sstvPhoneTxProgress = document.getElementById('sstv-phone-tx-progress');
  var sstvPhoneTxTime = document.getElementById('sstv-phone-tx-time');
  var sstvPhoneHaltBtn = document.getElementById('sstv-phone-halt-btn');
  var sstvPhoneTxTimer = null;
  var sstvPhoneTxStart = 0;
  var sstvPhoneTxDuration = 0;

  if (sstvPhoneHaltBtn) {
    sstvPhoneHaltBtn.addEventListener('click', function() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'sstv-halt-tx' }));
      }
      if (sstvPhoneStatus) { sstvPhoneStatus.textContent = 'HALTing TX...'; sstvPhoneStatus.style.color = '#e94560'; }
      sstvPhoneStopTxProgress();
    });
  }

  function formatSec(s) {
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function sstvPhoneStartTxProgress(durationSec) {
    sstvPhoneTxDuration = durationSec;
    sstvPhoneTxStart = Date.now();
    if (sstvPhoneTxBar) sstvPhoneTxBar.style.display = '';
    if (sstvPhoneTxProgress) sstvPhoneTxProgress.style.width = '0%';
    if (sstvPhoneTxTime) sstvPhoneTxTime.textContent = '0:00 / ' + formatSec(durationSec);
    if (sstvPhoneTxTimer) clearInterval(sstvPhoneTxTimer);
    sstvPhoneTxTimer = setInterval(function() {
      var elapsed = (Date.now() - sstvPhoneTxStart) / 1000;
      var pct = sstvPhoneTxDuration > 0 ? Math.min(100, elapsed / sstvPhoneTxDuration * 100) : 0;
      var remaining = Math.max(0, sstvPhoneTxDuration - elapsed);
      if (sstvPhoneTxProgress) sstvPhoneTxProgress.style.width = pct + '%';
      if (sstvPhoneTxTime) sstvPhoneTxTime.textContent = formatSec(elapsed) + ' / ' + formatSec(sstvPhoneTxDuration);
      if (elapsed >= sstvPhoneTxDuration + 2) sstvPhoneStopTxProgress();
    }, 500);
  }

  function sstvPhoneStopTxProgress() {
    if (sstvPhoneTxTimer) { clearInterval(sstvPhoneTxTimer); sstvPhoneTxTimer = null; }
    if (sstvPhoneTxBar) sstvPhoneTxBar.style.display = 'none';
    if (sstvPhoneTxProgress) sstvPhoneTxProgress.style.width = '0%';
  }
  var sstvPhoneWfCanvas = document.getElementById('sstv-phone-wf');
  var sstvPhoneWfCtx = sstvPhoneWfCanvas ? sstvPhoneWfCanvas.getContext('2d') : null;
  var sstvPhoneWfWrap = document.getElementById('sstv-phone-wf-wrap');
  var sstvPhoneWfToggle = document.getElementById('sstv-phone-wf-toggle');
  var sstvPhoneWfVisible = false;

  if (sstvPhoneWfToggle) {
    sstvPhoneWfToggle.addEventListener('click', function() {
      sstvPhoneWfVisible = !sstvPhoneWfVisible;
      if (sstvPhoneWfWrap) sstvPhoneWfWrap.style.display = sstvPhoneWfVisible ? '' : 'none';
      sstvPhoneWfToggle.style.background = sstvPhoneWfVisible ? 'var(--accent)' : 'transparent';
      sstvPhoneWfToggle.style.color = sstvPhoneWfVisible ? '#fff' : 'var(--text-dim)';
    });
  }

  function sstvPhoneDrawWfLine(bins) {
    if (!sstvPhoneWfVisible || !sstvPhoneWfCtx || !bins) return;
    var w = sstvPhoneWfCanvas.width, h = sstvPhoneWfCanvas.height;
    // Scroll down
    var imgData = sstvPhoneWfCtx.getImageData(0, 0, w, h);
    sstvPhoneWfCtx.putImageData(imgData, 0, 1);
    // Draw new line
    var lineData = sstvPhoneWfCtx.createImageData(w, 1);
    var d = lineData.data;
    var binCount = bins.length;
    for (var x = 0; x < w; x++) {
      var bi = Math.floor(x * binCount / w);
      var v = Math.max(0, Math.min(1, (bins[bi] || 0) / 255));
      var r, g, b;
      if (v < 0.2)      { r = 0; g = 0; b = Math.round(v / 0.2 * 180); }
      else if (v < 0.4) { r = 0; g = Math.round((v-0.2)/0.2*200); b = 180; }
      else if (v < 0.6) { r = 0; g = 200; b = Math.round(180-(v-0.4)/0.2*180); }
      else if (v < 0.8) { r = Math.round((v-0.6)/0.2*255); g = 200+Math.round((v-0.6)/0.2*55); b = 0; }
      else              { r = 255; g = 255; b = Math.round((v-0.8)/0.2*255); }
      var idx = x * 4;
      d[idx] = r; d[idx+1] = g; d[idx+2] = b; d[idx+3] = 255;
    }
    sstvPhoneWfCtx.putImageData(lineData, 0, 0);
  }

  var sstvFreqPhone = document.getElementById('sstv-freq-phone');
  var sstvModePhone = document.getElementById('sstv-mode-phone');
  var sstvCameraBtn = document.getElementById('sstv-camera-btn');
  var sstvGalleryPickBtn = document.getElementById('sstv-gallery-pick-btn');

  // Restore saved SSTV decode mode preference (not frequency — radio is source of truth)
  try {
    var savedMode = localStorage.getItem('sstv-phone-mode');
    if (savedMode && sstvModePhone) sstvModePhone.value = savedMode;
  } catch (e) {}

  // Frequency dropdown — QSY on change + save
  if (sstvFreqPhone) {
    sstvFreqPhone.addEventListener('change', function() {
      var opt = sstvFreqPhone.options[sstvFreqPhone.selectedIndex];
      // SSTV is USB on all HF bands by convention — never default to LSB here
      // even if the option somehow lacks an explicit data-mode attribute.
      var mode = (opt && opt.dataset.mode) || 'USB';
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tune', freqKhz: sstvFreqPhone.value, mode: mode }));
      try { localStorage.setItem('sstv-phone-freq', sstvFreqPhone.value); } catch (e) {}
    });
  }

  // Mode dropdown — save on change
  if (sstvModePhone) {
    sstvModePhone.addEventListener('change', function() {
      try { localStorage.setItem('sstv-phone-mode', sstvModePhone.value); } catch (e) {}
    });
  }
  var sstvRandomPhoneBtn = document.getElementById('sstv-random-phone-btn');
  var sstvSendBtn = document.getElementById('sstv-send-btn');
  var sstvPhoneAddTextBtn = document.getElementById('sstv-phone-add-text');
  var sstvPhoneTextLayersEl = document.getElementById('sstv-phone-text-layers');
  var sstvPhoneTextEditor = document.getElementById('sstv-phone-text-editor');
  var sstvPhoneTplStrip = document.getElementById('sstv-phone-tpl-strip');
  var sstvPhoneTplSection = document.getElementById('sstv-phone-tpl-section');
  var sstvFileInput = document.getElementById('sstv-phone-file-input');

  // Text elements — synced from desktop templates/settings, editable on phone
  var sstvPhoneTexts = [
    { key: 'cq', label: 'CQ SSTV', x: 8, y: 22, fontSize: 18, bold: true, italic: false, color: '#ffffff', rotation: 0, visible: true },
    { key: 'call', label: '', x: 8, y: 44, fontSize: 20, bold: true, italic: false, color: '#ffffff', rotation: 0, visible: true },
    { key: 'grid', label: '', x: 8, y: 66, fontSize: 14, bold: false, italic: false, color: '#ffffff', rotation: 0, visible: true },
  ];
  var sstvPhoneSelectedText = null;
  var sstvPhoneTemplates = [];
  var sstvPhoneUserTextCount = 0;

  // Load templates + text elements from settings received on auth
  function sstvPhoneLoadSettings() {
    if (!echoSettings) return;
    // An empty list is news too (the last template deleted, here or on
    // another machine): keeping the stale copy would save it back.
    if (Array.isArray(echoSettings.sstvTemplates)) {
      sstvPhoneTemplates = echoSettings.sstvTemplates;
    }
    sstvPhoneRenderTemplates();
    if (echoSettings.sstvTextElements && echoSettings.sstvTextElements.length) {
      sstvPhoneTexts = echoSettings.sstvTextElements.map(function(t) {
        return { key: t.key, label: t.label || '', x: t.x, y: t.y, fontSize: t.fontSize || 14, bold: !!t.bold, italic: !!t.italic, color: t.color || '#ffffff', rotation: t.rotation || 0, visible: t.visible !== false };
      });
      sstvPhoneUserTextCount = sstvPhoneTexts.filter(function(t) { return t.key.indexOf('user-') === 0; }).length;
    }
    // Fill auto-labels
    var callEl = sstvPhoneTexts.find(function(t) { return t.key === 'call'; });
    if (callEl) callEl.label = myCallsign ? 'de ' + myCallsign.toUpperCase() : '';
    var gridEl = sstvPhoneTexts.find(function(t) { return t.key === 'grid'; });
    if (gridEl) gridEl.label = phoneGrid ? phoneGrid.toUpperCase() : '';
    sstvPhoneRenderTextLayers();
    sstvRenderPhoneCompose();
  }

  // --- Templates strip ---
  function sstvPhoneRenderTemplates() {
    if (!sstvPhoneTplStrip) return;
    sstvPhoneTplStrip.innerHTML = '';
    if (sstvPhoneTplSection) sstvPhoneTplSection.style.display = '';
    if (sstvPhoneTemplates.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:16px 4px;';
      empty.textContent = 'No templates yet — tap + Save to store the current compose.';
      sstvPhoneTplStrip.appendChild(empty);
      return;
    }
    for (var i = 0; i < sstvPhoneTemplates.length; i++) {
      (function(idx) {
        var tpl = sstvPhoneTemplates[idx];
        var div = document.createElement('div');
        div.style.cssText = 'position:relative;flex-shrink:0;border:2px solid transparent;border-radius:4px;overflow:hidden;cursor:pointer;';
        var img = document.createElement('img');
        img.src = tpl.thumbnail || '';
        img.style.cssText = 'display:block;height:50px;width:auto;';
        div.appendChild(img);
        div.addEventListener('click', function() { sstvPhoneLoadTemplate(idx); });
        // Long-press (or right-click) to delete
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = 'x';
        delBtn.title = 'Delete template';
        delBtn.style.cssText = 'position:absolute;top:1px;right:1px;width:16px;height:16px;padding:0;line-height:14px;font-size:11px;border:0;border-radius:8px;background:rgba(0,0,0,0.6);color:#fff;cursor:pointer;';
        delBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          sstvPhoneDeleteTemplate(idx);
        });
        div.appendChild(delBtn);
        sstvPhoneTplStrip.appendChild(div);
      })(i);
    }
  }

  // --- Save current compose as template ---
  function sstvPhoneSaveTemplate() {
    if (sstvPhoneTemplates.length >= 12) {
      if (sstvPhoneStatus) sstvPhoneStatus.textContent = 'Max 12 templates — delete one first';
      return;
    }
    if (!sstvPhoneCompose) return;
    // Thumbnail from the current compose canvas (includes bg + text)
    var thumbC = document.createElement('canvas');
    var thumbScale = 70 / sstvPhoneCompose.width;
    thumbC.width = 70;
    thumbC.height = Math.round(sstvPhoneCompose.height * thumbScale);
    thumbC.getContext('2d').drawImage(sstvPhoneCompose, 0, 0, thumbC.width, thumbC.height);
    var thumbnail = thumbC.toDataURL('image/png');
    // Background — render the cropped bg only (no text) to a 320x256 canvas so
    // the phone/desktop can re-apply it without re-running the crop math.
    var bgDataUrl = null;
    if (sstvPhoneBg) {
      var bgC = document.createElement('canvas');
      bgC.width = 320; bgC.height = 256;
      var bgCtx = bgC.getContext('2d');
      var srcW = sstvPhoneBg.width || sstvPhoneBg.naturalWidth || 320;
      var srcH = sstvPhoneBg.height || sstvPhoneBg.naturalHeight || 256;
      var fitScale = Math.max(320 / srcW, 256 / srcH);
      var totalScale = fitScale * sstvPhoneBgZoom;
      var visW = 320 / totalScale;
      var visH = 256 / totalScale;
      var cx = srcW / 2 + sstvPhoneBgPanX;
      var cy = srcH / 2 + sstvPhoneBgPanY;
      var sx = Math.max(0, Math.min(srcW - visW, cx - visW / 2));
      var sy = Math.max(0, Math.min(srcH - visH, cy - visH / 2));
      bgCtx.drawImage(sstvPhoneBg, sx, sy, visW, visH, 0, 0, 320, 256);
      bgDataUrl = bgC.toDataURL('image/jpeg', 0.85);
    }
    var tpl = {
      bgParams: null,
      bgDataUrl: bgDataUrl,
      texts: sstvPhoneTexts.map(function(t) {
        return { key: t.key, x: t.x, y: t.y, fontSize: t.fontSize, bold: t.bold, italic: t.italic, color: t.color, rotation: t.rotation || 0, visible: t.visible, label: t.label };
      }),
      thumbnail: thumbnail,
    };
    sstvPhoneTemplates.push(tpl);
    sstvPhoneRenderTemplates();
    // Persist to desktop settings so both sides stay in sync
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'save-settings', settings: { sstvTemplates: sstvPhoneTemplates } }));
    }
    if (sstvPhoneStatus) sstvPhoneStatus.textContent = 'Template saved (' + sstvPhoneTemplates.length + ')';
  }

  function sstvPhoneDeleteTemplate(idx) {
    if (idx < 0 || idx >= sstvPhoneTemplates.length) return;
    sstvPhoneTemplates.splice(idx, 1);
    sstvPhoneRenderTemplates();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'save-settings', settings: { sstvTemplates: sstvPhoneTemplates } }));
    }
  }

  var sstvPhoneTplSaveBtn = document.getElementById('sstv-phone-tpl-save');
  if (sstvPhoneTplSaveBtn) sstvPhoneTplSaveBtn.addEventListener('click', sstvPhoneSaveTemplate);

  function sstvPhoneLoadTemplate(idx) {
    var tpl = sstvPhoneTemplates[idx];
    if (!tpl) return;
    try {
      // Restore text elements
      if (Array.isArray(tpl.texts)) {
        sstvPhoneTexts = tpl.texts.map(function(t) {
          return { key: t.key, label: t.label || '', x: t.x, y: t.y, fontSize: t.fontSize || 14, bold: !!t.bold, italic: !!t.italic, color: t.color || '#ffffff', rotation: t.rotation || 0, visible: t.visible !== false };
        });
      }
      // Fill auto-labels with current callsign/grid
      var callEl = sstvPhoneTexts.find(function(t) { return t.key === 'call'; });
      if (callEl) callEl.label = myCallsign ? 'de ' + myCallsign.toUpperCase() : '';
      var gridEl = sstvPhoneTexts.find(function(t) { return t.key === 'grid'; });
      if (gridEl) gridEl.label = phoneGrid ? phoneGrid.toUpperCase() : '';
      sstvPhoneUserTextCount = sstvPhoneTexts.filter(function(t) { return t.key.indexOf('user-') === 0; }).length;
      sstvPhoneSelectedText = null;
      sstvPhoneRenderTextLayers();
      sstvPhoneHideEditor();
      // Restore background — render text layers first so the user gets instant
      // feedback, then update bg asynchronously if it's a data URL.
      sstvPhoneResetCrop();
      if (tpl.bgDataUrl) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        // Paint texts with the (still-old) bg immediately so the user sees the
        // template took effect. The bg swaps in when the image decodes.
        sstvRenderPhoneCompose();
        var applyBg = function() { try { sstvPhoneSetBg(img, true); } catch (e) { console.error('[SSTV] setBg failed:', e); } };
        var decodeFail = function(err) {
          console.error('[SSTV] Template bg image failed to load:', err);
          if (sstvPhoneStatus) sstvPhoneStatus.textContent = 'Template bg decode failed';
        };
        // Prefer Image.decode() on iOS — onload is unreliable with large data URLs
        if (typeof img.decode === 'function') {
          img.src = tpl.bgDataUrl;
          img.decode().then(applyBg).catch(function(err) {
            // Fall back to onload in case decode() rejected on an early race
            img.onload = applyBg;
            img.onerror = function() { decodeFail(err); };
          });
        } else {
          img.onload = applyBg;
          img.onerror = function() { decodeFail(new Error('onerror')); };
          img.src = tpl.bgDataUrl;
        }
      } else if (tpl.bgParams) {
        sstvPhoneGeneratePattern(tpl.bgParams);
        if (sstvCropBar) sstvCropBar.style.display = 'none';
        sstvRenderPhoneCompose();
      } else {
        // Template has no bg — just repaint with the new text layers
        sstvRenderPhoneCompose();
      }
      if (sstvPhoneStatus) {
        sstvPhoneStatus.style.color = 'var(--pota)';
        sstvPhoneStatus.textContent = 'Template ' + (idx + 1) + ' loaded';
      }
    } catch (err) {
      console.error('[SSTV] Template load failed:', err);
      if (sstvPhoneStatus) sstvPhoneStatus.textContent = 'Template load failed: ' + (err && err.message ? err.message : String(err));
    }
  }

  // --- Text layer list ---
  function sstvPhoneRenderTextLayers() {
    if (!sstvPhoneTextLayersEl) return;
    sstvPhoneTextLayersEl.innerHTML = '';
    for (var i = 0; i < sstvPhoneTexts.length; i++) {
      (function(idx) {
        var t = sstvPhoneTexts[idx];
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;font-size:13px;cursor:pointer;border:1px solid ' + (t === sstvPhoneSelectedText ? 'var(--accent)' : 'transparent') + ';background:' + (t === sstvPhoneSelectedText ? 'rgba(79,195,247,0.1)' : 'transparent') + ';';
        // Visibility checkbox
        var vis = document.createElement('input');
        vis.type = 'checkbox'; vis.checked = t.visible;
        vis.style.cssText = 'width:16px;height:16px;';
        vis.addEventListener('change', function() { t.visible = vis.checked; sstvRenderPhoneCompose(); });
        row.appendChild(vis);
        // Color swatch
        var sw = document.createElement('span');
        sw.style.cssText = 'width:12px;height:12px;border-radius:2px;border:1px solid rgba(255,255,255,0.2);flex-shrink:0;background:' + (t.color || '#fff') + ';';
        row.appendChild(sw);
        // Label
        var lbl = document.createElement('span');
        lbl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);';
        var name = t.key === 'call' ? 'Callsign' : t.key === 'grid' ? 'Grid' : t.key === 'cq' ? 'CQ SSTV' : (t.label || '(empty)');
        var style = (t.bold ? 'B' : '') + (t.italic ? 'I' : '');
        lbl.textContent = name + (style ? ' [' + style + ']' : '') + ' ' + t.fontSize + 'px';
        row.appendChild(lbl);
        // Delete (user-created only)
        if (t.key.indexOf('user-') === 0) {
          var del = document.createElement('button');
          del.textContent = '\u2715';
          del.style.cssText = 'background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:14px;padding:0 3px;';
          del.addEventListener('click', function(e) {
            e.stopPropagation();
            sstvPhoneTexts.splice(idx, 1);
            if (sstvPhoneSelectedText === t) { sstvPhoneSelectedText = null; sstvPhoneHideEditor(); }
            sstvPhoneRenderTextLayers(); sstvRenderPhoneCompose();
          });
          row.appendChild(del);
        }
        row.addEventListener('click', function(e) {
          if (e.target === vis) return;
          sstvPhoneSelectedText = t;
          sstvPhoneRenderTextLayers();
          sstvPhoneShowEditor(t);
        });
        sstvPhoneTextLayersEl.appendChild(row);
      })(i);
    }
  }

  // --- Text property editor ---
  function sstvPhoneShowEditor(t) {
    if (!sstvPhoneTextEditor) return;
    sstvPhoneTextEditor.style.display = 'flex';
    var textIn = document.getElementById('sstv-phone-te-text');
    var sizeIn = document.getElementById('sstv-phone-te-size');
    var boldBtn = document.getElementById('sstv-phone-te-bold');
    var italicBtn = document.getElementById('sstv-phone-te-italic');
    var colorIn = document.getElementById('sstv-phone-te-color');
    var isAuto = (t.key === 'call' || t.key === 'grid');
    textIn.value = isAuto ? '' : t.label;
    textIn.placeholder = isAuto ? (t.key === 'call' ? 'Callsign (auto)' : 'Grid (auto)') : 'Text...';
    textIn.disabled = isAuto;
    textIn.style.opacity = isAuto ? '0.5' : '1';
    sizeIn.value = t.fontSize;
    boldBtn.style.background = t.bold ? 'var(--accent)' : 'transparent';
    boldBtn.style.color = t.bold ? '#000' : 'var(--text-dim)';
    italicBtn.style.background = t.italic ? 'var(--accent)' : 'transparent';
    italicBtn.style.color = t.italic ? '#000' : 'var(--text-dim)';
    colorIn.value = t.color || '#ffffff';
    // Wire events (remove old listeners by replacing elements)
    var newText = textIn.cloneNode(true);
    textIn.parentNode.replaceChild(newText, textIn);
    newText.addEventListener('input', function() { t.label = newText.value; sstvRenderPhoneCompose(); });
    var newSize = sizeIn.cloneNode(true);
    sizeIn.parentNode.replaceChild(newSize, sizeIn);
    newSize.addEventListener('change', function() { t.fontSize = Math.max(8, Math.min(40, parseInt(newSize.value) || 14)); sstvPhoneRenderTextLayers(); sstvRenderPhoneCompose(); });
    var newBold = boldBtn.cloneNode(true);
    boldBtn.parentNode.replaceChild(newBold, boldBtn);
    newBold.addEventListener('click', function() { t.bold = !t.bold; sstvPhoneShowEditor(t); sstvPhoneRenderTextLayers(); sstvRenderPhoneCompose(); });
    var newItalic = italicBtn.cloneNode(true);
    italicBtn.parentNode.replaceChild(newItalic, italicBtn);
    newItalic.addEventListener('click', function() { t.italic = !t.italic; sstvPhoneShowEditor(t); sstvPhoneRenderTextLayers(); sstvRenderPhoneCompose(); });
    var newColor = colorIn.cloneNode(true);
    colorIn.parentNode.replaceChild(newColor, colorIn);
    newColor.addEventListener('input', function() { t.color = newColor.value; sstvPhoneRenderTextLayers(); sstvRenderPhoneCompose(); });
  }

  function sstvPhoneHideEditor() {
    if (sstvPhoneTextEditor) sstvPhoneTextEditor.style.display = 'none';
  }

  // Add text layer
  if (sstvPhoneAddTextBtn) {
    sstvPhoneAddTextBtn.addEventListener('click', function() {
      sstvPhoneUserTextCount++;
      var newY = sstvPhoneTexts.length > 0 ? sstvPhoneTexts[sstvPhoneTexts.length - 1].y + 20 : 22;
      var t = { key: 'user-' + sstvPhoneUserTextCount, label: 'Text', x: 8, y: Math.min(newY, 240), fontSize: 14, bold: false, italic: false, color: '#ffffff', rotation: 0, visible: true };
      sstvPhoneTexts.push(t);
      sstvPhoneSelectedText = t;
      sstvPhoneRenderTextLayers();
      sstvPhoneShowEditor(t);
      sstvRenderPhoneCompose();
    });
  }

  // --- Canvas touch drag for text repositioning + reply inset ---
  if (sstvPhoneCompose) {
    let insetDrag = null; // { ox, oy } when dragging the reply inset
    sstvPhoneCompose.addEventListener('touchstart', function(e) {
      var touch = e.touches[0];
      var rect = sstvPhoneCompose.getBoundingClientRect();
      var sx = sstvPhoneCompose.width / rect.width;
      var sy = sstvPhoneCompose.height / rect.height;
      var mx = (touch.clientX - rect.left) * sx;
      var my = (touch.clientY - rect.top) * sy;
      // Reply inset takes hit-test priority — it's drawn on top
      if (sstvPhoneReplyImage && sstvPhoneReplyInset._drawW) {
        var ix = sstvPhoneReplyInset._drawX;
        var iy = sstvPhoneReplyInset._drawY;
        var iw = sstvPhoneReplyInset._drawW;
        var ih = sstvPhoneReplyInset._drawH;
        if (mx >= ix && mx <= ix + iw && my >= iy && my <= iy + ih) {
          insetDrag = { ox: mx - ix, oy: my - iy };
          e.preventDefault();
          return;
        }
      }
      // Hit test text elements
      for (var i = sstvPhoneTexts.length - 1; i >= 0; i--) {
        var t = sstvPhoneTexts[i];
        if (!t.visible || !t.label) continue;
        sstvPhoneComposeCtx.font = (t.italic ? 'italic ' : '') + (t.bold ? 'bold ' : '') + t.fontSize + 'px sans-serif';
        var metrics = sstvPhoneComposeCtx.measureText(t.label);
        if (mx >= t.x && mx <= t.x + metrics.width && my >= t.y - t.fontSize && my <= t.y + 2) {
          sstvPhoneSelectedText = t;
          sstvPhoneSelectedText._dragOx = mx - t.x;
          sstvPhoneSelectedText._dragOy = my - t.y;
          sstvPhoneRenderTextLayers();
          sstvPhoneShowEditor(t);
          e.preventDefault();
          return;
        }
      }
    }, { passive: false });

    sstvPhoneCompose.addEventListener('touchmove', function(e) {
      var touch = e.touches[0];
      var rect = sstvPhoneCompose.getBoundingClientRect();
      var sx = sstvPhoneCompose.width / rect.width;
      var sy = sstvPhoneCompose.height / rect.height;
      var mx = (touch.clientX - rect.left) * sx;
      var my = (touch.clientY - rect.top) * sy;
      if (insetDrag) {
        sstvPhoneReplyInset.x = Math.max(0, Math.min(sstvPhoneCompose.width - sstvPhoneReplyInset._drawW, mx - insetDrag.ox));
        sstvPhoneReplyInset.y = Math.max(0, Math.min(sstvPhoneCompose.height - sstvPhoneReplyInset._drawH, my - insetDrag.oy));
        sstvRenderPhoneCompose();
        e.preventDefault();
        return;
      }
      if (!sstvPhoneSelectedText || !sstvPhoneSelectedText._dragOx) return;
      sstvPhoneSelectedText.x = Math.max(0, Math.min(sstvPhoneCompose.width - 10, mx - sstvPhoneSelectedText._dragOx));
      sstvPhoneSelectedText.y = Math.max(sstvPhoneSelectedText.fontSize, Math.min(sstvPhoneCompose.height, my - sstvPhoneSelectedText._dragOy));
      sstvRenderPhoneCompose();
      e.preventDefault();
    }, { passive: false });

    sstvPhoneCompose.addEventListener('touchend', function() {
      insetDrag = null;
      if (sstvPhoneSelectedText) delete sstvPhoneSelectedText._dragOx;
    });
  }

  // --- Camera ---
  if (sstvCameraBtn) {
    sstvCameraBtn.addEventListener('click', async function() {
      try {
        if (sstvCameraStream) { sstvCaptureFrame(); return; }
        sstvCameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        sstvCameraPreview.srcObject = sstvCameraStream;
        sstvCameraPreview.style.display = 'block';
        sstvCameraBtn.textContent = 'Capture';
      } catch (err) {
        if (sstvPhoneStatus) sstvPhoneStatus.textContent = 'Camera error: ' + err.message;
      }
    });
  }

  function sstvCaptureFrame() {
    if (!sstvCameraStream || !sstvCameraPreview.videoWidth) return;
    var c = document.createElement('canvas');
    c.width = sstvCameraPreview.videoWidth; c.height = sstvCameraPreview.videoHeight;
    c.getContext('2d').drawImage(sstvCameraPreview, 0, 0);
    sstvCameraStream.getTracks().forEach(function(t) { t.stop(); });
    sstvCameraStream = null;
    sstvCameraPreview.style.display = 'none';
    sstvCameraBtn.textContent = 'Camera';
    sstvPhoneSetBg(c, true);
  }

  // --- Image crop/zoom/pan ---
  var sstvCropBar = document.getElementById('sstv-phone-crop-bar');
  var sstvZoomLabel = document.getElementById('sstv-phone-zoom-label');

  function sstvPhoneResetCrop() {
    sstvPhoneBgZoom = 1.0;
    sstvPhoneBgPanX = 0;
    sstvPhoneBgPanY = 0;
    sstvPhoneUpdateCropUI();
  }

  function sstvPhoneSetBg(imgOrCanvas, showCrop) {
    sstvPhoneBg = imgOrCanvas;
    sstvPhoneResetCrop();
    if (sstvCropBar) sstvCropBar.style.display = showCrop ? 'flex' : 'none';
    sstvRenderPhoneCompose();
  }

  // Receive live compose state from desktop POTACAT (background + texts)
  function sstvPhoneApplyComposeState(msg) {
    if (msg.texts && Array.isArray(msg.texts)) {
      sstvPhoneTexts = msg.texts.map(function(t) {
        return {
          key: t.key, label: t.label || '',
          x: t.x, y: t.y, fontSize: t.fontSize || 14,
          bold: !!t.bold, italic: !!t.italic,
          color: t.color || '#ffffff', rotation: t.rotation || 0,
          visible: t.visible !== false,
        };
      });
      sstvPhoneUserTextCount = sstvPhoneTexts.filter(function(t) { return t.key && t.key.indexOf('user-') === 0; }).length;
      sstvPhoneRenderTextLayers();
    }
    if (msg.bgDataUrl) {
      var img = new Image();
      img.onload = function() { sstvPhoneSetBg(img, false); };
      img.src = msg.bgDataUrl;
    } else {
      // Desktop has no background currently — keep whatever the phone has
      sstvRenderPhoneCompose();
    }
  }

  function sstvPhoneUpdateCropUI() {
    if (sstvZoomLabel) sstvZoomLabel.textContent = sstvPhoneBgZoom.toFixed(1) + 'x';
  }

  // Zoom buttons
  var zoomInBtn = document.getElementById('sstv-phone-zoom-in');
  var zoomOutBtn = document.getElementById('sstv-phone-zoom-out');
  var cropResetBtn = document.getElementById('sstv-phone-crop-reset');
  if (zoomInBtn) zoomInBtn.addEventListener('click', function() {
    sstvPhoneBgZoom = Math.min(5.0, sstvPhoneBgZoom + 0.2);
    sstvPhoneUpdateCropUI(); sstvRenderPhoneCompose();
  });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', function() {
    sstvPhoneBgZoom = Math.max(0.5, sstvPhoneBgZoom - 0.2);
    sstvPhoneUpdateCropUI(); sstvRenderPhoneCompose();
  });
  if (cropResetBtn) cropResetBtn.addEventListener('click', function() {
    sstvPhoneResetCrop(); sstvRenderPhoneCompose();
  });

  // Touch pan on compose canvas (when dragging background, not text)
  var _bgPanActive = false;
  var _bgPanLastX = 0, _bgPanLastY = 0;

  if (sstvPhoneCompose) {
    // Pan starts if touch doesn't hit text — fires after text touchstart handler
    // Uses a tiny delay so text handler's preventDefault() can claim the touch first
    sstvPhoneCompose.addEventListener('touchstart', function(e) {
      if (!sstvPhoneBg || sstvPhoneBgZoom <= 1.0) return;
      // If text drag is already active, don't start pan
      if (sstvPhoneSelectedText && sstvPhoneSelectedText._dragOx != null) return;
      var touch = e.touches[0];
      _bgPanActive = true;
      _bgPanLastX = touch.clientX;
      _bgPanLastY = touch.clientY;
    }, { passive: true });

    sstvPhoneCompose.addEventListener('touchmove', function(e) {
      if (!_bgPanActive) return;
      var touch = e.touches[0];
      var rect = sstvPhoneCompose.getBoundingClientRect();
      // Convert screen pixel delta to source image pixel delta
      var srcW = sstvPhoneBg.width || sstvPhoneBg.naturalWidth || 320;
      var srcH = sstvPhoneBg.height || sstvPhoneBg.naturalHeight || 256;
      var baseScale = Math.max(320 / srcW, 256 / srcH);
      var effectiveScale = baseScale * sstvPhoneBgZoom;
      // How many source pixels per screen pixel
      var screenToSrc = 1 / (effectiveScale * (rect.width / 320));
      var dx = (touch.clientX - _bgPanLastX) * screenToSrc;
      var dy = (touch.clientY - _bgPanLastY) * screenToSrc;
      sstvPhoneBgPanX -= dx;
      sstvPhoneBgPanY -= dy;
      _bgPanLastX = touch.clientX;
      _bgPanLastY = touch.clientY;
      sstvRenderPhoneCompose();
      e.preventDefault();
    }, { passive: false });

    sstvPhoneCompose.addEventListener('touchend', function() {
      _bgPanActive = false;
    });
  }

  // --- Photo picker (from phone gallery) ---
  if (sstvGalleryPickBtn && sstvFileInput) {
    sstvGalleryPickBtn.addEventListener('click', function() { sstvFileInput.click(); });
    sstvFileInput.addEventListener('change', function() {
      var file = sstvFileInput.files && sstvFileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function() {
        var img = new Image();
        img.onload = function() { sstvPhoneSetBg(img, true); };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
      sstvFileInput.value = '';
    });
  }

  // --- Random pattern ---
  if (sstvRandomPhoneBtn) {
    sstvRandomPhoneBtn.addEventListener('click', function() {
      sstvPhoneGeneratePattern(null);
      sstvPhoneResetCrop();
      if (sstvCropBar) sstvCropBar.style.display = 'none'; // patterns don't need crop
      sstvRenderPhoneCompose();
    });
  }

  function sstvPhoneGeneratePattern(params) {
    var c = document.createElement('canvas');
    c.width = 320; c.height = 256;
    var ctx2 = c.getContext('2d');
    var imgData = ctx2.createImageData(320, 256);
    var d = imgData.data;
    // Only plasma params are supported on the phone. For other desktop pattern
    // types (gradient/waves/geometric), fall back to a random plasma instead
    // of producing garbage from undefined seed fields.
    var seed = (params && params.seed && typeof params.seed.f1 === 'number') ? params.seed : null;
    var f1 = seed ? seed.f1 : 0.02 + Math.random() * 0.04;
    var f2 = seed ? seed.f2 : 0.02 + Math.random() * 0.04;
    var f3 = seed ? seed.f3 : 0.01 + Math.random() * 0.03;
    var p1 = seed ? (seed.p1 || 0) : Math.random() * Math.PI * 2;
    var p2 = seed ? (seed.p2 || 0) : Math.random() * Math.PI * 2;
    var p3 = seed ? (seed.p3 || 0) : Math.random() * Math.PI * 2;
    var hueBase = seed ? seed.hue : Math.random() * 360;
    for (var y = 0; y < 256; y++) {
      for (var x = 0; x < 320; x++) {
        var v = (Math.sin(x * f1 + p1) + Math.sin(y * f2 + p2) + Math.sin((x + y) * f3 + p3)) / 3;
        var hue = (hueBase + v * 120 + 360) % 360;
        var sat = 0.7, lit = 0.35 + v * 0.2;
        var q2 = lit < 0.5 ? lit * (1 + sat) : lit + sat - lit * sat;
        var pp = 2 * lit - q2;
        var hh = hue / 360;
        var rr = hue2rgb(pp, q2, hh + 1/3);
        var gg = hue2rgb(pp, q2, hh);
        var bb = hue2rgb(pp, q2, hh - 1/3);
        var idx = (y * 320 + x) * 4;
        d[idx] = Math.round(rr * 255); d[idx+1] = Math.round(gg * 255);
        d[idx+2] = Math.round(bb * 255); d[idx+3] = 255;
      }
    }
    ctx2.putImageData(imgData, 0, 0);
    sstvPhoneBg = c;
  }

  function hue2rgb(p, q, t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }

  // --- Canvas compose (background + text layers) ---
  function sstvRenderPhoneCompose() {
    if (!sstvPhoneComposeCtx) return;
    var w = 320, h = 256;
    sstvPhoneCompose.width = w; sstvPhoneCompose.height = h;
    // Background with zoom/pan
    if (sstvPhoneBg) {
      var srcW = sstvPhoneBg.width || sstvPhoneBg.naturalWidth || w;
      var srcH = sstvPhoneBg.height || sstvPhoneBg.naturalHeight || h;
      // Base scale: cover-crop
      var baseScale = Math.max(w / srcW, h / srcH);
      // Apply user zoom (higher zoom = see less of image = more zoomed in)
      var effectiveScale = baseScale * sstvPhoneBgZoom;
      // Source region size (how much of the source image is visible)
      var sw = w / effectiveScale;
      var sh = h / effectiveScale;
      // Center + apply pan offset (clamped to image bounds)
      var sx = (srcW - sw) / 2 + sstvPhoneBgPanX;
      var sy = (srcH - sh) / 2 + sstvPhoneBgPanY;
      // Clamp to source image bounds
      sx = Math.max(0, Math.min(srcW - sw, sx));
      sy = Math.max(0, Math.min(srcH - sh, sy));
      sstvPhoneComposeCtx.drawImage(sstvPhoneBg, sx, sy, sw, sh, 0, 0, w, h);
    } else {
      sstvPhoneComposeCtx.fillStyle = '#0a0a18';
      sstvPhoneComposeCtx.fillRect(0, 0, w, h);
    }
    // Text layers
    for (var i = 0; i < sstvPhoneTexts.length; i++) {
      var t = sstvPhoneTexts[i];
      if (!t.visible || !t.label) continue;
      sstvPhoneComposeCtx.save();
      sstvPhoneComposeCtx.shadowColor = '#000';
      sstvPhoneComposeCtx.shadowBlur = 3;
      sstvPhoneComposeCtx.shadowOffsetX = 1;
      sstvPhoneComposeCtx.shadowOffsetY = 1;
      sstvPhoneComposeCtx.fillStyle = t.color || '#ffffff';
      sstvPhoneComposeCtx.font = (t.italic ? 'italic ' : '') + (t.bold ? 'bold ' : '') + t.fontSize + 'px sans-serif';
      if (t.rotation) {
        sstvPhoneComposeCtx.translate(t.x, t.y);
        sstvPhoneComposeCtx.rotate(t.rotation);
        sstvPhoneComposeCtx.fillText(t.label, 0, 0);
      } else {
        sstvPhoneComposeCtx.fillText(t.label, t.x, t.y);
      }
      sstvPhoneComposeCtx.restore();
    }
    // PiP reply inset (drawn last so it sits above text)
    if (sstvPhoneReplyImage && sstvPhoneReplyImage.complete && sstvPhoneReplyImage.naturalWidth > 0) {
      var insetW = Math.round(w * sstvPhoneReplyInset.scale);
      var insetH = Math.round(insetW * (sstvPhoneReplyImage.naturalHeight / sstvPhoneReplyImage.naturalWidth));
      var margin = 8;
      var ix = sstvPhoneReplyInset.x >= 0 ? sstvPhoneReplyInset.x : w - insetW - margin;
      var iy = sstvPhoneReplyInset.y >= 0 ? sstvPhoneReplyInset.y : h - insetH - margin;
      // Cache draw rect so touch handlers can hit-test
      sstvPhoneReplyInset._drawX = ix;
      sstvPhoneReplyInset._drawY = iy;
      sstvPhoneReplyInset._drawW = insetW;
      sstvPhoneReplyInset._drawH = insetH;
      sstvPhoneComposeCtx.save();
      sstvPhoneComposeCtx.shadowColor = 'rgba(0,0,0,0.7)';
      sstvPhoneComposeCtx.shadowBlur = 4;
      sstvPhoneComposeCtx.shadowOffsetX = 1;
      sstvPhoneComposeCtx.shadowOffsetY = 2;
      sstvPhoneComposeCtx.drawImage(sstvPhoneReplyImage, ix, iy, insetW, insetH);
      sstvPhoneComposeCtx.shadowColor = 'transparent';
      sstvPhoneComposeCtx.strokeStyle = '#fff';
      sstvPhoneComposeCtx.lineWidth = 1.5;
      sstvPhoneComposeCtx.strokeRect(ix, iy, insetW, insetH);
      sstvPhoneComposeCtx.restore();
    }
  }

  // --- Reply-image helpers -------------------------------------------------
  function sstvPhoneSetReplyImage(src) {
    if (!src) return;
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function() {
      sstvPhoneReplyImage = img;
      sstvPhoneReplyInset.x = -1;
      sstvPhoneReplyInset.y = -1;
      sstvPhoneReplyInset.scale = 0.28;
      sstvRenderPhoneCompose();
      sstvPhoneUpdateReplyUI();
    };
    img.onerror = function() {
      console.warn('[SSTV] Reply image failed to load');
    };
    img.src = src;
  }
  function sstvPhoneClearReply() {
    sstvPhoneReplyImage = null;
    sstvRenderPhoneCompose();
    sstvPhoneUpdateReplyUI();
  }
  function sstvPhoneUpdateReplyUI() {
    // Update the SEND button label + visibility of the Clear-reply chip
    if (sstvSendBtn) {
      sstvSendBtn.textContent = sstvPhoneReplyImage ? 'REPLY' : 'SEND';
    }
    var chip = document.getElementById('sstv-phone-reply-chip');
    if (sstvPhoneReplyImage) {
      if (!chip) {
        chip = document.createElement('button');
        chip.id = 'sstv-phone-reply-chip';
        chip.type = 'button';
        chip.textContent = '↩ Clear reply inset';
        chip.style.cssText = 'display:block;margin:4px 10px 0;padding:5px 10px;font-size:11px;border:1px solid var(--accent);background:rgba(233,69,96,0.1);color:var(--accent);border-radius:4px;cursor:pointer;';
        chip.addEventListener('click', sstvPhoneClearReply);
        var composeCanvas = document.getElementById('sstv-phone-compose');
        if (composeCanvas && composeCanvas.parentNode) {
          composeCanvas.parentNode.parentNode.insertBefore(chip, composeCanvas.parentNode.nextSibling);
        }
      }
      chip.style.display = 'block';
    } else if (chip) {
      chip.style.display = 'none';
    }
  }

  // --- Send ---
  function sstvPhoneUpdateSendBtn() {
    if (!sstvSendBtn) return;
    if (sstvPhoneRxActive) {
      sstvSendBtn.style.opacity = '0.4';
      sstvSendBtn.style.pointerEvents = 'none';
      sstvSendBtn.textContent = 'RX...';
    } else {
      sstvSendBtn.style.opacity = '';
      sstvSendBtn.style.pointerEvents = '';
      sstvSendBtn.textContent = 'SEND';
    }
  }

  if (sstvSendBtn) {
    sstvSendBtn.addEventListener('click', function() {
      if (sstvPhoneRxActive) return;
      sstvRenderPhoneCompose();
      var dataUrl = sstvPhoneCompose.toDataURL('image/jpeg', 0.9);
      var modeEl = document.getElementById('sstv-mode-phone');
      var mode = modeEl ? modeEl.value : 'martin1';
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'sstv-photo', image: dataUrl, mode: mode }));
      if (sstvPhoneStatus) { sstvPhoneStatus.textContent = 'Sending...'; sstvPhoneStatus.style.color = 'var(--accent)'; }
    });
  }

  // --- Gallery fetch from POTACAT ---
  var sstvPhoneGalleryLoaded = 0;  // how many gallery images loaded so far
  var sstvPhoneGalleryTotal = 0;   // total images on POTACAT
  var sstvPhoneDecodeStatus = document.getElementById('sstv-phone-decode-status');
  var sstvPhoneGalleryCountEl = document.getElementById('sstv-phone-gallery-count');
  var sstvPhoneLoadMoreBtn = document.getElementById('sstv-phone-load-more');

  // Refresh flag carries between request and response since the server doesn't
  // echo our request fields back. Set to true for replace-style loads (initial,
  // reconnect, manual refresh); false for append-style Load More.
  var sstvPhoneGalleryNextIsRefresh = true;

  function sstvPhoneRequestGallery(limit, offset, isRefresh) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sstvPhoneGalleryNextIsRefresh = isRefresh !== false && (offset || 0) === 0;
    ws.send(JSON.stringify({ type: 'sstv-get-gallery', limit: limit || 10, offset: offset || 0 }));
  }

  function sstvPhoneHandleGallery(msg) {
    var images = msg.images || [];
    sstvPhoneGalleryTotal = msg.total || 0;
    if (!msg.requestId) {
      // Refresh (replace) vs Load More (append). Clearing the DOM on refresh
      // is what makes reconnect pick up images decoded while we were away —
      // live broadcasts are fire-and-forget and get lost if Safari is asleep.
      if (sstvPhoneGalleryNextIsRefresh && sstvPhoneGallery) {
        sstvPhoneGallery.innerHTML = '';
      }
      for (var i = 0; i < images.length; i++) {
        sstvPhoneAddGalleryImage(images[i]);
      }
    }
    sstvPhoneGalleryLoaded = sstvPhoneGallery ? sstvPhoneGallery.children.length : 0;
    if (sstvPhoneGalleryCountEl) {
      sstvPhoneGalleryCountEl.textContent = sstvPhoneGalleryLoaded + ' of ' + sstvPhoneGalleryTotal;
    }
    if (sstvPhoneLoadMoreBtn) {
      sstvPhoneLoadMoreBtn.style.display = sstvPhoneGalleryLoaded < sstvPhoneGalleryTotal ? '' : 'none';
    }
  }

  function sstvPhoneAddGalleryImage(img) {
    if (!sstvPhoneGallery) return;
    // Dedup: if a thumbnail with the same timestamp is already in the DOM
    // (added by a prior refresh or by the live rx-image broadcast that wrote
    // this same file), skip — inserting again would duplicate.
    var ts = String(img.timestamp || 0);
    if (ts !== '0') {
      var existing = sstvPhoneGallery.children;
      for (var ei = 0; ei < existing.length; ei++) {
        if (existing[ei].dataset.timestamp === ts) return;
      }
    }
    var div = document.createElement('div');
    div.style.cssText = 'flex-shrink:0;border:1px solid var(--border);border-radius:4px;overflow:hidden;position:relative;cursor:pointer;';
    var imgEl = document.createElement('img');
    imgEl.src = img.dataUrl || img.image || '';
    imgEl.style.cssText = 'display:block;width:120px;height:auto;';
    div.appendChild(imgEl);
    var info = document.createElement('div');
    info.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.6);font-size:10px;color:#ccc;padding:1px 4px;text-align:center;';
    var d = img.timestamp ? new Date(img.timestamp) : null;
    var dateStr = d ? d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    var imgHz = img.freqHz || (img.freqKhz ? img.freqKhz * 1000 : 0);
    info.textContent = (img.mode || '') + (imgHz ? ' ' + (Math.round(imgHz / 1000) / 1000).toFixed(3) : '') + ' ' + dateStr;
    div.appendChild(info);
    // Reply button — overlays the thumb, taps set this image as PiP reply inset
    var replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.textContent = '↩';
    replyBtn.title = 'Reply with this image';
    replyBtn.style.cssText = 'position:absolute;top:2px;right:2px;background:rgba(233,69,96,0.95);color:#fff;border:none;border-radius:3px;font-size:13px;font-weight:700;padding:2px 6px;cursor:pointer;z-index:2;';
    replyBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      sstvPhoneSetReplyImage(img.dataUrl || img.image);
    });
    div.appendChild(replyBtn);
    div.dataset.timestamp = img.timestamp || 0;
    // Tap to view full size
    div.addEventListener('click', function() {
      sstvPhoneViewImage(img.dataUrl || img.image);
    });
    // Insert in sorted position (newest first = leftmost)
    var inserted = false;
    var children = sstvPhoneGallery.children;
    for (var ci = 0; ci < children.length; ci++) {
      if ((img.timestamp || 0) > (parseFloat(children[ci].dataset.timestamp) || 0)) {
        sstvPhoneGallery.insertBefore(div, children[ci]);
        inserted = true;
        break;
      }
    }
    if (!inserted) sstvPhoneGallery.appendChild(div);
  }

  // Full-size image viewer overlay
  function sstvPhoneViewImage(src) {
    if (!src) return;
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;';
    var img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'max-width:95%;max-height:85%;image-rendering:pixelated;border-radius:4px;';
    overlay.appendChild(img);
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:12px;margin-top:14px;';
    var replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.textContent = '↩ Reply with this';
    replyBtn.style.cssText = 'padding:10px 18px;font-size:14px;font-weight:700;border:none;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer;';
    replyBtn.addEventListener('click', function() {
      sstvPhoneSetReplyImage(src);
      overlay.remove();
    });
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'padding:10px 18px;font-size:14px;border:1px solid #888;border-radius:6px;background:transparent;color:#fff;cursor:pointer;';
    closeBtn.addEventListener('click', function() { overlay.remove(); });
    actions.appendChild(replyBtn);
    actions.appendChild(closeBtn);
    overlay.appendChild(actions);
    // Click on backdrop (not buttons) to close
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay || e.target === img) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  if (sstvPhoneLoadMoreBtn) {
    sstvPhoneLoadMoreBtn.addEventListener('click', function() {
      var offset = sstvPhoneGallery ? sstvPhoneGallery.children.length : 0;
      sstvPhoneRequestGallery(10, offset);
    });
  }

  // --- Receive decoded SSTV image (live from POTACAT decoder) ---
  function sstvPhoneAddRxImage(msg) {
    if (!sstvPhoneGallery) return;
    var imgSrc = msg.image || msg.dataUrl || '';
    if (!imgSrc) return;
    // Dedup against anything already on screen — same thumbnail could arrive
    // via both the live broadcast and a gallery refresh that saw the same PNG
    // on disk. Prefer the server-supplied timestamp so keys match the refresh.
    var liveTs = String(msg.timestamp || Date.now());
    var existingKids = sstvPhoneGallery.children;
    for (var ek = 0; ek < existingKids.length; ek++) {
      if (existingKids[ek].dataset.timestamp === liveTs) return;
    }
    var div = document.createElement('div');
    div.style.cssText = 'flex-shrink:0;border:2px solid var(--pota);border-radius:4px;overflow:hidden;position:relative;cursor:pointer;';
    var img = document.createElement('img');
    img.src = imgSrc;
    img.style.cssText = 'display:block;width:120px;height:auto;';
    div.appendChild(img);
    var info = document.createElement('div');
    info.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.6);font-size:10px;color:#ccc;padding:1px 4px;text-align:center;';
    var now = new Date();
    info.textContent = 'NEW ' + (msg.mode || '') + (msg.freqHz ? ' ' + (Math.round(msg.freqHz / 1000) / 1000).toFixed(3) : '') + ' ' + now.toLocaleDateString([], {month:'numeric',day:'numeric'}) + ' ' + now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    div.appendChild(info);
    // Reply button on live decode — most valuable placement since this is the
    // thumbnail users reach for first right after receiving
    var replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.textContent = '↩';
    replyBtn.title = 'Reply with this image';
    replyBtn.style.cssText = 'position:absolute;top:2px;right:2px;background:rgba(233,69,96,0.95);color:#fff;border:none;border-radius:3px;font-size:13px;font-weight:700;padding:2px 6px;cursor:pointer;z-index:2;';
    replyBtn.addEventListener('click', function(e) { e.stopPropagation(); sstvPhoneSetReplyImage(imgSrc); });
    div.appendChild(replyBtn);
    div.dataset.timestamp = liveTs;
    div.addEventListener('click', function() { sstvPhoneViewImage(imgSrc); });
    sstvPhoneGallery.insertBefore(div, sstvPhoneGallery.firstChild);
    sstvPhoneGalleryItems.unshift({ src: imgSrc, mode: msg.mode });
    // Fade the green border after 5 seconds
    setTimeout(function() { div.style.borderColor = 'var(--border)'; }, 5000);
    // Update count
    sstvPhoneGalleryTotal++;
    sstvPhoneGalleryLoaded = sstvPhoneGallery.children.length;
    if (sstvPhoneGalleryCountEl) sstvPhoneGalleryCountEl.textContent = sstvPhoneGalleryLoaded + ' of ' + sstvPhoneGalleryTotal;
    // Show decode status
    if (sstvPhoneDecodeStatus) {
      sstvPhoneDecodeStatus.style.display = '';
      sstvPhoneDecodeStatus.textContent = 'New image decoded!';
      setTimeout(function() { sstvPhoneDecodeStatus.style.display = 'none'; }, 4000);
    }
    if (sstvPhoneStatus) sstvPhoneStatus.textContent = 'Image received';
  }

  // Load SSTV settings when auth completes
  // (echoSettings is set earlier in the auth-ok handler)
  setTimeout(sstvPhoneLoadSettings, 500);

  // ── End SSTV ─────────────────────────────────────────────

  // ===== Full VFO View — opt-in operator interface =====
  // Mirrors the desktop VFO popout (freq/mode/dial/bands/PTT) on phone screens.
  // Phase 1: dial + bands + mode picker + PTT. Op info / S-meter / macros TBD.
  (function setupVfoFullview() {
    const fullview = document.getElementById('vfo-fullview');
    const toggleBtn = document.getElementById('vfo-fullview-btn');
    const backBtn = document.getElementById('vf-back');
    const vfFreq = document.getElementById('vf-freq');
    const vfModePill = document.getElementById('vf-mode-pill');
    const vfFilterPill = document.getElementById('vf-filter-pill');
    const vfStepPill = document.getElementById('vf-step-pill');
    const vfPttBtn = document.getElementById('vf-ptt');
    const vfPttRow = vfPttBtn ? vfPttBtn.parentElement : null;
    const vfOpCard = document.getElementById('vf-op-card');
    const vfOpCall = document.getElementById('vf-op-call');
    const vfOpName = document.getElementById('vf-op-name');
    const vfOpLoc = document.getElementById('vf-op-loc');
    const vfOpRef = document.getElementById('vf-op-ref');
    const vfOpBearing = document.getElementById('vf-op-bearing');
    const vfOpDupe = document.getElementById('vf-op-dupe');
    const vfLogBtn = document.getElementById('vf-log-btn');
    const vfDial = document.getElementById('vf-dial');
    if (!fullview || !toggleBtn) return;

    let isOpen = false;
    // Visual rotation of the dial (radians) — accumulates as the user drags so
    // they can SEE motion. Each ~30° of rotation = one frequency step.
    let dialRotation = 0;

    function show() {
      isOpen = true;
      fullview.classList.remove('hidden');
      toggleBtn.classList.add('active');
      renderAll();
      drawDial();
    }
    function hide() {
      isOpen = false;
      fullview.classList.add('hidden');
      toggleBtn.classList.remove('active');
    }

    toggleBtn.addEventListener('click', () => isOpen ? hide() : show());
    backBtn.addEventListener('click', hide);

    // VFO Lock button — toggles the global lock state on the desktop host.
    // The server echoes a vfo-lock-state message back, which drives the UI
    // update, so desktop and all ECHOCAT clients stay in sync.
    const vfLockBtn = document.getElementById('vf-lock-btn');
    if (vfLockBtn) {
      vfLockBtn.addEventListener('click', () => {
        const next = !vfoLocked;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'vfo-set-lock', locked: next }));
        }
        // Optimistic update so the button responds immediately; the WS echo
        // from the server will confirm (or correct) it.
        vfoLocked = next;
        updateVfoLockUi();
      });
      updateVfoLockUi();
    }

    // --- Render: pull from existing shared state, push to view ---
    function renderAll() {
      // The status bar is covered while this panel is open, so re-render its
      // mirrored readouts here — the solar/split data usually arrived before
      // the operator opened the panel (LZ3AW 2026-08-28).
      renderFreqOther();
      renderSolarPills();
      vfFreq.textContent = currentFreqKhz ? formatFreq(Math.round(currentFreqKhz * 1000)) : '---.---.---';
      vfModePill.textContent = currentMode || '---';
      // Filter pill — read from existing CW/SSB filter state if available
      vfFilterPill.textContent = (typeof currentFilterWidth !== 'undefined' && currentFilterWidth)
        ? currentFilterWidth + ' Hz' : '--- Hz';
      vfStepPill.textContent = STEP_SIZES[dpStepIdx] >= 1
        ? STEP_SIZES[dpStepIdx] + ' kHz'
        : (STEP_SIZES[dpStepIdx] * 1000) + ' Hz';
      // Highlight band button matching current frequency
      const khz = currentFreqKhz ? Math.round(currentFreqKhz) : 0;
      fullview.querySelectorAll('.vf-band').forEach((btn) => {
        const bandKhz = parseInt(btn.dataset.khz, 10);
        // Within ~10% of the band-edge marker counts as "active"
        const inBand = khz > 0 && Math.abs(khz - bandKhz) < bandKhz * 0.10;
        btn.classList.toggle('active', inBand);
      });
      // Op info — rich card with big call/name + meta + Log button.
      if (vfOpCard) {
        if (tunedCallsign) {
          vfOpCard.classList.remove('vf-op-empty');
          if (vfOpCall) vfOpCall.textContent = tunedCallsign;
          if (vfOpName) vfOpName.textContent = tunedOpName || '';
          // Location: prefer "US-XX" for US ops (matches POTACAT convention),
          // fall back to country name for DX, then bare state if neither.
          let loc = '';
          if (tunedState && /^united states|^usa$/i.test(tunedCountry || '')) {
            loc = 'US-' + tunedState.toUpperCase();
          } else if (tunedCountry) {
            loc = tunedCountry;
          } else if (tunedState) {
            loc = tunedState;
          }
          if (vfOpLoc) vfOpLoc.textContent = loc;
          if (vfOpRef) vfOpRef.textContent = tunedRef ? (tunedSig ? `${tunedSig} ${tunedRef}` : tunedRef) : '';
          if (vfOpBearing) {
            if (showVfoBearing && typeof tunedBearing === 'number' && isFinite(tunedBearing)) {
              const b = ((Math.round(tunedBearing) % 360) + 360) % 360;
              vfOpBearing.textContent = 'Beam: ' + String(b).padStart(3, '0') + '°';
            } else {
              vfOpBearing.textContent = '';
            }
          }
          if (vfOpDupe) {
            if (tunedDupe) {
              const d = tunedDupe;
              const parts = [];
              if (d.timeUtc) parts.push(d.timeUtc.slice(0, 2) + ':' + d.timeUtc.slice(2, 4) + ' UTC');
              if (d.freqKhz) parts.push((parseFloat(d.freqKhz) / 1000).toFixed(3) + ' MHz');
              if (d.mode) parts.push(d.mode);
              vfOpDupe.textContent = 'DUPE';
              vfOpDupe.title = parts.length ? 'Already worked: ' + parts.join(' · ') : 'Already worked this activation';
            } else {
              vfOpDupe.textContent = '';
              vfOpDupe.title = '';
            }
          }
        } else {
          vfOpCard.classList.add('vf-op-empty');
        }
      }
      // Hide PTT in non-voice modes (CW/digital) — same logic as main pttBtn.
      if (vfPttRow) {
        const mUp = (currentMode || '').toUpperCase();
        const isVoice = (mUp === 'SSB' || mUp === 'USB' || mUp === 'LSB' ||
                         mUp === 'FM' || mUp === 'AM' || mUp.startsWith('FREEDV'));
        vfPttRow.classList.toggle('hidden', !isVoice);
      }
    }

    // Draw the jog dial. The HOUSING (outer ring + center label) is fixed; the
    // tick marks rotate by `dialRotation` so the user sees motion as they spin
    // it. A bright "indicator notch" marks the 12 o'clock position to make the
    // rotation obvious even at small angles.
    function drawDial() {
      if (!vfDial || !isOpen) return;
      const ctx = vfDial.getContext('2d');
      const w = vfDial.width, h = vfDial.height;
      const cx = w / 2, cy = h / 2, R = w / 2 - 6;
      ctx.clearRect(0, 0, w, h);

      // Housing (fixed)
      const grad = ctx.createRadialGradient(cx, cy - R * 0.3, 0, cx, cy, R);
      grad.addColorStop(0, '#404058');
      grad.addColorStop(0.7, '#2a2a3a');
      grad.addColorStop(1, '#1a1a28');
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.stroke();

      // Rotating tick marks + finger dimple — drawn in a rotated transform so
      // the entire pattern visibly spins as the user drags.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(dialRotation);
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const r1 = R - 14, r2 = R - 4;
        ctx.beginPath();
        ctx.moveTo(r1 * Math.cos(a), r1 * Math.sin(a));
        ctx.lineTo(r2 * Math.cos(a), r2 * Math.sin(a));
        ctx.lineWidth = i % 6 === 0 ? 2.5 : 1;
        ctx.strokeStyle = i % 6 === 0 ? 'rgba(78,204,163,0.85)' : 'rgba(255,255,255,0.35)';
        ctx.stroke();
      }
      // Finger dimple — a darker recessed circle near the edge that ALSO
      // rotates so it's the most obvious motion cue
      const dimpleR = R * 0.12;
      const dimpleOffset = R * 0.6;
      ctx.beginPath();
      ctx.arc(0, -dimpleOffset, dimpleR, 0, Math.PI * 2);
      const dimpleGrad = ctx.createRadialGradient(0, -dimpleOffset - dimpleR * 0.3, 0, 0, -dimpleOffset, dimpleR);
      dimpleGrad.addColorStop(0, 'rgba(0,0,0,0.55)');
      dimpleGrad.addColorStop(1, 'rgba(0,0,0,0.15)');
      ctx.fillStyle = dimpleGrad;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.stroke();
      ctx.restore();

      // Fixed indicator notch at 12 o'clock — gives the user a reference
      // point so even small rotations are clearly visible.
      ctx.beginPath();
      ctx.moveTo(cx, cy - R - 2);
      ctx.lineTo(cx - 5, cy - R + 6);
      ctx.lineTo(cx + 5, cy - R + 6);
      ctx.closePath();
      ctx.fillStyle = '#ff5252';
      ctx.fill();

      // Center label — current step size for context
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const stepLabel = STEP_SIZES[dpStepIdx] >= 1
        ? STEP_SIZES[dpStepIdx] + ' kHz/step'
        : (STEP_SIZES[dpStepIdx] * 1000) + ' Hz/step';
      ctx.fillText(stepLabel, cx, cy);
    }

    // Drag the dial to tune. Each ~30° of rotation = 1 step (matches existing dial).
    let dragStartAngle = null;
    let dragAccumRad = 0;
    function dialAngle(e) {
      const rect = vfDial.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const t = e.touches ? e.touches[0] : e;
      return Math.atan2(t.clientY - cy, t.clientX - cx);
    }
    function dialStart(e) {
      e.preventDefault();
      dragStartAngle = dialAngle(e);
      dragAccumRad = 0;
    }
    function dialMove(e) {
      if (dragStartAngle == null || !currentFreqKhz) return;
      e.preventDefault();
      let a = dialAngle(e);
      let delta = a - dragStartAngle;
      // Normalize to (-PI, PI]
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      dragAccumRad += delta;
      dragStartAngle = a;
      // Visual rotation tracks the cumulative drag so the dial's tick marks
      // and finger dimple SPIN with the user's finger — without this the dial
      // looks static even while it's tuning.
      dialRotation += delta;
      const stepRad = Math.PI / 6; // 30° per step
      while (Math.abs(dragAccumRad) >= stepRad) {
        const dir = dragAccumRad > 0 ? 1 : -1;
        const step = STEP_SIZES[dpStepIdx];
        const next = Math.round((currentFreqKhz + dir * step) * 100) / 100;
        if (next >= 100) dpTune(next);
        dragAccumRad -= dir * stepRad;
      }
      drawDial();
    }
    function dialEnd() { dragStartAngle = null; }
    vfDial.addEventListener('touchstart', dialStart, { passive: false });
    vfDial.addEventListener('touchmove', dialMove, { passive: false });
    vfDial.addEventListener('touchend', dialEnd);
    vfDial.addEventListener('mousedown', dialStart);
    document.addEventListener('mousemove', (e) => { if (isOpen) dialMove(e); });
    document.addEventListener('mouseup', dialEnd);

    // --- Pill interactions ---
    vfFreq.addEventListener('click', () => {
      // Force the dial-pad's keypad sub-view (the user just tapped a frequency
      // — they want to type numbers, not see the small jog dial).
      const dialPad = document.getElementById('dial-pad');
      const dialPadBackdrop = document.getElementById('dial-pad-backdrop');
      const dpKeypad = document.getElementById('dp-keypad-view');
      const dpVfoView = document.getElementById('dp-vfo-view');
      const dpModeToggle = document.getElementById('dp-mode-toggle');
      if (dpKeypad) dpKeypad.classList.remove('hidden');
      if (dpVfoView) dpVfoView.classList.add('hidden');
      if (dpModeToggle) {
        dpModeToggle.innerHTML = '&#x25CE;';
        dpModeToggle.title = 'Switch to VFO dial';
      }
      if (dialPad) dialPad.classList.remove('hidden');
      if (dialPadBackdrop) dialPadBackdrop.classList.remove('hidden');
    });
    vfModePill.addEventListener('click', (e) => {
      e.stopPropagation();
      // Reuse existing mode picker — just trigger its open logic
      modeBadge.click();
    });
    vfStepPill.addEventListener('click', () => {
      dpStepIdx = (dpStepIdx + 1) % STEP_SIZES.length;
      try { localStorage.setItem('echocat-step-idx', dpStepIdx); } catch {}
      renderAll();
      drawDial();
    });

    // --- PTT (delegate to existing pttStart/pttStop so all state stays in sync) ---
    function vfPttDown(e) { e.preventDefault(); vfPttBtn.classList.add('active'); pttStart(); }
    function vfPttUp(e) { e.preventDefault(); vfPttBtn.classList.remove('active'); pttStop(); }
    vfPttBtn.addEventListener('touchstart', vfPttDown, { passive: false });
    vfPttBtn.addEventListener('touchend', vfPttUp, { passive: false });
    vfPttBtn.addEventListener('touchcancel', vfPttUp);
    vfPttBtn.addEventListener('mousedown', vfPttDown);
    vfPttBtn.addEventListener('mouseup', vfPttUp);
    vfPttBtn.addEventListener('mouseleave', (e) => { if (vfPttBtn.classList.contains('active')) vfPttUp(e); });

    // --- Band quick-tune ---
    fullview.querySelectorAll('.vf-band').forEach((btn) => {
      btn.addEventListener('click', () => {
        const khz = parseInt(btn.dataset.khz, 10);
        if (khz > 0) dpTune(khz);
      });
    });

    // --- Log QSO button — opens the existing log sheet pre-filled from
    // tuned-spot context. The log-sheet's existing 'log-ok' handler closes
    // the sheet on success, which leaves the user back in the VFO view.
    if (vfLogBtn) {
      vfLogBtn.addEventListener('click', () => {
        if (!tunedCallsign) return;
        openLogSheet({
          callsign: tunedCallsign,
          // No freqKhz: this IS the dial, so let the sheet keep following it.
          mode: currentMode || '',
          sig: tunedSig || '',
          sigInfo: tunedRef || '',
        });
      });
    }

    // Re-render whenever the radio state changes — patch updateStatus by
    // wrapping it. Simpler than wiring 5 separate listeners.
    const originalUpdateStatus = updateStatus;
    window._wrappedStatusForVfo = true;
    // Replace the symbol in the closure isn't easy — instead, use a polling
    // tick while the view is open. Cheap and avoids touching updateStatus.
    setInterval(() => { if (isOpen) renderAll(); }, 500);

    // If the split layout was applied before this IIFE bound click handlers,
    // the initial toggleBtn.click() was a no-op. Re-apply now so a docked
    // sidebar actually enters open state and its render loop runs.
    if (typeof window.__echocatApplySplitLayout === 'function') {
      window.__echocatApplySplitLayout();
    }

    // Expose renderAll so other IIFEs (notably setupVfoWidgets, and the
    // beam-heading + dupe toggle change handlers in the Settings overlay)
    // can request a re-render without sharing this lexical scope.
    window.__vfRenderAll = renderAll;
  })();
  // ===== End Full VFO View =====

  // ===== VFO Widgets (opt-in modular blocks inside the VFO panel) =====
  // Each widget shows/hides based on settings persisted to localStorage.
  // Implementations either listen to existing state vars (currentNb, currentAtu,
  // currentFilterWidth, etc.) and incoming WS messages, or delegate clicks to
  // the existing rc-* / cw-* / ssb-macro / custom-cat handlers in the Settings
  // overlay so we don't duplicate complex audio/playback logic.
  (function setupVfoWidgets() {
    const VFO_WIDGETS_KEY = 'echocat-vfo-widgets';
    const WIDGET_IDS = ['meter', 'rigctl', 'filter', 'cw', 'voice', 'customcat', 'profiles', 'presets'];
    let widgetState = {};
    try { widgetState = JSON.parse(localStorage.getItem(VFO_WIDGETS_KEY) || '{}') || {}; } catch { widgetState = {}; }

    function applyVisibility() {
      WIDGET_IDS.forEach((id) => {
        const el = document.querySelector(`.vf-widget[data-vf-widget="${id}"]`);
        if (el) el.classList.toggle('hidden', !widgetState[id]);
        const tgl = document.getElementById('so-vfw-' + id);
        if (tgl) {
          tgl.classList.toggle('active', !!widgetState[id]);
          tgl.textContent = widgetState[id] ? 'On' : 'Off';
        }
      });
    }
    function setWidget(id, on) {
      widgetState[id] = !!on;
      try { localStorage.setItem(VFO_WIDGETS_KEY, JSON.stringify(widgetState)); } catch {}
      applyVisibility();
      // Re-render content for widgets that need a refresh on enable
      if (on && id === 'voice') renderVfVoice();
      if (on && id === 'customcat') renderVfCustomCat();
      if (on && id === 'cw') vfCwSync();
      if (on && id === 'profiles') renderVfProfiles();
    }

    // Wire toggles
    WIDGET_IDS.forEach((id) => {
      const tgl = document.getElementById('so-vfw-' + id);
      if (tgl) tgl.addEventListener('click', () => setWidget(id, !widgetState[id]));
    });

    // ----- Meter widget: S-meter / SWR / TX-power pills -----
    const vfSmeterPill = document.getElementById('vf-smeter-pill');
    const vfSwrPill = document.getElementById('vf-swr-pill');
    const vfPwrPill = document.getElementById('vf-pwr-pill');
    function vfSetMeter(val) {
      if (!vfSmeterPill) return;
      const color = val < 80 ? '#4ecca3' : val < 160 ? '#ffd740' : '#e94560';
      vfSmeterPill.style.color = color;
      vfSmeterPill.textContent = val <= 120
        ? 'S' + Math.round(val * 9 / 120)
        : 'S9+' + Math.round((val - 120) * 60 / 135);
    }
    function vfSetSwr(swr) {
      if (!vfSwrPill || swr <= 0) return;
      const color = swr <= 1.5 ? '#4ecca3' : swr <= 2.0 ? '#ffd740' : swr <= 3.0 ? '#f0a500' : '#e94560';
      vfSwrPill.style.color = color;
      vfSwrPill.textContent = swr < 10 ? swr.toFixed(1) : '>10';
    }
    function vfSetPwr(w) {
      if (!vfPwrPill) return;
      vfPwrPill.textContent = w >= 100 ? Math.round(w) + 'W' : (+w).toFixed(1) + 'W';
    }
    // Expose update functions on window so the existing locally-declared
    // updateEcho* functions (which run in the IIFE's lexical scope and can't
    // be reassigned from out here) can call us via explicit hooks. The
    // hooks are added inline at the call sites in the main handler/update
    // functions — see updateEchoSmeter / updateEchoSwr / updateEchoPower.
    window.__vfSetMeter = vfSetMeter;
    window.__vfSetSwr = vfSetSwr;
    window.__vfSetPwr = vfSetPwr;
    // window.__vfRenderAll is set from inside setupVfoFullview where
    // renderAll lives — referencing it here was a ReferenceError that
    // halted the whole IIFE before the spots panel finished setting up
    // (KK4DF / KM4CFT v1.5.7 "table won't load" reports).

    // ----- Rig-control widget: ATU / NB toggles + Rig On/Off + RF Gain / TX Power sliders -----
    const vfAtuBtn = document.getElementById('vf-atu-btn');
    const vfNbBtn = document.getElementById('vf-nb-btn');
    const vfPowerOnBtn = document.getElementById('vf-power-on-btn');
    const vfPowerOffBtn = document.getElementById('vf-power-off-btn');
    const vfRfGainSlider = document.getElementById('vf-rfgain-slider');
    const vfRfGainVal = document.getElementById('vf-rfgain-val');
    const vfTxPowerSlider = document.getElementById('vf-txpower-slider');
    const vfTxPowerVal = document.getElementById('vf-txpower-val');
    if (vfAtuBtn) vfAtuBtn.addEventListener('click', () => { if (rcAtuBtn) rcAtuBtn.click(); });
    if (vfNbBtn) vfNbBtn.addEventListener('click', () => { if (rcNbBtn) rcNbBtn.click(); });
    if (vfPowerOnBtn) vfPowerOnBtn.addEventListener('click', () => {
      sendToServer({ type: 'rig-control', data: { action: 'power-on' } });
    });
    if (vfPowerOffBtn) vfPowerOffBtn.addEventListener('click', () => {
      sendToServer({ type: 'rig-control', data: { action: 'power-off' } });
    });
    if (vfRfGainSlider) {
      vfRfGainSlider.addEventListener('input', () => {
        vfRfGainVal.textContent = vfRfGainSlider.value;
        if (rcRfGainSlider) {
          rcRfGainSlider.value = vfRfGainSlider.value;
          if (gainNode) {} // no-op; mirroring just for display
        }
      });
      vfRfGainSlider.addEventListener('change', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'set-rfgain', value: parseInt(vfRfGainSlider.value, 10) }));
        }
      });
    }
    if (vfTxPowerSlider) {
      vfTxPowerSlider.addEventListener('input', () => {
        vfTxPowerVal.textContent = vfTxPowerSlider.value;
      });
      vfTxPowerSlider.addEventListener('change', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'set-txpower', value: parseInt(vfTxPowerSlider.value, 10) }));
        }
      });
    }

    // ----- Filter widget: BW stepper -----
    const vfBwLabel = document.getElementById('vf-bw-label');
    const vfBwDn = document.getElementById('vf-bw-dn');
    const vfBwUp = document.getElementById('vf-bw-up');
    if (vfBwDn) vfBwDn.addEventListener('click', () => { if (rcBwDn) rcBwDn.click(); });
    if (vfBwUp) vfBwUp.addEventListener('click', () => { if (rcBwUp) rcBwUp.click(); });

    // ----- CW widget: WPM stepper + text-to-send input -----
    const vfCwWpm = document.getElementById('vf-cw-wpm');
    const vfCwWpmDn = document.getElementById('vf-cw-wpm-dn');
    const vfCwWpmUp = document.getElementById('vf-cw-wpm-up');
    const vfCwInput = document.getElementById('vf-cw-input');
    const vfCwSend = document.getElementById('vf-cw-send');
    if (vfCwWpmDn) vfCwWpmDn.addEventListener('click', () => { if (cwWpmDn) cwWpmDn.click(); vfCwSync(); });
    if (vfCwWpmUp) vfCwWpmUp.addEventListener('click', () => { if (cwWpmUp) cwWpmUp.click(); vfCwSync(); });
    if (vfCwSend) vfCwSend.addEventListener('click', () => {
      // Live mode: the letters already went out as they were typed; TX only
      // clears the box (sending the line again would key it twice).
      if (cwLiveMode) { vfCwInput.value = ''; vfCwLiveSent = 0; return; }
      const t = vfCwInput.value.trim();
      if (t) { sendCwText(t); vfCwInput.value = ''; }
    });
    if (vfCwInput) vfCwInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); vfCwSend.click(); }
    });
    function vfCwSync() {
      if (vfCwWpm && typeof cwWpm === 'number') vfCwWpm.textContent = cwWpm + ' wpm';
    }

    // ----- Voice macros: mirror buttons from the Settings overlay's row -----
    const vfVoiceRow = document.getElementById('vf-voice-row');
    function renderVfVoice() {
      if (!vfVoiceRow) return;
      vfVoiceRow.innerHTML = '';
      const src = document.getElementById('ssb-macro-row');
      if (!src) return;
      Array.from(src.querySelectorAll('button')).forEach((srcBtn) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vf-macro-btn';
        btn.textContent = srcBtn.textContent;
        btn.title = srcBtn.title || '';
        if (srcBtn.style.opacity && parseFloat(srcBtn.style.opacity) < 1) btn.classList.add('empty');
        btn.addEventListener('click', () => srcBtn.click());
        vfVoiceRow.appendChild(btn);
      });
    }

    // ----- Custom CAT: mirror buttons from the Settings overlay's row -----
    const vfCustomCatRow = document.getElementById('vf-customcat-row');
    // This row MIRRORS the Settings overlay's controls rather than rebuilding
    // them, so debounce, template substitution and toggle state stay in one
    // place. It walked `button` elements only, and a slider slot is a
    // <span> holding an <input type="range"> — so sliders silently never
    // appeared here ("Custom slider works, but not visible in VFO pane",
    // LZ3AW 2026-09-19). Both shapes are mirrored now; a slider forwards its
    // value to the source range, whose own listener does the sending.
    function renderVfCustomCat() {
      if (!vfCustomCatRow) return;
      vfCustomCatRow.innerHTML = '';
      const src = document.getElementById('rc-custom-cat-btns');
      if (!src) return;
      Array.from(src.children).forEach((slot) => {
        if (slot.tagName === 'BUTTON') {
          const name = (slot.textContent || '').trim();
          if (!name) return;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'vf-macro-btn';
          btn.textContent = name;
          if (slot.classList.contains('rc-custom-cat-on')) btn.classList.add('active');
          btn.addEventListener('click', () => slot.click());
          vfCustomCatRow.appendChild(btn);
          return;
        }
        const srcRange = slot.querySelector && slot.querySelector('input[type="range"]');
        if (!srcRange) return;
        const srcLabel = slot.querySelector('.rc-ccs-label');
        const wrap = document.createElement('span');
        wrap.className = 'vf-macro-slider';
        const lbl = document.createElement('span');
        lbl.className = 'vf-macro-slider-label';
        lbl.textContent = (srcLabel && srcLabel.textContent) || 'CAT';
        const range = document.createElement('input');
        range.type = 'range';
        range.className = 'vf-macro-range';
        range.min = srcRange.min;
        range.max = srcRange.max;
        range.step = srcRange.step || 1;
        range.value = srcRange.value;
        const val = document.createElement('span');
        val.className = 'vf-macro-slider-val';
        val.textContent = srcRange.value;
        range.addEventListener('input', () => {
          val.textContent = range.value;
          // Drive the source control: its own 'input' listener debounces and
          // sends, and keeps the overlay's slider in step with this one.
          srcRange.value = range.value;
          srcRange.dispatchEvent(new Event('input', { bubbles: true }));
        });
        wrap.appendChild(lbl);
        wrap.appendChild(range);
        wrap.appendChild(val);
        vfCustomCatRow.appendChild(wrap);
      });
    }

    // ----- Hook exports -----
    // Expose VFO widget update entrypoints for the existing in-scope
    // functions (updateRigControls / updateEchoSwr / updateEchoPower /
    // renderSsbMacros / renderCustomCatButtons) to call via explicit hook
    // invocations. Adding hook calls at the call sites is more reliable than
    // monkey-patching across the IIFE boundary.
    window.__vfUpdateRig = function(s) {
      if (s.nb !== undefined && vfNbBtn) vfNbBtn.classList.toggle('active', s.nb);
      if (s.atu !== undefined && vfAtuBtn) vfAtuBtn.classList.toggle('active', s.atu);
      if (s.filterWidth !== undefined && vfBwLabel) vfBwLabel.textContent = 'Filter ' + (typeof formatBw === 'function' ? formatBw(s.filterWidth) : s.filterWidth);
      if (s.rfgain !== undefined && vfRfGainSlider) {
        vfRfGainSlider.value = s.rfgain;
        if (vfRfGainVal) vfRfGainVal.textContent = s.rfgain;
      }
      if (s.txpower !== undefined && vfTxPowerSlider) {
        vfTxPowerSlider.value = s.txpower;
        if (vfTxPowerVal) vfTxPowerVal.textContent = s.txpower;
      }
    };
    window.__vfRenderVoiceMacros = renderVfVoice;
    window.__vfRenderCustomCat = renderVfCustomCat;
    window.__vfSyncCw = vfCwSync;

    // ----- Profiles widget: bidirectional sync with desktop VFO popout -----
    // Profiles live in `settings.vfoProfiles` on the desktop. The desktop
    // pushes the current list via { type: 'vfo-profiles', profiles } on
    // auth-ok and on every change. The phone sends edits back via
    // { type: 'vfo-profiles-update', profiles } — the desktop saves to
    // settings and broadcasts back so both UIs stay in sync.
    let vfoProfiles = [];
    const vfProfileList = document.getElementById('vf-profile-list');
    const vfProfileNameInput = document.getElementById('vf-profile-name');
    const vfProfileSaveBtn = document.getElementById('vf-profile-save');

    function renderVfProfiles() {
      if (!vfProfileList) return;
      if (!vfoProfiles.length) {
        vfProfileList.innerHTML = '<div class="vf-profile-empty">No profiles. Tune somewhere, name it, tap Save.</div>';
        return;
      }
      vfProfileList.innerHTML = '';
      vfoProfiles.forEach((p, i) => {
        const item = document.createElement('div');
        item.className = 'vf-profile-item';
        const freqMhz = p.freqKhz ? (p.freqKhz / 1000).toFixed(3) : '?';
        const detail = freqMhz + ' MHz ' + (p.mode || '') + (p.filterWidth ? ' BW:' + p.filterWidth : '');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'vf-profile-item-name';
        nameSpan.textContent = p.name || '(unnamed)';
        const detailSpan = document.createElement('span');
        detailSpan.className = 'vf-profile-item-detail';
        detailSpan.textContent = detail;
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'vf-profile-item-edit';
        editBtn.title = 'Rename';
        editBtn.innerHTML = '&#x270E;';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'vf-profile-item-del';
        delBtn.title = 'Delete';
        delBtn.textContent = '×';
        item.appendChild(nameSpan);
        item.appendChild(detailSpan);
        item.appendChild(editBtn);
        item.appendChild(delBtn);
        item.addEventListener('click', (e) => {
          if (e.target === delBtn || e.target === editBtn) return;
          if (item.classList.contains('editing')) return;
          applyProfile(p);
        });
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          beginVfProfileRename(item, nameSpan, p, i);
        });
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vfoProfiles.splice(i, 1);
          renderVfProfiles();
          pushProfilesToDesktop();
        });
        vfProfileList.appendChild(item);
      });
    }

    // Inline rename — same pattern as the desktop popout. Replace the name
    // span with an input, commit on blur/Enter, cancel on Esc. Tap-to-apply
    // is suppressed via the .editing class so an accidental tap during edit
    // doesn't immediately tune.
    function beginVfProfileRename(item, nameEl, profile, index) {
      if (item.classList.contains('editing')) return;
      item.classList.add('editing');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'vf-profile-item-name-edit';
      input.value = profile.name || '';
      input.maxLength = 64;
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      let committed = false;
      const finish = (commit) => {
        if (committed) return;
        committed = true;
        const newName = (input.value || '').trim();
        if (commit && newName && newName !== profile.name) {
          vfoProfiles[index] = Object.assign({}, profile, { name: newName });
          renderVfProfiles();
          pushProfilesToDesktop();
        } else {
          renderVfProfiles();
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    }

    function applyProfile(p) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Desktop's apply path tunes to freq+mode then sets a generic
      // filter width. We piggy-back on the existing tune message and add
      // a separate apply-vfo-profile message that the desktop dispatches
      // through its existing applyProfile equivalent.
      ws.send(JSON.stringify({
        type: 'apply-vfo-profile',
        profile: { name: p.name, freqKhz: p.freqKhz, mode: p.mode, filterWidth: p.filterWidth },
      }));
    }

    function pushProfilesToDesktop() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'vfo-profiles-update', profiles: vfoProfiles }));
    }

    if (vfProfileSaveBtn) {
      vfProfileSaveBtn.addEventListener('click', () => {
        const name = (vfProfileNameInput && vfProfileNameInput.value || '').trim();
        if (!name) {
          if (vfProfileNameInput) vfProfileNameInput.focus();
          return;
        }
        // Snapshot current VFO state at full precision. Round to whole Hz (the
        // radio's real resolution), THEN convert to kHz — do NOT Math.round to
        // integer kHz, which silently drops CW/FT8 sub-kHz dial offsets (e.g. a
        // 10118.5 kHz CW spot would collapse to 10119, and applying it later
        // would tune 500 Hz off). Matches the desktop popout, which stores
        // currentFreqHz/1000. currentFilterWidth may be 0 if the rig hasn't
        // reported one yet — store undefined in that case so apply doesn't set
        // a 0-Hz filter. (K3SBP 2026-07-15.)
        const freqKhz = currentFreqHz ? Math.round(currentFreqHz) / 1000 : 0;
        if (!freqKhz) return;
        vfoProfiles.push({
          name, freqKhz,
          mode: currentMode || '',
          filterWidth: currentFilterWidth > 0 ? currentFilterWidth : undefined,
        });
        if (vfProfileNameInput) vfProfileNameInput.value = '';
        renderVfProfiles();
        pushProfilesToDesktop();
      });
    }

    // Expose hook so the WS message dispatcher (declared earlier) can hand
    // us new profile lists arriving from the desktop.
    window.__vfReceiveProfiles = function(list) {
      vfoProfiles = Array.isArray(list) ? list.slice() : [];
      renderVfProfiles();
    };

    // ----- Rig presets widget (lib/rig-presets.js) -----
    // The desktop sends { type:'rig-presets', presets, byMode, rigId, caps,
    // details } for the ACTIVE rig; a tap sends apply-rig-preset {id}; Save
    // sends the whole list back as rig-presets-update (new entries are
    // stamped with the active rig on the desktop). Levels and the mode
    // assignments are edited on the desktop's Rig menu.
    let rigPresets = { presets: [], byMode: {}, caps: {}, details: {} };
    const vfPresetList = document.getElementById('vf-preset-list');
    const vfPresetNameInput = document.getElementById('vf-preset-name');
    const vfPresetSaveBtn = document.getElementById('vf-preset-save');

    function renderVfPresets() {
      if (!vfPresetList) return;
      if (!rigPresets.presets.length) {
        vfPresetList.innerHTML = '<div class="vf-profile-empty">No rig presets. Set the radio, name it, tap Save. Edit on the desktop Rig menu.</div>';
        return;
      }
      vfPresetList.innerHTML = '';
      rigPresets.presets.forEach((p) => {
        const det = (rigPresets.details && rigPresets.details[p.id]) || {};
        const row = document.createElement('div');
        row.className = 'vf-profile-item';
        const name = document.createElement('span'); name.className = 'vf-profile-item-name'; name.textContent = p.name;
        const detail = document.createElement('span'); detail.className = 'vf-profile-item-detail'; detail.textContent = det.text || '(nothing set)';
        row.appendChild(name); row.appendChild(detail);
        const del = document.createElement('button'); del.type = 'button'; del.className = 'vf-profile-item-del'; del.textContent = '×'; del.title = 'Delete';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'rig-presets-update', presets: rigPresets.presets.filter(x => x.id !== p.id), byMode: rigPresets.byMode }));
        });
        row.appendChild(del);
        row.addEventListener('click', () => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'apply-rig-preset', id: p.id }));
        });
        vfPresetList.appendChild(row);
      });
    }
    if (vfPresetSaveBtn) {
      vfPresetSaveBtn.addEventListener('click', () => {
        const name = (vfPresetNameInput && vfPresetNameInput.value || '').trim();
        if (!name) { if (vfPresetNameInput) vfPresetNameInput.focus(); return; }
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        // The radio's current levels as this page knows them — the rig-control
        // sliders, fed by status.txpower / status.rfgain. Power 0 = unknown.
        const p = { name };
        const tp = rcTxPowerSlider ? Number(rcTxPowerSlider.value) : 0;
        const rg = rcRfGainSlider ? Number(rcRfGainSlider.value) : NaN;
        if (Number.isFinite(tp) && tp > 0) p.txPower = tp;
        if (Number.isFinite(rg) && rigPresets.caps && rigPresets.caps.rfgain) p.rfGain = rg;
        ws.send(JSON.stringify({ type: 'rig-presets-update', presets: rigPresets.presets.concat([p]), byMode: rigPresets.byMode }));
        if (vfPresetNameInput) vfPresetNameInput.value = '';
      });
    }
    window.__vfReceiveRigPresets = function(msg) {
      rigPresets = {
        presets: Array.isArray(msg.presets) ? msg.presets.slice() : [],
        byMode: msg.byMode || {}, caps: msg.caps || {}, details: msg.details || {},
      };
      renderVfPresets();
    };
    renderVfPresets();

    // First paint
    applyVisibility();
    vfCwSync();
    if (widgetState.voice) renderVfVoice();
    if (widgetState.customcat) renderVfCustomCat();
    if (widgetState.profiles) renderVfProfiles();
  })();
  // ===== End VFO Widgets =====

  // --- Popout bootstrap (view=<tab>) ---
  // Popout windows don't authenticate or open a WebSocket. They mirror the
  // main tab's state over BroadcastChannel, and post user actions back as
  // { kind: 'forward', ... } for the main tab to forward on the real WS.
  function bootstrapPopout() {
    // Reveal main UI without auth.
    connectScreen.classList.add('hidden');
    mainUI.classList.remove('hidden');

    const popoutBanner = document.getElementById('popout-banner');
    const popoutFreq = document.getElementById('popout-freq');
    const popoutModeEl = document.getElementById('popout-mode');
    const popoutMsg = document.getElementById('popout-msg');
    if (popoutBanner) popoutBanner.classList.remove('hidden');

    function setStatus(connected, message) {
      if (!popoutBanner) return;
      popoutBanner.classList.toggle('disconnected', !connected);
      if (popoutMsg) popoutMsg.textContent = message || (connected ? '' : 'Disconnected from main window');
    }

    function setVfo(freqKhz, modeStr) {
      if (popoutFreq && freqKhz) popoutFreq.textContent = formatFreq(freqKhz * 1000);
      if (popoutModeEl && modeStr) popoutModeEl.textContent = modeStr;
    }

    // Initialize Leaflet the same way switchTab('map') does for the main window.
    if (popoutView === 'map') {
      spotMap = L.map('spot-map', {
        zoomControl: true,
        maxBounds: [[-85, -300], [85, 300]],
        maxBoundsViscosity: 1.0,
        minZoom: 2,
      }).setView([39.8, -98.5], 4);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OSM',
        className: 'dark-tiles',
        noWrap: true,
      }).addTo(spotMap);
      workedOverlayAttach(spotMap); // worked-states / countries tints + legend
      // Give CSS a tick to settle, then ask Leaflet to remeasure.
      // Do it several times — Leaflet needs the container size to be accurate
      // at the moment renderMapSpots() runs, and initial layout in popouts is
      // sometimes reported as 0x0 on the first RAF.
      const remeasure = () => { try { spotMap.invalidateSize(); } catch {} };
      requestAnimationFrame(remeasure);
      setTimeout(remeasure, 100);
      setTimeout(remeasure, 500);
      window.addEventListener('resize', remeasure);
    }

    // Open BroadcastChannel and hook handlers.
    try { bc = new BroadcastChannel('echocat'); } catch {
      setStatus(false, 'BroadcastChannel unavailable in this browser');
      return;
    }

    let snapshotReceived = false;
    bc.addEventListener('message', (ev) => {
      const m = ev.data;
      if (!m || !m.kind) return;
      switch (m.kind) {
        case 'state-snapshot':
          snapshotReceived = true;
          setStatus(m.online !== false, '');
          spots = Array.isArray(m.spots) ? m.spots : [];
          if (m.currentFreqKhz != null) currentFreqKhz = m.currentFreqKhz;
          if (typeof m.phoneGrid === 'string') phoneGrid = m.phoneGrid;
          if (typeof m.distUnit === 'string') distUnit = m.distUnit;
          setVfo(currentFreqKhz, m.mode || '');
          console.log('[BC popout] state-snapshot', spots.length, 'spots, vfo=', currentFreqKhz);
          if (popoutView === 'map' && spotMap) { try { spotMap.invalidateSize(); } catch {} ; renderMapSpots(); }
          break;
        case 'spots':
          spots = Array.isArray(m.data) ? m.data : [];
          console.log('[BC popout] spots pushed:', spots.length);
          if (popoutView === 'map' && spotMap) renderMapSpots();
          break;
        case 'vfo':
          if (m.freqKhz != null) currentFreqKhz = m.freqKhz;
          setVfo(currentFreqKhz, m.mode || '');
          break;
        case 'connection':
          setStatus(!!m.online, m.online ? '' : (m.reason === 'kicked' ? 'Main window lost connection' : 'Main window disconnected'));
          break;
        case 'main-closing':
          setStatus(false, 'Main window closed — reopen POTACAT Remote to resync');
          break;
      }
    });

    // Say hello — the main window (if open) responds with a state-snapshot.
    // Retry every 2s until a snapshot arrives so the popout auto-recovers if
    // the main tab was opened after the popout.
    const sayHello = () => {
      try { bc.postMessage({ kind: 'hello', view: popoutView, id: _popoutClientId }); } catch {}
    };
    sayHello();
    const helloTimer = setInterval(() => {
      if (snapshotReceived) { clearInterval(helloTimer); return; }
      sayHello();
    }, 2000);
    // After ~1.5s with no snapshot, surface the "open main first" hint.
    setTimeout(() => {
      if (!snapshotReceived) setStatus(false, 'Waiting for main POTACAT Remote window…');
    }, 1500);
  }

  // ── Winlink mail (the shack's Pat; owner only) ────────────────────────
  // The shack holds the mailbox and runs the session; this tab composes,
  // reads and presses Send / Receive. State arrives as winlink-state.
  var mailState = null;
  var mailLists = { in: [], out: [], sent: [], archive: [] };
  var mailBox = 'in';
  var mailGateways = [];
  var mailGatewayNote = '';
  var mailNoticeThen = null;
  function mailSend(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function mailEl(id) { return document.getElementById(id); }
  // No Winlink password on the shack yet: set the account up from here.
  // winlink.org has no web sign-up; the shack's Pat creates the account.
  var mailAcct = { asked: false, exists: null };
  function mailAcctRender(s) {
    var card = mailEl('mail-acct');
    if (!card) return;
    var need = !!(s.enabled && s.hasPassword === false && (s.patReady || s.patStarted === false));
    card.classList.toggle('hidden', !need);
    card.style.display = need ? 'flex' : 'none';
    if (!need) { mailAcct.asked = false; return; }
    if (!mailAcct.asked) { mailAcct.asked = true; mailSend({ type: 'winlink-account-check' }); }
  }
  function mailAcctAnswer(msg) {
    mailAcct.exists = !!msg.exists;
    mailEl('mail-acct-text').textContent = msg.exists
      ? msg.callsign + ' already has a Winlink account. Enter its password.'
      : msg.callsign + ' has no Winlink account yet. Create one here; winlink.org does not sign up new users on its website.';
    mailEl('mail-acct-email').style.display = msg.exists ? 'none' : '';
    mailEl('mail-acct-go').textContent = msg.exists ? 'Save password' : 'Create my Winlink account';
  }
  function mailAcctResult(msg) {
    if (msg.op === 'account-check') {
      mailEl('mail-acct-text').textContent = 'Could not reach Winlink to check: ' + (msg.error || 'no answer') + '. Close and reopen Mail to try again.';
      mailAcct.asked = false;
      return;
    }
    if (msg.ok) { mailEl('mail-acct-pw').value = ''; showToast(mailAcct.exists ? 'Saved. Try Send / Receive over the internet.' : 'Account created. Send / Receive over the internet is your first login.', 4000); }
    else mailEl('mail-acct-text').textContent = msg.error || 'That did not work.';
  }
  // Winlink's password rule, a verbatim copy of lib/winlink-pat.js (pinned by test).
  var WINLINK_PASSWORD_RE = /^[A-Za-z0-9.!@#$%^&*()_]{6,12}$/;
  var WINLINK_PASSWORD_HINT = '6 to 12 characters: letters, numbers and . ! @ # $ % ^ & * ( ) _ (no dash, no space)';
  function winlinkPasswordProblem(pw) {
    var s = String(pw == null ? '' : pw);
    if (s.length < 6 || s.length > 12) return 'The Winlink password must be ' + WINLINK_PASSWORD_HINT;
    var bad = s.match(/[^A-Za-z0-9.!@#$%^&*()_]/);
    if (bad) return (bad[0] === ' ' ? 'A space' : '"' + bad[0] + '"') + ' is not allowed in a Winlink password. Allowed: letters, numbers and . ! @ # $ % ^ & * ( ) _';
    return '';
  }
  document.addEventListener('click', function (e) {
    if (!e.target || e.target.id !== 'mail-acct-go') return;
    var pw = mailEl('mail-acct-pw').value;
    var pwProblem = winlinkPasswordProblem(pw);
    if (pwProblem) { mailEl('mail-acct-text').textContent = pwProblem; return; }
    if (mailAcct.exists) mailSend({ type: 'winlink-set-password', password: pw });
    else mailSend({ type: 'winlink-register', password: pw, recoveryEmail: mailEl('mail-acct-email').value.trim() || undefined });
  });

  function mailRenderState() {
    var s = mailState || {};
    mailAcctRender(s);
    var btn = mailEl('mail-tab-btn');
    if (btn) btn.classList.toggle('hidden', !s.enabled);
    var badge = mailEl('tab-mail-badge');
    if (badge) { badge.textContent = String(s.unread || 0); badge.classList.toggle('hidden', !s.unread); }
    var sel = mailEl('mail-mode');
    if (sel) {
      var cur = sel.value || s.mode || 'telnet';
      sel.innerHTML = (s.modes || []).map(function (m) {
        return '<option value="' + esc(m.id) + '"' + (m.available ? '' : ' disabled') + '>' + esc(m.label) + (m.available ? '' : ' (unavailable)') + '</option>';
      }).join('');
      var ok = (s.modes || []).some(function (m) { return m.id === cur && m.available; });
      sel.value = ok ? cur : 'telnet';
      mailEl('mail-radio').classList.toggle('hidden', sel.value === 'telnet');
    }
    mailRenderSession();
  }
  function mailActive(ss) { return ['starting', 'connecting', 'connected', 'disconnecting'].indexOf(ss.state) >= 0; }
  function mailRenderSession() {
    var s = mailState || {};
    var ss = s.session || {};
    var el = mailEl('mail-session');
    if (!el) return;
    if (!s.patReady) { el.textContent = s.patError ? 'Shack: ' + s.patError : 'The shack is starting Pat…'; }
    else {
      var t = ss.state === 'error' ? (ss.error || 'Session failed') : (ss.text || '');
      if (mailActive(ss) && ss.subject) t = (ss.direction === 'receiving' ? 'Receiving ' : 'Sending ') + '"' + ss.subject + '" ' + (ss.pct || 0) + '%';
      if (mailActive(ss) && ss.remainingSec != null) t += ' · ' + Math.floor(ss.remainingSec / 60) + ' min left';
      if (mailActive(ss) && ss.mode !== 'telnet') t = (ss.ptt ? 'TX · ' : 'RX · ') + t;
      var words = { starting: 'Starting', connecting: 'Connecting', connected: 'Connected', disconnecting: 'Stopping', done: '', error: 'Failed: ' };
      el.textContent = (words[ss.state] ? words[ss.state] + (ss.state === 'error' ? '' : ' · ') : '') + t;
      el.style.color = ss.state === 'error' ? '#e94560' : ss.state === 'done' ? '#4ecca3' : '';
      el.style.fontWeight = (ss.state === 'done' || ss.state === 'error') ? '700' : '';
    }
    mailEl('mail-connect').classList.toggle('hidden', mailActive(ss));
    mailEl('mail-abort').classList.toggle('hidden', !mailActive(ss));
    var pr = mailEl('mail-prompt');
    var p = ss.prompt;
    pr.classList.toggle('hidden', !p);
    if (p) {
      var busy = p.kind === 'busy-channel';
      pr.innerHTML = '<span style="flex:1">' + esc(busy ? 'The frequency is busy.' : (p.message || 'Decision needed')) + '</span>'
        + '<button type="button" id="mail-p-yes">' + (busy ? 'Keep waiting' : 'Accept') + '</button>'
        + '<button type="button" id="mail-p-no">' + (busy ? 'Give up' : 'Decline') + '</button>';
      mailEl('mail-p-yes').onclick = function () { if (busy) pr.classList.add('hidden'); else mailSend({ type: 'winlink-prompt', id: p.id, value: 'accept' }); };
      mailEl('mail-p-no').onclick = function () { mailSend({ type: 'winlink-prompt', id: p.id, value: busy ? 'abort' : 'decline' }); };
    }
  }
  function mailShowList() {
    mailEl('mail-list').classList.remove('hidden');
    mailEl('mail-reader').classList.add('hidden');
    mailEl('mail-compose').classList.add('hidden');
    mailRenderList();
  }
  function mailRenderList() {
    var rows = mailLists[mailBox] || [];
    var el = mailEl('mail-list');
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:13px;">Nothing here.</div>'; return; }
    el.innerHTML = rows.map(function (m) {
      var who = mailBox === 'in' ? m.from : (m.to || []).join(', ');
      return '<div class="mail-row" data-mid="' + esc(m.mid) + '" style="padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;">'
        + '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-dim);"><span>' + esc(who) + '</span><span>' + esc(new Date(m.date).toLocaleDateString()) + '</span></div>'
        + '<div style="font-size:14px;' + (m.read ? '' : 'font-weight:700;') + '">' + (m.attachments && m.attachments.length ? '[' + m.attachments.length + ' att] ' : '') + esc(m.subject || '(no subject)') + '</div></div>';
    }).join('');
  }
  function mailShowMessage(msg) {
    var m = msg.message || {};
    var r = mailEl('mail-reader');
    mailEl('mail-list').classList.add('hidden');
    mailEl('mail-compose').classList.add('hidden');
    r.classList.remove('hidden');
    r.innerHTML = '<div style="display:flex;gap:6px;margin-bottom:8px;"><button type="button" id="mail-back">Back</button>'
      + (msg.box === 'in' ? '<button type="button" id="mail-reply">Reply</button>' : '')
      + '<span style="flex:1"></span><button type="button" id="mail-del" style="color:#e94560;">Delete</button></div>'
      + '<div style="font-size:12px;color:var(--text-dim);line-height:1.6;"><b style="color:var(--text)">' + esc(m.subject || '') + '</b><br>From ' + esc(m.from) + '<br>To ' + esc((m.to || []).join(', ')) + '</div>'
      + '<div style="white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:13px;margin-top:8px;">' + esc(m.body || '') + '</div>'
      + (m.attachments || []).map(function (a) { return '<button type="button" class="mail-att" data-name="' + esc(a.name) + '" style="margin:6px 6px 0 0;">Save ' + esc(a.name) + '</button>'; }).join('');
    mailEl('mail-back').onclick = mailShowList;
    var rp = mailEl('mail-reply');
    if (rp) rp.onclick = function () { mailCompose(m.from, /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject); };
    var delArmed = null;
    mailEl('mail-del').onclick = function () {
      var b = mailEl('mail-del');
      if (!delArmed) {
        b.textContent = 'Delete this message?';
        delArmed = setTimeout(function () { delArmed = null; b.textContent = 'Delete'; }, 5000);
        return;
      }
      clearTimeout(delArmed); delArmed = null;
      mailSend({ type: 'winlink-delete', box: msg.box, mid: msg.mid }); mailShowList();
    };
    Array.prototype.forEach.call(r.querySelectorAll('.mail-att'), function (b) {
      b.onclick = function () { mailSend({ type: 'winlink-attachment-get', box: msg.box, mid: msg.mid, name: b.getAttribute('data-name') }); };
    });
  }
  function mailRequireNotice(then) {
    if (mailState && mailState.noticeAccepted) { then(); return; }
    mailNoticeThen = then;
    mailEl('mail-notice-text').textContent = (mailState && mailState.noticeText) || '';
    mailEl('mail-notice').classList.remove('hidden');
  }
  function mailCompose(to, subj) {
    mailRequireNotice(function () {
      mailEl('mail-list').classList.add('hidden');
      mailEl('mail-reader').classList.add('hidden');
      mailEl('mail-compose').classList.remove('hidden');
      mailEl('mail-to').value = to || '';
      mailEl('mail-subj').value = subj || '';
      mailEl('mail-body').value = '';
      mailEl('mail-err').textContent = '';
    });
  }
  function mailGatewayLabel(g) {
    var parts = [g.call];
    if (g.dialKhz) parts.push(g.dialKhz.toFixed(1) + ' kHz');
    if (g.qualityWord) parts.push(g.qualityWord + (g.quality != null ? ' ' + g.quality + '%' : ''));
    if (g.distKm != null) parts.push(g.distKm + ' km');
    return parts.join('  ');
  }
  function mailRenderGateways() {
    var sel = mailEl('mail-gateway');
    var note = mailEl('mail-gw-note');
    if (note) note.textContent = mailGatewayNote;
    if (!mailGateways.length) { sel.innerHTML = '<option value="">No gateways for that band</option>'; return; }
    sel.innerHTML = mailGateways.slice(0, 80).map(function (g, i) {
      return '<option value="' + i + '">' + esc(mailGatewayLabel(g)) + '</option>';
    }).join('');
  }
  function mailLoadGateways() {
    var mode = mailEl('mail-mode').value;
    if (mode === 'telnet') return;
    mailEl('mail-gateway').innerHTML = '<option value="">' + (mode === 'packet' || mode === 'varafm' ? 'Loading…' : 'Loading, predicting propagation…') + '</option>';
    mailGatewayNote = '';
    mailSend({ type: 'winlink-gateways-get', mode: mode, band: mailEl('mail-band').value });
  }
  function mailOnOpen() {
    mailSend({ type: 'winlink-list', box: mailBox });
    mailShowList();
  }
  (function mailWire() {
    if (!mailEl('mail-view')) return;
    mailEl('mail-box').addEventListener('change', function () { mailBox = mailEl('mail-box').value; mailOnOpen(); });
    mailEl('mail-new').addEventListener('click', function () { mailCompose('', ''); });
    mailEl('mail-list').addEventListener('click', function (e) {
      var row = e.target.closest('.mail-row');
      if (row) mailSend({ type: 'winlink-read', box: mailBox, mid: row.getAttribute('data-mid') });
    });
    mailEl('mail-cancel').addEventListener('click', mailShowList);
    mailEl('mail-queue').addEventListener('click', function () {
      if (!mailEl('mail-to').value.trim() || !mailEl('mail-subj').value.trim()) { mailEl('mail-err').textContent = 'Add a recipient and a subject'; return; }
      mailSend({ type: 'winlink-compose', to: mailEl('mail-to').value, subject: mailEl('mail-subj').value, body: mailEl('mail-body').value });
    });
    mailEl('mail-mode').addEventListener('change', function () {
      var mode = mailEl('mail-mode').value;
      mailSend({ type: 'winlink-set-mode', mode: mode });
      mailEl('mail-radio').classList.toggle('hidden', mode === 'telnet');
      mailGateways = [];
      mailLoadGateways();
    });
    mailEl('mail-band').addEventListener('change', mailLoadGateways);
    mailEl('mail-gateway').addEventListener('change', function () {
      var g = mailGateways[parseInt(mailEl('mail-gateway').value, 10)];
      if (g && g.dialKhz) mailSend({ type: 'winlink-qsy', dialKhz: g.dialKhz, mode: mailEl('mail-mode').value });
    });
    mailEl('mail-connect').addEventListener('click', function () {
      mailRequireNotice(function () {
        var mode = mailEl('mail-mode').value || 'telnet';
        var o = { type: 'winlink-connect', mode: mode };
        if (mode !== 'telnet') {
          var g = mailGateways[parseInt(mailEl('mail-gateway').value, 10)];
          if (!g) { showToast('Pick a gateway first', 3000, true); return; }
          o.gateway = g.call; o.dialKhz = g.dialKhz; o.url = g.url;
        }
        mailSend(o);
      });
    });
    mailEl('mail-abort').addEventListener('click', function () { mailSend({ type: 'winlink-abort' }); });
    mailEl('mail-notice-ok').addEventListener('click', function () {
      mailSend({ type: 'winlink-accept-notice' });
      if (mailState) mailState.noticeAccepted = true;
      mailEl('mail-notice').classList.add('hidden');
      var f = mailNoticeThen; mailNoticeThen = null; if (f) f();
    });
    mailEl('mail-notice-no').addEventListener('click', function () { mailEl('mail-notice').classList.add('hidden'); mailNoticeThen = null; });
  })();

  // Auto-connect on page load (or bootstrap popout view)
  if (isPopout) {
    bootstrapPopout();
  } else {
    connect('');
  }
})();
