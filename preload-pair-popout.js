const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  echocatCreatePairingQr: (opts) => ipcRenderer.invoke('echocat-create-pairing-qr', opts || {}),
  onPairQrProgress: (cb) => ipcRenderer.on('pair-qr-progress', (_e, msg) => cb(msg)),
  close: () => ipcRenderer.send('pair-popout-close'),
});
