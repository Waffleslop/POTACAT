const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onStartAudio: (cb) => ipcRenderer.on('remote-audio-start', (_e, config) => cb(config)),
  onStopAudio: (cb) => ipcRenderer.on('remote-audio-stop', () => cb()),
  onSignal: (cb) => ipcRenderer.on('remote-audio-signal', (_e, data) => cb(data)),
  sendSignal: (data) => ipcRenderer.send('remote-audio-send-signal', data),
  sendAudioStatus: (status) => ipcRenderer.send('remote-audio-status', status),
  onFreedvMute: (cb) => ipcRenderer.on('freedv-mute', (_e, muted) => cb(muted)),
});
