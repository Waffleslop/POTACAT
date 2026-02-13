const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onSpots: (cb) => ipcRenderer.on('spots', (_e, data) => cb(data)),
  onSpotsError: (cb) => ipcRenderer.on('spots-error', (_e, msg) => cb(msg)),
  onCatStatus: (cb) => ipcRenderer.on('cat-status', (_e, s) => cb(s)),
  tune: (frequency, mode) => ipcRenderer.send('tune', { frequency, mode }),
  refresh: () => ipcRenderer.send('refresh'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  listPorts: () => ipcRenderer.invoke('list-ports'),
  connectCat: (target) => ipcRenderer.send('connect-cat', target),
  onCatFrequency: (cb) => ipcRenderer.on('cat-frequency', (_e, hz) => cb(hz)),
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
});
