const { app, BrowserWindow, ipcMain, Menu, dialog, Notification, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// --- Headless mode: POTACAT --headless ---
// Runs the full app with a hidden window — no GUI shown.
// Useful for serving ECHOCAT from a headless server (e.g. Raspberry Pi).
// All features work: CAT, spots, FT8 engine, ECHOCAT, CW keyer.
const HEADLESS = process.argv.includes('--headless');

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
    // System tray icon — use .ico on Windows, .png on Mac/Linux
    const icoFile = process.platform === 'win32' ? 'icon.ico' : 'icon-256.png';
    const iconPath = path.join(__dirname, 'assets', icoFile);
    const { shell } = require('electron');
    const tray = new Tray(iconPath);
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
const { KenwoodCodec } = require('./lib/codecs/kenwood-codec');
const { RigctldCodec } = require('./lib/codecs/rigctld-codec');
const { CivCodec } = require('./lib/codecs/civ-codec');
const { getTuneQuirks } = require('./lib/rig-models');
const { gridToLatLon, haversineDistanceMiles, bearing } = require('./lib/grid');
const { freqToBand } = require('./lib/bands');
const { loadCtyDat, resolveCallsign, getAllEntities } = require('./lib/cty');
const { parseAdifFile, parseWorkedQsos, parseAllQsos, parseAllRawQsos, parseSqliteFile, parseSqliteConfirmed, isSqliteFile, parseRecord: parseAdifRecord } = require('./lib/adif');
const { DxClusterClient } = require('./lib/dxcluster');
const { RbnClient } = require('./lib/rbn');
const { appendQso, buildAdifRecord, appendImportedQso, appendRawQso, rewriteAdifFile, ADIF_HEADER, adifField } = require('./lib/adif-writer');
const { SmartSdrClient, setColorblindMode: setSmartSdrColorblind } = require('./lib/smartsdr');
const { TciClient, setTciColorblindMode } = require('./lib/tci');
const { AntennaGeniusClient } = require('./lib/antenna-genius');
const { IambicKeyer } = require('./lib/keyer');
const { parsePotaParksCSV } = require('./lib/pota-parks');
const { WsjtxClient, encodeHeartbeat, encodeLoggedAdif, encodeQsoLogged } = require('./lib/wsjtx');
const { PskrClient } = require('./lib/pskreporter');
const { Ft8Engine } = require('./lib/ft8-engine');
const { RemoteServer } = require('./lib/remote-server');
const { loadClubUsers, hashPasswords, hasPlaintextPasswords } = require('./lib/club-users');
const { createAuditLogger } = require('./lib/club-audit');
const { fetchSpots: fetchWwffSpots } = require('./lib/wwff');
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

// --- QRZ.com callsign lookup ---
let qrz = new QrzClient();

// --- Cloud Sync (initialized in app.whenReady) ---
let cloudIpc = null;

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
let jtcatPopoutWin = null;   // pop-out JTCAT window
let jtcatMapPopoutWin = null; // pop-out JTCAT map window
let popoutJtcatQso = null;   // QSO state for popout (like remoteJtcatQso for ECHOCAT)
let cat = null;
let spotTimer = null;
let solarTimer = null;
let rigctldProc = null;
let cluster = null; // legacy — replaced by clusterClients Map
let clusterSpots = []; // streaming DX cluster spots (FIFO, max 500)
let clusterFlushTimer = null; // throttle timer for cluster → renderer updates
let cwSpotsClients = new Map(); // club → DxClusterClient (one per checked club, or single for all)
let cwSpots = []; // streaming CW club spots (FIFO, max 500)
let cwSpotsFlushTimer = null; // throttle timer for CW spots → renderer updates
let rbn = null;
let rbnSpots = []; // streaming RBN spots (FIFO, max 500)
let rbnFlushTimer = null; // throttle timer for RBN → renderer updates
let rbnWatchSpots = []; // RBN spots for watchlist callsigns, merged into main table
let smartSdr = null;
let smartSdrPushTimer = null; // throttle timer for SmartSDR spot pushes
let tciClient = null;
let tciPushTimer = null; // throttle timer for TCI spot pushes
let agClient = null; // 4O3A Antenna Genius client
let agLastBand = null; // last band we switched to (avoid redundant commands)
let workedQsos = new Map(); // callsign → [{date, ref}] from QSO log (all QSOs, not just confirmed)
let workedParks = new Map(); // reference → park data from POTA parks CSV
let wsjtx = null;
let wsjtxStatus = null; // last Status message from WSJT-X
let wsjtxHighlightTimer = null; // throttle timer for highlight updates
let donorCallsigns = new Set(); // supporter callsigns from potacat.com
let expeditionCallsigns = new Set(); // active DX expeditions from Club Log + danplanet iCal
let expeditionMeta = new Map(); // callsign → { entity, startDate, endDate, description }
let activeEvents = [];                // events fetched from remote endpoint
const EVENTS_CACHE_PATH = path.join(app.getPath('userData'), 'events-cache.json');
let directoryNets = [];               // HF nets from community Google Sheet
let directorySwl = [];                // SWL broadcasts from community Google Sheet
const DIRECTORY_CACHE_PATH = path.join(app.getPath('userData'), 'directory-cache.json');
let pskr = null;
let pskrSpots = [];       // streaming PSKReporter FreeDV spots (FIFO, max 500)
let pskrFlushTimer = null; // throttle timer for PSKReporter → renderer updates
let pskrMap = null;            // PskrClient for dedicated PSKReporter Map view
let pskrMapSpots = [];         // receiver spots for PSKReporter Map (FIFO, max 500)
let pskrMapFlushTimer = null;  // throttle timer for PSKReporter Map → renderer
let keyer = null;          // IambicKeyer instance for CW MIDI keying
let remoteServer = null;   // RemoteServer instance for phone remote access
let cwKeyPort = null;      // Dedicated SerialPort for DTR CW keying (external USB-serial adapter)
let remoteAudioWin = null; // hidden BrowserWindow for WebRTC audio bridge
let _currentFreqHz = 0;    // tracked for remote radio status
let _currentMode = '';
let _remoteTxState = false;
let _currentNbState = false;
let _currentSmeter = 0;
let _currentAtuState = false;
let _currentVfo = 'A';
let _currentFilterWidth = 0;
let _currentRfGain = 0;
let _currentTxPower = 0; // 0 = unknown until radio reports actual power
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
  if (target.type === 'icom') return 'icom';
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
const recentNotifications = new Map(); // callsign → timestamp for dedup (5-min window)

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
    if (target.dtrOff) args.push('--set-conf=dtr_state=OFF,rts_state=OFF');
    if (target.verbose) args.push('-vvvv');

    if (!portOverride) killRigctld();
    rigctldStderr = '';

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
  _currentFreqHz = hz;
  broadcastRemoteRadioStatus();
}

function sendCatMode(mode) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-mode', mode);
  _currentMode = mode;
  // Mode confirmed by radio — clear suppress so ECHOCAT gets the real value
  _modeSuppressUntil = 0;
  broadcastRigState();
}

function sendCatPower(watts) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-power', watts);
  _currentTxPower = watts;
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
  _currentSmeter = val;
  if (remoteServer && remoteServer.running) remoteServer.sendToClient({ type: 'smeter', value: val });
}

function sendCatSwr(val) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-swr', val);
  if (remoteServer && remoteServer.running) remoteServer.sendToClient({ type: 'swr', value: val });
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
  sendCatLog(`Rotor → ${host}:${port} azimuth=${azimuth}°`);
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
    sendCatLog(`Connecting to Icom on ${target.path}`);
    transport.connect({ path: target.path, baudRate: target.baudRate || 19200, dtrOff: target.dtrOff });

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
    sendCatLog(`Connecting to ${model.brand || 'radio'} on ${target.path}`);
    transport.connect({ path: target.path, baudRate: target.baudRate || 9600, dtrOff: target.dtrOff, connectDelay: model.connectDelay });
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

let clusterClients = new Map(); // id → { client, nodeConfig }

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

  if (!settings.enableCluster || !settings.myCallsign) {
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
  if (!settings.enableCwSpots || !settings.myCallsign) return;
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
}

