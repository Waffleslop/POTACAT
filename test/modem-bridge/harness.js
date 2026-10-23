// Electron harness for test/modem-bridge-test.js: loads the REAL modem audio
// bridge window (renderer/modem-audio-bridge.html + its preload) against
// Chromium's fake audio device and a REAL lib/modem-audio-server.js, and
// writes what happened to the result file named in argv.
//
// Flags (set by the test): --use-fake-device-for-media-stream (a synthetic
// input that produces a beeping tone) and --use-fake-ui-for-media-stream (no
// permission prompt). The fake device's id is 'default' in enumerateDevices.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const ROOT = path.join(__dirname, '..', '..');
const OUT = process.argv.find((a) => a.startsWith('--out=')).slice(6);
app.setPath('userData', path.join(path.dirname(OUT), 'ud'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const { ModemAudioServer } = require(path.join(ROOT, 'lib', 'modem-audio-server.js'));
const { StreamingResampler } = require(path.join(ROOT, 'lib', 'mercury-audio-bridge.js'));

const result = { statuses: [], rx: { batches: 0, samples: 0, sampleRate: 0, peak: 0, rms: 0 }, modem: { bytes: 0, rms: 0 }, acks: 0, errors: [] };
const write = () => fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
const fatal = setTimeout(() => { result.errors.push('timeout'); write(); app.exit(1); }, 40000);

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  // A real modem audio server, and a fake "modem" that reads its 12 kHz stream.
  const srv = new ModemAudioServer({ makeResampler: (a, b) => new StreamingResampler(a, b), txOutRate: 24000, log: () => {} });
  await srv.listen(0);
  let sumSq = 0, n = 0;
  const modem = net.connect(srv.port, '127.0.0.1');
  modem.on('data', (buf) => {
    result.modem.bytes += buf.length;
    for (let i = 0; i + 1 < buf.length; i += 2) { const v = buf.readInt16LE(i) / 32768; sumSq += v * v; n++; }
  });
  const txChunks = [];
  srv.on('tx', (pcm) => txChunks.push(pcm.length));

  let win = null;
  let rxSq = 0, rxN = 0;
  ipcMain.on('modem-bridge-rx', (_e, d) => {
    if (!d || !d.pcm) return;
    const pcm = d.pcm instanceof Float32Array ? d.pcm : new Float32Array(d.pcm.buffer ? d.pcm.buffer : d.pcm);
    result.rx.batches++; result.rx.samples += pcm.length; result.rx.sampleRate = d.sampleRate;
    if (d.peak > result.rx.peak) result.rx.peak = d.peak;
    for (let i = 0; i < pcm.length; i++) { rxSq += pcm[i] * pcm[i]; rxN++; }
    srv.feedRx(pcm, d.sampleRate);
  });
  ipcMain.on('modem-bridge-status', (_e, s) => { if (!(s && typeof s.level === 'number')) result.statuses.push(s); });
  ipcMain.on('audio-ack', (_e, m) => { if (m && m.channel === 'modem-bridge-tx') result.acks += m.count | 0; });

  win = new BrowserWindow({ width: 320, height: 200, show: false, webPreferences: { preload: path.join(ROOT, 'preload-modem-audio-bridge.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') result.errors.push(String(e.message)); });
  await win.loadFile(path.join(ROOT, 'renderer', 'modem-audio-bridge.html'));

  // 1. Start with the fake device as input and output, playback on.
  win.webContents.send('modem-bridge-start', { inputId: 'default', outputId: 'default', playback: true, txGain: 1 });
  await new Promise((r) => setTimeout(r, 2500));
  // 2. Feed TX chunks (24 kHz, 20 ms) as the server would and count ACKs.
  for (let i = 0; i < 25; i++) {
    const pcm = new Float32Array(480); for (let k = 0; k < 480; k++) pcm[k] = 0.5 * Math.sin(2 * Math.PI * 1000 * k / 24000);
    win.webContents.send('modem-bridge-tx', { pcm });
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 600));
  result.rx.rms = rxN ? Math.sqrt(rxSq / rxN) : 0;
  result.modem.rms = n ? Math.sqrt(sumSq / n) : 0;
  // 3. A bogus input id must fail with the exact wording and capture nothing.
  result.statuses.push({ marker: 'bogus-start' });
  const before = result.rx.batches;
  win.webContents.send('modem-bridge-start', { inputId: 'no-such-device-id', outputId: 'default', playback: false });
  await new Promise((r) => setTimeout(r, 1500));
  result.rx.batchesAfterBogus = result.rx.batches - before;
  // 4. Stop.
  win.webContents.send('modem-bridge-stop');
  await new Promise((r) => setTimeout(r, 400));
  clearTimeout(fatal);
  write();
  try { modem.destroy(); srv.close(); } catch {}
  app.exit(0);
}).catch((e) => { result.errors.push(String(e && e.stack || e)); write(); app.exit(2); });
