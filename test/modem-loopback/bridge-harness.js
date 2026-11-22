// Layer L4 (docs/ardop-macos-plan.md, #187): can anything upstream starve the
// modem's audio? The REAL path as POTACAT runs it: the modem audio lane
// (lib/modem-audio-lane.js, its own utility process) owns the modem socket;
// the REAL bridge window (hidden, renderer/modem-audio-bridge.html) gets the
// lane's ports, so its worklets talk to the lane directly. A stand-in modem
// (fake-modem.js, its own process, paced like ardopcf) transmits a tone for
// --seconds inside one over and counts every receive sample it consumes.
//
// --stall: main freezes 200 ms every second (POTACAT's main is busy: a
// settings save, a GC, a spot burst). The transmission must not notice.
//
// Writes --out: the over's report from the play worklet (holes, cut audio),
// the lane's cuts, and receive loss counted in samples: what the capture
// produced (plus render quanta the audio thread skipped) against what the
// modem read off its socket. No wall clock in the loss figure.
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const OUT = arg('--out');
const SECONDS = Number(arg('--seconds', '120'));
const STALL = process.argv.includes('--stall');
app.setPath('userData', path.join(path.dirname(OUT), 'ud-' + (STALL ? 's' : 'n')));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // never frontmost, like POTACAT behind other windows

const { ModemAudioLane } = require(path.join(ROOT, 'lib', 'modem-audio-lane-client.js'));
const MODEM_RATE = 12000;
const result = { platform: process.platform, arch: process.arch, seconds: SECONDS, stall: STALL, rx: {}, tx: {}, statuses: [], errors: [], laneLog: [] };
const write = () => fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
const fatal = setTimeout(() => { result.errors.push('timeout'); write(); app.exit(1); }, (SECONDS + 90) * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeModem(port) {
  const p = spawn(process.execPath, [path.join(__dirname, 'fake-modem.js'), '--port', String(port), '--rate', String(MODEM_RATE), '--seconds', String(SECONDS)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = [];
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiters.findIndex((x) => x.test(m)); if (w >= 0) waiters.splice(w, 1)[0].resolve(m); }
  });
  const until = (test, ms = 10000) => new Promise((resolve, reject) => { waiters.push({ test, resolve }); setTimeout(() => reject(new Error('fake modem did not answer')), ms); });
  return { p, send: (c) => p.stdin.write(c + '\n'), until };
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const block = powerSaveBlocker.start('prevent-app-suspension'); // as a radio session does (#187)
  const lane = new ModemAudioLane({ modemRate: MODEM_RATE, log: (s) => result.laneLog.push(s) });
  const overs = [], cuts = [];
  let drained = null;
  lane.on('over-report', (o) => overs.push(o));
  lane.on('tx-cut', (c) => cuts.push(c));
  lane.on('drained', (d) => { drained = d || {}; if (d && d.over) overs.push(d.over); });
  await lane.listen();
  const modem = fakeModem(lane.port);
  await modem.until((m) => m.connected);

  ipcMain.on('modem-bridge-status', (_e, s) => { if (s && typeof s.level !== 'number') result.statuses.push(s); });
  ipcMain.on('modem-bridge-rx', () => {}); // main's copy (meter, VARA): not the modem's path any more
  ipcMain.on('audio-ack', () => {});
  const win = new BrowserWindow({ width: 320, height: 200, show: false, skipTaskbar: true, webPreferences: { preload: path.join(ROOT, 'preload-modem-audio-bridge.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') result.errors.push(String(e.message)); });
  await win.loadFile(path.join(ROOT, 'renderer', 'modem-audio-bridge.html'));
  const ok = new Promise((r) => ipcMain.on('modem-bridge-status', (_e, s) => { if (s && s.ok) r(s); }));
  win.webContents.send('modem-bridge-start', { inputId: 'default', outputId: 'default', playback: true, txGain: 1 });
  const st = await ok;
  lane.attachBridge(win.webContents, { tx: true, rx: true });
  await sleep(2500);
  result.captureRate = st.sampleRate; result.playbackRate = st.playbackSampleRate;
  result.txDirect = lane.txDirect; result.rxDirect = lane.rxDirect;

  // Count from here: the lane's capture counters and the modem's read count, both at zero.
  lane.resetMeters();
  modem.send('reset'); await modem.until((m) => m.reset);

  let stalls = 0, stallTimer = null;
  if (STALL) stallTimer = setInterval(() => { const t = Date.now(); while (Date.now() - t < 200) { /* main is busy */ } stalls++; }, 1000);

  // One over: key-down, the modem transmits for SECONDS, PTT off asked, the bridge plays it out.
  lane.key(true, { bridge: true, seedGain: 1 });
  modem.send('go');
  await modem.until((m) => m.done, (SECONDS + 20) * 1000);
  await sleep(150); // the modem's last 100 ms lead reaches the lane
  const askedAt = Date.now();
  lane.endOver({ leaveMs: 0 });
  for (let i = 0; i < 100 && !drained; i++) await sleep(50);
  result.tx.drainedAfterMs = drained ? Date.now() - askedAt : null;
  lane.key(false);
  if (stallTimer) clearInterval(stallTimer);

  // Receive: stop the capture, let the pipeline empty, then compare the counts.
  win.webContents.send('modem-bridge-stop');
  await sleep(1500);
  const stats = await new Promise((r) => { lane.once('stats', r); });
  modem.send('count');
  const got = await modem.until((m) => m.read != null);
  const rx = stats.rx || {};
  const produced = (rx.frames || 0) + (rx.skipped || 0);
  const expected = rx.rate ? produced * MODEM_RATE / rx.rate : 0;
  result.rx = {
    captureRate: rx.rate, framesFromCapture: rx.frames, skippedFrames: rx.skipped,
    expectedAtModem: Math.round(expected), readByModem: got.read,
    lostPct: expected ? +(100 * (1 - got.read / expected)).toFixed(3) : null,
    droppedAtSocket: stats.rxDropped,
    longestHoleMs: stats.rxMeter ? Math.round(stats.rxMeter.maxGapMs) : null,
    holesOver50ms: stats.rxMeter ? stats.rxMeter.gapsOverWarn : null,
  };
  const ov = overs[overs.length - 1] || { gaps: 0, gapMs: 0, droppedMs: 0 };
  result.tx = {
    ...result.tx,
    drained: !!drained,
    holes: ov.gaps, holeMs: +(ov.gapMs || 0).toFixed(1),
    cutInWorkletMs: +(ov.droppedMs || 0).toFixed(1),
    cutInLaneMs: cuts.length ? cuts[cuts.length - 1].totalMs : 0,
    laneStatsCutMs: stats.txCutMs,
  };
  result.mainStalls = stalls;
  modem.send('quit');
  try { powerSaveBlocker.stop(block); } catch {}
  await lane.close();
  clearTimeout(fatal);
  write();
  app.exit(0);
}).catch((e) => { result.errors.push(String(e && e.stack || e)); write(); app.exit(2); });
