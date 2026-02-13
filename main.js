const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { fetchSpots: fetchPotaSpots } = require('./lib/pota');
const { fetchSpots: fetchSotaSpots, fetchSummitCoordsBatch, summitCache } = require('./lib/sota');
const { CatClient, RigctldClient, listSerialPorts } = require('./lib/cat');
const { gridToLatLon, haversineDistanceMiles } = require('./lib/grid');
const { freqToBand } = require('./lib/bands');

// --- Settings ---
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return { grid: 'FN20jb', catTarget: null, enablePota: true, enableSota: false, firstRun: true };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

let settings = null;
let win = null;
let cat = null;
let spotTimer = null;
let rigctldProc = null;

// --- Rigctld management ---
function findRigctld() {
  // Check user-configured path first
  if (settings && settings.rigctldPath) {
    try {
      fs.accessSync(settings.rigctldPath, fs.constants.X_OK);
      return settings.rigctldPath;
    } catch { /* fall through */ }
  }

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
      for (const line of lines) {
        const m = line.match(/^\s*(\d+)\s+(\S+(?:\s+\S+)*?)\s{2,}(\S+(?:\s+\S+)*?)\s{2,}(\S+)\s+(\S+)/);
        if (m) {
          rigs.push({ id: parseInt(m[1], 10), mfg: m[2].trim(), model: m[3].trim(), version: m[4], status: m[5] });
        }
      }
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

function spawnRigctld(target) {
  return new Promise((resolve, reject) => {
    const rigctldPath = findRigctld();
    const args = [
      '-m', String(target.rigId),
      '-r', target.serialPort,
      '-s', String(target.baudRate),
      '-t', '4532',
    ];

    killRigctld();

    const proc = spawn(rigctldPath, args, { stdio: 'ignore' });
    rigctldProc = proc;

    proc.on('error', (err) => {
      rigctldProc = null;
      reject(err);
    });

    proc.on('exit', () => {
      if (rigctldProc === proc) rigctldProc = null;
    });

    // Give rigctld time to start listening
    setTimeout(() => resolve(), 500);
  });
}

function sendCatStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-status', s);
}

function sendCatFrequency(hz) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-frequency', hz);
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
    cat.on('status', sendCatStatus);
    cat.on('frequency', sendCatFrequency);
    cat.connect({ type: 'rigctld', host: '127.0.0.1', port: 4532 });
  } else {
    cat = new CatClient();
    cat.on('status', sendCatStatus);
    cat.on('frequency', sendCatFrequency);
    if (target) {
      cat.connect(target);
    }
  }
}

// --- Spot processing ---
function processPotaSpots(raw) {
  const myPos = gridToLatLon(settings.grid);
  return raw.map((s) => {
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

    return {
      source: 'pota',
      callsign: s.activator || s.callsign || '',
      frequency: s.frequency,
      freqMHz,
      mode: (s.mode || '').toUpperCase(),
      reference: s.reference || '',
      parkName: s.name || s.parkName || '',
      locationDesc: s.locationDesc || '',
      distance,
      lat,
      lon,
      band: freqToBand(freqMHz),
      spotTime: s.spotTime || '',
    };
  });
}

async function processSotaSpots(raw) {
  const myPos = gridToLatLon(settings.grid);

  // Batch-fetch summit coordinates (cached across refreshes)
  await fetchSummitCoordsBatch(raw);

  return raw.map((s) => {
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

    return {
      source: 'sota',
      callsign: s.activatorCallsign || '',
      frequency: String(freqKHz),
      freqMHz,
      mode: (s.mode || '').toUpperCase(),
      reference: ref,
      parkName: s.summitDetails || '',
      locationDesc: assoc,
      distance,
      lat,
      lon,
      band: freqToBand(freqMHz),
      spotTime: s.timeStamp || '',
    };
  });
}

async function refreshSpots() {
  try {
    const enablePota = settings.enablePota !== false; // default true
    const enableSota = settings.enableSota === true;  // default false

    const fetches = [];
    if (enablePota) fetches.push(fetchPotaSpots().then(processPotaSpots));
    if (enableSota) fetches.push(fetchSotaSpots().then(processSotaSpots));

    const results = await Promise.allSettled(fetches);
    const spots = results
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    if (win && !win.isDestroyed()) {
      win.webContents.send('spots', spots);
    }

    // Report errors from rejected fetches
    const errors = results.filter((r) => r.status === 'rejected');
    if (errors.length > 0 && spots.length === 0 && win && !win.isDestroyed()) {
      win.webContents.send('spots-error', errors[0].reason.message);
    }
  } catch (err) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('spots-error', err.message);
    }
  }
}

// --- App lifecycle ---
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    title: 'POTA CAT',
    frame: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Once the renderer is actually ready to listen, send current state
  win.webContents.on('did-finish-load', () => {
    if (cat) {
      sendCatStatus({ connected: cat.connected, target: cat._target });
    }
    refreshSpots();
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  settings = loadSettings();

  createWindow();
  connectCat();

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

  // IPC handlers
  ipcMain.on('open-external', (_e, url) => {
    const { shell } = require('electron');
    // Only allow known URLs
    if (url.startsWith('https://www.qrz.com/') || url.startsWith('https://caseystanton.com/') || url.startsWith('https://github.com/Waffleslop/POTA-CAT/') || url.startsWith('https://hamlib.github.io/')) {
      shell.openExternal(url);
    }
  });

  ipcMain.on('tune', (_e, { frequency, mode }) => {
    const freqHz = Math.round(parseFloat(frequency) * 1000); // kHz → Hz
    cat.tune(freqHz, mode);
  });

  ipcMain.on('refresh', () => { refreshSpots(); });

  ipcMain.handle('get-settings', () => settings);

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
    settings = { ...settings, ...newSettings };
    saveSettings(settings);
    connectCat();
    refreshSpots();
    return settings;
  });

  ipcMain.on('connect-cat', (_e, target) => {
    settings.catTarget = target;
    saveSettings(settings);
    connectCat();
  });
});

app.on('window-all-closed', () => {
  if (spotTimer) clearInterval(spotTimer);
  if (cat) cat.disconnect();
  killRigctld();
  app.quit();
});
