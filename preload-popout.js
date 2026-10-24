const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  onPopoutSpots: (cb) => ipcRenderer.on('popout-spots', (_e, data) => cb(data)),
  onPopoutTuneArc: (cb) => ipcRenderer.on('popout-tune-arc', (_e, data) => cb(data)),
  onPopoutHome: (cb) => ipcRenderer.on('popout-home', (_e, data) => cb(data)),
  onPopoutTheme: (cb) => ipcRenderer.on('popout-theme', (_e, theme) => cb(theme)),
  onColorblindMode: (cb) => ipcRenderer.on('colorblind-mode', (_e, enabled) => cb(enabled)),
  onWcagMode: (cb) => ipcRenderer.on('wcag-mode', (_e, enabled) => cb(enabled)),
  tune: (frequency, mode, bearing) => ipcRenderer.send('tune', { frequency, mode, bearing }),
  onTuneBlocked: (cb) => ipcRenderer.on('tune-blocked', (_e, msg) => cb(msg)),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  // Worked-states / countries map tints (lib/worked-overlay.js attach())
  getWorkedRoster: () => ipcRenderer.invoke('worked-roster-get'),
  onWorkedRoster: (cb) => ipcRenderer.on('worked-roster', (_e, roster) => cb(roster)),
  workedOverlayGet: () => ipcRenderer.invoke('worked-overlay-get'),
  workedOverlaySet: (patch) => ipcRenderer.send('worked-overlay-set', patch),
  workedOverlayGeo: () => ipcRenderer.invoke('worked-overlay-geo'),
  workedSync: (kind) => ipcRenderer.invoke('worked-sync', kind),
  onWorkedOverlayState: (cb) => ipcRenderer.on('worked-overlay-state', (_e, s) => cb(s)),
  openLogDialog: (spot) => ipcRenderer.send('popout-open-log', spot),
  minimize: () => ipcRenderer.send('popout-minimize'),
  maximize: () => ipcRenderer.send('popout-maximize'),
  close: () => ipcRenderer.send('popout-close'),
});
