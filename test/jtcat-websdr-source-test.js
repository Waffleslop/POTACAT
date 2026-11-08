#!/usr/bin/env node
'use strict';
// GitHub #243, LZ3AW: WebSDR audio (websdr.ewi.utwente.nl, 7119 Hz) played
// in the speakers while JTCAT, listening to the radio's audio input, showed
// no waterfall and no decodes, and a JTCAT band change did not move the SDR.
// JTCAT now has a receive-audio choice, Radio (sound card) or WebSDR:
// lib/jtcat-rx-source.js, lib/stream-resampler.js and their wiring in
// main.js, the preloads, renderer/app.js and renderer/jtcat-popout.*.
// Run: node test/jtcat-websdr-source-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const RX = require('../lib/jtcat-rx-source');
const { StreamResampler } = require('../lib/stream-resampler');
const { WebSdrClient } = require('../lib/websdr');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e).split('\n').slice(0, 3).join('\n       ')); }
}
const root = path.join(__dirname, '..');
const MAIN = readSrc(path.join(root, 'main.js'));
const APP = readSrc(path.join(root, 'renderer', 'app.js'));
const POP = readSrc(path.join(root, 'renderer', 'jtcat-popout.js'));
const POP_HTML = readSrc(path.join(root, 'renderer', 'jtcat-popout.html'));
const INDEX = readSrc(path.join(root, 'renderer', 'index.html'));
const PRELOAD = readSrc(path.join(root, 'preload.js'));
const PRELOAD_POP = readSrc(path.join(root, 'preload-jtcat-popout.js'));

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' missing');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

// ── Resampler ────────────────────────────────────────────────────────────────
function tone(rate, hz, n, amp = 0.5) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * hz * i / rate);
  return x;
}
function resampleChunked(from, to, input, sizes) {
  const r = new StreamResampler(from, to);
  const parts = [];
  let at = 0, k = 0;
  while (at < input.length) {
    const n = sizes[k++ % sizes.length];
    parts.push(r.process(input.subarray(at, at + n)));
    at += n;
  }
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { out, latency: r._W }; // output lags by W input samples
}
// Amplitude of `hz` in x (sampled at rate), by correlation over a window.
function amplitudeAt(x, rate, hz, from, to) {
  let re = 0, im = 0;
  for (let i = from; i < to; i++) { re += x[i] * Math.cos(2 * Math.PI * hz * i / rate); im += x[i] * Math.sin(2 * Math.PI * hz * i / rate); }
  return 2 * Math.hypot(re, im) / (to - from);
}
const dB = (a, b) => 20 * Math.log10(a / b);

console.log('JTCAT receive audio from the WebSDR (#243)');

test('resampler: a 1500 Hz tone at the WebSDR\'s 7119 Hz comes out at 12 kHz as 1500 Hz, full level, no images', () => {
  const from = 7119, to = 12000, sec = 4;
  const { out } = resampleChunked(from, to, tone(from, 1500, from * sec), [256, 1024, 896, 1024]); // LZ3AW's frame sizes
  // Length: 12 kHz worth of the input, less the kernel's look-ahead.
  assert.ok(Math.abs(out.length - to * sec) < 60, 'length ' + out.length);
  const a = 2000, b = out.length - 2000;
  const sig = amplitudeAt(out, to, 1500, a, b);
  assert.ok(Math.abs(dB(sig, 0.5)) < 0.3, 'level ' + dB(sig, 0.5).toFixed(2) + ' dB');
  // A wrong ratio would put the peak elsewhere: 1490 and 1510 Hz are far down.
  assert.ok(dB(amplitudeAt(out, to, 1490, a, b), sig) < -20 && dB(amplitudeAt(out, to, 1510, a, b), sig) < -20, 'tone is not at 1500 Hz');
  // The image linear interpolation leaves at 7119 - 1500 = 5619 Hz.
  assert.ok(dB(amplitudeAt(out, to, from - 1500, a, b), sig) < -60, 'image at 5619 Hz: ' + dB(amplitudeAt(out, to, from - 1500, a, b), sig).toFixed(1) + ' dB');
  // Waveform: the output is the ideal 12 kHz sine (any phase), sample by sample.
  const re = (() => { let c = 0, s = 0; for (let i = a; i < b; i++) { c += out[i] * Math.cos(2 * Math.PI * 1500 * i / to); s += out[i] * Math.sin(2 * Math.PI * 1500 * i / to); } return { c: 2 * c / (b - a), s: 2 * s / (b - a) }; })();
  let worst = 0;
  for (let i = a; i < b; i++) {
    const ideal = re.c * Math.cos(2 * Math.PI * 1500 * i / to) + re.s * Math.sin(2 * Math.PI * 1500 * i / to);
    worst = Math.max(worst, Math.abs(out[i] - ideal));
  }
  assert.ok(worst < 0.005, 'worst sample error ' + worst.toFixed(4) + ' (a chunk seam or drift)');
});

