const { app, BrowserWindow, ipcMain, Menu, dialog, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// Prevent EPIPE crashes when stdout/stderr pipe is closed
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});
const { execFile, spawn } = require('child_process');
const { fetchSpots: fetchPotaSpots } = require('./lib/pota');
const { fetchSpots: fetchSotaSpots, fetchSummitCoordsBatch, summitCache, loadAssociations, getAssociationName } = require('./lib/sota');
const { CatClient, RigctldClient, listSerialPorts } = require('./lib/cat');
const { gridToLatLon, haversineDistanceMiles, bearing } = require('./lib/grid');
const { freqToBand } = require('./lib/bands');
const { loadCtyDat, resolveCallsign, getAllEntities } = require('./lib/cty');
const { parseAdifFile, parseWorkedQsos, parseAllQsos, parseAllRawQsos, parseSqliteFile, parseSqliteConfirmed, isSqliteFile } = require('./lib/adif');
const { DxClusterClient } = require('./lib/dxcluster');
const { RbnClient } = require('./lib/rbn');
const { appendQso, buildAdifRecord, appendImportedQso, rewriteAdifFile, ADIF_HEADER, adifField } = require('./lib/adif-writer');
const { SmartSdrClient } = require('./lib/smartsdr');
const { TciClient } = require('./lib/tci');
const { IambicKeyer } = require('./lib/keyer');
const { parsePotaParksCSV } = require('./lib/pota-parks');
const { WsjtxClient } = require('./lib/wsjtx');
const { PskrClient } = require('./lib/pskreporter');
const { fetchSpots: fetchWwffSpots } = require('./lib/wwff');
const { fetchSpots: fetchLlotaSpots } = require('./lib/llota');
const { postWwffRespot } = require('./lib/wwff-respot');
const { QrzClient } = require('./lib/qrz');
const { callsignToProgram, fetchParksForProgram, loadParksCache, saveParksCache, isCacheStale, searchParks: searchParksDb, getPark: getParkDb, buildParksMap } = require('./lib/pota-parks-db');
const { autoUpdater } = require('electron-updater');

// --- QRZ.com callsign lookup ---
let qrz = new QrzClient();

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
let cat = null;
let spotTimer = null;
let solarTimer = null;
let rigctldProc = null;
let cluster = null; // legacy — replaced by clusterClients Map
let clusterSpots = []; // streaming DX cluster spots (FIFO, max 500)
let clusterFlushTimer = null; // throttle timer for cluster → renderer updates
let rbn = null;
let rbnSpots = []; // streaming RBN spots (FIFO, max 500)
let rbnFlushTimer = null; // throttle timer for RBN → renderer updates
let rbnWatchSpots = []; // RBN spots for watchlist callsigns, merged into main table
let smartSdr = null;
let smartSdrPushTimer = null; // throttle timer for SmartSDR spot pushes
let tciClient = null;
let tciPushTimer = null; // throttle timer for TCI spot pushes
let workedQsos = new Map(); // callsign → [{date, ref}] from QSO log (all QSOs, not just confirmed)
let workedParks = new Map(); // reference → park data from POTA parks CSV
let wsjtx = null;
let wsjtxStatus = null; // last Status message from WSJT-X
let wsjtxHighlightTimer = null; // throttle timer for highlight updates
let donorCallsigns = new Set(); // supporter callsigns from potacat.com
let expeditionCallsigns = new Set(); // active DX expeditions from Club Log
let activeEvents = [];                // events fetched from remote endpoint
const EVENTS_CACHE_PATH = path.join(app.getPath('userData'), 'events-cache.json');
let pskr = null;
let pskrSpots = [];       // streaming PSKReporter FreeDV spots (FIFO, max 500)
let pskrFlushTimer = null; // throttle timer for PSKReporter → renderer updates
let keyer = null;          // IambicKeyer instance for CW MIDI keying

// --- Watchlist notifications ---
const recentNotifications = new Map(); // callsign → timestamp for dedup (5-min window)
let lastNotifiedPotaSota = new Set(); // callsigns seen in previous POTA/SOTA refresh

