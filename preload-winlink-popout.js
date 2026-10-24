// Preload for the Winlink mail window. Mirrors preload-mercury-popout.js: the
// renderer has no Node — Pat, the radio and every file live in main; this only
// marshals commands out and state in.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // Mailbox (invoke → {ok, ...})
  list: (box) => ipcRenderer.invoke('winlink-cmd-list', box),
  read: (box, mid) => ipcRenderer.invoke('winlink-cmd-read', { box, mid }),
  del: (box, mid) => ipcRenderer.invoke('winlink-cmd-delete', { box, mid }),
  saveAttachment: (box, mid, name) => ipcRenderer.invoke('winlink-cmd-save-attachment', { box, mid, name }),
  pickAttachments: () => ipcRenderer.invoke('winlink-pick-attachments'),
  send: (msg) => ipcRenderer.invoke('winlink-cmd-send', msg),
  posreport: (o) => ipcRenderer.invoke('winlink-cmd-posreport', o),
  // POTA self-spot by email (spot@pota.tdod.org), filled from the live activation.
  potaSpotTemplate: (o) => ipcRenderer.invoke('winlink-pota-spot-template', o || {}),
  onComposePrefill: (cb) => ipcRenderer.on('winlink-compose-prefill', (_e, m) => cb(m || {})),

  // Sessions — Connect is the only way a radio session starts.
  connect: (o) => ipcRenderer.invoke('winlink-cmd-connect', o),
  abort: () => ipcRenderer.send('winlink-cmd-abort'),
  // The account, from the mail window (no account = the first thing it shows).
  accountCheck: () => ipcRenderer.invoke('winlink-account-check'),
  register: (o) => ipcRenderer.invoke('winlink-register', { ...o, origin: 'mail window' }),
  setPassword: (pw) => ipcRenderer.invoke('winlink-cmd-set-password', pw),
  qsy: (o) => ipcRenderer.invoke('winlink-cmd-qsy', o),
  watchAudio: (on) => ipcRenderer.send('winlink-watch-audio', !!on),
  setPref: (key, value) => ipcRenderer.send('winlink-cmd-pref', { key, value }),
  // A phone is watching the waterfall through the shack: on a sound-device
  // rig this window is the only thing hearing the radio, so it relays its
  // magnitudes to main (which decides Busy/Clear and pushes the frames).
  onRemoteWatch: (cb) => ipcRenderer.on('winlink-remote-watch', (_e, on) => cb(!!on)),
  spectrumMags: (mags) => ipcRenderer.send('winlink-spectrum-mags', mags),
  onAudioFrame: (cb) => {
    // main sends frames through audioSafeSend, which bounds its backlog on
    // ACKs from here (batched, with a periodic flush). Without them main
    // pauses after 120 frames and resyncs every 2 s — the waterfall ran in
    // bursts (K3SBP 2026-10-22). Same idiom as preload-vfo-popout.js.
    let _ackCount = 0;
    const flush = () => {
      if (_ackCount > 0) {
        ipcRenderer.send('audio-ack', { channel: 'winlink-audio-frame', count: _ackCount });
        _ackCount = 0;
      }
    };
    ipcRenderer.on('winlink-audio-frame', (_e, d) => {
      if (++_ackCount >= 8) flush();
      try { cb(d); } catch (e) { /* one bad frame must not stop acking */ }
    });
    setInterval(flush, 100);
  },
  answerPrompt: (id, value) => ipcRenderer.send('winlink-cmd-prompt', { id, value }),
  gateways: (mode, band) => ipcRenderer.invoke('winlink-cmd-gateways', { mode, band }),
  setMode: (mode) => ipcRenderer.send('winlink-cmd-set-mode', mode),
  acceptNotice: () => ipcRenderer.invoke('winlink-cmd-accept-notice'),
  getState: () => ipcRenderer.invoke('winlink-cmd-state'),
  // Radio sound: picked automatically when POTACAT can tell, asked only when not.
  audioRig: () => ipcRenderer.invoke('winlink-audio-rig'),
  audioAuto: (o) => ipcRenderer.invoke('winlink-audio-auto', o),
  audioSave: (o) => ipcRenderer.invoke('winlink-audio-save', o),
  audioList: () => ipcRenderer.invoke('winlink-list-ardop-devices'),
  openSettings: () => ipcRenderer.send('winlink-open-settings'),
  openFolder: () => ipcRenderer.send('winlink-open-folder'),

  // The radio: RF power setting (same payload as the JTCAT window), the
  // measured forward power and SWR, and the ONE dispatcher every surface
  // sets power through (rig-control set-tx-power).
  rigControl: (d) => ipcRenderer.invoke('rig-control', d),
  onRigPower: (cb) => ipcRenderer.on('winlink-rig-power', (_e, p) => cb(p)),
  onCatFwdPower: (cb) => ipcRenderer.on('cat-fwd-power', (_e, v) => cb(v)),
  onCatSwr: (cb) => ipcRenderer.on('cat-swr', (_e, v) => cb(v)),
  onCatSwrRatio: (cb) => ipcRenderer.on('cat-swr-ratio', (_e, v) => cb(v)),

  // Events
  onState: (cb) => ipcRenderer.on('winlink-state', (_e, d) => cb(d)),
  onMailbox: (cb) => ipcRenderer.on('winlink-mailbox', (_e, d) => cb(d)),
  onSession: (cb) => ipcRenderer.on('winlink-session', (_e, d) => cb(d)),
  onPopoutTheme: (cb) => ipcRenderer.on('winlink-popout-theme', (_e, t) => cb(t)),

  // Window controls
  minimize: () => ipcRenderer.send('winlink-popout-minimize'),
  maximize: () => ipcRenderer.send('winlink-popout-maximize'),
  close: () => ipcRenderer.send('winlink-popout-close'),
  setZoom: (f) => webFrame.setZoomFactor(f),
  getZoom: () => webFrame.getZoomFactor(),
});
