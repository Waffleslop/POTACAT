// Layer L3 (docs/ardop-macos-plan.md, #187): real ARDOP frames through the
// REAL bridge window's capture and playback, decoded by a real ardopcf.
//
//   --phase=capture  --wav=<ardop frames, 12 kHz s16>  Chromium's fake
//      microphone plays the recording (--use-file-for-fake-audio-capture);
//      the bridge captures it, main feeds it to a ModemAudioServer exactly as
//      POTACAT does, and ardopcf B (LISTEN TRUE) on that server must decode it.
//   --phase=playback  ardopcf A calls (ARQCALL); its transmit audio goes from
//      the server to the bridge as POTACAT sends it ('modem-bridge-tx', 24 kHz)
//      and is played; a tap inside the page records what the play graph sends
//      to the output, and that recording is then fed to ardopcf B.
// Writes --out: the context rates Chromium chose and how many frames B decoded.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const OUT = arg('--out');
const PHASE = arg('--phase', 'capture');
const WAV = arg('--wav', '');
const LOGS = arg('--logs', path.dirname(OUT));
const PORT = Number(arg('--port', '18900'));
app.setPath('userData', path.join(path.dirname(OUT), 'ud-l3-' + PHASE));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (PHASE === 'capture') app.commandLine.appendSwitch('use-file-for-fake-audio-capture', WAV);
if (process.platform === 'darwin' && app.dock) app.dock.hide();

const { ModemAudioServer } = require(path.join(ROOT, 'lib', 'modem-audio-server.js'));
const { StreamingResampler } = require(path.join(ROOT, 'lib', 'mercury-audio-bridge.js'));
const { Ardop } = require('./ardop');
const { ModemAudioLane } = require(path.join(ROOT, 'lib', 'modem-audio-lane-client.js'));
// The path POTACAT runs (#187): the modem audio lane owns the modem's socket and the bridge worklets talk to it directly.
async function laneFor(win) {
  const lane = new ModemAudioLane({ modemRate: 12000, log: (m) => result.errors.push('lane: ' + m) });
  await lane.listen();
  return lane;
}
const bridgeOk = () => new Promise((r) => ipcMain.on('modem-bridge-status', (_e, s) => { if (s && s.ok) r(s); }));
const mkServer = () => new ModemAudioServer({ makeResampler: (a, b) => new StreamingResampler(a, b), txOutRate: 24000, log: () => {} });
const result = { phase: PHASE, platform: process.platform, arch: process.arch, statuses: [], errors: [] };
const write = () => fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
const fatal = setTimeout(() => { result.errors.push('timeout'); write(); app.exit(1); }, 300000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Frames B decoded: its debug log's "[DecodeFrame] Frame: X Decode PASS" lines.
function decodes(dir) {
  const out = { pass: 0, fail: 0, types: {} };
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^ARDOPDebug/.test(f)) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      let m = /\[DecodeFrame\] Frame: (\S+) Decode PASS/.exec(line);
      if (m) { out.pass++; out.types[m[1]] = (out.types[m[1]] || 0) + 1; continue; }
      if (/Decode FAIL|Frame Type Decode Fail/.test(line)) out.fail++;
    }
  }
  return out;
}

async function startB(srv, port, dir) {
  const B = new Ardop({ root: ROOT, name: 'B', call: 'W1BBB', hostPort: port, audioPort: srv.port, logDir: dir });
  await B.start();
  B.send('PROTOCOLMODE ARQ'); B.send('ARQBW 2000MAX'); B.send('LISTEN TRUE');
  return B;
}

