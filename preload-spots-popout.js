const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  onSpotsData: (cb) => ipcRenderer.on('spots-popout-data', (_e, data) => cb(data)),
  onTheme: (cb) => ipcRenderer.on('spots-popout-theme', (_e, theme) => cb(theme)),
  onColorblindMode: (cb) => ipcRenderer.on('colorblind-mode', (_e, enabled) => cb(enabled)),
  tune: (frequency, mode, bearing) => ipcRenderer.send('tune', { frequency, mode, bearing }),
  onTuneBlocked: (cb) => ipcRenderer.on('tune-blocked', (_e, msg) => cb(msg)),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openLogDialog: (spot) => ipcRenderer.send('spots-popout-open-log', spot),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  minimize: () => ipcRenderer.send('spots-popout-minimize'),
  maximize: () => ipcRenderer.send('spots-popout-maximize'),
  close: () => ipcRenderer.send('spots-popout-close'),
});
