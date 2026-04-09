const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  onClusterLine: (cb) => ipcRenderer.on('cluster-popout-line', (_e, data) => cb(data)),
  onTheme: (cb) => ipcRenderer.on('cluster-popout-theme', (_e, theme) => cb(theme)),
  onNodes: (cb) => ipcRenderer.on('cluster-popout-nodes', (_e, nodes) => cb(nodes)),
  sendCommand: (text, nodeId) => ipcRenderer.invoke('send-cluster-command', text, nodeId),
  tune: (frequency, mode) => ipcRenderer.send('tune', { frequency, mode }),
  onTuneBlocked: (cb) => ipcRenderer.on('tune-blocked', (_e, msg) => cb(msg)),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  minimize: () => ipcRenderer.send('cluster-popout-minimize'),
  maximize: () => ipcRenderer.send('cluster-popout-maximize'),
  close: () => ipcRenderer.send('cluster-popout-close'),
});