test('resampler: frames of any size give the same samples as one block (no seams at network frames)', () => {
  const x = tone(7119, 1500, 7119 * 2);
  const one = resampleChunked(7119, 12000, x, [x.length]).out;
  const many = resampleChunked(7119, 12000, x, [256, 1, 1023, 17, 896]).out;
  assert.strictEqual(many.length, one.length);
  for (let i = 0; i < one.length; i++) assert.ok(Math.abs(one[i] - many[i]) < 1e-6, 'differs at ' + i);
});

test('resampler: 8 kHz WebSDR streams too (FT8\'s ~3 kHz top tone is inside 0-4 kHz), and 2900 Hz keeps its level', () => {
  const { out } = resampleChunked(8000, 12000, tone(8000, 2900, 8000 * 3), [1024]);
  const sig = amplitudeAt(out, 12000, 2900, 2000, out.length - 2000);
  assert.ok(Math.abs(dB(sig, 0.5)) < 1, '2900 Hz level ' + dB(sig, 0.5).toFixed(2) + ' dB');
  assert.ok(Math.abs(out.length - 36000) < 60);
});

test('resampler: decimating 48 kHz to 12 kHz keeps 1500 Hz and rejects what would alias (9 kHz -> 3 kHz)', () => {
  const x = tone(48000, 1500, 48000 * 2);
  const y = tone(48000, 9000, 48000 * 2);
  const ox = resampleChunked(48000, 12000, x, [4800]).out;
  const oy = resampleChunked(48000, 12000, y, [4800]).out;
  assert.ok(Math.abs(dB(amplitudeAt(ox, 12000, 1500, 1000, ox.length - 1000), 0.5)) < 0.3);
  assert.ok(dB(amplitudeAt(oy, 12000, 3000, 1000, oy.length - 1000) + 1e-12, 0.5) < -60, 'a 9 kHz tone aliased into the FT8 band');
});

// ── Source selection ─────────────────────────────────────────────────────────
test('source selection: radio by default (and for anything unknown), websdr only when chosen', () => {
  assert.deepStrictEqual(RX.SOURCES, ['radio', 'websdr']);
  assert.strictEqual(RX.normalizeJtcatRxSource(undefined), 'radio');
  assert.strictEqual(RX.normalizeJtcatRxSource('dax'), 'radio');
  assert.strictEqual(RX.normalizeJtcatRxSource('websdr'), 'websdr');
  assert.strictEqual(RX.SOURCE_LABELS.radio, 'Radio (sound card)');
  assert.strictEqual(RX.SOURCE_LABELS.websdr, 'WebSDR');
});

