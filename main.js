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
const { parseAdifFile, parseWorkedCallsigns, parseAllQsos, parseSqliteFile, parseSqliteConfirmed, isSqliteFile } = require('./lib/adif');
const { DxClusterClient } = require('./lib/dxcluster');
const { RbnClient } = require('./lib/rbn');
const { appendQso, buildAdifRecord, appendImportedQso } = require('./lib/adif-writer');
const { SmartSdrClient } = require('./lib/smartsdr');
const { parsePotaParksCSV } = require('./lib/pota-parks');
const { WsjtxClient } = require('./lib/wsjtx');
const { fetchSpots: fetchWwffSpots } = require('./lib/wwff');
const { fetchSpots: fetchLlotaSpots } = require('./lib/llota');
const { postWwffRespot } = require('./lib/wwff-respot');
const { QrzClient } = require('./lib/qrz');

// --- QRZ.com callsign lookup ---
let qrz = new QrzClient();

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
let cat = null;
let spotTimer = null;
let solarTimer = null;
let rigctldProc = null;
let cluster = null;
let clusterSpots = []; // streaming DX cluster spots (FIFO, max 500)
let clusterFlushTimer = null; // throttle timer for cluster → renderer updates
let rbn = null;
let rbnSpots = []; // streaming RBN spots (FIFO, max 500)
let rbnFlushTimer = null; // throttle timer for RBN → renderer updates
let rbnWatchSpots = []; // RBN spots for watchlist callsigns, merged into main table
let smartSdr = null;
let smartSdrPushTimer = null; // throttle timer for SmartSDR spot pushes
let workedCallsigns = new Set(); // callsigns from QSO log (all QSOs, not just confirmed)
let workedParks = new Map(); // reference → park data from POTA parks CSV
let wsjtx = null;
let wsjtxStatus = null; // last Status message from WSJT-X
let wsjtxHighlightTimer = null; // throttle timer for highlight updates
let donorCallsigns = new Set(); // supporter callsigns from potacat.com

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
  const sourceLabels = { pota: 'POTA', sota: 'SOTA', wwff: 'WWFF', llota: 'LLOTA', dxc: 'DX Cluster', rbn: 'RBN' };
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
    const port = portOverride || '4532';
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
  if (cat) cat.disconnect();
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
    sendCatLog('Connecting to rigctld on 127.0.0.1:4532');
    cat.connect({ type: 'rigctld', host: '127.0.0.1', port: 4532 });
  } else {
    cat = new CatClient();
    cat._debug = true;
    cat.on('log', sendCatLog);
    cat.on('status', sendCatStatus);
    cat.on('frequency', sendCatFrequency);
    if (target) {
      cat.connect(target);
    }
  }
}

// --- DX Cluster ---
function sendClusterStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('cluster-status', s);
}

function connectCluster() {
  if (cluster) {
    cluster.disconnect();
    cluster.removeAllListeners();
    cluster = null;
  }
  clusterSpots = [];

  if (!settings.enableCluster || !settings.myCallsign) {
    sendClusterStatus({ connected: false });
    return;
  }

  cluster = new DxClusterClient();
  const myPos = gridToLatLon(settings.grid);
  // Resolve user's own entity so we can suppress meaningless same-entity distances
  const myEntity = (ctyDb && settings.myCallsign) ? resolveCallsign(settings.myCallsign, ctyDb) : null;

  cluster.on('spot', (raw) => {
    // Normalize to standard spot shape
    const spot = {
      source: 'dxc',
      callsign: raw.callsign,
      frequency: raw.frequency,
      freqMHz: raw.freqMHz,
      mode: raw.mode,
      reference: '',
      parkName: raw.comment || '',
      locationDesc: '',
      distance: null,
      lat: null,
      lon: null,
      band: raw.band,
      spotTime: raw.spotTime,
    };

    // Resolve DXCC entity for location info + approximate coordinates
    if (ctyDb) {
      const entity = resolveCallsign(raw.callsign, ctyDb);
      if (entity) {
        spot.locationDesc = entity.name;
        spot.continent = entity.continent || '';
        if (entity.lat != null && entity.lon != null) {
          spot.lat = entity.lat;
          spot.lon = entity.lon;
          // Skip distance for same-entity spots — cty.dat centroid is meaningless
          if (myPos && entity !== myEntity) {
            spot.distance = Math.round(haversineDistanceMiles(myPos.lat, myPos.lon, entity.lat, entity.lon));
            spot.bearing = Math.round(bearing(myPos.lat, myPos.lon, entity.lat, entity.lon));
          }
        }
      }
    }

    // Watchlist notification for DX Cluster spots
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

    // Dedupe: keep only the latest spot per callsign
    const idx = clusterSpots.findIndex(s => s.callsign === spot.callsign);
    if (idx !== -1) clusterSpots.splice(idx, 1);
    clusterSpots.push(spot);
    // FIFO cap at 500
    if (clusterSpots.length > 500) {
      clusterSpots = clusterSpots.slice(-500);
    }

    // Throttle: batch spots and flush to renderer at most once every 2s
    if (!clusterFlushTimer) {
      clusterFlushTimer = setTimeout(() => {
        clusterFlushTimer = null;
        sendMergedSpots();
      }, 2000);
    }
  });

  cluster.on('status', (s) => {
    sendClusterStatus(s);
  });

  cluster.connect({
    host: settings.clusterHost || 'w3lpl.net',
    port: settings.clusterPort || 7373,
    callsign: settings.myCallsign,
  });
}

