// Preload for the Winlink mail window. Mirrors preload-mercury-popout.js: the
// renderer has no Node — Pat, the radio and every file live in main; this only
// marshals commands out and state in.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // Mailbox (invoke → {ok, ...})
  list: (box) => ipcRenderer.invoke('winlink-cmd-list', box),
  read: (box, mid) => ipcRenderer.invoke('winlink-cmd-read', { box, mid }),
  del: (box, mid) => ipcRenderer.invoke('winlink-cmd-delete', { box, mid }),
  saveAttachment: (box, mid, name) => ipcRenderer.invoke('winlink-cmd-save-attachment', { box, mid, name }),
  pickAttachments: () => ipcRenderer.invoke('winlink-pick-attachments'),
  send: (msg) => ipcRenderer.invoke('winlink-cmd-send', msg),
  posreport: (o) => ipcRenderer.invoke('winlink-cmd-posreport', o),

  // Sessions — Connect is the only way a radio session starts.
  connect: (o) => ipcRenderer.invoke('winlink-cmd-connect', o),
  abort: () => ipcRenderer.send('winlink-cmd-abort'),
  answerPrompt: (id, value) => ipcRenderer.send('winlink-cmd-prompt', { id, value }),
  gateways: (mode, band) => ipcRenderer.invoke('winlink-cmd-gateways', { mode, band }),
  setMode: (mode) => ipcRenderer.send('winlink-cmd-set-mode', mode),
  acceptNotice: () => ipcRenderer.invoke('winlink-cmd-accept-notice'),
  getState: () => ipcRenderer.invoke('winlink-cmd-state'),
  // Radio sound: picked automatically when POTACAT can tell, asked only when not.
  audioRig: () => ipcRenderer.invoke('winlink-audio-rig'),
  audioAuto: (o) => ipcRenderer.invoke('winlink-audio-auto', o),
  audioSave: (o) => ipcRenderer.invoke('winlink-audio-save', o),
  audioList: () => ipcRenderer.invoke('winlink-list-ardop-devices'),
  openSettings: () => ipcRenderer.send('winlink-open-settings'),
  openFolder: () => ipcRenderer.send('winlink-open-folder'),

  // Events
  onState: (cb) => ipcRenderer.on('winlink-state', (_e, d) => cb(d)),
  onMailbox: (cb) => ipcRenderer.on('winlink-mailbox', (_e, d) => cb(d)),
  onSession: (cb) => ipcRenderer.on('winlink-session', (_e, d) => cb(d)),
  onPopoutTheme: (cb) => ipcRenderer.on('winlink-popout-theme', (_e, t) => cb(t)),

  // Window controls
  minimize: () => ipcRenderer.send('winlink-popout-minimize'),
  maximize: () => ipcRenderer.send('winlink-popout-maximize'),
  close: () => ipcRenderer.send('winlink-popout-close'),
  setZoom: (f) => webFrame.setZoomFactor(f),
  getZoom: () => webFrame.getZoomFactor(),
});