function connectRbn() {
  if (rbn) {
    rbn.disconnect();
    rbn.removeAllListeners();
    rbn = null;
  }
  rbnSpots = [];

  if (!settings.enableRbn || !settings.myCallsign) {
    sendRbnStatus({ connected: false });
    return;
  }

  rbn = new RbnClient();
  const myPos = gridToLatLon(settings.grid);

  rbn.on('spot', (raw) => {
    // Strip skimmer suffix (e.g. KM3T-# → KM3T)
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

  if (!settings.enablePskr) {
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

// --- PSKReporter Map view ---
function sendPskrMapStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('pskr-map-status', s);
}

function sendPskrMapSpots() {
  if (win && !win.isDestroyed()) win.webContents.send('pskr-map-spots', pskrMapSpots);
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
async function saveQsoRecord(qsoData) {
  // Inject operator callsign from settings
  if (settings.myCallsign && !qsoData.operator) {
    qsoData.operator = settings.myCallsign.toUpperCase();
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
    if (win && !win.isDestroyed()) {
      win.webContents.send('worked-qsos', [...workedQsos.entries()]);
    }
    if (remoteServer && remoteServer.running) {
      remoteServer.sendWorkedQsos([...workedQsos.entries()]);
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

  // Forward to external logbook if enabled
  // skipLogbookForward: multi-park activations send one ADIF record per park ref,
  // but external logbooks only need one QSO per physical contact
  if (settings.sendToLogbook && settings.logbookType && !qsoData.skipLogbookForward) {
    try {
      sendCatLog(`[Logbook] Forwarding QSO to ${settings.logbookType}: ${qsoData.callsign} ${qsoData.frequency}kHz ${qsoData.mode}`);
      await forwardToLogbook(qsoData);
      sendCatLog(`[Logbook] QSO forwarded successfully`);
    } catch (fwdErr) {
      sendCatLog(`[Logbook] Forwarding failed: ${fwdErr.message}`);
      console.error('Logbook forwarding failed:', fwdErr.message);
      return { success: true, logbookError: fwdErr.message };
    }
  }

  // Upload to QRZ Logbook if enabled (independent of logbook forwarding)
  if (settings.qrzLogbook && settings.qrzApiKey && !qsoData.skipLogbookForward) {
    try {
      await sendToQrzLogbook(qsoData);
    } catch (qrzErr) {
      console.error('QRZ Logbook upload failed:', qrzErr.message);
      return { success: true, qrzError: qrzErr.message };
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
  return { success: true, resposted: didRespot || false };
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
          if (i > 0) parkQso.skipLogbookForward = true; // only forward first record
          allQsoData.push(parkQso);
          await saveQsoRecord(parkQso);
        }
        // Cross-program references (WWFF, LLOTA for same park)
        const crossRefs = (settings.activatorCrossRefs || []).filter(xr => xr && xr.ref);
        for (const xr of crossRefs) {
          const xrQso = { ...qsoData, mySig: xr.program.toUpperCase(), mySigInfo: xr.ref, myGridsquare: settings.grid || '', skipLogbookForward: true };
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
let ft8Engine = null;
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
  const parts = (text || '').toUpperCase().split(/\s+/);
  // CQ [MODIFIER] CALLSIGN GRID — modifier is optional (POTA, SOTA, DX, etc.)
  let callIdx = 1;
  if (parts.length > 3 && parts[1].length <= 5 && !/[0-9]/.test(parts[1])) callIdx = 2;
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
  if (ft8Engine) await ft8Engine.setTxMessage(msg);
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
    rstSent: q.sentReport || '-00',
    rstRcvd: q.report || '-00',
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
        if (i > 0) parkQso.skipLogbookForward = true;
        await saveQsoRecord(parkQso);
      }
      // Cross-program refs (WWFF, LLOTA)
      const crossRefs = (settings.activatorCrossRefs || []).filter(xr => xr && xr.ref);
      for (const xr of crossRefs) {
        const xrQso = { ...qsoData, mySig: (xr.program || 'WWFF').toUpperCase(), mySigInfo: xr.ref, myGridsquare: settings.grid || '', skipLogbookForward: true };
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
function advanceJtcatQso(q, results, setTxMsg, onDone) {
  if (!q || q.phase === 'done' || q.phase === 'idle') return;
  const myCall = q.myCall;

  if (q.mode === 'cq') {
    // Final courtesy TX: wait one decode cycle so the RR73 has a chance to transmit
    if (q.phase === 'cq-rr73') {
      if (!q._courtesySent) {
        q._courtesySent = true;
        return; // first decode in this phase — TX boundary hasn't fired yet
      }
      q.phase = 'done';
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      ft8Engine.setTxSlot('auto');
      return;
    }

    if (q.phase === 'cq') {
      const reply = results.find(d => {
        const t = (d.text || '').toUpperCase();
        return t.indexOf(myCall) >= 0 && !t.startsWith('CQ ');
      });
      if (!reply) return;
      const m = (reply.text || '').toUpperCase().match(new RegExp(myCall.replace(/[/]/g, '\\/') + '\\s+([A-Z0-9/]+)\\s+([A-R]{2}\\d{2})', 'i'));
      if (!m) return;
      q.call = m[1]; q.grid = m[2];
      const dbRounded = Math.round(reply.db);
      const rpt = dbRounded >= 0 ? '+' + String(dbRounded).padStart(2, '0') : '-' + String(Math.abs(dbRounded)).padStart(2, '0');
      q.sentReport = rpt;
      q.txMsg = q.call + ' ' + myCall + ' ' + rpt;
      q.phase = 'cq-report';
      ft8Engine.setRxFreq(reply.df);
      setTxMsg(q.txMsg);
    } else if (q.phase === 'cq-report') {
      const resp = results.find(d => { const t = (d.text || '').toUpperCase(); return t.indexOf(myCall) >= 0 && t.indexOf(q.call) >= 0; });
      if (!resp) { return; }
      const rptM = (resp.text || '').toUpperCase().match(/R([+-]\d{2})/);
      if (!rptM) {
        q._heardThisCycle = true; // they responded but haven't sent R+report yet
        return;
      }
      q.report = rptM[1];
      q.txMsg = q.call + ' ' + myCall + ' RR73';
      q.phase = 'cq-rr73';
      setTxMsg(q.txMsg);
      // QSO confirmed — both reports exchanged. Log now, send RR73 as courtesy.
      onDone();
    }
  } else {
    // Reply mode
    const theirCall = q.call;

    // Final courtesy TX: wait one decode cycle so the 73 has a chance to transmit
    if (q.phase === '73') {
      if (!q._courtesySent) {
        q._courtesySent = true;
        return; // first decode in this phase — TX boundary hasn't fired yet
      }
      q.phase = 'done';
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      ft8Engine.setTxSlot('auto');
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
      return;
    }

    const resp = results.find(d => { const t = (d.text || '').toUpperCase(); return t.indexOf(myCall) >= 0 && t.indexOf(theirCall) >= 0; });
    if (!resp) return;
    const text = (resp.text || '').toUpperCase();
    if (q.phase === 'reply') {
      const rptM = text.match(/[R]?([+-]\d{2})/);
      if (!rptM) return;
      q.report = rptM[1];
      const dbRounded = Math.round(resp.db);
      const ourRpt = dbRounded >= 0 ? '+' + String(dbRounded).padStart(2, '0') : '-' + String(Math.abs(dbRounded)).padStart(2, '0');
      q.sentReport = ourRpt;
      if (text.indexOf('R' + rptM[1]) >= 0 || text.indexOf('R+') >= 0 || text.indexOf('R-') >= 0) {
        // They sent R+report — both reports exchanged. Send RR73, log now.
        q.txMsg = theirCall + ' ' + myCall + ' RR73'; q.phase = '73';
        setTxMsg(q.txMsg);
        onDone();
      } else {
        q.txMsg = theirCall + ' ' + myCall + ' R' + ourRpt; q.phase = 'r+report';
        setTxMsg(q.txMsg);
      }
    } else if (q.phase === 'r+report') {
      if (text.indexOf('RR73') >= 0 || text.indexOf('RRR') >= 0 || text.indexOf(' 73') >= 0) {
        // They confirmed — QSO complete. Send 73 as courtesy, log now.
        q.txMsg = theirCall + ' ' + myCall + ' 73'; q.phase = '73';
        setTxMsg(q.txMsg);
        onDone();
      } else {
        // They're still responding (e.g. repeating report) — mark as heard so retries don't expire
        q._heardThisCycle = true;
      }
    }
  }
}

// Server-side QSO state machine wrappers
function processRemoteJtcatQso(results) {
  const qso = remoteJtcatQso; // capture reference — don't rely on global in callbacks
  advanceJtcatQso(qso, results, remoteJtcatSetTxMsg, () => {
    jtcatAutoLog(qso); // use captured ref, not global
    remoteJtcatBroadcastQso();
  });
}

function processPopoutJtcatQso(results) {
  const qso = popoutJtcatQso; // capture reference — don't rely on global in callbacks
  advanceJtcatQso(qso, results, (msg) => {
    if (ft8Engine) ft8Engine.setTxMessage(msg);
    popoutBroadcastQso();
  }, () => {
    jtcatAutoLog(qso); // use captured ref, not global (global may be replaced by auto-CQ)
    popoutBroadcastQso();
  });
}

function startJtcat(mode) {
  stopJtcat();
  jtcatAutoCqMode = 'off';
  jtcatAutoCqWorkedSession.clear();
  jtcatAutoCqOwner = null;
  ft8Engine = new Ft8Engine();
  ft8Engine.setMode(mode || 'FT8');

  ft8Engine.on('decode', async (data) => {
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
      remoteServer.broadcastJtcatDecode({ ...data, time: timeStr });
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

function stopJtcat() {
  if (ft8Engine) {
    ft8Engine.stop();
    ft8Engine.removeAllListeners();
    ft8Engine = null;
    console.log('[JTCAT] Engine stopped');
  }
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
  smartSdr.on('error', (err) => {
    console.error('SmartSDR:', err.message);
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
  // Use SmartSDR host if configured, else fall back to Flex CAT host, else localhost
  const sdrHost = settings.smartSdrHost || (settings.catTarget && settings.catTarget.host) || '127.0.0.1';
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
  sendCatLog(`[AG] Band ${band} → antenna ${antenna} (port ${radioPort === 1 ? 'A' : 'B'})`);
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
    customCatButtons: settings.customCatButtons || null,
  });
}

// --- CW Key Port (dedicated DTR keying via external USB-serial adapter) ---
function connectCwKeyPort() {
  disconnectCwKeyPort();
  // CW key port for external DTR keying
  const portPath = settings.cwKeyPort;
  if (!portPath) return;
  const { SerialPort } = require('serialport');
  const port = new SerialPort({
    path: portPath,
    baudRate: 38400, // CDC-ACM ignores baud, but match QMX default just in case
    autoOpen: false,
    rtscts: false,
    hupcl: false,
  });
  cwKeyPort = port;
  port._dtrFailed = false; // reset DTR fallback flag on fresh connection
  port.on('open', () => {
    // Force DTR low initially (key up), RTS low too
    port.set({ dtr: false, rts: false }, () => {});
    console.log(`[CW Key Port] Opened ${portPath} for DTR keying`);
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
  if (cwKeyPort) {
    // Force key up before closing
    try { cwKeyPort.set({ dtr: false }, () => {}); } catch {}
    if (cwKeyPort.isOpen) cwKeyPort.close();
    cwKeyPort = null;
  }
}

function connectRemote() {
  disconnectRemote();
  if (!settings.enableRemote) return;

  remoteServer = new RemoteServer();
  if (settings.colorblindMode) remoteServer.setColorblindMode(true);

  remoteServer.on('tune', ({ freqKhz, mode, bearing }) => {
    console.log('[Echo CAT] Tune request:', freqKhz, 'kHz, mode:', mode || '(keep)');
    // Only clear XIT for manual freq entry (no mode); apply CW XIT for spot clicks
    tuneRadio(freqKhz, mode, bearing, { clearXit: !mode });
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
    // Safety: always force RX on disconnect regardless of tracked PTT state
    // (prevents stuck TX from race conditions, VOX triggering, or stale state)
    handleRemotePtt(false);
    // CW safety: ensure PTT released on disconnect (keyer.stop() is handled in RemoteServer)
    if (detectRigType() === 'flex' && smartSdr && smartSdr.connected) {
      smartSdr.cwPttRelease();
    }
    // Icom: force key up on disconnect — both DTR and TX/RX methods
    if (detectRigType() === 'icom' && cat && cat.connected) {
      cat.setCwKeyDtr(false);
      cat.setCwKeyTxRx(false);
    }
    // Yaesu/Kenwood: force TX/RX key up on disconnect
    if ((detectRigType() === 'yaesu' || detectRigType() === 'kenwood') && cat && cat.connected) {
      cat.setCwKeyTxRx(false);
    }
    // Force CW key port DTR low (key up) on disconnect
    if (cwKeyPort && cwKeyPort.isOpen) {
      cwKeyPort.set({ dtr: false }, () => {});
    }
    // Destroy audio window to stop all outgoing audio (prevents VOX re-trigger)
    destroyRemoteAudioWindow();
    // Delayed safety TX-off: VOX on some radios (e.g. IC-7300 USB audio) can re-trigger
    // from audio artifacts when the WebRTC stream closes. Send TX-off again after a short
    // delay to catch any VOX re-key that happened during audio teardown.
    setTimeout(() => {
      if (cat && cat.connected) cat.setTransmit(false);
      if (smartSdr && smartSdr.connected) smartSdr.setTransmit(false);
    }, 500);
    // Safety: disable JTCAT TX if phone was driving a QSO
    if (ft8Engine && remoteJtcatQso) {
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      if (ft8Engine._txActive) ft8Engine.txComplete();
      console.log('[JTCAT] Phone disconnected — TX disabled, QSO cleared');
    }
    remoteJtcatQso = null;
  });

  // CW keyer output: route IambicKeyer key events to radio
  let _cwPollResumeTimer = null;
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
      // Route keying based on model's preferred paddle method
      // Icom default: txrx (CI-V PTT 0x1C) — universal, no DTR config needed
      // Models with DTR keying support can override via cw.paddleKey: 'dtr'
      const paddleMethod = cwCaps.paddleKey || 'txrx';
      if (paddleMethod === 'dtr') {
        // If dedicated CW Key Port handles DTR, skip DTR on main CAT port
        // (QMX/IC-705 CAT ports don't support DTR on Linux CDC-ACM)
        if (!(cwKeyPort && cwKeyPort.isOpen)) {
          cat.setCwKeyDtr(down, cwCaps.dtrPins);
        }
      } else if (paddleMethod === 'ta' && cwCaps.taKey) {
        cat.setCwKeyTa(down);
      } else {
        cat.setCwKeyTxRx(down);
      }
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
    // Substitute macros
    const expanded = text.replace(/\{MYCALL\}/gi, settings.myCallsign || '')
      .replace(/\{mycallsign\}/gi, settings.myCallsign || '');
    console.log(`[Echo CAT] CW text: ${expanded}`);
    // FlexRadio: use SmartSDR `cw send` command
    if (detectRigType() === 'flex' && smartSdr && smartSdr.connected) {
      smartSdr.sendCwText(expanded);
    }
    // Serial CAT (Kenwood/Yaesu/Icom): use KY or CI-V 0x17 command
    if (cat && cat.connected) {
      cat.sendCwText(expanded);
    }
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

  // Enable remote CW if setting is on
  if (settings.remoteCwEnabled) {
    remoteServer.setCwEnabled(true);
    if (smartSdr) smartSdr.setNeedsCw(true);
  }

  // Open dedicated CW Key Port if configured
  if (settings.cwKeyPort) {
    connectCwKeyPort();
  }

  remoteServer.on('set-sources', (sources) => {
    if (!sources) return;
    const map = { pota: 'enablePota', sota: 'enableSota', wwff: 'enableWwff', llota: 'enableLlota', cluster: 'enableCluster' };
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
    console.log('[Echo CAT] Filter step:', direction, '→', presets[idx], 'Hz');
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
    console.log('[Echo CAT] Swap VFO →', newVfo);
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
      remoteServer.sendToClient({ type: 'qrz-result', callsign, fname: '' });
      return;
    }
    try {
      const data = await qrz.lookup(callsign);
      const fname = data ? (data.nickname || data.fname || '') : '';
      remoteServer.sendToClient({ type: 'qrz-result', callsign, fname });
    } catch {
      remoteServer.sendToClient({ type: 'qrz-result', callsign, fname: '' });
    }
  });

  // Unified rig-control from ECHOCAT phone (same dispatch as desktop IPC)
  remoteServer.on('rig-control', (data) => {
    if (!data || !data.action) return;
    const rigType = detectRigType();
    switch (data.action) {
      case 'set-nb': {
        const on = !!data.value;
        if (flexSdr()) smartSdr.setSliceNb(0, on);
        else if (cat && cat.connected) cat.setNb(on);
        _currentNbState = on;
        broadcastRigState();
        break;
      }
      case 'atu-tune':
        if (flexSdr()) smartSdr.setAtu(true);
        else if (cat && cat.connected) cat.startTune();
        _currentAtuState = true;
        broadcastRigState();
        break;
      case 'power-on':
        // Power-on: radio may be off, so don't require cat.connected — just need transport open
        if (cat && rigType !== 'flex') cat.setPowerState(true);
        break;
      case 'power-off':
        if (cat && cat.connected && rigType !== 'flex') cat.setPowerState(false);
        break;
      case 'set-rf-gain': {
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
    console.log('[Echo CAT] Refresh interval →', val, 's');
  });

  remoteServer.on('set-mode', ({ mode }) => {
    if (!mode) return;
    if (!_currentFreqHz) {
      console.log('[Echo CAT] Set mode ignored — no frequency from radio yet');
      return;
    }
    console.log('[Echo CAT] Set mode →', mode);
    // Reset rate limiter so mode-only change goes through
    _lastTuneFreq = 0;
    tuneRadio(_currentFreqHz / 1000, mode);
  });

  remoteServer.on('toggle-rotor', ({ enabled }) => {
    settings.rotorActive = enabled;
    saveSettings(settings);
    updateRemoteSettings(); // push updated state back to phone
    console.log('[Echo CAT] Rotor →', enabled ? 'ON' : 'OFF');
  });

  remoteServer.on('set-scan-dwell', ({ value }) => {
    const val = Math.max(1, parseInt(value, 10) || 7);
    settings.scanDwell = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] Scan dwell →', val, 's');
  });

  remoteServer.on('set-max-age', ({ value }) => {
    const val = Math.max(1, parseInt(value, 10) || 5);
    settings.maxAgeMin = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] Max spot age →', val, 'm');
  });

  remoteServer.on('set-dist-unit', ({ value }) => {
    if (value === 'mi' || value === 'km') {
      settings.distUnit = value;
      saveSettings(settings);
      updateRemoteSettings();
      console.log('[Echo CAT] Distance unit →', value);
    }
  });

  remoteServer.on('set-cw-xit', ({ value }) => {
    const val = Math.max(-999, Math.min(999, parseInt(value, 10) || 0));
    settings.cwXit = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] CW XIT →', val, 'Hz');
  });

  remoteServer.on('set-cw-filter', ({ value }) => {
    const val = Math.max(0, Math.min(3000, parseInt(value, 10) || 0));
    settings.cwFilterWidth = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] CW Filter →', val, 'Hz');
  });

  remoteServer.on('set-ssb-filter', ({ value }) => {
    const val = Math.max(0, Math.min(4000, parseInt(value, 10) || 0));
    settings.ssbFilterWidth = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] SSB Filter →', val, 'Hz');
  });

  remoteServer.on('set-digital-filter', ({ value }) => {
    const val = Math.max(0, Math.min(5000, parseInt(value, 10) || 0));
    settings.digitalFilterWidth = val;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] Digital Filter →', val, 'Hz');
  });

  remoteServer.on('set-enable-split', ({ value }) => {
    settings.enableSplit = !!value;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] Split →', value ? 'ON' : 'OFF');
  });

  remoteServer.on('set-enable-atu', ({ value }) => {
    settings.enableAtu = !!value;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] ATU Auto →', value ? 'ON' : 'OFF');
  });

  remoteServer.on('set-tune-click', ({ value }) => {
    settings.tuneClick = !!value;
    saveSettings(settings);
    updateRemoteSettings();
    console.log('[Echo CAT] Tune Click →', value ? 'ON' : 'OFF');
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
      const contactData = {
        callsign: qsoData.callsign,
        timeUtc: qsoTime,
        freqKhz: String(freqKhz),
        mode: qsoData.mode,
        band,
        rstSent: qsoData.rstSent,
        rstRcvd: qsoData.rstRcvd,
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
    startJtcat(mode);
    // Start audio capture in desktop renderer
    if (win && !win.isDestroyed()) win.webContents.send('jtcat-start-for-remote');
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
    ft8Engine._txEnabled = true;
    await remoteJtcatSetTxMsg(txMsg);
    ft8Engine.tryImmediateTx();
    console.log('[JTCAT Remote] CQ:', txMsg, '@ quiet freq', jtcatQuietFreq, 'Hz slot:', nextSlot);
  });

  remoteServer.on('jtcat-reply', async ({ call, grid, df, slot }) => {
    if (!ft8Engine) return;
    const myCall = remoteJtcatMyCall();
    const myGrid = remoteJtcatMyGrid();
    if (!myCall) return;
    // If replacing an active QSO that had reports exchanged but wasn't logged yet, log it
    if (remoteJtcatQso && remoteJtcatQso.call && remoteJtcatQso.report &&
        remoteJtcatQso.phase !== '73' && remoteJtcatQso.phase !== 'done' &&
        remoteJtcatQso.call.toUpperCase() !== (call || '').toUpperCase()) {
      sendCatLog(`[JTCAT] Replacing active QSO with ${remoteJtcatQso.call} — auto-logging`);
      jtcatAutoLog(remoteJtcatQso);
    }
    // Halt any active TX (e.g. CQ) so reply goes out on next boundary
    if (ft8Engine._txActive) ft8Engine.txComplete();
    const txMsg = call + ' ' + myCall + ' ' + myGrid;
    ft8Engine.setTxFreq(df);
    ft8Engine.setRxFreq(df);
    // TX on opposite slot from the station we're replying to (use slot from decode data)
    const targetSlot = slot || ft8Engine._lastRxSlot;
    ft8Engine.setTxSlot(targetSlot === 'even' ? 'odd' : (targetSlot === 'odd' ? 'even' : 'auto'));
    remoteJtcatQso = { mode: 'reply', call, grid, phase: 'reply', txMsg, report: null, sentReport: null, myCall, myGrid, txRetries: 0 };
    ft8Engine._txEnabled = true;
    await remoteJtcatSetTxMsg(txMsg);
    ft8Engine.tryImmediateTx();
    console.log('[JTCAT Remote] Reply to', call, ':', txMsg, 'slot:', ft8Engine._txSlot);
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
    if (ft8Engine) {
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      if (ft8Engine._txActive) ft8Engine.txComplete();
    }
    remoteJtcatQso = null;
    remoteJtcatBroadcastQso();
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

  remoteServer.on('jtcat-skip-phase', () => {
    if (!remoteJtcatQso || remoteJtcatQso.phase === 'done' || remoteJtcatQso.phase === 'idle') return;
    const q = remoteJtcatQso;
    const myCall = q.myCall;
    if (q.mode === 'cq') {
      if (q.phase === 'cq-report') {
        q.txMsg = q.call + ' ' + myCall + ' RR73';
        q.phase = 'cq-rr73';
      } else if (q.phase === 'cq-rr73') {
        q.phase = 'done';
        ft8Engine._txEnabled = false;
        ft8Engine.setTxMessage('');
        ft8Engine.setTxSlot('auto');
      }
    } else {
      if (q.phase === 'reply') {
        const rpt = q.sentReport || '-10';
        q.txMsg = q.call + ' ' + myCall + ' R' + rpt;
        q.phase = 'r+report';
      } else if (q.phase === 'r+report') {
        q.txMsg = q.call + ' ' + myCall + ' RR73';
        q.phase = '73';
      } else if (q.phase === '73') {
        q.phase = 'done';
        ft8Engine._txEnabled = false;
        ft8Engine.setTxMessage('');
        ft8Engine.setTxSlot('auto');
      }
    }
    q.txRetries = 0;
    if (q.txMsg && q.phase !== 'done') {
      remoteJtcatSetTxMsg(q.txMsg);
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
  const requireToken = settings.remoteRequireToken !== false;
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

function handleRemotePtt(state) {
  const target = settings.catTarget;
  const isFlexRig = target && target.type === 'tcp';
  if (isFlexRig) {
    // FlexRadio: use SmartSDR xmit command (voice PTT, not CW PTT)
    if (smartSdr && smartSdr.connected) {
      smartSdr.setTransmit(state);
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

  _remoteTxState = state;

  // Broadcast to desktop UI
  if (win && !win.isDestroyed()) {
    win.webContents.send('remote-tx-state', state);
  }
  // Broadcast to phone
  broadcastRemoteRadioStatus();
}

function broadcastRemoteRadioStatus() {
  if (!remoteServer || !remoteServer.running) return;
  const rigType = detectRigType();
  const now = Date.now();
  // Suppress rfgain/txpower echo-back to ECHOCAT while user is actively adjusting
  const rfg = (typeof _rfGainSuppressBroadcast !== 'undefined' && now < _rfGainSuppressBroadcast) ? undefined : _currentRfGain;
  const txp = (typeof _txPowerSuppressBroadcast !== 'undefined' && now < _txPowerSuppressBroadcast) ? undefined : _currentTxPower;
  // Suppress stale mode during tune transition — phone has optimistic update, don't overwrite with old mode
  const modeVal = (now < _modeSuppressUntil) ? undefined : (_currentMode || '');
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
    });
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
  if (smartSdr) {
    if (smartSdr.connected) smartSdr.cwStop();
    smartSdr.setNeedsCw(false);
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('cw-keyer-status', { enabled: false });
  }
}

// --- Solar data ---
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
        if (win && !win.isDestroyed()) win.webContents.send('solar-data', data);
      }
    });
  });
  req.on('error', () => { /* silently ignore — pills keep last known values */ });
}

// --- Spot processing ---
function processPotaSpots(raw) {
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
    };
  });
  // Dedupe: keep latest spot per callsign+band (allows multi-band activations)
  const seen = new Map();
  for (const s of all) { seen.set(s.callsign + '_' + s.band, s); }
  return [...seen.values()];
}

async function processSotaSpots(raw) {
  const myPos = gridToLatLon(settings.grid);

  // Batch-fetch summit coordinates (cached across refreshes)
  await fetchSummitCoordsBatch(raw);

  const all = raw.filter((s) => {
    // Skip spots with no frequency (pre-announced activations with no QRG)
    const f = parseFloat(s.frequency);
    return !isNaN(f) && f > 0;
  }).map((s) => {
    const freqMHz = parseFloat(s.frequency);
    const freqKHz = Math.round(freqMHz * 1000); // SOTA gives MHz → convert to kHz
    const assoc = s.associationCode || '';
    const code = s.summitCode || '';
    const ref = assoc && code ? assoc + '/' + code : '';

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
      parkName: s.summitDetails || '',
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

function sendMergedSpots() {
  if (!win || win.isDestroyed()) return;
  const netSpots = getActiveNetSpots();
  const merged = [...netSpots, ...lastPotaSotaSpots, ...clusterSpots, ...cwSpots, ...rbnWatchSpots, ...pskrSpots];
  win.webContents.send('spots', merged);
  pushSpotsToSmartSdr(merged);
  pushSpotsToTci(merged);
  // Forward to ECHOCAT — all modes (phone-side Mode dropdown handles filtering), respect max spot age
  if (remoteServer && remoteServer.running) {
    const maxAgeMs = ((settings.maxAgeMin != null ? settings.maxAgeMin : 5) * 60000) || 300000;
    const now = Date.now();
    const echoSpots = merged.filter(s => {
      // Net spots always pass through to ECHOCAT
      if (s.source === 'net') return true;
      // Age filter
      if (s.spotTime) {
        const t = s.spotTime.endsWith('Z') ? s.spotTime : s.spotTime + 'Z';
        const age = now - new Date(t).getTime();
        if (age > maxAgeMs) return false;
      }
      return true;
    });
    remoteServer.broadcastSpots(echoSpots);
  }
  // Forward to spots pop-out if open
  if (spotsPopoutWin && !spotsPopoutWin.isDestroyed()) {
    spotsPopoutWin.webContents.send('spots-popout-data', merged);
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
      }
    }).catch(() => { /* ignore QRZ errors */ });
  }
}

async function refreshSpots() {
  try {
    const enablePota = settings.enablePota !== false; // default true
    const enableSota = settings.enableSota === true;  // default false
    const enableWwff = settings.enableWwff === true;   // default false
    const enableLlota = settings.enableLlota === true; // default false

    const fetches = [];
    if (enablePota) fetches.push(fetchPotaSpots().then(processPotaSpots));
    if (enableSota) fetches.push(fetchSotaSpots().then(processSotaSpots));
    if (enableWwff) fetches.push(fetchWwffSpots().then(processWwffSpots));
    if (enableLlota) fetches.push(fetchLlotaSpots().then(processLlotaSpots));

    const results = await Promise.allSettled(fetches);
    const allSpots = results
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    // Cross-reference POTA ↔ WWFF: same callsign + same frequency = dual-park
    const potaSpots = allSpots.filter(s => s.source === 'pota');
    const wwffSpots = allSpots.filter(s => s.source === 'wwff');
    const otherSpots = allSpots.filter(s => s.source !== 'pota' && s.source !== 'wwff');

    if (wwffSpots.length > 0 && potaSpots.length > 0) {
      const wwffMap = new Map();
      for (const w of wwffSpots) {
        const key = w.callsign.toUpperCase() + '_' + String(Math.round(parseFloat(w.frequency)));
        wwffMap.set(key, w);
      }
      const matchedWwffKeys = new Set();
      for (const p of potaSpots) {
        const key = p.callsign.toUpperCase() + '_' + String(Math.round(parseFloat(p.frequency)));
        const match = wwffMap.get(key);
        if (match) {
          p.wwffReference = match.reference;
          p.wwffParkName = match.parkName;
          matchedWwffKeys.add(key);
        }
      }
      // Only keep unmatched WWFF spots as standalone rows
      const unmatchedWwff = wwffSpots.filter(w => {
        const key = w.callsign.toUpperCase() + '_' + String(Math.round(parseFloat(w.frequency)));
        return !matchedWwffKeys.has(key);
      });
      lastPotaSotaSpots = [...potaSpots, ...otherSpots, ...unmatchedWwff];
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

    // Build confirmation map: entityIndex → { band → Set<mode> }
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
}

// --- Worked parks tracking ---

// Supplemental file for parks worked via POTACAT (persists across restarts)
const WORKED_PARKS_LOCAL_PATH = path.join(app.getPath('userData'), 'worked-parks-local.json');

function loadLocalWorkedParks() {
  try {
    if (fs.existsSync(WORKED_PARKS_LOCAL_PATH)) {
      const data = JSON.parse(fs.readFileSync(WORKED_PARKS_LOCAL_PATH, 'utf-8'));
      return Array.isArray(data) ? data : [];
    }
  } catch {}
  return [];
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
  if (!settings.potaParksPath) {
    workedParks = new Map();
  } else {
    try {
      workedParks = parsePotaParksCSV(settings.potaParksPath);
    } catch (err) {
      console.error('Failed to parse POTA parks CSV:', err.message);
      workedParks = new Map();
    }
  }
  // Merge in parks worked via POTACAT's own logger (persisted locally)
  const localParks = loadLocalWorkedParks();
  for (const ref of localParks) {
    if (!workedParks.has(ref)) {
      workedParks.set(ref, { reference: ref });
    }
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('worked-parks', [...workedParks.entries()]);
  }
  if (remoteServer && remoteServer.running) {
    remoteServer.sendWorkedParks([...workedParks.keys()]);
  }
}

// --- HamRS bridge (WSJT-X binary protocol) ---
// HamRS expects WSJT-X binary UDP messages, not plain ADIF text.
// We send periodic heartbeats so HamRS shows "connected", and Logged ADIF (type 12) for QSOs.
const hamrsBridge = {
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
      console.error('[HamRS] UDP error:', err.message);
    });
    // Send heartbeat immediately, then every 15 seconds
    this._sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), 15000);
    console.log(`[HamRS] Bridge started → ${this.host}:${this.port}`);
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
        reject(new Error('HamRS bridge not started'));
        return;
      }
      const freqHz = Math.round((parseFloat(qsoData.frequency) || 0) * 1000);
      sendCatLog(`[HamRS] Sending QSO: ${qsoData.callsign} ${freqHz}Hz ${qsoData.mode} → ${this.host}:${this.port}`);

      // Build proper Date objects from qsoData date/time fields
      let dateTimeOff;
      if (qsoData.qsoDate) {
        const d = qsoData.qsoDate; // YYYYMMDD
        const t = qsoData.timeOn || '0000'; // HHMM or HHMMSS
        dateTimeOff = new Date(Date.UTC(
          parseInt(d.slice(0, 4), 10), parseInt(d.slice(4, 6), 10) - 1, parseInt(d.slice(6, 8), 10),
          parseInt(t.slice(0, 2), 10), parseInt(t.slice(2, 4), 10), t.length >= 6 ? parseInt(t.slice(4, 6), 10) : 0
        ));
      }

      // Send QSO_LOGGED (type 5) — the primary message most apps listen for
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
      });
      this.socket.send(qsoMsg, 0, qsoMsg.length, this.port, this.host, (err) => {
        if (err) sendCatLog(`[HamRS] QSO_LOGGED send error: ${err.message}`);
        else sendCatLog(`[HamRS] QSO_LOGGED (type 5) sent (${qsoMsg.length} bytes)`);
      });

      // Also send LOGGED_ADIF (type 12) as supplementary
      const adifBuf = encodeLoggedAdif(this.id, adifText);
      this.socket.send(adifBuf, 0, adifBuf.length, this.port, this.host, (err) => {
        if (err) {
          sendCatLog(`[HamRS] LOGGED_ADIF send error: ${err.message}`);
          reject(err);
        } else {
          sendCatLog(`[HamRS] LOGGED_ADIF (type 12) sent (${adifBuf.length} bytes)`);
          resolve();
        }
      });
    });
  },
};