test('source selection: both JTCAT windows offer exactly the two labels; the pop-out\'s off switch is in the bar', () => {
  for (const [name, html, id] of [['index.html', INDEX, 'jtcat-rx-source'], ['jtcat-popout.html', POP_HTML, 'jp-rx-source']]) {
    const m = html.match(new RegExp('<select id="' + id + '"[^>]*>([\\s\\S]*?)</select>'));
    assert.ok(m, name + ': #' + id + ' missing');
    const opts = [...m[1].matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((o) => [o[1], o[2]]);
    assert.deepStrictEqual(opts, [['radio', RX.SOURCE_LABELS.radio], ['websdr', RX.SOURCE_LABELS.websdr]], name);
  }
  assert.ok(/id="jp-rx-sdr-chip"[^>]*hidden[^>]*>RX: WebSDR/.test(POP_HTML), 'the lit RX: WebSDR chip');
  assert.ok(POP.includes("rxSdrChip.addEventListener('click', function() { window.api.jtcatSetRxSource('radio'); });"));
});

test('source selection: one writer — the windows send jtcat-set-rx-source; main saves it and rebuilds both captures', () => {
  assert.ok(/jtcatSetRxSource: \(v\) => ipcRenderer\.send\('jtcat-set-rx-source', v\)/.test(PRELOAD));
  assert.ok(/jtcatSetRxSource: \(v\) => ipcRenderer\.send\('jtcat-set-rx-source', v\)/.test(PRELOAD_POP));
  assert.ok(APP.includes("window.api.jtcatSetRxSource(jtcatRxSourceSelect.value)"));
  assert.ok(POP.includes("window.api.jtcatSetRxSource(rxSourceSelect.value)"));
  const at = MAIN.indexOf("ipcMain.on('jtcat-set-rx-source'");
  assert.ok(at > 0);
  const body = MAIN.slice(at, MAIN.indexOf('\n  });', at));
  assert.ok(/settings\.jtcatRxSource = next;\s*saveSettings\(settings\);/.test(body), 'saved');
  assert.ok(body.includes("win.webContents.send('restart-jtcat-audio', 'rx-source')"), 'main window rebuilds');
  assert.ok(body.includes("jtcatPopoutWin.webContents.send('restart-popout-audio')"), 'pop-out rebuilds');
  assert.ok(body.includes("jtcatWebSdrFollowDial(_jtcatExpectedDialHz / 1000, 'receive source')"), 'the SDR goes to JTCAT\'s dial at once');
  assert.ok(MAIN.includes('    delete newSettings.jtcatRxSource;'), 'save-settings cannot put an old choice back');
});

test('source selection: with the WebSDR chosen, both windows draw the 12 kHz frames main sends, not a sound card', () => {
  assert.ok(APP.includes("var jtcatFromSdr = s.jtcatRxSource === 'websdr';"));
  assert.ok(APP.includes("if (jtcatFromSdr || s.audioSource === 'smartsdr' || s.audioSource === 'icom-network' || s.audioSource === 'yaesu-lan') {"));
  assert.ok(/const vita49SourceOptions = jtcatFromSdr\s*\? \{ sourceRate: 12000 \}/.test(APP));
  assert.ok(POP.includes("return s && s.jtcatRxSource === 'websdr' ? 'websdr' : (s && s.audioSource);"));
  assert.ok(POP.includes("if (audioSource === 'smartsdr' || audioSource === 'yaesu-lan' || audioSource === 'websdr') {"));
  assert.ok(/processorOptions: audioSource === 'websdr'\s*\? \{ sourceRate: 12000 \}/.test(POP));
  assert.strictEqual((POP.match(/startPopoutAudio\(s\.remoteAudioInput \|\| '', jpCaptureSource\(s\)\)/g) || []).length, 2, 'both pop-out start paths');
  // The window's capture is the SDR audio coming back: main does not feed it twice.
  const ipc = MAIN.slice(MAIN.indexOf("ipcMain.on('jtcat-audio'"), MAIN.indexOf("ipcMain.on('jtcat-slice-audio'"));
  assert.ok(/if \(jtcatRxFromWebSdr\(\)\) return;/.test(ipc));
});

// ── The feed (main.js feedJtcatFromWebSdr, run) ──────────────────────────────
test('wiring: SDR audio reaches the FT8 engine at 12 kHz and the waterfall, even when the SDR is not what you hear', () => {
  const audioAt = MAIN.indexOf("kiwiClient.on('audio', (pcmFloat, sampleRate) => {");
  const handler = MAIN.slice(audioAt, audioAt + 400);
  assert.ok(handler.indexOf('feedJtcatFromWebSdr(pcmFloat, sampleRate)') < handler.indexOf('if (!listenSdr.live) return;'), 'fed before the listen gate');
  const fed = [], ui = [];
  // eslint-disable-next-line no-new-func
  const make = new Function('StreamResampler', `
    var jtcatManager = { running: true, feedAudio: function(id, s) { fed.push([id, s.length]); } };
    var ft8Engine = null, win = { id: 'main' }, jtcatPopoutWin = { id: 'pop', webContents: 'popWC' };
    var fed = this.fed, ui = this.ui;
    function isJtcatIpAudioReady(w) { return w === jtcatPopoutWin; }
    function audioSafeSend(wc, ch, frame) { ui.push([wc, ch, frame.sampleRate, frame.pcm.length]); }
    function sendCatLog() {}
    var _jtcatSdrResampler = null, _jtcatSdrFrames = 0;
    ${extractFn(MAIN, 'feedJtcatFromWebSdr')}
    return feedJtcatFromWebSdr;
  `).bind({ fed, ui });
  const feed = make(StreamResampler);
  const x = tone(7119, 1500, 7119 * 2);
  for (let at = 0; at < x.length; at += 1024) feed(x.subarray(at, at + 1024), 7119);
  const total = fed.reduce((a, f) => a + f[1], 0);
  assert.ok(fed.every((f) => f[0] === 'default'));
  assert.ok(Math.abs(total - 24000) < 60, 'engine got ' + total + ' samples for 2 s');
  assert.ok(ui.length === fed.length && ui.every((u) => u[0] === 'popWC' && u[1] === 'jtcat-vita49-audio' && u[2] === 12000));
});

// ── Dial follow ──────────────────────────────────────────────────────────────
test('dial follow: JTCAT\'s FT8 dial becomes a USB tune with the whole FT8 sub-band in the passband', () => {
  assert.deepStrictEqual(RX.websdrTuneForDial(14074), { freqKhz: 14074, mode: 'usb', opts: { lo: 0.1, hi: 3.0 } });
  assert.deepStrictEqual(RX.websdrTuneForDial('7074').freqKhz, 7074);
  assert.strictEqual(RX.websdrTuneForDial(0), null);
  for (const m of ['FT8', 'ft4', 'FT2', 'JTTY']) assert.ok(RX.isJtcatDialMode(m), m);
  for (const m of ['USB', 'CW', 'SSB', '', null]) assert.ok(!RX.isJtcatDialMode(m), String(m));
});

test('dial follow: the WebSDR client sends that tune on the wire (f=14074, USB, lo=0.1 hi=3)', () => {
  const c = new WebSdrClient();
  c._callsign = 'LZ3AW';
  const sent = [];
  c._ws = { readyState: require('ws').OPEN, send: (s) => sent.push(s) };
  c.on('log', () => {});
  const t = RX.websdrTuneForDial(14074);
  c.tune(t.freqKhz, t.mode, t.opts);
  assert.strictEqual(sent.length, 1);
  assert.ok(/^GET \/~~param\?f=14074&band=\d+&lo=0\.1&hi=3&mode=0&name=POTACAT_LZ3AW$/.test(sent[0]), sent[0]);
});

test('dial follow: main retunes the connected SDR only while JTCAT receives from it', () => {
  const calls = [];
  // eslint-disable-next-line no-new-func
  const make = new Function('JtcatRxSource', 'state', `
    function sendCatLog() {}
    ${extractFn(MAIN, 'jtcatRxFromWebSdr')}
    ${extractFn(MAIN, 'jtcatWebSdrFollowDial')}
    return function(khz) { settings = state.settings; kiwiClient = state.kiwi; return jtcatWebSdrFollowDial(khz, 'test'); };
    var settings, kiwiClient;
  `);
  const state = { settings: { jtcatRxSource: 'websdr' }, kiwi: { connected: true, tune: (...a) => calls.push(a) } };
  const follow = make(RX, state);
  assert.strictEqual(follow(21074), true);
  assert.deepStrictEqual(calls.pop(), [21074, 'usb', { lo: 0.1, hi: 3.0 }]);
  state.settings = { jtcatRxSource: 'radio' };
  assert.strictEqual(follow(7074), false, 'radio source: the SDR is left alone');
  state.settings = { jtcatRxSource: 'websdr' }; state.kiwi.connected = false;
  assert.strictEqual(follow(7074), false, 'no SDR connected');
  assert.strictEqual(calls.length, 0);
});

test('wiring: a JTCAT band pick (either window, or ECHOCAT) retunes the SDR, even with no radio on the CAT link', () => {
  const tuneAt = MAIN.indexOf("ipcMain.on('tune', (_e, { frequency, mode, bearing, slicePort, origin }) => {");
  const tune = MAIN.slice(tuneAt, MAIN.indexOf('// --- Rig Control Panel IPC ---', tuneAt));
  const follow = tune.indexOf("const sdrFollowed = JtcatRxSource.isJtcatDialMode(mode) && jtcatWebSdrFollowDial(parseFloat(frequency), 'band pick');");
  const dead = tune.indexOf('if (!((smartSdr && smartSdr.canTune) || (cat && cat.connected))) {');
  assert.ok(follow > 0 && dead > follow, 'the follow comes before the radio-link refusal');
  assert.ok(/if \(!\(\(smartSdr && smartSdr\.canTune\) \|\| \(cat && cat\.connected\)\)\) \{\s*if \(sdrFollowed\) return;/.test(tune), 'no "radio not connected" when the SDR took the tune');
  assert.ok(tune.includes('if (!sdrFollowed && kiwiActive && kiwiClient && kiwiClient.connected) {'), 'the voice-passband auto-tune does not undo it');
  const band = MAIN.slice(MAIN.indexOf("remoteServer.on('jtcat-set-band'"), MAIN.indexOf("remoteServer.on('jtcat-log-qso'"));
  assert.ok(band.includes("jtcatWebSdrFollowDial(freqKhz, 'ECHOCAT band pick');"));
  const conn = MAIN.slice(MAIN.indexOf("kiwiClient.on('connected', () => {"), MAIN.indexOf("kiwiClient.on('audio'"));
  assert.ok(conn.includes("jtcatWebSdrFollowDial(_jtcatExpectedDialHz / 1000, 'connected')"), 'a WebSDR that connects goes to JTCAT\'s dial');
});

// ── TX refusal ───────────────────────────────────────────────────────────────
test('TX refusal: while the WebSDR is the receive source, TX is refused with a clear reason; with the radio it is not', () => {
  const msg = RX.jtcatTxRefusalForSource('websdr');
  assert.ok(msg && /^TX blocked/.test(msg));
  assert.ok(/cannot hear your own signal/.test(msg) && /different frequency/.test(msg), msg);
  assert.ok(msg.includes('Receive audio') && msg.includes('Radio (sound card)'), 'says how to transmit again, with the real labels');
  assert.strictEqual(RX.jtcatTxRefusalForSource('radio'), null);
  assert.strictEqual(RX.jtcatTxRefusalForSource(undefined), null);
});

test('TX refusal: main\'s tx-start refuses before anything is keyed, through jtcatRefuseTx, and tells the windows', () => {
  const start = MAIN.indexOf("ft8Engine.on('tx-start', (data) => {\n    // Radio-owner arbiter");
  assert.ok(start > 0);
  const body = MAIN.slice(start, MAIN.indexOf("ft8Engine.on('tx-end'", start));
  const guard = body.indexOf('const sdrRefusal = JtcatRxSource.jtcatTxRefusalForSource(settings.jtcatRxSource);');
  const key = body.indexOf("handleRemotePtt(true, { audio: true, emission: 'DATA'");
  assert.ok(guard > 0 && key > guard, 'the guard is before the key-down');
  const g = body.slice(guard, guard + 800);
  assert.ok(g.includes("jtcatRefuseTx('JTCAT is receiving from the WebSDR');\n      return;"), 'refused, not completed');
  assert.ok(g.includes("jtcatPopoutWin.webContents.send('jtcat-qso-state', { phase: 'error', error: sdrRefusal })"), 'the pop-out shows it');
  assert.ok(g.includes("remoteServer.broadcastJtcatQsoState({ phase: 'error', error: sdrRefusal })"), 'ECHOCAT shows it');
  assert.ok(g.includes("sendCatLog('[JTCAT] ' + sdrRefusal);"), 'the log says it');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
