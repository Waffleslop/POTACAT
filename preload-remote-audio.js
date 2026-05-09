const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onStartAudio: (cb) => ipcRenderer.on('remote-audio-start', (_e, config) => cb(config)),
  onStopAudio: (cb) => ipcRenderer.on('remote-audio-stop', () => cb()),
  onSignal: (cb) => ipcRenderer.on('remote-audio-signal', (_e, data) => cb(data)),
  sendSignal: (data) => ipcRenderer.send('remote-audio-send-signal', data),
  sendAudioStatus: (status) => ipcRenderer.send('remote-audio-status', status),
  // PC-side TX peak (0..1) for the VFO popout's TX meter — lets the user see
  // whether ECHOCAT phone audio is reaching the radio's USB CODEC.
  sendTxMeter: (peak) => ipcRenderer.send('remote-audio-tx-meter', peak),
  sendAudioHealth: (state) => ipcRenderer.send('remote-audio-health', state),
  onFreedvMute: (cb) => ipcRenderer.on('freedv-mute', (_e, muted) => cb(muted)),
  // KiwiSDR / WebSDR audio routed through the WebRTC bridge so mobile clients
  // (which don't have Web Audio) hear SDR audio over the same path as rig
  // audio. Main process sends `kiwi-active` (start/stop) and streams PCM
  // frames via `kiwi-audio-frame`.
  onKiwiActive: (cb) => ipcRenderer.on('kiwi-active', (_e, active) => cb(active)),
  onKiwiAudioFrame: (cb) => ipcRenderer.on('kiwi-audio-frame', (_e, frame) => cb(frame)),
  // TX state — used to mute Kiwi audio while transmitting so the
  // mobile listener doesn't hear their own TX echoed through the
  // remote SDR. (VK3AWA original report; the desktop and browser
  // ECHOCAT paths already had this — Gap 20a's WebRTC route was
  // missing it, so v1.5.15 mobile users got their TX back.)
  onTxState: (cb) => ipcRenderer.on('remote-tx-state', (_e, state) => cb(state)),
});
