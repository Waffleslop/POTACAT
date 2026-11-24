'use strict';
// Preload for the Contact details window (lib/contact-card.js builds what it
// shows in main). Sandboxed: only the electron module is here, and the page
// can show, copy, open the QRZ page and switch weather; nothing else.
const { contextBridge, ipcRenderer } = require('electron');

let platform = '';
try { platform = process.platform; } catch { /* leave blank */ }

contextBridge.exposeInMainWorld('api', {
  platform,
  onLoading: (cb) => ipcRenderer.on('contact-card-loading', (_e, call) => cb(call)),
  onShow: (cb) => ipcRenderer.on('contact-card-show', (_e, vm) => cb(vm)),
  copyText: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  setWeather: (on) => ipcRenderer.send('contact-card-weather', on === true),
  minimize: () => ipcRenderer.send('contact-card-minimize'),
  close: () => ipcRenderer.send('contact-card-close'),
});