async function bridgeWindow(onTapInstall) {
  const win = new BrowserWindow({ width: 320, height: 200, show: false, skipTaskbar: true, webPreferences: { preload: path.join(ROOT, 'preload-modem-audio-bridge.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') result.errors.push(String(e.message)); });
  await win.loadFile(path.join(ROOT, 'renderer', 'modem-audio-bridge.html'));
  if (onTapInstall) await win.webContents.executeJavaScript(onTapInstall);
  return win;
}

// Installed in the page before playback starts: whatever the play graph sends
// to the output is copied into window.__tap (Float32, the context's rate).
const TAP = `(() => {
  window.__tap = []; window.__tapRate = 0;
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && !this.__tapped) {
      this.__tapped = true;
      const ctx = this.context;
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => { window.__tapRate = ctx.sampleRate; window.__tap.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      orig.call(this, sp);
      orig.call(sp, ctx.destination);
    }
    return orig.call(this, dest, ...rest);
  };
  return true;
})()`;

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  ipcMain.on('modem-bridge-status', (_e, s) => { if (s && typeof s.level !== 'number') result.statuses.push(s); });
  if (PHASE === 'capture') {
    const win = await bridgeWindow(null);
    const lane = await laneFor(win);
    const dirB = path.join(LOGS, 'l3-capture-B');
    const B = await startB(lane, PORT, dirB);
    ipcMain.on('modem-bridge-rx', () => {}); // main's copy: the meter's; the modem is fed by the lane
    const ok = bridgeOk();
    win.webContents.send('modem-bridge-start', { inputId: 'default', outputId: 'default', playback: false });
    await ok;
    lane.attachBridge(win.webContents, { tx: false, rx: true });
    await sleep(40000);
    win.webContents.send('modem-bridge-stop');
    await sleep(800);
    const st = await new Promise((r) => lane.once('stats', r));
    result.rxDirect = lane.rxDirect;
    result.captureRate = st.rx.rate; result.capturedSeconds = st.rx.rate ? +(st.rx.frames / st.rx.rate).toFixed(1) : 0;
    await lane.close();
    result.bDecoded = decodes(dirB);
    result.bLines = B.lines.slice(-15);
    B.stop();
  } else {
    // A calls through the bridge's playback; the page tap records what it played.
    const win = await bridgeWindow(TAP);
    const lane = await laneFor(win);
    const dirA = path.join(LOGS, 'l3-playback-A');
    const A = new Ardop({ root: ROOT, name: 'A', call: 'W1AAA', hostPort: PORT, audioPort: lane.port, logDir: dirA });
    const ok = bridgeOk();
    win.webContents.send('modem-bridge-start', { inputId: 'default', outputId: 'default', playback: true, txGain: 1 });
    await ok;
    lane.attachBridge(win.webContents, { tx: true, rx: false });
    await sleep(2500);
    result.txDirect = lane.txDirect;
    lane.key(true, { bridge: true, seedGain: 1 }); // keyed for the whole run: A's calls and the silence between
    // A hears nothing back, so it keeps calling: ConReq frames for ~25 s.
    await A.start();
    A.send('PROTOCOLMODE ARQ'); A.send('ARQBW 2000MAX');
    await sleep(500);
    A.send('ARQCALL W1BBB 6');
    await sleep(25000);
    A.stop();
    await sleep(1500);
    lane.key(false);
    await lane.close();
    const got = await win.webContents.executeJavaScript(`(() => { const n = window.__tap.reduce((a, c) => a + c.length, 0); const all = new Float32Array(n); let o = 0; for (const c of window.__tap) { all.set(c, o); o += c.length; } let pk = 0; for (let i = 0; i < n; i++) { const v = Math.abs(all[i]); if (v > pk) pk = v; } return { rate: window.__tapRate, n, peak: pk, raw: Array.from(all) }; })()`);
    result.playbackRate = got.rate; result.playedSeconds = got.rate ? +(got.n / got.rate).toFixed(1) : 0; result.playedPeak = +got.peak.toFixed(3);
    win.webContents.send('modem-bridge-stop');
    // Feed what was played to B, in real time, as a radio would deliver it.
    const srvB = mkServer(); await srvB.listen(0);
    const dirB = path.join(LOGS, 'l3-playback-B');
    const B = await startB(srvB, PORT + 20, dirB);
    await sleep(800);
    const play = Float32Array.from(got.raw);
    const step = Math.round(got.rate / 50); // 20 ms
    // Paced by the wall clock, not by sleep(20) per block: on a Mac VM a 20 ms
    // timer fires up to ~150 ms late, which stretched 30 s of audio past the limit.
    const tail = new Float32Array(got.rate * 2);
    const feed = new Float32Array(play.length + tail.length); feed.set(play, 0);
    const t0 = Date.now(); let fed = 0;
    while (fed < feed.length) {
      const due = Math.min(feed.length, Math.floor((Date.now() - t0) / 1000 * got.rate));
      if (due > fed) { srvB.feedRx(feed.subarray(fed, due), got.rate); fed = due; }
      await sleep(10);
    }
    result.bDecoded = decodes(dirB);
    result.bLines = B.lines.slice(-15);
    B.stop();
  }
  clearTimeout(fatal);
  write();
  await sleep(300);
  app.exit(0);
}).catch((e) => { result.errors.push(String(e && e.stack || e)); write(); app.exit(2); });
