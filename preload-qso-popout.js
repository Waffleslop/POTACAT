const electron = require('electron');
const { contextBridge, ipcRenderer } = electron;
const webFrame = electron.webFrame;

// webFrame is part of the sandbox-allowed surface in modern Electron, but
// if it's ever missing the zoom helpers degrade to no-ops rather than
// blowing up the whole exposeInMainWorld call. Mirrors preload-log-popout.
const setZoom = (factor) => { try { if (webFrame) webFrame.setZoomFactor(factor); } catch (e) { console.warn('[preload-qso-popout] setZoom:', e); } };
const getZoom = () => { try { return webFrame ? webFrame.getZoomFactor() : 1; } catch { return 1; } };

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  setZoom,
  getZoom,
  getAllQsos: () => ipcRenderer.invoke('get-all-qsos'),
  updateQso: (data) => ipcRenderer.invoke('update-qso', data),
  expandQsoMultipark: (data) => ipcRenderer.invoke('expand-qso-multipark', data),
  deleteQso: (idx) => ipcRenderer.invoke('delete-qso', idx),
  exportAdif: (qsos) => ipcRenderer.invoke('export-adif', qsos),
  importAdif: () => ipcRenderer.invoke('import-adif'),
  findDuplicateQsos: () => ipcRenderer.invoke('find-duplicate-qsos'),
  deleteDuplicateQsos: (remove) => ipcRenderer.invoke('delete-duplicate-qsos', { remove }),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getDefaultLogPath: () => ipcRenderer.invoke('get-default-log-path'),
  onQsoAdded: (cb) => ipcRenderer.on('qso-popout-added', (_e, qso) => cb(qso)),
  onQsoUpdated: (cb) => ipcRenderer.on('qso-popout-updated', (_e, data) => cb(data)),
  onQsoDeleted: (cb) => ipcRenderer.on('qso-popout-deleted', (_e, idx) => cb(idx)),
  onRefresh: (cb) => ipcRenderer.on('qso-popout-refresh', () => cb()),
  onSetSearch: (cb) => ipcRenderer.on('qso-popout-set-search', (_e, q) => cb(q)),
  onTheme: (cb) => ipcRenderer.on('qso-popout-theme', (_e, theme) => cb(theme)),
  onColorblindMode: (cb) => ipcRenderer.on('colorblind-mode', (_e, enabled) => cb(enabled)),
  // Rig frequency push — used by "+ New QSO" to auto-fill the Freq field
  // with the radio's current frequency (N4DWJ 2026-06-09).
  onCatFrequency: (cb) => ipcRenderer.on('cat-frequency', (_e, hz) => cb(hz)),
  resolveCallsignLocations: (callsigns) => ipcRenderer.invoke('resolve-callsign-locations', callsigns),
  getPark: (ref) => ipcRenderer.invoke('get-park', ref),
  resendQsosToLogbook: (qsos) => ipcRenderer.invoke('resend-qsos-to-logbook', qsos),
  saveQso: (qsoData) => ipcRenderer.invoke('save-qso', qsoData),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  minimize: () => ipcRenderer.send('qso-popout-minimize'),
  maximize: () => ipcRenderer.send('qso-popout-maximize'),
  close: () => ipcRenderer.send('qso-popout-close'),
});
