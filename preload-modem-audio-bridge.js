// Preload for the hidden modem audio bridge window (renderer/modem-audio-bridge.html).
// main ↔ window: start/playback/stop commands in, RX batches and status out,
// TX chunks in (ACK-credited, see onTx).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  onStart: (cb) => ipcRenderer.on('modem-bridge-start', (_e, cfg) => cb(cfg)),
  onPlayback: (cb) => ipcRenderer.on('modem-bridge-playback', (_e, cfg) => cb(cfg)),
  onStop: (cb) => ipcRenderer.on('modem-bridge-stop', () => cb()),
  rx: (pcm, sampleRate, peak) => ipcRenderer.send('modem-bridge-rx', { pcm, sampleRate, peak }),
  status: (s) => ipcRenderer.send('modem-bridge-status', s),
  onTx: (cb) => {
    // main sends TX chunks through audioSafeSend, which bounds its backlog on
    // these ACKs (batched, periodic flush) — the winlink-audio-frame idiom.
    let n = 0;
    const flush = () => { if (n > 0) { ipcRenderer.send('audio-ack', { channel: 'modem-bridge-tx', count: n }); n = 0; } };
    ipcRenderer.on('modem-bridge-tx', (_e, d) => {
      if (++n >= 8) flush();
      try { cb(d); } catch { /* one bad chunk must not stop acking */ }
    });
    setInterval(flush, 250);
  },
});
