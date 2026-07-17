const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  // JTCAT engine control
  jtcatStart: (mode) => ipcRenderer.send('jtcat-start', mode),
  jtcatStop: () => ipcRenderer.send('jtcat-stop'),
  jtcatSetMode: (mode) => ipcRenderer.send('jtcat-set-mode', mode),
  jtcatSetWsprDial: (bandOrMHz) => ipcRenderer.send('jtcat-set-wspr-dial', bandOrMHz),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  jtcatWsprBeacon: (opts) => ipcRenderer.send('jtcat-wspr-beacon', opts),
  jtcatWsprHop: (opts) => ipcRenderer.send('jtcat-wspr-hop', opts),
  jtcatSetTxFreq: (hz) => ipcRenderer.send('jtcat-set-tx-freq', hz),
  jtcatSetRxFreq: (hz) => ipcRenderer.send('jtcat-set-rx-freq', hz),
  jtcatEnableTx: (enabled) => ipcRenderer.send('jtcat-enable-tx', enabled),
  jtcatHaltTx: () => ipcRenderer.send('jtcat-halt-tx'),
  jtcatTuneToggle: () => ipcRenderer.send('jtcat-tune-toggle'),
  jtcatSetTxMsg: (text) => ipcRenderer.send('jtcat-set-tx-msg', text),
  jtcatValidateTxMsg: (text) => ipcRenderer.invoke('jtcat-validate-tx-msg', text),
  // PSK31 — one-shot Send (renders + fires immediately; Send IS the arm
  // action) and the continuous decoded-character stream from the engine.
  jtcatPskSend: (text) => ipcRenderer.send('jtcat-psk-send', text),
  jtcatPskSetSql: (level) => ipcRenderer.send('jtcat-psk-set-sql', level),
  onJtcatPskRx: (cb) => ipcRenderer.on('jtcat-psk-rx', (_e, data) => cb(data)),
  onJtcatDupeWarning: (cb) => ipcRenderer.on('jtcat-dupe-warning', (_e, data) => cb(data)),
  // Stalled-QSO closeout notice ("logged, sending final 73") — informational,
  // NOT the error channel: phase:'error' force-clears qsoState/txEnabled,
  // which would fight the still-running courtesy-73 leg.
  onJtcatQsoNotice: (cb) => ipcRenderer.on('jtcat-qso-notice', (_e, data) => cb(data)),
  // Spot Target (Table-view FT8/FT4 spot click → auto-call the activator)
  onJtcatSpotTarget: (cb) => ipcRenderer.on('jtcat-spot-target', (_e, data) => cb(data)),
  jtcatSpotTargetClear: () => ipcRenderer.send('jtcat-spot-target-clear'),
  jtcatSpotTargetCallNow: () => ipcRenderer.send('jtcat-spot-target-call-now'),
  onJtcatFlagState: (cb) => ipcRenderer.on('jtcat-flag-state', (_e, data) => cb(data)),
  // Hold TX Freq — dedicated IPC (not saveSettings): main live-applies the
  // engine setter and echoes state to the phone (jtcat-hold-tx-state).
  jtcatSetHoldTxFreq: (enabled) => ipcRenderer.send('jtcat-set-hold-tx-freq', !!enabled),
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
  onJtcatWsprSpots: (cb) => ipcRenderer.on('jtcat-wspr-spots', (_e, data) => cb(data)),
  onJtcatWsprHeard: (cb) => ipcRenderer.on('jtcat-wspr-heard', (_e, data) => cb(data)),
  onJtcatWsprHopBand: (cb) => ipcRenderer.on('jtcat-wspr-hop-band', (_e, data) => cb(data)),
  onJtcatWsprBeaconState: (cb) => ipcRenderer.on('jtcat-wspr-beacon-state', (_e, data) => cb(data)),
  onJtcatCycle: (cb) => ipcRenderer.on('jtcat-cycle', (_e, data) => cb(data)),
  onJtcatSpectrum: (cb) => ipcRenderer.on('jtcat-spectrum', (_e, data) => cb(data)),
  onJtcatStatus: (cb) => ipcRenderer.on('jtcat-status', (_e, data) => cb(data)),
  onJtcatClock: (cb) => ipcRenderer.on('jtcat-clock', (_e, data) => cb(data)),
  jtcatGetClock: () => ipcRenderer.invoke('jtcat-get-clock'),
  jtcatCheckClock: () => ipcRenderer.invoke('jtcat-check-clock'),
  jtcatSyncClock: () => ipcRenderer.invoke('jtcat-sync-clock'),
  jtcatOpenTimeSettings: () => ipcRenderer.invoke('jtcat-open-time-settings'),
  onJtcatTxAudio: (cb) => ipcRenderer.on('jtcat-tx-audio', (_e, data) => cb(data)),
  onJtcatTxStatus: (cb) => ipcRenderer.on('jtcat-tx-status', (_e, data) => cb(data)),
  onJtcatTuneState: (cb) => ipcRenderer.on('jtcat-tune-state', (_e, data) => cb(data)),
  onRestartPopoutAudio: (cb) => ipcRenderer.on('restart-popout-audio', () => cb()),
  // VITA-49 dax_rx frames forwarded from main when on "SmartSDR Direct" —
  // the pop-out builds a synthetic MediaStream from these to drive its
  // waterfall, same as the main window does. K3SBP 2026-05-14.
  onJtcatVita49Audio: (cb) => {
    // Batch-ack so main can bound the IPC backlog. cb returns true on
    // actual consumption; no-op acks eagerly so this window doesn't
    // build a backlog and starve the live consumer. K3SBP 2026-05-30.
    let _ackCount = 0;
    ipcRenderer.on('jtcat-vita49-audio', (_e, frame) => {
      const consumed = cb(frame);
      _ackCount++;
      if (!consumed || _ackCount >= 20) {
        ipcRenderer.send('audio-ack', { channel: 'jtcat-vita49-audio', count: _ackCount });
        _ackCount = 0;
      }
    });
  },
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
  // ARRL Field Day window — gates the seasonal "Hunt: Field Day" option +
  // FD bar controls. { active, startsAt, endsAt }.
  jtcatFdWindow: () => ipcRenderer.invoke('jtcat-fd-window'),
  // Chase target — the CQ tag / entity being chased (shared with the phone)
  jtcatSetChaseTarget: (tag) => ipcRenderer.send('jtcat-popout-set-chase-target', tag || ''),
  onJtcatChaseTarget: (cb) => ipcRenderer.on('jtcat-chase-target', (_e, data) => cb(data)),
  // ULTRACAT (tier-2 easter egg) — Full Auto CQ run mode
  onJtcatUltracat: (cb) => ipcRenderer.on('jtcat-ultracat', (_e, on) => cb(on)),
  jtcatSetFullAutoCq: (on) => ipcRenderer.send('jtcat-popout-full-auto-cq', on),
  onJtcatFullAutoCqState: (cb) => ipcRenderer.on('jtcat-full-auto-cq-state', (_e, data) => cb(data)),
  // Map popout
  jtcatMapPopout: () => ipcRenderer.send('jtcat-map-popout'),
  // Tuning
  tune: (frequency, mode, bearing, slicePort) => ipcRenderer.send('tune', { frequency, mode, bearing, slicePort }),
  onTuneBlocked: (cb) => ipcRenderer.on('tune-blocked', (_e, msg) => cb(msg)),
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  // QRZ lookup
  qrzLookup: (callsign) => ipcRenderer.invoke('qrz-lookup', callsign),
  // Theme
  onPopoutTheme: (cb) => ipcRenderer.on('jtcat-popout-theme', (_e, theme) => cb(theme)),
  // Spot-list highlight — receives the currently-visible POTA/WWFF callsigns
  // from the main renderer so JTCAT can color-match decode rows that match
  // what's in the filtered spot table.
  onJtcatSpotsHighlight: (cb) => ipcRenderer.on('jtcat-spots-highlight', (_e, data) => cb(data)),
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
