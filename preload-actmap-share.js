const { contextBridge, ipcRenderer } = require('electron');

// The activation share image page (renderer/actmap-share.html) only needs
// its data in and a "tiles are in, capture me" signal out.
contextBridge.exposeInMainWorld('shareApi', {
  onData: (cb) => ipcRenderer.once('actmap-share-data', (_e, data) => cb(data)),
  ready: () => ipcRenderer.send('actmap-share-ready'),
});
