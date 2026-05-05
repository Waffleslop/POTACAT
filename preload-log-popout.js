'use strict';
//
// Preload bridge for the ragchew log pop-out (Ctrl+L).
//
// Sandboxed (contextIsolation: true, nodeIntegration: false) — only the
// `electron` module is available here. Anything that needs Node built-ins
// has to live in main and reach the renderer via IPC.
//

// Diagnostic — surfaces in DevTools console + Electron logs. WG9I on
// macOS darwin (v1.5.14, 2026-05-05) reported "window.api undefined" on
// Save. Logging each step makes the failure point obvious if it happens
// again on another platform.
console.log('[preload-log-popout] start');

const electron = require('electron');
const { contextBridge, ipcRenderer } = electron;
const webFrame = electron.webFrame;

// platform read goes inside a try so even if `process` is somehow
// stripped on this Electron build, we still expose the rest of the API.
let platform = '';
try { platform = process.platform; } catch { /* leave blank */ }

// webFrame is part of the sandbox-allowed surface in modern Electron,
// but if it's ever missing the zoom helpers degrade to no-ops rather
// than blowing up the whole exposeInMainWorld call.
const setZoom = (factor) => { try { if (webFrame) webFrame.setZoomFactor(factor); } catch (e) { console.warn('[preload-log-popout] setZoom:', e); } };
const getZoom = () => { try { return webFrame ? webFrame.getZoomFactor() : 1; } catch { return 1; } };

const apiSurface = {
  // --- Window controls (frameless title bar) ---
  minimizeWindow: () => ipcRenderer.send('log-popout-minimize'),
  closeWindow: () => ipcRenderer.send('log-popout-close'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  platform,

  // --- Settings ---
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  // --- QSO save (reuses the same handler as the main window) ---
  saveQso: (qsoData) => ipcRenderer.invoke('save-qso', qsoData),

  // --- Combined callsign lookup (QRZ info + past QSOs from local log) ---
  callsignInfo: (call, limit) => ipcRenderer.invoke('log-popout-callsign-info', call, limit),

  // --- Open the QSO Logbook pop-out and pre-fill its search with this call ---
  searchInLogbook: (call) => ipcRenderer.send('qso-popout-search-call', call),

  // --- CAT live updates ---
  onCatFrequency: (cb) => ipcRenderer.on('cat-frequency', (_e, hz) => cb(hz)),
  onCatMode: (cb) => ipcRenderer.on('cat-mode', (_e, mode) => cb(mode)),

  // --- Theme propagation (light / dark) ---
  onTheme: (cb) => ipcRenderer.on('log-popout-theme', (_e, theme) => cb(theme)),

  // --- Zoom (Ctrl+= / Ctrl+- / Ctrl+0) ---
  setZoom,
  getZoom,

  // --- Pop-out lifecycle ---
  onPrefill: (cb) => ipcRenderer.on('log-popout-prefill', (_e, p) => cb(p)),
};

try {
  contextBridge.exposeInMainWorld('api', apiSurface);
  console.log('[preload-log-popout] exposed api with', Object.keys(apiSurface).length, 'methods');
} catch (err) {
  // Last-resort visibility: even if the bridge fails, dump to console
  // so the renderer's DevTools shows WHY window.api wasn't set.
  console.error('[preload-log-popout] contextBridge.exposeInMainWorld failed:', err);
}