function disconnectCluster() {
  if (clusterFlushTimer) {
    clearTimeout(clusterFlushTimer);
    clusterFlushTimer = null;
  }
  if (cluster) {
    cluster.disconnect();
    cluster.removeAllListeners();
    cluster = null;
  }
  clusterSpots = [];
  sendClusterStatus({ connected: false });
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
        fs.writeFileSync(logPath, 'POTA CAT ADIF Log\n<EOH>\n');
      }
      fs.appendFileSync(logPath, adif + '\n');
      // Reload worked callsigns
      loadWorkedCallsigns();
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
  // Connect SmartSDR API if panadapter spots are enabled, OR if WSJT-X is active
  // with a Flex (TCP CAT) so we can tune via the API when CAT is released
  if (settings.smartSdrSpots) return true;
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
  const now = Date.now();
  if (now - lastSmartSdrPush < 5000) return;
  lastSmartSdrPush = now;

  for (const spot of spots) {
    if (spot.source === 'pota' && settings.smartSdrPota === false) continue;
    if (spot.source === 'sota' && settings.smartSdrSota === false) continue;
    if (spot.source === 'dxc' && settings.smartSdrCluster === false) continue;
    if (spot.source === 'rbn' && !settings.smartSdrRbn) continue;
    if (spot.source === 'wwff' && settings.smartSdrWwff === false) continue;
    if (spot.source === 'llota' && settings.smartSdrLlota === false) continue;
    smartSdr.addSpot(spot);
  }
  // Remove spots no longer in the list (instead of clear+re-add which causes flashing)
  smartSdr.pruneStaleSpots();
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
  // Dedupe: keep latest spot per callsign
  const seen = new Map();
  for (const s of all) { seen.set(s.callsign, s); }
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
  // Dedupe: keep latest spot per callsign
  const seen = new Map();
  for (const s of all) { seen.set(s.callsign, s); }
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
  // Dedupe: keep latest spot per callsign
  const seen = new Map();
  for (const s of all) { seen.set(s.callsign, s); }
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
  // Dedupe: keep latest spot per callsign
  const seen = new Map();
  for (const s of all) { seen.set(s.callsign, s); }
  return [...seen.values()];
}

let lastPotaSotaSpots = []; // cache of last fetched POTA+SOTA+WWFF+LLOTA spots

