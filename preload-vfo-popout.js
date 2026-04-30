const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  tune: (frequency, mode, bearing) => ipcRenderer.send('tune', { frequency, mode, bearing }),
  setVfoLock: (locked) => ipcRenderer.send('vfo-set-lock', locked),
  onVfoLockState: (cb) => ipcRenderer.on('vfo-lock-state', (_e, locked) => cb(locked)),
  onTuneBlocked: (cb) => ipcRenderer.on('tune-blocked', (_e, msg) => cb(msg)),
  setMode: (mode) => ipcRenderer.send('vfo-set-mode', mode),
  setFilterWidth: (hz) => ipcRenderer.send('vfo-set-filter-width', hz),
  rigControl: (data) => ipcRenderer.send('rig-control', data),
  sendCustomCat: (cmd) => ipcRenderer.send('rig-control', { action: 'send-custom-cat', command: cmd }),
  sendCwText: (text) => ipcRenderer.send('send-cw-text', text),
  cwCancel: () => ipcRenderer.send('cw-cancel'),
  cwSetWpm: (wpm) => ipcRenderer.send('cw-set-wpm', wpm),
  voiceMacroPtt: (state) => ipcRenderer.send('voice-macro-ptt', state),
  openLogForm: () => ipcRenderer.send('vfo-open-log'),
  setAlwaysOnTop: (on) => ipcRenderer.send('vfo-set-always-on-top', on),
  voiceMacroList: () => ipcRenderer.invoke('voice-macro-list'),
  voiceMacroLoad: (idx) => ipcRenderer.invoke('voice-macro-load', idx),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  onRadioState: (cb) => ipcRenderer.on('vfo-radio-state', (_e, data) => cb(data)),
  onSmeter: (cb) => ipcRenderer.on('cat-smeter', (_e, val) => cb(val)),
  onSwr: (cb) => ipcRenderer.on('cat-swr', (_e, val) => cb(val)),
  onSwrRatio: (cb) => ipcRenderer.on('cat-swr-ratio', (_e, val) => cb(val)),
  onAlc: (cb) => ipcRenderer.on('cat-alc', (_e, val) => cb(val)),
  // PC-side TX peak forwarded from the hidden remote-audio bridge — lets the
  // VFO popout's TX meter cover ECHOCAT phone audio in addition to the local
  // voice-macro / PTT-Mic paths it already meters directly.
  onTxMeter: (cb) => ipcRenderer.on('vfo-popout-tx-meter', (_e, peak) => cb(peak)),
  onTxState: (cb) => ipcRenderer.on('remote-tx-state', (_e, state) => cb(state)),
  onSolarData: (cb) => ipcRenderer.on('solar-data', (_e, data) => cb(data)),
  onTunedSpot: (cb) => ipcRenderer.on('vfo-tuned-spot', (_e, spot) => cb(spot)),
  kiwiConnect: (opts) => ipcRenderer.send('kiwi-connect', opts),
  kiwiDisconnect: () => ipcRenderer.send('kiwi-disconnect'),
  onKiwiStatus: (cb) => ipcRenderer.on('kiwi-status', (_e, s) => cb(s)),
  onKiwiAudio: (cb) => ipcRenderer.on('kiwi-audio', (_e, d) => cb(d)),
  onTheme: (cb) => ipcRenderer.on('vfo-popout-theme', (_e, theme) => cb(theme)),
  // Live profile-list updates pushed by main when ECHOCAT phone (or another
  // window) edits settings.vfoProfiles. Fires after a save() or delete on
  // the phone-side widget; lets the popout re-render without a manual reload.
  onVfoProfilesChanged: (cb) => ipcRenderer.on('vfo-profiles-changed', (_e, list) => cb(list)),
  minimize: () => ipcRenderer.send('vfo-popout-minimize'),
  maximize: () => ipcRenderer.send('vfo-popout-maximize'),
  close: () => ipcRenderer.send('vfo-popout-close'),
});
