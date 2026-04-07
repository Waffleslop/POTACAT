const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  // JTCAT engine control
  jtcatStart: (mode) => ipcRenderer.send('jtcat-start', mode),
  jtcatStop: () => ipcRenderer.send('jtcat-stop'),
  jtcatSetMode: (mode) => ipcRenderer.send('jtcat-set-mode', mode),
  jtcatSetTxFreq: (hz) => ipcRenderer.send('jtcat-set-tx-freq', hz),
  jtcatSetRxFreq: (hz) => ipcRenderer.send('jtcat-set-rx-freq', hz),
  jtcatEnableTx: (enabled) => ipcRenderer.send('jtcat-enable-tx', enabled),
  jtcatHaltTx: () => ipcRenderer.send('jtcat-halt-tx'),
  jtcatSetTxMsg: (text) => ipcRenderer.send('jtcat-set-tx-msg', text),
  jtcatSetTxSlot: (slot) => ipcRenderer.send('jtcat-set-tx-slot', slot),
  jtcatSetTxGain: (level) => ipcRenderer.send('jtcat-set-tx-gain', level),
  jtcatTxComplete: () => ipcRenderer.send('jtcat-tx-complete'),
  jtcatAudio: (buf) => ipcRenderer.send('jtcat-audio', buf),
  jtcatSliceAudio: (sliceId, buf) => ipcRenderer.send('jtcat-slice-audio', sliceId, buf),
  jtcatStartMulti: (slices) => ipcRenderer.send('jtcat-start-multi', slices),
  enumerateAudioDevices: () => navigator.mediaDevices.enumerateDevices().then(d => d.filter(x => x.kind === 'audioinput').map(x => ({ deviceId: x.deviceId, label: x.label }))),
  jtcatQuietFreq: (hz) => ipcRenderer.send('jtcat-quiet-freq', hz),
  jtcatSpectrum: (bins) => ipcRenderer.send('jtcat-spectrum', bins),
  // JTCAT events
  onJtcatDecode: (cb) => ipcRenderer.on('jtcat-decode', (_e, data) => cb(data)),
  onJtcatCycle: (cb) => ipcRenderer.on('jtcat-cycle', (_e, data) => cb(data)),
  onJtcatSpectrum: (cb) => ipcRenderer.on('jtcat-spectrum', (_e, data) => cb(data)),
  onJtcatStatus: (cb) => ipcRenderer.on('jtcat-status', (_e, data) => cb(data)),
  onJtcatTxAudio: (cb) => ipcRenderer.on('jtcat-tx-audio', (_e, data) => cb(data)),
  onJtcatTxStatus: (cb) => ipcRenderer.on('jtcat-tx-status', (_e, data) => cb(data)),
  onRestartPopoutAudio: (cb) => ipcRenderer.on('restart-popout-audio', () => cb()),
  onJtcatQsoState: (cb) => ipcRenderer.on('jtcat-qso-state', (_e, data) => cb(data)),
  onJtcatQsoLogged: (cb) => ipcRenderer.on('jtcat-qso-logged', (_e, data) => cb(data)),
  onCatStatus: (cb) => ipcRenderer.on('cat-status', (_e, s) => cb(s)),
  onCatFrequency: (cb) => ipcRenderer.on('cat-frequency', (_e, hz) => cb(hz)),
  // QSO commands (relayed to main renderer)
  jtcatReply: (data) => ipcRenderer.send('jtcat-popout-reply', data),
  jtcatCallCq: (modifier) => ipcRenderer.send('jtcat-popout-call-cq', modifier || ''),
  jtcatCancelQso: () => ipcRenderer.send('jtcat-popout-cancel-qso'),
  jtcatSkipPhase: () => ipcRenderer.send('jtcat-popout-skip-phase'),
  openQsoLog: () => ipcRenderer.send('qso-popout-open'),
  jtcatSetAutoCqMode: (mode) => ipcRenderer.send('jtcat-popout-auto-cq-mode', mode),
  onJtcatAutoCqState: (cb) => ipcRenderer.on('jtcat-auto-cq-state', (_e, data) => cb(data)),
  // Map popout
  jtcatMapPopout: () => ipcRenderer.send('jtcat-map-popout'),
  // Tuning
  tune: (frequency, mode, bearing, slicePort) => ipcRenderer.send('tune', { frequency, mode, bearing, slicePort }),
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  // QRZ lookup
  qrzLookup: (callsign) => ipcRenderer.invoke('qrz-lookup', callsign),
  // Theme
  onPopoutTheme: (cb) => ipcRenderer.on('jtcat-popout-theme', (_e, theme) => cb(theme)),
  // Focus main window (for QSO editing)
  focusMain: () => ipcRenderer.send('jtcat-popout-focus-main'),
  // Window controls
  minimize: () => ipcRenderer.send('jtcat-popout-minimize'),
  maximize: () => ipcRenderer.send('jtcat-popout-maximize'),
  close: () => ipcRenderer.send('jtcat-popout-close'),
  // Zoom
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  getZoom: () => webFrame.getZoomFactor(),
});