function sendMergedSpots() {
  if (!win || win.isDestroyed()) return;
  const merged = [...lastPotaSotaSpots, ...clusterSpots, ...rbnWatchSpots];
  win.webContents.send('spots', merged);
  pushSpotsToSmartSdr(merged);
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
  if (!ctyDb || !settings.adifPath) return null;
  try {
    const qsos = isSqliteFile(settings.adifPath)
      ? await parseSqliteConfirmed(settings.adifPath)
      : parseAdifFile(settings.adifPath);

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

// --- Worked callsigns tracking ---
function loadWorkedCallsigns() {
  if (!settings.adifLogPath) return;
  try {
    workedCallsigns = parseWorkedCallsigns(settings.adifLogPath);
    if (win && !win.isDestroyed()) {
      win.webContents.send('worked-callsigns', [...workedCallsigns]);
    }
  } catch (err) {
    console.error('Failed to parse worked callsigns:', err.message);
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
  return Promise.resolve();
}

/**
 * Send a QSO to HRD Logbook via plain UDP ADIF on port 2333.
 */
function sendHrdUdp(qsoData, host, port) {
  return new Promise((resolve, reject) => {
    const dgram = require('dgram');
    const record = buildAdifRecord(qsoData);
    const adifText = `<adif_ver:5>3.1.4\n<programid:8>POTA CAT\n<EOH>\n${record}\n`;
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

// --- App lifecycle ---
function createWindow() {
  // Restore saved window bounds (with display sanity check)
  let windowOpts = { width: 1100, height: 700 };
  const saved = settings.windowBounds;
  if (saved && saved.width > 200 && saved.height > 150) {
    // Verify saved position is on a visible display
    const displays = screen.getAllDisplays();
    const onScreen = displays.some(d => {
      const b = d.bounds;
      return saved.x < b.x + b.width && saved.x + saved.width > b.x &&
             saved.y < b.y + b.height && saved.y + saved.height > b.y;
    });
    if (onScreen) {
      windowOpts = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    }
  }

  win = new BrowserWindow({
    ...windowOpts,
    title: 'POTA CAT',
    frame: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Restore maximized state after window is ready
  if (settings.windowMaximized) {
    win.maximize();
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Once the renderer is actually ready to listen, send current state
  win.webContents.on('did-finish-load', () => {
    if (cat) {
      sendCatStatus({ connected: cat.connected, target: cat._target });
    }
    if (cluster) {
      sendClusterStatus({ connected: cluster.connected, host: settings.clusterHost, port: settings.clusterPort });
    }
    if (rbn) {
      sendRbnStatus({ connected: rbn.connected, host: 'telnet.reversebeacon.net', port: 7000 });
      if (rbnSpots.length > 0) sendRbnSpots();
    }
    if (wsjtx) {
      sendWsjtxStatus({ connected: wsjtx.connected, listening: true });
    }
    refreshSpots();
    fetchSolarData();
    // Auto-send DXCC data if enabled and ADIF path is set
    if (settings.enableDxcc && settings.adifPath) {
      sendDxccData();
    }
    // Load worked callsigns from QSO log
    loadWorkedCallsigns();
    // Load worked parks from POTA CSV
    loadWorkedParks();
    // Fetch donor list (async, non-blocking)
    fetchDonorList();
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

// --- Update check ---
function checkForUpdates() {
  const https = require('https');
  const currentVersion = require('./package.json').version;
  const options = {
    hostname: 'api.github.com',
    path: '/repos/Waffleslop/POTA-CAT/releases/latest',
    headers: { 'User-Agent': 'POTA-CAT/' + currentVersion },
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
          const releaseUrl = data.html_url || `https://github.com/Waffleslop/POTA-CAT/releases/tag/${data.tag_name}`;
          if (win && !win.isDestroyed()) {
            win.webContents.send('update-available', { version: latestTag, url: releaseUrl, headline: data.name || '' });
          }
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

// --- Anonymous telemetry (opt-in only) ---
const TELEMETRY_URL = 'https://telemetry.potacat.com/ping';
let sessionStartTime = Date.now();

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
    source: 'POTA CAT',
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

function trackRespot() {
  const https = require('https');
  const url = new URL('https://telemetry.potacat.com/respot');
  const req = https.request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 5000,
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
}

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
    saveSettings(s);
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
  connectSmartSdr(); // connects if smartSdrSpots or WSJT-X+Flex
  if (settings.enableWsjtx) connectWsjtx();
  // Configure QRZ client from saved credentials
  if (settings.enableQrz && settings.qrzUsername && settings.qrzPassword) {
    qrz.configure(settings.qrzUsername, settings.qrzPassword);
  }

  // Window control IPC
  ipcMain.on('win-minimize', () => { if (win) win.minimize(); });
  ipcMain.on('win-maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('win-close', () => { if (win) win.close(); });

  // Start spot fetching
  refreshSpots();
  spotTimer = setInterval(refreshSpots, 30000);

  // Start solar data fetching (every 10 minutes)
  solarTimer = setInterval(fetchSolarData, 600000);

  // Check for updates (after a short delay so the window is ready)
  setTimeout(checkForUpdates, 5000);

  // Send telemetry ping on launch (opt-in only, after short delay)
  setTimeout(() => sendTelemetry(0), 8000);

  // Telemetry heartbeat every 30 minutes (captures duration if shutdown is not graceful)
  setInterval(() => {
    const sessionSeconds = Math.round((Date.now() - sessionStartTime) / 1000);
    sendTelemetry(sessionSeconds);
  }, 1800000);

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
    if (url.startsWith('https://www.qrz.com/') || url.startsWith('https://caseystanton.com/') || url.startsWith('https://github.com/Waffleslop/POTA-CAT/') || url.startsWith('https://hamlib.github.io/') || url.startsWith('https://github.com/Hamlib/') || url.startsWith('https://discord.gg/') || url.startsWith('https://potacat.com/') || url.startsWith('https://buymeacoffee.com/potacat')) {
      shell.openExternal(url);
    }
  });

  let _lastTuneFreq = 0;
  let _lastTuneTime = 0;
  ipcMain.on('tune', (_e, { frequency, mode, bearing }) => {
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

  ipcMain.on('refresh', () => { refreshSpots(); });

  ipcMain.handle('get-settings', () => ({ ...settings, appVersion: require('./package.json').version }));

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
    const adifLogPathChanged = newSettings.adifLogPath !== settings.adifLogPath;
    const potaParksPathChanged = newSettings.potaParksPath !== settings.potaParksPath;

    const clusterChanged = newSettings.enableCluster !== settings.enableCluster ||
      newSettings.myCallsign !== settings.myCallsign ||
      newSettings.clusterHost !== settings.clusterHost ||
      newSettings.clusterPort !== settings.clusterPort;

    const rbnChanged = newSettings.enableRbn !== settings.enableRbn ||
      newSettings.myCallsign !== settings.myCallsign ||
      newSettings.watchlist !== settings.watchlist;

    const smartSdrChanged = newSettings.smartSdrSpots !== settings.smartSdrSpots ||
      newSettings.smartSdrHost !== settings.smartSdrHost;

    const wsjtxChanged = newSettings.enableWsjtx !== settings.enableWsjtx ||
      newSettings.wsjtxPort !== settings.wsjtxPort;

    settings = { ...settings, ...newSettings };
    saveSettings(settings);
    // Only reconnect CAT if WSJT-X is not managing the radio
    if (!settings.enableWsjtx) connectCat();
    refreshSpots();

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

    // Reconnect SmartSDR if settings changed (also needed for WSJT-X+Flex tuning)
    if (smartSdrChanged || wsjtxChanged) {
      connectSmartSdr(); // needsSmartSdr() decides whether to actually connect
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

    // Auto-parse ADIF and send DXCC data if enabled
    if (settings.enableDxcc && settings.adifPath) {
      sendDxccData();
    }

    // Reload worked callsigns if log path changed
    if (adifLogPathChanged) {
      loadWorkedCallsigns();
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

  // --- DXCC Tracker IPC ---
  ipcMain.handle('choose-adif-file', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Log File',
      filters: [
        { name: 'Log Files', extensions: ['adi', 'adif', 'sqlite', 'db'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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
    loadWorkedCallsigns();

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
    try {
      // Inject operator callsign from settings
      if (settings.myCallsign && !qsoData.operator) {
        qsoData.operator = settings.myCallsign.toUpperCase();
      }
      const logPath = settings.adifLogPath || path.join(app.getPath('userData'), 'potacat_qso_log.adi');
      appendQso(logPath, qsoData);

      // Update worked callsigns set and notify renderer
      if (qsoData.callsign) {
        workedCallsigns.add(qsoData.callsign.toUpperCase());
        if (win && !win.isDestroyed()) {
          win.webContents.send('worked-callsigns', [...workedCallsigns]);
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
          trackRespot();
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
        } catch (respotErr) {
          console.error('WWFF re-spot failed:', respotErr.message);
          return { success: true, wwffRespotError: respotErr.message };
        }
      }

      const didRespot = (qsoData.respot && qsoData.sig === 'POTA') || qsoData.wwffRespot;
      return { success: true, resposted: didRespot || false };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.on('connect-cat', (_e, target) => {
    settings.catTarget = target;
    saveSettings(settings);
    if (!settings.enableWsjtx) connectCat();
  });

  // --- WSJT-X IPC ---
  ipcMain.on('wsjtx-reply', (_e, decode) => {
    if (wsjtx && wsjtx.connected) {
      wsjtx.reply(decode, 0);
    }
  });

  ipcMain.on('wsjtx-halt-tx', () => {
    if (wsjtx && wsjtx.connected) {
      wsjtx.haltTx(true);
    }
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

  // --- RBN IPC ---
  ipcMain.on('rbn-clear', () => {
    rbnSpots = [];
    sendRbnSpots();
  });
});

app.on('window-all-closed', async () => {
  // Save window bounds before cleanup
  if (win && !win.isDestroyed()) {
    settings.windowMaximized = win.isMaximized();
    if (!win.isMaximized() && !win.isMinimized()) {
      settings.windowBounds = win.getBounds();
    }
    saveSettings(settings);
  }

  // Send session duration telemetry before quitting — await so the request flushes
  const sessionSeconds = Math.round((Date.now() - sessionStartTime) / 1000);
  await sendTelemetry(sessionSeconds);

  if (spotTimer) clearInterval(spotTimer);
  if (solarTimer) clearInterval(solarTimer);
  if (cat) cat.disconnect();
  if (cluster) cluster.disconnect();
  if (rbn) rbn.disconnect();
  disconnectWsjtx();
  disconnectSmartSdr();
  killRigctld();
  app.quit();
});
