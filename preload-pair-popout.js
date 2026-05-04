const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  echocatCreatePairingQr: (opts) => ipcRenderer.invoke('echocat-create-pairing-qr', opts || {}),
  close: () => ipcRenderer.send('pair-popout-close'),
});
