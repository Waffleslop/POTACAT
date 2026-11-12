#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Audio meant for the radio never plays when the key-down is refused, and any
// that started stops with the refusal (GitHub #214, VK4KTW FTDX10 on an
// SCU-LAN10 with the LAN as the audio source: Tune in the FT8 window played a
// tone through the PC speakers until POTACAT was closed; the radio, rightly,
// never keyed).
//
// The cause: handleRemotePtt refused the key-down and its halt stopped Tune,
// but startJtcatTune never learned of it and went on to start the tone and the
// 90 s timer. The tone start arrived AFTER the stop, and the 90 s timer found
// Tune already "off" and did nothing. The 2-minute stuck-TX limit never armed:
// nothing was keyed.
// Run: node test/refused-key-audio-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  });
}

const root = path.join(__dirname, '..');
const MAIN = readSrc(path.join(root, 'main.js'));
const APP = readSrc(path.join(root, 'renderer/app.js'));

function fnBody(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, 'missing: ' + header);
  const close = src.indexOf(') {', i);
  let depth = 0, j = close >= 0 && close - i < 200 ? close + 2 : src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + header);
}

// --- main.js Tune, run for real against a fake window and fake timers -------
function tuneSandbox(pttImpl) {
  const sent = [];
  const logs = [];
  const timers = new Map();
  let nextId = 1;
  const ctx = {
    sent, logs, timers,
    settings: { audioSource: 'yaesu-lan' },
    _swrTripped: false,
    ICOM_NETWORK_TX_AUDIO_ENABLED: false,
    _icomNetworkTransport: null,
    smartSdrAudio: null,
    ft8Engine: null,
    jtcatPopoutWin: null,
    remoteServer: null,
    win: { isDestroyed: () => false, webContents: { send: (ch, ...a) => sent.push(ch) } },
    sendCatLog: (m) => logs.push(m),
    setTimeout: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
    forceReleaseIcomNetworkTx: () => {},
    // SCU-LAN10 Tune over the LAN (#227): no LAN session in these cases.
    yaesuLanBufferTxReady: () => false,
    releaseYaesuLanTx: () => {},
    yaesuLanTransport: () => null,
    Date,
    Math,
    Number,
  };
  vm.createContext(ctx);
  const src = [
    'const JTCAT_TUNE_DURATION_S = 90;',
    'const jtcatTuneState = { active: false, endsAt: 0, endTimer: null, tickTimer: null, directIcom: false };',
    'let _jtcatTuneTxActive = false;',
    fnBody(MAIN, 'function broadcastJtcatTuneState('),
    fnBody(MAIN, 'function jtcatDirectTxActive('),
    fnBody(MAIN, 'function _stopDirectTuneTone('),
    fnBody(MAIN, 'function startJtcatTune('),
    fnBody(MAIN, 'function stopJtcatTune('),
    'this.jtcatTuneState = jtcatTuneState; this.startJtcatTune = startJtcatTune; this.stopJtcatTune = stopJtcatTune;',
  ].join('\n');
  vm.runInContext(src, ctx);
  ctx.handleRemotePtt = (state, opts) => pttImpl(ctx, state, opts);
  return ctx;
}
const lastIndex = (arr, v) => arr.lastIndexOf(v);

test('SCU-LAN10 refusal (halt runs inside the refusal): no tone, no timers, Tune off, said why', () => {
  const ctx = tuneSandbox((c, state) => {
    if (!state) return undefined;
    // What handleRemotePtt does for yaesuLanTxRefusal(): log, halt (which
    // stops Tune), refuse.
    c.sendCatLog('[PTT] refused — transmit audio over the Yaesu LAN (SCU-LAN10) is not supported yet');
    if (c.jtcatTuneState.active) c.stopJtcatTune();
    return false;
  });
  ctx.startJtcatTune();
  const start = lastIndex(ctx.sent, 'jtcat-tune-audio-start');
  const stop = lastIndex(ctx.sent, 'jtcat-tune-audio-stop');
  assert.ok(start < 0 || start < stop, `the tone was started after its stop (sent: ${ctx.sent.join(', ')})`);
  assert.strictEqual(ctx.jtcatTuneState.active, false, 'Tune left active');
  assert.strictEqual(ctx.timers.size, 0, `${ctx.timers.size} timer(s) left running (the 90 s stop / countdown)`);
  assert.ok(ctx.logs.some((l) => /Tune not started: transmit was refused/.test(l)), 'no log line saying why: ' + ctx.logs.join(' | '));
  assert.ok(!ctx.logs.some((l) => /Tune ON/.test(l)), 'logged Tune ON for a refused key-down');
});

test('any other refusal (SWR guard, ATU wizard, licence, SDR): no tone, no timers', () => {
  const ctx = tuneSandbox((c, state) => (state ? false : undefined));
  ctx.startJtcatTune();
  assert.ok(!ctx.sent.includes('jtcat-tune-audio-start'), 'tone started for a refused key-down');
  assert.strictEqual(ctx.jtcatTuneState.active, false);
  assert.strictEqual(ctx.timers.size, 0);
  assert.ok(ctx.sent.includes('jtcat-tune-state'), 'surfaces not told Tune is off');
});

