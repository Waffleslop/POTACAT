const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  onActivationData: (cb) => ipcRenderer.on('actmap-data', (_e, data) => cb(data)),
  onContactAdded: (cb) => ipcRenderer.on('actmap-contact-added', (_e, data) => cb(data)),
  onTheme: (cb) => ipcRenderer.on('actmap-theme', (_e, theme) => cb(theme)),
  onColorblindMode: (cb) => ipcRenderer.on('colorblind-mode', (_e, enabled) => cb(enabled)),
  resolveCallsignLocations: (callsigns) => ipcRenderer.invoke('resolve-callsign-locations', callsigns),
  getPark: (ref) => ipcRenderer.invoke('get-park', ref),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveActivationImage: (opts) => ipcRenderer.invoke('actmap-save-image', opts),
  minimize: () => ipcRenderer.send('actmap-popout-minimize'),
  maximize: () => ipcRenderer.send('actmap-popout-maximize'),
  close: () => ipcRenderer.send('actmap-popout-close'),
});
