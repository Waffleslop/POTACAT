// --- Startup timing instrumentation ---
// `npm start --startup-timing` (or POTACAT_STARTUP_TIMING=1) prints a
// `[startup] +Nms : <stage>` line at every checkpoint below. Helps
// diagnose the "sometimes opens fast, sometimes 3-5s lag" symptom:
// the slow run will have one stage that visibly jumps (typically AV
// scan, native module load, or a network call at boot).
const _startupTs = Date.now();
const _startupTiming = process.argv.includes('--startup-timing') ||
  process.argv.includes('--startup-debug') ||
  process.env.POTACAT_STARTUP_TIMING === '1';
let _lastStageTs = _startupTs;
function logStartupStage(name) {
  if (!_startupTiming) return;
  const now = Date.now();
  const total = now - _startupTs;
  const delta = now - _lastStageTs;
  _lastStageTs = now;
  // Pad to align so the visual scan picks out the slow stage immediately.
  // ASCII-only: Windows cmd (CP437/850) mangles Greek delta and em-dash
  // into mojibake. Format reads as "total +Xms, delta +Yms".
  console.error(`[startup] +${String(total).padStart(5, ' ')}ms (+${String(delta).padStart(5, ' ')}ms): ${name}`);
}

const { app, BrowserWindow, ipcMain, Menu, dialog, Notification, screen, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
logStartupStage('electron + path + fs required');

// --- Headless mode: POTACAT --headless ---
// Runs the full app with a hidden window — no GUI shown.
// Useful for serving ECHOCAT from a headless server (e.g. Raspberry Pi).
// All features work: CAT, spots, FT8 engine, ECHOCAT, CW keyer.
const HEADLESS = process.argv.includes('--headless');

// --- Print TLS cert fingerprint and exit ---
// `POTACAT --print-cert-fingerprint` prints the SHA-256 fingerprint of the
// active ECHOCAT TLS cert and exits. The mobile app pairs by pinning this
// fingerprint, so users / devs need a way to read it out-of-band when the
// QR-pair flow isn't available (e.g. headless server boxes).
if (process.argv.includes('--print-cert-fingerprint')) {
  const crypto = require('crypto');
  // Resolve the same certDir RemoteServer uses. Electron's userData isn't
  // available before app.whenReady, so we wait for it.
  app.whenReady().then(() => {
    const certPath = path.join(app.getPath('userData'), 'remote-cert.pem');
    if (!fs.existsSync(certPath)) {
      console.error(`No cert found at ${certPath}.`);
      console.error('Run POTACAT once with ECHOCAT enabled to generate one, then re-run this command.');
      app.exit(1);
      return;
    }
    try {
      const pem = fs.readFileSync(certPath, 'utf8');
      const cert = new crypto.X509Certificate(pem);
      // fingerprint256 is "AA:BB:CC:..." — that's the format the mobile
      // app pins against. Print it on its own line so scripts can grep
      // and slice without parsing.
      process.stdout.write(cert.fingerprint256 + '\n');
      app.exit(0);
    } catch (err) {
      console.error('Failed to read or parse cert:', err.message);
      app.exit(1);
    }
  });
  return;
}

// --- Launcher-only mode: POTACAT.exe --launcher ---
// Runs the lightweight HTTPS launcher server without any GUI.
// Used by the Windows/macOS/Linux Startup to start/stop POTACAT remotely.
// No external Node.js required — uses Electron's embedded runtime.
if (process.argv.includes('--launcher')) {
  const { Tray, Menu, nativeImage: ni } = require('electron');
  const launcherScript = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'launcher.js')
    : path.join(__dirname, 'scripts', 'launcher.js');
  // Prevent Electron from quitting when there are no windows
  app.on('window-all-closed', (e) => { /* keep running */ });
  // Catch EADDRINUSE gracefully — another launcher is already running
  process.on('uncaughtException', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('[Launcher] Port already in use — exiting quietly.');
      app.quit();
      return;
    }
    console.error('[Launcher] Fatal:', err.message);
    app.quit();
  });
  app.whenReady().then(() => {
    if (fs.existsSync(launcherScript)) {
      require(launcherScript);
      console.log('[Launcher] Running in headless mode on port 7301');
    } else {
      console.error('[Launcher] Script not found:', launcherScript);
      app.quit();
      return;
    }
    // System tray icon — use .ico on Windows, resized png on Mac/Linux
    const { shell } = require('electron');
    let trayIcon;
    if (process.platform === 'win32') {
      trayIcon = path.join(__dirname, 'assets', 'icon.ico');
    } else {
      // macOS menu bar icons must be 16x16 (or 32x32 @2x) — resize from 256px
      const img = ni.createFromPath(path.join(__dirname, 'assets', 'icon-256.png'));
      trayIcon = img.resize({ width: 16, height: 16 });
    }
    const tray = new Tray(trayIcon);
    tray.setToolTip('POTACAT Launcher (port 7301)');
    tray.on('click', () => shell.openExternal('https://localhost:7301'));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Launcher', click: () => shell.openExternal('https://localhost:7301') },
      { type: 'separator' },
      { label: 'POTACAT Launcher', enabled: false },
      { label: 'Port: 7301', enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  });
  return; // skip all GUI initialization below
}

// Prevent EPIPE crashes when stdout/stderr pipe is closed
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

// Allow AudioContext to play without user gesture (required for JTCAT audio capture in Chromium 142+)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const { execFile, spawn } = require('child_process');
const { fetchSpots: fetchPotaSpots } = require('./lib/pota');
const { fetchSpots: fetchSotaSpots, fetchSummitCoordsBatch, summitCache, loadAssociations, getAssociationName, SotaUploader } = require('./lib/sota');
const sotaUploader = new SotaUploader();
const { CatClient, RigctldClient, CivClient, listSerialPorts } = require('./lib/cat');
// New rig abstraction layer
const { RigController } = require('./lib/rig-controller');
const { TcpTransport, SerialTransport } = require('./lib/transport');
const { RsBa1Transport } = require('./lib/rsba1-transport');
const { KenwoodCodec } = require('./lib/codecs/kenwood-codec');
const { RigctldCodec } = require('./lib/codecs/rigctld-codec');
const { CivCodec } = require('./lib/codecs/civ-codec');
const { getTuneQuirks } = require('./lib/rig-models');
const { gridToLatLon, haversineDistanceMiles, bearing } = require('./lib/grid');
const { freqToBand } = require('./lib/bands');
const { loadCtyDat, resolveCallsign, getAllEntities } = require('./lib/cty');
const { parseAdifFile, parseWorkedQsos, parseAllQsos, parseAllRawQsos, parseAdifStream, parseSqliteFile, parseSqliteConfirmed, isSqliteFile, parseRecord: parseAdifRecord } = require('./lib/adif');
const { DxClusterClient } = require('./lib/dxcluster');
const { RbnClient } = require('./lib/rbn');
const { appendQso, buildAdifRecord, appendImportedQso, appendRawQso, rewriteAdifFile, ADIF_HEADER, adifField } = require('./lib/adif-writer');
const { SmartSdrClient, setColorblindMode: setSmartSdrColorblind } = require('./lib/smartsdr');
const { TciClient, setTciColorblindMode } = require('./lib/tci');
const { AntennaGeniusClient } = require('./lib/antenna-genius');
const { TunerGeniusClient } = require('./lib/tuner-genius');
const { FreedvEngine } = require('./lib/freedv-engine');
const { SstvEngine } = require('./lib/sstv-engine');
const { SstvManager } = require('./lib/sstv-manager');
const { FreedvReporterClient } = require('./lib/freedv-reporter');
const { IambicKeyer } = require('./lib/keyer');
const { WinKeyer } = require('./lib/winkeyer');
const { parsePotaParksCSV } = require('./lib/pota-parks');
const { PotaSync } = require('./lib/pota-sync');
const { WsjtxClient, extractCallsigns, encodeHeartbeat, encodeLoggedAdif, encodeQsoLogged } = require('./lib/wsjtx');
const { PskrClient } = require('./lib/pskreporter');
const { Ft8Engine } = require('./lib/ft8-engine');
const { RemoteServer } = require('./lib/remote-server');
const { loadClubUsers, hashPasswords, hasPlaintextPasswords } = require('./lib/club-users');
const { createAuditLogger } = require('./lib/club-audit');
const { fetchSpots: fetchWwffSpots } = require('./lib/wwff');
const { fetchSpots: fetchTilesSpots, resetCursor: resetTilesCursor, parseFreqKhz: parseTilesFreqKhz } = require('./lib/tiles');
const { fetchSpots: fetchLlotaSpots } = require('./lib/llota');
const { postWwffRespot } = require('./lib/wwff-respot');
const { fetchNets: fetchDirectoryNets, fetchSwl: fetchDirectorySwl } = require('./lib/directory');
const { QrzClient } = require('./lib/qrz');
const { callsignToProgram, fetchParksForProgram, loadParksCache, saveParksCache, isCacheStale, searchParks: searchParksDb, getPark: getParkDb, buildParksMap } = require('./lib/pota-parks-db');
const { fetchDxCalExpeditions } = require('./lib/dxcal');
const { getModel, getModelList } = require('./lib/rig-models');
const { autoUpdater } = require('electron-updater');
let registerCloudIpc;
try { registerCloudIpc = require('./lib/cloud-ipc').registerCloudIpc; } catch { registerCloudIpc = null; }
logStartupStage('top-level requires complete');

// --- QRZ.com callsign lookup ---
let qrz = new QrzClient();

// --- Cloud Sync (initialized in app.whenReady) ---
let cloudIpc = null;
let potaSync = null; // lib/pota-sync.js instance — created lazily on first access

// --- Parks DB (activator mode) ---
let parksArray = [];
let parksMap = new Map();
let parksDbPrefix = '';
let parksDbLoading = false;

// --- cty.dat database (loaded once at startup) ---
let ctyDb = null;

// --- Settings ---
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return { grid: 'FN20jb', catTarget: null, enablePota: true, enableSota: false, firstRun: true, watchlist: 'K3SBP' };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

let settings = null;
let win = null;
let popoutWin = null; // pop-out map window
let qsoPopoutWin = null; // pop-out QSO log window
let actmapPopoutWin = null; // pop-out activation map window
let spotsPopoutWin = null; // pop-out spots window (activator mode)
let clusterPopoutWin = null; // pop-out DX cluster terminal window
let propPopoutWin = null;    // pop-out propagation map window
let vfoPopoutWin = null;     // pop-out VFO window
let jtcatPopoutWin = null;   // pop-out JTCAT window
let sstvPopoutWin = null;    // pop-out SSTV window
let bandspreadPopoutWin = null; // pop-out bandspread window
let logPopoutWin = null;     // pop-out Log QSO window (W9TEF "ragchew logger" feature)
let lastMergedSpots = [];        // most recent dedupe'd spot list, cached so the
                                 // bandspread-popout-push handler can substitute
                                 // the renderer's table-filtered payload with the
                                 // panadapter's allowlist when "Sync with Table
                                 // View" is off (K0OTC 2026-04-30).
let sstvEngine = null;       // SSTV encode/decode engine (single-slice)
let _sstvLastActivityMs = 0; // last VIS/image timestamp — for heartbeat log
let _sstvHeartbeatTimer = null;
let sstvManager = null;      // SSTV multi-slice manager
let openSstvPopout = null;   // function — assigned in second whenReady block
let startSstv = null;        // function — assigned in second whenReady block (same reason)
const SSTV_GALLERY_DIR = path.join(app.getPath('userData'), 'sstv-gallery');
function ensureSstvGalleryDir() {
  if (!fs.existsSync(SSTV_GALLERY_DIR)) fs.mkdirSync(SSTV_GALLERY_DIR, { recursive: true });
}
let jtcatMapPopoutWin = null; // pop-out JTCAT map window
let popoutJtcatQso = null;   // QSO state for popout (like remoteJtcatQso for ECHOCAT)
let cat = null;
let spotTimer = null;
let solarTimer = null;
let rigctldProc = null;
let cluster = null; // legacy — replaced by clusterClients Map
let clusterSpots = []; // streaming DX cluster spots (FIFO, max 500)
// Non-deduped spot histories so the "spot history" popover can show prior
// spots of the same callsign (clusterSpots itself is deduped per call+band so
// it can't show history). Cap at 2000 entries each — ~1 hour at typical
// rates. Each entry: { callsign, frequency, mode, spotter, comments, source,
// spotTime, band }.
let _dxcSpotHistory = [];
let _rbnSpotHistory = [];
// POTA/WWFF have no usable public spot-history endpoint — pota.app's
// /spot/comments/{ref}/{call} returns empty arrays even for activators with
// dozens of spots in their current activation. We accumulate raw spots from
// the standard /spot/activator polls instead, deduped by spotId so the same
// spot appearing across successive polls only lands in the buffer once.
let _potaSpotHistory = [];
let _wwffSpotHistory = [];
const _potaSpotIds = new Set();
const _wwffSpotIds = new Set();
const _SPOT_HISTORY_CAP = 2000;
let clusterFlushTimer = null; // throttle timer for cluster -> renderer updates
let cwSpotsClients = new Map(); // club -> DxClusterClient (one per checked club, or single for all)
let cwSpots = []; // streaming CW club spots (FIFO, max 500)
let cwSpotsFlushTimer = null; // throttle timer for CW spots -> renderer updates
let rbn = null;
let rbnSpots = []; // streaming RBN spots (FIFO, max 500)
let rbnFlushTimer = null; // throttle timer for RBN -> renderer updates
let rbnWatchSpots = []; // RBN spots for watchlist callsigns, merged into main table
let smartSdr = null;
let smartSdrPushTimer = null; // throttle timer for SmartSDR spot pushes
let tciClient = null;
let tciPushTimer = null; // throttle timer for TCI spot pushes
let agClient = null; // 4O3A Antenna Genius client
let agLastBand = null; // last band we switched to (avoid redundant commands)
let tgxlClient = null; // FlexRadio TunerGenius 1x3 client
let tgxlLastBand = null;
let freedvReporter = null; // FreeDV Reporter (qso.freedv.org) client
let freedvEngine = null;   // FreeDV codec engine (started on tune to FreeDV spot)
let _freedvAudioMuted = false; // true when ECHOCAT audio is muted for FreeDV
let freedvReporterSpots = []; // accumulates FreeDV spots
let freedvReporterFlushTimer = null;
let workedQsos = new Map(); // callsign -> [{date, ref}] from QSO log (all QSOs, not just confirmed)
// Richer per-callsign QSO history used by the "ragchew logger" pop-out
// (W9TEF feature: show past QSOs when typing a callsign in the log form).
// Keyed by callsign uppercase, /SUFFIX stripped. Each value is an array of
// QSOs sorted newest-first. We keep this separate from `workedQsos` (which
// only tracks date+ref for the "hide already worked" filter) because the
// log form wants mode/freq/band/comment too. Built from parseAllRawQsos at
// startup and on log-path change; appended to incrementally on each save.
let qsoDetails = new Map(); // callsign -> [{date, time, mode, freq, band, comment, ref}, ...]
let rosterWorkedDxcc = new Set();  // "EntityName|20m" — DXCC entities worked per band
let rosterWorkedCalls = new Set(); // "K1ABC" — all callsigns ever worked
let rosterWorkedGrids = new Set(); // "FN42" — all grids ever worked
let workedParks = new Map(); // reference -> park data from POTA parks CSV
let wsjtx = null;
let wsjtxStatus = null; // last Status message from WSJT-X
let wsjtxHighlightTimer = null; // throttle timer for highlight updates
let donorCallsigns = new Set(); // supporter callsigns from potacat.com
let expeditionCallsigns = new Set(); // active DX expeditions from Club Log + danplanet iCal
let expeditionMeta = new Map(); // callsign -> { entity, startDate, endDate, description }
let activeEvents = [];                // events fetched from remote endpoint
const EVENTS_CACHE_PATH = path.join(app.getPath('userData'), 'events-cache.json');
let directoryNets = [];               // HF nets from community Google Sheet
let directorySwl = [];                // SWL broadcasts from community Google Sheet
const DIRECTORY_CACHE_PATH = path.join(app.getPath('userData'), 'directory-cache.json');
let pskr = null;
let pskrSpots = [];       // streaming PSKReporter FreeDV spots (FIFO, max 500)
let pskrFlushTimer = null; // throttle timer for PSKReporter -> renderer updates
let pskrMap = null;            // PskrClient for dedicated PSKReporter Map view
let pskrMapSpots = [];         // receiver spots for PSKReporter Map (FIFO, max 500)
let pskrMapFlushTimer = null;  // throttle timer for PSKReporter Map -> renderer
let keyer = null;          // IambicKeyer instance for CW MIDI keying
let winKeyer = null;       // K1EL WinKeyer instance for hardware CW keying
let remoteServer = null;   // RemoteServer instance for phone remote access
let cwKeyPort = null;      // Dedicated SerialPort for DTR CW keying (external USB-serial adapter)
let _cwKeyPortEverOpened = false; // Becomes true after the first successful open this session — gates startup vs reconnect auto-open
let remoteAudioWin = null; // hidden BrowserWindow for WebRTC audio bridge
let _currentFreqHz = 0;    // tracked for remote radio status
let _currentMode = '';
let _remoteTxState = false;
let _currentNbState = false;
let _currentSmeter = 0;
// Stored alongside _currentSmeter so broadcastRemoteRadioStatus() can include
// them in the status snapshot — mobile reads status.swr / status.alc / .power
// from the snapshot. Discrete {type:'smeter'|'swr'|'alc'} messages still fire
// for live meter updates. (Gap 10, mobile dev report 2026-05-03.)
let _currentSwr = 0;
let _currentAlc = 0;
let _currentPower = 0; // live wattmeter reading from the rig (during TX)
let _currentAtuState = false;
let _currentVfo = 'A';
let _currentFilterWidth = 0;
let _currentRfGain = 0;
let _currentTxPower = 0; // 0 = unknown until radio reports actual power
let _vfoLocked = false;  // VFO lock — blocks tune requests from spots/table/map
let _rfGainSuppressBroadcast = 0;  // timestamp: suppress ECHOCAT echo-back until this time
let _txPowerSuppressBroadcast = 0;

// Filter preset tables for rig controls (Hz values)
const FILTER_PRESETS = {
  SSB: [1800, 2100, 2400, 2700, 3000, 3600],
  CW:  [50, 100, 200, 500, 1000, 1500, 2400],
  DIG: [500, 1000, 2000, 3000, 4000],
};

function getFilterPresets(mode) {
  const m = (mode || '').toUpperCase();
  if (m === 'CW') return FILTER_PRESETS.CW;
  if (m === 'FT8' || m === 'FT4' || m === 'FT2' || m === 'DIGU' || m === 'DIGL' || m === 'RTTY' || m === 'PKTUSB' || m === 'PKTLSB') return FILTER_PRESETS.DIG;
  return FILTER_PRESETS.SSB; // default for SSB/USB/LSB/FM/AM
}

function findNearestPreset(presets, currentWidth) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < presets.length; i++) {
    const d = Math.abs(presets[i] - currentWidth);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function detectRigType() {
  const target = settings.catTarget;
  if (!target) return 'unknown';
  if (target.type === 'icom' || target.type === 'civ-tcp' || target.type === 'icom-network') return 'icom';
  if (target.type === 'rigctld' || target.type === 'rigctldnet') return 'rigctld';
  if (target.type === 'tcp') return 'flex'; // TCP CAT ports 5002-5005 are always FlexRadio
  if (target.type === 'serial') {
    // New rig layer: check model brand directly (no runtime FA digit detection needed)
    if (cat && cat.model && cat.model.brand === 'Yaesu') return 'yaesu';
    // Old rig layer fallback: runtime Yaesu detection via FA digit count
    if (cat && cat._isYaesu && cat._isYaesu()) return 'yaesu';
    return 'kenwood';
  }
  return 'unknown';
}

/** Get the active rig's model entry from rig-models.js, or null */
function getActiveRigModel() {
  const activeRig = (settings.rigs || []).find(r => r.id === settings.activeRigId);
  const modelName = activeRig?.model || null;
  const rigType = detectRigType();
  return getModel(modelName, rigType);
}

function getRigCapabilities(rigType) {
  // Try model-specific capabilities first
  const model = getActiveRigModel();
  if (model && model.caps) {
    const caps = { ...model.caps };
    // Include power limits so UI can clamp sliders
    if (model.minPower != null) caps.minPower = model.minPower;
    if (model.maxPower != null) caps.maxPower = model.maxPower;
    return caps;
  }
  // Fallback to generic per-type
  switch (rigType) {
    case 'flex':    return { nb: true, atu: true, vfo: false, filter: true, filterType: 'arbitrary', rfgain: true, txpower: true, power: false };
    case 'yaesu':   return { nb: true, atu: true, vfo: true, filter: true, filterType: 'indexed', rfgain: true, txpower: true, power: true };
    case 'kenwood': return { nb: true, atu: true, vfo: true, filter: true, filterType: 'direct', rfgain: true, txpower: true, power: true };
    case 'icom':    return { nb: false, atu: false, vfo: false, filter: false, filterType: 'none', rfgain: false, txpower: false, power: true };
    case 'rigctld': return { nb: true, atu: true, vfo: true, filter: true, filterType: 'passband', rfgain: true, txpower: true, power: true };
    default:        return { nb: false, atu: false, vfo: false, filter: false, filterType: 'none', rfgain: false, txpower: false, power: false };
  }
}

// --- Watchlist notifications ---
const recentNotifications = new Map(); // callsign -> timestamp for dedup (5-min window)

// Parse watchlist string into array of { callsign, band, mode } rules.
// Format: "K3SBP, K4SWL:20m, KI6NAZ:CW, W1AW:40m:SSB"
// Band/mode qualifiers are optional — omitted means match any.
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

function notifyWatchlistSpot({ callsign, frequency, mode, source, reference, locationDesc }) {
  // Skip if pop-up notifications are disabled
  if (settings.notifyPopup === false) return;

  // Dedup: skip if same callsign notified within 5 minutes
  const now = Date.now();
  const lastTime = recentNotifications.get(callsign);
  if (lastTime && now - lastTime < 300000) return;

  // Prune stale entries
  for (const [cs, ts] of recentNotifications) {
    if (now - ts >= 300000) recentNotifications.delete(cs);
  }

  recentNotifications.set(callsign, now);

  // Build notification body
  const freqMHz = (parseFloat(frequency) / 1000).toFixed(3);
  let body = `${freqMHz} MHz`;
  if (mode) body += ` ${mode}`;
  const sourceLabels = { pota: 'POTA', sota: 'SOTA', wwff: 'WWFF', llota: 'LLOTA', dxc: 'DX Cluster', rbn: 'RBN', pskr: 'FreeDV' };
  const label = sourceLabels[source] || source;
  if (reference) {
    body += ` \u2014 ${label} ${reference}`;
  } else if (locationDesc) {
    body += ` \u2014 ${label} ${locationDesc}`;
  } else {
    body += ` \u2014 ${label}`;
  }

  const silent = settings.notifySound === false;
  const n = new Notification({ title: callsign, body, silent });
  n.show();

  // Auto-dismiss after configured timeout (default 10s)
  const timeout = (settings.notifyTimeout || 10) * 1000;
  setTimeout(() => { try { n.close(); } catch { /* already dismissed */ } }, timeout);
}

// --- Rigctld management ---
let rigctldStderr = ''; // accumulated stderr from rigctld process (capped at 4KB)

function findRigctld() {
  // Check user-configured path first
  if (settings && settings.rigctldPath) {
    try {
      fs.accessSync(settings.rigctldPath, fs.constants.X_OK);
      return settings.rigctldPath;
    } catch { /* fall through */ }
  }

  // Check bundled path (packaged app vs dev)
  const isWin = process.platform === 'win32';
  const rigBin = isWin ? 'rigctld.exe' : 'rigctld';
  const bundledPath = app.isPackaged
    ? path.join(process.resourcesPath, 'hamlib', rigBin)
    : path.join(__dirname, 'assets', 'hamlib', rigBin);
  try {
    fs.accessSync(bundledPath, fs.constants.X_OK);
    return bundledPath;
  } catch { /* fall through */ }

  // Check common install directories
  const candidates = isWin ? [
    'C:\\Program Files\\hamlib\\bin\\rigctld.exe',
    'C:\\Program Files (x86)\\hamlib\\bin\\rigctld.exe',
    'C:\\hamlib\\bin\\rigctld.exe',
  ] : [
    '/usr/bin/rigctld',
    '/usr/local/bin/rigctld',
    '/opt/homebrew/bin/rigctld',    // macOS Apple Silicon (Homebrew)
    '/opt/local/bin/rigctld',       // macOS MacPorts
    '/snap/bin/rigctld',
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* continue */ }
  }

  // Fall back to PATH (just the bare name — execFile will search PATH)
  console.log('[hamlib] rigctld not found at bundled or system paths — falling back to PATH');
  return 'rigctld';
}

function listRigs(rigctldPath) {
  return new Promise((resolve, reject) => {
    execFile(rigctldPath, ['-l'], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        console.error('[hamlib] rigctld -l failed:', err.message);
        sendCatLog(`[hamlib] rigctld not found or failed: ${err.message}. On Linux, install hamlib: sudo apt install libhamlib-utils`);
        return reject(err);
      }
      const lines = stdout.split('\n');
      const rigs = [];
      const SKIP_IDS = new Set([1, 2, 6]);
      const SKIP_MFG = new Set(['Dummy', 'NET']);
      for (const line of lines) {
        const m = line.match(/^\s*(\d+)\s+(\S+(?:\s+\S+)*?)\s{2,}(\S+(?:\s+\S+)*?)\s{2,}(\S+)\s+(\S+)/);
        if (m) {
          const id = parseInt(m[1], 10);
          const mfg = m[2].trim();
          if (SKIP_IDS.has(id) || SKIP_MFG.has(mfg)) continue;
          rigs.push({ id, mfg, model: m[3].trim(), version: m[4], status: m[5] });
        }
      }
      // Sort alphabetically by manufacturer, then model
      rigs.sort((a, b) => {
        const cmp = a.mfg.localeCompare(b.mfg, undefined, { sensitivity: 'base' });
        if (cmp !== 0) return cmp;
        return a.model.localeCompare(b.model, undefined, { sensitivity: 'base' });
      });
      resolve(rigs);
    });
  });
}

function killRigctld() {
  if (rigctldProc) {
    try { rigctldProc.kill(); } catch { /* ignore */ }
    rigctldProc = null;
  }
}

function spawnRigctld(target, portOverride) {
  return new Promise((resolve, reject) => {
    const rigctldPath = findRigctld();
    const port = portOverride || String(target.rigctldPort || 4532);
    const args = [
      '-m', String(target.rigId),
      '-r', target.serialPort,
      '-s', String(target.baudRate || 9600),
      '-t', port,
    ];
    // Separate PTT port (DigiRig / SignaLink / etc.) — tell rigctld to
    // drive PTT via DTR or RTS on the supplied serial port instead of
    // the rig's own CAT command. Required for older rigs whose CAT PTT
    // doesn't switch the audio path to the USB CODEC. (N4RDX on
    // IC-706MKIIG: TX worked in WSJT-X but not POTACAT because POTACAT
    // was PTT'ing via CAT only.)
    //
    // Two adapter shapes exist:
    //   - "Full-size" DigiRig: two virtual COM ports, one for CI-V
    //     data, the other wired to the rig's PTT line. CAT and PTT
    //     ports MUST be different.
    //   - "DigiRig Mobile" / single-port adapters: one virtual COM,
    //     CI-V data and a DTR-or-RTS-keyed PTT line on the SAME port.
    //     CAT and PTT ports MUST be the same. (N4RDX 2026-04-29.)
    //
    // We can't tell which shape the user has from POTACAT's side, so
    // we let them pick and only emit a non-fatal note if a same-port
    // config looks suspicious. The pttType setting (DTR/RTS) lets
    // single-port-Mobile users who key on RTS actually hit their
    // hardware.
    if (target.pttPort) {
      const ptt = String(target.pttPort).trim().toLowerCase();
      const cat = String(target.serialPort || '').trim().toLowerCase();
      const pttType = (target.pttType || 'DTR').toUpperCase();
      if (ptt === cat) {
        sendCatLog(`[rigctld] PTT Port matches CAT port (${target.pttPort}). ` +
          `OK for single-port adapters like DigiRig Mobile that key PTT via ${pttType} on the CI-V port. ` +
          `If you have a full-size DigiRig (two virtual COM ports), this will fail — pick the OTHER port instead.`);
      }
      args.push('--ptt-type=' + (pttType === 'RTS' ? 'RTS' : 'DTR'));
      args.push('--ptt-file=' + target.pttPort);
    }
    if (target.dtrOff) args.push('--set-conf=dtr_state=OFF,rts_state=OFF');
    if (target.verbose) args.push('-vvvv');

    if (!portOverride) killRigctld();
    rigctldStderr = '';

    // Surface the args so users (and bug reporters) can confirm exactly
    // what flags hamlib received — necessary for debugging PTT-Port and
    // similar issues that depend on rigctld being spawned with the right
    // configuration. (N4RDX report on v1.5.8: PTT Port set but TX still
    // not working — without this log line we couldn't tell whether the
    // setting reached spawn.)
    sendCatLog('rigctld spawn: ' + args.map((a) => /\s/.test(a) ? '"' + a + '"' : a).join(' '));

    const proc = spawn(rigctldPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    if (!portOverride) rigctldProc = proc;

    // Capture stderr (capped at 4KB) and pipe to log panel
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      rigctldStderr += text;
      if (rigctldStderr.length > 4096) rigctldStderr = rigctldStderr.slice(-4096);
      // Send each line to the CAT log panel
      text.split('\n').filter(Boolean).forEach(line => sendCatLog(`[rigctld] ${line}`));
    });

    let settled = false;

    proc.on('error', (err) => {
      if (!portOverride && rigctldProc === proc) rigctldProc = null;
      if (!settled) { settled = true; reject(err); }
    });

    proc.on('exit', (code) => {
      if (!portOverride && rigctldProc === proc) rigctldProc = null;
      // Early exit (before the 500ms init window) means something went wrong
      if (!settled) {
        settled = true;
        const lastLine = rigctldStderr.trim().split('\n').pop() || `rigctld exited with code ${code}`;
        reject(new Error(lastLine));
      } else {
        // Late exit — send error to renderer
        if (!portOverride) {
          const lastLine = rigctldStderr.trim().split('\n').pop() || `rigctld exited with code ${code}`;
          sendCatStatus({ connected: false, error: lastLine });
        }
      }
    });

    // Give rigctld time to start listening
    setTimeout(() => {
      if (!settled) { settled = true; resolve(proc); }
    }, 500);
  });
}

function sendCatStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-status', s);
  if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) jtcatPopoutWin.webContents.send('cat-status', s);
  // If CAT disconnected while ECHOCAT PTT was active, force-release PTT
  // and notify the phone so it can update its UI state
  if (!s.connected && _remoteTxState && remoteServer && remoteServer.running) {
    console.log('[Echo CAT] CAT disconnected during TX — forcing PTT release');
    _remoteTxState = false;
    remoteServer.forcePttRelease();
    if (win && !win.isDestroyed()) {
      win.webContents.send('remote-tx-state', false);
    }
  }
  // CAT (re)connected — if a CW key port is configured AND we've already
  // opened it once this session (i.e., this is a recovery from a transient
  // unplug, not the initial connect), try to open it again. The
  // "ever-opened" flag is what lets us skip the auto-open at very first
  // startup (avoids the WD4DAN spurious-dit) while still recovering from
  // a CW operator's mid-session USB-serial unplug.
  if (s.connected && settings.cwKeyPort && _cwKeyPortEverOpened &&
      !(cwKeyPort && cwKeyPort.isOpen)) {
    connectCwKeyPort();
  }
  // Broadcast rig state on connect/disconnect so the Rig panel updates
  broadcastRigState();
}

function sendCatFrequency(hz) {
  if (hz > 0 && hz < 100000) {
    console.warn(`[CAT] Ignoring suspicious frequency: ${hz} Hz (below 100 kHz)`);
    return;
  }
  if (win && !win.isDestroyed()) win.webContents.send('cat-frequency', hz);
  if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) jtcatPopoutWin.webContents.send('cat-frequency', hz);
  if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) sstvPopoutWin.webContents.send('cat-frequency', hz);
  if (logPopoutWin && !logPopoutWin.isDestroyed()) logPopoutWin.webContents.send('cat-frequency', hz);
  // Bandspread expects kHz, not Hz, so it can draw the VFO cursor at the
  // right x-coordinate without needing CAT plumbing of its own.
  if (bandspreadPopoutWin && !bandspreadPopoutWin.isDestroyed()) {
    bandspreadPopoutWin.webContents.send('bandspread-popout-freq', hz / 1000);
  }
  _currentFreqHz = hz;
  sendVfoState();
  broadcastRemoteRadioStatus();
  sendN1mmRadioInfo();
}

function sendCatMode(mode) {
  // While FreeDV engine is active, display "FreeDV" instead of the radio's USB/LSB
  const displayMode = (freedvEngine && (mode === 'USB' || mode === 'LSB')) ? 'FreeDV' : mode;
  if (win && !win.isDestroyed()) win.webContents.send('cat-mode', displayMode);
  if (bandspreadPopoutWin && !bandspreadPopoutWin.isDestroyed()) {
    bandspreadPopoutWin.webContents.send('bandspread-popout-mode', displayMode);
  }
  if (logPopoutWin && !logPopoutWin.isDestroyed()) logPopoutWin.webContents.send('cat-mode', mode);
  _currentMode = mode; // keep real mode internally for CAT
  // Don't clear mode suppress — handleRemotePtt sets a long suppress during
  // SSB-over-DATA transitions to prevent ECHOCAT from seeing transient DATA modes
  sendVfoState();
  broadcastRigState();
  sendN1mmRadioInfo();
}

function sendCatPower(watts) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-power', watts);
  if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.webContents.send('cat-power', watts);
  if (remoteServer && remoteServer.running) remoteServer.sendToClient({ type: 'power', value: watts });
  _currentTxPower = watts;
  _currentPower = watts;
  broadcastRigState();
}

function sendCatNb(on) {
  // For Flex rigs, NB is controlled via SmartSDR API — ignore Kenwood CAT NB poll
  // responses which can fight with the API state (stale/different values)
  if (detectRigType() === 'flex' && smartSdr && smartSdr.connected) return;
  _currentNbState = on;
  broadcastRigState();
}

function sendCatSmeter(val) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-smeter', val);
  if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.webContents.send('cat-smeter', val);
  _currentSmeter = val;
  if (remoteServer && remoteServer.running) remoteServer.sendToClient({ type: 'smeter', value: val });
}

function sendCatSwr(val) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-swr', val);
  if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.webContents.send('cat-swr', val);
  _currentSwr = val;
  if (remoteServer && remoteServer.running) remoteServer.sendToClient({ type: 'swr', value: val });
}

function sendCatAlc(val) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-alc', val);
  if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.webContents.send('cat-alc', val);
  _currentAlc = val;
  if (remoteServer && remoteServer.running) remoteServer.sendToClient({ type: 'alc', value: val });
}

// Broadcast full rig control state to renderer and ECHOCAT
function broadcastRigState() {
  const rigType = detectRigType();
  const caps = getRigCapabilities(rigType);
  const state = {
    nb: _currentNbState,
    rfGain: _currentRfGain,
    txPower: _currentTxPower,
    filterWidth: _currentFilterWidth,
    atuActive: _currentAtuState,
    mode: _currentMode,
    capabilities: caps,
  };
  if (win && !win.isDestroyed()) win.webContents.send('rig-state', state);
  sendVfoState();
  broadcastRemoteRadioStatus();
}

function sendCatLog(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[CAT ${ts}] ${msg}`;
  try { console.log(line); } catch { /* EPIPE if stdout closed */ }
  if (win && !win.isDestroyed()) win.webContents.send('cat-log', line);
}

// PstRotator UDP rotor control
const dgram = require('dgram');
let rotorSocket = null;

function sendRotorBearing(azimuth) {
  if (!rotorSocket) rotorSocket = dgram.createSocket('udp4');
  const host = settings.rotorHost || '127.0.0.1';
  const port = settings.rotorPort || 12040;
  const msg = Buffer.from(`<PST><AZIMUTH>${azimuth}</AZIMUTH></PST>`);
  rotorSocket.send(msg, port, host, (err) => {
    if (err) sendCatLog(`Rotor UDP error: ${err.message}`);
  });
  sendCatLog(`Rotor -> ${host}:${port} azimuth=${azimuth}°`);
}

// N1MM+ RadioInfo UDP broadcast — sends frequency/mode to band decoders, antenna switches, etc.
let n1mmSocket = null;
let _n1mmLastFreq = 0;
let _n1mmLastMode = '';

function sendN1mmRadioInfo() {
  if (!settings.enableN1mmUdp) return;
  const freq = _currentFreqHz;
  const mode = _currentMode || '';
  // Only send when freq or mode actually changed
  if (freq === _n1mmLastFreq && mode === _n1mmLastMode) return;
  _n1mmLastFreq = freq;
  _n1mmLastMode = mode;

  if (!n1mmSocket) n1mmSocket = dgram.createSocket('udp4');
  const host = settings.n1mmHost || '127.0.0.1';
  const port = settings.n1mmPort || 12060;
  // Freq in N1MM+ format: Hz / 10 (14.074 MHz = 1407400)
  const freqN1mm = Math.round(freq / 10);
  const call = settings.myCallsign || '';
  const activeRig = (settings.rigs || []).find(r => r.id === settings.activeRigId);
  const radioNr = (activeRig && activeRig.radioNr) || 1;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<RadioInfo>
<app>POTACAT</app>
<StationName></StationName>
<RadioNr>${radioNr}</RadioNr>
<Freq>${freqN1mm}</Freq>
<TXFreq>${freqN1mm}</TXFreq>
<Mode>${mode}</Mode>
<OpCall>${call}</OpCall>
<IsRunning>False</IsRunning>
<FocusEntry>0</FocusEntry>
<EntryWindowHwnd>0</EntryWindowHwnd>
<Antenna>0</Antenna>
<Rotors></Rotors>
<FocusRadioNr>${radioNr}</FocusRadioNr>
<IsStereo>False</IsStereo>
<IsSplit>False</IsSplit>
<ActiveRadioNr>${radioNr}</ActiveRadioNr>
<IsTransmitting>False</IsTransmitting>
<FunctionKeyCaption></FunctionKeyCaption>
<RadioName></RadioName>
<AuxAntSelected>-1</AuxAntSelected>
<AuxAntSelectedName></AuxAntSelectedName>
</RadioInfo>`;
  const msg = Buffer.from(xml);
  n1mmSocket.send(msg, port, host, (err) => {
    if (err) sendCatLog(`N1MM UDP error: ${err.message}`);
  });
}

let _connectCatPending = false;
async function connectCat() {
  if (_connectCatPending) return; // prevent concurrent connectCat() calls
  _connectCatPending = true;
  try {
  if (cat) {
    cat.removeAllListeners();
    cat.disconnect();
    // Brief delay to let serial port fully release before reconnecting
    // (prevents "Resource busy" on macOS when switching rigs)
    await new Promise(r => setTimeout(r, 300));
  }
  // Optimistic reset of the paddle-availability flag for the new rig —
  // if the transport later emits 'pin-unsupported' (Linux cdc_acm),
  // the flag drops to false and the phone stops generating sidetone.
  _setCwPaddleAvailability(true, 'rig-changed');
  killRigctld();
  const target = settings.catTarget;
  if (!target) return;

  // --- New rig abstraction layer ---
  // Uses RigController (transport + codec + model) instead of ad-hoc wiring.
  // The model drives ALL protocol differences — no if(_isYaesu) branches.
  const rigModel = getActiveRigModel();

  // FlexRadio uses SmartSDR, not the rig controller
  if (target.type === 'tcp') {
    // Flex: use old CatClient for basic CAT (SmartSDR handles the real work)
    cat = new CatClient();
    cat._debug = true;
    cat._skipMeters = true; // Flex CAT emulation doesn't support SM; or RM1;
    cat.on('log', sendCatLog);
    cat.on('status', sendCatStatus);
    cat.on('frequency', sendCatFrequency);
    cat.on('mode', sendCatMode);
    cat.on('power', sendCatPower);
    cat.on('nb', sendCatNb);
    cat.on('smeter', sendCatSmeter);
    cat.on('swr', sendCatSwr);
    cat.on('alc', sendCatAlc);
    cat.connect(target);
    return;
  }

  // Build transport + codec based on target type and model
  let transport, codec;

  if (target.type === 'rigctld') {
    // Spawn rigctld process first
    try {
      await spawnRigctld(target);
    } catch (err) {
      console.error('Failed to spawn rigctld:', err.message);
      sendCatStatus({ connected: false, target, error: err.message });
      return;
    }
    const rigctldPort = target.rigctldPort || 4532;
    transport = new TcpTransport();
    const model = rigModel || { brand: 'Hamlib', protocol: 'rigctld', caps: {}, cw: {} };
    // Override tune quirks for rigctld: always use M,F,M,F sandwich regardless of
    // the model's native protocol. The sandwich handles band-recall mode reversion
    // AND CW pitch offset (confirmed needed by W3AVP on FT-710 via rigctld).
    model.tune = model.tune || { modeBeforeFreq: true, modeAfterFreq: true, freqAfterMode: true, alwaysResendMode: false, daCommand: false };
    codec = new RigctldCodec(model, (data) => transport.write(data));
    cat = new RigController(model, transport, codec);
    cat._debug = true;
    cat.on('log', sendCatLog);
    cat.on('status', (s) => {
      if (!s.connected && rigctldStderr) {
        const lastLine = rigctldStderr.trim().split('\n').pop();
        if (lastLine) s.error = lastLine;
      }
      sendCatLog(`rigctld status: connected=${s.connected}${s.error ? ' error=' + s.error : ''}`);
      sendCatStatus(s);
    });
    cat.on('frequency', sendCatFrequency);
    cat.on('mode', sendCatMode);
    cat.on('nb', sendCatNb);
    cat.on('smeter', sendCatSmeter);
    cat.on('swr', sendCatSwr);
    cat.on('alc', sendCatAlc);
    sendCatLog(`Connecting to rigctld on 127.0.0.1:${rigctldPort}`);
    transport.connect({ host: '127.0.0.1', port: rigctldPort });

  } else if (target.type === 'rigctldnet') {
    transport = new TcpTransport();
    const model = rigModel || { brand: 'Hamlib', protocol: 'rigctld', caps: {}, cw: {} };
    // Same rigctld sandwich override as above
    model.tune = model.tune || { modeBeforeFreq: true, modeAfterFreq: true, freqAfterMode: true, alwaysResendMode: false, daCommand: false };
    codec = new RigctldCodec(model, (data) => transport.write(data));
    cat = new RigController(model, transport, codec);
    cat._debug = true;
    cat.on('log', sendCatLog);
    cat.on('status', (s) => {
      sendCatLog(`rigctld-net status: connected=${s.connected}${s.error ? ' error=' + s.error : ''}`);
      sendCatStatus(s);
    });
    cat.on('frequency', sendCatFrequency);
    cat.on('mode', sendCatMode);
    cat.on('nb', sendCatNb);
    cat.on('smeter', sendCatSmeter);
    cat.on('swr', sendCatSwr);
    cat.on('alc', sendCatAlc);
    const host = target.host || '127.0.0.1';
    const port = target.port || 4532;
    sendCatLog(`Connecting to remote rigctld on ${host}:${port}`);
    transport.connect({ host, port });

  } else if (target.type === 'icom') {
    transport = new SerialTransport();
    const model = rigModel || { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: {}, cw: {} };
    model.tune = getTuneQuirks(model);
    codec = new CivCodec(model, (data) => transport.write(data));
    cat = new RigController(model, transport, codec);
    cat._debug = true;
    cat.on('log', sendCatLog);
    cat.on('status', sendCatStatus);
    cat.on('frequency', sendCatFrequency);
    cat.on('mode', sendCatMode);
    cat.on('power', sendCatPower);
    cat.on('nb', sendCatNb);
    cat.on('smeter', sendCatSmeter);
    cat.on('swr', sendCatSwr);
    cat.on('alc', sendCatAlc);
    sendCatLog(`Connecting to Icom on ${target.path}`);
    // Default DTR/RTS to LOW on the main CAT port. USB-CDC serial defaults
    // DTR high at open, but many Icom rigs (IC-7300, MK II, etc.) can be
    // configured to use DTR as a CW key source (Menu → SET → Connectors →
    // USB Keying (CW) = USB(A) DTR). In that mode, idle-high DTR means the
    // rig sees CW keyed-down any time it's in CW mode, and the moment the
    // user switches to CW the tone goes out. Forcing DTR low on connect
    // avoids that. POTACAT's CW keying uses CI-V 0x1C 0x01 for paddle
    // elements (or a dedicated cwKeyPort for DTR-keying workflows) so this
    // safety is always correct. Reported by KM4CFT 2026-04-24.
    const dtrOff = target.dtrOff !== false; // default true
    transport.connect({ path: target.path, baudRate: target.baudRate || 19200, dtrOff });

  } else if (target.type === 'civ-tcp') {
    // Raw CI-V frames over TCP. Works with:
    //   - ser2net / socat bridging a USB-serial CI-V port on a remote box
    //   - IC-7300 MK II's built-in "Network CI-V" mode (LAN, port 50001 by
    //     default — gateway to the same CI-V frame format over the wire)
    //   - any other ser2net-style raw passthrough
    // Same codec as the direct-serial 'icom' branch — CivCodec doesn't care
    // what transport carries the bytes.
    transport = new TcpTransport();
    const model = rigModel || { brand: 'Icom', protocol: 'civ', civAddr: target.civAddr || 0x94, caps: {}, cw: {} };
    model.tune = getTuneQuirks(model);
    codec = new CivCodec(model, (data) => transport.write(data));
    cat = new RigController(model, transport, codec);
    cat._debug = true;
    cat.on('log', sendCatLog);
    cat.on('status', sendCatStatus);
    cat.on('frequency', sendCatFrequency);
    cat.on('mode', sendCatMode);
    cat.on('power', sendCatPower);
    cat.on('nb', sendCatNb);
    cat.on('smeter', sendCatSmeter);
    cat.on('swr', sendCatSwr);
    cat.on('alc', sendCatAlc);
    const host = target.host || '127.0.0.1';
    const port = target.port || 50001;
    sendCatLog(`Connecting to Icom CI-V over TCP on ${host}:${port}`);
    transport.connect({ host, port });

  } else if (target.type === 'icom-network') {
    // Icom RS-BA1 protocol over UDP. Works with:
    //   - wfserver (wfview's headless GPLv3 server) bridging a USB-attached
    //     Icom (IC-7300/MK II, IC-7100, etc.) onto the network
    //   - IP-native Icoms with built-in network: IC-705, IC-9700, IC-7610,
    //     IC-7851, IC-R8600
    // Wraps CI-V bytes in RS-BA1 data frames; CivCodec is unchanged from
    // the serial / civ-tcp paths.
    transport = new RsBa1Transport();
    const model = rigModel || { brand: 'Icom', protocol: 'civ', civAddr: target.civAddr || 0x94, caps: {}, cw: {} };
    model.tune = getTuneQuirks(model);
    codec = new CivCodec(model, (data) => transport.write(data));
    cat = new RigController(model, transport, codec);
    cat._debug = true;
    cat.on('log', sendCatLog);
    cat.on('status', sendCatStatus);
    cat.on('frequency', sendCatFrequency);
    cat.on('mode', sendCatMode);
    cat.on('power', sendCatPower);
    cat.on('nb', sendCatNb);
    cat.on('smeter', sendCatSmeter);
    cat.on('swr', sendCatSwr);
    cat.on('alc', sendCatAlc);
    transport.on('log', (m) => sendCatLog(m));
    const host = target.host || '127.0.0.1';
    const controlPort = target.controlPort || target.port || 50001;
    const civPort = target.civPort || null; // null = use whatever the radio reports in Status
    sendCatLog(`Connecting to Icom Network on ${host}:${controlPort} (RS-BA1 protocol)`);
    transport.connect({
      host,
      controlPort,
      civPort,
      username: target.username || '',
      password: target.password || '',
      compName: target.compName || 'POTACAT',
    });

  } else {
    // Kenwood/Yaesu serial
    transport = new SerialTransport();
    const model = rigModel || { brand: 'Kenwood', protocol: 'kenwood', caps: {}, cw: {} };
    model.tune = getTuneQuirks(model);
    codec = new KenwoodCodec(model, (data) => transport.write(data));
    cat = new RigController(model, transport, codec);
    cat._debug = true;
    cat.on('log', sendCatLog);
    cat.on('status', sendCatStatus);
    cat.on('frequency', sendCatFrequency);
    cat.on('mode', sendCatMode);
    cat.on('power', sendCatPower);
    cat.on('nb', sendCatNb);
    cat.on('smeter', sendCatSmeter);
    cat.on('swr', sendCatSwr);
    cat.on('alc', sendCatAlc);
    sendCatLog(`Connecting to ${model.brand || 'radio'} on ${target.path}`);
    transport.connect({ path: target.path, baudRate: target.baudRate || 9600, dtrOff: target.dtrOff, connectDelay: model.connectDelay });
  }

  // Apply user command overrides from settings (Kenwood/Yaesu codec)
  if (cat && settings.rigCommandOverrides) {
    const activeRig = (settings.rigs || []).find(r => r.id === settings.activeRigId);
    const overrides = activeRig?.model && settings.rigCommandOverrides[activeRig.model];
    if (overrides) cat.applyCommandOverrides(overrides);
  }
  // Linux cdc_acm radios reject TIOCMSET, so node-serialport's port.set()
  // call to flip DTR for paddle keying fails on the first try and every try
  // after. The transport emits 'pin-unsupported' once per connection — we
  // catch it here and spin up a long-running pyserial subprocess that
  // toggles DTR/RTS via TIOCMBIS/TIOCMBIC, the per-bit ioctl that cdc_acm
  // does honor. Both processes hold the same /dev/ttyACM* fd in parallel
  // (Linux allows it, modem bits are driver-level not per-fd) so node-
  // serialport keeps doing CAT polling while the helper drives the key.
  if (transport && typeof transport.on === 'function') {
    transport.on('pin-unsupported', ({ path, error }) => {
      // Linux cdc_acm rejects TIOCMSET on USB-CDC radios — the kernel
      // driver simply doesn't honor `port.set({ dtr, rts })` from
      // node-serialport. We can't fix this from JS; the workaround is
      // an external USB-UART (FTDI/CH340) on the radio's CW KEY jack.
      // Notify the phone so its local CW keyer stops generating sidetone
      // for keys that produce no RF — the prior behavior misled users
      // into bug reports about "ECHOCAT broken" (KM4CFT 2026-04-29).
      sendCatLog(
        `[CW paddle] DTR keying not supported on ${path} (${error}) — phone-side paddle disabled. ` +
        'Macros/text-send (CI-V 0x17, hamlib send_morse) still work. ' +
        'For a working paddle: wire an external FTDI/CH340 to the radio\'s CW KEY jack and set it as "CW Key Port" in Settings → Rig.'
      );
      _setCwPaddleAvailability(false, 'tiocmset-unsupported');
    });
  }
  // Surface model-specific gotchas to the CAT log so users see them on
  // connect (FT-710 ATU + CAT timeout, etc.) without having to dig through
  // docs. Keep this generic — any model entry can declare a `notes` array.
  if (rigModel && Array.isArray(rigModel.notes)) {
    for (const note of rigModel.notes) sendCatLog(note);
  }
  } finally {
    _connectCatPending = false;
  }
}

// --- DX Cluster ---

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
  { name: 'S50CLX', host: 's50clx.si', port: 41112 },
];

// --- CW Spots (CW club telnet spotters) ---

const CW_SPOTS_PRESETS = [
  { name: 'CW Club Spotter (all clubs)', host: 'rbn.telegraphy.de', port: 7000, postLogin: ['set/clubs', 'set/nodupes'] },
  { name: 'FOC Members', host: 'foc.dj1yfk.de', port: 7300, postLogin: [] },
  { name: 'FOC + Nominees', host: 'foc.dj1yfk.de', port: 7373, postLogin: [] },
];

// Clean up RBN-style comments for the Name column (strip redundant mode, reorder fields)
const CLUSTER_COMMENT_RE = /^(\S+)\s+(-?\d+)\s*dB\s+(?:(\d+)\s*WPM\s*)?(.*)$/i;
const MODE_KEYWORDS = /^(?:CW|SSB|USB|LSB|FM|AM|FT[48]|RTTY|PSK\d*|JS8)\b/i;
function formatClusterComment(comment) {
  if (!comment) return '';
  const m = comment.match(CLUSTER_COMMENT_RE);
  if (m) {
    // RBN-style: "CW 28 dB 29 WPM CQ" or "FT8 -12 dB CQ"
    const snr = m[2] + ' dB';
    const wpm = m[3] ? m[3] + ' WPM' : null;
    const type = (m[4] || '').trim().toUpperCase();
    const parts = [wpm, snr, type || null].filter(Boolean);
    return parts.join(' \u00b7 ');  // middle dot separator
  }
  // Not RBN format — strip leading mode keyword if present (e.g. "CW JN80oj -> FK85")
  const stripped = comment.replace(MODE_KEYWORDS, '').trim();
  if (stripped && stripped !== comment) {
    return stripped.replace(/->/g, '\u2192');  // arrow
  }
  return comment;
}

// Build a normalized spot from raw cluster data (shared by all cluster clients)
function buildClusterSpot(raw, myPos, myEntity) {
  // Extract WPM from RBN-style comment (e.g. "CW 28 dB 29 WPM CQ")
  const wpmMatch = (raw.comment || '').match(/(\d+)\s*WPM/i);
  const spot = {
    source: 'dxc',
    callsign: raw.callsign,
    frequency: raw.frequency,
    freqMHz: raw.freqMHz,
    mode: raw.mode,
    reference: '',
    parkName: formatClusterComment(raw.comment || ''),
    locationDesc: '',
    distance: null,
    lat: null,
    lon: null,
    band: raw.band,
    spotTime: raw.spotTime,
    wpm: wpmMatch ? parseInt(wpmMatch[1], 10) : null,
  };

  if (ctyDb) {
    const entity = resolveCallsign(raw.callsign, ctyDb);
    if (entity) {
      spot.locationDesc = entity.name;
      spot.continent = entity.continent || '';
      if (entity.lat != null && entity.lon != null) {
        spot.lat = entity.lat;
        spot.lon = entity.lon;
        if (myPos && entity !== myEntity) {
          spot.distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, entity.lat, entity.lon));
          spot.bearing = Math.round(bearing(myPos.lat, myPos.lon, entity.lat, entity.lon));
        }
      }
    }
  }

  return spot;
}

let clusterClients = new Map(); // id -> { client, nodeConfig }

function sendClusterStatus() {
  const nodes = [];
  for (const [id, entry] of clusterClients) {
    nodes.push({ id, name: entry.nodeConfig.name, host: entry.nodeConfig.host, connected: entry.client.connected });
  }
  const s = { nodes };
  if (win && !win.isDestroyed()) win.webContents.send('cluster-status', s);
  // Push cluster state to ECHOCAT phone
  if (remoteServer && remoteServer.running) {
    const anyConnected = nodes.some(n => n.connected);
    remoteServer.broadcastClusterState(anyConnected);
    updateRemoteSettings();
  }
}

function getClusterNodeList() {
  const nodes = [];
  for (const [id, entry] of clusterClients) {
    nodes.push({ id, name: entry.nodeConfig.name, host: entry.nodeConfig.host, connected: entry.client.connected });
  }
  return nodes;
}

function sendClusterNodesToPopout() {
  if (clusterPopoutWin && !clusterPopoutWin.isDestroyed()) {
    clusterPopoutWin.webContents.send('cluster-popout-nodes', getClusterNodeList());
  }
}

function connectCluster() {
  // Disconnect all existing clients
  for (const [, entry] of clusterClients) {
    entry.client.disconnect();
    entry.client.removeAllListeners();
  }
  clusterClients.clear();
  clusterSpots = [];

  // Source fetches if either the table side wants it or the panadapter
  // has independently asked for it (Sync with Table View off + Cluster
  // checked under Settings → Panadapter & Bandscope). K0OTC 2026-04-30.
  const wantCluster = settings.enableCluster === true || panadapterWantsSource('dxc');
  if (!wantCluster || !settings.myCallsign) {
    sendClusterStatus();
    return;
  }

  // Migrate legacy settings if needed
  if (!settings.clusterNodes) {
    migrateClusterNodes();
  }
  // piAccess gate removed — CW keyer, JTCAT, and remote CW are now public
  if (!settings.piAccess) {
    settings.piAccess = true;
    saveSettings(settings);
  }

  const enabledNodes = (settings.clusterNodes || []).filter(n => n.enabled).slice(0, 3);
  if (enabledNodes.length === 0) {
    sendClusterStatus();
    return;
  }

  const myPos = gridToLatLon(settings.grid);
  const myEntity = (ctyDb && settings.myCallsign) ? resolveCallsign(settings.myCallsign, ctyDb) : null;

  for (const node of enabledNodes) {
    const client = new DxClusterClient();

    client.on('spot', (raw) => {
      // Filter beacon stations (/B suffix) unless user opted in
      if (!settings.showBeacons && /\/B$/i.test(raw.callsign)) return;

      const spot = buildClusterSpot(raw, myPos, myEntity);

      // Watchlist notification
      const watchRules = parseWatchlist(settings.watchlist);
      if (watchlistMatch(watchRules, raw.callsign, spot.band, raw.mode)) {
        notifyWatchlistSpot({
          callsign: raw.callsign,
          frequency: raw.frequency,
          mode: raw.mode,
          source: 'dxc',
          reference: '',
          locationDesc: spot.locationDesc,
        });
      }

      // Dedupe: keep only the latest spot per callsign+band (across all nodes)
      const idx = clusterSpots.findIndex(s => s.callsign === spot.callsign && s.band === spot.band);
      if (idx !== -1) clusterSpots.splice(idx, 1);
      clusterSpots.push(spot);
      if (clusterSpots.length > 500) {
        clusterSpots = clusterSpots.slice(-500);
      }
      // Append to non-deduped history so the spot-history popover can show
      // prior spots from different nodes / earlier times.
      _dxcSpotHistory.push(spot);
      if (_dxcSpotHistory.length > _SPOT_HISTORY_CAP) {
        _dxcSpotHistory = _dxcSpotHistory.slice(-_SPOT_HISTORY_CAP);
      }

      if (!clusterFlushTimer) {
        clusterFlushTimer = setTimeout(() => {
          clusterFlushTimer = null;
          sendMergedSpots();
        }, 2000);
      }
    });

    client.on('line', (line) => {
      if (clusterPopoutWin && !clusterPopoutWin.isDestroyed()) {
        clusterPopoutWin.webContents.send('cluster-popout-line', { nodeId: node.id, line });
      }
    });

    client.on('status', () => {
      sendClusterStatus();
      sendClusterNodesToPopout();
    });

    client.connect({
      host: node.host,
      port: node.port,
      callsign: settings.myCallsign,
    });

    clusterClients.set(node.id, { client, nodeConfig: node });
  }
}

function disconnectCluster() {
  if (clusterFlushTimer) {
    clearTimeout(clusterFlushTimer);
    clusterFlushTimer = null;
  }
  for (const [, entry] of clusterClients) {
    entry.client.disconnect();
    entry.client.removeAllListeners();
  }
  clusterClients.clear();
  clusterSpots = [];
  sendClusterStatus();
}

// --- CW Spots connect/disconnect ---

function connectCwSpots() {
  disconnectCwSpots();
  const wantCwSpots = settings.enableCwSpots === true || panadapterWantsSource('cwspots');
  if (!wantCwSpots || !settings.myCallsign) return;
  const host = settings.cwSpotsHost || 'rbn.telegraphy.de';
  const port = settings.cwSpotsPort || 7000;
  const clubs = settings.cwSpotsClubs || [];
  const myPos = gridToLatLon(settings.grid);
  const myEntity = ctyDb ? resolveCallsign(settings.myCallsign, ctyDb) : null;
  const isMainServer = host === 'rbn.telegraphy.de';

  // Per-club connections: one per checked club so we can tag spots with the club name.
  // rbn.telegraphy.de supports SSIDs (K3SBP-1, -2) for multiple filter sets.
  // If no clubs selected or non-main server, use single connection for all.
  const clubList = (isMainServer && clubs.length > 0) ? clubs : [null];

  clubList.forEach((club, i) => {
    const client = new DxClusterClient();
    const clubTag = club || 'CW';
    const ssid = club ? `-${i + 1}` : '';
    const postLogin = isMainServer
      ? [club ? `set/clubs ${club.toLowerCase()}` : 'set/clubs', 'set/nodupes']
      : [];

    client.on('spot', (raw) => {
      // Filter by max WPM if configured
      const maxWpm = settings.cwSpotsMaxWpm || 0;
      if (maxWpm > 0) {
        const wpmMatch = (raw.comment || '').match(/(\d+)\s*WPM/i);
        if (wpmMatch && parseInt(wpmMatch[1], 10) > maxWpm) return;
      }
      const spot = buildClusterSpot(raw, myPos, myEntity);
      spot.source = 'cwspots';
      spot.cwClub = clubTag; // tag with club name for badge display
      // Dedup by callsign+band
      const idx = cwSpots.findIndex(s => s.callsign === spot.callsign && s.band === spot.band);
      if (idx !== -1) cwSpots.splice(idx, 1);
      cwSpots.push(spot);
      if (cwSpots.length > 500) cwSpots = cwSpots.slice(-500);
      if (!cwSpotsFlushTimer) {
        cwSpotsFlushTimer = setTimeout(() => {
          cwSpotsFlushTimer = null;
          sendMergedSpots();
        }, 2000);
      }
    });
    client.on('status', (s) => {
      sendCatLog(`[CW Spots${club ? ' ' + club : ''}] ${s.connected ? 'Connected to' : 'Disconnected from'} ${host}:${port}`);
      if (win && !win.isDestroyed()) win.webContents.send('cw-spots-status', s);
    });
    client.connect({ host, port, callsign: settings.myCallsign + ssid, postLogin });
    cwSpotsClients.set(clubTag, client);
  });
}

function disconnectCwSpots() {
  if (cwSpotsFlushTimer) { clearTimeout(cwSpotsFlushTimer); cwSpotsFlushTimer = null; }
  for (const [, client] of cwSpotsClients) {
    client.disconnect();
    client.removeAllListeners();
  }
  cwSpotsClients.clear();
  cwSpots = [];
}

// Migrate legacy clusterHost/clusterPort to clusterNodes array
function migrateClusterNodes() {
  if (settings.clusterNodes) return;
  const host = settings.clusterHost || 'w3lpl.net';
  const port = settings.clusterPort || 7373;
  // Find matching preset
  const preset = CLUSTER_PRESETS.find(p => p.host === host && p.port === port);
  settings.clusterNodes = [{
    id: Date.now().toString(36),
    name: preset ? preset.name : host,
    host,
    port,
    enabled: true,
    preset: preset ? preset.name : null,
  }];
  saveSettings(settings);
}

// --- Call area coordinate lookup for large countries ---
// cty.dat gives one centroid per country — useless for plotting skimmers across the US/Canada/etc.
// This maps call area digits to approximate regional centroids.
const CALL_AREA_COORDS = {
  'United States': {
    '1': { lat: 42.5, lon: -72.0, region: 'New England' },
    '2': { lat: 41.0, lon: -74.0, region: 'NY/NJ' },
    '3': { lat: 40.0, lon: -76.5, region: 'PA/MD/DE' },
    '4': { lat: 34.0, lon: -84.0, region: 'Southeast' },
    '5': { lat: 32.0, lon: -97.0, region: 'South Central' },
    '6': { lat: 37.0, lon: -120.0, region: 'California' },
    '7': { lat: 43.0, lon: -114.0, region: 'Northwest' },
    '8': { lat: 40.5, lon: -82.5, region: 'MI/OH/WV' },
    '9': { lat: 41.5, lon: -88.0, region: 'IL/IN/WI' },
    '0': { lat: 41.0, lon: -97.0, region: 'Central' },
  },
  'Canada': {
    '1': { lat: 47.0, lon: -56.0, region: 'NL' },
    '2': { lat: 47.0, lon: -71.0, region: 'QC' },
    '3': { lat: 44.0, lon: -79.5, region: 'ON' },
    '4': { lat: 50.0, lon: -97.0, region: 'MB' },
    '5': { lat: 52.0, lon: -106.0, region: 'SK' },
    '6': { lat: 51.0, lon: -114.0, region: 'AB' },
    '7': { lat: 49.0, lon: -123.0, region: 'BC' },
    '9': { lat: 46.0, lon: -66.0, region: 'Maritimes' },
  },
  'Japan': {
    '1': { lat: 35.7, lon: 139.7, region: 'Kanto' },
    '2': { lat: 35.0, lon: 137.0, region: 'Tokai' },
    '3': { lat: 34.7, lon: 135.5, region: 'Kansai' },
    '4': { lat: 34.4, lon: 132.5, region: 'Chugoku' },
    '5': { lat: 33.8, lon: 133.5, region: 'Shikoku' },
    '6': { lat: 33.0, lon: 131.0, region: 'Kyushu' },
    '7': { lat: 39.0, lon: 140.0, region: 'Tohoku' },
    '8': { lat: 43.0, lon: 141.3, region: 'Hokkaido' },
    '9': { lat: 36.6, lon: 136.6, region: 'Hokuriku' },
    '0': { lat: 37.0, lon: 138.5, region: 'Shinetsu' },
  },
  'Australia': {
    '1': { lat: -35.3, lon: 149.1, region: 'ACT' },
    '2': { lat: -33.9, lon: 151.0, region: 'NSW' },
    '3': { lat: -37.8, lon: 145.0, region: 'VIC' },
    '4': { lat: -27.5, lon: 153.0, region: 'QLD' },
    '5': { lat: -34.9, lon: 138.6, region: 'SA' },
    '6': { lat: -31.9, lon: 115.9, region: 'WA' },
    '7': { lat: -42.9, lon: 147.3, region: 'TAS' },
    '8': { lat: -12.5, lon: 130.8, region: 'NT' },
  },
};

// Extract the call area digit from a callsign (first digit found)
function getCallAreaCoords(callsign, entityName) {
  const areaMap = CALL_AREA_COORDS[entityName];
  if (!areaMap) return null;
  const m = callsign.match(/(\d)/);
  if (!m) return null;
  return areaMap[m[1]] || null;
}

// --- Reverse Beacon Network ---
function sendRbnStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('rbn-status', s);
}

function sendRbnSpots() {
  if (win && !win.isDestroyed()) win.webContents.send('rbn-spots', rbnSpots);
  if (propPopoutWin && !propPopoutWin.isDestroyed()) propPopoutWin.webContents.send('rbn-spots', rbnSpots);
}

function connectRbn() {
  if (rbn) {
    rbn.disconnect();
    rbn.removeAllListeners();
    rbn = null;
  }
  rbnSpots = [];

  const wantRbn = settings.enableRbn === true || panadapterWantsSource('rbn');
  if (!wantRbn || !settings.myCallsign) {
    sendRbnStatus({ connected: false });
    return;
  }

  rbn = new RbnClient();
  const myPos = gridToLatLon(settings.grid);

  rbn.on('spot', (raw) => {
    // Strip skimmer suffix (e.g. KM3T-# -> KM3T)
    const spotter = raw.spotter.replace(/-[#\d]+$/, '');

    const spot = {
      spotter,
      callsign: raw.callsign,
      frequency: raw.frequency,
      freqMHz: raw.freqMHz,
      mode: raw.mode,
      band: raw.band,
      snr: raw.snr,
      wpm: raw.wpm,
      type: raw.type,
      spotTime: raw.spotTime,
      lat: null,
      lon: null,
      distance: null,
      locationDesc: '',
    };

    // Resolve spotter's location via call area lookup, then cty.dat fallback
    if (ctyDb) {
      const entity = resolveCallsign(spotter, ctyDb);
      if (entity) {
        // Try call area coordinates first (much more precise for large countries)
        const areaCoords = getCallAreaCoords(spotter, entity.name);
        if (areaCoords) {
          spot.lat = areaCoords.lat;
          spot.lon = areaCoords.lon;
          spot.locationDesc = `${entity.name} — ${areaCoords.region}`;
        } else if (entity.lat != null && entity.lon != null) {
          spot.lat = entity.lat;
          spot.lon = entity.lon;
          spot.locationDesc = entity.name;
        }
        if (spot.lat != null && myPos) {
          spot.distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, spot.lat, spot.lon));
        }
      }
    }

    // Watchlist notification for RBN spots (skip self — own callsign is expected)
    const myCall = (settings.myCallsign || '').toUpperCase();
    const rbnWatchRules = parseWatchlist(settings.watchlist);
    if (watchlistMatch(rbnWatchRules, raw.callsign, spot.band, raw.mode) && raw.callsign.toUpperCase() !== myCall) {
      notifyWatchlistSpot({
        callsign: raw.callsign,
        frequency: raw.frequency,
        mode: raw.mode,
        source: 'rbn',
        reference: '',
        locationDesc: `spotted by ${spotter}`,
      });
    }

    rbnSpots.push(spot);
    if (rbnSpots.length > 500) {
      rbnSpots = rbnSpots.slice(-500);
    }

    // Add watchlist callsigns (not self) to main table as merged spots
    if (watchlistMatch(rbnWatchRules, raw.callsign, spot.band, raw.mode) && raw.callsign.toUpperCase() !== myCall) {
      // Resolve activator's location (not spotter's) for main table/map
      let actLat = null, actLon = null, actDist = null, actBearing = null, actLoc = '', actContinent = '';
      if (ctyDb) {
        const actEntity = resolveCallsign(raw.callsign, ctyDb);
        if (actEntity) {
          actLoc = actEntity.name;
          actContinent = actEntity.continent || '';
          if (actEntity.lat != null && actEntity.lon != null) {
            actLat = actEntity.lat;
            actLon = actEntity.lon;
            if (myPos) {
              actDist = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, actEntity.lat, actEntity.lon));
              actBearing = Math.round(bearing(myPos.lat, myPos.lon, actEntity.lat, actEntity.lon));
            }
          }
        }
      }
      const mainSpot = {
        source: 'rbn',
        callsign: raw.callsign,
        frequency: raw.frequency,
        freqMHz: raw.freqMHz,
        mode: raw.mode,
        band: raw.band,
        reference: '',
        parkName: `spotted by ${spotter} (${raw.snr} dB)`,
        locationDesc: actLoc,
        continent: actContinent,
        distance: actDist,
        bearing: actBearing,
        lat: actLat,
        lon: actLon,
        spotTime: raw.spotTime,
      };
      // Deduplicate: keep only the most recent spot per callsign+band
      rbnWatchSpots = rbnWatchSpots.filter(s =>
        !(s.callsign.toUpperCase() === raw.callsign.toUpperCase() && s.band === raw.band)
      );
      rbnWatchSpots.push(mainSpot);
      if (rbnWatchSpots.length > 50) rbnWatchSpots = rbnWatchSpots.slice(-50);
      // Non-deduped history for the spot-history popover (different reverse
      // beacons + spot times for the same call).
      _rbnSpotHistory.push({ ...mainSpot, spotter: raw.skimmer || raw.spotter || '' });
      if (_rbnSpotHistory.length > _SPOT_HISTORY_CAP) {
        _rbnSpotHistory = _rbnSpotHistory.slice(-_SPOT_HISTORY_CAP);
      }
    }

    // Throttle: flush to renderer at most once every 2s
    if (!rbnFlushTimer) {
      rbnFlushTimer = setTimeout(() => {
        rbnFlushTimer = null;
        sendRbnSpots();
        sendMergedSpots();
      }, 2000);
    }
  });

  rbn.on('status', (s) => {
    sendRbnStatus(s);
  });

  rbn.connect({
    host: 'telnet.reversebeacon.net',
    port: 7000,
    callsign: settings.myCallsign,
    watchlist: settings.watchlist || '',
  });
}

function disconnectRbn() {
  if (rbnFlushTimer) {
    clearTimeout(rbnFlushTimer);
    rbnFlushTimer = null;
  }
  if (rbn) {
    rbn.disconnect();
    rbn.removeAllListeners();
    rbn = null;
  }
  rbnSpots = [];
  rbnWatchSpots = [];
  sendRbnStatus({ connected: false });
}

// --- PSKReporter FreeDV integration ---
function sendPskrStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('pskr-status', s);
}

function connectPskr() {
  if (pskr) {
    pskr.disconnect();
    pskr.removeAllListeners();
    pskr = null;
  }
  pskrSpots = [];

  const wantPskr = settings.enablePskr === true || settings.enableFreedv === true ||
    panadapterWantsSource('pskr');
  if (!wantPskr) {
    sendPskrStatus({ connected: false });
    return;
  }

  pskr = new PskrClient();
  const myPos = gridToLatLon(settings.grid);
  const myEntity = (ctyDb && settings.myCallsign) ? resolveCallsign(settings.myCallsign, ctyDb) : null;

  pskr.on('spot', (raw) => {
    const spot = {
      source: 'pskr',
      callsign: raw.callsign,
      frequency: raw.frequency,
      freqMHz: raw.freqMHz,
      mode: raw.mode,
      reference: '',
      parkName: `heard by ${raw.spotter}${raw.snr != null ? ` (${raw.snr} dB)` : ''}`,
      locationDesc: '',
      distance: null,
      lat: null,
      lon: null,
      band: raw.band,
      spotTime: raw.spotTime,
    };

    // Resolve DXCC entity for location + approximate coordinates
    if (ctyDb) {
      const entity = resolveCallsign(raw.callsign, ctyDb);
      if (entity) {
        spot.locationDesc = entity.name;
        spot.continent = entity.continent || '';
        if (entity.lat != null && entity.lon != null) {
          spot.lat = entity.lat;
          spot.lon = entity.lon;
          if (myPos && entity !== myEntity) {
            spot.distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, entity.lat, entity.lon));
            spot.bearing = Math.round(bearing(myPos.lat, myPos.lon, entity.lat, entity.lon));
          }
        }
      }
    }

    // Watchlist notification
    const pskrWatchRules = parseWatchlist(settings.watchlist);
    if (watchlistMatch(pskrWatchRules, raw.callsign, spot.band, raw.mode)) {
      notifyWatchlistSpot({
        callsign: raw.callsign,
        frequency: raw.frequency,
        mode: raw.mode,
        source: 'pskr',
        reference: '',
        locationDesc: spot.locationDesc,
      });
    }

    // Dedupe: keep latest per callsign+band
    const idx = pskrSpots.findIndex(s => s.callsign === spot.callsign && s.band === spot.band);
    if (idx !== -1) pskrSpots.splice(idx, 1);
    pskrSpots.push(spot);
    if (pskrSpots.length > 500) {
      pskrSpots = pskrSpots.slice(-500);
    }

    // Throttle: flush to renderer at most once every 2s
    if (!pskrFlushTimer) {
      pskrFlushTimer = setTimeout(() => {
        pskrFlushTimer = null;
        sendMergedSpots();
      }, 2000);
    }
  });

  pskr.on('status', (s) => {
    sendPskrStatus({ ...s, spotCount: pskrSpots.length, nextPollAt: pskr.nextPollAt });
    // Flush spots immediately on connect (don't wait for 2s throttle)
    if (s.connected && pskrSpots.length > 0) {
      if (pskrFlushTimer) { clearTimeout(pskrFlushTimer); pskrFlushTimer = null; }
      sendMergedSpots();
    }
  });

  pskr.on('pollDone', () => {
    // Lightweight update — sends nextPollAt + spotCount without triggering the toast
    sendPskrStatus({ connected: pskr.connected, nextPollAt: pskr.nextPollAt, spotCount: pskrSpots.length, pollUpdate: true });
  });

  pskr.on('log', (msg) => {
    sendCatLog(`[FreeDV] ${msg}`);
  });

  pskr.on('error', (msg) => {
    console.error(msg);
    sendCatLog(`[FreeDV] ${msg}`);
    sendPskrStatus({ connected: false, error: msg });
  });

  pskr.connect();
}

function disconnectPskr() {
  if (pskrFlushTimer) {
    clearTimeout(pskrFlushTimer);
    pskrFlushTimer = null;
  }
  if (pskr) {
    pskr.disconnect();
    pskr.removeAllListeners();
    pskr = null;
  }
  pskrSpots = [];
  sendPskrStatus({ connected: false });
}

// --- FreeDV Reporter (qso.freedv.org) ---

function connectFreedvReporter() {
  disconnectFreedvReporter();
  if (!settings.enableFreedv) return;

  freedvReporter = new FreedvReporterClient();
  const myPos = gridToLatLon(settings.grid);

  freedvReporter.on('connected', () => {
    sendCatLog('[FreeDV Reporter] Connected to qso.freedv.org');
  });
  freedvReporter.on('disconnected', () => {
    sendCatLog('[FreeDV Reporter] Disconnected');
  });
  freedvReporter.on('error', (err) => {
    sendCatLog(`[FreeDV Reporter] Error: ${err.message}`);
  });

  freedvReporter.on('spot', (raw) => {
    if (!raw.callsign || !raw.frequency) return;
    const freqHz = typeof raw.frequency === 'number' ? raw.frequency : parseInt(raw.frequency, 10);
    if (!freqHz || freqHz < 100000) return;
    const freqKhz = freqHz / 1000;
    const freqMHz = freqHz / 1000000;

    // Resolve mode string for display
    let mode = 'FREEDV';
    if (raw.mode && raw.mode !== 'FREEDV') mode = 'FREEDV-' + raw.mode;

    let distance = null;
    let spotBearing = null;
    if (myPos && raw.grid && raw.grid.length >= 4) {
      const pos = gridToLatLon(raw.grid);
      if (pos) {
        distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, pos.lat, pos.lon));
        spotBearing = Math.round(bearing(myPos.lat, myPos.lon, pos.lat, pos.lon));
      }
    }

    const spot = {
      source: 'freedv',
      callsign: raw.callsign,
      frequency: String(freqKhz),
      freqMHz,
      mode,
      reference: '',
      parkName: '',
      locationDesc: raw.grid || '',
      distance,
      bearing: spotBearing,
      lat: null,
      lon: null,
      band: freqToBand(freqMHz),
      spotTime: new Date().toISOString(),
      continent: '',
      snr: raw.snr,
      transmitting: raw.transmitting,
    };

    // Dedup by callsign (keep latest)
    freedvReporterSpots = freedvReporterSpots.filter(s => s.callsign !== spot.callsign);
    freedvReporterSpots.push(spot);
    // Cap at 200
    if (freedvReporterSpots.length > 200) freedvReporterSpots = freedvReporterSpots.slice(-200);

    // Throttle flush to renderer (every 2s)
    if (!freedvReporterFlushTimer) {
      freedvReporterFlushTimer = setTimeout(() => {
        freedvReporterFlushTimer = null;
        sendMergedSpots();
      }, 2000);
    }
  });

  sendCatLog('[FreeDV Reporter] Connecting to qso.freedv.org...');
  freedvReporter.connect();
}

function disconnectFreedvReporter() {
  if (freedvReporterFlushTimer) {
    clearTimeout(freedvReporterFlushTimer);
    freedvReporterFlushTimer = null;
  }
  if (freedvReporter) {
    freedvReporter.disconnect();
    freedvReporter.removeAllListeners();
    freedvReporter = null;
  }
  freedvReporterSpots = [];
}

// --- PSKReporter Map view ---
function sendPskrMapStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('pskr-map-status', s);
}

function sendPskrMapSpots() {
  if (win && !win.isDestroyed()) win.webContents.send('pskr-map-spots', pskrMapSpots);
  if (propPopoutWin && !propPopoutWin.isDestroyed()) propPopoutWin.webContents.send('pskr-map-spots', pskrMapSpots);
}

function connectPskrMap() {
  if (pskrMap) {
    pskrMap.disconnect();
    pskrMap.removeAllListeners();
    pskrMap = null;
  }
  pskrMapSpots = [];

  if (!settings.enablePskrMap || !settings.myCallsign) {
    sendPskrMapStatus({ connected: false });
    return;
  }

  pskrMap = new PskrClient();
  const myPos = gridToLatLon(settings.grid);
  const myCall = settings.myCallsign.toUpperCase();

  pskrMap.on('spot', (raw) => {
    // Only keep spots where WE are the sender
    if (raw.callsign.toUpperCase() !== myCall) return;

    // Resolve receiver location: prefer receiverGrid, fallback to cty.dat
    let lat = null, lon = null, locationDesc = '';
    if (raw.receiverGrid && raw.receiverGrid.length >= 4) {
      const pos = gridToLatLon(raw.receiverGrid);
      if (pos) { lat = pos.lat; lon = pos.lon; }
    }
    if (ctyDb) {
      const entity = resolveCallsign(raw.spotter, ctyDb);
      if (entity) {
        locationDesc = entity.name;
        if (lat == null && entity.lat != null && entity.lon != null) {
          lat = entity.lat;
          lon = entity.lon;
        }
      }
    }

    let distance = null, bear = null;
    if (myPos && lat != null && lon != null) {
      distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, lat, lon));
      bear = Math.round(bearing(myPos.lat, myPos.lon, lat, lon));
    }

    const spot = {
      receiver: raw.spotter,
      callsign: raw.callsign,
      frequency: raw.frequency,
      freqMHz: raw.freqMHz,
      mode: raw.mode,
      band: raw.band,
      snr: raw.snr,
      spotTime: raw.spotTime,
      lat, lon,
      locationDesc,
      distance,
      bearing: bear,
      receiverGrid: raw.receiverGrid || '',
    };

    // Dedupe: keep latest per receiver+band
    const idx = pskrMapSpots.findIndex(s => s.receiver === spot.receiver && s.band === spot.band);
    if (idx !== -1) pskrMapSpots.splice(idx, 1);
    pskrMapSpots.push(spot);
    if (pskrMapSpots.length > 500) {
      pskrMapSpots = pskrMapSpots.slice(-500);
    }

    // Throttle: flush to renderer at most once every 2s
    if (!pskrMapFlushTimer) {
      pskrMapFlushTimer = setTimeout(() => {
        pskrMapFlushTimer = null;
        sendPskrMapSpots();
      }, 2000);
    }
  });

  pskrMap.on('status', (s) => {
    sendPskrMapStatus({ ...s, spotCount: pskrMapSpots.length, nextPollAt: pskrMap.nextPollAt });
    if (s.connected && pskrMapSpots.length > 0) {
      if (pskrMapFlushTimer) { clearTimeout(pskrMapFlushTimer); pskrMapFlushTimer = null; }
      sendPskrMapSpots();
    }
  });

  pskrMap.on('pollDone', () => {
    sendPskrMapStatus({ connected: pskrMap.connected, nextPollAt: pskrMap.nextPollAt, spotCount: pskrMapSpots.length, pollUpdate: true });
  });

  pskrMap.on('log', (msg) => {
    sendCatLog(`[PSKRMap] ${msg}`);
  });

  pskrMap.on('error', (msg) => {
    console.error(msg);
    sendCatLog(`[PSKRMap] ${msg}`);
    sendPskrMapStatus({ connected: false, error: msg });
  });

  pskrMap.connect({ senderCallsign: myCall });
}

function disconnectPskrMap() {
  if (pskrMapFlushTimer) {
    clearTimeout(pskrMapFlushTimer);
    pskrMapFlushTimer = null;
  }
  if (pskrMap) {
    pskrMap.disconnect();
    pskrMap.removeAllListeners();
    pskrMap = null;
  }
  pskrMapSpots = [];
  sendPskrMapStatus({ connected: false });
}

// --- Shared QSO save logic ---
// Module-scoped so WSJT-X, Echo CAT, and IPC handlers can all use it
// Recent-save dedup window. Catches runaway callers (stacked listeners, stuck
// retry loops, renderer races) that try to save the same QSO dozens of times
// in a few hundred ms. Reported by bjh 2026-04-23: one Log click produced
// 200-300 duplicate ADIF entries + a cascade of "100/150/200 QSOs" milestone
// popups. A legitimate two-fer/three-fer save uses distinct sigInfo refs so
// it's not caught by this dedup.
const _qsoSaveHistory = new Map(); // key -> lastSavedTs
const _QSO_DEDUP_WINDOW_MS = 2000;
let _qsoSaveDupWarningLogged = false;
function _qsoDedupKey(q) {
  return [
    (q.callsign || '').toUpperCase(),
    q.qsoDate || '',
    q.timeOn || '',
    (q.sigInfo || '').toUpperCase(),
    (q.band || '').toUpperCase(),
    (q.mode || '').toUpperCase(),
  ].join('|');
}

// Mirrors renderer/app.js:cleanQrzName so phone-logged (ECHOCAT) QSOs format
// the operator name the same way as desktop-logged ones (drops trailing
// middle-initial, title-cases). Kept here so we can enrich qsoData on the
// main side before forwarding to N3FJP / ADIF.
// Mirrors lib/qrz.js's cleanQrzName. Source-of-truth lives there; this
// copy is kept for callers that get a name from a non-QRZ path (e.g. an
// ADIF import or a manual entry). Only re-cases fully-uppercase / fully-
// lowercase input so "McDonald" / "O'Brien" survive.
function cleanQrzName(raw) {
  if (!raw) return '';
  const parts = String(raw).trim().split(/\s+/);
  if (parts.length > 1 && /^[A-Za-z]\.?$/.test(parts[parts.length - 1])) parts.pop();
  const joined = parts.join(' ');
  const hasLower = /[a-z]/.test(joined);
  const hasUpper = /[A-Z]/.test(joined);
  if (hasLower && hasUpper) return joined;
  return joined.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

async function saveQsoRecord(qsoData) {
  // Duplicate-save guard — see _qsoSaveHistory comment above.
  const dedupKey = _qsoDedupKey(qsoData);
  const now = Date.now();
  const lastTs = _qsoSaveHistory.get(dedupKey);
  if (lastTs && now - lastTs < _QSO_DEDUP_WINDOW_MS) {
    if (!_qsoSaveDupWarningLogged) {
      _qsoSaveDupWarningLogged = true;
      sendCatLog(`[QSO] SUPPRESSED duplicate save within ${_QSO_DEDUP_WINDOW_MS}ms: ${dedupKey}. ` +
        `Something upstream (spot-log form, WSJT-X bridge, ECHOCAT log-qso, etc.) is firing saveQsoRecord repeatedly. ` +
        `Subsequent suppressions are silent to avoid log spam.`);
      // Reset the warning flag after 30 s so we'll still log a fresh warning
      // if the same thing happens again in a separate operating session.
      setTimeout(() => { _qsoSaveDupWarningLogged = false; }, 30_000);
    }
    return { success: false, suppressed: true, error: 'Duplicate save suppressed' };
  }
  _qsoSaveHistory.set(dedupKey, now);
  // Prune history older than the window to keep the Map small.
  if (_qsoSaveHistory.size > 100) {
    for (const [k, ts] of _qsoSaveHistory) {
      if (now - ts > _QSO_DEDUP_WINDOW_MS * 2) _qsoSaveHistory.delete(k);
    }
  }

  // Inject operator callsign from settings
  if (settings.myCallsign && !qsoData.operator) {
    qsoData.operator = settings.myCallsign.toUpperCase();
  }

  // Auto-fill TX power from the live CAT reading (matches the TX Power slider)
  // when the caller didn't supply one — typical for the Logbook pop-out's
  // "+ New QSO" form which has no power field.
  if (!qsoData.txPower) {
    if (_currentTxPower > 0) qsoData.txPower = String(_currentTxPower);
    else if (settings.defaultPower) qsoData.txPower = String(settings.defaultPower);
  }

  // Enrich COMMENT with park name + location for POTA/WWFF/LLOTA QSOs
  const parkRef = qsoData.potaRef || qsoData.wwffRef || (qsoData.sig && qsoData.sigInfo ? qsoData.sigInfo : '');
  if (parkRef) {
    const park = getParkDb(parksMap, parkRef);
    if (park && park.name) {
      const parts = [
        qsoData.sig || 'POTA',
        parkRef,
        park.locationDesc || '',
        park.name || '',
      ].filter(Boolean);
      const parkTag = `[${parts.join(' ')}]`;
      // Strip the auto-appended [SIG REF] tag from the base comment to avoid duplication
      const userComment = (qsoData.comment || '').replace(/\s*\[.+?\]\s*$/, '').trim();
      qsoData.comment = userComment ? `${userComment} ${parkTag}` : parkTag;
    }
  }

  // Enrich COMMENT with CW club membership if the station was spotted via CW Spots
  if (cwSpots.length > 0 && qsoData.callsign) {
    const call = qsoData.callsign.toUpperCase();
    const clubs = [...new Set(cwSpots.filter(s => s.callsign === call && s.cwClub && s.cwClub !== 'CW').map(s => s.cwClub))];
    if (clubs.length > 0) {
      const clubTag = `[${clubs.join(' ')}]`;
      const base = (qsoData.comment || '').trim();
      qsoData.comment = base ? `${base} ${clubTag}` : clubTag;
    }
  }

  const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
  if (!qsoData.uuid) qsoData.uuid = require('crypto').randomUUID();
  appendQso(logPath, qsoData);

  // Record in cloud sync journal
  if (cloudIpc) cloudIpc.journalCreate(qsoData);

  // Notify QSO pop-out window
  if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) {
    qsoPopoutWin.webContents.send('qso-popout-added', qsoData);
  }

  // Track QSO in telemetry (fire-and-forget)
  const qsoSource = (qsoData.sig || '').toLowerCase();
  trackQso(['pota', 'sota', 'wwff', 'llota'].includes(qsoSource) ? qsoSource : null);

  // Check if QSO matches any active event and auto-mark progress
  checkEventQso(qsoData);

  // Update worked QSOs map and notify renderer
  if (qsoData.callsign) {
    const call = qsoData.callsign.toUpperCase();
    const entry = { date: qsoData.qsoDate || '', ref: (qsoData.sigInfo || '').toUpperCase(), band: (qsoData.band || '').toUpperCase(), mode: (qsoData.mode || '').toUpperCase() };
    if (!workedQsos.has(call)) workedQsos.set(call, []);
    workedQsos.get(call).push(entry);
    // Mirror into the richer ragchew-logger index so a freshly-saved QSO
    // appears in "Past QSOs with <call>" without a full log re-parse.
    appendToQsoDetailsIndex(qsoData);
    if (win && !win.isDestroyed()) {
      win.webContents.send('worked-qsos', [...workedQsos.entries()]);
    }
    if (remoteServer && remoteServer.running) {
      remoteServer.sendWorkedQsos([...workedQsos.entries()]);
    }
    // Update roster needed sets live
    rosterWorkedCalls.add(call);
    const grid = (qsoData.grid || '').toUpperCase().substring(0, 4);
    if (grid && /^[A-R]{2}\d{2}$/.test(grid)) rosterWorkedGrids.add(grid);
    const band = (qsoData.band || '').toLowerCase();
    if (band && ctyDb) {
      const entity = resolveCallsign(call, ctyDb);
      if (entity) rosterWorkedDxcc.add(entity.name + '|' + band);
    }
  }

  // Update worked parks set when a POTA/WWFF park is logged (live "new-to-me" update)
  const loggedParkRef = qsoData.potaRef
    || qsoData.wwffRef
    || ((qsoData.sig === 'POTA' || qsoData.sig === 'WWFF') && qsoData.sigInfo ? qsoData.sigInfo.toUpperCase() : '');
  if (loggedParkRef && !workedParks.has(loggedParkRef)) {
    workedParks.set(loggedParkRef, { reference: loggedParkRef });
    saveLocalWorkedPark(loggedParkRef); // persist to disk
    if (win && !win.isDestroyed()) {
      win.webContents.send('worked-parks', [...workedParks.entries()]);
    }
    if (remoteServer && remoteServer.running) {
      remoteServer.sendWorkedParks([...workedParks.keys()]);
    }
  }
  // Debounced POTA.app pull — no-ops unless the user has enabled auto-sync.
  if (loggedParkRef && potaSync) { try { potaSync.noteQsoLogged(); } catch {} }

  // Forward to external logbook if enabled
  // skipLogbookForward: multi-park activations send one ADIF record per park ref,
  // but external logbooks only need one QSO per physical contact
  let logbookError, qrzError;

  if (settings.sendToLogbook && settings.logbookType && !qsoData.skipLogbookForward) {
    try {
      sendCatLog(`[Logbook] Forwarding QSO to ${settings.logbookType}: ${qsoData.callsign} ${qsoData.frequency}kHz ${qsoData.mode}`);
      await forwardToLogbook(qsoData);
      sendCatLog(`[Logbook] QSO forwarded successfully`);
    } catch (fwdErr) {
      sendCatLog(`[Logbook] Forwarding failed: ${fwdErr.message}`);
      console.error('Logbook forwarding failed:', fwdErr.message);
      logbookError = fwdErr.message;
    }
  }

  // Optional: also fire the QSO at a user-defined extra UDP destination
  // (parallel to the main logbook). For users who want GridTracker / JTAlert
  // / etc. to see logged QSOs without going through Log4OM as a middleman.
  if (settings.extraUdpEnabled && !qsoData.skipLogbookForward) {
    const host = settings.extraUdpHost || '127.0.0.1';
    const port = parseInt(settings.extraUdpPort, 10) || 2237;
    const format = settings.extraUdpFormat || 'wsjtx';
    try {
      sendCatLog(`[Extra UDP] Broadcasting QSO to ${host}:${port} (${format})`);
      if (format === 'wsjtx') {
        // Reuse the persistent bridge so heartbeats have already registered
        // "POTACAT" as a source with GridTracker before the first QSO.
        if (!extraUdpBridge.socket || extraUdpBridge.host !== host || extraUdpBridge.port !== port) {
          extraUdpBridge.start(host, port);
        }
        const record = buildAdifRecord(qsoData);
        const adifText = `<adif_ver:5>3.1.4\n<programid:7>POTACAT\n<EOH>\n${record}\n`;
        await extraUdpBridge.sendQso(qsoData, adifText);
      } else {
        await sendUdpAdif(qsoData, host, port);
      }
      sendCatLog(`[Extra UDP] Sent`);
    } catch (extraErr) {
      sendCatLog(`[Extra UDP] Send failed: ${extraErr.message}`);
      console.error('Extra UDP send failed:', extraErr.message);
    }
  }

  // Upload to QRZ Logbook if enabled (independent of logbook forwarding)
  if (settings.qrzLogbook && settings.qrzApiKey && !qsoData.skipLogbookForward) {
    try {
      await sendToQrzLogbook(qsoData);
    } catch (qrzErr) {
      console.error('QRZ Logbook upload failed:', qrzErr.message);
      qrzError = qrzErr.message;
    }
  }

  // Expand respot comment macros ({op_firstname}, {rst}, {mycallsign}, {QTH})
  if (qsoData.respotComment) {
    let opName = '';
    if (qrz.configured && settings.enableQrz && qsoData.callsign) {
      try {
        const qrzData = await qrz.lookup(qsoData.callsign.split('/')[0]);
        if (qrzData) opName = qrzData.nickname || qrzData.fname || '';
      } catch { /* QRZ lookup failed — leave blank */ }
    }
    qsoData.respotComment = qsoData.respotComment
      .replace(/\{op_firstname\}/gi, opName)
      .replace(/\{rst\}/gi, qsoData.rstSent || '59')
      .replace(/\{mycallsign\}/gi, settings.myCallsign || '')
      .replace(/\{QTH\}/gi, settings.grid || '')
      .replace(/\{call\}/gi, qsoData.callsign || '');
  }

  // Re-spot on POTA if requested
  if (qsoData.respot && qsoData.sig === 'POTA' && qsoData.sigInfo && settings.myCallsign) {
    try {
      await postPotaRespot({
        activator: qsoData.callsign,
        spotter: settings.myCallsign.toUpperCase(),
        frequency: qsoData.frequency,
        reference: qsoData.sigInfo,
        mode: qsoData.mode,
        comments: qsoData.respotComment || '',
      });
      trackRespot('pota');
    } catch (respotErr) {
      console.error('POTA re-spot failed:', respotErr.message);
      return { success: true, respotError: respotErr.message };
    }
  }

  // Re-spot on WWFF if requested — validate ref starts with KFF/xFF (WWFF format)
  if (qsoData.wwffRespot && qsoData.wwffReference && settings.myCallsign) {
    if (!/^[A-Z0-9]{1,4}FF-\d{4}$/i.test(qsoData.wwffReference)) {
      console.warn('WWFF re-spot skipped: reference does not match WWFF format:', qsoData.wwffReference);
    } else {
      try {
        await postWwffRespot({
          activator: qsoData.callsign,
          spotter: settings.myCallsign.toUpperCase(),
          frequency: qsoData.frequency,
          reference: qsoData.wwffReference,
          mode: qsoData.mode,
          comments: qsoData.respotComment || '',
        });
        trackRespot('wwff');
      } catch (respotErr) {
        console.error('WWFF re-spot failed:', respotErr.message);
        return { success: true, wwffRespotError: respotErr.message };
      }
    }
  }

  // Re-spot on LLOTA if requested — validate ref matches LLOTA format (XX-NNNN where sig=LLOTA)
  if (qsoData.llotaRespot && qsoData.llotaReference) {
    if (qsoData.sig !== 'LLOTA') {
      console.warn('LLOTA re-spot skipped: QSO sig is', qsoData.sig, 'not LLOTA, ref:', qsoData.llotaReference);
    } else {
      try {
        await postLlotaRespot({
          activator: qsoData.callsign,
          frequency: qsoData.frequency,
          reference: qsoData.llotaReference,
          mode: qsoData.mode,
          comments: qsoData.respotComment || '',
        });
        trackRespot('llota');
      } catch (respotErr) {
        console.error('LLOTA re-spot failed:', respotErr.message);
        return { success: true, llotaRespotError: respotErr.message };
      }
    }
  }

  // Spot on DX Cluster if requested
  if (qsoData.dxcRespot) {
    try {
      let sent = 0;
      for (const [, entry] of clusterClients) {
        if (entry.client.sendSpot({ frequency: qsoData.frequency, callsign: qsoData.callsign, comment: qsoData.respotComment || '' })) {
          sent++;
        }
      }
      if (sent === 0) throw new Error('no connected nodes');
    } catch (respotErr) {
      console.error('DX Cluster spot failed:', respotErr.message);
      return { success: true, dxcRespotError: respotErr.message };
    }
  }

  // Auto-upload chaser QSO to SOTAdata if enabled
  if (settings.sotaUpload && qsoData.sig === 'SOTA' && qsoData.sigInfo && sotaUploader.configured) {
    try {
      sendCatLog(`[SOTA] Uploading chase: ${qsoData.callsign} @ ${qsoData.sigInfo} RST S${qsoData.rstSent || '?'} R${qsoData.rstRcvd || '?'}`);
      const sotaResult = await sotaUploader.uploadChase(qsoData);
      if (sotaResult.success) {
        sendCatLog(`[SOTA] Chase uploaded successfully`);
      } else {
        sendCatLog(`[SOTA] Upload failed: ${sotaResult.error}`);
        console.error('SOTA upload failed:', sotaResult.error);
      }
    } catch (sotaErr) {
      sendCatLog(`[SOTA] Upload error: ${sotaErr.message}`);
      console.error('SOTA upload error:', sotaErr.message);
    }
  }

  const didRespot = (qsoData.respot && qsoData.sig === 'POTA') || qsoData.wwffRespot || qsoData.llotaRespot || qsoData.dxcRespot;
  return { success: true, resposted: didRespot || false, logbookError, qrzError };
}

// --- WSJT-X integration ---
function sendWsjtxStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('wsjtx-status', s);
}

function connectWsjtx() {
  disconnectWsjtx();
  if (!settings.enableWsjtx) return;

  // Release the radio so WSJT-X can control it (even on FlexRadio — dual CAT conflicts)
  if (cat) cat.disconnect();
  killRigctld();
  sendCatStatus({ connected: false, wsjtxMode: true });

  wsjtx = new WsjtxClient();

  wsjtx.on('status', (s) => {
    sendWsjtxStatus(s);
  });

  wsjtx.on('error', (err) => {
    console.error('WSJT-X UDP error:', err.message);
  });

  wsjtx.on('wsjtx-status', (status) => {
    wsjtxStatus = status;
    // Feed WSJT-X dial frequency into the same frequency tracker CAT uses
    if (status.dialFrequency) {
      sendCatFrequency(status.dialFrequency);
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('wsjtx-state', {
        dialFrequency: status.dialFrequency,
        mode: status.mode,
        dxCall: status.dxCall,
        txEnabled: status.txEnabled,
        transmitting: status.transmitting,
        decoding: status.decoding,
        deCall: status.deCall,
        subMode: status.subMode,
      });
    }
  });

  wsjtx.on('decode', (decode) => {
    if (!decode.isNew) return;
    // Forward to renderer for display
    if (win && !win.isDestroyed()) {
      win.webContents.send('wsjtx-decode', {
        time: decode.time,
        snr: decode.snr,
        deltaTime: decode.deltaTime,
        deltaFrequency: decode.deltaFrequency,
        mode: decode.mode,
        message: decode.message,
        dxCall: decode.dxCall,
        deCall: decode.deCall,
        lowConfidence: decode.lowConfidence,
      });
    }
  });

  wsjtx.on('clear', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('wsjtx-clear');
    }
  });

  wsjtx.on('logged-adif', async ({ adif }) => {
    if (!settings.wsjtxAutoLog) return;
    try {
      const f = parseAdifRecord(adif);
      const freqMHz = parseFloat(f.FREQ || '0');
      // WSJT-X sends MODE=MFSK + SUBMODE=FT4; prefer SUBMODE when available
      const wsjtxMode = f.SUBMODE || f.MODE || '';
      const qsoData = {
        callsign: f.CALL || '',
        frequency: String(Math.round(freqMHz * 1000)),
        mode: wsjtxMode,
        qsoDate: f.QSO_DATE || '',
        timeOn: f.TIME_ON || '',
        rstSent: f.RST_SENT || '',
        rstRcvd: f.RST_RCVD || '',
        txPower: f.TX_PWR || '',
        band: f.BAND || '',
        sig: f.SIG || '',
        sigInfo: f.SIG_INFO || '',
        name: f.NAME || '',
        gridsquare: f.GRIDSQUARE || '',
        comment: f.COMMENT || '',
        operator: f.OPERATOR || settings.myCallsign || '',
      };

      // In activator mode, inject MY_SIG fields for each park ref (cross-product)
      const parkRefs = (settings.activatorParkRefs || []).filter(p => p && p.ref);
      if (settings.appMode === 'activator' && parkRefs.length > 0) {
        const allQsoData = [];
        for (let i = 0; i < parkRefs.length; i++) {
          const parkQso = { ...qsoData, mySig: 'POTA', mySigInfo: parkRefs[i].ref, myGridsquare: settings.grid || '' };
          allQsoData.push(parkQso);
          await saveQsoRecord(parkQso);
        }
        // Cross-program references (WWFF, LLOTA for same park)
        const crossRefs = (settings.activatorCrossRefs || []).filter(xr => xr && xr.ref);
        for (const xr of crossRefs) {
          const xrQso = { ...qsoData, mySig: xr.program.toUpperCase(), mySigInfo: xr.ref, myGridsquare: settings.grid || '' };
          if (xr.program === 'WWFF') xrQso.myWwffRef = xr.ref;
          allQsoData.push(xrQso);
          await saveQsoRecord(xrQso);
        }
        // Notify renderer so activator view gets the contact
        if (win && !win.isDestroyed()) {
          const freqKhz = Math.round(freqMHz * 1000);
          const timeOn = qsoData.timeOn || '';
          const timeUtc = timeOn.length >= 4 ? `${timeOn.slice(0, 2)}:${timeOn.slice(2, 4)}` : '';
          win.webContents.send('wsjtx-activator-qso', {
            callsign: qsoData.callsign,
            timeUtc,
            freqDisplay: freqMHz.toFixed(3),
            mode: qsoData.mode,
            band: qsoData.band || '',
            rstSent: qsoData.rstSent,
            rstRcvd: qsoData.rstRcvd,
            name: qsoData.name || '',
            myParks: parkRefs.map(p => p.ref),
            theirParks: [],
            qsoData: allQsoData[0],
            qsoDataList: allQsoData,
          });
        }
      } else {
        await saveQsoRecord(qsoData);
      }
    } catch (err) {
      console.error('Failed to log WSJT-X QSO:', err.message);
    }
  });

  wsjtx.on('qso-logged', (qso) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('wsjtx-qso-logged', {
        dxCall: qso.dxCall,
        dxGrid: qso.dxGrid,
        mode: qso.mode,
        reportSent: qso.reportSent,
        reportReceived: qso.reportReceived,
        txFrequency: qso.txFrequency,
      });
    }
    // Match callsign to a spotted POTA/SOTA activator and mark park as worked
    const call = (qso.dxCall || '').toUpperCase();
    if (call) {
      const spot = lastPotaSotaSpots.find(s => s.callsign.toUpperCase() === call);
      const freqHz = qso.txFrequency || 0;
      const freqKhz = freqHz > 100000 ? freqHz / 1000 : freqHz; // WSJT-X sends Hz
      const band = freqKhz ? (freqToBand(freqKhz / 1000) || '') : '';
      const mode = (qso.mode || '').toUpperCase();
      const now = new Date();
      const qsoDate = now.getUTCFullYear().toString() +
        String(now.getUTCMonth() + 1).padStart(2, '0') +
        String(now.getUTCDate()).padStart(2, '0');
      // Update workedQsos (callsign tracking)
      const entry = { date: qsoDate, ref: spot ? (spot.reference || '').toUpperCase() : '', band, mode };
      if (!workedQsos.has(call)) workedQsos.set(call, []);
      workedQsos.get(call).push(entry);
      if (win && !win.isDestroyed()) win.webContents.send('worked-qsos', [...workedQsos.entries()]);
      if (remoteServer && remoteServer.running) remoteServer.sendWorkedQsos([...workedQsos.entries()]);
      // Update roster needed sets
      rosterWorkedCalls.add(call);
      const grid = (qso.dxGrid || '').toUpperCase().substring(0, 4);
      if (grid && /^[A-R]{2}\d{2}$/.test(grid)) rosterWorkedGrids.add(grid);
      if (band && ctyDb) {
        const entity = resolveCallsign(call, ctyDb);
        if (entity) rosterWorkedDxcc.add(entity.name + '|' + band);
      }
      // Update workedParks if activator was at a park
      if (spot && spot.reference) {
        const parkRef = spot.reference.toUpperCase();
        if (!workedParks.has(parkRef)) {
          workedParks.set(parkRef, { reference: parkRef });
          saveLocalWorkedPark(parkRef);
          if (win && !win.isDestroyed()) win.webContents.send('worked-parks', [...workedParks.entries()]);
          if (remoteServer && remoteServer.running) remoteServer.sendWorkedParks([...workedParks.keys()]);
          sendCatLog(`[WSJT-X] QSO logged: ${call} -> park ${parkRef} marked as worked`);
        } else {
          sendCatLog(`[WSJT-X] QSO logged: ${call} at ${parkRef} (already worked)`);
        }
      } else {
        sendCatLog(`[WSJT-X] QSO logged: ${call} (no park match in spots)`);
      }
    }
  });

  const port = parseInt(settings.wsjtxPort, 10) || 2237;
  wsjtx.connect(port);

  // Schedule highlight updates whenever spots change
  scheduleWsjtxHighlights();
}

function disconnectWsjtx() {
  const wasRunning = wsjtx != null;
  if (wsjtxHighlightTimer) {
    clearTimeout(wsjtxHighlightTimer);
    wsjtxHighlightTimer = null;
  }
  if (wsjtx) {
    wsjtx.clearHighlights();
    wsjtx.disconnect();
    wsjtx = null;
  }
  wsjtxStatus = null;
  sendWsjtxStatus({ connected: false });

  // Reconnect CAT now that WSJT-X is no longer managing the radio
  if (wasRunning) {
    connectCat();
  }
}

/**
 * Highlight POTA/SOTA activator callsigns in WSJT-X's Band Activity window.
 * Called after spots refresh and throttled to avoid spamming.
 */
function scheduleWsjtxHighlights() {
  if (wsjtxHighlightTimer) return;
  wsjtxHighlightTimer = setTimeout(() => {
    wsjtxHighlightTimer = null;
    updateWsjtxHighlights();
  }, 3000);
}

function updateWsjtxHighlights() {
  if (!wsjtx || !wsjtx.connected || !settings.wsjtxHighlight) return;

  // Build set of active POTA/SOTA callsigns
  const activators = new Set();
  for (const spot of lastPotaSotaSpots) {
    if (spot.callsign) activators.add(spot.callsign.toUpperCase());
  }

  // Clear old highlights that are no longer active
  for (const call of wsjtx._highlightedCalls) {
    if (!activators.has(call)) {
      wsjtx.highlightCallsign(call, null, null);
    }
  }

  // Set highlights for active POTA callsigns
  const bgColor = settings?.colorblindMode
    ? { r: 79, g: 195, b: 247 }  // #4fc3f7 sky blue (CB-safe)
    : { r: 78, g: 204, b: 163 }; // #4ecca3 POTA green
  const fgColor = { r: 0, g: 0, b: 0 };
  for (const call of activators) {
    wsjtx.highlightCallsign(call, bgColor, fgColor);
  }
}

// --- JTCAT (FT8/FT4 native decode engine) ---
const { JtcatManager } = require('./lib/jtcat-manager');
let jtcatManager = null; // initialized on first startJtcat()
let ft8Engine = null;    // alias for jtcatManager.engine (Phase 0 compatibility)
let remoteJtcatQso = null;
let jtcatQuietFreq = 1500; // auto-detected quiet TX frequency from FFT analysis
const JTCAT_MAX_CQ_RETRIES = 15;
const JTCAT_MAX_QSO_RETRIES = 12; // ~3 minutes of retries at 15s/cycle

// Auto-CQ response state
let jtcatAutoCqMode = 'off';          // 'off' | 'pota' | 'sota' | 'all'
let jtcatAutoCqWorkedSession = new Set(); // callsigns attempted/worked this session
let jtcatAutoCqOwner = null;           // 'popout' | 'remote' | null

function matchesAutoCqFilter(text, filterMode) {
  const upper = (text || '').toUpperCase();
  if (!upper.startsWith('CQ ')) return false;
  if (filterMode === 'all') return true;
  if (filterMode === 'pota') return upper.startsWith('CQ POTA ');
  if (filterMode === 'sota') return upper.startsWith('CQ SOTA ');
  return false;
}

function parseCqMessage(text) {
  const parts = (text || '').toUpperCase().split(/\s+/).filter(Boolean);
  // CQ [MODIFIER]* CALLSIGN [GRID]. Modifiers (POTA, SOTA, DX, NA, EU, ...)
  // are letter-only — they never match callsign shape. Match the first
  // callsign-shaped token after CQ instead of the previous "if length>3
  // and parts[1] looks like a modifier" heuristic, which broke for shorter
  // messages like "CQ POTA W1AW" (no grid). The old code treated POTA as
  // the callsign and replied with "POTA MYCALL MYGRID". (IU7RAL report.)
  const isCallsign = (s) => /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$/.test((s || '').split('/')[0]);
  let callIdx = -1;
  for (let i = 1; i < parts.length; i++) {
    if (isCallsign(parts[i])) { callIdx = i; break; }
  }
  if (callIdx === -1) callIdx = 1; // nothing callsign-shaped — keep prior fallback
  return { call: parts[callIdx] || '', grid: parts[callIdx + 1] || '' };
}

function broadcastAutoCqState() {
  const state = { mode: jtcatAutoCqMode, workedCount: jtcatAutoCqWorkedSession.size };
  if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
    jtcatPopoutWin.webContents.send('jtcat-auto-cq-state', state);
  }
  if (remoteServer && remoteServer.hasClient()) {
    remoteServer.broadcastJtcatAutoCqState(state);
  }
}

function remoteJtcatMyCall() { return (settings.myCallsign || '').toUpperCase(); }
function remoteJtcatMyGrid() { return (settings.grid || '').toUpperCase().substring(0, 4); }

function remoteJtcatBroadcastQso() {
  if (remoteServer) remoteServer.broadcastJtcatQsoState(remoteJtcatQso || { phase: 'idle' });
}

async function remoteJtcatSetTxMsg(msg) {
  const txEng = jtcatManager ? jtcatManager.txEngine : ft8Engine;
  if (txEng) await txEng.setTxMessage(msg);
  remoteJtcatBroadcastQso();
}

function popoutBroadcastQso() {
  if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
    jtcatPopoutWin.webContents.send('jtcat-qso-state', popoutJtcatQso || { phase: 'idle' });
  }
}

async function jtcatAutoLog(qso) {
  const q = qso || remoteJtcatQso;
  if (!q || !q.call) {
    sendCatLog(`[JTCAT] Auto-log skipped — no QSO data`);
    return;
  }
  // Prevent logging incomplete QSOs (no signal reports exchanged)
  if (!q.report && !q.sentReport) {
    sendCatLog(`[JTCAT] Auto-log skipped — no signal reports exchanged for ${q.call}`);
    return;
  }
  // Prevent double-logging the same QSO
  if (q._logged) {
    sendCatLog(`[JTCAT] Auto-log skipped — already logged ${q.call}`);
    return;
  }
  q._logged = true;
  // When WSJT-X mode is enabled, WSJT-X handles logging via logged-adif (type 12).
  // Don't double-log from JTCAT's QSO state machine.
  if (settings.enableWsjtx && wsjtx && wsjtx.connected) {
    sendCatLog(`[JTCAT] Auto-log skipped — WSJT-X mode handles logging`);
    return;
  }
  sendCatLog(`[JTCAT] Auto-logging QSO: ${q.call} report=${q.report || 'none'} sent=${q.sentReport || 'none'}`);
  const now = new Date();
  const qsoDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const qsoTime = now.toISOString().slice(11, 16).replace(/:/g, '');
  const freqKhz = _currentFreqHz ? _currentFreqHz / 1000 : 0;
  const freqMhz = freqKhz / 1000;
  const band = freqToBand(freqMhz) || '';
  const mode = ft8Engine ? ft8Engine._mode : 'FT8';
  const qsoData = {
    callsign: q.call.toUpperCase(),
    frequency: String(freqKhz),
    mode,
    band,
    qsoDate,
    timeOn: qsoTime,
    rstSent: q.sentReport || '',
    rstRcvd: q.report || '',
    gridsquare: q.grid || '',
    comment: 'JTCAT ' + mode,
  };

  try {
    // Activation mode: add park refs so JTCAT QSOs log to the activation logbook
    const parkRefs = (settings.activatorParkRefs || []).filter(p => p && p.ref);
    if (settings.appMode === 'activator' && parkRefs.length > 0) {
      sendCatLog(`[JTCAT] Activation mode — logging to ${parkRefs.map(p => p.ref).join(', ')}`);
      for (let i = 0; i < parkRefs.length; i++) {
        const parkQso = { ...qsoData, mySig: 'POTA', mySigInfo: parkRefs[i].ref, myGridsquare: settings.grid || '' };
        await saveQsoRecord(parkQso);
      }
      // Cross-program refs (WWFF, LLOTA)
      const crossRefs = (settings.activatorCrossRefs || []).filter(xr => xr && xr.ref);
      for (const xr of crossRefs) {
        const xrQso = { ...qsoData, mySig: (xr.program || 'WWFF').toUpperCase(), mySigInfo: xr.ref, myGridsquare: settings.grid || '' };
        if (xr.program === 'WWFF') xrQso.myWwffRef = xr.ref;
        await saveQsoRecord(xrQso);
      }
    } else {
      await saveQsoRecord(qsoData);
    }

    console.log('[JTCAT] Auto-logged QSO:', q.call, 'OK');
    // Notify the popout window
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.webContents.send('jtcat-qso-logged', {
        callsign: q.call.toUpperCase(),
        grid: q.grid || '',
        band,
        mode,
        rstSent: q.sentReport || '',
        rstRcvd: q.report || '',
      });
    }
  } catch (err) {
    console.error('[JTCAT] Auto-log failed:', err.message);
  }
}

// Shared QSO state machine — advance on decodes
// setTxMsg: fn(msg) to set TX message and broadcast state
// onDone: fn() called when QSO completes
//
// Diagnostic logging: every call emits one [JTCAT QSO] line summarizing
// what the state machine saw and what it did. Helps answer "why did POTACAT
// repeat my last TX instead of advancing?" — the typical answer is the FT8
// engine missed the partner's reply on that cycle (a normal ~2-3% miss rate
// at low SNR). The log line shows whether a matching decode was actually in
// the cycle's results — if yes, it's a state-machine bug; if no, it's a
// decoder miss and the next cycle should pick it up. (K3SBP 2026-05-03.)
function advanceJtcatQso(q, results, setTxMsg, onDone) {
  if (!q || q.phase === 'done' || q.phase === 'idle') return;
  const myCall = q.myCall;
  const _phaseBefore = q.phase;
  function _qsoLog(action, extra) {
    try {
      const head = `[JTCAT QSO] phase=${_phaseBefore}${q.phase !== _phaseBefore ? '->' + q.phase : ''} call=${q.call || '-'} mode=${q.mode} results=${results.length}`;
      sendCatLog(extra ? `${head} ${action} ${extra}` : `${head} ${action}`);
    } catch {}
  }

  if (q.mode === 'cq') {
    // Final courtesy TX: wait one decode cycle so the RR73 has a chance to transmit
    if (q.phase === 'cq-rr73') {
      if (!q._courtesySent) {
        q._courtesySent = true;
        _qsoLog('courtesy-RR73 wait (first cycle in cq-rr73)');
        return; // first decode in this phase — TX boundary hasn't fired yet
      }
      q.phase = 'done';
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      ft8Engine.setTxSlot('auto');
      _qsoLog('QSO done (courtesy RR73 sent)');
      return;
    }

    if (q.phase === 'cq') {
      const reply = results.find(d => {
        const t = (d.text || '').toUpperCase();
        return t.indexOf(myCall) >= 0 && !t.startsWith('CQ ');
      });
      if (!reply) {
        _qsoLog('no advance', `(no decode containing ${myCall} that isn't a CQ)`);
        return;
      }
      const m = (reply.text || '').toUpperCase().match(new RegExp(myCall.replace(/[/]/g, '\\/') + '\\s+([A-Z0-9/]+)\\s+([A-R]{2}\\d{2})', 'i'));
      if (!m) {
        _qsoLog('no advance', `(decode "${reply.text}" matched ${myCall} but didn't parse <call> <grid>)`);
        return;
      }
      q.call = m[1]; q.grid = m[2];
      const dbRounded = Math.round(reply.db);
      const rpt = dbRounded >= 0 ? '+' + String(dbRounded).padStart(2, '0') : '-' + String(Math.abs(dbRounded)).padStart(2, '0');
      q.sentReport = rpt;
      q.txMsg = q.call + ' ' + myCall + ' ' + rpt;
      q.phase = 'cq-report';
      ft8Engine.setRxFreq(reply.df);
      setTxMsg(q.txMsg);
      _qsoLog('advance to cq-report', `("${reply.text}" -> tx "${q.txMsg}")`);
    } else if (q.phase === 'cq-report') {
      const resp = results.find(d => { const t = (d.text || '').toUpperCase(); return t.indexOf(myCall) >= 0 && t.indexOf(q.call) >= 0; });
      if (!resp) {
        _qsoLog('no advance', `(no decode containing ${myCall}+${q.call})`);
        return;
      }
      const rptM = (resp.text || '').toUpperCase().match(/R?([+-]\d{2})/);
      if (!rptM) {
        q._heardThisCycle = true; // they responded but haven't sent R+report yet
        _qsoLog('heard but no advance', `(decode "${resp.text}" had no R-report yet)`);
        return;
      }
      q.report = rptM[1];
      q.txMsg = q.call + ' ' + myCall + ' RR73';
      q.phase = 'cq-rr73';
      setTxMsg(q.txMsg);
      // QSO confirmed — both reports exchanged. Log now, send RR73 as courtesy.
      onDone();
      _qsoLog('advance to cq-rr73 + log', `("${resp.text}" -> tx "${q.txMsg}")`);
    }
  } else {
    // Reply mode
    const theirCall = q.call;

    // Final courtesy TX: wait one decode cycle so the 73 has a chance to transmit
    if (q.phase === '73') {
      if (!q._courtesySent) {
        q._courtesySent = true;
        _qsoLog('courtesy-73 wait (first cycle in 73)');
        return; // first decode in this phase — TX boundary hasn't fired yet
      }
      q.phase = 'done';
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      ft8Engine.setTxSlot('auto');
      _qsoLog('QSO done (courtesy 73 sent)');
      return;
    }

    // Detect if the station we're calling started a QSO with someone else.
    // e.g. we're calling K3SBP but we decode "W1ABC K3SBP FN20" or "W1ABC K3SBP R-12" — K3SBP picked someone else.
    const theyPickedOther = results.find(d => {
      const t = (d.text || '').toUpperCase();
      if (t.startsWith('CQ ')) return false; // ignore their CQ
      if (t.indexOf(myCall) >= 0) return false; // directed at us — not "someone else"
      // Check if theirCall appears as the sender (second token) replying to a different station
      // e.g. "N2XYZ W1ABC -12" means W1ABC (theirCall) is sending to N2XYZ, not us
      const parts = t.split(/\s+/);
      return parts.length >= 2 && parts[1] === theirCall;
    });
    if (theyPickedOther) {
      console.log('[JTCAT] Station', theirCall, 'started QSO with someone else:', theyPickedOther.text, '— aborting');
      q.phase = 'done';
      q.error = theirCall + ' picked another station';
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      ft8Engine.setTxSlot('auto');
      if (ft8Engine._txActive) ft8Engine.txComplete();
      _qsoLog('aborted', `(${theirCall} replied to "${theyPickedOther.text}" instead of us)`);
      return;
    }

    const resp = results.find(d => { const t = (d.text || '').toUpperCase(); return t.indexOf(myCall) >= 0 && t.indexOf(theirCall) >= 0; });
    if (!resp) {
      _qsoLog('no advance', `(no decode containing ${myCall}+${theirCall} -- decoder probably missed their reply this cycle)`);
      return;
    }
    const text = (resp.text || '').toUpperCase();
    if (q.phase === 'reply') {
      const rptM = text.match(/[R]?([+-]\d{2})/);
      if (!rptM) {
        _qsoLog('no advance', `(decode "${resp.text}" had no signal report yet)`);
        return;
      }
      q.report = rptM[1];
      const dbRounded = Math.round(resp.db);
      const ourRpt = dbRounded >= 0 ? '+' + String(dbRounded).padStart(2, '0') : '-' + String(Math.abs(dbRounded)).padStart(2, '0');
      q.sentReport = ourRpt;
      if (text.indexOf('R' + rptM[1]) >= 0 || text.indexOf('R+') >= 0 || text.indexOf('R-') >= 0) {
        // They sent R+report — both reports exchanged. Send RR73, log now.
        q.txMsg = theirCall + ' ' + myCall + ' RR73'; q.phase = '73';
        setTxMsg(q.txMsg);
        onDone();
        _qsoLog('advance to 73 + log', `("${resp.text}" had R-report -> tx "${q.txMsg}")`);
      } else {
        q.txMsg = theirCall + ' ' + myCall + ' R' + ourRpt; q.phase = 'r+report';
        setTxMsg(q.txMsg);
        _qsoLog('advance to r+report', `("${resp.text}" -> tx "${q.txMsg}")`);
      }
    } else if (q.phase === 'r+report') {
      if (/\bRR73\b/.test(text) || /\bRRR\b/.test(text) || /\s73$/.test(text)) {
        // They confirmed — QSO complete. Send 73 as courtesy, log now.
        q.txMsg = theirCall + ' ' + myCall + ' 73'; q.phase = '73';
        setTxMsg(q.txMsg);
        onDone();
        _qsoLog('advance to 73 + log', `("${resp.text}" had RR73 -> tx "${q.txMsg}")`);
      } else {
        // They're still responding (e.g. repeating report) — mark as heard so retries don't expire
        q._heardThisCycle = true;
        _qsoLog('heard but no advance', `(decode "${resp.text}" — still waiting for RR73)`);
      }
    }
  }
}

// Server-side QSO state machine wrappers
//
// When the engine's _autoSeq flag is false, skip the auto-advance entirely.
// The user drives phases manually via Skip (jtcat-skip-phase). Decodes still
// flow to clients via the normal jtcat-decode broadcast — only the
// state-machine call is gated. (Gap 12, 2026-05-04.)
function _autoSeqEnabled() {
  const eng = (jtcatManager && jtcatManager.txEngine) || ft8Engine;
  // Default to true when no engine yet — matches the engine's own default.
  return !eng || eng._autoSeq !== false;
}

function processRemoteJtcatQso(results) {
  if (!_autoSeqEnabled()) return;
  const qso = remoteJtcatQso; // capture reference — don't rely on global in callbacks
  advanceJtcatQso(qso, results, remoteJtcatSetTxMsg, async () => {
    await jtcatAutoLog(qso); // use captured ref, not global
    remoteJtcatBroadcastQso();
  });
}

function processPopoutJtcatQso(results) {
  if (!_autoSeqEnabled()) return;
  const qso = popoutJtcatQso; // capture reference — don't rely on global in callbacks
  advanceJtcatQso(qso, results, async (msg) => {
    const txEng = jtcatManager ? jtcatManager.txEngine : ft8Engine;
    if (txEng) await txEng.setTxMessage(msg);
    popoutBroadcastQso();
  }, async () => {
    await jtcatAutoLog(qso); // use captured ref, not global (global may be replaced by auto-CQ)
    popoutBroadcastQso();
  });
}

function startJtcat(mode) {
  stopJtcat();
  // SSTV and JTCAT can't share the audio input device — getUserMedia
  // from the SSTV popout holds it (or downgrades JTCAT to the laptop
  // mic via the default-device fallback, which silently produces zero
  // decodes). When the user starts JTCAT, tear down any SSTV first so
  // JTCAT gets a clean grab of the configured rig audio device.
  // Casey on 2026-05-03: came back from Auto-SSTV, opened JTCAT on 20m,
  // got zero decodes; restart fixed it because SSTV was no longer
  // running.
  cancelAutoSstv();
  if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
    sendCatLog('[JTCAT] Closing SSTV popout — JTCAT and SSTV can\'t share the audio input');
    try { sstvPopoutWin.close(); } catch {}
  }
  jtcatAutoCqMode = 'off';
  jtcatAutoCqWorkedSession.clear();
  jtcatAutoCqOwner = null;
  if (!jtcatManager) jtcatManager = new JtcatManager();
  jtcatManager.startSlice({ sliceId: 'default', mode: mode || 'FT8' });
  ft8Engine = jtcatManager.engine; // Phase 0 alias

  // Remove any stale listeners from a previous startJtcat() cycle
  ft8Engine.removeAllListeners('decode');
  ft8Engine.removeAllListeners('tx-start');
  ft8Engine.removeAllListeners('tx-end');

  // Catch engine errors (e.g. missing FT4/FT2 decoder on some platforms)
  ft8Engine.on('error', (data) => {
    const msg = data.message || String(data);
    sendCatLog('[JTCAT] Engine error: ' + msg);
    console.error('[JTCAT] Engine error:', msg);
  });

  // Surface engine-level info (which decoder is in use, etc.) in the
  // Verbose CAT log so the user can verify ft8_lib (native) is loaded
  // without opening DevTools / Node console.
  ft8Engine.on('log', (line) => sendCatLog('[JTCAT] ' + line));

  ft8Engine.on('decode', async (data) => {
    // Enrich decodes with "needed" flags for call roster
    if (data.results) {
      const currentBand = _currentFreqHz ? freqToBand(_currentFreqHz / 1e6) : null;
      // Parse watchlist for matching
      const wlStr = (settings.watchlist || '').toUpperCase();
      const wlCalls = wlStr ? wlStr.split(',').map(s => s.trim().split(':')[0]).filter(Boolean) : [];
      for (const r of data.results) {
        const { dxCall } = extractCallsigns(r.text || '');
        if (!dxCall) continue;
        const uc = dxCall.toUpperCase();
        if (ctyDb) {
          const entity = resolveCallsign(uc, ctyDb);
          r.entity = entity ? entity.name : '';
          r.continent = entity ? entity.continent : '';
          r.newDxcc = !!(entity && currentBand && !rosterWorkedDxcc.has(entity.name + '|' + currentBand));
        }
        r.call = uc;
        r.newCall = !rosterWorkedCalls.has(uc);
        r.watched = wlCalls.length > 0 && wlCalls.some(w => uc.indexOf(w) >= 0 || w.indexOf(uc) >= 0);
        // Extract grid from CQ messages (e.g. "CQ K1ABC FN42")
        // Maidenhead grids: longitude field A-R, latitude field A-J, then 2 digits
        const gm = (r.text || '').match(/\b([A-R]{2}\d{2})\s*$/i);
        // Exclude FT8 exchanges that look like grids (RR73, RR99, etc.)
        if (gm && !(/^RR\d{2}$/i.test(gm[1]))) {
          r.grid = gm[1].toUpperCase();
          r.newGrid = !rosterWorkedGrids.has(r.grid);
        }
      }
    }

    if (win && !win.isDestroyed()) {
      win.webContents.send('jtcat-decode', data);
    }
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.webContents.send('jtcat-decode', data);
    }
    if (jtcatMapPopoutWin && !jtcatMapPopoutWin.isDestroyed()) {
      jtcatMapPopoutWin.webContents.send('jtcat-decode', data);
    }
    // Broadcast to phone + advance remote QSO state machine
    if (remoteServer && remoteServer.hasClient()) {
      const now = new Date();
      const timeStr = String(now.getUTCHours()).padStart(2, '0') + ':' +
                      String(now.getUTCMinutes()).padStart(2, '0') + ':' +
                      String(now.getUTCSeconds()).padStart(2, '0');
      const sliceBand = jtcatManager ? jtcatManager.getDialFreq('default').band : '';
      remoteServer.broadcastJtcatDecode({ ...data, time: timeStr, sliceId: 'default', band: sliceBand });
    }
    // Clean up completed QSOs (re-arms auto-CQ for next cycle)
    if (remoteJtcatQso && remoteJtcatQso.phase === 'done') {
      remoteJtcatQso = null;
      remoteJtcatBroadcastQso();
    }
    if (popoutJtcatQso && popoutJtcatQso.phase === 'done') {
      popoutJtcatQso = null;
      popoutBroadcastQso();
    }
    if (remoteJtcatQso && remoteJtcatQso.phase !== 'done') {
      const phaseBefore = remoteJtcatQso.phase;
      remoteJtcatQso._heardThisCycle = false;
      processRemoteJtcatQso(data.results || []);
      // Count retries — only increment when other station was NOT heard at all
      if (remoteJtcatQso && remoteJtcatQso.phase === phaseBefore && remoteJtcatQso.phase !== 'done') {
        if (remoteJtcatQso._heardThisCycle) {
          remoteJtcatQso.txRetries = 0; // they're still responding, keep trying
        } else {
          remoteJtcatQso.txRetries = (remoteJtcatQso.txRetries || 0) + 1;
        }
        const max = (remoteJtcatQso.phase === 'cq') ? JTCAT_MAX_CQ_RETRIES : JTCAT_MAX_QSO_RETRIES;
        if (remoteJtcatQso.txRetries >= max) {
          console.log('[JTCAT Remote] TX retry limit reached (' + max + ') in phase ' + remoteJtcatQso.phase + ' — giving up');
          ft8Engine._txEnabled = false;
          ft8Engine.setTxMessage('');
          ft8Engine.setTxSlot('auto');
          if (ft8Engine._txActive) ft8Engine.txComplete();
          remoteJtcatQso = null;
          remoteJtcatBroadcastQso();
          if (remoteServer.hasClient()) {
            remoteServer.broadcastJtcatQsoState({ phase: 'error', error: 'No response — TX stopped' });
          }
        }
      } else if (remoteJtcatQso && remoteJtcatQso.phase !== phaseBefore) {
        remoteJtcatQso.txRetries = 0;
      }
    }
    // Advance popout QSO state machine
    if (popoutJtcatQso && popoutJtcatQso.phase !== 'done') {
      const phaseBefore = popoutJtcatQso.phase;
      popoutJtcatQso._heardThisCycle = false;
      processPopoutJtcatQso(data.results || []);
      if (popoutJtcatQso && popoutJtcatQso.phase === phaseBefore && popoutJtcatQso.phase !== 'done') {
        if (popoutJtcatQso._heardThisCycle) {
          popoutJtcatQso.txRetries = 0; // they're still responding, keep trying
        } else {
          popoutJtcatQso.txRetries = (popoutJtcatQso.txRetries || 0) + 1;
        }
        const max = (popoutJtcatQso.phase === 'cq') ? JTCAT_MAX_CQ_RETRIES : JTCAT_MAX_QSO_RETRIES;
        if (popoutJtcatQso.txRetries >= max) {
          console.log('[JTCAT Popout] TX retry limit reached (' + max + ') in phase ' + popoutJtcatQso.phase + ' — giving up');
          ft8Engine._txEnabled = false;
          ft8Engine.setTxMessage('');
          ft8Engine.setTxSlot('auto');
          if (ft8Engine._txActive) ft8Engine.txComplete();
          popoutJtcatQso = null;
          popoutBroadcastQso();
          if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
            jtcatPopoutWin.webContents.send('jtcat-qso-state', { phase: 'error', error: 'No response — TX stopped' });
          }
        }
      } else if (popoutJtcatQso && popoutJtcatQso.phase !== phaseBefore) {
        popoutJtcatQso.txRetries = 0;
      }
    }

    // --- Auto-CQ Response ---
    // Only trigger when no active QSO is running and auto mode is enabled
    if (jtcatAutoCqMode !== 'off' && !popoutJtcatQso && !remoteJtcatQso) {
      const myCall = (settings.myCallsign || '').toUpperCase();
      const myGrid = (settings.grid || '').toUpperCase().substring(0, 4);
      if (myCall && myGrid && ft8Engine) {
        const results = data.results || [];
        const candidates = results
          .filter(d => matchesAutoCqFilter(d.text, jtcatAutoCqMode))
          .map(d => ({ ...d, ...parseCqMessage(d.text) }))
          .filter(d => {
            if (!d.call || d.call === myCall) return false;
            if (jtcatAutoCqWorkedSession.has(d.call)) return false;
            if (workedQsos && workedQsos.has(d.call)) return false;
            return true;
          });

        // Pick strongest SNR
        candidates.sort((a, b) => b.db - a.db);
        const best = candidates[0];

        if (best) {
          jtcatAutoCqWorkedSession.add(best.call);
          console.log(`[JTCAT Auto-CQ] Responding to ${best.call} (${best.grid}) SNR ${best.db}dB`);

          // Create QSO — assign to the owner's state variable
          const qso = {
            mode: 'reply',
            phase: 'reply',
            call: best.call,
            grid: best.grid,
            myCall,
            myGrid,
            txMsg: best.call + ' ' + myCall + ' ' + myGrid,
            report: null,
            sentReport: null,
            txRetries: 0,
          };

          ft8Engine.setRxFreq(best.df);
          ft8Engine.setTxFreq(best.df);
          ft8Engine._txEnabled = true;
          // Match their TX slot: they CQ on slot X, we reply on the opposite
          const theirSlot = best.slot || 'even';
          ft8Engine.setTxSlot(theirSlot === 'even' ? 'odd' : 'even');

          if (jtcatAutoCqOwner === 'remote') {
            remoteJtcatQso = qso;
            await remoteJtcatSetTxMsg(qso.txMsg);
            if (ft8Engine) ft8Engine.tryImmediateTx();
            remoteJtcatBroadcastQso();
          } else {
            popoutJtcatQso = qso;
            if (ft8Engine) await ft8Engine.setTxMessage(qso.txMsg);
            if (ft8Engine) ft8Engine.tryImmediateTx();
            popoutBroadcastQso();
          }
          broadcastAutoCqState();
        }
      }
    }
  });

  ft8Engine.on('silent', () => {
    // Audio capture is delivering zeros — tell renderer to restart
    if (win && !win.isDestroyed()) win.webContents.send('restart-jtcat-audio');
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      // Popout has its own audio — tell it to restart too
      jtcatPopoutWin.webContents.send('restart-popout-audio');
    }
  });

  ft8Engine.on('cycle', (data) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('jtcat-cycle', data);
    }
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.webContents.send('jtcat-cycle', data);
    }
    if (remoteServer && remoteServer.hasClient()) remoteServer.broadcastJtcatCycle(data);
  });

  ft8Engine.on('status', (data) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('jtcat-status', data);
    }
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.webContents.send('jtcat-status', data);
    }
    if (remoteServer && remoteServer.hasClient()) remoteServer.broadcastJtcatStatus(data);
  });

  ft8Engine.on('tx-start', (data) => {
    const catState = cat ? `connected=${cat.connected}` : 'cat=null';
    console.log(`[JTCAT] TX start — PTT on, message: ${data.message}, ${catState}`);
    sendCatLog(`FT8 TX: ${data.message} freq=${data.freq}Hz slot=${data.slot} ${catState}`);
    handleRemotePtt(true);
    if (win && !win.isDestroyed()) {
      win.webContents.send('jtcat-tx-status', { state: 'tx', message: data.message, slot: data.slot });
    }
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.webContents.send('jtcat-tx-status', { state: 'tx', message: data.message, slot: data.slot, txFreq: ft8Engine._txFreq });
    }
    if (jtcatMapPopoutWin && !jtcatMapPopoutWin.isDestroyed()) {
      jtcatMapPopoutWin.webContents.send('jtcat-tx-status', { state: 'tx', message: data.message, slot: data.slot, txFreq: ft8Engine._txFreq });
      if (popoutJtcatQso) jtcatMapPopoutWin.webContents.send('jtcat-qso-state', popoutJtcatQso);
    }
    if (remoteServer && remoteServer.hasClient()) {
      remoteServer.broadcastJtcatTxStatus({ state: 'tx', message: data.message, slot: data.slot, txFreq: ft8Engine._txFreq });
    }
    setTimeout(() => {
      if (win && !win.isDestroyed() && ft8Engine && ft8Engine._txActive) {
        win.webContents.send('jtcat-tx-audio', { samples: Array.from(data.samples), offsetMs: data.offsetMs || 0 });
      }
    }, 200);
  });

  ft8Engine.on('tx-end', () => {
    console.log('[JTCAT] TX end — PTT off');
    handleRemotePtt(false);
    if (win && !win.isDestroyed()) {
      win.webContents.send('jtcat-tx-status', { state: 'rx' });
    }
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.webContents.send('jtcat-tx-status', { state: 'rx', txFreq: ft8Engine ? ft8Engine._txFreq : 0 });
    }
    if (remoteServer && remoteServer.hasClient()) {
      remoteServer.broadcastJtcatTxStatus({ state: 'rx', txFreq: ft8Engine ? ft8Engine._txFreq : 0 });
    }
  });

  ft8Engine.on('error', (err) => {
    console.error('[JTCAT] Engine error:', err.message);
  });

  ft8Engine.start();
  console.log('[JTCAT] Engine started, mode:', mode || 'FT8');
}

// --- JTCAT Tune (WSJT-X-style steady-tone for power/ALC tuning) ---
const JTCAT_TUNE_DURATION_S = 90;
const jtcatTuneState = {
  active: false,
  endsAt: 0,        // wall-clock ms when it auto-stops
  endTimer: null,   // setTimeout ref
  tickTimer: null,  // setInterval ref for countdown broadcast
};

function broadcastJtcatTuneState() {
  const remaining = jtcatTuneState.active
    ? Math.max(0, Math.ceil((jtcatTuneState.endsAt - Date.now()) / 1000))
    : 0;
  const payload = { active: jtcatTuneState.active, secondsRemaining: remaining };
  if (win && !win.isDestroyed()) win.webContents.send('jtcat-tune-state', payload);
  if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) jtcatPopoutWin.webContents.send('jtcat-tune-state', payload);
  // Mobile FT8 screen reads this so the Tune button reflects state +
  // countdown. (Gap 11.)
  if (remoteServer && remoteServer.hasClient && remoteServer.hasClient()) {
    remoteServer.sendToClient({ type: 'jtcat-tune-state', ...payload });
  }
}

function startJtcatTune() {
  if (jtcatTuneState.active) return;
  jtcatTuneState.active = true;
  jtcatTuneState.endsAt = Date.now() + JTCAT_TUNE_DURATION_S * 1000;
  // Audio is genuinely going to the rig USB CODEC, so audio:true triggers
  // SSB-over-DATA where appropriate (USB -> DIGU mute the rig mic during
  // the tone). The 90s timer auto-releases.
  handleRemotePtt(true, { audio: true });
  if (win && !win.isDestroyed()) win.webContents.send('jtcat-tune-audio-start');
  jtcatTuneState.endTimer = setTimeout(() => stopJtcatTune(), JTCAT_TUNE_DURATION_S * 1000);
  jtcatTuneState.tickTimer = setInterval(broadcastJtcatTuneState, 1000);
  broadcastJtcatTuneState();
  sendCatLog(`[JTCAT] Tune ON (${JTCAT_TUNE_DURATION_S}s)`);
}

function stopJtcatTune() {
  if (!jtcatTuneState.active) return;
  jtcatTuneState.active = false;
  if (jtcatTuneState.endTimer) { clearTimeout(jtcatTuneState.endTimer); jtcatTuneState.endTimer = null; }
  if (jtcatTuneState.tickTimer) { clearInterval(jtcatTuneState.tickTimer); jtcatTuneState.tickTimer = null; }
  if (win && !win.isDestroyed()) win.webContents.send('jtcat-tune-audio-stop');
  handleRemotePtt(false);
  broadcastJtcatTuneState();
  sendCatLog('[JTCAT] Tune OFF');
}

function stopJtcat() {
  // Clean up any active QSOs to prevent stuck state
  if (remoteJtcatQso) {
    remoteJtcatQso = null;
    if (remoteServer && remoteServer.hasClient && remoteServer.hasClient()) {
      remoteServer.broadcastJtcatQsoState({ phase: 'idle' });
    }
  }
  if (popoutJtcatQso) {
    popoutJtcatQso = null;
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.webContents.send('jtcat-qso-state', { phase: 'idle' });
    }
  }
  if (jtcatManager) {
    jtcatManager.stopAll();
  }
  if (jtcatTuneState.active) stopJtcatTune();
  ft8Engine = null;
  console.log('[JTCAT] Engine stopped');
}

// --- SmartSDR panadapter spots ---
function needsSmartSdr() {
  // Connect SmartSDR API only when a Flex radio is configured or panadapter spots are enabled.
  // All Flex-specific features (CW keyer, rig controls, XIT) require catTarget.type === 'tcp'.
  const isFlex = settings.catTarget && settings.catTarget.type === 'tcp';
  if (settings.smartSdrSpots) return true;
  if (!isFlex) return false; // non-Flex rigs never need SmartSDR
  if (settings.enableCwKeyer) return true;
  if (settings.enableRemote && settings.remoteCwEnabled) return true;
  if (settings.enableWsjtx) return true;
  if (settings.enableRemote) return true;
  if (settings.cwXit) return true;
  return true; // Flex rig always needs API for rig panel (ATU/NB/gain/power)
}

function connectSmartSdr() {
  disconnectSmartSdr();
  if (!needsSmartSdr()) return;
  smartSdr = new SmartSdrClient();
  let _sdrErrorLogged = false;
  smartSdr.on('error', (err) => {
    console.error('SmartSDR:', err.message);
    // Only log the first error in a failure sequence — the retry loop will
    // otherwise spam the CAT log every 5-20 s. The 'give-up' handler below
    // surfaces a final, actionable message.
    if (!_sdrErrorLogged) {
      sendCatLog(`SmartSDR API error: ${err.message}`);
      _sdrErrorLogged = true;
    }
  });
  smartSdr.on('connected', () => {
    _sdrErrorLogged = false;
    sendCatLog('SmartSDR API connected (port 4992) — rig controls active');
  });
  smartSdr.on('disconnected', () => {
    sendCatLog('SmartSDR API disconnected — rig controls (ATU/filter/gain) unavailable');
  });
  smartSdr.on('give-up', ({ host, attempts }) => {
    const isLocal = host === '127.0.0.1' || host === 'localhost';
    const hint = isLocal
      ? `Set "SmartSDR API Host" in your Rig settings to your Flex's IP address (e.g. 192.168.1.100). SmartSDR only exposes CAT on localhost; the API (ATU, NB, SWR, S-meter, CW keyer, SSB/DIGU TX) lives on port 4992 of the radio itself.`
      : `Check that the radio is on the network, reachable at ${host}, and SmartSDR is connected to it.`;
    sendCatLog(`SmartSDR API unreachable at ${host}:4992 after ${attempts} attempts — giving up. ${hint}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('smartsdr-unreachable', { host, hint });
    }
  });
  // Generate and store a persistent client_id for GUI registration (needed for CW keying)
  if (!settings.smartSdrClientId) {
    const crypto = require('crypto');
    settings.smartSdrClientId = crypto.randomUUID();
    saveSettings(settings);
  }
  smartSdr.setPersistentId(settings.smartSdrClientId);
  // Tell SmartSDR whether CW keyer needs GUI auth
  smartSdr.setNeedsCw(!!(settings.enableCwKeyer || (settings.enableRemote && settings.remoteCwEnabled)));
  // Bind to GUI client for ECHOCAT rig controls (ATU, etc.)
  smartSdr.setNeedsBind(!!settings.enableRemote);
  // Log CW auth results
  smartSdr.on('smeter', sendCatSmeter);
  smartSdr.on('swr-ratio', (swr) => {
    if (win && !win.isDestroyed()) win.webContents.send('cat-swr-ratio', swr);
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.webContents.send('cat-swr-ratio', swr);
    if (remoteServer && remoteServer.running) remoteServer.sendToClient({ type: 'swr-ratio', value: swr });
  });

  smartSdr.on('cw-auth', ({ method, ok }) => {
    console.log(`[SmartSDR] CW auth: method=${method} ok=${ok}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('cw-keyer-status', {
        enabled: !!settings.enableCwKeyer,
        cwAuth: method,
        cwAuthOk: ok,
      });
    }
  });
  // Use per-rig flexApiHost if set, else smartSdrHost global, else catTarget host, else localhost
  const activeRig = (settings.rigs || []).find(r => r.id === settings.activeRigId);
  const sdrHost = (activeRig && activeRig.flexApiHost) || settings.smartSdrHost || (settings.catTarget && settings.catTarget.host) || '127.0.0.1';
  sendCatLog(`Connecting SmartSDR API to ${sdrHost}:4992...`);
  smartSdr.connect(sdrHost);
}

function disconnectSmartSdr() {
  if (smartSdrPushTimer) {
    clearTimeout(smartSdrPushTimer);
    smartSdrPushTimer = null;
  }
  if (smartSdr) {
    if (smartSdr.connected) smartSdr.clearSpots();
    smartSdr.disconnect();
    smartSdr = null;
  }
}

let lastSmartSdrPush = 0;

// ---------------------------------------------------------------------------
// Panadapter / Bandscope spot routing
// ---------------------------------------------------------------------------
// The same merged spot list flows to three "frequency-overlay" destinations:
// the SmartSDR panadapter, the TCI panadapter, and the bandscope popout.
// These three should behave identically — operators don't think of them as
// separate things, they think of "the panadapter" (Casey to Tyler 2026-04-30).
//
// Two modes:
//
//   * Sync with Table View (default ON) — reuse the table's source toggles
//     (settings.enablePota / enableSota / enableWwff / enableLlota /
//     enableCluster / enableCwSpots / enableRbn / enablePskr) so whatever
//     the operator sees in the table is what overlays on the panadapter.
//
//   * Independent (sync OFF) — the panadapter has its own per-source
//     allowlist (settings.panadapterPota / Sota / Wwff / Llota / Cluster /
//     Rbn / CwSpots / Pskr / Wsjtx). When this mode is on, the *fetch*
//     decision in refreshSpots / connectCluster / etc. ORs in these
//     toggles too so a source enabled only here still pulls traffic.
//     Required for K0OTC's "DX-only-panadapter, POTA-only-table" scenario.
//
// Helper used by all three push sites + the bandspread popout payload.
function panadapterAllowsSource(source) {
  if (settings.panadapterSyncTable !== false) {
    // Sync mode (default) — mirror the table's source set.
    switch (source) {
      case 'pota':    return settings.enablePota !== false; // default true
      case 'sota':    return settings.enableSota === true;
      case 'wwff':    return settings.enableWwff === true;
      case 'llota':   return settings.enableLlota === true;
      case 'tiles':   return settings.enableTiles !== false; // default true
      case 'dxc':     return settings.enableCluster === true;
      case 'rbn':     return settings.enableRbn === true;
      case 'cwspots': return settings.enableCwSpots === true;
      case 'pskr':    return settings.enablePskr === true;
      case 'freedv':  return settings.enableFreedv === true;
      case 'wsjtx':   return true; // local overlays — operator owns the WSJT-X UI
      default:        return true;
    }
  }
  // Independent mode — explicit per-source picks for the panadapter.
  switch (source) {
    case 'pota':    return settings.panadapterPota === true;
    case 'sota':    return settings.panadapterSota === true;
    case 'wwff':    return settings.panadapterWwff === true;
    case 'llota':   return settings.panadapterLlota === true;
    case 'dxc':     return settings.panadapterCluster === true;
    case 'rbn':     return settings.panadapterRbn === true;
    case 'cwspots': return settings.panadapterCwSpots === true;
    case 'pskr':    return settings.panadapterPskr === true;
    case 'freedv':  return settings.panadapterPskr === true;
    case 'wsjtx':   return settings.panadapterWsjtx === true;
    default:        return true;
  }
}

function spotsForPanadapter(merged) {
  return merged.filter(s => panadapterAllowsSource(s.source));
}

// True when the user has independently selected a source for the panadapter.
// Used by fetch gates: if the table-side enable* says no, we still pull
// the source if the panadapter asked for it (and we're in independent mode).
function panadapterWantsSource(source) {
  if (settings.panadapterSyncTable !== false) return false; // sync mode adds nothing extra
  switch (source) {
    case 'pota':    return settings.panadapterPota === true;
    case 'sota':    return settings.panadapterSota === true;
    case 'wwff':    return settings.panadapterWwff === true;
    case 'llota':   return settings.panadapterLlota === true;
    case 'dxc':     return settings.panadapterCluster === true;
    case 'rbn':     return settings.panadapterRbn === true;
    case 'cwspots': return settings.panadapterCwSpots === true;
    case 'pskr':    return settings.panadapterPskr === true;
    default:        return false;
  }
}

function pushSpotsToSmartSdr(spots) {
  if (!smartSdr || !smartSdr.connected) return;
  if (!settings.smartSdrSpots) return; // only push spots when explicitly enabled
  const now = Date.now();
  if (now - lastSmartSdrPush < 5000) return;
  lastSmartSdrPush = now;

  const tableMaxAgeMs = ((settings.maxAgeMin != null ? settings.maxAgeMin : 5) * 60000) || 300000;
  const sdrMaxAgeMs = (settings.smartSdrMaxAge != null ? settings.smartSdrMaxAge : 15) * 60000;
  const maxAgeMs = sdrMaxAgeMs > 0 ? Math.min(sdrMaxAgeMs, tableMaxAgeMs) : tableMaxAgeMs;
  const maxSpots = settings.smartSdrMaxSpots || 0;

  // Apply the user's panadapter-source allowlist (sync-with-table or independent).
  spots = spotsForPanadapter(spots);

  let pushed = 0;
  for (const spot of spots) {
    // Age filter — skip spots older than the effective max age (table age or panadapter age, whichever is smaller)
    if (maxAgeMs > 0 && spot.spotTime) {
      const t = spot.spotTime.endsWith('Z') ? spot.spotTime : spot.spotTime + 'Z';
      const age = now - new Date(t).getTime();
      if (age > maxAgeMs) continue;
    }
    smartSdr.addSpot(spot);
    pushed++;
    if (maxSpots > 0 && pushed >= maxSpots) break;
  }
  // Remove spots no longer in the list (instead of clear+re-add which causes flashing)
  smartSdr.pruneStaleSpots();
}

// --- TCI (Thetis/ExpertSDR3) panadapter spots ---
function connectTci() {
  disconnectTci();
  if (!settings.tciSpots) return;
  tciClient = new TciClient();
  tciClient.on('error', (err) => {
    console.error('TCI:', err.message);
  });
  tciClient.connect(settings.tciHost || '127.0.0.1', settings.tciPort || 50001);
}

function disconnectTci() {
  if (tciPushTimer) {
    clearTimeout(tciPushTimer);
    tciPushTimer = null;
  }
  if (tciClient) {
    if (tciClient.connected) tciClient.clearSpots();
    tciClient.disconnect();
    tciClient = null;
  }
}

// --- 4O3A Antenna Genius ---
function connectAntennaGenius() {
  disconnectAntennaGenius();
  if (!settings.enableAntennaGenius) {
    sendCatLog('[AG] Antenna Genius disabled in settings');
    return;
  }
  if (!settings.agHost) {
    sendCatLog('[AG] Antenna Genius enabled but no host configured');
    return;
  }
  agClient = new AntennaGeniusClient();
  agLastBand = null;
  sendCatLog(`[AG] Connecting to Antenna Genius at ${settings.agHost}:9007`);
  agClient.on('connected', () => {
    sendCatLog('[AG] Connected to Antenna Genius');
    agClient.subscribePortStatus();
    sendAgStatus();
  });
  agClient.on('disconnected', () => {
    sendCatLog('[AG] Disconnected from Antenna Genius');
    sendAgStatus();
  });
  agClient.on('port-status', (status) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('ag-port-status', status);
    }
  });
  agClient.on('antenna-list', (names) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('ag-antenna-names', names);
    }
  });
  agClient.on('log', (msg) => {
    sendCatLog(`[AG] ${msg}`);
  });
  agClient.on('error', (err) => {
    sendCatLog(`[AG] Error: ${err.message}`);
  });
  agClient.on('reconnecting', () => {
    sendCatLog(`[AG] Reconnecting to ${settings.agHost}:9007...`);
  });
  agClient.connect(settings.agHost, 9007);
}

function disconnectAntennaGenius() {
  agLastBand = null;
  if (agClient) {
    agClient.removeAllListeners();
    agClient.disconnect();
    agClient = null;
  }
}

// --- TunerGenius 1x3 ---

function connectTunerGenius() {
  disconnectTunerGenius();
  if (!settings.enableTgxl) {
    sendCatLog('[TGXL] TunerGenius disabled in settings');
    return;
  }
  if (!settings.tgxlHost) {
    sendCatLog('[TGXL] TunerGenius enabled but no IP configured');
    return;
  }
  tgxlClient = new TunerGeniusClient();
  tgxlLastBand = null;
  sendCatLog(`[TGXL] Connecting to TunerGenius at ${settings.tgxlHost}:9010`);
  tgxlClient.on('connected', () => {
    sendCatLog('[TGXL] Connected to TunerGenius');
    sendTgxlStatus();
  });
  tgxlClient.on('disconnected', () => {
    sendCatLog('[TGXL] Disconnected from TunerGenius');
    sendTgxlStatus();
  });
  tgxlClient.on('status', (status) => {
    const labels = settings.tgxlLabels || {};
    if (win && !win.isDestroyed()) win.webContents.send('tgxl-status', { ...status, labels });
    if (remoteServer && remoteServer.running) {
      remoteServer.sendToClient({ type: 'tgxl-status', ...status, labels });
    }
  });
  tgxlClient.on('log', (msg) => sendCatLog(`[TGXL] ${msg}`));
  tgxlClient.on('error', (err) => sendCatLog(`[TGXL] Error: ${err.message}`));
  tgxlClient.connect(settings.tgxlHost, 9010);
}

function disconnectTunerGenius() {
  tgxlLastBand = null;
  if (tgxlClient) {
    tgxlClient.removeAllListeners();
    tgxlClient.disconnect();
    tgxlClient = null;
  }
}

function sendTgxlStatus() {
  const status = {
    connected: !!(tgxlClient && tgxlClient.connected),
    antenna: tgxlClient ? tgxlClient.antenna : 0,
  };
  if (win && !win.isDestroyed()) win.webContents.send('tgxl-status', status);
}

function tgxlSwitchForBand(band) {
  if (!tgxlClient || !tgxlClient.connected) return;
  if (!band || band === tgxlLastBand) return;
  tgxlLastBand = band;
  const bandMap = settings.tgxlBandMap || {};
  const ant = parseInt(bandMap[band], 10);
  if (ant >= 1 && ant <= 3) {
    sendCatLog(`[TGXL] Band ${band} -> antenna ${ant}`);
    tgxlClient.selectAntenna(ant);
  }
}

function sendAgStatus() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('ag-status', {
      connected: !!(agClient && agClient.connected),
    });
  }
}

/**
 * Switch antenna based on frequency. Called from tuneRadio().
 * @param {number} freqKhz - Frequency in kHz
 */
function agSwitchForFreq(freqKhz) {
  if (!agClient || !agClient.connected) {
    sendCatLog('[AG] Skip switch — not connected');
    return;
  }
  if (!settings.agBandMap || typeof settings.agBandMap !== 'object') {
    sendCatLog('[AG] Skip switch — no band map configured');
    return;
  }

  const freqMhz = freqKhz / 1000;
  const band = freqToBand(freqMhz);
  if (!band) {
    sendCatLog(`[AG] Skip switch — freq ${freqKhz} kHz not in any band`);
    return;
  }

  // Don't re-send if already on this band
  if (band === agLastBand) return;
  agLastBand = band;

  const antenna = settings.agBandMap[band];
  if (!antenna) {
    sendCatLog(`[AG] No antenna mapped for ${band}`);
    return;
  }

  const radioPort = settings.agRadioPort || 1;
  sendCatLog(`[AG] Band ${band} -> antenna ${antenna} (port ${radioPort === 1 ? 'A' : 'B'})`);
  agClient.selectAntenna(radioPort, antenna);
}

// --- ECHOCAT ---
function pushActivatorStateToPhone() {
  if (!remoteServer || !remoteServer.hasClient()) return;
  const parkRefs = (settings.activatorParkRefs || []).filter(p => p && p.ref).map(p => ({ ref: p.ref, name: p.name || '' }));
  remoteServer.broadcastActivatorState({
    appMode: settings.appMode || 'hunter',
    parkRefs,
    grid: settings.grid || '',
  });
  remoteServer.sendSessionContacts();
}

function updateRemoteSettings() {
  if (!remoteServer) return;
  const anyCluster = [...clusterClients.values()].some(e => e.client.connected);
  remoteServer.setRemoteSettings({
    myCallsign: settings.myCallsign || '',
    grid: settings.grid || '',
    clusterConnected: anyCluster,
    respotDefault: settings.respotDefault !== false,
    respotTemplate: settings.respotTemplate || '{rst} in {QTH} 73s {mycallsign} via POTACAT',
    dxRespotTemplate: settings.dxRespotTemplate || 'Heard in {QTH} 73s {mycallsign} via POTACAT',
    scanDwell: parseInt(settings.scanDwell, 10) || 7,
    refreshInterval: settings.refreshInterval || 30,
    maxAgeMin: settings.maxAgeMin != null ? settings.maxAgeMin : 5,
    distUnit: settings.distUnit || 'mi',
    cwXit: settings.cwXit || 0,
    cwFilterWidth: settings.cwFilterWidth || 0,
    ssbFilterWidth: settings.ssbFilterWidth || 0,
    digitalFilterWidth: settings.digitalFilterWidth || 0,
    enableSplit: !!settings.enableSplit,
    enableAtu: !!settings.enableAtu,
    tuneClick: !!settings.tuneClick,
    enableRotor: !!settings.enableRotor,
    rotorActive: settings.rotorActive !== false,
    remoteCwEnabled: !!settings.remoteCwEnabled,
    remoteCwMacros: settings.remoteCwMacros || null,
    // Phone-stored prefs that we persist server-side so they survive
    // localStorage wipes on the phone (Safari ITP, cache clears).
    // Currently: echocatWelcomeDismissed.
    echocatWelcomeDismissed: !!(settings.echocatPrefs && settings.echocatPrefs.echocatWelcomeDismissed),
    customCatButtons: settings.customCatButtons || null,
    kiwiSdrHost1: settings.kiwiSdrHost1 || settings.kiwiSdrHost || '',
    kiwiSdrHost2: settings.kiwiSdrHost2 || '',
    kiwiSdrHost3: settings.kiwiSdrHost3 || '',
    kiwiSdrLabel1: settings.kiwiSdrLabel1 || '',
    kiwiSdrLabel2: settings.kiwiSdrLabel2 || '',
    kiwiSdrLabel3: settings.kiwiSdrLabel3 || '',
    sstvTemplates: settings.sstvTemplates || [],
    sstvTextElements: settings.sstvTextElements || [],
    enableAutoSstv: !!settings.enableAutoSstv,
    autoSstvInactivityMin: settings.autoSstvInactivityMin || 90,
    // Forwarded so ECHOCAT's phone-side iambic keyer stays in sync with the
    // desktop's. The phone owns the mode selector so this is mostly a fresh-
    // connect snapshot; swap is desktop-only, so the phone needs it to
    // produce the right local sidetone pattern.
    cwKeyerMode: settings.cwKeyerMode || 'iambicB',
    cwSwapPaddles: !!settings.cwSwapPaddles,
  });
}

// --- CW Key Port (dedicated DTR keying via external USB-serial adapter) ---
// Trigger an open ONLY if the port is configured AND not already open or
// opening. Used by the lazy-open paths (first paddle event, first CW
// text-send) so the inevitable open-time DTR pulse merges into a moment
// the operator is intentionally keying. (WD4DAN report: spurious dit at
// app launch was the OS asserting DTR at serial open before our drop ran.)
function ensureCwKeyPortLazyOpen() {
  if (!settings.cwKeyPort) return;
  if (cwKeyPort) return; // already open or in-flight; connectCwKeyPort sets this synchronously
  connectCwKeyPort();
}

function connectCwKeyPort() {
  disconnectCwKeyPort();
  _cwKeyPortPathForPython = null; // forget any stale Python fallback target
  // CW key port for external DTR keying
  const portPath = settings.cwKeyPort;
  if (!portPath) return;
  // Refuse to open the same serial port as the CAT target. Windows serial
  // ports are exclusive, so if rigctld already has it (or the direct serial
  // CAT client does), opening a second handle causes both openers to keep
  // evicting each other — a ~4 s ECONNRESET reconnect storm that presents as
  // the CAT/Rig tabs flashing. Reported by AB9AI 2026-04-23 with FTdx3000
  // configured as serialPort=COM5 + cwKeyPort=COM5.
  const catTarget = settings.catTarget || {};
  const catPath = catTarget.serialPort || catTarget.path || '';
  if (catPath && portPath.toLowerCase() === catPath.toLowerCase()) {
    sendCatLog(`[CW Key Port] Skipping ${portPath} — same as CAT serial port. ` +
      `To use dedicated DTR keying you need a second USB-serial adapter on a different COM port; ` +
      `otherwise leave cwKeyPort blank and POTACAT will key via CI-V / rig protocol.`);
    return;
  }
  const { SerialPort } = require('serialport');
  const port = new SerialPort({
    path: portPath,
    baudRate: 38400, // CDC-ACM ignores baud, but match QMX default just in case
    autoOpen: false,
    rtscts: false,
    // hupcl: true so the OS drops DTR/RTS on close — without this, if our
    // explicit pin-drop ever fails to take, the line stays raised forever
    // (DA2PK reported tone continuing after POTACAT exited). Worth more
    // than the legacy "keep state across reopen" reason hupcl:false had.
    hupcl: true,
  });
  cwKeyPort = port;
  port._dtrFailed = false; // reset DTR fallback flag on fresh connection
  port.on('open', () => {
    // Force DTR low initially (key up), RTS low too. On Linux cdc_acm the
    // kernel raises DTR/RTS during open() and our drop runs ASYNC after —
    // there's a ~10–50ms window where the radio sees key-down. Worse, on
    // some kernels TIOCMSET silently fails for cdc_acm and the line stays
    // raised forever ("constant DAAAAH" reported by Phil/FT-710). So we
    // (a) log the result of the first drop, (b) re-issue the drop 150ms
    // later as belt-and-suspenders, and (c) log a clear hint if either
    // call returns an error so the user knows to check radio menu / OS
    // permissions instead of staring at a quiet log.
    let _ioctlUnsupported = false;
    const dropPins = (label) => {
      if (_ioctlUnsupported) return; // already gave up — don't spam retries
      try {
        port.set({ dtr: false, rts: false }, (err) => {
          if (err) {
            console.log(`[CW Key Port] ${label} pin drop failed: ${err.message}`);
            // ENOTTY / "Inappropriate ioctl" = node-serialport's TIOCMSET path
            // is rejected by the driver (Linux cdc_acm being the typical case
            // on Yaesu USB tty). pyserial works on the same device because it
            // uses TIOCMBIS/TIOCMBIC (set/clear individual modem bits) rather
            // than TIOCMSET (full state including read-only input bits). We
            // can't change which ioctl node-serialport uses, but we CAN shell
            // out to Python to do the keying. Mark the port for the Python
            // fallback and close our handle (hupcl:true drops DTR) so the
            // radio isn't stuck. sendCwTextViaPython picks it up from there.
            const ioctlErr = /inappropriate ioctl|ENOTTY|not supported/i.test(err.message);
            if (ioctlErr && !_ioctlUnsupported) {
              _ioctlUnsupported = true;
              _cwKeyPortPathForPython = portPath;
              sendCatLog(`[CW Key Port] This driver doesn't honor TIOCMSET ("${err.message}") ` +
                `— dropping DTR/RTS via Python helper, then closing the node-serialport handle. ` +
                `CW text-send will use the Python pyserial path (requires python3 + pyserial — ` +
                `install via pip or your distro's python3-pyserial package).`);
              // Drop DTR/RTS via pyserial (TIOCMBIS/BIC) BEFORE closing our
              // node-serialport handle. The kernel hupcl on close was racing
              // with the moment we needed DTR low — DA2PK reported the radio
              // back on continuous carrier in v1.5.5 even though the same
              // logical code path "worked" in his earlier pull. Doing the
              // active drop guarantees DTR is low regardless of hupcl timing.
              try {
                const { spawn } = require('child_process');
                const escPath = portPath.replace(/'/g, "\\'");
                const dropProc = spawn('python3', ['-c',
                  `import serial; p = serial.Serial('${escPath}', 4800); p.setDTR(False); p.setRTS(False); p.close()`
                ], { stdio: ['ignore', 'pipe', 'pipe'] });
                let dropErr = '';
                dropProc.stderr.on('data', (d) => { dropErr += d.toString(); });
                dropProc.on('error', (e) => sendCatLog(`[CW Key Port] Python pin-drop spawn failed: ${e.code || e.message}`));
                dropProc.on('exit', (code) => {
                  if (code === 0) sendCatLog('[CW Key Port] DTR/RTS dropped via pyserial');
                  else sendCatLog(`[CW Key Port] Python pin-drop exited code ${code}${dropErr ? ': ' + dropErr.split('\n')[0] : ''}`);
                });
              } catch (e) {
                sendCatLog(`[CW Key Port] Python pin-drop threw: ${e.message}`);
              }
              try { port.close(); } catch {}
            } else if (!ioctlErr) {
              sendCatLog(`[CW Key Port] Could not pull DTR/RTS low (${err.message}). ` +
                `If the radio is keying continuously, set OPERATION SETTING -> ` +
                `CAT/LINEAR/TUNER -> USB Keying (CW) = OFF on the radio until this is resolved.`);
            }
          } else {
            console.log(`[CW Key Port] ${label} DTR/RTS dropped`);
          }
        });
      } catch (e) {
        console.log(`[CW Key Port] ${label} pin drop threw: ${e.message}`);
      }
    };
    dropPins('initial');
    // Reassert at 50ms (catches drivers that need a settle delay) and 250ms
    // (catches the case where the kernel re-raises DTR after open completes).
    setTimeout(() => { if (cwKeyPort === port && port.isOpen) dropPins('settle'); }, 50);
    setTimeout(() => { if (cwKeyPort === port && port.isOpen) dropPins('reassert'); }, 250);
    console.log(`[CW Key Port] Opened ${portPath} for DTR keying`);
    sendCatLog(`[CW Key Port] Opened ${portPath} (lazy)`);
    _cwKeyPortEverOpened = true;
  });
  port.on('error', (err) => {
    console.log(`[CW Key Port] Error: ${err.message}`);
  });
  port.on('close', () => {
    console.log(`[CW Key Port] Closed ${portPath}`);
    cwKeyPort = null;
  });
  port.open((err) => {
    if (err) {
      console.log(`[CW Key Port] Open failed: ${err.message}`);
      cwKeyPort = null;
    }
  });
}

function disconnectCwKeyPort() {
  if (!cwKeyPort) return;
  const port = cwKeyPort;
  cwKeyPort = null;
  if (!port.isOpen) return;
  // Wait for the explicit pin-drop to land BEFORE closing — set() and close()
  // race on some Linux drivers and a fire-and-forget set followed by an
  // immediate close left DTR raised (DA2PK report). hupcl:true on the port
  // gives us an OS-level safety net too, but issuing the explicit drop first
  // makes the typical case clean.
  const finishClose = () => { try { port.close(); } catch {} };
  try {
    port.set({ dtr: false, rts: false }, (err) => {
      if (err) console.log(`[CW Key Port] Final pin drop failed: ${err.message}`);
      finishClose();
    });
  } catch (e) {
    console.log(`[CW Key Port] Final pin drop threw: ${e.message}`);
    finishClose();
  }
}

function connectWinKeyer() {
  disconnectWinKeyer();
  if (settings.cwKeyerType !== 'winkeyer' || !settings.winKeyerPort) return;
  winKeyer = new WinKeyer();
  winKeyer.on('connected', ({ version }) => {
    console.log(`[WinKeyer] Connected, version ${version}`);
    if (settings.cwWpm) winKeyer.setSpeed(settings.cwWpm);
    if (settings.wkPttLeadIn) winKeyer.setPttLeadIn(settings.wkPttLeadIn);
    if (settings.wkPttTail) winKeyer.setPttTail(settings.wkPttTail);
    if (win && !win.isDestroyed()) {
      win.webContents.send('cw-keyer-status', { enabled: true, winkeyer: true, version });
    }
  });
  winKeyer.on('disconnected', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('cw-keyer-status', { enabled: false });
    }
  });
  winKeyer.on('echo', ({ char }) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('cw-echo', { char });
    }
  });
  winKeyer.on('busy', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('winkeyer-busy', true);
    }
  });
  winKeyer.on('idle', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('winkeyer-busy', false);
    }
  });
  winKeyer.on('breakin', () => {
    console.log('[WinKeyer] Paddle breakin');
  });
  winKeyer.on('error', (err) => {
    console.log(`[WinKeyer] Error: ${err.message}`);
  });
  winKeyer.connect(settings.winKeyerPort);
}

function disconnectWinKeyer() {
  if (winKeyer) {
    winKeyer.disconnect();
    winKeyer.removeAllListeners();
    winKeyer = null;
  }
}

// Unified CW text send — routes through WinKeyer, SmartSDR, or CAT codec
// Local morse encoder for the "key via DTR pin" text path. Only used when a
// rig model opts in (cw.textMethod === 'dtr-key-port') and a dedicated CW key
// port is open — the radio just sees a hand-key on its CW jack and times the
// elements itself, so this is a reliable fallback when CAT-side KY auto-key
// is unreliable (FT-710 report 2026-04: KY+TX1 sequence enters TX but the
// internal keyer never plays out the buffered text).
const _MORSE_TABLE = {
  'A':'.-','B':'-...','C':'-.-.','D':'-..','E':'.','F':'..-.','G':'--.','H':'....',
  'I':'..','J':'.---','K':'-.-','L':'.-..','M':'--','N':'-.','O':'---','P':'.--.',
  'Q':'--.-','R':'.-.','S':'...','T':'-','U':'..-','V':'...-','W':'.--','X':'-..-',
  'Y':'-.--','Z':'--..','0':'-----','1':'.----','2':'..---','3':'...--','4':'....-',
  '5':'.....','6':'-....','7':'--...','8':'---..','9':'----.','?':'..--..','=':'-...-',
  '/':'-..-.','.':'.-.-.-',',':'--..--','+':'.-.-.','-':'-....-',
};
let _cwDtrSendTimers = []; // outstanding setTimeout ids so a new send can cancel an in-flight one
let _cwDtrEndTimer = null;
// When node-serialport hits ENOTTY on TIOCMSET (Linux cdc_acm), we close our
// handle and remember the port path here so sendCwTextViaPython can take over.
// pyserial uses TIOCMBIS/TIOCMBIC which the same driver accepts, so spawning
// python3 -c "..." per message is a working escape hatch.
let _cwKeyPortPathForPython = null;
let _cwPythonProc = null;
function sendCwTextViaPython(text, wpm) {
  if (!_cwKeyPortPathForPython) return false;
  const cleaned = String(text).toUpperCase().replace(/[^A-Z0-9 /?.=,+\-]/g, '');
  if (!cleaned) return false;
  // Cancel an in-flight Python send so re-sending mid-message starts clean.
  if (_cwPythonProc) {
    try { _cwPythonProc.kill('SIGTERM'); } catch {}
    _cwPythonProc = null;
  }
  const morseJson = JSON.stringify(_MORSE_TABLE);
  const portPath = _cwKeyPortPathForPython.replace(/'/g, "\\'");
  // Inline Python — opens the tty (4800 matches the user's working script;
  // baud is irrelevant for cdc_acm but pyserial requires one), keys via
  // setDTR which uses TIOCMBIS/TIOCMBIC. Always drops DTR in finally so a
  // SIGTERM mid-message can't leave the radio stuck.
  const script =
    'import sys, json, time, serial\n' +
    `port = serial.Serial('${portPath}', 4800)\n` +
    `MORSE = json.loads('${morseJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')\n` +
    `WPM = ${Math.max(5, Math.min(60, wpm | 0)) || 20}\n` +
    'DIT = 1.2 / WPM\n' +
    'DAH = 3 * DIT\n' +
    'try:\n' +
    '    for ch in sys.stdin.read():\n' +
    '        if ch == " ":\n' +
    '            time.sleep(7 * DIT); continue\n' +
    '        if ch not in MORSE: continue\n' +
    '        for sym in MORSE[ch]:\n' +
    '            port.setDTR(True)\n' +
    '            time.sleep(DIT if sym == "." else DAH)\n' +
    '            port.setDTR(False)\n' +
    '            time.sleep(DIT)\n' +
    '        time.sleep(2 * DIT)\n' +
    'finally:\n' +
    '    try: port.setDTR(False)\n' +
    '    except Exception: pass\n' +
    '    port.close()\n';
  const { spawn } = require('child_process');
  try {
    _cwPythonProc = spawn('python3', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    sendCatLog(`[CW] Python fallback spawn failed: ${err.message}. Install python3 + pyserial.`);
    return false;
  }
  _cwPythonProc.on('error', (err) => {
    sendCatLog(`[CW] python3 not available (${err.code || err.message}). Install python3 and pyserial to use CW text-send on this driver.`);
    _cwPythonProc = null;
  });
  let stderr = '';
  _cwPythonProc.stderr.on('data', (d) => { stderr += d.toString(); });
  _cwPythonProc.on('exit', (code) => {
    if (code !== 0) {
      const tip = /no module named serial|ModuleNotFoundError/i.test(stderr)
        ? ' (pyserial not installed — try "pip install pyserial" or your distro\'s python3-pyserial package)'
        : '';
      sendCatLog(`[CW] Python helper exited with code ${code}${tip}${stderr ? ': ' + stderr.split('\n')[0] : ''}`);
    }
    _cwPythonProc = null;
  });
  _cwPythonProc.stdin.write(cleaned);
  _cwPythonProc.stdin.end();
  return true;
}

// Notify phone whether paddle keying actually reaches the radio. Macros
// and text-send go through different code paths (CI-V 0x17, hamlib
// send_morse) and stay enabled regardless — only the iambic-keyer paddle
// is gated by this. Used to suppress phone-side local sidetone when the
// transport reports DTR keying isn't available (e.g. Linux cdc_acm
// rejecting TIOCMSET on the IC-7300's USB tty), so the user doesn't get
// phantom tones with no RF and assume POTACAT is broken (KM4CFT report).
function _setCwPaddleAvailability(available, reason) {
  if (remoteServer && typeof remoteServer.setCwPaddleAvailable === 'function') {
    remoteServer.setCwPaddleAvailable(available, reason);
  }
}

function sendCwTextViaDtrKey(text, wpm, dtrPins) {
  if (!cwKeyPort || !cwKeyPort.isOpen) return false;
  const cleaned = String(text).toUpperCase().replace(/[^A-Z0-9 /?.=,+\-]/g, '');
  if (!cleaned) return false;
  // Cancel any in-flight DTR keying so re-sending mid-message starts clean.
  for (const t of _cwDtrSendTimers) clearTimeout(t);
  _cwDtrSendTimers = [];
  if (_cwDtrEndTimer) { clearTimeout(_cwDtrEndTimer); _cwDtrEndTimer = null; }

  const unitMs = 1200 / Math.max(5, Math.min(60, wpm || 20));
  const pins = dtrPins || { dtr: true };
  const setKey = (down) => {
    if (!cwKeyPort || !cwKeyPort.isOpen) return;
    const state = {};
    if (pins.dtr) state.dtr = !!down;
    if (pins.rts) state.rts = !!down;
    cwKeyPort.set(state, () => {});
  };

  let t = 0;
  for (const ch of cleaned) {
    if (ch === ' ') { t += 4 * unitMs; continue; } // word gap (3 already added after prev char)
    const morse = _MORSE_TABLE[ch];
    if (!morse) continue;
    for (let i = 0; i < morse.length; i++) {
      const dur = (morse[i] === '.' ? 1 : 3) * unitMs;
      const downAt = t;
      const upAt = t + dur;
      _cwDtrSendTimers.push(setTimeout(() => setKey(true), downAt));
      _cwDtrSendTimers.push(setTimeout(() => setKey(false), upAt));
      t = upAt + unitMs; // intra-character gap (1 unit)
    }
    t += 2 * unitMs; // inter-character gap = 3 units total (1 already added)
  }
  // Final safety pulse: force key-up after total duration. Belt-and-suspenders
  // in case the last setKey(false) somehow didn't land (port blip, etc.).
  _cwDtrEndTimer = setTimeout(() => { setKey(false); _cwDtrEndTimer = null; }, t + 100);
  return true;
}

function sendCwTextToRadio(text) {
  if (!text) return;
  const expanded = text.replace(/\{MYCALL\}/gi, settings.myCallsign || '')
    .replace(/\{mycallsign\}/gi, settings.myCallsign || '');
  // Note: {call}, {op_firstname}, {state} are expanded client-side before reaching here
  console.log(`[CW] Text: ${expanded}`);
  // WinKeyer takes priority — it keys the radio directly via hardware output
  if (winKeyer && winKeyer.connected) {
    winKeyer.sendText(expanded);
    return;
  }
  // FlexRadio: ensure active/TX slice is set to POTACAT's slice before sending CW
  if (detectRigType() === 'flex' && smartSdr && smartSdr.connected) {
    const sliceIndex = (settings.catTarget.port || 5002) - 5002;
    smartSdr.setActiveSlice(sliceIndex);
    smartSdr.setTxSlice(sliceIndex);
    smartSdr.sendCwText(expanded);
  }
  // DTR-key-port text path: rig models can opt in via cw.textMethod when
  // their CAT KY auto-key is unreliable. We generate morse locally and pulse
  // the dedicated CW key port — same effect as plugging a straight key into
  // the radio's CW jack, so it bypasses CAT-side keyer quirks entirely.
  const rigModel = getActiveRigModel();
  const cwCaps = rigModel?.cw || {};
  if (cwCaps.textMethod === 'dtr-key-port') {
    const wpm = (cat && cat._cwWpm) || 20;
    // Trigger the lazy open so subsequent text sends in this session use
    // the dedicated key port. This first send falls through to the
    // alternate path (cat.sendCwText) below — acceptable cost vs. the
    // startup-dit it avoids. (WD4DAN.)
    if (!cwKeyPort) ensureCwKeyPortLazyOpen();
    if (cwKeyPort && cwKeyPort.isOpen) {
      if (sendCwTextViaDtrKey(expanded, wpm, cwCaps.dtrPins)) {
        sendCatLog(`[CW] Text via DTR keyer @ ${wpm} wpm: ${expanded}`);
        return;
      }
    } else if (_cwKeyPortPathForPython) {
      // node-serialport's TIOCMSET was rejected on this driver; pyserial uses
      // TIOCMBIS/TIOCMBIC which works on the same device. See dropPins above.
      if (sendCwTextViaPython(expanded, wpm)) {
        sendCatLog(`[CW] Text via Python pyserial fallback @ ${wpm} wpm: ${expanded}`);
        return;
      }
    }
  }
  // Serial CAT (Kenwood/Yaesu/Icom): use KY or CI-V 0x17 command
  if (cat && cat.connected) {
    cat.sendCwText(expanded);
  }
}

function connectRemote() {
  disconnectRemote();
  if (!settings.enableRemote) return;

  remoteServer = new RemoteServer();
  // Surface our package version in the v1 protocol `hello` so connected
  // clients can show "POTACAT desktop 1.5.13" and decide whether to
  // suggest an update.
  try { remoteServer._serverVersion = String(app.getVersion() || ''); } catch {}
  // Hydrate paired-devices list from settings.json. The list survives
  // across desktop restarts; revoking from settings UI removes a device.
  try { remoteServer.setPairedDevices(settings.pairedDevices || []); } catch {}
  // When the server adds or revokes a device, persist the new list.
  remoteServer.on('paired-devices-changed', () => {
    try {
      settings.pairedDevices = remoteServer.exportPairedDevices();
      saveSettings(settings);
      if (win && !win.isDestroyed()) {
        win.webContents.send('echocat-paired-devices', remoteServer.listPairedDevices());
      }
    } catch (err) {
      console.error('[Echo CAT] paired-devices persist failed:', err.message);
    }
  });
  if (settings.colorblindMode) remoteServer.setColorblindMode(true);

  // Surface ECHOCAT lifecycle events (server bind, request errors, client
  // connect/disconnect) into the Verbose log so users can tell whether
  // their phone is reaching the desktop. Until v1.5.7 these were
  // console.log only, which is invisible in installed builds — Walt KK4DF
  // and Jonathan KM4CFT reported "Page does not load. Nothing in Verbose
  // log." in v1.5.7 with no further information possible.
  remoteServer.on('log', (msg) => sendCatLog('[Echo CAT] ' + msg));

  remoteServer.on('tune', ({ freqKhz, mode, bearing }) => {
    console.log('[Echo CAT] Tune request:', freqKhz, 'kHz, mode:', mode || '(keep)');
    // Only clear XIT for manual freq entry (no mode); apply CW XIT for spot clicks
    tuneRadio(freqKhz, mode, bearing, { clearXit: !mode });
    // Auto-tune KiwiSDR
    if (kiwiActive && kiwiClient && kiwiClient.connected && freqKhz > 100) {
      const m = (mode || _currentMode || 'USB').toLowerCase().replace('digu', 'usb').replace('digl', 'lsb').replace('pktusb', 'usb').replace('pktlsb', 'lsb').replace('ft8', 'usb').replace('ft4', 'usb').replace('ssb', freqKhz >= 10000 ? 'usb' : 'lsb');
      sendCatLog(`[WebSDR] Auto-tune: ${freqKhz} kHz mode=${m}`);
      kiwiClient.tune(freqKhz, m);
    }
    // Force TX to the tuned slice (Flex multi-slice: user may have TX on a different slice)
    if (smartSdr && smartSdr.connected && settings.catTarget && settings.catTarget.type === 'tcp') {
      const sliceIndex = (settings.catTarget.port || 5002) - 5002;
      smartSdr.setTxSlice(sliceIndex);
    }
  });

  remoteServer.on('ptt', ({ state }) => {
    handleRemotePtt(state);
  });

  remoteServer.on('client-connected', () => {
    broadcastRemoteRadioStatus();
    // Send current source toggles to phone
    remoteServer.sendSourcesToClient({
      pota: settings.enablePota !== false,
      sota: settings.enableSota === true,
      wwff: settings.enableWwff === true,
      llota: settings.enableLlota === true,
      tiles: settings.enableTiles !== false,
      cluster: settings.enableCluster === true,
    });
    // Send rig list so phone can switch rigs
    const rigs = (settings.rigs || []).map(r => ({ id: r.id, name: r.name }));
    remoteServer.sendRigsToClient(rigs, settings.activeRigId || null);
    // Push activator state
    pushActivatorStateToPhone();
    // Send worked parks for new-to-me filter
    if (workedParks.size > 0) {
      remoteServer.sendWorkedParks([...workedParks.keys()]);
    }
    // Send worked QSOs for worked-spot display
    if (workedQsos.size > 0) {
      remoteServer.sendWorkedQsos([...workedQsos.entries()]);
    }
    // Restore saved ECHOCAT filters (bands, modes, regions, sort, etc.)
    if (settings.echoFilters) {
      remoteServer.sendFiltersToClient(settings.echoFilters);
    }
    // FreeDV enabled state
    remoteServer.sendToClient({ type: 'freedv-enabled', enabled: !!settings.enableFreedv });
    // JTCAT Tune + Auto Seq state (Gap 11 + Gap 12, 2026-05-04) — phone
    // FT8 screen renders these controls and needs to reflect current
    // server state on reconnect. Tune state defaults to {active:false}
    // when nothing's running; auto-seq defaults to true.
    {
      const remaining = jtcatTuneState.active
        ? Math.max(0, Math.ceil((jtcatTuneState.endsAt - Date.now()) / 1000))
        : 0;
      remoteServer.sendToClient({ type: 'jtcat-tune-state', active: jtcatTuneState.active, secondsRemaining: remaining });
    }
    {
      const eng = (jtcatManager && jtcatManager.txEngine) || ft8Engine;
      const enabled = !eng || eng._autoSeq !== false;
      remoteServer.sendToClient({ type: 'jtcat-auto-seq-state', enabled });
    }
    // VFO Profiles — send current list so phone's profiles widget can render
    // immediately. Phone edits push back via 'vfo-profiles-update'.
    remoteServer.sendVfoProfiles(settings.vfoProfiles || []);
    // Sync voice macros to phone
    ensureVoiceMacroDir();
    const vmLabels = settings.voiceMacroLabels || [];
    for (let i = 0; i < 5; i++) {
      const p = voiceMacroPath(i);
      if (fs.existsSync(p)) {
        const audio = fs.readFileSync(p).toString('base64');
        remoteServer.sendToClient({ type: 'voice-macro-sync', idx: i, label: vmLabels[i] || '', audio });
      }
    }
    if (vmLabels.length) remoteServer.sendToClient({ type: 'voice-macro-labels', labels: vmLabels });

    // TunerGenius status (labels + active antenna)
    if (tgxlClient && tgxlClient.connected) {
      const labels = settings.tgxlLabels || {};
      remoteServer.sendToClient({ type: 'tgxl-status', antenna: tgxlClient.antenna, connected: true, labels });
    }
    // Push settings needed by phone (callsign, grid, respot defaults, cluster state)
    updateRemoteSettings();
    if (win && !win.isDestroyed()) {
      win.webContents.send('remote-status', { connected: true });
    }
  });

  remoteServer.on('client-disconnected', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('remote-status', { connected: false });
    }
    // Stop JTCAT engine FIRST — prevents new TX audio from being generated
    if (ft8Engine) {
      stopJtcat();
      if (win && !win.isDestroyed()) win.webContents.send('jtcat-stop-for-remote');
      console.log('[JTCAT] Phone disconnected — engine stopped, audio released');
    }
    remoteJtcatQso = null;
    // Destroy audio window to stop all outgoing audio (prevents VOX trigger)
    destroyRemoteAudioWindow();
    // Clear SSB-over-DATA state so handleRemotePtt doesn't try to restore mode
    _ssbModeBeforePtt = null;
    // ALWAYS force RX on disconnect — critical safety to prevent stuck TX
    // (FT8 may use VOX, PTT state tracking can be stale, radio may be mid-cycle)
    handleRemotePtt(false);
    // CW safety: ensure PTT released on disconnect (keyer.stop() is handled in RemoteServer)
    const rigType = detectRigType();
    if (rigType === 'flex' && smartSdr && smartSdr.connected) {
      smartSdr.cwPttRelease();
    }
    // Force CW key port DTR low (key up) on disconnect
    if (cwKeyPort && cwKeyPort.isOpen) {
      cwKeyPort.set({ dtr: false }, () => {});
    }
    // Delayed safety TX-off: catches VOX re-trigger from audio artifacts during teardown,
    // and any race conditions from FT8 engine shutdown
    setTimeout(() => {
      if (cat && cat.connected) cat.setTransmit(false);
      if (smartSdr && smartSdr.connected) smartSdr.setTransmit(false);
    }, 500);
    setTimeout(() => {
      if (cat && cat.connected) cat.setTransmit(false);
      if (smartSdr && smartSdr.connected) smartSdr.setTransmit(false);
    }, 2000);
  });

  // CW keyer output: route IambicKeyer key events to radio
  let _cwPollResumeTimer = null;
  let _cwKeyLoggedRoute = false;
  remoteServer.setCwKeyerOutput(({ down }) => {
    // FlexRadio via SmartSDR TCP API — only when Flex is the active CAT rig
    if (detectRigType() === 'flex' && smartSdr && smartSdr.connected) {
      if (down) {
        smartSdr.cwPttOn();
      }
      smartSdr.cwKey(down);
    }
    // Serial CAT keying — method depends on radio model
    const rigType = detectRigType();
    const rigModel = getActiveRigModel();
    const cwCaps = rigModel?.cw || {};
    if (cat && cat.connected && rigType !== 'flex') {
      // Pause polling so commands don't interleave with CW keying
      if (down) {
        if (_cwPollResumeTimer) { clearTimeout(_cwPollResumeTimer); _cwPollResumeTimer = null; }
        cat.pausePolling();
      } else {
        // Resume polling 1.5s after last key-up
        if (_cwPollResumeTimer) clearTimeout(_cwPollResumeTimer);
        _cwPollResumeTimer = setTimeout(() => {
          _cwPollResumeTimer = null;
          cat.resumePolling();
        }, 1500);
      }
      // Lazy-open the dedicated CW Key Port (if configured) on the first
      // paddle event of the session. Originally gated on `paddleKey === 'dtr'`
      // models (Icom-style USB-A DTR keying) but rigctld users with a Yaesu
      // FTDx10 (`paddleKey: 'txrx'`) ALSO need a dedicated key port to do
      // paddle CW at all — see rigctld branch below — so always try the lazy
      // open. If they don't have one configured, ensureCwKeyPortLazyOpen()
      // is a no-op.
      if (down && !cwKeyPort) {
        ensureCwKeyPortLazyOpen();
      }
      // Rigctld has no per-element CW keying command — its "T 1"/"T 0" only
      // toggles the mic PTT line, so the radio TX-keys with zero CW output
      // (KM4CFT IC-7300 MK II via rigctld, 2026-04-23). The dedicated CW Key
      // Port path below DOES work over rigctld (it uses node-serialport DTR
      // directly, bypassing rigctld). So skip the cat-side keying for
      // rigctld users but fall through to the cwKeyPort handler.
      const isRigctld = settings.catTarget && settings.catTarget.type === 'rigctld';
      if (isRigctld) {
        const dedicatedAvail = cwKeyPort && cwKeyPort.isOpen;
        if (!_cwKeyLoggedRoute) {
          _cwKeyLoggedRoute = true;
          if (dedicatedAvail) {
            sendCatLog('[CW] Rigctld backend can\'t key per-element — paddle keying via dedicated CW Key Port (DTR) instead.');
          } else {
            sendCatLog('[CW] Paddle keying is not supported over rigctld — hamlib has no per-element CW keying command, only mic PTT (T 1/T 0). The radio would TX with no CW output. ' +
              'Workarounds: (1) type text in the CW widget\'s text box — that uses hamlib\'s send_morse and works correctly; (2) wire an external USB-UART (FTDI / CH340) to the rig\'s CW KEY jack and set it as "CW Key Port" in Settings → Rig.');
            // Tell the phone its paddle won\'t make RF — suppresses local
            // sidetone and shows a red banner with the workaround. G5HOW
            // FTDx10 + Hamlib v1.5.11 2026-04-30.
            _setCwPaddleAvailability(false, 'rigctld-no-per-element-cw');
          }
        }
        // Skip the cat-side keying methods. Fall through to the cwKeyPort
        // block at the bottom of the callback — it handles the real keying.
      } else {
      // Route keying based on model's preferred paddle method
      // Icom default: txrx (CI-V PTT 0x1C) — universal, no DTR config needed
      // Models with DTR keying support can override via cw.paddleKey: 'dtr'
      let paddleMethod = cwCaps.paddleKey || 'txrx';
      // DTR keying without a dedicated CW key port: fall back to toggling DTR on
      // the main CAT serial port. This is what the radio's "USB Keying (CW) = USB(A) DTR"
      // menu actually reads, and it produces real RF rather than silent PTT.
      // Falling back to txrx would send CI-V 0x1C 0x00 (PTT only) — on an IC-7300 that
      // keys the transmitter with no CW output (KM4CFT, 2026-04-21).
      if (paddleMethod === 'dtr' && !(cwKeyPort && cwKeyPort.isOpen)) {
        paddleMethod = 'main-dtr';
      }
      if (!_cwKeyLoggedRoute) {
        _cwKeyLoggedRoute = true;
        sendCatLog(`[CW] Keying route: ${paddleMethod}${cwKeyPort && cwKeyPort.isOpen ? ' + dedicated key port' : ''} (model: ${rigModel?.brand || '?'})`);
        // Actionable hint when we're toggling DTR on the main CAT port — a
        // very common "radio doesn't key" gotcha is the rig menu not being
        // set to read DTR. (KQ3Q on IC-7300.)
        if (paddleMethod === 'main-dtr') {
          const brand = (rigModel?.brand || '').toLowerCase();
          let hint;
          if (brand === 'icom') {
            hint = 'IC-7300/705/7610: SET > Connectors > USB SEND = DTR (or USB Keying (CW) = USB(A) DTR).';
          } else if (brand === 'yaesu') {
            hint = 'Yaesu: OPERATION SETTING > TUNING > CAT PORT setup + CW KEYING source = DTR.';
          } else if (brand === 'kenwood') {
            hint = 'Kenwood: Menu > PC Port / USB > CW Keying = DTR.';
          } else {
            hint = 'Check your rig menu — "USB Keying (CW) = DTR" (or equivalent) must be set or the DTR pulses POTACAT sends will not key the radio.';
          }
          sendCatLog(`[CW] If the radio isn't keying, verify the rig menu: ${hint}`);
        }
      }
      if (paddleMethod === 'dtr') {
        // Dedicated CW Key Port is handling DTR — skip main CAT port
      } else if (paddleMethod === 'main-dtr') {
        // Toggle DTR/RTS on the main CAT serial port (no second adapter).
        // Requires the radio's "USB Keying (CW)" menu to be set to USB(A) DTR/RTS.
        // On Linux cdc_acm radios this fails silently — the transport emits
        // 'pin-unsupported' on first try and we drop phone-side sidetone via
        // _setCwPaddleAvailability(false). Subsequent calls here are no-ops
        // since rig-controller latches `_dtrUnsupported` after the first error.
        if (cat.setCwKeyDtr) cat.setCwKeyDtr(down, cwCaps.dtrPins || { dtr: true });
      } else if (paddleMethod === 'ta' && cwCaps.taKey) {
        cat.setCwKeyTa(down);
      } else {
        cat.setCwKeyTxRx(down);
      }
      } // end non-rigctld branch
    }
    // Dedicated CW Key Port — DTR/RTS keying via external USB-serial adapter or QMX second port
    if (cwKeyPort && cwKeyPort.isOpen) {
      // Use dtrPins from rig model: { dtr: true, rts: true } for QMX, { dtr: true } for most others
      const pins = cwCaps.dtrPins || { dtr: true };
      const pinState = {};
      if (pins.dtr) pinState.dtr = !!down;
      if (pins.rts) pinState.rts = !!down;
      cwKeyPort.set(pinState, (err) => {
        if (err && !cwKeyPort._dtrLoggedError) {
          console.log(`[CW Key Port] Pin set error: ${err.message} (pins: ${JSON.stringify(pinState)})`);
          cwKeyPort._dtrLoggedError = true; // log once, don't spam
        }
      });
    }
  });

  // CW config changes from phone (WPM)
  remoteServer.on('cw-config', ({ wpm }) => {
    if (winKeyer && winKeyer.connected) winKeyer.setSpeed(wpm);
    if (detectRigType() === 'flex' && smartSdr && smartSdr.connected) {
      smartSdr.setCwSpeed(wpm);
    }
    // Also set KS on serial CAT (QMX etc.)
    if (cat && cat.connected) {
      cat.setCwSpeed(wpm);
    }
  });

  // CW text macros/freeform from phone — route to radio
  remoteServer.on('cw-text', ({ text }) => {
    if (!text) return;
    sendCwTextToRadio(text);
  });

  // Phone updated the VFO profile list — single source of truth is
  // `settings.vfoProfiles`. Save, then echo back to BOTH the phone (so its
  // local list is the canonical persisted version) and the desktop VFO
  // popout (live refresh of its inline list + Profiles tab).
  remoteServer.on('vfo-profiles-update', ({ profiles }) => {
    settings.vfoProfiles = Array.isArray(profiles) ? profiles : [];
    saveSettings(settings);
    remoteServer.sendVfoProfiles(settings.vfoProfiles);
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) {
      vfoPopoutWin.webContents.send('vfo-profiles-changed', settings.vfoProfiles);
    }
    // Also nudge the main window's renderer in case it's holding a stale
    // copy in memory (Settings panel etc.).
    if (win && !win.isDestroyed()) {
      win.webContents.send('vfo-profiles-changed', settings.vfoProfiles);
    }
    console.log(`[VFO Profiles] Phone updated list — ${settings.vfoProfiles.length} profile(s)`);
  });

  // Phone tapped a profile — apply freq + mode + filter through the same
  // code path the desktop popout uses (existing `tune` handler + filter
  // setter), but bundled so the phone doesn't have to ship three messages.
  remoteServer.on('apply-vfo-profile', ({ profile }) => {
    if (!profile || !profile.freqKhz) return;
    const freqHz = profile.freqKhz * 1000;
    if (cat && cat.connected) {
      cat.tune(freqHz, profile.mode || _currentMode);
      if (profile.filterWidth && cat.setFilterWidth) {
        cat.setFilterWidth(profile.filterWidth);
      }
    }
    // Mirror to the desktop popout so its label/dial reflect the new state.
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) {
      vfoPopoutWin.webContents.send('vfo-profile-applied', profile);
    }
    console.log(`[VFO Profiles] Phone applied "${profile.name || ''}" — ${profile.freqKhz} kHz ${profile.mode || ''}`);
  });

  // Phone requests to toggle remote CW on/off
  remoteServer.on('cw-enable-request', ({ enabled }) => {
    settings.remoteCwEnabled = !!enabled;
    saveSettings(settings);
    remoteServer.setCwEnabled(!!enabled);
    if (enabled && smartSdr) {
      smartSdr.setNeedsCw(true);
    }
    // Notify desktop UI
    if (win && !win.isDestroyed()) {
      win.webContents.send('settings-changed', { remoteCwEnabled: !!enabled });
    }
    console.log(`[Echo CAT] Remote CW ${enabled ? 'enabled' : 'disabled'} by phone`);
  });

  // Phone updated custom CAT buttons — save to settings and sync desktop
  remoteServer.on('save-custom-cat-buttons', (buttons) => {
    settings.customCatButtons = buttons;
    saveSettings(settings);
    if (win && !win.isDestroyed()) {
      win.webContents.send('reload-prefs');
    }
    console.log('[Echo CAT] Custom CAT buttons updated from phone');
  });

  // ── Cloud Sync via ECHOCAT ──────────────────────────────────────
  remoteServer.on('cloud-login', async (msg, reply) => {
    const result = await ipcMain.handle('cloud-login', null, msg.email, msg.password).catch(e => ({ error: e.message }));
    // IPC handles are already registered, invoke them directly
    reply(result || { error: 'No handler' });
  });

  // Bridge ECHOCAT cloud messages to the existing IPC handlers
  const cloudBridge = (event, handler) => {
    remoteServer.on(event, async (...args) => {
      const reply = args[args.length - 1]; // last arg is always the reply callback
      try {
        const result = await handler(...args.slice(0, -1));
        reply(result);
      } catch (err) {
        reply({ error: err.message });
      }
    });
  };

  // Remove the direct handler above and use the bridge pattern for all cloud events
  remoteServer.removeAllListeners('cloud-login');
  cloudBridge('cloud-login', async (msg) => {
    if (!cloudIpc) return { error: 'Cloud not initialized' };
    const sync = cloudIpc.getCloudSync();
    const deviceId = (() => { if (!settings.cloudDeviceId) { settings.cloudDeviceId = require('crypto').randomUUID(); saveSettings(settings); } return settings.cloudDeviceId; })();
    const result = await sync._post('/v1/auth/login', { email: msg.email, password: msg.password, deviceId }, true);
    settings.cloudAccessToken = result.accessToken;
    settings.cloudRefreshToken = result.refreshToken;
    settings.cloudUser = result.user;
    saveSettings(settings);
    return { success: true, user: result.user };
  });

  cloudBridge('cloud-register', async (msg) => {
    if (!cloudIpc) return { error: 'Cloud not initialized' };
    const sync = cloudIpc.getCloudSync();
    const deviceId = (() => { if (!settings.cloudDeviceId) { settings.cloudDeviceId = require('crypto').randomUUID(); saveSettings(settings); } return settings.cloudDeviceId; })();
    const result = await sync._post('/v1/auth/register', { email: msg.email, password: msg.password, callsign: msg.callsign, displayName: msg.callsign, deviceId }, true);
    settings.cloudAccessToken = result.accessToken;
    settings.cloudRefreshToken = result.refreshToken;
    settings.cloudUser = result.user;
    saveSettings(settings);
    return { success: true, user: result.user };
  });

  cloudBridge('cloud-logout', async () => {
    if (settings.cloudRefreshToken) {
      try {
        const sync = cloudIpc.getCloudSync();
        await sync._post('/v1/auth/logout', { refreshToken: settings.cloudRefreshToken }, true);
      } catch {}
    }
    settings.cloudAccessToken = null;
    settings.cloudRefreshToken = null;
    settings.cloudUser = null;
    settings.cloudLastSyncTimestamp = null;
    settings.cloudLastSyncAt = null;
    saveSettings(settings);
    return { success: true };
  });

  cloudBridge('cloud-get-status', async () => {
    if (!settings.cloudAccessToken) return { loggedIn: false };
    return {
      loggedIn: true,
      user: settings.cloudUser,
      lastSyncAt: settings.cloudLastSyncAt,
      pendingChanges: cloudIpc ? cloudIpc.journal.length : 0,
      sync: {
        totalQsos: settings.cloudTotalQsos ?? null,
        deviceCount: settings.cloudDeviceCount ?? null,
      },
    };
  });

  cloudBridge('cloud-sync-now', async () => {
    if (!cloudIpc) return { error: 'Cloud not initialized' };
    const sync = cloudIpc.getCloudSync();
    const result = await sync.sync(cloudIpc.journal, {
      onPulled: () => {},
      onConflicts: () => {},
    });
    settings.cloudLastSyncAt = new Date().toISOString();
    if (sync.lastSyncTimestamp) settings.cloudLastSyncTimestamp = sync.lastSyncTimestamp;
    if (result.totalQsos != null) settings.cloudTotalQsos = result.totalQsos;
    if (result.deviceCount != null) settings.cloudDeviceCount = result.deviceCount;
    saveSettings(settings);
    return { success: true, pushed: result.pushed, pulled: result.pulled };
  });

  cloudBridge('cloud-bulk-upload', async () => {
    if (!cloudIpc) return { error: 'Cloud not initialized' };
    const { parseAllRawQsos } = require('./lib/adif');
    const { rewriteAdifFile } = require('./lib/adif-writer');
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    const allQsos = parseAllRawQsos(logPath);
    let needsRewrite = false;
    for (const qso of allQsos) {
      if (!qso.APP_POTACAT_UUID) {
        qso.APP_POTACAT_UUID = require('crypto').randomUUID();
        qso.APP_POTACAT_VERSION = '1';
        needsRewrite = true;
      }
    }
    if (needsRewrite) rewriteAdifFile(logPath, allQsos);
    const sync = cloudIpc.getCloudSync();
    const result = await sync.bulkUpload(allQsos.map(f => ({ uuid: f.APP_POTACAT_UUID, adifFields: f })));
    cloudIpc.journal.clear();
    settings.cloudLastSyncAt = new Date().toISOString();
    saveSettings(settings);
    return { success: true, imported: result.imported, duplicates: result.duplicates, total: allQsos.length };
  });

  cloudBridge('cloud-verify-subscription', async () => {
    if (!cloudIpc) return { error: 'Cloud not initialized' };
    const sync = cloudIpc.getCloudSync();
    return await sync.verifySubscription();
  });

  cloudBridge('cloud-save-bmac-email', async (bmacEmail) => {
    if (!cloudIpc) return { error: 'Cloud not initialized' };
    settings.cloudBmacEmail = bmacEmail;
    saveSettings(settings);
    const sync = cloudIpc.getCloudSync();
    return await sync._authedRequest('POST', '/v1/subscription/set-bmac-email', { bmacEmail });
  });

  // Enable remote CW if setting is on
  if (settings.remoteCwEnabled) {
    remoteServer.setCwEnabled(true);
    if (smartSdr) smartSdr.setNeedsCw(true);
  }

  // Dedicated CW Key Port — opens lazily on first CW activity rather
  // than at app startup. Opening a serial port asserts DTR at the OS
  // level for ~5–50 ms before our user-space drop runs; on a radio with
  // "USB Keying (CW) = DTR" set in the menu, that brief assertion sends
  // a spurious dit on the air every time POTACAT launches. (WD4DAN
  // report 2026-04-28.) Lazy open moves the unavoidable pulse into the
  // moment the operator is already intentionally keying, where it
  // merges into their first dit instead of being a surprise.

  remoteServer.on('set-sources', (sources) => {
    if (!sources) return;
    const map = { pota: 'enablePota', sota: 'enableSota', wwff: 'enableWwff', llota: 'enableLlota', tiles: 'enableTiles', cluster: 'enableCluster' };
    const newSettings = {};
    for (const [key, settingKey] of Object.entries(map)) {
      if (key in sources) newSettings[settingKey] = !!sources[key];
    }
    // Save and apply — same as settings dialog save
    Object.assign(settings, newSettings);
    saveSettings(settings);
    // Sync desktop UI — reload prefs so spots dropdown matches
    if (win && !win.isDestroyed()) {
      win.webContents.send('reload-prefs');
    }
    // Reconnect cluster if toggled
    if ('enableCluster' in newSettings) {
      if (newSettings.enableCluster) connectCluster(); else disconnectCluster();
    }
    // Refresh spots with new sources
    refreshSpots();
    console.log('[Echo CAT] Sources updated:', newSettings);
  });

  remoteServer.on('set-echo-filters', (filters) => {
    if (!filters) return;
    settings.echoFilters = filters;
    saveSettings(settings);
  });

  remoteServer.on('switch-rig', ({ rigId }) => {
    const rig = (settings.rigs || []).find(r => r.id === rigId);
    if (!rig) return;
    settings.activeRigId = rig.id;
    settings.catTarget = rig.catTarget;
    settings.remoteAudioInput = rig.remoteAudioInput || '';
    settings.remoteAudioOutput = rig.remoteAudioOutput || '';
    // Per-rig CW key port
    if (rig.cwKeyPort !== undefined) {
      settings.cwKeyPort = rig.cwKeyPort || '';
      connectCwKeyPort();
    }
    saveSettings(settings);
    if (!settings.enableWsjtx) connectCat();
    connectSmartSdr();
    // Restart audio bridge with new rig's audio devices
    if (remoteAudioWin && !remoteAudioWin.isDestroyed()) {
      startRemoteAudio();
    }
    // Sync desktop UI
    if (win && !win.isDestroyed()) {
      win.webContents.send('reload-prefs');
    }
    // Track active rig for club schedule advisory
    if (remoteServer._clubMode) remoteServer._activeRigId = rig.id;
    // Confirm back to phone
    const rigs = (settings.rigs || []).map(r => ({ id: r.id, name: r.name }));
    remoteServer.sendRigsToClient(rigs, rig.id);
    console.log('[Echo CAT] Switched rig to:', rig.name);
  });

  // --- Rig controls (filter, NB, VFO) ---
  // Helper: true if SmartSDR API is available for rig control commands
  function flexSdr() { return smartSdr && smartSdr.connected; }

  function applyFilter(width) {
    if (flexSdr()) {
      const m = (_currentMode || '').toUpperCase();
      let lo, hi;
      if (m === 'CW') {
        lo = Math.max(0, 600 - Math.round(width / 2));
        hi = 600 + Math.round(width / 2);
      } else {
        lo = 100;
        hi = 100 + width;
      }
      smartSdr.setSliceFilter(0, lo, hi);
    } else if (cat && cat.connected) {
      cat.setFilterWidth(width);
    }
    _currentFilterWidth = width;
    broadcastRigState();
  }

  remoteServer.on('set-filter', ({ width }) => {
    if (!width || width <= 0) return;
    applyFilter(width);
    console.log('[Echo CAT] Set filter width:', width, 'Hz');
  });

  remoteServer.on('filter-step', ({ direction }) => {
    const presets = getFilterPresets(_currentMode);
    let idx = findNearestPreset(presets, _currentFilterWidth);
    if (direction === 'wider' && idx < presets.length - 1) idx++;
    else if (direction === 'narrower' && idx > 0) idx--;
    applyFilter(presets[idx]);
    console.log('[Echo CAT] Filter step:', direction, '->', presets[idx], 'Hz');
  });

  remoteServer.on('set-nb', ({ on }) => {
    if (flexSdr()) {
      smartSdr.setSliceNb(0, on);
    } else if (cat && cat.connected) {
      cat.setNb(on);
    }
    _currentNbState = on;
    broadcastRigState();
    console.log('[Echo CAT] NB:', on ? 'ON' : 'OFF');
  });

  remoteServer.on('set-atu', ({ on }) => {
    if (flexSdr()) {
      smartSdr.setAtu(on);
    } else if (cat && cat.connected) {
      if (on) cat.startTune();
      else cat.stopTune();
    }
    _currentAtuState = on;
    broadcastRigState();
    console.log('[Echo CAT] ATU:', on ? 'ON' : 'OFF');
  });

  remoteServer.on('set-vfo', ({ vfo }) => {
    if (flexSdr()) {
      smartSdr.setActiveSlice(vfo === 'B' ? 1 : 0);
    } else if (cat && cat.connected) {
      cat.setVfo(vfo);
    }
    _currentVfo = vfo;
    broadcastRigState();
    console.log('[Echo CAT] VFO:', vfo);
  });

  remoteServer.on('swap-vfo', () => {
    const rigType = detectRigType();
    const newVfo = _currentVfo === 'A' ? 'B' : 'A';
    if (rigType === 'yaesu' && cat && cat.connected) {
      cat.swapVfo();
    } else if (flexSdr()) {
      smartSdr.setActiveSlice(newVfo === 'B' ? 1 : 0);
    } else if (cat && cat.connected) {
      cat.setVfo(newVfo);
    }
    _currentVfo = newVfo;
    broadcastRigState();
    console.log('[Echo CAT] Swap VFO ->', newVfo);
  });

  // RF Gain from ECHOCAT — debounce to avoid serial command flooding and feedback loops
  let _rfGainTimer = null;
  remoteServer.on('set-rfgain', ({ value }) => {
    _currentRfGain = value;
    _rfGainSuppressBroadcast = Date.now() + 500; // suppress echo-back for 500ms
    // Debounce the actual radio command (50ms)
    if (_rfGainTimer) clearTimeout(_rfGainTimer);
    _rfGainTimer = setTimeout(() => {
      _rfGainTimer = null;
      if (flexSdr()) {
        const dB = (value * 0.3) - 10;
        smartSdr.setRfGain(0, dB);
      } else if (cat && cat.connected) {
        const rigType = detectRigType();
        if (rigType === 'rigctld') cat.setRfGain(value / 100);
        else cat.setRfGain(value);
      }
    }, 50);
    // Update desktop UI immediately (not ECHOCAT — suppress echo)
    if (win && !win.isDestroyed()) win.webContents.send('rig-state', {
      nb: _currentNbState, rfGain: _currentRfGain, txPower: _currentTxPower,
      filterWidth: _currentFilterWidth, atuActive: _currentAtuState, mode: _currentMode,
      capabilities: getRigCapabilities(detectRigType()),
    });
  });

  // TX Power from ECHOCAT — debounce to avoid serial command flooding and feedback loops
  let _txPowerTimer = null;
  remoteServer.on('set-txpower', ({ value }) => {
    _currentTxPower = value;
    _txPowerSuppressBroadcast = Date.now() + 500;
    if (_txPowerTimer) clearTimeout(_txPowerTimer);
    _txPowerTimer = setTimeout(() => {
      _txPowerTimer = null;
      if (flexSdr()) {
        smartSdr.setTxPower(value);
      } else if (cat && cat.connected) {
        const rigType = detectRigType();
        if (rigType === 'rigctld') cat.setTxPower(value / 100);
        else cat.setTxPower(value);
      }
    }, 50);
    if (win && !win.isDestroyed()) win.webContents.send('rig-state', {
      nb: _currentNbState, rfGain: _currentRfGain, txPower: _currentTxPower,
      filterWidth: _currentFilterWidth, atuActive: _currentAtuState, mode: _currentMode,
      capabilities: getRigCapabilities(detectRigType()),
    });
  });

  // Audio device enumeration and selection from ECHOCAT
  remoteServer.on('get-audio-devices', async () => {
    try {
      const devices = await win.webContents.executeJavaScript(`
        navigator.mediaDevices.enumerateDevices().then(d =>
          d.filter(x => x.kind === 'audioinput' || x.kind === 'audiooutput')
           .map(x => ({ deviceId: x.deviceId, label: x.label || x.deviceId.slice(0, 20), kind: x.kind }))
        )
      `);
      const current = {
        input: settings.remoteAudioInput || '',
        output: settings.remoteAudioOutput || '',
      };
      remoteServer.sendToClient({ type: 'audio-devices', devices, current });
    } catch (err) {
      console.error('[Echo CAT] Failed to enumerate audio devices:', err.message);
    }
  });

  remoteServer.on('set-audio-device', ({ kind, deviceId }) => {
    if (kind === 'input') {
      settings.remoteAudioInput = deviceId;
    } else if (kind === 'output') {
      settings.remoteAudioOutput = deviceId;
    }
    saveSettings(settings);
    // Restart remote audio to apply new device (destroy, phone will re-initiate)
    destroyRemoteAudioWindow();
    sendCatLog(`[Audio] ${kind} device changed to: ${deviceId || '(default)'}`);
    // Update desktop UI
    if (win && !win.isDestroyed()) win.webContents.send('reload-prefs');
  });

  // QRZ lookup from ECHOCAT (for CW macro {op_firstname})
  remoteServer.on('qrz-lookup', async ({ callsign }) => {
    if (!callsign || !qrz.configured || !settings.enableQrz) {
      remoteServer.sendToClient({ type: 'qrz-result', callsign, fname: '', state: '' });
      return;
    }
    try {
      const data = await qrz.lookup(callsign);
      const fname = data ? (data.nickname || data.fname || '') : '';
      const state = data ? (data.state || '') : '';
      remoteServer.sendToClient({ type: 'qrz-result', callsign, fname, state });
    } catch {
      remoteServer.sendToClient({ type: 'qrz-result', callsign, fname: '', state: '' });
    }
  });

  // --- External ATU (LDG Z-100plus, MFJ, other RF-sensing tuners) ---
  // These tuners have no CAT — they sense carrier on the feedline and match
  // autonomously. We emit a low-power CW carrier so the tuner has something
  // to detect, then restore the rig's previous mode and power.
  let _externalAtuActive = false;
  let _externalAtuCancel = false;
  async function runExternalAtuTune() {
    if (_externalAtuActive) return true; // already running
    const activeRig = (settings.rigs || []).find(r => r.id === settings.activeRigId);
    if (!activeRig || activeRig.externalAtu !== 'rf-sense') return false;
    if (!cat || !cat.connected) {
      sendCatLog('[ExtATU] CAT not connected — cannot trigger external tuner');
      return true;
    }
    const watts = Math.max(5, Math.min(25, parseInt(activeRig.externalAtuWatts, 10) || 10));
    const seconds = Math.max(1, Math.min(15, parseFloat(activeRig.externalAtuSeconds) || 4));
    _externalAtuActive = true;
    _externalAtuCancel = false;
    const restoreMode = _currentMode || 'USB';
    const restorePower = _currentTxPower > 0 ? _currentTxPower : (settings.defaultPower || 100);
    sendCatLog(`[ExtATU] Firing ${watts} W CW carrier for ${seconds}s (mode ${restoreMode} → CW, power ${restorePower}W → ${watts}W)`);
    if (win && !win.isDestroyed()) win.webContents.send('external-atu-start', { seconds });
    try {
      if (cat.setModeOnly) cat.setModeOnly('CW', _currentFreqHz);
      else if (cat.setMode) cat.setMode('CW');
      cat.setTxPower(watts);
      await new Promise(r => setTimeout(r, 300));
      if (_externalAtuCancel) throw new Error('cancelled');
      cat.setTransmit(true);
      // Wait in ~250ms slices so cancel can interrupt mid-burst
      const endAt = Date.now() + seconds * 1000;
      while (Date.now() < endAt) {
        if (_externalAtuCancel) break;
        await new Promise(r => setTimeout(r, 250));
      }
      cat.setTransmit(false);
    } catch (err) {
      try { cat.setTransmit(false); } catch {}
      sendCatLog(`[ExtATU] ${err.message}`);
    } finally {
      await new Promise(r => setTimeout(r, 200));
      try {
        if (cat.setModeOnly) cat.setModeOnly(restoreMode, _currentFreqHz);
        else if (cat.setMode) cat.setMode(restoreMode);
        cat.setTxPower(restorePower);
      } catch {}
      _externalAtuActive = false;
      _externalAtuCancel = false;
      sendCatLog('[ExtATU] Tune complete — restored mode and power');
      if (win && !win.isDestroyed()) win.webContents.send('external-atu-complete');
    }
    return true;
  }
  ipcMain.on('external-atu-cancel', () => { _externalAtuCancel = true; });

  // Unified rig-control from ECHOCAT phone (same dispatch as desktop IPC)
  remoteServer.on('rig-control', (data) => {
    if (!data || !data.action) return;
    const rigType = detectRigType();
    const flexNeedsApi = rigType === 'flex' && !flexSdr();
    switch (data.action) {
      case 'set-nb': {
        const on = !!data.value;
        if (flexSdr()) smartSdr.setSliceNb(0, on);
        else if (cat && cat.connected) cat.setNb(on);
        _currentNbState = on;
        broadcastRigState();
        break;
      }
      case 'atu-tune': {
        // RF-sensing external tuner (LDG Z-100plus, MFJ, etc.) — fire carrier
        // burst instead of CAT's internal AC011.
        const rig = (settings.rigs || []).find(r => r.id === settings.activeRigId);
        if (rig && rig.externalAtu === 'rf-sense') {
          runExternalAtuTune(); // async, fire-and-forget
        } else if (flexNeedsApi) {
          sendCatLog('ATU requires SmartSDR API — not connected');
        } else if (flexSdr()) {
          smartSdr.setAtu(true);
          _currentAtuState = true;
          broadcastRigState();
        } else if (cat && cat.connected) {
          cat.startTune();
          _currentAtuState = true;
          broadcastRigState();
        }
        break;
      }
      case 'power-on':
        // Power-on: radio may be off, so don't require cat.connected — just need transport open
        if (cat && rigType !== 'flex') cat.setPowerState(true);
        break;
      case 'power-off':
        if (cat && cat.connected && rigType !== 'flex') cat.setPowerState(false);
        break;
      case 'set-rf-gain': {
        if (flexNeedsApi) { sendCatLog('RF Gain requires SmartSDR API — not connected'); break; }
        const value = Number(data.value) || 0;
        if (flexSdr()) smartSdr.setRfGain(0, (value * 0.3) - 10);
        else if (cat && cat.connected) {
          if (rigType === 'rigctld') cat.setRfGain(value / 100);
          else cat.setRfGain(value);
        }
        _currentRfGain = value;
        broadcastRigState();
        break;
      }
      case 'set-tx-power': {
        if (flexNeedsApi) { sendCatLog('TX Power requires SmartSDR API — not connected'); break; }
        const value = Number(data.value) || 0;
        if (flexSdr()) smartSdr.setTxPower(value);
        else if (cat && cat.connected) {
          if (rigType === 'rigctld') cat.setTxPower(value / 100);
          else cat.setTxPower(value);
        }
        _currentTxPower = value;
        broadcastRigState();
        break;
      }
      case 'set-filter-width': {
        if (flexNeedsApi) { sendCatLog('Filter requires SmartSDR API — not connected'); break; }
        const width = Number(data.value) || 0;
        if (width <= 0) break;
        if (flexSdr()) {
          const m = (_currentMode || '').toUpperCase();
          let lo, hi;
          if (m === 'CW') { lo = Math.max(0, 600 - Math.round(width / 2)); hi = 600 + Math.round(width / 2); }
          else { lo = 100; hi = 100 + width; }
          smartSdr.setSliceFilter(0, lo, hi);
        } else if (cat && cat.connected) cat.setFilterWidth(width);
        _currentFilterWidth = width;
        // Update per-mode setting so rig panel changes persist across tunes
        const cm = (_currentMode || '').toUpperCase();
        if (cm === 'CW') settings.cwFilterWidth = width;
        else if (cm === 'USB' || cm === 'LSB' || cm === 'SSB') settings.ssbFilterWidth = width;
        else if (cm === 'DIGU' || cm === 'DIGL' || cm === 'PKTUSB' || cm === 'PKTLSB' || cm === 'FT8' || cm === 'FT4') settings.digitalFilterWidth = width;
        broadcastRigState();
        break;
      }
      case 'send-custom-cat': {
        const cmd = data.command;
        if (!cmd || typeof cmd !== 'string') break;
        console.log('[Echo CAT] Custom CAT command:', cmd);
        if (flexSdr()) smartSdr._send(cmd);
        else if (cat && cat.connected) cat.sendRaw(cmd);
        break;
      }
    }
    console.log('[Echo CAT] rig-control:', data.action, data.value != null ? data.value : '');
  });

  remoteServer.on('set-activator-park', async ({ parkRef, activationType, activationName: actName, sig }) => {
    console.log('[Echo CAT] Set activator park:', parkRef || actName, 'type:', activationType);
    settings.appMode = 'activator';
    if (parkRef) {
      settings.activatorParkRefs = [{ id: parkRef, ref: parkRef, name: '' }];
      // Look up park name
      let parkName = '';
      try {
        const park = getParkDb(parksMap, parkRef);
        if (park && park.name) parkName = park.name;
      } catch {}
      if (parkName) {
        settings.activatorParkRefs[0].name = parkName;
      }
    } else {
      settings.activatorParkRefs = [];
    }
    saveSettings(settings);

    // Push updated state to phone
    pushActivatorStateToPhone();
    // Sync desktop UI
    if (win && !win.isDestroyed()) {
      win.webContents.send('reload-prefs');
    }
    // Reset session contacts for new activation
    remoteServer.resetSessionContacts();
  });

  remoteServer.on('search-parks', ({ query }) => {
    try {
      const results = searchParksDb(parksArray, query);
      remoteServer.sendParkResults(results || []);
    } catch (err) {
      console.error('[Echo CAT] Park search error:', err.message);
      remoteServer.sendParkResults([]);
    }
  });

  remoteServer.on('set-refresh-interval', ({ value }) => {
    const val = Math.max(15, parseInt(value, 10) || 30);
    settings.refreshInterval = val;
    saveSettings(settings);
    if (spotTimer) clearInterval(spotTimer);
    spotTimer = setInterval(refreshSpots, val * 1000);
    console.log('[Echo CAT] Refresh interval ->', val, 's');
  });

  remoteServer.on('set-mode', ({ mode }) => {
    if (!mode) return;
    if (!_currentFreqHz) {
      console.log('[Echo CAT] Set mode ignored — no frequency from radio yet');
      return;
    }
    console.log('[Echo CAT] Set mode ->', mode);
    // Reset rate limiter so mode-only change goes through
    _lastTuneFreq = 0;
    tuneRadio(_currentFreqHz / 1000, mode);
  });

  remoteServer.on('toggle-rotor', ({ enabled }) => {
    settings.rotorActive = enabled;
    saveSettings(settings);
    updateRemoteSettings(); // push updated state back to phone
    console.log('[Echo CAT] Rotor ->', enabled ? 'ON' : 'OFF');
  });

  remoteServer.on('set-scan-dwell', ({ value }) => {
    const val = Math.max(1, parseInt(value, 10) || 7);
    settings.scanDwell = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] Scan dwell ->', val, 's');
  });

  remoteServer.on('set-max-age', ({ value }) => {
    const val = Math.max(1, parseInt(value, 10) || 5);
    settings.maxAgeMin = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] Max spot age ->', val, 'm');
  });

  remoteServer.on('set-dist-unit', ({ value }) => {
    if (value === 'mi' || value === 'km') {
      settings.distUnit = value;
      saveSettings(settings);
      updateRemoteSettings();
      console.log('[Echo CAT] Distance unit ->', value);
    }
  });

  remoteServer.on('set-cw-xit', ({ value }) => {
    const val = Math.max(-999, Math.min(999, parseInt(value, 10) || 0));
    settings.cwXit = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] CW XIT ->', val, 'Hz');
  });

  remoteServer.on('set-cw-filter', ({ value }) => {
    const val = Math.max(0, Math.min(3000, parseInt(value, 10) || 0));
    settings.cwFilterWidth = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] CW Filter ->', val, 'Hz');
  });

  remoteServer.on('set-ssb-filter', ({ value }) => {
    const val = Math.max(0, Math.min(4000, parseInt(value, 10) || 0));
    settings.ssbFilterWidth = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] SSB Filter ->', val, 'Hz');
  });

  remoteServer.on('set-digital-filter', ({ value }) => {
    const val = Math.max(0, Math.min(5000, parseInt(value, 10) || 0));
    settings.digitalFilterWidth = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] Digital Filter ->', val, 'Hz');
  });

  remoteServer.on('set-enable-split', ({ value }) => {
    settings.enableSplit = !!value;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] Split ->', value ? 'ON' : 'OFF');
  });

  remoteServer.on('set-enable-atu', ({ value }) => {
    settings.enableAtu = !!value;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] ATU Auto ->', value ? 'ON' : 'OFF');
  });

  remoteServer.on('set-tune-click', ({ value }) => {
    settings.tuneClick = !!value;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] Tune Click ->', value ? 'ON' : 'OFF');
  });

  remoteServer.on('lookup-call', async ({ callsign }) => {
    const call = (callsign || '').toUpperCase().trim();
    if (!call) return;
    let name = '';
    let location = '';
    // Try QRZ first (has operator name)
    if (qrz.configured && settings.enableQrz) {
      try {
        const r = await qrz.lookup(call);
        if (r) {
          name = r.nickname || r.fname || '';
          if (r.name && name) name += ' ' + r.name;
          else if (r.name) name = r.name;
          const parts = [];
          if (r.addr2) parts.push(r.addr2);
          if (r.state) parts.push(r.state);
          if (r.country && r.country !== 'United States') parts.push(r.country);
          location = parts.join(', ');
        }
      } catch {}
    }
    // Fallback to cty.dat for country
    if (!name && !location && ctyDb) {
      const entity = resolveCallsign(call, ctyDb);
      if (entity) location = entity.name || '';
    }
    remoteServer.sendCallLookup({ callsign: call, name, location });
  });

  remoteServer.on('get-past-activations', () => {
    try {
      const activations = getPastActivations();
      remoteServer.sendPastActivations(activations);
    } catch (err) {
      console.error('[Echo CAT] Past activations error:', err.message);
      remoteServer.sendPastActivations([]);
    }
  });

  remoteServer.on('get-activation-map-data', ({ parkRef, date, contacts }) => {
    try {
      // Look up park coordinates
      let park = null;
      if (parkRef) {
        const p = getParkDb(parksMap, parkRef);
        if (p) park = { ref: parkRef, name: p.name || '', lat: parseFloat(p.latitude) || null, lon: parseFloat(p.longitude) || null };
      }
      // Resolve contact locations via cty.dat
      const resolvedContacts = [];
      for (const c of (contacts || [])) {
        let loc = null;
        // Try grid square first (more precise)
        if (c.myGridsquare || c.gridsquare) {
          // Grid squares would need client-side conversion; use cty.dat here
        }
        // Resolve via cty.dat
        if (ctyDb && c.callsign) {
          const entity = resolveCallsign(c.callsign, ctyDb);
          if (entity && entity.lat != null && entity.lon != null) {
            const area = getCallAreaCoords(c.callsign, entity.name);
            if (area) {
              loc = { lat: area.lat, lon: area.lon, name: entity.name };
            } else {
              loc = { lat: entity.lat, lon: entity.lon, name: entity.name };
            }
          }
        }
        resolvedContacts.push({
          callsign: c.callsign || '',
          freq: c.freq || '',
          mode: c.mode || '',
          lat: loc ? loc.lat : null,
          lon: loc ? loc.lon : null,
          entityName: loc ? loc.name : '',
        });
      }
      remoteServer.sendActivationMapData({ parkRef, park, resolvedContacts });
    } catch (err) {
      console.error('[Echo CAT] Activation map data error:', err.message);
      remoteServer.sendActivationMapData({ parkRef, park: null, resolvedContacts: [] });
    }
  });

  remoteServer.on('get-all-qsos', () => {
    try {
      const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
      const qsos = parseAllRawQsos(logPath);
      // Send with idx so phone can reference by index for edit/delete
      const mapped = qsos.map((q, i) => ({ idx: i, ...q }));
      remoteServer.sendAllQsos(mapped);
    } catch (err) {
      console.error('[Echo CAT] get-all-qsos error:', err.message);
      remoteServer.sendAllQsos([]);
    }
  });

  remoteServer.on('update-qso', ({ idx, fields }) => {
    try {
      const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
      const qsos = parseAllRawQsos(logPath);
      if (idx < 0 || idx >= qsos.length) {
        remoteServer.sendQsoUpdated({ success: false, idx, error: 'Invalid index' });
        return;
      }
      Object.assign(qsos[idx], fields);
      rewriteAdifFile(logPath, qsos);
      loadWorkedQsos();
      // Notify desktop QSO pop-out
      if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) {
        qsoPopoutWin.webContents.send('qso-popout-updated', { idx, fields });
      }
      remoteServer.sendQsoUpdated({ success: true, idx, fields });
    } catch (err) {
      remoteServer.sendQsoUpdated({ success: false, idx, error: err.message });
    }
  });

  remoteServer.on('delete-qso', ({ idx }) => {
    try {
      const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
      const qsos = parseAllRawQsos(logPath);
      if (idx < 0 || idx >= qsos.length) {
        remoteServer.sendQsoDeleted({ success: false, idx, error: 'Invalid index' });
        return;
      }
      qsos.splice(idx, 1);
      rewriteAdifFile(logPath, qsos);
      loadWorkedQsos();
      // Notify desktop QSO pop-out
      if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) {
        qsoPopoutWin.webContents.send('qso-popout-deleted', idx);
      }
      remoteServer.sendQsoDeleted({ success: true, idx });
    } catch (err) {
      remoteServer.sendQsoDeleted({ success: false, idx, error: err.message });
    }
  });

  remoteServer.on('log-qso', async (data) => {
    if (!data || !data.callsign) {
      remoteServer.sendLogResult({ success: false, error: 'Missing callsign' });
      return;
    }
    try {
      const now = new Date();
      const qsoDate = now.toISOString().slice(0, 10).replace(/-/g, '');
      const qsoTime = now.toISOString().slice(11, 16).replace(/:/g, '');
      const freqKhz = parseFloat(data.freqKhz) || 0;
      const freqMhz = freqKhz / 1000;
      const band = freqToBand(freqMhz) || '';

      const sig = data.sig || '';
      const sigInfo = data.sigInfo || '';
      const userComment = (data.userComment || '').trim();
      let comment = '';
      if (sigInfo && userComment) comment = `[${sig} ${sigInfo}] ${userComment}`;
      else if (sigInfo) comment = `[${sig} ${sigInfo}]`;
      else comment = userComment;

      // QRZ + park enrichment — mirror the desktop banner-logger so a phone-
      // logged QSO carries the same name/state/grid/country into N3FJP and
      // ADIF as the same contact logged from the desktop. Without this,
      // KK4DF reported phone-logged QSOs landed in N3FJP with empty operator
      // fields while desktop-logged ones were fully populated.
      let qrzInfo = null;
      if (qrz.configured && settings.enableQrz) {
        try { qrzInfo = await qrz.lookup(data.callsign.split('/')[0]); }
        catch { /* QRZ failed — leave qrzInfo null and emit empty fields */ }
      }
      let parkLocState = '', parkLocGrid = '';
      if (sig === 'POTA' && sigInfo) {
        const park = getParkDb(parksMap, sigInfo);
        if (park) {
          const locParts = (park.locationDesc || '').split('-');
          if (locParts.length >= 2) parkLocState = locParts.slice(1).join('-');
          parkLocGrid = park.grid || '';
        }
      }
      const qrzName = qrzInfo
        ? [cleanQrzName(qrzInfo.nickname) || cleanQrzName(qrzInfo.fname), cleanQrzName(qrzInfo.name)].filter(Boolean).join(' ')
        : '';

      const qsoData = {
        callsign: data.callsign.toUpperCase(),
        frequency: String(freqKhz),
        mode: (data.mode || '').toUpperCase(),
        band,
        qsoDate,
        timeOn: qsoTime,
        rstSent: data.rstSent || '59',
        rstRcvd: data.rstRcvd || '59',
        sig,
        sigInfo,
        comment,
        // QRZ-derived fields. The state/county branch suppresses the worked
        // op's home QTH on POTA contacts (the park's state goes there
        // instead) — matches desktop banner-logger semantics.
        name: qrzName,
        state: parkLocState || (!sig && qrzInfo ? (qrzInfo.state || '') : ''),
        county: !parkLocState && !sig && qrzInfo && qrzInfo.state && qrzInfo.county ? `${qrzInfo.state},${qrzInfo.county}` : '',
        gridsquare: parkLocGrid || (qrzInfo ? (qrzInfo.grid || '') : ''),
        country: qrzInfo ? (qrzInfo.country || '') : '',
      };

      // Pass through respot flags from phone
      if (data.respot) qsoData.respot = true;
      if (data.wwffRespot) { qsoData.wwffRespot = true; qsoData.wwffReference = data.wwffReference || ''; }
      if (data.llotaRespot) { qsoData.llotaRespot = true; qsoData.llotaReference = data.llotaReference || ''; }
      if (data.dxcRespot) qsoData.dxcRespot = true;
      if (data.respotComment) qsoData.respotComment = data.respotComment;

      // Add station fields from settings
      if (settings.myCallsign) {
        qsoData.stationCallsign = settings.myCallsign.toUpperCase();
      }
      // Club mode: OPERATOR = individual member callsign
      if (settings.clubMode && remoteServer) {
        const member = remoteServer.getAuthenticatedMember();
        if (member) {
          qsoData.operator = member.callsign;
        }
      }
      if (settings.txPower) {
        qsoData.txPower = String(settings.txPower);
      }

      // Activator mode: inject mySig fields from phone or desktop settings
      const mySig = data.mySig || '';
      const mySigInfo = data.mySigInfo || '';
      const myGrid = data.myGridsquare || settings.grid || '';

      let result = { success: true };
      if (mySig && mySigInfo) {
        // Phone sent explicit park ref — use multi-park cross-product from desktop
        const parkRefs = (settings.activatorParkRefs || []).filter(p => p && p.ref);
        if (mySig === 'POTA' && parkRefs.length > 1) {
          // Cross-product: one ADIF record per park
          for (let i = 0; i < parkRefs.length; i++) {
            const parkQso = { ...qsoData, mySig: 'POTA', mySigInfo: parkRefs[i].ref, myGridsquare: myGrid };
            if (i > 0) parkQso.skipLogbookForward = true;
            const r = await saveQsoRecord(parkQso);
            if (r) Object.assign(result, r);
          }
        } else {
          qsoData.mySig = mySig;
          qsoData.mySigInfo = mySigInfo;
          qsoData.myGridsquare = myGrid;
          const r = await saveQsoRecord(qsoData);
          if (r) Object.assign(result, r);
        }
        // Cross-program references (WWFF, LLOTA for same park)
        const crossRefs1 = (settings.activatorCrossRefs || []).filter(xr => xr && xr.ref);
        for (const xr of crossRefs1) {
          const xrQso = { ...qsoData, mySig: xr.program.toUpperCase(), mySigInfo: xr.ref, myGridsquare: myGrid, skipLogbookForward: true };
          if (xr.program === 'WWFF') xrQso.myWwffRef = xr.ref;
          await saveQsoRecord(xrQso);
        }
      } else if (settings.appMode === 'activator') {
        // Desktop is in activator mode but phone didn't send mySig — use desktop park refs
        const parkRefs = (settings.activatorParkRefs || []).filter(p => p && p.ref);
        if (parkRefs.length > 0) {
          for (let i = 0; i < parkRefs.length; i++) {
            const parkQso = { ...qsoData, mySig: 'POTA', mySigInfo: parkRefs[i].ref, myGridsquare: myGrid };
            if (i > 0) parkQso.skipLogbookForward = true;
            const r = await saveQsoRecord(parkQso);
            if (r) Object.assign(result, r);
          }
          // Cross-program references (WWFF, LLOTA for same park)
          const crossRefs2 = (settings.activatorCrossRefs || []).filter(xr => xr && xr.ref);
          for (const xr of crossRefs2) {
            const xrQso = { ...qsoData, mySig: xr.program.toUpperCase(), mySigInfo: xr.ref, myGridsquare: myGrid, skipLogbookForward: true };
            if (xr.program === 'WWFF') xrQso.myWwffRef = xr.ref;
            await saveQsoRecord(xrQso);
          }
        } else {
          const r = await saveQsoRecord(qsoData);
          if (r) Object.assign(result, r);
        }
      } else {
        const r = await saveQsoRecord(qsoData);
        if (r) Object.assign(result, r);
      }

      // Handle additional parks from phone
      const additionalParks = data.additionalParks || [];
      for (const addlRef of additionalParks) {
        if (!addlRef) continue;
        const addlQso = { ...qsoData, sigInfo: addlRef, respot: false, wwffRespot: false,
          llotaRespot: false, dxcRespot: false, respotComment: '', skipLogbookForward: true };
        await saveQsoRecord(addlQso);
      }

      // Track session contact and send enhanced log-ok
      // Dupe check: same callsign + same band in current activation session
      const existingContacts = remoteServer.getSessionContacts();
      const callUpper = qsoData.callsign.toUpperCase();
      const isDupe = existingContacts.some(c => c.callsign.toUpperCase() === callUpper && c.band === band);
      const contactData = {
        callsign: qsoData.callsign,
        timeUtc: qsoTime,
        freqKhz: String(freqKhz),
        mode: qsoData.mode,
        band,
        rstSent: qsoData.rstSent,
        rstRcvd: qsoData.rstRcvd,
        dupe: isDupe,
      };
      const contact = remoteServer.addSessionContact(contactData);
      remoteServer.sendLogResult({
        success: true,
        callsign: qsoData.callsign,
        nr: contact.nr,
        timeUtc: contact.timeUtc,
        freqKhz: contact.freqKhz,
        mode: contact.mode,
        band: contact.band,
        rstSent: contact.rstSent,
        rstRcvd: contact.rstRcvd,
        resposted: result.resposted || false,
        respotError: result.respotError || result.wwffRespotError || result.llotaRespotError || result.dxcRespotError || '',
      });
    } catch (err) {
      console.error('[Echo CAT] Log QSO error:', err.message);
      remoteServer.sendLogResult({ success: false, error: err.message });
    }
  });

  // --- JTCAT remote control (event handlers — helpers are at file level) ---

  remoteServer.on('jtcat-start', ({ mode }) => {
    // Close JTCAT popout if open — only one platform at a time
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      sendCatLog('[JTCAT] Closing popout — ECHOCAT taking over FT8');
      jtcatPopoutWin.close();
    }
    startJtcat(mode);
    // Start audio capture in desktop renderer
    if (win && !win.isDestroyed()) win.webContents.send('jtcat-start-for-remote');
    // Push a confirmed jtcat-status to the phone so its UI doesn't have to
    // optimistically flip the running flag and wait for the first decode to
    // confirm. (Gap 9, mobile dev report 2026-05-03.)
    if (remoteServer.hasClient()) {
      remoteServer.broadcastJtcatStatus({ state: 'running', mode: mode || 'FT8' });
    }
  });

  // Phone tap on Tune button — same code path as the local desktop button.
  // (Gap 11, 2026-05-04.)
  remoteServer.on('jtcat-tune-toggle', () => {
    if (jtcatTuneState.active) stopJtcatTune();
    else startJtcatTune();
  });

  // Phone tap on Auto Seq pill — flip the engine flag and broadcast new
  // state so any other connected client (or reconnect) sees it. (Gap 12.)
  remoteServer.on('jtcat-set-auto-seq', ({ enabled }) => {
    const eng = (jtcatManager && jtcatManager.txEngine) || ft8Engine;
    if (eng) eng._autoSeq = !!enabled;
    sendCatLog(`[JTCAT] Auto Seq ${enabled ? 'ON' : 'OFF'} (set by ECHOCAT)`);
    if (remoteServer.hasClient()) {
      remoteServer.sendToClient({ type: 'jtcat-auto-seq-state', enabled: !!enabled });
    }
  });

  // ECHOCAT multi-slice — phone sends config, desktop runs engines + audio
  remoteServer.on('jtcat-start-multi-remote', ({ slices }) => {
    if (!Array.isArray(slices) || slices.length === 0) return;
    // Emit the same IPC event that the desktop popout uses
    ipcMain.emit('jtcat-start-multi', {}, slices);
    // Start audio capture in desktop renderer for each slice
    if (win && !win.isDestroyed()) win.webContents.send('jtcat-start-for-remote');
    sendCatLog(`[JTCAT] Multi-slice started from ECHOCAT: ${slices.map(s => s.sliceId + '/' + s.band).join(', ')}`);
  });

  remoteServer.on('jtcat-stop', () => {
    stopJtcat();
    remoteJtcatQso = null;
    if (win && !win.isDestroyed()) win.webContents.send('jtcat-stop-for-remote');
  });

  remoteServer.on('jtcat-call-cq', async () => {
    if (!ft8Engine) return;
    const myCall = remoteJtcatMyCall();
    const myGrid = remoteJtcatMyGrid();
    if (!myCall || !myGrid) {
      // Send error back to phone
      if (remoteServer.hasClient()) {
        remoteServer.broadcastJtcatQsoState({ phase: 'error', error: 'Set callsign & grid in POTACAT Settings first' });
      }
      console.warn('[JTCAT Remote] CQ aborted — callsign or grid not configured');
      return;
    }
    // Auto-place TX on quiet frequency from FFT analysis
    ft8Engine.setTxFreq(jtcatQuietFreq);
    if (remoteServer.hasClient()) {
      remoteServer.broadcastJtcatTxStatus({ state: 'rx', txFreq: jtcatQuietFreq });
    }
    const txMsg = 'CQ ' + myCall + ' ' + myGrid;
    // TX on next available slot
    const nextSlot = ft8Engine._lastRxSlot === 'even' ? 'odd' : (ft8Engine._lastRxSlot === 'odd' ? 'even' : 'even');
    ft8Engine.setTxSlot(nextSlot);
    remoteJtcatQso = { mode: 'cq', call: null, grid: null, phase: 'cq', txMsg, report: null, sentReport: null, myCall, myGrid, txRetries: 0 };
    await remoteJtcatSetTxMsg(txMsg); // encode first, then enable TX
    ft8Engine._txEnabled = true;
    ft8Engine.tryImmediateTx();
    console.log('[JTCAT Remote] CQ:', txMsg, '@ quiet freq', jtcatQuietFreq, 'Hz slot:', nextSlot);
  });

  remoteServer.on('jtcat-reply', async (data) => {
    const { call, df, slot, sliceId, snr } = data;
    // Route TX to correct slice in multi-slice mode
    const targetEngine = (jtcatManager && sliceId) ? jtcatManager.getEngine(sliceId) : ft8Engine;
    if (!targetEngine) return;
    if (jtcatManager && sliceId) { jtcatManager.setTxSlice(sliceId); jtcatManager.requestTx(sliceId); }
    const myCall = remoteJtcatMyCall();
    const myGrid = remoteJtcatMyGrid();
    if (!myCall) return;
    // If replacing an active QSO that had reports exchanged but wasn't logged yet, log it
    if (remoteJtcatQso && remoteJtcatQso.call && remoteJtcatQso.report &&
        remoteJtcatQso.phase !== '73' && remoteJtcatQso.phase !== 'done' &&
        remoteJtcatQso.call.toUpperCase() !== (call || '').toUpperCase()) {
      sendCatLog(`[JTCAT] Replacing active QSO with ${remoteJtcatQso.call} — auto-logging`);
      await jtcatAutoLog(remoteJtcatQso);
    }
    // Halt any active TX (e.g. CQ) so reply goes out on next boundary
    if (targetEngine._txActive) targetEngine.txComplete();
    targetEngine.setTxFreq(df);
    targetEngine.setRxFreq(df);
    // TX on opposite slot from the station we're replying to (use slot from decode data)
    const targetSlot = slot || targetEngine._lastRxSlot;
    targetEngine.setTxSlot(targetSlot === 'even' ? 'odd' : (targetSlot === 'odd' ? 'even' : 'auto'));

    // Compute next TX message from the explicit `nextStep` set by phone-side
    // FT8 click handler. Falls back to legacy `rr73`/`report` flags for any
    // older client. Same fix as jtcat-popout-reply — see comment block there
    // (Chris N4RDX 2026-04-29).
    let nextStep = data.nextStep;
    if (!nextStep) {
      if (data.rr73) nextStep = 'send-73';
      else if (data.report) nextStep = 'send-r-report';
      else nextStep = 'reply-cq';
    }
    const ourRpt = (() => {
      const v = Math.round(snr || 0);
      return v >= 0 ? '+' + String(v).padStart(2, '0') : '-' + String(Math.abs(v)).padStart(2, '0');
    })();
    const theirGrid = data.theirGrid || data.grid || '';
    const theirReport = data.theirReport || data.report;
    const sliceKey = sliceId || 'default';

    let txMsg, phase;
    if (nextStep === 'send-73') {
      txMsg = call + ' ' + myCall + ' 73';
      phase = '73';
    } else if (nextStep === 'send-rr73') {
      txMsg = call + ' ' + myCall + ' RR73';
      phase = 'rr73';
      const sameCall = remoteJtcatQso && remoteJtcatQso.call && remoteJtcatQso.call.toUpperCase() === call.toUpperCase();
      remoteJtcatQso = {
        mode: 'reply', call,
        grid: theirGrid || (sameCall ? remoteJtcatQso.grid : ''),
        phase, txMsg,
        report: theirReport || (sameCall ? remoteJtcatQso.report : null),
        sentReport: (sameCall ? remoteJtcatQso.sentReport : null) || ourRpt,
        myCall, myGrid, txRetries: 0, sliceId: sliceKey,
      };
    } else if (nextStep === 'send-r-report') {
      txMsg = call + ' ' + myCall + ' R' + ourRpt;
      phase = 'r+report';
      remoteJtcatQso = { mode: 'reply', call, grid: theirGrid, phase, txMsg, report: theirReport, sentReport: ourRpt, myCall, myGrid, txRetries: 0, sliceId: sliceKey };
    } else if (nextStep === 'send-report') {
      txMsg = call + ' ' + myCall + ' ' + ourRpt;
      phase = 'report';
      remoteJtcatQso = { mode: 'reply', call, grid: theirGrid, phase, txMsg, report: null, sentReport: ourRpt, myCall, myGrid, txRetries: 0, sliceId: sliceKey };
    } else {
      txMsg = call + ' ' + myCall + ' ' + myGrid;
      phase = 'reply';
    }

    if (phase === '73') {
      const prev = remoteJtcatQso;
      const sameCall = prev && prev.call && prev.call.toUpperCase() === call.toUpperCase();
      remoteJtcatQso = { mode: 'reply', call, grid: theirGrid || (sameCall ? prev.grid : ''), phase, txMsg,
        report: sameCall ? prev.report : null,
        sentReport: sameCall ? prev.sentReport : null,
        myCall, myGrid, txRetries: 0, sliceId: sliceKey };
      await remoteJtcatSetTxMsg(txMsg);
      targetEngine._txEnabled = true;
      targetEngine.tryImmediateTx();
      if (!sameCall) await jtcatAutoLog(remoteJtcatQso);
    } else if (phase === 'reply') {
      // Fresh reply with our grid — set up new QSO entry.
      remoteJtcatQso = { mode: 'reply', call, grid: theirGrid, phase: 'reply', txMsg, report: null, sentReport: null, myCall, myGrid, txRetries: 0, sliceId: sliceKey };
      await remoteJtcatSetTxMsg(txMsg);
      targetEngine._txEnabled = true;
      targetEngine.tryImmediateTx();
    } else {
      // QSO already populated above by send-report / send-r-report / send-rr73.
      await remoteJtcatSetTxMsg(txMsg);
      targetEngine._txEnabled = true;
      targetEngine.tryImmediateTx();
    }
    remoteJtcatBroadcastQso();
    console.log('[JTCAT Remote]', nextStep, '→', call, ':', txMsg, 'phase:', phase, 'slot:', targetEngine._txSlot, 'locked:', targetEngine._lockedTxSlot);
  });

  remoteServer.on('jtcat-enable-tx', ({ enabled }) => {
    if (ft8Engine) ft8Engine._txEnabled = enabled;
  });

  remoteServer.on('jtcat-auto-cq-mode', ({ mode }) => {
    jtcatAutoCqMode = mode || 'off';
    jtcatAutoCqOwner = 'remote';
    if (mode === 'off') jtcatAutoCqWorkedSession.clear();
    broadcastAutoCqState();
    console.log('[JTCAT Remote] Auto-CQ mode:', mode);
  });

  remoteServer.on('jtcat-halt-tx', () => {
    if (jtcatManager) {
      for (const id of jtcatManager.sliceIds) {
        const eng = jtcatManager.getEngine(id);
        if (eng) { eng._txEnabled = false; eng.setTxMessage(''); if (eng._txActive) eng.txComplete(); }
        jtcatManager.releaseTx(id);
      }
    } else if (ft8Engine) {
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      if (ft8Engine._txActive) ft8Engine.txComplete();
    }
    remoteJtcatQso = null;
    remoteJtcatBroadcastQso();
    handleRemotePtt(false);
  });

  remoteServer.on('jtcat-set-mode', ({ mode }) => {
    if (ft8Engine) ft8Engine.setMode(mode);
  });

  remoteServer.on('jtcat-set-tx-freq', ({ hz }) => {
    if (ft8Engine) {
      ft8Engine.setTxFreq(hz);
      if (remoteServer.hasClient()) {
        remoteServer.broadcastJtcatTxStatus({ state: ft8Engine._txActive ? 'tx' : 'rx', txFreq: ft8Engine._txFreq });
      }
    }
  });

  remoteServer.on('jtcat-set-tx-slot', ({ slot }) => {
    if (ft8Engine) ft8Engine.setTxSlot(slot);
  });

  // ECHOCAT FT8 gain controls — relay to main renderer
  remoteServer.on('set-freedv', ({ enabled }) => {
    settings.enableFreedv = enabled;
    saveSettings(settings);
    if (enabled) {
      connectFreedvReporter();
      connectPskr();
    } else {
      disconnectFreedvReporter();
    }
    // Send confirmation back so checkbox stays in sync
    remoteServer.sendToClient({ type: 'freedv-enabled', enabled });
  });

  remoteServer.on('tgxl-select-antenna', ({ port }) => {
    if (tgxlClient && tgxlClient.connected) tgxlClient.selectAntenna(port);
  });

  // FreeDV from ECHOCAT
  remoteServer.on('freedv-start', ({ mode }) => {
    if (freedvEngine) freedvEngine.stop();
    // Trigger the IPC handler via a synthetic event
    if (win && !win.isDestroyed()) win.webContents.send('freedv-remote-start', mode);
  });
  remoteServer.on('freedv-stop', () => {
    if (win && !win.isDestroyed()) win.webContents.send('freedv-remote-stop');
  });
  remoteServer.on('freedv-set-mode', ({ mode }) => {
    if (freedvEngine) freedvEngine.setMode(mode);
  });
  remoteServer.on('freedv-set-tx', ({ enabled }) => {
    if (freedvEngine) freedvEngine.setTxEnabled(enabled);
    // PTT via CAT
    if (enabled) {
      if (cat && cat.connected) cat.setTransmit(true);
    } else {
      if (cat && cat.connected) cat.setTransmit(false);
    }
  });
  remoteServer.on('freedv-set-squelch', ({ enabled, threshold }) => {
    if (freedvEngine) freedvEngine.setSquelch(enabled, threshold);
    settings.freedvSquelch = { enabled: !!enabled, threshold: Number(threshold) };
    saveSettings(settings);
  });

  remoteServer.on('jtcat-rx-gain', ({ value }) => {
    if (win && !win.isDestroyed()) win.webContents.send('jtcat-set-rx-gain', value);
  });
  remoteServer.on('jtcat-tx-gain', ({ value }) => {
    if (win && !win.isDestroyed()) win.webContents.send('jtcat-set-tx-gain', value);
  });

  // SSTV from ECHOCAT phone — open desktop SSTV popout
  remoteServer.on('sstv-open', () => {
    console.log('[SSTV] ECHOCAT sstv-open received, openSstvPopout=' + (typeof openSstvPopout));
    if (openSstvPopout) openSstvPopout();
    else console.warn('[SSTV] openSstvPopout not yet assigned — second whenReady block not run?');
    // Ask the popout to push its current compose to the phone. Popout may not
    // exist yet on first open; the ipc handler tolerates that.
    if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
      sstvPopoutWin.webContents.send('sstv-send-compose-state');
    }
  });

  // Phone asked for the current compose explicitly (on tab open etc.)
  remoteServer.on('sstv-get-compose', () => {
    if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
      sstvPopoutWin.webContents.send('sstv-send-compose-state');
    }
  });

  // SSTV from ECHOCAT phone — receive photo, encode, transmit
  remoteServer.on('sstv-photo', ({ image, mode }) => {
    if (!sstvEngine && startSstv) startSstv();
    if (!sstvEngine) {
      console.error('[SSTV] ECHOCAT photo received but SSTV not initialized');
      return;
    }
    // Open the desktop popout so the operator can see what's being sent. The
    // popout also owns TX audio playback for the Flex audio path.
    const popoutWasOpen = !!(sstvPopoutWin && !sstvPopoutWin.isDestroyed());
    if (!popoutWasOpen && openSstvPopout) openSstvPopout();
    try {
      const { nativeImage } = require('electron');
      // Decode base64 JPEG/PNG from phone
      const base64 = image.replace(/^data:image\/\w+;base64,/, '');
      const img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
      const size = img.getSize();
      if (size.width === 0 || size.height === 0) {
        console.error('[SSTV] ECHOCAT: invalid image');
        return;
      }
      const bitmap = img.toBitmap(); // BGRA format
      // Convert BGRA to RGBA
      const rgba = new Uint8ClampedArray(bitmap.length);
      for (let i = 0; i < bitmap.length; i += 4) {
        rgba[i]     = bitmap[i + 2]; // R
        rgba[i + 1] = bitmap[i + 1]; // G
        rgba[i + 2] = bitmap[i];     // B
        rgba[i + 3] = bitmap[i + 3]; // A
      }
      console.log(`[SSTV] ECHOCAT photo received: ${size.width}x${size.height}, mode=${mode}`);
      // Show the outgoing image on the desktop popout's TX canvas so the op
      // can see what their phone is sending. Send immediately if popout was
      // already open; otherwise wait for it to finish loading.
      const pushTxImage = () => {
        if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
          sstvPopoutWin.webContents.send('sstv-tx-image', {
            imageData: Array.from(rgba),
            width: size.width,
            height: size.height,
            mode,
          });
        }
      };
      if (popoutWasOpen) {
        pushTxImage();
      } else {
        setTimeout(pushTxImage, 1500);
      }
      sstvEngine.encode(rgba, size.width, size.height, mode);
    } catch (err) {
      console.error('[SSTV] ECHOCAT photo error:', err.message);
    }
  });
  remoteServer.on('sstv-stop', () => {
    if (sstvEngine) sstvEngine.stop();
  });

  // Phone requested an immediate TX abort.
  // Release PTT FIRST (FCC safety — don't leave the Flex keyed), then tell
  // the popout to stop audio playback, then notify all clients.
  remoteServer.on('sstv-halt-tx', () => {
    console.log('[SSTV] ECHOCAT requested TX halt');
    try { handleRemotePtt(false); } catch (e) { console.error('[SSTV] halt PTT release:', e); }
    if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
      sstvPopoutWin.webContents.send('sstv-abort-tx');
    }
    if (remoteServer && remoteServer.hasClient()) {
      remoteServer.broadcastSstvTxStatus({ state: 'rx' });
    }
  });

  remoteServer.on('sstv-get-gallery', ({ limit, offset, requestId }) => {
    ensureSstvGalleryDir();
    try {
      const files = fs.readdirSync(SSTV_GALLERY_DIR)
        .filter(f => f.endsWith('.png'))
        .sort((a, b) => b.localeCompare(a));
      const total = files.length;
      const slice = files.slice(offset || 0, (offset || 0) + (limit || 10));
      const images = slice.map(f => {
        const filePath = path.join(SSTV_GALLERY_DIR, f);
        const stat = fs.statSync(filePath);
        const data = fs.readFileSync(filePath);
        const parts = f.replace('.png', '').split('_');
        return {
          filename: f,
          dataUrl: 'data:image/png;base64,' + data.toString('base64'),
          mode: parts[1] || '',
          timestamp: stat.mtimeMs,
        };
      });
      remoteServer.sendSstvGallery(images, requestId, total);
    } catch (err) {
      console.error('[SSTV] Gallery fetch for ECHOCAT error:', err.message);
      remoteServer.sendSstvGallery([], requestId, 0);
    }
  });

  // CW macros pushed from ECHOCAT phone — phone localStorage gets
  // wiped periodically by Safari ITP and similar; the desktop is the
  // durable home for the user's macros. We persist to
  // settings.remoteCwMacros (which is already pushed to the phone via
  // the auth-ok handshake) and trigger a re-push so other connected
  // clients see the update too.
  remoteServer.on('save-cw-macros', ({ macros }) => {
    settings.remoteCwMacros = macros;
    saveSettings(settings);
    updateRemoteSettings();
    sendCatLog(`[Echo CAT] Saved ${macros.length} CW macros from phone`);
  });

  // ECHOCAT prefs from phone (welcome-banner dismissed, etc.) — same
  // localStorage-survivability story as the CW macros.
  remoteServer.on('save-echo-pref', ({ key, value }) => {
    if (!settings.echocatPrefs) settings.echocatPrefs = {};
    settings.echocatPrefs[key] = value;
    saveSettings(settings);
    updateRemoteSettings();
    sendCatLog(`[Echo CAT] Saved phone pref ${key}=${JSON.stringify(value)}`);
  });

  // Voice macro sync from ECHOCAT phone
  remoteServer.on('voice-macro-sync', ({ idx, label, audio }) => {
    ensureVoiceMacroDir();
    if (audio) fs.writeFileSync(voiceMacroPath(idx), Buffer.from(audio, 'base64'));
    if (label != null) {
      if (!settings.voiceMacroLabels) settings.voiceMacroLabels = ['', '', '', '', ''];
      settings.voiceMacroLabels[idx] = label;
      saveSettings(settings);
    }
    // Notify desktop renderer to refresh
    if (win && !win.isDestroyed()) win.webContents.send('voice-macros-updated');
    console.log(`[Voice] Received macro ${idx} from phone`);
  });

  remoteServer.on('voice-macro-delete', ({ idx }) => {
    const p = voiceMacroPath(idx);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    if (win && !win.isDestroyed()) win.webContents.send('voice-macros-updated');
  });

  remoteServer.on('jtcat-cancel-qso', () => {
    if (ft8Engine) {
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      ft8Engine.setTxSlot('auto');
      if (ft8Engine._txActive) ft8Engine.txComplete();
    }
    remoteJtcatQso = null;
    remoteJtcatBroadcastQso();
  });

  remoteServer.on('jtcat-skip-phase', async () => {
    if (!remoteJtcatQso || remoteJtcatQso.phase === 'done' || remoteJtcatQso.phase === 'idle') return;
    const q = remoteJtcatQso;
    const myCall = q.myCall;
    const validCall = q.call && /^[A-Z0-9/]{2,}$/i.test(q.call);
    if (q.mode === 'cq') {
      if (q.phase === 'cq' || q.phase === 'cq-report') {
        q.txMsg = validCall ? (q.call + ' ' + myCall + ' RR73') : '';
        q.phase = validCall ? 'cq-rr73' : 'done';
      } else {
        q.phase = 'done';
      }
    } else {
      if (q.phase === 'reply') {
        const rpt = q.sentReport || '-10';
        q.txMsg = q.call + ' ' + myCall + ' R' + rpt;
        q.phase = 'r+report';
      } else if (q.phase === 'r+report') {
        q.txMsg = q.call + ' ' + myCall + ' RR73';
        q.phase = '73';
      } else {
        q.phase = 'done';
      }
    }
    if (q.phase === 'done') {
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      ft8Engine.setTxSlot('auto');
    }
    q.txRetries = 0;
    if (q.txMsg && q.phase !== 'done') {
      await remoteJtcatSetTxMsg(q.txMsg);
    }
    remoteJtcatBroadcastQso();
    console.log('[JTCAT] Remote skip to phase:', q.phase, '— TX:', q.txMsg);
  });

  remoteServer.on('jtcat-set-band', ({ band, freqKhz }) => {
    if (freqKhz) tuneRadio(freqKhz, 'DIGU');
  });

  remoteServer.on('jtcat-log-qso', async () => {
    if (!remoteJtcatQso || !remoteJtcatQso.call) {
      console.log('[JTCAT Remote] Log QSO requested but no active QSO');
      return;
    }
    try {
      const q = remoteJtcatQso;
      const now = new Date();
      const qsoDate = now.toISOString().slice(0, 10).replace(/-/g, '');
      const qsoTime = now.toISOString().slice(11, 16).replace(/:/g, '');
      const freqKhz = _currentFreqHz ? _currentFreqHz / 1000 : 0;
      const freqMhz = freqKhz / 1000;
      const band = freqToBand(freqMhz) || '';
      const mode = ft8Engine ? ft8Engine._mode : 'FT8';

      const qsoData = {
        callsign: q.call.toUpperCase(),
        frequency: String(freqKhz),
        mode,
        band,
        qsoDate,
        timeOn: qsoTime,
        rstSent: q.sentReport || '-00',
        rstRcvd: q.report || '-00',
        gridsquare: q.grid || '',
        comment: 'JTCAT FT8',
      };

      const result = await saveQsoRecord(qsoData);
      console.log('[JTCAT Remote] QSO logged:', q.call, result.success ? 'OK' : result.error);

      // Broadcast updated worked QSOs so the phone's spot list updates
      if (result.success && win && !win.isDestroyed()) {
        win.webContents.send('jtcat-decode', { cycle: 0, mode, results: [] }); // trigger UI refresh
      }
    } catch (err) {
      console.error('[JTCAT Remote] Log QSO failed:', err.message);
    }
  });

  remoteServer.on('signal-from-client', (data) => {
    if (data && data.type === 'start-audio') {
      // Safety: release PTT if active — audio reconnect means phone lost state
      if (remoteServer._pttActive) {
        console.log('[Echo CAT] Audio restart while TX — forcing RX');
        remoteServer.forcePttRelease();
        handleRemotePtt(false);
      }
      // Tell phone whether to use STUN before WebRTC negotiation begins
      remoteServer.sendToClient({ type: 'stun-config', useStun: !!settings.remoteStun });
      // Phone requested audio — create or restart hidden audio window
      startRemoteAudio();
      return;
    }
    if (remoteAudioWin && !remoteAudioWin.isDestroyed()) {
      remoteAudioWin.webContents.send('remote-audio-signal', data);
    }
  });

  remoteServer.on('error', (err) => {
    console.error('[Echo CAT] Error:', err.message);
  });

  const port = settings.remotePort || 7300;
  const requireToken = settings.remoteRequireToken === true;
  let token = settings.remoteToken;
  if (requireToken && !token) {
    token = RemoteServer.generateToken();
    settings.remoteToken = token;
    saveSettings(settings);
  }
  // Club Station Mode
  if (settings.clubMode && settings.clubCsvPath) {
    const auditPath = settings.clubAuditPath ||
      path.join(app.getPath('userData'), 'club-audit.csv');
    const auditLogger = createAuditLogger(auditPath);
    remoteServer.setClubMode(true, settings.clubCsvPath, auditLogger, settings.rigs || [], settings.activeRigId);
  }

  remoteServer.start(port, token, {
    requireToken: settings.clubMode ? true : requireToken, // club mode always requires auth
    pttSafetyTimeout: settings.remotePttTimeout || 180,
    rendererPath: path.join(app.getAppPath(), 'renderer'),
    certDir: app.getPath('userData'),
  });

  // KiwiSDR bridge — must be inside connectRemote() so listeners survive reconnect
  remoteServer.on('kiwi-connect', (msg) => {
    const raw = msg.host || settings.kiwiSdrHost1 || settings.kiwiSdrHost || '';
    const clean = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    sendCatLog(`[WebSDR] ECHOCAT connect: "${clean}"`);
    const parts = clean.split(':');
    if (parts[0]) {
      require('electron').ipcMain.emit('kiwi-connect', { sender: { send: () => {} } }, { host: parts[0], port: parseInt(parts[1], 10) || 8073, password: msg.password });
    }
  });
  remoteServer.on('kiwi-disconnect', () => {
    if (kiwiClient) { kiwiClient.disconnect(); kiwiClient = null; }
    kiwiActive = false;
  });
  remoteServer.on('save-settings', (partial) => {
    Object.assign(settings, partial);
    saveSettings(settings);
  });
}

function disconnectRemote() {
  disconnectCwKeyPort();
  if (remoteServer) {
    remoteServer.removeAllListeners();
    remoteServer.stop();
    remoteServer = null;
  }
  destroyRemoteAudioWindow();
}

let _ssbModeBeforePtt = null; // original mode saved during DATA-mode PTT workaround
let _ssbOverDataYaesuWarned = false; // log the rig-menu hint once per session

function handleRemotePtt(state, opts = {}) {
  const target = settings.catTarget;
  const isFlexRig = target && target.type === 'tcp';

  // SSB-over-DATA only makes sense when audio is being sent to the rig
  // through the USB CODEC (voice macro, ECHOCAT audio bridge, FT8 modem,
  // SSTV, FreeDV). For naked PTT — user keying with a hand mic from
  // the desktop UI or phone — switching to DATA mode disables the rig's
  // own mic and produces silence on the air. KL7AC on TS-890S v1.5.9:
  // hit PTT in USB, rig went to PKTUSB and TX was dead. Caller now
  // declares whether the PTT carries audio (default: no).
  //
  // Special case: when the caller doesn't pass `audio` explicitly we
  // peek at known audio-active conditions (voice macro currently
  // playing, ECHOCAT audio bridge alive, FreeDV engine running) so
  // that legacy callers / older paths don't lose the auto-switch
  // behavior they depended on.
  const audioActive = (opts.audio === true) ||
    (opts.audio === undefined && (
      (remoteAudioWin && !remoteAudioWin.isDestroyed()) ||
      (typeof freedvEngine !== 'undefined' && freedvEngine)
    ));

  if (state && settings.ssbOverData && audioActive && !ft8Engine) {
    // Switch to DATA mode before TX to prevent local mic bleed
    // Skip when JTCAT is active — it manages its own DATA mode
    const curMode = (_currentMode || '').toUpperCase();
    if (curMode === 'USB' || curMode === 'LSB' || curMode === 'SSB' || curMode === 'FM' || curMode === 'AM') {
      const dataMode = (curMode === 'LSB') ? 'DIGL' : 'DIGU';
      _ssbModeBeforePtt = curMode;
      sendCatLog(`[PTT] ${curMode} -> ${dataMode} (SSB-over-DATA: mic disabled)`);
      // Yaesu rigs have a "DATA MODE" menu that controls whether DIGL/DIGU
      // behave as mic-disabled SSB (DATA MODE = Others/STD — carrier freq
      // unchanged) or as a subcarrier-offset PSK mode (DATA MODE = PSK —
      // actual RF shifts several hundred Hz below the dial). If the rig is
      // in PSK mode, SSB-over-DATA will put TX ~1 kHz off where the user
      // dialed it (AE4XO on FTDX10, 2026-04). Warn once per session.
      if (!_ssbOverDataYaesuWarned) {
        const activeRig = getActiveRigModel();
        if (activeRig && activeRig.brand === 'Yaesu') {
          _ssbOverDataYaesuWarned = true;
          sendCatLog('[PTT] Yaesu + SSB-over-DATA: verify the rig menu "DATA MODE" = Others (or DATA-STD), not PSK. PSK shifts the TX carrier by the subcarrier offset (~1500 Hz below the dial freq) and your TX will land off-frequency.');
        }
      }
      // Suppress mode broadcasts for the entire PTT duration + restore.
      _modeSuppressUntil = Date.now() + 120000;
      // Change mode only — don't retune frequency (avoids 0Hz bug when freq unknown).
      // Pass current freq so setModeOnly can re-anchor the VFO after the mode
      // change (Yaesu drifts by the filter-width diff on every mode swap).
      if (cat && cat.connected) {
        if (cat.setModeOnly) cat.setModeOnly(dataMode, _currentFreqHz);
        else if (_currentFreqHz) cat.tune(_currentFreqHz, dataMode);
      }
    }
  }

  if (isFlexRig) {
    // FlexRadio: prefer SmartSDR API so TX is pinned to POTACAT's slice. If
    // the SmartSDR API isn't available, fall back to the TS-2000 TX;/RX;
    // command via the TCP CAT shim — slice selection is lost but the radio
    // will at least key (W0MET silent-PTT report 2026-04-18).
    if (smartSdr && smartSdr.connected) {
      const sliceIndex = (settings.catTarget.port || 5002) - 5002;
      smartSdr.setActiveSlice(sliceIndex);
      smartSdr.setTxSlice(sliceIndex);
      smartSdr.setTransmit(state);
    } else if (cat && cat.connected) {
      if (state) sendCatLog('[PTT] SmartSDR API unavailable — falling back to TS-2000 TX; command (slice selection skipped)');
      cat.setTransmit(state);
    } else if (state) {
      console.warn('[PTT] Cannot key TX — neither SmartSDR API nor CAT TCP is connected');
      sendCatLog('PTT FAILED: neither SmartSDR API nor CAT TCP is connected');
    }
  } else {
    // Non-Flex rig (serial or rigctld): use TX;/RX; or T 1/T 0
    if (cat && cat.connected) {
      cat.setTransmit(state);
    } else if (state) {
      console.warn('[PTT] Cannot key TX — CAT not connected');
      sendCatLog('PTT FAILED: CAT not connected (TX audio may play but radio will not transmit)');
    }
  }

  if (!state && _ssbModeBeforePtt) {
    // Restore original voice mode after PTT release (mode-only, no retune)
    const restoreMode = _ssbModeBeforePtt;
    _ssbModeBeforePtt = null;
    sendCatLog(`[PTT] Restoring ${restoreMode} mode`);
    // Suppress mode broadcasts during restore so ECHOCAT doesn't flicker
    _modeSuppressUntil = Date.now() + 2000;
    if (cat && cat.connected) {
      if (cat.setModeOnly) cat.setModeOnly(restoreMode, _currentFreqHz);
      else if (_currentFreqHz) cat.tune(_currentFreqHz, restoreMode);
    }
  }

  _remoteTxState = state;

  // Broadcast to desktop UI
  if (win && !win.isDestroyed()) {
    win.webContents.send('remote-tx-state', state);
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.webContents.send('remote-tx-state', state);
  }
  // Broadcast to phone
  broadcastRemoteRadioStatus();
}

/** Apply FreeDV audio mute state to ECHOCAT WebRTC — called on state change and audio (re)connect */
/** Send full radio state to VFO popout */
function sendVfoState() {
  if (!vfoPopoutWin || vfoPopoutWin.isDestroyed()) return;
  vfoPopoutWin.webContents.send('vfo-radio-state', {
    freq: _currentFreqHz || 0,
    mode: _currentMode || '',
    filterWidth: _currentFilterWidth || 0,
    nb: _currentNbState,
    atu: _currentAtuState,
    customCatButtons: settings.customCatButtons || [],
  });
}

function applyFreedvAudioMute() {
  if (remoteAudioWin && !remoteAudioWin.isDestroyed()) {
    remoteAudioWin.webContents.send('freedv-mute', _freedvAudioMuted);
  }
}

function broadcastRemoteRadioStatus() {
  if (!remoteServer || !remoteServer.running) return;
  const rigType = detectRigType();
  const now = Date.now();
  // Suppress rfgain/txpower echo-back to ECHOCAT while user is actively adjusting
  const rfg = (typeof _rfGainSuppressBroadcast !== 'undefined' && now < _rfGainSuppressBroadcast) ? undefined : _currentRfGain;
  const txp = (typeof _txPowerSuppressBroadcast !== 'undefined' && now < _txPowerSuppressBroadcast) ? undefined : _currentTxPower;
  // Suppress stale mode during tune transition — phone has optimistic update, don't overwrite with old mode
  let modeVal = (now < _modeSuppressUntil) ? undefined : (_currentMode || '');
  // When FreeDV engine is active, show the FreeDV codec mode instead of raw USB/LSB
  if (modeVal && freedvEngine && (modeVal === 'USB' || modeVal === 'LSB')) {
    modeVal = 'FREEDV-' + (freedvEngine.mode || 'RADEV1').toUpperCase();
  }
  const status = {
    freq: _currentFreqHz || 0,
    mode: modeVal,
    catConnected: (cat && cat.connected) || (smartSdr && smartSdr.connected),
    txState: _remoteTxState,
    rigType,
    nb: _currentNbState,
    atu: _currentAtuState,
    vfo: _currentVfo,
    filterWidth: _currentFilterWidth,
    rfgain: rfg,
    txpower: txp,
    // Live meter readings — mobile VFO screen reads these from the
    // status snapshot. (Gap 10.) These are also sent as discrete
    // {type:'smeter'|'swr'|'alc'|'power'} frames for real-time updates;
    // including them on the snapshot ensures clients that connect mid-
    // session see the current values without waiting for the next poll.
    smeter: _currentSmeter,
    swr: _currentSwr,
    alc: _currentAlc,
    power: _currentPower,
    capabilities: getRigCapabilities(rigType),
  };
  remoteServer.broadcastRadioStatus(status);
}

// --- Remote Audio (hidden BrowserWindow for WebRTC) ---
async function startRemoteAudio() {
  // On macOS, request microphone permission before creating the audio window.
  // Without this, getUserMedia() silently returns an empty/silent stream.
  if (process.platform === 'darwin') {
    const { systemPreferences } = require('electron');
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      if (!granted) {
        console.error('[Echo CAT] Microphone permission denied by macOS');
        return;
      }
    }
  }

  // If window already exists, tell it to restart a fresh WebRTC session
  if (remoteAudioWin && !remoteAudioWin.isDestroyed()) {
    remoteAudioWin.webContents.send('remote-audio-start', {
      inputDeviceId: settings.remoteAudioInput || '',
      outputDeviceId: settings.remoteAudioOutput || '',
      useStun: !!settings.remoteStun,
    });
    // Re-apply FreeDV mute after audio restart
    if (_freedvAudioMuted) setTimeout(() => applyFreedvAudioMute(), 500);
    return;
  }

  remoteAudioWin = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-remote-audio.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });

  // Grant media permissions to the audio window's session
  remoteAudioWin.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(true));
  // Chromium 134+ may mute getUserMedia tracks in never-shown windows.
  // Briefly show off-screen so the renderer is "visible" during capture, then hide.
  remoteAudioWin.setPosition(-9999, -9999);
  remoteAudioWin.showInactive();

  remoteAudioWin.loadFile(path.join(__dirname, 'renderer', 'remote-audio.html'));

  remoteAudioWin.webContents.on('did-finish-load', () => {
    if (remoteAudioWin && !remoteAudioWin.isDestroyed()) {
      remoteAudioWin.webContents.send('remote-audio-start', {
        inputDeviceId: settings.remoteAudioInput || '',
        outputDeviceId: settings.remoteAudioOutput || '',
      });
      // Apply FreeDV mute if engine is active (audio window created after FreeDV started)
      if (_freedvAudioMuted) applyFreedvAudioMute();
    }
  });

  remoteAudioWin.on('closed', () => {
    remoteAudioWin = null;
  });
}

function destroyRemoteAudioWindow() {
  if (remoteAudioWin && !remoteAudioWin.isDestroyed()) {
    try { remoteAudioWin.webContents.send('remote-audio-stop'); } catch { /* may be destroyed */ }
    try { remoteAudioWin.close(); } catch { /* ignore */ }
  }
  // After ECHOCAT releases the audio device, tell renderer to restart JTCAT
  // audio capture if it was running — the shared device may need re-acquisition
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.webContents.send('restart-jtcat-audio');
  }, 500);
}

let lastTciPush = 0;

function pushSpotsToTci(spots) {
  if (!tciClient || !tciClient.connected) return;
  const now = Date.now();
  if (now - lastTciPush < 5000) return;
  lastTciPush = now;

  const tableMaxAgeMs = ((settings.maxAgeMin != null ? settings.maxAgeMin : 5) * 60000) || 300000;
  const tciMaxAgeMs = (settings.tciMaxAge != null ? settings.tciMaxAge : 15) * 60000;
  const maxAgeMs = tciMaxAgeMs > 0 ? Math.min(tciMaxAgeMs, tableMaxAgeMs) : tableMaxAgeMs;

  // Apply the user's panadapter-source allowlist — TCI is treated as a
  // panadapter destination (Casey: "what is good for the panadapter is
  // good for the bandscope" — same applies here).
  spots = spotsForPanadapter(spots);

  for (const spot of spots) {
    // Age filter — skip spots older than the effective max age (table age or panadapter age, whichever is smaller)
    if (maxAgeMs > 0 && spot.spotTime) {
      const t = spot.spotTime.endsWith('Z') ? spot.spotTime : spot.spotTime + 'Z';
      const age = now - new Date(t).getTime();
      if (age > maxAgeMs) continue;
    }
    tciClient.addSpot(spot);
  }
  // Remove spots no longer in the list (instead of clear+re-add which causes flashing)
  tciClient.pruneStaleSpots();
}

// --- CW Keyer ---

function connectKeyer() {
  disconnectKeyer();
  if (!settings.enableCwKeyer) return;

  // WinKeyer: hardware keyer handles its own iambic timing
  if (settings.cwKeyerType === 'winkeyer') {
    connectWinKeyer();
    return;
  }

  // IambicKeyer generates elements; raw key events sent directly to SmartSDR
  // via `cw key 0|1` + MOX control. Preserves operator's exact fist/timing.
  keyer = new IambicKeyer();
  keyer.setWpm(settings.cwWpm || 20);
  keyer.setMode(settings.cwKeyerMode || 'iambicB');
  keyer.setSwapPaddles(!!settings.cwSwapPaddles);

  keyer.on('key', ({ down }) => {
    // Send raw key event directly to radio with timestamps — preserves operator's fist
    if (smartSdr && smartSdr.connected) {
      if (down) {
        smartSdr.cwPttOn();  // activate CW PTT (with holdoff auto-release)
      }
      smartSdr.cwKey(down);
    }

    // Forward to renderer for sidetone
    if (win && !win.isDestroyed()) {
      win.webContents.send('cw-key', { down });
    }
  });

  // Bind to SmartSDR GUI client for CW config commands
  if (smartSdr) {
    smartSdr.setNeedsCw(true);
    if (smartSdr.connected) {
      smartSdr.setCwSpeed(settings.cwWpm || 20);
    }
  }

  if (win && !win.isDestroyed()) {
    win.webContents.send('cw-keyer-status', { enabled: true });
  }
}

function disconnectKeyer() {
  if (keyer) {
    keyer.stop();
    keyer.removeAllListeners();
    keyer = null;
  }
  disconnectWinKeyer();
  if (smartSdr) {
    if (smartSdr.connected) smartSdr.cwStop();
    smartSdr.setNeedsCw(false);
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('cw-keyer-status', { enabled: false });
  }
}

// --- Solar data ---
let _cachedSolarData = null;

function fetchSolarData() {
  const https = require('https');
  const req = https.get('https://www.hamqsl.com/solarxml.php', { timeout: 10000 }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      const sfi = (body.match(/<solarflux>\s*(\d+)\s*<\/solarflux>/) || [])[1];
      const aIndex = (body.match(/<aindex>\s*(\d+)\s*<\/aindex>/) || [])[1];
      const kIndex = (body.match(/<kindex>\s*(\d+)\s*<\/kindex>/) || [])[1];
      if (sfi && aIndex && kIndex) {
        const data = { sfi: parseInt(sfi, 10), aIndex: parseInt(aIndex, 10), kIndex: parseInt(kIndex, 10) };
        _cachedSolarData = data;
        if (win && !win.isDestroyed()) win.webContents.send('solar-data', data);
        if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.webContents.send('solar-data', data);
      }
    });
  });
  req.on('error', () => { /* silently ignore — pills keep last known values */ });
}

// --- Spot processing ---
function processPotaSpots(raw) {
  // Snapshot raw spots into the rolling history buffer (deduped by spotId)
  // before any per-callsign+band dedupe collapses them down to one row each.
  for (const s of raw) {
    const id = 'pota:' + (s.spotId != null
      ? s.spotId
      : (s.activator || '') + '|' + s.frequency + '|' + s.spotTime + '|' + (s.spotter || ''));
    if (_potaSpotIds.has(id)) continue;
    _potaSpotIds.add(id);
    _potaSpotHistory.push({
      _key: id,
      callsign: s.activator || '',
      reference: s.reference || '',
      frequency: s.frequency,
      mode: (s.mode || '').toUpperCase(),
      spotter: s.spotter || '',
      comments: s.comments || '',
      source: 'pota',
      spotTime: s.spotTime || '',
    });
  }
  if (_potaSpotHistory.length > _SPOT_HISTORY_CAP) {
    const dropped = _potaSpotHistory.splice(0, _potaSpotHistory.length - _SPOT_HISTORY_CAP);
    for (const e of dropped) _potaSpotIds.delete(e._key);
  }

  const myPos = gridToLatLon(settings.grid);
  const all = raw.map((s) => {
    const freqMHz = parseFloat(s.frequency) / 1000; // API gives kHz
    let distance = null;
    if (myPos) {
      let spotLat = parseFloat(s.latitude);
      let spotLon = parseFloat(s.longitude);
      if (isNaN(spotLat) || isNaN(spotLon)) {
        const grid = s.grid6 || s.grid4;
        const pos = grid ? gridToLatLon(grid) : null;
        if (pos) { spotLat = pos.lat; spotLon = pos.lon; }
      }
      if (!isNaN(spotLat) && !isNaN(spotLon)) {
        distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, spotLat, spotLon));
      }
    }
    // Resolve lat/lon for map plotting
    let lat = parseFloat(s.latitude);
    let lon = parseFloat(s.longitude);
    if (isNaN(lat) || isNaN(lon)) {
      const grid = s.grid6 || s.grid4;
      const pos = grid ? gridToLatLon(grid) : null;
      if (pos) { lat = pos.lat; lon = pos.lon; }
      else { lat = null; lon = null; }
    }

    // Resolve continent from cty.dat
    const callsign = s.activator || s.callsign || '';
    let continent = '';
    if (ctyDb && callsign) {
      const entity = resolveCallsign(callsign, ctyDb);
      if (entity) continent = entity.continent || '';
    }

    let spotBearing = null;
    if (myPos && lat != null && lon != null) {
      spotBearing = Math.round(bearing(myPos.lat, myPos.lon, lat, lon));
    }

    return {
      source: 'pota',
      callsign,
      frequency: s.frequency,
      freqMHz,
      mode: (s.mode || '').toUpperCase(),
      reference: s.reference || '',
      parkName: s.name || s.parkName || '',
      locationDesc: s.locationDesc || '',
      distance,
      bearing: spotBearing,
      lat,
      lon,
      band: freqToBand(freqMHz),
      spotTime: s.spotTime || '',
      continent,
      comments: s.comments || '',
      count: typeof s.count === 'number' ? s.count : null,
      wpm: (() => { const m = (s.comments || '').match(/(\d+)\s*WPM/i); return m ? parseInt(m[1], 10) : null; })(),
    };
  });
  // Dedupe: keep latest spot per callsign+band (allows multi-band activations)
  const seen = new Map();
  for (const s of all) { seen.set(s.callsign + '_' + s.band, s); }
  return [...seen.values()];
}

async function processSotaSpots(raw) {
  const myPos = gridToLatLon(settings.grid);

  // New API: summitCode is full ref "W7A/PE-097", split into assoc/code for coord lookup
  const spotsWithSplit = raw.map(s => {
    const ref = s.summitCode || '';
    const slashIdx = ref.indexOf('/');
    return {
      ...s,
      _ref: ref,
      associationCode: slashIdx > 0 ? ref.slice(0, slashIdx) : '',
      _summitCode: slashIdx > 0 ? ref.slice(slashIdx + 1) : ref,
    };
  });

  // Batch-fetch summit coordinates (cached across refreshes)
  await fetchSummitCoordsBatch(spotsWithSplit.map(s => ({
    associationCode: s.associationCode,
    summitCode: s._summitCode,
  })));

  const all = spotsWithSplit.filter((s) => {
    // Skip spots with no frequency (pre-announced activations with no QRG)
    const f = parseFloat(s.frequency);
    return !isNaN(f) && f > 0;
  }).map((s) => {
    const freqMHz = parseFloat(s.frequency);
    const freqKHz = Math.round(freqMHz * 1000); // SOTA gives MHz -> convert to kHz
    const ref = s._ref;
    const assoc = s.associationCode;

    // Look up cached summit coordinates
    const coords = ref ? summitCache.get(ref) : null;
    const lat = coords ? coords.lat : null;
    const lon = coords ? coords.lon : null;

    let distance = null;
    if (myPos && lat != null && lon != null) {
      distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, lat, lon));
    }

    // Resolve continent from cty.dat
    const callsign = s.activatorCallsign || '';
    let continent = '';
    if (ctyDb && callsign) {
      const entity = resolveCallsign(callsign, ctyDb);
      if (entity) continent = entity.continent || '';
    }

    let spotBearing = null;
    if (myPos && lat != null && lon != null) {
      spotBearing = Math.round(bearing(myPos.lat, myPos.lon, lat, lon));
    }

    return {
      source: 'sota',
      callsign,
      frequency: String(freqKHz),
      freqMHz,
      mode: (s.mode || '').toUpperCase(),
      reference: ref,
      parkName: s.summitName || s.summitDetails || '',
      locationDesc: getAssociationName(assoc),
      distance,
      bearing: spotBearing,
      lat,
      lon,
      band: freqToBand(freqMHz),
      spotTime: s.timeStamp || '',
      continent,
    };
  });
  // Dedupe: keep latest spot per callsign+band (allows multi-band activations)
  const seen = new Map();
  for (const s of all) { seen.set(s.callsign + '_' + s.band, s); }
  return [...seen.values()];
}

function processWwffSpots(raw) {
  // Mirror processPotaSpots — snapshot raw WWFF spots into history before
  // dedupe collapses them. WWFF has no spotId so we build a composite key
  // from activator + freq + spot_time.
  for (const s of raw) {
    const id = 'wwff:' + (s.activator || '') + '|' + s.frequency_khz + '|' + s.spot_time + '|' + (s.spotter || '');
    if (_wwffSpotIds.has(id)) continue;
    _wwffSpotIds.add(id);
    const spotTimeIso = s.spot_time ? new Date(s.spot_time * 1000).toISOString() : '';
    _wwffSpotHistory.push({
      _key: id,
      callsign: s.activator || '',
      reference: s.reference || '',
      frequency: String(s.frequency_khz),
      mode: (s.mode || '').toUpperCase(),
      spotter: s.spotter || '',
      comments: s.comments || '',
      source: 'wwff',
      spotTime: spotTimeIso,
    });
  }
  if (_wwffSpotHistory.length > _SPOT_HISTORY_CAP) {
    const dropped = _wwffSpotHistory.splice(0, _wwffSpotHistory.length - _SPOT_HISTORY_CAP);
    for (const e of dropped) _wwffSpotIds.delete(e._key);
  }

  const myPos = gridToLatLon(settings.grid);
  const all = raw.map((s) => {
    const freqKhz = s.frequency_khz;
    const freqMHz = freqKhz / 1000;
    const callsign = s.activator || '';
    const lat = s.latitude != null ? parseFloat(s.latitude) : null;
    const lon = s.longitude != null ? parseFloat(s.longitude) : null;

    let distance = null;
    if (myPos && lat != null && lon != null && !isNaN(lat) && !isNaN(lon)) {
      distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, lat, lon));
    }

    let continent = '', wwffLocationDesc = '';
    if (ctyDb && callsign) {
      const entity = resolveCallsign(callsign, ctyDb);
      if (entity) {
        continent = entity.continent || '';
        wwffLocationDesc = entity.name || '';
      }
    }

    let spotBearing = null;
    if (myPos && lat != null && lon != null && !isNaN(lat) && !isNaN(lon)) {
      spotBearing = Math.round(bearing(myPos.lat, myPos.lon, lat, lon));
    }

    // Convert Unix timestamp to ISO string
    let spotTime = '';
    if (s.spot_time) {
      spotTime = new Date(s.spot_time * 1000).toISOString();
    }

    return {
      source: 'wwff',
      callsign,
      frequency: String(freqKhz),
      freqMHz,
      mode: (s.mode || '').toUpperCase(),
      reference: s.reference || '',
      parkName: s.reference_name || '',
      locationDesc: wwffLocationDesc,
      distance,
      bearing: spotBearing,
      lat: (lat != null && !isNaN(lat)) ? lat : null,
      lon: (lon != null && !isNaN(lon)) ? lon : null,
      band: freqToBand(freqMHz),
      spotTime,
      continent,
    };
  });
  // Dedupe: keep latest spot per callsign+band (allows multi-band activations)
  const seen = new Map();
  for (const s of all) { seen.set(s.callsign + '_' + s.band, s); }
  return [...seen.values()];
}

// History buffer for Tiles (mirrors _wwffSpotIds / _wwffSpotHistory pattern).
const _tilesSpotIds = new Set();
const _tilesSpotHistory = [];
const _SPOT_HISTORY_CAP_TILES = 500;

// Tiles API spot envelope:
//   { id, call_sign, frequency, mode, maidenhead_grid, latitude, longitude,
//     notes, pota_ref, sota_ref, created_at }
// Activation reference IS the maidenhead grid (no separate "tile id").
// Spots can also carry pota_ref / sota_ref for cross-program activations.
function processTilesSpots(raw) {
  if (!Array.isArray(raw)) return [];

  // Snapshot raw spots into history before dedupe collapses them. The id
  // field is a UUID so it's unique enough to use as the dedupe key.
  for (const s of raw) {
    const id = 'tiles:' + (s.id || '');
    if (_tilesSpotIds.has(id)) continue;
    _tilesSpotIds.add(id);
    const freqKhz = parseTilesFreqKhz(s.frequency);
    _tilesSpotHistory.push({
      _key: id,
      callsign: s.call_sign || '',
      reference: s.maidenhead_grid || '',
      frequency: String(freqKhz),
      mode: (s.mode || '').toUpperCase(),
      spotter: '', // Tiles API doesn't expose the spotter
      comments: s.notes || '',
      source: 'tiles',
      spotTime: s.created_at || '',
    });
  }
  if (_tilesSpotHistory.length > _SPOT_HISTORY_CAP_TILES) {
    const dropped = _tilesSpotHistory.splice(0, _tilesSpotHistory.length - _SPOT_HISTORY_CAP_TILES);
    for (const e of dropped) _tilesSpotIds.delete(e._key);
  }

  const myPos = gridToLatLon(settings.grid);
  return raw.map((s) => {
    const freqKhz = parseTilesFreqKhz(s.frequency);
    const freqMHz = freqKhz / 1000;
    const callsign = s.call_sign || '';
    const grid = s.maidenhead_grid || '';
    const lat = (s.latitude != null && !isNaN(parseFloat(s.latitude))) ? parseFloat(s.latitude) : null;
    const lon = (s.longitude != null && !isNaN(parseFloat(s.longitude))) ? parseFloat(s.longitude) : null;

    let distance = null;
    if (myPos && lat != null && lon != null) {
      distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, lat, lon));
    }

    let continent = '', locationDesc = '';
    if (ctyDb && callsign) {
      const entity = resolveCallsign(callsign, ctyDb);
      if (entity) {
        continent = entity.continent || '';
        locationDesc = entity.name || '';
      }
    }

    let spotBearing = null;
    if (myPos && lat != null && lon != null) {
      spotBearing = Math.round(bearing(myPos.lat, myPos.lon, lat, lon));
    }

    return {
      source: 'tiles',
      callsign,
      frequency: String(freqKhz),
      freqMHz,
      mode: (s.mode || '').toUpperCase(),
      reference: grid,        // activation ref IS the grid square
      parkName: '',           // no separate tile name
      grid,                   // also surfaced for the map / grid column
      // Cross-program tags so the table can show "POTA US-9787" alongside
      // a Tiles spot when the activator is also doing POTA.
      potaReference: s.pota_ref || '',
      sotaReference: s.sota_ref || '',
      locationDesc,
      distance,
      bearing: spotBearing,
      lat, lon,
      band: freqToBand(freqMHz),
      spotTime: s.created_at || '',
      continent,
      comments: s.notes || '',
    };
  });
}

function processLlotaSpots(raw) {
  const myPos = gridToLatLon(settings.grid);
  const all = raw.filter(s => s.is_active !== false).map((s) => {
    // Frequency may be kHz (14250) or MHz (14.250) — normalize
    let freqNum = typeof s.frequency === 'string' ? parseFloat(s.frequency) : (s.frequency || 0);
    let freqMHz = freqNum >= 1000 ? freqNum / 1000 : freqNum;
    let freqKhz = freqNum >= 1000 ? Math.round(freqNum) : Math.round(freqNum * 1000);

    const callsign = s.callsign || '';

    // No lat/lon in LLOTA API — resolve approximate location from cty.dat
    let lat = null, lon = null, continent = '', ctyName = '';
    if (ctyDb && callsign) {
      const entity = resolveCallsign(callsign, ctyDb);
      if (entity) {
        continent = entity.continent || '';
        ctyName = entity.name || '';
        lat = entity.lat != null ? entity.lat : null;
        lon = entity.lon != null ? entity.lon : null;
      }
    }
    // Prefer country_name from LLOTA API, fall back to cty.dat entity name
    const locationDesc = s.country_name || ctyName;

    let distance = null;
    if (myPos && lat != null && lon != null) {
      distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, lat, lon));
    }

    let spotBearing = null;
    if (myPos && lat != null && lon != null) {
      spotBearing = Math.round(bearing(myPos.lat, myPos.lon, lat, lon));
    }

    // Use updated_at or created_at for spot time
    let spotTime = '';
    if (s.updated_at) {
      spotTime = s.updated_at.endsWith('Z') ? s.updated_at : s.updated_at + 'Z';
    } else if (s.created_at) {
      spotTime = s.created_at.endsWith('Z') ? s.created_at : s.created_at + 'Z';
    }

    return {
      source: 'llota',
      callsign,
      frequency: String(freqKhz),
      freqMHz,
      mode: (s.mode || '').toUpperCase(),
      reference: s.reference || '',
      parkName: s.reference_name || '',
      locationDesc,
      distance,
      bearing: spotBearing,
      lat,
      lon,
      band: freqToBand(freqMHz),
      spotTime,
      continent,
    };
  });
  // Dedupe: keep latest spot per callsign+band (allows multi-band activations)
  const seen = new Map();
  for (const s of all) { seen.set(s.callsign + '_' + s.band, s); }
  return [...seen.values()];
}

let lastPotaSotaSpots = []; // cache of last fetched POTA+SOTA+WWFF+LLOTA spots

// --- Net Reminder helpers ---

function isNetScheduledToday(net, today) {
  if (!net.enabled) return false;
  const sched = net.schedule;
  if (!sched) return true; // no schedule = always
  if (sched.type === 'daily') return true;
  if (sched.type === 'weekly') {
    const dow = today.getDay(); // 0=Sun
    return Array.isArray(sched.days) && sched.days.includes(dow);
  }
  if (sched.type === 'dates') {
    const iso = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');
    return Array.isArray(sched.dates) && sched.dates.includes(iso);
  }
  return false;
}

function getNetTimes(net, today) {
  const [hh, mm] = (net.startTime || '00:00').split(':').map(Number);
  let startMs;
  if (net.timeZone === 'utc') {
    startMs = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), hh, mm);
  } else {
    startMs = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hh, mm).getTime();
  }
  const dur = (net.duration || 60) * 60000;
  const lead = (net.leadTime != null ? net.leadTime : 15) * 60000;
  return { startMs, endMs: startMs + dur, showMs: startMs - lead };
}

function getActiveNetSpots() {
  const nets = settings.netReminders;
  if (!Array.isArray(nets) || nets.length === 0) return [];
  const now = Date.now();
  const spots = [];
  // Check today and yesterday (for midnight-spanning nets)
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const net of nets) {
    if (!net.enabled) continue;
    let startMs, endMs;
    let scheduled = false;
    // Check today
    if (isNetScheduledToday(net, today)) {
      const t = getNetTimes(net, today);
      if (now < t.endMs) {
        scheduled = true;
        startMs = t.startMs; endMs = t.endMs;
      }
    }
    // Check yesterday (midnight spanning)
    if (!scheduled && isNetScheduledToday(net, yesterday)) {
      const t = getNetTimes(net, yesterday);
      if (now < t.endMs) {
        scheduled = true;
        startMs = t.startMs; endMs = t.endMs;
      }
    }
    if (!scheduled) continue;

    // Build comments string
    let comments;
    if (now >= startMs) {
      const minsLeft = Math.ceil((endMs - now) / 60000);
      comments = minsLeft >= 60
        ? `On air \u2014 ${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m left`
        : `On air \u2014 ${minsLeft}m left`;
    } else {
      const minsUntil = Math.ceil((startMs - now) / 60000);
      if (minsUntil >= 60) {
        const h = Math.floor(minsUntil / 60);
        const m = minsUntil % 60;
        comments = m > 0 ? `Starts in ${h}h ${m}m` : `Starts in ${h}h`;
      } else {
        comments = `Starts in ${minsUntil}m`;
      }
    }

    spots.push({
      source: 'net',
      callsign: net.name || 'Net',
      frequency: String(net.frequency),
      freqMHz: (net.frequency / 1000).toFixed(4),
      mode: net.mode || 'SSB',
      band: freqToBand(net.frequency / 1000),
      spotTime: new Date(startMs).toISOString(),
      comments,
      reference: '', parkName: '', locationDesc: '',
      distance: null, bearing: null, lat: null, lon: null, continent: null,
      _netId: net.id,
    });
  }
  return spots;
}

// Priority order for cross-source dedup. Same callsign + same kHz across these
// sources is the same activator; we collapse to one row whose `source` is the
// highest-priority hit (drives the badge color + bandspread color), with a
// `sources` array listing every source that reported it. Sources outside this
// map (rbn / pskr / freedv / net) pass through untouched — they're per-skimmer
// reception reports, not "the same spot from another spotter".
const _DEDUPE_PRIORITY = { pota: 0, sota: 1, llota: 2, wwff: 3, cwspots: 4, dxc: 5 };

function dedupeCrossSource(spots) {
  const groups = new Map();
  const passthrough = [];
  for (const s of spots) {
    if (_DEDUPE_PRIORITY[s.source] == null) { passthrough.push(s); continue; }
    const fkhz = Math.round(parseFloat(s.frequency) || 0);
    const key = (s.callsign || '').toUpperCase() + '_' + fkhz;
    if (!key || fkhz === 0) { passthrough.push(s); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const collapsed = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      // Still tag with sources:[s.source] so renderer code has a single path.
      const s = group[0];
      collapsed.push(s.sources ? s : { ...s, sources: [s.source] });
      continue;
    }
    group.sort((a, b) => _DEDUPE_PRIORITY[a.source] - _DEDUPE_PRIORITY[b.source]);
    const sources = [];
    const seen = new Set();
    for (const s of group) {
      // Honor a pre-existing sources array (the POTA↔WWFF dual-park merge
      // already tags the survivor with ['pota','wwff']) so we don't drop the
      // WWFF tag when a DX/CW spot also matches the same call+freq.
      const tagged = Array.isArray(s.sources) && s.sources.length > 0 ? s.sources : [s.source];
      for (const src of tagged) {
        if (!seen.has(src)) { seen.add(src); sources.push(src); }
      }
    }
    // Clone the survivor so we don't mutate the source-of-truth arrays
    // (lastPotaSotaSpots / clusterSpots / cwSpots).
    const survivor = { ...group[0], sources };
    // Preserve secondary program references on the survivor so the log
    // dialog (and ADIF writer) can include them on a dual-program contact.
    // KK4DF report: K4FR was spotted on both POTA AND SOTA; without this,
    // the dedup kept only the POTA reference and the SOTA ref vanished.
    for (const s of group) {
      if (s.source === 'pota' && s.reference && !survivor.potaReference) survivor.potaReference = s.reference;
      if (s.source === 'sota' && s.reference && !survivor.sotaReference) survivor.sotaReference = s.reference;
      if (s.source === 'llota' && s.reference && !survivor.llotaReference) survivor.llotaReference = s.reference;
      if (s.source === 'wwff' && s.reference && !survivor.wwffReference) survivor.wwffReference = s.reference;
      // Park names too, for the info display in the log dialog.
      if (s.source === 'sota' && s.parkName && !survivor.sotaParkName) survivor.sotaParkName = s.parkName;
      if (s.source === 'llota' && s.parkName && !survivor.llotaParkName) survivor.llotaParkName = s.parkName;
    }
    collapsed.push(survivor);
  }
  return [...passthrough, ...collapsed];
}

function sendMergedSpots() {
  if (!win || win.isDestroyed()) return;
  const netSpots = getActiveNetSpots();
  const raw = [...netSpots, ...lastPotaSotaSpots, ...clusterSpots, ...cwSpots, ...rbnWatchSpots, ...pskrSpots, ...freedvReporterSpots];
  const merged = dedupeCrossSource(raw);
  lastMergedSpots = merged; // cached for the bandspread-popout-push override
  win.webContents.send('spots', merged);
  pushSpotsToSmartSdr(merged);
  pushSpotsToTci(merged);
  // Forward to ECHOCAT — all modes (phone-side Mode dropdown handles filtering), respect max spot age
  if (remoteServer && remoteServer.running) {
    const maxAgeMs = ((settings.maxAgeMin != null ? settings.maxAgeMin : 5) * 60000) || 300000;
    const dxcMaxAgeMs = ((settings.dxcMaxAge != null ? settings.dxcMaxAge : 15) * 60000) || 900000;
    const sotaMaxAgeMs = ((settings.sotaMaxAge != null ? settings.sotaMaxAge : 30) * 60000) || 1800000;
    const now = Date.now();
    const echoSpots = merged.filter(s => {
      // Net spots always pass through to ECHOCAT
      if (s.source === 'net') return true;
      // Age filter — pick per-source window
      if (s.spotTime) {
        const t = s.spotTime.endsWith('Z') ? s.spotTime : s.spotTime + 'Z';
        const age = now - new Date(t).getTime();
        let limit = maxAgeMs;
        if (s.source === 'dxc') limit = dxcMaxAgeMs;
        else if (s.source === 'sota') limit = sotaMaxAgeMs;
        if (age > limit) return false;
      }
      return true;
    });
    remoteServer.broadcastSpots(echoSpots);
  }
  // Forward to spots pop-out if open
  if (spotsPopoutWin && !spotsPopoutWin.isDestroyed()) {
    spotsPopoutWin.webContents.send('spots-popout-data', merged);
  }
  // Forward to bandspread pop-out if open (reuses 'spots' channel) — apply
  // the same panadapter-source filter so bandspread mirrors the panadapter
  // (sync-with-table by default, or the operator's independent picks).
  if (bandspreadPopoutWin && !bandspreadPopoutWin.isDestroyed()) {
    bandspreadPopoutWin.webContents.send('spots', spotsForPanadapter(merged));
  }
  // Trigger QRZ lookups for new callsigns (async, non-blocking)
  if (qrz.configured && settings.enableQrz) {
    const callsigns = [...new Set(merged.map(s => s.callsign))];
    qrz.batchLookup(callsigns).then(results => {
      if (!win || win.isDestroyed()) return;
      // Convert Map to plain object for IPC
      const data = {};
      for (const [cs, info] of results) {
        if (info) data[cs] = info;
      }
      if (Object.keys(data).length > 0) {
        win.webContents.send('qrz-data', data);
        // Forward operator names to ECHOCAT for the Name column. Compose
        // first + last so the phone gets "Casey Stanton" instead of just
        // "Casey" — short names alone are ambiguous in spot rows. Falls
        // back to first-only when the QRZ entry has no surname. (Gap 8.)
        if (remoteServer && remoteServer.hasClient()) {
          const names = {};
          for (const [cs, info] of Object.entries(data)) {
            const first = (info.nickname || info.fname || '').trim();
            const last = (info.name || '').trim();
            names[cs] = last && first ? `${first} ${last}` : first;
          }
          remoteServer.sendToClient({ type: 'qrz-names', data: names });
        }
      }
    }).catch(() => { /* ignore QRZ errors */ });
  }
}

async function refreshSpots() {
  try {
    // A source fetches if either the table side wants it (settings.enableX)
    // or the panadapter has independently asked for it. Without the OR-in
    // there's no way to feed "DX on panadapter only / POTA on table only"
    // workflows (K0OTC 2026-04-30).
    const enablePota = settings.enablePota !== false || panadapterWantsSource('pota');
    const enableSota = settings.enableSota === true   || panadapterWantsSource('sota');
    const enableWwff = settings.enableWwff === true   || panadapterWantsSource('wwff');
    const enableLlota = settings.enableLlota === true || panadapterWantsSource('llota');
    const enableTiles = settings.enableTiles !== false || panadapterWantsSource('tiles');

    const fetches = [];
    if (enablePota) fetches.push(fetchPotaSpots().then(processPotaSpots));
    if (enableSota) fetches.push(fetchSotaSpots().then(processSotaSpots));
    if (enableWwff) fetches.push(fetchWwffSpots().then(processWwffSpots));
    if (enableLlota) fetches.push(fetchLlotaSpots().then(processLlotaSpots));
    if (enableTiles) fetches.push(fetchTilesSpots().then(processTilesSpots));

    const results = await Promise.allSettled(fetches);
    const allSpots = results
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    // Cross-reference all program sources (POTA/SOTA/WWFF/LLOTA/Tiles):
    // when the same callsign appears at the same frequency from multiple
    // program APIs, that's one operator activating multiple programs at
    // once (very common — a park is often also a WWFF site, and lately
    // also a Tiles square). Collapse the duplicates into one row whose
    // primary `reference` is the highest-priority program's ref, with the
    // others decorated as <source>Reference / <source>ParkName.
    //
    // Priority order is "what the operator most likely cares about
    // logging first": POTA > SOTA > WWFF > LLOTA > Tiles. Adjust here
    // if community usage shifts. (Casey 2026-05-04.)
    const PROGRAM_PRIORITY = ['pota', 'sota', 'wwff', 'llota', 'tiles'];
    const SECONDARY_FIELDS = {
      pota: { ref: 'potaReference', name: 'potaParkName' },
      sota: { ref: 'sotaReference', name: 'sotaParkName' },
      wwff: { ref: 'wwffReference', name: 'wwffParkName' },
      llota: { ref: 'llotaReference', name: 'llotaParkName' },
      tiles: { ref: 'tilesReference', name: 'tilesParkName' },
    };
    const programSpots = allSpots.filter(s => PROGRAM_PRIORITY.includes(s.source));
    const otherSpots = allSpots.filter(s => !PROGRAM_PRIORITY.includes(s.source));

    if (programSpots.length > 0) {
      const groups = new Map();
      for (const s of programSpots) {
        const key = (s.callsign || '').toUpperCase() + '|' + String(Math.round(parseFloat(s.frequency || 0)));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
      const dropped = new Set();
      const merged = [];
      for (const group of groups.values()) {
        // Sort by priority — primary is the first program in the order
        group.sort((a, b) => PROGRAM_PRIORITY.indexOf(a.source) - PROGRAM_PRIORITY.indexOf(b.source));
        const primary = group[0];
        if (group.length > 1) {
          primary.sources = group.map(s => s.source);
          for (let i = 1; i < group.length; i++) {
            const sec = group[i];
            const fields = SECONDARY_FIELDS[sec.source];
            if (fields) {
              primary[fields.ref] = sec.reference;
              primary[fields.name] = sec.parkName || '';
            }
            dropped.add(sec);
          }
        }
        // Tiles spots can ALSO carry pota_ref/sota_ref baked into the API
        // payload itself (the Tiles back-end records the cross-program
        // tags on the spot). Fold those into `sources` too so badges
        // render correctly even when no separate POTA/SOTA fetch matched.
        if (primary.source === 'tiles') {
          if (primary.potaReference && !primary.sources) primary.sources = ['tiles', 'pota'];
          else if (primary.potaReference && primary.sources && !primary.sources.includes('pota')) primary.sources.push('pota');
          if (primary.sotaReference && !primary.sources) primary.sources = ['tiles', 'sota'];
          else if (primary.sotaReference && primary.sources && !primary.sources.includes('sota')) primary.sources.push('sota');
        }
        merged.push(primary);
      }
      // Anything we didn't drop made it into `merged`; otherSpots are
      // non-program (RBN/cluster/PSKR/etc.) which dedupe should leave alone.
      lastPotaSotaSpots = [...merged.filter(s => !dropped.has(s)), ...otherSpots];
    } else {
      lastPotaSotaSpots = allSpots;
    }

    sendMergedSpots();

    // Update WSJT-X callsign highlights with fresh activator list
    if (wsjtx && wsjtx.connected && settings.wsjtxHighlight) {
      scheduleWsjtxHighlights();
    }

    // Watchlist notifications for POTA/SOTA spots (5-min dedup in notifyWatchlistSpot)
    const potaSotaWatchRules = parseWatchlist(settings.watchlist);
    if (potaSotaWatchRules.length > 0) {
      for (const spot of lastPotaSotaSpots) {
        if (watchlistMatch(potaSotaWatchRules, spot.callsign, spot.band, spot.mode)) {
          notifyWatchlistSpot({
            callsign: spot.callsign,
            frequency: spot.frequency,
            mode: spot.mode,
            source: spot.source,
            reference: spot.reference,
            locationDesc: spot.locationDesc,
          });
        }
      }
    }

    // Report errors from rejected fetches
    const errors = results.filter((r) => r.status === 'rejected');
    if (errors.length > 0 && lastPotaSotaSpots.length === 0 && win && !win.isDestroyed()) {
      win.webContents.send('spots-error', errors[0].reason.message);
    }
  } catch (err) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('spots-error', err.message);
    }
  }
}

// --- DXCC data builder ---
async function buildDxccData() {
  if (!ctyDb) return null;
  const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
  if (!fs.existsSync(logPath)) return null;
  try {
    const qsos = isSqliteFile(logPath)
      ? await parseSqliteConfirmed(logPath)
      : parseAdifFile(logPath, { confirmedOnly: false });

    // Build confirmation map: entityIndex -> { band -> Set<mode> }
    const confirmMap = new Map();

    for (const qso of qsos) {
      // Use DXCC field from ADIF if present, otherwise resolve via cty.dat
      let entIdx = null;
      if (qso.dxcc != null) {
        // Find entity by matching DXCC number — cty.dat doesn't store DXCC numbers directly,
        // so we resolve the callsign instead
        const entity = resolveCallsign(qso.call, ctyDb);
        if (entity) {
          entIdx = ctyDb.entities.indexOf(entity);
        }
      } else {
        const entity = resolveCallsign(qso.call, ctyDb);
        if (entity) {
          entIdx = ctyDb.entities.indexOf(entity);
        }
      }
      if (entIdx == null || entIdx < 0) continue;

      if (!confirmMap.has(entIdx)) confirmMap.set(entIdx, {});
      const bands = confirmMap.get(entIdx);
      if (!bands[qso.band]) bands[qso.band] = new Set();
      bands[qso.band].add(qso.mode);
    }

    // Build entity list with confirmations
    const allEnts = ctyDb.entities.map((ent, idx) => {
      const confirmed = {};
      const bandData = confirmMap.get(idx);
      if (bandData) {
        for (const [band, modes] of Object.entries(bandData)) {
          confirmed[band] = [...modes];
        }
      }
      return {
        name: ent.name,
        prefix: ent.prefix,
        continent: ent.continent,
        confirmed,
      };
    });

    // Sort by entity name
    allEnts.sort((a, b) => a.name.localeCompare(b.name));

    return { entities: allEnts };
  } catch (err) {
    console.error('Failed to parse ADIF:', err.message);
    return null;
  }
}

async function sendDxccData() {
  const data = await buildDxccData();
  if (data && win && !win.isDestroyed()) {
    win.webContents.send('dxcc-data', data);
  }
}

// --- Worked QSOs tracking ---
function loadWorkedQsos() {
  if (!settings.adifLogPath) return;
  try {
    workedQsos = parseWorkedQsos(settings.adifLogPath);
    if (win && !win.isDestroyed()) {
      win.webContents.send('worked-qsos', [...workedQsos.entries()]);
    }
  } catch (err) {
    console.error('Failed to parse worked QSOs:', err.message);
  }
  buildQsoDetailsIndex();
  buildRosterSets();
}

// --- qsoDetails index — for the ragchew log pop-out ---

/** Strip a /SUFFIX so K3SBP/4 and K3SBP both index under K3SBP. */
function normalizeCallForIndex(call) {
  return String(call || '').toUpperCase().split('/')[0].trim();
}

/** Pick the best-available reference from an ADIF record (POTA/SOTA/WWFF/etc). */
function adifRef(rec) {
  if (rec.SIG && rec.SIG_INFO) return `${rec.SIG.toUpperCase()} ${rec.SIG_INFO.toUpperCase()}`;
  if (rec.POTA_REF) return `POTA ${rec.POTA_REF.toUpperCase()}`;
  if (rec.SOTA_REF) return `SOTA ${rec.SOTA_REF.toUpperCase()}`;
  if (rec.WWFF_REF) return `WWFF ${rec.WWFF_REF.toUpperCase()}`;
  return '';
}

/** Convert ADIF FREQ (MHz string) to integer kHz, e.g. "14.074" → 14074. */
function adifFreqToKhz(freq) {
  if (!freq) return null;
  const mhz = parseFloat(freq);
  if (!isFinite(mhz)) return null;
  return Math.round(mhz * 1000);
}

/** Build qsoDetails Map by parsing the full ADIF log. */
function buildQsoDetailsIndex() {
  qsoDetails = new Map();
  if (!settings.adifLogPath || !fs.existsSync(settings.adifLogPath)) return;
  try {
    const all = parseAllRawQsos(settings.adifLogPath);
    for (const rec of all) {
      const key = normalizeCallForIndex(rec.CALL);
      if (!key) continue;
      const entry = {
        call: rec.CALL || key,
        date: rec.QSO_DATE || '',
        time: rec.TIME_ON || '',
        mode: rec.MODE || '',
        freq: adifFreqToKhz(rec.FREQ),
        band: rec.BAND || '',
        comment: rec.COMMENT || '',
        ref: adifRef(rec),
      };
      if (!qsoDetails.has(key)) qsoDetails.set(key, []);
      qsoDetails.get(key).push(entry);
    }
    // Newest-first within each callsign's list.
    for (const list of qsoDetails.values()) {
      list.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    }
  } catch (err) {
    console.error('[qsoDetails] failed to build index:', err.message);
  }
}

/** Push a freshly-saved QSO into the in-memory index without re-parsing the log. */
function appendToQsoDetailsIndex(qsoData) {
  if (!qsoData || !qsoData.callsign) return;
  const key = normalizeCallForIndex(qsoData.callsign);
  if (!key) return;
  // qsoData fields come from the renderer's save form. Frequency arrives as
  // string kHz; we store as integer kHz for consistency with parsed records.
  const freq = qsoData.frequency != null ? Math.round(parseFloat(qsoData.frequency)) : null;
  const ref = qsoData.sig && qsoData.sigInfo
    ? `${String(qsoData.sig).toUpperCase()} ${String(qsoData.sigInfo).toUpperCase()}`
    : (qsoData.potaRef ? `POTA ${qsoData.potaRef}` : '');
  const entry = {
    call: qsoData.callsign,
    date: (qsoData.qsoDate || '').replace(/-/g, ''),
    time: (qsoData.timeOn || '').replace(/:/g, ''),
    mode: qsoData.mode || '',
    freq: isFinite(freq) ? freq : null,
    band: qsoData.band || '',
    comment: qsoData.comment || '',
    ref,
  };
  if (!qsoDetails.has(key)) qsoDetails.set(key, []);
  // Insert at front (newest-first invariant).
  qsoDetails.get(key).unshift(entry);
}

/** Look up past QSOs for a callsign. Optional `limit` caps the result. */
function lookupPastQsos(call, limit) {
  const key = normalizeCallForIndex(call);
  const list = qsoDetails.get(key) || [];
  return limit ? list.slice(0, limit) : list.slice();
}

// --- Call Roster "needed" sets ---
function buildRosterSets() {
  rosterWorkedDxcc.clear();
  rosterWorkedCalls.clear();
  rosterWorkedGrids.clear();
  const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
  if (!fs.existsSync(logPath)) return;
  try {
    const qsos = isSqliteFile(logPath) ? null : parseAllQsos(logPath);
    if (!qsos) return; // SQLite logs don't have grids reliably, skip for now
    for (const q of qsos) {
      const call = (q.call || '').toUpperCase();
      if (!call) continue;
      rosterWorkedCalls.add(call);
      // Grid
      const grid = (q.gridsquare || '').toUpperCase().substring(0, 4);
      if (grid && /^[A-R]{2}\d{2}$/.test(grid)) rosterWorkedGrids.add(grid);
      // DXCC entity per band
      const band = (q.band || '').toLowerCase();
      if (band && ctyDb) {
        const entity = resolveCallsign(call, ctyDb);
        if (entity) rosterWorkedDxcc.add(entity.name + '|' + band);
      }
    }
    console.log('[Roster] Built needed sets: ' + rosterWorkedDxcc.size + ' dxcc-band, ' + rosterWorkedCalls.size + ' calls, ' + rosterWorkedGrids.size + ' grids');
  } catch (err) {
    console.error('Failed to build roster sets:', err.message);
  }
}

// --- Worked parks tracking ---

// Supplemental file for parks worked via POTACAT (persists across restarts)
const WORKED_PARKS_LOCAL_PATH = path.join(app.getPath('userData'), 'worked-parks-local.json');

// Voice macro file storage (shared between desktop and ECHOCAT)
const VOICE_MACRO_DIR = path.join(app.getPath('userData'), 'voice-macros');
function ensureVoiceMacroDir() { if (!fs.existsSync(VOICE_MACRO_DIR)) fs.mkdirSync(VOICE_MACRO_DIR, { recursive: true }); }
function voiceMacroPath(idx) { return path.join(VOICE_MACRO_DIR, `macro-${idx}.webm`); }

function loadLocalWorkedParks() {
  try {
    if (fs.existsSync(WORKED_PARKS_LOCAL_PATH)) {
      const data = JSON.parse(fs.readFileSync(WORKED_PARKS_LOCAL_PATH, 'utf-8'));
      return Array.isArray(data) ? data : [];
    }
  } catch {}
  return [];
}

// Walk the user's main ADIF log and pull every POTA reference out. Used
// to seed workedParks from imported logs (N3FJP/HRD/HAMRS/etc.) without
// needing pota.app's CSV download — that endpoint is IAM-authorized via
// SigV4 and POTACAT's Cognito JWT can't hit it. The local log is the
// authoritative source anyway: any QSO the user has logged is a park
// they've worked, regardless of whether pota.app has ingested the QSO yet.
//
// Scans both standard ADIF (SIG=POTA + SIG_INFO=<ref>) and the de-facto
// POTA_REF custom field that most major loggers also write. Comma-or-
// space-separated refs (n-fers) are split into individual references.
function harvestParksFromLog(logPath) {
  try {
    if (!logPath || !fs.existsSync(logPath)) return [];
    const qsos = parseAllRawQsos(logPath);
    const refs = new Set();
    for (const q of qsos) {
      const potaRef = (q.POTA_REF || '').trim().toUpperCase();
      if (potaRef) for (const r of potaRef.split(/[,\s]+/)) if (r) refs.add(r);
      const sig = (q.SIG || '').trim().toUpperCase();
      const sigInfo = (q.SIG_INFO || '').trim().toUpperCase();
      if (sig === 'POTA' && sigInfo) {
        for (const r of sigInfo.split(/[,\s]+/)) if (r) refs.add(r);
      }
    }
    return [...refs];
  } catch (err) {
    console.error('harvestParksFromLog failed:', err.message);
    return [];
  }
}

function saveLocalWorkedPark(ref) {
  try {
    const existing = loadLocalWorkedParks();
    if (!existing.includes(ref)) {
      existing.push(ref);
      fs.writeFileSync(WORKED_PARKS_LOCAL_PATH, JSON.stringify(existing));
    }
  } catch (err) {
    console.error('Failed to save local worked park:', err.message);
  }
}

function loadWorkedParks() {
  // Two sources, kept separate so the renderer can pick which one to
  // use for ATNO detection:
  //   creditedParks — POTA hunter CSV only (parks pota.app says you have
  //                   credit for). Empty if no CSV is loaded.
  //   workedParks   — credited + parks logged locally + parks harvested
  //                   from the user's ADIF log. This is what we've always
  //                   used; K0OTC pointed out that local-only QSOs that
  //                   never reached pota.app shouldn't suppress an ATNO
  //                   alert for the same park, so the strict-mode toggle
  //                   in the renderer can switch to creditedParks.
  let creditedParks = new Map();
  if (settings.potaParksPath) {
    try {
      creditedParks = parsePotaParksCSV(settings.potaParksPath);
    } catch (err) {
      console.error('Failed to parse POTA parks CSV:', err.message);
    }
  }
  workedParks = new Map(creditedParks);

  // Merge in parks worked via POTACAT's own logger (persisted locally)
  const localParks = loadLocalWorkedParks();
  for (const ref of localParks) {
    if (!workedParks.has(ref)) {
      workedParks.set(ref, { reference: ref });
    }
  }
  // Merge in parks harvested from the user's main QSO log file. This is
  // how imported logs (N3FJP/HRD/HAMRS/etc., 12k+ QSOs in some cases)
  // get their park refs into workedParks without depending on pota.app's
  // IAM-authorized CSV endpoint. The harvest runs once per call here; the
  // file walk on a 13k-record log takes ~200-500ms so we keep this
  // out of the hot path and just rely on the in-memory Map afterward.
  const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
  const harvested = harvestParksFromLog(logPath);
  let added = 0;
  for (const ref of harvested) {
    if (!workedParks.has(ref)) {
      workedParks.set(ref, { reference: ref });
      added++;
    }
  }
  if (added > 0) sendCatLog(`[worked-parks] harvested ${added} new refs from QSO log`);
  if (win && !win.isDestroyed()) {
    win.webContents.send('worked-parks', [...workedParks.entries()]);
    win.webContents.send('credited-parks', [...creditedParks.keys()]);
  }
  if (remoteServer && remoteServer.running) {
    remoteServer.sendWorkedParks([...workedParks.keys()]);
  }
}

// --- WSJT-X UDP bridge factory ---
// Many receivers (HamRS, GridTracker, JTAlert) track WSJT-X instances by id
// and require a HEARTBEAT to register the source before they'll accept
// QSO_LOGGED / LOGGED_ADIF messages. A long-lived socket sending periodic
// heartbeats solves this. Used by both the main logbook path (HamRS/Log4OM/
// MacLoggerDX) and the parallel Extra UDP destination (GridTracker direct).
function createWsjtxUdpBridge(label) {
  return {
    label,
    socket: null,
    heartbeatTimer: null,
    host: '127.0.0.1',
    port: 2237,
    id: 'POTACAT',

    start(host, port) {
      this.stop();
      this.host = host || '127.0.0.1';
      this.port = port || 2237;
      const dgram = require('dgram');
      this.socket = dgram.createSocket('udp4');
      this.socket.on('error', (err) => {
        console.error(`[${this.label}] UDP error:`, err.message);
      });
      this._sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), 15000);
      console.log(`[${this.label}] Bridge started -> ${this.host}:${this.port}`);
    },

    stop() {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.socket) {
        try { this.socket.close(); } catch { /* ignore */ }
        this.socket = null;
      }
    },

    _sendHeartbeat() {
      if (!this.socket) return;
      const buf = encodeHeartbeat(this.id, 3);
      this.socket.send(buf, 0, buf.length, this.port, this.host);
    },

    sendQso(qsoData, adifText) {
      return new Promise((resolve, reject) => {
        if (!this.socket) {
          reject(new Error(`${this.label} bridge not started`));
          return;
        }
        const freqHz = Math.round((parseFloat(qsoData.frequency) || 0) * 1000);
        sendCatLog(`[${this.label}] Sending QSO: ${qsoData.callsign} ${freqHz}Hz ${qsoData.mode} -> ${this.host}:${this.port}`);

        let dateTimeOff;
        if (qsoData.qsoDate) {
          const d = qsoData.qsoDate; // YYYYMMDD
          const t = qsoData.timeOn || '0000'; // HHMM or HHMMSS
          dateTimeOff = new Date(Date.UTC(
            parseInt(d.slice(0, 4), 10), parseInt(d.slice(4, 6), 10) - 1, parseInt(d.slice(6, 8), 10),
            parseInt(t.slice(0, 2), 10), parseInt(t.slice(2, 4), 10), t.length >= 6 ? parseInt(t.slice(4, 6), 10) : 0
          ));
        }

        // LOGGED_ADIF (type 12) first — carries POTA_REF, SIG_INFO, and other
        // program-specific fields. Then QSO_LOGGED (type 5) for apps that
        // only listen for the structured message.
        const adifBuf = encodeLoggedAdif(this.id, adifText);
        this.socket.send(adifBuf, 0, adifBuf.length, this.port, this.host, (err) => {
          if (err) sendCatLog(`[${this.label}] LOGGED_ADIF send error: ${err.message}`);
          else sendCatLog(`[${this.label}] LOGGED_ADIF (type 12) sent (${adifBuf.length} bytes)`);
        });

        const qsoMsg = encodeQsoLogged(this.id, {
          dateTimeOff,
          dateTimeOn: dateTimeOff,
          dxCall: qsoData.callsign || '',
          dxGrid: qsoData.gridsquare || '',
          txFrequency: freqHz,
          mode: qsoData.mode || '',
          reportSent: qsoData.rstSent || '59',
          reportReceived: qsoData.rstRcvd || '59',
          txPower: qsoData.txPower || '',
          comments: qsoData.comment || '',
          name: qsoData.name || '',
          operatorCall: qsoData.operator || '',
          myCall: qsoData.stationCallsign || '',
          myGrid: qsoData.myGridsquare || '',
          exchangeSent: qsoData.mySigInfo || '',
          exchangeReceived: qsoData.sigInfo || '',
        });
        this.socket.send(qsoMsg, 0, qsoMsg.length, this.port, this.host, (err) => {
          if (err) {
            sendCatLog(`[${this.label}] QSO_LOGGED send error: ${err.message}`);
            reject(err);
          } else {
            sendCatLog(`[${this.label}] QSO_LOGGED (type 5) sent (${qsoMsg.length} bytes)`);
            resolve();
          }
        });
      });
    },
  };
}

const hamrsBridge = createWsjtxUdpBridge('HamRS');
const extraUdpBridge = createWsjtxUdpBridge('Extra UDP');

// --- Logbook forwarding ---

/**
 * Convert raw ADIF fields (uppercase keys from parseAllRawQsos) to the
 * qsoData format that buildAdifRecord() / forwardToLogbook() expect.
 */
function rawQsoToQsoData(raw) {
  const freqMhz = parseFloat(raw.FREQ || '0');
  return {
    callsign: raw.CALL || '',
    frequency: (freqMhz * 1000).toFixed(1), // MHz -> kHz
    mode: raw.MODE || '',
    qsoDate: raw.QSO_DATE || '',
    timeOn: raw.TIME_ON || '',
    rstSent: raw.RST_SENT || '',
    rstRcvd: raw.RST_RCVD || '',
    txPower: raw.TX_PWR || '',
    band: raw.BAND || '',
    sig: raw.SIG || '',
    sigInfo: raw.SIG_INFO || '',
    potaRef: raw.POTA_REF || '',
    sotaRef: raw.SOTA_REF || '',
    wwffRef: raw.WWFF_REF || '',
    operator: raw.OPERATOR || '',
    name: raw.NAME || '',
    state: raw.STATE || '',
    county: raw.CNTY || '',
    gridsquare: raw.GRIDSQUARE || '',
    country: raw.COUNTRY || '',
    comment: raw.COMMENT || '',
    mySig: raw.MY_SIG || '',
    mySigInfo: raw.MY_SIG_INFO || '',
    myPotaRef: raw.MY_POTA_REF || '',
    mySotaRef: raw.MY_SOTA_REF || '',
    myGridsquare: raw.MY_GRIDSQUARE || '',
    stationCallsign: raw.STATION_CALLSIGN || '',
  };
}

function forwardToLogbook(qsoData) {
  const type = settings.logbookType;
  const host = settings.logbookHost || '127.0.0.1';
  const port = parseInt(settings.logbookPort, 10);

  if (type === 'log4om') {
    // Optional: send via WSJT-X binary protocol. Required for Log4OM to
    // propagate QSOs to QRZ/Clublog (plain ADIF UDP is treated as a batch
    // import and skips upstream sync hooks).
    if (settings.log4omWsjtxBinary) {
      const record = buildAdifRecord(qsoData);
      const adifText = `<adif_ver:5>3.1.4\n<programid:7>POTACAT\n<EOH>\n${record}\n`;
      const hp = port || 2237;
      if (!hamrsBridge.socket || hamrsBridge.host !== host || hamrsBridge.port !== hp) {
        hamrsBridge.start(host, hp);
      }
      return hamrsBridge.sendQso(qsoData, adifText);
    }
    return sendUdpAdif(qsoData, host, port || 2237);
  }
  if (type === 'hamrs') {
    const record = buildAdifRecord(qsoData);
    const adifText = `<adif_ver:5>3.1.4\n<programid:7>POTACAT\n<EOH>\n${record}\n`;
    // Start bridge if not running (or if host/port changed)
    const hp = port || 2237;
    if (!hamrsBridge.socket || hamrsBridge.host !== host || hamrsBridge.port !== hp) {
      hamrsBridge.start(host, hp);
    }
    return hamrsBridge.sendQso(qsoData, adifText);
  }
  if (type === 'hrd') {
    return sendUdpAdif(qsoData, host, port || 2333);
  }
  if (type === 'macloggerdx') {
    // MacLoggerDX speaks WSJT-X binary protocol (same as HamRS)
    const record = buildAdifRecord(qsoData);
    const adifText = `<adif_ver:5>3.1.4\n<programid:7>POTACAT\n<EOH>\n${record}\n`;
    const hp = port || 2237;
    if (!hamrsBridge.socket || hamrsBridge.host !== host || hamrsBridge.port !== hp) {
      hamrsBridge.start(host, hp);
    }
    return hamrsBridge.sendQso(qsoData, adifText);
  }
  if (type === 'logger32') {
    // Logger32's "Log QSOs received from WSJT-X" feature accepts the standard
    // WSJT-X binary QSO datagram on its configured UDP port (default 2237).
    // Reuse the same bridge we use for HamRS/MacLoggerDX/Log4OM-binary.
    const record = buildAdifRecord(qsoData);
    const adifText = `<adif_ver:5>3.1.4\n<programid:7>POTACAT\n<EOH>\n${record}\n`;
    const hp = port || 2237;
    if (!hamrsBridge.socket || hamrsBridge.host !== host || hamrsBridge.port !== hp) {
      hamrsBridge.start(host, hp);
    }
    return hamrsBridge.sendQso(qsoData, adifText);
  }
  if (type === 'n3fjp') {
    return sendN3fjpTcp(qsoData, host, port || 1100);
  }
  if (type === 'dxkeeper') {
    return sendDxkeeperTcp(qsoData, host, port || 52001);
  }
  if (type === 'wavelog') {
    return sendWavelogHttp(qsoData);
  }
  if (type === 'wrl') {
    return sendWrlUdp(qsoData, host, port || 12060);
  }
  return Promise.resolve();
}

/**
 * Send a QSO via plain UDP ADIF packet.
 * Used by Log4OM 2 (port 2237), HRD Logbook (port 2333), and MacLoggerDX (port 9090).
 */
function sendUdpAdif(qsoData, host, port) {
  return new Promise((resolve, reject) => {
    const dgram = require('dgram');
    const record = buildAdifRecord(qsoData);
    const adifText = `<adif_ver:5>3.1.4\n<programid:7>POTACAT\n<EOH>\n${record}\n`;
    const message = Buffer.from(adifText, 'utf-8');

    const client = dgram.createSocket('udp4');
    client.send(message, 0, message.length, port, host, (err) => {
      client.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Send a QSO to World Radio League via N1MM-compatible ContactInfo UDP.
 * WRL Cat Control listens for these and forwards to the WRL cloud logbook.
 */
function sendWrlUdp(qsoData, host, port) {
  return new Promise((resolve, reject) => {
    const dgram = require('dgram');
    const call = qsoData.callsign || '';
    const mycall = qsoData.operator || settings.myCallsign || '';
    const freqKhz = parseFloat(qsoData.frequency) || 0;
    const rxfreq = Math.round(freqKhz * 100).toString(); // N1MM uses 10 Hz units
    const txfreq = rxfreq;
    const mode = (qsoData.mode || 'SSB').toUpperCase();
    const band = (qsoData.band || '').toUpperCase();
    const snt = qsoData.rstSent || '59';
    const rcv = qsoData.rstRcvd || '59';
    const dateStr = qsoData.qsoDate || '';
    const timeStr = qsoData.timeOn || '';
    const ts = dateStr.length === 8 && timeStr.length >= 4
      ? `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)} ${timeStr.slice(0,2)}:${timeStr.slice(2,4)}:00`
      : new Date().toISOString().replace('T', ' ').slice(0, 19);
    const comment = qsoData.comment || '';
    const grid = qsoData.gridsquare || '';
    const contestName = qsoData.sig || '';
    const contestNr = qsoData.sigInfo || '';
    // The base N1MM ContactInfo schema doesn't carry STATE / SIG / SIG_INFO
    // and only ships the contest pair (contestname / contestnr). WRL Cat
    // Control's listener doesn't translate those back to ADIF SIG / SIG_INFO
    // on the way to the cloud logbook, so POTA hunts had no SIG fields and
    // none of the QSOs carried STATE (W7DB report). Emit the ADIF-style
    // tags alongside the legacy ones — N1MM ignores unknown tags, and WRL
    // picks them up directly into the ADIF record. Only emit when we have
    // a value so we don't pollute the packet with empty elements.
    const adifField = (name, val) => val ? `  <${name}>${escXml(val)}</${name}>\n` : '';
    const state = qsoData.state || '';
    const county = qsoData.county || '';
    const country = qsoData.country || '';
    const name = qsoData.name || '';
    const sig = qsoData.sig || '';
    const sigInfo = qsoData.sigInfo || '';
    const potaRef = qsoData.potaRef || '';
    const sotaRef = qsoData.sotaRef || '';
    const wwffRef = qsoData.wwffRef || '';
    const txPower = qsoData.txPower || '';
    const stationCallsign = qsoData.stationCallsign || mycall;
    const myGridsquare = qsoData.myGridsquare || settings.grid || '';
    const mySig = qsoData.mySig || '';
    const mySigInfo = qsoData.mySigInfo || '';

    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<contactinfo>\n`
      + `  <app>POTACAT</app>\n`
      + `  <contestname>${escXml(contestName)}</contestname>\n`
      + `  <contestnr>${escXml(contestNr)}</contestnr>\n`
      + `  <timestamp>${escXml(ts)}</timestamp>\n`
      + `  <mycall>${escXml(mycall)}</mycall>\n`
      + `  <operator>${escXml(mycall)}</operator>\n`
      + `  <band>${escXml(band)}</band>\n`
      + `  <rxfreq>${rxfreq}</rxfreq>\n`
      + `  <txfreq>${txfreq}</txfreq>\n`
      + `  <call>${escXml(call)}</call>\n`
      + `  <mode>${escXml(mode)}</mode>\n`
      + `  <snt>${escXml(snt)}</snt>\n`
      + `  <rcv>${escXml(rcv)}</rcv>\n`
      + `  <gridsquare>${escXml(grid)}</gridsquare>\n`
      + adifField('state', state)
      + adifField('cnty', county)
      + adifField('country', country)
      + adifField('name', name)
      + adifField('sig', sig)
      + adifField('sig_info', sigInfo)
      + adifField('pota_ref', potaRef)
      + adifField('sota_ref', sotaRef)
      + adifField('wwff_ref', wwffRef)
      + adifField('tx_pwr', txPower)
      + adifField('station_callsign', stationCallsign)
      + adifField('my_gridsquare', myGridsquare)
      + adifField('my_sig', mySig)
      + adifField('my_sig_info', mySigInfo)
      + `  <comment>${escXml(comment)}</comment>\n`
      + `</contactinfo>\n`;

    const message = Buffer.from(xml, 'utf-8');
    const client = dgram.createSocket('udp4');
    client.send(message, 0, message.length, port, host, (err) => {
      client.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

function escXml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Send a QSO to N3FJP via TCP ADDADIFRECORD command.
 * Format: <CMD><ADDADIFRECORD><VALUE>...adif fields...<EOR></VALUE></CMD>\r\n
 */
function sendN3fjpTcp(qsoData, host, port) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const record = buildAdifRecord(qsoData);
    const cmd = `<CMD><ADDADIFRECORD><VALUE>${record}</VALUE></CMD>\r\n`;

    let settled = false;
    const sock = net.createConnection({ host, port }, () => {
      sock.write(cmd, 'utf-8', () => {
        sock.end();
      });
    });

    // Wait for socket to fully close + brief delay — N3FJP needs time
    // between connections before it can accept the next one
    sock.on('close', () => {
      if (!settled) { settled = true; setTimeout(resolve, 250); }
    });

    sock.setTimeout(5000);
    sock.on('timeout', () => {
      sock.destroy();
      if (!settled) { settled = true; reject(new Error('N3FJP connection timed out')); }
    });
    sock.on('error', (err) => {
      if (!settled) { settled = true; reject(new Error(`N3FJP: ${err.message}`)); }
    });
  });
}

/**
 * Send a QSO to DXLab DXKeeper via TCP externallog command.
 * Format: <command:11>externallog<parameters:N><ExternalLogADIF:M>...ADIF...<EOR><DeduceMissing:1>Y<QueryCallbook:1>Y
 * DXKeeper uses a single-connection model — open, send, close.
 */
function sendDxkeeperTcp(qsoData, host, port) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const record = buildAdifRecord(qsoData);
    const options = '<DeduceMissing:1>Y<QueryCallbook:1>Y';
    const adifTag = `<ExternalLogADIF:${Buffer.byteLength(record, 'utf-8')}>${record}`;
    const params = `${adifTag}${options}`;
    const cmd = `<command:11>externallog<parameters:${Buffer.byteLength(params, 'utf-8')}>${params}`;

    const sock = net.createConnection({ host, port }, () => {
      sock.write(cmd, 'utf-8', () => {
        sock.end();
        resolve();
      });
    });

    sock.setTimeout(5000);
    sock.on('timeout', () => {
      sock.destroy();
      reject(new Error('DXKeeper connection timed out'));
    });
    sock.on('error', (err) => {
      reject(new Error(`DXKeeper: ${err.message}`));
    });
  });
}

/**
 * Send a QSO to Wavelog via HTTP POST.
 * POST {url}/index.php/api/qso with JSON body { key, station_profile_id, type: 'adif', string: adifRecord }
 */
function sendWavelogHttp(qsoData) {
  return new Promise((resolve, reject) => {
    let baseUrl = (settings.wavelogUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return reject(new Error('Wavelog URL not configured'));
    const apiKey = settings.wavelogApiKey;
    if (!apiKey) return reject(new Error('Wavelog API key not configured'));
    const stationId = settings.wavelogStationId || '1';

    const record = buildAdifRecord(qsoData);
    const body = JSON.stringify({
      key: apiKey,
      station_profile_id: String(stationId),
      type: 'adif',
      string: record,
    });

    const url = new URL(baseUrl + '/index.php/api/qso');
    const isHttps = url.protocol === 'https:';
    const httpMod = isHttps ? require('https') : require('http');

    const req = httpMod.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'created') {
            resolve();
          } else {
            reject(new Error(`Wavelog: ${json.reason || json.status || 'unknown error'}`));
          }
        } catch {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`Wavelog HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Wavelog: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Wavelog request timed out')); });
    req.write(body);
    req.end();
  });
}

/**
 * Upload a QSO to QRZ Logbook via their API.
 * Throws on failure (caller handles gracefully).
 */
async function sendToQrzLogbook(qsoData) {
  const apiKey = settings.qrzApiKey;
  if (!apiKey) throw new Error('QRZ API key not configured');

  // Comment already enriched with park name in saveQsoRecord()
  const record = buildAdifRecord(qsoData);
  await QrzClient.uploadQso(apiKey, record, settings.myCallsign || '');
}

// --- App lifecycle ---
function isOnScreen(saved) {
  const displays = screen.getAllDisplays();
  return displays.some(d => {
    const b = d.bounds;
    return saved.x < b.x + b.width && saved.x + saved.width > b.x &&
           saved.y < b.y + b.height && saved.y + saved.height > b.y;
  });
}

/** Clamp bounds so window fits within the nearest display's work area */
function clampToWorkArea(bounds) {
  const display = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
  const wa = display.workArea;
  const w = Math.min(bounds.width, wa.width);
  const h = Math.min(bounds.height, wa.height);
  const x = Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - w));
  const y = Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - h));
  return { x, y, width: w, height: h };
}

function getIconPath() {
  const variant = settings.lightIcon ? 'icon-light.png' : 'icon.png';
  return path.join(__dirname, 'assets', variant);
}

function applyIconToAllWindows() {
  const iconPath = getIconPath();
  const img = nativeImage.createFromPath(iconPath);
  const allWins = BrowserWindow.getAllWindows();
  for (const w of allWins) {
    if (!w.isDestroyed()) w.setIcon(img);
  }
}

function createWindow() {
  // Create window at default size first, then restore bounds via setBounds()
  // so Electron resolves DPI scaling for the correct display
  const primary = screen.getPrimaryDisplay().workArea;
  const defaultW = Math.min(1100, primary.width);
  const defaultH = Math.min(700, primary.height);
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: defaultW,
    height: defaultH,
    title: `POTACAT - v${require('./package.json').version}`,
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    icon: getIconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Restore saved window bounds after creation (DPI-aware), clamped to fit screen
  const saved = settings.windowBounds;
  if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
    win.setBounds(clampToWorkArea(saved));
  }

  if (settings.windowMaximized) {
    win.maximize();
  }

  // Allow MIDI device access for CW keyer
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(true));

  if (!HEADLESS) win.show();
  logStartupStage('win.show() (window visible)');

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // F12 opens DevTools
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      win.webContents.toggleDevTools();
    }
  });

  // Close pop-out map when main window closes
  win.on('close', () => {
    // Save window bounds before destruction
    settings.windowMaximized = win.isMaximized();
    if (!win.isMaximized() && !win.isMinimized()) {
      settings.windowBounds = win.getBounds();
    }
    // Remember whether pop-out windows were open
    settings.mapPopoutOpen = !!(popoutWin && !popoutWin.isDestroyed());
    settings.qsoPopoutOpen = !!(qsoPopoutWin && !qsoPopoutWin.isDestroyed());
    settings.spotsPopoutOpen = !!(spotsPopoutWin && !spotsPopoutWin.isDestroyed());
    settings.clusterPopoutOpen = !!(clusterPopoutWin && !clusterPopoutWin.isDestroyed());
    settings.vfoPopoutOpen = !!(vfoPopoutWin && !vfoPopoutWin.isDestroyed());
    saveSettings(settings);
    if (popoutWin && !popoutWin.isDestroyed()) popoutWin.close();
    if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) qsoPopoutWin.close();
    if (spotsPopoutWin && !spotsPopoutWin.isDestroyed()) spotsPopoutWin.close();
    if (clusterPopoutWin && !clusterPopoutWin.isDestroyed()) clusterPopoutWin.close();
    if (actmapPopoutWin && !actmapPopoutWin.isDestroyed()) actmapPopoutWin.close();
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.close();
    if (remoteAudioWin && !remoteAudioWin.isDestroyed()) remoteAudioWin.close();
    if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) sstvPopoutWin.close();
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) jtcatPopoutWin.close();
    if (jtcatMapPopoutWin && !jtcatMapPopoutWin.isDestroyed()) jtcatMapPopoutWin.close();
  });

  // Once the renderer is actually ready to listen, send current state
  win.webContents.on('did-finish-load', () => {
    logStartupStage('main window did-finish-load (renderer ready)');
    if (cat) {
      sendCatStatus({ connected: cat.connected, target: cat._target });
    }
    if (clusterClients.size > 0) {
      sendClusterStatus();
    }
    if (rbn) {
      sendRbnStatus({ connected: rbn.connected, host: 'telnet.reversebeacon.net', port: 7000 });
      if (rbnSpots.length > 0) sendRbnSpots();
    }
    if (wsjtx) {
      sendWsjtxStatus({ connected: wsjtx.connected, listening: true });
    }
    if (pskr) {
      sendPskrStatus({ connected: pskr.connected });
    }
    if (pskrMap) {
      sendPskrMapStatus({ connected: pskrMap.connected, spotCount: pskrMapSpots.length });
      if (pskrMapSpots.length > 0) sendPskrMapSpots();
    }
    refreshSpots();
    fetchSolarData();
    // Auto-send DXCC data if enabled and ADIF path is set
    if (settings.enableDxcc) {
      sendDxccData();
    }
    // Load worked callsigns from QSO log
    loadWorkedQsos();
    // Load worked parks from POTA CSV
    loadWorkedParks();
    // Fetch donor list (async, non-blocking)
    fetchDonorList();
    setInterval(fetchDonorList, 24 * 3600000); // refresh supporter list daily
    // Fetch active DX expeditions from Club Log
    fetchExpeditions();
    setInterval(fetchExpeditions, 3600000); // refresh every hour
    // Fetch active events (contests, awards) from remote endpoint
    const cachedEvents = loadEventsCache();
    if (cachedEvents.events && cachedEvents.events.length) {
      activeEvents = cachedEvents.events;
    }
    fetchActiveEvents();
    setInterval(fetchActiveEvents, 4 * 3600000); // refresh every 4 hours
    // Push cached events to renderer immediately + scan log for matches
    pushEventsToRenderer();
    scanLogForEvents();
    // Load directory cache and fetch fresh data (only if enabled)
    if (settings.enableDirectory) {
      const dirCache = loadDirectoryCache();
      directoryNets = dirCache.nets || [];
      directorySwl = dirCache.swl || [];
      pushDirectoryToRenderer();
      fetchDirectory();
    }
    setInterval(() => { if (settings.enableDirectory) fetchDirectory(); }, 4 * 3600000);
    // Auto-reopen pop-out map if it was open when the app last closed
    if (settings.mapPopoutOpen) {
      ipcMain.emit('popout-map-open');
    }
    // Auto-reopen pop-out QSO log if it was open when the app last closed
    if (settings.qsoPopoutOpen) {
      ipcMain.emit('qso-popout-open');
    }
    // Auto-reopen pop-out spots if it was open when the app last closed
    if (settings.spotsPopoutOpen) {
      ipcMain.emit('spots-popout-open');
    }
    // Auto-reopen cluster terminal if it was open when the app last closed
    if (settings.clusterPopoutOpen) {
      ipcMain.emit('cluster-popout-open');
    }
    // Auto-reopen VFO if it was open when the app last closed
    if (settings.vfoPopoutOpen) {
      ipcMain.emit('vfo-popout-open');
    }
  });
}

// --- Donor list ---
function fetchDonorList() {
  const https = require('https');
  const req = https.get('https://api.potacat.com/v1/supporters', (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const arr = JSON.parse(body);
        if (!Array.isArray(arr)) return;
        donorCallsigns = new Set(arr.map(cs => cs.toUpperCase()));
        if (win && !win.isDestroyed()) {
          win.webContents.send('donor-callsigns', [...donorCallsigns]);
        }
        if (remoteServer && remoteServer.running) {
          remoteServer.broadcastDonorCallsigns([...donorCallsigns]);
        }
      } catch { /* silently ignore parse errors */ }
    });
  });
  req.on('error', () => { /* silently ignore — no internet is fine */ });
}

// --- DX Expeditions (Club Log + danplanet iCal) ---
function fetchClubLogExpeditions() {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.get('https://clublog.org/expeditions.php?api=1', (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const arr = JSON.parse(body);
          const cutoff = Date.now() - 7 * 24 * 3600000;
          const calls = [];
          for (const entry of arr) {
            const lastQso = new Date(entry[1] + 'Z').getTime();
            if (lastQso >= cutoff) calls.push(entry[0].toUpperCase());
          }
          resolve(calls);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
  });
}

async function fetchExpeditions() {
  const [clubLogResult, dxCalResult] = await Promise.allSettled([
    fetchClubLogExpeditions(),
    fetchDxCalExpeditions(),
  ]);

  const merged = new Set();
  const meta = new Map();

  // Club Log callsigns
  if (clubLogResult.status === 'fulfilled') {
    for (const cs of clubLogResult.value) merged.add(cs);
  }

  // danplanet iCal expeditions — richer metadata
  if (dxCalResult.status === 'fulfilled') {
    for (const exp of dxCalResult.value) {
      for (const cs of exp.callsigns) {
        const upper = cs.toUpperCase();
        merged.add(upper);
        meta.set(upper, {
          entity: exp.entity,
          startDate: exp.startDate,
          endDate: exp.endDate,
          description: exp.description,
        });
      }
    }
  }

  expeditionCallsigns = merged;
  expeditionMeta = meta;

  if (win && !win.isDestroyed()) {
    const metadata = {};
    for (const [cs, m] of meta) metadata[cs] = m;
    win.webContents.send('expedition-callsigns', {
      callsigns: [...merged],
      metadata,
    });
  }
}

// --- Active Events (remote endpoint) ---
// Built-in event definitions — remote endpoint overrides these.
// Board types: "regions" (state grid), "checklist" (named items), "counter" (QSO count)
const BUILTIN_EVENTS = {
  events: [
    // --- ARRL America 250 WAS (year-long, 50-state tracker) ---
    {
      id: 'america250-2026',
      name: 'ARRL America 250 WAS',
      type: 'was',
      board: 'regions',
      url: 'https://www.arrl.org/america250-was',
      badge: '250',
      badgeColor: '#cf6a00',
      callsignPatterns: ['W1AW/*'],
      schedule: [
        // Jan 2026
        { region: 'NY', regionName: 'New York', start: '2026-01-07T00:00:00Z', end: '2026-01-13T23:59:59Z' },
        { region: 'NE', regionName: 'Nebraska', start: '2026-01-07T00:00:00Z', end: '2026-01-13T23:59:59Z' },
        { region: 'WV', regionName: 'West Virginia', start: '2026-01-14T00:00:00Z', end: '2026-01-20T23:59:59Z' },
        { region: 'LA', regionName: 'Louisiana', start: '2026-01-14T00:00:00Z', end: '2026-01-20T23:59:59Z' },
        { region: 'SC', regionName: 'South Carolina', start: '2026-01-14T00:00:00Z', end: '2026-01-20T23:59:59Z' },
        { region: 'IL', regionName: 'Illinois', start: '2026-01-21T00:00:00Z', end: '2026-01-27T23:59:59Z' },
        { region: 'ME', regionName: 'Maine', start: '2026-01-28T00:00:00Z', end: '2026-02-03T23:59:59Z' },
        // Feb 2026
        { region: 'CA', regionName: 'California', start: '2026-02-04T00:00:00Z', end: '2026-02-10T23:59:59Z' },
        { region: 'MA', regionName: 'Massachusetts', start: '2026-02-11T00:00:00Z', end: '2026-02-17T23:59:59Z' },
        { region: 'MI', regionName: 'Michigan', start: '2026-02-18T00:00:00Z', end: '2026-02-24T23:59:59Z' },
        { region: 'AZ', regionName: 'Arizona', start: '2026-02-25T00:00:00Z', end: '2026-03-03T23:59:59Z' },
        // Mar 2026
        { region: 'AZ', regionName: 'Arizona', start: '2026-03-04T00:00:00Z', end: '2026-03-10T23:59:59Z' },
        { region: 'VA', regionName: 'Virginia', start: '2026-03-11T00:00:00Z', end: '2026-03-17T23:59:59Z' },
        { region: 'HI', regionName: 'Hawaii', start: '2026-03-18T00:00:00Z', end: '2026-03-24T23:59:59Z' },
        { region: 'KY', regionName: 'Kentucky', start: '2026-03-18T00:00:00Z', end: '2026-03-24T23:59:59Z' },
        { region: 'MN', regionName: 'Minnesota', start: '2026-03-18T00:00:00Z', end: '2026-03-24T23:59:59Z' },
        { region: 'ND', regionName: 'North Dakota', start: '2026-03-25T00:00:00Z', end: '2026-03-31T23:59:59Z' },
        { region: 'OK', regionName: 'Oklahoma', start: '2026-03-25T00:00:00Z', end: '2026-03-31T23:59:59Z' },
        // Apr 2026
        { region: 'NH', regionName: 'New Hampshire', start: '2026-04-29T00:00:00Z', end: '2026-05-05T23:59:59Z' },
        // Remaining states will be filled from remote endpoint as schedule is confirmed
      ],
      tracking: { type: 'regions', total: 50, label: 'States' },
    },
    // --- CQ WW 160m SSB 2026 (weekend contest) ---
    {
      id: 'cq160-ssb-2026',
      name: 'CQ WW 160m SSB',
      type: 'contest',
      board: 'counter',
      url: 'https://cq160.com',
      badge: '160',
      badgeColor: '#e040fb',
      callsignPatterns: [],
      schedule: [
        { region: 'ALL', regionName: 'Worldwide', start: '2026-02-27T22:00:00Z', end: '2026-03-01T22:00:00Z' },
      ],
      tracking: { type: 'counter', total: 0, label: 'QSOs' },
    },
    // --- 13 Colonies Special Event (July) ---
    {
      id: '13colonies-2026',
      name: '13 Colonies',
      type: 'special-event',
      board: 'checklist',
      url: 'https://www.13colonies.us',
      badge: '13C',
      badgeColor: '#1776cf',
      callsignPatterns: ['K2A', 'K2B', 'K2C', 'K2D', 'K2E', 'K2F', 'K2G', 'K2H', 'K2I', 'K2J', 'K2K', 'K2L', 'K2M', 'WM3PEN', 'GB13COL', 'TM13COL'],
      schedule: [
        { region: 'ALL', regionName: '13 Colonies', start: '2026-07-01T13:00:00Z', end: '2026-07-07T04:00:00Z' },
      ],
      tracking: {
        type: 'checklist', total: 16, label: 'Stations',
        items: [
          { id: 'K2A', name: 'New York' },
          { id: 'K2B', name: 'Virginia' },
          { id: 'K2C', name: 'Rhode Island' },
          { id: 'K2D', name: 'Connecticut' },
          { id: 'K2E', name: 'Delaware' },
          { id: 'K2F', name: 'Maryland' },
          { id: 'K2G', name: 'Georgia' },
          { id: 'K2H', name: 'Massachusetts' },
          { id: 'K2I', name: 'New Jersey' },
          { id: 'K2J', name: 'North Carolina' },
          { id: 'K2K', name: 'New Hampshire' },
          { id: 'K2L', name: 'South Carolina' },
          { id: 'K2M', name: 'Pennsylvania' },
          { id: 'WM3PEN', name: 'Bonus: Philadelphia' },
          { id: 'GB13COL', name: 'Bonus: England' },
          { id: 'TM13COL', name: 'Bonus: France' },
        ],
      },
    },
  ],
};

function loadEventsCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(EVENTS_CACHE_PATH, 'utf-8'));
    if (cached.events && cached.events.length) return cached;
  } catch { /* fall through */ }
  return BUILTIN_EVENTS;
}

function saveEventsCache(data) {
  try { fs.writeFileSync(EVENTS_CACHE_PATH, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
}

function fetchActiveEvents() {
  const https = require('https');
  const req = https.get('https://potacat.com/events/active.json', (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data && Array.isArray(data.events)) {
          activeEvents = data.events;
          saveEventsCache(data);
          pushEventsToRenderer();
          scanLogForEvents();
        }
      } catch { /* silently ignore parse errors */ }
    });
  });
  req.on('error', () => { /* silently ignore — use cache */ });
}

function pushEventsToRenderer() {
  if (!win || win.isDestroyed()) return;
  // Merge event definitions with user opt-in/progress state from settings
  const eventStates = settings.events || {};
  const payload = activeEvents.map(ev => ({
    ...ev,
    optedIn: !!(eventStates[ev.id] && eventStates[ev.id].optedIn),
    dismissed: !!(eventStates[ev.id] && eventStates[ev.id].dismissed),
    progress: (eventStates[ev.id] && eventStates[ev.id].progress) || {},
  }));
  win.webContents.send('active-events', payload);
}

// --- Directory (HF Nets & SWL Broadcasts from Google Sheet) ---

function loadDirectoryCache() {
  try {
    return JSON.parse(fs.readFileSync(DIRECTORY_CACHE_PATH, 'utf-8'));
  } catch { /* fall through */ }
  return { nets: [], swl: [], timestamp: 0 };
}

function saveDirectoryCache(data) {
  try { fs.writeFileSync(DIRECTORY_CACHE_PATH, JSON.stringify(data)); } catch { /* ignore */ }
}

async function fetchDirectory() {
  const results = await Promise.allSettled([fetchDirectoryNets(), fetchDirectorySwl()]);
  if (results[0].status === 'fulfilled') directoryNets = results[0].value;
  if (results[1].status === 'fulfilled') directorySwl = results[1].value;
  saveDirectoryCache({ nets: directoryNets, swl: directorySwl, timestamp: Date.now() });
  pushDirectoryToRenderer();
}

function pushDirectoryToRenderer() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('directory-data', { nets: directoryNets, swl: directorySwl });
  // Also push to ECHOCAT phone client (only when directory feature is enabled)
  if (remoteServer && remoteServer.running && settings.enableDirectory) {
    remoteServer.broadcastDirectory({ nets: directoryNets, swl: directorySwl });
  }
}

function getEventProgress(eventId) {
  if (!settings.events || !settings.events[eventId]) return {};
  return settings.events[eventId].progress || {};
}

function setEventOptIn(eventId, optedIn, dismissed) {
  if (!settings.events) settings.events = {};
  if (!settings.events[eventId]) settings.events[eventId] = { optedIn: false, dismissed: false, progress: {} };
  if (optedIn !== undefined) settings.events[eventId].optedIn = optedIn;
  if (dismissed !== undefined) settings.events[eventId].dismissed = dismissed;
  saveSettings(settings);
  pushEventsToRenderer();
}

function markEventRegion(eventId, region, qsoData) {
  if (!settings.events) settings.events = {};
  if (!settings.events[eventId]) settings.events[eventId] = { optedIn: true, dismissed: false, progress: {} };
  settings.events[eventId].progress[region] = {
    call: qsoData.callsign,
    band: qsoData.band || '',
    mode: qsoData.mode || '',
    date: qsoData.qsoDate || new Date().toISOString().slice(0, 10),
    freq: qsoData.frequency || '',
  };
  saveSettings(settings);
  pushEventsToRenderer();
}

/** Scan existing QSO log for contacts that match opted-in events.
 *  Rebuilds progress from scratch so only log-verified QSOs count. */
function scanLogForEvents() {
  if (!activeEvents.length || !settings.events) return;
  const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
  let qsos = [];
  try {
    if (fs.existsSync(logPath)) qsos = parseAllRawQsos(logPath);
  } catch { /* ignore */ }

  let changed = false;
  for (const ev of activeEvents) {
    const state = settings.events && settings.events[ev.id];
    if (!state || !state.optedIn) continue;

    const board = ev.board || ev.tracking?.type || 'regions';
    // Skip counter events — don't retroactively count old QSOs
    if (board === 'counter') continue;

    // Reset progress and rebuild purely from the log
    const oldProgress = state.progress || {};
    state.progress = {};
    changed = true;

    for (const rec of qsos) {
      const call = (rec.CALL || '').toUpperCase();
      if (!call) continue;

      // Parse QSO date (YYYYMMDD) to match against schedule
      const qsoDateStr = rec.QSO_DATE || '';
      const qsoDate = qsoDateStr.length === 8
        ? new Date(`${qsoDateStr.slice(0, 4)}-${qsoDateStr.slice(4, 6)}-${qsoDateStr.slice(6, 8)}T12:00:00Z`)
        : null;

      // Find schedule entry that covers this QSO's date
      const matchEntry = (ev.schedule || []).find(s => {
        const start = new Date(s.start);
        const end = new Date(s.end);
        return qsoDate && qsoDate >= start && qsoDate < end;
      });
      if (!matchEntry) continue;

      const qsoData = {
        callsign: call,
        band: rec.BAND || '',
        mode: rec.MODE || '',
        qsoDate: qsoDateStr,
        frequency: rec.FREQ || '',
      };

      if (board === 'checklist') {
        const items = (ev.tracking && ev.tracking.items) || [];
        const matchedItem = items.find(it => call === it.id.toUpperCase() || call.startsWith(it.id.toUpperCase() + '/'));
        if (!matchedItem || state.progress[matchedItem.id]) continue;
        state.progress[matchedItem.id] = {
          call: qsoData.callsign,
          band: qsoData.band,
          mode: qsoData.mode,
          date: qsoData.qsoDate,
          freq: qsoData.frequency,
        };
      } else if (board === 'regions') {
        const matches = (ev.callsignPatterns || []).some(pattern => {
          if (pattern.endsWith('/*')) return call.startsWith(pattern.slice(0, -1));
          return call === pattern.toUpperCase();
        });
        if (!matches || state.progress[matchEntry.region]) continue;
        state.progress[matchEntry.region] = {
          call: qsoData.callsign,
          band: qsoData.band,
          mode: qsoData.mode,
          date: qsoData.qsoDate,
          freq: qsoData.frequency,
        };
      }
    }
  }
  if (changed) {
    saveSettings(settings);
    pushEventsToRenderer();
  }
}

/** Check if a logged QSO matches any active event and auto-mark progress */
function checkEventQso(qsoData) {
  if (!activeEvents.length || !settings.events) return;
  const call = (qsoData.callsign || '').toUpperCase();
  const now = new Date();

  for (const ev of activeEvents) {
    const state = settings.events[ev.id];
    if (!state || !state.optedIn) continue;

    const board = ev.board || ev.tracking?.type || 'regions';

    // Find the active schedule entry
    const activeEntry = (ev.schedule || []).find(s => {
      const start = new Date(s.start);
      const end = new Date(s.end);
      return now >= start && now < end;
    });
    if (!activeEntry) continue;

    if (board === 'checklist') {
      // Checklist: match callsign exactly against tracking.items[].id
      const items = (ev.tracking && ev.tracking.items) || [];
      const matchedItem = items.find(it => call === it.id.toUpperCase() || call.startsWith(it.id.toUpperCase() + '/'));
      if (!matchedItem) continue;
      if (state.progress[matchedItem.id]) continue;
      markEventRegion(ev.id, matchedItem.id, qsoData);
    } else if (board === 'counter') {
      // Counter: any QSO during event counts — store by timestamp key
      const key = `qso-${Date.now()}`;
      markEventRegion(ev.id, key, qsoData);
    } else {
      // Regions (WAS): match callsign pattern, mark active region
      const matches = (ev.callsignPatterns || []).some(pattern => {
        if (pattern.endsWith('/*')) {
          return call.startsWith(pattern.slice(0, -1));
        }
        return call === pattern.toUpperCase();
      });
      if (!matches) continue;
      if (state.progress[activeEntry.region]) continue;
      markEventRegion(ev.id, activeEntry.region, qsoData);
    }
  }
}

// --- Update check (electron-updater for installed, manual fallback for portable) ---
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = {
  info: (...args) => console.log('[updater]', ...args),
  warn: (...args) => console.warn('[updater]', ...args),
  error: (...args) => console.error('[updater]', ...args),
  debug: (...args) => console.log('[updater:debug]', ...args),
};

autoUpdater.on('update-available', (info) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-available', {
      version: info.version,
      releaseName: info.releaseName || '',
      releaseNotes: info.releaseNotes || '',
    });
  }
});

autoUpdater.on('download-progress', (progress) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-download-progress', { percent: Math.round(progress.percent) });
  }
});

autoUpdater.on('update-downloaded', () => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-downloaded');
  }
});

autoUpdater.on('update-not-available', () => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-up-to-date');
  }
});

autoUpdater.on('error', (err) => {
  console.error('autoUpdater error:', err);
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-error', err?.message || String(err));
  }
});

ipcMain.on('start-download', () => { autoUpdater.downloadUpdate(); });
ipcMain.on('install-update', () => { autoUpdater.quitAndInstall(); });
ipcMain.on('check-for-updates', () => { checkForUpdates(); });

// Fallback for portable builds where electron-updater is inactive
function checkForUpdatesManual() {
  const https = require('https');
  const currentVersion = require('./package.json').version;
  const options = {
    hostname: 'api.github.com',
    path: '/repos/Waffleslop/POTACAT/releases/latest',
    headers: { 'User-Agent': 'POTACAT/' + currentVersion },
    timeout: 10000,
  };
  const req = https.get(options, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        const latestTag = (data.tag_name || '').replace(/^v/, '');
        if (latestTag && isNewerVersion(currentVersion, latestTag)) {
          const releaseUrl = data.html_url || `https://github.com/Waffleslop/POTACAT/releases/tag/${data.tag_name}`;
          if (win && !win.isDestroyed()) {
            win.webContents.send('update-available', { version: latestTag, url: releaseUrl, headline: data.name || '' });
          }
        } else if (win && !win.isDestroyed()) {
          win.webContents.send('update-up-to-date');
        }
      } catch { /* silently ignore parse errors */ }
    });
  });
  req.on('error', () => { /* silently ignore — no internet is fine */ });
}

function isNewerVersion(current, latest) {
  const a = current.split('.').map(Number);
  const b = latest.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (bv > av) return true;
    if (bv < av) return false;
  }
  return false;
}

function checkForUpdates() {
  if (autoUpdater.isUpdaterActive()) {
    // Installed build — use electron-updater
    autoUpdater.checkForUpdates().catch(() => {});
    // Also tell renderer that auto-update is available
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater-active', true);
    }
  } else {
    // Portable build — fall back to manual GitHub API check
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater-active', false);
    }
    checkForUpdatesManual();
  }
}

// --- Fetch release notes for a specific version ---
ipcMain.handle('get-release-notes', async (_event, version) => {
  const https = require('https');
  const tag = version.startsWith('v') ? version : `v${version}`;
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/Waffleslop/POTACAT/releases/tags/${tag}`,
      headers: { 'User-Agent': 'POTACAT/' + require('./package.json').version },
      timeout: 10000,
    };
    const req = https.get(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve({ name: data.name || '', body: data.body || '' });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
});

// --- Anonymous telemetry (opt-in only) ---
const TELEMETRY_URL = 'https://telemetry.potacat.com/ping';
let sessionStartTime = Date.now();
let lastActivityTime = Date.now(); // tracks meaningful user actions for active/idle detection

function markUserActive() {
  lastActivityTime = Date.now();
  if (autoSstvActive) cancelAutoSstv();
  // If CAT polling was paused for inactivity, resume it now — user is back
  if (idlePolePaused && cat && cat.resumePolling) {
    cat.resumePolling();
    idlePolePaused = false;
  }
}
function isUserActive() { return (Date.now() - lastActivityTime) < 1800000; } // active within 30 min

// --- Idle CAT-polling pause ---
// Polling keeps some radios from entering their screensaver / sleep mode
// (W3AVP report on FT-710). After N minutes of POTACAT inactivity we pause
// the poll timer; any user action in POTACAT resumes it via markUserActive().
// The user loses frequency/mode updates while paused — acceptable tradeoff
// for long idle periods where they explicitly want the radio to sleep.
let idlePauseTimer = null;
let idlePolePaused = false;
function startIdlePauseTimer() {
  stopIdlePauseTimer();
  if (settings.enableIdlePause === false) return; // explicit opt-out
  const thresholdMs = (settings.idlePauseMin || 20) * 60 * 1000;
  idlePauseTimer = setInterval(() => {
    if (idlePolePaused) return;
    if (!cat || !cat.pausePolling || !cat.connected) return;
    const idle = Date.now() - lastActivityTime;
    if (idle >= thresholdMs) {
      cat.pausePolling();
      idlePolePaused = true;
      console.log('[IdlePause] CAT polling paused after ' + Math.round(idle / 60000) + ' min idle');
    }
  }, 30000); // check every 30s
}
function stopIdlePauseTimer() {
  if (idlePauseTimer) { clearInterval(idlePauseTimer); idlePauseTimer = null; }
}

// --- Auto-SSTV: idle-triggered SSTV decode ---
let autoSstvTimer = null;
let autoSstvActive = false;
let autoSstvPrevFreq = null;
let autoSstvPrevMode = null;
let autoSstvCurrentFreq = 0;

function getSunTimes(lat, lon, date) {
  const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const declination = -23.45 * Math.cos(2 * Math.PI / 365 * (dayOfYear + 10));
  const decRad = declination * Math.PI / 180;
  const latRad = lat * Math.PI / 180;
  const cosHA = -(Math.sin(latRad) * Math.sin(decRad)) / (Math.cos(latRad) * Math.cos(decRad));
  if (cosHA > 1) return { sunrise: 12, sunset: 12 };   // polar night
  if (cosHA < -1) return { sunrise: 0, sunset: 24 };   // midnight sun
  const ha = Math.acos(cosHA) * 180 / Math.PI;
  const noon = 12 - lon / 15;
  return { sunrise: noon - ha / 15, sunset: noon + ha / 15 };
}

function getSstvAutoFreq() {
  const pos = gridToLatLon(settings.grid);
  if (!pos) return { freqKhz: 14230, mode: 'USB' };
  const now = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const sun = getSunTimes(pos.lat, pos.lon, now);
  const daytime = utcH >= sun.sunrise && utcH < sun.sunset;
  return daytime ? { freqKhz: 14230, mode: 'USB' } : { freqKhz: 7171, mode: 'USB' };
}

function startAutoSstvTimer() {
  stopAutoSstvTimer();
  if (!settings.enableAutoSstv) return;
  const thresholdMs = (settings.autoSstvInactivityMin || 90) * 60 * 1000;
  autoSstvTimer = setInterval(() => {
    const idle = Date.now() - lastActivityTime;
    if (!autoSstvActive && idle >= thresholdMs) {
      triggerAutoSstv();
    }
    // If already active, check for band change at sunrise/sunset
    if (autoSstvActive) {
      const newBand = getSstvAutoFreq();
      if (newBand.freqKhz !== autoSstvCurrentFreq) {
        autoSstvCurrentFreq = newBand.freqKhz;
        if (cat && cat.connected) cat.tune(newBand.freqKhz * 1000, newBand.mode);
        console.log('[Auto-SSTV] Band switch to ' + newBand.freqKhz + ' kHz');
      }
    }
  }, 30000);
  console.log('[Auto-SSTV] Timer started (' + (settings.autoSstvInactivityMin || 90) + ' min threshold)');
}

function stopAutoSstvTimer() {
  if (autoSstvTimer) { clearInterval(autoSstvTimer); autoSstvTimer = null; }
}

function triggerAutoSstv() {
  autoSstvActive = true;
  autoSstvPrevFreq = _currentFreqHz;
  autoSstvPrevMode = _currentMode;
  const autoSstvBand = getSstvAutoFreq();
  autoSstvCurrentFreq = autoSstvBand.freqKhz;
  if (cat && cat.connected) cat.tune(autoSstvBand.freqKhz * 1000, autoSstvBand.mode);
  if (openSstvPopout) openSstvPopout();
  sendCatLog('[Auto-SSTV] Activated — tuned to ' + autoSstvCurrentFreq + ' kHz');
  if (remoteServer && remoteServer.hasClient()) {
    remoteServer.broadcastSstvTxStatus({ state: 'auto-rx', freqKhz: autoSstvCurrentFreq });
  }
}

function cancelAutoSstv() {
  if (!autoSstvActive) return;
  autoSstvActive = false;
  if (autoSstvPrevFreq && cat && cat.connected) {
    cat.tune(autoSstvPrevFreq, autoSstvPrevMode || 'USB');
  }
  sendCatLog('[Auto-SSTV] Cancelled — restored ' + (autoSstvPrevFreq ? (autoSstvPrevFreq / 1000) + ' kHz' : 'previous frequency'));
  autoSstvPrevFreq = null;
  autoSstvPrevMode = null;
}

function generateTelemetryId() {
  // Random UUID v4 — not tied to any user identity
  const bytes = require('crypto').randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function postPotaRespot(spotData) {
  const https = require('https');
  const payload = JSON.stringify({
    activator: spotData.activator,
    spotter: spotData.spotter,
    frequency: spotData.frequency,
    reference: spotData.reference,
    mode: spotData.mode,
    source: 'POTACAT',
    comments: spotData.comments,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.pota.app',
      path: '/spot/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'origin': 'https://pota.app',
        'referer': 'https://pota.app/',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(payload);
    req.end();
  });
}

function postLlotaRespot(spotData) {
  const https = require('https');
  const payload = JSON.stringify({
    callsign: spotData.activator,
    frequency: spotData.frequency,
    mode: spotData.mode,
    reference: spotData.reference,
    comments: spotData.comments || '',
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'llota.app',
      path: '/api/public/spots/spot',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-API-Key': 'aagh6LeK5eirash5hei4zei7ShaeDahl4roM0Ool',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(payload);
    req.end();
  });
}

function sendTelemetry(sessionSeconds) {
  if (!settings || !settings.enableTelemetry) return Promise.resolve();
  if (!settings.telemetryId) {
    settings.telemetryId = generateTelemetryId();
    saveSettings(settings);
  }
  const https = require('https');
  const payload = JSON.stringify({
    id: settings.telemetryId,
    version: require('./package.json').version,
    os: process.platform,
    sessionSeconds: sessionSeconds || 0,
    active: sessionSeconds === 0 ? true : isUserActive(), // launch ping always active
  });
  const url = new URL(TELEMETRY_URL);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    }, () => resolve());
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(payload);
    req.end();
  });
}

function trackTelemetryEvent(endpoint, source) {
  if (!settings || !settings.enableTelemetry) return;
  const https = require('https');
  const payload = source ? JSON.stringify({ source }) : '';
  const req = https.request({
    hostname: 'telemetry.potacat.com',
    path: endpoint,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    timeout: 5000,
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  if (payload) req.write(payload);
  req.end();
}

function trackQso(source) { trackTelemetryEvent('/qso', source); }
function trackRespot(source) { trackTelemetryEvent('/respot', source); }

// --- Rig profile migration ---
function describeTargetForMigration(target) {
  if (!target) return 'No Radio';
  if (target.type === 'tcp') {
    const host = target.host || '127.0.0.1';
    const port = target.port || 5002;
    if ((host === '127.0.0.1' || host === 'localhost') && port >= 5002 && port <= 5005) {
      const sliceLetter = String.fromCharCode(65 + port - 5002); // A, B, C, D
      return `FlexRadio Slice ${sliceLetter}`;
    }
    return `TCP ${host}:${port}`;
  }
  if (target.type === 'serial') {
    return `Serial CAT on ${target.path || 'unknown'}`;
  }
  if (target.type === 'rigctld') {
    const port = target.serialPort || 'unknown';
    return `Hamlib Rig on ${port}`;
  }
  return 'Radio';
}

function migrateRigSettings(s) {
  if (!s.rigs) {
    s.rigs = [];
  }
  if (s.catTarget && s.rigs.length === 0) {
    const rig = {
      id: 'rig_' + Date.now(),
      name: describeTargetForMigration(s.catTarget),
      catTarget: JSON.parse(JSON.stringify(s.catTarget)),
    };
    s.rigs.push(rig);
    s.activeRigId = rig.id;
    delete s.catTarget;
    saveSettings(s);
  }
  // Dedup rigs with identical catTarget (could happen from repeated migration)
  if (s.rigs.length > 1) {
    const seen = new Set();
    const before = s.rigs.length;
    s.rigs = s.rigs.filter(r => {
      const key = JSON.stringify(r.catTarget);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (s.rigs.length < before) {
      if (!s.rigs.find(r => r.id === s.activeRigId)) {
        s.activeRigId = s.rigs[0]?.id || null;
      }
      saveSettings(s);
    }
  }
}

// --- Tune radio (shared by IPC and protocol handler) ---
let _lastTuneFreq = 0;
let _lastTuneTime = 0;
let _lastTuneBand = null; // for ATU auto-tune on band change
let _modeSuppressUntil = 0; // suppress stale mode broadcasts to ECHOCAT during tune transition

function tuneRadio(freqKhz, mode, brng, { clearXit } = {}) {
  let freqHz = Math.round(parseFloat(freqKhz) * 1000); // kHz -> Hz
  const now = Date.now();
  if (freqHz === _lastTuneFreq && now - _lastTuneTime < 300) return;
  _lastTuneFreq = freqHz;
  _lastTuneTime = now;

  // Auto-tune KiwiSDR WebSDR to follow
  if (kiwiActive && kiwiClient && kiwiClient.connected && freqHz > 100000) {
    const fKhz = freqHz / 1000;
    const m = (mode || _currentMode || 'USB').toLowerCase()
      .replace('digu', 'usb').replace('digl', 'lsb').replace('pktusb', 'usb').replace('pktlsb', 'lsb')
      .replace('ft8', 'usb').replace('ft4', 'usb').replace('ssb', fKhz >= 10000 ? 'usb' : 'lsb');
    kiwiClient.tune(fKhz, m);
  }

  // CW XIT: use radio's XIT (TX offset only) instead of shifting tune frequency
  const wantXit = !clearXit && (mode === 'CW') && settings.cwXit;
  // User pref: apply XIT by shifting the VFO (legacy behavior) — overrides native XIT.
  // Useful for operators who want the VFO display to reflect the offset.
  const legacyShift = !!settings.cwXitShiftVfo;
  const useNativeXit = wantXit && !legacyShift;
  const useVfoShift  = wantXit && legacyShift;
  // Clear XIT when tuning to a non-CW spot (don't leave stale XIT from a previous CW tune)
  const shouldClearXit = clearXit || (!wantXit && mode && mode !== 'CW');
  // Also disable any prior native XIT when the user has asked for the VFO-shift path
  // — otherwise the rig's native XIT would double-apply on top of the shifted VFO.
  const shouldDisableNativeXit = shouldClearXit || useVfoShift;

  const m = (mode || '').toUpperCase();
  let filterWidth = 0;
  if (m === 'CW') {
    filterWidth = settings.cwFilterWidth || 0;
  } else if (m === 'SSB' || m === 'USB' || m === 'LSB') {
    filterWidth = settings.ssbFilterWidth || 0;
  } else if (m === 'FT8' || m === 'FT4' || m === 'FT2' || m === 'DIGU' || m === 'DIGL' || m === 'PKTUSB' || m === 'PKTLSB') {
    filterWidth = settings.digitalFilterWidth || 0;
  } else if (m === 'FM') {
    filterWidth = 0; // FM has fixed bandwidth
  } else if (m === 'AM') {
    filterWidth = 0; // AM uses radio default
  }
  // Only preserve live filter adjustment if staying on the same mode category
  // (prevents CW filter from bleeding into SSB or vice versa)

  // FreeDV: auto-start/stop engine based on spot mode
  const isFreedvMode = m.startsWith('FREEDV') || m === 'DV';
  if (isFreedvMode && settings.enableFreedv) {
    // Start FreeDV engine if not already running
    if (!freedvEngine) {
      let codecMode = '700E';
      if (m.includes('RADE')) codecMode = 'RADEV1';
      else if (m.includes('700D')) codecMode = '700D';
      else if (m.includes('700C')) codecMode = '700C';
      else if (m.includes('1600')) codecMode = '1600';

      freedvEngine = new FreedvEngine();
      freedvEngine.on('rx-speech', (data) => {
        if (win && !win.isDestroyed()) win.webContents.send('freedv-rx-speech', data);
      });
      freedvEngine.on('tx-modem', (data) => {
        if (win && !win.isDestroyed()) win.webContents.send('freedv-tx-modem', data);
      });
      freedvEngine.on('sync', (data) => {
        if (win && !win.isDestroyed()) win.webContents.send('freedv-sync', data);
        if (remoteServer && remoteServer.running) remoteServer.sendToClient({ type: 'freedv-sync', ...data });
      });
      freedvEngine.on('status', (data) => sendCatLog(`[FreeDV] ${data.state} mode=${data.mode}`));
      freedvEngine.on('error', (data) => sendCatLog(`[FreeDV] Error: ${data.message}`));
      freedvEngine.start(codecMode);
      if (settings.freedvSquelch) {
        freedvEngine.setSquelch(!!settings.freedvSquelch.enabled, Number(settings.freedvSquelch.threshold));
      }
      sendCatLog(`[FreeDV] Auto-started for mode ${m} (codec ${codecMode})`);
      // Mute ECHOCAT audio so user only hears decoded FreeDV speech (not raw USB)
      _freedvAudioMuted = true;
      applyFreedvAudioMute();
      sendCatLog('[FreeDV] Muted ECHOCAT audio');
      // Tell renderer to start RX audio capture
      if (win && !win.isDestroyed()) win.webContents.send('freedv-auto-start', codecMode);
    }
    // Override mode for the radio. Two independent dimensions:
    //
    //  freedvUseDataMode (default true): DATA sideband (DIGU/DIGL,
    //    mapped to PKTUSB/PKTLSB on rigctld) vs plain SSB (USB/LSB).
    //    FreeDV transmits via the USB CODEC, so most modern rigs need
    //    DATA mode to route audio from the codec instead of the mic
    //    (FT-991A, FT-710, IC-7300, etc.). On older rigs that cap
    //    DATA-mode IF bandwidth at 2.4 kHz (FTDX3000, others), setting
    //    this false keeps the radio in plain USB/LSB where the IF is
    //    wider — operator routes audio at the rig level. (AB9AI report
    //    on FTDX3000 v1.5.7.)
    //
    //  freedvForceSideband (default '', i.e. auto):
    //    ''      → band-based: LSB <10 MHz, USB >=10 MHz. Matches
    //              voice SSB convention. (IU7RAL fix.)
    //    'upper' → always USB-side, regardless of band
    //    'lower' → always LSB-side, regardless of band
    //
    //  Operators on FTDX3000 / older Yaesus often want
    //  forceSideband='upper' so 40m FreeDV lands in plain USB (4 kHz
    //  IF instead of the band's natural LSB 2.4 kHz DATA path).
    //  (AB9AI report on v1.5.10.)
    const useData = settings.freedvUseDataMode !== false;
    const forceSb = settings.freedvForceSideband || '';
    let upperSideband;
    if (forceSb === 'upper') upperSideband = true;
    else if (forceSb === 'lower') upperSideband = false;
    else upperSideband = freqHz >= 10_000_000;
    if (useData) {
      mode = upperSideband ? 'DIGU' : 'DIGL';
    } else {
      mode = upperSideband ? 'USB' : 'LSB';
    }
  } else if (!isFreedvMode && freedvEngine) {
    // Tuned away from FreeDV — stop the engine
    sendCatLog('[FreeDV] Auto-stopped (tuned to non-FreeDV mode)');
    freedvEngine.stop();
    freedvEngine = null;
    if (win && !win.isDestroyed()) win.webContents.send('freedv-auto-stop');
    // Unmute ECHOCAT audio
    _freedvAudioMuted = false;
    applyFreedvAudioMute();
    sendCatLog('[FreeDV] Unmuted ECHOCAT audio');
  }

  if (settings.enableRotor && settings.rotorActive !== false && settings.rotorMode !== 'manual' && brng != null && !isNaN(brng)) {
    sendRotorBearing(Math.round(brng));
  }

  // Antenna Genius: switch antenna based on band
  if (settings.enableAntennaGenius) {
    agSwitchForFreq(freqKhz);
  }

  // TunerGenius 1x3: no auto-switch on tune — TGXL remembers per-band internally.
  // Manual switching via ECHOCAT / desktop buttons only.

  if (settings.enableWsjtx && (!cat || !cat.connected)) {
    if (smartSdr && smartSdr.connected && settings.catTarget && settings.catTarget.type === 'tcp') {
      const sliceIndex = (settings.catTarget.port || 5002) - 5002;
      const wsjtxTuneHz = useVfoShift ? (freqHz + settings.cwXit) : freqHz;
      const freqMhz = wsjtxTuneHz / 1e6;
      const ssbSide = freqHz < 10000000 && !(freqHz >= 5300000 && freqHz <= 5410000) ? 'LSB' : 'USB';
      const flexMode = (mode === 'FT8' || mode === 'FT4' || mode === 'FT2' || mode === 'JT65' || mode === 'JT9' || mode === 'WSPR' || mode === 'DIGU' || mode === 'PKTUSB')
        ? 'DIGU' : (mode === 'DIGL' || mode === 'PKTLSB') ? 'DIGL'
        : (mode === 'CW' ? 'CW' : (mode === 'AM' ? 'AM' : (mode === 'FM' ? 'FM' : (mode === 'SSB' ? ssbSide : (mode === 'USB' ? 'USB' : (mode === 'LSB' ? 'LSB' : null))))));
      sendCatLog(`tune via SmartSDR API: slice=${sliceIndex} freq=${freqMhz.toFixed(6)}MHz mode=${mode}->${flexMode} filter=${filterWidth}${useVfoShift ? ` (VFO shifted +${settings.cwXit}Hz for XIT)` : ''}`);
      smartSdr.tuneSlice(sliceIndex, freqMhz, flexMode, filterWidth);
      // Set or clear XIT on the slice. When the user has chosen VFO-shift mode,
      // we actively disable native slice XIT so offsets don't double up.
      if (useNativeXit) {
        smartSdr.setSliceXit(sliceIndex, true, settings.cwXit);
      } else if (shouldDisableNativeXit) {
        smartSdr.setSliceXit(sliceIndex, false);
      }
      // ATU: auto-tune on band change (SmartSDR-only path)
      if (settings.enableAtu) {
        const freqMhzSdr = freqHz / 1e6;
        const tuneBandSdr = freqToBand(freqMhzSdr);
        if (tuneBandSdr && tuneBandSdr !== _lastTuneBand) {
          _lastTuneBand = tuneBandSdr;
          setTimeout(() => {
            sendCatLog(`[ATU] Band changed to ${tuneBandSdr} -> starting SmartSDR ATU tune`);
            smartSdr.setAtu(true);
          }, 1500);
        } else if (!_lastTuneBand && tuneBandSdr) {
          _lastTuneBand = tuneBandSdr;
        }
      }
    }
    return;
  }

  if (!cat || !cat.connected) {
    sendCatLog('tune ignored — no radio connected. Check Settings -> My Rigs.');
    return;
  }

  // CW XIT dispatch:
  //   - useNativeXit: ask the rig (Yaesu XT/RU/RD or SmartSDR slice XIT) for a TX-only offset.
  //   - useVfoShift: legacy — add the offset to the VFO itself and disable any native XIT.
  //   - Otherwise (radio has no native XIT and SmartSDR isn't handling it): fall back to VFO shift.
  let tuneFreqHz = freqHz;
  let nativeXit = null;
  if (useNativeXit && cat.hasNativeXit) {
    nativeXit = settings.cwXit;
  } else if (useVfoShift) {
    tuneFreqHz = freqHz + settings.cwXit;
  } else if (wantXit && !(smartSdr && smartSdr.connected && settings.catTarget && settings.catTarget.type === 'tcp')) {
    // Automatic fallback for rigs with no native XIT and no SmartSDR
    tuneFreqHz = freqHz + settings.cwXit;
  }
  // Disable native XIT when we don't want it active (switching to non-CW OR using VFO-shift)
  if (shouldDisableNativeXit && cat.hasNativeXit) {
    nativeXit = 0;
  }

  const resolvedMode = (mode || '').toUpperCase() === 'SSB' ? (tuneFreqHz >= 10000000 ? 'USB' : 'LSB') : mode;
  // Suppress stale mode broadcasts to ECHOCAT for 2s — prevents flicker when
  // frequency-triggered status broadcasts include the OLD mode before polling catches up
  if (mode) _modeSuppressUntil = Date.now() + 2000;
  const xitTag = wantXit ? ` xit=${settings.cwXit}${useVfoShift ? ' (VFO shift)' : ''}` : '';
  sendCatLog(`tune: freq=${freqKhz}kHz -> ${tuneFreqHz}Hz mode=${mode}${mode !== resolvedMode ? '->' + resolvedMode : ''} split=${!!settings.enableSplit} filter=${filterWidth}${xitTag}`);
  cat.tune(tuneFreqHz, mode, { split: settings.enableSplit, filterWidth, xit: nativeXit });

  // Set or clear XIT via SmartSDR API (works even when tuning via CAT).
  // When legacy VFO-shift is active, force slice XIT off so the offset isn't double-applied.
  if (smartSdr && smartSdr.connected && settings.catTarget && settings.catTarget.type === 'tcp') {
    const sliceIndex = (settings.catTarget.port || 5002) - 5002;
    if (useNativeXit) {
      smartSdr.setSliceXit(sliceIndex, true, settings.cwXit);
    } else if (shouldDisableNativeXit) {
      smartSdr.setSliceXit(sliceIndex, false);
    }
  }

  // ATU: auto-tune on band change
  if (settings.enableAtu) {
    const freqMhz = freqKhz / 1000;
    const tuneBand = freqToBand(freqMhz);
    if (tuneBand && tuneBand !== _lastTuneBand) {
      _lastTuneBand = tuneBand;
      // Delay ATU trigger to let the radio settle on the new frequency first
      setTimeout(() => {
        if (smartSdr && smartSdr.connected && settings.catTarget && settings.catTarget.type === 'tcp') {
          sendCatLog(`[ATU] Band changed to ${tuneBand} -> starting SmartSDR ATU tune`);
          smartSdr.setAtu(true);
        } else if (cat && cat.connected) {
          sendCatLog(`[ATU] Band changed to ${tuneBand} -> starting ATU tune`);
          cat.startTune();
        }
      }, 1500);
    } else if (!_lastTuneBand && tuneBand) {
      // First tune — just record the band, don't trigger ATU
      _lastTuneBand = tuneBand;
    }
  }
}

// --- potacat:// protocol handler ---
if (!app.isDefaultProtocolClient('potacat')) {
  app.setAsDefaultProtocolClient('potacat');
}

function handleProtocolUrl(url) {
  // potacat://tune/14074/USB -> tune to 14074 kHz USB
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'tune' || parsed.pathname.startsWith('//tune')) {
      const parts = parsed.pathname.replace(/^\/+/, '').split('/');
      const segments = parts.filter(p => p && p.toLowerCase() !== 'tune');
      const freqKhz = segments[0];
      const mode = (segments[1] || '').toUpperCase();
      if (freqKhz && !isNaN(parseFloat(freqKhz))) {
        tuneRadio(parseFloat(freqKhz), mode);
      }
    }
  } catch (err) {
    console.error('Failed to parse protocol URL:', url, err);
  }
}

// Single instance lock — second launch passes URL to running instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find(a => a.startsWith('potacat://'));
    if (url) handleProtocolUrl(url);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// macOS: handle protocol URL when app is already running
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

// KiwiSDR state (module scope for access from connectRemote and whenReady)
let kiwiClient = null;
let kiwiActive = false;

app.whenReady().then(() => {
  logStartupStage('app.whenReady fired');
  // Add Referer header for OpenStreetMap tile requests (required by OSM usage policy)
  const { session } = require('electron');
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://*.tile.openstreetmap.org/*'] },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'https://potacat.com';
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  Menu.setApplicationMenu(null);
  settings = loadSettings();
  migrateRigSettings(settings);
  logStartupStage('settings loaded');
  if (settings.colorblindMode) {
    setSmartSdrColorblind(true);
    setTciColorblindMode(true);
  }

  // Load cty.dat for DXCC lookups
  try {
    ctyDb = loadCtyDat(path.join(__dirname, 'assets', 'cty.dat'));
  } catch (err) {
    console.error('Failed to load cty.dat:', err.message);
  }
  logStartupStage('cty.dat loaded');

  // Load SOTA association names (async, non-blocking — falls back to codes if it fails)
  loadAssociations().catch(err => console.error('Failed to load SOTA associations:', err.message));

  createWindow();
  logStartupStage('createWindow returned (BrowserWindow constructed)');
  if (HEADLESS) {
    // Force ECHOCAT on in headless mode — that's the whole point
    if (!settings.enableRemote) {
      settings.enableRemote = true;
      saveSettings(settings);
    }
    const port = settings.remotePort || 7300;
    console.log('[POTACAT] Running in headless mode — no GUI.');
    console.log(`[POTACAT] ECHOCAT enabled on port ${port}`);
    // Print URLs after a short delay to allow network interfaces to be ready
    setTimeout(() => {
      const ips = RemoteServer.getLocalIPs();
      console.log('[POTACAT] Connect via ECHOCAT:');
      for (const ip of ips) {
        const label = ip.tailscale ? (ip.tailscaleHostname || 'Tailscale') : ip.name;
        const host = ip.tailscaleHostname || ip.address;
        console.log(`  ${label}: https://${host}:${port}`);
      }
    }, 1000);
  }
  if (!settings.enableWsjtx) connectCat();
  if (settings.enableCluster) connectCluster();
  if (settings.enableCwSpots) connectCwSpots();
  if (settings.enableRbn) connectRbn();
  connectSmartSdr(); // connects if smartSdrSpots, CW keyer, or WSJT-X+Flex
  connectTci();
  connectAntennaGenius();
  connectTunerGenius();
  if (settings.enableRemote) connectRemote();
  logStartupStage('all connect* dispatched (most async, actual connections may still be pending)');
  if (settings.enableCwKeyer) connectKeyer();
  if (settings.enableWsjtx) connectWsjtx();
  if (settings.enablePskr || settings.enableFreedv) connectPskr();
  if (settings.enableFreedv) connectFreedvReporter();
  if (settings.enablePskrMap) connectPskrMap();
  if (settings.sendToLogbook && (settings.logbookType === 'hamrs' || settings.logbookType === 'logger32')) {
    hamrsBridge.start(settings.logbookHost || '127.0.0.1', parseInt(settings.logbookPort, 10) || 2237);
  }
  if (settings.extraUdpEnabled && (settings.extraUdpFormat || 'wsjtx') === 'wsjtx') {
    extraUdpBridge.start(
      settings.extraUdpHost || '127.0.0.1',
      parseInt(settings.extraUdpPort, 10) || 2237
    );
  }

  // --- Cloud Sync (optional — module may not be present in open-source builds) ---
  if (registerCloudIpc) {
    cloudIpc = registerCloudIpc({
      app,
      win: () => win,
      getSettings: () => settings,
      saveSettings: (s) => { Object.assign(settings, s); saveSettings(settings); },
      getLogPath: () => settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi'),
      loadWorkedQsos: () => loadWorkedQsos(),
      sendToRenderer: (channel, data) => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, data);
      },
    });
    cloudIpc.startBackgroundSync();
  }

  // --- POTA.app Profile (display-only; no CSV sync) ---
  // The previous CSV-pull design depended on an IAM-authorized endpoint
  // that POTACAT's Cognito User Pool JWT can't reach. The worked-parks
  // list is now harvested directly from the user's own ADIF log
  // (loadWorkedParks → harvestParksFromLog), so this module exists
  // solely to surface the user's pota.app profile counts (parks
  // hunted/activated, QSOs, awards, endorsements). No scheduler, no
  // QSO-debounced auto-pull. Sign-in only fires when the user clicks
  // Connect; refresh only when they click Refresh.
  potaSync = new PotaSync({
    settings,
    onSettingsChange: async () => { saveSettings(settings); },
    logger: (msg) => { try { sendCatLog('[pota-sync] ' + msg); } catch { console.log('[pota-sync]', msg); } },
  });
  potaSync.on('status', (s) => {
    if (win && !win.isDestroyed()) win.webContents.send('pota-sync-status', s);
  });

  ipcMain.handle('pota-sync-status', () => potaSync.status());
  ipcMain.handle('pota-sync-connect', async () => potaSync.connect());
  ipcMain.handle('pota-sync-disconnect', async () => { await potaSync.disconnect(); return potaSync.status(); });
  ipcMain.handle('pota-sync-now', async () => potaSync.pull());
  // Kept as no-op compatibility shims — old preload still wires them, and
  // a stale renderer build calling them shouldn't error.
  ipcMain.handle('pota-sync-set-enabled', async () => potaSync.status());
  ipcMain.handle('pota-sync-set-interval', async () => potaSync.status());

  // Spot history (per-callsign list of recent prior spots) for the ⓘ popover
  // on the desktop spots table. All sources are served from local rolling
  // history buffers — pota.app's /spot/comments endpoint returns empty even
  // for activators with dozens of spots, so we accumulate from the standard
  // /spot/activator polls (deduped by spotId) instead.
  ipcMain.handle('pota-spot-history', async (_e, { source, callsign, reference } = {}) => {
    const call = (callsign || '').toUpperCase();
    if (!call) return { ok: false, error: 'Missing callsign', entries: [] };
    const src = (source || '').toLowerCase();
    const buffer = src === 'pota' ? _potaSpotHistory
      : src === 'wwff' ? _wwffSpotHistory
      : src === 'dxc'  ? _dxcSpotHistory
      : src === 'rbn'  ? _rbnSpotHistory
      : null;
    if (!buffer) return { ok: false, error: 'Unsupported source: ' + src, entries: [] };
    const entries = buffer
      .filter(s => (s.callsign || '').toUpperCase() === call)
      .slice(-25).reverse(); // newest first
    return { ok: true, source: src, entries };
  });

  // Ensure launcher background service is installed for boot startup.
  // Only INSTALL (to Startup/LaunchAgents) — don't spawn duplicates on every app launch.
  // The launcher starts on next boot, or user can enable it manually in Settings.
  if (app.isPackaged && settings.enableLauncher !== false) {
    try {
      const exePath = process.execPath;
      const configDir = app.getPath('userData');
      const configPath = path.join(configDir, 'launcher-config.json');
      if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, JSON.stringify({ port: 7301, https: true }, null, 2));
      }

      if (process.platform === 'win32') {
        const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
        const vbsPath = path.join(startupDir, 'POTACAT-Launcher.vbs');
        if (!fs.existsSync(vbsPath)) {
          fs.writeFileSync(vbsPath, `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${exePath}"" --launcher", 0, False\r\n`);
          console.log('[Launcher] Installed to Windows Startup');
        }
        // Start launcher only if port 7301 is not already in use
        const net = require('net');
        const probe = net.createServer();
        probe.once('error', () => { /* port in use — launcher already running */ });
        probe.once('listening', () => {
          probe.close();
          // Port is free — start the launcher
          require('child_process').spawn(exePath, ['--launcher'], { detached: true, stdio: 'ignore' }).unref();
          console.log('[Launcher] Started background process');
        });
        probe.listen(7301, '0.0.0.0');
      } else if (process.platform === 'darwin') {
        const plistDir = path.join(require('os').homedir(), 'Library', 'LaunchAgents');
        const plistPath = path.join(plistDir, 'com.potacat.launcher.plist');
        if (!fs.existsSync(plistPath)) {
          fs.mkdirSync(plistDir, { recursive: true });
          // No KeepAlive — don't respawn endlessly. RunAtLoad starts it on login.
          const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.potacat.launcher</string><key>ProgramArguments</key><array><string>${exePath}</string><string>--launcher</string></array><key>RunAtLoad</key><true/></dict></plist>`;
          fs.writeFileSync(plistPath, plist);
          try { require('child_process').execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' }); } catch {}
          console.log('[Launcher] Installed to macOS LaunchAgents');
        }
      } else {
        // Linux: write XDG autostart .desktop so the launcher runs on next login,
        // and (if port 7301 is free) spawn it immediately for this session too.
        const os = require('os');
        const autostartDir = path.join(os.homedir(), '.config', 'autostart');
        const desktopPath = path.join(autostartDir, 'potacat-launcher.desktop');
        if (!fs.existsSync(desktopPath)) {
          fs.mkdirSync(autostartDir, { recursive: true });
          fs.writeFileSync(desktopPath, `[Desktop Entry]\nType=Application\nName=POTACAT Launcher\nExec=${exePath} --launcher\nHidden=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`);
          console.log('[Launcher] Installed to Linux autostart');
        }
        const net = require('net');
        const probe = net.createServer();
        probe.once('error', () => { /* port in use — launcher already running */ });
        probe.once('listening', () => {
          probe.close();
          require('child_process').spawn(exePath, ['--launcher'], { detached: true, stdio: 'ignore' }).unref();
          console.log('[Launcher] Started background process');
        });
        probe.listen(7301, '0.0.0.0');
      }
    } catch (err) {
      console.error('[Launcher] Setup failed:', err.message);
    }
  }

  // Cold start: check if app was launched via potacat:// URL
  const protocolUrl = process.argv.find(a => a.startsWith('potacat://'));
  if (protocolUrl) {
    setTimeout(() => handleProtocolUrl(protocolUrl), 2000);
  }

  // Configure QRZ client from saved credentials
  if (settings.enableQrz && settings.qrzUsername && settings.qrzPassword) {
    qrz.configure(settings.qrzUsername, settings.qrzPassword);
  }
  // Configure SOTA uploader
  if (settings.sotaUpload && settings.sotaUsername && settings.sotaPassword) {
    sotaUploader.configure(settings.sotaUsername, settings.sotaPassword);
  }
  // Load QRZ disk cache
  const qrzCachePath = path.join(app.getPath('userData'), 'qrz-cache.json');
  qrz.loadCache(qrzCachePath);

  // Load parks DB for activator mode
  loadParksDbForCallsign(settings.myCallsign);

  // Window control IPC
  ipcMain.on('win-minimize', () => { if (win) win.minimize(); });
  ipcMain.on('win-maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('win-close', () => { if (win) win.close(); });

  // --- Pop-out Map Window ---
  ipcMain.on('popout-map-open', () => {
    if (popoutWin && !popoutWin.isDestroyed()) {
      popoutWin.focus();
      return;
    }

    const isMac = process.platform === 'darwin';
    popoutWin = new BrowserWindow({
      width: 800,
      height: 600,
      title: 'POTACAT Map',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Restore saved bounds after creation (DPI-aware)
    const saved = settings.mapPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      popoutWin.setBounds(clampToWorkArea(saved));
    }
    popoutWin.show();

    popoutWin.setMenuBarVisibility(false);
    popoutWin.loadFile(path.join(__dirname, 'renderer', 'map-popout.html'));

    popoutWin.on('close', () => {
      if (popoutWin && !popoutWin.isDestroyed()) {
        if (!popoutWin.isMaximized() && !popoutWin.isMinimized()) {
          settings.mapPopoutBounds = popoutWin.getBounds();
          saveSettings(settings);
        }
      }
    });

    popoutWin.on('closed', () => {
      popoutWin = null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('popout-map-status', false);
      }
    });

    popoutWin.webContents.on('did-finish-load', () => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('popout-map-status', true);
      }
    });

    // F12 opens DevTools in pop-out
    popoutWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        popoutWin.webContents.toggleDevTools();
      }
    });
  });

  ipcMain.on('popout-map-close', () => {
    if (popoutWin && !popoutWin.isDestroyed()) popoutWin.close();
  });

  // Relay filtered spots from main renderer to pop-out
  ipcMain.on('popout-map-spots', (_e, data) => {
    if (popoutWin && !popoutWin.isDestroyed()) {
      popoutWin.webContents.send('popout-spots', data);
    }
  });

  // Relay tune arc from main renderer to pop-out
  ipcMain.on('popout-map-tune-arc', (_e, data) => {
    if (popoutWin && !popoutWin.isDestroyed()) {
      popoutWin.webContents.send('popout-tune-arc', data);
    }
  });

  // Relay home position updates to pop-out
  ipcMain.on('popout-map-home', (_e, data) => {
    if (popoutWin && !popoutWin.isDestroyed()) {
      popoutWin.webContents.send('popout-home', data);
    }
  });

  // --- Propagation map pop-out ---
  ipcMain.on('prop-popout-open', () => {
    if (propPopoutWin && !propPopoutWin.isDestroyed()) {
      propPopoutWin.focus();
      return;
    }

    const isMac = process.platform === 'darwin';
    propPopoutWin = new BrowserWindow({
      width: 900,
      height: 650,
      title: 'POTACAT — Propagation',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-prop-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const saved = settings.propPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      propPopoutWin.setBounds(clampToWorkArea(saved));
    }
    propPopoutWin.show();
    propPopoutWin.setMenuBarVisibility(false);
    propPopoutWin.loadFile(path.join(__dirname, 'renderer', 'prop-popout.html'));

    propPopoutWin.on('close', () => {
      if (propPopoutWin && !propPopoutWin.isDestroyed()) {
        if (!propPopoutWin.isMaximized() && !propPopoutWin.isMinimized()) {
          settings.propPopoutBounds = propPopoutWin.getBounds();
          saveSettings(settings);
        }
      }
    });

    propPopoutWin.on('closed', () => {
      propPopoutWin = null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('prop-popout-status', false);
      }
    });

    propPopoutWin.webContents.on('did-finish-load', () => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('prop-popout-status', true);
      }
      // Send current data to pop-out
      if (rbnSpots.length > 0) propPopoutWin.webContents.send('rbn-spots', rbnSpots);
      if (pskrMapSpots.length > 0) propPopoutWin.webContents.send('pskr-map-spots', pskrMapSpots);
    });

    propPopoutWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        propPopoutWin.webContents.toggleDevTools();
      }
    });
  });

  ipcMain.on('prop-popout-minimize', () => { if (propPopoutWin && !propPopoutWin.isDestroyed()) propPopoutWin.minimize(); });
  ipcMain.on('prop-popout-maximize', () => {
    if (propPopoutWin && !propPopoutWin.isDestroyed()) {
      propPopoutWin.isMaximized() ? propPopoutWin.unmaximize() : propPopoutWin.maximize();
    }
  });
  ipcMain.on('prop-popout-close', () => { if (propPopoutWin && !propPopoutWin.isDestroyed()) propPopoutWin.close(); });

  // Relay colorblind mode to pop-outs and panadapter integrations
  ipcMain.on('colorblind-mode', (_e, enabled) => {
    setSmartSdrColorblind(enabled);
    setTciColorblindMode(enabled);
    if (popoutWin && !popoutWin.isDestroyed()) popoutWin.webContents.send('colorblind-mode', enabled);
    if (spotsPopoutWin && !spotsPopoutWin.isDestroyed()) spotsPopoutWin.webContents.send('colorblind-mode', enabled);
    if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) qsoPopoutWin.webContents.send('colorblind-mode', enabled);
    if (actmapPopoutWin && !actmapPopoutWin.isDestroyed()) actmapPopoutWin.webContents.send('colorblind-mode', enabled);
    if (remoteServer) remoteServer.setColorblindMode(enabled);
  });

  // Relay WCAG mode to pop-outs
  ipcMain.on('wcag-mode', (_e, enabled) => {
    if (popoutWin && !popoutWin.isDestroyed()) popoutWin.webContents.send('wcag-mode', enabled);
    if (spotsPopoutWin && !spotsPopoutWin.isDestroyed()) spotsPopoutWin.webContents.send('wcag-mode', enabled);
    if (actmapPopoutWin && !actmapPopoutWin.isDestroyed()) actmapPopoutWin.webContents.send('wcag-mode', enabled);
  });

  // Relay theme changes to pop-out
  ipcMain.on('popout-map-theme', (_e, theme) => {
    if (popoutWin && !popoutWin.isDestroyed()) {
      popoutWin.webContents.send('popout-theme', theme);
    }
  });

  // Pop-out window controls
  ipcMain.on('popout-minimize', () => { if (popoutWin) popoutWin.minimize(); });
  ipcMain.on('popout-maximize', () => {
    if (!popoutWin) return;
    if (popoutWin.isMaximized()) popoutWin.unmaximize();
    else popoutWin.maximize();
  });
  ipcMain.on('popout-close', () => { if (popoutWin) popoutWin.close(); });

  // Relay log dialog request from pop-out to main renderer
  ipcMain.on('popout-open-log', (_e, spot) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('popout-open-log', spot);
      win.focus();
    }
  });

  // --- QSO Pop-out window ---
  ipcMain.on('qso-popout-open', () => {
    if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) {
      qsoPopoutWin.focus();
      return;
    }

    const isMac = process.platform === 'darwin';
    qsoPopoutWin = new BrowserWindow({
      width: 900,
      height: 600,
      title: 'POTACAT Logbook',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-qso-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Restore saved bounds (DPI-aware)
    const saved = settings.qsoPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      qsoPopoutWin.setBounds(clampToWorkArea(saved));
    }
    qsoPopoutWin.show();

    qsoPopoutWin.setMenuBarVisibility(false);
    qsoPopoutWin.loadFile(path.join(__dirname, 'renderer', 'qso-popout.html'));

    qsoPopoutWin.on('close', () => {
      if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) {
        if (!qsoPopoutWin.isMaximized() && !qsoPopoutWin.isMinimized()) {
          settings.qsoPopoutBounds = qsoPopoutWin.getBounds();
          saveSettings(settings);
        }
      }
    });

    qsoPopoutWin.on('closed', () => {
      qsoPopoutWin = null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('qso-popout-status', false);
      }
    });

    qsoPopoutWin.webContents.on('did-finish-load', () => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('qso-popout-status', true);
      }
    });

    // F12 opens DevTools in pop-out
    qsoPopoutWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        qsoPopoutWin.webContents.toggleDevTools();
      }
    });
  });

  // QSO pop-out window controls
  ipcMain.on('qso-popout-minimize', () => { if (qsoPopoutWin) qsoPopoutWin.minimize(); });
  ipcMain.on('qso-popout-maximize', () => {
    if (!qsoPopoutWin) return;
    if (qsoPopoutWin.isMaximized()) qsoPopoutWin.unmaximize();
    else qsoPopoutWin.maximize();
  });
  ipcMain.on('qso-popout-close', () => { if (qsoPopoutWin) qsoPopoutWin.close(); });

  // Open the QSO pop-out (logbook) and set its search input to a callsign.
  // Used by "View all in Logbook →" link in the ragchew log pop-out.
  ipcMain.on('qso-popout-search-call', (_e, call) => {
    const search = String(call || '').trim();
    if (!search) return;
    const fire = () => {
      if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) {
        qsoPopoutWin.webContents.send('qso-popout-set-search', search);
      }
    };
    if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) {
      qsoPopoutWin.focus();
      fire();
    } else {
      ipcMain.emit('qso-popout-open');
      // Window's renderer needs to load before it can accept the search msg.
      setTimeout(fire, 600);
    }
  });

  // ── Ragchew log pop-out (Ctrl+L) ──────────────────────────────────────
  ipcMain.on('log-popout-open', (_e, prefill) => {
    if (logPopoutWin && !logPopoutWin.isDestroyed()) {
      logPopoutWin.focus();
      // Re-send prefill so the open form picks up the latest CAT freq/mode
      // even if the user is reopening from a different state.
      if (prefill) logPopoutWin.webContents.send('log-popout-prefill', prefill);
      return;
    }
    const isMac = process.platform === 'darwin';
    logPopoutWin = new BrowserWindow({
      width: 540,
      height: 740,
      minWidth: 460,
      minHeight: 560,
      title: 'Log QSO',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-log-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const saved = settings.logPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      logPopoutWin.setBounds(clampToWorkArea(saved));
    }
    logPopoutWin.show();
    logPopoutWin.setMenuBarVisibility(false);
    logPopoutWin.loadFile(path.join(__dirname, 'renderer', 'log-popout.html'));

    logPopoutWin.on('close', () => {
      if (logPopoutWin && !logPopoutWin.isDestroyed()) {
        if (!logPopoutWin.isMaximized() && !logPopoutWin.isMinimized()) {
          settings.logPopoutBounds = logPopoutWin.getBounds();
          saveSettings(settings);
        }
      }
    });
    logPopoutWin.on('closed', () => { logPopoutWin = null; });

    logPopoutWin.webContents.on('did-finish-load', () => {
      if (!logPopoutWin || logPopoutWin.isDestroyed()) return;
      // Send theme + prefill once the renderer is ready.
      logPopoutWin.webContents.send('log-popout-theme', settings.lightMode ? 'light' : 'dark');
      if (prefill) logPopoutWin.webContents.send('log-popout-prefill', prefill);
    });

    // F12 toggles DevTools, mirroring other pop-outs.
    logPopoutWin.webContents.on('before-input-event', (_e2, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        logPopoutWin.webContents.toggleDevTools();
      }
    });
  });

  // Frameless window controls for the log pop-out.
  ipcMain.on('log-popout-minimize', () => { if (logPopoutWin) logPopoutWin.minimize(); });
  ipcMain.on('log-popout-close', () => { if (logPopoutWin) logPopoutWin.close(); });

  // Theme relay — fired by app.js whenever the user toggles light mode.
  ipcMain.on('log-popout-theme', (_e, theme) => {
    if (logPopoutWin && !logPopoutWin.isDestroyed()) {
      logPopoutWin.webContents.send('log-popout-theme', theme);
    }
  });

  // Relay theme to QSO pop-out
  ipcMain.on('qso-popout-theme', (_e, theme) => {
    if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) {
      qsoPopoutWin.webContents.send('qso-popout-theme', theme);
    }
  });

  // --- Spots Pop-out Window ---
  ipcMain.on('spots-popout-open', () => {
    if (spotsPopoutWin && !spotsPopoutWin.isDestroyed()) {
      spotsPopoutWin.focus();
      return;
    }

    const isMac = process.platform === 'darwin';
    spotsPopoutWin = new BrowserWindow({
      width: 900,
      height: 500,
      title: 'POTACAT Spots',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-spots-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Restore saved bounds (DPI-aware)
    const saved = settings.spotsPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      spotsPopoutWin.setBounds(clampToWorkArea(saved));
    }
    spotsPopoutWin.show();

    spotsPopoutWin.setMenuBarVisibility(false);
    spotsPopoutWin.loadFile(path.join(__dirname, 'renderer', 'spots-popout.html'));

    spotsPopoutWin.on('close', () => {
      if (spotsPopoutWin && !spotsPopoutWin.isDestroyed()) {
        if (!spotsPopoutWin.isMaximized() && !spotsPopoutWin.isMinimized()) {
          settings.spotsPopoutBounds = spotsPopoutWin.getBounds();
          saveSettings(settings);
        }
      }
    });

    spotsPopoutWin.on('closed', () => {
      spotsPopoutWin = null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('spots-popout-status', false);
      }
    });

    spotsPopoutWin.webContents.on('did-finish-load', () => {
      // Send current spots immediately
      const merged = [...lastPotaSotaSpots, ...clusterSpots, ...rbnWatchSpots, ...pskrSpots];
      spotsPopoutWin.webContents.send('spots-popout-data', merged);
      if (win && !win.isDestroyed()) {
        win.webContents.send('spots-popout-status', true);
      }
    });

    // F12 opens DevTools in pop-out
    spotsPopoutWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        spotsPopoutWin.webContents.toggleDevTools();
      }
    });
  });

  // Spots pop-out window controls
  ipcMain.on('spots-popout-minimize', () => { if (spotsPopoutWin) spotsPopoutWin.minimize(); });
  ipcMain.on('spots-popout-maximize', () => {
    if (!spotsPopoutWin) return;
    if (spotsPopoutWin.isMaximized()) spotsPopoutWin.unmaximize();
    else spotsPopoutWin.maximize();
  });
  ipcMain.on('spots-popout-close', () => { if (spotsPopoutWin) spotsPopoutWin.close(); });

  // Relay theme to spots pop-out
  ipcMain.on('spots-popout-theme', (_e, theme) => {
    if (spotsPopoutWin && !spotsPopoutWin.isDestroyed()) {
      spotsPopoutWin.webContents.send('spots-popout-theme', theme);
    }
  });

  // Relay log dialog request from spots pop-out to main renderer
  ipcMain.on('spots-popout-open-log', (_e, spot) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('popout-open-log', spot);
      win.focus();
    }
  });

  // --- DX Cluster Terminal Pop-out ---
  ipcMain.on('cluster-popout-open', () => {
    if (clusterPopoutWin && !clusterPopoutWin.isDestroyed()) {
      clusterPopoutWin.focus();
      return;
    }

    const isMac = process.platform === 'darwin';
    clusterPopoutWin = new BrowserWindow({
      width: 700,
      height: 450,
      title: 'DX Cluster Terminal',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-cluster-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Restore saved bounds (DPI-aware)
    const saved = settings.clusterPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      clusterPopoutWin.setBounds(clampToWorkArea(saved));
    }
    clusterPopoutWin.show();

    clusterPopoutWin.setMenuBarVisibility(false);
    clusterPopoutWin.loadFile(path.join(__dirname, 'renderer', 'cluster-popout.html'));

    clusterPopoutWin.on('close', () => {
      if (clusterPopoutWin && !clusterPopoutWin.isDestroyed()) {
        if (!clusterPopoutWin.isMaximized() && !clusterPopoutWin.isMinimized()) {
          settings.clusterPopoutBounds = clusterPopoutWin.getBounds();
          saveSettings(settings);
        }
      }
    });

    clusterPopoutWin.on('closed', () => {
      clusterPopoutWin = null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('cluster-popout-status', false);
      }
    });

    clusterPopoutWin.webContents.on('did-finish-load', () => {
      // Send current node list
      clusterPopoutWin.webContents.send('cluster-popout-nodes', getClusterNodeList());
      if (win && !win.isDestroyed()) {
        win.webContents.send('cluster-popout-status', true);
      }
    });

    // F12 opens DevTools in pop-out
    clusterPopoutWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        clusterPopoutWin.webContents.toggleDevTools();
      }
    });
  });

  // Cluster pop-out window controls
  ipcMain.on('cluster-popout-minimize', () => { if (clusterPopoutWin) clusterPopoutWin.minimize(); });
  ipcMain.on('cluster-popout-maximize', () => {
    if (!clusterPopoutWin) return;
    if (clusterPopoutWin.isMaximized()) clusterPopoutWin.unmaximize();
    else clusterPopoutWin.maximize();
  });
  ipcMain.on('cluster-popout-close', () => { if (clusterPopoutWin) clusterPopoutWin.close(); });

  // Relay theme to cluster pop-out
  ipcMain.on('cluster-popout-theme', (_e, theme) => {
    if (clusterPopoutWin && !clusterPopoutWin.isDestroyed()) {
      clusterPopoutWin.webContents.send('cluster-popout-theme', theme);
    }
  });

  // --- Bandspread Pop-out ---
  ipcMain.on('bandspread-popout-open', () => {
    if (bandspreadPopoutWin && !bandspreadPopoutWin.isDestroyed()) {
      bandspreadPopoutWin.focus();
      return;
    }
    const isMac = process.platform === 'darwin';
    bandspreadPopoutWin = new BrowserWindow({
      width: 900,
      height: 320,
      title: 'Bandspread',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-bandspread-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const saved = settings.bandspreadPopoutBounds;
    if (saved && saved.width > 300 && saved.height > 120 && isOnScreen(saved)) {
      bandspreadPopoutWin.setBounds(clampToWorkArea(saved));
    }
    bandspreadPopoutWin.show();
    bandspreadPopoutWin.setMenuBarVisibility(false);
    bandspreadPopoutWin.loadFile(path.join(__dirname, 'renderer', 'bandspread-popout.html'));

    // Persist bounds on resize/move as well as close, so the last known position
    // survives unclean exits (task-manager kill, power loss, etc.).
    let bandspreadBoundsSaveTimer = null;
    const saveBandspreadBounds = () => {
      if (!bandspreadPopoutWin || bandspreadPopoutWin.isDestroyed()) return;
      if (bandspreadPopoutWin.isMaximized() || bandspreadPopoutWin.isMinimized()) return;
      if (bandspreadBoundsSaveTimer) clearTimeout(bandspreadBoundsSaveTimer);
      bandspreadBoundsSaveTimer = setTimeout(() => {
        if (!bandspreadPopoutWin || bandspreadPopoutWin.isDestroyed()) return;
        settings.bandspreadPopoutBounds = bandspreadPopoutWin.getBounds();
        saveSettings(settings);
      }, 400);
    };
    bandspreadPopoutWin.on('resize', saveBandspreadBounds);
    bandspreadPopoutWin.on('move', saveBandspreadBounds);
    bandspreadPopoutWin.on('close', () => {
      if (bandspreadBoundsSaveTimer) clearTimeout(bandspreadBoundsSaveTimer);
      if (bandspreadPopoutWin && !bandspreadPopoutWin.isDestroyed()) {
        if (!bandspreadPopoutWin.isMaximized() && !bandspreadPopoutWin.isMinimized()) {
          settings.bandspreadPopoutBounds = bandspreadPopoutWin.getBounds();
          saveSettings(settings);
        }
      }
    });
    bandspreadPopoutWin.on('closed', () => {
      bandspreadPopoutWin = null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('bandspread-popout-status', false);
      }
    });
    bandspreadPopoutWin.webContents.on('did-finish-load', () => {
      const theme = settings.lightMode ? 'light' : 'dark';
      bandspreadPopoutWin.webContents.send('bandspread-popout-theme', theme);
      // Tell the main renderer the popout is up so it can push the filtered
      // view (spots + active band) immediately. We no longer push an initial
      // unfiltered snapshot from main — the renderer is the source of truth.
      if (win && !win.isDestroyed()) {
        win.webContents.send('bandspread-popout-status', true);
      }
      // Also push the current frequency right away so the cursor draws on
      // first paint, instead of waiting for the next CAT poll.
      if (typeof _currentFreqHz === 'number' && _currentFreqHz > 0) {
        bandspreadPopoutWin.webContents.send('bandspread-popout-freq', _currentFreqHz / 1000);
      }
      if (typeof _currentMode === 'string' && _currentMode) {
        bandspreadPopoutWin.webContents.send('bandspread-popout-mode', _currentMode);
      }
    });
    bandspreadPopoutWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        bandspreadPopoutWin.webContents.toggleDevTools();
      }
    });
  });

  ipcMain.on('bandspread-popout-minimize', () => { if (bandspreadPopoutWin) bandspreadPopoutWin.minimize(); });
  ipcMain.on('bandspread-popout-maximize', () => {
    if (!bandspreadPopoutWin) return;
    if (bandspreadPopoutWin.isMaximized()) bandspreadPopoutWin.unmaximize();
    else bandspreadPopoutWin.maximize();
  });
  ipcMain.on('bandspread-popout-close', () => { if (bandspreadPopoutWin) bandspreadPopoutWin.close(); });

  ipcMain.on('bandspread-popout-theme', (_e, theme) => {
    if (bandspreadPopoutWin && !bandspreadPopoutWin.isDestroyed()) {
      bandspreadPopoutWin.webContents.send('bandspread-popout-theme', theme);
    }
  });

  // Forwards the main window's filtered spot list + active-band hint to the
  // bandspread popout. The popout used to receive raw `spots` and run its own
  // (frequency-only) filter, which meant disabled sources / age limits / mode
  // filters / watchlist all leaked into the bandspread.
  ipcMain.on('bandspread-popout-push', (_e, payload) => {
    if (bandspreadPopoutWin && !bandspreadPopoutWin.isDestroyed()) {
      // When the operator has chosen an independent panadapter source set,
      // substitute the renderer's table-filtered payload with the
      // panadapter allowlist so DX-only-panadapter / POTA-only-table
      // setups actually behave that way for the bandspread too.
      if (settings.panadapterSyncTable === false) {
        const panaSpots = spotsForPanadapter(lastMergedSpots);
        payload = Object.assign({}, payload || {}, { spots: panaSpots });
      }
      bandspreadPopoutWin.webContents.send('bandspread-popout-view', payload);
    }
  });

  // Bandspread-side click-to-tune sends the spot here so the main window can
  // mark it as the active tuned spot — same highlight + scroll behavior as
  // clicking the freq cell in Table View.
  ipcMain.on('bandspread-popout-tuned-spot', (_e, payload) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('bandspread-tuned-spot', payload);
    }
  });


  // --- Activation Map Pop-out ---
  ipcMain.on('actmap-popout-open', () => {
    if (actmapPopoutWin && !actmapPopoutWin.isDestroyed()) {
      actmapPopoutWin.focus();
      return;
    }

    const isMac = process.platform === 'darwin';
    actmapPopoutWin = new BrowserWindow({
      width: 700,
      height: 500,
      title: 'Activation Map',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-actmap-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Restore saved bounds (DPI-aware)
    const saved = settings.actmapPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      actmapPopoutWin.setBounds(clampToWorkArea(saved));
    }
    actmapPopoutWin.show();

    actmapPopoutWin.setMenuBarVisibility(false);
    actmapPopoutWin.loadFile(path.join(__dirname, 'renderer', 'actmap-popout.html'));

    actmapPopoutWin.on('close', () => {
      if (actmapPopoutWin && !actmapPopoutWin.isDestroyed()) {
        if (!actmapPopoutWin.isMaximized() && !actmapPopoutWin.isMinimized()) {
          settings.actmapPopoutBounds = actmapPopoutWin.getBounds();
          saveSettings(settings);
        }
      }
    });

    actmapPopoutWin.on('closed', () => {
      actmapPopoutWin = null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('actmap-popout-status', false);
      }
    });

    actmapPopoutWin.webContents.on('did-finish-load', () => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('actmap-popout-status', true);
      }
    });

    actmapPopoutWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        actmapPopoutWin.webContents.toggleDevTools();
      }
    });
  });

  // Activation map pop-out window controls
  ipcMain.on('actmap-popout-minimize', () => { if (actmapPopoutWin) actmapPopoutWin.minimize(); });
  ipcMain.on('actmap-popout-maximize', () => {
    if (!actmapPopoutWin) return;
    if (actmapPopoutWin.isMaximized()) actmapPopoutWin.unmaximize();
    else actmapPopoutWin.maximize();
  });
  ipcMain.on('actmap-popout-close', () => { if (actmapPopoutWin) actmapPopoutWin.close(); });

  // Relay activation data to pop-out
  ipcMain.on('actmap-popout-data', (_e, data) => {
    if (actmapPopoutWin && !actmapPopoutWin.isDestroyed()) {
      actmapPopoutWin.webContents.send('actmap-data', data);
    }
  });

  ipcMain.on('actmap-popout-contact', (_e, data) => {
    if (actmapPopoutWin && !actmapPopoutWin.isDestroyed()) {
      actmapPopoutWin.webContents.send('actmap-contact-added', data);
    }
  });

  ipcMain.on('actmap-popout-theme', (_e, theme) => {
    if (actmapPopoutWin && !actmapPopoutWin.isDestroyed()) {
      actmapPopoutWin.webContents.send('actmap-theme', theme);
    }
  });

  // Capture activation map pop-out as PNG for social share image
  ipcMain.handle('capture-actmap-popout', async () => {
    if (!actmapPopoutWin || actmapPopoutWin.isDestroyed()) {
      return { success: false, error: 'Activation map is not open' };
    }
    try {
      // Hide UI overlays before capture
      await actmapPopoutWin.webContents.executeJavaScript(`
        document.querySelector('.titlebar').style.display = 'none';
        document.getElementById('qso-counter').style.display = 'none';
      `);
      // Wait a frame for Leaflet to reflow into the freed space
      await new Promise(r => setTimeout(r, 200));
      const nativeImage = await actmapPopoutWin.webContents.capturePage();
      // Restore UI overlays
      await actmapPopoutWin.webContents.executeJavaScript(`
        document.querySelector('.titlebar').style.display = '';
        document.getElementById('qso-counter').style.display = '';
      `);
      const dataUrl = nativeImage.toDataURL();
      return { success: true, dataUrl, width: nativeImage.getSize().width, height: nativeImage.getSize().height };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // --- VFO Pop-out Window ---
  ipcMain.on('vfo-popout-open', () => {
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) { vfoPopoutWin.focus(); return; }
    const isMac = process.platform === 'darwin';
    const vfoAlwaysOnTop = settings.vfoAlwaysOnTop !== false; // default true
    vfoPopoutWin = new BrowserWindow({
      width: 340, height: 560, title: 'VFO',
      show: false,
      alwaysOnTop: vfoAlwaysOnTop,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-vfo-popout.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    const saved = settings.vfoPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      vfoPopoutWin.setBounds(clampToWorkArea(saved));
    }
    vfoPopoutWin.show();
    vfoPopoutWin.setMenuBarVisibility(false);
    vfoPopoutWin.loadFile(path.join(__dirname, 'renderer', 'vfo-popout.html'));
    vfoPopoutWin.webContents.on('did-finish-load', () => {
      sendVfoState();
      if (_cachedSolarData) vfoPopoutWin.webContents.send('solar-data', _cachedSolarData);
      vfoPopoutWin.webContents.send('vfo-popout-theme', settings.lightMode ? 'light' : 'dark');
    });
    vfoPopoutWin.on('close', () => {
      if (vfoPopoutWin && !vfoPopoutWin.isDestroyed() && !vfoPopoutWin.isMaximized() && !vfoPopoutWin.isMinimized()) {
        settings.vfoPopoutBounds = vfoPopoutWin.getBounds();
        saveSettings(settings);
      }
    });
    vfoPopoutWin.on('closed', () => {
      vfoPopoutWin = null;
      if (win && !win.isDestroyed()) win.webContents.send('vfo-popout-status', false);
    });
    if (win && !win.isDestroyed()) win.webContents.send('vfo-popout-status', true);
    vfoPopoutWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') vfoPopoutWin.webContents.toggleDevTools();
    });
  });
  ipcMain.on('vfo-popout-minimize', () => { if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.minimize(); });
  ipcMain.on('vfo-popout-maximize', () => {
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) {
      vfoPopoutWin.isMaximized() ? vfoPopoutWin.unmaximize() : vfoPopoutWin.maximize();
    }
  });
  ipcMain.on('vfo-popout-close', () => { if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.close(); });

  // VFO mode/filter commands from popout
  ipcMain.on('vfo-open-log', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('open-log-form');
      win.show();
      win.focus();
    }
  });

  ipcMain.on('vfo-set-always-on-top', (_e, on) => {
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.setAlwaysOnTop(on);
    settings.vfoAlwaysOnTop = on;
    saveSettings(settings);
  });

  ipcMain.on('vfo-popout-theme', (_e, theme) => {
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) vfoPopoutWin.webContents.send('vfo-popout-theme', theme);
  });

  ipcMain.on('vfo-tuned-spot', (_e, spot) => {
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) {
      vfoPopoutWin.webContents.send('vfo-tuned-spot', spot);
    }
  });

  ipcMain.on('vfo-set-mode', (_e, mode) => {
    if (!_currentFreqHz) return;
    _lastTuneFreq = 0; // reset rate limiter
    tuneRadio(_currentFreqHz / 1000, mode);
  });
  ipcMain.on('vfo-set-filter-width', (_e, hz) => {
    if (cat && cat.connected) cat.setFilterWidth(hz);
    _currentFilterWidth = hz;
  });

  // Relay visible-spot callsigns from the main renderer's filtered spot
  // table into any open JTCAT window so decode rows can be highlighted for
  // POTA spots the user currently has in view.
  ipcMain.on('jtcat-spots-highlight', (_e, data) => {
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.webContents.send('jtcat-spots-highlight', data);
    }
    if (jtcatMapPopoutWin && !jtcatMapPopoutWin.isDestroyed()) {
      jtcatMapPopoutWin.webContents.send('jtcat-spots-highlight', data);
    }
  });

  // --- JTCAT Pop-out Window ---
  ipcMain.on('jtcat-popout-open', () => {
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.focus();
      return;
    }
    // Stop ECHOCAT JTCAT if running — only one platform at a time
    if (remoteJtcatQso) {
      remoteJtcatQso = null;
      // Halt TX on the engine so it doesn't keep transmitting
      if (ft8Engine) {
        ft8Engine._txEnabled = false;
        ft8Engine.setTxMessage('');
        ft8Engine.setTxSlot('auto');
      }
      if (remoteServer && remoteServer.hasClient && remoteServer.hasClient()) {
        remoteServer.broadcastJtcatQsoState({ phase: 'idle' });
        remoteServer.broadcastJtcatStatus({ running: false });
      }
      sendCatLog('[JTCAT] Stopping ECHOCAT FT8 — popout taking over');
    }
    const isMac = process.platform === 'darwin';
    jtcatPopoutWin = new BrowserWindow({
      width: 1100,
      height: 700,
      title: 'POTACAT — JTCAT',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-jtcat-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    const saved = settings.jtcatPopoutBounds;
    if (saved && saved.width > 400 && saved.height > 300 && isOnScreen(saved)) {
      jtcatPopoutWin.setBounds(clampToWorkArea(saved));
    }
    jtcatPopoutWin.show();
    jtcatPopoutWin.setMenuBarVisibility(false);
    jtcatPopoutWin.loadFile(path.join(__dirname, 'renderer', 'jtcat-popout.html'));
    jtcatPopoutWin.on('close', () => {
      if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
        if (!jtcatPopoutWin.isMaximized() && !jtcatPopoutWin.isMinimized()) {
          settings.jtcatPopoutBounds = jtcatPopoutWin.getBounds();
          saveSettings(settings);
        }
      }
    });
    jtcatPopoutWin.on('closed', () => {
      jtcatPopoutWin = null;
      // Clear popout QSO state and halt TX so engine doesn't keep transmitting
      if (popoutJtcatQso) {
        popoutJtcatQso = null;
        if (ft8Engine) {
          ft8Engine._txEnabled = false;
          ft8Engine.setTxMessage('');
          ft8Engine.setTxSlot('auto');
        }
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('jtcat-popout-status', false);
      }
    });
    jtcatPopoutWin.webContents.on('did-finish-load', () => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('jtcat-popout-status', true);
      }
      // Send current theme
      const theme = settings.lightMode ? 'light' : 'dark';
      jtcatPopoutWin.webContents.send('jtcat-popout-theme', theme);
    });
    jtcatPopoutWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        jtcatPopoutWin.webContents.toggleDevTools();
      }
    });
  });

  ipcMain.on('jtcat-popout-close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
  ipcMain.on('jtcat-popout-minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
  ipcMain.on('jtcat-popout-maximize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } });
  ipcMain.on('jtcat-popout-focus-main', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });

  // --- JTCAT Map Pop-out ---
  ipcMain.on('jtcat-map-popout', () => {
    if (jtcatMapPopoutWin && !jtcatMapPopoutWin.isDestroyed()) {
      jtcatMapPopoutWin.focus();
      return;
    }
    jtcatMapPopoutWin = new BrowserWindow({
      width: 700, height: 500,
      frame: false,
      webPreferences: { preload: path.join(__dirname, 'preload-jtcat-popout.js'), contextIsolation: true, nodeIntegration: false },
    });
    jtcatMapPopoutWin.loadFile('renderer/jtcat-map-popout.html');
    jtcatMapPopoutWin.on('closed', () => { jtcatMapPopoutWin = null; });
    jtcatMapPopoutWin.webContents.on('did-finish-load', () => {
      const theme = settings.lightMode ? 'light' : 'dark';
      jtcatMapPopoutWin.webContents.send('jtcat-popout-theme', theme);
    });
  });
  ipcMain.on('jtcat-popout-theme', (_e, theme) => {
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.webContents.send('jtcat-popout-theme', theme);
    }
    if (jtcatMapPopoutWin && !jtcatMapPopoutWin.isDestroyed()) {
      jtcatMapPopoutWin.webContents.send('jtcat-popout-theme', theme);
    }
  });

  // === SSTV Pop-out Window ================================================

  startSstv = function startSstv() {
    if (sstvEngine) return;
    sstvEngine = new SstvEngine();

    sstvEngine.on('encode-complete', (data) => {
      // Ensure popout is open for audio playback — open it if needed
      if (!sstvPopoutWin || sstvPopoutWin.isDestroyed()) {
        openSstvPopout();
      }
      // Key PTT
      handleRemotePtt(true);
      // Send audio to popout for playback after PTT settles (extra delay if popout just opened)
      const delay = (!sstvPopoutWin || sstvPopoutWin.isDestroyed()) ? 1500 : 200;
      setTimeout(() => {
        if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
          sstvPopoutWin.webContents.send('sstv-tx-audio', {
            samples: Array.from(data.samples),
            durationSec: data.durationSec,
          });
        } else {
          // Failsafe: release PTT if popout never opened
          handleRemotePtt(false);
        }
      }, delay);
      // Notify ECHOCAT with duration so phone can show progress
      if (remoteServer && remoteServer.hasClient()) {
        remoteServer.broadcastSstvTxStatus({ state: 'tx', durationSec: data.durationSec });
      }
    });

    sstvEngine.on('rx-vis', (data) => {
      sendCatLog(`[SSTV] VIS detected: ${data.modeName} (mode 0x${(data.mode || 0).toString(16)}) — locking onto signal`);
      _sstvLastActivityMs = Date.now();
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        sstvPopoutWin.webContents.send('sstv-rx-vis', data);
      }
    });

    sstvEngine.on('rx-line', (data) => {
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        sstvPopoutWin.webContents.send('sstv-rx-line', {
          line: data.line,
          totalLines: data.totalLines,
          rgba: Array.from(data.rgba),
        });
      }
      // Throttled progress to ECHOCAT (every 10 lines)
      if (remoteServer && remoteServer.hasClient() && data.line % 10 === 0) {
        remoteServer.broadcastSstvProgress({
          progress: data.line / data.totalLines,
          line: data.line,
          totalLines: data.totalLines,
          mode: sstvEngine._decoding ? 'decoding' : '',
        });
      }
    });

    sstvEngine.on('rx-image', (data) => {
      sendCatLog(`[SSTV] Image decoded: ${data.width}x${data.height} ${data.mode} — saving to gallery`);
      _sstvLastActivityMs = Date.now();
      // Save to gallery
      saveSstvImage(data);
      // Send to popout
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        sstvPopoutWin.webContents.send('sstv-rx-image', {
          imageData: Array.from(data.imageData),
          width: data.width,
          height: data.height,
          mode: data.mode,
        });
      }
      // Send to ECHOCAT phone
      if (remoteServer && remoteServer.hasClient()) {
        try {
          const { nativeImage } = require('electron');
          const rgba = new Uint8ClampedArray(data.imageData);
          const bgra = Buffer.alloc(rgba.length);
          for (let i = 0; i < rgba.length; i += 4) {
            bgra[i] = rgba[i + 2]; bgra[i + 1] = rgba[i + 1];
            bgra[i + 2] = rgba[i]; bgra[i + 3] = rgba[i + 3];
          }
          const img = nativeImage.createFromBitmap(bgra, { width: data.width, height: data.height });
          const base64 = img.toPNG().toString('base64');
          remoteServer.broadcastSstvRxImage({
            base64: 'data:image/png;base64,' + base64,
            mode: data.mode,
            width: data.width,
            height: data.height,
          });
        } catch (err) {
          console.error('[SSTV] ECHOCAT broadcast error:', err.message);
        }
      }
    });

    sstvEngine.on('status', (data) => {
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        sstvPopoutWin.webContents.send('sstv-status', data);
      }
    });

    sstvEngine.on('rx-debug', (data) => {
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        sstvPopoutWin.webContents.send('sstv-rx-debug', data);
      }
    });

    sstvEngine.on('error', (data) => {
      console.error('[SSTV] Engine error:', data.message);
      sendCatLog(`[SSTV] Engine error: ${data.message}`);
    });

    sstvEngine.start();
    console.log('[SSTV] Engine started');
    sendCatLog('[SSTV] Decoder started — listening for VIS headers');
    _sstvLastActivityMs = Date.now();
    // Heartbeat: every 5 minutes, if nothing has been detected, log a line
    // so the user can see the decoder is still alive vs silently dead.
    if (_sstvHeartbeatTimer) clearInterval(_sstvHeartbeatTimer);
    _sstvHeartbeatTimer = setInterval(() => {
      if (!sstvEngine) return;
      const idleMin = Math.round((Date.now() - _sstvLastActivityMs) / 60000);
      sendCatLog(`[SSTV] Decoder alive — no VIS / image in last ${idleMin} min (radio mode must be USB on all bands for SSTV)`);
    }, 5 * 60 * 1000);
  }

  function stopSstv() {
    // SAFETY: always release PTT. If a TX was in progress when the popout/app
    // closed, the Flex would otherwise keep keyed after we stopped feeding it
    // audio — an FCC problem (silent carrier).
    try { handleRemotePtt(false); } catch {}
    if (sstvEngine) {
      sstvEngine.stop();
      sstvEngine = null;
      console.log('[SSTV] Engine stopped');
      sendCatLog('[SSTV] Decoder stopped');
    }
    if (_sstvHeartbeatTimer) {
      clearInterval(_sstvHeartbeatTimer);
      _sstvHeartbeatTimer = null;
    }
  }

  function saveSstvImage(data) {
    try {
      ensureSstvGalleryDir();
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const filename = `sstv_${data.mode}_${ts}.png`;
      const { nativeImage } = require('electron');
      // ImageData is RGBA, nativeImage expects BGRA — convert
      const rgba = new Uint8ClampedArray(data.imageData);
      const bgra = Buffer.alloc(rgba.length);
      for (let i = 0; i < rgba.length; i += 4) {
        bgra[i]     = rgba[i + 2]; // B
        bgra[i + 1] = rgba[i + 1]; // G
        bgra[i + 2] = rgba[i];     // R
        bgra[i + 3] = rgba[i + 3]; // A
      }
      const img = nativeImage.createFromBitmap(bgra, { width: data.width, height: data.height });
      fs.writeFileSync(path.join(SSTV_GALLERY_DIR, filename), img.toPNG());
      console.log('[SSTV] Saved decoded image:', filename);
    } catch (err) {
      console.error('[SSTV] Save image error:', err.message);
    }
  }

  // SSTV IPC handlers
  ipcMain.on('sstv-set-sample-rate', (_e, rate) => {
    if (sstvEngine) sstvEngine.setSampleRate(rate);
    console.log('[SSTV] Audio sample rate set to ' + rate + ' Hz');
  });

  ipcMain.on('sstv-audio', (_e, buf) => {
    if (!sstvEngine) return;
    let samples;
    if (buf instanceof Float32Array) samples = buf;
    else if (Array.isArray(buf)) samples = new Float32Array(buf);
    else { try { samples = new Float32Array(Object.values(buf)); } catch { return; } }
    sstvEngine.feedAudio(samples);
  });

  ipcMain.on('sstv-encode', (_e, data) => {
    if (!sstvEngine) startSstv();
    const imageData = new Uint8ClampedArray(data.imageData);
    sstvEngine.encode(imageData, data.width, data.height, data.mode);
  });

  ipcMain.on('sstv-tx-complete', () => {
    handleRemotePtt(false);
    if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
      sstvPopoutWin.webContents.send('sstv-tx-status', { state: 'rx' });
    }
    if (remoteServer && remoteServer.hasClient()) {
      remoteServer.broadcastSstvTxStatus({ state: 'rx' });
    }
  });

  ipcMain.on('sstv-wf-bins', (_e, bins) => {
    if (remoteServer && remoteServer.hasClient()) {
      remoteServer.broadcastSstvWfBins(bins);
    }
  });

  // Desktop popout pushes its current compose to the phone for live sync
  ipcMain.on('sstv-compose-state', (_e, state) => {
    if (remoteServer && remoteServer.hasClient()) {
      remoteServer.broadcastSstvComposeState(state);
    }
  });

  ipcMain.on('sstv-stop', () => {
    if (sstvEngine) sstvEngine.stop();
  });

  ipcMain.handle('sstv-get-gallery', async () => {
    ensureSstvGalleryDir();
    try {
      const files = fs.readdirSync(SSTV_GALLERY_DIR)
        .filter(f => f.endsWith('.png'))
        .sort((a, b) => b.localeCompare(a)); // newest first
      const results = [];
      for (const f of files.slice(0, 50)) { // limit to 50 most recent
        const filePath = path.join(SSTV_GALLERY_DIR, f);
        const stat = fs.statSync(filePath);
        const data = fs.readFileSync(filePath);
        const dataUrl = 'data:image/png;base64,' + data.toString('base64');
        // Parse mode from filename: sstv_MODE_DATE.png
        const parts = f.replace('.png', '').split('_');
        const mode = parts[1] || '';
        results.push({ filename: f, dataUrl, mode, timestamp: stat.mtimeMs, width: 320, height: 256 });
      }
      return results;
    } catch (err) {
      console.error('[SSTV] Gallery read error:', err.message);
      return [];
    }
  });

  ipcMain.handle('sstv-delete-image', async (_e, filename) => {
    try {
      const filePath = path.join(SSTV_GALLERY_DIR, path.basename(filename));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return true;
    } catch { return false; }
  });

  ipcMain.handle('sstv-load-file', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(sstvPopoutWin || win, {
      title: 'Select Image for SSTV',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    const dataUrl = `data:image/${mime};base64,${data.toString('base64')}`;
    return { dataUrl, filePath };
  });

  ipcMain.on('sstv-open-gallery-folder', () => {
    ensureSstvGalleryDir();
    require('electron').shell.openPath(SSTV_GALLERY_DIR);
  });

  // SSTV pop-out window
  openSstvPopout = function() {
    if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
      // Popout already open — ask it to re-QSY to the selected SSTV freq so the
      // radio moves back from whatever POTA spot the user last tuned to.
      try { sstvPopoutWin.webContents.send('sstv-refocus-qsy'); } catch {}
      sstvPopoutWin.focus();
      return;
    }
    const isMac = process.platform === 'darwin';
    sstvPopoutWin = new BrowserWindow({
      width: 900,
      height: 700,
      title: 'POTACAT — SSTV',
      show: false,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      icon: getIconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-sstv-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    const saved = settings.sstvPopoutBounds;
    if (saved && saved.width > 400 && saved.height > 300 && isOnScreen(saved)) {
      sstvPopoutWin.setBounds(clampToWorkArea(saved));
    }
    sstvPopoutWin.show();
    sstvPopoutWin.setMenuBarVisibility(false);
    sstvPopoutWin.loadFile(path.join(__dirname, 'renderer', 'sstv-popout.html'));
    sstvPopoutWin.on('close', () => {
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        if (!sstvPopoutWin.isMaximized() && !sstvPopoutWin.isMinimized()) {
          settings.sstvPopoutBounds = sstvPopoutWin.getBounds();
          saveSettings(settings);
        }
      }
    });
    sstvPopoutWin.on('closed', () => {
      sstvPopoutWin = null;
      stopSstv();
    });
    sstvPopoutWin.webContents.on('did-finish-load', () => {
      // Send theme
      const theme = settings.lightMode ? 'light' : 'dark';
      sstvPopoutWin.webContents.send('sstv-popout-theme', theme);
      // Start SSTV engine when popout opens
      startSstv();
    });
    sstvPopoutWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        sstvPopoutWin.webContents.toggleDevTools();
      }
    });
  };

  ipcMain.on('sstv-popout-open', () => openSstvPopout());

  ipcMain.on('sstv-popout-theme', (_e, theme) => {
    if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
      sstvPopoutWin.webContents.send('sstv-popout-theme', theme);
    }
  });
  ipcMain.on('sstv-popout-close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
  ipcMain.on('sstv-popout-minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
  ipcMain.on('sstv-popout-maximize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } });

  // --- SSTV Multi-Slice ---

  function stopSstvMulti() {
    if (sstvManager) {
      sstvManager.stopAll();
      sstvManager = null;
      console.log('[SSTV] Multi-slice stopped');
    }
  }

  ipcMain.on('sstv-start-multi', (_e, slices) => {
    if (!Array.isArray(slices) || slices.length === 0) return;
    stopSstvMulti();
    sstvManager = new SstvManager();

    // Wire events from all slices
    sstvManager.on('rx-vis', (data) => {
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        sstvPopoutWin.webContents.send('sstv-rx-vis', data);
      }
    });

    sstvManager.on('rx-line', (data) => {
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        sstvPopoutWin.webContents.send('sstv-rx-line', {
          line: data.line, totalLines: data.totalLines,
          rgba: Array.from(data.rgba), sliceId: data.sliceId,
        });
      }
    });

    sstvManager.on('rx-image', (data) => {
      saveSstvImage(data);
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        sstvPopoutWin.webContents.send('sstv-rx-image', {
          imageData: Array.from(data.imageData),
          width: data.width, height: data.height,
          mode: data.mode, sliceId: data.sliceId,
        });
      }
      if (remoteServer && remoteServer.hasClient()) {
        try {
          const { nativeImage } = require('electron');
          const rgba = new Uint8ClampedArray(data.imageData);
          const bgra = Buffer.alloc(rgba.length);
          for (let i = 0; i < rgba.length; i += 4) {
            bgra[i] = rgba[i + 2]; bgra[i + 1] = rgba[i + 1];
            bgra[i + 2] = rgba[i]; bgra[i + 3] = rgba[i + 3];
          }
          const img = nativeImage.createFromBitmap(bgra, { width: data.width, height: data.height });
          const base64 = img.toPNG().toString('base64');
          remoteServer.broadcastSstvRxImage({
            base64: 'data:image/png;base64,' + base64,
            mode: data.mode, width: data.width, height: data.height,
          });
        } catch (err) { console.error('[SSTV] Multi broadcast error:', err.message); }
      }
    });

    sstvManager.on('status', (data) => {
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        sstvPopoutWin.webContents.send('sstv-status', data);
      }
    });

    sstvManager.on('rx-debug', (data) => {
      if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
        sstvPopoutWin.webContents.send('sstv-rx-debug', data);
      }
    });

    // Start each slice
    for (const s of slices) {
      sstvManager.startSlice(s);
      // Tune the Flex slice if slicePort is set
      if (s.slicePort && smartSdr && smartSdr.connected) {
        const sliceIndex = s.slicePort - 5002;
        smartSdr.tuneSlice(sliceIndex, s.freqKhz / 1000, 'USB');
        smartSdr.setSliceFilter(sliceIndex, 100, 2800);
      }
    }

    console.log('[SSTV] Multi-slice started: ' + slices.map(s => s.sliceId + '@' + s.freqKhz).join(', '));
  });

  ipcMain.on('sstv-stop-multi', () => {
    stopSstvMulti();
    if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
      sstvPopoutWin.webContents.send('sstv-status', { state: 'stopped', multi: false });
    }
  });

  ipcMain.on('sstv-slice-audio', (_e, sliceId, buf) => {
    if (!sstvManager) return;
    let samples;
    if (buf instanceof Float32Array) samples = buf;
    else if (Array.isArray(buf)) samples = new Float32Array(buf);
    else { try { samples = new Float32Array(Object.values(buf)); } catch { return; } }
    sstvManager.feedAudio(sliceId, samples);
  });

  // === End SSTV ============================================================

  // --- Popout QSO state machine (drives engine directly, like ECHOCAT) ---
  ipcMain.on('jtcat-popout-reply', async (_e, data) => {
    // Route TX to correct slice in multi-slice mode
    const replySliceId = data.sliceId || 'default';
    const replyEngine = (jtcatManager && data.sliceId) ? jtcatManager.getEngine(data.sliceId) : ft8Engine;
    if (!replyEngine) return;
    if (jtcatManager && data.sliceId) { jtcatManager.setTxSlice(data.sliceId); jtcatManager.requestTx(data.sliceId); }
    const myCall = (settings.myCallsign || '').toUpperCase();
    const myGrid = (settings.grid || '').toUpperCase().substring(0, 4);
    if (!myCall) return;
    // If replacing an active QSO that had reports exchanged but wasn't logged yet, log it
    if (popoutJtcatQso && popoutJtcatQso.call && popoutJtcatQso.report &&
        popoutJtcatQso.phase !== '73' && popoutJtcatQso.phase !== 'done' &&
        popoutJtcatQso.call.toUpperCase() !== (data.call || '').toUpperCase()) {
      sendCatLog(`[JTCAT] Replacing active QSO with ${popoutJtcatQso.call} — auto-logging`);
      await jtcatAutoLog(popoutJtcatQso);
    }
    // Halt any active TX (e.g. CQ) so reply goes out on next boundary
    if (replyEngine._txActive) replyEngine.txComplete();
    replyEngine.setTxFreq(data.df || 1500);
    replyEngine.setRxFreq(data.df || 1500);
    // TX on opposite slot from the station we're replying to
    const targetSlot = data.slot || replyEngine._lastRxSlot;
    replyEngine.setTxSlot(targetSlot === 'even' ? 'odd' : (targetSlot === 'odd' ? 'even' : 'auto'));

    // Helper: render a signal report for our SNR field (e.g. -10, +05).
    const fmtSnr = (snr) => {
      const v = Math.round(snr || 0);
      return v >= 0 ? '+' + String(v).padStart(2, '0') : '-' + String(Math.abs(v)).padStart(2, '0');
    };

    // Renderer (popout / phone) now sends an explicit `nextStep` so we can
    // distinguish step 3 (their plain signal report → we send R+report) from
    // step 4 (their R-prefixed report → we send RR73), and step 2 (their
    // grid reply to our CQ → we send signal report) from step 1 (we are
    // replying with our grid to their CQ). Old `data.rr73` / `data.report`
    // are kept as fallbacks for any caller that hasn't been updated yet.
    // Chris N4RDX sequencing report 2026-04-29.
    let nextStep = data.nextStep;
    if (!nextStep) {
      if (data.rr73) nextStep = 'send-73';
      else if (data.report) nextStep = 'send-r-report'; // legacy: assumed plain signal
      else nextStep = 'reply-cq';
    }

    let txMsg, phase;
    const ourRpt = fmtSnr(data.snr);
    if (nextStep === 'send-73') {
      txMsg = data.call + ' ' + myCall + ' 73';
      phase = '73';
    } else if (nextStep === 'send-rr73') {
      // Their step 4 (R+signal) → we send step 5 (RR73). Carry any prior
      // QSO state if it's the same caller, otherwise create a new entry.
      txMsg = data.call + ' ' + myCall + ' RR73';
      phase = 'rr73';
      const sameCall = popoutJtcatQso && popoutJtcatQso.call && popoutJtcatQso.call.toUpperCase() === data.call.toUpperCase();
      popoutJtcatQso = {
        mode: 'reply', call: data.call,
        grid: (data.theirGrid || data.grid || (sameCall ? popoutJtcatQso.grid : '')),
        phase, txMsg,
        report: data.theirReport || data.report || (sameCall ? popoutJtcatQso.report : null),
        sentReport: (sameCall ? popoutJtcatQso.sentReport : null) || ourRpt,
        myCall, myGrid, txRetries: 0, sliceId: replySliceId,
      };
    } else if (nextStep === 'send-r-report') {
      // Their step 3 (plain signal report) → we send step 4 (R+ourReport).
      txMsg = data.call + ' ' + myCall + ' R' + ourRpt;
      phase = 'r+report';
      popoutJtcatQso = {
        mode: 'reply', call: data.call,
        grid: data.theirGrid || data.grid || '',
        phase, txMsg,
        report: data.theirReport || data.report,
        sentReport: ourRpt,
        myCall, myGrid, txRetries: 0, sliceId: replySliceId,
      };
    } else if (nextStep === 'send-report') {
      // Their step 2 (grid reply) → we send step 3 (plain signal report).
      // Old code treated this as a fresh CQ-reply (sending OUR grid back),
      // which rolled back the QSO whenever a stale step-2 message was
      // double-clicked after we'd already advanced.
      txMsg = data.call + ' ' + myCall + ' ' + ourRpt;
      phase = 'report';
      popoutJtcatQso = {
        mode: 'reply', call: data.call,
        grid: data.theirGrid || data.grid || '',
        phase, txMsg,
        report: null,
        sentReport: ourRpt,
        myCall, myGrid, txRetries: 0, sliceId: replySliceId,
      };
    } else {
      // 'reply-cq' — fresh reply with our grid (step 1 → step 2).
      txMsg = data.call + ' ' + myCall + ' ' + myGrid;
      phase = 'reply';
    }

    if (phase === '73') {
      // Send 73 courtesy — preserve reports from existing QSO if same call, don't re-log
      const prev = popoutJtcatQso;
      const sameCall = prev && prev.call && prev.call.toUpperCase() === data.call.toUpperCase();
      popoutJtcatQso = { mode: 'reply', call: data.call, grid: data.grid || (sameCall ? prev.grid : ''), phase, txMsg,
        report: sameCall ? prev.report : null,
        sentReport: sameCall ? prev.sentReport : null,
        myCall, myGrid, txRetries: 0, sliceId: replySliceId };
      replyEngine._txEnabled = true;
      await replyEngine.setTxMessage(txMsg);
      replyEngine.tryImmediateTx();
      if (!sameCall) await jtcatAutoLog(popoutJtcatQso);
    } else if (!popoutJtcatQso || popoutJtcatQso.phase !== phase) {
      // Only set up QSO if not already created above (report case)
      if (phase === 'reply') {
        popoutJtcatQso = { mode: 'reply', call: data.call, grid: data.grid, phase, txMsg, report: null, sentReport: null, myCall, myGrid, txRetries: 0, sliceId: replySliceId };
      }
      replyEngine._txEnabled = true;
      await replyEngine.setTxMessage(txMsg);
      replyEngine.tryImmediateTx();
    } else {
      replyEngine._txEnabled = true;
      await replyEngine.setTxMessage(txMsg);
      replyEngine.tryImmediateTx();
    }

    popoutBroadcastQso();
    console.log('[JTCAT Popout] Reply to', data.call, '— phase:', phase, '— slot:', replyEngine._txSlot, '—', txMsg);
  });

  ipcMain.on('jtcat-popout-call-cq', async (_e, modifier) => {
    sendCatLog(`[JTCAT] CQ button pressed (engine=${!!ft8Engine})`);
    if (!ft8Engine) {
      console.log('[JTCAT Popout] CQ aborted — engine not running');
      sendCatLog('[JTCAT] CQ aborted — engine not running. Open JTCAT first.');
      return;
    }
    const myCall = (settings.myCallsign || '').toUpperCase();
    const myGrid = (settings.grid || '').toUpperCase().substring(0, 4);
    if (!myCall || !myGrid) {
      console.log('[JTCAT Popout] CQ aborted — callsign:', myCall || '(empty)', 'grid:', myGrid || '(empty)');
      sendCatLog(`[JTCAT] CQ aborted — ${!myCall ? 'callsign not set' : 'grid not set'} in Settings`);
      return;
    }
    const mod = (modifier || '').toUpperCase().replace(/[^A-Z]/g, '').substring(0, 4);
    const txMsg = mod ? 'CQ ' + mod + ' ' + myCall + ' ' + myGrid : 'CQ ' + myCall + ' ' + myGrid;
    // TX on opposite slot from last decode; default to 'even' if no decodes yet
    const nextSlot = ft8Engine._lastRxSlot === 'even' ? 'odd' : 'even';
    ft8Engine.setTxSlot(nextSlot);
    popoutJtcatQso = { mode: 'cq', call: null, grid: null, phase: 'cq', txMsg, report: null, sentReport: null, myCall, myGrid, txRetries: 0 };
    ft8Engine._txEnabled = true;
    sendCatLog(`[JTCAT] CQ encoding: ${txMsg} slot=${nextSlot}`);
    await ft8Engine.setTxMessage(txMsg);
    const fired = ft8Engine.tryImmediateTx();
    if (!fired) {
      sendCatLog(`[JTCAT] CQ queued for next ${nextSlot} slot: ${txMsg} (samples=${ft8Engine._txSamples ? 'ready' : 'encoding'})`);
    } else {
      sendCatLog(`[JTCAT] CQ immediate TX: ${txMsg}`);
    }
    popoutBroadcastQso();
    console.log('[JTCAT Popout] CQ:', txMsg, 'slot:', nextSlot, 'immediate:', fired);
  });

  ipcMain.on('jtcat-popout-auto-cq-mode', (_e, mode) => {
    jtcatAutoCqMode = mode || 'off';
    jtcatAutoCqOwner = 'popout';
    if (mode === 'off') jtcatAutoCqWorkedSession.clear();
    broadcastAutoCqState();
    console.log('[JTCAT Popout] Auto-CQ mode:', mode);
  });

  ipcMain.on('jtcat-popout-skip-phase', async () => {
    if (!popoutJtcatQso || popoutJtcatQso.phase === 'done' || popoutJtcatQso.phase === 'idle') return;
    const q = popoutJtcatQso;
    const eng = (q.sliceId && jtcatManager) ? jtcatManager.getEngine(q.sliceId) : ft8Engine;
    if (!eng) return;
    const myCall = q.myCall;
    const validCall = q.call && /^[A-Z0-9/]{2,}$/i.test(q.call);
    if (q.mode === 'cq') {
      if (q.phase === 'cq' || q.phase === 'cq-report') {
        q.txMsg = validCall ? (q.call + ' ' + myCall + ' RR73') : '';
        q.phase = validCall ? 'cq-rr73' : 'done';
      } else {
        q.phase = 'done';
      }
    } else {
      if (q.phase === 'reply') {
        const rpt = q.sentReport || '-10';
        q.txMsg = q.call + ' ' + myCall + ' R' + rpt;
        q.phase = 'r+report';
      } else if (q.phase === 'r+report') {
        q.txMsg = q.call + ' ' + myCall + ' RR73';
        q.phase = '73';
      } else {
        q.phase = 'done';
      }
    }
    if (q.phase === 'done') {
      eng._txEnabled = false;
      eng.setTxMessage('');
      eng.setTxSlot('auto');
    }
    q.txRetries = 0;
    if (q.txMsg && q.phase !== 'done') {
      await eng.setTxMessage(q.txMsg);
    }
    popoutBroadcastQso();
    console.log('[JTCAT Popout] Skip to phase:', q.phase, '— TX:', q.txMsg);
  });

  ipcMain.on('jtcat-popout-cancel-qso', () => {
    const q = popoutJtcatQso;
    popoutJtcatQso = null;
    const eng = (q && q.sliceId && jtcatManager) ? jtcatManager.getEngine(q.sliceId) : ft8Engine;
    if (eng) {
      eng._txEnabled = false;
      eng.setTxMessage('');
      eng.setTxSlot('auto');
      if (eng._txActive) eng.txComplete();
    }
    popoutBroadcastQso();
    console.log('[JTCAT Popout] QSO cancelled');
  });

  // Capture a specific rect of the main window (for inline activation map)
  ipcMain.handle('capture-main-window-rect', async (_e, rect) => {
    if (!win || win.isDestroyed()) return { success: false, error: 'Main window not available' };
    try {
      const nativeImage = await win.webContents.capturePage(rect);
      const dataUrl = nativeImage.toDataURL();
      return { success: true, dataUrl, width: nativeImage.getSize().width, height: nativeImage.getSize().height };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Save share image JPG via save dialog
  ipcMain.handle('save-share-image', async (event, data) => {
    const { jpgBase64, parkRef, callsign } = data;
    if (!jpgBase64) return { success: false, error: 'No image data' };
    try {
      const parentWin = BrowserWindow.fromWebContents(event.sender) || win;
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      const defaultName = `${callsign || 'POTACAT'}-${parkRef || 'activation'}-${dateStr}.jpg`;
      const result = await dialog.showSaveDialog(parentWin, {
        title: 'Save Share Image',
        defaultPath: path.join(app.getPath('pictures'), defaultName),
        filters: [
          { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled) return { success: false };
      const buf = Buffer.from(jpgBase64, 'base64');
      fs.writeFileSync(result.filePath, buf);
      return { success: true, path: result.filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Start spot fetching
  refreshSpots();
  const refreshMs = Math.max(15, settings.refreshInterval || 30) * 1000;
  spotTimer = setInterval(refreshSpots, refreshMs);

  // Start solar data fetching (every 10 minutes)
  solarTimer = setInterval(fetchSolarData, 600000);

  // Start auto-SSTV idle timer
  startAutoSstvTimer();

  // Start idle CAT-polling pause timer
  startIdlePauseTimer();

  // Check for updates (after a short delay so the window is ready)
  if (!settings.disableAutoUpdate) {
    setTimeout(checkForUpdates, 5000);
  }

  // Send telemetry ping on launch (opt-in only, after short delay)
  setTimeout(() => sendTelemetry(0), 8000);



  // IPC handlers

  // Reliable clipboard write via main-process Electron API.
  // The renderer's navigator.clipboard.writeText silently fails in some
  // contexts (focus loss, permissions) — main-process clipboard always works.
  ipcMain.handle('copy-to-clipboard', (_e, text) => {
    try {
      clipboard.writeText(String(text || ''));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('open-external', (_e, url) => {
    const { shell } = require('electron');
    // Allow opening local log files
    if (url.startsWith('file://')) {
      const filePath = url.replace('file://', '');
      shell.showItemInFolder(filePath);
      return;
    }
    // Only allow known URLs
    const allowed = [
      'https://www.qrz.com/', 'https://caseystanton.com/', 'https://github.com/Waffleslop/POTACAT/',
      'https://hamlib.github.io/', 'https://github.com/Hamlib/', 'https://discord.gg/',
      'https://potacat.com/', 'https://docs.potacat.com/', 'https://buymeacoffee.com/potacat', 'https://docs.google.com/spreadsheets/',
      'https://pota.app/', 'https://www.sotadata.org.uk/', 'https://wwff.co/', 'https://llota.app/',
      'https://tailscale.com', 'https://worldradioleague.com',
      'https://api.potacat.com/',
      'http://rx.linkfanel.net', 'http://kiwisdr.com', 'http://websdr.org',
    ];
    if (allowed.some(prefix => url.startsWith(prefix))) {
      shell.openExternal(url);
    }
  });

  ipcMain.on('rotate-to', (_e, azimuth) => {
    if (settings.enableRotor && !isNaN(azimuth)) {
      sendRotorBearing(Math.round(azimuth));
    }
  });

  function applyVfoLock(locked) {
    _vfoLocked = !!locked;
    // Broadcast lock state to all Electron windows (desktop VFO popout etc.)
    for (const wc of require('electron').webContents.getAllWebContents()) {
      wc.send('vfo-lock-state', _vfoLocked);
    }
    // Sync to ECHOCAT clients over WS so the lock pill there stays in sync.
    if (remoteServer && typeof remoteServer.setVfoLocked === 'function') {
      remoteServer.setVfoLocked(_vfoLocked);
    }
  }
  ipcMain.on('vfo-set-lock', (_e, locked) => applyVfoLock(locked));
  // ECHOCAT clients toggle via WS; remote-server emits this event.
  if (remoteServer) remoteServer.on('vfo-set-lock', (locked) => applyVfoLock(locked));

  // --- KiwiSDR / WebSDR.org integration ---
  const { KiwiSdrClient } = require('./lib/kiwisdr');
  const { WebSdrClient } = require('./lib/websdr');
  // kiwiClient and kiwiActive declared near top of whenReady for global access

  ipcMain.on('kiwi-connect', (_e, { host: rawHost, port: rawPort, password }) => {
    // Sanitize host — strip http://, https://, trailing slashes
    const host = (rawHost || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const port = rawPort || 8073;
    if (!host) { sendCatLog('[WebSDR] No host specified'); return; }
    if (kiwiClient) kiwiClient.disconnect();
    // Port-based protocol selection: 8073 = KiwiSDR, anything else = WebSDR.org.
    // WebSDR.org has its own byte-tagged binary protocol over a WebSocket at
    // /~~stream — see lib/websdr.js. Both clients share the same EventEmitter
    // shape so the wiring below works for either.
    const isWebSdr = port !== 8073;
    if (isWebSdr) {
      kiwiClient = new WebSdrClient();
      sendCatLog(`[WebSDR] Using WebSDR.org protocol for ${host}:${port}`);
    } else {
      kiwiClient = new KiwiSdrClient();
    }
    const kiwiFullHost = host + ':' + port;
    kiwiClient.on('log', (msg) => sendCatLog(`[WebSDR] ${msg}`));
    kiwiClient.on('connected', () => {
      kiwiActive = true;
      sendCatLog(`[WebSDR] Connected to ${kiwiFullHost}`);
      // Auto-tune to current rig frequency on connect.
      if (_currentFreqHz > 0 && _currentMode) {
        const mode = _currentMode.toLowerCase().replace('digu', 'usb').replace('digl', 'lsb').replace('pktusb', 'usb').replace('pktlsb', 'lsb');
        kiwiClient.tune(_currentFreqHz / 1000, mode);
      }
      if (kiwiClient.setAgc) kiwiClient.setAgc(true);
      for (const wc of require('electron').webContents.getAllWebContents()) {
        wc.send('kiwi-status', { connected: true, host: kiwiFullHost });
      }
      if (remoteServer && remoteServer.hasClient && remoteServer.hasClient()) {
        remoteServer.sendToClient({ type: 'kiwi-status', connected: true, host: kiwiFullHost });
      }
    });
    let _kiwiAudioCount = 0;
    kiwiClient.on('audio', (pcmFloat, sampleRate) => {
      if (++_kiwiAudioCount === 1) sendCatLog(`[WebSDR] First audio packet: ${pcmFloat.length} samples @ ${sampleRate}Hz`);
      // Forward audio to VFO popout and main window
      if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) {
        vfoPopoutWin.webContents.send('kiwi-audio', { pcm: Array.from(pcmFloat), sampleRate });
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('kiwi-audio', { pcm: Array.from(pcmFloat), sampleRate });
      }
      // Forward to ECHOCAT phone via WebSocket
      if (remoteServer && remoteServer.hasClient && remoteServer.hasClient()) {
        if (_kiwiAudioCount === 10) sendCatLog(`[WebSDR] Streaming audio to ECHOCAT (${pcmFloat.length} samples/packet)`);
        remoteServer.sendToClient({ type: 'kiwi-audio', pcm: Array.from(pcmFloat), sampleRate });
      }
    });
    kiwiClient.on('smeter', (dbm) => {
      if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) {
        vfoPopoutWin.webContents.send('kiwi-smeter', dbm);
      }
    });
    kiwiClient.on('disconnected', () => {
      kiwiActive = false;
      sendCatLog('[WebSDR] Disconnected');
      for (const wc of require('electron').webContents.getAllWebContents()) {
        wc.send('kiwi-status', { connected: false });
      }
      if (remoteServer && remoteServer.hasClient && remoteServer.hasClient()) {
        remoteServer.sendToClient({ type: 'kiwi-status', connected: false });
      }
    });
    kiwiClient.on('error', (msg) => {
      sendCatLog(`[WebSDR] Error: ${msg}`);
      for (const wc of require('electron').webContents.getAllWebContents()) {
        wc.send('kiwi-status', { connected: false, error: msg });
      }
      if (remoteServer && remoteServer.hasClient && remoteServer.hasClient()) {
        remoteServer.sendToClient({ type: 'kiwi-status', connected: false, error: msg });
      }
    });
    if (isWebSdr) {
      // WebSDR.org: connect signature is (host, port, freqKhz, mode, options).
      // We send an initial tune at connect time so the receiver has a valid
      // frequency before any audio flows. Subsequent QSYs use kiwiClient.tune().
      const freqKhz = _currentFreqHz > 0 ? _currentFreqHz / 1000 : 7200;
      const mode = (_currentMode || 'USB').toLowerCase()
        .replace('digu', 'usb').replace('digl', 'lsb')
        .replace('pktusb', 'usb').replace('pktlsb', 'lsb');
      kiwiClient.connect(host, port, freqKhz, mode, { callsign: settings.myCallsign || '' });
    } else {
      // KiwiSDR connect: pass myCallsign through so the client can both
      // identify (SET ident_user) and authenticate as a real ham (SET auth p=)
      // for extended listener time on tlimit-restricted kiwis.
      kiwiClient.connect(host, port, password, settings.myCallsign || '');
    }
  });

  ipcMain.on('kiwi-disconnect', () => {
    if (kiwiClient) { kiwiClient.disconnect(); kiwiClient = null; }
    kiwiActive = false;
  });

  ipcMain.on('kiwi-tune', (_e, { freqKhz, mode }) => {
    if (kiwiClient && kiwiClient.connected) {
      const m = (mode || 'usb').toLowerCase().replace('digu', 'usb').replace('digl', 'lsb').replace('pktusb', 'usb').replace('pktlsb', 'lsb');
      kiwiClient.tune(freqKhz, m);
    }
  });

  // KiwiSDR bridge listeners are now inside connectRemote()

  // (Earlier this block wrapped sendCatFrequency to also retune the kiwi on
  // every cat 'frequency' poll response. That race-conditioned with the
  // spot-click path: the rig takes ~500 ms to process FA<new>, so the next
  // poll responds with the OLD frequency, and the wrapper would yank the
  // kiwi back to the previous tuning every second. tuneRadio() and the
  // 'tune' / 'apply-vfo-profile' IPC handlers already retune the kiwi
  // directly with the authoritative spot data, so the wrapper was strictly
  // harmful and is removed. External rig tunes (knob, SmartSDR app) no
  // longer auto-follow the kiwi — acceptable; that path needs a real
  // race-protection design before re-introducing.)

  ipcMain.on('tune', (_e, { frequency, mode, bearing, slicePort }) => {
    markUserActive();
    if (_vfoLocked) {
      _e.sender.send('tune-blocked', 'VFO Locked — Unlock VFO to change frequency');
      return;
    }
    if (slicePort && smartSdr && smartSdr.connected) {
      // JTCAT on a separate Flex slice
      const sliceIndex = slicePort - 5002;
      const freqHz = Math.round(parseFloat(frequency) * 1000);
      const jtSsbSide = freqHz < 10000000 && !(freqHz >= 5300000 && freqHz <= 5410000) ? 'LSB' : 'USB';
      const flexMode = (mode === 'FT8' || mode === 'FT4' || mode === 'FT2' || mode === 'DIGU')
        ? 'DIGU' : (mode === 'CW' ? 'CW' : (mode === 'SSB' ? jtSsbSide : (mode === 'USB' ? 'USB' : (mode === 'LSB' ? 'LSB' : null))));
      const filterWidth = settings.digitalFilterWidth || 0;
      sendCatLog(`JTCAT tune via SmartSDR: slice=${String.fromCharCode(65 + sliceIndex)} freq=${(freqHz / 1e6).toFixed(6)}MHz mode=${flexMode}`);
      smartSdr.tuneSlice(sliceIndex, freqHz / 1e6, flexMode, filterWidth);
      // Ensure TX is routed to this slice (prevents TX going to a different slice
      // that was last used by WSJT-X or another app)
      smartSdr.setTxSlice(sliceIndex);
      smartSdr.setActiveSlice(sliceIndex);
    } else {
      tuneRadio(frequency, mode, bearing);
    }
    // Auto-tune KiwiSDR to match
    if (kiwiActive && kiwiClient && kiwiClient.connected) {
      const freqKhz = parseFloat(frequency);
      if (freqKhz > 100) {
        const m = (mode || _currentMode || 'USB').toLowerCase().replace('digu', 'usb').replace('digl', 'lsb').replace('pktusb', 'usb').replace('pktlsb', 'lsb').replace('ft8', 'usb').replace('ft4', 'usb').replace('ssb', freqKhz >= 10000 ? 'usb' : 'lsb');
        sendCatLog(`[WebSDR] Auto-tune: ${freqKhz} kHz mode=${m}`);
        kiwiClient.tune(freqKhz, m);
      }
    }
  });

  // --- Rig Control Panel IPC ---
  ipcMain.handle('rig-control', (_e, data) => {
    if (!data || !data.action) return;
    const flexSdr = () => smartSdr && smartSdr.connected;
    const rigType = detectRigType();
    // Flex radios need SmartSDR API for most controls — Kenwood CAT on port 5002
    // only supports FA/MD/NB. Warn if SmartSDR is down instead of silently
    // sending unsupported Kenwood commands that return '?' errors.
    const flexNeedsApi = rigType === 'flex' && !flexSdr();
    const _flexWarnOnce = (() => {
      let _last = 0;
      return (msg) => { const now = Date.now(); if (now - _last > 5000) { _last = now; sendCatLog(msg); } };
    })();
    switch (data.action) {
      case 'set-nb': {
        const on = !!data.value;
        if (flexSdr()) {
          smartSdr.setSliceNb(0, on);
        } else if (cat && cat.connected) {
          cat.setNb(on);
        }
        _currentNbState = on;
        broadcastRigState();
        break;
      }
      case 'atu-tune': {
        // External RF-sensing tuner (LDG Z-100plus / MFJ) path — emits a low-
        // power CW carrier so the tuner can match. Internal CAT tune is used
        // only when no external tuner is configured on the active rig.
        const rig = (settings.rigs || []).find(r => r.id === settings.activeRigId);
        if (rig && rig.externalAtu === 'rf-sense') {
          runExternalAtuTune(); // async fire-and-forget
          break;
        }
        if (flexNeedsApi) { sendCatLog('ATU requires SmartSDR API — not connected'); break; }
        const atuOn = !_currentAtuState; // toggle
        if (flexSdr()) {
          smartSdr.setAtu(atuOn);
        } else if (cat && cat.connected) {
          if (atuOn) cat.startTune();
          else cat.stopTune();
        }
        _currentAtuState = atuOn;
        broadcastRigState();
        break;
      }
      case 'power-on': {
        // Power-on: radio may be off, so don't require cat.connected — just need transport open
        if (cat && rigType !== 'flex') {
          cat.setPowerState(true);
        }
        break;
      }
      case 'power-off': {
        if (cat && cat.connected && rigType !== 'flex') {
          cat.setPowerState(false);
        }
        break;
      }
      case 'set-rf-gain': {
        if (flexNeedsApi) { _flexWarnOnce('RF Gain requires SmartSDR API — not connected'); break; }
        const value = Number(data.value) || 0;
        if (flexSdr()) {
          const dB = (value * 0.3) - 10;
          smartSdr.setRfGain(0, dB);
        } else if (cat && cat.connected) {
          if (rigType === 'rigctld') {
            cat.setRfGain(value / 100);
          } else {
            cat.setRfGain(value);
          }
        }
        _currentRfGain = value;
        broadcastRigState();
        break;
      }
      case 'set-tx-power': {
        if (flexNeedsApi) { _flexWarnOnce('TX Power requires SmartSDR API — not connected'); break; }
        const value = Number(data.value) || 0;
        if (flexSdr()) {
          smartSdr.setTxPower(value);
        } else if (cat && cat.connected) {
          if (rigType === 'rigctld') {
            cat.setTxPower(value / 100);
          } else {
            cat.setTxPower(value);
          }
        }
        _currentTxPower = value;
        broadcastRigState();
        break;
      }
      case 'set-filter-width': {
        if (flexNeedsApi) { sendCatLog('Filter requires SmartSDR API — not connected'); break; }
        const width = Number(data.value) || 0;
        if (width <= 0) break;
        if (flexSdr()) {
          const m = (_currentMode || '').toUpperCase();
          let lo, hi;
          if (m === 'CW') {
            lo = Math.max(0, 600 - Math.round(width / 2));
            hi = 600 + Math.round(width / 2);
          } else {
            lo = 100;
            hi = 100 + width;
          }
          smartSdr.setSliceFilter(0, lo, hi);
        } else if (cat && cat.connected) {
          cat.setFilterWidth(width);
        }
        _currentFilterWidth = width;
        // Update the per-mode setting so rig panel changes persist across tunes
        const cm = (_currentMode || '').toUpperCase();
        if (cm === 'CW') settings.cwFilterWidth = width;
        else if (cm === 'USB' || cm === 'LSB' || cm === 'SSB') settings.ssbFilterWidth = width;
        else if (cm === 'DIGU' || cm === 'DIGL' || cm === 'PKTUSB' || cm === 'PKTLSB' || cm === 'FT8' || cm === 'FT4') settings.digitalFilterWidth = width;
        broadcastRigState();
        break;
      }
      case 'get-state': {
        broadcastRigState();
        break;
      }
      case 'send-custom-cat': {
        const cmd = data.command;
        if (!cmd || typeof cmd !== 'string') break;
        console.log('[Rig] Custom CAT command:', cmd);
        if (flexSdr()) {
          smartSdr._send(cmd);
        } else if (cat && cat.connected) {
          cat.sendRaw(cmd);
        }
        break;
      }
    }
  });

  ipcMain.on('refresh', () => { markUserActive(); refreshSpots(); });

  ipcMain.on('app-relaunch', () => { app.relaunch(); app.exit(0); });
  ipcMain.handle('get-settings', () => ({ ...settings, appVersion: require('./package.json').version }));
  ipcMain.handle('get-rig-models', () => getModelList());
  ipcMain.handle('get-sdr-directory', () => require('./lib/sdr-directory').STATIONS);

  // --- Mobile-app pairing IPC ---
  // The desktop UI calls these from the Settings → ECHOCAT → "Pair
  // Mobile App" section. The QR is generated server-side so the
  // renderer doesn't need to pull a QR lib.
  ipcMain.handle('echocat-create-pairing-qr', async (_e, opts = {}) => {
    if (!remoteServer || !remoteServer.running) {
      return { error: 'ECHOCAT server is not running. Enable it in Settings first.' };
    }
    let qrcode;
    try { qrcode = require('qrcode'); }
    catch (err) {
      return { error: 'qrcode module not installed. Run npm install in the POTACAT repo.' };
    }
    const pairingToken = remoteServer.createPairingToken({ deviceLabel: opts.deviceLabel || '' });
    let fingerprint = '';
    try {
      if (remoteServer._tlsCertPem) {
        const x509 = new (require('crypto').X509Certificate)(remoteServer._tlsCertPem);
        fingerprint = x509.fingerprint256 || '';
      }
    } catch {}
    // Use the LAN IP if we can find one; fall back to localhost. The
    // mobile app uses mDNS to discover, but the QR also embeds an
    // explicit URL as a safety net for users on weird networks.
    const os = require('os');
    let host = '127.0.0.1';
    try {
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs) {
          if (a.family === 'IPv4' && !a.internal) { host = a.address; break; }
        }
        if (host !== '127.0.0.1') break;
      }
    } catch {}
    const port = remoteServer._port || 7300;
    const wsUrl = `wss://${host}:${port}`;
    const hostname = (() => { try { return os.hostname(); } catch { return 'POTACAT'; } })();
    const qrParams = new URLSearchParams({
      host: wsUrl,
      token: pairingToken,
      fp: fingerprint,
      name: hostname,
    });
    const qrText = `potacat://pair?${qrParams.toString()}`;
    const dataUrl = await qrcode.toDataURL(qrText, { errorCorrectionLevel: 'M', width: 320, margin: 2 });
    return {
      qrText,
      dataUrl,
      pairingToken,
      fingerprint,
      host: wsUrl,
      hostname,
      ttlSeconds: 5 * 60,
    };
  });

  ipcMain.handle('echocat-list-paired-devices', () => {
    if (!remoteServer) return [];
    return remoteServer.listPairedDevices();
  });

  ipcMain.handle('echocat-revoke-device', (_e, deviceId) => {
    if (!remoteServer) return { ok: false, error: 'server not running' };
    const ok = remoteServer.revokeDevice(String(deviceId || ''));
    return { ok };
  });

  // Ragchew log pop-out: combined callsign lookup. Returns the QRZ result
  // (live network call) AND the past-QSO history from the in-memory index in
  // a single round-trip so the pop-out only debounces one IPC.
  ipcMain.handle('log-popout-callsign-info', async (_e, call, limit) => {
    const trimmed = String(call || '').trim().toUpperCase();
    if (!trimmed) return { qrz: null, pastQsos: [], totalQsos: 0 };
    let qrzInfo = null;
    try {
      // Reuse the existing QRZ lookup pipeline. Strip /SUFFIX so the lookup
      // hits the base callsign (QRZ doesn't index portable variants).
      if (qrz.configured && settings.enableQrz) {
        qrzInfo = await qrz.lookup(trimmed.split('/')[0]);
      }
    } catch {}
    const all = lookupPastQsos(trimmed);
    const pastQsos = limit ? all.slice(0, limit) : all;
    return { qrz: qrzInfo, pastQsos, totalQsos: all.length };
  });

  // Export/Import settings
  ipcMain.handle('export-settings', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog(win, {
      title: 'Export POTACAT Settings',
      defaultPath: 'potacat-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    // Exclude sensitive data from export
    const exportData = { ...settings };
    delete exportData.qrzPassword;
    delete exportData.remoteToken;
    delete exportData.smartSdrClientId;
    fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2));
    return true;
  });

  ipcMain.handle('import-settings', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(win, {
      title: 'Import POTACAT Settings',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return false;
    try {
      const imported = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
      // Preserve local-only fields
      imported.smartSdrClientId = settings.smartSdrClientId;
      if (!imported.remoteToken) imported.remoteToken = settings.remoteToken;
      if (!imported.qrzPassword) imported.qrzPassword = settings.qrzPassword;
      settings = { ...settings, ...imported };
      saveSettings(settings);
      return true;
    } catch (err) {
      console.error('Settings import failed:', err.message);
      return false;
    }
  });

  // TunerGenius 1x3 IPC
  ipcMain.handle('tgxl-select-antenna', (_e, port) => {
    if (tgxlClient && tgxlClient.connected) {
      tgxlClient.selectAntenna(port);
    }
  });
  ipcMain.handle('tgxl-get-status', () => ({
    connected: !!(tgxlClient && tgxlClient.connected),
    antenna: tgxlClient ? tgxlClient.antenna : 0,
  }));

  // --- Rig Command Table IPC ---
  ipcMain.handle('get-rig-commands', () => {
    const activeRig = (settings.rigs || []).find(r => r.id === settings.activeRigId);
    const modelName = activeRig?.model || 'Unknown';
    // SmartSDR (Flex) path
    if (smartSdr && smartSdr.connected) {
      return {
        commands: smartSdr.getCommandTable(),
        modelName,
        protocol: 'smartsdr',
      };
    }
    // RigController (Kenwood/Yaesu/Icom/rigctld) path
    if (!cat) return { commands: [], modelName: null, protocol: null };
    return {
      commands: cat.getCommandTable(),
      modelName,
      protocol: cat.protocol || 'unknown',
    };
  });

  ipcMain.handle('save-rig-command-override', (_e, { key, value }) => {
    if (!key || typeof key !== 'string') return;
    const activeRig = (settings.rigs || []).find(r => r.id === settings.activeRigId);
    const modelName = activeRig?.model;
    if (!modelName) return;
    // Store overrides per rig model
    if (!settings.rigCommandOverrides) settings.rigCommandOverrides = {};
    if (!settings.rigCommandOverrides[modelName]) settings.rigCommandOverrides[modelName] = {};
    if (value && typeof value === 'string') {
      settings.rigCommandOverrides[modelName][key] = value;
    } else {
      delete settings.rigCommandOverrides[modelName][key];
    }
    saveSettings(settings);
    // Apply override to live codec
    if (cat && cat.connected) {
      cat.applyCommandOverrides(settings.rigCommandOverrides[modelName]);
    }
  });

  ipcMain.handle('reset-all-rig-commands', () => {
    const activeRig = (settings.rigs || []).find(r => r.id === settings.activeRigId);
    const modelName = activeRig?.model;
    if (!modelName) return;
    if (settings.rigCommandOverrides) {
      delete settings.rigCommandOverrides[modelName];
      saveSettings(settings);
    }
    // Reconnect to rebuild codec with clean defaults
    if (cat) connectCat();
  });

  // --- Remote Launcher IPC ---
  // Uses POTACAT.exe --launcher to run the launcher server at login.
  // No external Node.js needed — Electron itself runs the launcher script.
  ipcMain.handle('install-launcher', () => {
    try {
      const os = require('os');
      const isWin = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
      const configDir = app.getPath('userData');
      const configPath = path.join(configDir, 'launcher-config.json');
      const exePath = process.execPath; // POTACAT.exe (or electron in dev)

      // Load or create config
      let config = { port: 7301, https: true };
      if (fs.existsSync(configPath)) {
        try { config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; } catch {}
      }
      delete config.token;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Platform-specific auto-start — all use "POTACAT.exe --launcher"
      if (isWin) {
        const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
        const vbsPath = path.join(startupDir, 'POTACAT-Launcher.vbs');
        fs.writeFileSync(vbsPath, `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${exePath}"" --launcher", 0, False\r\n`);
      } else if (isMac) {
        const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
        fs.mkdirSync(plistDir, { recursive: true });
        const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.potacat.launcher</string><key>ProgramArguments</key><array><string>${exePath}</string><string>--launcher</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`;
        fs.writeFileSync(path.join(plistDir, 'com.potacat.launcher.plist'), plist);
        try { execSync(`launchctl load "${path.join(plistDir, 'com.potacat.launcher.plist')}"`, { stdio: 'pipe' }); } catch {}
      } else {
        const autostartDir = path.join(os.homedir(), '.config', 'autostart');
        fs.mkdirSync(autostartDir, { recursive: true });
        fs.writeFileSync(path.join(autostartDir, 'potacat-launcher.desktop'), `[Desktop Entry]\nType=Application\nName=POTACAT Launcher\nExec=${exePath} --launcher\nHidden=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('uninstall-launcher', () => {
    try {
      const os = require('os');
      const isWin = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
      if (isWin) {
        const vbsPath = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'POTACAT-Launcher.vbs');
        if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
      } else if (isMac) {
        const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.potacat.launcher.plist');
        if (fs.existsSync(plistPath)) {
          try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' }); } catch {}
          fs.unlinkSync(plistPath);
        }
      } else {
        const desktopPath = path.join(os.homedir(), '.config', 'autostart', 'potacat-launcher.desktop');
        if (fs.existsSync(desktopPath)) fs.unlinkSync(desktopPath);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- ECHOCAT IPC ---
  ipcMain.handle('get-local-ips', () => RemoteServer.getLocalIPs());

  ipcMain.on('remote-audio-send-signal', (_e, data) => {
    if (remoteServer) {
      remoteServer.relaySignalToClient(data);
    }
  });

  ipcMain.on('remote-audio-status', (_e, status) => {
    console.log('[Echo CAT Audio]', JSON.stringify(status));
    // Hide audio window once getUserMedia has captured (was shown briefly for Chromium 134+)
    if (status.status === 'started' && remoteAudioWin && !remoteAudioWin.isDestroyed()) {
      remoteAudioWin.hide();
    }
    // Forward audio connection state to phone
    if (status.connectionState && remoteServer) {
      remoteServer.broadcastRadioStatus({ audioState: status.connectionState });
    }
    if (status.error) {
      console.error('[Echo CAT Audio] Error:', status.error);
    }
  });

  // PC-side TX peak from the ECHOCAT remote-audio bridge — forward to the VFO
  // popout so its TX meter shows whether phone audio is actually reaching the
  // radio's USB CODEC. Also pushed to the phone so users on small screens who
  // can't see the desktop VFO can monitor their own TX level from the phone
  // Settings panel.
  ipcMain.on('remote-audio-tx-meter', (_e, peak) => {
    if (vfoPopoutWin && !vfoPopoutWin.isDestroyed()) {
      vfoPopoutWin.webContents.send('vfo-popout-tx-meter', peak);
    }
    if (remoteServer && remoteServer.running) {
      remoteServer.sendToClient({ type: 'tx-meter', value: peak });
    }
  });

  // --- Directory IPC ---
  ipcMain.on('fetch-directory', () => { fetchDirectory(); });
  ipcMain.handle('get-directory', () => ({ nets: directoryNets, swl: directorySwl }));

  // --- Events IPC ---
  ipcMain.handle('get-active-events', () => {
    const eventStates = settings.events || {};
    return activeEvents.map(ev => ({
      ...ev,
      optedIn: !!(eventStates[ev.id] && eventStates[ev.id].optedIn),
      dismissed: !!(eventStates[ev.id] && eventStates[ev.id].dismissed),
      progress: (eventStates[ev.id] && eventStates[ev.id].progress) || {},
    }));
  });

  ipcMain.handle('set-event-optin', (_e, { eventId, optedIn, dismissed }) => {
    setEventOptIn(eventId, optedIn, dismissed);
    // Scan existing log for matching QSOs when user opts in
    if (optedIn) scanLogForEvents();
    return true;
  });

  ipcMain.handle('get-event-progress', (_e, eventId) => {
    return getEventProgress(eventId);
  });

  ipcMain.handle('mark-event-region', (_e, { eventId, region, qsoData }) => {
    markEventRegion(eventId, region, qsoData);
    return true;
  });

  ipcMain.handle('reset-event-progress', (_e, eventId) => {
    if (settings.events && settings.events[eventId]) {
      settings.events[eventId].progress = {};
      saveSettings(settings);
      pushEventsToRenderer();
    }
    return true;
  });

  ipcMain.handle('export-event-adif', async (_e, { eventId }) => {
    const state = settings.events && settings.events[eventId];
    if (!state || !state.progress) return { success: false, error: 'No progress data' };
    const event = activeEvents.find(ev => ev.id === eventId);
    if (!event) return { success: false, error: 'Event not found' };

    // Build ADIF records from progress entries
    const records = [];
    for (const [region, qso] of Object.entries(state.progress)) {
      const entry = (event.schedule || []).find(s => s.region === region);
      records.push({
        CALL: qso.call,
        QSO_DATE: (qso.date || '').replace(/-/g, ''),
        TIME_ON: qso.time || '0000',
        BAND: qso.band,
        MODE: qso.mode,
        FREQ: qso.freq ? (parseFloat(qso.freq) / 1000).toFixed(6) : '',
        RST_SENT: qso.rstSent || '59',
        RST_RCVD: qso.rstRcvd || '59',
        STATE: region,
        COMMENT: `${event.name} - ${entry ? entry.regionName : region}`,
        STATION_CALLSIGN: settings.myCallsign || '',
        OPERATOR: settings.myCallsign || '',
      });
    }

    const parentWin = win;
    const startDir = (settings.lastAdifExportDir && fs.existsSync(settings.lastAdifExportDir))
      ? settings.lastAdifExportDir
      : app.getPath('documents');
    const result = await dialog.showSaveDialog(parentWin, {
      title: `Export ${event.name} ADIF for LOTW`,
      defaultPath: path.join(startDir, `potacat_${eventId}.adi`),
      filters: [
        { name: 'ADIF Files', extensions: ['adi', 'adif'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return null;

    let content = ADIF_HEADER;
    for (const rec of records) {
      const parts = [];
      for (const [key, value] of Object.entries(rec)) {
        if (value != null && value !== '') parts.push(adifField(key, value));
      }
      content += '\n' + parts.join(' ') + ' <EOR>\n';
    }
    fs.writeFileSync(result.filePath, content, 'utf-8');
    // Remember folder for the next export
    const dir = path.dirname(result.filePath);
    if (dir && dir !== settings.lastAdifExportDir) {
      settings.lastAdifExportDir = dir;
      saveSettings(settings);
    }
    return { success: true, filePath: result.filePath, count: records.length };
  });

  ipcMain.handle('list-ports', async () => {
    return listSerialPorts();
  });

  ipcMain.handle('list-rigs', async () => {
    try {
      const rigctldPath = findRigctld();
      console.log(`[hamlib] Using rigctld at: ${rigctldPath}`);
      return await listRigs(rigctldPath);
    } catch (err) {
      console.error(`[hamlib] Failed to list rigs: ${err.message}`);
      sendCatLog(`[hamlib] rigctld not found or failed: ${err.message}. On Linux: sudo apt install libhamlib-utils`);
      return [];
    }
  });

  ipcMain.handle('save-settings', (_e, newSettings) => {
    markUserActive();
    const adifLogPathChanged = newSettings.adifLogPath !== settings.adifLogPath;
    const potaParksPathChanged = newSettings.potaParksPath !== settings.potaParksPath;

    // Only detect changes for keys that are actually present in the incoming save
    const has = (k) => k in newSettings;

    const clusterChanged = (has('enableCluster') && newSettings.enableCluster !== settings.enableCluster) ||
      (has('myCallsign') && newSettings.myCallsign !== settings.myCallsign) ||
      (has('clusterNodes') && JSON.stringify(newSettings.clusterNodes) !== JSON.stringify(settings.clusterNodes));

    const rbnChanged = (has('enableRbn') && newSettings.enableRbn !== settings.enableRbn) ||
      (has('myCallsign') && newSettings.myCallsign !== settings.myCallsign) ||
      (has('watchlist') && newSettings.watchlist !== settings.watchlist);

    const smartSdrChanged = (has('smartSdrSpots') && newSettings.smartSdrSpots !== settings.smartSdrSpots) ||
      (has('smartSdrHost') && newSettings.smartSdrHost !== settings.smartSdrHost);

    const tciChanged = (has('tciSpots') && newSettings.tciSpots !== settings.tciSpots) ||
      (has('tciHost') && newSettings.tciHost !== settings.tciHost) ||
      (has('tciPort') && newSettings.tciPort !== settings.tciPort);

    const agChanged = (has('enableAntennaGenius') && newSettings.enableAntennaGenius !== settings.enableAntennaGenius) ||
      (has('agHost') && newSettings.agHost !== settings.agHost);

    const wsjtxChanged = (has('enableWsjtx') && newSettings.enableWsjtx !== settings.enableWsjtx) ||
      (has('wsjtxPort') && newSettings.wsjtxPort !== settings.wsjtxPort);

    const pskrChanged = has('enablePskr') && newSettings.enablePskr !== settings.enablePskr;

    const pskrMapChanged = (has('enablePskrMap') && newSettings.enablePskrMap !== settings.enablePskrMap) ||
      (has('myCallsign') && newSettings.myCallsign !== settings.myCallsign);

    const remoteChanged = (has('enableRemote') && newSettings.enableRemote !== settings.enableRemote) ||
      (has('remotePort') && newSettings.remotePort !== settings.remotePort) ||
      (has('remoteToken') && newSettings.remoteToken !== settings.remoteToken) ||
      (has('remoteRequireToken') && newSettings.remoteRequireToken !== settings.remoteRequireToken) ||
      (has('clubMode') && newSettings.clubMode !== settings.clubMode) ||
      (has('clubCsvPath') && newSettings.clubCsvPath !== settings.clubCsvPath) ||
      (has('remoteCwEnabled') && newSettings.remoteCwEnabled !== settings.remoteCwEnabled) ||
      (has('cwKeyPort') && newSettings.cwKeyPort !== settings.cwKeyPort);

    const iconChanged = has('lightIcon') && newSettings.lightIcon !== settings.lightIcon;

    const cwKeyerChanged = (has('enableCwKeyer') && newSettings.enableCwKeyer !== settings.enableCwKeyer) ||
      (has('cwKeyerType') && newSettings.cwKeyerType !== settings.cwKeyerType) ||
      (has('cwKeyerMode') && newSettings.cwKeyerMode !== settings.cwKeyerMode) ||
      (has('cwWpm') && newSettings.cwWpm !== settings.cwWpm) ||
      (has('cwSwapPaddles') && newSettings.cwSwapPaddles !== settings.cwSwapPaddles) ||
      (has('winKeyerPort') && newSettings.winKeyerPort !== settings.winKeyerPort) ||
      (has('wkPttLeadIn') && newSettings.wkPttLeadIn !== settings.wkPttLeadIn) ||
      (has('wkPttTail') && newSettings.wkPttTail !== settings.wkPttTail);

    const activatorStateChanged = (has('appMode') && newSettings.appMode !== settings.appMode) ||
      (has('activatorParkRefs') && JSON.stringify(newSettings.activatorParkRefs) !== JSON.stringify(settings.activatorParkRefs));

    const isPartialSave = !has('enablePota'); // hotkey saves only send 1-2 keys

    settings = { ...settings, ...newSettings };
    saveSettings(settings);
    // Reconnect CW key port if it changed (works for both partial and full saves)
    if (has('cwKeyPort')) connectCwKeyPort();

    // Only reconnect CAT / refresh spots for full settings saves
    if (!isPartialSave) {
      if (!settings.enableWsjtx) connectCat();
      refreshSpots();
      // Restart spot timer with new interval
      if (spotTimer) clearInterval(spotTimer);
      const newRefreshMs = Math.max(15, settings.refreshInterval || 30) * 1000;
      spotTimer = setInterval(refreshSpots, newRefreshMs);
    }

    // Panadapter source-set changes (Settings → Panadapter & Bandscope) may
    // alter fetch decisions: enabling a source for the panadapter while it's
    // still off in the table needs to spin up its connection, and turning
    // it off may let us tear it down. Re-evaluate streaming sources by
    // calling connect* — those functions now consult both table and
    // panadapter sides via panadapterWantsSource(). Polled sources
    // (POTA/SOTA/WWFF/LLOTA) pick up the new gate on the next refreshSpots.
    const panadapterChanged = has('panadapterSyncTable') || has('panadapterPota') ||
      has('panadapterSota') || has('panadapterWwff') || has('panadapterLlota') ||
      has('panadapterCluster') || has('panadapterRbn') || has('panadapterCwSpots') ||
      has('panadapterPskr') || has('panadapterWsjtx');
    if (panadapterChanged) {
      // connectX() and disconnectX() are idempotent — they tear down before
      // (re)gating, so calling them when the gate is now false is the safe
      // way to disconnect a source that was previously enabled only via the
      // panadapter side.
      connectCluster();
      connectRbn();
      connectCwSpots();
      connectPskr();
      // Trigger a fresh push so the new allowlist takes effect immediately
      // (without waiting for the next refresh tick).
      if (typeof sendMergedSpots === 'function') {
        try { sendMergedSpots(); } catch { /* ignore */ }
      }
    }

    // Reconnect cluster if settings changed
    if (clusterChanged) {
      if (settings.enableCluster) {
        connectCluster();
      } else {
        disconnectCluster();
      }
    }

    // Reconnect CW Spots if settings changed
    const cwSpotsChanged = has('enableCwSpots') || has('cwSpotsHost') || has('cwSpotsPort') || has('cwSpotsClubs') || has('cwSpotsMaxWpm') ||
      (has('myCallsign') && settings.enableCwSpots);
    if (cwSpotsChanged) {
      if (settings.enableCwSpots) connectCwSpots(); else disconnectCwSpots();
    }

    // Reconnect RBN if settings changed
    if (rbnChanged) {
      if (settings.enableRbn) {
        connectRbn();
      } else {
        disconnectRbn();
      }
    }

    // Reconnect SmartSDR if settings changed (also needed for WSJT-X+Flex and CW keyer)
    if (smartSdrChanged || wsjtxChanged || cwKeyerChanged || remoteChanged) {
      connectSmartSdr(); // needsSmartSdr() decides whether to actually connect
    }

    // Reconnect TCI if settings changed
    if (tciChanged) {
      connectTci();
    }

    // Reconnect Antenna Genius if settings changed
    if (agChanged) {
      connectAntennaGenius();
    }

    // Reconnect TunerGenius if settings changed
    const tgxlChanged = has('enableTgxl') || has('tgxlHost');
    if (tgxlChanged) {
      connectTunerGenius();
    }

    // Reconnect ECHOCAT if settings changed
    if (remoteChanged) {
      if (settings.enableRemote) {
        connectRemote();
      } else {
        disconnectRemote();
      }
    }

    // Push activator state to phone when park refs or app mode change
    if (activatorStateChanged) {
      pushActivatorStateToPhone();
    }

    // VFO Profiles changed (typically from the desktop popout's Save / Delete
    // buttons) — push to ECHOCAT phone so its widget reflects the new list.
    // Phone-initiated changes go through `vfo-profiles-update` event handler
    // and don't hit this path, so no echo loop.
    if (has('vfoProfiles') && remoteServer && remoteServer.running) {
      remoteServer.sendVfoProfiles(settings.vfoProfiles || []);
    }

    // Reconnect CW keyer if settings changed
    if (cwKeyerChanged) {
      if (settings.enableCwKeyer) {
        connectKeyer();
      } else {
        disconnectKeyer();
      }
    }

    // Reconnect WSJT-X if settings changed
    if (wsjtxChanged) {
      if (settings.enableWsjtx) {
        connectWsjtx();
      } else {
        disconnectWsjtx();
      }
    } else if (wsjtx && wsjtx.connected) {
      // Highlight setting may have changed
      if (settings.wsjtxHighlight) {
        updateWsjtxHighlights();
      } else {
        wsjtx.clearHighlights();
      }
    }

    // Reconnect FreeDV Reporter if FreeDV setting changed
    if (has('enableFreedv')) {
      if (settings.enableFreedv) connectFreedvReporter();
      else disconnectFreedvReporter();
    }

    // Reconnect PSKReporter if settings changed (or auto-enable for FreeDV)
    const freedvNeedsPskr = settings.enableFreedv && !settings.enablePskr;
    if (pskrChanged || (has('enableFreedv') && freedvNeedsPskr)) {
      if (settings.enablePskr || settings.enableFreedv) {
        connectPskr();
      } else {
        disconnectPskr();
      }
    }

    // Reconnect PSKReporter Map if settings changed
    if (pskrMapChanged) {
      if (settings.enablePskrMap) {
        connectPskrMap();
      } else {
        disconnectPskrMap();
      }
    }

    // Push updated settings to ECHOCAT phone
    if (has('rotorActive') || has('enableRotor') || has('customCatButtons')) {
      updateRemoteSettings();
    }

    // Start/stop WSJT-X-binary bridge. HamRS, Logger32, MacLoggerDX and
    // Log4OM-binary all share this path — they recognize POTACAT as a
    // WSJT-X peer via periodic status heartbeats.
    const wsjtxBinaryLoggers = new Set(['hamrs', 'logger32', 'macloggerdx']);
    const log4omBinary = settings.logbookType === 'log4om' && settings.log4omWsjtxBinary;
    if (settings.sendToLogbook && (wsjtxBinaryLoggers.has(settings.logbookType) || log4omBinary)) {
      const hp = parseInt(settings.logbookPort, 10) || 2237;
      const hh = settings.logbookHost || '127.0.0.1';
      if (!hamrsBridge.socket || hamrsBridge.host !== hh || hamrsBridge.port !== hp) {
        hamrsBridge.start(hh, hp);
      }
    } else {
      hamrsBridge.stop();
    }

    // Start/stop Extra UDP bridge — heartbeats register POTACAT with GridTracker
    if (settings.extraUdpEnabled && (settings.extraUdpFormat || 'wsjtx') === 'wsjtx') {
      const ep = parseInt(settings.extraUdpPort, 10) || 2237;
      const eh = settings.extraUdpHost || '127.0.0.1';
      if (!extraUdpBridge.socket || extraUdpBridge.host !== eh || extraUdpBridge.port !== ep) {
        extraUdpBridge.start(eh, ep);
      }
    } else {
      extraUdpBridge.stop();
    }

    // Auto-parse ADIF and send DXCC data if enabled
    if (settings.enableDxcc) {
      sendDxccData();
    }

    // Reload worked callsigns if log path changed
    if (adifLogPathChanged) {
      loadWorkedQsos();
    }

    // Reload worked parks if CSV path changed
    if (potaParksPathChanged) {
      loadWorkedParks();
    }

    // Swap app icon on all windows if setting changed
    if (iconChanged) applyIconToAllWindows();

    // Reconfigure QRZ client if credentials changed
    if (newSettings.enableQrz) {
      qrz.configure(newSettings.qrzUsername || '', newSettings.qrzPassword || '');
    }

    // Reconfigure SOTA uploader if credentials changed
    if (newSettings.sotaUpload && newSettings.sotaUsername) {
      sotaUploader.configure(newSettings.sotaUsername, newSettings.sotaPassword || '');
    }

    // Restart auto-SSTV timer if settings changed
    if (has('enableAutoSstv') || has('autoSstvInactivityMin')) {
      startAutoSstvTimer();
    }

    // Restart idle-pause timer if settings changed
    if (has('enableIdlePause') || has('idlePauseMin')) {
      startIdlePauseTimer();
    }

    return settings;
  });



  ipcMain.handle('choose-pota-parks-file', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select POTA Parks Worked CSV',
      filters: [
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('parse-adif', async () => {
    return await buildDxccData();
  });

  // --- Log Import IPC ---
  ipcMain.handle('import-adif', async (event) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender) || win;
    const result = await dialog.showOpenDialog(parentWin, {
      title: 'Import Log File(s)',
      filters: [
        { name: 'Log Files', extensions: ['adi', 'adif', 'sqlite', 'db'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    let totalImported = 0;
    const uniqueCalls = new Set();
    const fileNames = [];

    for (const filePath of result.filePaths) {
      try {
        if (isSqliteFile(filePath)) {
          const qsos = await parseSqliteFile(filePath);
          for (const qso of qsos) {
            appendImportedQso(logPath, qso);
            uniqueCalls.add(qso.call.toUpperCase());
            totalImported++;
          }
        } else {
          const qsos = parseAllRawQsos(filePath);
          for (const qso of qsos) {
            appendRawQso(logPath, qso);
            uniqueCalls.add((qso.CALL || '').toUpperCase());
            totalImported++;
          }
        }
        fileNames.push(path.basename(filePath));
      } catch (err) {
        dialog.showMessageBox(parentWin, {
          type: 'error',
          title: 'Import Failed',
          message: `Failed to parse ${path.basename(filePath)}`,
          detail: err.message,
        });
        return { success: false, error: `Failed to parse ${path.basename(filePath)}: ${err.message}` };
      }
    }

    // Reload worked callsigns from updated log and push to renderer
    loadWorkedQsos();
    // Re-harvest parks from the now-larger log so imported QSOs' park
    // refs flow into workedParks for new-park / hide-worked-parks
    // detection — without this, freshly imported logs wouldn't influence
    // the spots view until next app start. Snapshot the worked-parks
    // count before/after so the import-result dialog can lead with the
    // bridge between "import" and "filter" — KE4WLE saw v1.5.9's
    // worked-parks-from-log change land but couldn't tell from the UI
    // that running Import Log here was the action that wires it up.
    const parksBefore = workedParks ? workedParks.size : 0;
    loadWorkedParks();
    const parksAfter = workedParks ? workedParks.size : 0;
    const parksAdded = Math.max(0, parksAfter - parksBefore);
    // Scan imported QSOs for event matches
    scanLogForEvents();

    // Notify pop-out logbook to refresh (if open and not the caller)
    if (qsoPopoutWin && !qsoPopoutWin.isDestroyed() &&
        BrowserWindow.fromWebContents(event.sender) !== qsoPopoutWin) {
      qsoPopoutWin.webContents.send('qso-popout-refresh');
    }

    const fileList = fileNames.join(', ');
    const detailLines = [
      `${totalImported.toLocaleString()} QSOs (${uniqueCalls.size.toLocaleString()} unique callsigns) added.`,
    ];
    if (parksAdded > 0) {
      detailLines.push('');
      detailLines.push(`Worked-parks list now has ${parksAfter.toLocaleString()} references (${parksAdded.toLocaleString()} new from this import).`);
      detailLines.push('Use “Hide worked parks” in Settings → Spots or Quick Settings to filter the spots table by them.');
    } else if (parksAfter > 0) {
      detailLines.push('');
      detailLines.push(`Worked-parks list has ${parksAfter.toLocaleString()} references (no new park refs in this import).`);
    }
    dialog.showMessageBox(parentWin, {
      type: 'info',
      title: 'Import Complete',
      message: `Successfully imported ${fileList}`,
      detail: detailLines.join('\n'),
    });

    return {
      success: true,
      imported: totalImported,
      unique: uniqueCalls.size,
      parksTotal: parksAfter,
      parksAdded,
    };
  });

  // --- QSO Logging IPC ---
  ipcMain.handle('get-default-log-path', () => {
    return path.join(app.getPath('userData'), 'potacat_qso_log.adi');
  });

  // --- Club Station Mode IPC ---
  ipcMain.handle('choose-club-csv-file', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose Club Users CSV',
      filters: [
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('preview-club-csv', async (_e, csvPath) => {
    if (!csvPath) return { members: [], radioColumns: [], errors: ['No file path'] };
    return loadClubUsers(csvPath);
  });

  ipcMain.handle('hash-club-passwords', async (_e, csvPath) => {
    if (!csvPath) return { hashed: 0, alreadyHashed: 0, error: 'No file path' };
    return hashPasswords(csvPath);
  });

  ipcMain.handle('create-club-csv', async (_e, rigNames) => {
    // Default to same directory as the logbook file
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    const logDir = path.dirname(logPath);
    const defaultPath = path.join(logDir, 'club_users.csv');
    const result = await dialog.showSaveDialog(win, {
      title: 'Create Club Users CSV',
      defaultPath,
      filters: [
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return null;
    // Build header with fixed columns + rig names + schedule
    const fixed = ['firstname', 'lastname', 'callsign', 'passwd', 'license', 'admin', 'user'];
    const header = fixed.concat(rigNames || []).concat(['schedule']).join(',');
    // Write header + one example row
    const rigXs = (rigNames || []).map(() => 'x').join(',');
    const exampleSched = rigNames && rigNames.length > 0
      ? '"Mon 19:00-21:00 ' + rigNames[0] + '"'
      : '""';
    const example = 'Jane,Doe,W1AW,changeme,Extra,x,,' + rigXs + ',' + exampleSched;
    fs.writeFileSync(result.filePath, header + '\n' + example + '\n');
    return result.filePath;
  });

  ipcMain.handle('choose-log-file', async (_e, currentPath) => {
    const defaultPath = currentPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    const result = await dialog.showSaveDialog(win, {
      title: 'Choose QSO Log File',
      defaultPath,
      filters: [
        { name: 'ADIF Files', extensions: ['adi', 'adif'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return null;
    return result.filePath;
  });

  // --- Sticky ADIF export directory --------------------------------------
  // Remembers the folder the user picked last time they exported an ADIF so
  // the next Save dialog defaults there instead of forcing them back to
  // Documents. Falls back to Documents if we haven't seen a save yet or the
  // saved path no longer exists. (SP5GB request, 2026-04-17.)
  function adifExportDefaultDir() {
    const saved = settings.lastAdifExportDir;
    if (saved) {
      try { if (fs.existsSync(saved) && fs.statSync(saved).isDirectory()) return saved; } catch {}
    }
    return app.getPath('documents');
  }
  function rememberAdifExportDir(filePath) {
    if (!filePath) return;
    const dir = path.dirname(filePath);
    if (dir && dir !== settings.lastAdifExportDir) {
      settings.lastAdifExportDir = dir;
      saveSettings(settings);
    }
  }

  ipcMain.handle('export-adif', async (event, qsos) => {
    try {
      const parentWin = BrowserWindow.fromWebContents(event.sender) || win;
      const result = await dialog.showSaveDialog(parentWin, {
        title: 'Export ADIF',
        defaultPath: path.join(adifExportDefaultDir(), 'potacat_export.adi'),
        filters: [
          { name: 'ADIF Files', extensions: ['adi', 'adif'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled) return null;
      let content = ADIF_HEADER;
      for (const q of qsos) {
        const parts = [];
        for (const [key, value] of Object.entries(q)) {
          if (key === 'idx') continue;
          if (value != null && value !== '') parts.push(adifField(key, value));
        }
        content += '\n' + parts.join(' ') + ' <EOR>\n';
      }
      fs.writeFileSync(result.filePath, content, 'utf-8');
      rememberAdifExportDir(result.filePath);
      return { success: true, filePath: result.filePath, count: qsos.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('resend-qsos-to-logbook', async (_e, rawQsos) => {
    if (!settings.logbookType) return { success: false, error: 'No logbook configured' };
    let sent = 0;
    for (const raw of rawQsos) {
      try {
        const qsoData = rawQsoToQsoData(raw);
        await forwardToLogbook(qsoData);
        sent++;
        // Small delay between sends to avoid flooding
        if (rawQsos.length > 1) await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        console.error('Resend QSO failed:', err.message);
      }
    }
    return { success: true, sent, total: rawQsos.length };
  });

  ipcMain.handle('test-serial-cat', async (_e, config) => {
    const { portPath, baudRate, dtrOff } = config;
    const { SerialPort } = require('serialport');

    // Temporarily disconnect live CAT + kill rigctld to release the serial port
    if (cat) cat.disconnect();
    killRigctld();

    // Wait for OS to fully release the serial port
    await new Promise((r) => setTimeout(r, 500));

    return new Promise((resolve) => {
      let settled = false;
      let buf = '';
      const port = new SerialPort({
        path: portPath,
        baudRate: baudRate || 9600,
        dataBits: 8, stopBits: 1, parity: 'none',
        autoOpen: false,
        rtscts: false, hupcl: false,
      });

      let allData = ''; // capture everything for diagnostics

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { port.close(); } catch { /* ignore */ }
          const hint = allData ? `Got data but no FA response: ${allData.slice(0, 120)}` : 'No response from radio. Check baud rate and cable.';
          resolve({ success: false, error: hint });
        }
      }, 5000);

      port.on('open', () => {
        if (dtrOff) {
          try { port.set({ dtr: false, rts: false }); } catch { /* ignore */ }
        }
        // Send frequency query immediately, and again after 1s in case startup data interfered
        setTimeout(() => port.write('FA;'), 100);
        setTimeout(() => { if (!settled) port.write('FA;'); }, 1200);
      });

      port.on('data', (chunk) => {
        const text = chunk.toString();
        allData += text;
        buf += text;
        console.log('[serial-cat-test] rx:', JSON.stringify(text));
        // Scan for any FA response in the stream (skip startup banners etc.)
        let semi;
        while ((semi = buf.indexOf(';')) !== -1) {
          const msg = buf.slice(0, semi);
          buf = buf.slice(semi + 1);
          if (msg.startsWith('FA') && !settled) {
            settled = true;
            clearTimeout(timeout);
            try { port.close(); } catch { /* ignore */ }
            const hz = parseInt(msg.slice(2), 10);
            const freqMHz = (hz / 1e6).toFixed(6);
            resolve({ success: true, frequency: freqMHz });
            return;
          }
        }
      });

      port.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ success: false, error: err.message });
        }
      });

      port.open((err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ success: false, error: err.message });
        }
      });
    });
  });

  ipcMain.handle('test-icom-civ', async (_e, config) => {
    const { portPath, baudRate, civAddress } = config;
    const { SerialPort } = require('serialport');

    // Temporarily disconnect live CAT to release the serial port
    if (cat) cat.disconnect();

    await new Promise((r) => setTimeout(r, 500));

    return new Promise((resolve) => {
      let settled = false;
      const radioAddr = civAddress || 0x94;
      const ctrlAddr = 0xE0;
      let buf = Buffer.alloc(0);

      const port = new SerialPort({
        path: portPath,
        baudRate: baudRate || 115200,
        dataBits: 8, stopBits: 1, parity: 'none',
        autoOpen: false, rtscts: false, hupcl: false,
      });

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { port.close(); } catch {}
          resolve({ success: false, error: 'No CI-V response. Check baud rate, COM port, and CI-V address.' });
        }
      }, 5000);

      port.on('open', () => {
        try { port.set({ dtr: false, rts: false }); } catch {}
        // Send CI-V frequency read command (0x03)
        const cmd = Buffer.from([0xFE, 0xFE, radioAddr, ctrlAddr, 0x03, 0xFD]);
        setTimeout(() => port.write(cmd), 100);
        setTimeout(() => { if (!settled) port.write(cmd); }, 1500);
      });

      port.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        // Scan for complete CI-V frames
        while (buf.length >= 6) {
          let preamble = -1;
          for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i] === 0xFE && buf[i + 1] === 0xFE) { preamble = i; break; }
          }
          if (preamble === -1) { buf = Buffer.alloc(0); return; }
          if (preamble > 0) buf = buf.slice(preamble);
          const fdIdx = buf.indexOf(0xFD, 4);
          if (fdIdx === -1) return;
          const body = buf.slice(2, fdIdx);
          buf = buf.slice(fdIdx + 1);
          if (body.length < 3) continue;
          const toAddr = body[0];
          const cmd = body[2];
          const payload = body.slice(3);
          // Only process frames addressed to us
          if (toAddr !== ctrlAddr) continue;
          // Frequency response (cmd 0x03)
          if (cmd === 0x03 && payload.length >= 5 && !settled) {
            let hz = 0, mult = 1;
            for (let i = 0; i < 5; i++) {
              hz += ((payload[i] >> 4) * 10 + (payload[i] & 0x0F)) * mult;
              mult *= 100;
            }
            settled = true;
            clearTimeout(timeout);
            try { port.close(); } catch {}
            resolve({ success: true, frequency: (hz / 1e6).toFixed(6) });
            return;
          }
          // NAK — wrong address or unsupported command
          if (cmd === 0xFA && !settled) {
            settled = true;
            clearTimeout(timeout);
            try { port.close(); } catch {}
            resolve({ success: false, error: 'Radio rejected command (NAK). Check CI-V address matches your radio model.' });
            return;
          }
        }
      });

      port.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timeout); resolve({ success: false, error: err.message }); }
      });

      port.open((err) => {
        if (err && !settled) { settled = true; clearTimeout(timeout); resolve({ success: false, error: err.message }); }
      });
    });
  });

  ipcMain.handle('test-hamlib', async (_e, config) => {
    const { rigId, serialPort, baudRate, dtrOff } = config;
    let testProc = null;
    const net = require('net');
    // Kill live rigctld first — two rigctld instances can't share a serial port
    const hadLiveRigctld = !!rigctldProc;
    killRigctld();
    // Brief delay for OS to release the serial port
    if (hadLiveRigctld) await new Promise((r) => setTimeout(r, 300));

    try {
      testProc = await spawnRigctld({ rigId, serialPort, baudRate, dtrOff, verbose: true }, '4533');

      // Give rigctld time to initialize and open the serial port
      await new Promise((r) => setTimeout(r, 1000));

      // Check if rigctld already exited (bad config, serial port issue, etc.)
      if (testProc.exitCode !== null) {
        const lastLine = rigctldStderr.trim().split('\n').pop() || `rigctld exited with code ${testProc.exitCode}`;
        return { success: false, error: lastLine };
      }

      const freq = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          sock.destroy();
          const lines = rigctldStderr.trim().split('\n').filter(Boolean);
          const hint = lines.slice(-3).join(' | ');
          reject(new Error(hint ? `Timed out — rigctld: ${hint}` : 'Timed out waiting for rigctld response'));
        }, 5000);

        const sock = net.createConnection({ host: '127.0.0.1', port: 4533 }, () => {
          sock.write('f\n');
        });

        let data = '';
        sock.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\n')) {
            clearTimeout(timeout);
            sock.destroy();
            const line = data.trim().split('\n')[0];
            // rigctld returns frequency in Hz as a number, or RPRT -N on error
            if (line.startsWith('RPRT')) {
              const { rprtMessage } = require('./lib/codecs/rigctld-codec');
              const meaning = rprtMessage(line);
              reject(new Error(meaning ? `${meaning} (${line})` : `rigctld error: ${line}`));
            } else {
              resolve(line);
            }
          }
        });

        sock.on('error', (err) => {
          clearTimeout(timeout);
          // Surface rigctld's stderr if available — it has the real error
          const lastLine = rigctldStderr.trim().split('\n').pop();
          reject(new Error(lastLine || `Connection failed: ${err.message}`));
        });
      });

      return { success: true, frequency: freq };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      if (testProc) {
        try { testProc.kill(); } catch { /* ignore */ }
      }
      // Restart live rigctld if one was running before the test
      if (hadLiveRigctld && settings.catTarget && settings.catTarget.type === 'rigctld') {
        connectCat();
      }
    }
  });

  ipcMain.handle('save-qso', async (_e, qsoData) => {
    markUserActive();
    try {
      return await saveQsoRecord(qsoData);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Quick re-spot (no QSO logging)
  ipcMain.handle('quick-respot', async (_e, data) => {
    markUserActive();
    try {
      const errors = [];
      if (data.potaRespot && data.potaReference && settings.myCallsign) {
        try {
          await postPotaRespot({
            activator: data.callsign,
            spotter: settings.myCallsign.toUpperCase(),
            frequency: data.frequency,
            reference: data.potaReference,
            mode: data.mode,
            comments: data.comment || '',
          });
          trackRespot('pota');
        } catch (err) { errors.push('POTA: ' + err.message); }
      }
      if (data.wwffRespot && data.wwffReference && settings.myCallsign) {
        if (!/^[A-Z0-9]{1,4}FF-\d{4}$/i.test(data.wwffReference)) {
          errors.push('WWFF: reference does not match WWFF format: ' + data.wwffReference);
        } else {
          try {
            await postWwffRespot({
              activator: data.callsign,
              spotter: settings.myCallsign.toUpperCase(),
              frequency: data.frequency,
              reference: data.wwffReference,
              mode: data.mode,
              comments: data.comment || '',
            });
            trackRespot('wwff');
          } catch (err) { errors.push('WWFF: ' + err.message); }
        }
      }
      if (data.llotaRespot && data.llotaReference) {
        try {
          await postLlotaRespot({
            activator: data.callsign,
            frequency: data.frequency,
            reference: data.llotaReference,
            mode: data.mode,
            comments: data.comment || '',
          });
          trackRespot('llota');
        } catch (err) { errors.push('LLOTA: ' + err.message); }
      }
      if (data.dxcRespot) {
        let sent = 0;
        for (const [, entry] of clusterClients) {
          if (entry.client.sendSpot({ frequency: data.frequency, callsign: data.callsign, comment: data.comment || '' })) {
            sent++;
          }
        }
        if (sent === 0) errors.push('DX Cluster: no connected nodes');
      }
      if (errors.length > 0) return { error: errors.join('; ') };
      return { success: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('send-cluster-command', async (_e, text, nodeId) => {
    let sent = 0;
    if (nodeId) {
      const entry = clusterClients.get(nodeId);
      if (entry && entry.client.sendCommand(text)) sent++;
      if (sent === 0) return { error: 'Selected node is not connected' };
    } else {
      for (const [, entry] of clusterClients) {
        if (entry.client.sendCommand(text)) sent++;
      }
      if (sent === 0) return { error: 'No connected DX Cluster nodes' };
    }
    return { success: true, sent };
  });

  ipcMain.on('connect-cat', (_e, target) => {
    settings.catTarget = target;
    saveSettings(settings);
    if (!settings.enableWsjtx) connectCat();
  });

  // --- WSJT-X IPC ---
  ipcMain.on('wsjtx-reply', (_e, decode) => {
    markUserActive();
    if (wsjtx && wsjtx.connected) {
      wsjtx.reply(decode, 0);
    }
  });

  ipcMain.on('wsjtx-halt-tx', () => {
    if (wsjtx && wsjtx.connected) {
      wsjtx.haltTx(true);
    }
  });

  // --- JTCAT IPC ---
  ipcMain.on('jtcat-start', (_e, mode) => startJtcat(mode));
  ipcMain.on('jtcat-stop', () => stopJtcat());
  ipcMain.on('jtcat-set-mode', (_e, mode) => { if (ft8Engine) ft8Engine.setMode(mode); });
  ipcMain.on('jtcat-set-tx-freq', (_e, hz) => { if (ft8Engine) ft8Engine.setTxFreq(hz); });
  ipcMain.on('jtcat-set-rx-freq', (_e, hz) => { if (ft8Engine) ft8Engine.setRxFreq(hz); });
  ipcMain.on('jtcat-enable-tx', (_e, enabled) => { if (ft8Engine) ft8Engine._txEnabled = enabled; });
  ipcMain.on('jtcat-halt-tx', () => {
    // Halt TX on ALL engines (multi-slice: any engine could be TX'ing)
    if (jtcatManager) {
      for (const id of jtcatManager.sliceIds) {
        const eng = jtcatManager.getEngine(id);
        if (eng) {
          eng._txEnabled = false;
          eng.setTxMessage('');
          if (eng._txActive) eng.txComplete();
        }
        jtcatManager.releaseTx(id);
      }
    } else if (ft8Engine) {
      ft8Engine._txEnabled = false;
      if (ft8Engine._txActive) ft8Engine.txComplete();
    }
    // Halt also kills any active tune
    if (jtcatTuneState.active) stopJtcatTune();
    // Also clear QSO state
    if (popoutJtcatQso) { popoutJtcatQso = null; popoutBroadcastQso(); }
    if (remoteJtcatQso) { remoteJtcatQso = null; remoteJtcatBroadcastQso(); }
    handleRemotePtt(false);
  });

  // KD2TJU: WSJT-X-style Tune button — keys PTT and plays a steady tone
  // through the rig USB CODEC for up to 90s, so the user can dial in TX
  // power and ALC without juggling Enable TX timing. Click again to stop
  // early. Halt TX also kills it.
  ipcMain.on('jtcat-tune-toggle', () => {
    if (jtcatTuneState.active) stopJtcatTune();
    else startJtcatTune();
  });
  ipcMain.on('jtcat-set-tx-msg', (_e, text) => { if (ft8Engine) ft8Engine.setTxMessage(text); });
  ipcMain.on('jtcat-set-tx-slot', (_e, slot) => { if (ft8Engine) ft8Engine.setTxSlot(slot); });
  ipcMain.on('jtcat-set-tx-gain', (_e, level) => {
    // Relay TX gain from popout to main renderer
    if (win && !win.isDestroyed()) win.webContents.send('jtcat-set-tx-gain', level);
  });
  ipcMain.on('jtcat-auto-cq-mode', (_e, mode) => {
    jtcatAutoCqMode = mode || 'off';
    jtcatAutoCqOwner = 'popout';
    if (mode === 'off') jtcatAutoCqWorkedSession.clear();
    broadcastAutoCqState();
    console.log('[JTCAT] Auto-CQ mode:', mode);
  });
  ipcMain.on('jtcat-tx-complete', () => { if (ft8Engine) ft8Engine.txComplete(); });
  ipcMain.on('jtcat-log', (_e, msg) => {
    console.log(msg);
    // Also surface in the Verbose CAT log so users diagnosing JTCAT
    // audio capture issues can see warnings without opening DevTools.
    sendCatLog(String(msg));
  });
  let _jtcatAudioDiag = 0;
  ipcMain.on('jtcat-audio', (_e, buf) => {
    _jtcatAudioDiag++;
    // Ensure buf is a proper array — IPC serialization on macOS can produce
    // objects that Float32Array constructor interprets as length instead of data
    let samples;
    if (buf instanceof Float32Array) {
      samples = buf;
    } else if (ArrayBuffer.isView(buf) || buf instanceof ArrayBuffer) {
      samples = new Float32Array(buf);
    } else if (Array.isArray(buf)) {
      samples = new Float32Array(buf);
    } else {
      // Fallback: buf might be an object with numeric keys from structured clone
      try { samples = new Float32Array(Object.values(buf)); } catch { return; }
    }
    if (_jtcatAudioDiag <= 3 || _jtcatAudioDiag % 200 === 0) {
      let max = 0;
      for (let j = 0; j < Math.min(100, samples.length); j++) max = Math.max(max, Math.abs(samples[j]));
      console.log(`[JTCAT] audio IPC #${_jtcatAudioDiag} len=${samples.length} max=${max.toFixed(4)} engine=${!!ft8Engine}`);
    }
    if (jtcatManager) jtcatManager.feedAudio('default', samples);
  });
  // Multi-slice audio: tagged with sliceId
  ipcMain.on('jtcat-slice-audio', (_e, sliceId, buf) => {
    let samples;
    if (buf instanceof Float32Array) samples = buf;
    else if (ArrayBuffer.isView(buf) || buf instanceof ArrayBuffer) samples = new Float32Array(buf);
    else if (Array.isArray(buf)) samples = new Float32Array(buf);
    else { try { samples = new Float32Array(Object.values(buf)); } catch { return; } }
    if (jtcatManager) jtcatManager.feedAudio(sliceId, samples);
  });

  // Multi-slice start: [{sliceId, mode, band, freqKhz, audioDeviceId, slicePort}]
  ipcMain.on('jtcat-start-multi', (_e, slices) => {
    if (!Array.isArray(slices) || slices.length === 0) return;
    stopJtcat();
    // Same audio-device contention fix as startJtcat: tear down SSTV
    // first so it doesn't hold the input device away from JTCAT.
    cancelAutoSstv();
    if (sstvPopoutWin && !sstvPopoutWin.isDestroyed()) {
      sendCatLog('[JTCAT] Closing SSTV popout — JTCAT and SSTV can\'t share the audio input');
      try { sstvPopoutWin.close(); } catch {}
    }
    jtcatAutoCqMode = 'off';
    jtcatAutoCqWorkedSession.clear();
    jtcatAutoCqOwner = null;
    if (!jtcatManager) jtcatManager = new JtcatManager();

    for (const s of slices) {
      const freqKhz = s.freqKhz || 14074;
      const engine = jtcatManager.startSlice({ sliceId: s.sliceId, mode: s.mode || 'FT8', sliceIndex: s.sliceIndex, band: s.band });
      jtcatManager.setDialFreq(s.sliceId, freqKhz * 1000, s.band);
      // Wire decode enrichment for this slice
      engine.on('decode', (data) => {
        if (data.results) {
          const currentBand = s.freqKhz ? freqToBand(s.freqKhz / 1000) : null;
          const wlStr = (settings.watchlist || '').toUpperCase();
          const wlCalls = wlStr ? wlStr.split(',').map(w => w.trim().split(':')[0]).filter(Boolean) : [];
          for (const r of data.results) {
            r.sliceId = s.sliceId;
            r.band = currentBand || s.band || '';
            const { dxCall } = extractCallsigns(r.text || '');
            if (!dxCall) continue;
            const uc = dxCall.toUpperCase();
            if (ctyDb) {
              const entity = resolveCallsign(uc, ctyDb);
              r.entity = entity ? entity.name : '';
              r.continent = entity ? entity.continent : '';
              r.newDxcc = !!(entity && currentBand && !rosterWorkedDxcc.has(entity.name + '|' + currentBand));
            }
            r.call = uc;
            r.newCall = !rosterWorkedCalls.has(uc);
            r.watched = wlCalls.length > 0 && wlCalls.some(w => uc.indexOf(w) >= 0 || w.indexOf(uc) >= 0);
            const gm = (r.text || '').match(/\b([A-R]{2}\d{2})\s*$/i);
            if (gm && !(/^RR\d{2}$/i.test(gm[1]))) {
              r.grid = gm[1].toUpperCase();
              r.newGrid = !rosterWorkedGrids.has(r.grid);
            }
          }
        }
        // Forward to popout
        if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
          jtcatPopoutWin.webContents.send('jtcat-decode', { ...data, sliceId: s.sliceId, band: s.band });
        }
        if (remoteServer && remoteServer.hasClient()) {
          const now = new Date();
          const timeStr = String(now.getUTCHours()).padStart(2, '0') + ':' +
                          String(now.getUTCMinutes()).padStart(2, '0') + ':' +
                          String(now.getUTCSeconds()).padStart(2, '0');
          remoteServer.broadcastJtcatDecode({ ...data, sliceId: s.sliceId, band: s.band, time: timeStr });
        }
        // Advance QSO state machine from this slice's decodes
        // (same logic as single-engine path in startJtcat)
        if (popoutJtcatQso && popoutJtcatQso.phase === 'done') {
          popoutJtcatQso = null;
          popoutBroadcastQso();
        }
        if (remoteJtcatQso && remoteJtcatQso.phase === 'done') {
          remoteJtcatQso = null;
          remoteJtcatBroadcastQso();
        }
        if (popoutJtcatQso && popoutJtcatQso.phase !== 'done') {
          const phaseBefore = popoutJtcatQso.phase;
          popoutJtcatQso._heardThisCycle = false;
          processPopoutJtcatQso(data.results || []);
          if (popoutJtcatQso && popoutJtcatQso.phase === phaseBefore && popoutJtcatQso.phase !== 'done') {
            if (popoutJtcatQso._heardThisCycle) {
              popoutJtcatQso.txRetries = 0;
            } else {
              popoutJtcatQso.txRetries = (popoutJtcatQso.txRetries || 0) + 1;
              const max = (popoutJtcatQso.phase === 'cq') ? JTCAT_MAX_CQ_RETRIES : JTCAT_MAX_QSO_RETRIES;
              if (popoutJtcatQso.txRetries >= max) {
                console.log('[JTCAT Multi] Popout TX retry limit — giving up');
                engine._txEnabled = false;
                engine.setTxMessage('');
                if (engine._txActive) engine.txComplete();
                popoutJtcatQso = null;
                popoutBroadcastQso();
                if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
                  jtcatPopoutWin.webContents.send('jtcat-qso-state', { phase: 'error', error: 'No response — TX stopped' });
                }
              }
            }
          } else if (popoutJtcatQso && popoutJtcatQso.phase !== phaseBefore) {
            popoutJtcatQso.txRetries = 0;
          }
          popoutBroadcastQso();
        }
        if (remoteJtcatQso && remoteJtcatQso.phase !== 'done') {
          const phaseBefore = remoteJtcatQso.phase;
          remoteJtcatQso._heardThisCycle = false;
          processRemoteJtcatQso(data.results || []);
          if (remoteJtcatQso && remoteJtcatQso.phase === phaseBefore && remoteJtcatQso.phase !== 'done') {
            if (remoteJtcatQso._heardThisCycle) {
              remoteJtcatQso.txRetries = 0;
            } else {
              remoteJtcatQso.txRetries = (remoteJtcatQso.txRetries || 0) + 1;
              const max = (remoteJtcatQso.phase === 'cq') ? JTCAT_MAX_CQ_RETRIES : JTCAT_MAX_QSO_RETRIES;
              if (remoteJtcatQso.txRetries >= max) {
                console.log('[JTCAT Multi] Remote TX retry limit — giving up');
                engine._txEnabled = false;
                engine.setTxMessage('');
                if (engine._txActive) engine.txComplete();
                remoteJtcatQso = null;
                remoteJtcatBroadcastQso();
                if (remoteServer.hasClient()) {
                  remoteServer.broadcastJtcatQsoState({ phase: 'error', error: 'No response — TX stopped' });
                }
              }
            }
          } else if (remoteJtcatQso && remoteJtcatQso.phase !== phaseBefore) {
            remoteJtcatQso.txRetries = 0;
          }
          remoteJtcatBroadcastQso();
        }

        // Smart TX scheduling — evaluate priority at each decode cycle
        const txWinner = jtcatManager.scheduleTx();
        if (txWinner) {
          console.log(`[JTCAT] TX scheduler: ${txWinner} wins TX slot`);
        }
      });

      // Wire TX events — critical for multi-slice PTT and audio playback
      engine.on('tx-start', (data) => {
        // Only TX if this slice owns the TX slot (prevents two slices TX'ing simultaneously)
        if (jtcatManager && jtcatManager.txSliceId !== s.sliceId) {
          console.log(`[JTCAT Multi] TX blocked on ${s.sliceId}/${s.band} — TX owned by ${jtcatManager.txSliceId}`);
          engine._txEnabled = false;
          if (engine._txActive) engine.txComplete();
          return;
        }
        const catState = cat ? `connected=${cat.connected}` : 'cat=null';
        console.log(`[JTCAT Multi] TX start on ${s.sliceId}/${s.band} — PTT on, message: ${data.message}, ${catState}`);
        sendCatLog(`FT8 TX (${s.band}): ${data.message} freq=${data.freq}Hz slot=${data.slot} ${catState}`);
        handleRemotePtt(true);
        if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
          jtcatPopoutWin.webContents.send('jtcat-tx-status', { state: 'tx', message: data.message, slot: data.slot, txFreq: engine._txFreq, sliceId: s.sliceId });
        }
        if (remoteServer && remoteServer.hasClient()) {
          remoteServer.broadcastJtcatTxStatus({ state: 'tx', message: data.message, slot: data.slot, txFreq: engine._txFreq, sliceId: s.sliceId });
        }
        // Send TX audio to renderer for playback through DAX TX
        setTimeout(() => {
          if (win && !win.isDestroyed() && engine._txActive) {
            win.webContents.send('jtcat-tx-audio', { samples: Array.from(data.samples), offsetMs: data.offsetMs || 0 });
          }
        }, 200);
      });

      engine.on('tx-end', () => {
        console.log(`[JTCAT Multi] TX end on ${s.sliceId}/${s.band} — PTT off`);
        handleRemotePtt(false);
        if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
          jtcatPopoutWin.webContents.send('jtcat-tx-status', { state: 'rx', sliceId: s.sliceId });
        }
        if (remoteServer && remoteServer.hasClient()) {
          remoteServer.broadcastJtcatTxStatus({ state: 'rx' });
        }
      });

      engine.on('cycle', (data) => {
        if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
          jtcatPopoutWin.webContents.send('jtcat-cycle', { ...data, sliceId: s.sliceId });
        }
        if (remoteServer && remoteServer.hasClient()) {
          remoteServer.broadcastJtcatCycle({ ...data, sliceId: s.sliceId });
        }
      });

      engine.on('silent', () => {
        console.warn(`[JTCAT Multi] Silent audio on ${s.sliceId}/${s.band}`);
        if (win && !win.isDestroyed()) win.webContents.send('restart-jtcat-audio');
      });
    }

    // Listen for TX slice switches (for SmartSDR slice routing)
    jtcatManager.on('tx-switch', ({ sliceId }) => {
      const cfg = slices.find(c => c.sliceId === sliceId);
      if (cfg && smartSdr && smartSdr.connected) {
        const sliceIndex = (cfg.slicePort || 5002) - 5002;
        smartSdr.setTxSlice(sliceIndex);
        console.log(`[JTCAT] SmartSDR TX switched to slice ${String.fromCharCode(65 + sliceIndex)}`);
      }
    });

    ft8Engine = jtcatManager.engine; // Phase 0 compat alias
    console.log(`[JTCAT] Multi-slice started: ${slices.map(s => s.sliceId + '/' + s.band).join(', ')}`);
  });

  ipcMain.on('jtcat-quiet-freq', (_e, hz) => {
    jtcatQuietFreq = hz;
  });
  ipcMain.on('jtcat-spectrum', (_e, bins) => {
    if (remoteServer && remoteServer.hasClient()) remoteServer.broadcastJtcatSpectrum(bins);
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) jtcatPopoutWin.webContents.send('jtcat-spectrum', { bins });
  });

  // --- FreeDV Digital Voice IPC ---

  ipcMain.on('freedv-start', (_e, mode) => {
    if (freedvEngine) freedvEngine.stop();
    freedvEngine = new FreedvEngine();
    freedvEngine.on('rx-speech', (data) => {
      if (win && !win.isDestroyed()) win.webContents.send('freedv-rx-speech', data);
    });
    freedvEngine.on('tx-modem', (data) => {
      if (win && !win.isDestroyed()) win.webContents.send('freedv-tx-modem', data);
    });
    freedvEngine.on('sync', (data) => {
      if (win && !win.isDestroyed()) win.webContents.send('freedv-sync', data);
      if (remoteServer && remoteServer.running) {
        remoteServer.sendToClient({ type: 'freedv-sync', ...data });
      }
    });
    freedvEngine.on('status', (data) => {
      sendCatLog(`[FreeDV] ${data.state} mode=${data.mode}`);
      if (win && !win.isDestroyed()) win.webContents.send('freedv-status', data);
    });
    freedvEngine.on('error', (data) => {
      sendCatLog(`[FreeDV] Error: ${data.message}`);
    });
    freedvEngine.start(mode);
    if (settings.freedvSquelch) {
      freedvEngine.setSquelch(!!settings.freedvSquelch.enabled, Number(settings.freedvSquelch.threshold));
    }
  });

  ipcMain.on('freedv-stop', () => {
    if (freedvEngine) { freedvEngine.stop(); freedvEngine = null; }
  });

  ipcMain.on('freedv-set-mode', (_e, mode) => {
    if (freedvEngine) freedvEngine.setMode(mode);
  });

  let _freedvRxCount = 0;
  ipcMain.on('freedv-rx-audio', (_e, buf) => {
    if (freedvEngine) {
      const samples = buf instanceof Int16Array ? buf : new Int16Array(buf);
      if (++_freedvRxCount <= 3 || _freedvRxCount % 200 === 0) {
        console.log(`[FreeDV] RX audio #${_freedvRxCount} len=${samples.length} engine=${!!freedvEngine}`);
      }
      freedvEngine.feedRxAudio(samples);
    }
  });

  ipcMain.on('freedv-tx-audio', (_e, buf) => {
    if (freedvEngine) {
      const samples = buf instanceof Int16Array ? buf : new Int16Array(buf);
      freedvEngine.feedTxAudio(samples);
    }
  });

  ipcMain.on('freedv-set-tx', (_e, enabled) => {
    if (freedvEngine) freedvEngine.setTxEnabled(enabled);
  });

  ipcMain.on('freedv-set-squelch', (_e, enabled, threshold) => {
    if (freedvEngine) freedvEngine.setSquelch(enabled, threshold);
    settings.freedvSquelch = { enabled: !!enabled, threshold: Number(threshold) };
    saveSettings(settings);
  });

  // --- QRZ single callsign lookup (for Quick Log) ---
  ipcMain.handle('qrz-lookup', async (_e, callsign) => {
    if (!qrz.configured || !settings.enableQrz) return null;
    try {
      return await qrz.lookup(callsign);
    } catch {
      return null;
    }
  });

  // --- QRZ Logbook API ---
  ipcMain.handle('qrz-check-sub', async (_e, force) => {
    if (!qrz.configured || !settings.enableQrz) {
      return { subscriber: false, expiry: '', error: 'QRZ not configured' };
    }
    // Use cached subscription info if available (unless force recheck)
    if (!force && qrz.subscriptionExpiry) {
      return { subscriber: qrz.isSubscriber, expiry: qrz.subscriptionExpiry };
    }
    try {
      qrz._sessionKey = null;
      await qrz.login();
      return { subscriber: qrz.isSubscriber, expiry: qrz.subscriptionExpiry };
    } catch (err) {
      return { subscriber: false, expiry: '', error: err.message };
    }
  });

  ipcMain.handle('qrz-verify-api-key', async (_e, key) => {
    if (!key) return { ok: false, message: 'No API key provided' };
    return QrzClient.checkApiKey(key, settings.myCallsign || '');
  });

  // --- QRZ Logbook Download & Merge ---
  ipcMain.handle('qrz-download-logbook', async () => {
    if (!settings.qrzApiKey) return { ok: false, error: 'QRZ API key not configured' };
    try {
      sendCatLog('[QRZ] Downloading logbook...');
      const adifText = await QrzClient.fetchLogbook(settings.qrzApiKey, settings.myCallsign || '', (msg) => sendCatLog(msg));
      if (!adifText) return { ok: true, imported: 0, message: 'QRZ logbook is empty' };

      // Length-respecting parser handles ADIF with or without <EOR> separators
      // (QRZ's responses may omit <EOR> between records).
      const records = parseAdifStream(adifText);
      sendCatLog(`[QRZ] Parsed ${records.length} records from ${adifText.length} bytes of ADIF`);

      // Dedup against existing log
      const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
      const existingQsos = new Set();
      try {
        const existing = parseAllRawQsos(logPath);
        for (const q of existing) {
          const key = [q.CALL, q.QSO_DATE, (q.TIME_ON || '').slice(0, 4), q.BAND].join('|').toUpperCase();
          existingQsos.add(key);
        }
      } catch { /* no existing log or parse error */ }

      let imported = 0;
      let skipped = 0;
      for (const fields of records) {
        const key = [fields.CALL, fields.QSO_DATE, (fields.TIME_ON || '').slice(0, 4), fields.BAND].join('|').toUpperCase();
        if (existingQsos.has(key)) { skipped++; continue; }
        // appendRawQso expects a fields object — pass the parsed map directly
        // (the previous code passed a raw string here, which corrupted the log)
        appendRawQso(logPath, fields);
        existingQsos.add(key);
        imported++;
      }

      sendCatLog(`[QRZ] Downloaded ${records.length} QSOs, imported ${imported} new, skipped ${skipped} duplicates`);
      if (imported > 0) loadWorkedQsos();
      return { ok: true, imported, total: records.length, skipped };
    } catch (err) {
      sendCatLog(`[QRZ] Logbook download failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  // Diagnostic: dump one raw QRZ Logbook response to a file for ground-truth
  // analysis. Used when a download produces unexpected results — we save what
  // QRZ actually sent so we can see the wire format instead of guessing.
  ipcMain.handle('qrz-debug-dump', async () => {
    if (!settings.qrzApiKey) return { ok: false, error: 'QRZ API key not configured' };
    try {
      sendCatLog('[QRZ] Capturing raw response for diagnosis...');
      const raw = await QrzClient.fetchLogbookRaw(settings.qrzApiKey, settings.myCallsign || '', 5);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const outPath = path.join(app.getPath('documents'), `potacat-qrz-debug-${ts}.txt`);
      fs.writeFileSync(outPath, raw, 'utf-8');
      sendCatLog(`[QRZ] Raw response saved (${raw.length} bytes): ${outPath}`);
      return { ok: true, path: outPath, bytes: raw.length };
    } catch (err) {
      sendCatLog(`[QRZ] Debug dump failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  // --- Activator Mode: Parks DB IPC ---
  ipcMain.handle('fetch-parks-db', async (_e, prefix) => {
    if (!prefix) return { success: false, error: 'No program prefix' };
    try {
      await loadParksDbForCallsign(prefix === 'auto' ? (settings.myCallsign || '') : prefix);
      return { success: true, count: parksArray.length, prefix: parksDbPrefix };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('search-parks', (_e, query) => {
    return searchParksDb(parksArray, query);
  });

  ipcMain.handle('get-park', (_e, ref) => {
    return getParkDb(parksMap, ref);
  });

  ipcMain.handle('parks-db-status', () => {
    return { prefix: parksDbPrefix, count: parksArray.length, loading: parksDbLoading };
  });

  ipcMain.handle('export-activation-adif', async (event, data) => {
    const { writeActivationAdifRaw } = require('./lib/adif-writer');
    const { qsos, parkRef, myCallsign: activatorCall } = data;
    if (!qsos || !qsos.length) return { success: false, error: 'No contacts to export' };
    try {
      const parentWin = BrowserWindow.fromWebContents(event.sender) || win;
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      const defaultName = `${activatorCall || 'POTACAT'}@${parkRef || 'PARK'}-${dateStr}.adi`;
      const result = await dialog.showSaveDialog(parentWin, {
        title: 'Export Activation ADIF',
        defaultPath: path.join(adifExportDefaultDir(), defaultName),
        filters: [
          { name: 'ADIF Files', extensions: ['adi', 'adif'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled) return { success: false };
      writeActivationAdifRaw(result.filePath, qsos);
      rememberAdifExportDir(result.filePath);
      return { success: true, path: result.filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // One-click "Upload to POTA.app": writes the activation ADIF to a known
  // userData path, reveals the file in the OS file manager, and opens
  // pota.app's upload page in the user's browser. The user drags the file
  // from the file manager onto the upload page. We deliberately don't try
  // to POST the ADIF to pota.app's API — that endpoint is IAM-authorized
  // (SigV4) on a deliberately-private API (per WD4DAN, who's on the POTA
  // dev team), and v3 will ship real API keys "next year-ish". Until then
  // this manual-but-streamlined flow is the only sanctioned path.
  ipcMain.handle('upload-activation-to-pota', async (_e, data) => {
    const { writeActivationAdifRaw } = require('./lib/adif-writer');
    const { qsos, parkRef, myCallsign: activatorCall } = data || {};
    if (!qsos || !qsos.length) return { success: false, error: 'No contacts to upload' };
    try {
      const dir = path.join(app.getPath('userData'), 'pota-uploads');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      const safeCall = (activatorCall || 'POTACAT').replace(/[^A-Za-z0-9_-]/g, '_');
      const safeRef = (parkRef || 'PARK').replace(/[^A-Za-z0-9_-]/g, '_');
      const fileName = `${safeCall}@${safeRef}-${dateStr}.adi`;
      const filePath = path.join(dir, fileName);
      writeActivationAdifRaw(filePath, qsos);
      // Reveal the file in Explorer/Finder so the user can drag-drop it
      // onto the upload page. Then open the upload page itself.
      const { shell } = require('electron');
      try { shell.showItemInFolder(filePath); } catch {}
      try { shell.openExternal('https://pota.app/#/upload'); } catch {}
      return { success: true, path: filePath, fileName, qsoCount: qsos.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('export-activation-adif-perpark', async (event, data) => {
    const { writeActivationAdifRaw } = require('./lib/adif-writer');
    const { qsosByPark, myCallsign: activatorCall } = data;
    if (!qsosByPark || !Object.keys(qsosByPark).length) return { success: false, error: 'No contacts to export' };
    try {
      const parentWin = BrowserWindow.fromWebContents(event.sender) || win;
      const result = await dialog.showOpenDialog(parentWin, {
        title: 'Choose folder for per-park ADIF files',
        defaultPath: adifExportDefaultDir(),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths.length) return { success: false };
      const folder = result.filePaths[0];
      // The folder itself is what the user picked — remember it as-is.
      if (folder && folder !== settings.lastAdifExportDir) {
        settings.lastAdifExportDir = folder;
        saveSettings(settings);
      }
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      let fileCount = 0;
      let totalQsos = 0;
      for (const [ref, qsos] of Object.entries(qsosByPark)) {
        const safeRef = ref.replace(/[^A-Za-z0-9_-]/g, '_');
        const fileName = `${activatorCall || 'POTACAT'}@${safeRef}-${dateStr}.adi`;
        const filePath = path.join(folder, fileName);
        writeActivationAdifRaw(filePath, qsos);
        fileCount++;
        totalQsos += qsos.length;
      }
      return { success: true, folder, fileCount, totalQsos };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // --- Past Activations (scan log for MY_SIG groups — POTA, SOTA, etc.) ---
  function getPastActivations() {
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      if (!fs.existsSync(logPath)) return [];
      const qsos = parseAllRawQsos(logPath);
      // Group by MY_SIG_INFO (park/summit ref) + QSO_DATE
      const groups = new Map();
      for (const q of qsos) {
        const mySig = (q.MY_SIG || '').toUpperCase();
        if (!mySig || !q.MY_SIG_INFO) continue;
        const ref = q.MY_SIG_INFO.toUpperCase();
        const date = q.QSO_DATE || '';
        const key = `${ref}|${date}`;
        if (!groups.has(key)) {
          groups.set(key, { parkRef: ref, date, sig: mySig, contacts: [] });
        }
        groups.get(key).contacts.push({
          callsign: q.CALL || '',
          timeOn: q.TIME_ON || '',
          freq: q.FREQ || '',
          mode: q.MODE || '',
          band: q.BAND || '',
          rstSent: q.RST_SENT || '',
          rstRcvd: q.RST_RCVD || '',
          name: q.NAME || '',
          sig: q.SIG || '',
          sigInfo: q.SIG_INFO || '',
          myGridsquare: q.MY_GRIDSQUARE || '',
        });
      }
      // Sort newest first
      const result = [...groups.values()];
      result.sort((a, b) => (b.date + (b.contacts[0]?.timeOn || '')).localeCompare(a.date + (a.contacts[0]?.timeOn || '')));
      return result;
    } catch {
      return [];
    }
  }

  ipcMain.handle('get-past-activations', () => getPastActivations());

  // --- Delete activation (removes matching QSOs from ADIF log) ---
  ipcMain.handle('delete-activation', async (_e, parkRef, date) => {
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      if (!fs.existsSync(logPath)) return { success: false, error: 'Log file not found' };
      const qsos = parseAllRawQsos(logPath);
      const before = qsos.length;
      const filtered = qsos.filter(q => {
        if ((q.MY_SIG || '').toUpperCase() !== 'POTA') return true;
        if ((q.MY_SIG_INFO || '').toUpperCase() !== parkRef.toUpperCase()) return true;
        if ((q.QSO_DATE || '') !== date) return true;
        return false; // matches — remove it
      });
      const removed = before - filtered.length;
      if (removed === 0) return { success: true, removed: 0 };
      rewriteAdifFile(logPath, filtered);
      loadWorkedQsos();
      return { success: true, removed };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // --- Resolve callsigns to lat/lon via cty.dat (for activation map) ---
  ipcMain.handle('resolve-callsign-locations', (_e, callsigns) => {
    if (!ctyDb || !Array.isArray(callsigns)) return {};
    const result = {};
    for (const cs of callsigns) {
      const entity = resolveCallsign(cs, ctyDb);
      if (entity && entity.lat != null && entity.lon != null) {
        // Use call-area regional coords for large countries instead of country centroid
        const area = getCallAreaCoords(cs, entity.name);
        if (area) {
          result[cs] = { lat: area.lat, lon: area.lon, name: entity.name || '', continent: entity.continent || '' };
        } else {
          result[cs] = { lat: entity.lat, lon: entity.lon, name: entity.name || '', continent: entity.continent || '' };
        }
      }
    }
    return result;
  });

  // --- Recent QSOs IPC ---
  ipcMain.handle('get-recent-qsos', () => {
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      if (!fs.existsSync(logPath)) return [];
      const qsos = parseAllQsos(logPath);
      qsos.sort((a, b) => (b.qsoDate + b.timeOn).localeCompare(a.qsoDate + a.timeOn));
      return qsos.slice(0, 10).map(q => ({
        call: q.call,
        qsoDate: q.qsoDate,
        timeOn: q.timeOn,
        band: q.band,
        mode: q.mode,
        freq: q.freq,
        rstSent: q.rstSent,
        rstRcvd: q.rstRcvd,
        comment: q.comment,
      }));
    } catch {
      return [];
    }
  });

  // --- Full Log Viewer IPC ---
  ipcMain.handle('get-all-qsos', () => {
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      if (!fs.existsSync(logPath)) return [];
      const qsos = parseAllRawQsos(logPath);
      return qsos.map((fields, idx) => ({ idx, ...fields }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('update-qso', async (event, { idx, fields }) => {
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      const qsos = parseAllRawQsos(logPath);
      if (idx < 0 || idx >= qsos.length) return { success: false, error: 'Invalid index' };
      Object.assign(qsos[idx], fields);
      rewriteAdifFile(logPath, qsos);
      if (cloudIpc) cloudIpc.journalUpdate(qsos[idx]);
      loadWorkedQsos();
      // Notify other windows about the change
      const sender = event.sender;
      if (qsoPopoutWin && !qsoPopoutWin.isDestroyed() && qsoPopoutWin.webContents !== sender) {
        qsoPopoutWin.webContents.send('qso-popout-updated', { idx, fields });
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // AG5B: when the user pastes "US-1595, US-4567, ..." into the SIG_INFO
  // cell of an existing QSO in the logbook, offer to split it into N
  // separate POTA records (each park needs its own QSO for credit). The
  // first ref stays on the original row; each additional ref clones the
  // row with TIME_ON +N seconds so dupe-detection in downstream loggers
  // doesn't merge them.
  ipcMain.handle('expand-qso-multipark', async (event, { idx, refs }) => {
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      const qsos = parseAllRawQsos(logPath);
      if (idx < 0 || idx >= qsos.length) return { success: false, error: 'Invalid index' };
      const cleanRefs = (refs || [])
        .map(r => String(r || '').trim().toUpperCase())
        .filter(Boolean);
      if (cleanRefs.length < 2) return { success: false, error: 'Need at least two refs to split' };

      const base = qsos[idx];
      base.SIG = 'POTA';
      base.SIG_INFO = cleanRefs[0];
      base.POTA_REF = cleanRefs[0];

      // Build clones for refs[1..N-1]. TIME_ON is HHMMSS in ADIF; bump the
      // seconds field by i so each row has a unique timestamp. If the bump
      // crosses 60s we just keep going — major loggers tolerate non-rollover
      // times in this range, and 4-park n-fers logged at the same minute
      // are realistic.
      const baseTime = (base.TIME_ON || '000000').padEnd(6, '0').slice(0, 6);
      const baseHms = parseInt(baseTime, 10) || 0;
      const clones = [];
      for (let i = 1; i < cleanRefs.length; i++) {
        const newHms = String(baseHms + i).padStart(6, '0');
        const clone = { ...base };
        clone.SIG = 'POTA';
        clone.SIG_INFO = cleanRefs[i];
        clone.POTA_REF = cleanRefs[i];
        clone.TIME_ON = newHms;
        if (clone.TIME_OFF) clone.TIME_OFF = newHms;
        clones.push(clone);
      }
      qsos.splice(idx + 1, 0, ...clones);
      rewriteAdifFile(logPath, qsos);
      if (cloudIpc) {
        cloudIpc.journalUpdate(base);
        for (const c of clones) cloudIpc.journalUpdate(c);
      }
      loadWorkedQsos();
      // Notify the QSO pop-out to reload from disk so its indices realign —
      // splice shifted everything after idx.
      const sender = event.sender;
      if (qsoPopoutWin && !qsoPopoutWin.isDestroyed() && qsoPopoutWin.webContents !== sender) {
        qsoPopoutWin.webContents.send('qso-popout-refresh');
      }
      return { success: true, added: clones.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('delete-qso', async (event, idx) => {
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      const qsos = parseAllRawQsos(logPath);
      if (idx < 0 || idx >= qsos.length) return { success: false, error: 'Invalid index' };
      const deletedQso = { ...qsos[idx] };
      qsos.splice(idx, 1);
      rewriteAdifFile(logPath, qsos);
      if (cloudIpc) cloudIpc.journalDelete(deletedQso);
      loadWorkedQsos();
      // Notify QSO pop-out about the deletion
      const sender = event.sender;
      if (qsoPopoutWin && !qsoPopoutWin.isDestroyed() && qsoPopoutWin.webContents !== sender) {
        qsoPopoutWin.webContents.send('qso-popout-deleted', idx);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Update QSO(s) by matching fields (used by activator mode to edit a contact with multiple ADIF records)
  ipcMain.handle('update-qsos-by-match', async (_event, { match, updates }) => {
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      const qsos = parseAllRawQsos(logPath);
      const callUpper = (match.callsign || '').toUpperCase();
      const dateMatch = (match.qsoDate || '').replace(/-/g, '');
      const timeMatch = (match.timeOn || '').replace(/:/g, '');
      let updated = 0;
      for (const q of qsos) {
        const qCall = (q.CALL || '').toUpperCase();
        const qDate = (q.QSO_DATE || '').replace(/-/g, '');
        const qTime = (q.TIME_ON || '').replace(/:/g, '').substring(0, 4);
        if (qCall !== callUpper) continue;
        if (qDate !== dateMatch) continue;
        if (qTime !== timeMatch.substring(0, 4)) continue;
        if (match.frequency) {
          const qFreq = parseFloat(q.FREQ || 0) * 1000;
          const mFreq = parseFloat(match.frequency);
          if (Math.abs(qFreq - mFreq) > 1) continue;
        }
        // Apply updates
        Object.assign(q, updates);
        updated++;
      }
      if (updated > 0) {
        rewriteAdifFile(logPath, qsos);
        loadWorkedQsos();
        if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) {
          const refreshed = parseAllRawQsos(logPath);
          qsoPopoutWin.webContents.send('qso-popout-refreshed', refreshed);
        }
      }
      return { success: true, updated };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Delete QSO(s) by matching fields (used by activator mode to remove a contact with multiple ADIF records)
  ipcMain.handle('delete-qsos-by-match', async (_event, match) => {
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      const qsos = parseAllRawQsos(logPath);
      const before = qsos.length;
      const callUpper = (match.callsign || '').toUpperCase();
      const dateMatch = (match.qsoDate || '').replace(/-/g, '');
      const timeMatch = (match.timeOn || '').replace(/:/g, '');
      // Remove all QSOs that match callsign + date + time (+ freq if provided)
      const filtered = qsos.filter(q => {
        const qCall = (q.CALL || '').toUpperCase();
        const qDate = (q.QSO_DATE || '').replace(/-/g, '');
        const qTime = (q.TIME_ON || '').replace(/:/g, '').substring(0, 4);
        if (qCall !== callUpper) return true;
        if (qDate !== dateMatch) return true;
        if (qTime !== timeMatch.substring(0, 4)) return true;
        if (match.frequency) {
          const qFreq = parseFloat(q.FREQ || 0) * 1000; // FREQ in MHz -> kHz
          const mFreq = parseFloat(match.frequency);
          if (Math.abs(qFreq - mFreq) > 1) return true;
        }
        return false; // matched — remove
      });
      const removed = before - filtered.length;
      if (removed > 0) {
        rewriteAdifFile(logPath, filtered);
        loadWorkedQsos();
        // Notify QSO pop-out to refresh
        if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) {
          const refreshed = parseAllRawQsos(logPath);
          qsoPopoutWin.webContents.send('qso-popout-refreshed', refreshed);
        }
      }
      return { success: true, removed };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // --- RBN IPC ---
  ipcMain.on('rbn-clear', () => {
    rbnSpots = [];
    sendRbnSpots();
  });

  // --- PSKReporter Map IPC ---
  ipcMain.on('pskr-map-clear', () => {
    pskrMapSpots = [];
    sendPskrMapSpots();
  });

  // --- CW Keyer IPC ---
  // Paddle events go through IambicKeyer, which generates key events -> xmit 1/0
  ipcMain.on('cw-paddle-dit', (_e, pressed) => {
    if (keyer) keyer.paddleDit(pressed);
  });
  ipcMain.on('cw-paddle-dah', (_e, pressed) => {
    if (keyer) keyer.paddleDah(pressed);
  });
  ipcMain.on('cw-set-wpm', (_e, wpm) => {
    if (keyer) keyer.setWpm(wpm);
    if (winKeyer && winKeyer.connected) winKeyer.setSpeed(wpm);
    if (smartSdr && smartSdr.connected) smartSdr.setCwSpeed(wpm);
    if (cat && cat.connected) cat.setCwSpeed(wpm);
  });
  ipcMain.on('cw-stop', () => {
    if (keyer) keyer.stop();
    if (winKeyer && winKeyer.connected) winKeyer.cancelText();
    if (smartSdr && smartSdr.connected) smartSdr.cwStop();
  });
  // Desktop voice macro PTT — voice macros play audio through the rig's
  // USB CODEC, so SSB-over-DATA's mode switch IS appropriate here when
  // the user has it enabled.
  ipcMain.on('voice-macro-ptt', (_e, state) => {
    handleRemotePtt(!!state, { audio: true });
  });

  // VFO popout's manual PTT button — naked TX key with no audio bridge to
  // the rig. K4GDJ on FTDX101MP (2026-05): voice-macro-ptt's audio:true
  // triggered SSB-over-DATA on every press, flipping USB to PKTUSB and
  // disabling the rig mic. The popout's mic capture (if any) goes to the
  // user's local speaker / sinkId, not necessarily the rig — so the
  // mode-switch assumption is wrong. Treat this as audio:false.
  ipcMain.on('naked-ptt', (_e, state) => {
    handleRemotePtt(!!state, { audio: false });
  });

  // Voice macro file storage (shared between desktop and ECHOCAT)
  // Voice macro helpers hoisted to module scope (see below)

  ipcMain.handle('voice-macro-save', (_e, idx, base64) => {
    ensureVoiceMacroDir();
    fs.writeFileSync(voiceMacroPath(idx), Buffer.from(base64, 'base64'));
    // Sync to connected ECHOCAT phone
    if (remoteServer && remoteServer.hasClient()) {
      const label = (settings.voiceMacroLabels || [])[idx] || '';
      remoteServer.sendToClient({ type: 'voice-macro-sync', idx, label, audio: base64 });
    }
    return true;
  });

  ipcMain.handle('voice-macro-load', (_e, idx) => {
    const p = voiceMacroPath(idx);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p).toString('base64');
  });

  ipcMain.handle('voice-macro-delete', (_e, idx) => {
    const p = voiceMacroPath(idx);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    if (remoteServer && remoteServer.hasClient()) {
      remoteServer.sendToClient({ type: 'voice-macro-delete', idx });
    }
    return true;
  });

  ipcMain.handle('voice-macro-list', () => {
    ensureVoiceMacroDir();
    const filled = [];
    for (let i = 0; i < 5; i++) { if (fs.existsSync(voiceMacroPath(i))) filled.push(i); }
    return filled;
  });

  ipcMain.handle('voice-macro-labels-save', (_e, labels) => {
    settings.voiceMacroLabels = labels;
    saveSettings(settings);
    if (remoteServer && remoteServer.hasClient()) {
      remoteServer.sendToClient({ type: 'voice-macro-labels', labels });
    }
    return true;
  });
  // Desktop CW text sending (macros)
  ipcMain.on('send-cw-text', (_e, text) => {
    sendCwTextToRadio(text);
  });
  // Desktop CW cancel / abort
  ipcMain.on('cw-cancel', () => {
    if (winKeyer && winKeyer.connected) winKeyer.cancelText();
    if (keyer) keyer.stop();
    if (smartSdr && smartSdr.connected) smartSdr.cwStop();
  });
});

// --- Parks DB loader ---
async function loadParksDbForCallsign(callsign) {
  const prefix = callsignToProgram(callsign);
  if (!prefix || prefix === parksDbPrefix) return;
  if (parksDbLoading) return;
  parksDbLoading = true;
  try {
    const userDataPath = app.getPath('userData');
    const cached = loadParksCache(userDataPath, prefix);
    if (cached && !isCacheStale(cached.updatedAt)) {
      parksArray = cached.parks || [];
      parksMap = buildParksMap(parksArray);
      parksDbPrefix = prefix;
      parksDbLoading = false;
      return;
    }
    // Fetch fresh from API
    const parks = await fetchParksForProgram(prefix);
    saveParksCache(userDataPath, prefix, parks);
    parksArray = parks;
    parksMap = buildParksMap(parksArray);
    parksDbPrefix = prefix;
  } catch (err) {
    console.error('[ParksDB] Failed to load:', err.message);
    // Fall back to stale cache if available
    const userDataPath = app.getPath('userData');
    const cached = loadParksCache(userDataPath, prefix);
    if (cached) {
      parksArray = cached.parks || [];
      parksMap = buildParksMap(parksArray);
      parksDbPrefix = prefix;
    }
  } finally {
    parksDbLoading = false;
  }
}

let cleanupDone = false;
function gracefulCleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  // SAFETY FIRST: release PTT before we tear down any rig connections. If the
  // user shut down during an SSTV/FT8/CW transmission, we must stop TX on the
  // radio before the SmartSDR/CAT/keyer connections close — otherwise the
  // radio can stay keyed with no audio (a silent-carrier FCC issue).
  try { handleRemotePtt(false); } catch {}
  try { if (sstvEngine) sstvEngine.stop(); } catch {}
  // Save QRZ cache to disk
  try {
    const qrzCachePath = path.join(app.getPath('userData'), 'qrz-cache.json');
    qrz.saveCache(qrzCachePath);
  } catch {}
  if (spotTimer) clearInterval(spotTimer);
  if (solarTimer) clearInterval(solarTimer);
  if (cat) try { cat.disconnect(); } catch {}
  for (const [, entry] of clusterClients) { try { entry.client.disconnect(); } catch {} }
  clusterClients.clear();
  for (const [, c] of cwSpotsClients) { try { c.disconnect(); } catch {} }
  cwSpotsClients.clear();
  if (rbn) try { rbn.disconnect(); } catch {}
  try { disconnectWsjtx(); } catch {}
  try { disconnectSmartSdr(); } catch {}
  try { disconnectTci(); } catch {}
  try { disconnectAntennaGenius(); } catch {}
  try { disconnectTunerGenius(); } catch {}
  try { disconnectFreedvReporter(); } catch {}
  try { disconnectRemote(); } catch {}
  try { disconnectKeyer(); } catch {}
  try { stopJtcat(); } catch {}
  try { stopSstv(); } catch {}
  try { stopSstvMulti(); } catch {}
  try { stopAutoSstvTimer(); } catch {}
  try { hamrsBridge.stop(); } catch {}
  try { extraUdpBridge.stop(); } catch {}
  try { if (potaSync) potaSync.stop(); } catch {}
  killRigctld();
}

app.on('before-quit', gracefulCleanup);
process.on('SIGINT', () => { gracefulCleanup(); process.exit(0); });
process.on('SIGTERM', () => { gracefulCleanup(); process.exit(0); });

app.on('window-all-closed', () => {
  if (HEADLESS) return; // keep running in headless mode
  // Fire-and-forget telemetry — don't await; delaying app.quit() causes SIGABRT on macOS
  const sessionSeconds = Math.round((Date.now() - sessionStartTime) / 1000);
  sendTelemetry(sessionSeconds);

  gracefulCleanup();
  app.quit();
});
