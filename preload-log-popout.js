'use strict';
//
// Preload bridge for the ragchew log pop-out (Ctrl+L).
//
// Sandboxed (contextIsolation: true, nodeIntegration: false) — only the
// `electron` module is available here. Anything that needs Node built-ins
// has to live in main and reach the renderer via IPC.
//

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // --- Window controls (frameless title bar) ---
  minimizeWindow: () => ipcRenderer.send('log-popout-minimize'),
  closeWindow: () => ipcRenderer.send('log-popout-close'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  platform: process.platform,

  // --- Settings ---
  getSettings: () => ipcRenderer.invoke('get-settings'),

  // --- QSO save (reuses the same handler as the main window) ---
  saveQso: (qsoData) => ipcRenderer.invoke('save-qso', qsoData),

  // --- Combined callsign lookup (QRZ info + past QSOs from local log) ---
  callsignInfo: (call, limit) => ipcRenderer.invoke('log-popout-callsign-info', call, limit),

  // --- Open the QSO Logbook pop-out and pre-fill its search with this call ---
  searchInLogbook: (call) => ipcRenderer.send('qso-popout-search-call', call),

  // --- CAT live updates ---
  onCatFrequency: (cb) => ipcRenderer.on('cat-frequency', (_e, hz) => cb(hz)),
  onCatMode: (cb) => ipcRenderer.on('cat-mode', (_e, mode) => cb(mode)),

  // --- Pop-out lifecycle ---
  onPrefill: (cb) => ipcRenderer.on('log-popout-prefill', (_e, p) => cb(p)),
});
