const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { fetchSpots } = require('./lib/pota');
const { CatClient, listSerialPorts } = require('./lib/cat');
const { gridToLatLon, haversineDistanceMiles } = require('./lib/grid');
const { freqToBand } = require('./lib/bands');

// --- Settings ---
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return { grid: 'FN20jb', catTarget: { type: 'tcp', host: '127.0.0.1', port: 5002 } };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

let settings = null;
let win = null;
let cat = null;
let spotTimer = null;

function sendCatStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('cat-status', s);
}

function connectCat() {
  if (cat) cat.disconnect();
  cat = new CatClient();
  cat.on('status', sendCatStatus);
  if (settings.catTarget) {
    cat.connect(settings.catTarget);
  }
}

// --- Spot processing ---
function processSpots(raw) {
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

async function refreshSpots() {
  try {
    const raw = await fetchSpots();
    const spots = processSpots(raw);
    if (win && !win.isDestroyed()) {
      win.webContents.send('spots', spots);
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
  settings = loadSettings();

  createWindow();
  connectCat();

  // Start spot fetching
  refreshSpots();
  spotTimer = setInterval(refreshSpots, 30000);

  // IPC handlers
  ipcMain.on('open-external', (_e, url) => {
    const { shell } = require('electron');
    // Only allow QRZ URLs
    if (url.startsWith('https://www.qrz.com/')) {
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
  app.quit();
});
