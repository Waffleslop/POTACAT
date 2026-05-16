const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  // Solar / propagation data — same payload shape as the main-window
  // `solar-data` IPC. Main broadcasts to every open window so we get
  // updates automatically; getSolar() pulls cache so the popout can
  // paint immediately on open instead of waiting for the next 10-min tick.
  onSolarData: (cb) => ipcRenderer.on('solar-data', (_e, d) => cb(d)),
  getSolar: () => ipcRenderer.invoke('get-solar'),
  refreshSolar: () => ipcRenderer.send('refresh-solar'),
  // Theme — main pushes once on did-finish-load, then relays live toggles
  // through `conditions-popout-theme` so flipping the main app's light/dark
  // mode flips this window too without a reopen.
  onTheme: (cb) => ipcRenderer.on('conditions-popout-theme', (_e, theme) => cb(theme)),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  // Window chrome — frameless on Win/Linux, hiddenInset on macOS. The
  // popout's titlebar uses these to drive minimize / maximize / close.
  minimize: () => ipcRenderer.send('conditions-popout-minimize'),
  maximize: () => ipcRenderer.send('conditions-popout-maximize'),
  close: () => ipcRenderer.send('conditions-popout-close'),
  // Ctrl+wheel zoom — renderer intercepts the wheel event so Chromium's
  // own pinch-zoom logic doesn't double-fire, then asks main to bump
  // setZoomLevel in the same direction (+1 in / -1 out).
  zoomBy: (delta) => ipcRenderer.send('conditions-popout-zoom-by', delta),
});
