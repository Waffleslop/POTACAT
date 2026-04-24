const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  onSpots: (cb) => ipcRenderer.on('spots', (_e, data) => cb(data)),
  onTheme: (cb) => ipcRenderer.on('bandspread-popout-theme', (_e, theme) => cb(theme)),
  onFrequencyUpdate: (cb) => ipcRenderer.on('bandspread-popout-freq', (_e, freqKhz) => cb(freqKhz)),
  onTuneBlocked: (cb) => ipcRenderer.on('tune-blocked', (_e, msg) => cb(msg)),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  tune: (frequency, mode) => ipcRenderer.send('tune', { frequency, mode }),
  minimize: () => ipcRenderer.send('bandspread-popout-minimize'),
  maximize: () => ipcRenderer.send('bandspread-popout-maximize'),
  close: () => ipcRenderer.send('bandspread-popout-close'),
});
