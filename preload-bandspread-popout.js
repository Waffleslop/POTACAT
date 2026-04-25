const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  onSpots: (cb) => ipcRenderer.on('spots', (_e, data) => cb(data)),
  // Filtered spots + suggested band, pushed by the main window so the
  // bandspread mirrors Table View's filters and active band. Replaces the
  // unfiltered onSpots feed once the main renderer has reported in.
  onView: (cb) => ipcRenderer.on('bandspread-popout-view', (_e, payload) => cb(payload)),
  onTheme: (cb) => ipcRenderer.on('bandspread-popout-theme', (_e, theme) => cb(theme)),
  onFrequencyUpdate: (cb) => ipcRenderer.on('bandspread-popout-freq', (_e, freqKhz) => cb(freqKhz)),
  onModeUpdate: (cb) => ipcRenderer.on('bandspread-popout-mode', (_e, mode) => cb(mode)),
  // Notify the main renderer that the user QSY'd by clicking a spot in the
  // bandspread, so the table can highlight the same row it would for a
  // table-side click.
  notifyTunedSpot: (payload) => ipcRenderer.send('bandspread-popout-tuned-spot', payload),
  onTuneBlocked: (cb) => ipcRenderer.on('tune-blocked', (_e, msg) => cb(msg)),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  tune: (frequency, mode) => ipcRenderer.send('tune', { frequency, mode }),
  minimize: () => ipcRenderer.send('bandspread-popout-minimize'),
  maximize: () => ipcRenderer.send('bandspread-popout-maximize'),
  close: () => ipcRenderer.send('bandspread-popout-close'),
});