function parseWatchlist(str) {
  if (!str) return new Set();
  const set = new Set();
  for (const cs of str.split(',')) {
    const trimmed = cs.trim().toUpperCase();
    if (trimmed) set.add(trimmed);
  }
  return set;
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
  const bundledPath = app.isPackaged
    ? path.join(process.resourcesPath, 'hamlib', 'rigctld.exe')
    : path.join(__dirname, 'assets', 'hamlib', 'rigctld.exe');
  try {
    fs.accessSync(bundledPath, fs.constants.X_OK);
    return bundledPath;
  } catch { /* fall through */ }

  // Check common install directories (Windows)
  const candidates = [
    'C:\\Program Files\\hamlib\\bin\\rigctld.exe',
    'C:\\Program Files (x86)\\hamlib\\bin\\rigctld.exe',
    'C:\\hamlib\\bin\\rigctld.exe',
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* continue */ }
  }

  // Fall back to PATH (just the bare name — execFile will search PATH)
  return 'rigctld';
}

function listRigs(rigctldPath) {
  return new Promise((resolve, reject) => {
    execFile(rigctldPath, ['-l'], { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(err);
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
      '-s', String(target.baudRate),
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
}

function sendCatFrequency(hz) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-frequency', hz);
}

function sendCatMode(mode) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-mode', mode);
}

function sendCatPower(watts) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-power', watts);
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

async function connectCat() {
  if (cat) {
    cat.removeAllListeners(); // prevent stale close events from sending false status
    cat.disconnect();
  }
  killRigctld();
  const target = settings.catTarget;

  if (target && target.type === 'rigctld') {
    // Spawn rigctld process, then connect RigctldClient to it
    try {
      await spawnRigctld(target);
    } catch (err) {
      console.error('Failed to spawn rigctld:', err.message);
      sendCatStatus({ connected: false, target, error: err.message });
      return;
    }
    cat = new RigctldClient();
    cat.on('status', (s) => {
      // Enrich disconnect events with last rigctld stderr
      if (!s.connected && rigctldStderr) {
        const lastLine = rigctldStderr.trim().split('\n').pop();
        if (lastLine) s.error = lastLine;
      }
      sendCatLog(`rigctld status: connected=${s.connected}${s.error ? ' error=' + s.error : ''}`);
      sendCatStatus(s);
    });
    cat.on('frequency', sendCatFrequency);
    cat.on('mode', sendCatMode);
    const rigctldPort = target.rigctldPort || 4532;
    sendCatLog(`Connecting to rigctld on 127.0.0.1:${rigctldPort}`);
    cat.connect({ type: 'rigctld', host: '127.0.0.1', port: rigctldPort });
  } else if (target && target.type === 'rigctldnet') {
    // Connect directly to remote rigctld server — no local spawn
    cat = new RigctldClient();
    cat.on('status', (s) => {
      sendCatLog(`rigctld-net status: connected=${s.connected}${s.error ? ' error=' + s.error : ''}`);
      sendCatStatus(s);
    });
    cat.on('frequency', sendCatFrequency);
    cat.on('mode', sendCatMode);
    const host = target.host || '127.0.0.1';
    const port = target.port || 4532;
    sendCatLog(`Connecting to remote rigctld on ${host}:${port}`);
    cat.connect({ type: 'rigctldnet', host, port });
  } else {
    cat = new CatClient();
    cat._debug = true;
    cat.on('log', sendCatLog);
    cat.on('status', sendCatStatus);
    cat.on('frequency', sendCatFrequency);
    cat.on('mode', sendCatMode);
    cat.on('power', sendCatPower);
    if (target) {
      cat.connect(target);
    }
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
      const watchSet = parseWatchlist(settings.watchlist);
      if (watchSet.has(raw.callsign.toUpperCase())) {
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

    client.on('status', () => {
      sendClusterStatus();
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
    const rbnWatchSet = parseWatchlist(settings.watchlist);
    if (rbnWatchSet.has(raw.callsign.toUpperCase()) && raw.callsign.toUpperCase() !== myCall) {
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
    if (rbnWatchSet.has(raw.callsign.toUpperCase()) && raw.callsign.toUpperCase() !== myCall) {
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
    const watchSet = parseWatchlist(settings.watchlist);
    if (watchSet.has(raw.callsign.toUpperCase())) {
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

  wsjtx.on('logged-adif', ({ adif }) => {
    if (!settings.wsjtxAutoLog) return;
    // Append the raw ADIF record to our log file
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      // Ensure log file exists with header
      if (!fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, 'POTACAT ADIF Log\n<EOH>\n');
      }
      fs.appendFileSync(logPath, adif + '\n');
      // Reload worked callsigns
      loadWorkedQsos();
    } catch (err) {
      console.error('Failed to append WSJT-X ADIF:', err.message);
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

  // Set highlights for active POTA callsigns — green background
  const bgColor = { r: 78, g: 204, b: 163 }; // #4ecca3 POTA green
  const fgColor = { r: 0, g: 0, b: 0 };
  for (const call of activators) {
    wsjtx.highlightCallsign(call, bgColor, fgColor);
  }
}

// --- SmartSDR panadapter spots ---
function needsSmartSdr() {
  // Connect SmartSDR API if panadapter spots are enabled, CW keyer is active,
  // or WSJT-X is active with a Flex (TCP CAT) so we can tune via the API when CAT is released
  if (settings.smartSdrSpots) return true;
  if (settings.enableCwKeyer) return true;
  if (settings.enableWsjtx && settings.catTarget && settings.catTarget.type === 'tcp') return true;
  return false;
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
  smartSdr.setNeedsCw(!!settings.enableCwKeyer);
  // Log CW auth results
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

  const maxAgeMs = (settings.smartSdrMaxAge != null ? settings.smartSdrMaxAge : 15) * 60000;

  for (const spot of spots) {
    // Age filter — skip spots older than the configured max age (0 = no limit)
    if (maxAgeMs > 0 && spot.spotTime) {
      const t = spot.spotTime.endsWith('Z') ? spot.spotTime : spot.spotTime + 'Z';
      const age = now - new Date(t).getTime();
      if (age > maxAgeMs) continue;
    }
    smartSdr.addSpot(spot);
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

let lastTciPush = 0;

function pushSpotsToTci(spots) {
  if (!tciClient || !tciClient.connected) return;
  const now = Date.now();
  if (now - lastTciPush < 5000) return;
  lastTciPush = now;

  const maxAgeMs = (settings.tciMaxAge != null ? settings.tciMaxAge : 15) * 60000;

  for (const spot of spots) {
    // Age filter — skip spots older than the configured max age (0 = no limit)
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

  const all = raw.map((s) => {
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

function sendMergedSpots() {
  if (!win || win.isDestroyed()) return;
  const merged = [...lastPotaSotaSpots, ...clusterSpots, ...rbnWatchSpots, ...pskrSpots];
  win.webContents.send('spots', merged);
  pushSpotsToSmartSdr(merged);
  pushSpotsToTci(merged);
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

    // Watchlist notifications for newly-appeared POTA/SOTA spots
    const potaSotaWatchSet = parseWatchlist(settings.watchlist);
    if (potaSotaWatchSet.size > 0) {
      const currentCallsigns = new Set(lastPotaSotaSpots.map(s => s.callsign.toUpperCase()));
      for (const spot of lastPotaSotaSpots) {
        const csUpper = spot.callsign.toUpperCase();
        if (potaSotaWatchSet.has(csUpper) && !lastNotifiedPotaSota.has(csUpper)) {
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
      lastNotifiedPotaSota = currentCallsigns;
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
function loadWorkedParks() {
  if (!settings.potaParksPath) {
    workedParks = new Map();
    if (win && !win.isDestroyed()) {
      win.webContents.send('worked-parks', []);
    }
    return;
  }
  try {
    workedParks = parsePotaParksCSV(settings.potaParksPath);
    if (win && !win.isDestroyed()) {
      // Serialize Map as array of [key, value] pairs
      win.webContents.send('worked-parks', [...workedParks.entries()]);
    }
  } catch (err) {
    console.error('Failed to parse POTA parks CSV:', err.message);
  }
}

// --- Logbook forwarding ---
function forwardToLogbook(qsoData) {
  const type = settings.logbookType;
  const host = settings.logbookHost || '127.0.0.1';
  const port = parseInt(settings.logbookPort, 10);

  if (type === 'log4om') {
    // Log4OM watches the ADIF file directly — no network forwarding needed
    return Promise.resolve();
  }
  if (type === 'hrd') {
    return sendHrdUdp(qsoData, host, port || 2333);
  }
  if (type === 'n3fjp') {
    return sendN3fjpTcp(qsoData, host, port || 1100);
  }
  if (type === 'dxkeeper') {
    return sendDxkeeperTcp(qsoData, host, port || 52001);
  }
  return Promise.resolve();
}

/**
 * Send a QSO to HRD Logbook via plain UDP ADIF on port 2333.
 */
function sendHrdUdp(qsoData, host, port) {
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
 * Send a QSO to N3FJP via TCP ADDADIFRECORD command.
 * Format: <CMD><ADDADIFRECORD><VALUE>...adif fields...<EOR></VALUE></CMD>\r\n
 */
function sendN3fjpTcp(qsoData, host, port) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const record = buildAdifRecord(qsoData);
    const cmd = `<CMD><ADDADIFRECORD><VALUE>${record}</VALUE></CMD>\r\n`;

    const sock = net.createConnection({ host, port }, () => {
      sock.write(cmd, 'utf-8', () => {
        sock.end();
        resolve();
      });
    });

    sock.setTimeout(5000);
    sock.on('timeout', () => {
      sock.destroy();
      reject(new Error('N3FJP connection timed out'));
    });
    sock.on('error', (err) => {
      reject(new Error(`N3FJP: ${err.message}`));
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

// --- App lifecycle ---
function isOnScreen(saved) {
  const displays = screen.getAllDisplays();
  return displays.some(d => {
    const b = d.bounds;
    return saved.x < b.x + b.width && saved.x + saved.width > b.x &&
           saved.y < b.y + b.height && saved.y + saved.height > b.y;
  });
}

function createWindow() {
  // Create window at default size first, then restore bounds via setBounds()
  // so Electron resolves DPI scaling for the correct display
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    title: `POTACAT - v${require('./package.json').version}`,
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Restore saved window bounds after creation (DPI-aware)
  const saved = settings.windowBounds;
  if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
    win.setBounds(saved);
  }

  if (settings.windowMaximized) {
    win.maximize();
  }

  // Allow MIDI device access for CW keyer
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(true));

  win.show();

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
    saveSettings(settings);
    if (popoutWin && !popoutWin.isDestroyed()) popoutWin.close();
    if (qsoPopoutWin && !qsoPopoutWin.isDestroyed()) qsoPopoutWin.close();
    if (spotsPopoutWin && !spotsPopoutWin.isDestroyed()) spotsPopoutWin.close();
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

// --- DX Expeditions (Club Log) ---
function fetchExpeditions() {
  const https = require('https');
  const req = https.get('https://clublog.org/expeditions.php?api=1', (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const arr = JSON.parse(body);
        // Each entry is [callsign, lastQsoDateTime, qsoCount]
        // Only include expeditions active in the last 7 days
        const cutoff = Date.now() - 7 * 24 * 3600000;
        expeditionCallsigns = new Set();
        for (const entry of arr) {
          const lastQso = new Date(entry[1] + 'Z').getTime();
          if (lastQso >= cutoff) {
            expeditionCallsigns.add(entry[0].toUpperCase());
          }
        }
        if (win && !win.isDestroyed()) {
          win.webContents.send('expedition-callsigns', [...expeditionCallsigns]);
        }
      } catch { /* silently ignore parse errors */ }
    });
  });
  req.on('error', () => { /* silently ignore */ });
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  settings = loadSettings();
  migrateRigSettings(settings);

  // Load cty.dat for DXCC lookups
  try {
    ctyDb = loadCtyDat(path.join(__dirname, 'assets', 'cty.dat'));
  } catch (err) {
    console.error('Failed to load cty.dat:', err.message);
  }

  // Load SOTA association names (async, non-blocking — falls back to codes if it fails)
  loadAssociations().catch(err => console.error('Failed to load SOTA associations:', err.message));

  createWindow();
  if (!settings.enableWsjtx) connectCat();
  if (settings.enableCluster) connectCluster();
  if (settings.enableRbn) connectRbn();
  connectSmartSdr(); // connects if smartSdrSpots, CW keyer, or WSJT-X+Flex
  connectTci();
  if (settings.enableCwKeyer) connectKeyer();
  if (settings.enableWsjtx) connectWsjtx();
  if (settings.enablePskr) connectPskr();
  // Configure QRZ client from saved credentials
  if (settings.enableQrz && settings.qrzUsername && settings.qrzPassword) {
    qrz.configure(settings.qrzUsername, settings.qrzPassword);
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
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Restore saved bounds after creation (DPI-aware)
    const saved = settings.mapPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      popoutWin.setBounds(saved);
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
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-qso-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Restore saved bounds (DPI-aware)
    const saved = settings.qsoPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      qsoPopoutWin.setBounds(saved);
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
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-spots-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Restore saved bounds (DPI-aware)
    const saved = settings.spotsPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      spotsPopoutWin.setBounds(saved);
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
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-actmap-popout.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Restore saved bounds (DPI-aware)
    const saved = settings.actmapPopoutBounds;
    if (saved && saved.width > 200 && saved.height > 150 && isOnScreen(saved)) {
      actmapPopoutWin.setBounds(saved);
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
    if (url.startsWith('https://www.qrz.com/') || url.startsWith('https://caseystanton.com/') || url.startsWith('https://github.com/Waffleslop/POTACAT/') || url.startsWith('https://hamlib.github.io/') || url.startsWith('https://github.com/Hamlib/') || url.startsWith('https://discord.gg/') || url.startsWith('https://potacat.com/') || url.startsWith('https://buymeacoffee.com/potacat')) {
      shell.openExternal(url);
    }
  });

  let _lastTuneFreq = 0;
  let _lastTuneTime = 0;
  ipcMain.on('tune', (_e, { frequency, mode, bearing }) => {
    markUserActive();
    let freqHz = Math.round(parseFloat(frequency) * 1000); // kHz → Hz
    // Debounce: skip duplicate tune to same frequency within 300ms
    const now = Date.now();
    if (freqHz === _lastTuneFreq && now - _lastTuneTime < 300) return;
    _lastTuneFreq = freqHz;
    _lastTuneTime = now;
    // Apply CW XIT offset — shift tune frequency so TX lands offset from the activator
    if ((mode === 'CW') && settings.cwXit) {
      freqHz += settings.cwXit;
    }

    // Look up per-mode filter width from settings
    const m = (mode || '').toUpperCase();
    let filterWidth = 0;
    if (m === 'CW') {
      filterWidth = settings.cwFilterWidth || 0;
    } else if (m === 'SSB' || m === 'USB' || m === 'LSB') {
      filterWidth = settings.ssbFilterWidth || 0;
    } else if (m === 'FT8' || m === 'FT4' || m === 'DIGU' || m === 'DIGL') {
      filterWidth = settings.digitalFilterWidth || 0;
    }

    // Send bearing to PstRotator via UDP
    if (settings.enableRotor && bearing != null && !isNaN(bearing)) {
      sendRotorBearing(Math.round(bearing));
    }

    // If WSJT-X is active and CAT is released, try to tune via SmartSDR API
    if (settings.enableWsjtx && (!cat || !cat.connected)) {
      if (smartSdr && smartSdr.connected && settings.catTarget && settings.catTarget.type === 'tcp') {
        const sliceIndex = (settings.catTarget.port || 5002) - 5002;
        const freqMhz = freqHz / 1e6;
        // Map common modes to FlexRadio mode strings
        const flexMode = (mode === 'FT8' || mode === 'FT4' || mode === 'JT65' || mode === 'JT9' || mode === 'WSPR')
          ? 'DIGU' : (mode === 'CW' ? 'CW' : (mode === 'SSB' || mode === 'USB' ? 'USB' : (mode === 'LSB' ? 'LSB' : null)));
        sendCatLog(`tune via SmartSDR API: slice=${sliceIndex} freq=${freqMhz.toFixed(6)}MHz mode=${mode}→${flexMode} filter=${filterWidth}`);
        smartSdr.tuneSlice(sliceIndex, freqMhz, flexMode, filterWidth);
      }
      return;
    }

    if (!cat || !cat.connected) return;
    sendCatLog(`tune IPC: freq=${frequency}kHz → ${freqHz}Hz mode=${mode} split=${!!settings.enableSplit} filter=${filterWidth} cat.connected=${cat ? cat.connected : 'no cat'}`);
    cat.tune(freqHz, mode, { split: settings.enableSplit, filterWidth });
  });

  ipcMain.on('refresh', () => { markUserActive(); refreshSpots(); });

  ipcMain.handle('get-settings', () => ({ ...settings, appVersion: require('./package.json').version }));

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
      return await listRigs(rigctldPath);
    } catch {
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

    const wsjtxChanged = (has('enableWsjtx') && newSettings.enableWsjtx !== settings.enableWsjtx) ||
      (has('wsjtxPort') && newSettings.wsjtxPort !== settings.wsjtxPort);

    const pskrChanged = has('enablePskr') && newSettings.enablePskr !== settings.enablePskr;

    const cwKeyerChanged = (has('enableCwKeyer') && newSettings.enableCwKeyer !== settings.enableCwKeyer) ||
      (has('cwKeyerMode') && newSettings.cwKeyerMode !== settings.cwKeyerMode) ||
      (has('cwWpm') && newSettings.cwWpm !== settings.cwWpm) ||
      (has('cwSwapPaddles') && newSettings.cwSwapPaddles !== settings.cwSwapPaddles);

    const isPartialSave = !has('enablePota'); // hotkey saves only send 1-2 keys

    settings = { ...settings, ...newSettings };
    saveSettings(settings);
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

    // Reconnect RBN if settings changed
    if (rbnChanged) {
      if (settings.enableRbn) {
        connectRbn();
      } else {
        disconnectRbn();
      }
    }

    // Reconnect SmartSDR if settings changed (also needed for WSJT-X+Flex and CW keyer)
    if (smartSdrChanged || wsjtxChanged || cwKeyerChanged) {
      connectSmartSdr(); // needsSmartSdr() decides whether to actually connect
    }

    // Reconnect TCI if settings changed
    if (tciChanged) {
      connectTci();
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

    // Reconfigure QRZ client if credentials changed
    if (newSettings.enableQrz) {
      qrz.configure(newSettings.qrzUsername || '', newSettings.qrzPassword || '');
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
  ipcMain.handle('import-adif', async () => {
    const result = await dialog.showOpenDialog(win, {
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
        const qsos = isSqliteFile(filePath)
          ? await parseSqliteFile(filePath)
          : parseAllQsos(filePath);
        for (const qso of qsos) {
          appendImportedQso(logPath, qso);
          uniqueCalls.add(qso.call.toUpperCase());
          totalImported++;
        }
        fileNames.push(path.basename(filePath));
      } catch (err) {
        dialog.showMessageBox(win, {
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

    const fileList = fileNames.join(', ');
    dialog.showMessageBox(win, {
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

  ipcMain.handle('test-hamlib', async (_e, config) => {
    const { rigId, serialPort, baudRate, dtrOff } = config;
    let testProc = null;
    const net = require('net');

    try {
      // Spawn rigctld on port 4533 to avoid conflict with live instance on 4532
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
    }
  });

  ipcMain.handle('save-qso', async (_e, qsoData) => {
    markUserActive();
    try {
      // Inject operator callsign from settings
      if (settings.myCallsign && !qsoData.operator) {
        qsoData.operator = settings.myCallsign.toUpperCase();
      }
      const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
      appendQso(logPath, qsoData);

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
        const entry = { date: qsoData.qsoDate || '', ref: (qsoData.sigInfo || '').toUpperCase(), band: (qsoData.band || '').toUpperCase() };
        if (!workedQsos.has(call)) workedQsos.set(call, []);
        workedQsos.get(call).push(entry);
        if (win && !win.isDestroyed()) {
          win.webContents.send('worked-qsos', [...workedQsos.entries()]);
        }
      }

      // Forward to external logbook if enabled
      if (settings.sendToLogbook && settings.logbookType) {
        try {
          await forwardToLogbook(qsoData);
        } catch (fwdErr) {
          console.error('Logbook forwarding failed:', fwdErr.message);
          return { success: true, logbookError: fwdErr.message };
        }
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
          // Track re-spot in telemetry (fire-and-forget)
          trackRespot('pota');
        } catch (respotErr) {
          console.error('POTA re-spot failed:', respotErr.message);
          return { success: true, respotError: respotErr.message };
        }
      }

      // Re-spot on WWFF if requested
      if (qsoData.wwffRespot && qsoData.wwffReference && settings.myCallsign) {
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

      // Re-spot on LLOTA if requested
      if (qsoData.llotaRespot && qsoData.llotaReference) {
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

      const didRespot = (qsoData.respot && qsoData.sig === 'POTA') || qsoData.wwffRespot || qsoData.llotaRespot || qsoData.dxcRespot;
      return { success: true, resposted: didRespot || false };
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

  // --- QRZ single callsign lookup (for Quick Log) ---
  ipcMain.handle('qrz-lookup', async (_e, callsign) => {
    if (!qrz.configured || !settings.enableQrz) return null;
    try {
      return await qrz.lookup(callsign);
    } catch {
      return null;
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

  // --- Past Activations (scan log for MY_SIG=POTA groups) ---
  ipcMain.handle('get-past-activations', () => {
    const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
    try {
      if (!fs.existsSync(logPath)) return [];
      const qsos = parseAllRawQsos(logPath);
      // Group by MY_SIG_INFO (park ref) + QSO_DATE
      const groups = new Map();
      for (const q of qsos) {
        if ((q.MY_SIG || '').toUpperCase() !== 'POTA' || !q.MY_SIG_INFO) continue;
        const ref = q.MY_SIG_INFO.toUpperCase();
        const date = q.QSO_DATE || '';
        const key = `${ref}|${date}`;
        if (!groups.has(key)) {
          groups.set(key, { parkRef: ref, date, contacts: [] });
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
  });

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
        result[cs] = { lat: entity.lat, lon: entity.lon, name: entity.name || '' };
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
      qsos.splice(idx, 1);
      rewriteAdifFile(logPath, qsos);
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
  if (rbn) try { rbn.disconnect(); } catch {}
  try { disconnectWsjtx(); } catch {}
  try { disconnectSmartSdr(); } catch {}
  try { disconnectTci(); } catch {}
  try { disconnectKeyer(); } catch {}
  killRigctld();
}

app.on('before-quit', gracefulCleanup);
process.on('SIGINT', () => { gracefulCleanup(); process.exit(0); });
process.on('SIGTERM', () => { gracefulCleanup(); process.exit(0); });

app.on('window-all-closed', async () => {
  // Send session duration telemetry before quitting — await so the request flushes
  const sessionSeconds = Math.round((Date.now() - sessionStartTime) / 1000);
  await sendTelemetry(sessionSeconds);

  gracefulCleanup();
  app.quit();
});
