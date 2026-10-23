// Preload for the hidden modem audio bridge window (renderer/modem-audio-bridge.html).
// main ↔ window: start/playback/stop commands in, RX batches and status out,
// TX chunks in (ACK-credited, see ackedChannel) — for the RADIO side, and the
// same four for the CABLE side (the virtual cable VARA is wired to).
const { contextBridge, ipcRenderer } = require('electron');

// main sends TX chunks through audioSafeSend, which bounds its backlog on
// these ACKs (batched, periodic flush) — the winlink-audio-frame idiom.
function ackedChannel(channel, cb) {
  let n = 0;
  const flush = () => { if (n > 0) { ipcRenderer.send('audio-ack', { channel, count: n }); n = 0; } };
  ipcRenderer.on(channel, (_e, d) => {
    if (++n >= 8) flush();
    try { cb(d); } catch { /* one bad chunk must not stop acking */ }
  });
  setInterval(flush, 250);
}

contextBridge.exposeInMainWorld('bridge', {
  onStart: (cb) => ipcRenderer.on('modem-bridge-start', (_e, cfg) => cb(cfg)),
  onPlayback: (cb) => ipcRenderer.on('modem-bridge-playback', (_e, cfg) => cb(cfg)),
  onStop: (cb) => ipcRenderer.on('modem-bridge-stop', () => cb()),
  onStopRadio: (cb) => ipcRenderer.on('modem-bridge-stop-radio', () => cb()),
  rx: (pcm, sampleRate, peak) => ipcRenderer.send('modem-bridge-rx', { pcm, sampleRate, peak }),
  status: (s) => ipcRenderer.send('modem-bridge-status', s),
  onTx: (cb) => ackedChannel('modem-bridge-tx', cb),
  // The cable side (VARA): capture = what VARA transmits, playback = what VARA hears.
  onCableStart: (cb) => ipcRenderer.on('modem-bridge-cable-start', (_e, cfg) => cb(cfg)),
  onCableStop: (cb) => ipcRenderer.on('modem-bridge-cable-stop', () => cb()),
  cableRx: (pcm, sampleRate, peak) => ipcRenderer.send('modem-bridge-cable-rx', { pcm, sampleRate, peak }),
  cableStatus: (s) => ipcRenderer.send('modem-bridge-cable-status', s),
  onCableTx: (cb) => ackedChannel('modem-bridge-cable-tx', cb),
});