// --- Logbook forwarding ---

/**
 * Convert raw ADIF fields (uppercase keys from parseAllRawQsos) to the
 * qsoData format that buildAdifRecord() / forwardToLogbook() expect.
 */
function rawQsoToQsoData(raw) {
  const freqMhz = parseFloat(raw.FREQ || '0');
  return {
    callsign: raw.CALL || '',
    frequency: (freqMhz * 1000).toFixed(1), // MHz → kHz
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
    saveSettings(settings);
    if (popoutWin && !popoutWin.isDestroyed()) popoutWin.close();
    if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) qsoPopoutWin.close();
    if (spotsPopoutWin && !spotsPopoutWin.isDestroyed()) spotsPopoutWin.close();
    if (clusterPopoutWin && !clusterPopoutWin.isDestroyed()) clusterPopoutWin.close();
    if (actmapPopoutWin && !actmapPopoutWin.isDestroyed()) actmapPopoutWin.close();
    if (remoteAudioWin && !remoteAudioWin.isDestroyed()) remoteAudioWin.close();
  });

  // Once the renderer is actually ready to listen, send current state
  win.webContents.on('did-finish-load', () => {
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
  });
}

// --- Donor list ---
function fetchDonorList() {
  const https = require('https');
  const req = https.get('https://donors.potacat.com/d/a7f3e9b1c4d2', (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const arr = JSON.parse(body);
        donorCallsigns = new Set(arr.map(b64 => Buffer.from(b64, 'base64').toString('utf-8')));
        if (win && !win.isDestroyed()) {
          win.webContents.send('donor-callsigns', [...donorCallsigns]);
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

function markUserActive() { lastActivityTime = Date.now(); }
function isUserActive() { return (Date.now() - lastActivityTime) < 1800000; } // active within 30 min

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
  let freqHz = Math.round(parseFloat(freqKhz) * 1000); // kHz → Hz
  const now = Date.now();
  if (freqHz === _lastTuneFreq && now - _lastTuneTime < 300) return;
  _lastTuneFreq = freqHz;
  _lastTuneTime = now;

  // CW XIT: use radio's XIT (TX offset only) instead of shifting tune frequency
  const wantXit = !clearXit && (mode === 'CW') && settings.cwXit;
  // Clear XIT when tuning to a non-CW spot (don't leave stale XIT from a previous CW tune)
  const shouldClearXit = clearXit || (!wantXit && mode && mode !== 'CW');

  const m = (mode || '').toUpperCase();
  let filterWidth = 0;
  if (m === 'CW') {
    filterWidth = settings.cwFilterWidth || 0;
  } else if (m === 'SSB' || m === 'USB' || m === 'LSB') {
    filterWidth = settings.ssbFilterWidth || 0;
  } else if (m === 'FT8' || m === 'FT4' || m === 'FT2' || m === 'DIGU' || m === 'DIGL' || m === 'PKTUSB' || m === 'PKTLSB') {
    filterWidth = settings.digitalFilterWidth || 0;
  }
  // If no per-mode preset but user adjusted filter via live controls, preserve it
  if (!filterWidth && _currentFilterWidth > 0) {
    filterWidth = _currentFilterWidth;
  }

  if (settings.enableRotor && settings.rotorActive !== false && settings.rotorMode !== 'manual' && brng != null && !isNaN(brng)) {
    sendRotorBearing(Math.round(brng));
  }

  // Antenna Genius: switch antenna based on band
  if (settings.enableAntennaGenius) {
    agSwitchForFreq(freqKhz);
  }

  if (settings.enableWsjtx && (!cat || !cat.connected)) {
    if (smartSdr && smartSdr.connected && settings.catTarget && settings.catTarget.type === 'tcp') {
      const sliceIndex = (settings.catTarget.port || 5002) - 5002;
      const freqMhz = freqHz / 1e6;
      const ssbSide = freqHz < 10000000 && !(freqHz >= 5300000 && freqHz <= 5410000) ? 'LSB' : 'USB';
      const flexMode = (mode === 'FT8' || mode === 'FT4' || mode === 'FT2' || mode === 'JT65' || mode === 'JT9' || mode === 'WSPR' || mode === 'DIGU' || mode === 'PKTUSB')
        ? 'DIGU' : (mode === 'DIGL' || mode === 'PKTLSB') ? 'DIGL'
        : (mode === 'CW' ? 'CW' : (mode === 'AM' ? 'AM' : (mode === 'FM' ? 'FM' : (mode === 'SSB' ? ssbSide : (mode === 'USB' ? 'USB' : (mode === 'LSB' ? 'LSB' : null))))));
      sendCatLog(`tune via SmartSDR API: slice=${sliceIndex} freq=${freqMhz.toFixed(6)}MHz mode=${mode}→${flexMode} filter=${filterWidth}`);
      smartSdr.tuneSlice(sliceIndex, freqMhz, flexMode, filterWidth);
      // Set or clear XIT on the slice
      if (wantXit) {
        smartSdr.setSliceXit(sliceIndex, true, settings.cwXit);
      } else if (shouldClearXit) {
        smartSdr.setSliceXit(sliceIndex, false);
      }
      // ATU: auto-tune on band change (SmartSDR-only path)
      if (settings.enableAtu) {
        const freqMhzSdr = freqHz / 1e6;
        const tuneBandSdr = freqToBand(freqMhzSdr);
        if (tuneBandSdr && tuneBandSdr !== _lastTuneBand) {
          _lastTuneBand = tuneBandSdr;
          setTimeout(() => {
            sendCatLog(`[ATU] Band changed to ${tuneBandSdr} → starting SmartSDR ATU tune`);
            smartSdr.setAtu(true);
          }, 1500);
        } else if (!_lastTuneBand && tuneBandSdr) {
          _lastTuneBand = tuneBandSdr;
        }
      }
    }
    return;
  }

  if (!cat || !cat.connected) return;

  // CW XIT: use native TX CLAR commands if radio supports them (Yaesu XT/RU/RD),
  // otherwise fall back to shifting the VFO frequency
  let tuneFreqHz = freqHz;
  let nativeXit = null;
  if (wantXit && cat.hasNativeXit) {
    // Radio supports native XIT — pass to tune() for auto-apply after freq change
    nativeXit = settings.cwXit;
  } else if (wantXit && !(smartSdr && smartSdr.connected && settings.catTarget && settings.catTarget.type === 'tcp')) {
    // Fallback: shift VFO frequency
    tuneFreqHz = freqHz + settings.cwXit;
  }
  // Clear native XIT when switching away from CW
  if (shouldClearXit && cat.hasNativeXit) {
    nativeXit = 0;
  }

  const resolvedMode = (mode || '').toUpperCase() === 'SSB' ? (tuneFreqHz >= 10000000 ? 'USB' : 'LSB') : mode;
  // Suppress stale mode broadcasts to ECHOCAT for 2s — prevents flicker when
  // frequency-triggered status broadcasts include the OLD mode before polling catches up
  if (mode) _modeSuppressUntil = Date.now() + 2000;
  sendCatLog(`tune: freq=${freqKhz}kHz → ${tuneFreqHz}Hz mode=${mode}${mode !== resolvedMode ? '→' + resolvedMode : ''} split=${!!settings.enableSplit} filter=${filterWidth}${wantXit ? ` xit=${settings.cwXit}` : ''}`);
  cat.tune(tuneFreqHz, mode, { split: settings.enableSplit, filterWidth, xit: nativeXit });

  // Set or clear XIT via SmartSDR API (works even when tuning via CAT)
  if (smartSdr && smartSdr.connected && settings.catTarget && settings.catTarget.type === 'tcp') {
    const sliceIndex = (settings.catTarget.port || 5002) - 5002;
    if (wantXit) {
      smartSdr.setSliceXit(sliceIndex, true, settings.cwXit);
    } else if (shouldClearXit) {
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
          sendCatLog(`[ATU] Band changed to ${tuneBand} → starting SmartSDR ATU tune`);
          smartSdr.setAtu(true);
        } else if (cat && cat.connected) {
          sendCatLog(`[ATU] Band changed to ${tuneBand} → starting ATU tune`);
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
  // potacat://tune/14074/USB → tune to 14074 kHz USB
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

app.whenReady().then(() => {
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

  // Load SOTA association names (async, non-blocking — falls back to codes if it fails)
  loadAssociations().catch(err => console.error('Failed to load SOTA associations:', err.message));

  createWindow();
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
  if (settings.enableRemote) connectRemote();
  if (settings.enableCwKeyer) connectKeyer();
  if (settings.enableWsjtx) connectWsjtx();
  if (settings.enablePskr) connectPskr();
  if (settings.enablePskrMap) connectPskrMap();
  if (settings.sendToLogbook && settings.logbookType === 'hamrs') {
    hamrsBridge.start(settings.logbookHost || '127.0.0.1', parseInt(settings.logbookPort, 10) || 2237);
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

  // --- JTCAT Pop-out Window ---
  ipcMain.on('jtcat-popout-open', () => {
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) {
      jtcatPopoutWin.focus();
      return;
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

  // --- Popout QSO state machine (drives engine directly, like ECHOCAT) ---
  ipcMain.on('jtcat-popout-reply', async (_e, data) => {
    if (!ft8Engine) return;
    const myCall = (settings.myCallsign || '').toUpperCase();
    const myGrid = (settings.grid || '').toUpperCase().substring(0, 4);
    if (!myCall) return;
    // If replacing an active QSO that had reports exchanged but wasn't logged yet, log it
    if (popoutJtcatQso && popoutJtcatQso.call && popoutJtcatQso.report &&
        popoutJtcatQso.phase !== '73' && popoutJtcatQso.phase !== 'done' &&
        popoutJtcatQso.call.toUpperCase() !== (data.call || '').toUpperCase()) {
      sendCatLog(`[JTCAT] Replacing active QSO with ${popoutJtcatQso.call} — auto-logging`);
      jtcatAutoLog(popoutJtcatQso);
    }
    // Halt any active TX (e.g. CQ) so reply goes out on next boundary
    if (ft8Engine._txActive) ft8Engine.txComplete();
    ft8Engine.setTxFreq(data.df || 1500);
    ft8Engine.setRxFreq(data.df || 1500);
    // TX on opposite slot from the station we're replying to
    const targetSlot = data.slot || ft8Engine._lastRxSlot;
    ft8Engine.setTxSlot(targetSlot === 'even' ? 'odd' : (targetSlot === 'odd' ? 'even' : 'auto'));

    let txMsg, phase;
    if (data.rr73) {
      // They sent RR73/73 — send 73 back, log QSO
      txMsg = data.call + ' ' + myCall + ' 73';
      phase = '73';
    } else if (data.report) {
      // They sent a signal report — pick up at R+report phase
      const snr = data.snr != null ? data.snr : 0;
      const ourRpt = snr >= 0 ? '+' + String(Math.round(snr)).padStart(2, '0') : '-' + String(Math.abs(Math.round(snr))).padStart(2, '0');
      txMsg = data.call + ' ' + myCall + ' R' + ourRpt;
      phase = 'r+report';
      popoutJtcatQso = { mode: 'reply', call: data.call, grid: data.grid, phase, txMsg, report: data.report, sentReport: ourRpt, myCall, myGrid, txRetries: 0 };
    } else {
      // Fresh reply to CQ — start from beginning
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
        myCall, myGrid, txRetries: 0 };
      ft8Engine._txEnabled = true;
      await ft8Engine.setTxMessage(txMsg);
      ft8Engine.tryImmediateTx();
      if (!sameCall) jtcatAutoLog(popoutJtcatQso);
    } else if (!popoutJtcatQso || popoutJtcatQso.phase !== phase) {
      // Only set up QSO if not already created above (report case)
      if (phase === 'reply') {
        popoutJtcatQso = { mode: 'reply', call: data.call, grid: data.grid, phase, txMsg, report: null, sentReport: null, myCall, myGrid, txRetries: 0 };
      }
      ft8Engine._txEnabled = true;
      await ft8Engine.setTxMessage(txMsg);
      ft8Engine.tryImmediateTx();
    } else {
      ft8Engine._txEnabled = true;
      await ft8Engine.setTxMessage(txMsg);
      ft8Engine.tryImmediateTx();
    }

    popoutBroadcastQso();
    console.log('[JTCAT Popout] Reply to', data.call, '— phase:', phase, '— slot:', ft8Engine._txSlot, '—', txMsg);
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
    // TX on next available slot (opposite of last decoded, or 'auto' if no decodes yet)
    const nextSlot = ft8Engine._lastRxSlot === 'even' ? 'odd' : (ft8Engine._lastRxSlot === 'odd' ? 'even' : 'auto');
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

  ipcMain.on('jtcat-popout-skip-phase', () => {
    if (!popoutJtcatQso || popoutJtcatQso.phase === 'done' || popoutJtcatQso.phase === 'idle') return;
    const q = popoutJtcatQso;
    const myCall = q.myCall;
    if (q.mode === 'cq') {
      if (q.phase === 'cq-report') {
        q.txMsg = q.call + ' ' + myCall + ' RR73';
        q.phase = 'cq-rr73';
      } else if (q.phase === 'cq-rr73') {
        q.phase = 'done';
        ft8Engine._txEnabled = false;
        ft8Engine.setTxMessage('');
        ft8Engine.setTxSlot('auto');
      }
    } else {
      if (q.phase === 'reply') {
        const rpt = q.sentReport || '-10';
        q.txMsg = q.call + ' ' + myCall + ' R' + rpt;
        q.phase = 'r+report';
      } else if (q.phase === 'r+report') {
        q.txMsg = q.call + ' ' + myCall + ' RR73';
        q.phase = '73';
      } else if (q.phase === '73') {
        q.phase = 'done';
        ft8Engine._txEnabled = false;
        ft8Engine.setTxMessage('');
        ft8Engine.setTxSlot('auto');
      }
    }
    q.txRetries = 0;
    if (q.txMsg && q.phase !== 'done') {
      if (ft8Engine) ft8Engine.setTxMessage(q.txMsg);
    }
    popoutBroadcastQso();
    console.log('[JTCAT Popout] Skip to phase:', q.phase, '— TX:', q.txMsg);
  });

  ipcMain.on('jtcat-popout-cancel-qso', () => {
    popoutJtcatQso = null;
    if (ft8Engine) {
      ft8Engine._txEnabled = false;
      ft8Engine.setTxMessage('');
      ft8Engine.setTxSlot('auto');
      if (ft8Engine._txActive) ft8Engine.txComplete();
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

  // Check for updates (after a short delay so the window is ready)
  if (!settings.disableAutoUpdate) {
    setTimeout(checkForUpdates, 5000);
  }

  // Send telemetry ping on launch (opt-in only, after short delay)
  setTimeout(() => sendTelemetry(0), 8000);



  // IPC handlers
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

  ipcMain.on('tune', (_e, { frequency, mode, bearing, slicePort }) => {
    markUserActive();
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
    } else {
      tuneRadio(frequency, mode, bearing);
    }
  });

  // --- Rig Control Panel IPC ---
  ipcMain.handle('rig-control', (_e, data) => {
    if (!data || !data.action) return;
    const flexSdr = () => smartSdr && smartSdr.connected;
    const rigType = detectRigType();
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

  ipcMain.handle('get-settings', () => ({ ...settings, appVersion: require('./package.json').version }));
  ipcMain.handle('get-rig-models', () => getModelList());

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
    const result = await dialog.showSaveDialog(parentWin, {
      title: `Export ${event.name} ADIF for LOTW`,
      defaultPath: path.join(app.getPath('documents'), `potacat_${eventId}.adi`),
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
      (has('cwKeyerMode') && newSettings.cwKeyerMode !== settings.cwKeyerMode) ||
      (has('cwWpm') && newSettings.cwWpm !== settings.cwWpm) ||
      (has('cwSwapPaddles') && newSettings.cwSwapPaddles !== settings.cwSwapPaddles);

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

    // Reconnect PSKReporter if settings changed
    if (pskrChanged) {
      if (settings.enablePskr) {
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

    // Start/stop HamRS bridge (WSJT-X binary heartbeats)
    if (settings.sendToLogbook && settings.logbookType === 'hamrs') {
      const hp = parseInt(settings.logbookPort, 10) || 2237;
      const hh = settings.logbookHost || '127.0.0.1';
      if (!hamrsBridge.socket || hamrsBridge.host !== hh || hamrsBridge.port !== hp) {
        hamrsBridge.start(hh, hp);
      }
    } else {
      hamrsBridge.stop();
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
    // Scan imported QSOs for event matches
    scanLogForEvents();

    // Notify pop-out logbook to refresh (if open and not the caller)
    if (qsoPopoutWin && !qsoPopoutWin.isDestroyed() &&
        BrowserWindow.fromWebContents(event.sender) !== qsoPopoutWin) {
      qsoPopoutWin.webContents.send('qso-popout-refresh');
    }

    const fileList = fileNames.join(', ');
    dialog.showMessageBox(parentWin, {
      type: 'info',
      title: 'Import Complete',
      message: `Successfully imported ${fileList}`,
      detail: `${totalImported} QSOs (${uniqueCalls.size} unique callsigns) added.`,
    });

    return { success: true, imported: totalImported, unique: uniqueCalls.size };
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

  ipcMain.handle('export-adif', async (event, qsos) => {
    try {
      const parentWin = BrowserWindow.fromWebContents(event.sender) || win;
      const result = await dialog.showSaveDialog(parentWin, {
        title: 'Export ADIF',
        defaultPath: path.join(app.getPath('documents'), 'potacat_export.adi'),
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
              reject(new Error(`rigctld error: ${line}`));
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
    if (ft8Engine) {
      ft8Engine._txEnabled = false;
      if (ft8Engine._txActive) {
        ft8Engine.txComplete(); // force stop if currently transmitting
      }
    }
  });
  ipcMain.on('jtcat-set-tx-msg', (_e, text) => { if (ft8Engine) ft8Engine.setTxMessage(text); });
  ipcMain.on('jtcat-set-tx-slot', (_e, slot) => { if (ft8Engine) ft8Engine.setTxSlot(slot); });
  ipcMain.on('jtcat-auto-cq-mode', (_e, mode) => {
    jtcatAutoCqMode = mode || 'off';
    jtcatAutoCqOwner = 'popout';
    if (mode === 'off') jtcatAutoCqWorkedSession.clear();
    broadcastAutoCqState();
    console.log('[JTCAT] Auto-CQ mode:', mode);
  });
  ipcMain.on('jtcat-tx-complete', () => { if (ft8Engine) ft8Engine.txComplete(); });
  ipcMain.on('jtcat-log', (_e, msg) => console.log(msg));
  let _jtcatAudioDiag = 0;
  ipcMain.on('jtcat-audio', (_e, buf) => {
    _jtcatAudioDiag++;
    if (_jtcatAudioDiag <= 3 || _jtcatAudioDiag % 200 === 0) {
      const arr = buf ? new Float32Array(buf) : null;
      const max = arr ? Math.max(...arr.slice(0, 100).map(Math.abs)) : 0;
      console.log(`[JTCAT] audio IPC #${_jtcatAudioDiag} len=${buf ? buf.length : 0} max=${max.toFixed(4)} engine=${!!ft8Engine}`);
    }
    if (ft8Engine) ft8Engine.feedAudio(new Float32Array(buf));
  });
  ipcMain.on('jtcat-quiet-freq', (_e, hz) => {
    jtcatQuietFreq = hz;
  });
  ipcMain.on('jtcat-spectrum', (_e, bins) => {
    if (remoteServer && remoteServer.hasClient()) remoteServer.broadcastJtcatSpectrum(bins);
    if (jtcatPopoutWin && !jtcatPopoutWin.isDestroyed()) jtcatPopoutWin.webContents.send('jtcat-spectrum', { bins });
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
      const adifText = await QrzClient.fetchLogbook(settings.qrzApiKey, settings.myCallsign || '');
      if (!adifText) return { ok: true, imported: 0, message: 'QRZ logbook is empty' };

      // Parse downloaded ADIF records
      const downloaded = [];
      const recordRe = /<call:[^>]+>([^<]*)/gi;
      // Split into individual records by <eor>
      const records = adifText.split(/<eor>/i).filter(r => r.trim());

      // Parse existing log for dedup
      const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
      let existingQsos = new Set();
      try {
        const existing = parseAllRawQsos(logPath);
        for (const q of existing) {
          // Dedup key: callsign + date + time + band
          const key = [q.CALL, q.QSO_DATE, (q.TIME_ON || '').slice(0, 4), q.BAND].join('|').toUpperCase();
          existingQsos.add(key);
        }
      } catch { /* no existing log or parse error */ }

      let imported = 0;
      for (const record of records) {
        // Extract key fields for dedup
        const fields = {};
        const fieldRe = /<(\w+):\d+(?::\w+)?>([^<]*)/gi;
        let fm;
        while ((fm = fieldRe.exec(record)) !== null) {
          fields[fm[1].toUpperCase()] = fm[2].trim();
        }
        if (!fields.CALL) continue;

        const key = [fields.CALL, fields.QSO_DATE, (fields.TIME_ON || '').slice(0, 4), fields.BAND].join('|').toUpperCase();
        if (existingQsos.has(key)) continue; // already in log

        // Append the raw ADIF record
        appendRawQso(logPath, record.trim());
        existingQsos.add(key);
        imported++;
      }

      sendCatLog(`[QRZ] Downloaded ${records.length} QSOs, imported ${imported} new`);
      // Reload worked QSOs to update checkmarks
      if (imported > 0) loadWorkedQsos();
      return { ok: true, imported, total: records.length };
    } catch (err) {
      sendCatLog(`[QRZ] Logbook download failed: ${err.message}`);
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
        defaultPath: path.join(app.getPath('documents'), defaultName),
        filters: [
          { name: 'ADIF Files', extensions: ['adi', 'adif'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled) return { success: false };
      writeActivationAdifRaw(result.filePath, qsos);
      return { success: true, path: result.filePath };
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
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths.length) return { success: false };
      const folder = result.filePaths[0];
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
          const qFreq = parseFloat(q.FREQ || 0) * 1000; // FREQ in MHz → kHz
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
  // Paddle events go through IambicKeyer, which generates key events → xmit 1/0
  ipcMain.on('cw-paddle-dit', (_e, pressed) => {
    if (keyer) keyer.paddleDit(pressed);
  });
  ipcMain.on('cw-paddle-dah', (_e, pressed) => {
    if (keyer) keyer.paddleDah(pressed);
  });
  ipcMain.on('cw-set-wpm', (_e, wpm) => {
    if (keyer) keyer.setWpm(wpm);
    if (smartSdr && smartSdr.connected) smartSdr.setCwSpeed(wpm);
  });
  ipcMain.on('cw-stop', () => {
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
  try { disconnectRemote(); } catch {}
  try { disconnectKeyer(); } catch {}
  try { stopJtcat(); } catch {}
  try { hamrsBridge.stop(); } catch {}
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