test('an accepted key-down still plays the tone and arms the 90 s stop', () => {
  const ctx = tuneSandbox(() => undefined);
  ctx.settings.audioSource = 'dax';
  ctx.startJtcatTune();
  assert.ok(ctx.sent.includes('jtcat-tune-audio-start'));
  assert.strictEqual(ctx.jtcatTuneState.active, true);
  assert.strictEqual(ctx.timers.size, 2, 'the 90 s stop and the countdown');
  ctx.stopJtcatTune();
  assert.strictEqual(ctx.timers.size, 0);
  assert.ok(lastIndex(ctx.sent, 'jtcat-tune-audio-stop') > lastIndex(ctx.sent, 'jtcat-tune-audio-start'));
});

// --- handleRemotePtt says so when it refuses ---------------------------------
test('every key-down refusal in handleRemotePtt returns false', () => {
  const body = fnBody(MAIN, 'function handleRemotePtt(');
  const head = body.slice(0, body.indexOf('const target = settings.catTarget;'));
  const refusals = [
    'if (state && _swrTripped) {',
    'if (state && atuWizardActive()) {',
    'if (state && listenSdr.live && listenSdr.auto) {',
    'if (state && yaesuLanTxRefusal(opts.lanOwner || null)) {',
  ];
  for (const r of refusals) {
    const i = head.indexOf(r);
    assert.ok(i >= 0, 'missing: ' + r);
    const block = head.slice(i, head.indexOf('\n  }\n', i));
    assert.ok(/\n\s*return false;\s*$/.test(block), r + ' does not return false');
  }
  assert.ok(/if \(state && ownTxPrivilegeRefused\([^\n]*\)\) return false;/.test(head), 'licence refusal does not return false');
});

// --- the other callers that play radio audio around a key-down ----------------
test('SSTV does not send the picture when its key-down is refused', () => {
  const i = MAIN.indexOf("sstvEngine.on('encode-complete'");
  assert.ok(i >= 0);
  const b = MAIN.slice(i, MAIN.indexOf('_sstvStartAudio(() => {', i));
  assert.ok(/if \(handleRemotePtt\(true, \{ audio: true, forceDataMode: _sstvIcom, emission: 'SSTV', txKind: 'sstv'(, lanOwner: [^}]+)? \}\) === false\) \{/.test(b), 'refusal not checked');
  const r = b.slice(b.indexOf("txKind: 'sstv'"));
  assert.ok(/picture not sent: transmit was refused/.test(r), 'no log line');
  assert.ok(/sstv-abort-tx/.test(r) && /return;/.test(r), 'pop-out not told / audio not skipped');
});

test('a voice macro stops when its key-down is refused', () => {
  const b = fnBody(MAIN, "ipcMain.on('voice-macro-ptt'");
  assert.ok(/handleRemotePtt\(!!state, \{ audio: true \}\) === false/.test(b), 'refusal not checked');
  assert.ok(/send\('stop-voice-macro'\)/.test(b) && /macro stopped: transmit was refused/.test(b));
  assert.ok(/onStopVoiceMacro\(/.test(APP), 'the main window stops the macro on stop-voice-macro');
});

// --- renderer: a stop that lands while the tone is still starting wins -------
test('renderer: a Tune stop during the tone start-up leaves nothing playing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const oscillators = [];
  class FakeCtx {
    constructor() { this.state = 'running'; this.destination = {}; }
    async resume() {}
    async setSinkId() {}
    createOscillator() { const o = { frequency: {}, started: false, stopped: false, connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } }; oscillators.push(o); return o; }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
  }
  const ctx = {
    window: { api: { getSettings: () => gate.then(() => ({ remoteAudioOutput: '' })), jtcatTuneAudioFailed() {}, jtcatTxAudioFault() {} } },
    AudioContext: FakeCtx,
    console,
    jtcatTxAudioCtx: null,
    jtcatTxGainLevel: 0.5,
  };
  vm.createContext(ctx);
  const decl = APP.slice(APP.indexOf('var jtcatTuneOsc = null;'), APP.indexOf('async function startJtcatTuneAudio('));
  vm.runInContext(decl + fnBody(APP, 'async function startJtcatTuneAudio(') + '\n' + fnBody(APP, 'function stopJtcatTuneAudio(') +
    '\nthis.start = startJtcatTuneAudio; this.stop = stopJtcatTuneAudio;', ctx);
  const p = ctx.start();
  ctx.stop();          // the refusal's stop arrives before the settings do
  release();
  await p;
  const playing = oscillators.filter((o) => o.started && !o.stopped);
  assert.strictEqual(playing.length, 0, 'a tone is playing after its stop');
  // And an ordinary start still plays.
  await ctx.start();
  assert.strictEqual(oscillators.filter((o) => o.started && !o.stopped).length, 1, 'a normal start plays');
  ctx.stop();
});

(async () => {
  for (const t of pending) await t();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
