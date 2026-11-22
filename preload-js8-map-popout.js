// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
// Preload for the JS8 Heartbeat Map — deliberately tiny: window chrome,
// theme, and the one data channel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform, // popout-theme-boot.js: macOS hides the drawn buttons for the traffic lights (#866)
  minimize: () => ipcRenderer.send('js8-map-minimize'),
  maximize: () => ipcRenderer.send('js8-map-maximize'),
  close: () => ipcRenderer.send('js8-map-close'),
  onTheme: (cb) => ipcRenderer.on('js8call-popout-theme', (_e, t) => cb(t)),
  // { home:{call,grid}, heard:[{call,grid,snr,utc}], heardBy:[{call,grid,snr,utc}] }
  onData: (cb) => ipcRenderer.on('js8-map-data', (_e, d) => cb(d)),
  ready: () => ipcRenderer.send('js8-map-ready'),
});
