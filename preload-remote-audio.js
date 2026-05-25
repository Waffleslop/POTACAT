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
  // SmartSDR DAX-free audio path. Opus frames arrive as Buffer; the
  // bridge decodes via WebCodecs and feeds a synthetic MediaStream to
  // the WebRTC peer.
  onSmartSdrAudioFrame: (cb) => {
    // Batch-ack received frames so main's audioSafeSend can apply
    // backpressure — see main.js audioBus. Without these acks the
    // backlog counter never decrements and we'd be throttled after
    // AUDIO_MAX_BACKLOG frames.
    let _ackCount = 0;
    ipcRenderer.on('smartsdr-audio-frame', (_e, frame) => {
      cb(frame);
      if (++_ackCount >= 20) {
        ipcRenderer.send('audio-ack', { channel: 'smartsdr-audio-frame', count: _ackCount });
        _ackCount = 0;
      }
    });
  },
  onSmartSdrAudioFallback: (cb) => ipcRenderer.on('smartsdr-audio-fallback', () => cb()),
  // TX state — used to mute Kiwi audio while transmitting so the
  // mobile listener doesn't hear their own TX echoed through the
  // remote SDR. (VK3AWA original report; the desktop and browser
  // ECHOCAT paths already had this — Gap 20a's WebRTC route was
  // missing it, so v1.5.15 mobile users got their TX back.)
  onTxState: (cb) => ipcRenderer.on('remote-tx-state', (_e, state) => cb(state)),
  // CW sidetone synthesis. Flex slice RX is muted by firmware during TX,
  // so the dax_rx stream feeding the WebRTC bridge goes silent — the iOS
  // listener hears nothing while a CW macro plays. Other rigs may also
  // mute USB audio during TX. Synthesizing morse locally and mixing into
  // the bridge destination gives the iOS user audible feedback without
  // depending on rig-specific sidetone routing. Casey K3SBP 2026-05-13.
  onCwSidetonePlay: (cb) => ipcRenderer.on('cw-sidetone-play', (_e, payload) => cb(payload)),
  // DAX TX direct path — forward downsampled (24 kHz mono Float32) WebRTC
  // mic chunks to main, which wraps them in VITA-49 dax_tx packets and
  // sends to the radio. Bypasses Windows DAX TX device entirely.
  // K3SBP 2026-05-15.
  daxTxChunk: (samples) => ipcRenderer.send('dax-tx-chunk', samples),
  // TX EQ + compressor — main pushes live updates here when the user
  // toggles enable/preset in Settings without rebuilding WebRTC.
  onTxEqUpdate: (cb) => ipcRenderer.on('tx-eq-update', (_e, eqConfig) => cb(eqConfig)),
});
