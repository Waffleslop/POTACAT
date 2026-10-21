// Preload for the desktop-as-client WebRTC answerer window
// (renderer/remote-audio-client.html). Bridges the answerer module to main,
// which relays signaling to the remote shack over RemoteClient.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Outbound from the answerer → main → RemoteClient.sendSignal() → shack.
  outSignal: (data) => ipcRenderer.send('rac-out-signal', data),
  state: (s) => ipcRenderer.send('rac-state', s),
  // Inbound from main.
  onStart: (cb) => ipcRenderer.on('rac-start', () => cb()),
  onSignal: (cb) => ipcRenderer.on('rac-signal', (_e, d) => cb(d)),
  onStunConfig: (cb) => ipcRenderer.on('rac-stun-config', (_e, c) => cb(c)),
  onPtt: (cb) => ipcRenderer.on('rac-ptt', (_e, on) => cb(on)),
  onStop: (cb) => ipcRenderer.on('rac-stop', () => cb()),
  // Output device, mic, volume, mute for the shack's audio (settings.remoteShackAudio).
  onConfig: (cb) => ipcRenderer.on('rac-config', (_e, c) => cb(c)),
});
