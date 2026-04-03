const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  onRbnSpots: (cb) => ipcRenderer.on('rbn-spots', (_e, data) => cb(data)),
  onPskrMapSpots: (cb) => ipcRenderer.on('pskr-map-spots', (_e, data) => cb(data)),
  onPopoutTheme: (cb) => ipcRenderer.on('popout-theme', (_e, theme) => cb(theme)),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  minimize: () => ipcRenderer.send('prop-popout-minimize'),
  maximize: () => ipcRenderer.send('prop-popout-maximize'),
  close: () => ipcRenderer.send('prop-popout-close'),
});
