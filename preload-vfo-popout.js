const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  tune: (frequency, mode, bearing) => ipcRenderer.send('tune', { frequency, mode, bearing }),
  setVfoLock: (locked) => ipcRenderer.send('vfo-set-lock', locked),
  onVfoLockState: (cb) => ipcRenderer.on('vfo-lock-state', (_e, locked) => cb(locked)),
  onTuneBlocked: (cb) => ipcRenderer.on('tune-blocked', (_e, msg) => cb(msg)),
  setMode: (mode) => ipcRenderer.send('vfo-set-mode', mode),
  setFilterWidth: (hz) => ipcRenderer.send('vfo-set-filter-width', hz),
  // rig-control is registered with ipcMain.handle (main.js), so it must be
  // invoked, not sent — a bare .send has no listener and is silently dropped,
  // which is why the popout's ATU / NB / custom-CAT buttons did nothing. Match
  // the main-window preload (preload.js). Fire-and-forget: callers don't await.
  rigControl: (data) => ipcRenderer.invoke('rig-control', data),
  sendCustomCat: (cmd) => ipcRenderer.invoke('rig-control', { action: 'send-custom-cat', command: cmd }),
  sendCwText: (text) => ipcRenderer.send('send-cw-text', text),
  cwCancel: () => ipcRenderer.send('cw-cancel'),
  cwSetWpm: (wpm) => ipcRenderer.send('cw-set-wpm', wpm),
  voiceMacroPtt: (state) => ipcRenderer.send('voice-macro-ptt', state),
  // Naked PTT (manual PTT button, no audio bridge). Distinct from
  // voiceMacroPtt so SSB-over-DATA doesn't disable the rig's hand mic
  // when the user is just keying TX from the popout button.
  nakedPtt: (state) => ipcRenderer.send('naked-ptt', state),
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
  onSmartSdrAudio: (cb) => {
    // Batch-ack so main can bound the IPC backlog. See main.js audioBus.
    // Ack receipt, decoupled from cb, with a periodic flush so a slow/
    // throwing handler can't freeze the credit and wedge main into
    // dropping every frame (see preload-remote-audio.js, 2026-06-14).
    let _ackCount = 0;
    const flush = () => {
      if (_ackCount > 0) {
        ipcRenderer.send('audio-ack', { channel: 'smartsdr-audio-frame', count: _ackCount });
        _ackCount = 0;
      }
    };
    ipcRenderer.on('smartsdr-audio-frame', (_e, d) => {
      if (++_ackCount >= 8) flush();
      try { cb(d); } catch (e) { /* one bad frame must not stop acking */ }
    });
    setInterval(flush, 250);
  },
  onTheme: (cb) => ipcRenderer.on('vfo-popout-theme', (_e, theme) => cb(theme)),
  // Live profile-list updates pushed by main when ECHOCAT phone (or another
  // window) edits settings.vfoProfiles. Fires after a save() or delete on
  // the phone-side widget; lets the popout re-render without a manual reload.
  onVfoProfilesChanged: (cb) => ipcRenderer.on('vfo-profiles-changed', (_e, list) => cb(list)),
  minimize: () => ipcRenderer.send('vfo-popout-minimize'),
  maximize: () => ipcRenderer.send('vfo-popout-maximize'),
  close: () => ipcRenderer.send('vfo-popout-close'),
  // PC-mic PTT path: the VFO popout captures from a local mic and needs
  // to feed the same VITA-49 dax_tx / K4 Opus pipeline the ECHOCAT
  // bridge uses for the iOS mic stream. Reusing the dax-tx-chunk IPC
  // means main doesn't care which window sent the chunks.
  daxTxChunk: (samples) => ipcRenderer.send('dax-tx-chunk', samples),
  // TX EQ + compressor — shared state with the bridge + Settings dialog.
  // setTxEq persists + broadcasts to bridge + VFO; onTxEqUpdate hydrates
  // the VFO's UI when state changes from any source (Settings dropdown,
  // iOS WS, this popout's own controls).
  setTxEq: (eqConfig) => ipcRenderer.send('tx-eq-set', eqConfig),
  onTxEqUpdate: (cb) => ipcRenderer.on('tx-eq-update', (_e, eqConfig) => cb(eqConfig)),
  // Persist the current EQ state as the per-rig default for whichever
  // rig profile is active right now. Main looks at settings.activeRigId
  // and stamps the EQ fields onto that rig entry in settings.rigs.
  saveTxEqRigDefault: (eqConfig) => ipcRenderer.invoke('tx-eq-save-rig-default', eqConfig),
});
