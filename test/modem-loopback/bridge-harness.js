// Layer L4 (docs/ardop-macos-plan.md, #187): does the hidden bridge window
// starve the modem's audio? Loads the REAL modem audio bridge window
// (renderer/modem-audio-bridge.html + its preload) hidden, exactly as POTACAT
// creates it, against Chromium's fake audio device, for --seconds. Measures:
//   receive: every capture batch's arrival in the main process: the largest
//            gap, and samples received against what the clock says is due;
//   transmit: a continuous 1 kHz tone sent as POTACAT sends it (24 kHz, 20 ms
//            chunks on a main-process timer), the bridge's ACKs, and any
//            underrun the play worklet reports at the end of an over.
// --blocker holds powerSaveBlocker('prevent-app-suspension') for the run.
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const OUT = arg('--out');
const SECONDS = Number(arg('--seconds', '120'));
const BLOCKER = process.argv.includes('--blocker');
app.setPath('userData', path.join(path.dirname(OUT), 'ud-' + (BLOCKER ? 'b' : 'n')));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // the app is never frontmost, like POTACAT behind other windows

const result = { platform: process.platform, arch: process.arch, seconds: SECONDS, blocker: BLOCKER, rx: {}, tx: {}, statuses: [], errors: [] };
const write = () => fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
const fatal = setTimeout(() => { result.errors.push('timeout'); write(); app.exit(1); }, (SECONDS + 60) * 1000);

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let blockId = null;
  if (BLOCKER) blockId = powerSaveBlocker.start('prevent-app-suspension');
  // RX: arrival of each capture batch in main.
  let first = 0, last = 0, samples = 0, rate = 0, maxGap = 0, gaps50 = 0, batches = 0;
  ipcMain.on('modem-bridge-rx', (_e, d) => {
    if (!d || !d.pcm) return;
    const n = d.pcm.length != null ? d.pcm.length : (d.pcm.byteLength / 4);
    const now = performance.now();
    if (!first) first = now; else { const g = now - last; if (g > maxGap) maxGap = g; if (g > 50) gaps50++; }
    last = now; samples += n; rate = d.sampleRate; batches++;
  });
  let acks = 0;
  ipcMain.on('audio-ack', (_e, m) => { if (m && m.channel === 'modem-bridge-tx') acks += m.count | 0; });
  ipcMain.on('modem-bridge-status', (_e, s) => { if (s && typeof s.level !== 'number') result.statuses.push(s); });

  const win = new BrowserWindow({ width: 320, height: 200, show: false, skipTaskbar: true, webPreferences: { preload: path.join(ROOT, 'preload-modem-audio-bridge.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') result.errors.push(String(e.message)); });
  await win.loadFile(path.join(ROOT, 'renderer', 'modem-audio-bridge.html'));
  win.webContents.send('modem-bridge-start', { inputId: 'default', outputId: 'default', playback: true, txGain: 1 });
  await new Promise((r) => setTimeout(r, 2500));
  first = 0; last = 0; samples = 0; maxGap = 0; gaps50 = 0; batches = 0;

  // TX: a continuous tone, 20 ms per chunk, paced by the wall clock like main's modem path.
  const t0 = performance.now();
  let sent = 0, phase = 0, txMaxLate = 0, lastTick = t0;
  const tick = setInterval(() => {
    const now = performance.now();
    const late = now - lastTick - 20; if (late > txMaxLate) txMaxLate = late; lastTick = now;
    const due = Math.floor((now - t0) / 20);
    while (sent < due) {
      const pcm = new Float32Array(480);
      for (let k = 0; k < 480; k++) { pcm[k] = 0.5 * Math.sin(phase); phase += 2 * Math.PI * 1000 / 24000; }
      win.webContents.send('modem-bridge-tx', { pcm });
      sent++;
    }
  }, 20);
  // One "over" every 10 s: stop the tone for 1 s so the worklet reports its over.
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(tick);
  await new Promise((r) => setTimeout(r, 1500));
  const span = (last - first) / 1000;
  result.rx = { sampleRate: rate, batches, seconds: +span.toFixed(1), samples, expected: Math.round(span * rate), lostPct: rate ? +(100 * (1 - samples / Math.max(1, span * rate))).toFixed(2) : null, maxGapMs: +maxGap.toFixed(1), gapsOver50ms: gaps50 };
  result.tx = { chunksSent: sent, acks, timerMaxLateMs: +txMaxLate.toFixed(1), overs: result.statuses.filter((s) => s && s.txOver).map((s) => s.txOver) };
  win.webContents.send('modem-bridge-stop');
  await new Promise((r) => setTimeout(r, 400));
  if (blockId != null) powerSaveBlocker.stop(blockId);
  clearTimeout(fatal);
  write();
  app.exit(0);
}).catch((e) => { result.errors.push(String(e && e.stack || e)); write(); app.exit(2); });
