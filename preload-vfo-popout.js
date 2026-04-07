const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  tune: (frequency, mode, bearing) => ipcRenderer.send('tune', { frequency, mode, bearing }),
  setMode: (mode) => ipcRenderer.send('vfo-set-mode', mode),
  setFilterWidth: (hz) => ipcRenderer.send('vfo-set-filter-width', hz),
  rigControl: (data) => ipcRenderer.send('rig-control', data),
  sendCustomCat: (cmd) => ipcRenderer.send('rig-control', { action: 'send-custom-cat', command: cmd }),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  onRadioState: (cb) => ipcRenderer.on('vfo-radio-state', (_e, data) => cb(data)),
  minimize: () => ipcRenderer.send('vfo-popout-minimize'),
  maximize: () => ipcRenderer.send('vfo-popout-maximize'),
  close: () => ipcRenderer.send('vfo-popout-close'),
});
