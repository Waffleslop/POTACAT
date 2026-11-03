const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Band Scope pop-out — the FT-710's own spectrum, read over USB by a helper
// process main.js supervises. This window only draws and asks; every decision
// (spawn, CAT handshake, restore) is main's.
contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  // Stream + state from main
  onScopeFrame: (cb) => ipcRenderer.on('scope-frame', (_e, f) => cb(f)),
  onScopeState: (cb) => ipcRenderer.on('scope-state', (_e, s) => cb(s)),
  onSpots: (cb) => ipcRenderer.on('spots', (_e, spots) => cb(spots)),
  onCatFrequency: (cb) => ipcRenderer.on('cat-frequency', (_e, hz) => cb(hz)),
  onPopoutTheme: (cb) => ipcRenderer.on('scope-popout-theme', (_e, theme) => cb(theme)),
  // The tuning step, synced with the VFO window and every ECHOCAT device.
  tuneStepGet: () => ipcRenderer.invoke('tune-step-get'),
  setTuneStep: (hz) => ipcRenderer.send('tune-step-set', Number(hz)),
  onTuneStep: (cb) => ipcRenderer.on('tune-step', (_e, hz) => cb(hz)),
  // Asks
  enableOnRadio: () => ipcRenderer.send('scope-enable-on-radio'),
  restart: () => ipcRenderer.send('scope-restart'),
  setSynth: (on) => ipcRenderer.send('scope-set-synth', !!on),
  setFps: (fps) => ipcRenderer.send('scope-set-fps', Number(fps)),
  setSpan: (hz) => ipcRenderer.send('scope-span', Number(hz)),
  tune: (frequency, mode) => ipcRenderer.send('tune', { frequency, mode }),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  // Window controls
  minimize: () => ipcRenderer.send('scope-popout-minimize'),
  maximize: () => ipcRenderer.send('scope-popout-maximize'),
  close: () => ipcRenderer.send('scope-popout-close'),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  getZoom: () => webFrame.getZoomFactor(),
});
