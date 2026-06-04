// Preload for the pair-request approve/deny popout window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onPairRequest: (cb) => ipcRenderer.on('pair-request', (_e, req) => cb(req)),
  onPairRequestExpired: (cb) => ipcRenderer.on('pair-request-expired', (_e, reason) => cb(reason)),
  pairRequestApprove: (requestId) => ipcRenderer.send('pair-request-approve', requestId),
  pairRequestDeny: (requestId) => ipcRenderer.send('pair-request-deny', requestId),
  pairRequestCloseWindow: () => ipcRenderer.send('pair-request-close-window'),
});
