const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Tuner Memories pop-out — the ATU Calibration Wizard (lib/atu-wizard.js).
// This window shows the plan and the readings and asks; every decision
// (privileges, keying, the SWR guard hand-off, restore) is main's.
contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  // Asks
  get: () => ipcRenderer.invoke('atu-wizard-get'),
  plan: (q) => ipcRenderer.invoke('atu-wizard-plan', q),
  start: (q) => ipcRenderer.invoke('atu-wizard-start', q),
  stop: () => ipcRenderer.send('atu-wizard-stop'),
  pause: () => ipcRenderer.send('atu-wizard-pause'),
  resume: () => ipcRenderer.send('atu-wizard-resume'),
  skip: () => ipcRenderer.send('atu-wizard-skip'),
  busy: (answer) => ipcRenderer.send('atu-wizard-busy', String(answer)),
  runGet: (file) => ipcRenderer.invoke('atu-wizard-run-get', file),
  exportCsv: (file) => ipcRenderer.invoke('atu-wizard-export-csv', file || null),
  // From main
  onState: (cb) => ipcRenderer.on('atu-wizard-state', (_e, s) => cb(s)),
  onPopoutTheme: (cb) => ipcRenderer.on('atu-wizard-popout-theme', (_e, t) => cb(t)),
  // Window controls
  minimize: () => ipcRenderer.send('atu-wizard-popout-minimize'),
  maximize: () => ipcRenderer.send('atu-wizard-popout-maximize'),
  close: () => ipcRenderer.send('atu-wizard-popout-close'),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  getZoom: () => webFrame.getZoomFactor(),
});
