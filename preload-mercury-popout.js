// Preload for the Mercury HF-data chat/file popout. Mirrors the send/on idiom
// of preload-jtcat-popout.js. Renderer has no Node — all radio/file work is in
// main; this only marshals commands out and events in.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('get-settings'),

  // Commands (renderer → main → MercuryClient)
  mercuryConnect: (their) => ipcRenderer.send('mercury-cmd-connect', their),
  mercuryDisconnect: () => ipcRenderer.send('mercury-cmd-disconnect'),
  mercuryAbort: () => ipcRenderer.send('mercury-cmd-abort'),
  mercuryListen: (on) => ipcRenderer.send('mercury-cmd-listen', !!on),
  mercurySetBw: (bw) => ipcRenderer.send('mercury-cmd-bw', bw),
  mercurySendText: (text) => ipcRenderer.send('mercury-cmd-send-text', text),
  mercurySendFile: () => ipcRenderer.invoke('mercury-cmd-send-file'), // main opens the picker
  openDownloads: () => ipcRenderer.send('mercury-open-downloads'),

  // Events (main → renderer)
  onMercuryStatus: (cb) => ipcRenderer.on('mercury-status', (_e, d) => cb(d)),   // TNC connection
  onMercurySession: (cb) => ipcRenderer.on('mercury-session', (_e, d) => cb(d)), // ARQ connect/disconnect
  onMercuryLink: (cb) => ipcRenderer.on('mercury-link', (_e, d) => cb(d)),       // ptt/busy/sn/bitrate
  onMercuryChat: (cb) => ipcRenderer.on('mercury-chat', (_e, d) => cb(d)),       // {dir,text,replay?}
  onMercuryFile: (cb) => ipcRenderer.on('mercury-file', (_e, d) => cb(d)),       // {dir,name,size,done,path?}
  onPopoutTheme: (cb) => ipcRenderer.on('mercury-popout-theme', (_e, t) => cb(t)),

  // Window controls
  minimize: () => ipcRenderer.send('mercury-popout-minimize'),
  maximize: () => ipcRenderer.send('mercury-popout-maximize'),
  close: () => ipcRenderer.send('mercury-popout-close'),
  setZoom: (f) => webFrame.setZoomFactor(f),
  getZoom: () => webFrame.getZoomFactor(),
});
