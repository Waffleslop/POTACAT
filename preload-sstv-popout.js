const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  // SSTV control
  sstvEncode: (data) => ipcRenderer.send('sstv-encode', data),
  sstvStop: () => ipcRenderer.send('sstv-stop'),
  sstvTxComplete: () => ipcRenderer.send('sstv-tx-complete'),
  sstvAudio: (buf) => ipcRenderer.send('sstv-audio', buf),
  sstvSetSampleRate: (rate) => ipcRenderer.send('sstv-set-sample-rate', rate),
  sstvWfBins: (bins) => ipcRenderer.send('sstv-wf-bins', bins),
  // Live compose sync to ECHOCAT mobile
  sstvComposeState: (state) => ipcRenderer.send('sstv-compose-state', state),
  onSstvSendComposeState: (cb) => ipcRenderer.on('sstv-send-compose-state', () => cb()),
  // Multi-slice
  sstvStartMulti: (slices) => ipcRenderer.send('sstv-start-multi', slices),
  sstvStopMulti: () => ipcRenderer.send('sstv-stop-multi'),
  sstvSliceAudio: (sliceId, buf) => ipcRenderer.send('sstv-slice-audio', sliceId, buf),
  // SSTV events
  onSstvTxAudio: (cb) => ipcRenderer.on('sstv-tx-audio', (_e, d) => cb(d)),
  onSstvTxStatus: (cb) => ipcRenderer.on('sstv-tx-status', (_e, d) => cb(d)),
  onSstvRxImage: (cb) => ipcRenderer.on('sstv-rx-image', (_e, d) => cb(d)),
  onSstvRxLine: (cb) => ipcRenderer.on('sstv-rx-line', (_e, d) => cb(d)),
  onSstvRxVis: (cb) => ipcRenderer.on('sstv-rx-vis', (_e, d) => cb(d)),
  onSstvStatus: (cb) => ipcRenderer.on('sstv-status', (_e, d) => cb(d)),
  onSstvRxDebug: (cb) => ipcRenderer.on('sstv-rx-debug', (_e, d) => cb(d)),
  // Gallery
  sstvGetGallery: () => ipcRenderer.invoke('sstv-get-gallery'),
  sstvOpenGalleryFolder: () => ipcRenderer.send('sstv-open-gallery-folder'),
  sstvDeleteImage: (filename) => ipcRenderer.invoke('sstv-delete-image', filename),
  sstvLoadFile: () => ipcRenderer.invoke('sstv-load-file'),
  // Audio devices
  enumerateAudioDevices: () => navigator.mediaDevices.enumerateDevices()
    .then(d => d.filter(x => x.kind === 'audioinput' || x.kind === 'audiooutput')
    .map(x => ({ deviceId: x.deviceId, label: x.label, kind: x.kind }))),
  // Tuning
  tune: (frequency, mode, bearing, slicePort) => ipcRenderer.send('tune', { frequency, mode, bearing, slicePort }),
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  // Radio frequency updates
  onCatFrequency: (cb) => ipcRenderer.on('cat-frequency', (_e, hz) => cb(hz)),
  // Re-QSY when the SSTV popout is reopened/refocused (main re-requests the tune)
  onRefocusQsy: (cb) => ipcRenderer.on('sstv-refocus-qsy', () => cb()),
  // Theme
  onPopoutTheme: (cb) => ipcRenderer.on('sstv-popout-theme', (_e, theme) => cb(theme)),
  // Window controls
  minimize: () => ipcRenderer.send('sstv-popout-minimize'),
  maximize: () => ipcRenderer.send('sstv-popout-maximize'),
  close: () => ipcRenderer.send('sstv-popout-close'),
  // Zoom
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  getZoom: () => webFrame.getZoomFactor(),
});
